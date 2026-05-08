'use strict';

// Runtime injected into the design-mode iframe. Lives as a stand-alone file
// so the parent's CSP `script-src 'self'` can load it without needing
// 'unsafe-inline' or per-request hashes.
//
// Two strategies for moving an element:
//  - position absolute/fixed → adjust `left`/`top` in px from the original
//    computed values
//  - everything else → CSS `transform: translate(...)`
// On apply, the parent writes the appropriate CSS rule with !important.

(function () {
  var OTID_ATTR = 'data-otid';
  var positions = {};
  var dragging = null;

  function px(v) {
    if (!v || v === 'auto') return 0;
    var n = parseFloat(v);
    return isFinite(n) ? n : 0;
  }

  function applyMove(el, entry) {
    if (entry.mode === 'pos') {
      el.style.left = (entry.baseLeft + entry.dx) + 'px';
      el.style.top = (entry.baseTop + entry.dy) + 'px';
    } else {
      el.style.transform = 'translate(' + entry.dx + 'px,' + entry.dy + 'px)';
    }
  }

  function captureBase(el, otid) {
    var cs = getComputedStyle(el);
    var mode = cs.position === 'absolute' || cs.position === 'fixed' ? 'pos' : 'translate';
    var existing = positions[otid];
    if (existing && existing.mode === mode) return existing;
    return {
      mode: mode,
      dx: existing ? existing.dx : 0,
      dy: existing ? existing.dy : 0,
      baseLeft: mode === 'pos' ? px(cs.left) : 0,
      baseTop: mode === 'pos' ? px(cs.top) : 0
    };
  }

  function reapplyAll() {
    Object.keys(positions).forEach(function (otid) {
      var el = document.querySelector('[' + OTID_ATTR + '="' + otid + '"]');
      if (el) applyMove(el, positions[otid]);
    });
  }

  function reportSelection() {
    if (!dragging || !dragging.entry) return;
    parent.postMessage(
      {
        type: 'ot:drag',
        otid: dragging.otid,
        dx: Math.round(dragging.entry.dx),
        dy: Math.round(dragging.entry.dy),
        mode: dragging.entry.mode
      },
      '*'
    );
  }

  document.addEventListener(
    'pointerdown',
    function (e) {
      var target = e.target && e.target.closest && e.target.closest('[' + OTID_ATTR + ']');
      if (!target) return;
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      var otid = target.getAttribute(OTID_ATTR);
      var entry = captureBase(target, otid);
      positions[otid] = entry;
      dragging = {
        el: target,
        otid: otid,
        startX: e.clientX,
        startY: e.clientY,
        dxStart: entry.dx,
        dyStart: entry.dy,
        entry: entry
      };
      if (target.setPointerCapture) {
        try {
          target.setPointerCapture(e.pointerId);
        } catch (_) {
          /* ignore */
        }
      }
      target.classList.add('ot-active');
      reportSelection();
    },
    true
  );

  document.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    dragging.entry.dx = e.clientX - dragging.startX + dragging.dxStart;
    dragging.entry.dy = e.clientY - dragging.startY + dragging.dyStart;
    applyMove(dragging.el, dragging.entry);
    reportSelection();
  });

  function endDrag() {
    if (!dragging) return;
    dragging.el.classList.remove('ot-active');
    dragging = null;
    parent.postMessage({ type: 'ot:dragEnd' }, '*');
  }
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);

  document.addEventListener('dblclick', function (e) {
    var target = e.target && e.target.closest && e.target.closest('[' + OTID_ATTR + ']');
    if (!target) return;
    var otid = target.getAttribute(OTID_ATTR);
    delete positions[otid];
    target.style.transform = '';
    target.style.left = '';
    target.style.top = '';
    parent.postMessage({ type: 'ot:reset', otid: otid }, '*');
  });

  window.addEventListener('message', function (e) {
    var data = e.data || {};
    if (data.type === 'ot:init') {
      positions = data.positions || {};
      reapplyAll();
      return;
    }
    if (data.type === 'ot:getPositions') {
      e.source.postMessage({ type: 'ot:positions', payload: positions }, e.origin || '*');
    }
  });

  // Tell the parent we've booted so it can push initial positions
  parent.postMessage({ type: 'ot:ready' }, '*');

  // eslint-disable-next-line no-console
  console.log(
    '[OpenTemplate design mode] runtime ready, ' +
      document.querySelectorAll('[' + OTID_ATTR + ']').length +
      ' draggable elements'
  );
})();
