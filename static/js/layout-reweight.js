(function (global) {
  'use strict';

  var GraphUtils = global.GraphUtils;
  var Metrics = global.PlanarVibeMetrics;
  var PlaygroundUtils = global.PlaygroundUtils;
  var Tutte = global.PlanarVibeTutteAlgorithm;
  var alignOuterFaceEdgeHorizontally = GraphUtils.alignOuterFaceEdgeHorizontally;
  var buildAdjacencyArrays = GraphUtils.buildAdjacencyArrays;
  var chooseOuterFaceFromEmbedding = GraphUtils.chooseOuterFaceFromEmbedding;
  var collectMovableVertices = GraphUtils.collectMovableVertices;
  var computeDrawingDiameter = GraphUtils.computeDrawingDiameter;
  var computeDistributionQuality = Metrics && Metrics.computeDistributionQuality;
  var computePositionMoveStats = GraphUtils.computePositionMoveStats;
  var createAugmentationDebugState = PlaygroundUtils.createAugmentationDebugState;
  var createMovementConvergenceTracker = GraphUtils.createMovementConvergenceTracker;
  var edgeKey = GraphUtils.edgeKey;
  var findOuterFaceIndex = GraphUtils.findOuterFaceIndex;
  var polygonAreaAbs = GraphUtils.polygonAreaAbs;

  function buildOuterFacePositions(nodeIds, outerFace, fixedOuterPos) {
    var pos = Tutte.placeOuterFaceVertices(
      nodeIds,
      outerFace,
      Tutte.defaultOuterPlacementOptions({
        useSeedOuter: false
      })
    );
    if (!fixedOuterPos) {
      return pos;
    }
    for (var i = 0; i < outerFace.length; i += 1) {
      var fv = String(outerFace[i]);
      if (fixedOuterPos[fv] && Number.isFinite(fixedOuterPos[fv].x) && Number.isFinite(fixedOuterPos[fv].y)) {
        pos[fv] = { x: fixedOuterPos[fv].x, y: fixedOuterPos[fv].y };
      }
    }
    return alignOuterFaceEdgeHorizontally(pos, outerFace);
  }

  function barycentricLayoutWeighted(nodeIds, adj, outerFace, weights, maxIters, fixedOuterPos) {
    var pos = buildOuterFacePositions(nodeIds, outerFace, fixedOuterPos);
    var outerSet = new Set(outerFace.map(String));
    var iters = 0;
    var converged = false;

    while (!converged && iters < maxIters) {
      converged = true;
      iters += 1;
      for (var i = 0; i < nodeIds.length; i += 1) {
        var v = String(nodeIds[i]);
        if (outerSet.has(v)) continue;
        var ngh = adj[v] || [];
        if (ngh.length === 0) continue;
        var sx = 0;
        var sy = 0;
        var sw = 0;
        for (var j = 0; j < ngh.length; j += 1) {
          var u = String(ngh[j]);
          var w = weights[edgeKey(v, u)];
          if (!Number.isFinite(w) || w <= 0) w = 1;
          sx += w * pos[u].x;
          sy += w * pos[u].y;
          sw += w;
        }
        if (!(sw > 0)) continue;
        var nx = sx / sw;
        var ny = sy / sw;
        if (Math.abs(pos[v].x - nx) > 1e-8 || Math.abs(pos[v].y - ny) > 1e-8) {
          pos[v] = { x: nx, y: ny };
          converged = false;
        }
      }
    }
    return { pos: pos, iters: iters };
  }

  function fillMissingPositionsByNeighborAverage(nodeIds, adj, posById, maxPasses) {
    var out = {};
    for (var i = 0; i < nodeIds.length; i += 1) {
      var id = String(nodeIds[i]);
      if (posById[id] && Number.isFinite(posById[id].x) && Number.isFinite(posById[id].y)) {
        out[id] = { x: posById[id].x, y: posById[id].y };
      }
    }
    var passes = Math.max(1, Number(maxPasses) || 1);
    for (var p = 0; p < passes; p += 1) {
      var changed = false;
      for (i = 0; i < nodeIds.length; i += 1) {
        id = String(nodeIds[i]);
        if (out[id]) continue;
        var ngh = adj[id] || [];
        var sx = 0;
        var sy = 0;
        var cnt = 0;
        for (var j = 0; j < ngh.length; j += 1) {
          var u = String(ngh[j]);
          if (!out[u]) continue;
          sx += out[u].x;
          sy += out[u].y;
          cnt += 1;
        }
        if (cnt > 0) {
          out[id] = { x: sx / cnt, y: sy / cnt };
          changed = true;
        }
      }
      if (!changed) break;
    }
    return out;
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
    return {
      maxOuterIters: Number.isFinite(opts.maxOuterIters) ? Math.max(1, Math.floor(opts.maxOuterIters)) : 8,
      pressureStep: Number.isFinite(opts.pressureStep) ? Math.max(0, opts.pressureStep) : 0.16,
      pressureClamp: Number.isFinite(opts.pressureClamp) ? Math.max(0.05, opts.pressureClamp) : 1.20,
      pressureBeta: Number.isFinite(opts.pressureBeta) ? Math.max(0, opts.pressureBeta) : 0.18,
      warmIters: Number.isFinite(opts.warmIters) ? Math.max(1, Math.floor(opts.warmIters)) : 2000,
      warmFillPasses: Number.isFinite(opts.warmFillPasses) ? Math.max(1, Math.floor(opts.warmFillPasses)) : 5,
      innerIters: Number.isFinite(opts.innerIters) ? Math.max(1, Math.floor(opts.innerIters)) : 3000,
      finalIters: Number.isFinite(opts.finalIters) ? Math.max(1, Math.floor(opts.finalIters)) : 3000,
      pressureDeltaClamp: Number.isFinite(opts.pressureDeltaClamp) ? Math.max(0.05, opts.pressureDeltaClamp) : 0.75,
      scaleMin: Number.isFinite(opts.scaleMin) ? Math.max(0.01, opts.scaleMin) : 0.25,
      scaleMax: Number.isFinite(opts.scaleMax) ? Math.max(Math.max(0.01, Number.isFinite(opts.scaleMin) ? opts.scaleMin : 0.25), opts.scaleMax) : 10.0,
      pressureScaleMin: Number.isFinite(opts.pressureScaleMin) ? Math.max(0.01, opts.pressureScaleMin) : 1.0,
      pressureScaleMax: Number.isFinite(opts.pressureScaleMax) ? Math.max(Number.isFinite(opts.pressureScaleMin) ? Math.max(0.01, opts.pressureScaleMin) : 1.0, opts.pressureScaleMax) : 1.25,
      minItersBeforeStop: Number.isFinite(opts.minItersBeforeStop) ? Math.max(1, Math.floor(opts.minItersBeforeStop)) : 8,
      stableIterLimit: Number.isFinite(opts.stableIterLimit) ? Math.max(1, Math.floor(opts.stableIterLimit)) : 4,
      movementStopTol: Number.isFinite(opts.movementStopTol) && opts.movementStopTol >= 0 ? opts.movementStopTol : null,
      avgMovementStopTol: Number.isFinite(opts.avgMovementStopTol) && opts.avgMovementStopTol >= 0 ? opts.avgMovementStopTol : null,
      onIteration: typeof opts.onIteration === 'function' ? opts.onIteration : null
    };
  }

  function prepareReweightState(graph, options) {
    var opts = normalizeReweightOptions(options);
    var graph = {
      nodeIds: (graph.nodeIds || []).map(String),
      edgePairs: (graph.edgePairs || []).map(function (edge) { return [String(edge[0]), String(edge[1])]; })
    };
    var context = PlaygroundUtils.prepareTriangulatedLayoutData(graph, {
      failureLabel: 'ReweightTutte',
      minNodeCount: 3
    });
    if (!context || !context.ok) {
      return context || { ok: false, message: 'ReweightTutte setup failed' };
    }

    var g = context.graph;
    var outer = context.outerFace;
    var augmented = context.augmented;
    var embAug = augmented.embedding;
    var outerFaceForEmbedding = outer;

    var faces = embAug.faces || [];
    var outerFaceIdx = findOuterFaceIndex(faces, outerFaceForEmbedding);
    if (outerFaceIdx < 0) {
      outerFaceForEmbedding = chooseOuterFaceFromEmbedding(embAug);
      outerFaceIdx = findOuterFaceIndex(faces, outerFaceForEmbedding);
    }
    if (outerFaceIdx < 0 || !outerFaceForEmbedding || outerFaceForEmbedding.length < 3) {
      return { ok: false, message: 'Could not determine augmented outer face' };
    }
    var boundedFaceIdx = [];
    for (var i = 0; i < faces.length; i += 1) {
      if (i !== outerFaceIdx) boundedFaceIdx.push(i);
    }
    if (boundedFaceIdx.length === 0) {
      return { ok: false, message: 'No bounded faces' };
    }

    var adj = buildAdjacencyArrays(augmented.nodeIds, augmented.edgePairs);
    var e2f = buildEdgeToFaceMap(faces);
    var weights = {};
    for (i = 0; i < augmented.edgePairs.length; i += 1) {
      weights[edgeKey(augmented.edgePairs[i][0], augmented.edgePairs[i][1])] = 1;
    }
    var facePressure = [];
    for (i = 0; i < faces.length; i += 1) facePressure[i] = 0;
    var boundedSet = {};
    for (i = 0; i < boundedFaceIdx.length; i += 1) boundedSet[boundedFaceIdx[i]] = true;
    var desired = 1 / boundedFaceIdx.length;
    var fixedOuterPos = {};
    var initPos = buildOuterFacePositions(augmented.nodeIds, outer, null);
    for (var oi = 0; oi < outer.length; oi += 1) {
      var ov = String(outer[oi]);
      fixedOuterPos[ov] = { x: initPos[ov].x, y: initPos[ov].y };
    }
    var warm = barycentricLayoutWeighted(augmented.nodeIds, adj, outer, weights, opts.warmIters, fixedOuterPos);
    var currentPos = fillMissingPositionsByNeighborAverage(augmented.nodeIds, adj, warm.pos, opts.warmFillPasses);
    var movableVertices = collectMovableVertices(augmented.nodeIds, outer);
    var movementScale = computeDrawingDiameter(augmented.nodeIds, currentPos);
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
      warmIters: warm.iters,
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
    var totalInnerIters = prepared.warmIters || 0;
    var stopReason = 'max-iters';
    var performedOuterIters = 0;
    var finalIterationStats = null;

    for (var iter = 0; iter < opts.maxOuterIters; iter += 1) {
      var prevPos = currentPos;
      var inner = barycentricLayoutWeighted(augmented.nodeIds, adj, outer, weights, opts.innerIters, fixedOuterPos);
      totalInnerIters += inner.iters;
      performedOuterIters = iter + 1;

      var pos = inner.pos;
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
        augmented.edgePairs,
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
          outerFace: outer.slice(),
          positions: pos,
          faceAreaScore: iterStats ? iterStats.score : null,
          faceAreaMinRatio: iterStats ? iterStats.minRatio : null,
          faceAreaMaxRatio: iterStats ? iterStats.maxRatio : null,
          boundedFaceCount: iterStats ? iterStats.faceCount : boundedFaceIdx.length,
          movedVertices: moveStats.movedVertices,
          maxMove: moveStats.maxMove,
          avgMove: moveStats.avgMove,
          stableIterCount: movementStatus.stableIterations,
          stableIterLimit: movementStatus.stableIterLimit
        });
      }
      if (movementStatus.converged) {
        stopReason = movementStatus.reason || 'movement-converged';
        break;
      }
    }

    var finalLayout = barycentricLayoutWeighted(augmented.nodeIds, adj, outer, weights, opts.finalIters, fixedOuterPos);
    totalInnerIters += finalLayout.iters;

    return {
      ok: true,
      graph: g,
      outerFace: outer,
      augmented: augmented,
      pos: finalLayout.pos,
      iters: totalInnerIters,
      stopReason: stopReason,
      totalInnerIters: totalInnerIters,
      outerSteps: performedOuterIters,
      faceAreaScore: finalIterationStats ? finalIterationStats.score : null,
      boundedFaceCount: finalIterationStats ? finalIterationStats.faceCount : boundedFaceIdx.length,
      faceAreaMinRatio: finalIterationStats ? finalIterationStats.minRatio : null,
      faceAreaMaxRatio: finalIterationStats ? finalIterationStats.maxRatio : null
    };
  }

  async function computeReweightTuttePositions(nodeIds, edgePairs, options) {
    var prepared = prepareReweightState({
      nodeIds: nodeIds,
      edgePairs: edgePairs
    }, options);
    if (!prepared || !prepared.ok) {
      return prepared || { ok: false, message: 'ReweightTutte setup failed' };
    }
    return runReweightIterations(prepared, prepared.opts);
  }

  async function applyReweightTutteLayout(cy, options) {
    return PlaygroundUtils.runIncrementalLayout(cy, options, {
      compute: computeReweightTuttePositions,
      patchComputeOptions: function (ctx) {
        return { onIteration: ctx.onProgress };
      },
      getPositions: function (result) {
        return result.pos;
      },
      buildResult: function (ctx) {
        var result = ctx.result;
        return {
          ok: true,
          stopReason: result.stopReason,
          message: 'Applied ReweightTutte (' + result.outerFace.length + '-vertex outer face' +
            (result.augmented.dummyCount > 0 ? ', +' + result.augmented.dummyCount + ' dummy vertices' : '') +
            ', ' + result.iters + ' iters, ' + result.outerSteps + ' steps, ' + result.stopReason + ')',
          faceAreaScore: result.faceAreaScore,
          faceAreaMinRatio: result.faceAreaMinRatio,
          faceAreaMaxRatio: result.faceAreaMaxRatio,
          boundedFaceCount: result.boundedFaceCount,
          debugState: createAugmentationDebugState(
            result.graph,
            result.outerFace,
            result.augmented,
            result.pos
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
