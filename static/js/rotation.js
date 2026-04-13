(function (global) {
  'use strict';

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

  function normalizeRotationAngle(angle) {
    var period = Math.PI;
    var normalized = Number(angle) || 0;
    normalized = normalized % period;
    if (normalized < 0) {
      normalized += period;
    }
    return normalized;
  }

  function canonicalizeRotationAngle(angle) {
    var normalized = normalizeRotationAngle(angle);
    if (normalized >= Math.PI / 2) {
      normalized -= Math.PI;
    }
    return normalized;
  }

  function buildExactHorizontalCandidateAngles(edgePairs, posById) {
    var candidates = [];
    var seen = {};
    for (var i = 0; i < edgePairs.length; i += 1) {
      var u = String(edgePairs[i][0]);
      var v = String(edgePairs[i][1]);
      var pu = posById[u];
      var pv = posById[v];
      if (!pu || !pv || !Number.isFinite(pu.x) || !Number.isFinite(pu.y) || !Number.isFinite(pv.x) || !Number.isFinite(pv.y)) {
        continue;
      }
      var dx = pv.x - pu.x;
      var dy = pv.y - pu.y;
      if (!(Math.hypot(dx, dy) > 1e-12)) {
        continue;
      }
      var angle = canonicalizeRotationAngle(-Math.atan2(dy, dx));
      var key = angle.toFixed(12);
      if (!seen[key]) {
        seen[key] = true;
        candidates.push(angle);
      }
    }
    return candidates;
  }

  function isBetterTrial(trial, angle, bestResult, bestAngle) {
    if (!trial || !trial.ok || !Number.isFinite(trial.score)) {
      return false;
    }
    return (
      trial.score > bestResult.score + 1e-12 ||
      (Math.abs(trial.score - bestResult.score) <= 1e-12 && trial.matchedWeight1 > bestResult.matchedWeight1 + 1e-12) ||
      (Math.abs(trial.score - bestResult.score) <= 1e-12 && Math.abs(trial.matchedWeight1 - bestResult.matchedWeight1) <= 1e-12 && trial.matchedWeight3 > bestResult.matchedWeight3 + 1e-12) ||
      (Math.abs(trial.score - bestResult.score) <= 1e-12 && Math.abs(trial.matchedWeight1 - bestResult.matchedWeight1) <= 1e-12 && Math.abs(trial.matchedWeight3 - bestResult.matchedWeight3) <= 1e-12 && trial.matchedWeight5 > bestResult.matchedWeight5 + 1e-12) ||
      (Math.abs(trial.score - bestResult.score) <= 1e-12 && Math.abs(trial.matchedWeight1 - bestResult.matchedWeight1) <= 1e-12 && Math.abs(trial.matchedWeight3 - bestResult.matchedWeight3) <= 1e-12 && Math.abs(trial.matchedWeight5 - bestResult.matchedWeight5) <= 1e-12 && Math.abs(canonicalizeRotationAngle(angle)) < Math.abs(canonicalizeRotationAngle(bestAngle)))
    );
  }

  function computeWeightedNearHorizontalScore(edgePairs, posById, options) {
    if (!edgePairs || edgePairs.length === 0) {
      return { ok: false, reason: 'No edges' };
    }
    var opts = options || {};
    var angleOffset = Number.isFinite(opts.angleOffset) ? opts.angleOffset : 0;
    var thresholdDeg1 = Number.isFinite(opts.thresholdDeg1) ? Math.max(0, opts.thresholdDeg1) : 1;
    var thresholdDeg3 = Number.isFinite(opts.thresholdDeg3) ? Math.max(thresholdDeg1, opts.thresholdDeg3) : 3;
    var thresholdDeg5 = Number.isFinite(opts.thresholdDeg5) ? Math.max(thresholdDeg3, opts.thresholdDeg5) : 5;
    var thresholdRad1 = thresholdDeg1 * Math.PI / 180;
    var thresholdRad3 = thresholdDeg3 * Math.PI / 180;
    var thresholdRad5 = thresholdDeg5 * Math.PI / 180;
    var totalWeight = 0;
    var weightedMatch = 0;
    var matchedWeight0 = 0;
    var matchedWeight1 = 0;
    var matchedWeight3 = 0;
    var matchedWeight5 = 0;
    var matchedCount0 = 0;
    var matchedCount1 = 0;
    var matchedCount3 = 0;
    var matchedCount5 = 0;
    var usedEdgeCount = 0;
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
      totalWeight += len;
      usedEdgeCount += 1;
      if (deviation <= 1e-12) {
        matchedWeight0 += len;
        matchedCount0 += 1;
      }
      if (deviation <= thresholdRad1 + 1e-12) {
        matchedWeight1 += len;
        matchedWeight3 += len;
        matchedWeight5 += len;
        matchedCount1 += 1;
        matchedCount3 += 1;
        matchedCount5 += 1;
      } else if (deviation <= thresholdRad3 + 1e-12) {
        matchedWeight3 += len;
        matchedWeight5 += len;
        matchedCount3 += 1;
        matchedCount5 += 1;
      } else if (deviation <= thresholdRad5 + 1e-12) {
        matchedWeight5 += len;
        matchedCount5 += 1;
      }
      if (deviation <= 1e-12) {
        weightedMatch += len;
      } else if (deviation <= thresholdRad5 + 1e-12) {
        var t = deviation / Math.max(thresholdRad5, 1e-12);
        var c = Math.cos(0.5 * Math.PI * t);
        weightedMatch += 0.5 * len * c * c;
      }
    }
    if (!(totalWeight > 0) || usedEdgeCount === 0) {
      return { ok: false, reason: 'No edge lengths available' };
    }
    return {
      ok: true,
      score: weightedMatch / totalWeight,
      weightedMatch: weightedMatch,
      totalWeight: totalWeight,
      matchedWeight0: matchedWeight0,
      matchedWeight1: matchedWeight1,
      matchedWeight3: matchedWeight3,
      matchedWeight5: matchedWeight5,
      matchedCount0: matchedCount0,
      matchedCount1: matchedCount1,
      matchedCount3: matchedCount3,
      matchedCount5: matchedCount5,
      usedEdgeCount: usedEdgeCount,
      thresholdDeg1: thresholdDeg1,
      thresholdDeg3: thresholdDeg3,
      thresholdDeg5: thresholdDeg5
    };
  }

  function computeOptimalWeightedEdgeRotation(edgePairs, posById, options) {
    if (!edgePairs || edgePairs.length === 0) {
      return { ok: false, reason: 'No edges' };
    }
    var opts = options || {};
    var thresholdDeg1 = Number.isFinite(opts.thresholdDeg1) ? Math.max(0, opts.thresholdDeg1) : 1;
    var thresholdDeg3 = Number.isFinite(opts.thresholdDeg3) ? Math.max(thresholdDeg1, opts.thresholdDeg3) : 3;
    var thresholdDeg5 = Number.isFinite(opts.thresholdDeg5) ? Math.max(thresholdDeg3, opts.thresholdDeg5) : 5;

    var baseline = computeWeightedNearHorizontalScore(edgePairs, posById, {
      angleOffset: 0,
      thresholdDeg1: thresholdDeg1,
      thresholdDeg3: thresholdDeg3,
      thresholdDeg5: thresholdDeg5
    });
    if (!baseline || !baseline.ok) {
      return baseline || { ok: false, reason: 'No edges' };
    }

    var samples = Number.isFinite(opts.samples) ? Math.max(36, Math.floor(opts.samples)) : 720;
    var bestAngle = 0;
    var bestResult = baseline;
    var i;

    for (i = 0; i < samples; i += 1) {
      var angle = (Math.PI * i) / samples;
      var trial = computeWeightedNearHorizontalScore(edgePairs, posById, {
        angleOffset: angle,
        thresholdDeg1: thresholdDeg1,
        thresholdDeg3: thresholdDeg3,
        thresholdDeg5: thresholdDeg5
      });
      if (isBetterTrial(trial, angle, bestResult, bestAngle)) {
        bestAngle = angle;
        bestResult = trial;
      }
    }

    var exactCandidates = buildExactHorizontalCandidateAngles(edgePairs, posById);
    for (i = 0; i < exactCandidates.length; i += 1) {
      var exactAngle = exactCandidates[i];
      trial = computeWeightedNearHorizontalScore(edgePairs, posById, {
        angleOffset: exactAngle,
        thresholdDeg1: thresholdDeg1,
        thresholdDeg3: thresholdDeg3,
        thresholdDeg5: thresholdDeg5
      });
      if (isBetterTrial(trial, exactAngle, bestResult, bestAngle)) {
        bestAngle = exactAngle;
        bestResult = trial;
      }
    }

    var step = Math.PI / samples;
    for (i = 0; i < 24; i += 1) {
      var improved = false;
      var leftAngle = normalizeRotationAngle(bestAngle - step);
      var rightAngle = normalizeRotationAngle(bestAngle + step);
      var left = computeWeightedNearHorizontalScore(edgePairs, posById, {
        angleOffset: leftAngle,
        thresholdDeg1: thresholdDeg1,
        thresholdDeg3: thresholdDeg3,
        thresholdDeg5: thresholdDeg5
      });
      var right = computeWeightedNearHorizontalScore(edgePairs, posById, {
        angleOffset: rightAngle,
        thresholdDeg1: thresholdDeg1,
        thresholdDeg3: thresholdDeg3,
        thresholdDeg5: thresholdDeg5
      });
      if (isBetterTrial(left, leftAngle, bestResult, bestAngle)) {
        bestAngle = leftAngle;
        bestResult = left;
        improved = true;
      }
      if (isBetterTrial(right, rightAngle, bestResult, bestAngle)) {
        bestAngle = rightAngle;
        bestResult = right;
        improved = true;
      }
      if (!improved) {
        step *= 0.5;
      }
      if (!(step > 1e-8)) {
        break;
      }
    }

    bestAngle = canonicalizeRotationAngle(bestAngle);

    return {
      ok: true,
      angle: bestAngle,
      scoreBefore: baseline.score,
      scoreAfter: bestResult.score,
      matchedCountBefore0: baseline.matchedCount0,
      matchedCountAfter0: bestResult.matchedCount0,
      matchedCountBefore1: baseline.matchedCount1,
      matchedCountAfter1: bestResult.matchedCount1,
      matchedCountBefore3: baseline.matchedCount3,
      matchedCountAfter3: bestResult.matchedCount3,
      matchedCountBefore5: baseline.matchedCount5,
      matchedCountAfter5: bestResult.matchedCount5,
      thresholdDeg1: thresholdDeg1,
      thresholdDeg3: thresholdDeg3,
      thresholdDeg5: thresholdDeg5,
      improved: bestResult.score > baseline.score + 1e-12 ||
        bestResult.matchedWeight1 > baseline.matchedWeight1 + 1e-12 ||
        bestResult.matchedWeight3 > baseline.matchedWeight3 + 1e-12 ||
        bestResult.matchedWeight5 > baseline.matchedWeight5 + 1e-12
    };
  }

  global.PlanarVibeRotation = {
    computeOptimalWeightedEdgeRotation: computeOptimalWeightedEdgeRotation
  };
})(window);
