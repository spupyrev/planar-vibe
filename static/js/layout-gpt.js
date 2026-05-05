(function (global) {
  'use strict';

  var CyRuntime = global.CyRuntime;
  var GraphUtils = global.GraphUtils;
  var GeometryUtils = global.GeometryUtils;
  var PlanarGraphUtils = global.PlanarGraphUtils;
  var PlanarityTest = global.PlanarVibePlanarityTest;
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
    budgetMs: 22000,
    edgeBalancerMaxNodes: 220,
    fabalancerMaxNodes: 120,
    airMaxNodes: 96,
    airMinEdgeRatio: 0.01,
    treeMaxNodes: 220,
    radialTreeMaxNodes: 220,
    unicyclicMaxNodes: 220,
    gridMaxNodes: 240,
    p3tMaxNodes: 220,
    outerplanarMaxNodes: 180,
    coreTreeMaxNodes: 110,
    coreTreeMaxCoreNodes: 70,
    leafSpreadMaxNodes: 120,
    leafSpreadMinLeaves: 4,
    leafSpreadMaxEdgeSurplusRatio: 0.65,
    leafSpreadMaxEdgeRatioDrop: 0.16,
    polishMaxNodes: 96,
    polishMaxScore: 0.90,
    polishMaxEvaluations: 450,
    polishLargeNodeThreshold: 50,
    polishLargeMaxEvaluations: 320,
    polishMinRemainingMs: 900,
    rotationSamples: 96,
    affineMaxNodes: 160,
    affineStretchFactors: [1, 1.04, 1.1, 1.2]
  };

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
      if (!adjacency[u] || !adjacency[v]) {
        continue;
      }
      degree[u] += 1;
      degree[v] += 1;
      adjacency[u].push(v);
      adjacency[v].push(u);
    }
    return { degree: degree, adjacency: adjacency };
  }

  function isConnected(graph, info) {
    if (graph.nodeIds.length <= 1) {
      return true;
    }
    var adjacency = info.adjacency;
    var start = String(graph.nodeIds[0]);
    var seen = {};
    var queue = [start];
    seen[start] = true;
    for (var qi = 0; qi < queue.length; qi += 1) {
      var u = queue[qi];
      var neighbors = adjacency[u] || [];
      for (var i = 0; i < neighbors.length; i += 1) {
        var v = String(neighbors[i]);
        if (seen[v]) {
          continue;
        }
        seen[v] = true;
        queue.push(v);
      }
    }
    return queue.length === graph.nodeIds.length;
  }

  function isTreeGraph(graph) {
    if (graph.nodeIds.length === 0 || graph.edgePairs.length !== graph.nodeIds.length - 1) {
      return false;
    }
    return isConnected(graph, graphInfo(graph));
  }

  function orderedPathNodes(graph, info) {
    var degree = info.degree;
    var adjacency = info.adjacency;
    var start = null;
    var endpoints = 0;
    var i;
    for (i = 0; i < graph.nodeIds.length; i += 1) {
      var id = String(graph.nodeIds[i]);
      if (degree[id] > 2) {
        return null;
      }
      if (degree[id] <= 1) {
        endpoints += 1;
        if (start === null || id < start) {
          start = id;
        }
      }
    }
    if (graph.nodeIds.length > 1 && endpoints !== 2) {
      return null;
    }
    if (start === null) {
      start = String(graph.nodeIds[0]);
    }

    var order = [];
    var previous = null;
    var current = start;
    var seen = {};
    while (current !== null) {
      order.push(current);
      seen[current] = true;
      var next = null;
      var neighbors = (adjacency[current] || []).slice().sort();
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
      var x = row % 2 === 0 ? col : width - 1 - col;
      positions[String(order[i])] = { x: x, y: row };
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
      if (degree[id] <= 1) {
        leaves.push(id);
      }
    }
    leaves.sort();
    while (remaining > 2 && leaves.length > 0) {
      var nextLeaves = [];
      remaining -= leaves.length;
      for (i = 0; i < leaves.length; i += 1) {
        var leaf = leaves[i];
        var neighbors = info.adjacency[leaf] || [];
        for (var j = 0; j < neighbors.length; j += 1) {
          var v = String(neighbors[j]);
          degree[v] -= 1;
          if (degree[v] === 1) {
            nextLeaves.push(v);
          }
        }
      }
      nextLeaves.sort();
      leaves = nextLeaves;
    }
    return leaves.length > 0 ? String(leaves[0]) : String(graph.nodeIds[0]);
  }

  function computeLayeredTreePositions(graph, info) {
    var root = findTreeCenter(graph, info);
    var parent = {};
    var children = {};
    var depth = {};
    var stack = [root];
    parent[root] = null;
    depth[root] = 0;
    for (var si = 0; si < stack.length; si += 1) {
      var u = stack[si];
      var neighbors = (info.adjacency[u] || []).slice().sort();
      children[u] = [];
      for (var i = 0; i < neighbors.length; i += 1) {
        var v = String(neighbors[i]);
        if (v === parent[u]) {
          continue;
        }
        parent[v] = u;
        depth[v] = depth[u] + 1;
        children[u].push(v);
        stack.push(v);
      }
    }
    if (stack.length !== graph.nodeIds.length) {
      return null;
    }

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
        if (leafCount[b] !== leafCount[a]) {
          return leafCount[b] - leafCount[a];
        }
        return a < b ? -1 : (a > b ? 1 : 0);
      });
      return total;
    }
    countLeaves(root);

    var positions = {};
    var nextX = 0;
    var maxDepth = 0;
    function assign(u) {
      var kids = children[u] || [];
      maxDepth = Math.max(maxDepth, depth[u] || 0);
      if (kids.length === 0) {
        positions[u] = { x: nextX, y: depth[u] || 0 };
        nextX += 1;
        return positions[u].x;
      }
      for (var i = 0; i < kids.length; i += 1) {
        assign(kids[i]);
      }
      var first = positions[kids[0]].x;
      var last = positions[kids[kids.length - 1]].x;
      positions[u] = { x: (first + last) / 2, y: depth[u] || 0 };
      return positions[u].x;
    }
    assign(root);

    var width = Math.max(1, nextX - 1);
    var levelGap = width > 0 && maxDepth > 0
      ? Math.max(0.75, Math.min(2.5, width / (maxDepth + 1)))
      : 1;
    for (var id in positions) {
      if (Object.prototype.hasOwnProperty.call(positions, id)) {
        positions[id].y *= levelGap;
      }
    }
    return positions;
  }

  function computeTreePositions(graph) {
    var info = graphInfo(graph);
    if (graph.edgePairs.length !== graph.nodeIds.length - 1 || !isConnected(graph, info)) {
      return { ok: false, message: 'Not a tree' };
    }
    var order = orderedPathNodes(graph, info);
    var positions = order ? computePathSnakePositions(order) : computeLayeredTreePositions(graph, info);
    if (!positions) {
      return { ok: false, message: 'Tree layout failed' };
    }
    return { ok: true, positions: positions, message: 'Computed tree layout' };
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
        if (v === parent[u]) {
          continue;
        }
        parent[v] = u;
        depth[v] = depth[u] + 1;
        children[u].push(v);
        order.push(v);
      }
    }
    if (order.length !== graph.nodeIds.length) {
      return null;
    }
    return { root: root, parent: parent, children: children, depth: depth, order: order };
  }

  function computeRadialTreePositions(graph) {
    var info = graphInfo(graph);
    if (graph.edgePairs.length !== graph.nodeIds.length - 1 || !isConnected(graph, info)) {
      return { ok: false, message: 'Not a tree' };
    }
    if (graph.nodeIds.length === 1) {
      var only = String(graph.nodeIds[0]);
      var single = {};
      single[only] = { x: 0, y: 0 };
      return { ok: true, positions: single, message: 'Computed radial tree layout' };
    }

    var rooted = buildRootedTree(graph, info);
    if (!rooted) {
      return { ok: false, message: 'Radial tree rooting failed' };
    }
    var children = rooted.children;
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
        if (leafCount[b] !== leafCount[a]) {
          return leafCount[b] - leafCount[a];
        }
        return a < b ? -1 : (a > b ? 1 : 0);
      });
      return total;
    }
    countLeaves(rooted.root);

    var positions = {};
    positions[rooted.root] = { x: 0, y: 0 };
    var twoPi = Math.PI * 2;
    var levelGap = 1.15;

    function assign(u, startAngle, endAngle) {
      var kids = children[u] || [];
      if (kids.length === 0) {
        return;
      }
      var span = endAngle - startAngle;
      var cursor = startAngle;
      var totalLeaves = 0;
      for (var i = 0; i < kids.length; i += 1) {
        totalLeaves += leafCount[kids[i]] || 1;
      }
      for (i = 0; i < kids.length; i += 1) {
        var child = kids[i];
        var part = span * (leafCount[child] || 1) / Math.max(1, totalLeaves);
        var a0 = cursor;
        var a1 = cursor + part;
        var angle = (a0 + a1) / 2;
        var radius = levelGap * (rooted.depth[child] || 1);
        positions[child] = {
          x: radius * Math.cos(angle),
          y: radius * Math.sin(angle)
        };
        assign(child, a0, a1);
        cursor = a1;
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
      if (degree[id] <= 1) {
        queue.push(id);
      }
    }

    for (var qi = 0; qi < queue.length; qi += 1) {
      var u = queue[qi];
      if (removed[u]) {
        continue;
      }
      removed[u] = true;
      var neighbors = info.adjacency[u] || [];
      for (i = 0; i < neighbors.length; i += 1) {
        var v = String(neighbors[i]);
        if (removed[v]) {
          continue;
        }
        degree[v] -= 1;
        if (degree[v] === 1) {
          queue.push(v);
        }
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
    if (core.length < 3) {
      return null;
    }
    for (i = 0; i < core.length; i += 1) {
      id = core[i];
      var coreDegree = 0;
      neighbors = info.adjacency[id] || [];
      for (var j = 0; j < neighbors.length; j += 1) {
        if (inCore[String(neighbors[j])]) {
          coreDegree += 1;
        }
      }
      if (coreDegree !== 2) {
        return null;
      }
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
        if (next !== start) {
          return null;
        }
        break;
      }
      if (!next || seen[next]) {
        return null;
      }
      previous = current;
      current = next;
    }
    return order;
  }

  function isUnicyclicGraph(graph) {
    var info = graphInfo(graph);
    return !!extractUnicyclicCycle(graph, info);
  }

  function computeUnicyclicPositions(graph) {
    var info = graphInfo(graph);
    var cycle = extractUnicyclicCycle(graph, info);
    if (!cycle) {
      return { ok: false, message: 'Not a connected unicyclic graph' };
    }
    var inCycle = {};
    var i;
    for (i = 0; i < cycle.length; i += 1) {
      inCycle[cycle[i]] = true;
    }

    var positions = {};
    var k = cycle.length;
    var cycleRadius = Math.max(1.2, 0.5 / Math.sin(Math.PI / k));
    for (i = 0; i < k; i += 1) {
      var angle = -Math.PI / 2 + (Math.PI * 2 * i / k);
      positions[cycle[i]] = {
        x: cycleRadius * Math.cos(angle),
        y: cycleRadius * Math.sin(angle)
      };
    }

    var children = {};
    function buildTree(u, parent) {
      var kids = [];
      var neighbors = (info.adjacency[u] || []).slice().sort();
      for (var j = 0; j < neighbors.length; j += 1) {
        var v = String(neighbors[j]);
        if (v === parent || inCycle[v]) {
          continue;
        }
        kids.push(v);
        buildTree(v, u);
      }
      children[u] = kids;
    }
    for (i = 0; i < k; i += 1) {
      var root = cycle[i];
      var rootKids = [];
      var neighbors = (info.adjacency[root] || []).slice().sort();
      for (var j = 0; j < neighbors.length; j += 1) {
        var v = String(neighbors[j]);
        if (inCycle[v]) {
          continue;
        }
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
      for (var j = 0; j < kids.length; j += 1) {
        total += countLeaves(kids[j]);
      }
      leafCount[u] = total;
      kids.sort(function (a, b) {
        if (leafCount[b] !== leafCount[a]) {
          return leafCount[b] - leafCount[a];
        }
        return a < b ? -1 : (a > b ? 1 : 0);
      });
      return total;
    }
    for (i = 0; i < k; i += 1) {
      countLeaves(cycle[i]);
    }

    var levelGap = 1.05;
    function assignSubtree(u, depth, startAngle, endAngle) {
      var kids = children[u] || [];
      if (kids.length === 0) {
        return;
      }
      var total = 0;
      for (var j = 0; j < kids.length; j += 1) {
        total += leafCount[kids[j]] || 1;
      }
      var cursor = startAngle;
      for (j = 0; j < kids.length; j += 1) {
        var child = kids[j];
        var span = (endAngle - startAngle) * (leafCount[child] || 1) / Math.max(1, total);
        var a0 = cursor;
        var a1 = cursor + span;
        var angle = (a0 + a1) / 2;
        var radius = cycleRadius + depth * levelGap;
        positions[child] = {
          x: radius * Math.cos(angle),
          y: radius * Math.sin(angle)
        };
        assignSubtree(child, depth + 1, a0, a1);
        cursor = a1;
      }
    }

    var baseSector = Math.PI * 2 / k;
    for (i = 0; i < k; i += 1) {
      angle = Math.atan2(positions[cycle[i]].y, positions[cycle[i]].x);
      var half = Math.min(baseSector * 0.42, Math.PI / 3);
      assignSubtree(cycle[i], 1, angle - half, angle + half);
    }

    return { ok: true, positions: positions, message: 'Computed unicyclic layout' };
  }

  function rectangularGridDimensions(graph) {
    var n = graph.nodeIds.length;
    var m = graph.edgePairs.length;
    if (n < 4) {
      return null;
    }
    var sideSum = 2 * n - m;
    for (var r = 2; r * r <= n; r += 1) {
      if (n % r === 0) {
        var c = n / r;
        if (r + c === sideSum) {
          return { rows: r, cols: c };
        }
      }
    }
    return null;
  }

  function hasRectangularGridSignature(graph) {
    var dims = rectangularGridDimensions(graph);
    if (!dims) {
      return false;
    }
    var info = graphInfo(graph);
    var corners = 0;
    for (var i = 0; i < graph.nodeIds.length; i += 1) {
      var d = info.degree[String(graph.nodeIds[i])] || 0;
      if (d > 4 || d < 2) {
        return false;
      }
      if (d === 2) {
        corners += 1;
      }
    }
    return corners === 4 && isConnected(graph, info);
  }

  function hasGridEdge(edgeSet, u, v) {
    return !!edgeSet[GraphUtils.edgeKey(String(u), String(v))];
  }

  function computeTwoRowGridPositions(graph, info, columns) {
    var edgeSet = {};
    var i;
    for (i = 0; i < graph.edgePairs.length; i += 1) {
      edgeSet[GraphUtils.edgeKey(String(graph.edgePairs[i][0]), String(graph.edgePairs[i][1]))] = true;
    }

    var corners = [];
    for (i = 0; i < graph.nodeIds.length; i += 1) {
      var id = String(graph.nodeIds[i]);
      if ((info.degree[id] || 0) === 2) {
        corners.push(id);
      }
    }
    corners.sort();

    for (var ci = 0; ci < corners.length; ci += 1) {
      var top = corners[ci];
      var neighbors = (info.adjacency[top] || []).slice().sort();
      for (var ni = 0; ni < neighbors.length; ni += 1) {
        var bottom = String(neighbors[ni]);
        if ((info.degree[bottom] || 0) !== 2) {
          continue;
        }

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

          if (col === columns - 1) {
            break;
          }

          var topNext = [];
          var topNeighbors = info.adjacency[topCur] || [];
          for (i = 0; i < topNeighbors.length; i += 1) {
            id = String(topNeighbors[i]);
            if (id !== topPrev && id !== bottomCur && !seen[id]) {
              topNext.push(id);
            }
          }

          var bottomNext = [];
          var bottomNeighbors = info.adjacency[bottomCur] || [];
          for (i = 0; i < bottomNeighbors.length; i += 1) {
            id = String(bottomNeighbors[i]);
            if (id !== bottomPrev && id !== topCur && !seen[id]) {
              bottomNext.push(id);
            }
          }

          if (topNext.length !== 1 || bottomNext.length !== 1 || !hasGridEdge(edgeSet, topNext[0], bottomNext[0])) {
            valid = false;
            break;
          }
          topPrev = topCur;
          bottomPrev = bottomCur;
          topCur = topNext[0];
          bottomCur = bottomNext[0];
        }

        if (!valid || Object.keys(seen).length !== graph.nodeIds.length) {
          continue;
        }
        for (i = 0; i < graph.edgePairs.length; i += 1) {
          var a = positions[String(graph.edgePairs[i][0])];
          var b = positions[String(graph.edgePairs[i][1])];
          if (!a || !b || Math.abs(a.x - b.x) + Math.abs(a.y - b.y) !== 1) {
            valid = false;
            break;
          }
        }
        if (valid) {
          return { ok: true, positions: positions, message: 'Computed two-row grid layout' };
        }
      }
    }
    return { ok: false, message: 'Two-row grid coordinate recovery failed' };
  }

  function isPlanar3TreeGraph(graph) {
    if (!global.PlanarVibePlanarityTest ||
        typeof global.PlanarVibePlanarityTest.analyzePlanar3Tree !== 'function') {
      return false;
    }
    try {
      var info = global.PlanarVibePlanarityTest.analyzePlanar3Tree(graph);
      return !!(info && info.ok);
    } catch (err) {
      return false;
    }
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
        if (v !== previous && !seen[v] && (info.degree[v] || 0) < 4) {
          candidates.push(v);
        }
      }
      if (candidates.length !== 1) {
        return null;
      }
      candidates.sort();
      previous = current;
      current = candidates[0];
      seen[current] = true;
      path.push(current);
    }
    return path;
  }

  function multiSourceDistances(graph, sources, info) {
    var dist = {};
    var queue = [];
    for (var i = 0; i < sources.length; i += 1) {
      var s = String(sources[i]);
      if (dist[s] === 0) {
        continue;
      }
      dist[s] = 0;
      queue.push(s);
    }
    for (var qi = 0; qi < queue.length; qi += 1) {
      var u = queue[qi];
      var neighbors = info.adjacency[u] || [];
      for (i = 0; i < neighbors.length; i += 1) {
        var v = String(neighbors[i]);
        if (dist[v] !== undefined) {
          continue;
        }
        dist[v] = dist[u] + 1;
        queue.push(v);
      }
    }
    return dist;
  }

  function computeRectangularGridPositions(graph) {
    if (!hasRectangularGridSignature(graph)) {
      return { ok: false, message: 'Not a rectangular grid' };
    }
    var info = graphInfo(graph);
    var dims = rectangularGridDimensions(graph);
    if (dims && (dims.rows === 2 || dims.cols === 2)) {
      return computeTwoRowGridPositions(graph, info, Math.max(dims.rows, dims.cols));
    }
    var corners = [];
    var i;
    for (i = 0; i < graph.nodeIds.length; i += 1) {
      var id = String(graph.nodeIds[i]);
      if ((info.degree[id] || 0) === 2) {
        corners.push(id);
      }
    }
    corners.sort();
    for (var ci = 0; ci < corners.length; ci += 1) {
      var corner = corners[ci];
      var neighbors = (info.adjacency[corner] || []).slice().sort();
      for (var flip = 0; flip < 2; flip += 1) {
        var pathX = traceGridBoundaryPath(corner, neighbors[flip], info);
        var pathY = traceGridBoundaryPath(corner, neighbors[1 - flip], info);
        if (!pathX || !pathY) {
          continue;
        }
        var width = pathX.length - 1;
        var height = pathY.length - 1;
        if ((width + 1) * (height + 1) !== graph.nodeIds.length) {
          continue;
        }
        var distToY = multiSourceDistances(graph, pathY, info);
        var distToX = multiSourceDistances(graph, pathX, info);
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
        if (!valid) {
          continue;
        }
        for (i = 0; i < graph.edgePairs.length; i += 1) {
          var a = positions[String(graph.edgePairs[i][0])];
          var b = positions[String(graph.edgePairs[i][1])];
          if (!a || !b || Math.abs(a.x - b.x) + Math.abs(a.y - b.y) !== 1) {
            valid = false;
            break;
          }
        }
        if (valid) {
          return { ok: true, positions: positions, message: 'Computed rectangular grid layout' };
        }
      }
    }
    return { ok: false, message: 'Rectangular grid coordinate recovery failed' };
  }

  function computeOuterplanarOrder(graph) {
    if (!PlanarityTest || typeof PlanarityTest.computePlanarEmbedding !== 'function') {
      return null;
    }
    var n = graph.nodeIds.length;
    if (n < 3) {
      return null;
    }

    var nodeIds = [];
    var idSet = {};
    var i;
    for (i = 0; i < n; i += 1) {
      var id = String(graph.nodeIds[i]);
      nodeIds.push(id);
      idSet[id] = true;
    }

    var hub = '@gptOuterHub';
    var suffix = 1;
    while (idSet[hub]) {
      hub = '@gptOuterHub' + suffix;
      suffix += 1;
    }

    var edgePairs = [];
    for (i = 0; i < graph.edgePairs.length; i += 1) {
      edgePairs.push([String(graph.edgePairs[i][0]), String(graph.edgePairs[i][1])]);
    }
    for (i = 0; i < nodeIds.length; i += 1) {
      edgePairs.push([hub, nodeIds[i]]);
    }

    var embedding = PlanarityTest.computePlanarEmbedding(nodeIds.concat([hub]), edgePairs);
    if (!embedding || !embedding.ok || !embedding.indexById || !Array.isArray(embedding.rotation)) {
      return null;
    }
    var hubIndex = embedding.indexById[hub];
    var rotation = Number.isInteger(hubIndex) ? embedding.rotation[hubIndex] : null;
    if (!Array.isArray(rotation) || rotation.length !== nodeIds.length) {
      return null;
    }

    var seen = {};
    var order = [];
    for (i = 0; i < rotation.length; i += 1) {
      id = String(rotation[i]);
      if (!idSet[id] || seen[id]) {
        return null;
      }
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
    if (!order) {
      return { ok: false, message: 'Not outerplanar' };
    }

    var n = order.length;
    var radius = Math.max(1, n / (Math.PI * 2));
    var positions = {};
    for (var i = 0; i < n; i += 1) {
      var angle = -Math.PI / 2 + Math.PI * 2 * i / n;
      positions[order[i]] = {
        x: radius * Math.cos(angle),
        y: radius * Math.sin(angle)
      };
    }
    if (GeometryUtils.hasPositionCrossings(positions, graph.edgePairs)) {
      return { ok: false, message: 'Outerplanar circle drawing crossed edges' };
    }
    return { ok: true, positions: positions, message: 'Computed outerplanar circle layout' };
  }

  function computeTwoCoreInfo(graph, options) {
    var opts = options || {};
    var maxNodes = Number.isFinite(opts.coreTreeMaxNodes)
      ? opts.coreTreeMaxNodes
      : DEFAULT_OPTIONS.coreTreeMaxNodes;
    var maxCoreNodes = Number.isFinite(opts.coreTreeMaxCoreNodes)
      ? opts.coreTreeMaxCoreNodes
      : DEFAULT_OPTIONS.coreTreeMaxCoreNodes;
    var n = graph.nodeIds.length;
    if (n > maxNodes) {
      return null;
    }

    var info = graphInfo(graph);
    if (!isConnected(graph, info)) {
      return null;
    }

    var degree = {};
    var removed = {};
    var queue = [];
    var i;
    for (i = 0; i < graph.nodeIds.length; i += 1) {
      var id = String(graph.nodeIds[i]);
      degree[id] = info.degree[id] || 0;
      if (degree[id] <= 1) {
        queue.push(id);
      }
    }

    for (var qi = 0; qi < queue.length; qi += 1) {
      var u = queue[qi];
      if (removed[u]) {
        continue;
      }
      removed[u] = true;
      var neighbors = info.adjacency[u] || [];
      for (i = 0; i < neighbors.length; i += 1) {
        var v = String(neighbors[i]);
        if (removed[v]) {
          continue;
        }
        degree[v] -= 1;
        if (degree[v] === 1) {
          queue.push(v);
        }
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
    if (core.length < 3 || core.length === graph.nodeIds.length || core.length > maxCoreNodes) {
      return null;
    }

    var coreEdges = [];
    for (i = 0; i < graph.edgePairs.length; i += 1) {
      var a = String(graph.edgePairs[i][0]);
      var b = String(graph.edgePairs[i][1]);
      if (coreSet[a] && coreSet[b]) {
        coreEdges.push([a, b]);
      }
    }
    if (coreEdges.length < core.length) {
      return null;
    }

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
    if (memo[id]) {
      return memo[id];
    }
    var kids = children[id] || [];
    if (kids.length === 0) {
      memo[id] = 1;
      return 1;
    }
    var total = 0;
    for (var i = 0; i < kids.length; i += 1) {
      total += coreTreeLeafCount(children, kids[i], memo);
    }
    memo[id] = total;
    return total;
  }

	  async function computeCoreTreePositions(graph, options) {
	    if (!global.PlanarVibeEdgeBalancer ||
	        typeof global.PlanarVibeEdgeBalancer.prepareGraphData !== 'function' ||
	        typeof global.PlanarVibeEdgeBalancer.computePositions !== 'function') {
	      return { ok: false, message: 'CoreTree requires EdgeBalancer' };
	    }

    var coreInfo = computeTwoCoreInfo(graph, options);
    if (!coreInfo) {
      return { ok: false, message: 'Not an eligible core-tree graph' };
    }

	    var coreOptions = Object.assign({}, options || {});
	    delete coreOptions.currentPositions;
	    var coreResult = await Promise.resolve(
	      computeWithLayoutModule(global.PlanarVibeEdgeBalancer, coreInfo.coreGraph, coreOptions)
	    );
    if (!coreResult || !coreResult.ok || !coreResult.positions) {
      return { ok: false, message: 'CoreTree core layout failed' };
    }

    var positions = copyPositionsForNodes(coreResult.positions, coreInfo.core);
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
        if (coreInfo.coreSet[v] || Object.prototype.hasOwnProperty.call(parent, v)) {
          continue;
        }
        parent[v] = u;
        if (!children[u]) {
          children[u] = [];
        }
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

    var levelGap = medianEdgeLength(coreInfo.coreGraph, positions) || 1;
    levelGap *= 0.95;
    var leafMemo = {};
    function assignSubtree(root, anchor, depth, startAngle, endAngle) {
      var kids = (children[root] || []).slice().sort(function (a, b) {
        var da = coreTreeLeafCount(children, a, leafMemo);
        var db = coreTreeLeafCount(children, b, leafMemo);
        if (db !== da) {
          return db - da;
        }
        return a < b ? -1 : (a > b ? 1 : 0);
      });
      if (kids.length === 0) {
        return;
      }

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
      var attachmentCount = 0;
      var rootChildren = children[coreId] || [];
      for (var ri = 0; ri < rootChildren.length; ri += 1) {
        if (!coreInfo.coreSet[rootChildren[ri]]) {
          attachmentCount += 1;
        }
      }
      if (attachmentCount === 0) {
        continue;
      }
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

  function medianFinite(values) {
    var out = [];
    for (var i = 0; i < values.length; i += 1) {
      var value = Number(values[i]);
      if (Number.isFinite(value)) {
        out.push(value);
      }
    }
    if (out.length === 0) {
      return null;
    }
    out.sort(function (a, b) { return a - b; });
    var mid = Math.floor(out.length / 2);
    return out.length % 2 === 1 ? out[mid] : (out[mid - 1] + out[mid]) / 2;
  }

  function normalizedPositiveAngle(angle) {
    var twoPi = Math.PI * 2;
    var out = angle % twoPi;
    if (out < 0) {
      out += twoPi;
    }
    return out;
  }

  function isLeafSpreadSource(name) {
    return name === 'edgebalancer' || name === 'fabalancer' || name === 'air';
  }

  function shouldTryLeafSpreadGraph(graph, options) {
    var opts = options || {};
    var n = graph.nodeIds.length;
    var maxNodes = Number.isFinite(opts.leafSpreadMaxNodes)
      ? opts.leafSpreadMaxNodes
      : DEFAULT_OPTIONS.leafSpreadMaxNodes;
    if (n > maxNodes || graph.edgePairs.length <= n) {
      return false;
    }
    var maxSurplusRatio = Number.isFinite(opts.leafSpreadMaxEdgeSurplusRatio)
      ? opts.leafSpreadMaxEdgeSurplusRatio
      : DEFAULT_OPTIONS.leafSpreadMaxEdgeSurplusRatio;
    if (graph.edgePairs.length - n > Math.max(6, Math.floor(n * maxSurplusRatio))) {
      return false;
    }
    var minLeaves = Number.isFinite(opts.leafSpreadMinLeaves)
      ? opts.leafSpreadMinLeaves
      : DEFAULT_OPTIONS.leafSpreadMinLeaves;
    var info = graphInfo(graph);
    if (!isConnected(graph, info)) {
      return false;
    }
    var leaves = 0;
    for (var i = 0; i < graph.nodeIds.length; i += 1) {
      if ((info.degree[String(graph.nodeIds[i])] || 0) === 1) {
        leaves += 1;
      }
    }
    return leaves >= minLeaves;
  }

  function medianEdgeLength(graph, posById, edgeFilter) {
    var lengths = [];
    for (var i = 0; i < graph.edgePairs.length; i += 1) {
      var u = String(graph.edgePairs[i][0]);
      var v = String(graph.edgePairs[i][1]);
      if (edgeFilter && !edgeFilter(u, v)) {
        continue;
      }
      var pu = posById[u];
      var pv = posById[v];
      if (!pu || !pv) {
        continue;
      }
      var dx = pu.x - pv.x;
      var dy = pu.y - pv.y;
      var len = Math.sqrt(dx * dx + dy * dy);
      if (len > 0) {
        lengths.push(len);
      }
    }
    return medianFinite(lengths);
  }

  function computeLeafSpreadPositions(graph, basePositions, options) {
    var opts = options || {};
    var info = graphInfo(graph);
    var positions = copyPositionsForNodes(basePositions, graph.nodeIds);
    if (!positions || GeometryUtils.hasPositionCrossings(positions, graph.edgePairs)) {
      return { ok: false, message: 'LeafSpread base is not plane' };
    }

    var minLeaves = Number.isFinite(opts.leafSpreadMinLeaves)
      ? opts.leafSpreadMinLeaves
      : DEFAULT_OPTIONS.leafSpreadMinLeaves;
    var leafSet = {};
    var leaves = [];
    var parentLeaves = {};
    var i;
    for (i = 0; i < graph.nodeIds.length; i += 1) {
      var id = String(graph.nodeIds[i]);
      if ((info.degree[id] || 0) !== 1) {
        continue;
      }
      var parent = String((info.adjacency[id] || [])[0] || '');
      if (!parent || !positions[parent]) {
        continue;
      }
      leafSet[id] = true;
      leaves.push(id);
      if (!parentLeaves[parent]) {
        parentLeaves[parent] = [];
      }
      parentLeaves[parent].push(id);
    }
    if (leaves.length < minLeaves) {
      return { ok: false, message: 'LeafSpread needs more leaves' };
    }

    var nonLeafMedian = medianEdgeLength(graph, positions, function (u, v) {
      return !leafSet[u] && !leafSet[v];
    });
    var allMedian = medianEdgeLength(graph, positions);
    var targetLength = nonLeafMedian || allMedian || 1;
    if (!(targetLength > 0)) {
      return { ok: false, message: 'LeafSpread has no length scale' };
    }

    var assignment = {};
    var parents = Object.keys(parentLeaves).sort();
    var twoPi = Math.PI * 2;
    for (i = 0; i < parents.length; i += 1) {
      parent = parents[i];
      var center = positions[parent];
      var kids = parentLeaves[parent].slice().sort();
      var occupied = [];
      var neighbors = (info.adjacency[parent] || []).slice().sort();
      for (var ni = 0; ni < neighbors.length; ni += 1) {
        var neighbor = String(neighbors[ni]);
        if (leafSet[neighbor]) {
          continue;
        }
        var q = positions[neighbor];
        if (!q) {
          continue;
        }
        occupied.push(normalizedPositiveAngle(Math.atan2(q.y - center.y, q.x - center.x)));
      }

      var localMedian = medianEdgeLength(graph, positions, function (u, v) {
        return (u === parent || v === parent) && !leafSet[u] && !leafSet[v];
      });
      var radius = localMedian || targetLength;
      radius *= 1 + Math.min(0.35, 0.04 * Math.max(0, kids.length - 1));

      if (occupied.length === 0) {
        for (var ki = 0; ki < kids.length; ki += 1) {
          assignment[kids[ki]] = {
            parent: parent,
            radius: radius,
            angle: -Math.PI + twoPi * (ki + 1) / (kids.length + 1)
          };
        }
        continue;
      }

      occupied.sort(function (a, b) { return a - b; });
      var gaps = [];
      for (var gi = 0; gi < occupied.length; gi += 1) {
        var start = occupied[gi];
        var end = occupied[(gi + 1) % occupied.length];
        var span = end - start;
        if (span <= 0) {
          span += twoPi;
        }
        gaps.push({ start: start, span: span, leaves: [] });
      }

      for (ki = 0; ki < kids.length; ki += 1) {
        var bestGap = gaps[0];
        var bestScore = -Infinity;
        for (gi = 0; gi < gaps.length; gi += 1) {
          var score = gaps[gi].span / (gaps[gi].leaves.length + 1);
          if (score > bestScore) {
            bestScore = score;
            bestGap = gaps[gi];
          }
        }
        bestGap.leaves.push(kids[ki]);
      }

      for (gi = 0; gi < gaps.length; gi += 1) {
        var gapLeaves = gaps[gi].leaves;
        if (gapLeaves.length === 0) {
          continue;
        }
        var margin = Math.min(gaps[gi].span * 0.18, Math.PI / 8);
        var usable = Math.max(gaps[gi].span - 2 * margin, gaps[gi].span * 0.35);
        var base = gaps[gi].start + (gaps[gi].span - usable) / 2;
        for (ki = 0; ki < gapLeaves.length; ki += 1) {
          assignment[gapLeaves[ki]] = {
            parent: parent,
            radius: radius,
            angle: base + usable * (ki + 1) / (gapLeaves.length + 1)
          };
        }
      }
    }

    var factors = [1.15, 1, 0.85, 0.7, 0.55, 0.4, 0.28];
    for (var fi = 0; fi < factors.length; fi += 1) {
      var out = copyPositionsForNodes(positions, graph.nodeIds);
      for (i = 0; i < leaves.length; i += 1) {
        id = leaves[i];
        var item = assignment[id];
        if (!item) {
          continue;
        }
        center = positions[item.parent];
        var r = item.radius * factors[fi];
        out[id] = {
          x: center.x + r * Math.cos(item.angle),
          y: center.y + r * Math.sin(item.angle)
        };
      }
      if (!GeometryUtils.hasPositionCrossings(out, graph.edgePairs)) {
        return {
          ok: true,
          positions: out,
          message: 'Computed sparse leaf-spread layout'
        };
      }
    }

    return { ok: false, message: 'LeafSpread could not keep drawing plane' };
  }

  function bestTransformForCandidate(graph, posById, options, deadlineMs) {
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
        if (best && Number.isFinite(deadlineMs) && Date.now() >= deadlineMs) {
          return best;
        }
        var angle = period * i / samples;
        var transformed = transformPositions(base, graph.nodeIds, angle, stretch);
        var evaluated = evaluatePositions(graph, transformed, Object.assign({}, opts, { assumePlane: true }));
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

  function shouldTryPolish(graph, evaluated, options, deadlineMs) {
    var opts = options || {};
    if (!evaluated || !evaluated.ok || !evaluated.positions) {
      return false;
    }
    var maxNodes = Number.isFinite(opts.polishMaxNodes)
      ? opts.polishMaxNodes
      : DEFAULT_OPTIONS.polishMaxNodes;
    if (graph.nodeIds.length > maxNodes) {
      return false;
    }
    var maxScore = Number.isFinite(opts.polishMaxScore)
      ? opts.polishMaxScore
      : DEFAULT_OPTIONS.polishMaxScore;
    if (Number.isFinite(maxScore) && evaluated.score > maxScore) {
      return false;
    }
    var minRemainingMs = Number.isFinite(opts.polishMinRemainingMs)
      ? opts.polishMinRemainingMs
      : DEFAULT_OPTIONS.polishMinRemainingMs;
    return !Number.isFinite(deadlineMs) || Date.now() + minRemainingMs < deadlineMs;
  }

  function computePolishedPositions(graph, seedPositions, seedScore, options, deadlineMs) {
    var opts = options || {};
    var positions = copyPositionsForNodes(seedPositions, graph.nodeIds);
    if (!positions || GeometryUtils.hasPositionCrossings(positions, graph.edgePairs)) {
      return null;
    }

    var best = evaluatePositions(graph, positions, opts);
    if (!best || !best.ok) {
      return null;
    }
    var originalScore = Number.isFinite(seedScore) ? seedScore : best.score;
    var maxEvaluations = Number.isFinite(opts.polishMaxEvaluations)
      ? Math.max(0, Math.floor(opts.polishMaxEvaluations))
      : DEFAULT_OPTIONS.polishMaxEvaluations;
    var largeThreshold = Number.isFinite(opts.polishLargeNodeThreshold)
      ? opts.polishLargeNodeThreshold
      : DEFAULT_OPTIONS.polishLargeNodeThreshold;
    var largeMaxEvaluations = Number.isFinite(opts.polishLargeMaxEvaluations)
      ? Math.max(0, Math.floor(opts.polishLargeMaxEvaluations))
      : DEFAULT_OPTIONS.polishLargeMaxEvaluations;
    if (graph.nodeIds.length > largeThreshold) {
      maxEvaluations = Math.min(maxEvaluations, largeMaxEvaluations);
    }
    if (maxEvaluations <= 0) {
      return null;
    }

    var ids = graph.nodeIds.slice().map(String).sort();
    var baseLength = medianEdgeLength(graph, positions) || 1;
    var stepFactors = [0.16, 0.09, 0.05, 0.028];
    var directions = [
      [1, 0], [-1, 0], [0, 1], [0, -1],
      [1, 1], [1, -1], [-1, 1], [-1, -1]
    ];
    var evaluations = 0;
    var moves = 0;

    function pastDeadline() {
      return Number.isFinite(deadlineMs) && Date.now() >= deadlineMs;
    }

    for (var fi = 0; fi < stepFactors.length; fi += 1) {
      var factor = stepFactors[fi];
      var improved = true;
      for (var pass = 0; improved && pass < 2; pass += 1) {
        improved = false;
        for (var ii = 0; ii < ids.length; ii += 1) {
          if (pastDeadline() || evaluations >= maxEvaluations) {
            break;
          }
          var id = ids[ii];
          var p = positions[id];
          if (!p) {
            continue;
          }

          var localDirections = directions.slice();
          var radialLength = Math.sqrt(p.x * p.x + p.y * p.y);
          if (radialLength > 1e-9) {
            localDirections.push([p.x / radialLength, p.y / radialLength]);
            localDirections.push([-p.x / radialLength, -p.y / radialLength]);
          }

          var localBest = best;
          var localPositions = null;
          for (var di = 0; di < localDirections.length; di += 1) {
            if (pastDeadline() || evaluations >= maxEvaluations) {
              break;
            }
            var dir = localDirections[di];
            var norm = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1]) || 1;
            var candidate = copyPositionsForNodes(positions, graph.nodeIds);
            if (!candidate) {
              continue;
            }
            candidate[id] = {
              x: p.x + baseLength * factor * dir[0] / norm,
              y: p.y + baseLength * factor * dir[1] / norm
            };
            evaluations += 1;
            var evaluated = evaluatePositions(graph, candidate, opts);
            if (evaluated && evaluated.ok && evaluated.score > localBest.score + 1e-6) {
              localBest = evaluated;
              localPositions = candidate;
            }
          }

          if (localPositions) {
            positions = localPositions;
            best = localBest;
            moves += 1;
            improved = true;
          }
        }
      }
    }

    if (moves === 0 || best.score <= originalScore + 1e-6) {
      return null;
    }
    best.moves = moves;
    best.evaluations = evaluations;
    return best;
  }

	  function buildComputeOptions(baseOptions, currentPositions) {
    var opts = Object.assign({}, baseOptions || {});
    opts.currentPositions = currentPositions;
    delete opts.candidates;
    delete opts.budgetMs;
    delete opts.edgeBalancerMaxNodes;
    delete opts.fabalancerMaxNodes;
    delete opts.airMaxNodes;
    delete opts.airMinEdgeRatio;
    delete opts.treeMaxNodes;
    delete opts.radialTreeMaxNodes;
    delete opts.unicyclicMaxNodes;
    delete opts.gridMaxNodes;
    delete opts.p3tMaxNodes;
    delete opts.outerplanarMaxNodes;
    delete opts.coreTreeMaxNodes;
    delete opts.coreTreeMaxCoreNodes;
    delete opts.leafSpreadMaxNodes;
    delete opts.leafSpreadMinLeaves;
    delete opts.leafSpreadMaxEdgeSurplusRatio;
    delete opts.leafSpreadMaxEdgeRatioDrop;
    delete opts.polishMaxNodes;
    delete opts.polishMaxScore;
    delete opts.polishMaxEvaluations;
    delete opts.polishLargeNodeThreshold;
    delete opts.polishLargeMaxEvaluations;
    delete opts.polishMinRemainingMs;
    delete opts.rotationSamples;
    delete opts.affineMaxNodes;
    delete opts.affineStretchFactors;
	    return opts;
	  }

	  function hasComputeInterface(module) {
	    return !!module &&
	      typeof module.prepareGraphData === 'function' &&
	      typeof module.computePositions === 'function';
	  }

	  function computeWithLayoutModule(module, graph, runtime) {
	    var layoutInput = module.prepareGraphData(graph, runtime);
	    return module.computePositions(layoutInput, {});
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
    var fabalancerMax = Number.isFinite(opts.fabalancerMaxNodes)
      ? opts.fabalancerMaxNodes
      : DEFAULT_OPTIONS.fabalancerMaxNodes;
    var airMax = Number.isFinite(opts.airMaxNodes)
      ? opts.airMaxNodes
      : DEFAULT_OPTIONS.airMaxNodes;
    var treeMax = Number.isFinite(opts.treeMaxNodes)
      ? opts.treeMaxNodes
      : DEFAULT_OPTIONS.treeMaxNodes;
    var radialTreeMax = Number.isFinite(opts.radialTreeMaxNodes)
      ? opts.radialTreeMaxNodes
      : DEFAULT_OPTIONS.radialTreeMaxNodes;
    var unicyclicMax = Number.isFinite(opts.unicyclicMaxNodes)
      ? opts.unicyclicMaxNodes
      : DEFAULT_OPTIONS.unicyclicMaxNodes;
    var gridMax = Number.isFinite(opts.gridMaxNodes)
      ? opts.gridMaxNodes
      : DEFAULT_OPTIONS.gridMaxNodes;
    var p3tMax = Number.isFinite(opts.p3tMaxNodes)
      ? opts.p3tMaxNodes
      : DEFAULT_OPTIONS.p3tMaxNodes;
    var outerplanarMax = Number.isFinite(opts.outerplanarMaxNodes)
      ? opts.outerplanarMaxNodes
      : DEFAULT_OPTIONS.outerplanarMaxNodes;
    var coreTreeMax = Number.isFinite(opts.coreTreeMaxNodes)
      ? opts.coreTreeMaxNodes
      : DEFAULT_OPTIONS.coreTreeMaxNodes;

    if (n <= treeMax && isTreeGraph(graph)) {
      specs.push('tree');
    }
    if (n <= radialTreeMax && isTreeGraph(graph)) {
      specs.push('radialtree');
    }
    if (n <= unicyclicMax && isUnicyclicGraph(graph)) {
      specs.push('unicyclic');
    }
    if (n <= gridMax && hasRectangularGridSignature(graph)) {
      specs.push('grid');
    }
    if (n <= outerplanarMax && isOuterplanarGraph(graph)) {
      specs.push('outercircle');
    }
    var tryCoreTree = n <= coreTreeMax && shouldTryCoreTreeGraph(graph, opts);
    if (tryCoreTree) {
      specs.push('coretree');
    }
	    if (hasComputeInterface(global.PlanarVibeP3T) &&
	        n <= p3tMax &&
	        isPlanar3TreeGraph(graph)) {
	      specs.push('p3t');
	    }
	
	    if (hasComputeInterface(global.PlanarVibeEdgeBalancer) &&
	        n <= edgeMax) {
	      specs.push('edgebalancer');
	    }
	    if (hasComputeInterface(global.PlanarVibeFABalancer) &&
	        n <= fabalancerMax) {
	      specs.push('fabalancer');
	    }
	    if (hasComputeInterface(global.PlanarVibeAir) &&
	        n <= airMax) {
	      specs.push('air');
	    }
    return specs;
  }

  async function runCandidate(name, graph, computeOptions) {
	    if (name === 'tutte' && hasComputeInterface(global.PlanarVibeTutte)) {
	      return computeWithLayoutModule(global.PlanarVibeTutte, graph, computeOptions);
	    }
	    if (name === 'edgebalancer' && hasComputeInterface(global.PlanarVibeEdgeBalancer)) {
	      return computeWithLayoutModule(global.PlanarVibeEdgeBalancer, graph, computeOptions);
	    }
	    if (name === 'fabalancer' && hasComputeInterface(global.PlanarVibeFABalancer)) {
	      return computeWithLayoutModule(global.PlanarVibeFABalancer, graph, computeOptions);
	    }
	    if (name === 'air' && hasComputeInterface(global.PlanarVibeAir)) {
	      return computeWithLayoutModule(global.PlanarVibeAir, graph, computeOptions);
    }
    if (name === 'tree') {
      return computeTreePositions(graph);
    }
    if (name === 'radialtree') {
      return computeRadialTreePositions(graph);
    }
    if (name === 'unicyclic') {
      return computeUnicyclicPositions(graph);
    }
    if (name === 'grid') {
      return computeRectangularGridPositions(graph);
    }
    if (name === 'outercircle') {
      return computeOuterplanarCirclePositions(graph);
    }
    if (name === 'coretree') {
      return computeCoreTreePositions(graph, computeOptions);
    }
	    if (name === 'p3t' && hasComputeInterface(global.PlanarVibeP3T)) {
	      return computeWithLayoutModule(global.PlanarVibeP3T, graph, computeOptions);
    }
    return {
      ok: false,
      message: 'Unknown GPT candidate: ' + String(name)
    };
  }

	  async function computePositions(layoutInput, options) {
    var opts = options;
    var graph = opts.graph;
    var currentPositions = opts.currentPositions;
    var candidateNames = buildCandidateSpecs(graph, opts);
    var startedAt = Date.now();
    var deadlineMs = Number.isFinite(opts.budgetMs) ? startedAt + opts.budgetMs : null;
    var best = null;
    var leafSpreadSeed = null;
    var leafSpreadEligible = shouldTryLeafSpreadGraph(graph, opts);
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

      var evaluated = bestTransformForCandidate(graph, result.positions, opts, deadlineMs);
      if (!evaluated || !evaluated.ok) {
        failures.push(name + ': invalid scored drawing');
        continue;
      }
      if (name === 'air' &&
          Number.isFinite(opts.airMinEdgeRatio) &&
          evaluated.metrics &&
          Number.isFinite(evaluated.metrics.edgeRatio) &&
          evaluated.metrics.edgeRatio < opts.airMinEdgeRatio) {
        failures.push(name + ': edge ratio below floor');
        continue;
      }
      evaluated.name = name;
      evaluated.result = result;
      if (!best || evaluated.score > best.score) {
        best = evaluated;
      }
      if (leafSpreadEligible &&
          isLeafSpreadSource(name) &&
          (!leafSpreadSeed || evaluated.score > leafSpreadSeed.score)) {
        leafSpreadSeed = {
          name: name,
          score: evaluated.score,
          metrics: evaluated.metrics,
          positions: result.positions
        };
      }
    }

    if (leafSpreadSeed && (!Number.isFinite(deadlineMs) || Date.now() < deadlineMs)) {
      var spreadResult = computeLeafSpreadPositions(graph, leafSpreadSeed.positions, opts);
      if (spreadResult && spreadResult.ok && spreadResult.positions) {
        var spreadEvaluated = bestTransformForCandidate(graph, spreadResult.positions, opts, deadlineMs);
        if (spreadEvaluated && spreadEvaluated.ok) {
          var maxEdgeRatioDrop = Number.isFinite(opts.leafSpreadMaxEdgeRatioDrop)
            ? opts.leafSpreadMaxEdgeRatioDrop
            : DEFAULT_OPTIONS.leafSpreadMaxEdgeRatioDrop;
          var seedEdgeRatio = leafSpreadSeed.metrics && leafSpreadSeed.metrics.edgeRatio;
          var spreadEdgeRatio = spreadEvaluated.metrics && spreadEvaluated.metrics.edgeRatio;
          if (Number.isFinite(maxEdgeRatioDrop) &&
              Number.isFinite(seedEdgeRatio) &&
              Number.isFinite(spreadEdgeRatio) &&
              spreadEdgeRatio < seedEdgeRatio - maxEdgeRatioDrop) {
            failures.push('leafspread-' + leafSpreadSeed.name + ': edge ratio drop above floor');
          } else {
            spreadEvaluated.name = 'leafspread-' + leafSpreadSeed.name;
            spreadEvaluated.result = spreadResult;
            if (!best || spreadEvaluated.score > best.score) {
              best = spreadEvaluated;
            }
          }
        }
      }
    }

    if (best && shouldTryPolish(graph, best, opts, deadlineMs)) {
      var polished = computePolishedPositions(graph, best.positions, best.score, opts, deadlineMs);
      if (polished && polished.ok && polished.score > best.score) {
        polished.name = 'polish-' + best.name;
        polished.result = {
          ok: true,
          positions: polished.positions,
          message: 'Computed polished layout'
        };
        best = polished;
      }
    }

    if (!best) {
      return {
        ok: false,
        message: failures.length > 0
          ? 'GPT failed (' + failures.slice(0, 3).join('; ') + ')'
          : 'GPT failed (no valid candidates)'
      };
    }

    return {
      ok: true,
      positions: GeometryUtils.normalizePositionMapToViewport(best.positions),
      candidate: best.name,
      score: best.score,
      rotation: best.rotation,
      stretch: best.stretch,
      message: 'Applied GPT (' + best.name + ', score ' + best.score.toFixed(3) + ')'
    };
  }

  async function applyLayout(cy, options) {
    var opts = Object.assign({}, DEFAULT_OPTIONS, options || {});
    return CyRuntime.runLayout(cy, opts, {
      initialFitBounds: function () {
        var defaults = global.PlanarVibeViewportDefaults || {};
        var width = Number.isFinite(defaults.width) ? defaults.width : 900;
        var height = Number.isFinite(defaults.height) ? defaults.height : 620;
        return { x1: 0, y1: 0, x2: width, y2: height };
      },
      computePositions: computePositions,
      failureMessage: 'GPT failed'
    });
  }

	  global.PlanarVibeGPT = {
	    computePositions: computePositions,
	    applyLayout: applyLayout
	  };
})(window);
