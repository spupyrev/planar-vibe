(function (global) {
  'use strict';

  // Graph-specific helpers and lightweight graph analysis utilities.

  function normalizeOuterFace(outerFace) {
    return Array.isArray(outerFace) ? outerFace.slice() : [];
  }

  function edgeKey(u, v) {
    return u < v ? u + '::' + v : v + '::' + u;
  }

  function cloneEdgePairs(edgePairs) {
    var out = [];
    for (var i = 0; i < (edgePairs || []).length; i += 1) {
      out.push([edgePairs[i][0], edgePairs[i][1]]);
    }
    return out;
  }

  function hashString(value, seed) {
    var hash = seed >>> 0;
    var text = String(value);
    for (var i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function normalizedHash(value, seed) {
    return hashString(value, seed) / 4294967295;
  }

  function resolveFiniteOption(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
  }

  function resolveFloatOption(value, fallback, min, max) {
    if (!Number.isFinite(value)) {
      return fallback;
    }
    var out = value;
    if (Number.isFinite(min)) {
      out = Math.max(min, out);
    }
    if (Number.isFinite(max)) {
      out = Math.min(max, out);
    }
    return out;
  }

  function resolveIntOption(value, fallback, min, max) {
    if (!Number.isFinite(value)) {
      return fallback;
    }
    var out = Math.floor(value);
    if (Number.isFinite(min)) {
      out = Math.max(min, out);
    }
    if (Number.isFinite(max)) {
      out = Math.min(max, out);
    }
    return out;
  }

  function resolvePositiveOption(value, fallback) {
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  function resolveNonNegativeOption(value, fallback) {
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  }

  function resolveGreaterThanOption(value, fallback, threshold) {
    return Number.isFinite(value) && value > threshold ? value : fallback;
  }

  function resolveOpenIntervalOption(value, fallback, minExclusive, maxExclusive) {
    if (!Number.isFinite(value)) {
      return fallback;
    }
    if (Number.isFinite(minExclusive) && !(value > minExclusive)) {
      return fallback;
    }
    if (Number.isFinite(maxExclusive) && !(value < maxExclusive)) {
      return fallback;
    }
    return value;
  }

  function resolveFunctionOption(value, fallback) {
    return typeof value === 'function' ? value : fallback;
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

  function Graph(nodeIds, edgePairs) {
    if (!Array.isArray(nodeIds)) {
      throw new Error('Graph requires nodeIds array');
    }
    if (!Array.isArray(edgePairs)) {
      throw new Error('Graph requires edgePairs array');
    }

    this.nodeIds = nodeIds.slice();
    this.edgePairs = [];
    this.adjacency = {};
    this.adjacencySets = {};

    var nodeIdSet = new Set();
    for (var i = 0; i < this.nodeIds.length; i += 1) {
      var id = this.nodeIds[i];
      if (typeof id !== 'string') {
        throw new Error('Graph node ids must be strings');
      }
      if (nodeIdSet.has(id)) {
        throw new Error('Graph node ids must be unique');
      }
      nodeIdSet.add(id);
      this.adjacency[id] = [];
      this.adjacencySets[id] = new Set();
    }

    var edgeSet = new Set();
    for (i = 0; i < edgePairs.length; i += 1) {
      var edge = edgePairs[i];
      if (!Array.isArray(edge) || edge.length < 2) {
        throw new Error('Graph edges must be [source, target] pairs');
      }
      var u = edge[0];
      var v = edge[1];
      if (typeof u !== 'string' || typeof v !== 'string') {
        throw new Error('Graph edge endpoints must be strings');
      }
      if (!nodeIdSet.has(u) || !nodeIdSet.has(v)) {
        throw new Error('Graph edges must reference known node ids');
      }
      if (u === v) {
        throw new Error('Graph edges must be simple and cannot contain self-loops');
      }
      var key = edgeKey(u, v);
      if (edgeSet.has(key)) {
        throw new Error('Graph edges must be unique');
      }
      edgeSet.add(key);
      this.edgePairs.push([u, v]);
    }

    for (var i = 0; i < this.edgePairs.length; i += 1) {
      var u = this.edgePairs[i][0];
      var v = this.edgePairs[i][1];
      this.adjacency[u].push(v);
      this.adjacency[v].push(u);
      this.adjacencySets[u].add(v);
      this.adjacencySets[v].add(u);
    }
  }

  function createGraph(nodeIds, edgePairs) {
    return new Graph(nodeIds, edgePairs);
  }

  function connectivityAfterRemoving(nodeIds, adjacency, removedSet) {
    var ids = nodeIds;
    var start = null;
    var remaining = 0;
    for (var i = 0; i < ids.length; i += 1) {
      var id = ids[i];
      if (removedSet && removedSet.has(id)) {
        continue;
      }
      remaining += 1;
      if (start === null) {
        start = id;
      }
    }
    if (remaining <= 1) {
      return { connected: true, remaining: remaining };
    }

    var seen = new Set([start]);
    var queue = [start];
    while (queue.length > 0) {
      var u = queue.shift();
      var neighbors = adjacency[u];
      if (!neighbors) {
        continue;
      }
      neighbors.forEach(function (v) {
        if (removedSet && removedSet.has(v)) {
          return;
        }
        if (seen.has(v)) {
          return;
        }
        seen.add(v);
        queue.push(v);
      });
    }

    return {
      connected: seen.size === remaining,
      remaining: remaining
    };
  }

  function analyzeThreeConnectivity(graph) {
    var ids = graph.nodeIds;
    if (ids.length < 4) {
      return {
        ok: false,
        reason: 'Graph is not 3-connected: requires at least 4 vertices'
      };
    }

    var adj = graph.adjacencySets;
    for (var i = 0; i < ids.length; i += 1) {
      if ((adj[ids[i]] ? adj[ids[i]].size : 0) < 3) {
        return {
          ok: false,
          reason: 'Graph is not 3-connected: vertex ' + ids[i] + ' has degree < 3',
          witness: { type: 'low-degree', vertex: ids[i] }
        };
      }
    }

    var base = connectivityAfterRemoving(ids, adj, new Set());
    if (!base.connected) {
      return {
        ok: false,
        reason: 'Graph is not 3-connected: graph is disconnected',
        witness: { type: 'disconnected' }
      };
    }

    for (i = 0; i < ids.length; i += 1) {
      var cut1 = new Set([ids[i]]);
      if (!connectivityAfterRemoving(ids, adj, cut1).connected) {
        return {
          ok: false,
          reason: 'Graph is not 3-connected: articulation vertex ' + ids[i],
          witness: { type: 'articulation', vertex: ids[i] }
        };
      }
    }

    for (i = 0; i < ids.length; i += 1) {
      for (var j = i + 1; j < ids.length; j += 1) {
        var cut2 = new Set([ids[i], ids[j]]);
        if (!connectivityAfterRemoving(ids, adj, cut2).connected) {
          return {
            ok: false,
            reason: 'Graph is not 3-connected: separation pair {' + ids[i] + ', ' + ids[j] + '}',
            witness: { type: 'separation-pair', vertices: [ids[i], ids[j]] }
          };
        }
      }
    }

    return { ok: true };
  }

  function analyzeInternallyThreeConnected(graph, outerFace) {
    var ids = graph.nodeIds;
    var outer = Array.isArray(outerFace) ? outerFace.slice() : [];
    if (outer.length < 3) {
      return {
        ok: false,
        reason: 'Graph is not internally 3-connected: outer face must have at least 3 vertices'
      };
    }

    var idSet = new Set(ids);
    for (var i = 0; i < outer.length; i += 1) {
      if (!idSet.has(outer[i])) {
        return {
          ok: false,
          reason: 'Graph is not internally 3-connected: outer face contains unknown vertex ' + outer[i]
        };
      }
    }

    var hubId = '@internal3connOuterHub';
    var suffix = 0;
    while (idSet.has(hubId)) {
      suffix += 1;
      hubId = '@internal3connOuterHub' + suffix;
    }

    var augmentedNodeIds = ids.concat([hubId]);
    var augmentedEdgePairs = cloneEdgePairs(graph.edgePairs);
    var seenOuter = new Set();
    for (i = 0; i < outer.length; i += 1) {
      var v = outer[i];
      if (seenOuter.has(v)) {
        continue;
      }
      seenOuter.add(v);
      augmentedEdgePairs.push([hubId, v]);
    }

    var result = analyzeThreeConnectivity(createGraph(augmentedNodeIds, augmentedEdgePairs));
    if (result.ok) {
      return result;
    }
    return {
      ok: false,
      reason: 'Graph is not internally 3-connected for the chosen outer face: ' + result.reason,
      witness: result.witness || null
    };
  }

  function collectMovableVertices(nodeIds, outerFace) {
    var outerSet = new Set(outerFace || []);
    var movable = [];
    for (var i = 0; i < (nodeIds || []).length; i += 1) {
      var id = nodeIds[i];
      if (!outerSet.has(id)) {
        movable.push(id);
      }
    }
    return movable;
  }

  function computeMoveStats(items, distanceFn, options) {
    var opts = options || {};
    var moveTol = resolveNonNegativeOption(opts.moveTol, 1e-9);
    var movedVertices = 0;
    var totalMove = 0;
    var maxMove = 0;
    var list = Array.isArray(items) ? items : [];
    for (var i = 0; i < list.length; i += 1) {
      var dist = distanceFn(list[i], i);
      if (!Number.isFinite(dist) || dist < 0) {
        continue;
      }
      totalMove += dist;
      if (dist > maxMove) {
        maxMove = dist;
      }
      if (dist > moveTol) {
        movedVertices += 1;
      }
    }
    return {
      movedVertices: movedVertices,
      totalMove: totalMove,
      avgMove: list.length > 0 ? (totalMove / list.length) : 0,
      maxMove: maxMove
    };
  }

  function buildLayoutResult(fields) {
    var base = fields || {};
    var out = Object.assign({}, base);
    delete out.pos;
    var positions = base.positions !== undefined
      ? base.positions
      : (base.posById !== undefined ? base.posById : null);
    var posById = base.posById !== undefined ? base.posById : positions;
    var iters = Number.isFinite(base.iters) ? base.iters : (Number.isFinite(base.iterations) ? base.iterations : null);
    var iterations = Number.isFinite(base.iterations) ? base.iterations : iters;
    var status = base.status !== undefined ? base.status : (base.stopReason !== undefined ? base.stopReason : null);
    var stopReason = base.stopReason !== undefined ? base.stopReason : (base.status !== undefined ? base.status : null);

    return Object.assign(out, {
      ok: base.ok !== false,
      positions: positions,
      posById: posById,
      iters: iters,
      iterations: iterations,
      outerFace: base.outerFace !== undefined ? base.outerFace : null,
      graph: base.graph !== undefined ? base.graph : null,
      augmented: base.augmented !== undefined ? base.augmented : null,
      status: status,
      stopReason: stopReason
    });
  }

  function buildLayoutError(fields) {
    return buildLayoutResult(Object.assign({
      ok: false,
      positions: null,
      posById: null,
      iters: null,
      iterations: null,
      outerFace: null,
      graph: null,
      augmented: null,
      status: null,
      stopReason: null
    }, fields || {}));
  }

  function buildLayoutStatusMessage(layoutName, stats) {
    var name = String(layoutName || 'Layout');
    var data = stats || {};
    var parts = [];

    if (Number.isFinite(data.outerFaceVertexCount)) {
      parts.push(data.outerFaceVertexCount + '-vertex outer face');
    }
    if (Number.isFinite(data.boundedFaceCount)) {
      parts.push(data.boundedFaceCount + ' bounded faces');
    }
    if (Number.isFinite(data.vertexCount)) {
      parts.push(data.vertexCount + ' vertices');
    }
    if (Number.isFinite(data.dummyCount) && data.dummyCount > 0) {
      parts.push('+' + data.dummyCount + ' dummy vertices');
    }
    if (Number.isFinite(data.iters)) {
      parts.push(data.iters + ' iters');
    }
    if (Number.isFinite(data.outerSteps)) {
      parts.push(data.outerSteps + ' steps');
    }
    if (Number.isFinite(data.accepted)) {
      parts.push('accepted ' + data.accepted);
    }
    if (Number.isFinite(data.rejected)) {
      parts.push('rejected ' + data.rejected);
    }
    if (data.status) {
      parts.push('status ' + data.status);
    } else if (data.stopReason) {
      parts.push(String(data.stopReason));
    }
    if (Number.isFinite(data.maxRelError)) {
      parts.push('max rel err ' + data.maxRelError.toFixed(3));
    }
    if (Number.isFinite(data.faceAreaScore)) {
      parts.push('face score ' + data.faceAreaScore.toFixed(3));
    }
    if (Number.isFinite(data.faceAreaMinRatio)) {
      parts.push('min ratio ' + data.faceAreaMinRatio.toFixed(3));
    }
    if (Number.isFinite(data.faceAreaMaxRatio)) {
      parts.push('max ratio ' + data.faceAreaMaxRatio.toFixed(3));
    }
    if (Array.isArray(data.extraParts)) {
      for (var i = 0; i < data.extraParts.length; i += 1) {
        if (data.extraParts[i]) {
          parts.push(String(data.extraParts[i]));
        }
      }
    }

    return 'Applied ' + name + ' (' + parts.join(', ') + ')';
  }

  function computePositionMoveStats(nodeIds, prevPosById, nextPosById, options) {
    return computeMoveStats(nodeIds, function (nodeId) {
      var id = String(nodeId);
      var prev = prevPosById ? prevPosById[id] : null;
      var next = nextPosById ? nextPosById[id] : null;
      if (!prev || !next || !Number.isFinite(prev.x) || !Number.isFinite(prev.y) || !Number.isFinite(next.x) || !Number.isFinite(next.y)) {
        return NaN;
      }
      return Math.hypot(next.x - prev.x, next.y - prev.y);
    }, options);
  }

  function createMovementConvergenceTracker(options) {
    var opts = options || {};
    var minItersBeforeStop = resolveIntOption(opts.minItersBeforeStop, 20, 1);
    var stableIterLimit = resolveIntOption(opts.stableIterLimit, 5, 1);
    var maxMoveTol = resolveNonNegativeOption(opts.maxMoveTol, 1e-3);
    var avgMoveTol = resolveNonNegativeOption(opts.avgMoveTol, maxMoveTol);
    var stableIterations = 0;

    return {
      update: function (stats, iter) {
        var stable = !!stats &&
          Number.isFinite(stats.maxMove) &&
          Number.isFinite(stats.avgMove) &&
          stats.maxMove <= maxMoveTol &&
          stats.avgMove <= avgMoveTol;
        stableIterations = stable ? (stableIterations + 1) : 0;
        var ready = iter >= minItersBeforeStop && stableIterations >= stableIterLimit;
        return {
          stable: stable,
          stableIterations: stableIterations,
          stableIterLimit: stableIterLimit,
          converged: ready,
          reason: ready ? 'movement-converged' : null
        };
      }
    };
  }

  global.GraphUtils = {
    Graph: Graph,
    createGraph: createGraph,
    faceKey: faceKey,
    edgeKey: edgeKey,
    hashString: hashString,
    normalizedHash: normalizedHash,
    resolveFiniteOption: resolveFiniteOption,
    resolveFloatOption: resolveFloatOption,
    resolveIntOption: resolveIntOption,
    resolvePositiveOption: resolvePositiveOption,
    resolveNonNegativeOption: resolveNonNegativeOption,
    resolveGreaterThanOption: resolveGreaterThanOption,
    resolveOpenIntervalOption: resolveOpenIntervalOption,
    resolveFunctionOption: resolveFunctionOption,
    normalizeOuterFace: normalizeOuterFace,
    cloneEdgePairs: cloneEdgePairs,
    collectMovableVertices: collectMovableVertices,
    computeMoveStats: computeMoveStats,
    buildLayoutResult: buildLayoutResult,
    buildLayoutError: buildLayoutError,
    buildLayoutStatusMessage: buildLayoutStatusMessage,
    computePositionMoveStats: computePositionMoveStats,
    createMovementConvergenceTracker: createMovementConvergenceTracker,
    analyzeThreeConnectivity: analyzeThreeConnectivity,
    analyzeInternallyThreeConnected: analyzeInternallyThreeConnected
  };
})(window);
