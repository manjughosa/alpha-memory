# -*- coding: utf-8 -*-
"""Apply one review decision and flush all durable state before exit."""
from __future__ import annotations

import argparse
import json
import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from md_cg.datapath import mdcg_root
from md_cg.mdcos import MdCGOS


def _json_object(value: str, flag: str) -> dict:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        raise argparse.ArgumentTypeError(f"{flag} must be valid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise argparse.ArgumentTypeError(f"{flag} must decode to an object")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Apply an md_cg review decision")
    parser.add_argument("decision", choices=("accept", "reject", "edit", "merge", "noop"))
    parser.add_argument("pid", help="proposal id")
    parser.add_argument("--root", default=None, help="md_cg root; defaults to configured root")
    parser.add_argument("--actor", default="designer", help="audit actor")
    parser.add_argument("--reason", default="", help="decision reason")
    parser.add_argument("--merge-into", default=None, help="target node for merge")
    parser.add_argument("--edits", default=None, metavar="JSON", help="edit object")
    parser.add_argument("--redteam", default=None, metavar="JSON", help="red-team result object")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    edits = _json_object(args.edits, "--edits") if args.edits else None
    redteam = _json_object(args.redteam, "--redteam") if args.redteam else None
    root = os.path.abspath(args.root or mdcg_root())
    cg = MdCGOS(root, actor=args.actor)
    try:
        result = cg.review_decide(
            args.pid,
            args.decision,
            edits=edits,
            merge_into=args.merge_into,
            reason=args.reason,
            redteam=redteam,
        )
        cg.flush()
    finally:
        cg.close()
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
