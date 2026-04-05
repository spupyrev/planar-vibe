(function (global) {
  'use strict';

  var GraphUtils = global.GraphUtils;
  var Metrics = global.PlanarVibeMetrics;
  var PlaygroundUtils = global.PlaygroundUtils;
  var TutteAdaptive = global.PlanarVibeTutteAdaptive;
  var TutteAlgorithm = global.PlanarVibeTutteAlgorithm;
  var applyAndFit = PlaygroundUtils.applyAndFit;
  var buildAdjacencyArrays = GraphUtils.buildAdjacencyArrays;
  var buildLayoutError = GraphUtils.buildLayoutError;
  var buildLayoutResult = GraphUtils.buildLayoutResult;
  var buildLayoutStatusMessage = GraphUtils.buildLayoutStatusMessage;
  var collectMovableVertices = GraphUtils.collectMovableVertices;
  var computeDrawingDiameter = GraphUtils.computeDrawingDiameter;
  var computePositionMoveStats = GraphUtils.computePositionMoveStats;
  var copyPositions = GraphUtils.copyPositions;
  var edgeKey = GraphUtils.edgeKey;
  var filterPositions = GraphUtils.filterPositions;
  var graphFromCy = PlaygroundUtils.graphFromCy;
  var hasPositionCrossings = GraphUtils.hasPositionCrossings;
  var normalizeGraphInput = GraphUtils.normalizeGraphInput;
  var resolveFloatOption = GraphUtils.resolveFloatOption;
  var resolveFunctionOption = GraphUtils.resolveFunctionOption;
  var resolveIntOption = GraphUtils.resolveIntOption;

  function normalizeCommonOptions(options) {
    var opts = options || {};
    return {
      augmentationMethod: opts.augmentationMethod || null,
      augmentationOptions: opts.augmentationOptions || null,
      normalizeByDegree: opts.normalizeByDegree,
      originalEdgeWeight: opts.originalEdgeWeight,
      augmentationEdgeWeight: opts.augmentationEdgeWeight,
      onIteration: resolveFunctionOption(opts.onIteration, null)
    };
  }

  function prepareExplorationState(nodeIds, edgePairs, options, failureLabel) {
    var opts = normalizeCommonOptions(options);
    var graph = normalizeGraphInput(nodeIds, edgePairs);
    var prepared = PlaygroundUtils.prepareGraphData(graph, {
      failureLabel: failureLabel,
      minNodeCount: 3,
      augmentationMethod: opts.augmentationMethod,
      augmentationOptions: opts.augmentationOptions
    });
    if (!prepared || !prepared.ok) {
      return buildLayoutError(prepared || { message: failureLabel + ' failed' });
    }

    var outerFace = prepared.augmentedOuterFace || prepared.outerFace;
    var augmented = prepared.augmented;
    var baseWeights = TutteAlgorithm.buildSoftAugmentationWeights(
      augmented.nodeIds,
      graph.edgePairs,
      augmented.edgePairs,
      {
        normalizeByDegree: opts.normalizeByDegree,
        originalEdgeWeight: opts.originalEdgeWeight,
        augmentationEdgeWeight: opts.augmentationEdgeWeight
      }
    );
    var seed = TutteAlgorithm.solveBarycentricPositionsExact(
      augmented.nodeIds,
      augmented.edgePairs,
      outerFace,
      {
        weights: baseWeights,
        initOptions: TutteAlgorithm.defaultOuterPlacementOptions({ useSeedOuter: false })
      }
    );
    if (!seed || !seed.ok || !seed.pos) {
      return buildLayoutError(seed || { message: failureLabel + ' failed' });
    }

    var fixedOuterPos = {};
    for (var i = 0; i < outerFace.length; i += 1) {
      var outerId = String(outerFace[i]);
      fixedOuterPos[outerId] = {
        x: seed.pos[outerId].x,
        y: seed.pos[outerId].y
      };
    }

    return {
      ok: true,
      graph: graph,
      prepared: prepared,
      augmented: augmented,
      outerFace: outerFace,
      adjacency: buildAdjacencyArrays(augmented.nodeIds, augmented.edgePairs),
      movable: collectMovableVertices(augmented.nodeIds, outerFace),
      fixedOuterPos: fixedOuterPos,
      baseWeights: baseWeights,
      seedPos: seed.pos,
      commonOptions: opts
    };
  }

  function buildPostProcessStateFromResult(result) {
    var outerFace = result && result.augmented && Array.isArray(result.augmented.outerFace)
      ? result.augmented.outerFace
      : (result && result.outerFace ? result.outerFace : []);
    var fixedOuterPos = {};
    var i;
    for (i = 0; i < outerFace.length; i += 1) {
      var outerId = String(outerFace[i]);
      fixedOuterPos[outerId] = {
        x: result.posById[outerId].x,
        y: result.posById[outerId].y
      };
    }

    return {
      ok: true,
      graph: {
        nodeIds: result.nodeIds,
        edgePairs: result.edgePairs
      },
      prepared: {
        graph: result.graph,
        baseEmbedding: result.embedding,
        outerFace: result.outerFace
      },
      augmented: result.augmented,
      outerFace: outerFace,
      movable: collectMovableVertices(result.augmented.nodeIds, outerFace),
      fixedOuterPos: fixedOuterPos
    };
  }

  function buildAlignedResult(state, posById, label, extraFields) {
    var alignedPosById = GraphUtils.alignOuterFaceEdgeHorizontally(posById, state.outerFace);
    var projected = filterPositions(alignedPosById, state.graph.nodeIds);
    if (hasPositionCrossings(projected, state.graph.edgePairs)) {
      return buildLayoutError({
        message: label + ' produced a non-plane drawing',
        graph: state.prepared.graph,
        outerFace: state.prepared.outerFace,
        augmented: state.augmented
      });
    }

    return buildLayoutResult(Object.assign({
      ok: true,
      nodeIds: state.graph.nodeIds,
      edgePairs: state.graph.edgePairs,
      outerFace: state.prepared.outerFace,
      embedding: state.prepared.baseEmbedding,
      augmented: state.augmented,
      graph: state.prepared.graph,
      pos: projected,
      posById: alignedPosById
    }, extraFields || {}));
  }

  function buildResultFromExistingLayout(existingResult, state, posById, label, extraFields) {
    var alignedPosById = GraphUtils.alignOuterFaceEdgeHorizontally(posById, state.outerFace);
    var projected = filterPositions(alignedPosById, existingResult.nodeIds);
    if (hasPositionCrossings(projected, existingResult.edgePairs)) {
      return buildLayoutError({
        message: label + ' produced a non-plane drawing',
        graph: existingResult.graph,
        outerFace: existingResult.outerFace,
        augmented: existingResult.augmented
      });
    }

    return buildLayoutResult(Object.assign({
      ok: true,
      nodeIds: existingResult.nodeIds,
      edgePairs: existingResult.edgePairs,
      outerFace: existingResult.outerFace,
      embedding: existingResult.embedding,
      augmented: existingResult.augmented,
      graph: existingResult.graph,
      pos: projected,
      posById: alignedPosById
    }, extraFields || {}));
  }

  function verifyAugmentedPositions(state, posById) {
    return PlaygroundUtils.verifyEmbeddingWithPositions(state.augmented.embedding, posById, {
      edgePairs: state.augmented.edgePairs,
      outerFace: state.outerFace
    });
  }

  function interpolateInteriorPositions(state, prevPosById, nextPosById, blend) {
    var rho = Number.isFinite(blend) ? Math.max(0, Math.min(1, blend)) : 1;
    var out = copyPositions(prevPosById || {});
    var i;

    for (i = 0; i < state.outerFace.length; i += 1) {
      var outerId = String(state.outerFace[i]);
      out[outerId] = {
        x: state.fixedOuterPos[outerId].x,
        y: state.fixedOuterPos[outerId].y
      };
    }

    for (i = 0; i < state.movable.length; i += 1) {
      var id = String(state.movable[i]);
      var prev = prevPosById[id];
      var next = nextPosById[id];
      if (!prev || !next) {
        continue;
      }
      out[id] = {
        x: prev.x + rho * (next.x - prev.x),
        y: prev.y + rho * (next.y - prev.y)
      };
    }

    return out;
  }

  function tryBlendedSolve(state, currentPosById, solvedPosById, damping) {
    var rho = Number.isFinite(damping) ? Math.max(0, Math.min(1, damping)) : 1;
    var blended = copyPositions(solvedPosById);
    var verification = verifyAugmentedPositions(state, blended);
    if (!verification.ok) {
      return { ok: false, pos: currentPosById, appliedDamping: 0 };
    }
    if (rho >= 1) {
      return { ok: true, pos: blended, appliedDamping: 1 };
    }

    while (rho >= 1e-3) {
      blended = interpolateInteriorPositions(state, currentPosById, solvedPosById, rho);
      verification = verifyAugmentedPositions(state, blended);
      if (verification.ok) {
        return { ok: true, pos: blended, appliedDamping: rho };
      }
      rho *= 0.5;
    }

    return { ok: true, pos: copyPositions(solvedPosById), appliedDamping: 1 };
  }

  function buildDistanceWeights(edgePairs, posById, baseWeights, options) {
    var opts = options || {};
    var alpha = resolveFloatOption(opts.alpha, 1, 0);
    var mode = typeof opts.weightMode === 'string' ? opts.weightMode : 'normalized-length';
    var drawingDiameter = computeDrawingDiameter(Object.keys(posById || {}), posById || {});
    var eps = resolveFloatOption(opts.epsilon, drawingDiameter * 1e-6, 1e-12);
    var minWeight = resolveFloatOption(opts.minWeight, 1e-3, 1e-12);
    var maxWeight = resolveFloatOption(opts.maxWeight, 1e3, minWeight);
    var weights = {};
    var sum = 0;
    var count = 0;

    for (var i = 0; i < edgePairs.length; i += 1) {
      var u = String(edgePairs[i][0]);
      var v = String(edgePairs[i][1]);
      var pu = posById[u];
      var pv = posById[v];
      var base = baseWeights && Number.isFinite(baseWeights[edgeKey(u, v)]) ? baseWeights[edgeKey(u, v)] : 1;
      var len = (pu && pv) ? Math.hypot(pu.x - pv.x, pu.y - pv.y) : 0;
      var normalizedLen = len / Math.max(drawingDiameter, eps);
      var weight = base;
      if (mode === 'inverse-length') {
        weight = base / Math.pow(len + eps, alpha);
      } else if (mode === 'length') {
        weight = base * Math.pow(len + eps, alpha);
      } else {
        weight = base * Math.pow(normalizedLen + eps, alpha);
      }
      if (!Number.isFinite(weight) || !(weight > 0)) {
        weight = base;
      }
      if (weight < minWeight) weight = minWeight;
      if (weight > maxWeight) weight = maxWeight;
      weights[edgeKey(u, v)] = weight;
      sum += weight;
      count += 1;
    }

    var average = count > 0 ? (sum / count) : 1;
    if (!(average > 0)) {
      average = 1;
    }
    for (i = 0; i < edgePairs.length; i += 1) {
      var key = edgeKey(edgePairs[i][0], edgePairs[i][1]);
      weights[key] /= average;
    }
    return weights;
  }

  function solveWeightedWithFixedOuter(state, weights) {
    return TutteAlgorithm.solveBarycentricPositionsExact(
      state.augmented.nodeIds,
      state.augmented.edgePairs,
      state.outerFace,
      {
        weights: weights,
        adjacency: state.adjacency,
        initOptions: TutteAlgorithm.defaultOuterPlacementOptions({
          useSeedOuter: false,
          fixedOuterPos: state.fixedOuterPos
        })
      }
    );
  }

  function runDistanceReweighting(state, startPosById, options) {
    var opts = options || {};
    var rounds = resolveIntOption(opts.rounds, 4, 0);
    var damping = resolveFloatOption(opts.damping, 0.5, 0, 1);
    var current = copyPositions(startPosById || state.seedPos);
    var solves = 0;

    for (var iter = 0; iter < rounds; iter += 1) {
      var weights = buildDistanceWeights(state.augmented.edgePairs, current, state.baseWeights, opts);
      var solved = solveWeightedWithFixedOuter(state, weights);
      solves += 1;
      if (!solved || !solved.ok || !solved.pos) {
        return buildLayoutError(solved || { message: 'DistanceReweightedTutte failed' });
      }
      var blended = tryBlendedSolve(state, current, solved.pos, damping);
      current = blended.pos;

      if (typeof opts.onIteration === 'function') {
        var moveStats = computePositionMoveStats(state.movable, startPosById || state.seedPos, current, { moveTol: 0 });
        opts.onIteration({
          iter: iter + 1,
          maxIters: rounds,
          maxMove: moveStats.maxMove,
          avgMove: moveStats.avgMove,
          movedVertices: moveStats.movedVertices,
          appliedDamping: blended.appliedDamping
        });
      }
    }

    return {
      ok: true,
      pos: current,
      solves: solves
    };
  }

  function stepToValidPositions(state, currentPosById, targetPosById, options) {
    var opts = options || {};
    var maxStep = resolveFloatOption(opts.maxStepScale, 1, 0, 1);
    var minStep = resolveFloatOption(opts.minStepScale, 1 / 64, 0, 1);
    var fallbackToTarget = opts.fallbackToTarget === true;
    var scale = maxStep;

    while (scale >= minStep) {
      var candidate = interpolateInteriorPositions(state, currentPosById, targetPosById, scale);
      var verification = verifyAugmentedPositions(state, candidate);
      if (verification.ok) {
        return {
          ok: true,
          pos: candidate,
          appliedScale: scale
        };
      }
      scale *= 0.5;
    }

    if (fallbackToTarget) {
      return {
        ok: true,
        pos: copyPositions(targetPosById),
        appliedScale: 1
      };
    }

    return {
      ok: false,
      pos: copyPositions(currentPosById),
      appliedScale: 0
    };
  }

  function buildAntiSmoothTarget(state, currentPosById, eta) {
    var target = copyPositions(currentPosById);
    for (var i = 0; i < state.movable.length; i += 1) {
      var id = String(state.movable[i]);
      var neighbors = state.adjacency[id] || [];
      if (neighbors.length === 0) {
        continue;
      }
      var sx = 0;
      var sy = 0;
      var count = 0;
      for (var j = 0; j < neighbors.length; j += 1) {
        var p = currentPosById[String(neighbors[j])];
        if (!p) {
          continue;
        }
        sx += p.x;
        sy += p.y;
        count += 1;
      }
      if (count === 0) {
        continue;
      }
      var px = currentPosById[id].x;
      var py = currentPosById[id].y;
      var avgX = sx / count;
      var avgY = sy / count;
      target[id] = {
        x: px + eta * (px - avgX),
        y: py + eta * (py - avgY)
      };
    }
    return target;
  }

  function computeMedianPositive(values) {
    var positive = [];
    for (var i = 0; i < values.length; i += 1) {
      if (Number.isFinite(values[i]) && values[i] > 1e-12) {
        positive.push(values[i]);
      }
    }
    if (positive.length === 0) {
      return 1;
    }
    positive.sort(function (a, b) { return a - b; });
    var mid = Math.floor(positive.length / 2);
    if (positive.length % 2 === 1) {
      return positive[mid];
    }
    return 0.5 * (positive[mid - 1] + positive[mid]);
  }

  function computePolygonCentroid(face, posById) {
    var area2 = 0;
    var cx = 0;
    var cy = 0;
    for (var i = 0; i < face.length; i += 1) {
      var a = posById[String(face[i])];
      var b = posById[String(face[(i + 1) % face.length])];
      if (!a || !b) {
        return null;
      }
      var cross = a.x * b.y - b.x * a.y;
      area2 += cross;
      cx += (a.x + b.x) * cross;
      cy += (a.y + b.y) * cross;
    }
    if (Math.abs(area2) <= 1e-12) {
      cx = 0;
      cy = 0;
      for (i = 0; i < face.length; i += 1) {
        var p = posById[String(face[i])];
        cx += p.x;
        cy += p.y;
      }
      return { x: cx / face.length, y: cy / face.length };
    }
    return {
      x: cx / (3 * area2),
      y: cy / (3 * area2)
    };
  }

  function buildFaceExpandTarget(state, currentPosById, eta, options) {
    var opts = options || {};
    var faces = state.augmented.embedding && Array.isArray(state.augmented.embedding.faces)
      ? state.augmented.embedding.faces
      : [];
    var outerFaceIndex = GraphUtils.findOuterFaceIndex(faces, state.outerFace);
    var areas = new Array(faces.length);
    var centroids = new Array(faces.length);
    var i;
    var incidentFacesById = {};
    var medianArea;
    var minWeight;
    var maxWeight;
    var target = copyPositions(currentPosById);

    for (i = 0; i < faces.length; i += 1) {
      areas[i] = GraphUtils.polygonAreaAbs(faces[i], currentPosById);
      centroids[i] = computePolygonCentroid(faces[i], currentPosById);
      if (i === outerFaceIndex) {
        continue;
      }
      for (var j = 0; j < faces[i].length; j += 1) {
        var id = String(faces[i][j]);
        if (!incidentFacesById[id]) {
          incidentFacesById[id] = [];
        }
        incidentFacesById[id].push(i);
      }
    }

    medianArea = computeMedianPositive(areas);
    minWeight = resolveFloatOption(opts.faceWeightMin, 0.25, 0);
    maxWeight = resolveFloatOption(opts.faceWeightMax, 6, minWeight);

    for (i = 0; i < state.movable.length; i += 1) {
      var id = String(state.movable[i]);
      var incident = incidentFacesById[id] || [];
      var sumX = 0;
      var sumY = 0;
      var weightSum = 0;
      for (j = 0; j < incident.length; j += 1) {
        var faceIndex = incident[j];
        var centroid = centroids[faceIndex];
        var area = areas[faceIndex];
        if (!centroid || !(area > 1e-12)) {
          continue;
        }
        var faceWeight = medianArea / Math.max(area, 1e-12);
        if (faceWeight < minWeight) faceWeight = minWeight;
        if (faceWeight > maxWeight) faceWeight = maxWeight;
        sumX += faceWeight * (currentPosById[id].x - centroid.x);
        sumY += faceWeight * (currentPosById[id].y - centroid.y);
        weightSum += faceWeight;
      }
      if (!(weightSum > 0)) {
        continue;
      }
      target[id] = {
        x: currentPosById[id].x + eta * (sumX / weightSum),
        y: currentPosById[id].y + eta * (sumY / weightSum)
      };
    }

    return target;
  }

  function runAntiSmoothing(state, startPosById, options) {
    var opts = options || {};
    var passes = resolveIntOption(opts.passes, 8, 0);
    var eta = resolveFloatOption(opts.eta, 0.1, 0);
    var current = copyPositions(startPosById);
    var accepted = 0;

    for (var iter = 0; iter < passes; iter += 1) {
      var target = buildAntiSmoothTarget(state, current, eta);
      var stepped = stepToValidPositions(state, current, target, {});
      current = stepped.pos;
      if (stepped.appliedScale > 0) {
        accepted += 1;
      }
      if (typeof opts.onIteration === 'function') {
        var moveStats = computePositionMoveStats(state.movable, startPosById, current, { moveTol: 0 });
        opts.onIteration({
          iter: iter + 1,
          maxIters: passes,
          maxMove: moveStats.maxMove,
          avgMove: moveStats.avgMove,
          movedVertices: moveStats.movedVertices,
          appliedScale: stepped.appliedScale
        });
      }
    }

    return {
      ok: true,
      pos: current,
      accepted: accepted,
      iters: passes
    };
  }

  function runFaceExpansion(state, startPosById, options) {
    var opts = options || {};
    var passes = resolveIntOption(opts.passes, 8, 0);
    var eta = resolveFloatOption(opts.eta, 0.18, 0);
    var current = copyPositions(startPosById);
    var accepted = 0;

    for (var iter = 0; iter < passes; iter += 1) {
      var target = buildFaceExpandTarget(state, current, eta, opts);
      var stepped = stepToValidPositions(state, current, target, {});
      current = stepped.pos;
      if (stepped.appliedScale > 0) {
        accepted += 1;
      }
      if (typeof opts.onIteration === 'function') {
        var moveStats = computePositionMoveStats(state.movable, startPosById, current, { moveTol: 0 });
        opts.onIteration({
          iter: iter + 1,
          maxIters: passes,
          maxMove: moveStats.maxMove,
          avgMove: moveStats.avgMove,
          movedVertices: moveStats.movedVertices,
          appliedScale: stepped.appliedScale
        });
      }
    }

    return {
      ok: true,
      pos: current,
      accepted: accepted,
      iters: passes
    };
  }

  function computeDistanceReweightedTuttePositions(nodeIds, edgePairs, options) {
    var opts = options || {};
    var state = prepareExplorationState(nodeIds, edgePairs, opts, 'DistanceReweightedTutte layout');
    if (!state || !state.ok) {
      return buildLayoutError(state || { message: 'DistanceReweightedTutte failed' });
    }

    var result = runDistanceReweighting(state, state.seedPos, {
      rounds: opts.rounds,
      alpha: opts.alpha,
      damping: opts.damping,
      weightMode: opts.weightMode,
      epsilon: opts.epsilon,
      minWeight: opts.minWeight,
      maxWeight: opts.maxWeight,
      onIteration: opts.onIteration
    });
    if (!result || !result.ok) {
      return buildLayoutError(result || { message: 'DistanceReweightedTutte failed' });
    }

    return buildAlignedResult(state, result.pos, 'DistanceReweightedTutte', {
      iters: 1 + result.solves
    });
  }

  function computeTutteAntiSmoothPositions(nodeIds, edgePairs, options) {
    var opts = options || {};
    var state = prepareExplorationState(nodeIds, edgePairs, opts, 'TutteAntiSmooth layout');
    if (!state || !state.ok) {
      return buildLayoutError(state || { message: 'TutteAntiSmooth failed' });
    }

    var result = runAntiSmoothing(state, state.seedPos, {
      passes: opts.passes,
      eta: opts.eta,
      onIteration: opts.onIteration
    });
    if (!result || !result.ok) {
      return buildLayoutError(result || { message: 'TutteAntiSmooth failed' });
    }

    return buildAlignedResult(state, result.pos, 'TutteAntiSmooth', {
      iters: 1 + result.iters,
      accepted: result.accepted
    });
  }

  function computeTutteFaceExpandPositions(nodeIds, edgePairs, options) {
    var opts = options || {};
    var state = prepareExplorationState(nodeIds, edgePairs, opts, 'TutteFaceExpand layout');
    if (!state || !state.ok) {
      return buildLayoutError(state || { message: 'TutteFaceExpand failed' });
    }

    var result = runFaceExpansion(state, state.seedPos, {
      passes: opts.passes,
      eta: opts.eta,
      faceWeightMin: opts.faceWeightMin,
      faceWeightMax: opts.faceWeightMax,
      onIteration: opts.onIteration
    });
    if (!result || !result.ok) {
      return buildLayoutError(result || { message: 'TutteFaceExpand failed' });
    }

    return buildAlignedResult(state, result.pos, 'TutteFaceExpand', {
      iters: 1 + result.iters,
      accepted: result.accepted
    });
  }

  function computeDistanceReweightedTuttePlusPositions(nodeIds, edgePairs, options) {
    var opts = options || {};
    var state = prepareExplorationState(nodeIds, edgePairs, opts, 'DistanceReweightedTuttePlus layout');
    if (!state || !state.ok) {
      return buildLayoutError(state || { message: 'DistanceReweightedTuttePlus failed' });
    }

    var reweighted = runDistanceReweighting(state, state.seedPos, {
      rounds: resolveIntOption(opts.rounds, 4, 0),
      alpha: opts.alpha,
      damping: opts.damping,
      weightMode: opts.weightMode,
      epsilon: opts.epsilon,
      minWeight: opts.minWeight,
      maxWeight: opts.maxWeight
    });
    if (!reweighted || !reweighted.ok) {
      return buildLayoutError(reweighted || { message: 'DistanceReweightedTuttePlus failed' });
    }

    var currentPos = reweighted.pos;
    var totalAccepted = 0;
    var totalIters = 1 + reweighted.solves;

    var antiPasses = resolveIntOption(opts.antiPasses, 0, 0);
    if (antiPasses > 0) {
      var anti = runAntiSmoothing(state, currentPos, {
        passes: antiPasses,
        eta: resolveFloatOption(opts.antiEta, 0.08, 0)
      });
      if (!anti || !anti.ok) {
        return buildLayoutError(anti || { message: 'DistanceReweightedTuttePlus failed' });
      }
      currentPos = anti.pos;
      totalAccepted += anti.accepted;
      totalIters += anti.iters;
    }

    var expanded = runFaceExpansion(state, currentPos, {
      passes: resolveIntOption(opts.facePasses, 8, 0),
      eta: resolveFloatOption(opts.faceEta, 0.18, 0),
      faceWeightMin: opts.faceWeightMin,
      faceWeightMax: opts.faceWeightMax
    });
    if (!expanded || !expanded.ok) {
      return buildLayoutError(expanded || { message: 'DistanceReweightedTuttePlus failed' });
    }

    return buildAlignedResult(state, expanded.pos, 'DistanceReweightedTuttePlus', {
      iters: totalIters + expanded.iters,
      accepted: totalAccepted + expanded.accepted
    });
  }

  function normalizeTutteAdaptiveFaceExpandOptions(options) {
    var opts = options || {};
    return {
      adaptiveRounds: opts.adaptiveRounds,
      maxIters: opts.maxIters,
      tolerance: opts.tolerance,
      augmentationMethod: opts.augmentationMethod,
      augmentationOptions: opts.augmentationOptions,
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
      pressureScaleMax: opts.pressureScaleMax,
      faceScoreThreshold: resolveFloatOption(opts.faceScoreThreshold, 0.9, 0, 1),
      facePasses: resolveIntOption(opts.facePasses, 4, 0),
      faceEta: resolveFloatOption(opts.faceEta, 0.04, 0),
      faceWeightMin: opts.faceWeightMin,
      faceWeightMax: opts.faceWeightMax,
      onIteration: resolveFunctionOption(opts.onIteration, null)
    };
  }

  function computeTutteAdaptiveFaceExpandPositions(nodeIds, edgePairs, options) {
    var opts = normalizeTutteAdaptiveFaceExpandOptions(options);
    var base = TutteAdaptive.computeTutteAdaptiveLayout(nodeIds, edgePairs, opts);
    if (!base || !base.ok || !base.posById) {
      return buildLayoutError(base || { message: 'TutteAdaptiveFaceExpand failed' });
    }

    var projectedBase = filterPositions(base.pos || base.posById || {}, base.nodeIds);
    var faceScore = Metrics && typeof Metrics.computeUniformFaceAreaScore === 'function'
      ? Metrics.computeUniformFaceAreaScore(base.nodeIds, base.edgePairs, projectedBase)
      : null;
    var threshold = opts.faceScoreThreshold;
    if (faceScore && faceScore.ok && Number.isFinite(threshold) && faceScore.quality >= threshold) {
      return buildLayoutResult(Object.assign({}, base, {
        faceExpandApplied: false,
        faceExpandAccepted: 0,
        faceScoreBeforeExpand: faceScore.quality
      }));
    }

    var state = buildPostProcessStateFromResult(base);
    var result = runFaceExpansion(state, base.posById, {
      passes: opts.facePasses,
      eta: opts.faceEta,
      faceWeightMin: opts.faceWeightMin,
      faceWeightMax: opts.faceWeightMax,
      onIteration: opts.onIteration
    });
    if (!result || !result.ok) {
      return buildLayoutError(result || { message: 'TutteAdaptiveFaceExpand failed' });
    }

    return buildResultFromExistingLayout(base, state, result.pos, 'TutteAdaptiveFaceExpand', {
      iters: (Number.isFinite(base.iters) ? base.iters : 0) + result.iters,
      accepted: result.accepted,
      faceExpandApplied: result.accepted > 0,
      faceExpandAccepted: result.accepted,
      faceScoreBeforeExpand: faceScore && faceScore.ok ? faceScore.quality : null
    });
  }

  function applyLayoutWithResult(cy, result, label) {
    if (!result || !result.ok) {
      return buildLayoutError(result || {
        message: label + ' failed',
        graph: graphFromCy(cy)
      });
    }

    applyAndFit(cy, result.pos);
    return {
      ok: true,
      message: buildLayoutStatusMessage(label, {
        outerFaceVertexCount: result.outerFace.length,
        iters: result.iters,
        accepted: result.accepted
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

  function applyDistanceReweightedTutteLayout(cy, options) {
    var graph = graphFromCy(cy);
    return applyLayoutWithResult(cy, computeDistanceReweightedTuttePositions(graph.nodeIds, graph.edgePairs, options || {}), 'DistanceReweightedTutte');
  }

  function applyTutteAntiSmoothLayout(cy, options) {
    var graph = graphFromCy(cy);
    return applyLayoutWithResult(cy, computeTutteAntiSmoothPositions(graph.nodeIds, graph.edgePairs, options || {}), 'TutteAntiSmooth');
  }

  function applyTutteFaceExpandLayout(cy, options) {
    var graph = graphFromCy(cy);
    return applyLayoutWithResult(cy, computeTutteFaceExpandPositions(graph.nodeIds, graph.edgePairs, options || {}), 'TutteFaceExpand');
  }

  function applyDistanceReweightedTuttePlusLayout(cy, options) {
    var graph = graphFromCy(cy);
    return applyLayoutWithResult(cy, computeDistanceReweightedTuttePlusPositions(graph.nodeIds, graph.edgePairs, options || {}), 'DistanceReweightedTuttePlus');
  }

  function applyTutteAdaptiveFaceExpandLayout(cy, options) {
    var graph = graphFromCy(cy);
    return applyLayoutWithResult(cy, computeTutteAdaptiveFaceExpandPositions(graph.nodeIds, graph.edgePairs, options || {}), 'TutteAdaptiveFaceExpand');
  }

  global.PlanarVibeDistanceReweightedTutte = {
    computeDistanceReweightedTuttePositions: computeDistanceReweightedTuttePositions,
    applyDistanceReweightedTutteLayout: applyDistanceReweightedTutteLayout
  };

  global.PlanarVibeTutteAntiSmooth = {
    computeTutteAntiSmoothPositions: computeTutteAntiSmoothPositions,
    applyTutteAntiSmoothLayout: applyTutteAntiSmoothLayout
  };

  global.PlanarVibeTutteFaceExpand = {
    computeTutteFaceExpandPositions: computeTutteFaceExpandPositions,
    applyTutteFaceExpandLayout: applyTutteFaceExpandLayout
  };

  global.PlanarVibeDistanceReweightedTuttePlus = {
    computeDistanceReweightedTuttePlusPositions: computeDistanceReweightedTuttePlusPositions,
    applyDistanceReweightedTuttePlusLayout: applyDistanceReweightedTuttePlusLayout
  };

  global.PlanarVibeTutteAdaptiveFaceExpand = {
    computeTutteAdaptiveFaceExpandPositions: computeTutteAdaptiveFaceExpandPositions,
    applyTutteAdaptiveFaceExpandLayout: applyTutteAdaptiveFaceExpandLayout
  };
})(window);
