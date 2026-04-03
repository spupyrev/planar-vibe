(function (global) {
  'use strict';

  var PlaygroundUtils = global.PlaygroundUtils;
  var GraphUtils = global.GraphUtils;
  var buildAdjacencyArrays = GraphUtils.buildAdjacencyArrays;
  var buildLayoutError = GraphUtils.buildLayoutError;
  var buildLayoutResult = GraphUtils.buildLayoutResult;
  var buildLayoutStatusMessage = GraphUtils.buildLayoutStatusMessage;
  var edgeKey = GraphUtils.edgeKey;
  var filterPositions = GraphUtils.filterPositions;
  var resolveFloatOption = GraphUtils.resolveFloatOption;
  var resolveIntOption = GraphUtils.resolveIntOption;
  var normalizeGraphInput = GraphUtils.normalizeGraphInput;
  var normalizeNodeIds = GraphUtils.normalizeNodeIds;
  var normalizeEdgePairs = GraphUtils.normalizeEdgePairs;
  var normalizeOuterFace = GraphUtils.normalizeOuterFace;
  var embeddingHasFace = GraphUtils.embeddingHasFace;
  var hasPositionCrossings = GraphUtils.hasPositionCrossings;

  function buildUniformWeights(edgePairs, value) {
    var pairs = normalizeEdgePairs(edgePairs);
    var weights = {};
    var w = Number.isFinite(value) && value > 0 ? value : 1;
    for (var i = 0; i < pairs.length; i += 1) {
      var u = pairs[i][0];
      var v = pairs[i][1];
      weights[edgeKey(u, v)] = w;
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
    var ids = normalizeNodeIds(nodeIds);
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
    var useSeed = !!opts.useSeedOuter;

    if (useSeed) {
      var seedPos = opts.seedPos || {};
      var minX = Infinity;
      var minY = Infinity;
      var maxX = -Infinity;
      var maxY = -Infinity;
      var haveSeed = false;

      for (i = 0; i < ids.length; i += 1) {
        var nid = ids[i];
        var sp = seedPos[nid];
        if (!sp || !Number.isFinite(sp.x) || !Number.isFinite(sp.y)) {
          continue;
        }
        haveSeed = true;
        if (sp.x < minX) minX = sp.x;
        if (sp.y < minY) minY = sp.y;
        if (sp.x > maxX) maxX = sp.x;
        if (sp.y > maxY) maxY = sp.y;
      }

      if (haveSeed) {
        cx = (minX + maxX) / 2;
        cy = (minY + maxY) / 2;
        var spanX = maxX - minX;
        var spanY = maxY - minY;
        var spanMin = Math.max(1, Math.min(spanX, spanY));
        R = Math.max(80, spanMin * 0.42);
      } else {
        R = Math.max(80, R);
      }
    }

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

  function computeBarycentricPositions(nodeIds, edgePairs, outerFace, options) {
    var opts = options || {};
    var graph = normalizeGraphInput(nodeIds, edgePairs);
    var ids = graph.nodeIds;
    var pairs = graph.edgePairs;
    var face = normalizeOuterFace(outerFace);
    var adjacency = opts.adjacency || buildAdjacencyArrays(ids, pairs);
    var weights = opts.weights || buildUniformWeights(pairs, 1);
    var rowWeights = opts.rowWeights || null;
    var maxIters = resolveIntOption(opts.maxIters, 1000, 1);
    var tol = resolveFloatOption(opts.tolerance, 1e-7, 0);
    var initOptions = opts.initOptions || defaultOuterPlacementOptions({ useSeedOuter: false });

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

    var pos = placeOuterFaceVertices(ids, face, initOptions);
    var outerSet = new Set(face);
    var iters = 0;
    var converged = false;

    while (!converged && iters < maxIters) {
      converged = true;
      iters += 1;
      for (var i = 0; i < ids.length; i += 1) {
        var v = ids[i];
        if (outerSet.has(v)) {
          continue;
        }
        var ngh = adjacency[v] || [];
        if (ngh.length === 0) {
          continue;
        }

        var sx = 0;
        var sy = 0;
        var sw = 0;
        for (var j = 0; j < ngh.length; j += 1) {
          var u = ngh[j];
          var w = rowWeights && rowWeights[v] ? rowWeights[v][u] : undefined;
          if (!Number.isFinite(w) || w <= 0) {
            w = weights[edgeKey(v, u)];
          }
          if (!Number.isFinite(w) || w <= 0) {
            w = 1;
          }
          sx += w * pos[u].x;
          sy += w * pos[u].y;
          sw += w;
        }
        if (!(sw > 0)) {
          continue;
        }
        var nx = sx / sw;
        var ny = sy / sw;
        if (Math.abs(pos[v].x - nx) > tol || Math.abs(pos[v].y - ny) > tol) {
          pos[v] = { x: nx, y: ny };
          converged = false;
        }
      }
    }

    return buildLayoutResult({
      ok: true,
      graph: graph,
      outerFace: face,
      pos: pos,
      iters: iters
    });
  }

  function computeTutteLayout(nodeIds, edgePairs, options) {
    var opts = options || {};
    var graph = normalizeGraphInput(nodeIds, edgePairs);
    var ids = graph.nodeIds;
    var pairs = graph.edgePairs;

    if (ids.length < 3) {
      return buildLayoutError({
        message: 'Tutte requires at least 3 vertices',
        graph: graph
      });
    }

    var prepared = PlaygroundUtils.prepareGraphAndLayoutData({
      nodeIds: ids,
      edgePairs: pairs
    }, {
      failureLabel: 'Tutte layout',
      minNodeCount: 3,
      augmentationMethod: opts.augmentationMethod || null,
      augmentationOptions: opts.augmentationOptions || null
    });
    if (!prepared || !prepared.ok) {
      return buildLayoutError(prepared || { message: 'Tutte failed' });
    }

    var projected = filterPositions(prepared.posById, ids);
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
      pos: projected,
      posById: prepared.posById,
      iters: prepared.initResult && Number.isFinite(prepared.initResult.iters) ? prepared.initResult.iters : 0
    });
  }

  function applyTutteLayout(cy, options) {
    var graph = PlaygroundUtils.graphFromCy(cy);
    var result = computeTutteLayout(graph.nodeIds, graph.edgePairs, options || {});
    if (!result || !result.ok) {
      return buildLayoutError(result || {
        message: 'Tutte failed',
        graph: graph
      });
    }

    if (typeof PlaygroundUtils.applyAndFit === 'function') {
      PlaygroundUtils.applyAndFit(cy, result.pos);
    } else {
      var nodes = cy.nodes().toArray();
      for (var i = 0; i < nodes.length; i += 1) {
        var nodeId = nodes[i].id();
        if (result.pos[nodeId]) {
          nodes[i].position(result.pos[nodeId]);
        }
      }
      cy.fit(undefined, 24);
    }

    return {
      ok: true,
      message: buildLayoutStatusMessage('Tutte', {
        outerFaceVertexCount: result.outerFace.length,
        iters: result.iters
      }),
      debugState: typeof PlaygroundUtils.createAugmentationDebugState === 'function'
        ? PlaygroundUtils.createAugmentationDebugState(
          result.graph,
          result.outerFace,
          result.augmented,
          result.posById
        )
        : null
    };
  }

  global.PlanarVibeTutteAlgorithm = {
    buildUniformWeights: buildUniformWeights,
    defaultOuterPlacementOptions: defaultOuterPlacementOptions,
    placeOuterFaceVertices: placeOuterFaceVertices,
    computeBarycentricPositions: computeBarycentricPositions,
    computeTutteLayout: computeTutteLayout
  };

  global.PlanarVibeTutte = {
    computeTutteLayout: computeTutteLayout,
    applyTutteLayout: applyTutteLayout
  };
})(window);
