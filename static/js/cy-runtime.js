(function (global) {
  'use strict';

  // Shared Cytoscape runtime layer for reading graph state, rendering progress,
  // and coordinating browser-side execution behavior for graph algorithms.

  var GraphUtils = global.GraphUtils;
  var LayoutPreprocessing = global.LayoutPreprocessing;
  function isDummyCyNode(node) {
    return !!(node && typeof node.hasClass === 'function' && node.hasClass('dummy-node'));
  }

  function graphFromCy(cy) {
    var nodes = cy.nodes().toArray ? cy.nodes().toArray() : cy.nodes();
    var filteredNodes = [];
    var keep = {};
    for (var i = 0; i < nodes.length; i += 1) {
      if (isDummyCyNode(nodes[i])) {
        continue;
      }
      var id = String(nodes[i].id());
      filteredNodes.push(id);
      keep[id] = true;
    }
    return GraphUtils.createGraph(
      filteredNodes,
      (cy.edges().toArray ? cy.edges().toArray() : cy.edges()).map(function (e) {
        return [String(e.source().id()), String(e.target().id())];
      }).filter(function (edge) {
        return keep[edge[0]] && keep[edge[1]];
      })
    );
  }

  function currentPositionsFromCy(cy) {
    var out = {};
    var nodes = cy.nodes().toArray ? cy.nodes().toArray() : cy.nodes();
    for (var i = 0; i < nodes.length; i += 1) {
      if (isDummyCyNode(nodes[i])) {
        continue;
      }
      var id = String(nodes[i].id());
      var p = nodes[i].position();
      out[id] = { x: p.x, y: p.y };
    }
    return out;
  }

  function captureViewportFromCy(cy) {
    if (!cy) {
      return null;
    }
    return {
      zoom: cy.zoom(),
      pan: cy.pan(),
      width: cy.width(),
      height: cy.height()
    };
  }

  function applyPositionsToCy(cy, posById) {
    var nodes = cy.nodes().toArray();
    for (var i = 0; i < nodes.length; i += 1) {
      var id = String(nodes[i].id());
      if (posById[id]) {
        nodes[i].position(posById[id]);
      }
    }
  }

  function applyViewportToCy(cy, viewport) {
    var vp = viewport || null;
    if (!cy || !vp) {
      return false;
    }
    if (!Number.isFinite(vp.zoom) || !vp.pan) {
      return false;
    }
    cy.zoom(vp.zoom);
    cy.pan(vp.pan);
    return true;
  }

  function restorePositionsToCy(cy, posById) {
    if (!cy || !posById) {
      return false;
    }
    var changed = false;
    var nodes = cy.nodes().toArray();
    for (var i = 0; i < nodes.length; i += 1) {
      var id = String(nodes[i].id());
      var p = posById[id];
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        nodes[i].position({ x: p.x, y: p.y });
        changed = true;
      }
    }
    return changed;
  }

  function fitCy(cy, fitPadding, bounds) {
    if (!cy || typeof cy.fit !== 'function') {
      return;
    }
    var padding = Number.isFinite(fitPadding) ? fitPadding : 24;
    if (bounds && Number.isFinite(bounds.x1) && Number.isFinite(bounds.y1) &&
        Number.isFinite(bounds.x2) && Number.isFinite(bounds.y2)) {
      cy.fit(bounds, padding);
      return;
    }
    cy.fit(undefined, padding);
  }

  function computePositionBounds(posById) {
    var ids = Object.keys(posById || {});
    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    for (var i = 0; i < ids.length; i += 1) {
      var p = posById[ids[i]];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        continue;
      }
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return null;
    }
    return { x1: minX, y1: minY, x2: maxX, y2: maxY };
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

  function resolveLayoutTimingOptions(options, defaults) {
    var opts = options || {};
    var cfg = defaults || {};
    return {
      delayMs: Number.isFinite(opts.delayMs)
        ? Math.max(0, opts.delayMs)
        : (Number.isFinite(cfg.delayMs) ? Math.max(0, cfg.delayMs) : 0),
      renderEvery: Number.isFinite(opts.renderEvery)
        ? Math.max(1, Math.floor(opts.renderEvery))
        : (Number.isFinite(cfg.renderEvery) ? Math.max(1, Math.floor(cfg.renderEvery)) : 2),
      yieldEvery: Number.isFinite(opts.yieldEvery)
        ? Math.max(1, Math.floor(opts.yieldEvery))
        : (Number.isFinite(cfg.yieldEvery) ? Math.max(1, Math.floor(cfg.yieldEvery)) : 5)
    };
  }

  function createLayoutRenderer(config) {
    var cy = config.cy;
    var getPositions = typeof config.getPositions === 'function' ? config.getPositions : function () { return {}; };
    var hasInitialPositions = typeof config.hasInitialPositions === 'function'
      ? config.hasInitialPositions
      : function () { return false; };
    var timing = resolveLayoutTimingOptions(config, {
      delayMs: 0,
      renderEvery: 2,
      yieldEvery: 5
    });
    var delayMs = timing.delayMs;
    var renderEvery = timing.renderEvery;
    var yieldEvery = timing.yieldEvery;
    var fitPadding = Number.isFinite(config.fitPadding) ? Math.max(0, config.fitPadding) : 24;
    var initialFitBounds = config.initialFitBounds || null;
    var didFit = false;

    function renderCurrent(fitIfFirstVisible) {
      applyPositionsToCy(cy, getPositions());
      if (fitIfFirstVisible && !didFit) {
        fitCy(cy, fitPadding, initialFitBounds);
        didFit = true;
      }
    }

    async function begin() {
      if (!hasInitialPositions()) {
        return;
      }
      renderCurrent(true);
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

      if (isRenderable) {
        renderCurrent(true);
        await waitForNextFrame(delayMs);
        return;
      }

      if ((extra.forceYield || delayMs > 0) && shouldYield) {
        await waitForNextFrame(delayMs);
      }
    }

    function finish() {
      renderCurrent(false);
    }

    return {
      begin: begin,
      onProgress: onProgress,
      finish: finish
    };
  }

  function syncOverlayInCy(cy, overlay) {
    if (!cy) {
      return;
    }
    cy.elements('.debug-overlay').remove();
    if (!overlay) {
      return;
    }
    var elements = [];
    var positionsById = overlay.positionsById || {};
    var labelsById = overlay.labelsById || {};
    var classesById = overlay.classesById || {};
    var edgePairs = Array.isArray(overlay.edgePairs) ? overlay.edgePairs : [];
    var edgeClassByKey = overlay.edgeClassByKey || {};
    var nodeIds = Object.keys(positionsById);
    var i;

    for (i = 0; i < nodeIds.length; i += 1) {
      var id = nodeIds[i];
      elements.push({
        data: {
          id: id,
          label: labelsById[id] !== undefined ? labelsById[id] : id
        },
        classes: classesById[id] || 'debug-overlay'
      });
    }
    for (i = 0; i < edgePairs.length; i += 1) {
      var source = String(edgePairs[i][0]);
      var target = String(edgePairs[i][1]);
      var edgeId = '__dbg__e' + i + '__' + source + '__' + target;
      elements.push({
        data: {
          id: edgeId,
          source: source,
          target: target
        },
        classes: edgeClassByKey[GraphUtils.edgeKey(source, target)] || 'debug-overlay'
      });
    }
    if (elements.length === 0) {
      return;
    }
    cy.add(elements);
    cy.nodes('.debug-overlay').forEach(function (node) {
      var p = positionsById[String(node.id())];
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        node.position({ x: p.x, y: p.y });
      }
    });
  }

  function runLayout(cy, options, spec) {
    var opts = options || {};
    var cfg = spec || {};
    var graph = graphFromCy(cy);
    var initialCurrentPositions = currentPositionsFromCy(cy);
    var livePositions = {};
    var timing = resolveLayoutTimingOptions(opts, {
      delayMs: cfg.delayMsDefault,
      renderEvery: cfg.renderEveryDefault,
      yieldEvery: cfg.yieldEveryDefault
    });
    var delayMs = timing.delayMs;
    var renderEvery = timing.renderEvery;
    var yieldEvery = timing.yieldEvery;
    var fitPadding = Number.isFinite(cfg.fitPadding) ? Math.max(0, cfg.fitPadding) : 24;
    var didStreamProgress = false;
    var initialFitBounds = null;
    var sharedPreparedSeed = null;

    if (cfg.useSharedPreparedSeed) {
      sharedPreparedSeed = LayoutPreprocessing.prepareGraphAndLayoutData(graph, {
        failureLabel: String(cfg.sharedSeedFailureLabel || cfg.failureMessage || 'Layout'),
        currentPositions: initialCurrentPositions,
        augmentationMethod: opts.augmentationMethod
      });
      if (sharedPreparedSeed && sharedPreparedSeed.ok && sharedPreparedSeed.posById) {
        livePositions = sharedPreparedSeed.posById;
        initialFitBounds = computePositionBounds(sharedPreparedSeed.posById);
      }
    }

    var renderer = createLayoutRenderer({
      cy: cy,
      getPositions: function () { return livePositions; },
      hasInitialPositions: function () {
        var ids = Object.keys(livePositions || {});
        for (var i = 0; i < ids.length; i += 1) {
          var p = livePositions[ids[i]];
          if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
            return true;
          }
        }
        return false;
      },
      delayMs: delayMs,
      renderEvery: renderEvery,
      yieldEvery: yieldEvery,
      fitPadding: fitPadding,
      initialFitBounds: initialFitBounds
    });

    async function onProgress(progress) {
      var event = progress || {};
      didStreamProgress = true;
      livePositions = event.positions || livePositions;
      if (typeof opts.onIteration === 'function') {
        opts.onIteration(event);
      }
      await renderer.onProgress(event, { forceYield: !!(opts.onIteration || delayMs > 0) });
    }

    function finalizeResult(result) {
      var positions = null;
      var streamed = didStreamProgress;
      if (result && result.ok) {
        positions = typeof cfg.getPositions === 'function'
          ? cfg.getPositions(result)
          : result.positions;
        livePositions = positions || livePositions;
      }
      renderer.finish();

      if (!result || !result.ok) {
        return result || { ok: false, message: String(cfg.failureMessage || 'Layout failed') };
      }

      function attachProgressMetadata(out) {
        if (out && typeof out === 'object') {
          out.didStreamProgress = streamed;
        }
        return out;
      }

      if (typeof cfg.buildResult === 'function') {
        return attachProgressMetadata(cfg.buildResult({
          result: result,
          graph: graph,
          cy: cy,
          options: opts,
          positions: positions
        }));
      }

      return attachProgressMetadata(result);
    }

    function executeCompute() {
      var computeOptions = Object.assign(
        {},
        opts,
        {
          currentPositions: initialCurrentPositions,
          preparedSeed: sharedPreparedSeed,
          onIteration: onProgress
        },
        typeof cfg.patchComputeOptions === 'function'
          ? (cfg.patchComputeOptions({
            options: opts,
            graph: graph,
            cy: cy,
            onProgress: onProgress
          }) || {})
          : {}
      );
      var result = cfg.compute(graph, computeOptions);
      if (result && typeof result.then === 'function') {
        return result.then(finalizeResult);
      }
      return finalizeResult(result);
    }

    return renderer.begin().then(executeCompute);
  }

  global.CyRuntime = {
    currentPositionsFromCy: currentPositionsFromCy,
    captureViewportFromCy: captureViewportFromCy,
    applyPositionsToCy: applyPositionsToCy,
    applyViewportToCy: applyViewportToCy,
    restorePositionsToCy: restorePositionsToCy,
    syncOverlayInCy: syncOverlayInCy,
    runLayout: runLayout
  };
})(window);
