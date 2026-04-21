(function (global) {
  'use strict';

  var LayoutPreprocessing = global.LayoutPreprocessing;
  var CyRuntime = global.CyRuntime;
  var Metrics = global.PlanarVibeMetrics;
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
  var luFactorize = LinearAlgebraUtils.luFactorize;
  var segmentsIntersectStrict = GeometryUtils.segmentsIntersectStrict;
  var solveLUWithTwoRhs = LinearAlgebraUtils.solveLUWithTwoRhs;
  var solveTransposeLUWithTwoRhs = LinearAlgebraUtils.solveTransposeLUWithTwoRhs;
  var createZeroVector = GeometryUtils.createZeroVector;
  var vecAddScaled = GeometryUtils.vecAddScaled;
  var vecDot = GeometryUtils.vecDot;
  var vecNorm = GeometryUtils.vecNorm;
  var vecScale = GeometryUtils.vecScale;
  var vecSub = GeometryUtils.vecSub;

  var TWO_PI = 2 * Math.PI;
  var ANGLE_CONFIG = {
    areaTol: 1e-15,
    wedgeTol: 1e-8,
    angleBarrierWeight: 0.05,
    faceBarrierWeight: 0.02,
    faceWeight: 0,
    angleWeight: 0,
    edgeBarrierWeight: 0,
    edgeUniformWeight: 0,
    minFaceAreaFactor: 0.2,
    gradTol: 1e-5,
    stepTol: 1e-10,
    lbfgsMemory: 10,
    maxStepNorm: 2.0,
    lineSearchC1: 1e-4,
    lineSearchTau: 0.5,
    maxIters: 200,
    minItersBeforeStop: 40,
    stableIterLimit: 8,
    movementStopTol: 1e-6,
    avgMovementStopTol: 2e-7,
    maxPositionStepRatio: 0.01
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

  function chooseCCWNeighborOrder(centerAug, neighborAugIndices, x0, y0) {
    if (!neighborAugIndices || neighborAugIndices.length < 2) {
      return Array.isArray(neighborAugIndices) ? neighborAugIndices.slice() : [];
    }
    var angles = new Array(neighborAugIndices.length);
    for (var i = 0; i < neighborAugIndices.length; i += 1) {
      var neighborAug = neighborAugIndices[i];
      angles[i] = Math.atan2(y0[neighborAug] - y0[centerAug], x0[neighborAug] - x0[centerAug]);
    }
    var forwardSum = 0;
    var backwardSum = 0;
    for (i = 0; i < angles.length; i += 1) {
      var next = (i + 1) % angles.length;
      forwardSum += computePositiveTurn(angles[i], angles[next]);
      backwardSum += computePositiveTurn(angles[next], angles[i]);
    }
    return Math.abs(forwardSum - TWO_PI) <= Math.abs(backwardSum - TWO_PI)
      ? neighborAugIndices.slice()
      : neighborAugIndices.slice().reverse();
  }

  function buildAngleBalancerData(input) {
    var augmentedEdgePairs = input.augmentedEdgePairs;
    var augmentedEmbedding = input.augmentedEmbedding;
    var outerFace = input.outerFace;
    var outerPos = input.outerPos || {};
    var objectiveGraph = input.objectiveGraph;
    var baseEmbedding = input.baseEmbedding;
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
    var boundedFaceKeys = [];
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
      var faceK = faceKey(rawFace);
      if (faceK === outerKey) continue;
      if (!rawFace || rawFace.length < 3) {
        return buildLayoutError({ reason: 'AngleBalancer requires a valid triangulated augmentation' });
      }
      if (rawFace.length !== 3) {
        return buildLayoutError({ reason: 'AngleBalancer requires all non-outer augmented faces to be triangles' });
      }
      boundedFaceKeys.push(faceK);
      var boundedFace = rawFace.map(function (id) { return augIndexById[String(id)]; });
      boundedFaces.push(boundedFace);
    }

    var triangles = [];
    for (i = 0; i < boundedFaces.length; i += 1) {
      var triFace = boundedFaces[i];
      triangles.push([triFace[0], triFace[1], triFace[2], i]);
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

    return buildLayoutResult({
      ok: true,
      augIds: augIds,
      augIndexById: augIndexById,
      x0: x0,
      y0: y0,
      interiorAugIndices: interiorAugIndices,
      interiorVertexIds: interiorAugIndices.map(function (idx) { return augIds[idx]; }),
      interiorIndexByAug: interiorIndexByAug,
      rowStart: rowStart,
      rowLength: rowLength,
      neighborAugIndices: neighborAugIndices,
      neighborInteriorIndices: neighborInteriorIndices,
      qSize: qSize,
      triangles: triangles,
      boundedFaces: boundedFaces,
      boundedFaceKeys: boundedFaceKeys,
      edges: edges,
      areaTol: input.areaTol,
      angleTol: input.angleTol,
      angleBarrierWeight: Math.max(0, input.angleBarrierWeight),
      faceBarrierWeight: Math.max(0, input.faceBarrierWeight),
      edgeBarrierWeight: Math.max(0, input.edgeBarrierWeight),
      edgeUniformWeight: Math.max(0, input.edgeUniformWeight),
      edgeBarrierScale2: 1,
      initialMinEdgeLength2: 0,
      initialAvgFaceArea: 1,
      initialMinFaceArea: 0,
      initialMinAngleRatio: 0,
      initialMaxAngleResidual: 0,
      minFaceArea: Math.max(0, input.minFaceArea),
      faceWeight: Math.max(0, input.faceWeight),
      angleWeight: Math.max(0, input.angleWeight),
      objectiveGraph: objectiveGraph,
      baseEmbedding: baseEmbedding,
      baseIds: baseIds,
      baseIndexById: baseIndexById,
      objectiveVertexIds: [],
      wedgeStart: [],
      wedgeCount: [],
      wedges: []
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
            reason: 'AngleBalancer initialization requires positive Tutte weights',
            vertexId: vertexId,
            neighborId: neighborId
          });
        }
        rowWeights[k] = rowWeight;
        rowWeightSum += rowWeight;
      }
      if (!(rowWeightSum > 0)) {
        return buildLayoutError({
          reason: 'AngleBalancer initialization requires positive Tutte row weight sum',
          vertexId: vertexId
        });
      }
      for (k = 0; k < neighbors.length; k += 1) {
        q0[rowOffset + k] = Math.log(rowWeights[k] / rowWeightSum);
      }
    }
    return buildLayoutResult({ ok: true, q0: q0 });
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

  function polygonHasSelfIntersection(vertexIds, getPoint, eps) {
    if (typeof getPoint !== 'function') {
      throw new Error('polygonHasSelfIntersection requires a point lookup function');
    }
    if (!vertexIds || vertexIds.length < 4) return false;
    var n = vertexIds.length;
    for (var i = 0; i < n; i += 1) {
      var a0 = vertexIds[i];
      var a1 = vertexIds[(i + 1) % n];
      var pa0 = getPoint(a0);
      var pa1 = getPoint(a1);
      if (!pa0 || !pa1) {
        throw new Error('polygonHasSelfIntersection found a missing polygon point');
      }
      for (var j = i + 1; j < n; j += 1) {
        var nextI = (i + 1) % n;
        var nextJ = (j + 1) % n;
        if (i === j || i === nextJ || nextI === j) continue;
        if (i === 0 && nextJ === 0) continue;
        var b0 = vertexIds[j];
        var b1 = vertexIds[nextJ];
        var pb0 = getPoint(b0);
        var pb1 = getPoint(b1);
        if (!pb0 || !pb1) {
          throw new Error('polygonHasSelfIntersection found a missing polygon point');
        }
        if (segmentsIntersectStrict(pa0, pa1, pb0, pb1, eps)) {
          return true;
        }
      }
    }
    return false;
  }

  function getIndexedPoint(x, y) {
    return function (index) {
      return { x: x[index], y: y[index] };
    };
  }

  function realizeAngleBalancerState(q, data) {
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
    if (!factor) return buildLayoutError({ reason: 'AngleBalancer linear solve failed' });
    var primal = solveLUWithTwoRhs(factor, bx, by);
    if (!primal) return buildLayoutError({ reason: 'AngleBalancer linear solve failed' });

    var x = data.x0.slice();
    var y = data.y0.slice();
    for (i = 0; i < nI; i += 1) {
      var aug = data.interiorAugIndices[i];
      x[aug] = primal.x1[i];
      y[aug] = primal.x2[i];
    }
    return buildLayoutResult({
      ok: true,
      lambda: lambda,
      factor: factor,
      x: x,
      y: y
    });
  }

  function initializeAngleBalancerBaseline(data, q0) {
    var realized = realizeAngleBalancerState(q0, data);
    if (!realized || !realized.ok) {
      return realized || buildLayoutError({ reason: 'AngleBalancer initialization failed' });
    }

    var x = realized.x;
    var y = realized.y;
    var edgeScaleSum = 0;
    var edgeScaleCount = 0;
    var initialMinEdgeLength2 = Infinity;
    var i;
    for (i = 0; i < data.edges.length; i += 1) {
      var edge = data.edges[i];
      var dx = x[edge[0]] - x[edge[1]];
      var dy = y[edge[0]] - y[edge[1]];
      var len2 = dx * dx + dy * dy;
      if (len2 > 1e-12) {
        edgeScaleSum += len2;
        edgeScaleCount += 1;
        if (len2 < initialMinEdgeLength2) initialMinEdgeLength2 = len2;
      }
    }
    data.edgeBarrierScale2 = edgeScaleCount > 0 ? (edgeScaleSum / edgeScaleCount) : 1;
    data.initialMinEdgeLength2 = Number.isFinite(initialMinEdgeLength2) ? initialMinEdgeLength2 : 0;

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
      data.triangles[i] = [face[0], face[1], face[2], i];
    }
    data.initialAvgFaceArea = initialFaceCount > 0 ? (initialFaceAreaSum / initialFaceCount) : 1;
    data.initialMinFaceArea = Number.isFinite(initialFaceMinArea) ? initialFaceMinArea : 0;

    var objectiveVertexIds = [];
    var wedgeStart = [];
    var wedgeCount = [];
    var wedges = [];
    var initialMinAngleRatio = Infinity;
    var initialMaxAngleResidual = 0;
    for (i = 0; i < data.objectiveGraph.nodeIds.length; i += 1) {
      var centerId = String(data.objectiveGraph.nodeIds[i]);
      var centerBaseIdx = data.baseIndexById[centerId];
      var centerAugIdx = data.augIndexById[centerId];
      if (centerBaseIdx === undefined || centerAugIdx === undefined) continue;
      var objectiveRotation = data.baseEmbedding.rotation[centerBaseIdx] || [];
      if (objectiveRotation.length < 2) continue;
      var objectiveNeighbors = [];
      for (var k = 0; k < objectiveRotation.length; k += 1) {
        var neighborAugIdx = data.augIndexById[String(objectiveRotation[k])];
        if (neighborAugIdx !== undefined) {
          objectiveNeighbors.push(neighborAugIdx);
        }
      }
      if (objectiveNeighbors.length < 2) continue;
      objectiveNeighbors = chooseCCWNeighborOrder(centerAugIdx, objectiveNeighbors, x, y);
      var targetAngle = TWO_PI / objectiveNeighbors.length;
      wedgeStart.push(wedges.length);
      wedgeCount.push(objectiveNeighbors.length);
      objectiveVertexIds.push(centerId);
      for (k = 0; k < objectiveNeighbors.length; k += 1) {
        var leftAugIdx = objectiveNeighbors[k];
        var rightAugIdx = objectiveNeighbors[(k + 1) % objectiveNeighbors.length];
        wedges.push([centerAugIdx, leftAugIdx, rightAugIdx, targetAngle, objectiveVertexIds.length - 1]);
        var leftAngle = Math.atan2(y[leftAugIdx] - y[centerAugIdx], x[leftAugIdx] - x[centerAugIdx]);
        var rightAngle = Math.atan2(y[rightAugIdx] - y[centerAugIdx], x[rightAugIdx] - x[centerAugIdx]);
        var initialAngle = computePositiveTurn(leftAngle, rightAngle);
        var initialRatio = initialAngle / targetAngle;
        if (initialRatio < initialMinAngleRatio) initialMinAngleRatio = initialRatio;
        var initialResidual = Math.abs(initialRatio - 1);
        if (initialResidual > initialMaxAngleResidual) initialMaxAngleResidual = initialResidual;
      }
    }
    data.objectiveVertexIds = objectiveVertexIds;
    data.wedgeStart = wedgeStart;
    data.wedgeCount = wedgeCount;
    data.wedges = wedges;
    data.initialMinAngleRatio = Number.isFinite(initialMinAngleRatio) ? initialMinAngleRatio : 0;
    data.initialMaxAngleResidual = initialMaxAngleResidual;

    return buildLayoutResult({
      ok: true,
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
    if (!(angle > 0)) {
      angle += TWO_PI;
    }
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
      ok: true,
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
      return buildLayoutError({ reason: 'AngleBalancer requires at least one valid objective angle' });
    }

    var weightScale = 1 / wedgeCount;
    var angleObjectiveTerm = 0;
    var maxAngleResidual = 0;
    var minAngleRatio = Infinity;
    var worstWedge = null;
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

      angleObjectiveTerm += weightScale * residual * residual;
      var coeff = weightScale * (2 * residual / targetAngle);
      if (data.angleBarrierWeight > 0) {
        angleObjectiveTerm -= weightScale * data.angleBarrierWeight * Math.log(ratio);
        coeff -= weightScale * data.angleBarrierWeight / wedgeEval.angle;
      }
      addPointGradient(data, center, coeff * wedgeEval.gradCenterX, coeff * wedgeEval.gradCenterY, zX, zY);
      addPointGradient(data, left, coeff * wedgeEval.gradLeftX, coeff * wedgeEval.gradLeftY, zX, zY);
      addPointGradient(data, right, coeff * wedgeEval.gradRightX, coeff * wedgeEval.gradRightY, zX, zY);
    }

    return buildLayoutResult({
      ok: true,
      angleObjectiveTerm: angleObjectiveTerm,
      maxAngleResidual: maxAngleResidual,
      minAngleRatio: Number.isFinite(minAngleRatio) ? minAngleRatio : null,
      worstWedge: worstWedge
    });
  }

  function evaluateObjectiveAndGradient(q, data) {
    var triangleSlack = Math.max(data.areaTol, 1e-12);
    var i;
    var nI = data.interiorAugIndices.length;
    var realized = realizeAngleBalancerState(q, data);
    if (!realized || !realized.ok) {
      return realized || buildLayoutError({ reason: 'AngleBalancer linear solve failed' });
    }
    var lambda = realized.lambda;
    var factor = realized.factor;
    var x = realized.x;
    var y = realized.y;
    var getPoint = getIndexedPoint(x, y);

    var faceAreas = createZeroVector(data.boundedFaceKeys.length);
    for (i = 0; i < data.triangles.length; i += 1) {
      var tri = data.triangles[i];
      var a = tri[0];
      var b = tri[1];
      var c = tri[2];
      var area = 0.5 * ((x[b] - x[a]) * (y[c] - y[a]) - (x[c] - x[a]) * (y[b] - y[a]));
      if (!(area > -triangleSlack)) {
        return buildLayoutError({ reason: 'invalid-triangulation-step' });
      }
      faceAreas[tri[3]] += area > triangleSlack ? area : triangleSlack;
    }
    for (i = 0; i < faceAreas.length; i += 1) {
      if (!(faceAreas[i] > data.minFaceArea)) {
        return buildLayoutError({ reason: 'invalid-face-step' });
      }
    }
    for (i = 0; i < data.boundedFaces.length; i += 1) {
      var boundary = data.boundedFaces[i];
      if (polygonHasSelfIntersection(boundary, getPoint, 1e-9)) {
        return buildLayoutError({ reason: 'invalid-face-step' });
      }
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

    var faceBarrierTerm = 0;
    if (data.faceBarrierWeight > 0) {
      var faceScale = data.initialAvgFaceArea > 1e-12 ? data.initialAvgFaceArea : 1;
      for (i = 0; i < faceAreas.length; i += 1) {
        faceBarrierTerm -= data.faceBarrierWeight * Math.log(faceAreas[i] / faceScale);
      }
      E += faceBarrierTerm;
      for (i = 0; i < data.triangles.length; i += 1) {
        tri = data.triangles[i];
        a = tri[0];
        b = tri[1];
        c = tri[2];
        var faceIdx = tri[3];
        var coeff = -data.faceBarrierWeight / faceAreas[faceIdx];
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
    if (!adjoint) return buildLayoutError({ reason: 'AngleBalancer adjoint solve failed' });

    var gradVec = createZeroVector(data.qSize);
    for (i = 0; i < nI; i += 1) {
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

    return buildLayoutResult({
      ok: true,
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

  async function runAngleBalancerOptimization(q0, data, opts) {
    var maxIters = opts.maxIters;
    var maxPositionStep = opts.maxPositionStep;
    var q = q0.slice();
    var current = evaluateObjectiveAndGradient(q, data);
    if (!current.ok) return current;

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
      if (current.gradNorm <= ANGLE_CONFIG.gradTol) {
        stopReason = 'grad-converged';
        break;
      }

      var prevX = current.x;
      var prevY = current.y;
      var d = lbfgsDirection(current.gradVec, S, Y, Rho);
      if (!(vecDot(current.gradVec, d) < 0)) d = vecScale(current.gradVec, -1);
      var directionNorm = vecNorm(d);
      if (directionNorm > ANGLE_CONFIG.maxStepNorm) {
        d = vecScale(d, ANGLE_CONFIG.maxStepNorm / directionNorm);
      }

      var gtd = vecDot(current.gradVec, d);
      var accepted = null;
      var lineSearchAttempt;
      for (lineSearchAttempt = 0; lineSearchAttempt < 2 && !accepted; lineSearchAttempt += 1) {
        var searchDir = d;
        if (lineSearchAttempt === 1) {
          searchDir = vecScale(current.gradVec, -1);
          directionNorm = vecNorm(searchDir);
          if (directionNorm > ANGLE_CONFIG.maxStepNorm) {
            searchDir = vecScale(searchDir, ANGLE_CONFIG.maxStepNorm / directionNorm);
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
          var trial = evaluateObjectiveAndGradient(qTrial, data);
          if (trial.ok) {
            var trialMoveStats = computeInteriorMoveStats(data, current.x, current.y, trial.x, trial.y);
            if (trialMoveStats.maxMove > maxPositionStep) {
              alpha *= ANGLE_CONFIG.lineSearchTau;
              continue;
            }
          }
          if (trial.ok && trial.E <= current.E + ANGLE_CONFIG.lineSearchC1 * alpha * gtd) {
            accepted = { q: qTrial, eval: trial };
            break;
          }
          alpha *= ANGLE_CONFIG.lineSearchTau;
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

      if (movementTracker) {
        moveStats = computeInteriorMoveStats(data, prevX, prevY, current.x, current.y);
        movementStatus = movementTracker.update(moveStats, iter);
      }

      if (onIteration) {
        await onIteration({
          iter: iter,
          maxIters: maxIters,
          objective: current.E,
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
      if (stepNorm < ANGLE_CONFIG.stepTol) {
        stopReason = 'step-converged';
        break;
      }

      var ys = vecDot(y, s);
      if (ys > 1e-14) {
        if (S.length === ANGLE_CONFIG.lbfgsMemory) {
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
      ok: true,
      q: q,
      positions: buildPositionMap(data, current.x, current.y),
      E: current.E,
      gradNorm: current.gradNorm,
      maxAngleResidual: current.maxAngleResidual,
      minAngleRatio: current.minAngleRatio,
      worstWedge: current.worstWedge || null,
      stopReason: stopReason,
      iters: completedIters
    });
  }

  async function computeAngleBalancerPositions(graph, options) {
    options = options || {};
    var context = LayoutPreprocessing.prepareGraphData(graph, {
      failureLabel: 'AngleBalancer layout',
      augmentationMethod: options.augmentationMethod === undefined ? null : options.augmentationMethod,
      augmentationOptions: typeof options.augmentationOptions === 'object' && options.augmentationOptions
        ? Object.assign({}, options.augmentationOptions)
        : null,
      currentPositions: options.currentPositions
    });
    if (!context || !context.ok) {
      return buildLayoutError(context || { message: 'AngleBalancer setup failed' });
    }

    var g = context.graph;
    var outerFace = context.augmentedOuterFace;
    var augmented = context.augmented;
    var baseEmbedding = context.baseEmbedding;
    var outerPos = PlanarVibeTutte.placeOuterFaceVertices(
      context.augmentedGraph.nodeIds,
      outerFace,
      PlanarVibeTutte.defaultOuterPlacementOptions()
    );
    var data = buildAngleBalancerData({
      augmentedEdgePairs: augmented.graph.edgePairs,
      augmentedEmbedding: augmented.embedding,
      outerFace: outerFace,
      outerPos: outerPos,
      objectiveGraph: g,
      baseEmbedding: baseEmbedding,
      areaTol: ANGLE_CONFIG.areaTol,
      angleTol: ANGLE_CONFIG.wedgeTol,
      angleBarrierWeight: ANGLE_CONFIG.angleBarrierWeight,
      faceBarrierWeight: ANGLE_CONFIG.faceBarrierWeight,
      edgeBarrierWeight: ANGLE_CONFIG.edgeBarrierWeight,
      edgeUniformWeight: ANGLE_CONFIG.edgeUniformWeight,
      minFaceArea: 0,
      faceWeight: ANGLE_CONFIG.faceWeight,
      angleWeight: ANGLE_CONFIG.angleWeight
    });
    if (!data.ok) {
      return buildLayoutError({
        message: data.reason || 'AngleBalancer setup failed',
        graph: g,
        outerFace: outerFace,
        augmented: augmented
      });
    }
    var tutteWeights = PlanarVibeTutte.buildTutteWeights(g, context.augmentedGraph);
    var q0Result = buildInitialLogitSeed(data, tutteWeights);
    if (!q0Result.ok) {
      return buildLayoutError({
        message: q0Result.reason || 'AngleBalancer initialization failed',
        graph: g,
        outerFace: outerFace,
        augmented: augmented
      });
    }
    var q0 = q0Result.q0;
    var baseline = initializeAngleBalancerBaseline(data, q0);
    if (!baseline || !baseline.ok || !baseline.positions) {
      return buildLayoutError({
        message: baseline && baseline.reason ? baseline.reason : 'AngleBalancer initialization failed',
        graph: g,
        outerFace: outerFace,
        augmented: augmented
      });
    }
    data.minFaceArea = Math.max(0, ANGLE_CONFIG.minFaceAreaFactor * data.initialMinFaceArea);
    if (!(data.objectiveVertexIds.length > 0) || !(data.wedges.length > 0)) {
      var staticPositions = {};
      for (var si = 0; si < g.nodeIds.length; si += 1) {
        var sid = String(g.nodeIds[si]);
        if (baseline.positions[sid]) {
          staticPositions[sid] = { x: baseline.positions[sid].x, y: baseline.positions[sid].y };
        }
      }
      var staticStats = computeAngleStats(g, staticPositions);
      return buildLayoutResult({
        ok: true,
        nodeIds: g.nodeIds,
        edgePairs: g.edgePairs,
        outerFace: outerFace,
        graph: g,
        augmented: augmented,
        positions: staticPositions,
        debugPositions: baseline.positions,
        stopReason: 'no-objective-angles',
        iters: 0,
        objective: 0,
        angleResolutionScore: staticStats.angleResolutionScore,
        angleCount: staticStats.angleCount
      });
    }

    if (data.minFaceArea > 0) {
      var minFaceAreaProbe = evaluateObjectiveAndGradient(q0, data);
      while (!minFaceAreaProbe.ok &&
             minFaceAreaProbe.reason === 'invalid-face-step' &&
             data.minFaceArea > 1e-18) {
        data.minFaceArea *= 0.25;
        minFaceAreaProbe = evaluateObjectiveAndGradient(q0, data);
      }
    }

    var movementScale = GeometryUtils.computeDrawingDiameter(augmented.graph.nodeIds, baseline.positions);
    var movementTracker = global.GraphUtils.createMovementConvergenceTracker({
      minItersBeforeStop: ANGLE_CONFIG.minItersBeforeStop,
      stableIterLimit: ANGLE_CONFIG.stableIterLimit,
      maxMoveTol: ANGLE_CONFIG.movementStopTol * movementScale,
      avgMoveTol: ANGLE_CONFIG.avgMovementStopTol * movementScale
    });

    var result = await runAngleBalancerOptimization(q0, data, {
      maxIters: ANGLE_CONFIG.maxIters,
      maxPositionStep: ANGLE_CONFIG.maxPositionStepRatio * movementScale,
      movementTracker: movementTracker,
      onIteration: async function (progress) {
        if (options.onIteration) {
          var positions = {};
          for (var pi = 0; pi < g.nodeIds.length; pi += 1) {
            var pid = String(g.nodeIds[pi]);
            if (progress.positions[pid]) {
              positions[pid] = progress.positions[pid];
            }
          }
          var progressAngleStats = computeAngleStats(g, positions);
          await options.onIteration(Object.assign({}, progress, {
            positions: positions,
            angleResolutionScore: progressAngleStats.angleResolutionScore,
            angleCount: progressAngleStats.angleCount
          }));
        }
      }
    });
    if (!result.ok) {
      return buildLayoutError({
        message: result.reason || 'AngleBalancer optimization failed',
        graph: g,
        outerFace: outerFace,
        augmented: augmented
      });
    }

    var finalPositions = {};
    for (var i = 0; i < g.nodeIds.length; i += 1) {
      var nodeId = String(g.nodeIds[i]);
      if (result.positions[nodeId]) {
        finalPositions[nodeId] = result.positions[nodeId];
      }
    }
    var hasCrossings = hasPositionCrossings(finalPositions, g.edgePairs);
    if (hasCrossings) {
      return buildLayoutError({
        stopReason: result.stopReason,
        graph: g,
        outerFace: outerFace,
        augmented: augmented,
        message: 'AngleBalancer produced a non-plane drawing'
      });
    }
    var finalAngleStats = computeAngleStats(g, finalPositions);
    return buildLayoutResult({
      ok: true,
      nodeIds: g.nodeIds,
      edgePairs: g.edgePairs,
      outerFace: outerFace,
      graph: g,
      augmented: augmented,
      positions: finalPositions,
      debugPositions: result.positions,
      stopReason: result.stopReason,
      iters: result.iters,
      objective: result.E,
      angleResolutionScore: finalAngleStats.angleResolutionScore,
      angleCount: finalAngleStats.angleCount,
      maxAngleResidual: result.maxAngleResidual,
      minAngleRatio: result.minAngleRatio
    });
  }

  async function applyAngleBalancerLayout(cy, options) {
    return CyRuntime.runLayout(cy, options, {
      compute: computeAngleBalancerPositions,
      buildResult: function (ctx) {
        var result = ctx.result;
        var message = buildLayoutStatusMessage('AngleBalancer', {
          dummyCount: result.augmented.dummyCount,
          iters: result.iters,
          stopReason: result.stopReason,
          extraParts: [
            Number.isFinite(result.angleResolutionScore) ? 'angle score ' + result.angleResolutionScore.toFixed(3) : null,
            Number.isFinite(result.objective) ? 'obj ' + result.objective.toFixed(3) : null
          ]
        });
        return {
          ok: true,
          stopReason: result.stopReason,
          angleResolutionScore: result.angleResolutionScore,
          message: message,
          debugState: LayoutPreprocessing.createAugmentationDebugState(
            result.graph,
            result.augmented,
            result.debugPositions || result.positions
          )
        };
      },
      failureMessage: 'AngleBalancer failed'
    });
  }

  global.PlanarVibeAngleBalancer = {
    computeAngleBalancerPositions: computeAngleBalancerPositions,
    applyAngleBalancerLayout: applyAngleBalancerLayout
  };
})(window);
