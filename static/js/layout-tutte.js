(function (global) {
  'use strict';

  var PlanarCommon = global.PlanarVibePlanarCommon || {};
  var LayoutRuntime = global.PlanarVibeLayoutRuntime || {};
  var GraphCore = global.PlanarGraphCore;
  var buildAdjacency = GraphCore.buildAdjacency;
  var edgeKey = GraphCore.edgeKey;
  var normalizeNodeIds = GraphCore.normalizeNodeIds;
  var normalizeEdgePairs = GraphCore.normalizeEdgePairs;
  var normalizeOuterFace = GraphCore.normalizeOuterFace;
  var embeddingHasFace = GraphCore.embeddingHasFace;

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
    return pos;
  }

  function computeBarycentricPositions(nodeIds, edgePairs, outerFace, options) {
    var opts = options || {};
    var ids = normalizeNodeIds(nodeIds);
    var pairs = normalizeEdgePairs(edgePairs);
    var face = normalizeOuterFace(outerFace);
    var adjacency = opts.adjacency || buildAdjacency(ids, pairs);
    var weights = opts.weights || buildUniformWeights(pairs, 1);
    var rowWeights = opts.rowWeights || null;
    var maxIters = Number.isFinite(opts.maxIters) ? Math.max(1, Math.floor(opts.maxIters)) : 1000;
    var tol = Number.isFinite(opts.tolerance) ? Math.max(0, opts.tolerance) : 1e-7;
    var initOptions = opts.initOptions || defaultOuterPlacementOptions({ useSeedOuter: false });

    if (ids.length < 1) {
      return { ok: false, message: 'No vertices' };
    }
    if (face.length < 3) {
      return { ok: false, message: 'Outer face is invalid' };
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

    return { ok: true, pos: pos, iters: iters };
  }

  function extractOriginalPositions(posById, nodeIds) {
    var ids = normalizeNodeIds(nodeIds);
    var out = {};
    for (var i = 0; i < ids.length; i += 1) {
      var id = ids[i];
      if (posById[id]) {
        out[id] = { x: posById[id].x, y: posById[id].y };
      }
    }
    return out;
  }

  function computeTutteLayout(nodeIds, edgePairs, options) {
    var opts = options || {};
    var ids = normalizeNodeIds(nodeIds);
    var pairs = normalizeEdgePairs(edgePairs);

    if (ids.length < 3) {
      return {
        ok: false,
        message: 'Tutte requires at least 3 vertices'
      };
    }

    if (!PlanarCommon || typeof PlanarCommon.prepareTriangulatedLayoutData !== 'function') {
      return {
        ok: false,
        message: 'Shared planar prep is missing. Check script load order'
      };
    }

    var prepared = PlanarCommon.prepareTriangulatedLayoutData({
      nodeIds: ids,
      edgePairs: pairs
    }, {
      failureLabel: 'Tutte layout',
      minNodeCount: 3,
      baseEmbedding: opts.embedding || null,
      outerFace: Array.isArray(opts.outerFace) ? normalizeOuterFace(opts.outerFace) : null,
      augmentationOptions: opts.augmentationOptions || null,
      initPositions: function (solveNodeIds, solveEdgePairs, outerFace, localCy, context) {
        var embedding = context && context.augmented ? context.augmented.embedding : null;
        if (!embedding || !embedding.ok) {
          return { ok: false, message: 'Barycentric initialization requires a planar embedding' };
        }
        if (!embeddingHasFace(embedding, outerFace)) {
          return { ok: false, message: 'Provided outer face is not a face of the embedding' };
        }
        var connectivity = GraphCore.analyzeInternallyThreeConnected(solveNodeIds, solveEdgePairs, outerFace);
        if (!connectivity || !connectivity.ok) {
          return {
            ok: false,
            message: (connectivity && connectivity.reason) || 'Barycentric layout requires an internally 3-connected planar graph'
          };
        }
        return computeBarycentricPositions(
          solveNodeIds,
          solveEdgePairs,
          outerFace,
          {
          maxIters: Number.isFinite(opts.maxIters) ? Math.max(1, Math.floor(opts.maxIters)) : 1000,
          tolerance: Number.isFinite(opts.tolerance) ? Math.max(0, opts.tolerance) : 1e-7,
          initOptions: defaultOuterPlacementOptions({
            useSeedOuter: false
          })
          }
        );
      }
    });
    if (!prepared || !prepared.ok) {
      return prepared || { ok: false, message: 'Tutte failed' };
    }

    var projected = extractOriginalPositions(prepared.posById, ids);
    var hasCrossings = !!(global.PlanarVibeMetrics &&
      typeof global.PlanarVibeMetrics.hasCrossingsFromPositions === 'function' &&
      global.PlanarVibeMetrics.hasCrossingsFromPositions(
        projected,
        pairs
      ));
    if (hasCrossings) {
      return {
        ok: false,
        message: 'Tutte produced a non-plane drawing'
      };
    }

    return {
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
    };
  }

  function applyTutteLayout(cy) {
    var graph = PlanarCommon.graphFromCy(cy);
    var result = computeTutteLayout(graph.nodeIds, graph.edgePairs);
    if (!result || !result.ok) {
      return result || { ok: false, message: 'Tutte failed' };
    }

    if (typeof LayoutRuntime.applyAndFit === 'function') {
      LayoutRuntime.applyAndFit(cy, result.nodeIds, result.pos, 24);
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
      message: 'Applied Tutte (' + result.outerFace.length + '-vertex outer face, ' + result.iters + ' iters)',
      debugState: typeof PlanarCommon.createAugmentationDebugState === 'function'
        ? PlanarCommon.createAugmentationDebugState(
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
