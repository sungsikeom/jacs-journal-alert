#!/usr/bin/env python3
"""Fetch recent journal metadata from Crossref and update the static site data."""

from __future__ import annotations

import argparse
import html
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
ARTICLES_PATH = DATA_DIR / "articles.json"
STATE_PATH = DATA_DIR / "seen_dois.json"
ISSUE_BODY_PATH = DATA_DIR / "new_articles.md"
SEOUL = timezone(timedelta(hours=9))

JOURNALS = [
    {
        "key": "jacs",
        "name": "Journal of the American Chemical Society",
        "short_name": "JACS",
        "issn": "0002-7863",
    }
]


def normalize_doi(value: str) -> str:
    value = value.strip().lower()
    for prefix in ("https://doi.org/", "http://doi.org/", "doi:"):
        if value.startswith(prefix):
            value = value[len(prefix) :]
    return value


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


def crossref_url(issn: str, lookback_days: int, rows: int) -> str:
    start = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).date().isoformat()
    params = {
        "filter": f"from-index-date:{start},type:journal-article",
        "select": "DOI,title,URL,published-online,published-print,published,issued,indexed",
        "rows": str(rows),
        "sort": "indexed",
        "order": "desc",
        "mailto": os.environ.get("CROSSREF_MAILTO", "journal-alert@example.com"),
    }
    return f"https://api.crossref.org/journals/{issn}/works?{urllib.parse.urlencode(params)}"


def fetch_json(url: str) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "JACSJournalAlert/1.0 (mailto:journal-alert@example.com)",
        },
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        return json.load(response)


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
    title = html.unescape(str(titles[0])).strip() if titles else ""
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
        key=lambda x: (x.get("indexed_at") or "", x["doi"]),
        reverse=True,
    )


def issue_markdown(new_articles: list[dict[str, Any]], checked_at: str) -> str:
    lines = [f"## JACS 신규 논문 {len(new_articles)}편", "", f"확인 시각: {checked_at}", ""]
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


def update(fixture: Path | None, lookback_days: int, rows: int) -> int:
    checked_at = datetime.now(SEOUL).isoformat(timespec="seconds")
    old_state = load_json(STATE_PATH, {})
    initialized = bool(old_state.get("initialized"))
    seen = {normalize_doi(value) for value in old_state.get("seen_dois", [])}
    fetched: list[dict[str, Any]] = []

    fixture_payload = load_json(fixture, {}) if fixture else None
    for journal in JOURNALS:
        payload = fixture_payload if fixture_payload is not None else fetch_json(
            crossref_url(journal["issn"], lookback_days, rows)
        )
        for item in payload.get("message", {}).get("items", []):
            article = article_from_item(item, journal)
            if article:
                fetched.append(article)

    fetched = deduplicate(fetched)
    new_articles = [article for article in fetched if article["doi"] not in seen] if initialized else []
    new_dois = {article["doi"] for article in fetched}
    combined_seen = sorted(seen | new_dois)

    previous_articles = load_json(ARTICLES_PATH, {}).get("articles", [])
    merged = deduplicate(fetched + previous_articles)[:500]
    output = {
        "checked_at": checked_at,
        "journal_count": len(JOURNALS),
        "new_count": len(new_articles),
        "baseline_initialized": not initialized,
        "articles": merged,
        "new_dois": [article["doi"] for article in new_articles],
    }
    state = {"initialized": True, "checked_at": checked_at, "seen_dois": combined_seen}

    atomic_write(ARTICLES_PATH, json.dumps(output, ensure_ascii=False, indent=2) + "\n")
    atomic_write(STATE_PATH, json.dumps(state, ensure_ascii=False, indent=2) + "\n")
    atomic_write(ISSUE_BODY_PATH, issue_markdown(new_articles, checked_at) if new_articles else "")

    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a", encoding="utf-8") as handle:
            handle.write(f"new_count={len(new_articles)}\n")
            handle.write(f"checked_date={datetime.now(SEOUL).date().isoformat()}\n")
    print(f"Checked {len(fetched)} recent records; found {len(new_articles)} new DOI(s).")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", type=Path, help="Use a local Crossref response for testing")
    parser.add_argument("--lookback-days", type=int, default=14)
    parser.add_argument("--rows", type=int, default=1000)
    args = parser.parse_args()
    try:
        return update(args.fixture, args.lookback_days, args.rows)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        print(f"Update failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
