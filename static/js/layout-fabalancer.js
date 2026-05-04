(function (global) {
  'use strict';

  var LayoutPreprocessing = global.LayoutPreprocessing;
  var CyRuntime = global.CyRuntime;
  var Metrics = global.PlanarVibeMetrics;
  var Alignment = global.PlanarVibeAlignment;
  var PlanarVibeTutte = global.PlanarVibeTutte;
  var GeometryUtils = global.GeometryUtils;
  var LinearAlgebraUtils = global.LinearAlgebraUtils;
  var edgeKey = global.GraphUtils.edgeKey;
  var faceKey = global.GraphUtils.faceKey;
  var buildLayoutError = global.GraphUtils.buildLayoutError;
  var buildLayoutResult = global.GraphUtils.buildLayoutResult;
  var buildLayoutStatusMessage = global.GraphUtils.buildLayoutStatusMessage;
  var computeMoveStats = global.GraphUtils.computeMoveStats;
  var hasPositionCrossings = GeometryUtils.hasPositionCrossings;
  var copyPositions = GeometryUtils.copyPositionMap;
  var luFactorize = LinearAlgebraUtils.luFactorize;
  var solveLUWithTwoRhs = LinearAlgebraUtils.solveLUWithTwoRhs;
  var solveTransposeLUWithTwoRhs = LinearAlgebraUtils.solveTransposeLUWithTwoRhs;
  var createZeroVector = GeometryUtils.createZeroVector;
  var vecAddScaled = GeometryUtils.vecAddScaled;
  var vecDot = GeometryUtils.vecDot;
  var vecNorm = GeometryUtils.vecNorm;
  var vecScale = GeometryUtils.vecScale;
  var vecSub = GeometryUtils.vecSub;

  var TWO_PI = 2 * Math.PI;
  var FABALANCER_CONFIG = {
    areaTol: 1e-15,
    angleTol: 1e-8,
    gradTol: 1e-5,
    stepTol: 1e-10,
    maxStepNorm: 2.0,
    lbfgsMemory: 10,
    lineSearchC1: 1e-4,
    lineSearchTau: 0.5,
    movementStopTol: 1e-6,
    avgMovementStopTol: 2e-7,
    alignMaxPasses: 3,
    faceWarmStage: {
      maxIters: 20,
      minItersBeforeStop: 20,
      stableIterLimit: 6,
      maxPositionStepRatio: 0.02,
      minFaceAreaFactor: 0.25,
      faceBarrierWeight: 0.2,
      edgeBarrierWeight: 0.05,
      edgeUniformWeight: 0.02,
      faceWeight: 1.0,
      angleWeight: 0,
      angleBarrierWeight: 0,
      horizontalityWeight: 0
    },
    angleStage: {
      maxIters: 180,
      minItersBeforeStop: 40,
      stableIterLimit: 8,
      maxPositionStepRatio: 0.01,
      minFaceAreaFactor: 0.2,
      angleBarrierWeight: 0.5,
      minRatioWeight: 0.25,
      minRatioBeta: 10,
      faceBarrierWeight: 0.02,
      faceWeight: 0,
      angleWeight: 1.0,
      horizontalityWeight: 0.5,
      edgeBarrierWeight: 0.005,
      edgeUniformWeight: 0.002
    }
  };

  function softmaxInto(q, start, length, out) {
    var m = -Infinity;
    var i;
    for (i = 0; i < length; i += 1) {
      var value = q[start + i];
      if (value > m) m = value;
    }
    var Z = 0;
    for (i = 0; i < length; i += 1) {
      var w = Math.exp(q[start + i] - m);
      out[start + i] = w;
      Z += w;
    }
    if (!(Z > 0)) {
      var uniform = 1 / Math.max(1, length);
      for (i = 0; i < length; i += 1) out[start + i] = uniform;
      return;
    }
    for (i = 0; i < length; i += 1) out[start + i] /= Z;
  }

  function computePositiveTurn(fromAngle, toAngle) {
    var delta = toAngle - fromAngle;
    while (delta <= 0) delta += TWO_PI;
    return delta;
  }

  function buildFABalancerData(input) {
    var augmentedEdgePairs = input.augmentedEdgePairs;
    var augmentedEmbedding = input.augmentedEmbedding;
    var outerFace = input.outerFace;
    var outerPos = input.outerPos || {};
    var objectiveGraph = input.objectiveGraph;
    var baseEmbedding = input.baseEmbedding;
    var angleBarrierWeight = input.angleBarrierWeight;
    var minRatioWeight = input.minRatioWeight;
    var minRatioBeta = input.minRatioBeta;
    var faceBarrierWeight = input.faceBarrierWeight;
    var faceWeight = input.faceWeight;
    var angleWeight = input.angleWeight;
    var horizontalityWeight = input.horizontalityWeight;
    var edgeBarrierWeight = input.edgeBarrierWeight;
    var edgeUniformWeight = input.edgeUniformWeight;
    var augIds = augmentedEmbedding.idByIndex.map(String);
    var augIndexById = {};
    var i;
    for (i = 0; i < augIds.length; i += 1) augIndexById[augIds[i]] = i;

    var x0 = new Array(augIds.length);
    var y0 = new Array(augIds.length);
    for (i = 0; i < augIds.length; i += 1) {
      var p = outerPos[augIds[i]];
      x0[i] = p ? p.x : 0;
      y0[i] = p ? p.y : 0;
    }

    var edges = [];
    var outerKey = faceKey(outerFace);
    var boundedFaces = [];
    for (i = 0; i < augmentedEdgePairs.length; i += 1) {
      var u = augIndexById[String(augmentedEdgePairs[i][0])];
      var v = augIndexById[String(augmentedEdgePairs[i][1])];
      if (u === undefined || v === undefined || u === v) continue;
      edges.push([u, v]);
    }
    for (i = 0; i < augmentedEmbedding.faces.length; i += 1) {
      var rawFace = Array.isArray(augmentedEmbedding.faces[i])
        ? augmentedEmbedding.faces[i].slice().map(String)
        : [];
      if (faceKey(rawFace) === outerKey) continue;
      if (!rawFace || rawFace.length < 3) {
        return buildLayoutError({ reason: 'FABalancer requires a valid triangulated augmentation' });
      }
      if (rawFace.length !== 3) {
        return buildLayoutError({ reason: 'FABalancer requires all non-outer augmented faces to be triangles' });
      }
      boundedFaces.push(rawFace.map(function (id) { return augIndexById[String(id)]; }));
    }

    var outerMask = new Array(augIds.length);
    for (i = 0; i < outerMask.length; i += 1) outerMask[i] = false;
    for (i = 0; i < outerFace.length; i += 1) {
      var outerIdx = augIndexById[String(outerFace[i])];
      if (outerIdx !== undefined) {
        outerMask[outerIdx] = true;
      }
    }

    var interiorAugIndices = [];
    var interiorIndexByAug = new Array(augIds.length);
    for (i = 0; i < augIds.length; i += 1) {
      interiorIndexByAug[i] = -1;
      if (!outerMask[i]) {
        interiorIndexByAug[i] = interiorAugIndices.length;
        interiorAugIndices.push(i);
      }
    }

    var rowStart = new Array(interiorAugIndices.length);
    var rowLength = new Array(interiorAugIndices.length);
    var neighborAugIndices = new Array(interiorAugIndices.length);
    var neighborInteriorIndices = new Array(interiorAugIndices.length);
    var qSize = 0;
    for (i = 0; i < interiorAugIndices.length; i += 1) {
      var augIdx = interiorAugIndices[i];
      var rotationRow = augmentedEmbedding.rotation[augIdx] || [];
      var neighbors = rotationRow.map(function (id) { return augIndexById[String(id)]; });
      rowStart[i] = qSize;
      rowLength[i] = neighbors.length;
      qSize += neighbors.length;
      neighborAugIndices[i] = neighbors;
      var mapped = new Array(neighbors.length);
      for (var k = 0; k < neighbors.length; k += 1) mapped[k] = interiorIndexByAug[neighbors[k]];
      neighborInteriorIndices[i] = mapped;
    }

    var baseIds = Array.isArray(baseEmbedding.idByIndex) ? baseEmbedding.idByIndex.map(String) : [];
    var baseIndexById = {};
    for (i = 0; i < baseIds.length; i += 1) baseIndexById[baseIds[i]] = i;

    var objectiveVertexIds = [];
    var wedgeStart = [];
    var wedgeCount = [];
    var wedges = [];
    var objectiveEdges = [];
    for (i = 0; i < objectiveGraph.nodeIds.length; i += 1) {
      var centerId = String(objectiveGraph.nodeIds[i]);
      var centerBaseIdx = baseIndexById[centerId];
      var centerAugIdx = augIndexById[centerId];
      if (centerBaseIdx === undefined || centerAugIdx === undefined) continue;
      var objectiveRotation = baseEmbedding.rotation[centerBaseIdx] || [];
      if (objectiveRotation.length < 2) continue;
      var objectiveNeighbors = [];
      for (var k = 0; k < objectiveRotation.length; k += 1) {
        var neighborAugIdx = augIndexById[String(objectiveRotation[k])];
        if (neighborAugIdx !== undefined) {
          objectiveNeighbors.push(neighborAugIdx);
        }
      }
      if (objectiveNeighbors.length < 2) continue;
      var targetAngle = TWO_PI / objectiveNeighbors.length;
      wedgeStart.push(wedges.length);
      wedgeCount.push(objectiveNeighbors.length);
      objectiveVertexIds.push(centerId);
      for (k = 0; k < objectiveNeighbors.length; k += 1) {
        var leftAugIdx = objectiveNeighbors[k];
        var rightAugIdx = objectiveNeighbors[(k + 1) % objectiveNeighbors.length];
        wedges.push([centerAugIdx, leftAugIdx, rightAugIdx, targetAngle, objectiveVertexIds.length - 1]);
      }
    }

    for (i = 0; i < objectiveGraph.edgePairs.length; i += 1) {
      var edgePair = objectiveGraph.edgePairs[i];
      var edgeU = augIndexById[String(edgePair[0])];
      var edgeV = augIndexById[String(edgePair[1])];
      if (edgeU === undefined || edgeV === undefined || edgeU === edgeV) continue;
      objectiveEdges.push([edgeU, edgeV]);
    }

    return buildLayoutResult({
      augIds: augIds,
      x0: x0,
      y0: y0,
      interiorAugIndices: interiorAugIndices,
      interiorIndexByAug: interiorIndexByAug,
      rowStart: rowStart,
      rowLength: rowLength,
      neighborAugIndices: neighborAugIndices,
      neighborInteriorIndices: neighborInteriorIndices,
      qSize: qSize,
      boundedFaces: boundedFaces,
      edges: edges,
      objectiveVertexIds: objectiveVertexIds,
      wedgeStart: wedgeStart,
      wedgeCount: wedgeCount,
      wedges: wedges,
      objectiveEdges: objectiveEdges,
      areaTol: input.areaTol,
      angleTol: input.angleTol,
      angleBarrierWeight: angleBarrierWeight,
      minRatioWeight: Math.max(0, minRatioWeight || 0),
      minRatioBeta: minRatioBeta,
      faceBarrierWeight: faceBarrierWeight,
      horizontalityWeight: horizontalityWeight,
      edgeBarrierWeight: edgeBarrierWeight,
      edgeUniformWeight: edgeUniformWeight,
      minFaceArea: 0,
      faceWeight: faceWeight,
      angleWeight: angleWeight
    });
  }

  function buildInitialLogitSeed(data, weights) {
    var q0 = createZeroVector(data.qSize);
    for (var i = 0; i < data.interiorAugIndices.length; i += 1) {
      var augIdx = data.interiorAugIndices[i];
      var vertexId = data.augIds[augIdx];
      var rowOffset = data.rowStart[i];
      var neighbors = data.neighborAugIndices[i];
      if (!(neighbors && neighbors.length > 0)) {
        continue;
      }
      var rowWeightSum = 0;
      var rowWeights = new Array(neighbors.length);
      for (var k = 0; k < neighbors.length; k += 1) {
        var neighborId = data.augIds[neighbors[k]];
        var rowWeight = weights[edgeKey(vertexId, neighborId)];
        if (!Number.isFinite(rowWeight) || !(rowWeight > 0)) {
          return buildLayoutError({
            reason: 'FABalancer initialization requires positive Tutte weights',
            vertexId: vertexId,
            neighborId: neighborId
          });
        }
        rowWeights[k] = rowWeight;
        rowWeightSum += rowWeight;
      }
      if (!(rowWeightSum > 0)) {
        return buildLayoutError({
          reason: 'FABalancer initialization requires positive Tutte row weight sum',
          vertexId: vertexId
        });
      }
      for (k = 0; k < neighbors.length; k += 1) {
        q0[rowOffset + k] = Math.log(rowWeights[k] / rowWeightSum);
      }
    }
    return buildLayoutResult({ q0: q0 });
  }

  function buildInitialLogitSeedFromPositions(data, posById) {
    var q0 = createZeroVector(data.qSize);
    var x = new Array(data.augIds.length);
    var y = new Array(data.augIds.length);
    for (var i = 0; i < data.augIds.length; i += 1) {
      var p = posById && posById[data.augIds[i]];
      x[i] = p ? p.x : data.x0[i];
      y[i] = p ? p.y : data.y0[i];
    }

    for (i = 0; i < data.interiorAugIndices.length; i += 1) {
      var augIdx = data.interiorAugIndices[i];
      var rowOffset = data.rowStart[i];
      var neighbors = data.neighborAugIndices[i];
      if (!(neighbors && neighbors.length > 0)) continue;
      var ordered = neighbors.slice();
      var vectors = new Array(ordered.length);
      var angles = new Array(ordered.length);
      for (var k = 0; k < ordered.length; k += 1) {
        var neighborAugIdx = ordered[k];
        var vx = x[neighborAugIdx] - x[augIdx];
        var vy = y[neighborAugIdx] - y[augIdx];
        var len = Math.hypot(vx, vy);
        if (!(len > 1e-12)) {
          return buildLayoutError({ reason: 'FABalancer warm start requires positive edge lengths' });
        }
        vectors[k] = { vx: vx, vy: vy, len: len };
      }
      for (k = 0; k < ordered.length; k += 1) {
        var next = (k + 1) % ordered.length;
        var cross = vectors[k].vx * vectors[next].vy - vectors[k].vy * vectors[next].vx;
        var dot = vectors[k].vx * vectors[next].vx + vectors[k].vy * vectors[next].vy;
        var theta = Math.atan2(cross, dot);
        if (!(theta > 0)) theta += TWO_PI;
        if (!(theta > 1e-8)) {
          return buildLayoutError({ reason: 'FABalancer warm start requires strictly positive neighbor wedges' });
        }
        angles[k] = theta;
      }

      var weightByNeighbor = {};
      var rowWeightSum = 0;
      for (k = 0; k < ordered.length; k += 1) {
        var prev = (k + ordered.length - 1) % ordered.length;
        var weight = (Math.tan(angles[prev] / 2) + Math.tan(angles[k] / 2)) / vectors[k].len;
        if (!(weight > 0) || !Number.isFinite(weight)) {
          return buildLayoutError({ reason: 'FABalancer warm start requires positive mean-value weights' });
        }
        weightByNeighbor[ordered[k]] = weight;
        rowWeightSum += weight;
      }
      if (!(rowWeightSum > 0)) {
        return buildLayoutError({ reason: 'FABalancer warm start requires positive row weight sum' });
      }
      for (k = 0; k < neighbors.length; k += 1) {
        var neighborWeight = weightByNeighbor[neighbors[k]];
        if (!(neighborWeight > 0)) {
          return buildLayoutError({ reason: 'FABalancer warm start could not map neighbor weights' });
        }
        q0[rowOffset + k] = Math.log(neighborWeight / rowWeightSum);
      }
    }

    return buildLayoutResult({ q0: q0 });
  }

  function buildPositionMap(data, x, y) {
    var pos = {};
    for (var i = 0; i < data.augIds.length; i += 1) {
      pos[data.augIds[i]] = { x: x[i], y: y[i] };
    }
    return pos;
  }

  function computeAngleStats(graph, posById) {
    var angle = Metrics.computeAngularResolutionScore(graph, posById);
    return {
      angleResolutionScore: angle && angle.ok ? angle.score : null,
      angleCount: angle && angle.ok ? angle.usedNodeCount : null
    };
  }

  function computeFaceStats(graph, embedding, posById) {
    var face = Metrics.computeUniformFaceAreaScore(graph.nodeIds, graph.edgePairs, posById, embedding);
    return {
      faceAreaScore: face && face.ok ? face.quality : null
    };
  }

  function computeFABalancerTradeoffScore(faceAreaScore, angleResolutionScore) {
    if (!(Number.isFinite(faceAreaScore) && faceAreaScore >= 0 &&
          Number.isFinite(angleResolutionScore) && angleResolutionScore >= 0)) {
      return -Infinity;
    }
    return Math.sqrt(faceAreaScore * angleResolutionScore);
  }

  function computeFABalancerStageMetrics(graph, embedding, posById) {
    var positions = GeometryUtils.filterPositionMap(posById || {}, graph.nodeIds);
    var angleStats = computeAngleStats(graph, positions);
    var faceStats = computeFaceStats(graph, embedding, positions);
    return {
      positions: positions,
      angleResolutionScore: angleStats.angleResolutionScore,
      angleCount: angleStats.angleCount,
      faceAreaScore: faceStats.faceAreaScore,
      tradeoffScore: computeFABalancerTradeoffScore(faceStats.faceAreaScore, angleStats.angleResolutionScore)
    };
  }

  function applyFABalancerAxisAlignment(graph, posById, maxPasses) {
    if (!Alignment || typeof Alignment.alignToAxisGreedy !== 'function') {
      return buildLayoutResult({
        changed: false,
        passes: 0,
        positions: copyPositions(posById),
        results: []
      });
    }
    var limit = Number.isFinite(maxPasses) ? Math.max(1, Math.floor(maxPasses)) : 1;
    var working = copyPositions(posById);
    var results = [];
    var changedAny = false;
    for (var pass = 0; pass < limit; pass += 1) {
      var result = Alignment.alignToAxisGreedy(graph.nodeIds, graph.edgePairs, working);
      if (!result || !result.ok) {
        return buildLayoutError({
          reason: result && result.reason ? result.reason : 'FABalancer axis-align failed'
        });
      }
      results.push(result);
      if (!result.changed || !result.positions) {
        break;
      }
      working = result.positions;
      changedAny = true;
    }
    return buildLayoutResult({
      changed: changedAny,
      passes: results.length,
      positions: working,
      results: results
    });
  }

  function polygonArea2FromArrays(faceIndices, x, y) {
    if (!faceIndices || faceIndices.length < 3) return 0;
    var sum = 0;
    for (var i = 0; i < faceIndices.length; i += 1) {
      var a = faceIndices[i];
      var b = faceIndices[(i + 1) % faceIndices.length];
      sum += x[a] * y[b] - x[b] * y[a];
    }
    return sum;
  }

  function realizeFABalancerState(q, data, failureReason) {
    var nI = data.interiorAugIndices.length;
    var lambda = createZeroVector(data.qSize);
    var L = new Array(nI);
    var bx = createZeroVector(nI);
    var by = createZeroVector(nI);
    var i;
    for (i = 0; i < nI; i += 1) {
      L[i] = createZeroVector(nI);
      L[i][i] = 1;
      softmaxInto(q, data.rowStart[i], data.rowLength[i], lambda);
      var neighbors = data.neighborAugIndices[i];
      var interiorNeighbors = data.neighborInteriorIndices[i];
      for (var k = 0; k < neighbors.length; k += 1) {
        var w = lambda[data.rowStart[i] + k];
        var augIdx = neighbors[k];
        var interiorIdx = interiorNeighbors[k];
        if (interiorIdx >= 0) {
          L[i][interiorIdx] -= w;
        } else {
          bx[i] += w * data.x0[augIdx];
          by[i] += w * data.y0[augIdx];
        }
      }
    }

    var factor = luFactorize(L);
    if (!factor) return buildLayoutError({ reason: failureReason || 'FABalancer linear solve failed' });
    var primal = solveLUWithTwoRhs(factor, bx, by);
    if (!primal) return buildLayoutError({ reason: failureReason || 'FABalancer linear solve failed' });

    var x = data.x0.slice();
    var y = data.y0.slice();
    for (i = 0; i < nI; i += 1) {
      var aug = data.interiorAugIndices[i];
      x[aug] = primal.x1[i];
      y[aug] = primal.x2[i];
    }
    return buildLayoutResult({
      lambda: lambda,
      factor: factor,
      x: x,
      y: y
    });
  }

  function initializeFABalancerBaseline(data, q0) {
    var realized = realizeFABalancerState(q0, data, 'FABalancer initialization failed');
    if (!realized || !realized.ok) {
      return realized || buildLayoutError({ reason: 'FABalancer initialization failed' });
    }

    var x = realized.x;
    var y = realized.y;
    var i;
    var edgeScaleSum = 0;
    var edgeScaleCount = 0;
    for (i = 0; i < data.edges.length; i += 1) {
      var edge = data.edges[i];
      var dx = x[edge[0]] - x[edge[1]];
      var dy = y[edge[0]] - y[edge[1]];
        var len2 = dx * dx + dy * dy;
      if (len2 > 1e-12) {
        edgeScaleSum += len2;
        edgeScaleCount += 1;
      }
    }
    data.edgeBarrierScale2 = edgeScaleCount > 0 ? (edgeScaleSum / edgeScaleCount) : 1;

    var initialFaceMinArea = Infinity;
    var initialFaceAreaSum = 0;
    var initialFaceCount = 0;
    for (i = 0; i < data.boundedFaces.length; i += 1) {
      var face = data.boundedFaces[i];
      if (polygonArea2FromArrays(face, x, y) < 0) {
        face.reverse();
      }
      var area = Math.abs(polygonArea2FromArrays(face, x, y)) / 2;
      if (area > 1e-12) {
        initialFaceAreaSum += area;
        initialFaceCount += 1;
        if (area < initialFaceMinArea) initialFaceMinArea = area;
      }
    }
    data.initialAvgFaceArea = initialFaceCount > 0 ? (initialFaceAreaSum / initialFaceCount) : 1;
    data.initialMinFaceArea = Number.isFinite(initialFaceMinArea) ? initialFaceMinArea : 0;

    return buildLayoutResult({
      positions: buildPositionMap(data, x, y)
    });
  }

  function addPointGradient(data, augIdx, gx, gy, zX, zY) {
    var interiorIdx = data.interiorIndexByAug[augIdx];
    if (interiorIdx >= 0) {
      zX[interiorIdx] += gx;
      zY[interiorIdx] += gy;
    }
  }

  function projectAdjointToWeightGradient(data, lambda, x, y, adjoint) {
    var gradVec = createZeroVector(data.qSize);
    for (var i = 0; i < data.interiorAugIndices.length; i += 1) {
      var rowOffset = data.rowStart[i];
      var meanx = 0;
      var meany = 0;
      var neighbors = data.neighborAugIndices[i];
      var k;
      for (k = 0; k < neighbors.length; k += 1) {
        var w = lambda[rowOffset + k];
        var augIdx = neighbors[k];
        meanx += w * x[augIdx];
        meany += w * y[augIdx];
      }
      for (k = 0; k < neighbors.length; k += 1) {
        augIdx = neighbors[k];
        w = lambda[rowOffset + k];
        gradVec[rowOffset + k] = w * (
          adjoint.x1[i] * (x[augIdx] - meanx) +
          adjoint.x2[i] * (y[augIdx] - meany)
        );
      }
    }
    return gradVec;
  }

  function computeWedgeAngleAndGradient(center, left, right, x, y, angleTol) {
    var ux = x[left] - x[center];
    var uy = y[left] - y[center];
    var vx = x[right] - x[center];
    var vy = y[right] - y[center];
    var lenU2 = ux * ux + uy * uy;
    var lenV2 = vx * vx + vy * vy;
    var lenTol2 = Math.max(1e-24, angleTol * angleTol);
    if (!(lenU2 > lenTol2) || !(lenV2 > lenTol2)) {
      return buildLayoutError({ reason: 'invalid-angle-step' });
    }
    var cross = ux * vy - uy * vx;
    var dot = ux * vx + uy * vy;
    var angle = Math.atan2(cross, dot);
    if (!(angle > 0)) angle += TWO_PI;
    if (!(angle > angleTol)) {
      return buildLayoutError({ reason: 'invalid-angle-step' });
    }
    var denom = lenU2 * lenV2;
    if (!(denom > 1e-24) || !Number.isFinite(denom)) {
      return buildLayoutError({ reason: 'invalid-angle-step' });
    }
    var gradUx = (dot * vy - cross * vx) / denom;
    var gradUy = (-dot * vx - cross * vy) / denom;
    var gradVx = (-dot * uy - cross * ux) / denom;
    var gradVy = (dot * ux - cross * uy) / denom;
    return buildLayoutResult({
      angle: angle,
      gradCenterX: -gradUx - gradVx,
      gradCenterY: -gradUy - gradVy,
      gradLeftX: gradUx,
      gradLeftY: gradUy,
      gradRightX: gradVx,
      gradRightY: gradVy
    });
  }

  function evaluateAngleObjectiveTerms(data, x, y, zX, zY) {
    var wedgeCount = data.wedges.length;
    if (!(wedgeCount > 0)) {
      return buildLayoutError({ reason: 'FABalancer requires at least one valid objective angle' });
    }

    var angleObjectiveTerm = 0;
    var maxAngleResidual = 0;
    var minAngleRatio = Infinity;
    var worstWedge = null;
    var vertexWeightScale = data.objectiveVertexIds.length > 0
      ? (1 / data.objectiveVertexIds.length)
      : (1 / wedgeCount);
    var minRatioWeight = data.minRatioWeight > 0 ? data.minRatioWeight : 0;
    var minRatioBeta = data.minRatioBeta > 0 ? data.minRatioBeta : 10;
    var minRatioVertexMax = minRatioWeight > 0 ? createZeroVector(data.objectiveVertexIds.length) : null;
    var minRatioVertexSum = minRatioWeight > 0 ? createZeroVector(data.objectiveVertexIds.length) : null;
    var wedgeEvals = new Array(wedgeCount);
    var wedgeRatios = new Array(wedgeCount);
    var wedgeResiduals = new Array(wedgeCount);
    if (minRatioVertexMax) {
      for (var vi = 0; vi < minRatioVertexMax.length; vi += 1) minRatioVertexMax[vi] = -Infinity;
    }
    for (var i = 0; i < wedgeCount; i += 1) {
      var wedge = data.wedges[i];
      var center = wedge[0];
      var left = wedge[1];
      var right = wedge[2];
      var targetAngle = wedge[3];
      var vertexIdx = wedge[4];
      var wedgeEval = computeWedgeAngleAndGradient(center, left, right, x, y, data.angleTol);
      if (!wedgeEval.ok) {
        return wedgeEval;
      }
      var ratio = wedgeEval.angle / targetAngle;
      if (!(ratio > 0) || !Number.isFinite(ratio)) {
        return buildLayoutError({ reason: 'invalid-angle-step' });
      }
      var residual = ratio - 1;
      wedgeEvals[i] = wedgeEval;
      wedgeRatios[i] = ratio;
      wedgeResiduals[i] = residual;
      var absResidual = Math.abs(residual);
      if (absResidual > maxAngleResidual) {
        maxAngleResidual = absResidual;
        worstWedge = {
          vertexId: data.objectiveVertexIds[vertexIdx],
          angle: wedgeEval.angle,
          targetAngle: targetAngle,
          ratio: ratio,
          residual: residual
        };
      }
      if (ratio < minAngleRatio) minAngleRatio = ratio;
      if (minRatioVertexMax) {
        var scaledDeficit = minRatioBeta * (1 - ratio);
        if (scaledDeficit > minRatioVertexMax[vertexIdx]) minRatioVertexMax[vertexIdx] = scaledDeficit;
      }
    }

    if (minRatioVertexMax) {
      for (i = 0; i < wedgeCount; i += 1) {
        wedge = data.wedges[i];
        vertexIdx = wedge[4];
        minRatioVertexSum[vertexIdx] += Math.exp(minRatioBeta * (1 - wedgeRatios[i]) - minRatioVertexMax[vertexIdx]);
      }
    }

    for (i = 0; i < wedgeCount; i += 1) {
      wedge = data.wedges[i];
      center = wedge[0];
      left = wedge[1];
      right = wedge[2];
      targetAngle = wedge[3];
      vertexIdx = wedge[4];
      wedgeEval = wedgeEvals[i];
      ratio = wedgeRatios[i];
      residual = wedgeResiduals[i];

      var weightScale = vertexWeightScale / Math.max(1, data.wedgeCount[vertexIdx]);
      angleObjectiveTerm += weightScale * residual * residual;
      var coeff = weightScale * (2 * residual / targetAngle);
      if (data.angleBarrierWeight > 0) {
        angleObjectiveTerm -= weightScale * data.angleBarrierWeight * Math.log(ratio);
        coeff -= weightScale * data.angleBarrierWeight / wedgeEval.angle;
      }
      if (minRatioVertexMax) {
        var vertexSoftMinWeight = vertexWeightScale * minRatioWeight;
        var minRatioSum = minRatioVertexSum[vertexIdx];
        if (minRatioSum > 0) {
          if (i === data.wedgeStart[vertexIdx]) {
            angleObjectiveTerm += vertexSoftMinWeight *
              ((Math.log(minRatioSum) + minRatioVertexMax[vertexIdx]) / minRatioBeta);
          }
          var softMinShare = Math.exp(minRatioBeta * (1 - ratio) - minRatioVertexMax[vertexIdx]) / minRatioSum;
          coeff -= vertexSoftMinWeight * softMinShare / targetAngle;
        }
      }
      addPointGradient(data, center, coeff * wedgeEval.gradCenterX, coeff * wedgeEval.gradCenterY, zX, zY);
      addPointGradient(data, left, coeff * wedgeEval.gradLeftX, coeff * wedgeEval.gradLeftY, zX, zY);
      addPointGradient(data, right, coeff * wedgeEval.gradRightX, coeff * wedgeEval.gradRightY, zX, zY);
    }

    return buildLayoutResult({
      angleObjectiveTerm: angleObjectiveTerm,
      maxAngleResidual: maxAngleResidual,
      minAngleRatio: Number.isFinite(minAngleRatio) ? minAngleRatio : null,
      worstWedge: worstWedge
    });
  }

  function evaluateHorizontalityObjectiveTerms(data, x, y, zX, zY) {
    if (!(data.objectiveEdges && data.objectiveEdges.length > 0)) {
      return buildLayoutResult({
        horizontalityObjectiveTerm: 0
      });
    }

    var eps2 = Math.max(1e-24, data.areaTol);
    var horizontalityObjectiveTerm = 0;
    var weight = 1 / data.objectiveEdges.length;
    for (var i = 0; i < data.objectiveEdges.length; i += 1) {
      var edge = data.objectiveEdges[i];
      var u = edge[0];
      var v = edge[1];
      var dx = x[v] - x[u];
      var dy = y[v] - y[u];
      var absDy = Math.sqrt(dy * dy + eps2);
      var len2 = dx * dx + dy * dy + eps2;
      var len = Math.sqrt(len2);
      var penalty = absDy / len;
      var gradDx = -absDy * dx / (len2 * len);
      var gradDy = (dy / (absDy * len)) - (absDy * dy / (len2 * len));
      horizontalityObjectiveTerm += weight * penalty;
      addPointGradient(data, u, -weight * gradDx, -weight * gradDy, zX, zY);
      addPointGradient(data, v, weight * gradDx, weight * gradDy, zX, zY);
    }

    return buildLayoutResult({
      horizontalityObjectiveTerm: horizontalityObjectiveTerm
    });
  }

  function evaluateFABalancerAngleStageObjectiveAndGradient(q, data) {
    var triangleSlack = Math.max(data.areaTol, 1e-12);
    var nI = data.interiorAugIndices.length;
    var realized = realizeFABalancerState(q, data, 'FABalancer angle stage linear solve failed');
    if (!realized || !realized.ok) return realized || buildLayoutError({ reason: 'FABalancer angle stage linear solve failed' });
    var lambda = realized.lambda;
    var factor = realized.factor;
    var x = realized.x;
    var y = realized.y;
    var i;
    var faceAreas = createZeroVector(data.boundedFaces.length);
    for (i = 0; i < data.boundedFaces.length; i += 1) {
      var tri = data.boundedFaces[i];
      var a = tri[0];
      var b = tri[1];
      var c = tri[2];
      var area = 0.5 * ((x[b] - x[a]) * (y[c] - y[a]) - (x[c] - x[a]) * (y[b] - y[a]));
      if (!(area > -triangleSlack)) {
        return buildLayoutError({ reason: 'invalid-triangulation-step' });
      }
      faceAreas[i] += area > triangleSlack ? area : triangleSlack;
    }
    for (i = 0; i < faceAreas.length; i += 1) {
      if (!(faceAreas[i] > data.minFaceArea)) {
        return buildLayoutError({ reason: 'invalid-face-step' });
      }
    }
    for (i = 0; i < data.boundedFaces.length; i += 1) {
      var boundary = data.boundedFaces[i];
      if (!(polygonArea2FromArrays(boundary, x, y) > 2 * data.areaTol)) {
        return buildLayoutError({ reason: 'invalid-face-step' });
      }
    }

    var zX = createZeroVector(nI);
    var zY = createZeroVector(nI);
    var E = 0;
    var angleEval = evaluateAngleObjectiveTerms(data, x, y, zX, zY);
    if (!angleEval.ok) {
      return angleEval;
    }
    E += angleEval.angleObjectiveTerm;

    if (data.horizontalityWeight > 0) {
      var horizontalZX = createZeroVector(nI);
      var horizontalZY = createZeroVector(nI);
      var horizontalityEval = evaluateHorizontalityObjectiveTerms(data, x, y, horizontalZX, horizontalZY);
      if (!horizontalityEval.ok) {
        return horizontalityEval;
      }
      E += data.horizontalityWeight * horizontalityEval.horizontalityObjectiveTerm;
      for (i = 0; i < nI; i += 1) {
        zX[i] += data.horizontalityWeight * horizontalZX[i];
        zY[i] += data.horizontalityWeight * horizontalZY[i];
      }
    }

    if (data.faceBarrierWeight > 0) {
      for (i = 0; i < faceAreas.length; i += 1) {
        E -= data.faceBarrierWeight * Math.log(faceAreas[i] / data.initialAvgFaceArea);
      }
      for (i = 0; i < data.boundedFaces.length; i += 1) {
        tri = data.boundedFaces[i];
        a = tri[0];
        b = tri[1];
        c = tri[2];
        var coeff = -data.faceBarrierWeight / faceAreas[i];
        var dAxA = 0.5 * (y[b] - y[c]);
        var dAxB = 0.5 * (y[c] - y[a]);
        var dAxC = 0.5 * (y[a] - y[b]);
        var dAyA = 0.5 * (x[c] - x[b]);
        var dAyB = 0.5 * (x[a] - x[c]);
        var dAyC = 0.5 * (x[b] - x[a]);
        addPointGradient(data, a, coeff * dAxA, coeff * dAyA, zX, zY);
        addPointGradient(data, b, coeff * dAxB, coeff * dAyB, zX, zY);
        addPointGradient(data, c, coeff * dAxC, coeff * dAyC, zX, zY);
      }
    }

    var adjoint = solveTransposeLUWithTwoRhs(factor, zX, zY);
    if (!adjoint) return buildLayoutError({ reason: 'FABalancer angle stage adjoint solve failed' });

    var gradVec = projectAdjointToWeightGradient(data, lambda, x, y, adjoint);

    return buildLayoutResult({
      E: E,
      gradVec: gradVec,
      gradNorm: vecNorm(gradVec),
      x: x,
      y: y,
      maxAngleResidual: angleEval.maxAngleResidual,
      minAngleRatio: angleEval.minAngleRatio,
      worstWedge: angleEval.worstWedge
    });
  }

  function evaluateFABalancerObjectiveAndGradient(q, data) {
    var triangleSlack = Math.max(data.areaTol, 1e-12);
    var nI = data.interiorAugIndices.length;
    var realized = realizeFABalancerState(q, data, 'FABalancer linear solve failed');
    if (!realized || !realized.ok) return realized || buildLayoutError({ reason: 'FABalancer linear solve failed' });
    var lambda = realized.lambda;
    var factor = realized.factor;
    var x = realized.x;
    var y = realized.y;
    var i;
    var faceAreas = createZeroVector(data.boundedFaces.length);
    var totalArea = 0;
    for (i = 0; i < data.boundedFaces.length; i += 1) {
      var tri = data.boundedFaces[i];
      var a = tri[0];
      var b = tri[1];
      var c = tri[2];
      var area = 0.5 * ((x[b] - x[a]) * (y[c] - y[a]) - (x[c] - x[a]) * (y[b] - y[a]));
      if (!(area > -triangleSlack)) {
        return buildLayoutError({ reason: 'invalid-triangulation-step' });
      }
      faceAreas[i] += area > triangleSlack ? area : triangleSlack;
    }
    for (i = 0; i < faceAreas.length; i += 1) {
      if (!(faceAreas[i] > data.minFaceArea)) {
        return buildLayoutError({ reason: 'invalid-face-step' });
      }
      totalArea += faceAreas[i];
    }
    for (i = 0; i < data.boundedFaces.length; i += 1) {
      var boundary = data.boundedFaces[i];
      if (!(polygonArea2FromArrays(boundary, x, y) > 2 * data.areaTol)) {
        return buildLayoutError({ reason: 'invalid-face-step' });
      }
    }
    if (faceAreas.length === 0 || !(totalArea > 1e-12)) {
      return buildLayoutError({ reason: 'FABalancer total bounded area is not positive' });
    }

    var zX = createZeroVector(nI);
    var zY = createZeroVector(nI);
    var E = 0;
    var edge;
    var u;
    var v;
    var dx;
    var dy;
    var len2;
    var safeLen2;
    var iu;
    var iv;

    var angleEval;
    if (data.angleWeight > 0) {
      var angleZX = createZeroVector(nI);
      var angleZY = createZeroVector(nI);
      angleEval = evaluateAngleObjectiveTerms(data, x, y, angleZX, angleZY);
      if (!angleEval.ok) {
        return angleEval;
      }
      E += data.angleWeight * angleEval.angleObjectiveTerm;
      for (i = 0; i < nI; i += 1) {
        zX[i] += data.angleWeight * angleZX[i];
        zY[i] += data.angleWeight * angleZY[i];
      }
    } else {
      angleEval = {
        maxAngleResidual: null,
        minAngleRatio: null,
        worstWedge: null,
        angleObjectiveTerm: 0
      };
    }

    if (data.horizontalityWeight > 0) {
      var horizontalZX = createZeroVector(nI);
      var horizontalZY = createZeroVector(nI);
      var horizontalityEval = evaluateHorizontalityObjectiveTerms(data, x, y, horizontalZX, horizontalZY);
      if (!horizontalityEval.ok) {
        return horizontalityEval;
      }
      E += data.horizontalityWeight * horizontalityEval.horizontalityObjectiveTerm;
      for (i = 0; i < nI; i += 1) {
        zX[i] += data.horizontalityWeight * horizontalZX[i];
        zY[i] += data.horizontalityWeight * horizontalZY[i];
      }
    }

    var targetArea = totalArea / faceAreas.length;
    var residual = createZeroVector(faceAreas.length);
    var maxRelError = 0;
    var faceScale = 1 / faceAreas.length;
    var faceWeight = data.faceWeight;
    if (faceWeight > 0 || data.faceBarrierWeight > 0) {
      for (i = 0; i < faceAreas.length; i += 1) {
        residual[i] = faceAreas[i] / targetArea - 1;
        var rel = Math.abs(residual[i]);
        if (rel > maxRelError) maxRelError = rel;
        if (faceWeight > 0) {
          E += faceWeight * faceScale * residual[i] * residual[i];
        }
        if (data.faceBarrierWeight > 0) {
          E -= faceWeight * faceScale * data.faceBarrierWeight * Math.log(faceAreas[i] / targetArea);
        }
      }
      for (i = 0; i < data.boundedFaces.length; i += 1) {
        tri = data.boundedFaces[i];
        a = tri[0];
        b = tri[1];
        c = tri[2];
        var coeff = 0;
        if (faceWeight > 0) {
          coeff += faceWeight * faceScale * (2 * residual[i] / targetArea);
        }
        if (data.faceBarrierWeight > 0) {
          coeff -= faceWeight * faceScale * data.faceBarrierWeight / faceAreas[i];
        }
        var dAxA = 0.5 * (y[b] - y[c]);
        var dAxB = 0.5 * (y[c] - y[a]);
        var dAxC = 0.5 * (y[a] - y[b]);
        var dAyA = 0.5 * (x[c] - x[b]);
        var dAyB = 0.5 * (x[a] - x[c]);
        var dAyC = 0.5 * (x[b] - x[a]);
        addPointGradient(data, a, coeff * dAxA, coeff * dAyA, zX, zY);
        addPointGradient(data, b, coeff * dAxB, coeff * dAyB, zX, zY);
        addPointGradient(data, c, coeff * dAxC, coeff * dAyC, zX, zY);
      }
    }

    if (data.edgeBarrierWeight > 0) {
      var edgeScale2 = data.edgeBarrierScale2 > 1e-12 ? data.edgeBarrierScale2 : 1;
      var edgeTol2 = Math.max(1e-24, data.areaTol);
      var edgeBarrierScale = 1 / Math.max(1, data.edges.length);
      for (i = 0; i < data.edges.length; i += 1) {
        edge = data.edges[i];
        u = edge[0];
        v = edge[1];
        dx = x[u] - x[v];
        dy = y[u] - y[v];
        len2 = dx * dx + dy * dy;
        safeLen2 = len2 > edgeTol2 ? len2 : edgeTol2;
        if (!(safeLen2 < edgeScale2)) {
          continue;
        }
        E -= data.edgeBarrierWeight * edgeBarrierScale * Math.log(safeLen2 / edgeScale2);
        var edgeCoeff = -2 * data.edgeBarrierWeight * edgeBarrierScale / safeLen2;
        iu = data.interiorIndexByAug[u];
        iv = data.interiorIndexByAug[v];
        if (iu >= 0) {
          zX[iu] += edgeCoeff * dx;
          zY[iu] += edgeCoeff * dy;
        }
        if (iv >= 0) {
          zX[iv] -= edgeCoeff * dx;
          zY[iv] -= edgeCoeff * dy;
        }
      }
    }

    if (data.edgeUniformWeight > 0 && data.edges.length > 1) {
      var uniformTol2 = Math.max(1e-24, data.areaTol);
      var logLen2 = new Array(data.edges.length);
      var logMean = 0;
      for (i = 0; i < data.edges.length; i += 1) {
        edge = data.edges[i];
        u = edge[0];
        v = edge[1];
        dx = x[u] - x[v];
        dy = y[u] - y[v];
        len2 = dx * dx + dy * dy;
        safeLen2 = len2 > uniformTol2 ? len2 : uniformTol2;
        var logValue = Math.log(safeLen2);
        logLen2[i] = logValue;
        logMean += logValue;
      }
      logMean /= data.edges.length;
      var uniformScale = 2 * data.edgeUniformWeight / data.edges.length;
      for (i = 0; i < data.edges.length; i += 1) {
        edge = data.edges[i];
        u = edge[0];
        v = edge[1];
        dx = x[u] - x[v];
        dy = y[u] - y[v];
        len2 = dx * dx + dy * dy;
        safeLen2 = len2 > uniformTol2 ? len2 : uniformTol2;
        var centeredLogLen2 = logLen2[i] - logMean;
        E += data.edgeUniformWeight * centeredLogLen2 * centeredLogLen2 / data.edges.length;
        var uniformCoeff = uniformScale * centeredLogLen2 / safeLen2;
        iu = data.interiorIndexByAug[u];
        iv = data.interiorIndexByAug[v];
        if (iu >= 0) {
          zX[iu] += uniformCoeff * dx;
          zY[iu] += uniformCoeff * dy;
        }
        if (iv >= 0) {
          zX[iv] -= uniformCoeff * dx;
          zY[iv] -= uniformCoeff * dy;
        }
      }
    }

    var adjoint = solveTransposeLUWithTwoRhs(factor, zX, zY);
    if (!adjoint) return buildLayoutError({ reason: 'FABalancer adjoint solve failed' });

    var gradVec = projectAdjointToWeightGradient(data, lambda, x, y, adjoint);

    return buildLayoutResult({
      E: E,
      gradVec: gradVec,
      gradNorm: vecNorm(gradVec),
      x: x,
      y: y,
      maxRelError: maxRelError,
      maxAngleResidual: angleEval.maxAngleResidual,
      minAngleRatio: angleEval.minAngleRatio,
      worstWedge: angleEval.worstWedge
    });
  }

  function lbfgsDirection(g, S, Y, Rho) {
    var m = S.length;
    var alpha = new Array(m);
    var q = g.slice();
    for (var i = m - 1; i >= 0; i -= 1) {
      alpha[i] = Rho[i] * vecDot(S[i], q);
      q = vecSub(q, vecScale(Y[i], alpha[i]));
    }
    var gamma = 1;
    if (m > 0) {
      var denom = vecDot(Y[m - 1], Y[m - 1]);
      if (denom > 1e-14) gamma = vecDot(S[m - 1], Y[m - 1]) / denom;
    }
    var r = vecScale(q, gamma);
    for (i = 0; i < m; i += 1) {
      var beta = Rho[i] * vecDot(Y[i], r);
      r = vecAddScaled(r, S[i], alpha[i] - beta);
    }
    return vecScale(r, -1);
  }

  function computeInteriorMoveStats(data, prevX, prevY, nextX, nextY) {
    return computeMoveStats(data.interiorAugIndices, function (idx) {
      return Math.hypot(nextX[idx] - prevX[idx], nextY[idx] - prevY[idx]);
    }, { moveTol: 1e-9 });
  }

  async function runFABalancerOptimization(q0, data, opts) {
    var maxIters = opts.maxIters;
    var maxPositionStep = opts.maxPositionStep;
    var evaluate = typeof opts.evaluate === 'function' ? opts.evaluate : evaluateFABalancerObjectiveAndGradient;
    var q = q0.slice();
    var current = evaluate(q, data);
    if (!current.ok) return current;

    var best = current;
    var bestQ = q.slice();
    var S = [];
    var Y = [];
    var Rho = [];
    var onIteration = typeof opts.onIteration === 'function' ? opts.onIteration : null;
    var movementTracker = opts.movementTracker || null;
    var movementStatus = { stableIterations: 0, stableIterLimit: 0, converged: false };
    var stopReason = 'max-iters';
    var moveStats = { movedVertices: 0, totalMove: 0, avgMove: 0, maxMove: 0 };
    var completedIters = 0;

    for (var iter = 1; iter <= maxIters; iter += 1) {
      if (current.gradNorm <= FABALANCER_CONFIG.gradTol) {
        stopReason = 'grad-converged';
        break;
      }

      var prevX = current.x;
      var prevY = current.y;
      var d = lbfgsDirection(current.gradVec, S, Y, Rho);
      if (!(vecDot(current.gradVec, d) < 0)) d = vecScale(current.gradVec, -1);
      var directionNorm = vecNorm(d);
      if (directionNorm > FABALANCER_CONFIG.maxStepNorm) {
        d = vecScale(d, FABALANCER_CONFIG.maxStepNorm / directionNorm);
      }

      var gtd = vecDot(current.gradVec, d);
      var accepted = null;
      var lineSearchAttempt;
      for (lineSearchAttempt = 0; lineSearchAttempt < 2 && !accepted; lineSearchAttempt += 1) {
        var searchDir = d;
        if (lineSearchAttempt === 1) {
          searchDir = vecScale(current.gradVec, -1);
          directionNorm = vecNorm(searchDir);
          if (directionNorm > FABALANCER_CONFIG.maxStepNorm) {
            searchDir = vecScale(searchDir, FABALANCER_CONFIG.maxStepNorm / directionNorm);
          }
          gtd = vecDot(current.gradVec, searchDir);
          if (!(gtd < 0)) {
            break;
          }
          if (S.length > 0) {
            S = [];
            Y = [];
            Rho = [];
          }
        }
        var alpha = 1.0;
        while (alpha >= 1e-12) {
          var qTrial = vecAddScaled(q, searchDir, alpha);
          var trial = evaluate(qTrial, data);
          if (trial.ok) {
            var trialMoveStats = computeInteriorMoveStats(data, current.x, current.y, trial.x, trial.y);
            if (trialMoveStats.maxMove > maxPositionStep) {
              alpha *= FABALANCER_CONFIG.lineSearchTau;
              continue;
            }
          }
          if (trial.ok && trial.E <= current.E + FABALANCER_CONFIG.lineSearchC1 * alpha * gtd) {
            accepted = { q: qTrial, eval: trial };
            break;
          }
          alpha *= FABALANCER_CONFIG.lineSearchTau;
        }
      }
      if (!accepted) {
        stopReason = 'line-search-failed';
        break;
      }

      var s = vecSub(accepted.q, q);
      var y = vecSub(accepted.eval.gradVec, current.gradVec);
      var stepNorm = vecNorm(s);
      q = accepted.q;
      current = accepted.eval;
      completedIters = iter;
      if (current.E < best.E) {
        best = current;
        bestQ = q.slice();
      }

      if (movementTracker) {
        moveStats = computeInteriorMoveStats(data, prevX, prevY, current.x, current.y);
        movementStatus = movementTracker.update(moveStats, iter);
      }

      if (onIteration) {
        await onIteration({
          iter: iter,
          maxIters: maxIters,
          objective: current.E,
          maxRelError: current.maxRelError,
          maxAngleResidual: current.maxAngleResidual,
          minAngleRatio: current.minAngleRatio,
          positions: buildPositionMap(data, current.x, current.y),
          movedVertices: moveStats.movedVertices,
          maxMove: moveStats.maxMove,
          avgMove: moveStats.avgMove,
          debug: {
            gradNorm: current.gradNorm,
            stableIterCount: movementStatus.stableIterations,
            stableIterLimit: movementStatus.stableIterLimit,
            stepNorm: stepNorm,
            worstWedge: current.worstWedge || null
          }
        });
      }

      if (movementStatus.converged) {
        stopReason = movementStatus.reason || 'movement-converged';
        break;
      }
      if (stepNorm < FABALANCER_CONFIG.stepTol) {
        stopReason = 'step-converged';
        break;
      }

      var ys = vecDot(y, s);
      if (ys > 1e-14) {
        if (S.length === FABALANCER_CONFIG.lbfgsMemory) {
          S.shift();
          Y.shift();
          Rho.shift();
        }
        S.push(s);
        Y.push(y);
        Rho.push(1 / ys);
      }
    }

    return buildLayoutResult({
      q: bestQ,
      positions: buildPositionMap(data, best.x, best.y),
      E: best.E,
      maxRelError: best.maxRelError,
      maxAngleResidual: best.maxAngleResidual,
      minAngleRatio: best.minAngleRatio,
      worstWedge: best.worstWedge || null,
      stopReason: stopReason,
      iters: completedIters
    });
  }

  async function runAngleStageOptimization(q0, data, opts) {
    return runFABalancerOptimization(q0, data, Object.assign({}, opts, {
      evaluate: evaluateFABalancerAngleStageObjectiveAndGradient
    }));
  }

  async function runFABalancerFaceOptimization(q0, data, opts) {
    return runFABalancerOptimization(q0, data, Object.assign({}, opts, {
      evaluate: evaluateFABalancerObjectiveAndGradient
    }));
  }

  function createStageTracker(scale, minItersBeforeStop, stableIterLimit) {
    return global.GraphUtils.createMovementConvergenceTracker({
      minItersBeforeStop: minItersBeforeStop,
      stableIterLimit: stableIterLimit,
      maxMoveTol: FABALANCER_CONFIG.movementStopTol * scale,
      avgMoveTol: FABALANCER_CONFIG.avgMovementStopTol * scale
    });
  }

  function relaxMinFaceArea(data, q0, evaluateFn) {
    if (!(data && data.minFaceArea > 0) || typeof evaluateFn !== 'function') {
      return;
    }
    var probe = evaluateFn(q0, data);
    while (!probe.ok &&
           probe.reason === 'invalid-face-step' &&
           data.minFaceArea > 1e-18) {
      data.minFaceArea *= 0.25;
      probe = evaluateFn(q0, data);
    }
  }

  function buildFABalancerStageData(augmented, outerFace, outerPos, objectiveGraph, baseEmbedding, overrides) {
    return buildFABalancerData(Object.assign({
      augmentedEdgePairs: augmented.graph.edgePairs,
      augmentedEmbedding: augmented.embedding,
      outerFace: outerFace,
      outerPos: outerPos,
      objectiveGraph: objectiveGraph,
      baseEmbedding: baseEmbedding,
      areaTol: FABALANCER_CONFIG.areaTol,
      angleTol: FABALANCER_CONFIG.angleTol
    }, overrides || {}));
  }

  function buildStageSeedFromPositions(data, positions, tutteWeights) {
    var q0Result = buildInitialLogitSeedFromPositions(data, positions);
    if (!q0Result.ok) {
      q0Result = buildInitialLogitSeed(data, tutteWeights);
    }
    return q0Result;
  }

  async function runStageOptimization(runFn, q0, data, positionNodeIds, scalePositions, config) {
    var scale = GeometryUtils.computeDrawingDiameter(positionNodeIds, scalePositions);
    var tracker = createStageTracker(scale, config.minItersBeforeStop, config.stableIterLimit);
    return runFn(q0, data, {
      maxIters: config.maxIters,
      maxPositionStep: config.maxPositionStepRatio * scale,
      movementTracker: tracker,
      onIteration: config.onIteration || null
    });
  }

  async function runFABalancerStage(config) {
    var data = buildFABalancerStageData(
      config.augmented,
      config.outerFace,
      config.outerPos,
      config.objectiveGraph,
      config.baseEmbedding,
      config.dataOverrides
    );
    if (!data || !data.ok) {
      return buildLayoutError({ reason: data && data.reason || 'FABalancer setup failed' });
    }
    var initialQResult = config.buildInitialQ(data);
    if (!initialQResult || !initialQResult.ok) {
      return initialQResult || buildLayoutError({ reason: 'FABalancer initialization failed' });
    }
    var initialQ = initialQResult.q0;
    var baseline = initializeFABalancerBaseline(data, initialQ);
    if (!baseline || !baseline.ok || !baseline.positions) {
      return baseline || buildLayoutError({ reason: 'FABalancer initialization failed' });
    }
    if (typeof config.prepareData === 'function') {
      config.prepareData(data, baseline, initialQ);
    }
    var q0Result = config.buildSeed(data, baseline, initialQ);
    if (!q0Result || !q0Result.ok) {
      return q0Result || buildLayoutError({ reason: 'FABalancer initialization failed' });
    }
    var q0 = q0Result.q0;
    relaxMinFaceArea(data, q0, config.evaluate);
    var result = await runStageOptimization(
      config.run,
      q0,
      data,
      config.augmented.graph.nodeIds,
      config.scalePositions || baseline.positions,
      {
        maxIters: config.maxIters,
        maxPositionStepRatio: config.maxPositionStepRatio,
        minItersBeforeStop: config.minItersBeforeStop,
        stableIterLimit: config.stableIterLimit,
        onIteration: config.onIteration || null
      }
    );
    return buildLayoutResult({
      result: result
    });
  }

  function buildFABalancerStageError(setup, fallbackMessage, g, outerFace, augmented) {
    return buildLayoutError({
      message: setup && (setup.reason || setup.message) || fallbackMessage,
      graph: g,
      outerFace: outerFace,
      augmented: augmented
    });
  }

  async function computeFABalancerPositionsFromPrepared(options, context) {
    options = options || {};
    var onIteration = typeof options.onIteration === 'function' ? options.onIteration : null;
    if (!context || !context.ok) {
      return buildLayoutError(context || { message: 'FABalancer setup failed' });
    }

    var g = context.graph;
    var outerFace = context.augmentedOuterFace;
    var augmented = context.augmented;
    var baseEmbedding = context.baseEmbedding;
    var outerPos = buildFABalancerOuterPositions(context);
    var tutteWeights = PlanarVibeTutte.buildTutteWeights(g, context.augmentedGraph);
    var STAGE_COUNT = 3;

    function filteredOriginalPositions(posById) {
      return GeometryUtils.filterPositionMap(posById || {}, g.nodeIds);
    }

    async function emitStageProgress(stageKey, stageLabel, stageIndex, rawProgress, positionsOverride) {
      if (!onIteration || !rawProgress) return;
      var positions = GeometryUtils.filterPositionMap(
        positionsOverride || rawProgress.positions || {},
        g.nodeIds
      );
      var angleStats = computeAngleStats(g, positions);
      var faceStats = computeFaceStats(g, baseEmbedding, positions);
      var tradeoffScore = computeFABalancerTradeoffScore(faceStats.faceAreaScore, angleStats.angleResolutionScore);
      await onIteration(Object.assign({}, rawProgress, {
        stage: stageKey,
        stageLabel: stageLabel,
        stageIndex: stageIndex,
        stageCount: STAGE_COUNT,
        positions: positions,
        angleResolutionScore: angleStats.angleResolutionScore,
        angleCount: angleStats.angleCount,
        faceAreaScore: faceStats.faceAreaScore,
        tradeoffScore: Number.isFinite(tradeoffScore) ? tradeoffScore : null
      }));
    }

    async function emitPostStageProgress(stageKey, stageLabel, stageIndex, step, maxSteps, positions, debug) {
      if (!onIteration) return;
      var metrics = computeFABalancerStageMetrics(g, baseEmbedding, positions);
      await onIteration({
        stage: stageKey,
        stageLabel: stageLabel,
        stageIndex: stageIndex,
        stageCount: STAGE_COUNT,
        iter: step,
        maxIters: maxSteps,
        objective: null,
        positions: metrics.positions,
        angleResolutionScore: metrics.angleResolutionScore,
        angleCount: metrics.angleCount,
        faceAreaScore: metrics.faceAreaScore,
        tradeoffScore: Number.isFinite(metrics.tradeoffScore) ? metrics.tradeoffScore : null,
        debug: debug || null
      });
    }

    var faceWarmSetup = await runFABalancerStage({
      augmented: augmented,
      outerFace: outerFace,
      outerPos: outerPos,
      objectiveGraph: g,
      baseEmbedding: baseEmbedding,
      dataOverrides: {
        angleBarrierWeight: FABALANCER_CONFIG.faceWarmStage.angleBarrierWeight,
        faceBarrierWeight: FABALANCER_CONFIG.faceWarmStage.faceBarrierWeight,
        edgeBarrierWeight: FABALANCER_CONFIG.faceWarmStage.edgeBarrierWeight,
        edgeUniformWeight: FABALANCER_CONFIG.faceWarmStage.edgeUniformWeight,
        faceWeight: FABALANCER_CONFIG.faceWarmStage.faceWeight,
        angleWeight: FABALANCER_CONFIG.faceWarmStage.angleWeight,
        horizontalityWeight: FABALANCER_CONFIG.faceWarmStage.horizontalityWeight
      },
      prepareData: function (data) {
        data.minFaceArea = Math.max(0, FABALANCER_CONFIG.faceWarmStage.minFaceAreaFactor * data.initialMinFaceArea);
      },
      buildInitialQ: function (data) {
        return buildInitialLogitSeed(data, tutteWeights);
      },
      buildSeed: function (data, baseline) {
        return buildStageSeedFromPositions(data, baseline.positions, tutteWeights);
      },
      evaluate: evaluateFABalancerObjectiveAndGradient,
      run: runFABalancerFaceOptimization,
      maxIters: FABALANCER_CONFIG.faceWarmStage.maxIters,
      maxPositionStepRatio: FABALANCER_CONFIG.faceWarmStage.maxPositionStepRatio,
      minItersBeforeStop: FABALANCER_CONFIG.faceWarmStage.minItersBeforeStop,
      stableIterLimit: FABALANCER_CONFIG.faceWarmStage.stableIterLimit,
      onIteration: async function (progress) {
        await emitStageProgress('face-warm', 'face', 1, progress);
      }
    });
    if (!faceWarmSetup || !faceWarmSetup.ok) {
      return buildFABalancerStageError(faceWarmSetup, 'FABalancer setup failed', g, outerFace, augmented);
    }
    if (!faceWarmSetup.result || !faceWarmSetup.result.ok || !Array.isArray(faceWarmSetup.result.q)) {
      return buildFABalancerStageError(faceWarmSetup.result, 'FABalancer face-warm stage did not return a valid result', g, outerFace, augmented);
    }
    var faceWarmQ = faceWarmSetup.result.q;

    var angleSetup = await runFABalancerStage({
      augmented: augmented,
      outerFace: outerFace,
      outerPos: outerPos,
      objectiveGraph: g,
      baseEmbedding: baseEmbedding,
      dataOverrides: {
        angleBarrierWeight: FABALANCER_CONFIG.angleStage.angleBarrierWeight,
        faceBarrierWeight: FABALANCER_CONFIG.angleStage.faceBarrierWeight,
        edgeBarrierWeight: FABALANCER_CONFIG.angleStage.edgeBarrierWeight,
        edgeUniformWeight: FABALANCER_CONFIG.angleStage.edgeUniformWeight,
        faceWeight: FABALANCER_CONFIG.angleStage.faceWeight,
        angleWeight: FABALANCER_CONFIG.angleStage.angleWeight,
        horizontalityWeight: FABALANCER_CONFIG.angleStage.horizontalityWeight
      },
      prepareData: function (data) {
        data.minFaceArea = Math.max(0, FABALANCER_CONFIG.angleStage.minFaceAreaFactor * data.initialMinFaceArea);
        if (!(data.objectiveVertexIds.length > 0) || !(data.wedges.length > 0)) {
          data.angleWeight = 0;
        }
      },
      buildInitialQ: function (data) {
        if (Array.isArray(faceWarmQ)) {
          return buildLayoutResult({ q0: faceWarmQ.slice() });
        }
        return buildInitialLogitSeed(data, tutteWeights);
      },
      buildSeed: function (_data, _baseline, initialQ) {
        return buildLayoutResult({ q0: initialQ.slice() });
      },
      evaluate: evaluateFABalancerAngleStageObjectiveAndGradient,
      run: runAngleStageOptimization,
      maxIters: FABALANCER_CONFIG.angleStage.maxIters,
      maxPositionStepRatio: FABALANCER_CONFIG.angleStage.maxPositionStepRatio,
      minItersBeforeStop: FABALANCER_CONFIG.angleStage.minItersBeforeStop,
      stableIterLimit: FABALANCER_CONFIG.angleStage.stableIterLimit,
      onIteration: async function (progress) {
        await emitStageProgress('angle', 'angle', 2, progress);
      }
    });
    if (!angleSetup || !angleSetup.ok) {
      return buildFABalancerStageError(angleSetup, 'FABalancer setup failed', g, outerFace, augmented);
    }
    var angleResult = angleSetup.result;
    if (!angleResult || !angleResult.ok) {
      return buildFABalancerStageError(angleResult, 'FABalancer optimization failed', g, outerFace, augmented);
    }

    var finalPositions = filteredOriginalPositions(angleResult.positions || {});
    if (hasPositionCrossings(finalPositions, g.edgePairs)) {
      return buildLayoutError({
        stopReason: angleResult.stopReason,
        graph: g,
        outerFace: outerFace,
        augmented: augmented,
        message: 'FABalancer produced a non-plane drawing'
      });
    }
    var alignStage = applyFABalancerAxisAlignment(g, finalPositions, FABALANCER_CONFIG.alignMaxPasses);
    if (!alignStage.ok) {
      return buildLayoutError({
        message: alignStage.reason || alignStage.message || 'FABalancer axis-align failed',
        graph: g,
        outerFace: outerFace,
        augmented: augmented
      });
    }
    finalPositions = GeometryUtils.filterPositionMap(alignStage.positions || finalPositions, g.nodeIds);
    for (var alignPass = 0; alignPass < Math.max(1, alignStage.passes || 0); alignPass += 1) {
      var alignPassResult = alignStage.results && alignStage.results[alignPass] ? alignStage.results[alignPass] : null;
      await emitPostStageProgress(
        'align',
        'align',
        3,
        alignPass + 1,
        Math.max(1, alignStage.passes || 0),
        alignPassResult && alignPassResult.positions ? alignPassResult.positions : finalPositions,
        {
        alignmentChanged: !!alignStage.changed,
        passResult: alignPassResult
        }
      );
    }

    var finalMetrics = computeFABalancerStageMetrics(g, baseEmbedding, finalPositions);
    return buildLayoutResult({
      nodeIds: g.nodeIds,
      edgePairs: g.edgePairs,
      outerFace: outerFace,
      graph: g,
      augmented: augmented,
      positions: finalPositions,
      debugPositions: angleResult.positions,
      stopReason: angleResult.stopReason,
      iters: angleResult.iters,
      objective: null,
      angleResolutionScore: finalMetrics.angleResolutionScore,
      angleCount: finalMetrics.angleCount,
      faceAreaScore: finalMetrics.faceAreaScore,
      maxRelError: null,
      maxAngleResidual: angleResult.maxAngleResidual,
      minAngleRatio: angleResult.minAngleRatio,
      tradeoffScore: finalMetrics.tradeoffScore
    });
  }

  function buildFABalancerOuterPositions(prepared) {
    if (!prepared || !prepared.ok) {
      throw new Error('buildFABalancerOuterPositions requires prepared graph data');
    }
    var fullPos = PlanarVibeTutte.placeOuterFaceVertices(
      prepared.augmentedGraph.nodeIds,
      prepared.augmentedOuterFace,
      PlanarVibeTutte.defaultOuterPlacementOptions()
    );
    var outerPos = {};
    for (var i = 0; i < prepared.augmentedOuterFace.length; i += 1) {
      var id = String(prepared.augmentedOuterFace[i]);
      if (fullPos[id] && Number.isFinite(fullPos[id].x) && Number.isFinite(fullPos[id].y)) {
        outerPos[id] = { x: fullPos[id].x, y: fullPos[id].y };
      }
    }
    return outerPos;
  }

  function createLayoutInput(graph, options) {
    options = options || {};
    return LayoutPreprocessing.createLayoutInput(graph, {
      failureLabel: 'FABalancer layout',
      augmentationMethod: options.augmentationMethod === undefined ? null : options.augmentationMethod,
      augmentationOptions: typeof options.augmentationOptions === 'object' && options.augmentationOptions
        ? Object.assign({}, options.augmentationOptions)
        : null,
      currentPositions: options.currentPositions
    });
  }

  async function computePositions(graph, layoutInput) {
    return computeFABalancerPositionsFromPrepared(null, layoutInput);
  }

  async function computeFABalancerPositions(graph, options) {
    options = options || {};
    return computeFABalancerPositionsFromPrepared(options, createLayoutInput(graph, options));
  }

  async function applyFABalancerLayout(cy, options) {
    return CyRuntime.runLayout(cy, options, {
      prepareMode: 'graph',
      prepareFailureLabel: 'FABalancer layout',
      initialFitBounds: function (ctx) {
        return CyRuntime.computePositionBounds(buildFABalancerOuterPositions(ctx.prepared));
      },
      computePositions: function (_graph, computeOptions, prepared) {
        return computeFABalancerPositionsFromPrepared(computeOptions || {}, prepared);
      },
      buildResult: function (ctx) {
        var result = ctx.result;
        var message = buildLayoutStatusMessage('FABalancer', {
          dummyCount: result.augmented.dummyCount,
          iters: result.iters,
          stopReason: result.stopReason,
          extraParts: [
            Number.isFinite(result.faceAreaScore) ? 'face score ' + result.faceAreaScore.toFixed(3) : null,
            Number.isFinite(result.angleResolutionScore) ? 'angle score ' + result.angleResolutionScore.toFixed(3) : null,
            Number.isFinite(result.tradeoffScore) ? 'tradeoff ' + result.tradeoffScore.toFixed(3) : null,
            Number.isFinite(result.objective) ? 'obj ' + result.objective.toFixed(3) : null
          ]
        });
        return {
          ok: true,
          stopReason: result.stopReason,
          faceAreaScore: result.faceAreaScore,
          angleResolutionScore: result.angleResolutionScore,
          message: message,
          debugState: LayoutPreprocessing.createAugmentationDebugState(
            result.graph,
            result.augmented,
            result.debugPositions || result.positions
          )
        };
      },
      failureMessage: 'FABalancer failed'
    });
  }

	  global.PlanarVibeFABalancer = {
	    createLayoutInput: createLayoutInput,
	    computePositions: computePositions,
	    applyLayout: applyFABalancerLayout
	  };
})(window);
