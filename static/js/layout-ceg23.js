(function (global) {
  'use strict';

  var LayoutPreprocessing = global.LayoutPreprocessing;
  var CyRuntime = global.CyRuntime;
  var GeometryUtils = global.GeometryUtils;
  var GraphUtils = global.GraphUtils;
  var Tutte = global.PlanarVibeTutteAlgorithm;
  var alignOuterFaceEdgeHorizontally = GeometryUtils.alignOuterFaceEdgeHorizontally;
  var buildLayoutError = GraphUtils.buildLayoutError;
  var buildLayoutResult = GraphUtils.buildLayoutResult;
  var edgeKey = GraphUtils.edgeKey;
  var filterPositions = GeometryUtils.filterPositionMap;
  var hasPositionCrossings = GeometryUtils.hasPositionCrossings;
  var resolveFiniteOption = GraphUtils.resolveFiniteOption;
  var resolveGreaterThanOption = GraphUtils.resolveGreaterThanOption;
  var resolveIntOption = GraphUtils.resolveIntOption;
  var resolvePositiveOption = GraphUtils.resolvePositiveOption;
  var prepareGraphAndLayoutData = LayoutPreprocessing.prepareGraphAndLayoutData;

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

  function prepareCEG23State(graph, failureLabel, options) {
    var prepared = prepareGraphAndLayoutData(graph, {
      failureLabel: failureLabel,
      augmentationMethod: options && options.augmentationMethod ? options.augmentationMethod : null
    });
    if (!prepared || !prepared.ok) {
      return buildLayoutError(prepared || {
        message: failureLabel + ' requires a planar graph'
      });
    }

    var baseGraph = prepared.graph;
    var ids = baseGraph.nodeIds;
    var pairs = baseGraph.edgePairs;
    var augmented = prepared.augmented;
    return buildLayoutResult({
      ok: true,
      failureLabel: failureLabel,
      ids: ids,
      pairs: pairs,
      prepared: prepared,
      augmented: augmented,
      augmentedGraph: prepared.augmentedGraph,
      outerFace: prepared.outerFace,
      augmentedOuterFace: prepared.augmentedOuterFace || prepared.outerFace,
      augmentedIds: augmented.graph.nodeIds,
      augmentedPairs: augmented.graph.edgePairs,
      adjacency: prepared.augmentedGraph.adjacency
    });
  }

  function solveAugmentedWeightedLayout(state, weights, maxIters) {
    return Tutte.computeBarycentricPositions(
      state.augmentedGraph,
      state.augmentedOuterFace,
      {
        adjacency: state.adjacency,
        weights: weights,
        maxIters: maxIters,
        tolerance: 1e-8,
        initOptions: Tutte.defaultOuterPlacementOptions()
      }
    );
  }

  function projectCEG23Positions(state, posById, failureLabel) {
    var projected = filterPositions(posById, state.ids);
    if (hasPositionCrossings(projected, state.pairs)) {
      return buildLayoutError({
        message: failureLabel + ' produced a non-plane drawing'
      });
    }
    return buildLayoutResult({
      ok: true,
      projected: projected
    });
  }

  function buildCEG23SuccessResult(state, posById, iters, message) {
    var projectedResult = projectCEG23Positions(state, posById, state.failureLabel);
    if (!projectedResult.ok) {
      return projectedResult;
    }

    return buildLayoutResult({
      ok: true,
      nodeIds: state.ids,
      edgePairs: state.pairs,
      outerFace: state.outerFace,
      graph: state.prepared.graph,
      augmented: state.augmented,
      positions: projectedResult.projected,
      posById: posById,
      iters: iters,
      message: message
    });
  }

  function computeCEG23BfsPositions(graph, options) {
    var opts = options || {};
    var state = prepareCEG23State(graph, 'CEG23-bfs', opts);
    if (!state || !state.ok) {
      return state;
    }

    var A = resolvePositiveOption(opts.a, 1.0);
    var R = resolveGreaterThanOption(opts.r, 1.35, 1);
    var MAX_ITERS = resolveIntOption(opts.maxIters, 4000, 1);
    var DEPTH_SOURCE = String(opts.depthSource || 'outer-multi');
    var EDGE_DEPTH_MODE = String(opts.edgeDepthMode || 'min');

    var depthById = bfsDepthFromOuter(state.augmentedIds, state.adjacency, state.augmentedOuterFace, DEPTH_SOURCE);
    var weights = buildDepthWeights(state.augmentedPairs, depthById, A, R, EDGE_DEPTH_MODE);
    var out = solveAugmentedWeightedLayout(state, weights, MAX_ITERS);
    if (!out.ok) {
      return buildLayoutError({
        message: out.message || 'CEG23-bfs solver failed',
        graph: state.prepared.graph,
        outerFace: state.augmentedOuterFace,
        augmented: state.augmented
      });
    }
    out.positions = alignOuterFaceEdgeHorizontally(out.positions, state.augmentedOuterFace);

    return buildCEG23SuccessResult(
      state,
      out.positions,
      out.iters,
      'Applied CEG23-bfs (' + state.augmentedOuterFace.length + '-vertex outer face, depth=' + DEPTH_SOURCE + ', edgeDepth=' + EDGE_DEPTH_MODE + ', r=' + R +
      (state.augmented.dummyCount > 0 ? ', +' + state.augmented.dummyCount + ' dummy vertices' : '') +
      ', ' + out.iters + ' iters)'
    );
  }

  function computeCEG23XyPositions(graph, options) {
    var opts = options || {};
    var state = prepareCEG23State(graph, 'CEG23-xy', opts);
    if (!state || !state.ok) {
      return state;
    }

    var maxIters = resolveIntOption(opts.maxIters, 2500, 1);
    var alpha = resolveFiniteOption(opts.alpha, 0.5);
    var beta = resolveFiniteOption(opts.beta, 1.0);
    var lambdaX = resolveFiniteOption(opts.lambdaX, 0.5);

    var uniformWeights = Tutte.buildUniformWeights(state.augmentedPairs, 1);
    var base = solveAugmentedWeightedLayout(state, uniformWeights, maxIters);
    if (!base.ok) {
      return buildLayoutError({
        message: base.message || 'CEG23-xy baseline solve failed',
        graph: state.prepared.graph,
        outerFace: state.augmentedOuterFace,
        augmented: state.augmented
      });
    }
    base.positions = alignOuterFaceEdgeHorizontally(base.positions, state.augmentedOuterFace);

    var xRank = rankByAxis(state.augmentedIds, base.positions, 'x');
    var yRank = rankByAxis(state.augmentedIds, base.positions, 'y');
    var wx = buildSpreadWeights(state.augmentedPairs, xRank, alpha, beta);
    var wy = buildSpreadWeights(state.augmentedPairs, yRank, alpha, beta);
    var wxy = combineWeights(state.augmentedPairs, wx, wy, lambdaX);
    var xySolve = solveAugmentedWeightedLayout(state, wxy, maxIters, base.positions);
    if (!xySolve.ok) {
      return buildLayoutError({
        message: xySolve.message || 'CEG23-xy solve failed',
        graph: state.prepared.graph,
        outerFace: state.augmentedOuterFace,
        augmented: state.augmented
      });
    }
    xySolve.positions = alignOuterFaceEdgeHorizontally(xySolve.positions, state.augmentedOuterFace);

    return buildCEG23SuccessResult(
      state,
      xySolve.positions,
      base.iters + xySolve.iters,
      'Applied CEG23-xy (' + state.augmentedOuterFace.length + '-vertex outer face, alpha=' + alpha + ', beta=' + beta + ', lambdaX=' + Math.max(0, Math.min(1, lambdaX)) +
      (state.augmented.dummyCount > 0 ? ', +' + state.augmented.dummyCount + ' dummy vertices' : '') +
      ', ' + (base.iters + xySolve.iters) + ' total iters)'
    );
  }

  function applyCEG23Layout(cy, options, computeLayout, failureMessage) {
    return CyRuntime.runLayout(cy, options || {}, {
      compute: computeLayout,
      buildResult: function (ctx) {
        return {
          ok: true,
          message: ctx.result.message
        };
      },
      failureMessage: failureMessage
    });
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
