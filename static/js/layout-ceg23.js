(function (global) {
  'use strict';

  var LayoutPreprocessing = global.LayoutPreprocessing;
  var CyRuntime = global.CyRuntime;
  var GeometryUtils = global.GeometryUtils;
  var GraphUtils = global.GraphUtils;
  var Tutte = global.PlanarVibeTutte;
  var createAugmentationDebugState = LayoutPreprocessing.createAugmentationDebugState;
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

  function buildUniformWeights(edgePairs, value) {
    var pairs = edgePairs;
    var weights = {};
    var w = Number.isFinite(value) && value > 0 ? value : 1;
    for (var i = 0; i < pairs.length; i += 1) {
      var u = pairs[i][0];
      var v = pairs[i][1];
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
    if (!edgeKey) {
      return weights;
    }

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

  function computePositionCenter(nodeIds, posById) {
    var cx = 0;
    var cy = 0;
    var count = 0;
    for (var i = 0; i < nodeIds.length; i += 1) {
      var pos = posById[String(nodeIds[i])];
      if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) continue;
      cx += pos.x;
      cy += pos.y;
      count += 1;
    }
    if (count < 1) {
      return { x: 0, y: 0 };
    }
    return { x: cx / count, y: cy / count };
  }

  function rotatePositions(nodeIds, posById, angle) {
    var out = {};
    var theta = Number.isFinite(angle) ? angle : 0;
    var center = computePositionCenter(nodeIds, posById);
    var cos = Math.cos(theta);
    var sin = Math.sin(theta);

    for (var i = 0; i < nodeIds.length; i += 1) {
      var id = String(nodeIds[i]);
      var pos = posById[id];
      if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
        out[id] = { x: 0, y: 0 };
        continue;
      }
      var dx = pos.x - center.x;
      var dy = pos.y - center.y;
      out[id] = {
        x: center.x + dx * cos - dy * sin,
        y: center.y + dx * sin + dy * cos
      };
    }
    return out;
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
      var rotated = rotatePositions(nodeIds, posById, angles[i]);
      if (!hasVerticalSpreadEdge(edgePairs, rotated, 1e-7)) {
        return rotated;
      }
    }
    return rotatePositions(nodeIds, posById, 1e-2);
  }

  function buildFixedOuterPositions(outerFace, posById) {
    var fixed = {};
    for (var i = 0; i < outerFace.length; i += 1) {
      var id = String(outerFace[i]);
      var pos = posById[id];
      if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) continue;
      fixed[id] = { x: pos.x, y: pos.y };
    }
    return fixed;
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

  function buildTargetCoordinates(sorted, outerFace, posById) {
    var target = {};
    var outerSet = {};
    var outerIndices = [];
    var i;

    for (i = 0; i < outerFace.length; i += 1) {
      outerSet[String(outerFace[i])] = true;
    }
    for (i = 0; i < sorted.length; i += 1) {
      var id = String(sorted[i]);
      if (outerSet[id]) {
        outerIndices.push(i);
        target[id] = posById[id].x;
      }
    }
    if (outerIndices.length < 2) {
      for (i = 0; i < sorted.length; i += 1) {
        target[String(sorted[i])] = i;
      }
      return target;
    }

    for (i = 0; i < outerIndices.length - 1; i += 1) {
      var leftIndex = outerIndices[i];
      var rightIndex = outerIndices[i + 1];
      var leftId = String(sorted[leftIndex]);
      var rightId = String(sorted[rightIndex]);
      var leftX = posById[leftId].x;
      var rightX = posById[rightId].x;
      var span = rightIndex - leftIndex;
      for (var k = leftIndex + 1; k < rightIndex; k += 1) {
        var t = (k - leftIndex) / span;
        target[String(sorted[k])] = leftX + (rightX - leftX) * t;
      }
    }

    var firstOuter = outerIndices[0];
    for (i = firstOuter - 1; i >= 0; i -= 1) {
      target[String(sorted[i])] = posById[String(sorted[firstOuter])].x - (firstOuter - i);
    }
    var lastOuter = outerIndices[outerIndices.length - 1];
    for (i = lastOuter + 1; i < sorted.length; i += 1) {
      target[String(sorted[i])] = posById[String(sorted[lastOuter])].x + (i - lastOuter);
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

    var targetX = buildTargetCoordinates(orientation.sorted, state.augmentedOuterFace, workingPositions);
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
      ok: true,
      weights: weights,
      orientation: orientation,
      targetX: targetX
    });
  }

  function buildSpreadState(state, basePositions, angle, failureLabel) {
    var rotatedPositions = rotatePositions(state.augmentedIds, basePositions, angle);
    var workingPositions = rotateForSpread(state.augmentedIds, state.augmentedPairs, rotatedPositions);
    var spread = buildSpreadPathWeights(state, workingPositions, failureLabel);
    if (!spread.ok) {
      return spread;
    }

    return buildLayoutResult({
      ok: true,
      angle: angle,
      workingPositions: workingPositions,
      weights: spread.weights,
      orientation: spread.orientation,
      targetX: spread.targetX
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

  function prepareCEG23State(graph, failureLabel, options) {
    var prepared = prepareGraphAndLayoutData(graph, {
      failureLabel: failureLabel,
      augmentationMethod: options && options.augmentationMethod ? options.augmentationMethod : null,
      currentPositions: options ? options.currentPositions : undefined
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

  function solveAugmentedWeightedLayout(state, weights, maxIters, initOptions) {
    return Tutte.computeBarycentricPositions(
      state.augmentedGraph,
      state.augmentedOuterFace,
      {
        adjacency: state.adjacency,
        weights: weights,
        initOptions: Tutte.defaultOuterPlacementOptions(initOptions || {})
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
      message: message,
      debugState: typeof createAugmentationDebugState === 'function'
        ? createAugmentationDebugState(
          state.prepared.graph,
          state.augmented,
          posById
        )
        : null
    });
  }

  function computeCEG23BfsPositions(graph, options) {
    var state = prepareCEG23State(graph, 'CEG23-bfs', options);
    if (!state || !state.ok) {
      return state;
    }

    var A = resolvePositiveOption(options.a, 1.0);
    var R = resolveGreaterThanOption(options.r, 1.35, 1);
    var MAX_ITERS = resolveIntOption(options.maxIters, 4000, 1);

    var baseWeights = buildUniformWeights(state.augmentedPairs, 1);
    var base = solveAugmentedWeightedLayout(state, baseWeights, MAX_ITERS);
    if (!base.ok) {
      return buildLayoutError({
        message: base.message || 'CEG23-bfs baseline solve failed',
        graph: state.prepared.graph,
        outerFace: state.augmentedOuterFace,
        augmented: state.augmented
      });
    }

    var depthById = bfsDepthFromOuter(state.augmentedIds, state.adjacency, state.augmentedOuterFace);
    var weights = buildDepthWeights(state.augmentedPairs, depthById, A, R);
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
      base.iters + out.iters,
      'Applied CEG23-bfs (' + state.augmentedOuterFace.length + '-vertex outer face, multi-source outer BFS, edgeDepth=1+min(endpointDepth), r=' + R +
      (state.augmented.dummyCount > 0 ? ', +' + state.augmented.dummyCount + ' dummy vertices' : '') +
      ', ' + (base.iters + out.iters) + ' total iters)'
    );
  }

  function computeCEG23XPositions(graph, options) {
    var state = prepareCEG23State(graph, 'CEG23-x', options);
    if (!state || !state.ok) {
      return state;
    }

    var maxIters = resolveIntOption(options.maxIters, 2500, 1);
    var baseWeights = buildUniformWeights(state.augmentedPairs, 1);
    var base = solveAugmentedWeightedLayout(state, baseWeights, maxIters);
    if (!base.ok) {
      return buildLayoutError({
        message: base.message || 'CEG23-x baseline solve failed',
        graph: state.prepared.graph,
        outerFace: state.augmentedOuterFace,
        augmented: state.augmented
      });
    }
    base.positions = alignOuterFaceEdgeHorizontally(base.positions, state.augmentedOuterFace);

    var spread = buildSpreadState(state, base.positions, 0, 'CEG23-x');
    if (!spread.ok) {
      return spread;
    }

    var fixedOuterPos = buildFixedOuterPositions(state.augmentedOuterFace, base.positions);
    var out = solveAugmentedWeightedLayout(state, spread.weights, maxIters, {
      fixedOuterPos: fixedOuterPos
    });
    if (!out.ok) {
      return buildLayoutError({
        message: out.message || 'CEG23-x solve failed',
        graph: state.prepared.graph,
        outerFace: state.augmentedOuterFace,
        augmented: state.augmented
      });
    }

    return buildCEG23SuccessResult(
      state,
      out.positions,
      base.iters + out.iters,
      'Applied CEG23-x (' + state.augmentedOuterFace.length + '-vertex outer face, st-orientation path-count spread' +
      (state.augmented.dummyCount > 0 ? ', +' + state.augmented.dummyCount + ' dummy vertices' : '') +
      ', ' + (base.iters + out.iters) + ' total iters)'
    );
  }

  function computeCEG23YPositions(graph, options) {
    var state = prepareCEG23State(graph, 'CEG23-y', options);
    if (!state || !state.ok) {
      return state;
    }

    var maxIters = resolveIntOption(options.maxIters, 2500, 1);
    var baseWeights = buildUniformWeights(state.augmentedPairs, 1);
    var base = solveAugmentedWeightedLayout(state, baseWeights, maxIters);
    if (!base.ok) {
      return buildLayoutError({
        message: base.message || 'CEG23-y baseline solve failed',
        graph: state.prepared.graph,
        outerFace: state.augmentedOuterFace,
        augmented: state.augmented
      });
    }
    base.positions = alignOuterFaceEdgeHorizontally(base.positions, state.augmentedOuterFace);

    var spread = buildSpreadState(state, base.positions, Math.PI / 2, 'CEG23-y');
    if (!spread.ok) {
      return spread;
    }

    var fixedOuterPos = buildFixedOuterPositions(state.augmentedOuterFace, base.positions);
    var out = solveAugmentedWeightedLayout(state, spread.weights, maxIters, {
      fixedOuterPos: fixedOuterPos
    });
    if (!out.ok) {
      return buildLayoutError({
        message: out.message || 'CEG23-y solve failed',
        graph: state.prepared.graph,
        outerFace: state.augmentedOuterFace,
        augmented: state.augmented
      });
    }

    return buildCEG23SuccessResult(
      state,
      out.positions,
      base.iters + out.iters,
      'Applied CEG23-y (' + state.augmentedOuterFace.length + '-vertex outer face, rotated st-orientation path-count spread' +
      (state.augmented.dummyCount > 0 ? ', +' + state.augmented.dummyCount + ' dummy vertices' : '') +
      ', ' + (base.iters + out.iters) + ' total iters)'
    );
  }

  function computeCEG23XyPositions(graph, options) {
    var state = prepareCEG23State(graph, 'CEG23-xy', options);
    if (!state || !state.ok) {
      return state;
    }

    var maxIters = resolveIntOption(options.maxIters, 2500, 1);
    var lambdaX = resolveFiniteOption(options.lambdaX, 0.5);

    var uniformWeights = buildUniformWeights(state.augmentedPairs, 1);
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

    var xSpread = buildSpreadState(state, base.positions, 0, 'CEG23-xy x-spread');
    if (!xSpread.ok) {
      return xSpread;
    }
    var ySpread = buildSpreadState(state, base.positions, Math.PI / 2, 'CEG23-xy y-spread');
    if (!ySpread.ok) {
      return ySpread;
    }

    var wxy = combineWeights(state.augmentedPairs, xSpread.weights, ySpread.weights, lambdaX);
    var fixedOuterPos = buildFixedOuterPositions(state.augmentedOuterFace, base.positions);
    var xySolve = solveAugmentedWeightedLayout(state, wxy, maxIters, {
      fixedOuterPos: fixedOuterPos
    });
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
      'Applied CEG23-xy (' + state.augmentedOuterFace.length + '-vertex outer face, lambdaX=' + Math.max(0, Math.min(1, lambdaX)) + ', x/y spread morph' +
      (state.augmented.dummyCount > 0 ? ', +' + state.augmented.dummyCount + ' dummy vertices' : '') +
      ', ' + (base.iters + xySolve.iters) + ' total iters)'
    );
  }

  function applyCEG23Layout(cy, options, computeLayout, failureMessage) {
    return CyRuntime.runLayout(cy, options, {
      compute: computeLayout,
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
