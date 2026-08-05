const PUBLISHER_STATE_KEY = "publisherCollectorState";
const PUBLISHER_CUTOFF = "2026-01-01";

const publisherConfig = (() => {
  if (location.hostname === "www.nature.com") return { key: "nature", label: "Nature Communications", prefix: "10.1038/s41467-", source: "Nature Communications Research Articles" };
  if (location.hostname === "pubs.acs.org") return { key: "jctc", label: "JCTC", prefix: "10.1021/acs.jctc.", source: "ACS JCTC search results" };
  const series = new URL(location.href).searchParams.get("SeriesKey")?.toLowerCase();
  if (series === "1096987x") return { key: "jcc", label: "Journal of Computational Chemistry", prefix: "10.1002/jcc.", source: "Wiley Journal of Computational Chemistry search results" };
  if (series === "15213773") return { key: "angew", label: "Angewandte", prefix: "10.1002/anie.", source: "Wiley Angewandte search results" };
  return null;
})();

function publisherDoi(value) {
  const text = String(value || "");
  const nature = text.match(/\/articles\/(s41467-\d{3}-\d{4,6}-\d)/i);
  if (nature) return `10.1038/${nature[1].toLowerCase()}`;
  const match = text.match(/10\.\d{4,9}\/[^?#\s]+/i);
  return match ? match[0].toLowerCase().replace(/[).,;]+$/, "") : "";
}

function publisherDate(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const iso = text.match(/\b20\d{2}-\d{2}-\d{2}\b/);
  if (iso) return iso[0];
  const match = text.match(/\b(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(20\d{2})\b/i);
  if (!match) return null;
  const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  return `${match[3]}-${String(months[match[2].slice(0, 3).toLowerCase()]).padStart(2, "0")}-${String(match[1]).padStart(2, "0")}`;
}

function readPublisherPage() {
  const selectors = publisherConfig.key === "nature"
    ? "li.app-article-list-row__item, article"
    : publisherConfig.key === "jctc"
      ? ".sr-list.content-type-journal-articles"
      : ".search__item, .item-container, article";
  const byDoi = new Map();
  for (const item of document.querySelectorAll(selectors)) {
    const anchors = [...item.querySelectorAll('a[href*="/articles/"], a[href*="/doi/"], a[href*="doi.org/"]')];
    const doiAnchor = anchors.find((anchor) => publisherDoi(anchor.href).startsWith(publisherConfig.prefix));
    const doi = publisherDoi(doiAnchor?.href);
    if (!doi || byDoi.has(doi)) continue;
    const titleNode = item.querySelector("h2 a, h3 a, h4 a, .publication_title a, .sri-title a") || doiAnchor;
    const dateNode = item.querySelector("time, .c-meta__item time, .meta__epubDate, .sri-date");
    byDoi.set(doi, { doi, title: String(titleNode?.textContent || doi).replace(/\s+/g, " ").trim(), published_date: publisherDate(dateNode?.getAttribute("datetime") || dateNode?.textContent || item.textContent), url: `https://doi.org/${doi}` });
  }
  return [...byDoi.values()];
}

function publisherMessage(message) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, (response) => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else if (!response?.ok) reject(new Error(response?.error || "Unknown extension error"));
    else resolve(response.payload);
  }));
}

const loadPublisherState = () => chrome.storage.local.get(PUBLISHER_STATE_KEY).then((value) => value[PUBLISHER_STATE_KEY] || null);
const savePublisherState = (state) => chrome.storage.local.set({ [PUBLISHER_STATE_KEY]: state });

function publisherPanel(message, running = false) {
  let panel = document.querySelector("#publisher-collector-panel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "publisher-collector-panel";
    panel.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;width:390px;max-width:calc(100vw - 32px);background:#fff;border:1px solid #214e3e;border-radius:10px;padding:13px;box-shadow:0 4px 20px #0003;font:12px Arial;color:#111";
    panel.innerHTML = `<strong>${publisherConfig.label} Collector</strong><div id="publisher-status" style="margin:9px 0"></div><button id="publisher-start" type="button">수집 시작</button>`;
    document.body.appendChild(panel);
    panel.querySelector("button").addEventListener("click", () => startPublisherCollection().catch((error) => publisherPanel(`오류: ${error.message}`)));
  }
  panel.querySelector("#publisher-status").textContent = message;
  panel.querySelector("button").textContent = running ? "새 수집으로 초기화" : "수집 시작";
}

async function waitPublisherRows() {
  let best = [];
  let previous = -1;
  let stable = 0;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const rows = readPublisherPage();
    if (rows.length > best.length) best = rows;
    stable = rows.length > 0 && rows.length === previous ? stable + 1 : 0;
    if (stable >= 2) return rows;
    previous = rows.length;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (best.length) return best;
  throw new Error("공식 검색 결과를 읽지 못했습니다.");
}

function nextPublisherPage() {
  return document.querySelector('a[rel="next"], a.c-pagination__link[data-page="next"], a.pagination__btn--next, button.sr-nav-next, a.sr-nav-next');
}

async function finishPublisher(state, reason) {
  publisherPanel(`저장 중 · ${state.articles.length}편`, true);
  const result = await publisherMessage({ type: "publisher-complete", payload: { mode: state.mode, reason, source: publisherConfig.source, articles: state.articles } });
  await chrome.storage.local.remove(PUBLISHER_STATE_KEY);
  publisherPanel(`완료 · ${result.article_count}편 저장`);
}

async function processPublisherPage() {
  const state = await loadPublisherState();
  if (!state?.running || state.key !== publisherConfig.key) return;
  const rows = await waitPublisherRows();
  const known = new Set(state.known_dois);
  const collected = new Set(state.articles.map((item) => item.doi));
  let reason = null;
  for (const row of rows) {
    if (!row.published_date) throw new Error(`발행일을 읽지 못했습니다: ${row.doi}`);
    if (row.published_date < PUBLISHER_CUTOFF) { reason = "cutoff"; break; }
    if (state.mode === "incremental" && known.has(row.doi)) { reason = "known-doi"; break; }
    if (!collected.has(row.doi)) { state.articles.push(row); collected.add(row.doi); }
  }
  state.pages += 1;
  await savePublisherState(state);
  publisherPanel(`${state.pages}페이지 · ${state.articles.length}편`, true);
  if (reason) return finishPublisher(state, reason);
  const next = nextPublisherPage();
  if (!next) return finishPublisher(state, "last-page");
  setTimeout(() => { next.click(); }, 3500 + Math.floor(Math.random() * 2500));
}

async function startPublisherCollection() {
  const baseline = await publisherMessage({ type: "publisher-baseline" });
  const state = { running: true, key: publisherConfig.key, mode: baseline.known_dois.length ? "incremental" : "baseline", known_dois: baseline.known_dois, articles: [], pages: 0 };
  await savePublisherState(state);
  await processPublisherPage();
}

if (publisherConfig) {
  publisherPanel(`준비됨 · 현재 페이지 ${readPublisherPage().length}편`);
  loadPublisherState().then((state) => {
    if (state?.running && state.key === publisherConfig.key) processPublisherPage().catch((error) => publisherPanel(`오류: ${error.message}`));
    else if (location.hash === "#publisher-auto") startPublisherCollection().catch((error) => publisherPanel(`오류: ${error.message}`));
  });
}
