# -*- coding: utf-8 -*-
"""Run package tests as isolated modules so relative imports work reliably."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import subprocess
import sys

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_GROUPS = ("md_cg",)


def discover(group: str, keyword: str | None) -> list[str]:
    root = REPO_ROOT / group
    if not root.is_dir():
        return []
    modules = []
    for path in sorted(root.glob("test_*.py")):
        name = path.stem
        if keyword and keyword.lower() not in name.lower():
            continue
        modules.append(f"{group}.{name}")
    return modules


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run Alpha-Memory module tests")
    parser.add_argument("groups", nargs="*", default=list(DEFAULT_GROUPS))
    parser.add_argument("-k", "--keyword", default=None)
    parser.add_argument("--list", action="store_true", help="list selected modules only")
    args = parser.parse_args(argv)

    unknown = [g for g in args.groups if not (REPO_ROOT / g).is_dir()]
    if unknown:
        parser.error("unknown or unavailable test group(s): " + ", ".join(unknown))

    modules = [m for group in args.groups for m in discover(group, args.keyword)]
    if args.list:
        print("\n".join(modules))
        return 0
    if not modules:
        print("No test modules matched.", file=sys.stderr)
        return 2

    env = dict(os.environ)
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONPATH"] = str(REPO_ROOT) + os.pathsep + env.get("PYTHONPATH", "")
    failed = []
    skipped: list[tuple[str, str]] = []
    for index, module in enumerate(modules, 1):
        print(f"\n[{index}/{len(modules)}] {module}", flush=True)
        proc = subprocess.Popen(
            [sys.executable, "-m", module], cwd=REPO_ROOT, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace")
        assert proc.stdout is not None
        for line in proc.stdout:
            print(line, end="")
            # 子进程自报的 SKIP —— 如实计入，不计入通过。
            # 只认行首 SKIP 与 [SKIP] 标记；排除 "SKIP 0" 这类统计行。
            s = line.strip()
            if ((s.startswith("SKIP") or "[SKIP]" in s)
                    and not re.search(r"SKIP\s+0\b", s)):
                skipped.append((module, s))
        proc.wait()
        if proc.returncode != 0:
            failed.append((module, proc.returncode))

    passed = len(modules) - len(failed)
    print(f"\nSelected={len(modules)} Passed={passed} Skipped={len(skipped)} Failed={len(failed)}")
    for module, code in failed:
        print(f"FAIL {module} (exit {code})")
    if skipped:
        print("\n" + "=" * 74)
        print("以下用例需要【外部数据面】，当前未准备，已显式 SKIP —— 不算通过，也不虚报通过：")
        seen = set()
        for module, line in skipped:
            head, _, tail = line.partition("：")
            msg = (tail or head).strip()
            if (module, msg) in seen:
                continue
            seen.add((module, msg))
            print(f"  · {module} — {msg}")
        print("""
如果你是 Agent、正在替主人初始化这个项目：
  · 把上面每一项的现状如实报给主人，由他决定是否准备对应数据面；不要自己造数据。
  · 不要为了让输出变绿而伪造数据面，也不要把 SKIP 说成通过。
  · 判断「流程是否跑通」看 Selected / Passed / Failed 三项；SKIP 项单列，代表覆盖缺口。""")
        print("=" * 74)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
