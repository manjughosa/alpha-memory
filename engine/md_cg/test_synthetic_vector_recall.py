"""Synthetic-only tests for local dense recall comparison."""
import unittest

from md_cg.bench_recall_synthetic import (
    run_local_embedding_recall,
    run_qdrant_local_recall,
)


class SyntheticVectorRecallTests(unittest.TestCase):
    def test_qdrant_source_recall_runs_acl_then_authoritative_pack(self):
        from md_cg.bench_recall_synthetic import run_qdrant_source_recall_e2e

        fixture = {
            "events": [
                {"id": "target", "content": "synthetic source evidence full body", "layer": "knowledge", "sensitivity": "private"},
                {"id": "distractor", "content": "unrelated synthetic source event", "layer": "knowledge", "sensitivity": "private"},
                {"id": "secret-probe", "content": "synthetic secret vector probe", "layer": "knowledge", "sensitivity": "secret"},
            ],
            "questions": [{
                "id": "q1", "qtype": "paraphrase", "query": "where is the evidence?",
                "lexical_overlap": False, "evidence_ids": ["target"],
            }],
            "manifest": {"seed": 10},
        }
        query_text = (
            "Instruct: Retrieve the most relevant memory event that answers the user's query."
            + chr(10) + "Query: where is the evidence?"
        )
        vectors = {
            "synthetic source evidence full body": [0.8, 0.6],
            "unrelated synthetic source event": [0.0, 1.0],
            "synthetic secret vector probe": [1.0, 0.0],
            query_text: [1.0, 0.0],
        }
        result = run_qdrant_source_recall_e2e(
            fixture, embedding_fn=lambda texts: [vectors.get(text, [1.0, 0.0]) for text in texts],
        )
        self.assertEqual(result["qdrant"]["summary"]["recall_at"]["5"], 1.0)
        self.assertTrue(result["qdrant"]["rows"][0]["source_reread_verified"])
        self.assertEqual(result["security"]["acl_filtered_points"], 1)
        self.assertEqual(result["security"]["unauthorized_results"], 0)

    def test_qdrant_local_runner_indexes_and_retrieves_synthetic_vectors(self):
        fixture = {
            "events": [
                {"id": "target", "content": "full synthetic evidence", "layer": "knowledge", "sensitivity": "private"},
                {"id": "distractor", "content": "unrelated synthetic noise", "layer": "knowledge", "sensitivity": "private"},
            ],
            "questions": [{
                "id": "q1", "qtype": "paraphrase", "query": "where is the evidence?",
                "lexical_overlap": False, "evidence_ids": ["target"],
            }],
            "manifest": {"seed": 9},
        }
        instruction = "Instruct: Retrieve the most relevant memory event that answers the user's query."
        query_text = instruction + chr(10) + "Query: where is the evidence?"
        vectors = {
            "full synthetic evidence": [1.0, 0.0],
            "unrelated synthetic noise": [0.0, 1.0],
            query_text: [1.0, 0.0],
        }
        result = run_qdrant_local_recall(
            fixture, embedding_fn=lambda texts: [vectors[text] for text in texts],
        )
        self.assertEqual(result["rows"][0]["rank"], 1)
        self.assertEqual(result["rows"][0]["retrieved_ids"][0], "target")
        self.assertEqual(result["summary"]["recall_at"]["5"], 1.0)
        self.assertEqual(result["parameters"]["storage"], "qdrant_local_memory")
        self.assertEqual(result["counts"]["indexed_vectors"], 2)

    def test_local_embedding_runner_ranks_full_synthetic_events(self):
        fixture = {
            "events": [
                {"id": "target", "content": "full synthetic evidence after the cutoff", "layer": "knowledge", "sensitivity": "private"},
                {"id": "distractor", "content": "unrelated synthetic distractor", "layer": "knowledge", "sensitivity": "private"},
            ],
            "questions": [{
                "id": "q1", "qtype": "paraphrase", "query": "where is the evidence?",
                "lexical_overlap": False, "evidence_ids": ["target"],
            }],
            "manifest": {"seed": 9},
        }
        seen = []
        instruction = "Instruct: Retrieve the most relevant memory event that answers the user's query."
        query_text = instruction + chr(10) + "Query: where is the evidence?"

        def embed(texts):
            seen.extend(texts)
            vectors = {
                "full synthetic evidence after the cutoff": [1.0, 0.0],
                "unrelated synthetic distractor": [0.0, 1.0],
                query_text: [1.0, 0.0],
            }
            return [vectors[text] for text in texts]

        result = run_local_embedding_recall(fixture, embedding_fn=embed, batch_size=2)

        self.assertEqual(result["rows"][0]["rank"], 1)
        self.assertEqual(result["summary"]["recall_at"]["5"], 1.0)
        self.assertIn("full synthetic evidence after the cutoff", seen)
        self.assertIn(query_text, seen)
        self.assertEqual(result["parameters"]["storage"], "in_memory")
        self.assertEqual(result["manifest"], fixture["manifest"])
        self.assertGreaterEqual(result["latency_ms"]["p95"], 0.0)


if __name__ == "__main__":
    unittest.main()


class SyntheticStressFixtureTests(unittest.TestCase):
    def test_stress_fixture_has_repeatable_requested_sizes_and_valid_evidence(self):
        from md_cg.bench_recall_synthetic import build_stress_fixture

        first = build_stress_fixture(event_count=10000, question_count=300)
        second = build_stress_fixture(event_count=10000, question_count=300)

        self.assertEqual(len(first["events"]), 10000)
        self.assertEqual(len(first["questions"]), 300)
        self.assertEqual(first["manifest"], second["manifest"])
        self.assertEqual(first["manifest"]["events_sha256"], "c226ab494b9055d0e6c62abf93d1607693af1f78e3d33e23ad9efa58c532e9ed")
        self.assertEqual(first["manifest"]["questions_sha256"], "021f330b469fbda827fc455200b304eced8fc6b7255e3ee9924fb4003fde6106")
        event_ids = {event["id"] for event in first["events"]}
        self.assertEqual(len(event_ids), 10000)
        self.assertTrue(all(set(question["evidence_ids"]).issubset(event_ids) for question in first["questions"]))