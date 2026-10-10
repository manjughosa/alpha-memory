"""Tests overlap-aware reporting for paraphrase recall questions."""
import unittest

from md_cg.bench_recall_synthetic import summarize_rankings


class SyntheticRecallOverlapMetricsTests(unittest.TestCase):
    def test_summary_separates_lexically_overlapping_and_nonoverlapping_paraphrases(self):
        summary = summarize_rankings([
            {"qtype": "paraphrase", "rank": 1, "lexical_overlap": True},
            {"qtype": "paraphrase", "rank": 0, "lexical_overlap": False},
        ])

        self.assertIn("by_paraphrase_overlap", summary)
        self.assertEqual(summary["by_paraphrase_overlap"]["overlap"]["n"], 1)
        self.assertEqual(summary["by_paraphrase_overlap"]["no_overlap"]["n"], 1)
        self.assertEqual(
            summary["by_paraphrase_overlap"]["no_overlap"]["recall_at"]["1"],
            0.0,
        )


if __name__ == "__main__":
    unittest.main()