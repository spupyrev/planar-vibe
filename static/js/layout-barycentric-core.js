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

  function buildUniformWeights(edgePairs, value) {
    var weights = {};
    var w = Number.isFinite(value) && value > 0 ? value : 1;
    for (var i = 0; i < edgePairs.length; i += 1) {
      var u = String(edgePairs[i][0]);
      var v = String(edgePairs[i][1]);
      weights[edgeKey(u, v)] = w;
    }
    return weights;
  }

  function initOuterCoords(nodeIds, outerFace, options) {
    var opts = options || {};
    var pos = {};
    var i;
    for (i = 0; i < nodeIds.length; i += 1) {
      pos[String(nodeIds[i])] = { x: 0, y: 0 };
    }

    var cx = Number.isFinite(opts.defaultCenterX) ? opts.defaultCenterX : 2000;
    var cy = Number.isFinite(opts.defaultCenterY) ? opts.defaultCenterY : 2000;
    var R = Number.isFinite(opts.defaultRadius) && opts.defaultRadius > 0 ? opts.defaultRadius : 1000;
    var useSeed = !!opts.useSeedOuter;

    if (useSeed) {
      var seedPos = opts.seedPos || {};
      var minX = Infinity;
      var minY = Infinity;
      var maxX = -Infinity;
      var maxY = -Infinity;
      var haveSeed = false;

      for (i = 0; i < nodeIds.length; i += 1) {
        var nid = String(nodeIds[i]);
        var sp = seedPos[nid];
        if (!sp || !Number.isFinite(sp.x) || !Number.isFinite(sp.y)) {
          continue;
        }
        haveSeed = true;
        if (sp.x < minX) minX = sp.x;
        if (sp.y < minY) minY = sp.y;
        if (sp.x > maxX) maxX = sp.x;
        if (sp.y > maxY) maxY = sp.y;
      }

      if (haveSeed) {
        cx = (minX + maxX) / 2;
        cy = (minY + maxY) / 2;
        var spanX = maxX - minX;
        var spanY = maxY - minY;
        var spanMin = Math.max(1, Math.min(spanX, spanY));
        R = Math.max(80, spanMin * 0.42);
      } else {
        R = Math.max(80, R);
      }
    }

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

  function solveWeightedBarycentricLayout(input) {
    var nodeIds = (input && input.nodeIds) ? input.nodeIds.map(String) : [];
    var adjacency = (input && input.adjacency) ? input.adjacency : {};
    var outerFace = (input && input.outerFace) ? input.outerFace.map(String) : [];
    var weights = (input && input.weights) ? input.weights : {};
    var maxIters = Number.isFinite(input && input.maxIters) ? Math.max(1, Math.floor(input.maxIters)) : 1000;
    var tol = Number.isFinite(input && input.tolerance) ? Math.max(0, input.tolerance) : 1e-6;
    var initOptions = input && input.initOptions ? input.initOptions : {};

    if (nodeIds.length < 1) {
      return { ok: false, message: 'No vertices' };
    }
    if (outerFace.length < 3) {
      return { ok: false, message: 'Outer face is invalid' };
    }

    var pos = initOuterCoords(nodeIds, outerFace, initOptions);
    var outerSet = new Set(outerFace);
    var iters = 0;
    var converged = false;

    while (!converged && iters < maxIters) {
      converged = true;
      iters += 1;
      for (var i = 0; i < nodeIds.length; i += 1) {
        var v = String(nodeIds[i]);
        if (outerSet.has(v)) {
          continue;
        }
        var ngh = adjacency[v] || [];
        if (ngh.length === 0) {
          continue;
        }

        var sx = 0;
        var sy = 0;
        var sw = 0;
        for (var j = 0; j < ngh.length; j += 1) {
          var u = String(ngh[j]);
          var w = weights[edgeKey(v, u)];
          if (!Number.isFinite(w) || w <= 0) {
            w = 1;
          }
          sx += w * pos[u].x;
          sy += w * pos[u].y;
          sw += w;
        }
        if (!(sw > 0)) {
          continue;
        }
        var nx = sx / sw;
        var ny = sy / sw;
        if (Math.abs(pos[v].x - nx) > tol || Math.abs(pos[v].y - ny) > tol) {
          pos[v] = { x: nx, y: ny };
          converged = false;
        }
      }
    }

    return { ok: true, pos: pos, iters: iters };
  }

  global.PlanarVibeBarycentricCore = {
    edgeKey: edgeKey,
    currentPositionsFromCy: currentPositionsFromCy,
    buildUniformWeights: buildUniformWeights,
    solveWeightedBarycentricLayout: solveWeightedBarycentricLayout
  };
})(window);
