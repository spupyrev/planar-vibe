(function (global) {
  'use strict';

  var PPAG_REV = 'ppag-20260323';
  var PlanarCommon = global.PlanarVibePlanarCommon || {};

  function faceKey(face) {
    return PlanarCommon.faceKey(face);
  }

  function graphFromCy(cy) {
    return PlanarCommon.graphFromCy(cy);
  }

  function buildAdjacency(nodeIds, edgePairs) {
    return PlanarCommon.buildAdjacency(nodeIds, edgePairs);
  }

  function triangleArea2(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }

  function polygonArea2(face, posById) {
    return PlanarCommon.polygonArea2(face, posById);
  }

  function orientFaceCCW(face, posById) {
    return PlanarCommon.orientFaceCCW(face, posById);
  }

  function copyPositions(posById) {
    return PlanarCommon.copyPositions(posById);
  }

  function outerFaceDiameter(posById, outerFace) {
    return PlanarCommon.outerFaceDiameter(posById, outerFace);
  }

  function buildInitialPositions(nodeIds, edgePairs, outerFace, cy) {
    return PlanarCommon.buildUniformBarycentricSeed(nodeIds, edgePairs, outerFace, cy, {
      maxIters: 1000,
      tolerance: 1e-7,
      useSeedOuter: false
    });
  }

  function prepareAugmentedTriangulation(nodeIds, edgePairs, embedding, outerFace) {
    return PlanarCommon.prepareAugmentedTriangulation(nodeIds, edgePairs, embedding, outerFace, 'PPAG');
  }

  function originalFaceKeyForAugmentedFace(face, dummyFaceKeyById, dummyFaceVerticesById, seenDummyIds) {
    return PlanarCommon.originalFaceKeyForAugmentedFace(face, dummyFaceKeyById, dummyFaceVerticesById, seenDummyIds);
  }

  function buildPPAGData(baseEmbedding, augmentedEmbedding, outerFace, dummyFaceKeyById, dummyFaceVerticesById, posById) {
    var outerOriginalKey = originalFaceKeyForAugmentedFace(outerFace, dummyFaceKeyById, dummyFaceVerticesById);
    var originalFaceKeys = [];
    var originalFaceSet = new Set();
    var faceTrianglesByKey = {};
    var incidentTrianglesByVertex = {};
    var triangles = [];
    var i;

    for (i = 0; i < augmentedEmbedding.idByIndex.length; i += 1) {
      incidentTrianglesByVertex[String(augmentedEmbedding.idByIndex[i])] = [];
    }

    for (i = 0; i < baseEmbedding.faces.length; i += 1) {
      var baseKey = faceKey(baseEmbedding.faces[i]);
      if (baseKey === outerOriginalKey) continue;
      if (!originalFaceSet.has(baseKey)) {
        originalFaceSet.add(baseKey);
        originalFaceKeys.push(baseKey);
        faceTrianglesByKey[baseKey] = [];
      }
    }

    for (i = 0; i < augmentedEmbedding.faces.length; i += 1) {
      var face = augmentedEmbedding.faces[i];
      if (!face || face.length < 3) {
        return { ok: false, reason: 'PPAG requires a valid triangulated augmentation' };
      }
      var oriented = orientFaceCCW(face, posById);
      var originalKey = originalFaceKeyForAugmentedFace(oriented, dummyFaceKeyById, dummyFaceVerticesById);
      if (originalKey === outerOriginalKey) {
        continue;
      }
      if (oriented.length !== 3) {
        return { ok: false, reason: 'PPAG requires all non-outer augmented faces to be triangles' };
      }
      if (!originalFaceSet.has(originalKey)) {
        return { ok: false, reason: 'PPAG face mapping failed for face ' + oriented.join(',') };
      }
      var triangleIndex = triangles.length;
      triangles.push({
        vertices: oriented,
        originalKey: originalKey
      });
      faceTrianglesByKey[originalKey].push(triangleIndex);
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

    if (originalFaceKeys.length === 0 || triangles.length === 0) {
      return {
        ok: true,
        outerFace: outerFace.slice().map(String),
        originalFaceKeys: [],
        faceTrianglesByKey: faceTrianglesByKey,
        incidentTrianglesByVertex: incidentTrianglesByVertex,
        triangles: triangles,
        desiredOriginalArea: 0
      };
    }

    var outerArea = Math.abs(polygonArea2(outerFace, posById)) / 2;
    if (!(outerArea > 1e-12)) {
      return { ok: false, reason: 'PPAG initialization failed: outer face has zero area' };
    }

    return {
      ok: true,
      outerFace: outerFace.slice().map(String),
      originalFaceKeys: originalFaceKeys,
      faceTrianglesByKey: faceTrianglesByKey,
      incidentTrianglesByVertex: incidentTrianglesByVertex,
      triangles: triangles,
      desiredOriginalArea: outerArea / originalFaceKeys.length
    };
  }

  function computeAverageEdgeLength2(edgePairs, posById) {
    var sum = 0;
    var count = 0;
    for (var i = 0; i < edgePairs.length; i += 1) {
      var u = posById[String(edgePairs[i][0])];
      var v = posById[String(edgePairs[i][1])];
      if (!u || !v) continue;
      var dx = u.x - v.x;
      var dy = u.y - v.y;
      var len2 = dx * dx + dy * dy;
      if (len2 > 1e-18) {
        sum += len2;
        count += 1;
      }
    }
    return count > 0 ? (sum / count) : 1;
  }

  function createGradientMap(movableVertices) {
    var gradient = {};
    for (var i = 0; i < movableVertices.length; i += 1) {
      gradient[movableVertices[i]] = { x: 0, y: 0 };
    }
    return gradient;
  }

  function buildIncidentEdgeMap(edgePairs) {
    var map = {};
    for (var i = 0; i < edgePairs.length; i += 1) {
      var u = String(edgePairs[i][0]);
      var v = String(edgePairs[i][1]);
      if (!map[u]) map[u] = [];
      if (!map[v]) map[v] = [];
      map[u].push(v);
      map[v].push(u);
    }
    return map;
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

  function computeLocalGradient(vertexId, ppagData, posById, faceCoeff, incidentEdgesByVertex, targetEdgeLength2, opts) {
    var grad = { x: 0, y: 0 };
    var entries = ppagData.incidentTrianglesByVertex[vertexId] || [];
    for (var i = 0; i < entries.length; i += 1) {
      var entry = entries[i];
      var tri = ppagData.triangles[entry.triangleIndex];
      var coeff = faceCoeff[tri.originalKey] || 0;
      if (coeff === 0) {
        continue;
      }
      var a = posById[tri.vertices[0]];
      var b = posById[tri.vertices[1]];
      var c = posById[tri.vertices[2]];
      if (!a || !b || !c) {
        continue;
      }
      addTriangleGradientForSlot(grad, entry.slot, a, b, c, coeff);
    }

    if (opts.edgeWeight > 0 && incidentEdgesByVertex && targetEdgeLength2 > 1e-18) {
      var neighbors = incidentEdgesByVertex[vertexId] || [];
      var p = posById[vertexId];
      if (p) {
        for (i = 0; i < neighbors.length; i += 1) {
          var q = posById[String(neighbors[i])];
          if (!q) continue;
          var dx = p.x - q.x;
          var dy = p.y - q.y;
          var len2 = dx * dx + dy * dy;
          var edgeRel = len2 / targetEdgeLength2 - 1;
          var edgeCoeff = opts.edgeWeight * (4 * edgeRel / targetEdgeLength2);
          grad.x += edgeCoeff * dx;
          grad.y += edgeCoeff * dy;
        }
      }
    }
    return grad;
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

  function computePPAGState(ppagData, posById, movableVertices, regularizationEdges, targetEdgeLength2, opts, withGradient) {
    var tolAreaPositive = opts.tolAreaPositive;
    var triangles = ppagData.triangles || [];
    var faceAreas = {};
    var faceCoeff = {};
    var gradient = withGradient ? createGradientMap(movableVertices) : null;
    var i;

    for (i = 0; i < ppagData.originalFaceKeys.length; i += 1) {
      faceAreas[ppagData.originalFaceKeys[i]] = 0;
    }

    for (i = 0; i < triangles.length; i += 1) {
      var tri = triangles[i];
      var a = posById[tri.vertices[0]];
      var b = posById[tri.vertices[1]];
      var c = posById[tri.vertices[2]];
      if (!a || !b || !c) {
        return { ok: false, reason: 'missing_triangle_vertex' };
      }
      var signedArea = triangleArea2(a, b, c) / 2;
      if (!(signedArea > tolAreaPositive)) {
        return { ok: false, reason: 'triangle_nonpositive' };
      }
      faceAreas[tri.originalKey] = (faceAreas[tri.originalKey] || 0) + signedArea;
    }

    var targetArea = ppagData.desiredOriginalArea;
    var areaEnergy = 0;
    var maxRelError = 0;
    for (i = 0; i < ppagData.originalFaceKeys.length; i += 1) {
      var key = ppagData.originalFaceKeys[i];
      var area = faceAreas[key] || 0;
      var rel = area / targetArea - 1;
      var absRel = Math.abs(rel);
      if (absRel > maxRelError) {
        maxRelError = absRel;
      }
      areaEnergy += rel * rel;
      faceCoeff[key] = 2 * rel / targetArea;
    }

    if (withGradient) {
      for (i = 0; i < triangles.length; i += 1) {
        tri = triangles[i];
        var coeff = faceCoeff[tri.originalKey] || 0;
        if (coeff === 0) continue;

        a = posById[tri.vertices[0]];
        b = posById[tri.vertices[1]];
        c = posById[tri.vertices[2]];

        var gradA = gradient[tri.vertices[0]];
        var gradB = gradient[tri.vertices[1]];
        var gradC = gradient[tri.vertices[2]];

        if (gradA) {
          gradA.x += coeff * 0.5 * (b.y - c.y);
          gradA.y += coeff * 0.5 * (c.x - b.x);
        }
        if (gradB) {
          gradB.x += coeff * 0.5 * (c.y - a.y);
          gradB.y += coeff * 0.5 * (a.x - c.x);
        }
        if (gradC) {
          gradC.x += coeff * 0.5 * (a.y - b.y);
          gradC.y += coeff * 0.5 * (b.x - a.x);
        }
      }
    }

    var edgeEnergy = 0;
    if (opts.edgeWeight > 0 && Array.isArray(regularizationEdges) && regularizationEdges.length > 0 && targetEdgeLength2 > 1e-18) {
      for (i = 0; i < regularizationEdges.length; i += 1) {
        var uId = String(regularizationEdges[i][0]);
        var vId = String(regularizationEdges[i][1]);
        var u = posById[uId];
        var v = posById[vId];
        if (!u || !v) continue;
        var dx = u.x - v.x;
        var dy = u.y - v.y;
        var len2 = dx * dx + dy * dy;
        var edgeRel = len2 / targetEdgeLength2 - 1;
        edgeEnergy += edgeRel * edgeRel;
        if (withGradient) {
          var edgeCoeff = opts.edgeWeight * (4 * edgeRel / targetEdgeLength2);
          var gradU = gradient[uId];
          var gradV = gradient[vId];
          if (gradU) {
            gradU.x += edgeCoeff * dx;
            gradU.y += edgeCoeff * dy;
          }
          if (gradV) {
            gradV.x -= edgeCoeff * dx;
            gradV.y -= edgeCoeff * dy;
          }
        }
      }
    }

    var maxGradNorm = 0;
    if (withGradient) {
      for (i = 0; i < movableVertices.length; i += 1) {
        var grad = gradient[movableVertices[i]];
        if (!grad) continue;
        var gradNorm = Math.hypot(grad.x, grad.y);
        if (gradNorm > maxGradNorm) {
          maxGradNorm = gradNorm;
        }
      }
    }

    return {
      ok: true,
      objective: areaEnergy + opts.edgeWeight * edgeEnergy,
      areaEnergy: areaEnergy,
      edgeEnergy: edgeEnergy,
      faceAreas: faceAreas,
      faceCoeff: faceCoeff,
      maxRelError: maxRelError,
      gradient: gradient,
      maxGradNorm: maxGradNorm
    };
  }

  function buildVertexTrialPosition(posById, vertexId, gradient, stepSize) {
    var trial = copyPositions(posById);
    var base = trial[vertexId];
    if (!base || !gradient) {
      return {
        posById: trial,
        move: 0
      };
    }
    var dx = -stepSize * gradient.x;
    var dy = -stepSize * gradient.y;
    trial[vertexId] = {
      x: base.x + dx,
      y: base.y + dy
    };
    return {
      posById: trial,
      move: Math.hypot(dx, dy)
    };
  }

  function buildGlobalTrialPosition(posById, movableVertices, gradientMap, stepSize) {
    var trial = copyPositions(posById);
    var maxMove = 0;
    for (var i = 0; i < movableVertices.length; i += 1) {
      var vertexId = movableVertices[i];
      var gradient = gradientMap ? gradientMap[vertexId] : null;
      var base = trial[vertexId];
      if (!gradient || !base) {
        continue;
      }
      var dx = -stepSize * gradient.x;
      var dy = -stepSize * gradient.y;
      trial[vertexId] = {
        x: base.x + dx,
        y: base.y + dy
      };
      var move = Math.hypot(dx, dy);
      if (move > maxMove) {
        maxMove = move;
      }
    }
    return {
      posById: trial,
      maxMove: maxMove
    };
  }

  function allTrianglesStayPositive(ppagData, posById, tolAreaPositive) {
    for (var i = 0; i < ppagData.triangles.length; i += 1) {
      var tri = ppagData.triangles[i];
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
      edgeWeight: Number.isFinite(opts.edgeWeight) ? Math.max(0, opts.edgeWeight) : 0.003,
      initialMoveRel: Number.isFinite(opts.initialMoveRel) && opts.initialMoveRel > 0 ? opts.initialMoveRel : 0.08,
      stepShrink: Number.isFinite(opts.stepShrink) && opts.stepShrink > 0 && opts.stepShrink < 1 ? opts.stepShrink : 0.5,
      minStepScale: Number.isFinite(opts.minStepScale) && opts.minStepScale > 0 ? opts.minStepScale : Math.pow(2, -20),
      tolAreaPositive: Number.isFinite(opts.tolAreaPositive) ? Math.max(0, opts.tolAreaPositive) : 1e-12,
      tolAreaGlobal: Number.isFinite(opts.tolAreaGlobal) ? Math.max(0, opts.tolAreaGlobal) : 1e-3,
      tolGrad: Number.isFinite(opts.tolGrad) ? Math.max(0, opts.tolGrad) : 1e-8,
      moveTolRel: Number.isFinite(opts.moveTolRel) && opts.moveTolRel >= 0 ? opts.moveTolRel : 1e-5,
      moveTolAbs: Number.isFinite(opts.moveTolAbs) && opts.moveTolAbs >= 0 ? opts.moveTolAbs : 1e-9,
      energyTolRel: Number.isFinite(opts.energyTolRel) && opts.energyTolRel >= 0 ? opts.energyTolRel : 1e-6,
      energyTolAbs: Number.isFinite(opts.energyTolAbs) && opts.energyTolAbs >= 0 ? opts.energyTolAbs : 1e-10,
      acceptanceTol: Number.isFinite(opts.acceptanceTol) && opts.acceptanceTol >= 0 ? opts.acceptanceTol : 1e-12,
      patience: Number.isFinite(opts.patience) ? Math.max(1, Math.floor(opts.patience)) : 6,
      deadlockPatience: Number.isFinite(opts.deadlockPatience) ? Math.max(1, Math.floor(opts.deadlockPatience)) : 2,
      plateauWindow: Number.isFinite(opts.plateauWindow) ? Math.max(4, Math.floor(opts.plateauWindow)) : 12,
      plateauPatience: Number.isFinite(opts.plateauPatience) ? Math.max(1, Math.floor(opts.plateauPatience)) : 2,
      plateauObjTolAbs: Number.isFinite(opts.plateauObjTolAbs) && opts.plateauObjTolAbs >= 0 ? opts.plateauObjTolAbs : 1e-3,
      plateauObjTolRel: Number.isFinite(opts.plateauObjTolRel) && opts.plateauObjTolRel >= 0 ? opts.plateauObjTolRel : 1e-4,
      plateauErrTolAbs: Number.isFinite(opts.plateauErrTolAbs) && opts.plateauErrTolAbs >= 0 ? opts.plateauErrTolAbs : 1e-3,
      plateauErrTolRel: Number.isFinite(opts.plateauErrTolRel) && opts.plateauErrTolRel >= 0 ? opts.plateauErrTolRel : 1e-4,
      delayMs: Number.isFinite(opts.delayMs) ? Math.max(0, opts.delayMs) : 0,
      onIteration: typeof opts.onIteration === 'function' ? opts.onIteration : null,
      yieldEvery: Number.isFinite(opts.yieldEvery) ? Math.max(1, Math.floor(opts.yieldEvery)) : 5,
      renderEvery: Number.isFinite(opts.renderEvery) ? Math.max(1, Math.floor(opts.renderEvery)) : 4
    };
  }

  function preparePPAGFromGeneralPlaneGraph(cy, options) {
    var opts = normalizePPAGOptions(options);
    if (!global.PlanarVibePlanarityTest || !global.PlanarVibePlanarityTest.computePlanarEmbedding) {
      return { ok: false, message: 'Planarity utilities are missing. Check script load order' };
    }
    if (!global.PlanarGraphCore || !global.PlanarGraphCore.prepareTriangulatedByFaceStellation) {
      return { ok: false, message: 'Planar graph utilities are missing. Check script load order' };
    }
    if (!global.PlanarVibeBarycentricCore ||
        !global.PlanarVibeBarycentricCore.buildUniformWeights ||
        !global.PlanarVibeBarycentricCore.solveWeightedBarycentricLayout ||
        !global.PlanarVibeBarycentricCore.currentPositionsFromCy) {
      return { ok: false, message: 'Barycentric core is missing. Check script load order' };
    }

    var g = graphFromCy(cy);
    if (g.nodeIds.length < 3) {
      return { ok: false, message: 'PPAG layout requires at least 3 vertices' };
    }

    var baseEmbedding = global.PlanarVibePlanarityTest.computePlanarEmbedding(g.nodeIds, g.edgePairs);
    if (!baseEmbedding || !baseEmbedding.ok) {
      return { ok: false, message: 'PPAG layout requires a planar graph' };
    }

    var outerFace = global.PlanarGraphCore.chooseOuterFaceFromEmbedding(baseEmbedding);
    if (!outerFace || outerFace.length < 3) {
      return { ok: false, message: 'Could not determine outer boundary for PPAG layout' };
    }

    var augmented = prepareAugmentedTriangulation(g.nodeIds, g.edgePairs, baseEmbedding, outerFace);
    if (!augmented.ok) {
      return { ok: false, message: augmented.reason || 'PPAG augmentation failed' };
    }

    var init = buildInitialPositions(augmented.nodeIds, augmented.edgePairs, outerFace, cy);
    if (!init || !init.ok || !init.pos) {
      return { ok: false, message: (init && init.message) || 'PPAG initialization failed' };
    }

    var posById = (global.PlanarGraphCore && typeof global.PlanarGraphCore.alignOuterFaceEdgeHorizontally === 'function')
      ? global.PlanarGraphCore.alignOuterFaceEdgeHorizontally(init.pos, outerFace)
      : copyPositions(init.pos);
    var ppagData = buildPPAGData(baseEmbedding, augmented.embedding, outerFace, augmented.dummyFaceKeyById, augmented.dummyFaceVerticesById, posById);
    if (!ppagData.ok) {
      return { ok: false, message: ppagData.reason || 'PPAG setup failed' };
    }

    if (ppagData.originalFaceKeys.length === 0) {
      return {
        ok: true,
        opts: opts,
        graph: g,
        baseEmbedding: baseEmbedding,
        outerFace: outerFace,
        augmented: augmented,
        posById: posById,
        ppagData: ppagData,
        movableVertices: [],
        targetEdgeLength2: computeAverageEdgeLength2(augmented.edgePairs, posById)
      };
    }

    for (var fi = 0; fi < ppagData.triangles.length; fi += 1) {
      var tri = ppagData.triangles[fi];
      var area = triangleArea2(posById[tri.vertices[0]], posById[tri.vertices[1]], posById[tri.vertices[2]]) / 2;
      if (!(area > opts.tolAreaPositive)) {
        return { ok: false, message: 'PPAG initialization failed: degenerate augmented triangle' };
      }
    }

    var outerSet = new Set(outerFace.map(String));
    var movableVertices = [];
    for (var ni = 0; ni < augmented.nodeIds.length; ni += 1) {
      var nodeId = String(augmented.nodeIds[ni]);
      if (!outerSet.has(nodeId)) {
        movableVertices.push(nodeId);
      }
    }

    return {
      ok: true,
      opts: opts,
      graph: g,
      baseEmbedding: baseEmbedding,
      outerFace: outerFace,
      augmented: augmented,
      posById: posById,
      ppagData: ppagData,
      movableVertices: movableVertices,
      incidentEdgesByVertex: buildIncidentEdgeMap(augmented.edgePairs),
      targetEdgeLength2: computeAverageEdgeLength2(augmented.edgePairs, posById)
    };
  }

  async function solvePPAG(prepared, options) {
    var opts = Object.assign({}, prepared && prepared.opts ? prepared.opts : {}, options || {});
    var g = prepared.graph;
    var posById = prepared.posById;
    var ppagData = prepared.ppagData;
    var movableVertices = prepared.movableVertices || [];
    var regularizationEdges = prepared.augmented ? prepared.augmented.edgePairs : [];
    var incidentEdgesByVertex = prepared.incidentEdgesByVertex || buildIncidentEdgeMap(regularizationEdges);
    var outerDiameter = outerFaceDiameter(posById, prepared.outerFace || ppagData.outerFace || []);
    var moveTol = opts.moveTolAbs + opts.moveTolRel * outerDiameter;
    var stalledIters = 0;
    var deadSweeps = 0;
    var plateauSweeps = 0;
    var status = 'max_iters';
    var lastMoveStats = { movedVertices: 0, totalMove: 0, avgMove: 0, maxMove: 0 };
    var state = computePPAGState(ppagData, posById, movableVertices, regularizationEdges, prepared.targetEdgeLength2, opts, true);
    var objectiveWindow = state.ok ? [state.objective] : [];
    var errorWindow = state.ok ? [state.maxRelError] : [];

    if (!state.ok) {
      return {
        ok: false,
        status: 'invalid',
        reason: state.reason || 'PPAG initialization failed'
      };
    }

    if (state.maxRelError <= opts.tolAreaGlobal) {
      status = 'realized';
    } else if (state.maxGradNorm <= opts.tolGrad) {
      status = 'stalled';
    }

    var iter;
    for (iter = 1; iter <= opts.maxIters && status === 'max_iters'; iter += 1) {
      var prevObjective = state.objective;
      var prevSweepPos = copyPositions(posById);
      var acceptedCount = 0;
      var acceptedStepSum = 0;
      var lineSearchSteps = 0;
      var globalAccepted = false;

      if (state.gradient && state.maxGradNorm > opts.tolGrad) {
        var globalBaseStep = 0.35 * opts.initialMoveRel * outerDiameter / Math.max(state.maxGradNorm, 1e-12);
        var globalStepScale = 1;
        while (globalStepScale >= opts.minStepScale) {
          var globalStepSize = globalBaseStep * globalStepScale;
          var globalTrial = buildGlobalTrialPosition(posById, movableVertices, state.gradient, globalStepSize);
          if (!allTrianglesStayPositive(ppagData, globalTrial.posById, opts.tolAreaPositive)) {
            globalStepScale *= opts.stepShrink;
            lineSearchSteps += 1;
            continue;
          }
          var globalTrialState = computePPAGState(ppagData, globalTrial.posById, movableVertices, regularizationEdges, prepared.targetEdgeLength2, opts, false);
          if (globalTrialState.ok &&
              globalTrialState.objective <= state.objective - opts.acceptanceTol * Math.max(1, state.objective)) {
            posById = globalTrial.posById;
            prepared.posById = posById;
            state = computePPAGState(ppagData, posById, movableVertices, regularizationEdges, prepared.targetEdgeLength2, opts, true);
            acceptedCount += 1;
            acceptedStepSum += globalStepSize;
            globalAccepted = true;
            break;
          }
          globalStepScale *= opts.stepShrink;
          lineSearchSteps += 1;
        }
      }

      for (var vi = 0; vi < movableVertices.length; vi += 1) {
        var vertexId = movableVertices[vi];
        var grad = computeLocalGradient(
          vertexId,
          ppagData,
          posById,
          state.faceCoeff || {},
          incidentEdgesByVertex,
          prepared.targetEdgeLength2,
          opts
        );
        var gradNorm = Math.hypot(grad.x, grad.y);
        if (!(gradNorm > opts.tolGrad)) {
          continue;
        }

        var baseStep = opts.initialMoveRel * outerDiameter / gradNorm;
        if (!(baseStep > 0) || !Number.isFinite(baseStep)) {
          continue;
        }
        var stepScale = 1;
        while (stepScale >= opts.minStepScale) {
          var stepSize = baseStep * stepScale;
          var trial = buildVertexTrialPosition(posById, vertexId, grad, stepSize);
          if (!incidentTrianglesStayPositive(vertexId, ppagData, trial.posById, opts.tolAreaPositive)) {
            stepScale *= opts.stepShrink;
            lineSearchSteps += 1;
            continue;
          }
          var trialState = computePPAGState(ppagData, trial.posById, movableVertices, regularizationEdges, prepared.targetEdgeLength2, opts, false);
          if (trialState.ok &&
              trialState.objective <= state.objective - opts.acceptanceTol * Math.max(1, state.objective)) {
            posById = trial.posById;
            prepared.posById = posById;
            state = computePPAGState(ppagData, posById, movableVertices, regularizationEdges, prepared.targetEdgeLength2, opts, true);
            acceptedCount += 1;
            acceptedStepSum += stepSize;
            break;
          }
          stepScale *= opts.stepShrink;
          lineSearchSteps += 1;
        }
      }

      lastMoveStats = (global.PlanarGraphCore && typeof global.PlanarGraphCore.computePositionMoveStats === 'function')
        ? global.PlanarGraphCore.computePositionMoveStats(movableVertices, prevSweepPos, posById, { moveTol: moveTol })
        : { movedVertices: 0, totalMove: 0, avgMove: 0, maxMove: 0 };
      lastMoveStats.acceptedCount = acceptedCount;

      var improvement = prevObjective - state.objective;
      var smallMove = lastMoveStats.maxMove <= moveTol && lastMoveStats.avgMove <= moveTol;
      var smallImprovement = improvement <= opts.energyTolAbs + opts.energyTolRel * Math.max(1, prevObjective);
      objectiveWindow.push(state.objective);
      errorWindow.push(state.maxRelError);
      if (objectiveWindow.length > opts.plateauWindow + 1) {
        objectiveWindow.shift();
      }
      if (errorWindow.length > opts.plateauWindow + 1) {
        errorWindow.shift();
      }
      var plateauObjImprovementAbs = null;
      var plateauObjImprovementRel = null;
      var plateauErrImprovementAbs = null;
      var plateauErrImprovementRel = null;
      if (objectiveWindow.length >= opts.plateauWindow + 1 && errorWindow.length >= opts.plateauWindow + 1) {
        plateauObjImprovementAbs = objectiveWindow[0] - state.objective;
        plateauObjImprovementRel = plateauObjImprovementAbs / Math.max(1, objectiveWindow[0]);
        plateauErrImprovementAbs = errorWindow[0] - state.maxRelError;
        plateauErrImprovementRel = plateauErrImprovementAbs / Math.max(1, errorWindow[0]);
      }
      if (smallMove && smallImprovement) {
        stalledIters += 1;
      } else {
        stalledIters = 0;
      }
      if (acceptedCount === 0) {
        deadSweeps += 1;
      } else {
        deadSweeps = 0;
      }
      if (plateauObjImprovementAbs !== null &&
          plateauObjImprovementAbs <= opts.plateauObjTolAbs &&
          plateauObjImprovementRel <= opts.plateauObjTolRel &&
          plateauErrImprovementAbs <= opts.plateauErrTolAbs &&
          plateauErrImprovementRel <= opts.plateauErrTolRel) {
        plateauSweeps += 1;
      } else {
        plateauSweeps = 0;
      }

      if (opts.onIteration) {
        opts.onIteration({
          iter: iter,
          maxIters: opts.maxIters,
          objective: state.objective,
          areaEnergy: state.areaEnergy,
          edgeEnergy: state.edgeEnergy,
          gradNorm: state.maxGradNorm,
          maxRelError: state.maxRelError,
          maxMove: lastMoveStats.maxMove,
          avgMove: lastMoveStats.avgMove,
          movedVertices: lastMoveStats.movedVertices,
          acceptedCount: acceptedCount,
          acceptedStep: acceptedCount > 0 ? (acceptedStepSum / acceptedCount) : 0,
          globalAccepted: globalAccepted,
          lineSearchSteps: lineSearchSteps,
          boundedFaceCount: ppagData.originalFaceKeys.length,
          stalledIters: stalledIters,
          stallLimit: opts.patience,
          plateauSweeps: plateauSweeps,
          plateauPatience: opts.plateauPatience,
          plateauWindow: opts.plateauWindow,
          plateauObjImprovementAbs: plateauObjImprovementAbs,
          plateauObjImprovementRel: plateauObjImprovementRel,
          plateauErrImprovementAbs: plateauErrImprovementAbs,
          plateauErrImprovementRel: plateauErrImprovementRel
        });
      }
      if (typeof opts.onStepComplete === 'function') {
        await opts.onStepComplete({
          iter: iter,
          maxIters: opts.maxIters,
          status: status,
          positions: posById,
          stats: state,
          moveStats: lastMoveStats,
          acceptedStep: acceptedCount > 0 ? (acceptedStepSum / acceptedCount) : 0,
          lineSearchSteps: lineSearchSteps
        });
      }

      if (state.maxRelError <= opts.tolAreaGlobal) {
        status = 'realized';
        break;
      }
      if (deadSweeps >= opts.deadlockPatience) {
        status = 'deadlock';
        break;
      }
      if (plateauSweeps >= opts.plateauPatience) {
        status = 'stalled';
        break;
      }
      if (state.maxGradNorm <= opts.tolGrad || stalledIters >= opts.patience) {
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
      boundedFaceCount: ppagData.originalFaceKeys.length,
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

    if (prepared.ppagData.originalFaceKeys.length === 0) {
      runtime.applyPositionsToCy(cy, prepared.graph.nodeIds, prepared.posById);
      cy.fit(undefined, 24);
      return { ok: true, message: 'Applied PPAG (no bounded faces to balance)' };
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
      onStepComplete: async function (event) {
        await renderer.onProgress(event, { forceYield: !!(opts.onIteration || opts.delayMs > 0) });
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
    var message = 'Applied PPAG [' + PPAG_REV + '] (' + prepared.ppagData.originalFaceKeys.length + ' bounded faces, ' +
      prepared.ppagData.triangles.length + ' triangles';
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
      boundedFaceCount: prepared.ppagData.originalFaceKeys.length,
      dummyCount: prepared.augmented.dummyCount
    };
  }

  global.PlanarVibePPAG = {
    preparePPAGFromGeneralPlaneGraph: preparePPAGFromGeneralPlaneGraph,
    solvePPAG: solvePPAG,
    applyPPAGLayout: applyPPAGLayout
  };
})(window);
