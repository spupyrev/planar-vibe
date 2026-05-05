(function (global) {
  'use strict';

  var LayoutPreprocessing = global.LayoutPreprocessing;
  var CyRuntime = global.CyRuntime;
  var GeometryUtils = global.GeometryUtils;
  var GraphUtils = global.GraphUtils;
  var Tutte = global.PlanarVibeTutte;
  var createAugmentationDebugState = LayoutPreprocessing.createAugmentationDebugState;
  var buildLayoutError = GraphUtils.buildLayoutError;
  var buildLayoutResult = GraphUtils.buildLayoutResult;
  var edgeKey = GraphUtils.edgeKey;
  var computeFaceCentroid = GeometryUtils.computeFaceCentroid;
  var filterPositions = GeometryUtils.filterPositionMap;
  var hasPositionCrossings = GeometryUtils.hasPositionCrossings;
  var rotatePositionMap = GeometryUtils.rotatePositionMap;
  var prepareGraphAndLayoutData = LayoutPreprocessing.prepareGraphAndLayoutData;
  var CEG_CONFIG = {
    bfsBaseWeight: 1.0,
    bfsDepthRatio: 1.35,
    xyLambda: 0.5
  };

  function buildUniformWeights(edgePairs, value) {
    var weights = {};
    var w = Number.isFinite(value) && value > 0 ? value : 1;
    for (var i = 0; i < edgePairs.length; i += 1) {
      var u = edgePairs[i][0];
      var v = edgePairs[i][1];
      weights[edgeKey(u, v)] = w;
    }
    return weights;
  }

  function bfsDepthFromOuter(nodeIds, adjacency, outerFace) {
    var depth = {};
    var q = [];
    var head = 0;
    var i;

    for (i = 0; i < nodeIds.length; i += 1) {
      depth[String(nodeIds[i])] = Infinity;
    }
    for (i = 0; i < outerFace.length; i += 1) {
      var root = String(outerFace[i]);
      depth[root] = 0;
      q.push(root);
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

  function buildDepthWeights(edgePairs, depthById, a, r) {
    var weights = {};
    var scale = Number.isFinite(a) && a > 0 ? a : 1;
    var ratio = Number.isFinite(r) && r > 1 ? r : 1.35;

    for (var i = 0; i < edgePairs.length; i += 1) {
      var u = String(edgePairs[i][0]);
      var v = String(edgePairs[i][1]);
      var du = depthById[u];
      var dv = depthById[v];
      var d = 1 + Math.min(du, dv);
      if (!Number.isFinite(d) || d < 0) d = 0;
      var w = scale / Math.pow(ratio, d);
      if (!(w > 0)) w = 1;
      weights[edgeKey(u, v)] = w;
    }
    return weights;
  }

  function hasVerticalSpreadEdge(edgePairs, posById, epsilon) {
    var tol = Number.isFinite(epsilon) && epsilon > 0 ? epsilon : 1e-7;
    for (var i = 0; i < edgePairs.length; i += 1) {
      var u = String(edgePairs[i][0]);
      var v = String(edgePairs[i][1]);
      var pu = posById[u];
      var pv = posById[v];
      if (!pu || !pv) continue;
      if (Math.abs(pu.x - pv.x) <= tol) {
        return true;
      }
    }
    return false;
  }

  function rotateForSpread(nodeIds, edgePairs, posById) {
    var center = computeFaceCentroid(posById, nodeIds);
    var angles = [
      0,
      1e-6, -1e-6,
      1e-5, -1e-5,
      1e-4, -1e-4,
      1e-3, -1e-3,
      1e-2, -1e-2,
      Math.PI / 180, -Math.PI / 180
    ];
    for (var i = 0; i < angles.length; i += 1) {
      var rotated = rotatePositionMap(posById, center, angles[i]);
      if (!hasVerticalSpreadEdge(edgePairs, rotated, 1e-7)) {
        return rotated;
      }
    }
    return rotatePositionMap(posById, center, 1e-2);
  }

  function buildFixedOuterPositions(outerFace, posById) {
    return filterPositions(posById, outerFace);
  }

  function buildSpreadOrientation(nodeIds, edgePairs, posById) {
    var sorted = sortedNodeIds(nodeIds, posById, 'x');
    var order = {};
    var outAdj = {};
    var inAdj = {};
    var outDegree = {};
    var inDegree = {};
    var edgeDir = {};
    var i;

    for (i = 0; i < sorted.length; i += 1) {
      var id = String(sorted[i]);
      order[id] = i;
      outAdj[id] = [];
      inAdj[id] = [];
      outDegree[id] = 0;
      inDegree[id] = 0;
    }

    for (i = 0; i < edgePairs.length; i += 1) {
      var a = String(edgePairs[i][0]);
      var b = String(edgePairs[i][1]);
      var u = order[a] < order[b] ? a : b;
      var v = u === a ? b : a;
      outAdj[u].push(v);
      inAdj[v].push(u);
      outDegree[u] += 1;
      inDegree[v] += 1;
      edgeDir[edgeKey(a, b)] = { from: u, to: v };
    }

    return {
      sorted: sorted,
      order: order,
      source: String(sorted[0]),
      sink: String(sorted[sorted.length - 1]),
      outAdj: outAdj,
      inAdj: inAdj,
      outDegree: outDegree,
      inDegree: inDegree,
      edgeDir: edgeDir
    };
  }

  function buildForwardTree(sorted, inAdj, source) {
    var dist = {};
    var parent = {};
    var children = {};
    var i;

    for (i = 0; i < sorted.length; i += 1) {
      var id = String(sorted[i]);
      dist[id] = Infinity;
      parent[id] = null;
      children[id] = [];
    }
    dist[source] = 0;

    for (i = 0; i < sorted.length; i += 1) {
      id = String(sorted[i]);
      if (id === source) continue;
      var preds = inAdj[id] || [];
      var bestParent = null;
      var bestDist = Infinity;
      for (var j = 0; j < preds.length; j += 1) {
        var pred = String(preds[j]);
        if (dist[pred] < bestDist) {
          bestDist = dist[pred];
          bestParent = pred;
        }
      }
      if (bestParent === null || !Number.isFinite(bestDist)) {
        return null;
      }
      parent[id] = bestParent;
      dist[id] = bestDist + 1;
      children[bestParent].push(id);
    }

    return {
      parent: parent,
      children: children,
      dist: dist
    };
  }

  function buildBackwardTree(sorted, outAdj, sink) {
    var dist = {};
    var parent = {};
    var children = {};
    var i;

    for (i = 0; i < sorted.length; i += 1) {
      var id = String(sorted[i]);
      dist[id] = Infinity;
      parent[id] = null;
      children[id] = [];
    }
    dist[sink] = 0;

    for (i = sorted.length - 1; i >= 0; i -= 1) {
      id = String(sorted[i]);
      if (id === sink) continue;
      var succs = outAdj[id] || [];
      var bestParent = null;
      var bestDist = Infinity;
      for (var j = 0; j < succs.length; j += 1) {
        var succ = String(succs[j]);
        if (dist[succ] < bestDist) {
          bestDist = dist[succ];
          bestParent = succ;
        }
      }
      if (bestParent === null || !Number.isFinite(bestDist)) {
        return null;
      }
      parent[id] = bestParent;
      dist[id] = bestDist + 1;
      children[bestParent].push(id);
    }

    return {
      parent: parent,
      children: children,
      dist: dist
    };
  }

  function computeForwardSubtreeSums(sorted, children, valueById) {
    var sum = {};
    for (var i = 0; i < sorted.length; i += 1) {
      var id = String(sorted[i]);
      sum[id] = Number.isFinite(valueById[id]) ? valueById[id] : 0;
    }
    for (i = sorted.length - 1; i >= 0; i -= 1) {
      id = String(sorted[i]);
      var kids = children[id] || [];
      for (var j = 0; j < kids.length; j += 1) {
        var child = String(kids[j]);
        sum[id] += sum[child];
      }
    }
    return sum;
  }

  function computeBackwardSubtreeSums(sorted, parent, valueById) {
    var sum = {};
    for (var i = 0; i < sorted.length; i += 1) {
      var id = String(sorted[i]);
      sum[id] = Number.isFinite(valueById[id]) ? valueById[id] : 0;
    }
    for (i = 0; i < sorted.length; i += 1) {
      id = String(sorted[i]);
      var p = parent[id];
      if (p !== null && p !== undefined) {
        sum[p] += sum[id];
      }
    }
    return sum;
  }

  function buildRankSpacedTargetCoordinates(sorted, posById) {
    var target = {};
    var minX = Infinity;
    var maxX = -Infinity;
    var i;

    for (i = 0; i < sorted.length; i += 1) {
      var id = String(sorted[i]);
      var pos = posById[id];
      if (pos && Number.isFinite(pos.x)) {
        minX = Math.min(minX, pos.x);
        maxX = Math.max(maxX, pos.x);
      }
    }
    if (!(maxX > minX)) {
      for (i = 0; i < sorted.length; i += 1) {
        target[String(sorted[i])] = i;
      }
      return target;
    }

    // Spread targets by rank so near-equal projected outer coordinates do not
    // turn into huge n_ij / (x_j - x_i) weights on symmetric instances.
    var step = (maxX - minX) / Math.max(1, sorted.length - 1);
    for (i = 0; i < sorted.length; i += 1) {
      target[String(sorted[i])] = minX + step * i;
    }

    return target;
  }

  function buildSpreadPathWeights(state, workingPositions, failureLabel) {
    var orientation = buildSpreadOrientation(state.augmentedIds, state.augmentedPairs, workingPositions);
    var forwardTree = buildForwardTree(orientation.sorted, orientation.inAdj, orientation.source);
    var backwardTree = buildBackwardTree(orientation.sorted, orientation.outAdj, orientation.sink);
    if (!forwardTree || !backwardTree) {
      return buildLayoutError({
        message: failureLabel + ' could not build spread trees on the augmented graph',
        graph: state.prepared.graph,
        outerFace: state.augmentedOuterFace,
        augmented: state.augmented
      });
    }

    var targetX = buildRankSpacedTargetCoordinates(orientation.sorted, workingPositions);
    var forwardSum = computeForwardSubtreeSums(orientation.sorted, forwardTree.children, orientation.outDegree);
    var backwardSum = computeBackwardSubtreeSums(orientation.sorted, backwardTree.parent, orientation.inDegree);
    var weights = {};

    for (var i = 0; i < state.augmentedPairs.length; i += 1) {
      var a = String(state.augmentedPairs[i][0]);
      var b = String(state.augmentedPairs[i][1]);
      var key = edgeKey(a, b);
      var dir = orientation.edgeDir[key];
      if (!dir) continue;
      var u = dir.from;
      var v = dir.to;
      var delta = targetX[v] - targetX[u];
      if (!(delta > 1e-9)) {
        delta = 1e-9;
      }
      var count = 1;
      if (forwardTree.parent[v] === u) {
        count += forwardSum[v];
      }
      if (backwardTree.parent[u] === v) {
        count += backwardSum[u];
      }
      var weight = count / delta;
      if (!Number.isFinite(weight) || !(weight > 0)) {
        weight = 1;
      }
      weights[key] = weight;
    }

    return buildLayoutResult({
      weights: weights,
      orientation: orientation,
      targetX: targetX
    });
  }

  function buildSpreadState(state, basePositions, angle, failureLabel) {
    var rotatedPositions = rotatePositionMap(basePositions, computeFaceCentroid(basePositions, state.augmentedIds), Number.isFinite(angle) ? angle : 0);
    var workingPositions = rotateForSpread(state.augmentedIds, state.augmentedPairs, rotatedPositions);
    var spread = buildSpreadPathWeights(state, workingPositions, failureLabel);
    if (!spread.ok) {
      return spread;
    }

    return buildLayoutResult({
      weights: spread.weights
    });
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

  function buildCEGStateFromPrepared(prepared, failureLabel) {
    if (!prepared || !prepared.ok) {
      return buildLayoutError(prepared || {
        message: failureLabel + ' requires a planar graph'
      });
    }

    var baseGraph = prepared.graph;
    var ids = baseGraph.nodeIds;
    var pairs = baseGraph.edgePairs;
    return buildLayoutResult({
      failureLabel: failureLabel,
      ids: ids,
      pairs: pairs,
      prepared: prepared,
      augmented: prepared.augmented,
      outerFace: prepared.outerFace,
      augmentedOuterFace: prepared.augmentedOuterFace,
      augmentedIds: prepared.augmented.graph.nodeIds,
      augmentedPairs: prepared.augmented.graph.edgePairs,
      adjacency: prepared.augmented.graph.adjacency
    });
  }

  function prepareCEGState(graph, failureLabel, options) {
    return buildCEGStateFromPrepared(prepareGraphData(graph, failureLabel, options), failureLabel);
  }

  function prepareGraphData(graph, failureLabel, options) {
    return LayoutPreprocessing.prepareGraphAndLayoutData(graph, {
      failureLabel: failureLabel,
      augmentationMethod: options && options.augmentationMethod ? options.augmentationMethod : null,
      currentPositions: options ? options.currentPositions : undefined
    });
  }

  function solveAugmentedWeightedLayout(state, weights, initOptions) {
    return Tutte.computeBarycentricPositions(
      state.augmented.graph,
      state.augmentedOuterFace,
      {
        adjacency: state.adjacency,
        weights: weights,
        initOptions: Tutte.defaultOuterPlacementOptions(initOptions || {})
      }
    );
  }

  function projectCEGPositions(state, posById, failureLabel) {
    var projected = filterPositions(posById, state.ids);
    if (hasPositionCrossings(projected, state.pairs)) {
      return buildLayoutError({
        message: failureLabel + ' produced a non-plane drawing'
      });
    }
    return buildLayoutResult({
      projected: projected
    });
  }

  function buildCEGSuccessResult(state, posById, iters, message) {
    var projectedResult = projectCEGPositions(state, posById, state.failureLabel);
    if (!projectedResult.ok) {
      return projectedResult;
    }

    return buildLayoutResult({
      nodeIds: state.ids,
      edgePairs: state.pairs,
      outerFace: state.outerFace,
      graph: state.prepared.graph,
      augmented: state.augmented,
      positions: projectedResult.projected,
      posById: posById,
      iters: iters,
      message: message,
      debugState: createAugmentationDebugState(
        state.prepared.graph,
        state.augmented,
        posById
      )
    });
  }

  function computeCEGBfsPositions(graph, options, prepared) {
    var state = prepared
      ? buildCEGStateFromPrepared(prepared, 'CEG-bfs')
      : prepareCEGState(graph, 'CEG-bfs', options);
    if (!state || !state.ok) {
      return state;
    }

    var A = CEG_CONFIG.bfsBaseWeight;
    var R = CEG_CONFIG.bfsDepthRatio;
    var depthById = bfsDepthFromOuter(state.augmentedIds, state.adjacency, state.augmentedOuterFace);
    var weights = buildDepthWeights(state.augmentedPairs, depthById, A, R);
    var out = solveAugmentedWeightedLayout(state, weights);
    if (!out.ok) {
      return buildLayoutError({
        message: out.message || 'CEG-bfs solver failed',
        graph: state.prepared.graph,
        outerFace: state.augmentedOuterFace,
        augmented: state.augmented
      });
    }
    return buildCEGSuccessResult(
      state,
      out.positions,
      out.iters,
      'Applied CEG-bfs (' + state.augmentedOuterFace.length + '-vertex outer face, multi-source outer BFS, edgeDepth=1+min(endpointDepth), r=' + R +
      (state.augmented.dummyCount > 0 ? ', +' + state.augmented.dummyCount + ' dummy vertices' : '') +
      ', ' + out.iters + ' total iters)'
    );
  }

  function computeCEGXyPositions(graph, options, prepared) {
    var state = prepared
      ? buildCEGStateFromPrepared(prepared, 'CEG-xy')
      : prepareCEGState(graph, 'CEG-xy', options);
    if (!state || !state.ok) {
      return state;
    }

    var lambdaX = CEG_CONFIG.xyLambda;

    var uniformWeights = buildUniformWeights(state.augmentedPairs, 1);
    var base = solveAugmentedWeightedLayout(state, uniformWeights);
    if (!base.ok) {
      return buildLayoutError({
        message: base.message || 'CEG-xy baseline solve failed',
        graph: state.prepared.graph,
        outerFace: state.augmentedOuterFace,
        augmented: state.augmented
      });
    }
    var xSpread = buildSpreadState(state, base.positions, 0, 'CEG-xy x-spread');
    if (!xSpread.ok) {
      return xSpread;
    }
    var ySpread = buildSpreadState(state, base.positions, Math.PI / 2, 'CEG-xy y-spread');
    if (!ySpread.ok) {
      return ySpread;
    }

    var wxy = combineWeights(state.augmentedPairs, xSpread.weights, ySpread.weights, lambdaX);
    var fixedOuterPos = buildFixedOuterPositions(state.augmentedOuterFace, base.positions);
    var xySolve = solveAugmentedWeightedLayout(state, wxy, {
      fixedOuterPos: fixedOuterPos
    });
    if (!xySolve.ok) {
      return buildLayoutError({
        message: xySolve.message || 'CEG-xy solve failed',
        graph: state.prepared.graph,
        outerFace: state.augmentedOuterFace,
        augmented: state.augmented
      });
    }
    return buildCEGSuccessResult(
      state,
      xySolve.positions,
      base.iters + xySolve.iters,
      'Applied CEG-xy (' + state.augmentedOuterFace.length + '-vertex outer face, lambdaX=' + Math.max(0, Math.min(1, lambdaX)) + ', x/y spread morph' +
      (state.augmented.dummyCount > 0 ? ', +' + state.augmented.dummyCount + ' dummy vertices' : '') +
      ', ' + (base.iters + xySolve.iters) + ' total iters)'
    );
  }

  function applyLayout(cy, options, computeLayout, failureMessage) {
    return CyRuntime.runLayout(cy, options, {
      prepareMode: 'graph+layout',
      prepareFailureLabel: String(failureMessage || 'CEG layout').replace(/ failed$/i, ' layout'),
      initialFitBounds: function (ctx) {
        return CyRuntime.computePositionBounds(ctx.prepared.posById);
      },
      computePositions: async function (prepared, computeOptions) {
        var result = computeLayout(prepared.graph, computeOptions, prepared);
        if (result && result.ok && result.positions && typeof computeOptions.onIteration === 'function') {
          await computeOptions.onIteration({
            iter: 1,
            maxIters: 1,
            positions: result.positions
          });
        }
        return result;
      },
      buildResult: function (ctx) {
        var result = ctx.result;
        return {
          ok: true,
          message: result.message,
          debugState: result.debugState || null
        };
      },
      failureMessage: failureMessage
    });
  }

  global.PlanarVibeCEGBfs = {
    prepareGraphData: function (graph, options) {
      return prepareGraphData(graph, 'CEG-bfs', options);
    },
	    computePositions: function (layoutInput, options) {
	      return computeCEGBfsPositions(layoutInput.graph, options, layoutInput);
	    },
	    applyLayout: function (cy, options) {
	      return applyLayout(cy, options, computeCEGBfsPositions, 'CEG-bfs failed');
	    }
	  };
  global.PlanarVibeCEGXy = {
    prepareGraphData: function (graph, options) {
      return prepareGraphData(graph, 'CEG-xy', options);
    },
	    computePositions: function (layoutInput, options) {
	      return computeCEGXyPositions(layoutInput.graph, options, layoutInput);
	    },
	    applyLayout: function (cy, options) {
	      return applyLayout(cy, options, computeCEGXyPositions, 'CEG-xy failed');
	    }
	  };
})(window);
