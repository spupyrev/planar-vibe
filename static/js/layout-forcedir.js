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
  var segmentsIntersectOrTouch = GeometryUtils.segmentsIntersectOrTouch;
  var FORCE_DIR_CONFIG = {
    evalEvery: 10,
    alpha: 1.2,
    initialStepFactor: 0.02,
    minStepFactor: 1e-5,
    minItersBeforeStop: 30,
    stableIterLimit: 8,
    movementStopTolFactor: 1e-4,
    avgMovementStopTolFactor: 2e-5,
    epsilon: 1e-9,
    repulsionEps: 1e-6,
    repulsionPower: 2,
    maxIters: 400,
    beta: 0.45,
    alphaGrowEvery: 120,
    alphaGrowFactor: 1.15,
    alphaCap: 4.0,
    stepDecay: 0.5,
    maxForce: 9.0,
    eta: 1.2,
    zeta: 3.2,
    collisionBoost: 6.0,
    kNearest: 4
  };

  function wouldIntroduceCrossing(vertexId, newPos, positions, edgePairs, adjacency, eps) {
    var v = String(vertexId);
    var changed = adjacency[v] || [];
    for (var i = 0; i < changed.length; i += 1) {
      var other = String(changed[i]);
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
    return arr.length % 2 === 1 ? arr[mid] : 0.5 * (arr[mid - 1] + arr[mid]);
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
      }
      candidates.sort(function (a, b) { return a.dist - b.dist; });
      if (candidates.length > 0) {
        nnById[v] = candidates[0];
        if (candidates[0].dist > 1e-12) {
          sum += candidates[0].dist;
          cnt += 1;
        }
      }
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

      if (wouldIntroduceCrossing(vId, candidate, state.pos, state.edgePairs, state.adjOrig, state.EPS)) {
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
    return buildLayoutResult({
      nodeIds: state.nodeIds,
      edgePairs: state.edgePairs,
      outerFace: state.outerFace,
      graph: state.graph,
      augmented: context.augmented,
      positions: state.bestPos || state.pos,
      stopReason: state.stopReason,
      iters: state.performedIters,
      accepted: state.acceptedTotal,
      rejected: state.rejectedTotal,
      spacingScore: Number.isFinite(state.bestScore) ? state.bestScore : null
    });
  }

  function updateForceDirBestScore(state, evalEvery) {
    if (!(state.performedIters % evalEvery === 0 || state.performedIters === 1 || state.performedIters === state.maxIters)) {
      return;
    }
    var q = evaluateSpacingQuality(state.nodeIds, state.edgePairs, state.pos);
    if (Number.isFinite(q) && q > state.bestScore) {
      state.bestScore = q;
      state.bestPos = copyPositions(state.pos);
    }
  }

  function runForceDirIterations(state, context, options) {
    var evalEvery = FORCE_DIR_CONFIG.evalEvery;
    var onIteration = options.onIteration;
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
    var runtime = options || {};
    var alpha0 = FORCE_DIR_CONFIG.alpha;
    var graph = context.graph;
    var ids = graph.nodeIds.slice();
    var pairs = graph.edgePairs.slice();
    if (pairs.length < 3) {
      return buildLayoutError({ message: 'ForceDir requires at least 3 edges', graph: graph });
    }

    var outerFace = context.outerFace;
    var pos = context.posById;
    var movable = collectMovableVertices(ids, outerFace);

    var lengths = [];
    for (var i = 0; i < pairs.length; i += 1) {
      var u = String(pairs[i][0]);
      var v = String(pairs[i][1]);
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
    var h = Math.max(1e-8, FORCE_DIR_CONFIG.initialStepFactor * diameter);
    var hMin = Math.max(1e-10, FORCE_DIR_CONFIG.minStepFactor * diameter);
    var movementTracker = createMovementConvergenceTracker({
      minItersBeforeStop: FORCE_DIR_CONFIG.minItersBeforeStop,
      stableIterLimit: FORCE_DIR_CONFIG.stableIterLimit,
      maxMoveTol: FORCE_DIR_CONFIG.movementStopTolFactor * diameter,
      avgMoveTol: FORCE_DIR_CONFIG.avgMovementStopTolFactor * diameter
    });

    var state = {
      EPS: FORCE_DIR_CONFIG.epsilon,
      repEps: FORCE_DIR_CONFIG.repulsionEps,
      repPower: FORCE_DIR_CONFIG.repulsionPower,
      maxIters: FORCE_DIR_CONFIG.maxIters,
      beta: FORCE_DIR_CONFIG.beta,
      alpha: alpha0,
      alphaGrowEvery: FORCE_DIR_CONFIG.alphaGrowEvery,
      alphaGrowFactor: FORCE_DIR_CONFIG.alphaGrowFactor,
      alphaCap: FORCE_DIR_CONFIG.alphaCap,
      gamma: FORCE_DIR_CONFIG.stepDecay,
      maxForce: FORCE_DIR_CONFIG.maxForce,
      eta: FORCE_DIR_CONFIG.eta,
      zeta: FORCE_DIR_CONFIG.zeta,
      collisionBoost: FORCE_DIR_CONFIG.collisionBoost,
      kNearest: FORCE_DIR_CONFIG.kNearest,
      graph: graph,
      nodeIds: ids,
      edgePairs: pairs,
      outerFace: outerFace,
      pos: pos,
      adjOrig: graph.adjacency,
      movable: movable,
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
      onIteration: typeof runtime.onIteration === 'function' ? runtime.onIteration : null,
      movementTracker: movementTracker
    });
  }

  function prepareGraphData(graph, options) {
    var runtime = options || {};
    return LayoutPreprocessing.prepareGraphAndLayoutData(graph, {
      failureLabel: 'ForceDir',
      augmentationMethod: runtime.augmentationMethod || null,
      currentPositions: runtime.currentPositions
    });
  }

  function computePositions(graph, layoutInput) {
    if (!layoutInput.ok) {
      return buildLayoutError(layoutInput);
    }
    return computeForceDirPositionsFromPrepared(layoutInput, null);
  }

  function computeForceDirPositions(graph, options) {
    var context = prepareGraphData(graph, options);
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
	    prepareGraphData: prepareGraphData,
	    computePositions: computePositions,
	    applyLayout: applyForceDirLayout
	  };
})(window);
