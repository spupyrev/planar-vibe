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

  function normalizeLayoutMethodName(layoutName) {
    var key = String(layoutName || '').toLowerCase();
    if (key === 'reweight') return 'reweighttutte';
    if (key === 'fd_uniform') return 'fd-uniform';
    if (key === 'ceg23_bfs') return 'ceg23-bfs';
    if (key === 'ceg23_xy') return 'ceg23-xy';
    return key;
  }

  function sharedLayoutMethodOptionsByName(layoutName, overrides) {
    var key = normalizeLayoutMethodName(layoutName);
    var base = {};
    if (key === 'air' ||
        key === 'ppag' ||
        key === 'facebalancer' ||
        key === 'reweighttutte' ||
        key === 'fd-uniform' ||
        key === 'impred') {
      base = {
        incremental: true,
        interactive: true,
        delayMs: 0,
        renderEvery: 2,
        yieldEvery: 5
      };
    }
    return Object.assign({}, base, overrides || {});
  }

  function prepareAugmentedTriangulation(nodeIds, edgePairs, embedding, outerFace, failureLabel, options) {
    if (!embedding || !embedding.ok) {
      return { ok: false, reason: 'prepareAugmentedTriangulation requires a planar embedding' };
    }
    if (!Array.isArray(outerFace) || outerFace.length < 3) {
      return { ok: false, reason: 'prepareAugmentedTriangulation requires an outer face' };
    }
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

  function prepareGraphData(graph, config) {
    var cfg = config || {};
    var label = String(cfg.failureLabel || 'Layout');
    var minNodeCount = Number.isFinite(cfg.minNodeCount) ? Math.max(1, Math.floor(cfg.minNodeCount)) : 3;
    var normalizedGraph = {
      nodeIds: GraphUtils.normalizeNodeIds(graph && graph.nodeIds),
      edgePairs: GraphUtils.normalizeSimpleEdgePairs(graph && graph.edgePairs)
    };

    if (normalizedGraph.nodeIds.length < minNodeCount) {
      return { ok: false, message: label + ' requires at least ' + minNodeCount + ' vertices' };
    }

    var drawingEmbedding = GraphUtils.extractEmbeddingFromPositions(
      normalizedGraph.nodeIds,
      normalizedGraph.edgePairs,
      cfg.currentPositions || null
    );
    var baseEmbedding = drawingEmbedding ||
      global.PlanarVibePlanarityTest.computePlanarEmbedding(normalizedGraph.nodeIds, normalizedGraph.edgePairs);
    if (!baseEmbedding || !baseEmbedding.ok) {
      return { ok: false, message: label + ' requires a planar graph' };
    }

    var outerFace = Array.isArray(baseEmbedding.outerFace) && baseEmbedding.outerFace.length >= 3
      ? baseEmbedding.outerFace.slice().map(String)
      : null;
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

    return {
      ok: true,
      graph: normalizedGraph,
      baseEmbedding: baseEmbedding,
      outerFace: outerFace,
      augmented: augmented,
      embedding: augmented.embedding,
      augmentedNodeIds: augmented.nodeIds,
      augmentedEdgePairs: augmented.edgePairs,
      augmentedDummyCount: augmented.dummyCount || 0
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
    normalized.debug = normalized.debug ? Object.assign({}, normalized.debug) : {};

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
          cy: cy,
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

  function createZeroVectorLocal(n) {
    var out = new Array(Math.max(0, Math.floor(Number(n) || 0)));
    for (var i = 0; i < out.length; i += 1) {
      out[i] = 0;
    }
    return out;
  }

  function validateBarycentricSeedContext(nodeIds, edgePairs, outerFace, context) {
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
    return { ok: true };
  }

  function computeSharedBarycentricSeed(nodeIds, edgePairs, outerFace, context) {
    var validation = validateBarycentricSeedContext(nodeIds, edgePairs, outerFace, context);
    if (!validation.ok) {
      return validation;
    }
    var ids = (nodeIds || []).map(String);
    var adjacency = GraphUtils.buildAdjacencyArrays(ids, edgePairs || []);
    var pos = global.PlanarVibeTutteAlgorithm.placeOuterFaceVertices(
      ids,
      outerFace,
      global.PlanarVibeTutteAlgorithm.defaultOuterPlacementOptions({
        useSeedOuter: false
      })
    );
    var outerSet = new Set((outerFace || []).map(String));
    var interiorIds = [];
    var interiorIndexById = {};
    var i;
    var j;

    for (i = 0; i < ids.length; i += 1) {
      var id = ids[i];
      if (!outerSet.has(id)) {
        interiorIndexById[id] = interiorIds.length;
        interiorIds.push(id);
      }
    }
    if (interiorIds.length === 0) {
      return { ok: true, pos: pos, iters: 0 };
    }

    var L = new Array(interiorIds.length);
    var bx = createZeroVectorLocal(interiorIds.length);
    var by = createZeroVectorLocal(interiorIds.length);
    for (i = 0; i < interiorIds.length; i += 1) {
      L[i] = createZeroVectorLocal(interiorIds.length);
      L[i][i] = 1;
      var neighbors = adjacency[interiorIds[i]] || [];
      if (neighbors.length === 0) {
        continue;
      }
      var weight = 1 / neighbors.length;
      for (j = 0; j < neighbors.length; j += 1) {
        var neighborId = String(neighbors[j]);
        var interiorIdx = interiorIndexById[neighborId];
        if (interiorIdx === undefined) {
          bx[i] += weight * pos[neighborId].x;
          by[i] += weight * pos[neighborId].y;
        } else {
          L[i][interiorIdx] -= weight;
        }
      }
    }

    var factor = GraphUtils.luFactorize(L);
    if (!factor) {
      return { ok: false, message: 'Exact barycentric solve failed' };
    }
    var solved = GraphUtils.solveLUWithTwoRhs(factor, bx, by);
    if (!solved) {
      return { ok: false, message: 'Exact barycentric solve failed' };
    }
    for (i = 0; i < interiorIds.length; i += 1) {
      pos[interiorIds[i]] = { x: solved.x1[i], y: solved.x2[i] };
    }
    return { ok: true, pos: pos, iters: 1 };
  }

  function verifyEmbeddingWithPositions(embedding, posById, options) {
    var opts = options || {};
    var emb = embedding || null;
    if (!emb || !emb.ok) {
      return { ok: false, message: 'Position verification requires a planar embedding' };
    }

    var ids = Array.isArray(emb.idByIndex) ? emb.idByIndex.map(String) : [];
    if (ids.length === 0) {
      return { ok: false, message: 'Position verification requires embedding vertices' };
    }
    if (!posById || typeof posById !== 'object') {
      return { ok: false, message: 'Position verification requires coordinates' };
    }

    for (var i = 0; i < ids.length; i += 1) {
      var p = posById[ids[i]];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        return { ok: false, message: 'Position verification found missing or non-finite coordinates for vertex ' + ids[i] };
      }
    }

    var outerFace = Array.isArray(opts.outerFace) && opts.outerFace.length >= 3
      ? opts.outerFace.slice().map(String)
      : (Array.isArray(emb.outerFace) && emb.outerFace.length >= 3 ? emb.outerFace.slice().map(String) : null);
    if (!outerFace) {
      return { ok: false, message: 'Position verification requires an outer face' };
    }
    if (!GraphUtils.embeddingHasFace(emb, outerFace)) {
      return { ok: false, message: 'Position verification found an outer face that is not present in the embedding' };
    }
    if (!(GraphUtils.polygonAreaAbs(outerFace, posById) > 1e-12)) {
      return { ok: false, message: 'Position verification found a degenerate outer face' };
    }

    var edges = Array.isArray(opts.edgePairs) ? opts.edgePairs : emb.edges;
    if (GraphUtils.hasPositionCrossings(posById, edges || [])) {
      return { ok: false, message: 'Position verification found crossings in the drawing' };
    }

    var faces = Array.isArray(emb.faces) ? emb.faces : [];
    for (i = 0; i < faces.length; i += 1) {
      var face = faces[i];
      if (!Array.isArray(face) || face.length < 3) {
        return { ok: false, message: 'Position verification found an invalid face in the embedding' };
      }
      if (!(GraphUtils.polygonAreaAbs(face, posById) > 1e-12)) {
        return { ok: false, message: 'Position verification found a degenerate face' };
      }
    }

    return { ok: true };
  }

  function prepareGraphAndLayoutData(graph, config) {
    var cfg = config || {};
    var label = String(cfg.failureLabel || 'Layout');
    var prepared = prepareGraphData(graph, cfg);
    if (!prepared || !prepared.ok) {
      return prepared;
    }
    var normalizedGraph = prepared.graph;
    var baseEmbedding = prepared.baseEmbedding;
    var outerFace = prepared.outerFace;
    var augmented = prepared.augmented;

    var init = computeSharedBarycentricSeed(augmented.nodeIds, augmented.edgePairs, outerFace, {
      graph: normalizedGraph,
      baseEmbedding: baseEmbedding,
      augmented: augmented,
      outerFace: outerFace,
      config: cfg
    });
    if (!init || !init.ok || !init.pos) {
      return { ok: false, message: (init && init.message) || (label + ' initialization failed') };
    }
    var verification = verifyEmbeddingWithPositions(augmented.embedding, init.pos, {
      edgePairs: augmented.edgePairs,
      outerFace: outerFace
    });
    if (!verification.ok) {
      return { ok: false, message: verification.message || (label + ' initialization failed') };
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

  global.PlaygroundUtils = {
    graphFromCy: graphFromCy,
    currentPositionsFromCy: currentPositionsFromCy,
    sharedLayoutMethodOptionsByName: sharedLayoutMethodOptionsByName,
    prepareGraphData: prepareGraphData,
    originalFaceKeyForAugmentedFace: originalFaceKeyForAugmentedFace,
    createAugmentationDebugState: createAugmentationDebugState,
    applyPositionsToCy: applyPositionsToCy,
    applyAndFit: applyAndFit,
    waitForNextFrame: waitForNextFrame,
    normalizeIncrementalProgress: normalizeIncrementalProgress,
    resolveIncrementalLayoutTimingOptions: resolveIncrementalLayoutTimingOptions,
    createIncrementalRenderer: createIncrementalRenderer,
    runIncrementalLayout: runIncrementalLayout,
    computeSharedBarycentricSeed: computeSharedBarycentricSeed,
    verifyEmbeddingWithPositions: verifyEmbeddingWithPositions,
    prepareGraphAndLayoutData: prepareGraphAndLayoutData
  };
})(window);
