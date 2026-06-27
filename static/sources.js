'use strict';

// ── State ───────────────────────────────────────────────────────────────────
const state = {
  sources: [],          // list results (full LitPartSource objects)
  selected: null,       // currently shown source
  original: null,       // snapshot for revert
  parts: [],            // service_part reference
  filters: { book: 'GR', status: '', q: '' },
  bboxFilter: null,     // Set of text_ids when filtering by shared bbox; null = off
};

const $ = id => document.getElementById(id);

// DOM refs
const bookChips   = $('book-chips');
const statusChips = $('status-chips');
const srcSearch   = $('src-search');
const srcList        = $('src-list');
const srcListCount   = $('src-list-count');
const bboxFilterBanner = $('src-bbox-filter-banner');
const bboxFilterLabel  = $('src-bbox-filter-label');
const bboxFilterClear  = $('src-bbox-filter-clear');
const statsBadge  = $('src-stats-badge');
const emptyState  = $('src-empty-state');
const editor      = $('src-editor');
const srcTitle    = $('src-title');
const srcMeta     = $('src-meta');
const seStatus    = $('se-status');
const sePart      = $('se-part');
const seEpoch     = $('se-epoch');
const seWkday     = $('se-wkday');
const seTextsrc   = $('se-textsrc');
const seOriginal  = $('se-original');
const seVernacular= $('se-vernacular');
const seBbox      = $('se-bbox');
const seChantSection = $('src-chant-section');
const seChantMeta    = $('src-chant-meta');
const seChantPreview = $('src-chant-preview');
const seApprove   = $('se-approve');
const seReject    = $('se-reject');
const seSave      = $('se-save');
const seRevert    = $('se-revert');
const seMsg       = $('se-status-msg');
const imgLabel    = $('src-image-label');
const pageImg     = $('src-page-img');
const bboxOverlay = $('src-bbox-overlay');

// ── API helpers ──────────────────────────────────────────────────────────────
async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch (_) {}
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

// ── List ─────────────────────────────────────────────────────────────────────
async function loadList() {
  const p = new URLSearchParams();
  if (state.filters.book)   p.set('book', state.filters.book);
  if (state.filters.status) p.set('status', state.filters.status);
  if (state.filters.q)      p.set('q', state.filters.q);
  // When viewing "all sources", restrict to provenanced rows (those reviewable
  // against a page image); GR filter already implies provenance.
  if (!state.filters.book)  p.set('provenanced', 'true');
  state.bboxFilter = null;
  try {
    state.sources = await api('/api/lit_part_sources?' + p.toString());
  } catch (e) {
    srcList.innerHTML = `<li class="src-error">Error: ${e.message}</li>`;
    return;
  }
  renderList();
  renderStats();
}

function renderList() {
  const visible = state.bboxFilter
    ? state.sources.filter(s => state.bboxFilter.has(s.text_id))
    : state.sources;

  if (state.bboxFilter) {
    bboxFilterLabel.textContent = `Bbox filter — ${visible.length} source(s)`;
    bboxFilterBanner.hidden = false;
  } else {
    bboxFilterBanner.hidden = true;
  }

  srcList.innerHTML = '';
  srcListCount.textContent = `${state.sources.length} source(s)`;
  let lastPage = null;
  for (const s of visible) {
    const pageKey = `${s.book || '—'}/${s.pdf_page_num || '—'}`;
    if (pageKey !== lastPage) {
      const hdr = document.createElement('li');
      hdr.className = 'src-page-hdr';
      hdr.textContent = s.book
        ? `${s.book} p.${s.pdf_page_num}` + (s.printed_page_num ? ` (printed ${s.printed_page_num})` : '')
        : 'no page provenance';
      srcList.appendChild(hdr);
      lastPage = pageKey;
    }
    const li = document.createElement('li');
    li.className = 'src-item' + (state.selected && state.selected.text_id === s.text_id ? ' selected' : '');
    li.dataset.id = s.text_id;
    const incipit = (s.original_text || '(no text)').slice(0, 48);
    const partLabel = s.part_display_name || s.service_part;
    li.innerHTML =
      `<span class="src-part part-${s.service_part}">${escapeHtml(partLabel)}</span>` +
      `<span class="src-incipit">${escapeHtml(incipit)}</span>` +
      `<span class="src-status status-${s.status}">${s.status}</span>`;
    li.addEventListener('click', () => selectSource(s.text_id));
    srcList.appendChild(li);
  }
}

function renderStats() {
  const counts = {};
  for (const s of state.sources) counts[s.status] = (counts[s.status] || 0) + 1;
  const parts = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ');
  statsBadge.textContent = `${state.sources.length} shown${parts ? ' — ' + parts : ''}`;
}

// ── Chant engraving rendering ────────────────────────────────────────────────
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
    const rect = container.getBoundingClientRect();
    const w = Math.max((rect.width || container.clientWidth) - 32, 300);
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

async function loadChantEngraving(s) {
  if (!s.chant_uuid) {
    seChantSection.hidden = true;
    return;
  }
  seChantSection.hidden = false;
  seChantMeta.textContent = s.chant_uuid;
  seChantPreview.innerHTML = '<em class="render-note">Loading…</em>';
  try {
    const chant = await api('/api/chant_by_uuid?uuid=' + encodeURIComponent(s.chant_uuid));
    const parts = [chant.incipit, chant.mode ? `mode ${chant.mode}` : null, chant.version]
      .filter(Boolean).join(' · ');
    seChantMeta.textContent = parts || s.chant_uuid;
    renderGabc(chant.gabc_body, seChantPreview);
  } catch (e) {
    seChantPreview.innerHTML = `<em class="render-note">Error: ${escapeHtml(e.message)}</em>`;
  }
}

// ── Selection / editor ───────────────────────────────────────────────────────
function selectSource(textId) {
  const s = state.sources.find(x => x.text_id === textId);
  if (!s) return;
  state.selected = s;
  state.original = { ...s };
  renderList();  // refresh selected highlight

  emptyState.hidden = true;
  editor.hidden = false;
  seMsg.textContent = '';

  srcTitle.textContent = `#${s.text_id} · ${s.service_part.toUpperCase()}`;
  srcMeta.textContent = [s.epoch_title, s.assignment_authority_code]
    .filter(Boolean).join(' · ');

  seStatus.value = s.status;
  sePart.value = s.service_part;
  seEpoch.value = s.lit_epoch_slug || '';
  seWkday.value = s.wkday == null ? '' : s.wkday;
  seTextsrc.value = s.text_src || '';
  seOriginal.value = s.original_text || '';
  seVernacular.value = s.vernacular_text || '';
  seBbox.value = s.bbox || '';
  $('se-bbox-label').textContent = s.part_display_name || s.service_part;

  loadPageImage(s);
  drawSiblingOverlays();
  loadChantEngraving(s);
}

function loadPageImage(s) {
  if (s.book && s.pdf_page_num != null) {
    imgLabel.textContent =
      `${s.book} p.${s.pdf_page_num}` +
      (s.printed_page_num ? ` (printed ${s.printed_page_num})` : '');
    pageImg.src = `/api/books/${encodeURIComponent(s.book)}/${s.pdf_page_num}/image`;
    pageImg.style.display = '';
  } else {
    imgLabel.textContent = 'No page image (text-only source)';
    pageImg.removeAttribute('src');
    pageImg.style.display = 'none';
    bboxOverlay.style.display = 'none';
  }
}

// ── bbox overlay ─────────────────────────────────────────────────────────────
function parseBbox(str) {
  if (!str) return null;
  const parts = str.split(',').map(t => parseFloat(t.trim()));
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n))) return null;
  return parts; // x0,y0,x1,y1
}

function drawOverlay() {
  const box = parseBbox(seBbox.value);
  if (!box || !pageImg.naturalWidth || pageImg.style.display === 'none') {
    bboxOverlay.style.display = 'none';
    return;
  }
  const scale = pageImg.clientWidth / pageImg.naturalWidth;
  // The image is inset by the wrapper's padding; offset the overlay to match.
  const ox = pageImg.offsetLeft;
  const oy = pageImg.offsetTop;
  const [x0, y0, x1, y1] = box;
  bboxOverlay.style.display = 'block';
  bboxOverlay.style.left   = (ox + x0 * scale) + 'px';
  bboxOverlay.style.top    = (oy + y0 * scale) + 'px';
  bboxOverlay.style.width  = ((x1 - x0) * scale) + 'px';
  bboxOverlay.style.height = ((y1 - y0) * scale) + 'px';
}

function drawSiblingOverlays() {
  // Remove previous sibling overlays
  const imageWrap = bboxOverlay.parentElement;
  imageWrap.querySelectorAll('.sibling-bbox').forEach(el => el.remove());

  if (!state.selected || !pageImg.naturalWidth || pageImg.style.display === 'none') return;
  const { book, pdf_page_num, text_id } = state.selected;
  if (!book || pdf_page_num == null) return;

  const scale = pageImg.clientWidth / pageImg.naturalWidth;
  const ox = pageImg.offsetLeft;
  const oy = pageImg.offsetTop;

  for (const s of state.sources) {
    if (s.text_id === text_id) continue;
    if (s.book !== book || s.pdf_page_num !== pdf_page_num) continue;
    const box = parseBbox(s.bbox);
    if (!box) continue;
    const [x0, y0, x1, y1] = box;
    const div = document.createElement('div');
    div.className = `sibling-bbox status-${s.status}`;
    div.title = `#${s.text_id} ${s.part_display_name || s.service_part}`;
    const lbl = document.createElement('span');
    lbl.className = 'bbox-label';
    lbl.textContent = s.part_display_name || s.service_part;
    div.appendChild(lbl);
    div.style.left   = (ox + x0 * scale) + 'px';
    div.style.top    = (oy + y0 * scale) + 'px';
    div.style.width  = ((x1 - x0) * scale) + 'px';
    div.style.height = ((y1 - y0) * scale) + 'px';
    imageWrap.appendChild(div);
  }
}

pageImg.addEventListener('load', () => { drawOverlay(); drawSiblingOverlays(); });
window.addEventListener('resize', () => { drawOverlay(); drawSiblingOverlays(); });
seBbox.addEventListener('input', drawOverlay);

// ── Click on image wrap to select/filter by sibling bbox ─────────────────────
const imageWrapEl = bboxOverlay.parentElement;
imageWrapEl.addEventListener('click', e => {
  // Ignore clicks that originated on the selected-bbox overlay (drag handles etc.)
  if (bboxOverlay.contains(e.target)) return;
  if (!state.selected || !pageImg.naturalWidth || pageImg.style.display === 'none') return;

  const { book, pdf_page_num, text_id } = state.selected;
  if (!book || pdf_page_num == null) return;

  // Convert click position to natural image coordinates
  const scale = pageImg.clientWidth / pageImg.naturalWidth;
  const ox = pageImg.offsetLeft;
  const oy = pageImg.offsetTop;
  const wrapRect = imageWrapEl.getBoundingClientRect();
  const cx = (e.clientX - wrapRect.left - ox) / scale;
  const cy = (e.clientY - wrapRect.top - oy) / scale;

  // Find siblings whose bbox contains the click point
  const hits = state.sources.filter(s => {
    if (s.text_id === text_id) return false;
    if (s.book !== book || s.pdf_page_num !== pdf_page_num) return false;
    const box = parseBbox(s.bbox);
    if (!box) return false;
    const [x0, y0, x1, y1] = box;
    return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
  });

  if (hits.length === 0) return;
  if (hits.length === 1) {
    state.bboxFilter = null;
    selectSource(hits[0].text_id);
  } else {
    state.bboxFilter = new Set(hits.map(s => s.text_id));
    renderList();
  }
});

bboxFilterClear.addEventListener('click', () => {
  state.bboxFilter = null;
  renderList();
});

// ── Drag / resize the bbox directly on the image ─────────────────────────────
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const MIN_SIZE = 6; // minimum box size in natural px
let drag = null;    // active gesture: {mode, startX, startY, box, natPerDisp}

function buildHandles() {
  for (const h of HANDLES) {
    const el = document.createElement('div');
    el.className = 'bbox-handle bbox-' + h;
    el.dataset.handle = h;
    bboxOverlay.appendChild(el);
  }
  bboxOverlay.addEventListener('pointerdown', onBboxPointerDown);
}

function onBboxPointerDown(e) {
  const box = parseBbox(seBbox.value);
  if (!box || !pageImg.naturalWidth || pageImg.style.display === 'none') return;
  e.preventDefault();
  drag = {
    mode: e.target.dataset.handle || 'move',
    startX: e.clientX,
    startY: e.clientY,
    box: box.slice(),
    natPerDisp: pageImg.naturalWidth / pageImg.clientWidth,
  };
  bboxOverlay.setPointerCapture(e.pointerId);
  window.addEventListener('pointermove', onBboxPointerMove);
  window.addEventListener('pointerup', onBboxPointerUp);
}

function onBboxPointerMove(e) {
  if (!drag) return;
  const W = pageImg.naturalWidth, H = pageImg.naturalHeight;
  const dx = (e.clientX - drag.startX) * drag.natPerDisp;
  const dy = (e.clientY - drag.startY) * drag.natPerDisp;
  let [x0, y0, x1, y1] = drag.box;
  const m = drag.mode;

  if (m === 'move') {
    const w = x1 - x0, h = y1 - y0;
    x0 = Math.min(Math.max(0, x0 + dx), W - w); x1 = x0 + w;
    y0 = Math.min(Math.max(0, y0 + dy), H - h); y1 = y0 + h;
  } else {
    if (m.includes('w')) x0 = Math.min(Math.max(0, x0 + dx), x1 - MIN_SIZE);
    if (m.includes('e')) x1 = Math.max(Math.min(W, x1 + dx), x0 + MIN_SIZE);
    if (m.includes('n')) y0 = Math.min(Math.max(0, y0 + dy), y1 - MIN_SIZE);
    if (m.includes('s')) y1 = Math.max(Math.min(H, y1 + dy), y0 + MIN_SIZE);
  }

  seBbox.value = [x0, y0, x1, y1].map(Math.round).join(',');
  drawOverlay();
}

function onBboxPointerUp() {
  drag = null;
  window.removeEventListener('pointermove', onBboxPointerMove);
  window.removeEventListener('pointerup', onBboxPointerUp);
}

// ── Save / approve ───────────────────────────────────────────────────────────
function buildPayload() {
  const wkRaw = seWkday.value.trim();
  return {
    status: seStatus.value,
    service_part: sePart.value,
    lit_epoch_slug: seEpoch.value.trim() || null,
    wkday: wkRaw === '' ? null : parseInt(wkRaw, 10),
    text_src: seTextsrc.value.trim() || null,
    original_text: seOriginal.value || null,
    vernacular_text: seVernacular.value || null,
    bbox: seBbox.value.trim() || null,
  };
}

async function save(newStatus) {
  if (!state.selected) return;
  if (newStatus) seStatus.value = newStatus;
  const payload = buildPayload();
  seMsg.textContent = 'Saving…';
  try {
    const updated = await api(`/api/lit_part_sources/${state.selected.text_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    // update local copy in list
    const idx = state.sources.findIndex(x => x.text_id === updated.text_id);
    if (idx !== -1) state.sources[idx] = updated;
    state.selected = updated;
    state.original = { ...updated };
    seMsg.textContent = '✓ Saved';
    renderList();
    renderStats();
    srcMeta.textContent = [updated.epoch_title, updated.assignment_authority_code]
      .filter(Boolean).join(' · ');
  } catch (e) {
    seMsg.textContent = 'Error: ' + e.message;
  }
}

function revert() {
  if (state.original) selectSource(state.original.text_id);
}

seSave.addEventListener('click', () => save());
seApprove.addEventListener('click', () => save('reviewed'));
seReject.addEventListener('click', () => save('rejected'));
seRevert.addEventListener('click', revert);

// ── Filters ──────────────────────────────────────────────────────────────────
function wireChips(container, key) {
  container.addEventListener('click', e => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    container.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    state.filters[key] = btn.dataset[key];
    loadList();
  });
}
wireChips(bookChips, 'book');
wireChips(statusChips, 'status');

let searchTimer = null;
srcSearch.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.filters.q = srcSearch.value.trim();
    loadList();
  }, 250);
});

// ── Misc ─────────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadParts() {
  try {
    state.parts = await api('/api/service_parts');
  } catch (_) { state.parts = []; }
  sePart.innerHTML = '';
  for (const p of state.parts) {
    const opt = document.createElement('option');
    opt.value = p.part_code;
    opt.textContent = `${p.part_code} — ${p.display_name}`;
    sePart.appendChild(opt);
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────
(async function init() {
  buildHandles();
  await loadParts();
  await loadList();
})();
