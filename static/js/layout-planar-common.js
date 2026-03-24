(function (global) {
  'use strict';

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

  function graphFromCy(cy) {
    return {
      nodeIds: cy.nodes().map(function (n) { return String(n.id()); }),
      edgePairs: cy.edges().map(function (e) {
        return [String(e.source().id()), String(e.target().id())];
      })
    };
  }

  function currentPositionsFromCy(cy) {
    if (global.PlanarVibeBarycentricCore &&
        typeof global.PlanarVibeBarycentricCore.currentPositionsFromCy === 'function') {
      return global.PlanarVibeBarycentricCore.currentPositionsFromCy(cy);
    }
    var out = {};
    var nodes = cy.nodes().toArray ? cy.nodes().toArray() : cy.nodes();
    for (var i = 0; i < nodes.length; i += 1) {
      var id = String(nodes[i].id());
      var p = nodes[i].position();
      out[id] = { x: p.x, y: p.y };
    }
    return out;
  }

  function buildAdjacency(nodeIds, edgePairs) {
    var adj = {};
    var i;
    for (i = 0; i < nodeIds.length; i += 1) {
      adj[String(nodeIds[i])] = [];
    }
    for (i = 0; i < edgePairs.length; i += 1) {
      var u = String(edgePairs[i][0]);
      var v = String(edgePairs[i][1]);
      if (!adj[u]) adj[u] = [];
      if (!adj[v]) adj[v] = [];
      adj[u].push(v);
      adj[v].push(u);
    }
    return adj;
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

  function buildUniformBarycentricSeed(nodeIds, edgePairs, outerFace, cy, options) {
    var opts = options || {};
    var adjacency = buildAdjacency(nodeIds, edgePairs);
    var weights = global.PlanarVibeBarycentricCore.buildUniformWeights(edgePairs, 1);
    var seedPos = currentPositionsFromCy(cy);
    return global.PlanarVibeBarycentricCore.solveWeightedBarycentricLayout({
      nodeIds: nodeIds,
      adjacency: adjacency,
      outerFace: outerFace,
      weights: weights,
      maxIters: Number.isFinite(opts.maxIters) ? Math.max(1, Math.floor(opts.maxIters)) : 1000,
      tolerance: Number.isFinite(opts.tolerance) ? Math.max(0, opts.tolerance) : 1e-7,
      initOptions: global.PlanarVibeBarycentricCore.defaultOuterInitOptions({
        useSeedOuter: opts.useSeedOuter === true,
        seedPos: seedPos
      })
    });
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

  function prepareAugmentedTriangulation(nodeIds, edgePairs, embedding, outerFace, failureLabel) {
    var augmented = global.PlanarGraphCore.prepareTriangulatedByFaceStellation(nodeIds, edgePairs, embedding, outerFace);
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

  function prepareTriangulatedLayoutContext(cy, config) {
    var cfg = config || {};
    var label = String(cfg.failureLabel || 'Layout');
    var minNodeCount = Number.isFinite(cfg.minNodeCount) ? Math.max(1, Math.floor(cfg.minNodeCount)) : 3;
    var usesDefaultSeed = typeof cfg.initPositions !== 'function';
    var initPositions = usesDefaultSeed
      ? function (nodeIds, edgePairs, outerFace, localCy) {
        return buildUniformBarycentricSeed(nodeIds, edgePairs, outerFace, localCy, cfg.seedOptions || {
          maxIters: 1000,
          tolerance: 1e-7,
          useSeedOuter: false
        });
      }
      : cfg.initPositions;

    if (!global.PlanarVibePlanarityTest || !global.PlanarVibePlanarityTest.computePlanarEmbedding) {
      return { ok: false, message: 'Planarity utilities are missing. Check script load order' };
    }
    if (!global.PlanarGraphCore || !global.PlanarGraphCore.prepareTriangulatedByFaceStellation) {
      return { ok: false, message: 'Planar graph utilities are missing. Check script load order' };
    }
    if (usesDefaultSeed && (!global.PlanarVibeBarycentricCore ||
        !global.PlanarVibeBarycentricCore.buildUniformWeights ||
        !global.PlanarVibeBarycentricCore.solveWeightedBarycentricLayout ||
        !global.PlanarVibeBarycentricCore.currentPositionsFromCy)) {
      return { ok: false, message: 'Barycentric core is missing. Check script load order' };
    }

    var graph = graphFromCy(cy);
    if (graph.nodeIds.length < minNodeCount) {
      return { ok: false, message: label + ' requires at least ' + minNodeCount + ' vertices' };
    }

    var baseEmbedding = global.PlanarVibePlanarityTest.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
    if (!baseEmbedding || !baseEmbedding.ok) {
      return { ok: false, message: label + ' requires a planar graph' };
    }

    var outerFace = global.PlanarGraphCore.chooseOuterFaceFromEmbedding(baseEmbedding);
    if (!outerFace || outerFace.length < 3) {
      return { ok: false, message: 'Could not determine outer boundary for ' + label };
    }

    var augmented = prepareAugmentedTriangulation(graph.nodeIds, graph.edgePairs, baseEmbedding, outerFace, label);
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
      movableVertices: collectMovableVertices(augmented.nodeIds, outerFace)
    };
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
    buildUniformBarycentricSeed: buildUniformBarycentricSeed,
    collectMovableVertices: collectMovableVertices,
    prepareAugmentedTriangulation: prepareAugmentedTriangulation,
    originalFaceKeyForAugmentedFace: originalFaceKeyForAugmentedFace,
    prepareTriangulatedLayoutContext: prepareTriangulatedLayoutContext
  };
})(window);
