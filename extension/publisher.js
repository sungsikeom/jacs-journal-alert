const PUBLISHER_STATE_KEY = "publisherCollectorState";
const PUBLISHER_CUTOFF = "2026-01-01";
const PUBLISHER_BUILD = "2.0.1";
const PUBLISHER_MAX_PAGES = 1000;
const ACS_SEARCH_KEYS = new Set(["jctc", "jcim", "jpcl"]);
const NATURE_KEYS = new Set(["nature", "nature-main", "nature-chemistry"]);

const publisherConfig = (() => {
  if (location.hostname === "www.nature.com" && /^\/ncomms\//i.test(location.pathname)) return { key: "nature", label: "Nature Communications", prefix: "10.1038/s41467-", articleCode: "s41467-", source: "Nature Communications Research Articles" };
  if (location.hostname === "www.nature.com" && /^\/nature\//i.test(location.pathname)) return { key: "nature-main", label: "Nature", prefix: "10.1038/s41586-", source: "Nature Research Articles" };
  if (location.hostname === "www.nature.com" && /^\/nchem\//i.test(location.pathname)) return { key: "nature-chemistry", label: "Nature Chemistry", prefixes: ["10.1038/s41557-", "10.1038/nchem."], cutoff: "2009-01-01", source: "Nature Chemistry Research Articles" };
  if (location.hostname === "pubs.acs.org" && /^\/jctcce\//i.test(location.pathname)) return { key: "jctc", label: "JCTC", prefix: "10.1021/acs.jctc.", source: "ACS JCTC Article search results" };
  if (location.hostname === "pubs.acs.org" && /^\/jcisd8\//i.test(location.pathname)) return { key: "jcim", label: "JCIM", prefix: "10.1021/acs.jcim.", source: "ACS JCIM Article search results" };
  if (location.hostname === "pubs.acs.org" && /^\/jpclcd\//i.test(location.pathname)) return { key: "jpcl", label: "JPCL", prefix: "10.1021/acs.jpclett.", source: "ACS JPCL Article search results" };
  if (location.hostname === "pubs.rsc.org" && (/\/sc\/issue\//i.test(location.pathname) || /latest-articles|advance-articles/i.test(location.href))) return { key: "chemical-science", label: "Chemical Science", prefix: "10.1039/", source: "RSC Chemical Science latest articles" };
  const series = new URL(location.href).searchParams.get("SeriesKey")?.toLowerCase();
  if (series === "1096987x") return { key: "jcc", label: "Journal of Computational Chemistry", prefix: "10.1002/jcc.", source: "Wiley Journal of Computational Chemistry search results" };
  if (series === "15213773") return { key: "angew", label: "Angewandte", prefix: "10.1002/anie.", source: "Wiley Angewandte search results" };
  return null;
})();

function publisherDoi(value) {
  const text = String(value || "");
  const nature = text.match(/\/articles\/(s\d{5}-[^/?#]+)/i);
  if (nature) return `10.1038/${nature[1].toLowerCase()}`;
  const legacyNatureChemistry = text.match(/\/articles\/(nchem\.\d+)/i);
  if (legacyNatureChemistry) return `10.1038/${legacyNatureChemistry[1].toLowerCase()}`;
  const acsJournal = text.match(/10\.1021\/acs\.(?:jctc|jcim|jpclett)\.[a-z0-9]+/i);
  if (acsJournal) return acsJournal[0].toLowerCase();
  const rsc = text.match(/\/content\/articlelanding\/20\d{2}\/sc\/([a-z0-9]+)/i);
  if (rsc) return `10.1039/${rsc[1].toLowerCase()}`;
  const rscPath = text.match(/\/sc\/(d\dsc\d+[a-z])/i);
  if (rscPath) return `10.1039/${rscPath[1].toLowerCase()}`;
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

function chemicalScienceTitle(item, anchor, doi) {
  const candidates = [...(item?.querySelectorAll("h1, h2, h3, h4, h5, [class*='title'], [id*='title']") || [])]
    .map((node) => String(node.textContent || "").replace(/\s+/g, " ").trim())
    .filter((text) => text && text !== doi && !/^abstracts?$|^view article|^open access$/i.test(text));
  if (candidates.length) return candidates.sort((a, b) => b.length - a.length)[0];
  const text = String(item?.innerText || item?.textContent || anchor?.textContent || "").replace(/\s+/g, " ").trim();
  const beforeAccess = text.split(/\bOpen Access\b/i)[0].trim();
  const cleaned = beforeAccess.replace(/^(?:Covers|Front\/Back Matter|Perspectives|Review Articles|Edge Articles|Corrections)\s+/i, "").trim();
  return cleaned && !/^10\.1039\//i.test(cleaned) ? cleaned : doi;
}

function chemicalScienceItem(anchor) {
  let node = anchor?.parentElement || null;
  for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
    const text = String(node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
    if (/\bOpen Access\b/i.test(text) && text.length < 6000) return node;
  }
  return anchor?.parentElement || null;
}

function publisherPrefixes() {
  return publisherConfig.prefixes || [publisherConfig.prefix];
}

function matchesPublisherDoi(doi) {
  return publisherPrefixes().some((prefix) => doi.startsWith(prefix));
}

function readPublisherPage() {
  if (NATURE_KEYS.has(publisherConfig.key)) {
    const byDoi = new Map();
    for (const item of document.querySelectorAll("li.app-article-list-row__item")) {
      const anchor = [...item.querySelectorAll('a[href*="/articles/"]')].find((candidate) => matchesPublisherDoi(publisherDoi(candidate.href)));
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
  if (publisherConfig.key === "chemical-science") {
    const byDoi = new Map();
    const anchors = [...document.querySelectorAll('a[href*="/content/articlelanding/"], a[href*="/articlelanding/"], a[href*="/sc/d"], a[href*="doi.org/10.1039/"]')];
    for (const anchor of anchors) {
      const doi = publisherDoi(anchor.href);
      if (!doi) continue;
      const item = chemicalScienceItem(anchor);
      const text = String(item?.textContent || anchor.textContent || "").replace(/\s+/g, " ").trim();
      const year = text.match(/\b(20\d{2})\b/)?.[1] || new URL(anchor.href).pathname.match(/\/articlelanding\/(20\d{2})\//)?.[1];
      if (!year) continue;
      const candidate = {
        doi,
        title: chemicalScienceTitle(item, anchor, doi),
        published_date: publisherDate(text) || `${year}-01-01`,
        url: `https://doi.org/${doi}`,
      };
      const existing = byDoi.get(doi);
      const isArticleLanding = /articlelanding|\/sc\/d/i.test(anchor.href || "");
      const existingIsCitation = existing && /^Chem\. Sci\./i.test(existing.title);
      if (!existing || (existingIsCitation && isArticleLanding)) byDoi.set(doi, candidate);
    }
    return [...byDoi.values()];
  }
  const selectors = NATURE_KEYS.has(publisherConfig.key)
    ? "li.app-article-list-row__item, article"
    : ACS_SEARCH_KEYS.has(publisherConfig.key)
      ? ".sr-list.content-type-journal-articles"
      : ".search__item, .item-container, article";
  const byDoi = new Map();
  for (const item of document.querySelectorAll(selectors)) {
    const anchors = [...item.querySelectorAll('a[href*="/articles/"], a[href*="/doi/"], a[href*="doi.org/"]')];
    const titleNode = item.querySelector("h2 a, h3 a, h4 a, .publication_title a, .sri-title a");
    const titleDoi = publisherDoi(titleNode?.href);
    const doiAnchor = anchors.find((anchor) => matchesPublisherDoi(publisherDoi(anchor.href)));
    const doi = matchesPublisherDoi(titleDoi) ? titleDoi : publisherDoi(doiAnchor?.href);
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

function publisherSecurityChallenge() {
  if (publisherConfig.key !== "chemical-science") return false;
  const text = String(document.body?.innerText || "").toLowerCase();
  return text.includes("security check") || text.includes("cloudflare") || text.includes("보안 확인") || text.includes("잠시만 기다리십시오");
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
  for (let attempt = 0; attempt < (publisherConfig.key === "chemical-science" ? 180 : 60); attempt += 1) {
    if (publisherSecurityChallenge()) publisherPanel("RSC 보안 확인 대기 중 · 브라우저에서 확인을 완료해 주세요", true);
    const rows = readPublisherPage();
    if (publisherConfig.key === "chemical-science" && !publisherSecurityChallenge() && attempt % 5 === 0) publisherPanel(`RSC 논문 링크 탐색 중 · ${rows.length}편 감지`, true);
    if (rows.length > best.length) best = rows;
    if (NATURE_KEYS.has(publisherConfig.key)) {
      const complete = rows.length > 0 && rows.length <= 20 && rows.every((row) => row.title && row.title !== row.doi && row.published_date);
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
  if (best.length) return best;
  throw new Error("공식 검색 결과를 읽지 못했습니다.");
}

function nextPublisherPage() {
  if (publisherConfig.key === "chemical-science" && /latest-articles|advance-articles/i.test(location.pathname)) {
    return [...document.querySelectorAll("a, button")].find((element) => /advance articles/i.test(String(element.textContent || "").replace(/\s+/g, " ").trim())) || null;
  }
  return document.querySelector('a[rel="next"], a.c-pagination__link[data-page="next"], a.pagination__btn--next, button.sr-nav-next, a.sr-nav-next');
}

function openNextPublisherPage() {
  if (publisherConfig.key === "chemical-science") {
    if (/latest-articles|advance-articles/i.test(location.pathname)) {
      const next = nextPublisherPage();
      if (!next) return false;
      if (next.tagName === "A" && next.href) {
        const nextUrl = new URL(next.href, location.href);
        nextUrl.hash = "publisher-auto";
        location.replace(nextUrl.toString());
      } else next.click();
      return true;
    }
    const match = location.pathname.match(/^\/sc\/issue\/(\d+)\/(\d+)/i);
    if (!match) return false;
    const volume = Number(match[1]);
    const issue = Number(match[2]);
    if (issue <= 1) return false;
    const nextUrl = new URL(location.href);
    nextUrl.pathname = `/sc/issue/${volume}/${issue - 1}`;
    nextUrl.hash = "publisher-auto";
    location.replace(nextUrl.toString());
    return true;
  }
  if (NATURE_KEYS.has(publisherConfig.key) || ACS_SEARCH_KEYS.has(publisherConfig.key)) {
    const nextUrl = new URL(location.href);
    const currentPage = Number(nextUrl.searchParams.get("page") || "1");
    nextUrl.searchParams.set("page", String(currentPage + 1));
    if (NATURE_KEYS.has(publisherConfig.key)) {
      nextUrl.searchParams.set("searchType", "journalSearch");
      nextUrl.searchParams.set("sort", "PubDate");
      if (publisherConfig.key === "nature-main") nextUrl.searchParams.set("year", "2026");
      if (publisherConfig.key === "nature-chemistry") nextUrl.searchParams.set("type", "article");
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
    if (row.published_date < (publisherConfig.cutoff || PUBLISHER_CUTOFF)) { reason = "cutoff"; break; }
    if (state.mode === "incremental" && known.has(row.doi)) { reason = "known-doi"; break; }
    pageRows.push(row);
  }
  if (!reason && NATURE_KEYS.has(publisherConfig.key) && pageRows.length !== rows.length) {
    throw new Error(`Nature 페이지 검증 실패: 감지 ${rows.length}편, 전송 ${pageRows.length}편`);
  }
  const batch = await publisherMessage({ type: "publisher-batch", payload: { articles: pageRows } });
  if (!reason && NATURE_KEYS.has(publisherConfig.key) && batch.received_count !== rows.length) {
    throw new Error(`Nature 전송 검증 실패: ${rows.length}편 대신 ${batch.received_count}편 전송`);
  }
  if (!reason && NATURE_KEYS.has(publisherConfig.key) && batch.added_count === 0) {
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
  const visiblePage = NATURE_KEYS.has(publisherConfig.key) || ACS_SEARCH_KEYS.has(publisherConfig.key)
    ? new URL(location.href).searchParams.get("page") || "1"
    : publisherConfig.key === "chemical-science"
      ? (location.pathname.match(/^\/sc\/issue\/(\d+)\/(\d+)/i)?.slice(1).join("권 · ") || "현재")
    : publisherConfig.key === "jcc" || publisherConfig.key === "angew"
      ? String(Number(new URL(location.href).searchParams.get("startPage") || "0") + 1)
      : state.pages;
  const pageBreakdown = NATURE_KEYS.has(publisherConfig.key)
    ? ` · 이번 ${rows.length}편 · 신규 고유 ${batch.added_count}편`
    : "";
  publisherPanel(`${visiblePage}페이지${pageBreakdown} · 누적 ${state.article_count}편`, true);
  if (reason) return finishPublisher(state, reason);
  if (state.pages >= PUBLISHER_MAX_PAGES) throw new Error(`${PUBLISHER_MAX_PAGES}페이지 안전 한도에 도달했습니다.`);
  if (publisherConfig.key === "chemical-science") {
    if (/latest-articles|advance-articles/i.test(location.pathname)) {
      return finishPublisher(state, "latest-page");
    } else {
      const issue = Number(location.pathname.match(/^\/sc\/issue\/\d+\/(\d+)/i)?.[1] || 0);
      if (issue <= 1) return finishPublisher(state, "last-issue");
    }
  } else if (NATURE_KEYS.has(publisherConfig.key) && !nextPublisherPage()) return finishPublisher(state, "last-page");
  else if (!ACS_SEARCH_KEYS.has(publisherConfig.key) && rows.length < 20) return finishPublisher(state, "short-page");
  if (!NATURE_KEYS.has(publisherConfig.key) && publisherConfig.key !== "chemical-science" && !ACS_SEARCH_KEYS.has(publisherConfig.key) && !nextPublisherPage()) return finishPublisher(state, "last-page");
  setTimeout(() => {
    loadPublisherState().then((latest) => {
      if (!latest?.running || latest.run_id !== state.run_id) return;
      if (!openNextPublisherPage()) finishPublisher(state, "last-page").catch((error) => publisherPanel(`오류: ${error.message}`));
    });
  }, 3500 + Math.floor(Math.random() * 2500));
}

async function startPublisherCollection() {
  if (ACS_SEARCH_KEYS.has(publisherConfig.key) && new URL(location.href).searchParams.get("f_ContentType") !== "Journal Articles") {
    throw new Error(`${publisherConfig.label} Content Type 필터가 없습니다. Journal Articles 필터 주소에서 시작하세요.`);
  }
  if (publisherConfig.key === "nature-chemistry" && new URL(location.href).searchParams.get("type") !== "article") {
    throw new Error("Nature Chemistry Article 필터 주소에서 시작하세요.");
  }
  if (publisherConfig.key === "nature-main" && new URL(location.href).searchParams.get("year") !== "2026") {
    throw new Error("Nature 2026 연도 필터 주소에서 시작하세요.");
  }
  if (publisherConfig.key === "chemical-science" && !(/^\/sc\/issue\/\d+\/\d+/i.test(location.pathname) || /latest-articles|advance-articles/i.test(location.pathname))) {
    throw new Error("Chemical Science 최신 논문 또는 Volume/Issue 주소에서 시작하세요.");
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
