(function (global) {
  'use strict';

  function asPlanarGraph(cy) {
    if (!global.PlanarGraphCore || !global.PlanarGraphCore.graphFromCy) {
      return null;
    }
    return global.PlanarGraphCore.graphFromCy(cy);
  }

  function applyTutteLayout(cy) {
    var nodes = cy.nodes().toArray();
    if (nodes.length < 3) {
      return {
        ok: false,
        message: 'Tutte requires at least 3 vertices'
      };
    }

    var planarGraph = asPlanarGraph(cy);
    if (!planarGraph) {
      return {
        ok: false,
        message: 'PlanarGraphCore is missing. Check script load order'
      };
    }

    var adj = planarGraph.adjacency;
    var outerFace = planarGraph.chooseOuterFace();
    if (!outerFace || outerFace.length < 3) {
      return {
        ok: false,
        message: 'Could not find/build outer face for Tutte'
      };
    }

    var coord = {};
    for (var i = 0; i < nodes.length; i += 1) {
      coord[nodes[i].id()] = { x: 0, y: 0 };
    }

    var R = 1000;
    var gamma = 2.0 * Math.PI / outerFace.length;
    for (var j = 0; j < outerFace.length; j += 1) {
      var v = outerFace[outerFace.length - j - 1];
      var x = R * Math.cos(gamma * (0.25 + j)) + 2.0 * R;
      var y = R * Math.sin(gamma * (0.25 + j)) + 2.0 * R;
      coord[v] = { x: x, y: y };
    }

    var outerSet = {};
    for (var k = 0; k < outerFace.length; k += 1) {
      outerSet[outerFace[k]] = true;
    }

    var iters = 0;
    var converged = false;
    while (!converged && iters < 1000) {
      converged = true;
      iters += 1;

      for (var n = 0; n < nodes.length; n += 1) {
        var id = nodes[n].id();
        if (outerSet[id]) {
          continue;
        }

        var ngh = adj[id] || [];
        if (ngh.length === 0) {
          continue;
        }

        var sx = 0;
        var sy = 0;
        for (var p = 0; p < ngh.length; p += 1) {
          var u = ngh[p];
          sx += coord[u].x;
          sy += coord[u].y;
        }
        var nx = sx / ngh.length;
        var ny = sy / ngh.length;

        if (Math.abs(coord[id].x - nx) > 1e-6 || Math.abs(coord[id].y - ny) > 1e-6) {
          coord[id] = { x: nx, y: ny };
          converged = false;
        }
      }
    }

    for (var q = 0; q < nodes.length; q += 1) {
      var nodeId = nodes[q].id();
      nodes[q].position(coord[nodeId]);
    }
    cy.fit(undefined, 24);

    return {
      ok: true,
      message: 'Applied Tutte (' + outerFace.length + '-vertex outer face, ' + iters + ' iters)'
    };
  }

  global.PlanarVibeTutte = {
    applyTutteLayout: applyTutteLayout
  };
})(window);
