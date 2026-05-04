(function (global) {
  'use strict';

  var GraphUtils = global.GraphUtils;
  var CyRuntime = global.CyRuntime;
  var buildLayoutResult = GraphUtils.buildLayoutResult;
  var normalizedHash = GraphUtils.normalizedHash;

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

  function createLayoutInput(_graph, runtime) {
    runtime = runtime || {};
    return {
      ok: true,
      width: runtime.width,
      height: runtime.height
    };
  }

  function computePositions(graph, layoutInput) {
    return computeRandomPositions(
      graph,
      layoutInput.width,
      layoutInput.height
    );
  }

  function applyRandomLayout(cy, options) {
    return CyRuntime.runLayout(cy, options, {
      initialFitBounds: function (ctx) {
        var width = Math.max(Number(ctx.cy && ctx.cy.width && ctx.cy.width()) || 320, 320);
        var height = Math.max(Number(ctx.cy && ctx.cy.height && ctx.cy.height()) || 260, 260);
        return { x1: 0, y1: 0, x2: width, y2: height };
      },
      patchComputeOptions: function (ctx) {
        return {
          width: ctx.cy.width(),
          height: ctx.cy.height()
        };
	      },
	      computePositions: async function (graph, computeOptions) {
	        var result = computePositions(graph, createLayoutInput(graph, computeOptions));
	        await emitSingleIteration(computeOptions || {}, result);
	        return result;
	      },
      buildResult: function () {
        return { ok: true, message: 'Applied random coordinates' };
      },
      failureMessage: 'Random failed'
    });
  }

	  global.PlanarVibeRandom = {
	    createLayoutInput: createLayoutInput,
	    computePositions: computePositions,
	    applyLayout: applyRandomLayout
	  };
})(window);
