const STATE_KEY = "jacsCollectorState";
const CUTOFF = "2025-01-01";
const COLLECTOR_BUILD = "1.4.4";
const ARTICLE_FILTER = 'input.chkSelect[data-redirect-url*="f_ContentType=Journal+Articles"]';
const ARTICLE_ITEMS = ".sr-list.content-type-journal-articles";

function normalizeDoi(value) {
  const match = String(value || "").match(/10\.1021\/jacs\.[^?#/]+/i);
  return match ? match[0].toLowerCase().replace(/[).,;]+$/, "") : "";
}

function isoDate(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const iso = text.match(/\b20\d{2}-\d{2}-\d{2}\b/);
  if (iso) return iso[0];
  const monthFirst = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(20\d{2})\b/i);
  const dayFirst = text.match(/\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})\b/i);
  const months = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
  if (monthFirst) return `${monthFirst[3]}-${String(months[monthFirst[1].toLowerCase()]).padStart(2, "0")}-${String(monthFirst[2]).padStart(2, "0")}`;
  if (!dayFirst) return null;
  return `${dayFirst[3]}-${String(months[dayFirst[2].toLowerCase()]).padStart(2, "0")}-${String(dayFirst[1]).padStart(2, "0")}`;
}

function readPage() {
  const byDoi = new Map();
  const articleItems = [...document.querySelectorAll(ARTICLE_ITEMS)]
    .filter((item) => item.querySelector('a[href*="/doi/"], a[href*="doi.org/"], [data-doi]'));
  const items = articleItems.length ? articleItems : [...document.querySelectorAll('a[href*="/doi/"], a[href*="doi.org/"], [data-doi]')]
    .map((anchor) => anchor.closest(".item-container, .sr-list, article, li") || anchor.parentElement)
    .filter(Boolean);
  for (const item of items) {
    const anchors = [...item.querySelectorAll('a[href*="/doi/"], a[href*="doi.org/"]')];
    const doi = normalizeDoi(anchors.map((anchor) => anchor.href).find((href) => normalizeDoi(href)));
    if (!doi || byDoi.has(doi)) continue;
    const titleNode = item.querySelector(".sri-title h4 a, .sri-title a, h4 a");
    const dateNode = item.querySelector(".sri-date.al-pub-date, .sri-date");
    byDoi.set(doi, {
      doi,
      title: String(titleNode?.textContent || doi).replace(/\s+/g, " ").trim(),
      published_date: isoDate(dateNode?.textContent || ""),
      url: `https://doi.org/${doi}`,
    });
  }
  return [...byDoi.values()];
}

function readIssuePage() {
  const byDoi = new Map();
  const anchors = [...document.querySelectorAll('a[href*="/doi/"], a[href*="doi.org/"]')];
  for (const anchor of anchors) {
    const doi = normalizeDoi(anchor.href);
    if (!doi || byDoi.has(doi)) continue;
    const item = anchor.closest('.issue-item, [class*="issue-item"], .articleEntry, article, li') || anchor.parentElement;
    if (!item) continue;
    const titleNode = item.querySelector('.issue-item_title a, [class*="title"] a, h2 a, h3 a, h4 a, h5 a') || anchor;
    const publishedDate = isoDate(item.textContent || "");
    if (!publishedDate) continue;
    byDoi.set(doi, {
      doi,
      title: String(titleNode.textContent || doi).replace(/\s+/g, " ").trim(),
      published_date: publishedDate,
      url: `https://doi.org/${doi}`,
    });
  }
  return [...byDoi.values()];
}

async function waitForIssueRows() {
  let previousCount = -1;
  let stableReads = 0;
  let bestRows = [];
  for (let attempt = 0; attempt < 30; attempt += 1) {
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const rows = readIssuePage();
    if (rows.length > bestRows.length) bestRows = rows;
    if (rows.length > 0 && rows.length === previousCount) stableReads += 1;
    else stableReads = 0;
    if (rows.length > 0 && stableReads >= 3) {
      window.scrollTo(0, 0);
      return rows;
    }
    previousCount = rows.length;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  window.scrollTo(0, 0);
  if (bestRows.length > 0) return bestRows;
  throw new Error("JACS 호별 목차에서 논문을 읽지 못했습니다.");
}

async function waitForRows() {
  let previousCount = -1;
  let stableReads = 0;
  let bestRows = [];
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const rows = readPage();
    if (rows.length > bestRows.length) bestRows = rows;
    if (rows.length > 0 && rows.length === previousCount) stableReads += 1;
    else stableReads = 0;
    if (rows.length > 0 && stableReads >= 2) return rows;
    if (bestRows.length > 0 && attempt >= 7) return bestRows;
    previousCount = rows.length;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (bestRows.length > 0) return bestRows;
  throw new Error("페이지의 논문 결과가 완전히 로드되지 않았습니다.");
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!response?.ok) reject(new Error(response?.error || "Unknown extension error"));
      else resolve(response.payload);
    });
  });
}

async function loadState() {
  const result = await chrome.storage.local.get(STATE_KEY);
  const state = result[STATE_KEY] || null;
  if (state && state.collector_build !== COLLECTOR_BUILD) {
    await chrome.storage.local.remove(STATE_KEY);
    return null;
  }
  return state;
}

function saveState(state) {
  return chrome.storage.local.set({ [STATE_KEY]: state });
}

function makeMonthlyRanges() {
  const ranges = [];
  const cutoff = new Date(`${CUTOFF}T00:00:00Z`);
  for (let cursor = new Date(Date.UTC(2026, 0, 1)); cursor >= cutoff; cursor.setUTCMonth(cursor.getUTCMonth() - 1)) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    const from = `${year}-${String(month + 1).padStart(2, "0")}-01`;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const to = `${year}-${String(month + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    ranges.push({ from, to });
  }
  return ranges;
}

function makeIssueBackfill() {
  return [
    { volume: 148, issue: 1 },
    ...Array.from({ length: 52 }, (_, index) => ({ volume: 147, issue: 52 - index })),
  ];
}

async function processIssuePage(state) {
  const target = state.issues?.[state.issueIndex];
  if (!target) {
    await finish(state, "all-issues");
    return;
  }
  setPanel(`JACS ${target.volume}권 ${target.issue}호 읽는 중 · 누적 ${state.articles.length}편`, true);
  const rows = await waitForIssueRows();
  const collected = new Set(state.articles.map((article) => article.doi));
  for (const row of rows) {
    if (row.published_date < CUTOFF || collected.has(row.doi)) continue;
    state.articles.push(row);
    collected.add(row.doi);
  }
  state.pages += 1;
  state.issueIndex += 1;
  await saveState(state);
  await sendMessage({ type: "progress" });
  setPanel(`${target.volume}권 ${target.issue}호 · 이번 호 ${rows.length}편 · 누적 ${state.articles.length}편`, true);
  const nextTarget = state.issues[state.issueIndex];
  if (!nextTarget) {
    await finish(state, "all-issues");
    return;
  }
  const delay = 4000 + Math.floor(Math.random() * 3000);
  setTimeout(() => {
    location.href = `https://pubs.acs.org/toc/jacsat/${nextTarget.volume}/${nextTarget.issue}#jacs-auto`;
  }, delay);
}

async function finishRangeOrCollection(state, reason) {
  if (state.mode === "baseline" && state.ranges && state.rangeIndex < state.ranges.length - 1) {
    state.rangeIndex += 1;
    state.rangeApplied = false;
    state.lastRangeTransition = Date.now();
    await saveState(state);
    const nextRange = state.ranges[state.rangeIndex];
    setPanel(`날짜 범위 완료 · 다음 ${nextRange.from}~${nextRange.to}`, true);
    const startUrl = new URL(location.href);
    startUrl.searchParams.set("page", "1");
    startUrl.hash = "jacs-auto";
    location.href = startUrl.toString();
    return;
  }
  await finish(state, reason);
}

async function applyMonthlyRange(state) {
  const range = state.ranges[state.rangeIndex];
  if (!range) throw new Error("ACS Publication Date range is missing.");
  let from;
  let to;
  let apply;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    from = document.querySelector("#fromDate");
    to = document.querySelector("#ToDate");
    apply = document.querySelector("#btnRangeSearch");
    if (from && to && apply) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!from || !to || !apply) {
    setPanel(`진단: 날짜 범위 컨트롤 대기 실패 · ${range.from}~${range.to} · 10초 후 재시도`, true);
    setTimeout(() => processCurrentPage().catch((error) => setPanel(`오류: ${error.message}`, false)), 10000);
    return;
  }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(from, range.from);
  setter.call(to, range.to);
  from.dispatchEvent(new Event("input", { bubbles: true }));
  from.dispatchEvent(new Event("change", { bubbles: true }));
  to.dispatchEvent(new Event("input", { bubbles: true }));
  to.dispatchEvent(new Event("change", { bubbles: true }));
  state.rangeApplied = true;
  await saveState(state);
  setPanel(`진단: 날짜 범위 ${range.from}~${range.to} 적용`, true);
  apply.click();
  setTimeout(() => processCurrentPage().catch((error) => setPanel(`오류: ${error.message}`, false)), 4000);
}

function setPanel(message, running = false) {
  const status = document.querySelector("#jacs-collector-status");
  const history = document.querySelector("#jacs-collector-history");
  const button = document.querySelector("#jacs-collector-start");
  if (status) status.textContent = message;
  if (history) {
    const entries = JSON.parse(history.dataset.entries || "[]");
    entries.push(`${new Date().toLocaleTimeString()} · ${message}`);
    history.dataset.entries = JSON.stringify(entries.slice(-6));
    history.innerHTML = entries.slice(-6).map((entry) => `<div>${entry}</div>`).join("");
  }
  if (button) {
    button.textContent = running ? "새 수집으로 초기화" : "JACS 수집 시작";
    button.disabled = false;
  }
}

async function finish(state, reason) {
  setPanel(`저장 중: ${state.articles.length}편`, true);
  const result = await sendMessage({
    type: "complete",
    payload: { mode: state.mode, reason, articles: state.articles },
  });
  await chrome.storage.local.remove(STATE_KEY);
  setPanel(`완료: ${result.article_count}편 저장`, false);
}

async function processCurrentPage() {
  const state = await loadState();
  if (!state?.running) return;
  if (location.pathname.startsWith("/toc/jacsat/")) {
    await processIssuePage(state);
    return;
  }
  const pageNumber = new URL(location.href).searchParams.get("page") || "?";
  setPanel(`진단: ${pageNumber}페이지 진입 · 누적 ${state.articles.length}편`, true);

  if (!location.search.includes("f_ContentType=Journal+Articles") && !location.search.includes("f_ContentType=Journal%20Articles")) {
    const filter = document.querySelector(ARTICLE_FILTER);
    if (!filter) {
      setPanel(`진단: ${pageNumber}페이지 · Journal Articles 필터 없음`, true);
      throw new Error("Journal Articles 필터를 찾지 못했습니다.");
    }
    setPanel(`진단: ${pageNumber}페이지 · 필터 클릭`, true);
    filter.click();
    setTimeout(() => processCurrentPage().catch((error) => setPanel(`오류: ${error.message}`, false)), 4000);
    return;
  }

  let rows;
  setPanel(`진단: ${pageNumber}페이지 · 논문 결과 블록 대기`, true);
  try {
    rows = await waitForRows();
  } catch (error) {
    const doiLinks = document.querySelectorAll('a[href*="/doi/"], a[href*="doi.org/"]').length;
    const title = document.title.slice(0, 50);
    if (doiLinks === 0 && /search results/i.test(document.title)) {
      if (state.mode === "baseline" && state.ranges && state.rangeIndex < state.ranges.length - 1) {
        if (state.lastRangeTransition && Date.now() - state.lastRangeTransition < 15000) {
          setPanel(`진단: 날짜 범위 전환 대기 중 · ${state.rangeIndex + 1}/${state.ranges.length}`, true);
          return;
        }
        state.rangeIndex += 1;
        state.rangeApplied = false;
        state.lastRangeTransition = Date.now();
        await saveState(state);
        setPanel(`진단: 날짜 범위 종료 · 다음 범위 ${state.rangeIndex + 1}/${state.ranges.length} 준비`, true);
        setTimeout(() => processCurrentPage().catch((retryError) => setPanel(`오류: ${retryError.message}`, false)), 2000);
        return;
      }
      await finish(state, "all-ranges");
      return;
    }
    setPanel(`진단: ${pageNumber}페이지 · 논문 블록 0개 · DOI 링크 ${doiLinks}개 · ${title} · 10초 후 재시도`, true);
    setTimeout(() => processCurrentPage().catch((retryError) => setPanel(`오류: ${retryError.message}`, false)), 10000);
    return;
  }

  const known = new Set(state.known_dois);
  const collected = new Set(state.articles.map((article) => article.doi));
  let stopReason = null;
  for (const row of rows) {
    if (!row.published_date) throw new Error(`날짜를 읽지 못했습니다: ${row.doi}`);
    if (row.published_date < CUTOFF) {
      stopReason = "cutoff";
      break;
    }
    if (state.mode === "incremental" && known.has(row.doi)) {
      stopReason = "known-doi";
      break;
    }
    if (!collected.has(row.doi)) {
      state.articles.push(row);
      collected.add(row.doi);
    }
  }

  state.pages += 1;
  await saveState(state);
  await sendMessage({ type: "progress" });
  setPanel(`${state.pages}페이지 · ${state.articles.length}편`, true);
  if (stopReason) {
    await finish(state, stopReason);
    return;
  }

  if (rows.length < 20) {
    await finishRangeOrCollection(state, "short-page");
    return;
  }

  const next = document.querySelector("button.sr-nav-next, a.sr-nav-next");
  if (!next) {
    await finishRangeOrCollection(state, "last-page");
    return;
  }
  const delay = 5000 + Math.floor(Math.random() * 3000);
  setPanel(`진단: ${pageNumber}페이지 · 논문 ${rows.length}편 · Next 있음 · ${Math.round(delay / 1000)}초 후 클릭`, true);
  setTimeout(() => {
    next.scrollIntoView({ block: "center" });
    next.click();
    setTimeout(() => processCurrentPage().catch((error) => setPanel(`오류: ${error.message}`, false)), 4000);
  }, delay);
}

async function startCollection() {
  setPanel("로컬 수신기 연결 중", true);
  const baseline = await sendMessage({ type: "baseline" });
  const state = {
    running: true,
    collector_build: COLLECTOR_BUILD,
    mode: baseline.force_baseline || !baseline.known_dois.length ? "baseline" : "incremental",
    known_dois: baseline.known_dois,
    articles: [],
    pages: 0,
    ranges: [],
    rangeIndex: 0,
    rangeApplied: false,
    issues: baseline.force_baseline || !baseline.known_dois.length ? makeIssueBackfill() : [],
    issueIndex: 0,
  };
  await saveState(state);
  if (state.mode === "baseline") {
    const firstIssue = state.issues[0];
    location.href = `https://pubs.acs.org/toc/jacsat/${firstIssue.volume}/${firstIssue.issue}#jacs-auto`;
    return;
  }
  const startUrl = new URL(location.href);
  let cleaned = false;
  for (const key of [...startUrl.searchParams.keys()]) {
    if (/publication|date|from|to|range/i.test(key)) {
      startUrl.searchParams.delete(key);
      cleaned = true;
    }
  }
  if (cleaned || startUrl.searchParams.get("page") !== "1") {
    startUrl.searchParams.set("page", "1");
    startUrl.hash = "jacs-auto";
    location.href = startUrl.toString();
    return;
  }
  await processCurrentPage();
}

function installPanel() {
  if (document.querySelector("#jacs-collector-panel")) return;
  const panel = document.createElement("div");
  panel.id = "jacs-collector-panel";
  panel.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#fff;border:1px solid #1f4e79;border-radius:8px;padding:12px;box-shadow:0 2px 12px #0003;font:14px Arial;color:#111";
  panel.innerHTML = '<div id="jacs-collector-status" style="margin-bottom:8px">준비됨</div><div id="jacs-collector-history" data-entries="[]" style="margin-bottom:8px;max-width:360px;max-height:120px;overflow:auto;font-size:11px;color:#444"></div><button id="jacs-collector-start" type="button" style="padding:7px 10px;cursor:pointer">JACS 수집 시작</button>';
  document.body.appendChild(panel);
  panel.querySelector("button").addEventListener("click", () => startCollection().catch((error) => setPanel(`오류: ${error.message}`, false)));
}

installPanel();
loadState().then((state) => {
  if (state?.running) {
    processCurrentPage().catch((error) => setPanel(`오류: ${error.message}`, false));
  } else if (location.hash === "#jacs-auto") {
    startCollection().catch((error) => setPanel(`오류: ${error.message}`, false));
  }
});
