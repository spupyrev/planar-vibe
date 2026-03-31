(function (global) {
  'use strict';

  var PlanarityTest = global.PlanarVibePlanarityTest;
  var PlaygroundUtils = global.PlaygroundUtils;

  function cliqueKey(a, b, c, indexById) {
    var arr = [a, b, c];
    arr.sort(function (x, y) {
      return indexById[x] - indexById[y];
    });
    return arr[0] + '|' + arr[1] + '|' + arr[2];
  }

  function computeP3TPositions(nodeIds, edgePairs) {
    var ids = (nodeIds || []).map(String);
    var pairs = (edgePairs || []).map(function (edge) { return [String(edge[0]), String(edge[1])]; });
    var info = PlanarityTest.analyzePlanar3Tree(ids, pairs);
    if (!info.ok) {
      return {
        ok: false,
        message: 'P3T requires a planar 3-tree: ' + info.reason
      };
    }

    var emb = info.embedding;
    var outer = info.outerFace;
    var indexById = emb.indexById;

    var insertion = info.elimination.slice().reverse();
    var parents2v = {};
    for (var i = 0; i < insertion.length; i += 1) {
      var rec = insertion[i];
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
    for (i = 0; i < ids.length; i += 1) {
      coord[ids[i]] = { x: 0, y: 0 };
    }

    var R = 1000;
    var gamma = 2.0 * Math.PI / outer.length;
    for (i = 0; i < outer.length; i += 1) {
      var ov = outer[outer.length - i - 1];
      coord[ov] = {
        x: R * Math.cos(gamma * i) + 2.0 * R,
        y: R * Math.sin(gamma * i) + 2.0 * R
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

    return {
      ok: true,
      nodeIds: ids,
      edgePairs: pairs,
      outerFace: outer.slice(),
      embedding: emb,
      pos: coord
    };
  }

  function applyP3TLayout(cy) {
    var graph = PlaygroundUtils.graphFromCy(cy);
    var result = computeP3TPositions(graph.nodeIds, graph.edgePairs);
    if (!result || !result.ok) {
      return result || { ok: false, message: 'P3T failed' };
    }

    PlaygroundUtils.applyAndFit(cy, result.pos);
    return {
      ok: true,
      message: 'Applied P3T equal-face-area layout (' + result.nodeIds.length + ' vertices)'
    };
  }

  global.PlanarVibeP3T = {
    computeP3TPositions: computeP3TPositions,
    applyP3TLayout: applyP3TLayout
  };
})(window);
