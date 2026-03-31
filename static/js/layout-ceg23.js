(function (global) {
  'use strict';

  var PlaygroundUtils = global.PlaygroundUtils;
  var GraphUtils = global.GraphUtils;
  var Tutte = global.PlanarVibeTutteAlgorithm;
  var alignOuterFaceEdgeHorizontally = GraphUtils.alignOuterFaceEdgeHorizontally;
  var buildAdjacencyArrays = GraphUtils.buildAdjacencyArrays;
  var edgeKey = GraphUtils.edgeKey;
  var prepareTriangulatedLayoutData = PlaygroundUtils.prepareTriangulatedLayoutData;

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

  function prepareCEG23State(nodeIds, edgePairs, failureLabel) {
    var ids = (nodeIds || []).map(String);
    var pairs = (edgePairs || []).map(function (edge) { return [String(edge[0]), String(edge[1])]; });
    if (ids.length < 3) {
      return {
        ok: false,
        message: failureLabel + ' requires at least 3 vertices'
      };
    }

    var prepared = prepareTriangulatedLayoutData({
      nodeIds: ids,
      edgePairs: pairs
    }, {
      failureLabel: failureLabel,
      minNodeCount: 3
    });
    if (!prepared || !prepared.ok) {
      return prepared || { ok: false, message: failureLabel + ' requires a planar graph' };
    }

    var augmented = prepared.augmented;
    return {
      ok: true,
      failureLabel: failureLabel,
      ids: ids,
      pairs: pairs,
      prepared: prepared,
      augmented: augmented,
      outerFace: prepared.outerFace,
      augmentedIds: augmented.nodeIds,
      augmentedPairs: augmented.edgePairs,
      adjacency: buildAdjacencyArrays(augmented.nodeIds, augmented.edgePairs)
    };
  }

  function solveAugmentedWeightedLayout(state, weights, maxIters, seedPos) {
    return Tutte.computeBarycentricPositions(
      state.augmentedIds,
      state.augmentedPairs,
      state.outerFace,
      {
        adjacency: state.adjacency,
        weights: weights,
        maxIters: maxIters,
        tolerance: 1e-8,
        initOptions: Tutte.defaultOuterPlacementOptions({
          useSeedOuter: false,
          seedPos: seedPos || null
        })
      }
    );
  }

  function projectCEG23Positions(state, posById, failureLabel) {
    var projected = extractOriginalPositions(posById, state.ids);
    if (global.PlanarVibeMetrics &&
        typeof global.PlanarVibeMetrics.hasCrossingsFromPositions === 'function' &&
        global.PlanarVibeMetrics.hasCrossingsFromPositions(projected, state.pairs)) {
      return {
        ok: false,
        message: failureLabel + ' produced a non-plane drawing'
      };
    }
    return {
      ok: true,
      projected: projected
    };
  }

  function buildCEG23SuccessResult(state, posById, iters, message) {
    var projectedResult = projectCEG23Positions(state, posById, state.failureLabel);
    if (!projectedResult.ok) {
      return projectedResult;
    }

    return {
      ok: true,
      nodeIds: state.ids,
      edgePairs: state.pairs,
      outerFace: state.outerFace,
      graph: state.prepared.graph,
      augmented: state.augmented,
      pos: projectedResult.projected,
      posById: posById,
      iters: iters,
      message: message
    };
  }

  function computeCEG23BfsPositions(nodeIds, edgePairs, options) {
    var opts = options || {};
    var state = prepareCEG23State(nodeIds, edgePairs, 'CEG23-bfs');
    if (!state || !state.ok) {
      return state;
    }

    var A = Number.isFinite(opts.a) && opts.a > 0 ? opts.a : 1.0;
    var R = Number.isFinite(opts.r) && opts.r > 1 ? opts.r : 1.35;
    var MAX_ITERS = Number.isFinite(opts.maxIters) ? Math.max(1, Math.floor(opts.maxIters)) : 4000;
    var DEPTH_SOURCE = String(opts.depthSource || 'outer-multi');
    var EDGE_DEPTH_MODE = String(opts.edgeDepthMode || 'min');

    var depthById = bfsDepthFromOuter(state.augmentedIds, state.adjacency, state.outerFace, DEPTH_SOURCE);
    var weights = buildDepthWeights(state.augmentedPairs, depthById, A, R, EDGE_DEPTH_MODE);
    var out = solveAugmentedWeightedLayout(state, weights, MAX_ITERS, opts.seedPos || null);
    if (!out.ok) {
      return { ok: false, message: out.message || 'CEG23-bfs solver failed' };
    }
    out.pos = alignOuterFaceEdgeHorizontally(out.pos, state.outerFace);

    return buildCEG23SuccessResult(
      state,
      out.pos,
      out.iters,
      'Applied CEG23-bfs (' + state.outerFace.length + '-vertex outer face, depth=' + DEPTH_SOURCE + ', edgeDepth=' + EDGE_DEPTH_MODE + ', r=' + R +
      (state.augmented.dummyCount > 0 ? ', +' + state.augmented.dummyCount + ' dummy vertices' : '') +
      ', ' + out.iters + ' iters)'
    );
  }

  function computeCEG23XyPositions(nodeIds, edgePairs, options) {
    var opts = options || {};
    var state = prepareCEG23State(nodeIds, edgePairs, 'CEG23-xy');
    if (!state || !state.ok) {
      return state;
    }

    var maxIters = Number.isFinite(opts.maxIters) ? Math.max(1, Math.floor(opts.maxIters)) : 2500;
    var alpha = Number.isFinite(opts.alpha) ? opts.alpha : 0.5;
    var beta = Number.isFinite(opts.beta) ? opts.beta : 1.0;
    var lambdaX = Number.isFinite(opts.lambdaX) ? opts.lambdaX : 0.5;

    var uniformWeights = Tutte.buildUniformWeights(state.augmentedPairs, 1);
    var base = solveAugmentedWeightedLayout(state, uniformWeights, maxIters, opts.seedPos || null);
    if (!base.ok) {
      return { ok: false, message: base.message || 'CEG23-xy baseline solve failed' };
    }
    base.pos = alignOuterFaceEdgeHorizontally(base.pos, state.outerFace);

    var xRank = rankByAxis(state.augmentedIds, base.pos, 'x');
    var yRank = rankByAxis(state.augmentedIds, base.pos, 'y');
    var wx = buildSpreadWeights(state.augmentedPairs, xRank, alpha, beta);
    var wy = buildSpreadWeights(state.augmentedPairs, yRank, alpha, beta);
    var wxy = combineWeights(state.augmentedPairs, wx, wy, lambdaX);
    var xySolve = solveAugmentedWeightedLayout(state, wxy, maxIters, base.pos);
    if (!xySolve.ok) {
      return { ok: false, message: xySolve.message || 'CEG23-xy solve failed' };
    }
    xySolve.pos = alignOuterFaceEdgeHorizontally(xySolve.pos, state.outerFace);

    return buildCEG23SuccessResult(
      state,
      xySolve.pos,
      base.iters + xySolve.iters,
      'Applied CEG23-xy (' + state.outerFace.length + '-vertex outer face, alpha=' + alpha + ', beta=' + beta + ', lambdaX=' + Math.max(0, Math.min(1, lambdaX)) +
      (state.augmented.dummyCount > 0 ? ', +' + state.augmented.dummyCount + ' dummy vertices' : '') +
      ', ' + (base.iters + xySolve.iters) + ' total iters)'
    );
  }

  function applyCEG23Layout(cy, options, computeLayout, failureMessage) {
    var graph = PlaygroundUtils.graphFromCy(cy);
    var result = computeLayout(graph.nodeIds, graph.edgePairs, options || {});
    if (!result || !result.ok) {
      return result || { ok: false, message: failureMessage };
    }
    PlaygroundUtils.applyAndFit(cy, result.pos);
    return {
      ok: true,
      message: result.message
    };
  }

  function applyCEG23BfsLayout(cy, options) {
    return applyCEG23Layout(cy, options, computeCEG23BfsPositions, 'CEG23-bfs failed');
  }

  function applyCEG23XyLayout(cy, options) {
    return applyCEG23Layout(cy, options, computeCEG23XyPositions, 'CEG23-xy failed');
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
