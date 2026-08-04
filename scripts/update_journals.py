#!/usr/bin/env python3
"""Build the JACS list from ACS search results, enriched by Crossref."""

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
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
ARTICLES_PATH = DATA_DIR / "articles.json"
STATE_PATH = DATA_DIR / "seen_dois.json"
ISSUE_BODY_PATH = DATA_DIR / "new_articles.md"
SEOUL = timezone(timedelta(hours=9))
SCOPE_START = "2026-01-01"
SCOPE_VERSION = 4
ACS_SEARCH_URL = "https://pubs.acs.org/jacsat/search-results"
JOURNAL = {
    "name": "Journal of the American Chemical Society",
    "short_name": "JACS",
    "issn": "0002-7863",
}
DOI_RE = re.compile(r"10\.1021/(?:acs\.)?jacs\.[A-Za-z0-9._;()/:+-]+", re.I)
DATE_PATTERNS = (
    re.compile(r"\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b"),
    re.compile(
        r"\b(?:Publication\s+Date\s*:?\s*)?"
        r"(January|February|March|April|May|June|July|August|September|October|November|December)"
        r"\s+(\d{1,2}),\s+(20\d{2})\b",
        re.I,
    ),
)
MONTHS = {name.lower(): index for index, name in enumerate(
    ("January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"), 1
)}


def normalize_doi(value: str) -> str:
    value = html.unescape(value).strip().lower().rstrip(".,;)]}")
    value = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", value)
    return value


def plain_text(fragment: str) -> str:
    fragment = re.sub(r"<(?:script|style)\b.*?</(?:script|style)>", " ", fragment, flags=re.I | re.S)
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", fragment)).split())


def find_date(text: str) -> str | None:
    match = DATE_PATTERNS[0].search(text)
    if match:
        try:
            return f"{int(match.group(1)):04d}-{int(match.group(2)):02d}-{int(match.group(3)):02d}"
        except ValueError:
            pass
    match = DATE_PATTERNS[1].search(text)
    if match:
        return f"{int(match.group(3)):04d}-{MONTHS[match.group(1).lower()]:02d}-{int(match.group(2)):02d}"
    return None


def first_crossref_date(item: dict[str, Any]) -> str | None:
    for key in ("published-online", "published-print", "published", "issued"):
        parts = item.get(key, {}).get("date-parts", [])
        if parts and parts[0]:
            values = list(parts[0]) + [1, 1]
            try:
                return f"{int(values[0]):04d}-{int(values[1]):02d}-{int(values[2]):02d}"
            except (TypeError, ValueError):
                continue
    return None


def request_text(url: str, label: str, attempts: int = 6) -> str:
    headers = {
        "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.8",
        "User-Agent": "Mozilla/5.0 (compatible; JACSJournalAlert/2.0; +https://github.com/sungsikeom/jacs-journal-alert)",
    }
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as response:
                return response.read().decode(response.headers.get_content_charset() or "utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            if exc.code not in (429, 403) and not 500 <= exc.code < 600:
                raise
            if attempt == attempts - 1:
                raise
            retry_after = exc.headers.get("Retry-After")
            try:
                delay = float(retry_after) if retry_after else min(60, 5 * (2**attempt))
            except ValueError:
                delay = min(60, 5 * (2**attempt))
            print(f"{label} returned HTTP {exc.code}; retrying in {delay:g} seconds.")
            time.sleep(delay)
        except urllib.error.URLError:
            if attempt == attempts - 1:
                raise
            time.sleep(min(60, 5 * (2**attempt)))
    raise RuntimeError(f"{label} request retry loop ended unexpectedly")


def fetch_json(url: str) -> dict[str, Any]:
    return json.loads(request_text(url, "Crossref"))


def crossref_url(start: str, end: str, rows: int, cursor: str) -> str:
    params = {
        "filter": f"from-pub-date:{start},until-pub-date:{end},type:journal-article",
        "select": "DOI,title,URL,published-online,published-print,published,issued,indexed",
        "rows": str(rows), "cursor": cursor, "sort": "published", "order": "desc",
        "mailto": os.environ.get("CROSSREF_MAILTO", "journal-alert@example.com"),
    }
    return f"https://api.crossref.org/journals/{JOURNAL['issn']}/works?{urllib.parse.urlencode(params)}"


def fetch_crossref(start: str, end: str, rows: int) -> dict[str, dict[str, Any]]:
    found: dict[str, dict[str, Any]] = {}
    cursor = "*"
    seen_pages: set[tuple[str, ...]] = set()
    while True:
        message = fetch_json(crossref_url(start, end, rows, cursor)).get("message", {})
        page = message.get("items", [])
        signature = tuple(normalize_doi(str(item.get("DOI", ""))) for item in page)
        if signature in seen_pages:
            raise RuntimeError("Crossref repeated a result page")
        seen_pages.add(signature)
        for item in page:
            doi = normalize_doi(str(item.get("DOI", "")))
            if doi:
                found[doi] = item
        next_cursor = message.get("next-cursor")
        if len(page) < rows or not next_cursor:
            return found
        cursor = str(next_cursor)


def acs_search_url(page: int) -> str:
    params = {
        "sort": "Date - Newest First", "f_JournalID": "1000059", "fl_SiteID": "1000113",
        "qb": '{"q":""}', "page": str(page),
    }
    return f"{ACS_SEARCH_URL}?{urllib.parse.urlencode(params)}"


def parse_acs_page(document: str) -> list[dict[str, Any]]:
    records: dict[str, dict[str, Any]] = {}
    for match in DOI_RE.finditer(html.unescape(document)):
        doi = normalize_doi(match.group(0))
        left = max(0, match.start() - 2500)
        right = min(len(document), match.end() + 2500)
        context = document[left:right]
        text = plain_text(context)
        record = records.setdefault(doi, {"doi": doi, "title": "", "published_date": None})
        record["published_date"] = record["published_date"] or find_date(text)
        candidates = []
        for anchor in re.findall(r"<a\b[^>]*>(.*?)</a>", context, flags=re.I | re.S):
            candidate = plain_text(anchor)
            if 12 <= len(candidate) <= 500 and "10.1021/" not in candidate.lower():
                candidates.append(candidate)
        if candidates:
            record["title"] = max((record["title"], *candidates), key=len)
    return list(records.values())


def fetch_acs(crossref: dict[str, dict[str, Any]], cutoff: str, max_pages: int) -> list[dict[str, Any]]:
    records: dict[str, dict[str, Any]] = {}
    seen_pages: set[tuple[str, ...]] = set()
    reached_cutoff = False
    for page_number in range(1, max_pages + 1):
        document = request_text(acs_search_url(page_number), "ACS")
        page = parse_acs_page(document)
        signature = tuple(sorted(item["doi"] for item in page))
        if not signature:
            raise RuntimeError(f"ACS page {page_number} contained no recognizable JACS DOI")
        if signature in seen_pages:
            raise RuntimeError(f"ACS repeated result page {page_number}")
        seen_pages.add(signature)
        page_dates = []
        for item in page:
            metadata = crossref.get(item["doi"], {})
            item["published_date"] = first_crossref_date(metadata) or item.get("published_date")
            titles = metadata.get("title") or []
            if titles:
                item["title"] = html.unescape(str(titles[0])).strip()
            records[item["doi"]] = item
            if item.get("published_date"):
                page_dates.append(item["published_date"])
        print(f"ACS page {page_number}: {len(page)} DOI(s)")
        if page_dates and max(page_dates) < cutoff:
            reached_cutoff = True
            break
        time.sleep(1)
    if not reached_cutoff:
        raise RuntimeError(f"ACS pagination did not reach dates before {cutoff} within {max_pages} pages")
    scoped = [item for item in records.values() if item.get("published_date") and item["published_date"] >= cutoff]
    if len(scoped) < 100:
        raise RuntimeError(f"ACS completeness guard rejected an implausibly small result: {len(scoped)} DOI(s)")
    return scoped


def load_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else fallback
    except (json.JSONDecodeError, OSError):
        return fallback


def atomic_write(path: Path, payload: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(payload, encoding="utf-8")
    temporary.replace(path)


def issue_markdown(new_articles: list[dict[str, Any]], checked_at: str) -> str:
    lines = [f"## JACS 신규 논문 {len(new_articles)}편", "", f"확인 시각: {checked_at}", ""]
    for article in new_articles:
        lines.extend([f"### {article['title']}", "", f"DOI: [{article['doi']}]({article['url']})", ""])
    return "\n".join(lines).rstrip() + "\n"


def update(fixture: Path | None, rows: int, max_pages: int) -> int:
    now = datetime.now(SEOUL)
    checked_at, scope_end = now.isoformat(timespec="seconds"), now.date().isoformat()
    old_state = load_json(STATE_PATH, {})
    initialized = bool(old_state.get("initialized")) and old_state.get("scope_version") == SCOPE_VERSION
    seen = {normalize_doi(value) for value in old_state.get("seen_dois", [])}
    if fixture:
        fixture_payload = load_json(fixture, {})
        crossref = {normalize_doi(str(item.get("DOI", ""))): item for item in fixture_payload.get("message", {}).get("items", [])}
        acs_records = []
        for doi, item in crossref.items():
            titles = item.get("title") or []
            acs_records.append({"doi": doi, "title": html.unescape(str(titles[0])) if titles else doi, "published_date": first_crossref_date(item)})
    else:
        crossref = fetch_crossref(SCOPE_START, scope_end, rows)
        acs_records = fetch_acs(crossref, SCOPE_START, max_pages)
    articles = []
    for item in acs_records:
        date = item.get("published_date")
        if not date or not (SCOPE_START <= date <= scope_end):
            continue
        doi = item["doi"]
        metadata = crossref.get(doi, {})
        articles.append({
            "doi": doi, "title": item.get("title") or doi,
            "journal": JOURNAL["name"], "journal_short": JOURNAL["short_name"],
            "published_date": date, "indexed_at": metadata.get("indexed", {}).get("date-time"),
            "url": f"https://doi.org/{urllib.parse.quote(doi, safe='/()')}", "source": "ACS",
        })
    articles = sorted({item["doi"]: item for item in articles}.values(), key=lambda x: (x["published_date"], x["doi"]), reverse=True)
    current_dois = {item["doi"] for item in articles}
    new_articles = [item for item in articles if item["doi"] not in seen] if initialized else []
    combined_seen = sorted(seen | current_dois) if initialized else sorted(current_dois)
    output = {
        "checked_at": checked_at, "journal_count": 1, "new_count": len(new_articles),
        "baseline_initialized": not initialized, "scope_start": SCOPE_START, "scope_end": scope_end,
        "primary_source": "ACS Publications", "crossref_count": len(crossref),
        "articles": articles, "new_dois": [item["doi"] for item in new_articles],
    }
    state = {"initialized": True, "scope_version": SCOPE_VERSION, "scope_start": SCOPE_START,
             "checked_at": checked_at, "seen_dois": combined_seen}
    atomic_write(ARTICLES_PATH, json.dumps(output, ensure_ascii=False, indent=2) + "\n")
    atomic_write(STATE_PATH, json.dumps(state, ensure_ascii=False, indent=2) + "\n")
    atomic_write(ISSUE_BODY_PATH, issue_markdown(new_articles, checked_at) if new_articles else "")
    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a", encoding="utf-8") as handle:
            handle.write(f"new_count={len(new_articles)}\nchecked_date={scope_end}\n")
    print(f"Verified {len(articles)} ACS JACS DOI(s) from {SCOPE_START} through {scope_end}; {len(new_articles)} new.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", type=Path)
    parser.add_argument("--rows", type=int, default=1000)
    parser.add_argument("--max-pages", type=int, default=500)
    args = parser.parse_args()
    try:
        return update(args.fixture, args.rows, args.max_pages)
    except Exception as exc:
        print(f"Update failed without replacing existing site data: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
