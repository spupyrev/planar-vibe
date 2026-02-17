(function (global) {
  'use strict';

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

  function applyRandomLayout(cy) {
    var width = Math.max(cy.width(), 320);
    var height = Math.max(cy.height(), 260);
    var margin = 26;
    var xSpan = Math.max(width - margin * 2, 1);
    var ySpan = Math.max(height - margin * 2, 1);

    cy.nodes().forEach(function (node) {
      var id = node.id();
      var x = margin + normalizedHash(id + ':x', 2166136261) * xSpan;
      var y = margin + normalizedHash(id + ':y', 33554467) * ySpan;
      node.position({ x: x, y: y });
    });
    cy.fit(undefined, 20);
    return { ok: true, message: 'Applied random coordinates' };
  }

  global.PlanarVibeRandom = {
    applyRandomLayout: applyRandomLayout
  };
})(window);
