"""Unit tests for the pure computation layer of sheets_client.

The Google I/O (`_service`, `list_projects`, `fetch_assessment`) is not exercised
here — only the deterministic helpers that turn raw `raw_data` values into the
`(topics_by_bb, bb_avgs)` structure the deck builder consumes. Run with:

    python3 -m unittest discover -s tests
"""
import json
import os
import unittest

import sheets_client

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# A tiny 3-topic taxonomy over 2 building blocks, in template order.
TINY_TAX = [
    {"bb": "BB One", "sub_bb": "S1", "topic": "T0", "atscale": 3.0},
    {"bb": "BB One", "sub_bb": "S1", "topic": "T1", "atscale": 2.0},
    {"bb": "BB Two", "sub_bb": "S2", "topic": "T2", "atscale": 4.0},
]
# Header: 3 topic columns, then the meta columns, mirroring `raw_data`.
HEADER = ["*T0*", "*T1*", "*T2*", "Your name", "t", "p", "s"]


def _rows():
    # Two Acme respondents + one other project.
    return [
        [3, 4, 5, "Alice", "Acme", "x", ""],
        [2, "", 3, "Bob", "Acme", "x", ""],
        [1, 1, 1, "Zoe", "OtherCo", "x", ""],
    ]


class ComputeAssessmentTests(unittest.TestCase):
    def test_averages_group_and_atscale(self):
        topics_by_bb, bb_avgs = sheets_client.compute_assessment(
            HEADER, _rows(), "Acme", TINY_TAX)

        # T0: mean(3,2)=2.5 ; T1: mean(4)=4.0 (blank ignored) ; T2: mean(5,3)=4.0
        self.assertEqual(topics_by_bb["BB One"], [
            {"topic": "T0", "rating": 2.5, "atscale": 3.0},
            {"topic": "T1", "rating": 4.0, "atscale": 2.0},
        ])
        self.assertEqual(topics_by_bb["BB Two"], [
            {"topic": "T2", "rating": 4.0, "atscale": 4.0},
        ])
        # client_avg over the BB's topic ratings; atscale_avg over atscale refs.
        self.assertEqual(bb_avgs["BB One"]["client_avg"], round((2.5 + 4.0) / 2, 1))
        self.assertEqual(bb_avgs["BB One"]["atscale_avg"], round((3.0 + 2.0) / 2, 1))
        self.assertEqual(bb_avgs["BB Two"], {"client_avg": 4.0, "atscale_avg": 4.0})

    def test_ignores_non_numeric_values(self):
        rows = [[3, "n/a", 5, "Alice", "Acme", "", ""]]
        topics_by_bb, _ = sheets_client.compute_assessment(HEADER, rows, "Acme", TINY_TAX)
        # T1 has no numeric response → rating None, no client dot placed downstream.
        self.assertIsNone(topics_by_bb["BB One"][1]["rating"])

    def test_topic_with_no_data_is_none_but_row_kept(self):
        rows = [["", "", "", "Alice", "Acme", "", ""]]
        topics_by_bb, bb_avgs = sheets_client.compute_assessment(HEADER, rows, "Acme", TINY_TAX)
        # All rows preserved (positional integrity with the template) even when empty.
        self.assertEqual(len(topics_by_bb["BB One"]), 2)
        self.assertIsNone(topics_by_bb["BB One"][0]["rating"])
        self.assertIsNone(bb_avgs["BB One"]["client_avg"])

    def test_matching_is_trim_and_case_insensitive(self):
        rows = [[4, 4, 4, "Alice", "  acme ", "", ""]]
        topics_by_bb, _ = sheets_client.compute_assessment(HEADER, rows, "Acme", TINY_TAX)
        self.assertEqual(topics_by_bb["BB One"][0]["rating"], 4.0)

    def test_ragged_rows_do_not_crash(self):
        # The Sheets API omits trailing empty cells → short rows.
        rows = [[3, 4, 5, "Alice", "Acme"], [2]]  # 2nd row has no project → excluded
        topics_by_bb, _ = sheets_client.compute_assessment(HEADER, rows, "Acme", TINY_TAX)
        self.assertEqual(topics_by_bb["BB One"][0]["rating"], 3.0)

    def test_raises_when_topic_columns_do_not_match_taxonomy(self):
        bad_header = ["*T0*", "*T1*", "Your name", "t"]  # only 2 topics vs 3 in taxonomy
        with self.assertRaises(ValueError):
            sheets_client.compute_assessment(bad_header, [], "Acme", TINY_TAX)


class SelectProjectsTests(unittest.TestCase):
    def test_distinct_sorted_excluding_blocklist(self):
        rows = [
            [1, 1, 1, "a", "Circula", "", ""],
            [1, 1, 1, "b", "tabesto", "", ""],
            [1, 1, 1, "c", "Circula", "", ""],
            [1, 1, 1, "d", "test", "", ""],
            [1, 1, 1, "e", "", "", ""],
            [1, 1, 1, "f", "[CHANGE TO CLIENT NAME]", "", ""],
        ]
        got = sheets_client.select_projects(HEADER, rows)
        self.assertEqual(got, ["Circula", "tabesto"])


class TaxonomyIntegrityTests(unittest.TestCase):
    """The committed taxonomy must stay aligned with the deck template geometry."""

    def test_taxonomy_matches_template_rows(self):
        import deck_builder
        with open(os.path.join(REPO, "self_assessment_taxonomy.json")) as f:
            tax = json.load(f)

        # Per-BB topic counts must equal the template's dot-row counts.
        expected = {bb: len(deck_builder.SLIDE_Y_CENTERS[num])
                    for num, bb in deck_builder.SLIDE_BB_MAP.items()}
        counts = {}
        for row in tax:
            counts[row["bb"]] = counts.get(row["bb"], 0) + 1
        self.assertEqual(counts, expected)

        # Every BB is a known template building block, and rows are contiguous by BB.
        self.assertTrue(set(counts).issubset(set(deck_builder.SLIDE_BB_MAP.values())))
        seen, order = set(), []
        for row in tax:
            if row["bb"] not in seen:
                seen.add(row["bb"]); order.append(row["bb"])
        self.assertEqual(len(order), len(seen), "each BB must be one contiguous block")

        for row in tax:
            self.assertTrue(row["topic"])
            self.assertIsInstance(row["atscale"], (int, float))


if __name__ == "__main__":
    unittest.main()
