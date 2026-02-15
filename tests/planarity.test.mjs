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
    'static/js/planarity-test.js'
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
const Planarity = modules.PlanarVibePlanarityTest;

test('sample3 (K3,3) is non-planar', () => {
  const text = Generator.getSample('sample3');
  const graph = parseEdgeListText(text);
  const emb = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
  assert.equal(emb.ok, false);
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

test('maximal planar 3-tree generator returns planar 3-tree', () => {
  const text = Generator.maximalPlanar3Tree(30);
  const graph = parseEdgeListText(text);

  const emb = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
  assert.equal(emb.ok, true);
  assert.equal(emb.idByIndex.length, 30);

  const is3Tree = Planarity.isPlanar3Tree(graph.nodeIds, graph.edgePairs);
  assert.equal(is3Tree, true);

  const analysis = Planarity.analyzePlanar3Tree(graph.nodeIds, graph.edgePairs);
  assert.equal(analysis.ok, true);
  assert.equal(analysis.outerFace.length, 3);
  assert.equal(analysis.elimination.length, 27);
});

test('cycle graph is planar but not planar 3-tree', () => {
  const text = Generator.cycleGraph(8);
  const graph = parseEdgeListText(text);
  assert.equal(Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs).ok, true);
  assert.equal(Planarity.isPlanar3Tree(graph.nodeIds, graph.edgePairs), false);
});

test('wheel graph W7 is planar and not planar 3-tree', () => {
  const text = Generator.wheelGraph(7);
  const graph = parseEdgeListText(text);
  assert.equal(Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs).ok, true);
  assert.equal(Planarity.isPlanar3Tree(graph.nodeIds, graph.edgePairs), false);
});
