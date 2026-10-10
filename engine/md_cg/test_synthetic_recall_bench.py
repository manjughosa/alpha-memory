"""Contract tests for the deterministic synthetic recall baseline."""
import importlib
import importlib.util
import unittest

MODULE = "md_cg.bench_recall_synthetic"


class SyntheticRecallBenchmarkTests(unittest.TestCase):
    def load_benchmark(self):
        spec = importlib.util.find_spec(MODULE)
        self.assertIsNotNone(spec, "synthetic recall benchmark module is missing")
        return importlib.import_module(MODULE)

    def test_fixture_is_reproducible_and_matches_the_plan_shape(self):
        benchmark = self.load_benchmark()
        first = benchmark.build_fixture(seed=20261009)
        second = benchmark.build_fixture(seed=20261009)

        self.assertEqual(len(first["events"]), 1000)
        self.assertEqual(len(first["questions"]), 180)
        self.assertEqual(first["manifest"], second["manifest"])
        self.assertEqual(first["manifest"]["events_sha256"], second["manifest"]["events_sha256"])
        self.assertEqual(first["manifest"]["questions_sha256"], second["manifest"]["questions_sha256"])
        self.assertEqual(first["events"], second["events"])
        self.assertEqual(first["questions"], second["questions"])

        counts = {}
        event_ids = {event["id"] for event in first["events"]}
        for question in first["questions"]:
            counts[question["qtype"]] = counts.get(question["qtype"], 0) + 1
            self.assertTrue(question["evidence_ids"])
            self.assertTrue(set(question["evidence_ids"]).issubset(event_ids))
        self.assertEqual(set(counts.values()), {30})
        self.assertEqual(len(counts), 6)

        paraphrases = [q for q in first["questions"] if q["qtype"] == "paraphrase"]
        self.assertEqual(sum(q["lexical_overlap"] for q in paraphrases), 15)
        self.assertEqual(sum(not q["lexical_overlap"] for q in paraphrases), 15)
        self.assertTrue(all(event["id"].startswith("synthetic_") for event in first["events"]))

    def test_ranking_summary_reports_required_cutoffs(self):
        benchmark = self.load_benchmark()
        summary = benchmark.summarize_rankings(
            [
                {"qtype": "late_240", "rank": 1},
                {"qtype": "late_240", "rank": 5},
                {"qtype": "zh_2", "rank": 0},
            ],
            k_values=(1, 5, 10),
        )

        self.assertEqual(summary["n"], 3)
        self.assertAlmostEqual(summary["recall_at"]["1"], 1 / 3)
        self.assertAlmostEqual(summary["recall_at"]["5"], 2 / 3)
        self.assertAlmostEqual(summary["recall_at"]["10"], 2 / 3)
        self.assertAlmostEqual(summary["mrr_at_10"], 0.4)
        self.assertAlmostEqual(summary["precision_at_5"], 2 / 15)
        self.assertEqual(summary["by_qtype"]["late_240"]["n"], 2)


if __name__ == "__main__":
    unittest.main()