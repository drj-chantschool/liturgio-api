'use strict';

// ── State ───────────────────────────────────────────────────────────────────
const state = {
  sources: [],          // list results (full LitPartSource objects)
  selected: null,       // currently shown source
  original: null,       // snapshot for revert
  parts: [],            // service_part reference
  filters: { book: '', status: 'draft', q: '' },
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
const seCycle     = $('se-cycle');
const seBrowseBtn = $('se-browse-btn');
const seNewBtn    = $('se-new-btn');

const imgLabel    = $('src-image-label');
const pageImg     = $('src-page-img');
const bboxOverlay = $('src-bbox-overlay');
const nextImgLabel = $('next-image-label');
const nextImgWrap  = $('next-image-wrap');
const nextPageImg  = $('next-page-img');
const refImgLabel = $('ref-image-label');
const refImgWrap  = $('ref-image-wrap');
const refPageImg  = $('ref-page-img');

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
  if (state.filters.status) p.set('review_status', state.filters.status);
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
    const pageKey = `${s.book || '—'}/${s.printed_page_num || '—'}`;
    if (pageKey !== lastPage) {
      const hdr = document.createElement('li');
      hdr.className = 'src-page-hdr';
      hdr.textContent = s.book
        ? `${s.book} p.${s.printed_page_num}`
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
      `<span class="src-status status-${s.review_status}">${s.review_status}</span>`;
    li.addEventListener('click', () => selectSource(s.text_id));
    srcList.appendChild(li);
  }
}

function renderStats() {
  const counts = {};
  for (const s of state.sources) counts[s.review_status] = (counts[s.review_status] || 0) + 1;
  const parts = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ');
  statsBadge.textContent = `${state.sources.length} shown${parts ? ' — ' + parts : ''}`;
}

// ── Chant engraving rendering ────────────────────────────────────────────────
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
    renderGabc(chant.gabc_body, seChantPreview, chant.verses_html);
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
  srcMeta.textContent = [s.epoch_title, s.book]
    .filter(Boolean).join(' · ');

  seStatus.value = s.review_status;
  sePart.value = s.service_part;
  seEpoch.value = s.lit_epoch_slug || '';
  seWkday.value = s.wkday == null ? '' : s.wkday;
  const cycleStr = s.cycle_sun != null
    ? 'cycle ' + ['C','A','B'][s.cycle_sun % 3]
    : s.cycle_wkday != null
      ? 'cycle ' + ['II','I'][s.cycle_wkday % 2]
      : '';
  seCycle.textContent = cycleStr;
  seCycle.hidden = !cycleStr;
  seTextsrc.value = s.text_src || '';
  seOriginal.value = s.original_text || '';
  seVernacular.value = s.vernacular_text || '';
  seBbox.value = s.bbox || '';

  loadPageImage(s);
  drawSiblingOverlays();
  loadChantEngraving(s);
}

function loadPageImage(s) {
  if (s.book && s.printed_page_num != null) {
    imgLabel.textContent = `${s.book} p.${s.printed_page_num}`;
    pageImg.src = `/api/books/${encodeURIComponent(s.book)}/${s.printed_page_num}/image`;
    pageImg.style.display = '';
  } else {
    imgLabel.textContent = 'No page image (text-only source)';
    pageImg.removeAttribute('src');
    pageImg.style.display = 'none';
    bboxOverlay.style.display = 'none';
  }

  // printed_page_num is a string (books.printed_page_num is a VARCHAR), so it has
  // to be coerced before arithmetic: '15' + 1 is '151', not 16.
  const nextPage = Number(s.printed_page_num) + 1;
  if (s.book && s.printed_page_num != null && Number.isFinite(nextPage)) {
    nextImgLabel.textContent = `${s.book} p.${nextPage}`;
    nextImgLabel.hidden = false;
    nextPageImg.src = `/api/books/${encodeURIComponent(s.book)}/${nextPage}/image`;
    nextImgWrap.hidden = false;
  } else {
    nextImgLabel.hidden = true;
    nextImgWrap.hidden = true;
    nextPageImg.removeAttribute('src');
  }

  if (s.book && s.ref_printed_page_num != null) {
    refImgLabel.textContent = `${s.book} p.${s.ref_printed_page_num}`;
    refImgLabel.hidden = false;
    refPageImg.src = `/api/books/${encodeURIComponent(s.book)}/${s.ref_printed_page_num}/image`;
    refImgWrap.hidden = false;
  } else {
    refImgLabel.hidden = true;
    refImgWrap.hidden = true;
    refPageImg.removeAttribute('src');
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
  const { book, printed_page_num, text_id } = state.selected;
  if (!book || printed_page_num == null) return;

  const scale = pageImg.clientWidth / pageImg.naturalWidth;
  const ox = pageImg.offsetLeft;
  const oy = pageImg.offsetTop;

  for (const s of state.sources) {
    if (s.text_id === text_id) continue;
    if (s.book !== book || s.printed_page_num !== printed_page_num) continue;
    const box = parseBbox(s.bbox);
    if (!box) continue;
    const [x0, y0, x1, y1] = box;
    const div = document.createElement('div');
    div.className = `sibling-bbox status-${s.review_status}`;
    div.title = `#${s.text_id} ${s.part_display_name || s.service_part}`;
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

  const { book, printed_page_num, text_id } = state.selected;
  if (!book || printed_page_num == null) return;

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
    if (s.book !== book || s.printed_page_num !== printed_page_num) return false;
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
    review_status: seStatus.value,
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
    srcMeta.textContent = [updated.epoch_title, updated.book]
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

async function loadBooks() {
  let books = [];
  try { books = await api('/api/lit_part_sources/books'); } catch (_) {}
  bookChips.innerHTML = '';
  for (const b of books) {
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.dataset.book = b;
    btn.textContent = b;
    bookChips.appendChild(btn);
  }
  const allBtn = document.createElement('button');
  allBtn.className = 'chip';
  allBtn.dataset.book = '';
  allBtn.textContent = 'All sources';
  bookChips.appendChild(allBtn);
  // Default to first book
  const defaultBook = books[0] ?? '';
  state.filters.book = defaultBook;
  const active = bookChips.querySelector(`[data-book="${CSS.escape(defaultBook)}"]`);
  if (active) active.classList.add('active');
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

// ── Browse / new-chant panels ─────────────────────────────────────────────────
function hidePanels() {
  browser.hide();
  newChant.hide();
}

const browser = createGregobaseBrowser({
  panel: $('gri-browse-panel'),
  api,
  onAssign: async gregobaseId => {
    if (!state.selected) throw new Error('No source selected');
    const updated = await api(`/api/lit_part_sources/${state.selected.text_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chant_uuid: `gregobase:${gregobaseId}` }),
    });
    const idx = state.sources.findIndex(x => x.text_id === updated.text_id);
    if (idx !== -1) state.sources[idx] = updated;
    state.selected = updated;
    state.original = { ...updated };
    seMsg.textContent = `✓ Assigned gregobase:${gregobaseId}`;
    loadChantEngraving(updated);
  },
});

seBrowseBtn.addEventListener('click', () => {
  hidePanels();
  browser.open({ part: state.selected?.service_part });
});

const newChant = createNewChantPanel({
  panel: $('gri-new-panel'),
  onSave: async payload => {
    if (!state.selected) throw new Error('No source selected');
    const textId = state.selected.text_id;
    await api(`/api/lit_part_assignments/${textId}/local_chant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    // Re-fetch the source to get updated chant_uuid
    const updated = await api(`/api/lit_part_sources/${textId}`);
    const idx = state.sources.findIndex(x => x.text_id === textId);
    if (idx !== -1) state.sources[idx] = updated;
    state.selected = updated;
    state.original = { ...updated };
    seMsg.textContent = '✓ New local chant created and assigned';
    loadChantEngraving(updated);
  },
});

seNewBtn.addEventListener('click', () => {
  hidePanels();
  newChant.open({ incipit: (state.selected?.original_text || '').slice(0, 60) });
});

// ── Init ─────────────────────────────────────────────────────────────────────
(async function init() {
  buildHandles();
  await Promise.all([loadParts(), browser.init(), loadBooks()]);
  await loadList();

  // Select a source via URL hash (e.g. /sources#123) — used by assignment review links
  const hashId = parseInt(window.location.hash.slice(1), 10);
  if (!isNaN(hashId)) {
    const exists = state.sources.find(s => s.text_id === hashId);
    if (exists) {
      selectSource(hashId);
    } else {
      // Source may not be in the current filter — fetch it directly
      try {
        const src = await api(`/api/lit_part_sources/${hashId}`);
        state.sources = [src, ...state.sources];
        renderList();
        renderStats();
        selectSource(hashId);
      } catch (_) {}
    }
  }
})();
