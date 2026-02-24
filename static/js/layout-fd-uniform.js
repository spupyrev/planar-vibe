(function (global) {
  'use strict';

  function canonicalEdgeKey(u, v) {
    var a = String(u);
    var b = String(v);
    return a < b ? a + '::' + b : b + '::' + a;
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

  function pointEquals(a, b, eps) {
    return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
  }

  function onSegment(a, b, p, eps) {
    return (
      Math.min(a.x, b.x) - eps <= p.x && p.x <= Math.max(a.x, b.x) + eps &&
      Math.min(a.y, b.y) - eps <= p.y && p.y <= Math.max(a.y, b.y) + eps
    );
  }

  function segmentsIntersectProper(a, b, c, d, eps) {
    var o1 = triangleArea2(a, b, c);
    var o2 = triangleArea2(a, b, d);
    var o3 = triangleArea2(c, d, a);
    var o4 = triangleArea2(c, d, b);

    if (((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps)) &&
        ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps))) {
      return true;
    }

    if (Math.abs(o1) <= eps && onSegment(a, b, c, eps) && !pointEquals(c, a, eps) && !pointEquals(c, b, eps)) return true;
    if (Math.abs(o2) <= eps && onSegment(a, b, d, eps) && !pointEquals(d, a, eps) && !pointEquals(d, b, eps)) return true;
    if (Math.abs(o3) <= eps && onSegment(c, d, a, eps) && !pointEquals(a, c, eps) && !pointEquals(a, d, eps)) return true;
    if (Math.abs(o4) <= eps && onSegment(c, d, b, eps) && !pointEquals(b, c, eps) && !pointEquals(b, d, eps)) return true;
    return false;
  }

  function wouldIntroduceCrossing(vertexId, newPos, positions, edgePairs, incidentEdges, eps) {
    var v = String(vertexId);
    var changed = incidentEdges[v] || [];
    if (changed.length === 0) {
      return false;
    }

    for (var i = 0; i < changed.length; i += 1) {
      var e = changed[i];
      var u = String(e[0]);
      var w = String(e[1]);
      var other = u === v ? w : u;
      var p1 = newPos;
      var q1 = positions[other];
      if (!q1) {
        continue;
      }

      for (var j = 0; j < edgePairs.length; j += 1) {
        var a = String(edgePairs[j][0]);
        var b = String(edgePairs[j][1]);
        if (a === v || b === v || a === other || b === other) {
          continue;
        }
        var p2 = positions[a];
        var q2 = positions[b];
        if (!p2 || !q2) {
          continue;
        }
        if (segmentsIntersectProper(p1, q1, p2, q2, eps)) {
          return true;
        }
      }
    }
    return false;
  }

  function median(values) {
    if (!values || values.length === 0) {
      return 1;
    }
    var arr = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(arr.length / 2);
    if (arr.length % 2 === 1) {
      return arr[mid];
    }
    return 0.5 * (arr[mid - 1] + arr[mid]);
  }

  function computeDrawingDiameter(nodeIds, pos) {
    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    for (var i = 0; i < nodeIds.length; i += 1) {
      var p = pos[String(nodeIds[i])];
      if (!p) {
        continue;
      }
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return 1;
    }
    var dx = maxX - minX;
    var dy = maxY - minY;
    var d = Math.sqrt(dx * dx + dy * dy);
    return d > 1e-9 ? d : 1;
  }

  function copyPositions(pos) {
    var out = {};
    var keys = Object.keys(pos);
    for (var i = 0; i < keys.length; i += 1) {
      var k = keys[i];
      out[k] = { x: pos[k].x, y: pos[k].y };
    }
    return out;
  }

  function computeNearestNeighborData(nodeIds, pos, kNearest) {
    var nnById = {};
    var knearestById = {};
    var sum = 0;
    var cnt = 0;
    var sumK = 0;
    var cntK = 0;
    var k = Number.isFinite(kNearest) ? Math.max(1, Math.floor(kNearest)) : 3;
    for (var i = 0; i < nodeIds.length; i += 1) {
      var v = String(nodeIds[i]);
      var pv = pos[v];
      if (!pv) {
        continue;
      }
      var bestId = null;
      var bestDist = Infinity;
      var candidates = [];
      for (var j = 0; j < nodeIds.length; j += 1) {
        if (i === j) continue;
        var u = String(nodeIds[j]);
        var pu = pos[u];
        if (!pu) {
          continue;
        }
        var dx = pv.x - pu.x;
        var dy = pv.y - pu.y;
        var d = Math.sqrt(dx * dx + dy * dy);
        candidates.push({ id: u, dist: d });
        if (d < bestDist) {
          bestDist = d;
          bestId = u;
        }
      }
      if (bestId !== null && Number.isFinite(bestDist)) {
        nnById[v] = { id: bestId, dist: bestDist };
        if (bestDist > 1e-12) {
          sum += bestDist;
          cnt += 1;
        }
      }
      candidates.sort(function (a, b) { return a.dist - b.dist; });
      var localK = [];
      var kk = Math.min(k, candidates.length);
      for (var c = 0; c < kk; c += 1) {
        localK.push(candidates[c]);
        if (candidates[c].dist > 1e-12) {
          sumK += candidates[c].dist;
          cntK += 1;
        }
      }
      knearestById[v] = localK;
    }
    return {
      nnById: nnById,
      meanDist: cnt > 0 ? (sum / cnt) : 0,
      knearestById: knearestById,
      meanKDist: cntK > 0 ? (sumK / cntK) : 0
    };
  }

  function applyPositionsToCy(cy, nodeIds, pos) {
    for (var i = 0; i < nodeIds.length; i += 1) {
      var nodeId = String(nodeIds[i]);
      var node = cy.getElementById ? cy.getElementById(nodeId) : null;
      if (!node || typeof node.position !== 'function') {
        var arr = cy.nodes();
        for (var t = 0; t < arr.length; t += 1) {
          if (String(arr[t].id()) === nodeId) {
            node = arr[t];
            break;
          }
        }
      }
      if (node && pos[nodeId]) {
        node.position({ x: pos[nodeId].x, y: pos[nodeId].y });
      }
    }
  }

  function evaluateSpacingQuality(nodeIds, edgePairs, pos) {
    if (!global.PlanarVibeMetrics || typeof global.PlanarVibeMetrics.computeSpacingUniformityScore !== 'function') {
      return null;
    }
    if (global.PlanarVibeMetrics.hasCrossingsFromPositions &&
        global.PlanarVibeMetrics.hasCrossingsFromPositions(pos, edgePairs)) {
      return null;
    }
    var score = global.PlanarVibeMetrics.computeSpacingUniformityScore(nodeIds, pos);
    if (!score || !score.ok || !Number.isFinite(score.score)) {
      return null;
    }
    return score.score;
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

  function applyFDUniformLayout(cy, options) {
    var opts = options || {};
    var EPS = Number.isFinite(opts.epsilon) ? Math.max(1e-12, opts.epsilon) : 1e-9;
    var repEps = Number.isFinite(opts.repulsionEps) ? Math.max(1e-12, opts.repulsionEps) : 1e-6;
    var repPower = Number.isFinite(opts.repulsionPower) ? Math.max(1, opts.repulsionPower) : 2;
    var maxIters = Number.isFinite(opts.maxIters) ? Math.max(1, Math.floor(opts.maxIters)) : 800;
    var beta = Number.isFinite(opts.beta) ? Math.max(0, opts.beta) : 0.45;
    var alpha0 = Number.isFinite(opts.alpha) ? Math.max(0, opts.alpha) : 1.2;
    var alpha = alpha0;
    var alphaGrowEvery = Number.isFinite(opts.alphaGrowEvery) ? Math.max(1, Math.floor(opts.alphaGrowEvery)) : 120;
    var alphaGrowFactor = Number.isFinite(opts.alphaGrowFactor) ? Math.max(1, opts.alphaGrowFactor) : 1.15;
    var alphaCap = Number.isFinite(opts.alphaCap) ? Math.max(alpha0, opts.alphaCap) : 4.0;
    var gamma = Number.isFinite(opts.stepDecay) ? Math.min(0.95, Math.max(0.1, opts.stepDecay)) : 0.5;
    var maxForce = Number.isFinite(opts.maxForce) ? Math.max(1e-6, opts.maxForce) : 9.0;
    var eta = Number.isFinite(opts.eta) ? Math.max(0, opts.eta) : 1.2;
    var zeta = Number.isFinite(opts.zeta) ? Math.max(0, opts.zeta) : 3.2;
    var collisionBoost = Number.isFinite(opts.collisionBoost) ? Math.max(0, opts.collisionBoost) : 6.0;
    var kNearest = Number.isFinite(opts.kNearest) ? Math.max(1, Math.floor(opts.kNearest)) : 4;
    var interactive = !!opts.interactive;
    var useSeedOuter = (typeof opts.useSeedOuter === 'boolean') ? opts.useSeedOuter : true;
    var evalEvery = Number.isFinite(opts.evalEvery) ? Math.max(1, Math.floor(opts.evalEvery)) : 10;
    var delayMs = Number.isFinite(opts.delayMs) ? Math.max(0, Math.floor(opts.delayMs)) : 0;
    var renderEvery = Number.isFinite(opts.renderEvery) ? Math.max(1, Math.floor(opts.renderEvery)) : 5;
    var onIteration = typeof opts.onIteration === 'function' ? opts.onIteration : null;

    if (!global.PlanarVibePlanarityTest || !global.PlanarVibePlanarityTest.computePlanarEmbedding) {
      return { ok: false, message: 'Planarity utilities are missing' };
    }
    if (!global.PlanarVibeBarycentricCore || !global.PlanarVibeBarycentricCore.solveWeightedBarycentricLayout) {
      return { ok: false, message: 'Barycentric core is missing' };
    }

    var nodeIds = cy.nodes().map(function (n) { return String(n.id()); });
    if (nodeIds.length < 3) {
      return { ok: false, message: 'FD-uniform requires at least 3 vertices' };
    }
    var edgePairs = cy.edges().map(function (e) {
      return [String(e.source().id()), String(e.target().id())];
    });
    if (edgePairs.length < 3) {
      return { ok: false, message: 'FD-uniform requires at least 3 edges' };
    }

    var emb = global.PlanarVibePlanarityTest.computePlanarEmbedding(nodeIds, edgePairs);
    if (!emb || !emb.ok) {
      return { ok: false, message: 'FD-uniform requires a planar graph' };
    }

    var outerFace = (emb.outerFace && emb.outerFace.length >= 3) ? emb.outerFace.slice().map(String) : null;
    if (!outerFace) {
      return { ok: false, message: 'Could not determine outer face' };
    }

    var augmentedNodeIds = nodeIds.slice();
    var augmentedEdgePairs = edgePairs.slice();
    if (global.PlanarGraphCore && global.PlanarGraphCore.augmentByFaceStellation) {
      var aug = global.PlanarGraphCore.augmentByFaceStellation(nodeIds, edgePairs, emb);
      if (aug && aug.nodeIds && aug.edgePairs) {
        augmentedNodeIds = aug.nodeIds.map(String);
        augmentedEdgePairs = aug.edgePairs.map(function (e) { return [String(e[0]), String(e[1])]; });
      }
    }

    var adjacencyAug = buildAdjacency(augmentedNodeIds, augmentedEdgePairs);
    var uniformWeights = global.PlanarVibeBarycentricCore.buildUniformWeights(augmentedEdgePairs, 1);
    var seedPos = (global.PlanarVibeBarycentricCore && global.PlanarVibeBarycentricCore.currentPositionsFromCy)
      ? global.PlanarVibeBarycentricCore.currentPositionsFromCy(cy)
      : {};
    var initial = global.PlanarVibeBarycentricCore.solveWeightedBarycentricLayout({
      nodeIds: augmentedNodeIds,
      adjacency: adjacencyAug,
      outerFace: outerFace,
      weights: uniformWeights,
      maxIters: Number.isFinite(opts.initMaxIters) ? Math.max(10, Math.floor(opts.initMaxIters)) : 1200,
      tolerance: Number.isFinite(opts.initTolerance) ? Math.max(1e-10, opts.initTolerance) : 1e-7,
      initOptions: {
        useSeedOuter: useSeedOuter,
        seedPos: seedPos,
        defaultCenterX: 2000,
        defaultCenterY: 2000,
        defaultRadius: 1000
      }
    });
    if (!initial || !initial.ok || !initial.pos) {
      return { ok: false, message: 'Initial barycentric embedding failed' };
    }

    var pos = copyPositions(initial.pos);
    var adjOrig = buildAdjacency(nodeIds, edgePairs);
    var outerSet = new Set(outerFace.map(String));
    var movable = [];
    for (var i = 0; i < nodeIds.length; i += 1) {
      var id = String(nodeIds[i]);
      if (!outerSet.has(id)) {
        movable.push(id);
      }
    }

    var incidentEdges = {};
    for (i = 0; i < nodeIds.length; i += 1) {
      incidentEdges[String(nodeIds[i])] = [];
    }
    for (i = 0; i < edgePairs.length; i += 1) {
      var u = String(edgePairs[i][0]);
      var v = String(edgePairs[i][1]);
      incidentEdges[u].push([u, v]);
      incidentEdges[v].push([u, v]);
    }

    var lengths = [];
    for (i = 0; i < edgePairs.length; i += 1) {
      u = String(edgePairs[i][0]);
      v = String(edgePairs[i][1]);
      var pu = pos[u];
      var pv = pos[v];
      if (!pu || !pv) continue;
      var dx0 = pu.x - pv.x;
      var dy0 = pu.y - pv.y;
      var len0 = Math.sqrt(dx0 * dx0 + dy0 * dy0);
      if (len0 > 1e-9) lengths.push(len0);
    }
    var targetLength = median(lengths);
    var diameter = computeDrawingDiameter(nodeIds, pos);
    var h = Number.isFinite(opts.initialStep) ? Math.max(1e-8, opts.initialStep) : 0.02 * diameter;
    var hMin = Number.isFinite(opts.minStep) ? Math.max(1e-10, opts.minStep) : 1e-5 * diameter;

    var acceptedTotal = 0;
    var rejectedTotal = 0;
    var performedIters = 0;
    var didFit = false;
    var bestScore = -Infinity;
    var bestPos = null;

    function runIteration(iter) {
      performedIters = iter;
      var accepted = 0;
      var rejected = 0;
      var uniformityBoost = 1 + 2.0 * (iter / Math.max(1, maxIters));
      var nnData = computeNearestNeighborData(nodeIds, pos, kNearest);
      var nnById = nnData.nnById;
      var meanNnDist = nnData.meanDist;
      var knearestById = nnData.knearestById;
      var meanKDist = nnData.meanKDist;
      var scaleLen = Math.max(targetLength, 1e-6);

      for (var m = 0; m < movable.length; m += 1) {
        var vId = movable[m];
        var pv0 = pos[vId];
        if (!pv0) continue;

        var fx = 0;
        var fy = 0;

        var ngh = adjOrig[vId] || [];
        for (var ni = 0; ni < ngh.length; ni += 1) {
          var uId = String(ngh[ni]);
          var pu0 = pos[uId];
          if (!pu0) continue;
          var rdx = pv0.x - pu0.x;
          var rdy = pv0.y - pu0.y;
          var rlen = Math.sqrt(rdx * rdx + rdy * rdy);
          if (rlen < 1e-12) continue;
          var coeffS = 2 * (rlen - targetLength) / (rlen + repEps);
          fx += -beta * (coeffS * rdx);
          fy += -beta * (coeffS * rdy);
        }

        for (var j = 0; j < nodeIds.length; j += 1) {
          var oId = String(nodeIds[j]);
          if (oId === vId) continue;
          var po = pos[oId];
          if (!po) continue;
          var dx = pv0.x - po.x;
          var dy = pv0.y - po.y;
          // Scale-normalized repulsion to avoid vanishing forces on large coordinate ranges.
          var dxn = dx / scaleLen;
          var dyn = dy / scaleLen;
          var d2 = dxn * dxn + dyn * dyn;
          if (d2 < 1e-18) continue;
          var denom = Math.pow(d2 + repEps, (repPower / 2) + 1);
          var coeffR = repPower / denom;
          fx += alpha * coeffR * dxn;
          fy += alpha * coeffR * dyn;
        }

        // Optional nearest-neighbor regularization: push very close pairs apart, very far pairs together.
        if (eta > 0 && meanNnDist > 1e-9 && nnById[vId]) {
          var nn = nnById[vId];
          var pn = pos[nn.id];
          if (pn && nn.dist > 1e-12) {
            var vx = pv0.x - pn.x;
            var vy = pv0.y - pn.y;
            var inv = 1 / nn.dist;
            var ux = vx * inv;
            var uy = vy * inv;
            var delta = meanNnDist - nn.dist;
            // Clamp NN correction to avoid instability on outliers.
            var deltaCap = 0.8 * meanNnDist;
            if (delta > deltaCap) delta = deltaCap;
            if (delta < -deltaCap) delta = -deltaCap;
            fx += (eta * uniformityBoost) * delta * ux;
            fy += (eta * uniformityBoost) * delta * uy;
          }
        }

        // Stronger local equalization on k-nearest neighbors.
        if (zeta > 0 && meanKDist > 1e-9 && knearestById[vId] && knearestById[vId].length > 0) {
          var knn = knearestById[vId];
          for (var ki = 0; ki < knn.length; ki += 1) {
            var kn = knn[ki];
            var pk = pos[kn.id];
            if (!pk || !(kn.dist > 1e-12)) {
              continue;
            }
            var kvx = pv0.x - pk.x;
            var kvy = pv0.y - pk.y;
            var kinv = 1 / kn.dist;
            var kux = kvx * kinv;
            var kuy = kvy * kinv;
            var kdelta = meanKDist - kn.dist;
            var kcap = 0.7 * meanKDist;
            if (kdelta > kcap) kdelta = kcap;
            if (kdelta < -kcap) kdelta = -kcap;
            fx += (zeta * uniformityBoost) * kdelta * kux;
            fy += (zeta * uniformityBoost) * kdelta * kuy;
          }
        }

        // Short-range barrier to avoid very close pairs (clusters).
        if (collisionBoost > 0 && meanNnDist > 1e-9 && knearestById[vId]) {
          var threshold = 0.75 * meanNnDist;
          var knn2 = knearestById[vId];
          for (var kb = 0; kb < knn2.length; kb += 1) {
            var nbr = knn2[kb];
            if (!(nbr.dist > 1e-12) || nbr.dist >= threshold) {
              continue;
            }
            var pnb = pos[nbr.id];
            if (!pnb) continue;
            var bdx = pv0.x - pnb.x;
            var bdy = pv0.y - pnb.y;
            var binv = 1 / nbr.dist;
            var bux = bdx * binv;
            var buy = bdy * binv;
            var strength = (collisionBoost * uniformityBoost) * ((threshold - nbr.dist) / Math.max(threshold, 1e-9));
            fx += strength * bux;
            fy += strength * buy;
          }
        }

        var fNorm = Math.sqrt(fx * fx + fy * fy);
        if (fNorm > maxForce) {
          var s = maxForce / fNorm;
          fx *= s;
          fy *= s;
        }

        var candidate = {
          x: pv0.x + h * fx,
          y: pv0.y + h * fy
        };

        if (wouldIntroduceCrossing(vId, candidate, pos, edgePairs, incidentEdges, EPS)) {
          rejected += 1;
          continue;
        }

        pos[vId] = candidate;
        accepted += 1;
      }

      acceptedTotal += accepted;
      rejectedTotal += rejected;

      if (onIteration) {
        onIteration({
          iter: iter,
          maxIters: maxIters,
          step: h,
          alpha: alpha,
          accepted: accepted,
          rejected: rejected,
          positions: pos,
          spacingScore: Number.isFinite(bestScore) ? bestScore : null
        });
      }

      return { accepted: accepted, rejected: rejected };
    }

    function finalizeResult() {
      var finalPos = bestPos || pos;
      applyPositionsToCy(cy, nodeIds, finalPos);
      if (!didFit) {
        cy.fit(undefined, 24);
        didFit = true;
      }
      return {
        ok: true,
        message: 'Applied FD-uniform (' + performedIters + ' iters, accepted ' + acceptedTotal + ', rejected ' + rejectedTotal + ')'
      };
    }

    if (!interactive) {
      for (var iter = 1; iter <= maxIters; iter += 1) {
        var step = runIteration(iter);
        var accepted = step.accepted;
        var rejected = step.rejected;
        acceptedTotal += accepted;
        rejectedTotal += rejected;

        if (movable.length > 0 && rejected > movable.length * 0.5) {
          h *= gamma;
          if (h < hMin) {
            break;
          }
        }

        if (iter % alphaGrowEvery === 0 && alpha < alphaCap) {
          alpha = Math.min(alphaCap, alpha * alphaGrowFactor);
        }

        if (iter % evalEvery === 0 || iter === 1 || iter === maxIters) {
          var q = evaluateSpacingQuality(nodeIds, edgePairs, pos);
          if (Number.isFinite(q) && q > bestScore) {
            bestScore = q;
            bestPos = copyPositions(pos);
          }
        }
      }
      return finalizeResult();
    }

    return (async function () {
      // Match Reweight behavior: show first valid state immediately and fit once.
      applyPositionsToCy(cy, nodeIds, pos);
      cy.fit(undefined, 24);
      didFit = true;
      await waitForNextFrame(delayMs);

      for (var iter = 1; iter <= maxIters; iter += 1) {
        if (h < hMin) {
          break;
        }
        var step = runIteration(iter);
        var accepted = step.accepted;
        var rejected = step.rejected;
        acceptedTotal += accepted;
        rejectedTotal += rejected;

        if (movable.length > 0 && rejected > movable.length * 0.5) {
          h *= gamma;
        }
        if (iter % alphaGrowEvery === 0 && alpha < alphaCap) {
          alpha = Math.min(alphaCap, alpha * alphaGrowFactor);
        }

        if (iter % renderEvery === 0 || iter === 1 || iter === maxIters) {
          applyPositionsToCy(cy, nodeIds, pos);
          var q = evaluateSpacingQuality(nodeIds, edgePairs, pos);
          if (Number.isFinite(q) && q > bestScore) {
            bestScore = q;
            bestPos = copyPositions(pos);
          }
          if (!didFit) {
            cy.fit(undefined, 24);
            didFit = true;
          }
          await waitForNextFrame(delayMs);
        }
      }
      return finalizeResult();
    })();
  }

  global.PlanarVibeFDUniform = {
    applyFDUniformLayout: applyFDUniformLayout,
    _internal: {
      wouldIntroduceCrossing: wouldIntroduceCrossing,
      segmentsIntersectProper: segmentsIntersectProper
    }
  };
})(window);
