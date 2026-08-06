const container = document.querySelector('#articles');
const empty = document.querySelector('#empty');
const search = document.querySelector('#search');
const loadMore = document.querySelector('#load-more');
const scopeFilterButtons = [...document.querySelectorAll('.scope-filter')];
const journalFilterButtons = [...document.querySelectorAll('.journal-filter')];
const publicationCutoff = '2026-01-01';
const pageSize = 50;
let payload = { articles: [], new_dois: [] };
let activeFilter = 'all';
let activeJournal = 'all';
let visibleCount = pageSize;

const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
const journalDisplayName = value => ({
  'Nat Commun': 'Nat Commun',
  'J. Comput. Chem.': 'JCC',
  'Angew. Chem. Int. Ed.': 'Angew.',
}[value] || value);

function render(query = '') {
  const needle = query.trim().toLowerCase();
  const matchingRows = [...payload.articles]
    .filter(article => String(article.published_date || '') >= publicationCutoff)
    .filter(article => activeJournal === 'all' || article.journal_short === activeJournal)
    .filter(article => activeFilter !== 'new' || payload.new_dois.includes(article.doi))
    .filter(article => `${article.title} ${article.doi}`.toLowerCase().includes(needle))
    .sort((a, b) => {
      const byDate = String(b.published_date || '').localeCompare(String(a.published_date || ''));
      return byDate || String(b.doi || '').localeCompare(String(a.doi || ''));
    });
  const rows = matchingRows.slice(0, visibleCount);
  const journalLabel = activeJournal === 'all' ? '모든 저널' : journalDisplayName(activeJournal);
  document.querySelector('#list-title').textContent = activeJournal === 'all' ? '최근 확인된 논문' : `${journalLabel} 최근 논문`;
  document.querySelector('#result-summary').textContent = `${journalLabel} · ${matchingRows.length.toLocaleString('ko-KR')}편`;
  container.innerHTML = rows.map((article, index) => {
    const isNew = payload.new_dois.includes(article.doi);
    return `<a class="article" href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer">
      <span class="number">${String(index + 1).padStart(2, '0')}</span>
      <div><h3>${escapeHtml(article.title)}${isNew ? '<span class="new-badge">NEW</span>' : ''}</h3>
      <div class="meta"><span class="article-journal">${escapeHtml(journalDisplayName(article.journal_short))}</span><span>${escapeHtml(article.published_date || 'Publication date pending')}</span><span class="doi">${escapeHtml(article.doi)}</span></div></div>
      <span class="arrow" aria-hidden="true">↗</span></a>`;
  }).join('');
  container.hidden = rows.length === 0;
  empty.hidden = rows.length !== 0;
  loadMore.hidden = rows.length === 0 || rows.length >= matchingRows.length;
  loadMore.textContent = `논문 더 보기 (${matchingRows.length - rows.length}편 남음)`;
}

fetch('./data/articles.json', { cache: 'no-store' })
  .then(response => { if (!response.ok) throw new Error('Data unavailable'); return response.json(); })
  .then(data => {
    payload = data;
    const journalCounts = data.articles.reduce((counts, article) => {
      counts[article.journal_short] = (counts[article.journal_short] || 0) + 1;
      return counts;
    }, {});
    document.querySelector('#journal-count').textContent = Object.keys(journalCounts).length.toLocaleString('ko-KR');
    document.querySelector('#total-count').textContent = (data.total_count ?? data.articles.length).toLocaleString('ko-KR');
    document.querySelector('#new-count').textContent = (data.new_count ?? data.new_dois?.length ?? 0).toLocaleString('ko-KR');
    document.querySelector('#status-label').textContent = '마지막 확인 완료';
    document.querySelector('#checked-at').textContent = data.checked_at ? new Date(data.checked_at).toLocaleString('ko-KR') : '첫 업데이트 전';
    render();
  })
  .catch(() => {
    document.querySelector('#status-label').textContent = '첫 업데이트 대기 중';
    document.querySelector('#checked-at').textContent = 'GitHub Actions를 실행해 주세요';
    render();
  });

search.addEventListener('input', event => {
  visibleCount = pageSize;
  render(event.target.value);
});

scopeFilterButtons.forEach(button => button.addEventListener('click', () => {
  activeFilter = button.dataset.filter;
  visibleCount = pageSize;
  scopeFilterButtons.forEach(item => item.classList.toggle('is-active', item === button));
  render(search.value);
}));

journalFilterButtons.forEach(button => button.addEventListener('click', () => {
  activeJournal = button.dataset.journal;
  visibleCount = pageSize;
  journalFilterButtons.forEach(item => item.classList.toggle('is-active', item === button));
  render(search.value);
}));

loadMore.addEventListener('click', () => {
  visibleCount += pageSize;
  render(search.value);
});
