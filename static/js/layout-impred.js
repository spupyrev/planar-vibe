(function (global) {
  'use strict';

  function edgeKey(u, v) {
    var a = String(u);
    var b = String(v);
    return a < b ? a + '::' + b : b + '::' + a;
  }

  function collectGraphFromCy(cy) {
    var nodeIds = cy.nodes().map(function (n) { return String(n.id()); });
    var edgePairs = cy.edges().map(function (e) {
      return [String(e.source().id()), String(e.target().id())];
    });
    return { nodeIds: nodeIds, edgePairs: edgePairs };
  }

  function currentPositionsFromCy(cy) {
    var pos = {};
    cy.nodes().forEach(function (n) {
      var id = String(n.id());
      var p = n.position();
      pos[id] = { x: p.x, y: p.y };
    });
    return pos;
  }

  function buildAdjacency(nodeIds, edgePairs) {
    var adj = {};
    for (var i = 0; i < nodeIds.length; i += 1) {
      adj[String(nodeIds[i])] = new Set();
    }
    for (i = 0; i < edgePairs.length; i += 1) {
      var u = String(edgePairs[i][0]);
      var v = String(edgePairs[i][1]);
      if (!adj[u]) adj[u] = new Set();
      if (!adj[v]) adj[v] = new Set();
      adj[u].add(v);
      adj[v].add(u);
    }
    return adj;
  }

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

  function polygonAreaAbs(face, posById) {
    if (!face || face.length < 3) {
      return 0;
    }
    var s = 0;
    for (var i = 0; i < face.length; i += 1) {
      var a = posById[String(face[i])];
      var b = posById[String(face[(i + 1) % face.length])];
      if (!a || !b || !Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(b.x) || !Number.isFinite(b.y)) {
        return 0;
      }
      s += a.x * b.y - b.x * a.y;
    }
    return Math.abs(s) / 2;
  }

  function chooseCurrentOuterFaceByArea(embedding, posById) {
    if (!embedding || !embedding.faces || embedding.faces.length === 0) {
      return embedding && embedding.outerFace ? embedding.outerFace.slice() : null;
    }
    var best = null;
    var bestArea = -1;
    for (var i = 0; i < embedding.faces.length; i += 1) {
      var face = embedding.faces[i];
      var area = polygonAreaAbs(face, posById);
      if (area > bestArea) {
        bestArea = area;
        best = face;
      }
    }
    if (best && best.length >= 3) {
      return best.slice();
    }
    return embedding.outerFace ? embedding.outerFace.slice() : null;
  }

  function dot(ax, ay, bx, by) {
    return ax * bx + ay * by;
  }

  function cross(ax, ay, bx, by) {
    return ax * by - ay * bx;
  }

  function distancePointToSegment(px, py, ax, ay, bx, by) {
    var vx = bx - ax;
    var vy = by - ay;
    var wx = px - ax;
    var wy = py - ay;
    var c1 = dot(wx, wy, vx, vy);
    if (c1 <= 0) {
      var dx0 = px - ax;
      var dy0 = py - ay;
      return Math.sqrt(dx0 * dx0 + dy0 * dy0);
    }
    var c2 = dot(vx, vy, vx, vy);
    if (c2 <= c1) {
      var dx1 = px - bx;
      var dy1 = py - by;
      return Math.sqrt(dx1 * dx1 + dy1 * dy1);
    }
    var t = c1 / c2;
    var qx = ax + t * vx;
    var qy = ay + t * vy;
    var dx = px - qx;
    var dy = py - qy;
    return Math.sqrt(dx * dx + dy * dy);
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

  function properIntersect(a, b, c, d) {
    function orient(p, q, r) {
      return cross(q.x - p.x, q.y - p.y, r.x - p.x, r.y - p.y);
    }
    function between(a0, b0, c0) {
      return Math.min(a0, b0) <= c0 + 1e-9 && c0 <= Math.max(a0, b0) + 1e-9;
    }
    var o1 = orient(a, b, c);
    var o2 = orient(a, b, d);
    var o3 = orient(c, d, a);
    var o4 = orient(c, d, b);
    if ((o1 > 1e-9 && o2 < -1e-9 || o1 < -1e-9 && o2 > 1e-9) &&
        (o3 > 1e-9 && o4 < -1e-9 || o3 < -1e-9 && o4 > 1e-9)) {
      return true;
    }
    if (Math.abs(o1) <= 1e-9 && between(a.x, b.x, c.x) && between(a.y, b.y, c.y)) return true;
    if (Math.abs(o2) <= 1e-9 && between(a.x, b.x, d.x) && between(a.y, b.y, d.y)) return true;
    if (Math.abs(o3) <= 1e-9 && between(c.x, d.x, a.x) && between(c.y, d.y, a.y)) return true;
    if (Math.abs(o4) <= 1e-9 && between(c.x, d.x, b.x) && between(c.y, d.y, b.y)) return true;
    return false;
  }

  function moveWouldCross(v, oldPos, newPos, edgePairs, posById) {
    for (var i = 0; i < edgePairs.length; i += 1) {
      var a = String(edgePairs[i][0]);
      var b = String(edgePairs[i][1]);
      if (a === v || b === v) {
        continue;
      }
      var pa = posById[a];
      var pb = posById[b];
      if (!pa || !pb) continue;
      if (properIntersect(oldPos, newPos, pa, pb)) {
        return true;
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

      var adj = adjacency[v] ? Array.from(adjacency[v]) : [];
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

  function waitForNextFrame(delayMs) {
    return new Promise(function (resolve) {
      var done = function () {
        if (delayMs > 0) {
          setTimeout(resolve, delayMs);
        } else {
          resolve();
        }
      };
      if (typeof global.requestAnimationFrame === 'function') {
        global.requestAnimationFrame(function () { done(); });
      } else {
        setTimeout(done, 0);
      }
    });
  }

  function clonePositionsMap(posById) {
    var out = {};
    var keys = Object.keys(posById || {});
    for (var i = 0; i < keys.length; i += 1) {
      var id = keys[i];
      var p = posById[id];
      out[id] = { x: p.x, y: p.y };
    }
    return out;
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
        if (properIntersect(p1, q1, p2, q2)) {
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

  function applyPositionsToCy(cy, posById) {
    cy.nodes().forEach(function (node) {
      var id = String(node.id());
      if (posById[id]) {
        node.position({ x: posById[id].x, y: posById[id].y });
      }
    });
  }

  async function applyImPrEdLayout(cy, options) {
    var opts = options || {};
    var g = collectGraphFromCy(cy);
    if (!g.nodeIds || g.nodeIds.length < 2) {
      return { ok: false, message: 'ImPrEd requires at least 2 vertices' };
    }
    if (!g.edgePairs || g.edgePairs.length === 0) {
      return { ok: false, message: 'ImPrEd requires at least 1 edge' };
    }

    var posById = currentPositionsFromCy(cy);
    var adj = buildAdjacency(g.nodeIds, g.edgePairs);
    var fixedOuter = new Set();
    if (global.PlanarVibePlanarityTest && global.PlanarVibePlanarityTest.computePlanarEmbedding) {
      var emb = global.PlanarVibePlanarityTest.computePlanarEmbedding(g.nodeIds, g.edgePairs);
      if (emb && emb.ok) {
        var visibleOuter = chooseCurrentOuterFaceByArea(emb, posById);
        if (visibleOuter && visibleOuter.length >= 3) {
          for (var fo = 0; fo < visibleOuter.length; fo += 1) {
            fixedOuter.add(String(visibleOuter[fo]));
          }
        }
      }
    }
    var delta = Number.isFinite(opts.delta) && opts.delta > 0 ? opts.delta : estimateDelta(g.edgePairs, posById);
    var maxIters = Number.isFinite(opts.maxIters) ? Math.max(1, Math.floor(opts.maxIters)) : 120;
    var startMaxMove = Number.isFinite(opts.maxMove) && opts.maxMove > 0 ? opts.maxMove : 3 * delta;
    var minMaxMove = Number.isFinite(opts.minMaxMove) && opts.minMaxMove >= 0 ? opts.minMaxMove : 0.05 * delta;
    var sectorCount = 8;
    var forceScale = Number.isFinite(opts.forceScale) && opts.forceScale > 0 ? opts.forceScale : 0.05;
    var cNodeRep = Number.isFinite(opts.cNodeRep) ? opts.cNodeRep : 1.0;
    var cEdgeAttr = Number.isFinite(opts.cEdgeAttr) ? opts.cEdgeAttr : 1.0;
    var cNodeEdgeRep = Number.isFinite(opts.cNodeEdgeRep) ? opts.cNodeEdgeRep : 0.7;
    var nearbyFactor = Number.isFinite(opts.nearbyFactor) && opts.nearbyFactor > 0 ? opts.nearbyFactor : 6.0;
    var delayMs = Number.isFinite(opts.delayMs) ? Math.floor(opts.delayMs) : 0;
    var momentumBeta = Number.isFinite(opts.momentumBeta) ? Math.max(0, Math.min(0.98, opts.momentumBeta)) : 0.75;
    var rejectedVelocityDamp = Number.isFinite(opts.rejectedVelocityDamp) ? Math.max(0, Math.min(1, opts.rejectedVelocityDamp)) : 0.25;
    var rollbackVelocityDamp = Number.isFinite(opts.rollbackVelocityDamp) ? Math.max(0, Math.min(1, opts.rollbackVelocityDamp)) : 0.0;
    var fullRollbackVelocityDamp = Number.isFinite(opts.fullRollbackVelocityDamp) ? Math.max(0, Math.min(1, opts.fullRollbackVelocityDamp)) : 0.5;
    var iter;
    var velocityById = {};
    for (iter = 0; iter < g.nodeIds.length; iter += 1) {
      velocityById[g.nodeIds[iter]] = { x: 0, y: 0 };
    }

    iter = 0;
    for (iter = 0; iter < maxIters; iter += 1) {
      var prevPosById = clonePositionsMap(posById);
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
      var moved = 0;

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
        while (moveWouldCross(v, oldP, newP, g.edgePairs, posById) && shrink < 12) {
          newP.x = oldP.x + (newP.x - oldP.x) * 0.5;
          newP.y = oldP.y + (newP.y - oldP.y) * 0.5;
          shrink += 1;
        }
        if (moveWouldCross(v, oldP, newP, g.edgePairs, posById)) {
          velocityById[v].x *= rejectedVelocityDamp;
          velocityById[v].y *= rejectedVelocityDamp;
          continue;
        }

        var movedDx = newP.x - oldP.x;
        var movedDy = newP.y - oldP.y;
        if (Math.hypot(movedDx, movedDy) > 1e-6) {
          posById[v] = newP;
          velocityById[v] = { x: movedDx, y: movedDy };
          moved += 1;
        } else {
          velocityById[v].x *= rejectedVelocityDamp;
          velocityById[v].y *= rejectedVelocityDamp;
        }
      }

      var hasCrossings = false;
      if (global.PlanarVibeMetrics && global.PlanarVibeMetrics.hasCrossingsFromPositions) {
        hasCrossings = !!global.PlanarVibeMetrics.hasCrossingsFromPositions(posById, g.edgePairs);
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
          moved = 0;
          hasCrossings = false;
        } else if (global.PlanarVibeMetrics && global.PlanarVibeMetrics.hasCrossingsFromPositions) {
          rollbackResult.rolledBack.forEach(function (rv) {
            if (velocityById[rv]) {
              velocityById[rv].x *= rollbackVelocityDamp;
              velocityById[rv].y *= rollbackVelocityDamp;
            }
          });
          hasCrossings = !!global.PlanarVibeMetrics.hasCrossingsFromPositions(posById, g.edgePairs);
        } else {
          hasCrossings = false;
        }
      }

      if (typeof opts.onIteration === 'function') {
        opts.onIteration({
          iter: iter + 1,
          maxIters: maxIters,
          movedNodes: moved,
          maxMove: maxMove,
          hasCrossings: hasCrossings
        });
      }
      applyPositionsToCy(cy, posById);
      if (moved === 0) {
        break;
      }
      if (iter < maxIters - 1 && delayMs >= 0) {
        await waitForNextFrame(delayMs);
      }
    }

    applyPositionsToCy(cy, posById);
    if (opts.fit === true) {
      cy.fit(undefined, 24);
    }

    return {
      ok: true,
      message: 'Applied ImPrEd (' + g.nodeIds.length + ' vertices, ' + (iter + 1) + ' iters)'
    };
  }

  global.PlanarVibeImPrEd = {
    applyImPrEdLayout: applyImPrEdLayout
  };
})(window);
