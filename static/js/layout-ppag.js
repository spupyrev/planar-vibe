(function (global) {
  'use strict';

  var PPAG_REV = 'ppag-20260323';
  var PlaygroundUtils = global.PlaygroundUtils;
  var orientFaceCCW = global.GraphUtils.orientFaceCCW;
  var outerFaceDiameter = global.GraphUtils.outerFaceDiameter;
  var polygonArea2 = global.GraphUtils.polygonArea2;
  var triangleArea2 = global.GraphUtils.triangleArea2;
  var PPAG_INTERNAL = {
    tolGrad: 1e-8,
    acceptanceTol: 1e-12
  };

  function buildPPAGData(augmentedEmbedding, outerFace, posById) {
    var incidentTrianglesByVertex = {};
    var triangles = [];
    var i;
    for (i = 0; i < augmentedEmbedding.idByIndex.length; i += 1) {
      incidentTrianglesByVertex[String(augmentedEmbedding.idByIndex[i])] = [];
    }

    var outerIndex = global.GraphUtils.findOuterFaceIndex(augmentedEmbedding.faces || [], outerFace);
    for (i = 0; i < augmentedEmbedding.faces.length; i += 1) {
      var face = augmentedEmbedding.faces[i];
      if (!face || face.length < 3) {
        return { ok: false, reason: 'PPAG requires a valid triangulated augmentation' };
      }
      if (i === outerIndex) {
        continue;
      }
      var oriented = orientFaceCCW(face, posById);
      if (oriented.length !== 3) {
        return { ok: false, reason: 'PPAG requires all bounded faces of H to be triangles' };
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
      return {
        ok: true,
        outerFace: outerFace.slice().map(String),
        incidentTrianglesByVertex: incidentTrianglesByVertex,
        triangles: triangles,
        targetTriangleArea: 0
      };
    }

    var outerArea = Math.abs(polygonArea2(outerFace, posById)) / 2;
    if (!(outerArea > 1e-12)) {
      return { ok: false, reason: 'PPAG initialization failed: outer face has zero area' };
    }

    return {
      ok: true,
      outerFace: outerFace.slice().map(String),
      incidentTrianglesByVertex: incidentTrianglesByVertex,
      triangles: triangles,
      targetTriangleArea: outerArea / triangles.length
    };
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
        return { ok: false, reason: 'missing_triangle_vertex' };
      }
      var area = triangleArea2(a, b, c) / 2;
      if (!(area > tolAreaPositive)) {
        return { ok: false, reason: 'triangle_nonpositive' };
      }
      var rel = area / targetArea - 1;
      residuals[i] = rel;
      areas[i] = area;
      areaEnergy += rel * rel;
      if (Math.abs(rel) > maxRelError) {
        maxRelError = Math.abs(rel);
      }
    }
    return {
      ok: true,
      residuals: residuals,
      areas: areas,
      areaEnergy: areaEnergy,
      maxRelError: maxRelError
    };
  }

  function computePPAGState(ppagData, posById, opts) {
    var residualState = computeTriangleResiduals(ppagData, posById, opts.tolAreaPositive);
    if (!residualState.ok) {
      return residualState;
    }

    return {
      ok: true,
      objective: residualState.areaEnergy,
      areaEnergy: residualState.areaEnergy,
      residuals: residualState.residuals,
      maxRelError: residualState.maxRelError,
      rmsRelError: ppagData.triangles.length > 0
        ? Math.sqrt(residualState.areaEnergy / ppagData.triangles.length)
        : 0
    };
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

  function originalDrawingHasCrossings(posById, edgePairs) {
    return !!(global.PlanarVibeMetrics &&
      typeof global.PlanarVibeMetrics.hasCrossingsFromPositions === 'function' &&
      global.PlanarVibeMetrics.hasCrossingsFromPositions(posById, edgePairs));
  }

  function normalizePPAGOptions(options) {
    var opts = options || {};
    return {
      interactive: opts.interactive !== false,
      maxIters: Number.isFinite(opts.maxIters) ? Math.max(1, Math.floor(opts.maxIters)) : 200,
      maxVertexMoveRel: Number.isFinite(opts.maxVertexMoveRel) && opts.maxVertexMoveRel > 0 ? opts.maxVertexMoveRel : 0.08,
      localDamping: Number.isFinite(opts.localDamping) && opts.localDamping > 0 ? opts.localDamping : 1e-3,
      stepShrink: Number.isFinite(opts.stepShrink) && opts.stepShrink > 0 && opts.stepShrink < 1 ? opts.stepShrink : 0.5,
      minStepScale: Number.isFinite(opts.minStepScale) && opts.minStepScale > 0 ? opts.minStepScale : Math.pow(2, -20),
      tolAreaPositive: Number.isFinite(opts.tolAreaPositive) ? Math.max(0, opts.tolAreaPositive) : 1e-12,
      tolAreaGlobal: Number.isFinite(opts.tolAreaGlobal) ? Math.max(0, opts.tolAreaGlobal) : 1e-3,
      delayMs: Number.isFinite(opts.delayMs) ? Math.max(0, opts.delayMs) : 0,
      onIteration: typeof opts.onIteration === 'function' ? opts.onIteration : null,
      onSweep: typeof opts.onSweep === 'function' ? opts.onSweep : null,
      yieldEvery: Number.isFinite(opts.yieldEvery) ? Math.max(1, Math.floor(opts.yieldEvery)) : 5,
      renderEvery: Number.isFinite(opts.renderEvery) ? Math.max(1, Math.floor(opts.renderEvery)) : 4
    };
  }

  function preparePPAGState(graph, options, cy) {
    var opts = normalizePPAGOptions(options);
    var context = PlaygroundUtils.prepareTriangulatedLayoutData(graph, {
      failureLabel: 'PPAG layout',
      minNodeCount: 3,
      seedOptions: {
        maxIters: 1000,
        tolerance: 1e-7,
        useSeedOuter: false
      }
    }, cy);
    if (!context || !context.ok) {
      return context || { ok: false, message: 'PPAG setup failed' };
    }

    var ppagData = buildPPAGData(context.augmented.embedding, context.outerFace, context.posById);
    if (!ppagData.ok) {
      return { ok: false, message: ppagData.reason || 'PPAG setup failed' };
    }

    if (ppagData.triangles.length === 0) {
      return {
        ok: true,
        opts: opts,
        graph: context.graph,
        outerFace: context.outerFace,
        augmented: context.augmented,
        posById: context.posById,
        ppagData: ppagData,
        movableVertices: []
      };
    }

    for (var fi = 0; fi < ppagData.triangles.length; fi += 1) {
      var tri = ppagData.triangles[fi];
      var area = triangleArea2(context.posById[tri.vertices[0]], context.posById[tri.vertices[1]], context.posById[tri.vertices[2]]) / 2;
      if (!(area > opts.tolAreaPositive)) {
        return { ok: false, message: 'PPAG initialization failed: degenerate augmented triangle' };
      }
    }

    return {
      ok: true,
      opts: opts,
      graph: context.graph,
      outerFace: context.outerFace,
      augmented: context.augmented,
      posById: context.posById,
      ppagData: ppagData,
      movableVertices: context.movableVertices
    };
  }

  async function runPPAGIterations(prepared, options) {
    var opts = Object.assign({}, prepared && prepared.opts ? prepared.opts : {}, options || {});
    var g = prepared.graph;
    var posById = prepared.posById;
    var ppagData = prepared.ppagData;
    var movableVertices = prepared.movableVertices || [];
    var outerDiameter = outerFaceDiameter(posById, prepared.outerFace || ppagData.outerFace || []);
    opts.maxVertexMove = opts.maxVertexMoveRel * outerDiameter;
    var status = 'max_iters';
    var lastMoveStats = { movedVertices: 0, totalMove: 0, avgMove: 0, maxMove: 0 };
    var state = computePPAGState(ppagData, posById, opts);

    if (!state.ok) {
      return {
        ok: false,
        status: 'invalid',
        reason: state.reason || 'PPAG initialization failed'
      };
    }

    if (state.maxRelError <= opts.tolAreaGlobal) {
      status = 'realized';
    }

    var iter;
    for (iter = 1; iter <= opts.maxIters && status === 'max_iters'; iter += 1) {
      var prevSweepPos = global.GraphUtils.copyPositions(posById);
      var acceptedCount = 0;
      var acceptedStepSum = 0;
      var lineSearchSteps = 0;
      var sweepVertices = movableVertices.slice().sort(function (a, b) {
        return maxIncidentResidual(b, ppagData, state.residuals || []) - maxIncidentResidual(a, ppagData, state.residuals || []);
      });

      for (var vi = 0; vi < sweepVertices.length; vi += 1) {
        var vertexId = sweepVertices[vi];
        var delta = computeLocalDelta(vertexId, ppagData, posById, state.residuals || [], opts);
        if (!(delta.norm > PPAG_INTERNAL.tolGrad)) {
          continue;
        }
        var basePos = posById[vertexId];
        if (!basePos) {
          continue;
        }
        var stepScale = 1;
        while (stepScale >= opts.minStepScale) {
          var dx = stepScale * delta.x;
          var dy = stepScale * delta.y;
          posById[vertexId] = {
            x: basePos.x + dx,
            y: basePos.y + dy
          };
          if (!incidentTrianglesStayPositive(vertexId, ppagData, posById, opts.tolAreaPositive)) {
            posById[vertexId] = basePos;
            stepScale *= opts.stepShrink;
            lineSearchSteps += 1;
            continue;
          }
          var trialState = computePPAGState(ppagData, posById, opts);
          if (trialState.ok &&
              trialState.objective <= state.objective - PPAG_INTERNAL.acceptanceTol * Math.max(1, state.objective)) {
            state = trialState;
            acceptedCount += 1;
            acceptedStepSum += Math.hypot(dx, dy);
            break;
          }
          posById[vertexId] = basePos;
          stepScale *= opts.stepShrink;
          lineSearchSteps += 1;
        }
      }

      lastMoveStats = (global.GraphUtils && typeof global.GraphUtils.computePositionMoveStats === 'function')
        ? global.GraphUtils.computePositionMoveStats(movableVertices, prevSweepPos, posById, { moveTol: 0 })
        : { movedVertices: 0, totalMove: 0, avgMove: 0, maxMove: 0 };
      lastMoveStats.acceptedCount = acceptedCount;

      if (opts.onSweep) {
        await opts.onSweep({
          iter: iter,
          maxIters: opts.maxIters,
          status: status,
          positions: posById,
          objective: state.objective,
          areaEnergy: state.areaEnergy,
          maxRelError: state.maxRelError,
          rmsRelError: state.rmsRelError,
          maxMove: lastMoveStats.maxMove,
          avgMove: lastMoveStats.avgMove,
          movedVertices: lastMoveStats.movedVertices,
          acceptedCount: acceptedCount,
          acceptedStep: acceptedCount > 0 ? (acceptedStepSum / acceptedCount) : 0,
          lineSearchSteps: lineSearchSteps,
          boundedFaceCount: ppagData.triangles.length
        });
      }

      if (state.maxRelError <= opts.tolAreaGlobal) {
        status = 'realized';
        break;
      }
      if (acceptedCount === 0) {
        status = 'stalled';
        break;
      }
    }

    if (status === 'max_iters' && iter > opts.maxIters) {
      status = 'max_iters';
    }

    var hasCrossings = originalDrawingHasCrossings(posById, g.edgePairs);
    return {
      ok: !hasCrossings,
      status: status,
      positions: posById,
      stats: state,
      moveStats: lastMoveStats,
      iters: Math.min(opts.maxIters, Math.max(0, iter - (status === 'max_iters' ? 1 : 0))),
      boundedFaceCount: ppagData.triangles.length,
      dummyCount: prepared.augmented ? prepared.augmented.dummyCount : 0,
      hasCrossings: hasCrossings
    };
  }

  async function computePPAGPositions(nodeIds, edgePairs, options) {
    var opts = options || {};
    var prepared = preparePPAGState({
      nodeIds: (nodeIds || []).map(String),
      edgePairs: (edgePairs || []).map(function (edge) { return [String(edge[0]), String(edge[1])]; })
    }, opts, opts.cy || null);
    if (!prepared || !prepared.ok) {
      return prepared || { ok: false, message: 'PPAG setup failed' };
    }

    if (prepared.ppagData.triangles.length === 0) {
      return {
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
      };
    }

    var result = await runPPAGIterations(prepared, prepared.opts);

    if (!result.ok && result.reason) {
      return {
        ok: false,
        status: result.status,
        message: result.reason
      };
    }
    if (result.hasCrossings) {
      return {
        ok: false,
        status: result.status,
        message: 'PPAG [' + PPAG_REV + '] produced a non-plane drawing'
      };
    }

    var faceScore = global.PlanarVibeMetrics && global.PlanarVibeMetrics.computeUniformFaceAreaScore
      ? global.PlanarVibeMetrics.computeUniformFaceAreaScore(prepared.graph.nodeIds, prepared.graph.edgePairs, prepared.posById)
      : null;
    var lastStats = result.stats || {};
    var message = 'Applied PPAG [' + PPAG_REV + '] (' + prepared.ppagData.triangles.length + ' bounded triangles';
    if (prepared.augmented.dummyCount > 0) {
      message += ', +' + prepared.augmented.dummyCount + ' dummy';
    }
    message += ', status ' + result.status;
    if (Number.isFinite(lastStats.maxRelError)) {
      message += ', max rel err ' + lastStats.maxRelError.toFixed(3);
    }
    if (faceScore && faceScore.ok && Number.isFinite(faceScore.quality)) {
      message += ', face score ' + faceScore.quality.toFixed(3);
    }
    message += ')';

    return {
      ok: true,
      status: result.status,
      positions: prepared.posById,
      graph: prepared.graph,
      outerFace: prepared.outerFace,
      augmented: prepared.augmented,
      ppagData: prepared.ppagData,
      iters: result.iters,
      message: message,
      faceAreaScore: faceScore && faceScore.ok ? faceScore.quality : null,
      maxRelError: Number.isFinite(lastStats.maxRelError) ? lastStats.maxRelError : null,
      boundedFaceCount: prepared.ppagData.triangles.length,
      dummyCount: prepared.augmented.dummyCount
    };
  }

  async function applyPPAGLayout(cy, options) {
    var runtime = PlaygroundUtils;
    if (!runtime || typeof runtime.applyPositionsToCy !== 'function' || typeof runtime.createIncrementalRenderer !== 'function') {
      return { ok: false, message: 'Layout runtime is missing. Check script load order' };
    }

    var graph = PlaygroundUtils.graphFromCy(cy);
    var renderer = runtime.createIncrementalRenderer({
      cy: cy,
      nodeIds: graph.nodeIds,
      getPositions: function () { return currentPositions; },
      interactive: options && options.interactive !== false,
      delayMs: Number.isFinite(options && options.delayMs) ? Math.max(0, options.delayMs) : 0,
      renderEvery: Number.isFinite(options && options.renderEvery) ? Math.max(1, Math.floor(options.renderEvery)) : 4,
      yieldEvery: Number.isFinite(options && options.yieldEvery) ? Math.max(1, Math.floor(options.yieldEvery)) : 5,
      fitPadding: 24
    });
    var currentPositions = {};
    await renderer.begin();

    var result = await computePPAGPositions(graph.nodeIds, graph.edgePairs, Object.assign({}, options || {}, {
      cy: cy,
      onSweep: async function (progress) {
        currentPositions = progress.positions || currentPositions;
        if (options && typeof options.onIteration === 'function') {
          options.onIteration(progress);
        }
        await renderer.onProgress(progress, { forceYield: !!((options && options.onIteration) || (options && options.delayMs > 0)) });
      }
    }));

    renderer.finish();

    if (!result || !result.ok) {
      return result || { ok: false, message: 'PPAG failed' };
    }

    runtime.applyPositionsToCy(cy, result.positions);
    cy.fit(undefined, 24);
    return {
      ok: true,
      status: result.status,
      iters: result.iters,
      message: result.message,
      faceAreaScore: result.faceAreaScore,
      maxRelError: result.maxRelError,
      boundedFaceCount: result.boundedFaceCount,
      dummyCount: result.dummyCount,
      debugState: typeof PlaygroundUtils.createAugmentationDebugState === 'function'
        ? PlaygroundUtils.createAugmentationDebugState(
          result.graph,
          result.outerFace,
          result.augmented,
          result.positions
        )
        : null
    };
  }

  global.PlanarVibePPAG = {
    computePPAGPositions: computePPAGPositions,
    applyPPAGLayout: applyPPAGLayout
  };
})(window);
