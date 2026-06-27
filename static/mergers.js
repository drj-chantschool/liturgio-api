'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let queueOffset = 0;
let remainingCount = null;
const QUEUE_BATCH = 20;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const queueCards     = document.getElementById('queue-cards');
const queueLoading   = document.getElementById('queue-loading');
const queueEmpty     = document.getElementById('queue-empty');
const queueStatusMsg = document.getElementById('queue-status-msg');
const loadMoreBtn    = document.getElementById('load-more-btn');
const manualIdA      = document.getElementById('manual-id-a');
const manualIdB      = document.getElementById('manual-id-b');
const manualCompBtn  = document.getElementById('manual-compare-btn');
const manualMsg      = document.getElementById('manual-msg');
const manualCardArea = document.getElementById('manual-card-area');

// ── Utility ───────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderGabc(gabcBody, container) {
  if (!gabcBody) {
    container.innerHTML = '<em class="render-note">(no notation)</em>';
    return;
  }
  if (typeof exsurge === 'undefined') {
    container.innerHTML = '<em class="render-note">exsurge not loaded</em>';
    return;
  }
  container.innerHTML = '<em class="render-note">Rendering…</em>';
  requestAnimationFrame(() => {
    const rect = container.getBoundingClientRect();
    const w = Math.max((rect.width || container.clientWidth) - 24, 260);
    try {
      const ctxt = new exsurge.ChantContext();
      const mappings = exsurge.Gabc.createMappingsFromSource(ctxt, gabcBody);
      const score = new exsurge.ChantScore(ctxt, mappings, true);
      score.performLayout(ctxt);
      score.layoutChantLines(ctxt, w, () => {
        try {
          container.innerHTML = score.createSvg(ctxt);
        } catch (err) {
          container.innerHTML = `<em class="render-note">Draw error: ${escHtml(err.message)}</em>`;
        }
      });
    } catch (err) {
      container.innerHTML = `<em class="render-note">Render error: ${escHtml(err.message)}</em>`;
    }
  });
}

// ── API ───────────────────────────────────────────────────────────────────────
async function apiFetch(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${body}`);
  }
  return res.json();
}

// ── Card building ─────────────────────────────────────────────────────────────
const PART_NAMES = {
  in: 'Introit', gr: 'Gradual', al: 'Alleluia', of: 'Offertory', co: 'Communion',
};

function makeGroupPanel(g) {
  const partLabel = PART_NAMES[g.office_part] || g.office_part || '';
  const countStr  = g.chant_count ? `${g.chant_count} chant${g.chant_count !== 1 ? 's' : ''}` : '';
  const cleanDiff = g.incipit_clean &&
                    g.incipit_clean !== (g.incipit || '').toLowerCase();

  const div = document.createElement('div');
  div.className = 'mgp';
  div.dataset.groupId = g.chant_group_id;
  div.innerHTML =
    `<div class="mgp-topline">` +
      `<span class="mgp-id">id: ${g.chant_group_id}</span>` +
      `<span class="mgp-count">${escHtml(countStr)}</span>` +
    `</div>` +
    `<div class="mgp-name" title="Click to edit">${escHtml(g.canonical_name)}</div>` +
    `<div class="mgp-badges">` +
      (g.mode      ? `<span class="mgp-badge">mode ${escHtml(g.mode)}</span>` : '') +
      (partLabel   ? `<span class="mgp-badge part-b">${escHtml(partLabel)}</span>` : '') +
    `</div>` +
    `<div class="mgp-incipit">${escHtml(g.incipit || '')}</div>` +
    (cleanDiff ? `<div class="mgp-clean">→ ${escHtml(g.incipit_clean)}</div>` : '') +
    `<div class="mgp-gabc"></div>`;

  attachNameEditor(div.querySelector('.mgp-name'), g.chant_group_id);
  return div;
}

function attachNameEditor(nameEl, groupId) {
  nameEl.addEventListener('click', () => {
    if (nameEl.classList.contains('editing')) return;
    nameEl.classList.add('editing');

    const original = nameEl.textContent.trim();
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'mgp-name-input';
    input.value = original;

    const saveBtn   = document.createElement('button');
    saveBtn.className = 'mgp-name-btn save';
    saveBtn.textContent = '✓';
    saveBtn.title = 'Save (Enter)';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'mgp-name-btn cancel';
    cancelBtn.textContent = '✕';
    cancelBtn.title = 'Cancel (Esc)';

    nameEl.textContent = '';
    nameEl.append(input, saveBtn, cancelBtn);
    input.focus();
    input.select();

    function restore(text) {
      nameEl.classList.remove('editing');
      nameEl.textContent = text;
      attachNameEditor(nameEl, groupId);
    }

    async function doSave() {
      const newName = input.value.trim();
      if (!newName) return;
      if (newName === original) { restore(original); return; }
      saveBtn.disabled = cancelBtn.disabled = true;
      try {
        await apiFetch(`/api/chant_groups/${groupId}/name`, {
          method: 'PATCH',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ canonical_name: newName }),
        });
        restore(newName);
      } catch (err) {
        restore(original);
        // brief flash of the error in the element
        nameEl.title = `Error: ${err.message}`;
      }
    }

    saveBtn.addEventListener('click', doSave);
    cancelBtn.addEventListener('click', () => restore(original));

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); doSave(); }
      if (e.key === 'Escape') restore(original);
    });

    // Save on blur unless focus moved to one of our own buttons
    input.addEventListener('blur', () => {
      setTimeout(() => {
        if (!nameEl.contains(document.activeElement)) doSave();
      }, 150);
    });
  });
}

function buildCard(pair, isManual = false) {
  const { group_a: ga, group_b: gb, similarity } = pair;
  const radioName = `keep-${ga.chant_group_id}-${gb.chant_group_id}`;
  const simPct    = similarity != null ? `${Math.round(similarity * 100)}% match` : '';

  // Card header
  const modePart = [
    ga.mode ? `mode ${ga.mode}` : null,
    PART_NAMES[ga.office_part] || ga.office_part || null,
  ].filter(Boolean).join(' · ');

  const card = document.createElement('div');
  card.className = 'merge-card' + (isManual ? ' manual-card' : '');

  // ── Header ──
  const hdr = document.createElement('div');
  hdr.className = 'mc-header';
  hdr.innerHTML =
    `<span class="mc-context">${escHtml(isManual ? 'Manual comparison' : modePart)}</span>` +
    (simPct ? `<span class="mc-sim">${simPct}</span>` : '');

  // ── Body: two panels ──
  const body = document.createElement('div');
  body.className = 'mc-body';

  const panelA = makeGroupPanel(ga);
  const panelB = makeGroupPanel(gb);
  // Mark which side each panel is (for keep-label)
  panelA.querySelector('.mgp-topline').insertAdjacentHTML(
    'afterbegin', '<span class="mgp-side-label">A</span>'
  );
  panelB.querySelector('.mgp-topline').insertAdjacentHTML(
    'afterbegin', '<span class="mgp-side-label">B</span>'
  );
  body.append(panelA, panelB);

  // ── Footer: keep radios + actions ──
  const ftr = document.createElement('div');
  ftr.className = 'mc-footer';
  ftr.innerHTML =
    `<div class="mc-keep">` +
      `Keep: ` +
      `<label><input type="radio" name="${radioName}" value="a" checked> A</label>` +
      `<label><input type="radio" name="${radioName}" value="b"> B</label>` +
    `</div>` +
    `<div class="mc-actions">` +
      `<button class="btn-merge btn-primary">Merge</button>` +
      `<button class="btn-reject btn-secondary">Not the same group</button>` +
      `<button class="btn-related btn-related-style">Related</button>` +
      `<span class="mc-msg"></span>` +
    `</div>`;

  card.append(hdr, body, ftr);

  // ── Wire up buttons ──
  const mergeBtn   = ftr.querySelector('.btn-merge');
  const rejectBtn  = ftr.querySelector('.btn-reject');
  const relatedBtn = ftr.querySelector('.btn-related');
  const mcMsg      = ftr.querySelector('.mc-msg');

  mergeBtn.addEventListener('click', async () => {
    const keepSide = ftr.querySelector(`input[name="${radioName}"]:checked`)?.value || 'a';
    const keepId  = keepSide === 'a' ? ga.chant_group_id : gb.chant_group_id;
    const mergeId = keepSide === 'a' ? gb.chant_group_id : ga.chant_group_id;
    mergeBtn.disabled = rejectBtn.disabled = relatedBtn.disabled = true;
    mcMsg.textContent = 'Merging…';
    mcMsg.className = 'mc-msg';
    try {
      await apiFetch('/api/merge-queue/merge', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ keep_id: keepId, merge_id: mergeId }),
      });
      mcMsg.textContent = `Merged — group ${mergeId} absorbed into ${keepId}`;
      mcMsg.className = 'mc-msg ok';
      card.classList.add('mc-done');
      decrementCount();
      setTimeout(() => card.remove(), 300);
    } catch (err) {
      mcMsg.textContent = `Error: ${err.message}`;
      mcMsg.className = 'mc-msg err';
      mergeBtn.disabled = rejectBtn.disabled = relatedBtn.disabled = false;
    }
  });

  rejectBtn.addEventListener('click', async () => {
    mergeBtn.disabled = rejectBtn.disabled = relatedBtn.disabled = true;
    mcMsg.textContent = 'Saving…';
    mcMsg.className = 'mc-msg';
    try {
      await apiFetch('/api/merge-queue/reject', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ group_id_a: ga.chant_group_id, group_id_b: gb.chant_group_id }),
      });
      mcMsg.textContent = 'Marked: not the same group';
      mcMsg.className = 'mc-msg ok';
      card.classList.add('mc-done');
      decrementCount();
      setTimeout(() => card.remove(), 300);
    } catch (err) {
      mcMsg.textContent = `Error: ${err.message}`;
      mcMsg.className = 'mc-msg err';
      mergeBtn.disabled = rejectBtn.disabled = relatedBtn.disabled = false;
    }
  });

  relatedBtn.addEventListener('click', async () => {
    mergeBtn.disabled = rejectBtn.disabled = relatedBtn.disabled = true;
    mcMsg.textContent = 'Saving…';
    mcMsg.className = 'mc-msg';
    try {
      await apiFetch('/api/merge-queue/related', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ group_id_a: ga.chant_group_id, group_id_b: gb.chant_group_id }),
      });
      mcMsg.textContent = 'Marked: related';
      mcMsg.className = 'mc-msg ok';
      card.classList.add('mc-done');
      decrementCount();
      setTimeout(() => card.remove(), 300);
    } catch (err) {
      mcMsg.textContent = `Error: ${err.message}`;
      mcMsg.className = 'mc-msg err';
      mergeBtn.disabled = rejectBtn.disabled = relatedBtn.disabled = false;
    }
  });

  // Render GABC after the card is in the DOM
  requestAnimationFrame(() => {
    renderGabc(ga.rep_gabc_body, panelA.querySelector('.mgp-gabc'));
    renderGabc(gb.rep_gabc_body, panelB.querySelector('.mgp-gabc'));
  });

  return card;
}

// ── Queue loading ──────────────────────────────────────────────────────────────
async function loadQueueBatch() {
  queueLoading.hidden = false;
  loadMoreBtn.hidden  = true;
  queueEmpty.hidden   = true;

  try {
    const pairs = await apiFetch(
      `/api/merge-queue/candidates?limit=${QUEUE_BATCH}&offset=${queueOffset}`
    );
    if (pairs.length === 0) {
      if (queueOffset === 0) queueEmpty.hidden = false;
      // else: no more after initial load — leave existing cards, hide button
    } else {
      queueOffset += pairs.length;
      for (const pair of pairs) queueCards.appendChild(buildCard(pair));
      if (pairs.length === QUEUE_BATCH) loadMoreBtn.hidden = false;
    }
  } catch (err) {
    const el = document.createElement('div');
    el.className = 'mc-api-error';
    el.textContent = `Error loading queue: ${err.message}`;
    queueCards.appendChild(el);
  } finally {
    queueLoading.hidden = true;
  }
}

// ── Manual comparison ──────────────────────────────────────────────────────────
manualCompBtn.addEventListener('click', async () => {
  const idA = parseInt(manualIdA.value, 10);
  const idB = parseInt(manualIdB.value, 10);
  if (!idA || !idB) { manualMsg.textContent = 'Enter both IDs.'; return; }
  if (idA === idB)  { manualMsg.textContent = 'IDs must differ.'; return; }

  manualCompBtn.disabled = true;
  manualMsg.textContent  = 'Loading…';
  manualCardArea.innerHTML = '';

  try {
    const [ga, gb] = await Promise.all([
      apiFetch(`/api/chant_groups/${idA}/summary`),
      apiFetch(`/api/chant_groups/${idB}/summary`),
    ]);
    manualMsg.textContent = '';
    manualCardArea.appendChild(buildCard({ group_a: ga, group_b: gb, similarity: null }, true));
  } catch (err) {
    manualMsg.textContent = `Error: ${err.message}`;
  } finally {
    manualCompBtn.disabled = false;
  }
});

// Allow Enter key in the ID inputs to trigger compare
[manualIdA, manualIdB].forEach(inp =>
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') manualCompBtn.click(); })
);

// ── Load more ─────────────────────────────────────────────────────────────────
loadMoreBtn.addEventListener('click', loadQueueBatch);

// ── Count display ─────────────────────────────────────────────────────────────
function updateCountDisplay() {
  if (remainingCount === null) {
    queueStatusMsg.textContent = '';
  } else {
    queueStatusMsg.textContent = `${remainingCount} remaining`;
  }
}

function decrementCount() {
  if (remainingCount !== null) {
    remainingCount = Math.max(0, remainingCount - 1);
    updateCountDisplay();
  }
}

async function fetchCount() {
  try {
    const data = await apiFetch('/api/merge-queue/count');
    remainingCount = data.count;
    updateCountDisplay();
  } catch (_) {}
}

// ── Init ──────────────────────────────────────────────────────────────────────
fetchCount();
loadQueueBatch();
