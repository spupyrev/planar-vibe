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
        nodes.add(String(parts[1]));
      }
      continue;
    }
    if (parts.length < 2) {
      continue;
    }
    const a = String(parts[0]);
    const b = String(parts[1]);
    if (a === b) {
      continue;
    }
    nodes.add(a);
    nodes.add(b);
    const key = a < b ? `${a}::${b}` : `${b}::${a}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
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
    Number,
    Promise
  });

  const files = [
    'static/js/planarity-test.js',
    'static/js/metrics.js',
    'static/js/linear-algebra.js',
    'static/js/geometry-utils.js',
    'static/js/planar-graph-utils.js',
    'static/js/graph-utils.js',
    'static/js/graph-generator.js',
    'static/js/layout-preprocessing.js',
    'static/js/cy-runtime.js',
    'static/js/layout-tutte.js',
    'static/js/layout-air.js',
    'static/js/layout-ppag.js',
    'static/js/layout-facebalancer.js',
    'static/js/layout-edgebalancer.js',
    'static/js/layout-reweight.js',
    'static/js/layout-fd-uniform.js'
  ];

  for (const rel of files) {
    const abs = path.resolve(process.cwd(), rel);
    const code = fs.readFileSync(abs, 'utf8');
    new vm.Script(code, { filename: rel }).runInContext(context);
  }

  return window;
}

function nowNs() {
  return process.hrtime.bigint();
}

function nsToMs(ns) {
  return Number(ns) / 1e6;
}

async function measureAsync(fn) {
  const start = nowNs();
  const value = await fn();
  return {
    value,
    ms: nsToMs(nowNs() - start)
  };
}

function projectOriginalPositions(GraphUtils, graph, result) {
  return modules.GeometryUtils.filterPositionMap((result && (result.positions || result.posById)) || {}, graph.nodeIds);
}

function validateSeedContext(modules, graph, outerFace, context) {
  const GraphUtils = modules.GraphUtils;
  const PlanarGraphUtils = modules.PlanarGraphUtils;
  const embedding = context && context.augmented ? context.augmented.embedding : null;
  if (!embedding || !embedding.ok) {
    return { ok: false, message: 'Barycentric initialization requires a planar embedding' };
  }
  if (!PlanarGraphUtils.embeddingHasFace(embedding, outerFace)) {
    return { ok: false, message: 'Provided outer face is not a face of the embedding' };
  }
  const connectivity = GraphUtils.analyzeInternallyThreeConnected(graph, outerFace);
  if (!connectivity || !connectivity.ok) {
    return {
      ok: false,
      message: (connectivity && connectivity.reason) || 'Barycentric layout requires an internally 3-connected planar graph'
    };
  }
  return { ok: true };
}

function computeIterativeSeedForBenchmark(modules, graph, outerFace, context, options) {
  const validation = validateSeedContext(modules, graph, outerFace, context);
  if (!validation.ok) {
    return validation;
  }
  const Tutte = modules.PlanarVibeTutte;
  const weights = Tutte.buildTutteWeights(
    context && context.graph ? context.graph : graph,
    graph
  );
  return Tutte.computeBarycentricPositions(
    graph,
    outerFace,
    {
      weights,
      initOptions: Tutte.defaultOuterPlacementOptions({ useSeedOuter: false })
    }
  );
}

function computeExactSeedForBenchmark(modules, graph, outerFace, context) {
  const validation = validateSeedContext(modules, graph, outerFace, context);
  if (!validation.ok) {
    return validation;
  }
  return modules.LayoutPreprocessing.computeInitialPositions(
    graph,
    outerFace,
    context && context.augmented ? context.augmented.embedding : null
  );
}

function buildPreparedContext(modules, graph, cfg, seedName, iterativeOptions) {
  const LayoutPreprocessing = modules.LayoutPreprocessing;
  const GraphUtils = modules.GraphUtils;
  const prepared = LayoutPreprocessing.prepareGraphData(graph, cfg);
  if (!prepared || !prepared.ok) {
    return prepared || { ok: false, message: 'prepareGraphData failed' };
  }

  const seedHelper = seedName === 'exact'
    ? computeExactSeedForBenchmark
    : computeIterativeSeedForBenchmark;

  const init = seedHelper(
    modules,
    prepared.augmentedGraph,
    prepared.augmentedOuterFace,
    {
      graph: prepared.graph,
      baseEmbedding: prepared.baseEmbedding,
      augmented: prepared.augmented,
      outerFace: prepared.outerFace,
      config: cfg
    },
    iterativeOptions
  );
  if (!init || !init.ok || !init.positions) {
    return init || { ok: false, message: 'seed initializer failed' };
  }

  return {
    ok: true,
    graph: prepared.graph,
    baseEmbedding: prepared.baseEmbedding,
    outerFace: prepared.outerFace,
    augmented: prepared.augmented,
    augmentedGraph: prepared.augmentedGraph,
    posById: modules.GeometryUtils.alignOuterFaceEdgeHorizontally(init.positions, prepared.augmentedOuterFace),
    movableVertices: GraphUtils.collectMovableVertices(prepared.augmented.graph.nodeIds, prepared.augmentedOuterFace),
    initResult: init
  };
}

async function withSeedMethod(modules, seedName, fn) {
  const LayoutPreprocessing = modules.LayoutPreprocessing;
  const original = LayoutPreprocessing.prepareGraphAndLayoutData;
  LayoutPreprocessing.prepareGraphAndLayoutData = function patchedPrepareGraphAndLayoutData(graph, config) {
    return buildPreparedContext(modules, graph, config || {}, seedName);
  };
  try {
    return await fn();
  } finally {
    LayoutPreprocessing.prepareGraphAndLayoutData = original;
  }
}

function average(rows, key) {
  if (!rows.length) {
    return null;
  }
  let total = 0;
  let count = 0;
  for (const row of rows) {
    if (Number.isFinite(row[key])) {
      total += row[key];
      count += 1;
    }
  }
  return count > 0 ? total / count : null;
}

function summarizeBy(rows, groupKeys) {
  const groups = new Map();
  for (const row of rows) {
    const key = groupKeys.map((k) => row[k]).join('||');
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(row);
  }

  const out = [];
  for (const rowsInGroup of groups.values()) {
    const sample = rowsInGroup[0];
    const summary = {};
    for (const key of groupKeys) {
      summary[key] = sample[key];
    }
    summary.runs = rowsInGroup.length;
    summary.successes = rowsInGroup.filter((row) => row.ok).length;
    summary.avgMs = average(rowsInGroup, 'ms');
    summary.avgFaceScore = average(rowsInGroup.filter((row) => row.ok), 'faceScore');
    summary.avgIters = average(rowsInGroup.filter((row) => row.ok), 'iters');
    out.push(summary);
  }
  out.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return out;
}

async function main() {
  const modules = loadBrowserModules();
  const GraphUtils = modules.GraphUtils;
  const Metrics = modules.PlanarVibeMetrics;
  const Generator = modules.PlanarVibeGraphGenerator;
  const Air = modules.PlanarVibeAir;
  const PPAG = modules.PlanarVibePPAG;
  const FaceBalancer = modules.PlanarVibeFaceBalancer;
  const EdgeBalancer = modules.PlanarVibeEdgeBalancer;
  const Reweight = modules.PlanarVibeReweightTutte;
  const FDUniform = modules.PlanarVibeFDUniform;

  const graphNames = ['sample1', 'grid4x20', 'randomplanar2', 'randomplanar4', 'planar3tree30'];
  const graphs = graphNames.map((name) => ({
    name,
    ...parseEdgeListText(Generator.getSample(name))
  }));

  const seedBenchConfig = {
    failureLabel: 'Benchmark seed'
  };
  const iterativeSeedOptions = {
    maxIters: 2000,
    tolerance: 1e-8
  };

  const layoutBenchmarks = [
    {
      name: 'Air',
      run: (graph) => Air.computeAirPositions(graph, {
        maxSweeps: 80,
        delayMs: 0,
        yieldEvery: 50,
        renderEvery: 100
      })
    },
    {
      name: 'PPAG',
      run: (graph) => PPAG.computePPAGPositions(graph, {
        maxIters: 120,
        delayMs: 0,
        yieldEvery: 50,
        renderEvery: 100
      })
    },
    {
      name: 'FaceBalancer',
      run: (graph) => FaceBalancer.computeFaceBalancerPositions(graph, {
        maxIters: 30,
        delayMs: 0
      })
    },
    {
      name: 'EdgeBalancer',
      run: (graph) => EdgeBalancer.computeEdgeBalancerPositions(graph, {
        maxIters: 30,
        delayMs: 0
      })
    },
    {
      name: 'ReweightTutte',
      run: (graph) => Reweight.computeReweightTuttePositions(graph, {
        maxOuterIters: 6,
        warmIters: 1200,
        innerIters: 1600,
        finalIters: 1600,
        delayMs: 0
      })
    },
    {
      name: 'FD-uniform',
      run: (graph) => FDUniform.computeFDUniformPositions(graph, {
        maxIters: 120,
        delayMs: 0
      })
    }
  ];

  const seedRows = [];
  for (const graph of graphs) {
    for (const seedName of ['iterative', 'exact']) {
      const measured = await measureAsync(async () => buildPreparedContext(modules, graph, seedBenchConfig, seedName, iterativeSeedOptions));
      const result = measured.value;
      const posById = result && result.ok ? modules.GeometryUtils.filterPositionMap(result.posById || {}, graph.nodeIds) : null;
      const face = posById ? Metrics.computeUniformFaceAreaScore(graph.nodeIds, graph.edgePairs, posById) : null;
      seedRows.push({
        graph: graph.name,
        seed: seedName,
        ok: !!(result && result.ok),
        ms: measured.ms,
        faceScore: face && face.ok ? face.quality : null,
        iters: result && result.initResult && Number.isFinite(result.initResult.iters) ? result.initResult.iters : null,
        crossings: posById ? Metrics.hasCrossingsFromPositions(posById, graph.edgePairs) : null
      });
    }
  }

  const layoutRows = [];
  for (const graph of graphs) {
    for (const seedName of ['iterative', 'exact']) {
      for (const layout of layoutBenchmarks) {
        const measured = await measureAsync(async () => withSeedMethod(modules, seedName, async () => layout.run(graph)));
        const result = measured.value;
        const posById = result && result.ok ? projectOriginalPositions(GraphUtils, graph, result) : null;
        const face = posById ? Metrics.computeUniformFaceAreaScore(graph.nodeIds, graph.edgePairs, posById) : null;
        layoutRows.push({
          graph: graph.name,
          seed: seedName,
          layout: layout.name,
          ok: !!(result && result.ok),
          ms: measured.ms,
          faceScore: face && face.ok ? face.quality : null,
          iters: result && Number.isFinite(result.iters) ? result.iters : null,
          crossings: posById ? Metrics.hasCrossingsFromPositions(posById, graph.edgePairs) : null,
          message: result && (result.message || result.reason || result.status || result.stopReason || null)
        });
      }
    }
  }

  const report = {
    seedPerGraph: seedRows,
    seedSummary: summarizeBy(seedRows, ['seed']),
    layoutPerRun: layoutRows,
    layoutSummary: summarizeBy(layoutRows, ['seed', 'layout'])
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
