import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(ROOT, "data", "acs_articles.json");
const CUTOFF = "2025-01-01";
const PORT = 47821;
const PROFILE_DIR = process.env.ACS_CHROME_PROFILE_DIR || "Profile 1";
const IDLE_TIMEOUT_MS = Number(process.env.PUBLISHER_IDLE_TIMEOUT_MS || 180_000);
const URL = "https://pubs.acs.org/jacsat/search-results?sort=Date+-+Newest+First&f_JournalID=1000059&fl_SiteID=1000113&qb={%22q%22:%22%22}&page=1#jacs-auto";
let lastActivityAt = Date.now();

function normalizeDoi(value) {
  const match = String(value || "").toLowerCase().match(/10\.1021\/jacs\.[^?#/]+/);
  return match ? match[0].replace(/[).,;]+$/, "") : "";
}

async function loadExistingPayload() {
  try {
    return JSON.parse(await fs.readFile(OUTPUT, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function loadExisting() {
  const payload = await loadExistingPayload();
  return Array.isArray(payload.articles) ? payload.articles : [];
}

function json(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  response.end(JSON.stringify(payload));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 10_000_000) throw new Error("Collection payload is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = http.createServer(async (request, response) => {
  try {
    lastActivityAt = Date.now();
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      response.end();
      return;
    }
    if (request.method === "GET" && request.url === "/baseline") {
      const existingPayload = await loadExistingPayload();
      const existing = Array.isArray(existingPayload.articles) ? existingPayload.articles : [];
      json(response, 200, {
        known_dois: existing.map((item) => normalizeDoi(item.doi)).filter(Boolean),
        force_baseline: existingPayload.scope_start !== CUTOFF || existingPayload.backfill_complete !== true,
      });
      return;
    }
    if (request.method === "GET" && request.url === "/heartbeat") {
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && request.url === "/cancel") {
      json(response, 200, { cancelled: true });
      clearInterval(idleTimer);
      setTimeout(() => server.close(), 250);
      return;
    }
    if (request.method === "POST" && request.url === "/complete") {
      const body = await readBody(request);
      const incoming = Array.isArray(body.articles) ? body.articles : [];
      const existing = await loadExisting();
      const byDoi = new Map();
      for (const item of [...existing, ...incoming]) {
        const doi = normalizeDoi(item.doi);
        const publishedDate = String(item.published_date || "");
        if (!doi || publishedDate < CUTOFF) continue;
        byDoi.set(doi, { doi, title: String(item.title || doi).trim(), published_date: publishedDate, url: `https://doi.org/${doi}` });
      }
      const articles = [...byDoi.values()].sort((a, b) => b.published_date.localeCompare(a.published_date) || b.doi.localeCompare(a.doi));
      const incoming2025Dates = incoming
        .map((item) => String(item.published_date || ""))
        .filter((publishedDate) => publishedDate.startsWith("2025-"))
        .sort();
      const earliest2025 = incoming2025Dates[0] || "";
      const latest2025 = incoming2025Dates.at(-1) || "";
      if (body.mode === "baseline" && (body.reason !== "last-page" || earliest2025 > "2025-01-31" || latest2025 < "2025-12-01")) {
        throw new Error(`JACS 2025 date coverage is incomplete: ${earliest2025 || "missing"} through ${latest2025 || "missing"}`);
      }
      const payload = {
        source: "ACS JACS search results collected by the local Chrome extension",
        collected_at: new Date().toISOString(),
        scope_start: CUTOFF,
        scope_end: "2026-01-01",
        backfill_complete: true,
        article_count: articles.length,
        articles,
      };
      const temporary = `${OUTPUT}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await fs.rename(temporary, OUTPUT);
      json(response, 200, { article_count: articles.length });
      clearInterval(idleTimer);
      setTimeout(() => server.close(), 1000);
      return;
    }
    json(response, 404, { error: "Not found" });
  } catch (error) {
    json(response, 400, { error: error.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`JACS local receiver is listening on http://127.0.0.1:${PORT}`);
  console.log("Open chrome://extensions, enable Developer mode, and load the repository's extension folder once.");
  console.log("Then click 'JACS 수집 시작' on the ACS search page.");
  const chrome = path.join(process.env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe");
  console.log(`Opening Chrome profile: ${PROFILE_DIR}`);
  const child = spawn(chrome, [`--profile-directory=${PROFILE_DIR}`, "--new-window", URL], { detached: true, stdio: "ignore" });
  child.unref();
});

const idleTimer = setInterval(() => {
  if (Date.now() - lastActivityAt < IDLE_TIMEOUT_MS) return;
  console.warn(`JACS collector received no data for ${Math.round(IDLE_TIMEOUT_MS / 1000)} seconds; preserving the existing inventory and continuing.`);
  clearInterval(idleTimer);
  server.close();
  server.closeAllConnections?.();
  setTimeout(() => process.exit(0), 1000);
}, 15_000);

server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
