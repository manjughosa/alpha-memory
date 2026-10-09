"""Synthetic-only tests for authoritative source-event recall."""
import json
import os
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from md_cg import crypto
from md_cg.mdcos import MdCGSecure, est_tokens
from md_cg.security import Principal
from md_cg.sources import (
    Ingestor, JsonlSource, PiSessionSource, SessionLogSource, _resolve_source_ref,
)

_TEST_KEY = bytes.fromhex("4f" * 32)


def _store(root, clearance="private"):
    return MdCGSecure(root, principal=Principal(
        tenant="synthetic-source-tenant", actor="synthetic-source-actor",
        clearance=clearance, can_write=True, session="synthetic-source-session",
    ), master_key=_TEST_KEY, autoflush=1)


def _recall(cg, query, budget=2000):
    return cg.recall(query, k=20, budget_tokens=budget, max_item_tokens=budget,
                     judge=False, paths=("lexical",))


class SyntheticSourceEventRecallTests(unittest.TestCase):
    def test_jsonl_pair_slots_are_stored_and_recalled_as_distinct_events(self):
        with TemporaryDirectory(prefix="alpha-source-pair-") as temp:
            source_root = os.path.join(temp, "sources")
            os.makedirs(source_root)
            path = os.path.join(source_root, "paired.jsonl")
            texts = ["pair-anchor-user original user event",
                     "pair-anchor-assistant original assistant event"]
            with open(path, "w", encoding="utf-8") as stream:
                stream.write(json.dumps({"seq": 8, "session": "pair-session",
                                         "question": texts[0], "answer": texts[1]}) + chr(10))
            with patch.dict(os.environ, {"MDCG_SESSIONS_ROOT": source_root}):
                cg = _store(os.path.join(temp, "memory"))
                source = JsonlSource(path, pair_fields=[("question", "user"),
                                                        ("answer", "assistant")])
                ingested = Ingestor(cg).ingest(source, mine_fix_pairs=False)
                refs = [cg.get(nid)["frontmatter"].get("source_ref")
                        for nid in ingested["ids"]]
                self.assertEqual(len(refs), 2)
                self.assertTrue(all(isinstance(ref, dict) for ref in refs))
                self.assertEqual([ref["line"] for ref in refs], [1, 1])
                self.assertNotEqual(refs[0]["seq"], refs[1]["seq"])
                for nid, text, query in zip(ingested["ids"], texts,
                                            ("pair-anchor-user", "pair-anchor-assistant")):
                    item = next(item for item in _recall(cg, query)["pack"]
                                if item["id"] == nid)
                    self.assertEqual(item["content"], text)

    def test_sessionlog_and_pi_locators_replay_exact_events(self):
        with TemporaryDirectory(prefix="alpha-source-adapters-") as temp:
            source_root = os.path.join(temp, "sources")
            os.makedirs(source_root)
            session_path = os.path.join(source_root, "session.jsonl")
            session_text = "sessionlog-anchor exact synthetic event"
            with open(session_path, "w", encoding="utf-8") as stream:
                stream.write(json.dumps({"type": "session", "id": "session-id"}) + chr(10))
                stream.write(json.dumps({"type": "user/message", "seq": 12,
                    "data": {"content": [{"type": "text", "text": session_text}]}}) + chr(10))
            pi_path = os.path.join(source_root, "pi.jsonl")
            pi_text = "pi-anchor-first-" + "z" * 70
            with open(pi_path, "w", encoding="utf-8") as stream:
                stream.write(json.dumps({"type": "session", "id": "pi-id", "version": 1}) + chr(10))
                stream.write(json.dumps({"type": "message", "message": {
                    "role": "user", "content": pi_text}}) + chr(10))
            with patch.dict(os.environ, {"MDCG_SESSIONS_ROOT": source_root}):
                cg = _store(os.path.join(temp, "memory"))
                session_ingested = Ingestor(cg).ingest(
                    SessionLogSource(session_path), mine_fix_pairs=False)
                session_id = session_ingested["ids"][0]
                session_item = next(item for item in _recall(cg, "sessionlog-anchor")["pack"]
                                    if item["id"] == session_id)
                self.assertEqual(session_item["content"], session_text)
                self.assertIsInstance(cg.get(session_id)["frontmatter"].get("source_ref"), dict)
                pi_source = PiSessionSource(pi_path, max_chars=32)
                chunks = [event["text"] for event in pi_source.events()]
                pi_ingested = Ingestor(cg).ingest(pi_source, mine_fix_pairs=False)
                self.assertGreater(len(pi_ingested["ids"]), 1)
                self.assertEqual(len(chunks), len(pi_ingested["ids"]))
                pi_id = pi_ingested["ids"][0]
                pi_item = next(item for item in _recall(cg, "pi-anchor-first")["pack"]
                               if item["id"] == pi_id)
                self.assertEqual(pi_item["content"], chunks[0])
                self.assertIsInstance(cg.get(pi_id)["frontmatter"].get("source_ref"), dict)

    def test_full_event_is_budgeted_before_pack_and_token_count(self):
        with TemporaryDirectory(prefix="alpha-source-budget-") as temp:
            source_root = os.path.join(temp, "sources")
            os.makedirs(source_root)
            path = os.path.join(source_root, "long.jsonl")
            text = "budget-anchor-lilac " + "synthetic filler " * 30 + "authoritative-tail-marker"
            with open(path, "w", encoding="utf-8") as stream:
                stream.write(json.dumps({"seq": 1, "session": "budget-session", "text": text}) + chr(10))
            with patch.dict(os.environ, {"MDCG_SESSIONS_ROOT": source_root}):
                cg = _store(os.path.join(temp, "memory"))
                ingested = Ingestor(cg).ingest(JsonlSource(path), mine_fix_pairs=False)
                result = _recall(cg, "budget-anchor-lilac")
                item = next(item for item in result["pack"] if item["id"] == ingested["ids"][0])
                self.assertEqual(item["content"], text)
                self.assertEqual(item["tokens"], est_tokens(text))
                self.assertEqual(result["tokens_used"], est_tokens(text))
                self.assertEqual(set(result), {"pack", "tokens_used", "budget", "skipped", "recent", "meta"})

    def test_changed_source_event_is_skipped_instead_of_using_stale_excerpt(self):
        with TemporaryDirectory(prefix="alpha-source-drift-") as temp:
            source_root = os.path.join(temp, "sources")
            os.makedirs(source_root)
            path = os.path.join(source_root, "drift.jsonl")
            original = "drift-anchor-amber " + "original filler " * 25 + "original-tail"
            with open(path, "w", encoding="utf-8") as stream:
                stream.write(json.dumps({"seq": 1, "session": "drift-session", "text": original}) + chr(10))
            with patch.dict(os.environ, {"MDCG_SESSIONS_ROOT": source_root}):
                cg = _store(os.path.join(temp, "memory"))
                ingested = Ingestor(cg).ingest(JsonlSource(path), mine_fix_pairs=False)
                with open(path, "w", encoding="utf-8") as stream:
                    stream.write(json.dumps({"seq": 1, "session": "drift-session",
                                             "text": original.replace("original-tail", "changed-tail")}) + chr(10))
                result = _recall(cg, "drift-anchor-amber")
                nid = ingested["ids"][0]
                self.assertNotIn(nid, {item["id"] for item in result["pack"]})
                skipped = next(item for item in result["skipped"] if item["id"] == nid)
                self.assertEqual(skipped["reason"], "source_event_changed")

    def test_low_clearance_does_not_report_private_source_even_when_missing(self):
        with TemporaryDirectory(prefix="alpha-source-acl-") as temp:
            source_root = os.path.join(temp, "sources")
            os.makedirs(source_root)
            path = os.path.join(source_root, "private.jsonl")
            private_text = "private-source-amber synthetic protected event"
            with open(path, "w", encoding="utf-8") as stream:
                stream.write(json.dumps({"seq": 1, "session": "private-session", "text": private_text}) + chr(10))
            with patch.dict(os.environ, {"MDCG_SESSIONS_ROOT": source_root}):
                owner = _store(os.path.join(temp, "memory"), clearance="private")
                ingested = Ingestor(owner).ingest(JsonlSource(path), mine_fix_pairs=False)
                os.remove(path)
                reader = _store(os.path.join(temp, "memory"), clearance="public")
                result = _recall(reader, "private-source-amber")
                nid = ingested["ids"][0]
                self.assertNotIn(nid, {item["id"] for item in result["pack"]})
                self.assertNotIn(nid, {item["id"] for item in result["skipped"]})
                self.assertNotIn(private_text, str(result))


    def test_source_ref_rejects_traversal_and_absolute_paths(self):
        for path in ("../outside.jsonl", "C:/outside.jsonl", "/outside.jsonl"):
            with self.subTest(path=path):
                result = _resolve_source_ref({
                    "version": 1, "path": path, "line": 1,
                    "event_sha256": "0" * 64,
                })
                self.assertEqual(result["status"], "source_path_invalid")

    def test_missing_visible_source_event_is_skipped(self):
        with TemporaryDirectory(prefix="alpha-source-missing-") as temp:
            source_root = os.path.join(temp, "sources")
            os.makedirs(source_root)
            path = os.path.join(source_root, "missing.jsonl")
            text = "missing-source-anchor violet " + "synthetic filler " * 25
            with open(path, "w", encoding="utf-8") as stream:
                stream.write(json.dumps({"seq": 1, "session": "missing-session",
                                         "text": text}) + chr(10))
            with patch.dict(os.environ, {"MDCG_SESSIONS_ROOT": source_root}):
                cg = _store(os.path.join(temp, "memory"))
                ingested = Ingestor(cg).ingest(JsonlSource(path), mine_fix_pairs=False)
                os.remove(path)
                result = _recall(cg, "missing-source-anchor")
                nid = ingested["ids"][0]
                self.assertNotIn(nid, {item["id"] for item in result["pack"]})
                skipped = next(item for item in result["skipped"] if item["id"] == nid)
                self.assertEqual(skipped["reason"], "source_missing")
    def test_lexical_prefilter_skips_body_decryption_for_source_nonmatches(self):
        with TemporaryDirectory(prefix="alpha-source-prefilter-") as temp:
            source_root = os.path.join(temp, "sources")
            os.makedirs(source_root)
            path = os.path.join(source_root, "prefilter.jsonl")
            records = [
                {"seq": 1, "session": "prefilter-session",
                 "text": "synthetic filler " * 30 + "xqvzxqv target marker"},
                {"seq": 2, "session": "prefilter-session",
                 "text": "unrelated synthetic distractor record"},
            ]
            with open(path, "w", encoding="utf-8") as stream:
                for record in records:
                    stream.write(json.dumps(record) + chr(10))
            with patch.dict(os.environ, {"MDCG_SESSIONS_ROOT": source_root}):
                cg = _store(os.path.join(temp, "memory"))
                ingested = Ingestor(cg).ingest(JsonlSource(path), mine_fix_pairs=False)
                target_id, distractor_id = ingested["ids"]
                original_open = cg._open_content
                original_read = cg._read
                body_opens = []
                index_opens = []
                read_ids = []
                id_by_path = {entry["path"]: node_id
                              for node_id, entry in cg.index["nodes"].items()}

                def track_read(entry):
                    read_ids.append(id_by_path[entry["path"]])
                    return original_read(entry)

                def track_content_open(node_id, frontmatter, content):
                    if content == frontmatter.get("source_search_index"):
                        index_opens.append(node_id)
                    else:
                        body_opens.append(node_id)
                    return original_open(node_id, frontmatter, content)

                cg._open_content = track_content_open
                cg._read = track_read
                result = _recall(cg, "xqvzxqv")
                read_ids.clear()
                repeated = _recall(cg, "xqvzxqv")

                self.assertIn(target_id, {item["id"] for item in result["pack"]})
                self.assertIn(target_id, {item["id"] for item in repeated["pack"]})
                self.assertIn(target_id, body_opens)
                self.assertNotIn(distractor_id, body_opens)
                self.assertEqual(set(index_opens), {target_id, distractor_id})
                self.assertEqual(len(index_opens), 2)
                self.assertIn(target_id, read_ids)
                self.assertNotIn(distractor_id, read_ids)
    def test_lexical_prefilter_skips_bigrams_only_distractors_after_warmup(self):
        with TemporaryDirectory(prefix="alpha-source-trigram-filter-") as temp:
            source_root = os.path.join(temp, "sources")
            os.makedirs(source_root)
            path = os.path.join(source_root, "trigrams.jsonl")
            records = [
                {"seq": 1, "session": "trigram-session",
                 "text": "synthetic filler " * 30 + "鲸鱼蓝调令牌"},
                {"seq": 2, "session": "trigram-session",
                 "text": "synthetic filler " * 30 + "蓝调"},
            ]
            with open(path, "w", encoding="utf-8") as stream:
                for record in records:
                    stream.write(json.dumps(record, ensure_ascii=False) + chr(10))
            with patch.dict(os.environ, {"MDCG_SESSIONS_ROOT": source_root}):
                cg = _store(os.path.join(temp, "memory"))
                ingested = Ingestor(cg).ingest(JsonlSource(path), mine_fix_pairs=False)
                target_id, distractor_id = ingested["ids"]
                original_read = cg._read
                read_ids = []

                def track_read(entry):
                    read_ids.append(os.path.splitext(os.path.basename(entry["path"]))[0])
                    return original_read(entry)

                cg._read = track_read
                _recall(cg, "cache-warmup-only")
                read_ids.clear()
                result = _recall(cg, "鲸鱼蓝调令牌")

                self.assertIn(target_id, {item["id"] for item in result["pack"]})
                self.assertNotIn(distractor_id, read_ids)
    def test_lexical_prefilter_ignores_high_frequency_trigrams(self):
        with TemporaryDirectory(prefix="alpha-source-common-trigram-") as temp:
            source_root = os.path.join(temp, "sources")
            os.makedirs(source_root)
            path = os.path.join(source_root, "common.jsonl")
            records = [{"seq": 1, "session": "common-trigram-session",
                        "text": "synthetic filler " * 30 + "巡检完成条件"}]
            records.extend({"seq": seq, "session": "common-trigram-session",
                            "text": "synthetic filler " * 30 + "状态巡检完成，结果已记录"}
                           for seq in range(2, 12))
            with open(path, "w", encoding="utf-8") as stream:
                for record in records:
                    stream.write(json.dumps(record, ensure_ascii=False) + chr(10))
            with patch.dict(os.environ, {"MDCG_SESSIONS_ROOT": source_root}):
                cg = _store(os.path.join(temp, "memory"))
                ingested = Ingestor(cg).ingest(JsonlSource(path), mine_fix_pairs=False)
                target_id, *distractor_ids = ingested["ids"]
                original_read = cg._read
                read_ids = []

                def track_read(entry):
                    read_ids.append(os.path.splitext(os.path.basename(entry["path"]))[0])
                    return original_read(entry)

                cg._read = track_read
                _recall(cg, "cache-warmup-only")
                read_ids.clear()
                result = _recall(cg, "巡检完成条件")

                self.assertIn(target_id, {item["id"] for item in result["pack"]})
                self.assertFalse(set(distractor_ids).intersection(read_ids))
    def test_late_event_terms_retrieve_target_ahead_of_recent_distractors(self):
        with TemporaryDirectory(prefix="alpha-source-late-index-") as temp:
            source_root = os.path.join(temp, "sources")
            os.makedirs(source_root)
            path = os.path.join(source_root, "late.jsonl")
            text = "synthetic filler " * 30 + "xqvzxqv identifies event 42"
            records = [{"seq": 1, "session": "late-session", "text": text}]
            records.extend({"seq": seq, "session": "late-session",
                            "text": f"unrelated synthetic distraction record {seq}"}
                           for seq in range(2, 32))
            with open(path, "w", encoding="utf-8") as stream:
                for record in records:
                    stream.write(json.dumps(record) + chr(10))
            with patch.dict(os.environ, {"MDCG_SESSIONS_ROOT": source_root}):
                cg = _store(os.path.join(temp, "memory"))
                ingested = Ingestor(cg).ingest(JsonlSource(path), mine_fix_pairs=False)
                nid = ingested["ids"][0]
                stored_index = cg._read(cg.index["nodes"][nid])[0].get("source_search_index")
                self.assertIsInstance(stored_index, str)
                self.assertTrue(crypto.is_encrypted(stored_index))
                self.assertNotIn("source_search_index", cg.get(nid)["frontmatter"])
                scored = cg._lexical("xqvzxqv", cg._candidates(), {"scanned": 0})
                lexical_score = next(score for doc, score in scored if doc["id"] == nid)
                self.assertGreater(lexical_score, 0)
                result = _recall(cg, "xqvzxqv")
                item = next(item for item in result["pack"] if item["id"] == nid)
                self.assertEqual(item["content"], text)
                self.assertNotIn("source_search_index", item["frontmatter"])
                self.assertNotIn("_source_search_terms", item["frontmatter"])

if __name__ == "__main__":
    unittest.main()