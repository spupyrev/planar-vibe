(function (global) {
  'use strict';

  var GraphUtils = global.GraphUtils;
  var Metrics = global.PlanarVibeMetrics;

  function copyPositions(posById) {
    var out = {};
    var ids = Object.keys(posById || {});
    for (var i = 0; i < ids.length; i += 1) {
      var id = ids[i];
      var p = posById[id];
      out[id] = { x: p.x, y: p.y };
    }
    return out;
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

  function computeAxisTolerance(values, options) {
    if (!values || values.length < 2) {
      return 0;
    }
    var opts = options || {};
    if (Number.isFinite(opts.tolerance)) {
      return Math.max(0, opts.tolerance);
    }
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var range = sorted[sorted.length - 1] - sorted[0];
    if (!(range > 0)) {
      return 0;
    }

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
      return Math.min(range * capFraction, Math.max(minTolerance, scale * quantile));
    }
    return range * fallbackFraction;
  }

  function buildAxisGroups(nodeIds, posById, axis, tolerance) {
    var entries = [];
    var i;
    for (i = 0; i < nodeIds.length; i += 1) {
      var id = String(nodeIds[i]);
      var p = posById[id];
      entries.push({
        id: id,
        coord: p[axis]
      });
    }
    entries.sort(function (a, b) { return a.coord - b.coord; });

    if (entries.length === 0) {
      return [];
    }

    var eps = Number.isFinite(tolerance) ? Math.max(0, tolerance) : 0;
    var groups = [];
    var current = {
      ids: [entries[0].id],
      coord: entries[0].coord,
      minCoord: entries[0].coord,
      maxCoord: entries[0].coord,
      totalCoord: entries[0].coord
    };

    for (i = 1; i < entries.length; i += 1) {
      var entry = entries[i];
      var prev = entries[i - 1];
      if (entry.coord - prev.coord <= eps) {
        current.ids.push(entry.id);
        current.maxCoord = entry.coord;
        current.totalCoord += entry.coord;
        current.coord = current.totalCoord / current.ids.length;
      } else {
        groups.push(current);
        current = {
          ids: [entry.id],
          coord: entry.coord,
          minCoord: entry.coord,
          maxCoord: entry.coord,
          totalCoord: entry.coord
        };
      }
    }
    groups.push(current);
    return groups;
  }

  function tryMergeGroups(groups, index, axis, posById, edgePairs) {
    var left = groups[index];
    var right = groups[index + 1];
    var mergedCoord = ((left.coord * left.ids.length) + (right.coord * right.ids.length)) / (left.ids.length + right.ids.length);
    var affectedIds = left.ids.concat(right.ids);
    var oldCoords = {};
    for (var i = 0; i < affectedIds.length; i += 1) {
      var id = affectedIds[i];
      oldCoords[id] = posById[id][axis];
      posById[id][axis] = mergedCoord;
    }

    if (global.GeometryUtils.hasPositionCrossings(posById, edgePairs)) {
      for (i = 0; i < affectedIds.length; i += 1) {
        id = affectedIds[i];
        posById[id][axis] = oldCoords[id];
      }
      return null;
    }

    return {
      ids: affectedIds,
      coord: mergedCoord,
      minCoord: mergedCoord,
      maxCoord: mergedCoord,
      totalCoord: mergedCoord * affectedIds.length
    };
  }

  function greedyAxisSweep(nodeIds, edgePairs, posById, axis, groupTolerance, mergeTolerance) {
    var groups = buildAxisGroups(nodeIds, posById, axis, groupTolerance);
    var mergedCount = 0;
    var i = 0;

    while (i < groups.length - 1) {
      var gap = groups[i + 1].minCoord - groups[i].maxCoord;
      if (!(gap <= mergeTolerance)) {
        i += 1;
        continue;
      }

      var merged = tryMergeGroups(groups, i, axis, posById, edgePairs);
      if (!merged) {
        i += 1;
        continue;
      }

      groups.splice(i, 2, merged);
      mergedCount += 1;
    }

    return {
      mergedCount: mergedCount,
      groupCount: groups.length,
      tolerance: mergeTolerance,
      baseTolerance: groupTolerance
    };
  }

  function alignToAxisGreedy(nodeIds, edgePairs, posById, options) {
    if (!global.GeometryUtils || typeof global.GeometryUtils.hasPositionCrossings !== 'function') {
      return { ok: false, reason: 'Geometry utilities are missing' };
    }
    if (!nodeIds || nodeIds.length < 2) {
      return { ok: false, reason: 'Not enough nodes' };
    }

    var i;
    for (i = 0; i < nodeIds.length; i += 1) {
      var id = String(nodeIds[i]);
      var p = posById && posById[id];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        return { ok: false, reason: 'Not enough positioned nodes' };
      }
    }
    if (global.GeometryUtils.hasPositionCrossings(posById, edgePairs)) {
      return { ok: false, reason: 'Drawing is not plane' };
    }

    var opts = options || {};
    var working = copyPositions(posById);
    var scoreEps = 1e-12;
    var scoreBeforeResult = Metrics && typeof Metrics.computeAxisAlignmentScore === 'function'
      ? Metrics.computeAxisAlignmentScore(nodeIds, working)
      : null;
    var scoreBefore = scoreBeforeResult && scoreBeforeResult.ok ? scoreBeforeResult.score : null;
    var currentScore = scoreBefore;

    var xs = [];
    var ys = [];
    for (i = 0; i < nodeIds.length; i += 1) {
      id = String(nodeIds[i]);
      xs.push(working[id].x);
      ys.push(working[id].y);
    }

    var xBaseTolerance = computeAxisTolerance(xs, {
      tolerance: opts.toleranceX,
      quantile: opts.quantile,
      toleranceScale: opts.toleranceScale,
      toleranceCapFraction: opts.toleranceCapFraction,
      minTolerance: opts.minToleranceX,
      fallbackToleranceFraction: opts.fallbackToleranceFraction
    });
    var yBaseTolerance = computeAxisTolerance(ys, {
      tolerance: opts.toleranceY,
      quantile: opts.quantile,
      toleranceScale: opts.toleranceScale,
      toleranceCapFraction: opts.toleranceCapFraction,
      minTolerance: opts.minToleranceY,
      fallbackToleranceFraction: opts.fallbackToleranceFraction
    });
    var mergeToleranceScale = Number.isFinite(opts.mergeToleranceScale)
      ? Math.max(1, opts.mergeToleranceScale)
      : 1.5;
    var xMergeTolerance = Number.isFinite(opts.mergeToleranceX)
      ? Math.max(0, opts.mergeToleranceX)
      : xBaseTolerance * mergeToleranceScale;
    var yMergeTolerance = Number.isFinite(opts.mergeToleranceY)
      ? Math.max(0, opts.mergeToleranceY)
      : yBaseTolerance * mergeToleranceScale;

    var xTrial = copyPositions(working);
    var xTrialResult = greedyAxisSweep(
      nodeIds,
      edgePairs,
      xTrial,
      'x',
      xBaseTolerance,
      xMergeTolerance
    );
    var xScoreResult = Metrics && typeof Metrics.computeAxisAlignmentScore === 'function'
      ? Metrics.computeAxisAlignmentScore(nodeIds, xTrial)
      : null;
    var xScore = xScoreResult && xScoreResult.ok ? xScoreResult.score : null;
    var xResult = {
      mergedCount: 0,
      groupCount: null,
      tolerance: xMergeTolerance,
      baseTolerance: xBaseTolerance
    };
    if (currentScore === null || xScore === null || xScore + scoreEps >= currentScore) {
      working = xTrial;
      currentScore = xScore;
      xResult = xTrialResult;
    }

    var yTrial = copyPositions(working);
    var yTrialResult = greedyAxisSweep(
      nodeIds,
      edgePairs,
      yTrial,
      'y',
      yBaseTolerance,
      yMergeTolerance
    );
    var yScoreResult = Metrics && typeof Metrics.computeAxisAlignmentScore === 'function'
      ? Metrics.computeAxisAlignmentScore(nodeIds, yTrial)
      : null;
    var yScore = yScoreResult && yScoreResult.ok ? yScoreResult.score : null;
    var yResult = {
      mergedCount: 0,
      groupCount: null,
      tolerance: yMergeTolerance,
      baseTolerance: yBaseTolerance
    };
    if (currentScore === null || yScore === null || yScore + scoreEps >= currentScore) {
      working = yTrial;
      currentScore = yScore;
      yResult = yTrialResult;
    }

    var scoreAfter = Metrics && typeof Metrics.computeAxisAlignmentScore === 'function'
      ? Metrics.computeAxisAlignmentScore(nodeIds, working)
      : null;

    return {
      ok: true,
      positions: working,
      changed: xResult.mergedCount + yResult.mergedCount > 0,
      mergedCountX: xResult.mergedCount,
      mergedCountY: yResult.mergedCount,
      toleranceX: xResult.tolerance,
      toleranceY: yResult.tolerance,
      baseToleranceX: xResult.baseTolerance,
      baseToleranceY: yResult.baseTolerance,
      scoreBefore: scoreBefore,
      scoreAfter: scoreAfter && scoreAfter.ok ? scoreAfter.score : null
    };
  }

  global.PlanarVibeAlignment = {
    alignToAxisGreedy: alignToAxisGreedy
  };
})(window);
