(function (global) {
  'use strict';

  function collectGraphFromCy(cy) {
    var nodeIds = cy.nodes().map(function (node) {
      return String(node.id());
    });
    var edgePairs = cy.edges().map(function (edge) {
      return [String(edge.source().id()), String(edge.target().id())];
    });
    return {
      nodeIds: nodeIds,
      edgePairs: edgePairs
    };
  }

  function prepareTriangulatedEmbedding(nodeIds, edgePairs) {
    if (!global.PlanarVibePlanarityTest || !global.PlanarVibePlanarityTest.computePlanarEmbedding) {
      return {
        ok: false,
        reason: 'Planarity utilities are missing.'
      };
    }
    if (!global.PlanarGraphCore || !global.PlanarGraphCore.isTriangulatedEmbedding || !global.PlanarGraphCore.augmentByFaceStellation || !global.PlanarGraphCore.cloneEdgePairs) {
      return {
        ok: false,
        reason: 'Planar graph utilities are missing.'
      };
    }

    var embedding = global.PlanarVibePlanarityTest.computePlanarEmbedding(nodeIds, edgePairs);
    if (!embedding.ok) {
      return {
        ok: false,
        reason: 'Graph is not planar.'
      };
    }

    var augmented = {
      nodeIds: nodeIds.map(String),
      edgePairs: global.PlanarGraphCore.cloneEdgePairs(edgePairs),
      dummyCount: 0
    };
    if (!global.PlanarGraphCore.isTriangulatedEmbedding(embedding)) {
      augmented = global.PlanarGraphCore.augmentByFaceStellation(nodeIds, edgePairs, embedding);
      embedding = global.PlanarVibePlanarityTest.computePlanarEmbedding(augmented.nodeIds, augmented.edgePairs);
      if (!embedding.ok) {
        return {
          ok: false,
          reason: 'Augmentation failed: resulting graph is not planar.'
        };
      }
      if (!global.PlanarGraphCore.isTriangulatedEmbedding(embedding)) {
        return {
          ok: false,
          reason: 'Augmentation failed to triangulate all faces.'
        };
      }
    }

    var analysis = null;
    if (global.PlanarVibePlanarityTest.analyzePlanar3Tree) {
      analysis = global.PlanarVibePlanarityTest.analyzePlanar3Tree(augmented.nodeIds, augmented.edgePairs);
    }

    return {
      ok: true,
      embedding: embedding,
      analysis3Tree: analysis,
      augmentedNodeIds: augmented.nodeIds,
      augmentedEdgePairs: augmented.edgePairs,
      augmentedDummyCount: augmented.dummyCount
    };
  }

  function computeCanonicalOrdering(prepared) {
    if (!prepared || !prepared.ok) {
      return {
        ok: false,
        reason: 'Missing prepared embedding.'
      };
    }
    if (!global.PlanarVibePlanarityTest || !global.PlanarVibePlanarityTest.analyzePlanar3Tree) {
      return {
        ok: false,
        reason: 'Planarity utilities are missing.'
      };
    }

    var analysis = prepared.analysis3Tree;
    if (!analysis || !analysis.ok) {
      analysis = global.PlanarVibePlanarityTest.analyzePlanar3Tree(prepared.augmentedNodeIds, prepared.augmentedEdgePairs);
    }
    if (!analysis || !analysis.ok) {
      return {
        ok: false,
        reason: 'Canonical ordering is currently implemented for planar 3-trees only.'
      };
    }

    var order = [];
    var contourNeighborsByVertex = {};
    var outer = analysis.outerFace.slice();
    var insertion = analysis.elimination.slice().reverse();

    order.push(outer[0], outer[1], outer[2]);
    for (var i = 0; i < insertion.length; i += 1) {
      order.push(insertion[i].vertex);
      contourNeighborsByVertex[insertion[i].vertex] = insertion[i].parents.slice();
    }

    return {
      ok: true,
      order: order.slice(),
      outerFace: outer,
      contourNeighborsByVertex: contourNeighborsByVertex
    };
  }

  function normalizeCoordinates(coords, order) {
    var minX = Infinity;
    var minY = Infinity;
    var i;
    for (i = 0; i < order.length; i += 1) {
      var v = order[i];
      if (!coords[v]) {
        continue;
      }
      if (coords[v].x < minX) {
        minX = coords[v].x;
      }
      if (coords[v].y < minY) {
        minY = coords[v].y;
      }
    }
    if (!isFinite(minX) || !isFinite(minY)) {
      return;
    }
    for (i = 0; i < order.length; i += 1) {
      v = order[i];
      if (coords[v]) {
        coords[v].x -= minX;
        coords[v].y -= minY;
      }
    }
  }

  function findNeighborSegment(contour, neighborSet) {
    var n = contour.length;
    if (n === 0) {
      return null;
    }

    if (neighborSet.size === n) {
      return { start: 0, end: n - 1 };
    }

    var ext = contour.concat(contour);
    var targetSize = neighborSet.size;
    var best = null;

    for (var s = 0; s < n; s += 1) {
      if (!neighborSet.has(ext[s])) {
        continue;
      }

      var e = s;
      while (e < s + n && neighborSet.has(ext[e])) {
        e += 1;
      }
      var len = e - s;
      if (len !== targetSize) {
        continue;
      }

      var prev = ext[(s - 1 + n) % n];
      var next = ext[e % n];
      if (neighborSet.has(prev) || neighborSet.has(next)) {
        continue;
      }

      best = { start: s, end: e - 1 };
      break;
    }

    return best;
  }

  function applyFPPPlacement(cy, canonical) {
    var order = canonical.order;
    if (!order || order.length < 3) {
      return {
        ok: false,
        message: 'Canonical ordering is too short for FPP.'
      };
    }

    var contourNeighborsByVertex = canonical.contourNeighborsByVertex || {};
    var coords = {};

    var v1 = order[0];
    var v2 = order[1];
    var v3 = order[2];

    // Standard FPP initialization on integer grid.
    coords[v1] = { x: 0, y: 0 };
    coords[v2] = { x: 2, y: 0 };
    coords[v3] = { x: 1, y: 1 };

    var contour = [v1, v3, v2];

    for (var i = 3; i < order.length; i += 1) {
      var vk = order[i];
      var neigh = contourNeighborsByVertex[vk];
      if (!neigh || neigh.length < 2) {
        return {
          ok: false,
          message: 'Missing contour neighbors for vertex ' + vk + '.'
        };
      }

      var neighSet = new Set(neigh);
      var segment = findNeighborSegment(contour, neighSet);
      if (!segment) {
        return {
          ok: false,
          message: 'Could not find consecutive contour segment for vertex ' + vk + '.'
        };
      }

      var p = segment.start;
      var q = segment.end;
      var n = contour.length;

      if (q >= n) {
        var shift = p;
        contour = contour.slice(shift).concat(contour.slice(0, shift));
        q -= shift;
        p = 0;
      }

      var wp = contour[p];
      var wq = contour[q];

      // FPP shift operations.
      for (var t = q; t < contour.length; t += 1) {
        coords[contour[t]].x += 2;
      }
      for (t = p + 1; t < q; t += 1) {
        coords[contour[t]].x += 1;
      }

      // Intersection of slope +1 from wp and slope -1 from wq.
      var x = (coords[wp].x + coords[wp].y + coords[wq].x - coords[wq].y) / 2.0;
      var y = (coords[wp].x + coords[wp].y - coords[wq].x + coords[wq].y) / 2.0;
      coords[vk] = { x: x, y: y };

      // Replace interior of segment by vk.
      contour = contour.slice(0, p + 1).concat([vk]).concat(contour.slice(q));
    }

    normalizeCoordinates(coords, order);

    var SCALE = 30;
    cy.nodes().forEach(function (node) {
      var id = String(node.id());
      if (coords[id]) {
        node.position({
          x: coords[id].x * SCALE + 20,
          y: coords[id].y * SCALE + 20
        });
      }
    });
    cy.fit(undefined, 24);

    return {
      ok: true,
      message: 'Applied FPP layout (' + order.length + ' vertices)'
    };
  }

  function applyFPPLayout(cy) {
    var graph = collectGraphFromCy(cy);
    var prepared = prepareTriangulatedEmbedding(graph.nodeIds, graph.edgePairs);
    if (!prepared.ok) {
      return {
        ok: false,
        message: prepared.reason
      };
    }

    var canonical = computeCanonicalOrdering(prepared);
    if (!canonical.ok) {
      return {
        ok: false,
        message: canonical.reason
      };
    }

    var result = applyFPPPlacement(cy, canonical);
    if (result.ok && prepared.augmentedDummyCount > 0) {
      result.message += ' after augmentation (+' + prepared.augmentedDummyCount + ' dummy)';
    }
    return result;
  }

  global.PlanarVibeFPP = {
    augmentPlanarByFaceStellation: global.PlanarGraphCore ? global.PlanarGraphCore.augmentByFaceStellation : null,
    prepareTriangulatedEmbedding: prepareTriangulatedEmbedding,
    computeCanonicalOrdering: computeCanonicalOrdering,
    applyFPPLayout: applyFPPLayout
  };
})(window);
