(function (global) {
  'use strict';

  var GraphUtils = global.GraphUtils;
  var PlaygroundUtils = global.PlaygroundUtils;
  var buildLayoutResult = GraphUtils.buildLayoutResult;
  var normalizedHash = GraphUtils.normalizedHash;

  function computeRandomPositions(nodeIds, width, height) {
    var ids = (nodeIds || []).map(String);
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
      pos: posById
    });
  }

  function applyRandomLayout(cy) {
    var graph = PlaygroundUtils.graphFromCy(cy);
    var result = computeRandomPositions(graph.nodeIds, cy.width(), cy.height());
    PlaygroundUtils.applyAndFit(cy, result.pos, 20);
    return { ok: true, message: 'Applied random coordinates' };
  }

  global.PlanarVibeRandom = {
    computeRandomPositions: computeRandomPositions,
    applyRandomLayout: applyRandomLayout
  };
})(window);
