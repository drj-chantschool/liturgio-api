'use strict';

// ── Chant Browser ─────────────────────────────────────────────────────────────
// GregoBase-style browsing over the chants table, one row per
// chant group. Filters: typed incipit prefix (or words-in-text), office-part,
// mode, "assigned in Liturgio". Facet chips come from /api/browse/facets, so
// every part/mode in the DB shows, with counts for the other active filters.

const PAGE_SIZE = 100;

// Display names for gregobase office-part codes. Display only: which chips
// appear is decided by the DB (facets endpoint), not by this map.
const PART_NAMES = {
  in: 'Introitus', gr: 'Graduale', al: 'Alleluia', tr: 'Tractus', se: 'Sequentia',
  of: 'Offertorium', co: 'Communio', an: 'Antiphona', re: 'Responsorium',
  rb: 'Responsorium breve', hy: 'Hymnus', ps: 'Psalmus', ca: 'Canticum',
  ky: 'Kyriale', or: 'Toni communes', pr: 'Praefationes', va: 'Varia',
  su: 'Supplicatio', pa: 'Prosa', tp: 'Tropus', im: 'Improperia', rh: 'Rhythmus',
  none: 'No part',
};
// Mass propers first, in Mass order; everything else follows by count.
const PART_ORDER = ['in', 'gr', 'al', 'tr', 'se', 'of', 'co', 'an', 're', 'rb', 'hy', 'ps', 'ca', 'ky'];
const ROMAN = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV', 5: 'V', 6: 'VI', 7: 'VII', 8: 'VIII' };

const $ = id => document.getElementById(id);
const qInput    = $('cb-q');
const matchSeg  = $('cb-match');
const usedBox   = $('cb-used');
const partsEl   = $('cb-parts');
const modesEl   = $('cb-modes');
const countEl   = $('cb-count');
const resultsEl = $('cb-results');
const statusEl  = $('cb-status');
const scrollEl  = $('cb-scroll');
const sentinel  = $('cb-sentinel');

const state = {
  q: '', match: 'prefix', part: '', mode: '', used: false,
  groups: [], total: 0, done: false, loading: false,
  seq: 0,              // bumps on every filter change; stale responses are dropped
  openKey: null,
  cursor: -1,          // index into state.groups for keyboard navigation
};
const detailCache = new Map();   // key -> BrowseGroupDetail
const rowView = new Map();       // key -> { active: chant_uuid, compare: bool }

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fold(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
function partName(p) { return PART_NAMES[p] || p; }
function modeLabel(m) {
  if (m === 'none' || m == null || m === '') return '—';
  if (ROMAN[m]) return ROMAN[m];
  if (m === 'p') return 'Per.';
  return m;
}
async function api(url) {
  const res = await fetch(url);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch (_) {}
    throw new Error(`${res.status}: ${detail}`);
  }
  return res.json();
}
function filterParams() {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.match !== 'prefix') p.set('match', state.match);
  if (state.part) p.set('part', state.part);
  if (state.mode) p.set('mode', state.mode);
  if (state.used) p.set('used', 'true');
  return p;
}
function versionMatches(v) {
  const vp = v.part || 'none', vm = v.mode || 'none';
  return (!state.part || vp === state.part) && (!state.mode || vm === state.mode);
}

// ── URL state ─────────────────────────────────────────────────────────────────
function readUrl() {
  const p = new URLSearchParams(location.search);
  state.q = p.get('q') || '';
  state.match = p.get('match') === 'text' ? 'text' : 'prefix';
  state.part = p.get('part') || '';
  state.mode = p.get('mode') || '';
  state.used = p.get('used') === 'true';
  state.openKey = p.get('open') || null;
}
function writeUrl() {
  const p = filterParams();
  if (state.openKey) p.set('open', state.openKey);
  const s = p.toString();
  history.replaceState(null, '', location.pathname + (s ? '?' + s : ''));
}
function syncControls() {
  qInput.value = state.q;
  usedBox.checked = state.used;
  for (const b of matchSeg.querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.match === state.match);
  }
  qInput.placeholder = state.match === 'text'
    ? 'Type words from the chant text — e.g. “animam meam”'
    : 'Type the start of an incipit — e.g. “Ad te lev”';
}

// ── Facets ────────────────────────────────────────────────────────────────────
async function loadFacets(seq) {
  let f;
  try {
    f = await api('/api/browse/facets?' + filterParams().toString());
  } catch (e) {
    return;   // the list request reports errors; chips just keep their old counts
  }
  if (seq !== state.seq) return;
  renderSelect(partsEl, sortParts(f.parts), 'part', 'All parts', v => partName(v));
  renderSelect(modesEl, sortModes(f.modes), 'mode', 'All modes', v => (ROMAN[v] ? 'Mode ' : '') + modeLabel(v));
}
function sortParts(list) {
  const rank = v => {
    const i = PART_ORDER.indexOf(v);
    return v === 'none' ? 1e9 : i >= 0 ? i : 1e6;
  };
  return [...list].sort((a, b) => rank(a.value) - rank(b.value) || b.n - a.n || a.value.localeCompare(b.value));
}
function sortModes(list) {
  const rank = v => (ROMAN[v] ? Number(v) : v === 'none' ? 1e9 : 100);
  return [...list].sort((a, b) => rank(a.value) - rank(b.value) || b.n - a.n);
}
function renderSelect(el, facets, key, allLabel, label) {
  const opts = [`<option value="">${esc(allLabel)}</option>`];
  for (const f of facets) {
    // Values with no matches stay selectable but read as empty
    opts.push(
      `<option value="${esc(f.value)}"${f.n === 0 ? ' class="zero"' : ''}>` +
      `${esc(label(f.value))} (${f.n.toLocaleString()})</option>`);
  }
  el.innerHTML = opts.join('');
  el.value = state[key];
  if (el.value !== state[key]) {   // selected value vanished from the data
    el.insertAdjacentHTML('beforeend', `<option value="${esc(state[key])}">${esc(label(state[key]))} (0)</option>`);
    el.value = state[key];
  }
}
partsEl.addEventListener('change', () => { state.part = partsEl.value; refresh(); });
modesEl.addEventListener('change', () => { state.mode = modesEl.value; refresh(); });

// ── List ──────────────────────────────────────────────────────────────────────
function refresh() {
  state.seq++;
  state.groups = [];
  state.total = 0;
  state.done = false;
  state.loading = false;
  state.cursor = -1;
  resultsEl.innerHTML = '';
  writeUrl();
  loadFacets(state.seq);
  loadMore();
}

async function loadMore() {
  if (state.loading || state.done) return;
  state.loading = true;
  const seq = state.seq;
  const p = filterParams();
  p.set('limit', PAGE_SIZE);
  p.set('offset', state.groups.length);
  statusEl.className = 'cb-status';
  statusEl.textContent = 'Loading…';
  let data;
  try {
    data = await api('/api/browse?' + p.toString());
  } catch (e) {
    if (seq !== state.seq) return;
    state.loading = false;
    statusEl.className = 'cb-status error';
    statusEl.textContent = 'Could not load chants — ' + e.message;
    return;
  }
  if (seq !== state.seq) return;
  state.loading = false;
  const first = state.groups.length === 0;
  if (first) state.total = data.total;
  const start = state.groups.length;
  state.groups.push(...data.groups);
  state.done = data.groups.length < PAGE_SIZE;
  const frag = document.createDocumentFragment();
  data.groups.forEach((g, i) => frag.appendChild(makeRow(g, start + i)));
  resultsEl.appendChild(frag);
  renderCount();
  statusEl.textContent = state.done
    ? (state.total === 0 ? (state.q ? `Nothing matches “${state.q}”.` : 'No chants match these filters.') : '')
    : '';
  // Restore an ?open= row on first load, if it is on this page
  if (first && state.openKey) {
    const row = resultsEl.querySelector(`.cb-row[data-key="${CSS.escape(state.openKey)}"]`);
    if (row) toggleRow(row, true); else { state.openKey = null; writeUrl(); }
  }
  // Short page on a tall screen: keep filling until the sentinel is off-screen
  if (!state.done) requestAnimationFrame(checkSentinel);
}

function renderCount() {
  const n = state.total;
  countEl.textContent = `${n.toLocaleString()} chant${n === 1 ? '' : 's'}` +
    (state.groups.length < n ? ` · showing ${state.groups.length.toLocaleString()}` : '');
}

function highlight(incipit) {
  const s = incipit || '(no incipit)';
  if (state.match !== 'prefix' || !state.q) return esc(s);
  const n = state.q.length;
  if (fold(s.slice(0, n)) !== fold(state.q)) return esc(s);
  return `<mark>${esc(s.slice(0, n))}</mark>${esc(s.slice(n))}`;
}

function makeRow(g, idx) {
  const li = document.createElement('li');
  li.className = 'cb-row';
  li.dataset.key = g.key;
  li.dataset.idx = idx;
  const modes = g.modes.length ? g.modes.map(modeLabel).join(' · ') : '—';
  const parts = g.parts.map(p => `<span class="cb-part" title="${esc(p)}">${esc(partName(p))}</span>`).join('');
  li.innerHTML =
    `<div class="cb-head">` +
      `<span class="cb-mode" title="Mode">${esc(modes)}</span>` +
      `<span class="cb-incipit" title="${esc(g.canonical_name || g.incipit)}">${highlight(g.incipit)}</span>` +
      `<span class="cb-badges">` +
        parts +
        (g.n_local ? `<span class="cb-tag local" title="Includes a local (Liturgio) chant">local</span>` : '') +
        (g.used ? `<span class="cb-tag used" title="Assigned in lit_part_sources">in Liturgio</span>` : '') +
      `</span>` +
      `<span class="cb-nver">${g.n_match} version${g.n_match === 1 ? '' : 's'}</span>` +
    `</div>`;
  li.querySelector('.cb-head').addEventListener('click', () => {
    setCursor(idx, false);
    toggleRow(li);
  });
  return li;
}

// ── Detail ────────────────────────────────────────────────────────────────────
async function toggleRow(li, forceOpen) {
  const key = li.dataset.key;
  const isOpen = li.classList.contains('open');
  if (isOpen && !forceOpen) {
    closeRow(li);
    state.openKey = null;
    writeUrl();
    return;
  }
  // One open row at a time keeps the page (and exsurge) light
  const prev = resultsEl.querySelector('.cb-row.open');
  if (prev && prev !== li) closeRow(prev);
  li.classList.add('open');
  state.openKey = key;
  writeUrl();

  let det = li.querySelector('.cb-detail');
  if (!det) {
    det = document.createElement('div');
    det.className = 'cb-detail';
    li.appendChild(det);
  }
  det.innerHTML = '<div class="cb-none">Loading…</div>';
  let d = detailCache.get(key);
  if (!d) {
    try {
      d = await api('/api/browse/group/' + encodeURIComponent(key));
      detailCache.set(key, d);
    } catch (e) {
      det.innerHTML = `<div class="cb-status error">${esc(e.message)}</div>`;
      return;
    }
  }
  if (!li.classList.contains('open')) return;   // closed while loading
  renderDetail(li, d);
}

function closeRow(li) {
  li.classList.remove('open');
  const det = li.querySelector('.cb-detail');
  if (det) det.remove();
}

function renderDetail(li, d) {
  const det = li.querySelector('.cb-detail');
  const key = li.dataset.key;
  const matching = d.versions.filter(versionMatches);
  let view = rowView.get(key);
  if (!view || !d.versions.some(v => v.chant_uuid === view.active)) {
    view = { active: (matching[0] || d.versions[0]).chant_uuid, compare: false };
    rowView.set(key, view);
  }

  const tabs = d.versions.map(v => {
    const cls = ['cb-vtab'];
    if (!view.compare && v.chant_uuid === view.active) cls.push('active');
    if (!versionMatches(v)) cls.push('dim');
    if (v.src === 'local') cls.push('local');
    const label = v.src === 'local' ? `Local · ${v.version || ''}` : (v.version || 'gregobase');
    const tip = [v.incipit, partName(v.part || 'none'), 'mode ' + modeLabel(v.mode)].join(' · ');
    return `<button type="button" class="${cls.join(' ')}" data-uuid="${esc(v.chant_uuid)}" title="${esc(tip)}">${esc(label)}</button>`;
  }).join('');

  const shown = view.compare
    ? (matching.length ? matching : d.versions)
    : d.versions.filter(v => v.chant_uuid === view.active);

  det.innerHTML =
    `<div class="cb-vtabs">${tabs}<span class="spacer"></span>` +
      (d.versions.length > 1
        ? `<button type="button" class="cb-btn${view.compare ? ' on' : ''}" data-act="compare" ` +
          `title="Engrave every version${matching.length && matching.length < d.versions.length ? ' matching the filters' : ''} one under another">Compare all</button>`
        : '') +
    `</div>` +
    shown.map(versionHtml).join('') +
    usagesHtml(d);

  det.querySelector('.cb-vtabs').addEventListener('click', e => {
    const tab = e.target.closest('.cb-vtab');
    if (tab) { view.active = tab.dataset.uuid; view.compare = false; renderDetail(li, d); return; }
    if (e.target.closest('[data-act="compare"]')) { view.compare = !view.compare; renderDetail(li, d); }
  });
  det.querySelectorAll('[data-act="copy"]').forEach(b => b.addEventListener('click', () => {
    const v = d.versions.find(x => x.chant_uuid === b.dataset.uuid);
    copyText(b, gabcFile(v));
  }));
  det.querySelectorAll('[data-act="uuid"]').forEach(b => b.addEventListener('click', () => {
    copyText(b, b.dataset.uuid);
  }));
  drawScores(det, d);
}

function drawScores(det, d) {
  det.querySelectorAll('.cb-score').forEach(el => {
    const v = d.versions.find(x => x.chant_uuid === el.dataset.uuid);
    renderGabc(v.gabc_body, el, v.verses_html, v.gabc_header);
  });
}

function versionHtml(v) {
  const meta = [
    `<span><b>${esc(v.incipit)}</b></span>`,
    `<span>${esc(partName(v.part || 'none'))}</span>`,
    `<span>Mode <b>${esc(modeLabel(v.mode))}</b></span>`,
    `<span>${esc(v.src === 'local' ? 'Local' : 'GregoBase')} · ${esc(v.version || '—')}</span>`,
    v.transcriber ? `<span>Transcriber: ${esc(v.transcriber)}</span>` : '',
    v.status ? `<span>Status: <b>${esc(v.status)}</b></span>` : '',
    v.commentary ? `<span>${esc(v.commentary)}</span>` : '',
    v.tags.length ? `<span>Tags: ${v.tags.map(esc).join(', ')}</span>` : '',
  ].join('');
  const gb = v.src === 'gregobase'
    ? `<a class="cb-btn" href="https://gregobase.selapa.net/chant.php?id=${encodeURIComponent(v.chant_id)}" target="_blank" rel="noopener">GregoBase ↗</a>`
    : '';
  const sources = v.sources.length
    ? `<div class="cb-sub">Printed in</div><ul class="cb-sources">` +
      v.sources.map(s => `<li>${esc(s.title)} <span class="yr">(${esc(s.year)})</span>${s.page ? `, p. ${esc(s.page)}` : ''}</li>`).join('') +
      `</ul>`
    : '';
  return `<div class="cb-version">` +
      `<div class="cb-vmeta">${meta}<span class="actions">` +
        `<button type="button" class="cb-btn" data-act="copy" data-uuid="${esc(v.chant_uuid)}">Copy GABC</button>` +
        `<button type="button" class="cb-btn" data-act="uuid" data-uuid="${esc(v.chant_uuid)}" title="${esc(v.chant_uuid)}">Copy chant_uuid</button>` +
        gb +
      `</span></div>` +
      `<div class="cb-score" data-uuid="${esc(v.chant_uuid)}"></div>` +
      sources +
    `</div>`;
}

function usagesHtml(d) {
  if (!d.usages.length) {
    return `<div class="cb-sub">In Liturgio</div><div class="cb-none">Not assigned to any liturgical part yet.</div>`;
  }
  const label = new Map(d.versions.map(v => [v.chant_uuid,
    v.src === 'local' ? `Local · ${v.version || ''}` : (v.version || 'gregobase')]));
  return `<div class="cb-sub">In Liturgio (${d.usages.length})</div><ul class="cb-usages">` +
    d.usages.map(u =>
      `<li>${esc(u.epoch_title || u.lit_epoch_slug || '—')} ` +
      `<span class="meta">(${esc(u.lit_epoch_slug || '')})</span> — ${esc(u.part_name || '')}` +
      (u.option_txt ? ` <span class="meta">${esc(u.option_txt)}</span>` : '') +
      ` <span class="meta">· ${esc(u.book || '')}${u.printed_page_num ? ' p. ' + esc(u.printed_page_num) : ''}` +
      ` · ${esc(u.jurisdiction || '')} · ${esc(label.get(u.chant_uuid) || u.chant_uuid)}</span></li>`
    ).join('') + `</ul>`;
}

function gabcFile(v) {
  const header = [
    `name: ${v.incipit || ''};`,
    v.part ? `office-part: ${partName(v.part)};` : '',
    v.mode ? `mode: ${v.mode};` : '',
    `transcriber: ${v.transcriber || ''};`,
  ].filter(Boolean).join('\n');
  return `${header}\n%%\n${v.gabc_body || ''}\n`;
}

async function copyText(btn, s) {
  const old = btn.textContent;
  try {
    await navigator.clipboard.writeText(s);
    btn.textContent = 'Copied';
  } catch (_) {
    btn.textContent = 'Copy failed';
  }
  setTimeout(() => { btn.textContent = old; }, 1200);
}

// ── Keyboard ──────────────────────────────────────────────────────────────────
function setCursor(idx, scroll = true) {
  const rows = resultsEl.children;
  if (!rows.length) return;
  idx = Math.max(0, Math.min(idx, rows.length - 1));
  if (state.cursor >= 0 && rows[state.cursor]) rows[state.cursor].classList.remove('cursor');
  state.cursor = idx;
  rows[idx].classList.add('cursor');
  if (scroll) rows[idx].querySelector('.cb-head').scrollIntoView({ block: 'nearest' });
  if (idx >= rows.length - 5) loadMore();
}

document.addEventListener('keydown', e => {
  const inField = e.target === qInput;
  const typing = !inField && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '/' && !inField) {
    e.preventDefault();
    qInput.focus();
    qInput.select();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    setCursor(state.cursor + 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (state.cursor <= 0 && !inField) { qInput.focus(); return; }
    setCursor(state.cursor - 1);
  } else if (e.key === 'Enter' && state.cursor >= 0) {
    e.preventDefault();
    toggleRow(resultsEl.children[state.cursor]);
  } else if (e.key === 'Escape') {
    if (inField && qInput.value) {
      qInput.value = '';
      onQuery();
    } else {
      const open = resultsEl.querySelector('.cb-row.open');
      if (open) { closeRow(open); state.openKey = null; writeUrl(); }
    }
  } else if (!inField && e.key.length === 1 && /\S/.test(e.key)) {
    // Start typing anywhere on the page → goes into the search box
    qInput.focus();
  }
});

// ── Wiring ────────────────────────────────────────────────────────────────────
let qTimer = null;
function onQuery() {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => {
    const q = qInput.value.trim();
    if (q === state.q) return;
    state.q = q;
    refresh();
  }, 180);
}
qInput.addEventListener('input', onQuery);

matchSeg.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b || b.dataset.match === state.match) return;
  state.match = b.dataset.match;
  syncControls();
  refresh();
});
usedBox.addEventListener('change', () => { state.used = usedBox.checked; refresh(); });

function checkSentinel() {
  const r = sentinel.getBoundingClientRect();
  if (r.top < scrollEl.getBoundingClientRect().bottom + 600) loadMore();
}
new IntersectionObserver(entries => {
  if (entries.some(en => en.isIntersecting)) loadMore();
}, { root: scrollEl, rootMargin: '600px' }).observe(sentinel);

// Re-engrave the open row's scores when the width changes
let rTimer = null;
let lastW = window.innerWidth;
window.addEventListener('resize', () => {
  if (window.innerWidth === lastW) return;
  lastW = window.innerWidth;
  clearTimeout(rTimer);
  rTimer = setTimeout(() => {
    const open = resultsEl.querySelector('.cb-row.open');
    const d = open && detailCache.get(open.dataset.key);
    if (d) drawScores(open, d);
  }, 250);
});

readUrl();
syncControls();
refresh();
qInput.focus();
