(function (global) {
  'use strict';

  var GraphUtils = global.GraphUtils;
  var GeometryUtils = global.GeometryUtils;
  var PlanarGraphUtils = global.PlanarGraphUtils;
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
 
  function snapshotCy(cy) {
    var nodeIds = [], edgePairs = [], posById = {};
    cy.nodes().forEach(function (n) {
      var id = String(n.id());
      nodeIds.push(id);
      var p = n.position();
      posById[id] = { x: p.x, y: p.y };
    });
    cy.edges().forEach(function (e) {
      edgePairs.push([String(e.source().id()), String(e.target().id())]);
    });
    return { nodeIds: nodeIds, edgePairs: edgePairs, posById: posById };
  }
 
  function applyPositions(cy, posById) {
    cy.nodes().forEach(function (n) {
      var id = String(n.id());
      var p = posById[id];
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        n.position({ x: p.x, y: p.y });
      }
    });
  }
 
  // Module-level cache: populated by applyLayout at entry.
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
 
  function extractCandidateEmbedding(graph, posById) {
    var embedding = PlanarGraphUtils.extractEmbeddingFromPositions(graph.nodeIds, graph.edgePairs, posById);
    return embedding && embedding.ok ? embedding : null;
  }

  async function runCandidate(module, graph, runtime) {
    var layoutInput = module.prepareGraphData(graph, runtime);
    var result = await module.computePositions(layoutInput, {});
    var positions = result && result.positions;
    var embedding = positions ? extractCandidateEmbedding(graph, positions) : null;
    return { ok: result && result.ok && !!embedding, posById: positions, embedding: embedding };
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
 
  async function applyLayout(cy, options) {
    options = options || {};
    var startMs = Date.now();
    // Default 22s instead of 25s — gives an 8s wall-clock safety margin against the 30s
    // eval timeout even if a single candidate runs several seconds longer than expected.
    var globalBudgetMs = Number.isFinite(options.claudeBudgetMs) ? options.claudeBudgetMs : 22000;
    var timeLeft = function () { return globalBudgetMs - (Date.now() - startMs); };
 
    var parsed = snapshotCy(cy);
    var nodeIds = parsed.nodeIds, edgePairs = parsed.edgePairs;
    var graph = GraphUtils.createGraph(nodeIds, edgePairs);
    _sharedCtx = { graph: graph };
    var runtime = Object.assign({}, options, { currentPositions: parsed.posById });
 
    // 1. Candidate layouts — EdgeBalancer is always listed first so we have at least one
    //    valid variant if time runs out before other candidates complete.
    var runners = [
      ['EdgeBalancer',   global.PlanarVibeEdgeBalancer],
      ['FABalancer',     global.PlanarVibeFABalancer],
      ['AngleBalancer',  global.PlanarVibeAngleBalancer],
      ['AreaGrad',       global.PlanarVibeAreaGrad],
      ['FaceBalancer',   global.PlanarVibeFaceBalancer],
      ['Reweight',       global.PlanarVibeReweight],
      ['Schnyder',       global.PlanarVibeSchnyder],
      ['CEGBfs',         global.PlanarVibeCEGBfs],
      ['Tutte',          global.PlanarVibeTutte]
    ];

    var variants = [];
    for (var i = 0; i < runners.length; i += 1) {
      // If we've already spent most of the budget, skip further candidates.
      // Always try EdgeBalancer (i=0) since it's fast and our strongest single layout.
      if (i > 0 && timeLeft() < 3000) break;
      var label = runners[i][0], module = runners[i][1];
      var out = await runCandidate(module, graph, runtime);
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
 
    applyPositions(cy, best.posById);
    if (typeof cy.fit === 'function') cy.fit();
    return {
      ok: true,
      message: 'Claude selected ' + best.label + ' (score=' + best.scores.total.toFixed(4) + ')',
      bestScore: best.scores.total
    };
  }
 
	  global.PlanarVibeClaude = { applyLayout: applyLayout };
})(typeof window !== 'undefined' ? window : globalThis);
