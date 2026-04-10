(function (global) {
  'use strict';

  var GraphUtils = global.GraphUtils;
  var Metrics = global.PlanarVibeMetrics;
  var PlaygroundUtils = global.PlaygroundUtils;
  var buildAdjacencyArrays = GraphUtils.buildAdjacencyArrays;
  var buildLayoutError = GraphUtils.buildLayoutError;
  var buildLayoutResult = GraphUtils.buildLayoutResult;
  var buildLayoutStatusMessage = GraphUtils.buildLayoutStatusMessage;
  var hasPositionCrossings = GraphUtils.hasPositionCrossings;
  var normalizeGraphInput = GraphUtils.normalizeGraphInput;
  var computePositionMoveStats = GraphUtils.computePositionMoveStats;
  var createMovementConvergenceTracker = GraphUtils.createMovementConvergenceTracker;
  var copyPositions = GraphUtils.copyPositions;
  var pointOnSegmentInterior = GraphUtils.pointOnSegmentInterior;
  var resolveFiniteOption = GraphUtils.resolveFiniteOption;
  var resolveFloatOption = GraphUtils.resolveFloatOption;
  var resolveIntOption = GraphUtils.resolveIntOption;
  var resolveNonNegativeOption = GraphUtils.resolveNonNegativeOption;
  var resolvePositiveOption = GraphUtils.resolvePositiveOption;
  var segmentsIntersectOrTouch = GraphUtils.segmentsIntersectOrTouch;

  function estimateDelta(edgePairs, posById) {
    var sum = 0;
    var cnt = 0;
    for (var i = 0; i < edgePairs.length; i += 1) {
      var u = String(edgePairs[i][0]);
      var v = String(edgePairs[i][1]);
      var pu = posById[u];
      var pv = posById[v];
      if (!pu || !pv) continue;
      var dx = pu.x - pv.x;
      var dy = pu.y - pv.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (!(d > 1e-9)) continue;
      sum += d;
      cnt += 1;
    }
    if (cnt === 0) return 40;
    return sum / cnt;
  }

  function cross(ax, ay, bx, by) {
    return ax * by - ay * bx;
  }

  function projectPointOnSegment(px, py, ax, ay, bx, by) {
    var vx = bx - ax;
    var vy = by - ay;
    var ww = vx * vx + vy * vy;
    if (!(ww > 1e-12)) {
      return null;
    }
    var t = ((px - ax) * vx + (py - ay) * vy) / ww;
    if (t < 0 || t > 1) {
      return null;
    }
    return { x: ax + t * vx, y: ay + t * vy, t: t };
  }

  function raySegmentDistance(px, py, dx, dy, ax, ay, bx, by) {
    var ex = bx - ax;
    var ey = by - ay;
    var den = cross(dx, dy, ex, ey);
    if (Math.abs(den) < 1e-12) {
      return Infinity;
    }
    var qpx = ax - px;
    var qpy = ay - py;
    var t = cross(qpx, qpy, ex, ey) / den;
    var u = cross(qpx, qpy, dx, dy) / den;
    if (t > 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) {
      return t;
    }
    return Infinity;
  }

  function moveWouldCross(v, oldPos, newPos, nodeIds, edgePairs, posById) {
    var EPS = 1e-9;
    var incidentNeighbors = [];

    for (var i = 0; i < edgePairs.length; i += 1) {
      var a = String(edgePairs[i][0]);
      var b = String(edgePairs[i][1]);
      if (a === v) {
        incidentNeighbors.push(b);
        continue;
      }
      if (b === v) {
        incidentNeighbors.push(a);
        continue;
      }
      var pa = posById[a];
      var pb = posById[b];
      if (!pa || !pb) continue;
      if (pointOnSegmentInterior(pa, pb, newPos, EPS)) {
        return true;
      }
      if (segmentsIntersectOrTouch(oldPos, newPos, pa, pb, EPS)) {
        return true;
      }
    }

    for (i = 0; i < incidentNeighbors.length; i += 1) {
      var u = String(incidentNeighbors[i]);
      var pu = posById[u];
      if (!pu) continue;

      for (var j = 0; j < edgePairs.length; j += 1) {
        a = String(edgePairs[j][0]);
        b = String(edgePairs[j][1]);
        if (a === v || b === v || a === u || b === u) {
          continue;
        }
        pa = posById[a];
        pb = posById[b];
        if (!pa || !pb) continue;
        if (segmentsIntersectOrTouch(newPos, pu, pa, pb, EPS)) {
          return true;
        }
      }

      for (j = 0; j < nodeIds.length; j += 1) {
        var w = String(nodeIds[j]);
        if (w === v || w === u) {
          continue;
        }
        var pw = posById[w];
        if (!pw) continue;
        if (pointOnSegmentInterior(newPos, pu, pw, EPS)) {
          return true;
        }
      }
    }

    return false;
  }

  function sectorIndex(dx, dy, sectorCount) {
    var a = Math.atan2(dy, dx);
    if (a < 0) a += 2 * Math.PI;
    var k = Math.floor((a / (2 * Math.PI)) * sectorCount);
    if (k < 0) k = 0;
    if (k >= sectorCount) k = sectorCount - 1;
    return k;
  }

  function computeNodeForces(nodeIds, edgePairs, adjacency, posById, opts) {
    var delta = opts.delta;
    var cNodeRep = opts.cNodeRep;
    var cEdgeAttr = opts.cEdgeAttr;
    var cNodeEdgeRep = opts.cNodeEdgeRep;
    var nearbyFactor = opts.nearbyFactor;
    var forces = {};
    var i;

    for (i = 0; i < nodeIds.length; i += 1) {
      forces[nodeIds[i]] = { x: 0, y: 0 };
    }

    // f_Node_Repulsive and f_Node_Attractive (OGDF/Bertault style)
    for (i = 0; i < nodeIds.length; i += 1) {
      var v = nodeIds[i];
      var pv = posById[v];
      for (var j = 0; j < nodeIds.length; j += 1) {
        if (i === j) continue;
        var u = nodeIds[j];
        var pu = posById[u];
        var dx = pv.x - pu.x;
        var dy = pv.y - pu.y;
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (!(dist > 1e-9)) {
          continue;
        }
        var ux = dx / dist;
        var uy = dy / dist;
        var fr = cNodeRep * Math.pow(delta / dist, 2);
        forces[v].x += fr * ux;
        forces[v].y += fr * uy;
      }

      var adj = adjacency[v] || [];
      for (j = 0; j < adj.length; j += 1) {
        u = String(adj[j]);
        pu = posById[u];
        dx = pu.x - pv.x;
        dy = pu.y - pv.y;
        dist = Math.sqrt(dx * dx + dy * dy);
        if (!(dist > 1e-9)) {
          continue;
        }
        ux = dx / dist;
        uy = dy / dist;
        var fa = cEdgeAttr * Math.pow(dist / delta, 1);
        forces[v].x += fa * ux;
        forces[v].y += fa * uy;
      }
    }

    // f_Edge: non-incident edge repulsion from projection / closest segment point.
    for (i = 0; i < nodeIds.length; i += 1) {
      v = nodeIds[i];
      pv = posById[v];
      for (j = 0; j < edgePairs.length; j += 1) {
        var a = String(edgePairs[j][0]);
        var b = String(edgePairs[j][1]);
        if (a === v || b === v) {
          continue;
        }
        var pa = posById[a];
        var pb = posById[b];
        if (!pa || !pb) continue;

        var proj = projectPointOnSegment(pv.x, pv.y, pa.x, pa.y, pb.x, pb.y);
        var qx;
        var qy;
        if (proj) {
          qx = proj.x;
          qy = proj.y;
        } else {
          var da = Math.hypot(pv.x - pa.x, pv.y - pa.y);
          var db = Math.hypot(pv.x - pb.x, pv.y - pb.y);
          if (da <= db) {
            qx = pa.x;
            qy = pa.y;
          } else {
            qx = pb.x;
            qy = pb.y;
          }
        }
        dx = pv.x - qx;
        dy = pv.y - qy;
        dist = Math.sqrt(dx * dx + dy * dy);
        if (!(dist > 1e-9)) {
          continue;
        }
        if (dist > nearbyFactor * delta) {
          continue;
        }
        ux = dx / dist;
        uy = dy / dist;
        var fe = cNodeEdgeRep * Math.pow(delta / dist, 2);
        forces[v].x += fe * ux;
        forces[v].y += fe * uy;
      }
    }

    return forces;
  }

  function computeMovementLimits(nodeIds, edgePairs, posById, maxMove, sectorCount) {
    var limits = {};
    var i;
    for (i = 0; i < nodeIds.length; i += 1) {
      limits[nodeIds[i]] = new Array(sectorCount);
      for (var s = 0; s < sectorCount; s += 1) {
        limits[nodeIds[i]][s] = maxMove;
      }
    }

    for (i = 0; i < nodeIds.length; i += 1) {
      var v = nodeIds[i];
      var pv = posById[v];
      for (s = 0; s < sectorCount; s += 1) {
        var ang = ((s + 0.5) / sectorCount) * 2 * Math.PI;
        var dx = Math.cos(ang);
        var dy = Math.sin(ang);
        var best = maxMove;
        for (var j = 0; j < edgePairs.length; j += 1) {
          var a = String(edgePairs[j][0]);
          var b = String(edgePairs[j][1]);
          if (a === v || b === v) {
            continue;
          }
          var pa = posById[a];
          var pb = posById[b];
          if (!pa || !pb) continue;
          var t = raySegmentDistance(pv.x, pv.y, dx, dy, pa.x, pa.y, pb.x, pb.y);
          if (t < best) {
            best = t;
          }
        }
        limits[v][s] = Math.max(0, best - 1e-4);
      }
    }
    return limits;
  }

  function findCrossingEdgePairs(edgePairs, posById) {
    var out = [];
    for (var i = 0; i < edgePairs.length; i += 1) {
      var a1 = String(edgePairs[i][0]);
      var b1 = String(edgePairs[i][1]);
      var p1 = posById[a1];
      var q1 = posById[b1];
      if (!p1 || !q1) continue;
      for (var j = i + 1; j < edgePairs.length; j += 1) {
        var a2 = String(edgePairs[j][0]);
        var b2 = String(edgePairs[j][1]);
        if (a1 === a2 || a1 === b2 || b1 === a2 || b1 === b2) {
          continue;
        }
        var p2 = posById[a2];
        var q2 = posById[b2];
        if (!p2 || !q2) continue;
        if (segmentsIntersectOrTouch(p1, q1, p2, q2, 1e-9)) {
          out.push({ e1: [a1, b1], e2: [a2, b2] });
        }
      }
    }
    return out;
  }

  function resolveCrossingsByVertexRollback(posById, prevPosById, edgePairs, fixedOuter) {
    var EPS = 1e-9;
    var maxRounds = 64;
    var rolledBack = new Set();

    function movedDistance(v) {
      var cur = posById[v];
      var prev = prevPosById[v];
      if (!cur || !prev) return 0;
      return Math.hypot(cur.x - prev.x, cur.y - prev.y);
    }

    for (var round = 0; round < maxRounds; round += 1) {
      var crossings = findCrossingEdgePairs(edgePairs, posById);
      if (crossings.length === 0) {
        return {
          resolved: true,
          rolledBack: rolledBack
        };
      }

      var changed = false;
      for (var i = 0; i < crossings.length; i += 1) {
        var pair = crossings[i];
        var candidates = [
          pair.e1[0], pair.e1[1], pair.e2[0], pair.e2[1]
        ];
        var bestV = null;
        var bestDist = 0;
        for (var c = 0; c < candidates.length; c += 1) {
          var v = String(candidates[c]);
          if (fixedOuter.has(v)) continue;
          var d = movedDistance(v);
          if (d > bestDist + EPS) {
            bestDist = d;
            bestV = v;
          }
        }
        if (bestV && bestDist > EPS && prevPosById[bestV]) {
          posById[bestV] = { x: prevPosById[bestV].x, y: prevPosById[bestV].y };
          rolledBack.add(bestV);
          changed = true;
        }
      }
      if (!changed) {
        break;
      }
    }

    return {
      resolved: findCrossingEdgePairs(edgePairs, posById).length === 0,
      rolledBack: rolledBack
    };
  }

  async function computeImPrEdPositions(nodeIds, edgePairs, options) {
    var opts = options || {};
    var g = normalizeGraphInput(nodeIds, edgePairs);
    if (!g.nodeIds || g.nodeIds.length < 2) {
      return buildLayoutError({ message: 'ImPrEd requires at least 2 vertices', graph: g });
    }
    if (!g.edgePairs || g.edgePairs.length === 0) {
      return buildLayoutError({ message: 'ImPrEd requires at least 1 edge', graph: g });
    }

    var currentSource = opts.currentPositions || {};
    var currentPositions = {};
    var currentCount = 0;
    for (var ci = 0; ci < g.nodeIds.length; ci += 1) {
      var currentId = g.nodeIds[ci];
      var currentPos = currentSource[currentId];
      if (currentPos && Number.isFinite(currentPos.x) && Number.isFinite(currentPos.y)) {
        currentPositions[currentId] = { x: currentPos.x, y: currentPos.y };
        currentCount += 1;
      }
    }

    var seed = null;
    var currentEmbedding = currentCount === g.nodeIds.length
      ? GraphUtils.extractEmbeddingFromPositions(g.nodeIds, g.edgePairs, currentPositions)
      : null;
    if (currentEmbedding && currentEmbedding.ok) {
      seed = {
        ok: true,
        graph: g,
        baseEmbedding: currentEmbedding,
        outerFace: currentEmbedding.outerFace ? currentEmbedding.outerFace.slice().map(String) : null,
        posById: currentPositions,
        movableVertices: GraphUtils.collectMovableVertices(g.nodeIds, currentEmbedding.outerFace || []),
        initSource: 'current-plane'
      };
    } else {
      seed = PlaygroundUtils.prepareGraphAndLayoutData(g, {
        failureLabel: 'ImPrEd layout',
        augmentationMethod: opts.augmentationMethod || null,
        currentPositions: currentCount === g.nodeIds.length ? currentPositions : null
      });
      if (!seed || !seed.ok) {
        return buildLayoutError(seed || { message: 'ImPrEd initialization failed', graph: g });
      }
      seed = {
        ok: true,
        graph: seed.graph,
        baseEmbedding: seed.baseEmbedding || null,
        outerFace: seed.outerFace ? seed.outerFace.slice() : null,
        posById: copyPositions(seed.posById || {}),
        movableVertices: seed.movableVertices ? seed.movableVertices.slice() : g.nodeIds.slice(),
        initSource: 'shared-seed'
      };
    }

    var posById = copyPositions(seed.posById || {});
    var adj = buildAdjacencyArrays(g.nodeIds, g.edgePairs);
    var emb = seed.baseEmbedding || null;
    var fixedOuter = new Set((seed.outerFace || []).map(String));
    var delta = resolvePositiveOption(opts.delta, estimateDelta(g.edgePairs, posById));
    var maxIters = resolveIntOption(opts.maxIters, 600, 1);
    var startMaxMove = resolvePositiveOption(opts.maxMove, 3 * delta);
    var minMaxMove = resolveNonNegativeOption(opts.minMaxMove, 0.05 * delta);
    var minItersBeforeStop = resolveIntOption(opts.minItersBeforeStop, 60, 1);
    var stableIterLimit = resolveIntOption(opts.stableIterLimit, 16, 1);
    var movementStopTol = resolveNonNegativeOption(opts.movementStopTol, 0.008 * delta);
    var avgMovementStopTol = resolveNonNegativeOption(opts.avgMovementStopTol, 0.0015 * delta);
    var sectorCount = 8;
    var forceScale = resolvePositiveOption(opts.forceScale, 0.04);
    var cNodeRep = resolveFiniteOption(opts.cNodeRep, 1.0);
    var cEdgeAttr = resolveFiniteOption(opts.cEdgeAttr, 1.0);
    var cNodeEdgeRep = resolveFiniteOption(opts.cNodeEdgeRep, 0.75);
    var nearbyFactor = resolvePositiveOption(opts.nearbyFactor, 6.0);
    var momentumBeta = resolveFloatOption(opts.momentumBeta, 0.78, 0, 0.98);
    var rejectedVelocityDamp = resolveFloatOption(opts.rejectedVelocityDamp, 0.25, 0, 1);
    var rollbackVelocityDamp = resolveFloatOption(opts.rollbackVelocityDamp, 0.0, 0, 1);
    var fullRollbackVelocityDamp = resolveFloatOption(opts.fullRollbackVelocityDamp, 0.5, 0, 1);
    var iter;
    var stopReason = 'max-iters';
    var lastStats = { movedNodes: 0, totalMove: 0, avgActualMove: 0, maxActualMove: 0 };
    var movementTracker = createMovementConvergenceTracker({
      minItersBeforeStop: minItersBeforeStop,
      stableIterLimit: stableIterLimit,
      maxMoveTol: movementStopTol,
      avgMoveTol: avgMovementStopTol
    });
    var velocityById = {};
    for (iter = 0; iter < g.nodeIds.length; iter += 1) {
      velocityById[g.nodeIds[iter]] = { x: 0, y: 0 };
    }

    iter = 0;
    for (iter = 0; iter < maxIters; iter += 1) {
      var prevPosById = copyPositions(posById);
      var alpha = maxIters > 1 ? (iter / (maxIters - 1)) : 1;
      var maxMove = startMaxMove + alpha * (minMaxMove - startMaxMove);
      var forces = computeNodeForces(g.nodeIds, g.edgePairs, adj, posById, {
        delta: delta,
        cNodeRep: cNodeRep * (1.0 + 3.0 * alpha), // 1 -> 4
        cEdgeAttr: cEdgeAttr * (1.0 - 0.6 * alpha), // 1 -> 0.4
        cNodeEdgeRep: cNodeEdgeRep,
        nearbyFactor: nearbyFactor
      });
      var limits = computeMovementLimits(g.nodeIds, g.edgePairs, posById, maxMove, sectorCount);
      for (var i = 0; i < g.nodeIds.length; i += 1) {
        var v = g.nodeIds[i];
        if (fixedOuter.has(v)) {
          velocityById[v] = { x: 0, y: 0 };
          continue;
        }
        var f = forces[v];
        if (!f) continue;
        var fmag = Math.hypot(f.x, f.y);
        if (!(fmag > 1e-9)) continue;
        var k = sectorIndex(f.x, f.y, sectorCount);
        var allowed = limits[v][k];
        if (!(allowed > 1e-9)) continue;
        var step = Math.min(allowed, forceScale * fmag);
        if (!(step > 1e-9)) continue;
        var ux = f.x / fmag;
        var uy = f.y / fmag;
        var oldP = { x: posById[v].x, y: posById[v].y };
        var prevVel = velocityById[v] || { x: 0, y: 0 };
        var proposedDx = ux * step;
        var proposedDy = uy * step;
        var velX = momentumBeta * prevVel.x + (1 - momentumBeta) * proposedDx;
        var velY = momentumBeta * prevVel.y + (1 - momentumBeta) * proposedDy;
        var velMag = Math.hypot(velX, velY);
        if (velMag > allowed && velMag > 1e-12) {
          var sc = allowed / velMag;
          velX *= sc;
          velY *= sc;
        }
        var newP = { x: oldP.x + velX, y: oldP.y + velY };

        // Additional safeguard: binary-shrink movement until no node-edge crossing.
        var shrink = 0;
        while (moveWouldCross(v, oldP, newP, g.nodeIds, g.edgePairs, posById) && shrink < 12) {
          newP.x = oldP.x + (newP.x - oldP.x) * 0.5;
          newP.y = oldP.y + (newP.y - oldP.y) * 0.5;
          shrink += 1;
        }
        if (moveWouldCross(v, oldP, newP, g.nodeIds, g.edgePairs, posById)) {
          velocityById[v].x *= rejectedVelocityDamp;
          velocityById[v].y *= rejectedVelocityDamp;
          continue;
        }

        var movedDx = newP.x - oldP.x;
        var movedDy = newP.y - oldP.y;
        if (Math.hypot(movedDx, movedDy) > 1e-6) {
          posById[v] = newP;
          velocityById[v] = { x: movedDx, y: movedDy };
        } else {
          velocityById[v].x *= rejectedVelocityDamp;
          velocityById[v].y *= rejectedVelocityDamp;
        }
      }

      var hasCrossings = false;
      if (Metrics) {
        hasCrossings = hasPositionCrossings(posById, g.edgePairs);
      }
      if (hasCrossings) {
        // Prefer reverting only vertices involved in crossing pairs.
        var rollbackResult = resolveCrossingsByVertexRollback(posById, prevPosById, g.edgePairs, fixedOuter);
        if (!rollbackResult.resolved) {
          // Safety fallback: revert whole iteration.
          posById = prevPosById;
          for (var vi = 0; vi < g.nodeIds.length; vi += 1) {
            var vid = g.nodeIds[vi];
            velocityById[vid].x *= fullRollbackVelocityDamp;
            velocityById[vid].y *= fullRollbackVelocityDamp;
          }
          hasCrossings = false;
        } else if (Metrics) {
          rollbackResult.rolledBack.forEach(function (rv) {
            if (velocityById[rv]) {
              velocityById[rv].x *= rollbackVelocityDamp;
              velocityById[rv].y *= rollbackVelocityDamp;
            }
          });
          hasCrossings = hasPositionCrossings(posById, g.edgePairs);
          if (hasCrossings) {
            posById = prevPosById;
            for (vi = 0; vi < g.nodeIds.length; vi += 1) {
              vid = g.nodeIds[vi];
              velocityById[vid].x *= fullRollbackVelocityDamp;
              velocityById[vid].y *= fullRollbackVelocityDamp;
            }
            hasCrossings = false;
          }
        } else {
          hasCrossings = false;
        }
      }

      var rawMoveStats = computePositionMoveStats(g.nodeIds, prevPosById, posById, { moveTol: 1e-6 });
      lastStats = {
        movedNodes: rawMoveStats.movedVertices,
        totalMove: rawMoveStats.totalMove,
        avgActualMove: rawMoveStats.avgMove,
        maxActualMove: rawMoveStats.maxMove
      };
      var movementStatus = movementTracker ? movementTracker.update({
        maxMove: lastStats.maxActualMove,
        avgMove: lastStats.avgActualMove
      }, iter + 1) : { stableIterations: 0, stableIterLimit: stableIterLimit, converged: false };

      if (typeof opts.onIteration === 'function') {
        await opts.onIteration({
          iter: iter + 1,
          maxIters: maxIters,
          positions: posById,
          movedVertices: lastStats.movedNodes,
          maxMove: lastStats.maxActualMove,
          avgMove: lastStats.avgActualMove,
          debug: {
            moveCap: maxMove,
            totalMove: lastStats.totalMove,
            hasCrossings: hasCrossings,
            stableIterCount: movementStatus.stableIterations,
            stableIterLimit: movementStatus.stableIterLimit
          }
        });
      }
      if (lastStats.movedNodes === 0) {
        stopReason = 'no-movement';
        break;
      }
      if (movementStatus.converged) {
        stopReason = movementStatus.reason || 'movement-converged';
        break;
      }
    }

    return buildLayoutResult({
      ok: true,
      nodeIds: g.nodeIds,
      edgePairs: g.edgePairs,
      graph: g,
      outerFace: seed.outerFace ? seed.outerFace.slice() : (emb && emb.outerFace ? emb.outerFace.slice() : null),
      embedding: emb,
      pos: posById,
      iterations: iter + 1,
      stopReason: stopReason,
      maxActualMove: lastStats.maxActualMove,
      avgActualMove: lastStats.avgActualMove
    });
  }

  async function applyImPrEdLayout(cy, options) {
    return PlaygroundUtils.runLayout(cy, options, {
      compute: computeImPrEdPositions,
      patchComputeOptions: function (ctx) {
        return {
          currentPositions: PlaygroundUtils.currentPositionsFromCy(ctx.cy),
          onIteration: ctx.onProgress
        };
      },
      getPositions: function (result) {
        return result.pos;
      },
      buildResult: function (ctx) {
        var result = ctx.result;
        return {
          ok: true,
          iterations: result.iterations,
          stopReason: result.stopReason,
          maxActualMove: result.maxActualMove,
          avgActualMove: result.avgActualMove,
          message: buildLayoutStatusMessage('ImPrEd', {
            vertexCount: result.nodeIds.length,
            iters: result.iterations,
            stopReason: result.stopReason
          })
        };
      },
      failureMessage: 'ImPrEd failed'
    });
  }

  global.PlanarVibeImPrEd = {
    computeImPrEdPositions: computeImPrEdPositions,
    applyImPrEdLayout: applyImPrEdLayout
  };
})(window);
