'use strict';

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  entries: [],        // full list from API
  selected: null,     // GrIndexEntry (list fields only)
  detail: null,       // GrIndexEntry (with gabc_body)
  filters: { status: '', q: '' },
  browse: {
    groups: [],       // GrIndexBrowseGroup[]
    selected: null,   // currently highlighted group in browse panel
  },
};

// section_type → gregobase office-part code
const SECTION_TO_PART = {
  introitus: 'in', graduale: 'gr', alleluia: 'al', tractus: 'tr',
  offertorium: 'of', communio: 'co', antiphona: 'an',
  hymnus: 'hy', sequentia: 'se', psalmus: 'ps',
};

const $ = id => document.getElementById(id);

// DOM refs
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
const browsePanel         = $('gri-browse-panel');
const browsePart          = $('gri-browse-part');
const browseLetter        = $('gri-browse-letter');
const browseCloseBtn      = $('gri-browse-close-btn');
const browseMsg           = $('gri-browse-msg');
const browseList          = $('gri-browse-list');
const browseDetailMeta    = $('gri-browse-detail-meta');
const browseDetailEngrav  = $('gri-browse-detail-engrav');
const browseDetailActions = $('gri-browse-detail-actions');
const browseAssignBtn     = $('gri-browse-assign-btn');
const newPanel        = $('gri-new-panel');
const newIncipit      = $('gri-new-incipit');
const newMode         = $('gri-new-mode');
const newVersion      = $('gri-new-version');
const newName         = $('gri-new-name');
const newGabc         = $('gri-new-gabc');
const newPreviewDiv   = $('gri-new-preview');
const newPreviewBtn   = $('gri-new-preview-btn');
const newSaveBtn      = $('gri-new-save-btn');
const newCloseBtn     = $('gri-new-close-btn');
const newMsg          = $('gri-new-msg');

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
  if (state.filters.status) p.set('match_status', state.filters.status);
  if (state.filters.q)      p.set('q', state.filters.q);
  try {
    state.entries = await api('/api/gr_index_entries?' + p.toString());
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

  griTitle.textContent = `#${e.row_id} · ${e.section_type || '?'} · mode ${e.mode ?? '—'} · p.${e.page ?? '—'}`;
  griMeta.textContent = `match_status: ${e.match_status || '(none)'}`;

  loadImages(e.page);

  // Load detail (with gabc_body)
  griAssignNone.hidden = false;
  griAssignDisp.hidden = true;
  griAssignEngrav.innerHTML = '';
  griBtnClear.hidden = true;

  try {
    state.detail = await api(`/api/gr_index_entries/${rowId}`);
    renderAssignment(state.detail);
  } catch (err) {
    griAssignMeta.textContent = 'Error loading detail: ' + err.message;
  }

  // Pre-fill browse dropdowns from entry
  browsePart.value = SECTION_TO_PART[e.section_type] || 'in';
  const firstLetter = (e.incipit || '').trim()[0]?.toUpperCase() || 'A';
  browseLetter.value = firstLetter || 'A';
}

function loadImages(page) {
  if (page != null) {
    griImgLabelA.textContent = `GR p.${page}`;
    griImgA.src = `/api/books/GRADUALE/${page}/image`;
    griImgA.style.display = '';
    griImgLabelB.textContent = `GR p.${page + 1}`;
    griImgB.src = `/api/books/GRADUALE/${page + 1}/image`;
    griImgB.style.display = '';
  } else {
    griImgA.style.display = 'none';
    griImgB.style.display = 'none';
    griImgLabelA.textContent = 'No page';
    griImgLabelB.textContent = '';
  }
}

function renderAssignment(detail) {
  const hasGb = detail.gregobase_id != null;
  const hasLc = detail.local_chant_id != null;

  if (!hasGb && !hasLc) {
    griAssignNone.hidden = false;
    griAssignDisp.hidden = true;
    griBtnClear.hidden = true;
    return;
  }

  griAssignNone.hidden = true;
  griAssignDisp.hidden = false;
  griBtnClear.hidden = false;

  if (hasGb) {
    griAssignMeta.textContent =
      `gregobase:${detail.gregobase_id}` +
      (detail.gb_incipit ? ` — ${detail.gb_incipit}` : '');
    renderGabc(detail.gb_gabc_body, griAssignEngrav);
  } else {
    griAssignMeta.textContent =
      `local:${detail.local_chant_id}` +
      (detail.lc_incipit ? ` — ${detail.lc_incipit}` : '');
    renderGabc(detail.lc_gabc_body, griAssignEngrav);
  }
}

// ── GABC rendering ────────────────────────────────────────────────────────────
function renderGabc(gabcBody, container) {
  if (typeof exsurge === 'undefined') {
    container.innerHTML = '<em class="render-note">exsurge not loaded</em>';
    return;
  }
  if (!gabcBody) {
    container.innerHTML = '<em class="render-note">No GABC</em>';
    return;
  }
  container.innerHTML = '<em class="render-note">Rendering…</em>';
  requestAnimationFrame(() => {
    const w = Math.max((container.clientWidth || 700) - 32, 300);
    try {
      const ctxt = new exsurge.ChantContext();
      const mappings = exsurge.Gabc.createMappingsFromSource(ctxt, gabcBody);
      const score = new exsurge.ChantScore(ctxt, mappings, true);
      score.performLayout(ctxt);
      score.layoutChantLines(ctxt, w, () => {
        try {
          container.innerHTML = score.createSvg(ctxt);
        } catch (err) {
          container.innerHTML = `<em class="render-note">Render error: ${escapeHtml(err.message)}</em>`;
        }
      });
    } catch (err) {
      container.innerHTML = `<em class="render-note">Render error: ${escapeHtml(err.message)}</em>`;
    }
  });
}

// ── Actions ───────────────────────────────────────────────────────────────────
async function patchEntry(rowId, fields) {
  return api(`/api/gr_index_entries/${rowId}`, {
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
      gregobase_id: null,
      local_chant_id: null,
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
griBtnBrowse.addEventListener('click', () => {
  hidePanels();
  browsePanel.hidden = false;
  runBrowseLoad();
});

browseCloseBtn.addEventListener('click', () => { browsePanel.hidden = true; });

browseLetter.addEventListener('change', runBrowseLoad);

async function runBrowseLoad() {
  const part = browsePart.value;
  const letter = browseLetter.value;
  if (!part || !letter) return;
  browseMsg.textContent = 'Loading…';
  browseList.innerHTML = '';
  clearBrowseDetail();
  state.browse.groups = [];
  state.browse.selected = null;
  try {
    const p = new URLSearchParams({ part, letter, limit: '300' });
    state.browse.groups = await api('/api/gr_index_browse?' + p.toString());
    browseMsg.textContent = `${state.browse.groups.length} group(s)`;
    renderBrowseList();
  } catch (e) {
    browseMsg.textContent = 'Error: ' + e.message;
  }
}

function renderBrowseList() {
  browseList.innerHTML = '';
  if (!state.browse.groups.length) {
    const li = document.createElement('li');
    li.className = 'gri-browse-empty';
    li.textContent = 'No groups found.';
    browseList.appendChild(li);
    return;
  }
  for (const g of state.browse.groups) {
    const li = document.createElement('li');
    li.className = 'gri-browse-list-item';
    li.dataset.gid = g.chant_group_id;
    li.textContent = g.incipit || g.canonical_name || `group ${g.chant_group_id}`;
    li.addEventListener('click', () => selectBrowseGroup(g));
    browseList.appendChild(li);
  }
}

function selectBrowseGroup(g) {
  state.browse.selected = g;
  // Highlight
  browseList.querySelectorAll('.gri-browse-list-item').forEach(li => {
    li.classList.toggle('active', li.dataset.gid == g.chant_group_id);
  });
  // Show detail
  browseDetailMeta.innerHTML =
    `<strong>${escapeHtml(g.incipit || g.canonical_name || '')}</strong>` +
    (g.best_mode    ? ` <span class="mgp-badge">mode ${escapeHtml(g.best_mode)}</span>` : '') +
    (g.best_version ? ` <span class="mgp-badge">${escapeHtml(g.best_version)}</span>` : '') +
    ` <span class="mgp-badge gri-gb-id">#${g.best_gregobase_id}</span>`;
  browseDetailEngrav.innerHTML = '';
  if (g.best_gabc_body) renderGabc(g.best_gabc_body, browseDetailEngrav);
  else browseDetailEngrav.innerHTML = '<em class="render-note">No GABC</em>';
  browseDetailActions.hidden = false;
}

function clearBrowseDetail() {
  browseDetailMeta.innerHTML = '';
  browseDetailEngrav.innerHTML = '';
  browseDetailActions.hidden = true;
}

browseAssignBtn.addEventListener('click', async () => {
  if (!state.selected || !state.browse.selected) return;
  browseMsg.textContent = 'Assigning…';
  const gregobaseId = state.browse.selected.best_gregobase_id;
  try {
    const updated = await patchEntry(state.selected.row_id, {
      gregobase_id: gregobaseId,
      local_chant_id: null,
      match_status: 'reviewed',
    });
    applyUpdate(updated);
    browsePanel.hidden = true;
    griMsg.textContent = `✓ Assigned gregobase:${gregobaseId}`;
  } catch (e) {
    browseMsg.textContent = 'Error: ' + e.message;
  }
});

// ── New chant panel ───────────────────────────────────────────────────────────
griBtnNew.addEventListener('click', () => {
  hidePanels();
  // Pre-fill from selected entry
  if (state.selected) {
    newIncipit.value = state.selected.incipit || '';
    newMode.value = state.selected.mode != null ? String(state.selected.mode) : '';
    newName.value = state.selected.incipit || '';
  }
  newGabc.value = '';
  newPreviewDiv.innerHTML = '';
  newMsg.textContent = '';
  newPanel.hidden = false;
  newGabc.focus();
});

newCloseBtn.addEventListener('click', () => { newPanel.hidden = true; });

newPreviewBtn.addEventListener('click', () => {
  const body = extractGabcBody(newGabc.value.trim());
  if (body) renderGabc(body, newPreviewDiv);
  else newPreviewDiv.innerHTML = '<em class="render-note">No GABC to preview</em>';
});

newSaveBtn.addEventListener('click', async () => {
  if (!state.selected) return;
  const gabc = newGabc.value.trim();
  if (!gabc) { newMsg.textContent = 'GABC cannot be empty.'; return; }
  newMsg.textContent = 'Saving…';
  newSaveBtn.disabled = true;
  try {
    const updated = await api(`/api/gr_index_entries/${state.selected.row_id}/local_chant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gabc,
        incipit: newIncipit.value.trim() || null,
        mode: newMode.value.trim() || null,
        version: newVersion.value.trim() || 'latin',
        canonical_name: newName.value.trim() || null,
      }),
    });
    applyUpdate(updated);
    newPanel.hidden = true;
    griMsg.textContent = `✓ New local chant created and assigned`;
  } catch (e) {
    newMsg.textContent = 'Error: ' + e.message;
  } finally {
    newSaveBtn.disabled = false;
  }
});

// ── Utilities ─────────────────────────────────────────────────────────────────
function hidePanels() {
  browsePanel.hidden = true;
  newPanel.hidden = true;
}

function extractGabcBody(gabc) {
  if (!gabc) return '';
  const parts = gabc.split('%%');
  return parts.length > 1 ? parts[parts.length - 1].trim() : gabc.trim();
}

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Filters ───────────────────────────────────────────────────────────────────
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
async function loadBrowseParts() {
  const parts = await api('/api/gregobase_parts');
  browsePart.innerHTML = '';
  for (const p of parts) {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p;
    browsePart.appendChild(opt);
  }
  await loadBrowseLetters();
}

async function loadBrowseLetters() {
  const part = browsePart.value;
  if (!part) return;
  const letters = await api('/api/gregobase_letters?part=' + encodeURIComponent(part));
  const prev = browseLetter.value;
  browseLetter.innerHTML = '';
  for (const l of letters) {
    const opt = document.createElement('option');
    opt.value = l;
    opt.textContent = l;
    browseLetter.appendChild(opt);
  }
  // Restore previous selection if still present, else default to first
  if (letters.includes(prev)) browseLetter.value = prev;
}

browsePart.addEventListener('change', async () => {
  await loadBrowseLetters();
  runBrowseLoad();
});

(async function init() {
  await loadBrowseParts();
  await loadList();
})();
