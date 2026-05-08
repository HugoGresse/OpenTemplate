'use strict';

const KEY_STORAGE = 'opentemplate_api_key';
const LIVE_STORAGE = 'opentemplate_live_preview';
const LAYOUT_STORAGE = 'opentemplate_layout';

const EDITOR_BLOCKS = ['html', 'css', 'data'];
const $ = (id) => document.getElementById(id);

const LIVE_PREVIEW_DEBOUNCE_MS = 800;

// ---------- toast ----------

function toast(message, kind = 'info', ttl = 4000) {
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => el.classList.add('toast-leave'), ttl - 250);
  setTimeout(() => el.remove(), ttl);
}

// ---------- API helpers ----------

function authHeaders() {
  const key = localStorage.getItem(KEY_STORAGE) ?? '';
  return key ? { 'x-api-key': key } : {};
}

async function api(path, opts = {}) {
  const headers = {
    ...(opts.body ? { 'content-type': 'application/json' } : {}),
    ...authHeaders(),
    ...(opts.headers ?? {})
  };
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) toast('Auth required — set the App API key.', 'error');
  return res;
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function escapeAttr(s) {
  return escapeHtml(s);
}

// ---------- client-side Mustache subset ----------
// Mirrors server src/utils/interpolate.ts so design-mode preview matches the
// rendered output. Subset: {{var}} (escaped + nl2br), {{{var}}} (raw),
// dotted-path keys. NO sections, partials, lambdas.

function getDataValue(data, path) {
  const parts = path.trim().split('.');
  let cur = data;
  for (const p of parts) {
    if (cur == null) return '';
    cur = cur[p];
  }
  return cur ?? '';
}

function escapeForMustache(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\//g, '&#x2F;')
    .replace(/`/g, '&#x60;')
    .replace(/=/g, '&#x3D;')
    .replace(/\r\n|\r|\n/g, '<br />');
}

function clientInterpolate(template, data) {
  if (!template) return '';
  // Single pass with alternation — triple brace tried first because it's
  // listed first and the regex engine evaluates alternatives left-to-right.
  return template.replace(
    /\{\{\{\s*([^}]+?)\s*\}\}\}|\{\{\s*([^}]+?)\s*\}\}/g,
    (_, rawKey, escKey) => {
      if (rawKey !== undefined) return String(getDataValue(data, rawKey));
      return escapeForMustache(getDataValue(data, escKey));
    }
  );
}

function getCurrentData() {
  const raw = editor.data.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    /* ignore — design mode just shows {{var}} literals if JSON is bad */
  }
  return {};
}

// ---------- Monaco ----------

const monacoEditors = { html: null, css: null, data: null };
let monacoReady = false;

function loadMonaco() {
  return new Promise((resolve, reject) => {
    /* global require */
    if (typeof require === 'undefined') {
      reject(new Error('Monaco loader script missing'));
      return;
    }
    require.config({ paths: { vs: 'vendor/monaco/vs' } });
    self.MonacoEnvironment = {
      getWorkerUrl: () => 'vendor/monaco/vs/base/worker/workerMain.js'
    };
    require(['vs/editor/editor.main'], () => {
      if (!self.monaco) reject(new Error('Monaco failed to load'));
      else resolve(self.monaco);
    });
  });
}

function createEditors(monaco) {
  const common = {
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    theme: 'vs-dark',
    fontSize: 13,
    tabSize: 2,
    wordWrap: 'on',
    formatOnPaste: true,
    formatOnType: false,
    bracketPairColorization: { enabled: true },
    scrollbar: { useShadows: false }
  };
  monacoEditors.html = monaco.editor.create($('ed-html'), {
    ...common,
    language: 'html',
    value: ''
  });
  monacoEditors.css = monaco.editor.create($('ed-css'), {
    ...common,
    language: 'css',
    value: ''
  });
  monacoEditors.data = monaco.editor.create($('ed-data'), {
    ...common,
    language: 'json',
    value: '{}'
  });

  for (const ed of Object.values(monacoEditors)) {
    ed.onDidChangeModelContent(() => scheduleLivePreview());
  }
}

const editor = {
  get html() {
    return monacoEditors.html?.getValue() ?? '';
  },
  set html(v) {
    monacoEditors.html?.setValue(v ?? '');
  },
  get css() {
    return monacoEditors.css?.getValue() ?? '';
  },
  set css(v) {
    monacoEditors.css?.setValue(v ?? '');
  },
  get data() {
    return monacoEditors.data?.getValue() ?? '{}';
  },
  set data(v) {
    monacoEditors.data?.setValue(v ?? '{}');
  }
};

// Format buttons — wired up after Monaco loads
function wireFormatButtons() {
  document.querySelectorAll('[data-format]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const which = btn.getAttribute('data-format');
      const ed = monacoEditors[which];
      if (!ed) return;
      ed.focus();
      const action = ed.getAction('editor.action.formatDocument');
      if (action) void action.run();
    });
  });
}

// ---------- editor block layout (collapse / focus) ----------

function relayoutMonaco() {
  // Monaco has automaticLayout: true (ResizeObserver), but a manual call
  // ensures it picks up the new dimensions in the same frame as the CSS class
  // change. Cheap, idempotent.
  for (const which of EDITOR_BLOCKS) {
    monacoEditors[which]?.layout();
  }
}

function saveLayout() {
  const state = {};
  for (const which of EDITOR_BLOCKS) {
    const block = $('block-' + which);
    if (!block) continue;
    state[which] = {
      collapsed: block.classList.contains('collapsed'),
      focused: block.classList.contains('focused')
    };
  }
  try {
    localStorage.setItem(LAYOUT_STORAGE, JSON.stringify(state));
  } catch {
    /* ignore quota errors */
  }
}

function loadLayout() {
  let state;
  try {
    state = JSON.parse(localStorage.getItem(LAYOUT_STORAGE) ?? '{}');
  } catch {
    state = {};
  }
  for (const which of EDITOR_BLOCKS) {
    const block = $('block-' + which);
    if (!block) continue;
    const s = state[which];
    if (!s) continue;
    if (s.collapsed) block.classList.add('collapsed');
    if (s.focused) block.classList.add('focused');
  }
  // If multiple were marked focused (state corruption), keep only the first
  const focused = document.querySelectorAll('.editor-block.focused');
  if (focused.length > 1) {
    [...focused].slice(1).forEach((b) => b.classList.remove('focused'));
  }
}

function toggleCollapse(which) {
  const block = $('block-' + which);
  if (!block) return;
  block.classList.toggle('collapsed');
  // Collapsing kills focus — they're contradictory states
  if (block.classList.contains('collapsed')) block.classList.remove('focused');
  saveLayout();
  relayoutMonaco();
}

function toggleFocus(which) {
  const block = $('block-' + which);
  if (!block) return;
  const wasFocused = block.classList.contains('focused');
  // Clear focus on every block first
  document.querySelectorAll('.editor-block').forEach((b) => b.classList.remove('focused'));
  if (wasFocused) {
    // Toggling off: also restore other blocks (un-collapse those we auto-collapsed)
    document.querySelectorAll('.editor-block').forEach((b) => b.classList.remove('collapsed'));
  } else {
    block.classList.add('focused');
    block.classList.remove('collapsed');
    // Auto-collapse the others to give the focused one room
    for (const other of EDITOR_BLOCKS) {
      if (other === which) continue;
      $('block-' + other)?.classList.add('collapsed');
    }
  }
  saveLayout();
  relayoutMonaco();
}

function wireLayoutButtons() {
  document.querySelectorAll('[data-collapse]').forEach((btn) => {
    btn.addEventListener('click', () => toggleCollapse(btn.getAttribute('data-collapse')));
  });
  document.querySelectorAll('[data-focus]').forEach((btn) => {
    btn.addEventListener('click', () => toggleFocus(btn.getAttribute('data-focus')));
  });
}

// ---------- settings ----------

function loadSettings() {
  const k = localStorage.getItem(KEY_STORAGE);
  if (k) $('apiKey').value = k;
  const livePref = localStorage.getItem(LIVE_STORAGE);
  if (livePref !== null) $('livePreview').checked = livePref === 'true';
}

$('saveKey').addEventListener('click', () => {
  localStorage.setItem(KEY_STORAGE, $('apiKey').value.trim());
  toast('Saved.', 'info', 1500);
  void refreshTemplateList();
});

$('livePreview').addEventListener('change', () => {
  localStorage.setItem(LIVE_STORAGE, String($('livePreview').checked));
  if ($('livePreview').checked) scheduleLivePreview();
});

// ---------- preview ----------

function getRenderBody() {
  let data = {};
  const raw = editor.data.trim();
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error('Invalid JSON in data field');
    }
  }
  return {
    html: editor.html,
    css: editor.css || undefined,
    data,
    width: Number($('tplWidth').value) || 1200,
    height: Number($('tplHeight').value) || 630,
    engine: $('tplEngine').value
  };
}

let inFlightPreview = null;
function setSpinner(visible) {
  $('previewSpinner').hidden = !visible;
}

async function previewWithEndpoint(endpoint, kind) {
  if (designMode.active) return; // suspend live render while user is dragging
  if (inFlightPreview) inFlightPreview.abort();
  const ctrl = new AbortController();
  inFlightPreview = ctrl;
  setSpinner(true);

  try {
    const body = getRenderBody();
    const res = await api(endpoint, {
      method: 'POST',
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    if (ctrl.signal.aborted) return;
    if (!res.ok) {
      if (res.status === 429) {
        $('previewMeta').textContent = 'rate limited — slow down or disable live preview';
        return;
      }
      const errBody = await safeJson(res);
      throw new Error(errBody?.message ?? `${res.status}`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const engine = res.headers.get('x-engine') ?? 'unknown';
    const fallback = res.headers.get('x-fallback-reason');
    const inlined = res.headers.get('x-assets-inlined');
    const skipped = res.headers.get('x-assets-skipped');
    const skipDetail = res.headers.get('x-assets-skip-detail');
    const meta = [`engine: ${engine}`];
    if (inlined && inlined !== '0') meta.push(`inlined: ${inlined}`);
    if (skipped) {
      let s = `skipped: ${skipped}`;
      if (skipDetail) {
        try { s += ` (${decodeURIComponent(skipDetail)})`; } catch (_) {}
      }
      meta.push(s);
    }
    if (fallback) meta.push(`fallback: ${decodeURIComponent(fallback)}`);
    $('previewMeta').textContent = meta.join(' · ');
    if (kind === 'pdf') $('preview').innerHTML = `<iframe src="${url}"></iframe>`;
    else $('preview').innerHTML = `<img src="${url}" alt="preview" />`;
  } catch (err) {
    if (err.name === 'AbortError') return;
    toast(`Preview failed: ${err.message}`, 'error', 6000);
  } finally {
    if (inFlightPreview === ctrl) inFlightPreview = null;
    setSpinner(false);
  }
}

$('previewBtn').addEventListener('click', () => previewWithEndpoint('/render/png', 'png'));
$('pdfBtn').addEventListener('click', () => previewWithEndpoint('/render/pdf', 'pdf'));

// ---------- live preview ----------

let liveTimer = null;
function scheduleLivePreview() {
  if (!monacoReady) return;
  if (designMode.active) return;
  if (!$('livePreview').checked) return;
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => previewWithEndpoint('/render/png', 'png'), LIVE_PREVIEW_DEBOUNCE_MS);
}

for (const id of ['tplWidth', 'tplHeight', 'tplEngine']) {
  $(id).addEventListener('input', scheduleLivePreview);
  $(id).addEventListener('change', scheduleLivePreview);
}

// ---------- bundle download ----------

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const len = bin.length;
  const arr = new Uint8Array(len);
  for (let i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type });
}

$('bundleBtn').addEventListener('click', async () => {
  $('bundleBtn').disabled = true;
  setSpinner(true);
  try {
    const body = getRenderBody();
    const res = await api('/render/bundle', { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) {
      const errBody = await safeJson(res);
      throw new Error(errBody?.message ?? `${res.status}`);
    }
    const json = await res.json();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const baseName = ($('tplName').value || 'template').replace(/[^a-z0-9_-]+/gi, '_');
    downloadBlob(`${baseName}-${stamp}.png`, base64ToBlob(json.png, 'image/png'));
    downloadBlob(`${baseName}-${stamp}.pdf`, base64ToBlob(json.pdf, 'application/pdf'));
    toast(`Bundle ready (png:${json.engineUsed.png}, pdf:${json.engineUsed.pdf}).`, 'success');
  } catch (err) {
    toast(`Bundle failed: ${err.message}`, 'error', 6000);
  } finally {
    $('bundleBtn').disabled = false;
    setSpinner(false);
  }
});

// ---------- API call snippet modal ----------

function buildSnippet(kind) {
  const origin = location.origin;
  const apiKey = localStorage.getItem(KEY_STORAGE) ?? '<APP_API_KEY>';
  let body;
  try {
    body = getRenderBody();
  } catch (err) {
    return `# error: ${err.message}`;
  }
  const tplId = $('tplList').value;

  const formatBody = (b) => JSON.stringify(b, null, 2);

  if (kind === 'bundle-stored') {
    if (!tplId) {
      return '# Save the template first, then select it from the list to use this snippet.';
    }
    const data = body.data ?? {};
    return [
      `curl -X POST "${origin}/render/${tplId}/bundle" \\`,
      `  -H "x-api-key: ${apiKey}" \\`,
      `  -H "content-type: application/json" \\`,
      `  -d '${formatBody({ data }).replace(/'/g, "'\\''")}'`,
      ``,
      `# Response: { png: base64, pdf: base64, engineUsed: {...}, width, height }`
    ].join('\n');
  }

  const path =
    kind === 'pdf' ? '/render/pdf' : kind === 'bundle' ? '/render/bundle' : '/render/png';
  const note =
    kind === 'bundle'
      ? '# Response is JSON — base64 png + base64 pdf'
      : kind === 'pdf'
        ? '# Response is application/pdf — write to file'
        : '# Response is image/png — write to file';
  const out =
    kind === 'pdf' ? ' -o out.pdf' : kind === 'bundle' ? ' -o bundle.json' : ' -o out.png';

  return [
    `curl -X POST "${origin}${path}"${out} \\`,
    `  -H "x-api-key: ${apiKey}" \\`,
    `  -H "content-type: application/json" \\`,
    `  -d '${formatBody(body).replace(/'/g, "'\\''")}'`,
    ``,
    note
  ].join('\n');
}

let activeSnippetTab = 'png';
function refreshSnippet() {
  $('snippetCode').textContent = buildSnippet(activeSnippetTab);
}

$('snippetBtn').addEventListener('click', () => {
  activeSnippetTab = 'png';
  document.querySelectorAll('#snippetModal .tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === activeSnippetTab);
  });
  refreshSnippet();
  $('snippetModal').hidden = false;
});

document.querySelectorAll('#snippetModal .tab').forEach((t) => {
  t.addEventListener('click', () => {
    activeSnippetTab = t.dataset.tab;
    document.querySelectorAll('#snippetModal .tab').forEach((x) => {
      x.classList.toggle('active', x === t);
    });
    refreshSnippet();
  });
});

$('snippetClose').addEventListener('click', () => {
  $('snippetModal').hidden = true;
});

$('snippetModal').addEventListener('click', (e) => {
  if (e.target === $('snippetModal')) $('snippetModal').hidden = true;
});

$('snippetCopy').addEventListener('click', async () => {
  const text = $('snippetCode').textContent ?? '';
  try {
    await navigator.clipboard.writeText(text);
    $('snippetStatus').textContent = 'copied to clipboard';
    setTimeout(() => ($('snippetStatus').textContent = ''), 2000);
  } catch {
    $('snippetStatus').textContent = 'copy failed (clipboard blocked)';
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('snippetModal').hidden) $('snippetModal').hidden = true;
});

// ---------- design mode (drag elements in preview) ----------

const OTID_ATTR = 'data-otid';
const DESIGN_BLOCK_MARKER = '/* design-mode positions */';

const designMode = {
  active: false,
  iframe: null,
  positions: {} // { otid: { x, y } } cumulative
};

const DESIGN_OVERLAY_CSS = `
[${OTID_ATTR}] {
  outline: 1px dashed rgba(30,136,229,0.4) !important;
  cursor: move !important;
  user-select: none !important;
  pointer-events: auto !important;
  touch-action: none;
}
[${OTID_ATTR}]:hover { outline-color: #1e88e5 !important; }
[${OTID_ATTR}].ot-active { outline: 2px solid #1e88e5 !important; outline-offset: 2px !important; }
`;

function ensureOtIds(html) {
  const doc = new DOMParser().parseFromString(`<div id="__root">${html}</div>`, 'text/html');
  const root = doc.getElementById('__root');
  if (!root) return { html, changed: false };
  let counter = 1;
  let changed = false;
  // Find max existing otid to avoid collisions
  root.querySelectorAll(`[${OTID_ATTR}]`).forEach((el) => {
    const v = el.getAttribute(OTID_ATTR);
    const m = /^el(\d+)$/.exec(v ?? '');
    if (m) counter = Math.max(counter, Number(m[1]) + 1);
  });
  root.querySelectorAll('*').forEach((el) => {
    if (!el.hasAttribute(OTID_ATTR)) {
      el.setAttribute(OTID_ATTR, `el${counter++}`);
      changed = true;
    }
  });
  return { html: root.innerHTML, changed };
}

function parseExistingPositions(css) {
  // Pull positions from a previous design-mode run. Handles both transform
  // and pos (left/top) variants. Returns map otid → { mode, dx, dy, baseLeft, baseTop }.
  const positions = {};
  const idx = css.indexOf(DESIGN_BLOCK_MARKER);
  if (idx < 0) return positions;
  const block = css.slice(idx);
  // /* otid: el1 mode: pos baseLeft: 86 baseTop: 189 dx: 15 dy: 30 */
  const re = /\/\*\s*otid:\s*([^\s]+)\s+mode:\s*(pos|translate)(?:\s+baseLeft:\s*(-?\d+(?:\.\d+)?))?(?:\s+baseTop:\s*(-?\d+(?:\.\d+)?))?\s+dx:\s*(-?\d+(?:\.\d+)?)\s+dy:\s*(-?\d+(?:\.\d+)?)\s*\*\//g;
  let m;
  while ((m = re.exec(block)) !== null) {
    positions[m[1]] = {
      mode: m[2],
      baseLeft: m[3] !== undefined ? Number(m[3]) : 0,
      baseTop: m[4] !== undefined ? Number(m[4]) : 0,
      dx: Number(m[5]),
      dy: Number(m[6])
    };
  }
  return positions;
}

function stripDesignBlock(css) {
  const idx = css.indexOf(DESIGN_BLOCK_MARKER);
  if (idx < 0) return css;
  return css.slice(0, idx).replace(/\s+$/, '') + '\n';
}

function buildDesignDocument(html, css, width, height) {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { width: ${width}px; height: ${height}px; overflow: hidden; }
  ${css ?? ''}
  ${DESIGN_OVERLAY_CSS}
</style>
</head>
<body>${html}<script src="design-runtime.js"></script></body></html>`;
}

$('designBtn').addEventListener('click', () => {
  if (designMode.active) return;
  enterDesignMode();
});

$('designCancelBtn').addEventListener('click', () => {
  exitDesignMode(false);
});

$('designApplyBtn').addEventListener('click', () => {
  if (!designMode.iframe) return;
  // Ask iframe for its latest positions
  designMode.iframe.contentWindow.postMessage({ type: 'ot:getPositions' }, '*');
});

window.addEventListener('message', (e) => {
  // Only handle our own protocol; ignore everything else (Monaco workers, etc.)
  const data = e.data || {};
  if (!designMode.active) return;
  if (data.type === 'ot:ready') {
    // Iframe runtime booted — push initial positions so prior drags compose
    designMode.iframe?.contentWindow?.postMessage(
      { type: 'ot:init', positions: designMode.positions },
      '*'
    );
    return;
  }
  if (data.type === 'ot:positions') {
    applyPositionsToCss(data.payload || {});
    exitDesignMode(true);
    return;
  }
  if (data.type === 'ot:drag') {
    $('previewMeta').textContent =
      `Design mode — ${data.otid} (${data.mode}) Δ(${data.dx}, ${data.dy}). Drag, then Apply. Double-click resets.`;
    return;
  }
  if (data.type === 'ot:dragEnd') return;
  if (data.type === 'ot:reset') {
    $('previewMeta').textContent = `Design mode — reset ${data.otid}.`;
    return;
  }
});

function enterDesignMode() {
  if (!editor.html.trim()) {
    toast('Add some HTML first.', 'error');
    return;
  }
  // Tag elements with stable ids if missing
  const { html, changed } = ensureOtIds(editor.html);
  if (changed) editor.html = html;

  // Seed positions from existing CSS so subsequent drags compose
  designMode.positions = parseExistingPositions(editor.css);

  const width = Number($('tplWidth').value) || 1200;
  const height = Number($('tplHeight').value) || 630;

  // Strip the existing design-mode block before handing CSS to the iframe.
  // Those rules use !important and would override the runtime's inline
  // style.left/top, breaking drag on a previously-positioned element.
  // The runtime re-applies the captured deltas via inline style on boot.
  const cssForIframe = stripDesignBlock(editor.css ?? '');

  // Interpolate Mustache placeholders against the JSON pane so design mode
  // shows what the user actually authored, not raw {{var}} strings.
  const data = getCurrentData();
  const interpolatedHtml = clientInterpolate(html, data);
  const interpolatedCss = clientInterpolate(cssForIframe, data);

  const doc = buildDesignDocument(interpolatedHtml, interpolatedCss, width, height);

  const iframe = document.createElement('iframe');
  iframe.className = 'design-frame';
  // allow-same-origin is required so parent CSP `script-src 'self'` matches
  // the iframe's origin and the design-runtime.js script can load. Trust
  // model: the rendered HTML is the user's own template, not an attacker's
  // payload, so dropping the cross-origin sandbox here is acceptable.
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  iframe.setAttribute('srcdoc', doc);
  iframe.style.width = '100%';
  iframe.style.height = '100%';

  $('preview').innerHTML = '';
  $('preview').appendChild(iframe);
  designMode.iframe = iframe;
  designMode.active = true;

  $('designBtn').hidden = true;
  $('designApplyBtn').hidden = false;
  $('designCancelBtn').hidden = false;
  $('previewMeta').textContent = 'Design mode — click and drag elements. Apply to commit positions.';
  toast('Design mode active. Drag elements, then Apply.', 'info', 4000);
}

function exitDesignMode(applied) {
  designMode.active = false;
  designMode.iframe = null;
  $('designBtn').hidden = false;
  $('designApplyBtn').hidden = true;
  $('designCancelBtn').hidden = true;
  $('preview').innerHTML = '';
  $('previewMeta').textContent = applied ? 'Positions applied.' : '';
  if (applied) scheduleLivePreview();
}

function applyPositionsToCss(positions) {
  const dirty = Object.values(positions).some((p) => Math.round(p.dx) !== 0 || Math.round(p.dy) !== 0);
  if (!dirty) {
    toast('No moves to apply.', 'info', 1500);
    return;
  }
  let css = stripDesignBlock(editor.css ?? '');
  if (css && !css.endsWith('\n')) css += '\n';
  css += `\n${DESIGN_BLOCK_MARKER}\n`;
  for (const [otid, pos] of Object.entries(positions)) {
    const dx = Math.round(pos.dx);
    const dy = Math.round(pos.dy);
    if (dx === 0 && dy === 0) continue;
    if (pos.mode === 'pos') {
      const left = Math.round(pos.baseLeft + dx);
      const top = Math.round(pos.baseTop + dy);
      // Comment carries the metadata so we can resume the next session
      css += `/* otid: ${otid} mode: pos baseLeft: ${pos.baseLeft} baseTop: ${pos.baseTop} dx: ${dx} dy: ${dy} */\n`;
      css += `[data-otid="${otid}"] { left: ${left}px !important; top: ${top}px !important; }\n`;
    } else {
      css += `/* otid: ${otid} mode: translate dx: ${dx} dy: ${dy} */\n`;
      css += `[data-otid="${otid}"] { transform: translate(${dx}px, ${dy}px) !important; }\n`;
    }
  }
  editor.css = css;
  designMode.positions = positions;
  toast('Positions written to CSS.', 'success', 2500);
}

// ---------- templates ----------

async function refreshTemplateList() {
  try {
    const res = await api('/templates?limit=200');
    if (!res.ok) throw new Error(`list ${res.status}`);
    const json = await res.json();
    const list = json.items ?? [];
    const sel = $('tplList');
    const current = sel.value;
    sel.innerHTML =
      '<option value="">— pick template —</option>' +
      list
        .map((t) => `<option value="${escapeAttr(t.id)}">${escapeHtml(t.name)} (${t.id})</option>`)
        .join('');
    if (current && [...sel.options].some((o) => o.value === current)) sel.value = current;
  } catch (err) {
    console.error('refresh list failed', err);
  }
}

$('saveTplBtn').addEventListener('click', async () => {
  const name = $('tplName').value.trim() || 'untitled';
  let sampleData;
  const rawData = editor.data.trim();
  if (rawData) {
    try {
      const parsed = JSON.parse(rawData);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        sampleData = parsed;
      }
    } catch {
      return toast('Data field is not valid JSON — fix it before saving.', 'error', 6000);
    }
  }
  const payload = {
    name,
    html: editor.html,
    css: editor.css || undefined,
    width: Number($('tplWidth').value) || 1200,
    height: Number($('tplHeight').value) || 630,
    engine: $('tplEngine').value,
    sampleData
  };
  if (!payload.html) return toast('HTML cannot be empty.', 'error');
  if (payload.sampleData === undefined) delete payload.sampleData;
  const selected = $('tplList').value;
  const url = selected ? `/templates/${selected}` : '/templates';
  const method = selected ? 'PUT' : 'POST';
  try {
    const res = await api(url, { method, body: JSON.stringify(payload) });
    if (!res.ok) {
      const errBody = await safeJson(res);
      throw new Error(errBody?.message ?? `${res.status}`);
    }
    const saved = await res.json();
    await refreshTemplateList();
    $('tplList').value = saved.id;
    toast(`Saved as ${saved.id}`, 'success');
  } catch (err) {
    toast(`Save failed: ${err.message}`, 'error', 6000);
  }
});

$('loadTplBtn').addEventListener('click', async () => {
  const id = $('tplList').value;
  if (!id) return;
  try {
    const res = await api(`/templates/${id}`);
    if (!res.ok) throw new Error(`${res.status}`);
    const t = await res.json();
    $('tplName').value = t.name ?? '';
    editor.html = t.html ?? '';
    editor.css = t.css ?? '';
    editor.data = t.sampleData ? JSON.stringify(t.sampleData, null, 2) : '{}';
    $('tplWidth').value = t.width ?? 1200;
    $('tplHeight').value = t.height ?? 630;
    $('tplEngine').value = t.engine ?? 'auto';
    toast(`Loaded ${id}`, 'info', 1500);
    scheduleLivePreview();
  } catch (err) {
    toast(`Load failed: ${err.message}`, 'error');
  }
});

$('delTplBtn').addEventListener('click', async () => {
  const id = $('tplList').value;
  if (!id) return;
  if (!confirm(`Delete template ${id}?`)) return;
  try {
    const res = await api(`/templates/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`${res.status}`);
    await refreshTemplateList();
    $('tplList').value = '';
    toast('Deleted.', 'info', 1500);
  } catch (err) {
    toast(`Delete failed: ${err.message}`, 'error');
  }
});

$('newTplBtn').addEventListener('click', () => {
  if (!confirm('Clear current editor state?')) return;
  $('tplList').value = '';
  $('tplName').value = '';
  editor.html = '';
  editor.css = '';
  editor.data = '{}';
  $('tplWidth').value = 1200;
  $('tplHeight').value = 630;
  $('tplEngine').value = 'auto';
  $('preview').innerHTML = '';
  $('previewMeta').textContent = '';
});

// ---------- boot ----------

loadSettings();
void refreshTemplateList();
loadMonaco()
  .then((monaco) => {
    createEditors(monaco);
    wireFormatButtons();
    wireLayoutButtons();
    loadLayout();
    relayoutMonaco();
    monacoReady = true;
  })
  .catch((err) => {
    console.error('Monaco load failed', err);
    toast('Editor failed to load — check /editor/vendor/monaco assets.', 'error', 8000);
  });
