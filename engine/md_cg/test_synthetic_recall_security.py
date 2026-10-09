"""Synthetic-only security regression tests for recall candidates."""
import os
from tempfile import TemporaryDirectory
import unittest

from md_cg import nodefile, refindex
from md_cg.mdcg import MdCG
from md_cg.mdcos import MdCGSecure
from md_cg.mcp_server import call_tool
from md_cg.security import AccessDenied, Principal


_TEST_KEY = bytes.fromhex("4f" * 32)


def _secure_store(root, *, tenant, actor, clearance, session):
    principal = Principal(
        tenant=tenant,
        actor=actor,
        clearance=clearance,
        can_write=True,
        session=session,
    )
    return MdCGSecure(
        root,
        principal=principal,
        master_key=_TEST_KEY,
        autoflush=1,
    )


def _recall_ids(cg, query, **kwargs):
    result = cg.recall(
        query,
        k=20,
        budget_tokens=1200,
        judge=False,
        paths=("lexical",),
        **kwargs,
    )
    return {item["id"] for item in result["pack"]}


class SyntheticRecallSecurityTests(unittest.TestCase):
    def test_private_candidates_are_hidden_from_low_clearance_recall_and_get(self):
        with TemporaryDirectory(prefix="alpha-memory-synthetic-acl-") as root:
            owner = _secure_store(
                root,
                tenant="synthetic-tenant",
                actor="synthetic-owner",
                clearance="secret",
                session="synthetic-writer-session",
            )
            owner.add(
                "synthetic_public_amber",
                "synthetic amber retrieval marker public evidence",
                sensitivity="public",
            )
            owner.add(
                "synthetic_secret_amber",
                "synthetic amber retrieval marker secret evidence",
                sensitivity="secret",
            )

            reader = _secure_store(
                root,
                tenant="synthetic-tenant",
                actor="synthetic-owner",
                clearance="public",
                session="synthetic-reader-session",
            )

            ids = _recall_ids(reader, "synthetic amber retrieval marker")
            self.assertIn("synthetic_public_amber", ids)
            self.assertNotIn("synthetic_secret_amber", ids)
            self.assertIsNone(reader.get("synthetic_secret_amber"))

    def test_candidates_from_another_tenant_are_hidden_from_recall_and_get(self):
        with TemporaryDirectory(prefix="alpha-memory-synthetic-tenant-") as root:
            tenant_a = _secure_store(
                root,
                tenant="synthetic-tenant-a",
                actor="synthetic-actor-a",
                clearance="internal",
                session="synthetic-session-a",
            )
            tenant_a.add(
                "synthetic_tenant_a_cobalt",
                "synthetic cobalt tenant-bound retrieval evidence",
                sensitivity="public",
            )
            tenant_b = _secure_store(
                root,
                tenant="synthetic-tenant-b",
                actor="synthetic-actor-b",
                clearance="internal",
                session="synthetic-session-b",
            )
            tenant_b.add(
                "synthetic_tenant_b_cobalt",
                "synthetic cobalt tenant-bound retrieval evidence",
                sensitivity="public",
            )

            ids = _recall_ids(tenant_b, "synthetic cobalt tenant-bound")
            self.assertIn("synthetic_tenant_b_cobalt", ids)
            self.assertNotIn("synthetic_tenant_a_cobalt", ids)
            self.assertIsNone(tenant_b.get("synthetic_tenant_a_cobalt"))

    def test_session_and_expiry_filters_apply_before_recall_pack(self):
        with TemporaryDirectory(prefix="alpha-memory-synthetic-filters-") as root:
            cg = _secure_store(
                root,
                tenant="synthetic-filter-tenant",
                actor="synthetic-filter-actor",
                clearance="internal",
                session="synthetic-default-session",
            )
            content = "synthetic slate rendezvous retrieval evidence"
            cg.add(
                "synthetic_session_a_active",
                content,
                sensitivity="internal",
                session="synthetic-session-a",
            )
            cg.add(
                "synthetic_session_b_active",
                content,
                sensitivity="internal",
                session="synthetic-session-b",
            )
            cg.add(
                "synthetic_session_a_expired",
                content,
                sensitivity="internal",
                session="synthetic-session-a",
                valid_until="2000-01-01T00:00:00Z",
            )

            ids = _recall_ids(
                cg,
                "synthetic slate rendezvous",
                session="synthetic-session-a",
                validity=True,
            )

            self.assertIn("synthetic_session_a_active", ids)
            self.assertNotIn("synthetic_session_b_active", ids)
            self.assertNotIn("synthetic_session_a_expired", ids)


    def test_shared_root_enforces_tenant_ownership_for_new_nodes(self):
        with TemporaryDirectory(prefix="alpha-memory-synthetic-shared-tenant-") as root:
            tenant_a = _secure_store(
                root,
                tenant="synthetic-shared-a",
                actor="synthetic-shared-actor-a",
                clearance="internal",
                session="synthetic-shared-session-a",
            )
            tenant_a.add(
                "synthetic_shared_cobalt_a",
                "synthetic cobalt tenant-bound retrieval evidence",
                sensitivity="public",
            )
            self.assertEqual(
                tenant_a.get("synthetic_shared_cobalt_a")["frontmatter"]["tenant"],
                "synthetic-shared-a",
            )

            tenant_b = _secure_store(
                root,
                tenant="synthetic-shared-b",
                actor="synthetic-shared-actor-b",
                clearance="internal",
                session="synthetic-shared-session-b",
            )
            self.assertNotIn(
                "synthetic_shared_cobalt_a",
                _recall_ids(tenant_b, "synthetic cobalt tenant-bound"),
            )
            self.assertIsNone(tenant_b.get("synthetic_shared_cobalt_a"))
            with self.assertRaises(AccessDenied):
                tenant_b.add(
                    "synthetic_shared_cobalt_a",
                    "synthetic overwrite must be denied",
                    sensitivity="public",
                )

            tenant_a_reopened = _secure_store(
                root,
                tenant="synthetic-shared-a",
                actor="synthetic-shared-actor-a",
                clearance="internal",
                session="synthetic-shared-session-a2",
            )
            tenant_a_reopened.rebuild_index()
            self.assertEqual(
                tenant_a_reopened.index["nodes"]["synthetic_shared_cobalt_a"]["tenant"],
                "synthetic-shared-a",
            )
            self.assertIn(
                "synthetic_shared_cobalt_a",
                _recall_ids(tenant_a_reopened, "synthetic cobalt tenant-bound"),
            )

    def test_legacy_nodes_fail_closed_until_admin_explicitly_binds_tenant(self):
        with TemporaryDirectory(prefix="alpha-memory-synthetic-legacy-tenant-") as root:
            legacy = MdCG(root)
            legacy.add(
                "synthetic_legacy_cobalt",
                "synthetic cobalt legacy unbound retrieval evidence",
                layer="knowledge",
            )

            tenant_a = _secure_store(
                root,
                tenant="synthetic-legacy-a",
                actor="synthetic-legacy-actor-a",
                clearance="internal",
                session="synthetic-legacy-session-a",
            )
            self.assertIsNone(tenant_a.get("synthetic_legacy_cobalt"))
            self.assertNotIn(
                "synthetic_legacy_cobalt",
                _recall_ids(tenant_a, "synthetic cobalt legacy unbound"),
            )
            with self.assertRaises(AccessDenied):
                tenant_a.bind_legacy_tenant("synthetic_legacy_cobalt")

            admin = MdCGSecure(
                root,
                principal=Principal(
                    tenant="synthetic-legacy-a",
                    actor="synthetic-legacy-admin",
                    clearance="internal",
                    can_write=True,
                    can_admin=True,
                    session="synthetic-legacy-admin-session",
                ),
                master_key=_TEST_KEY,
                autoflush=1,
            )
            self.assertEqual(
                admin.bind_legacy_tenant("synthetic_legacy_cobalt"),
                "synthetic_legacy_cobalt",
            )
            self.assertEqual(
                admin.get("synthetic_legacy_cobalt")["frontmatter"]["tenant"],
                "synthetic-legacy-a",
            )
            tenant_b = _secure_store(
                root,
                tenant="synthetic-legacy-b",
                actor="synthetic-legacy-actor-b",
                clearance="internal",
                session="synthetic-legacy-session-b",
            )
            self.assertIsNone(tenant_b.get("synthetic_legacy_cobalt"))
    def test_get_and_secure_read_reject_paths_outside_canonical_root(self):
        with TemporaryDirectory(prefix="alpha-memory-synthetic-path-escape-") as parent:
            root = os.path.join(parent, "root")
            store = _secure_store(
                root,
                tenant="synthetic-path-tenant",
                actor="synthetic-path-actor",
                clearance="internal",
                session="synthetic-path-session",
            )
            outside = os.path.join(parent, "outside.md")
            with open(outside, "w", encoding="utf-8") as stream:
                stream.write(nodefile.dumps(
                    {
                        "id": "synthetic_path_escape",
                        "tenant": "synthetic-path-tenant",
                        "sensitivity": "public",
                    },
                    "synthetic outside-root content must never be returned",
                ))
            entry = {
                "path": "../outside.md",
                "tenant": "synthetic-path-tenant",
                "sensitivity": "public",
            }
            store.index["nodes"]["synthetic_path_escape"] = entry

            with self.assertRaisesRegex(ValueError, "outside the memory root"):
                store._read(entry)
            with self.assertRaisesRegex(ValueError, "outside the memory root"):
                store.get("synthetic_path_escape")
    def test_node_write_rejects_paths_outside_canonical_root(self):
        with TemporaryDirectory(prefix="alpha-memory-synthetic-write-escape-") as parent:
            root = os.path.join(parent, "root")
            store = _secure_store(
                root,
                tenant="synthetic-write-tenant",
                actor="synthetic-write-actor",
                clearance="internal",
                session="synthetic-write-session",
            )
            outside = os.path.join(parent, "outside.md")

            with self.assertRaisesRegex(ValueError, "outside the memory root"):
                store._write_node(
                    "synthetic_write_escape",
                    outside,
                    {"id": "synthetic_write_escape", "sensitivity": "public"},
                    "synthetic content must remain inside the memory root",
                )

            self.assertFalse(os.path.exists(outside))

    def test_negative_recall_rejects_paths_outside_canonical_root(self):
        with TemporaryDirectory(prefix="alpha-memory-synthetic-search-escape-") as parent:
            root = os.path.join(parent, "root")
            store = _secure_store(
                root,
                tenant="synthetic-search-tenant",
                actor="synthetic-search-actor",
                clearance="internal",
                session="synthetic-search-session",
            )
            store.add(
                "synthetic_search_anchor",
                "needle inside-root search candidate",
                layer="knowledge",
                tags=["synthetic"],
            )
            outside = os.path.join(parent, "outside.md")
            with open(outside, "w", encoding="utf-8") as stream:
                stream.write(nodefile.dumps(
                    {
                        "id": "synthetic_search_escape",
                        "layer": "rejected",
                        "tenant": "synthetic-search-tenant",
                        "sensitivity": "public",
                    },
                    "needle outside-root rejected memory",
                ))
            store.index["nodes"]["synthetic_search_escape"] = {
                "path": "../outside.md",
                "layer": "rejected",
                "tenant": "synthetic-search-tenant",
                "sensitivity": "public",
            }

            with self.assertRaisesRegex(ValueError, "outside the memory root"):
                store.search("needle", include_neg=True, judge=False, record=False)

    def test_base_search_rejects_candidate_paths_outside_canonical_root(self):
        with TemporaryDirectory(prefix="alpha-memory-synthetic-base-search-escape-") as parent:
            root = os.path.join(parent, "root")
            store = MdCG(root)
            store.add(
                "synthetic_base_search_anchor",
                "needle inside-root search candidate",
                layer="knowledge",
                tags=["synthetic"],
            )
            outside = os.path.join(parent, "outside.md")
            with open(outside, "w", encoding="utf-8") as stream:
                stream.write(nodefile.dumps(
                    {"id": "synthetic_base_search_escape", "layer": "rejected"},
                    "needle outside-root rejected memory",
                ))
            store.index["nodes"]["synthetic_base_search_escape"] = {
                "path": "../outside.md",
                "layer": "rejected",
            }

            with self.assertRaisesRegex(ValueError, "outside the memory root"):
                store.search("needle", include_neg=True, judge=False, record=False)
    def test_ref_reads_reject_parent_and_absolute_paths(self):
        with TemporaryDirectory(prefix="alpha-memory-synthetic-ref-escape-") as parent:
            root = os.path.join(parent, "root")
            os.makedirs(root)
            outside = os.path.join(parent, "outside.jsonl")
            with open(outside, "w", encoding="utf-8") as stream:
                stream.write("SYNTHETIC-OUTSIDE-ROOT\n")

            for path in ("../outside.jsonl", outside):
                with self.subTest(path=path):
                    result = refindex.read_ref({
                        "root": root,
                        "path": path,
                        "lineno": 1,
                        "end": 1,
                    })
                    self.assertFalse(result["ok"])
                    self.assertNotIn("SYNTHETIC-OUTSIDE-ROOT", result.get("text", ""))

    def test_ref_reads_reject_symlink_escape(self):
        with TemporaryDirectory(prefix="alpha-memory-synthetic-ref-symlink-") as parent:
            root = os.path.join(parent, "root")
            os.makedirs(root)
            outside = os.path.join(parent, "outside.jsonl")
            with open(outside, "w", encoding="utf-8") as stream:
                stream.write("SYNTHETIC-OUTSIDE-ROOT\n")
            os.symlink(outside, os.path.join(root, "outside-link.jsonl"))

            result = refindex.read_ref({
                "root": root,
                "path": "outside-link.jsonl",
                "lineno": 1,
                "end": 1,
            })
            self.assertFalse(result["ok"])
            self.assertNotIn("SYNTHETIC-OUTSIDE-ROOT", result.get("text", ""))

    def test_mcp_ref_reads_require_a_visible_node_and_its_bound_ref(self):
        with TemporaryDirectory(prefix="alpha-memory-synthetic-ref-auth-") as root:
            source_path = os.path.join(root, "source.jsonl")
            decoy_path = os.path.join(root, "decoy.jsonl")
            with open(source_path, "w", encoding="utf-8") as stream:
                stream.write("SYNTHETIC-AUTHORIZED-SOURCE\n")
            with open(decoy_path, "w", encoding="utf-8") as stream:
                stream.write("SYNTHETIC-UNBOUND-SOURCE\n")

            node_id = "synthetic_ref_bound_node"
            bound_ref = {
                "root": root,
                "path": "source.jsonl",
                "lineno": 1,
                "end": 1,
            }
            decoy_ref = {
                "root": root,
                "path": "decoy.jsonl",
                "lineno": 1,
                "end": 1,
            }
            owner = _secure_store(
                root,
                tenant="synthetic-ref-owner",
                actor="synthetic-ref-owner-actor",
                clearance="internal",
                session="synthetic-ref-owner-session",
            )
            owner.add(
                node_id,
                "synthetic reference authorization node",
                sensitivity="public",
                code_ref=bound_ref,
            )

            valid = call_tool(owner, "cg", {"op": "ref", "node_id": node_id})
            self.assertTrue(valid["ok"])
            self.assertIn("SYNTHETIC-AUTHORIZED-SOURCE", valid["text"])

            unbound = call_tool(owner, "cg", {"op": "ref", "ref": bound_ref})
            self.assertFalse(unbound["ok"])
            self.assertNotIn("SYNTHETIC-AUTHORIZED-SOURCE", unbound.get("text", ""))

            mismatched = call_tool(owner, "cg", {
                "op": "ref",
                "node_id": node_id,
                "ref": decoy_ref,
            })
            self.assertFalse(mismatched["ok"])
            self.assertNotIn("SYNTHETIC-UNBOUND-SOURCE", mismatched.get("text", ""))

            other_tenant = _secure_store(
                root,
                tenant="synthetic-ref-other",
                actor="synthetic-ref-other-actor",
                clearance="internal",
                session="synthetic-ref-other-session",
            )
            hidden = call_tool(other_tenant, "cg", {
                "op": "ref",
                "node_id": node_id,
            })
            self.assertFalse(hidden["ok"])
            self.assertNotIn("SYNTHETIC-AUTHORIZED-SOURCE", hidden.get("text", ""))

            with self.assertRaises(AccessDenied):
                call_tool(owner, "cg", {
                    "op": "ref",
                    "node_id": node_id,
                    "as_unit": "output",
                })
if __name__ == "__main__":
    unittest.main()