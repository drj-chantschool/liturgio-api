// ── Shared chant renderer ─────────────────────────────────────────────────────
// The one place chant notation is drawn. Every page that shows a score loads
// this after exsurge.min.js and before its own script:
//
//   <script src="https://cdn.jsdelivr.net/gh/bbloomf/exsurge@v1.24.2/dist/exsurge.min.js"></script>
//   <script src="/static/chant-render.js"></script>
//
// Styles (.render-note, .tex-verses) live in style.css.

// GABC body: everything after the last '%%' header separator, or the whole
// text if there is no header.
function extractGabcBody(gabc) {
  if (!gabc) return '';
  const parts = gabc.split('%%');
  return parts.length > 1 ? parts[parts.length - 1].trim() : gabc.trim();
}

// Header fields (annotation, commentary, ...) of a full GABC file, as an
// object; {} when there is no '%%' header.
function extractGabcHeader(gabc) {
  const hdr = {};
  const parts = (gabc || '').split('%%');
  if (parts.length < 2) return hdr;
  for (const m of parts[0].matchAll(/^\s*([\w-]+)\s*:\s*([^;]*?)\s*;/gm)) {
    if (!(m[1] in hdr)) hdr[m[1]] = m[2];
  }
  return hdr;
}

// Gregorio TeX macros that exsurge cannot interpret. \greheightstar is the
// raised psalm-tone star; draw it as a plain '*'.
function _chantCleanBody(body) {
  return body.replace(/\\greheightstar\s*(\{\})?/g, '*');
}

// Draw a chant into `container`.
//   gabc       — GABC body or full GABC file (the header is stripped).
//                API *gabc_body fields already include gabc_verses (verses
//                2..n in notation), so these engrave as one score, as on GregoBase.
//   meta       — optional {annotation, commentary} overriding the header
//                (needed when `gabc` is an API body with no header).
//   versesHtml — optional API *verses_html field: the chant's tex_verses
//                (text-only verses GregoBase sets below the score), already
//                converted to safe HTML server-side. Appended under the SVG.
function renderGabc(gabc, container, versesHtml, meta) {
  if (!container) return;
  if (typeof exsurge === 'undefined') {
    container.innerHTML = '<em class="render-note">exsurge not loaded — check network</em>';
    return;
  }
  const body = _chantCleanBody(extractGabcBody(gabc));
  const hdr = Object.assign(extractGabcHeader(gabc), meta || {});
  if (!body) {
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
      const mappings = exsurge.Gabc.createMappingsFromSource(ctxt, body);
      const score = new exsurge.ChantScore(ctxt, mappings, true);
      if (hdr.annotation) {
        score.annotation = new exsurge.Annotation(ctxt, _chantCleanBody(hdr.annotation));
      }
      score.performLayout(ctxt);
      score.layoutChantLines(ctxt, w, () => {
        try {
          container.innerHTML =
            (hdr.commentary
              ? `<div class="chant-commentary">${_chantEscape(_chantCleanBody(hdr.commentary))}</div>`
              : '') +
            score.createSvg(ctxt) +
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
