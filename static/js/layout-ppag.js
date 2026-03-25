(function (global) {
  'use strict';

  var PPAG_REV = 'ppag-20260323';
  var PlanarCommon = global.PlanarVibePlanarCommon || {};
  var PPAG_INTERNAL = {
    tolGrad: 1e-8,
    acceptanceTol: 1e-12
  };

  function triangleArea2(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }

  function sameCyclicDirection(a, b) {
    if (!a || !b || a.length !== b.length || a.length === 0) return false;
    var arrA = a.map(String);
    var arrB = b.map(String);
    var n = arrA.length;
    var start = -1;
    for (var i = 0; i < n; i += 1) {
      if (arrB[i] === arrA[0]) {
        start = i;
        break;
      }
    }
    if (start < 0) return false;
    for (i = 0; i < n; i += 1) {
      if (arrA[i] !== arrB[(start + i) % n]) {
        return false;
      }
    }
    return true;
  }

  function sameCyclicEitherDirection(a, b) {
    if (sameCyclicDirection(a, b)) return true;
    if (!a || !b || a.length !== b.length) return false;
    return sameCyclicDirection(a, b.slice().reverse());
  }

  function findOuterFaceIndex(faces, outerFace) {
    if (!Array.isArray(faces) || !Array.isArray(outerFace) || outerFace.length === 0) {
      return -1;
    }
    for (var i = 0; i < faces.length; i += 1) {
      if (sameCyclicDirection(outerFace, faces[i])) {
        return i;
      }
    }
    for (i = 0; i < faces.length; i += 1) {
      if (sameCyclicEitherDirection(outerFace, faces[i])) {
        return i;
      }
    }
    return -1;
  }

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
        return { ok: false, reason: 'PPAG requires a valid triangulated augmentation' };
      }
      if (i === outerIndex) {
        continue;
      }
      var oriented = PlanarCommon.orientFaceCCW(face, posById);
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

    var outerArea = Math.abs(PlanarCommon.polygonArea2(outerFace, posById)) / 2;
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

  function preparePPAGFromGeneralPlaneGraph(cy, options) {
    var opts = normalizePPAGOptions(options);
    var context = PlanarCommon.prepareTriangulatedLayoutContext(cy, {
      failureLabel: 'PPAG layout',
      minNodeCount: 3,
      seedOptions: {
        maxIters: 1000,
        tolerance: 1e-7,
        useSeedOuter: false
      }
    });
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

  async function solvePPAG(prepared, options) {
    var opts = Object.assign({}, prepared && prepared.opts ? prepared.opts : {}, options || {});
    var g = prepared.graph;
    var posById = prepared.posById;
    var ppagData = prepared.ppagData;
    var movableVertices = prepared.movableVertices || [];
    var outerDiameter = PlanarCommon.outerFaceDiameter(posById, prepared.outerFace || ppagData.outerFace || []);
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
      var prevSweepPos = PlanarCommon.copyPositions(posById);
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

      lastMoveStats = (global.PlanarGraphCore && typeof global.PlanarGraphCore.computePositionMoveStats === 'function')
        ? global.PlanarGraphCore.computePositionMoveStats(movableVertices, prevSweepPos, posById, { moveTol: 0 })
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

  async function applyPPAGLayout(cy, options) {
    var runtime = global.PlanarVibeLayoutRuntime;
    if (!runtime || typeof runtime.applyPositionsToCy !== 'function' || typeof runtime.createIncrementalRenderer !== 'function') {
      return { ok: false, message: 'Layout runtime is missing. Check script load order' };
    }

    var prepared = preparePPAGFromGeneralPlaneGraph(cy, options);
    if (!prepared || !prepared.ok) {
      return prepared || { ok: false, message: 'PPAG setup failed' };
    }

    if (prepared.ppagData.triangles.length === 0) {
      runtime.applyPositionsToCy(cy, prepared.graph.nodeIds, prepared.posById);
      cy.fit(undefined, 24);
      return {
        ok: true,
        message: 'Applied PPAG (no bounded faces to balance)',
        debugState: typeof PlanarCommon.createAugmentationDebugState === 'function'
          ? PlanarCommon.createAugmentationDebugState(
            prepared.graph,
            prepared.outerFace,
            prepared.augmented,
            prepared.posById
          )
          : null
      };
    }

    var opts = prepared.opts;
    var renderer = runtime.createIncrementalRenderer({
      cy: cy,
      nodeIds: prepared.graph.nodeIds,
      getPositions: function () { return prepared.posById; },
      interactive: opts.interactive,
      delayMs: opts.delayMs,
      renderEvery: opts.renderEvery,
      yieldEvery: opts.yieldEvery,
      fitPadding: 24
    });
    await renderer.begin();

    var result = await solvePPAG(prepared, Object.assign({}, opts, {
      onSweep: async function (progress) {
        if (opts.onIteration) {
          opts.onIteration(progress);
        }
        await renderer.onProgress(progress, { forceYield: !!(opts.onIteration || opts.delayMs > 0) });
      }
    }));

    renderer.finish();

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
      iters: result.iters,
      message: message,
      faceAreaScore: faceScore && faceScore.ok ? faceScore.quality : null,
      maxRelError: Number.isFinite(lastStats.maxRelError) ? lastStats.maxRelError : null,
      boundedFaceCount: prepared.ppagData.triangles.length,
      dummyCount: prepared.augmented.dummyCount,
      debugState: typeof PlanarCommon.createAugmentationDebugState === 'function'
        ? PlanarCommon.createAugmentationDebugState(
          prepared.graph,
          prepared.outerFace,
          prepared.augmented,
          prepared.posById
        )
        : null
    };
  }

  function exportPPAGAugmentedGraph(cy, options) {
    var prepared = preparePPAGFromGeneralPlaneGraph(cy, options);
    if (!prepared || !prepared.ok) {
      return prepared || { ok: false, message: 'PPAG setup failed' };
    }

    var lines = [
      '# PPAG augmented graph H',
      '# original vertices: ' + prepared.graph.nodeIds.length,
      '# augmented vertices: ' + prepared.augmented.nodeIds.length,
      '# dummy vertices: ' + prepared.augmented.dummyCount
    ];
    var nodeIds = prepared.augmented.nodeIds || [];
    var edgePairs = prepared.augmented.edgePairs || [];
    var dummySet = new Set(Object.keys((prepared.augmented && prepared.augmented.dummyFaceVerticesById) || {}));
    var dummyDisplayIndex = 0;
    var dummyLabelById = {};

    for (var i = 0; i < nodeIds.length; i += 1) {
      var nodeId = String(nodeIds[i]);
      var p = prepared.posById[nodeId];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        continue;
      }
      if (dummySet.has(nodeId)) {
        dummyLabelById[nodeId] = String(dummyDisplayIndex);
        lines.push('v ' + nodeId + ' ' + p.x + ' ' + p.y + ' ' + dummyLabelById[nodeId] + ' dummy-node');
        var face = prepared.augmented.dummyFaceVerticesById[nodeId] || [];
        lines.push('# dummy ' + dummyLabelById[nodeId] + ' (' + nodeId + ') <- [' + face.map(String).join(' ') + ']');
        dummyDisplayIndex += 1;
      } else {
        lines.push('v ' + nodeId + ' ' + p.x + ' ' + p.y);
      }
    }
    for (i = 0; i < edgePairs.length; i += 1) {
      lines.push(String(edgePairs[i][0]) + ' ' + String(edgePairs[i][1]));
    }

    return {
      ok: true,
      text: lines.join('\n'),
      dummyCount: prepared.augmented.dummyCount || 0,
      boundedFaceCount: prepared.ppagData ? prepared.ppagData.triangles.length : 0
    };
  }

  global.PlanarVibePPAG = {
    preparePPAGFromGeneralPlaneGraph: preparePPAGFromGeneralPlaneGraph,
    solvePPAG: solvePPAG,
    applyPPAGLayout: applyPPAGLayout,
    exportPPAGAugmentedGraph: exportPPAGAugmentedGraph
  };
})(window);
