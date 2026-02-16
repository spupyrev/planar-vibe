(function (global) {
  'use strict';

  function faceCanonicalKey(face) {
    if (!face || face.length === 0) {
      return '';
    }
    var arr = face.map(String);
    var n = arr.length;

    function bestRotation(seq) {
      var best = null;
      for (var i = 0; i < n; i += 1) {
        var rot = seq.slice(i).concat(seq.slice(0, i)).join('|');
        if (best === null || rot < best) {
          best = rot;
        }
      }
      return best;
    }

    var forward = bestRotation(arr);
    var backward = bestRotation(arr.slice().reverse());
    return forward < backward ? forward : backward;
  }

  function polygonAreaAbs(face, posById) {
    if (!face || face.length < 3) {
      return 0;
    }
    var sum = 0;
    for (var i = 0; i < face.length; i += 1) {
      var a = posById[String(face[i])];
      var b = posById[String(face[(i + 1) % face.length])];
      if (!a || !b || !Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(b.x) || !Number.isFinite(b.y)) {
        return 0;
      }
      sum += a.x * b.y - b.x * a.y;
    }
    return Math.abs(sum) / 2;
  }

  function computeFaceAreaDistribution(nodeIds, edgePairs, posById) {
    if (!global.PlanarVibePlanarityTest || !global.PlanarVibePlanarityTest.computePlanarEmbedding) {
      return { ok: false, reason: 'Planarity utilities are missing.' };
    }
    var emb = global.PlanarVibePlanarityTest.computePlanarEmbedding(nodeIds, edgePairs);
    if (!emb || !emb.ok) {
      return { ok: false, reason: 'Graph is not planar' };
    }
    if (!emb.faces || emb.faces.length === 0) {
      return { ok: false, reason: 'No faces available' };
    }

    var outerKey = emb.outerFace ? faceCanonicalKey(emb.outerFace) : null;
    var areas = [];
    for (var i = 0; i < emb.faces.length; i += 1) {
      var face = emb.faces[i];
      if (outerKey && faceCanonicalKey(face) === outerKey) {
        continue;
      }
      var a = polygonAreaAbs(face, posById);
      if (a > 1e-12) {
        areas.push(a);
      }
    }

    if (areas.length === 0) {
      return { ok: false, reason: 'No bounded face areas available' };
    }

    var total = 0;
    for (i = 0; i < areas.length; i += 1) {
      total += areas[i];
    }
    if (!(total > 0)) {
      return { ok: false, reason: 'Degenerate face areas.' };
    }

    var normalized = areas.map(function (a) { return a / total; });
    normalized.sort(function (x, y) { return x - y; });

    return {
      ok: true,
      values: normalized,
      ideal: 1 / normalized.length,
      faceCount: normalized.length
    };
  }

  function computeFaceAreaDistributionFromCy(cy, edgePairs) {
    var nodeIds = [];
    var posById = {};
    cy.nodes().forEach(function (node) {
      var id = String(node.id());
      nodeIds.push(id);
      var p = node.position();
      posById[id] = { x: p.x, y: p.y };
    });
    var pairs = edgePairs || cy.edges().map(function (e) {
      return [String(e.source().id()), String(e.target().id())];
    });
    return computeFaceAreaDistribution(nodeIds, pairs, posById);
  }

  global.PlanarVibeMetrics = {
    computeFaceAreaDistribution: computeFaceAreaDistribution,
    computeFaceAreaDistributionFromCy: computeFaceAreaDistributionFromCy
  };
})(window);
