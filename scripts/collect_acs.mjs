import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(ROOT, "data", "acs_articles.json");
const DIAGNOSTICS = path.join(ROOT, "diagnostics");
const PROFILE = path.join(ROOT, ".chrome-profile-acs");
const CUTOFF = "2026-01-01";
const BASE_URL = "https://pubs.acs.org/jacsat/search-results?sort=Date+-+Newest+First&f_JournalID=1000059&fl_SiteID=1000113&qb={%22q%22:%22%22}";
const MAX_PAGES = 200;

function normalizeDoi(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "")
    .replace(/^doi:\s*/, "")
    .replace(/[?#].*$/, "")
    .replace(/[).,;]+$/, "");
}

function isoDate(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return iso[0];
  const named = text.match(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},\s+20\d{2}\b/i);
  if (!named) return null;
  const parsed = new Date(`${named[0]} 00:00:00 UTC`);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString().slice(0, 10);
}

async function extractPage(page) {
  return page.locator('a[href*="/doi/"]').evaluateAll((anchors) => {
    const rows = [];
    for (const anchor of anchors) {
      const href = anchor.href || "";
      const match = href.match(/\/doi\/(?:abs|full|pdf|epdf)?\/?(10\.1021\/jacs\.[^?#/]+)/i);
      if (!match) continue;
      let root = anchor;
      for (let i = 0; i < 8 && root.parentElement; i += 1) {
        root = root.parentElement;
        const body = (root.innerText || "").trim();
        if (body.length >= 40 && /20\d{2}/.test(body)) break;
      }
      const titleNode = root.querySelector('h2, h3, h4, [class*="title" i]') || anchor;
      rows.push({
        doi: match[1],
        title: (titleNode.textContent || anchor.textContent || "").replace(/\s+/g, " ").trim(),
        text: (root.innerText || "").replace(/\s+/g, " ").trim(),
        url: href,
      });
    }
    return rows;
  });
}

async function saveDiagnostics(page, label) {
  await fs.mkdir(DIAGNOSTICS, { recursive: true });
  await page.screenshot({ path: path.join(DIAGNOSTICS, `${label}.png`), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(DIAGNOSTICS, `${label}.html`), await page.content(), "utf8").catch(() => {});
}

async function main() {
  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  const context = await chromium.launchPersistentContext(PROFILE, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1400, height: 1000 },
    locale: "en-US",
  });
  const page = context.pages()[0] || await context.newPage();
  const byDoi = new Map();
  let reachedCutoff = false;
  let previousSignature = "";

  try {
    for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
      const url = `${BASE_URL}&page=${pageNumber}`;
      console.log(`ACS page ${pageNumber}: ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.waitForTimeout(2500);

      const title = await page.title();
      const body = await page.locator("body").innerText().catch(() => "");
      if (/access denied|forbidden|captcha|verify you are human/i.test(`${title}\n${body}`)) {
        await saveDiagnostics(page, `blocked-page-${pageNumber}`);
        throw new Error("ACS requested human verification or denied access. No data were changed.");
      }

      const rawRows = await extractPage(page);
      const rows = rawRows.map((row) => ({
        doi: normalizeDoi(row.doi),
        title: row.title,
        published_date: isoDate(row.text),
        url: `https://doi.org/${normalizeDoi(row.doi)}`,
      })).filter((row) => row.doi.startsWith("10.1021/jacs."));

      const signature = rows.map((row) => row.doi).sort().join("|");
      if (!rows.length || signature === previousSignature) {
        await saveDiagnostics(page, `unexpected-page-${pageNumber}`);
        throw new Error(`ACS page ${pageNumber} was empty or repeated before the cutoff was reached.`);
      }
      previousSignature = signature;

      for (const row of rows) {
        if (row.published_date && row.published_date < CUTOFF) reachedCutoff = true;
        if ((!row.published_date || row.published_date >= CUTOFF) && !byDoi.has(row.doi)) byDoi.set(row.doi, row);
      }
      console.log(`  ${rows.length} DOI(s), total ${byDoi.size}`);
      if (reachedCutoff) break;
      await page.waitForTimeout(1500 + Math.floor(Math.random() * 1500));
    }

    if (!reachedCutoff) throw new Error(`Did not reach the ${CUTOFF} boundary within ${MAX_PAGES} pages.`);
    const articles = [...byDoi.values()].sort((a, b) =>
      String(b.published_date || "").localeCompare(String(a.published_date || "")) || b.doi.localeCompare(a.doi));
    if (articles.length < 1000) throw new Error(`Only ${articles.length} ACS articles were found; refusing an implausibly small replacement.`);

    const payload = {
      source: "ACS JACS search results viewed in local Google Chrome",
      collected_at: new Date().toISOString(),
      scope_start: CUTOFF,
      article_count: articles.length,
      articles,
    };
    const temporary = `${OUTPUT}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await fs.rename(temporary, OUTPUT);
    console.log(`Saved ${articles.length} ACS DOI(s) to ${OUTPUT}`);
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
