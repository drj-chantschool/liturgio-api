'use strict';

const $ = id => document.getElementById(id);

// ── API helper (matches pattern in app.js) ────────────────────────────────────
async function apiFetch(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${msg}`);
  }
  return res.json();
}

// ── State ─────────────────────────────────────────────────────────────────────
let currentScope = new URLSearchParams(location.search).get('scope') || 'all';
let knownScopes = [];   // populated on first load; reused on re-fetch

// ── DOM refs ──────────────────────────────────────────────────────────────────
const scopeChips       = $('scope-chips');
const dashLoading      = $('dash-loading');
const dashError        = $('dash-error');
const sectionSources   = $('dash-section-sources');
const sourcesCards     = $('dash-sources-cards');
const sectionChants    = $('dash-section-chants');
const chantsPartsEl    = $('dash-chants-parts');
const dashBadge        = $('dash-badge');

// ── Chip rendering ────────────────────────────────────────────────────────────
function renderScopeChips(scopes) {
  scopeChips.innerHTML = '';
  for (const sc of scopes) {
    const btn = document.createElement('button');
    btn.className = 'chip' + (sc.id === currentScope ? ' active' : '');
    btn.dataset.scope = sc.id;
    btn.textContent = `${sc.label} (${sc.epoch_count})`;
    btn.addEventListener('click', () => {
      if (sc.id === currentScope) return;
      currentScope = sc.id;
      history.replaceState(null, '', `?scope=${encodeURIComponent(currentScope)}`);
      fetchAndRender();
    });
    scopeChips.appendChild(btn);
  }
}

// ── Progress bar rendering ────────────────────────────────────────────────────
function renderPartsRows(parts, container) {
  container.innerHTML = '';
  for (const p of parts) {
    if (p.expected === 0) continue;
    const row = document.createElement('div');
    row.className = 'dash-part-row';

    const label = document.createElement('div');
    label.className = 'dash-part-label';
    label.textContent = p.display_name;

    const track = document.createElement('div');
    track.className = 'dash-bar-track';

    const fill = document.createElement('div');
    fill.className = 'dash-bar-fill';
    fill.style.width = `${Math.min(p.pct, 100)}%`;

    const pctTxt = document.createElement('span');
    pctTxt.className = 'dash-bar-pct';
    pctTxt.textContent = `${p.covered} / ${p.expected} (${p.pct}%)`;

    track.appendChild(fill);
    row.appendChild(label);
    row.appendChild(track);
    row.appendChild(pctTxt);
    container.appendChild(row);
  }
}

// ── Main render ───────────────────────────────────────────────────────────────
function renderData(data) {
  // Scope chips — only rebuild on first load or if scope list changed
  if (knownScopes.length === 0) {
    knownScopes = data.scopes;
  }
  renderScopeChips(data.scopes);

  dashBadge.textContent =
    data.scopes.find(s => s.id === data.scope)?.epoch_count + ' epochs in scope' || '';

  // Sources section
  sourcesCards.innerHTML = '';
  for (const src of data.sources) {
    const card = document.createElement('div');
    card.className = 'dash-card';

    const title = document.createElement('div');
    title.className = 'dash-card-title';
    title.textContent = src.source;
    card.appendChild(title);

    const partsEl = document.createElement('div');
    partsEl.className = 'dash-card-parts';
    renderPartsRows(src.parts, partsEl);
    card.appendChild(partsEl);

    sourcesCards.appendChild(card);
  }
  sectionSources.hidden = false;

  // Chants section
  renderPartsRows(data.chants_set.parts, chantsPartsEl);
  sectionChants.hidden = false;
}

// ── Fetch + render ────────────────────────────────────────────────────────────
async function fetchAndRender() {
  dashLoading.hidden = false;
  dashError.hidden = true;
  sectionSources.hidden = true;
  sectionChants.hidden = true;

  // Update chip active state immediately
  for (const btn of scopeChips.querySelectorAll('.chip')) {
    btn.classList.toggle('active', btn.dataset.scope === currentScope);
  }

  try {
    const data = await apiFetch(`/api/dashboard/coverage?scope=${encodeURIComponent(currentScope)}`);
    dashLoading.hidden = true;
    renderData(data);
  } catch (err) {
    dashLoading.hidden = true;
    dashError.textContent = `Error: ${err.message}`;
    dashError.hidden = false;
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
fetchAndRender();
