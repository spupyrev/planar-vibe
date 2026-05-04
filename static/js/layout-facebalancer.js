(function (global) {
  'use strict';

  var LayoutPreprocessing = global.LayoutPreprocessing;
  var PlanarVibeTutte = global.PlanarVibeTutte;
  var CyRuntime = global.CyRuntime;
  var Metrics = global.PlanarVibeMetrics;
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
  var solveLUWithTwoRhs = LinearAlgebraUtils.solveLUWithTwoRhs;
  var solveTransposeLUWithTwoRhs = LinearAlgebraUtils.solveTransposeLUWithTwoRhs;
  var createZeroVector = GeometryUtils.createZeroVector;
  var vecAddScaled = GeometryUtils.vecAddScaled;
  var vecDot = GeometryUtils.vecDot;
  var vecNorm = GeometryUtils.vecNorm;
  var vecScale = GeometryUtils.vecScale;
  var vecSub = GeometryUtils.vecSub;
  var FACE_CONFIG = {
    areaTol: 1e-15,
    faceBarrierWeight: 0.2,
    edgeBarrierWeight: 0.05,
    edgeUniformWeight: 0.02,
    minFaceAreaFactor: 0.25,
    minEdgeLength2: 0,
    maxIters: 80,
    gradTol: 1e-5,
    stepTol: 1e-6,
    lbfgsMemory: 10,
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

  function buildFaceBalancerData(input) {
    var augmentedEdgePairs = input.augmentedEdgePairs;
    var augmentedEmbedding = input.augmentedEmbedding;
    var outerFace = input.outerFace;
    var outerPos = input.outerPos || {};
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
    for (i = 0; i < augmentedEdgePairs.length; i += 1) {
      var u = augIndexById[String(augmentedEdgePairs[i][0])];
      var v = augIndexById[String(augmentedEdgePairs[i][1])];
      if (u === undefined || v === undefined || u === v) continue;
      edges.push([u, v]);
    }

    var outerKey = faceKey(outerFace);
    var boundedFaces = [];
    for (i = 0; i < augmentedEmbedding.faces.length; i += 1) {
      var rawFace = Array.isArray(augmentedEmbedding.faces[i])
        ? augmentedEmbedding.faces[i].slice().map(String)
        : [];
      if (faceKey(rawFace) === outerKey) continue;
      if (!rawFace || rawFace.length < 3) {
        return buildLayoutError({ reason: 'FaceBalancer requires a valid triangulated augmentation' });
      }
      if (rawFace.length !== 3) {
        return buildLayoutError({ reason: 'FaceBalancer requires all non-outer augmented faces to be triangles' });
      }
      boundedFaces.push(rawFace.map(function (id) { return augIndexById[String(id)]; }));
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
      boundedFaces: boundedFaces,
      edges: edges,
      areaTol: Math.max(0, input.areaTol),
      faceBarrierWeight: Math.max(0, input.faceBarrierWeight),
      edgeBarrierWeight: Math.max(0, input.edgeBarrierWeight),
      edgeUniformWeight: Math.max(0, input.edgeUniformWeight),
      edgeBarrierScale2: 1,
      initialMinFaceArea: 0,
      minFaceArea: Math.max(0, input.minFaceArea),
      minEdgeLength2: Math.max(0, input.minEdgeLength2)
    });
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
            reason: 'FaceBalancer initialization requires positive Tutte weights',
            vertexId: vertexId,
            neighborId: neighborId
          });
        }
        rowWeights[k] = rowWeight;
        rowWeightSum += rowWeight;
      }
      if (!(rowWeightSum > 0)) {
        return buildLayoutError({
          reason: 'FaceBalancer initialization requires positive Tutte row weight sum',
          vertexId: vertexId
        });
      }
      for (k = 0; k < neighbors.length; k += 1) {
        q0[rowOffset + k] = Math.log(rowWeights[k] / rowWeightSum);
      }
    }
    return buildLayoutResult({ q0: q0 });
  }

  function realizeFaceBalancerState(q, data) {
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
    if (!factor) return buildLayoutError({ reason: 'FaceBalancer linear solve failed' });
    var primal = solveLUWithTwoRhs(factor, bx, by);
    if (!primal) return buildLayoutError({ reason: 'FaceBalancer linear solve failed' });

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

  function initializeFaceBalancerBaseline(data, q0) {
    var realized = realizeFaceBalancerState(q0, data);
    if (!realized || !realized.ok) {
      return realized || buildLayoutError({ reason: 'FaceBalancer initialization failed' });
    }

    var x = realized.x;
    var y = realized.y;
    var edgeScaleSum = 0;
    var edgeScaleCount = 0;
    var i;
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
    for (i = 0; i < data.boundedFaces.length; i += 1) {
      var face = data.boundedFaces[i];
      if (polygonArea2FromArrays(face, x, y) < 0) {
        face.reverse();
      }
      var area = Math.abs(polygonArea2FromArrays(face, x, y)) / 2;
      if (area > 1e-12) {
        if (area < initialFaceMinArea) initialFaceMinArea = area;
      }
    }
    data.initialMinFaceArea = Number.isFinite(initialFaceMinArea) ? initialFaceMinArea : 0;

    return buildLayoutResult({
      q0: q0,
      positions: buildPositionMap(data, x, y)
    });
  }

  function evaluateObjectiveAndGradient(q, data) {
    var triangleSlack = Math.max(data.areaTol, 1e-12);
    var i;
    var nI = data.interiorAugIndices.length;
    var realized = realizeFaceBalancerState(q, data);
    if (!realized || !realized.ok) {
      return realized || buildLayoutError({ reason: 'FaceBalancer linear solve failed' });
    }
    var lambda = realized.lambda;
    var factor = realized.factor;
    var x = realized.x;
    var y = realized.y;
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
    }
    for (i = 0; i < data.boundedFaces.length; i += 1) {
      var boundary = data.boundedFaces[i];
      if (!(polygonArea2FromArrays(boundary, x, y) > 2 * data.areaTol)) {
        return buildLayoutError({ reason: 'invalid-face-step' });
      }
    }
    for (i = 0; i < faceAreas.length; i += 1) totalArea += faceAreas[i];
    if (!(faceAreas.length > 0) || !(totalArea > 1e-12)) {
      return buildLayoutError({ reason: 'FaceBalancer total bounded area is not positive' });
    }

    var targetArea = totalArea / faceAreas.length;
    var residual = createZeroVector(faceAreas.length);
    var E = 0;
    var maxRelError = 0;
    var barrierWeight = data.faceBarrierWeight;
    var edgeBarrierWeight = data.edgeBarrierWeight;
    var edgeUniformWeight = data.edgeUniformWeight;
    for (i = 0; i < faceAreas.length; i += 1) {
      residual[i] = faceAreas[i] / targetArea - 1;
      E += residual[i] * residual[i];
      if (barrierWeight > 0) {
        E -= barrierWeight * Math.log(faceAreas[i] / targetArea);
      }
      var rel = Math.abs(residual[i]);
      if (rel > maxRelError) maxRelError = rel;
    }

    var zX = createZeroVector(nI);
    var zY = createZeroVector(nI);
    for (i = 0; i < data.boundedFaces.length; i += 1) {
      tri = data.boundedFaces[i];
      a = tri[0];
      b = tri[1];
      c = tri[2];
      var coeff = 2 * residual[i] / targetArea;
      if (barrierWeight > 0) {
        coeff -= barrierWeight / faceAreas[i];
      }
      var dAxA = 0.5 * (y[b] - y[c]);
      var dAxB = 0.5 * (y[c] - y[a]);
      var dAxC = 0.5 * (y[a] - y[b]);
      var dAyA = 0.5 * (x[c] - x[b]);
      var dAyB = 0.5 * (x[a] - x[c]);
      var dAyC = 0.5 * (x[b] - x[a]);
      var ia = data.interiorIndexByAug[a];
      var ib = data.interiorIndexByAug[b];
      var ic = data.interiorIndexByAug[c];
      if (ia >= 0) {
        zX[ia] += coeff * dAxA;
        zY[ia] += coeff * dAyA;
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

    if (edgeBarrierWeight > 0) {
      var edgeScale2 = data.edgeBarrierScale2 > 1e-12 ? data.edgeBarrierScale2 : 1;
      var edgeTol2 = Math.max(1e-24, data.areaTol);
      for (i = 0; i < data.edges.length; i += 1) {
        var edge = data.edges[i];
        var u = edge[0];
        var v = edge[1];
        var dx = x[u] - x[v];
        var dy = y[u] - y[v];
        var len2 = dx * dx + dy * dy;
        var safeLen2 = len2 > edgeTol2 ? len2 : edgeTol2;
        if (!(safeLen2 < edgeScale2)) {
          continue;
        }
        E -= edgeBarrierWeight * Math.log(safeLen2 / edgeScale2);
        var edgeCoeff = -2 * edgeBarrierWeight / safeLen2;
        var iu = data.interiorIndexByAug[u];
        var iv = data.interiorIndexByAug[v];
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

    if (edgeUniformWeight > 0 && data.edges.length > 1) {
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
      var uniformScale = 2 * edgeUniformWeight / data.edges.length;
      for (i = 0; i < data.edges.length; i += 1) {
        edge = data.edges[i];
        u = edge[0];
        v = edge[1];
        dx = x[u] - x[v];
        dy = y[u] - y[v];
        len2 = dx * dx + dy * dy;
        safeLen2 = len2 > uniformTol2 ? len2 : uniformTol2;
        var centeredLogLen2 = logLen2[i] - logMean;
        E += edgeUniformWeight * centeredLogLen2 * centeredLogLen2 / data.edges.length;
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

    if (data.minEdgeLength2 > 0) {
      for (i = 0; i < data.edges.length; i += 1) {
        var boundedEdge = data.edges[i];
        var ox = x[boundedEdge[0]] - x[boundedEdge[1]];
        var oy = y[boundedEdge[0]] - y[boundedEdge[1]];
        if (!(ox * ox + oy * oy > data.minEdgeLength2)) {
          return buildLayoutError({ reason: 'invalid-edge-step' });
        }
      }
    }
    var adjoint = solveTransposeLUWithTwoRhs(factor, zX, zY);
    if (!adjoint) return buildLayoutError({ reason: 'FaceBalancer adjoint solve failed' });

    var gradVec = createZeroVector(data.qSize);
    for (i = 0; i < nI; i += 1) {
      var rowOffset = data.rowStart[i];
      var meanx = 0;
      var meany = 0;
      var neighbors = data.neighborAugIndices[i];
      for (var k = 0; k < neighbors.length; k += 1) {
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
      E: E,
      gradVec: gradVec,
      gradNorm: vecNorm(gradVec),
      x: x,
      y: y,
      faceAreas: faceAreas,
      maxRelError: maxRelError
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

  async function runFaceBalancerOptimization(q0, data, opts) {
    var maxIters = opts.maxIters;
    var gradTol = opts.gradTol;
    var stepTol = opts.stepTol;
    var memory = opts.lbfgsMemory;
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

      var alpha = 1.0;
      var accepted = null;
      var gtd = vecDot(current.gradVec, d);
      while (alpha >= 1e-12) {
        var qTrial = vecAddScaled(q, d, alpha);
        var trial = evaluateObjectiveAndGradient(qTrial, data);
        if (trial.ok && trial.E <= current.E + lineSearchC1 * alpha * gtd) {
          accepted = { q: qTrial, eval: trial };
          break;
        }
        alpha *= lineSearchTau;
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
        moveStats = computeMoveStats(data.interiorAugIndices, function (idx) {
          return Math.hypot(current.x[idx] - prevX[idx], current.y[idx] - prevY[idx]);
        }, { moveTol: 1e-9 });
        movementStatus = movementTracker.update(moveStats, iter);
      }

      if (onIteration) {
        await onIteration({
          iter: iter,
          maxIters: maxIters,
          objective: current.E,
          maxRelError: current.maxRelError,
          positions: buildPositionMap(data, current.x, current.y),
          movedVertices: moveStats.movedVertices,
          maxMove: moveStats.maxMove,
          avgMove: moveStats.avgMove,
          debug: {
            gradNorm: current.gradNorm,
            stableIterCount: movementStatus.stableIterations,
            stableIterLimit: movementStatus.stableIterLimit,
            stepNorm: stepNorm
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
      q: q,
      positions: buildPositionMap(data, current.x, current.y),
      E: current.E,
      gradNorm: current.gradNorm,
      maxRelError: current.maxRelError,
      stopReason: stopReason,
      iters: completedIters
    });
  }

  async function computeFaceBalancerPositionsFromPrepared(options, prepared) {
    options = options || {};
    if (!prepared || !prepared.ok) {
      return buildLayoutError(prepared || { message: 'FaceBalancer setup failed' });
    }

    var g = prepared.graph;
    var outerFace = prepared.augmentedOuterFace;
    var augmented = prepared.augmented;
    var outerPos = buildFaceBalancerOuterPositions(prepared);
    var data = buildFaceBalancerData({
      augmentedEdgePairs: augmented.graph.edgePairs,
      augmentedEmbedding: augmented.embedding,
      outerFace: outerFace,
      outerPos: outerPos,
      areaTol: FACE_CONFIG.areaTol,
      faceBarrierWeight: FACE_CONFIG.faceBarrierWeight,
      edgeBarrierWeight: FACE_CONFIG.edgeBarrierWeight,
      edgeUniformWeight: FACE_CONFIG.edgeUniformWeight,
      minFaceArea: 0,
      minEdgeLength2: FACE_CONFIG.minEdgeLength2
    });
    if (!data.ok) {
      return buildLayoutError({
        message: data.reason || 'FaceBalancer setup failed',
        graph: g,
        outerFace: outerFace,
        augmented: augmented
      });
    }
    var tutteWeights = PlanarVibeTutte.buildTutteWeights(g, prepared.augmented.graph);
    var q0Result = buildInitialLogitSeed(data, tutteWeights);
    if (!q0Result.ok) {
      return buildLayoutError({
        message: q0Result.reason || 'FaceBalancer initialization failed',
        graph: g,
        outerFace: outerFace,
        augmented: augmented
      });
    }
    var q0 = q0Result.q0;
    var baseline = initializeFaceBalancerBaseline(data, q0);
    if (!baseline || !baseline.ok || !baseline.positions) {
      return buildLayoutError({
        message: baseline && baseline.reason ? baseline.reason : 'FaceBalancer initialization failed',
        graph: g,
        outerFace: outerFace,
        augmented: augmented
      });
    }
    if (data.boundedFaces.length === 0) {
      var staticPositions = filterPositions(baseline.positions, g.nodeIds);
      return buildLayoutResult({
        nodeIds: g.nodeIds,
        edgePairs: g.edgePairs,
        outerFace: outerFace,
        graph: g,
        augmented: augmented,
        positions: staticPositions,
        debugPositions: baseline.positions,
        stopReason: 'no-bounded-faces',
        iters: 0,
        objective: 0,
        faceAreaScore: null,
        boundedFaceCount: 0
      });
    }
    data.minFaceArea = Math.max(0, FACE_CONFIG.minFaceAreaFactor * data.initialMinFaceArea);
    var movementScale = GeometryUtils.computeDrawingDiameter(augmented.graph.nodeIds, baseline.positions);
    var movementTracker = global.GraphUtils.createMovementConvergenceTracker({
      minItersBeforeStop: FACE_CONFIG.minItersBeforeStop,
      stableIterLimit: FACE_CONFIG.stableIterLimit,
      maxMoveTol: FACE_CONFIG.movementStopTol * movementScale,
      avgMoveTol: FACE_CONFIG.avgMovementStopTol * movementScale
    });

    var result = await runFaceBalancerOptimization(q0, data, {
      maxIters: FACE_CONFIG.maxIters,
      gradTol: FACE_CONFIG.gradTol,
      stepTol: FACE_CONFIG.stepTol,
      lbfgsMemory: FACE_CONFIG.lbfgsMemory,
      lineSearchC1: FACE_CONFIG.lineSearchC1,
      lineSearchTau: FACE_CONFIG.lineSearchTau,
      movementTracker: movementTracker,
      onIteration: options.onIteration
    });
    if (!result.ok) {
      return buildLayoutError({
        message: result.reason || 'FaceBalancer optimization failed',
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
        message: 'FaceBalancer produced a non-plane drawing'
      });
    }
    var faceScore = Metrics.computeUniformFaceAreaScore(g.nodeIds, g.edgePairs, finalPositions, prepared.baseEmbedding);
    return buildLayoutResult({
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
      faceAreaScore: faceScore && faceScore.ok ? faceScore.quality : null,
      boundedFaceCount: data.boundedFaces.length
    });
  }

  function buildFaceBalancerOuterPositions(prepared) {
    if (!prepared || !prepared.ok) {
      throw new Error('buildFaceBalancerOuterPositions requires prepared graph data');
    }
    var fullPos = PlanarVibeTutte.placeOuterFaceVertices(
      prepared.augmented.graph.nodeIds,
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

  function prepareGraphData(graph, options) {
    options = options || {};
    return LayoutPreprocessing.prepareGraphData(graph, {
      failureLabel: 'FaceBalancer layout',
      augmentationMethod: options.augmentationMethod === undefined ? null : options.augmentationMethod,
      augmentationOptions: typeof options.augmentationOptions === 'object' && options.augmentationOptions
        ? Object.assign({}, options.augmentationOptions)
        : null,
      currentPositions: options.currentPositions
    });
  }

  async function computePositions(graph, layoutInput) {
    return computeFaceBalancerPositionsFromPrepared(null, layoutInput);
  }

  async function computeFaceBalancerPositions(graph, options) {
    options = options || {};
    return computeFaceBalancerPositionsFromPrepared(options, prepareGraphData(graph, options));
  }

  async function applyFaceBalancerLayout(cy, options) {
    return CyRuntime.runLayout(cy, options, {
      prepareMode: 'graph',
      prepareFailureLabel: 'FaceBalancer layout',
      initialFitBounds: function (ctx) {
        return CyRuntime.computePositionBounds(buildFaceBalancerOuterPositions(ctx.prepared));
      },
      computePositions: function (_graph, computeOptions, prepared) {
        return computeFaceBalancerPositionsFromPrepared(computeOptions || {}, prepared);
      },
      buildResult: function (ctx) {
        var result = ctx.result;
        var message = result.boundedFaceCount === 0
          ? 'Applied FaceBalancer (no bounded faces to balance)'
          : buildLayoutStatusMessage('FaceBalancer', {
            boundedFaceCount: result.boundedFaceCount,
            dummyCount: result.augmented.dummyCount,
            iters: result.iters,
            stopReason: result.stopReason,
            extraParts: [Number.isFinite(result.objective) ? 'obj ' + result.objective.toFixed(3) : null]
          });
        return {
          ok: true,
          stopReason: result.stopReason,
          faceAreaScore: result.faceAreaScore,
          message: message,
          debugState: LayoutPreprocessing.createAugmentationDebugState(
            result.graph,
            result.augmented,
            result.debugPositions || result.positions
          )
        };
      },
      failureMessage: 'FaceBalancer failed'
    });
  }

	  global.PlanarVibeFaceBalancer = {
	    prepareGraphData: prepareGraphData,
	    computePositions: computePositions,
	    applyLayout: applyFaceBalancerLayout
	  };
})(window);
