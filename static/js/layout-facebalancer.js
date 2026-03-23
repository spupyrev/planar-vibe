(function (global) {
  'use strict';

  var FACEBALANCER_REV = 'fb-edgeuniform-20260323';

  function faceKey(face) {
    if (!face || face.length === 0) return '';
    var arr = face.map(String);
    var n = arr.length;
    var best = null;
    for (var i = 0; i < n; i += 1) {
      var rot = arr.slice(i).concat(arr.slice(0, i)).join('|');
      if (best === null || rot < best) best = rot;
    }
    var rev = arr.slice().reverse();
    for (i = 0; i < n; i += 1) {
      var rrot = rev.slice(i).concat(rev.slice(0, i)).join('|');
      if (best === null || rrot < best) best = rrot;
    }
    return best || '';
  }

  function graphFromCy(cy) {
    return {
      nodeIds: cy.nodes().map(function (n) { return String(n.id()); }),
      edgePairs: cy.edges().map(function (e) {
        return [String(e.source().id()), String(e.target().id())];
      })
    };
  }

  function buildAdjacency(nodeIds, edgePairs) {
    var adj = {};
    for (var i = 0; i < nodeIds.length; i += 1) {
      adj[String(nodeIds[i])] = [];
    }
    for (i = 0; i < edgePairs.length; i += 1) {
      var u = String(edgePairs[i][0]);
      var v = String(edgePairs[i][1]);
      if (!adj[u]) adj[u] = [];
      if (!adj[v]) adj[v] = [];
      adj[u].push(v);
      adj[v].push(u);
    }
    return adj;
  }

  function copyPositions(pos) {
    var out = {};
    var keys = Object.keys(pos || {});
    for (var i = 0; i < keys.length; i += 1) {
      var k = keys[i];
      out[k] = { x: pos[k].x, y: pos[k].y };
    }
    return out;
  }

  function polygonArea2(face, posById) {
    if (!face || face.length < 3) return 0;
    var sum = 0;
    for (var i = 0; i < face.length; i += 1) {
      var a = posById[String(face[i])];
      var b = posById[String(face[(i + 1) % face.length])];
      if (!a || !b) return 0;
      sum += a.x * b.y - b.x * a.y;
    }
    return sum;
  }

  function orientFaceCCW(face, posById) {
    var out = face.slice().map(String);
    if (polygonArea2(out, posById) < 0) {
      out.reverse();
    }
    return out;
  }

  function dot(a, b) {
    var s = 0;
    for (var i = 0; i < a.length; i += 1) s += a[i] * b[i];
    return s;
  }

  function norm(a) {
    return Math.sqrt(dot(a, a));
  }

  function addScaled(a, b, alpha) {
    var out = new Array(a.length);
    for (var i = 0; i < a.length; i += 1) out[i] = a[i] + alpha * b[i];
    return out;
  }

  function subtractVec(a, b) {
    var out = new Array(a.length);
    for (var i = 0; i < a.length; i += 1) out[i] = a[i] - b[i];
    return out;
  }

  function scaleVec(a, alpha) {
    var out = new Array(a.length);
    for (var i = 0; i < a.length; i += 1) out[i] = alpha * a[i];
    return out;
  }

  function applyPositionsToCy(cy, nodeIds, posById) {
    var nodes = cy.nodes().toArray();
    for (var i = 0; i < nodes.length; i += 1) {
      var id = String(nodes[i].id());
      if (posById[id]) {
        nodes[i].position(posById[id]);
      }
    }
  }

  function waitForNextFrame(delayMs) {
    var delay = Math.max(0, Number(delayMs) || 0);
    return new Promise(function (resolve) {
      var schedule = (typeof global.setTimeout === 'function')
        ? global.setTimeout.bind(global)
        : (typeof setTimeout === 'function' ? setTimeout : null);
      if (!schedule) {
        resolve();
        return;
      }
      schedule(function () {
        var raf = (typeof global.requestAnimationFrame === 'function')
          ? global.requestAnimationFrame.bind(global)
          : (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null);
        if (raf) {
          raf(function () { resolve(); });
        } else {
          resolve();
        }
      }, delay);
    });
  }

  function buildInitialPositions(nodeIds, edgePairs, outerFace, cy) {
    function solveExactWeightedBarycentricLayout(input) {
      var ids = (input && input.nodeIds) ? input.nodeIds.map(String) : [];
      var adjacency = (input && input.adjacency) ? input.adjacency : {};
      var face = (input && input.outerFace) ? input.outerFace.map(String) : [];
      var initOptions = input && input.initOptions ? input.initOptions : {};
      var pos = global.PlanarVibeBarycentricCore.initOuterCoords(ids, face, initOptions);
      var outerSet = new Set(face);
      var interiorIds = [];
      var interiorIndexById = {};
      var i;
      var j;

      for (i = 0; i < ids.length; i += 1) {
        var id = String(ids[i]);
        if (!outerSet.has(id)) {
          interiorIndexById[id] = interiorIds.length;
          interiorIds.push(id);
        }
      }
      if (interiorIds.length === 0) {
        return { ok: true, pos: pos, iters: 0 };
      }

      var L = new Array(interiorIds.length);
      var bx = createZeroVector(interiorIds.length);
      var by = createZeroVector(interiorIds.length);
      for (i = 0; i < interiorIds.length; i += 1) {
        L[i] = createZeroVector(interiorIds.length);
        L[i][i] = 1;
        var neighbors = adjacency[interiorIds[i]] || [];
        if (neighbors.length === 0) {
          continue;
        }
        var weight = 1 / neighbors.length;
        for (j = 0; j < neighbors.length; j += 1) {
          var neighborId = String(neighbors[j]);
          var interiorIdx = interiorIndexById[neighborId];
          if (interiorIdx === undefined) {
            bx[i] += weight * pos[neighborId].x;
            by[i] += weight * pos[neighborId].y;
          } else {
            L[i][interiorIdx] -= weight;
          }
        }
      }

      var factor = luFactorize(L);
      if (!factor) {
        return { ok: false, message: 'Exact barycentric solve failed' };
      }
      var solved = solveLUWithTwoRhs(factor, bx, by);
      if (!solved) {
        return { ok: false, message: 'Exact barycentric solve failed' };
      }
      for (i = 0; i < interiorIds.length; i += 1) {
        pos[interiorIds[i]] = { x: solved.x1[i], y: solved.x2[i] };
      }
      return { ok: true, pos: pos, iters: 1 };
    }

    var adjacency = buildAdjacency(nodeIds, edgePairs);
    var seedPos = global.PlanarVibeBarycentricCore.currentPositionsFromCy
      ? global.PlanarVibeBarycentricCore.currentPositionsFromCy(cy)
      : {};
    return solveExactWeightedBarycentricLayout({
      nodeIds: nodeIds,
      adjacency: adjacency,
      outerFace: outerFace,
      initOptions: global.PlanarVibeBarycentricCore.defaultOuterInitOptions({
        useSeedOuter: false,
        seedPos: seedPos
      })
    });
  }

  function prepareAugmentedTriangulation(nodeIds, edgePairs, embedding, outerFace) {
    var augmented = global.PlanarGraphCore.prepareTriangulatedByFaceStellation(nodeIds, edgePairs, embedding, outerFace);
    if (!augmented || !augmented.ok) {
      return { ok: false, reason: (augmented && augmented.reason) || 'FaceBalancer augmentation failed' };
    }
    var dummyFaceVerticesById = augmented.dummyFaceVerticesById || {};
    var dummyFaceKeyById = {};
    var dummyIds = Object.keys(dummyFaceVerticesById);
    for (var i = 0; i < dummyIds.length; i += 1) {
      dummyFaceKeyById[String(dummyIds[i])] = faceKey(dummyFaceVerticesById[dummyIds[i]]);
    }
    return {
      ok: true,
      nodeIds: augmented.nodeIds.map(String),
      edgePairs: augmented.edgePairs.map(function (e) { return [String(e[0]), String(e[1])]; }),
      dummyCount: augmented.dummyCount || 0,
      dummyFaceKeyById: dummyFaceKeyById,
      dummyFaceVerticesById: dummyFaceVerticesById,
      embedding: augmented.embedding
    };
  }

  function originalFaceKeyForAugmentedFace(face, dummyFaceKeyById, dummyFaceVerticesById, seenDummyIds) {
    var seen = seenDummyIds || new Set();
    for (var i = 0; i < face.length; i += 1) {
      var vertexId = String(face[i]);
      if (dummyFaceVerticesById && Array.isArray(dummyFaceVerticesById[vertexId]) && !seen.has(vertexId)) {
        seen.add(vertexId);
        return originalFaceKeyForAugmentedFace(dummyFaceVerticesById[vertexId], dummyFaceKeyById, dummyFaceVerticesById, seen);
      }
      if (dummyFaceKeyById[vertexId]) {
        return dummyFaceKeyById[vertexId];
      }
    }
    return faceKey(face);
  }

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

  function cloneMatrix(A) {
    var out = new Array(A.length);
    for (var i = 0; i < A.length; i += 1) out[i] = A[i].slice();
    return out;
  }

  function luFactorize(A) {
    var n = A.length;
    var LU = cloneMatrix(A);
    var piv = new Array(n);
    for (var i = 0; i < n; i += 1) piv[i] = i;
    for (var k = 0; k < n; k += 1) {
      var pivotRow = k;
      var pivotValue = Math.abs(LU[k][k]);
      for (i = k + 1; i < n; i += 1) {
        var cand = Math.abs(LU[i][k]);
        if (cand > pivotValue) {
          pivotValue = cand;
          pivotRow = i;
        }
      }
      if (!(pivotValue > 1e-12)) return null;
      if (pivotRow !== k) {
        var tmpRow = LU[k];
        LU[k] = LU[pivotRow];
        LU[pivotRow] = tmpRow;
        var tmpPivot = piv[k];
        piv[k] = piv[pivotRow];
        piv[pivotRow] = tmpPivot;
      }
      for (i = k + 1; i < n; i += 1) {
        LU[i][k] /= LU[k][k];
        var factor = LU[i][k];
        for (var j = k + 1; j < n; j += 1) {
          LU[i][j] -= factor * LU[k][j];
        }
      }
    }
    return { LU: LU, piv: piv };
  }

  function solveLUWithTwoRhs(factor, b1, b2) {
    var n = b1.length;
    if (n === 0) return { x1: [], x2: [] };
    var LU = factor.LU;
    var piv = factor.piv;
    var y1 = new Array(n);
    var y2 = new Array(n);
    var i;
    var j;
    for (i = 0; i < n; i += 1) {
      y1[i] = b1[piv[i]];
      y2[i] = b2[piv[i]];
    }
    for (i = 0; i < n; i += 1) {
      for (j = 0; j < i; j += 1) {
        y1[i] -= LU[i][j] * y1[j];
        y2[i] -= LU[i][j] * y2[j];
      }
    }
    var x1 = new Array(n);
    var x2 = new Array(n);
    for (i = n - 1; i >= 0; i -= 1) {
      var sum1 = y1[i];
      var sum2 = y2[i];
      for (j = i + 1; j < n; j += 1) {
        sum1 -= LU[i][j] * x1[j];
        sum2 -= LU[i][j] * x2[j];
      }
      var diag = LU[i][i];
      if (!(Math.abs(diag) > 1e-12)) return null;
      x1[i] = sum1 / diag;
      x2[i] = sum2 / diag;
    }
    return { x1: x1, x2: x2 };
  }

  function solveTransposeLUWithTwoRhs(factor, b1, b2) {
    var n = b1.length;
    if (n === 0) return { x1: [], x2: [] };
    var LU = factor.LU;
    var piv = factor.piv;
    var z1 = new Array(n);
    var z2 = new Array(n);
    var i;
    var j;

    // Solve U^T z = b.
    for (i = 0; i < n; i += 1) {
      var sum1 = b1[i];
      var sum2 = b2[i];
      for (j = 0; j < i; j += 1) {
        sum1 -= LU[j][i] * z1[j];
        sum2 -= LU[j][i] * z2[j];
      }
      var diag = LU[i][i];
      if (!(Math.abs(diag) > 1e-12)) return null;
      z1[i] = sum1 / diag;
      z2[i] = sum2 / diag;
    }

    // Solve L^T w = z, noting that L has unit diagonal.
    var w1 = new Array(n);
    var w2 = new Array(n);
    for (i = n - 1; i >= 0; i -= 1) {
      var acc1 = z1[i];
      var acc2 = z2[i];
      for (j = i + 1; j < n; j += 1) {
        acc1 -= LU[j][i] * w1[j];
        acc2 -= LU[j][i] * w2[j];
      }
      w1[i] = acc1;
      w2[i] = acc2;
    }

    // Solve P x = w, i.e. x = P^T w.
    var x1 = new Array(n);
    var x2 = new Array(n);
    for (i = 0; i < n; i += 1) {
      x1[piv[i]] = w1[i];
      x2[piv[i]] = w2[i];
    }
    return { x1: x1, x2: x2 };
  }

  function buildFaceBalancerData(baseEmbedding, augmentedEmbedding, outerFace, dummyFaceKeyById, dummyFaceVerticesById, initPos, areaTol, faceBarrierWeight, edgeBarrierWeight, edgeUniformWeight, originalEdgePairs, minOriginalFaceArea, minOriginalEdgeLength2) {
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

    var outerOriginalKey = originalFaceKeyForAugmentedFace(outerFace, dummyFaceKeyById, dummyFaceVerticesById);

    var originalEdges = [];
    var edgeScaleSum = 0;
    var edgeScaleCount = 0;
    var initialMinOriginalEdgeLength2 = Infinity;
    for (i = 0; i < originalEdgePairs.length; i += 1) {
      var u = augIndexById[String(originalEdgePairs[i][0])];
      var v = augIndexById[String(originalEdgePairs[i][1])];
      if (u === undefined || v === undefined || u === v) continue;
      originalEdges.push([u, v]);
      var dx0 = x0[u] - x0[v];
      var dy0 = y0[u] - y0[v];
      var len20 = dx0 * dx0 + dy0 * dy0;
      if (len20 > 1e-12) {
        edgeScaleSum += len20;
        edgeScaleCount += 1;
        if (len20 < initialMinOriginalEdgeLength2) initialMinOriginalEdgeLength2 = len20;
      }
    }

    var originalFaceMinArea = Infinity;
    var originalFaceAreaSum = 0;
    var originalFaceCount = 0;
    for (i = 0; i < baseEmbedding.faces.length; i += 1) {
      var baseFace = baseEmbedding.faces[i];
      if (faceKey(baseFace) === outerOriginalKey) continue;
      var faceArea = Math.abs(polygonArea2(baseFace, initPos)) / 2;
      if (faceArea > 1e-12) {
        if (faceArea < originalFaceMinArea) originalFaceMinArea = faceArea;
        originalFaceAreaSum += faceArea;
        originalFaceCount += 1;
      }
    }

    var originalFaceKeys = [];
    var originalFaces = [];
    var originalFaceIndexByKey = {};
    for (i = 0; i < baseEmbedding.faces.length; i += 1) {
      var orientedBaseFace = orientFaceCCW(baseEmbedding.faces[i], initPos);
      var key = faceKey(orientedBaseFace);
      if (key === outerOriginalKey || originalFaceIndexByKey[key] !== undefined) continue;
      originalFaceIndexByKey[key] = originalFaceKeys.length;
      originalFaceKeys.push(key);
      originalFaces.push(orientedBaseFace.map(function (id) { return augIndexById[String(id)]; }));
    }

    var triangles = [];
    for (i = 0; i < augmentedEmbedding.faces.length; i += 1) {
      var face = augmentedEmbedding.faces[i];
      if (!face || face.length < 3) {
        return { ok: false, reason: 'FaceBalancer requires a valid triangulated augmentation' };
      }
      var oriented = orientFaceCCW(face, initPos);
      var originalKey = originalFaceKeyForAugmentedFace(oriented, dummyFaceKeyById, dummyFaceVerticesById);
      if (originalKey === outerOriginalKey) continue;
      if (face.length !== 3) {
        return { ok: false, reason: 'FaceBalancer requires all non-outer augmented faces to be triangles' };
      }
      var faceIdx = originalFaceIndexByKey[originalKey];
      if (faceIdx === undefined) {
        return { ok: false, reason: 'FaceBalancer face mapping failed for face ' + oriented.join(',') };
      }
      triangles.push([
        augIndexById[String(oriented[0])],
        augIndexById[String(oriented[1])],
        augIndexById[String(oriented[2])],
        faceIdx
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

    return {
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
      originalFaces: originalFaces,
      originalEdges: originalEdges,
      originalFaceKeys: originalFaceKeys,
      areaTol: Number.isFinite(areaTol) ? Math.max(0, areaTol) : 0,
      faceBarrierWeight: Number.isFinite(faceBarrierWeight) ? Math.max(0, faceBarrierWeight) : 0,
      edgeBarrierWeight: Number.isFinite(edgeBarrierWeight) ? Math.max(0, edgeBarrierWeight) : 0,
      edgeUniformWeight: Number.isFinite(edgeUniformWeight) ? Math.max(0, edgeUniformWeight) : 0,
      edgeBarrierScale2: edgeScaleCount > 0 ? (edgeScaleSum / edgeScaleCount) : 1,
      initialMinOriginalEdgeLength2: Number.isFinite(initialMinOriginalEdgeLength2) ? initialMinOriginalEdgeLength2 : 0,
      initialAvgOriginalFaceArea: originalFaceCount > 0 ? (originalFaceAreaSum / originalFaceCount) : 1,
      initialMinOriginalFaceArea: Number.isFinite(originalFaceMinArea) ? originalFaceMinArea : 0,
      minOriginalFaceArea: Number.isFinite(minOriginalFaceArea) ? Math.max(0, minOriginalFaceArea) : 0,
      minOriginalEdgeLength2: Number.isFinite(minOriginalEdgeLength2) ? Math.max(0, minOriginalEdgeLength2) : 0
    };
  }

  function createZeroVector(n) {
    var out = new Array(n);
    for (var i = 0; i < n; i += 1) out[i] = 0;
    return out;
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
    for (var i = 0; i < data.originalFaceKeys.length; i += 1) {
      out[data.originalFaceKeys[i]] = faceAreas[i];
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

  function orient2d(ax, ay, bx, by, cx, cy) {
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  }

  function pointOnSegmentInterior(ax, ay, bx, by, px, py, eps) {
    var tol = Number.isFinite(eps) ? Math.max(0, eps) : 1e-9;
    if (
      px < Math.min(ax, bx) - tol || px > Math.max(ax, bx) + tol ||
      py < Math.min(ay, by) - tol || py > Math.max(ay, by) + tol
    ) {
      return false;
    }
    if ((Math.abs(px - ax) <= tol && Math.abs(py - ay) <= tol) ||
        (Math.abs(px - bx) <= tol && Math.abs(py - by) <= tol)) {
      return false;
    }
    return true;
  }

  function segmentsIntersectStrict(ax, ay, bx, by, cx, cy, dx, dy, eps) {
    var tol = Number.isFinite(eps) ? Math.max(0, eps) : 1e-9;
    var o1 = orient2d(ax, ay, bx, by, cx, cy);
    var o2 = orient2d(ax, ay, bx, by, dx, dy);
    var o3 = orient2d(cx, cy, dx, dy, ax, ay);
    var o4 = orient2d(cx, cy, dx, dy, bx, by);

    if (((o1 > tol && o2 < -tol) || (o1 < -tol && o2 > tol)) &&
        ((o3 > tol && o4 < -tol) || (o3 < -tol && o4 > tol))) {
      return true;
    }
    return false;
  }

  function polygonHasSelfIntersection(faceIndices, x, y, eps) {
    if (!faceIndices || faceIndices.length < 4) return false;
    var n = faceIndices.length;
    for (var i = 0; i < n; i += 1) {
      var a0 = faceIndices[i];
      var a1 = faceIndices[(i + 1) % n];
      for (var j = i + 1; j < n; j += 1) {
        var nextI = (i + 1) % n;
        var nextJ = (j + 1) % n;
        if (i === j || i === nextJ || nextI === j) continue;
        if (i === 0 && nextJ === 0) continue;
        var b0 = faceIndices[j];
        var b1 = faceIndices[nextJ];
        if (segmentsIntersectStrict(
          x[a0], y[a0], x[a1], y[a1],
          x[b0], y[b0], x[b1], y[b1],
          eps
        )) {
          return true;
        }
      }
    }
    return false;
  }

  function graphHasEdgeCrossings(edgePairs, x, y, eps) {
    if (!edgePairs || edgePairs.length < 2) return false;
    for (var i = 0; i < edgePairs.length; i += 1) {
      var e1 = edgePairs[i];
      var a = e1[0];
      var b = e1[1];
      for (var j = i + 1; j < edgePairs.length; j += 1) {
        var e2 = edgePairs[j];
        var c = e2[0];
        var d = e2[1];
        if (a === c || a === d || b === c || b === d) continue;
        if (segmentsIntersectStrict(
          x[a], y[a], x[b], y[b],
          x[c], y[c], x[d], y[d],
          eps
        )) {
          return true;
        }
        var tol = Number.isFinite(eps) ? Math.max(0, eps) : 1e-9;
        if (Math.abs(orient2d(x[a], y[a], x[b], y[b], x[c], y[c])) <= tol &&
            pointOnSegmentInterior(x[a], y[a], x[b], y[b], x[c], y[c], tol)) {
          return true;
        }
        if (Math.abs(orient2d(x[a], y[a], x[b], y[b], x[d], y[d])) <= tol &&
            pointOnSegmentInterior(x[a], y[a], x[b], y[b], x[d], y[d], tol)) {
          return true;
        }
        if (Math.abs(orient2d(x[c], y[c], x[d], y[d], x[a], y[a])) <= tol &&
            pointOnSegmentInterior(x[c], y[c], x[d], y[d], x[a], y[a], tol)) {
          return true;
        }
        if (Math.abs(orient2d(x[c], y[c], x[d], y[d], x[b], y[b])) <= tol &&
            pointOnSegmentInterior(x[c], y[c], x[d], y[d], x[b], y[b], tol)) {
          return true;
        }
      }
    }
    return false;
  }

  function computeMoveStatsFromArrays(data, prevX, prevY, nextX, nextY, options) {
    var opts = options || {};
    var moveTol = Number.isFinite(opts.moveTol) && opts.moveTol >= 0 ? opts.moveTol : 1e-9;
    var movedVertices = 0;
    var totalMove = 0;
    var maxMove = 0;
    for (var i = 0; i < data.interiorAugIndices.length; i += 1) {
      var idx = data.interiorAugIndices[i];
      var dx = nextX[idx] - prevX[idx];
      var dy = nextY[idx] - prevY[idx];
      var dist = Math.hypot(dx, dy);
      totalMove += dist;
      if (dist > maxMove) {
        maxMove = dist;
      }
      if (dist > moveTol) {
        movedVertices += 1;
      }
    }
    return {
      movedVertices: movedVertices,
      totalMove: totalMove,
      avgMove: data.interiorAugIndices.length > 0 ? (totalMove / data.interiorAugIndices.length) : 0,
      maxMove: maxMove
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
    if (!factor) return { ok: false, reason: 'FaceBalancer linear solve failed' };
    var primal = solveLUWithTwoRhs(factor, bx, by);
    if (!primal) return { ok: false, reason: 'FaceBalancer linear solve failed' };

    var x = data.x0.slice();
    var y = data.y0.slice();
    for (i = 0; i < nI; i += 1) {
      var aug = data.interiorAugIndices[i];
      x[aug] = primal.x1[i];
      y[aug] = primal.x2[i];
    }

    var faceAreas = createZeroVector(data.originalFaceKeys.length);
    var totalArea = 0;
    for (i = 0; i < data.triangles.length; i += 1) {
      var tri = data.triangles[i];
      var a = tri[0];
      var b = tri[1];
      var c = tri[2];
      var area = 0.5 * ((x[b] - x[a]) * (y[c] - y[a]) - (x[c] - x[a]) * (y[b] - y[a]));
      if (!(area > -triangleSlack)) {
        return { ok: false, reason: 'invalid-triangulation-step' };
      }
      faceAreas[tri[3]] += area > triangleSlack ? area : triangleSlack;
    }
    for (i = 0; i < faceAreas.length; i += 1) {
      if (!(faceAreas[i] > data.minOriginalFaceArea)) {
        return { ok: false, reason: 'invalid-original-face-step' };
      }
    }
    for (i = 0; i < data.originalFaces.length; i += 1) {
      var boundary = data.originalFaces[i];
      if (polygonHasSelfIntersection(boundary, x, y, 1e-9)) {
        return { ok: false, reason: 'invalid-original-face-step' };
      }
      if (!(polygonArea2FromArrays(boundary, x, y) > 2 * data.areaTol)) {
        return { ok: false, reason: 'invalid-original-face-step' };
      }
    }
    for (i = 0; i < faceAreas.length; i += 1) totalArea += faceAreas[i];
    if (!(faceAreas.length > 0) || !(totalArea > 1e-12)) {
      return { ok: false, reason: 'FaceBalancer total bounded area is not positive' };
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
      for (i = 0; i < data.originalEdges.length; i += 1) {
        var edge = data.originalEdges[i];
        var u = edge[0];
        var v = edge[1];
        var dx = x[u] - x[v];
        var dy = y[u] - y[v];
        var len2 = dx * dx + dy * dy;
        var safeLen2 = len2 > edgeTol2 ? len2 : edgeTol2;
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

    if (edgeUniformWeight > 0 && data.originalEdges.length > 1) {
      var uniformTol2 = Math.max(1e-24, data.areaTol);
      var logLen2 = new Array(data.originalEdges.length);
      var logMean = 0;
      for (i = 0; i < data.originalEdges.length; i += 1) {
        edge = data.originalEdges[i];
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
      logMean /= data.originalEdges.length;
      var uniformScale = 2 * edgeUniformWeight / data.originalEdges.length;
      for (i = 0; i < data.originalEdges.length; i += 1) {
        edge = data.originalEdges[i];
        u = edge[0];
        v = edge[1];
        dx = x[u] - x[v];
        dy = y[u] - y[v];
        len2 = dx * dx + dy * dy;
        safeLen2 = len2 > uniformTol2 ? len2 : uniformTol2;
        var centeredLogLen2 = logLen2[i] - logMean;
        E += edgeUniformWeight * centeredLogLen2 * centeredLogLen2 / data.originalEdges.length;
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

    if (data.minOriginalEdgeLength2 > 0) {
      for (i = 0; i < data.originalEdges.length; i += 1) {
        var originalEdge = data.originalEdges[i];
        var ox = x[originalEdge[0]] - x[originalEdge[1]];
        var oy = y[originalEdge[0]] - y[originalEdge[1]];
        if (!(ox * ox + oy * oy > data.minOriginalEdgeLength2)) {
          return { ok: false, reason: 'invalid-original-edge-step' };
        }
      }
    }
    if (graphHasEdgeCrossings(data.originalEdges, x, y, 1e-9)) {
      return { ok: false, reason: 'invalid-original-face-step' };
    }

    var adjoint = solveTransposeLUWithTwoRhs(factor, zX, zY);
    if (!adjoint) return { ok: false, reason: 'FaceBalancer adjoint solve failed' };

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

    return {
      ok: true,
      E: E,
      gradVec: gradVec,
      gradNorm: norm(gradVec),
      x: x,
      y: y,
      faceAreas: faceAreas,
      maxRelError: maxRelError
    };
  }

  function lbfgsDirection(g, S, Y, Rho) {
    var m = S.length;
    var alpha = new Array(m);
    var q = g.slice();
    for (var i = m - 1; i >= 0; i -= 1) {
      alpha[i] = Rho[i] * dot(S[i], q);
      q = subtractVec(q, scaleVec(Y[i], alpha[i]));
    }
    var gamma = 1;
    if (m > 0) {
      var denom = dot(Y[m - 1], Y[m - 1]);
      if (denom > 1e-14) gamma = dot(S[m - 1], Y[m - 1]) / denom;
    }
    var r = scaleVec(q, gamma);
    for (i = 0; i < m; i += 1) {
      var beta = Rho[i] * dot(Y[i], r);
      r = addScaled(r, S[i], alpha[i] - beta);
    }
    return scaleVec(r, -1);
  }

  function optimizeTheta(q0, data, opts) {
    var maxIters = Number.isFinite(opts.maxIters) ? Math.max(1, Math.floor(opts.maxIters)) : 80;
    var gradTol = Number.isFinite(opts.gradTol) ? Math.max(0, opts.gradTol) : 1e-5;
    var stepTol = Number.isFinite(opts.stepTol) ? Math.max(0, opts.stepTol) : 1e-10;
    var memory = Number.isFinite(opts.lbfgsMemory) ? Math.max(1, Math.floor(opts.lbfgsMemory)) : 10;
    var lineSearchC1 = Number.isFinite(opts.lineSearchC1) ? Math.max(0, opts.lineSearchC1) : 1e-4;
    var lineSearchTau = Number.isFinite(opts.lineSearchTau) ? Math.min(0.9, Math.max(0.1, opts.lineSearchTau)) : 0.5;
    var q = q0.slice();
    var current = evaluateObjectiveAndGradient(q, data);
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

    for (var iter = 1; iter <= maxIters; iter += 1) {
      if (current.gradNorm <= gradTol) {
        stopReason = 'grad-converged';
        break;
      }

      var prevX = current.x;
      var prevY = current.y;
      var d = lbfgsDirection(current.gradVec, S, Y, Rho);
      if (!(dot(current.gradVec, d) < 0)) d = scaleVec(current.gradVec, -1);

      var alpha = 1.0;
      var accepted = null;
      var gtd = dot(current.gradVec, d);
      while (alpha >= 1e-12) {
        var qTrial = addScaled(q, d, alpha);
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

      var s = subtractVec(accepted.q, q);
      var y = subtractVec(accepted.eval.gradVec, current.gradVec);
      var stepNorm = norm(s);
      q = accepted.q;
      current = accepted.eval;
      if (current.E < best.E) {
        best = current;
        bestQ = q.slice();
      }

      if (movementTracker) {
        movementStatus = movementTracker.update(
          computeMoveStatsFromArrays(data, prevX, prevY, current.x, current.y, { moveTol: 1e-9 }),
          iter
        );
      }

      if (onIteration) {
        onIteration({
          iter: iter,
          maxIters: maxIters,
          objective: current.E,
          gradNorm: current.gradNorm,
          maxRelError: current.maxRelError,
          positions: buildPositionMap(data, current.x, current.y),
          stableIterCount: movementStatus.stableIterations,
          stableIterLimit: movementStatus.stableIterLimit
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

      var ys = dot(y, s);
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

    return {
      ok: true,
      q: bestQ,
      pos: buildPositionMap(data, best.x, best.y),
      E: best.E,
      gradNorm: best.gradNorm,
      faceAreas: buildFaceAreaMap(data, best.faceAreas),
      maxRelError: best.maxRelError,
      stopReason: stopReason
    };
  }

  async function applyFaceBalancerLayout(cy, options) {
    var opts = options || {};
    var interactive = opts.interactive !== false;
    var delayMs = Number.isFinite(opts.delayMs) ? Math.max(0, opts.delayMs) : 0;
    var renderEvery = Number.isFinite(opts.renderEvery) ? Math.max(1, Math.floor(opts.renderEvery)) : 2;
    var maxIters = Number.isFinite(opts.maxIters) ? Math.max(1, Math.floor(opts.maxIters)) : 80;

    if (!global.PlanarVibePlanarityTest || !global.PlanarVibePlanarityTest.computePlanarEmbedding) {
      return { ok: false, message: 'Planarity utilities are missing. Check script load order' };
    }
    if (!global.PlanarGraphCore || !global.PlanarGraphCore.prepareTriangulatedByFaceStellation) {
      return { ok: false, message: 'Planar graph utilities are missing. Check script load order' };
    }
    if (!global.PlanarVibeBarycentricCore ||
        !global.PlanarVibeBarycentricCore.buildUniformWeights ||
        !global.PlanarVibeBarycentricCore.solveWeightedBarycentricLayout ||
        !global.PlanarVibeBarycentricCore.defaultOuterInitOptions) {
      return { ok: false, message: 'Barycentric core is missing. Check script load order' };
    }

    var g = graphFromCy(cy);
    if (g.nodeIds.length < 3) {
      return { ok: false, message: 'FaceBalancer requires at least 3 vertices' };
    }
    var baseEmbedding = global.PlanarVibePlanarityTest.computePlanarEmbedding(g.nodeIds, g.edgePairs);
    if (!baseEmbedding || !baseEmbedding.ok) {
      return { ok: false, message: 'FaceBalancer requires a planar graph' };
    }

    var outerFace = global.PlanarGraphCore.chooseOuterFaceFromEmbedding(baseEmbedding);
    if (!outerFace || outerFace.length < 3) {
      return { ok: false, message: 'Could not determine outer boundary for FaceBalancer layout' };
    }
    var augmented = prepareAugmentedTriangulation(g.nodeIds, g.edgePairs, baseEmbedding, outerFace);
    if (!augmented.ok) {
      return { ok: false, message: augmented.reason || 'FaceBalancer augmentation failed' };
    }
    var init = buildInitialPositions(augmented.nodeIds, augmented.edgePairs, outerFace, cy);
    if (!init || !init.ok || !init.pos) {
      return { ok: false, message: (init && init.message) || 'FaceBalancer initialization failed' };
    }

    var initPos = (global.PlanarGraphCore && typeof global.PlanarGraphCore.alignOuterFaceEdgeHorizontally === 'function')
      ? global.PlanarGraphCore.alignOuterFaceEdgeHorizontally(init.pos, outerFace)
      : copyPositions(init.pos);
    var areaTol = Number.isFinite(opts.areaTol) && opts.areaTol >= 0
      ? opts.areaTol
      : 1e-15;
    var data = buildFaceBalancerData(
      baseEmbedding,
      augmented.embedding,
      outerFace,
      augmented.dummyFaceKeyById,
      augmented.dummyFaceVerticesById,
      initPos,
      areaTol,
      Number.isFinite(opts.faceBarrierWeight) ? Math.max(0, opts.faceBarrierWeight) : 0.2,
      Number.isFinite(opts.edgeBarrierWeight) ? Math.max(0, opts.edgeBarrierWeight) : 0.05,
      Number.isFinite(opts.edgeUniformWeight) ? Math.max(0, opts.edgeUniformWeight) : 0.02,
      g.edgePairs,
      Number.isFinite(opts.minOriginalFaceArea) && opts.minOriginalFaceArea >= 0 ? opts.minOriginalFaceArea : 0,
      Number.isFinite(opts.minOriginalEdgeLength2) && opts.minOriginalEdgeLength2 >= 0 ? opts.minOriginalEdgeLength2 : 0
    );
    if (!(data.initialAvgOriginalFaceArea > 0)) {
      return { ok: false, message: 'FaceBalancer setup failed' };
    }
    if (!data.ok) {
      return { ok: false, message: data.reason || 'FaceBalancer setup failed' };
    }
    if (!(Number.isFinite(opts.minOriginalFaceArea) && opts.minOriginalFaceArea >= 0)) {
      data.minOriginalFaceArea = Math.max(0, 0.25 * data.initialMinOriginalFaceArea);
    }
    if (!(Number.isFinite(opts.minOriginalEdgeLength2) && opts.minOriginalEdgeLength2 >= 0)) {
      data.minOriginalEdgeLength2 = 0;
    }
    if (data.originalFaceKeys.length === 0) {
      applyPositionsToCy(cy, g.nodeIds, initPos);
      cy.fit(undefined, 24);
      return { ok: true, message: 'Applied FaceBalancer (no bounded faces to balance)' };
    }

    var q0 = createZeroVector(data.qSize);
    var movementScale = (global.PlanarGraphCore && typeof global.PlanarGraphCore.computeDrawingDiameter === 'function')
      ? global.PlanarGraphCore.computeDrawingDiameter(augmented.nodeIds, initPos)
      : 1;
    var movementTracker = (global.PlanarGraphCore && typeof global.PlanarGraphCore.createMovementConvergenceTracker === 'function')
      ? global.PlanarGraphCore.createMovementConvergenceTracker({
        minItersBeforeStop: Number.isFinite(opts.minItersBeforeStop)
          ? Math.max(1, Math.floor(opts.minItersBeforeStop))
          : Math.max(20, Math.min(maxIters, 40)),
        stableIterLimit: Number.isFinite(opts.stableIterLimit) ? Math.max(1, Math.floor(opts.stableIterLimit)) : 8,
        maxMoveTol: Number.isFinite(opts.movementStopTol) && opts.movementStopTol >= 0 ? opts.movementStopTol : 1e-6 * movementScale,
        avgMoveTol: Number.isFinite(opts.avgMovementStopTol) && opts.avgMovementStopTol >= 0 ? opts.avgMovementStopTol : 2e-7 * movementScale
      })
      : null;

    var iterationCount = 0;
    var didFit = false;
    if (interactive) {
      applyPositionsToCy(cy, g.nodeIds, initPos);
      cy.fit(undefined, 24);
      didFit = true;
      await waitForNextFrame(delayMs);
    }

    var result = optimizeTheta(q0, data, {
      maxIters: maxIters,
      gradTol: Number.isFinite(opts.gradTol) ? Math.max(0, opts.gradTol) : 1e-5,
      stepTol: Number.isFinite(opts.stepTol) ? Math.max(0, opts.stepTol) : 1e-6,
      lbfgsMemory: Number.isFinite(opts.lbfgsMemory) ? Math.max(1, Math.floor(opts.lbfgsMemory)) : 10,
      movementTracker: movementTracker,
      onIteration: function (progress) {
        iterationCount = progress.iter;
        if (typeof opts.onIteration === 'function') opts.onIteration(progress);
        if (interactive && (progress.iter % renderEvery === 0 || progress.iter === 1)) {
          applyPositionsToCy(cy, g.nodeIds, progress.positions);
          if (!didFit) {
            cy.fit(undefined, 24);
            didFit = true;
          }
        }
      }
    });
    if (!result.ok) {
      return { ok: false, message: result.reason || 'FaceBalancer optimization failed' };
    }

    applyPositionsToCy(cy, g.nodeIds, result.pos);
    if (!didFit) cy.fit(undefined, 24);
    var hasCrossings = global.PlanarVibeMetrics && typeof global.PlanarVibeMetrics.hasCrossingsFromPositions === 'function'
      ? global.PlanarVibeMetrics.hasCrossingsFromPositions(result.pos, g.edgePairs)
      : false;
    if (hasCrossings) {
      return {
        ok: false,
        stopReason: result.stopReason,
        message: 'FaceBalancer [' + FACEBALANCER_REV + '] produced a non-plane drawing'
      };
    }
    var faceScore = global.PlanarVibeMetrics && global.PlanarVibeMetrics.computeUniformFaceAreaScore
      ? global.PlanarVibeMetrics.computeUniformFaceAreaScore(g.nodeIds, g.edgePairs, result.pos)
      : null;
    return {
      ok: true,
      stopReason: result.stopReason,
      faceAreaScore: faceScore && faceScore.ok ? faceScore.quality : null,
      message: 'Applied FaceBalancer [' + FACEBALANCER_REV + '] (' + data.originalFaceKeys.length + ' bounded faces, +' + augmented.dummyCount + ' dummy, ' +
        iterationCount + ' iters, ' + result.stopReason + ', obj ' + result.E.toFixed(3) + ')'
    };
  }

  global.PlanarVibeFaceBalancer = {
    applyFaceBalancerLayout: applyFaceBalancerLayout
  };
})(window);
