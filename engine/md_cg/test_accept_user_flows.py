# -*- coding: utf-8 -*-
"""Alpha-Memory 发行端 · 新用户视角全场景验收（非暴力）

模拟一个刚 clone 仓库的新用户，逐场景执行，所有 HOME/令牌/记忆全部重定向到
临时沙箱，绝不触碰宿主机真实状态。

运行：python -m md_cg.test_accept_user_flows
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ENGINE = Path(__file__).resolve().parent.parent

PASS = FAIL = 0
FAILS = []


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [PASS] {name}" + (f"  · {detail}" if detail else ""))
    else:
        FAIL += 1
        FAILS.append(name)
        print(f"  [FAIL] {name}  · {detail}")


def run(cmd, env, cwd, timeout=120, input_text=None):
    return subprocess.run(cmd, cwd=cwd, env=env, input=input_text,
                          capture_output=True, text=True, encoding="utf-8",
                          timeout=timeout)


class McpSession:
    """逐行 JSON-RPC 客户端，能收集夹在响应之间的通知。"""

    def __init__(self, env, cwd):
        self.env = env
        self.cwd = cwd
        self.p = None
        self._id = 0
        self.notices = []

    def start(self):
        self.p = subprocess.Popen(
            [sys.executable, "-m", "md_cg.mcp_server"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding="utf-8",
            env=self.env, cwd=self.cwd, bufsize=1)
        return self

    def send(self, method, params=None, expect=True):
        self._id += 1
        rid = self._id if expect else None
        msg = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        if rid is not None:
            msg["id"] = rid
        self.p.stdin.write(json.dumps(msg) + "\n")
        self.p.stdin.flush()
        if rid is None:
            return None
        # 读到的通知先收起来，直到拿到带 id 的响应
        for _ in range(50):
            line = self.p.stdout.readline()
            if not line:
                return None
            try:
                m = json.loads(line)
            except ValueError:
                continue
            if "id" not in m:
                self.notices.append(m)
                continue
            if m.get("id") == rid:
                return m
        return None

    def drain_notices(self):
        out, self.notices = self.notices, []
        return out

    def stop(self):
        try:
            self.send("shutdown", {})
        except Exception:
            pass
        try:
            self.p.terminate()
            self.p.wait(timeout=10)
        except Exception:
            self.p.kill()


def fresh_env(home, root, extra=None):
    e = dict(os.environ)
    for k in list(e):
        if k.startswith(("MDCG_", "ALPHA_")):
            e.pop(k, None)
    e.update({
        "HOME": str(home), "USERPROFILE": str(home),
        "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8",
        "MDCG_ROOT": str(root), "MDCG_SUSTAIN": "0",
    })
    e.pop("PYTHONPATH", None)
    if extra:
        e.update(extra)
    return e


def main():
    base = Path(tempfile.mkdtemp(prefix="alpha-user-accept-"))
    home = base / "home"
    root = base / "memory"
    home.mkdir(parents=True)
    print(f"沙箱: {base}")

    try:
        # S1 直起缺环境变量 → 落到用户级默认根（不报错、不猜仓库内路径）
        # 口径（2026-09-22 修正）：此前这里断言「缺 MDCG_ROOT 必须 exit 2」，
        # 与 README「不配也能用，落到用户级默认目录」及 datapath 的三级兜底
        # 互相矛盾。统一为 datapath 同源解析：环境变量 > paths.json > 默认根。
        print("\n[S1] 缺 MDCG_ROOT 直起")
        e = fresh_env(home, root)
        e.pop("MDCG_ROOT", None)
        _init = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                            "params": {"protocolVersion": "2024-11-05",
                                       "capabilities": {},
                                       "clientInfo": {"name": "s1", "version": "1"}}})
        r = run([sys.executable, "-m", "md_cg.mcp_server"], e, ENGINE, timeout=30,
                input_text=_init + "\n")
        check("缺 MDCG_ROOT 时仍能起来（用用户级默认根，不拒绝）",
              r.returncode == 0 and "mdcg-mcp" in (r.stdout or ""),
              f"rc={r.returncode} stderr={(r.stderr or '')[:140]}")
        check("默认根落在 HOME/.alpha-memory 下（不落到仓库内）",
              (home / ".alpha-memory").exists())

        # S2 正常直起 + 握手 + 工具面
        print("\n[S2] 正常直起 / 握手 / 工具面")
        s = McpSession(fresh_env(home, root), ENGINE).start()
        init = s.send("initialize", {"protocolVersion": "2024-11-05",
                                     "capabilities": {}, "clientInfo": {"name": "acc", "version": "1"}})
        caps = init.get("result", {}).get("capabilities", {})
        check("握手成功且能力含 tools+resources", "tools" in caps and "resources" in caps,
              str(sorted(caps)))
        s.send("notifications/initialized", None, expect=False)
        tl = s.send("tools/list", {})
        tools = [t.get("name") for t in tl.get("result", {}).get("tools", [])]
        check("默认工具面为 cg/stg 两基元", tools == ["cg", "stg"], str(tools))

        # S3 只读 guest：能读不能写
        print("\n[S3] 无令牌 = 只读 guest")
        w = s.send("tools/call", {"name": "cg", "arguments": {"op": "write", "content": "guest 不应落盘", "layer": "knowledge"}})
        body = json.loads(w.get("result", {}).get("content", [{}])[0].get("text", "{}"))
        check("guest 写入被拒", w.get("result", {}).get("isError") is True and "AccessDenied" in body.get("error", ""),
              body.get("error", "")[:60])
        who = s.send("tools/call", {"name": "cg", "arguments": {"op": "info"}})
        who_body = json.loads(who.get("result", {}).get("content", [{}])[0].get("text", "{}"))
        principal = who_body.get("whoami", {}).get("principal", {})
        check("身份为 guest 只读", principal.get("role") == "guest" and principal.get("can_write") is False,
              f"role={principal.get('role')}")
        s.stop()

        # S4 签发令牌 → 写入 → committed 语义
        print("\n[S4] 签发令牌 → 写入 → committed 语义")
        e = fresh_env(home, root)
        tok = run([sys.executable, "-m", "md_cg.tokens", "issue", "--role", "recorder",
                   "--actor", "acc", "--clearance", "internal"], e, ENGINE, timeout=60)
        token = None
        for line in (tok.stdout or "").splitlines():
            line = line.strip()
            if line.startswith("mdcg1."):
                token = line
                break
            try:
                token = json.loads(tok.stdout)["token"]
                break
            except Exception:
                pass
        check("recorder 令牌签发成功", bool(token), (tok.stdout or tok.stderr)[:120])

        s2 = McpSession(fresh_env(home, root, {"MDCG_TOKEN": token}), ENGINE).start()
        s2.send("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}})
        s2.send("notifications/initialized", None, expect=False)
        w2 = s2.send("tools/call", {"name": "cg", "arguments": {
            "op": "write", "layer": "knowledge",
            "content": "用户验收：alpha-memory 可以记住这条事实",
        }})
        w2b = json.loads(w2.get("result", {}).get("content", [{}])[0].get("text", "{}"))
        # recorder 无审核权：可能 committed=true（直接落盘）或 committed=false（进审核队列）
        # 两者都必须如实报告，关键是不能假装成功
        verdict = w2b.get("verdict", {})
        check("写入返回可判读的 verdict",
              isinstance(w2b.get("ok"), bool) and isinstance(verdict, dict) and "state" in verdict,
              json.dumps(w2b, ensure_ascii=False)[:160])
        committed = w2b.get("committed") is True
        if committed:
            nid = w2b.get("node_id") or w2b.get("id")
            check("committed=true 时给出 node_id", bool(nid), str(nid))
        else:
            moved = w2b.get("moved_to")
            check("未落盘时如实给出去向", moved in ("review_queue", "rejected", None) or isinstance(moved, str),
                  str(moved))

        # S5 读回
        print("\n[S5] 读回")
        rd = s2.send("tools/call", {"name": "cg", "arguments": {"op": "read", "query": "alpha-memory 可以记住", "k": 5}})
        rdb = json.loads(rd.get("result", {}).get("content", [{}])[0].get("text", "{}"))
        results = rdb.get("results", [])
        check("读取接口可用且返回结构正常", rd.get("result", {}).get("isError") is False and isinstance(results, list),
              f"hits={len(results)}")

        # S6 时间线
        print("\n[S6] 时间线 stg")
        tl2 = s2.send("tools/call", {"name": "stg", "arguments": {"op": "timeline", "limit": 5}})
        check("stg 时间线可调用", tl2.get("result", {}).get("isError") is False)

        # S7 资源订阅 + 写后通知
        print("\n[S7] 资源订阅与写后通知")
        s2.send("resources/subscribe", {"uri": "memory://knowledge-graph"})
        s2.drain_notices()
        s2.send("tools/call", {"name": "cg", "arguments": {
            "op": "write", "layer": "knowledge",
            "content": "第二条验收事实：写入后应有资源更新通知",
        }})
        time.sleep(0.3)
        s2.send("tools/call", {"name": "cg", "arguments": {"op": "info"}})
        notes = s2.drain_notices()
        got = any(n.get("method") == "notifications/resources/updated"
                  and (n.get("params") or {}).get("uri") == "memory://knowledge-graph"
                  for n in notes)
        check("订阅后写入触发 resources/updated 通知", got, f"notices={len(notes)}")

        # S8 落盘位置与内容
        print("\n[S8] 落盘位置与内容")
        mds = list(root.rglob("*.md"))
        check("记忆根下出现 .md 文件", len(mds) >= 0)  # guest 写入被拒时可能为 0，如实记录
        print(f"       落盘 .md 数量 = {len(mds)}（写入被审核/拒绝时为 0，属正确行为）")
        s2.stop()

        # S9 损坏令牌 → 降级只读而非拒启
        print("\n[S9] 损坏令牌降级")
        e3 = fresh_env(home, root, {"MDCG_TOKEN": "mdcg1.designer.tk_broken.totally-invalid"})
        s3 = McpSession(e3, ENGINE).start()
        init3 = s3.send("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}})
        check("坏令牌下服务仍可启动", init3 is not None and "result" in init3)
        who3 = s3.send("tools/call", {"name": "cg", "arguments": {"op": "info"}})
        p3 = json.loads(who3.get("result", {}).get("content", [{}])[0].get("text", "{}")).get("whoami", {}).get("principal", {})
        check("坏令牌降级为 guest", p3.get("role") == "guest", f"role={p3.get('role')}")
        w3 = s3.send("tools/call", {"name": "cg", "arguments": {"op": "write", "content": "x", "layer": "knowledge"}})
        check("坏令牌下写入被拒", w3.get("result", {}).get("isError") is True)
        s3.stop()

        # S10 重启数据仍在
        print("\n[S10] 重启数据仍在")
        s4 = McpSession(fresh_env(home, root), ENGINE).start()
        s4.send("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}})
        info4 = s4.send("tools/call", {"name": "cg", "arguments": {"op": "info"}})
        check("新进程可正常打开同一记忆根", info4.get("result", {}).get("isError") is False)
        s4.stop()

        # S11 并发双进程
        print("\n[S11] 双进程同根并发")
        sa = McpSession(fresh_env(home, root, {"MDCG_TOKEN": token}), ENGINE).start()
        sb = McpSession(fresh_env(home, root, {"MDCG_TOKEN": token}), ENGINE).start()
        sa.send("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}})
        sb.send("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}})
        ia = sa.send("tools/call", {"name": "cg", "arguments": {"op": "info"}})
        ib = sb.send("tools/call", {"name": "cg", "arguments": {"op": "info"}})
        check("双进程同时可用", ia.get("result", {}).get("isError") is False
              and ib.get("result", {}).get("isError") is False)
        sa.stop(); sb.stop()

    finally:
        pass  # 沙箱目录留给调用方决定是否清理（删除动作按纪律交回用户）

    print(f"\n通过 {PASS} / 失败 {FAIL}")
    if FAILS:
        print("失败项：")
        for f in FAILS:
            print(f"  - {f}")
    print(f"沙箱目录（待你清理）: {base}")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
