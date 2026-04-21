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
  var filterPositions = GeometryUtils.filterPositionMap;
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
  var EDGE_CONFIG = {
    areaTol: 1e-15,
    augmentedEdgeWeight: 0.25,
    faceBarrierWeight: 0.02,
    rangeWeight: 0.05,
    rangeBeta: 6,
    logAbsWeight: 0.5,
    logAbsEpsilon: 0.25,
    minFaceAreaFactor: 0.2,
    maxIters: 80,
    gradTol: 1e-5,
    stepTol: 1e-10,
    lbfgsMemory: 10,
    maxStepNorm: 2.0,
    maxPositionStepRatio: 0.1,
    lineSearchC1: 1e-4,
    lineSearchTau: 0.5,
    minItersBeforeStop: 40,
    stableIterLimit: 8,
    movementStopTol: 1e-6,
    avgMovementStopTol: 2e-7
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

  function buildEdgeBalancerData(input) {
    var augmentedEdgePairs = input.augmentedEdgePairs;
    var augmentedEmbedding = input.augmentedEmbedding;
    var outerFace = input.outerFace;
    var outerPos = input.outerPos || {};
    var objectiveEdgePairs = input.objectiveEdgePairs;
    var augmentedEdgeWeight = input.augmentedEdgeWeight;
    var augIds = augmentedEmbedding.idByIndex.map(String);
    var augIndexById = {};
    var i;
    for (i = 0; i < augIds.length; i += 1) augIndexById[augIds[i]] = i;

    var originalEdgeSet = {};
    for (i = 0; i < objectiveEdgePairs.length; i += 1) {
      originalEdgeSet[edgeKey(objectiveEdgePairs[i][0], objectiveEdgePairs[i][1])] = true;
    }

    var x0 = new Array(augIds.length);
    var y0 = new Array(augIds.length);
    for (i = 0; i < augIds.length; i += 1) {
      var p = outerPos[augIds[i]];
      x0[i] = p ? p.x : 0;
      y0[i] = p ? p.y : 0;
    }

    var edges = [];
    for (i = 0; i < augmentedEdgePairs.length; i += 1) {
      var sourceU = String(augmentedEdgePairs[i][0]);
      var sourceV = String(augmentedEdgePairs[i][1]);
      var u = augIndexById[String(augmentedEdgePairs[i][0])];
      var v = augIndexById[String(augmentedEdgePairs[i][1])];
      if (u === undefined || v === undefined || u === v) continue;
      var barrierWeight = originalEdgeSet[edgeKey(sourceU, sourceV)] ? 1 : augmentedEdgeWeight;
      edges.push([u, v, barrierWeight]);
    }

    var objectiveEdges = [];
    for (i = 0; i < objectiveEdgePairs.length; i += 1) {
      u = augIndexById[String(objectiveEdgePairs[i][0])];
      v = augIndexById[String(objectiveEdgePairs[i][1])];
      if (u === undefined || v === undefined || u === v) continue;
      objectiveEdges.push([u, v]);
    }

    var outerKey = faceKey(outerFace);
    var boundedFaceKeys = [];
    var boundedFaces = [];
    for (i = 0; i < augmentedEmbedding.faces.length; i += 1) {
      var rawFace = Array.isArray(augmentedEmbedding.faces[i])
        ? augmentedEmbedding.faces[i].slice().map(String)
        : [];
      var faceK = faceKey(rawFace);
      if (faceK === outerKey) continue;
      if (!rawFace || rawFace.length < 3) {
        return buildLayoutError({ reason: 'EdgeBalancer requires a valid triangulated augmentation' });
      }
      if (rawFace.length !== 3) {
        return buildLayoutError({ reason: 'EdgeBalancer requires all non-outer augmented faces to be triangles' });
      }
      boundedFaceKeys.push(faceK);
      var boundedFace = rawFace.map(function (id) { return augIndexById[String(id)]; });
      boundedFaces.push(boundedFace);
    }

    var triangles = [];
    for (i = 0; i < boundedFaces.length; i += 1) {
      var triFace = boundedFaces[i];
      triangles.push([
        triFace[0],
        triFace[1],
        triFace[2],
        i
      ]);
    }

    var outerMask = new Array(augIds.length);
    for (i = 0; i < outerMask.length; i += 1) outerMask[i] = false;
    for (i = 0; i < outerFace.length; i += 1) {
      var outerIdx = augIndexById[String(outerFace[i])];
      outerMask[outerIdx] = true;
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
      objectiveEdges: objectiveEdges,
      areaTol: Math.max(0, input.areaTol),
      faceBarrierWeight: Math.max(0, input.faceBarrierWeight),
      rangeWeight: Math.max(0, input.rangeWeight),
      rangeBeta: input.rangeBeta,
      logAbsWeight: Math.max(0, input.logAbsWeight),
      logAbsEpsilon: Math.max(0, input.logAbsEpsilon),
      augmentedEdgeWeight: augmentedEdgeWeight,
      edgeBarrierScale2: 1,
      initialMinEdgeLength2: 0,
      initialObjectiveMinEdgeLength2: 0,
      initialAvgFaceArea: 1,
      initialMinFaceArea: 0,
      minFaceArea: Math.max(0, input.minFaceArea)
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
            reason: 'EdgeBalancer initialization requires positive Tutte weights',
            vertexId: vertexId,
            neighborId: neighborId
          });
        }
        rowWeights[k] = rowWeight;
        rowWeightSum += rowWeight;
      }
      if (!(rowWeightSum > 0)) {
        return buildLayoutError({
          reason: 'EdgeBalancer initialization requires positive Tutte row weight sum',
          vertexId: vertexId
        });
      }
      for (k = 0; k < neighbors.length; k += 1) {
        q0[rowOffset + k] = Math.log(rowWeights[k] / rowWeightSum);
      }
    }
    return buildLayoutResult({ ok: true, q0: q0 });
  }

  function computeInteriorMoveStats(data, prevX, prevY, nextX, nextY) {
    return computeMoveStats(data.interiorAugIndices, function (idx) {
      return Math.hypot(nextX[idx] - prevX[idx], nextY[idx] - prevY[idx]);
    }, { moveTol: 1e-9 });
  }

  function addObjectiveEdgeGradient(data, edge, coeff, dx, dy, zX, zY) {
    var u = edge[0];
    var v = edge[1];
    var iu = data.interiorIndexByAug[u];
    var iv = data.interiorIndexByAug[v];
    if (iu >= 0) {
      zX[iu] += coeff * dx;
      zY[iu] += coeff * dy;
    }
    if (iv >= 0) {
      zX[iv] -= coeff * dx;
      zY[iv] -= coeff * dy;
    }
  }

  function evaluateObjectiveEdgeTerms(data, objectiveEdges, x, y, edgeTol2, zX, zY) {
    var m = objectiveEdges.length;
    var len2 = new Array(m);
    var lengths = new Array(m);
    var dxArr = new Array(m);
    var dyArr = new Array(m);
    var logLen2 = new Array(m);
    var logMean = 0;
    var lengthSum = 0;
    var i;

    for (i = 0; i < m; i += 1) {
      var edge = objectiveEdges[i];
      var u = edge[0];
      var v = edge[1];
      var dx = x[u] - x[v];
      var dy = y[u] - y[v];
      var currentLen2 = dx * dx + dy * dy;
      if (!(currentLen2 > edgeTol2)) {
        return buildLayoutError({ reason: 'invalid-edge-step' });
      }
      var currentLength = Math.sqrt(currentLen2);
      len2[i] = currentLen2;
      lengths[i] = currentLength;
      dxArr[i] = dx;
      dyArr[i] = dy;
      logLen2[i] = Math.log(currentLen2);
      logMean += logLen2[i];
      lengthSum += currentLength;
    }
    logMean /= m;

    var edgeStats = summarizeObjectiveEdges(data, objectiveEdges, x, y, edgeTol2, logLen2, logMean);
    var maxLogDeviation = edgeStats.maxLogDeviation;

    var centeredLogLen2 = new Array(m);
    var edgeVarianceTerm = 0;
    for (i = 0; i < m; i += 1) {
      centeredLogLen2[i] = logLen2[i] - logMean;
      edgeVarianceTerm += centeredLogLen2[i] * centeredLogLen2[i] / m;
    }

    var logAbsEpsilon = data.logAbsEpsilon > 0 ? data.logAbsEpsilon : 0.25;
    var edgeSmoothLogAbsTerm = 0;
    var logAbsGrad = new Array(m);
    var logAbsGradMean = 0;
    for (i = 0; i < m; i += 1) {
      var smooth = Math.sqrt(centeredLogLen2[i] * centeredLogLen2[i] + logAbsEpsilon * logAbsEpsilon);
      edgeSmoothLogAbsTerm += (smooth - logAbsEpsilon) / m;
      logAbsGrad[i] = centeredLogLen2[i] / smooth;
      logAbsGradMean += logAbsGrad[i];
    }
    logAbsGradMean /= m;

    var edgeSoftRangeTerm = 0;
    var rangePosWeights = null;
    var rangeNegWeights = null;
    var rangeBeta = data.rangeBeta > 0 ? data.rangeBeta : 6;
    if (m > 0) {
      var maxScaled = -Infinity;
      var maxNegScaled = -Infinity;
      for (i = 0; i < m; i += 1) {
        var scaled = rangeBeta * logLen2[i];
        var negScaled = -scaled;
        if (scaled > maxScaled) maxScaled = scaled;
        if (negScaled > maxNegScaled) maxNegScaled = negScaled;
      }
      rangePosWeights = new Array(m);
      rangeNegWeights = new Array(m);
      var posSum = 0;
      var negSum = 0;
      for (i = 0; i < m; i += 1) {
        var posWeight = Math.exp(rangeBeta * logLen2[i] - maxScaled);
        var negWeight = Math.exp(-rangeBeta * logLen2[i] - maxNegScaled);
        rangePosWeights[i] = posWeight;
        rangeNegWeights[i] = negWeight;
        posSum += posWeight;
        negSum += negWeight;
      }
      edgeSoftRangeTerm = (Math.log(posSum) + maxScaled) / rangeBeta -
        (Math.log(negSum) + maxNegScaled) / rangeBeta;
      for (i = 0; i < m; i += 1) {
        rangePosWeights[i] /= posSum;
        rangeNegWeights[i] /= negSum;
      }
    }

    var edgeObjectiveTerm = edgeVarianceTerm +
      data.rangeWeight * edgeSoftRangeTerm +
      data.logAbsWeight * edgeSmoothLogAbsTerm;
    for (i = 0; i < m; i += 1) {
      var varianceCoeff = (4 / m) * centeredLogLen2[i] / len2[i];
      var extraRangeCoeff = data.rangeWeight * (2 / len2[i]) * (rangePosWeights[i] - rangeNegWeights[i]);
      var extraLogAbsCoeff = data.logAbsWeight * (2 / (m * len2[i])) * (logAbsGrad[i] - logAbsGradMean);
      addObjectiveEdgeGradient(
        data,
        objectiveEdges[i],
        varianceCoeff + extraRangeCoeff + extraLogAbsCoeff,
        dxArr[i],
        dyArr[i],
        zX,
        zY
      );
    }

    return buildLayoutResult({
      ok: true,
      edgeObjectiveTerm: edgeObjectiveTerm,
      edgeVarianceTerm: edgeVarianceTerm,
      edgeSmoothLogAbsTerm: edgeSmoothLogAbsTerm,
      edgeSoftRangeTerm: edgeSoftRangeTerm,
      logLen2: logLen2,
      logMean: logMean,
      edgeStats: edgeStats,
      maxLogDeviation: maxLogDeviation
    });
  }

  function summarizeObjectiveEdges(data, objectiveEdges, x, y, edgeTol2, logLen2, logMean) {
    var minLength = Infinity;
    var maxLength = 0;
    var totalLength = 0;
    var validCount = 0;
    var maxLogDeviation = 0;
    var worstEdge = null;
    for (var i = 0; i < objectiveEdges.length; i += 1) {
      var edge = objectiveEdges[i];
      var u = edge[0];
      var v = edge[1];
      var dx = x[u] - x[v];
      var dy = y[u] - y[v];
      var len2 = dx * dx + dy * dy;
      if (!(len2 > edgeTol2)) {
        continue;
      }
      var length = Math.sqrt(len2);
      if (length < minLength) minLength = length;
      if (length > maxLength) maxLength = length;
      totalLength += length;
      validCount += 1;
      var centered = logLen2[i] - logMean;
      var deviation = Math.abs(centered);
      if (deviation > maxLogDeviation) {
        maxLogDeviation = deviation;
        worstEdge = {
          u: data.augIds[u],
          v: data.augIds[v],
          length: length,
          logDeviation: centered
        };
      }
    }
    return {
      minLength: Number.isFinite(minLength) ? minLength : null,
      maxLength: maxLength > 0 ? maxLength : null,
      meanLength: validCount > 0 ? (totalLength / validCount) : null,
      ratio: (Number.isFinite(minLength) && maxLength > 0) ? (minLength / maxLength) : null,
      maxLogDeviation: maxLogDeviation,
      worstEdge: worstEdge
    };
  }

  function buildPositionMap(data, x, y) {
    var pos = {};
    for (var i = 0; i < data.augIds.length; i += 1) {
      pos[data.augIds[i]] = { x: x[i], y: y[i] };
    }
    return pos;
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

  function realizeEdgeBalancerState(q, data) {
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
    if (!factor) return buildLayoutError({ reason: 'EdgeBalancer linear solve failed' });
    var primal = solveLUWithTwoRhs(factor, bx, by);
    if (!primal) return buildLayoutError({ reason: 'EdgeBalancer linear solve failed' });

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

  function initializeEdgeBalancerBaseline(data, q0) {
    var realized = realizeEdgeBalancerState(q0, data);
    if (!realized || !realized.ok) {
      return realized || buildLayoutError({ reason: 'EdgeBalancer initialization failed' });
    }

    var x = realized.x;
    var y = realized.y;
    var edgeScaleSum = 0;
    var edgeScaleWeight = 0;
    var initialMinEdgeLength2 = Infinity;
    var i;
    for (i = 0; i < data.edges.length; i += 1) {
      var edge = data.edges[i];
      var dx = x[edge[0]] - x[edge[1]];
      var dy = y[edge[0]] - y[edge[1]];
      var len2 = dx * dx + dy * dy;
      if (len2 > 1e-12) {
        edgeScaleSum += edge[2] * len2;
        edgeScaleWeight += edge[2];
        if (len2 < initialMinEdgeLength2) initialMinEdgeLength2 = len2;
      }
    }
    data.edgeBarrierScale2 = edgeScaleWeight > 0 ? (edgeScaleSum / edgeScaleWeight) : 1;
    data.initialMinEdgeLength2 = Number.isFinite(initialMinEdgeLength2) ? initialMinEdgeLength2 : 0;

    var initialObjectiveMinEdgeLength2 = Infinity;
    for (i = 0; i < data.objectiveEdges.length; i += 1) {
      edge = data.objectiveEdges[i];
      dx = x[edge[0]] - x[edge[1]];
      dy = y[edge[0]] - y[edge[1]];
      len2 = dx * dx + dy * dy;
      if (len2 > 1e-12 && len2 < initialObjectiveMinEdgeLength2) {
        initialObjectiveMinEdgeLength2 = len2;
      }
    }
    data.initialObjectiveMinEdgeLength2 = Number.isFinite(initialObjectiveMinEdgeLength2)
      ? initialObjectiveMinEdgeLength2
      : 0;

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

    return buildLayoutResult({
      ok: true,
      positions: buildPositionMap(data, x, y)
    });
  }

  function evaluateObjectiveAndGradient(q, data) {
    var triangleSlack = Math.max(data.areaTol, 1e-12);
    var i;
    var nI = data.interiorAugIndices.length;
    var realized = realizeEdgeBalancerState(q, data);
    if (!realized || !realized.ok) {
      return realized || buildLayoutError({ reason: 'EdgeBalancer linear solve failed' });
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

    var objectiveEdges = data.objectiveEdges;
    if (!(objectiveEdges.length > 0)) {
      return buildLayoutError({ reason: 'EdgeBalancer requires at least one valid objective edge' });
    }

    var zX = createZeroVector(nI);
    var zY = createZeroVector(nI);
    var E = 0;
    var edgeTol2 = Math.max(1e-24, data.areaTol);
    var u;
    var v;
    var dx;
    var dy;
    var len2;
    var iu;
    var iv;
    var objectiveEval = evaluateObjectiveEdgeTerms(data, objectiveEdges, x, y, edgeTol2, zX, zY);
    if (!objectiveEval.ok) {
      return objectiveEval;
    }
    var edgeVarianceTerm = objectiveEval.edgeVarianceTerm;
    var edgeSmoothLogAbsTerm = objectiveEval.edgeSmoothLogAbsTerm;
    var edgeSoftRangeTerm = objectiveEval.edgeSoftRangeTerm;
    var edgeObjectiveTerm = objectiveEval.edgeObjectiveTerm;
    var edgeStats = objectiveEval.edgeStats;
    var maxLogDeviation = objectiveEval.maxLogDeviation;
    E += edgeObjectiveTerm;

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
        iu = data.interiorIndexByAug[a];
        var ib = data.interiorIndexByAug[b];
        var ic = data.interiorIndexByAug[c];
        if (iu >= 0) {
          zX[iu] += coeff * dAxA;
          zY[iu] += coeff * dAyA;
        }
        if (ib >= 0) {
          zX[ib] += coeff * dAxB;
          zY[ib] += coeff * dAyB;
        }
        if (ic >= 0) {
          zX[ic] += coeff * dAxC;
          zY[ic] += coeff * dAyC;
        }
      }
    }

    var adjoint = solveTransposeLUWithTwoRhs(factor, zX, zY);
    if (!adjoint) return buildLayoutError({ reason: 'EdgeBalancer adjoint solve failed' });

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
      maxLogDeviation: maxLogDeviation,
      edgeStats: edgeStats
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

  async function runEdgeBalancerOptimization(q0, data, opts) {
    var maxIters = opts.maxIters;
    var gradTol = opts.gradTol;
    var stepTol = opts.stepTol;
    var memory = opts.lbfgsMemory;
    var maxStepNorm = opts.maxStepNorm;
    var maxPositionStep = opts.maxPositionStep;
    var lineSearchC1 = opts.lineSearchC1;
    var lineSearchTau = opts.lineSearchTau;
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
      if (current.gradNorm <= gradTol) {
        stopReason = 'grad-converged';
        break;
      }

      var prevX = current.x;
      var prevY = current.y;
      var d = lbfgsDirection(current.gradVec, S, Y, Rho);
      if (!(vecDot(current.gradVec, d) < 0)) d = vecScale(current.gradVec, -1);
      var directionNorm = vecNorm(d);
      if (directionNorm > maxStepNorm) {
        d = vecScale(d, maxStepNorm / directionNorm);
      }

      var gtd = vecDot(current.gradVec, d);
      var accepted = null;
      var lineSearchAttempt;
      for (lineSearchAttempt = 0; lineSearchAttempt < 2 && !accepted; lineSearchAttempt += 1) {
        var searchDir = d;
        if (lineSearchAttempt === 1) {
          searchDir = vecScale(current.gradVec, -1);
          directionNorm = vecNorm(searchDir);
          if (directionNorm > maxStepNorm) {
            searchDir = vecScale(searchDir, maxStepNorm / directionNorm);
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
              alpha *= lineSearchTau;
              continue;
            }
          }
          if (trial.ok && trial.E <= current.E + lineSearchC1 * alpha * gtd) {
            accepted = { q: qTrial, eval: trial };
            break;
          }
          alpha *= lineSearchTau;
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
          maxLogDeviation: current.maxLogDeviation,
          edgeLengthRatio: current.edgeStats ? current.edgeStats.ratio : null,
          minEdgeLength: current.edgeStats ? current.edgeStats.minLength : null,
          maxEdgeLength: current.edgeStats ? current.edgeStats.maxLength : null,
          meanEdgeLength: current.edgeStats ? current.edgeStats.meanLength : null,
          positions: buildPositionMap(data, current.x, current.y),
          movedVertices: moveStats.movedVertices,
          maxMove: moveStats.maxMove,
          avgMove: moveStats.avgMove,
          debug: {
            gradNorm: current.gradNorm,
            stableIterCount: movementStatus.stableIterations,
            stableIterLimit: movementStatus.stableIterLimit,
            stepNorm: stepNorm,
            worstEdge: current.edgeStats ? current.edgeStats.worstEdge : null
          }
        });
      }

      if (movementStatus.converged) {
        stopReason = movementStatus.reason || 'movement-converged';
        break;
      }
      if (stepNorm < stepTol) {
        stopReason = 'step-converged';
        break;
      }

      var ys = vecDot(y, s);
      if (ys > 1e-14) {
        if (S.length === memory) {
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
      maxLogDeviation: current.maxLogDeviation,
      edgeStats: current.edgeStats || null,
      stopReason: stopReason,
      iters: completedIters
    });
  }

  async function computeEdgeBalancerPositions(graph, options) {
    options = options || {};
    var context = LayoutPreprocessing.prepareGraphData(graph, {
      failureLabel: 'EdgeBalancer layout',
      augmentationMethod: options.augmentationMethod === undefined ? null : options.augmentationMethod,
      augmentationOptions: typeof options.augmentationOptions === 'object' && options.augmentationOptions
        ? Object.assign({}, options.augmentationOptions)
        : null,
      currentPositions: options.currentPositions
    });
    if (!context || !context.ok) {
      return buildLayoutError(context || { message: 'EdgeBalancer setup failed' });
    }

    var g = context.graph;
    var outerFace = context.augmentedOuterFace;
    var augmented = context.augmented;
    var outerPos = PlanarVibeTutte.placeOuterFaceVertices(
      context.augmentedGraph.nodeIds,
      outerFace,
      PlanarVibeTutte.defaultOuterPlacementOptions()
    );
    var data = buildEdgeBalancerData({
      augmentedEdgePairs: augmented.graph.edgePairs,
      augmentedEmbedding: augmented.embedding,
      objectiveEdgePairs: g.edgePairs,
      outerFace: outerFace,
      outerPos: outerPos,
      areaTol: EDGE_CONFIG.areaTol,
      augmentedEdgeWeight: EDGE_CONFIG.augmentedEdgeWeight,
      faceBarrierWeight: EDGE_CONFIG.faceBarrierWeight,
      rangeWeight: EDGE_CONFIG.rangeWeight,
      rangeBeta: EDGE_CONFIG.rangeBeta,
      logAbsWeight: EDGE_CONFIG.logAbsWeight,
      logAbsEpsilon: EDGE_CONFIG.logAbsEpsilon,
      minFaceArea: 0
    });
    if (!data.ok) {
      return buildLayoutError({
        message: data.reason || 'EdgeBalancer setup failed',
        graph: g,
        outerFace: outerFace,
        augmented: augmented
      });
    }
    var tutteWeights = PlanarVibeTutte.buildTutteWeights(g, context.augmentedGraph);
    var q0Result = buildInitialLogitSeed(data, tutteWeights);
    if (!q0Result.ok) {
      return buildLayoutError({
        message: q0Result.reason || 'EdgeBalancer initialization failed',
        graph: g,
        outerFace: outerFace,
        augmented: augmented
      });
    }
    var q0 = q0Result.q0;
    var baseline = initializeEdgeBalancerBaseline(data, q0);
    if (!baseline || !baseline.ok || !baseline.positions) {
      return buildLayoutError({
        message: baseline && baseline.reason ? baseline.reason : 'EdgeBalancer initialization failed',
        graph: g,
        outerFace: outerFace,
        augmented: augmented
      });
    }
    data.minFaceArea = Math.max(0, EDGE_CONFIG.minFaceAreaFactor * data.initialMinFaceArea);
    var movementScale = GeometryUtils.computeDrawingDiameter(augmented.graph.nodeIds, baseline.positions);
    var movementTracker = global.GraphUtils.createMovementConvergenceTracker({
      minItersBeforeStop: EDGE_CONFIG.minItersBeforeStop,
      stableIterLimit: EDGE_CONFIG.stableIterLimit,
      maxMoveTol: EDGE_CONFIG.movementStopTol * movementScale,
      avgMoveTol: EDGE_CONFIG.avgMovementStopTol * movementScale
    });

    var result = await runEdgeBalancerOptimization(q0, data, {
      maxIters: EDGE_CONFIG.maxIters,
      gradTol: EDGE_CONFIG.gradTol,
      stepTol: EDGE_CONFIG.stepTol,
      lbfgsMemory: EDGE_CONFIG.lbfgsMemory,
      maxStepNorm: EDGE_CONFIG.maxStepNorm,
      maxPositionStep: EDGE_CONFIG.maxPositionStepRatio * movementScale,
      lineSearchC1: EDGE_CONFIG.lineSearchC1,
      lineSearchTau: EDGE_CONFIG.lineSearchTau,
      movementTracker: movementTracker,
      onIteration: async function (progress) {
        if (options.onIteration) {
          var progressEdgeDeviation = Metrics.computeEdgeLengthDeviationScore(g.edgePairs, progress.positions);
          await options.onIteration(Object.assign({}, progress, {
            edgeLengthDeviation: progressEdgeDeviation && progressEdgeDeviation.ok ? progressEdgeDeviation.score : null
          }));
        }
      }
    });
    if (!result.ok) {
      return buildLayoutError({
        message: result.reason || 'EdgeBalancer optimization failed',
        graph: g,
        outerFace: outerFace,
        augmented: augmented
      });
    }
    var finalPositions = filterPositions(result.positions, g.nodeIds);
    var hasCrossings = hasPositionCrossings(finalPositions, g.edgePairs);
    if (hasCrossings) {
      return buildLayoutError({
        stopReason: result.stopReason,
        graph: g,
        outerFace: outerFace,
        augmented: augmented,
        message: 'EdgeBalancer produced a non-plane drawing'
      });
    }
    var edgeDeviation = Metrics.computeEdgeLengthDeviationScore(g.edgePairs, finalPositions);
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
      maxLogDeviation: result.maxLogDeviation,
      edgeLengthDeviation: edgeDeviation && edgeDeviation.ok ? edgeDeviation.score : null
    });
  }

  async function applyEdgeBalancerLayout(cy, options) {
    return CyRuntime.runLayout(cy, options, {
      compute: computeEdgeBalancerPositions,
      buildResult: function (ctx) {
        var result = ctx.result;
        var message = buildLayoutStatusMessage('EdgeBalancer', {
          dummyCount: result.augmented.dummyCount,
          iters: result.iters,
          stopReason: result.stopReason,
          extraParts: [
            Number.isFinite(result.edgeLengthDeviation) ? 'edge deviation ' + result.edgeLengthDeviation.toFixed(3) : null,
            Number.isFinite(result.objective) ? 'obj ' + result.objective.toFixed(3) : null
          ]
        });
        return {
          ok: true,
          stopReason: result.stopReason,
          edgeLengthDeviation: result.edgeLengthDeviation,
          message: message,
          debugState: LayoutPreprocessing.createAugmentationDebugState(
            result.graph,
            result.augmented,
            result.debugPositions || result.positions
          )
        };
      },
      failureMessage: 'EdgeBalancer failed'
    });
  }

  global.PlanarVibeEdgeBalancer = {
    computeEdgeBalancerPositions: computeEdgeBalancerPositions,
    applyEdgeBalancerLayout: applyEdgeBalancerLayout
  };
})(window);
