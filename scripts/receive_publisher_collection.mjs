import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CUTOFF = "2026-01-01";
const PORT = 47823;
const PROFILE_DIR = process.env.PUBLISHER_CHROME_PROFILE_DIR || "Profile 1";
const configs = {
  nature: { output: "nature_communications_articles.json", minimum: 5000, url: "https://www.nature.com/ncomms/research-articles#publisher-auto" },
  jctc: { output: "jctc_articles.json", minimum: 300, url: "https://pubs.acs.org/jctcce/search-results?q=&f_JournalID=1000064&fl_SiteID=1000123&page=1&qb=%7b%22q%22%3a%22%22%7d&sort=Date+-+Newest+First#publisher-auto" },
  jcc: { output: "jcc_articles.json", minimum: 100, url: "https://onlinelibrary.wiley.com/action/doSearch?SeriesKey=1096987x&sortBy=Newest#publisher-auto" },
  angew: { output: "angew_articles.json", minimum: 1000, url: "https://onlinelibrary.wiley.com/action/doSearch?SeriesKey=15213773&sortBy=Newest#publisher-auto" },
};

const key = process.argv[2];
const config = configs[key];
if (!config) {
  console.error(`Usage: node scripts/receive_publisher_collection.mjs ${Object.keys(configs).join("|")}`);
  process.exit(2);
}
const output = path.join(ROOT, "data", config.output);

function normalizeDoi(value) {
  const match = String(value || "").toLowerCase().match(/10\.\d{4,9}\/[^?#\s]+/);
  return match ? match[0].replace(/[).,;]+$/, "") : "";
}

async function existingArticles() {
  try {
    const payload = JSON.parse(await fs.readFile(output, "utf8"));
    return Array.isArray(payload.articles) ? payload.articles : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function respond(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  response.end(JSON.stringify(payload));
}

async function requestJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 20_000_000) throw new Error("Collection payload is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") {
      response.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
      response.end();
      return;
    }
    if (request.method === "GET" && request.url === "/baseline") {
      const existing = await existingArticles();
      respond(response, 200, { known_dois: existing.map((item) => normalizeDoi(item.doi)).filter(Boolean) });
      return;
    }
    if (request.method === "POST" && request.url === "/complete") {
      const body = await requestJson(request);
      const incoming = Array.isArray(body.articles) ? body.articles : [];
      const existing = body.mode === "incremental" ? await existingArticles() : [];
      const byDoi = new Map();
      for (const item of [...existing, ...incoming]) {
        const doi = normalizeDoi(item.doi);
        const publishedDate = String(item.published_date || "");
        if (!doi || publishedDate < CUTOFF) continue;
        byDoi.set(doi, { doi, title: String(item.title || doi).replace(/\s+/g, " ").trim(), published_date: publishedDate, url: `https://doi.org/${doi}` });
      }
      const articles = [...byDoi.values()].sort((a, b) => b.published_date.localeCompare(a.published_date) || b.doi.localeCompare(a.doi));
      if (body.mode === "baseline" && articles.length < config.minimum) throw new Error(`Only ${articles.length} articles were collected; expected at least ${config.minimum}`);
      const payload = { source: body.source || `${key} official publisher results`, collected_at: new Date().toISOString(), scope_start: CUTOFF, article_count: articles.length, articles };
      const temporary = `${output}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await fs.rename(temporary, output);
      respond(response, 200, { article_count: articles.length });
      setTimeout(() => server.close(), 1000);
      return;
    }
    respond(response, 404, { error: "Not found" });
  } catch (error) {
    respond(response, 400, { error: error.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`${key} publisher receiver is listening on http://127.0.0.1:${PORT}`);
  const chrome = path.join(process.env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe");
  const child = spawn(chrome, [`--profile-directory=${PROFILE_DIR}`, "--new-window", config.url], { detached: true, stdio: "ignore" });
  child.unref();
});

server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
