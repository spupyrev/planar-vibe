import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import {
  benchmark,
  createMockCy,
  parseEdgeListText,
  positionsFromCy,
  seedPositions
} from './report-shared.mjs';

function parseArgs(argv) {
  const out = {
    variants: null,
    output: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--variants' && i + 1 < argv.length) {
      out.variants = argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean);
      i += 1;
      continue;
    }
    if (arg === '--output' && i + 1 < argv.length) {
      out.output = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

function average(rows, key) {
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

function summarizeByVariant(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = row.variant;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(row);
  }

  const out = [];
  for (const [variant, group] of grouped.entries()) {
    const okRows = group.filter((row) => row.ok);
    out.push({
      variant,
      runs: group.length,
      successes: okRows.length,
      avgRuntimeMs: average(group, 'runtimeMs'),
      avgEdge: average(okRows, 'edge'),
      avgEdgeRatio: average(okRows, 'edgeRatio'),
      avgFace: average(okRows, 'face'),
      avgAngle: average(okRows, 'angle'),
      avgSpacing: average(okRows, 'spacing'),
      avgAlignment: average(okRows, 'alignment')
    });
  }
  out.sort((a, b) => a.variant.localeCompare(b.variant));
  return out;
}

function summarizeVsBaseline(rows, baselineKey) {
  const byGraph = new Map();
  for (const row of rows) {
    if (!byGraph.has(row.graph)) {
      byGraph.set(row.graph, []);
    }
    byGraph.get(row.graph).push(row);
  }

  const deltas = [];
  for (const group of byGraph.values()) {
    const baseline = group.find((row) => row.variant === baselineKey);
    if (!baseline || !baseline.ok) {
      continue;
    }
    for (const row of group) {
      if (row.variant === baselineKey || !row.ok) {
        continue;
      }
      deltas.push({
        variant: row.variant,
        graph: row.graph,
        edgeDelta: Number.isFinite(row.edge) && Number.isFinite(baseline.edge) ? row.edge - baseline.edge : null,
        edgeRatioDelta: Number.isFinite(row.edgeRatio) && Number.isFinite(baseline.edgeRatio) ? row.edgeRatio - baseline.edgeRatio : null,
        faceDelta: Number.isFinite(row.face) && Number.isFinite(baseline.face) ? row.face - baseline.face : null
      });
    }
  }

  const grouped = new Map();
  for (const row of deltas) {
    if (!grouped.has(row.variant)) {
      grouped.set(row.variant, []);
    }
    grouped.get(row.variant).push(row);
  }

  const out = [];
  for (const [variant, group] of grouped.entries()) {
    let edgeWins = 0;
    let edgeRatioWins = 0;
    let edgeLosses = 0;
    let edgeRatioLosses = 0;
    for (const row of group) {
      if (Number.isFinite(row.edgeDelta)) {
        if (row.edgeDelta > 1e-12) edgeWins += 1;
        if (row.edgeDelta < -1e-12) edgeLosses += 1;
      }
      if (Number.isFinite(row.edgeRatioDelta)) {
        if (row.edgeRatioDelta > 1e-12) edgeRatioWins += 1;
        if (row.edgeRatioDelta < -1e-12) edgeRatioLosses += 1;
      }
    }
    out.push({
      variant,
      comparedGraphs: group.length,
      avgEdgeDelta: average(group, 'edgeDelta'),
      avgEdgeRatioDelta: average(group, 'edgeRatioDelta'),
      avgFaceDelta: average(group, 'faceDelta'),
      edgeWins,
      edgeLosses,
      edgeRatioWins,
      edgeRatioLosses
    });
  }
  out.sort((a, b) => a.variant.localeCompare(b.variant));
  return out;
}

function loadEdgeBenchmarkModules() {
  const windowObj = {};
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
    setTimeout,
    clearTimeout
  });

  const files = [
    'static/js/graph-generator.js',
    'static/js/planarvibe-plugin.js',
    'static/js/planarity-test.js',
    'static/js/metrics.js',
    'static/js/linear-algebra.js',
    'static/js/geometry-utils.js',
    'static/js/planar-graph-utils.js',
    'static/js/graph-utils.js',
    'static/js/alignment.js',
    'static/js/cy-runtime.js',
    'static/js/layout-preprocessing.js',
    'static/js/layout-tutte.js',
    'static/js/layout-random.js',
    'static/js/layout-air.js',
    'static/js/layout-areagrad.js',
    'static/js/layout-facebalancer.js',
    'static/js/layout-edgebalancer.js',
    'static/js/layout-reweight.js',
    'static/js/layout-forcedir.js',
    'static/js/layout-impred.js',
    'static/js/layout-fpp.js',
    'static/js/layout-schnyder.js',
    'static/js/layout-ceg.js',
    'static/js/layout-p3t.js'
  ];

  for (const rel of files) {
    const abs = path.resolve(process.cwd(), rel);
    const code = fs.readFileSync(abs, 'utf8');
    new vm.Script(code, { filename: rel }).runInContext(context);
  }
  return windowObj;
}

function createVariantSpecs() {
  return [
    {
      key: 'default',
      label: 'Default'
    }
  ];
}

async function runVariant(windowObj, graphName, variant) {
  const Generator = windowObj.PlanarVibeGraphGenerator;
  const GraphUtils = windowObj.GraphUtils;
  const Metrics = windowObj.PlanarVibeMetrics;
  const EdgeBalancer = windowObj.PlanarVibeEdgeBalancer;

  const sample = Generator.getSample(graphName);
  if (!sample) {
    throw new Error(`Missing sample: ${graphName}`);
  }
  const parsed = parseEdgeListText(sample);
  const graph = GraphUtils.createGraph(parsed.nodeIds, parsed.edgePairs);
  const cy = createMockCy(parsed.nodeIds, parsed.edgePairs);
  seedPositions(cy, parsed.nodeIds, graphName);
  const currentPositions = positionsFromCy(cy);

  const t0 = process.hrtime.bigint();
  let result;
  try {
    const runtime = {
      augmentationMethod: 'outer-cycle',
      currentPositions
    };
    result = await EdgeBalancer.computePositions(graph, EdgeBalancer.prepareGraphData(graph, runtime));
  } catch (err) {
    result = { ok: false, message: err && err.message ? err.message : String(err) };
  }
  const runtimeMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const rec = {
    graph: graphName,
    n: parsed.nodeIds.length,
    m: parsed.edgePairs.length,
    variant: variant.key,
    variantLabel: variant.label,
    runtimeMs,
    ok: !!(result && result.ok),
    message: result && (result.message || result.reason || result.stopReason || '') ? String(result.message || result.reason || result.stopReason || '') : '',
    objective: result && Number.isFinite(result.objective) ? result.objective : null,
    stopReason: result && result.stopReason ? String(result.stopReason) : '',
    angle: null,
    face: null,
    edge: null,
    edgeRatio: null,
    spacing: null,
    alignment: null
  };

  if (!rec.ok || !result.positions) {
    return rec;
  }

  const posById = windowObj.GeometryUtils.filterPositionMap(result.positions, parsed.nodeIds);
  const isPlane = !windowObj.GeometryUtils.hasPositionCrossings(posById, parsed.edgePairs);
  const edgeScore = Metrics.computeEdgeLengthDeviationScore(parsed.edgePairs, posById);
  const edgeRatio = Metrics.computeEdgeLengthRatio(parsed.edgePairs, posById);
  const spacing = Metrics.computeSpacingUniformityScore(parsed.nodeIds, posById);
  const alignment = Metrics.computeAxisAlignmentScore(parsed.nodeIds, posById);
  let face = null;
  let angle = null;
  if (isPlane) {
    const embedding = windowObj.PlanarGraphUtils.extractEmbeddingFromPositions(parsed.nodeIds, parsed.edgePairs, posById);
    face = Metrics.computeUniformFaceAreaScore(parsed.nodeIds, parsed.edgePairs, posById, embedding);
    angle = Metrics.computeAngularResolutionScore(graph, posById);
  }
  rec.face = face && face.ok ? face.quality : null;
  rec.angle = angle && angle.ok ? angle.score : null;
  rec.edge = edgeScore && edgeScore.ok ? edgeScore.score : null;
  rec.edgeRatio = edgeRatio && edgeRatio.ok ? edgeRatio.ratio : null;
  rec.spacing = spacing && spacing.ok ? spacing.score : null;
  rec.alignment = alignment && alignment.ok ? alignment.score : null;
  if (!isPlane) {
    rec.ok = false;
    rec.message = rec.message
      ? `${rec.message} [non-plane drawing]`
      : 'non-plane drawing';
  }
  return rec;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const windowObj = loadEdgeBenchmarkModules();
  const allVariants = createVariantSpecs();
  const requested = args.variants && args.variants.length
    ? allVariants.filter((variant) => args.variants.includes(variant.key))
    : allVariants;
  if (!requested.length) {
    throw new Error('No objective variants selected');
  }

  const rows = [];
  for (const variant of requested) {
    for (const graphName of benchmark) {
      const rec = await runVariant(windowObj, graphName, variant);
      rows.push(rec);
      console.log([
        variant.key,
        graphName,
        rec.ok ? 'ok' : 'fail',
        Number.isFinite(rec.edge) ? rec.edge.toFixed(6) : 'na',
        Number.isFinite(rec.edgeRatio) ? rec.edgeRatio.toFixed(6) : 'na',
        rec.stopReason || rec.message || ''
      ].join('\t'));
    }
  }

  const report = {
    benchmark,
    variants: requested.map((variant) => ({ key: variant.key, label: variant.label })),
    rows,
    summary: summarizeByVariant(rows),
    versusBaseline: summarizeVsBaseline(rows, 'default')
  };

  if (args.output) {
    const outPath = path.resolve(process.cwd(), args.output);
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.error(`Wrote ${outPath}`);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
