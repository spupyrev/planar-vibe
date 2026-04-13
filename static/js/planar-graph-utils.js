(function (global) {
  'use strict';

  // Planar embedding helpers and augmentation routines.

  var GeometryUtils = global.GeometryUtils;

  if (!GeometryUtils) {
    throw new Error('GeometryUtils must be loaded before PlanarGraphUtils');
  }

  function sameCyclicDirection(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) {
      return false;
    }
    var target = b.map(String);
    var source = a.map(String);
    for (var offset = 0; offset < source.length; offset += 1) {
      var ok = true;
      for (var i = 0; i < source.length; i += 1) {
        if (source[(offset + i) % source.length] !== target[i]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        return true;
      }
    }
    return false;
  }

  function sameCyclicEitherDirection(a, b) {
    if (sameCyclicDirection(a, b)) {
      return true;
    }
    return sameCyclicDirection(a, (b || []).slice().reverse());
  }

  var polygonAreaAbs = GeometryUtils.polygonAreaAbs;

  function extractFacesFromRotationMap(rotation) {
    var seenHalfEdges = new Set();
    var faces = [];

    function halfEdgeKey(u, v) {
      return String(u) + '|' + String(v);
    }

    var vertices = Object.keys(rotation || {});
    for (var i = 0; i < vertices.length; i += 1) {
      var u = String(vertices[i]);
      var row = rotation[u] || [];
      for (var j = 0; j < row.length; j += 1) {
        var v = String(row[j]);
        var startKey = halfEdgeKey(u, v);
        if (seenHalfEdges.has(startKey)) {
          continue;
        }

        var startU = u;
        var startV = v;
        var curU = startU;
        var curV = startV;
        var face = [];

        while (true) {
          var curKey = halfEdgeKey(curU, curV);
          if (seenHalfEdges.has(curKey)) {
            break;
          }
          seenHalfEdges.add(curKey);
          face.push(curU);

          var adj = rotation[curV];
          if (!adj || adj.length === 0) {
            face = [];
            break;
          }

          var idx = adj.indexOf(curU);
          if (idx < 0) {
            face = [];
            break;
          }

          var prevIdx = (idx - 1 + adj.length) % adj.length;
          var nextV = String(adj[prevIdx]);
          curU = curV;
          curV = nextV;

          if (curU === startU && curV === startV) {
            break;
          }
        }

        if (face.length >= 3) {
          faces.push(face);
        }
      }
    }

    return faces;
  }

  function buildRotationFromPositions(nodeIds, edgePairs, posById) {
    var adjacency = {};
    for (var i = 0; i < nodeIds.length; i += 1) {
      adjacency[String(nodeIds[i])] = [];
    }
    for (i = 0; i < edgePairs.length; i += 1) {
      var a = String(edgePairs[i][0]);
      var b = String(edgePairs[i][1]);
      if (!adjacency[a] || !adjacency[b]) {
        return null;
      }
      adjacency[a].push(b);
      adjacency[b].push(a);
    }

    var rotation = {};
    for (i = 0; i < nodeIds.length; i += 1) {
      var u = String(nodeIds[i]);
      var pu = posById[u];
      if (!pu || !Number.isFinite(pu.x) || !Number.isFinite(pu.y)) {
        return null;
      }
      var neighbors = (adjacency[u] || []).slice();
      neighbors.sort(function (a, b) {
        var pa = posById[a];
        var pb = posById[b];
        if (!pa || !pb) {
          return a < b ? -1 : (a > b ? 1 : 0);
        }
        var angleA = Math.atan2(pa.y - pu.y, pa.x - pu.x);
        var angleB = Math.atan2(pb.y - pu.y, pb.x - pu.x);
        if (Math.abs(angleA - angleB) > 1e-12) {
          return angleA - angleB;
        }
        var distA = (pa.x - pu.x) * (pa.x - pu.x) + (pa.y - pu.y) * (pa.y - pu.y);
        var distB = (pb.x - pu.x) * (pb.x - pu.x) + (pb.y - pu.y) * (pb.y - pu.y);
        if (Math.abs(distA - distB) > 1e-12) {
          return distA - distB;
        }
        return a < b ? -1 : (a > b ? 1 : 0);
      });
      rotation[u] = neighbors;
    }
    return rotation;
  }

  function findFaceIndex(faces, face, allowReverse) {
    for (var i = 0; i < (faces || []).length; i += 1) {
      if (sameCyclicDirection(faces[i], face)) {
        return i;
      }
      if (allowReverse && sameCyclicEitherDirection(faces[i], face)) {
        return i;
      }
    }
    return -1;
  }

  function largestAreaFace(faces, posById) {
    var best = null;
    var bestArea = -1;
    for (var i = 0; i < (faces || []).length; i += 1) {
      var face = faces[i];
      if (!face || face.length < 3) {
        continue;
      }
      var area = polygonAreaAbs(face, posById);
      if (area > bestArea + 1e-9) {
        bestArea = area;
        best = face.slice().map(String);
      } else if (Math.abs(area - bestArea) <= 1e-9 && best && face.length > best.length) {
        best = face.slice().map(String);
      }
    }
    return best;
  }

  function insertBefore(list, beforeValue, value) {
    var idx = list.indexOf(String(beforeValue));
    if (idx < 0) {
      throw new Error('Could not locate face wedge while updating rotation');
    }
    if (list.indexOf(String(value)) >= 0) {
      return;
    }
    list.splice(idx, 0, String(value));
  }

  function hasCompleteFinitePositions(nodeIds, posById) {
    if (!Array.isArray(nodeIds) || !posById) {
      return false;
    }
    for (var i = 0; i < nodeIds.length; i += 1) {
      var p = posById[String(nodeIds[i])];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        return false;
      }
    }
    return true;
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

  function buildOuterFaceEdgeSet(edgePairs) {
    var out = {};
    if (!Array.isArray(edgePairs)) return out;
    for (var i = 0; i < edgePairs.length; i += 1) {
      var e = edgePairs[i];
      if (!e || e.length < 2) continue;
      out[global.GraphUtils.edgeKey(e[0], e[1])] = true;
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
        if (edgeSet[global.GraphUtils.edgeKey(face[i], face[j])]) {
          count += 1;
        }
      }
    }
    return count;
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

  function extractEmbeddingFromPositions(nodeIds, edgePairs, posById) {
    if (!Array.isArray(nodeIds) || !Array.isArray(edgePairs) || !posById) {
      return null;
    }
    if (!hasCompleteFinitePositions(nodeIds, posById)) {
      return null;
    }
    if (GeometryUtils.hasPositionCrossings(posById, edgePairs)) {
      return null;
    }

    var embedding = PlanarEmbedding.fromDrawing({ nodeIds: nodeIds, edgePairs: edgePairs }, posById);
    return embedding ? embedding.toEmbeddingObject() : null;
  }

  function chooseOuterFaceFromPositions(nodeIds, edgePairs, posById) {
    var embedding = extractEmbeddingFromPositions(nodeIds, edgePairs, posById);
    return embedding && embedding.ok && embedding.outerFace ? embedding.outerFace.slice().map(String) : null;
  }

  function findOuterFaceIndex(faces, outerFace) {
    if (!Array.isArray(faces) || !Array.isArray(outerFace) || outerFace.length === 0) {
      return -1;
    }
    return findFaceIndex(faces, outerFace, true);
  }

  function triangulateFace(pe, face, options) {
    var opts = options || {};
    var matchedFace = pe.getFace(face);
    if (!matchedFace) {
      throw new Error('Face not found in embedding');
    }
    if (matchedFace.length < 3) {
      throw new Error('Cannot stellate a face with fewer than 3 vertices');
    }

    function createDummy(prefix) {
      var dummy = String(pe._nextDummyId(prefix));
      pe.indexById[dummy] = pe.nodeIds.length;
      pe.nodeIds.push(dummy);
      pe.rotationById[dummy] = [];
      return dummy;
    }

    function linkDummyToDummy(prevDummy, nextDummy) {
      if (!pe._addEdge(prevDummy, nextDummy)) {
        throw new Error('Dummy path introduced a duplicate edge');
      }
      pe.rotationById[prevDummy].push(nextDummy);
      pe.rotationById[nextDummy].push(prevDummy);
    }

    function linkDummyToBoundary(dummy, vertex, previousBoundary) {
      if (!pe._addEdge(dummy, vertex)) {
        throw new Error('Face triangulation still produced a multi-edge');
      }
      insertBefore(pe.rotationById[vertex], previousBoundary, dummy);
      pe.rotationById[dummy].push(vertex);
    }

    var prefix = opts.dummyPrefix || '@dummy';
    var firstDummyId = createDummy(prefix);
    var currentDummyId = firstDummyId;
    var currentSeen = new Set();
    var firstVertex = String(matchedFace[0]);
    var previousBoundary = String(matchedFace[matchedFace.length - 1]);
    var dummyCount = 1;

    for (var i = 0; i < matchedFace.length; i += 1) {
      var vertex = String(matchedFace[i]);
      if (currentSeen.has(vertex)) {
        var previousDummyId = currentDummyId;
        var nextDummyId = createDummy(prefix);
        linkDummyToDummy(previousDummyId, nextDummyId);
        currentDummyId = nextDummyId;
        currentSeen = new Set();
        linkDummyToBoundary(currentDummyId, previousBoundary, previousDummyId);
        currentSeen.add(previousBoundary);
        dummyCount += 1;
      }
      linkDummyToBoundary(currentDummyId, vertex, previousBoundary);
      currentSeen.add(vertex);
      previousBoundary = vertex;
    }

    if (!currentSeen.has(firstVertex)) {
      linkDummyToBoundary(currentDummyId, firstVertex, previousBoundary);
    }

    pe.recomputeFaces();

    if (opts.newOuterFace) {
      pe.setOuterFace([firstDummyId, matchedFace[0], matchedFace[1]]);
    }

    return dummyCount;
  }

  function triangulateInteriorFaces(pe, outerFace) {
    var dummyCount = 0;
    var faces = pe.faces.slice();
    for (var i = 0; i < faces.length; i += 1) {
      var face = faces[i];
      if (!face || face.length <= 3) {
        continue;
      }
      if (sameCyclicDirection(face, outerFace)) {
        continue;
      }
      try {
        dummyCount += triangulateFace(pe, face.slice().map(String));
      } catch (err) {
        return {
          ok: false,
          reason: err && err.message ? err.message : 'Interior face augmentation failed'
        };
      }
    }
    return {
      ok: true,
      dummyCount: dummyCount
    };
  }

  function triangulateOuterFaceIfRequested(pe, outerFace, options) {
    var opts = options || {};
    if (!opts.triangulateOuterFace || !outerFace || outerFace.length <= 3) {
      return {
        ok: true,
        dummyCount: 0
      };
    }
    try {
      var dummyCount = triangulateFace(pe, outerFace, {
        dummyPrefix: '@outerDummy',
        newOuterFace: true
      });
      return {
        ok: true,
        dummyCount: dummyCount
      };
    } catch (err) {
      return {
        ok: false,
        reason: err && err.message ? err.message : 'Outer-face augmentation failed'
      };
    }
  }

  function triangulateByFaceStellation(graph, embedding, outerFace, options) {
    var emb = embedding;
    if (!emb || !emb.ok) {
      return {
        ok: false,
        reason: 'triangulateByFaceStellation requires a planar embedding'
      };
    }
    var selectedOuterFace = Array.isArray(outerFace) ? outerFace.slice().map(String) : null;
    if (!selectedOuterFace || selectedOuterFace.length < 3) {
      return {
        ok: false,
        reason: 'triangulateByFaceStellation requires an outer face'
      };
    }
    var opts = options || {};
    var pe = PlanarEmbedding.fromEmbeddingObject(graph, emb, selectedOuterFace);
    var interior = triangulateInteriorFaces(pe, selectedOuterFace);
    if (!interior.ok) {
      return interior;
    }
    var outer = triangulateOuterFaceIfRequested(pe, selectedOuterFace, opts);
    if (!outer.ok) {
      return outer;
    }

    var finalEmbedding = pe.toEmbeddingObject();
    var finalGraph = pe.toGraph();
    return {
      ok: true,
      graph: finalGraph,
      dummyCount: interior.dummyCount + outer.dummyCount,
      embedding: finalEmbedding
    };
  }

  function triangulateByOuterCycle(graph, embedding, outerFace, options) {
    var emb = embedding;
    if (!emb || !emb.ok) {
      return {
        ok: false,
        reason: 'triangulateByOuterCycle requires a planar embedding'
      };
    }
    var selectedOuterFace = Array.isArray(outerFace) ? outerFace.slice().map(String) : null;
    if (!selectedOuterFace || selectedOuterFace.length < 3) {
      return {
        ok: false,
        reason: 'triangulateByOuterCycle requires an outer face'
      };
    }

    var pe = PlanarEmbedding.fromEmbeddingObject(graph, emb, selectedOuterFace);
    var opts = options || {};
    var dummyCount = 0;
    var outerDummyIds;

    try {
      outerDummyIds = pe.addOuterFaceCycle(selectedOuterFace, opts);
    } catch (err) {
      return {
        ok: false,
        reason: err && err.message ? err.message : 'Outer-cycle augmentation failed'
      };
    }
    dummyCount += outerDummyIds.length;

    selectedOuterFace = pe.outerFace ? pe.outerFace.slice().map(String) : selectedOuterFace;
    var interior = triangulateInteriorFaces(pe, selectedOuterFace);
    if (!interior.ok) {
      return interior;
    }
    dummyCount += interior.dummyCount;

    var outer = triangulateOuterFaceIfRequested(pe, selectedOuterFace, opts);
    if (!outer.ok) {
      return outer;
    }
    dummyCount += outer.dummyCount;

    var finalEmbedding = pe.toEmbeddingObject();
    var finalGraph = pe.toGraph();
    return {
      ok: true,
      graph: finalGraph,
      dummyCount: dummyCount,
      embedding: finalEmbedding
    };
  }

  function PlanarEmbedding(options) {
    var opts = options || {};
    if (!Array.isArray(opts.nodeIds)) {
      throw new Error('PlanarEmbedding requires nodeIds array');
    }
    if (!Array.isArray(opts.edgePairs)) {
      throw new Error('PlanarEmbedding requires edgePairs array');
    }
    this.nodeIds = opts.nodeIds.slice();
    this.edgePairs = global.GraphUtils.cloneEdgePairs(opts.edgePairs);
    this.indexById = {};
    this.rotationById = {};
    this.faces = [];
    this.outerFace = Array.isArray(opts.outerFace) ? opts.outerFace.slice() : null;

    for (var i = 0; i < this.nodeIds.length; i += 1) {
      if (typeof this.nodeIds[i] !== 'string') {
        throw new Error('PlanarEmbedding node ids must be strings');
      }
      this.indexById[this.nodeIds[i]] = i;
    }

    var sourceRotation = opts.rotationById || {};
    for (i = 0; i < this.nodeIds.length; i += 1) {
      var id = this.nodeIds[i];
      this.rotationById[id] = Array.isArray(sourceRotation[id]) ? sourceRotation[id].slice() : [];
    }

    this._edgeSet = new Set();
    for (i = 0; i < this.edgePairs.length; i += 1) {
      this._edgeSet.add(global.GraphUtils.edgeKey(this.edgePairs[i][0], this.edgePairs[i][1]));
    }

    if (Array.isArray(opts.faces) && opts.faces.length > 0) {
      this.faces = opts.faces.map(function (face) {
        return face.slice();
      });
    } else {
      this.recomputeFaces();
    }
  }

  PlanarEmbedding.fromEmbeddingObject = function (graph, embedding, outerFace) {
    var ids = graph.nodeIds.slice();
    var pairs = global.GraphUtils.cloneEdgePairs(graph.edgePairs);
    var rotationById = {};
    for (var i = 0; i < ids.length; i += 1) {
      var id = ids[i];
      var idx = embedding && embedding.indexById ? embedding.indexById[id] : i;
      var row = embedding && embedding.rotation ? embedding.rotation[idx] : [];
      rotationById[id] = Array.isArray(row) ? row.slice() : [];
    }
    return new PlanarEmbedding({
      nodeIds: ids,
      edgePairs: pairs,
      rotationById: rotationById,
      faces: embedding && embedding.faces ? embedding.faces : null,
      outerFace: outerFace || (embedding && embedding.outerFace) || null
    });
  };

  PlanarEmbedding.fromDrawing = function (graph, posById) {
    var ids = graph.nodeIds.slice();
    var pairs = global.GraphUtils.cloneEdgePairs(graph.edgePairs);
    var rotationById = buildRotationFromPositions(ids, pairs, posById || {});
    if (!rotationById) {
      return null;
    }
    var faces = extractFacesFromRotationMap(rotationById);
    if (!faces || faces.length === 0) {
      return null;
    }
    return new PlanarEmbedding({
      nodeIds: ids,
      edgePairs: pairs,
      rotationById: rotationById,
      faces: faces,
      outerFace: largestAreaFace(faces, posById || {})
    });
  };

  PlanarEmbedding.prototype.clone = function () {
    return new PlanarEmbedding({
      nodeIds: this.nodeIds,
      edgePairs: this.edgePairs,
      rotationById: this.rotationById,
      faces: this.faces,
      outerFace: this.outerFace
    });
  };

  PlanarEmbedding.prototype.recomputeFaces = function () {
    this.faces = extractFacesFromRotationMap(this.rotationById).map(function (face) {
      return face.slice().map(String);
    });
    return this.faces;
  };

  PlanarEmbedding.prototype.hasFace = function (face) {
    return findFaceIndex(this.faces, face) >= 0;
  };

  PlanarEmbedding.prototype.getFace = function (face) {
    var idx = findFaceIndex(this.faces, face);
    return idx >= 0 ? this.faces[idx].slice().map(String) : null;
  };

  PlanarEmbedding.prototype._nextDummyId = function (prefix) {
    var base = String(prefix || '@dummy');
    var id = base;
    var suffix = 0;
    while (Object.prototype.hasOwnProperty.call(this.indexById, id)) {
      suffix += 1;
      id = base + suffix;
    }
    return id;
  };

  PlanarEmbedding.prototype._addEdge = function (u, v) {
    var key = global.GraphUtils.edgeKey(u, v);
    if (this._edgeSet.has(key)) {
      return false;
    }
    this._edgeSet.add(key);
    this.edgePairs.push([String(u), String(v)]);
    return true;
  };

  PlanarEmbedding.prototype.setOuterFace = function (face) {
    var matched = this.getFace(face);
    if (!matched) {
      throw new Error('Requested outer face is not present in the embedding');
    }
    this.outerFace = matched;
    return this.outerFace.slice().map(String);
  };

  PlanarEmbedding.prototype.addFaceDummy = function (face, dummyId, options) {
    var opts = options || {};
    var matchedFace = this.getFace(face);
    if (!matchedFace) {
      throw new Error('Face not found in embedding');
    }
    if (matchedFace.length < 3) {
      throw new Error('Cannot stellate a face with fewer than 3 vertices');
    }
    var seen = new Set();
    for (var i = 0; i < matchedFace.length; i += 1) {
      var boundaryId = String(matchedFace[i]);
      if (seen.has(boundaryId)) {
        throw new Error('Face stellation requires a simple boundary');
      }
      seen.add(boundaryId);
    }

    var isOuter = this.outerFace && sameCyclicDirection(this.outerFace, matchedFace);
    if (isOuter && !opts.newOuterFace) {
      throw new Error('Splitting the outer face requires a replacement outer face');
    }

    var dummy = String(dummyId || this._nextDummyId('@dummy'));
    if (Object.prototype.hasOwnProperty.call(this.indexById, dummy)) {
      throw new Error('Dummy vertex already exists: ' + dummy);
    }

    this.indexById[dummy] = this.nodeIds.length;
    this.nodeIds.push(dummy);
    this.rotationById[dummy] = matchedFace.slice().map(String);

    for (i = 0; i < matchedFace.length; i += 1) {
      var v = String(matchedFace[i]);
      var prev = String(matchedFace[(i - 1 + matchedFace.length) % matchedFace.length]);
      this._addEdge(dummy, v);
      insertBefore(this.rotationById[v], prev, dummy);
    }

    this.recomputeFaces();

    if (opts.newOuterFace) {
      this.setOuterFace(opts.newOuterFace);
    } else if (isOuter) {
      throw new Error('Outer face split did not define a replacement outer face');
    } else if (this.outerFace && !this.hasFace(this.outerFace)) {
      throw new Error('Existing outer face was not preserved');
    }

    return dummy;
  };

  PlanarEmbedding.prototype.addOuterFaceCycle = function (face, options) {
    var matchedFace = this.getFace(face);
    if (!matchedFace) {
      throw new Error('Outer face not found in embedding');
    }
    if (matchedFace.length < 3) {
      throw new Error('Outer-cycle augmentation requires at least 3 boundary vertices');
    }
    if (!this.outerFace || !sameCyclicDirection(this.outerFace, matchedFace)) {
      throw new Error('Outer-cycle augmentation requires the chosen outer face');
    }

    var opts = options || {};
    var dummyIds = [];
    var i;
    for (i = 0; i < matchedFace.length; i += 1) {
      var dummy = this._nextDummyId(opts.outerDummyPrefix || '@outerDummy');
      this.indexById[dummy] = this.nodeIds.length;
      this.nodeIds.push(dummy);
      this.rotationById[dummy] = [];
      dummyIds.push(dummy);
    }

    for (i = 0; i < matchedFace.length; i += 1) {
      var v = String(matchedFace[i]);
      var next = String(matchedFace[(i + 1) % matchedFace.length]);
      var prev = String(matchedFace[(i - 1 + matchedFace.length) % matchedFace.length]);
      var dummyCurrent = String(dummyIds[i]);
      var dummyPrev = String(dummyIds[(i - 1 + dummyIds.length) % dummyIds.length]);
      var dummyNext = String(dummyIds[(i + 1) % dummyIds.length]);

      this._addEdge(dummyCurrent, v);
      this._addEdge(dummyCurrent, next);
      this._addEdge(dummyCurrent, dummyNext);

      insertBefore(this.rotationById[v], prev, dummyCurrent);
      insertBefore(this.rotationById[v], prev, dummyPrev);

      this.rotationById[dummyCurrent] = [
        dummyPrev,
        v,
        next,
        dummyNext
      ];
    }

    this.recomputeFaces();
    this.setOuterFace(dummyIds);
    return dummyIds.slice().map(String);
  };

  PlanarEmbedding.prototype.toEmbeddingObject = function () {
    var rotation = [];
    for (var i = 0; i < this.nodeIds.length; i += 1) {
      rotation.push((this.rotationById[this.nodeIds[i]] || []).slice().map(String));
    }
    return {
      ok: true,
      idByIndex: this.nodeIds.slice().map(String),
      indexById: Object.assign({}, this.indexById),
      edges: global.GraphUtils.cloneEdgePairs(this.edgePairs),
      rotation: rotation,
      faces: this.faces.map(function (face) { return face.slice().map(String); }),
      outerFace: this.outerFace ? this.outerFace.slice().map(String) : null
    };
  };

  PlanarEmbedding.prototype.toGraph = function () {
    if (!global.GraphUtils || typeof global.GraphUtils.createGraph !== 'function') {
      throw new Error('GraphUtils must be loaded before PlanarEmbedding.toGraph');
    }
    return global.GraphUtils.createGraph(this.nodeIds, this.edgePairs);
  };

  global.PlanarGraphUtils = {
    sameCyclicDirection: sameCyclicDirection,
    sameCyclicEitherDirection: sameCyclicEitherDirection,
    findOuterFaceIndex: findOuterFaceIndex,
    embeddingHasFace: embeddingHasFace,
    extractEmbeddingFromPositions: extractEmbeddingFromPositions,
    chooseOuterFaceFromPositions: chooseOuterFaceFromPositions,
    chooseOuterFaceFromEmbedding: chooseOuterFaceFromEmbedding,
    triangulateByFaceStellation: triangulateByFaceStellation,
    triangulateByOuterCycle: triangulateByOuterCycle,
    PlanarEmbedding: PlanarEmbedding
  };
})(window);
