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

    return {
      ok: true,
      embedding: embedding,
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
    if (!prepared.embedding || !prepared.embedding.ok) {
      return {
        ok: false,
        reason: 'Missing embedding.'
      };
    }

    var embedding = prepared.embedding;
    var nodeIds = embedding.idByIndex.slice();
    if (nodeIds.length < 3) {
      return {
        ok: false,
        reason: 'Need at least 3 vertices.'
      };
    }

    var outerFace = embedding.outerFace ? embedding.outerFace.slice() : null;
    if (!outerFace || outerFace.length !== 3) {
      return {
        ok: false,
        reason: 'Triangulated embedding must have triangular outer face.'
      };
    }

    var rotationById = {};
    for (var r = 0; r < embedding.idByIndex.length; r += 1) {
      rotationById[embedding.idByIndex[r]] = embedding.rotation[r] ? embedding.rotation[r].slice() : [];
    }

    var adjacency = {};
    for (var i = 0; i < nodeIds.length; i += 1) {
      adjacency[nodeIds[i]] = new Set();
    }
    for (i = 0; i < prepared.augmentedEdgePairs.length; i += 1) {
      var e = prepared.augmentedEdgePairs[i];
      var a = String(e[0]);
      var b = String(e[1]);
      if (!adjacency[a]) {
        adjacency[a] = new Set();
      }
      if (!adjacency[b]) {
        adjacency[b] = new Set();
      }
      adjacency[a].add(b);
      adjacency[b].add(a);
    }

    function hasEdge(u, v) {
      return !!(adjacency[u] && adjacency[u].has(v));
    }

    function rotationPathInclusive(v, start, end) {
      var nbrs = rotationById[v] || [];
      if (nbrs.length === 0) {
        return null;
      }
      var iStart = nbrs.indexOf(start);
      var iEnd = nbrs.indexOf(end);
      if (iStart === -1 || iEnd === -1) {
        return null;
      }

      var out = [start];
      var cur = iStart;
      while (cur !== iEnd) {
        cur = (cur + 1) % nbrs.length;
        out.push(nbrs[cur]);
        if (out.length > nbrs.length + 1) {
          return null;
        }
      }
      return out;
    }

    function scoreReplacementPath(path, outerSet, remaining) {
      if (!path || path.length < 2) {
        return -1;
      }
      var score = 0;
      for (var s = 1; s + 1 < path.length; s += 1) {
        var x = path[s];
        if (remaining.has(x) && !outerSet.has(x)) {
          score += 2;
        } else if (remaining.has(x)) {
          score += 1;
        }
      }
      return score;
    }

    function chooseReplacementPath(v, pred, succ, outerSet, remaining) {
      var pathA = rotationPathInclusive(v, pred, succ);
      var pathB = rotationPathInclusive(v, succ, pred);
      if (pathB) {
        pathB = pathB.slice().reverse();
      }

      var scoreA = scoreReplacementPath(pathA, outerSet, remaining);
      var scoreB = scoreReplacementPath(pathB, outerSet, remaining);

      if (scoreA > scoreB) {
        return pathA;
      }
      if (scoreB > scoreA) {
        return pathB;
      }
      if (pathA && pathB) {
        if (pathA.length !== pathB.length) {
          return pathA.length > pathB.length ? pathA : pathB;
        }
        return pathA.join('\u0001') <= pathB.join('\u0001') ? pathA : pathB;
      }
      return pathA || pathB || [pred, succ];
    }

    function sanitizeReplacementPath(path, pred, succ, outerSet, remaining) {
      if (!path || path.length < 2) {
        return [pred, succ];
      }
      if (path[0] !== pred || path[path.length - 1] !== succ) {
        return [pred, succ];
      }

      var out = [pred];
      var seen = new Set([pred]);
      for (var i = 1; i + 1 < path.length; i += 1) {
        var x = path[i];
        if (!remaining.has(x) || outerSet.has(x) || seen.has(x)) {
          continue;
        }
        out.push(x);
        seen.add(x);
      }
      out.push(succ);
      return out;
    }

    function buildNextOuterCycle(outerCycle, removeIdx, replacementPath) {
      var n = outerCycle.length;
      var succIdx = (removeIdx + 1) % n;
      var predIdx = (removeIdx - 1 + n) % n;
      var succ = outerCycle[succIdx];
      var pred = outerCycle[predIdx];
      var interior = replacementPath.slice(1, replacementPath.length - 1);

      var walk = [];
      var t = succIdx;
      while (t !== removeIdx) {
        walk.push(outerCycle[t]);
        t = (t + 1) % n;
      }

      if (walk.length === 0 || walk[walk.length - 1] !== pred) {
        return null;
      }

      return walk.concat(interior);
    }

    var v1 = outerFace[0];
    var v2 = outerFace[1];
    var vn = outerFace[2];

    var remaining = new Set(nodeIds);
    var outerCycle = [v1, vn, v2];
    var removed = [];
    var contourNeighborsByVertex = {};

    while (remaining.size > 3) {
      var outerSet = new Set(outerCycle);
      var chosen = null;
      var chosenIdx = -1;

      if (remaining.size === nodeIds.length) {
        chosen = vn;
        chosenIdx = outerCycle.indexOf(vn);
      } else {
        for (var c = 0; c < outerCycle.length; c += 1) {
          var cand = outerCycle[c];
          if (cand === v1 || cand === v2) {
            continue;
          }

          var prev = outerCycle[(c - 1 + outerCycle.length) % outerCycle.length];
          var next = outerCycle[(c + 1) % outerCycle.length];
          if (!hasEdge(prev, next)) {
            continue;
          }
          var hasChord = false;
          var outerNeighborCount = 0;
          var neighbors = adjacency[cand] ? Array.from(adjacency[cand]) : [];

          for (var ni = 0; ni < neighbors.length; ni += 1) {
            var nb = neighbors[ni];
            if (!remaining.has(nb) || !outerSet.has(nb)) {
              continue;
            }
            outerNeighborCount += 1;
            if (nb !== prev && nb !== next) {
              hasChord = true;
              break;
            }
          }

          if (!hasChord && outerNeighborCount === 2) {
            chosen = cand;
            chosenIdx = c;
            break;
          }
        }
      }

      if (!chosen || chosenIdx === -1) {
        return {
          ok: false,
          reason: 'Could not find shelling vertex for canonical ordering.'
        };
      }

      var pred = outerCycle[(chosenIdx - 1 + outerCycle.length) % outerCycle.length];
      var succ = outerCycle[(chosenIdx + 1) % outerCycle.length];
      var replacementPath = chooseReplacementPath(chosen, pred, succ, outerSet, remaining);
      replacementPath = sanitizeReplacementPath(replacementPath, pred, succ, outerSet, remaining);

      contourNeighborsByVertex[chosen] = replacementPath.slice();

      var nextCycle = buildNextOuterCycle(outerCycle, chosenIdx, replacementPath);
      if (!nextCycle || nextCycle.length < 2) {
        return {
          ok: false,
          reason: 'Failed to update outer cycle during canonical ordering.'
        };
      }

      if (adjacency[chosen]) {
        adjacency[chosen].forEach(function (nb) {
          if (adjacency[nb]) {
            adjacency[nb].delete(chosen);
          }
        });
      }
      adjacency[chosen] = new Set();
      remaining.delete(chosen);
      removed.push(chosen);
      outerCycle = nextCycle;
    }

    var base = Array.from(remaining);
    if (base.length !== 3) {
      return {
        ok: false,
        reason: 'Canonical reduction did not end with 3 vertices.'
      };
    }
    if (!base.includes(v1) || !base.includes(v2)) {
      return {
        ok: false,
        reason: 'Canonical base does not contain fixed outer edge.'
      };
    }

    var v3 = null;
    for (i = 0; i < base.length; i += 1) {
      if (base[i] !== v1 && base[i] !== v2) {
        v3 = base[i];
        break;
      }
    }
    if (v3 === null) {
      return {
        ok: false,
        reason: 'Canonical base triangle is invalid.'
      };
    }

    var order = [v1, v2, v3];
    for (i = removed.length - 1; i >= 0; i -= 1) {
      order.push(removed[i]);
    }

    if (order.length !== nodeIds.length || new Set(order).size !== nodeIds.length) {
      return {
        ok: false,
        reason: 'Canonical ordering has duplicate or missing vertices.'
      };
    }

    return {
      ok: true,
      order: order.slice(),
      outerFace: [v1, v2, v3],
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

  function findNeighborSegment(contour, neighborPath) {
    var n = contour.length;
    if (n === 0 || !neighborPath || neighborPath.length < 2) {
      return null;
    }

    function matchesAt(start, path) {
      for (var i = 0; i < path.length; i += 1) {
        if (contour[(start + i) % n] !== path[i]) {
          return false;
        }
      }
      return true;
    }

    for (var s = 0; s < n; s += 1) {
      if (matchesAt(s, neighborPath)) {
        return { start: s, end: s + neighborPath.length - 1 };
      }
    }

    var reversed = neighborPath.slice().reverse();
    for (s = 0; s < n; s += 1) {
      if (matchesAt(s, reversed)) {
        return { start: s, end: s + reversed.length - 1 };
      }
    }

    return null;
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

    // Standard FPP initialization (bottom-to-top orientation).
    coords[v1] = { x: 0, y: 2 };
    coords[v2] = { x: 2, y: 2 };
    coords[v3] = { x: 1, y: 0 };

    var contour = [v1, v2, v3];

    for (var i = 3; i < order.length; i += 1) {
      var vk = order[i];
      var neigh = contourNeighborsByVertex[vk];
      if (!neigh || neigh.length < 2) {
        return {
          ok: false,
          message: 'Missing contour neighbors for vertex ' + vk + '.'
        };
      }

      var segment = findNeighborSegment(contour, neigh);
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
      if (!coords[wp] || !coords[wq]) {
        return {
          ok: false,
          message: 'Missing endpoint coordinates for vertex ' + vk + '.'
        };
      }

      var t;
      for (t = q; t < contour.length; t += 1) {
        coords[contour[t]].x += 2;
      }
      for (t = p + 1; t < q; t += 1) {
        coords[contour[t]].x += 1;
      }

      var x = (coords[wp].x + coords[wp].y + coords[wq].x - coords[wq].y) / 2.0;
      var y = (coords[wp].x + coords[wp].y - coords[wq].x + coords[wq].y) / 2.0;
      coords[vk] = { x: x, y: y };

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
