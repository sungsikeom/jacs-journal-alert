import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(ROOT, "data", "nature_machine_intelligence_articles.json");
const PROFILE = process.env.NATURE_MACHINE_INTELLIGENCE_CHROME_PROFILE_DIR
  ? path.resolve(process.env.NATURE_MACHINE_INTELLIGENCE_CHROME_PROFILE_DIR)
  : path.join(os.tmpdir(), "journal-pulse-nature-machine-intelligence-profile");
const BASE_URL = "https://www.nature.com/natmachintell/research-articles";
const SCOPE_START = "2026-01-01";
const DOI_PREFIX = "10.1038/s42256-";
const PAGE_SIZE = 20;
const MINIMUM_BASELINE = 50;
const forceBaseline = process.argv.includes("--fresh");

function normalizeDoi(value) {
  const article = String(value || "").match(/\/articles\/(s42256-[^/?#]+)/i);
  if (article) return `10.1038/${article[1].toLowerCase()}`;
  const doi = String(value || "").toLowerCase().match(/10\.1038\/s42256-[^?#\s]+/i);
  return doi ? doi[0].replace(/[).,;]+$/, "") : "";
}

function parseDate(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const iso = text.match(/\b20\d{2}-\d{2}-\d{2}\b/);
  if (iso) return iso[0];
  const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const match = text.match(/\b(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(20\d{2})\b/i);
  if (!match) return null;
  return `${match[3]}-${String(months[match[2].slice(0, 3).toLowerCase()]).padStart(2, "0")}-${String(match[1]).padStart(2, "0")}`;
}

async function existingArticles() {
  try {
    const payload = JSON.parse(await fs.readFile(OUTPUT, "utf8"));
    return Array.isArray(payload.articles) ? payload.articles : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function readRows(page) {
  return page.locator("li.app-article-list-row__item").evaluateAll((items) => items.map((item) => {
    const anchor = [...item.querySelectorAll('a[href*="/articles/s42256-"]')]
      .find((candidate) => /\/articles\/s42256-/i.test(candidate.href || ""));
    const titleNode = item.querySelector("h2 a, h3 a, h4 a") || anchor;
    const dateNode = item.querySelector("time, .c-meta__item time");
    return {
      href: anchor?.href || "",
      title: String(titleNode?.textContent || "").replace(/\s+/g, " ").trim(),
      date: dateNode?.getAttribute("datetime") || dateNode?.textContent || item.textContent || "",
    };
  }));
}

async function stablePageRows(page, expectedCount) {
  let best = [];
  let previousSignature = "";
  let stable = 0;
  for (let attempt = 0; attempt < 45; attempt += 1) {
    const rawRows = await readRows(page);
    const byDoi = new Map();
    for (const row of rawRows) {
      const doi = normalizeDoi(row.href);
      const publishedDate = parseDate(row.date);
      if (!doi.startsWith(DOI_PREFIX) || !row.title || !publishedDate) continue;
      byDoi.set(doi, { doi, title: row.title, published_date: publishedDate, url: `https://doi.org/${doi}` });
    }
    const rows = [...byDoi.values()];
    if (rows.length > best.length) best = rows;
    const signature = rows.map((row) => `${row.doi}|${row.title}|${row.published_date}`).join("\n");
    stable = signature && signature === previousSignature ? stable + 1 : 0;
    previousSignature = signature;
    if (rows.length === expectedCount && stable >= 2) return rows;
    await page.waitForTimeout(1000);
  }
  throw new Error(`Nature Machine Intelligence page did not fully load: expected ${expectedCount}, found ${best.length}`);
}

async function openPage(page, pageNumber) {
  const url = new URL(BASE_URL);
  url.searchParams.set("year", "2026");
  url.searchParams.set("page", String(pageNumber));
  await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.locator("li.app-article-list-row__item").first().waitFor({ state: "attached", timeout: 120_000 });
}

async function run() {
  const existing = forceBaseline ? [] : await existingArticles();
  const known = new Set(existing.map((article) => normalizeDoi(article.doi)).filter(Boolean));
  const collected = new Map();
  const chrome = path.join(process.env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe");
  const context = await chromium.launchPersistentContext(PROFILE, {
    executablePath: chrome,
    headless: process.env.NATURE_HEADLESS !== "0",
    viewport: { width: 1400, height: 1000 },
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    console.log(`Opening Nature Machine Intelligence 2026 research articles in ${process.env.NATURE_HEADLESS === "0" ? "visible" : "headless"} Chrome`);
    await openPage(page, 1);
    const bodyText = await page.locator("body").innerText();
    const totalMatch = bodyText.match(/\b2026\s*\(([\d,]+)\)/);
    const officialTotal = Number(String(totalMatch?.[1] || "").replace(/,/g, ""));
    if (!Number.isInteger(officialTotal) || officialTotal < MINIMUM_BASELINE) {
      throw new Error(`Nature Machine Intelligence 2026 total count was not found or is implausible: ${officialTotal || "unknown"}`);
    }
    const totalPages = Math.ceil(officialTotal / PAGE_SIZE);
    let stoppedOnKnown = false;
    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
      if (pageNumber > 1) await openPage(page, pageNumber);
      const expectedCount = Math.min(PAGE_SIZE, officialTotal - ((pageNumber - 1) * PAGE_SIZE));
      const rows = await stablePageRows(page, expectedCount);
      let knownOnPage = false;
      for (const article of rows) {
        if (article.published_date < SCOPE_START) throw new Error(`Nature Machine Intelligence year filter returned an out-of-scope date: ${article.published_date}`);
        if (known.has(article.doi)) knownOnPage = true;
        collected.set(article.doi, article);
      }
      console.log(`${pageNumber}/${totalPages} page · ${rows.length} articles · ${collected.size} unique`);
      if (known.size && knownOnPage) {
        stoppedOnKnown = true;
        break;
      }
      await page.waitForTimeout(2500 + Math.floor(Math.random() * 1500));
    }

    const byDoi = new Map();
    for (const article of [...existing, ...collected.values()]) {
      const doi = normalizeDoi(article.doi);
      if (!doi.startsWith(DOI_PREFIX) || String(article.published_date || "") < SCOPE_START) continue;
      byDoi.set(doi, { doi, title: String(article.title || doi).replace(/\s+/g, " ").trim(), published_date: article.published_date, url: `https://doi.org/${doi}` });
    }
    const articles = [...byDoi.values()].sort((a, b) => b.published_date.localeCompare(a.published_date) || b.doi.localeCompare(a.doi));
    if (!known.size && articles.length !== officialTotal) {
      throw new Error(`Nature Machine Intelligence baseline validation failed: expected ${officialTotal}, collected ${articles.length}`);
    }
    if (articles.length < MINIMUM_BASELINE) throw new Error(`Only ${articles.length} Nature Machine Intelligence articles were collected`);
    const payload = {
      source: "Nature Machine Intelligence Research Articles · 2026 filter",
      collected_at: new Date().toISOString(),
      scope_start: SCOPE_START,
      official_total: officialTotal,
      collection_mode: known.size ? "incremental" : "baseline",
      stopped_on_known_doi: stoppedOnKnown,
      article_count: articles.length,
      articles,
    };
    const temporary = `${OUTPUT}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await fs.rename(temporary, OUTPUT);
    console.log(`Saved ${articles.length} Nature Machine Intelligence articles to ${OUTPUT}`);
  } finally {
    await context.close();
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
