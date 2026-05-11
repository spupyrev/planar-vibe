// JS reference freezer. Runs one (dataset, graph, algorithm) tuple through
// the existing JS layout pipeline (mirroring scripts/run-dataset-algorithm-batch-worker.mjs)
// and emits a single JSON line to stdout with positions + metrics + runtime.
//
// Usage (from repo root):
//   node src-python/scripts/js_driver.mjs <dot-file> <graph-name> <algorithm-key>
//
// Intended to be invoked by Python freeze_js_reference.py. Does NOT modify
// any JS source.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..', '..');

// Import from the existing JS pipeline.
const reportShared = await import(path.join(REPO_ROOT, 'scripts/report-shared.mjs'));
const applyLayout = await import(path.join(REPO_ROOT, 'scripts/apply-layout-js.mjs'));

const {
  createAlgorithmSpecs,
  createMockCy,
  initializeMockCyPositions,
  loadBrowserModules,
  positionsFromCy
} = reportShared;
const { loadGraphs } = applyLayout;

function computeMetrics(windowObj, parsed, posById) {
  const Metrics = windowObj.PlanarVibeMetrics;
  const GeometryUtils = windowObj.GeometryUtils;
  const GraphUtils = windowObj.GraphUtils;
  const PlanarGraphUtils = windowObj.PlanarGraphUtils;
  const graph = GraphUtils.createGraph(parsed.nodeIds, parsed.edgePairs);

  const isPlane = !GeometryUtils.hasPositionCrossings(posById, parsed.edgePairs);
  const aspectRatio = Metrics.computeAspectRatioScore(parsed.nodeIds, posById);
  const nodeUniformity = Metrics.computeNodeUniformityScore(parsed.nodeIds, posById);
  const edgeLengthDeviation = Metrics.computeEdgeLengthDeviationScore(parsed.edgePairs, posById);
  const edgeRatio = Metrics.computeEdgeLengthRatio(parsed.edgePairs, posById);
  const spacing = Metrics.computeSpacingUniformityScore(parsed.nodeIds, posById);
  const edgeOrthogonality = Metrics.computeEdgeOrthogonalityScore(parsed.edgePairs, posById);
  const alignment = Metrics.computeAxisAlignmentScore(parsed.nodeIds, posById);
  const angularResolution = Metrics.computeAngularResolutionScore(graph, posById);

  let face = null;
  let convexity = null;
  if (isPlane) {
    const embedding = PlanarGraphUtils.extractEmbeddingFromPositions(parsed.nodeIds, parsed.edgePairs, posById);
    face = Metrics.computeUniformFaceAreaScore(parsed.nodeIds, parsed.edgePairs, posById, embedding);
    convexity = Metrics.computeConvexityScore(parsed.nodeIds, parsed.edgePairs, posById, embedding);
  }

  return {
    isPlane,
    angularResolution: angularResolution && angularResolution.ok ? angularResolution.score : null,
    aspectRatio: aspectRatio && aspectRatio.ok ? aspectRatio.score : null,
    convexity: convexity && convexity.ok ? convexity.score : null,
    edgeLengthDeviation: edgeLengthDeviation && edgeLengthDeviation.ok ? edgeLengthDeviation.score : null,
    edgeRatio: edgeRatio && edgeRatio.ok ? edgeRatio.ratio : null,
    edgeOrthogonality: edgeOrthogonality && edgeOrthogonality.ok ? edgeOrthogonality.score : null,
    face: face && face.ok ? face.quality : null,
    nodeUniformity: nodeUniformity && nodeUniformity.ok ? nodeUniformity.score : null,
    alignment: alignment && alignment.ok ? alignment.score : null,
    spacing: spacing && spacing.ok ? spacing.score : null
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length !== 3) {
    process.stderr.write('Usage: node js_driver.mjs <dot-file> <graph-name> <algorithm-key>\n');
    process.exit(2);
  }
  const [dotFile, graphName, algorithmKey] = argv;

  const dataset = loadGraphs(dotFile);
  const graphEntry = dataset.graphs.find((g) => g.graphName === graphName);
  if (!graphEntry) {
    process.stderr.write(`No graph named ${graphName} in ${dotFile}\n`);
    process.exit(2);
  }
  const parsed = graphEntry.parsed;

  const windowObj = loadBrowserModules();
  const cy = createMockCy(parsed.nodeIds, parsed.edgePairs);
  initializeMockCyPositions(
    cy,
    parsed.nodeIds,
    `${dataset.dataset}:${graphName}`,
    parsed.positionsById || null,
    windowObj.GeometryUtils
  );

  let layoutResult;
  let runtimeMs = 0;
  let posById = null;

  if (algorithmKey === 'input') {
    const positions = parsed.positionsById || null;
    const hasAllPositions = parsed.nodeIds.every((id) => {
      const p = positions && positions[String(id)];
      return p && Number.isFinite(p.x) && Number.isFinite(p.y);
    });
    if (!hasAllPositions) {
      layoutResult = { ok: false, message: 'Input coordinates are missing or invalid' };
    } else {
      posById = windowObj.GeometryUtils.normalizePositionMapToViewport(positions);
      layoutResult = { ok: true, message: 'Used input coordinates' };
    }
  } else if (algorithmKey === 'random') {
    // Not in createAlgorithmSpecs; invoke PlanarVibeRandom.applyLayout directly.
    const t0 = process.hrtime.bigint();
    try {
      layoutResult = await Promise.resolve(windowObj.PlanarVibeRandom.applyLayout(cy, {}));
    } catch (err) {
      layoutResult = { ok: false, message: err && err.message ? err.message : String(err) };
    }
    runtimeMs = Number(process.hrtime.bigint() - t0) / 1e6;
    if (layoutResult && layoutResult.ok) {
      posById = positionsFromCy(cy);
    }
  } else {
    const specs = createAlgorithmSpecs(windowObj);
    const spec = specs.find((s) => s.key === algorithmKey);
    if (!spec) {
      process.stderr.write(`Unknown algorithm: ${algorithmKey}\n`);
      process.exit(2);
    }
    const t0 = process.hrtime.bigint();
    try {
      layoutResult = await Promise.resolve(spec.run(cy));
    } catch (err) {
      layoutResult = { ok: false, message: err && err.message ? err.message : String(err) };
    }
    runtimeMs = Number(process.hrtime.bigint() - t0) / 1e6;
    if (layoutResult && layoutResult.ok) {
      posById = positionsFromCy(cy);
    }
  }

  const out = {
    dataset: dataset.dataset,
    graph: graphName,
    algorithm: algorithmKey,
    n: parsed.nodeIds.length,
    m: parsed.edgePairs.length,
    runtime_ms: runtimeMs,
    ok: !!(layoutResult && layoutResult.ok),
    message: layoutResult && layoutResult.message ? String(layoutResult.message) : '',
    positions: null,
    metrics: null
  };

  if (out.ok && posById) {
    const metrics = computeMetrics(windowObj, parsed, posById);
    out.positions = {};
    for (const id of Object.keys(posById)) {
      const p = posById[id];
      out.positions[id] = [p.x, p.y];
    }
    out.metrics = metrics;
  }

  process.stdout.write(JSON.stringify(out) + '\n');
}

main().catch((err) => {
  process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
  process.exit(1);
});
