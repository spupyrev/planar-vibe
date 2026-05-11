import { parentPort, workerData } from 'node:worker_threads';

import {
  createAlgorithmSpecs,
  createMockCy,
  initializeMockCyPositions,
  loadBrowserModules,
  positionsFromCy,
} from './report-shared.mjs';

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
  const dataset = String(workerData && workerData.dataset ? workerData.dataset : '');
  const graphName = String(workerData && workerData.graphName ? workerData.graphName : '');
  const algorithmKey = String(workerData && workerData.algorithmKey ? workerData.algorithmKey : '');
  const includePositions = !!(workerData && workerData.includePositions);
  const parsed = workerData && workerData.parsed ? workerData.parsed : null;
  if (!parsed || !Array.isArray(parsed.nodeIds) || !Array.isArray(parsed.edgePairs)) {
    throw new Error('Missing parsed graph payload');
  }

  const windowObj = loadBrowserModules();
  let posById = null;
  let runtimeMs = 0;
  let recAlgorithm = algorithmKey;
  let recAlgorithmLabel = algorithmKey;
  let layoutResult;

  if (algorithmKey === 'input') {
    recAlgorithmLabel = 'Input';
    const positions = parsed && parsed.positionsById ? parsed.positionsById : null;
    const hasAllPositions = parsed.nodeIds.every((id) => {
      const p = positions && positions[String(id)];
      return p && Number.isFinite(p.x) && Number.isFinite(p.y);
    });
    if (!hasAllPositions) {
      layoutResult = {
        ok: false,
        message: 'Input coordinates are missing or invalid for one or more vertices'
      };
    } else {
      posById = (windowObj.GeometryUtils && typeof windowObj.GeometryUtils.normalizePositionMapToViewport === 'function')
        ? windowObj.GeometryUtils.normalizePositionMapToViewport(positions)
        : positions;
      layoutResult = {
        ok: true,
        message: 'Used input coordinates'
      };
    }
  } else {
    const algorithms = createAlgorithmSpecs(windowObj);
    const alg = algorithms.find((spec) => spec.key === algorithmKey);
    if (!alg) {
      throw new Error(`Unknown algorithm: ${algorithmKey}`);
    }

    recAlgorithm = alg.key;
    recAlgorithmLabel = alg.label;

    const cy = createMockCy(parsed.nodeIds, parsed.edgePairs);
    initializeMockCyPositions(
      cy,
      parsed.nodeIds,
      `${dataset}:${graphName}`,
      parsed.positionsById || null,
      windowObj.GeometryUtils
    );

    const t0 = process.hrtime.bigint();
    try {
      layoutResult = await Promise.resolve(alg.run(cy));
    } catch (err) {
      layoutResult = { ok: false, message: err && err.message ? err.message : String(err) };
    }
    runtimeMs = Number(process.hrtime.bigint() - t0) / 1e6;
    if (layoutResult && layoutResult.ok) {
      posById = positionsFromCy(cy);
    }
  }

  const rec = {
    dataset,
    graph: graphName,
    n: parsed.nodeIds.length,
    m: parsed.edgePairs.length,
    algorithm: recAlgorithm,
    algorithmLabel: recAlgorithmLabel,
    runtimeMs,
    ok: !!(layoutResult && layoutResult.ok),
    message: layoutResult && layoutResult.message ? String(layoutResult.message) : '',
    isPlane: null,
    angularResolution: null,
    aspectRatio: null,
    convexity: null,
    edgeLengthDeviation: null,
    edgeRatio: null,
    edgeOrthogonality: null,
    face: null,
    nodeUniformity: null,
    alignment: null,
    spacing: null
  };

  if (rec.ok) {
    const metrics = computeMetrics(windowObj, parsed, posById);
    rec.isPlane = metrics.isPlane ? 1 : 0;
    rec.angularResolution = metrics.angularResolution;
    rec.aspectRatio = metrics.aspectRatio;
    rec.convexity = metrics.convexity;
    rec.edgeLengthDeviation = metrics.edgeLengthDeviation;
    rec.edgeRatio = metrics.edgeRatio;
    rec.edgeOrthogonality = metrics.edgeOrthogonality;
    rec.face = metrics.face;
    rec.nodeUniformity = metrics.nodeUniformity;
    rec.alignment = metrics.alignment;
    rec.spacing = metrics.spacing;
    if (!metrics.isPlane) {
      rec.ok = false;
      rec.message = rec.message ? `${rec.message} [non-plane drawing]` : 'non-plane drawing';
    }
    if (includePositions) {
      rec.positions = posById;
    }
  }

  parentPort.postMessage({ ok: true, rec });
}

main().catch((err) => {
  parentPort.postMessage({
    ok: false,
    message: err && err.message ? err.message : String(err)
  });
});
