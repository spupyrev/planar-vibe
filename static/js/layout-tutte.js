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
  var filterPositions = GeometryUtils.filterPositionMap;
  var luFactorize = LinearAlgebraUtils.luFactorize;
  var normalizeOuterFace = GraphUtils.normalizeOuterFace;
  var hasPositionCrossings = GeometryUtils.hasPositionCrossings;
  var solveLUWithTwoRhs = LinearAlgebraUtils.solveLUWithTwoRhs;

  function buildDegreeMap(graph) {
    var ids = graph.nodeIds;
    var pairs = graph.edgePairs;
    var degreeById = {};
    for (var i = 0; i < ids.length; i += 1) {
      degreeById[ids[i]] = 0;
    }
    for (i = 0; i < pairs.length; i += 1) {
      var u = pairs[i][0];
      var v = pairs[i][1];
      degreeById[u] = (degreeById[u] || 0) + 1;
      degreeById[v] = (degreeById[v] || 0) + 1;
    }
    return degreeById;
  }

  function buildTutteWeights(graph, augmentedGraph) {
    var originalPairs = graph.edgePairs;
    var augmentedPairs = augmentedGraph.edgePairs;
    var degreeById = buildDegreeMap(augmentedGraph);
    var originalEdgeSet = {};
    var weights = {};
    var originalWeight = 1;
    var augmentationWeight = 0.245;
    var i;

    for (i = 0; i < originalPairs.length; i += 1) {
      originalEdgeSet[edgeKey(originalPairs[i][0], originalPairs[i][1])] = true;
    }

    for (i = 0; i < augmentedPairs.length; i += 1) {
      var u = augmentedPairs[i][0];
      var v = augmentedPairs[i][1];
      var key = edgeKey(u, v);
      var baseWeight = originalEdgeSet[key] ? originalWeight : augmentationWeight;
      var du = Math.max(1, degreeById[u] || 0);
      var dv = Math.max(1, degreeById[v] || 0);
      baseWeight /= Math.sqrt(du * dv);
      weights[key] = baseWeight;
    }

    return weights;
  }

  function defaultOuterPlacementOptions(overrides) {
    var out = {
      defaultCenterX: 450,
      defaultCenterY: 310,
      defaultRadius: 300
    };
    var extra = overrides || {};
    var keys = Object.keys(extra);
    for (var i = 0; i < keys.length; i += 1) {
      out[keys[i]] = extra[keys[i]];
    }
    return out;
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
    for (i = 0; i < face.length; i += 1) {
      var v = face[face.length - i - 1];
      pos[v] = {
        x: cx + R * Math.cos(gamma * i),
        y: cy + R * Math.sin(gamma * i)
      };
    }
    if (opts.fixedOuterPos) {
      for (i = 0; i < face.length; i += 1) {
        v = face[i];
        var fp = opts.fixedOuterPos[v];
        if (fp && Number.isFinite(fp.x) && Number.isFinite(fp.y)) {
          pos[v] = { x: fp.x, y: fp.y };
        }
      }
    }
    return pos;
  }

  function computeBarycentricPositions(graph, outerFace, options) {
    var opts = options || {};
    var ids = graph.nodeIds;
    var face = normalizeOuterFace(outerFace);
    var adjacency = opts.adjacency || graph.adjacency;
    var weights = opts.weights || null;
    var initOptions = opts.initOptions || defaultOuterPlacementOptions();
    var pos = placeOuterFaceVertices(ids, face, initOptions);
    var outerSet = new Set(face);
    var interiorIds = [];
    var interiorIndexById = {};
    var i;
    var j;

    if (ids.length < 1) {
      return buildLayoutError({
        message: 'No vertices',
        graph: graph,
        outerFace: face
      });
    }
    if (face.length < 3) {
      return buildLayoutError({
        message: 'Outer face is invalid',
        graph: graph,
        outerFace: face
      });
    }
    if (!weights || typeof weights !== 'object') {
      return buildLayoutError({
        message: 'Barycentric weights are required',
        graph: graph,
        outerFace: face
      });
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
        ok: true,
        graph: graph,
        outerFace: face,
        positions: pos,
        iters: 1
      });
    }

    var L = new Array(interiorIds.length);
    var bx = new Array(interiorIds.length);
    var by = new Array(interiorIds.length);
    for (i = 0; i < interiorIds.length; i += 1) {
      L[i] = new Array(interiorIds.length);
      for (j = 0; j < interiorIds.length; j += 1) {
        L[i][j] = 0;
      }
      L[i][i] = 1;
      bx[i] = 0;
      by[i] = 0;

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
    if (!factor) {
      return buildLayoutError({
        message: 'Exact barycentric solve failed',
        graph: graph,
        outerFace: face
      });
    }
    var solved = solveLUWithTwoRhs(factor, bx, by);
    if (!solved) {
      return buildLayoutError({
        message: 'Exact barycentric solve failed',
        graph: graph,
        outerFace: face
      });
    }

    for (i = 0; i < interiorIds.length; i += 1) {
      pos[interiorIds[i]] = { x: solved.x1[i], y: solved.x2[i] };
    }

    return buildLayoutResult({
      ok: true,
      graph: graph,
      outerFace: face,
      positions: pos,
      iters: 1
    });
  }

  function computeTutteLayout(graph, options) {
    var opts = options || {};
    var ids = graph.nodeIds;
    var pairs = graph.edgePairs;

    if (ids.length < 3) {
      return buildLayoutError({
        message: 'Tutte requires at least 3 vertices',
        graph: graph
      });
    }

    var prepared = LayoutPreprocessing.prepareGraphData(graph, {
      failureLabel: 'Tutte layout',
      augmentationMethod: opts.augmentationMethod || null,
      augmentationOptions: opts.augmentationOptions || null
    });
    if (!prepared || !prepared.ok) {
      return buildLayoutError(prepared || { message: 'Tutte failed' });
    }

    var augmentedGraph = prepared.augmentedGraph;
    var augmentedOuterFace = prepared.augmentedOuterFace || prepared.outerFace;
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

    var alignedPosById = GeometryUtils.alignOuterFaceEdgeHorizontally(
      barycentric.positions,
      augmentedOuterFace
    );
    var projected = filterPositions(alignedPosById, ids);
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
      ok: true,
      nodeIds: ids,
      edgePairs: pairs,
      outerFace: prepared.outerFace,
      embedding: prepared.baseEmbedding,
      augmented: prepared.augmented,
      graph: prepared.graph,
      positions: projected,
      posById: alignedPosById,
      iters: barycentric.iters
    });
  }

  function applyTutteLayout(cy, options) {
    return CyRuntime.runLayout(cy, options || {}, {
      compute: computeTutteLayout,
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
              result.posById
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
    computeBarycentricPositions: computeBarycentricPositions,
    computeTutteLayout: computeTutteLayout,
    applyTutteLayout: applyTutteLayout
  };
})(window);
