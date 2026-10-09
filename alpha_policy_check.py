# -*- coding: utf-8 -*-
"""Alpha 审核规则自查（2026-09-16）。
用途：在不开 token、不写一个字节的前提下，验证 MDCG_POLICY_FILE 是否真的能拦住垃圾、放行真金。
跑法：由 Alpha桥.js 的 policy 操作拉起（node 调 python，合法过 Aegis 门卫）。
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.environ.get("MDCG_PKG_PATH") or next(
    (
        _cand
        for _cand in (os.path.join(_HERE, "engine"), _HERE)
        if os.path.isdir(os.path.join(_cand, "md_cg"))
    ),
    os.path.join(_HERE, "engine"),
)
sys.path.insert(0, PKG)

from md_cg import audit

_p = os.environ.get("MDCG_POLICY_FILE")
print("env_policy =", _p)
print("exists =", os.path.exists(_p) if _p else None)
try:
    import json as _json
    with open(_p, encoding="utf-8") as _f:
        _raw = _f.read()
    print("raw_len =", len(_raw))
    print("parsed =", _json.loads(_raw))
except Exception as _e:
    print("parse_error =", type(_e).__name__, _e)
rules = audit.load_rulebook()
print("policy_file =", os.environ.get("MDCG_POLICY_FILE"))
print("rules =", rules)
print("verifiers =", {k: v["verifier"] for k, v in audit.kinds().items()})
print("-" * 40)

SAMPLES = [
    ("空壳占位", "待补充"),
    ("巡检占位", "### 63轮系统巡检 · 8-09 16:28（自动触发，不可跳过）本轮无实质内容"),
    ("合格样例", "部署在测试机 8080 端口，服务名 demo-api，负责人已确认验收口径。"),
    ("过短句子", "待确认"),
]

for name, text in SAMPLES:
    v = audit.audit("text", {"content": text}, {"rules": rules})
    print("%-8s → %-7s | %s" % (name, v.get("state"), v.get("evidence")))
