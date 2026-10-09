# -*- coding: utf-8 -*-
"""MCP 资源契约验收（memory://knowledge-graph 只读资源 + 订阅式写后广播）。

对照 P1 契约：知识图作为只读 MCP 资源暴露，写入成功后仅向**已订阅**的客户端
广播 notifications/resources/updated。验收覆盖：
  ① initialize 声明 resources 能力（subscribe / listChanged）
  ② resources/list 返回知识图 URI 单项
  ③ resources/read 返回内容；未知 uri 回 -32602
  ④ resources/subscribe 成功且对未知 uri 报错
  ⑤ 订阅后写入 → 收到 resources/updated 广播
  ⑥ 未订阅时写入**不广播**（避免通知插在响应之间打乱既有客户端读序）
  ⑦ 只读 op 不广播；非写工具不广播

诚实纪律：通知仅在订阅后发生，非订阅客户端的行为与改造前逐字一致。
独立临时根，不触碰宿主机真实记忆与凭据。

运行：python -m md_cg.test_p33_resource_notify
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile

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


class Mcp:
    """最小 MCP stdio 客户端：能收齐夹在响应之间的通知。"""

    def __init__(self, env, cwd):
        self.p = subprocess.Popen(
            [sys.executable, "-m", "md_cg.mcp_server"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding="utf-8",
            env=env, cwd=cwd, bufsize=1)
        self._id = 0
        self.notices = []
        self.send("initialize", {"protocolVersion": "2024-11-05",
                                 "capabilities": {}})
        self.send("notifications/initialized", None, expect=False)

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

    def drain(self):
        out, self.notices = self.notices, []
        return out

    def close(self):
        try:
            self.send("shutdown", {})
        except Exception:
            pass
        try:
            self.p.terminate()
            self.p.wait(timeout=10)
        except Exception:
            self.p.kill()


def _env(root, extra=None):
    e = dict(os.environ)
    for k in list(e):
        if k.startswith(("MDCG_", "ALPHA_")):
            e.pop(k, None)
    e.update({"MDCG_ROOT": root, "MDCG_SUSTAIN": "0",
              "MDCG_LEGACY_ENV_AUTH": "1", "MDCG_CAN_ADMIN": "1",
              "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
    e.pop("PYTHONPATH", None)
    if extra:
        e.update(extra)
    return e


def _notify_hits(notices):
    return [n for n in notices
            if n.get("method") == "notifications/resources/updated"
            and (n.get("params") or {}).get("uri") == "memory://knowledge-graph"]


def main():
    engine = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    root = tempfile.mkdtemp(prefix="mdcg-res-accept-")
    try:
        print("\n【1】能力声明与资源发现")
        m = Mcp(_env(root), engine)
        init = m.send("initialize", {"protocolVersion": "2024-11-05",
                                     "capabilities": {}})
        caps = (init or {}).get("result", {}).get("capabilities", {})
        check("initialize 声明 resources 能力",
              "resources" in caps and caps["resources"].get("subscribe") is True,
              str(sorted(caps)))
        lst = m.send("resources/list", {})
        uris = [r.get("uri") for r in
                (lst or {}).get("result", {}).get("resources", [])]
        check("resources/list 返回知识图 URI",
              uris == ["memory://knowledge-graph"], str(uris))

        print("\n【2】资源读取与错误分支")
        rd = m.send("resources/read", {"uri": "memory://knowledge-graph"})
        contents = (rd or {}).get("result", {}).get("contents", [])
        check("resources/read 返回该 uri 的内容",
              bool(contents) and contents[0].get("uri") == "memory://knowledge-graph")
        bad = m.send("resources/read", {"uri": "memory://nope"})
        check("未知 uri 回 -32602",
              (bad or {}).get("error", {}).get("code") == -32602)
        sub_bad = m.send("resources/subscribe", {"uri": "memory://nope"})
        check("订阅未知 uri 回 -32602",
              (sub_bad or {}).get("error", {}).get("code") == -32602)

        print("\n【3】未订阅时写入：不得广播")
        m.drain()
        m.send("tools/call", {"name": "cg", "arguments": {
            "op": "write", "layer": "knowledge",
            "content": "未订阅客户端写入不广播验证"}})
        m.send("tools/call", {"name": "cg", "arguments": {"op": "info"}})
        check("未订阅时写入不产生通知",
              len(_notify_hits(m.drain())) == 0)

        print("\n【4】订阅后写入：应广播")
        m.send("resources/subscribe", {"uri": "memory://knowledge-graph"})
        m.drain()
        m.send("tools/call", {"name": "cg", "arguments": {
            "op": "write", "layer": "knowledge",
            "content": "订阅客户端写入应广播验证"}})
        m.send("tools/call", {"name": "cg", "arguments": {"op": "info"}})
        check("订阅后写入收到 resources/updated",
              len(_notify_hits(m.drain())) == 1)

        print("\n【5】只读与非写工具：不得广播")
        m.drain()
        m.send("tools/call", {"name": "cg", "arguments": {
            "op": "read", "query": "广播"}})
        m.send("tools/call", {"name": "cg", "arguments": {"op": "info"}})
        check("只读 op 不广播", len(_notify_hits(m.drain())) == 0)
        m.send("tools/call", {"name": "mdcg_health", "arguments": {}})
        m.send("tools/call", {"name": "cg", "arguments": {"op": "info"}})
        check("非写工具不广播", len(_notify_hits(m.drain())) == 0)
        m.close()

        print("\n【6】落盘与读回（确认广播与实际写入一致）")
        m2 = Mcp(_env(root), engine)
        rd2 = m2.send("tools/call", {"name": "cg", "arguments": {
            "op": "read", "query": "广播验证", "k": 5}})
        body = json.loads(rd2.get("result", {}).get("content", [{}])[0].get("text", "{}"))
        check("此前写入的内容可被读回", len(body.get("results", [])) >= 1,
              f"hits={len(body.get('results', []))}")
        m2.close()
    finally:
        shutil.rmtree(root, ignore_errors=True)

    print("\n" + "=" * 68)
    print(f"通过 {PASS} / 失败 {FAIL}")
    if FAILS:
        print("失败项：")
        for f in FAILS:
            print(f"  - {f}")
    print("=" * 68)
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
