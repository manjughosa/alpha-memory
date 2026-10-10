"""End-to-end tests for the synthetic-only recall baseline runner."""
import unittest

from md_cg.bench_recall_synthetic import run_baseline


class SyntheticRecallRunnerTests(unittest.TestCase):
    def test_baseline_indexes_and_recalls_private_synthetic_evidence_in_isolation(self):
        event = {
            "id": "synthetic_event_target",
            "content": "synthetic cobalt lookup target",
            "layer": "knowledge",
            "sensitivity": "private",
        }
        fixture = {
            "events": [event],
            "questions": [{
                "id": "synthetic_question_target",
                "qtype": "unit",
                "query": "cobalt lookup",
                "evidence_ids": [event["id"]],
            }],
            "manifest": {"seed": 7},
        }

        result = run_baseline(
            fixture,
            k=5,
            budget_tokens=512,
            paths=("lexical",),
        )

        self.assertEqual(result["rows"][0]["rank"], 1)
        self.assertEqual(result["summary"]["n"], 1)
        self.assertEqual(result["summary"]["recall_at"]["5"], 1.0)
        self.assertEqual(result["counts"]["misses"], 0)
        self.assertGreaterEqual(result["latency_ms"]["p95"], 0.0)


    def test_source_ingest_runner_recalls_late_tail_terms(self):
        from md_cg.bench_recall_synthetic import run_source_ingested

        target = {
            "id": "synthetic_event_target",
            "content": "ordinary synthetic context " * 18 + "\nxqvzxqv identifies the target event",
            "layer": "knowledge",
            "sensitivity": "private",
        }
        events = [target] + [{
            "id": f"synthetic_event_distractor_{seq}",
            "content": f"unrelated synthetic distraction record {seq}",
            "layer": "knowledge",
            "sensitivity": "private",
        } for seq in range(30)]
        fixture = {
            "events": events,
            "questions": [{
                "id": "synthetic_question_late_tail",
                "qtype": "late_240",
                "query": "xqvzxqv",
                "evidence_ids": [target["id"]],
            }],
            "manifest": {"seed": 8},
        }

        from md_cg.bench_recall_synthetic import run_baseline

        legacy_fixture = dict(fixture)
        legacy_fixture["events"] = [
            {**event, "content": event["content"][:240]}
            for event in events
        ]
        legacy = run_baseline(legacy_fixture, k=5, budget_tokens=512,
                              paths=("lexical",))
        self.assertEqual(legacy["rows"][0]["rank"], 0)
        result = run_source_ingested(fixture, k=5, budget_tokens=512,
                                     paths=("lexical",))

        self.assertEqual(result["rows"][0]["rank"], 1)
        self.assertEqual(result["summary"]["recall_at"]["5"], 1.0)
        self.assertEqual(result["source_ingest"]["written"], 31)
if __name__ == "__main__":
    unittest.main()