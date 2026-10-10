"""Production vector regressions. Synthetic temp roots only; no live memory."""
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from md_cg.mdcos import MdCGSecure, MdCGOS
from md_cg.security import Principal

try:
    from md_cg.vector_index import VectorIndex
    from qdrant_client import models
except ImportError:
    VectorIndex = None

ENGINE = str(Path(__file__).resolve().parents[1])
KEY = bytes.fromhex("4f" * 32)


def fake_embed(texts):
    return [[1.0] + [0.0] * 1023 for _ in texts]


def store(root, tenant="tenant-a", clearance="secret"):
    return MdCGSecure(root, principal=Principal(
        tenant=tenant, actor="synthetic-owner", clearance=clearance,
        can_write=True, can_admin=True, session="s-a"),
        master_key=KEY, autoflush=1)


@unittest.skipIf(VectorIndex is None, "SKIP qdrant-client missing; install requirements.txt in the selected Python")
class ProductionVectorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory(prefix="alpha-vector-regression-")
        self.addCleanup(self.tmp.cleanup)
        self.root = self.tmp.name
        self.embedding = patch.object(VectorIndex, "embed_texts", side_effect=fake_embed)
        self.embedding.start()
        self.addCleanup(self.embedding.stop)
        self.env = patch.dict(os.environ, {"MDCG_VECTOR_AUTO_INDEX": "0"})
        self.env.start()
        self.addCleanup(self.env.stop)

    def client(self):
        return VectorIndex(self.root)

    def child(self, code, *args, seed="random"):
        env = dict(os.environ, PYTHONPATH=ENGINE, PYTHONUTF8="1", PYTHONHASHSEED=seed)
        return subprocess.run([sys.executable, "-X", "utf8", "-c", code, *args],
                              cwd=ENGINE, env=env, capture_output=True,
                              text=True, encoding="utf-8", timeout=30, check=True)

    def test_ids_are_stable_in_fresh_processes(self):
        code = "from md_cg.vector_index import VectorIndex; print(VectorIndex._point_id('restart-node'))"
        a = self.child(code, seed="1").stdout.strip()
        b = self.child(code, seed="2").stdout.strip()
        self.assertEqual(a, b)
        self.assertEqual(int(a), VectorIndex._point_id("restart-node"))

    def test_restart_reindex_removes_legacy_duplicates_and_delete_cleans_all(self):
        vi = self.client()
        with vi._open_client() as client:
            client.upsert(vi.collection, points=[models.PointStruct(
                id=n, vector=fake_embed([""])[0], payload={
                    "node_id": "restart-node", "acl_visible": True, "sensitivity": "public"})
                for n in (11, 12)])
        self.child("import sys; from md_cg.vector_index import VectorIndex; "
                   "v=VectorIndex(sys.argv[1]); v.embed_texts=lambda xs:[[1.0]+[0.0]*1023 for _ in xs]; "
                   "assert v.index_node('restart-node','new',sensitivity='public')", self.root)
        with vi._open_client() as client:
            self.assertEqual(client.get_collection(vi.collection).points_count, 1)
        self.child("import sys; from md_cg.vector_index import VectorIndex; "
                   "assert VectorIndex(sys.argv[1]).delete_node('restart-node')", self.root)
        self.assertEqual(vi.search("probe"), [])

    def test_two_processes_share_persistent_qdrant_without_lock_errors(self):
        code = ("import sys; from md_cg.vector_index import VectorIndex; "
                "v=VectorIndex(sys.argv[1]); v.embed_texts=lambda xs:[[1.0]+[0.0]*1023 for _ in xs]; "
                "assert all(v.index_node(sys.argv[2]+str(i),'content',sensitivity='public') for i in range(8))")
        env = dict(os.environ, PYTHONPATH=ENGINE, PYTHONUTF8="1")
        procs = [subprocess.Popen([sys.executable, "-X", "utf8", "-c", code, self.root, prefix],
                    cwd=ENGINE, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    text=True, encoding="utf-8") for prefix in ("a-", "b-")]
        for proc in procs:
            stdout, stderr = proc.communicate(timeout=45)
            self.assertEqual(proc.returncode, 0, stdout + stderr)
        vi = self.client()
        with vi._open_client() as client:
            self.assertEqual(client.get_collection(vi.collection).points_count, 16)

    def test_allowed_candidates_are_filtered_before_top_k(self):
        vi = self.client()
        self.assertEqual(vi.index_nodes_batch([
            ("foreign-" + str(i), "content", True, "internal") for i in range(60)
        ] + [("allowed", "content", True, "public")]), (61, 0))
        self.assertEqual([n for n, _ in vi.search("probe", limit=1,
                                               allowed_node_ids=["allowed"])], ["allowed"])
        self.assertEqual(vi.search("probe", allowed_node_ids=[]), [])

    def test_secure_vector_recall_filters_tenant_session_expiry_and_clearance(self):
        a = store(self.root)
        a.add("own", "synthetic beacon evidence", sensitivity="public")
        a.add("other-session", "synthetic beacon evidence", sensitivity="public", session="s-b")
        a.add("expired", "synthetic beacon evidence", sensitivity="public", valid_until="2000-01-01")
        a.add("secret", "synthetic beacon evidence", sensitivity="secret")
        b = store(self.root, tenant="tenant-b")
        b.add("foreign", "synthetic beacon evidence", sensitivity="public")
        vi = self.client()
        vi.index_nodes_batch([(nid, "content", True, "public") for nid in (
            "own", "other-session", "expired", "secret", "foreign")])
        reader = store(self.root, clearance="public")
        reader._vector_index = vi
        results, meta = reader.search_rrf("beacon", paths=("vector",), judge=False,
                                         session="s-a", validity=True)
        self.assertEqual([r[0]["id"] for r in results], ["own"])
        self.assertEqual(meta["paths"]["vector"], 1)
        self.assertIsNone(meta["vector_error"])

    def test_default_writes_never_embed_and_updates_remove_stale_vector(self):
        cg = store(self.root)
        with patch.object(VectorIndex, "embed_texts", side_effect=AssertionError("unexpected embedding")):
            cg.add("node", "original content", sensitivity="public")
        self.assertFalse(Path(self.root, "qdrant").exists())
        vi = self.client()
        self.assertTrue(vi.index_node("node", "old content", sensitivity="public"))
        node = cg.get("node")
        cg._write_node("node", os.path.join(self.root, node["path"]), node["frontmatter"], "updated content")
        self.assertEqual(vi.search("probe"), [])
        self.assertEqual(cg.get("node")["content"].strip(), "updated content")

    def test_auto_index_uses_committed_writes_and_sensitive_transition_deletes(self):
        cg = store(self.root)
        with patch.dict(os.environ, {"MDCG_VECTOR_AUTO_INDEX": "1"}):
            cg.add("node", "public evidence", sensitivity="public")
            self.assertEqual([n for n, _ in cg._vector_index.search("probe")], ["node"])
            node = cg.get("node")
            fm = dict(node["frontmatter"], sensitivity="secret")
            cg._write_node("node", os.path.join(self.root, node["path"]), fm, "secret evidence")
        self.assertEqual(cg._vector_index.search("probe"), [])

    def test_forget_removes_vectors_after_store_restart(self):
        cg = store(self.root)
        cg.add("node", "evidence", sensitivity="public")
        vi = self.client()
        vi.index_node("node", "evidence", sensitivity="public")
        fresh = store(self.root)
        self.assertFalse(hasattr(fresh, "_vector_index"))
        result = fresh.forget("node", override=True)
        self.assertTrue(result["ok"], result)
        self.assertNotIn("vector_warning", result)
        self.assertEqual(vi.search("probe"), [])

    def test_failure_is_visible_and_not_cached_as_empty_success(self):
        cg = store(self.root)
        cg.add("node", "beacon evidence", sensitivity="public")
        vi = self.client()
        cg._vector_index = vi
        with patch.object(vi, "search", side_effect=RuntimeError("synthetic outage")):
            results, meta = cg.search_rrf("beacon", paths=("lexical", "vector"), judge=False)
            self.assertTrue(results)
            self.assertIn("synthetic outage", meta["vector_error"])
            self.assertIn("synthetic outage", cg.health_os()["vector"]["last_error"])
        vi.index_node("node", "content", sensitivity="public")
        _, meta = cg.search_rrf("beacon", paths=("lexical", "vector"), judge=False)
        self.assertIsNone(meta["vector_error"])
        self.assertEqual(meta["paths"]["vector"], 1)
        self.assertIsNone(cg.health_os()["vector"]["last_error"])

    def test_batch_failure_accounting_and_invalid_batch_size(self):
        vi = self.client()
        with patch.object(vi, "embed_texts", side_effect=RuntimeError("outage")):
            self.assertEqual(vi.index_nodes_batch([
                ("empty", "", True, "public"), ("valid", "content", True, "public")]), (0, 2))
        with self.assertRaises(ValueError):
            vi.index_nodes_batch([], batch_size=0)

    def test_migration_rereads_source_and_skips_private_by_default(self):
        from md_cg.migrate_to_vector import migrate_memory_to_vector
        cg = MdCGOS(self.root, actor="synthetic", autoflush=1)
        cg.add("public", "stale content", sensitivity="public")
        cg.add("private", "private marker", sensitivity="private")
        node = cg.get("public")
        cg._write_node("public", os.path.join(self.root, node["path"]), node["frontmatter"], "current source")
        with patch.object(VectorIndex, "index_nodes_batch", return_value=(1, 0)) as index:
            total, success, fail, skipped = migrate_memory_to_vector(self.root)
        self.assertEqual((total, success, fail, skipped), (2, 1, 0, 1))
        indexed = index.call_args.args[0]
        self.assertEqual(indexed[0][0], "public")
        self.assertEqual(indexed[0][1].strip(), "current source")

    def test_migration_cli_reports_partial_failure_with_nonzero_exit(self):
        from md_cg import migrate_to_vector
        for failed, expected in ((0, 0), (1, 1)):
            with patch.object(sys, "argv", ["migrate_to_vector", self.root]), \
                 patch.object(migrate_to_vector, "migrate_memory_to_vector",
                              return_value=(2, 1, failed, 1)), \
                 patch("builtins.print"):
                self.assertEqual(migrate_to_vector.main(), expected)

    def test_remote_endpoint_is_rejected_before_creating_storage(self):
        with self.assertRaisesRegex(ValueError, "loopback"):
            VectorIndex(self.root, embedding_api="https://example.com/v1")
        self.assertFalse(Path(self.root, "qdrant").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
