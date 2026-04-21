(function (global) {
  'use strict';

  var GraphUtils = global.GraphUtils;
  var GeometryUtils = global.GeometryUtils;
  var PlanarGraphUtils = global.PlanarGraphUtils;

  function normalizePreparedAugmentationResult(augmented, failureLabel) {
    var label = failureLabel || 'layout';
    if (!augmented || !augmented.ok) {
      return { ok: false, reason: (augmented && augmented.reason) || (label + ' augmentation failed') };
    }
    var dummyFaceVerticesById = augmented.dummyFaceVerticesById || {};
    var outerDummyIds = Array.isArray(augmented.outerDummyIds)
      ? augmented.outerDummyIds.slice().map(String)
      : [];
    if (augmented.graph && typeof augmented.graph === 'object') {
      augmented.graph.outerDummyIds = outerDummyIds.slice();
    }
    return {
      ok: true,
      graph: augmented.graph,
      dummyCount: augmented.dummyCount || 0,
      dummyFaceVerticesById: dummyFaceVerticesById,
      outerDummyIds: outerDummyIds,
      embedding: augmented.embedding,
      outerFace: augmented.embedding && Array.isArray(augmented.embedding.outerFace)
        ? augmented.embedding.outerFace.slice().map(String)
        : null
    };
  }

  function prepareAugmentedTriangulation(graph, embedding, outerFace, failureLabel, options) {
    if (!embedding || !embedding.ok) {
      return { ok: false, reason: 'prepareAugmentedTriangulation requires a planar embedding' };
    }
    if (!Array.isArray(outerFace) || outerFace.length < 3) {
      return { ok: false, reason: 'prepareAugmentedTriangulation requires an outer face' };
    }
    var augmented = PlanarGraphUtils.triangulateByFaceStellation(graph, embedding, outerFace, options);
    return normalizePreparedAugmentationResult(augmented, failureLabel);
  }

  function prepareOuterCycleTriangulation(graph, embedding, outerFace, failureLabel, options) {
    if (!embedding || !embedding.ok) {
      return { ok: false, reason: 'prepareOuterCycleTriangulation requires a planar embedding' };
    }
    if (!Array.isArray(outerFace) || outerFace.length < 3) {
      return { ok: false, reason: 'prepareOuterCycleTriangulation requires an outer face' };
    }
    var augmented = PlanarGraphUtils.triangulateByOuterCycle(graph, embedding, outerFace, options);
    return normalizePreparedAugmentationResult(augmented, failureLabel);
  }

  function chooseLongestFaceFromEmbedding(embedding) {
    if (!embedding) {
      return null;
    }
    var faces = Array.isArray(embedding.faces) ? embedding.faces : [];
    var best = null;
    for (var i = 0; i < faces.length; i += 1) {
      var face = faces[i];
      if (!Array.isArray(face) || face.length < 3) {
        continue;
      }
      var mapped = face.slice().map(String);
      if (!best || mapped.length > best.length) {
        best = mapped;
      }
    }
    if (best) {
      return best;
    }
    return Array.isArray(embedding.outerFace) && embedding.outerFace.length >= 3
      ? embedding.outerFace.slice().map(String)
      : null;
  }

  function sanitizeEmbeddingSnapshot(embedding) {
    if (!embedding || !embedding.ok) {
      return embedding;
    }
    return {
      ok: true,
      idByIndex: Array.isArray(embedding.idByIndex) ? embedding.idByIndex.slice().map(String) : [],
      indexById: Object.assign({}, embedding.indexById || {}),
      edges: Array.isArray(embedding.edges)
        ? embedding.edges.map(function (edge) { return [String(edge[0]), String(edge[1])]; })
        : [],
      rotation: Array.isArray(embedding.rotation)
        ? embedding.rotation.map(function (row) {
          return Array.isArray(row) ? row.slice().map(String) : [];
        })
        : [],
      faces: Array.isArray(embedding.faces)
        ? embedding.faces.map(function (face) {
          return Array.isArray(face) ? face.slice().map(String) : [];
        })
        : [],
      outerFace: Array.isArray(embedding.outerFace) ? embedding.outerFace.slice().map(String) : null
    };
  }

  function resolveAugmentationMethod(rawValue) {
    var augmentationKey = String(rawValue || '').trim().toLowerCase();
    if (!augmentationKey || augmentationKey === 'default' || augmentationKey === 'outer-cycle') {
      return 'triangulateByOuterCycle';
    }
    if (augmentationKey === 'face-stellation') {
      return 'triangulateByFaceStellation';
    }
    return null;
  }

  function prepareGraphData(graph, config) {
    var label = String(config.failureLabel || 'Layout');
    if (!graph || !Array.isArray(graph.nodeIds) || !Array.isArray(graph.edgePairs)) {
      throw new Error('prepareGraphData requires a graph');
    }

    if (graph.nodeIds.length < 3) {
      return { ok: false, message: label + ' requires at least 3 vertices' };
    }

    var augmentationMethod = resolveAugmentationMethod(config.augmentationMethod);
    if (!augmentationMethod) {
      return { ok: false, message: 'Unknown augmentation method: ' + String(config.augmentationMethod) };
    }

    var drawingEmbedding = PlanarGraphUtils.extractEmbeddingFromPositions(
      graph.nodeIds,
      graph.edgePairs,
      config.currentPositions
    );
    var extractedEmbedding = sanitizeEmbeddingSnapshot(drawingEmbedding);
    drawingEmbedding = null;
    var baseEmbedding = extractedEmbedding ||
      global.PlanarVibePlanarityTest.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
    if (!baseEmbedding || !baseEmbedding.ok) {
      return { ok: false, message: label + ' requires a planar graph' };
    }

    var selectedOuterFace = null;
    if (augmentationMethod === 'triangulateByOuterCycle') {
      selectedOuterFace = extractedEmbedding && extractedEmbedding.ok
        ? extractedEmbedding.outerFace.slice().map(String)
        : chooseLongestFaceFromEmbedding(baseEmbedding);
    } else {
      selectedOuterFace = Array.isArray(baseEmbedding.outerFace) && baseEmbedding.outerFace.length >= 3
        ? baseEmbedding.outerFace.slice().map(String)
        : null;
    }
    if (!selectedOuterFace || selectedOuterFace.length < 3) {
      return { ok: false, message: 'Could not determine outer boundary for ' + label };
    }

    var augmented;
    if (augmentationMethod === 'triangulateByFaceStellation') {
      augmented = prepareAugmentedTriangulation(
        graph,
        baseEmbedding,
        selectedOuterFace,
        label,
        config.augmentationOptions || null
      );
    } else if (augmentationMethod === 'triangulateByOuterCycle') {
      augmented = prepareOuterCycleTriangulation(
        graph,
        baseEmbedding,
        selectedOuterFace,
        label,
        config.augmentationOptions || null
      );
    }
    if (!augmented.ok) {
      return { ok: false, message: augmented.reason || (label + ' augmentation failed') };
    }
    augmented.method = augmentationMethod;
    var augmentedOuterFace = Array.isArray(augmented.outerFace) && augmented.outerFace.length >= 3
      ? augmented.outerFace.slice().map(String)
      : selectedOuterFace.slice().map(String);

    return {
      ok: true,
      graph: graph,
      baseEmbedding: baseEmbedding,
      outerFace: selectedOuterFace.slice().map(String),
      augmentedOuterFace: augmentedOuterFace,
      augmented: augmented,
      augmentedGraph: augmented.graph,
      embedding: augmented.embedding,
      augmentationMethod: augmentationMethod,
      augmentedNodeIds: augmented.graph.nodeIds,
      augmentedEdgePairs: augmented.graph.edgePairs,
      augmentedDummyCount: augmented.dummyCount || 0
    };
  }

  function createAugmentationDebugState(graph, augmented, posById) {
    var baseGraph = graph || { nodeIds: [], edgePairs: [] };
    var aug = augmented || { graph: { nodeIds: [], edgePairs: [] } };
    var augmentedGraph = aug.graph || { nodeIds: [], edgePairs: [] };
    var positions = posById || {};
    var originalEdgeSet = {};
    var originalNodeSet = {};
    var i;

    for (i = 0; i < baseGraph.nodeIds.length; i += 1) {
      originalNodeSet[String(baseGraph.nodeIds[i])] = true;
    }

    for (i = 0; i < baseGraph.edgePairs.length; i += 1) {
      var a = String(baseGraph.edgePairs[i][0]);
      var b = String(baseGraph.edgePairs[i][1]);
      var key = a < b ? a + '::' + b : b + '::' + a;
      originalEdgeSet[key] = true;
    }

    var dummyIds = [];
    for (i = 0; i < augmentedGraph.nodeIds.length; i += 1) {
      var augmentedId = String(augmentedGraph.nodeIds[i]);
      if (!originalNodeSet[augmentedId]) {
        dummyIds.push(augmentedId);
      }
    }
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
    for (i = 0; i < augmentedGraph.edgePairs.length; i += 1) {
      var u = String(augmentedGraph.edgePairs[i][0]);
      var v = String(augmentedGraph.edgePairs[i][1]);
      var edgeKey = u < v ? u + '::' + v : v + '::' + u;
      if (!originalEdgeSet[edgeKey]) {
        addedEdgePairs.push([u, v]);
      }
    }

    return {
      addedEdgePairs: addedEdgePairs,
      dummyIds: dummyIds,
      dummyLabelById: dummyLabelById,
      dummyPositionsById: dummyPositionsById
    };
  }

  function computeInitialPositions(graph, outerFace, embedding, originalGraph) {
    if (!embedding || !embedding.ok) {
      return { ok: false, message: 'Barycentric initialization requires a planar embedding' };
    }
    if (!PlanarGraphUtils.embeddingHasFace(embedding, outerFace)) {
      return { ok: false, message: 'Provided outer face is not a face of the embedding' };
    }
    var connectivity = GraphUtils.analyzeInternallyThreeConnected(graph, outerFace);
    if (!connectivity || !connectivity.ok) {
      return {
        ok: false,
        message: (connectivity && connectivity.reason) || 'Barycentric layout requires an internally 3-connected planar graph'
      };
    }
    var initialPositions = global.PlanarVibeTutte.computeBarycentricPositions(
      graph,
      outerFace,
      {
        initOptions: global.PlanarVibeTutte.defaultOuterPlacementOptions(),
        weights: global.PlanarVibeTutte.buildTutteWeights(originalGraph || graph, graph)
      }
    );
    if (!initialPositions || !initialPositions.ok || !initialPositions.positions) {
      return { ok: false, message: (initialPositions && initialPositions.message) || 'Exact barycentric solve failed' };
    }
    return {
      ok: true,
      positions: initialPositions.positions,
      iters: initialPositions.iters
    };
  }

  function verifyEmbeddingWithPositions(embedding, posById, options) {
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

    var outerFace = Array.isArray(options.outerFace) && options.outerFace.length >= 3
      ? options.outerFace.slice().map(String)
      : (Array.isArray(emb.outerFace) && emb.outerFace.length >= 3 ? emb.outerFace.slice().map(String) : null);
    if (!outerFace) {
      return { ok: false, message: 'Position verification requires an outer face' };
    }
    if (!PlanarGraphUtils.embeddingHasFace(emb, outerFace)) {
      return { ok: false, message: 'Position verification found an outer face that is not present in the embedding' };
    }
    if (!(GeometryUtils.polygonAreaAbs(outerFace, posById) > 1e-12)) {
      return { ok: false, message: 'Position verification found a degenerate outer face' };
    }

    var edges = Array.isArray(options.edgePairs) ? options.edgePairs : emb.edges;
    if (GeometryUtils.hasPositionCrossings(posById, edges || [])) {
      return { ok: false, message: 'Position verification found crossings in the drawing' };
    }

    var faces = Array.isArray(emb.faces) ? emb.faces : [];
    for (i = 0; i < faces.length; i += 1) {
      var face = faces[i];
      if (!Array.isArray(face) || face.length < 3) {
        return { ok: false, message: 'Position verification found an invalid face in the embedding' };
      }
      if (!(GeometryUtils.polygonAreaAbs(face, posById) > 1e-12)) {
        return { ok: false, message: 'Position verification found a degenerate face' };
      }
    }

    return { ok: true };
  }

  function prepareGraphAndLayoutData(graph, config) {
    var label = String(config.failureLabel || 'Layout');
    var prepared = prepareGraphData(graph, config);
    if (!prepared || !prepared.ok) {
      return prepared;
    }
    var normalizedGraph = prepared.graph;
    var baseEmbedding = prepared.baseEmbedding;
    var outerFace = prepared.outerFace;
    var augmentedOuterFace = prepared.augmentedOuterFace;
    var augmented = prepared.augmented;

    var init = computeInitialPositions(
      prepared.augmentedGraph,
      augmentedOuterFace,
      augmented.embedding,
      prepared.graph
    );
    if (!init || !init.ok || !init.positions) {
      return { ok: false, message: (init && init.message) || (label + ' initialization failed') };
    }
    var verification = verifyEmbeddingWithPositions(augmented.embedding, init.positions, {
      edgePairs: augmented.graph.edgePairs,
      outerFace: augmentedOuterFace
    });
    if (!verification.ok) {
      return { ok: false, message: verification.message || (label + ' initialization failed') };
    }

    return {
      ok: true,
      graph: normalizedGraph,
      baseEmbedding: baseEmbedding,
      outerFace: outerFace,
      augmentedOuterFace: augmentedOuterFace,
      augmented: augmented,
      augmentedGraph: prepared.augmentedGraph,
      posById: init.positions,
      movableVertices: GraphUtils.collectMovableVertices(augmented.graph.nodeIds, augmentedOuterFace),
      initResult: init
    };
  }

  global.LayoutPreprocessing = {
    createAugmentationDebugState: createAugmentationDebugState,
    computeInitialPositions: computeInitialPositions,
    verifyEmbeddingWithPositions: verifyEmbeddingWithPositions,
    prepareGraphData: prepareGraphData,
    prepareGraphAndLayoutData: prepareGraphAndLayoutData
  };
})(window);
