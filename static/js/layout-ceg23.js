(function (global) {
  'use strict';

  var PlaygroundUtils = global.PlaygroundUtils || {};
  var GraphCore = global.GraphUtils || {};
  var Tutte = global.PlanarVibeTutteAlgorithm || {};
  var PlanarityTest = global.PlanarVibePlanarityTest || {};
  var buildAdjacency = GraphCore.buildAdjacency;
  var edgeKey = GraphCore.edgeKey;
  var chooseOuterFaceFromEmbedding = GraphCore.chooseOuterFaceFromEmbedding;
  var computePlanarEmbedding = PlanarityTest.computePlanarEmbedding;

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
    if (!edgeKey) {
      return weights;
    }

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
    var ek = edgeKey;

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

  function combineWeights(edgePairs, wA, wB, lambdaA) {
    var out = {};
    var lam = Number.isFinite(lambdaA) ? Math.max(0, Math.min(1, lambdaA)) : 0.5;
    var lamB = 1 - lam;
    var ek = edgeKey;
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

  function computeCEG23BfsPositions(nodeIds, edgePairs, options) {
    var opts = options || {};

    var ids = (nodeIds || []).map(String);
    var pairs = (edgePairs || []).map(function (edge) { return [String(edge[0]), String(edge[1])]; });
    if (ids.length < 3) {
      return { ok: false, message: 'CEG23-bfs requires at least 3 vertices' };
    }

    var adjacency = buildAdjacency(ids, pairs);
    var emb = computePlanarEmbedding(ids, pairs);
    if (!emb || !emb.ok) {
      return { ok: false, message: 'CEG23-bfs requires a planar graph' };
    }

    var outerFace = chooseOuterFaceFromEmbedding(emb);
    if (!outerFace || outerFace.length < 3) {
      return { ok: false, message: 'Could not determine outer face' };
    }

    var A = Number.isFinite(opts.a) && opts.a > 0 ? opts.a : 1.0;
    var R = Number.isFinite(opts.r) && opts.r > 1 ? opts.r : 1.35;
    var MAX_ITERS = Number.isFinite(opts.maxIters) ? Math.max(1, Math.floor(opts.maxIters)) : 4000;
    var DEPTH_SOURCE = String(opts.depthSource || 'outer-multi');
    var EDGE_DEPTH_MODE = String(opts.edgeDepthMode || 'min');

    var depthById = bfsDepthFromOuter(ids, adjacency, outerFace, DEPTH_SOURCE);
    var weights = buildDepthWeights(pairs, depthById, A, R, EDGE_DEPTH_MODE);
    var out = Tutte.computeBarycentricPositions(
      ids,
      pairs,
      outerFace,
      {
        adjacency: adjacency,
        weights: weights,
        maxIters: MAX_ITERS,
        tolerance: 1e-8,
        initOptions: Tutte.defaultOuterPlacementOptions({
          useSeedOuter: false,
          seedPos: opts.seedPos || null
        })
      }
    );
    if (!out.ok) {
      return { ok: false, message: out.message || 'CEG23-bfs solver failed' };
    }
    out.pos = PlaygroundUtils.alignOuterFace(out.pos, outerFace);

    return {
      ok: true,
      nodeIds: ids,
      edgePairs: pairs,
      outerFace: outerFace,
      pos: out.pos,
      iters: out.iters,
      message: 'Applied CEG23-bfs (' + outerFace.length + '-vertex outer face, depth=' + DEPTH_SOURCE + ', edgeDepth=' + EDGE_DEPTH_MODE + ', r=' + R + ', ' + out.iters + ' iters)'
    };
  }

  function computeCEG23XyPositions(nodeIds, edgePairs, options) {
    var opts = options || {};

    var ids = (nodeIds || []).map(String);
    var pairs = (edgePairs || []).map(function (edge) { return [String(edge[0]), String(edge[1])]; });
    if (ids.length < 3) {
      return { ok: false, message: 'CEG23-xy requires at least 3 vertices' };
    }

    var adjacency = buildAdjacency(ids, pairs);
    var emb = computePlanarEmbedding(ids, pairs);
    if (!emb || !emb.ok) {
      return { ok: false, message: 'CEG23-xy requires a planar graph' };
    }

    var outerFace = chooseOuterFaceFromEmbedding(emb);
    if (!outerFace || outerFace.length < 3) {
      return { ok: false, message: 'Could not determine outer face' };
    }

    var maxIters = Number.isFinite(opts.maxIters) ? Math.max(1, Math.floor(opts.maxIters)) : 2500;
    var alpha = Number.isFinite(opts.alpha) ? opts.alpha : 0.5;
    var beta = Number.isFinite(opts.beta) ? opts.beta : 1.0;
    var lambdaX = Number.isFinite(opts.lambdaX) ? opts.lambdaX : 0.5;

    var seed = opts.seedPos || null;
    var uniformWeights = Tutte.buildUniformWeights(pairs, 1);
    var base = Tutte.computeBarycentricPositions(
      ids,
      pairs,
      outerFace,
      {
        adjacency: adjacency,
        weights: uniformWeights,
        maxIters: maxIters,
        tolerance: 1e-8,
        initOptions: Tutte.defaultOuterPlacementOptions({
          useSeedOuter: false,
          seedPos: seed
        })
      }
    );
    if (!base.ok) {
      return { ok: false, message: base.message || 'CEG23-xy baseline solve failed' };
    }
    base.pos = PlaygroundUtils.alignOuterFace(base.pos, outerFace);

    var xRank = rankByAxis(ids, base.pos, 'x');
    var yRank = rankByAxis(ids, base.pos, 'y');
    var wx = buildSpreadWeights(pairs, xRank, alpha, beta);
    var wy = buildSpreadWeights(pairs, yRank, alpha, beta);
    var wxy = combineWeights(pairs, wx, wy, lambdaX);
    var xySolve = Tutte.computeBarycentricPositions(
      ids,
      pairs,
      outerFace,
      {
        adjacency: adjacency,
        weights: wxy,
        maxIters: maxIters,
        tolerance: 1e-8,
        initOptions: Tutte.defaultOuterPlacementOptions({
          useSeedOuter: false,
          seedPos: base.pos
        })
      }
    );
    if (!xySolve.ok) {
      return { ok: false, message: xySolve.message || 'CEG23-xy solve failed' };
    }
    xySolve.pos = PlaygroundUtils.alignOuterFace(xySolve.pos, outerFace);

    return {
      ok: true,
      nodeIds: ids,
      edgePairs: pairs,
      outerFace: outerFace,
      pos: xySolve.pos,
      iters: base.iters + xySolve.iters,
      message: 'Applied CEG23-xy (' + outerFace.length + '-vertex outer face, alpha=' + alpha + ', beta=' + beta + ', lambdaX=' + Math.max(0, Math.min(1, lambdaX)) + ', ' + (base.iters + xySolve.iters) + ' total iters)'
    };
  }

  function applyCEG23BfsLayout(cy, options) {
    if (!PlaygroundUtils || typeof PlaygroundUtils.graphFromCy !== 'function' || typeof PlaygroundUtils.currentPositionsFromCy !== 'function' || typeof PlaygroundUtils.alignOuterFace !== 'function') {
      return { ok: false, message: 'Shared planar utilities are missing. Check script load order' };
    }
    if (typeof buildAdjacency !== 'function' || typeof edgeKey !== 'function' || typeof chooseOuterFaceFromEmbedding !== 'function') {
      return { ok: false, message: 'GraphUtils is missing. Check script load order' };
    }
    if (typeof computePlanarEmbedding !== 'function') {
      return { ok: false, message: 'Planarity utilities are missing. Check script load order' };
    }
    if (!Tutte || typeof Tutte.computeBarycentricPositions !== 'function' || typeof Tutte.buildUniformWeights !== 'function' || typeof Tutte.defaultOuterPlacementOptions !== 'function') {
      return { ok: false, message: 'Tutte algorithm is missing. Check script load order' };
    }
    var graph = PlaygroundUtils.graphFromCy(cy);
    var result = computeCEG23BfsPositions(graph.nodeIds, graph.edgePairs, Object.assign({}, options || {}, {
      seedPos: PlaygroundUtils.currentPositionsFromCy(cy)
    }));
    if (!result || !result.ok) {
      return result || { ok: false, message: 'CEG23-bfs failed' };
    }
    if (typeof PlaygroundUtils.applyAndFit === 'function') {
      PlaygroundUtils.applyAndFit(cy, result.pos, 24);
    } else {
      var nodes = cy.nodes().toArray();
      for (var i = 0; i < nodes.length; i += 1) {
        var id = String(nodes[i].id());
        if (result.pos[id]) {
          nodes[i].position(result.pos[id]);
        }
      }
      cy.fit(undefined, 24);
    }
    return {
      ok: true,
      message: result.message
    };
  }

  function applyCEG23XyLayout(cy, options) {
    if (!PlaygroundUtils || typeof PlaygroundUtils.graphFromCy !== 'function' || typeof PlaygroundUtils.currentPositionsFromCy !== 'function' || typeof PlaygroundUtils.alignOuterFace !== 'function') {
      return { ok: false, message: 'Shared planar utilities are missing. Check script load order' };
    }
    if (typeof buildAdjacency !== 'function' || typeof edgeKey !== 'function' || typeof chooseOuterFaceFromEmbedding !== 'function') {
      return { ok: false, message: 'GraphUtils is missing. Check script load order' };
    }
    if (typeof computePlanarEmbedding !== 'function') {
      return { ok: false, message: 'Planarity utilities are missing. Check script load order' };
    }
    if (!Tutte || typeof Tutte.computeBarycentricPositions !== 'function' || typeof Tutte.buildUniformWeights !== 'function' || typeof Tutte.defaultOuterPlacementOptions !== 'function') {
      return { ok: false, message: 'Tutte algorithm is missing. Check script load order' };
    }
    var graph = PlaygroundUtils.graphFromCy(cy);
    var result = computeCEG23XyPositions(graph.nodeIds, graph.edgePairs, Object.assign({}, options || {}, {
      seedPos: PlaygroundUtils.currentPositionsFromCy(cy)
    }));
    if (!result || !result.ok) {
      return result || { ok: false, message: 'CEG23-xy failed' };
    }
    if (typeof PlaygroundUtils.applyAndFit === 'function') {
      PlaygroundUtils.applyAndFit(cy, result.pos, 24);
    } else {
      var nodes = cy.nodes().toArray();
      for (var i = 0; i < nodes.length; i += 1) {
        var id = String(nodes[i].id());
        if (result.pos[id]) {
          nodes[i].position(result.pos[id]);
        }
      }
      cy.fit(undefined, 24);
    }
    return {
      ok: true,
      message: result.message
    };
  }

  global.PlanarVibeCEG23Bfs = {
    computeCEG23BfsPositions: computeCEG23BfsPositions,
    applyCEG23BfsLayout: applyCEG23BfsLayout
  };
  global.PlanarVibeCEG23Xy = {
    computeCEG23XyPositions: computeCEG23XyPositions,
    applyCEG23XyLayout: applyCEG23XyLayout
  };
})(window);
