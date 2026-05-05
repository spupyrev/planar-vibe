(function (global) {
  'use strict';

  var GraphUtils = global.GraphUtils;
  var GeometryUtils = global.GeometryUtils;
  var LayoutPreprocessing = global.LayoutPreprocessing;
  var CyRuntime = global.CyRuntime;
  var buildLayoutError = GraphUtils.buildLayoutError;
  var buildLayoutResult = GraphUtils.buildLayoutResult;
  var buildLayoutStatusMessage = GraphUtils.buildLayoutStatusMessage;
  var hasPositionCrossings = GeometryUtils.hasPositionCrossings;
  var computePositionMoveStats = GraphUtils.computePositionMoveStats;
  var createMovementConvergenceTracker = GraphUtils.createMovementConvergenceTracker;
  var copyPositions = GeometryUtils.copyPositionMap;
  var pointOnSegmentInterior = GeometryUtils.pointOnSegmentInterior;
  var segmentsIntersectOrTouch = GeometryUtils.segmentsIntersectOrTouch;
  var IMPRED_CONFIG = {
    maxIters: 600,
    maxMoveFactor: 3,
    minMaxMoveFactor: 0.05,
    sectorCount: 8,
    forceScale: 0.04,
    nodeRepulsion: 1.0,
    edgeAttraction: 1.0,
    nodeEdgeRepulsion: 0.75,
    nearbyFactor: 6.0,
    momentumBeta: 0.78,
    rejectedVelocityDamp: 0.25,
    rollbackVelocityDamp: 0.0,
    fullRollbackVelocityDamp: 0.5,
    minItersBeforeStop: 60,
    stableIterLimit: 16,
    movementStopTolFactor: 0.008,
    avgMovementStopTolFactor: 0.0015
  };

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

  function moveWouldCross(v, oldPos, newPos, nodeIds, edgePairs, adjacency, posById) {
    var EPS = 1e-9;

    for (var i = 0; i < edgePairs.length; i += 1) {
      var a = String(edgePairs[i][0]);
      var b = String(edgePairs[i][1]);
      if (a === v || b === v) {
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

    var incidentNeighbors = adjacency[v] || [];
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
        var fa = cEdgeAttr * (dist / delta);
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
          var q = da <= db ? pa : pb;
          qx = q.x;
          qy = q.y;
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
      limits[nodeIds[i]] = new Array(sectorCount).fill(maxMove);
    }

    for (i = 0; i < nodeIds.length; i += 1) {
      var v = nodeIds[i];
      var pv = posById[v];
      for (var s = 0; s < sectorCount; s += 1) {
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

  function buildImPrEdSeedFromPrepared(g, options, layoutInput) {
    var init = LayoutPreprocessing.computeInitialPositions(
      layoutInput.augmented.graph,
      layoutInput.augmentedOuterFace,
      layoutInput.augmented.embedding,
      layoutInput.graph
    );
    if (!init || !init.ok || !init.positions) {
      return buildLayoutError(init || { message: 'ImPrEd initialization failed', graph: g });
    }
    return {
      baseEmbedding: layoutInput.baseEmbedding || null,
      outerFace: layoutInput.outerFace ? layoutInput.outerFace.slice() : null,
      posById: copyPositions(init.positions)
    };
  }

  async function computePositions(layoutInput, options) {
    var g = layoutInput.graph;
    if (!g.edgePairs || g.edgePairs.length === 0) {
      return buildLayoutError({ message: 'ImPrEd requires at least 1 edge', graph: g });
    }

    var seed = buildImPrEdSeedFromPrepared(g, options, layoutInput);
    if (!seed || seed.ok === false) {
      return buildLayoutError(seed || { message: 'ImPrEd initialization failed', graph: g });
    }

    return runImPrEdIterations(g, options, seed);
  }

  function prepareGraphData(g, options) {
    var runtime = options || {};
    return LayoutPreprocessing.prepareGraphData(g, {
      failureLabel: 'ImPrEd layout',
      augmentationMethod: runtime.augmentationMethod || null,
      currentPositions: runtime.currentPositions || null
    });
  }

  async function runImPrEdIterations(g, options, seed) {
    var runtime = options;
    var posById = copyPositions(seed.posById || {});
    var fixedOuter = new Set(seed.outerFace.map(String));
    var delta = estimateDelta(g.edgePairs, posById);
    var maxIters = IMPRED_CONFIG.maxIters;
    var startMaxMove = IMPRED_CONFIG.maxMoveFactor * delta;
    var minMaxMove = IMPRED_CONFIG.minMaxMoveFactor * delta;
    var sectorCount = IMPRED_CONFIG.sectorCount;
    var forceScale = IMPRED_CONFIG.forceScale;
    var cNodeRep = IMPRED_CONFIG.nodeRepulsion;
    var cEdgeAttr = IMPRED_CONFIG.edgeAttraction;
    var cNodeEdgeRep = IMPRED_CONFIG.nodeEdgeRepulsion;
    var nearbyFactor = IMPRED_CONFIG.nearbyFactor;
    var momentumBeta = IMPRED_CONFIG.momentumBeta;
    var rejectedVelocityDamp = IMPRED_CONFIG.rejectedVelocityDamp;
    var rollbackVelocityDamp = IMPRED_CONFIG.rollbackVelocityDamp;
    var fullRollbackVelocityDamp = IMPRED_CONFIG.fullRollbackVelocityDamp;
    var iter;
    var stopReason = 'max-iters';
    var lastStats = { movedVertices: 0, totalMove: 0, avgMove: 0, maxMove: 0 };
    var movementTracker = createMovementConvergenceTracker({
      minItersBeforeStop: IMPRED_CONFIG.minItersBeforeStop,
      stableIterLimit: IMPRED_CONFIG.stableIterLimit,
      maxMoveTol: IMPRED_CONFIG.movementStopTolFactor * delta,
      avgMoveTol: IMPRED_CONFIG.avgMovementStopTolFactor * delta
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
      var forces = computeNodeForces(g.nodeIds, g.edgePairs, g.adjacency, posById, {
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
        while (moveWouldCross(v, oldP, newP, g.nodeIds, g.edgePairs, g.adjacency, posById) && shrink < 12) {
          newP.x = oldP.x + (newP.x - oldP.x) * 0.5;
          newP.y = oldP.y + (newP.y - oldP.y) * 0.5;
          shrink += 1;
        }
        if (moveWouldCross(v, oldP, newP, g.nodeIds, g.edgePairs, g.adjacency, posById)) {
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

      var hasCrossings = hasPositionCrossings(posById, g.edgePairs);
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
        } else {
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
        }
      }

      lastStats = computePositionMoveStats(g.nodeIds, prevPosById, posById, { moveTol: 1e-6 });
      var movementStatus = movementTracker.update({
        maxMove: lastStats.maxMove,
        avgMove: lastStats.avgMove
      }, iter + 1);

      if (typeof runtime.onIteration === 'function') {
        await runtime.onIteration({
          iter: iter + 1,
          maxIters: maxIters,
          positions: posById,
          movedVertices: lastStats.movedVertices,
          totalMove: lastStats.totalMove,
          maxMove: lastStats.maxMove,
          avgMove: lastStats.avgMove,
          debug: {
            moveCap: maxMove,
            hasCrossings: hasCrossings,
            stableIterCount: movementStatus.stableIterations,
            stableIterLimit: movementStatus.stableIterLimit
          }
        });
      }
      if (lastStats.movedVertices === 0) {
        stopReason = 'no-movement';
        break;
      }
      if (movementStatus.converged) {
        stopReason = movementStatus.reason || 'movement-converged';
        break;
      }
    }

    return buildLayoutResult({
      nodeIds: g.nodeIds,
      edgePairs: g.edgePairs,
      graph: g,
      outerFace: seed.outerFace ? seed.outerFace.slice() : null,
      embedding: seed.baseEmbedding || null,
      positions: posById,
      iters: iter + 1,
      stopReason: stopReason,
      totalMove: lastStats.totalMove,
      maxMove: lastStats.maxMove,
      avgMove: lastStats.avgMove
    });
  }

  async function applyLayout(cy, options) {
    return CyRuntime.runLayout(cy, options, {
      prepareMode: 'graph',
      prepareFailureLabel: 'ImPrEd layout',
      initialFitBounds: function (ctx) {
        return CyRuntime.computePositionBounds(ctx.currentPositions);
      },
      computePositions: computePositions,
      buildResult: function (ctx) {
        var result = ctx.result;
        return {
          ok: true,
          iters: result.iters,
          stopReason: result.stopReason,
          totalMove: result.totalMove,
          maxMove: result.maxMove,
          avgMove: result.avgMove,
          message: buildLayoutStatusMessage('ImPrEd', {
            vertexCount: result.nodeIds.length,
            iters: result.iters,
            stopReason: result.stopReason
          })
        };
      },
      failureMessage: 'ImPrEd failed'
    });
  }

  global.PlanarVibeImPrEd = {
	    prepareGraphData: prepareGraphData,
	    computePositions: computePositions,
	    applyLayout: applyLayout,
	    buildImPrEdSeedFromPrepared: buildImPrEdSeedFromPrepared
	  };
})(window);
