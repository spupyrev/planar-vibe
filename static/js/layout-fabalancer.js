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
  var polygonArea2 = GeometryUtils.polygonArea2;
  var orientFaceCCW = GeometryUtils.orientFaceCCW;
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
  var HYBRID_AREA_TOL = 1e-15;
  var HYBRID_GRAD_TOL = 1e-5;
  var HYBRID_STEP_TOL = 1e-10;
  var HYBRID_ANGLE_TOL = 1e-8;
  var HYBRID_ANGLE_BARRIER_WEIGHT = 0.05;
  var HYBRID_FACE_BARRIER_WEIGHT = 0.02;
  var HYBRID_FACE_WEIGHT = 0.05;
  var HYBRID_ANGLE_WEIGHT = 1.0;
  var HYBRID_HORIZONTALITY_WEIGHT = 0.5;
  var HYBRID_EDGE_BARRIER_WEIGHT = 0.005;
  var HYBRID_EDGE_UNIFORM_WEIGHT = 0.002;
  var HYBRID_MAX_STEP_NORM = 2.0;
  var HYBRID_LBFGS_MEMORY = 10;
  var HYBRID_LINE_SEARCH_C1 = 1e-4;
  var HYBRID_LINE_SEARCH_TAU = 0.5;
  var HYBRID_STABLE_ITER_LIMIT = 8;
  var HYBRID_MOVEMENT_STOP_TOL = 1e-6;
  var HYBRID_AVG_MOVEMENT_STOP_TOL = 2e-7;
  var HYBRID_MAX_ITERS = 180;
  var HYBRID_FACE_WARM_START_ITERS = 20;
  var HYBRID_FACE_WARM_FACE_BARRIER_WEIGHT = 0.2;
  var HYBRID_FACE_WARM_EDGE_BARRIER_WEIGHT = 0.05;
  var HYBRID_FACE_WARM_EDGE_UNIFORM_WEIGHT = 0.02;
  var HYBRID_FACE_WARM_STABLE_ITER_LIMIT = 6;
  var HYBRID_FACE_WARM_MAX_POSITION_STEP_RATIO = 0.02;
  var HYBRID_ANGLE_STAGE_MAX_POSITION_STEP_RATIO = 0.01;
  var HYBRID_ALIGN_MAX_PASSES = 3;
  
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

  function buildHybridData(input) {
    var augmentedEdgePairs = input.augmentedEdgePairs;
    var augmentedEmbedding = input.augmentedEmbedding;
    var outerFace = input.outerFace;
    var initPos = input.initPos;
    var objectiveGraph = input.objectiveGraph;
    var baseEmbedding = input.baseEmbedding;
    var angleBarrierWeight = Number.isFinite(input.angleBarrierWeight) ? input.angleBarrierWeight : HYBRID_ANGLE_BARRIER_WEIGHT;
    var faceBarrierWeight = Number.isFinite(input.faceBarrierWeight) ? input.faceBarrierWeight : HYBRID_FACE_BARRIER_WEIGHT;
    var faceWeight = Number.isFinite(input.faceWeight) ? input.faceWeight : HYBRID_FACE_WEIGHT;
    var angleWeight = Number.isFinite(input.angleWeight) ? input.angleWeight : HYBRID_ANGLE_WEIGHT;
    var horizontalityWeight = Number.isFinite(input.horizontalityWeight) ? input.horizontalityWeight : 0;
    var edgeBarrierWeight = Number.isFinite(input.edgeBarrierWeight) ? input.edgeBarrierWeight : HYBRID_EDGE_BARRIER_WEIGHT;
    var edgeUniformWeight = Number.isFinite(input.edgeUniformWeight) ? input.edgeUniformWeight : HYBRID_EDGE_UNIFORM_WEIGHT;
    var augIds = augmentedEmbedding.idByIndex.map(String);
    var augIndexById = {};
    var i;
    for (i = 0; i < augIds.length; i += 1) augIndexById[augIds[i]] = i;

    var x0 = new Array(augIds.length);
    var y0 = new Array(augIds.length);
    for (i = 0; i < augIds.length; i += 1) {
      var p = initPos[augIds[i]];
      x0[i] = p ? p.x : 0;
      y0[i] = p ? p.y : 0;
    }

    var edges = [];
    var edgeScaleSum = 0;
    var edgeScaleCount = 0;
    var initialMinEdgeLength2 = Infinity;
    var outerKey = faceKey(outerFace);
    var boundedFaceKeys = [];
    var boundedFaces = [];
    var initialFaceMinArea = Infinity;
    var initialFaceAreaSum = 0;
    var initialFaceCount = 0;
    for (i = 0; i < augmentedEdgePairs.length; i += 1) {
      var u = augIndexById[String(augmentedEdgePairs[i][0])];
      var v = augIndexById[String(augmentedEdgePairs[i][1])];
      if (u === undefined || v === undefined || u === v) continue;
      edges.push([u, v]);
      var dx0 = x0[u] - x0[v];
      var dy0 = y0[u] - y0[v];
      var len20 = dx0 * dx0 + dy0 * dy0;
      if (len20 > 1e-12) {
        edgeScaleSum += len20;
        edgeScaleCount += 1;
        if (len20 < initialMinEdgeLength2) initialMinEdgeLength2 = len20;
      }
    }
    for (i = 0; i < augmentedEmbedding.faces.length; i += 1) {
      var orientedFace = orientFaceCCW(augmentedEmbedding.faces[i], initPos);
      var faceK = faceKey(orientedFace);
      if (faceK === outerKey) continue;
      if (!orientedFace || orientedFace.length < 3) {
        return buildLayoutError({ reason: 'Hybrid requires a valid triangulated augmentation' });
      }
      if (orientedFace.length !== 3) {
        return buildLayoutError({ reason: 'Hybrid requires all non-outer augmented faces to be triangles' });
      }
      boundedFaceKeys.push(faceK);
      var boundedFace = orientedFace.map(function (id) { return augIndexById[String(id)]; });
      boundedFaces.push(boundedFace);
      var boundedArea = Math.abs(polygonArea2(orientedFace, initPos)) / 2;
      if (boundedArea > 1e-12) {
        if (boundedArea < initialFaceMinArea) initialFaceMinArea = boundedArea;
        initialFaceAreaSum += boundedArea;
        initialFaceCount += 1;
      }
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

    var objectiveVertexIds = [];
    var wedgeStart = [];
    var wedgeCount = [];
    var wedges = [];
    var objectiveEdges = [];
    var objectiveEdgeWeights = [];
    var objectiveEdgeWeightSum = 0;
    var initialMinAngleRatio = Infinity;
    var initialMaxAngleResidual = 0;
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
      objectiveNeighbors = chooseCCWNeighborOrder(centerAugIdx, objectiveNeighbors, x0, y0);
      var targetAngle = TWO_PI / objectiveNeighbors.length;
      wedgeStart.push(wedges.length);
      wedgeCount.push(objectiveNeighbors.length);
      objectiveVertexIds.push(centerId);
      for (k = 0; k < objectiveNeighbors.length; k += 1) {
        var leftAugIdx = objectiveNeighbors[k];
        var rightAugIdx = objectiveNeighbors[(k + 1) % objectiveNeighbors.length];
        wedges.push([centerAugIdx, leftAugIdx, rightAugIdx, targetAngle, objectiveVertexIds.length - 1]);
        var leftAngle = Math.atan2(y0[leftAugIdx] - y0[centerAugIdx], x0[leftAugIdx] - x0[centerAugIdx]);
        var rightAngle = Math.atan2(y0[rightAugIdx] - y0[centerAugIdx], x0[rightAugIdx] - x0[centerAugIdx]);
        var initialAngle = computePositiveTurn(leftAngle, rightAngle);
        var initialRatio = initialAngle / targetAngle;
        if (initialRatio < initialMinAngleRatio) initialMinAngleRatio = initialRatio;
        var initialResidual = Math.abs(initialRatio - 1);
        if (initialResidual > initialMaxAngleResidual) initialMaxAngleResidual = initialResidual;
      }
    }

    for (i = 0; i < objectiveGraph.edgePairs.length; i += 1) {
      var edgePair = objectiveGraph.edgePairs[i];
      var edgeU = augIndexById[String(edgePair[0])];
      var edgeV = augIndexById[String(edgePair[1])];
      if (edgeU === undefined || edgeV === undefined || edgeU === edgeV) continue;
      objectiveEdges.push([edgeU, edgeV]);
      var objectiveEdgeWeight = 1;
      objectiveEdgeWeights.push(objectiveEdgeWeight);
      objectiveEdgeWeightSum += objectiveEdgeWeight;
    }

    return buildLayoutResult({
      ok: true,
      augIds: augIds,
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
      objectiveVertexIds: objectiveVertexIds,
      wedgeStart: wedgeStart,
      wedgeCount: wedgeCount,
      wedges: wedges,
      objectiveEdges: objectiveEdges,
      objectiveEdgeWeights: objectiveEdgeWeights,
      objectiveEdgeWeightSum: objectiveEdgeWeightSum,
      areaTol: HYBRID_AREA_TOL,
      angleTol: HYBRID_ANGLE_TOL,
      angleBarrierWeight: angleBarrierWeight,
      faceBarrierWeight: faceBarrierWeight,
      horizontalityWeight: horizontalityWeight,
      edgeBarrierWeight: edgeBarrierWeight,
      edgeUniformWeight: edgeUniformWeight,
      edgeBarrierScale2: edgeScaleCount > 0 ? (edgeScaleSum / edgeScaleCount) : 1,
      initialMinEdgeLength2: Number.isFinite(initialMinEdgeLength2) ? initialMinEdgeLength2 : 0,
      initialAvgFaceArea: initialFaceCount > 0 ? (initialFaceAreaSum / initialFaceCount) : 1,
      initialMinFaceArea: Number.isFinite(initialFaceMinArea) ? initialFaceMinArea : 0,
      initialMinAngleRatio: Number.isFinite(initialMinAngleRatio) ? initialMinAngleRatio : 0,
      initialMaxAngleResidual: initialMaxAngleResidual,
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
            reason: 'Hybrid initialization requires positive Tutte weights',
            vertexId: vertexId,
            neighborId: neighborId
          });
        }
        rowWeights[k] = rowWeight;
        rowWeightSum += rowWeight;
      }
      if (!(rowWeightSum > 0)) {
        return buildLayoutError({
          reason: 'Hybrid initialization requires positive Tutte row weight sum',
          vertexId: vertexId
        });
      }
      for (k = 0; k < neighbors.length; k += 1) {
        q0[rowOffset + k] = Math.log(rowWeights[k] / rowWeightSum);
      }
    }
    return buildLayoutResult({ ok: true, q0: q0 });
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
      var ordered = chooseCCWNeighborOrder(augIdx, neighbors, x, y);
      var vectors = new Array(ordered.length);
      var angles = new Array(ordered.length);
      for (var k = 0; k < ordered.length; k += 1) {
        var neighborAugIdx = ordered[k];
        var vx = x[neighborAugIdx] - x[augIdx];
        var vy = y[neighborAugIdx] - y[augIdx];
        var len = Math.hypot(vx, vy);
        if (!(len > 1e-12)) {
          return buildLayoutError({ reason: 'Hybrid warm start requires positive edge lengths' });
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
          return buildLayoutError({ reason: 'Hybrid warm start requires strictly positive neighbor wedges' });
        }
        angles[k] = theta;
      }

      var weightByNeighbor = {};
      var rowWeightSum = 0;
      for (k = 0; k < ordered.length; k += 1) {
        var prev = (k + ordered.length - 1) % ordered.length;
        var weight = (Math.tan(angles[prev] / 2) + Math.tan(angles[k] / 2)) / vectors[k].len;
        if (!(weight > 0) || !Number.isFinite(weight)) {
          return buildLayoutError({ reason: 'Hybrid warm start requires positive mean-value weights' });
        }
        weightByNeighbor[ordered[k]] = weight;
        rowWeightSum += weight;
      }
      if (!(rowWeightSum > 0)) {
        return buildLayoutError({ reason: 'Hybrid warm start requires positive row weight sum' });
      }
      for (k = 0; k < neighbors.length; k += 1) {
        var neighborWeight = weightByNeighbor[neighbors[k]];
        if (!(neighborWeight > 0)) {
          return buildLayoutError({ reason: 'Hybrid warm start could not map neighbor weights' });
        }
        q0[rowOffset + k] = Math.log(neighborWeight / rowWeightSum);
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
    var angle = Metrics.computeUniformAngleResolutionScore(graph, posById);
    return {
      angleResolutionScore: angle && angle.ok ? angle.score : null,
      angleCount: angle && angle.ok ? angle.angleCount : null
    };
  }

  function computeFaceStats(graph, embedding, posById) {
    var face = Metrics.computeUniformFaceAreaScore(graph.nodeIds, graph.edgePairs, posById, embedding);
    return {
      faceAreaScore: face && face.ok ? face.quality : null
    };
  }

  function computeHybridTradeoffScore(faceAreaScore, angleResolutionScore) {
    if (!(Number.isFinite(faceAreaScore) && faceAreaScore >= 0 &&
          Number.isFinite(angleResolutionScore) && angleResolutionScore >= 0)) {
      return -Infinity;
    }
    return Math.sqrt(faceAreaScore * angleResolutionScore);
  }

  function copyPositionMap(posById) {
    var out = {};
    var ids = Object.keys(posById || {});
    for (var i = 0; i < ids.length; i += 1) {
      var id = ids[i];
      var p = posById[id];
      if (!p) continue;
      out[id] = { x: p.x, y: p.y };
    }
    return out;
  }

  function computeHybridStageMetrics(graph, embedding, posById) {
    var positions = GeometryUtils.filterPositionMap(posById || {}, graph.nodeIds);
    var angleStats = computeAngleStats(graph, positions);
    var faceStats = computeFaceStats(graph, embedding, positions);
    return {
      positions: positions,
      angleResolutionScore: angleStats.angleResolutionScore,
      angleCount: angleStats.angleCount,
      faceAreaScore: faceStats.faceAreaScore,
      tradeoffScore: computeHybridTradeoffScore(faceStats.faceAreaScore, angleStats.angleResolutionScore)
    };
  }

  function applyHybridAxisAlignment(graph, posById, maxPasses) {
    if (!Alignment || typeof Alignment.alignToAxisGreedy !== 'function') {
      return buildLayoutResult({
        ok: true,
        changed: false,
        passes: 0,
        positions: copyPositionMap(posById),
        results: []
      });
    }
    var limit = Number.isFinite(maxPasses) ? Math.max(1, Math.floor(maxPasses)) : 1;
    var working = copyPositionMap(posById);
    var results = [];
    var changedAny = false;
    for (var pass = 0; pass < limit; pass += 1) {
      var result = Alignment.alignToAxisGreedy(graph.nodeIds, graph.edgePairs, working);
      if (!result || !result.ok) {
        return buildLayoutError({
          reason: result && result.reason ? result.reason : 'Hybrid axis-align failed'
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
      ok: true,
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
      return buildLayoutError({ reason: 'Hybrid requires at least one valid objective angle' });
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

  function evaluateHorizontalityObjectiveTerms(data, x, y, zX, zY) {
    if (!(data.objectiveEdges && data.objectiveEdges.length > 0) ||
        !(data.objectiveEdgeWeightSum > 0)) {
      return buildLayoutResult({
        ok: true,
        horizontalityObjectiveTerm: 0
      });
    }

    var eps2 = Math.max(1e-24, data.areaTol);
    var horizontalityObjectiveTerm = 0;
    for (var i = 0; i < data.objectiveEdges.length; i += 1) {
      var edge = data.objectiveEdges[i];
      var u = edge[0];
      var v = edge[1];
      var dx = x[v] - x[u];
      var dy = y[v] - y[u];
      var absDy = Math.sqrt(dy * dy + eps2);
      var len2 = dx * dx + dy * dy + eps2;
      var len = Math.sqrt(len2);
      var weight = data.objectiveEdgeWeights[i] / data.objectiveEdgeWeightSum;
      var penalty = absDy / len;
      var gradDx = -absDy * dx / (len2 * len);
      var gradDy = (dy / (absDy * len)) - (absDy * dy / (len2 * len));
      horizontalityObjectiveTerm += weight * penalty;
      addPointGradient(data, u, -weight * gradDx, -weight * gradDy, zX, zY);
      addPointGradient(data, v, weight * gradDx, weight * gradDy, zX, zY);
    }

    return buildLayoutResult({
      ok: true,
      horizontalityObjectiveTerm: horizontalityObjectiveTerm
    });
  }

  function evaluateHybridAngleStageObjectiveAndGradient(q, data) {
    var triangleSlack = Math.max(data.areaTol, 1e-12);
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
    if (!factor) return buildLayoutError({ reason: 'Hybrid angle stage linear solve failed' });
    var primal = solveLUWithTwoRhs(factor, bx, by);
    if (!primal) return buildLayoutError({ reason: 'Hybrid angle stage linear solve failed' });

    var x = data.x0.slice();
    var y = data.y0.slice();
    for (i = 0; i < nI; i += 1) {
      var aug = data.interiorAugIndices[i];
      x[aug] = primal.x1[i];
      y[aug] = primal.x2[i];
    }
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
    var getPoint = getIndexedPoint(x, y);
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
      var faceBarrierTerm = 0;
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
    if (!adjoint) return buildLayoutError({ reason: 'Hybrid angle stage adjoint solve failed' });

    var gradVec = createZeroVector(data.qSize);
    for (i = 0; i < nI; i += 1) {
      var rowOffset = data.rowStart[i];
      var meanx = 0;
      var meany = 0;
      neighbors = data.neighborAugIndices[i];
      for (k = 0; k < neighbors.length; k += 1) {
        w = lambda[rowOffset + k];
        augIdx = neighbors[k];
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

  function evaluateHybridObjectiveAndGradient(q, data) {
    var triangleSlack = Math.max(data.areaTol, 1e-12);
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
    if (!factor) return buildLayoutError({ reason: 'Hybrid linear solve failed' });
    var primal = solveLUWithTwoRhs(factor, bx, by);
    if (!primal) return buildLayoutError({ reason: 'Hybrid linear solve failed' });

    var x = data.x0.slice();
    var y = data.y0.slice();
    for (i = 0; i < nI; i += 1) {
      var aug = data.interiorAugIndices[i];
      x[aug] = primal.x1[i];
      y[aug] = primal.x2[i];
    }
    var faceAreas = createZeroVector(data.boundedFaceKeys.length);
    var totalArea = 0;
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
      totalArea += faceAreas[i];
    }
    var getPoint = getIndexedPoint(x, y);
    for (i = 0; i < data.boundedFaces.length; i += 1) {
      var boundary = data.boundedFaces[i];
      if (polygonHasSelfIntersection(boundary, getPoint, 1e-9)) {
        return buildLayoutError({ reason: 'invalid-face-step' });
      }
      if (!(polygonArea2FromArrays(boundary, x, y) > 2 * data.areaTol)) {
        return buildLayoutError({ reason: 'invalid-face-step' });
      }
    }
    if (faceAreas.length === 0 || !(totalArea > 1e-12)) {
      return buildLayoutError({ reason: 'Hybrid total bounded area is not positive' });
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
      angleEval = buildLayoutResult({
        ok: true,
        maxAngleResidual: null,
        minAngleRatio: null,
        worstWedge: null,
        angleObjectiveTerm: 0
      });
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
      for (i = 0; i < data.triangles.length; i += 1) {
        tri = data.triangles[i];
        a = tri[0];
        b = tri[1];
        c = tri[2];
        var faceIdx = tri[3];
        var coeff = 0;
        if (faceWeight > 0) {
          coeff += faceWeight * faceScale * (2 * residual[faceIdx] / targetArea);
        }
        if (data.faceBarrierWeight > 0) {
          coeff -= faceWeight * faceScale * data.faceBarrierWeight / faceAreas[faceIdx];
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
    if (!adjoint) return buildLayoutError({ reason: 'Hybrid adjoint solve failed' });

    var gradVec = createZeroVector(data.qSize);
    for (i = 0; i < nI; i += 1) {
      var rowOffset = data.rowStart[i];
      var meanx = 0;
      var meany = 0;
      neighbors = data.neighborAugIndices[i];
      for (k = 0; k < neighbors.length; k += 1) {
        w = lambda[rowOffset + k];
        augIdx = neighbors[k];
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
      faceAreas: faceAreas,
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

  async function runHybridOptimization(q0, data, opts) {
    var maxIters = opts.maxIters;
    var maxPositionStep = opts.maxPositionStep;
    var evaluate = typeof opts.evaluate === 'function' ? opts.evaluate : evaluateHybridObjectiveAndGradient;
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
      if (current.gradNorm <= HYBRID_GRAD_TOL) {
        stopReason = 'grad-converged';
        break;
      }

      var prevX = current.x;
      var prevY = current.y;
      var d = lbfgsDirection(current.gradVec, S, Y, Rho);
      if (!(vecDot(current.gradVec, d) < 0)) d = vecScale(current.gradVec, -1);
      var directionNorm = vecNorm(d);
      if (directionNorm > HYBRID_MAX_STEP_NORM) {
        d = vecScale(d, HYBRID_MAX_STEP_NORM / directionNorm);
      }

      var gtd = vecDot(current.gradVec, d);
      var accepted = null;
      var lineSearchAttempt;
      for (lineSearchAttempt = 0; lineSearchAttempt < 2 && !accepted; lineSearchAttempt += 1) {
        var searchDir = d;
        if (lineSearchAttempt === 1) {
          searchDir = vecScale(current.gradVec, -1);
          directionNorm = vecNorm(searchDir);
          if (directionNorm > HYBRID_MAX_STEP_NORM) {
            searchDir = vecScale(searchDir, HYBRID_MAX_STEP_NORM / directionNorm);
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
              alpha *= HYBRID_LINE_SEARCH_TAU;
              continue;
            }
          }
          if (trial.ok && trial.E <= current.E + HYBRID_LINE_SEARCH_C1 * alpha * gtd) {
            accepted = { q: qTrial, eval: trial };
            break;
          }
          alpha *= HYBRID_LINE_SEARCH_TAU;
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
      if (stepNorm < HYBRID_STEP_TOL) {
        stopReason = 'step-converged';
        break;
      }

      var ys = vecDot(y, s);
      if (ys > 1e-14) {
        if (S.length === HYBRID_LBFGS_MEMORY) {
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
      q: bestQ,
      positions: buildPositionMap(data, best.x, best.y),
      E: best.E,
      gradNorm: best.gradNorm,
      faceAreas: best.faceAreas,
      maxRelError: best.maxRelError,
      maxAngleResidual: best.maxAngleResidual,
      minAngleRatio: best.minAngleRatio,
      worstWedge: best.worstWedge || null,
      stopReason: stopReason,
      iters: completedIters
    });
  }

  async function runAngleStageOptimization(q0, data, opts) {
    return runHybridOptimization(q0, data, Object.assign({}, opts, {
      evaluate: evaluateHybridAngleStageObjectiveAndGradient
    }));
  }

  async function runHybridFaceOptimization(q0, data, opts) {
    return runHybridOptimization(q0, data, Object.assign({}, opts, {
      evaluate: evaluateHybridObjectiveAndGradient
    }));
  }

  function createStageTracker(scale, minItersBeforeStop, stableIterLimit) {
    return global.GraphUtils.createMovementConvergenceTracker({
      minItersBeforeStop: minItersBeforeStop,
      stableIterLimit: stableIterLimit,
      maxMoveTol: HYBRID_MOVEMENT_STOP_TOL * scale,
      avgMoveTol: HYBRID_AVG_MOVEMENT_STOP_TOL * scale
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

  function buildHybridStageData(augmented, outerFace, initPos, objectiveGraph, baseEmbedding, overrides) {
    return buildHybridData(Object.assign({
      augmentedEdgePairs: augmented.graph.edgePairs,
      augmentedEmbedding: augmented.embedding,
      outerFace: outerFace,
      initPos: initPos,
      objectiveGraph: objectiveGraph,
      baseEmbedding: baseEmbedding
    }, overrides || {}));
  }

  function buildStageSeedFromPositions(data, positions, tutteWeights) {
    var q0Result = buildInitialLogitSeedFromPositions(data, positions);
    if (!q0Result.ok) {
      q0Result = buildInitialLogitSeed(data, tutteWeights);
    }
    return q0Result;
  }

  async function runStageOptimization(runFn, q0, data, positionNodeIds, initPos, config) {
    var scale = GeometryUtils.computeDrawingDiameter(positionNodeIds, initPos);
    var tracker = createStageTracker(scale, config.minItersBeforeStop, config.stableIterLimit);
    return runFn(q0, data, {
      maxIters: config.maxIters,
      maxPositionStep: config.maxPositionStepRatio * scale,
      movementTracker: tracker,
      onIteration: config.onIteration || null
    });
  }

  async function runHybridStage(config) {
    var data = buildHybridStageData(
      config.augmented,
      config.outerFace,
      config.initPos,
      config.objectiveGraph,
      config.baseEmbedding,
      config.dataOverrides
    );
    if (!data || !data.ok) {
      return buildLayoutError({ reason: data && data.reason || 'Hybrid setup failed' });
    }
    if (typeof config.prepareData === 'function') {
      config.prepareData(data);
    }
    if (typeof config.skipData === 'function' && config.skipData(data)) {
      return buildLayoutResult({
        ok: true,
        data: data,
        q0: null,
        result: null
      });
    }
    if (typeof config.requireData === 'function' && !config.requireData(data)) {
      return null;
    }
    var q0Result = config.buildSeed(data);
    if (!q0Result || !q0Result.ok) {
      return q0Result || buildLayoutError({ reason: 'Hybrid initialization failed' });
    }
    var q0 = q0Result.q0;
    relaxMinFaceArea(data, q0, config.evaluate);
    var result = await runStageOptimization(
      config.run,
      q0,
      data,
      config.augmented.graph.nodeIds,
      config.initPos,
      {
        maxIters: config.maxIters,
        maxPositionStepRatio: config.maxPositionStepRatio,
        minItersBeforeStop: config.minItersBeforeStop,
        stableIterLimit: config.stableIterLimit,
        onIteration: config.onIteration || null
      }
    );
    return buildLayoutResult({
      ok: true,
      data: data,
      q0: q0,
      result: result
    });
  }

  async function computeHybridPositions(graph, options) {
    options = options || {};
    var augmentationMethod = options.augmentationMethod === undefined ? null : options.augmentationMethod;
    var augmentationOptions = typeof options.augmentationOptions === 'object' && options.augmentationOptions
      ? Object.assign({}, options.augmentationOptions)
      : null;
    var onIteration = options.onIteration || null;
    var context = LayoutPreprocessing.reusePreparedLayoutData(graph, {
      preparedSeed: options.preparedSeed,
      augmentationMethod: augmentationMethod
    });
    if (!context) {
      context = LayoutPreprocessing.prepareGraphAndLayoutData(graph, {
        failureLabel: 'Hybrid layout',
        augmentationMethod: augmentationMethod,
        augmentationOptions: augmentationOptions,
        currentPositions: options.currentPositions
      });
    }
    if (!context || !context.ok) {
      return buildLayoutError(context || { message: 'Hybrid setup failed' });
    }

    var g = context.graph;
    var outerFace = context.augmentedOuterFace || context.outerFace;
    var augmented = context.augmented;
    var initPos = context.posById;
    var baseEmbedding = context.baseEmbedding;
    var tutteWeights = PlanarVibeTutte.buildTutteWeights(g, context.augmentedGraph);
    var warmStartPositions = initPos;
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
      var tradeoffScore = computeHybridTradeoffScore(faceStats.faceAreaScore, angleStats.angleResolutionScore);
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
      var metrics = computeHybridStageMetrics(g, baseEmbedding, positions);
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

    if (HYBRID_FACE_WARM_START_ITERS > 0) {
      var faceWarmSetup = await runHybridStage({
        augmented: augmented,
        outerFace: outerFace,
        initPos: initPos,
        objectiveGraph: g,
        baseEmbedding: baseEmbedding,
        dataOverrides: {
          faceBarrierWeight: HYBRID_FACE_WARM_FACE_BARRIER_WEIGHT,
          edgeBarrierWeight: HYBRID_FACE_WARM_EDGE_BARRIER_WEIGHT,
          edgeUniformWeight: HYBRID_FACE_WARM_EDGE_UNIFORM_WEIGHT,
          faceWeight: 1.0,
          angleWeight: 0
        },
        prepareData: function (data) {
          data.minFaceArea = Math.max(0, 0.25 * data.initialMinFaceArea);
        },
        requireData: function (data) {
          return data.boundedFaceKeys.length > 0;
        },
        buildSeed: function (data) {
          return buildLayoutResult({ ok: true, q0: createZeroVector(data.qSize) });
        },
        evaluate: evaluateHybridObjectiveAndGradient,
        run: runHybridFaceOptimization,
        maxIters: HYBRID_FACE_WARM_START_ITERS,
        maxPositionStepRatio: HYBRID_FACE_WARM_MAX_POSITION_STEP_RATIO,
        minItersBeforeStop: Math.max(10, Math.min(HYBRID_FACE_WARM_START_ITERS, 20)),
        stableIterLimit: HYBRID_FACE_WARM_STABLE_ITER_LIMIT,
        onIteration: async function (progress) {
          await emitStageProgress('face-warm', 'face', 1, progress);
        }
      });
      if (faceWarmSetup && faceWarmSetup.ok &&
          faceWarmSetup.result && faceWarmSetup.result.ok &&
          faceWarmSetup.result.positions) {
        warmStartPositions = faceWarmSetup.result.positions;
      }
    }

    var angleSetup = await runHybridStage({
      augmented: augmented,
      outerFace: outerFace,
      initPos: warmStartPositions,
      objectiveGraph: g,
      baseEmbedding: baseEmbedding,
      dataOverrides: {
        angleBarrierWeight: HYBRID_ANGLE_BARRIER_WEIGHT,
        faceBarrierWeight: HYBRID_FACE_BARRIER_WEIGHT,
        faceWeight: 0,
        angleWeight: 1.0,
        horizontalityWeight: HYBRID_HORIZONTALITY_WEIGHT
      },
      prepareData: function (data) {
        data.minFaceArea = Math.max(0, 0.2 * data.initialMinFaceArea);
        if (!(data.objectiveVertexIds.length > 0) || !(data.wedges.length > 0)) {
          data.angleWeight = 0;
        }
      },
      skipData: function (data) {
        return !(data.boundedFaceKeys.length > 0);
      },
      buildSeed: function (data) {
        return buildStageSeedFromPositions(data, warmStartPositions, tutteWeights);
      },
      evaluate: evaluateHybridAngleStageObjectiveAndGradient,
      run: runAngleStageOptimization,
      maxIters: HYBRID_MAX_ITERS,
      maxPositionStepRatio: HYBRID_ANGLE_STAGE_MAX_POSITION_STEP_RATIO,
      minItersBeforeStop: Math.max(20, Math.min(HYBRID_MAX_ITERS, 40)),
      stableIterLimit: HYBRID_STABLE_ITER_LIMIT,
      onIteration: async function (progress) {
        await emitStageProgress('angle', 'angle', 2, progress);
      }
    });
    if (!angleSetup || !angleSetup.ok || !angleSetup.data) {
      return buildLayoutError({
        message: angleSetup && (angleSetup.reason || angleSetup.message) || 'Hybrid setup failed',
        graph: g,
        outerFace: outerFace,
        augmented: augmented
      });
    }
    var angleData = angleSetup.data;
    if (!(angleData.boundedFaceKeys.length > 0)) {
      var staticMetrics = computeHybridStageMetrics(g, baseEmbedding, initPos);
      return buildLayoutResult({
        ok: true,
        nodeIds: g.nodeIds,
        edgePairs: g.edgePairs,
        outerFace: context.outerFace,
        graph: g,
        augmented: augmented,
        positions: staticMetrics.positions,
        debugPositions: initPos,
        stopReason: 'no-bounded-faces',
        iters: 0,
        objective: 0,
        angleResolutionScore: staticMetrics.angleResolutionScore,
        angleCount: staticMetrics.angleCount,
        faceAreaScore: staticMetrics.faceAreaScore,
        tradeoffScore: staticMetrics.tradeoffScore
      });
    }
    var angleResult = angleSetup.result;
    if (!angleResult || !angleResult.ok) {
      return buildLayoutError({
        message: angleResult && (angleResult.reason || angleResult.message) || 'Hybrid optimization failed',
        graph: g,
        outerFace: outerFace,
        augmented: augmented
      });
    }

    var finalPositions = filteredOriginalPositions(angleResult.positions || {});
    if (hasPositionCrossings(finalPositions, g.edgePairs)) {
      return buildLayoutError({
        stopReason: angleResult.stopReason,
        graph: g,
        outerFace: context.outerFace,
        augmented: augmented,
        message: 'Hybrid produced a non-plane drawing'
      });
    }
    var alignStage = applyHybridAxisAlignment(g, finalPositions, HYBRID_ALIGN_MAX_PASSES);
    if (!alignStage.ok) {
      return buildLayoutError({
        message: alignStage.reason || alignStage.message || 'Hybrid axis-align failed',
        graph: g,
        outerFace: context.outerFace,
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

    var finalMetrics = computeHybridStageMetrics(g, baseEmbedding, finalPositions);
    return buildLayoutResult({
      ok: true,
      nodeIds: g.nodeIds,
      edgePairs: g.edgePairs,
      outerFace: context.outerFace,
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

  async function applyHybridLayout(cy, options) {
    return CyRuntime.runLayout(cy, options, {
      useSharedPreparedSeed: true,
      sharedSeedFailureLabel: 'Hybrid layout',
      compute: computeHybridPositions,
      buildResult: function (ctx) {
        var result = ctx.result;
        var message = buildLayoutStatusMessage('Hybrid', {
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
      failureMessage: 'Hybrid failed'
    });
  }

  global.PlanarVibeHybrid = {
    computeHybridPositions: computeHybridPositions,
    applyHybridLayout: applyHybridLayout
  };
})(window);
