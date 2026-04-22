import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function parseEdgeListText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const nodes = new Set();
  const edges = [];
  const seen = new Set();

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts[0] === 'v' || parts[0] === 'V') {
      if (parts.length >= 2) {
        nodes.add(parts[1]);
      }
      continue;
    }
    if (parts.length < 2) {
      throw new Error(`Invalid edge line: ${line}`);
    }
    const a = parts[0];
    const b = parts[1];
    if (a === b) {
      continue;
    }
    nodes.add(a);
    nodes.add(b);
    const k = a < b ? `${a}::${b}` : `${b}::${a}`;
    if (seen.has(k)) {
      continue;
    }
    seen.add(k);
    edges.push([a, b]);
  }

  return { nodeIds: [...nodes], edgePairs: edges };
}

function parseVertexPositionsFromEdgeList(text) {
  const lines = String(text || '').split(/\r?\n/);
  const pos = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const parts = line.split(/\s+/);
    if ((parts[0] === 'v' || parts[0] === 'V') && parts.length >= 4) {
      const id = String(parts[1]);
      const x = Number(parts[2]);
      const y = Number(parts[3]);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        pos[id] = { x, y };
      }
    }
  }
  return pos;
}

function loadBrowserModules() {
  const window = {};
  window.window = window;

  const context = vm.createContext({
    window,
    console,
    Math,
    Set,
    Map,
    Array,
    Object,
    String,
    Number
  });

  const files = [
    'static/js/planarvibe-plugin.js',
    'static/js/graph-generator.js',
    'static/js/planarity-test.js',
    'static/js/metrics.js',
    'static/js/linear-algebra.js',
    'static/js/geometry-utils.js',
    'static/js/planar-graph-utils.js',
    'static/js/graph-utils.js',
    'static/js/layout-preprocessing.js',
    'static/js/cy-runtime.js',
    'static/js/layout-random.js',
    'static/js/layout-tutte.js',
    'static/js/layout-air.js',
    'static/js/layout-ppag.js',
    'static/js/layout-facebalancer.js',
    'static/js/layout-edgebalancer.js',
    'static/js/layout-anglebalancer.js',
    'static/js/layout-hybridbalancer.js',
    'static/js/layout-ceg23.js',
    'static/js/layout-impred.js',
    'static/js/layout-reweight.js',
    'static/js/layout-fd-uniform.js',
    'static/js/layout-p3t.js',
    'static/js/layout-fpp.js',
    'static/js/layout-schnyder.js'
  ];

  for (const rel of files) {
    const abs = path.resolve(process.cwd(), rel);
    const code = fs.readFileSync(abs, 'utf8');
    const script = new vm.Script(code, { filename: rel });
    script.runInContext(context);
  }

  return window;
}

const modules = loadBrowserModules();
const Generator = modules.PlanarVibeGraphGenerator;
const LayoutPreprocessing = modules.LayoutPreprocessing;
const PlanarGraphUtils = modules.PlanarGraphUtils;
const Planarity = modules.PlanarVibePlanarityTest;
const GraphUtils = modules.GraphUtils;
const GeometryUtils = modules.GeometryUtils;
const Metrics = modules.PlanarVibeMetrics;
const Tutte = modules.PlanarVibeTutte;
const Air = modules.PlanarVibeAir;
const PPAG = modules.PlanarVibePPAG;
const FaceBalancer = modules.PlanarVibeFaceBalancer;
const EdgeBalancer = modules.PlanarVibeEdgeBalancer;
const AngleBalancer = modules.PlanarVibeAngleBalancer;
const Hybrid = modules.PlanarVibeHybrid;
const ImPrEd = modules.PlanarVibeImPrEd;
const FPP = modules.PlanarVibeFPP;
const Schnyder = modules.PlanarVibeSchnyder;
const P3T = modules.PlanarVibeP3T;
const Reweight = modules.PlanarVibeReweightTutte;
const FDUniform = modules.PlanarVibeFDUniform;
const CEG23Bfs = modules.PlanarVibeCEG23Bfs;
const Random = modules.PlanarVibeRandom;
const CyRuntime = modules.CyRuntime;

const TUTTE_OUTER_CYCLE_REGRESSION_GRAPH = {
  nodeIds: ['0', '1', '2', '3', '12', '7', '11', '10', '9', '5', '8', '6', '4'],
  edgePairs: [
    ['0', '1'],
    ['1', '2'],
    ['3', '2'],
    ['12', '0'],
    ['12', '7'],
    ['11', '0'],
    ['10', '0'],
    ['9', '7'],
    ['9', '5'],
    ['8', '7'],
    ['8', '5'],
    ['6', '7'],
    ['6', '2'],
    ['6', '5'],
    ['4', '5'],
    ['4', '2']
  ]
};

function buildMockCy(nodeIds, edgePairs) {
  const nodeMap = new Map();
  const nodeObjs = nodeIds.map((id) => {
    const obj = {
      _id: String(id),
      _pos: null,
      id() {
        return this._id;
      },
      data(key) {
        if (key === 'label') {
          return this._id;
        }
        return undefined;
      },
      position(pos) {
        if (pos === undefined) {
          if (this._pos === null) {
            return { x: 0, y: 0 };
          }
          return { x: this._pos.x, y: this._pos.y };
        }
        this._pos = { x: pos.x, y: pos.y };
      }
    };
    nodeMap.set(String(id), obj);
    return obj;
  });

  const edgeObjs = edgePairs.map(([u, v]) => ({
    _id: `${u}--${v}`,
    id() {
      return this._id;
    },
    source() {
      return { id: () => String(u) };
    },
    target() {
      return { id: () => String(v) };
    }
  }));

  return {
    _nodeObjs: nodeObjs,
    _edgeObjs: edgeObjs,
    _fitCalls: 0,
    _fitArg: null,
    _fitPadding: null,
    nodes() {
      const arr = this._nodeObjs;
      arr.toArray = function toArray() {
        return arr.slice();
      };
      return arr;
    },
    edges() {
      return this._edgeObjs;
    },
    fit(arg, padding) {
      this._fitCalls += 1;
      this._fitArg = arg === undefined ? null : arg;
      this._fitPadding = padding;
    },
    width() {
      return 900;
    },
    height() {
      return 620;
    }
  };
}

function orientation(a, b, c) {
  const val = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(val) < 1e-9) {
    return 0;
  }
  return val > 0 ? 1 : 2;
}

function onSegment(a, b, c) {
  return (
    Math.min(a.x, c.x) - 1e-9 <= b.x &&
    b.x <= Math.max(a.x, c.x) + 1e-9 &&
    Math.min(a.y, c.y) - 1e-9 <= b.y &&
    b.y <= Math.max(a.y, c.y) + 1e-9
  );
}

function segmentsIntersect(p1, q1, p2, q2) {
  const o1 = orientation(p1, q1, p2);
  const o2 = orientation(p1, q1, q2);
  const o3 = orientation(p2, q2, p1);
  const o4 = orientation(p2, q2, q1);

  if (o1 !== o2 && o3 !== o4) {
    return true;
  }
  if (o1 === 0 && onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && onSegment(p1, q2, q1)) return true;
  if (o3 === 0 && onSegment(p2, p1, q2)) return true;
  if (o4 === 0 && onSegment(p2, q1, q2)) return true;
  return false;
}

function hasEdgeCrossing(nodeIds, edgePairs, positionsById) {
  function shareEndpoint(e1, e2) {
    return (
      e1[0] === e2[0] ||
      e1[0] === e2[1] ||
      e1[1] === e2[0] ||
      e1[1] === e2[1]
    );
  }

  for (let i = 0; i < edgePairs.length; i += 1) {
    for (let j = i + 1; j < edgePairs.length; j += 1) {
      const e1 = edgePairs[i];
      const e2 = edgePairs[j];
      if (shareEndpoint(e1, e2)) {
        continue;
      }

      const p1 = positionsById[e1[0]];
      const q1 = positionsById[e1[1]];
      const p2 = positionsById[e2[0]];
      const q2 = positionsById[e2[1]];
      if (!p1 || !q1 || !p2 || !q2) {
        return true;
      }

      if (segmentsIntersect(p1, q1, p2, q2)) {
        return true;
      }
    }
  }
  return false;
}

function faceCanonicalKeyForTest(face) {
  if (!face || face.length === 0) {
    return '';
  }
  const arr = face.map(String);
  const n = arr.length;
  let best = null;
  for (let i = 0; i < n; i += 1) {
    const rot = arr.slice(i).concat(arr.slice(0, i)).join('|');
    if (best === null || rot < best) {
      best = rot;
    }
  }
  const rev = arr.slice().reverse();
  for (let i = 0; i < n; i += 1) {
    const rot = rev.slice(i).concat(rev.slice(0, i)).join('|');
    if (best === null || rot < best) {
      best = rot;
    }
  }
  return best || '';
}

function polygonAreaAbs(face, positionsById) {
  let sum = 0;
  for (let i = 0; i < face.length; i += 1) {
    const a = positionsById[String(face[i])];
    const b = positionsById[String(face[(i + 1) % face.length])];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

function minBoundedFaceArea(graph, positionsById) {
  const embedding = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
  if (!embedding || !embedding.ok) {
    return null;
  }
  const outerKey = faceCanonicalKeyForTest(PlanarGraphUtils.chooseOuterFaceFromEmbedding(embedding) || []);
  let minArea = Infinity;
  for (const face of embedding.faces || []) {
    if (faceCanonicalKeyForTest(face) === outerKey) {
      continue;
    }
    const area = polygonAreaAbs(face, positionsById);
    if (area < minArea) {
      minArea = area;
    }
  }
  return Number.isFinite(minArea) ? minArea : null;
}

function edgeLengthRatio(edgePairs, positionsById) {
  let minLen = Infinity;
  let maxLen = 0;
  for (const [u, v] of edgePairs) {
    const pu = positionsById[String(u)];
    const pv = positionsById[String(v)];
    const dx = pu.x - pv.x;
    const dy = pu.y - pv.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < minLen) {
      minLen = len;
    }
    if (len > maxLen) {
      maxLen = len;
    }
  }
  if (!(minLen >= 0) || !(maxLen > 0)) {
    return null;
  }
  return minLen / maxLen;
}

function assertNoVertexOverlaps(cy, messagePrefix = 'vertex overlap') {
  const seen = new Set();
  for (const node of cy.nodes()) {
    const p = node._pos;
    assert.equal(!!p, true, `${messagePrefix}: missing position for node ${node.id()}`);
    const key = `${p.x},${p.y}`;
    assert.equal(seen.has(key), false, `${messagePrefix}: node ${node.id()} overlaps at ${key}`);
    seen.add(key);
  }
}

test('nonplanar1 (K3,3) is non-planar', () => {
  const text = Generator.getSample('nonplanar1');
  const graph = parseEdgeListText(text);
  const emb = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
  assert.equal(emb.ok, false);
});

test('edge-list parser accepts explicit vertex coordinates via "v id x y"', () => {
  const parsed = modules.PlanarVibePlugin.parseEdgeList(
    [
      'v a 10 20',
      'v b -5.5 7.25',
      'a b'
    ].join('\n')
  );
  assert.equal(parsed.nodeCount, 2);
  assert.equal(parsed.edgeCount, 1);
  assert.equal(parsed.hasExplicitPositions, true);
  assert.equal(parsed.positionsById.a.x, 10);
  assert.equal(parsed.positionsById.a.y, 20);
  assert.equal(parsed.positionsById.b.x, -5.5);
  assert.equal(parsed.positionsById.b.y, 7.25);
});

test('large non-planar generator stays non-planar', () => {
  const text = Generator.nonPlanarK33PlusPath(30);
  const graph = parseEdgeListText(text);
  assert.equal(graph.nodeIds.length, 30);
  const emb = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
  assert.equal(emb.ok, false);
});

test('large planar stellation generator stays planar', () => {
  const text = Generator.planarStellationGraph(40, 9);
  const graph = parseEdgeListText(text);
  assert.equal(graph.nodeIds.length, 40);
  const emb = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
  assert.equal(emb.ok, true);
});

test('10 random planar graphs (100 vertices) from stellation are planar', () => {
  for (let seed = 1; seed <= 10; seed += 1) {
    const text = Generator.planarStellationGraph(100, 10, seed);
    const graph = parseEdgeListText(text);
    assert.equal(graph.nodeIds.length, 100);
    const emb = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
    assert.equal(emb.ok, true, `expected planar for seed=${seed}`);
  }
});

test('10 random non-planar graphs (100 vertices) from K3,3 core are non-planar', () => {
  for (let seed = 1; seed <= 10; seed += 1) {
    const text = Generator.nonPlanarK33PlusPath(100, seed);
    const graph = parseEdgeListText(text);
    assert.equal(graph.nodeIds.length, 100);
    const emb = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
    assert.equal(emb.ok, false, `expected non-planar for seed=${seed}`);
  }
});

test('random planar sample set has requested sizes and is planar', () => {
  const expected = [
    { key: 'randomplanar1', n: 30, m: 80 },
    { key: 'randomplanar2', n: 50, m: 130 },
    { key: 'randomplanar3', n: 50, m: 144 },
    { key: 'randomplanar4', n: 60, m: 150 },
    { key: 'randomplanar5', n: 70, m: 200 }
  ];
  for (const item of expected) {
    const text = Generator.getSample(item.key);
    const graph = parseEdgeListText(text);
    assert.equal(graph.nodeIds.length, item.n, `${item.key} vertex count mismatch`);
    assert.equal(graph.edgePairs.length, item.m, `${item.key} edge count mismatch`);
    const emb = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
    assert.equal(emb.ok, true, `${item.key} expected planar`);
  }
});

test('maximal planar 3-tree generator returns planar 3-tree', () => {
  const text = Generator.maximalPlanar3Tree(30);
  const graph = parseEdgeListText(text);

  const emb = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
  assert.equal(emb.ok, true);
  assert.equal(emb.idByIndex.length, 30);

  const is3Tree = Planarity.isPlanar3Tree(graph);
  assert.equal(is3Tree, true);

  const analysis = Planarity.analyzePlanar3Tree(graph);
  assert.equal(analysis.ok, true);
  assert.equal(analysis.outerFace.length, 3);
  assert.equal(analysis.elimination.length, 27);
});

test('cycle graph is planar but not planar 3-tree', () => {
  const text = Generator.cycleGraph(8);
  const graph = parseEdgeListText(text);
  assert.equal(Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs).ok, true);
  assert.equal(Planarity.isPlanar3Tree(graph), false);
});

test('wheel graph W7 is planar and not planar 3-tree', () => {
  const text = Generator.wheelGraph(7);
  const graph = parseEdgeListText(text);
  assert.equal(Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs).ok, true);
  assert.equal(Planarity.isPlanar3Tree(graph), false);
});

test('planar augmentation triangulates non-triangular planar faces', () => {
  const text = Generator.cycleGraph(8);
  const graph = parseEdgeListText(text);
  const result = FPP.computeFPPPositions(graph);
  const prepared = result.prepared;

  assert.equal(result.ok, true, result.message || result.reason || 'FPP compute failed');
  assert.equal(prepared.ok, true);
  assert.equal(prepared.augmentedDummyCount > 0, true);
  assert.equal(prepared.embedding.ok, true);

  const n = prepared.embedding.idByIndex.length;
  const m = prepared.embedding.edges.length;
  assert.equal(m, 3 * n - 6);
  for (const f of prepared.embedding.faces) {
    assert.equal(f.length, 3);
  }
});

test('triangulateByFaceStellation adds one dummy vertex for every non-triangular face including the outer face when requested', () => {
  const text = Generator.cycleGraph(8);
  const graph = parseEdgeListText(text);
  const embedding = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
  const outerFace = embedding.outerFace.slice();

  assert.equal(embedding.ok, true);

  const augmented = PlanarGraphUtils.triangulateByFaceStellation(
    graph,
    embedding,
    outerFace,
    { triangulateOuterFace: true }
  );
  const originalNodeSet = new Set(graph.nodeIds.map(String));
  const dummyIds = augmented.graph.nodeIds
    .map(String)
    .filter((id) => !originalNodeSet.has(id));

  assert.equal(augmented.ok, true, augmented.reason || 'triangulation failed');
  assert.equal(augmented.dummyCount, 2);
  assert.equal(dummyIds.length, 2);
  for (const dummyId of dummyIds) {
    assert.equal(
      augmented.graph.edgePairs.filter(([a, b]) => String(a) === String(dummyId) || String(b) === String(dummyId)).length,
      8,
      `expected 8 stellation edges around ${dummyId}`
    );
    for (const v of outerFace) {
      assert.equal(
        augmented.graph.edgePairs.some(([a, b]) =>
          (String(a) === String(dummyId) && String(b) === String(v)) ||
          (String(a) === String(v) && String(b) === String(dummyId))
        ),
        true,
        `missing stellation edge ${dummyId}-${v}`
      );
    }
  }
});

test('triangulated augmentation removes degree-3 dummy vertices from the final graph', () => {
  const text = Generator.getSample('sample5');
  const graph = parseEdgeListText(text);
  const embedding = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
  const outerFace = PlanarGraphUtils.chooseOuterFaceFromEmbedding(embedding);
  const prepared = PlanarGraphUtils.triangulateByFaceStellation(
    graph,
    embedding,
    outerFace
  );

  assert.equal(prepared.ok, true);

  const degreeById = {};
  for (const id of prepared.graph.nodeIds) {
    degreeById[String(id)] = 0;
  }
  for (const [a, b] of prepared.graph.edgePairs) {
    degreeById[String(a)] += 1;
    degreeById[String(b)] += 1;
  }

  const originalNodeSet = new Set(graph.nodeIds.map(String));
  const dummyIds = prepared.graph.nodeIds
    .map(String)
    .filter((id) => !originalNodeSet.has(id));
  const degreeThreeDummies = dummyIds.filter((dummyId) => degreeById[String(dummyId)] === 3);

  assert.equal(degreeThreeDummies.length, 0);
});

test('triangulateByFaceStellation triangulates a cycle when the outer face must also be triangulated', () => {
  const text = Generator.cycleGraph(8);
  const graph = parseEdgeListText(text);
  const embedding = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
  const outerFace = embedding.outerFace.slice();

  const prepared = PlanarGraphUtils.triangulateByFaceStellation(
    graph,
    embedding,
    outerFace,
    { triangulateOuterFace: true }
  );

  assert.equal(prepared.ok, true, prepared.reason || 'triangulation failed');
  for (const face of prepared.embedding.faces) {
    assert.equal(face.length, 3);
  }
});

test('common outer-face helper prefers a chordless explicit outer face and otherwise falls back to the longest chordless face', () => {
  const explicit = PlanarGraphUtils.chooseOuterFaceFromEmbedding({
    outerFace: ['a', 'b', 'c'],
    edges: [['a', 'b'], ['b', 'c'], ['c', 'a'], ['x', 'y'], ['y', 'z'], ['z', 'w'], ['w', 'x']],
    faces: [['x', 'y', 'z', 'w']]
  });
  assert.deepEqual(explicit, ['a', 'b', 'c']);

  const fallback = PlanarGraphUtils.chooseOuterFaceFromEmbedding({
    edges: [
      ['1', '2'], ['2', '3'], ['3', '1'],
      ['4', '5'], ['5', '6'], ['6', '7'], ['7', '4'], ['4', '6'],
      ['8', '9'], ['9', '10'], ['10', '11'], ['11', '12'], ['12', '8']
    ],
    faces: [['1', '2', '3'], ['4', '5', '6', '7'], ['8', '9', '10', '11', '12']]
  });
  assert.deepEqual(fallback, ['8', '9', '10', '11', '12']);
});

test('common outer-face helper ignores an explicit outer face when it contains a chord', () => {
  const chosen = PlanarGraphUtils.chooseOuterFaceFromEmbedding({
    outerFace: ['1', '2', '3', '4'],
    edges: [
      ['1', '2'], ['2', '3'], ['3', '4'], ['4', '1'], ['1', '3'],
      ['5', '6'], ['6', '7'], ['7', '8'], ['8', '9'], ['9', '5']
    ],
    faces: [['1', '2', '3', '4'], ['5', '6', '7', '8', '9']]
  });
  assert.deepEqual(chosen, ['5', '6', '7', '8', '9']);
});

test('outer-face helper recovers the visible outer face from a plane drawing', () => {
  const text = Generator.getSample('sample5');
  const graph = parseEdgeListText(text);
  const pos = parseVertexPositionsFromEdgeList(text);
  const embedding = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
  const fromEmbedding = PlanarGraphUtils.chooseOuterFaceFromEmbedding(embedding);
  const outer = PlanarGraphUtils.chooseOuterFaceFromPositions(graph.nodeIds, graph.edgePairs, pos);
  assert.ok(Array.isArray(outer) && outer.length >= 3, 'expected a geometric outer face');
  assert.notEqual(faceCanonicalKeyForTest(outer || []), faceCanonicalKeyForTest(fromEmbedding || []));
});

test('shared initializer prefers the current plane drawing when choosing the outer face', () => {
  const text = Generator.getSample('sample5');
  const graph = parseEdgeListText(text);
  const pos = parseVertexPositionsFromEdgeList(text);
  const outer = PlanarGraphUtils.chooseOuterFaceFromPositions(graph.nodeIds, graph.edgePairs, pos);
  const prepared = LayoutPreprocessing.prepareGraphAndLayoutData(graph, {
    failureLabel: 'test',
    currentPositions: pos
  });
  assert.equal(prepared && prepared.ok, true, prepared && prepared.message ? prepared.message : 'shared initializer failed');
  assert.equal(
    faceCanonicalKeyForTest(prepared.outerFace || []),
    faceCanonicalKeyForTest(outer || [])
  );
});

test('shared embedding-position verifier rejects degenerate faces', () => {
  const embedding = {
    ok: true,
    idByIndex: ['1', '2', '3'],
    edges: [['1', '2'], ['2', '3'], ['3', '1']],
    faces: [['1', '2', '3']],
    outerFace: ['1', '2', '3']
  };
  const pos = {
    '1': { x: 0, y: 0 },
    '2': { x: 1, y: 0 },
    '3': { x: 2, y: 0 }
  };

  const verify = LayoutPreprocessing.verifyEmbeddingWithPositions(embedding, pos, {});
  assert.equal(verify.ok, false);
  assert.match(String(verify.message || ''), /degenerate/i);
});

test('shared initializer builds a verified seed for grid2x20', () => {
  const text = Generator.getSample('grid2x20');
  const graph = parseEdgeListText(text);
  const prepared = LayoutPreprocessing.prepareGraphAndLayoutData(graph, {
    failureLabel: 'Shared seed test'
  });

  assert.equal(prepared && prepared.ok, true, prepared && prepared.message ? prepared.message : 'shared initialization failed');
  assert.ok(prepared && prepared.posById, 'expected initialized coordinates');

  const verify = LayoutPreprocessing.verifyEmbeddingWithPositions(prepared.augmented.embedding, prepared.posById, {
    edgePairs: prepared.augmented.graph.edgePairs,
    outerFace: prepared.augmentedOuterFace
  });

  assert.equal(verify.ok, true, verify && verify.message ? verify.message : 'expected verified seed drawing');
});

test('raw shared barycentric seed rejects an outer face that does not belong to the embedding', () => {
  const text = Generator.getSample('grid2x20');
  const graph = parseEdgeListText(text);
  const prepared = LayoutPreprocessing.prepareGraphData(graph, {
    failureLabel: 'Shared seed test'
  });

  assert.equal(prepared && prepared.ok, true, prepared && prepared.message ? prepared.message : 'prepareGraphData failed');

  const seed = LayoutPreprocessing.computeInitialPositions(
    prepared.augmentedGraph,
    prepared.outerFace,
    prepared.augmented.embedding
  );

  assert.equal(seed && seed.ok, false);
  assert.match(String(seed && seed.message || ''), /outer face is not a face of the embedding/i);
});

test('prepareGraphData defaults to outer-cycle triangulation', () => {
  const prepared = LayoutPreprocessing.prepareGraphData({
    nodeIds: ['1', '2', '3', '4'],
    edgePairs: [['1', '2'], ['2', '3'], ['3', '4'], ['4', '1']]
  }, {
    failureLabel: 'Augmentation method test'
  });

  assert.equal(prepared && prepared.ok, true, prepared && prepared.message ? prepared.message : 'prepareGraphData failed');
  assert.equal(prepared.augmentationMethod, 'triangulateByOuterCycle');
  assert.equal(prepared.augmented && prepared.augmented.method, 'triangulateByOuterCycle');
});

test('prepareGraphData can use the outer-cycle augmentation on a drawing with repeated outer-face vertices', () => {
  const graph = {
    nodeIds: ['a', 'b', 'c', 'd', 'e'],
    edgePairs: [['a', 'b'], ['b', 'c'], ['c', 'a'], ['b', 'd'], ['d', 'e'], ['e', 'b']]
  };
  const pos = {
    a: { x: 0, y: 0 },
    b: { x: 1, y: 1 },
    c: { x: 0, y: 2 },
    d: { x: 3, y: 2 },
    e: { x: 3, y: 0 }
  };

  const prepared = LayoutPreprocessing.prepareGraphData(graph, {
    failureLabel: 'Outer cycle test',
    augmentationMethod: 'outer-cycle',
    currentPositions: pos
  });

  assert.equal(prepared && prepared.ok, true, prepared && prepared.message ? prepared.message : 'prepareGraphData failed');
  assert.equal(prepared.augmentationMethod, 'triangulateByOuterCycle');
  assert.equal(prepared.augmented && prepared.augmented.method, 'triangulateByOuterCycle');
  assert.equal((prepared.outerFace || []).filter((id) => id === 'b').length, 2);
  assert.equal(prepared.augmentedDummyCount, prepared.outerFace.length);
  assert.deepEqual(prepared.augmentedOuterFace, prepared.embedding.outerFace);
  assert.equal(new Set(prepared.augmentedOuterFace).size, prepared.augmentedOuterFace.length, 'outer dummy cycle should use distinct dummy vertices');
});

test('outer-cycle augmentation fully triangulates the Tutte regression instance', () => {
  const prepared = LayoutPreprocessing.prepareGraphData(TUTTE_OUTER_CYCLE_REGRESSION_GRAPH, {
    failureLabel: 'Tutte regression'
  });

  assert.equal(prepared && prepared.ok, true, prepared && prepared.message ? prepared.message : 'prepareGraphData failed');
  const internal = PlanarGraphUtils.analyzeInternallyTriangulated(
    prepared.embedding,
    prepared.augmentedOuterFace
  );
  assert.equal(internal && internal.ok, true, internal && internal.reason ? internal.reason : 'embedding should be internally triangulated');
});

test('splitFaceIntoSegments splits the Tutte regression face at repeats', () => {
  const face = ['0', '12', '7', '6', '2', '1', '0', '10', '0', '11'];
  const segments = PlanarGraphUtils.splitFaceIntoSegments(face);

  assert.equal(
    JSON.stringify(segments),
    JSON.stringify([
      ['0', '12', '7', '6', '2', '1'],
      ['0', '10'],
      ['0', '11'],
      ['0']
    ])
  );
});

test('splitFaceIntoSegments keeps a simple face as a single segment', () => {
  const face = ['a', 'b', 'c', 'd'];
  const segments = PlanarGraphUtils.splitFaceIntoSegments(face);

  assert.equal(
    JSON.stringify(segments),
    JSON.stringify([
      ['a', 'b', 'c', 'd']
    ])
  );
});

test('splitFaceIntoSegments splits once at a repeated articulation and closes in the final segment', () => {
  const face = ['a', 'b', 'c', 'b', 'd'];
  const segments = PlanarGraphUtils.splitFaceIntoSegments(face);

  assert.equal(
    JSON.stringify(segments),
    JSON.stringify([
      ['a', 'b', 'c'],
      ['b', 'd', 'a']
    ])
  );
});

test('prepareGraphData rejects unknown augmentation methods', () => {
  const prepared = LayoutPreprocessing.prepareGraphData({
    nodeIds: ['1', '2', '3'],
    edgePairs: [['1', '2'], ['2', '3'], ['3', '1']]
  }, {
    failureLabel: 'Augmentation method test',
    augmentationMethod: 'futureMagic'
  });

  assert.equal(prepared && prepared.ok, false);
  assert.match(String(prepared && prepared.message || ''), /unknown augmentation method/i);
});

test('shared layout runner fits once before compute even with a shared seed', async () => {
  const graph = {
    nodeIds: ['a', 'b', 'c', 'd', 'e'],
    edgePairs: [['a', 'b'], ['b', 'c'], ['c', 'a'], ['b', 'd'], ['d', 'e'], ['e', 'b']]
  };
  const pos = {
    a: { x: 0, y: 0 },
    b: { x: 1, y: 1 },
    c: { x: 0, y: 2 },
    d: { x: 3, y: 2 },
    e: { x: 3, y: 0 }
  };
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);
  for (const node of cy.nodes()) {
    const p = pos[String(node.id())];
    if (p) {
      node.position(p);
    }
  }

  const finalPos = {};
  for (const id of graph.nodeIds) {
    const p = pos[String(id)];
    finalPos[String(id)] = { x: p.x + 50, y: p.y - 30 };
  }
  const preparedSeed = LayoutPreprocessing.prepareGraphAndLayoutData(graph, {
    failureLabel: 'PPAG layout',
    currentPositions: pos,
    augmentationMethod: 'outer-cycle'
  });
  assert.equal(preparedSeed && preparedSeed.ok, true, preparedSeed && preparedSeed.message ? preparedSeed.message : 'shared seed prep failed');
  const seededOriginalPositions = GeometryUtils.filterPositionMap(preparedSeed.posById, graph.nodeIds);
  const seedPositions = preparedSeed.posById;
  const expectedFitBounds = {
    x1: Math.min(...Object.values(seedPositions).map((p) => p.x)),
    y1: Math.min(...Object.values(seedPositions).map((p) => p.y)),
    x2: Math.max(...Object.values(seedPositions).map((p) => p.x)),
    y2: Math.max(...Object.values(seedPositions).map((p) => p.y))
  };
  let fitCountAtComputeStart = -1;
  const result = await CyRuntime.runLayout(cy, {
    delayMs: 0,
    yieldEvery: 50,
    augmentationMethod: 'outer-cycle'
  }, {
    prepareMode: 'graph+layout',
    prepareFailureLabel: 'PPAG layout',
    initialFitBounds: function (ctx) {
      return CyRuntime.computePositionBounds(ctx.prepared.posById);
    },
    patchComputeOptions: function (ctx) {
      return {
        onIteration: ctx.onProgress
      };
    },
    computePositions: async function (_graph, options, prepared) {
      fitCountAtComputeStart = cy._fitCalls;
      assert.equal(prepared && prepared.ok, true);
      await options.onIteration({
        iter: 1,
        maxIters: 2,
        positions: finalPos
      });
      await options.onIteration({
        iter: 2,
        maxIters: 2,
        positions: finalPos
      });
      return {
        ok: true,
        positions: finalPos
      };
    },
    failureMessage: 'layout seed test failed'
  });

  assert.equal(result && result.ok, true, result && result.message ? result.message : 'runLayout failed');
  assert.equal(fitCountAtComputeStart, 1);
  assert.equal(cy._fitCalls, 1);
  assert.equal(cy._fitArg && cy._fitArg.x1, expectedFitBounds.x1);
  assert.equal(cy._fitArg && cy._fitArg.y1, expectedFitBounds.y1);
  assert.equal(cy._fitArg && cy._fitArg.x2, expectedFitBounds.x2);
  assert.equal(cy._fitArg && cy._fitArg.y2, expectedFitBounds.y2);
  for (const node of cy.nodes()) {
    assert.deepEqual(node.position(), finalPos[String(node.id())]);
  }
});

test('shared layout runner passes the original positions and prepared seed into compute', async () => {
  const graph = {
    nodeIds: ['a', 'b', 'c', 'd', 'e'],
    edgePairs: [['a', 'b'], ['b', 'c'], ['c', 'a'], ['b', 'd'], ['d', 'e'], ['e', 'b']]
  };
  const pos = {
    a: { x: 0, y: 0 },
    b: { x: 1, y: 1 },
    c: { x: 0, y: 2 },
    d: { x: 3, y: 2 },
    e: { x: 3, y: 0 }
  };
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);
  for (const node of cy.nodes()) {
    const p = pos[String(node.id())];
    if (p) {
      node.position(p);
    }
  }

  const preparedSeed = LayoutPreprocessing.prepareGraphAndLayoutData(graph, {
    failureLabel: 'PPAG layout',
    currentPositions: pos,
    augmentationMethod: 'outer-cycle'
  });
  assert.equal(preparedSeed && preparedSeed.ok, true, preparedSeed && preparedSeed.message ? preparedSeed.message : 'shared seed prep failed');

  let computeCurrentPositions = null;
  let computePrepared = null;
  const result = await CyRuntime.runLayout(cy, {
    augmentationMethod: 'outer-cycle'
  }, {
    prepareMode: 'graph+layout',
    prepareFailureLabel: 'PPAG layout',
    initialFitBounds: function (ctx) {
      return CyRuntime.computePositionBounds(ctx.prepared.posById);
    },
    computePositions: function (_graph, options, prepared) {
      computeCurrentPositions = options.currentPositions;
      computePrepared = prepared;
      return {
        ok: true,
        positions: preparedSeed.posById
      };
    },
    failureMessage: 'layout seed handoff test failed'
  });

  assert.equal(result && result.ok, true, result && result.message ? result.message : 'runLayout failed');
  assert.deepEqual(JSON.parse(JSON.stringify(computeCurrentPositions)), pos);
  assert.equal(computePrepared && computePrepared.ok, true);
  assert.deepEqual(GeometryUtils.filterPositionMap(computePrepared.posById, graph.nodeIds), preparedSeed.positions || GeometryUtils.filterPositionMap(preparedSeed.posById, graph.nodeIds));
});

test('AngleBalancer uses graph preparation in the runtime', async () => {
  const originalRunLayout = CyRuntime.runLayout;
  const cy = buildMockCy(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'a']]);
  let capturedSpec = null;
  CyRuntime.runLayout = function (_cy, _options, spec) {
    capturedSpec = spec;
    return Promise.resolve({ ok: true, message: 'ok' });
  };
  try {
    const result = await AngleBalancer.applyAngleBalancerLayout(cy, {});
    assert.equal(result && result.ok, true);
    assert.ok(capturedSpec, 'expected AngleBalancer to call CyRuntime.runLayout');
    assert.equal(capturedSpec.prepareMode, 'graph');
    assert.equal(capturedSpec.prepareFailureLabel, 'AngleBalancer layout');
  } finally {
    CyRuntime.runLayout = originalRunLayout;
  }
});

test('Hybrid uses graph preparation in the runtime', async () => {
  const originalRunLayout = CyRuntime.runLayout;
  const cy = buildMockCy(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'a']]);
  let capturedSpec = null;
  CyRuntime.runLayout = function (_cy, _options, spec) {
    capturedSpec = spec;
    return Promise.resolve({ ok: true, message: 'ok' });
  };
  try {
    const result = await Hybrid.applyHybridLayout(cy, {});
    assert.equal(result && result.ok, true);
    assert.ok(capturedSpec, 'expected Hybrid to call CyRuntime.runLayout');
    assert.equal(capturedSpec.prepareMode, 'graph');
    assert.equal(capturedSpec.prepareFailureLabel, 'Hybrid layout');
  } finally {
    CyRuntime.runLayout = originalRunLayout;
  }
});

test('shared layout runner does not synthesize a final progress step for one-shot layouts', async () => {
  const graph = {
    nodeIds: ['a', 'b', 'c'],
    edgePairs: [['a', 'b'], ['b', 'c']]
  };
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);
  const finalPos = {
    a: { x: 10, y: 20 },
    b: { x: 30, y: 40 },
    c: { x: 50, y: 60 }
  };
  const events = [];

  const result = await CyRuntime.runLayout(cy, {
    onIteration: function (progress) {
      events.push(progress);
    }
  }, {
    initialFitBounds: function (ctx) {
      return CyRuntime.computePositionBounds(ctx.currentPositions);
    },
    computePositions: function () {
      return {
        ok: true,
        positions: finalPos
      };
    },
    failureMessage: 'one-shot layout failed'
  });

  assert.equal(result && result.ok, true, result && result.message ? result.message : 'runLayout failed');
  assert.equal(events.length, 0);
  for (const node of cy.nodes()) {
    assert.deepEqual(node.position(), finalPos[String(node.id())]);
  }
});

test('Random emits one explicit 1/1 progress step', async () => {
  const graph = {
    nodeIds: ['a', 'b', 'c'],
    edgePairs: [['a', 'b'], ['b', 'c']]
  };
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);
  const events = [];

  const result = await Random.applyRandomLayout(cy, {
    onIteration: function (progress) {
      events.push(progress);
    }
  });

  assert.equal(result && result.ok, true, result && result.message ? result.message : 'Random failed');
  assert.equal(events.length, 1);
  assert.equal(events[0] && events[0].iter, 1);
  assert.equal(events[0] && events[0].maxIters, 1);
  assert.ok(events[0] && events[0].positions);
  for (const node of cy.nodes()) {
    const actual = node.position();
    const expected = events[0].positions[String(node.id())];
    assert.equal(actual && actual.x, expected && expected.x);
    assert.equal(actual && actual.y, expected && expected.y);
  }
});

test('viewport normalization maps arbitrary coordinates into the shared world size', () => {
  const normalized = GeometryUtils.normalizePositionMapToViewport({
    a: { x: -1000, y: -500 },
    b: { x: 3000, y: 1500 },
    c: { x: 500, y: 250 }
  });
  const xs = Object.values(normalized).map((p) => p.x);
  const ys = Object.values(normalized).map((p) => p.y);
  assert.ok(Math.min(...xs) >= 0);
  assert.ok(Math.max(...xs) <= modules.PlanarVibeViewportDefaults.width);
  assert.ok(Math.min(...ys) >= 0);
  assert.ok(Math.max(...ys) <= modules.PlanarVibeViewportDefaults.height);
});

test('shared movement convergence helper stops after enough stable iterations', () => {
  const prev = {
    a: { x: 0, y: 0 },
    b: { x: 10, y: 0 }
  };
  const next = {
    a: { x: 0.001, y: 0 },
    b: { x: 10.001, y: 0 }
  };
  const stats = GraphUtils.computePositionMoveStats(['a', 'b'], prev, next, { moveTol: 1e-4 });
  assert.ok(stats.maxMove > 0, 'expected non-zero movement');
  assert.equal(stats.movedVertices, 2);

  const tracker = GraphUtils.createMovementConvergenceTracker({
    minItersBeforeStop: 3,
    stableIterLimit: 2,
    maxMoveTol: 0.01,
    avgMoveTol: 0.01
  });
  const s1 = tracker.update({ maxMove: stats.maxMove, avgMove: stats.avgMove }, 1);
  const s2 = tracker.update({ maxMove: stats.maxMove, avgMove: stats.avgMove }, 2);
  const s3 = tracker.update({ maxMove: stats.maxMove, avgMove: stats.avgMove }, 3);
  assert.equal(s1.converged, false);
  assert.equal(s2.converged, false);
  assert.equal(s3.converged, true);
  assert.equal(s3.reason, 'movement-converged');
});

test('shared outer-face positioning ignores seed positions', () => {
  const nodeIds = ['1', '2', '3', '4'];
  const outerFace = ['1', '2', '3', '4'];
  const baseline = modules.PlanarVibeTutte.placeOuterFaceVertices(nodeIds, outerFace, {
    defaultCenterX: 2000,
    defaultCenterY: 2000,
    defaultRadius: 1000
  });
  const withSeed = modules.PlanarVibeTutte.placeOuterFaceVertices(nodeIds, outerFace, {
    seedPos: {
      '1': { x: 0, y: 0 },
      '2': { x: 10, y: 0 },
      '3': { x: 10, y: 10 },
      '4': { x: 0, y: 10 }
    },
    defaultCenterX: 2000,
    defaultCenterY: 2000,
    defaultRadius: 1000
  });
  assert.deepEqual(withSeed, baseline);
});

test('canonical ordering works on 10 random planar 3-trees (100 vertices)', () => {
  for (let seed = 1; seed <= 10; seed += 1) {
    const text = Generator.maximalPlanar3Tree(100 + seed);
    const graph = parseEdgeListText(text);
    const result = FPP.computeFPPPositions(graph);
    const prepared = result.prepared;
    const canonical = result.canonical;
    assert.equal(result.ok, true, `FPP compute failed for seed=${seed}: ${result.message || result.reason || ''}`);
    assert.equal(prepared.ok, true, `prepare failed for seed=${seed}`);
    assert.equal(canonical.ok, true, `canonical ordering failed for seed=${seed}`);
    assert.equal(canonical.order.length, prepared.embedding.idByIndex.length);
    assert.equal(new Set(canonical.order).size, canonical.order.length);
    assert.equal(canonical.outerFace.length, 3);
    assert.equal(canonical.order[0], canonical.outerFace[0]);
    assert.equal(canonical.order[1], canonical.outerFace[1]);
    assert.equal(canonical.order[2], canonical.outerFace[2]);
  }
});

test('canonical ordering works on sample planar3tree10', () => {
  const text = Generator.getSample('planar3tree10');
  const graph = parseEdgeListText(text);
  const result = FPP.computeFPPPositions(graph);
  const prepared = result.prepared;
  const canonical = result.canonical;
  assert.equal(result.ok, true, result.message || result.reason || 'FPP compute failed on planar3tree10');
  assert.equal(prepared.ok, true);
  assert.equal(canonical.ok, true, canonical.reason || 'canonical ordering failed on planar3tree10');
  assert.equal(canonical.order.length, prepared.embedding.idByIndex.length);
  assert.equal(new Set(canonical.order).size, canonical.order.length);
});

test('canonical ordering works on 10 random small planar 3-trees', () => {
  for (let seed = 1; seed <= 10; seed += 1) {
    const text = Generator.maximalPlanar3Tree(10 + seed);
    const graph = parseEdgeListText(text);
    const result = FPP.computeFPPPositions(graph);
    const prepared = result.prepared;
    const canonical = result.canonical;
    assert.equal(result.ok, true, `FPP compute failed for small seed=${seed}: ${result.message || result.reason || ''}`);
    assert.equal(prepared.ok, true, `prepare failed for small seed=${seed}`);
    assert.equal(canonical.ok, true, `canonical ordering failed for small seed=${seed}: ${canonical.reason || ''}`);
    assert.equal(canonical.order.length, prepared.embedding.idByIndex.length);
    assert.equal(new Set(canonical.order).size, canonical.order.length);
  }
});

test('canonical ordering works on small triangulated planar non-3-tree (octahedron)', () => {
  // Octahedron graph: maximal planar on 6 vertices, not a planar 3-tree.
  const text = [
    '1 2', '1 3', '1 4', '1 5',
    '6 2', '6 3', '6 4', '6 5',
    '2 3', '3 4', '4 5', '5 2'
  ].join('\n') + '\n';

  const graph = parseEdgeListText(text);
  assert.equal(Planarity.isPlanar3Tree(graph), false);

  const result = FPP.computeFPPPositions(graph);
  const prepared = result.prepared;
  const canonical = result.canonical;
  assert.equal(result.ok, true, result.message || result.reason || 'FPP compute failed on octahedron');
  assert.equal(prepared.ok, true);
  assert.equal(prepared.baseEmbedding.edges.length, 12);
  assert.equal(prepared.baseEmbedding.idByIndex.length, 6);
  assert.equal(prepared.embedding.outerFace.length, 3);
  assert.equal(canonical.ok, true, canonical.reason || 'canonical ordering failed on octahedron');
  assert.equal(canonical.order.length, prepared.embedding.idByIndex.length);
  assert.equal(new Set(canonical.order).size, canonical.order.length);
});

test('triangulateByFaceStellation triangulates embeddings with non-simple faces', () => {
  const text = Generator.getSample('randomplanar4');
  const graph = parseEdgeListText(text);
  const emb = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
  assert.equal(emb.ok, true);

  const result = PlanarGraphUtils.triangulateByFaceStellation(
    graph,
    emb,
    emb.outerFace,
    { triangulateOuterFace: true }
  );
  assert.equal(result.ok, true, result.reason || 'triangulation failed');
  for (const face of result.embedding.faces) {
    assert.equal(face.length, 3);
  }
});

test('canonical ordering works on random planar non-3-tree graph', () => {
  const text = Generator.planarStellationGraph(80, 10, 42);
  const graph = parseEdgeListText(text);
  const result = FPP.computeFPPPositions(graph);
  const prepared = result.prepared;
  const canonical = result.canonical;
  assert.equal(result.ok, true, result.message || result.reason || 'FPP compute failed on random non-3-tree');
  assert.equal(prepared.ok, true);
  assert.equal(canonical.ok, true, canonical.reason || 'canonical ordering failed on random non-3-tree');
  assert.equal(canonical.order.length, prepared.embedding.idByIndex.length);
  assert.equal(new Set(canonical.order).size, canonical.order.length);
});

test('ReweightTutte keeps augmented outer-face coordinates fixed across iterations', async () => {
  const text = Generator.planarStellationGraph(40, 8, 7);
  const graph = parseEdgeListText(text);
  const prepared = LayoutPreprocessing.prepareGraphAndLayoutData(graph, {
    failureLabel: 'ReweightTutte'
  });
  assert.equal(prepared && prepared.ok, true, prepared && prepared.message ? prepared.message : 'ReweightTutte setup failed');

  const outer = prepared.augmentedOuterFace.slice();
  const snapshots = [];
  const result = await Reweight.computeReweightTuttePositions(graph, {
    onIteration(step) {
      assert.deepEqual(step.debug.outerFace, outer);
      const snap = {};
      for (const v of outer) {
        const p = step.positions[v];
        snap[v] = { x: p.x, y: p.y };
      }
      snapshots.push(snap);
    }
  });

  assert.equal(result.ok, true, result.message || 'Reweight failed');
  assert.deepEqual(result.outerFace, outer);
  assert.ok(snapshots.length >= 2, 'expected multiple iterations');

  const first = snapshots[0];
  for (let i = 1; i < snapshots.length; i += 1) {
    for (const v of outer) {
      const a = first[v];
      const b = snapshots[i][v];
      assert.ok(Math.abs(a.x - b.x) < 1e-9, `outer x moved for vertex ${v}`);
      assert.ok(Math.abs(a.y - b.y) < 1e-9, `outer y moved for vertex ${v}`);
    }
  }
});

test('ReweightTutte preserves the shared augmented outer-face seed coordinates', async () => {
  const text = Generator.planarStellationGraph(40, 8, 7);
  const graph = parseEdgeListText(text);
  const prepared = LayoutPreprocessing.prepareGraphAndLayoutData(graph, {
    failureLabel: 'ReweightTutte'
  });
  assert.equal(prepared && prepared.ok, true, prepared && prepared.message ? prepared.message : 'ReweightTutte setup failed');

  const outer = prepared.augmentedOuterFace.slice();
  const reweight = await Reweight.computeReweightTuttePositions(graph, {});
  assert.equal(reweight.ok, true, reweight.message || 'Reweight failed');
  assert.deepEqual(reweight.outerFace, outer);
  assert.ok(reweight.debugPositions, 'expected ReweightTutte to expose augmented coordinates via debugPositions');

  for (const v of outer) {
    const seedPos = prepared.posById[v];
    const finalPos = reweight.debugPositions[v];
    assert.ok(Math.abs(seedPos.x - finalPos.x) < 1e-9, `outer x mismatch for vertex ${v}`);
    assert.ok(Math.abs(seedPos.y - finalPos.y) < 1e-9, `outer y mismatch for vertex ${v}`);
  }
});

test('Air outer-ring face weight changes the outer-cycle solve without changing target areas', async () => {
  const graph = {
    nodeIds: ['a', 'b', 'c', 'd', 'e'],
    edgePairs: [['a', 'b'], ['b', 'c'], ['c', 'a'], ['b', 'd'], ['d', 'e'], ['e', 'b']]
  };
  const pos = {
    a: { x: 0, y: 0 },
    b: { x: 1, y: 1 },
    c: { x: 0, y: 2 },
    d: { x: 3, y: 2 },
    e: { x: 3, y: 0 }
  };

  const baseline = await Air.computeAirPositions(graph, {
    augmentationMethod: 'outer-cycle',
    currentPositions: pos,
    outerRingFaceWeight: 1
  });
  const reduced = await Air.computeAirPositions(graph, {
    augmentationMethod: 'outer-cycle',
    currentPositions: pos,
    outerRingFaceWeight: 0
  });

  assert.equal(baseline && baseline.ok, true, baseline && baseline.message ? baseline.message : 'baseline Air solve failed');
  assert.equal(reduced && reduced.ok, true, reduced && reduced.message ? reduced.message : 'reweighted Air solve failed');
  assert.equal(hasEdgeCrossing(graph.nodeIds, graph.edgePairs, GeometryUtils.filterPositionMap(baseline.positions, graph.nodeIds)), false);
  assert.equal(hasEdgeCrossing(graph.nodeIds, graph.edgePairs, GeometryUtils.filterPositionMap(reduced.positions, graph.nodeIds)), false);
  assert.notEqual(
    JSON.stringify(GeometryUtils.filterPositionMap(baseline.positions, graph.nodeIds)),
    JSON.stringify(GeometryUtils.filterPositionMap(reduced.positions, graph.nodeIds))
  );
});

test('FaceBalancer awaits async iteration callbacks sequentially', async () => {
  const graph = {
    nodeIds: ['a', 'b', 'c', 'd'],
    edgePairs: [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a'], ['a', 'c']]
  };
  let activeCallbacks = 0;
  let maxActiveCallbacks = 0;
  let callbackCount = 0;

  const result = await FaceBalancer.computeFaceBalancerPositions(graph, {
    maxIters: 5,
    onIteration: async function () {
      activeCallbacks += 1;
      callbackCount += 1;
      if (activeCallbacks > maxActiveCallbacks) {
        maxActiveCallbacks = activeCallbacks;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      activeCallbacks -= 1;
    }
  });

  assert.equal(result && result.ok, true, result && result.message ? result.message : 'FaceBalancer failed');
  assert.ok(callbackCount > 0, 'expected FaceBalancer to emit progress callbacks');
  assert.equal(maxActiveCallbacks, 1, 'FaceBalancer progress callbacks should not overlap');
});

test('EdgeBalancer respects the maxPositionStep cap during optimization', async () => {
  const text = Generator.getSample('sample1');
  const graph = parseEdgeListText(text);
  const baseline = await Tutte.computeTutteLayout(graph, {
    augmentationMethod: 'outer-cycle'
  });
  assert.equal(baseline && baseline.ok, true, baseline && (baseline.message || baseline.reason || 'Tutte failed on sample1'));

  const stepCap = 5;
  let callbackCount = 0;
  let observedMaxMove = 0;
  const result = await EdgeBalancer.computeEdgeBalancerPositions(graph, {
    augmentationMethod: 'outer-cycle',
    currentPositions: baseline.positions,
    maxIters: 12,
    maxPositionStep: stepCap,
    onIteration: async function (progress) {
      callbackCount += 1;
      if (Number.isFinite(progress.maxMove) && progress.maxMove > observedMaxMove) {
        observedMaxMove = progress.maxMove;
      }
    }
  });

  assert.equal(result && result.ok, true, result && (result.message || result.reason || 'EdgeBalancer failed with step cap'));
  assert.ok(callbackCount > 0, 'expected EdgeBalancer to emit progress with a step cap');
  assert.ok(observedMaxMove <= stepCap + 1e-6, `EdgeBalancer exceeded maxPositionStep: cap=${stepCap}, observed=${observedMaxMove}`);
});

test('AngleBalancer keeps augmented barrier coordinates available on sample1', async () => {
  const text = Generator.getSample('sample1');
  const parsed = parseEdgeListText(text);
  const graph = GraphUtils.createGraph(parsed.nodeIds, parsed.edgePairs);
  const currentPositions = parseVertexPositionsFromEdgeList(text);
  const prepared = LayoutPreprocessing.prepareGraphAndLayoutData(graph, {
    failureLabel: 'AngleBalancer test',
    currentPositions
  });
  assert.equal(prepared && prepared.ok, true, prepared && (prepared.message || prepared.reason || 'AngleBalancer seed preparation failed'));
  const seedPositions = {};
  for (const id of graph.nodeIds) {
    seedPositions[String(id)] = prepared.posById[String(id)];
  }
  const result = await AngleBalancer.computeAngleBalancerPositions(graph, {
    currentPositions
  });
  const finalScore = Metrics.computeAngularResolutionScore(graph, result.positions);

  assert.equal(result && result.ok, true, result && (result.message || result.reason || 'AngleBalancer failed on sample1'));
  assert.equal(Number.isFinite(result.objective), true, 'AngleBalancer should report a finite objective on sample1');
  assert.equal(finalScore && finalScore.ok, true, 'expected a valid angle-resolution score for the AngleBalancer result');
  assert.ok(result.debugPositions && Object.keys(result.debugPositions).length > graph.nodeIds.length,
    'expected AngleBalancer debugPositions to retain augmented dummy coordinates');
});

test('Hybrid can return a staged candidate on sample1', async () => {
  const text = Generator.getSample('sample1');
  const parsed = parseEdgeListText(text);
  const graph = GraphUtils.createGraph(parsed.nodeIds, parsed.edgePairs);
  const currentPositions = parseVertexPositionsFromEdgeList(text);
  let lastProgress = null;
  const hybridResult = await Hybrid.computeHybridPositions(graph, {
    currentPositions,
    onIteration: async function (progress) {
      lastProgress = progress;
    }
  });
  assert.equal(hybridResult && hybridResult.ok, true, hybridResult && (hybridResult.message || hybridResult.reason || 'Hybrid failed on sample1'));
  assert.ok(lastProgress, 'expected Hybrid to emit progress on sample1');
  assert.equal(lastProgress.stage, 'angle', 'expected Hybrid to finish with angle-stage progress on sample1');
  assert.ok(Number.isFinite(hybridResult.faceAreaScore), 'expected Hybrid face score on sample1');
  assert.ok(Number.isFinite(hybridResult.angleResolutionScore), 'expected Hybrid angle score on sample1');
  assert.ok(Number.isFinite(hybridResult.tradeoffScore), 'expected Hybrid tradeoff score on sample1');
});

test('EdgeBalancer awaits async iteration callbacks sequentially', async () => {
  const graph = {
    nodeIds: ['a', 'b', 'c', 'd'],
    edgePairs: [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a'], ['a', 'c']]
  };
  let activeCallbacks = 0;
  let maxActiveCallbacks = 0;
  let callbackCount = 0;

  const result = await EdgeBalancer.computeEdgeBalancerPositions(graph, {
    maxIters: 5,
    onIteration: async function () {
      activeCallbacks += 1;
      callbackCount += 1;
      if (activeCallbacks > maxActiveCallbacks) {
        maxActiveCallbacks = activeCallbacks;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      activeCallbacks -= 1;
    }
  });

  assert.equal(result && result.ok, true, result && result.message ? result.message : 'EdgeBalancer failed');
  assert.ok(callbackCount > 0, 'expected EdgeBalancer to emit progress callbacks');
  assert.equal(maxActiveCallbacks, 1, 'EdgeBalancer progress callbacks should not overlap');
});

test('Tutte rejects graphs with fewer than 3 vertices', async () => {
  const graph = {
    nodeIds: ['a', 'b'],
    edgePairs: [['a', 'b']]
  };
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);
  const result = await Tutte.applyTutteLayout(cy, {});
  assert.equal(result.ok, false);
  assert.match(String(result.message || ''), /at least 3 vertices/i);
});

test('Tutte uses graph preparation in the runtime', async () => {
  const originalRunLayout = CyRuntime.runLayout;
  const cy = buildMockCy(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'a']]);
  let capturedSpec = null;
  CyRuntime.runLayout = function (_cy, _options, spec) {
    capturedSpec = spec;
    return Promise.resolve({ ok: true, message: 'ok' });
  };
  try {
    const result = await Tutte.applyTutteLayout(cy, {});
    assert.equal(result && result.ok, true);
    assert.ok(capturedSpec, 'expected Tutte to call CyRuntime.runLayout');
    assert.equal(capturedSpec.prepareMode, 'graph');
    assert.equal(capturedSpec.prepareFailureLabel, 'Tutte layout');
  } finally {
    CyRuntime.runLayout = originalRunLayout;
  }
});

test('CEG23-bfs uses graph+layout preparation in the runtime', async () => {
  const originalRunLayout = CyRuntime.runLayout;
  const cy = buildMockCy(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'a']]);
  let capturedSpec = null;
  CyRuntime.runLayout = function (_cy, _options, spec) {
    capturedSpec = spec;
    return Promise.resolve({ ok: true, message: 'ok' });
  };
  try {
    const result = await CEG23Bfs.applyCEG23BfsLayout(cy, {});
    assert.equal(result && result.ok, true);
    assert.ok(capturedSpec, 'expected CEG23-bfs to call CyRuntime.runLayout');
    assert.equal(capturedSpec.prepareMode, 'graph+layout');
    assert.equal(capturedSpec.prepareFailureLabel, 'CEG23-bfs layout');
  } finally {
    CyRuntime.runLayout = originalRunLayout;
  }
});

test('Schnyder uses graph preparation in the runtime', async () => {
  const originalRunLayout = CyRuntime.runLayout;
  const cy = buildMockCy(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'a']]);
  let capturedSpec = null;
  CyRuntime.runLayout = function (_cy, _options, spec) {
    capturedSpec = spec;
    return Promise.resolve({ ok: true, message: 'ok' });
  };
  try {
    const result = await Schnyder.applySchnyderLayout(cy, {});
    assert.equal(result && result.ok, true);
    assert.ok(capturedSpec, 'expected Schnyder to call CyRuntime.runLayout');
    assert.equal(capturedSpec.prepareMode, 'graph');
    assert.equal(capturedSpec.prepareFailureLabel, 'Schnyder layout');
  } finally {
    CyRuntime.runLayout = originalRunLayout;
  }
});

test('ImPrEd uses graph preparation in the runtime', async () => {
  const originalRunLayout = CyRuntime.runLayout;
  const cy = buildMockCy(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'a']]);
  let capturedSpec = null;
  CyRuntime.runLayout = function (_cy, _options, spec) {
    capturedSpec = spec;
    return Promise.resolve({ ok: true, message: 'ok' });
  };
  try {
    const result = await ImPrEd.applyImPrEdLayout(cy, {});
    assert.equal(result && result.ok, true);
    assert.ok(capturedSpec, 'expected ImPrEd to call CyRuntime.runLayout');
    assert.equal(capturedSpec.prepareMode, 'graph');
    assert.equal(capturedSpec.prepareFailureLabel, 'ImPrEd layout');
  } finally {
    CyRuntime.runLayout = originalRunLayout;
  }
});

test('FPP uses graph preparation with outer-face triangulation in the runtime', async () => {
  const originalRunLayout = CyRuntime.runLayout;
  const cy = buildMockCy(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'a']]);
  let capturedSpec = null;
  CyRuntime.runLayout = function (_cy, _options, spec) {
    capturedSpec = spec;
    return Promise.resolve({ ok: true, message: 'ok' });
  };
  try {
    const result = await FPP.applyFPPLayout(cy, {});
    assert.equal(result && result.ok, true);
    assert.ok(capturedSpec, 'expected FPP to call CyRuntime.runLayout');
    assert.equal(capturedSpec.prepareMode, 'graph');
    assert.equal(capturedSpec.prepareFailureLabel, 'FPP');
    assert.deepEqual(
      JSON.parse(JSON.stringify(capturedSpec.prepareOptions || null)),
      { augmentationOptions: { triangulateOuterFace: true } }
    );
  } finally {
    CyRuntime.runLayout = originalRunLayout;
  }
});

test('3-connectivity helpers distinguish strict and internal 3-connectivity', () => {
  const graph = GraphUtils.createGraph(
    ['1', '2', '3', '4'],
    [['1', '2'], ['2', '3'], ['3', '4'], ['4', '1']]
  );

  const strict = GraphUtils.analyzeThreeConnectivity(graph);
  assert.equal(strict.ok, false);
  assert.match(String(strict.reason || ''), /3-connected/i);

  const internal = GraphUtils.analyzeInternallyThreeConnected(graph, ['1', '2', '3', '4']);
  assert.equal(internal.ok, true, internal.reason || 'cycle should be internally 3-connected with its outer cycle');
});

test('Tutte uses the common outer face and succeeds on grid2x10 after augmentation', async () => {
  const text = Generator.getSample('grid2x10');
  const graph = parseEdgeListText(text);
  const embedding = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
  const outer = PlanarGraphUtils.chooseOuterFaceFromEmbedding(embedding);
  assert.equal(Array.isArray(outer), true);
  assert.equal(outer.length, 4);
  assert.equal(GraphUtils.analyzeInternallyThreeConnected(graph, outer).ok, false);

  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const result = await Tutte.applyTutteLayout(cy, {});
  assert.equal(result.ok, true, result.message || 'Tutte should succeed on grid2x10 after augmentation');
});
