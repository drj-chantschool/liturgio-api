'use strict';

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  entries: [],        // full list from API
  selected: null,     // ChantIndexEntry (list fields only)
  detail: null,       // ChantIndexEntry (with chant_gabc_body)
  filters: { book: '', status: '', q: '' },
};

// section_type → gregobase office-part code
const SECTION_TO_PART = {
  introitus: 'in', graduale: 'gr', alleluia: 'al', tractus: 'tr',
  offertorium: 'of', communio: 'co', antiphona: 'an',
  hymnus: 'hy', sequentia: 'se', psalmus: 'ps',
};

const $ = id => document.getElementById(id);

// DOM refs
const bookSelect      = $('gri-book');
const statusChips     = $('status-chips');
const griSearch       = $('gri-search');
const griList         = $('gri-list');
const griListCount    = $('gri-list-count');
const statsBadge      = $('gri-stats-badge');
const emptyState      = $('gri-empty-state');
const editor          = $('gri-editor');
const griTitle        = $('gri-title');
const griMeta         = $('gri-meta');
const griImgA         = $('gri-page-img-a');
const griImgB         = $('gri-page-img-b');
const griImgLabelA    = $('gri-img-label-a');
const griImgLabelB    = $('gri-img-label-b');
const griAssignNone   = $('gri-assignment-none');
const griAssignDisp   = $('gri-assignment-display');
const griAssignMeta   = $('gri-assign-meta');
const griAssignEngrav = $('gri-assign-engraving');
const griMsg          = $('gri-msg');
const griBtnBrowse    = $('gri-btn-browse');
const griBtnNew       = $('gri-btn-new');
const griBtnReviewed  = $('gri-btn-reviewed');
const griBtnClear     = $('gri-btn-clear');

// ── API helpers ───────────────────────────────────────────────────────────────
async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch (_) {}
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

// ── List ──────────────────────────────────────────────────────────────────────
async function loadList() {
  const p = new URLSearchParams();
  if (state.filters.book)   p.set('book', state.filters.book);
  if (state.filters.status) p.set('match_status', state.filters.status);
  if (state.filters.q)      p.set('q', state.filters.q);
  try {
    state.entries = await api('/api/chant_indices?' + p.toString());
  } catch (e) {
    griList.innerHTML = `<li class="src-error">Error: ${escapeHtml(e.message)}</li>`;
    return;
  }
  renderList();
  renderStats();
}

const STATUS_ABBR = {
  resolved: 'res',
  resolved_with_difficulty: 'dif',
  ambiguous: 'amb',
  unmatched: 'unk',
  reviewed: 'rev',
};

function renderList() {
  griList.innerHTML = '';
  griListCount.textContent = `${state.entries.length} entr${state.entries.length === 1 ? 'y' : 'ies'}`;

  for (const e of state.entries) {
    const li = document.createElement('li');
    const isSelected = state.selected && state.selected.row_id === e.row_id;
    li.className = 'src-item' + (isSelected ? ' selected' : '');
    li.dataset.id = e.row_id;

    const status = e.match_status || '';
    const abbr = STATUS_ABBR[status] || '—';
    const part = e.section_type ? e.section_type.slice(0, 3) : '?';
    const mode = e.mode != null ? `${e.mode}` : '';
    const incipit = (e.incipit || '(no incipit)').slice(0, 44);

    li.innerHTML =
      `<span class="gri-part-badge part-${part}">${escapeHtml(part)}</span>` +
      `<span class="gri-mode-badge">${escapeHtml(mode)}</span>` +
      `<span class="src-incipit">${escapeHtml(incipit)}</span>` +
      `<span class="gri-status status-gri-${escapeHtml(status)}">${escapeHtml(abbr)}</span>`;

    li.addEventListener('click', () => selectEntry(e.row_id));
    griList.appendChild(li);
  }
}

function renderStats() {
  const counts = {};
  for (const e of state.entries) {
    const s = e.match_status || '(none)';
    counts[s] = (counts[s] || 0) + 1;
  }
  const parts = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ');
  statsBadge.textContent = `${state.entries.length} shown${parts ? ' — ' + parts : ''}`;
}

// ── Selection ─────────────────────────────────────────────────────────────────
async function selectEntry(rowId) {
  const e = state.entries.find(x => x.row_id === rowId);
  if (!e) return;
  state.selected = e;
  renderList();

  hidePanels();
  emptyState.hidden = true;
  editor.hidden = false;
  griMsg.textContent = '';

  griTitle.textContent = `${e.book} #${e.id} · ${e.section_type || '?'} · mode ${e.mode ?? '—'} · p.${e.page ?? '—'}`;
  griMeta.textContent = `match_status: ${e.match_status || '(none)'}`;

  loadImages(e.book, e.page);

  // Load detail (with gabc_body)
  griAssignNone.hidden = false;
  griAssignDisp.hidden = true;
  griAssignEngrav.innerHTML = '';
  griBtnClear.hidden = true;

  try {
    state.detail = await api(`/api/chant_indices/${rowId}`);
    renderAssignment(state.detail);
  } catch (err) {
    griAssignMeta.textContent = 'Error loading detail: ' + err.message;
  }
}

function loadImages(book, page) {
  if (page != null) {
    const b = encodeURIComponent(book);
    griImgLabelA.textContent = `${book} p.${page}`;
    griImgA.src = `/api/books/${b}/${encodeURIComponent(page)}/image`;
    griImgA.style.display = '';
    // page is a printed label (VARCHAR); only numeric pages have an obvious next page
    if (/^\d+$/.test(page)) {
      const next = Number(page) + 1;
      griImgLabelB.textContent = `${book} p.${next}`;
      griImgB.src = `/api/books/${b}/${next}/image`;
      griImgB.style.display = '';
    } else {
      griImgLabelB.textContent = '';
      griImgB.style.display = 'none';
    }
  } else {
    griImgA.style.display = 'none';
    griImgB.style.display = 'none';
    griImgLabelA.textContent = 'No page';
    griImgLabelB.textContent = '';
  }
}

function renderAssignment(detail) {
  if (!detail.chant_uuid) {
    griAssignNone.hidden = false;
    griAssignDisp.hidden = true;
    griBtnClear.hidden = true;
    return;
  }

  griAssignNone.hidden = true;
  griAssignDisp.hidden = false;
  griBtnClear.hidden = false;

  griAssignMeta.textContent =
    detail.chant_uuid +
    (detail.chant_incipit ? ` — ${detail.chant_incipit}` : '') +
    (detail.chant_mode    ? ` · mode ${detail.chant_mode}` : '') +
    (detail.chant_version ? ` · ${detail.chant_version}` : '');
  renderGabc(detail.chant_gabc_body, griAssignEngrav, detail.chant_verses_html, detail.chant_gabc_header);
}

// ── Actions ───────────────────────────────────────────────────────────────────
async function patchEntry(rowId, fields) {
  return api(`/api/chant_indices/${rowId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
}

griBtnReviewed.addEventListener('click', async () => {
  if (!state.selected) return;
  griMsg.textContent = 'Saving…';
  try {
    const updated = await patchEntry(state.selected.row_id, { match_status: 'reviewed' });
    applyUpdate(updated);
    griMsg.textContent = '✓ Marked reviewed';
  } catch (e) {
    griMsg.textContent = 'Error: ' + e.message;
  }
});

griBtnClear.addEventListener('click', async () => {
  if (!state.selected) return;
  griMsg.textContent = 'Clearing…';
  try {
    const updated = await patchEntry(state.selected.row_id, {
      chant_uuid: null,
      match_status: 'unmatched',
    });
    applyUpdate(updated);
    griMsg.textContent = '✓ Cleared';
  } catch (e) {
    griMsg.textContent = 'Error: ' + e.message;
  }
});

function applyUpdate(detail) {
  state.detail = detail;
  // Update list entry
  const idx = state.entries.findIndex(x => x.row_id === detail.row_id);
  if (idx !== -1) {
    state.entries[idx] = { ...state.entries[idx], ...detail };
    state.selected = state.entries[idx];
  }
  griMeta.textContent = `match_status: ${detail.match_status || '(none)'}`;
  renderAssignment(detail);
  renderList();
}

// ── Browse panel ──────────────────────────────────────────────────────────────
const browser = createGregobaseBrowser({
  panel: $('gri-browse-panel'),
  api,
  onAssign: async gregobaseId => {
    if (!state.selected) throw new Error('No entry selected');
    const updated = await patchEntry(state.selected.row_id, {
      chant_uuid: `gregobase:${gregobaseId}`,
      match_status: 'reviewed',
    });
    applyUpdate(updated);
    griMsg.textContent = `✓ Assigned gregobase:${gregobaseId}`;
  },
});

// Pre-select part and seed the incipit box (first word) from the selected index entry
griBtnBrowse.addEventListener('click', () => {
  hidePanels();
  const e = state.selected;
  browser.open({
    part: SECTION_TO_PART[e?.section_type] || 'in',
    incipit: (e?.incipit || '').trim().split(/\s+/)[0] || '',
  });
});

// ── New chant panel ───────────────────────────────────────────────────────────
const newChant = createNewChantPanel({
  panel: $('gri-new-panel'),
  onSave: async payload => {
    if (!state.selected) throw new Error('No entry selected');
    const updated = await api(`/api/chant_indices/${state.selected.row_id}/local_chant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    applyUpdate(updated);
    griMsg.textContent = `✓ New local chant created and assigned`;
  },
});

// Pre-fill from selected entry
griBtnNew.addEventListener('click', () => {
  hidePanels();
  const e = state.selected;
  newChant.open({ incipit: e?.incipit, mode: e?.mode, name: e?.incipit });
});

// ── Utilities ─────────────────────────────────────────────────────────────────
function hidePanels() {
  browser.hide();
  newChant.hide();
}

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Filters ───────────────────────────────────────────────────────────────────
bookSelect.addEventListener('change', () => {
  state.filters.book = bookSelect.value;
  loadList();
});

statusChips.addEventListener('click', e => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  statusChips.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  state.filters.status = btn.dataset.status;
  loadList();
});

let searchTimer = null;
griSearch.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.filters.q = griSearch.value.trim();
    loadList();
  }, 250);
});

// ── Init ──────────────────────────────────────────────────────────────────────
async function loadBooks() {
  const books = await api('/api/chant_indices/books');
  bookSelect.innerHTML = '<option value="">All books</option>';
  for (const b of books) {
    const opt = document.createElement('option');
    opt.value = b;
    opt.textContent = b;
    bookSelect.appendChild(opt);
  }
  if (books.includes('GRADUALE')) bookSelect.value = 'GRADUALE';
  state.filters.book = bookSelect.value;
}

(async function init() {
  await loadBooks();
  await browser.init();
  await loadList();
})();
