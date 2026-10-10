"""Contract for the synthetic-only Alpha recall baseline runner."""
import unittest

from md_cg import bench_recall_synthetic


class SyntheticRecallRunnerContractTests(unittest.TestCase):
    def test_baseline_runner_is_available(self):
        self.assertTrue(
            callable(getattr(bench_recall_synthetic, "run_baseline", None)),
            "synthetic-only baseline runner is missing",
        )


    def test_runner_supports_mcp_default_recall_profile(self):
        event = {
            "id": "synthetic_mcp_default_target",
            "content": "synthetic cobalt lookup target",
            "layer": "knowledge",
            "sensitivity": "private",
        }
        fixture = {
            "events": [event],
            "questions": [{
                "id": "synthetic_mcp_default_question",
                "qtype": "unit",
                "query": "cobalt lookup",
                "evidence_ids": [event["id"]],
            }],
            "manifest": {"seed": 11},
        }

        report = bench_recall_synthetic.run_baseline(
            fixture,
            k=20,
            budget_tokens=1200,
            judge=True,
            max_item_tokens=250,
            paths=None,
        )

        self.assertEqual(report["rows"][0]["rank"], 1)
        self.assertEqual(report["parameters"], {
            "k": 20,
            "budget_tokens": 1200,
            "judge": True,
            "max_item_tokens": 250,
            "paths": "engine_default",
            "root_mode": "temporary_synthetic_only",
        })


if __name__ == "__main__":
    unittest.main()