#!/usr/bin/env python3
"""Fetch journal metadata published since the fixed site cutoff."""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
ARTICLES_PATH = DATA_DIR / "articles.json"
STATE_PATH = DATA_DIR / "seen_dois.json"
ISSUE_BODY_PATH = DATA_DIR / "new_articles.md"
SEOUL = timezone(timedelta(hours=9))
SCOPE_START = "2026-01-01"
SCOPE_VERSION = 6

JOURNALS = [
    {
        "key": "jacs",
        "name": "Journal of the American Chemical Society",
        "short_name": "JACS",
        "issn": "0002-7863",
    },
    {"key": "nature-communications", "name": "Nature Communications", "short_name": "Nat Commun", "issn": "2041-1723"},
    {"key": "journal-of-computational-chemistry", "name": "Journal of Computational Chemistry", "short_name": "J. Comput. Chem.", "issn": "1096-987X"},
    {"key": "jctc", "name": "Journal of Chemical Theory and Computation", "short_name": "JCTC", "issn": "1549-9626"},
    {"key": "angewandte", "name": "Angewandte Chemie International Edition", "short_name": "Angew. Chem. Int. Ed.", "issn": "1521-3773"},
]


def normalize_doi(value: str) -> str:
    value = value.strip().lower()
    for prefix in ("https://doi.org/", "http://doi.org/", "doi:"):
        if value.startswith(prefix):
            value = value[len(prefix) :]
    return value


def normalize_title(value: str) -> str:
    """Convert Crossref's occasional inline markup into a plain-text title."""
    value = html.unescape(value)
    value = re.sub(r"<[^>]+>", "", value)
    return " ".join(value.split()).strip()


def first_date(item: dict[str, Any]) -> str | None:
    for key in ("published-online", "published-print", "published", "issued"):
        parts = item.get(key, {}).get("date-parts", [])
        if parts and parts[0]:
            values = list(parts[0]) + [1, 1]
            try:
                return f"{int(values[0]):04d}-{int(values[1]):02d}-{int(values[2]):02d}"
            except (TypeError, ValueError):
                continue
    return None


def crossref_url(issn: str, start: str, end: str, rows: int, cursor: str) -> str:
    params = {
        "filter": f"from-pub-date:{start},until-pub-date:{end},type:journal-article",
        "select": "DOI,title,URL,published-online,published-print,published,issued,indexed",
        "rows": str(rows),
        "cursor": cursor,
        "sort": "published",
        "order": "desc",
        "mailto": os.environ.get("CROSSREF_MAILTO", "journal-alert@example.com"),
    }
    return f"https://api.crossref.org/journals/{issn}/works?{urllib.parse.urlencode(params)}"


def fetch_all_pages(issn: str, start: str, end: str, rows: int) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    cursor = "*"
    seen_pages: set[tuple[str, ...]] = set()
    while True:
        payload = fetch_json(crossref_url(issn, start, end, rows, cursor))
        message = payload.get("message", {})
        page = message.get("items", [])
        page_signature = tuple(normalize_doi(str(item.get("DOI", ""))) for item in page)
        if page_signature in seen_pages:
            raise RuntimeError("Crossref returned the same result page more than once")
        seen_pages.add(page_signature)
        items.extend(page)
        next_cursor = message.get("next-cursor")
        if len(page) < rows or not next_cursor:
            break
        cursor = str(next_cursor)
    return items


def fetch_json(url: str, attempts: int = 6) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "JACSJournalAlert/1.0 (mailto:journal-alert@example.com)",
        },
    )
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            if exc.code != 429 and not 500 <= exc.code < 600:
                raise
            if attempt == attempts - 1:
                raise
            retry_after = exc.headers.get("Retry-After")
            try:
                delay = float(retry_after) if retry_after else 5 * (2**attempt)
            except ValueError:
                delay = 5 * (2**attempt)
            print(f"Crossref returned HTTP {exc.code}; retrying in {delay:g} seconds.")
            time.sleep(delay)
    raise RuntimeError("Crossref request retry loop ended unexpectedly")


def load_json(path: Path, fallback: Any) -> Any:
    if not path.exists():
        return fallback
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return fallback


def atomic_write(path: Path, payload: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(payload, encoding="utf-8")
    temporary.replace(path)


def article_from_item(item: dict[str, Any], journal: dict[str, str]) -> dict[str, Any] | None:
    doi = normalize_doi(str(item.get("DOI", "")))
    titles = item.get("title") or []
    title = normalize_title(str(titles[0])) if titles else ""
    if not doi or not title:
        return None
    indexed = item.get("indexed", {}).get("date-time")
    return {
        "doi": doi,
        "title": title,
        "journal": journal["name"],
        "journal_short": journal["short_name"],
        "published_date": first_date(item),
        "indexed_at": indexed,
        "url": f"https://doi.org/{urllib.parse.quote(doi, safe='/()')}",
    }


def deduplicate(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_doi: dict[str, dict[str, Any]] = {}
    for item in items:
        by_doi[item["doi"]] = item
    return sorted(
        by_doi.values(),
        key=lambda x: (x.get("published_date") or "", x.get("indexed_at") or "", x["doi"]),
        reverse=True,
    )


def issue_markdown(new_articles: list[dict[str, Any]], checked_at: str) -> str:
    lines = [f"## 신규 논문 {len(new_articles)}편", "", f"확인 시각: {checked_at}", ""]
    for article in new_articles:
        lines.extend(
            [
                f"### {article['title']}",
                "",
                f"DOI: [{article['doi']}]({article['url']})",
                "",
            ]
        )
    return "\n".join(lines).rstrip() + "\n"


def load_acs_articles(path: Path) -> dict[str, dict[str, Any]]:
    payload = load_json(path, {})
    if payload.get("scope_start") != SCOPE_START:
        raise ValueError(f"ACS scope_start must be {SCOPE_START}")
    articles = payload.get("articles")
    if not isinstance(articles, list) or len(articles) < 1000:
        raise ValueError("ACS file is missing or contains implausibly few articles")
    by_doi: dict[str, dict[str, Any]] = {}
    for item in articles:
        doi = normalize_doi(str(item.get("doi", "")))
        if not doi.startswith("10.1021/jacs."):
            continue
        published_date = item.get("published_date")
        if published_date and published_date < SCOPE_START:
            continue
        by_doi[doi] = {
            "doi": doi,
            "title": str(item.get("title") or "").strip(),
            "journal": JOURNALS[0]["name"],
            "journal_short": JOURNALS[0]["short_name"],
            "published_date": published_date,
            "indexed_at": None,
            "url": f"https://doi.org/{urllib.parse.quote(doi, safe='/()')}",
            "sources": ["acs"],
        }
    if len(by_doi) < 1000:
        raise ValueError("ACS DOI validation left implausibly few articles")
    return by_doi


def load_science_articles(path: Path) -> dict[str, dict[str, Any]]:
    payload = load_json(path, {})
    if payload.get("scope_start") != SCOPE_START:
        raise ValueError(f"Science scope_start must be {SCOPE_START}")
    articles = payload.get("articles")
    if not isinstance(articles, list) or len(articles) < 50:
        raise ValueError("Science file is missing or contains implausibly few articles")
    by_doi: dict[str, dict[str, Any]] = {}
    for item in articles:
        doi = normalize_doi(str(item.get("doi", "")))
        published_date = item.get("published_date")
        if not doi.startswith("10.1126/science.") or not published_date or published_date < SCOPE_START:
            continue
        by_doi[doi] = {
            "doi": doi,
            "title": normalize_title(str(item.get("title") or doi)),
            "journal": "Science",
            "journal_short": "Science",
            "published_date": published_date,
            "indexed_at": None,
            "url": f"https://doi.org/{urllib.parse.quote(doi, safe='/()')}",
            "article_type": "Research Article",
            "sources": ["science"],
        }
    if len(by_doi) < 50:
        raise ValueError("Science DOI validation left implausibly few articles")
    return by_doi


def merge_acs_and_crossref(
    acs_by_doi: dict[str, dict[str, Any]], crossref_articles: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    crossref_by_doi = {article["doi"]: article for article in crossref_articles}
    merged: list[dict[str, Any]] = []
    for doi, acs_article in acs_by_doi.items():
        crossref = crossref_by_doi.get(doi)
        if crossref:
            article = {**acs_article, **crossref, "sources": ["acs", "crossref"]}
            if not article.get("published_date"):
                article["published_date"] = acs_article.get("published_date")
            if not article.get("title"):
                article["title"] = acs_article.get("title") or doi
        else:
            article = {**acs_article}
            if not article.get("title"):
                article["title"] = doi
        merged.append(article)
    for doi, crossref in crossref_by_doi.items():
        if doi not in acs_by_doi:
            merged.append({**crossref, "sources": ["crossref"]})
    return deduplicate(merged)


def load_publisher_articles(path: Path, journal: dict[str, str], minimum: int = 10) -> dict[str, dict[str, Any]]:
    payload = load_json(path, {})
    if payload.get("scope_start") != SCOPE_START:
        raise ValueError(f"{journal['short_name']} scope_start must be {SCOPE_START}")
    articles = payload.get("articles")
    if not isinstance(articles, list) or len(articles) < minimum:
        raise ValueError(f"{journal['short_name']} inventory contains implausibly few articles")
    by_doi: dict[str, dict[str, Any]] = {}
    for item in articles:
        doi = normalize_doi(str(item.get("doi", "")))
        published_date = item.get("published_date")
        if not doi or not published_date or published_date < SCOPE_START:
            continue
        by_doi[doi] = {
            "doi": doi,
            "title": normalize_title(str(item.get("title") or doi)),
            "journal": journal["name"],
            "journal_short": journal["short_name"],
            "published_date": published_date,
            "indexed_at": None,
            "url": f"https://doi.org/{urllib.parse.quote(doi, safe='/()')}",
            "sources": ["publisher"],
        }
    if len(by_doi) < minimum:
        raise ValueError(f"{journal['short_name']} DOI validation left implausibly few articles")
    return by_doi


def apply_publisher_authority(
    articles: list[dict[str, Any]], inventory: dict[str, dict[str, Any]], journal: dict[str, str]
) -> list[dict[str, Any]]:
    kept = [article for article in articles if article.get("journal_short") != journal["short_name"]]
    kept.extend(inventory.values())
    return deduplicate(kept)


def merge_publisher_baseline(
    articles: list[dict[str, Any]], inventory: dict[str, dict[str, Any]]
) -> list[dict[str, Any]]:
    """Keep the saved publisher inventory and append newly indexed records."""
    return deduplicate([*articles, *inventory.values()])


def carry_same_day_new_articles(
    fetched: list[dict[str, Any]], old_output: dict[str, Any], today: date
) -> list[dict[str, Any]]:
    """Keep today's NEW list stable when the updater runs more than once."""
    if str(old_output.get("checked_at", ""))[:10] != today.isoformat():
        return []
    previous_new = {normalize_doi(value) for value in old_output.get("new_dois", [])}
    return [article for article in fetched if article["doi"] in previous_new]


def update(
    fixture: Path | None,
    rows: int,
    acs_file: Path | None,
    science_file: Path | None,
    publisher_files: dict[str, Path],
) -> int:
    checked_at = datetime.now(SEOUL).isoformat(timespec="seconds")
    today = datetime.now(SEOUL).date()
    scope_start = SCOPE_START
    scope_end = today.isoformat()
    old_state = load_json(STATE_PATH, {})
    old_output = load_json(ARTICLES_PATH, {})
    initialized = (
        bool(old_state.get("initialized"))
        and old_state.get("scope_start") == scope_start
        and old_state.get("scope_version") == SCOPE_VERSION
    )
    seen = {normalize_doi(value) for value in old_state.get("seen_dois", [])}
    journals_by_key = {journal["key"]: journal for journal in JOURNALS}
    fetched = []
    fixture_payload = load_json(fixture, {}) if fixture else None
    for journal in JOURNALS:
        items = (
            fixture_payload.get("message", {}).get("items", [])
            if fixture_payload is not None
            else fetch_all_pages(journal["issn"], scope_start, scope_end, rows)
        )
        for item in items:
            article = article_from_item(item, journal)
            if article and article["published_date"] and scope_start <= article["published_date"] <= scope_end:
                fetched.append(article)
    fetched = deduplicate(fetched)
    source_mode = "publisher-baseline+crossref" if acs_file or science_file or publisher_files else "crossref"
    if acs_file:
        fetched = merge_acs_and_crossref(load_acs_articles(acs_file), fetched)
    if science_file:
        fetched = deduplicate([*fetched, *load_science_articles(science_file).values()])
    for key, inventory_path in publisher_files.items():
        fetched = merge_publisher_baseline(
            fetched, load_publisher_articles(inventory_path, journals_by_key[key])
        )
    detected_new_articles = [article for article in fetched if article["doi"] not in seen] if initialized else []
    display_new_articles = detected_new_articles
    if initialized and not display_new_articles:
        display_new_articles = carry_same_day_new_articles(fetched, old_output, today)
    new_dois = {article["doi"] for article in fetched}
    combined_seen = sorted((seen | new_dois) if initialized else new_dois)
    output = {
        "checked_at": checked_at,
        "journal_count": len({article["journal"] for article in fetched}),
        "new_count": len(display_new_articles),
        "total_count": len(fetched),
        "baseline_initialized": not initialized,
        "scope_start": scope_start,
        "scope_end": scope_end,
        "source_mode": source_mode,
        "articles": fetched,
        "new_dois": [article["doi"] for article in display_new_articles],
    }
    state = {
        "initialized": True,
        "scope_version": SCOPE_VERSION,
        "scope_start": scope_start,
        "checked_at": checked_at,
        "seen_dois": combined_seen,
    }

    atomic_write(ARTICLES_PATH, json.dumps(output, ensure_ascii=False, indent=2) + "\n")
    atomic_write(STATE_PATH, json.dumps(state, ensure_ascii=False, indent=2) + "\n")
    atomic_write(
        ISSUE_BODY_PATH,
        issue_markdown(detected_new_articles, checked_at) if detected_new_articles else "",
    )

    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a", encoding="utf-8") as handle:
            handle.write(f"new_count={len(detected_new_articles)}\n")
            handle.write(f"checked_date={datetime.now(SEOUL).date().isoformat()}\n")
    print(
        f"Checked {len(fetched)} records published from {scope_start} through {scope_end}; "
        f"found {len(detected_new_articles)} new DOI(s)."
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", type=Path, help="Use a local Crossref response for testing")
    parser.add_argument("--rows", type=int, default=1000)
    parser.add_argument("--acs-file", type=Path, help="Use an ACS DOI inventory as the inclusion authority")
    parser.add_argument("--science-file", type=Path, help="Include a verified Science Research Article inventory")
    parser.add_argument("--nature-file", type=Path, help="Use the Nature Communications Research Articles inventory")
    parser.add_argument("--jctc-file", type=Path, help="Use the ACS JCTC search inventory")
    parser.add_argument("--jcc-file", type=Path, help="Use the Wiley Journal of Computational Chemistry inventory")
    parser.add_argument("--angew-file", type=Path, help="Use the Wiley Angewandte inventory")
    args = parser.parse_args()
    try:
        publisher_files = {
            key: path
            for key, path in {
                "nature-communications": args.nature_file,
                "jctc": args.jctc_file,
                "journal-of-computational-chemistry": args.jcc_file,
                "angewandte": args.angew_file,
            }.items()
            if path is not None
        }
        return update(args.fixture, args.rows, args.acs_file, args.science_file, publisher_files)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        print(f"Update failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
