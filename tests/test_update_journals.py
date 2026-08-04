import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "update_journals.py"
SPEC = importlib.util.spec_from_file_location("update_journals", MODULE_PATH)
UPDATE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(UPDATE)


class MetadataNormalizationTests(unittest.TestCase):
    def test_normalize_doi(self):
        self.assertEqual(UPDATE.normalize_doi("https://doi.org/10.1021/JACS.1C00001"), "10.1021/jacs.1c00001")

    def test_normalize_title_removes_markup_and_whitespace(self):
        raw = "<i>In Situ</i>\n  CO<sub>2</sub> Capture &amp; Release"
        self.assertEqual(UPDATE.normalize_title(raw), "In Situ CO2 Capture & Release")

    def test_article_uses_plain_text_title(self):
        item = {
            "DOI": "10.1021/jacs.1c00001",
            "title": ["A <b>clean</b> title"],
            "published-online": {"date-parts": [[2026, 8, 4]]},
        }
        article = UPDATE.article_from_item(item, UPDATE.JOURNALS[0])
        self.assertEqual(article["title"], "A clean title")


if __name__ == "__main__":
    unittest.main()
