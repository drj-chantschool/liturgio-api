'use strict';

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  parts: [],         // from /api/service_parts
  seasons: [],       // [{slug, kind, title}] season epochs
  weekOptions: [],   // full week epoch objects for the day-kind dropdown
  kind: 'week',      // active kind chip
  season: null,      // selected season slug
  weekSlug: null,    // selected week slug (day kind only)
  weekData: null,    // full week epoch object
  month: null,       // selected nominal month (1-12, saint kind only)
  chapter: null,     // selected Graduale chapter code (ritual kind only)
  epochs: [],        // current epoch list shown in sidebar
  selectedSlug: null,
  reviewData: null,  // response from /api/lit_epochs/{slug}/assignments_review

  // Composition workflow
  textSources: [],   // [{code, display_name}]
  chantSources: [],  // [{code, display_name}]
  textSource: null,  // active translation_source_code
  chantSource: null, // active assignment_authority_code
  selectedPart: null,       // part_code of clicked chip
  selectedPartEpoch: null,  // epoch_slug of clicked chip (may be a child epoch)
  selectedCycleSun: null,   // cycle_sun int of clicked chip, or null
  selectedCycleWkday: null, // cycle_wkday int of clicked chip, or null
  selectedWkday: null,      // wkday int (1=Sun..7=Sat) of clicked chip, or null
  selectedTextOption: null,  // option_num for the text pane, or null (=lowest available)
  selectedChantOption: null, // option_num for the chant pane, or null (=lowest available)
  workflowData: null,      // response from /api/lit_epochs/{slug}/composition_data

  // Source review sub-pane text_ids (null when pane is hidden)
  textSrcId: null,
  chantSrcId: null,
};

const $ = id => document.getElementById(id);

// Sidebar refs
const kindChips        = $('kind-chips');
const seasonFilter     = $('season-filter');
const seasonChips      = $('season-chips');
const weekFilter       = $('week-filter');
const weekSelect       = $('week-select');
const monthFilter      = $('month-filter');
const monthSelect      = $('month-select');
const chapterFilter    = $('chapter-filter');
const chapterChips     = $('chapter-chips');
const epochList        = $('src-list');
const epochListCount   = $('src-list-count');
const emptyState       = $('src-empty-state');
const editor           = $('src-editor');
const srcTitle         = $('src-title');

// Composition workflow refs
const cfgTextSource    = $('cfg-text-source');
const cfgChantSource   = $('cfg-chant-source');
const partChips        = $('part-chips');
const composeWorkflow  = $('compose-workflow');
const cwTextFoundAt    = $('cw-text-found-at');
const cwTextOption     = $('cw-text-option');
const cwLatin          = $('cw-latin');
const cwEnglish        = $('cw-english');
const cwChantFoundAt   = $('cw-chant-found-at');
const cwChantOption    = $('cw-chant-option');
const cwChantMeta      = $('cw-chant-meta');
const cwChantEngrav    = $('cw-chant-engrav');
const cwLocalChants    = $('cw-local-chants');
const sectionImagesCol = $('src-images-col');
const sectionImages    = $('section-images');
const cwCopyLatin      = $('cw-copy-latin');
const cwCopyEnglish    = $('cw-copy-english');
const cwCopyGabc       = $('cw-copy-gabc');
const cwComposeBtn     = $('cw-compose-btn');
const cwFindSimilarBtn = $('cw-find-similar');

// "Find similar" modal refs
const simModal         = $('similar-modal');
const simClose         = $('sim-close');
const simQuery         = $('sim-query');
const simSearchBtn     = $('sim-search-btn');
const simStatus        = $('sim-status');
const simResults       = $('sim-results');

const cpTsrcList       = $('cp-translation-sources-list');
const composePanel     = $('compose-panel');
const cpCancelBtn      = $('cp-cancel-btn');
const cpSaveBtn        = $('cp-save-btn');
const cpMsg            = $('cp-msg');
const cpGabc           = $('cp-gabc');

// Source review sub-pane refs
const cwTextSrcBadge    = $('cw-text-src-badge');
const cwChantSrcBadge   = $('cw-chant-src-badge');
const cwTextSrcReview   = $('cw-text-src-review');
const cwTextSrcId       = $('cw-text-src-id');
const cwTextSrcStatus   = $('cw-text-src-status');
const cwTextSrcApprove  = $('cw-text-src-approve');
const cwTextSrcReject   = $('cw-text-src-reject');
const cwTextSrcLink     = $('cw-text-src-link');
const cwTextSrcMsg      = $('cw-text-src-msg');
const cwTextSrcImgLabel = $('cw-text-src-img-label');
const cwTextSrcImg        = $('cw-text-src-img');
const cwTextSrcBbox       = $('cw-text-src-bbox');
const cwTextSrcTextsrc    = $('cw-text-src-textsrc');
const cwTextSrcTextsrcSave = $('cw-text-src-textsrc-save');
const cwTextSrcTextsrcMsg  = $('cw-text-src-textsrc-msg');

const cwChantSrcReview   = $('cw-chant-src-review');
const cwChantSrcId       = $('cw-chant-src-id');
const cwChantSrcStatus   = $('cw-chant-src-status');
const cwChantSrcApprove  = $('cw-chant-src-approve');
const cwChantSrcReject   = $('cw-chant-src-reject');
const cwChantSrcLink     = $('cw-chant-src-link');
const cwChantSrcMsg      = $('cw-chant-src-msg');
const cwChantSrcImgLabel = $('cw-chant-src-img-label');
const cwChantSrcImg        = $('cw-chant-src-img');
const cwChantSrcBbox       = $('cw-chant-src-bbox');
const cwChantSrcTextsrc    = $('cw-chant-src-textsrc');
const cwChantSrcTextsrcSave = $('cw-chant-src-textsrc-save');
const cwChantSrcTextsrcMsg  = $('cw-chant-src-textsrc-msg');

// ── Source review sub-panes ───────────────────────────────────────────────────
function setSrcBadge(badgeEl, status) {
  if (!status) { badgeEl.hidden = true; return; }
  badgeEl.hidden = false;
  const ok = status === 'reviewed' || status === 'published';
  badgeEl.textContent = ok ? '✓ Reviewed' : '✗ Needs review';
  badgeEl.className = 'cw-src-badge ' + (ok ? 'cw-src-badge-ok' : 'cw-src-badge-needs');
}

function parseBboxStr(str) {
  if (!str) return null;
  const pts = str.split(',').map(t => parseFloat(t.trim()));
  if (pts.length !== 4 || pts.some(n => Number.isNaN(n))) return null;
  return pts;
}

function drawSrcBboxOverlay(imgEl, overlayEl, bboxStr) {
  const box = parseBboxStr(bboxStr);
  if (!box || !imgEl.naturalWidth) { overlayEl.style.display = 'none'; return; }
  const scale = imgEl.clientWidth / imgEl.naturalWidth;
  const ox = imgEl.offsetLeft;
  const oy = imgEl.offsetTop;
  const [x0, y0, x1, y1] = box;
  overlayEl.style.cssText = [
    'display:block',
    `left:${ox + x0 * scale}px`,
    `top:${oy + y0 * scale}px`,
    `width:${(x1 - x0) * scale}px`,
    `height:${(y1 - y0) * scale}px`,
  ].join(';');
}

async function patchSrcField(textId, field, value, msgEl) {
  if (!textId) return;
  msgEl.textContent = 'Saving…';
  try {
    await api(`/api/lit_part_sources/${textId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value || null }),
    });
    msgEl.textContent = 'Saved';
    setTimeout(() => { if (msgEl.textContent === 'Saved') msgEl.textContent = ''; }, 2000);
  } catch (e) {
    msgEl.textContent = 'Error: ' + e.message;
  }
}

async function patchSrcStatus(textId, newStatus, statusEl, msgEl, badgeEl) {
  if (!textId) return;
  msgEl.textContent = 'Saving…';
  try {
    await api(`/api/lit_part_sources/${textId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ review_status: newStatus }),
    });
    statusEl.value = newStatus;
    setSrcBadge(badgeEl, newStatus);
    msgEl.textContent = 'Saved';
    setTimeout(() => { if (msgEl.textContent === 'Saved') msgEl.textContent = ''; }, 2000);
  } catch (e) {
    msgEl.textContent = 'Error: ' + e.message;
  }
}

function renderTextSrcReviewPane(textData) {
  if (!textData || !textData.text_id) {
    cwTextSrcReview.hidden = true;
    cwTextSrcBadge.hidden = true;
    state.textSrcId = null;
    return;
  }
  state.textSrcId = textData.text_id;
  cwTextSrcReview.hidden = false;
  setSrcBadge(cwTextSrcBadge, textData.review_status);
  cwTextSrcId.textContent = textData._borrowed
    ? `#${textData.text_id} — borrowed from ${textData.found_at_slug || textData.found_at_title || '?'}`
    : `#${textData.text_id}`;
  cwTextSrcStatus.value = textData.review_status || 'draft';
  // A "Find similar" selection borrows a row that lives on a different day/part;
  // don't let this sub-pane PATCH it as if it were the current epoch's own source row.
  cwTextSrcStatus.disabled = !!textData._borrowed;
  cwTextSrcApprove.disabled = !!textData._borrowed;
  cwTextSrcReject.disabled = !!textData._borrowed;
  cwTextSrcTextsrcSave.disabled = !!textData._borrowed;
  cwTextSrcLink.href = `/sources#${textData.text_id}`;
  cwTextSrcMsg.textContent = '';
  cwTextSrcTextsrc.value = textData.text_src || '';
  cwTextSrcTextsrcMsg.textContent = '';

  if (textData.book && textData.printed_page_num != null) {
    cwTextSrcImgLabel.textContent = `${textData.book} p.${textData.printed_page_num}`;
    cwTextSrcImg.style.display = '';
    cwTextSrcImg.dataset.bbox = textData.bbox || '';
    cwTextSrcImg.src = `/api/books/${encodeURIComponent(textData.book)}/${textData.printed_page_num}/image`;
  } else {
    cwTextSrcImgLabel.textContent = 'No page image';
    cwTextSrcImg.removeAttribute('src');
    cwTextSrcImg.style.display = 'none';
    cwTextSrcBbox.style.display = 'none';
  }
}

function renderChantSrcReviewPane(chantData) {
  if (!chantData || !chantData.text_id) {
    cwChantSrcReview.hidden = true;
    cwChantSrcBadge.hidden = true;
    state.chantSrcId = null;
    return;
  }
  state.chantSrcId = chantData.text_id;
  cwChantSrcReview.hidden = false;
  setSrcBadge(cwChantSrcBadge, chantData.review_status);
  cwChantSrcId.textContent = `#${chantData.text_id}`;
  cwChantSrcStatus.value = chantData.review_status || 'draft';
  cwChantSrcLink.href = `/sources#${chantData.text_id}`;
  cwChantSrcMsg.textContent = '';
  cwChantSrcTextsrc.value = chantData.text_src || '';
  cwChantSrcTextsrcMsg.textContent = '';

  const chantPageNum = chantData.chant_page_num || chantData.printed_page_num;
  if (chantData.book && chantPageNum != null) {
    cwChantSrcImgLabel.textContent = `${chantData.book} p.${chantPageNum}`;
    cwChantSrcImg.style.display = '';
    cwChantSrcImg.dataset.bbox = chantData.bbox || '';
    cwChantSrcImg.src = `/api/books/${encodeURIComponent(chantData.book)}/${chantPageNum}/image`;
  } else {
    cwChantSrcImgLabel.textContent = 'No page image';
    cwChantSrcImg.removeAttribute('src');
    cwChantSrcImg.style.display = 'none';
    cwChantSrcBbox.style.display = 'none';
  }
}

cwTextSrcImg.addEventListener('load', () => {
  drawSrcBboxOverlay(cwTextSrcImg, cwTextSrcBbox, cwTextSrcImg.dataset.bbox);
});
cwChantSrcImg.addEventListener('load', () => {
  drawSrcBboxOverlay(cwChantSrcImg, cwChantSrcBbox, cwChantSrcImg.dataset.bbox);
});
window.addEventListener('resize', () => {
  if (cwTextSrcImg.naturalWidth)  drawSrcBboxOverlay(cwTextSrcImg,  cwTextSrcBbox,  cwTextSrcImg.dataset.bbox);
  if (cwChantSrcImg.naturalWidth) drawSrcBboxOverlay(cwChantSrcImg, cwChantSrcBbox, cwChantSrcImg.dataset.bbox);
});

cwTextSrcApprove.addEventListener('click', () =>
  patchSrcStatus(state.textSrcId, 'reviewed', cwTextSrcStatus, cwTextSrcMsg, cwTextSrcBadge));
cwTextSrcReject.addEventListener('click', () =>
  patchSrcStatus(state.textSrcId, 'rejected', cwTextSrcStatus, cwTextSrcMsg, cwTextSrcBadge));
cwTextSrcStatus.addEventListener('change', () =>
  patchSrcStatus(state.textSrcId, cwTextSrcStatus.value, cwTextSrcStatus, cwTextSrcMsg, cwTextSrcBadge));

cwChantSrcApprove.addEventListener('click', () =>
  patchSrcStatus(state.chantSrcId, 'reviewed', cwChantSrcStatus, cwChantSrcMsg, cwChantSrcBadge));
cwChantSrcReject.addEventListener('click', () =>
  patchSrcStatus(state.chantSrcId, 'rejected', cwChantSrcStatus, cwChantSrcMsg, cwChantSrcBadge));
cwChantSrcStatus.addEventListener('change', () =>
  patchSrcStatus(state.chantSrcId, cwChantSrcStatus.value, cwChantSrcStatus, cwChantSrcMsg, cwChantSrcBadge));

cwTextSrcTextsrcSave.addEventListener('click', () =>
  patchSrcField(state.textSrcId, 'text_src', cwTextSrcTextsrc.value.trim(), cwTextSrcTextsrcMsg));
cwChantSrcTextsrcSave.addEventListener('click', () =>
  patchSrcField(state.chantSrcId, 'text_src', cwChantSrcTextsrc.value.trim(), cwChantSrcTextsrcMsg));

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

function extractGabcBody(gabc) {
  if (!gabc) return '';
  const parts = gabc.split('%%');
  return parts.length > 1 ? parts[parts.length - 1].trim() : gabc.trim();
}

// ── Source dropdowns ──────────────────────────────────────────────────────────
async function loadSources() {
  let data;
  try { data = await api('/api/composition/sources'); } catch (_) { return; }

  state.textSources  = data.text_sources  || [];
  state.chantSources = data.chant_sources || [];

  cfgTextSource.innerHTML = '<option value="">(none)</option>';
  for (const s of state.textSources) {
    const opt = document.createElement('option');
    opt.value = s.code;
    opt.textContent = s.display_name;
    cfgTextSource.appendChild(opt);
  }
  if (state.textSources.length > 0) {
    state.textSource = state.textSources[0].code;
    cfgTextSource.value = state.textSource;
  }

  cfgChantSource.innerHTML = '<option value="">(none)</option>';
  for (const s of state.chantSources) {
    const opt = document.createElement('option');
    opt.value = s.code;
    opt.textContent = s.display_name;
    cfgChantSource.appendChild(opt);
  }
  if (state.chantSources.length > 0) {
    state.chantSource = state.chantSources[0].code;
    cfgChantSource.value = state.chantSource;
  }
}

cfgTextSource.addEventListener('change', () => {
  state.textSource = cfgTextSource.value || null;
  // Options are source-specific; reset to default when the source changes.
  state.selectedTextOption = null;
  if (state.selectedPart) loadCompositionData();
});

cfgChantSource.addEventListener('change', () => {
  state.chantSource = cfgChantSource.value || null;
  // Options are source-specific; reset to default when the source changes.
  state.selectedChantOption = null;
  if (state.selectedSlug) loadCompositionParts();
  if (state.selectedPart) loadCompositionData();
});

if (cwTextOption) cwTextOption.addEventListener('change', () => {
  state.selectedTextOption = cwTextOption.value ? parseInt(cwTextOption.value, 10) : null;
  if (state.selectedPart) loadCompositionData();
});

if (cwChantOption) cwChantOption.addEventListener('change', () => {
  state.selectedChantOption = cwChantOption.value ? parseInt(cwChantOption.value, 10) : null;
  if (state.selectedPart) loadCompositionData();
});

// ── Sidebar filter rendering ──────────────────────────────────────────────────
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function applyKindVisibility() {
  const needsSeason = ['subseason', 'week', 'day'].includes(state.kind);
  seasonFilter.hidden = !needsSeason;
  weekFilter.hidden = !(state.kind === 'day' && state.season);
  monthFilter.hidden = state.kind !== 'saint';
  chapterFilter.hidden = state.kind !== 'ritual';
}

function populateMonthDropdown() {
  if (monthSelect.options.length > 1) return;
  for (let m = 1; m <= 12; m++) {
    const opt = document.createElement('option');
    opt.value = String(m);
    opt.textContent = MONTH_NAMES[m - 1];
    monthSelect.appendChild(opt);
  }
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
  if (state.kind === 'saint' && state.month) {
    params.set('month', state.month);
  }

  let epochs;
  try {
    epochs = await api('/api/lit_epochs?' + params.toString());
  } catch (e) {
    if (mySeq !== _listSeq) return;
    epochList.innerHTML = `<li class="src-error">Error: ${escapeHtml(e.message)}</li>`;
    return;
  }

  if (mySeq !== _listSeq) return;
  state.epochs = epochs;

  epochListCount.textContent = `${state.epochs.length} epoch(s)`;

  if (state.kind === 'saint') {
    renderSaintList(state.epochs);
    return;
  }
  if (state.kind === 'ritual') {
    renderChapterChips(state.epochs);
    renderRitualList();
    return;
  }
  if (state.kind === 'common') {
    renderCommonList(state.epochs);
    return;
  }

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

// Saint kind: epochs already come back sorted by (month_nominal, day_nominal, slug),
// with dateless saints (no proper_of_saints row yet) trailing at the end.
function renderSaintList(epochs) {
  let currentMonth = undefined;
  for (const ep of epochs) {
    const m = ep.month_nominal ?? null;
    if (m !== currentMonth) {
      currentMonth = m;
      const header = document.createElement('li');
      header.className = 'asgn-month-header';
      header.textContent = m ? MONTH_NAMES[m - 1] : 'No date on file';
      epochList.appendChild(header);
    }
    const li = document.createElement('li');
    li.className = 'asgn-item' + (ep.slug === state.selectedSlug ? ' selected' : '');
    li.dataset.slug = ep.slug;
    const dateLabel = ep.day_nominal ? `${MONTH_NAMES[m - 1].slice(0, 3)} ${ep.day_nominal}` : '';
    li.innerHTML =
      `<span class="asgn-body">` +
        `<span class="asgn-name">${escapeHtml(ep.title || ep.slug)}</span>` +
        `<span class="asgn-epoch">${escapeHtml(dateLabel || ep.slug)}</span>` +
      `</span>`;
    li.addEventListener('click', () => selectEpoch(ep.slug));
    epochList.appendChild(li);
  }
}

function appendEpochItem(ep, sublabel, extraClass) {
  const li = document.createElement('li');
  li.className = 'asgn-item'
    + (extraClass ? ' ' + extraClass : '')
    + (ep.slug === state.selectedSlug ? ' selected' : '');
  li.dataset.slug = ep.slug;
  li.innerHTML =
    `<span class="asgn-body">` +
      `<span class="asgn-name">${escapeHtml(ep.title || ep.slug)}</span>` +
      `<span class="asgn-epoch">${escapeHtml(sublabel || ep.slug)}</span>` +
    `</span>`;
  li.addEventListener('click', () => selectEpoch(ep.slug));
  epochList.appendChild(li);
}

function appendGroupHeader(label) {
  const header = document.createElement('li');
  header.className = 'asgn-group-header';
  header.textContent = label;
  epochList.appendChild(header);
}

// Ritual kind: Graduale chapters 4–5. The server returns each formulary's
// chapter (derived from its printed GR page) and orders the list in book order.
function renderChapterChips(epochs) {
  chapterChips.innerHTML = '';
  const seen = new Map();
  for (const ep of epochs) {
    if (ep.chapter && !seen.has(ep.chapter)) seen.set(ep.chapter, ep.chapter_label);
  }
  // Drop a stale selection when the chapter is absent from this response.
  if (state.chapter && !seen.has(state.chapter)) state.chapter = null;

  const mkChip = (code, label) => {
    const btn = document.createElement('button');
    btn.className = 'chip' + (state.chapter === code ? ' active' : '');
    if (code !== null) btn.dataset.chapter = code;  // absent on "All" → state.chapter = null
    btn.textContent = label;
    chapterChips.appendChild(btn);
  };
  mkChip(null, 'All');
  for (const [code, label] of seen) mkChip(code, label);
}

function renderRitualList() {
  epochList.innerHTML = '';
  const shown = state.chapter
    ? state.epochs.filter(ep => ep.chapter === state.chapter)
    : state.epochs;
  epochListCount.textContent = `${shown.length} epoch(s)`;

  let currentChapter;
  for (const ep of shown) {
    if (ep.chapter !== currentChapter) {
      currentChapter = ep.chapter;
      appendGroupHeader(ep.chapter_label || 'Other');
    }
    // Page first: the sublabel ellipsises on long slugs, and the page is the
    // more useful half when it does.
    appendEpochItem(ep, ep.gr_page ? `GR p.${ep.gr_page} · ${ep.slug}` : ep.slug);
  }
}

// Common kind: 5 container nodes over 17 formularies, plus 9 standalone
// Commons. sort_order already lays them out in book order with each container
// immediately ahead of its children, so indenting on parent_slug is enough.
function renderCommonList(epochs) {
  for (const ep of epochs) {
    appendEpochItem(ep, ep.slug, ep.parent_slug ? 'asgn-child' : null);
  }
}

// ── Epoch selection ───────────────────────────────────────────────────────────
async function selectEpoch(slug) {
  state.selectedSlug = slug;
  state.selectedPart = null;
  state.selectedPartEpoch = null;
  state.selectedTextOption = null;
  state.selectedChantOption = null;
  state.workflowData = null;
  epochList.querySelectorAll('.asgn-item').forEach(li =>
    li.classList.toggle('selected', li.dataset.slug === slug)
  );

  emptyState.hidden = true;
  editor.hidden = false;
  srcTitle.textContent = 'Loading…';
  partChips.innerHTML = '';
  composeWorkflow.hidden = true;
  composePanel.hidden = true;
  sectionImagesCol.hidden = true;
  sectionImages.innerHTML = '';

  await loadCompositionParts();
}

async function loadCompositionParts() {
  if (!state.selectedSlug) return;

  const params = new URLSearchParams();
  if (state.chantSource) params.set('chant_source', state.chantSource);

  let data;
  try {
    data = await api(
      `/api/lit_epochs/${encodeURIComponent(state.selectedSlug)}/composition_parts?${params}`
    );
  } catch (e) {
    srcTitle.textContent = 'Error loading epoch';
    partChips.innerHTML =
      `<div class="review-empty">Error: ${escapeHtml(e.message)}</div>`;
    return;
  }

  srcTitle.textContent = `${data.epoch.title || data.epoch.slug} — ${data.epoch.kind}`;
  renderParts(data.parts);
  renderSectionImages(data.pages);
}

// ── Part chips ────────────────────────────────────────────────────────────────
const WKDAY_NAMES = ['', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function chipKey(epochSlug, partCode, cycleSun, cycleWkday, wkday) {
  return `${epochSlug}||${partCode}||${cycleSun ?? ''}||${cycleWkday ?? ''}||${wkday ?? ''}`;
}

function renderParts(parts) {
  partChips.innerHTML = '';

  if (!parts || parts.length === 0) {
    partChips.innerHTML =
      '<span class="cw-text-empty">No parts for this epoch.</span>';
    return;
  }

  const activeKey = state.selectedPartEpoch
    ? chipKey(state.selectedPartEpoch, state.selectedPart, state.selectedCycleSun, state.selectedCycleWkday, state.selectedWkday)
    : null;

  for (const part of parts) {
    const key = chipKey(part.epoch_slug, part.part_code, part.cycle_sun, part.cycle_wkday, part.wkday);
    const btn = document.createElement('button');
    btn.className = 'part-chip' + (key === activeKey ? ' active' : '');
    btn.dataset.chipKey = key;
    const pc = (part.part_code || '').toLowerCase();

    // Show epoch context if this assignment is from a child epoch
    const isParent = part.epoch_slug === state.selectedSlug;
    const epochLabel = !isParent && part.epoch_title
      ? ` <span class="chip-epoch">${escapeHtml(shortEpochTitle(part.epoch_title))}</span>`
      : '';

    const cycleLabel = part.cycle
      ? ` <span class="chip-cycle">Yr ${escapeHtml(part.cycle)}</span>`
      : '';

    const wkdayLabel = part.wkday
      ? ` <span class="chip-wkday">${escapeHtml(WKDAY_NAMES[part.wkday] || '')}</span>`
      : '';

    btn.innerHTML =
      `<span class="src-part part-${escapeHtml(pc)}">${escapeHtml(pc.toUpperCase())}</span>` +
      ` <span>${escapeHtml(part.part_name || part.part_code || '')}</span>` +
      epochLabel + cycleLabel + wkdayLabel;
    btn.addEventListener('click', () => selectPart(part.part_code, part.epoch_slug, part.cycle_sun, part.cycle_wkday, part.wkday));
    partChips.appendChild(btn);
  }
}

// Shorten "13th Sunday of Ordinary Time" → "13th Sun", "Wednesday of..." → "Wed"
function shortEpochTitle(title) {
  if (!title) return '';
  const m = title.match(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/);
  if (m) return m[1].slice(0, 3);
  const m2 = title.match(/^(\d+\w+)\s+(Sunday|Monday)/);
  if (m2) return `${m2[1]} ${m2[2].slice(0, 3)}`;
  return title.split(' ').slice(0, 2).join(' ');
}

// ── Section images (epoch-level) ──────────────────────────────────────────────
function renderSectionImages(pages) {
  sectionImages.innerHTML = '';
  if (!pages || pages.length === 0) {
    sectionImagesCol.hidden = true;
    return;
  }
  for (const page of pages) {
    const wrap = document.createElement('div');
    wrap.className = 'section-img-wrap';
    const label = document.createElement('div');
    label.className = 'section-img-label';
    label.textContent = `${page.book} p. ${page.printed_page_num}`;
    const img = document.createElement('img');
    img.alt = `${page.book} p. ${page.printed_page_num}`;
    img.src = `/api/books/${encodeURIComponent(page.book)}/${encodeURIComponent(page.printed_page_num)}/image`;
    wrap.appendChild(label);
    wrap.appendChild(img);
    sectionImages.appendChild(wrap);
  }
  sectionImagesCol.hidden = false;
}

// ── Part selection & composition data ────────────────────────────────────────
async function selectPart(partCode, epochSlug, cycleSun, cycleWkday, wkday) {
  state.selectedPart = partCode;
  state.selectedPartEpoch = epochSlug || state.selectedSlug;
  state.selectedCycleSun = cycleSun ?? null;
  state.selectedCycleWkday = cycleWkday ?? null;
  state.selectedWkday = wkday ?? null;
  // Reset per-pane option selection to default (lowest) when switching parts.
  state.selectedTextOption = null;
  state.selectedChantOption = null;
  state.workflowData = null;
  composePanel.hidden = true;

  // Update active chip
  const key = chipKey(state.selectedPartEpoch, partCode, state.selectedCycleSun, state.selectedCycleWkday, state.selectedWkday);
  partChips.querySelectorAll('.part-chip').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.chipKey === key)
  );

  composeWorkflow.hidden = false;
  cwLatin.textContent = '';
  cwEnglish.textContent = '';
  cwChantEngrav.innerHTML = '<em class="render-note">Loading…</em>';
  cwChantMeta.textContent = '';
  cwTextFoundAt.textContent = '';
  cwChantFoundAt.textContent = '';
  cwLocalChants.hidden = true;
  cwLocalChants.innerHTML = '';
  cwTextSrcReview.hidden = true;
  cwChantSrcReview.hidden = true;
  cwTextSrcBadge.hidden = true;
  cwChantSrcBadge.hidden = true;
  state.textSrcId = null;
  state.chantSrcId = null;

  await loadCompositionData();
}

async function loadCompositionData() {
  if (!state.selectedPart || !state.selectedPartEpoch) return;

  const params = new URLSearchParams({ part_code: state.selectedPart });
  if (state.textSource)  params.set('text_source',  state.textSource);
  if (state.chantSource) params.set('chant_source', state.chantSource);
  if (state.selectedCycleSun !== null)   params.set('cycle_sun',   state.selectedCycleSun);
  if (state.selectedCycleWkday !== null) params.set('cycle_wkday', state.selectedCycleWkday);
  if (state.selectedWkday !== null)      params.set('wkday',       state.selectedWkday);
  if (state.selectedTextOption !== null)  params.set('text_option_num',  state.selectedTextOption);
  if (state.selectedChantOption !== null) params.set('chant_option_num', state.selectedChantOption);

  let data;
  try {
    data = await api(
      `/api/lit_epochs/${encodeURIComponent(state.selectedPartEpoch)}/composition_data?${params}`
    );
  } catch (e) {
    cwChantEngrav.innerHTML = `<em class="render-note">Error: ${escapeHtml(e.message)}</em>`;
    return;
  }

  state.workflowData = data;
  renderWorkflow(data);
}

// Populate a per-pane option <select> from an options list. Hidden when <=1 option.
function renderOptionSelect(selectEl, options, selectedNum) {
  if (!selectEl) return;
  selectEl.innerHTML = '';
  if (!options || options.length <= 1) {
    selectEl.hidden = true;
    return;
  }
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = String(opt.option_num);
    const label = opt.label ? ` — ${opt.label}` : '';
    o.textContent = `opt ${opt.option_num}${label}`;
    selectEl.appendChild(o);
  }
  if (selectedNum != null) selectEl.value = String(selectedNum);
  if (selectEl.selectedIndex < 0) selectEl.selectedIndex = 0;
  selectEl.hidden = false;
}

function renderWorkflow(data) {
  renderOptionSelect(cwTextOption, data.text_options, data.text ? data.text.option_num : null);
  renderOptionSelect(cwChantOption, data.chant_options, data.chant ? data.chant.option_num : null);

  // Text pane
  if (data.text) {
    const t = data.text;
    cwLatin.textContent   = t.original_text   || '';
    cwEnglish.textContent = t.vernacular_text  || '';
    if (!t.original_text)  cwLatin.innerHTML   = '<em class="cw-text-empty">No Latin text</em>';
    if (!t.vernacular_text) cwEnglish.innerHTML = '<em class="cw-text-empty">No English text</em>';
    if (t.found_at_slug !== state.selectedSlug) {
      cwTextFoundAt.textContent = `(from ${t.found_at_title || t.found_at_slug})`;
    } else {
      cwTextFoundAt.textContent = '';
    }
  } else {
    cwLatin.innerHTML   = '<em class="cw-text-empty">No text found for this source</em>';
    cwEnglish.innerHTML = '';
    cwTextFoundAt.textContent = '';
  }
  renderTextSrcReviewPane(data.text || null);

  // Chant pane
  if (data.chant) {
    const c = data.chant;
    const metaParts = [c.incipit, c.mode ? `Mode ${c.mode}` : null, c.version, c.cycle ? `Cycle ${c.cycle}` : null].filter(Boolean);
    cwChantMeta.textContent = metaParts.join(' · ');
    if (c.found_at_slug !== state.selectedSlug) {
      cwChantFoundAt.textContent = `(from ${c.found_at_title || c.found_at_slug})`;
    } else {
      cwChantFoundAt.textContent = '';
    }
    if (c.gabc_body) {
      renderGabc(c.gabc_body, cwChantEngrav);
    } else {
      cwChantEngrav.innerHTML = '<em class="render-note">No GABC</em>';
    }
  } else {
    cwChantMeta.textContent = '';
    cwChantFoundAt.textContent = '';
    cwChantEngrav.innerHTML = '<em class="render-note">No chant found for this source</em>';
  }

  // Local chants in the same chant_group
  cwLocalChants.innerHTML = '';
  if (data.local_chants && data.local_chants.length > 0) {
    cwLocalChants.hidden = false;
    const header = document.createElement('div');
    header.className = 'cw-local-chants-header';
    header.textContent = 'Local chants in same group';
    cwLocalChants.appendChild(header);
    for (const lc of data.local_chants) {
      const item = document.createElement('div');
      item.className = 'cw-local-chant';
      const metaRow = document.createElement('div');
      metaRow.className = 'cw-local-chant-header';
      const metaParts = [lc.incipit, lc.mode ? `Mode ${lc.mode}` : null, lc.version, lc.status].filter(Boolean);
      const meta = document.createElement('span');
      meta.className = 'cw-chant-meta';
      meta.textContent = metaParts.join(' · ');
      metaRow.appendChild(meta);
      const editLink = document.createElement('a');
      editLink.href = `/#${lc.local_chant_id}`;
      editLink.target = '_blank';
      editLink.textContent = 'Edit';
      editLink.className = 'btn-secondary btn-sm';
      metaRow.appendChild(editLink);
      item.appendChild(metaRow);
      const engrav = document.createElement('div');
      item.appendChild(engrav);
      cwLocalChants.appendChild(item);
      if (lc.gabc_body) {
        renderGabc(lc.gabc_body, engrav);
      } else {
        engrav.innerHTML = '<em class="render-note">No GABC</em>';
      }
    }
  } else {
    cwLocalChants.hidden = true;
  }

  renderChantSrcReviewPane(data.chant || null);
}

// ── Clipboard helpers ─────────────────────────────────────────────────────────
const OFFICE_PART_NAMES = {
  'in': 'Introitus', 'gr': 'Gradualis', 'al': 'Alleluia',
  'of': 'Offertorium', 'co': 'Communio',
};
const ANNOT_ABBREVS = {
  'in': 'In.', 'gr': 'Gr.', 'al': 'Al.', 'of': 'Of.', 'co': 'Co.',
};
const ROMAN_MODES = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];

function buildGabcHeader(chant, partCode, textData) {
  const pc = (partCode || '').toLowerCase();
  const officePart = OFFICE_PART_NAMES[pc] || partCode;
  const annotPart  = ANNOT_ABBREVS[pc]  || pc;
  const modeNum    = parseInt(chant.mode, 10);
  const modeRoman  = (modeNum >= 1 && modeNum <= 8) ? ROMAN_MODES[modeNum] : (chant.mode || '');
  const annotation = [annotPart, modeRoman].filter(Boolean).join(' ');

  const commentaryParts = [];
  if (chant.incipit)                         commentaryParts.push(chant.incipit);
  const citePage = chant.chant_page_num || chant.printed_page_num;
  if (citePage)                              commentaryParts.push(`GR ${citePage}`);
  if (chant.text_src)                        commentaryParts.push(chant.text_src);
  if (textData?.translation_short_code) {
    const trPage = textData.text_page_num ? ` ${textData.text_page_num}` : '';
    commentaryParts.push(`tr. ${textData.translation_short_code}${trPage}`);
  }

  return [
    `name:${chant.incipit || ''};`,
    `office-part:${officePart};`,
    `mode:${chant.mode || ''};`,
    `book:Graduale Romanum, 1974;`,
    `transcriber:John Costanzo;`,
    `annotation:${annotation};`,
    `commentary:${commentaryParts.join(', ')};`,
    `centering-scheme:english;`,
    '%%',
    chant.gabc_body || '',
  ].join('\n');
}

cwCopyLatin.addEventListener('click', () => {
  const txt = state.workflowData?.text?.original_text || '';
  navigator.clipboard.writeText(txt).catch(() => {});
});

cwCopyEnglish.addEventListener('click', () => {
  const txt = state.workflowData?.text?.vernacular_text || '';
  navigator.clipboard.writeText(txt).catch(() => {});
});

cwCopyGabc.addEventListener('click', () => {
  const chant = state.workflowData?.chant;
  if (!chant?.gabc_body) return;
  const txt = buildGabcHeader(chant, state.selectedPart, state.workflowData?.text);
  navigator.clipboard.writeText(txt).catch(() => {});
});

// ── Find similar texts ────────────────────────────────────────────────────────
// Extract sung lyrics from a GABC body: drop (...) note groups, {}/<...> tags
// entirely (not just replace-with-space — GABC syllables split across a note
// group like "le(gh)vá(h)vi(g.)" would otherwise shatter into "le vá vi" and
// break the server's token-set Jaccard prefilter). *|  are real word-boundary
// separators in the lyric line, so those alone collapse to a space.
function gabcLyrics(gabc) {
  return String(gabc || '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[*|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// In-flight request guard, same pattern as _listSeq in loadEpochList: discard
// a response if a newer search has since been kicked off.
let _simSeq = 0;

function openSimilarModal() {
  const chant = state.workflowData?.chant;
  const q = chant?.original_text
    || gabcLyrics(chant?.gabc_body)
    || chant?.incipit
    || '';
  simModal.hidden = false;
  simQuery.value = q;
  simStatus.textContent = '';
  simResults.innerHTML = '';
  if (q.trim()) {
    runSimilarSearch();
  } else {
    simQuery.focus();
  }
}

function closeSimilarModal() {
  simModal.hidden = true;
  cwFindSimilarBtn.focus();
}

async function runSimilarSearch() {
  const q = simQuery.value.trim();
  const mySeq = ++_simSeq;
  if (!q) {
    simStatus.textContent = '';
    simResults.innerHTML = '';
    return;
  }
  simStatus.textContent = 'Searching…';
  simResults.innerHTML = '';
  let results;
  try {
    results = await api(`/api/lit_part_sources/similar?q=${encodeURIComponent(q)}&limit=30`);
  } catch (e) {
    if (mySeq !== _simSeq) return;
    simStatus.textContent = `Error: ${e.message}`;
    return;
  }
  if (mySeq !== _simSeq) return;
  simStatus.textContent = `${results.length} result${results.length === 1 ? '' : 's'}`;
  renderSimilarResults(results);
}

function renderSimilarResults(results) {
  simResults.innerHTML = '';
  for (const r of results) {
    const li = document.createElement('li');
    li.className = 'sim-result';
    li.tabIndex = 0;
    li.setAttribute('role', 'button');

    const meta = document.createElement('div');
    meta.className = 'sim-result-meta';
    const metaBits = [];
    metaBits.push(`<span class="sim-score">${Math.round(r.score * 100)}%</span>`);
    if (r.part_code) {
      metaBits.push(`<span class="src-part part-${escapeHtml(r.part_code)}">${escapeHtml(r.part_code.toUpperCase())}</span>`);
    }
    metaBits.push(`<span class="sim-epoch">${escapeHtml(r.epoch_title || r.lit_epoch_slug || '')}</span>`);
    const tsrc = r.translation_short_code || r.translation_display_name;
    if (tsrc) metaBits.push(`<span class="sim-tsrc">${escapeHtml(tsrc)}</span>`);
    if (r.book) {
      const pg = r.printed_page_num ? ` p.${escapeHtml(r.printed_page_num)}` : '';
      metaBits.push(`<span class="sim-book">${escapeHtml(r.book)}${pg}</span>`);
    }
    if (r.review_status) metaBits.push(`<span class="sim-review-status">${escapeHtml(r.review_status)}</span>`);
    meta.innerHTML = metaBits.join('');
    li.appendChild(meta);

    const latin = document.createElement('div');
    latin.className = 'sim-latin';
    latin.textContent = r.original_text || '';
    li.appendChild(latin);

    if (r.vernacular_text) {
      const eng = document.createElement('div');
      eng.className = 'sim-english';
      eng.textContent = r.vernacular_text;
      li.appendChild(eng);
    }

    li.addEventListener('click', () => selectSimilarResult(r));
    li.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectSimilarResult(r);
      }
    });
    simResults.appendChild(li);
  }
}

function selectSimilarResult(r) {
  if (!state.workflowData) {
    simStatus.textContent = 'No active chant/part selected — cannot apply this text.';
    return;
  }

  const newText = {
    text_id: r.text_id,
    option_num: r.option_num,
    original_text: r.original_text,
    vernacular_text: r.vernacular_text,
    text_src: r.text_src,
    found_at_slug: r.lit_epoch_slug,
    found_at_title: r.epoch_title,
    translation_source_code: r.translation_source_code,
    translation_short_code: r.translation_short_code,
    text_page_num: r.text_page_num,
    book: r.book,
    printed_page_num: r.printed_page_num,
    bbox: r.bbox,
    review_status: r.review_status,
    // Selected via "Find similar": this row belongs to a different day/part.
    // renderTextSrcReviewPane uses this to disable the PATCH-to-DB controls.
    _borrowed: true,
  };
  state.workflowData.text = newText;

  if (!state.workflowData.text_source_options) state.workflowData.text_source_options = [];
  const hasOption = state.workflowData.text_source_options
    .some(o => o.translation_source_code === r.translation_source_code);
  if (!hasOption && r.translation_source_code) {
    state.workflowData.text_source_options.unshift({
      translation_source_code: r.translation_source_code,
      display_name: r.translation_display_name,
      short_code: r.translation_short_code,
      printed_page_num: r.printed_page_num,
      text_src: r.text_src,
      found_at_slug: r.lit_epoch_slug,
    });
  }

  renderWorkflow(state.workflowData);
  closeSimilarModal();
}

cwFindSimilarBtn.addEventListener('click', openSimilarModal);
simClose.addEventListener('click', closeSimilarModal);
simModal.addEventListener('click', e => {
  if (e.target === simModal) closeSimilarModal();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !simModal.hidden) closeSimilarModal();
});
simSearchBtn.addEventListener('click', runSimilarSearch);
simQuery.addEventListener('keydown', e => {
  if (e.key === 'Enter') runSimilarSearch();
});

// ── Composition panel ─────────────────────────────────────────────────────────
// ── Translation source checkboxes ─────────────────────────────────────────────
const _tsrcOptions = new Map();  // translation_source_code → TextSourceOption

function buildSourceCitation(opt) {
  if (opt.printed_page_num) return `${opt.display_name || opt.translation_source_code} p.${opt.printed_page_num}`;
  if (opt.text_src)         return opt.text_src;
  return opt.display_name || opt.translation_source_code;
}

function checkedSourceOptions() {
  return [...cpTsrcList.querySelectorAll('input[type="checkbox"]:checked')]
    .map(cb => _tsrcOptions.get(cb.value))
    .filter(Boolean);
}

cwComposeBtn.addEventListener('click', openCompose);
cpCancelBtn.addEventListener('click', () => { composePanel.hidden = true; });

// Show/hide canonical name field based on group mode
document.addEventListener('change', e => {
  if (e.target.name === 'cp-group-mode') {
    $('cp-canonical-name-wrap').hidden = (e.target.value === 'derived');
  }
});

function openCompose() {
  const chant = state.workflowData?.chant;

  // Pre-populate from chant source
  cpGabc.value = chant?.gabc_body || '';
  $('cp-incipit').value   = chant?.incipit  || '';
  $('cp-mode').value      = chant?.mode     || '';
  $('cp-version').value   = 'english';
  $('cp-derived-from-uid').value = chant?.chant_uuid || '';
  $('cp-office-part').value = state.selectedPart || '';
  // Render translation source checkboxes
  _tsrcOptions.clear();
  cpTsrcList.innerHTML = '';
  const currentTsrc = state.workflowData?.text?.translation_source_code;
  for (const opt of (state.workflowData?.text_source_options || [])) {
    _tsrcOptions.set(opt.translation_source_code, opt);
    const lbl = document.createElement('label');
    lbl.className = 'cp-tsrc-item';
    lbl.title = buildSourceCitation(opt);
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = opt.translation_source_code;
    cb.checked = (opt.translation_source_code === currentTsrc);
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(' ' + (opt.short_code || opt.display_name || opt.translation_source_code)));
    cpTsrcList.appendChild(lbl);
  }
  $('cp-transcriber').value = 'Doctor J';
  $('cp-status').value = 'draft';
  $('cp-canonical-name').value = chant?.incipit || '';
  $('cp-is-text-exact').value = '1';

  // Default to "derived" group mode
  document.querySelectorAll('[name="cp-group-mode"]').forEach(r => {
    r.checked = (r.value === 'derived');
  });
  $('cp-canonical-name-wrap').hidden = true;

  cpMsg.textContent = '';
  cpMsg.className = '';
  composePanel.hidden = false;
  composePanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function parseGabcHeader(gabc) {
  const header = gabc.split('%%')[0] || '';
  const result = {};
  for (const line of header.split('\n')) {
    const m = line.match(/^([\w-]+):(.*?);\s*$/);
    if (m) result[m[1]] = m[2].trim();
  }
  return result;
}

cpSaveBtn.addEventListener('click', saveComposition);

async function saveComposition() {
  const gabc = cpGabc.value.trim();
  if (!gabc) { showMsg('GABC cannot be empty.', 'error'); return; }

  const groupMode = document.querySelector('[name="cp-group-mode"]:checked')?.value || 'new';
  if (groupMode === 'derived' && !$('cp-derived-from-uid').value.trim()) {
    showMsg('Derived from UID is required when using "Derived from source".', 'error');
    return;
  }
  if (groupMode === 'new' && !$('cp-canonical-name').value.trim()) {
    showMsg('Group name is required for a new group.', 'error');
    return;
  }

  cpSaveBtn.disabled = true;
  showMsg('Saving…', '');

  try {
    await api('/api/local_chants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gabc,
        version:                $('cp-version').value.trim() || 'english',
        incipit:                $('cp-incipit').value.trim() || null,
        office_part:            $('cp-office-part').value.trim() || null,
        mode:                   $('cp-mode').value.trim() || null,
        transcriber:            $('cp-transcriber').value.trim() || 'Doctor J',
        translation_source_code: checkedSourceOptions()[0]?.translation_source_code || null,
        source_citation:         checkedSourceOptions().map(buildSourceCitation).join('; ') || null,
        is_text_exact:          parseInt($('cp-is-text-exact').value, 10),
        derived_from_uid:       $('cp-derived-from-uid').value.trim() || null,
        status:                 $('cp-status').value || 'draft',
        commentary:             parseGabcHeader(gabc)['commentary'] || null,
        chant_group_mode:       groupMode,
        canonical_name:         $('cp-canonical-name').value.trim() || null,
      }),
    });
    showMsg('Saved!', 'success');
    cpSaveBtn.disabled = false;
  } catch (e) {
    showMsg('Error: ' + e.message, 'error');
    cpSaveBtn.disabled = false;
  }
}

function showMsg(txt, type) {
  cpMsg.textContent = txt;
  cpMsg.className = type;
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
  state.month = null;
  state.chapter = null;
  state.selectedSlug = null;
  state.selectedPart = null;
  seasonChips.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  weekSelect.innerHTML = '<option value="">— select week —</option>';
  monthSelect.value = '';
  chapterChips.innerHTML = '';
  editor.hidden = true;
  emptyState.hidden = false;
  applyKindVisibility();
  if (state.kind === 'saint') populateMonthDropdown();
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
  state.selectedPart = null;
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

monthSelect.addEventListener('change', () => {
  state.month = monthSelect.value ? parseInt(monthSelect.value, 10) : null;
  loadEpochList();
});

// The whole ritual list is already in state.epochs, so narrowing to one chapter
// is a re-render, not a refetch.
chapterChips.addEventListener('click', e => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  chapterChips.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  state.chapter = btn.dataset.chapter || null;
  renderRitualList();
});

weekSelect.addEventListener('change', () => {
  const slug = weekSelect.value;
  state.weekSlug = slug || null;
  state.weekData = slug ? (state.weekOptions.find(w => w.slug === slug) || null) : null;
  state.selectedSlug = null;
  state.selectedPart = null;
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
  populateMonthDropdown();
  await Promise.all([loadParts(), loadSeasons(), loadSources()]);
  applyKindVisibility();
  await loadEpochList();
}());
