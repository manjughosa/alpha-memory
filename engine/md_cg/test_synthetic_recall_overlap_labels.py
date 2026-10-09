"""Verify declared paraphrase overlap matches actual whitespace token overlap."""
import unittest

from md_cg.bench_recall_synthetic import build_fixture


class SyntheticRecallOverlapLabelTests(unittest.TestCase):
    def test_paraphrase_overlap_labels_match_content_and_query_tokens(self):
        fixture = build_fixture(seed=20261009)
        events = {event["id"]: event["content"] for event in fixture["events"]}
        punctuation = ".,?!:;()[]{}"

        for question in fixture["questions"]:
            if question["qtype"] != "paraphrase":
                continue
            content = events[question["evidence_ids"][0]]
            content_tokens = {
                token.strip(punctuation).casefold()
                for token in content.split()
                if token.strip(punctuation)
            }
            query_tokens = {
                token.strip(punctuation).casefold()
                for token in question["query"].split()
                if token.strip(punctuation)
            }
            self.assertEqual(
                question["lexical_overlap"],
                bool(content_tokens & query_tokens),
                question["id"],
            )


if __name__ == "__main__":
    unittest.main()