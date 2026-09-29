'use strict';

// ── State ───────────────────────────────────────────────────────────────────
const state = {
  sources: [],          // list results (full LitPartSource objects)
  selected: null,       // currently shown source
  original: null,       // snapshot for revert
  parts: [],            // service_part reference
  filters: { book: '', status: 'draft', q: '' },
  bboxFilter: null,     // Set of text_ids when filtering by shared bbox; null = off
  browse: {
    groups: [],
    selected: null,
    chants: [],
    selectedChant: null,
  },
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

// Browse / new-chant panel refs
const browsePanelEl         = $('gri-browse-panel');
const browsePartSel         = $('gri-browse-part');
const browseLetterSel       = $('gri-browse-letter');
const browseLetterSel2Wrap  = $('gri-browse-letter2-wrap');
const browseLetterSel2      = $('gri-browse-letter2');
const browseCloseBtnEl      = $('gri-browse-close-btn');
const browseMsgEl           = $('gri-browse-msg');
const browseListEl          = $('gri-browse-list');
const browseDetailMetaEl    = $('gri-browse-detail-meta');
const browseChantListEl     = $('gri-browse-chant-list');
const browseChantUl         = $('gri-browse-chant-ul');
const browseDetailEngravEl  = $('gri-browse-detail-engrav');
const browseDetailActionsEl = $('gri-browse-detail-actions');
const browseAssignBtnEl     = $('gri-browse-assign-btn');
const newPanelEl            = $('gri-new-panel');
const newIncipitEl          = $('gri-new-incipit');
const newModeEl             = $('gri-new-mode');
const newVersionEl          = $('gri-new-version');
const newNameEl             = $('gri-new-name');
const newGabcEl             = $('gri-new-gabc');
const newPreviewDivEl       = $('gri-new-preview');
const newPreviewBtnEl       = $('gri-new-preview-btn');
const newSaveBtnEl          = $('gri-new-save-btn');
const newCloseBtnEl         = $('gri-new-close-btn');
const newMsgEl              = $('gri-new-msg');

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
function extractGabcBody(gabc) {
  if (!gabc) return '';
  const parts = gabc.split('%%');
  return parts.length > 1 ? parts[parts.length - 1].trim() : gabc.trim();
}

function hidePanels() {
  browsePanelEl.hidden = true;
  newPanelEl.hidden = true;
}

async function loadBrowseParts() {
  try {
    const parts = await api('/api/gregobase_parts');
    browsePartSel.innerHTML = '';
    for (const p of parts) {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p;
      browsePartSel.appendChild(opt);
    }
    await loadBrowseLetters();
  } catch (_) {}
}

async function loadBrowseLetters() {
  const part = browsePartSel.value;
  if (!part) return;
  try {
    const letters = await api('/api/gregobase_letters?part=' + encodeURIComponent(part));
    const prev = browseLetterSel.value;
    browseLetterSel.innerHTML = '';
    for (const l of letters) {
      const opt = document.createElement('option');
      opt.value = l;
      opt.textContent = l;
      browseLetterSel.appendChild(opt);
    }
    if (letters.includes(prev)) browseLetterSel.value = prev;
  } catch (_) {}
  await loadBrowseLetter2();
}

async function loadBrowseLetter2() {
  const part = browsePartSel.value;
  const letter = browseLetterSel.value;
  if (!part || !letter) { browseLetterSel2Wrap.hidden = true; return; }
  try {
    const sub = await api('/api/gregobase_letters?part=' + encodeURIComponent(part) + '&prefix=' + encodeURIComponent(letter));
    if (sub.length > 1) {
      const prev = browseLetterSel2.value;
      browseLetterSel2.innerHTML = '';
      for (const l of sub) {
        const opt = document.createElement('option');
        opt.value = l;
        opt.textContent = l;
        browseLetterSel2.appendChild(opt);
      }
      if (sub.includes(prev)) browseLetterSel2.value = prev;
      browseLetterSel2Wrap.hidden = false;
    } else {
      browseLetterSel2Wrap.hidden = true;
    }
  } catch (_) { browseLetterSel2Wrap.hidden = true; }
}

async function runBrowseLoad() {
  const part = browsePartSel.value;
  const prefix = browseLetterSel2Wrap.hidden ? browseLetterSel.value : browseLetterSel2.value;
  if (!part || !prefix) return;
  browseMsgEl.textContent = 'Loading…';
  browseListEl.innerHTML = '';
  clearBrowseDetail();
  state.browse.groups = [];
  state.browse.selected = null;
  try {
    const p = new URLSearchParams({ part, prefix, limit: '300' });
    state.browse.groups = await api('/api/gr_index_browse?' + p.toString());
    browseMsgEl.textContent = `${state.browse.groups.length} group(s)`;
    renderBrowseList();
  } catch (e) {
    browseMsgEl.textContent = 'Error: ' + e.message;
  }
}

function renderBrowseList() {
  browseListEl.innerHTML = '';
  if (!state.browse.groups.length) {
    const li = document.createElement('li');
    li.className = 'gri-browse-empty';
    li.textContent = 'No groups found.';
    browseListEl.appendChild(li);
    return;
  }
  for (const g of state.browse.groups) {
    const li = document.createElement('li');
    li.className = 'gri-browse-list-item';
    li.dataset.gid = g.chant_group_id;
    li.textContent = g.incipit || g.canonical_name || `group ${g.chant_group_id}`;
    li.addEventListener('click', () => selectBrowseGroup(g));
    browseListEl.appendChild(li);
  }
}

async function selectBrowseGroup(g) {
  state.browse.selected = g;
  state.browse.chants = [];
  state.browse.selectedChant = null;
  browseListEl.querySelectorAll('.gri-browse-list-item').forEach(li => {
    li.classList.toggle('active', li.dataset.gid == g.chant_group_id);
  });
  browseDetailMetaEl.innerHTML =
    `<strong>${escapeHtml(g.incipit || g.canonical_name || '')}</strong>`;
  browseChantUl.innerHTML = '<li class="gri-browse-empty">Loading…</li>';
  browseChantListEl.hidden = false;
  browseDetailEngravEl.innerHTML = '';
  browseDetailActionsEl.hidden = true;
  try {
    state.browse.chants = await api(`/api/chant_groups/${g.chant_group_id}/gregobase_chants`);
  } catch (_) { state.browse.chants = []; }
  if (!state.browse.chants.length && g.best_gregobase_id) {
    state.browse.chants = [{ gregobase_id: g.best_gregobase_id, mode: g.best_mode,
      version: g.best_version, gabc_body: g.best_gabc_body }];
  }
  renderBrowseChantList();
  if (state.browse.chants.length === 1) selectBrowseChant(state.browse.chants[0]);
}

function renderBrowseChantList() {
  const chants = state.browse.chants;
  browseChantUl.innerHTML = '';
  if (!chants.length) {
    browseChantListEl.hidden = true;
    return;
  }
  if (chants.length === 1) { browseChantListEl.hidden = true; return; }
  browseChantListEl.hidden = false;
  for (const c of chants) {
    const li = document.createElement('li');
    li.className = 'gri-browse-chant-item';
    li.dataset.gbid = c.gregobase_id;
    li.innerHTML =
      `<span class="gri-chant-version">${escapeHtml(c.version || '—')}</span>` +
      (c.mode ? ` <span class="mgp-badge">mode ${escapeHtml(c.mode)}</span>` : '') +
      ` <span class="gri-gb-id">#${c.gregobase_id}</span>`;
    li.addEventListener('click', () => selectBrowseChant(c));
    browseChantUl.appendChild(li);
  }
}

function selectBrowseChant(c) {
  state.browse.selectedChant = c;
  browseChantUl.querySelectorAll('.gri-browse-chant-item').forEach(li => {
    li.classList.toggle('active', li.dataset.gbid == c.gregobase_id);
  });
  browseDetailEngravEl.innerHTML = '';
  if (c.gabc_body) renderGabc(c.gabc_body, browseDetailEngravEl);
  else browseDetailEngravEl.innerHTML = '<em class="render-note">No GABC</em>';
  browseDetailActionsEl.hidden = false;
}

function clearBrowseDetail() {
  browseDetailMetaEl.innerHTML = '';
  browseChantUl.innerHTML = '';
  browseChantListEl.hidden = true;
  browseDetailEngravEl.innerHTML = '';
  browseDetailActionsEl.hidden = true;
  state.browse.chants = [];
  state.browse.selectedChant = null;
}

browseCloseBtnEl.addEventListener('click', () => { browsePanelEl.hidden = true; });
browseLetterSel.addEventListener('change', async () => { await loadBrowseLetter2(); runBrowseLoad(); });
browseLetterSel2.addEventListener('change', runBrowseLoad);
browsePartSel.addEventListener('change', async () => {
  await loadBrowseLetters();
  runBrowseLoad();
});

browseAssignBtnEl.addEventListener('click', async () => {
  if (!state.selected || !state.browse.selectedChant) return;
  browseMsgEl.textContent = 'Assigning…';
  const gregobaseId = state.browse.selectedChant.gregobase_id;
  try {
    const updated = await api(`/api/lit_part_sources/${state.selected.text_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chant_uuid: `gregobase:${gregobaseId}` }),
    });
    const idx = state.sources.findIndex(x => x.text_id === updated.text_id);
    if (idx !== -1) state.sources[idx] = updated;
    state.selected = updated;
    state.original = { ...updated };
    browsePanelEl.hidden = true;
    seMsg.textContent = `✓ Assigned gregobase:${gregobaseId}`;
    loadChantEngraving(updated);
  } catch (e) {
    browseMsgEl.textContent = 'Error: ' + e.message;
  }
});

seBrowseBtn.addEventListener('click', async () => {
  hidePanels();
  browsePanelEl.hidden = false;
  if (state.selected?.service_part) browsePartSel.value = state.selected.service_part;
  await loadBrowseLetters();
  runBrowseLoad();
});

newCloseBtnEl.addEventListener('click', () => { newPanelEl.hidden = true; });

newPreviewBtnEl.addEventListener('click', () => {
  const body = extractGabcBody(newGabcEl.value.trim());
  if (body) renderGabc(body, newPreviewDivEl);
  else newPreviewDivEl.innerHTML = '<em class="render-note">No GABC to preview</em>';
});

newSaveBtnEl.addEventListener('click', async () => {
  if (!state.selected) return;
  const gabc = newGabcEl.value.trim();
  if (!gabc) { newMsgEl.textContent = 'GABC cannot be empty.'; return; }
  newMsgEl.textContent = 'Saving…';
  newSaveBtnEl.disabled = true;
  try {
    await api(`/api/lit_part_assignments/${state.selected.text_id}/local_chant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gabc,
        incipit: newIncipitEl.value.trim() || null,
        mode: newModeEl.value.trim() || null,
        version: newVersionEl.value.trim() || 'latin',
        canonical_name: newNameEl.value.trim() || null,
      }),
    });
    // Re-fetch the source to get updated chant_uuid
    const textId = state.selected.text_id;
    const updated = await api(`/api/lit_part_sources/${textId}`);
    const idx = state.sources.findIndex(x => x.text_id === textId);
    if (idx !== -1) state.sources[idx] = updated;
    state.selected = updated;
    state.original = { ...updated };
    newPanelEl.hidden = true;
    seMsg.textContent = '✓ New local chant created and assigned';
    loadChantEngraving(updated);
  } catch (e) {
    newMsgEl.textContent = 'Error: ' + e.message;
  } finally {
    newSaveBtnEl.disabled = false;
  }
});

seNewBtn.addEventListener('click', () => {
  hidePanels();
  newIncipitEl.value = state.selected ? (state.selected.original_text || '').slice(0, 60) : '';
  newModeEl.value = '';
  newVersionEl.value = 'latin';
  newNameEl.value = '';
  newGabcEl.value = '';
  newPreviewDivEl.innerHTML = '';
  newMsgEl.textContent = '';
  newPanelEl.hidden = false;
  newGabcEl.focus();
});

// ── Init ─────────────────────────────────────────────────────────────────────
(async function init() {
  buildHandles();
  await Promise.all([loadParts(), loadBrowseParts(), loadBooks()]);
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
