(function (global) {
  'use strict';

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

  function computeUniformFaceAreaScore(nodeIds, edgePairs, posById) {
    var emb = global.PlanarGraphUtils.extractEmbeddingFromPositions(nodeIds, edgePairs, posById);
    if (!emb || !emb.ok) {
      return { ok: false, reason: 'Drawing does not determine a plane embedding' };
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
      if (a > 1e-12) {
        areas.push(a);
        idealWeights.push(Math.max(1, face.length - 2));
      }
    }

    var result = buildWeightedDistributionResult(areas, idealWeights, 'No bounded face areas available', 'Degenerate face areas');
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
      if (!(len > 1e-12)) {
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

  function wrapAngleToPi(angle) {
    var wrapped = Number(angle) || 0;
    var PI = Math.PI;
    var TWO_PI = 2 * PI;
    wrapped = wrapped % TWO_PI;
    if (wrapped <= -PI) {
      wrapped += TWO_PI;
    } else if (wrapped > PI) {
      wrapped -= TWO_PI;
    }
    return wrapped;
  }

  function angleToNearestHorizontal(angle) {
    var wrapped = wrapAngleToPi(angle);
    var absAngle = Math.abs(wrapped);
    return Math.min(absAngle, Math.abs(Math.PI - absAngle));
  }

  function computeGenericEdgeHorizontalityScore(edgePairs, posById, options) {
    if (!edgePairs || edgePairs.length === 0) {
      return { ok: false, reason: 'No edges' };
    }
    var opts = options || {};
    var useLengthWeights = opts.useLengthWeights === true;
    var angleOffset = Number.isFinite(opts.angleOffset) ? opts.angleOffset : 0;
    var totalWeight = 0;
    var weightedPenalty = 0;
    var usedEdgeCount = 0;
    var maxDeviation = Math.PI / 2;
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
      if (!(len > 1e-12)) {
        continue;
      }
      var deviation = angleToNearestHorizontal(Math.atan2(dy, dx) + angleOffset);
      var normalizedDeviation = deviation / maxDeviation;
      var weight = useLengthWeights ? len : 1;
      totalWeight += weight;
      weightedPenalty += weight * normalizedDeviation * normalizedDeviation;
      usedEdgeCount += 1;
    }
    if (!(totalWeight > 0) || usedEdgeCount === 0) {
      return { ok: false, reason: 'No edge lengths available' };
    }
    var meanPenalty = weightedPenalty / totalWeight;
    return {
      ok: true,
      score: Math.max(0, Math.min(1, 1 - meanPenalty)),
      penalty: Math.max(0, meanPenalty),
      weightedPenalty: weightedPenalty,
      totalWeight: totalWeight,
      usedEdgeCount: usedEdgeCount,
      weighting: useLengthWeights ? 'length' : 'uniform'
    };
  }

  function computeUnweightedEdgeHorizontalityScore(edgePairs, posById, options) {
    var opts = Object.assign({}, options || {}, { useLengthWeights: false });
    return computeGenericEdgeHorizontalityScore(edgePairs, posById, opts);
  }

  function computeWeightedEdgeHorizontalityScore(edgePairs, posById, options) {
    var opts = Object.assign({}, options || {}, { useLengthWeights: true });
    return computeGenericEdgeHorizontalityScore(edgePairs, posById, opts);
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
      if (Number.isFinite(best) && best > 1e-12) {
        nn.push(best);
      }
    }
    if (nn.length < 2) {
      return { ok: false, reason: 'Not enough valid nearest-neighbor distances' };
    }

    var sum = 0;
    for (i = 0; i < nn.length; i += 1) {
      sum += nn[i];
    }
    var mean = sum / nn.length;
    if (!(mean > 1e-12)) {
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

  function computeUniformAngleResolutionScore(graph, posById) {
    var nodeIds = graph.nodeIds;
    var edgePairs = graph.edgePairs;
    if (!nodeIds || nodeIds.length === 0) {
      return { ok: false, reason: 'No nodes' };
    }
    if (!edgePairs || edgePairs.length === 0) {
      return { ok: false, reason: 'No edges' };
    }
    var emb = global.PlanarGraphUtils.extractEmbeddingFromPositions(nodeIds, edgePairs, posById);
    if (!emb || !emb.ok) {
      return { ok: false, reason: 'Drawing does not determine a plane embedding' };
    }

    var adjacency = graph.adjacency;
    var i;

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
    computeUniformFaceAreaScore: computeUniformFaceAreaScore,
    computeUniformFaceAreaScoreFromCy: computeUniformFaceAreaScoreFromCy,
    computeUniformEdgeLengthScore: computeUniformEdgeLengthScore,
    computeEdgeLengthRatio: computeEdgeLengthRatio,
    computeUnweightedEdgeHorizontalityScore: computeUnweightedEdgeHorizontalityScore,
    computeWeightedEdgeHorizontalityScore: computeWeightedEdgeHorizontalityScore,
    computeAxisAlignmentScore: computeAxisAlignmentScore,
    computeSpacingUniformityScore: computeSpacingUniformityScore,
    computeUniformAngleResolutionScore: computeUniformAngleResolutionScore,
    computeUniformityScore: computeUniformityScore,
    computeDistributionQuality: computeDistributionQuality,
    isBipartiteGraph: isBipartiteGraph
  };
})(window);
