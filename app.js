const container = document.querySelector('#articles');
const empty = document.querySelector('#empty');
const search = document.querySelector('#search');
const loadMore = document.querySelector('#load-more');
const yearFilter = document.querySelector('#year-filter');
const profileGate = document.querySelector('#profile-gate');
const profileForm = document.querySelector('#profile-form');
const profileName = document.querySelector('#profile-name');
const profileReset = document.querySelector('#profile-reset');
const profileTitle = document.querySelector('#profile-title');
const profileDescription = document.querySelector('#profile-description');
const profileSubmit = document.querySelector('#profile-submit');
const profileCancel = document.querySelector('#profile-cancel');
const scopeFilterButtons = [...document.querySelectorAll('.scope-filter')];
const journalFilterButtons = [...document.querySelectorAll('.journal-filter')];
const publicationCutoff = article => article.journal_short === 'JACS' ? '2025-01-01' : '2026-01-01';
const pageSize = 50;
const PROFILE_KEY = 'journalPulseProfile:v1';
const PROFILE_STATE_PREFIX = 'journalPulseState:v1:';
const PROFILE_INDEX_KEY = 'journalPulseProfileIndex:v1';
const COMMENTS_API_URL = 'https://journal-pulse-comments.sungsikeom886704.chatgpt.site/api/comments';
const PROFILE_STATE_API_URL = 'https://journal-pulse-comments.sungsikeom886704.chatgpt.site/api/profile-state';
const COMMENT_MIGRATION_PREFIX = 'journalPulseCommentsMigrated:v2:';
const COMMENT_OWNERSHIP_MIGRATION_PREFIX = 'journalPulseCommentOwnerMigrated:v3:';
const PROFILE_STATE_MIGRATION_PREFIX = 'journalPulseProfileStateMigrated:v2:';
let payload = { articles: [], new_dois: [] };
let activeFilter = 'all';
const activeJournals = new Set();
let activeYear = 'all';
let visibleCount = pageSize;
let activeProfile = null;
let profileState = { read: {}, interesting: {} };
let sharedComments = {};
let profileStateMutationVersion = 0;
let profileStateSyncPromise = null;
let profileStateSyncProfileId = null;

const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const journalDisplayName = value => ({ 'Nat Commun': 'Nat Commun', 'J. Comput. Chem.': 'JCC', 'Angew. Chem. Int. Ed.': 'Angew.' }[value] || value);
const profileStateKey = id => `${PROFILE_STATE_PREFIX}${id}`;

function normalizeProfileId(value) {
  return String(value || '').trim().normalize('NFKC').toLocaleLowerCase('ko-KR');
}

function profileAuthor(value) {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(normalizeProfileId(value))) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  hash ^= hash >>> 16;
  return `A${String((hash >>> 0) % 1000000).padStart(6, '0')}`;
}

function commentOwnerCredential(value = activeProfile?.name) {
  const bytes = new TextEncoder().encode(normalizeProfileId(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return encoded ? `profile-v1:${encoded}`.padEnd(32, '_') : '';
}

function ensureCommentIdentity() {
  if (!activeProfile) return;
  activeProfile.author = profileAuthor(activeProfile.name);
  localStorage.setItem(PROFILE_KEY, JSON.stringify(activeProfile));
}

function openProfileEditor() {
  if (!activeProfile) return;
  profileTitle.textContent = '아이디 재설정';
  profileDescription.textContent = '새 아이디를 입력하면 댓글 권한과 작성자 코드가 해당 아이디로 전환됩니다.';
  profileSubmit.textContent = '아이디 적용';
  profileCancel.hidden = false;
  profileName.value = activeProfile.name;
  profileGate.hidden = false;
  requestAnimationFrame(() => {
    profileName.focus();
    profileName.select();
  });
}

function closeProfileEditor() {
  if (!activeProfile) return;
  profileGate.hidden = true;
  profileName.value = '';
}

function loadProfile() {
  try {
    const profile = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null');
    if (!profile?.id || !profile.name) return false;
    activeProfile = profile;
    ensureCommentIdentity();
    profileState = JSON.parse(localStorage.getItem(profileStateKey(profile.id)) || '{"read":{},"interesting":{},"notInteresting":{}}');
    profileState.notInteresting ||= {};
    profileState.comments ||= {};
    return true;
  } catch { return false; }
}

function saveProfileState() {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(activeProfile));
  localStorage.setItem(profileStateKey(activeProfile.id), JSON.stringify(profileState));
  const index = JSON.parse(localStorage.getItem(PROFILE_INDEX_KEY) || '{}');
  index[normalizeProfileId(activeProfile.name)] = activeProfile.id;
  localStorage.setItem(PROFILE_INDEX_KEY, JSON.stringify(index));
}

function commentsFor(doi) {
  return sharedComments[String(doi || '').toLowerCase()] || [];
}

async function commentRequest(method = 'GET', body = null, owner = commentOwnerCredential()) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (owner) headers['X-Comment-Owner'] = owner;
  const response = await fetch(COMMENTS_API_URL, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '댓글 서버에 연결하지 못했습니다.');
  return data;
}

async function profileStateRequest(method = 'GET', body = null, owner = commentOwnerCredential()) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (owner) headers['X-Profile-Owner'] = owner;
  const response = await fetch(PROFILE_STATE_API_URL, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '프로필 설정 서버에 연결하지 못했습니다.');
  return data;
}

function profileStatePayload() {
  return {
    read: Object.fromEntries(Object.entries(profileState.read || {}).filter(([, value]) => value === true)),
    interesting: Object.fromEntries(Object.entries(profileState.interesting || {}).filter(([, value]) => value === true)),
    notInteresting: Object.fromEntries(Object.entries(profileState.notInteresting || {}).filter(([, value]) => value === true)),
  };
}

function replaceProfileState(remoteState) {
  profileState = {
    read: remoteState?.read && typeof remoteState.read === 'object' ? remoteState.read : {},
    interesting: remoteState?.interesting && typeof remoteState.interesting === 'object' ? remoteState.interesting : {},
    notInteresting: remoteState?.notInteresting && typeof remoteState.notInteresting === 'object' ? remoteState.notInteresting : {},
    comments: profileState.comments || {},
  };
  saveProfileState();
}

function setProfileFlag(group, doi, value) {
  profileState[group] ||= {};
  if (value) profileState[group][doi] = true;
  else delete profileState[group][doi];
}

async function persistProfileArticleState(doi, patch) {
  const data = await profileStateRequest('PATCH', { doi, ...patch });
  if (!data.article) throw new Error('저장된 프로필 설정을 확인하지 못했습니다.');
  setProfileFlag('read', doi, data.article.read);
  setProfileFlag('interesting', doi, data.article.interesting);
  setProfileFlag('notInteresting', doi, data.article.notInteresting);
  saveProfileState();
  return data.article;
}

function syncProfileState() {
  if (!activeProfile) return Promise.resolve(false);
  const profileId = activeProfile.id;
  if (profileStateSyncPromise && profileStateSyncProfileId === profileId) return profileStateSyncPromise;
  const owner = commentOwnerCredential();
  const mutationVersion = profileStateMutationVersion;
  const syncPromise = (async () => {
    const migrationKey = `${PROFILE_STATE_MIGRATION_PREFIX}${profileId}`;
    const data = localStorage.getItem(migrationKey)
      ? await profileStateRequest('GET', null, owner)
      : await profileStateRequest('POST', { state: profileStatePayload() }, owner);
    if (!localStorage.getItem(migrationKey)) localStorage.setItem(migrationKey, new Date().toISOString());
    if (activeProfile?.id !== profileId || profileStateMutationVersion !== mutationVersion) return false;
    replaceProfileState(data.state);
    render(search.value);
    return true;
  })().catch(error => {
    console.error('Profile state unavailable:', error);
    return false;
  }).finally(() => {
    if (profileStateSyncPromise === syncPromise) {
      profileStateSyncPromise = null;
      profileStateSyncProfileId = null;
    }
  });
  profileStateSyncPromise = syncPromise;
  profileStateSyncProfileId = profileId;
  return syncPromise;
}

function indexSharedComments(comments) {
  sharedComments = {};
  for (const comment of comments || []) {
    const doi = String(comment.doi || '').toLowerCase();
    if (!doi) continue;
    (sharedComments[doi] ||= []).push(comment);
  }
}

function legacyCommentsForMigration() {
  const rows = [];
  let normalized = false;
  for (const [doi, saved] of Object.entries(profileState.comments || {})) {
    const comments = Array.isArray(saved) ? saved : typeof saved === 'string' && saved.trim() ? [{ text: saved.trim() }] : [];
    const prepared = comments.filter(comment => String(comment?.text || '').trim()).map(comment => {
      const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(comment.id || '') ? comment.id : crypto.randomUUID();
      if (id !== comment.id) normalized = true;
      return { ...comment, id, author: /^A\d{6}$/.test(comment.author || '') ? comment.author : activeProfile.author, text: String(comment.text).trim() };
    });
    profileState.comments[doi] = prepared;
    prepared.forEach(comment => rows.push({ id: comment.id, doi, author: comment.author, text: comment.text }));
  }
  if (normalized) saveProfileState();
  return rows;
}

async function migrateLocalComments() {
  if (!activeProfile) return false;
  const migrationKey = `${COMMENT_MIGRATION_PREFIX}${activeProfile.id}`;
  if (localStorage.getItem(migrationKey)) return false;
  const comments = legacyCommentsForMigration();
  for (const comment of comments) await commentRequest('POST', comment);
  localStorage.setItem(migrationKey, new Date().toISOString());
  return comments.length > 0;
}

async function migrateCommentOwnership() {
  if (!activeProfile?.commentSecret) return false;
  const migrationKey = `${COMMENT_OWNERSHIP_MIGRATION_PREFIX}${activeProfile.id}`;
  if (localStorage.getItem(migrationKey)) return false;
  const previousOwner = activeProfile.commentSecret;
  const data = await commentRequest('PUT', { owner: commentOwnerCredential(), author: activeProfile.author }, previousOwner);
  localStorage.setItem(migrationKey, new Date().toISOString());
  delete activeProfile.commentSecret;
  saveProfileState();
  return Number(data.migrated || 0) > 0;
}

async function syncSharedComments() {
  try {
    await migrateCommentOwnership();
  } catch (error) {
    console.error('Comment ownership migration unavailable:', error);
  }
  try {
    let data = await commentRequest();
    indexSharedComments(data.comments);
    if (await migrateLocalComments()) {
      data = await commentRequest();
      indexSharedComments(data.comments);
    }
  } catch (error) {
    console.error('Shared comments unavailable:', error);
  }
  render(search.value);
}

function render(query = '') {
  const needle = query.trim().toLowerCase();
  const matchingRows = [...payload.articles]
    .filter(article => String(article.published_date || '') >= publicationCutoff(article))
    .filter(article => activeJournals.size === 0 || activeJournals.has(article.journal_short))
    .filter(article => activeYear === 'all' || String(article.published_date || '').slice(0, 4) === activeYear)
    .filter(article => activeFilter === 'all'
      || (activeFilter === 'new' && payload.new_dois.includes(article.doi))
      || (activeFilter === 'read' && profileState.read[article.doi])
      || (activeFilter === 'interesting' && profileState.interesting[article.doi])
      || (activeFilter === 'notInteresting' && profileState.notInteresting?.[article.doi]))
    .filter(article => `${article.title} ${article.doi} ${commentsFor(article.doi).map(comment => comment.text).join(' ')}`.toLowerCase().includes(needle))
    .sort((a, b) => String(b.published_date || '').localeCompare(String(a.published_date || '')) || String(b.doi || '').localeCompare(String(a.doi || '')));
  const rows = matchingRows.slice(0, visibleCount);
  const selectedJournalLabels = [...activeJournals].map(journalDisplayName);
  const journalLabel = selectedJournalLabels.length ? selectedJournalLabels.join(' · ') : '모든 저널';
  document.querySelector('#list-title').textContent = selectedJournalLabels.length ? `${journalLabel} 최근 논문` : '최근 확인된 논문';
  document.querySelector('#result-summary').textContent = `${journalLabel} · ${matchingRows.length.toLocaleString('ko-KR')}편`;
  container.innerHTML = rows.map((article, index) => {
    const isNew = payload.new_dois.includes(article.doi);
    const isRead = Boolean(profileState.read[article.doi]);
    const isInteresting = Boolean(profileState.interesting[article.doi]);
    const isNotInteresting = Boolean(profileState.notInteresting?.[article.doi]);
    const comments = commentsFor(article.doi);
    const commentsMarkup = comments.map(comment => `<div class="comment-item"><p class="comment-text"><b>${escapeHtml(comment.author)}</b> ${escapeHtml(comment.text)}</p>${comment.mine ? `<div class="comment-owner-actions"><button type="button" class="comment-edit" data-doi="${escapeHtml(article.doi)}" data-comment-id="${escapeHtml(comment.id)}">수정</button><button type="button" class="comment-delete" data-doi="${escapeHtml(article.doi)}" data-comment-id="${escapeHtml(comment.id)}">삭제</button></div>` : ''}</div>`).join('');
    return `<div class="article${isRead ? ' is-read' : ''}">
      <div class="article-main"><span class="number">${String(index + 1).padStart(2, '0')}</span><div class="article-copy"><a class="article-title" href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer"><h3>${escapeHtml(article.title)}${isNew ? '<span class="new-badge">NEW</span>' : ''}</h3></a><div class="meta"><span class="article-journal">${escapeHtml(journalDisplayName(article.journal_short))}</span><span>${escapeHtml(article.published_date || 'Publication date pending')}</span><span class="doi">${escapeHtml(article.doi)}</span><div class="article-toolbar"><div class="article-actions"><label><input type="checkbox" class="read-toggle" data-doi="${escapeHtml(article.doi)}"${isRead ? ' checked' : ''}> 살펴봄</label><button type="button" class="interest-toggle${isInteresting ? ' is-active' : ''}" data-doi="${escapeHtml(article.doi)}" aria-pressed="${isInteresting}">★ 관심 있음</button><button type="button" class="not-interest-toggle${isNotInteresting ? ' is-active' : ''}" data-doi="${escapeHtml(article.doi)}" aria-pressed="${isNotInteresting}">관심 없음</button></div><button type="button" class="comment-toggle" data-doi="${escapeHtml(article.doi)}">댓글${comments.length ? ` ${comments.length}` : ''}</button></div></div></div><a class="article-open" href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer" aria-label="논문 열기">→</a></div>
      <form class="comment-form is-collapsed" data-doi="${escapeHtml(article.doi)}"><span>${escapeHtml(activeProfile?.author || '익명')}</span><input name="comment" maxlength="500" value="" placeholder="댓글을 남겨보세요"><button type="submit">저장</button><small class="comment-feedback" aria-live="polite"></small></form>
      ${commentsMarkup}
    </div>`;
  }).join('');
  container.hidden = rows.length === 0;
  empty.hidden = rows.length !== 0;
  loadMore.hidden = rows.length === 0 || rows.length >= matchingRows.length;
  loadMore.textContent = `논문 더 보기 (${matchingRows.length - rows.length}편 남음)`;
  container.querySelectorAll('.read-toggle').forEach(input => input.addEventListener('change', async event => {
    const doi = event.target.dataset.doi;
    const previous = Boolean(profileState.read[doi]);
    const next = event.target.checked;
    profileStateMutationVersion += 1;
    setProfileFlag('read', doi, next);
    saveProfileState();
    event.target.closest('.article')?.classList.toggle('is-read', next);
    event.target.disabled = true;
    try {
      await persistProfileArticleState(doi, { read: next });
      event.target.disabled = false;
    } catch (error) {
      setProfileFlag('read', doi, previous);
      saveProfileState();
      render(search.value);
      window.alert(error.message);
    }
  }));
  container.querySelectorAll('.interest-toggle').forEach(button => button.addEventListener('click', async event => {
    const doi = event.currentTarget.dataset.doi;
    const previousInteresting = Boolean(profileState.interesting[doi]);
    const previousNotInteresting = Boolean(profileState.notInteresting[doi]);
    const next = !previousInteresting;
    profileStateMutationVersion += 1;
    setProfileFlag('interesting', doi, next);
    if (next) setProfileFlag('notInteresting', doi, false);
    saveProfileState();
    event.currentTarget.classList.toggle('is-active', next);
    event.currentTarget.setAttribute('aria-pressed', String(next));
    const opposite = container.querySelector(`.not-interest-toggle[data-doi="${CSS.escape(doi)}"]`);
    if (opposite) { opposite.classList.toggle('is-active', false); opposite.setAttribute('aria-pressed', 'false'); }
    event.currentTarget.disabled = true;
    try {
      await persistProfileArticleState(doi, { interesting: next, notInteresting: next ? false : previousNotInteresting });
      event.currentTarget.disabled = false;
    } catch (error) {
      setProfileFlag('interesting', doi, previousInteresting);
      setProfileFlag('notInteresting', doi, previousNotInteresting);
      saveProfileState();
      render(search.value);
      window.alert(error.message);
    }
  }));
  container.querySelectorAll('.not-interest-toggle').forEach(button => button.addEventListener('click', async event => {
    const doi = event.currentTarget.dataset.doi;
    const previousNotInteresting = Boolean(profileState.notInteresting[doi]);
    const previousInteresting = Boolean(profileState.interesting[doi]);
    const next = !previousNotInteresting;
    profileStateMutationVersion += 1;
    setProfileFlag('notInteresting', doi, next);
    if (next) setProfileFlag('interesting', doi, false);
    saveProfileState();
    event.currentTarget.classList.toggle('is-active', next);
    event.currentTarget.setAttribute('aria-pressed', String(next));
    const opposite = container.querySelector(`.interest-toggle[data-doi="${CSS.escape(doi)}"]`);
    if (opposite) { opposite.classList.toggle('is-active', false); opposite.setAttribute('aria-pressed', 'false'); }
    event.currentTarget.disabled = true;
    try {
      await persistProfileArticleState(doi, { notInteresting: next, interesting: next ? false : previousInteresting });
      event.currentTarget.disabled = false;
    } catch (error) {
      setProfileFlag('notInteresting', doi, previousNotInteresting);
      setProfileFlag('interesting', doi, previousInteresting);
      saveProfileState();
      render(search.value);
      window.alert(error.message);
    }
  }));
  container.querySelectorAll('.comment-form').forEach(form => form.addEventListener('submit', async event => {
    event.preventDefault();
    const currentForm = event.currentTarget;
    const doi = currentForm.dataset.doi;
    const doiKey = doi.toLowerCase();
    const value = String(new FormData(currentForm).get('comment') || '').trim();
    if (!value) return;
    const comments = commentsFor(doi);
    const editId = currentForm.dataset.editId;
    const editing = editId ? comments.find(comment => comment.id === editId && comment.mine) : null;
    const submitButton = currentForm.querySelector('button[type="submit"]');
    const feedback = currentForm.querySelector('.comment-feedback');
    submitButton.disabled = true;
    feedback.textContent = '저장 중…';
    try {
      const data = editing
        ? await commentRequest('PATCH', { id: editing.id, text: value })
        : await commentRequest('POST', { id: crypto.randomUUID(), doi, author: activeProfile.author, text: value });
      if (editing) sharedComments[doiKey] = comments.map(comment => comment.id === editing.id ? data.comment : comment);
      else (sharedComments[doiKey] ||= []).push(data.comment);
      render(search.value);
    } catch (error) {
      submitButton.disabled = false;
      feedback.textContent = error.message;
    }
  }));
  container.querySelectorAll('.comment-toggle').forEach(button => button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    const form = container.querySelector(`.comment-form[data-doi="${CSS.escape(event.currentTarget.dataset.doi)}"]`);
    if (!form) return;
    form.classList.toggle('is-collapsed');
    if (!form.classList.contains('is-collapsed')) {
      delete form.dataset.editId;
      form.querySelector('input').value = '';
      form.querySelector('input')?.focus();
    }
  }));
  container.querySelectorAll('.comment-edit').forEach(button => button.addEventListener('click', event => {
    const doi = event.currentTarget.dataset.doi;
    const comment = commentsFor(doi).find(item => item.id === event.currentTarget.dataset.commentId && item.mine);
    const form = container.querySelector(`.comment-form[data-doi="${CSS.escape(doi)}"]`);
    if (!comment || !form) return;
    form.dataset.editId = comment.id;
    form.querySelector('input').value = comment.text;
    form.classList.remove('is-collapsed');
    form.querySelector('input')?.focus();
  }));
  container.querySelectorAll('.comment-delete').forEach(button => button.addEventListener('click', async event => {
    const doi = event.currentTarget.dataset.doi;
    const doiKey = doi.toLowerCase();
    const commentId = event.currentTarget.dataset.commentId;
    event.currentTarget.disabled = true;
    try {
      await commentRequest('DELETE', { id: commentId });
      sharedComments[doiKey] = commentsFor(doi).filter(comment => comment.id !== commentId);
      if (!sharedComments[doiKey].length) delete sharedComments[doiKey];
      render(search.value);
    } catch (error) {
      event.currentTarget.disabled = false;
      window.alert(error.message);
    }
  }));
}

if (loadProfile()) profileGate.hidden = true;
else profileGate.hidden = false;
profileReset.addEventListener('click', openProfileEditor);
profileCancel.addEventListener('click', closeProfileEditor);
profileForm.addEventListener('submit', event => {
  event.preventDefault();
  const name = profileName.value.trim();
  if (!name) return;
  const index = JSON.parse(localStorage.getItem(PROFILE_INDEX_KEY) || '{}');
  const normalizedName = normalizeProfileId(name);
  const existingId = index[normalizedName];
  activeProfile = { name, id: existingId || crypto.randomUUID() };
  index[normalizedName] = activeProfile.id;
  localStorage.setItem(PROFILE_INDEX_KEY, JSON.stringify(index));
  profileState = JSON.parse(localStorage.getItem(profileStateKey(activeProfile.id)) || '{"read":{},"interesting":{},"notInteresting":{},"comments":{}}');
  profileState.notInteresting ||= {};
  profileState.comments ||= {};
  ensureCommentIdentity();
  saveProfileState();
  profileGate.hidden = true;
  render(search.value);
  syncSharedComments();
  syncProfileState();
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
    syncSharedComments();
    syncProfileState();
  })
  .catch(() => { document.querySelector('#status-label').textContent = '데이터 확인 대기 중'; document.querySelector('#checked-at').textContent = '잠시 후 다시 시도해 주세요'; render(); });

search.addEventListener('input', event => { visibleCount = pageSize; render(event.target.value); });
scopeFilterButtons.forEach(button => button.addEventListener('click', () => { activeFilter = button.dataset.filter; visibleCount = pageSize; scopeFilterButtons.forEach(item => item.classList.toggle('is-active', item === button)); render(search.value); }));
journalFilterButtons.forEach(button => button.addEventListener('click', () => {
  const journal = button.dataset.journal;
  if (journal === 'all') activeJournals.clear();
  else if (activeJournals.has(journal)) activeJournals.delete(journal);
  else activeJournals.add(journal);
  visibleCount = pageSize;
  journalFilterButtons.forEach(item => {
    const selected = item.dataset.journal === 'all' ? activeJournals.size === 0 : activeJournals.has(item.dataset.journal);
    item.classList.toggle('is-active', selected);
    item.setAttribute('aria-pressed', String(selected));
  });
  render(search.value);
}));
yearFilter.addEventListener('change', event => { activeYear = event.target.value; visibleCount = pageSize; render(search.value); });
loadMore.addEventListener('click', () => { visibleCount += pageSize; render(search.value); });
