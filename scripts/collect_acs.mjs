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
const CHALLENGE_PATTERN = /unusual traffic|not a robot|security verification|malicious bots|verifying|access denied|forbidden|captcha|verify you are human/i;

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
  const dayFirst = text.match(/\b\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+20\d{2}\b/i);
  const valueToParse = named?.[0] || dayFirst?.[0];
  if (!valueToParse) return null;
  const parsed = new Date(`${valueToParse} 00:00:00 UTC`);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString().slice(0, 10);
}

async function extractPage(page) {
  return page.locator(".sr-list.content-type-journal-articles").evaluateAll((items) => {
    const rows = [];
    for (const item of items) {
      const anchors = [...item.querySelectorAll('a[href*="/doi/"]')];
      const anchor = anchors.find((node) => /10\.1021\/jacs\./i.test(node.href)) || anchors[0];
      const href = anchor?.href || "";
      const match = href.match(/(?:\/doi\/|\/article\/doi\/)(10\.1021\/jacs\.[^?#/]+)/i);
      if (!match) continue;
      const titleNode = item.querySelector(".sri-title h4 a, .sri-title a, h4 a") || anchor;
      const dateNode = item.querySelector(".sri-date.al-pub-date, .sri-date");
      rows.push({
        doi: match[1],
        title: (titleNode.textContent || anchor.textContent || "").replace(/\s+/g, " ").trim(),
        text: (dateNode?.textContent || item.innerText || "").replace(/\s+/g, " ").trim(),
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

async function waitForSearchResults(page, pageNumber) {
  const challengeText = `${await page.title()}\n${await page.locator("body").innerText().catch(() => "")}`;
  if (!CHALLENGE_PATTERN.test(challengeText)) {
    await waitForCompleteResultPage(page, pageNumber);
    return;
  }

  console.log("ACS is requesting human verification in Chrome.");
  console.log("Complete the checkbox once. Chrome will return to the ACS results automatically.");
  await page.locator('a[href*="/doi/"]').first().waitFor({ state: "attached", timeout: 1800000 }).catch(async () => {
    await saveDiagnostics(page, `blocked-page-${pageNumber}`);
    throw new Error("ACS human verification was not completed within 30 minutes. No data were changed.");
  });
  await waitForCompleteResultPage(page, pageNumber);
}

async function openJournalArticleResults(page) {
  const url = `${BASE_URL}&page=1`;
  console.log(`Opening ACS search through its normal entry page: ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(3000);

  const articleFilter = page.locator('input.chkSelect[data-redirect-url*="f_ContentType=Journal+Articles"]').first();
  await articleFilter.waitFor({ state: "attached", timeout: 1800000 }).catch(async () => {
    await saveDiagnostics(page, "blocked-entry-page");
    throw new Error("The normal ACS search entry page did not become available within 30 minutes.");
  });

  console.log("Selecting the Journal Articles filter through the ACS page.");
  const previousUrl = page.url();
  await articleFilter.click();
  await page.waitForFunction((oldUrl) => location.href !== oldUrl, previousUrl, { timeout: 90000 });
  await page.waitForTimeout(3000);
}

async function openNextResultsPage(page, nextPageNumber) {
  const next = page.locator("button.sr-nav-next").first();
  await next.waitFor({ state: "visible", timeout: 30000 });
  const previousUrl = page.url();
  console.log(`Opening ACS page ${nextPageNumber} with the on-page Next button.`);
  await next.click();
  await page.waitForFunction((oldUrl) => location.href !== oldUrl, previousUrl, { timeout: 90000 });
  await page.waitForTimeout(3000);
}

async function waitForCompleteResultPage(page, pageNumber) {
  await page.waitForFunction(() => {
    const dois = new Set();
    for (const item of document.querySelectorAll(".sr-list.content-type-journal-articles")) {
      const match = [...item.querySelectorAll('a[href*="/doi/"]')]
        .map((anchor) => anchor.href.match(/10\.1021\/jacs\.[^?#/]+/i))
        .find(Boolean);
      if (match) dois.add(match[0].toLowerCase());
    }
    return dois.size >= 20;
  }, null, { timeout: 60000 }).catch(async () => {
    await saveDiagnostics(page, `incomplete-page-${pageNumber}`);
    throw new Error(`ACS page ${pageNumber} did not finish rendering a complete result set.`);
  });
  await page.waitForTimeout(2000);
}

async function loadBaseline() {
  try {
    const payload = JSON.parse(await fs.readFile(OUTPUT, "utf8"));
    const articles = Array.isArray(payload.articles) ? payload.articles : [];
    const byDoi = new Map();
    for (const item of articles) {
      const doi = normalizeDoi(item.doi);
      const publishedDate = isoDate(item.published_date);
      if (!doi.startsWith("10.1021/jacs.") || !publishedDate || publishedDate < CUTOFF) continue;
      byDoi.set(doi, {
        doi,
        title: String(item.title || doi).replace(/\s+/g, " ").trim(),
        published_date: publishedDate,
        url: `https://doi.org/${doi}`,
      });
    }
    if (byDoi.size) return { byDoi, source: OUTPUT };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { byDoi: new Map(), source: null };
}

async function main() {
  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  console.log("Using the isolated ACS Chrome profile.");
  console.log("Sign in to sungsikeom@hanyang.ac.kr in this window if Chrome asks.");
  const context = await chromium.launchPersistentContext(PROFILE, {
    channel: "chrome",
    headless: false,
    ignoreDefaultArgs: ["--no-sandbox", "--disable-sync"],
    viewport: { width: 1400, height: 1000 },
    locale: "en-US",
  });
  const page = context.pages()[0] || await context.newPage();
  const baseline = await loadBaseline();
  const knownDois = new Set(baseline.byDoi.keys());
  const newByDoi = new Map();
  let reachedCutoff = false;
  let reachedKnownDoi = false;
  let previousSignature = "";

  if (knownDois.size) {
    console.log(`Incremental mode: loaded ${knownDois.size} ACS-verified 2026 DOI(s) from ${baseline.source}.`);
  } else {
    console.log(`Baseline mode: collecting every ACS result back to ${CUTOFF}.`);
  }

  try {
    await openJournalArticleResults(page);
    for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
      console.log(`Reading ACS page ${pageNumber}: ${page.url()}`);

      await waitForSearchResults(page, pageNumber);

      const title = await page.title();
      const body = await page.locator("body").innerText().catch(() => "");
      if (CHALLENGE_PATTERN.test(`${title}\n${body}`)) {
        await saveDiagnostics(page, `blocked-page-${pageNumber}`);
        throw new Error("ACS requested human verification or denied access. No data were changed.");
      }

      const rawRows = await extractPage(page);
      const pageByDoi = new Map();
      for (const row of rawRows) {
        const doi = normalizeDoi(row.doi);
        if (!doi.startsWith("10.1021/jacs.")) continue;
        const candidate = {
          doi,
          title: row.title,
          published_date: isoDate(row.text),
          url: `https://doi.org/${doi}`,
        };
        const current = pageByDoi.get(doi);
        const score = (value) => (value.published_date ? 4 : 0) + (value.title && value.title !== value.doi ? 2 : 0) + value.title.length / 1000;
        if (!current || score(candidate) > score(current)) pageByDoi.set(doi, candidate);
      }
      const rows = [...pageByDoi.values()];

      const signature = rows.map((row) => row.doi).sort().join("|");
      if (!rows.length || signature === previousSignature) {
        await saveDiagnostics(page, `unexpected-page-${pageNumber}`);
        throw new Error(`ACS page ${pageNumber} was empty or repeated before the cutoff was reached.`);
      }
      previousSignature = signature;

      for (const row of rows) {
        if (row.published_date && row.published_date < CUTOFF) {
          reachedCutoff = true;
          break;
        }
        if (knownDois.has(row.doi)) {
          reachedKnownDoi = true;
          break;
        }
        if (!newByDoi.has(row.doi)) newByDoi.set(row.doi, row);
      }
      console.log(`  ${rows.length} unique DOI(s), ${newByDoi.size} new`);
      if (reachedCutoff || reachedKnownDoi) break;
      await page.waitForTimeout(4000 + Math.floor(Math.random() * 4000));
      await openNextResultsPage(page, pageNumber + 1);
    }

    if (!reachedCutoff && !reachedKnownDoi) {
      throw new Error(`Did not reach an existing DOI or the ${CUTOFF} boundary within ${MAX_PAGES} pages.`);
    }
    const combined = new Map(baseline.byDoi);
    for (const [doi, article] of newByDoi) combined.set(doi, article);
    const articles = [...combined.values()].sort((a, b) =>
      String(b.published_date || "").localeCompare(String(a.published_date || "")) || b.doi.localeCompare(a.doi));
    if (articles.length < 1000) throw new Error(`Only ${articles.length} ACS articles were found; refusing an implausibly small replacement.`);

    const payload = {
      source: "ACS JACS search results incrementally viewed in local Google Chrome",
      collected_at: new Date().toISOString(),
      scope_start: CUTOFF,
      article_count: articles.length,
      articles,
    };
    const temporary = `${OUTPUT}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await fs.rename(temporary, OUTPUT);
    console.log(`Saved ${articles.length} ACS DOI(s), including ${newByDoi.size} new DOI(s), to ${OUTPUT}`);
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
