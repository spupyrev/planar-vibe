(function (global) {
  'use strict';

  var Metrics = global.PlanarVibeMetrics;
  var LayoutPreprocessing = global.LayoutPreprocessing;
  var CyRuntime = global.CyRuntime;
  var GeometryUtils = global.GeometryUtils;
  var buildLayoutError = global.GraphUtils.buildLayoutError;
  var buildLayoutResult = global.GraphUtils.buildLayoutResult;
  var buildLayoutStatusMessage = global.GraphUtils.buildLayoutStatusMessage;
  var collectMovableVertices = global.GraphUtils.collectMovableVertices;
  var computeDrawingDiameter = GeometryUtils.computeDrawingDiameter;
  var hasPositionCrossings = GeometryUtils.hasPositionCrossings;
  var computePositionMoveStats = global.GraphUtils.computePositionMoveStats;
  var copyPositions = GeometryUtils.copyPositionMap;
  var createMovementConvergenceTracker = global.GraphUtils.createMovementConvergenceTracker;
  var resolveFloatOption = global.GraphUtils.resolveFloatOption;
  var resolveFunctionOption = global.GraphUtils.resolveFunctionOption;
  var resolveIntOption = global.GraphUtils.resolveIntOption;
  var resolveNonNegativeOption = global.GraphUtils.resolveNonNegativeOption;
  var segmentsIntersectOrTouch = GeometryUtils.segmentsIntersectOrTouch;

  function wouldIntroduceCrossing(vertexId, newPos, positions, edgePairs, incidentEdges, eps) {
    var v = String(vertexId);
    var changed = incidentEdges[v] || [];
    if (changed.length === 0) {
      return false;
    }

    for (var i = 0; i < changed.length; i += 1) {
      var e = changed[i];
      var u = String(e[0]);
      var w = String(e[1]);
      var other = u === v ? w : u;
      var p1 = newPos;
      var q1 = positions[other];
      if (!q1) {
        continue;
      }

      for (var j = 0; j < edgePairs.length; j += 1) {
        var a = String(edgePairs[j][0]);
        var b = String(edgePairs[j][1]);
        if (a === v || b === v || a === other || b === other) {
          continue;
        }
        var p2 = positions[a];
        var q2 = positions[b];
        if (!p2 || !q2) {
          continue;
        }
        if (segmentsIntersectOrTouch(p1, q1, p2, q2, eps)) {
          return true;
        }
      }
    }
    return false;
  }

  function median(values) {
    if (!values || values.length === 0) {
      return 1;
    }
    var arr = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(arr.length / 2);
    if (arr.length % 2 === 1) {
      return arr[mid];
    }
    return 0.5 * (arr[mid - 1] + arr[mid]);
  }

  function computeNearestNeighborData(nodeIds, pos, kNearest) {
    var nnById = {};
    var knearestById = {};
    var sum = 0;
    var cnt = 0;
    var sumK = 0;
    var cntK = 0;
    var k = Number.isFinite(kNearest) ? Math.max(1, Math.floor(kNearest)) : 3;
    for (var i = 0; i < nodeIds.length; i += 1) {
      var v = String(nodeIds[i]);
      var pv = pos[v];
      if (!pv) {
        continue;
      }
      var bestId = null;
      var bestDist = Infinity;
      var candidates = [];
      for (var j = 0; j < nodeIds.length; j += 1) {
        if (i === j) continue;
        var u = String(nodeIds[j]);
        var pu = pos[u];
        if (!pu) {
          continue;
        }
        var dx = pv.x - pu.x;
        var dy = pv.y - pu.y;
        var d = Math.sqrt(dx * dx + dy * dy);
        candidates.push({ id: u, dist: d });
        if (d < bestDist) {
          bestDist = d;
          bestId = u;
        }
      }
      if (bestId !== null && Number.isFinite(bestDist)) {
        nnById[v] = { id: bestId, dist: bestDist };
        if (bestDist > 1e-12) {
          sum += bestDist;
          cnt += 1;
        }
      }
      candidates.sort(function (a, b) { return a.dist - b.dist; });
      var localK = [];
      var kk = Math.min(k, candidates.length);
      for (var c = 0; c < kk; c += 1) {
        localK.push(candidates[c]);
        if (candidates[c].dist > 1e-12) {
          sumK += candidates[c].dist;
          cntK += 1;
        }
      }
      knearestById[v] = localK;
    }
    return {
      nnById: nnById,
      meanDist: cnt > 0 ? (sum / cnt) : 0,
      knearestById: knearestById,
      meanKDist: cntK > 0 ? (sumK / cntK) : 0
    };
  }

  function evaluateSpacingQuality(nodeIds, edgePairs, pos) {
    if (!Metrics || typeof Metrics.computeSpacingUniformityScore !== 'function') {
      return null;
    }
    if (hasPositionCrossings(pos, edgePairs)) {
      return null;
    }
    var score = Metrics.computeSpacingUniformityScore(nodeIds, pos);
    if (!score || !score.ok || !Number.isFinite(score.score)) {
      return null;
    }
    return score.score;
  }

  function runForceDirIteration(state, iter) {
    state.performedIters = iter;
    var accepted = 0;
    var rejected = 0;
    var uniformityBoost = 1 + 2.0 * (iter / Math.max(1, state.maxIters));
    var nnData = computeNearestNeighborData(state.nodeIds, state.pos, state.kNearest);
    var nnById = nnData.nnById;
    var meanNnDist = nnData.meanDist;
    var knearestById = nnData.knearestById;
    var meanKDist = nnData.meanKDist;
    var scaleLen = Math.max(state.targetLength, 1e-6);

    for (var m = 0; m < state.movable.length; m += 1) {
      var vId = state.movable[m];
      var pv0 = state.pos[vId];
      if (!pv0) continue;

      var fx = 0;
      var fy = 0;

      var ngh = state.adjOrig[vId] || [];
      for (var ni = 0; ni < ngh.length; ni += 1) {
        var uId = String(ngh[ni]);
        var pu0 = state.pos[uId];
        if (!pu0) continue;
        var rdx = pv0.x - pu0.x;
        var rdy = pv0.y - pu0.y;
        var rlen = Math.sqrt(rdx * rdx + rdy * rdy);
        if (rlen < 1e-12) continue;
        var coeffS = 2 * (rlen - state.targetLength) / (rlen + state.repEps);
        fx += -state.beta * (coeffS * rdx);
        fy += -state.beta * (coeffS * rdy);
      }

      for (var j = 0; j < state.nodeIds.length; j += 1) {
        var oId = String(state.nodeIds[j]);
        if (oId === vId) continue;
        var po = state.pos[oId];
        if (!po) continue;
        var dx = pv0.x - po.x;
        var dy = pv0.y - po.y;
        var dxn = dx / scaleLen;
        var dyn = dy / scaleLen;
        var d2 = dxn * dxn + dyn * dyn;
        if (d2 < 1e-18) continue;
        var denom = Math.pow(d2 + state.repEps, (state.repPower / 2) + 1);
        var coeffR = state.repPower / denom;
        fx += state.alpha * coeffR * dxn;
        fy += state.alpha * coeffR * dyn;
      }

      if (state.eta > 0 && meanNnDist > 1e-9 && nnById[vId]) {
        var nn = nnById[vId];
        var pn = state.pos[nn.id];
        if (pn && nn.dist > 1e-12) {
          var vx = pv0.x - pn.x;
          var vy = pv0.y - pn.y;
          var inv = 1 / nn.dist;
          var ux = vx * inv;
          var uy = vy * inv;
          var delta = meanNnDist - nn.dist;
          var deltaCap = 0.8 * meanNnDist;
          if (delta > deltaCap) delta = deltaCap;
          if (delta < -deltaCap) delta = -deltaCap;
          fx += (state.eta * uniformityBoost) * delta * ux;
          fy += (state.eta * uniformityBoost) * delta * uy;
        }
      }

      if (state.zeta > 0 && meanKDist > 1e-9 && knearestById[vId] && knearestById[vId].length > 0) {
        var knn = knearestById[vId];
        for (var ki = 0; ki < knn.length; ki += 1) {
          var kn = knn[ki];
          var pk = state.pos[kn.id];
          if (!pk || !(kn.dist > 1e-12)) {
            continue;
          }
          var kvx = pv0.x - pk.x;
          var kvy = pv0.y - pk.y;
          var kinv = 1 / kn.dist;
          var kux = kvx * kinv;
          var kuy = kvy * kinv;
          var kdelta = meanKDist - kn.dist;
          var kcap = 0.7 * meanKDist;
          if (kdelta > kcap) kdelta = kcap;
          if (kdelta < -kcap) kdelta = -kcap;
          fx += (state.zeta * uniformityBoost) * kdelta * kux;
          fy += (state.zeta * uniformityBoost) * kdelta * kuy;
        }
      }

      if (state.collisionBoost > 0 && meanNnDist > 1e-9 && knearestById[vId]) {
        var threshold = 0.75 * meanNnDist;
        var knn2 = knearestById[vId];
        for (var kb = 0; kb < knn2.length; kb += 1) {
          var nbr = knn2[kb];
          if (!(nbr.dist > 1e-12) || nbr.dist >= threshold) {
            continue;
          }
          var pnb = state.pos[nbr.id];
          if (!pnb) continue;
          var bdx = pv0.x - pnb.x;
          var bdy = pv0.y - pnb.y;
          var binv = 1 / nbr.dist;
          var bux = bdx * binv;
          var buy = bdy * binv;
          var strength = (state.collisionBoost * uniformityBoost) * ((threshold - nbr.dist) / Math.max(threshold, 1e-9));
          fx += strength * bux;
          fy += strength * buy;
        }
      }

      var fNorm = Math.sqrt(fx * fx + fy * fy);
      if (fNorm > state.maxForce) {
        var s = state.maxForce / fNorm;
        fx *= s;
        fy *= s;
      }

      var candidate = {
        x: pv0.x + state.h * fx,
        y: pv0.y + state.h * fy
      };

      if (wouldIntroduceCrossing(vId, candidate, state.pos, state.edgePairs, state.incidentEdges, state.EPS)) {
        rejected += 1;
        continue;
      }

      state.pos[vId] = candidate;
      accepted += 1;
    }

    state.acceptedTotal += accepted;
    state.rejectedTotal += rejected;
    return { accepted: accepted, rejected: rejected };
  }

  function buildForceDirResult(state, context) {
    var finalPos = state.bestPos || state.pos;
    return buildLayoutResult({
      ok: true,
      nodeIds: state.nodeIds,
      edgePairs: state.edgePairs,
      outerFace: state.outerFace,
      graph: state.graph,
      augmented: context.augmented,
      positions: finalPos,
      stopReason: state.stopReason,
      iters: state.performedIters,
      accepted: state.acceptedTotal,
      rejected: state.rejectedTotal,
      spacingScore: Number.isFinite(state.bestScore) ? state.bestScore : null
    });
  }

  function updateForceDirBestScore(state, evalEvery) {
    var iter = state.performedIters;
    if (!(iter % evalEvery === 0 || iter === 1 || iter === state.maxIters)) {
      return;
    }
    var q = evaluateSpacingQuality(state.nodeIds, state.edgePairs, state.pos);
    if (Number.isFinite(q) && q > state.bestScore) {
      state.bestScore = q;
      state.bestPos = copyPositions(state.pos);
    }
  }

  function runForceDirIterations(state, context, options) {
    var evalEvery = resolveIntOption(options.evalEvery, 10, 1);
    var onIteration = resolveFunctionOption(options.onIteration, null);
    var movementTracker = options.movementTracker;
    var movable = state.movable;

    function runStep(iter) {
      if (state.h < state.hMin) {
        state.stopReason = 'step-too-small';
        return { done: true, progress: null };
      }

      var prevPos = copyPositions(state.pos);
      var step = runForceDirIteration(state, iter);
      var accepted = step.accepted;
      var rejected = step.rejected;
      var moveStats = computePositionMoveStats(movable, prevPos, state.pos, { moveTol: 1e-9 });
      var movementStatus = movementTracker.update({
        maxMove: moveStats.maxMove,
        avgMove: moveStats.avgMove
      }, iter);

      if (movable.length > 0 && rejected > movable.length * 0.5) {
        state.h *= state.gamma;
      }
      if (movementStatus.converged) {
        state.stopReason = movementStatus.reason || 'movement-converged';
        return { done: true, progress: null };
      }
      if (iter % state.alphaGrowEvery === 0 && state.alpha < state.alphaCap) {
        state.alpha = Math.min(state.alphaCap, state.alpha * state.alphaGrowFactor);
      }

      updateForceDirBestScore(state, evalEvery);

      return {
        done: false,
        progress: onIteration ? {
          iter: iter,
          maxIters: state.maxIters,
          positions: state.pos,
          debug: {
            step: state.h,
            alpha: state.alpha,
            accepted: accepted,
            rejected: rejected,
            spacingScore: Number.isFinite(state.bestScore) ? state.bestScore : null
          }
        } : null
      };
    }

    if (!onIteration) {
      for (var iter = 1; iter <= state.maxIters; iter += 1) {
        if (runStep(iter).done) {
          break;
        }
      }
      return buildForceDirResult(state, context);
    }

    return (async function () {
      for (var iter = 1; iter <= state.maxIters; iter += 1) {
        var step = runStep(iter);
        if (step.done) {
          break;
        }
        await onIteration(step.progress);
      }
      return buildForceDirResult(state, context);
    })();
  }

  function computeForceDirPositionsFromPrepared(context, options) {
    var EPS = resolveFloatOption(options.epsilon, 1e-9, 1e-12);
    var repEps = resolveFloatOption(options.repulsionEps, 1e-6, 1e-12);
    var repPower = resolveFloatOption(options.repulsionPower, 2, 1);
    var maxIters = resolveIntOption(options.maxIters, 400, 1);
    var beta = resolveFloatOption(options.beta, 0.45, 0);
    var alpha0 = resolveFloatOption(options.alpha, 1.2, 0);
    var alpha = alpha0;
    var alphaGrowEvery = resolveIntOption(options.alphaGrowEvery, 120, 1);
    var alphaGrowFactor = resolveFloatOption(options.alphaGrowFactor, 1.15, 1);
    var alphaCap = resolveFloatOption(options.alphaCap, 4.0, alpha0);
    var gamma = resolveFloatOption(options.stepDecay, 0.5, 0.1, 0.95);
    var maxForce = resolveFloatOption(options.maxForce, 9.0, 1e-6);
    var eta = resolveFloatOption(options.eta, 1.2, 0);
    var zeta = resolveFloatOption(options.zeta, 3.2, 0);
    var collisionBoost = resolveFloatOption(options.collisionBoost, 6.0, 0);
    var kNearest = resolveIntOption(options.kNearest, 4, 1);
    var evalEvery = resolveIntOption(options.evalEvery, 10, 1);
    var onIteration = resolveFunctionOption(options.onIteration, null);

    var graph = context.graph;
    var ids = graph.nodeIds.slice();
    var pairs = graph.edgePairs.slice();
    if (pairs.length < 3) {
      return buildLayoutError({ message: 'ForceDir requires at least 3 edges', graph: graph });
    }

    var outerFace = context.outerFace;
    var pos = context.posById;
    var adjOrig = graph.adjacency;
    var movable = collectMovableVertices(ids, outerFace);

    var i;

    var incidentEdges = {};
    for (i = 0; i < ids.length; i += 1) {
      incidentEdges[String(ids[i])] = [];
    }
    for (i = 0; i < pairs.length; i += 1) {
      var u = String(pairs[i][0]);
      var v = String(pairs[i][1]);
      incidentEdges[u].push([u, v]);
      incidentEdges[v].push([u, v]);
    }

    var lengths = [];
    for (i = 0; i < pairs.length; i += 1) {
      u = String(pairs[i][0]);
      v = String(pairs[i][1]);
      var pu = pos[u];
      var pv = pos[v];
      if (!pu || !pv) continue;
      var dx0 = pu.x - pv.x;
      var dy0 = pu.y - pv.y;
      var len0 = Math.sqrt(dx0 * dx0 + dy0 * dy0);
      if (len0 > 1e-9) lengths.push(len0);
    }
    var targetLength = median(lengths);
    var diameter = computeDrawingDiameter(ids, pos);
    var h = resolveFloatOption(options.initialStep, 0.02 * diameter, 1e-8);
    var hMin = resolveFloatOption(options.minStep, 1e-5 * diameter, 1e-10);
    var movementTracker = createMovementConvergenceTracker({
      minItersBeforeStop: resolveIntOption(options.minItersBeforeStop, 30, 1),
      stableIterLimit: resolveIntOption(options.stableIterLimit, 8, 1),
      maxMoveTol: resolveNonNegativeOption(options.movementStopTol, 1e-4 * diameter),
      avgMoveTol: resolveNonNegativeOption(options.avgMovementStopTol, 2e-5 * diameter)
    });

    var state = {
      EPS: EPS,
      repEps: repEps,
      repPower: repPower,
      maxIters: maxIters,
      beta: beta,
      alpha: alpha0,
      alphaGrowEvery: alphaGrowEvery,
      alphaGrowFactor: alphaGrowFactor,
      alphaCap: alphaCap,
      gamma: gamma,
      maxForce: maxForce,
      eta: eta,
      zeta: zeta,
      collisionBoost: collisionBoost,
      kNearest: kNearest,
      graph: graph,
      nodeIds: ids,
      edgePairs: pairs,
      outerFace: outerFace,
      pos: pos,
      adjOrig: adjOrig,
      movable: movable,
      incidentEdges: incidentEdges,
      targetLength: targetLength,
      h: h,
      hMin: hMin,
      acceptedTotal: 0,
      rejectedTotal: 0,
      performedIters: 0,
      bestScore: -Infinity,
      bestPos: null,
      stopReason: 'max-iters'
    };

    return runForceDirIterations(state, context, {
      evalEvery: evalEvery,
      onIteration: onIteration,
      movementTracker: movementTracker
    });
  }

  function computeForceDirPositions(graph, options) {
    var context = LayoutPreprocessing.prepareGraphAndLayoutData(graph, {
      failureLabel: 'ForceDir',
      augmentationMethod: options.augmentationMethod || null,
      currentPositions: options.currentPositions
    });
    if (!context || !context.ok) {
      return buildLayoutError(context || { message: 'ForceDir setup failed' });
    }
    return computeForceDirPositionsFromPrepared(context, options);
  }

  function applyForceDirLayout(cy, options) {
    return CyRuntime.runLayout(cy, options, {
      prepareMode: 'graph+layout',
      prepareFailureLabel: 'ForceDir layout',
      initialFitBounds: function (ctx) {
        return CyRuntime.computePositionBounds(ctx.prepared.posById);
      },
      computePositions: function (_graph, computeOptions, prepared) {
        return computeForceDirPositionsFromPrepared(prepared, computeOptions || {});
      },
      buildResult: function (ctx) {
        var result = ctx.result;
        return {
          ok: true,
          stopReason: result.stopReason,
          message: buildLayoutStatusMessage('ForceDir', {
            iters: result.iters,
            accepted: result.accepted,
            rejected: result.rejected,
            stopReason: result.stopReason
          }),
          debugState: LayoutPreprocessing.createAugmentationDebugState(
            result.graph,
            result.augmented,
            result.positions
          )
        };
      },
      failureMessage: 'ForceDir failed'
    });
  }

  global.PlanarVibeForceDir = {
    computeForceDirPositions: computeForceDirPositions,
    applyForceDirLayout: applyForceDirLayout
  };
})(window);
