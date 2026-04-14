(function (global) {
  'use strict';

  var GraphUtils = global.GraphUtils;
  var CyRuntime = global.CyRuntime;
  var buildLayoutResult = GraphUtils.buildLayoutResult;
  var normalizedHash = GraphUtils.normalizedHash;

  function computeRandomPositions(graph, width, height) {
    var ids = Array.isArray(graph && graph.nodeIds) ? graph.nodeIds.map(String) : [];
    var safeWidth = Number.isFinite(width) ? width : 320;
    var safeHeight = Number.isFinite(height) ? height : 260;
    var widthPx = Math.max(safeWidth, 320);
    var heightPx = Math.max(safeHeight, 260);
    var margin = 26;
    var xSpan = Math.max(widthPx - margin * 2, 1);
    var ySpan = Math.max(heightPx - margin * 2, 1);
    var posById = {};
    for (var i = 0; i < ids.length; i += 1) {
      var id = ids[i];
      var x = margin + normalizedHash(id + ':x', 2166136261) * xSpan;
      var y = margin + normalizedHash(id + ':y', 33554467) * ySpan;
      posById[id] = { x: x, y: y };
    }
    return buildLayoutResult({
      ok: true,
      nodeIds: ids,
      positions: posById
    });
  }

  function applyRandomLayout(cy, options) {
    return CyRuntime.runLayout(cy, options, {
      fitPadding: 20,
      patchComputeOptions: function (ctx) {
        return {
          width: ctx.cy.width(),
          height: ctx.cy.height()
        };
      },
      compute: function (graph, computeOptions) {
        return computeRandomPositions(
          graph,
          computeOptions && computeOptions.width,
          computeOptions && computeOptions.height
        );
      },
      buildResult: function () {
        return { ok: true, message: 'Applied random coordinates' };
      },
      failureMessage: 'Random failed'
    });
  }

  global.PlanarVibeRandom = {
    computeRandomPositions: computeRandomPositions,
    applyRandomLayout: applyRandomLayout
  };
})(window);
