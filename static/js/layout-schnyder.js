(function (global) {
  'use strict';

  function collectGraphFromCy(cy) {
    return {
      nodeIds: cy.nodes().map(function (n) { return String(n.id()); }),
      edgePairs: cy.edges().map(function (e) {
        return [String(e.source().id()), String(e.target().id())];
      })
    };
  }

  function edgeKey(u, v) {
    var a = String(u);
    var b = String(v);
    return a < b ? a + '::' + b : b + '::' + a;
  }

  function buildAdjacency(nodeIds, edgePairs) {
    var adj = {};
    for (var i = 0; i < nodeIds.length; i += 1) {
      adj[String(nodeIds[i])] = [];
    }
    for (i = 0; i < edgePairs.length; i += 1) {
      var u = String(edgePairs[i][0]);
      var v = String(edgePairs[i][1]);
      if (u === v) {
        continue;
      }
      if (!adj[u]) adj[u] = [];
      if (!adj[v]) adj[v] = [];
      adj[u].push(v);
      adj[v].push(u);
    }
    return adj;
  }

  function uniqueEdgePairs(edgePairs) {
    var out = [];
    var seen = new Set();
    for (var i = 0; i < edgePairs.length; i += 1) {
      var u = String(edgePairs[i][0]);
      var v = String(edgePairs[i][1]);
      if (u === v) {
        continue;
      }
      var k = edgeKey(u, v);
      if (seen.has(k)) {
        continue;
      }
      seen.add(k);
      out.push([u, v]);
    }
    return out;
  }

  function triangulateByFaceDiagonals(nodeIds, edgePairs) {
    if (!global.PlanarVibePlanarityTest || !global.PlanarVibePlanarityTest.computePlanarEmbedding) {
      return { ok: false, reason: 'Planarity utilities are missing' };
    }
    var nodes = nodeIds.map(String);
    var edges = uniqueEdgePairs(edgePairs);
    var set = new Set(edges.map(function (e) { return edgeKey(e[0], e[1]); }));
    var maxAdditions = Math.max(1, 4 * nodes.length);

    for (var added = 0; added <= maxAdditions; added += 1) {
      var emb = global.PlanarVibePlanarityTest.computePlanarEmbedding(nodes, edges);
      if (!emb || !emb.ok) {
        return { ok: false, reason: 'Graph is not planar' };
      }

      var nonTriFace = null;
      for (var fi = 0; fi < emb.faces.length; fi += 1) {
        if ((emb.faces[fi] || []).length > 3) {
          nonTriFace = emb.faces[fi];
          break;
        }
      }
      if (!nonTriFace) {
        return {
          ok: true,
          nodeIds: nodes,
          edgePairs: edges,
          embedding: emb
        };
      }

      var inserted = false;
      var m = nonTriFace.length;
      for (var i = 0; i < m && !inserted; i += 1) {
        for (var j = i + 2; j < m && !inserted; j += 1) {
          if (i === 0 && j === m - 1) {
            continue; // adjacent on cycle
          }
          var u = String(nonTriFace[i]);
          var v = String(nonTriFace[j]);
          if (u === v) {
            continue;
          }
          var k = edgeKey(u, v);
          if (set.has(k)) {
            continue;
          }
          var trialEdges = edges.slice();
          trialEdges.push([u, v]);
          var trialEmb = global.PlanarVibePlanarityTest.computePlanarEmbedding(nodes, trialEdges);
          if (!trialEmb || !trialEmb.ok) {
            continue;
          }
          edges = trialEdges;
          set.add(k);
          inserted = true;
        }
      }

      if (!inserted) {
        return { ok: false, reason: 'Could not triangulate all faces' };
      }
    }

    return { ok: false, reason: 'Triangulation exceeded iteration budget' };
  }

  function buildRotationById(embedding) {
    var byId = {};
    for (var i = 0; i < embedding.idByIndex.length; i += 1) {
      byId[String(embedding.idByIndex[i])] = (embedding.rotation[i] || []).map(String);
    }
    return byId;
  }

  function cycleIndex(arr, value) {
    for (var i = 0; i < arr.length; i += 1) {
      if (arr[i] === value) {
        return i;
      }
    }
    return -1;
  }

  function cyclicSucc(arr, idx) {
    return (idx + 1) % arr.length;
  }

  function cyclicPred(arr, idx) {
    return (idx - 1 + arr.length) % arr.length;
  }

  // Port of OGDF SchnyderLayout::contract (simplified to id-based structures).
  function contract(nodeIds, adjacency, a, b, c) {
    var N = 0;
    for (var i = 0; i < nodeIds.length; i += 1) {
      N += (adjacency[nodeIds[i]] || []).length;
    }
    N = Math.floor(N / 2);

    var marked = {};
    var deg = {};
    var L = [];
    var candidates = [];

    for (i = 0; i < nodeIds.length; i += 1) {
      var v = nodeIds[i];
      marked[v] = false;
      deg[v] = 0;
    }

    marked[a] = marked[b] = marked[c] = true;
    deg[a] = deg[b] = deg[c] = N;

    var an = adjacency[a] || [];
    for (i = 0; i < an.length; i += 1) {
      var x = an[i];
      marked[x] = true;
      var xn = adjacency[x] || [];
      for (var j = 0; j < xn.length; j += 1) {
        var y = xn[j];
        deg[y] = (deg[y] || 0) + 1;
      }
    }

    for (i = 0; i < an.length; i += 1) {
      if (deg[an[i]] <= 2) {
        candidates.push(an[i]);
      }
    }

    while (candidates.length > 0) {
      var u = candidates.shift();
      if (deg[u] !== 2) {
        continue;
      }
      L.unshift(u);
      deg[u] = N;

      var un = adjacency[u] || [];
      for (j = 0; j < un.length; j += 1) {
        var nb = un[j];
        deg[nb] = (deg[nb] || 0) - 1;
        if (!marked[nb]) {
          marked[nb] = true;
          var nbn = adjacency[nb] || [];
          for (var k = 0; k < nbn.length; k += 1) {
            var t = nbn[k];
            deg[t] = (deg[t] || 0) + 1;
          }
          if (deg[nb] <= 2) {
            candidates.push(nb);
          }
        } else if (deg[nb] === 2) {
          candidates.push(nb);
        }
      }
    }

    return L;
  }

  function addDirectedLabeledEdge(outEdgesByLabel, outAdjByLabel, src, dst, label) {
    if (!outEdgesByLabel[label]) {
      outEdgesByLabel[label] = [];
    }
    outEdgesByLabel[label].push({ source: src, target: dst });
    var a = outAdjByLabel[label];
    if (!a[src]) {
      a[src] = [];
    }
    a[src].push(dst);
  }

  // Port of OGDF SchnyderLayout::realizer.
  function realizer(nodeIds, L, a, b, c, rotationById, adjacency) {
    var ord = {};
    var i = 0;
    ord[b] = i++;
    ord[c] = i++;
    for (var p = 0; p < L.length; p += 1) {
      ord[L[p]] = i++;
    }
    ord[a] = i++;

    var outAdjByLabel = {
      1: {},
      2: {},
      3: {}
    };
    var outEdgesByLabel = {
      1: [],
      2: [],
      3: []
    };

    for (var n = 0; n < nodeIds.length; n += 1) {
      var id = nodeIds[n];
      outAdjByLabel[1][id] = [];
      outAdjByLabel[2][id] = [];
      outAdjByLabel[3][id] = [];
    }

    for (p = 0; p < L.length; p += 1) {
      var v = L[p];
      var rot = rotationById[v] || [];
      if (rot.length === 0) {
        return { ok: false, reason: 'Missing rotation at vertex ' + v };
      }

      var firstIdx = -1;
      for (i = 0; i < rot.length; i += 1) {
        if ((ord[rot[i]] || 0) > (ord[v] || 0)) {
          firstIdx = i;
          break;
        }
      }
      if (firstIdx < 0) {
        return { ok: false, reason: 'Could not find higher-order neighbor at vertex ' + v };
      }

      var idx1 = firstIdx;
      while ((ord[rot[idx1]] || 0) > (ord[v] || 0)) {
        idx1 = cyclicSucc(rot, idx1);
      }
      addDirectedLabeledEdge(outEdgesByLabel, outAdjByLabel, rot[idx1], v, 2);

      var idx2 = firstIdx;
      while ((ord[rot[idx2]] || 0) > (ord[v] || 0)) {
        idx2 = cyclicPred(rot, idx2);
      }
      addDirectedLabeledEdge(outEdgesByLabel, outAdjByLabel, rot[idx2], v, 3);

      var walk = cyclicSucc(rot, idx1);
      while (walk !== idx2) {
        addDirectedLabeledEdge(outEdgesByLabel, outAdjByLabel, v, rot[walk], 1);
        walk = cyclicSucc(rot, walk);
      }
    }

    var an = adjacency[a] || [];
    for (i = 0; i < an.length; i += 1) {
      addDirectedLabeledEdge(outEdgesByLabel, outAdjByLabel, a, an[i], 1);
    }
    addDirectedLabeledEdge(outEdgesByLabel, outAdjByLabel, b, a, 2);
    addDirectedLabeledEdge(outEdgesByLabel, outAdjByLabel, b, c, 2);
    addDirectedLabeledEdge(outEdgesByLabel, outAdjByLabel, c, a, 3);
    addDirectedLabeledEdge(outEdgesByLabel, outAdjByLabel, c, b, 3);

    return {
      ok: true,
      ord: ord,
      outAdjByLabel: outAdjByLabel
    };
  }

  function subtreeSizes(outAdjByLabel, label, root) {
    var memo = {};
    var visiting = {};

    function dfs(v) {
      if (memo[v] !== undefined) {
        return memo[v];
      }
      if (visiting[v]) {
        return 1;
      }
      visiting[v] = true;
      var sum = 0;
      var kids = outAdjByLabel[label][v] || [];
      for (var i = 0; i < kids.length; i += 1) {
        sum += dfs(kids[i]);
      }
      visiting[v] = false;
      memo[v] = sum + 1;
      return memo[v];
    }

    dfs(root);
    return memo;
  }

  function prefixSum(outAdjByLabel, label, root, val) {
    var sum = {};
    var queue = [root];
    sum[root] = val[root] || 0;
    var head = 0;
    while (head < queue.length) {
      var v = queue[head++];
      var kids = outAdjByLabel[label][v] || [];
      for (var i = 0; i < kids.length; i += 1) {
        var w = kids[i];
        if (sum[w] !== undefined) {
          continue;
        }
        sum[w] = (val[w] || 0) + sum[v];
        queue.push(w);
      }
    }
    return sum;
  }

  function computeSchnyderCoordinates(nodeIds, realizerOut, a, b, c) {
    var outAdj = realizerOut.outAdjByLabel;

    var t1 = subtreeSizes(outAdj, 1, a);
    var t2 = subtreeSizes(outAdj, 2, b);

    var ones = {};
    for (var i = 0; i < nodeIds.length; i += 1) {
      ones[nodeIds[i]] = 1;
    }
    var p1 = prefixSum(outAdj, 1, a, ones);
    var p2 = prefixSum(outAdj, 2, b, ones);
    var p3 = prefixSum(outAdj, 3, c, ones);

    var sum1 = prefixSum(outAdj, 2, b, t1);
    sum1[a] = t1[a] || 1;
    var sum2 = prefixSum(outAdj, 3, c, t1);
    sum2[a] = t1[a] || 1;

    var x = {};
    for (i = 0; i < nodeIds.length; i += 1) {
      var v = nodeIds[i];
      var r1 = (sum1[v] || 0) + (sum2[v] || 0) - (t1[v] || 1);
      x[v] = r1 - (p3[v] || 1);
    }

    sum1 = prefixSum(outAdj, 3, c, t2);
    sum1[b] = t2[b] || 1;
    sum2 = prefixSum(outAdj, 1, a, t2);
    sum2[b] = t2[b] || 1;

    var y = {};
    for (i = 0; i < nodeIds.length; i += 1) {
      v = nodeIds[i];
      var r2 = (sum1[v] || 0) + (sum2[v] || 0) - (t2[v] || 1);
      y[v] = r2 - (p1[v] || 1);
    }

    return { x: x, y: y };
  }

  function applyCoordinates(cy, coords, nodeIds) {
    var screenPos = buildScreenPositions(coords, nodeIds);
    if (!screenPos) {
      return false;
    }
    cy.nodes().forEach(function (node) {
      var id = String(node.id());
      if (!screenPos[id]) {
        return;
      }
      node.position(screenPos[id]);
    });
    cy.fit(undefined, 24);
    return true;
  }

  function buildScreenPositions(coords, nodeIds) {
    var minX = Infinity;
    var minY = Infinity;
    var maxY = -Infinity;
    var i;
    for (i = 0; i < nodeIds.length; i += 1) {
      var id = nodeIds[i];
      var xi = coords.x[id];
      var yi = coords.y[id];
      if (!Number.isFinite(xi) || !Number.isFinite(yi)) {
        return null;
      }
      if (xi < minX) minX = xi;
      if (yi < minY) minY = yi;
      if (yi > maxY) maxY = yi;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
      return null;
    }
    var SCALE = 30;
    var out = {};
    for (i = 0; i < nodeIds.length; i += 1) {
      var id2 = nodeIds[i];
      if (coords.x[id2] === undefined || coords.y[id2] === undefined) {
        continue;
      }
      out[id2] = {
        x: (coords.x[id2] - minX) * SCALE + 20,
        y: (maxY - coords.y[id2]) * SCALE + 20
      };
    }
    return out;
  }

  function applyScreenPositions(cy, posById) {
    cy.nodes().forEach(function (node) {
      var id = String(node.id());
      if (!posById[id]) {
        return;
      }
      node.position({ x: posById[id].x, y: posById[id].y });
    });
    cy.fit(undefined, 24);
  }

  function hasOverlappingVertices(posById) {
    var seen = new Set();
    var keys = Object.keys(posById || {});
    for (var i = 0; i < keys.length; i += 1) {
      var id = keys[i];
      var p = posById[id];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        continue;
      }
      var k = String(p.x) + ',' + String(p.y);
      if (seen.has(k)) {
        return true;
      }
      seen.add(k);
    }
    return false;
  }

  function countOverlappingVertices(posById) {
    var buckets = {};
    var ids = Object.keys(posById || {});
    for (var i = 0; i < ids.length; i += 1) {
      var id = ids[i];
      var p = posById[id];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        continue;
      }
      var k = String(p.x) + ',' + String(p.y);
      buckets[k] = (buckets[k] || 0) + 1;
    }
    var overlaps = 0;
    var keys = Object.keys(buckets);
    for (i = 0; i < keys.length; i += 1) {
      if (buckets[keys[i]] > 1) {
        overlaps += (buckets[keys[i]] - 1);
      }
    }
    return overlaps;
  }

  function clonePositions(posById) {
    var out = {};
    var ids = Object.keys(posById || {});
    for (var i = 0; i < ids.length; i += 1) {
      var id = ids[i];
      var p = posById[id];
      out[id] = { x: p.x, y: p.y };
    }
    return out;
  }

  function groupOverlaps(posById) {
    var buckets = {};
    var ids = Object.keys(posById || {});
    for (var i = 0; i < ids.length; i += 1) {
      var id = ids[i];
      var p = posById[id];
      var k = String(p.x) + ',' + String(p.y);
      if (!buckets[k]) {
        buckets[k] = [];
      }
      buckets[k].push(id);
    }
    var out = [];
    var keys = Object.keys(buckets);
    for (i = 0; i < keys.length; i += 1) {
      var list = buckets[keys[i]];
      if (list.length > 1) {
        list.sort();
        out.push(list);
      }
    }
    return out;
  }

  function hasCrossings(posById, edgePairs) {
    if (!global.PlanarVibeMetrics || typeof global.PlanarVibeMetrics.hasCrossingsFromPositions !== 'function') {
      return false;
    }
    return !!global.PlanarVibeMetrics.hasCrossingsFromPositions(posById, edgePairs);
  }

  function resolveOverlapsWithoutCrossings(posById, edgePairs) {
    if (!hasOverlappingVertices(posById)) {
      return clonePositions(posById);
    }
    var pos = clonePositions(posById);
    var overlapGroups = groupOverlaps(pos);
    var ring = [];
    var DIRS = 24;
    for (var a = 0; a < DIRS; a += 1) {
      var ang = (2 * Math.PI * a) / DIRS;
      ring.push([Math.cos(ang), Math.sin(ang)]);
    }
    var radii = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0];

    for (var g = 0; g < overlapGroups.length; g += 1) {
      var group = overlapGroups[g];
      var anchor = pos[group[0]];
      var placedGroup = false;

      for (var r = 0; r < radii.length && !placedGroup; r += 1) {
        var radius = radii[r];
        for (var phase = 0; phase < ring.length && !placedGroup; phase += 1) {
          var trial = clonePositions(pos);
          for (var i = 0; i < group.length; i += 1) {
            var id = group[i];
            var idx = (phase + Math.floor((i * ring.length) / group.length)) % ring.length;
            var dx = ring[idx][0];
            var dy = ring[idx][1];
            trial[id] = {
              x: anchor.x + dx * radius,
              y: anchor.y + dy * radius
            };
          }
          if (hasOverlappingVertices(trial)) {
            continue;
          }
          if (hasCrossings(trial, edgePairs)) {
            continue;
          }
          pos = trial;
          placedGroup = true;
        }
      }
      if (!placedGroup) {
        return null;
      }
    }

    if (hasOverlappingVertices(pos) || hasCrossings(pos, edgePairs)) {
      return null;
    }
    return pos;
  }

  function candidateOuterTriples(emb, rotationById) {
    var out = [];
    if (!emb || !emb.edges || emb.edges.length === 0) {
      return out;
    }
    var e0 = emb.edges[0];
    var a = String(e0[0]);
    var b = String(e0[1]);
    var rotB = rotationById[b] || [];
    var idxA = cycleIndex(rotB, a);
    if (idxA === -1 || rotB.length === 0) {
      return out;
    }
    // Mimic OGDF default: adja = firstEdge->adjSource, then faceCyclePred twice.
    var c = String(rotB[cyclicPred(rotB, idxA)]);
    out.push([a, b, c]);
    // Try mirrored orientation as deterministic fallback.
    out.push([a, c, b]);
    return out;
  }

  function applySchnyderLayout(cy) {
    if (!global.PlanarVibePlanarityTest || !global.PlanarVibePlanarityTest.computePlanarEmbedding) {
      return { ok: false, message: 'Planarity utilities are missing' };
    }
    var g = collectGraphFromCy(cy);
    if (g.nodeIds.length < 3) {
      if (g.nodeIds.length === 2) {
        var map = {};
        cy.nodes().forEach(function (n) { map[String(n.id())] = n; });
        if (map[g.nodeIds[0]]) map[g.nodeIds[0]].position({ x: 20, y: 20 });
        if (map[g.nodeIds[1]]) map[g.nodeIds[1]].position({ x: 50, y: 20 });
        cy.fit(undefined, 24);
      }
      return { ok: true, message: 'Applied Schnyder layout (' + String(g.nodeIds.length) + ' vertices)' };
    }

    var triangulated = triangulateByFaceDiagonals(g.nodeIds, g.edgePairs);
    if (!triangulated.ok) {
      return { ok: false, message: triangulated.reason || 'Schnyder triangulation failed' };
    }

    var emb = global.PlanarVibePlanarityTest.computePlanarEmbedding(triangulated.nodeIds, triangulated.edgePairs);
    if (!emb || !emb.ok) {
      return { ok: false, message: 'Graph is not planar' };
    }
    var rotationById = buildRotationById(emb);
    var adjacency = buildAdjacency(triangulated.nodeIds, triangulated.edgePairs);
    var bestPos = null;
    var bestOverlapCount = Infinity;
    var candidates = candidateOuterTriples(emb, rotationById);
    if (candidates.length === 0 && emb.outerFace && emb.outerFace.length >= 3) {
      candidates = [[String(emb.outerFace[0]), String(emb.outerFace[1]), String(emb.outerFace[2])]];
    }
    for (var ci = 0; ci < candidates.length; ci += 1) {
      var tri = candidates[ci];
      var a = tri[0];
      var b = tri[1];
      var c = tri[2];

      var L = contract(triangulated.nodeIds, adjacency, a, b, c);
      if (L.length !== triangulated.nodeIds.length - 3) {
        continue;
      }
      var r = realizer(triangulated.nodeIds, L, a, b, c, rotationById, adjacency);
      if (!r.ok) {
        continue;
      }

      var coords = computeSchnyderCoordinates(triangulated.nodeIds, r, a, b, c);
      var pos = buildScreenPositions(coords, g.nodeIds);
      if (!pos) {
        continue;
      }
      if (hasCrossings(pos, g.edgePairs)) {
        continue;
      }
      if (hasOverlappingVertices(pos)) {
        var resolved = resolveOverlapsWithoutCrossings(pos, g.edgePairs);
        if (resolved) {
          pos = resolved;
        }
      }
      var overlapCount = countOverlappingVertices(pos);
      if (overlapCount < bestOverlapCount) {
        bestOverlapCount = overlapCount;
        bestPos = pos;
      }
      if (overlapCount === 0) {
        break;
      }
    }

    if (!bestPos) {
      return { ok: false, message: 'Schnyder failed to find crossing-free embedding' };
    }
    applyScreenPositions(cy, bestPos);

    return {
      ok: true,
      message: 'Applied Schnyder layout (' + String(g.nodeIds.length) + ' vertices)'
    };
  }

  global.PlanarVibeSchnyder = {
    applySchnyderLayout: applySchnyderLayout
  };
})(window);
