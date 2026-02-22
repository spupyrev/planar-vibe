(function (global) {
  'use strict';

  function bfsDepthFromOuter(nodeIds, adjacency, outerFace, depthSource) {
    var depth = {};
    var q = [];
    var head = 0;
    var i;
    var mode = String(depthSource || 'outer-multi');

    for (i = 0; i < nodeIds.length; i += 1) {
      depth[String(nodeIds[i])] = Infinity;
    }
    if (mode === 'outer-single') {
      if (outerFace.length > 0) {
        var first = String(outerFace[0]);
        depth[first] = 0;
        q.push(first);
      }
    } else {
      for (i = 0; i < outerFace.length; i += 1) {
        var root = String(outerFace[i]);
        depth[root] = 0;
        q.push(root);
      }
    }

    while (head < q.length) {
      var u = q[head];
      head += 1;
      var du = depth[u];
      var ngh = adjacency[u] || [];
      for (i = 0; i < ngh.length; i += 1) {
        var v = String(ngh[i]);
        if (depth[v] <= du + 1) continue;
        depth[v] = du + 1;
        q.push(v);
      }
    }

    for (i = 0; i < nodeIds.length; i += 1) {
      var id = String(nodeIds[i]);
      if (!Number.isFinite(depth[id])) {
        depth[id] = 0;
      }
    }
    return depth;
  }

  function buildDepthWeights(edgePairs, depthById, a, r, edgeDepthMode) {
    var weights = {};
    var scale = Number.isFinite(a) && a > 0 ? a : 1;
    var ratio = Number.isFinite(r) && r > 1 ? r : 1.35;
    var mode = String(edgeDepthMode || 'min');
    if (!global.PlanarVibeBarycentricCore || !global.PlanarVibeBarycentricCore.edgeKey) {
      return weights;
    }
    var edgeKey = global.PlanarVibeBarycentricCore.edgeKey;

    for (var i = 0; i < edgePairs.length; i += 1) {
      var u = String(edgePairs[i][0]);
      var v = String(edgePairs[i][1]);
      var du = depthById[u];
      var dv = depthById[v];
      var d;
      if (mode === 'max') {
        d = Math.max(du, dv);
      } else if (mode === 'avg') {
        d = 0.5 * (du + dv);
      } else {
        d = Math.min(du, dv);
      }
      if (!Number.isFinite(d) || d < 0) d = 0;
      var w = scale / Math.pow(ratio, d);
      if (!(w > 0)) w = 1;
      weights[edgeKey(u, v)] = w;
    }
    return weights;
  }

  function sortedNodeIds(nodeIds, posById, axis) {
    return nodeIds.slice().sort(function (a, b) {
      var va = (posById[a] && Number.isFinite(posById[a][axis])) ? posById[a][axis] : 0;
      var vb = (posById[b] && Number.isFinite(posById[b][axis])) ? posById[b][axis] : 0;
      if (Math.abs(va - vb) > 1e-9) {
        return va - vb;
      }
      return String(a).localeCompare(String(b));
    });
  }

  function rankByAxis(nodeIds, posById, axis) {
    var sorted = sortedNodeIds(nodeIds, posById, axis);
    var rank = {};
    for (var i = 0; i < sorted.length; i += 1) {
      rank[String(sorted[i])] = i;
    }
    return rank;
  }

  function buildSpreadWeights(edgePairs, rank, alpha, beta) {
    var a = Number.isFinite(alpha) && alpha > 0 ? alpha : 0.5;
    var b = Number.isFinite(beta) && beta >= 0 ? beta : 1.0;
    var weights = {};
    var ek = global.PlanarVibeBarycentricCore.edgeKey;

    for (var i = 0; i < edgePairs.length; i += 1) {
      var u = String(edgePairs[i][0]);
      var v = String(edgePairs[i][1]);
      var ru = Number(rank[u]);
      var rv = Number(rank[v]);
      var diff = Math.abs(ru - rv);
      var w = a + Math.pow(diff + 1, b);
      if (!Number.isFinite(w) || !(w > 0)) {
        w = 1;
      }
      weights[ek(u, v)] = w;
    }
    return weights;
  }

  function averagePositions(nodeIds, posA, posB) {
    var out = {};
    for (var i = 0; i < nodeIds.length; i += 1) {
      var id = String(nodeIds[i]);
      var pa = posA[id];
      var pb = posB[id];
      if (!pa || !pb) {
        continue;
      }
      out[id] = {
        x: 0.5 * (pa.x + pb.x),
        y: 0.5 * (pa.y + pb.y)
      };
    }
    return out;
  }

  function combineWeights(edgePairs, wA, wB, lambdaA) {
    var out = {};
    var lam = Number.isFinite(lambdaA) ? Math.max(0, Math.min(1, lambdaA)) : 0.5;
    var lamB = 1 - lam;
    var ek = global.PlanarVibeBarycentricCore.edgeKey;
    for (var i = 0; i < edgePairs.length; i += 1) {
      var u = String(edgePairs[i][0]);
      var v = String(edgePairs[i][1]);
      var key = ek(u, v);
      var a = Number.isFinite(wA[key]) ? wA[key] : 1;
      var b = Number.isFinite(wB[key]) ? wB[key] : 1;
      var w = lam * a + lamB * b;
      if (!Number.isFinite(w) || !(w > 0)) {
        w = 1;
      }
      out[key] = w;
    }
    return out;
  }

  function applyCEG23BfsLayout(cy, options) {
    var opts = options || {};
    var tuning = opts.tuning || {};

    if (!global.PlanarVibePlanarityTest || !global.PlanarVibePlanarityTest.computePlanarEmbedding) {
      return { ok: false, message: 'Planarity utilities are missing' };
    }
    if (!global.PlanarGraphCore || typeof global.PlanarGraphCore.graphFromCy !== 'function') {
      return { ok: false, message: 'PlanarGraphCore is missing. Check script load order' };
    }
    if (!global.PlanarVibeBarycentricCore || !global.PlanarVibeBarycentricCore.solveWeightedBarycentricLayout) {
      return { ok: false, message: 'Barycentric core is missing. Check script load order' };
    }

    var nodes = cy.nodes().toArray();
    if (nodes.length < 3) {
      return { ok: false, message: 'CEG23-bfs requires at least 3 vertices' };
    }

    var graph = global.PlanarGraphCore.graphFromCy(cy);
    var nodeIds = graph.nodeIds.slice().map(String);
    var edgePairs = cy.edges().map(function (e) {
      return [String(e.source().id()), String(e.target().id())];
    });

    var emb = global.PlanarVibePlanarityTest.computePlanarEmbedding(nodeIds, edgePairs);
    if (!emb || !emb.ok) {
      return { ok: false, message: 'CEG23-bfs requires a planar graph' };
    }

    var outerFace = graph.chooseOuterFace();
    if (!outerFace || outerFace.length < 3) {
      return { ok: false, message: 'Could not determine outer face' };
    }

    var A = Number.isFinite(tuning.a) && tuning.a > 0 ? tuning.a : 1.0;
    var R = Number.isFinite(tuning.r) && tuning.r > 1 ? tuning.r : 1.35;
    var MAX_ITERS = Number.isFinite(tuning.maxIters) ? Math.max(1, Math.floor(tuning.maxIters)) : 4000;
    var DEPTH_SOURCE = String(tuning.depthSource || 'outer-multi');
    var EDGE_DEPTH_MODE = String(tuning.edgeDepthMode || 'min');

    var depthById = bfsDepthFromOuter(nodeIds, graph.adjacency, outerFace, DEPTH_SOURCE);
    var weights = buildDepthWeights(edgePairs, depthById, A, R, EDGE_DEPTH_MODE);
    var out = global.PlanarVibeBarycentricCore.solveWeightedBarycentricLayout({
      nodeIds: nodeIds,
      adjacency: graph.adjacency,
      outerFace: outerFace,
      weights: weights,
      maxIters: MAX_ITERS,
      tolerance: 1e-8,
      initOptions: {
        useSeedOuter: true,
        seedPos: global.PlanarVibeBarycentricCore.currentPositionsFromCy(cy)
      }
    });
    if (!out.ok) {
      return { ok: false, message: out.message || 'CEG23-bfs solver failed' };
    }

    for (var i = 0; i < nodes.length; i += 1) {
      var id = String(nodes[i].id());
      if (out.pos[id]) {
        nodes[i].position(out.pos[id]);
      }
    }
    cy.fit(undefined, 24);

    return {
      ok: true,
      message: 'Applied CEG23-bfs (' + outerFace.length + '-vertex outer face, depth=' + DEPTH_SOURCE + ', edgeDepth=' + EDGE_DEPTH_MODE + ', r=' + R + ', ' + out.iters + ' iters)'
    };
  }

  function applyCEG23XyLayout(cy, options) {
    var opts = options || {};
    var tuning = opts.tuning || {};

    if (!global.PlanarVibePlanarityTest || !global.PlanarVibePlanarityTest.computePlanarEmbedding) {
      return { ok: false, message: 'Planarity utilities are missing' };
    }
    if (!global.PlanarGraphCore || typeof global.PlanarGraphCore.graphFromCy !== 'function') {
      return { ok: false, message: 'PlanarGraphCore is missing. Check script load order' };
    }
    if (!global.PlanarVibeBarycentricCore || !global.PlanarVibeBarycentricCore.solveWeightedBarycentricLayout) {
      return { ok: false, message: 'Barycentric core is missing. Check script load order' };
    }

    var nodes = cy.nodes().toArray();
    if (nodes.length < 3) {
      return { ok: false, message: 'CEG23-xy requires at least 3 vertices' };
    }

    var graph = global.PlanarGraphCore.graphFromCy(cy);
    var nodeIds = graph.nodeIds.slice().map(String);
    var edgePairs = cy.edges().map(function (e) {
      return [String(e.source().id()), String(e.target().id())];
    });
    var emb = global.PlanarVibePlanarityTest.computePlanarEmbedding(nodeIds, edgePairs);
    if (!emb || !emb.ok) {
      return { ok: false, message: 'CEG23-xy requires a planar graph' };
    }

    var outerFace = graph.chooseOuterFace();
    if (!outerFace || outerFace.length < 3) {
      return { ok: false, message: 'Could not determine outer face' };
    }

    var maxIters = Number.isFinite(tuning.maxIters) ? Math.max(1, Math.floor(tuning.maxIters)) : 2500;
    var alpha = Number.isFinite(tuning.alpha) ? tuning.alpha : 0.5;
    var beta = Number.isFinite(tuning.beta) ? tuning.beta : 1.0;
    var lambdaX = Number.isFinite(tuning.lambdaX) ? tuning.lambdaX : 0.5;

    var seed = global.PlanarVibeBarycentricCore.currentPositionsFromCy(cy);
    var uniformWeights = global.PlanarVibeBarycentricCore.buildUniformWeights(edgePairs, 1);
    var base = global.PlanarVibeBarycentricCore.solveWeightedBarycentricLayout({
      nodeIds: nodeIds,
      adjacency: graph.adjacency,
      outerFace: outerFace,
      weights: uniformWeights,
      maxIters: maxIters,
      tolerance: 1e-8,
      initOptions: {
        useSeedOuter: true,
        seedPos: seed
      }
    });
    if (!base.ok) {
      return { ok: false, message: base.message || 'CEG23-xy baseline solve failed' };
    }

    var xRank = rankByAxis(nodeIds, base.pos, 'x');
    var yRank = rankByAxis(nodeIds, base.pos, 'y');
    var wx = buildSpreadWeights(edgePairs, xRank, alpha, beta);
    var wy = buildSpreadWeights(edgePairs, yRank, alpha, beta);
    var wxy = combineWeights(edgePairs, wx, wy, lambdaX);
    var xySolve = global.PlanarVibeBarycentricCore.solveWeightedBarycentricLayout({
      nodeIds: nodeIds,
      adjacency: graph.adjacency,
      outerFace: outerFace,
      weights: wxy,
      maxIters: maxIters,
      tolerance: 1e-8,
      initOptions: {
        useSeedOuter: true,
        seedPos: base.pos
      }
    });
    if (!xySolve.ok) {
      return { ok: false, message: xySolve.message || 'CEG23-xy solve failed' };
    }

    for (var i = 0; i < nodes.length; i += 1) {
      var id = String(nodes[i].id());
      if (xySolve.pos[id]) {
        nodes[i].position(xySolve.pos[id]);
      }
    }
    cy.fit(undefined, 24);

    return {
      ok: true,
      message: 'Applied CEG23-xy (' + outerFace.length + '-vertex outer face, alpha=' + alpha + ', beta=' + beta + ', lambdaX=' + Math.max(0, Math.min(1, lambdaX)) + ', ' + (base.iters + xySolve.iters) + ' total iters)'
    };
  }

  global.PlanarVibeCEG23Bfs = {
    applyCEG23BfsLayout: applyCEG23BfsLayout
  };
  global.PlanarVibeCEG23Xy = {
    applyCEG23XyLayout: applyCEG23XyLayout
  };
})(window);
