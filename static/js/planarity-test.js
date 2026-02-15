(function (global) {
  'use strict';

  function edgeKey(u, v) {
    return String(u) + '|' + String(v);
  }

  function parseEdgeKey(key) {
    var parts = String(key).split('|');
    return [Number(parts[0]), Number(parts[1])];
  }

  function emptyInterval() {
    return { low: null, high: null };
  }

  function copyInterval(interval) {
    return { low: interval.low, high: interval.high };
  }

  function conflictPair() {
    return { left: emptyInterval(), right: emptyInterval() };
  }

  function topOfStack(stack) {
    return stack.length ? stack[stack.length - 1] : null;
  }

  function intervalEmpty(interval) {
    return interval.low === null && interval.high === null;
  }

  function intervalConflicting(interval, edge, state) {
    return !intervalEmpty(interval) && state.lowpt[interval.high] > state.lowpt[edge];
  }

  function conflictPairLowest(pair, state) {
    if (intervalEmpty(pair.left)) {
      return state.lowpt[pair.right.low];
    }
    if (intervalEmpty(pair.right)) {
      return state.lowpt[pair.left.low];
    }
    return Math.min(state.lowpt[pair.left.low], state.lowpt[pair.right.low]);
  }

  function hasDirectedEdge(state, u, v) {
    return state.directedEdgeSet.has(edgeKey(u, v));
  }

  function sortBySignedNesting(state, vertex) {
    state.orderedAdjs[vertex].sort(function (l, r) {
      return state.nestingDepth[edgeKey(vertex, l)] - state.nestingDepth[edgeKey(vertex, r)];
    });
  }

  function getSide(state, edge) {
    if (edge === null || edge === undefined) {
      return 1;
    }
    if (state.side[edge] === undefined) {
      state.side[edge] = 1;
    }
    return state.side[edge];
  }

  function addHalfEdgeFirst(rotation, v, w) {
    if (rotation[v].indexOf(w) === -1) {
      rotation[v].push(w);
    }
  }

  function addHalfEdge(rotation, v, w, opts) {
    if (rotation[v].indexOf(w) !== -1) {
      return;
    }

    var ref = null;
    var useCCW = false;
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'ccw')) {
      ref = opts.ccw;
      useCCW = true;
    } else if (opts && Object.prototype.hasOwnProperty.call(opts, 'cw')) {
      ref = opts.cw;
      useCCW = false;
    }

    if (rotation[v].length === 0 || ref === null || ref === undefined || ref < 0) {
      rotation[v].push(w);
      return;
    }

    var idx = rotation[v].indexOf(ref);
    if (idx === -1) {
      rotation[v].push(w);
      return;
    }

    if (useCCW) {
      rotation[v].splice(idx + 1, 0, w);
    } else {
      rotation[v].splice(idx, 0, w);
    }
  }

  function extractFacesFromRotation(rotation) {
    var seenHalfEdges = new Set();
    var faces = [];

    function hkey(u, v) {
      return edgeKey(u, v);
    }

    for (var u = 0; u < rotation.length; u += 1) {
      for (var i = 0; i < rotation[u].length; i += 1) {
        var v = rotation[u][i];
        var startKey = hkey(u, v);
        if (seenHalfEdges.has(startKey)) {
          continue;
        }

        var startU = u;
        var startV = v;
        var curU = startU;
        var curV = startV;
        var face = [];

        while (true) {
          var curKey = hkey(curU, curV);
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
          if (idx === -1) {
            face = [];
            break;
          }

          var prevIdx = (idx - 1 + adj.length) % adj.length;
          var nextV = adj[prevIdx];
          curU = curV;
          curV = nextV;

          if (curU === startU && curV === startV) {
            break;
          }
        }

        if (face.length > 0) {
          faces.push(face);
        }
      }
    }

    return faces;
  }

  function chooseOuterFaceFromFaces(faces) {
    if (!faces.length) {
      return null;
    }
    var best = faces[0];
    for (var i = 1; i < faces.length; i += 1) {
      if (faces[i].length > best.length) {
        best = faces[i];
      }
    }
    return best.slice();
  }

  function LRPlanarity(n, edges) {
    this.n = n;
    this.m = edges.length;
    this.edges = edges.slice();

    this.adjs = [];
    this.directedAdjs = [];
    this.directedEdgeSet = new Set();
    this.orderedAdjs = [];

    this.roots = [];
    this.height = [];
    this.parentEdge = [];
    this.nextIndex = [];

    this.lowpt = {};
    this.lowpt2 = {};
    this.nestingDepth = {};
    this.ref = {};
    this.side = {};
    this.stackBottom = {};
    this.lowptEdge = {};
    this.skipInit = {};

    this.S = [];

    this.rotation = [];
    this.faces = [];
  }

  LRPlanarity.prototype.initAdjacency = function () {
    this.adjs = Array(this.n);
    this.directedAdjs = Array(this.n);
    this.orderedAdjs = Array(this.n);
    for (var i = 0; i < this.n; i += 1) {
      this.adjs[i] = [];
      this.directedAdjs[i] = [];
      this.orderedAdjs[i] = [];
    }

    for (var j = 0; j < this.edges.length; j += 1) {
      var e = this.edges[j];
      var u = e[0];
      var v = e[1];
      this.adjs[u].push(v);
      this.adjs[v].push(u);
    }
  };

  LRPlanarity.prototype.orientEdge = function (u, v) {
    this.directedAdjs[u].push(v);
    this.directedEdgeSet.add(edgeKey(u, v));
  };

  LRPlanarity.prototype.clearSkipInitForCurrentAdj = function () {
    this.skipInit = {};
  };

  LRPlanarity.prototype.dfsOrientation = function (root) {
    var dfsStack = [root];
    this.nextIndex = Array(this.n).fill(0);
    this.clearSkipInitForCurrentAdj();

    while (dfsStack.length) {
      var v = dfsStack.pop();
      var parent = this.parentEdge[v];

      for (var i = this.nextIndex[v]; i < this.adjs[v].length; i += 1) {
        var w = this.adjs[v][i];
        var vw = edgeKey(v, w);

        if (!this.skipInit[vw]) {
          if (hasDirectedEdge(this, v, w) || hasDirectedEdge(this, w, v)) {
            this.nextIndex[v] += 1;
            continue;
          }

          this.orientEdge(v, w);
          this.lowpt[vw] = this.height[v];
          this.lowpt2[vw] = this.height[v];

          if (this.height[w] === -1) {
            this.parentEdge[w] = vw;
            this.height[w] = this.height[v] + 1;
            dfsStack.push(v);
            dfsStack.push(w);
            this.skipInit[vw] = true;
            break;
          } else {
            this.lowpt[vw] = this.height[w];
          }
        }

        this.nestingDepth[vw] = 2 * this.lowpt[vw];
        if (this.lowpt2[vw] < this.height[v]) {
          this.nestingDepth[vw] += 1;
        }

        if (parent !== null) {
          if (this.lowpt[vw] < this.lowpt[parent]) {
            this.lowpt2[parent] = Math.min(this.lowpt[parent], this.lowpt2[vw]);
            this.lowpt[parent] = this.lowpt[vw];
          } else if (this.lowpt[vw] > this.lowpt[parent]) {
            this.lowpt2[parent] = Math.min(this.lowpt2[parent], this.lowpt[vw]);
          } else {
            this.lowpt2[parent] = Math.min(this.lowpt2[parent], this.lowpt2[vw]);
          }
        }

        this.nextIndex[v] += 1;
      }
    }
  };

  LRPlanarity.prototype.addConstraints = function (ei, e) {
    var P = conflictPair();

    while (true) {
      var Q = this.S.pop();
      if (!intervalEmpty(Q.left)) {
        var temp = Q.left;
        Q.left = Q.right;
        Q.right = temp;
      }

      if (!intervalEmpty(Q.left)) {
        return false;
      }

      if (this.lowpt[Q.right.low] > this.lowpt[e]) {
        if (intervalEmpty(P.right)) {
          P.right = copyInterval(Q.right);
        } else {
          this.ref[P.right.low] = Q.right.high;
        }
        P.right.low = Q.right.low;
      } else {
        this.ref[Q.right.low] = this.lowptEdge[e];
      }

      if (topOfStack(this.S) === this.stackBottom[ei]) {
        break;
      }
    }

    while (true) {
      var top = topOfStack(this.S);
      if (!top || (!intervalConflicting(top.left, ei, this) && !intervalConflicting(top.right, ei, this))) {
        break;
      }

      Q = this.S.pop();
      if (intervalConflicting(Q.right, ei, this)) {
        temp = Q.left;
        Q.left = Q.right;
        Q.right = temp;
      }
      if (intervalConflicting(Q.right, ei, this)) {
        return false;
      }

      this.ref[P.right.low] = Q.right.high;
      if (Q.right.low !== null) {
        P.right.low = Q.right.low;
      }

      if (intervalEmpty(P.left)) {
        P.left = copyInterval(Q.left);
      } else {
        this.ref[P.left.low] = Q.left.high;
      }
      P.left.low = Q.left.low;
    }

    if (!intervalEmpty(P.left) || !intervalEmpty(P.right)) {
      this.S.push(P);
    }

    return true;
  };

  LRPlanarity.prototype.removeBackEdges = function (e) {
    var endpoints = parseEdgeKey(e);
    var u = endpoints[0];

    while (this.S.length && conflictPairLowest(topOfStack(this.S), this) === this.height[u]) {
      var popped = this.S.pop();
      if (popped.left.low !== null) {
        this.side[popped.left.low] = -1;
      }
    }

    if (this.S.length) {
      var P = this.S.pop();

      while (P.left.high !== null && parseEdgeKey(P.left.high)[1] === u) {
        P.left.high = this.ref[P.left.high] || null;
      }
      if (P.left.high === null && P.left.low !== null) {
        this.ref[P.left.low] = P.right.low;
        this.side[P.left.low] = -1;
        P.left.low = null;
      }

      while (P.right.high !== null && parseEdgeKey(P.right.high)[1] === u) {
        P.right.high = this.ref[P.right.high] || null;
      }
      if (P.right.high === null && P.right.low !== null) {
        this.ref[P.right.low] = P.left.low;
        this.side[P.right.low] = -1;
        P.right.low = null;
      }

      this.S.push(P);
    }

    if (this.lowpt[e] < this.height[u]) {
      var top = topOfStack(this.S);
      var hl = top ? top.left.high : null;
      var hr = top ? top.right.high : null;

      if (hl !== null && (hr === null || this.lowpt[hl] > this.lowpt[hr])) {
        this.ref[e] = hl;
      } else {
        this.ref[e] = hr;
      }
    }
  };

  LRPlanarity.prototype.dfsTesting = function (root) {
    var dfsStack = [root];
    this.nextIndex = Array(this.n).fill(0);
    this.clearSkipInitForCurrentAdj();

    while (dfsStack.length) {
      var v = dfsStack.pop();
      var e = this.parentEdge[v];
      var skipFinal = false;

      for (var i = this.nextIndex[v]; i < this.orderedAdjs[v].length; i += 1) {
        var w = this.orderedAdjs[v][i];
        var ei = edgeKey(v, w);

        if (!this.skipInit[ei]) {
          this.stackBottom[ei] = topOfStack(this.S);

          if (ei === this.parentEdge[w]) {
            dfsStack.push(v);
            dfsStack.push(w);
            this.skipInit[ei] = true;
            skipFinal = true;
            break;
          } else {
            this.lowptEdge[ei] = ei;
            this.S.push({ left: emptyInterval(), right: { low: ei, high: ei } });
          }
        }

        if (this.lowpt[ei] < this.height[v]) {
          if (w === this.orderedAdjs[v][0]) {
            this.lowptEdge[e] = this.lowptEdge[ei];
          } else if (!this.addConstraints(ei, e)) {
            return false;
          }
        }

        this.nextIndex[v] += 1;
      }

      if (!skipFinal && e !== null) {
        this.removeBackEdges(e);
      }
    }

    return true;
  };

  LRPlanarity.prototype.sign = function (startEdge) {
    var dfsStack = [startEdge];
    var oldRef = {};

    while (dfsStack.length) {
      var e = dfsStack.pop();
      if (this.ref[e] !== undefined && this.ref[e] !== null) {
        dfsStack.push(e);
        dfsStack.push(this.ref[e]);
        oldRef[e] = this.ref[e];
        this.ref[e] = null;
      } else {
        this.side[e] = getSide(this, e) * getSide(this, oldRef[e]);
      }
    }

    return this.side[startEdge];
  };

  LRPlanarity.prototype.dfsEmbedding = function (root) {
    var dfsStack = [root];
    var ind = Array(this.n).fill(0);
    var leftRef = Array(this.n).fill(-1);
    var rightRef = Array(this.n).fill(-1);

    while (dfsStack.length) {
      var v = dfsStack.pop();

      for (var i = ind[v]; i < this.orderedAdjs[v].length; i += 1) {
        var w = this.orderedAdjs[v][i];
        ind[v] += 1;
        var ei = edgeKey(v, w);

        if (ei === this.parentEdge[w]) {
          addHalfEdgeFirst(this.rotation, w, v);
          leftRef[v] = w;
          rightRef[v] = w;
          dfsStack.push(v);
          dfsStack.push(w);
          break;
        }

        if (getSide(this, ei) === 1) {
          addHalfEdge(this.rotation, w, v, { ccw: rightRef[w] });
        } else {
          addHalfEdge(this.rotation, w, v, { cw: leftRef[w] });
          leftRef[w] = v;
        }
      }
    }
  };

  LRPlanarity.prototype.buildEmbedding = function () {
    var v;
    var w;
    var e;

    for (v = 0; v < this.n; v += 1) {
      for (var i = 0; i < this.orderedAdjs[v].length; i += 1) {
        w = this.orderedAdjs[v][i];
        e = edgeKey(v, w);
        this.nestingDepth[e] = this.sign(e) * this.nestingDepth[e];
      }
    }

    for (v = 0; v < this.n; v += 1) {
      sortBySignedNesting(this, v);
    }

    this.rotation = Array(this.n);
    for (v = 0; v < this.n; v += 1) {
      this.rotation[v] = [];
      var prev = null;
      for (var j = 0; j < this.orderedAdjs[v].length; j += 1) {
        w = this.orderedAdjs[v][j];
        addHalfEdge(this.rotation, v, w, { ccw: prev });
        prev = w;
      }
    }

    for (var r = 0; r < this.roots.length; r += 1) {
      this.dfsEmbedding(this.roots[r]);
    }

    this.faces = extractFacesFromRotation(this.rotation);
  };

  LRPlanarity.prototype.run = function () {
    if (this.n > 2 && this.m > 3 * this.n - 6) {
      return { ok: false, reason: 'Euler bound violated' };
    }

    this.initAdjacency();
    this.height = Array(this.n).fill(-1);
    this.parentEdge = Array(this.n).fill(null);

    for (var v = 0; v < this.n; v += 1) {
      if (this.height[v] !== -1) {
        continue;
      }
      this.height[v] = 0;
      this.roots.push(v);
      this.dfsOrientation(v);
    }

    for (v = 0; v < this.n; v += 1) {
      this.orderedAdjs[v] = this.directedAdjs[v].slice();
      sortBySignedNesting(this, v);
    }

    for (var i = 0; i < this.roots.length; i += 1) {
      if (!this.dfsTesting(this.roots[i])) {
        return { ok: false, reason: 'LR constraints conflict' };
      }
    }

    this.buildEmbedding();
    return { ok: true };
  };

  function normalizeEdges(nodeIds, edgePairs) {
    var indexById = {};
    var idByIndex = [];
    var i;

    for (i = 0; i < nodeIds.length; i += 1) {
      var id = String(nodeIds[i]);
      if (indexById[id] !== undefined) {
        continue;
      }
      indexById[id] = idByIndex.length;
      idByIndex.push(id);
    }

    var edges = [];
    var seen = new Set();
    for (i = 0; i < edgePairs.length; i += 1) {
      var uId = String(edgePairs[i][0]);
      var vId = String(edgePairs[i][1]);
      if (uId === vId) {
        continue;
      }
      if (indexById[uId] === undefined) {
        indexById[uId] = idByIndex.length;
        idByIndex.push(uId);
      }
      if (indexById[vId] === undefined) {
        indexById[vId] = idByIndex.length;
        idByIndex.push(vId);
      }
      var u = indexById[uId];
      var v = indexById[vId];
      var a = Math.min(u, v);
      var b = Math.max(u, v);
      var key = edgeKey(a, b);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      edges.push([a, b]);
    }

    return {
      idByIndex: idByIndex,
      indexById: indexById,
      edges: edges
    };
  }

  function mapEmbeddingBack(ids, rotation, faces) {
    function mapFace(face) {
      var out = [];
      for (var i = 0; i < face.length; i += 1) {
        out.push(ids[face[i]]);
      }
      return out;
    }

    var mappedRotation = [];
    for (var v = 0; v < rotation.length; v += 1) {
      var row = [];
      for (var j = 0; j < rotation[v].length; j += 1) {
        row.push(ids[rotation[v][j]]);
      }
      mappedRotation.push(row);
    }

    var mappedFaces = [];
    for (var k = 0; k < faces.length; k += 1) {
      mappedFaces.push(mapFace(faces[k]));
    }

    return {
      rotation: mappedRotation,
      faces: mappedFaces,
      outerFace: chooseOuterFaceFromFaces(mappedFaces)
    };
  }

  function computePlanarEmbedding(nodeIds, edgePairs) {
    var normalized = normalizeEdges(nodeIds || [], edgePairs || []);
    var test = new LRPlanarity(normalized.idByIndex.length, normalized.edges);
    var run = test.run();

    if (!run.ok) {
      return {
        ok: false,
        reason: run.reason,
        idByIndex: normalized.idByIndex.slice(),
        indexById: Object.assign({}, normalized.indexById)
      };
    }

    var mapped = mapEmbeddingBack(normalized.idByIndex, test.rotation, test.faces);
    var mappedEdges = normalized.edges.map(function (e) {
      return [normalized.idByIndex[e[0]], normalized.idByIndex[e[1]]];
    });
    return {
      ok: true,
      idByIndex: normalized.idByIndex.slice(),
      indexById: Object.assign({}, normalized.indexById),
      edges: mappedEdges,
      rotation: mapped.rotation,
      faces: mapped.faces,
      outerFace: mapped.outerFace
    };
  }

  function collectFromCy(cy) {
    var nodeIds = [];
    var edgePairs = [];

    cy.nodes().forEach(function (node) {
      nodeIds.push(String(node.id()));
    });
    cy.edges().forEach(function (edge) {
      edgePairs.push([String(edge.source().id()), String(edge.target().id())]);
    });

    return { nodeIds: nodeIds, edgePairs: edgePairs };
  }

  function computePlanarEmbeddingFromCy(cy) {
    var graph = collectFromCy(cy);
    return computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
  }

  function computePlanarEmbeddingFromEdgeListText(text) {
    if (!global.PlanarVibePlugin || !global.PlanarVibePlugin.parseEdgeList) {
      throw new Error('PlanarVibePlugin.parseEdgeList is required to parse text.');
    }

    var parsed = global.PlanarVibePlugin.parseEdgeList(text);
    var nodeIds = [];
    var edgePairs = [];

    for (var i = 0; i < parsed.elements.length; i += 1) {
      var el = parsed.elements[i];
      if (!el || !el.data) {
        continue;
      }
      if (el.data.source !== undefined && el.data.target !== undefined) {
        edgePairs.push([String(el.data.source), String(el.data.target)]);
      } else if (el.data.id !== undefined) {
        nodeIds.push(String(el.data.id));
      }
    }

    return computePlanarEmbedding(nodeIds, edgePairs);
  }

  function buildFppInput(nodeIds, edgePairs) {
    var emb = computePlanarEmbedding(nodeIds, edgePairs);
    if (!emb.ok) {
      return emb;
    }

    var rotationById = {};
    for (var i = 0; i < emb.idByIndex.length; i += 1) {
      rotationById[emb.idByIndex[i]] = emb.rotation[i] ? emb.rotation[i].slice() : [];
    }

    return {
      ok: true,
      nodeIds: emb.idByIndex.slice(),
      edgePairs: emb.edges.map(function (e) { return e.slice(); }),
      rotationById: rotationById,
      rotation: emb.rotation.map(function (row) { return row.slice(); }),
      faces: emb.faces.map(function (f) { return f.slice(); }),
      outerFace: emb.outerFace ? emb.outerFace.slice() : null,
      indexById: Object.assign({}, emb.indexById)
    };
  }

  function analyzePlanar3Tree(nodeIds, edgePairs) {
    var emb = computePlanarEmbedding(nodeIds, edgePairs);
    if (!emb.ok) {
      return { ok: false, reason: 'Graph is not planar' };
    }

    var n = emb.idByIndex.length;
    if (n < 3) {
      return { ok: false, reason: 'Need at least 3 vertices' };
    }

    var outer = emb.outerFace;
    if (!outer || outer.length !== 3) {
      return { ok: false, reason: 'Outer face is not a triangle' };
    }

    var m = emb.edges.length;
    if (m !== 3 * n - 6) {
      return { ok: false, reason: 'Edge count does not match maximal planar graph' };
    }

    var adjacency = {};
    for (var i = 0; i < emb.idByIndex.length; i += 1) {
      adjacency[emb.idByIndex[i]] = new Set();
    }
    for (i = 0; i < emb.edges.length; i += 1) {
      var e = emb.edges[i];
      adjacency[e[0]].add(e[1]);
      adjacency[e[1]].add(e[0]);
    }

    var outerSet = new Set(outer);
    var uniqueOuterApexCount = 0;
    for (i = 0; i < emb.idByIndex.length; i += 1) {
      var v = emb.idByIndex[i];
      if (outerSet.has(v)) {
        continue;
      }
      if (adjacency[v].has(outer[0]) && adjacency[v].has(outer[1]) && adjacency[v].has(outer[2])) {
        uniqueOuterApexCount += 1;
      }
    }
    if (uniqueOuterApexCount !== 1) {
      return { ok: false, reason: 'Outer face does not have a unique adjacent internal vertex' };
    }

    function triangleNeighbors(list) {
      return adjacency[list[0]].has(list[1]) &&
        adjacency[list[0]].has(list[2]) &&
        adjacency[list[1]].has(list[2]);
    }

    var remaining = new Set(emb.idByIndex);
    var changed = true;
    var elimination = [];

    while (changed && remaining.size > 3) {
      changed = false;

      var ids = Array.from(remaining);
      for (var j = 0; j < ids.length; j += 1) {
        v = ids[j];
        if (outerSet.has(v)) {
          continue;
        }

        var remNeighbors = [];
        adjacency[v].forEach(function (u) {
          if (remaining.has(u)) {
            remNeighbors.push(u);
          }
        });

        if (remNeighbors.length !== 3 || !triangleNeighbors(remNeighbors)) {
          continue;
        }

        elimination.push({
          vertex: v,
          parents: remNeighbors.slice()
        });

        for (var k = 0; k < remNeighbors.length; k += 1) {
          adjacency[remNeighbors[k]].delete(v);
        }
        remaining.delete(v);
        changed = true;
        break;
      }
    }

    if (remaining.size !== 3) {
      return { ok: false, reason: 'Could not eliminate to outer triangle' };
    }

    var finalThree = Array.from(remaining);
    if (!outerSet.has(finalThree[0]) || !outerSet.has(finalThree[1]) || !outerSet.has(finalThree[2])) {
      return { ok: false, reason: 'Remaining triangle does not match outer face' };
    }

    if (!triangleNeighbors(finalThree)) {
      return { ok: false, reason: 'Final three vertices do not form a triangle' };
    }

    return {
      ok: true,
      embedding: emb,
      outerFace: outer.slice(),
      elimination: elimination,
      nodeIds: emb.idByIndex.slice(),
      edges: emb.edges.map(function (e) { return e.slice(); })
    };
  }

  function isPlanar3Tree(nodeIds, edgePairs) {
    return analyzePlanar3Tree(nodeIds, edgePairs).ok;
  }

  global.PlanarVibePlanarityTest = {
    computePlanarEmbedding: computePlanarEmbedding,
    computePlanarEmbeddingFromCy: computePlanarEmbeddingFromCy,
    computePlanarEmbeddingFromEdgeListText: computePlanarEmbeddingFromEdgeListText,
    buildFppInput: buildFppInput,
    analyzePlanar3Tree: analyzePlanar3Tree,
    isPlanar3Tree: isPlanar3Tree
  };
})(window);
