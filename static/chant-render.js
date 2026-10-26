// ── Shared chant renderer ─────────────────────────────────────────────────────
// The one place chant notation is drawn. Every page that shows a score loads
// this after exsurge.min.js and before its own script:
//
//   <script src="https://cdn.jsdelivr.net/gh/drj-chantschool/exsurge@v2.2.0-liturgio.2/dist/exsurge.min.js"></script>
//   <script src="/static/chant-render.js"></script>
//
// Styles (.render-note, .tex-verses) live in style.css.

// Whether GABC text has any notation after its header (the part after the
// last '%%'). Only for text typed in the browser: the API sends stored chants
// already split into *gabc_body / *gabc_header (rendered from chants.elements).
function hasGabcBody(gabc) {
  if (!gabc) return false;
  const parts = gabc.split('%%');
  return !!parts[parts.length - 1].trim();
}

// House style for every score. Change it here; exsurge itself needs no edits.
//   commentaryRaise — staff intervals; + raises the commentary, − lowers it
//                     (Gregorio's \grechangedim{commentaryraise}).
//   textStyles      — overrides for ctxt.textStyles.<type>, which is Gregorio's
//                     \grechangestyle. Types: commentary, annotation, title,
//                     subtitle, leftRight, lyric, translation, al, dropCap.
//                     Properties: size (px), font, color, prefix (markup such as
//                     '<i>' — commentary is italic by default, '' turns it off),
//                     lineHeight (em; also commentaryseparation for a
//                     multi-line commentary), padding.
const CHANT_STYLE = {
  commentaryRaise: 0,
  textStyles: {
    // commentary: { size: 13, color: '#555' },
  },
};

function applyChantStyle(ctxt) {
  if (CHANT_STYLE.commentaryRaise != null) ctxt.commentaryRaise = CHANT_STYLE.commentaryRaise;
  for (const [type, style] of Object.entries(CHANT_STYLE.textStyles)) {
    if (ctxt.textStyles[type]) Object.assign(ctxt.textStyles[type], style);
  }
}

// The full GABC to engrave: `header` (the API's *gabc_header field), if given,
// goes in front of `gabc` unless `gabc` already has a header of its own.
function fullGabc(gabc, header) {
  gabc = (gabc || '').trim();
  if (!header || gabc.includes('%%')) return gabc;
  return header.trim() + '\n%%\n' + gabc;
}

// Draw a chant into `container`.
//   gabc       — GABC body or full GABC file. The header is no longer stripped:
//                exsurge reads it, and Gabc.applyHeader() applies the annotation,
//                mode, staff-lines, language and commentary, as Gregorio does.
//                API *gabc_body fields already include gabc_verses (verses
//                2..n in notation), so these engrave as one score, as on GregoBase.
//   versesHtml — optional API *verses_html field: the chant's tex_verses
//                (text-only verses GregoBase sets below the score), already
//                converted to safe HTML server-side. Appended under the SVG.
//   header     — optional API *gabc_header field, for a `gabc` that is only a body.
function renderGabc(gabc, container, versesHtml, header) {
  if (!container) return;
  if (typeof exsurge === 'undefined') {
    container.innerHTML = '<em class="render-note">exsurge not loaded — check network</em>';
    return;
  }
  const full = fullGabc(gabc, header);
  if (!hasGabcBody(full)) {
    container.innerHTML = '<em class="render-note">No notation</em>';
    return;
  }
  container.innerHTML = '<em class="render-note">Rendering…</em>';
  // rAF so the container is laid out and its width is valid
  requestAnimationFrame(() => {
    const rect = container.getBoundingClientRect();
    const w = Math.max((rect.width || container.clientWidth || 700) - 32, 260);
    const fail = (what, err) => {
      container.innerHTML =
        `<em class="render-note error">${what} error: ${_chantEscape(err && err.message)}</em>`;
    };
    try {
      const ctxt = new exsurge.ChantContext();
      // Phones: scale notation and lyrics down (exsurge defaults: 1/16 glyph scaling, 16px font)
      if (window.matchMedia('(max-width: 760px)').matches) {
        ctxt.setGlyphScaling((1 / 16) * 0.8);
        ctxt.setFont("'Palatino Linotype', 'Book Antiqua', Palatino, serif", 13);
      }
      applyChantStyle(ctxt);
      const mappings = exsurge.Gabc.createMappingsFromSource(ctxt, full);
      const score = new exsurge.ChantScore(ctxt, mappings, true);
      // A stale cached page can still load the pre-fork exsurge (no applyHeader); render without header settings then
      if (typeof exsurge.Gabc.applyHeader === 'function') {
        exsurge.Gabc.applyHeader(score, ctxt, new exsurge.GabcHeader(full));
      }
      score.performLayout(ctxt);
      score.layoutChantLines(ctxt, w, () => {
        try {
          container.innerHTML = score.createSvg(ctxt) +
            (versesHtml ? `<div class="tex-verses">${versesHtml}</div>` : '');
        } catch (err) {
          fail('Draw', err);
        }
      });
    } catch (err) {
      fail('Render', err);
    }
  });
}

function _chantEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
