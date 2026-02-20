(function (global) {
  'use strict';

  function edgeKey(u, v) {
    var a = String(u);
    var b = String(v);
    return a < b ? a + '::' + b : b + '::' + a;
  }

  function currentPositionsFromCy(cy) {
    var pos = {};
    var nodes = cy.nodes().toArray();
    for (var i = 0; i < nodes.length; i += 1) {
      var id = String(nodes[i].id());
      var p = nodes[i].position();
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        pos[id] = { x: p.x, y: p.y };
      }
    }
    return pos;
  }

  function initOuterCoords(nodeIds, outerFace, seedPos) {
    var pos = {};
    var i;
    for (i = 0; i < nodeIds.length; i += 1) {
      pos[String(nodeIds[i])] = { x: 0, y: 0 };
    }

    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    var haveSeed = false;
    for (i = 0; i < nodeIds.length; i += 1) {
      var nid = String(nodeIds[i]);
      var sp = seedPos ? seedPos[nid] : null;
      if (!sp || !Number.isFinite(sp.x) || !Number.isFinite(sp.y)) {
        continue;
      }
      haveSeed = true;
      if (sp.x < minX) minX = sp.x;
      if (sp.y < minY) minY = sp.y;
      if (sp.x > maxX) maxX = sp.x;
      if (sp.y > maxY) maxY = sp.y;
    }

    var cx = haveSeed ? (minX + maxX) / 2 : 2000;
    var cy = haveSeed ? (minY + maxY) / 2 : 2000;
    var spanX = haveSeed ? (maxX - minX) : 1200;
    var spanY = haveSeed ? (maxY - minY) : 900;
    var spanMin = Math.max(1, Math.min(spanX, spanY));
    var R = Math.max(80, spanMin * 0.42);
    var gamma = 2 * Math.PI / outerFace.length;

    for (i = 0; i < outerFace.length; i += 1) {
      var v = String(outerFace[outerFace.length - i - 1]);
      pos[v] = {
        x: cx + R * Math.cos(gamma * (0.25 + i)),
        y: cy + R * Math.sin(gamma * (0.25 + i))
      };
    }
    return pos;
  }

  function bfsDepthFromOuter(nodeIds, adjacency, outerFace, depthSource) {
    var depth = {};
    var q = [];
    var head = 0;
    var i;
    var mode = String(depthSource || 'outer-multi');

    for (i = 0; i < nodeIds.length; i += 1) {
      depth[String(nodeIds[i])] = Infinity;
    }
    if (mode === 'outer-single') {
      if (outerFace.length > 0) {
        var first = String(outerFace[0]);
        depth[first] = 0;
        q.push(first);
      }
    } else {
      for (i = 0; i < outerFace.length; i += 1) {
        var root = String(outerFace[i]);
        depth[root] = 0;
        q.push(root);
      }
    }

    while (head < q.length) {
      var u = q[head];
      head += 1;
      var du = depth[u];
      var ngh = adjacency[u] || [];
      for (i = 0; i < ngh.length; i += 1) {
        var v = String(ngh[i]);
        if (depth[v] <= du + 1) continue;
        depth[v] = du + 1;
        q.push(v);
      }
    }

    for (i = 0; i < nodeIds.length; i += 1) {
      var id = String(nodeIds[i]);
      if (!Number.isFinite(depth[id])) {
        depth[id] = 0;
      }
    }
    return depth;
  }

  function buildDepthWeights(edgePairs, depthById, a, r, edgeDepthMode) {
    var weights = {};
    var scale = Number.isFinite(a) && a > 0 ? a : 1;
    var ratio = Number.isFinite(r) && r > 1 ? r : 1.35;
    var mode = String(edgeDepthMode || 'min');

    for (var i = 0; i < edgePairs.length; i += 1) {
      var u = String(edgePairs[i][0]);
      var v = String(edgePairs[i][1]);
      var du = depthById[u];
      var dv = depthById[v];
      var d;
      if (mode === 'max') {
        d = Math.max(du, dv);
      } else if (mode === 'avg') {
        d = 0.5 * (du + dv);
      } else {
        d = Math.min(du, dv);
      }
      if (!Number.isFinite(d) || d < 0) d = 0;
      var w = scale / Math.pow(ratio, d);
      if (!(w > 0)) w = 1;
      weights[edgeKey(u, v)] = w;
    }
    return weights;
  }

  function barycentricLayoutWeighted(nodeIds, adjacency, outerFace, weights, maxIters, seedPos) {
    var pos = initOuterCoords(nodeIds, outerFace, seedPos);
    var outerSet = new Set(outerFace.map(String));
    var iters = 0;
    var converged = false;

    while (!converged && iters < maxIters) {
      converged = true;
      iters += 1;
      for (var i = 0; i < nodeIds.length; i += 1) {
        var v = String(nodeIds[i]);
        if (outerSet.has(v)) continue;
        var ngh = adjacency[v] || [];
        if (ngh.length === 0) continue;

        var sx = 0;
        var sy = 0;
        var sw = 0;
        for (var j = 0; j < ngh.length; j += 1) {
          var u = String(ngh[j]);
          var w = weights[edgeKey(v, u)];
          if (!Number.isFinite(w) || w <= 0) w = 1;
          sx += w * pos[u].x;
          sy += w * pos[u].y;
          sw += w;
        }
        if (!(sw > 0)) continue;
        var nx = sx / sw;
        var ny = sy / sw;
        if (Math.abs(pos[v].x - nx) > 1e-8 || Math.abs(pos[v].y - ny) > 1e-8) {
          pos[v] = { x: nx, y: ny };
          converged = false;
        }
      }
    }
    return { pos: pos, iters: iters };
  }

  function applyCEG23Layout(cy, options) {
    var opts = options || {};
    var tuning = opts.tuning || {};

    if (!global.PlanarVibePlanarityTest || !global.PlanarVibePlanarityTest.computePlanarEmbedding) {
      return { ok: false, message: 'Planarity utilities are missing' };
    }
    if (!global.PlanarGraphCore || typeof global.PlanarGraphCore.graphFromCy !== 'function') {
      return { ok: false, message: 'PlanarGraphCore is missing. Check script load order' };
    }

    var nodes = cy.nodes().toArray();
    if (nodes.length < 3) {
      return { ok: false, message: 'CEG23 requires at least 3 vertices' };
    }

    var graph = global.PlanarGraphCore.graphFromCy(cy);
    var nodeIds = graph.nodeIds.slice().map(String);
    var edgePairs = cy.edges().map(function (e) {
      return [String(e.source().id()), String(e.target().id())];
    });

    var emb = global.PlanarVibePlanarityTest.computePlanarEmbedding(nodeIds, edgePairs);
    if (!emb || !emb.ok) {
      return { ok: false, message: 'CEG23 requires a planar graph' };
    }

    var outerFace = graph.chooseOuterFace();
    if (!outerFace || outerFace.length < 3) {
      return { ok: false, message: 'Could not determine outer face' };
    }

    var A = Number.isFinite(tuning.a) && tuning.a > 0 ? tuning.a : 1.0;
    var R = Number.isFinite(tuning.r) && tuning.r > 1 ? tuning.r : 1.35;
    var MAX_ITERS = Number.isFinite(tuning.maxIters) ? Math.max(1, Math.floor(tuning.maxIters)) : 4000;
    var DEPTH_SOURCE = String(tuning.depthSource || 'outer-multi');
    var EDGE_DEPTH_MODE = String(tuning.edgeDepthMode || 'min');

    var depthById = bfsDepthFromOuter(nodeIds, graph.adjacency, outerFace, DEPTH_SOURCE);
    var weights = buildDepthWeights(edgePairs, depthById, A, R, EDGE_DEPTH_MODE);
    var seedPos = currentPositionsFromCy(cy);
    var out = barycentricLayoutWeighted(nodeIds, graph.adjacency, outerFace, weights, MAX_ITERS, seedPos);

    for (var i = 0; i < nodes.length; i += 1) {
      var id = String(nodes[i].id());
      if (out.pos[id]) {
        nodes[i].position(out.pos[id]);
      }
    }
    cy.fit(undefined, 24);

    return {
      ok: true,
      message: 'Applied CEG23 (' + outerFace.length + '-vertex outer face, depth=' + DEPTH_SOURCE + ', edgeDepth=' + EDGE_DEPTH_MODE + ', r=' + R + ', ' + out.iters + ' iters)'
    };
  }

  global.PlanarVibeCEG23 = {
    applyCEG23Layout: applyCEG23Layout
  };
})(window);
