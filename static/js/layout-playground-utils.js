(function (global) {
  'use strict';

  var buildAdjacency = global.PlanarGraphCore.buildAdjacency;

  function faceKey(face) {
    if (!face || face.length === 0) return '';
    var arr = face.map(String);
    var n = arr.length;
    var best = null;
    var i;
    for (i = 0; i < n; i += 1) {
      var rot = arr.slice(i).concat(arr.slice(0, i)).join('|');
      if (best === null || rot < best) best = rot;
    }
    var rev = arr.slice().reverse();
    for (i = 0; i < n; i += 1) {
      var rrot = rev.slice(i).concat(rev.slice(0, i)).join('|');
      if (best === null || rrot < best) best = rrot;
    }
    return best || '';
  }

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
      edgePairs: (cy.edges().toArray ? cy.edges().toArray() : cy.edges()).map(function (e) {
        return [String(e.source().id()), String(e.target().id())];
      }).filter(function (edge) {
        return keep[edge[0]] && keep[edge[1]];
      })
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

  function copyPositions(pos) {
    var out = {};
    var keys = Object.keys(pos || {});
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      out[key] = { x: pos[key].x, y: pos[key].y };
    }
    return out;
  }

  function polygonArea2(face, posById) {
    if (!face || face.length < 3) return 0;
    var sum = 0;
    for (var i = 0; i < face.length; i += 1) {
      var a = posById[String(face[i])];
      var b = posById[String(face[(i + 1) % face.length])];
      if (!a || !b) return 0;
      sum += a.x * b.y - b.x * a.y;
    }
    return sum;
  }

  function orientFaceCCW(face, posById) {
    var out = face.slice().map(String);
    if (polygonArea2(out, posById) < 0) {
      out.reverse();
    }
    return out;
  }

  function alignOuterFace(pos, outerFace) {
    if (global.PlanarGraphCore && typeof global.PlanarGraphCore.alignOuterFaceEdgeHorizontally === 'function') {
      return global.PlanarGraphCore.alignOuterFaceEdgeHorizontally(pos, outerFace);
    }
    return copyPositions(pos);
  }

  function outerFaceDiameter(posById, outerFace) {
    var face = Array.isArray(outerFace) ? outerFace : [];
    var diameter = 0;
    for (var i = 0; i < face.length; i += 1) {
      var a = posById[String(face[i])];
      if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) continue;
      for (var j = i + 1; j < face.length; j += 1) {
        var b = posById[String(face[j])];
        if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
        var dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (dist > diameter) {
          diameter = dist;
        }
      }
    }
    return diameter > 1e-12 ? diameter : 1;
  }

  function collectMovableVertices(nodeIds, outerFace) {
    var outerSet = new Set((outerFace || []).map(String));
    var movableVertices = [];
    for (var i = 0; i < nodeIds.length; i += 1) {
      var nodeId = String(nodeIds[i]);
      if (!outerSet.has(nodeId)) {
        movableVertices.push(nodeId);
      }
    }
    return movableVertices;
  }

  function prepareAugmentedTriangulation(nodeIds, edgePairs, embedding, outerFace, failureLabel, options) {
    var augmented = global.PlanarGraphCore.prepareTriangulatedByFaceStellation(nodeIds, edgePairs, embedding, outerFace, options);
    var label = failureLabel || 'layout';
    if (!augmented || !augmented.ok) {
      return { ok: false, reason: (augmented && augmented.reason) || (label + ' augmentation failed') };
    }
    var dummyFaceVerticesById = augmented.dummyFaceVerticesById || {};
    var dummyFaceKeyById = {};
    var dummyIds = Object.keys(dummyFaceVerticesById);
    for (var i = 0; i < dummyIds.length; i += 1) {
      dummyFaceKeyById[String(dummyIds[i])] = faceKey(dummyFaceVerticesById[dummyIds[i]]);
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
    return faceKey(face);
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

  function prepareTriangulatedLayoutData(graph, config, cy) {
    var cfg = config || {};
    var label = String(cfg.failureLabel || 'Layout');
    var minNodeCount = Number.isFinite(cfg.minNodeCount) ? Math.max(1, Math.floor(cfg.minNodeCount)) : 3;
    var usesDefaultSeed = typeof cfg.initPositions !== 'function';
    var initPositions = usesDefaultSeed
      ? function (nodeIds, edgePairs, outerFace, localCy, context) {
        var opts = cfg.seedOptions || {
          maxIters: 1000,
          tolerance: 1e-7
        };
        var embedding = context && context.augmented ? context.augmented.embedding : null;
        if (!embedding || !embedding.ok) {
          return { ok: false, message: 'Barycentric initialization requires a planar embedding' };
        }
        if (!global.PlanarGraphCore.embeddingHasFace(embedding, outerFace)) {
          return { ok: false, message: 'Provided outer face is not a face of the embedding' };
        }
        var connectivity = global.PlanarGraphCore.analyzeInternallyThreeConnected(nodeIds, edgePairs, outerFace);
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

    if (!global.PlanarVibePlanarityTest || !global.PlanarVibePlanarityTest.computePlanarEmbedding) {
      return { ok: false, message: 'Planarity utilities are missing. Check script load order' };
    }
    if (!global.PlanarGraphCore || !global.PlanarGraphCore.prepareTriangulatedByFaceStellation) {
      return { ok: false, message: 'Planar graph utilities are missing. Check script load order' };
    }
    if (usesDefaultSeed && (!global.PlanarVibeTutteAlgorithm ||
        typeof global.PlanarVibeTutteAlgorithm.computeBarycentricPositions !== 'function' ||
        typeof global.PlanarVibeTutteAlgorithm.defaultOuterPlacementOptions !== 'function')) {
      return { ok: false, message: 'Tutte algorithm is missing. Check script load order' };
    }

    if (graph.nodeIds.length < minNodeCount) {
      return { ok: false, message: label + ' requires at least ' + minNodeCount + ' vertices' };
    }

    var baseEmbedding = cfg.baseEmbedding || global.PlanarVibePlanarityTest.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
    if (!baseEmbedding || !baseEmbedding.ok) {
      return { ok: false, message: label + ' requires a planar graph' };
    }

    var outerFace = Array.isArray(cfg.outerFace) && cfg.outerFace.length >= 3
      ? cfg.outerFace.slice().map(String)
      : global.PlanarGraphCore.chooseOuterFaceFromEmbedding(baseEmbedding);
    if (!outerFace || outerFace.length < 3) {
      return { ok: false, message: 'Could not determine outer boundary for ' + label };
    }

    var augmented = prepareAugmentedTriangulation(
      graph.nodeIds,
      graph.edgePairs,
      baseEmbedding,
      outerFace,
      label,
      cfg.augmentationOptions || null
    );
    if (!augmented.ok) {
      return { ok: false, message: augmented.reason || (label + ' augmentation failed') };
    }

    var init = initPositions(augmented.nodeIds, augmented.edgePairs, outerFace, cy, {
      graph: graph,
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
      graph: graph,
      baseEmbedding: baseEmbedding,
      outerFace: outerFace,
      augmented: augmented,
      posById: alignOuterFace(init.pos, outerFace),
      movableVertices: collectMovableVertices(augmented.nodeIds, outerFace),
      initResult: init
    };
  }

  function prepareTriangulatedLayoutContext(cy, config) {
    return prepareTriangulatedLayoutData(graphFromCy(cy), config, cy);
  }

  global.PlanarVibePlanarCommon = {
    faceKey: faceKey,
    graphFromCy: graphFromCy,
    currentPositionsFromCy: currentPositionsFromCy,
    buildAdjacency: buildAdjacency,
    copyPositions: copyPositions,
    polygonArea2: polygonArea2,
    orientFaceCCW: orientFaceCCW,
    alignOuterFace: alignOuterFace,
    outerFaceDiameter: outerFaceDiameter,
    collectMovableVertices: collectMovableVertices,
    prepareAugmentedTriangulation: prepareAugmentedTriangulation,
    originalFaceKeyForAugmentedFace: originalFaceKeyForAugmentedFace,
    createAugmentationDebugState: createAugmentationDebugState,
    prepareTriangulatedLayoutData: prepareTriangulatedLayoutData,
    prepareTriangulatedLayoutContext: prepareTriangulatedLayoutContext
  };
})(window);
