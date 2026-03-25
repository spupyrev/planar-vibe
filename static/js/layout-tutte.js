(function (global) {
  'use strict';

  var PlanarCommon = global.PlanarVibePlanarCommon || {};
  var LayoutRuntime = global.PlanarVibeLayoutRuntime || {};

  function checkTutteDependencies() {
    if (!global.PlanarVibePlanarityTest || !global.PlanarVibePlanarityTest.computePlanarEmbedding) {
      return {
        ok: false,
        message: 'Planarity utilities are missing. Check script load order'
      };
    }
    if (!global.PlanarGraphCore || !global.PlanarGraphCore.prepareTriangulatedByFaceStellation) {
      return {
        ok: false,
        message: 'PlanarGraphCore is missing. Check script load order'
      };
    }
    if (!PlanarCommon || typeof PlanarCommon.prepareTriangulatedLayoutData !== 'function') {
      return {
        ok: false,
        message: 'Shared planar prep is missing. Check script load order'
      };
    }
    if (!global.PlanarVibeBarycentricCore || typeof global.PlanarVibeBarycentricCore.computeBarycentricLayout !== 'function') {
      return {
        ok: false,
        message: 'Barycentric core is missing. Check script load order'
      };
    }
    return { ok: true };
  }

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

  function computeTutteLayout(nodeIds, edgePairs, options) {
    var opts = options || {};
    var ids = (nodeIds || []).map(String);
    var pairs = (edgePairs || []).map(function (e) { return [String(e[0]), String(e[1])]; });

    if (ids.length < 3) {
      return {
        ok: false,
        message: 'Tutte requires at least 3 vertices'
      };
    }

    var deps = checkTutteDependencies();
    if (!deps.ok) {
      return deps;
    }

    var prepared = PlanarCommon.prepareTriangulatedLayoutData({
      nodeIds: ids,
      edgePairs: pairs
    }, {
      failureLabel: 'Tutte layout',
      minNodeCount: 3,
      baseEmbedding: opts.embedding || null,
      outerFace: Array.isArray(opts.outerFace) ? opts.outerFace.slice().map(String) : null,
      augmentationOptions: opts.augmentationOptions || null,
      initPositions: function (solveNodeIds, solveEdgePairs, outerFace, localCy, context) {
        return global.PlanarVibeBarycentricCore.computeBarycentricLayout(solveNodeIds, solveEdgePairs, {
          outerFace: outerFace,
          embedding: context && context.augmented ? context.augmented.embedding : null,
          maxIters: Number.isFinite(opts.maxIters) ? Math.max(1, Math.floor(opts.maxIters)) : 1000,
          tolerance: Number.isFinite(opts.tolerance) ? Math.max(0, opts.tolerance) : 1e-7,
          initOptions: global.PlanarVibeBarycentricCore.defaultOuterInitOptions({
            useSeedOuter: false
          })
        });
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
      pos: projected,
      iters: prepared.initResult && Number.isFinite(prepared.initResult.iters) ? prepared.initResult.iters : 0,
      debugState: typeof PlanarCommon.createAugmentationDebugState === 'function'
        ? PlanarCommon.createAugmentationDebugState(
          prepared.graph,
          prepared.outerFace,
          prepared.augmented,
          prepared.posById
        )
        : null
    };
  }

  function applyTutteLayout(cy) {
    var nodes = cy.nodes().toArray();
    var graph = PlanarCommon.graphFromCy(cy);
    var result = computeTutteLayout(graph.nodeIds, graph.edgePairs);
    if (!result || !result.ok) {
      return result || { ok: false, message: 'Tutte failed' };
    }

    if (typeof LayoutRuntime.applyAndFit === 'function') {
      LayoutRuntime.applyAndFit(cy, result.nodeIds, result.pos, 24);
    } else {
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
      debugState: result.debugState || null
    };
  }

  global.PlanarVibeTutte = {
    computeTutteLayout: computeTutteLayout,
    computeTutteGeometry: computeTutteLayout,
    applyTutteLayout: applyTutteLayout
  };
})(window);
