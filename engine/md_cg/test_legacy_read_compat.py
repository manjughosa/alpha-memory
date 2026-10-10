"""Legacy single-user memory remains readable without mass tenant migration."""
import hashlib
import os
import stat
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from pathlib import Path
from tempfile import TemporaryDirectory

from md_cg import nodefile
from md_cg.mdcg import MdCG
from md_cg.mdcos import MdCGSecure
from md_cg.security import Principal

KEY = bytes.fromhex("4f" * 32)


def secure(root, tenant="default", clearance="internal"):
    return MdCGSecure(root, principal=Principal(
        tenant=tenant, actor="legacy-reader", clearance=clearance,
        can_write=False, session="legacy-session"), master_key=KEY)


class LegacyReadCompatibilityTests(unittest.TestCase):
    def build(self, root, **extra):
        old = MdCG(root, autoflush=1)
        old.add("legacy_cobalt", "cobalt legacy memory retrieval evidence", **extra)
        old.flush()
        old.compact_index()
        return old

    def test_default_reads_and_recalls_without_rewriting_source_or_index(self):
        with TemporaryDirectory() as root:
            old = self.build(root)
            source = Path(root, old.index["nodes"]["legacy_cobalt"]["path"])
            index = Path(root, "_index.json")
            before = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in (source, index)}
            reader = secure(root)
            for _ in range(2):
                node = reader.get("legacy_cobalt")
                self.assertIsNotNone(node)
                self.assertNotIn("tenant", node["frontmatter"])
                result = reader.recall("cobalt legacy memory", k=3, budget_tokens=800,
                                       paths=("lexical",), judge=False)
                self.assertIn("legacy_cobalt", {n["id"] for n in result["pack"]})
            self.assertNotIn("tenant", reader.index["nodes"]["legacy_cobalt"])
            reader.flush()
            self.assertEqual(before, {p: hashlib.sha256(p.read_bytes()).hexdigest()
                                      for p in (source, index)})

    def test_other_tenant_and_low_clearance_remain_hidden(self):
        with TemporaryDirectory() as root:
            self.build(root, sensitivity="private")
            self.assertIsNone(secure(root, tenant="foreign", clearance="secret").get("legacy_cobalt"))
            self.assertIsNone(secure(root, clearance="internal").get("legacy_cobalt"))
            self.assertIsNotNone(secure(root, clearance="secret").get("legacy_cobalt"))

    def test_stale_null_index_does_not_hide_legacy_or_override_explicit_owner(self):
        with TemporaryDirectory() as root:
            self.build(root)
            reader = secure(root)
            entry = reader.index["nodes"]["legacy_cobalt"]
            entry["tenant"] = None  # Old reader cached an absent field as None.
            self.assertIsNotNone(reader.get("legacy_cobalt"))
            path = Path(root, entry["path"])
            fm, content = nodefile.loads(path.read_text(encoding="utf-8"))
            fm["tenant"] = "foreign"
            path.write_text(nodefile.dumps(fm, content), encoding="utf-8")
            self.assertIsNone(reader.get("legacy_cobalt"))
            self.assertIsNotNone(secure(root, tenant="foreign").get("legacy_cobalt"))

    def test_explicit_null_and_missing_file_do_not_become_default_owned(self):
        with TemporaryDirectory() as root:
            self.build(root, tenant=None)
            reader = secure(root)
            self.assertIsNone(reader.get("legacy_cobalt"))
            entry = dict(reader.index["nodes"]["legacy_cobalt"])
            entry["path"] = "missing.md"
            self.assertFalse(reader._readable(entry))

    @unittest.skipUnless(os.name == "nt", "Windows plain-path fast path")
    def test_plain_windows_paths_skip_handle_resolution_but_recheck_links(self):
        with TemporaryDirectory() as root:
            old = self.build(root)
            relative = old.index["nodes"]["legacy_cobalt"]["path"]
            expected = os.path.abspath(os.path.join(root, relative))
            with patch("md_cg.mdcg.os.path.realpath", wraps=os.path.realpath) as resolve:
                self.assertEqual(old._resolve_node_path(relative), expected)
                self.assertEqual(resolve.call_count, 0)
            # A newly introduced ancestor reparse point MUST trigger realpath,
            # even after a successful plain-path read. No cached link verdict.
            parent = os.path.dirname(expected)
            original_lstat = os.lstat
            def changed_lstat(path):
                if os.path.normcase(path) == os.path.normcase(parent):
                    return SimpleNamespace(st_file_attributes=stat.FILE_ATTRIBUTE_REPARSE_POINT)
                return original_lstat(path)
            outside = os.path.abspath(os.path.join(root, "..", "outside.md"))
            with patch("md_cg.mdcg.os.lstat", side_effect=changed_lstat), patch(
                    "md_cg.mdcg.os.path.realpath", side_effect=[os.path.abspath(root), outside]):
                with self.assertRaisesRegex(ValueError, "outside the memory root"):
                    old._resolve_node_path(relative)

    def test_path_traversal_and_absolute_paths_remain_rejected(self):
        with TemporaryDirectory() as root:
            old = self.build(root)
            for path in ("../outside.md", os.path.abspath(os.path.join(root, "inside.md"))):
                with self.subTest(path=path), self.assertRaises(ValueError):
                    old._resolve_node_path(path)

    def test_explicit_foreign_index_is_never_legacy(self):
        with TemporaryDirectory() as root:
            self.build(root, tenant="foreign")
            self.assertIsNone(secure(root).get("legacy_cobalt"))
            self.assertIsNotNone(secure(root, tenant="foreign").get("legacy_cobalt"))


if __name__ == "__main__":
    unittest.main()
