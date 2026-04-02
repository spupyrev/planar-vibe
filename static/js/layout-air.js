(function (global) {
  'use strict';

  var PlaygroundUtils = global.PlaygroundUtils;
  var Metrics = global.PlanarVibeMetrics;
  var buildLayoutError = global.GraphUtils.buildLayoutError;
  var buildLayoutResult = global.GraphUtils.buildLayoutResult;
  var buildLayoutStatusMessage = global.GraphUtils.buildLayoutStatusMessage;
  var faceKey = global.GraphUtils.faceKey;
  var polygonArea2 = global.GraphUtils.polygonArea2;
  var pointAdd = global.GraphUtils.pointAdd;
  var pointDot = global.GraphUtils.pointDot;
  var pointNorm = global.GraphUtils.pointNorm;
  var pointRot90 = global.GraphUtils.pointRot90;
  var pointScale = global.GraphUtils.pointScale;
  var pointSub = global.GraphUtils.pointSub;
  var normalizeGraphInput = global.GraphUtils.normalizeGraphInput;
  var resolveFloatOption = global.GraphUtils.resolveFloatOption;
  var resolveFunctionOption = global.GraphUtils.resolveFunctionOption;
  var resolveIntOption = global.GraphUtils.resolveIntOption;
  var resolveNonNegativeOption = global.GraphUtils.resolveNonNegativeOption;
  var resolvePositiveOption = global.GraphUtils.resolvePositiveOption;
  var orientFaceCCW = global.GraphUtils.orientFaceCCW;
  var outerFaceDiameter = global.GraphUtils.outerFaceDiameter;
  var triangleArea2 = global.GraphUtils.triangleArea2;
  var hasPositionCrossings = global.GraphUtils.hasPositionCrossings;

  function buildAirData(augmentedEmbedding, outerFace, posById) {
    var outerKey = faceKey(outerFace);
    var i;

    var triangles = [];
    var incident = {};

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

      var triangleIndex = triangles.length;
      triangles.push({
        vertices: oriented,
        targetArea: 0
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
        ok: true,
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
      ok: true,
      outerFace: outerFace.slice().map(String),
      triangles: triangles,
      incident: incident,
      targetTriangleArea: targetTriangleArea
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
      force.x += pressure * r.x;
      force.y += pressure * r.y;
      entropy += -tri.targetArea * Math.log(Math.max(pressure, 1e-300));

      var coeff = -0.25 * tri.targetArea / (area * area);
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
    var entries = opts.entries || airData.incident[vertexId] || [];
    var maxNewtonIter = opts.maxNewtonIter;
    var tolForceVertex = opts.tolForceVertex;
    var tolAreaPositive = opts.tolAreaPositive;
    var armijo = opts.armijo;
    var minStep = opts.minStep;
    var state = opts.initialState || null;

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

    var finalState = state || evaluateLocalState(entries, airData.triangles, posById, p, tolAreaPositive);
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
      var state = evaluateLocalState(airData.incident[v] || [], airData.triangles, posById, posById[v], tolAreaPositive);
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
    var opts = options || {};
    var timing = PlaygroundUtils.resolveIncrementalLayoutTimingOptions(opts, {
      delayMs: 0,
      renderEvery: 2,
      yieldEvery: 5
    });
    return {
      interactive: opts.interactive !== false,
      augmentationOptions: opts && typeof opts.augmentationOptions === 'object' && opts.augmentationOptions
        ? Object.assign({}, opts.augmentationOptions)
        : null,
      maxSweeps: resolveIntOption(opts.maxSweeps, 200, 1),
      maxNewtonIter: resolveIntOption(opts.maxNewtonIter, 10, 1),
      tolForceGlobal: resolveFloatOption(opts.tolForceGlobal, 1e-8, 0),
      tolForceVertex: resolveFloatOption(opts.tolForceVertex, 1e-6, 0),
      tolAreaGlobal: resolveFloatOption(opts.tolAreaGlobal, 1e-3, 0),
      tolAreaPositive: resolveFloatOption(opts.tolAreaPositive, 1e-15, 0),
      tolMove: resolveFloatOption(opts.tolMove, 1e-12, 0),
      armijo: resolveFloatOption(opts.armijo, 1e-4, 0),
      minStep: resolvePositiveOption(opts.minStep, Math.pow(2, -40)),
      delayMs: timing.delayMs,
      onIteration: resolveFunctionOption(opts.onIteration, null),
      yieldEvery: timing.yieldEvery,
      renderEvery: timing.renderEvery,
      moveTolRel: resolveNonNegativeOption(opts.moveTolRel, 1e-5),
      moveTolAbs: resolveNonNegativeOption(opts.moveTolAbs, 1e-12),
      errTolRel: resolveNonNegativeOption(opts.errTolRel, 1e-4),
      patience: resolveIntOption(opts.patience, 2, 1),
      deadlockPatience: resolveIntOption(opts.deadlockPatience, 2, 1),
      plateauWindow: resolveIntOption(opts.plateauWindow, 12, 2),
      plateauPatience: resolveIntOption(opts.plateauPatience, 1, 1),
      plateauErrTolAbs: resolveNonNegativeOption(opts.plateauErrTolAbs, null),
      plateauErrTolRel: resolveNonNegativeOption(opts.plateauErrTolRel, null),
      plateauErrGuardFactor: resolvePositiveOption(opts.plateauErrGuardFactor, 20)
    };
  }

  function prepareAirState(graph, options) {
    var opts = normalizeAirOptions(options);
    var context = PlaygroundUtils.prepareGraphAndLayoutData(graph, {
      failureLabel: 'Air layout',
      minNodeCount: 3,
      augmentationOptions: opts.augmentationOptions,
      currentPositions: opts.currentPositions || null
    });
    if (!context || !context.ok) {
      return buildLayoutError(context || { message: 'Air setup failed' });
    }

    var airData = buildAirData(
      context.augmented.embedding,
      context.outerFace,
      context.posById
    );
    if (!airData.ok) {
      return buildLayoutError({ message: airData.reason || 'Air setup failed' });
    }

    if (airData.triangles.length === 0) {
      return buildLayoutResult({
        ok: true,
        opts: opts,
        graph: context.graph,
        baseEmbedding: context.baseEmbedding,
        outerFace: context.outerFace,
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
      if (!(area > opts.tolAreaPositive)) {
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
      ok: true,
      opts: opts,
      graph: context.graph,
      baseEmbedding: context.baseEmbedding,
      outerFace: context.outerFace,
      augmented: context.augmented,
      posById: context.posById,
      airData: airData,
      movableVertices: movableVertices
    });
  }

  async function runAirIterations(prepared, options) {
    var opts = Object.assign({}, prepared && prepared.opts ? prepared.opts : {}, options || {});
    var g = prepared.graph;
    var posById = prepared.posById;
    var airData = prepared.airData;
    var movableVertices = prepared.movableVertices || [];
    var status = 'max_sweeps';
    var lastStats = computeAirStats(airData, posById, movableVertices, opts.tolAreaPositive);
    var outerDiameter = outerFaceDiameter(posById, airData.outerFace || prepared.outerFace || []);
    var moveTol = opts.moveTolAbs + opts.moveTolRel * outerDiameter;
    var avgMoveTol = 0.25 * moveTol;
    var plateauErrTolAbs = opts.plateauErrTolAbs !== null ? opts.plateauErrTolAbs : opts.tolAreaGlobal;
    var plateauErrTolRel = opts.plateauErrTolRel !== null ? opts.plateauErrTolRel : 5 * opts.errTolRel;
    var plateauErrGuard = opts.plateauErrGuardFactor * opts.tolAreaGlobal;
    var prevMaxRelErr = lastStats.maxRelError;
    var stalledSweeps = 0;
    var deadSweeps = 0;
    var plateauSweeps = 0;
    var errWindow = [prevMaxRelErr];
    var lastMoveStats = { movedVertices: 0, avgMove: 0, maxMove: 0, acceptedCount: 0 };

    if (prevMaxRelErr <= opts.tolAreaGlobal) {
      lastStats.maxMove = 0;
      lastStats.avgMove = 0;
      lastStats.acceptedCount = 0;
      lastStats.sweeps = 0;
      return {
        ok: !hasPositionCrossings(posById, g.edgePairs),
        status: 'realized',
        pos: posById,
        stats: lastStats,
        moveStats: lastMoveStats,
        boundedFaceCount: airData.triangles.length,
        dummyCount: prepared.augmented ? prepared.augmented.dummyCount : 0,
        hasCrossings: hasPositionCrossings(posById, g.edgePairs)
      };
    }

    for (var sweep = 1; sweep <= opts.maxSweeps; sweep += 1) {
      var acceptedCount = 0;
      var sumMove = 0;
      var maxMove = 0;

      for (var vi = 0; vi < movableVertices.length; vi += 1) {
        var v = movableVertices[vi];
        var currentState = evaluateLocalState(airData.incident[v] || [], airData.triangles, posById, posById[v], opts.tolAreaPositive);
        var currentForce = currentState.feasible ? pointNorm(currentState.force) : Infinity;
        if (currentForce <= opts.tolForceGlobal) {
          continue;
        }

        var solved = solveBalancedPosition(v, airData, posById, {
          entries: airData.incident[v] || [],
          initialState: currentState,
          maxNewtonIter: opts.maxNewtonIter,
          tolForceVertex: opts.tolForceVertex,
          tolAreaPositive: opts.tolAreaPositive,
          armijo: opts.armijo,
          minStep: opts.minStep
        });
        if (!solved || !solved.pos) {
          continue;
        }
        var basePos = { x: posById[v].x, y: posById[v].y };
        var dx = solved.pos.x - basePos.x;
        var dy = solved.pos.y - basePos.y;
        var acceptedPos = null;
        var stepScale = 1;
        while (stepScale >= opts.minStep) {
          var candidate = {
            x: basePos.x + stepScale * dx,
            y: basePos.y + stepScale * dy
          };
          var candidateState = evaluateLocalState(airData.incident[v] || [], airData.triangles, posById, candidate, opts.tolAreaPositive);
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
      lastStats = computeAirStats(airData, posById, movableVertices, opts.tolAreaPositive);
      var maxRelErr = lastStats.maxRelError;
      var improvement = prevMaxRelErr - maxRelErr;
      var relImprovement = improvement / Math.max(1, prevMaxRelErr);
      errWindow.push(maxRelErr);
      if (errWindow.length > opts.plateauWindow + 1) {
        errWindow.shift();
      }
      var plateauWindowImprovementAbs = null;
      var plateauWindowImprovementRel = null;
      if (errWindow.length >= opts.plateauWindow + 1) {
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
      if (opts.onIteration) {
        await opts.onIteration({
          iter: sweep,
          maxIters: opts.maxSweeps,
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
            stableIterLimit: opts.patience,
            acceptedCount: acceptedCount,
            deadSweepCount: deadSweeps,
            plateauSweepCount: plateauSweeps,
            plateauPatience: opts.plateauPatience,
            plateauWindow: opts.plateauWindow,
            plateauWindowImprovementAbs: plateauWindowImprovementAbs,
            plateauWindowImprovementRel: plateauWindowImprovementRel,
            boundedFaceCount: lastStats.boundedFaceCount
          }
        });
      }

      if (maxRelErr <= opts.tolAreaGlobal) {
        status = 'realized';
        break;
      }

      if (acceptedCount === 0) {
        deadSweeps += 1;
      } else {
        deadSweeps = 0;
      }
      if (deadSweeps >= opts.deadlockPatience) {
        status = 'deadlock';
        break;
      }

      if (lastMoveStats.maxMove <= moveTol &&
          lastMoveStats.avgMove <= avgMoveTol &&
          relImprovement <= opts.errTolRel) {
        stalledSweeps += 1;
      } else {
        stalledSweeps = 0;
      }
      if (stalledSweeps >= opts.patience) {
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
      if (plateauSweeps >= opts.plateauPatience) {
        status = 'stalled';
        break;
      }

      prevMaxRelErr = maxRelErr;
    }

    return {
      ok: !hasPositionCrossings(posById, g.edgePairs),
      status: status,
      pos: posById,
      stats: lastStats,
      moveStats: lastMoveStats,
      boundedFaceCount: airData.triangles.length,
      dummyCount: prepared.augmented ? prepared.augmented.dummyCount : 0,
      hasCrossings: hasPositionCrossings(posById, g.edgePairs)
    };
  }

  async function computeAirPositions(nodeIds, edgePairs, options) {
    var opts = options || {};
    var prepared = prepareAirState(normalizeGraphInput(nodeIds, edgePairs), opts);
    if (!prepared || !prepared.ok) {
      return buildLayoutError(prepared || { message: 'Air failed' });
    }

    if (prepared.airData.triangles.length === 0) {
      return buildLayoutResult({
        ok: true,
        status: 'realized',
        pos: prepared.posById,
        graph: prepared.graph,
        outerFace: prepared.outerFace,
        augmented: prepared.augmented,
        airData: prepared.airData,
        boundedFaceCount: 0,
        dummyCount: prepared.augmented.dummyCount,
        faceAreaScore: null,
        maxRelError: 0
      });
    }

    var solveResult = await runAirIterations(prepared, prepared.opts);
    var status = solveResult.status;
    var lastStats = solveResult.stats;

    if (solveResult.hasCrossings) {
      return buildLayoutError({
        status: status,
        message: 'Air produced a non-plane drawing',
        graph: prepared.graph,
        outerFace: prepared.outerFace,
        augmented: prepared.augmented,
        maxRelError: lastStats ? lastStats.maxRelError : null,
        boundedFaceCount: prepared.airData.triangles.length,
        dummyCount: prepared.augmented.dummyCount
      });
    }

    var faceScore = Metrics.computeUniformFaceAreaScore(prepared.graph.nodeIds, prepared.graph.edgePairs, prepared.posById);

    var message = buildLayoutStatusMessage('Air', {
      boundedFaceCount: prepared.airData.triangles.length,
      dummyCount: prepared.augmented.dummyCount,
      status: status,
      maxRelError: lastStats ? lastStats.maxRelError : null,
      faceAreaScore: faceScore && faceScore.ok ? faceScore.quality : null
    });

    return buildLayoutResult({
      ok: true,
      status: status,
      pos: prepared.posById,
      graph: prepared.graph,
      outerFace: prepared.outerFace,
      augmented: prepared.augmented,
      airData: prepared.airData,
      message: message,
      faceAreaScore: faceScore && faceScore.ok ? faceScore.quality : null,
      maxRelError: lastStats ? lastStats.maxRelError : null,
      boundedFaceCount: prepared.airData.triangles.length,
      dummyCount: prepared.augmented.dummyCount,
      iters: lastStats && Number.isFinite(lastStats.sweeps) ? lastStats.sweeps : null
    });
  }

  async function applyAirLayout(cy, options) {
    return PlaygroundUtils.runIncrementalLayout(cy, options, {
      compute: computeAirPositions,
      patchComputeOptions: function (ctx) {
        return {
          onIteration: ctx.onProgress,
          currentPositions: PlaygroundUtils.currentPositionsFromCy(ctx.cy)
        };
      },
      getPositions: function (result) {
        return result.pos;
      },
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
          debugState: typeof PlaygroundUtils.createAugmentationDebugState === 'function'
            ? PlaygroundUtils.createAugmentationDebugState(
              result.graph,
              result.outerFace,
              result.augmented,
              result.pos
            )
            : null
        };
      },
      failureMessage: 'Air failed'
    });
  }

  global.PlanarVibeAir = {
    computeAirPositions: computeAirPositions,
    applyAirLayout: applyAirLayout
  };
})(window);
