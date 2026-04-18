(function (global) {
  'use strict';

  var GraphUtils = global.GraphUtils;
  var GeometryUtils = global.GeometryUtils;
  var LayoutPreprocessing = global.LayoutPreprocessing;
  var Metrics = global.PlanarVibeMetrics;
  var CyRuntime = global.CyRuntime;
  var buildLayoutError = GraphUtils.buildLayoutError;
  var buildLayoutResult = GraphUtils.buildLayoutResult;
  var buildLayoutStatusMessage = GraphUtils.buildLayoutStatusMessage;
  var computePositionMoveStats = GraphUtils.computePositionMoveStats;
  var copyPositions = GeometryUtils.copyPositionMap;
  var findOuterFaceIndex = global.PlanarGraphUtils.findOuterFaceIndex;
  var resolveFloatOption = GraphUtils.resolveFloatOption;
  var resolveFunctionOption = GraphUtils.resolveFunctionOption;
  var resolveIntOption = GraphUtils.resolveIntOption;
  var resolveOpenIntervalOption = GraphUtils.resolveOpenIntervalOption;
  var resolvePositiveOption = GraphUtils.resolvePositiveOption;
  var orientFaceCCW = GeometryUtils.orientFaceCCW;
  var outerFaceDiameter = GeometryUtils.outerFaceDiameter;
  var polygonArea2 = GeometryUtils.polygonArea2;
  var triangleArea2 = GeometryUtils.triangleArea2;
  var hasPositionCrossings = GeometryUtils.hasPositionCrossings;
  var PPAG_INTERNAL = {
    tolGrad: 1e-8,
    acceptanceTol: 1e-12,
    minTriangleAreaRel: 1e-10
  };

  function buildPPAGData(augmentedEmbedding, outerFace, posById) {
    var incidentTrianglesByVertex = {};
    var triangles = [];
    var i;
    for (i = 0; i < augmentedEmbedding.idByIndex.length; i += 1) {
      incidentTrianglesByVertex[String(augmentedEmbedding.idByIndex[i])] = [];
    }

    var outerIndex = findOuterFaceIndex(augmentedEmbedding.faces || [], outerFace);
    for (i = 0; i < augmentedEmbedding.faces.length; i += 1) {
      var face = augmentedEmbedding.faces[i];
      if (!face || face.length < 3) {
        return buildLayoutError({ reason: 'PPAG requires a valid triangulated augmentation' });
      }
      if (i === outerIndex) {
        continue;
      }
      var oriented = orientFaceCCW(face, posById);
      if (oriented.length !== 3) {
        return buildLayoutError({ reason: 'PPAG requires all bounded faces of H to be triangles' });
      }
      var triangleIndex = triangles.length;
      triangles.push({ vertices: oriented });
      for (var j = 0; j < 3; j += 1) {
        var vertexId = String(oriented[j]);
        if (!incidentTrianglesByVertex[vertexId]) {
          incidentTrianglesByVertex[vertexId] = [];
        }
        incidentTrianglesByVertex[vertexId].push({
          triangleIndex: triangleIndex,
          slot: j
        });
      }
    }

    if (triangles.length === 0) {
      return buildLayoutResult({
        ok: true,
        outerFace: outerFace.slice().map(String),
        incidentTrianglesByVertex: incidentTrianglesByVertex,
        triangles: triangles,
        targetTriangleArea: 0
      });
    }

    var outerArea = Math.abs(polygonArea2(outerFace, posById)) / 2;
    if (!(outerArea > 1e-12)) {
      return buildLayoutError({ reason: 'PPAG initialization failed: outer face has zero area' });
    }

    return buildLayoutResult({
      ok: true,
      outerFace: outerFace.slice().map(String),
      incidentTrianglesByVertex: incidentTrianglesByVertex,
      triangles: triangles,
      targetTriangleArea: outerArea / triangles.length
    });
  }

  function addTriangleGradientForSlot(grad, slot, a, b, c, coeff) {
    if (!grad || coeff === 0) {
      return;
    }
    if (slot === 0) {
      grad.x += coeff * 0.5 * (b.y - c.y);
      grad.y += coeff * 0.5 * (c.x - b.x);
    } else if (slot === 1) {
      grad.x += coeff * 0.5 * (c.y - a.y);
      grad.y += coeff * 0.5 * (a.x - c.x);
    } else if (slot === 2) {
      grad.x += coeff * 0.5 * (a.y - b.y);
      grad.y += coeff * 0.5 * (b.x - a.x);
    }
  }

  function incidentTrianglesStayPositive(vertexId, ppagData, posById, tolAreaPositive) {
    var entries = ppagData.incidentTrianglesByVertex[vertexId] || [];
    for (var i = 0; i < entries.length; i += 1) {
      var tri = ppagData.triangles[entries[i].triangleIndex];
      var a = posById[tri.vertices[0]];
      var b = posById[tri.vertices[1]];
      var c = posById[tri.vertices[2]];
      if (!a || !b || !c) {
        return false;
      }
      if (!(triangleArea2(a, b, c) / 2 > tolAreaPositive)) {
        return false;
      }
    }
    return true;
  }

  function effectiveMinTriangleArea(ppagData, opts) {
    var targetArea = ppagData && Number.isFinite(ppagData.targetTriangleArea)
      ? ppagData.targetTriangleArea
      : 0;
    return Math.max(
      Number.isFinite(opts && opts.tolAreaPositive) ? opts.tolAreaPositive : 0,
      PPAG_INTERNAL.minTriangleAreaRel * Math.max(targetArea, 0)
    );
  }

  function computeTriangleResiduals(ppagData, posById, tolAreaPositive) {
    var triangles = ppagData.triangles || [];
    var residuals = new Array(triangles.length);
    var areas = new Array(triangles.length);
    var areaEnergy = 0;
    var maxRelError = 0;
    var targetArea = ppagData.targetTriangleArea;
    for (var i = 0; i < triangles.length; i += 1) {
      var tri = triangles[i];
      var a = posById[tri.vertices[0]];
      var b = posById[tri.vertices[1]];
      var c = posById[tri.vertices[2]];
      if (!a || !b || !c) {
        return buildLayoutError({ reason: 'missing_triangle_vertex' });
      }
      var area = triangleArea2(a, b, c) / 2;
      if (!(area > tolAreaPositive)) {
        return buildLayoutError({ reason: 'triangle_nonpositive' });
      }
      var rel = area / targetArea - 1;
      residuals[i] = rel;
      areas[i] = area;
      areaEnergy += rel * rel;
      if (Math.abs(rel) > maxRelError) {
        maxRelError = Math.abs(rel);
      }
    }
    return buildLayoutResult({
      ok: true,
      residuals: residuals,
      areas: areas,
      areaEnergy: areaEnergy,
      maxRelError: maxRelError
    });
  }

  function computePPAGState(ppagData, posById, opts) {
    var residualState = computeTriangleResiduals(ppagData, posById, effectiveMinTriangleArea(ppagData, opts));
    if (!residualState.ok) {
      return residualState;
    }

    return buildLayoutResult({
      ok: true,
      objective: residualState.areaEnergy,
      areaEnergy: residualState.areaEnergy,
      residuals: residualState.residuals,
      maxRelError: residualState.maxRelError,
      rmsRelError: ppagData.triangles.length > 0
        ? Math.sqrt(residualState.areaEnergy / ppagData.triangles.length)
        : 0
    });
  }

  function computeLocalDelta(vertexId, ppagData, posById, residuals, opts) {
    var entries = ppagData.incidentTrianglesByVertex[vertexId] || [];
    if (entries.length === 0) {
      return { x: 0, y: 0, norm: 0 };
    }
    var h00 = opts.localDamping;
    var h01 = 0;
    var h11 = opts.localDamping;
    var b0 = 0;
    var b1 = 0;
    var invTargetArea = 1 / Math.max(ppagData.targetTriangleArea, 1e-18);

    for (var i = 0; i < entries.length; i += 1) {
      var entry = entries[i];
      var tri = ppagData.triangles[entry.triangleIndex];
      var a = posById[tri.vertices[0]];
      var b = posById[tri.vertices[1]];
      var c = posById[tri.vertices[2]];
      if (!a || !b || !c) {
        continue;
      }
      var localGrad = { x: 0, y: 0 };
      addTriangleGradientForSlot(localGrad, entry.slot, a, b, c, invTargetArea);
      var gx = localGrad.x;
      var gy = localGrad.y;
      var r = residuals[entry.triangleIndex] || 0;
      h00 += gx * gx;
      h01 += gx * gy;
      h11 += gy * gy;
      b0 += -r * gx;
      b1 += -r * gy;
    }

    var det = h00 * h11 - h01 * h01;
    if (!(det > 1e-18)) {
      return { x: 0, y: 0, norm: 0 };
    }
    var dx = (h11 * b0 - h01 * b1) / det;
    var dy = (h00 * b1 - h01 * b0) / det;
    var norm = Math.hypot(dx, dy);
    if (norm > opts.maxVertexMove && opts.maxVertexMove > 0) {
      var scale = opts.maxVertexMove / norm;
      dx *= scale;
      dy *= scale;
      norm = opts.maxVertexMove;
    }
    return { x: dx, y: dy, norm: norm };
  }

  function maxIncidentResidual(vertexId, ppagData, residuals) {
    var entries = ppagData.incidentTrianglesByVertex[vertexId] || [];
    var worst = 0;
    for (var i = 0; i < entries.length; i += 1) {
      var residual = Math.abs(residuals[entries[i].triangleIndex] || 0);
      if (residual > worst) {
        worst = residual;
      }
    }
    return worst;
  }

  function fillPPAGSettings(options) {
    options.augmentationMethod = options.augmentationMethod || null;
    options.maxIters = resolveIntOption(options.maxIters, 200, 1);
    options.maxVertexMoveRel = resolvePositiveOption(options.maxVertexMoveRel, 0.08);
    options.localDamping = resolvePositiveOption(options.localDamping, 1e-3);
    options.stepShrink = resolveOpenIntervalOption(options.stepShrink, 0.5, 0, 1);
    options.minStepScale = resolvePositiveOption(options.minStepScale, Math.pow(2, -20));
    options.tolAreaPositive = resolveFloatOption(options.tolAreaPositive, 1e-12, 0);
    options.tolAreaGlobal = resolveFloatOption(options.tolAreaGlobal, 1e-3, 0);
    options.delayMs = 0;
    options.onIteration = resolveFunctionOption(options.onIteration, null);
    options.yieldEvery = 5;
    options.renderEvery = 2;
  }

  function preparePPAGState(graph, options) {
    fillPPAGSettings(options);
    var context = LayoutPreprocessing.reusePreparedLayoutData(graph, {
      preparedSeed: options.preparedSeed,
      augmentationMethod: options.augmentationMethod
    });
    if (!context) {
      context = LayoutPreprocessing.prepareGraphAndLayoutData(graph, {
        failureLabel: 'PPAG layout',
        augmentationMethod: options.augmentationMethod,
        currentPositions: options.currentPositions
      });
    }
    if (!context || !context.ok) {
      return buildLayoutError(context || { message: 'PPAG setup failed' });
    }

    var ppagData = buildPPAGData(
      context.augmented.embedding,
      context.augmentedOuterFace || context.outerFace,
      context.posById
    );
    if (!ppagData.ok) {
      return buildLayoutError({ message: ppagData.reason || 'PPAG setup failed' });
    }

    if (ppagData.triangles.length === 0) {
      return buildLayoutResult({
        ok: true,
        opts: options,
        graph: context.graph,
        outerFace: context.augmentedOuterFace || context.outerFace,
        augmented: context.augmented,
        posById: context.posById,
        ppagData: ppagData,
        movableVertices: []
      });
    }

    var minTriangleArea = effectiveMinTriangleArea(ppagData, options);
    for (var fi = 0; fi < ppagData.triangles.length; fi += 1) {
      var tri = ppagData.triangles[fi];
      var area = triangleArea2(context.posById[tri.vertices[0]], context.posById[tri.vertices[1]], context.posById[tri.vertices[2]]) / 2;
      if (!(area > minTriangleArea)) {
        return buildLayoutError({ message: 'PPAG initialization failed: degenerate augmented triangle' });
      }
    }

    return buildLayoutResult({
      ok: true,
      opts: options,
      graph: context.graph,
      outerFace: context.augmentedOuterFace || context.outerFace,
      augmented: context.augmented,
      posById: context.posById,
      ppagData: ppagData,
      movableVertices: context.movableVertices
    });
  }

  async function runPPAGIterations(prepared, options) {
    var g = prepared.graph;
    var posById = prepared.posById;
    var ppagData = prepared.ppagData;
    var movableVertices = prepared.movableVertices || [];
    var outerDiameter = outerFaceDiameter(posById, prepared.outerFace || ppagData.outerFace || []);
    options.maxVertexMove = options.maxVertexMoveRel * outerDiameter;
    options.minTriangleArea = effectiveMinTriangleArea(ppagData, options);
    var status = 'max_iters';
    var lastMoveStats = { movedVertices: 0, totalMove: 0, avgMove: 0, maxMove: 0 };
    var state = computePPAGState(ppagData, posById, options);

    if (!state.ok) {
      return buildLayoutError({
        ok: false,
        status: 'invalid',
        reason: state.reason || 'PPAG initialization failed'
      });
    }

    if (state.maxRelError <= options.tolAreaGlobal) {
      status = 'realized';
    }

    var iter;
    for (iter = 1; iter <= options.maxIters && status === 'max_iters'; iter += 1) {
      var prevSweepPos = copyPositions(posById);
      var acceptedCount = 0;
      var acceptedStepSum = 0;
      var lineSearchSteps = 0;
      var sweepVertices = movableVertices.slice().sort(function (a, b) {
        return maxIncidentResidual(b, ppagData, state.residuals || []) - maxIncidentResidual(a, ppagData, state.residuals || []);
      });

      for (var vi = 0; vi < sweepVertices.length; vi += 1) {
        var vertexId = sweepVertices[vi];
        var delta = computeLocalDelta(vertexId, ppagData, posById, state.residuals || [], options);
        if (!(delta.norm > PPAG_INTERNAL.tolGrad)) {
          continue;
        }
        var basePos = posById[vertexId];
        if (!basePos) {
          continue;
        }
        var stepScale = 1;
        while (stepScale >= options.minStepScale) {
          var dx = stepScale * delta.x;
          var dy = stepScale * delta.y;
          posById[vertexId] = {
            x: basePos.x + dx,
            y: basePos.y + dy
          };
          if (!incidentTrianglesStayPositive(vertexId, ppagData, posById, options.minTriangleArea)) {
            posById[vertexId] = basePos;
            stepScale *= options.stepShrink;
            lineSearchSteps += 1;
            continue;
          }
          var trialState = computePPAGState(ppagData, posById, options);
          if (trialState.ok &&
              trialState.objective <= state.objective - PPAG_INTERNAL.acceptanceTol * Math.max(1, state.objective)) {
            state = trialState;
            acceptedCount += 1;
            acceptedStepSum += Math.hypot(dx, dy);
            break;
          }
          posById[vertexId] = basePos;
          stepScale *= options.stepShrink;
          lineSearchSteps += 1;
        }
      }

      lastMoveStats = computePositionMoveStats(movableVertices, prevSweepPos, posById, { moveTol: 0 });
      lastMoveStats.acceptedCount = acceptedCount;

      if (options.onIteration) {
        await options.onIteration({
          iter: iter,
          maxIters: options.maxIters,
          status: status,
          positions: posById,
          objective: state.objective,
          maxRelError: state.maxRelError,
          maxMove: lastMoveStats.maxMove,
          avgMove: lastMoveStats.avgMove,
          movedVertices: lastMoveStats.movedVertices,
          debug: {
            areaEnergy: state.areaEnergy,
            rmsRelError: state.rmsRelError,
            acceptedCount: acceptedCount,
            acceptedStep: acceptedCount > 0 ? (acceptedStepSum / acceptedCount) : 0,
            lineSearchSteps: lineSearchSteps,
            boundedFaceCount: ppagData.triangles.length,
            gradNorm: state.gradNorm
          }
        });
      }

      if (state.maxRelError <= options.tolAreaGlobal) {
        status = 'realized';
        break;
      }
      if (acceptedCount === 0) {
        status = 'stalled';
        break;
      }
    }

    if (status === 'max_iters' && iter > options.maxIters) {
      status = 'max_iters';
    }

    var hasCrossings = hasPositionCrossings(posById, g.edgePairs);
    return {
      ok: !hasCrossings,
      status: status,
      positions: posById,
      stats: state,
      moveStats: lastMoveStats,
      iters: Math.min(options.maxIters, Math.max(0, iter - (status === 'max_iters' ? 1 : 0))),
      boundedFaceCount: ppagData.triangles.length,
      dummyCount: prepared.augmented ? prepared.augmented.dummyCount : 0,
      hasCrossings: hasCrossings
    };
  }

  async function computePPAGPositions(graph, options) {
    var prepared = preparePPAGState(graph, options);
    if (!prepared || !prepared.ok) {
      return buildLayoutError(prepared || { message: 'PPAG setup failed' });
    }

    if (prepared.ppagData.triangles.length === 0) {
      return buildLayoutResult({
        ok: true,
        status: 'realized',
        positions: prepared.posById,
        graph: prepared.graph,
        outerFace: prepared.outerFace,
        augmented: prepared.augmented,
        ppagData: prepared.ppagData,
        boundedFaceCount: 0,
        dummyCount: prepared.augmented.dummyCount,
        iters: 0,
        maxRelError: 0,
        faceAreaScore: null
      });
    }

    var result = await runPPAGIterations(prepared, prepared.opts);

    if (!result.ok && result.reason) {
      return buildLayoutError({
        status: result.status,
        graph: prepared.graph,
        outerFace: prepared.outerFace,
        augmented: prepared.augmented,
        message: result.reason
      });
    }
    if (result.hasCrossings) {
      return buildLayoutError({
        status: result.status,
        graph: prepared.graph,
        outerFace: prepared.outerFace,
        augmented: prepared.augmented,
        message: 'PPAG produced a non-plane drawing'
      });
    }

    var faceScore = Metrics && Metrics.computeUniformFaceAreaScore
      ? Metrics.computeUniformFaceAreaScore(prepared.graph.nodeIds, prepared.graph.edgePairs, prepared.posById, prepared.baseEmbedding)
      : null;
    var lastStats = result.stats || {};

    return buildLayoutResult({
      ok: true,
      status: result.status,
      positions: prepared.posById,
      graph: prepared.graph,
      outerFace: prepared.outerFace,
      augmented: prepared.augmented,
      ppagData: prepared.ppagData,
      iters: result.iters,
      faceAreaScore: faceScore && faceScore.ok ? faceScore.quality : null,
      maxRelError: Number.isFinite(lastStats.maxRelError) ? lastStats.maxRelError : null,
      boundedFaceCount: prepared.ppagData.triangles.length,
      dummyCount: prepared.augmented.dummyCount
    });
  }

  async function applyPPAGLayout(cy, options) {
    return CyRuntime.runLayout(cy, options, {
      useSharedPreparedSeed: true,
      sharedSeedFailureLabel: 'PPAG layout',
      compute: computePPAGPositions,
      buildResult: function (ctx) {
        var result = ctx.result;
        var message = buildLayoutStatusMessage('PPAG', {
          boundedFaceCount: result.boundedFaceCount,
          dummyCount: result.dummyCount,
          status: result.status,
          maxRelError: result.maxRelError,
          faceAreaScore: result.faceAreaScore
        });
        return {
          ok: true,
          status: result.status,
          iters: result.iters,
          message: message,
          faceAreaScore: result.faceAreaScore,
          maxRelError: result.maxRelError,
          boundedFaceCount: result.boundedFaceCount,
          dummyCount: result.dummyCount,
          debugState: typeof LayoutPreprocessing.createAugmentationDebugState === 'function'
            ? LayoutPreprocessing.createAugmentationDebugState(
              result.graph,
              result.augmented,
              result.positions
            )
            : null
        };
      },
      failureMessage: 'PPAG failed'
    });
  }

  global.PlanarVibePPAG = {
    computePPAGPositions: computePPAGPositions,
    applyPPAGLayout: applyPPAGLayout
  };
})(window);
