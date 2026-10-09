"""Guard against accidental lexical leakage between synthetic query classes."""
import unittest

from md_cg.bench_recall_synthetic import build_fixture


class SyntheticRecallDisambiguationTests(unittest.TestCase):
    def test_late_clue_terms_are_not_reused_as_chinese_only_gold_terms(self):
        fixture = build_fixture(seed=20261009)
        late_terms = {
            question["query"].split("对应哪个测试编号")[0]
            for question in fixture["questions"]
            if question["qtype"] == "late_240"
        }
        chinese_terms = {
            question["query"]
            for question in fixture["questions"]
            if question["qtype"] == "zh_3plus"
        }

        self.assertTrue(late_terms.isdisjoint(chinese_terms))


if __name__ == "__main__":
    unittest.main()