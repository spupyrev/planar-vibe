(function (global) {
  'use strict';

  function buildAdjacency(nodeIds, edgePairs) {
    var adj = {};
    for (var i = 0; i < nodeIds.length; i += 1) {
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

  function extractOriginalPositions(posById, nodeIds) {
    var out = {};
    for (var i = 0; i < nodeIds.length; i += 1) {
      var id = String(nodeIds[i]);
      if (posById[id]) {
        out[id] = { x: posById[id].x, y: posById[id].y };
      }
    }
    return out;
  }

  function applyTutteLayout(cy) {
    var nodes = cy.nodes().toArray();
    if (nodes.length < 3) {
      return {
        ok: false,
        message: 'Tutte requires at least 3 vertices'
      };
    }

    if (!global.PlanarVibePlanarityTest || !global.PlanarVibePlanarityTest.computePlanarEmbedding) {
      return {
        ok: false,
        message: 'Planarity utilities are missing. Check script load order'
      };
    }
    if (!global.PlanarGraphCore || !global.PlanarGraphCore.prepareTriangulatedByFaceStellation) {
      return {
        ok: false,
        message: 'PlanarGraphCore is missing. Check script load order'
      };
    }
    if (!global.PlanarVibeBarycentricCore || !global.PlanarVibeBarycentricCore.solveWeightedBarycentricLayout) {
      return {
        ok: false,
        message: 'Barycentric core is missing. Check script load order'
      };
    }

    var nodeIds = cy.nodes().map(function (n) { return String(n.id()); });
    var edgePairs = cy.edges().map(function (e) {
      return [String(e.source().id()), String(e.target().id())];
    });

    var embedding = global.PlanarVibePlanarityTest.computePlanarEmbedding(nodeIds, edgePairs);
    if (!embedding || !embedding.ok) {
      return {
        ok: false,
        message: 'Tutte requires a planar graph'
      };
    }

    var outerFace = global.PlanarGraphCore.chooseOuterFaceFromEmbedding(embedding);
    if (!outerFace || outerFace.length < 3) {
      return {
        ok: false,
        message: 'Could not determine outer face for Tutte'
      };
    }
    var prepared = global.PlanarGraphCore.prepareTriangulatedByFaceStellation(nodeIds, edgePairs, embedding, outerFace);
    if (!prepared || !prepared.ok) {
      return {
        ok: false,
        message: (prepared && prepared.reason) || 'Could not build a triangulated embedding for Tutte'
      };
    }
    var solveNodeIds = prepared.nodeIds.map(String);
    var solveEdgePairs = prepared.edgePairs.map(function (e) { return [String(e[0]), String(e[1])]; });
    var solveEmbedding = prepared.embedding;
    var solveAdj = buildAdjacency(solveNodeIds, solveEdgePairs);
    var weights = global.PlanarVibeBarycentricCore.buildUniformWeights(solveEdgePairs, 1);
    var attempts = [
      { maxIters: 1000, tolerance: 1e-6 },
      { maxIters: 1000, tolerance: 1e-7 },
      { maxIters: 2000, tolerance: 1e-8 }
    ];
    var out = null;
    var hasCrossings = false;
    for (var ai = 0; ai < attempts.length; ai += 1) {
      var attempt = attempts[ai];
      out = global.PlanarVibeBarycentricCore.solveWeightedBarycentricLayout({
        nodeIds: solveNodeIds,
        adjacency: solveAdj,
        outerFace: outerFace,
        weights: weights,
        maxIters: attempt.maxIters,
        tolerance: attempt.tolerance,
        initOptions: global.PlanarVibeBarycentricCore.defaultOuterInitOptions({
          useSeedOuter: false
        })
      });
      if (!out.ok) {
        break;
      }
      hasCrossings = !!(global.PlanarVibeMetrics &&
        typeof global.PlanarVibeMetrics.hasCrossingsFromPositions === 'function' &&
        global.PlanarVibeMetrics.hasCrossingsFromPositions(
          extractOriginalPositions(out.pos, nodeIds),
          edgePairs
        ));
      if (!hasCrossings) {
        break;
      }
    }
    if (!out.ok) {
      return {
        ok: false,
        message: out.message || 'Tutte solver failed'
      };
    }
    if (global.PlanarGraphCore && typeof global.PlanarGraphCore.alignOuterFaceEdgeHorizontally === 'function') {
      out.pos = global.PlanarGraphCore.alignOuterFaceEdgeHorizontally(out.pos, outerFace);
    }
    if (hasCrossings) {
      return {
        ok: false,
        message: 'Tutte produced a non-plane drawing'
      };
    }

    for (var i = 0; i < nodes.length; i += 1) {
      var nodeId = nodes[i].id();
      if (out.pos[nodeId]) {
        nodes[i].position(out.pos[nodeId]);
      }
    }
    cy.fit(undefined, 24);

    return {
      ok: true,
      message: 'Applied Tutte (' + outerFace.length + '-vertex outer face, ' + out.iters + ' iters)'
    };
  }

  global.PlanarVibeTutte = {
    applyTutteLayout: applyTutteLayout
  };
})(window);
