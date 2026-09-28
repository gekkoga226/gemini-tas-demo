import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from scripts.work_measure import main


class MeasurementTest(unittest.TestCase):
    def test_record_summary_and_missingness(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / "synthetic-repo"
            repo.mkdir()
            def run(*args):
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    main(args, repo=repo)
                return out.getvalue()

            run("start", "task1", "--model", "synthetic-model", "--work-type", "research")
            run("event", "task1", "pruning", "--calls", "1", "--display-chars", "12",
                "--rereads", "0", "--reread-chars", "0")
            run("event", "task1", "pruning", "--calls", "1", "--display-chars", "unknown",
                "--rereads", "1", "--reread-chars", "5")
            run("end", "task1", "--success", "yes", "--rework", "no",
                "--strategy-status", "checkpoint=unused", "--strategy-status", "repo_map=unavailable")
            run("start", "task2")
            run("end", "task2")
            record = json.loads((repo / ".work-measure" / "task1.json").read_text())
            self.assertEqual(record["usage"]["input_tokens"], "unknown")
            self.assertEqual(record["strategies"]["pruning"]["calls"], 2)
            self.assertIsNone(record["strategies"]["pruning"]["display_chars"])
            result = json.loads(run("summary"))
            self.assertEqual(result["work_count"], 2)
            self.assertEqual(result["strategies"]["pruning"]["statuses"],
                             {"used": 1, "unused": 0, "unavailable": 0, "unmeasured": 1})
            self.assertEqual(result["strategies"]["pruning"]["metrics"]["calls"],
                             {"known_sum": 2, "unknown_records": 0})
            self.assertEqual(result["strategies"]["pruning"]["metrics"]["display_chars"],
                             {"known_sum": 0, "unknown_records": 1})
            self.assertEqual(result["strategies"]["checkpoint"]["statuses"]["unused"], 1)
            self.assertEqual(result["strategies"]["repo_map"]["statuses"]["unavailable"], 1)
            self.assertEqual(result["outcomes"]["success"], {"yes": 1, "no": 0, "unknown": 1})


if __name__ == "__main__":
    unittest.main()
