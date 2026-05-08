import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { loadGraphs } from './apply-layout.mjs';
import {
  createAlgorithmSpecs,
  createMockCy,
  initializeMockCyPositions,
  positionsFromCy
} from './report-shared.mjs';

const DEFAULT_FILES = ['benchmark/planar_all.dot'];
const DEFAULT_OUTPUT = '/tmp/claude-candidate-trace.json';
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
    files: DEFAULT_FILES.slice(),
    graphs: null,
    top: null,
    sort: 'n',
    output: DEFAULT_OUTPUT,
    quiet: false,
    policy: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--files' && i + 1 < argv.length) {
      opts.files = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--graphs' && i + 1 < argv.length) {
      opts.graphs = new Set(String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean));
    } else if (arg === '--top' && i + 1 < argv.length) {
      opts.top = Math.max(1, Math.floor(Number(argv[++i]) || 0));
    } else if (arg === '--sort' && i + 1 < argv.length) {
      opts.sort = String(argv[++i]).trim() || opts.sort;
    } else if (arg === '--output' && i + 1 < argv.length) {
      opts.output = String(argv[++i]);
    } else if (arg === '--policy' && i + 1 < argv.length) {
      const policy = String(argv[++i]).trim().toLowerCase();
      if (policy === 'on' || policy === 'off') opts.policy = policy;
    } else if (arg === '--quiet') {
      opts.quiet = true;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: node scripts/trace-claude-candidates.mjs ' +
        '[--files benchmark/planar_all.dot] [--graphs g1,g2] [--top 20] ' +
        '[--sort n|m|size] [--policy on|off] [--output /tmp/claude-candidate-trace.json] [--quiet]\n'
      );
      process.exit(0);
    }
  }

  return opts;
}

function replaceOnce(source, needle, replacement, label) {
  if (!source.includes(needle)) {
    throw new Error(`Could not instrument Claude source at ${label}`);
  }
  return source.replace(needle, replacement);
}

function instrumentClaudeSource(source) {
  let code = source;
  code = replaceOnce(
    code,
    "  'use strict';\n\n",
    `  'use strict';\n\n` +
      `  function __traceNow() { return Date.now(); }\n` +
      `  function __traceScoreSummary(variant) {\n` +
      `    if (!variant || !variant.scores) return null;\n` +
      `    return {\n` +
      `      label: variant.label,\n` +
      `      total: variant.scores.total,\n` +
      `      metrics: variant.scores.raw || variant.scores || null\n` +
      `    };\n` +
      `  }\n` +
      `  function __traceBest(variants) {\n` +
      `    var best = null;\n` +
      `    for (var i = 0; i < variants.length; i += 1) {\n` +
      `      if (!best || variants[i].scores.total > best.scores.total) best = variants[i];\n` +
      `    }\n` +
      `    return __traceScoreSummary(best);\n` +
      `  }\n` +
      `  function __tracePush(kind, label, ms, extra) {\n` +
      `    if (global.__ClaudeTrace && Array.isArray(global.__ClaudeTrace.events)) {\n` +
      `      global.__ClaudeTrace.events.push({ kind: kind, label: label, ms: ms, extra: extra || null });\n` +
      `    }\n` +
      `  }\n\n`,
    'trace helpers'
  );

  code = replaceOnce(
    code,
    `    function maybePushBalancer(label, module) {\n` +
      `      if (!hasComputeInterface(module)) return;\n` +
      `      var prepared = getBalancerPrepared(module);\n` +
      `      if (balancerInteriorAugVertexCount(prepared) > balancerInteriorLimit(opts)) return;\n` +
      `      if (USE_SIZE_DRIVEN_CANDIDATE_POLICY &&\n` +
      `          isHeavyBalancerCandidate(label) &&\n` +
      `          balancerAugEdgeCount(prepared) > HEAVY_BALANCER_AUG_EDGE_LIMIT) {\n` +
      `        return;\n` +
      `      }\n` +
      `      runners.push([label, function () { return runPreparedModuleCandidate(module, graph, prepared); }]);\n` +
      `    }\n`,
    `    function maybePushBalancer(label, module) {\n` +
      `      if (!hasComputeInterface(module)) return;\n` +
      `      var prepared = getBalancerPrepared(module);\n` +
      `      var interiorAugVertices = balancerInteriorAugVertexCount(prepared);\n` +
      `      var augGraph = prepared && prepared.augmented && prepared.augmented.graph ? prepared.augmented.graph : null;\n` +
      `      var augEdges = augGraph && augGraph.edgePairs ? augGraph.edgePairs.length : null;\n` +
      `      var skippedByInterior = interiorAugVertices > balancerInteriorLimit(opts);\n` +
      `      var skippedBySizePolicy = USE_SIZE_DRIVEN_CANDIDATE_POLICY &&\n` +
      `          isHeavyBalancerCandidate(label) &&\n` +
      `          balancerAugEdgeCount(prepared) > HEAVY_BALANCER_AUG_EDGE_LIMIT;\n` +
      `      __tracePush('candidateQueued', label, 0, {\n` +
      `        kind: 'balancer',\n` +
      `        interiorAugVertices: interiorAugVertices,\n` +
      `        augNodes: augGraph && augGraph.nodeIds ? augGraph.nodeIds.length : null,\n` +
      `        augEdges: augEdges,\n` +
      `        skippedByInterior: skippedByInterior,\n` +
      `        skippedBySizePolicy: skippedBySizePolicy,\n` +
      `        skipped: skippedByInterior || skippedBySizePolicy\n` +
      `      });\n` +
      `      if (skippedByInterior) return;\n` +
      `      if (skippedBySizePolicy) return;\n` +
      `      runners.push([label, function () { return runPreparedModuleCandidate(module, graph, prepared); }]);\n` +
      `    }\n`,
    'maybePushBalancer'
  );

  code = replaceOnce(
    code,
    `    var runners = buildCandidateRunners(graph, opts, runtime);\n`,
    `    var __buildT0 = __traceNow();\n` +
      `    var runners = buildCandidateRunners(graph, opts, runtime);\n` +
      `    __tracePush('buildCandidateRunners', 'all', __traceNow() - __buildT0, {\n` +
      `      labels: runners.map(function (r) { return r[0]; })\n` +
      `    });\n`,
    'buildCandidateRunners call'
  );

  code = replaceOnce(
    code,
    `      var label = runners[i][0];\n` +
      `      var out = await runners[i][1]();\n` +
      `      if (out.ok) {\n` +
      `        var expanded = expandVariants(label, out.posById, out.embedding, nodeIds, edgePairs);\n` +
      `        for (var k = 0; k < expanded.length; k += 1) variants.push(expanded[k]);\n` +
      `      }\n`,
    `      var label = runners[i][0];\n` +
      `      var __candT0 = __traceNow();\n` +
      `      var out = await runners[i][1]();\n` +
      `      __tracePush('candidate', label, __traceNow() - __candT0, {\n` +
      `        ok: !!(out && out.ok),\n` +
      `        message: out && out.message ? String(out.message) : ''\n` +
      `      });\n` +
      `      if (out.ok) {\n` +
      `        var __expandT0 = __traceNow();\n` +
      `        var expanded = expandVariants(label, out.posById, out.embedding, nodeIds, edgePairs);\n` +
      `        __tracePush('expandVariants', label, __traceNow() - __expandT0, {\n` +
      `          variants: expanded.map(__traceScoreSummary)\n` +
      `        });\n` +
      `        for (var k = 0; k < expanded.length; k += 1) variants.push(expanded[k]);\n` +
      `        __tracePush('prefixBest', label, 0, {\n` +
      `          candidateIndex: i,\n` +
      `          best: __traceBest(variants)\n` +
      `        });\n` +
      `      }\n`,
    'candidate loop'
  );

  return code;
}

function applyPolicyOverride(code, policy) {
  if (policy === 'on') {
    return code.replace(
      'var USE_SIZE_DRIVEN_CANDIDATE_POLICY = true;',
      'var USE_SIZE_DRIVEN_CANDIDATE_POLICY = true;'
    );
  }
  if (policy === 'off') {
    return code.replace(
      'var USE_SIZE_DRIVEN_CANDIDATE_POLICY = true;',
      'var USE_SIZE_DRIVEN_CANDIDATE_POLICY = false;'
    );
  }
  return code;
}

function loadInstrumentedModules(opts) {
  const windowObj = { __ClaudeTrace: { events: [] } };
  windowObj.window = windowObj;
  const context = vm.createContext({
    window: windowObj,
    console,
    Math,
    Set,
    Map,
    Array,
    Object,
    String,
    Number,
    Promise,
    Date,
    setTimeout,
    clearTimeout
  });

  for (const rel of BROWSER_MODULE_FILES) {
    const abs = path.resolve(process.cwd(), rel);
    let code = fs.readFileSync(abs, 'utf8');
    if (rel === 'static/js/layout-claude.js') {
      code = applyPolicyOverride(code, opts.policy);
      code = instrumentClaudeSource(code);
    }
    new vm.Script(code, { filename: rel }).runInContext(context);
  }
  return windowObj;
}

function metricValue(result, key) {
  if (!result || !result.ok) return null;
  if (key === 'edgeRatio') return result.ratio;
  if (key === 'face') return result.quality;
  return result.score;
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
    out.face = metricValue(
      Metrics.computeUniformFaceAreaScore(parsed.nodeIds, parsed.edgePairs, posById, embedding),
      'face'
    );
    out.convexity = metricValue(
      Metrics.computeConvexityScore(parsed.nodeIds, parsed.edgePairs, posById, embedding),
      'convexity'
    );
  }

  let sum = 0;
  let count = 0;
  for (const key of METRIC_KEYS) {
    if (Number.isFinite(out[key])) {
      sum += out[key];
      count += 1;
    }
  }
  out.total = count > 0 ? sum / count : null;
  return out;
}

function collectGraphs(opts) {
  const all = [];
  for (const file of opts.files) {
    const dataset = loadGraphs(file);
    for (const graph of dataset.graphs) {
      const graphName = String(graph.graphName);
      if (opts.graphs && !opts.graphs.has(graphName)) continue;
      all.push({
        dataset: dataset.dataset,
        file,
        graphName,
        parsed: graph.parsed,
        n: graph.parsed.nodeIds.length,
        m: graph.parsed.edgePairs.length
      });
    }
  }

  all.sort((a, b) => {
    if (opts.sort === 'm') return b.m - a.m || b.n - a.n || a.graphName.localeCompare(b.graphName);
    if (opts.sort === 'size') return (b.n + b.m) - (a.n + a.m) || b.n - a.n || a.graphName.localeCompare(b.graphName);
    return b.n - a.n || b.m - a.m || a.graphName.localeCompare(b.graphName);
  });

  return Number.isFinite(opts.top) ? all.slice(0, opts.top) : all;
}

async function runTrace(windowObj, graphRec) {
  windowObj.__ClaudeTrace.events = [];
  const alg = createAlgorithmSpecs(windowObj).find((spec) => spec.key === 'claude');
  if (!alg) throw new Error('Claude algorithm is not available');

  const cy = createMockCy(graphRec.parsed.nodeIds, graphRec.parsed.edgePairs);
  initializeMockCyPositions(
    cy,
    graphRec.parsed.nodeIds,
    `${graphRec.dataset}:${graphRec.graphName}`,
    graphRec.parsed.positionsById || null,
    windowObj.GeometryUtils
  );

  const t0 = process.hrtime.bigint();
  let result;
  try {
    result = await Promise.resolve(alg.run(cy));
  } catch (err) {
    result = { ok: false, message: err && err.message ? err.message : String(err) };
  }
  const runtimeMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const metrics = result && result.ok
    ? computeMetrics(windowObj, graphRec.parsed, positionsFromCy(cy))
    : null;

  return {
    dataset: graphRec.dataset,
    file: graphRec.file,
    graph: graphRec.graphName,
    n: graphRec.n,
    m: graphRec.m,
    ok: !!(result && result.ok),
    message: result && result.message ? String(result.message) : '',
    runtimeMs,
    metrics,
    events: windowObj.__ClaudeTrace.events
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const graphs = collectGraphs(opts);
  const windowObj = loadInstrumentedModules(opts);
  const records = [];

  if (!opts.quiet) {
    process.stderr.write(`Tracing Claude on ${graphs.length} graph(s); output=${opts.output}\n`);
  }

  for (const graph of graphs) {
    const rec = await runTrace(windowObj, graph);
    records.push(rec);
    if (!opts.quiet) {
      const total = rec.metrics && Number.isFinite(rec.metrics.total)
        ? rec.metrics.total.toFixed(6)
        : 'NA';
      process.stderr.write(
        `${rec.graph}\t${rec.n}V/${rec.m}E\t${rec.ok ? 'ok' : 'fail'}\t` +
        `${rec.runtimeMs.toFixed(1)}ms\ttotal=${total}\t${rec.message}\n`
      );
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    files: opts.files,
    sort: opts.sort,
    top: opts.top,
    graphs: records
  };
  fs.writeFileSync(opts.output, JSON.stringify(out, null, 2));
}

main().catch((err) => {
  process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
