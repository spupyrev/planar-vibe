(function (global) {
  'use strict';

  function normalizeNodeIds(nodeIds) {
    return (nodeIds || []).map(String);
  }

  function normalizeEdgePairs(edgePairs) {
    return (edgePairs || []).map(function (edge) {
      return [String(edge[0]), String(edge[1])];
    });
  }

  function normalizeGraphInput(nodeIds, edgePairs) {
    return {
      nodeIds: normalizeNodeIds(nodeIds),
      edgePairs: normalizeEdgePairs(edgePairs)
    };
  }

  function normalizeSimpleEdgePairs(edgePairs) {
    var pairs = normalizeEdgePairs(edgePairs);
    var out = [];
    var seen = new Set();
    for (var i = 0; i < pairs.length; i += 1) {
      var u = pairs[i][0];
      var v = pairs[i][1];
      if (u === v) {
        continue;
      }
      var key = edgeKey(u, v);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push([u, v]);
    }
    return out;
  }

  function normalizeOuterFace(outerFace) {
    return Array.isArray(outerFace) ? outerFace.slice().map(String) : [];
  }

  function edgeKey(u, v) {
    return u < v ? u + '::' + v : v + '::' + u;
  }

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

  function resolveFiniteOption(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
  }

  function resolveFloatOption(value, fallback, min, max) {
    if (!Number.isFinite(value)) {
      return fallback;
    }
    var out = value;
    if (Number.isFinite(min)) {
      out = Math.max(min, out);
    }
    if (Number.isFinite(max)) {
      out = Math.min(max, out);
    }
    return out;
  }

  function resolveIntOption(value, fallback, min, max) {
    if (!Number.isFinite(value)) {
      return fallback;
    }
    var out = Math.floor(value);
    if (Number.isFinite(min)) {
      out = Math.max(min, out);
    }
    if (Number.isFinite(max)) {
      out = Math.min(max, out);
    }
    return out;
  }

  function resolvePositiveOption(value, fallback) {
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  function resolveNonNegativeOption(value, fallback) {
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  }

  function resolveGreaterThanOption(value, fallback, threshold) {
    return Number.isFinite(value) && value > threshold ? value : fallback;
  }

  function resolveOpenIntervalOption(value, fallback, minExclusive, maxExclusive) {
    if (!Number.isFinite(value)) {
      return fallback;
    }
    if (Number.isFinite(minExclusive) && !(value > minExclusive)) {
      return fallback;
    }
    if (Number.isFinite(maxExclusive) && !(value < maxExclusive)) {
      return fallback;
    }
    return value;
  }

  function resolveFunctionOption(value, fallback) {
    return typeof value === 'function' ? value : fallback;
  }

  function cloneMatrix(A) {
    var out = new Array(A.length);
    for (var i = 0; i < A.length; i += 1) {
      out[i] = A[i].slice();
    }
    return out;
  }

  function luFactorize(A) {
    var n = A.length;
    var LU = cloneMatrix(A);
    var piv = new Array(n);
    var i;
    var j;

    for (i = 0; i < n; i += 1) {
      piv[i] = i;
    }
    for (var k = 0; k < n; k += 1) {
      var pivotRow = k;
      var pivotValue = Math.abs(LU[k][k]);
      for (i = k + 1; i < n; i += 1) {
        var cand = Math.abs(LU[i][k]);
        if (cand > pivotValue) {
          pivotValue = cand;
          pivotRow = i;
        }
      }
      if (!(pivotValue > 1e-12)) {
        return null;
      }
      if (pivotRow !== k) {
        var tmpRow = LU[k];
        LU[k] = LU[pivotRow];
        LU[pivotRow] = tmpRow;
        var tmpPivot = piv[k];
        piv[k] = piv[pivotRow];
        piv[pivotRow] = tmpPivot;
      }
      for (i = k + 1; i < n; i += 1) {
        LU[i][k] /= LU[k][k];
        var factor = LU[i][k];
        for (j = k + 1; j < n; j += 1) {
          LU[i][j] -= factor * LU[k][j];
        }
      }
    }
    return { LU: LU, piv: piv };
  }

  function solveLUWithTwoRhs(factor, b1, b2) {
    var n = b1.length;
    if (n === 0) return { x1: [], x2: [] };
    var LU = factor.LU;
    var piv = factor.piv;
    var y1 = new Array(n);
    var y2 = new Array(n);
    var i;
    var j;

    for (i = 0; i < n; i += 1) {
      y1[i] = b1[piv[i]];
      y2[i] = b2[piv[i]];
    }
    for (i = 0; i < n; i += 1) {
      for (j = 0; j < i; j += 1) {
        y1[i] -= LU[i][j] * y1[j];
        y2[i] -= LU[i][j] * y2[j];
      }
    }

    var x1 = new Array(n);
    var x2 = new Array(n);
    for (i = n - 1; i >= 0; i -= 1) {
      var sum1 = y1[i];
      var sum2 = y2[i];
      for (j = i + 1; j < n; j += 1) {
        sum1 -= LU[i][j] * x1[j];
        sum2 -= LU[i][j] * x2[j];
      }
      var diag = LU[i][i];
      if (!(Math.abs(diag) > 1e-12)) return null;
      x1[i] = sum1 / diag;
      x2[i] = sum2 / diag;
    }
    return { x1: x1, x2: x2 };
  }

  function solveTransposeLUWithTwoRhs(factor, b1, b2) {
    var n = b1.length;
    if (n === 0) return { x1: [], x2: [] };
    var LU = factor.LU;
    var piv = factor.piv;
    var z1 = new Array(n);
    var z2 = new Array(n);
    var i;
    var j;

    for (i = 0; i < n; i += 1) {
      var sum1 = b1[i];
      var sum2 = b2[i];
      for (j = 0; j < i; j += 1) {
        sum1 -= LU[j][i] * z1[j];
        sum2 -= LU[j][i] * z2[j];
      }
      var diag = LU[i][i];
      if (!(Math.abs(diag) > 1e-12)) return null;
      z1[i] = sum1 / diag;
      z2[i] = sum2 / diag;
    }

    var w1 = new Array(n);
    var w2 = new Array(n);
    for (i = n - 1; i >= 0; i -= 1) {
      var acc1 = z1[i];
      var acc2 = z2[i];
      for (j = i + 1; j < n; j += 1) {
        acc1 -= LU[j][i] * w1[j];
        acc2 -= LU[j][i] * w2[j];
      }
      w1[i] = acc1;
      w2[i] = acc2;
    }

    var x1 = new Array(n);
    var x2 = new Array(n);
    for (i = 0; i < n; i += 1) {
      x1[piv[i]] = w1[i];
      x2[piv[i]] = w2[i];
    }
    return { x1: x1, x2: x2 };
  }

  function faceKey(face) {
    if (!face || face.length === 0) return '';
    var arr = face.map(String);
    var n = arr.length;
    var best = null;
    var i;
    for (i = 0; i < n; i += 1) {
      var rot = arr.slice(i).concat(arr.slice(0, i)).join('|');
      if (best === null || rot < best) best = rot;
    }
    var rev = arr.slice().reverse();
    for (i = 0; i < n; i += 1) {
      var rrot = rev.slice(i).concat(rev.slice(0, i)).join('|');
      if (best === null || rrot < best) best = rrot;
    }
    return best || '';
  }

  function polygonArea2(face, posById) {
    if (!face || face.length < 3) return 0;
    var sum = 0;
    for (var i = 0; i < face.length; i += 1) {
      var a = posById[String(face[i])];
      var b = posById[String(face[(i + 1) % face.length])];
      if (!a || !b) return 0;
      sum += a.x * b.y - b.x * a.y;
    }
    return sum;
  }

  function polygonAreaAbs(face, posById) {
    return Math.abs(polygonArea2(face, posById)) / 2;
  }

  function pointAdd(p, q) {
    return { x: p.x + q.x, y: p.y + q.y };
  }

  function pointSub(p, q) {
    return { x: p.x - q.x, y: p.y - q.y };
  }

  function pointScale(s, p) {
    return { x: s * p.x, y: s * p.y };
  }

  function pointDot(p, q) {
    return p.x * q.x + p.y * q.y;
  }

  function pointRot90(p) {
    return { x: -p.y, y: p.x };
  }

  function pointNorm(p) {
    return Math.sqrt(pointDot(p, p));
  }

  function vecDot(a, b) {
    var s = 0;
    for (var i = 0; i < a.length; i += 1) {
      s += a[i] * b[i];
    }
    return s;
  }

  function vecNorm(a) {
    return Math.sqrt(vecDot(a, a));
  }

  function vecAddScaled(a, b, alpha) {
    var out = new Array(a.length);
    for (var i = 0; i < a.length; i += 1) {
      out[i] = a[i] + alpha * b[i];
    }
    return out;
  }

  function vecSub(a, b) {
    var out = new Array(a.length);
    for (var i = 0; i < a.length; i += 1) {
      out[i] = a[i] - b[i];
    }
    return out;
  }

  function vecScale(a, alpha) {
    var out = new Array(a.length);
    for (var i = 0; i < a.length; i += 1) {
      out[i] = alpha * a[i];
    }
    return out;
  }

  function orientFaceCCW(face, posById) {
    var out = face.slice().map(String);
    if (polygonArea2(out, posById) < 0) {
      out.reverse();
    }
    return out;
  }

  function outerFaceDiameter(posById, outerFace) {
    var face = Array.isArray(outerFace) ? outerFace : [];
    var diameter = 0;
    for (var i = 0; i < face.length; i += 1) {
      var a = posById[String(face[i])];
      if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) continue;
      for (var j = i + 1; j < face.length; j += 1) {
        var b = posById[String(face[j])];
        if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
        var dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (dist > diameter) {
          diameter = dist;
        }
      }
    }
    return diameter > 1e-12 ? diameter : 1;
  }

  function triangleArea2(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }

  function pointEquals(a, b, eps) {
    return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
  }

  function pointOnSegment(a, b, p, eps) {
    return (
      Math.min(a.x, b.x) - eps <= p.x && p.x <= Math.max(a.x, b.x) + eps &&
      Math.min(a.y, b.y) - eps <= p.y && p.y <= Math.max(a.y, b.y) + eps
    );
  }

  function pointOnSegmentInterior(a, b, p, eps) {
    if (!pointOnSegment(a, b, p, eps)) {
      return false;
    }
    if (Math.abs(p.x - a.x) <= eps && Math.abs(p.y - a.y) <= eps) {
      return false;
    }
    if (Math.abs(p.x - b.x) <= eps && Math.abs(p.y - b.y) <= eps) {
      return false;
    }
    return true;
  }

  function segmentsIntersectOrTouch(a, b, c, d, eps) {
    var o1 = triangleArea2(a, b, c);
    var o2 = triangleArea2(a, b, d);
    var o3 = triangleArea2(c, d, a);
    var o4 = triangleArea2(c, d, b);

    if (((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps)) &&
        ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps))) {
      return true;
    }

    if (Math.abs(o1) <= eps && pointOnSegment(a, b, c, eps)) return true;
    if (Math.abs(o2) <= eps && pointOnSegment(a, b, d, eps)) return true;
    if (Math.abs(o3) <= eps && pointOnSegment(c, d, a, eps)) return true;
    if (Math.abs(o4) <= eps && pointOnSegment(c, d, b, eps)) return true;
    return false;
  }

  function segmentsIntersectStrict(a, b, c, d, eps) {
    var o1 = triangleArea2(a, b, c);
    var o2 = triangleArea2(a, b, d);
    var o3 = triangleArea2(c, d, a);
    var o4 = triangleArea2(c, d, b);

    return (((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps)) &&
      ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps)));
  }

  function createEmptyAdjacency(nodeIds) {
    var adj = {};
    for (var i = 0; i < nodeIds.length; i += 1) {
      adj[nodeIds[i]] = [];
    }
    return adj;
  }

  function addUndirectedEdge(adjacency, source, target) {
    if (!adjacency[source]) {
      adjacency[source] = [];
    }
    if (!adjacency[target]) {
      adjacency[target] = [];
    }
    adjacency[source].push(target);
    adjacency[target].push(source);
  }

  function buildAdjacencyArrays(nodeIds, edgePairs) {
    // Use neighbor lists when callers want simple iteration order or indexable arrays.
    // The edge input is normalized first, so duplicate undirected edges are removed.
    var ids = normalizeNodeIds(nodeIds);
    var pairs = normalizeSimpleEdgePairs(edgePairs);
    var adjacency = createEmptyAdjacency(ids);
    for (var i = 0; i < pairs.length; i += 1) {
      addUndirectedEdge(adjacency, pairs[i][0], pairs[i][1]);
    }
    return adjacency;
  }

  function createEmptyAdjacencySets(nodeIds) {
    var adj = {};
    for (var i = 0; i < nodeIds.length; i += 1) {
      adj[String(nodeIds[i])] = new Set();
    }
    return adj;
  }

  function buildAdjacencySets(nodeIds, edgePairs) {
    // Use neighbor sets when callers care about uniqueness and set-style membership/mutation.
    var ids = normalizeNodeIds(nodeIds);
    var pairs = normalizeSimpleEdgePairs(edgePairs);
    var adj = createEmptyAdjacencySets(ids);
    for (var i = 0; i < pairs.length; i += 1) {
      var u = pairs[i][0];
      var v = pairs[i][1];
      if (!adj[u]) {
        adj[u] = new Set();
      }
      if (!adj[v]) {
        adj[v] = new Set();
      }
      adj[u].add(v);
      adj[v].add(u);
    }
    return adj;
  }

  function connectivityAfterRemoving(nodeIds, adjacency, removedSet) {
    var ids = nodeIds.map(String);
    var start = null;
    var remaining = 0;
    for (var i = 0; i < ids.length; i += 1) {
      var id = ids[i];
      if (removedSet && removedSet.has(id)) {
        continue;
      }
      remaining += 1;
      if (start === null) {
        start = id;
      }
    }
    if (remaining <= 1) {
      return { connected: true, remaining: remaining };
    }

    var seen = new Set([start]);
    var queue = [start];
    while (queue.length > 0) {
      var u = queue.shift();
      var neighbors = adjacency[u];
      if (!neighbors) {
        continue;
      }
      neighbors.forEach(function (v) {
        if (removedSet && removedSet.has(v)) {
          return;
        }
        if (seen.has(v)) {
          return;
        }
        seen.add(v);
        queue.push(v);
      });
    }

    return {
      connected: seen.size === remaining,
      remaining: remaining
    };
  }

  function analyzeThreeConnectivity(nodeIds, edgePairs) {
    var ids = nodeIds.map(String);
    if (ids.length < 4) {
      return {
        ok: false,
        reason: 'Graph is not 3-connected: requires at least 4 vertices'
      };
    }

    var adj = buildAdjacencySets(ids, edgePairs);
    for (var i = 0; i < ids.length; i += 1) {
      if ((adj[ids[i]] ? adj[ids[i]].size : 0) < 3) {
        return {
          ok: false,
          reason: 'Graph is not 3-connected: vertex ' + ids[i] + ' has degree < 3',
          witness: { type: 'low-degree', vertex: ids[i] }
        };
      }
    }

    var base = connectivityAfterRemoving(ids, adj, new Set());
    if (!base.connected) {
      return {
        ok: false,
        reason: 'Graph is not 3-connected: graph is disconnected',
        witness: { type: 'disconnected' }
      };
    }

    for (i = 0; i < ids.length; i += 1) {
      var cut1 = new Set([ids[i]]);
      if (!connectivityAfterRemoving(ids, adj, cut1).connected) {
        return {
          ok: false,
          reason: 'Graph is not 3-connected: articulation vertex ' + ids[i],
          witness: { type: 'articulation', vertex: ids[i] }
        };
      }
    }

    for (i = 0; i < ids.length; i += 1) {
      for (var j = i + 1; j < ids.length; j += 1) {
        var cut2 = new Set([ids[i], ids[j]]);
        if (!connectivityAfterRemoving(ids, adj, cut2).connected) {
          return {
            ok: false,
            reason: 'Graph is not 3-connected: separation pair {' + ids[i] + ', ' + ids[j] + '}',
            witness: { type: 'separation-pair', vertices: [ids[i], ids[j]] }
          };
        }
      }
    }

    return { ok: true };
  }

  function analyzeInternallyThreeConnected(nodeIds, edgePairs, outerFace) {
    var ids = nodeIds.map(String);
    var outer = Array.isArray(outerFace) ? outerFace.slice().map(String) : [];
    if (outer.length < 3) {
      return {
        ok: false,
        reason: 'Graph is not internally 3-connected: outer face must have at least 3 vertices'
      };
    }

    var idSet = new Set(ids);
    for (var i = 0; i < outer.length; i += 1) {
      if (!idSet.has(outer[i])) {
        return {
          ok: false,
          reason: 'Graph is not internally 3-connected: outer face contains unknown vertex ' + outer[i]
        };
      }
    }

    var hubId = '@internal3connOuterHub';
    var suffix = 0;
    while (idSet.has(hubId)) {
      suffix += 1;
      hubId = '@internal3connOuterHub' + suffix;
    }

    var augmentedNodeIds = ids.concat([hubId]);
    var augmentedEdgePairs = cloneEdgePairs(edgePairs);
    var seenOuter = new Set();
    for (i = 0; i < outer.length; i += 1) {
      var v = outer[i];
      if (seenOuter.has(v)) {
        continue;
      }
      seenOuter.add(v);
      augmentedEdgePairs.push([hubId, v]);
    }

    var result = analyzeThreeConnectivity(augmentedNodeIds, augmentedEdgePairs);
    if (result.ok) {
      return result;
    }
    return {
      ok: false,
      reason: 'Graph is not internally 3-connected for the chosen outer face: ' + result.reason,
      witness: result.witness || null
    };
  }

  function isThreeConnected(nodeIds, edgePairs) {
    return analyzeThreeConnectivity(nodeIds, edgePairs).ok;
  }

  function isInternallyThreeConnected(nodeIds, edgePairs, outerFace) {
    return analyzeInternallyThreeConnected(nodeIds, edgePairs, outerFace).ok;
  }

  function sameCyclicDirection(a, b) {
    if (!a || !b || a.length !== b.length || a.length === 0) return false;
    var arrA = a.map(String);
    var arrB = b.map(String);
    var n = arrA.length;
    var start = -1;
    for (var i = 0; i < n; i += 1) {
      if (arrB[i] === arrA[0]) {
        start = i;
        break;
      }
    }
    if (start < 0) return false;
    for (i = 0; i < n; i += 1) {
      if (arrA[i] !== arrB[(start + i) % n]) {
        return false;
      }
    }
    return true;
  }

  function sameCyclicEitherDirection(a, b) {
    if (sameCyclicDirection(a, b)) return true;
    if (!a || !b || a.length !== b.length) return false;
    return sameCyclicDirection(a, b.slice().reverse());
  }

  function findOuterFaceIndex(faces, outerFace) {
    if (!Array.isArray(faces) || !Array.isArray(outerFace) || outerFace.length === 0) {
      return -1;
    }
    for (var i = 0; i < faces.length; i += 1) {
      if (sameCyclicDirection(outerFace, faces[i])) {
        return i;
      }
    }
    for (i = 0; i < faces.length; i += 1) {
      if (sameCyclicEitherDirection(outerFace, faces[i])) {
        return i;
      }
    }
    return -1;
  }

  function embeddingHasFace(embedding, face) {
    var faces = embedding && Array.isArray(embedding.faces) ? embedding.faces : [];
    for (var i = 0; i < faces.length; i += 1) {
      if (sameCyclicEitherDirection(face, faces[i])) {
        return true;
      }
    }
    return false;
  }

  function buildOuterFaceEdgeSet(edgePairs) {
    var out = {};
    if (!Array.isArray(edgePairs)) return out;
    for (var i = 0; i < edgePairs.length; i += 1) {
      var e = edgePairs[i];
      if (!e || e.length < 2) continue;
      out[edgeKey(e[0], e[1])] = true;
    }
    return out;
  }

  function faceChordCount(face, edgeSet) {
    if (!Array.isArray(face) || face.length < 4) return 0;
    var count = 0;
    for (var i = 0; i < face.length; i += 1) {
      for (var j = i + 1; j < face.length; j += 1) {
        var isBoundaryEdge = (j === i + 1) || (i === 0 && j === face.length - 1);
        if (isBoundaryEdge) continue;
        if (edgeSet[edgeKey(face[i], face[j])]) {
          count += 1;
        }
      }
    }
    return count;
  }

  function chooseOuterFace(nodeIds, adjacency) {
      var edgePairs = [];
      var edgeSeen = {};

      for (var i = 0; i < nodeIds.length; i += 1) {
        var u = String(nodeIds[i]);
        var neighbors = adjacency[u] || [];
        for (var j = 0; j < neighbors.length; j += 1) {
          var v = String(neighbors[j]);
          var key = u < v ? u + '::' + v : v + '::' + u;
          if (edgeSeen[key]) {
            continue;
          }
          edgeSeen[key] = true;
          edgePairs.push([u, v]);
        }
      }

      var embedding = global.PlanarVibePlanarityTest.computePlanarEmbedding(nodeIds, edgePairs);
      if (embedding && embedding.ok && embedding.faces && embedding.faces.length > 0) {
        var selected = chooseOuterFaceFromEmbedding(embedding);
        if (selected && selected.length >= 3) {
          return selected;
        }
      }
    return null;
  }

  function chooseOuterFaceFromEmbedding(embedding) {
    if (!embedding) {
      return null;
    }
    var explicit = Array.isArray(embedding.outerFace) && embedding.outerFace.length >= 3
      ? embedding.outerFace.slice().map(String)
      : null;
    var edgeSet = buildOuterFaceEdgeSet(embedding.edges);
    if (explicit && (!Array.isArray(embedding.edges) || faceChordCount(explicit, edgeSet) === 0)) {
      return explicit;
    }
    if (Array.isArray(embedding.faces) && embedding.faces.length > 0) {
      var best = null;
      for (var i = 0; i < embedding.faces.length; i += 1) {
        var face = embedding.faces[i];
        if (!Array.isArray(face) || face.length < 3) continue;
        var mapped = face.slice().map(String);
        if (faceChordCount(mapped, edgeSet) !== 0) continue;
        if (!best || mapped.length > best.length) best = mapped;
      }
      return best;
    }
    return null;
  }

  function isTriangulatedEmbedding(embedding) {
    if (!embedding || !embedding.ok) {
      return false;
    }
    var n = embedding.idByIndex.length;
    var m = embedding.edges.length;
    if (n < 3) {
      return false;
    }
    if (m !== 3 * n - 6) {
      return false;
    }
    for (var i = 0; i < embedding.faces.length; i += 1) {
      if (embedding.faces[i].length !== 3) {
        return false;
      }
    }
    return true;
  }

  function isTriangulatedEmbeddingExceptOuter(embedding, outerFace) {
    if (!embedding || !embedding.ok) {
      return false;
    }
    var outerIndex = findOuterFaceIndex(embedding.faces, outerFace);
    for (var i = 0; i < embedding.faces.length; i += 1) {
      var face = embedding.faces[i];
      if (!face || face.length < 3) {
        return false;
      }
      if (i === outerIndex) {
        continue;
      }
      if (face.length !== 3) {
        return false;
      }
    }
    return true;
  }

  function cloneEdgePairs(edgePairs) {
    return edgePairs.map(function (e) {
      return [String(e[0]), String(e[1])];
    });
  }

  function computeDrawingDiameter(nodeIds, posById) {
    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    for (var i = 0; i < nodeIds.length; i += 1) {
      var id = String(nodeIds[i]);
      var p = posById ? posById[id] : null;
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        continue;
      }
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return 1;
    }
    var dx = maxX - minX;
    var dy = maxY - minY;
    var d = Math.sqrt(dx * dx + dy * dy);
    return d > 1e-9 ? d : 1;
  }

  function copyPositionMap(posById) {
    var out = {};
    var keys = Object.keys(posById || {});
    for (var i = 0; i < keys.length; i += 1) {
      var id = keys[i];
      var p = posById[id];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        continue;
      }
      out[id] = { x: p.x, y: p.y };
    }
    return out;
  }

  function filterPositionMap(posById, nodeIds) {
    var ids = normalizeNodeIds(nodeIds);
    var out = {};
    for (var i = 0; i < ids.length; i += 1) {
      var id = ids[i];
      var p = posById ? posById[id] : null;
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        continue;
      }
      out[id] = { x: p.x, y: p.y };
    }
    return out;
  }

  function collectMovableVertices(nodeIds, outerFace) {
    var outerSet = new Set((outerFace || []).map(String));
    var movable = [];
    for (var i = 0; i < (nodeIds || []).length; i += 1) {
      var id = String(nodeIds[i]);
      if (!outerSet.has(id)) {
        movable.push(id);
      }
    }
    return movable;
  }

  function computeFaceCentroid(posById, face) {
    var ids = Array.isArray(face) ? face : [];
    var sx = 0;
    var sy = 0;
    var count = 0;
    for (var i = 0; i < ids.length; i += 1) {
      var p = posById[String(ids[i])];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        continue;
      }
      sx += p.x;
      sy += p.y;
      count += 1;
    }
    if (count < 1) {
      return { x: 0, y: 0 };
    }
    return { x: sx / count, y: sy / count };
  }

  function rotatePositionMap(posById, center, angle) {
    var out = {};
    var c = Math.cos(angle);
    var s = Math.sin(angle);
    var keys = Object.keys(posById || {});
    for (var i = 0; i < keys.length; i += 1) {
      var id = keys[i];
      var p = posById[id];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        continue;
      }
      var dx = p.x - center.x;
      var dy = p.y - center.y;
      out[id] = {
        x: center.x + c * dx - s * dy,
        y: center.y + s * dx + c * dy
      };
    }
    return out;
  }

  function alignOuterFaceEdgeHorizontally(posById, outerFace) {
    var face = Array.isArray(outerFace) ? outerFace.map(String) : [];
    if (face.length < 2) {
      return copyPositionMap(posById);
    }
    var bestIndex = -1;
    var bestLength2 = -1;
    for (var i = 0; i < face.length; i += 1) {
      var a = posById ? posById[face[i]] : null;
      var b = posById ? posById[face[(i + 1) % face.length]] : null;
      if (!a || !b || !Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(b.x) || !Number.isFinite(b.y)) {
        continue;
      }
      var dx = b.x - a.x;
      var dy = b.y - a.y;
      var len2 = dx * dx + dy * dy;
      if (len2 > bestLength2) {
        bestLength2 = len2;
        bestIndex = i;
      }
    }
    if (!(bestIndex >= 0) || !(bestLength2 > 1e-18)) {
      return copyPositionMap(posById);
    }
    var start = posById[face[bestIndex]];
    var end = posById[face[(bestIndex + 1) % face.length]];
    var angle = Math.atan2(end.y - start.y, end.x - start.x);
    return rotatePositionMap(posById, computeFaceCentroid(posById, face), -angle);
  }

  function computeMoveStats(items, distanceFn, options) {
    var opts = options || {};
    var moveTol = resolveNonNegativeOption(opts.moveTol, 1e-9);
    var movedVertices = 0;
    var totalMove = 0;
    var maxMove = 0;
    var list = Array.isArray(items) ? items : [];
    for (var i = 0; i < list.length; i += 1) {
      var dist = distanceFn(list[i], i);
      if (!Number.isFinite(dist) || dist < 0) {
        continue;
      }
      totalMove += dist;
      if (dist > maxMove) {
        maxMove = dist;
      }
      if (dist > moveTol) {
        movedVertices += 1;
      }
    }
    return {
      movedVertices: movedVertices,
      totalMove: totalMove,
      avgMove: list.length > 0 ? (totalMove / list.length) : 0,
      maxMove: maxMove
    };
  }

  function buildLayoutResult(fields) {
    var base = fields || {};
    var pos = base.pos !== undefined ? base.pos : (base.posById !== undefined ? base.posById : null);
    var posById = base.posById !== undefined ? base.posById : pos;
    var iters = Number.isFinite(base.iters) ? base.iters : (Number.isFinite(base.iterations) ? base.iterations : null);
    var iterations = Number.isFinite(base.iterations) ? base.iterations : iters;
    var status = base.status !== undefined ? base.status : (base.stopReason !== undefined ? base.stopReason : null);
    var stopReason = base.stopReason !== undefined ? base.stopReason : (base.status !== undefined ? base.status : null);

    return Object.assign({}, base, {
      ok: base.ok !== false,
      pos: pos,
      posById: posById,
      iters: iters,
      iterations: iterations,
      outerFace: base.outerFace !== undefined ? base.outerFace : null,
      graph: base.graph !== undefined ? base.graph : null,
      augmented: base.augmented !== undefined ? base.augmented : null,
      status: status,
      stopReason: stopReason
    });
  }

  function buildLayoutError(fields) {
    return buildLayoutResult(Object.assign({
      ok: false,
      pos: null,
      posById: null,
      iters: null,
      iterations: null,
      outerFace: null,
      graph: null,
      augmented: null,
      status: null,
      stopReason: null
    }, fields || {}));
  }

  function buildLayoutStatusMessage(layoutName, stats) {
    var name = String(layoutName || 'Layout');
    var data = stats || {};
    var parts = [];

    if (Number.isFinite(data.outerFaceVertexCount)) {
      parts.push(data.outerFaceVertexCount + '-vertex outer face');
    }
    if (Number.isFinite(data.boundedFaceCount)) {
      parts.push(data.boundedFaceCount + ' bounded faces');
    }
    if (Number.isFinite(data.vertexCount)) {
      parts.push(data.vertexCount + ' vertices');
    }
    if (Number.isFinite(data.dummyCount) && data.dummyCount > 0) {
      parts.push('+' + data.dummyCount + ' dummy vertices');
    }
    if (Number.isFinite(data.iters)) {
      parts.push(data.iters + ' iters');
    }
    if (Number.isFinite(data.outerSteps)) {
      parts.push(data.outerSteps + ' steps');
    }
    if (Number.isFinite(data.accepted)) {
      parts.push('accepted ' + data.accepted);
    }
    if (Number.isFinite(data.rejected)) {
      parts.push('rejected ' + data.rejected);
    }
    if (data.status) {
      parts.push('status ' + data.status);
    } else if (data.stopReason) {
      parts.push(String(data.stopReason));
    }
    if (Number.isFinite(data.maxRelError)) {
      parts.push('max rel err ' + data.maxRelError.toFixed(3));
    }
    if (Number.isFinite(data.faceAreaScore)) {
      parts.push('face score ' + data.faceAreaScore.toFixed(3));
    }
    if (Number.isFinite(data.faceAreaMinRatio)) {
      parts.push('min ratio ' + data.faceAreaMinRatio.toFixed(3));
    }
    if (Number.isFinite(data.faceAreaMaxRatio)) {
      parts.push('max ratio ' + data.faceAreaMaxRatio.toFixed(3));
    }
    if (Array.isArray(data.extraParts)) {
      for (var i = 0; i < data.extraParts.length; i += 1) {
        if (data.extraParts[i]) {
          parts.push(String(data.extraParts[i]));
        }
      }
    }

    return 'Applied ' + name + ' (' + parts.join(', ') + ')';
  }

  function computePositionMoveStats(nodeIds, prevPosById, nextPosById, options) {
    return computeMoveStats(nodeIds, function (nodeId) {
      var id = String(nodeId);
      var prev = prevPosById ? prevPosById[id] : null;
      var next = nextPosById ? nextPosById[id] : null;
      if (!prev || !next || !Number.isFinite(prev.x) || !Number.isFinite(prev.y) || !Number.isFinite(next.x) || !Number.isFinite(next.y)) {
        return NaN;
      }
      return Math.hypot(next.x - prev.x, next.y - prev.y);
    }, options);
  }

  function hasPositionCrossings(posById, edgePairs) {
    return !!global.PlanarVibeMetrics.hasCrossingsFromPositions(posById, edgePairs);
  }

  function createMovementConvergenceTracker(options) {
    var opts = options || {};
    var minItersBeforeStop = resolveIntOption(opts.minItersBeforeStop, 20, 1);
    var stableIterLimit = resolveIntOption(opts.stableIterLimit, 5, 1);
    var maxMoveTol = resolveNonNegativeOption(opts.maxMoveTol, 1e-3);
    var avgMoveTol = resolveNonNegativeOption(opts.avgMoveTol, maxMoveTol);
    var stableIterations = 0;

    return {
      update: function (stats, iter) {
        var stable = !!stats &&
          Number.isFinite(stats.maxMove) &&
          Number.isFinite(stats.avgMove) &&
          stats.maxMove <= maxMoveTol &&
          stats.avgMove <= avgMoveTol;
        stableIterations = stable ? (stableIterations + 1) : 0;
        var ready = iter >= minItersBeforeStop && stableIterations >= stableIterLimit;
        return {
          stable: stable,
          stableIterations: stableIterations,
          stableIterLimit: stableIterLimit,
          converged: ready,
          reason: ready ? 'movement-converged' : null
        };
      }
    };
  }

  function augmentByFaceStellation(nodeIds, edgePairs, embedding, outerFace, options) {
    var nodes = nodeIds.map(String);
    var edges = cloneEdgePairs(edgePairs);
    var edgeSet = new Set();
    var idSet = new Set(nodes);
    var dummyCount = 0;
    var dummyFaceVerticesById = {};
    var outerIndex = findOuterFaceIndex(embedding.faces, outerFace);
    var outerVertexSet = new Set((outerFace || []).map(String));
    var opts = options || {};
    var forceSingleDummyPerFace = !!opts.forceSingleDummyPerFace;

    for (var i = 0; i < edges.length; i += 1) {
      edgeSet.add(edgeKey(edges[i][0], edges[i][1]));
    }

    function nextDummyId() {
      var id;
      do {
        id = '@dummy' + dummyCount;
        dummyCount += 1;
      } while (idSet.has(id));
      idSet.add(id);
      return id;
    }

    function addEdge(u, v) {
      var key = edgeKey(u, v);
      if (edgeSet.has(key)) {
        return;
      }
      edgeSet.add(key);
      edges.push([u, v]);
    }

    function buildTriangleAvoidingBlocks(face) {
      var boundary = face.map(String);
      var n = boundary.length;
      if (n <= 3) {
        return [];
      }

      var blocks = [];
      var current = [boundary[0]];
      for (var step = 1; step < n; step += 1) {
        var candidate = boundary[step];
        var createsTriangle = false;
        for (var j = 0; j < current.length - 1; j += 1) {
          // The final boundary edge back to the starting vertex is part of the
          // intended one-dummy fan, not a premature separating triangle.
          if (j === 0 && current[0] === boundary[0] && candidate === boundary[n - 1]) {
            continue;
          }
          // Boundary shortcuts between two chosen outer-face vertices are not
          // treated as premature triangles for block splitting.
          if (outerVertexSet.has(current[j]) && outerVertexSet.has(candidate)) {
            continue;
          }
          if (edgeSet.has(edgeKey(current[j], candidate))) {
            createsTriangle = true;
            break;
          }
        }
        if (!createsTriangle) {
          current.push(candidate);
          continue;
        }
        if (current.length < 2) {
          return null;
        }
        blocks.push(current.slice());
        current = [current[current.length - 1], candidate];
      }

      if (current.length < 2) {
        return null;
      }
      blocks.push(current.slice());
      return blocks;
    }

    function augmentFaceWithPath(face) {
      var blocks = forceSingleDummyPerFace
        ? [face.slice().map(String)]
        : buildTriangleAvoidingBlocks(face);
      if (!Array.isArray(blocks) || blocks.length === 0) {
        return false;
      }

      var dummies = [];
      for (var bi = 0; bi < blocks.length; bi += 1) {
        var dummy = nextDummyId();
        dummies.push(dummy);
        nodes.push(dummy);
        dummyFaceVerticesById[dummy] = face.slice().map(String);
        var seenBoundary = new Set();
        for (var bj = 0; bj < blocks[bi].length; bj += 1) {
          var boundaryId = String(blocks[bi][bj]);
          if (seenBoundary.has(boundaryId)) {
            continue;
          }
          seenBoundary.add(boundaryId);
          addEdge(dummy, boundaryId);
        }
      }

      for (bi = 0; bi < dummies.length - 1; bi += 1) {
        addEdge(dummies[bi], dummies[bi + 1]);
      }

      if (dummies.length === 1) {
        return true;
      }

      // The greedy blocks triangulate the boundary chains but leave one cap
      // polygon [apex, d0, d1, ..., d{k-1}]. Triangulate it explicitly.
      var apex = String(blocks[0][0]);
      for (bi = 1; bi < dummies.length; bi += 1) {
        addEdge(apex, dummies[bi]);
      }

      return true;
    }

    for (i = 0; i < embedding.faces.length; i += 1) {
      var face = embedding.faces[i];
      if (!face || face.length <= 3) {
        continue;
      }
      if (i === outerIndex) {
        continue;
      }

      if (!augmentFaceWithPath(face)) {
        return {
          nodeIds: nodes,
          edgePairs: edges,
          dummyCount: 0,
          dummyFaceVerticesById: {},
          reason: 'Path augmentation failed for face ' + face.join(',')
        };
      }
    }

    return {
      nodeIds: nodes,
      edgePairs: edges,
      dummyCount: dummyCount,
      dummyFaceVerticesById: dummyFaceVerticesById
    };
  }

  function removeDegreeThreeDummyVertices(nodeIds, edgePairs, dummyFaceVerticesById, outerFace) {
    var nodes = (nodeIds || []).map(String);
    var edges = cloneEdgePairs(edgePairs || []);
    var dummyMap = {};
    var dummyIds = Object.keys(dummyFaceVerticesById || {});
    var outerSet = new Set((outerFace || []).map(String));
    var i;

    for (i = 0; i < dummyIds.length; i += 1) {
      var dummyId = String(dummyIds[i]);
      dummyMap[dummyId] = (dummyFaceVerticesById[dummyId] || []).map(String);
    }

    var removedDummyIds = [];
    while (true) {
      var adjacency = buildAdjacencySets(nodes, edges);
      var removable = [];
      var currentDummyIds = Object.keys(dummyMap);
      for (i = 0; i < currentDummyIds.length; i += 1) {
        var currentDummyId = String(currentDummyIds[i]);
        if (outerSet.has(currentDummyId)) {
          continue;
        }
        if (!adjacency[currentDummyId]) {
          delete dummyMap[currentDummyId];
          continue;
        }
        if (adjacency[currentDummyId].size === 3) {
          removable.push(currentDummyId);
        }
      }
      if (removable.length === 0) {
        break;
      }

      var removeSet = new Set(removable);
      nodes = nodes.filter(function (id) {
        return !removeSet.has(String(id));
      });
      edges = edges.filter(function (edge) {
        return !removeSet.has(String(edge[0])) && !removeSet.has(String(edge[1]));
      });
      for (i = 0; i < removable.length; i += 1) {
        delete dummyMap[String(removable[i])];
        removedDummyIds.push(String(removable[i]));
      }
    }

    return {
      nodeIds: nodes,
      edgePairs: edges,
      dummyFaceVerticesById: dummyMap,
      dummyCount: Object.keys(dummyMap).length,
      removedDummyIds: removedDummyIds
    };
  }

  function triangulateByFaceStellation(nodeIds, edgePairs, embedding, outerFace, options) {
    var nodes = nodeIds.map(String);
    var edges = normalizeSimpleEdgePairs(edgePairs);
    var emb = embedding || global.PlanarVibePlanarityTest.computePlanarEmbedding(nodes, edges);
    if (!emb || !emb.ok) {
      return {
        ok: false,
        reason: 'Graph is not planar'
      };
    }
    var selectedOuterFace = Array.isArray(outerFace) ? outerFace.slice().map(String) : chooseOuterFaceFromEmbedding(emb);
    if (!selectedOuterFace || selectedOuterFace.length < 3) {
      return {
        ok: false,
        reason: 'Could not determine outer face'
      };
    }
    var opts = options || {};

    var dummyFaceVerticesById = {};
    var round = 0;
    var maxRounds = 1000;

    while (!isTriangulatedEmbeddingExceptOuter(emb, selectedOuterFace)) {
      if (round >= maxRounds) {
        return {
          ok: false,
          reason: 'Augmentation failed to triangulate all faces'
        };
      }

      var step = augmentByFaceStellation(nodes, edges, emb, selectedOuterFace, opts);
      if (!step || !Array.isArray(step.nodeIds) || !Array.isArray(step.edgePairs)) {
        return {
          ok: false,
          reason: 'Augmentation failed: invalid augmentation result'
        };
      }
      if (!(step.dummyCount > 0)) {
        return {
          ok: false,
          reason: 'Augmentation failed to triangulate all non-outer faces'
        };
      }

      nodes = step.nodeIds.map(String);
      edges = cloneEdgePairs(step.edgePairs);
      var stepDummyFaceVerticesById = step.dummyFaceVerticesById || {};
      var dummyIds = Object.keys(stepDummyFaceVerticesById);
      for (var i = 0; i < dummyIds.length; i += 1) {
        var dummyId = String(dummyIds[i]);
        dummyFaceVerticesById[dummyId] = (stepDummyFaceVerticesById[dummyId] || []).map(String);
      }

      emb = global.PlanarVibePlanarityTest.computePlanarEmbedding(nodes, edges);
      if (!emb || !emb.ok) {
        return {
          ok: false,
          reason: 'Augmentation failed: resulting graph is not planar'
        };
      }
      emb.outerFace = selectedOuterFace.slice();
      round += 1;
    }

    var simplified = removeDegreeThreeDummyVertices(nodes, edges, dummyFaceVerticesById, selectedOuterFace);
    nodes = simplified.nodeIds.map(String);
    edges = cloneEdgePairs(simplified.edgePairs);
    dummyFaceVerticesById = simplified.dummyFaceVerticesById || {};

    emb = global.PlanarVibePlanarityTest.computePlanarEmbedding(nodes, edges);
    if (!emb || !emb.ok) {
      return {
        ok: false,
        reason: 'Augmentation simplification failed: resulting graph is not planar'
      };
    }
    if (!isTriangulatedEmbeddingExceptOuter(emb, selectedOuterFace)) {
      return {
        ok: false,
        reason: 'Augmentation simplification failed to preserve triangulation'
      };
    }
    emb.outerFace = selectedOuterFace.slice();

    if (!opts.triangulateOuterFace) {
      return {
        ok: true,
        nodeIds: nodes,
        edgePairs: edges,
        dummyCount: Object.keys(dummyFaceVerticesById).length,
        dummyFaceVerticesById: dummyFaceVerticesById,
        embedding: emb
      };
    }
    if (isTriangulatedEmbedding(emb)) {
      return {
        ok: true,
        nodeIds: nodes,
        edgePairs: edges,
        dummyCount: Object.keys(dummyFaceVerticesById).length,
        dummyFaceVerticesById: dummyFaceVerticesById,
        embedding: emb
      };
    }
    if (selectedOuterFace.length === 3) {
      return {
        ok: false,
        reason: 'Expected a fully triangulated embedding but outer face is still not triangular'
      };
    }

    var idSet = new Set(nodes);
    var outerDummyId = '@outerDummy';
    var suffix = 0;
    while (idSet.has(outerDummyId)) {
      suffix += 1;
      outerDummyId = '@outerDummy' + suffix;
    }
    nodes = nodes.slice();
    edges = cloneEdgePairs(edges);
    nodes.push(outerDummyId);
    for (i = 0; i < selectedOuterFace.length; i += 1) {
      edges.push([outerDummyId, String(selectedOuterFace[i])]);
    }

    emb = global.PlanarVibePlanarityTest.computePlanarEmbedding(nodes, edges);
    if (!emb || !emb.ok) {
      return {
        ok: false,
        reason: 'Full triangulation failed: resulting graph is not planar'
      };
    }
    if (!isTriangulatedEmbedding(emb)) {
      return {
        ok: false,
        reason: 'Full triangulation failed to triangulate all faces'
      };
    }
    emb.outerFace = [outerDummyId, selectedOuterFace[0], selectedOuterFace[1]];
    var nextDummyFaceVerticesById = {};
    var dummyIds = Object.keys(dummyFaceVerticesById);
    for (i = 0; i < dummyIds.length; i += 1) {
      nextDummyFaceVerticesById[String(dummyIds[i])] = (dummyFaceVerticesById[dummyIds[i]] || []).map(String);
    }
    dummyFaceVerticesById = nextDummyFaceVerticesById;
    dummyFaceVerticesById[outerDummyId] = selectedOuterFace.slice();

    return {
      ok: true,
      nodeIds: nodes,
      edgePairs: edges,
      dummyCount: Object.keys(dummyFaceVerticesById).length,
      outerDummyId: opts.triangulateOuterFace ? outerDummyId : undefined,
      dummyFaceVerticesById: dummyFaceVerticesById,
      embedding: emb
    };
  }

  global.GraphUtils = {
    faceKey: faceKey,
    polygonArea2: polygonArea2,
    polygonAreaAbs: polygonAreaAbs,
    pointAdd: pointAdd,
    pointSub: pointSub,
    pointScale: pointScale,
    pointDot: pointDot,
    pointRot90: pointRot90,
    pointNorm: pointNorm,
    pointEquals: pointEquals,
    pointOnSegment: pointOnSegment,
    pointOnSegmentInterior: pointOnSegmentInterior,
    vecDot: vecDot,
    vecNorm: vecNorm,
    vecAddScaled: vecAddScaled,
    vecSub: vecSub,
    vecScale: vecScale,
    orientFaceCCW: orientFaceCCW,
    outerFaceDiameter: outerFaceDiameter,
    edgeKey: edgeKey,
    hashString: hashString,
    normalizedHash: normalizedHash,
    resolveFiniteOption: resolveFiniteOption,
    resolveFloatOption: resolveFloatOption,
    resolveIntOption: resolveIntOption,
    resolvePositiveOption: resolvePositiveOption,
    resolveNonNegativeOption: resolveNonNegativeOption,
    resolveGreaterThanOption: resolveGreaterThanOption,
    resolveOpenIntervalOption: resolveOpenIntervalOption,
    resolveFunctionOption: resolveFunctionOption,
    luFactorize: luFactorize,
    solveLUWithTwoRhs: solveLUWithTwoRhs,
    solveTransposeLUWithTwoRhs: solveTransposeLUWithTwoRhs,
    triangleArea2: triangleArea2,
    segmentsIntersectStrict: segmentsIntersectStrict,
    segmentsIntersectOrTouch: segmentsIntersectOrTouch,
    buildAdjacencyArrays: buildAdjacencyArrays,
    buildAdjacencySets: buildAdjacencySets,
    normalizeNodeIds: normalizeNodeIds,
    normalizeEdgePairs: normalizeEdgePairs,
    normalizeGraphInput: normalizeGraphInput,
    normalizeSimpleEdgePairs: normalizeSimpleEdgePairs,
    normalizeOuterFace: normalizeOuterFace,
    sameCyclicDirection: sameCyclicDirection,
    sameCyclicEitherDirection: sameCyclicEitherDirection,
    findOuterFaceIndex: findOuterFaceIndex,
    embeddingHasFace: embeddingHasFace,
    cloneEdgePairs: cloneEdgePairs,
    computeDrawingDiameter: computeDrawingDiameter,
    copyPositions: copyPositionMap,
    filterPositions: filterPositionMap,
    collectMovableVertices: collectMovableVertices,
    alignOuterFaceEdgeHorizontally: alignOuterFaceEdgeHorizontally,
    computeMoveStats: computeMoveStats,
    buildLayoutResult: buildLayoutResult,
    buildLayoutError: buildLayoutError,
    buildLayoutStatusMessage: buildLayoutStatusMessage,
    computePositionMoveStats: computePositionMoveStats,
    hasPositionCrossings: hasPositionCrossings,
    createMovementConvergenceTracker: createMovementConvergenceTracker,
    analyzeThreeConnectivity: analyzeThreeConnectivity,
    analyzeInternallyThreeConnected: analyzeInternallyThreeConnected,
    isThreeConnected: isThreeConnected,
    isInternallyThreeConnected: isInternallyThreeConnected,
    isTriangulatedEmbedding: isTriangulatedEmbedding,
    augmentByFaceStellation: augmentByFaceStellation,
    triangulateByFaceStellation: triangulateByFaceStellation,
    chooseOuterFace: chooseOuterFace,
    chooseOuterFaceFromEmbedding: chooseOuterFaceFromEmbedding
  };
})(window);
