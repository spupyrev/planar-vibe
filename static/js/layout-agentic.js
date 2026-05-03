(function (global) {
  'use strict';

  var CyRuntime = global.CyRuntime;
  var GraphUtils = global.GraphUtils;
  var GeometryUtils = global.GeometryUtils;
  var PlanarGraphUtils = global.PlanarGraphUtils;
  var Metrics = global.PlanarVibeMetrics;

  var METRIC_KEYS = [
    'angularResolution',
    'aspectRatio',
    'convexity',
    'edgeLengthDeviation',
    'edgeRatio',
    'edgeOrthogonality',
    'face',
    'nodeUniformity',
    'alignment',
    'spacing'
  ];

  var DEFAULT_OPTIONS = {
    budgetMs: 28000,
    edgeBalancerMaxNodes: 220,
    hybridMaxNodes: 120,
    reweightMaxNodes: 160,
    rotationSamples: 48
  };

  function toArray(collection) {
    if (!collection) return [];
    return typeof collection.toArray === 'function' ? collection.toArray() : collection;
  }

  function graphFromCy(cy) {
    var nodes = toArray(cy.nodes());
    var nodeIds = [];
    var keep = {};
    var i;
    for (i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (node && typeof node.hasClass === 'function' && node.hasClass('dummy-node')) {
        continue;
      }
      var id = String(node.id());
      nodeIds.push(id);
      keep[id] = true;
    }

    var edges = toArray(cy.edges());
    var edgePairs = [];
    var seen = {};
    for (i = 0; i < edges.length; i += 1) {
      var source = String(edges[i].source().id());
      var target = String(edges[i].target().id());
      if (!keep[source] || !keep[target] || source === target) {
        continue;
      }
      var key = GraphUtils.edgeKey(source, target);
      if (seen[key]) {
        continue;
      }
      seen[key] = true;
      edgePairs.push([source, target]);
    }
    return GraphUtils.createGraph(nodeIds, edgePairs);
  }

  function currentPositionsFromCy(cy) {
    if (CyRuntime && typeof CyRuntime.currentPositionsFromCy === 'function') {
      return CyRuntime.currentPositionsFromCy(cy);
    }
    var out = {};
    var nodes = toArray(cy.nodes());
    for (var i = 0; i < nodes.length; i += 1) {
      var id = String(nodes[i].id());
      var p = nodes[i].position();
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        out[id] = { x: p.x, y: p.y };
      }
    }
    return out;
  }

  function copyPositionsForNodes(posById, nodeIds) {
    var out = {};
    for (var i = 0; i < nodeIds.length; i += 1) {
      var id = String(nodeIds[i]);
      var p = posById ? posById[id] : null;
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        return null;
      }
      out[id] = { x: p.x, y: p.y };
    }
    return out;
  }

  function rotatePositions(posById, nodeIds, angle) {
    if (!Number.isFinite(angle) || Math.abs(angle) < 1e-12) {
      return copyPositionsForNodes(posById, nodeIds);
    }

    var cx = 0;
    var cy = 0;
    var n = 0;
    var i;
    for (i = 0; i < nodeIds.length; i += 1) {
      var p = posById[String(nodeIds[i])];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        return null;
      }
      cx += p.x;
      cy += p.y;
      n += 1;
    }
    if (n === 0) {
      return {};
    }
    cx /= n;
    cy /= n;

    var c = Math.cos(angle);
    var s = Math.sin(angle);
    var out = {};
    for (i = 0; i < nodeIds.length; i += 1) {
      var id = String(nodeIds[i]);
      p = posById[id];
      var dx = p.x - cx;
      var dy = p.y - cy;
      out[id] = {
        x: cx + c * dx - s * dy,
        y: cy + s * dx + c * dy
      };
    }
    return out;
  }

  function metricValue(result, key) {
    if (!result || !result.ok) {
      return 0;
    }
    if (key === 'edgeRatio') {
      return Number.isFinite(result.ratio) ? result.ratio : 0;
    }
    if (key === 'face') {
      return Number.isFinite(result.quality) ? result.quality : 0;
    }
    return Number.isFinite(result.score) ? result.score : 0;
  }

  function evaluatePositions(graph, posById, options) {
    var opts = options || {};
    var positions = copyPositionsForNodes(posById, graph.nodeIds);
    if (!positions) {
      return { ok: false, score: -Infinity, reason: 'missing positions' };
    }
    if (!opts.assumePlane && GeometryUtils.hasPositionCrossings(positions, graph.edgePairs)) {
      return { ok: false, score: -Infinity, reason: 'non-plane drawing' };
    }

    var embedding = null;
    try {
      embedding = PlanarGraphUtils.extractEmbeddingFromPositions(graph.nodeIds, graph.edgePairs, positions);
    } catch (err) {
      embedding = null;
    }

    var raw = {};
    raw.aspectRatio = metricValue(Metrics.computeAspectRatioScore(graph.nodeIds, positions), 'aspectRatio');
    raw.nodeUniformity = metricValue(Metrics.computeNodeUniformityScore(graph.nodeIds, positions), 'nodeUniformity');
    raw.edgeLengthDeviation = metricValue(Metrics.computeEdgeLengthDeviationScore(graph.edgePairs, positions), 'edgeLengthDeviation');
    raw.edgeRatio = metricValue(Metrics.computeEdgeLengthRatio(graph.edgePairs, positions), 'edgeRatio');
    raw.spacing = metricValue(Metrics.computeSpacingUniformityScore(graph.nodeIds, positions), 'spacing');
    raw.edgeOrthogonality = metricValue(Metrics.computeEdgeOrthogonalityScore(graph.edgePairs, positions), 'edgeOrthogonality');
    raw.alignment = metricValue(Metrics.computeAxisAlignmentScore(graph.nodeIds, positions), 'alignment');
    raw.angularResolution = metricValue(Metrics.computeAngularResolutionScore(graph, positions), 'angularResolution');
    raw.face = embedding
      ? metricValue(Metrics.computeUniformFaceAreaScore(graph.nodeIds, graph.edgePairs, positions, embedding), 'face')
      : 0;
    raw.convexity = embedding
      ? metricValue(Metrics.computeConvexityScore(graph.nodeIds, graph.edgePairs, positions, embedding), 'convexity')
      : 0;

    var sum = 0;
    for (var i = 0; i < METRIC_KEYS.length; i += 1) {
      sum += raw[METRIC_KEYS[i]];
    }
    return {
      ok: true,
      score: sum / METRIC_KEYS.length,
      metrics: raw,
      positions: positions
    };
  }

  function bestRotationForCandidate(graph, posById, rotationSamples) {
    var base = copyPositionsForNodes(posById, graph.nodeIds);
    if (!base || GeometryUtils.hasPositionCrossings(base, graph.edgePairs)) {
      return null;
    }

    var samples = Math.max(1, Math.floor(Number(rotationSamples) || 1));
    var best = null;
    var period = Math.PI;
    for (var i = 0; i < samples; i += 1) {
      var angle = period * i / samples;
      var rotated = rotatePositions(base, graph.nodeIds, angle);
      var evaluated = evaluatePositions(graph, rotated, { assumePlane: true });
      if (!evaluated.ok) {
        continue;
      }
      evaluated.rotation = angle;
      if (!best || evaluated.score > best.score) {
        best = evaluated;
      }
    }
    return best;
  }

  function buildComputeOptions(baseOptions, currentPositions) {
    var opts = Object.assign({}, baseOptions || {});
    opts.currentPositions = currentPositions;
    delete opts.candidates;
    delete opts.budgetMs;
    delete opts.edgeBalancerMaxNodes;
    delete opts.hybridMaxNodes;
    delete opts.reweightMaxNodes;
    delete opts.rotationSamples;
    return opts;
  }

  function buildCandidateSpecs(graph, options) {
    var opts = options || {};
    if (Array.isArray(opts.candidates) && opts.candidates.length > 0) {
      return opts.candidates.slice().map(String);
    }

    var n = graph.nodeIds.length;
    var specs = ['tutte'];
    var edgeMax = Number.isFinite(opts.edgeBalancerMaxNodes)
      ? opts.edgeBalancerMaxNodes
      : DEFAULT_OPTIONS.edgeBalancerMaxNodes;
    var hybridMax = Number.isFinite(opts.hybridMaxNodes)
      ? opts.hybridMaxNodes
      : DEFAULT_OPTIONS.hybridMaxNodes;
    var reweightMax = Number.isFinite(opts.reweightMaxNodes)
      ? opts.reweightMaxNodes
      : DEFAULT_OPTIONS.reweightMaxNodes;

    if (global.PlanarVibeEdgeBalancer &&
        typeof global.PlanarVibeEdgeBalancer.computeEdgeBalancerPositions === 'function' &&
        n <= edgeMax) {
      specs.push('edgebalancer');
    }
    if (global.PlanarVibeHybrid &&
        typeof global.PlanarVibeHybrid.computeHybridPositions === 'function' &&
        n <= hybridMax) {
      specs.push('hybrid');
    }
    if (global.PlanarVibeReweightTutte &&
        typeof global.PlanarVibeReweightTutte.computeReweightTuttePositions === 'function' &&
        n <= reweightMax) {
      specs.push('reweight');
    }
    return specs;
  }

  async function runCandidate(name, graph, computeOptions) {
    if (name === 'tutte' && global.PlanarVibeTutte &&
        typeof global.PlanarVibeTutte.computeTutteLayout === 'function') {
      return global.PlanarVibeTutte.computeTutteLayout(graph, computeOptions);
    }
    if (name === 'edgebalancer' && global.PlanarVibeEdgeBalancer &&
        typeof global.PlanarVibeEdgeBalancer.computeEdgeBalancerPositions === 'function') {
      return global.PlanarVibeEdgeBalancer.computeEdgeBalancerPositions(graph, computeOptions);
    }
    if (name === 'hybrid' && global.PlanarVibeHybrid &&
        typeof global.PlanarVibeHybrid.computeHybridPositions === 'function') {
      return global.PlanarVibeHybrid.computeHybridPositions(graph, computeOptions);
    }
    if (name === 'reweight' && global.PlanarVibeReweightTutte &&
        typeof global.PlanarVibeReweightTutte.computeReweightTuttePositions === 'function') {
      return global.PlanarVibeReweightTutte.computeReweightTuttePositions(graph, computeOptions);
    }
    return {
      ok: false,
      message: 'Unknown Agentic candidate: ' + String(name)
    };
  }

  async function applyAgenticLayout(cy, options) {
    var opts = Object.assign({}, DEFAULT_OPTIONS, options || {});
    var graph = graphFromCy(cy);
    var currentPositions = currentPositionsFromCy(cy);
    var candidateNames = buildCandidateSpecs(graph, opts);
    var startedAt = Date.now();
    var best = null;
    var failures = [];

    for (var i = 0; i < candidateNames.length; i += 1) {
      if (best && Date.now() - startedAt >= opts.budgetMs) {
        break;
      }

      var name = candidateNames[i];
      var result = null;
      try {
        result = await Promise.resolve(runCandidate(name, graph, buildComputeOptions(opts, currentPositions)));
      } catch (err) {
        failures.push(name + ': ' + (err && err.message ? err.message : String(err)));
        continue;
      }

      if (!result || !result.ok || !result.positions) {
        failures.push(name + ': ' + (result && result.message ? result.message : 'failed'));
        continue;
      }

      var evaluated = bestRotationForCandidate(graph, result.positions, opts.rotationSamples);
      if (!evaluated || !evaluated.ok) {
        failures.push(name + ': invalid scored drawing');
        continue;
      }
      evaluated.name = name;
      evaluated.result = result;
      if (!best || evaluated.score > best.score) {
        best = evaluated;
      }
    }

    if (!best) {
      return {
        ok: false,
        message: failures.length > 0
          ? 'Agentic failed (' + failures.slice(0, 3).join('; ') + ')'
          : 'Agentic failed (no valid candidates)'
      };
    }

    CyRuntime.applyPositionsToCy(cy, best.positions);
    if (typeof cy.fit === 'function') {
      cy.fit(undefined, 24);
    }

    return {
      ok: true,
      candidate: best.name,
      score: best.score,
      rotation: best.rotation,
      message: 'Applied Agentic (' + best.name + ', score ' + best.score.toFixed(3) + ')'
    };
  }

  global.PlanarVibeAgentic = {
    applyAgenticLayout: applyAgenticLayout
  };
})(window);
