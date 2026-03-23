(function (global) {
  'use strict';

  function edgeKey(u, v) {
    var a = String(u);
    var b = String(v);
    return a < b ? a + '::' + b : b + '::' + a;
  }

  function faceKey(face) {
    if (!face || face.length === 0) return '';
    var arr = face.map(String);
    var n = arr.length;
    var best = null;
    var i;
    for (i = 0; i < n; i += 1) {
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

  function findOuterFaceIndex(faces, outerFace) {
    if (!faces || !outerFace || faces.length === 0 || outerFace.length === 0) {
      return -1;
    }
    var target = faceKey(outerFace);
    for (var i = 0; i < faces.length; i += 1) {
      if (faceKey(faces[i]) === target) {
        return i;
      }
    }
    return -1;
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

  function triangleArea2(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
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

  function copyPositions(pos) {
    var out = {};
    var keys = Object.keys(pos || {});
    for (var i = 0; i < keys.length; i += 1) {
      var k = keys[i];
      out[k] = { x: pos[k].x, y: pos[k].y };
    }
    return out;
  }

  function add(p, q) {
    return { x: p.x + q.x, y: p.y + q.y };
  }

  function sub(p, q) {
    return { x: p.x - q.x, y: p.y - q.y };
  }

  function mul(s, p) {
    return { x: s * p.x, y: s * p.y };
  }

  function dot(p, q) {
    return p.x * q.x + p.y * q.y;
  }

  function rot90(p) {
    return { x: -p.y, y: p.x };
  }

  function norm(p) {
    return Math.sqrt(dot(p, p));
  }

  function prepareAugmentedTriangulation(nodeIds, edgePairs, embedding) {
    var augmented = global.PlanarGraphCore.prepareTriangulatedByFaceStellation(nodeIds, edgePairs, embedding);
    if (!augmented || !augmented.ok) {
      return { ok: false, reason: (augmented && augmented.reason) || 'Air augmentation failed' };
    }
    var embAug = augmented.embedding;
    var dummyFaceKeyById = {};
    var dummyFaceVerticesById = augmented.dummyFaceVerticesById || {};
    var dummyIds = Object.keys(dummyFaceVerticesById);
    for (var i = 0; i < dummyIds.length; i += 1) {
      dummyFaceKeyById[String(dummyIds[i])] = faceKey(dummyFaceVerticesById[dummyIds[i]]);
    }
    return {
      ok: true,
      nodeIds: augmented.nodeIds,
      edgePairs: augmented.edgePairs,
      dummyCount: augmented.dummyCount,
      dummyFaceKeyById: dummyFaceKeyById,
      dummyFaceVerticesById: dummyFaceVerticesById,
      embedding: embAug
    };
  }

  function buildInitialPositions(nodeIds, edgePairs, outerFace, cy) {
    var adjacency = buildAdjacency(nodeIds, edgePairs);
    var weights = global.PlanarVibeBarycentricCore.buildUniformWeights(edgePairs, 1);
    var seedPos = global.PlanarVibeBarycentricCore.currentPositionsFromCy(cy);
    return global.PlanarVibeBarycentricCore.solveWeightedBarycentricLayout({
      nodeIds: nodeIds,
      adjacency: adjacency,
      outerFace: outerFace,
      weights: weights,
      maxIters: 1000,
      tolerance: 1e-6,
      initOptions: global.PlanarVibeBarycentricCore.defaultOuterInitOptions({
        useSeedOuter: false,
        seedPos: seedPos
      })
    });
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

  function buildAirData(baseEmbedding, augmentedEmbedding, outerFace, dummyFaceKeyById, dummyFaceVerticesById, posById) {
    var outerOriginalKey = originalFaceKeyForAugmentedFace(outerFace, dummyFaceKeyById, dummyFaceVerticesById);
    var originalFaceKeys = [];
    var originalFaceSet = new Set();
    var i;

    for (i = 0; i < baseEmbedding.faces.length; i += 1) {
      var baseKey = faceKey(baseEmbedding.faces[i]);
      if (baseKey === outerOriginalKey) continue;
      if (!originalFaceSet.has(baseKey)) {
        originalFaceSet.add(baseKey);
        originalFaceKeys.push(baseKey);
      }
    }

    var triangles = [];
    var incident = {};
    var triangleCountByOriginal = {};

    for (i = 0; i < augmentedEmbedding.idByIndex.length; i += 1) {
      incident[String(augmentedEmbedding.idByIndex[i])] = [];
    }

    for (i = 0; i < augmentedEmbedding.faces.length; i += 1) {
      var face = augmentedEmbedding.faces[i];
      if (!face || face.length !== 3) {
        return { ok: false, reason: 'Air requires a fully triangulated augmentation' };
      }

      var oriented = orientFaceCCW(face, posById);
      var originalKey = originalFaceKeyForAugmentedFace(oriented, dummyFaceKeyById, dummyFaceVerticesById);
      if (originalKey === outerOriginalKey) {
        continue;
      }
      if (!originalFaceSet.has(originalKey)) {
        return { ok: false, reason: 'Air face mapping failed for face ' + oriented.join(',') };
      }

      var triangleIndex = triangles.length;
      triangles.push({
        vertices: oriented,
        originalKey: originalKey,
        targetArea: 0
      });
      triangleCountByOriginal[originalKey] = (triangleCountByOriginal[originalKey] || 0) + 1;

      for (var j = 0; j < 3; j += 1) {
        var v = String(oriented[j]);
        incident[v].push({
          faceIndex: triangleIndex,
          left: String(oriented[(j + 2) % 3]),
          right: String(oriented[(j + 1) % 3])
        });
      }
    }

    if (originalFaceKeys.length === 0 || triangles.length === 0) {
      return {
        ok: true,
        originalFaceKeys: [],
        triangles: triangles,
        incident: incident,
        desiredOriginalArea: 0
      };
    }

    var outerArea = Math.abs(polygonArea2(outerFace, posById)) / 2;
    if (!(outerArea > 1e-12)) {
      return { ok: false, reason: 'Air initialization failed: outer face has zero area' };
    }
    var desiredOriginalArea = outerArea / originalFaceKeys.length;
    for (i = 0; i < triangles.length; i += 1) {
      var original = triangles[i].originalKey;
      var cnt = triangleCountByOriginal[original] || 1;
      triangles[i].targetArea = desiredOriginalArea / cnt;
    }

    return {
      ok: true,
      outerFace: outerFace.slice().map(String),
      originalFaceKeys: originalFaceKeys,
      triangles: triangles,
      incident: incident,
      desiredOriginalArea: desiredOriginalArea
    };
  }

  function evaluateLocalState(entries, triangles, posById, point, tolAreaPositive) {
    var areas = [];
    var feasible = true;
    var force = { x: 0, y: 0 };
    var entropy = 0;
    var a = 0;
    var b = 0;
    var c = 0;

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

      var s = sub(leftPos, rightPos);
      var r = rot90(s);
      var delta = sub(point, rightPos);
      var area = 0.5 * (s.x * delta.y - s.y * delta.x);
      areas.push(area);
      if (!(area > tolAreaPositive)) {
        feasible = false;
        continue;
      }

      var pressure = tri.targetArea / area;
      force.x += pressure * r.x;
      force.y += pressure * r.y;
      entropy += -tri.targetArea * Math.log(Math.max(pressure, 1e-300));

      var coeff = -0.25 * tri.targetArea / (area * area);
      a += coeff * r.x * r.x;
      b += coeff * r.x * r.y;
      c += coeff * r.y * r.y;
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
    var entries = airData.incident[vertexId] || [];
    var maxNewtonIter = opts.maxNewtonIter;
    var tolForceVertex = opts.tolForceVertex;
    var tolAreaPositive = opts.tolAreaPositive;
    var armijo = opts.armijo;
    var minStep = opts.minStep;

    for (var iter = 0; iter < maxNewtonIter; iter += 1) {
      var state = evaluateLocalState(entries, airData.triangles, posById, p, tolAreaPositive);
      if (!state.feasible) {
        return { pos: p, forceNorm: Infinity, stalled: true };
      }

      var forceNorm = norm(state.force);
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

      if (dot(g, d) <= 0) {
        d = { x: g.x, y: g.y };
      }

      var alpha = 1;
      var accepted = false;
      while (alpha >= minStep) {
        var q = add(p, mul(alpha, d));
        var qState = evaluateLocalState(entries, airData.triangles, posById, q, tolAreaPositive);
        if (qState.feasible &&
            qState.entropy >= state.entropy + armijo * alpha * dot(g, d)) {
          p = q;
          accepted = true;
          break;
        }
        alpha *= 0.5;
      }

      if (!accepted) {
        return { pos: p, forceNorm: forceNorm, stalled: true };
      }
    }

    var finalState = evaluateLocalState(entries, airData.triangles, posById, p, tolAreaPositive);
    return {
      pos: p,
      forceNorm: finalState.feasible ? norm(finalState.force) : Infinity,
      stalled: false
    };
  }

  function computeOriginalFaceAreas(airData, posById) {
    var sums = {};
    for (var i = 0; i < airData.originalFaceKeys.length; i += 1) {
      sums[airData.originalFaceKeys[i]] = 0;
    }
    for (i = 0; i < airData.triangles.length; i += 1) {
      var tri = airData.triangles[i];
      var a = posById[tri.vertices[0]];
      var b = posById[tri.vertices[1]];
      var c = posById[tri.vertices[2]];
      if (!a || !b || !c) continue;
      var area = Math.abs(triangleArea2(a, b, c)) / 2;
      if (!Number.isFinite(area)) area = 0;
      sums[tri.originalKey] = (sums[tri.originalKey] || 0) + area;
    }
    return sums;
  }

  function computeAirStats(airData, posById, movableVertices, tolAreaPositive) {
    var faceAreas = computeOriginalFaceAreas(airData, posById);
    var maxRelError = 0;
    for (var i = 0; i < airData.originalFaceKeys.length; i += 1) {
      var key = airData.originalFaceKeys[i];
      var area = faceAreas[key] || 0;
      var rel = Math.abs(area - airData.desiredOriginalArea) / Math.max(airData.desiredOriginalArea, 1e-12);
      if (!Number.isFinite(rel)) rel = Infinity;
      if (rel > maxRelError) {
        maxRelError = rel;
      }
    }

    var maxForce = 0;
    var balancedCount = 0;
    for (i = 0; i < movableVertices.length; i += 1) {
      var v = movableVertices[i];
      var state = evaluateLocalState(airData.incident[v] || [], airData.triangles, posById, posById[v], tolAreaPositive);
      var f = state.feasible ? norm(state.force) : Infinity;
      if (f > maxForce) {
        maxForce = f;
      }
      if (f <= 1e-8) {
        balancedCount += 1;
      }
    }

    return {
      maxRelError: maxRelError,
      maxForce: maxForce,
      balancedCount: balancedCount,
      boundedFaceCount: airData.originalFaceKeys.length
    };
  }

  function applyPositionsToCy(cy, nodeIds, posById) {
    for (var i = 0; i < nodeIds.length; i += 1) {
      var nodeId = String(nodeIds[i]);
      var node = cy.getElementById ? cy.getElementById(nodeId) : null;
      if (!node || typeof node.position !== 'function') {
        var arr = cy.nodes();
        for (var j = 0; j < arr.length; j += 1) {
          if (String(arr[j].id()) === nodeId) {
            node = arr[j];
            break;
          }
        }
      }
      if (node && posById[nodeId]) {
        node.position({ x: posById[nodeId].x, y: posById[nodeId].y });
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

  async function applyAirLayout(cy, options) {
    var opts = options || {};
    var interactive = opts.interactive !== false;
    var maxSweeps = Number.isFinite(opts.maxSweeps) ? Math.max(1, Math.floor(opts.maxSweeps)) : 250;
    var maxNewtonIter = Number.isFinite(opts.maxNewtonIter) ? Math.max(1, Math.floor(opts.maxNewtonIter)) : 40;
    var tolForceGlobal = Number.isFinite(opts.tolForceGlobal) ? Math.max(0, opts.tolForceGlobal) : 1e-8;
    var tolForceVertex = Number.isFinite(opts.tolForceVertex) ? Math.max(0, opts.tolForceVertex) : 1e-10;
    var tolAreaGlobal = Number.isFinite(opts.tolAreaGlobal) ? Math.max(0, opts.tolAreaGlobal) : 1e-5;
    var tolAreaPositive = Number.isFinite(opts.tolAreaPositive) ? Math.max(0, opts.tolAreaPositive) : 1e-12;
    var tolMove = Number.isFinite(opts.tolMove) ? Math.max(0, opts.tolMove) : 1e-12;
    var armijo = Number.isFinite(opts.armijo) ? Math.max(0, opts.armijo) : 1e-4;
    var minStep = Number.isFinite(opts.minStep) && opts.minStep > 0 ? opts.minStep : Math.pow(2, -40);
    var delayMs = Number.isFinite(opts.delayMs) ? Math.max(0, opts.delayMs) : 0;
    var onIteration = typeof opts.onIteration === 'function' ? opts.onIteration : null;
    var yieldEvery = Number.isFinite(opts.yieldEvery) ? Math.max(1, Math.floor(opts.yieldEvery)) : 5;
    var renderEvery = Number.isFinite(opts.renderEvery) ? Math.max(1, Math.floor(opts.renderEvery)) : 4;

    if (!global.PlanarVibePlanarityTest || !global.PlanarVibePlanarityTest.computePlanarEmbedding) {
      return { ok: false, message: 'Planarity utilities are missing. Check script load order' };
    }
    if (!global.PlanarGraphCore || !global.PlanarGraphCore.prepareTriangulatedByFaceStellation) {
      return { ok: false, message: 'Planar graph utilities are missing. Check script load order' };
    }
    if (!global.PlanarVibeBarycentricCore ||
        !global.PlanarVibeBarycentricCore.buildUniformWeights ||
        !global.PlanarVibeBarycentricCore.solveWeightedBarycentricLayout ||
        !global.PlanarVibeBarycentricCore.currentPositionsFromCy) {
      return { ok: false, message: 'Barycentric core is missing. Check script load order' };
    }

    var g = graphFromCy(cy);
    if (g.nodeIds.length < 3) {
      return { ok: false, message: 'Air layout requires at least 3 vertices' };
    }

    var baseEmbedding = global.PlanarVibePlanarityTest.computePlanarEmbedding(g.nodeIds, g.edgePairs);
    if (!baseEmbedding || !baseEmbedding.ok) {
      return { ok: false, message: 'Air layout requires a planar graph' };
    }

    var augmented = prepareAugmentedTriangulation(g.nodeIds, g.edgePairs, baseEmbedding);
    if (!augmented.ok) {
      return { ok: false, message: augmented.reason || 'Air augmentation failed' };
    }
    var originalOuterFace = global.PlanarGraphCore.chooseOuterFaceFromEmbedding(baseEmbedding);
    if (!originalOuterFace || originalOuterFace.length < 3) {
      return { ok: false, message: 'Could not determine outer boundary for Air layout' };
    }

    var init = buildInitialPositions(augmented.nodeIds, augmented.edgePairs, originalOuterFace, cy);
    if (!init || !init.ok || !init.pos) {
      return { ok: false, message: (init && init.message) || 'Air initialization failed' };
    }

    var posById = copyPositions(init.pos);
    var airData = buildAirData(baseEmbedding, augmented.embedding, originalOuterFace, augmented.dummyFaceKeyById, augmented.dummyFaceVerticesById, posById);
    if (!airData.ok) {
      return { ok: false, message: airData.reason || 'Air setup failed' };
    }

    if (airData.originalFaceKeys.length === 0) {
      applyPositionsToCy(cy, g.nodeIds, posById);
      cy.fit(undefined, 24);
      return { ok: true, message: 'Applied Air (no bounded faces to balance)' };
    }

    for (var fi = 0; fi < airData.triangles.length; fi += 1) {
      var tri = airData.triangles[fi];
      var area = Math.abs(triangleArea2(posById[tri.vertices[0]], posById[tri.vertices[1]], posById[tri.vertices[2]])) / 2;
      if (!(area > tolAreaPositive)) {
        return { ok: false, message: 'Air initialization failed: degenerate augmented triangle' };
      }
    }

    var outerSet = new Set(originalOuterFace.map(String));
    var movableVertices = [];
    for (var ni = 0; ni < augmented.nodeIds.length; ni += 1) {
      var nodeId = String(augmented.nodeIds[ni]);
      if (!outerSet.has(nodeId) && airData.incident[nodeId] && airData.incident[nodeId].length > 0) {
        movableVertices.push(nodeId);
      }
    }

    var movementScale = (global.PlanarGraphCore && typeof global.PlanarGraphCore.computeDrawingDiameter === 'function')
      ? global.PlanarGraphCore.computeDrawingDiameter(augmented.nodeIds, posById)
      : 1;
    var movementTracker = (global.PlanarGraphCore && typeof global.PlanarGraphCore.createMovementConvergenceTracker === 'function')
      ? global.PlanarGraphCore.createMovementConvergenceTracker({
        minItersBeforeStop: Number.isFinite(opts.minItersBeforeStop) ? Math.max(1, Math.floor(opts.minItersBeforeStop)) : 8,
        stableIterLimit: Number.isFinite(opts.stableIterLimit) ? Math.max(1, Math.floor(opts.stableIterLimit)) : 4,
        maxMoveTol: Number.isFinite(opts.movementStopTol) && opts.movementStopTol >= 0 ? opts.movementStopTol : 1e-4 * movementScale,
        avgMoveTol: Number.isFinite(opts.avgMovementStopTol) && opts.avgMovementStopTol >= 0 ? opts.avgMovementStopTol : 2e-5 * movementScale
      })
      : null;

    var status = 'max_sweeps';
    var lastStats = computeAirStats(airData, posById, movableVertices, tolAreaPositive);
    var didFit = false;
    if (interactive) {
      applyPositionsToCy(cy, g.nodeIds, posById);
      cy.fit(undefined, 24);
      didFit = true;
      await waitForNextFrame(delayMs);
    }
    for (var sweep = 1; sweep <= maxSweeps; sweep += 1) {
      var prevSweepPos = copyPositions(posById);

      for (var vi = 0; vi < movableVertices.length; vi += 1) {
        var v = movableVertices[vi];
        var currentState = evaluateLocalState(airData.incident[v] || [], airData.triangles, posById, posById[v], tolAreaPositive);
        var currentForce = currentState.feasible ? norm(currentState.force) : Infinity;
        if (currentForce <= tolForceGlobal) {
          continue;
        }

        var solved = solveBalancedPosition(v, airData, posById, {
          maxNewtonIter: maxNewtonIter,
          tolForceVertex: tolForceVertex,
          tolAreaPositive: tolAreaPositive,
          armijo: armijo,
          minStep: minStep
        });
        if (!solved || !solved.pos) {
          continue;
        }
        var dx = solved.pos.x - posById[v].x;
        var dy = solved.pos.y - posById[v].y;
        var move = Math.sqrt(dx * dx + dy * dy);
        posById[v] = { x: solved.pos.x, y: solved.pos.y };
      }

      var moveStats = (global.PlanarGraphCore && typeof global.PlanarGraphCore.computePositionMoveStats === 'function')
        ? global.PlanarGraphCore.computePositionMoveStats(movableVertices, prevSweepPos, posById, { moveTol: tolMove })
        : { movedVertices: 0, avgMove: 0, maxMove: 0 };
      var movementStatus = movementTracker ? movementTracker.update({
        maxMove: moveStats.maxMove,
        avgMove: moveStats.avgMove
      }, sweep) : { stableIterations: 0, stableIterLimit: 0, converged: false };
      lastStats = computeAirStats(airData, posById, movableVertices, tolAreaPositive);
      if (onIteration) {
        onIteration({
          iter: sweep,
          maxIters: maxSweeps,
          maxRelError: lastStats.maxRelError,
          maxForce: lastStats.maxForce,
          balancedCount: lastStats.balancedCount,
          positions: posById,
          movedVertices: moveStats.movedVertices,
          maxMove: moveStats.maxMove,
          avgMove: moveStats.avgMove,
          stableIterCount: movementStatus.stableIterations,
          stableIterLimit: movementStatus.stableIterLimit,
          boundedFaceCount: lastStats.boundedFaceCount
        });
      }
      if (interactive && (sweep % renderEvery === 0 || sweep === 1 || sweep === maxSweeps)) {
        applyPositionsToCy(cy, g.nodeIds, posById);
        if (!didFit) {
          cy.fit(undefined, 24);
          didFit = true;
        }
        await waitForNextFrame(delayMs);
      } else if ((onIteration || delayMs > 0) && (sweep % yieldEvery === 0 || sweep === maxSweeps)) {
        await waitForNextFrame(delayMs);
      }

      if (lastStats.maxRelError <= tolAreaGlobal) {
        status = 'realized';
        break;
      }
      if (lastStats.maxForce <= tolForceGlobal) {
        status = 'deadlock';
        break;
      }
      if (movementStatus.converged) {
        status = movementStatus.reason || 'movement-converged';
        break;
      }
      if (moveStats.movedVertices === 0) {
        status = 'stalled';
        break;
      }
    }

    applyPositionsToCy(cy, g.nodeIds, posById);
    if (!didFit) {
      cy.fit(undefined, 24);
    }

    var faceScore = null;
    if (global.PlanarVibeMetrics && global.PlanarVibeMetrics.computeUniformFaceAreaScore) {
      faceScore = global.PlanarVibeMetrics.computeUniformFaceAreaScore(g.nodeIds, g.edgePairs, posById);
    }

    var message = 'Applied Air (' + airData.originalFaceKeys.length + ' bounded faces, ' +
      airData.triangles.length + ' triangles';
    if (augmented.dummyCount > 0) {
      message += ', +' + augmented.dummyCount + ' dummy';
    }
    message += ', status ' + status;
    if (lastStats && Number.isFinite(lastStats.maxRelError)) {
      message += ', max rel err ' + lastStats.maxRelError.toFixed(3);
    }
    if (faceScore && faceScore.ok && Number.isFinite(faceScore.quality)) {
      message += ', face score ' + faceScore.quality.toFixed(3);
    }
    message += ')';

    return {
      ok: true,
      status: status,
      message: message,
      faceAreaScore: faceScore && faceScore.ok ? faceScore.quality : null,
      maxRelError: lastStats ? lastStats.maxRelError : null,
      boundedFaceCount: airData.originalFaceKeys.length,
      dummyCount: augmented.dummyCount
    };
  }

  global.PlanarVibeAir = {
    applyAirLayout: applyAirLayout
  };
})(window);
