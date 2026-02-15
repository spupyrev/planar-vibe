(function (global) {
  'use strict';

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
        var longest = embedding.faces[0];
        for (var f = 1; f < embedding.faces.length; f += 1) {
          if (embedding.faces[f].length > longest.length) {
            longest = embedding.faces[f];
          }
        }
        if (longest.length >= 3) {
          return longest;
        }
      }
    }

    var cycle = detectCycleFromAdjacency(nodeIds, adjacency);
    if (cycle && cycle.length >= 3) {
      return cycle;
    }

    if (nodeIds.length >= 3) {
      return [nodeIds[0], nodeIds[1], nodeIds[2]];
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

  function cloneEdgePairs(edgePairs) {
    return edgePairs.map(function (e) {
      return [String(e[0]), String(e[1])];
    });
  }

  function augmentByFaceStellation(nodeIds, edgePairs, embedding) {
    var nodes = nodeIds.map(String);
    var edges = cloneEdgePairs(edgePairs);
    var edgeSet = new Set();
    var idSet = new Set(nodes);
    var dummyCount = 0;

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

    for (i = 0; i < embedding.faces.length; i += 1) {
      var face = embedding.faces[i];
      if (!face || face.length <= 3) {
        continue;
      }

      var dummy = nextDummyId();
      nodes.push(dummy);
      for (var j = 0; j < face.length; j += 1) {
        var u = String(face[j]);
        var key = canonicalUndirectedEdgeKey(dummy, u);
        if (edgeSet.has(key)) {
          continue;
        }
        edgeSet.add(key);
        edges.push([dummy, u]);
      }
    }

    return {
      nodeIds: nodes,
      edgePairs: edges,
      dummyCount: dummyCount
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
    graphFromCy: graphFromCy,
    cloneEdgePairs: cloneEdgePairs,
    isTriangulatedEmbedding: isTriangulatedEmbedding,
    augmentByFaceStellation: augmentByFaceStellation,
    detectCycleFromAdjacency: detectCycleFromAdjacency,
    chooseOuterFace: chooseOuterFace
  };
})(window);
