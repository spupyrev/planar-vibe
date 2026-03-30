(function (global) {
  'use strict';

  function normalizeNodeIds(nodeIds) {
    return (nodeIds || []).map(String);
  }

  function normalizeEdgePairs(edgePairs) {
    return (edgePairs || []).map(function (edge) {
      return [String(edge[0]), String(edge[1])];
    });
  }

  function normalizeOuterFace(outerFace) {
    return Array.isArray(outerFace) ? outerFace.slice().map(String) : [];
  }

  function edgeKey(u, v) {
    return u < v ? u + '::' + v : v + '::' + u;
  }

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

  function buildAdjacency(nodeIds, edgePairs) {
    var ids = normalizeNodeIds(nodeIds);
    var pairs = normalizeEdgePairs(edgePairs);
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

  function buildSimpleAdjacencySets(nodeIds, edgePairs) {
    var ids = nodeIds.map(String);
    var adj = createEmptyAdjacencySets(ids);
    for (var i = 0; i < edgePairs.length; i += 1) {
      var e = edgePairs[i];
      if (!e || e.length < 2) {
        continue;
      }
      var u = String(e[0]);
      var v = String(e[1]);
      if (u === v || !adj[u] || !adj[v]) {
        continue;
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

    var adj = buildSimpleAdjacencySets(ids, edgePairs);
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

  function buildCycle(parent, fromId, toId) {
    var cycle = [toId];
    var cur = fromId;

    while (cur !== undefined && cur !== toId) {
      cycle.push(cur);
      cur = parent[cur];
    }

    if (cur !== toId || cycle.length < 3) {
      return null;
    }
    return cycle;
  }

  function detectCycleFromAdjacency(nodeIds, adjacency) {
    var visited = {};
    var inPath = {};
    var parent = {};

    function dfs(u, p) {
      visited[u] = true;
      inPath[u] = true;
      var neighbors = adjacency[u] || [];

      for (var i = 0; i < neighbors.length; i += 1) {
        var v = neighbors[i];
        if (v === p) {
          continue;
        }

        if (!visited[v]) {
          parent[v] = u;
          var found = dfs(v, u);
          if (found) {
            return found;
          }
        } else if (inPath[v]) {
          var cycle = buildCycle(parent, u, v);
          if (cycle) {
            return cycle;
          }
        }
      }

      inPath[u] = false;
      return null;
    }

    for (var j = 0; j < nodeIds.length; j += 1) {
      var id = nodeIds[j];
      if (!visited[id]) {
        parent[id] = undefined;
        var c = dfs(id, undefined);
        if (c) {
          return c;
        }
      }
    }
    return null;
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

  function sameCyclicDirection(a, b) {
    if (!a || !b || a.length !== b.length || a.length === 0) return false;
    var arrA = a.map(String);
    var arrB = b.map(String);
    var n = arrA.length;
    var start = -1;
    for (var i = 0; i < n; i += 1) {
      if (arrB[i] === arrA[0]) {
        start = i;
        break;
      }
    }
    if (start < 0) return false;
    for (i = 0; i < n; i += 1) {
      if (arrA[i] !== arrB[(start + i) % n]) {
        return false;
      }
    }
    return true;
  }

  function sameCyclicEitherDirection(a, b) {
    if (sameCyclicDirection(a, b)) return true;
    if (!a || !b || a.length !== b.length) return false;
    return sameCyclicDirection(a, b.slice().reverse());
  }

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

  function embeddingHasFace(embedding, face) {
    var faces = embedding && Array.isArray(embedding.faces) ? embedding.faces : [];
    for (var i = 0; i < faces.length; i += 1) {
      if (sameCyclicEitherDirection(face, faces[i])) {
        return true;
      }
    }
    return false;
  }

  function outerFaceEdgeKey(u, v) {
    return String(u) < String(v) ? String(u) + '::' + String(v) : String(v) + '::' + String(u);
  }

  function buildOuterFaceEdgeSet(edgePairs) {
    var out = {};
    if (!Array.isArray(edgePairs)) return out;
    for (var i = 0; i < edgePairs.length; i += 1) {
      var e = edgePairs[i];
      if (!e || e.length < 2) continue;
      out[outerFaceEdgeKey(e[0], e[1])] = true;
    }
    return out;
  }

  function faceChordCount(face, edgeSet) {
    if (!Array.isArray(face) || face.length < 4) return 0;
    var count = 0;
    for (var i = 0; i < face.length; i += 1) {
      for (var j = i + 1; j < face.length; j += 1) {
        var isBoundaryEdge = (j === i + 1) || (i === 0 && j === face.length - 1);
        if (isBoundaryEdge) continue;
        if (edgeSet[outerFaceEdgeKey(face[i], face[j])]) {
          count += 1;
        }
      }
    }
    return count;
  }

  function chooseOuterFace(nodeIds, adjacency) {
    if (global.PlanarVibePlanarityTest && global.PlanarVibePlanarityTest.computePlanarEmbedding) {
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

      var embedding = global.PlanarVibePlanarityTest.computePlanarEmbedding(nodeIds, edgePairs);
      if (embedding && embedding.ok && embedding.faces && embedding.faces.length > 0) {
        var selected = chooseOuterFaceFromEmbedding(embedding);
        if (selected && selected.length >= 3) {
          return selected;
        }
      }
    }
    return null;
  }

  function chooseOuterFaceFromEmbedding(embedding) {
    if (!embedding) {
      return null;
    }
    var explicit = Array.isArray(embedding.outerFace) && embedding.outerFace.length >= 3
      ? embedding.outerFace.slice().map(String)
      : null;
    var edgeSet = buildOuterFaceEdgeSet(embedding.edges);
    if (explicit && (!Array.isArray(embedding.edges) || faceChordCount(explicit, edgeSet) === 0)) {
      return explicit;
    }
    if (Array.isArray(embedding.faces) && embedding.faces.length > 0) {
      var best = null;
      for (var i = 0; i < embedding.faces.length; i += 1) {
        var face = embedding.faces[i];
        if (!Array.isArray(face) || face.length < 3) continue;
        var mapped = face.slice().map(String);
        if (faceChordCount(mapped, edgeSet) !== 0) continue;
        if (!best || mapped.length > best.length) best = mapped;
      }
      return best;
    }
    return null;
  }

  function canonicalUndirectedEdgeKey(u, v) {
    return String(u) < String(v) ? String(u) + '::' + String(v) : String(v) + '::' + String(u);
  }

  function isTriangulatedEmbedding(embedding) {
    if (!embedding || !embedding.ok) {
      return false;
    }
    var n = embedding.idByIndex.length;
    var m = embedding.edges.length;
    if (n < 3) {
      return false;
    }
    if (m !== 3 * n - 6) {
      return false;
    }
    for (var i = 0; i < embedding.faces.length; i += 1) {
      if (embedding.faces[i].length !== 3) {
        return false;
      }
    }
    return true;
  }

  function isTriangulatedEmbeddingExceptOuter(embedding, outerFace) {
    if (!embedding || !embedding.ok) {
      return false;
    }
    var outerIndex = findOuterFaceIndex(embedding.faces, outerFace);
    for (var i = 0; i < embedding.faces.length; i += 1) {
      var face = embedding.faces[i];
      if (!face || face.length < 3) {
        return false;
      }
      if (i === outerIndex) {
        continue;
      }
      if (face.length !== 3) {
        return false;
      }
    }
    return true;
  }

  function cloneEdgePairs(edgePairs) {
    return edgePairs.map(function (e) {
      return [String(e[0]), String(e[1])];
    });
  }

  function computeDrawingDiameter(nodeIds, posById) {
    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    for (var i = 0; i < nodeIds.length; i += 1) {
      var id = String(nodeIds[i]);
      var p = posById ? posById[id] : null;
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        continue;
      }
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return 1;
    }
    var dx = maxX - minX;
    var dy = maxY - minY;
    var d = Math.sqrt(dx * dx + dy * dy);
    return d > 1e-9 ? d : 1;
  }

  function copyPositionMap(posById) {
    var out = {};
    var keys = Object.keys(posById || {});
    for (var i = 0; i < keys.length; i += 1) {
      var id = keys[i];
      var p = posById[id];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        continue;
      }
      out[id] = { x: p.x, y: p.y };
    }
    return out;
  }

  function computeFaceCentroid(posById, face) {
    var ids = Array.isArray(face) ? face : [];
    var sx = 0;
    var sy = 0;
    var count = 0;
    for (var i = 0; i < ids.length; i += 1) {
      var p = posById[String(ids[i])];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        continue;
      }
      sx += p.x;
      sy += p.y;
      count += 1;
    }
    if (count < 1) {
      return { x: 0, y: 0 };
    }
    return { x: sx / count, y: sy / count };
  }

  function rotatePositionMap(posById, center, angle) {
    var out = {};
    var c = Math.cos(angle);
    var s = Math.sin(angle);
    var keys = Object.keys(posById || {});
    for (var i = 0; i < keys.length; i += 1) {
      var id = keys[i];
      var p = posById[id];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        continue;
      }
      var dx = p.x - center.x;
      var dy = p.y - center.y;
      out[id] = {
        x: center.x + c * dx - s * dy,
        y: center.y + s * dx + c * dy
      };
    }
    return out;
  }

  function alignOuterFaceEdgeHorizontally(posById, outerFace) {
    var face = Array.isArray(outerFace) ? outerFace.map(String) : [];
    if (face.length < 2) {
      return copyPositionMap(posById);
    }
    var bestIndex = -1;
    var bestLength2 = -1;
    for (var i = 0; i < face.length; i += 1) {
      var a = posById ? posById[face[i]] : null;
      var b = posById ? posById[face[(i + 1) % face.length]] : null;
      if (!a || !b || !Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(b.x) || !Number.isFinite(b.y)) {
        continue;
      }
      var dx = b.x - a.x;
      var dy = b.y - a.y;
      var len2 = dx * dx + dy * dy;
      if (len2 > bestLength2) {
        bestLength2 = len2;
        bestIndex = i;
      }
    }
    if (!(bestIndex >= 0) || !(bestLength2 > 1e-18)) {
      return copyPositionMap(posById);
    }
    var start = posById[face[bestIndex]];
    var end = posById[face[(bestIndex + 1) % face.length]];
    var angle = Math.atan2(end.y - start.y, end.x - start.x);
    return rotatePositionMap(posById, computeFaceCentroid(posById, face), -angle);
  }

  function computePositionMoveStats(nodeIds, prevPosById, nextPosById, options) {
    var opts = options || {};
    var moveTol = Number.isFinite(opts.moveTol) && opts.moveTol >= 0 ? opts.moveTol : 1e-9;
    var movedVertices = 0;
    var totalMove = 0;
    var maxMove = 0;
    for (var i = 0; i < nodeIds.length; i += 1) {
      var id = String(nodeIds[i]);
      var prev = prevPosById ? prevPosById[id] : null;
      var next = nextPosById ? nextPosById[id] : null;
      if (!prev || !next || !Number.isFinite(prev.x) || !Number.isFinite(prev.y) || !Number.isFinite(next.x) || !Number.isFinite(next.y)) {
        continue;
      }
      var dist = Math.hypot(next.x - prev.x, next.y - prev.y);
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
      avgMove: nodeIds.length > 0 ? (totalMove / nodeIds.length) : 0,
      maxMove: maxMove
    };
  }

  function createMovementConvergenceTracker(options) {
    var opts = options || {};
    var minItersBeforeStop = Number.isFinite(opts.minItersBeforeStop) ? Math.max(1, Math.floor(opts.minItersBeforeStop)) : 20;
    var stableIterLimit = Number.isFinite(opts.stableIterLimit) ? Math.max(1, Math.floor(opts.stableIterLimit)) : 5;
    var maxMoveTol = Number.isFinite(opts.maxMoveTol) && opts.maxMoveTol >= 0 ? opts.maxMoveTol : 1e-3;
    var avgMoveTol = Number.isFinite(opts.avgMoveTol) && opts.avgMoveTol >= 0 ? opts.avgMoveTol : maxMoveTol;
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

  function augmentByFaceStellation(nodeIds, edgePairs, embedding, outerFace, options) {
    var nodes = nodeIds.map(String);
    var edges = cloneEdgePairs(edgePairs);
    var edgeSet = new Set();
    var idSet = new Set(nodes);
    var dummyCount = 0;
    var dummyFaceVerticesById = {};
    var outerIndex = findOuterFaceIndex(embedding.faces, outerFace);
    var outerVertexSet = new Set((outerFace || []).map(String));
    var opts = options || {};
    var forceSingleDummyPerFace = !!opts.forceSingleDummyPerFace;

    for (var i = 0; i < edges.length; i += 1) {
      edgeSet.add(canonicalUndirectedEdgeKey(edges[i][0], edges[i][1]));
    }

    function nextDummyId() {
      var id;
      do {
        id = '@dummy' + dummyCount;
        dummyCount += 1;
      } while (idSet.has(id));
      idSet.add(id);
      return id;
    }

    function addEdge(u, v) {
      var key = canonicalUndirectedEdgeKey(u, v);
      if (edgeSet.has(key)) {
        return;
      }
      edgeSet.add(key);
      edges.push([u, v]);
    }

    function buildTriangleAvoidingBlocks(face) {
      var boundary = face.map(String);
      var n = boundary.length;
      if (n <= 3) {
        return [];
      }

      var blocks = [];
      var current = [boundary[0]];
      for (var step = 1; step < n; step += 1) {
        var candidate = boundary[step];
        var createsTriangle = false;
        for (var j = 0; j < current.length - 1; j += 1) {
          // The final boundary edge back to the starting vertex is part of the
          // intended one-dummy fan, not a premature separating triangle.
          if (j === 0 && current[0] === boundary[0] && candidate === boundary[n - 1]) {
            continue;
          }
          // Boundary shortcuts between two chosen outer-face vertices are not
          // treated as premature triangles for block splitting.
          if (outerVertexSet.has(current[j]) && outerVertexSet.has(candidate)) {
            continue;
          }
          if (edgeSet.has(canonicalUndirectedEdgeKey(current[j], candidate))) {
            createsTriangle = true;
            break;
          }
        }
        if (!createsTriangle) {
          current.push(candidate);
          continue;
        }
        if (current.length < 2) {
          return null;
        }
        blocks.push(current.slice());
        current = [current[current.length - 1], candidate];
      }

      if (current.length < 2) {
        return null;
      }
      blocks.push(current.slice());
      return blocks;
    }

    function augmentFaceWithPath(face) {
      var blocks = forceSingleDummyPerFace
        ? [face.slice().map(String)]
        : buildTriangleAvoidingBlocks(face);
      if (!Array.isArray(blocks) || blocks.length === 0) {
        return false;
      }

      var dummies = [];
      for (var bi = 0; bi < blocks.length; bi += 1) {
        var dummy = nextDummyId();
        dummies.push(dummy);
        nodes.push(dummy);
        dummyFaceVerticesById[dummy] = face.slice().map(String);
        var seenBoundary = new Set();
        for (var bj = 0; bj < blocks[bi].length; bj += 1) {
          var boundaryId = String(blocks[bi][bj]);
          if (seenBoundary.has(boundaryId)) {
            continue;
          }
          seenBoundary.add(boundaryId);
          addEdge(dummy, boundaryId);
        }
      }

      for (bi = 0; bi < dummies.length - 1; bi += 1) {
        addEdge(dummies[bi], dummies[bi + 1]);
      }

      if (dummies.length === 1) {
        return true;
      }

      // The greedy blocks triangulate the boundary chains but leave one cap
      // polygon [apex, d0, d1, ..., d{k-1}]. Triangulate it explicitly.
      var apex = String(blocks[0][0]);
      for (bi = 1; bi < dummies.length; bi += 1) {
        addEdge(apex, dummies[bi]);
      }

      return true;
    }

    for (i = 0; i < embedding.faces.length; i += 1) {
      var face = embedding.faces[i];
      if (!face || face.length <= 3) {
        continue;
      }
      if (i === outerIndex) {
        continue;
      }

      if (!augmentFaceWithPath(face)) {
        return {
          nodeIds: nodes,
          edgePairs: edges,
          dummyCount: 0,
          dummyFaceVerticesById: {},
          reason: 'Path augmentation failed for face ' + face.join(',')
        };
      }
    }

    return {
      nodeIds: nodes,
      edgePairs: edges,
      dummyCount: dummyCount,
      dummyFaceVerticesById: dummyFaceVerticesById
    };
  }

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

    function buildAdjacency() {
      var adjacency = {};
      var ni;
      for (ni = 0; ni < nodes.length; ni += 1) {
        adjacency[String(nodes[ni])] = new Set();
      }
      for (ni = 0; ni < edges.length; ni += 1) {
        var a = String(edges[ni][0]);
        var b = String(edges[ni][1]);
        if (!adjacency[a]) {
          adjacency[a] = new Set();
        }
        if (!adjacency[b]) {
          adjacency[b] = new Set();
        }
        adjacency[a].add(b);
        adjacency[b].add(a);
      }
      return adjacency;
    }

    var removedDummyIds = [];
    while (true) {
      var adjacency = buildAdjacency();
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

  function prepareTriangulatedByFaceStellation(nodeIds, edgePairs, embedding, outerFace, options) {
    if (!global.PlanarVibePlanarityTest || !global.PlanarVibePlanarityTest.computePlanarEmbedding) {
      return {
        ok: false,
        reason: 'Planarity utilities are missing'
      };
    }

    var nodes = nodeIds.map(String);
    var edges = cloneEdgePairs(edgePairs);
    var emb = embedding || global.PlanarVibePlanarityTest.computePlanarEmbedding(nodes, edges);
    if (!emb || !emb.ok) {
      return {
        ok: false,
        reason: 'Graph is not planar'
      };
    }
    var selectedOuterFace = Array.isArray(outerFace) ? outerFace.slice().map(String) : chooseOuterFaceFromEmbedding(emb);
    if (!selectedOuterFace || selectedOuterFace.length < 3) {
      return {
        ok: false,
        reason: 'Could not determine outer face'
      };
    }

    var dummyFaceVerticesById = {};
    var round = 0;
    var maxRounds = 1000;

    while (!isTriangulatedEmbeddingExceptOuter(emb, selectedOuterFace)) {
      if (round >= maxRounds) {
        return {
          ok: false,
          reason: 'Augmentation failed to triangulate all faces'
        };
      }

      var step = augmentByFaceStellation(nodes, edges, emb, selectedOuterFace, options);
      if (!step || !Array.isArray(step.nodeIds) || !Array.isArray(step.edgePairs)) {
        return {
          ok: false,
          reason: 'Augmentation failed: invalid augmentation result'
        };
      }
      if (!(step.dummyCount > 0)) {
        return {
          ok: false,
          reason: 'Augmentation failed to triangulate all non-outer faces'
        };
      }

      nodes = step.nodeIds.map(String);
      edges = cloneEdgePairs(step.edgePairs);
      var stepDummyFaceVerticesById = step.dummyFaceVerticesById || {};
      var dummyIds = Object.keys(stepDummyFaceVerticesById);
      for (var i = 0; i < dummyIds.length; i += 1) {
        var dummyId = String(dummyIds[i]);
        dummyFaceVerticesById[dummyId] = (stepDummyFaceVerticesById[dummyId] || []).map(String);
      }

      emb = global.PlanarVibePlanarityTest.computePlanarEmbedding(nodes, edges);
      if (!emb || !emb.ok) {
        return {
          ok: false,
          reason: 'Augmentation failed: resulting graph is not planar'
        };
      }
      emb.outerFace = selectedOuterFace.slice();
      round += 1;
    }

    var simplified = removeDegreeThreeDummyVertices(nodes, edges, dummyFaceVerticesById, selectedOuterFace);
    nodes = simplified.nodeIds.map(String);
    edges = cloneEdgePairs(simplified.edgePairs);
    dummyFaceVerticesById = simplified.dummyFaceVerticesById || {};

    emb = global.PlanarVibePlanarityTest.computePlanarEmbedding(nodes, edges);
    if (!emb || !emb.ok) {
      return {
        ok: false,
        reason: 'Augmentation simplification failed: resulting graph is not planar'
      };
    }
    if (!isTriangulatedEmbeddingExceptOuter(emb, selectedOuterFace)) {
      return {
        ok: false,
        reason: 'Augmentation simplification failed to preserve triangulation'
      };
    }
    emb.outerFace = selectedOuterFace.slice();
    return {
      ok: true,
      nodeIds: nodes,
      edgePairs: edges,
      dummyCount: Object.keys(dummyFaceVerticesById).length,
      dummyFaceVerticesById: dummyFaceVerticesById,
      embedding: emb
    };
  }

  function prepareFullyTriangulatedByFaceStellation(nodeIds, edgePairs, embedding, outerFace) {
    if (!global.PlanarVibePlanarityTest || !global.PlanarVibePlanarityTest.computePlanarEmbedding) {
      return {
        ok: false,
        reason: 'Planarity utilities are missing'
      };
    }

    var prepared = prepareTriangulatedByFaceStellation(nodeIds, edgePairs, embedding, outerFace);
    if (!prepared || !prepared.ok) {
      return prepared || {
        ok: false,
        reason: 'Augmentation failed'
      };
    }
    if (isTriangulatedEmbedding(prepared.embedding)) {
      return prepared;
    }

    var selectedOuterFace = Array.isArray(outerFace)
      ? outerFace.slice().map(String)
      : (prepared.embedding && prepared.embedding.outerFace ? prepared.embedding.outerFace.slice().map(String) : null);
    if (!selectedOuterFace || selectedOuterFace.length < 3) {
      return {
        ok: false,
        reason: 'Could not determine outer face'
      };
    }
    if (selectedOuterFace.length === 3) {
      return {
        ok: false,
        reason: 'Expected a fully triangulated embedding but outer face is still not triangular'
      };
    }

    var nodes = prepared.nodeIds.map(String);
    var edges = cloneEdgePairs(prepared.edgePairs);
    var idSet = new Set(nodes);
    var outerDummyId = '@outerDummy';
    var suffix = 0;
    while (idSet.has(outerDummyId)) {
      suffix += 1;
      outerDummyId = '@outerDummy' + suffix;
    }
    nodes.push(outerDummyId);
    for (var i = 0; i < selectedOuterFace.length; i += 1) {
      edges.push([outerDummyId, String(selectedOuterFace[i])]);
    }

    var emb = global.PlanarVibePlanarityTest.computePlanarEmbedding(nodes, edges);
    if (!emb || !emb.ok) {
      return {
        ok: false,
        reason: 'Full triangulation failed: resulting graph is not planar'
      };
    }
    if (!isTriangulatedEmbedding(emb)) {
      return {
        ok: false,
        reason: 'Full triangulation failed to triangulate all faces'
      };
    }
    emb.outerFace = [outerDummyId, selectedOuterFace[0], selectedOuterFace[1]];

    var dummyFaceVerticesById = {};
    var preparedDummyFaceVertices = prepared.dummyFaceVerticesById || {};
    var dummyIds = Object.keys(preparedDummyFaceVertices);
    for (i = 0; i < dummyIds.length; i += 1) {
      dummyFaceVerticesById[String(dummyIds[i])] = (preparedDummyFaceVertices[dummyIds[i]] || []).map(String);
    }
    dummyFaceVerticesById[outerDummyId] = selectedOuterFace.slice();

    return {
      ok: true,
      nodeIds: nodes,
      edgePairs: edges,
      dummyCount: (prepared.dummyCount || 0) + 1,
      dummyFaceVerticesById: dummyFaceVerticesById,
      outerDummyId: outerDummyId,
      embedding: emb
    };
  }

  function PlanarVertex(id, label) {
    this.id = String(id);
    this.label = label === undefined ? String(id) : String(label);
    this.edgeIdsClockwise = [];
    this.stNumber = -1;
  }

  PlanarVertex.prototype.degree = function () {
    return this.edgeIdsClockwise.length;
  };

  PlanarVertex.prototype.addEdge = function (edgeId) {
    this.edgeIdsClockwise.push(edgeId);
  };

  PlanarVertex.prototype.findEdgeIndex = function (edgeId) {
    for (var i = 0; i < this.edgeIdsClockwise.length; i += 1) {
      if (this.edgeIdsClockwise[i] === edgeId) {
        return i;
      }
    }
    return -1;
  };

  PlanarVertex.prototype.findEdgeAfter = function (edgeId) {
    var idx = this.findEdgeIndex(edgeId);
    if (idx === -1 || this.edgeIdsClockwise.length === 0) {
      return null;
    }
    return this.edgeIdsClockwise[(idx + 1) % this.edgeIdsClockwise.length];
  };

  PlanarVertex.prototype.findEdgeBefore = function (edgeId) {
    var idx = this.findEdgeIndex(edgeId);
    if (idx === -1 || this.edgeIdsClockwise.length === 0) {
      return null;
    }
    return this.edgeIdsClockwise[(idx - 1 + this.edgeIdsClockwise.length) % this.edgeIdsClockwise.length];
  };

  function PlanarEdge(id, sourceId, targetId, isGenerated) {
    this.id = String(id);
    this.sourceId = String(sourceId);
    this.targetId = String(targetId);
    this.isGenerated = !!isGenerated;
  }

  PlanarEdge.prototype.incident = function (vertexId) {
    var id = String(vertexId);
    return this.sourceId === id || this.targetId === id;
  };

  PlanarEdge.prototype.other = function (vertexId) {
    var id = String(vertexId);
    if (this.sourceId === id) {
      return this.targetId;
    }
    if (this.targetId === id) {
      return this.sourceId;
    }
    return null;
  };

  function PlanarFace(vertexIds, edgeIds) {
    this.vertexIds = (vertexIds || []).map(String);
    this.edgeIds = (edgeIds || []).map(String);
  }

  PlanarFace.prototype.empty = function () {
    return this.vertexIds.length === 0;
  };

  PlanarFace.prototype.length = function () {
    return this.vertexIds.length;
  };

  PlanarFace.prototype.containsVertex = function (vertexId) {
    return this.vertexIds.indexOf(String(vertexId)) !== -1;
  };

  PlanarFace.prototype.containsEdge = function (edgeId) {
    return this.edgeIds.indexOf(String(edgeId)) !== -1;
  };

  function PlanarGraph(nodeIds, adjacency) {
    this.nodeIds = nodeIds.slice();
    this.adjacency = adjacency;
    this.verticesById = {};
    this.edgesById = {};
    this.edgeIdByUndirectedKey = {};
    this.outerFace = null;
  }

  PlanarGraph.prototype.findCycle = function () {
    return detectCycleFromAdjacency(this.nodeIds, this.adjacency);
  };

  PlanarGraph.prototype.chooseOuterFace = function () {
    return chooseOuterFace(this.nodeIds, this.adjacency);
  };

  PlanarGraph.prototype.numberOfVertices = function () {
    return this.nodeIds.length;
  };

  PlanarGraph.prototype.numberOfEdges = function () {
    return Object.keys(this.edgesById).length;
  };

  PlanarGraph.prototype.getVertex = function (vertexId) {
    return this.verticesById[String(vertexId)] || null;
  };

  PlanarGraph.prototype.getEdge = function (edgeId) {
    return this.edgesById[String(edgeId)] || null;
  };

  PlanarGraph.prototype.getEdgeBetween = function (u, v) {
    var key = canonicalUndirectedEdgeKey(u, v);
    var edgeId = this.edgeIdByUndirectedKey[key];
    return edgeId ? this.edgesById[edgeId] : null;
  };

  function graphFromCy(cy) {
    var nodeIds = cy.nodes().map(function (node) {
      return String(node.id());
    });
    var adjacency = createEmptyAdjacency(nodeIds);
    var graph = new PlanarGraph(nodeIds, adjacency);

    cy.nodes().forEach(function (node) {
      var id = String(node.id());
      var label = node.data('label');
      graph.verticesById[id] = new PlanarVertex(id, label);
    });

    cy.edges().forEach(function (edge) {
      var s = String(edge.source().id());
      var t = String(edge.target().id());
      var edgeId = String(edge.id() || ('e:' + s + ':' + t + ':' + graph.numberOfEdges()));

      if (graph.edgesById[edgeId]) {
        return;
      }

      addUndirectedEdge(adjacency, s, t);
      graph.edgesById[edgeId] = new PlanarEdge(edgeId, s, t, false);
      graph.edgeIdByUndirectedKey[canonicalUndirectedEdgeKey(s, t)] = edgeId;

      if (graph.verticesById[s]) {
        graph.verticesById[s].addEdge(edgeId);
      }
      if (graph.verticesById[t]) {
        graph.verticesById[t].addEdge(edgeId);
      }
    });

    var outer = graph.chooseOuterFace();
    graph.outerFace = outer ? new PlanarFace(outer, []) : null;
    return graph;
  }

  global.PlanarGraphCore = {
    PlanarVertex: PlanarVertex,
    PlanarEdge: PlanarEdge,
    PlanarFace: PlanarFace,
    PlanarGraph: PlanarGraph,
    edgeKey: edgeKey,
    buildAdjacency: buildAdjacency,
    normalizeNodeIds: normalizeNodeIds,
    normalizeEdgePairs: normalizeEdgePairs,
    normalizeOuterFace: normalizeOuterFace,
    sameCyclicDirection: sameCyclicDirection,
    sameCyclicEitherDirection: sameCyclicEitherDirection,
    findOuterFaceIndex: findOuterFaceIndex,
    embeddingHasFace: embeddingHasFace,
    graphFromCy: graphFromCy,
    cloneEdgePairs: cloneEdgePairs,
    computeDrawingDiameter: computeDrawingDiameter,
    alignOuterFaceEdgeHorizontally: alignOuterFaceEdgeHorizontally,
    computePositionMoveStats: computePositionMoveStats,
    createMovementConvergenceTracker: createMovementConvergenceTracker,
    analyzeThreeConnectivity: analyzeThreeConnectivity,
    analyzeInternallyThreeConnected: analyzeInternallyThreeConnected,
    isThreeConnected: isThreeConnected,
    isInternallyThreeConnected: isInternallyThreeConnected,
    isTriangulatedEmbedding: isTriangulatedEmbedding,
    augmentByFaceStellation: augmentByFaceStellation,
    prepareTriangulatedByFaceStellation: prepareTriangulatedByFaceStellation,
    prepareFullyTriangulatedByFaceStellation: prepareFullyTriangulatedByFaceStellation,
    detectCycleFromAdjacency: detectCycleFromAdjacency,
    chooseOuterFace: chooseOuterFace,
    chooseOuterFaceFromEmbedding: chooseOuterFaceFromEmbedding
  };
})(window);
