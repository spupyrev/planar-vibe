(function (global) {
  'use strict';

  var LayoutPreprocessing = global.LayoutPreprocessing;
  var CyRuntime = global.CyRuntime;
  var Metrics = global.PlanarVibeMetrics;
  var GeometryUtils = global.GeometryUtils;
  var LinearAlgebraUtils = global.LinearAlgebraUtils;
  var faceKey = global.GraphUtils.faceKey;
  var buildLayoutError = global.GraphUtils.buildLayoutError;
  var buildLayoutResult = global.GraphUtils.buildLayoutResult;
  var buildLayoutStatusMessage = global.GraphUtils.buildLayoutStatusMessage;
  var computeMoveStats = global.GraphUtils.computeMoveStats;
  var hasPositionCrossings = GeometryUtils.hasPositionCrossings;
  var pointOnSegmentInterior = GeometryUtils.pointOnSegmentInterior;
  var polygonArea2 = GeometryUtils.polygonArea2;
  var orientFaceCCW = GeometryUtils.orientFaceCCW;
  var luFactorize = LinearAlgebraUtils.luFactorize;
  var segmentsIntersectStrict = GeometryUtils.segmentsIntersectStrict;
  var solveLUWithTwoRhs = LinearAlgebraUtils.solveLUWithTwoRhs;
  var solveTransposeLUWithTwoRhs = LinearAlgebraUtils.solveTransposeLUWithTwoRhs;
  var triangleArea2 = GeometryUtils.triangleArea2;
  var resolveFloatOption = global.GraphUtils.resolveFloatOption;
  var resolveFunctionOption = global.GraphUtils.resolveFunctionOption;
  var resolveIntOption = global.GraphUtils.resolveIntOption;
  var resolveNonNegativeOption = global.GraphUtils.resolveNonNegativeOption;
  var createZeroVector = GeometryUtils.createZeroVector;
  var vecAddScaled = GeometryUtils.vecAddScaled;
  var vecDot = GeometryUtils.vecDot;
  var vecNorm = GeometryUtils.vecNorm;
  var vecScale = GeometryUtils.vecScale;
  var vecSub = GeometryUtils.vecSub;

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
    var initPos = input.initPos;
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

    var outerKey = faceKey(outerFace);
    var boundedFaceKeys = [];
    var boundedFaces = [];
    var initialFaceMinArea = Infinity;
    var initialFaceAreaSum = 0;
    var initialFaceCount = 0;
    for (i = 0; i < augmentedEmbedding.faces.length; i += 1) {
      var orientedFace = orientFaceCCW(augmentedEmbedding.faces[i], initPos);
      var faceK = faceKey(orientedFace);
      if (faceK === outerKey) continue;
      if (!orientedFace || orientedFace.length < 3) {
        return buildLayoutError({ reason: 'FaceBalancer requires a valid triangulated augmentation' });
      }
      if (orientedFace.length !== 3) {
        return buildLayoutError({ reason: 'FaceBalancer requires all non-outer augmented faces to be triangles' });
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
      areaTol: Number.isFinite(input.areaTol) ? Math.max(0, input.areaTol) : 0,
      faceBarrierWeight: Number.isFinite(input.faceBarrierWeight) ? Math.max(0, input.faceBarrierWeight) : 0,
      edgeBarrierWeight: Number.isFinite(input.edgeBarrierWeight) ? Math.max(0, input.edgeBarrierWeight) : 0,
      edgeUniformWeight: Number.isFinite(input.edgeUniformWeight) ? Math.max(0, input.edgeUniformWeight) : 0,
      edgeBarrierScale2: edgeScaleCount > 0 ? (edgeScaleSum / edgeScaleCount) : 1,
      initialMinEdgeLength2: Number.isFinite(initialMinEdgeLength2) ? initialMinEdgeLength2 : 0,
      initialAvgFaceArea: initialFaceCount > 0 ? (initialFaceAreaSum / initialFaceCount) : 1,
      initialMinFaceArea: Number.isFinite(initialFaceMinArea) ? initialFaceMinArea : 0,
      minFaceArea: Number.isFinite(input.minFaceArea) ? Math.max(0, input.minFaceArea) : 0,
      minEdgeLength2: Number.isFinite(input.minEdgeLength2) ? Math.max(0, input.minEdgeLength2) : 0
    });
  }

  function buildPositionMap(data, x, y) {
    var pos = {};
    for (var i = 0; i < data.augIds.length; i += 1) {
      pos[data.augIds[i]] = { x: x[i], y: y[i] };
    }
    return pos;
  }

  function buildFaceAreaMap(data, faceAreas) {
    var out = {};
    for (var i = 0; i < data.boundedFaceKeys.length; i += 1) {
      out[data.boundedFaceKeys[i]] = faceAreas[i];
    }
    return out;
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

  function hasIndexedEdgeCrossings(edgePairs, getPoint, eps) {
    if (typeof getPoint !== 'function') {
      throw new Error('hasIndexedEdgeCrossings requires a point lookup function');
    }
    if (!edgePairs || edgePairs.length < 2) return false;
    var tol = Number.isFinite(eps) ? Math.max(0, eps) : 1e-9;
    for (var i = 0; i < edgePairs.length; i += 1) {
      var e1 = edgePairs[i];
      var a = e1[0];
      var b = e1[1];
      var pa = getPoint(a);
      var pb = getPoint(b);
      if (!pa || !pb) {
        throw new Error('hasIndexedEdgeCrossings found a missing edge endpoint');
      }
      for (var j = i + 1; j < edgePairs.length; j += 1) {
        var e2 = edgePairs[j];
        var c = e2[0];
        var d = e2[1];
        if (a === c || a === d || b === c || b === d) continue;
        var pc = getPoint(c);
        var pd = getPoint(d);
        if (!pc || !pd) {
          throw new Error('hasIndexedEdgeCrossings found a missing edge endpoint');
        }
        if (segmentsIntersectStrict(pa, pb, pc, pd, eps)) {
          return true;
        }
        if (Math.abs(triangleArea2(pa, pb, pc)) <= tol &&
            pointOnSegmentInterior(pa, pb, pc, tol)) {
          return true;
        }
        if (Math.abs(triangleArea2(pa, pb, pd)) <= tol &&
            pointOnSegmentInterior(pa, pb, pd, tol)) {
          return true;
        }
        if (Math.abs(triangleArea2(pc, pd, pa)) <= tol &&
            pointOnSegmentInterior(pc, pd, pa, tol)) {
          return true;
        }
        if (Math.abs(triangleArea2(pc, pd, pb)) <= tol &&
            pointOnSegmentInterior(pc, pd, pb, tol)) {
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

  function evaluateObjectiveAndGradient(q, data) {
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
    var getPoint = getIndexedPoint(x, y);

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
    for (i = 0; i < data.triangles.length; i += 1) {
      tri = data.triangles[i];
      a = tri[0];
      b = tri[1];
      c = tri[2];
      var faceIdx = tri[3];
      var coeff = 2 * residual[faceIdx] / targetArea;
      if (barrierWeight > 0) {
        coeff -= barrierWeight / faceAreas[faceIdx];
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
    if (hasIndexedEdgeCrossings(data.edges, getPoint, 1e-9)) {
      return buildLayoutError({ reason: 'invalid-face-step' });
    }

    var adjoint = solveTransposeLUWithTwoRhs(factor, zX, zY);
    if (!adjoint) return buildLayoutError({ reason: 'FaceBalancer adjoint solve failed' });

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
    var maxIters = resolveIntOption(opts.maxIters, 80, 1);
    var gradTol = resolveFloatOption(opts.gradTol, 1e-5, 0);
    var stepTol = resolveFloatOption(opts.stepTol, 1e-10, 0);
    var memory = resolveIntOption(opts.lbfgsMemory, 10, 1);
    var lineSearchC1 = resolveFloatOption(opts.lineSearchC1, 1e-4, 0);
    var lineSearchTau = resolveFloatOption(opts.lineSearchTau, 0.5, 0.1, 0.9);
    var q = q0.slice();
    var current = evaluateObjectiveAndGradient(q, data);
    if (!current.ok) return current;

    var best = current;
    var bestQ = q.slice();
    var S = [];
    var Y = [];
    var Rho = [];
    var onIteration = resolveFunctionOption(opts.onIteration, null);
    var movementTracker = opts.movementTracker || null;
    var movementStatus = { stableIterations: 0, stableIterLimit: 0, converged: false };
    var stopReason = 'max-iters';
    var moveStats = { movedVertices: 0, totalMove: 0, avgMove: 0, maxMove: 0 };

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
      if (current.E < best.E) {
        best = current;
        bestQ = q.slice();
      }

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
      ok: true,
      q: bestQ,
      positions: buildPositionMap(data, best.x, best.y),
      E: best.E,
      gradNorm: best.gradNorm,
      faceAreas: buildFaceAreaMap(data, best.faceAreas),
      maxRelError: best.maxRelError,
      stopReason: stopReason
    });
  }

  async function computeFaceBalancerPositions(graph, options) {
    var maxIters = resolveIntOption(options.maxIters, 80, 1);
    var context = LayoutPreprocessing.prepareGraphAndLayoutData(graph, {
      failureLabel: 'FaceBalancer layout',
      augmentationMethod: options.augmentationMethod || null,
      currentPositions: options.currentPositions
    });
    if (!context || !context.ok) {
      return buildLayoutError(context || { message: 'FaceBalancer setup failed' });
    }

    var g = context.graph;
    var outerFace = context.augmentedOuterFace || context.outerFace;
    var augmented = context.augmented;
    var initPos = context.posById;
    var hasExplicitMinFaceArea = Number.isFinite(options.minFaceArea) && options.minFaceArea >= 0;
    var hasExplicitMinEdgeLength2 = Number.isFinite(options.minEdgeLength2) && options.minEdgeLength2 >= 0;
    var areaTol = resolveNonNegativeOption(options.areaTol, 1e-15);
    var data = buildFaceBalancerData({
      augmentedEdgePairs: augmented.graph.edgePairs,
      augmentedEmbedding: augmented.embedding,
      outerFace: outerFace,
      initPos: initPos,
      areaTol: areaTol,
      faceBarrierWeight: resolveFloatOption(options.faceBarrierWeight, 0.2, 0),
      edgeBarrierWeight: resolveFloatOption(options.edgeBarrierWeight, 0.05, 0),
      edgeUniformWeight: resolveFloatOption(options.edgeUniformWeight, 0.02, 0),
      minFaceArea: resolveNonNegativeOption(options.minFaceArea, 0),
      minEdgeLength2: resolveNonNegativeOption(options.minEdgeLength2, 0)
    });
    if (!data.ok) {
      return buildLayoutError({
        message: data.reason || 'FaceBalancer setup failed',
        graph: g,
        outerFace: outerFace,
        augmented: augmented
      });
    }
    if (!(data.initialAvgFaceArea > 0)) {
      return buildLayoutError({
        message: 'FaceBalancer setup failed',
        graph: g,
        outerFace: outerFace,
        augmented: augmented
      });
    }
    if (!hasExplicitMinFaceArea) {
      data.minFaceArea = Math.max(0, 0.25 * data.initialMinFaceArea);
    }
    if (!hasExplicitMinEdgeLength2) {
      data.minEdgeLength2 = 0;
    }
    if (data.boundedFaceKeys.length === 0) {
      return buildLayoutResult({
        ok: true,
        nodeIds: g.nodeIds,
        edgePairs: g.edgePairs,
        outerFace: outerFace,
        graph: g,
        augmented: augmented,
        positions: initPos,
        stopReason: 'no-bounded-faces',
        iters: 0,
        objective: 0,
        faceAreaScore: null,
        boundedFaceCount: 0
      });
    }

    var q0 = createZeroVector(data.qSize);
    var movementScale = GeometryUtils.computeDrawingDiameter(augmented.graph.nodeIds, initPos);
    var movementTracker = global.GraphUtils.createMovementConvergenceTracker({
      minItersBeforeStop: resolveIntOption(options.minItersBeforeStop, Math.max(20, Math.min(maxIters, 40)), 1),
      stableIterLimit: resolveIntOption(options.stableIterLimit, 8, 1),
      maxMoveTol: resolveNonNegativeOption(options.movementStopTol, 1e-6 * movementScale),
      avgMoveTol: resolveNonNegativeOption(options.avgMovementStopTol, 2e-7 * movementScale)
    });

    var iterationCount = 0;
    var result = await runFaceBalancerOptimization(q0, data, {
      maxIters: maxIters,
      gradTol: resolveFloatOption(options.gradTol, 1e-5, 0),
      stepTol: resolveFloatOption(options.stepTol, 1e-6, 0),
      lbfgsMemory: resolveIntOption(options.lbfgsMemory, 10, 1),
      movementTracker: movementTracker,
      onIteration: async function (progress) {
        iterationCount = progress.iter;
        if (typeof options.onIteration === 'function') {
          await options.onIteration(progress);
        }
      }
    });
    if (!result.ok) {
      return buildLayoutError({
        message: result.reason || 'FaceBalancer optimization failed',
        graph: g,
        outerFace: outerFace,
        augmented: augmented
      });
    }
    var hasCrossings = hasPositionCrossings(result.positions, g.edgePairs);
    if (hasCrossings) {
      return buildLayoutError({
        stopReason: result.stopReason,
        graph: g,
        outerFace: outerFace,
        augmented: augmented,
        message: 'FaceBalancer produced a non-plane drawing'
      });
    }
    var faceScore = Metrics.computeUniformFaceAreaScore(g.nodeIds, g.edgePairs, result.positions);
    return buildLayoutResult({
      ok: true,
      nodeIds: g.nodeIds,
      edgePairs: g.edgePairs,
      outerFace: outerFace,
      graph: g,
      augmented: augmented,
      positions: result.positions,
      stopReason: result.stopReason,
      iters: iterationCount,
      objective: result.E,
      faceAreaScore: faceScore && faceScore.ok ? faceScore.quality : null,
      boundedFaceCount: data.boundedFaceKeys.length
    });
  }

  async function applyFaceBalancerLayout(cy, options) {
    return CyRuntime.runLayout(cy, options, {
      useSharedPreparedSeed: true,
      sharedSeedFailureLabel: 'FaceBalancer layout',
      compute: computeFaceBalancerPositions,
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
            result.positions
          )
        };
      },
      failureMessage: 'FaceBalancer failed'
    });
  }

  global.PlanarVibeFaceBalancer = {
    computeFaceBalancerPositions: computeFaceBalancerPositions,
    applyFaceBalancerLayout: applyFaceBalancerLayout
  };
})(window);
