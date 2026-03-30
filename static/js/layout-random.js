(function (global) {
  'use strict';

  var PlaygroundUtils = global.PlaygroundUtils || {};

  function hashString(value, seed) {
    var hash = seed >>> 0;
    var text = String(value);
    for (var i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function normalizedHash(value, seed) {
    return hashString(value, seed) / 4294967295;
  }

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
    return {
      ok: true,
      nodeIds: ids,
      pos: posById
    };
  }

  function applyRandomLayout(cy) {
    var nodeIds = [];
    cy.nodes().forEach(function (node) {
      nodeIds.push(String(node.id()));
    });
    var result = computeRandomPositions(nodeIds, cy.width(), cy.height());
    var posById = result.pos;
    if (typeof PlaygroundUtils.applyAndFit === 'function') {
      PlaygroundUtils.applyAndFit(cy, posById, 20);
    } else {
      cy.nodes().forEach(function (node) {
        var id = String(node.id());
        if (posById[id]) {
          node.position(posById[id]);
        }
      });
      cy.fit(undefined, 20);
    }
    return { ok: true, message: 'Applied random coordinates' };
  }

  global.PlanarVibeRandom = {
    computeRandomPositions: computeRandomPositions,
    applyRandomLayout: applyRandomLayout
  };
})(window);
