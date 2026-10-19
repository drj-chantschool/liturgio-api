'use strict';

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  items: [],          // IntakeSummary list for the current filters
  item: null,         // IntakeItem (full) currently shown
  pageIdx: 0,         // which of item.pages is selected
  pageOffset: 0,      // ◀ ▶ browsing relative to that page
  canAnswer: false,
  filters: { status: 'open', book: '', category: '', q: '' },
};

const STATUS_LABELS = {
  open: 'Open', answered: 'Answered', claimed: 'In progress', done: 'Done', withdrawn: 'Withdrawn',
};

const $ = id => document.getElementById(id);

// ── API ──────────────────────────────────────────────────────────────────────
async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch (_) {}
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function shortDate(iso) {
  return iso ? iso.replace('T', ' ').slice(0, 16) : '';
}

// ── Filters ──────────────────────────────────────────────────────────────────
async function loadFacets() {
  const f = await api('/api/intake_queue/facets');
  const chips = $('iq-status-chips');
  chips.innerHTML = '';
  for (const [s, label] of [...Object.entries(STATUS_LABELS), ['', 'All']]) {
    const b = document.createElement('button');
    b.className = 'chip' + (state.filters.status === s ? ' active' : '');
    b.dataset.status = s;
    const n = s ? f.status_counts[s] : Object.values(f.status_counts).reduce((a, x) => a + x, 0);
    b.innerHTML = `${label}<span class="iq-count">${n}</span>`;
    chips.appendChild(b);
  }
  fillSelect($('iq-book'), f.books, 'All books', state.filters.book);
  fillSelect($('iq-category'), f.categories, 'All categories', state.filters.category);
  const open = f.status_counts.open, answered = f.status_counts.answered;
  $('iq-stats-badge').textContent = `${open} open · ${answered} awaiting an agent`;
}

function fillSelect(sel, values, allLabel, current) {
  sel.innerHTML = `<option value="">${allLabel}</option>` +
    values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  sel.value = values.includes(current) ? current : '';
}

$('iq-status-chips').addEventListener('click', e => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  state.filters.status = btn.dataset.status;
  $('iq-status-chips').querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === btn));
  loadList();
});
$('iq-book').addEventListener('change', e => { state.filters.book = e.target.value; loadList(); });
$('iq-category').addEventListener('change', e => { state.filters.category = e.target.value; loadList(); });
let searchTimer = null;
$('iq-search').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.filters.q = e.target.value.trim(); loadList(); }, 250);
});

// ── List ─────────────────────────────────────────────────────────────────────
async function loadList() {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(state.filters)) if (v) p.set(k, v);
  if (!state.filters.status) p.set('status', '');
  try {
    state.items = await api('/api/intake_queue?' + p.toString());
  } catch (e) {
    $('iq-list').innerHTML = `<li class="iq-item">Error: ${escapeHtml(e.message)}</li>`;
    return;
  }
  renderList();
}

function renderList() {
  const ul = $('iq-list');
  ul.innerHTML = '';
  $('iq-list-count').textContent = `${state.items.length} question${state.items.length === 1 ? '' : 's'}`;
  for (const it of state.items) {
    const li = document.createElement('li');
    li.className = 'iq-item' + (state.item && state.item.question_id === it.question_id ? ' selected' : '');
    li.dataset.id = it.question_id;
    const pg = it.first_page ? `p.${it.first_page}${it.page_count > 1 ? ` +${it.page_count - 1}` : ''}` : '';
    const prio = it.priority ? `<span class="iq-prio" title="priority">★${it.priority}</span>` : '';
    const st = state.filters.status ? '' : `<span class="iq-pill st-${it.status}">${STATUS_LABELS[it.status]}</span>`;
    li.innerHTML =
      `<div class="iq-item-top">${st}<span>#${it.question_id}</span>` +
      `<span class="iq-cat">${escapeHtml(it.category)}</span>${prio}` +
      `<span class="iq-pg">${escapeHtml(it.book ? shortBook(it.book) + ' ' : '')}${escapeHtml(pg)}</span></div>` +
      `<div class="iq-item-title">${escapeHtml(it.title)}</div>`;
    li.addEventListener('click', () => selectItem(it.question_id));
    ul.appendChild(li);
  }
}

function shortBook(book) {
  return { LIBER_HYMNARIUS: 'LH', GRADUALE: 'GR', GREGORIAN_MISSAL: 'GM' }[book] || book;
}

// ── Detail ───────────────────────────────────────────────────────────────────
async function selectItem(id, { focusAnswer = false } = {}) {
  let item;
  try {
    item = await api(`/api/intake_queue/${id}`);
  } catch (e) {
    $('iq-answer-msg').textContent = 'Error: ' + e.message;
    return;
  }
  state.item = item;
  state.pageIdx = 0;
  state.pageOffset = 0;
  history.replaceState(null, '', `/intake?id=${id}`);
  renderList();
  $('iq-empty-state').hidden = true;
  $('iq-detail').hidden = false;
  renderDetail();
  if (focusAnswer && !$('iq-answer').disabled) $('iq-answer').focus();
}

function renderDetail() {
  const it = state.item;
  $('iq-status-pill').className = `iq-pill st-${it.status}`;
  $('iq-status-pill').textContent = STATUS_LABELS[it.status];
  $('iq-title').textContent = it.title;
  $('iq-meta').textContent = [
    `#${it.question_id}`, it.pipeline, it.category, it.book,
    it.priority ? `priority ${it.priority}` : null,
    `raised ${shortDate(it.raised_at)} by ${it.raised_by}`,
    it.topic_key ? `topic ${it.topic_key}` : null,
  ].filter(Boolean).join(' · ');

  renderPages();
  $('iq-prompt').innerHTML = linkifyPages(escapeHtml(it.prompt));
  renderOptions();
  renderChants();
  renderRefs();
  renderContext();
  renderRelated();
  renderAnswer();
}

// Prompt page references ("p.16", "p. 255", "pp. 604") open that page of the
// question's book in the viewer.
function linkifyPages(html) {
  if (!state.item.book) return html;
  return html.replace(/\b(pp?\.\s?)(\d{1,4})\b/g,
    (m, pre, n) => `${pre}<a class="iq-pg-link" data-page="${n}">${n}</a>`);
}

$('iq-prompt').addEventListener('click', e => {
  const a = e.target.closest('.iq-pg-link');
  if (!a) return;
  showPage(state.item.book, a.dataset.page);
});

// ── Pages ────────────────────────────────────────────────────────────────────
function renderPages() {
  const pages = state.item.pages;
  const tabs = $('iq-page-tabs');
  tabs.innerHTML = '';
  pages.forEach((p, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'iq-tab' + (i === state.pageIdx ? ' active' : '');
    b.textContent = `${shortBook(p.book)} p.${p.page}`;
    b.title = p.note || '';
    b.addEventListener('click', () => { state.pageIdx = i; state.pageOffset = 0; renderPages(); });
    tabs.appendChild(b);
  });
  const none = !pages.length;
  $('iq-no-pages').hidden = !none;
  $('iq-page-toolbar').hidden = none;
  if (none) {
    $('iq-page-img').hidden = true;
    $('iq-page-missing').hidden = true;
    $('iq-page-note').textContent = '';
    return;
  }
  const p = pages[state.pageIdx];
  $('iq-page-note').textContent = state.pageOffset ? '' : (p.note || '');
  const numeric = /^\d+$/.test(p.page);
  const page = numeric ? String(Number(p.page) + state.pageOffset) : p.page;
  $('iq-page-prev').disabled = !numeric;
  $('iq-page-next').disabled = !numeric;
  $('iq-page-offset').textContent = state.pageOffset
    ? `${state.pageOffset > 0 ? '+' : ''}${state.pageOffset} from cited page` : '';
  loadImage(p.book, page);
}

// A page that isn't one of the cited pages (prompt link): show it without a tab.
function showPage(book, page) {
  const i = state.item.pages.findIndex(p => p.book === book && p.page === page);
  if (i >= 0) {
    state.pageIdx = i;
    state.pageOffset = 0;
    renderPages();
    return;
  }
  const base = state.item.pages[state.pageIdx];
  if (base && base.book === book && /^\d+$/.test(base.page) && /^\d+$/.test(page)) {
    state.pageOffset = Number(page) - Number(base.page);
    renderPages();
  } else {
    $('iq-page-note').textContent = '';
    loadImage(book, page);
  }
}

function loadImage(book, page) {
  const url = `/api/books/${encodeURIComponent(book)}/${encodeURIComponent(page)}/image`;
  const img = $('iq-page-img');
  $('iq-page-label').textContent = `${book} p.${page}`;
  $('iq-page-open').href = url;
  $('iq-page-missing').hidden = true;
  img.hidden = false;
  img.alt = `${book} page ${page}`;
  img.onerror = () => { img.hidden = true; $('iq-page-missing').hidden = false; };
  img.src = url;
  $('iq-page-wrap').scrollTop = 0;
}

$('iq-page-prev').addEventListener('click', () => { state.pageOffset--; renderPages(); });
$('iq-page-next').addEventListener('click', () => { state.pageOffset++; renderPages(); });
$('iq-page-zoom').addEventListener('click', () => {
  const zoomed = $('iq-page-wrap').classList.toggle('zoomed');
  $('iq-page-zoom').textContent = zoomed ? 'Fit' : 'Zoom';
});

// ── Options / chants / refs / context / related ──────────────────────────────
function renderOptions() {
  const opts = state.item.options;
  $('iq-options-block').hidden = !opts.length;
  const box = $('iq-options');
  box.innerHTML = '';
  opts.forEach(o => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'iq-option' + (o.recommended ? ' recommended' : '');
    b.disabled = !answerEditable();
    b.innerHTML = `<span class="iq-option-label">${escapeHtml(o.label)}</span>` +
      (o.recommended ? '<span class="iq-option-rec">recommended</span>' : '') +
      (o.detail ? `<span class="iq-option-detail">${escapeHtml(o.detail)}</span>` : '');
    b.addEventListener('click', () => {
      const ta = $('iq-answer');
      const line = o.detail ? `${o.label}: ${o.detail}` : o.label;
      ta.value = ta.value.trim() ? `${ta.value.trimEnd()}\n${line}` : line;
      ta.focus();
    });
    box.appendChild(b);
  });
}

function renderChants() {
  const chants = state.item.chants;
  $('iq-chants-block').hidden = !chants.length;
  const box = $('iq-chants');
  box.innerHTML = '';
  for (const c of chants) {
    const card = document.createElement('div');
    card.className = 'iq-chant';
    card.innerHTML =
      `<div class="iq-chant-head"><code>${escapeHtml(c.chant_uuid)}</code> <span class="iq-chant-info"></span>` +
      (c.note ? `<span class="iq-chant-note">${escapeHtml(c.note)}</span>` : '') + '</div>' +
      '<div class="iq-chant-score"><em class="render-note">Loading…</em></div>';
    box.appendChild(card);
    const score = card.querySelector('.iq-chant-score');
    api('/api/chant_by_uuid?uuid=' + encodeURIComponent(c.chant_uuid))
      .then(r => {
        card.querySelector('.iq-chant-info').textContent =
          [r.incipit, r.mode ? `mode ${r.mode}` : null, r.version].filter(Boolean).join(' · ');
        renderGabc(r.gabc_body, score, r.verses_html);
      })
      .catch(e => { score.innerHTML = `<em class="render-note error">${escapeHtml(e.message)}</em>`; });
  }
}

function renderRefs() {
  const refs = state.item.refs;
  $('iq-refs-block').hidden = !refs.length;
  $('iq-refs').innerHTML = refs.map(r => {
    const pk = Object.entries(r.pk || {}).map(([k, v]) => `${k}=${v}`).join(', ');
    return `<li><code>${escapeHtml(r.table)} ${escapeHtml(pk)}</code>` +
      (r.note ? ` <span class="iq-muted">— ${escapeHtml(r.note)}</span>` : '') + '</li>';
  }).join('');
}

function renderContext() {
  const ctx = state.item.context;
  $('iq-context-block').hidden = !ctx.length;
  const root = state.item.repo_root;
  $('iq-context').innerHTML = ctx.map(c => {
    const label = escapeHtml(c.label || c.path || c.url);
    if (c.url) {
      return `<li><a href="${escapeHtml(c.url)}" target="_blank" rel="noopener">${label}</a></li>`;
    }
    const file = (c.path || '').split('#')[0];
    // Local server: open the file in VS Code. Prod has no checkout, so just show the path.
    const link = root ? `<a href="vscode://file/${escapeHtml(root)}/${escapeHtml(file)}">${label}</a>` : label;
    return `<li>${link} <code class="iq-muted">${escapeHtml(c.path)}</code></li>`;
  }).join('');
}

function renderRelated() {
  const rel = state.item.related;
  $('iq-related-block').hidden = !rel.length;
  $('iq-related').innerHTML = rel.map(r =>
    `<li><a href="/intake?id=${r.question_id}" data-id="${r.question_id}">#${r.question_id}</a> ` +
    `<span class="iq-pill st-${r.status}">${STATUS_LABELS[r.status]}</span> ${escapeHtml(r.title)}</li>`
  ).join('');
}

$('iq-related').addEventListener('click', e => {
  const a = e.target.closest('a[data-id]');
  if (!a) return;
  e.preventDefault();
  selectItem(Number(a.dataset.id));
});

// ── Answer ───────────────────────────────────────────────────────────────────
function answerEditable() {
  return state.canAnswer && ['open', 'answered'].includes(state.item.status);
}

function renderAnswer() {
  const it = state.item;
  const editable = answerEditable();
  const ta = $('iq-answer');
  ta.value = it.answer || '';
  ta.disabled = !editable;
  $('iq-rule').checked = it.is_standing_rule;
  $('iq-rule').disabled = !editable;
  $('iq-btn-save').hidden = $('iq-btn-next').hidden = !editable;
  $('iq-btn-clear').hidden = !editable || !it.answer;
  const msg = $('iq-answer-msg');
  msg.className = '';
  if (it.answered_by) {
    msg.textContent = `Answered by ${it.answered_by} at ${shortDate(it.answered_at)}` +
      (editable ? '' : ' (locked: an agent has taken it)');
  } else if (!state.canAnswer) {
    msg.textContent = 'Answers can only be written on the local (read-write) server by an editor.';
  } else {
    msg.textContent = '';
  }

  const res = $('iq-resolution-block');
  res.hidden = !(it.claimed_by || it.resolution);
  $('iq-resolution').innerHTML =
    (it.claimed_by ? `<div class="iq-muted">Claimed by ${escapeHtml(it.claimed_by)} at ${shortDate(it.claimed_at)}</div>` : '') +
    (it.resolution ? `<div>${escapeHtml(it.resolution)}</div>` +
      `<div class="iq-muted">Resolved ${shortDate(it.resolved_at)}</div>` : '');
}

async function saveAnswer({ clear = false, next = false } = {}) {
  const it = state.item;
  if (!it) return;
  const answer = clear ? '' : $('iq-answer').value.trim();
  if (!clear && !answer) {
    showMsg('Write an answer first (or use Clear answer to reopen).', true);
    return;
  }
  showMsg(clear ? 'Clearing…' : 'Saving…');
  let updated;
  try {
    updated = await api(`/api/intake_queue/${it.question_id}/answer`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer, is_standing_rule: !clear && $('iq-rule').checked }),
    });
  } catch (e) {
    showMsg('Error: ' + e.message, true);
    return;
  }
  // Pick the next question before the list is refreshed (this one may drop out of the filter).
  const idx = state.items.findIndex(x => x.question_id === it.question_id);
  const nextItem = state.items[idx + 1] || null;
  state.item = updated;
  await Promise.all([loadFacets(), loadList()]);
  if (next && nextItem) {
    await selectItem(nextItem.question_id, { focusAnswer: true });
  } else {
    renderDetail();
    showMsg(clear ? '✓ Cleared; question reopened' : (next ? '✓ Saved; no more questions in this list' : '✓ Saved'));
  }
}

function showMsg(text, error = false) {
  const m = $('iq-answer-msg');
  m.textContent = text;
  m.className = error ? 'error' : '';
}

$('iq-btn-save').addEventListener('click', () => saveAnswer());
$('iq-btn-next').addEventListener('click', () => saveAnswer({ next: true }));
$('iq-btn-clear').addEventListener('click', () => saveAnswer({ clear: true }));
$('iq-answer').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    saveAnswer({ next: true });
  }
});

// j / k move through the list when not typing.
document.addEventListener('keydown', e => {
  if (e.target.closest('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key !== 'j' && e.key !== 'k') return;
  if (!state.items.length) return;
  const idx = state.item ? state.items.findIndex(x => x.question_id === state.item.question_id) : -1;
  const to = state.items[e.key === 'j' ? idx + 1 : Math.max(idx - 1, 0)];
  if (to) selectItem(to.question_id);
});

// ── Init ─────────────────────────────────────────────────────────────────────
(async function init() {
  const user = await window.currentUser;
  state.canAnswer = !!(user && user.can_write && !user.read_only);
  await loadFacets();
  await loadList();
  const id = Number(new URLSearchParams(location.search).get('id'));
  if (id) {
    await selectItem(id);
  } else if (state.items.length) {
    await selectItem(state.items[0].question_id);
  }
})();
