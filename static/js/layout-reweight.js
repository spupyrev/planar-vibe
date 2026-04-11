(function (global) {
  'use strict';

  var GraphUtils = global.GraphUtils;
  var GeometryUtils = global.GeometryUtils;
  var LayoutPreprocessing = global.LayoutPreprocessing;
  var Metrics = global.PlanarVibeMetrics;
  var CyRuntime = global.CyRuntime;
  var Tutte = global.PlanarVibeTutteAlgorithm;
  var buildLayoutError = GraphUtils.buildLayoutError;
  var buildLayoutResult = GraphUtils.buildLayoutResult;
  var buildLayoutStatusMessage = GraphUtils.buildLayoutStatusMessage;
  var collectMovableVertices = GraphUtils.collectMovableVertices;
  var computeDrawingDiameter = GeometryUtils.computeDrawingDiameter;
  var computeDistributionQuality = Metrics && Metrics.computeDistributionQuality;
  var computePositionMoveStats = GraphUtils.computePositionMoveStats;
  var createAugmentationDebugState = LayoutPreprocessing.createAugmentationDebugState;
  var createMovementConvergenceTracker = GraphUtils.createMovementConvergenceTracker;
  var createGraph = GraphUtils.createGraph;
  var edgeKey = GraphUtils.edgeKey;
  var findOuterFaceIndex = global.PlanarGraphUtils.findOuterFaceIndex;
  var polygonAreaAbs = GeometryUtils.polygonAreaAbs;
  var resolveFloatOption = GraphUtils.resolveFloatOption;
  var resolveFunctionOption = GraphUtils.resolveFunctionOption;
  var resolveIntOption = GraphUtils.resolveIntOption;
  var resolveNonNegativeOption = GraphUtils.resolveNonNegativeOption;

  function barycentricLayoutWeighted(nodeIds, adj, outerFace, weights, maxIters, fixedOuterPos) {
    return Tutte.computeBarycentricPositions(createGraph(nodeIds, []), outerFace, {
      adjacency: adj,
      weights: weights,
      maxIters: maxIters,
      tolerance: 1e-8,
      initOptions: Tutte.defaultOuterPlacementOptions({
        fixedOuterPos: fixedOuterPos || null
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

  function updateFacePressures(faceAreas, boundedFaceIdx, desired, facePressure, stepSize, clampValue, deltaClamp) {
    var next = facePressure.slice();
    var safeStep = Number.isFinite(stepSize) ? Math.max(0, stepSize) : 0.08;
    var safeClamp = Number.isFinite(clampValue) ? Math.max(0.05, clampValue) : 0.7;
    var safeDeltaClamp = Number.isFinite(deltaClamp) ? Math.max(0.05, deltaClamp) : 1.0;
    var sum = 0;
    var cnt = 0;
    for (var i = 0; i < boundedFaceIdx.length; i += 1) {
      var fi = boundedFaceIdx[i];
      var area = faceAreas[fi];
      if (!Number.isFinite(area) || !(area > 1e-12)) continue;
      var delta = Math.log(Math.max(desired, 1e-12) / Math.max(area, 1e-12));
      if (delta < -safeDeltaClamp) delta = -safeDeltaClamp;
      if (delta > safeDeltaClamp) delta = safeDeltaClamp;
      var p = next[fi] + safeStep * delta;
      if (p < -safeClamp) p = -safeClamp;
      if (p > safeClamp) p = safeClamp;
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

  function adjustWeights(edgePairs, outerFace, faces, faceAreas, desired, oldWeights, facePressure, e2f, boundedSet, pressureBeta, scaleMin, scaleMax, pressureScaleMin, pressureScaleMax) {
    var outerSet = new Set((outerFace || []).map(String));
    var newWeights = {};
    var sumW = 0;
    var cnt = 0;
    var beta = Number.isFinite(pressureBeta) ? Math.max(0, pressureBeta) : 0.12;
    var sMin = Number.isFinite(scaleMin) ? Math.max(0.01, scaleMin) : 0.2;
    var sMax = Number.isFinite(scaleMax) ? Math.max(sMin, scaleMax) : 10.0;
    var psMin = Number.isFinite(pressureScaleMin) ? Math.max(0.01, pressureScaleMin) : 0.85;
    var psMax = Number.isFinite(pressureScaleMax) ? Math.max(psMin, pressureScaleMax) : 1.15;

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

      var facesIdx = e2f[k] || [];
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

      var penalty = (areaSum / areaCnt) / Math.max(desired, 1e-12);
      var scale = penalty > 1 ? Math.sqrt(penalty) : penalty;
      if (scale < sMin) scale = sMin;
      if (scale > sMax) scale = sMax;

      var pSum = 0;
      var pCnt = 0;
      for (j = 0; j < facesIdx.length; j += 1) {
        fi = facesIdx[j];
        if (!boundedSet[fi]) continue;
        var p = facePressure[fi];
        if (Number.isFinite(p)) {
          pSum += p;
          pCnt += 1;
        }
      }
      if (pCnt > 0 && beta > 0) {
        var pressureScale = Math.exp(-beta * (pSum / pCnt));
        if (pressureScale < psMin) pressureScale = psMin;
        if (pressureScale > psMax) pressureScale = psMax;
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

    var normalized = [];
    for (j = 0; j < values.length; j += 1) {
      normalized.push(values[j] / sum);
    }
    normalized.sort(function (a, b) { return a - b; });

    var ideal = 1 / normalized.length;
    var minVal = normalized[0];
    var maxVal = normalized[normalized.length - 1];
    var score = null;
    if (typeof computeDistributionQuality === 'function') {
      score = computeDistributionQuality(normalized);
    }

    return {
      score: Number.isFinite(score) ? score : null,
      minRatio: minVal / ideal,
      maxRatio: maxVal / ideal,
      faceCount: normalized.length
    };
  }

  function normalizeReweightOptions(options) {
    var opts = options || {};
    var scaleMin = resolveFloatOption(opts.scaleMin, 0.25, 0.01);
    var pressureScaleMin = resolveFloatOption(opts.pressureScaleMin, 1.0, 0.01);
    return {
      augmentationMethod: opts.augmentationMethod || null,
      currentPositions: opts.currentPositions || null,
      maxOuterIters: resolveIntOption(opts.maxOuterIters, 8, 1),
      pressureStep: resolveFloatOption(opts.pressureStep, 0.16, 0),
      pressureClamp: resolveFloatOption(opts.pressureClamp, 1.20, 0.05),
      pressureBeta: resolveFloatOption(opts.pressureBeta, 0.18, 0),
      innerIters: resolveIntOption(opts.innerIters, 3000, 1),
      finalIters: resolveIntOption(opts.finalIters, 3000, 1),
      pressureDeltaClamp: resolveFloatOption(opts.pressureDeltaClamp, 0.75, 0.05),
      scaleMin: scaleMin,
      scaleMax: resolveFloatOption(opts.scaleMax, 10.0, scaleMin),
      pressureScaleMin: pressureScaleMin,
      pressureScaleMax: resolveFloatOption(opts.pressureScaleMax, 1.25, pressureScaleMin),
      minItersBeforeStop: resolveIntOption(opts.minItersBeforeStop, 8, 1),
      stableIterLimit: resolveIntOption(opts.stableIterLimit, 4, 1),
      movementStopTol: resolveNonNegativeOption(opts.movementStopTol, null),
      avgMovementStopTol: resolveNonNegativeOption(opts.avgMovementStopTol, null),
      onIteration: resolveFunctionOption(opts.onIteration, null)
    };
  }

  function prepareReweightState(graph, options) {
    var opts = normalizeReweightOptions(options);
    var context = LayoutPreprocessing.prepareGraphAndLayoutData(graph, {
      failureLabel: 'ReweightTutte',
      augmentationMethod: opts.augmentationMethod,
      currentPositions: opts.currentPositions || null
    });
    if (!context || !context.ok) {
      return buildLayoutError(context || {
        message: 'ReweightTutte setup failed',
        graph: graph
      });
    }

    var g = context.graph;
    var outer = context.augmentedOuterFace || context.outerFace;
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

    var adj = context.augmentedGraph.adjacency;
    var e2f = buildEdgeToFaceMap(faces);
    var weights = {};
    for (i = 0; i < augmented.graph.edgePairs.length; i += 1) {
      weights[edgeKey(augmented.graph.edgePairs[i][0], augmented.graph.edgePairs[i][1])] = 1;
    }
    var facePressure = [];
    for (i = 0; i < faces.length; i += 1) facePressure[i] = 0;
    var boundedSet = {};
    for (i = 0; i < boundedFaceIdx.length; i += 1) boundedSet[boundedFaceIdx[i]] = true;
    var desired = 1 / boundedFaceIdx.length;
    var fixedOuterPos = {};
    var initPos = context.posById;
    for (var oi = 0; oi < outer.length; oi += 1) {
      var ov = String(outer[oi]);
      fixedOuterPos[ov] = { x: initPos[ov].x, y: initPos[ov].y };
    }
    var currentPos = context.posById;
    var movableVertices = collectMovableVertices(augmented.graph.nodeIds, outer);
    var movementScale = computeDrawingDiameter(augmented.graph.nodeIds, currentPos);
    var movementTracker = createMovementConvergenceTracker({
      minItersBeforeStop: opts.minItersBeforeStop,
      stableIterLimit: opts.stableIterLimit,
      maxMoveTol: opts.movementStopTol !== null ? opts.movementStopTol : 1e-4 * movementScale,
      avgMoveTol: opts.avgMovementStopTol !== null ? opts.avgMovementStopTol : 2e-5 * movementScale
    });

    return {
      ok: true,
      opts: opts,
      graph: g,
      outerFace: outer,
      augmented: augmented,
      faces: faces,
      boundedFaceIdx: boundedFaceIdx,
      adj: adj,
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
    var opts = Object.assign({}, prepared && prepared.opts ? prepared.opts : {}, options || {});
    var g = prepared.graph;
    var outer = prepared.outerFace;
    var augmented = prepared.augmented;
    var faces = prepared.faces;
    var boundedFaceIdx = prepared.boundedFaceIdx;
    var adj = prepared.adj;
    var e2f = prepared.e2f;
    var weights = prepared.weights;
    var facePressure = prepared.facePressure;
    var boundedSet = prepared.boundedSet;
    var desired = prepared.desired;
    var fixedOuterPos = prepared.fixedOuterPos;
    var currentPos = prepared.currentPos;
    var movableVertices = prepared.movableVertices;
    var movementTracker = prepared.movementTracker;
    var totalInnerIters = prepared.initIters || 0;
    var stopReason = 'max-iters';
    var performedOuterIters = 0;
    var finalIterationStats = null;

    for (var iter = 0; iter < opts.maxOuterIters; iter += 1) {
      var prevPos = currentPos;
      var inner = barycentricLayoutWeighted(augmented.graph.nodeIds, adj, outer, weights, opts.innerIters, fixedOuterPos);
      totalInnerIters += inner.iters;
      performedOuterIters = iter + 1;

      var pos = inner.positions;
      currentPos = pos;
      var moveStats = computePositionMoveStats(movableVertices, prevPos, pos, { moveTol: 1e-9 });
      var movementStatus = movementTracker.update({
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

      facePressure = updateFacePressures(faceAreas, boundedFaceIdx, desired, facePressure, opts.pressureStep, opts.pressureClamp, opts.pressureDeltaClamp);
      weights = adjustWeights(
        augmented.graph.edgePairs,
        outer,
        faces,
        faceAreas,
        desired,
        weights,
        facePressure,
        e2f,
        boundedSet,
        opts.pressureBeta,
        opts.scaleMin,
        opts.scaleMax,
        opts.pressureScaleMin,
        opts.pressureScaleMax
      );
      if (typeof opts.onIteration === 'function') {
        await opts.onIteration({
          iter: iter + 1,
          maxIters: opts.maxOuterIters,
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

    var finalLayout = barycentricLayoutWeighted(augmented.graph.nodeIds, adj, outer, weights, opts.finalIters, fixedOuterPos);
    totalInnerIters += finalLayout.iters;

    return buildLayoutResult({
      ok: true,
      graph: g,
      outerFace: outer,
      augmented: augmented,
      positions: finalLayout.positions,
      iters: totalInnerIters,
      stopReason: stopReason,
      totalInnerIters: totalInnerIters,
      outerSteps: performedOuterIters,
      faceAreaScore: finalIterationStats ? finalIterationStats.score : null,
      boundedFaceCount: finalIterationStats ? finalIterationStats.faceCount : boundedFaceIdx.length,
      faceAreaMinRatio: finalIterationStats ? finalIterationStats.minRatio : null,
      faceAreaMaxRatio: finalIterationStats ? finalIterationStats.maxRatio : null
    });
  }

  async function computeReweightTuttePositions(graph, options) {
    var prepared = prepareReweightState(graph, options);
    if (!prepared || !prepared.ok) {
      return buildLayoutError(prepared || { message: 'ReweightTutte setup failed' });
    }
    return runReweightIterations(prepared, prepared.opts);
  }

  async function applyReweightTutteLayout(cy, options) {
    return CyRuntime.runLayout(cy, options || {}, {
      useSharedPreparedSeed: true,
      sharedSeedFailureLabel: 'ReweightTutte layout',
      compute: computeReweightTuttePositions,
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
            result.positions
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
