const container = document.querySelector('#articles');
const empty = document.querySelector('#empty');
const search = document.querySelector('#search');
const loadMore = document.querySelector('#load-more');
const yearFilter = document.querySelector('#year-filter');
const profileGate = document.querySelector('#profile-gate');
const profileForm = document.querySelector('#profile-form');
const profileName = document.querySelector('#profile-name');
const scopeFilterButtons = [...document.querySelectorAll('.scope-filter')];
const journalFilterButtons = [...document.querySelectorAll('.journal-filter')];
const publicationCutoff = article => article.journal_short === 'JACS' ? '2025-01-01' : '2026-01-01';
const pageSize = 50;
const PROFILE_KEY = 'journalPulseProfile:v1';
const PROFILE_STATE_PREFIX = 'journalPulseState:v1:';
const PROFILE_INDEX_KEY = 'journalPulseProfileIndex:v1';
let payload = { articles: [], new_dois: [] };
let activeFilter = 'all';
let activeJournal = 'all';
let activeYear = 'all';
let visibleCount = pageSize;
let activeProfile = null;
let profileState = { read: {}, interesting: {} };

const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const journalDisplayName = value => ({ 'Nat Commun': 'Nat Commun', 'J. Comput. Chem.': 'JCC', 'Angew. Chem. Int. Ed.': 'Angew.' }[value] || value);
const profileStateKey = id => `${PROFILE_STATE_PREFIX}${id}`;

function loadProfile() {
  try {
    const profile = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null');
    if (!profile?.id || !profile.name) return false;
    activeProfile = profile;
    profileState = JSON.parse(localStorage.getItem(profileStateKey(profile.id)) || '{"read":{},"interesting":{},"notInteresting":{}}');
    profileState.notInteresting ||= {};
    return true;
  } catch { return false; }
}

function saveProfileState() {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(activeProfile));
  localStorage.setItem(profileStateKey(activeProfile.id), JSON.stringify(profileState));
  const index = JSON.parse(localStorage.getItem(PROFILE_INDEX_KEY) || '{}');
  index[activeProfile.name.toLocaleLowerCase()] = activeProfile.id;
  localStorage.setItem(PROFILE_INDEX_KEY, JSON.stringify(index));
}

function render(query = '') {
  const needle = query.trim().toLowerCase();
  const matchingRows = [...payload.articles]
    .filter(article => String(article.published_date || '') >= publicationCutoff(article))
    .filter(article => activeJournal === 'all' || article.journal_short === activeJournal)
    .filter(article => activeYear === 'all' || String(article.published_date || '').slice(0, 4) === activeYear)
    .filter(article => activeFilter !== 'new' || payload.new_dois.includes(article.doi))
    .filter(article => `${article.title} ${article.doi}`.toLowerCase().includes(needle))
    .sort((a, b) => String(b.published_date || '').localeCompare(String(a.published_date || '')) || String(b.doi || '').localeCompare(String(a.doi || '')));
  const rows = matchingRows.slice(0, visibleCount);
  const journalLabel = activeJournal === 'all' ? '모든 저널' : journalDisplayName(activeJournal);
  document.querySelector('#list-title').textContent = activeJournal === 'all' ? '최근 확인된 논문' : `${journalLabel} 최근 논문`;
  document.querySelector('#result-summary').textContent = `${journalLabel} · ${matchingRows.length.toLocaleString('ko-KR')}편`;
  container.innerHTML = rows.map((article, index) => {
    const isNew = payload.new_dois.includes(article.doi);
    const isRead = Boolean(profileState.read[article.doi]);
    const isInteresting = Boolean(profileState.interesting[article.doi]);
    const isNotInteresting = Boolean(profileState.notInteresting?.[article.doi]);
    return `<div class="article${isRead ? ' is-read' : ''}">
      <a class="article-link" href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer"><span class="number">${String(index + 1).padStart(2, '0')}</span><div><h3>${escapeHtml(article.title)}${isNew ? '<span class="new-badge">NEW</span>' : ''}</h3><div class="meta"><span class="article-journal">${escapeHtml(journalDisplayName(article.journal_short))}</span><span>${escapeHtml(article.published_date || 'Publication date pending')}</span><span class="doi">${escapeHtml(article.doi)}</span></div></div><span class="arrow" aria-hidden="true">→</span></a>
      <div class="article-actions"><label><input type="checkbox" class="read-toggle" data-doi="${escapeHtml(article.doi)}"${isRead ? ' checked' : ''}> 읽음</label><button type="button" class="interest-toggle${isInteresting ? ' is-active' : ''}" data-doi="${escapeHtml(article.doi)}" aria-pressed="${isInteresting}">★ 관심 있음</button><button type="button" class="not-interest-toggle${isNotInteresting ? ' is-active' : ''}" data-doi="${escapeHtml(article.doi)}" aria-pressed="${isNotInteresting}">관심 없음</button></div>
    </div>`;
  }).join('');
  container.hidden = rows.length === 0;
  empty.hidden = rows.length !== 0;
  loadMore.hidden = rows.length === 0 || rows.length >= matchingRows.length;
  loadMore.textContent = `논문 더 보기 (${matchingRows.length - rows.length}편 남음)`;
  container.querySelectorAll('.read-toggle').forEach(input => input.addEventListener('change', event => {
    profileState.read[event.target.dataset.doi] = event.target.checked;
    saveProfileState();
    event.target.closest('.article')?.classList.toggle('is-read', event.target.checked);
  }));
  container.querySelectorAll('.interest-toggle').forEach(button => button.addEventListener('click', event => {
    const doi = event.currentTarget.dataset.doi;
    profileState.interesting[doi] = !profileState.interesting[doi];
    if (profileState.interesting[doi]) profileState.notInteresting[doi] = false;
    saveProfileState();
    event.currentTarget.classList.toggle('is-active', profileState.interesting[doi]);
    event.currentTarget.setAttribute('aria-pressed', String(profileState.interesting[doi]));
    const opposite = container.querySelector(`.not-interest-toggle[data-doi="${CSS.escape(doi)}"]`);
    if (opposite) { opposite.classList.toggle('is-active', false); opposite.setAttribute('aria-pressed', 'false'); }
  }));
  container.querySelectorAll('.not-interest-toggle').forEach(button => button.addEventListener('click', event => {
    const doi = event.currentTarget.dataset.doi;
    profileState.notInteresting[doi] = !profileState.notInteresting[doi];
    if (profileState.notInteresting[doi]) profileState.interesting[doi] = false;
    saveProfileState();
    event.currentTarget.classList.toggle('is-active', profileState.notInteresting[doi]);
    event.currentTarget.setAttribute('aria-pressed', String(profileState.notInteresting[doi]));
    const opposite = container.querySelector(`.interest-toggle[data-doi="${CSS.escape(doi)}"]`);
    if (opposite) { opposite.classList.toggle('is-active', false); opposite.setAttribute('aria-pressed', 'false'); }
  }));
}

if (loadProfile()) profileGate.hidden = true;
else profileGate.hidden = false;
profileForm.addEventListener('submit', event => {
  event.preventDefault();
  const name = profileName.value.trim();
  if (!name) return;
  const index = JSON.parse(localStorage.getItem(PROFILE_INDEX_KEY) || '{}');
  const normalizedName = name.toLocaleLowerCase();
  const existingId = index[normalizedName];
  activeProfile = { name, id: existingId || crypto.randomUUID() };
  index[normalizedName] = activeProfile.id;
  localStorage.setItem(PROFILE_INDEX_KEY, JSON.stringify(index));
  profileState = JSON.parse(localStorage.getItem(profileStateKey(activeProfile.id)) || '{"read":{},"interesting":{},"notInteresting":{}}');
  profileState.notInteresting ||= {};
  saveProfileState();
  profileGate.hidden = true;
  render(search.value);
});

fetch('./data/articles.json', { cache: 'no-store' })
  .then(response => { if (!response.ok) throw new Error('Data unavailable'); return response.json(); })
  .then(data => {
    payload = data;
    const years = [...new Set(data.articles.map(article => String(article.published_date || '').slice(0, 4)).filter(year => /^20\d{2}$/.test(year)))].sort().reverse();
    yearFilter.innerHTML = '<option value="all">모든 연도</option>' + years.map(year => `<option value="${year}">${year}년</option>`).join('');
    const journalCounts = data.articles.reduce((counts, article) => { counts[article.journal_short] = (counts[article.journal_short] || 0) + 1; return counts; }, {});
    document.querySelector('#journal-count').textContent = Object.keys(journalCounts).length.toLocaleString('ko-KR');
    document.querySelector('#total-count').textContent = (data.total_count ?? data.articles.length).toLocaleString('ko-KR');
    document.querySelector('#new-count').textContent = (data.new_count ?? data.new_dois?.length ?? 0).toLocaleString('ko-KR');
    document.querySelector('#status-label').textContent = '마지막 확인 완료';
    document.querySelector('#checked-at').textContent = data.checked_at ? new Date(data.checked_at).toLocaleString('ko-KR') : '확인 시각 없음';
    render();
  })
  .catch(() => { document.querySelector('#status-label').textContent = '데이터 확인 대기 중'; document.querySelector('#checked-at').textContent = '잠시 후 다시 시도해 주세요'; render(); });

search.addEventListener('input', event => { visibleCount = pageSize; render(event.target.value); });
scopeFilterButtons.forEach(button => button.addEventListener('click', () => { activeFilter = button.dataset.filter; visibleCount = pageSize; scopeFilterButtons.forEach(item => item.classList.toggle('is-active', item === button)); render(search.value); }));
journalFilterButtons.forEach(button => button.addEventListener('click', () => { activeJournal = button.dataset.journal; visibleCount = pageSize; journalFilterButtons.forEach(item => item.classList.toggle('is-active', item === button)); render(search.value); }));
yearFilter.addEventListener('change', event => { activeYear = event.target.value; visibleCount = pageSize; render(search.value); });
loadMore.addEventListener('click', () => { visibleCount += pageSize; render(search.value); });
