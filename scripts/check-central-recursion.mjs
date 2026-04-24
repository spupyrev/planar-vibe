import { benchmark, loadBrowserModules, parseEdgeListText } from './report-shared.mjs';

function canonicalEdgeKey(u, v) {
  u = String(u);
  v = String(v);
  return u < v ? `${u}::${v}` : `${v}::${u}`;
}

function sameCyclicDirection(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return false;
  const aa = a.map(String);
  const bb = b.map(String);
  const n = aa.length;
  for (let start = 0; start < n; start += 1) {
    if (bb[start] !== aa[0]) continue;
    let ok = true;
    for (let i = 0; i < n; i += 1) {
      if (aa[i] !== bb[(start + i) % n]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function sameCyclicEitherDirection(a, b) {
  return sameCyclicDirection(a, b) || sameCyclicDirection(a, b.slice().reverse());
}

function chooseOuterCorners(outerFace) {
  const n = outerFace.length;
  if (n < 3) return null;
  return [
    String(outerFace[0]),
    String(outerFace[Math.floor(n / 3)]),
    String(outerFace[Math.floor((2 * n) / 3)])
  ];
}

function listBoundaryCornerTriples(boundaryCycle) {
  const out = [];
  for (let i = 0; i < boundaryCycle.length; i += 1) {
    for (let j = i + 1; j < boundaryCycle.length; j += 1) {
      for (let k = j + 1; k < boundaryCycle.length; k += 1) {
        out.push([String(boundaryCycle[i]), String(boundaryCycle[j]), String(boundaryCycle[k])]);
      }
    }
  }
  out.sort((a, b) => {
    const spanA = (boundaryCycle.indexOf(a[1]) - boundaryCycle.indexOf(a[0])) +
      (boundaryCycle.indexOf(a[2]) - boundaryCycle.indexOf(a[1]));
    const spanB = (boundaryCycle.indexOf(b[1]) - boundaryCycle.indexOf(b[0])) +
      (boundaryCycle.indexOf(b[2]) - boundaryCycle.indexOf(b[1]));
    return spanA - spanB;
  });
  return out;
}

function buildAdjacency(nodeIds, edgePairs) {
  const adj = {};
  for (const id of nodeIds) adj[String(id)] = [];
  for (const [u0, v0] of edgePairs) {
    const u = String(u0);
    const v = String(v0);
    adj[u].push(v);
    adj[v].push(u);
  }
  return adj;
}

function faceSetKey(face) {
  return (face || []).map(String).slice().sort().join('::');
}

function augmentInsideFacesOnly(nodeIds, edgePairs, embedding, outerFace) {
  const nodes = nodeIds.map(String);
  const edges = edgePairs.map((e) => [String(e[0]), String(e[1])]);
  const edgeSet = new Set(edges.map((e) => canonicalEdgeKey(e[0], e[1])));
  const idSet = new Set(nodes);
  const outerKey = faceSetKey(outerFace);
  let dummyCount = 0;

  function nextDummyId() {
    let id;
    do {
      id = `@checkdummy${dummyCount}`;
      dummyCount += 1;
    } while (idSet.has(id));
    idSet.add(id);
    return id;
  }

  for (const face0 of embedding.faces || []) {
    const face = (face0 || []).map(String);
    if (face.length <= 3) continue;
    if (faceSetKey(face) === outerKey) continue;
    const dummy = nextDummyId();
    nodes.push(dummy);
    for (const u of face) {
      const key = canonicalEdgeKey(dummy, u);
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      edges.push([dummy, u]);
    }
  }

  return { nodeIds: nodes, edgePairs: edges, dummyCount };
}

function buildTriangulatedData(windowObj, nodeIds, edgePairs) {
  const baseEmbedding = windowObj.PlanarVibePlanarityTest.computePlanarEmbedding(nodeIds, edgePairs);
  if (!baseEmbedding || !baseEmbedding.ok) {
    return { ok: false, reason: 'not planar' };
  }

  const outerFace = (baseEmbedding.outerFace || []).map(String);
  const aug = augmentInsideFacesOnly(nodeIds, edgePairs, baseEmbedding, outerFace);
  const solveNodeIds = aug.nodeIds.map(String);
  const solveEdgePairs = aug.edgePairs.map((e) => [String(e[0]), String(e[1])]);
  const embedding = windowObj.PlanarVibePlanarityTest.computePlanarEmbedding(solveNodeIds, solveEdgePairs);
  if (!embedding || !embedding.ok) {
    return { ok: false, reason: 'triangulated embedding failed' };
  }

  let outerFaceIndex = -1;
  for (let i = 0; i < embedding.faces.length; i += 1) {
    if (sameCyclicEitherDirection(embedding.faces[i], outerFace)) {
      outerFaceIndex = i;
      break;
    }
  }

  const boundedFaceIds = [];
  for (let i = 0; i < embedding.faces.length; i += 1) {
    if (i !== outerFaceIndex) boundedFaceIds.push(i);
  }

  const edgeToBoundedFaces = {};
  for (const fi of boundedFaceIds) {
    const face = (embedding.faces[fi] || []).map(String);
    for (let i = 0; i < face.length; i += 1) {
      const u = face[i];
      const v = face[(i + 1) % face.length];
      const key = canonicalEdgeKey(u, v);
      if (!edgeToBoundedFaces[key]) edgeToBoundedFaces[key] = [];
      edgeToBoundedFaces[key].push(fi);
    }
  }

  return {
    ok: true,
    nodeIds: solveNodeIds,
    edgePairs: solveEdgePairs,
    embedding,
    outerFace,
    boundedFaceIds,
    edgeToBoundedFaces,
    adjacency: buildAdjacency(solveNodeIds, solveEdgePairs)
  };
}

function computeBoundaryCycleForFaceSet(data, faceIds) {
  const edgeCounts = {};
  for (const fi of faceIds) {
    const face = (data.embedding.faces[fi] || []).map(String);
    for (let i = 0; i < face.length; i += 1) {
      const u = face[i];
      const v = face[(i + 1) % face.length];
      const key = canonicalEdgeKey(u, v);
      edgeCounts[key] = (edgeCounts[key] || 0) + 1;
    }
  }

  const boundaryAdj = {};
  const boundaryEdges = [];
  for (const key of Object.keys(edgeCounts)) {
    if (edgeCounts[key] !== 1) continue;
    const [u, v] = key.split('::');
    if (!boundaryAdj[u]) boundaryAdj[u] = [];
    if (!boundaryAdj[v]) boundaryAdj[v] = [];
    boundaryAdj[u].push(v);
    boundaryAdj[v].push(u);
    boundaryEdges.push([u, v]);
  }
  if (boundaryEdges.length === 0) return null;

  const start = boundaryEdges[0][0];
  const cycle = [start];
  let prev = null;
  let cur = start;
  while (true) {
    const nexts = boundaryAdj[cur] || [];
    let next = null;
    for (const cand of nexts) {
      if (cand !== prev) {
        next = cand;
        break;
      }
    }
    if (!next) return null;
    if (next === start) break;
    cycle.push(next);
    prev = cur;
    cur = next;
    if (cycle.length > boundaryEdges.length + 2) return null;
  }
  return cycle;
}

function regionVertexSet(data, faceIds) {
  const out = new Set();
  for (const fi of faceIds) {
    const face = data.embedding.faces[fi] || [];
    for (const v of face) out.add(String(v));
  }
  return out;
}

function regionEdgeSet(data, faceIds, boundaryCycle) {
  const out = new Set();
  for (const fi of faceIds) {
    const face = (data.embedding.faces[fi] || []).map(String);
    for (let i = 0; i < face.length; i += 1) {
      out.add(canonicalEdgeKey(face[i], face[(i + 1) % face.length]));
    }
  }
  for (let i = 0; i < boundaryCycle.length; i += 1) {
    out.add(canonicalEdgeKey(boundaryCycle[i], boundaryCycle[(i + 1) % boundaryCycle.length]));
  }
  return out;
}

function buildRegionAdjacency(region) {
  const adj = {};
  for (const v of region.vertexSet) adj[v] = [];
  for (const key of region.edgeSet) {
    const [u, v] = key.split('::');
    if (region.vertexSet.has(u) && region.vertexSet.has(v)) {
      adj[u].push(v);
      adj[v].push(u);
    }
  }
  return adj;
}

function bfsDistances(adj, source, allowed) {
  const dist = {};
  const q = [source];
  dist[source] = 0;
  for (let head = 0; head < q.length; head += 1) {
    const u = q[head];
    for (const v of adj[u] || []) {
      if (allowed && !allowed.has(v)) continue;
      if (dist[v] !== undefined) continue;
      dist[v] = dist[u] + 1;
      q.push(v);
    }
  }
  return dist;
}

function* enumerateShortestPaths(adj, start, target, distToTarget, allowedInternal, blocked, forbiddenInternal) {
  function* dfs(u, path) {
    if (u === target) {
      yield path.slice();
      return;
    }
    const nexts = (adj[u] || []).filter((w) => {
      if (distToTarget[w] === undefined || distToTarget[u] === undefined) return false;
      if (distToTarget[w] !== distToTarget[u] - 1) return false;
      if (w !== target) {
        if (!allowedInternal.has(w)) return false;
        if (blocked.has(w)) return false;
        if (forbiddenInternal.has(w)) return false;
      }
      return true;
    });
    nexts.sort((a, b) => String(a).localeCompare(String(b)));
    for (const w of nexts) {
      path.push(w);
      yield* dfs(w, path);
      path.pop();
    }
  }
  yield* dfs(start, [start]);
}

function findDisjointShortestPaths(region, corners, candidate) {
  const [A, B, C] = corners.map(String);
  const adj = region.adj;

  const allowedInternal = new Set(region.vertexSet);
  for (const b of region.boundarySet) allowedInternal.delete(b);
  allowedInternal.add(candidate);

  const distA = bfsDistances(adj, A, region.vertexSet);
  const distB = bfsDistances(adj, B, region.vertexSet);
  const distC = bfsDistances(adj, C, region.vertexSet);
  if (distA[candidate] === undefined || distB[candidate] === undefined || distC[candidate] === undefined) {
    return null;
  }

  const targets = [
    { name: 'A', t: A, dist: distA },
    { name: 'B', t: B, dist: distB },
    { name: 'C', t: C, dist: distC }
  ];
  targets.sort((x, y) => x.dist[candidate] - y.dist[candidate] || String(x.t).localeCompare(String(y.t)));

  const forbiddenByTarget = new Map([
    [A, new Set([B, C])],
    [B, new Set([A, C])],
    [C, new Set([A, B])]
  ]);

  function backtrack(i, blocked, acc) {
    if (i === targets.length) return acc.slice();
    const item = targets[i];
    for (const path of enumerateShortestPaths(adj, candidate, item.t, item.dist, allowedInternal, blocked, forbiddenByTarget.get(item.t))) {
      const nextBlocked = new Set(blocked);
      for (let k = 1; k < path.length - 1; k += 1) {
        nextBlocked.add(String(path[k]));
      }
      acc.push(path.map(String));
      const out = backtrack(i + 1, nextBlocked, acc);
      if (out) return out;
      acc.pop();
    }
    return null;
  }

  const found = backtrack(0, new Set(), []);
  if (!found) return null;
  const byName = {};
  for (let i = 0; i < targets.length; i += 1) byName[targets[i].name] = found[i];
  return [byName.A, byName.B, byName.C];
}

function buildFaceComponents(data, regionFaceIds, selectedEdges) {
  const regionSet = new Set(regionFaceIds);
  const visited = new Set();
  const components = [];

  for (const start of regionFaceIds) {
    if (visited.has(start)) continue;
    const stack = [start];
    visited.add(start);
    const comp = [];
    while (stack.length > 0) {
      const cur = stack.pop();
      comp.push(cur);
      const face = data.embedding.faces[cur] || [];
      for (let i = 0; i < face.length; i += 1) {
        const u = String(face[i]);
        const v = String(face[(i + 1) % face.length]);
        const ekey = canonicalEdgeKey(u, v);
        if (selectedEdges.has(ekey)) continue;
        for (const next of data.edgeToBoundedFaces[ekey] || []) {
          if (next === cur || !regionSet.has(next) || visited.has(next)) continue;
          visited.add(next);
          stack.push(next);
        }
      }
    }
    components.push(comp);
  }

  return components;
}

function classifyChild(boundaryCycle, parentCorners, v) {
  const boundarySet = new Set(boundaryCycle.map(String));
  const present = parentCorners.filter((c) => boundarySet.has(String(c)));
  if (!boundarySet.has(String(v))) return null;
  if (present.length !== 2) return null;
  return [String(present[0]), String(present[1]), String(v)];
}

function computeCandidateTriple(region, corners, v) {
  const ds = corners.map((c) => bfsDistances(region.adj, String(c), region.vertexSet)[String(v)] ?? Infinity);
  ds.sort((a, b) => a - b);
  return ds;
}

function regionKey(region) {
  const faceKey = region.faceIds.slice().sort((a, b) => a - b).join(',');
  const cornerKey = region.corners.map(String).slice().sort().join('|');
  return `${faceKey}::${cornerKey}`;
}

function searchRegion(data, region, stats, memo) {
  stats.calls += 1;
  stats.maxDepth = Math.max(stats.maxDepth, region.depth);
  stats.maxBoundary = Math.max(stats.maxBoundary, region.boundaryCycle.length);

  const key = regionKey(region);
  if (memo.has(key)) return memo.get(key);

  const interior = Array.from(region.vertexSet).filter((v) => !region.boundarySet.has(v));
  if (interior.length === 0) {
    const ok = { ok: true };
    memo.set(key, ok);
    return ok;
  }

  const candidates = interior.slice().sort((u, v) => {
    const du = computeCandidateTriple(region, region.corners, u);
    const dv = computeCandidateTriple(region, region.corners, v);
    for (let i = 0; i < 3; i += 1) {
      if (du[i] !== dv[i]) return du[i] - dv[i];
    }
    return String(u).localeCompare(String(v));
  });

  for (const cand of candidates) {
    stats.candidatesTried += 1;
    const paths = findDisjointShortestPaths(region, region.corners, String(cand));
    if (!paths) continue;

    const selectedEdges = new Set();
    for (const path of paths) {
      for (let i = 0; i + 1 < path.length; i += 1) {
        selectedEdges.add(canonicalEdgeKey(path[i], path[i + 1]));
      }
    }

    const components = buildFaceComponents(data, region.faceIds, selectedEdges);
    if (components.length !== 3) continue;

    let ok = true;
    for (const faceIds of components) {
      const boundaryCycle = computeBoundaryCycleForFaceSet(data, faceIds);
      if (!boundaryCycle || boundaryCycle.length < 3) {
        ok = false;
        break;
      }
      const childCorners = classifyChild(boundaryCycle, region.corners, cand);
      if (!childCorners) {
        ok = false;
        break;
      }

      const child = {
        faceIds: faceIds.slice(),
        boundaryCycle: boundaryCycle.slice(),
        boundarySet: new Set(boundaryCycle.map(String)),
        vertexSet: regionVertexSet(data, faceIds),
        edgeSet: regionEdgeSet(data, faceIds, boundaryCycle),
        corners: childCorners,
        depth: region.depth + 1
      };
      child.adj = buildRegionAdjacency(child);

      const childResult = searchRegion(data, child, stats, memo);
      if (!childResult.ok) {
        ok = false;
        break;
      }
    }

    if (ok) {
      const result = {
        ok: true,
        witness: {
          v: String(cand),
          corners: region.corners.slice(),
          paths: paths.map((p) => p.slice())
        }
      };
      memo.set(key, result);
      return result;
    }
  }

  const fail = {
    ok: false,
    reason: 'no recursive center found',
    region: {
      depth: region.depth,
      corners: region.corners.slice(),
      boundarySize: region.boundaryCycle.length,
      interiorCount: interior.length
    }
  };
  memo.set(key, fail);
  return fail;
}

function runGraph(windowObj, graphName) {
  const text = windowObj.PlanarVibeGraphGenerator.getSample(graphName);
  const parsed = parseEdgeListText(text);
  const data = buildTriangulatedData(windowObj, parsed.nodeIds, parsed.edgePairs);
  if (!data.ok) return { ok: false, graphName, reason: data.reason };

  const triples = listBoundaryCornerTriples(data.outerFace);
  if (triples.length === 0) return { ok: false, graphName, reason: 'outer face too small' };

  let bestFail = null;
  let totalStats = { calls: 0, maxDepth: 0, maxBoundary: data.outerFace.length, candidatesTried: 0, triplesTried: 0 };
  for (const corners of triples) {
    totalStats.triplesTried += 1;
    const region = {
      faceIds: data.boundedFaceIds.slice(),
      boundaryCycle: data.outerFace.slice(),
      boundarySet: new Set(data.outerFace.map(String)),
      vertexSet: regionVertexSet(data, data.boundedFaceIds),
      edgeSet: regionEdgeSet(data, data.boundedFaceIds, data.outerFace),
      corners: corners.slice(),
      depth: 0
    };
    region.adj = buildRegionAdjacency(region);

    const stats = {
      calls: 0,
      maxDepth: 0,
      maxBoundary: data.outerFace.length,
      candidatesTried: 0
    };
    const result = searchRegion(data, region, stats, new Map());
    totalStats.calls += stats.calls;
    totalStats.maxDepth = Math.max(totalStats.maxDepth, stats.maxDepth);
    totalStats.maxBoundary = Math.max(totalStats.maxBoundary, stats.maxBoundary);
    totalStats.candidatesTried += stats.candidatesTried;
    if (result.ok) {
      return {
        ok: true,
        graphName,
        outerFaceSize: data.outerFace.length,
        corners,
        stats: totalStats,
        fail: null
      };
    }
    if (!bestFail) bestFail = result;
  }

  return {
    ok: false,
    graphName,
    outerFaceSize: data.outerFace.length,
    stats: totalStats,
    fail: bestFail
  };
}

const only = process.argv.slice(2);
const names = only.length ? only : benchmark;
const windowObj = loadBrowserModules();
let bad = 0;

for (const name of names) {
  const result = runGraph(windowObj, name);
  if (result.ok) {
    console.log(
      `OK   ${name} | outer=${result.outerFaceSize} | calls=${result.stats.calls} | depth=${result.stats.maxDepth} | maxBoundary=${result.stats.maxBoundary} | candidates=${result.stats.candidatesTried}`
    );
  } else {
    bad += 1;
    if (result.fail && result.fail.region) {
      const r = result.fail.region;
      console.log(
        `FAIL ${name} | outer=${result.outerFaceSize} | depth=${r.depth} | boundary=${r.boundarySize} | interior=${r.interiorCount} | corners=${r.corners.join('/')}`
      );
    } else {
      console.log(`FAIL ${name} | ${result.reason || 'unknown failure'}`);
    }
  }
}

if (bad > 0) process.exitCode = 1;
