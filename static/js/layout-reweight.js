(function (global) {
  'use strict';

  function edgeKey(u, v) {
    var a = String(u);
    var b = String(v);
    return a < b ? a + '::' + b : b + '::' + a;
  }

  function faceKey(face) {
    if (!face || face.length === 0) return '';
    var arr = face.map(String);
    var n = arr.length;
    var best = null;
    for (var i = 0; i < n; i += 1) {
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

  function polygonAreaAbs(face, posById) {
    if (!face || face.length < 3) return 0;
    var s = 0;
    for (var i = 0; i < face.length; i += 1) {
      var a = posById[String(face[i])];
      var b = posById[String(face[(i + 1) % face.length])];
      if (!a || !b) return 0;
      s += a.x * b.y - b.x * a.y;
    }
    return Math.abs(s) / 2;
  }

  function longestFace(faces) {
    if (!faces || faces.length === 0) return null;
    var best = faces[0];
    for (var i = 1; i < faces.length; i += 1) {
      if (faces[i].length > best.length) best = faces[i];
    }
    return best ? best.slice() : null;
  }

  function graphFromCy(cy) {
    var nodeIds = cy.nodes().map(function (n) { return String(n.id()); });
    var edgePairs = cy.edges().map(function (e) {
      return [String(e.source().id()), String(e.target().id())];
    });
    return { nodeIds: nodeIds, edgePairs: edgePairs };
  }

  function augmentExceptOuter(nodeIds, edgePairs, embedding, outerFace) {
    var nodes = nodeIds.slice().map(String);
    var edges = edgePairs.slice().map(function (e) { return [String(e[0]), String(e[1])]; });
    var idSet = new Set(nodes);
    var eSet = new Set();
    var outerK = faceKey(outerFace);
    var dummyCount = 0;

    for (var i = 0; i < edges.length; i += 1) {
      eSet.add(edgeKey(edges[i][0], edges[i][1]));
    }

    function nextDummy() {
      var id;
      do {
        id = '@rw_dummy' + dummyCount;
        dummyCount += 1;
      } while (idSet.has(id));
      idSet.add(id);
      return id;
    }

    for (i = 0; i < embedding.faces.length; i += 1) {
      var face = embedding.faces[i];
      if (!face || face.length <= 3) continue;
      if (faceKey(face) === outerK) continue;
      var d = nextDummy();
      nodes.push(d);
      for (var j = 0; j < face.length; j += 1) {
        var u = String(face[j]);
        var k = edgeKey(d, u);
        if (eSet.has(k)) continue;
        eSet.add(k);
        edges.push([d, u]);
      }
    }

    return { nodeIds: nodes, edgePairs: edges, dummyCount: dummyCount };
  }

  function buildAdjacency(nodeIds, edgePairs) {
    var adj = {};
    for (var i = 0; i < nodeIds.length; i += 1) adj[String(nodeIds[i])] = [];
    for (i = 0; i < edgePairs.length; i += 1) {
      var u = String(edgePairs[i][0]);
      var v = String(edgePairs[i][1]);
      if (!adj[u]) adj[u] = [];
      if (!adj[v]) adj[v] = [];
      adj[u].push(v);
      adj[v].push(u);
    }
    return adj;
  }

  function currentPositionsFromCy(cy) {
    var pos = {};
    var nodes = cy.nodes().toArray();
    for (var i = 0; i < nodes.length; i += 1) {
      var id = String(nodes[i].id());
      var p = nodes[i].position();
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        pos[id] = { x: p.x, y: p.y };
      }
    }
    return pos;
  }

  function initOuterCoords(nodeIds, outerFace, seedPos, fixedOuterPos) {
    var pos = {};
    var i;
    for (i = 0; i < nodeIds.length; i += 1) {
      pos[String(nodeIds[i])] = { x: 0, y: 0 };
    }

    if (fixedOuterPos) {
      for (i = 0; i < outerFace.length; i += 1) {
        var fv = String(outerFace[i]);
        if (fixedOuterPos[fv] && Number.isFinite(fixedOuterPos[fv].x) && Number.isFinite(fixedOuterPos[fv].y)) {
          pos[fv] = { x: fixedOuterPos[fv].x, y: fixedOuterPos[fv].y };
        }
      }
      return pos;
    }

    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    var haveSeed = false;
    if (seedPos) {
      for (i = 0; i < nodeIds.length; i += 1) {
        var nid = String(nodeIds[i]);
        var sp = seedPos[nid];
        if (!sp || !Number.isFinite(sp.x) || !Number.isFinite(sp.y)) continue;
        haveSeed = true;
        if (sp.x < minX) minX = sp.x;
        if (sp.y < minY) minY = sp.y;
        if (sp.x > maxX) maxX = sp.x;
        if (sp.y > maxY) maxY = sp.y;
      }
    }

    var cx = haveSeed ? (minX + maxX) / 2 : 2000;
    var cy = haveSeed ? (minY + maxY) / 2 : 2000;
    var spanX = haveSeed ? (maxX - minX) : 1200;
    var spanY = haveSeed ? (maxY - minY) : 900;
    var spanMin = Math.max(1, Math.min(spanX, spanY));
    var R = Math.max(80, spanMin * 0.42);
    var gamma = 2 * Math.PI / outerFace.length;

    // Keep Tutte prerequisites: outer boundary must be convex.
    for (i = 0; i < outerFace.length; i += 1) {
      var v = String(outerFace[outerFace.length - i - 1]);
      pos[v] = {
        x: cx + R * Math.cos(gamma * (0.25 + i)),
        y: cy + R * Math.sin(gamma * (0.25 + i))
      };
    }
    return pos;
  }

  function barycentricLayoutWeighted(nodeIds, adj, outerFace, weights, maxIters, seedPos, fixedOuterPos) {
    var pos = initOuterCoords(nodeIds, outerFace, seedPos, fixedOuterPos);
    var outerSet = new Set(outerFace.map(String));
    var iters = 0;
    var converged = false;

    while (!converged && iters < maxIters) {
      converged = true;
      iters += 1;
      for (var i = 0; i < nodeIds.length; i += 1) {
        var v = String(nodeIds[i]);
        if (outerSet.has(v)) continue;
        var ngh = adj[v] || [];
        if (ngh.length === 0) continue;
        var sx = 0;
        var sy = 0;
        var sw = 0;
        for (var j = 0; j < ngh.length; j += 1) {
          var u = String(ngh[j]);
          var w = weights[edgeKey(v, u)];
          if (!Number.isFinite(w) || w <= 0) w = 1;
          sx += w * pos[u].x;
          sy += w * pos[u].y;
          sw += w;
        }
        if (!(sw > 0)) continue;
        var nx = sx / sw;
        var ny = sy / sw;
        if (Math.abs(pos[v].x - nx) > 1e-8 || Math.abs(pos[v].y - ny) > 1e-8) {
          pos[v] = { x: nx, y: ny };
          converged = false;
        }
      }
    }
    return { pos: pos, iters: iters };
  }

  function buildEdgeToFaceMap(faces) {
    var map = {};
    for (var i = 0; i < faces.length; i += 1) {
      var face = faces[i];
      for (var j = 0; j < face.length; j += 1) {
        var u = String(face[j]);
        var v = String(face[(j + 1) % face.length]);
        var k = edgeKey(u, v);
        if (!map[k]) map[k] = [];
        map[k].push(i);
      }
    }
    return map;
  }

  function adjustWeights(edgePairs, outerFace, faces, faceAreas, desired, oldWeights) {
    var outerSet = new Set((outerFace || []).map(String));
    var e2f = buildEdgeToFaceMap(faces);
    var newWeights = {};
    var sumW = 0;
    var cnt = 0;

    for (var i = 0; i < edgePairs.length; i += 1) {
      var u = String(edgePairs[i][0]);
      var v = String(edgePairs[i][1]);
      var k = edgeKey(u, v);
      var wOld = oldWeights[k];
      if (!Number.isFinite(wOld) || wOld <= 0) wOld = 1;

      if (outerSet.has(u) && outerSet.has(v)) {
        newWeights[k] = wOld;
        continue;
      }

      var facesIdx = e2f[k] || [];
      var areaSum = 0;
      var areaCnt = 0;
      for (var j = 0; j < facesIdx.length; j += 1) {
        var fi = facesIdx[j];
        var a = faceAreas[fi];
        if (Number.isFinite(a) && a > 0) {
          areaSum += a;
          areaCnt += 1;
        }
      }
      if (areaCnt === 0) {
        newWeights[k] = wOld;
        sumW += newWeights[k];
        cnt += 1;
        continue;
      }

      var penalty = (areaSum / areaCnt) / Math.max(desired, 1e-12);
      var scale = penalty > 1 ? Math.sqrt(penalty) : penalty;
      if (scale < 0.2) scale = 0.2;
      if (scale > 10.0) scale = 10.0;

      var wNew = wOld * scale;
      if (wNew < 1e-4) wNew = 1e-4;
      if (wNew > 1e4) wNew = 1e4;
      newWeights[k] = wNew;
      sumW += wNew;
      cnt += 1;
    }

    var avg = cnt > 0 ? (sumW / cnt) : 1;
    if (!(avg > 0)) avg = 1;
    for (i = 0; i < edgePairs.length; i += 1) {
      var ek = edgeKey(edgePairs[i][0], edgePairs[i][1]);
      newWeights[ek] = (newWeights[ek] || 1) / avg;
    }

    return newWeights;
  }

  function applyPositionsToCy(cy, posById) {
    var nodes = cy.nodes().toArray();
    for (var i = 0; i < nodes.length; i += 1) {
      var id = String(nodes[i].id());
      if (posById[id]) {
        nodes[i].position(posById[id]);
      }
    }
  }

  function waitForNextFrame(delayMs) {
    var delay = Math.max(0, Number(delayMs) || 0);
    return new Promise(function (resolve) {
      var schedule = (typeof global.setTimeout === 'function')
        ? global.setTimeout.bind(global)
        : (typeof setTimeout === 'function' ? setTimeout : null);
      if (!schedule) {
        resolve();
        return;
      }
      schedule(function () {
        var raf = (typeof global.requestAnimationFrame === 'function')
          ? global.requestAnimationFrame.bind(global)
          : (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null);
        if (raf) {
          raf(function () { resolve(); });
        } else {
          resolve();
        }
      }, delay);
    });
  }

  async function applyReweightTutteLayout(cy, options) {
    var opts = options || {};
    if (!global.PlanarVibePlanarityTest || !global.PlanarVibePlanarityTest.computePlanarEmbedding) {
      return { ok: false, message: 'Planarity utilities are missing' };
    }

    var g = graphFromCy(cy);
    if (g.nodeIds.length < 3) {
      return { ok: false, message: 'ReweightTutte requires at least 3 vertices' };
    }

    var emb = global.PlanarVibePlanarityTest.computePlanarEmbedding(g.nodeIds, g.edgePairs);
    if (!emb || !emb.ok) {
      return { ok: false, message: 'ReweightTutte requires a planar graph' };
    }

    var outer = longestFace(emb.faces);
    if (!outer || outer.length < 3) {
      return { ok: false, message: 'Could not determine outer face' };
    }

    var augmented = augmentExceptOuter(g.nodeIds, g.edgePairs, emb, outer);
    var embAug = global.PlanarVibePlanarityTest.computePlanarEmbedding(augmented.nodeIds, augmented.edgePairs);
    if (!embAug || !embAug.ok) {
      return { ok: false, message: 'Augmentation failed' };
    }

    var faces = embAug.faces || [];
    var outerKey = faceKey(outer);
    var boundedFaceIdx = [];
    for (var i = 0; i < faces.length; i += 1) {
      if (faceKey(faces[i]) !== outerKey) boundedFaceIdx.push(i);
    }
    if (boundedFaceIdx.length === 0) {
      return { ok: false, message: 'No bounded faces' };
    }

    var adj = buildAdjacency(augmented.nodeIds, augmented.edgePairs);
    var weights = {};
    for (i = 0; i < augmented.edgePairs.length; i += 1) {
      weights[edgeKey(augmented.edgePairs[i][0], augmented.edgePairs[i][1])] = 1;
    }

    var MAX_OUTER_ITERS = 8;
    var inner = null;
    var desired = 1 / boundedFaceIdx.length;
    var totalInnerIters = 0;
    var seedPos = currentPositionsFromCy(cy);
    var fixedOuterPos = null;

    var initPos = initOuterCoords(augmented.nodeIds, outer, seedPos, null);
    fixedOuterPos = {};
    for (var oi = 0; oi < outer.length; oi += 1) {
      var ov = String(outer[oi]);
      fixedOuterPos[ov] = { x: initPos[ov].x, y: initPos[ov].y };
    }

    var didFit = false;
    for (var iter = 0; iter < MAX_OUTER_ITERS; iter += 1) {
      inner = barycentricLayoutWeighted(augmented.nodeIds, adj, outer, weights, 3000, seedPos, fixedOuterPos);
      totalInnerIters += inner.iters;

      var pos = inner.pos;
      applyPositionsToCy(cy, pos);
      if (!didFit) {
        cy.fit(undefined, 24);
        didFit = true;
      }
      seedPos = pos;
      if (typeof opts.onIteration === 'function') {
        opts.onIteration({
          iter: iter + 1,
          maxIters: MAX_OUTER_ITERS,
          outerFace: outer.slice(),
          positions: pos
        });
      }
      await waitForNextFrame(90);

      var outerArea = polygonAreaAbs(outer, pos);
      if (!(outerArea > 1e-12)) outerArea = 1;
      var faceAreas = [];
      for (i = 0; i < faces.length; i += 1) {
        faceAreas[i] = polygonAreaAbs(faces[i], pos) / outerArea;
      }

      weights = adjustWeights(augmented.edgePairs, outer, faces, faceAreas, desired, weights);
    }

    var finalLayout = barycentricLayoutWeighted(augmented.nodeIds, adj, outer, weights, 3000, seedPos, fixedOuterPos);
    totalInnerIters += finalLayout.iters;
    var finalPos = finalLayout.pos;

    applyPositionsToCy(cy, finalPos);

    return {
      ok: true,
      message: 'Applied ReweightTutte (' + outer.length + '-vertex outer face, +' + augmented.dummyCount + ' dummy, ' + totalInnerIters + ' iters, ' + MAX_OUTER_ITERS + ' steps)'
    };
  }

  global.PlanarVibeReweightTutte = {
    applyReweightTutteLayout: applyReweightTutteLayout
  };
})(window);
