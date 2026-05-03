(function (global) {
  'use strict';

  var buildLayoutError = global.GraphUtils.buildLayoutError;
  var buildLayoutResult = global.GraphUtils.buildLayoutResult;
  var buildLayoutStatusMessage = global.GraphUtils.buildLayoutStatusMessage;
  var CyRuntime = global.CyRuntime;
  var normalizePositionMapToViewport = global.GeometryUtils.normalizePositionMapToViewport;

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

  function cliqueKey(a, b, c, indexById) {
    var arr = [a, b, c];
    arr.sort(function (x, y) {
      return indexById[x] - indexById[y];
    });
    return arr[0] + '|' + arr[1] + '|' + arr[2];
  }

  function computeP3TPositions(graph) {
    var ids = graph.nodeIds;
    var info = global.PlanarVibePlanarityTest.analyzePlanar3Tree(graph);
    if (!info.ok) {
      return buildLayoutError({
        message: 'P3T requires a planar 3-tree: ' + info.reason
      });
    }

    var emb = info.embedding;
    var outer = info.outerFace;
    var indexById = emb.indexById;

    var parents2v = {};
    for (var i = info.elimination.length - 1; i >= 0; i -= 1) {
      var rec = info.elimination[i];
      parents2v[cliqueKey(rec.parents[0], rec.parents[1], rec.parents[2], indexById)] = rec.vertex;
    }

    var countInternals = {};
    function countInternalVertices(v0, v1, v2) {
      var key = cliqueKey(v0, v1, v2, indexById);
      var v = parents2v[key];
      if (v === undefined) {
        countInternals[key] = 0;
        return 0;
      }

      var c0 = countInternalVertices(v1, v2, v);
      var c1 = countInternalVertices(v2, v0, v);
      var c2 = countInternalVertices(v0, v1, v);
      countInternals[key] = c0 + c1 + c2 + 1;
      return countInternals[key];
    }

    var coord = {};
    for (i = 0; i < outer.length; i += 1) {
      var angle = 2.0 * Math.PI * i / outer.length;
      coord[outer[outer.length - i - 1]] = {
        x: 1000 * Math.cos(angle) + 2000,
        y: 1000 * Math.sin(angle) + 2000
      };
    }

    countInternalVertices(outer[0], outer[1], outer[2]);

    function processClique(v0, v1, v2) {
      var key = cliqueKey(v0, v1, v2, indexById);
      var v = parents2v[key];
      if (v === undefined) {
        return;
      }

      var k0 = cliqueKey(v1, v2, v, indexById);
      var k1 = cliqueKey(v2, v0, v, indexById);
      var k2 = cliqueKey(v0, v1, v, indexById);

      var a0 = (countInternals[k0] || 0) * 2 + 1;
      var a1 = (countInternals[k1] || 0) * 2 + 1;
      var a2 = (countInternals[k2] || 0) * 2 + 1;
      var sum = a0 + a1 + a2;

      coord[v] = {
        x: (a0 * coord[v0].x + a1 * coord[v1].x + a2 * coord[v2].x) / sum,
        y: (a0 * coord[v0].y + a1 * coord[v1].y + a2 * coord[v2].y) / sum
      };

      processClique(v1, v2, v);
      processClique(v2, v0, v);
      processClique(v0, v1, v);
    }

    processClique(outer[0], outer[1], outer[2]);

    return buildLayoutResult({
      nodeIds: ids,
      edgePairs: graph.edgePairs,
      outerFace: outer.slice(),
      graph: graph,
      embedding: emb,
      positions: normalizePositionMapToViewport(coord)
    });
  }

  function applyP3TLayout(cy, options) {
    return CyRuntime.runLayout(cy, options, {
      initialFitBounds: function (ctx) {
        var defaults = global.PlanarVibeViewportDefaults || {};
        var width = Number.isFinite(defaults.width) ? defaults.width : 900;
        var height = Number.isFinite(defaults.height) ? defaults.height : 620;
        return { x1: 0, y1: 0, x2: width, y2: height };
      },
      computePositions: async function (graph, computeOptions) {
        var result = computeP3TPositions(graph);
        await emitSingleIteration(computeOptions || {}, result);
        return result;
      },
      buildResult: function (ctx) {
        return {
          ok: true,
          message: buildLayoutStatusMessage('P3T equal-face-area layout', {
            vertexCount: ctx.result.nodeIds.length
          })
        };
      },
      failureMessage: 'P3T failed'
    });
  }

  global.PlanarVibeP3T = {
    computeP3TPositions: computeP3TPositions,
    applyP3TLayout: applyP3TLayout
  };
})(window);
