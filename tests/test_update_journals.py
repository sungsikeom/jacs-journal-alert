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

    def test_monitored_crossref_journals(self):
        journals = {journal["short_name"]: journal["issn"] for journal in UPDATE.JOURNALS}
        self.assertEqual(journals["Nat Commun"], "2041-1723")
        self.assertEqual(journals["J. Comput. Chem."], "1096-987X")
        self.assertEqual(journals["JCTC"], "1549-9626")
        self.assertEqual(journals["Angew. Chem. Int. Ed."], "1521-3773")

    def test_publisher_authority_removes_unverified_journal_items(self):
        journal = next(item for item in UPDATE.JOURNALS if item["short_name"] == "JCTC")
        articles = [
            {"doi": "10.1021/acs.jctc.6c00001", "journal_short": "JCTC", "title": "keep"},
            {"doi": "10.1021/acs.jctc.6c00002", "journal_short": "JCTC", "title": "remove"},
            {"doi": "10.1021/jacs.6c00001", "journal_short": "JACS", "title": "other"},
        ]
        inventory = {
            "10.1021/acs.jctc.6c00001": {
                "doi": "10.1021/acs.jctc.6c00001",
                "journal_short": "JCTC",
                "title": "publisher",
                "published_date": "2026-01-02",
            }
        }
        result = UPDATE.apply_publisher_authority(articles, inventory, journal)
        self.assertEqual({item["doi"] for item in result}, {"10.1021/acs.jctc.6c00001", "10.1021/jacs.6c00001"})
        kept = next(item for item in result if item["doi"] == "10.1021/acs.jctc.6c00001")
        self.assertEqual(kept["title"], "publisher")

    def test_publisher_baseline_keeps_inventory_and_new_indexed_records(self):
        indexed = [{"doi": "10.1002/anie.202600001", "title": "new"}]
        inventory = {"10.1002/anie.202500001": {"doi": "10.1002/anie.202500001", "title": "saved"}}
        result = UPDATE.merge_publisher_baseline(indexed, inventory)
        self.assertEqual(
            {item["doi"] for item in result},
            {"10.1002/anie.202600001", "10.1002/anie.202500001"},
        )

    def test_load_science_articles_normalizes_site_fields(self):
        science_path = Path(__file__).resolve().parents[1] / "data" / "science_articles.json"
        articles = UPDATE.load_science_articles(science_path)
        self.assertEqual(len(articles), 553)
        article = next(iter(articles.values()))
        self.assertEqual(article["journal_short"], "Science")
        self.assertEqual(article["article_type"], "Research Article")


if __name__ == "__main__":
    unittest.main()
