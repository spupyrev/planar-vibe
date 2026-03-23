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

  function outerFaceDiameter(posById, outerFace) {
    var face = Array.isArray(outerFace) ? outerFace : [];
    var diameter = 0;
    for (var i = 0; i < face.length; i += 1) {
      var vi = posById[String(face[i])];
      if (!vi || !Number.isFinite(vi.x) || !Number.isFinite(vi.y)) {
        continue;
      }
      for (var j = i + 1; j < face.length; j += 1) {
        var vj = posById[String(face[j])];
        if (!vj || !Number.isFinite(vj.x) || !Number.isFinite(vj.y)) {
          continue;
        }
        var dx = vi.x - vj.x;
        var dy = vi.y - vj.y;
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > diameter) {
          diameter = dist;
        }
      }
    }
    return diameter > 1e-12 ? diameter : 1;
  }

  function prepareAugmentedTriangulation(nodeIds, edgePairs, embedding, outerFace) {
    var augmented = global.PlanarGraphCore.prepareTriangulatedByFaceStellation(nodeIds, edgePairs, embedding, outerFace);
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
      tolerance: 1e-7,
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
      if (!face || face.length < 3) {
        return { ok: false, reason: 'Air requires a valid triangulated augmentation' };
      }

      var oriented = orientFaceCCW(face, posById);
      var originalKey = originalFaceKeyForAugmentedFace(oriented, dummyFaceKeyById, dummyFaceVerticesById);
      if (originalKey === outerOriginalKey) {
        continue;
      }
      if (face.length !== 3) {
        return { ok: false, reason: 'Air requires all non-outer augmented faces to be triangles' };
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

  function originalDrawingHasCrossings(posById, edgePairs) {
    return !!(global.PlanarVibeMetrics &&
      typeof global.PlanarVibeMetrics.hasCrossingsFromPositions === 'function' &&
      global.PlanarVibeMetrics.hasCrossingsFromPositions(posById, edgePairs));
  }

  function normalizeAirOptions(options) {
    var opts = options || {};
    return {
      interactive: opts.interactive !== false,
      maxSweeps: Number.isFinite(opts.maxSweeps) ? Math.max(1, Math.floor(opts.maxSweeps)) : 200,
      maxNewtonIter: Number.isFinite(opts.maxNewtonIter) ? Math.max(1, Math.floor(opts.maxNewtonIter)) : 40,
      tolForceGlobal: Number.isFinite(opts.tolForceGlobal) ? Math.max(0, opts.tolForceGlobal) : 1e-8,
      tolForceVertex: Number.isFinite(opts.tolForceVertex) ? Math.max(0, opts.tolForceVertex) : 1e-10,
      tolAreaGlobal: Number.isFinite(opts.tolAreaGlobal) ? Math.max(0, opts.tolAreaGlobal) : 1e-3,
      tolAreaPositive: Number.isFinite(opts.tolAreaPositive) ? Math.max(0, opts.tolAreaPositive) : 1e-15,
      tolMove: Number.isFinite(opts.tolMove) ? Math.max(0, opts.tolMove) : 1e-12,
      armijo: Number.isFinite(opts.armijo) ? Math.max(0, opts.armijo) : 1e-4,
      minStep: Number.isFinite(opts.minStep) && opts.minStep > 0 ? opts.minStep : Math.pow(2, -40),
      delayMs: Number.isFinite(opts.delayMs) ? Math.max(0, opts.delayMs) : 0,
      onIteration: typeof opts.onIteration === 'function' ? opts.onIteration : null,
      yieldEvery: Number.isFinite(opts.yieldEvery) ? Math.max(1, Math.floor(opts.yieldEvery)) : 5,
      renderEvery: Number.isFinite(opts.renderEvery) ? Math.max(1, Math.floor(opts.renderEvery)) : 4,
      moveTolRel: Number.isFinite(opts.moveTolRel) && opts.moveTolRel >= 0 ? opts.moveTolRel : 1e-5,
      moveTolAbs: Number.isFinite(opts.moveTolAbs) && opts.moveTolAbs >= 0 ? opts.moveTolAbs : 1e-12,
      errTolRel: Number.isFinite(opts.errTolRel) && opts.errTolRel >= 0 ? opts.errTolRel : 1e-4,
      patience: Number.isFinite(opts.patience) ? Math.max(1, Math.floor(opts.patience)) : 2,
      deadlockPatience: Number.isFinite(opts.deadlockPatience) ? Math.max(1, Math.floor(opts.deadlockPatience)) : 2,
      plateauWindow: Number.isFinite(opts.plateauWindow) ? Math.max(2, Math.floor(opts.plateauWindow)) : 12,
      plateauPatience: Number.isFinite(opts.plateauPatience) ? Math.max(1, Math.floor(opts.plateauPatience)) : 1,
      plateauErrTolAbs: Number.isFinite(opts.plateauErrTolAbs) && opts.plateauErrTolAbs >= 0 ? opts.plateauErrTolAbs : null,
      plateauErrTolRel: Number.isFinite(opts.plateauErrTolRel) && opts.plateauErrTolRel >= 0 ? opts.plateauErrTolRel : null,
      plateauErrGuardFactor: Number.isFinite(opts.plateauErrGuardFactor) && opts.plateauErrGuardFactor > 0 ? opts.plateauErrGuardFactor : 20
    };
  }

  function prepareAirFromGeneralPlaneGraph(cy, options) {
    var opts = normalizeAirOptions(options);
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

    var originalOuterFace = global.PlanarGraphCore.chooseOuterFaceFromEmbedding(baseEmbedding);
    if (!originalOuterFace || originalOuterFace.length < 3) {
      return { ok: false, message: 'Could not determine outer boundary for Air layout' };
    }
    var augmented = prepareAugmentedTriangulation(g.nodeIds, g.edgePairs, baseEmbedding, originalOuterFace);
    if (!augmented.ok) {
      return { ok: false, message: augmented.reason || 'Air augmentation failed' };
    }

    var init = buildInitialPositions(augmented.nodeIds, augmented.edgePairs, originalOuterFace, cy);
    if (!init || !init.ok || !init.pos) {
      return { ok: false, message: (init && init.message) || 'Air initialization failed' };
    }

    var posById = (global.PlanarGraphCore && typeof global.PlanarGraphCore.alignOuterFaceEdgeHorizontally === 'function')
      ? global.PlanarGraphCore.alignOuterFaceEdgeHorizontally(init.pos, originalOuterFace)
      : copyPositions(init.pos);
    var airData = buildAirData(baseEmbedding, augmented.embedding, originalOuterFace, augmented.dummyFaceKeyById, augmented.dummyFaceVerticesById, posById);
    if (!airData.ok) {
      return { ok: false, message: airData.reason || 'Air setup failed' };
    }

    if (airData.originalFaceKeys.length === 0) {
      return {
        ok: true,
        opts: opts,
        graph: g,
        baseEmbedding: baseEmbedding,
        outerFace: originalOuterFace,
        augmented: augmented,
        posById: posById,
        airData: airData,
        movableVertices: []
      };
    }

    for (var fi = 0; fi < airData.triangles.length; fi += 1) {
      var tri = airData.triangles[fi];
      var area = Math.abs(triangleArea2(posById[tri.vertices[0]], posById[tri.vertices[1]], posById[tri.vertices[2]])) / 2;
      if (!(area > opts.tolAreaPositive)) {
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

    return {
      ok: true,
      opts: opts,
      graph: g,
      baseEmbedding: baseEmbedding,
      outerFace: originalOuterFace,
      augmented: augmented,
      posById: posById,
      airData: airData,
      movableVertices: movableVertices
    };
  }

  async function solveAirTriangulation(prepared, options) {
    var opts = Object.assign({}, prepared && prepared.opts ? prepared.opts : {}, options || {});
    var g = prepared.graph;
    var posById = prepared.posById;
    var airData = prepared.airData;
    var movableVertices = prepared.movableVertices || [];
    var status = 'max_sweeps';
    var lastStats = computeAirStats(airData, posById, movableVertices, opts.tolAreaPositive);
    var outerDiameter = outerFaceDiameter(posById, airData.outerFace || prepared.outerFace || []);
    var moveTol = opts.moveTolAbs + opts.moveTolRel * outerDiameter;
    var avgMoveTol = 0.25 * moveTol;
    var plateauErrTolAbs = opts.plateauErrTolAbs !== null ? opts.plateauErrTolAbs : opts.tolAreaGlobal;
    var plateauErrTolRel = opts.plateauErrTolRel !== null ? opts.plateauErrTolRel : 5 * opts.errTolRel;
    var plateauErrGuard = opts.plateauErrGuardFactor * opts.tolAreaGlobal;
    var prevMaxRelErr = lastStats.maxRelError;
    var stalledSweeps = 0;
    var deadSweeps = 0;
    var plateauSweeps = 0;
    var errWindow = [prevMaxRelErr];
    var lastMoveStats = { movedVertices: 0, avgMove: 0, maxMove: 0, acceptedCount: 0 };

    if (prevMaxRelErr <= opts.tolAreaGlobal) {
      lastStats.maxMove = 0;
      lastStats.avgMove = 0;
      lastStats.acceptedCount = 0;
      lastStats.sweeps = 0;
      return {
        ok: !originalDrawingHasCrossings(posById, g.edgePairs),
        status: 'realized',
        positions: posById,
        stats: lastStats,
        moveStats: lastMoveStats,
        boundedFaceCount: airData.originalFaceKeys.length,
        dummyCount: prepared.augmented ? prepared.augmented.dummyCount : 0,
        hasCrossings: originalDrawingHasCrossings(posById, g.edgePairs)
      };
    }

    for (var sweep = 1; sweep <= opts.maxSweeps; sweep += 1) {
      var prevSweepPos = copyPositions(posById);
      var acceptedCount = 0;
      var sumMove = 0;
      var maxMove = 0;

      for (var vi = 0; vi < movableVertices.length; vi += 1) {
        var v = movableVertices[vi];
        var currentState = evaluateLocalState(airData.incident[v] || [], airData.triangles, posById, posById[v], opts.tolAreaPositive);
        var currentForce = currentState.feasible ? norm(currentState.force) : Infinity;
        if (currentForce <= opts.tolForceGlobal) {
          continue;
        }

        var solved = solveBalancedPosition(v, airData, posById, {
          maxNewtonIter: opts.maxNewtonIter,
          tolForceVertex: opts.tolForceVertex,
          tolAreaPositive: opts.tolAreaPositive,
          armijo: opts.armijo,
          minStep: opts.minStep
        });
        if (!solved || !solved.pos) {
          continue;
        }
        var basePos = { x: posById[v].x, y: posById[v].y };
        var dx = solved.pos.x - basePos.x;
        var dy = solved.pos.y - basePos.y;
        var acceptedPos = null;
        var stepScale = 1;
        while (stepScale >= opts.minStep) {
          var candidate = {
            x: basePos.x + stepScale * dx,
            y: basePos.y + stepScale * dy
          };
          var candidateState = evaluateLocalState(airData.incident[v] || [], airData.triangles, posById, candidate, opts.tolAreaPositive);
          if (candidateState.feasible) {
            posById[v] = candidate;
            if (!originalDrawingHasCrossings(posById, g.edgePairs)) {
              acceptedPos = candidate;
              break;
            }
          }
          posById[v] = basePos;
          stepScale *= 0.5;
        }
        if (acceptedPos) {
          posById[v] = acceptedPos;
          var moveDx = acceptedPos.x - basePos.x;
          var moveDy = acceptedPos.y - basePos.y;
          var move = Math.sqrt(moveDx * moveDx + moveDy * moveDy);
          if (move > maxMove) {
            maxMove = move;
          }
          sumMove += move;
          acceptedCount += 1;
        } else {
          posById[v] = basePos;
        }
      }

      lastMoveStats = (global.PlanarGraphCore && typeof global.PlanarGraphCore.computePositionMoveStats === 'function')
        ? global.PlanarGraphCore.computePositionMoveStats(movableVertices, prevSweepPos, posById, { moveTol: opts.tolMove })
        : { movedVertices: 0, avgMove: 0, maxMove: 0 };
      lastMoveStats.maxMove = maxMove;
      lastMoveStats.avgMove = acceptedCount > 0 ? (sumMove / acceptedCount) : 0;
      lastMoveStats.acceptedCount = acceptedCount;
      lastStats = computeAirStats(airData, posById, movableVertices, opts.tolAreaPositive);
      var maxRelErr = lastStats.maxRelError;
      var improvement = prevMaxRelErr - maxRelErr;
      var relImprovement = improvement / Math.max(1, prevMaxRelErr);
      errWindow.push(maxRelErr);
      if (errWindow.length > opts.plateauWindow + 1) {
        errWindow.shift();
      }
      var plateauWindowImprovementAbs = null;
      var plateauWindowImprovementRel = null;
      if (errWindow.length >= opts.plateauWindow + 1) {
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
      if (opts.onIteration) {
        opts.onIteration({
          iter: sweep,
          maxIters: opts.maxSweeps,
          maxRelError: maxRelErr,
          maxForce: lastStats.maxForce,
          balancedCount: lastStats.balancedCount,
          positions: posById,
          movedVertices: acceptedCount,
          maxMove: lastMoveStats.maxMove,
          avgMove: lastMoveStats.avgMove,
          stableIterCount: stalledSweeps,
          stableIterLimit: opts.patience,
          acceptedCount: acceptedCount,
          deadSweepCount: deadSweeps,
          plateauSweepCount: plateauSweeps,
          plateauPatience: opts.plateauPatience,
          plateauWindow: opts.plateauWindow,
          plateauWindowImprovementAbs: plateauWindowImprovementAbs,
          plateauWindowImprovementRel: plateauWindowImprovementRel,
          boundedFaceCount: lastStats.boundedFaceCount
        });
      }
      if (typeof opts.onSweepComplete === 'function') {
        await opts.onSweepComplete({
          iter: sweep,
          maxIters: opts.maxSweeps,
          status: status,
          positions: posById,
          stats: lastStats,
          moveStats: lastMoveStats,
          acceptedCount: acceptedCount,
          plateauSweepCount: plateauSweeps,
          boundedFaceCount: lastStats.boundedFaceCount
        });
      }

      if (maxRelErr <= opts.tolAreaGlobal) {
        status = 'realized';
        break;
      }

      if (acceptedCount === 0) {
        deadSweeps += 1;
      } else {
        deadSweeps = 0;
      }
      if (deadSweeps >= opts.deadlockPatience) {
        status = 'deadlock';
        break;
      }

      if (lastMoveStats.maxMove <= moveTol &&
          lastMoveStats.avgMove <= avgMoveTol &&
          relImprovement <= opts.errTolRel) {
        stalledSweeps += 1;
      } else {
        stalledSweeps = 0;
      }
      if (stalledSweeps >= opts.patience) {
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
      if (plateauSweeps >= opts.plateauPatience) {
        status = 'stalled';
        break;
      }

      prevMaxRelErr = maxRelErr;
    }

    return {
      ok: !originalDrawingHasCrossings(posById, g.edgePairs),
      status: status,
      positions: posById,
      stats: lastStats,
      moveStats: lastMoveStats,
      boundedFaceCount: airData.originalFaceKeys.length,
      dummyCount: prepared.augmented ? prepared.augmented.dummyCount : 0,
      hasCrossings: originalDrawingHasCrossings(posById, g.edgePairs)
    };
  }

  async function applyAirLayout(cy, options) {
    var prepared = prepareAirFromGeneralPlaneGraph(cy, options);
    if (!prepared || !prepared.ok) {
      return prepared || { ok: false, message: 'Air setup failed' };
    }

    if (prepared.airData.originalFaceKeys.length === 0) {
      applyPositionsToCy(cy, prepared.graph.nodeIds, prepared.posById);
      cy.fit(undefined, 24);
      return { ok: true, message: 'Applied Air (no bounded faces to balance)' };
    }

    var opts = prepared.opts;
    var didFit = false;
    if (opts.interactive) {
      applyPositionsToCy(cy, prepared.graph.nodeIds, prepared.posById);
      cy.fit(undefined, 24);
      didFit = true;
      await waitForNextFrame(opts.delayMs);
    }

    var solveResult = await solveAirTriangulation(prepared, Object.assign({}, opts, {
      onSweepComplete: async function (event) {
        if (opts.interactive &&
            (event.iter % opts.renderEvery === 0 || event.iter === 1 || event.iter === event.maxIters)) {
          applyPositionsToCy(cy, prepared.graph.nodeIds, prepared.posById);
          if (!didFit) {
            cy.fit(undefined, 24);
            didFit = true;
          }
          await waitForNextFrame(opts.delayMs);
        } else if ((opts.onIteration || opts.delayMs > 0) &&
            (event.iter % opts.yieldEvery === 0 || event.iter === event.maxIters)) {
          await waitForNextFrame(opts.delayMs);
        }
      }
    }));
    var status = solveResult.status;
    var lastStats = solveResult.stats;

    applyPositionsToCy(cy, prepared.graph.nodeIds, prepared.posById);
    if (!didFit) {
      cy.fit(undefined, 24);
    }
    if (solveResult.hasCrossings) {
      return {
        ok: false,
        status: status,
        message: 'Air produced a non-plane drawing',
        maxRelError: lastStats ? lastStats.maxRelError : null,
        boundedFaceCount: prepared.airData.originalFaceKeys.length,
        dummyCount: prepared.augmented.dummyCount
      };
    }

    var faceScore = null;
    if (global.PlanarVibeMetrics && global.PlanarVibeMetrics.computeUniformFaceAreaScore) {
      faceScore = global.PlanarVibeMetrics.computeUniformFaceAreaScore(prepared.graph.nodeIds, prepared.graph.edgePairs, prepared.posById);
    }

    var message = 'Applied Air (' + prepared.airData.originalFaceKeys.length + ' bounded faces, ' +
      prepared.airData.triangles.length + ' triangles';
    if (prepared.augmented.dummyCount > 0) {
      message += ', +' + prepared.augmented.dummyCount + ' dummy';
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
      boundedFaceCount: prepared.airData.originalFaceKeys.length,
      dummyCount: prepared.augmented.dummyCount
    };
  }

  global.PlanarVibeAir = {
    prepareAirFromGeneralPlaneGraph: prepareAirFromGeneralPlaneGraph,
    solveAirTriangulation: solveAirTriangulation,
    applyAirLayout: applyAirLayout
  };
})(window);
