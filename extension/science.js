const SCIENCE_STATE_KEY = "scienceCollectorState";
const SCIENCE_CUTOFF = "2026-01-01";

function normalizeScienceDoi(value) {
  const match = String(value || "").match(/10\.1126\/science\.[^?#/\s]+/i);
  return match ? match[0].toLowerCase().replace(/[).,;]+$/, "") : "";
}

function scienceIsoDate(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const iso = text.match(/\b20\d{2}-\d{2}-\d{2}\b/);
  if (iso) return iso[0];
  const match = text.match(/\b(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(20\d{2})\b/i);
  if (!match) return null;
  const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  return `${match[3]}-${String(months[match[2].slice(0, 3).toLowerCase()]).padStart(2, "0")}-${String(match[1]).padStart(2, "0")}`;
}

function researchSection() {
  return [...document.querySelectorAll("section.toc__section")].find((section) =>
    [...section.querySelectorAll("h5.to-section")].some((heading) =>
      String(heading.textContent || "").replace(/\s+/g, " ").trim().toLowerCase() === "research articles"
    )
  );
}

function readScienceIssue() {
  const section = researchSection();
  if (!section) return [];
  let cards = [...section.querySelectorAll(":scope > .card")];
  if (!cards.length) {
    cards = [...section.querySelectorAll(".card")].filter((card) =>
      card.closest("section.toc__section") === section && !card.closest(".card-related")
    );
  }
  const byDoi = new Map();
  for (const card of cards) {
    const anchors = [...card.querySelectorAll('a[href*="/doi/"], a[href*="doi.org/"]')]
      .filter((anchor) => !anchor.closest(".card-related"));
    const doiAnchor = anchors.find((anchor) => normalizeScienceDoi(anchor.href) || normalizeScienceDoi(anchor.textContent));
    const doi = normalizeScienceDoi(doiAnchor?.href) || normalizeScienceDoi(doiAnchor?.textContent);
    if (!doi || byDoi.has(doi)) continue;
    const titleAnchor = card.querySelector('.card-title a[href*="/doi/"], h3 a[href*="/doi/"], h4 a[href*="/doi/"]') || doiAnchor;
    const title = String(titleAnchor?.textContent || doi).replace(/\s+/g, " ").trim();
    const publishedDate = scienceIsoDate(card.textContent);
    byDoi.set(doi, {
      doi,
      title,
      published_date: publishedDate,
      article_type: "Research Article",
      url: `https://doi.org/${doi}`,
    });
  }
  return [...byDoi.values()];
}

function previousIssueLink() {
  return [...document.querySelectorAll('a[href*="/toc/science/"]')].find((link) =>
    /^\s*previous issue\s*$/i.test(String(link.textContent || ""))
  ) || null;
}

function scienceMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!response?.ok) reject(new Error(response?.error || "Unknown extension error"));
      else resolve(response.payload);
    });
  });
}

function loadScienceState() {
  return new Promise((resolve) => chrome.storage.local.get(SCIENCE_STATE_KEY, (value) => resolve(value[SCIENCE_STATE_KEY] || null)));
}

function saveScienceState(state) {
  return new Promise((resolve) => chrome.storage.local.set({ [SCIENCE_STATE_KEY]: state }, resolve));
}

function sciencePanel(message, running = false) {
  let panel = document.querySelector("#science-collector-panel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "science-collector-panel";
    panel.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;width:390px;max-height:50vh;overflow:auto;background:#fff;border:1px solid #b31b1b;border-radius:8px;padding:12px;box-shadow:0 2px 12px #0003;font:12px Arial;color:#111";
    panel.innerHTML = '<div style="font-size:14px;font-weight:bold;margin-bottom:8px">Science Research Article Collector</div><div id="science-status"></div><div id="science-history" data-entries="[]" style="margin:8px 0;font-size:11px;color:#444"></div><button id="science-start" type="button">Science 수집 시작</button>';
    document.body.appendChild(panel);
    panel.querySelector("#science-start").addEventListener("click", () => startScienceCollection().catch((error) => sciencePanel(`오류: ${error.message}`, false)));
  }
  const status = panel.querySelector("#science-status");
  const history = panel.querySelector("#science-history");
  const button = panel.querySelector("#science-start");
  status.textContent = message;
  const entries = JSON.parse(history.dataset.entries || "[]");
  entries.push(`${new Date().toLocaleTimeString()} · ${message}`);
  history.dataset.entries = JSON.stringify(entries.slice(-7));
  history.innerHTML = entries.slice(-7).map((entry) => `<div>${entry}</div>`).join("");
  button.textContent = running ? "새 수집으로 초기화" : "Science 수집 시작";
}

async function waitForScienceRows() {
  let best = [];
  let stable = 0;
  let previous = -1;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const rows = readScienceIssue();
    if (rows.length > best.length) best = rows;
    stable = rows.length > 0 && rows.length === previous ? stable + 1 : 0;
    if (stable >= 2) return rows;
    previous = rows.length;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (best.length) return best;
  throw new Error("Research Articles 섹션 또는 논문 카드를 읽지 못했습니다.");
}

async function finishScience(state, reason) {
  sciencePanel(`저장 중: ${state.articles.length}편`, true);
  const result = await scienceMessage({
    type: "science-complete",
    payload: { mode: state.mode, reason, articles: state.articles },
  });
  await new Promise((resolve) => chrome.storage.local.remove(SCIENCE_STATE_KEY, resolve));
  sciencePanel(`완료: ${result.article_count}편 저장`, false);
}

async function processScienceIssue() {
  const state = await loadScienceState();
  if (!state?.running) return;
  if (state.visited.includes(location.href.split("#")[0])) throw new Error("같은 Science 호를 다시 방문했습니다.");
  sciencePanel(`진단: Science 호 진입 · 누적 ${state.articles.length}편`, true);
  const rows = await waitForScienceRows();
  const dates = rows.map((row) => row.published_date).filter(Boolean).sort();
  const issueDate = dates.at(-1) || null;
  if (!issueDate) throw new Error("Science 호의 발행일을 읽지 못했습니다.");

  const known = new Set(state.known_dois);
  const collected = new Set(state.articles.map((article) => article.doi));
  let foundKnown = false;
  for (const row of rows) {
    if (!row.published_date) throw new Error(`발행일을 읽지 못했습니다: ${row.doi}`);
    if (row.published_date < SCIENCE_CUTOFF) continue;
    if (state.mode === "incremental" && known.has(row.doi)) foundKnown = true;
    if (!collected.has(row.doi)) {
      state.articles.push(row);
      collected.add(row.doi);
    }
  }
  state.visited.push(location.href.split("#")[0]);
  state.issues += 1;
  await saveScienceState(state);
  const previous = previousIssueLink();
  sciencePanel(`${state.issues}개 호 · 이번 호 ${rows.length}편 · 누적 ${state.articles.length}편 · ${issueDate}`, true);

  if (foundKnown) {
    await finishScience(state, "known-doi");
    return;
  }
  if (rows.length < 20) {
    await finishScience(state, "short-page");
    return;
  }
  if (issueDate < SCIENCE_CUTOFF || !previous) {
    await finishScience(state, issueDate < SCIENCE_CUTOFF ? "cutoff" : "last-issue");
    return;
  }
  setTimeout(() => { location.href = previous.href; }, 5000 + Math.floor(Math.random() * 3000));
}

async function startScienceCollection() {
  sciencePanel("로컬 수신기 연결 중", true);
  const baseline = await scienceMessage({ type: "science-baseline" });
  const state = {
    running: true,
    mode: baseline.known_dois.length ? "incremental" : "baseline",
    known_dois: baseline.known_dois,
    articles: [],
    issues: 0,
    visited: [],
  };
  await saveScienceState(state);
  if (!/\/toc\/science\/current\/?$/i.test(location.pathname)) {
    location.href = "https://www.science.org/toc/science/current#science-auto";
    return;
  }
  await processScienceIssue();
}

sciencePanel(`현재 호 진단: Research Article ${readScienceIssue().length}편 · Previous issue ${previousIssueLink() ? "있음" : "없음"}`, false);
loadScienceState().then((state) => {
  if (state?.running) {
    processScienceIssue().catch((error) => sciencePanel(`오류: ${error.message}`, false));
  } else if (location.hash === "#science-auto") {
    startScienceCollection().catch((error) => sciencePanel(`오류: ${error.message}`, false));
  }
});
