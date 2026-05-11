import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { Worker } from 'node:worker_threads';

import { loadGraphs } from './apply-layout-js.mjs';

const DEFAULT_DATASET = 'benchmark/planar_all.dot';
const DEFAULT_PREVIOUS = '/tmp/claude-policy-actual-planar-all-top100.json';
const DEFAULT_OUTPUT = '/tmp/claude-phase-trace.json';
const DEFAULT_CONCURRENCY = 6;

const METRIC_KEYS = [
  'angularResolution',
  'aspectRatio',
  'convexity',
  'edgeLengthDeviation',
  'edgeRatio',
  'edgeOrthogonality',
  'face',
  'nodeUniformity',
  'alignment',
  'spacing'
];

const BROWSER_MODULE_FILES = [
  'static/js/graph-generator.js',
  'static/js/planarvibe-plugin.js',
  'static/js/linear-algebra.js',
  'static/js/geometry-utils.js',
  'static/js/planar-graph-utils.js',
  'static/js/graph-utils.js',
  'static/js/planarity-test.js',
  'static/js/metrics.js',
  'static/js/rotation.js',
  'static/js/alignment.js',
  'static/js/layout-preprocessing.js',
  'static/js/cy-runtime.js',
  'static/js/layout-tutte.js',
  'static/js/layout-random.js',
  'static/js/layout-air.js',
  'static/js/layout-areagrad.js',
  'static/js/layout-facebalancer.js',
  'static/js/layout-edgebalancer.js',
  'static/js/layout-anglebalancer.js',
  'static/js/layout-fabalancer.js',
  'static/js/layout-gpt.js',
  'static/js/layout-claude.js',
  'static/js/layout-reweight.js',
  'static/js/layout-forcedir.js',
  'static/js/layout-impred.js',
  'static/js/layout-fpp.js',
  'static/js/layout-schnyder.js',
  'static/js/layout-ceg.js',
  'static/js/layout-p3t.js'
];

function parseArgs(argv) {
  const opts = {
    dataset: DEFAULT_DATASET,
    previous: DEFAULT_PREVIOUS,
    output: DEFAULT_OUTPUT,
    top: 100,
    graphs: null,
    concurrency: DEFAULT_CONCURRENCY,
    policy: 'current'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dataset' && i + 1 < argv.length) opts.dataset = String(argv[++i]);
    else if (arg === '--previous' && i + 1 < argv.length) opts.previous = String(argv[++i]);
    else if (arg === '--output' && i + 1 < argv.length) opts.output = String(argv[++i]);
    else if (arg === '--top' && i + 1 < argv.length) opts.top = Math.max(1, Math.floor(Number(argv[++i]) || 0));
    else if (arg === '--graphs' && i + 1 < argv.length) opts.graphs = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--concurrency' && i + 1 < argv.length) opts.concurrency = Math.max(1, Math.floor(Number(argv[++i]) || 0));
    else if (arg === '--policy' && i + 1 < argv.length) opts.policy = String(argv[++i]).trim();
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: node scripts/trace-claude-phases.mjs [--dataset benchmark/planar_all.dot] ' +
        '[--previous /tmp/claude-policy-actual-planar-all-top100.json] [--top 100] ' +
        '[--graphs g1,g2] [--policy current|full|no-late-skip|no-area|base-top2|base-top3|base-top3-large300|no-area-reweight|no-area-rot9-large300|rot9-no-area|rot6|rot4|rot6-no-area|rot6-core] [--output /tmp/claude-phase-trace.json]\n'
      );
      process.exit(0);
    }
  }
  return opts;
}

function replaceOnce(source, needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`Could not instrument Claude source at ${label}`);
  return source.replace(needle, replacement);
}

function instrumentClaudeSource(source, policy) {
  let code = source;
  if (policy === 'full') {
    code = code.replace('var USE_SIZE_DRIVEN_CANDIDATE_POLICY = true;', 'var USE_SIZE_DRIVEN_CANDIDATE_POLICY = false;');
    code = code.replace('var ENABLE_AREAGRAD_CANDIDATE = false;', 'var ENABLE_AREAGRAD_CANDIDATE = true;');
  } else if (policy === 'no-late-skip') {
    code = code.replace('var LATE_FALLBACK_SKIP_MIN_GRAPH_SIZE = 150;', 'var LATE_FALLBACK_SKIP_MIN_GRAPH_SIZE = Infinity;');
  }
  if (policy === 'base-top2' || policy === 'base-top3' || policy === 'base-top3-large300') {
    code = code.replace('var USE_BASE_RANKED_EXPANSION_POLICY = false;', 'var USE_BASE_RANKED_EXPANSION_POLICY = true;');
    code = code.replace('var BASE_RANKED_EXPANSION_TOP_K = 3;', `var BASE_RANKED_EXPANSION_TOP_K = ${policy === 'base-top2' ? 2 : 3};`);
    if (policy === 'base-top3-large300') {
      code = code.replace('var BASE_RANKED_EXPANSION_MIN_GRAPH_SIZE = 0;', 'var BASE_RANKED_EXPANSION_MIN_GRAPH_SIZE = 300;');
    }
  }
  if (policy === 'rot6' || policy === 'rot4' || policy === 'rot9-no-area' || policy === 'rot6-no-area' || policy === 'rot6-core') {
    var steps = policy === 'rot6' ? 6 : 4;
    if (policy === 'rot9-no-area') steps = 9;
    if (policy === 'rot6-no-area' || policy === 'rot6-core') steps = 6;
    code = code.replaceAll('for (var i = 0; i <= 18; i += 1) {', `for (var i = 0; i <= ${steps}; i += 1) {`);
    code = code.replaceAll('var theta = (i / 18) * (Math.PI / 2);', `var theta = (i / ${steps}) * (Math.PI / 2);`);
  }
  if (policy === 'no-area-rot9-large300') {
    code = code.replace(
      `    for (var i = 0; i <= 18; i += 1) {\n` +
      `      var theta = (i / 18) * (Math.PI / 2);\n`,
      `    var __rotSteps = (nodeIds.length + edgePairs.length > 300) ? 9 : 18;\n` +
      `    for (var i = 0; i <= __rotSteps; i += 1) {\n` +
      `      var theta = (i / __rotSteps) * (Math.PI / 2);\n`
    );
    code = code.replace(
      `    for (var i = 0; i <= 18; i += 1) {\n` +
      `      var theta = (i / 18) * (Math.PI / 2);\n`,
      `    var __rotAlignSteps = (nodeIds.length + edgePairs.length > 300) ? 9 : 18;\n` +
      `    for (var i = 0; i <= __rotAlignSteps; i += 1) {\n` +
      `      var theta = (i / __rotAlignSteps) * (Math.PI / 2);\n`
    );
  }
  if (policy === 'no-area' || policy === 'no-area-reweight' || policy === 'no-area-rot9-large300' || policy === 'rot9-no-area' || policy === 'rot6-no-area' || policy === 'rot6-core') {
    code = code.replace(
      `    if (hasComputeInterface(global.PlanarVibeAreaGrad)) {\n` +
      `      runners.push(['AreaGrad', function () { return runModuleCandidate(global.PlanarVibeAreaGrad, graph, runtime); }]);\n` +
      `    }\n`,
      `    if (false && hasComputeInterface(global.PlanarVibeAreaGrad)) {\n` +
      `      runners.push(['AreaGrad', function () { return runModuleCandidate(global.PlanarVibeAreaGrad, graph, runtime); }]);\n` +
      `    }\n`
    );
  }
  if (policy === 'rot6-core') {
    code = code.replace(`    maybePushBalancer('FABalancer', global.PlanarVibeFABalancer);\n`, `    if (false) maybePushBalancer('FABalancer', global.PlanarVibeFABalancer);\n`);
    code = code.replace(`    maybePushBalancer('AngleBalancer', global.PlanarVibeAngleBalancer);\n`, `    if (false) maybePushBalancer('AngleBalancer', global.PlanarVibeAngleBalancer);\n`);
    code = code.replace(`    maybePushBalancer('FaceBalancer', global.PlanarVibeFaceBalancer);\n`, `    if (false) maybePushBalancer('FaceBalancer', global.PlanarVibeFaceBalancer);\n`);
  }
  if (policy === 'no-area-reweight') {
    code = code.replace(
      `    if (hasComputeInterface(global.PlanarVibeReweight)) {\n` +
      `      runners.push(['Reweight', function () { return runModuleCandidate(global.PlanarVibeReweight, graph, runtime); }]);\n` +
      `    }\n`,
      `    if (false && hasComputeInterface(global.PlanarVibeReweight)) {\n` +
      `      runners.push(['Reweight', function () { return runModuleCandidate(global.PlanarVibeReweight, graph, runtime); }]);\n` +
      `    }\n`
    );
  }

  code = replaceOnce(
    code,
    "  'use strict';\n\n",
    `  'use strict';\n\n` +
      `  function __phaseNow() { return Date.now(); }\n` +
      `  function __phasePush(name, ms, extra) {\n` +
      `    if (global.__ClaudePhaseTrace && Array.isArray(global.__ClaudePhaseTrace.events)) {\n` +
      `      global.__ClaudePhaseTrace.events.push({ name: name, ms: ms, extra: extra || null });\n` +
      `    }\n` +
      `  }\n\n`,
    'phase helpers'
  );

  code = replaceOnce(
    code,
    `  function findBestRotationAndAlignment(nodeIds, edgePairs, posById, embedding) {\n` +
      `    var best = null;\n`,
    `  function findBestRotationAndAlignment(nodeIds, edgePairs, posById, embedding) {\n` +
      `    var __phaseT0 = __phaseNow();\n` +
      `    var best = null;\n`,
    'findBestRotationAndAlignment start'
  );
  code = replaceOnce(
    code,
    `    return best;\n` +
      `  }\n\n` +
      `  // Build node index`,
    `    __phasePush('findBestRotationAndAlignment', __phaseNow() - __phaseT0, null);\n` +
      `    return best;\n` +
      `  }\n\n` +
      `  // Build node index`,
    'findBestRotationAndAlignment end'
  );

  code = replaceOnce(
    code,
    `  function tryPolish(nodeIds, edgePairs, best, opts, tag) {\n` +
      `    opts = Object.assign({}, opts || {}, { embedding: best.embedding });\n` +
      `    var res = polishByLocalMoves(nodeIds, edgePairs, best.posById, opts);\n`,
    `  function tryPolish(nodeIds, edgePairs, best, opts, tag) {\n` +
      `    opts = Object.assign({}, opts || {}, { embedding: best.embedding });\n` +
      `    var __phaseT0 = __phaseNow();\n` +
      `    var res = polishByLocalMoves(nodeIds, edgePairs, best.posById, opts);\n` +
      `    __phasePush('tryPolish:' + tag, __phaseNow() - __phaseT0, { improved: res.scores.total > best.scores.total });\n`,
    'tryPolish'
  );

  code = replaceOnce(
    code,
    `    var runners = buildCandidateRunners(graph, opts, runtime);\n\n` +
      `    var variants = [];\n`,
    `    var __phaseBuildT0 = __phaseNow();\n` +
      `    var runners = buildCandidateRunners(graph, opts, runtime);\n` +
      `    __phasePush('buildCandidateRunners', __phaseNow() - __phaseBuildT0, { labels: runners.map(function (r) { return r[0]; }) });\n\n` +
      `    var variants = [];\n` +
      `    var __phaseCandidatesT0 = __phaseNow();\n`,
    'build runners'
  );

  code = replaceOnce(
    code,
    `      var label = runners[i][0];\n` +
      `      var out = await runners[i][1]();\n` +
      `      if (out.ok) {\n`,
    `      var label = runners[i][0];\n` +
      `      var __phaseCandidateT0 = __phaseNow();\n` +
      `      var out = await runners[i][1]();\n` +
      `      __phasePush('candidate:' + label, __phaseNow() - __phaseCandidateT0, { ok: !!(out && out.ok) });\n` +
      `      if (out.ok) {\n`,
    'candidate loop'
  );

  code = replaceOnce(
    code,
    `          var expanded = expandVariants(label, out.posById, out.embedding, nodeIds, edgePairs);\n`,
    `          var __phaseExpandT0 = __phaseNow();\n` +
      `          var expanded = expandVariants(label, out.posById, out.embedding, nodeIds, edgePairs);\n` +
      `          __phasePush('expand:' + label, __phaseNow() - __phaseExpandT0, { variants: expanded.length });\n`,
    'expandVariants'
  );

  code = replaceOnce(
    code,
    `    variants.sort(function (a, b) { return b.scores.total - a.scores.total; });\n`,
    `    __phasePush('candidateLoop', __phaseNow() - __phaseCandidatesT0, { variants: variants.length });\n` +
      `    variants.sort(function (a, b) { return b.scores.total - a.scores.total; });\n`,
    'candidateLoop end'
  );

  code = replaceOnce(
    code,
    `        var polished = polishByLocalMoves(nodeIds, edgePairs, startVar.posById, {\n` +
      `          embedding: startVar.embedding,\n` +
      `          maxPasses: polishPasses, stepScale: polishStep\n` +
      `        });\n`,
    `        var __phaseCoarseT0 = __phaseNow();\n` +
      `        var polished = polishByLocalMoves(nodeIds, edgePairs, startVar.posById, {\n` +
      `          embedding: startVar.embedding,\n` +
      `          maxPasses: polishPasses, stepScale: polishStep\n` +
      `        });\n` +
      `        __phasePush('coarsePolish', __phaseNow() - __phaseCoarseT0, { label: startVar.label, improved: polished.scores.total > best.scores.total });\n`,
    'coarse polish'
  );

  code = replaceOnce(
    code,
    `        var repaired = convexityRepair(nodeIds, edgePairs, best.posById, {\n` +
      `          embedding: best.embedding,\n` +
      `          maxPasses: 3\n` +
      `        });\n`,
    `        var __phaseCvxT0 = __phaseNow();\n` +
      `        var repaired = convexityRepair(nodeIds, edgePairs, best.posById, {\n` +
      `          embedding: best.embedding,\n` +
      `          maxPasses: 3\n` +
      `        });\n` +
      `        __phasePush('convexityRepair', __phaseNow() - __phaseCvxT0, { improved: repaired.scores.total > best.scores.total });\n`,
    'convexity repair'
  );

  code = replaceOnce(
    code,
    `            var res = restartPerturbAndPolish(nodeIds, edgePairs, best.posById, rng, {\n` +
      `              embedding: best.embedding,\n` +
      `              perturbScale: perturbScales[ri % perturbScales.length],\n` +
      `              maxPasses: 3, stepScale: 0.012\n` +
      `            });\n`,
    `            var __phaseRestartT0 = __phaseNow();\n` +
      `            var res = restartPerturbAndPolish(nodeIds, edgePairs, best.posById, rng, {\n` +
      `              embedding: best.embedding,\n` +
      `              perturbScale: perturbScales[ri % perturbScales.length],\n` +
      `              maxPasses: 3, stepScale: 0.012\n` +
      `            });\n` +
      `            __phasePush('restartPolish', __phaseNow() - __phaseRestartT0, { index: ri, improved: res.scores.total > best.scores.total });\n`,
    'restart polish'
  );

  code = replaceOnce(
    code,
    `    return {\n` +
      `      ok: true,\n`,
    `    __phasePush('computePositionsTotal', __phaseNow() - __phaseCandidatesT0 + 0, { best: best.label, score: best.scores.total });\n` +
      `    return {\n` +
      `      ok: true,\n`,
    'final'
  );

  return code;
}

function workerSource() {
  return `
    import fs from 'node:fs';
    import path from 'node:path';
    import vm from 'node:vm';
    import { parentPort, workerData } from 'node:worker_threads';
    import { pathToFileURL } from 'node:url';

    const root = workerData.root;
    const { loadGraphs } = await import(pathToFileURL(path.join(root, 'scripts/apply-layout-js.mjs')).href);
    const shared = await import(pathToFileURL(path.join(root, 'scripts/report-shared.mjs')).href);
    const { createAlgorithmSpecs, createMockCy, initializeMockCyPositions, positionsFromCy } = shared;
    const metricKeys = ${JSON.stringify(METRIC_KEYS)};
    const moduleFiles = ${JSON.stringify(BROWSER_MODULE_FILES)};
    const instrumentedClaude = workerData.instrumentedClaude;

    function metricValue(result, key) {
      if (!result || !result.ok) return null;
      if (key === 'edgeRatio') return result.ratio;
      if (key === 'face') return result.quality;
      return result.score;
    }

    function loadWindow() {
      const windowObj = { __ClaudePhaseTrace: { events: [] } };
      windowObj.window = windowObj;
      const context = vm.createContext({ window: windowObj, console, Math, Set, Map, Array, Object, String, Number, Promise, Date, setTimeout, clearTimeout });
      for (const rel of moduleFiles) {
        const code = rel === 'static/js/layout-claude.js' ? instrumentedClaude : fs.readFileSync(path.join(root, rel), 'utf8');
        new vm.Script(code, { filename: rel }).runInContext(context);
      }
      return windowObj;
    }

    function computeMetrics(windowObj, parsed, posById) {
      const Metrics = windowObj.PlanarVibeMetrics;
      const GeometryUtils = windowObj.GeometryUtils;
      const GraphUtils = windowObj.GraphUtils;
      const PlanarGraphUtils = windowObj.PlanarGraphUtils;
      const graph = GraphUtils.createGraph(parsed.nodeIds, parsed.edgePairs);
      const isPlane = !GeometryUtils.hasPositionCrossings(posById, parsed.edgePairs);
      const out = {
        isPlane,
        angularResolution: metricValue(Metrics.computeAngularResolutionScore(graph, posById), 'angularResolution'),
        aspectRatio: metricValue(Metrics.computeAspectRatioScore(parsed.nodeIds, posById), 'aspectRatio'),
        edgeLengthDeviation: metricValue(Metrics.computeEdgeLengthDeviationScore(parsed.edgePairs, posById), 'edgeLengthDeviation'),
        edgeRatio: metricValue(Metrics.computeEdgeLengthRatio(parsed.edgePairs, posById), 'edgeRatio'),
        edgeOrthogonality: metricValue(Metrics.computeEdgeOrthogonalityScore(parsed.edgePairs, posById), 'edgeOrthogonality'),
        nodeUniformity: metricValue(Metrics.computeNodeUniformityScore(parsed.nodeIds, posById), 'nodeUniformity'),
        alignment: metricValue(Metrics.computeAxisAlignmentScore(parsed.nodeIds, posById), 'alignment'),
        spacing: metricValue(Metrics.computeSpacingUniformityScore(parsed.nodeIds, posById), 'spacing'),
        face: null,
        convexity: null
      };
      if (isPlane) {
        const embedding = PlanarGraphUtils.extractEmbeddingFromPositions(parsed.nodeIds, parsed.edgePairs, posById);
        out.face = metricValue(Metrics.computeUniformFaceAreaScore(parsed.nodeIds, parsed.edgePairs, posById, embedding), 'face');
        out.convexity = metricValue(Metrics.computeConvexityScore(parsed.nodeIds, parsed.edgePairs, posById, embedding), 'convexity');
      }
      let sum = 0;
      let count = 0;
      for (const key of metricKeys) {
        if (Number.isFinite(out[key])) { sum += out[key]; count += 1; }
      }
      out.total = count > 0 ? sum / count : null;
      return out;
    }

    const dataset = loadGraphs(workerData.dataset);
    const byName = new Map(dataset.graphs.map((graph) => [String(graph.graphName), graph]));
    const windowObj = loadWindow();
    const alg = createAlgorithmSpecs(windowObj).find((spec) => spec.key === 'claude');
    for (const name of workerData.graphNames) {
      const graph = byName.get(String(name));
      windowObj.__ClaudePhaseTrace.events = [];
      const cy = createMockCy(graph.parsed.nodeIds, graph.parsed.edgePairs);
      initializeMockCyPositions(cy, graph.parsed.nodeIds, dataset.dataset + ':' + graph.graphName, graph.parsed.positionsById || null, windowObj.GeometryUtils);
      const t0 = process.hrtime.bigint();
      let result;
      try { result = await Promise.resolve(alg.run(cy)); }
      catch (err) { result = { ok: false, message: err && err.message ? err.message : String(err) }; }
      const runtimeMs = Number(process.hrtime.bigint() - t0) / 1e6;
      const metrics = result && result.ok ? computeMetrics(windowObj, graph.parsed, positionsFromCy(cy)) : null;
      parentPort.postMessage({ type: 'record', record: {
        graph: graph.graphName,
        n: graph.parsed.nodeIds.length,
        m: graph.parsed.edgePairs.length,
        runtimeMs,
        ok: !!(result && result.ok),
        message: result && result.message ? String(result.message) : '',
        metrics,
        events: windowObj.__ClaudePhaseTrace.events
      }});
    }
    parentPort.postMessage({ type: 'done' });
  `;
}

function graphNamesFor(opts) {
  if (opts.graphs) return opts.graphs;
  if (fs.existsSync(opts.previous)) {
    const prev = JSON.parse(fs.readFileSync(opts.previous, 'utf8'));
    if (Array.isArray(prev.graphNames)) return prev.graphNames.slice(0, opts.top);
  }
  const dataset = loadGraphs(opts.dataset);
  return dataset.graphs
    .map((graph) => ({
      name: graph.graphName,
      n: graph.parsed.nodeIds.length,
      m: graph.parsed.edgePairs.length
    }))
    .sort((a, b) => (b.n + b.m) - (a.n + a.m) || b.n - a.n || a.name.localeCompare(b.name))
    .slice(0, opts.top)
    .map((graph) => graph.name);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const graphNames = graphNamesFor(opts);
  const claude = instrumentClaudeSource(fs.readFileSync('static/js/layout-claude.js', 'utf8'), opts.policy);
  const chunks = Array.from({ length: Math.min(opts.concurrency, graphNames.length) }, () => []);
  for (let i = 0; i < graphNames.length; i += 1) chunks[i % chunks.length].push(graphNames[i]);

  const records = [];
  let completed = 0;
  const start = Date.now();
  await Promise.all(chunks.map((chunk, workerIndex) => new Promise((resolve, reject) => {
    const worker = new Worker(workerSource(), {
      eval: true,
      type: 'module',
      workerData: {
        root: process.cwd(),
        dataset: opts.dataset,
        graphNames: chunk,
        instrumentedClaude: claude
      }
    });
    worker.on('message', (msg) => {
      if (msg.type === 'record') {
        records.push(msg.record);
        completed += 1;
        process.stdout.write(
          `${completed}/${graphNames.length}\t${msg.record.graph}\t` +
          `${msg.record.n}V/${msg.record.m}E\t${msg.record.runtimeMs.toFixed(1)}ms\t` +
          `${msg.record.message}\telapsed=${((Date.now() - start) / 1000).toFixed(1)}s\n`
        );
      } else if (msg.type === 'done') {
        resolve();
      }
    });
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`worker ${workerIndex} exited ${code}`));
    });
  })));

  records.sort((a, b) => graphNames.indexOf(a.graph) - graphNames.indexOf(b.graph));
  fs.writeFileSync(opts.output, JSON.stringify({
    generatedAt: new Date().toISOString(),
    dataset: opts.dataset,
    policy: opts.policy,
    graphNames,
    records
  }, null, 2));
  process.stdout.write(`Wrote ${opts.output}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
