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
  var filterPositions = GeometryUtils.filterPositionMap;
  var findOuterFaceIndex = global.PlanarGraphUtils.findOuterFaceIndex;
  var orientFaceCCW = GeometryUtils.orientFaceCCW;
  var outerFaceDiameter = GeometryUtils.outerFaceDiameter;
  var polygonArea2 = GeometryUtils.polygonArea2;
  var triangleArea2 = GeometryUtils.triangleArea2;
  var hasPositionCrossings = GeometryUtils.hasPositionCrossings;
  var AREAGRAD_INTERNAL = {
    tolGrad: 1e-8,
    acceptanceTol: 1e-12,
    minTriangleAreaRel: 1e-10,
    maxIters: 200,
    maxVertexMoveRel: 0.08,
    localDamping: 1e-3,
    stepShrink: 0.5,
    minStepScale: Math.pow(2, -20),
    tolAreaPositive: 1e-12,
    tolAreaGlobal: 1e-3
  };

  function buildAreaGradData(augmentedEmbedding, outerFace, posById) {
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
        return buildLayoutError({ reason: 'AreaGrad requires a valid triangulated augmentation' });
      }
      if (i === outerIndex) {
        continue;
      }
      var oriented = orientFaceCCW(face, posById);
      if (oriented.length !== 3) {
        return buildLayoutError({ reason: 'AreaGrad requires all bounded faces of H to be triangles' });
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
        outerFace: outerFace.slice().map(String),
        incidentTrianglesByVertex: incidentTrianglesByVertex,
        triangles: triangles,
        targetTriangleArea: 0
      });
    }

    var outerArea = Math.abs(polygonArea2(outerFace, posById)) / 2;
    if (!(outerArea > 1e-12)) {
      return buildLayoutError({ reason: 'AreaGrad initialization failed: outer face has zero area' });
    }

    return buildLayoutResult({
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

  function incidentTrianglesStayPositive(vertexId, areaGradData, posById, tolAreaPositive) {
    var entries = areaGradData.incidentTrianglesByVertex[vertexId] || [];
    for (var i = 0; i < entries.length; i += 1) {
      var tri = areaGradData.triangles[entries[i].triangleIndex];
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

  function effectiveMinTriangleArea(areaGradData, opts) {
    var targetArea = areaGradData && Number.isFinite(areaGradData.targetTriangleArea)
      ? areaGradData.targetTriangleArea
      : 0;
    return Math.max(
      Number.isFinite(opts && opts.tolAreaPositive) ? opts.tolAreaPositive : 0,
      AREAGRAD_INTERNAL.minTriangleAreaRel * Math.max(targetArea, 0)
    );
  }

  function computeTriangleResiduals(areaGradData, posById, tolAreaPositive) {
    var triangles = areaGradData.triangles || [];
    var residuals = new Array(triangles.length);
    var areas = new Array(triangles.length);
    var areaEnergy = 0;
    var maxRelError = 0;
    var targetArea = areaGradData.targetTriangleArea;
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
      residuals: residuals,
      areas: areas,
      areaEnergy: areaEnergy,
      maxRelError: maxRelError
    });
  }

  function computeAreaGradState(areaGradData, posById, opts) {
    var residualState = computeTriangleResiduals(areaGradData, posById, effectiveMinTriangleArea(areaGradData, opts));
    if (!residualState.ok) {
      return residualState;
    }

    return buildLayoutResult({
      objective: residualState.areaEnergy,
      areaEnergy: residualState.areaEnergy,
      residuals: residualState.residuals,
      maxRelError: residualState.maxRelError,
      rmsRelError: areaGradData.triangles.length > 0
        ? Math.sqrt(residualState.areaEnergy / areaGradData.triangles.length)
        : 0
    });
  }

  function computeLocalDelta(vertexId, areaGradData, posById, residuals, opts) {
    var entries = areaGradData.incidentTrianglesByVertex[vertexId] || [];
    if (entries.length === 0) {
      return { x: 0, y: 0, norm: 0 };
    }
    var h00 = opts.localDamping;
    var h01 = 0;
    var h11 = opts.localDamping;
    var b0 = 0;
    var b1 = 0;
    var invTargetArea = 1 / Math.max(areaGradData.targetTriangleArea, 1e-18);

    for (var i = 0; i < entries.length; i += 1) {
      var entry = entries[i];
      var tri = areaGradData.triangles[entry.triangleIndex];
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

  function maxIncidentResidual(vertexId, areaGradData, residuals) {
    var entries = areaGradData.incidentTrianglesByVertex[vertexId] || [];
    var worst = 0;
    for (var i = 0; i < entries.length; i += 1) {
      var residual = Math.abs(residuals[entries[i].triangleIndex] || 0);
      if (residual > worst) {
        worst = residual;
      }
    }
    return worst;
  }

  function buildAreaGradSettings(options) {
    var raw = options || {};
    return {
      augmentationMethod: raw.augmentationMethod || null,
      augmentationOptions: typeof raw.augmentationOptions === 'object' && raw.augmentationOptions
        ? Object.assign({}, raw.augmentationOptions)
        : null,
      currentPositions: raw.currentPositions,
      onIteration: typeof raw.onIteration === 'function' ? raw.onIteration : null,
      maxIters: AREAGRAD_INTERNAL.maxIters,
      maxVertexMoveRel: AREAGRAD_INTERNAL.maxVertexMoveRel,
      localDamping: AREAGRAD_INTERNAL.localDamping,
      stepShrink: AREAGRAD_INTERNAL.stepShrink,
      minStepScale: AREAGRAD_INTERNAL.minStepScale,
      tolAreaPositive: AREAGRAD_INTERNAL.tolAreaPositive,
      tolAreaGlobal: AREAGRAD_INTERNAL.tolAreaGlobal
    };
  }

  function buildAreaGradStateFromPrepared(context, options) {
    var settings = buildAreaGradSettings(options);
    if (!context || !context.ok) {
      return buildLayoutError(context || { message: 'AreaGrad setup failed' });
    }
    
    var areaGradData = buildAreaGradData(
      context.augmented.embedding,
      context.augmentedOuterFace,
      context.posById
    );
    if (!areaGradData.ok) {
      return buildLayoutError({ message: areaGradData.reason || 'AreaGrad setup failed' });
    }

    if (areaGradData.triangles.length === 0) {
      return buildLayoutResult({
        opts: settings,
        graph: context.graph,
        baseEmbedding: context.baseEmbedding,
        outerFace: context.augmentedOuterFace,
        augmented: context.augmented,
        posById: context.posById,
        areaGradData: areaGradData,
        movableVertices: []
      });
    }

    var minTriangleArea = effectiveMinTriangleArea(areaGradData, settings);
    for (var fi = 0; fi < areaGradData.triangles.length; fi += 1) {
      var tri = areaGradData.triangles[fi];
      var area = triangleArea2(context.posById[tri.vertices[0]], context.posById[tri.vertices[1]], context.posById[tri.vertices[2]]) / 2;
      if (!(area > minTriangleArea)) {
        return buildLayoutError({ message: 'AreaGrad initialization failed: degenerate augmented triangle' });
      }
    }

    return buildLayoutResult({
      opts: settings,
      graph: context.graph,
      baseEmbedding: context.baseEmbedding,
      outerFace: context.augmentedOuterFace,
      augmented: context.augmented,
      posById: context.posById,
      areaGradData: areaGradData,
      movableVertices: context.movableVertices
    });
  }

  function prepareAreaGradState(graph, options) {
    var settings = buildAreaGradSettings(options);
    var context = LayoutPreprocessing.prepareGraphAndLayoutData(graph, {
      failureLabel: 'AreaGrad layout',
      augmentationMethod: settings.augmentationMethod,
      augmentationOptions: settings.augmentationOptions,
      currentPositions: settings.currentPositions
    });
    return buildAreaGradStateFromPrepared(context, settings);
  }

  async function runAreaGradIterations(prepared, options) {
    var g = prepared.graph;
    var posById = prepared.posById;
    var areaGradData = prepared.areaGradData;
    var movableVertices = prepared.movableVertices || [];
    var outerDiameter = outerFaceDiameter(posById, prepared.outerFace);
    options.maxVertexMove = options.maxVertexMoveRel * outerDiameter;
    options.minTriangleArea = effectiveMinTriangleArea(areaGradData, options);
    var status = 'max_iters';
    var lastMoveStats = { movedVertices: 0, totalMove: 0, avgMove: 0, maxMove: 0 };
    var state = computeAreaGradState(areaGradData, posById, options);

    if (!state.ok) {
      return buildLayoutError({
        ok: false,
        status: 'invalid',
        reason: state.reason || 'AreaGrad initialization failed'
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
        return maxIncidentResidual(b, areaGradData, state.residuals || []) - maxIncidentResidual(a, areaGradData, state.residuals || []);
      });

      for (var vi = 0; vi < sweepVertices.length; vi += 1) {
        var vertexId = sweepVertices[vi];
        var delta = computeLocalDelta(vertexId, areaGradData, posById, state.residuals || [], options);
        if (!(delta.norm > AREAGRAD_INTERNAL.tolGrad)) {
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
          if (!incidentTrianglesStayPositive(vertexId, areaGradData, posById, options.minTriangleArea)) {
            posById[vertexId] = basePos;
            stepScale *= options.stepShrink;
            lineSearchSteps += 1;
            continue;
          }
          var trialState = computeAreaGradState(areaGradData, posById, options);
          if (trialState.ok &&
              trialState.objective <= state.objective - AREAGRAD_INTERNAL.acceptanceTol * Math.max(1, state.objective)) {
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
            boundedFaceCount: areaGradData.triangles.length
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
      boundedFaceCount: areaGradData.triangles.length,
      dummyCount: prepared.augmented ? prepared.augmented.dummyCount : 0,
      hasCrossings: hasCrossings
    };
  }

  function prepareGraphData(graph, options) {
    var settings = buildAreaGradSettings(options);
    return LayoutPreprocessing.prepareGraphAndLayoutData(graph, {
      failureLabel: 'AreaGrad layout',
      augmentationMethod: settings.augmentationMethod,
      augmentationOptions: settings.augmentationOptions,
      currentPositions: settings.currentPositions
    });
  }

  async function computePositions(graph, layoutInput) {
    return computeAreaGradPositionsFromPrepared(graph, null, layoutInput);
  }

  async function computeAreaGradPositions(graph, options) {
    var prepared = prepareAreaGradState(graph, options);
    if (!prepared || !prepared.ok) {
      return buildLayoutError(prepared || { message: 'AreaGrad setup failed' });
    }
    return finishAreaGradPositions(prepared, prepared.opts);
  }

  async function computeAreaGradPositionsFromPrepared(_graph, options, prepared) {
    var state = buildAreaGradStateFromPrepared(prepared, options);
    if (!state || !state.ok) {
      return buildLayoutError(state || { message: 'AreaGrad setup failed' });
    }
    return finishAreaGradPositions(state, state.opts || options || {});
  }

  async function finishAreaGradPositions(state, options) {
    var finalPositions = filterPositions(state.posById, state.graph.nodeIds);

    if (state.areaGradData.triangles.length === 0) {
      return buildLayoutResult({
        status: 'realized',
        positions: finalPositions,
        debugPositions: state.posById,
        graph: state.graph,
        outerFace: state.outerFace,
        augmented: state.augmented,
        areaGradData: state.areaGradData,
        boundedFaceCount: 0,
        dummyCount: state.augmented.dummyCount,
        iters: 0,
        maxRelError: 0,
        faceAreaScore: null
      });
    }

    var result = await runAreaGradIterations(state, options);

    if (!result.ok && result.reason) {
      return buildLayoutError({
        status: result.status,
        graph: state.graph,
        outerFace: state.outerFace,
        augmented: state.augmented,
        message: result.reason
      });
    }
    if (result.hasCrossings) {
      return buildLayoutError({
        status: result.status,
        graph: state.graph,
        outerFace: state.outerFace,
        augmented: state.augmented,
        message: 'AreaGrad produced a non-plane drawing'
      });
    }

    var faceScore = Metrics.computeUniformFaceAreaScore(state.graph.nodeIds, state.graph.edgePairs, state.posById, state.baseEmbedding);
    var lastStats = result.stats || {};
    finalPositions = filterPositions(state.posById, state.graph.nodeIds);

    return buildLayoutResult({
      status: result.status,
      positions: finalPositions,
      debugPositions: state.posById,
      graph: state.graph,
      outerFace: state.outerFace,
      augmented: state.augmented,
      areaGradData: state.areaGradData,
      iters: result.iters,
      faceAreaScore: faceScore && faceScore.ok ? faceScore.quality : null,
      maxRelError: Number.isFinite(lastStats.maxRelError) ? lastStats.maxRelError : null,
      boundedFaceCount: state.areaGradData.triangles.length,
      dummyCount: state.augmented.dummyCount
    });
  }

  async function applyAreaGradLayout(cy, options) {
    return CyRuntime.runLayout(cy, options, {
      prepareMode: 'graph+layout',
      prepareFailureLabel: 'AreaGrad layout',
      initialFitBounds: function (ctx) {
        return CyRuntime.computePositionBounds(ctx.prepared.posById);
      },
      computePositions: computeAreaGradPositionsFromPrepared,
      buildResult: function (ctx) {
        var result = ctx.result;
        var message = buildLayoutStatusMessage('AreaGrad', {
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
              result.debugPositions || result.positions
            )
            : null
        };
      },
      failureMessage: 'AreaGrad failed'
    });
  }

	  global.PlanarVibeAreaGrad = {
	    prepareGraphData: prepareGraphData,
	    computePositions: computePositions,
	    applyLayout: applyAreaGradLayout
	  };
})(window);
