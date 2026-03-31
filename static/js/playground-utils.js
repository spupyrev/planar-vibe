(function (global) {
  'use strict';

  var GraphUtils = global.GraphUtils;

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
    return {
      nodeIds: filteredNodes,
      edgePairs: GraphUtils.normalizeSimpleEdgePairs((cy.edges().toArray ? cy.edges().toArray() : cy.edges()).map(function (e) {
        return [String(e.source().id()), String(e.target().id())];
      }).filter(function (edge) {
        return keep[edge[0]] && keep[edge[1]];
      }))
    };
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

  function prepareAugmentedTriangulation(nodeIds, edgePairs, embedding, outerFace, failureLabel, options) {
    var augmented = GraphUtils.triangulateByFaceStellation(nodeIds, edgePairs, embedding, outerFace, options);
    var label = failureLabel || 'layout';
    if (!augmented || !augmented.ok) {
      return { ok: false, reason: (augmented && augmented.reason) || (label + ' augmentation failed') };
    }
    var dummyFaceVerticesById = augmented.dummyFaceVerticesById || {};
    var dummyFaceKeyById = {};
    var dummyIds = Object.keys(dummyFaceVerticesById);
    for (var i = 0; i < dummyIds.length; i += 1) {
      dummyFaceKeyById[String(dummyIds[i])] = GraphUtils.faceKey(dummyFaceVerticesById[dummyIds[i]]);
    }
    return {
      ok: true,
      nodeIds: augmented.nodeIds.map(String),
      edgePairs: augmented.edgePairs.map(function (edge) { return [String(edge[0]), String(edge[1])]; }),
      dummyCount: augmented.dummyCount || 0,
      dummyFaceVerticesById: dummyFaceVerticesById,
      dummyFaceKeyById: dummyFaceKeyById,
      embedding: augmented.embedding
    };
  }

  function originalFaceKeyForAugmentedFace(face, dummyFaceKeyById, dummyFaceVerticesById, seenDummyIds) {
    var seen = seenDummyIds || new Set();
    for (var i = 0; i < face.length; i += 1) {
      var vertexId = String(face[i]);
      if (dummyFaceVerticesById && Array.isArray(dummyFaceVerticesById[vertexId]) && !seen.has(vertexId)) {
        seen.add(vertexId);
        return originalFaceKeyForAugmentedFace(dummyFaceVerticesById[vertexId], dummyFaceKeyById, dummyFaceVerticesById, seen);
      }
      if (dummyFaceKeyById && dummyFaceKeyById[vertexId]) {
        return dummyFaceKeyById[vertexId];
      }
    }
    return GraphUtils.faceKey(face);
  }

  function createAugmentationDebugState(graph, outerFace, augmented, posById) {
    var baseGraph = graph || { nodeIds: [], edgePairs: [] };
    var aug = augmented || { nodeIds: [], edgePairs: [], dummyFaceVerticesById: {} };
    var positions = posById || {};
    var originalEdgeSet = {};
    var i;

    for (i = 0; i < baseGraph.edgePairs.length; i += 1) {
      var a = String(baseGraph.edgePairs[i][0]);
      var b = String(baseGraph.edgePairs[i][1]);
      var key = a < b ? a + '::' + b : b + '::' + a;
      originalEdgeSet[key] = true;
    }

    var dummyFaceVerticesById = aug.dummyFaceVerticesById || {};
    var dummyIds = Object.keys(dummyFaceVerticesById).map(String);
    var dummySet = new Set(dummyIds);
    var dummyLabelById = {};
    var dummyPositionsById = {};
    for (i = 0; i < dummyIds.length; i += 1) {
      var dummyId = dummyIds[i];
      dummyLabelById[dummyId] = String(i);
      if (positions[dummyId] && Number.isFinite(positions[dummyId].x) && Number.isFinite(positions[dummyId].y)) {
        dummyPositionsById[dummyId] = { x: positions[dummyId].x, y: positions[dummyId].y };
      }
    }

    var addedEdgePairs = [];
    for (i = 0; i < aug.edgePairs.length; i += 1) {
      var u = String(aug.edgePairs[i][0]);
      var v = String(aug.edgePairs[i][1]);
      var edgeKey = u < v ? u + '::' + v : v + '::' + u;
      if (!originalEdgeSet[edgeKey]) {
        addedEdgePairs.push([u, v]);
      }
    }

    return {
      outerFace: Array.isArray(outerFace) ? outerFace.slice().map(String) : [],
      originalNodeIds: (baseGraph.nodeIds || []).map(String),
      originalEdgePairs: (baseGraph.edgePairs || []).map(function (edge) { return [String(edge[0]), String(edge[1])]; }),
      augmentedNodeIds: (aug.nodeIds || []).map(String),
      augmentedEdgePairs: (aug.edgePairs || []).map(function (edge) { return [String(edge[0]), String(edge[1])]; }),
      addedEdgePairs: addedEdgePairs,
      dummyIds: dummyIds,
      dummySet: dummySet,
      dummyLabelById: dummyLabelById,
      dummyPositionsById: dummyPositionsById,
      dummyFaceVerticesById: dummyFaceVerticesById,
      dummyCount: aug.dummyCount || 0
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

  function applyAndFit(cy, posById, fitPadding) {
    applyPositionsToCy(cy, posById);
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

  function normalizeIncrementalProgress(progress) {
    var event = progress || {};
    var normalized = Object.assign({}, event);

    if (!normalized.positions && normalized.pos) {
      normalized.positions = normalized.pos;
    }
    if (!normalized.pos && normalized.positions) {
      normalized.pos = normalized.positions;
    }
    if (!Number.isFinite(normalized.movedVertices) && Number.isFinite(normalized.movedNodes)) {
      normalized.movedVertices = normalized.movedNodes;
    }
    if (!Number.isFinite(normalized.movedNodes) && Number.isFinite(normalized.movedVertices)) {
      normalized.movedNodes = normalized.movedVertices;
    }
    if (!Number.isFinite(normalized.maxActualMove) && Number.isFinite(normalized.maxMove)) {
      normalized.maxActualMove = normalized.maxMove;
    }
    if (!Number.isFinite(normalized.avgActualMove) && Number.isFinite(normalized.avgMove)) {
      normalized.avgActualMove = normalized.avgMove;
    }
    if (!Number.isFinite(normalized.totalActualMove) && Number.isFinite(normalized.totalMove)) {
      normalized.totalActualMove = normalized.totalMove;
    }

    return normalized;
  }

  function resolveIncrementalLayoutTimingOptions(options, defaults) {
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

  function createIncrementalRenderer(config) {
    var cy = config.cy;
    var nodeIds = Array.isArray(config.nodeIds) ? config.nodeIds.map(String) : [];
    var getPositions = typeof config.getPositions === 'function' ? config.getPositions : function () { return {}; };
    var interactive = config.interactive !== false;
    var timing = resolveIncrementalLayoutTimingOptions(config, {
      delayMs: 0,
      renderEvery: 2,
      yieldEvery: 5
    });
    var delayMs = timing.delayMs;
    var renderEvery = timing.renderEvery;
    var yieldEvery = timing.yieldEvery;
    var fitPadding = Number.isFinite(config.fitPadding) ? Math.max(0, config.fitPadding) : 24;
    var didFit = false;

    function renderCurrent() {
      applyPositionsToCy(cy, getPositions());
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

  async function runIncrementalLayout(cy, options, spec) {
    var opts = options || {};
    var cfg = spec || {};
    var graph = graphFromCy(cy);
    var livePositions = {};
    var interactive = opts.interactive !== false;
    var timing = resolveIncrementalLayoutTimingOptions(opts, {
      delayMs: cfg.delayMsDefault,
      renderEvery: cfg.renderEveryDefault,
      yieldEvery: cfg.yieldEveryDefault
    });
    var delayMs = timing.delayMs;
    var renderEvery = timing.renderEvery;
    var yieldEvery = timing.yieldEvery;
    var fitPadding = Number.isFinite(cfg.fitPadding) ? Math.max(0, cfg.fitPadding) : 24;

    var renderer = createIncrementalRenderer({
      cy: cy,
      nodeIds: graph.nodeIds,
      getPositions: function () { return livePositions; },
      interactive: interactive,
      delayMs: delayMs,
      renderEvery: renderEvery,
      yieldEvery: yieldEvery,
      fitPadding: fitPadding
    });
    await renderer.begin();

    async function onProgress(progress) {
      var event = normalizeIncrementalProgress(progress);
      livePositions = event.positions || livePositions;
      if (typeof opts.onIteration === 'function') {
        opts.onIteration(event);
      }
      await renderer.onProgress(event, { forceYield: !!(opts.onIteration || delayMs > 0) });
    }

    var computeOptions = Object.assign(
      {},
      opts,
      typeof cfg.patchComputeOptions === 'function'
        ? (cfg.patchComputeOptions({
          options: opts,
          graph: graph,
          onProgress: onProgress
        }) || {})
        : {}
    );

    var result = await cfg.compute(graph.nodeIds, graph.edgePairs, computeOptions);
    var positions = null;
    if (result && result.ok) {
      positions = typeof cfg.getPositions === 'function'
        ? cfg.getPositions(result)
        : (result.pos || result.positions);
      livePositions = positions || livePositions;
    }
    renderer.finish();

    if (!result || !result.ok) {
      return result || { ok: false, message: String(cfg.failureMessage || 'Layout failed') };
    }

    if (typeof cfg.buildResult === 'function') {
      return cfg.buildResult({
        result: result,
        graph: graph,
        cy: cy,
        options: opts,
        positions: positions
      });
    }

    return result;
  }

  function prepareTriangulatedLayoutData(graph, config) {
    var cfg = config || {};
    var label = String(cfg.failureLabel || 'Layout');
    var minNodeCount = Number.isFinite(cfg.minNodeCount) ? Math.max(1, Math.floor(cfg.minNodeCount)) : 3;
    var normalizedGraph = {
      nodeIds: GraphUtils.normalizeNodeIds(graph && graph.nodeIds),
      edgePairs: GraphUtils.normalizeSimpleEdgePairs(graph && graph.edgePairs)
    };
    var usesDefaultSeed = typeof cfg.initPositions !== 'function';
    var initPositions = usesDefaultSeed
      ? function (nodeIds, edgePairs, outerFace, context) {
        var opts = cfg.seedOptions || {
          maxIters: 1000,
          tolerance: 1e-7
        };
        var embedding = context && context.augmented ? context.augmented.embedding : null;
        if (!embedding || !embedding.ok) {
          return { ok: false, message: 'Barycentric initialization requires a planar embedding' };
        }
        if (!GraphUtils.embeddingHasFace(embedding, outerFace)) {
          return { ok: false, message: 'Provided outer face is not a face of the embedding' };
        }
        var connectivity = GraphUtils.analyzeInternallyThreeConnected(nodeIds, edgePairs, outerFace);
        if (!connectivity || !connectivity.ok) {
          return {
            ok: false,
            message: (connectivity && connectivity.reason) || 'Barycentric layout requires an internally 3-connected planar graph'
          };
        }
        return global.PlanarVibeTutteAlgorithm.computeBarycentricPositions(
          nodeIds,
          edgePairs,
          outerFace,
          {
          maxIters: opts.maxIters,
          tolerance: opts.tolerance,
          initOptions: global.PlanarVibeTutteAlgorithm.defaultOuterPlacementOptions({
            useSeedOuter: false
          })
          }
        );
      }
      : cfg.initPositions;

    if (normalizedGraph.nodeIds.length < minNodeCount) {
      return { ok: false, message: label + ' requires at least ' + minNodeCount + ' vertices' };
    }

    var baseEmbedding = cfg.baseEmbedding || global.PlanarVibePlanarityTest.computePlanarEmbedding(normalizedGraph.nodeIds, normalizedGraph.edgePairs);
    if (!baseEmbedding || !baseEmbedding.ok) {
      return { ok: false, message: label + ' requires a planar graph' };
    }

    var outerFace = Array.isArray(cfg.outerFace) && cfg.outerFace.length >= 3
      ? cfg.outerFace.slice().map(String)
      : GraphUtils.chooseOuterFaceFromEmbedding(baseEmbedding);
    if (!outerFace || outerFace.length < 3) {
      return { ok: false, message: 'Could not determine outer boundary for ' + label };
    }

    var augmented = prepareAugmentedTriangulation(
      normalizedGraph.nodeIds,
      normalizedGraph.edgePairs,
      baseEmbedding,
      outerFace,
      label,
      cfg.augmentationOptions || null
    );
    if (!augmented.ok) {
      return { ok: false, message: augmented.reason || (label + ' augmentation failed') };
    }

    var init = initPositions(augmented.nodeIds, augmented.edgePairs, outerFace, {
      graph: normalizedGraph,
      baseEmbedding: baseEmbedding,
      augmented: augmented,
      outerFace: outerFace,
      config: cfg
    });
    if (!init || !init.ok || !init.pos) {
      return { ok: false, message: (init && init.message) || (label + ' initialization failed') };
    }

    return {
      ok: true,
      graph: normalizedGraph,
      baseEmbedding: baseEmbedding,
      outerFace: outerFace,
      augmented: augmented,
      posById: GraphUtils.alignOuterFaceEdgeHorizontally(init.pos, outerFace),
      movableVertices: GraphUtils.collectMovableVertices(augmented.nodeIds, outerFace),
      initResult: init
    };
  }

  function prepareTriangulatedLayoutContext(cy, config) {
    return prepareTriangulatedLayoutData(graphFromCy(cy), config);
  }

  global.PlaygroundUtils = {
    graphFromCy: graphFromCy,
    currentPositionsFromCy: currentPositionsFromCy,
    prepareAugmentedTriangulation: prepareAugmentedTriangulation,
    originalFaceKeyForAugmentedFace: originalFaceKeyForAugmentedFace,
    createAugmentationDebugState: createAugmentationDebugState,
    applyPositionsToCy: applyPositionsToCy,
    applyAndFit: applyAndFit,
    waitForNextFrame: waitForNextFrame,
    normalizeIncrementalProgress: normalizeIncrementalProgress,
    resolveIncrementalLayoutTimingOptions: resolveIncrementalLayoutTimingOptions,
    createIncrementalRenderer: createIncrementalRenderer,
    runIncrementalLayout: runIncrementalLayout,
    prepareTriangulatedLayoutData: prepareTriangulatedLayoutData,
    prepareTriangulatedLayoutContext: prepareTriangulatedLayoutContext
  };
})(window);
