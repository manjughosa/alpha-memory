# -*- coding: utf-8 -*-
"""md_cg · 设备驱动（记忆 OS #3）：把外部会话流接进认知图

设计：
  Source（事件源）—— 把某种外部存储解析成统一事件流：
      {"t": 毫秒时间戳, "seq": 序号, "role": ..., "text": ..., "session": ..., "cwd": ...}
  Ingestor（摄取器）—— 增量 watermark + 去重 + 写节点 + 自动 fix-pair 挖掘。

内置源：
  · JsonlSource        —— 通用 JSONL（每行一个事件对象）
  · SessionLogSource   —— 宿主会话日志（<会话根>/**/session.jsonl[.zstd]；会话根由
                          MDCG_SESSIONS_ROOT 指定，内核不预设任何宿主路径）
                          zstd 为**可选**依赖：缺失时优雅降级（跳过 .zstd 文件并告警）
  · PiSessionSource    —— Pi 会话 jsonl（每行 {type:"message", message:{role, content}}；
                          角色与正文嵌在 message 字段里，与 SessionLogSource 的平键格式不同）

默认敏感度：会话内容是私有记忆 → sensitivity="private"（避免落入公开根）。

零第三方依赖（zstd 为可选增强）。
"""
from __future__ import annotations

import datetime
import glob
import json
import os
import time

from .security import DEFAULT_SENSITIVITY

# 会话事件的默认落层与敏感度
SESSION_LAYER = "contextual"
SESSION_SENSITIVITY = "private"


# --------------------------------------------------------------------------
# 事件源
# --------------------------------------------------------------------------

# 生效条件：无必填构造形参，类常量 name="source" 即实例默认；仅当子类覆写 events() 时才产出事件，基类 events() 恒抛 NotImplementedError。
class Source:
    """事件源基类。"""

    name = "source"

# 生效条件：任何调用都直接 raise NotImplementedError（基类占位，无其它分支）。
    def events(self):
        raise NotImplementedError

# 生效条件：无前置；返回类常量 self.name（基类为 "source"），作为 watermark 的稳定标识，不含路径与运行期状态；
    def key(self):
        """源的稳定标识（用于 watermark）。"""
        return self.name


# ────────────────────────────────────────────────────────────────────────────
# 已知宿主 JSONL 格式表（唯一真源 · 2026-10-08 加）
# 背景：JsonlSource 默认键是 time/role/text，而宿主日志常用 ts/user_input/susu_reply
# 一类字段 —— 取不到文本就整行静默跳过，目录摄取只报 written 0，看不出原因。
# 新增宿主格式只改这张表：require = 顶层键签名（全部命中才算），其余键名同 JsonlSource。
# ────────────────────────────────────────────────────────────────────────────
KNOWN_JSONL_FORMATS = (
    # Deeptalk 回合流水（susumemory/session_trace.jsonl）：
    # 一行一个回合，user_input = 提问原文，susu_reply = 回复原文，ts 为时间戳
    {"require": ("user_input", "susu_reply"), "t_key": "ts",
     "pair_fields": (("user_input", "user"), ("susu_reply", "assistant")),
     "session_key": "session_id"},
)


# 生效条件：path 存在且可读时，从头逐行试解析，已取满 max_hits(3) 个非空 JSON 对象、或已扫过 max_scan(200) 个物理行即停，返回这些对象顶层键的并集；文件不存在 / 无对象 / 全不可解析时返回空 set。（不设字节上限：宿主一行可能几十 KB，按累计字节掐会在解析首行之前就 break，嗅探必然落空。）
def _first_object_keys(path, max_hits=3, max_scan=200):
    """取文件开头几个 JSON 对象行的顶层键（格式嗅探用；只认对象行，坏行跳过）。"""
    keys = set()
    if not os.path.exists(path):
        return keys
    got = 0
    with open(path, encoding="utf-8", errors="replace") as f:
        for i, line in enumerate(f):
            if i >= max_scan:
                break
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if isinstance(o, dict) and o:
                keys |= set(o.keys())
                got += 1
                if got >= max_hits:
                    break
    return keys


# 生效条件：path 头部的 JSON 顶层键命中 KNOWN_JSONL_FORMATS 任一条的 require 时，返回按该条映射构造的 JsonlSource（t_key/role_key/text_key/pair_fields/session_key/meta_keys 全部来自表内，缺省用 JsonlSource 默认值）；未命中任何一条时返回默认键的 JsonlSource(path)。name 透传给 JsonlSource，为 None 时回落为 "jsonl:"+basename(path)。
def jsonl_source_for(path, name=None):
    """按内容嗅探宿主格式的 JsonlSource 工厂 —— dir / file 摄取统一走这里。"""
    keys = _first_object_keys(path)
    for fmt in KNOWN_JSONL_FORMATS:
        if all(k in keys for k in fmt["require"]):
            return JsonlSource(path, name=name,
                               t_key=fmt.get("t_key", "time"),
                               role_key=fmt.get("role_key", "role"),
                               text_key=fmt.get("text_key", "text"),
                               pair_fields=fmt.get("pair_fields"),
                               session_key=fmt.get("session_key") or "session",
                               meta_keys=fmt.get("meta_keys"))
    return JsonlSource(path, name=name)


# 生效条件：required 形参 path 总被存入 self.path；可选形参 name 为假值（None/空串）时 self.name 回落到 "jsonl:"+os.path.basename(path)，为真值时用 name 本身，t_key/role_key/text_key/default_role/pair_fields/session_key/cwd_key/meta_keys 原样存入属性（默认值 "time"/"role"/"text"/"user"/None/"session"/"cwd"/None）。
class JsonlSource(Source):
    """通用 JSONL 会话源。

    每行是事件对象；字段映射可配置：
      t_key      —— 时间戳字段（默认 "time"，也接受 ISO 字符串）
      role_key   —— 角色字段（默认 "role"）
      text_key   —— 文本字段（默认 "text"）

    一问一答型宿主格式（**一行多事件**，2026-10-08 加）：某些宿主把「用户原话 +
    回复原文」写在同一行。此时给 `pair_fields` 即可，无需改本类：
      pair_fields —— [(字段名, 角色), ...]，按序各产出一条事件（空字段跳过）
    seq 用 `2*行号 + 槽位` 区分同行两事件 —— Ingestor 的去重键是 (session, seq)，
    同行共用 seq 会让第二条被静默丢弃。

    其余可选映射：session_key（默认 "session"）、cwd_key（默认 "cwd"）、
    meta_keys（默认 None）——列出的附加字段以 `[键] 值` 追加到事件文本末尾，
    供检索命中结构化旁注（情绪/骰子一类）；默认不追加，行为与改造前逐字一致。
    """

# 生效条件：传入 path；name 为假值（None/空串）时回落为 "jsonl:"+os.path.basename(path)，t_key/role_key/text_key/default_role 原样存为属性（默认值 "time"/"role"/"text"/"user"）。
    def __init__(self, path: str, name: str = None, t_key="time", role_key="role",
                 text_key="text", default_role="user", pair_fields=None,
                 session_key="session", cwd_key="cwd", meta_keys=None):
        self.path = path
        self.name = name or ("jsonl:" + os.path.basename(path))
        self.t_key, self.role_key, self.text_key = t_key, role_key, text_key
        self.default_role = default_role
        # 一行多事件（一问一答型宿主格式）：[(字段名, 角色), ...]；None = 走 t_key/role_key/text_key 单事件老路
        self.pair_fields = [(str(k), str(v)) for k, v in pair_fields] if pair_fields else None
        self.session_key = session_key or "session"
        self.cwd_key = cwd_key or "cwd"
        self.meta_keys = [str(k) for k in meta_keys] if meta_keys else None

# 生效条件：无前置；返回 self.name（构造时已回落为 "jsonl:"+basename(path)），只随构造参数变化、不随文件内容变化；
    def key(self):
        return self.name

# 生效条件：o.get(self.t_key) 为 int/float 时返回 float(v) 乘 1000（v<1e12）或乘 1（否则）；为字符串且 v[:19] 按 "%Y-%m-%dT%H:%M:%S" 解析成功时返回 mktime*1000，抛 ValueError 时返回 0.0；键缺失或其它类型返回 0.0。
    def _ts(self, o):
        v = o.get(self.t_key)
        if isinstance(v, (int, float)):
            return float(v) * (1000.0 if v < 1e12 else 1.0)
        if isinstance(v, str):
            try:
                return time.mktime(time.strptime(v[:19], "%Y-%m-%dT%H:%M:%S")) * 1000
            except ValueError:
                return 0.0
        return 0.0

# 生效条件：os.path.exists(self.path) 为真时逐行产出；空行、json.loads 抛 ValueError、解析出非 dict 的行一律跳过。pair_fields 为 None（默认）时每行产出 1 条：seq=o.get("seq", i)、role=o.get(self.role_key) or self.default_role、text=str(o.get(self.text_key))，text 为假则跳过该行；pair_fields 非 None（一问一答型宿主）时每行按序为每个 (字段名, 角色) 产出 1 条，槽位值为假则跳过该槽位，seq=行内 seq*2+槽位（行内 seq 非 int 则原样沿用）。产出项统一带 session=o.get(self.session_key)、cwd=o.get(self.cwd_key)、line=i+1（所在文件行号——瘦身节点靠它写 `# 位置` 回读）；meta_keys 非 None 时把命中字段以 `[键] 值` 追加到 text 末尾。path 不存在时直接 return，不产出。
    def events(self):
        if not os.path.exists(self.path):
            return
        with open(self.path, encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f):
                self.last_line = i + 1
                line = line.strip()
                if not line:
                    continue
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(o, dict):   # 非对象行（模板/裸字符串）跳过，不再整目录崩
                    continue
                base = o.get("seq", i)
                if self.pair_fields:
                    # 一行多事件：同行每个字段各成一条。seq 必须同行内互异，
                    # 否则被 Ingestor 的 (session, seq) 去重键静默丢一条。
                    for k, (fkey, role) in enumerate(self.pair_fields):
                        text = o.get(fkey)
                        if not text:
                            continue
                        yield {"t": self._ts(o),
                               "seq": (base * 2 + k) if isinstance(base, int) else base,
                               "role": role,
                               "line": i + 1,
                               "text": self._meta(str(text), o),
                               "session": o.get(self.session_key),
                               "cwd": o.get(self.cwd_key)}
                    continue
                text = o.get(self.text_key)
                if not text:
                    continue
                yield {"t": self._ts(o), "seq": base,
                       "role": o.get(self.role_key) or self.default_role,
                       "line": i + 1,
                       "text": self._meta(str(text), o),
                       "session": o.get(self.session_key),
                       "cwd": o.get(self.cwd_key)}

# 生效条件：self.meta_keys 为 None 时原样返回 text；否则按 meta_keys 顺序把 o 中非空值拼成 `[键] 值`（空格分隔）追加到 text 末尾；无任何非空值时不追加。
    def _meta(self, text, o):
        if not self.meta_keys:
            return text
        parts = ["[%s] %s" % (k, o.get(k)) for k in self.meta_keys
                 if o.get(k) not in (None, "", [], {})]
        return (text + chr(10) + " ".join(parts)) if parts else text


# 生效条件：path 指向的内容可读且 zstandard 可导入时返回 StringIO(raw.decode("utf-8", errors="replace"))；ImportError 时返回 None。
def _zstd_reader(path):
    """返回可读的文本迭代器；zstd 不可用返回 None。"""
    import io
    try:
        import zstandard as zstd
    except ImportError:
        return None
    with open(path, "rb") as f:
        raw = zstd.ZstdDecompressor().stream_reader(f).read()
    return io.StringIO(raw.decode("utf-8", errors="replace"))


# 生效条件：无入参；环境变量 MDCG_SESSIONS_ROOT 以 os.pathsep 分隔后首个非空项去空白并 expanduser 后返回，变量为空或全为空项时返回 ""。
def _env_session_root() -> str:
    """会话根：由调用方经 `MDCG_SESSIONS_ROOT` 指定（多个根用 `os.pathsep` 分隔）。

    内核**不预置任何宿主路径**——接入方自己决定会话日志放在哪。
    """
    for part in os.environ.get("MDCG_SESSIONS_ROOT", "").split(os.pathsep):
        part = part.strip()
        if part:
            return os.path.expanduser(part)
    return ""


# 生效条件：required 形参 path 总被存入 self.path，可选形参 include_reasoning 原样存入，self.name 恒为 "session:"+os.path.basename(os.path.dirname(path))（与 include_reasoning 取值无关）。
class SessionLogSource(Source):
    """宿主会话日志源（`session.jsonl` 事件流格式）。

    解析的是**通用会话事件格式**，与具体宿主无关：任何产出下列事件类型的
    宿主日志都能直接接入。

    事件映射：
      user/message      → role=user
      assistant/message → role=assistant（只取 content[].text，reasoning 默认丢弃）
      tool/call         → role=command（"name(args)" 形式）
      tool/result       → role=tool-output
    """

# 生效条件：传入 path 即成立，include_reasoning 原样存为属性（默认 False），name 固定为 "session:"+os.path.basename(os.path.dirname(path))。
    def __init__(self, path: str, include_reasoning: bool = False):
        self.path = path
        self.include_reasoning = include_reasoning
        self.name = "session:" + os.path.basename(os.path.dirname(path))

# 生效条件：无前置；返回 self.name（构造时固定为 "session:"+basename(dirname(path))），与 include_reasoning 取值无关；
    def key(self):
        return self.name

    @staticmethod
# 生效条件：可选形参 root 为假值（None/空串）时改用 _env_session_root()（即 MDCG_SESSIONS_ROOT 的首个非空项），该值为空串时返回空列表（内核不预设任何宿主路径）；否则用传入 root；对 root 下递归 glob 到的 session.jsonl 与 session.jsonl.zstd 按 -os.path.getsize 降序排序（无命中时为空列表），可选形参 limit 为假值（None/0）时返回全部 files，否则返回 files[:limit]。
    def discover(root: str = None, limit: int = None):
        root = root or _env_session_root()
        if not root:
            return []                 # 内核不猜宿主路径：未指定会话根即无候选
        files = glob.glob(os.path.join(root, "**", "session.jsonl"), recursive=True)
        files += glob.glob(os.path.join(root, "**", "session.jsonl.zstd"), recursive=True)
        files.sort(key=lambda p: (-os.path.getsize(p), p))
        return files[:limit] if limit else files

# 生效条件：self.path 以 ".zstd" 结尾时经 _zstd_reader 逐行产出（其返回 None 时 raise RuntimeError），否则以 utf-8/errors=replace 打开 self.path 逐行产出。
    def _lines(self):
        if self.path.endswith(".zstd"):
            fh = _zstd_reader(self.path)
            if fh is None:
                raise RuntimeError("zstd 不可用（pip install zstandard），跳过该会话")
            try:
                yield from fh
            finally:
                fh.close()
        else:
            with open(self.path, encoding="utf-8", errors="replace") as f:
                yield from f

    @staticmethod
# 生效条件：required 形参 content 为 str 时原样返回 content；为 list 时收集其中 str 元素及 type 属于 ("text","input-text") 且 text 为真值的 dict 元素（取 str(c["text"])），以 "\n" 连接返回（无可收集元素时为空串 ""）；既非 str 也非 list 时返回 ""。
    def _text_of(content):
        """content 可能是 [{type,text}] 或字符串。"""
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts = []
            for c in content:
                if isinstance(c, dict):
                    if c.get("type") in ("text", "input-text") and c.get("text"):
                        parts.append(str(c["text"]))
                elif isinstance(c, str):
                    parts.append(c)
            return "\n".join(parts)
        return ""

# 生效条件：逐行解析后按 o.get("type") 分派——"session" 只更新 sess/cwd 不产出；"user/message" 产出 role=user 与 _text_of(data.get("content"))；"assistant/message" 产出 role=assistant 与 _text_of(msg.get("content"))，include_reasoning 为真时再把 content 中 type=="reasoning" 且有 text 的项追加 "\n[reasoning] "+str(c["text"])；"tool/call" 产出 role=command 与 f"{name}({arguments or ''})"；"tool/result" 产出 role=tool-output，仅当 inner[0] 为 dict 时 text=_text_of(inner[0].get("content"))；其它 type 或 ev 中 text 为空的事件不产出。产出项带 line（文件行号，enumerate 计数）。
    def events(self):
        sess = None
        cwd = None
        for i, line in enumerate(self._lines()):
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if not isinstance(o, dict):   # 同上：非对象行跳过
                continue
            t = o.get("type")
            data = o.get("data") or {}
            if t == "session":
                sess, cwd = o.get("id"), o.get("cwd")
                continue
            ev = {"t": float(o.get("time") or 0), "seq": o.get("seq"),
                  "line": i + 1,
                  "session": sess, "cwd": cwd}
            if t == "user/message":
                ev["role"], ev["text"] = "user", self._text_of(data.get("content"))
            elif t == "assistant/message":
                msg = data.get("message") or {}
                ev["role"] = "assistant"
                ev["text"] = self._text_of(msg.get("content"))
                if self.include_reasoning:
                    for c in (msg.get("content") or []):
                        if isinstance(c, dict) and c.get("type") == "reasoning" \
                                and c.get("text"):
                            ev["text"] = (ev["text"] or "") + "\n[reasoning] " + str(c["text"])
            elif t == "tool/call":
                ev["role"] = "command"
                ev["text"] = f"{data.get('name')}({data.get('arguments') or ''})"
            elif t == "tool/result":
                msg = data.get("message") or {}
                inner = msg.get("content") or []
                txt = ""
                if inner and isinstance(inner[0], dict):
                    txt = self._text_of(inner[0].get("content"))
                ev["role"], ev["text"] = "tool-output", txt
            else:
                continue
            if ev.get("text"):
                yield ev


# 生效条件：required 形参 path 总被存入 self.path；可选形参 name 为假值（None/空串）时回落为 "pi:"+文件主名（去扩展名）；可选形参 max_chars 为假值时取 1800，超长正文按行切块。
class PiSessionSource(Source):
    """Pi 会话日志源（`{type:"message", message:{role, content}}` 事件流）。

    与 SessionLogSource 的区别：Pi 把角色与正文**嵌在 message 字段里**，且每个
    assistant 回合的 thinking / toolCall 与正文平级；行级 type 取值是
    `session` / `message` / `custom` / `custom_message` / `model_change` /
    `thinking_level_change`，不是 `user/message` 那一套平键格式。

    事件映射（只取正文，思维链与工具结果不入图）：
      message.role=user      → role=user（content[].type=="text" 的 text）
      message.role=assistant → role=assistant（同上；只有 toolCall 没有正文的回合不产出）
      其它 role（system/toolResult）与其它 type 不产出

    时间：优先取 message.timestamp（毫秒数），否则把行 timestamp（ISO，UTC）按 UTC 解析。
    序号：seq = 行号 × CHUNK + 块号，切块后同行仍互异（Ingestor 去重键是 (session, seq)）。
    """

    CHUNK = 50

# 生效条件：传入 path；name 为假值时回落为 "pi:"+os.path.splitext(os.path.basename(path))[0]；max_chars 为假值（0/None）时用 1800。
    def __init__(self, path: str, name: str = None, max_chars: int = 1800):
        self.path = path
        self.name = name or ("pi:" + os.path.splitext(os.path.basename(path))[0])
        self.max_chars = int(max_chars or 1800)

# 生效条件：无前置；返回 self.name。
    def key(self):
        return self.name

    @staticmethod
# 生效条件：root 为假值时改用 _env_session_root()（MDCG_SESSIONS_ROOT 首个非空项），该值为空串时返回空列表；否则递归 glob root 下全部 .jsonl 后按文件名升序（Pi 文件名前缀即 ISO 时刻）返回，limit 为假值时全量返回。
    def discover(root: str = None, limit: int = None):
        root = root or _env_session_root()
        if not root:
            return []
        files = glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True)
        files.sort(key=lambda p: os.path.basename(p))
        return files[:limit] if limit else files

# 生效条件：始终以 utf-8/errors=replace 打开 self.path 逐行产出文本行（不做 zstd 解压）。
    def _lines(self):
        with open(self.path, encoding="utf-8", errors="replace") as f:
            yield from f

    @staticmethod
# 生效条件：content 为 str 时原样返回；为 list 时收集其中 str 元素与 type 属于 ("text","input-text") 且 text 为真值的 dict 元素，以换行连接返回；其它类型返回空串（thinking/toolCall 不计入）。
    def _text_of(content):
        if isinstance(content, str):
            return content
        parts = []
        if isinstance(content, list):
            for c in content:
                if isinstance(c, dict):
                    if c.get("type") in ("text", "input-text") and c.get("text"):
                        parts.append(str(c["text"]))
                elif isinstance(c, str):
                    parts.append(c)
        return chr(10).join(parts)

# 生效条件：msg.get("timestamp") 为真值数字时按 <1e12 乘 1000 返回；否则取 o.get("timestamp") 为字符串且前 19 字符按 "%Y-%m-%dT%H:%M:%S" 解析成功时按 UTC 返回毫秒；两者都不成立时返回 0.0。
    def _ts_ms(self, o, msg):
        v = msg.get("timestamp")
        if isinstance(v, (int, float)) and v:
            return float(v) * (1000.0 if v < 1e12 else 1.0)
        v = o.get("timestamp")
        if isinstance(v, str) and v:
            try:
                dt = datetime.datetime.strptime(v[:19], "%Y-%m-%dT%H:%M:%S")
                return float(dt.replace(tzinfo=datetime.timezone.utc).timestamp()) * 1000
            except ValueError:
                return 0.0
        return 0.0

# 生效条件：text 长度不超过 self.max_chars 时原样返回单元素列表；否则按换行逐段累积，累积将超限即先落一块，单段自身超限时按 max_chars 硬切；空文本返回空列表。
    def _chunks(self, text):
        if len(text) <= self.max_chars:
            return [text]
        out, buf = [], ""
        for para in text.split(chr(10)):
            if buf and len(buf) + len(para) + 1 > self.max_chars:
                out.append(buf)
                buf = ""
            buf = (buf + chr(10) + para) if buf else para
            while len(buf) > self.max_chars:
                out.append(buf[:self.max_chars])
                buf = buf[self.max_chars:]
        if buf:
            out.append(buf)
        return out

# 生效条件：逐行解析，空行、json.loads 抛 ValueError、非 dict 行一律跳过；type=="session" 只记 id/cwd 不产事件；type=="message" 且 message.role 属于 ("user","assistant") 时取正文，正文全空白则不产出，否则按 _chunks 切块、第 k 块 seq=行号×CHUNK+k；产出项带 session（会话 id，缺失时用文件名主名）与 cwd；其它 type 与其它 role 不产出。
    def events(self):
        sess = None
        cwd = None
        stem = os.path.splitext(os.path.basename(self.path))[0]
        for i, line in enumerate(self._lines()):
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if not isinstance(o, dict):
                continue
            if o.get("type") == "session":
                sess = o.get("id") or sess
                cwd = o.get("cwd") or cwd
                continue
            if o.get("type") != "message":
                continue
            msg = o.get("message")
            if not isinstance(msg, dict):
                continue
            role = msg.get("role")
            if role not in ("user", "assistant"):
                continue
            text = self._text_of(msg.get("content"))
            if not text.strip():
                continue
            t = self._ts_ms(o, msg)
            for k, chunk in enumerate(self._chunks(text)):
                yield {"t": t, "seq": i * self.CHUNK + k, "role": role,
                       "line": i + 1, "text": chunk, "session": sess or stem,
                       "cwd": cwd}


# 生效条件：path 不是文件、无非空行、首行 json.loads 抛 ValueError 或 open 抛 OSError 时返回 None；首行解析为 dict 且 type=="session" 且含 "version" 时返回 PiSessionSource(path)；首行是其它内容（含 message 行）时立即返回 None。
def pi_session_source_for(path, name=None):
    """Pi 会话 jsonl 嗅探：头部是 type=session 头即认领，其它返回 None。"""
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    o = json.loads(line)
                except ValueError:
                    return None
                if isinstance(o, dict) and o.get("type") == "session" and "version" in o:
                    return PiSessionSource(path, name=name)
                return None
    except OSError:
        return None
    return None


# --------------------------------------------------------------------------
# 摄取器
# --------------------------------------------------------------------------

# 生效条件：required 形参 cg 总被存入并以其 cg.root 拼出 self.path=os.path.join(cg.root,"_sources.json")；layer/sensitivity 原样存入，未传时取模块级常量 SESSION_LAYER、SESSION_SENSITIVITY 作为默认值。
def _source_roots():
    roots = []
    seen = set()
    for part in os.environ.get("MDCG_SESSIONS_ROOT", "").split(os.pathsep):
        part = part.strip()
        if not part:
            continue
        root = os.path.realpath(os.path.expanduser(part))
        key = os.path.normcase(root)
        if os.path.isdir(root) and key not in seen:
            roots.append(root)
            seen.add(key)
    return sorted(roots, key=len, reverse=True)


def _source_root_id(root):
    import hashlib
    canonical = os.path.normcase(os.path.realpath(root))
    return hashlib.sha256(canonical.encode("utf-8", errors="surrogatepass")).hexdigest()[:24]


def _source_parser_config(source):
    if isinstance(source, JsonlSource):
        fields = (source.t_key, source.role_key, source.text_key,
                  source.default_role, source.session_key, source.cwd_key)
        pairs = [list(pair) for pair in source.pair_fields] if source.pair_fields else None
        meta_keys = list(source.meta_keys) if source.meta_keys else None
        if not all(isinstance(value, str) for value in fields):
            return None
        if pairs is not None and not all(
                isinstance(pair, list) and len(pair) == 2
                and all(isinstance(value, str) for value in pair) for pair in pairs):
            return None
        if meta_keys is not None and not all(isinstance(value, str) for value in meta_keys):
            return None
        return "jsonl", {
            "t_key": source.t_key, "role_key": source.role_key,
            "text_key": source.text_key, "default_role": source.default_role,
            "pair_fields": pairs, "session_key": source.session_key,
            "cwd_key": source.cwd_key, "meta_keys": meta_keys,
        }
    if isinstance(source, SessionLogSource):
        return "sessionlog", {"include_reasoning": bool(source.include_reasoning)}
    if isinstance(source, PiSessionSource):
        if not isinstance(source.max_chars, int) or source.max_chars < 1:
            return None
        return "pi", {"max_chars": source.max_chars}
    return None


def _build_source_search_index(cg, node_id, text, sensitivity):
    from .mdcg import bigrams, trigrams, en_zh_bigrams, normalize_en
    normalized = normalize_en(text)
    terms = sorted(bigrams(normalized) | en_zh_bigrams(text))
    trigram_terms = sorted(trigrams(normalized))
    payload = json.dumps({"version": 2, "terms": terms,
                          "trigrams": trigram_terms},
                         ensure_ascii=False, separators=(",", ":"))
    return cg._seal_content(node_id, payload, sensitivity)


def _build_source_ref(source, event):
    import hashlib
    parser = _source_parser_config(source)
    path = getattr(source, "path", None)
    line = event.get("line")
    text = event.get("text")
    if parser is None or not isinstance(path, str) or not isinstance(line, int) or line < 1:
        return None
    if not isinstance(text, str):
        return None
    seq, session, role = event.get("seq"), event.get("session"), event.get("role")
    if not (seq is None or isinstance(seq, (str, int, float, bool))):
        return None
    if not (session is None or isinstance(session, str)):
        return None
    if not (role is None or isinstance(role, str)):
        return None
    source_path = os.path.realpath(path)
    for root in _source_roots():
        try:
            if os.path.normcase(os.path.commonpath((root, source_path))) != os.path.normcase(root):
                continue
        except ValueError:
            continue
        relative = os.path.relpath(source_path, root).replace(os.sep, "/")
        parts = relative.split("/")
        if (not relative or relative.startswith("/") or chr(92) in relative
                or any(part in ("", ".", "..") for part in parts)):
            continue
        adapter, config = parser
        return {
            "version": 1,
            "root_id": _source_root_id(root),
            "path": relative,
            "adapter": adapter,
            "config": config,
            "line": line,
            "seq": seq,
            "session": session,
            "role": role,
            "event_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        }
    return None


def _resolve_source_ref(ref):
    import hashlib
    import ntpath
    if not isinstance(ref, dict) or type(ref.get("version")) is not int or ref["version"] != 1:
        return {"status": "source_ref_invalid"}
    relative = ref.get("path")
    if not isinstance(relative, str) or not relative or relative.startswith("/"):
        return {"status": "source_path_invalid"}
    if ntpath.splitdrive(relative)[0] or chr(92) in relative:
        return {"status": "source_path_invalid"}
    parts = relative.split("/")
    if any(part in ("", ".", "..") for part in parts):
        return {"status": "source_path_invalid"}
    if not isinstance(ref.get("line"), int) or ref["line"] < 1:
        return {"status": "source_ref_invalid"}
    if not isinstance(ref.get("event_sha256"), str):
        return {"status": "source_ref_invalid"}
    root = next((candidate for candidate in _source_roots()
                 if _source_root_id(candidate) == ref.get("root_id")), None)
    if root is None:
        return {"status": "source_root_unavailable"}
    path = os.path.realpath(os.path.join(root, *parts))
    try:
        if os.path.normcase(os.path.commonpath((root, path))) != os.path.normcase(root):
            return {"status": "source_path_invalid"}
    except ValueError:
        return {"status": "source_path_invalid"}
    if not os.path.isfile(path):
        return {"status": "source_missing"}
    adapter, config = ref.get("adapter"), ref.get("config")
    if not isinstance(config, dict):
        return {"status": "source_ref_invalid"}
    if adapter == "jsonl":
        required = {"t_key", "role_key", "text_key", "default_role", "pair_fields",
                    "session_key", "cwd_key", "meta_keys"}
        if set(config) != required:
            return {"status": "source_ref_invalid"}
        string_keys = required - {"pair_fields", "meta_keys"}
        if not all(isinstance(config.get(key), str) for key in string_keys):
            return {"status": "source_ref_invalid"}
        for key in ("pair_fields", "meta_keys"):
            value = config.get(key)
            if value is not None and not isinstance(value, list):
                return {"status": "source_ref_invalid"}
        pairs = config.get("pair_fields") or []
        if not all(isinstance(pair, list) and len(pair) == 2
                   and all(isinstance(value, str) for value in pair) for pair in pairs):
            return {"status": "source_ref_invalid"}
        if not all(isinstance(value, str) for value in (config.get("meta_keys") or [])):
            return {"status": "source_ref_invalid"}
        source = JsonlSource(path, **config)
    elif adapter == "sessionlog":
        if set(config) != {"include_reasoning"} or not isinstance(config["include_reasoning"], bool):
            return {"status": "source_ref_invalid"}
        source = SessionLogSource(path, **config)
    elif adapter == "pi":
        if (set(config) != {"max_chars"} or not isinstance(config["max_chars"], int)
                or config["max_chars"] < 1 or config["max_chars"] > 1000000):
            return {"status": "source_ref_invalid"}
        source = PiSessionSource(path, **config)
    else:
        return {"status": "source_ref_invalid"}
    matches = []
    try:
        for event in source.events():
            event_line = event.get("line")
            if event_line > ref["line"]:
                break
            if (event_line == ref["line"] and event.get("seq") == ref.get("seq")
                    and event.get("session") == ref.get("session")
                    and event.get("role") == ref.get("role")):
                matches.append(event)
    except (OSError, RuntimeError, UnicodeError):
        return {"status": "source_unavailable"}
    if not matches:
        return {"status": "source_event_missing"}
    if len(matches) != 1:
        return {"status": "source_event_ambiguous"}
    text = matches[0].get("text")
    if not isinstance(text, str) or hashlib.sha256(text.encode("utf-8")).hexdigest() != ref["event_sha256"]:
        return {"status": "source_event_changed"}
    return {"status": "ok", "text": text}
class Ingestor:
    """增量摄取：watermark + 去重 + 写节点 + 自动 fix-pair 挖掘。

    watermark 文件：<root>/_sources.json
        {source_key: {"t": 最后时间戳(ms), "seq": 最后序号, "count": 已摄取条数}}
    """

# 生效条件：传入带 root 的 cg 即成立，layer/sensitivity 默认 SESSION_LAYER/SESSION_SENSITIVITY 并原样存为属性，路径为 os.path.join(cg.root, "_sources.json")。
    def __init__(self, cg, layer: str = SESSION_LAYER,
                 sensitivity: str = SESSION_SENSITIVITY, rebuild: bool = False):
        self.cg = cg
        self.layer = layer
        # rebuild=True：越过「id 已存在即跳过」的幂等守卫，原地重写为当前形态（瘦身/形态迁移用）
        self.rebuild = bool(rebuild)
        self.sensitivity = sensitivity
        self.path = os.path.join(cg.root, "_sources.json")

    # ---- watermark ----

# 生效条件：self.path 存在、json.load 成功且结果为 dict 时返回该 dict；path 不存在、抛 ValueError/OSError 或结果非 dict 时返回 {"schema": 1, "sources": {}}。
    def _load(self):
        if os.path.exists(self.path):
            try:
                with open(self.path, encoding="utf-8") as f:
                    d = json.load(f)
                if isinstance(d, dict):
                    return d
            except (ValueError, OSError):
                pass
        return {"schema": 1, "sources": {}}

# 生效条件：传入 d 时以 ensure_ascii=False/indent=1 写入 self.path+".tmp"，再 os.replace 覆盖 self.path。
    def _save(self, d):
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=1)
        os.replace(tmp, self.path)

# 生效条件：key 命中 self._load()["sources"] 时返回其值，缺 key 时返回 {}（_load 结果缺 "sources" 键则抛 KeyError）。
    def watermark(self, key: str):
        return self._load()["sources"].get(key, {})

# 生效条件：调用即返回 dict(self._load()["sources"]) 的浅拷贝（_load 结果缺 "sources" 键则抛 KeyError）。
    def watermarks(self):
        return dict(self._load()["sources"])

    # ---- 摄取 ----

# 生效条件：对必需形参 source，先按 watermark(source.key()) 跳过 t<last_t（wm 的 "t" 为假值时视作 0）及 t==last_t 且 last_seq 非 None 且 ev["seq"] 为 int 且 <= last_seq 的事件、并按 (session, seq) 去重，max_events 为真值（非 0/None）时取满即停；dry_run 为假时逐条 cg.add（nid 已在 cg.index["nodes"] 中则跳过，cg.add 抛异常则 denied+=1、记 last_error 并继续），denied 与 last_error 同时成立时补 last_error/hint，mine_fix_pairs 为真且 new_events 非空且非 dry_run 时结果附 fix_pairs，new_events 非空且非 dry_run 时以末事件写回水位（count 累加 written），最后返回 result。
    def ingest(self, source, mine_fix_pairs: bool = True, max_events: int = None,
               dry_run: bool = False):
        """摄取一个源的新事件。返回统计。

        去重键：(session, seq) —— 同一事件不重复入库。
        增量：只处理 (t, seq) 大于 watermark 的事件。
        """
        key = source.key()
        wm = self.watermark(key)
        last_t, last_seq = float(wm.get("t") or 0), wm.get("seq")
        if getattr(self, "rebuild", False):
            # 重建模式：忽略水位全量重走，配合上面的幂等旁路把旧节点原地重写为当前形态
            last_t, last_seq = 0.0, None
        new_events, seen = [], set()
        for ev in source.events():
            if ev.get("t", 0) < last_t:
                continue
            if ev.get("t", 0) == last_t and last_seq is not None \
                    and isinstance(ev.get("seq"), int) and ev["seq"] <= last_seq:
                continue
            dedup = (ev.get("session"), ev.get("seq"))
            if dedup in seen:
                continue
            seen.add(dedup)
            new_events.append(ev)
            if max_events and len(new_events) >= max_events:
                break

        written, ids, denied = 0, [], 0
        if not dry_run:
            for ev in new_events:
                source_ref = _build_source_ref(source, ev)
                source_ref_kw = {"source_ref": source_ref} if source_ref is not None else {}
                nid = "src_%s_%s" % (_sig(key)[:6], _sig(
                    f"{ev.get('session')}:{ev.get('seq')}")[:10])
                if nid in self.cg.index["nodes"] and not getattr(self, "rebuild", False):
                    continue          # 幂等（rebuild=True 时原地重写为瘦身版）
                if source_ref is not None:
                    source_ref_kw["source_search_index"] = _build_source_search_index(
                        self.cg, nid, ev["text"], self.sensitivity)
                _head = " ".join(str(ev.get("text") or "").split())
                _line = ev.get("line") or getattr(source, "last_line", None) or ev.get("seq")
                _pos = "%s:%s" % (os.path.basename(getattr(source, "path", "") or key), _line)
                body = ("# 功能名：会话事件\n"
                        f"# 生效条件：检索「{_head[:20]}」\n"
                        "# 子功能：记录会话事件\n"
                        f"# 执行：{_head[:240]}\n"
                        f"# 验证方式：data（以原始日志为准；区间 {_pos}）\n"
                        "# 不适用条件：其它会话\n"
                        f"# 位置：{_pos}（jsonl，precise=True）\n")
                try:
                    self.cg.add(nid, body, layer=self.layer, role=ev.get("role"),
                                tags=["session", key], sensitivity=self.sensitivity,
                                verification_basis="data",
                                override=bool(getattr(self, "rebuild", False)),
                                condition_space={"observation_position": key,
                                                 "observation_tool": "会话流",
                                                 "existence_constraint": "源日志 %s 存在且可读" % _pos,
                                                 "time_window": [ev.get("t") or 0,
                                                                 ev.get("t") or 0]},
                                **source_ref_kw)
                except Exception as exc:   # noqa: BLE001 —— 权限/层错误不中断整批
                    denied += 1
                    self.last_error = f"{type(exc).__name__}: {exc}"
                    continue
                ids.append(nid)
                written += 1

        result = {"source": key, "new_events": len(new_events), "written": written,
                  "denied": denied, "ids": ids, "dry_run": dry_run,
                  "sensitivity": self.sensitivity}
        if denied and getattr(self, "last_error", None):
            result["last_error"] = self.last_error
            result["hint"] = ("会话内容默认 sensitivity=private；"
                              "调用方需 MDCG_CLEARANCE=private 才能写入")
        # 自动 fix-pair 挖掘（错误→修复）
        if mine_fix_pairs and new_events and not dry_run:
            result["fix_pairs"] = self.cg.mine_fix_pairs(
                [{"role": e.get("role"), "text": e.get("text")} for e in new_events])

        if new_events and not dry_run:
            d = self._load()
            last = new_events[-1]
            d["sources"][key] = {
                "t": last.get("t") or last_t,
                "seq": last.get("seq"),
                "count": (wm.get("count") or 0) + written,
                "updated_at": time.time(),
                "path": getattr(source, "path", None),
            }
            self._save(d)
        return result


# 生效条件：text 为 None 或假值时按 "" 参与 sha1；n 默认 12，返回 hexdigest 前 n 位（n=0 得空串）。
def _sig(text: str, n: int = 12) -> str:
    import hashlib
    return hashlib.sha1((text or "").encode("utf-8")).hexdigest()[:n]


# --------------------------------------------------------------------------
# 摄取分派（P0 · ingest op）：按扩展名选摄取方式，单一入口吃多种文件
# --------------------------------------------------------------------------
#
# 三条摄取链：
#   session —— 会话流（.jsonl）：走 Ingestor（watermark + 去重 + fix-pair）
#   doc     —— 文档（.md/.txt/...）：走 docindex.extract + refindex.add_items
#   code    —— 代码（.py/.ts/...）：走 codeindex.extract + refindex.add_items
#
# 设计要点：
#   - 注册表 INGEST_REGISTRY 是唯一真源：新增后缀只改这里。
#   - dir 动作分链处理：目录里 doc / code / jsonl 混放时各链互不干扰。
#   - 幂等：沿用 refindex.Ledger（size+mtime 水位）与 Ingestor watermark。
#   - 预演：dry_run=True 只统计、不写入（对应计划「可预演」要求）。

INGEST_ACTIONS = ("file", "dir", "jsonl", "stat")

INGEST_REGISTRY = {
    # 会话流
    ".jsonl": "session", ".ndjson": "session",
    # 文档
    ".md": "doc", ".markdown": "doc", ".txt": "doc", ".rst": "doc",
    ".html": "doc", ".htm": "doc",
    # 代码
    ".py": "code", ".js": "code", ".mjs": "code", ".ts": "code",
    ".tsx": "code", ".jsx": "code", ".go": "code", ".rs": "code",
    ".java": "code", ".kt": "code", ".swift": "code", ".rb": "code",
    ".php": "code", ".cs": "code", ".cpp": "code", ".cc": "code",
    ".c": "code", ".h": "code", ".hpp": "code",
}


# 生效条件：path 为 None 或空串时 splitext 得 "" 且未登记 → 返回 None；扩展名（小写）存在于 INGEST_REGISTRY 时返回其 kind。
def dispatch_of(path: str):
    """按扩展名返回摄取方式（session / doc / code）；未登记返回 None。"""
    return INGEST_REGISTRY.get(os.path.splitext(path or "")[1].lower())


# 生效条件：required 形参 cg 总被存入；可选形参 sensitivity 为假值（None/空串）时内部 Ingestor 的 sensitivity 回落模块级常量 SESSION_SENSITIVITY，为真值时用传入的 sensitivity。
class FileDispatcher:
    """单一入口吃多种文件：按扩展名分派到会话流 / 文档 / 代码三条摄取链。"""

# 生效条件：传入 cg 即成立，sensitivity 为假值（None/空串）时所用 Ingestor 回落 SESSION_SENSITIVITY，否则用传入值。
    def __init__(self, cg, sensitivity=None, rebuild=False):
        self.cg = cg
        # 会话链默认 sensitivity=private；调用方可显式覆盖（测试/受限环境）
        self.ingestor = Ingestor(cg, sensitivity=sensitivity or SESSION_SENSITIVITY,
                                 rebuild=rebuild)

    # ---- stat：看水位与支持面 ----

# 生效条件：from . import refindex 与 refindex.Ledger(self.cg.root).stat() 均不抛异常时返回该 stat 结果，抛任何异常时返回 {}。
    def _ledger_stat(self):
        try:
            from . import refindex
            # 2026-10-08 修：Ledger 没有 stat()，原名一直 AttributeError 被 except 吞成 {}
            return refindex.Ledger(self.cg.root).summary()
        except Exception:                                  # noqa: BLE001
            return {}

# 生效条件：调用即返回由 INGEST_REGISTRY 按 kind 分组并排序后的 extensions、list(INGEST_ACTIONS)、self.ingestor.watermarks()、self._ledger_stat() 与固定 note。
    def stat(self):
        kinds = {}
        for ext, kind in INGEST_REGISTRY.items():
            kinds.setdefault(kind, []).append(ext)
        return {"ok": True, "kind": "stat", "actions": list(INGEST_ACTIONS),
                "extensions": {k: sorted(v) for k, v in sorted(kinds.items())},
                "watermarks": self.ingestor.watermarks(),
                "ledger": self._ledger_stat(),
                "note": ("注册表是唯一真源：新增后缀只改 INGEST_REGISTRY。"
                         "watermarks=会话流水位；ledger=文档/代码文件水位。")}

    # ---- 单文件 ----

# 生效条件：dispatch_of(path) 为 None 时返回 ok=False 的「不支持的后缀」结果；path 不是文件时返回 ok=False 的「文件不存在」结果；kind=="session" 时转 ingest_jsonl(path, dry_run=dry_run)（layer/sensitivity 不参与）；其它 kind 转 _ingest_doc_or_code(path, kind, layer=layer, sensitivity=sensitivity, dry_run=dry_run)。
    def ingest_file(self, path, layer=None, sensitivity=None, dry_run=False):
        kind = dispatch_of(path)
        if kind is None:
            ext = os.path.splitext(path or "")[1] or "(无后缀)"
            return {"ok": False, "path": path, "error": f"不支持的后缀：{ext}",
                    "supported": sorted(INGEST_REGISTRY)}
        if not os.path.isfile(path):
            return {"ok": False, "path": path, "error": "文件不存在"}
        if kind == "session":
            return self.ingest_jsonl(path, dry_run=dry_run)
        return self._ingest_doc_or_code(path, kind, layer=layer,
                                         sensitivity=sensitivity, dry_run=dry_run)

# 生效条件：kind=="code" 用 codeindex 否则用 docindex；mod.extract 抛 ValueError 时返回 ok=False 的「抽取失败」；dry_run 为真时只返回 items 计数与前 20 个 node_id 不写盘；否则经 refindex.add_items（kind 为 code_ref/doc_ref）写入并返回 indexed、ids[:20] 与 sensitivity。
    def _ingest_doc_or_code(self, path, kind, layer=None, sensitivity=None,
                            dry_run=False):
        from . import codeindex, docindex, refindex
        mod = codeindex if kind == "code" else docindex
        rel = os.path.basename(path)
        with open(path, encoding="utf-8", errors="replace") as f:
            src = f.read()
        try:
            items = mod.extract(src, path=rel,
                                suffix=os.path.splitext(path)[1].lower())
        except ValueError as exc:
            return {"ok": False, "path": path, "error": f"抽取失败：{exc}"}
        items = items or []
        if dry_run:
            return {"ok": True, "dry_run": True, "kind": kind, "path": path,
                    "items": len(items),
                    "ids": [mod.node_id(i) for i in items[:20]],
                    "note": "预演：只抽取计数，未写盘"}
        ref_kind = "code_ref" if kind == "code" else "doc_ref"
        ids, sens = refindex.add_items(
            self.cg, items, kind=ref_kind,
            root=os.path.dirname(path) or ".", layer=layer,
            sensitivity=sensitivity)
        return {"ok": True, "kind": kind, "path": path, "items": len(items),
                "indexed": len(ids), "ids": ids[:20], "sensitivity": sens}

    # ---- 目录 ----

# 生效条件：调用即 os.walk(root) 统计每个文件名经 dispatch_of 得到的 kind（无匹配记 "unsupported"）并返回 dry_run 预演计数结果。
    def _dry_dir(self, root):
        counts = {}
        for _dp, _dn, fns in os.walk(root):
            for name in fns:
                k = dispatch_of(name) or "unsupported"
                counts[k] = counts.get(k, 0) + 1
        return {"ok": True, "dry_run": True, "kind": "dir", "root": root,
                "counts": counts,
                "note": "预演：仅统计各链文件数，未做任何写入"}

# 生效条件：root 非目录时返回 ok=False 的「目录不存在」；dry_run 为真时返回 _dry_dir(root)；否则对 doc_ref/code_ref 两链各以 patterns/max_files/max_items/incremental/ledger 调 refindex.index_dir 与 add_items，并把 root 下 **/*.jsonl 前 max_files 个逐个 ingest_jsonl 后返回 out。
    def ingest_dir(self, root, layer=None, sensitivity=None, patterns=None,
                   max_files=500, max_items=2000, incremental=False,
                   dry_run=False):
        from . import refindex
        if not os.path.isdir(root):
            return {"ok": False, "error": f"目录不存在：{root}"}
        if dry_run:
            return self._dry_dir(root)
        ledger = refindex.Ledger(self.cg.root)
        out = {"ok": True, "kind": "dir", "root": root, "chains": {}}
        for ref_kind, key in (("doc_ref", "doc"), ("code_ref", "code")):
            items, errors, stats = refindex.index_dir(
                root, kind=ref_kind, patterns=patterns, max_files=max_files,
                max_items=max_items, incremental=incremental, ledger=ledger)
            ids, sens = refindex.add_items(self.cg, items, kind=ref_kind,
                                           root=root, layer=layer,
                                           sensitivity=sensitivity)
            out["chains"][key] = {
                "indexed": len(ids), "errors": len(errors),
                "files": stats.get("files"), "truncated": stats.get("truncated"),
                "skipped_unchanged": stats.get("skipped_unchanged", 0),
                "skipped_suffixes": stats.get("skipped_suffixes", []),
                "sensitivity": sens}
        # 会话流（.jsonl）逐个增量摄取
        jsons = sorted(glob.glob(os.path.join(root, "**", "*.jsonl"),
                                 recursive=True))[:max_files]
        ses = []
        for p in jsons:
            r = self.ingest_jsonl(p)
            ses.append({"path": p, "written": r.get("written", 0),
                        "new_events": r.get("new_events", 0)})
        out["chains"]["session"] = {"files": len(jsons), "results": ses}
        return out

    # ---- 会话流 ----

    @staticmethod
# 生效条件：required 形参 path 先交给 pi_session_source_for 嗅探，命中 Pi 会话头（首行 type=="session" 且含 version）即返回 PiSessionSource；未命中时被 open(...,encoding="utf-8",errors="replace") 打开读前 50000 字符，head 含 '"user/message"'、'"assistant/message"'、'"tool/call"' 任一标记则返回 SessionLogSource(path)，否则返回 jsonl_source_for(path)（头部键命中 KNOWN_JSONL_FORMATS 时带表内字段映射，未命中则为默认键 JsonlSource）；打开抛 OSError 时同样走 jsonl_source_for(path)（文件不可读 → 空键集 → 默认键 JsonlSource）。
    def _auto_source(path):
        """通用 JSONL vs 会话日志：按内容探测，避免调用方选错源类型。"""
        pi = pi_session_source_for(path)
        if pi is not None:
            return pi
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                head = f.read(50000)
        except OSError:
            return JsonlSource(path)
        for marker in ('"user/message"', '"assistant/message"', '"tool/call"'):
            if marker in head:
                return SessionLogSource(path)
        return jsonl_source_for(path)   # 宿主格式嗅探：命中 KNOWN_JSONL_FORMATS 就用表内字段映射

# 生效条件：path 不是文件时返回 ok=False 的「文件不存在」；否则经 _auto_source(path) 选源后调 self.ingestor.ingest(src, dry_run=dry_run, max_events=max_events)，并补上 ok=True/kind/path/source_class 后返回。
    def ingest_jsonl(self, path, dry_run=False, max_events=None):
        if not os.path.isfile(path):
            return {"ok": False, "error": f"文件不存在：{path}"}
        src = self._auto_source(path)
        res = self.ingestor.ingest(src, dry_run=dry_run, max_events=max_events)
        res.update({"ok": True, "kind": "session", "path": path,
                    "source_class": type(src).__name__})
        return res


# 生效条件：cg 必填；action 为 None/空串时 (action or "stat") 归为 stat；file/jsonl 缺 path 返回 ok=False；dir 的 max_files/max_items 走 int(x or 500)/int(x or 2000)，传 0 也变 500/2000；未知 action 抛 ValueError。
def run(cg, action: str = "stat", **kw):
    """ingest op 唯一入口。"""
    act = (action or "stat").strip().lower()
    d = FileDispatcher(cg, sensitivity=kw.get("sensitivity"),
                       rebuild=bool(kw.get("rebuild")))
    if act == "stat":
        return d.stat()
    if act == "file":
        p = kw.get("path")
        if not p:
            return {"ok": False, "error": "file 动作需要 path"}
        return d.ingest_file(p, layer=kw.get("layer"),
                             sensitivity=kw.get("sensitivity"),
                             dry_run=bool(kw.get("dry_run")))
    if act == "dir":
        p = kw.get("path") or cg.root
        return d.ingest_dir(p, layer=kw.get("layer"),
                            sensitivity=kw.get("sensitivity"),
                            patterns=kw.get("patterns"),
                            max_files=int(kw.get("max_files") or 500),
                            max_items=int(kw.get("max_items") or 2000),
                            incremental=bool(kw.get("incremental")),
                            dry_run=bool(kw.get("dry_run")))
    if act == "jsonl":
        p = kw.get("path")
        if not p:
            return {"ok": False, "error": "jsonl 动作需要 path"}
        return d.ingest_jsonl(p, dry_run=bool(kw.get("dry_run")),
                              max_events=kw.get("max_events"))
    raise ValueError(f"未知 ingest action：{action!r}（允许 {INGEST_ACTIONS}）")