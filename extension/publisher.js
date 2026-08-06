const PUBLISHER_STATE_KEY = "publisherCollectorState";
const PUBLISHER_CUTOFF = "2026-01-01";
const PUBLISHER_BUILD = "1.3.11";

const publisherConfig = (() => {
  if (location.hostname === "www.nature.com") return { key: "nature", label: "Nature Communications", prefix: "10.1038/s41467-", source: "Nature Communications Research Articles" };
  if (location.hostname === "pubs.acs.org") return { key: "jctc", label: "JCTC", prefix: "10.1021/acs.jctc.", source: "ACS JCTC Article search results" };
  const series = new URL(location.href).searchParams.get("SeriesKey")?.toLowerCase();
  if (series === "1096987x") return { key: "jcc", label: "Journal of Computational Chemistry", prefix: "10.1002/jcc.", source: "Wiley Journal of Computational Chemistry search results" };
  if (series === "15213773") return { key: "angew", label: "Angewandte", prefix: "10.1002/anie.", source: "Wiley Angewandte search results" };
  return null;
})();

function publisherDoi(value) {
  const text = String(value || "");
  const nature = text.match(/\/articles\/(s41467-[^/?#]+)/i);
  if (nature) return `10.1038/${nature[1].toLowerCase()}`;
  const jctc = text.match(/10\.1021\/acs\.jctc\.[a-z0-9]+/i);
  if (jctc) return jctc[0].toLowerCase();
  const match = text.match(/10\.\d{4,9}\/[^?#\s]+/i);
  return match ? match[0].toLowerCase().replace(/[).,;]+$/, "") : "";
}

function publisherDate(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const iso = text.match(/\b20\d{2}-\d{2}-\d{2}\b/);
  if (iso) return iso[0];
  const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const dayFirst = text.match(/\b(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(20\d{2})\b/i);
  if (dayFirst) return `${dayFirst[3]}-${String(months[dayFirst[2].slice(0, 3).toLowerCase()]).padStart(2, "0")}-${String(dayFirst[1]).padStart(2, "0")}`;
  const monthFirst = text.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/i);
  if (!monthFirst) return null;
  return `${monthFirst[3]}-${String(months[monthFirst[1].slice(0, 3).toLowerCase()]).padStart(2, "0")}-${String(monthFirst[2]).padStart(2, "0")}`;
}

function readPublisherPage() {
  if (publisherConfig.key === "nature") {
    const byDoi = new Map();
    for (const item of document.querySelectorAll("li.app-article-list-row__item")) {
      const anchor = item.querySelector('a[href*="/articles/s41467-"]');
      const doi = publisherDoi(anchor?.href);
      if (!doi || byDoi.has(doi)) continue;
      const titleNode = item.querySelector("h2 a, h3 a, h4 a") || anchor;
      const dateNode = item.querySelector("time, .c-meta__item time");
      byDoi.set(doi, {
        doi,
        title: String(titleNode?.textContent || doi).replace(/\s+/g, " ").trim(),
        published_date: publisherDate(dateNode?.getAttribute("datetime") || dateNode?.textContent || item?.textContent),
        url: `https://doi.org/${doi}`,
      });
    }
    return [...byDoi.values()];
  }
  const selectors = publisherConfig.key === "nature"
    ? "li.app-article-list-row__item, article"
    : publisherConfig.key === "jctc"
      ? ".sr-list.content-type-journal-articles"
      : ".search__item, .item-container, article";
  const byDoi = new Map();
  for (const item of document.querySelectorAll(selectors)) {
    const anchors = [...item.querySelectorAll('a[href*="/articles/"], a[href*="/doi/"], a[href*="doi.org/"]')];
    const titleNode = item.querySelector("h2 a, h3 a, h4 a, .publication_title a, .sri-title a");
    const titleDoi = publisherDoi(titleNode?.href);
    const doiAnchor = anchors.find((anchor) => publisherDoi(anchor.href).startsWith(publisherConfig.prefix));
    const doi = titleDoi.startsWith(publisherConfig.prefix) ? titleDoi : publisherDoi(doiAnchor?.href);
    if (!doi || byDoi.has(doi)) continue;
    const resolvedTitleNode = titleNode || doiAnchor;
    const dateNode = item.querySelector("time, .c-meta__item time, .meta__epubDate, .sri-date");
    const title = String(resolvedTitleNode?.textContent || doi).replace(/\s+/g, " ").trim();
    if ((publisherConfig.key === "jcc" || publisherConfig.key === "angew") && /^issue information$/i.test(title)) continue;
    if (publisherConfig.key === "angew" && (/^(?:inside |outside )?(?:front |back )?cover:/i.test(title) || /^frontispiece:/i.test(title))) continue;
    byDoi.set(doi, { doi, title, published_date: publisherDate(dateNode?.getAttribute("datetime") || dateNode?.textContent || item.textContent), url: `https://doi.org/${doi}` });
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
    panel.innerHTML = `<strong>${publisherConfig.label} Collector</strong><div id="publisher-status" style="margin:9px 0"></div><div style="display:flex;gap:7px"><button id="publisher-start" type="button">수집 시작</button><button id="publisher-stop" type="button">중단</button></div>`;
    document.body.appendChild(panel);
    panel.querySelector("#publisher-start").addEventListener("click", () => startPublisherCollection().catch((error) => publisherPanel(`오류: ${error.message}`)));
    panel.querySelector("#publisher-stop").addEventListener("click", () => stopPublisherCollection().catch((error) => publisherPanel(`오류: ${error.message}`)));
  }
  panel.querySelector("#publisher-status").textContent = message;
  panel.querySelector("#publisher-start").textContent = running ? "새 수집으로 초기화" : "수집 시작";
  panel.querySelector("#publisher-stop").disabled = !running;
}

async function stopPublisherCollection() {
  const state = await loadPublisherState();
  if (state) {
    state.running = false;
    state.run_id = `stopped-${Date.now()}`;
    state.processing_url = null;
    await savePublisherState(state);
  }
  publisherPanel("중단됨");
}

async function waitPublisherRows() {
  let best = [];
  let previous = -1;
  let stable = 0;
  let previousSignature = "";
  let stableSignatures = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const rows = readPublisherPage();
    if (rows.length > best.length) best = rows;
    if (publisherConfig.key === "nature") {
      const complete = rows.length === 20 && rows.every((row) => row.title && row.title !== row.doi && row.published_date);
      const signature = complete
        ? rows.map((row) => `${row.doi}|${row.title}|${row.published_date}`).sort().join("\n")
        : "";
      stableSignatures = signature && signature === previousSignature ? stableSignatures + 1 : 0;
      previousSignature = signature;
      if (complete && stableSignatures >= 3) return rows;
      if (rows.length > 20) throw new Error(`Nature 결과 범위를 벗어났습니다: 20편 대신 ${rows.length}편 감지`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }
    stable = rows.length > 0 && rows.length === previous ? stable + 1 : 0;
    if (stable >= 2) return rows;
    previous = rows.length;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (publisherConfig.key === "nature" && best.length < 20) {
    throw new Error(`Nature 페이지가 불완전합니다: 20편 중 ${best.length}편만 로드됨`);
  }
  if (best.length) return best;
  throw new Error("공식 검색 결과를 읽지 못했습니다.");
}

function nextPublisherPage() {
  return document.querySelector('a[rel="next"], a.c-pagination__link[data-page="next"], a.pagination__btn--next, button.sr-nav-next, a.sr-nav-next');
}

function openNextPublisherPage() {
  if (publisherConfig.key === "nature" || publisherConfig.key === "jctc") {
    const nextUrl = new URL(location.href);
    const currentPage = Number(nextUrl.searchParams.get("page") || "1");
    nextUrl.searchParams.set("page", String(currentPage + 1));
    if (publisherConfig.key === "nature") {
      nextUrl.searchParams.set("searchType", "journalSearch");
      nextUrl.searchParams.set("sort", "PubDate");
    } else {
      nextUrl.searchParams.set("f_ContentType", "Journal Articles");
      nextUrl.searchParams.delete("f_ArticleTypeDisplayName");
      nextUrl.searchParams.set("sort", "Date - Newest First");
    }
    nextUrl.hash = "publisher-auto";
    location.replace(nextUrl.toString());
    return true;
  }
  if (publisherConfig.key === "jcc" || publisherConfig.key === "angew") {
    const nextUrl = new URL(location.href);
    const currentPage = Number(nextUrl.searchParams.get("startPage") || "0");
    nextUrl.searchParams.set("startPage", String(currentPage + 1));
    nextUrl.hash = "publisher-auto";
    location.replace(nextUrl.toString());
    return true;
  }
  const next = nextPublisherPage();
  if (!next) return false;
  next.click();
  return true;
}

async function finishPublisher(state, reason) {
  publisherPanel(`저장 중 · ${state.article_count}편`, true);
  const result = await publisherMessage({ type: "publisher-complete", payload: { mode: state.mode, reason, source: publisherConfig.source } });
  await chrome.storage.local.remove(PUBLISHER_STATE_KEY);
  publisherPanel(`완료 · ${result.article_count}편 저장`);
}

async function processPublisherPage() {
  const state = await loadPublisherState();
  if (!state?.running || state.key !== publisherConfig.key) return;
  if (state.collector_build !== PUBLISHER_BUILD) {
    state.collector_build = PUBLISHER_BUILD;
    state.processing_url = null;
    state.processing_started = null;
    state.last_processed_url = null;
    await savePublisherState(state);
  }
  const pageUrl = location.href.split("#")[0];
  if (state.processing_url === pageUrl && Date.now() - Number(state.processing_started || 0) < 120000) return;
  if (state.last_processed_url === pageUrl) {
    publisherPanel("현재 페이지는 저장됨 · 다음 페이지로 복구 중", true);
    setTimeout(() => {
      loadPublisherState().then((latest) => {
        if (latest?.running && latest.run_id === state.run_id) openNextPublisherPage();
      });
    }, 1500);
    return;
  }
  state.processing_url = pageUrl;
  state.processing_started = Date.now();
  await savePublisherState(state);
  publisherPanel("페이지 안정화 대기 · 2초", true);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const rows = await waitPublisherRows();
  const latestState = await loadPublisherState();
  if (!latestState?.running || latestState.run_id !== state.run_id) return;
  const known = new Set(state.known_dois);
  let reason = null;
  const pageRows = [];
  for (const row of rows) {
    if (!row.published_date) throw new Error(`발행일을 읽지 못했습니다: ${row.doi}`);
    if (row.published_date < PUBLISHER_CUTOFF) { reason = "cutoff"; break; }
    if (state.mode === "incremental" && known.has(row.doi)) { reason = "known-doi"; break; }
    pageRows.push(row);
  }
  if (!reason && publisherConfig.key === "nature" && pageRows.length !== 20) {
    throw new Error(`Nature 페이지 검증 실패: 전송 직전 ${pageRows.length}편`);
  }
  const batch = await publisherMessage({ type: "publisher-batch", payload: { articles: pageRows } });
  if (!reason && publisherConfig.key === "nature" && batch.received_count !== 20) {
    throw new Error(`Nature 전송 검증 실패: 20편 대신 ${batch.received_count}편 전송`);
  }
  if (!reason && publisherConfig.key === "nature" && batch.added_count === 0) {
    throw new Error("Nature 페이지의 20편이 모두 이전 페이지와 중복됩니다. 페이지 이동을 확인하세요.");
  }
  state.article_count = batch.article_count;
  state.last_received_count = batch.received_count;
  state.last_added_count = batch.added_count;
  state.pages += 1;
  state.last_processed_url = pageUrl;
  state.processing_url = null;
  state.processing_started = null;
  await savePublisherState(state);
  const visiblePage = publisherConfig.key === "nature" || publisherConfig.key === "jctc"
    ? new URL(location.href).searchParams.get("page") || "1"
    : publisherConfig.key === "jcc" || publisherConfig.key === "angew"
      ? String(Number(new URL(location.href).searchParams.get("startPage") || "0") + 1)
      : state.pages;
  const pageBreakdown = publisherConfig.key === "nature"
    ? ` · 이번 20편 · 신규 고유 ${batch.added_count}편`
    : "";
  publisherPanel(`${visiblePage}페이지${pageBreakdown} · 누적 ${state.article_count}편`, true);
  if (reason) return finishPublisher(state, reason);
  if (publisherConfig.key !== "nature" && !nextPublisherPage()) return finishPublisher(state, "last-page");
  setTimeout(() => {
    loadPublisherState().then((latest) => {
      if (!latest?.running || latest.run_id !== state.run_id) return;
      if (!openNextPublisherPage()) finishPublisher(state, "last-page").catch((error) => publisherPanel(`오류: ${error.message}`));
    });
  }, 3500 + Math.floor(Math.random() * 2500));
}

async function startPublisherCollection() {
  if (publisherConfig.key === "jctc" && new URL(location.href).searchParams.get("f_ContentType") !== "Journal Articles") {
    throw new Error("JCTC Content Type 필터가 없습니다. Journal Articles 필터 주소에서 시작하세요.");
  }
  const baseline = await publisherMessage({ type: "publisher-baseline", reset: true });
  const state = {
    running: true,
    collector_build: PUBLISHER_BUILD,
    run_id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    key: publisherConfig.key,
    mode: baseline.known_dois.length ? "incremental" : "baseline",
    known_dois: baseline.known_dois,
    article_count: 0,
    pages: 0,
    processing_url: null,
    processing_started: null,
    last_processed_url: null,
  };
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
