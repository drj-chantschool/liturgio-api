'use strict';

// ── Date helpers (local calendar dates — avoid UTC/ISO-string timezone shifts) ──
function toDateInputValue(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function fromDateInputValue(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDays(d, n) {
  const nd = new Date(d);
  nd.setDate(nd.getDate() + n);
  return nd;
}
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
function formatLongDate(d) {
  return `${WEEKDAY_NAMES[d.getDay()]}, ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  date: new Date(),          // currently selected calendar date
  jurisdiction: 'US',
  dayData: null,             // last successful /api/day response
  activeSlug: null,
};

const _chantCache = new Map(); // chant_uuid -> ChantUuidResult

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const dateInput      = $('date-input');
const dateDisplay     = $('date-display');
const jurSelect       = $('jurisdiction-select');
const tabsEl          = $('observance-tabs');
const loadingEl       = $('day-loading');
const errorEl         = $('day-error');
const emptyEl         = $('day-empty');
const panelEl         = $('observance-panel');
const obsTitleEl      = $('observance-title');
const obsMetaEl       = $('observance-meta');
const formularyTabsEl = $('formulary-tabs');
const serviceGroupsEl = $('service-groups');

// ── API helper ───────────────────────────────────────────────────────────────
async function apiFetch(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${msg}`);
  }
  return res.json();
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ── GABC rendering (mirrors app.js) ──────────────────────────────────────────
function renderGabc(gabcBody, container) {
  if (typeof exsurge === 'undefined') {
    container.innerHTML = '<em class="render-note">exsurge not loaded — check network</em>';
    return;
  }
  const body = (gabcBody || '').trim();
  if (!body) {
    container.innerHTML = '<em class="render-note">No notation</em>';
    return;
  }
  requestAnimationFrame(() => {
    const rect = container.getBoundingClientRect();
    const w = Math.max((rect.width || container.clientWidth) - 32, 300);
    try {
      const ctxt = new exsurge.ChantContext();
      const mappings = exsurge.Gabc.createMappingsFromSource(ctxt, body);
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
  });
}

// ── Fetch + render a day ─────────────────────────────────────────────────────
async function loadDay() {
  const dateStr = toDateInputValue(state.date);
  dateInput.value = dateStr;
  dateDisplay.textContent = formatLongDate(state.date);

  loadingEl.hidden = false;
  errorEl.hidden = true;
  emptyEl.hidden = true;
  panelEl.hidden = true;
  tabsEl.innerHTML = '';

  try {
    const data = await apiFetch(`/api/day/${dateStr}?jurisdiction=${encodeURIComponent(state.jurisdiction)}`);
    state.dayData = data;
    loadingEl.hidden = true;

    if (!data.observances.length) {
      emptyEl.hidden = false;
      emptyEl.textContent = 'No liturgical calendar data for this date.';
      return;
    }

    state.activeSlug = data.observances[0].epoch_slug;
    renderTabs(data.observances);
    renderObservance(data.observances[0]);
  } catch (err) {
    loadingEl.hidden = true;
    errorEl.hidden = false;
    errorEl.textContent = `Error loading day: ${err.message}`;
  }
}

function roleLabel(obs) {
  const bits = [];
  if (obs.role === 'commemoration') bits.push('commemoration');
  if (obs.role === 'optional') bits.push('optional memorial');
  if (obs.is_transferred && obs.nominal_dt) bits.push(`transferred from ${obs.nominal_dt}`);
  return bits.join(' · ');
}

// Short badge labels for the tab chip — p_lit_rank.display_name is a full
// rubrical description (fine for the observance header) but far too long
// for a tab. Fall back to a humanized rank_code for anything not listed.
const RANK_SHORT_LABELS = {
  TRIDUUM: 'Triduum', PRINCIPAL_TEMPORAL: 'Principal Feast', SOLEMNITY: 'Solemnity',
  PROPER_SOLEMNITY: 'Solemnity', FEAST_OF_THE_LORD: 'Feast of the Lord', SUNDAY: 'Sunday',
  FEAST: 'Feast', PROPER_FEAST: 'Feast', PRIVILEGED_WEEKDAY: 'Privileged Weekday',
  MEMORIAL: 'Memorial', PROPER_MEMORIAL: 'Memorial', OPTIONAL_MEMORIAL: 'Optional Memorial',
  WEEKDAY: 'Weekday', UNDETERMINED: 'Undetermined',
};
function shortRank(obs) {
  if (obs.rank_code && RANK_SHORT_LABELS[obs.rank_code]) return RANK_SHORT_LABELS[obs.rank_code];
  if (obs.rank_code) return obs.rank_code.replace(/_/g, ' ').replace(/\w\S*/g, w => w[0] + w.slice(1).toLowerCase());
  return '';
}

function renderTabs(observances) {
  tabsEl.innerHTML = '';
  for (const obs of observances) {
    const btn = document.createElement('button');
    btn.className = 'chip observance-tab' + (obs.epoch_slug === state.activeSlug ? ' active' : '');
    btn.dataset.slug = obs.epoch_slug;
    const label = roleLabel(obs);
    btn.innerHTML = `<span class="tab-title">${escHtml(obs.title)}</span>` +
      `<span class="tab-rank">${escHtml(shortRank(obs))}</span>` +
      (label ? `<span class="tab-role">${escHtml(label)}</span>` : '');
    btn.addEventListener('click', () => {
      state.activeSlug = obs.epoch_slug;
      tabsEl.querySelectorAll('.observance-tab').forEach(b => b.classList.toggle('active', b === btn));
      renderObservance(obs);
    });
    tabsEl.appendChild(btn);
  }
}

const SERVICE_LABELS = {
  MASS: 'Mass', VESPERS: 'Vespers', VIGIL: 'Vigil', ASHES: 'Distribution of Ashes',
  PALMS: 'Blessing and Procession of Palms', CANDLES: 'Blessing of Candles',
  GOODFRIDAY: 'Good Friday Liturgy', LOTIO: 'Washing of Feet',
};

function renderObservance(obs) {
  panelEl.hidden = false;
  emptyEl.hidden = true;

  obsTitleEl.textContent = obs.title;
  const metaBits = [obs.rank_display_name || obs.rank_code];
  const label = roleLabel(obs);
  if (label) metaBits.push(label);
  metaBits.push(obs.epoch_slug);
  obsMetaEl.textContent = metaBits.filter(Boolean).join('  ·  ');

  formularyTabsEl.innerHTML = '';
  serviceGroupsEl.innerHTML = '';

  const formularies = obs.formularies.filter(f => Object.keys(f.services).length);
  if (!formularies.length) {
    formularyTabsEl.hidden = true;
    serviceGroupsEl.innerHTML = '<p class="day-empty-state">No chants loaded yet for this observance.</p>';
    return;
  }

  // Sub-tabs appear only when the observance actually has more than one
  // formulary (e.g. Christmas: Vigil / Night / Dawn / Day Masses) — the
  // ordinary single-Mass case renders straight into the content pane.
  if (formularies.length === 1) {
    formularyTabsEl.hidden = true;
    renderFormularyServices(formularies[0]);
    return;
  }

  formularyTabsEl.hidden = false;
  const selectFormulary = (formulary) => {
    formularyTabsEl.querySelectorAll('.formulary-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.slug === formulary.epoch_slug));
    renderFormularyServices(formulary);
  };
  for (const formulary of formularies) {
    const btn = document.createElement('button');
    btn.className = 'chip formulary-tab';
    btn.dataset.slug = formulary.epoch_slug;
    btn.textContent = formulary.title || formulary.epoch_slug;
    btn.addEventListener('click', () => selectFormulary(formulary));
    formularyTabsEl.appendChild(btn);
  }
  selectFormulary(formularies[0]);
}

function renderFormularyServices(formulary) {
  serviceGroupsEl.innerHTML = '';
  for (const code of Object.keys(formulary.services)) {
    const group = document.createElement('section');
    group.className = 'service-group';
    const heading = document.createElement('div');
    heading.className = 'service-group-header';
    heading.textContent = SERVICE_LABELS[code] || code;
    group.appendChild(heading);

    for (const part of formulary.services[code]) {
      group.appendChild(renderPartRow(part));
    }
    serviceGroupsEl.appendChild(group);
  }
}

function renderPartRow(part) {
  const row = document.createElement('div');
  row.className = 'part-row';

  const header = document.createElement('div');
  header.className = 'part-row-header';
  header.innerHTML =
    `<span class="part-code part-${escHtml(part.part_code)}">${escHtml(part.part_code)}</span>` +
    `<span class="part-name">${escHtml(part.display_name)}</span>` +
    (part.option_num && part.option_num > 1 ? `<span class="part-option">option ${part.option_num}</span>` : '') +
    (part.assignment_authority_code ? `<span class="part-authority">${escHtml(part.assignment_authority_code)}</span>` : '');
  row.appendChild(header);

  const notationCol = document.createElement('div');
  notationCol.className = 'part-notation-col';
  notationCol.innerHTML =
    '<div class="part-col-label">Notation' +
    '<select class="part-version-select" hidden></select>' +
    '</div><div class="part-notation-body">&hellip;</div>';
  row.appendChild(notationCol);

  setupVersionSelector(
    part,
    notationCol.querySelector('.part-version-select'),
    notationCol.querySelector('.part-notation-body'),
  );

  if (part.notes) {
    const notes = document.createElement('div');
    notes.className = 'part-notes';
    notes.textContent = part.notes;
    row.appendChild(notes);
  }

  return row;
}

// ── Chant version selector ───────────────────────────────────────────────────
// Each chant_group can hold several settings of the same chant (a Solesmes/
// gregobase edition, alternate versions, a local English singing edition,
// ...). The day API only tells us which one is currently assigned
// (part.chant_uuid); this lets the viewer pick any other version in the same
// group, defaulting to the local English one when the group has one.
const _versionsCache = new Map(); // chant_group_id -> [ChantInGroup, ...]

async function fetchGroupVersions(groupId) {
  let versions = _versionsCache.get(groupId);
  if (!versions) {
    versions = await apiFetch(`/api/chant_groups/${groupId}/chants`);
    _versionsCache.set(groupId, versions);
  }
  return versions;
}

function versionLabel(v) {
  const bits = [v.source === 'local' ? 'Local' : 'Gregobase', v.version || 'unspecified'];
  if (v.incipit) bits.push(`“${v.incipit}”`);
  return bits.join(' · ');
}

async function loadChantNotation(uuid, container) {
  container.dataset.chantUuid = uuid || '';   // read by the right-click "Edit" menu
  if (!uuid) {
    container.innerHTML = '<em class="render-note">No chant assigned</em>';
    return;
  }
  try {
    let chant = _chantCache.get(uuid);
    if (!chant) {
      chant = await apiFetch(`/api/chant_by_uuid?uuid=${encodeURIComponent(uuid)}`);
      _chantCache.set(uuid, chant);
    }
    container.innerHTML = '';
    renderGabc(chant.gabc_body, container);
  } catch (err) {
    container.innerHTML = `<em class="render-note error">${escHtml(err.message)}</em>`;
  }
}

async function setupVersionSelector(part, selectEl, notationBodyEl) {
  // No chant_group_id at all (e.g. text-only assignment) — nothing to pick from.
  if (part.chant_group_id == null) {
    await loadChantNotation(part.chant_uuid, notationBodyEl);
    return;
  }

  await loadChantNotation(part.chant_uuid, notationBodyEl); // show the assigned version immediately

  let versions;
  try {
    versions = await fetchGroupVersions(part.chant_group_id);
  } catch (err) {
    return; // keep showing the assigned version; selector just won't appear
  }
  if (!versions.length) return;

  const englishLocal = versions.find(v => v.source === 'local' && (v.version || '').toLowerCase() === 'english');
  const assigned = versions.find(v => `${v.source}:${v.chant_id}` === part.chant_uuid);
  const defaultVersion = englishLocal || assigned || versions[0];

  selectEl.innerHTML = versions.map(v => {
    const uuid = `${v.source}:${v.chant_id}`;
    return `<option value="${escHtml(uuid)}"${uuid === `${defaultVersion.source}:${defaultVersion.chant_id}` ? ' selected' : ''}>${escHtml(versionLabel(v))}</option>`;
  }).join('');
  selectEl.hidden = false;

  selectEl.addEventListener('change', () => {
    notationBodyEl.innerHTML = '&hellip;';
    loadChantNotation(selectEl.value, notationBodyEl);
  });

  const defaultUuid = `${defaultVersion.source}:${defaultVersion.chant_id}`;
  if (defaultUuid !== part.chant_uuid) {
    await loadChantNotation(defaultUuid, notationBodyEl);
  }
}

// ── Right-click "Edit" menu for local chants ─────────────────────────────────
// Local (non-gregobase) chants are editable in the main Chant Editor
// (index.html), which loads whatever chant is named in the URL hash — see
// app.js's init and assignments.js's "Edit" link (`/#${local_chant_id}`,
// target=_blank). Here that same jump lives on a right-click context menu
// instead of a button, scoped to whichever version is currently rendered.
const chantContextMenu = document.createElement('div');
chantContextMenu.id = 'chant-context-menu';
chantContextMenu.hidden = true;
document.body.appendChild(chantContextMenu);

function hideChantContextMenu() { chantContextMenu.hidden = true; }
document.addEventListener('click', hideChantContextMenu);
document.addEventListener('scroll', hideChantContextMenu, true);
window.addEventListener('resize', hideChantContextMenu);

serviceGroupsEl.addEventListener('contextmenu', (e) => {
  const notationBody = e.target.closest('.part-notation-body');
  const uuid = notationBody?.dataset.chantUuid;
  if (!uuid || !uuid.startsWith('local:')) return; // not a local chant — leave the browser's own menu alone

  e.preventDefault();
  const localId = uuid.slice('local:'.length);
  chantContextMenu.innerHTML = '<button type="button" class="ctx-menu-item">Edit chant…</button>';
  chantContextMenu.querySelector('.ctx-menu-item').addEventListener('click', () => {
    window.open(`/#${localId}`, '_blank');
  });
  chantContextMenu.style.left = `${e.pageX}px`;
  chantContextMenu.style.top = `${e.pageY}px`;
  chantContextMenu.hidden = false;
});

// ── Navigation wiring ────────────────────────────────────────────────────────
$('nav-prev-day').addEventListener('click', () => { state.date = addDays(state.date, -1); loadDay(); });
$('nav-next-day').addEventListener('click', () => { state.date = addDays(state.date, 1); loadDay(); });
$('nav-prev-week').addEventListener('click', () => { state.date = addDays(state.date, -7); loadDay(); });
$('nav-next-week').addEventListener('click', () => { state.date = addDays(state.date, 7); loadDay(); });
$('nav-today').addEventListener('click', () => { state.date = new Date(); loadDay(); });
dateInput.addEventListener('change', () => {
  if (dateInput.value) {
    state.date = fromDateInputValue(dateInput.value);
    loadDay();
  }
});
jurSelect.addEventListener('change', () => {
  state.jurisdiction = jurSelect.value;
  loadDay();
});

// ── Init ─────────────────────────────────────────────────────────────────────
jurSelect.value = state.jurisdiction;
loadDay();
