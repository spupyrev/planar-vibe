(function (global) {
  'use strict';

  var GraphUtils = global.GraphUtils;
  var Metrics = global.PlanarVibeMetrics;
  var GeometryUtils = global.GeometryUtils;

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
    var gaps = GeometryUtils.collectPositiveGaps(sorted, range);
    var quantile = GeometryUtils.computeQuantile(gaps, opts.quantile);
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

  function buildCrossingContext(edgePairs) {
    var edges = [];
    var incidentEdgeIndexesByNode = {};
    for (var i = 0; i < edgePairs.length; i += 1) {
      var edge = {
        u: String(edgePairs[i][0]),
        v: String(edgePairs[i][1])
      };
      edges.push(edge);
      if (!incidentEdgeIndexesByNode[edge.u]) {
        incidentEdgeIndexesByNode[edge.u] = [];
      }
      if (!incidentEdgeIndexesByNode[edge.v]) {
        incidentEdgeIndexesByNode[edge.v] = [];
      }
      incidentEdgeIndexesByNode[edge.u].push(i);
      incidentEdgeIndexesByNode[edge.v].push(i);
    }
    return {
      edges: edges,
      incidentEdgeIndexesByNode: incidentEdgeIndexesByNode
    };
  }

  function boxesOverlap(a, b, c, d, eps) {
    return (
      Math.min(a.x, b.x) - eps <= Math.max(c.x, d.x) &&
      Math.min(c.x, d.x) - eps <= Math.max(a.x, b.x) &&
      Math.min(a.y, b.y) - eps <= Math.max(c.y, d.y) &&
      Math.min(c.y, d.y) - eps <= Math.max(a.y, b.y)
    );
  }

  function edgesShareEndpoint(a, b) {
    return a.u === b.u || a.u === b.v || a.v === b.u || a.v === b.v;
  }

  function collectAffectedEdgeIndexes(context, affectedSet, affectedIds) {
    var affectedEdgeIndexes = [];
    var affectedEdgeFlags = {};
    for (var i = 0; i < affectedIds.length; i += 1) {
      var id = String(affectedIds[i]);
      affectedSet[id] = true;
      var incident = context.incidentEdgeIndexesByNode[id] || [];
      for (var j = 0; j < incident.length; j += 1) {
        var edgeIndex = incident[j];
        if (!affectedEdgeFlags[edgeIndex]) {
          affectedEdgeFlags[edgeIndex] = true;
          affectedEdgeIndexes.push(edgeIndex);
        }
      }
    }
    return affectedEdgeIndexes;
  }

  function hasLocalPositionCrossings(context, nodeIds, posById, affectedIds) {
    var EPS = 1e-9;
    var affectedSet = {};
    var affectedEdgeIndexes = collectAffectedEdgeIndexes(context, affectedSet, affectedIds);
    var edges = context.edges;
    var i;
    var j;

    for (i = 0; i < affectedEdgeIndexes.length; i += 1) {
      var affectedEdge = edges[affectedEdgeIndexes[i]];
      var affectedU = posById[affectedEdge.u];
      var affectedV = posById[affectedEdge.v];
      if (!affectedU || !affectedV) {
        continue;
      }

      for (j = 0; j < edges.length; j += 1) {
        if (j === affectedEdgeIndexes[i]) {
          continue;
        }
        var otherEdge = edges[j];
        if (edgesShareEndpoint(affectedEdge, otherEdge)) {
          continue;
        }
        var otherU = posById[otherEdge.u];
        var otherV = posById[otherEdge.v];
        if (!otherU || !otherV || !boxesOverlap(affectedU, affectedV, otherU, otherV, EPS)) {
          continue;
        }
        if (global.GeometryUtils.segmentsIntersectOrTouch(affectedU, affectedV, otherU, otherV, EPS)) {
          return true;
        }
      }
    }

    for (i = 0; i < affectedIds.length; i += 1) {
      var affectedId = String(affectedIds[i]);
      var affectedPos = posById[affectedId];
      if (!affectedPos || !Number.isFinite(affectedPos.x) || !Number.isFinite(affectedPos.y)) {
        continue;
      }
      for (j = 0; j < edges.length; j += 1) {
        var edge = edges[j];
        if (affectedId === edge.u || affectedId === edge.v) {
          continue;
        }
        var edgeU = posById[edge.u];
        var edgeV = posById[edge.v];
        if (!edgeU || !edgeV) {
          continue;
        }
        if (global.GeometryUtils.pointOnSegmentInterior(edgeU, edgeV, affectedPos, EPS)) {
          return true;
        }
      }
    }

    for (i = 0; i < nodeIds.length; i += 1) {
      var nodeId = String(nodeIds[i]);
      if (affectedSet[nodeId]) {
        continue;
      }
      var nodePos = posById[nodeId];
      if (!nodePos || !Number.isFinite(nodePos.x) || !Number.isFinite(nodePos.y)) {
        continue;
      }
      for (j = 0; j < affectedEdgeIndexes.length; j += 1) {
        edge = edges[affectedEdgeIndexes[j]];
        if (nodeId === edge.u || nodeId === edge.v) {
          continue;
        }
        edgeU = posById[edge.u];
        edgeV = posById[edge.v];
        if (!edgeU || !edgeV) {
          continue;
        }
        if (global.GeometryUtils.pointOnSegmentInterior(edgeU, edgeV, nodePos, EPS)) {
          return true;
        }
      }
    }

    return false;
  }

  function tryMergeGroups(groups, index, axis, nodeIds, posById, crossingContext) {
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

    if (hasLocalPositionCrossings(crossingContext, nodeIds, posById, affectedIds)) {
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

  function greedyAxisSweep(nodeIds, posById, crossingContext, axis, groupTolerance, mergeTolerance) {
    var groups = buildAxisGroups(nodeIds, posById, axis, groupTolerance);
    var mergedCount = 0;
    var i = 0;

    while (i < groups.length - 1) {
      var gap = groups[i + 1].minCoord - groups[i].maxCoord;
      if (!(gap <= mergeTolerance)) {
        i += 1;
        continue;
      }

      var merged = tryMergeGroups(groups, i, axis, nodeIds, posById, crossingContext);
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
    var crossingContext = buildCrossingContext(edgePairs);

    var opts = options || {};
    var working = GeometryUtils.copyPositionMap(posById);
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

    var xTrial = GeometryUtils.copyPositionMap(working);
    var xTrialResult = greedyAxisSweep(
      nodeIds,
      xTrial,
      crossingContext,
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

    var yTrial = GeometryUtils.copyPositionMap(working);
    var yTrialResult = greedyAxisSweep(
      nodeIds,
      yTrial,
      crossingContext,
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
