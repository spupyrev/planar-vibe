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
    rotationSamples: 48,
    affineMaxNodes: 160,
    affineStretchFactors: [1, 1.03, 1.06, 1.1, 1.16, 1.22]
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

  function transformPositions(posById, nodeIds, angle, stretch) {
    var sxy = Number.isFinite(stretch) && stretch > 0 ? stretch : 1;
    if ((!Number.isFinite(angle) || Math.abs(angle) < 1e-12) && Math.abs(sxy - 1) < 1e-12) {
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
    var inv = 1 / sxy;
    var out = {};
    for (i = 0; i < nodeIds.length; i += 1) {
      var id = String(nodeIds[i]);
      p = posById[id];
      var dx = p.x - cx;
      var dy = p.y - cy;
      var rx = c * dx - s * dy;
      var ry = s * dx + c * dy;
      out[id] = {
        x: cx + sxy * rx,
        y: cy + inv * ry
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

  function normalizeStretchFactors(rawFactors, nodeCount, affineMaxNodes) {
    if (!(nodeCount <= affineMaxNodes)) {
      return [1];
    }
    var source = Array.isArray(rawFactors) && rawFactors.length > 0
      ? rawFactors
      : DEFAULT_OPTIONS.affineStretchFactors;
    var out = [];
    var seen = {};
    for (var i = 0; i < source.length; i += 1) {
      var value = Number(source[i]);
      if (!Number.isFinite(value) || !(value > 0)) {
        continue;
      }
      var factor = Math.max(1, value);
      var key = factor.toFixed(6);
      if (seen[key]) {
        continue;
      }
      seen[key] = true;
      out.push(factor);
    }
    return out.length > 0 ? out : [1];
  }

  function bestTransformForCandidate(graph, posById, options) {
    var opts = options || {};
    var base = copyPositionsForNodes(posById, graph.nodeIds);
    if (!base || GeometryUtils.hasPositionCrossings(base, graph.edgePairs)) {
      return null;
    }

    var samples = Math.max(1, Math.floor(Number(opts.rotationSamples) || 1));
    var affineMaxNodes = Number.isFinite(opts.affineMaxNodes)
      ? opts.affineMaxNodes
      : DEFAULT_OPTIONS.affineMaxNodes;
    var stretchFactors = normalizeStretchFactors(opts.affineStretchFactors, graph.nodeIds.length, affineMaxNodes);
    var best = null;
    var period = Math.PI;
    for (var f = 0; f < stretchFactors.length; f += 1) {
      var stretch = stretchFactors[f];
      for (var i = 0; i < samples; i += 1) {
        var angle = period * i / samples;
        var transformed = transformPositions(base, graph.nodeIds, angle, stretch);
        var evaluated = evaluatePositions(graph, transformed, { assumePlane: true });
        if (!evaluated.ok) {
          continue;
        }
        evaluated.rotation = angle;
        evaluated.stretch = stretch;
        if (!best || evaluated.score > best.score) {
          best = evaluated;
        }
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
    delete opts.rotationSamples;
    delete opts.affineMaxNodes;
    delete opts.affineStretchFactors;
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

      var evaluated = bestTransformForCandidate(graph, result.positions, opts);
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
      stretch: best.stretch,
      message: 'Applied Agentic (' + best.name + ', score ' + best.score.toFixed(3) + ')'
    };
  }

  global.PlanarVibeAgentic = {
    applyAgenticLayout: applyAgenticLayout
  };
})(window);
