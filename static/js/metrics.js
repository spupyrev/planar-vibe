(function (global) {
  'use strict';

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

  function buildWeightedDistributionResult(rawValues, rawIdealWeights, noDataReason, degenerateReason) {
    if (!rawValues || rawValues.length === 0 || !rawIdealWeights || rawIdealWeights.length !== rawValues.length) {
      return { ok: false, reason: noDataReason };
    }

    var valueTotal = 0;
    var weightTotal = 0;
    var i;
    for (i = 0; i < rawValues.length; i += 1) {
      valueTotal += rawValues[i];
      weightTotal += rawIdealWeights[i];
    }
    if (!(valueTotal > 0) || !(weightTotal > 0)) {
      return { ok: false, reason: degenerateReason };
    }

    var pairs = [];
    for (i = 0; i < rawValues.length; i += 1) {
      var value = rawValues[i] / valueTotal;
      var ideal = rawIdealWeights[i] / weightTotal;
      if (!Number.isFinite(value) || !Number.isFinite(ideal) || !(ideal > 0)) {
        return { ok: false, reason: degenerateReason };
      }
      pairs.push({
        value: value,
        ideal: ideal
      });
    }
    pairs.sort(function (a, b) {
      if (a.ideal !== b.ideal) {
        return a.ideal - b.ideal;
      }
      return a.value - b.value;
    });

    var normalized = pairs.map(function (pair) { return pair.value; });
    var idealValues = pairs.map(function (pair) { return pair.ideal; });

    return {
      ok: true,
      values: normalized,
      ideal: idealValues.length > 0 ? (1 / idealValues.length) : null,
      idealValues: idealValues,
      quality: computeUniformityScore(normalized, idealValues)
    };
  }

  function computeQuantile(values, q) {
    if (!values || values.length === 0) {
      return null;
    }
    var qq = Number.isFinite(q) ? Math.max(0, Math.min(1, q)) : 0.2;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var idx = qq * (sorted.length - 1);
    var lo = Math.floor(idx);
    var hi = Math.ceil(idx);
    var t = idx - lo;
    if (lo === hi) {
      return sorted[lo];
    }
    return sorted[lo] * (1 - t) + sorted[hi] * t;
  }

  function collectPositiveGaps(sortedValues, range) {
    var gaps = [];
    if (!sortedValues || sortedValues.length < 2) {
      return gaps;
    }
    var minPositiveGap = Math.max(1e-12, (Number.isFinite(range) ? range : 0) * 1e-12);
    for (var i = 1; i < sortedValues.length; i += 1) {
      var gap = sortedValues[i] - sortedValues[i - 1];
      if (gap > minPositiveGap) {
        gaps.push(gap);
      }
    }
    return gaps;
  }

  function clusterSortedValues(sortedValues, tolerance) {
    if (!sortedValues || sortedValues.length === 0) {
      return [];
    }
    var eps = Number.isFinite(tolerance) ? Math.max(0, tolerance) : 0;
    var sizes = [1];
    for (var i = 1; i < sortedValues.length; i += 1) {
      var gap = sortedValues[i] - sortedValues[i - 1];
      if (gap > eps) {
        sizes.push(1);
      } else {
        sizes[sizes.length - 1] += 1;
      }
    }
    return sizes;
  }

  function computeEffectiveLineCount(clusterSizes, totalCount) {
    if (!clusterSizes || clusterSizes.length === 0 || !(totalCount > 0)) {
      return null;
    }
    var sumSq = 0;
    for (var i = 0; i < clusterSizes.length; i += 1) {
      var frac = clusterSizes[i] / totalCount;
      sumSq += frac * frac;
    }
    if (!(sumSq > 0)) {
      return null;
    }
    return 1 / sumSq;
  }

  function computeAxisClustering(values, options) {
    if (!values || values.length === 0) {
      return null;
    }
    var opts = options || {};
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var min = sorted[0];
    var max = sorted[sorted.length - 1];
    var range = max - min;
    var rawTolerance = null;
    var tolerance = 0;
    var source = 'range-zero';
    var i;

    if (range > 0) {
      if (Number.isFinite(opts.tolerance)) {
        tolerance = Math.max(0, opts.tolerance);
        rawTolerance = tolerance;
        source = 'fixed';
      } else {
        var gaps = collectPositiveGaps(sorted, range);
        var quantile = computeQuantile(gaps, opts.quantile);
        var scale = Number.isFinite(opts.toleranceScale) ? opts.toleranceScale : 2;
        var minTolerance = Number.isFinite(opts.minTolerance)
          ? Math.max(0, opts.minTolerance)
          : Math.max(1e-12, range * 1e-9);
        var capFraction = Number.isFinite(opts.toleranceCapFraction)
          ? Math.max(0, opts.toleranceCapFraction)
          : 0.05;
        var fallbackFraction = Number.isFinite(opts.fallbackToleranceFraction)
          ? Math.max(0, opts.fallbackToleranceFraction)
          : 0.01;

        if (gaps.length >= 3 && Number.isFinite(quantile)) {
          rawTolerance = scale * quantile;
          tolerance = Math.min(range * capFraction, Math.max(minTolerance, rawTolerance));
          source = 'quantile';
        } else {
          rawTolerance = range * fallbackFraction;
          tolerance = rawTolerance;
          source = 'fallback';
        }
      }
    }

    var clusterSizes = clusterSortedValues(sorted, tolerance);
    var effectiveLineCount = computeEffectiveLineCount(clusterSizes, sorted.length);
    return {
      sortedValues: sorted,
      clusterSizes: clusterSizes,
      lineCount: clusterSizes.length,
      effectiveLineCount: effectiveLineCount,
      tolerance: tolerance,
      rawTolerance: rawTolerance,
      toleranceSource: source,
      range: range
    };
  }

  function computeAxisAlignmentScore(nodeIds, posById, options) {
    if (!nodeIds || nodeIds.length === 0) {
      return { ok: false, reason: 'No nodes' };
    }

    var opts = options || {};
    var xs = [];
    var ys = [];
    var usedNodeIds = [];
    for (var i = 0; i < nodeIds.length; i += 1) {
      var id = String(nodeIds[i]);
      var p = posById[id];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        continue;
      }
      xs.push(p.x);
      ys.push(p.y);
      usedNodeIds.push(id);
    }
    if (xs.length < 2) {
      return { ok: false, reason: 'Not enough positioned nodes' };
    }

    var sharedTolerance = Number.isFinite(opts.tolerance) ? opts.tolerance : null;
    var xAxis = computeAxisClustering(xs, {
      tolerance: Number.isFinite(opts.toleranceX) ? opts.toleranceX : sharedTolerance,
      quantile: opts.quantile,
      toleranceScale: opts.toleranceScale,
      toleranceCapFraction: opts.toleranceCapFraction,
      minTolerance: opts.minToleranceX,
      fallbackToleranceFraction: opts.fallbackToleranceFraction
    });
    var yAxis = computeAxisClustering(ys, {
      tolerance: Number.isFinite(opts.toleranceY) ? opts.toleranceY : sharedTolerance,
      quantile: opts.quantile,
      toleranceScale: opts.toleranceScale,
      toleranceCapFraction: opts.toleranceCapFraction,
      minTolerance: opts.minToleranceY,
      fallbackToleranceFraction: opts.fallbackToleranceFraction
    });
    if (!xAxis || !yAxis || !Number.isFinite(xAxis.effectiveLineCount) || !Number.isFinite(yAxis.effectiveLineCount)) {
      return { ok: false, reason: 'Invalid axis clustering' };
    }

    var denom = xs.length - 1;
    var scoreX = denom > 0 ? (xs.length - xAxis.effectiveLineCount) / denom : 1;
    var scoreY = denom > 0 ? (ys.length - yAxis.effectiveLineCount) / denom : 1;
    var score = (scoreX + scoreY) / 2;

    return {
      ok: true,
      score: Math.max(0, Math.min(1, score)),
      scoreX: Math.max(0, Math.min(1, scoreX)),
      scoreY: Math.max(0, Math.min(1, scoreY)),
      usedNodeCount: xs.length,
      usedNodeIds: usedNodeIds,
      lineCountX: xAxis.lineCount,
      lineCountY: yAxis.lineCount,
      effectiveLineCountX: xAxis.effectiveLineCount,
      effectiveLineCountY: yAxis.effectiveLineCount,
      clusterSizesX: xAxis.clusterSizes,
      clusterSizesY: yAxis.clusterSizes,
      toleranceX: xAxis.tolerance,
      toleranceY: yAxis.tolerance,
      toleranceSourceX: xAxis.toleranceSource,
      toleranceSourceY: yAxis.toleranceSource
    };
  }

  function computeUniformFaceAreaScore(nodeIds, edgePairs, posById, embedding) {
    var emb = embedding;
    if (!emb || !emb.ok) {
      return { ok: false, reason: 'Planar embedding required' };
    }
    if (!emb.faces || emb.faces.length === 0) {
      return { ok: false, reason: 'No faces available' };
    }

    var outerFaceIdx = global.PlanarGraphUtils.findOuterFaceIndex(emb.faces, emb.outerFace || []);
    var areas = [];
    var idealWeights = [];
    for (var i = 0; i < emb.faces.length; i += 1) {
      var face = emb.faces[i];
      if (i === outerFaceIdx) {
        continue;
      }
      var a = global.GeometryUtils.polygonAreaAbs(face, posById);
      if (a > 0) {
        areas.push(a);
        idealWeights.push(Math.max(1, face.length - 2));
      }
    }

    if (areas.length === 0) {
      return {
        ok: true,
        values: [],
        ideal: null,
        idealValues: [],
        quality: 1,
        faceCount: 0
      };
    }

    var result = buildWeightedDistributionResult(areas, idealWeights, 'No bounded face areas available', 'Degenerate face areas');
    if (!result.ok) {
      return result;
    }
    result.faceCount = result.values.length;
    return result;
  }

  function isConvexFace(face, posById, eps) {
    if (!face || face.length < 3) {
      return false;
    }
    var sign = 0;
    for (var i = 0; i < face.length; i += 1) {
      var prev = posById[String(face[(i - 1 + face.length) % face.length])];
      var cur = posById[String(face[i])];
      var next = posById[String(face[(i + 1) % face.length])];
      if (!prev || !cur || !next ||
          !Number.isFinite(prev.x) || !Number.isFinite(prev.y) ||
          !Number.isFinite(cur.x) || !Number.isFinite(cur.y) ||
          !Number.isFinite(next.x) || !Number.isFinite(next.y)) {
        return false;
      }
      var turn = global.GeometryUtils.triangleArea2(prev, cur, next);
      if (Math.abs(turn) <= eps) {
        return false;
      }
      var currentSign = turn > 0 ? 1 : -1;
      if (sign === 0) {
        sign = currentSign;
      } else if (currentSign !== sign) {
        return false;
      }
    }
    return true;
  }

  function computeConvexityScore(nodeIds, edgePairs, posById, embedding) {
    var emb = embedding;
    if (!emb || !emb.ok) {
      return { ok: false, reason: 'Planar embedding required' };
    }
    if (!emb.faces || emb.faces.length === 0) {
      return { ok: false, reason: 'No faces available' };
    }

    var outerFaceIdx = global.PlanarGraphUtils.findOuterFaceIndex(emb.faces, emb.outerFace || []);
    var eps = Math.max(1e-12, global.GeometryUtils.computeDrawingDiameter(nodeIds || [], posById || {}) * 1e-9);
    var faceCount = 0;
    var convexFaceCount = 0;
    for (var i = 0; i < emb.faces.length; i += 1) {
      if (i === outerFaceIdx) {
        continue;
      }
      faceCount += 1;
      if (isConvexFace(emb.faces[i], posById, eps)) {
        convexFaceCount += 1;
      }
    }

    if (faceCount === 0) {
      return {
        ok: true,
        score: 1,
        convexFaceCount: 0,
        faceCount: 0
      };
    }
    return {
      ok: true,
      score: convexFaceCount / faceCount,
      convexFaceCount: convexFaceCount,
      faceCount: faceCount
    };
  }

  function computeUniformFaceAreaScoreFromCy(cy, edgePairs, embedding) {
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
    return computeUniformFaceAreaScore(nodeIds, pairs, posById, embedding);
  }

  function computeEdgeLengthRatio(edgePairs, posById) {
    if (!edgePairs || edgePairs.length === 0) {
      return { ok: false, reason: 'No edges' };
    }
    var minLen = Infinity;
    var maxLen = 0;
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
      if (!(len > 0)) {
        continue;
      }
      if (len < minLen) {
        minLen = len;
      }
      if (len > maxLen) {
        maxLen = len;
      }
    }
    if (!(maxLen > 0) || !Number.isFinite(minLen)) {
      return { ok: false, reason: 'No edge lengths available' };
    }
    return {
      ok: true,
      ratio: minLen / maxLen,
      minLength: minLen,
      maxLength: maxLen
    };
  }

  function collectPositionedPoints(nodeIds, posById) {
    var points = [];
    if (!nodeIds || nodeIds.length === 0) {
      return points;
    }
    for (var i = 0; i < nodeIds.length; i += 1) {
      var id = String(nodeIds[i]);
      var p = posById[id];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        continue;
      }
      points.push({ id: id, x: p.x, y: p.y });
    }
    return points;
  }

  function computeAspectRatioScore(nodeIds, posById) {
    var points = collectPositionedPoints(nodeIds, posById);
    if (points.length === 0) {
      return { ok: false, reason: 'No positioned nodes' };
    }

    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    for (var i = 0; i < points.length; i += 1) {
      if (points[i].x < minX) minX = points[i].x;
      if (points[i].y < minY) minY = points[i].y;
      if (points[i].x > maxX) maxX = points[i].x;
      if (points[i].y > maxY) maxY = points[i].y;
    }

    var width = maxX - minX;
    var height = maxY - minY;
    var minSide = Math.min(width, height);
    var maxSide = Math.max(width, height);
    return {
      ok: true,
      score: !(minSide > 0) ? 1 : (minSide / maxSide),
      width: width,
      height: height,
      usedNodeCount: points.length
    };
  }

  function computeNodeUniformityScore(nodeIds, posById) {
    var points = collectPositionedPoints(nodeIds, posById);
    var n = points.length;
    if (n === 0) {
      return { ok: false, reason: 'No positioned nodes' };
    }

    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    for (var i = 0; i < points.length; i += 1) {
      if (points[i].x < minX) minX = points[i].x;
      if (points[i].y < minY) minY = points[i].y;
      if (points[i].x > maxX) maxX = points[i].x;
      if (points[i].y > maxY) maxY = points[i].y;
    }

    var width = maxX - minX;
    var height = maxY - minY;
    var rows = Math.max(1, Math.floor(Math.sqrt(n)));
    var cols = Math.max(1, Math.ceil(n / rows));
    var cellCount = rows * cols;
    var counts = [];
    for (i = 0; i < cellCount; i += 1) {
      counts.push(0);
    }

    for (i = 0; i < points.length; i += 1) {
      var col = 0;
      var row = 0;
      if (width > 0) {
        col = Math.floor(((points[i].x - minX) / width) * cols);
        if (col < 0) col = 0;
        if (col >= cols) col = cols - 1;
      }
      if (height > 0) {
        row = Math.floor(((points[i].y - minY) / height) * rows);
        if (row < 0) row = 0;
        if (row >= rows) row = rows - 1;
      }
      counts[row * cols + col] += 1;
    }

    var mu = n / cellCount;
    var deviation = 0;
    for (i = 0; i < counts.length; i += 1) {
      deviation += Math.abs(counts[i] - mu);
    }
    var maxDeviation = (2 * n * (cellCount - 1)) / cellCount;

    return {
      ok: true,
      score: !(maxDeviation > 0) ? 1 : Math.max(0, Math.min(1, 1 - (deviation / maxDeviation))),
      rows: rows,
      cols: cols,
      cellCount: cellCount,
      deviation: deviation,
      maxDeviation: maxDeviation,
      counts: counts
    };
  }

  function computeEdgeLengthDeviationScore(edgePairs, posById) {
    if (!edgePairs || edgePairs.length === 0) {
      return { ok: false, reason: 'No edges' };
    }

    var lengths = [];
    var i;
    for (i = 0; i < edgePairs.length; i += 1) {
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
      if (len > 0) {
        lengths.push(len);
      }
    }

    if (lengths.length === 0) {
      return { ok: false, reason: 'No edge lengths available' };
    }

    var meanLength = 0;
    for (i = 0; i < lengths.length; i += 1) {
      meanLength += lengths[i];
    }
    meanLength /= lengths.length;

    var avgRelativeDeviation = 0;
    for (i = 0; i < lengths.length; i += 1) {
      avgRelativeDeviation += Math.abs(lengths[i] - meanLength) / meanLength;
    }
    avgRelativeDeviation /= lengths.length;

    return {
      ok: true,
      score: 1 / (1 + avgRelativeDeviation),
      meanLength: meanLength,
      avgRelativeDeviation: avgRelativeDeviation,
      usedEdgeCount: lengths.length
    };
  }

  function angleToNearestOrthogonal(angle) {
    var halfPi = Math.PI / 2;
    var wrapped = Number(angle) || 0;
    wrapped = wrapped % halfPi;
    if (wrapped < 0) {
      wrapped += halfPi;
    }
    return Math.min(wrapped, halfPi - wrapped);
  }

  function computeEdgeOrthogonalityScore(edgePairs, posById) {
    if (!edgePairs || edgePairs.length === 0) {
      return { ok: false, reason: 'No edges' };
    }

    var usedEdgeCount = 0;
    var deviationSum = 0;
    var maxDeviation = Math.PI / 4;
    for (var i = 0; i < edgePairs.length; i += 1) {
      var u = String(edgePairs[i][0]);
      var v = String(edgePairs[i][1]);
      var pu = posById[u];
      var pv = posById[v];
      if (!pu || !pv || !Number.isFinite(pu.x) || !Number.isFinite(pu.y) || !Number.isFinite(pv.x) || !Number.isFinite(pv.y)) {
        return { ok: false, reason: 'Metrics unavailable' };
      }
      var dx = pv.x - pu.x;
      var dy = pv.y - pu.y;
      var len = Math.sqrt(dx * dx + dy * dy);
      if (!(len > 0)) {
        continue;
      }
      deviationSum += angleToNearestOrthogonal(Math.atan2(dy, dx));
      usedEdgeCount += 1;
    }

    if (usedEdgeCount === 0) {
      return { ok: false, reason: 'No edge lengths available' };
    }

    var meanDeviation = deviationSum / usedEdgeCount;
    return {
      ok: true,
      score: Math.max(0, Math.min(1, 1 - (meanDeviation / maxDeviation))),
      meanDeviation: meanDeviation,
      usedEdgeCount: usedEdgeCount
    };
  }

  function computeSpacingUniformityScore(nodeIds, posById, options) {
    var opts = options || {};
    var trimQuantile = Number.isFinite(opts.boundaryTrimQuantile)
      ? Math.max(0, Math.min(0.45, opts.boundaryTrimQuantile))
      : 0.1;

    var points = [];
    if (!nodeIds || nodeIds.length === 0) {
      return { ok: false, reason: 'No nodes' };
    }
    for (var i = 0; i < nodeIds.length; i += 1) {
      var id = String(nodeIds[i]);
      var p = posById[id];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        continue;
      }
      points.push({ id: id, x: p.x, y: p.y });
    }
    if (points.length < 2) {
      return { ok: false, reason: 'Not enough positioned nodes' };
    }

    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    for (i = 0; i < points.length; i += 1) {
      if (points[i].x < minX) minX = points[i].x;
      if (points[i].y < minY) minY = points[i].y;
      if (points[i].x > maxX) maxX = points[i].x;
      if (points[i].y > maxY) maxY = points[i].y;
    }

    var kept = points.slice();
    if (trimQuantile > 0 && points.length >= 10) {
      var boundaryDist = [];
      for (i = 0; i < points.length; i += 1) {
        var d = Math.min(
          points[i].x - minX,
          maxX - points[i].x,
          points[i].y - minY,
          maxY - points[i].y
        );
        boundaryDist.push({ idx: i, d: d });
      }
      boundaryDist.sort(function (a, b) { return a.d - b.d; });
      var dropCount = Math.floor(trimQuantile * boundaryDist.length);
      var keepMask = {};
      for (i = dropCount; i < boundaryDist.length; i += 1) {
        keepMask[boundaryDist[i].idx] = true;
      }
      var trimmed = [];
      for (i = 0; i < points.length; i += 1) {
        if (keepMask[i]) {
          trimmed.push(points[i]);
        }
      }
      if (trimmed.length >= 2) {
        kept = trimmed;
      }
    }

    var nn = [];
    for (i = 0; i < kept.length; i += 1) {
      var best = Infinity;
      for (var j = 0; j < kept.length; j += 1) {
        if (i === j) continue;
        var dx = kept[i].x - kept[j].x;
        var dy = kept[i].y - kept[j].y;
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < best) best = dist;
      }
      if (Number.isFinite(best) && best > 0) {
        nn.push(best);
      }
    }
    if (nn.length < 1) {
      return { ok: false, reason: 'Not enough valid nearest-neighbor distances' };
    }

    var sum = 0;
    for (i = 0; i < nn.length; i += 1) {
      sum += nn[i];
    }
    var mean = sum / nn.length;
    if (!(mean > 0)) {
      return { ok: false, reason: 'Degenerate nearest-neighbor distances' };
    }
    var varSum = 0;
    for (i = 0; i < nn.length; i += 1) {
      var delta = nn[i] - mean;
      varSum += delta * delta;
    }
    var std = Math.sqrt(varSum / nn.length);
    var cv = std / mean;
    var score = 1 / (1 + cv);
    if (!Number.isFinite(score)) {
      return { ok: false, reason: 'Invalid spacing score' };
    }
    return {
      ok: true,
      score: Math.max(0, Math.min(1, score)),
      cv: cv,
      meanNN: mean,
      stdNN: std,
      usedNodeCount: kept.length
    };
  }

  function computeDistributionQuality(values) {
    var ideal = uniformIdealDistribution(values ? values.length : 0);
    return computeUniformityScore(values, ideal);
  }

  function computeAngularResolutionScore(graph, posById) {
    var nodeIds = graph.nodeIds;
    var adjacency = graph.adjacency;
    if (!nodeIds || nodeIds.length === 0) {
      return { ok: false, reason: 'No nodes' };
    }

    var vertexCount = 0;
    var scoreSum = 0;
    var ratios = [];
    var TWO_PI = 2 * Math.PI;
    for (var i = 0; i < nodeIds.length; i += 1) {
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
        if (a < 0) {
          a += TWO_PI;
        }
        dirs.push(a);
      }
      dirs.sort(function (a, b) { return a - b; });

      var minGap = Infinity;
      for (j = 0; j < dirs.length; j += 1) {
        var next = dirs[(j + 1) % dirs.length];
        var cur = dirs[j];
        var gap = next - cur;
        if (gap <= 0) {
          gap += TWO_PI;
        }
        if (gap < minGap) {
          minGap = gap;
        }
      }
      var idealGap = TWO_PI / dirs.length;
      var ratio = minGap / idealGap;
      scoreSum += ratio;
      ratios.push(ratio);
      vertexCount += 1;
    }

    if (vertexCount === 0) {
      return { ok: false, reason: 'No angle data' };
    }

    ratios.sort(function (a, b) { return a - b; });

    return {
      ok: true,
      score: Math.max(0, Math.min(1, scoreSum / vertexCount)),
      usedNodeCount: vertexCount,
      values: ratios
    };
  }

  function isBipartiteGraph(graph) {
    var nodeIds = graph.nodeIds;
    var edgePairs = graph.edgePairs;
    for (var i = 0; i < edgePairs.length; i += 1) {
      var u = String(edgePairs[i][0]);
      var v = String(edgePairs[i][1]);
      if (u === v) {
        return false;
      }
    }
    var adjacency = graph.adjacency;

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
    computeAspectRatioScore: computeAspectRatioScore,
    computeNodeUniformityScore: computeNodeUniformityScore,
    computeAngularResolutionScore: computeAngularResolutionScore,
    computeUniformFaceAreaScore: computeUniformFaceAreaScore,
    computeUniformFaceAreaScoreFromCy: computeUniformFaceAreaScoreFromCy,
    computeConvexityScore: computeConvexityScore,
    computeEdgeLengthDeviationScore: computeEdgeLengthDeviationScore,
    computeEdgeLengthRatio: computeEdgeLengthRatio,
    computeEdgeOrthogonalityScore: computeEdgeOrthogonalityScore,
    computeAxisAlignmentScore: computeAxisAlignmentScore,
    computeSpacingUniformityScore: computeSpacingUniformityScore,
    computeUniformityScore: computeUniformityScore,
    computeDistributionQuality: computeDistributionQuality,
    isBipartiteGraph: isBipartiteGraph
  };
})(window);
