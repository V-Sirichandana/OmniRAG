"""CI wrapper around the offline retrieval evaluation (eval/run_eval.py).

Runs the real pipeline (chunking, hybrid retrieval, RRF, sufficiency gate,
identity-chunk append, tenant/department authz) against the synthetic
two-organization corpus with a deterministic LLM/embedding stand-in, then
asserts the invariants AND the metric thresholds observed on 2026-10-18
(the day the harness was introduced):

    mode      | recall@6 | MRR  | abstain | facts | leaks | scenarios
    ----------+----------+------+---------+-------+-------+----------
    bm25      |  1.0 all | 1.0* |  all n  | all n |   0   |  9/9
    dense     |  1.0 all | 1.0  |  all n  | all n |   0   |  9/9
    (* paraphrase MRR 0.667 in bm25 — gold doc ranked 3rd, still answered)

Thresholds sit slightly below the observed values so real regressions
(leakage, gate bypass, retrieval drops, fact misses, scenario breakage)
fail the suite while trivial tie-order jitter does not.

Run standalone (it monkeypatches app.embeddings/app.llm in-process):

    .venv\\Scripts\\python.exe -m tests.test_retrieval_eval
"""
import importlib.util
import unittest
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location(
    "run_eval", Path(__file__).resolve().parents[1] / "eval" / "run_eval.py")
RUNNER = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(RUNNER)          # sets isolated env, patches stubs

MIN_QUESTIONS = 31                        # 24 original + 7 robustness additions

# categories that deliberately have no gold docs (abstention/authorization)
ABSTAIN_CATS = {"unanswerable", "cross_department", "cross_tenant"}

# documented sub-1.0 observations (see module docstring) get their own floor
MRR_FLOOR = 0.90
MRR_FLOOR_OVERRIDES = {("bm25", "paraphrase"): 0.60}   # observed 0.667


class TestRetrievalEval(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.report = RUNNER.run("both", verbose=False)
        cls.modes = cls.report["modes"]

    def test_hard_invariants(self):
        """Leakage, gate bypass, answerable-question abstentions: zero tolerance."""
        self.assertEqual(self.report["failures"], [])

    def test_dataset_coverage(self):
        total = sum(s["n"] for s in self.modes["bm25"].values())
        self.assertGreaterEqual(total, MIN_QUESTIONS)
        self.assertEqual(set(self.modes), {"bm25", "dense"})

    def test_recall_and_mrr_thresholds(self):
        for mode, summary in self.modes.items():
            for cat, s in summary.items():
                if cat in ABSTAIN_CATS:
                    continue
                self.assertGreaterEqual(
                    s["recall@6"], 0.95, f"{mode}/{cat}: recall@6 regressed")
                floor = MRR_FLOOR_OVERRIDES.get((mode, cat), MRR_FLOOR)
                self.assertGreaterEqual(
                    s["mrr"], floor, f"{mode}/{cat}: MRR regressed")

    def test_abstention_correct_in_all_categories(self):
        for mode, summary in self.modes.items():
            for cat, s in summary.items():
                self.assertEqual(
                    s["abstain_correct"], s["n"],
                    f"{mode}/{cat}: abstention correctness regressed")

    def test_required_facts_present(self):
        for mode, summary in self.modes.items():
            for cat, s in summary.items():
                if cat in ABSTAIN_CATS:
                    continue
                self.assertEqual(
                    s["facts_correct"], s["n"],
                    f"{mode}/{cat}: required fact missing from answers")

    def test_no_leakage_and_gate_contract(self):
        for mode, summary in self.modes.items():
            for cat, s in summary.items():
                self.assertEqual(s["leaks"], 0, f"{mode}/{cat}: sentinel leaked")
                self.assertEqual(s["gate_violations"], 0,
                                 f"{mode}/{cat}: below-threshold question "
                                 f"reached generation")

    def test_incidental_overlap_bounded(self):
        # q15/q22 share generic tokens with authorized docs, so the calibrated
        # lexical gate (MIN_EVIDENCE_COVERAGE=0.30) passes by design. Pin the
        # measured count so a change in either direction is noticed.
        for mode, summary in self.modes.items():
            total = sum(s["incidental_overlap"] for s in summary.values())
            self.assertLessEqual(total, 2, f"{mode}: incidental overlap grew")

    def test_runtime_scenarios(self):
        for s in self.report["scenarios"]:
            self.assertTrue(s["ok"], f"scenario failed: {s['scenario']}")
        names = {s["scenario"] for s in self.report["scenarios"]}
        for expected in ("format:docx_table", "format:pptx_table", "format:csv",
                         "format:json", "format:pdf",
                         "replacement:new_facts",
                         "replacement:old_chunks_deleted",
                         "new_upload:immediately_retrievable",
                         "new_upload:no_cross_tenant_leak"):
            self.assertIn(expected, names)


if __name__ == "__main__":
    unittest.main(verbosity=2)
