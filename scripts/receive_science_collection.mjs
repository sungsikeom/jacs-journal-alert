import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(ROOT, "data", "science_articles.json");
const CUTOFF = "2026-01-01";
const PORT = 47822;
const PROFILE_DIR = process.env.SCIENCE_CHROME_PROFILE_DIR || "Profile 1";
const URL = "https://www.science.org/toc/science/current#science-auto";

function normalizeDoi(value) {
  const match = String(value || "").toLowerCase().match(/10\.1126\/science\.[^?#/\s]+/);
  return match ? match[0].replace(/[).,;]+$/, "") : "";
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

function respond(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  response.end(JSON.stringify(payload));
}

async function bodyJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 5_000_000) throw new Error("Collection payload is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = http.createServer(async (request, response) => {
  try {
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
      const existing = await existingArticles();
      respond(response, 200, { known_dois: existing.map((item) => normalizeDoi(item.doi)).filter(Boolean) });
      return;
    }
    if (request.method === "POST" && request.url === "/complete") {
      const body = await bodyJson(request);
      const incoming = Array.isArray(body.articles) ? body.articles : [];
      const existing = body.mode === "incremental" ? await existingArticles() : [];
      const byDoi = new Map();
      for (const item of [...existing, ...incoming]) {
        const doi = normalizeDoi(item.doi);
        const publishedDate = String(item.published_date || "");
        if (!doi || publishedDate < CUTOFF) continue;
        byDoi.set(doi, {
          doi,
          title: String(item.title || doi).trim(),
          published_date: publishedDate,
          article_type: "Research Article",
          url: `https://doi.org/${doi}`,
        });
      }
      const articles = [...byDoi.values()].sort((a, b) => b.published_date.localeCompare(a.published_date) || b.doi.localeCompare(a.doi));
      if (body.mode === "baseline" && articles.length < 50) throw new Error(`Only ${articles.length} Science Research Articles were collected; refusing an incomplete baseline`);
      const payload = {
        source: "Science tables of contents collected by the local Chrome extension",
        collected_at: new Date().toISOString(),
        scope_start: CUTOFF,
        article_type: "Research Article",
        article_count: articles.length,
        articles,
      };
      const temporary = `${OUTPUT}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await fs.rename(temporary, OUTPUT);
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
  console.log(`Science local receiver is listening on http://127.0.0.1:${PORT}`);
  console.log(`Opening Chrome profile: ${PROFILE_DIR}`);
  const chrome = path.join(process.env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe");
  const child = spawn(chrome, [`--profile-directory=${PROFILE_DIR}`, "--new-window", URL], { detached: true, stdio: "ignore" });
  child.unref();
});

server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
