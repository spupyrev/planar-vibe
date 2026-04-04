(function (global) {
  'use strict';

  var GraphUtils = global.GraphUtils;
  var PlaygroundUtils = global.PlaygroundUtils;
  var TutteAlgorithm = global.PlanarVibeTutteAlgorithm;
  var applyAndFit = PlaygroundUtils.applyAndFit;
  var buildLayoutError = GraphUtils.buildLayoutError;
  var buildLayoutResult = GraphUtils.buildLayoutResult;
  var buildLayoutStatusMessage = GraphUtils.buildLayoutStatusMessage;
  var collectMovableVertices = GraphUtils.collectMovableVertices;
  var computePositionMoveStats = GraphUtils.computePositionMoveStats;
  var edgeKey = GraphUtils.edgeKey;
  var filterPositions = GraphUtils.filterPositions;
  var graphFromCy = PlaygroundUtils.graphFromCy;
  var hasPositionCrossings = GraphUtils.hasPositionCrossings;
  var normalizeGraphInput = GraphUtils.normalizeGraphInput;
  var resolveFloatOption = GraphUtils.resolveFloatOption;
  var resolveFunctionOption = GraphUtils.resolveFunctionOption;
  var resolveIntOption = GraphUtils.resolveIntOption;

  function buildEdgeToFaceMap(faces) {
    var map = {};
    if (!Array.isArray(faces)) {
      return map;
    }
    for (var i = 0; i < faces.length; i += 1) {
      var face = Array.isArray(faces[i]) ? faces[i] : [];
      for (var j = 0; j < face.length; j += 1) {
        var key = edgeKey(face[j], face[(j + 1) % face.length]);
        if (!map[key]) {
          map[key] = [];
        }
        map[key].push(i);
      }
    }
    return map;
  }

  function updateFacePressure(faceAreas, boundedFaceIndices, desiredArea, facePressure, options) {
    var opts = options || {};
    var next = Array.isArray(facePressure) ? facePressure.slice() : [];
    var stepSize = resolveFloatOption(opts.pressureStep, 0.16, 0);
    var clampValue = resolveFloatOption(opts.pressureClamp, 1.2, 0.05);
    var deltaClamp = resolveFloatOption(opts.pressureDeltaClamp, 0.75, 0.05);
    var sum = 0;
    var count = 0;
    var i;

    for (i = 0; i < boundedFaceIndices.length; i += 1) {
      var faceIndex = boundedFaceIndices[i];
      var area = faceAreas[faceIndex];
      if (!Number.isFinite(area) || !(area > 1e-12)) {
        continue;
      }
      var delta = Math.log(Math.max(desiredArea, 1e-12) / Math.max(area, 1e-12));
      if (delta < -deltaClamp) delta = -deltaClamp;
      if (delta > deltaClamp) delta = deltaClamp;
      var updated = (Number.isFinite(next[faceIndex]) ? next[faceIndex] : 0) + stepSize * delta;
      if (updated < -clampValue) updated = -clampValue;
      if (updated > clampValue) updated = clampValue;
      next[faceIndex] = updated;
      sum += updated;
      count += 1;
    }

    if (count > 0) {
      var mean = sum / count;
      if (Math.abs(mean) > 1e-12) {
        for (i = 0; i < boundedFaceIndices.length; i += 1) {
          faceIndex = boundedFaceIndices[i];
          next[faceIndex] -= mean;
        }
      }
    }

    return next;
  }

  function adjustWeights(edgePairs, outerFace, faceAreas, desiredArea, oldWeights, facePressure, edgeToFaceMap, boundedFaceSet, options) {
    var opts = options || {};
    var pressureBeta = resolveFloatOption(opts.pressureBeta, 0.18, 0);
    var scaleMin = resolveFloatOption(opts.scaleMin, 0.25, 0.01);
    var scaleMax = resolveFloatOption(opts.scaleMax, 10, scaleMin);
    var pressureScaleMin = resolveFloatOption(opts.pressureScaleMin, 1.0, 0.01);
    var pressureScaleMax = resolveFloatOption(opts.pressureScaleMax, 1.25, pressureScaleMin);
    var outerSet = new Set((outerFace || []).map(String));
    var newWeights = {};
    var sumWeights = 0;
    var weightCount = 0;
    var i;

    for (i = 0; i < edgePairs.length; i += 1) {
      var u = String(edgePairs[i][0]);
      var v = String(edgePairs[i][1]);
      var key = edgeKey(u, v);
      var oldWeight = oldWeights[key];
      if (!Number.isFinite(oldWeight) || oldWeight <= 0) {
        oldWeight = 1;
      }

      if (outerSet.has(u) && outerSet.has(v)) {
        newWeights[key] = oldWeight;
        continue;
      }

      var incidentFaces = edgeToFaceMap[key] || [];
      var areaSum = 0;
      var areaCount = 0;
      var pressureSum = 0;
      var pressureCount = 0;
      var j;
      for (j = 0; j < incidentFaces.length; j += 1) {
        var faceIndex = incidentFaces[j];
        var area = faceAreas[faceIndex];
        if (Number.isFinite(area) && area > 0) {
          areaSum += area;
          areaCount += 1;
        }
        if (boundedFaceSet[faceIndex]) {
          var pressure = facePressure[faceIndex];
          if (Number.isFinite(pressure)) {
            pressureSum += pressure;
            pressureCount += 1;
          }
        }
      }

      if (areaCount === 0) {
        newWeights[key] = oldWeight;
        sumWeights += newWeights[key];
        weightCount += 1;
        continue;
      }

      var penalty = (areaSum / areaCount) / Math.max(desiredArea, 1e-12);
      var scale = penalty > 1 ? Math.sqrt(penalty) : penalty;
      if (scale < scaleMin) scale = scaleMin;
      if (scale > scaleMax) scale = scaleMax;

      if (pressureCount > 0 && pressureBeta > 0) {
        var pressureScale = Math.exp(-pressureBeta * (pressureSum / pressureCount));
        if (pressureScale < pressureScaleMin) pressureScale = pressureScaleMin;
        if (pressureScale > pressureScaleMax) pressureScale = pressureScaleMax;
        scale *= pressureScale;
      }

      var updatedWeight = oldWeight * scale;
      if (updatedWeight < 1e-4) updatedWeight = 1e-4;
      if (updatedWeight > 1e4) updatedWeight = 1e4;
      newWeights[key] = updatedWeight;
      sumWeights += updatedWeight;
      weightCount += 1;
    }

    var averageWeight = weightCount > 0 ? (sumWeights / weightCount) : 1;
    if (!(averageWeight > 0)) {
      averageWeight = 1;
    }
    for (i = 0; i < edgePairs.length; i += 1) {
      key = edgeKey(edgePairs[i][0], edgePairs[i][1]);
      newWeights[key] = (newWeights[key] || 1) / averageWeight;
    }

    return newWeights;
  }

  function normalizeTutteAdaptiveOptions(options) {
    var opts = options || {};
    return {
      augmentationMethod: opts.augmentationMethod || null,
      augmentationOptions: opts.augmentationOptions || null,
      adaptiveRounds: resolveIntOption(opts.adaptiveRounds, resolveIntOption(opts.maxIters, 4, 0), 0),
      onIteration: resolveFunctionOption(opts.onIteration, null),
      normalizeByDegree: opts.normalizeByDegree,
      originalEdgeWeight: opts.originalEdgeWeight,
      augmentationEdgeWeight: opts.augmentationEdgeWeight,
      pressureStep: opts.pressureStep,
      pressureClamp: opts.pressureClamp,
      pressureDeltaClamp: opts.pressureDeltaClamp,
      pressureBeta: opts.pressureBeta,
      scaleMin: opts.scaleMin,
      scaleMax: opts.scaleMax,
      pressureScaleMin: opts.pressureScaleMin,
      pressureScaleMax: opts.pressureScaleMax
    };
  }

  function computeTutteAdaptiveLayout(nodeIds, edgePairs, options) {
    var opts = normalizeTutteAdaptiveOptions(options);
    var graph = normalizeGraphInput(nodeIds, edgePairs);
    var ids = graph.nodeIds;
    var pairs = graph.edgePairs;

    if (ids.length < 3) {
      return buildLayoutError({
        message: 'TutteAdaptive requires at least 3 vertices',
        graph: graph
      });
    }

    var prepared = PlaygroundUtils.prepareGraphData({
      nodeIds: ids,
      edgePairs: pairs
    }, {
      failureLabel: 'TutteAdaptive layout',
      minNodeCount: 3,
      augmentationMethod: opts.augmentationMethod,
      augmentationOptions: opts.augmentationOptions
    });
    if (!prepared || !prepared.ok) {
      return buildLayoutError(prepared || { message: 'TutteAdaptive failed' });
    }

    var augmented = prepared.augmented;
    var outerFace = prepared.augmentedOuterFace || prepared.outerFace;
    var faces = augmented && augmented.embedding && Array.isArray(augmented.embedding.faces)
      ? augmented.embedding.faces
      : [];
    var outerFaceIndex = GraphUtils.findOuterFaceIndex(faces, outerFace);
    var boundedFaceIndices = [];
    var boundedFaceSet = {};
    var i;
    for (i = 0; i < faces.length; i += 1) {
      if (i === outerFaceIndex) {
        continue;
      }
      boundedFaceIndices.push(i);
      boundedFaceSet[i] = true;
    }

    var desiredArea = boundedFaceIndices.length > 0 ? (1 / boundedFaceIndices.length) : 1;
    var edgeToFaceMap = buildEdgeToFaceMap(faces);
    var movable = collectMovableVertices(augmented.nodeIds, outerFace);
    var weights = TutteAlgorithm.buildSoftAugmentationWeights(
      augmented.nodeIds,
      pairs,
      augmented.edgePairs,
      {
        normalizeByDegree: opts.normalizeByDegree,
        originalEdgeWeight: opts.originalEdgeWeight,
        augmentationEdgeWeight: opts.augmentationEdgeWeight
      }
    );
    var facePressure = new Array(faces.length);
    for (i = 0; i < faces.length; i += 1) {
      facePressure[i] = 0;
    }

    var previousPos = null;
    var solved = null;
    var iterations = 0;
    for (i = 0; i < opts.adaptiveRounds; i += 1) {
      solved = TutteAlgorithm.solveBarycentricPositionsExact(
        augmented.nodeIds,
        augmented.edgePairs,
        outerFace,
        {
          weights: weights,
          initOptions: TutteAlgorithm.defaultOuterPlacementOptions({ useSeedOuter: false })
        }
      );
      if (!solved || !solved.ok || !solved.pos) {
        return buildLayoutError(solved || { message: 'TutteAdaptive failed' });
      }

      var moveStats = previousPos
        ? computePositionMoveStats(movable, previousPos, solved.pos, { moveTol: 0 })
        : { maxMove: 0, avgMove: 0, movedVertices: 0 };
      previousPos = solved.pos;
      iterations = i + 1;

      var outerArea = GraphUtils.polygonAreaAbs(outerFace, solved.pos);
      if (!(outerArea > 1e-12)) {
        outerArea = 1;
      }
      var faceAreas = new Array(faces.length);
      var j;
      for (j = 0; j < faces.length; j += 1) {
        faceAreas[j] = GraphUtils.polygonAreaAbs(faces[j], solved.pos) / outerArea;
      }

      facePressure = updateFacePressure(
        faceAreas,
        boundedFaceIndices,
        desiredArea,
        facePressure,
        opts
      );
      weights = adjustWeights(
        augmented.edgePairs,
        outerFace,
        faceAreas,
        desiredArea,
        weights,
        facePressure,
        edgeToFaceMap,
        boundedFaceSet,
        opts
      );

      if (typeof opts.onIteration === 'function') {
        opts.onIteration({
          iter: iterations,
          maxIters: opts.adaptiveRounds,
          maxMove: Number.isFinite(moveStats.maxMove) ? moveStats.maxMove : 0,
          avgMove: Number.isFinite(moveStats.avgMove) ? moveStats.avgMove : 0,
          movedVertices: Number.isFinite(moveStats.movedVertices) ? moveStats.movedVertices : 0
        });
      }
    }

    solved = TutteAlgorithm.solveBarycentricPositionsExact(
      augmented.nodeIds,
      augmented.edgePairs,
      outerFace,
      {
        weights: weights,
        initOptions: TutteAlgorithm.defaultOuterPlacementOptions({ useSeedOuter: false })
      }
    );
    if (!solved || !solved.ok || !solved.pos) {
      return buildLayoutError(solved || { message: 'TutteAdaptive failed' });
    }

    var alignedPosById = GraphUtils.alignOuterFaceEdgeHorizontally(solved.pos, outerFace);
    var projected = filterPositions(alignedPosById, ids);
    if (hasPositionCrossings(projected, pairs)) {
      return buildLayoutError({
        message: 'TutteAdaptive produced a non-plane drawing',
        graph: prepared.graph,
        outerFace: prepared.outerFace,
        augmented: prepared.augmented
      });
    }

    return buildLayoutResult({
      ok: true,
      nodeIds: ids,
      edgePairs: pairs,
      outerFace: prepared.outerFace,
      embedding: prepared.baseEmbedding,
      augmented: prepared.augmented,
      graph: prepared.graph,
      pos: projected,
      posById: alignedPosById,
      iters: iterations + 1
    });
  }

  function applyTutteAdaptiveLayout(cy, options) {
    var graph = graphFromCy(cy);
    var result = computeTutteAdaptiveLayout(graph.nodeIds, graph.edgePairs, options || {});
    if (!result || !result.ok) {
      return buildLayoutError(result || {
        message: 'TutteAdaptive failed',
        graph: graph
      });
    }

    applyAndFit(cy, result.pos);
    return {
      ok: true,
      message: buildLayoutStatusMessage('TutteAdaptive', {
        outerFaceVertexCount: result.outerFace.length,
        iters: result.iters
      }),
      debugState: typeof PlaygroundUtils.createAugmentationDebugState === 'function'
        ? PlaygroundUtils.createAugmentationDebugState(
          result.graph,
          result.outerFace,
          result.augmented,
          result.posById
        )
        : null
    };
  }

  global.PlanarVibeTutteAdaptive = {
    computeTutteAdaptiveLayout: computeTutteAdaptiveLayout,
    applyTutteAdaptiveLayout: applyTutteAdaptiveLayout
  };
})(window);
