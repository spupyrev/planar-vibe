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

    if (!global.PlanarVibeBarycentricCore || !global.PlanarVibeBarycentricCore.solveWeightedBarycentricLayout) {
      return {
        ok: false,
        message: 'Barycentric core is missing. Check script load order'
      };
    }

    var edgePairs = cy.edges().map(function (e) {
      return [String(e.source().id()), String(e.target().id())];
    });
    var weights = global.PlanarVibeBarycentricCore.buildUniformWeights(edgePairs, 1);
    var out = global.PlanarVibeBarycentricCore.solveWeightedBarycentricLayout({
      nodeIds: planarGraph.nodeIds,
      adjacency: adj,
      outerFace: outerFace,
      weights: weights,
      maxIters: 1000,
      tolerance: 1e-6,
      initOptions: {
        useSeedOuter: false,
        defaultCenterX: 2000,
        defaultCenterY: 2000,
        defaultRadius: 1000
      }
    });
    if (!out.ok) {
      return {
        ok: false,
        message: out.message || 'Tutte solver failed'
      };
    }

    for (var i = 0; i < nodes.length; i += 1) {
      var nodeId = nodes[i].id();
      nodes[i].position(out.pos[nodeId]);
    }
    cy.fit(undefined, 24);

    return {
      ok: true,
      message: 'Applied Tutte (' + outerFace.length + '-vertex outer face, ' + out.iters + ' iters)'
    };
  }

  global.PlanarVibeTutte = {
    applyTutteLayout: applyTutteLayout
  };
})(window);
