(function (global) {
  'use strict';

  var LayoutPreprocessing = global.LayoutPreprocessing;
  var CyRuntime = global.CyRuntime;
  var Metrics = global.PlanarVibeMetrics;
  var GeometryUtils = global.GeometryUtils;
  var buildLayoutError = global.GraphUtils.buildLayoutError;
  var buildLayoutResult = global.GraphUtils.buildLayoutResult;
  var buildLayoutStatusMessage = global.GraphUtils.buildLayoutStatusMessage;
  var edgeKey = global.GraphUtils.edgeKey;
  var faceKey = global.GraphUtils.faceKey;
  var polygonArea2 = GeometryUtils.polygonArea2;
  var pointAdd = GeometryUtils.pointAdd;
  var pointDot = GeometryUtils.pointDot;
  var pointNorm = GeometryUtils.pointNorm;
  var pointRot90 = GeometryUtils.pointRot90;
  var pointScale = GeometryUtils.pointScale;
  var pointSub = GeometryUtils.pointSub;
  var resolveFloatOption = global.GraphUtils.resolveFloatOption;
  var resolveFunctionOption = global.GraphUtils.resolveFunctionOption;
  var resolveIntOption = global.GraphUtils.resolveIntOption;
  var orientFaceCCW = GeometryUtils.orientFaceCCW;
  var outerFaceDiameter = GeometryUtils.outerFaceDiameter;
  var triangleArea2 = GeometryUtils.triangleArea2;
  var hasPositionCrossings = GeometryUtils.hasPositionCrossings;

  function buildAirData(augmentedEmbedding, outerFace, posById, originalNodeIds, options) {
    var outerKey = faceKey(outerFace);
    var outerRingFaceWeight = options.outerRingFaceWeight;
    var outerEdgeSet = {};
    var outerVertexSet = new Set(outerFace.map(String));
    var originalVertexSet = new Set(originalNodeIds.map(String));
    var i;

    for (i = 0; i < outerFace.length; i += 1) {
      outerEdgeSet[edgeKey(outerFace[i], outerFace[(i + 1) % outerFace.length])] = true;
    }

    var triangles = [];
    var incident = {};
    var outerRingTriangleCount = 0;

    for (i = 0; i < augmentedEmbedding.idByIndex.length; i += 1) {
      incident[String(augmentedEmbedding.idByIndex[i])] = [];
    }

    for (i = 0; i < augmentedEmbedding.faces.length; i += 1) {
      var face = augmentedEmbedding.faces[i];
      if (!face || face.length < 3) {
        return buildLayoutError({ reason: 'Air requires a valid triangulated augmentation' });
      }

      var oriented = orientFaceCCW(face, posById);
      if (faceKey(oriented) === outerKey) {
        continue;
      }
      if (face.length !== 3) {
        return buildLayoutError({ reason: 'Air requires all non-outer augmented faces to be triangles' });
      }

      var isOuterRing = false;
      for (var ei = 0; ei < oriented.length; ei += 1) {
        if (outerVertexSet.has(String(oriented[ei]))) {
          isOuterRing = true;
          break;
        }
        if (outerEdgeSet[edgeKey(oriented[ei], oriented[(ei + 1) % oriented.length])]) {
          isOuterRing = true;
          break;
        }
      }
      if (isOuterRing) {
        outerRingTriangleCount += 1;
      }
      var isRealFace = true;
      for (ei = 0; ei < oriented.length; ei += 1) {
        if (!originalVertexSet.has(String(oriented[ei]))) {
          isRealFace = false;
          break;
        }
      }

      var triangleIndex = triangles.length;
      triangles.push({
        vertices: oriented,
        targetArea: 0,
        weight: isOuterRing ? outerRingFaceWeight : 1,
        isOuterRing: isOuterRing,
        isRealFace: isRealFace
      });

      for (var j = 0; j < 3; j += 1) {
        var v = String(oriented[j]);
        incident[v].push({
          faceIndex: triangleIndex,
          left: String(oriented[(j + 2) % 3]),
          right: String(oriented[(j + 1) % 3])
        });
      }
    }

    if (triangles.length === 0) {
      return buildLayoutResult({
        ok: true,
        triangles: triangles,
        incident: incident,
        targetTriangleArea: 0
      });
    }

    var outerArea = Math.abs(polygonArea2(outerFace, posById)) / 2;
    if (!(outerArea > 1e-12)) {
      return buildLayoutError({ reason: 'AirPlus initialization failed: outer face has zero area' });
    }
    var targetTriangleArea = outerArea / triangles.length;
    for (i = 0; i < triangles.length; i += 1) {
      triangles[i].targetArea = triangles[i].isRealFace
        ? (options.realFaceTargetScale * targetTriangleArea)
        : targetTriangleArea;
    }

    return buildLayoutResult({
      ok: true,
      outerFace: outerFace.slice().map(String),
      triangles: triangles,
      incident: incident,
      targetTriangleArea: targetTriangleArea,
      outerRingTriangleCount: outerRingTriangleCount
    });
  }

  function buildEdgeTargetData(graph, augmentedGraph, posById, options) {
    var edgePairs = graph && Array.isArray(graph.edgePairs) ? graph.edgePairs : [];
    var augmentedEdgePairs = augmentedGraph && Array.isArray(augmentedGraph.edgePairs) ? augmentedGraph.edgePairs : [];
    var edgeEntries = [];
    var incident = {};
    var originalEdgeSet = {};
    var logLen2Sum = 0;
    var originalLogLen2 = [];
    var validCount = 0;
    var i;

    for (i = 0; i < edgePairs.length; i += 1) {
      var u = String(edgePairs[i][0]);
      var v = String(edgePairs[i][1]);
      originalEdgeSet[edgeKey(u, v)] = true;
      var pu = posById[u];
      var pv = posById[v];
      if (!pu || !pv) {
        continue;
      }
      var dx = pu.x - pv.x;
      var dy = pu.y - pv.y;
      var len2 = dx * dx + dy * dy;
      if (!(len2 > 1e-12)) {
        continue;
      }
      edgeEntries.push({ u: u, v: v, weight: 1, isOriginal: true });
      if (!incident[u]) incident[u] = [];
      if (!incident[v]) incident[v] = [];
      incident[u].push({ other: v, weight: 1, isOriginal: true });
      incident[v].push({ other: u, weight: 1, isOriginal: true });
      logLen2Sum += Math.log(len2);
      originalLogLen2.push(Math.log(len2));
      validCount += 1;
    }

    for (i = 0; i < augmentedEdgePairs.length; i += 1) {
      u = String(augmentedEdgePairs[i][0]);
      v = String(augmentedEdgePairs[i][1]);
      if (originalEdgeSet[edgeKey(u, v)]) {
        continue;
      }
      pu = posById[u];
      pv = posById[v];
      if (!pu || !pv) {
        continue;
      }
      edgeEntries.push({
        u: u,
        v: v,
        weight: options.dummyEdgeWeight,
        isOriginal: false
      });
      if (!incident[u]) incident[u] = [];
      if (!incident[v]) incident[v] = [];
      incident[u].push({ other: v, weight: options.dummyEdgeWeight, isOriginal: false });
      incident[v].push({ other: u, weight: options.dummyEdgeWeight, isOriginal: false });
    }

    var targetLogLen2 = 0;
    if (validCount > 0) {
      originalLogLen2.sort(function (a, b) { return a - b; });
      var quantileIndex = Math.min(
        originalLogLen2.length - 1,
        Math.max(0, Math.floor(options.edgeTargetQuantile * (originalLogLen2.length - 1)))
      );
      targetLogLen2 = originalLogLen2[quantileIndex];
    }

    return {
      edges: edgeEntries,
      incident: incident,
      targetLogLen2: validCount > 0 ? targetLogLen2 : 0
    };
  }

  function summarizeEdgeLengths(edgeData, posById) {
    var minLength = Infinity;
    var maxLength = 0;
    var maxLogDeviation = 0;
    var validCount = 0;

    for (var i = 0; i < edgeData.edges.length; i += 1) {
      var edge = edgeData.edges[i];
      if (!edge.isOriginal) {
        continue;
      }
      var pu = posById[edge.u];
      var pv = posById[edge.v];
      if (!pu || !pv) {
        continue;
      }
      var dx = pu.x - pv.x;
      var dy = pu.y - pv.y;
      var len2 = dx * dx + dy * dy;
      if (!(len2 > 1e-12)) {
        continue;
      }
      var length = Math.sqrt(len2);
      if (length < minLength) minLength = length;
      if (length > maxLength) maxLength = length;
      var deviation = Math.abs(Math.log(len2) - edgeData.targetLogLen2);
      if (deviation > maxLogDeviation) {
        maxLogDeviation = deviation;
      }
      validCount += 1;
    }

    return {
      minLength: Number.isFinite(minLength) ? minLength : null,
      maxLength: maxLength > 0 ? maxLength : null,
      ratio: Number.isFinite(minLength) && maxLength > 0 ? (minLength / maxLength) : null,
      maxLogDeviation: validCount > 0 ? maxLogDeviation : null
    };
  }

  function evaluateLocalState(vertexId, entries, airData, posById, point, options) {
    var areas = [];
    var feasible = true;
    var force = { x: 0, y: 0 };
    var entropy = 0;
    var a = 0;
    var b = 0;
    var c = 0;
    var triangles = airData.triangles;
    var tolAreaPositive = options.tolAreaPositive;

    for (var i = 0; i < entries.length; i += 1) {
      var entry = entries[i];
      var tri = triangles[entry.faceIndex];
      var leftPos = posById[entry.left];
      var rightPos = posById[entry.right];
      if (!leftPos || !rightPos || !tri) {
        feasible = false;
        areas.push(0);
        continue;
      }

      var s = pointSub(leftPos, rightPos);
      var r = pointRot90(s);
      var delta = pointSub(point, rightPos);
      var area = 0.5 * (s.x * delta.y - s.y * delta.x);
      areas.push(area);
      if (!(area > tolAreaPositive)) {
        feasible = false;
        continue;
      }

      var weight = Number.isFinite(tri.weight) ? tri.weight : 1;
      var pressure;
      var coeff;
      if (area <= tri.targetArea) {
        pressure = tri.targetArea / area;
        entropy += -weight * tri.targetArea * Math.log(Math.max(pressure, 1e-300));
        coeff = -0.25 * weight * tri.targetArea / (area * area);
      } else {
        var oversizeRatio = area / tri.targetArea;
        pressure = -Math.log(Math.max(oversizeRatio, 1));
        entropy += -weight * (
          area * Math.log(Math.max(oversizeRatio, 1)) - area + tri.targetArea
        );
        coeff = -0.25 * weight / area;
      }
      force.x += weight * pressure * r.x;
      force.y += weight * pressure * r.y;

      a += coeff * r.x * r.x;
      b += coeff * r.x * r.y;
      c += coeff * r.y * r.y;
    }

    var edgeIncident = airData.edgeData && airData.edgeData.incident
      ? airData.edgeData.incident[vertexId]
      : null;
    if (edgeIncident && edgeIncident.length > 0 && options.edgeWeight > 0) {
      for (i = 0; i < edgeIncident.length; i += 1) {
        var edgeEntry = edgeIncident[i];
        var otherId = edgeEntry.other;
        var otherPos = posById[otherId];
        if (!otherPos) {
          continue;
        }
        var ex = point.x - otherPos.x;
        var ey = point.y - otherPos.y;
        var len2 = ex * ex + ey * ey;
        if (!(len2 > options.edgeTol2)) {
          feasible = false;
          continue;
        }
        var residual = Math.log(len2) - airData.edgeData.targetLogLen2;
        var residualScale = residual < 0 ? options.shortEdgeBoost : options.longEdgeWeightScale;
        var effectiveEdgeWeight = options.edgeWeight * options.edgeForceScale;
        var edgeCoeff = -4 * effectiveEdgeWeight * edgeEntry.weight * residualScale * residual / len2;
        force.x += edgeCoeff * ex;
        force.y += edgeCoeff * ey;
        entropy -= effectiveEdgeWeight * edgeEntry.weight * residualScale * residual * residual;
      }
    }

    return {
      feasible: feasible,
      areas: areas,
      force: force,
      entropy: entropy,
      a: a,
      b: b,
      c: c
    };
  }

  function solveBalancedPosition(vertexId, airData, posById, opts) {
    var p = { x: posById[vertexId].x, y: posById[vertexId].y };
    var entries = opts.entries;
    var maxNewtonIter = opts.maxNewtonIter;
    var tolForceVertex = opts.tolForceVertex;
    var armijo = opts.armijo;
    var minStep = opts.minStep;
    var state = opts.initialState;

    for (var iter = 0; iter < maxNewtonIter; iter += 1) {
      if (!state) {
        state = evaluateLocalState(vertexId, entries, airData, posById, p, opts);
      }
      if (!state.feasible) {
        return { pos: p, forceNorm: Infinity, stalled: true };
      }

      var forceNorm = pointNorm(state.force);
      if (forceNorm <= tolForceVertex) {
        return { pos: p, forceNorm: forceNorm, stalled: false };
      }

      var g = { x: 0.5 * state.force.x, y: 0.5 * state.force.y };
      var det = state.a * state.c - state.b * state.b;
      var d;
      if (det > 1e-18) {
        d = {
          x: (state.b * g.y - state.c * g.x) / det,
          y: (state.b * g.x - state.a * g.y) / det
        };
        if (!Number.isFinite(d.x) || !Number.isFinite(d.y)) {
          d = { x: g.x, y: g.y };
        }
      } else {
        d = { x: g.x, y: g.y };
      }

      if (pointDot(g, d) <= 0) {
        d = { x: g.x, y: g.y };
      }

      var alpha = 1;
      var accepted = false;
      while (alpha >= minStep) {
        var q = pointAdd(p, pointScale(alpha, d));
        var qState = evaluateLocalState(vertexId, entries, airData, posById, q, opts);
        if (qState.feasible &&
            qState.entropy >= state.entropy + armijo * alpha * pointDot(g, d)) {
          p = q;
          state = qState;
          accepted = true;
          break;
        }
        alpha *= 0.5;
      }

      if (!accepted) {
        return { pos: p, forceNorm: forceNorm, stalled: true };
      }
    }

    var finalState = state;
    if (!finalState) {
      finalState = evaluateLocalState(vertexId, entries, airData, posById, p, opts);
    }
    return {
      pos: p,
      forceNorm: finalState.feasible ? pointNorm(finalState.force) : Infinity,
      stalled: false
    };
  }

  function computeAirStats(airData, posById, movableVertices, tolAreaPositive) {
    var maxRelError = 0;
    for (var i = 0; i < airData.triangles.length; i += 1) {
      var tri = airData.triangles[i];
      var a = posById[tri.vertices[0]];
      var b = posById[tri.vertices[1]];
      var c = posById[tri.vertices[2]];
      var area = (a && b && c) ? (Math.abs(triangleArea2(a, b, c)) / 2) : 0;
      var targetArea = tri.targetArea;
      var rel = Math.abs(area - targetArea) / Math.max(targetArea, 1e-12);
      if (!Number.isFinite(rel)) rel = Infinity;
      if (rel > maxRelError) {
        maxRelError = rel;
      }
    }

    var maxForce = 0;
    var balancedCount = 0;
    for (i = 0; i < movableVertices.length; i += 1) {
      var v = movableVertices[i];
      var state = evaluateLocalState(v, airData.incident[v], airData, posById, posById[v], {
        tolAreaPositive: tolAreaPositive,
        edgeWeight: airData.edgeWeight,
        edgeTol2: airData.edgeTol2
      });
      var f = state.feasible ? pointNorm(state.force) : Infinity;
      if (f > maxForce) {
        maxForce = f;
      }
      if (f <= 1e-8) {
        balancedCount += 1;
      }
    }

    var edgeStats = summarizeEdgeLengths(airData.edgeData, posById);

    return {
      maxRelError: maxRelError,
      maxForce: maxForce,
      balancedCount: balancedCount,
      boundedFaceCount: airData.triangles.length,
      edgeLengthRatio: edgeStats.ratio,
      maxLogDeviation: edgeStats.maxLogDeviation,
      minEdgeLength: edgeStats.minLength,
      maxEdgeLength: edgeStats.maxLength
    };
  }

  function fillAirSettings(options) {
    if (options.augmentationMethod === undefined) {
      options.augmentationMethod = null;
    }
    options.augmentationOptions = typeof options.augmentationOptions === 'object' && options.augmentationOptions
      ? Object.assign({}, options.augmentationOptions)
      : null;
    options.maxSweeps = 400;
    options.maxNewtonIter = 10;
    options.tolForceGlobal = 1e-8;
    options.tolForceVertex = 1e-6;
    options.tolAreaGlobal = 1e-3;
    options.tolAreaPositive = 1e-15;
    options.tolMove = 1e-12;
    options.armijo = 1e-4;
    options.outerRingFaceWeight = resolveFloatOption(options.outerRingFaceWeight, 0.25, 0);
    options.edgeWeight = 0;
    options.edgeTol2 = 1e-12;
    options.minStep = Math.pow(2, -40);
    options.delayMs = 0;
    options.onIteration = resolveFunctionOption(options.onIteration, null);
    options.yieldEvery = 5;
    options.renderEvery = 2;
    options.moveTolRel = 1e-5;
    options.moveTolAbs = 1e-12;
    options.errTolRel = 1e-4;
    options.patience = 2;
    options.deadlockPatience = 2;
    options.plateauWindow = 12;
    options.plateauPatience = 1;
    options.plateauErrTolAbs = null;
    options.plateauErrTolRel = null;
    options.plateauErrGuardFactor = 20;
    options.shortEdgeBoost = 5;
    options.longEdgeWeightScale = 0.4;
    options.dummyEdgeWeight = 0.08;
    options.edgeTargetQuantile = 0.75;
    options.realFaceTargetScale = 1;
    options.edgeForceScale = 1;
  }

  function prepareAirState(graph, options) {
    fillAirSettings(options);
    var context = LayoutPreprocessing.prepareGraphAndLayoutData(graph, {
      failureLabel: 'AirPlus layout',
      augmentationMethod: options.augmentationMethod,
      augmentationOptions: options.augmentationOptions,
      currentPositions: options.currentPositions
    });
    if (!context.ok) {
      return buildLayoutError(context);
    }
    if (!Array.isArray(context.augmentedOuterFace) || context.augmentedOuterFace.length < 3) {
      return buildLayoutError({ message: 'AirPlus setup failed: missing augmented outer face' });
    }

    var airData = buildAirData(
      context.augmented.embedding,
      context.augmentedOuterFace,
      context.posById,
      context.graph.nodeIds,
      options
    );
    if (!airData.ok) {
      return buildLayoutError({ message: airData.reason });
    }
    airData.edgeData = buildEdgeTargetData(context.graph, context.augmented.graph, context.posById, options);
    airData.edgeWeight = options.edgeWeight;
    airData.edgeTol2 = options.edgeTol2;

    if (airData.triangles.length === 0) {
      return buildLayoutResult({
        ok: true,
        opts: options,
        graph: context.graph,
        baseEmbedding: context.baseEmbedding,
        outerFace: context.augmentedOuterFace,
        augmented: context.augmented,
        posById: context.posById,
        airData: airData,
        movableVertices: []
      });
    }

    for (var fi = 0; fi < airData.triangles.length; fi += 1) {
      var tri = airData.triangles[fi];
      var area = Math.abs(triangleArea2(
        context.posById[tri.vertices[0]],
        context.posById[tri.vertices[1]],
        context.posById[tri.vertices[2]]
      )) / 2;
      if (!(area > options.tolAreaPositive)) {
        return buildLayoutError({ message: 'AirPlus initialization failed: degenerate augmented triangle' });
      }
    }

    var movableVertices = [];
    for (var ni = 0; ni < context.movableVertices.length; ni += 1) {
      var nodeId = String(context.movableVertices[ni]);
      if (airData.incident[nodeId] && airData.incident[nodeId].length > 0) {
        movableVertices.push(nodeId);
      }
    }

    return buildLayoutResult({
      ok: true,
      opts: options,
      graph: context.graph,
      baseEmbedding: context.baseEmbedding,
      outerFace: context.augmentedOuterFace,
      augmented: context.augmented,
      posById: context.posById,
      airData: airData,
      movableVertices: movableVertices
    });
  }

  async function runAirIterations(prepared, options) {
    var g = prepared.graph;
    var posById = prepared.posById;
    var airData = prepared.airData;
    var movableVertices = prepared.movableVertices;
    var status = 'max_sweeps';
    var lastStats = computeAirStats(airData, posById, movableVertices, options.tolAreaPositive);
    var outerDiameter = outerFaceDiameter(posById, airData.outerFace);
    var moveTol = options.moveTolAbs + options.moveTolRel * outerDiameter;
    var avgMoveTol = 0.25 * moveTol;
    var plateauErrTolAbs = options.plateauErrTolAbs !== null ? options.plateauErrTolAbs : options.tolAreaGlobal;
    var plateauErrTolRel = options.plateauErrTolRel !== null ? options.plateauErrTolRel : 5 * options.errTolRel;
    var plateauErrGuard = options.plateauErrGuardFactor * options.tolAreaGlobal;
    var prevMaxRelErr = lastStats.maxRelError;
    var stalledSweeps = 0;
    var deadSweeps = 0;
    var plateauSweeps = 0;
    var errWindow = [prevMaxRelErr];
    var lastMoveStats = { movedVertices: 0, avgMove: 0, maxMove: 0, acceptedCount: 0 };

    if (prevMaxRelErr <= options.tolAreaGlobal) {
      lastStats.maxMove = 0;
      lastStats.avgMove = 0;
      lastStats.acceptedCount = 0;
      lastStats.sweeps = 0;
      return {
        ok: !hasPositionCrossings(posById, g.edgePairs),
        status: 'realized',
        positions: posById,
        stats: lastStats,
        moveStats: lastMoveStats,
        boundedFaceCount: airData.triangles.length,
        dummyCount: prepared.augmented ? prepared.augmented.dummyCount : 0,
        hasCrossings: hasPositionCrossings(posById, g.edgePairs)
      };
    }

    for (var sweep = 1; sweep <= options.maxSweeps; sweep += 1) {
      var acceptedCount = 0;
      var sumMove = 0;
      var maxMove = 0;

      for (var vi = 0; vi < movableVertices.length; vi += 1) {
        var v = movableVertices[vi];
        var currentState = evaluateLocalState(v, airData.incident[v], airData, posById, posById[v], options);
        var currentForce = currentState.feasible ? pointNorm(currentState.force) : Infinity;
        if (currentForce <= options.tolForceGlobal) {
          continue;
        }

        var solved = solveBalancedPosition(v, airData, posById, {
          entries: airData.incident[v],
          initialState: currentState,
          maxNewtonIter: options.maxNewtonIter,
          tolForceVertex: options.tolForceVertex,
          armijo: options.armijo,
          minStep: options.minStep,
          tolAreaPositive: options.tolAreaPositive,
          edgeWeight: options.edgeWeight,
          edgeForceScale: options.edgeForceScale,
          edgeTol2: options.edgeTol2,
          shortEdgeBoost: options.shortEdgeBoost,
          longEdgeWeightScale: options.longEdgeWeightScale
        });
        if (!solved || !solved.pos) {
          continue;
        }
        var basePos = { x: posById[v].x, y: posById[v].y };
        var dx = solved.pos.x - basePos.x;
        var dy = solved.pos.y - basePos.y;
        var acceptedPos = null;
        var stepScale = 1;
        while (stepScale >= options.minStep) {
          var candidate = {
            x: basePos.x + stepScale * dx,
            y: basePos.y + stepScale * dy
          };
          var candidateState = evaluateLocalState(v, airData.incident[v], airData, posById, candidate, options);
          if (candidateState.feasible) {
            acceptedPos = candidate;
            break;
          }
          stepScale *= 0.5;
        }
        if (acceptedPos) {
          posById[v] = acceptedPos;
          var moveDx = acceptedPos.x - basePos.x;
          var moveDy = acceptedPos.y - basePos.y;
          var move = Math.sqrt(moveDx * moveDx + moveDy * moveDy);
          if (move > 0) {
            if (move > maxMove) {
              maxMove = move;
            }
            sumMove += move;
            acceptedCount += 1;
          }
        } else {
          posById[v] = basePos;
        }
      }

      lastMoveStats = {
        movedVertices: acceptedCount,
        avgMove: 0,
        maxMove: 0
      };
      lastMoveStats.maxMove = maxMove;
      lastMoveStats.avgMove = acceptedCount > 0 ? (sumMove / acceptedCount) : 0;
      lastMoveStats.acceptedCount = acceptedCount;
      lastStats = computeAirStats(airData, posById, movableVertices, options.tolAreaPositive);
      var maxRelErr = lastStats.maxRelError;
      var improvement = prevMaxRelErr - maxRelErr;
      var relImprovement = improvement / Math.max(1, prevMaxRelErr);
      errWindow.push(maxRelErr);
      if (errWindow.length > options.plateauWindow + 1) {
        errWindow.shift();
      }
      var plateauWindowImprovementAbs = null;
      var plateauWindowImprovementRel = null;
      if (errWindow.length >= options.plateauWindow + 1) {
        plateauWindowImprovementAbs = errWindow[0] - maxRelErr;
        plateauWindowImprovementRel = plateauWindowImprovementAbs / Math.max(1, errWindow[0]);
      }
      lastStats.maxMove = lastMoveStats.maxMove;
      lastStats.avgMove = lastMoveStats.avgMove;
      lastStats.acceptedCount = acceptedCount;
      lastStats.sweeps = sweep;
      lastStats.plateauSweepCount = plateauSweeps;
      lastStats.plateauWindowImprovementAbs = plateauWindowImprovementAbs;
      lastStats.plateauWindowImprovementRel = plateauWindowImprovementRel;
      if (options.onIteration) {
        await options.onIteration({
          iter: sweep,
          maxIters: options.maxSweeps,
          status: status,
          positions: posById,
          movedVertices: acceptedCount,
          maxMove: lastMoveStats.maxMove,
          avgMove: lastMoveStats.avgMove,
          maxRelError: maxRelErr,
          debug: {
            maxForce: lastStats.maxForce,
            balancedCount: lastStats.balancedCount,
            stableIterCount: stalledSweeps,
            stableIterLimit: options.patience,
            acceptedCount: acceptedCount,
            deadSweepCount: deadSweeps,
            plateauSweepCount: plateauSweeps,
            plateauPatience: options.plateauPatience,
            plateauWindow: options.plateauWindow,
            plateauWindowImprovementAbs: plateauWindowImprovementAbs,
            plateauWindowImprovementRel: plateauWindowImprovementRel,
            boundedFaceCount: lastStats.boundedFaceCount,
            edgeLengthRatio: lastStats.edgeLengthRatio,
            maxLogDeviation: lastStats.maxLogDeviation
          }
        });
      }

      if (maxRelErr <= options.tolAreaGlobal) {
        status = 'realized';
        break;
      }

      if (acceptedCount === 0) {
        deadSweeps += 1;
      } else {
        deadSweeps = 0;
      }
      if (deadSweeps >= options.deadlockPatience) {
        status = 'deadlock';
        break;
      }

      if (lastMoveStats.maxMove <= moveTol &&
          lastMoveStats.avgMove <= avgMoveTol &&
          relImprovement <= options.errTolRel) {
        stalledSweeps += 1;
      } else {
        stalledSweeps = 0;
      }
      if (stalledSweeps >= options.patience) {
        status = 'stalled';
        break;
      }

      if (plateauWindowImprovementAbs !== null &&
          maxRelErr <= plateauErrGuard &&
          plateauWindowImprovementAbs <= plateauErrTolAbs &&
          plateauWindowImprovementRel <= plateauErrTolRel) {
        plateauSweeps += 1;
      } else {
        plateauSweeps = 0;
      }
      if (plateauSweeps >= options.plateauPatience) {
        status = 'stalled';
        break;
      }

      prevMaxRelErr = maxRelErr;
    }

    return {
      ok: !hasPositionCrossings(posById, g.edgePairs),
      status: status,
      positions: posById,
      stats: lastStats,
      moveStats: lastMoveStats,
      boundedFaceCount: airData.triangles.length,
      dummyCount: prepared.augmented ? prepared.augmented.dummyCount : 0,
      hasCrossings: hasPositionCrossings(posById, g.edgePairs)
    };
  }

  async function computeAirPositions(graph, options) {
    var prepared = prepareAirState(graph, options);
    if (!prepared.ok) {
      return buildLayoutError(prepared);
    }

    if (prepared.airData.triangles.length === 0) {
      return buildLayoutResult({
        ok: true,
        status: 'realized',
        positions: prepared.posById,
        graph: prepared.graph,
        outerFace: prepared.outerFace,
        augmented: prepared.augmented,
        airData: prepared.airData,
        boundedFaceCount: 0,
        dummyCount: prepared.augmented.dummyCount,
        faceAreaScore: null,
        maxRelError: 0
      });
    }

    var solveResult = await runAirIterations(prepared, prepared.opts);
    var status = solveResult.status;
    var lastStats = solveResult.stats;

    if (solveResult.hasCrossings) {
      return buildLayoutError({
        status: status,
        message: 'AirPlus produced a non-plane drawing',
        graph: prepared.graph,
        outerFace: prepared.outerFace,
        augmented: prepared.augmented,
        maxRelError: lastStats ? lastStats.maxRelError : null,
        boundedFaceCount: prepared.airData.triangles.length,
        dummyCount: prepared.augmented.dummyCount
      });
    }

    var faceScore = Metrics.computeUniformFaceAreaScore(prepared.graph.nodeIds, prepared.graph.edgePairs, prepared.posById);

    var message = buildLayoutStatusMessage('AirPlus', {
      outerFaceVertexCount: Array.isArray(prepared.outerFace) ? prepared.outerFace.length : null,
      boundedFaceCount: prepared.airData.triangles.length,
      dummyCount: prepared.augmented.dummyCount,
      status: status,
      maxRelError: lastStats ? lastStats.maxRelError : null,
      faceAreaScore: faceScore && faceScore.ok ? faceScore.quality : null
    });

    return buildLayoutResult({
      ok: true,
      status: status,
      positions: prepared.posById,
      graph: prepared.graph,
      outerFace: prepared.outerFace,
      augmented: prepared.augmented,
      airData: prepared.airData,
      message: message,
      faceAreaScore: faceScore && faceScore.ok ? faceScore.quality : null,
      maxRelError: lastStats ? lastStats.maxRelError : null,
      edgeLengthRatio: lastStats ? lastStats.edgeLengthRatio : null,
      maxLogDeviation: lastStats ? lastStats.maxLogDeviation : null,
      boundedFaceCount: prepared.airData.triangles.length,
      dummyCount: prepared.augmented.dummyCount,
      iters: lastStats && Number.isFinite(lastStats.sweeps) ? lastStats.sweeps : null
    });
  }

  async function applyAirLayout(cy, options) {
    return CyRuntime.runLayout(cy, options, {
      useSharedPreparedSeed: true,
      sharedSeedFailureLabel: 'AirPlus layout',
      compute: computeAirPositions,
      buildResult: function (ctx) {
        var result = ctx.result;
        return {
          ok: true,
          status: result.status,
          message: result.message,
          faceAreaScore: result.faceAreaScore,
          maxRelError: result.maxRelError,
          edgeLengthRatio: result.edgeLengthRatio,
          maxLogDeviation: result.maxLogDeviation,
          boundedFaceCount: result.boundedFaceCount,
          dummyCount: result.dummyCount,
          iters: result.iters,
          debugState: typeof LayoutPreprocessing.createAugmentationDebugState === 'function'
            ? LayoutPreprocessing.createAugmentationDebugState(
              result.graph,
              result.augmented,
              result.positions
            )
            : null
        };
      },
      failureMessage: 'AirPlus failed'
    });
  }
  global.PlanarVibeAirPlus = {
    computeAirPlusPositions: computeAirPositions,
    applyAirPlusLayout: applyAirLayout
  };
})(window);
