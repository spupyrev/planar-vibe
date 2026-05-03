(function (global) {
  'use strict';

  var LayoutPreprocessing = global.LayoutPreprocessing;
  var CyRuntime = global.CyRuntime;
  var GeometryUtils = global.GeometryUtils;
  var GraphUtils = global.GraphUtils;
  var LinearAlgebraUtils = global.LinearAlgebraUtils;
  var buildLayoutError = GraphUtils.buildLayoutError;
  var buildLayoutResult = GraphUtils.buildLayoutResult;
  var buildLayoutStatusMessage = GraphUtils.buildLayoutStatusMessage;
  var edgeKey = GraphUtils.edgeKey;
  var createZeroVector = GeometryUtils.createZeroVector;
  var filterPositions = GeometryUtils.filterPositionMap;
  var luFactorize = LinearAlgebraUtils.luFactorize;
  var normalizeOuterFace = GraphUtils.normalizeOuterFace;
  var hasPositionCrossings = GeometryUtils.hasPositionCrossings;
  var solveLUWithTwoRhs = LinearAlgebraUtils.solveLUWithTwoRhs;

  async function emitSingleIteration(options, result) {
    if (!result || !result.ok || !result.positions || typeof options.onIteration !== 'function') {
      return;
    }
    await options.onIteration({
      iter: 1,
      maxIters: 1,
      positions: result.positions
    });
  }

  function buildTutteWeights(graph, augmentedGraph) {
    var originalPairs = graph.edgePairs;
    var augmentedPairs = augmentedGraph.edgePairs;
    var adjacency = augmentedGraph.adjacency || null;
    var degreeById = {};
    var originalEdgeSet = {};
    var outerDummyIds = Array.isArray(augmentedGraph.outerDummyIds) ? augmentedGraph.outerDummyIds : [];
    var outerDummySet = {};
    var weights = {};
    var i;

    for (i = 0; i < originalPairs.length; i += 1) {
      originalEdgeSet[edgeKey(originalPairs[i][0], originalPairs[i][1])] = true;
    }
    for (i = 0; i < outerDummyIds.length; i += 1) {
      outerDummySet[String(outerDummyIds[i])] = true;
    }
    if (!adjacency) {
      for (i = 0; i < augmentedPairs.length; i += 1) {
        degreeById[augmentedPairs[i][0]] = (degreeById[augmentedPairs[i][0]] || 0) + 1;
        degreeById[augmentedPairs[i][1]] = (degreeById[augmentedPairs[i][1]] || 0) + 1;
      }
    }

    for (i = 0; i < augmentedPairs.length; i += 1) {
      var u = augmentedPairs[i][0];
      var v = augmentedPairs[i][1];
      var key = edgeKey(u, v);
      var touchesOuterDummy = !!outerDummySet[String(u)] || !!outerDummySet[String(v)];
      var baseWeight = (!originalEdgeSet[key] && touchesOuterDummy) ? 10 : 1;
      var du = Math.max(1, adjacency ? (adjacency[u] || []).length : (degreeById[u] || 0));
      var dv = Math.max(1, adjacency ? (adjacency[v] || []).length : (degreeById[v] || 0));
      baseWeight /= Math.sqrt(du * dv);
      weights[key] = baseWeight;
    }

    return weights;
  }

  function defaultOuterPlacementOptions(overrides) {
    return Object.assign({
      defaultCenterX: 450,
      defaultCenterY: 310,
      defaultRadius: 300,
      outerRotation: null
    }, overrides || {});
  }

  function placeOuterFaceVertices(nodeIds, outerFace, options) {
    var ids = (nodeIds || []).map(String);
    var face = normalizeOuterFace(outerFace);
    var opts = defaultOuterPlacementOptions(options);
    var pos = {};
    var i;
    for (i = 0; i < ids.length; i += 1) {
      pos[ids[i]] = { x: 0, y: 0 };
    }

    var cx = opts.defaultCenterX;
    var cy = opts.defaultCenterY;
    var R = opts.defaultRadius;

    var gamma = 2 * Math.PI / face.length;
    var startAngle = Number.isFinite(opts.outerRotation)
      ? opts.outerRotation
      : (Math.PI / 2 - gamma / 2);
    for (i = 0; i < face.length; i += 1) {
      var v = face[i];
      var angle = startAngle + gamma * i;
      pos[v] = {
        x: cx + R * Math.cos(angle),
        y: cy + R * Math.sin(angle)
      };
    }
    if (opts.fixedOuterPos) {
      for (i = 0; i < face.length; i += 1) {
        var fp = opts.fixedOuterPos[face[i]];
        if (fp && Number.isFinite(fp.x) && Number.isFinite(fp.y)) {
          pos[face[i]] = { x: fp.x, y: fp.y };
        }
      }
    }
    return pos;
  }

  function barycentricError(message, graph, face) {
    return buildLayoutError({
      message: message,
      graph: graph,
      outerFace: face
    });
  }

  function computeBarycentricPositions(graph, outerFace, options) {
    var ids = graph.nodeIds;
    var face = normalizeOuterFace(outerFace);
    var adjacency = options.adjacency || graph.adjacency;
    var weights = options.weights || null;
    var initOptions = options.initOptions || defaultOuterPlacementOptions();
    var pos = placeOuterFaceVertices(ids, face, initOptions);
    var outerSet = new Set(face);
    var interiorIds = [];
    var interiorIndexById = {};
    var i;
    var j;

    if (ids.length < 1) {
      return barycentricError('No vertices', graph, face);
    }
    if (face.length < 3) {
      return barycentricError('Outer face is invalid', graph, face);
    }
    if (!weights || typeof weights !== 'object') {
      return barycentricError('Barycentric weights are required', graph, face);
    }

    for (i = 0; i < ids.length; i += 1) {
      var id = ids[i];
      if (!outerSet.has(id)) {
        interiorIndexById[id] = interiorIds.length;
        interiorIds.push(id);
      }
    }
    if (interiorIds.length === 0) {
      return buildLayoutResult({
        graph: graph,
        outerFace: face,
        positions: pos,
        iters: 1
      });
    }

    var L = new Array(interiorIds.length);
    var bx = createZeroVector(interiorIds.length);
    var by = createZeroVector(interiorIds.length);
    for (i = 0; i < interiorIds.length; i += 1) {
      L[i] = createZeroVector(interiorIds.length);
      L[i][i] = 1;

      var v = interiorIds[i];
      var neighbors = adjacency[v] || [];
      var rawWeights = new Array(neighbors.length);
      var weightSum = 0;
      for (j = 0; j < neighbors.length; j += 1) {
        var u = String(neighbors[j]);
        var w = weights[edgeKey(v, u)];
        if (!Number.isFinite(w) || w <= 0) {
          w = 1;
        }
        rawWeights[j] = w;
        weightSum += w;
      }
      if (!(weightSum > 0)) {
        continue;
      }

      for (j = 0; j < neighbors.length; j += 1) {
        u = String(neighbors[j]);
        w = rawWeights[j] / weightSum;
        var interiorIdx = interiorIndexById[u];
        if (interiorIdx === undefined) {
          bx[i] += w * pos[u].x;
          by[i] += w * pos[u].y;
        } else {
          L[i][interiorIdx] -= w;
        }
      }
    }

    var factor = luFactorize(L);
    var solved = factor ? solveLUWithTwoRhs(factor, bx, by) : null;
    if (!solved) {
      return barycentricError('Exact barycentric solve failed', graph, face);
    }

    for (i = 0; i < interiorIds.length; i += 1) {
      pos[interiorIds[i]] = { x: solved.x1[i], y: solved.x2[i] };
    }

    return buildLayoutResult({
      graph: graph,
      outerFace: face,
      positions: pos,
      iters: 1
    });
  }

  function computeTutteLayoutWithPrepared(graph, prepared) {
    var ids = graph.nodeIds;
    var pairs = graph.edgePairs;
    if (!prepared || !prepared.ok) {
      return buildLayoutError(prepared || { message: 'Tutte failed' });
    }

    var augmentedGraph = prepared.augmentedGraph;
    var augmentedOuterFace = prepared.augmentedOuterFace;
    var barycentric = computeBarycentricPositions(
      augmentedGraph,
      augmentedOuterFace,
      {
        initOptions: defaultOuterPlacementOptions(),
        weights: buildTutteWeights(prepared.graph, augmentedGraph)
      }
    );
    if (!barycentric || !barycentric.ok || !barycentric.positions) {
      return buildLayoutError(barycentric || { message: 'Tutte failed' });
    }

    var projected = filterPositions(barycentric.positions, ids);
    var hasCrossings = hasPositionCrossings(projected, pairs);
    if (hasCrossings) {
      return buildLayoutError({
        message: 'Tutte produced a non-plane drawing',
        graph: prepared.graph,
        outerFace: prepared.outerFace,
        augmented: prepared.augmented
      });
    }

    return buildLayoutResult({
      nodeIds: ids,
      edgePairs: pairs,
      outerFace: prepared.outerFace,
      embedding: prepared.baseEmbedding,
      augmented: prepared.augmented,
      graph: prepared.graph,
      debugPositions: barycentric.positions,
      positions: projected,
      iters: barycentric.iters
    });
  }

  function computeTutteLayout(graph, options) {
    return computeTutteLayoutWithPrepared(graph, LayoutPreprocessing.prepareGraphData(graph, {
      failureLabel: 'Tutte layout',
      augmentationMethod: options.augmentationMethod || null,
      augmentationOptions: options.augmentationOptions || null,
      currentPositions: options.currentPositions
    }));
  }

  function buildTutteOuterPositions(prepared) {
    if (!prepared || !prepared.ok) {
      throw new Error('buildTutteOuterPositions requires prepared graph data');
    }
    var fullPos = placeOuterFaceVertices(
      prepared.augmentedGraph.nodeIds,
      prepared.augmentedOuterFace,
      defaultOuterPlacementOptions()
    );
    return filterPositions(fullPos, prepared.augmentedOuterFace);
  }

  function applyTutteLayout(cy, options) {
    return CyRuntime.runLayout(cy, options, {
      prepareMode: 'graph',
      prepareFailureLabel: 'Tutte layout',
      initialFitBounds: function (ctx) {
        return CyRuntime.computePositionBounds(buildTutteOuterPositions(ctx.prepared));
      },
      computePositions: async function (graph, computeOptions, prepared) {
        var result = computeTutteLayoutWithPrepared(graph, prepared);
        await emitSingleIteration(computeOptions || {}, result);
        return result;
      },
      buildResult: function (ctx) {
        var result = ctx.result;
        return {
          ok: true,
          message: buildLayoutStatusMessage('Tutte', {
            outerFaceVertexCount: result.outerFace.length,
            iters: result.iters
          }),
          debugState: typeof LayoutPreprocessing.createAugmentationDebugState === 'function'
            ? LayoutPreprocessing.createAugmentationDebugState(
              result.graph,
              result.augmented,
              result.debugPositions || result.posById
            )
            : null
        };
      },
      failureMessage: 'Tutte failed'
    });
  }

  global.PlanarVibeTutte = {
    buildTutteWeights: buildTutteWeights,
    defaultOuterPlacementOptions: defaultOuterPlacementOptions,
    placeOuterFaceVertices: placeOuterFaceVertices,
    buildTutteOuterPositions: buildTutteOuterPositions,
    computeBarycentricPositions: computeBarycentricPositions,
    computeTutteLayout: computeTutteLayout,
    applyTutteLayout: applyTutteLayout
  };
})(window);
