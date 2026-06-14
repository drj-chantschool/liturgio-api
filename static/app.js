'use strict';

// ── exsurge workarounds (frmatthew/exsurge 0.0.0 only — commented out for bbloomf 1.24.2) ──
//
// // 1. getSubStringLength crash on empty SVG text elements
// try {
//   const _origGSL = SVGTextContentElement.prototype.getSubStringLength;
//   SVGTextContentElement.prototype.getSubStringLength = function (charnum, nchars) {
//     try { return _origGSL.call(this, charnum, nchars); } catch (_) { return 0; }
//   };
// } catch (_) {}
//
// // 2. Garbled layout from ~ and <i>/<b> tags
// function preprocessGabcForPreview(body) {
//   return body
//     .replace(/\(([^)]*)\)/g, (_, n) => '(' + n.replace(/~/g, '') + ')')
//     .replace(/<\/?(i|b)>/gi, '');
// }

function preprocessGabcForPreview(body) { return body; }

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  chants: [],        // list results
  selected: null,    // full ChantDetail currently shown
  original: null,    // snapshot for revert
  dirty: false,
  filters: { q: '', part: '', status: '' },
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const searchInput     = $('search-input');
const chantList       = $('chant-list');
const listCount       = $('list-count');
const statsBadge      = $('stats-badge');
const emptyState      = $('empty-state');
const chantEditor     = $('chant-editor');
const chantTitle      = $('chant-title');
const chantMeta       = $('chant-meta');
const statusSelect    = $('status-select');
const sourceSelect    = $('source-select');
const exactCheck      = $('exact-check');
const gabcTextarea    = $('gabc-textarea');
const previewContainer= $('preview-container');
const saveBtn         = $('save-btn');
const revertBtn       = $('revert-btn');
const saveStatus      = $('save-status');
const assignSection   = $('assignments-section');
const assignSummary   = $('assignments-summary');
const assignList      = $('assignments-list');
const latinSection    = $('latin-section');
const latinSummary    = $('latin-summary');
const latinRefs       = $('latin-refs');

// ── Constants ─────────────────────────────────────────────────────────────────
const PART_NAMES = {
  in: 'Introit', gr: 'Gradual', al: 'Alleluia', of: 'Offertory', co: 'Communion',
};

// ── GABC / exsurge ────────────────────────────────────────────────────────────
function extractGabcBody(gabc) {
  if (!gabc) return '';
  const parts = gabc.split('%%');
  return parts.length > 1 ? parts[parts.length - 1].trim() : gabc.trim();
}

function renderGabc(gabcText, container, isBody = false) {
  if (typeof exsurge === 'undefined') {
    container.innerHTML = '<em class="render-note">exsurge not loaded — check network</em>';
    return;
  }
  const body = (isBody ? gabcText : extractGabcBody(gabcText)).trim();
  if (!body) {
    container.innerHTML = '<em class="render-note">No content</em>';
    return;
  }
  container.innerHTML = '<em class="render-note">Rendering…</em>';

  // rAF ensures the container is laid out and getBoundingClientRect() is valid
  requestAnimationFrame(() => _doRender(body, container));
}

function _doRender(body, container) {
  const rect = container.getBoundingClientRect();
  const w = Math.max((rect.width || container.clientWidth) - 32, 300);
  const safeBody = preprocessGabcForPreview(body);
  try {
    const ctxt = new exsurge.ChantContext();
    const mappings = exsurge.Gabc.createMappingsFromSource(ctxt, safeBody);
    const score = new exsurge.ChantScore(ctxt, mappings, true);
    score.performLayout(ctxt);
    score.layoutChantLines(ctxt, w, () => {
      try {
        container.innerHTML = score.createSvg(ctxt);
      } catch (err) {
        container.innerHTML = `<em class="render-note error">Draw error: ${escHtml(err.message)}</em>`;
      }
    });
  } catch (err) {
    container.innerHTML = `<em class="render-note error">Render error: ${escHtml(err.message)}</em>`;
  }
}

let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => renderGabc(gabcTextarea.value, previewContainer), 600);
}

// ── API helpers ───────────────────────────────────────────────────────────────
async function apiFetch(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${msg}`);
  }
  return res.json();
}

// ── Load / filter list ────────────────────────────────────────────────────────
async function loadChants() {
  const p = new URLSearchParams({ limit: '500' });
  if (state.filters.q)      p.set('q', state.filters.q);
  if (state.filters.part)   p.set('part', state.filters.part);
  if (state.filters.status) p.set('status', state.filters.status);

  try {
    state.chants = await apiFetch(`/api/chants?${p}`);
  } catch (err) {
    listCount.textContent = 'Error loading chants';
    console.error(err);
    return;
  }
  renderList();
}

async function loadTranslationSources() {
  try {
    const sources = await apiFetch('/api/translation_sources');
    for (const s of sources) {
      const opt = document.createElement('option');
      opt.value = s.code;
      opt.textContent = s.display_name;
      sourceSelect.appendChild(opt);
    }
  } catch (err) {
    console.error(err);
  }
}

async function loadStats() {
  try {
    const data = await apiFetch('/api/stats');
    const parts = [`${data.total} chants`];
    if (data.by_status) {
      const statuses = Object.entries(data.by_status)
        .map(([k, v]) => `${v} ${k}`)
        .join(', ');
      parts.push(statuses);
    }
    statsBadge.textContent = parts.join(' · ');
  } catch (_) {}
}

// ── Select & load a chant ─────────────────────────────────────────────────────
async function selectChant(id) {
  if (state.dirty && state.selected?.local_chant_id !== id) {
    if (!confirm('Discard unsaved changes?')) return;
  }

  // Highlight in list immediately
  document.querySelectorAll('.chant-item').forEach(el =>
    el.classList.toggle('active', el.dataset.id === id)
  );

  try {
    const chant = await apiFetch(`/api/chants/${id}`);
    state.selected = chant;
    state.original = structuredClone(chant);
    state.dirty = false;
    renderEditor();
  } catch (err) {
    alert('Failed to load chant: ' + err.message);
  }
}

// ── Render list ───────────────────────────────────────────────────────────────
function renderList() {
  const items = state.chants;
  listCount.textContent = `${items.length} chant${items.length !== 1 ? 's' : ''}`;
  chantList.innerHTML = '';

  const selectedId = state.selected?.local_chant_id;

  for (const c of items) {
    const li = document.createElement('li');
    li.className = 'chant-item' + (c.local_chant_id === selectedId ? ' active' : '');
    li.dataset.id = c.local_chant_id;

    const partCode = c.part || '';
    const partName = PART_NAMES[partCode] || partCode || '?';

    li.innerHTML =
      `<div class="item-name">${escHtml(c.canonical_name || c.incipit || '(unnamed)')}</div>` +
      `<div class="item-meta">` +
        `<span class="item-part ${escHtml(partCode)}">${partName}</span>` +
        `<span class="item-status ${escHtml(c.status || '')}">${escHtml(c.status || '')}</span>` +
        (c.mode ? `<span>${escHtml(c.mode)}</span>` : '') +
      `</div>`;

    li.addEventListener('click', () => selectChant(c.local_chant_id));
    chantList.appendChild(li);
  }
}

// ── Render editor ─────────────────────────────────────────────────────────────
function renderEditor() {
  const c = state.selected;
  if (!c) {
    emptyState.hidden = false;
    chantEditor.hidden = true;
    return;
  }

  emptyState.hidden = true;
  chantEditor.hidden = false;

  const partName = PART_NAMES[c.part] || c.part || '';
  chantTitle.innerHTML =
    (partName ? `<span class="part-label">${escHtml(partName)}</span>` : '') +
    escHtml(c.incipit || c.canonical_name || '(unnamed)');

  chantMeta.textContent = [
    c.canonical_name  ? `group: ${c.canonical_name}`        : null,
    c.version         ? `version: ${c.version}`              : null,
    c.mode            ? `mode: ${c.mode}`                    : null,
    c.transcriber     ? `transcriber: ${c.transcriber}`      : null,
    c.commentary      ? `commentary: ${c.commentary}`        : null,
  ].filter(Boolean).join('  ·  ');

  statusSelect.value  = c.status || 'draft';
  sourceSelect.value  = c.translation_source_code || '';
  exactCheck.checked  = !!c.is_text_exact;
  gabcTextarea.value  = c.gabc || '';

  setSaveStatus('', '');

  renderGabc(c.gabc || '', previewContainer);
  renderAssignments(c.assignments || []);
  renderLatinRefs(c.latin_refs || []);
}

const WKDAY_NAMES = ['', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CYCLE_SUN_NAMES = { '0': 'Year C', '1': 'Year A', '2': 'Year B' };
const CYCLE_WK_NAMES  = { '0': 'Yr II',  '1': 'Yr I' };

function formatAssignDay(a) {
  if (a.day_title) return escHtml(a.day_title);
  // General seasonal assignment
  const bits = [a.season, a.subseason, a.wknum != null ? `wk ${a.wknum}` : null]
    .filter(Boolean).join(' / ');
  let suffix = '';
  if (a.wkday) suffix += ` ${WKDAY_NAMES[a.wkday]}`;
  if (a.cycle_sun) suffix += ` ${CYCLE_SUN_NAMES[a.cycle_sun] || ''}`;
  if (a.cycle_wk)  suffix += ` ${CYCLE_WK_NAMES[a.cycle_wk]  || ''}`;
  return `<span class="general">${escHtml(bits)}${escHtml(suffix)}</span>`;
}

function renderAssignments(assignments) {
  const n = assignments.length;
  assignSummary.textContent = `Assigned To (${n})`;
  assignList.innerHTML = '';

  if (!n) {
    assignList.innerHTML = '<em class="render-note">No assignments found for this chant group</em>';
    return;
  }

  for (const a of assignments) {
    const row = document.createElement('div');
    row.className = 'assignment-row';

    const badges = [
      a.authority   ? `<span class="assign-badge authority">${escHtml(a.authority)}</span>`  : '',
      a.jurisdiction? `<span class="assign-badge">${escHtml(a.jurisdiction)}</span>` : '',
      a.notes       ? `<span class="assign-badge" title="${escHtml(a.notes)}">note</span>` : '',
    ].join('');

    row.innerHTML =
      `<span class="assign-part">${escHtml(a.part_name || a.part_code || '')}</span>` +
      `<span class="assign-day">${formatAssignDay(a)}</span>` +
      `<span class="assign-badges">${badges}</span>`;

    assignList.appendChild(row);
  }
}

function renderLatinRefs(refs) {
  const n = refs.length;
  latinSummary.textContent = `Latin Reference (${n} chant${n !== 1 ? 's' : ''})`;
  latinRefs.innerHTML = '';

  for (const ref of refs) {
    const div = document.createElement('div');
    div.className = 'latin-ref';

    const metaParts = [
      ref.mode      ? `mode ${ref.mode}`  : null,
      ref.version   ? ref.version         : null,
      ref.transcriber ? ref.transcriber   : null,
    ].filter(Boolean);

    div.innerHTML =
      `<div class="latin-ref-header">` +
        `<strong>${escHtml(ref.incipit || '(unnamed)')}</strong>` +
        (metaParts.length ? ` — ${escHtml(metaParts.join(' · '))}` : '') +
        `<span class="latin-ref-id">id: ${ref.gregobase_id}</span>` +
      `</div>` +
      `<div class="latin-ref-preview"></div>`;

    latinRefs.appendChild(div);

    const previewEl = div.querySelector('.latin-ref-preview');
    if (ref.gabc_body) {
      renderGabc(ref.gabc_body, previewEl, true);
    } else {
      previewEl.innerHTML = '<em class="render-note">No GABC available</em>';
    }
  }
}

// Re-render Latin refs when the section is opened (container now has width)
latinSection.addEventListener('toggle', () => {
  if (!latinSection.open || !state.selected) return;
  const previews = latinRefs.querySelectorAll('.latin-ref-preview');
  state.selected.latin_refs.forEach((ref, i) => {
    if (previews[i] && ref.gabc_body) {
      renderGabc(ref.gabc_body, previews[i], true);
    }
  });
});

// ── Save / Revert ─────────────────────────────────────────────────────────────
function markDirty() {
  if (!state.dirty) {
    state.dirty = true;
    setSaveStatus('● Unsaved changes', 'unsaved');
  }
}

function setSaveStatus(msg, cls) {
  saveStatus.textContent = msg;
  saveStatus.className = cls;
}

async function saveChant() {
  if (!state.selected) return;
  saveBtn.disabled = true;
  setSaveStatus('Saving…', '');

  const body = {
    gabc: gabcTextarea.value,
    status: statusSelect.value,
    translation_source_code: sourceSelect.value || null,
    is_text_exact: exactCheck.checked,
  };

  try {
    const updated = await apiFetch(`/api/chants/${state.selected.local_chant_id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    state.selected = updated;
    state.original = structuredClone(updated);
    state.dirty = false;
    setSaveStatus('✓ Saved', 'saved');

    // Sync the status badge in the list
    const listItem = chantList.querySelector(`[data-id="${updated.local_chant_id}"]`);
    if (listItem) {
      const badge = listItem.querySelector('.item-status');
      if (badge) {
        badge.textContent = updated.status || '';
        badge.className = `item-status ${updated.status || ''}`;
      }
    }
    // Refresh stats
    loadStats();
  } catch (err) {
    setSaveStatus(`✗ ${err.message}`, 'error');
  } finally {
    saveBtn.disabled = false;
  }
}

function revertChant() {
  if (!state.original) return;
  state.selected = structuredClone(state.original);
  state.dirty = false;
  renderEditor();
}

// ── Filters ───────────────────────────────────────────────────────────────────
function applyFilter(key, value) {
  state.filters[key] = value;
  loadChants();
}

// ── Event wiring ──────────────────────────────────────────────────────────────
let searchTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => applyFilter('q', searchInput.value.trim()), 300);
});

$('part-chips').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  $('part-chips').querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  applyFilter('part', chip.dataset.part);
});

$('status-chips').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  $('status-chips').querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  applyFilter('status', chip.dataset.status);
});

gabcTextarea.addEventListener('input', () => { markDirty(); schedulePreview(); });
statusSelect.addEventListener('change', markDirty);
sourceSelect.addEventListener('change', markDirty);
exactCheck.addEventListener('change', markDirty);

saveBtn.addEventListener('click', saveChant);

revertBtn.addEventListener('click', () => {
  if (!state.dirty || confirm('Revert all unsaved changes?')) revertChant();
});

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    if (state.selected) saveChant();
  }
});

// ── Utility ───────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Re-render preview on resize so the line width stays correct
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.selected?.gabc) renderGabc(state.selected.gabc, previewContainer);
  }, 250);
});

// ── Init ──────────────────────────────────────────────────────────────────────
Promise.all([loadChants(), loadStats(), loadTranslationSources()]);
