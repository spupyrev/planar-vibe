(function (global) {
  'use strict';

  var LayoutPreprocessing = global.LayoutPreprocessing;
  var CyRuntime = global.CyRuntime;
  var Metrics = global.PlanarVibeMetrics;
  var GeometryUtils = global.GeometryUtils;
  var buildLayoutError = global.GraphUtils.buildLayoutError;
  var buildLayoutResult = global.GraphUtils.buildLayoutResult;
  var buildLayoutStatusMessage = global.GraphUtils.buildLayoutStatusMessage;
  var edgeKey = global.GraphUtils.edgeKey;
  var faceKey = global.GraphUtils.faceKey;
  var filterPositions = GeometryUtils.filterPositionMap;
  var polygonArea2 = GeometryUtils.polygonArea2;
  var pointAdd = GeometryUtils.pointAdd;
  var pointDot = GeometryUtils.pointDot;
  var pointNorm = GeometryUtils.pointNorm;
  var pointRot90 = GeometryUtils.pointRot90;
  var pointScale = GeometryUtils.pointScale;
  var pointSub = GeometryUtils.pointSub;
  var resolveFunctionOption = global.GraphUtils.resolveFunctionOption;
  var orientFaceCCW = GeometryUtils.orientFaceCCW;
  var outerFaceDiameter = GeometryUtils.outerFaceDiameter;
  var triangleArea2 = GeometryUtils.triangleArea2;
  var hasPositionCrossings = GeometryUtils.hasPositionCrossings;
  var AIR_INTERNAL = {
    maxSweeps: 200,
    maxNewtonIter: 10,
    tolForceGlobal: 1e-8,
    tolForceVertex: 1e-6,
    tolAreaGlobal: 1e-3,
    tolAreaPositive: 1e-15,
    armijo: 1e-4,
    outerRingFaceWeight: 0.25,
    minStep: Math.pow(2, -40),
    moveTolRel: 1e-5,
    moveTolAbs: 1e-12,
    errTolRel: 1e-4,
    patience: 2,
    deadlockPatience: 2,
    plateauWindow: 12,
    plateauPatience: 1,
    plateauErrTolAbs: null,
    plateauErrTolRel: null,
    plateauErrGuardFactor: 20
  };

  function buildAirData(augmentedEmbedding, outerFace, posById, originalNodeIds) {
    var outerKey = faceKey(outerFace);
    var outerEdgeSet = {};
    var outerVertexSet = new Set(outerFace.map(String));
    var originalVertexSet = new Set(originalNodeIds.map(String));
    var i;

    for (i = 0; i < outerFace.length; i += 1) {
      outerEdgeSet[edgeKey(outerFace[i], outerFace[(i + 1) % outerFace.length])] = true;
    }

    var triangles = [];
    var incident = {};
    var outerRingTriangleCount = 0;

    for (i = 0; i < augmentedEmbedding.idByIndex.length; i += 1) {
      incident[String(augmentedEmbedding.idByIndex[i])] = [];
    }

    for (i = 0; i < augmentedEmbedding.faces.length; i += 1) {
      var face = augmentedEmbedding.faces[i];
      if (!face || face.length < 3) {
        return buildLayoutError({ reason: 'Air requires a valid triangulated augmentation' });
      }

      var oriented = orientFaceCCW(face, posById);
      if (faceKey(oriented) === outerKey) {
        continue;
      }
      if (face.length !== 3) {
        return buildLayoutError({ reason: 'Air requires all non-outer augmented faces to be triangles' });
      }

      var isOuterRing = false;
      for (var ei = 0; ei < oriented.length; ei += 1) {
        if (outerVertexSet.has(String(oriented[ei]))) {
          isOuterRing = true;
          break;
        }
        if (outerEdgeSet[edgeKey(oriented[ei], oriented[(ei + 1) % oriented.length])]) {
          isOuterRing = true;
          break;
        }
      }
      if (isOuterRing) {
        outerRingTriangleCount += 1;
      }
      var isRealFace = true;
      for (ei = 0; ei < oriented.length; ei += 1) {
        if (!originalVertexSet.has(String(oriented[ei]))) {
          isRealFace = false;
          break;
        }
      }

      var triangleIndex = triangles.length;
      triangles.push({
        vertices: oriented,
        targetArea: 0,
        weight: isOuterRing ? AIR_INTERNAL.outerRingFaceWeight : 1,
        isOuterRing: isOuterRing,
        isRealFace: isRealFace
      });

      for (var j = 0; j < 3; j += 1) {
        var v = String(oriented[j]);
        incident[v].push({
          faceIndex: triangleIndex,
          left: String(oriented[(j + 2) % 3]),
          right: String(oriented[(j + 1) % 3])
        });
      }
    }

    if (triangles.length === 0) {
      return buildLayoutResult({
        triangles: triangles,
        incident: incident,
        targetTriangleArea: 0
      });
    }

    var outerArea = Math.abs(polygonArea2(outerFace, posById)) / 2;
    if (!(outerArea > 1e-12)) {
      return buildLayoutError({ reason: 'Air initialization failed: outer face has zero area' });
    }
    var targetTriangleArea = outerArea / triangles.length;
    for (i = 0; i < triangles.length; i += 1) {
      triangles[i].targetArea = targetTriangleArea;
    }

    return buildLayoutResult({
      outerFace: outerFace.slice().map(String),
      triangles: triangles,
      incident: incident,
      targetTriangleArea: targetTriangleArea,
      outerRingTriangleCount: outerRingTriangleCount
    });
  }

  function evaluateLocalState(entries, triangles, posById, point, tolAreaPositive) {
    var areas = [];
    var feasible = true;
    var force = { x: 0, y: 0 };
    var entropy = 0;
    var a = 0;
    var b = 0;
    var c = 0;

    for (var i = 0; i < entries.length; i += 1) {
      var entry = entries[i];
      var tri = triangles[entry.faceIndex];
      var leftPos = posById[entry.left];
      var rightPos = posById[entry.right];
      if (!leftPos || !rightPos || !tri) {
        feasible = false;
        areas.push(0);
        continue;
      }

      var s = pointSub(leftPos, rightPos);
      var r = pointRot90(s);
      var delta = pointSub(point, rightPos);
      var area = 0.5 * (s.x * delta.y - s.y * delta.x);
      areas.push(area);
      if (!(area > tolAreaPositive)) {
        feasible = false;
        continue;
      }

      var pressure = tri.targetArea / area;
      var weight = Number.isFinite(tri.weight) ? tri.weight : 1;
      force.x += weight * pressure * r.x;
      force.y += weight * pressure * r.y;
      entropy += -weight * tri.targetArea * Math.log(Math.max(pressure, 1e-300));

      var coeff = -0.25 * weight * tri.targetArea / (area * area);
      a += coeff * r.x * r.x;
      b += coeff * r.x * r.y;
      c += coeff * r.y * r.y;
    }

    return {
      feasible: feasible,
      areas: areas,
      force: force,
      entropy: entropy,
      a: a,
      b: b,
      c: c
    };
  }

  function solveBalancedPosition(vertexId, airData, posById, opts) {
    var p = { x: posById[vertexId].x, y: posById[vertexId].y };
    var entries = opts.entries;
    var maxNewtonIter = opts.maxNewtonIter;
    var tolForceVertex = opts.tolForceVertex;
    var tolAreaPositive = opts.tolAreaPositive;
    var armijo = opts.armijo;
    var minStep = opts.minStep;
    var state = opts.initialState;

    for (var iter = 0; iter < maxNewtonIter; iter += 1) {
      if (!state) {
        state = evaluateLocalState(entries, airData.triangles, posById, p, tolAreaPositive);
      }
      if (!state.feasible) {
        return { pos: p, forceNorm: Infinity, stalled: true };
      }

      var forceNorm = pointNorm(state.force);
      if (forceNorm <= tolForceVertex) {
        return { pos: p, forceNorm: forceNorm, stalled: false };
      }

      var g = { x: 0.5 * state.force.x, y: 0.5 * state.force.y };
      var det = state.a * state.c - state.b * state.b;
      var d;
      if (det > 1e-18) {
        d = {
          x: (state.b * g.y - state.c * g.x) / det,
          y: (state.b * g.x - state.a * g.y) / det
        };
        if (!Number.isFinite(d.x) || !Number.isFinite(d.y)) {
          d = { x: g.x, y: g.y };
        }
      } else {
        d = { x: g.x, y: g.y };
      }

      if (pointDot(g, d) <= 0) {
        d = { x: g.x, y: g.y };
      }

      var alpha = 1;
      var accepted = false;
      while (alpha >= minStep) {
        var q = pointAdd(p, pointScale(alpha, d));
        var qState = evaluateLocalState(entries, airData.triangles, posById, q, tolAreaPositive);
        if (qState.feasible &&
            qState.entropy >= state.entropy + armijo * alpha * pointDot(g, d)) {
          p = q;
          state = qState;
          accepted = true;
          break;
        }
        alpha *= 0.5;
      }

      if (!accepted) {
        return { pos: p, forceNorm: forceNorm, stalled: true };
      }
    }

    var finalState = state;
    if (!finalState) {
      finalState = evaluateLocalState(entries, airData.triangles, posById, p, tolAreaPositive);
    }
    return {
      pos: p,
      forceNorm: finalState.feasible ? pointNorm(finalState.force) : Infinity,
      stalled: false
    };
  }

  function computeAirStats(airData, posById, movableVertices, tolAreaPositive) {
    var maxRelError = 0;
    for (var i = 0; i < airData.triangles.length; i += 1) {
      var tri = airData.triangles[i];
      var a = posById[tri.vertices[0]];
      var b = posById[tri.vertices[1]];
      var c = posById[tri.vertices[2]];
      var area = (a && b && c) ? (Math.abs(triangleArea2(a, b, c)) / 2) : 0;
      var targetArea = tri.targetArea;
      var rel = Math.abs(area - targetArea) / Math.max(targetArea, 1e-12);
      if (!Number.isFinite(rel)) rel = Infinity;
      if (rel > maxRelError) {
        maxRelError = rel;
      }
    }

    var maxForce = 0;
    var balancedCount = 0;
    for (i = 0; i < movableVertices.length; i += 1) {
      var v = movableVertices[i];
      var state = evaluateLocalState(airData.incident[v], airData.triangles, posById, posById[v], tolAreaPositive);
      var f = state.feasible ? pointNorm(state.force) : Infinity;
      if (f > maxForce) {
        maxForce = f;
      }
      if (f <= 1e-8) {
        balancedCount += 1;
      }
    }

    return {
      maxRelError: maxRelError,
      maxForce: maxForce,
      balancedCount: balancedCount,
      boundedFaceCount: airData.triangles.length
    };
  }

  function normalizeAirOptions(options) {
    var raw = options || {};
    return {
      augmentationMethod: raw.augmentationMethod === undefined ? null : raw.augmentationMethod,
      augmentationOptions: typeof raw.augmentationOptions === 'object' && raw.augmentationOptions
        ? Object.assign({}, raw.augmentationOptions)
        : null,
      onIteration: resolveFunctionOption(raw.onIteration, null)
    };
  }

  function buildAirStateFromPrepared(context, opts) {
    if (!Array.isArray(context.augmentedOuterFace) || context.augmentedOuterFace.length < 3) {
      return buildLayoutError({ message: 'Air setup failed: missing augmented outer face' });
    }

    var airData = buildAirData(
      context.augmented.embedding,
      context.augmentedOuterFace,
      context.posById,
      context.graph.nodeIds
    );
    if (!airData.ok) {
      return buildLayoutError({ message: airData.reason });
    }

    if (airData.triangles.length === 0) {
      return buildLayoutResult({
        opts: opts,
        graph: context.graph,
        baseEmbedding: context.baseEmbedding,
        outerFace: context.augmentedOuterFace,
        augmented: context.augmented,
        posById: context.posById,
        airData: airData,
        movableVertices: []
      });
    }

    for (var fi = 0; fi < airData.triangles.length; fi += 1) {
      var tri = airData.triangles[fi];
      var area = Math.abs(triangleArea2(
        context.posById[tri.vertices[0]],
        context.posById[tri.vertices[1]],
        context.posById[tri.vertices[2]]
      )) / 2;
      if (!(area > AIR_INTERNAL.tolAreaPositive)) {
        return buildLayoutError({ message: 'Air initialization failed: degenerate augmented triangle' });
      }
    }

    var movableVertices = [];
    for (var ni = 0; ni < context.movableVertices.length; ni += 1) {
      var nodeId = String(context.movableVertices[ni]);
      if (airData.incident[nodeId] && airData.incident[nodeId].length > 0) {
        movableVertices.push(nodeId);
      }
    }

    return buildLayoutResult({
      opts: opts,
      graph: context.graph,
      baseEmbedding: context.baseEmbedding,
      outerFace: context.augmentedOuterFace,
      augmented: context.augmented,
      posById: context.posById,
      airData: airData,
      movableVertices: movableVertices
    });
  }

  async function runAirIterations(layoutInput, options) {
    var g = layoutInput.graph;
    var posById = layoutInput.posById;
    var airData = layoutInput.airData;
    var movableVertices = layoutInput.movableVertices;
    var status = 'max_sweeps';
    var lastStats = computeAirStats(airData, posById, movableVertices, AIR_INTERNAL.tolAreaPositive);
    var outerDiameter = outerFaceDiameter(posById, airData.outerFace);
    var moveTol = AIR_INTERNAL.moveTolAbs + AIR_INTERNAL.moveTolRel * outerDiameter;
    var avgMoveTol = 0.25 * moveTol;
    var plateauErrTolAbs = AIR_INTERNAL.plateauErrTolAbs !== null ? AIR_INTERNAL.plateauErrTolAbs : AIR_INTERNAL.tolAreaGlobal;
    var plateauErrTolRel = AIR_INTERNAL.plateauErrTolRel !== null ? AIR_INTERNAL.plateauErrTolRel : 5 * AIR_INTERNAL.errTolRel;
    var plateauErrGuard = AIR_INTERNAL.plateauErrGuardFactor * AIR_INTERNAL.tolAreaGlobal;
    var prevMaxRelErr = lastStats.maxRelError;
    var stalledSweeps = 0;
    var deadSweeps = 0;
    var plateauSweeps = 0;
    var errWindow = [prevMaxRelErr];
    var lastMoveStats = { movedVertices: 0, avgMove: 0, maxMove: 0, acceptedCount: 0 };

    if (prevMaxRelErr <= AIR_INTERNAL.tolAreaGlobal) {
      lastStats.maxMove = 0;
      lastStats.avgMove = 0;
      lastStats.acceptedCount = 0;
      lastStats.sweeps = 0;
      return {
        status: 'realized',
        stats: lastStats,
        hasCrossings: hasPositionCrossings(posById, g.edgePairs)
      };
    }

    for (var sweep = 1; sweep <= AIR_INTERNAL.maxSweeps; sweep += 1) {
      var acceptedCount = 0;
      var sumMove = 0;
      var maxMove = 0;

      for (var vi = 0; vi < movableVertices.length; vi += 1) {
        var v = movableVertices[vi];
        var currentState = evaluateLocalState(airData.incident[v], airData.triangles, posById, posById[v], AIR_INTERNAL.tolAreaPositive);
        var currentForce = currentState.feasible ? pointNorm(currentState.force) : Infinity;
        if (currentForce <= AIR_INTERNAL.tolForceGlobal) {
          continue;
        }

        var solved = solveBalancedPosition(v, airData, posById, {
          entries: airData.incident[v],
          initialState: currentState,
          maxNewtonIter: AIR_INTERNAL.maxNewtonIter,
          tolForceVertex: AIR_INTERNAL.tolForceVertex,
          tolAreaPositive: AIR_INTERNAL.tolAreaPositive,
          armijo: AIR_INTERNAL.armijo,
          minStep: AIR_INTERNAL.minStep
        });
        if (!solved || !solved.pos) {
          continue;
        }
        var basePos = { x: posById[v].x, y: posById[v].y };
        var dx = solved.pos.x - basePos.x;
        var dy = solved.pos.y - basePos.y;
        var acceptedPos = null;
        var stepScale = 1;
        while (stepScale >= AIR_INTERNAL.minStep) {
          var candidate = {
            x: basePos.x + stepScale * dx,
            y: basePos.y + stepScale * dy
          };
          var candidateState = evaluateLocalState(airData.incident[v], airData.triangles, posById, candidate, AIR_INTERNAL.tolAreaPositive);
          if (candidateState.feasible) {
            acceptedPos = candidate;
            break;
          }
          stepScale *= 0.5;
        }
        if (acceptedPos) {
          posById[v] = acceptedPos;
          var moveDx = acceptedPos.x - basePos.x;
          var moveDy = acceptedPos.y - basePos.y;
          var move = Math.sqrt(moveDx * moveDx + moveDy * moveDy);
          if (move > maxMove) {
            maxMove = move;
          }
          sumMove += move;
          acceptedCount += 1;
        } else {
          posById[v] = basePos;
        }
      }

      lastMoveStats = {
        movedVertices: acceptedCount,
        avgMove: 0,
        maxMove: 0
      };
      lastMoveStats.maxMove = maxMove;
      lastMoveStats.avgMove = acceptedCount > 0 ? (sumMove / acceptedCount) : 0;
      lastMoveStats.acceptedCount = acceptedCount;
      lastStats = computeAirStats(airData, posById, movableVertices, AIR_INTERNAL.tolAreaPositive);
      var maxRelErr = lastStats.maxRelError;
      var improvement = prevMaxRelErr - maxRelErr;
      var relImprovement = improvement / Math.max(1, prevMaxRelErr);
      errWindow.push(maxRelErr);
      if (errWindow.length > AIR_INTERNAL.plateauWindow + 1) {
        errWindow.shift();
      }
      var plateauWindowImprovementAbs = null;
      var plateauWindowImprovementRel = null;
      if (errWindow.length >= AIR_INTERNAL.plateauWindow + 1) {
        plateauWindowImprovementAbs = errWindow[0] - maxRelErr;
        plateauWindowImprovementRel = plateauWindowImprovementAbs / Math.max(1, errWindow[0]);
      }
      lastStats.maxMove = lastMoveStats.maxMove;
      lastStats.avgMove = lastMoveStats.avgMove;
      lastStats.acceptedCount = acceptedCount;
      lastStats.sweeps = sweep;
      lastStats.plateauSweepCount = plateauSweeps;
      lastStats.plateauWindowImprovementAbs = plateauWindowImprovementAbs;
      lastStats.plateauWindowImprovementRel = plateauWindowImprovementRel;
      if (options.onIteration) {
        await options.onIteration({
          iter: sweep,
          maxIters: AIR_INTERNAL.maxSweeps,
          status: status,
          positions: posById,
          movedVertices: acceptedCount,
          maxMove: lastMoveStats.maxMove,
          avgMove: lastMoveStats.avgMove,
          maxRelError: maxRelErr,
          debug: {
            maxForce: lastStats.maxForce,
            balancedCount: lastStats.balancedCount,
            stableIterCount: stalledSweeps,
            stableIterLimit: AIR_INTERNAL.patience,
            acceptedCount: acceptedCount,
            deadSweepCount: deadSweeps,
            plateauSweepCount: plateauSweeps,
            plateauPatience: AIR_INTERNAL.plateauPatience,
            plateauWindow: AIR_INTERNAL.plateauWindow,
            plateauWindowImprovementAbs: plateauWindowImprovementAbs,
            plateauWindowImprovementRel: plateauWindowImprovementRel,
            boundedFaceCount: lastStats.boundedFaceCount
          }
        });
      }

      if (maxRelErr <= AIR_INTERNAL.tolAreaGlobal) {
        status = 'realized';
        break;
      }

      if (acceptedCount === 0) {
        deadSweeps += 1;
      } else {
        deadSweeps = 0;
      }
      if (deadSweeps >= AIR_INTERNAL.deadlockPatience) {
        status = 'deadlock';
        break;
      }

      if (lastMoveStats.maxMove <= moveTol &&
          lastMoveStats.avgMove <= avgMoveTol &&
          relImprovement <= AIR_INTERNAL.errTolRel) {
        stalledSweeps += 1;
      } else {
        stalledSweeps = 0;
      }
      if (stalledSweeps >= AIR_INTERNAL.patience) {
        status = 'stalled';
        break;
      }

      if (plateauWindowImprovementAbs !== null &&
          maxRelErr <= plateauErrGuard &&
          plateauWindowImprovementAbs <= plateauErrTolAbs &&
          plateauWindowImprovementRel <= plateauErrTolRel) {
        plateauSweeps += 1;
      } else {
        plateauSweeps = 0;
      }
      if (plateauSweeps >= AIR_INTERNAL.plateauPatience) {
        status = 'stalled';
        break;
      }

      prevMaxRelErr = maxRelErr;
    }

    return {
      status: status,
      stats: lastStats,
      hasCrossings: hasPositionCrossings(posById, g.edgePairs)
    };
  }

  function prepareGraphData(graph, options) {
    var opts = normalizeAirOptions(options);
    return LayoutPreprocessing.prepareGraphAndLayoutData(graph, {
      failureLabel: 'Air layout',
      augmentationMethod: opts.augmentationMethod,
      augmentationOptions: opts.augmentationOptions,
      currentPositions: options && options.currentPositions
    });
  }

  async function computePositions(layoutInput, options) {
    var opts = normalizeAirOptions(options);
    var state = buildAirStateFromPrepared(layoutInput, opts);
    if (!state.ok) {
      return buildLayoutError(state);
    }
    return finishAirPositions(state);
  }

  async function finishAirPositions(state) {
    var finalPositions = filterPositions(state.posById, state.graph.nodeIds);

    if (state.airData.triangles.length === 0) {
      return buildLayoutResult({
        status: 'realized',
        positions: finalPositions,
        debugPositions: state.posById,
        graph: state.graph,
        outerFace: state.outerFace,
        augmented: state.augmented,
        airData: state.airData,
        boundedFaceCount: 0,
        dummyCount: state.augmented.dummyCount,
        faceAreaScore: null,
        maxRelError: 0
      });
    }

    var solveResult = await runAirIterations(state, state.opts);
    var status = solveResult.status;
    var lastStats = solveResult.stats;
    finalPositions = filterPositions(state.posById, state.graph.nodeIds);

    if (solveResult.hasCrossings) {
      return buildLayoutError({
        status: status,
        message: 'Air produced a non-plane drawing',
        graph: state.graph,
        outerFace: state.outerFace,
        augmented: state.augmented,
        maxRelError: lastStats ? lastStats.maxRelError : null,
        boundedFaceCount: state.airData.triangles.length,
        dummyCount: state.augmented.dummyCount
      });
    }

    var faceScore = Metrics.computeUniformFaceAreaScore(
      state.graph.nodeIds,
      state.graph.edgePairs,
      state.posById,
      state.baseEmbedding
    );

    var quality = faceScore && faceScore.ok ? faceScore.quality : null;
    var message = buildLayoutStatusMessage('Air', {
      outerFaceVertexCount: Array.isArray(state.outerFace) ? state.outerFace.length : null,
      boundedFaceCount: state.airData.triangles.length,
      dummyCount: state.augmented.dummyCount,
      status: status,
      maxRelError: lastStats ? lastStats.maxRelError : null,
      faceAreaScore: quality
    });

    return buildLayoutResult({
      status: status,
      positions: finalPositions,
      debugPositions: state.posById,
      graph: state.graph,
      outerFace: state.outerFace,
      augmented: state.augmented,
      airData: state.airData,
      message: message,
      faceAreaScore: quality,
      maxRelError: lastStats ? lastStats.maxRelError : null,
      boundedFaceCount: state.airData.triangles.length,
      dummyCount: state.augmented.dummyCount,
      iters: lastStats && Number.isFinite(lastStats.sweeps) ? lastStats.sweeps : null
    });
  }

  async function applyLayout(cy, options) {
    return CyRuntime.runLayout(cy, options, {
      prepareMode: 'graph+layout',
      prepareFailureLabel: 'Air layout',
      initialFitBounds: function (ctx) {
        return CyRuntime.computePositionBounds(ctx.prepared.posById);
      },
      computePositions: computePositions,
      buildResult: function (ctx) {
        var result = ctx.result;
        return {
          ok: true,
          status: result.status,
          message: result.message,
          faceAreaScore: result.faceAreaScore,
          maxRelError: result.maxRelError,
          boundedFaceCount: result.boundedFaceCount,
          dummyCount: result.dummyCount,
          iters: result.iters,
          debugState: typeof LayoutPreprocessing.createAugmentationDebugState === 'function'
            ? LayoutPreprocessing.createAugmentationDebugState(
              result.graph,
              result.augmented,
              result.debugPositions || result.positions
            )
            : null
        };
      },
      failureMessage: 'Air failed'
    });
  }

	  global.PlanarVibeAir = {
	    prepareGraphData: prepareGraphData,
	    computePositions: computePositions,
	    applyLayout: applyLayout
	  };
})(window);
