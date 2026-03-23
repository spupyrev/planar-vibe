(function (global) {
  'use strict';

  function applyPositionsToCy(cy, nodeIds, posById) {
    var nodes = cy.nodes().toArray();
    for (var i = 0; i < nodes.length; i += 1) {
      var id = String(nodes[i].id());
      if (posById[id]) {
        nodes[i].position(posById[id]);
      }
    }
  }

  function applyAndFit(cy, nodeIds, posById, fitPadding) {
    applyPositionsToCy(cy, nodeIds, posById);
    cy.fit(undefined, Number.isFinite(fitPadding) ? fitPadding : 24);
  }

  function waitForNextFrame(delayMs) {
    var delay = Math.max(0, Number(delayMs) || 0);
    return new Promise(function (resolve) {
      var schedule = (typeof global.setTimeout === 'function')
        ? global.setTimeout.bind(global)
        : (typeof setTimeout === 'function' ? setTimeout : null);
      if (!schedule) {
        resolve();
        return;
      }
      schedule(function () {
        var raf = (typeof global.requestAnimationFrame === 'function')
          ? global.requestAnimationFrame.bind(global)
          : (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null);
        if (raf) {
          raf(function () { resolve(); });
        } else {
          resolve();
        }
      }, delay);
    });
  }

  function createIncrementalRenderer(config) {
    var cy = config.cy;
    var nodeIds = Array.isArray(config.nodeIds) ? config.nodeIds.map(String) : [];
    var getPositions = typeof config.getPositions === 'function' ? config.getPositions : function () { return {}; };
    var interactive = config.interactive !== false;
    var delayMs = Math.max(0, Number(config.delayMs) || 0);
    var renderEvery = Number.isFinite(config.renderEvery) ? Math.max(1, Math.floor(config.renderEvery)) : 4;
    var yieldEvery = Number.isFinite(config.yieldEvery) ? Math.max(1, Math.floor(config.yieldEvery)) : 5;
    var fitPadding = Number.isFinite(config.fitPadding) ? Math.max(0, config.fitPadding) : 24;
    var didFit = false;

    function renderCurrent() {
      applyPositionsToCy(cy, nodeIds, getPositions());
    }

    function fitIfNeeded() {
      if (!didFit) {
        cy.fit(undefined, fitPadding);
        didFit = true;
      }
    }

    async function begin() {
      if (!interactive) {
        return;
      }
      renderCurrent();
      fitIfNeeded();
      await waitForNextFrame(delayMs);
    }

    async function onProgress(event, options) {
      var progress = event || {};
      var extra = options || {};
      var iter = Number.isFinite(progress.iter) ? progress.iter : null;
      var maxIters = Number.isFinite(progress.maxIters) ? progress.maxIters : null;
      var isRenderable = iter !== null && maxIters !== null &&
        (iter === 1 || iter === maxIters || (iter % renderEvery) === 0);
      var shouldYield = iter !== null && maxIters !== null &&
        (iter === maxIters || (iter % yieldEvery) === 0);

      if (interactive && isRenderable) {
        renderCurrent();
        fitIfNeeded();
        await waitForNextFrame(delayMs);
        return;
      }

      if ((extra.forceYield || delayMs > 0) && shouldYield) {
        await waitForNextFrame(delayMs);
      }
    }

    function finish() {
      renderCurrent();
      fitIfNeeded();
    }

    return {
      begin: begin,
      onProgress: onProgress,
      finish: finish,
      didFit: function () { return didFit; }
    };
  }

  global.PlanarVibeLayoutRuntime = {
    applyPositionsToCy: applyPositionsToCy,
    applyAndFit: applyAndFit,
    waitForNextFrame: waitForNextFrame,
    createIncrementalRenderer: createIncrementalRenderer
  };
})(window);
