'use strict';

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  parts: [],         // from /api/service_parts
  seasons: [],       // [{slug, kind, title}] season epochs
  weekOptions: [],   // full week epoch objects for the day-kind dropdown
  kind: 'week',      // active kind chip
  season: null,      // selected season slug (for subseason/week/day)
  weekSlug: null,    // selected week slug (day kind only)
  weekData: null,    // full week epoch object {slug, season, subseason, wknum}
  epochs: [],        // current epoch list shown in sidebar
  selectedSlug: null,
  reviewData: null,  // response from /api/lit_epochs/{slug}/assignments_review
};

const $ = id => document.getElementById(id);

const kindChips        = $('kind-chips');
const seasonFilter     = $('season-filter');
const seasonChips      = $('season-chips');
const weekFilter       = $('week-filter');
const weekSelect       = $('week-select');
const epochList        = $('src-list');
const epochListCount   = $('src-list-count');
const emptyState       = $('src-empty-state');
const editor           = $('src-editor');
const srcTitle         = $('src-title');
const inheritedSection = $('inherited-section');
const inheritedList    = $('inherited-list');
const partsSection     = $('parts-section');

// ── API helper ───────────────────────────────────────────────────────────────
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
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Sidebar filter rendering ──────────────────────────────────────────────────
function applyKindVisibility() {
  const needsSeason = ['subseason', 'week', 'day'].includes(state.kind);
  seasonFilter.hidden = !needsSeason;
  weekFilter.hidden = !(state.kind === 'day' && state.season);
}

function renderSeasonChips() {
  seasonChips.innerHTML = '';
  for (const s of state.seasons) {
    const btn = document.createElement('button');
    btn.className = 'chip' + (s.slug === state.season ? ' active' : '');
    btn.dataset.season = s.slug;
    btn.textContent = s.title || s.slug;
    seasonChips.appendChild(btn);
  }
}

async function populateWeekDropdown() {
  weekSelect.innerHTML = '<option value="">— select week —</option>';
  if (!state.season) { state.weekOptions = []; return; }
  try {
    state.weekOptions = await api(
      `/api/lit_epochs?kind=week&season=${encodeURIComponent(state.season)}`
    );
  } catch (_) { state.weekOptions = []; }
  for (const w of state.weekOptions) {
    const opt = document.createElement('option');
    opt.value = w.slug;
    opt.textContent = w.title || w.slug;
    if (w.slug === state.weekSlug) opt.selected = true;
    weekSelect.appendChild(opt);
  }
}

// ── Epoch list ────────────────────────────────────────────────────────────────
let _listSeq = 0;

async function loadEpochList() {
  const mySeq = ++_listSeq;
  epochList.innerHTML = '';
  epochListCount.textContent = '';

  if (['subseason', 'week'].includes(state.kind) && !state.season) {
    epochListCount.textContent = 'Select a season above';
    return;
  }
  if (state.kind === 'day' && !state.weekData) {
    epochListCount.textContent = 'Select a season and week above';
    return;
  }

  const params = new URLSearchParams({ kind: state.kind });
  if (state.season && state.kind !== 'saint' && state.kind !== 'season') {
    params.set('season', state.season);
  }
  if (state.kind === 'day' && state.weekData) {
    params.set('subseason', state.weekData.subseason);
    params.set('wknum', state.weekData.wknum);
  }

  let epochs;
  try {
    epochs = await api('/api/lit_epochs?' + params.toString());
  } catch (e) {
    if (mySeq !== _listSeq) return;
    epochList.innerHTML = `<li class="src-error">Error: ${escapeHtml(e.message)}</li>`;
    return;
  }

  if (mySeq !== _listSeq) return;  // stale — a newer call has superseded this one
  state.epochs = epochs;

  epochListCount.textContent = `${state.epochs.length} epoch(s)`;
  for (const ep of state.epochs) {
    const li = document.createElement('li');
    li.className = 'asgn-item' + (ep.slug === state.selectedSlug ? ' selected' : '');
    li.dataset.slug = ep.slug;
    li.innerHTML =
      `<span class="asgn-body">` +
        `<span class="asgn-name">${escapeHtml(ep.title || ep.slug)}</span>` +
        `<span class="asgn-epoch">${escapeHtml(ep.slug)}</span>` +
      `</span>`;
    li.addEventListener('click', () => selectEpoch(ep.slug));
    epochList.appendChild(li);
  }
}

// ── Epoch selection ───────────────────────────────────────────────────────────
async function selectEpoch(slug) {
  state.selectedSlug = slug;
  epochList.querySelectorAll('.asgn-item').forEach(li =>
    li.classList.toggle('selected', li.dataset.slug === slug)
  );

  emptyState.hidden = true;
  editor.hidden = false;
  srcTitle.textContent = 'Loading…';
  inheritedSection.hidden = true;
  inheritedList.innerHTML = '';
  partsSection.innerHTML = '';

  try {
    state.reviewData = await api(
      `/api/lit_epochs/${encodeURIComponent(slug)}/assignments_review`
    );
  } catch (e) {
    srcTitle.textContent = 'Error loading epoch';
    partsSection.innerHTML =
      `<div class="review-empty">Error: ${escapeHtml(e.message)}</div>`;
    return;
  }

  renderContentPanel();
}

// ── Content panel rendering ───────────────────────────────────────────────────
function renderContentPanel() {
  const { epoch, inherited, by_part } = state.reviewData;
  srcTitle.textContent = `${epoch.title || epoch.slug} — ${epoch.kind}`;

  // Inherited section
  if (inherited && inherited.length > 0) {
    inheritedSection.hidden = false;
    inheritedList.innerHTML = '';
    for (const a of inherited) {
      inheritedList.appendChild(makeAssignmentRow(a, { isInherited: true }));
    }
  } else {
    inheritedSection.hidden = true;
  }

  // Per-part sections
  partsSection.innerHTML = '';
  if (!by_part || by_part.length === 0) {
    partsSection.innerHTML =
      '<div class="review-empty">No assignments at this epoch or its descendants.</div>';
    return;
  }

  for (const part of by_part) {
    const section = document.createElement('div');
    section.className = 'part-section';

    const hdr = document.createElement('div');
    hdr.className = 'review-section-header part-section-header';
    const pc = (part.part_code || '').toLowerCase();
    hdr.innerHTML =
      `<span class="src-part part-${escapeHtml(pc)}">${escapeHtml(pc.toUpperCase())}</span>` +
      ` ${escapeHtml(part.part_name || '')}`;
    section.appendChild(hdr);

    if (part.assignments.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'review-empty';
      empty.textContent = 'No assignments.';
      section.appendChild(empty);
    } else {
      for (const a of part.assignments) {
        section.appendChild(makeAssignmentRow(a, { depth: a.depth || 0 }));
      }
    }
    partsSection.appendChild(section);
  }
}

// ── Assignment row ────────────────────────────────────────────────────────────
function makeAssignmentRow(a, { depth = 0, isInherited = false } = {}) {
  const row = document.createElement('div');
  row.className = 'asgn-review-row' + (a.review_status === 'draft' ? ' needs-review' : ' reviewed');
  row.dataset.id = a.text_id;
  if (depth > 0) row.style.paddingLeft = `${1 + depth * 1.4}rem`;

  const epochLabel = isInherited
    ? `from: ${a.epoch_title || a.lit_epoch_slug || '(general)'}`
    : (depth > 0 ? (a.epoch_title || a.lit_epoch_slug || '') : '');

  const metaParts = [
    a.jurisdiction,
    a.option_num > 1 ? `opt ${a.option_num}` : null,
    a.assignment_authority_code,
    a.wkday != null ? `wkday ${a.wkday}` : null,
  ].filter(Boolean);

  const statusCls = a.review_status === 'draft' ? 'status-review' : 'status-ok';
  const statusTxt = a.review_status === 'draft' ? '⊙' : '✓';

  row.innerHTML = `
    <div class="arr-main">
      <div class="arr-info">
        ${epochLabel ? `<span class="arr-epoch-label">${escapeHtml(epochLabel)}</span>` : ''}
        <span class="arr-chant">${escapeHtml(a.chant_name || '(unknown chant)')}</span>
        ${metaParts.length ? `<span class="arr-meta">${escapeHtml(metaParts.join(' · '))}</span>` : ''}
      </div>
      <div class="arr-right">
        <span class="asgn-status ${statusCls}">${statusTxt}</span>
        <div class="arr-actions">
          <button class="btn-arr btn-accept">Accept</button>
          <button class="btn-arr btn-edit-row">Edit</button>
          <button class="btn-arr btn-reject">Reject</button>
        </div>
      </div>
    </div>
    <div class="arr-edit-form" hidden>
      <div class="aef-row">
        <label>Jurisdiction
          <select class="aef-jurisdiction">
            <option value="UNIVERSAL">UNIVERSAL</option>
            <option value="US">US</option>
          </select>
        </label>
        <label>Part <select class="aef-part"></select></label>
        <label>Option #
          <input type="number" class="aef-option-num" min="1" max="9" style="width:3.5rem">
        </label>
      </div>
      <div class="aef-row">
        <label>Authority
          <input type="text" class="aef-authority" placeholder="—" style="width:8rem">
        </label>
        <label>Epoch slug
          <input type="text" class="aef-epoch-slug" placeholder="lit_epoch_slug" style="width:12rem">
        </label>
        <label>Wkday
          <input type="number" class="aef-wkday" min="1" max="7" style="width:3.5rem" placeholder="—">
        </label>
      </div>
      <div class="aef-row">
        <label>Cycle Sun
          <input type="number" class="aef-cycle-sun" min="1" max="3" style="width:3.5rem" placeholder="—">
        </label>
        <label>Cycle Wk
          <input type="number" class="aef-cycle-wk" min="1" max="2" style="width:3.5rem" placeholder="—">
        </label>
        <label>Notes
          <input type="text" class="aef-notes" placeholder="—" style="width:14rem">
        </label>
      </div>
      <div class="aef-row">
        <button class="btn-arr btn-save-edit">Save</button>
        <button class="btn-arr btn-cancel-edit">Cancel</button>
        <span class="arr-msg"></span>
      </div>
    </div>
  `;

  // Populate part select
  const partSel = row.querySelector('.aef-part');
  for (const p of state.parts) {
    const opt = document.createElement('option');
    opt.value = p.part_id;
    opt.textContent = `${p.part_code} — ${p.display_name}`;
    partSel.appendChild(opt);
  }

  const editForm = row.querySelector('.arr-edit-form');
  const arrMain  = row.querySelector('.arr-main');
  const msg      = row.querySelector('.arr-msg');

  function fillForm() {
    row.querySelector('.aef-jurisdiction').value = a.jurisdiction || 'UNIVERSAL';
    row.querySelector('.aef-part').value         = String(a.part_id);
    row.querySelector('.aef-option-num').value   = a.option_num || 1;
    row.querySelector('.aef-authority').value    = a.assignment_authority_code || '';
    row.querySelector('.aef-epoch-slug').value   = a.lit_epoch_slug || '';
    row.querySelector('.aef-wkday').value        = a.wkday ?? '';
    row.querySelector('.aef-cycle-sun').value    = a.cycle_sun ?? '';
    row.querySelector('.aef-cycle-wk').value     = a.cycle_wkday ?? '';
    row.querySelector('.aef-notes').value        = a.notes || '';
  }

  // Accept
  row.querySelector('.btn-accept').addEventListener('click', async () => {
    if (a.review_status !== 'draft') return;
    try {
      await api(`/api/lit_part_assignments/${a.text_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ review_status: 'reviewed' }),
      });
      await selectEpoch(state.selectedSlug);
    } catch (e) { alert('Error: ' + e.message); }
  });

  // Edit
  row.querySelector('.btn-edit-row').addEventListener('click', () => {
    fillForm();
    arrMain.hidden = true;
    editForm.hidden = false;
  });

  // Cancel
  row.querySelector('.btn-cancel-edit').addEventListener('click', () => {
    editForm.hidden = true;
    arrMain.hidden = false;
    msg.textContent = '';
  });

  // Save edit
  row.querySelector('.btn-save-edit').addEventListener('click', async () => {
    const payload = {};
    const juris = row.querySelector('.aef-jurisdiction').value;
    if (juris !== a.jurisdiction) payload.jurisdiction = juris;
    const partId = parseInt(row.querySelector('.aef-part').value, 10);
    if (!isNaN(partId) && partId !== a.part_id) payload.part_id = partId;
    const optNum = parseInt(row.querySelector('.aef-option-num').value, 10);
    if (!isNaN(optNum) && optNum !== a.option_num) payload.option_num = optNum;
    const auth = row.querySelector('.aef-authority').value.trim() || null;
    if (auth !== (a.assignment_authority_code || null)) payload.assignment_authority_code = auth;
    const epochSlug = row.querySelector('.aef-epoch-slug').value.trim() || null;
    if (epochSlug !== (a.lit_epoch_slug || null)) payload.lit_epoch_slug = epochSlug;
    const wkday = row.querySelector('.aef-wkday').value === ''
      ? null : parseInt(row.querySelector('.aef-wkday').value, 10);
    if (wkday !== a.wkday) payload.wkday = wkday;
    const cycleSun = row.querySelector('.aef-cycle-sun').value === ''
      ? null : parseInt(row.querySelector('.aef-cycle-sun').value, 10);
    if (cycleSun !== a.cycle_sun) payload.cycle_sun = cycleSun;
    const cycleWk = row.querySelector('.aef-cycle-wk').value === ''
      ? null : parseInt(row.querySelector('.aef-cycle-wk').value, 10);
    if (cycleWk !== a.cycle_wkday) payload.cycle_wkday = cycleWk;
    const notes = row.querySelector('.aef-notes').value || null;
    if (notes !== (a.notes || null)) payload.notes = notes;

    if (!Object.keys(payload).length) { msg.textContent = '(no changes)'; return; }
    msg.textContent = 'Saving…';
    try {
      await api(`/api/lit_part_assignments/${a.text_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      await selectEpoch(state.selectedSlug);
    } catch (e) { msg.textContent = 'Error: ' + e.message; }
  });

  // Reject
  row.querySelector('.btn-reject').addEventListener('click', async () => {
    if (!confirm(`Delete assignment #${a.text_id}? This cannot be undone.`)) return;
    try {
      await api(`/api/assignments/${a.text_id}`, { method: 'DELETE' });
      await selectEpoch(state.selectedSlug);
    } catch (e) { alert('Error: ' + e.message); }
  });

  return row;
}

// ── Filter event handlers ─────────────────────────────────────────────────────
kindChips.addEventListener('click', e => {
  const btn = e.target.closest('[data-kind]');
  if (!btn) return;
  kindChips.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  state.kind = btn.dataset.kind;
  state.season = null;
  state.weekSlug = null;
  state.weekData = null;
  state.selectedSlug = null;
  seasonChips.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  weekSelect.innerHTML = '<option value="">— select week —</option>';
  editor.hidden = true;
  emptyState.hidden = false;
  applyKindVisibility();
  loadEpochList();
});

seasonChips.addEventListener('click', e => {
  const btn = e.target.closest('[data-season]');
  if (!btn) return;
  seasonChips.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  state.season = btn.dataset.season;
  state.weekSlug = null;
  state.weekData = null;
  state.selectedSlug = null;
  editor.hidden = true;
  emptyState.hidden = false;
  applyKindVisibility();
  if (state.kind === 'day') {
    populateWeekDropdown();
    epochListCount.textContent = 'Select a week above';
    epochList.innerHTML = '';
  } else {
    loadEpochList();
  }
});

weekSelect.addEventListener('change', () => {
  const slug = weekSelect.value;
  state.weekSlug = slug || null;
  state.weekData = slug ? (state.weekOptions.find(w => w.slug === slug) || null) : null;
  state.selectedSlug = null;
  editor.hidden = true;
  emptyState.hidden = false;
  if (slug) {
    loadEpochList();
  } else {
    epochList.innerHTML = '';
    epochListCount.textContent = 'Select a week above';
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
async function loadParts() {
  try { state.parts = await api('/api/service_parts'); } catch (_) { state.parts = []; }
}

async function loadSeasons() {
  try { state.seasons = await api('/api/lit_epochs?kind=season'); } catch (_) { state.seasons = []; }
  renderSeasonChips();
}

(async function init() {
  await Promise.all([loadParts(), loadSeasons()]);
  applyKindVisibility();
  await loadEpochList();
}());
