(function (global) {
  'use strict';

  function edgeKey(u, v) {
    var a = String(u);
    var b = String(v);
    return a < b ? a + '::' + b : b + '::' + a;
  }

  function cloneEdgePairs(edgePairs) {
    var out = [];
    for (var i = 0; i < (edgePairs || []).length; i += 1) {
      out.push([String(edgePairs[i][0]), String(edgePairs[i][1])]);
    }
    return out;
  }

  function normalizeNodeIds(nodeIds) {
    var seen = new Set();
    var out = [];
    for (var i = 0; i < (nodeIds || []).length; i += 1) {
      var id = String(nodeIds[i]);
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  function normalizeSimpleEdgePairs(edgePairs) {
    var seen = new Set();
    var out = [];
    for (var i = 0; i < (edgePairs || []).length; i += 1) {
      var a = String(edgePairs[i][0]);
      var b = String(edgePairs[i][1]);
      if (a === b) {
        continue;
      }
      var key = edgeKey(a, b);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push([a, b]);
    }
    return out;
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

  function polygonAreaAbs(face, posById) {
    var sum = 0;
    for (var i = 0; i < face.length; i += 1) {
      var a = posById[String(face[i])];
      var b = posById[String(face[(i + 1) % face.length])];
      if (!a || !b) {
        return 0;
      }
      sum += a.x * b.y - b.x * a.y;
    }
    return Math.abs(sum) / 2;
  }

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

  function findFaceIndex(faces, face) {
    for (var i = 0; i < (faces || []).length; i += 1) {
      if (sameCyclicDirection(faces[i], face)) {
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

  function PlanarEmbedding(data) {
    var opts = data || {};
    this.nodeIds = normalizeNodeIds(opts.nodeIds || []);
    this.edgePairs = normalizeSimpleEdgePairs(opts.edgePairs || []);
    this.indexById = {};
    this.rotationById = {};
    this.faces = [];
    this.outerFace = Array.isArray(opts.outerFace) ? opts.outerFace.slice().map(String) : null;

    for (var i = 0; i < this.nodeIds.length; i += 1) {
      this.indexById[this.nodeIds[i]] = i;
    }

    var sourceRotation = opts.rotationById || {};
    for (i = 0; i < this.nodeIds.length; i += 1) {
      var id = this.nodeIds[i];
      this.rotationById[id] = (sourceRotation[id] || []).slice().map(String);
    }

    this._edgeSet = new Set();
    for (i = 0; i < this.edgePairs.length; i += 1) {
      this._edgeSet.add(edgeKey(this.edgePairs[i][0], this.edgePairs[i][1]));
    }

    if (Array.isArray(opts.faces) && opts.faces.length > 0) {
      this.faces = opts.faces.map(function (face) {
        return face.slice().map(String);
      });
    } else {
      this.recomputeFaces();
    }
  }

  PlanarEmbedding.fromEmbeddingObject = function (nodeIds, edgePairs, embedding, outerFace) {
    var ids = normalizeNodeIds(nodeIds || (embedding && embedding.idByIndex) || []);
    var pairs = normalizeSimpleEdgePairs(edgePairs || (embedding && embedding.edges) || []);
    var rotationById = {};
    for (var i = 0; i < ids.length; i += 1) {
      var id = ids[i];
      var idx = embedding && embedding.indexById ? embedding.indexById[id] : i;
      var row = embedding && embedding.rotation ? embedding.rotation[idx] : [];
      rotationById[id] = (row || []).slice().map(String);
    }
    return new PlanarEmbedding({
      nodeIds: ids,
      edgePairs: pairs,
      rotationById: rotationById,
      faces: embedding && embedding.faces ? embedding.faces : null,
      outerFace: outerFace || (embedding && embedding.outerFace) || null
    });
  };

  PlanarEmbedding.fromDrawing = function (nodeIds, edgePairs, posById) {
    var ids = normalizeNodeIds(nodeIds || []);
    var pairs = normalizeSimpleEdgePairs(edgePairs || []);
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
    var key = edgeKey(u, v);
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

  PlanarEmbedding.prototype.toEmbeddingObject = function () {
    var rotation = [];
    for (var i = 0; i < this.nodeIds.length; i += 1) {
      rotation.push((this.rotationById[this.nodeIds[i]] || []).slice().map(String));
    }
    return {
      ok: true,
      idByIndex: this.nodeIds.slice().map(String),
      indexById: Object.assign({}, this.indexById),
      edges: cloneEdgePairs(this.edgePairs),
      rotation: rotation,
      faces: this.faces.map(function (face) { return face.slice().map(String); }),
      outerFace: this.outerFace ? this.outerFace.slice().map(String) : null
    };
  };

  PlanarEmbedding.prototype.toGraph = function () {
    return {
      nodeIds: this.nodeIds.slice().map(String),
      edgePairs: cloneEdgePairs(this.edgePairs)
    };
  };

  global.PlanarGraphUtils = {
    edgeKey: edgeKey,
    sameCyclicDirection: sameCyclicDirection,
    sameCyclicEitherDirection: sameCyclicEitherDirection,
    PlanarEmbedding: PlanarEmbedding
  };
})(window);
