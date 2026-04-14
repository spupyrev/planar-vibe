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
  var polygonArea2 = GeometryUtils.polygonArea2;
  var pointAdd = GeometryUtils.pointAdd;
  var pointDot = GeometryUtils.pointDot;
  var pointNorm = GeometryUtils.pointNorm;
  var pointRot90 = GeometryUtils.pointRot90;
  var pointScale = GeometryUtils.pointScale;
  var pointSub = GeometryUtils.pointSub;
  var resolveFloatOption = global.GraphUtils.resolveFloatOption;
  var resolveFunctionOption = global.GraphUtils.resolveFunctionOption;
  var resolveIntOption = global.GraphUtils.resolveIntOption;
  var orientFaceCCW = GeometryUtils.orientFaceCCW;
  var outerFaceDiameter = GeometryUtils.outerFaceDiameter;
  var triangleArea2 = GeometryUtils.triangleArea2;
  var hasPositionCrossings = GeometryUtils.hasPositionCrossings;

  function buildAirData(augmentedEmbedding, outerFace, posById, options) {
    var outerKey = faceKey(outerFace);
    var outerRingFaceWeight = options.outerRingFaceWeight;
    var outerEdgeSet = {};
    var outerVertexSet = new Set((outerFace || []).map(String));
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

      var triangleIndex = triangles.length;
      triangles.push({
        vertices: oriented,
        targetArea: 0,
        weight: isOuterRing ? outerRingFaceWeight : 1,
        isOuterRing: isOuterRing
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

  function fillAirSettings(options) {
    options.augmentationMethod = options.augmentationMethod || null;
    options.augmentationOptions = typeof options.augmentationOptions === 'object' && options.augmentationOptions
      ? Object.assign({}, options.augmentationOptions)
      : null;
    options.maxSweeps = 200;
    options.maxNewtonIter = 10;
    options.tolForceGlobal = 1e-8;
    options.tolForceVertex = 1e-6;
    options.tolAreaGlobal = 1e-3;
    options.tolAreaPositive = 1e-15;
    options.tolMove = 1e-12;
    options.armijo = 1e-4;
    options.outerRingFaceWeight = resolveFloatOption(options.outerRingFaceWeight, 0.25, 0);
    options.minStep = Math.pow(2, -40);
    options.delayMs = 0;
    options.onIteration = resolveFunctionOption(options.onIteration, null);
    options.yieldEvery = 5;
    options.renderEvery = 2;
    options.moveTolRel = 1e-5;
    options.moveTolAbs = 1e-12;
    options.errTolRel = 1e-4;
    options.patience = 2;
    options.deadlockPatience = 2;
    options.plateauWindow = 12;
    options.plateauPatience = 1;
    options.plateauErrTolAbs = null;
    options.plateauErrTolRel = null;
    options.plateauErrGuardFactor = 20;
  }

  function prepareAirState(graph, options) {
    fillAirSettings(options);
    var context = LayoutPreprocessing.prepareGraphAndLayoutData(graph, {
      failureLabel: 'Air layout',
      augmentationMethod: options.augmentationMethod,
      augmentationOptions: options.augmentationOptions,
      currentPositions: options.currentPositions
    });
    if (!context || !context.ok) {
      return buildLayoutError(context || { message: 'Air setup failed' });
    }

    var airData = buildAirData(
      context.augmented.embedding,
      context.augmentedOuterFace || context.outerFace,
      context.posById,
      options
    );
    if (!airData.ok) {
      return buildLayoutError({ message: airData.reason || 'Air setup failed' });
    }

    if (airData.triangles.length === 0) {
      return buildLayoutResult({
        ok: true,
        opts: options,
        graph: context.graph,
        baseEmbedding: context.baseEmbedding,
        outerFace: context.augmentedOuterFace || context.outerFace,
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
      if (!(area > options.tolAreaPositive)) {
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
      opts: options,
      graph: context.graph,
      baseEmbedding: context.baseEmbedding,
      outerFace: context.augmentedOuterFace || context.outerFace,
      augmented: context.augmented,
      posById: context.posById,
      airData: airData,
      movableVertices: movableVertices
    });
  }

  async function runAirIterations(prepared, options) {
    var g = prepared.graph;
    var posById = prepared.posById;
    var airData = prepared.airData;
    var movableVertices = prepared.movableVertices || [];
    var status = 'max_sweeps';
    var lastStats = computeAirStats(airData, posById, movableVertices, options.tolAreaPositive);
    var outerDiameter = outerFaceDiameter(posById, airData.outerFace || prepared.outerFace || []);
    var moveTol = options.moveTolAbs + options.moveTolRel * outerDiameter;
    var avgMoveTol = 0.25 * moveTol;
    var plateauErrTolAbs = options.plateauErrTolAbs !== null ? options.plateauErrTolAbs : options.tolAreaGlobal;
    var plateauErrTolRel = options.plateauErrTolRel !== null ? options.plateauErrTolRel : 5 * options.errTolRel;
    var plateauErrGuard = options.plateauErrGuardFactor * options.tolAreaGlobal;
    var prevMaxRelErr = lastStats.maxRelError;
    var stalledSweeps = 0;
    var deadSweeps = 0;
    var plateauSweeps = 0;
    var errWindow = [prevMaxRelErr];
    var lastMoveStats = { movedVertices: 0, avgMove: 0, maxMove: 0, acceptedCount: 0 };

    if (prevMaxRelErr <= options.tolAreaGlobal) {
      lastStats.maxMove = 0;
      lastStats.avgMove = 0;
      lastStats.acceptedCount = 0;
      lastStats.sweeps = 0;
      return {
        ok: !hasPositionCrossings(posById, g.edgePairs),
        status: 'realized',
        positions: posById,
        stats: lastStats,
        moveStats: lastMoveStats,
        boundedFaceCount: airData.triangles.length,
        dummyCount: prepared.augmented ? prepared.augmented.dummyCount : 0,
        hasCrossings: hasPositionCrossings(posById, g.edgePairs)
      };
    }

    for (var sweep = 1; sweep <= options.maxSweeps; sweep += 1) {
      var acceptedCount = 0;
      var sumMove = 0;
      var maxMove = 0;

      for (var vi = 0; vi < movableVertices.length; vi += 1) {
        var v = movableVertices[vi];
        var currentState = evaluateLocalState(airData.incident[v] || [], airData.triangles, posById, posById[v], options.tolAreaPositive);
        var currentForce = currentState.feasible ? pointNorm(currentState.force) : Infinity;
        if (currentForce <= options.tolForceGlobal) {
          continue;
        }

        var solved = solveBalancedPosition(v, airData, posById, {
          entries: airData.incident[v] || [],
          initialState: currentState,
          maxNewtonIter: options.maxNewtonIter,
          tolForceVertex: options.tolForceVertex,
          tolAreaPositive: options.tolAreaPositive,
          armijo: options.armijo,
          minStep: options.minStep
        });
        if (!solved || !solved.pos) {
          continue;
        }
        var basePos = { x: posById[v].x, y: posById[v].y };
        var dx = solved.pos.x - basePos.x;
        var dy = solved.pos.y - basePos.y;
        var acceptedPos = null;
        var stepScale = 1;
        while (stepScale >= options.minStep) {
          var candidate = {
            x: basePos.x + stepScale * dx,
            y: basePos.y + stepScale * dy
          };
          var candidateState = evaluateLocalState(airData.incident[v] || [], airData.triangles, posById, candidate, options.tolAreaPositive);
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
      lastStats = computeAirStats(airData, posById, movableVertices, options.tolAreaPositive);
      var maxRelErr = lastStats.maxRelError;
      var improvement = prevMaxRelErr - maxRelErr;
      var relImprovement = improvement / Math.max(1, prevMaxRelErr);
      errWindow.push(maxRelErr);
      if (errWindow.length > options.plateauWindow + 1) {
        errWindow.shift();
      }
      var plateauWindowImprovementAbs = null;
      var plateauWindowImprovementRel = null;
      if (errWindow.length >= options.plateauWindow + 1) {
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
          maxIters: options.maxSweeps,
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
            stableIterLimit: options.patience,
            acceptedCount: acceptedCount,
            deadSweepCount: deadSweeps,
            plateauSweepCount: plateauSweeps,
            plateauPatience: options.plateauPatience,
            plateauWindow: options.plateauWindow,
            plateauWindowImprovementAbs: plateauWindowImprovementAbs,
            plateauWindowImprovementRel: plateauWindowImprovementRel,
            boundedFaceCount: lastStats.boundedFaceCount
          }
        });
      }

      if (maxRelErr <= options.tolAreaGlobal) {
        status = 'realized';
        break;
      }

      if (acceptedCount === 0) {
        deadSweeps += 1;
      } else {
        deadSweeps = 0;
      }
      if (deadSweeps >= options.deadlockPatience) {
        status = 'deadlock';
        break;
      }

      if (lastMoveStats.maxMove <= moveTol &&
          lastMoveStats.avgMove <= avgMoveTol &&
          relImprovement <= options.errTolRel) {
        stalledSweeps += 1;
      } else {
        stalledSweeps = 0;
      }
      if (stalledSweeps >= options.patience) {
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
      if (plateauSweeps >= options.plateauPatience) {
        status = 'stalled';
        break;
      }

      prevMaxRelErr = maxRelErr;
    }

    return {
      ok: !hasPositionCrossings(posById, g.edgePairs),
      status: status,
      positions: posById,
      stats: lastStats,
      moveStats: lastMoveStats,
      boundedFaceCount: airData.triangles.length,
      dummyCount: prepared.augmented ? prepared.augmented.dummyCount : 0,
      hasCrossings: hasPositionCrossings(posById, g.edgePairs)
    };
  }

  async function computeAirPositions(graph, options) {
    var prepared = prepareAirState(graph, options);
    if (!prepared || !prepared.ok) {
      return buildLayoutError(prepared || { message: 'Air failed' });
    }

    if (prepared.airData.triangles.length === 0) {
      return buildLayoutResult({
        ok: true,
        status: 'realized',
        positions: prepared.posById,
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
      outerFaceVertexCount: Array.isArray(prepared.outerFace) ? prepared.outerFace.length : null,
      boundedFaceCount: prepared.airData.triangles.length,
      dummyCount: prepared.augmented.dummyCount,
      status: status,
      maxRelError: lastStats ? lastStats.maxRelError : null,
      faceAreaScore: faceScore && faceScore.ok ? faceScore.quality : null
    });

    return buildLayoutResult({
      ok: true,
      status: status,
      positions: prepared.posById,
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
    return CyRuntime.runLayout(cy, options, {
      useSharedPreparedSeed: true,
      sharedSeedFailureLabel: 'Air layout',
      compute: computeAirPositions,
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
              result.positions
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
