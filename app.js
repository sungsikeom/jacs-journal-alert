const container = document.querySelector('#articles');
const empty = document.querySelector('#empty');
const search = document.querySelector('#search');
let payload = { articles: [], new_dois: [] };

const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));

function render(query = '') {
  const needle = query.trim().toLowerCase();
  const rows = payload.articles.filter(article => `${article.title} ${article.doi}`.toLowerCase().includes(needle));
  container.innerHTML = rows.map((article, index) => {
    const isNew = payload.new_dois.includes(article.doi);
    return `<a class="article" href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer">
      <span class="number">${String(index + 1).padStart(2, '0')}</span>
      <div><h3>${escapeHtml(article.title)}${isNew ? '<span class="new-badge">NEW</span>' : ''}</h3>
      <div class="meta"><span>${escapeHtml(article.journal_short)}</span><span>${escapeHtml(article.published_date || 'Publication date pending')}</span><span class="doi">${escapeHtml(article.doi)}</span></div></div>
      <span class="arrow" aria-hidden="true">↗</span></a>`;
  }).join('');
  container.hidden = rows.length === 0;
  empty.hidden = rows.length !== 0;
}

fetch('./data/articles.json', { cache: 'no-store' })
  .then(response => { if (!response.ok) throw new Error('Data unavailable'); return response.json(); })
  .then(data => {
    payload = data;
    document.querySelector('#new-count').textContent = data.new_count ?? 0;
    document.querySelector('#status-label').textContent = '마지막 확인 완료';
    document.querySelector('#checked-at').textContent = data.checked_at ? new Date(data.checked_at).toLocaleString('ko-KR') : '첫 업데이트 전';
    render();
  })
  .catch(() => {
    document.querySelector('#status-label').textContent = '첫 업데이트 대기 중';
    document.querySelector('#checked-at').textContent = 'GitHub Actions를 실행해 주세요';
    render();
  });

search.addEventListener('input', event => render(event.target.value));
