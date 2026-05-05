(function (global) {
  'use strict';

  var GraphUtils = global.GraphUtils;
  var GeometryUtils = global.GeometryUtils;
  var PlanarGraphUtils = global.PlanarGraphUtils;
  var PlanarityTest = global.PlanarVibePlanarityTest;
  var CyRuntime = global.CyRuntime;
  var Metrics = global.PlanarVibeMetrics;
  var Alignment = global.PlanarVibeAlignment;

  var METRIC_KEYS = [
    'angularResolution', 'aspectRatio', 'convexity', 'edgeLengthDeviation',
    'edgeRatio', 'edgeOrthogonality', 'face', 'nodeUniformity', 'alignment', 'spacing'
  ];

  var DIRS8 = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [0.707, 0.707], [-0.707, 0.707], [0.707, -0.707], [-0.707, -0.707]
  ];

  var CUSTOM_LIMITS = {
    treeMaxNodes: 220,
    radialTreeMaxNodes: 220,
    unicyclicMaxNodes: 220,
    gridMaxNodes: 240,
    outerplanarMaxNodes: 180,
    coreTreeMaxNodes: 110,
    coreTreeMaxCoreNodes: 70
  };

  // Module-level cache: populated by computePositions at entry.
  // Holds graph-only context shared by all candidate scoring.
  var _sharedCtx = null;

  // Compute all 10 metrics and a total (mean). Assumes posById is a plane drawing —
  // all call sites guarantee this by construction (candidates return plane drawings,
  // rotations are rigid, alignment self-validates, polish uses local moveBreaksPlanarity).
  function computeScores(nodeIds, edgePairs, posById, embedding) {
    var graph = _sharedCtx.graph;

    var aspect = Metrics.computeAspectRatioScore(nodeIds, posById);
    var nodeU = Metrics.computeNodeUniformityScore(nodeIds, posById);
    var edgeDev = Metrics.computeEdgeLengthDeviationScore(edgePairs, posById);
    var edgeRat = Metrics.computeEdgeLengthRatio(edgePairs, posById);
    var spacing = Metrics.computeSpacingUniformityScore(nodeIds, posById);
    var orth = Metrics.computeEdgeOrthogonalityScore(edgePairs, posById);
    var align = Metrics.computeAxisAlignmentScore(nodeIds, posById);
    var angRes = Metrics.computeAngularResolutionScore(graph, posById);
    var face = embedding
      ? Metrics.computeUniformFaceAreaScore(nodeIds, edgePairs, posById, embedding)
      : { ok: false };
    var conv = embedding
      ? Metrics.computeConvexityScore(nodeIds, edgePairs, posById, embedding)
      : { ok: false };

    // Metric calls return { ok: false } on degenerate input (e.g., disconnected faces).
    // Treat missing values as 0 — same as the evaluator.
    var m = {
      angularResolution: angRes.ok ? angRes.score : 0,
      aspectRatio: aspect.ok ? aspect.score : 0,
      convexity: conv.ok ? conv.score : 0,
      edgeLengthDeviation: edgeDev.ok ? edgeDev.score : 0,
      edgeRatio: edgeRat.ok ? edgeRat.ratio : 0,
      edgeOrthogonality: orth.ok ? orth.score : 0,
      face: face.ok ? face.quality : 0,
      nodeUniformity: nodeU.ok ? nodeU.score : 0,
      alignment: align.ok ? align.score : 0,
      spacing: spacing.ok ? spacing.score : 0
    };
    var total = 0;
    for (var i = 0; i < METRIC_KEYS.length; i += 1) {
      total += m[METRIC_KEYS[i]];
    }
    m.total = total / METRIC_KEYS.length;
    return m;
  }

  // Rotate positions by theta around their centroid.
  function rotatePositions(posById, theta) {
    var ids = Object.keys(posById);
    if (ids.length === 0) return {};
    var cx = 0, cy = 0;
    for (var i = 0; i < ids.length; i += 1) { cx += posById[ids[i]].x; cy += posById[ids[i]].y; }
    cx /= ids.length; cy /= ids.length;
    var cos = Math.cos(theta), sin = Math.sin(theta);
    var out = {};
    for (i = 0; i < ids.length; i += 1) {
      var q = posById[ids[i]];
      var dx = q.x - cx, dy = q.y - cy;
      out[ids[i]] = { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
    }
    return out;
  }

  // Sweep 19 angles in [0, π/2] (rotations modulo π/2 are metric-equivalent) and pick the best.
  function findBestRotation(nodeIds, edgePairs, posById, embedding) {
    var bestPos = posById, bestScore = null;
    for (var i = 0; i <= 18; i += 1) {
      var theta = (i / 18) * (Math.PI / 2);
      var cand = i === 0 ? posById : rotatePositions(posById, theta);
      var s = computeScores(nodeIds, edgePairs, cand, embedding);
      if (bestScore === null || s.total > bestScore.total) {
        bestScore = s; bestPos = cand;
      }
    }
    return { posById: bestPos, scores: bestScore };
  }

  // Build node index and incident-edge lists for fast planarity checks.
  function buildAdjIndex(nodeIds, edgePairs) {
    var idIndex = {};
    for (var i = 0; i < nodeIds.length; i += 1) idIndex[String(nodeIds[i])] = i;
    var n = nodeIds.length;
    var incident = new Array(n);
    for (i = 0; i < n; i += 1) incident[i] = [];
    var edges = [];
    for (i = 0; i < edgePairs.length; i += 1) {
      var u = idIndex[String(edgePairs[i][0])], v = idIndex[String(edgePairs[i][1])];
      if (u === undefined || v === undefined || u === v) continue;
      var idx = edges.length;
      edges.push([u, v]);
      incident[u].push(idx);
      incident[v].push(idx);
    }
    return { idIndex: idIndex, incident: incident, edges: edges };
  }

  // Does moving vertex vIdx to (nx,ny) violate planarity under the evaluator's predicate?
  // Three cases to check (matching GeometryUtils.hasPositionCrossings):
  //  (a) incident edge (newly-placed v, other) crosses a non-incident edge
  //  (b) the new position of v lies on the interior of a non-incident edge
  //  (c) some non-adjacent vertex lies on the interior of an incident edge (v, other)
  // (b) and (c) are node-on-edge cases — they don't involve edge-edge intersection, so
  // they're easy to miss; they were the reason polish silently produced non-plane drawings.
  function moveBreaksPlanarity(vIdx, nx, ny, posArr, adjIndex) {
    var edges = adjIndex.edges, incident = adjIndex.incident;
    var incSet = {};
    for (var i = 0; i < incident[vIdx].length; i += 1) incSet[incident[vIdx][i]] = true;
    var incEdges = incident[vIdx];
    var intersectFn = GeometryUtils.segmentsIntersectOrTouch;
    var triangleArea2 = GeometryUtils.triangleArea2;
    var pointOnSegmentInterior = GeometryUtils.pointOnSegmentInterior;
    var EPS = 1e-9;
    var pv = { x: nx, y: ny };

    // (a) and (b): iterate non-incident edges.
    for (var ei = 0; ei < edges.length; ei += 1) {
      if (incSet[ei]) continue;
      var a = edges[ei][0], b = edges[ei][1];
      var pa = posArr[a], pb = posArr[b];
      // (b) v lands on non-incident edge (a,b)?
      if (Math.abs(triangleArea2(pa, pb, pv)) <= EPS && pointOnSegmentInterior(pa, pb, pv, EPS)) {
        return true;
      }
      // (a) any incident edge (pv, other) crosses (a,b)?
      for (var j = 0; j < incEdges.length; j += 1) {
        var ej = incEdges[j];
        var other = edges[ej][0] === vIdx ? edges[ej][1] : edges[ej][0];
        if (other === a || other === b) continue;
        if (intersectFn(pv, posArr[other], pa, pb, EPS)) return true;
      }
    }

    // (c) any non-adjacent vertex lies on the interior of an incident edge (pv, other)?
    for (var k = 0; k < incEdges.length; k += 1) {
      var ek = incEdges[k];
      var otherK = edges[ek][0] === vIdx ? edges[ek][1] : edges[ek][0];
      var po = posArr[otherK];
      for (var w = 0; w < posArr.length; w += 1) {
        if (w === vIdx || w === otherK) continue;
        var pw = posArr[w];
        if (Math.abs(triangleArea2(pv, po, pw)) <= EPS && pointOnSegmentInterior(pv, po, pw, EPS)) {
          return true;
        }
      }
    }
    return false;
  }

  // Shared polish scaffolding used by polishByLocalMoves and restart.
  function polishScaffold(nodeIds, edgePairs, posById) {
    var adjIndex = buildAdjIndex(nodeIds, edgePairs);
    var n = nodeIds.length;
    var posArr = new Array(n);
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < n; i += 1) {
      var p = posById[nodeIds[i]];
      posArr[i] = { x: p.x, y: p.y };
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    var diag = Math.sqrt((maxX - minX) * (maxX - minX) + (maxY - minY) * (maxY - minY));
    if (!(diag > 0)) diag = 1;
    function snapshot() {
      var out = {};
      for (var k = 0; k < n; k += 1) out[nodeIds[k]] = { x: posArr[k].x, y: posArr[k].y };
      return out;
    }
    return { adjIndex: adjIndex, posArr: posArr, n: n, diag: diag, snapshot: snapshot };
  }

  function makeTimeGuard(startTimeMs, budgetMs) {
    return function () {
      if (!startTimeMs || !budgetMs) return false;
      return Date.now() - startTimeMs > budgetMs;
    };
  }

  // Greedy local-move polish: try 8 fixed directions per vertex at a schedule of step sizes,
  // accept any move that improves the 10-metric mean and preserves planarity.
  function polishByLocalMoves(nodeIds, edgePairs, posById, opts) {
    opts = opts || {};
    var embedding = opts.embedding;
    var maxPasses = opts.maxPasses || 2;
    var stepScale = opts.stepScale || 0.08;
    var minStepScale = opts.minStepScale || 0.005;
    var timeUp = makeTimeGuard(opts.startTimeMs, opts.budgetMs);

    var ctx = polishScaffold(nodeIds, edgePairs, posById);
    var posArr = ctx.posArr, n = ctx.n, diag = ctx.diag, adjIndex = ctx.adjIndex;
    var bestTotal = computeScores(nodeIds, edgePairs, ctx.snapshot(), embedding).total;

    var scale = stepScale;
    for (var pass = 0; pass < maxPasses && !timeUp(); pass += 1) {
      var step = scale * diag;
      if (step < minStepScale * diag) break;
      var improved = false;
      for (var vi = 0; vi < n && !timeUp(); vi += 1) {
        var px = posArr[vi].x, py = posArr[vi].y;
        var bestDx = 0, bestDy = 0;
        for (var di = 0; di < DIRS8.length; di += 1) {
          var dx = DIRS8[di][0] * step, dy = DIRS8[di][1] * step;
          if (moveBreaksPlanarity(vi, px + dx, py + dy, posArr, adjIndex)) continue;
          posArr[vi].x = px + dx; posArr[vi].y = py + dy;
          var sc = computeScores(nodeIds, edgePairs, ctx.snapshot(), embedding);
          posArr[vi].x = px; posArr[vi].y = py;
          if (sc.total > bestTotal + 1e-8) {
            bestTotal = sc.total; bestDx = dx; bestDy = dy; improved = true;
          }
        }
        if (bestDx !== 0 || bestDy !== 0) {
          posArr[vi].x += bestDx; posArr[vi].y += bestDy;
        }
      }
      if (!improved) scale *= 0.5;
    }

    var finalPos = ctx.snapshot();
    return { positions: finalPos, embedding: embedding, scores: computeScores(nodeIds, edgePairs, finalPos, embedding) };
  }

  // Move reflex vertices of non-convex faces toward their face centroid.
  function convexityRepair(nodeIds, edgePairs, posById, opts) {
    opts = opts || {};
    var embedding = opts.embedding;
    var maxPasses = opts.maxPasses || 3;
    var timeUp = makeTimeGuard(opts.startTimeMs, opts.budgetMs);

    var ctx = polishScaffold(nodeIds, edgePairs, posById);
    var posArr = ctx.posArr, n = ctx.n, diag = ctx.diag, adjIndex = ctx.adjIndex;
    var idIndex = adjIndex.idIndex;
    var bestTotal = computeScores(nodeIds, edgePairs, ctx.snapshot(), embedding).total;

    function reflexIndicesOf(face) {
      // Signed-area sign determines orientation; reflex = turn sign opposite.
      if (!face || face.length < 4) return [];
      var pts = [];
      for (var k = 0; k < face.length; k += 1) {
        var idx = idIndex[String(face[k])];
        if (idx === undefined) return [];
        pts.push(posArr[idx]);
      }
      var sArea = 0;
      for (k = 0; k < pts.length; k += 1) {
        var a = pts[k], b = pts[(k + 1) % pts.length];
        sArea += a.x * b.y - b.x * a.y;
      }
      var orient = sArea >= 0 ? 1 : -1;
      var eps = diag * 1e-9;
      var result = [];
      for (k = 0; k < pts.length; k += 1) {
        var prev = pts[(k - 1 + pts.length) % pts.length];
        var cur = pts[k], next = pts[(k + 1) % pts.length];
        var turn = (cur.x - prev.x) * (next.y - cur.y) - (cur.y - prev.y) * (next.x - cur.x);
        if (Math.abs(turn) <= eps) continue;
        if ((turn > 0 ? 1 : -1) !== orient) result.push(idIndex[String(face[k])]);
      }
      return result;
    }

    for (var pass = 0; pass < maxPasses && !timeUp(); pass += 1) {
      var emb = embedding;
      if (!emb || !emb.ok) break;
      var outerIdx = PlanarGraphUtils.findOuterFaceIndex(emb.faces, emb.outerFace || []);
      var improved = false;
      for (var fi = 0; fi < emb.faces.length && !timeUp(); fi += 1) {
        if (fi === outerIdx) continue;
        var face = emb.faces[fi];
        if (!Array.isArray(face) || face.length < 4) continue;
        var reflex = reflexIndicesOf(face);
        if (reflex.length === 0) continue;
        // Face centroid.
        var cx = 0, cy = 0, m = 0;
        for (var fk = 0; fk < face.length; fk += 1) {
          var fidx = idIndex[String(face[fk])];
          if (fidx === undefined) { m = 0; break; }
          cx += posArr[fidx].x; cy += posArr[fidx].y; m += 1;
        }
        if (m === 0) continue;
        cx /= m; cy /= m;
        for (var r = 0; r < reflex.length && !timeUp(); r += 1) {
          var vIdx = reflex[r];
          var px = posArr[vIdx].x, py = posArr[vIdx].y;
          var dx = cx - px, dy = cy - py;
          var dlen = Math.sqrt(dx * dx + dy * dy);
          if (!(dlen > 0)) continue;
          dx /= dlen; dy /= dlen;
          var steps = [0.4, 0.2, 0.1, 0.05, 0.02];
          var bestDx = 0, bestDy = 0;
          for (var s = 0; s < steps.length; s += 1) {
            var dist = Math.min(dlen * steps[s], 0.15 * diag);
            var nx = px + dx * dist, ny = py + dy * dist;
            if (moveBreaksPlanarity(vIdx, nx, ny, posArr, adjIndex)) continue;
            posArr[vIdx].x = nx; posArr[vIdx].y = ny;
            var sc = computeScores(nodeIds, edgePairs, ctx.snapshot(), embedding);
            posArr[vIdx].x = px; posArr[vIdx].y = py;
            if (sc.total > bestTotal + 1e-8) {
              bestTotal = sc.total; bestDx = dx * dist; bestDy = dy * dist;
            }
          }
          if (bestDx !== 0 || bestDy !== 0) {
            posArr[vIdx].x += bestDx; posArr[vIdx].y += bestDy;
            improved = true;
          }
        }
      }
      if (!improved) break;
    }

    var finalPos = ctx.snapshot();
    return { positions: finalPos, embedding: embedding, scores: computeScores(nodeIds, edgePairs, finalPos, embedding) };
  }

  // Deterministic RNG seeded from graph structure.
  function seededRng(nodeIds, edgePairs) {
    var key = nodeIds.slice().sort().join(',') + '|' + edgePairs.map(function (e) {
      var a = String(e[0]), b = String(e[1]);
      return a < b ? a + '-' + b : b + '-' + a;
    }).sort().join(';');
    var h = 2166136261 >>> 0;
    for (var i = 0; i < key.length; i += 1) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    var state = (h >>> 0) || 1;
    return function () {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  // Small random perturbation + polish. Returns improved positions if any.
  function restartPerturbAndPolish(nodeIds, edgePairs, posById, rng, opts) {
    opts = opts || {};
    var embedding = opts.embedding;
    var perturbScale = opts.perturbScale || 0.03;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < nodeIds.length; i += 1) {
      var p = posById[nodeIds[i]];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    var diag = Math.sqrt((maxX - minX) * (maxX - minX) + (maxY - minY) * (maxY - minY)) || 1;
    var perturbed = {};
    for (i = 0; i < nodeIds.length; i += 1) {
      var id = nodeIds[i], q = posById[id];
      perturbed[id] = {
        x: q.x + (rng() * 2 - 1) * perturbScale * diag,
        y: q.y + (rng() * 2 - 1) * perturbScale * diag
      };
    }
    if (GeometryUtils.hasPositionCrossings(perturbed, edgePairs)) {
      return { positions: posById, embedding: embedding, scores: computeScores(nodeIds, edgePairs, posById, embedding) };
    }
    return polishByLocalMoves(nodeIds, edgePairs, perturbed, {
      embedding: embedding,
      maxPasses: opts.maxPasses || 3,
      stepScale: opts.stepScale || 0.012,
      minStepScale: 0.0005,
      startTimeMs: opts.startTimeMs,
      budgetMs: opts.budgetMs
    });
  }

  function edgeKey(a, b) {
    a = String(a);
    b = String(b);
    return a < b ? a + '::' + b : b + '::' + a;
  }

  function graphInfo(graph) {
    var degree = {};
    var adjacency = {};
    var i;
    for (i = 0; i < graph.nodeIds.length; i += 1) {
      var id = String(graph.nodeIds[i]);
      degree[id] = 0;
      adjacency[id] = [];
    }
    for (i = 0; i < graph.edgePairs.length; i += 1) {
      var u = String(graph.edgePairs[i][0]);
      var v = String(graph.edgePairs[i][1]);
      if (!adjacency[u] || !adjacency[v]) continue;
      degree[u] += 1;
      degree[v] += 1;
      adjacency[u].push(v);
      adjacency[v].push(u);
    }
    return { degree: degree, adjacency: adjacency };
  }

  function isConnected(graph, info) {
    if (graph.nodeIds.length <= 1) return true;
    var seen = {};
    var queue = [String(graph.nodeIds[0])];
    seen[queue[0]] = true;
    for (var qi = 0; qi < queue.length; qi += 1) {
      var neighbors = info.adjacency[queue[qi]] || [];
      for (var i = 0; i < neighbors.length; i += 1) {
        var v = String(neighbors[i]);
        if (seen[v]) continue;
        seen[v] = true;
        queue.push(v);
      }
    }
    return queue.length === graph.nodeIds.length;
  }

  function isTreeGraph(graph) {
    return graph.nodeIds.length > 0 &&
      graph.edgePairs.length === graph.nodeIds.length - 1 &&
      isConnected(graph, graphInfo(graph));
  }

  function orderedPathNodes(graph, info) {
    var start = null;
    var endpoints = 0;
    var i;
    for (i = 0; i < graph.nodeIds.length; i += 1) {
      var id = String(graph.nodeIds[i]);
      var d = info.degree[id] || 0;
      if (d > 2) return null;
      if (d <= 1) {
        endpoints += 1;
        if (start === null || id < start) start = id;
      }
    }
    if (graph.nodeIds.length > 1 && endpoints !== 2) return null;
    if (start === null) start = String(graph.nodeIds[0]);

    var order = [];
    var previous = null;
    var current = start;
    var seen = {};
    while (current !== null) {
      order.push(current);
      seen[current] = true;
      var next = null;
      var neighbors = (info.adjacency[current] || []).slice().sort();
      for (i = 0; i < neighbors.length; i += 1) {
        var candidate = String(neighbors[i]);
        if (candidate !== previous && !seen[candidate]) {
          next = candidate;
          break;
        }
      }
      previous = current;
      current = next;
    }
    return order.length === graph.nodeIds.length ? order : null;
  }

  function computePathSnakePositions(order) {
    var n = order.length;
    var positions = {};
    if (n === 1) {
      positions[String(order[0])] = { x: 0, y: 0 };
      return positions;
    }
    var width = Math.max(2, Math.ceil(Math.sqrt(n)));
    for (var i = 0; i < n; i += 1) {
      var row = Math.floor(i / width);
      var col = i % width;
      positions[String(order[i])] = {
        x: row % 2 === 0 ? col : width - 1 - col,
        y: row
      };
    }
    return positions;
  }

  function findTreeCenter(graph, info) {
    var degree = {};
    var leaves = [];
    var remaining = graph.nodeIds.length;
    var i;
    for (i = 0; i < graph.nodeIds.length; i += 1) {
      var id = String(graph.nodeIds[i]);
      degree[id] = info.degree[id] || 0;
      if (degree[id] <= 1) leaves.push(id);
    }
    leaves.sort();
    while (remaining > 2 && leaves.length > 0) {
      var nextLeaves = [];
      remaining -= leaves.length;
      for (i = 0; i < leaves.length; i += 1) {
        var neighbors = info.adjacency[leaves[i]] || [];
        for (var j = 0; j < neighbors.length; j += 1) {
          var v = String(neighbors[j]);
          degree[v] -= 1;
          if (degree[v] === 1) nextLeaves.push(v);
        }
      }
      nextLeaves.sort();
      leaves = nextLeaves;
    }
    return leaves.length > 0 ? String(leaves[0]) : String(graph.nodeIds[0]);
  }

  function buildRootedTree(graph, info) {
    var root = findTreeCenter(graph, info);
    var parent = {};
    var children = {};
    var depth = {};
    var order = [root];
    parent[root] = null;
    depth[root] = 0;
    for (var qi = 0; qi < order.length; qi += 1) {
      var u = order[qi];
      var neighbors = (info.adjacency[u] || []).slice().sort();
      children[u] = [];
      for (var i = 0; i < neighbors.length; i += 1) {
        var v = String(neighbors[i]);
        if (v === parent[u]) continue;
        parent[v] = u;
        depth[v] = depth[u] + 1;
        children[u].push(v);
        order.push(v);
      }
    }
    return order.length === graph.nodeIds.length
      ? { root: root, parent: parent, children: children, depth: depth, order: order }
      : null;
  }

  function sortChildrenByLeaves(children, root) {
    var leafCount = {};
    function countLeaves(u) {
      var kids = children[u] || [];
      if (kids.length === 0) {
        leafCount[u] = 1;
        return 1;
      }
      var total = 0;
      for (var i = 0; i < kids.length; i += 1) {
        total += countLeaves(kids[i]);
      }
      leafCount[u] = total;
      kids.sort(function (a, b) {
        if (leafCount[b] !== leafCount[a]) return leafCount[b] - leafCount[a];
        return a < b ? -1 : (a > b ? 1 : 0);
      });
      return total;
    }
    countLeaves(root);
    return leafCount;
  }

  function computeLayeredTreePositions(graph, info) {
    var rooted = buildRootedTree(graph, info);
    if (!rooted) return null;
    var leafCount = sortChildrenByLeaves(rooted.children, rooted.root);
    var positions = {};
    var nextX = 0;
    var maxDepth = 0;
    function assign(u) {
      var kids = rooted.children[u] || [];
      maxDepth = Math.max(maxDepth, rooted.depth[u] || 0);
      if (kids.length === 0) {
        positions[u] = { x: nextX, y: rooted.depth[u] || 0 };
        nextX += 1;
        return positions[u].x;
      }
      for (var i = 0; i < kids.length; i += 1) assign(kids[i]);
      positions[u] = {
        x: (positions[kids[0]].x + positions[kids[kids.length - 1]].x) / 2,
        y: rooted.depth[u] || 0
      };
      return positions[u].x;
    }
    assign(rooted.root);
    var width = Math.max(1, nextX - 1);
    var levelGap = width > 0 && maxDepth > 0
      ? Math.max(0.75, Math.min(2.5, width / (maxDepth + 1)))
      : 1;
    for (var id in positions) {
      if (Object.prototype.hasOwnProperty.call(positions, id)) positions[id].y *= levelGap;
    }
    leafCount[rooted.root] = leafCount[rooted.root] || 1;
    return positions;
  }

  function computeTreePositions(graph) {
    var info = graphInfo(graph);
    if (graph.edgePairs.length !== graph.nodeIds.length - 1 || !isConnected(graph, info)) {
      return { ok: false, message: 'Not a tree' };
    }
    var order = orderedPathNodes(graph, info);
    var positions = order ? computePathSnakePositions(order) : computeLayeredTreePositions(graph, info);
    return positions
      ? { ok: true, positions: positions, message: 'Computed tree layout' }
      : { ok: false, message: 'Tree layout failed' };
  }

  function computeRadialTreePositions(graph) {
    var info = graphInfo(graph);
    if (graph.edgePairs.length !== graph.nodeIds.length - 1 || !isConnected(graph, info)) {
      return { ok: false, message: 'Not a tree' };
    }
    if (graph.nodeIds.length === 1) {
      var single = {};
      single[String(graph.nodeIds[0])] = { x: 0, y: 0 };
      return { ok: true, positions: single, message: 'Computed radial tree layout' };
    }
    var rooted = buildRootedTree(graph, info);
    if (!rooted) return { ok: false, message: 'Radial tree rooting failed' };
    var leafCount = sortChildrenByLeaves(rooted.children, rooted.root);
    var positions = {};
    positions[rooted.root] = { x: 0, y: 0 };
    function assign(u, startAngle, endAngle) {
      var kids = rooted.children[u] || [];
      if (kids.length === 0) return;
      var total = 0;
      for (var i = 0; i < kids.length; i += 1) total += leafCount[kids[i]] || 1;
      var cursor = startAngle;
      for (i = 0; i < kids.length; i += 1) {
        var child = kids[i];
        var span = (endAngle - startAngle) * (leafCount[child] || 1) / Math.max(1, total);
        var angle = cursor + span / 2;
        var radius = 1.15 * (rooted.depth[child] || 1);
        positions[child] = { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
        assign(child, cursor, cursor + span);
        cursor += span;
      }
    }
    assign(rooted.root, -Math.PI, Math.PI);
    return { ok: true, positions: positions, message: 'Computed radial tree layout' };
  }

  function extractUnicyclicCycle(graph, info) {
    if (graph.nodeIds.length < 3 || graph.edgePairs.length !== graph.nodeIds.length || !isConnected(graph, info)) {
      return null;
    }
    var degree = {};
    var removed = {};
    var queue = [];
    var i;
    for (i = 0; i < graph.nodeIds.length; i += 1) {
      var id = String(graph.nodeIds[i]);
      degree[id] = info.degree[id] || 0;
      if (degree[id] <= 1) queue.push(id);
    }
    for (var qi = 0; qi < queue.length; qi += 1) {
      var u = queue[qi];
      if (removed[u]) continue;
      removed[u] = true;
      var neighbors = info.adjacency[u] || [];
      for (i = 0; i < neighbors.length; i += 1) {
        var v = String(neighbors[i]);
        if (removed[v]) continue;
        degree[v] -= 1;
        if (degree[v] === 1) queue.push(v);
      }
    }

    var core = [];
    var inCore = {};
    for (i = 0; i < graph.nodeIds.length; i += 1) {
      id = String(graph.nodeIds[i]);
      if (!removed[id]) {
        core.push(id);
        inCore[id] = true;
      }
    }
    if (core.length < 3) return null;
    for (i = 0; i < core.length; i += 1) {
      id = core[i];
      var coreDegree = 0;
      neighbors = info.adjacency[id] || [];
      for (var j = 0; j < neighbors.length; j += 1) {
        if (inCore[String(neighbors[j])]) coreDegree += 1;
      }
      if (coreDegree !== 2) return null;
    }

    core.sort();
    var start = core[0];
    var order = [];
    var seen = {};
    var previous = null;
    var current = start;
    for (i = 0; i < core.length; i += 1) {
      order.push(current);
      seen[current] = true;
      var coreNeighbors = (info.adjacency[current] || []).filter(function (v) {
        return !!inCore[String(v)];
      }).map(String).sort();
      var next = null;
      for (j = 0; j < coreNeighbors.length; j += 1) {
        var candidate = coreNeighbors[j];
        if (candidate !== previous) {
          next = candidate;
          break;
        }
      }
      if (i === core.length - 1) {
        if (next !== start) return null;
        break;
      }
      if (!next || seen[next]) return null;
      previous = current;
      current = next;
    }
    return order;
  }

  function isUnicyclicGraph(graph) {
    return !!extractUnicyclicCycle(graph, graphInfo(graph));
  }

  function computeUnicyclicPositions(graph) {
    var info = graphInfo(graph);
    var cycle = extractUnicyclicCycle(graph, info);
    if (!cycle) return { ok: false, message: 'Not a connected unicyclic graph' };
    var inCycle = {};
    var i;
    var j;
    var v;
    for (i = 0; i < cycle.length; i += 1) inCycle[cycle[i]] = true;
    var positions = {};
    var k = cycle.length;
    var cycleRadius = Math.max(1.2, 0.5 / Math.sin(Math.PI / k));
    for (i = 0; i < k; i += 1) {
      var angle = -Math.PI / 2 + Math.PI * 2 * i / k;
      positions[cycle[i]] = { x: cycleRadius * Math.cos(angle), y: cycleRadius * Math.sin(angle) };
    }

    var children = {};
    function buildTree(u, parent) {
      var kids = [];
      var neighbors = (info.adjacency[u] || []).slice().sort();
      for (var j = 0; j < neighbors.length; j += 1) {
        var v = String(neighbors[j]);
        if (v === parent || inCycle[v]) continue;
        kids.push(v);
        buildTree(v, u);
      }
      children[u] = kids;
    }
    for (i = 0; i < k; i += 1) {
      var root = cycle[i];
      var rootKids = [];
      var rootNeighbors = (info.adjacency[root] || []).slice().sort();
      for (j = 0; j < rootNeighbors.length; j += 1) {
        v = String(rootNeighbors[j]);
        if (inCycle[v]) continue;
        rootKids.push(v);
        buildTree(v, root);
      }
      children[root] = rootKids;
    }
    var leafCount = {};
    function countLeaves(u) {
      var kids = children[u] || [];
      if (kids.length === 0) {
        leafCount[u] = 1;
        return 1;
      }
      var total = 0;
      for (var j = 0; j < kids.length; j += 1) total += countLeaves(kids[j]);
      leafCount[u] = total;
      kids.sort(function (a, b) {
        if (leafCount[b] !== leafCount[a]) return leafCount[b] - leafCount[a];
        return a < b ? -1 : (a > b ? 1 : 0);
      });
      return total;
    }
    for (i = 0; i < k; i += 1) countLeaves(cycle[i]);
    var levelGap = 1.05;
    function assignSubtree(u, depth, startAngle, endAngle) {
      var kids = children[u] || [];
      if (kids.length === 0) return;
      var total = 0;
      for (var j = 0; j < kids.length; j += 1) total += leafCount[kids[j]] || 1;
      var cursor = startAngle;
      for (j = 0; j < kids.length; j += 1) {
        var child = kids[j];
        var span = (endAngle - startAngle) * (leafCount[child] || 1) / Math.max(1, total);
        var a0 = cursor;
        var a1 = cursor + span;
        var childAngle = (a0 + a1) / 2;
        var radius = cycleRadius + depth * levelGap;
        positions[child] = { x: radius * Math.cos(childAngle), y: radius * Math.sin(childAngle) };
        assignSubtree(child, depth + 1, a0, a1);
        cursor = a1;
      }
    }
    var baseSector = Math.PI * 2 / k;
    for (i = 0; i < k; i += 1) {
      angle = Math.atan2(positions[cycle[i]].y, positions[cycle[i]].x);
      assignSubtree(cycle[i], 1, angle - Math.min(baseSector * 0.42, Math.PI / 3), angle + Math.min(baseSector * 0.42, Math.PI / 3));
    }
    return { ok: true, positions: positions, message: 'Computed unicyclic layout' };
  }

  function rectangularGridDimensions(graph) {
    var n = graph.nodeIds.length;
    var m = graph.edgePairs.length;
    if (n < 4) return null;
    var sideSum = 2 * n - m;
    for (var r = 2; r * r <= n; r += 1) {
      if (n % r !== 0) continue;
      var c = n / r;
      if (r + c === sideSum) return { rows: r, cols: c };
    }
    return null;
  }

  function hasRectangularGridSignature(graph) {
    var dims = rectangularGridDimensions(graph);
    if (!dims) return false;
    var info = graphInfo(graph);
    var corners = 0;
    for (var i = 0; i < graph.nodeIds.length; i += 1) {
      var d = info.degree[String(graph.nodeIds[i])] || 0;
      if (d > 4 || d < 2) return false;
      if (d === 2) corners += 1;
    }
    return corners === 4 && isConnected(graph, info);
  }

  function traceGridBoundaryPath(start, next, info) {
    var path = [String(start), String(next)];
    var previous = String(start);
    var current = String(next);
    var seen = {};
    seen[previous] = true;
    seen[current] = true;
    while ((info.degree[current] || 0) !== 2) {
      var candidates = [];
      var neighbors = info.adjacency[current] || [];
      for (var i = 0; i < neighbors.length; i += 1) {
        var v = String(neighbors[i]);
        if (v !== previous && !seen[v] && (info.degree[v] || 0) < 4) candidates.push(v);
      }
      if (candidates.length !== 1) return null;
      candidates.sort();
      previous = current;
      current = candidates[0];
      seen[current] = true;
      path.push(current);
    }
    return path;
  }

  function multiSourceDistances(sources, info) {
    var dist = {};
    var queue = [];
    for (var i = 0; i < sources.length; i += 1) {
      var s = String(sources[i]);
      if (dist[s] === 0) continue;
      dist[s] = 0;
      queue.push(s);
    }
    for (var qi = 0; qi < queue.length; qi += 1) {
      var u = queue[qi];
      var neighbors = info.adjacency[u] || [];
      for (i = 0; i < neighbors.length; i += 1) {
        var v = String(neighbors[i]);
        if (dist[v] !== undefined) continue;
        dist[v] = dist[u] + 1;
        queue.push(v);
      }
    }
    return dist;
  }

  function computeTwoRowGridPositions(graph, info, columns) {
    var edges = {};
    var i;
    for (i = 0; i < graph.edgePairs.length; i += 1) {
      edges[edgeKey(graph.edgePairs[i][0], graph.edgePairs[i][1])] = true;
    }
    var corners = [];
    for (i = 0; i < graph.nodeIds.length; i += 1) {
      var id = String(graph.nodeIds[i]);
      if ((info.degree[id] || 0) === 2) corners.push(id);
    }
    corners.sort();
    for (var ci = 0; ci < corners.length; ci += 1) {
      var top = corners[ci];
      var neighbors = (info.adjacency[top] || []).slice().sort();
      for (var ni = 0; ni < neighbors.length; ni += 1) {
        var bottom = String(neighbors[ni]);
        if ((info.degree[bottom] || 0) !== 2) continue;
        var positions = {};
        var seen = {};
        var topPrev = null;
        var bottomPrev = null;
        var topCur = top;
        var bottomCur = bottom;
        var valid = true;
        for (var col = 0; col < columns; col += 1) {
          if (seen[topCur] || seen[bottomCur]) {
            valid = false;
            break;
          }
          seen[topCur] = true;
          seen[bottomCur] = true;
          positions[topCur] = { x: col, y: 0 };
          positions[bottomCur] = { x: col, y: 1 };
          if (col === columns - 1) break;
          var topNext = [];
          var topNeighbors = info.adjacency[topCur] || [];
          for (i = 0; i < topNeighbors.length; i += 1) {
            id = String(topNeighbors[i]);
            if (id !== topPrev && id !== bottomCur && !seen[id]) topNext.push(id);
          }
          var bottomNext = [];
          var bottomNeighbors = info.adjacency[bottomCur] || [];
          for (i = 0; i < bottomNeighbors.length; i += 1) {
            id = String(bottomNeighbors[i]);
            if (id !== bottomPrev && id !== topCur && !seen[id]) bottomNext.push(id);
          }
          if (topNext.length !== 1 || bottomNext.length !== 1 || !edges[edgeKey(topNext[0], bottomNext[0])]) {
            valid = false;
            break;
          }
          topPrev = topCur;
          bottomPrev = bottomCur;
          topCur = topNext[0];
          bottomCur = bottomNext[0];
        }
        if (valid && Object.keys(seen).length === graph.nodeIds.length) {
          return { ok: true, positions: positions, message: 'Computed two-row grid layout' };
        }
      }
    }
    return { ok: false, message: 'Two-row grid coordinate recovery failed' };
  }

  function computeRectangularGridPositions(graph) {
    if (!hasRectangularGridSignature(graph)) return { ok: false, message: 'Not a rectangular grid' };
    var info = graphInfo(graph);
    var dims = rectangularGridDimensions(graph);
    if (dims && (dims.rows === 2 || dims.cols === 2)) {
      return computeTwoRowGridPositions(graph, info, Math.max(dims.rows, dims.cols));
    }
    var corners = [];
    var i;
    for (i = 0; i < graph.nodeIds.length; i += 1) {
      var id = String(graph.nodeIds[i]);
      if ((info.degree[id] || 0) === 2) corners.push(id);
    }
    corners.sort();
    for (var ci = 0; ci < corners.length; ci += 1) {
      var corner = corners[ci];
      var neighbors = (info.adjacency[corner] || []).slice().sort();
      for (var flip = 0; flip < 2; flip += 1) {
        var pathX = traceGridBoundaryPath(corner, neighbors[flip], info);
        var pathY = traceGridBoundaryPath(corner, neighbors[1 - flip], info);
        if (!pathX || !pathY) continue;
        var width = pathX.length - 1;
        var height = pathY.length - 1;
        if ((width + 1) * (height + 1) !== graph.nodeIds.length) continue;
        var distToY = multiSourceDistances(pathY, info);
        var distToX = multiSourceDistances(pathX, info);
        var positions = {};
        var occupied = {};
        var valid = true;
        for (i = 0; i < graph.nodeIds.length; i += 1) {
          id = String(graph.nodeIds[i]);
          var x = distToY[id];
          var y = distToX[id];
          if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > width || y > height) {
            valid = false;
            break;
          }
          var key = x + ',' + y;
          if (occupied[key]) {
            valid = false;
            break;
          }
          occupied[key] = true;
          positions[id] = { x: x, y: y };
        }
        if (!valid) continue;
        for (i = 0; i < graph.edgePairs.length; i += 1) {
          var a = positions[String(graph.edgePairs[i][0])];
          var b = positions[String(graph.edgePairs[i][1])];
          if (!a || !b || Math.abs(a.x - b.x) + Math.abs(a.y - b.y) !== 1) {
            valid = false;
            break;
          }
        }
        if (valid) return { ok: true, positions: positions, message: 'Computed rectangular grid layout' };
      }
    }
    return { ok: false, message: 'Rectangular grid coordinate recovery failed' };
  }

  function computeOuterplanarOrder(graph) {
    if (!PlanarityTest || typeof PlanarityTest.computePlanarEmbedding !== 'function') return null;
    var n = graph.nodeIds.length;
    if (n < 3) return null;
    var nodeIds = [];
    var idSet = {};
    var i;
    for (i = 0; i < n; i += 1) {
      var id = String(graph.nodeIds[i]);
      nodeIds.push(id);
      idSet[id] = true;
    }
    var hub = '@claudeOuterHub';
    var suffix = 1;
    while (idSet[hub]) {
      hub = '@claudeOuterHub' + suffix;
      suffix += 1;
    }
    var edgePairs = [];
    for (i = 0; i < graph.edgePairs.length; i += 1) {
      edgePairs.push([String(graph.edgePairs[i][0]), String(graph.edgePairs[i][1])]);
    }
    for (i = 0; i < nodeIds.length; i += 1) edgePairs.push([hub, nodeIds[i]]);
    var embedding = PlanarityTest.computePlanarEmbedding(nodeIds.concat([hub]), edgePairs);
    if (!embedding || !embedding.ok || !embedding.indexById || !Array.isArray(embedding.rotation)) return null;
    var hubIndex = embedding.indexById[hub];
    var rotation = Number.isInteger(hubIndex) ? embedding.rotation[hubIndex] : null;
    if (!Array.isArray(rotation) || rotation.length !== nodeIds.length) return null;
    var seen = {};
    var order = [];
    for (i = 0; i < rotation.length; i += 1) {
      id = String(rotation[i]);
      if (!idSet[id] || seen[id]) return null;
      seen[id] = true;
      order.push(id);
    }
    return order.length === nodeIds.length ? order : null;
  }

  function isOuterplanarGraph(graph) {
    return !!computeOuterplanarOrder(graph);
  }

  function computeOuterplanarCirclePositions(graph) {
    var order = computeOuterplanarOrder(graph);
    if (!order) return { ok: false, message: 'Not outerplanar' };
    var n = order.length;
    var radius = Math.max(1, n / (Math.PI * 2));
    var positions = {};
    for (var i = 0; i < n; i += 1) {
      var angle = -Math.PI / 2 + Math.PI * 2 * i / n;
      positions[order[i]] = { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
    }
    if (GeometryUtils.hasPositionCrossings(positions, graph.edgePairs)) {
      return { ok: false, message: 'Outerplanar circle drawing crossed edges' };
    }
    return { ok: true, positions: positions, message: 'Computed outerplanar circle layout' };
  }

  function copyPositionsForNodes(posById, nodeIds) {
    var out = {};
    for (var i = 0; i < nodeIds.length; i += 1) {
      var id = String(nodeIds[i]);
      var p = posById ? posById[id] : null;
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
      out[id] = { x: p.x, y: p.y };
    }
    return out;
  }

  function medianFinite(values) {
    var out = [];
    for (var i = 0; i < values.length; i += 1) {
      var value = Number(values[i]);
      if (Number.isFinite(value)) out.push(value);
    }
    if (out.length === 0) return null;
    out.sort(function (a, b) { return a - b; });
    var mid = Math.floor(out.length / 2);
    return out.length % 2 === 1 ? out[mid] : (out[mid - 1] + out[mid]) / 2;
  }

  function medianEdgeLength(graph, posById, edgeFilter) {
    var lengths = [];
    for (var i = 0; i < graph.edgePairs.length; i += 1) {
      var u = String(graph.edgePairs[i][0]);
      var v = String(graph.edgePairs[i][1]);
      if (edgeFilter && !edgeFilter(u, v)) continue;
      var pu = posById[u];
      var pv = posById[v];
      if (!pu || !pv) continue;
      var dx = pu.x - pv.x;
      var dy = pu.y - pv.y;
      var len = Math.sqrt(dx * dx + dy * dy);
      if (len > 0) lengths.push(len);
    }
    return medianFinite(lengths);
  }

  function computeTwoCoreInfo(graph, options) {
    var opts = options;
    var maxNodes = Number.isFinite(opts.coreTreeMaxNodes)
      ? opts.coreTreeMaxNodes
      : CUSTOM_LIMITS.coreTreeMaxNodes;
    var maxCoreNodes = Number.isFinite(opts.coreTreeMaxCoreNodes)
      ? opts.coreTreeMaxCoreNodes
      : CUSTOM_LIMITS.coreTreeMaxCoreNodes;
    if (graph.nodeIds.length > maxNodes) return null;

    var info = graphInfo(graph);
    if (!isConnected(graph, info)) return null;

    var degree = {};
    var removed = {};
    var queue = [];
    var i;
    for (i = 0; i < graph.nodeIds.length; i += 1) {
      var id = String(graph.nodeIds[i]);
      degree[id] = info.degree[id] || 0;
      if (degree[id] <= 1) queue.push(id);
    }

    for (var qi = 0; qi < queue.length; qi += 1) {
      var u = queue[qi];
      if (removed[u]) continue;
      removed[u] = true;
      var neighbors = info.adjacency[u] || [];
      for (i = 0; i < neighbors.length; i += 1) {
        var v = String(neighbors[i]);
        if (removed[v]) continue;
        degree[v] -= 1;
        if (degree[v] === 1) queue.push(v);
      }
    }

    var core = [];
    var coreSet = {};
    for (i = 0; i < graph.nodeIds.length; i += 1) {
      id = String(graph.nodeIds[i]);
      if (!removed[id]) {
        core.push(id);
        coreSet[id] = true;
      }
    }
    if (core.length < 3 || core.length === graph.nodeIds.length || core.length > maxCoreNodes) return null;

    var coreEdges = [];
    for (i = 0; i < graph.edgePairs.length; i += 1) {
      var a = String(graph.edgePairs[i][0]);
      var b = String(graph.edgePairs[i][1]);
      if (coreSet[a] && coreSet[b]) coreEdges.push([a, b]);
    }
    if (coreEdges.length < core.length) return null;

    return {
      info: info,
      core: core,
      coreSet: coreSet,
      coreGraph: GraphUtils.createGraph(core, coreEdges)
    };
  }

  function shouldTryCoreTreeGraph(graph, options) {
    return !!computeTwoCoreInfo(graph, options);
  }

  function coreTreeLeafCount(children, id, memo) {
    if (memo[id]) return memo[id];
    var kids = children[id] || [];
    if (kids.length === 0) {
      memo[id] = 1;
      return 1;
    }
    var total = 0;
    for (var i = 0; i < kids.length; i += 1) total += coreTreeLeafCount(children, kids[i], memo);
    memo[id] = total;
    return total;
  }

  async function computeCoreTreePositions(graph, options) {
    if (!hasComputeInterface(global.PlanarVibeEdgeBalancer)) {
      return { ok: false, message: 'CoreTree requires EdgeBalancer' };
    }
    var coreInfo = computeTwoCoreInfo(graph, options);
    if (!coreInfo) return { ok: false, message: 'Not an eligible core-tree graph' };

    var coreOptions = Object.assign({}, options || {});
    delete coreOptions.currentPositions;
    var coreResult = await runModuleCandidate(global.PlanarVibeEdgeBalancer, coreInfo.coreGraph, coreOptions);
    if (!coreResult || !coreResult.ok || !coreResult.posById) {
      return { ok: false, message: 'CoreTree core layout failed' };
    }

    var positions = copyPositionsForNodes(coreResult.posById, coreInfo.core);
    if (!positions || GeometryUtils.hasPositionCrossings(positions, coreInfo.coreGraph.edgePairs)) {
      return { ok: false, message: 'CoreTree core drawing is not plane' };
    }

    var children = {};
    var parent = {};
    var queue = coreInfo.core.slice().sort();
    var i;
    for (i = 0; i < coreInfo.core.length; i += 1) {
      var coreId = coreInfo.core[i];
      parent[coreId] = null;
      children[coreId] = [];
    }

    for (var qi = 0; qi < queue.length; qi += 1) {
      var u = queue[qi];
      var neighbors = (coreInfo.info.adjacency[u] || []).slice().sort();
      for (i = 0; i < neighbors.length; i += 1) {
        var v = String(neighbors[i]);
        if (coreInfo.coreSet[v] || Object.prototype.hasOwnProperty.call(parent, v)) continue;
        parent[v] = u;
        if (!children[u]) children[u] = [];
        children[u].push(v);
        children[v] = [];
        queue.push(v);
      }
    }
    if (Object.keys(parent).length !== graph.nodeIds.length) {
      return { ok: false, message: 'CoreTree attachment forest failed' };
    }

    var cx = 0;
    var cy = 0;
    for (i = 0; i < coreInfo.core.length; i += 1) {
      coreId = coreInfo.core[i];
      cx += positions[coreId].x;
      cy += positions[coreId].y;
    }
    cx /= coreInfo.core.length;
    cy /= coreInfo.core.length;

    var levelGap = (medianEdgeLength(coreInfo.coreGraph, positions) || 1) * 0.95;
    var leafMemo = {};
    function assignSubtree(root, anchor, depth, startAngle, endAngle) {
      var kids = (children[root] || []).slice().sort(function (a, b) {
        var da = coreTreeLeafCount(children, a, leafMemo);
        var db = coreTreeLeafCount(children, b, leafMemo);
        if (db !== da) return db - da;
        return a < b ? -1 : (a > b ? 1 : 0);
      });
      if (kids.length === 0) return;

      var total = 0;
      for (var ki = 0; ki < kids.length; ki += 1) {
        total += coreTreeLeafCount(children, kids[ki], leafMemo);
      }

      var cursor = startAngle;
      for (ki = 0; ki < kids.length; ki += 1) {
        var child = kids[ki];
        var span = (endAngle - startAngle) * coreTreeLeafCount(children, child, leafMemo) / Math.max(1, total);
        var angle = cursor + span / 2;
        positions[child] = {
          x: anchor.x + levelGap * depth * Math.cos(angle),
          y: anchor.y + levelGap * depth * Math.sin(angle)
        };
        assignSubtree(child, anchor, depth + 1, cursor, cursor + span);
        cursor += span;
      }
    }

    for (i = 0; i < coreInfo.core.length; i += 1) {
      coreId = coreInfo.core[i];
      var rootChildren = children[coreId] || [];
      var attachmentCount = 0;
      for (var ri = 0; ri < rootChildren.length; ri += 1) {
        if (!coreInfo.coreSet[rootChildren[ri]]) attachmentCount += 1;
      }
      if (attachmentCount === 0) continue;
      var p = positions[coreId];
      var outward = Math.atan2(p.y - cy, p.x - cx);
      var half = Math.min(Math.PI * 0.72, Math.max(Math.PI / 5, attachmentCount * Math.PI / 9));
      assignSubtree(coreId, p, 1, outward - half, outward + half);
    }

    var out = copyPositionsForNodes(positions, graph.nodeIds);
    if (!out || GeometryUtils.hasPositionCrossings(out, graph.edgePairs)) {
      return { ok: false, message: 'CoreTree could not keep drawing plane' };
    }
    return { ok: true, positions: out, message: 'Computed core-tree layout' };
  }

  function extractCandidateEmbedding(graph, posById) {
    var embedding = PlanarGraphUtils.extractEmbeddingFromPositions(graph.nodeIds, graph.edgePairs, posById);
    return embedding && embedding.ok ? embedding : null;
  }

  async function runModuleCandidate(module, graph, runtime) {
    var prepareOptions = Object.assign({}, runtime);
    delete prepareOptions.currentPositions;
    var layoutInput = module.prepareGraphData(graph, prepareOptions);
    var result = await module.computePositions(layoutInput, {});
    var positions = result && result.positions;
    var embedding = positions ? extractCandidateEmbedding(graph, positions) : null;
    return { ok: result && result.ok && !!embedding, posById: positions, embedding: embedding };
  }

  async function runInternalCandidate(computeLayout, graph, options) {
    var result = await Promise.resolve(computeLayout(graph, options));
    var positions = result && result.positions;
    var embedding = positions ? extractCandidateEmbedding(graph, positions) : null;
    return { ok: result && result.ok && !!embedding, posById: positions, embedding: embedding };
  }

  function hasComputeInterface(module) {
    return !!module &&
      typeof module.prepareGraphData === 'function' &&
      typeof module.computePositions === 'function';
  }

  function customLimit(options, key) {
    return Number.isFinite(options[key]) ? options[key] : CUSTOM_LIMITS[key];
  }

  function buildCandidateRunners(graph, options, runtime) {
    var opts = options;
    var n = graph.nodeIds.length;
    var runners = [];

    if (n <= customLimit(opts, 'treeMaxNodes') && isTreeGraph(graph)) {
      runners.push(['Tree', function () { return runInternalCandidate(computeTreePositions, graph); }]);
    }
    if (n <= customLimit(opts, 'radialTreeMaxNodes') && isTreeGraph(graph)) {
      runners.push(['RadialTree', function () { return runInternalCandidate(computeRadialTreePositions, graph); }]);
    }
    if (n <= customLimit(opts, 'unicyclicMaxNodes') && isUnicyclicGraph(graph)) {
      runners.push(['Unicyclic', function () { return runInternalCandidate(computeUnicyclicPositions, graph); }]);
    }
    if (n <= customLimit(opts, 'gridMaxNodes') && hasRectangularGridSignature(graph)) {
      runners.push(['Grid', function () { return runInternalCandidate(computeRectangularGridPositions, graph); }]);
    }
    if (n <= customLimit(opts, 'outerplanarMaxNodes') && isOuterplanarGraph(graph)) {
      runners.push(['OuterCircle', function () { return runInternalCandidate(computeOuterplanarCirclePositions, graph); }]);
    }
    if (n <= customLimit(opts, 'coreTreeMaxNodes') && shouldTryCoreTreeGraph(graph, opts)) {
      runners.push(['CoreTree', function () { return runInternalCandidate(computeCoreTreePositions, graph, opts); }]);
    }

    if (hasComputeInterface(global.PlanarVibeEdgeBalancer)) {
      runners.push(['EdgeBalancer', function () { return runModuleCandidate(global.PlanarVibeEdgeBalancer, graph, runtime); }]);
    }
    if (hasComputeInterface(global.PlanarVibeFABalancer)) {
      runners.push(['FABalancer', function () { return runModuleCandidate(global.PlanarVibeFABalancer, graph, runtime); }]);
    }
    if (hasComputeInterface(global.PlanarVibeAngleBalancer)) {
      runners.push(['AngleBalancer', function () { return runModuleCandidate(global.PlanarVibeAngleBalancer, graph, runtime); }]);
    }
    if (hasComputeInterface(global.PlanarVibeAreaGrad)) {
      runners.push(['AreaGrad', function () { return runModuleCandidate(global.PlanarVibeAreaGrad, graph, runtime); }]);
    }
    if (hasComputeInterface(global.PlanarVibeFaceBalancer)) {
      runners.push(['FaceBalancer', function () { return runModuleCandidate(global.PlanarVibeFaceBalancer, graph, runtime); }]);
    }
    if (hasComputeInterface(global.PlanarVibeReweight)) {
      runners.push(['Reweight', function () { return runModuleCandidate(global.PlanarVibeReweight, graph, runtime); }]);
    }
    if (hasComputeInterface(global.PlanarVibeSchnyder)) {
      runners.push(['Schnyder', function () { return runModuleCandidate(global.PlanarVibeSchnyder, graph, runtime); }]);
    }
    if (hasComputeInterface(global.PlanarVibeCEGBfs)) {
      runners.push(['CEGBfs', function () { return runModuleCandidate(global.PlanarVibeCEGBfs, graph, runtime); }]);
    }
    if (hasComputeInterface(global.PlanarVibeTutte)) {
      runners.push(['Tutte', function () { return runModuleCandidate(global.PlanarVibeTutte, graph, runtime); }]);
    }

    return runners;
  }

  // Try a candidate + generate base/rot/rot+align/align variants, scoring each.
  // timeLeft is a callback returning remaining budget in ms; used to skip expensive
  // rotation / alignment work on large graphs when time is tight.
  function expandVariants(label, posById, embedding, nodeIds, edgePairs, timeLeft) {
    var variants = [];
    variants.push({
      label: label + ':base',
      posById: posById,
      embedding: embedding,
      scores: computeScores(nodeIds, edgePairs, posById, embedding)
    });
    // Skip rotation/alignment variants if not enough time; base alone is enough to be a
    // valid fallback. Rotation sweep does 19 computeScores calls, each O(n+m).
    if (timeLeft && timeLeft() < 1000) return variants;

    var rot = findBestRotation(nodeIds, edgePairs, posById, embedding);
    variants.push({ label: label + ':rot', posById: rot.posById, embedding: embedding, scores: rot.scores });

    if (!timeLeft || timeLeft() > 500) {
      var a1 = Alignment.alignToAxisGreedy(nodeIds, edgePairs, rot.posById, {});
      if (a1.ok) {
        variants.push({
          label: label + ':rot+align',
          posById: a1.positions,
          embedding: embedding,
          scores: computeScores(nodeIds, edgePairs, a1.positions, embedding)
        });
      }
    }
    return variants;
  }

  function tryAlign(nodeIds, edgePairs, best) {
    var a = Alignment.alignToAxisGreedy(nodeIds, edgePairs, best.posById, {});
    if (!a.ok) return best;
    var s = computeScores(nodeIds, edgePairs, a.positions, best.embedding);
    if (s.total > best.scores.total) {
      return { label: best.label + '+align', posById: a.positions, embedding: best.embedding, scores: s };
    }
    return best;
  }

  function tryRot(nodeIds, edgePairs, best) {
    var r = findBestRotation(nodeIds, edgePairs, best.posById, best.embedding);
    if (r.scores.total > best.scores.total) {
      return { label: best.label + '+rot', posById: r.posById, embedding: best.embedding, scores: r.scores };
    }
    return best;
  }

  function tryPolish(nodeIds, edgePairs, best, opts, tag) {
    opts = Object.assign({}, opts || {}, { embedding: best.embedding });
    var res = polishByLocalMoves(nodeIds, edgePairs, best.posById, opts);
    if (res.scores.total > best.scores.total) {
      return { label: best.label + tag, posById: res.positions, embedding: best.embedding, scores: res.scores };
    }
    return best;
  }

  async function computePositions(layoutInput, options) {
    var opts = options;
    var startMs = Date.now();
    // Default 22s instead of 25s — gives an 8s wall-clock safety margin against the 30s
    // eval timeout even if a single candidate runs several seconds longer than expected.
    var globalBudgetMs = Number.isFinite(opts.claudeBudgetMs) ? opts.claudeBudgetMs : 22000;
    var timeLeft = function () { return globalBudgetMs - (Date.now() - startMs); };

    var graph = opts.graph;
    var nodeIds = graph.nodeIds;
    var edgePairs = graph.edgePairs;
    _sharedCtx = { graph: graph };
    var runtime = Object.assign({}, opts, { currentPositions: opts.currentPositions });

    // 1. Candidate layouts. Internal graph-class layouts are listed first when they match.
    var runners = buildCandidateRunners(graph, opts, runtime);

    var variants = [];
    for (var i = 0; i < runners.length; i += 1) {
      // If we've already spent most of the budget, skip further candidates.
      if (i > 0 && timeLeft() < 3000) break;
      var label = runners[i][0];
      var out = await runners[i][1]();
      if (out.ok) {
        var expanded = expandVariants(label, out.posById, out.embedding, nodeIds, edgePairs, timeLeft);
        for (var k = 0; k < expanded.length; k += 1) variants.push(expanded[k]);
      }
    }

    variants.sort(function (a, b) { return b.scores.total - a.scores.total; });
    var best = variants[0];

    // 2. Multi-start polish on the top-K variants (coarse polish).
    var n = nodeIds.length;
    var polishPasses = n > 80 ? 2 : (n > 60 ? 3 : (n > 40 ? 4 : 5));
    var polishStep = n > 80 ? 0.03 : (n > 60 ? 0.04 : (n > 40 ? 0.05 : 0.06));

    if (n <= 150 && timeLeft() > 1500) {
      var totalBudget = Math.min(n > 75 ? 7000 : (n > 50 ? 16000 : 22000), timeLeft() - 1500);
      var numStarts = n > 75 ? 1 : (n > 50 ? 2 : 3);
      var topK = variants.slice(0, Math.min(numStarts, variants.length));
      var perVariant = Math.max(1500, Math.floor(totalBudget / topK.length));

      for (var si = 0; si < topK.length; si += 1) {
        var startVar = topK[si];
        var polished = polishByLocalMoves(nodeIds, edgePairs, startVar.posById, {
          embedding: startVar.embedding,
          maxPasses: polishPasses, stepScale: polishStep,
          startTimeMs: Date.now(), budgetMs: perVariant
        });
        if (polished.scores.total > best.scores.total) {
          best = {
            label: startVar.label + '+polish',
            posById: polished.positions,
            embedding: startVar.embedding,
            scores: polished.scores
          };
        }
      }

      // Re-rotate + re-align after coarse polish.
      best = tryRot(nodeIds, edgePairs, best);
      best = tryAlign(nodeIds, edgePairs, best);

      // 3. Fine then micro polish. Re-align after.
      if (n <= 75 && timeLeft() > 1000) {
        best = tryPolish(nodeIds, edgePairs, best, {
          maxPasses: 4, stepScale: 0.015, minStepScale: 0.001,
          startTimeMs: Date.now(), budgetMs: Math.min(n > 50 ? 3500 : 5000, timeLeft() - 1000)
        }, '+fine');

        if (timeLeft() > 800) {
          best = tryPolish(nodeIds, edgePairs, best, {
            maxPasses: 3, stepScale: 0.004, minStepScale: 0.0003,
            startTimeMs: Date.now(), budgetMs: Math.min(n > 50 ? 2000 : 3000, timeLeft() - 500)
          }, '+micro');
          best = tryAlign(nodeIds, edgePairs, best);
        }

        // 4. Convexity repair for non-convex faces, followed by a brief settle polish.
        if (timeLeft() > 600) {
          var repaired = convexityRepair(nodeIds, edgePairs, best.posById, {
            embedding: best.embedding,
            maxPasses: 3, startTimeMs: Date.now(),
            budgetMs: Math.min(n > 50 ? 2500 : 4000, timeLeft() - 500)
          });
          if (repaired.scores.total > best.scores.total) {
            best = {
              label: best.label + '+cvx',
              posById: repaired.positions,
              embedding: best.embedding,
              scores: repaired.scores
            };
          }
          if (timeLeft() > 400) {
            best = tryPolish(nodeIds, edgePairs, best, {
              maxPasses: 2, stepScale: 0.008, minStepScale: 0.0005,
              startTimeMs: Date.now(), budgetMs: Math.min(1500, timeLeft() - 300)
            }, '+cvxpol');
          }
        }

        // 5. Restart search: small random perturbations + polish.
        if (n <= 50 && timeLeft() > 2000) {
          var rng = seededRng(nodeIds, edgePairs);
          var restartBudget = Math.min(4000, timeLeft() - 1500);
          var numRestarts = n > 30 ? 2 : 3;
          var perRestart = Math.floor(restartBudget / numRestarts);
          var perturbScales = [0.015, 0.03, 0.06];
          for (var ri = 0; ri < numRestarts; ri += 1) {
            if (timeLeft() < 800) break;
            var res = restartPerturbAndPolish(nodeIds, edgePairs, best.posById, rng, {
              embedding: best.embedding,
              perturbScale: perturbScales[ri % perturbScales.length],
              maxPasses: 3, stepScale: 0.012,
              startTimeMs: Date.now(), budgetMs: perRestart
            });
            if (res.scores.total > best.scores.total) {
              best = {
                label: best.label + '+restart' + ri,
                posById: res.positions,
                embedding: best.embedding,
                scores: res.scores
              };
            }
          }
        }

        // 6. Final settle polish.
        if (timeLeft() > 300) {
          best = tryPolish(nodeIds, edgePairs, best, {
            maxPasses: 2, stepScale: 0.003, minStepScale: 0.0002,
            startTimeMs: Date.now(), budgetMs: Math.min(1500, timeLeft() - 200)
          }, '+settle');
        }
      }
    }

    // 7. Iterative outer loop: re-apply rotation/alignment/fine polish a few times;
    //    new alignment can unlock further fine improvements.
    if (n <= 70 && timeLeft() > 1500) {
      var outerIters = n > 40 ? 2 : 3;
      for (var oi = 0; oi < outerIters; oi += 1) {
        if (timeLeft() < 800) break;
        var before = best.scores.total;
        best = tryRot(nodeIds, edgePairs, best);
        best = tryAlign(nodeIds, edgePairs, best);
        if (timeLeft() > 800) {
          best = tryPolish(nodeIds, edgePairs, best, {
            maxPasses: 3, stepScale: 0.006, minStepScale: 0.0003,
            startTimeMs: Date.now(), budgetMs: Math.min(1800, timeLeft() - 500)
          }, '+fineIter');
        }
        if (best.scores.total <= before + 1e-6) break;
      }
    }

    return {
      ok: true,
      positions: GeometryUtils.normalizePositionMapToViewport(best.posById),
      message: 'Claude selected ' + best.label + ' (score=' + best.scores.total.toFixed(4) + ')',
      bestScore: best.scores.total
    };
  }

  async function applyLayout(cy, options) {
    var opts = options || {};
    return CyRuntime.runLayout(cy, opts, {
      initialFitBounds: function () {
        var defaults = global.PlanarVibeViewportDefaults || {};
        var width = Number.isFinite(defaults.width) ? defaults.width : 900;
        var height = Number.isFinite(defaults.height) ? defaults.height : 620;
        return { x1: 0, y1: 0, x2: width, y2: height };
      },
      computePositions: computePositions,
      failureMessage: 'Claude failed'
    });
  }

	  global.PlanarVibeClaude = {
	    computePositions: computePositions,
	    applyLayout: applyLayout
	  };
})(typeof window !== 'undefined' ? window : globalThis);
