(function (global) {
  'use strict';

  var GraphUtils = global.GraphUtils;
  var GeometryUtils = global.GeometryUtils;
  var LayoutPreprocessing = global.LayoutPreprocessing;
  var Metrics = global.PlanarVibeMetrics;
  var CyRuntime = global.CyRuntime;
  var Tutte = global.PlanarVibeTutte;
  var buildLayoutError = GraphUtils.buildLayoutError;
  var buildLayoutResult = GraphUtils.buildLayoutResult;
  var buildLayoutStatusMessage = GraphUtils.buildLayoutStatusMessage;
  var collectMovableVertices = GraphUtils.collectMovableVertices;
  var computeDrawingDiameter = GeometryUtils.computeDrawingDiameter;
  var computeDistributionQuality = Metrics.computeDistributionQuality;
  var computePositionMoveStats = GraphUtils.computePositionMoveStats;
  var createAugmentationDebugState = LayoutPreprocessing.createAugmentationDebugState;
  var createMovementConvergenceTracker = GraphUtils.createMovementConvergenceTracker;
  var edgeKey = GraphUtils.edgeKey;
  var filterPositions = GeometryUtils.filterPositionMap;
  var findOuterFaceIndex = global.PlanarGraphUtils.findOuterFaceIndex;
  var polygonAreaAbs = GeometryUtils.polygonAreaAbs;
  var resolveFloatOption = GraphUtils.resolveFloatOption;
  var resolveFunctionOption = GraphUtils.resolveFunctionOption;
  var resolveIntOption = GraphUtils.resolveIntOption;
  var resolveNonNegativeOption = GraphUtils.resolveNonNegativeOption;

  function solveWeighted(prepared, weights) {
    return Tutte.computeBarycentricPositions(prepared.augmentedGraph, prepared.outerFace, {
      adjacency: prepared.adj,
      weights: weights,
      initOptions: Tutte.defaultOuterPlacementOptions({
        fixedOuterPos: prepared.fixedOuterPos
      })
    });
  }

  function buildEdgeToFaceMap(faces) {
    var map = {};
    for (var i = 0; i < faces.length; i += 1) {
      var face = faces[i];
      for (var j = 0; j < face.length; j += 1) {
        var u = String(face[j]);
        var v = String(face[(j + 1) % face.length]);
        var k = edgeKey(u, v);
        if (!map[k]) map[k] = [];
        map[k].push(i);
      }
    }
    return map;
  }

  function updateFacePressures(prepared, faceAreas, facePressure) {
    var options = prepared.opts;
    var boundedFaceIdx = prepared.boundedFaceIdx;
    var next = facePressure.slice();
    var sum = 0;
    var cnt = 0;
    for (var i = 0; i < boundedFaceIdx.length; i += 1) {
      var fi = boundedFaceIdx[i];
      var area = faceAreas[fi];
      if (!Number.isFinite(area) || !(area > 1e-12)) continue;
      var delta = Math.log(Math.max(prepared.desired, 1e-12) / Math.max(area, 1e-12));
      if (delta < -options.pressureDeltaClamp) delta = -options.pressureDeltaClamp;
      if (delta > options.pressureDeltaClamp) delta = options.pressureDeltaClamp;
      var p = next[fi] + options.pressureStep * delta;
      if (p < -options.pressureClamp) p = -options.pressureClamp;
      if (p > options.pressureClamp) p = options.pressureClamp;
      next[fi] = p;
      sum += p;
      cnt += 1;
    }
    // Remove constant offset for numerical stability.
    var mean = cnt > 0 ? (sum / cnt) : 0;
    if (cnt > 0 && Math.abs(mean) > 1e-12) {
      for (i = 0; i < boundedFaceIdx.length; i += 1) {
        fi = boundedFaceIdx[i];
        next[fi] -= mean;
      }
    }
    return next;
  }

  function adjustWeights(prepared, faceAreas, oldWeights, facePressure) {
    var edgePairs = prepared.augmented.graph.edgePairs;
    var outerSet = new Set(prepared.outerFace.map(String));
    var options = prepared.opts;
    var newWeights = {};
    var sumW = 0;
    var cnt = 0;

    for (var i = 0; i < edgePairs.length; i += 1) {
      var u = String(edgePairs[i][0]);
      var v = String(edgePairs[i][1]);
      var k = edgeKey(u, v);
      var wOld = oldWeights[k];
      if (!Number.isFinite(wOld) || wOld <= 0) wOld = 1;

      if (outerSet.has(u) && outerSet.has(v)) {
        newWeights[k] = wOld;
        continue;
      }

      var facesIdx = prepared.e2f[k] || [];
      var areaSum = 0;
      var areaCnt = 0;
      for (var j = 0; j < facesIdx.length; j += 1) {
        var fi = facesIdx[j];
        var a = faceAreas[fi];
        if (Number.isFinite(a) && a > 0) {
          areaSum += a;
          areaCnt += 1;
        }
      }
      if (areaCnt === 0) {
        newWeights[k] = wOld;
        sumW += newWeights[k];
        cnt += 1;
        continue;
      }

      var penalty = (areaSum / areaCnt) / Math.max(prepared.desired, 1e-12);
      var scale = penalty > 1 ? Math.sqrt(penalty) : penalty;
      if (scale < options.scaleMin) scale = options.scaleMin;
      if (scale > options.scaleMax) scale = options.scaleMax;

      var pSum = 0;
      var pCnt = 0;
      for (j = 0; j < facesIdx.length; j += 1) {
        fi = facesIdx[j];
        if (!prepared.boundedSet.has(fi)) continue;
        var p = facePressure[fi];
        if (Number.isFinite(p)) {
          pSum += p;
          pCnt += 1;
        }
      }
      if (pCnt > 0 && options.pressureBeta > 0) {
        var pressureScale = Math.exp(-options.pressureBeta * (pSum / pCnt));
        if (pressureScale < options.pressureScaleMin) pressureScale = options.pressureScaleMin;
        if (pressureScale > options.pressureScaleMax) pressureScale = options.pressureScaleMax;
        scale *= pressureScale;
      }

      var wNew = wOld * scale;
      if (wNew < 1e-4) wNew = 1e-4;
      if (wNew > 1e4) wNew = 1e4;
      newWeights[k] = wNew;
      sumW += wNew;
      cnt += 1;
    }

    var avg = cnt > 0 ? (sumW / cnt) : 1;
    if (!(avg > 0)) avg = 1;
    for (i = 0; i < edgePairs.length; i += 1) {
      var ek = edgeKey(edgePairs[i][0], edgePairs[i][1]);
      newWeights[ek] = (newWeights[ek] || 1) / avg;
    }

    return newWeights;
  }

  function computeFaceAreaIterationStats(faceAreas, boundedFaceIdx) {
    var values = [];
    for (var i = 0; i < boundedFaceIdx.length; i += 1) {
      var area = faceAreas[boundedFaceIdx[i]];
      if (Number.isFinite(area) && area > 1e-12) {
        values.push(area);
      }
    }
    if (values.length === 0) {
      return null;
    }

    var sum = 0;
    var j;
    for (j = 0; j < values.length; j += 1) {
      sum += values[j];
    }
    if (!(sum > 0)) {
      return null;
    }

    for (j = 0; j < values.length; j += 1) {
      values[j] /= sum;
    }
    values.sort(function (a, b) { return a - b; });

    var ideal = 1 / values.length;
    var minVal = values[0];
    var maxVal = values[values.length - 1];
    var score = computeDistributionQuality(values);

    return {
      score: Number.isFinite(score) ? score : null,
      minRatio: minVal / ideal,
      maxRatio: maxVal / ideal,
      faceCount: values.length
    };
  }

  function fillReweightSettings(options) {
    var scaleMin = resolveFloatOption(options.scaleMin, 0.25, 0.01);
    var pressureScaleMin = resolveFloatOption(options.pressureScaleMin, 1.0, 0.01);
    options.augmentationMethod = options.augmentationMethod || null;
    options.maxOuterIters = resolveIntOption(options.maxOuterIters, 8, 1);
    options.pressureStep = resolveFloatOption(options.pressureStep, 0.16, 0);
    options.pressureClamp = resolveFloatOption(options.pressureClamp, 1.20, 0.05);
    options.pressureBeta = resolveFloatOption(options.pressureBeta, 0.18, 0);
    options.pressureDeltaClamp = resolveFloatOption(options.pressureDeltaClamp, 0.75, 0.05);
    options.scaleMin = scaleMin;
    options.scaleMax = resolveFloatOption(options.scaleMax, 10.0, scaleMin);
    options.pressureScaleMin = pressureScaleMin;
    options.pressureScaleMax = resolveFloatOption(options.pressureScaleMax, 1.25, pressureScaleMin);
    options.minItersBeforeStop = resolveIntOption(options.minItersBeforeStop, 8, 1);
    options.stableIterLimit = resolveIntOption(options.stableIterLimit, 4, 1);
    options.movementStopTol = resolveNonNegativeOption(options.movementStopTol, null);
    options.avgMovementStopTol = resolveNonNegativeOption(options.avgMovementStopTol, null);
    options.onIteration = resolveFunctionOption(options.onIteration, null);
  }

  function buildReweightStateFromPrepared(context, options) {
    fillReweightSettings(options);
    if (!context || !context.ok) {
      return buildLayoutError(context || {
        message: 'ReweightTutte setup failed',
        graph: context && context.graph ? context.graph : null
      });
    }

    var g = context.graph;
    var outer = context.augmentedOuterFace;
    var augmented = context.augmented;
    var embAug = augmented.embedding;

    var faces = embAug.faces || [];
    var outerFaceIdx = findOuterFaceIndex(faces, outer);
    if (outerFaceIdx < 0 || !outer || outer.length < 3) {
      return buildLayoutError({
        message: 'Shared initialization produced an invalid augmented outer face',
        graph: g,
        augmented: augmented
      });
    }
    var boundedFaceIdx = [];
    for (var i = 0; i < faces.length; i += 1) {
      if (i !== outerFaceIdx) boundedFaceIdx.push(i);
    }
    if (boundedFaceIdx.length === 0) {
      return buildLayoutError({
        message: 'No bounded faces',
        graph: g,
        outerFace: outer,
        augmented: augmented
      });
    }

    var e2f = buildEdgeToFaceMap(faces);
    var weights = {};
    for (i = 0; i < augmented.graph.edgePairs.length; i += 1) {
      weights[edgeKey(augmented.graph.edgePairs[i][0], augmented.graph.edgePairs[i][1])] = 1;
    }
    var facePressure = new Array(faces.length).fill(0);
    var boundedSet = new Set(boundedFaceIdx);
    var desired = 1 / boundedFaceIdx.length;
    var fixedOuterPos = filterPositions(context.posById, outer);
    var currentPos = context.posById;
    var movableVertices = collectMovableVertices(augmented.graph.nodeIds, outer);
    var movementScale = computeDrawingDiameter(augmented.graph.nodeIds, currentPos);
    var movementTracker = createMovementConvergenceTracker({
      minItersBeforeStop: options.minItersBeforeStop,
      stableIterLimit: options.stableIterLimit,
      maxMoveTol: options.movementStopTol !== null ? options.movementStopTol : 1e-4 * movementScale,
      avgMoveTol: options.avgMovementStopTol !== null ? options.avgMovementStopTol : 2e-5 * movementScale
    });

    return {
      ok: true,
      opts: options,
      graph: g,
      outerFace: outer,
      augmented: augmented,
      augmentedGraph: context.augmentedGraph,
      faces: faces,
      boundedFaceIdx: boundedFaceIdx,
      adj: context.augmentedGraph.adjacency,
      e2f: e2f,
      weights: weights,
      facePressure: facePressure,
      boundedSet: boundedSet,
      desired: desired,
      fixedOuterPos: fixedOuterPos,
      currentPos: currentPos,
      initIters: context.initResult && Number.isFinite(context.initResult.iters) ? context.initResult.iters : 0,
      movableVertices: movableVertices,
      movementTracker: movementTracker
    };
  }

  async function runReweightIterations(prepared, options) {
    var outer = prepared.outerFace;
    var augmented = prepared.augmented;
    var faces = prepared.faces;
    var boundedFaceIdx = prepared.boundedFaceIdx;
    var weights = prepared.weights;
    var facePressure = prepared.facePressure;
    var currentPos = prepared.currentPos;
    var totalInnerIters = prepared.initIters || 0;
    var stopReason = 'max-iters';
    var performedOuterIters = 0;
    var finalIterationStats = null;

    for (var iter = 0; iter < options.maxOuterIters; iter += 1) {
      var prevPos = currentPos;
      var inner = solveWeighted(prepared, weights);
      totalInnerIters += inner.iters;
      performedOuterIters = iter + 1;

      var pos = inner.positions;
      currentPos = pos;
      var moveStats = computePositionMoveStats(prepared.movableVertices, prevPos, pos, { moveTol: 1e-9 });
      var movementStatus = prepared.movementTracker.update({
        maxMove: moveStats.maxMove,
        avgMove: moveStats.avgMove
      }, iter + 1);

      var outerArea = polygonAreaAbs(outer, pos);
      if (!(outerArea > 1e-12)) outerArea = 1;
      var faceAreas = [];
      for (var i = 0; i < faces.length; i += 1) {
        faceAreas[i] = polygonAreaAbs(faces[i], pos) / outerArea;
      }
      var iterStats = computeFaceAreaIterationStats(faceAreas, boundedFaceIdx);
      finalIterationStats = iterStats;

      facePressure = updateFacePressures(prepared, faceAreas, facePressure);
      weights = adjustWeights(prepared, faceAreas, weights, facePressure);
      if (options.onIteration) {
        await options.onIteration({
          iter: iter + 1,
          maxIters: options.maxOuterIters,
          positions: pos,
          faceAreaScore: iterStats ? iterStats.score : null,
          movedVertices: moveStats.movedVertices,
          maxMove: moveStats.maxMove,
          avgMove: moveStats.avgMove,
          debug: {
            outerFace: outer.slice(),
            faceAreaMinRatio: iterStats ? iterStats.minRatio : null,
            faceAreaMaxRatio: iterStats ? iterStats.maxRatio : null,
            boundedFaceCount: iterStats ? iterStats.faceCount : boundedFaceIdx.length,
            stableIterCount: movementStatus.stableIterations,
            stableIterLimit: movementStatus.stableIterLimit
          }
        });
      }
      if (movementStatus.converged) {
        stopReason = movementStatus.reason || 'movement-converged';
        break;
      }
    }

    var finalLayout = solveWeighted(prepared, weights);
    totalInnerIters += finalLayout.iters;
    var finalPositions = filterPositions(finalLayout.positions, prepared.graph.nodeIds);

    return buildLayoutResult({
      graph: prepared.graph,
      outerFace: outer,
      augmented: augmented,
      positions: finalPositions,
      debugPositions: finalLayout.positions,
      iters: totalInnerIters,
      stopReason: stopReason,
      outerSteps: performedOuterIters,
      faceAreaScore: finalIterationStats ? finalIterationStats.score : null,
      boundedFaceCount: finalIterationStats ? finalIterationStats.faceCount : boundedFaceIdx.length,
      faceAreaMinRatio: finalIterationStats ? finalIterationStats.minRatio : null,
      faceAreaMaxRatio: finalIterationStats ? finalIterationStats.maxRatio : null
    });
  }

  async function computeReweightTuttePositions(graph, options) {
    var prepared = buildReweightStateFromPrepared(LayoutPreprocessing.prepareGraphAndLayoutData(graph, {
      failureLabel: 'ReweightTutte',
      augmentationMethod: options.augmentationMethod,
      currentPositions: options.currentPositions
    }), options);
    if (!prepared || !prepared.ok) {
      return buildLayoutError(prepared || { message: 'ReweightTutte setup failed' });
    }
    return runReweightIterations(prepared, prepared.opts);
  }

  async function computeReweightTuttePositionsFromPrepared(_graph, options, prepared) {
    var opts = options || {};
    var state = buildReweightStateFromPrepared(prepared, opts);
    if (!state || !state.ok) {
      return buildLayoutError(state || { message: 'ReweightTutte setup failed' });
    }
    return runReweightIterations(state, state.opts);
  }

  async function applyReweightTutteLayout(cy, options) {
    return CyRuntime.runLayout(cy, options, {
      prepareMode: 'graph+layout',
      prepareFailureLabel: 'ReweightTutte layout',
      initialFitBounds: function (ctx) {
        return CyRuntime.computePositionBounds(ctx.prepared.posById);
      },
      computePositions: computeReweightTuttePositionsFromPrepared,
      buildResult: function (ctx) {
        var result = ctx.result;
        return {
          ok: true,
          stopReason: result.stopReason,
          message: buildLayoutStatusMessage('ReweightTutte', {
            outerFaceVertexCount: result.outerFace.length,
            dummyCount: result.augmented.dummyCount,
            iters: result.iters,
            outerSteps: result.outerSteps,
            stopReason: result.stopReason
          }),
          faceAreaScore: result.faceAreaScore,
          faceAreaMinRatio: result.faceAreaMinRatio,
          faceAreaMaxRatio: result.faceAreaMaxRatio,
          boundedFaceCount: result.boundedFaceCount,
          debugState: createAugmentationDebugState(
            result.graph,
            result.augmented,
            result.debugPositions || result.positions
          )
        };
      },
      failureMessage: 'ReweightTutte failed'
    });
  }

  global.PlanarVibeReweightTutte = {
    computeReweightTuttePositions: computeReweightTuttePositions,
    applyReweightTutteLayout: applyReweightTutteLayout
  };
})(window);
