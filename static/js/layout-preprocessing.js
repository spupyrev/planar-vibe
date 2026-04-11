(function (global) {
  'use strict';

  var GraphUtils = global.GraphUtils;

  function normalizePreparedAugmentationResult(augmented, failureLabel) {
    var label = failureLabel || 'layout';
    if (!augmented || !augmented.ok) {
      return { ok: false, reason: (augmented && augmented.reason) || (label + ' augmentation failed') };
    }
    var dummyFaceVerticesById = augmented.dummyFaceVerticesById || {};
    return {
      ok: true,
      nodeIds: augmented.nodeIds.map(String),
      edgePairs: augmented.edgePairs.map(function (edge) { return [String(edge[0]), String(edge[1])]; }),
      dummyCount: augmented.dummyCount || 0,
      dummyFaceVerticesById: dummyFaceVerticesById,
      embedding: augmented.embedding,
      outerFace: augmented.embedding && Array.isArray(augmented.embedding.outerFace)
        ? augmented.embedding.outerFace.slice().map(String)
        : null
    };
  }

  function prepareAugmentedTriangulation(nodeIds, edgePairs, embedding, outerFace, failureLabel, options) {
    if (!embedding || !embedding.ok) {
      return { ok: false, reason: 'prepareAugmentedTriangulation requires a planar embedding' };
    }
    if (!Array.isArray(outerFace) || outerFace.length < 3) {
      return { ok: false, reason: 'prepareAugmentedTriangulation requires an outer face' };
    }
    var augmented = GraphUtils.triangulateByFaceStellation(nodeIds, edgePairs, embedding, outerFace, options);
    return normalizePreparedAugmentationResult(augmented, failureLabel);
  }

  function prepareOuterCycleTriangulation(nodeIds, edgePairs, embedding, outerFace, failureLabel, options) {
    if (!embedding || !embedding.ok) {
      return { ok: false, reason: 'prepareOuterCycleTriangulation requires a planar embedding' };
    }
    if (!Array.isArray(outerFace) || outerFace.length < 3) {
      return { ok: false, reason: 'prepareOuterCycleTriangulation requires an outer face' };
    }
    var augmented = GraphUtils.triangulateByOuterCycle(nodeIds, edgePairs, embedding, outerFace, options);
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

  function prepareGraphData(graph, config) {
    var cfg = config || {};
    var label = String(cfg.failureLabel || 'Layout');
    var normalizedGraph = {
      nodeIds: GraphUtils.normalizeNodeIds(graph && graph.nodeIds),
      edgePairs: GraphUtils.normalizeSimpleEdgePairs(graph && graph.edgePairs)
    };

    if (normalizedGraph.nodeIds.length < 3) {
      return { ok: false, message: label + ' requires at least 3 vertices' };
    }

    var augmentationKey = String(cfg.augmentationMethod || '').trim().toLowerCase();
    var augmentationMethod = null;
    if (!augmentationKey || augmentationKey === 'default' || augmentationKey === 'outer-cycle') {
      augmentationMethod = 'triangulateByOuterCycle';
    } else if (augmentationKey === 'face-stellation') {
      augmentationMethod = 'triangulateByFaceStellation';
    } else {
      return { ok: false, message: 'Unknown augmentation method: ' + String(cfg.augmentationMethod) };
    }

    var drawingEmbedding = GraphUtils.extractEmbeddingFromPositions(
      normalizedGraph.nodeIds,
      normalizedGraph.edgePairs,
      cfg.currentPositions || null
    );
    var extractedEmbedding = sanitizeEmbeddingSnapshot(drawingEmbedding);
    drawingEmbedding = null;
    var baseEmbedding = extractedEmbedding ||
      global.PlanarVibePlanarityTest.computePlanarEmbedding(normalizedGraph.nodeIds, normalizedGraph.edgePairs);
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
        normalizedGraph.nodeIds,
        normalizedGraph.edgePairs,
        baseEmbedding,
        selectedOuterFace,
        label,
        cfg.augmentationOptions || null
      );
    } else if (augmentationMethod === 'triangulateByOuterCycle') {
      augmented = prepareOuterCycleTriangulation(
        normalizedGraph.nodeIds,
        normalizedGraph.edgePairs,
        baseEmbedding,
        selectedOuterFace,
        label,
        cfg.augmentationOptions || null
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
      graph: normalizedGraph,
      baseEmbedding: baseEmbedding,
      outerFace: selectedOuterFace.slice().map(String),
      augmentedOuterFace: augmentedOuterFace,
      augmented: augmented,
      embedding: augmented.embedding,
      augmentationMethod: augmentationMethod,
      augmentedNodeIds: augmented.nodeIds,
      augmentedEdgePairs: augmented.edgePairs,
      augmentedDummyCount: augmented.dummyCount || 0
    };
  }

  function createAugmentationDebugState(graph, augmented, posById) {
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
      addedEdgePairs: addedEdgePairs,
      dummyIds: dummyIds,
      dummyLabelById: dummyLabelById,
      dummyPositionsById: dummyPositionsById,
      dummyFaceVerticesById: dummyFaceVerticesById
    };
  }

  function validateBarycentricSeedContext(embedding, nodeIds, edgePairs, outerFace) {
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

  function computeSharedBarycentricSeed(nodeIds, edgePairs, outerFace, embedding) {
    var validation = validateBarycentricSeedContext(embedding, nodeIds, edgePairs, outerFace);
    if (!validation.ok) {
      return validation;
    }
    var ids = (nodeIds || []).map(String);
    var adjacency = GraphUtils.buildAdjacencyArrays(ids, edgePairs || []);
    var pos = global.PlanarVibeTutteAlgorithm.placeOuterFaceVertices(
      ids,
      outerFace,
      global.PlanarVibeTutteAlgorithm.defaultOuterPlacementOptions()
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
      return { ok: true, positions: pos, iters: 0 };
    }

    var L = new Array(interiorIds.length);
    var bx = GraphUtils.createZeroVector(interiorIds.length);
    var by = GraphUtils.createZeroVector(interiorIds.length);
    for (i = 0; i < interiorIds.length; i += 1) {
      L[i] = GraphUtils.createZeroVector(interiorIds.length);
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
    return { ok: true, positions: pos, iters: 1 };
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
    var augmentedOuterFace = prepared.augmentedOuterFace || prepared.outerFace;
    var augmented = prepared.augmented;

    var init = computeSharedBarycentricSeed(
      augmented.nodeIds,
      augmented.edgePairs,
      augmentedOuterFace,
      augmented.embedding
    );
    if (!init || !init.ok || !init.positions) {
      return { ok: false, message: (init && init.message) || (label + ' initialization failed') };
    }
    var verification = verifyEmbeddingWithPositions(augmented.embedding, init.positions, {
      edgePairs: augmented.edgePairs,
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
      posById: GraphUtils.alignOuterFaceEdgeHorizontally(init.positions, augmentedOuterFace),
      movableVertices: GraphUtils.collectMovableVertices(augmented.nodeIds, augmentedOuterFace),
      initResult: init
    };
  }

  global.LayoutPreprocessing = {
    prepareGraphData: prepareGraphData,
    createAugmentationDebugState: createAugmentationDebugState,
    computeSharedBarycentricSeed: computeSharedBarycentricSeed,
    verifyEmbeddingWithPositions: verifyEmbeddingWithPositions,
    prepareGraphAndLayoutData: prepareGraphAndLayoutData
  };
})(window);
