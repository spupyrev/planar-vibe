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

  function normalizeDistribution(rawValues) {
    var total = 0;
    for (var i = 0; i < rawValues.length; i += 1) {
      total += rawValues[i];
    }
    if (!(total > 0)) {
      return null;
    }
    var normalized = rawValues.map(function (v) { return v / total; });
    normalized.sort(function (a, b) { return a - b; });
    return normalized;
  }

  function uniformIdealDistribution(n) {
    var ideal = [];
    if (!(n > 0)) {
      return ideal;
    }
    var v = 1 / n;
    for (var i = 0; i < n; i += 1) {
      ideal.push(v);
    }
    return ideal;
  }

  function computeUniformityScore(values, idealValues) {
    if (!values || !idealValues || values.length === 0 || values.length !== idealValues.length) {
      return null;
    }
    var k = values.length;
    if (k === 1) {
      return 1;
    }

    var sumSq = 0;
    var sumIdealSq = 0;
    var minIdeal = Infinity;
    for (var i = 0; i < k; i += 1) {
      var x = values[i];
      var p = idealValues[i];
      if (!Number.isFinite(x) || !Number.isFinite(p)) {
        return null;
      }
      var d = x - p;
      sumSq += d * d;
      sumIdealSq += p * p;
      if (p < minIdeal) {
        minIdeal = p;
      }
    }
    if (!Number.isFinite(minIdeal)) {
      return null;
    }

    // Maximum squared L2 distance to ideal over the simplex occurs at a vertex.
    var maxSq = 1 - 2 * minIdeal + sumIdealSq;
    if (!(maxSq > 0)) {
      return 1;
    }
    var normalized = Math.sqrt(sumSq / maxSq);
    var quality = 1 - normalized;
    return Math.max(0, Math.min(1, quality));
  }

  function buildUniformDistributionResult(rawValues, noDataReason, degenerateReason) {
    if (!rawValues || rawValues.length === 0) {
      return { ok: false, reason: noDataReason };
    }
    var normalized = normalizeDistribution(rawValues);
    if (!normalized) {
      return { ok: false, reason: degenerateReason };
    }
    var idealValues = uniformIdealDistribution(normalized.length);
    return {
      ok: true,
      values: normalized,
      ideal: 1 / normalized.length,
      idealValues: idealValues,
      quality: computeUniformityScore(normalized, idealValues)
    };
  }

  function computeUniformFaceAreaScore(nodeIds, edgePairs, posById) {
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

    var result = buildUniformDistributionResult(areas, 'No bounded face areas available', 'Degenerate face areas');
    if (!result.ok) {
      return result;
    }
    result.faceCount = result.values.length;
    return result;
  }

  function computeUniformFaceAreaScoreFromCy(cy, edgePairs) {
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
    return computeUniformFaceAreaScore(nodeIds, pairs, posById);
  }

  function computeUniformEdgeLengthScore(edgePairs, posById) {
    if (!edgePairs || edgePairs.length === 0) {
      return { ok: false, reason: 'No edges' };
    }
    var lengths = [];
    for (var i = 0; i < edgePairs.length; i += 1) {
      var u = String(edgePairs[i][0]);
      var v = String(edgePairs[i][1]);
      var pu = posById[u];
      var pv = posById[v];
      if (!pu || !pv || !Number.isFinite(pu.x) || !Number.isFinite(pu.y) || !Number.isFinite(pv.x) || !Number.isFinite(pv.y)) {
        return { ok: false, reason: 'Metrics unavailable' };
      }
      var dx = pu.x - pv.x;
      var dy = pu.y - pv.y;
      var len = Math.sqrt(dx * dx + dy * dy);
      if (!(len > 1e-12)) {
        continue;
      }
      lengths.push(len);
    }
    return buildUniformDistributionResult(lengths, 'No edge lengths available', 'No edge lengths available');
  }

  function computeDistributionQuality(values) {
    var ideal = uniformIdealDistribution(values ? values.length : 0);
    return computeUniformityScore(values, ideal);
  }

  function computeUniformAngleResolutionScore(nodeIds, edgePairs, posById) {
    if (!nodeIds || nodeIds.length === 0) {
      return { ok: false, reason: 'No nodes' };
    }
    if (!edgePairs || edgePairs.length === 0) {
      return { ok: false, reason: 'No edges' };
    }
    if (!global.PlanarVibePlanarityTest || !global.PlanarVibePlanarityTest.computePlanarEmbedding) {
      return { ok: false, reason: 'Planarity utilities are missing.' };
    }

    var emb = global.PlanarVibePlanarityTest.computePlanarEmbedding(nodeIds, edgePairs);
    if (!emb || !emb.ok) {
      return { ok: false, reason: 'Graph is not planar' };
    }

    var adjacency = {};
    for (var i = 0; i < nodeIds.length; i += 1) {
      adjacency[String(nodeIds[i])] = [];
    }
    for (i = 0; i < edgePairs.length; i += 1) {
      var u = String(edgePairs[i][0]);
      var v = String(edgePairs[i][1]);
      if (!adjacency[u]) adjacency[u] = [];
      if (!adjacency[v]) adjacency[v] = [];
      adjacency[u].push(v);
      adjacency[v].push(u);
    }

    var outerSet = new Set((emb.outerFace || []).map(String));
    var allValues = [];
    var allIdealValues = [];
    var TWO_PI = 2 * Math.PI;

    for (i = 0; i < nodeIds.length; i += 1) {
      var id = String(nodeIds[i]);
      var neighbors = adjacency[id] || [];
      if (neighbors.length < 2) {
        continue;
      }
      var p = posById[id];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        return { ok: false, reason: 'Metrics unavailable' };
      }

      var dirs = [];
      for (var j = 0; j < neighbors.length; j += 1) {
        var q = posById[String(neighbors[j])];
        if (!q || !Number.isFinite(q.x) || !Number.isFinite(q.y)) {
          return { ok: false, reason: 'Metrics unavailable' };
        }
        var a = Math.atan2(q.y - p.y, q.x - p.x);
        if (a < 0) a += TWO_PI;
        dirs.push(a);
      }
      dirs.sort(function (a, b) { return a - b; });

      var gaps = [];
      for (j = 0; j < dirs.length; j += 1) {
        var next = dirs[(j + 1) % dirs.length];
        var cur = dirs[j];
        var g = next - cur;
        if (g <= 0) g += TWO_PI;
        gaps.push(g);
      }

      var considered = gaps.slice();
      if (outerSet.has(id)) {
        var maxIdx = 0;
        for (j = 1; j < gaps.length; j += 1) {
          if (gaps[j] > gaps[maxIdx]) {
            maxIdx = j;
          }
        }
        considered.splice(maxIdx, 1);
      }

      if (considered.length === 0) {
        continue;
      }
      var localSum = 0;
      for (j = 0; j < considered.length; j += 1) {
        localSum += considered[j];
      }
      if (!(localSum > 0)) {
        continue;
      }
      var localValues = considered.map(function (x) { return x / localSum; });
      var idealAngle = 1 / localValues.length;
      for (j = 0; j < localValues.length; j += 1) {
        allValues.push(localValues[j]);
        allIdealValues.push(idealAngle);
      }
    }

    if (allValues.length === 0) {
      return { ok: false, reason: 'No angle data' };
    }
    var score = computeUniformityScore(allValues, allIdealValues);
    var pairs = [];
    for (i = 0; i < allValues.length; i += 1) {
      pairs.push([allValues[i], allIdealValues[i]]);
    }
    pairs.sort(function (a, b) {
      var ra = a[0] / Math.max(a[1], 1e-12);
      var rb = b[0] / Math.max(b[1], 1e-12);
      return ra - rb;
    });
    var valuesSorted = pairs.map(function (p) { return p[0]; });
    var idealSorted = pairs.map(function (p) { return p[1]; });
    return {
      ok: true,
      score: score === null ? null : Math.max(0, Math.min(1, score)),
      values: valuesSorted,
      idealValues: idealSorted,
      angleCount: allValues.length
    };
  }

  function hasCrossingsFromPositions(posById, edgePairs) {
    var EPS = 1e-9;

    function orient(a, b, c) {
      return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    }

    function onSegment(a, b, c) {
      return (
        Math.min(a.x, b.x) - EPS <= c.x && c.x <= Math.max(a.x, b.x) + EPS &&
        Math.min(a.y, b.y) - EPS <= c.y && c.y <= Math.max(a.y, b.y) + EPS
      );
    }

    function pointsEqual(a, b) {
      return Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS;
    }

    function properIntersect(a, b, c, d) {
      var o1 = orient(a, b, c);
      var o2 = orient(a, b, d);
      var o3 = orient(c, d, a);
      var o4 = orient(c, d, b);

      if (((o1 > EPS && o2 < -EPS) || (o1 < -EPS && o2 > EPS)) &&
          ((o3 > EPS && o4 < -EPS) || (o3 < -EPS && o4 > EPS))) {
        return true;
      }

      if (Math.abs(o1) <= EPS && onSegment(a, b, c) && !pointsEqual(c, a) && !pointsEqual(c, b)) return true;
      if (Math.abs(o2) <= EPS && onSegment(a, b, d) && !pointsEqual(d, a) && !pointsEqual(d, b)) return true;
      if (Math.abs(o3) <= EPS && onSegment(c, d, a) && !pointsEqual(a, c) && !pointsEqual(a, d)) return true;
      if (Math.abs(o4) <= EPS && onSegment(c, d, b) && !pointsEqual(b, c) && !pointsEqual(b, d)) return true;
      return false;
    }

    for (var i = 0; i < edgePairs.length; i += 1) {
      var s1 = String(edgePairs[i][0]);
      var t1 = String(edgePairs[i][1]);
      var p1 = posById[s1];
      var q1 = posById[t1];
      if (!p1 || !q1) {
        continue;
      }

      for (var j = i + 1; j < edgePairs.length; j += 1) {
        var s2 = String(edgePairs[j][0]);
        var t2 = String(edgePairs[j][1]);
        if (s1 === s2 || s1 === t2 || t1 === s2 || t1 === t2) {
          continue;
        }
        var p2 = posById[s2];
        var q2 = posById[t2];
        if (!p2 || !q2) {
          continue;
        }

        if (properIntersect(p1, q1, p2, q2)) {
          return true;
        }
      }
    }
    return false;
  }

  function isBipartiteGraph(nodeIds, edgePairs) {
    var adjacency = {};
    for (var i = 0; i < nodeIds.length; i += 1) {
      adjacency[String(nodeIds[i])] = [];
    }
    for (i = 0; i < edgePairs.length; i += 1) {
      var u = String(edgePairs[i][0]);
      var v = String(edgePairs[i][1]);
      if (u === v) {
        return false;
      }
      if (!adjacency[u]) adjacency[u] = [];
      if (!adjacency[v]) adjacency[v] = [];
      adjacency[u].push(v);
      adjacency[v].push(u);
    }

    var color = {};
    for (i = 0; i < nodeIds.length; i += 1) {
      var start = String(nodeIds[i]);
      if (color[start] !== undefined) continue;
      color[start] = 0;
      var queue = [start];
      var head = 0;
      while (head < queue.length) {
        var x = queue[head];
        head += 1;
        var neigh = adjacency[x] || [];
        for (var j = 0; j < neigh.length; j += 1) {
          var y = neigh[j];
          if (color[y] === undefined) {
            color[y] = 1 - color[x];
            queue.push(y);
          } else if (color[y] === color[x]) {
            return false;
          }
        }
      }
    }
    return true;
  }

  global.PlanarVibeMetrics = {
    computeUniformFaceAreaScore: computeUniformFaceAreaScore,
    computeUniformFaceAreaScoreFromCy: computeUniformFaceAreaScoreFromCy,
    computeUniformEdgeLengthScore: computeUniformEdgeLengthScore,
    computeUniformAngleResolutionScore: computeUniformAngleResolutionScore,
    computeUniformityScore: computeUniformityScore,
    computeDistributionQuality: computeDistributionQuality,
    hasCrossingsFromPositions: hasCrossingsFromPositions,
    isBipartiteGraph: isBipartiteGraph
  };
})(window);
