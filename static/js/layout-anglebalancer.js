(function (global) {
  'use strict';

  var LayoutPreprocessing = global.LayoutPreprocessing;
  var CyRuntime = global.CyRuntime;
  var Metrics = global.PlanarVibeMetrics;
  var GeometryUtils = global.GeometryUtils;
  var GraphUtils = global.GraphUtils;
  var buildLayoutError = GraphUtils.buildLayoutError;
  var buildLayoutResult = GraphUtils.buildLayoutResult;
  var buildLayoutStatusMessage = GraphUtils.buildLayoutStatusMessage;
  var computePositionMoveStats = GraphUtils.computePositionMoveStats;
  var createMovementConvergenceTracker = GraphUtils.createMovementConvergenceTracker;
  var resolveFloatOption = GraphUtils.resolveFloatOption;
  var resolveFunctionOption = GraphUtils.resolveFunctionOption;
  var resolveIntOption = GraphUtils.resolveIntOption;
  var resolveNonNegativeOption = GraphUtils.resolveNonNegativeOption;
  var computeDrawingDiameter = GeometryUtils.computeDrawingDiameter;
  var copyPositionMap = GeometryUtils.copyPositionMap;
  var filterPositionMap = GeometryUtils.filterPositionMap;
  var hasPositionCrossings = GeometryUtils.hasPositionCrossings;
  var orientFaceCCW = GeometryUtils.orientFaceCCW;
  var polygonArea2 = GeometryUtils.polygonArea2;
  var pointAdd = GeometryUtils.pointAdd;
  var pointNorm = GeometryUtils.pointNorm;
  var pointScale = GeometryUtils.pointScale;

  function fillAngleSettings(options) {
    if (options.augmentationMethod === undefined) {
      options.augmentationMethod = null;
    }
    options.augmentationOptions = typeof options.augmentationOptions === 'object' && options.augmentationOptions
      ? Object.assign({}, options.augmentationOptions)
      : null;
    options.maxSweeps = resolveIntOption(options.maxSweeps, 1, 1);
    options.initialStepScale = resolveFloatOption(options.initialStepScale, 0.35, 1e-6);
    options.minStepScale = resolveFloatOption(options.minStepScale, 1e-4, 1e-9);
    options.armijo = resolveFloatOption(options.armijo, 1e-4, 0);
    options.fdStepScale = resolveFloatOption(options.fdStepScale, 1e-4, 1e-8);
    options.fdStepMin = resolveFloatOption(options.fdStepMin, 1e-6, 1e-12);
    options.gradTol = resolveFloatOption(options.gradTol, 1e-7, 0);
    options.angleSoftminBeta = resolveFloatOption(options.angleSoftminBeta, 80, 1e-3);
    options.faceBarrierWeight = resolveFloatOption(options.faceBarrierWeight, 0.2, 0);
    options.minItersBeforeStop = resolveIntOption(options.minItersBeforeStop, 10, 1);
    options.stableIterLimit = resolveIntOption(options.stableIterLimit, 5, 1);
    options.movementStopTol = resolveNonNegativeOption(options.movementStopTol, 1e-5);
    options.avgMovementStopTol = resolveNonNegativeOption(options.avgMovementStopTol, 2e-6);
    options.onIteration = resolveFunctionOption(options.onIteration, null);
  }

  function buildAngleState(graph, outerFace, posById, movableVertices, barrierData) {
    return {
      graph: graph,
      outerFace: outerFace.slice().map(String),
      posById: filterPositionMap(posById, graph.nodeIds),
      movableVertices: movableVertices.slice().map(String),
      barrierData: barrierData || null
    };
  }

  function buildFaceBarrierData(context) {
    var augmented = context && context.augmented;
    var embedding = augmented && augmented.embedding;
    var initPos = context && context.posById;
    var outerFace = context && context.augmentedOuterFace;
    if (!embedding || !embedding.ok || !initPos || !Array.isArray(embedding.faces)) {
      return null;
    }
    var outerKey = GraphUtils.faceKey(outerFace);
    var faces = [];
    var incidentFacesByVertex = {};
    var initialMinFaceArea = Infinity;
    for (var i = 0; i < embedding.faces.length; i += 1) {
      var orientedFace = orientFaceCCW(embedding.faces[i], initPos);
      if (GraphUtils.faceKey(orientedFace) === outerKey) {
        continue;
      }
      var area = Math.abs(polygonArea2(orientedFace, initPos)) / 2;
      if (!(area > 1e-12)) {
        continue;
      }
      if (area < initialMinFaceArea) {
        initialMinFaceArea = area;
      }
      var faceIndex = faces.length;
      faces.push(orientedFace.slice().map(String));
      for (var j = 0; j < orientedFace.length; j += 1) {
        var id = String(orientedFace[j]);
        if (!incidentFacesByVertex[id]) {
          incidentFacesByVertex[id] = [];
        }
        incidentFacesByVertex[id].push(faceIndex);
      }
    }
    return {
      faces: faces,
      incidentFacesByVertex: incidentFacesByVertex,
      faceScale: 1,
      minFaceArea: Number.isFinite(initialMinFaceArea) ? Math.max(0, 0.25 * initialMinFaceArea) : 0
    };
  }

  function buildOrderedNeighborAngles(vertexId, graph, posById) {
    var neighbors = graph.adjacency[String(vertexId)] || [];
    if (neighbors.length < 2) {
      return [];
    }
    var p = posById[String(vertexId)];
    var ordered = [];
    for (var i = 0; i < neighbors.length; i += 1) {
      var neighborId = String(neighbors[i]);
      var q = posById[neighborId];
      if (!p || !q || !Number.isFinite(q.x) || !Number.isFinite(q.y)) {
        continue;
      }
      var theta = Math.atan2(q.y - p.y, q.x - p.x);
      if (theta < 0) {
        theta += 2 * Math.PI;
      }
      ordered.push({
        neighborId: neighborId,
        theta: theta
      });
    }
    ordered.sort(function (a, b) { return a.theta - b.theta; });
    return ordered;
  }

  function computeLocalAngleObjective(vertexId, graph, posById, options) {
    var ordered = buildOrderedNeighborAngles(vertexId, graph, posById);
    if (ordered.length < 2) {
      return 0;
    }
    var gaps = [];
    var i;
    for (i = 0; i < ordered.length; i += 1) {
      var nextTheta = ordered[(i + 1) % ordered.length].theta;
      var curTheta = ordered[i].theta;
      var gap = nextTheta - curTheta;
      if (gap <= 0) {
        gap += 2 * Math.PI;
      }
      gaps.push(gap);
    }

    var considered = gaps.slice();
    if (considered.length === 0) {
      return 0;
    }
    var beta = options.angleSoftminBeta;
    var minGap = Infinity;
    for (i = 0; i < considered.length; i += 1) {
      if (considered[i] < minGap) {
        minGap = considered[i];
      }
    }
    if (!(minGap > 0) || !Number.isFinite(minGap)) {
      return 0;
    }
    var expSum = 0;
    for (i = 0; i < considered.length; i += 1) {
      expSum += Math.exp(-beta * (considered[i] - minGap));
    }
    if (!(expSum > 0) || !Number.isFinite(expSum)) {
      return 0;
    }
    return minGap - (Math.log(expSum) / beta);
  }

  function computeLocalMinGap(vertexId, graph, posById) {
    var ordered = buildOrderedNeighborAngles(vertexId, graph, posById);
    if (ordered.length < 2) {
      return 0;
    }
    var minGap = Infinity;
    for (var i = 0; i < ordered.length; i += 1) {
      var nextTheta = ordered[(i + 1) % ordered.length].theta;
      var curTheta = ordered[i].theta;
      var gap = nextTheta - curTheta;
      if (gap <= 0) {
        gap += 2 * Math.PI;
      }
      if (gap < minGap) {
        minGap = gap;
      }
    }
    if (!(minGap > 0) || !Number.isFinite(minGap)) {
      return 0;
    }
    return minGap;
  }

  function collectAffectedVertices(vertexId, graph) {
    var out = [String(vertexId)];
    var seen = new Set(out);
    var neighbors = graph.adjacency[String(vertexId)] || [];
    for (var i = 0; i < neighbors.length; i += 1) {
      var neighborId = String(neighbors[i]);
      if (!seen.has(neighborId)) {
        seen.add(neighborId);
        out.push(neighborId);
      }
    }
    return out;
  }

  function computeAffectedObjective(vertexId, graph, posById, options) {
    var affected = collectAffectedVertices(vertexId, graph);
    var objective = 0;
    for (var i = 0; i < affected.length; i += 1) {
      objective += computeLocalAngleObjective(affected[i], graph, posById, options);
    }
    return {
      objective: objective,
      affected: affected
    };
  }

  function computeFaceBarrierForVertex(vertexId, barrierData, posById, options) {
    if (!barrierData || !(options.faceBarrierWeight > 0)) {
      return 0;
    }
    var incident = barrierData.incidentFacesByVertex[String(vertexId)] || [];
    if (!(incident.length > 0)) {
      return 0;
    }
    var value = 0;
    for (var i = 0; i < incident.length; i += 1) {
      var face = barrierData.faces[incident[i]];
      var area = Math.abs(polygonArea2(face, posById)) / 2;
      if (!(area > barrierData.minFaceArea)) {
        return -Infinity;
      }
      value += options.faceBarrierWeight * Math.log(area / barrierData.faceScale);
    }
    return value;
  }

  function computeAffectedMinGapStats(vertexId, graph, posById) {
    var affected = collectAffectedVertices(vertexId, graph);
    var movedId = String(vertexId);
    var movedMinGap = 0;
    var minGapSum = 0;
    for (var i = 0; i < affected.length; i += 1) {
      var currentId = affected[i];
      var minGap = computeLocalMinGap(currentId, graph, posById);
      minGapSum += minGap;
      if (currentId === movedId) {
        movedMinGap = minGap;
      }
    }
    return {
      affected: affected,
      movedMinGap: movedMinGap,
      minGapSum: minGapSum
    };
  }

  function averageIncidentEdgeLength(vertexId, graph, posById) {
    var neighbors = graph.adjacency[String(vertexId)] || [];
    var p = posById[String(vertexId)];
    var sum = 0;
    var count = 0;
    for (var i = 0; i < neighbors.length; i += 1) {
      var q = posById[String(neighbors[i])];
      if (!p || !q) {
        continue;
      }
      var len = Math.hypot(q.x - p.x, q.y - p.y);
      if (Number.isFinite(len) && len > 1e-12) {
        sum += len;
        count += 1;
      }
    }
    return count > 0 ? (sum / count) : 1;
  }

  function computeFiniteDifferenceGradient(vertexId, graph, posById, options, barrierData) {
    var base = computeAffectedObjective(vertexId, graph, posById, options).objective +
      computeFaceBarrierForVertex(vertexId, barrierData, posById, options);
    var localScale = averageIncidentEdgeLength(vertexId, graph, posById);
    var h = Math.max(options.fdStepMin, options.fdStepScale * localScale);
    var original = posById[String(vertexId)];
    var gradX;
    var gradY;

    posById[String(vertexId)] = { x: original.x + h, y: original.y };
    var plusX = computeAffectedObjective(vertexId, graph, posById, options).objective +
      computeFaceBarrierForVertex(vertexId, barrierData, posById, options);
    posById[String(vertexId)] = { x: original.x - h, y: original.y };
    var minusX = computeAffectedObjective(vertexId, graph, posById, options).objective +
      computeFaceBarrierForVertex(vertexId, barrierData, posById, options);
    gradX = (plusX - minusX) / (2 * h);

    posById[String(vertexId)] = { x: original.x, y: original.y + h };
    var plusY = computeAffectedObjective(vertexId, graph, posById, options).objective +
      computeFaceBarrierForVertex(vertexId, barrierData, posById, options);
    posById[String(vertexId)] = { x: original.x, y: original.y - h };
    var minusY = computeAffectedObjective(vertexId, graph, posById, options).objective +
      computeFaceBarrierForVertex(vertexId, barrierData, posById, options);
    gradY = (plusY - minusY) / (2 * h);

    posById[String(vertexId)] = original;
    return {
      objective: base,
      gradient: { x: gradX, y: gradY },
      localScale: localScale
    };
  }

  function computeAngleStats(graph, posById) {
    var angle = Metrics.computeUniformAngleResolutionScore(graph, posById);
    return {
      angleResolutionScore: angle && angle.ok ? angle.score : null,
      angleCount: angle && angle.ok ? angle.angleCount : null
    };
  }

  async function computeAngleBalancerPositions(graph, options) {
    fillAngleSettings(options);
    var context = LayoutPreprocessing.prepareGraphAndLayoutData(graph, {
      failureLabel: 'AngleBalancer layout',
      augmentationMethod: options.augmentationMethod,
      augmentationOptions: options.augmentationOptions,
      currentPositions: options.currentPositions
    });
    if (!context || !context.ok) {
      return buildLayoutError(context || { message: 'AngleBalancer setup failed' });
    }

    var g = context.graph;
    var outerFace = context.outerFace;
    var posById = filterPositionMap(context.posById, g.nodeIds);
    var barrierData = buildFaceBarrierData(context);
    var originalNodeSet = new Set(g.nodeIds.map(String));
    var movableVertices = [];
    for (var mi = 0; mi < context.movableVertices.length; mi += 1) {
      var movableId = String(context.movableVertices[mi]);
      if (originalNodeSet.has(movableId)) {
        movableVertices.push(movableId);
      }
    }
    var state = buildAngleState(g, outerFace, posById, movableVertices, barrierData);
    if (state.movableVertices.length === 0) {
      var staticStats = computeAngleStats(g, state.posById);
      return buildLayoutResult({
        ok: true,
        nodeIds: g.nodeIds,
        edgePairs: g.edgePairs,
        outerFace: outerFace,
        graph: g,
        augmented: context.augmented,
        positions: state.posById,
        debugPositions: context.posById,
        stopReason: 'no-movable-vertices',
        iters: 0,
        objective: null,
        angleResolutionScore: staticStats.angleResolutionScore,
        angleCount: staticStats.angleCount
      });
    }

    var drawingDiameter = computeDrawingDiameter(g.nodeIds, state.posById);
    var movementTracker = createMovementConvergenceTracker({
      minItersBeforeStop: options.minItersBeforeStop,
      stableIterLimit: options.stableIterLimit,
      maxMoveTol: options.movementStopTol * drawingDiameter,
      avgMoveTol: options.avgMovementStopTol * drawingDiameter
    });

    var stopReason = 'max_sweeps';
    var iterationCount = 0;
    var lastObjective = 0;
    for (var sweep = 1; sweep <= options.maxSweeps; sweep += 1) {
      iterationCount = sweep;
      var prevPos = copyPositionMap(state.posById);
      var accepted = 0;
      var rejected = 0;
      var objectiveSum = 0;
      var gradNormMax = 0;
      var bestMove = null;

      for (var vi = 0; vi < state.movableVertices.length; vi += 1) {
        var vertexId = state.movableVertices[vi];
        var local = computeFiniteDifferenceGradient(vertexId, g, state.posById, options, state.barrierData);
        var gradNorm = pointNorm(local.gradient);
        if (gradNorm > gradNormMax) {
          gradNormMax = gradNorm;
        }
        objectiveSum += local.objective;
        if (!(gradNorm > options.gradTol)) {
          continue;
        }

        var direction = pointScale(1 / gradNorm, local.gradient);
        var step = options.initialStepScale * local.localScale;
        var minStep = options.minStepScale * local.localScale;
        var baseMinGapStats = computeAffectedMinGapStats(vertexId, g, state.posById);
        var baseFaceBarrier = computeFaceBarrierForVertex(vertexId, state.barrierData, state.posById, options);
        var original = state.posById[String(vertexId)];
        var acceptedMove = null;

        while (step >= minStep) {
          var candidate = pointAdd(original, pointScale(step, direction));
          state.posById[String(vertexId)] = candidate;
          var candidateMinGapStats = computeAffectedMinGapStats(vertexId, g, state.posById);
          var candidateFaceBarrier = computeFaceBarrierForVertex(vertexId, state.barrierData, state.posById, options);
          var hasCrossings = hasPositionCrossings(state.posById, g.edgePairs);
          if (!hasCrossings &&
              candidateMinGapStats.movedMinGap >= baseMinGapStats.movedMinGap &&
              candidateMinGapStats.minGapSum > baseMinGapStats.minGapSum &&
              candidateFaceBarrier >= baseFaceBarrier) {
            acceptedMove = {
              vertexId: vertexId,
              candidate: candidate,
              localObjective: local.objective,
              minGapGain: candidateMinGapStats.minGapSum - baseMinGapStats.minGapSum,
              movedMinGapGain: candidateMinGapStats.movedMinGap - baseMinGapStats.movedMinGap,
              faceBarrierGain: candidateFaceBarrier - baseFaceBarrier
            };
            break;
          }
          state.posById[String(vertexId)] = original;
          step *= 0.5;
        }
        state.posById[String(vertexId)] = original;
        if (!acceptedMove) {
          rejected += 1;
          continue;
        }
        if (!bestMove ||
            acceptedMove.minGapGain > bestMove.minGapGain + 1e-12 ||
            (Math.abs(acceptedMove.minGapGain - bestMove.minGapGain) <= 1e-12 &&
             acceptedMove.movedMinGapGain > bestMove.movedMinGapGain + 1e-12) ||
            (Math.abs(acceptedMove.minGapGain - bestMove.minGapGain) <= 1e-12 &&
             Math.abs(acceptedMove.movedMinGapGain - bestMove.movedMinGapGain) <= 1e-12 &&
             acceptedMove.faceBarrierGain > bestMove.faceBarrierGain + 1e-12)) {
          bestMove = acceptedMove;
        }
      }

      if (bestMove) {
        state.posById[String(bestMove.vertexId)] = bestMove.candidate;
        accepted = 1;
        objectiveSum = bestMove.localObjective;
      } else {
        accepted = 0;
      }
      lastObjective = objectiveSum;
      var moveStats = computePositionMoveStats(g.nodeIds, prevPos, state.posById, { moveTol: 1e-12 });
      var convergence = movementTracker.update(moveStats, sweep);
      var angleStats = computeAngleStats(g, state.posById);
      if (typeof options.onIteration === 'function') {
        await options.onIteration({
          iter: sweep,
          maxIters: options.maxSweeps,
          objective: objectiveSum,
          angleResolutionScore: angleStats.angleResolutionScore,
          angleCount: angleStats.angleCount,
          accepted: accepted,
          rejected: rejected,
          gradNorm: gradNormMax,
          maxMove: moveStats.maxMove,
          avgMove: moveStats.avgMove,
          movedVertexId: bestMove ? String(bestMove.vertexId) : null,
          movedMinGapGain: bestMove ? bestMove.movedMinGapGain : null,
          minGapGain: bestMove ? bestMove.minGapGain : null,
          faceBarrierGain: bestMove ? bestMove.faceBarrierGain : null,
          positions: filterPositionMap(state.posById, g.nodeIds)
        });
      }
      if (accepted === 0) {
        stopReason = 'stalled';
        break;
      }
      if (convergence.converged) {
        stopReason = convergence.reason || 'movement-converged';
        break;
      }
    }

    var finalHasCrossings = hasPositionCrossings(state.posById, g.edgePairs);
    if (finalHasCrossings) {
      return buildLayoutError({
        graph: g,
        outerFace: outerFace,
        augmented: context.augmented,
        message: 'AngleBalancer produced a non-plane drawing'
      });
    }
    var finalAngleStats = computeAngleStats(g, state.posById);
    var debugPositions = copyPositionMap(context.posById);
    var originalIds = g.nodeIds;
    for (var oi = 0; oi < originalIds.length; oi += 1) {
      var originalId = String(originalIds[oi]);
      if (state.posById[originalId]) {
        debugPositions[originalId] = {
          x: state.posById[originalId].x,
          y: state.posById[originalId].y
        };
      }
    }
    return buildLayoutResult({
      ok: true,
      nodeIds: g.nodeIds,
      edgePairs: g.edgePairs,
      outerFace: outerFace,
      graph: g,
      augmented: context.augmented,
      positions: state.posById,
      debugPositions: debugPositions,
      stopReason: stopReason,
      iters: iterationCount,
      objective: lastObjective,
      angleResolutionScore: finalAngleStats.angleResolutionScore,
      angleCount: finalAngleStats.angleCount
    });
  }

  async function applyAngleBalancerLayout(cy, options) {
    return CyRuntime.runLayout(cy, options, {
      useSharedPreparedSeed: true,
      sharedSeedFailureLabel: 'AngleBalancer layout',
      compute: computeAngleBalancerPositions,
      buildResult: function (ctx) {
        var result = ctx.result;
        var message = buildLayoutStatusMessage('AngleBalancer', {
          dummyCount: result.augmented.dummyCount,
          iters: result.iters,
          stopReason: result.stopReason,
          extraParts: [
            Number.isFinite(result.angleResolutionScore) ? 'angle score ' + result.angleResolutionScore.toFixed(3) : null,
            Number.isFinite(result.objective) ? 'obj ' + result.objective.toFixed(3) : null
          ]
        });
        return {
          ok: true,
          stopReason: result.stopReason,
          angleResolutionScore: result.angleResolutionScore,
          message: message,
          debugState: LayoutPreprocessing.createAugmentationDebugState(
            result.graph,
            result.augmented,
            result.debugPositions || result.positions
          )
        };
      },
      failureMessage: 'AngleBalancer failed'
    });
  }

  global.PlanarVibeAngleBalancer = {
    computeAngleBalancerPositions: computeAngleBalancerPositions,
    applyAngleBalancerLayout: applyAngleBalancerLayout
  };
})(window);
