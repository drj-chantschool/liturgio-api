'use strict';

// Shared chant-assignment panels used by Source Review and GR Index.

// "Browse gregobase…" panel: part / letter (/ 2nd letter) → chant group
// → individual gregobase chant within the group → Assign.
//
// Usage:
//   <div id="gri-browse-panel" hidden></div>      (markup is injected here)
//   const browser = createGregobaseBrowser({
//     panel: document.getElementById('gri-browse-panel'),
//     api,                                       // page's fetch-JSON helper
//     onAssign: async gregobaseId => { ... },    // throw to show an error
//   });
//   await browser.init();                        // loads part list
//   browser.open({ part: 'in', letter: 'A' });   // both optional
//   browser.hide();
function createGregobaseBrowser({ panel, api, onAssign }) {
  panel.innerHTML = `
    <div class="pane-label" id="gri-browse-panel-label">Browse chant groups</div>
    <div id="gri-browse-controls">
      <label>Part
        <select id="gri-browse-part"></select>
      </label>
      <label>Letter
        <select id="gri-browse-letter"></select>
      </label>
      <label id="gri-browse-letter2-wrap" hidden>2nd
        <select id="gri-browse-letter2"></select>
      </label>
      <span id="gri-browse-msg"></span>
      <button id="gri-browse-close-btn" class="btn-secondary btn-sm" style="margin-left:auto">Close</button>
    </div>
    <div id="gri-browse-body">
      <ul id="gri-browse-list"></ul>
      <div id="gri-browse-detail">
        <div id="gri-browse-detail-meta"></div>
        <div id="gri-browse-chant-list" hidden>
          <ul id="gri-browse-chant-ul"></ul>
        </div>
        <div id="gri-browse-detail-engrav"></div>
        <div id="gri-browse-detail-actions" hidden>
          <button id="gri-browse-assign-btn" class="btn-primary btn-sm">Assign this</button>
        </div>
      </div>
    </div>`;

  const q = id => panel.querySelector('#' + id);
  const partSel       = q('gri-browse-part');
  const letterSel     = q('gri-browse-letter');
  const letter2Wrap   = q('gri-browse-letter2-wrap');
  const letter2Sel    = q('gri-browse-letter2');
  const closeBtn      = q('gri-browse-close-btn');
  const msgEl         = q('gri-browse-msg');
  const listEl        = q('gri-browse-list');
  const detailMetaEl  = q('gri-browse-detail-meta');
  const chantListEl   = q('gri-browse-chant-list');
  const chantUl       = q('gri-browse-chant-ul');
  const engravEl      = q('gri-browse-detail-engrav');
  const actionsEl     = q('gri-browse-detail-actions');
  const assignBtn     = q('gri-browse-assign-btn');

  const st = { groups: [], selected: null, chants: [], selectedChant: null };

  const esc = s => (s == null ? '' : String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));

  function fillSelect(sel, values) {
    const prev = sel.value;
    sel.innerHTML = '';
    for (const v of values) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      sel.appendChild(opt);
    }
    if (values.includes(prev)) sel.value = prev;
  }

  async function loadParts() {
    try {
      fillSelect(partSel, await api('/api/gregobase_parts'));
      await loadLetters();
    } catch (_) {}
  }

  async function loadLetters() {
    const part = partSel.value;
    if (!part) return;
    try {
      fillSelect(letterSel, await api('/api/gregobase_letters?part=' + encodeURIComponent(part)));
    } catch (_) {}
    await loadLetter2();
  }

  async function loadLetter2() {
    const part = partSel.value;
    const letter = letterSel.value;
    if (!part || !letter) { letter2Wrap.hidden = true; return; }
    try {
      const sub = await api('/api/gregobase_letters?part=' + encodeURIComponent(part) +
                            '&prefix=' + encodeURIComponent(letter));
      if (sub.length > 1) {
        fillSelect(letter2Sel, sub);
        letter2Wrap.hidden = false;
      } else {
        letter2Wrap.hidden = true;
      }
    } catch (_) { letter2Wrap.hidden = true; }
  }

  async function runLoad() {
    const part = partSel.value;
    const prefix = letter2Wrap.hidden ? letterSel.value : letter2Sel.value;
    if (!part || !prefix) return;
    msgEl.textContent = 'Loading…';
    listEl.innerHTML = '';
    clearDetail();
    st.groups = [];
    st.selected = null;
    try {
      const p = new URLSearchParams({ part, prefix, limit: '300' });
      st.groups = await api('/api/gr_index_browse?' + p.toString());
      msgEl.textContent = `${st.groups.length} group(s)`;
      renderList();
    } catch (e) {
      msgEl.textContent = 'Error: ' + e.message;
    }
  }

  function renderList() {
    listEl.innerHTML = '';
    if (!st.groups.length) {
      const li = document.createElement('li');
      li.className = 'gri-browse-empty';
      li.textContent = 'No groups found.';
      listEl.appendChild(li);
      return;
    }
    for (const g of st.groups) {
      const li = document.createElement('li');
      li.className = 'gri-browse-list-item';
      li.dataset.gid = g.chant_group_id;
      li.textContent = g.incipit || g.canonical_name || `group ${g.chant_group_id}`;
      li.addEventListener('click', () => selectGroup(g));
      listEl.appendChild(li);
    }
  }

  async function selectGroup(g) {
    st.selected = g;
    st.chants = [];
    st.selectedChant = null;
    listEl.querySelectorAll('.gri-browse-list-item').forEach(li => {
      li.classList.toggle('active', li.dataset.gid == g.chant_group_id);
    });
    detailMetaEl.innerHTML = `<strong>${esc(g.incipit || g.canonical_name || '')}</strong>`;
    chantUl.innerHTML = '<li class="gri-browse-empty">Loading…</li>';
    chantListEl.hidden = false;
    engravEl.innerHTML = '';
    actionsEl.hidden = true;
    let chants = [];
    try {
      chants = await api(`/api/chant_groups/${g.chant_group_id}/gregobase_chants`);
    } catch (_) {}
    if (st.selected !== g) return;  // user clicked another group meanwhile
    if (!chants.length && g.best_gregobase_id) {
      chants = [{ gregobase_id: g.best_gregobase_id, mode: g.best_mode,
        version: g.best_version, gabc_body: g.best_gabc_body, verses_html: g.best_verses_html }];
    }
    st.chants = chants;
    renderChantList();
    if (chants.length) selectChant(chants[0]);
  }

  function renderChantList() {
    const chants = st.chants;
    chantUl.innerHTML = '';
    if (chants.length <= 1) { chantListEl.hidden = true; return; }
    chantListEl.hidden = false;
    for (const c of chants) {
      const li = document.createElement('li');
      li.className = 'gri-browse-chant-item';
      li.dataset.gbid = c.gregobase_id;
      li.innerHTML =
        `<span class="gri-chant-version">${esc(c.version || '—')}</span>` +
        (c.mode ? ` <span class="mgp-badge">mode ${esc(c.mode)}</span>` : '') +
        ` <span class="gri-gb-id">#${c.gregobase_id}</span>`;
      li.addEventListener('click', () => selectChant(c));
      chantUl.appendChild(li);
    }
  }

  function selectChant(c) {
    st.selectedChant = c;
    chantUl.querySelectorAll('.gri-browse-chant-item').forEach(li => {
      li.classList.toggle('active', li.dataset.gbid == c.gregobase_id);
    });
    engravEl.innerHTML = '';
    if (c.gabc_body) renderGabc(c.gabc_body, engravEl, c.verses_html);
    else engravEl.innerHTML = '<em class="render-note">No GABC</em>';
    actionsEl.hidden = false;
  }

  function clearDetail() {
    detailMetaEl.innerHTML = '';
    chantUl.innerHTML = '';
    chantListEl.hidden = true;
    engravEl.innerHTML = '';
    actionsEl.hidden = true;
    st.chants = [];
    st.selectedChant = null;
  }

  function hide() { panel.hidden = true; }

  // Show the panel, optionally pre-selecting a part and first letter.
  async function open({ part, letter } = {}) {
    panel.hidden = false;
    if (part && [...partSel.options].some(o => o.value === part)) partSel.value = part;
    await loadLetters();
    if (letter && [...letterSel.options].some(o => o.value === letter)) {
      letterSel.value = letter;
      await loadLetter2();
    }
    runLoad();
  }

  closeBtn.addEventListener('click', hide);
  partSel.addEventListener('change', async () => { await loadLetters(); runLoad(); });
  letterSel.addEventListener('change', async () => { await loadLetter2(); runLoad(); });
  letter2Sel.addEventListener('change', runLoad);

  assignBtn.addEventListener('click', async () => {
    if (!st.selectedChant) return;
    msgEl.textContent = 'Assigning…';
    try {
      await onAssign(st.selectedChant.gregobase_id);
      hide();
    } catch (e) {
      msgEl.textContent = 'Error: ' + e.message;
    }
  });

  return { init: loadParts, open, hide };
}

// Shared "New chant…" panel: paste GABC, preview, save & assign.
//
// Usage:
//   <div id="gri-new-panel" hidden></div>         (markup is injected here)
//   const newChant = createNewChantPanel({
//     panel: document.getElementById('gri-new-panel'),
//     onSave: async payload => { ... },  // {gabc, incipit, mode, version, canonical_name}; throw to show an error
//   });
//   newChant.open({ incipit, mode, name });         // all optional
//   newChant.hide();
function createNewChantPanel({ panel, onSave }) {
  panel.innerHTML = `
    <div class="pane-label">Paste new chant GABC</div>
    <div id="gri-new-form">
      <div class="gri-new-row">
        <label>Incipit
          <input type="text" id="gri-new-incipit" placeholder="Latin incipit…">
        </label>
        <label>Mode
          <input type="text" id="gri-new-mode" placeholder="e.g. 1" style="width:4rem">
        </label>
        <label>Version
          <input type="text" id="gri-new-version" value="latin" style="width:6rem">
        </label>
        <label>Chant group name
          <input type="text" id="gri-new-name" placeholder="(uses incipit if blank)" style="width:14rem">
        </label>
      </div>
      <div class="pane-label" style="margin-top:0.5rem">GABC</div>
      <textarea id="gri-new-gabc" spellcheck="false" rows="8" placeholder="Paste GABC here…"></textarea>
      <div id="gri-new-preview"></div>
      <div class="gri-new-row gri-new-actions">
        <button id="gri-new-preview-btn" class="btn-secondary btn-sm">Preview</button>
        <button id="gri-new-save-btn" class="btn-primary">Save &amp; assign</button>
        <button id="gri-new-close-btn" class="btn-secondary btn-sm">Cancel</button>
        <span id="gri-new-msg"></span>
      </div>
    </div>`;

  const q = id => panel.querySelector('#' + id);
  const incipitEl  = q('gri-new-incipit');
  const modeEl     = q('gri-new-mode');
  const versionEl  = q('gri-new-version');
  const nameEl     = q('gri-new-name');
  const gabcEl     = q('gri-new-gabc');
  const previewEl  = q('gri-new-preview');
  const previewBtn = q('gri-new-preview-btn');
  const saveBtn    = q('gri-new-save-btn');
  const closeBtn   = q('gri-new-close-btn');
  const msgEl      = q('gri-new-msg');

  function hide() { panel.hidden = true; }

  function open({ incipit, mode, name } = {}) {
    incipitEl.value = incipit || '';
    modeEl.value = mode != null ? String(mode) : '';
    versionEl.value = 'latin';
    nameEl.value = name || '';
    gabcEl.value = '';
    previewEl.innerHTML = '';
    msgEl.textContent = '';
    panel.hidden = false;
    gabcEl.focus();
  }

  closeBtn.addEventListener('click', hide);

  previewBtn.addEventListener('click', () => {
    const body = extractGabcBody(gabcEl.value.trim());
    if (body) renderGabc(body, previewEl);
    else previewEl.innerHTML = '<em class="render-note">No GABC to preview</em>';
  });

  saveBtn.addEventListener('click', async () => {
    const gabc = gabcEl.value.trim();
    if (!gabc) { msgEl.textContent = 'GABC cannot be empty.'; return; }
    msgEl.textContent = 'Saving…';
    saveBtn.disabled = true;
    try {
      await onSave({
        gabc,
        incipit: incipitEl.value.trim() || null,
        mode: modeEl.value.trim() || null,
        version: versionEl.value.trim() || 'latin',
        canonical_name: nameEl.value.trim() || null,
      });
      hide();
    } catch (e) {
      msgEl.textContent = 'Error: ' + e.message;
    } finally {
      saveBtn.disabled = false;
    }
  });

  return { open, hide };
}
