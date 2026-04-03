(function (global) {
  'use strict';

  // Graph-specific helpers plus compatibility re-exports from geometry and linear algebra modules.

  var PlanarGraphUtils = global.PlanarGraphUtils;
  var GraphGeometryUtils = global.GraphGeometryUtils;
  var LinearAlgebraUtils = global.LinearAlgebraUtils;

  if (!PlanarGraphUtils) {
    throw new Error('PlanarGraphUtils must be loaded before GraphUtils');
  }
  if (!GraphGeometryUtils) {
    throw new Error('GraphGeometryUtils must be loaded before GraphUtils');
  }
  if (!LinearAlgebraUtils) {
    throw new Error('LinearAlgebraUtils must be loaded before GraphUtils');
  }

  function normalizeNodeIds(nodeIds) {
    return (nodeIds || []).map(String);
  }

  function normalizeEdgePairs(edgePairs) {
    return (edgePairs || []).map(function (edge) {
      return [String(edge[0]), String(edge[1])];
    });
  }

  function normalizeGraphInput(nodeIds, edgePairs) {
    return {
      nodeIds: normalizeNodeIds(nodeIds),
      edgePairs: normalizeEdgePairs(edgePairs)
    };
  }

  function normalizeSimpleEdgePairs(edgePairs) {
    var pairs = normalizeEdgePairs(edgePairs);
    var out = [];
    var seen = new Set();
    for (var i = 0; i < pairs.length; i += 1) {
      var u = pairs[i][0];
      var v = pairs[i][1];
      if (u === v) {
        continue;
      }
      var key = edgeKey(u, v);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push([u, v]);
    }
    return out;
  }

  function normalizeOuterFace(outerFace) {
    return Array.isArray(outerFace) ? outerFace.slice().map(String) : [];
  }

  var edgeKey = PlanarGraphUtils.edgeKey;

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

  var cloneMatrix = LinearAlgebraUtils.cloneMatrix;
  var luFactorize = LinearAlgebraUtils.luFactorize;
  var solveLUWithTwoRhs = LinearAlgebraUtils.solveLUWithTwoRhs;
  var solveTransposeLUWithTwoRhs = LinearAlgebraUtils.solveTransposeLUWithTwoRhs;

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

  var polygonArea2 = GraphGeometryUtils.polygonArea2;
  var polygonAreaAbs = GraphGeometryUtils.polygonAreaAbs;
  var pointAdd = GraphGeometryUtils.pointAdd;
  var pointSub = GraphGeometryUtils.pointSub;
  var pointScale = GraphGeometryUtils.pointScale;
  var pointDot = GraphGeometryUtils.pointDot;
  var pointRot90 = GraphGeometryUtils.pointRot90;
  var pointNorm = GraphGeometryUtils.pointNorm;
  var pointEquals = GraphGeometryUtils.pointEquals;
  var pointOnSegment = GraphGeometryUtils.pointOnSegment;
  var pointOnSegmentInterior = GraphGeometryUtils.pointOnSegmentInterior;
  var vecDot = GraphGeometryUtils.vecDot;
  var vecNorm = GraphGeometryUtils.vecNorm;
  var vecAddScaled = GraphGeometryUtils.vecAddScaled;
  var vecSub = GraphGeometryUtils.vecSub;
  var vecScale = GraphGeometryUtils.vecScale;
  var orientFaceCCW = GraphGeometryUtils.orientFaceCCW;
  var outerFaceDiameter = GraphGeometryUtils.outerFaceDiameter;
  var triangleArea2 = GraphGeometryUtils.triangleArea2;
  var segmentsIntersectStrict = GraphGeometryUtils.segmentsIntersectStrict;
  var segmentsIntersectOrTouch = GraphGeometryUtils.segmentsIntersectOrTouch;

  function createEmptyAdjacency(nodeIds) {
    var adj = {};
    for (var i = 0; i < nodeIds.length; i += 1) {
      adj[nodeIds[i]] = [];
    }
    return adj;
  }

  function addUndirectedEdge(adjacency, source, target) {
    if (!adjacency[source]) {
      adjacency[source] = [];
    }
    if (!adjacency[target]) {
      adjacency[target] = [];
    }
    adjacency[source].push(target);
    adjacency[target].push(source);
  }

  function buildAdjacencyArrays(nodeIds, edgePairs) {
    // Use neighbor lists when callers want simple iteration order or indexable arrays.
    // The edge input is normalized first, so duplicate undirected edges are removed.
    var ids = normalizeNodeIds(nodeIds);
    var pairs = normalizeSimpleEdgePairs(edgePairs);
    var adjacency = createEmptyAdjacency(ids);
    for (var i = 0; i < pairs.length; i += 1) {
      addUndirectedEdge(adjacency, pairs[i][0], pairs[i][1]);
    }
    return adjacency;
  }

  function createEmptyAdjacencySets(nodeIds) {
    var adj = {};
    for (var i = 0; i < nodeIds.length; i += 1) {
      adj[String(nodeIds[i])] = new Set();
    }
    return adj;
  }

  function buildAdjacencySets(nodeIds, edgePairs) {
    // Use neighbor sets when callers care about uniqueness and set-style membership/mutation.
    var ids = normalizeNodeIds(nodeIds);
    var pairs = normalizeSimpleEdgePairs(edgePairs);
    var adj = createEmptyAdjacencySets(ids);
    for (var i = 0; i < pairs.length; i += 1) {
      var u = pairs[i][0];
      var v = pairs[i][1];
      if (!adj[u]) {
        adj[u] = new Set();
      }
      if (!adj[v]) {
        adj[v] = new Set();
      }
      adj[u].add(v);
      adj[v].add(u);
    }
    return adj;
  }

  function connectivityAfterRemoving(nodeIds, adjacency, removedSet) {
    var ids = nodeIds.map(String);
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

  function analyzeThreeConnectivity(nodeIds, edgePairs) {
    var ids = nodeIds.map(String);
    if (ids.length < 4) {
      return {
        ok: false,
        reason: 'Graph is not 3-connected: requires at least 4 vertices'
      };
    }

    var adj = buildAdjacencySets(ids, edgePairs);
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

  function analyzeInternallyThreeConnected(nodeIds, edgePairs, outerFace) {
    var ids = nodeIds.map(String);
    var outer = Array.isArray(outerFace) ? outerFace.slice().map(String) : [];
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
    var augmentedEdgePairs = cloneEdgePairs(edgePairs);
    var seenOuter = new Set();
    for (i = 0; i < outer.length; i += 1) {
      var v = outer[i];
      if (seenOuter.has(v)) {
        continue;
      }
      seenOuter.add(v);
      augmentedEdgePairs.push([hubId, v]);
    }

    var result = analyzeThreeConnectivity(augmentedNodeIds, augmentedEdgePairs);
    if (result.ok) {
      return result;
    }
    return {
      ok: false,
      reason: 'Graph is not internally 3-connected for the chosen outer face: ' + result.reason,
      witness: result.witness || null
    };
  }

  function isThreeConnected(nodeIds, edgePairs) {
    return analyzeThreeConnectivity(nodeIds, edgePairs).ok;
  }

  function isInternallyThreeConnected(nodeIds, edgePairs, outerFace) {
    return analyzeInternallyThreeConnected(nodeIds, edgePairs, outerFace).ok;
  }

  var sameCyclicDirection = PlanarGraphUtils.sameCyclicDirection;
  var sameCyclicEitherDirection = PlanarGraphUtils.sameCyclicEitherDirection;

  function findOuterFaceIndex(faces, outerFace) {
    if (!Array.isArray(faces) || !Array.isArray(outerFace) || outerFace.length === 0) {
      return -1;
    }
    for (var i = 0; i < faces.length; i += 1) {
      if (sameCyclicDirection(outerFace, faces[i])) {
        return i;
      }
    }
    for (i = 0; i < faces.length; i += 1) {
      if (sameCyclicEitherDirection(outerFace, faces[i])) {
        return i;
      }
    }
    return -1;
  }

  var embeddingHasFace = PlanarGraphUtils.embeddingHasFace;

  function chooseOuterFace(nodeIds, adjacency) {
      var edgePairs = [];
      var edgeSeen = {};

      for (var i = 0; i < nodeIds.length; i += 1) {
        var u = String(nodeIds[i]);
        var neighbors = adjacency[u] || [];
        for (var j = 0; j < neighbors.length; j += 1) {
          var v = String(neighbors[j]);
          var key = u < v ? u + '::' + v : v + '::' + u;
          if (edgeSeen[key]) {
            continue;
          }
          edgeSeen[key] = true;
          edgePairs.push([u, v]);
        }
      }

      if (arguments.length >= 3) {
        var selectedFromPositions = chooseOuterFaceFromPositions(nodeIds, edgePairs, arguments[2]);
        if (selectedFromPositions && selectedFromPositions.length >= 3) {
          return selectedFromPositions;
        }
      }

      var embedding = global.PlanarVibePlanarityTest.computePlanarEmbedding(nodeIds, edgePairs);
      if (embedding && embedding.ok && embedding.faces && embedding.faces.length > 0) {
        var selected = chooseOuterFaceFromEmbedding(embedding);
        if (selected && selected.length >= 3) {
          return selected;
        }
    }
    return null;
  }

  var extractEmbeddingFromPositions = PlanarGraphUtils.extractEmbeddingFromPositions;
  var chooseOuterFaceFromPositions = PlanarGraphUtils.chooseOuterFaceFromPositions;
  var chooseOuterFaceFromEmbedding = PlanarGraphUtils.chooseOuterFaceFromEmbedding;
  var isTriangulatedEmbedding = PlanarGraphUtils.isTriangulatedEmbedding;

  function cloneEdgePairs(edgePairs) {
    return edgePairs.map(function (e) {
      return [String(e[0]), String(e[1])];
    });
  }

  var computeDrawingDiameter = GraphGeometryUtils.computeDrawingDiameter;
  var copyPositionMap = GraphGeometryUtils.copyPositionMap;

  function filterPositionMap(posById, nodeIds) {
    var ids = normalizeNodeIds(nodeIds);
    var out = {};
    for (var i = 0; i < ids.length; i += 1) {
      var id = ids[i];
      var p = posById ? posById[id] : null;
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        continue;
      }
      out[id] = { x: p.x, y: p.y };
    }
    return out;
  }

  function collectMovableVertices(nodeIds, outerFace) {
    var outerSet = new Set((outerFace || []).map(String));
    var movable = [];
    for (var i = 0; i < (nodeIds || []).length; i += 1) {
      var id = String(nodeIds[i]);
      if (!outerSet.has(id)) {
        movable.push(id);
      }
    }
    return movable;
  }

  var computeFaceCentroid = GraphGeometryUtils.computeFaceCentroid;
  var rotatePositionMap = GraphGeometryUtils.rotatePositionMap;
  var alignOuterFaceEdgeHorizontally = GraphGeometryUtils.alignOuterFaceEdgeHorizontally;

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
    var pos = base.pos !== undefined ? base.pos : (base.posById !== undefined ? base.posById : null);
    var posById = base.posById !== undefined ? base.posById : pos;
    var iters = Number.isFinite(base.iters) ? base.iters : (Number.isFinite(base.iterations) ? base.iterations : null);
    var iterations = Number.isFinite(base.iterations) ? base.iterations : iters;
    var status = base.status !== undefined ? base.status : (base.stopReason !== undefined ? base.stopReason : null);
    var stopReason = base.stopReason !== undefined ? base.stopReason : (base.status !== undefined ? base.status : null);

    return Object.assign({}, base, {
      ok: base.ok !== false,
      pos: pos,
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
      pos: null,
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

  var hasPositionCrossings = GraphGeometryUtils.hasPositionCrossings;

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

  var augmentByFaceStellation = PlanarGraphUtils.augmentByFaceStellation;

  function removeDegreeThreeDummyVertices(nodeIds, edgePairs, dummyFaceVerticesById, outerFace) {
    var nodes = (nodeIds || []).map(String);
    var edges = cloneEdgePairs(edgePairs || []);
    var dummyMap = {};
    var dummyIds = Object.keys(dummyFaceVerticesById || {});
    var outerSet = new Set((outerFace || []).map(String));
    var i;

    for (i = 0; i < dummyIds.length; i += 1) {
      var dummyId = String(dummyIds[i]);
      dummyMap[dummyId] = (dummyFaceVerticesById[dummyId] || []).map(String);
    }

    var removedDummyIds = [];
    while (true) {
      var adjacency = buildAdjacencySets(nodes, edges);
      var removable = [];
      var currentDummyIds = Object.keys(dummyMap);
      for (i = 0; i < currentDummyIds.length; i += 1) {
        var currentDummyId = String(currentDummyIds[i]);
        if (outerSet.has(currentDummyId)) {
          continue;
        }
        if (!adjacency[currentDummyId]) {
          delete dummyMap[currentDummyId];
          continue;
        }
        if (adjacency[currentDummyId].size === 3) {
          removable.push(currentDummyId);
        }
      }
      if (removable.length === 0) {
        break;
      }

      var removeSet = new Set(removable);
      nodes = nodes.filter(function (id) {
        return !removeSet.has(String(id));
      });
      edges = edges.filter(function (edge) {
        return !removeSet.has(String(edge[0])) && !removeSet.has(String(edge[1]));
      });
      for (i = 0; i < removable.length; i += 1) {
        delete dummyMap[String(removable[i])];
        removedDummyIds.push(String(removable[i]));
      }
    }

    return {
      nodeIds: nodes,
      edgePairs: edges,
      dummyFaceVerticesById: dummyMap,
      dummyCount: Object.keys(dummyMap).length,
      removedDummyIds: removedDummyIds
    };
  }

  var triangulateByFaceStellation = PlanarGraphUtils.triangulateByFaceStellation;

  global.GraphUtils = {
    faceKey: faceKey,
    polygonArea2: polygonArea2,
    polygonAreaAbs: polygonAreaAbs,
    pointAdd: pointAdd,
    pointSub: pointSub,
    pointScale: pointScale,
    pointDot: pointDot,
    pointRot90: pointRot90,
    pointNorm: pointNorm,
    pointEquals: pointEquals,
    pointOnSegment: pointOnSegment,
    pointOnSegmentInterior: pointOnSegmentInterior,
    vecDot: vecDot,
    vecNorm: vecNorm,
    vecAddScaled: vecAddScaled,
    vecSub: vecSub,
    vecScale: vecScale,
    orientFaceCCW: orientFaceCCW,
    outerFaceDiameter: outerFaceDiameter,
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
    luFactorize: luFactorize,
    solveLUWithTwoRhs: solveLUWithTwoRhs,
    solveTransposeLUWithTwoRhs: solveTransposeLUWithTwoRhs,
    triangleArea2: triangleArea2,
    segmentsIntersectStrict: segmentsIntersectStrict,
    segmentsIntersectOrTouch: segmentsIntersectOrTouch,
    buildAdjacencyArrays: buildAdjacencyArrays,
    buildAdjacencySets: buildAdjacencySets,
    normalizeNodeIds: normalizeNodeIds,
    normalizeEdgePairs: normalizeEdgePairs,
    normalizeGraphInput: normalizeGraphInput,
    normalizeSimpleEdgePairs: normalizeSimpleEdgePairs,
    normalizeOuterFace: normalizeOuterFace,
    sameCyclicDirection: sameCyclicDirection,
    sameCyclicEitherDirection: sameCyclicEitherDirection,
    findOuterFaceIndex: findOuterFaceIndex,
    embeddingHasFace: embeddingHasFace,
    cloneEdgePairs: cloneEdgePairs,
    computeDrawingDiameter: computeDrawingDiameter,
    copyPositions: copyPositionMap,
    filterPositions: filterPositionMap,
    collectMovableVertices: collectMovableVertices,
    alignOuterFaceEdgeHorizontally: alignOuterFaceEdgeHorizontally,
    computeMoveStats: computeMoveStats,
    buildLayoutResult: buildLayoutResult,
    buildLayoutError: buildLayoutError,
    buildLayoutStatusMessage: buildLayoutStatusMessage,
    computePositionMoveStats: computePositionMoveStats,
    hasPositionCrossings: hasPositionCrossings,
    createMovementConvergenceTracker: createMovementConvergenceTracker,
    analyzeThreeConnectivity: analyzeThreeConnectivity,
    analyzeInternallyThreeConnected: analyzeInternallyThreeConnected,
    isThreeConnected: isThreeConnected,
    isInternallyThreeConnected: isInternallyThreeConnected,
    isTriangulatedEmbedding: isTriangulatedEmbedding,
    augmentByFaceStellation: augmentByFaceStellation,
    triangulateByFaceStellation: triangulateByFaceStellation,
    chooseOuterFace: chooseOuterFace,
    extractEmbeddingFromPositions: extractEmbeddingFromPositions,
    chooseOuterFaceFromPositions: chooseOuterFaceFromPositions,
    chooseOuterFaceFromEmbedding: chooseOuterFaceFromEmbedding
  };
})(window);
