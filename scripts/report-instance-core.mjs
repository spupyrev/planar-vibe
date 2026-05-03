import {
  createAlgorithmSpecs,
  createMockCy,
  loadBrowserModules,
  parseEdgeListText,
  positionsFromCy,
  seedPositions
} from './report-shared.mjs';

export async function computeReportInstance(graphName, algorithmKey) {
  const windowObj = loadBrowserModules();
  const Generator = windowObj.PlanarVibeGraphGenerator;
  const Metrics = windowObj.PlanarVibeMetrics;
  const GeometryUtils = windowObj.GeometryUtils;
  const GraphUtils = windowObj.GraphUtils;
  const PlanarGraphUtils = windowObj.PlanarGraphUtils;
  const algorithms = createAlgorithmSpecs(windowObj);
  const alg = algorithms.find((spec) => spec.key === algorithmKey);
  if (!alg) {
    throw new Error(`Unknown algorithm: ${algorithmKey}`);
  }

  const sample = Generator.getSample(graphName);
  if (!sample) {
    throw new Error(`Missing sample: ${graphName}`);
  }
  const parsedInput = parseEdgeListText(sample);
  const parsed = GraphUtils.createGraph(parsedInput.nodeIds, parsedInput.edgePairs);
  const cy = createMockCy(parsed.nodeIds, parsed.edgePairs);
  seedPositions(cy, parsed.nodeIds, graphName);

  const t0 = process.hrtime.bigint();
  let result;
  try {
    result = await Promise.resolve(alg.run(cy));
  } catch (err) {
    result = { ok: false, message: err && err.message ? err.message : String(err) };
  }
  const runtimeMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const rec = {
    graph: graphName,
    n: parsed.nodeIds.length,
    m: parsed.edgePairs.length,
    algorithm: alg.key,
    algorithmLabel: alg.label,
    runtimeMs,
    ok: !!(result && result.ok),
    message: result && result.message ? String(result.message) : '',
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
    const posById = positionsFromCy(cy);
    const isPlane = !GeometryUtils.hasPositionCrossings(posById, parsed.edgePairs);
    const aspectRatio = Metrics.computeAspectRatioScore(parsed.nodeIds, posById);
    const nodeUniformity = Metrics.computeNodeUniformityScore(parsed.nodeIds, posById);
    const edgeLengthDeviation = Metrics.computeEdgeLengthDeviationScore(parsed.edgePairs, posById);
    const edgeRatio = Metrics.computeEdgeLengthRatio(parsed.edgePairs, posById);
    const spacing = Metrics.computeSpacingUniformityScore(parsed.nodeIds, posById);
    const edgeOrthogonality = Metrics.computeEdgeOrthogonalityScore(parsed.edgePairs, posById);
    const alignment = Metrics.computeAxisAlignmentScore(parsed.nodeIds, posById);
    let face = null;
    let convexity = null;
    let angularResolution = Metrics.computeAngularResolutionScore(parsed, posById);
    if (isPlane) {
      const embedding = PlanarGraphUtils.extractEmbeddingFromPositions(parsed.nodeIds, parsed.edgePairs, posById);
      face = Metrics.computeUniformFaceAreaScore(parsed.nodeIds, parsed.edgePairs, posById, embedding);
      convexity = Metrics.computeConvexityScore(parsed.nodeIds, parsed.edgePairs, posById, embedding);
    }
    rec.aspectRatio = aspectRatio && aspectRatio.ok ? aspectRatio.score : null;
    rec.nodeUniformity = nodeUniformity && nodeUniformity.ok ? nodeUniformity.score : null;
    rec.face = face && face.ok ? face.quality : null;
    rec.convexity = convexity && convexity.ok ? convexity.score : null;
    rec.angularResolution = angularResolution && angularResolution.ok ? angularResolution.score : null;
    rec.edgeLengthDeviation = edgeLengthDeviation && edgeLengthDeviation.ok ? edgeLengthDeviation.score : null;
    rec.edgeRatio = edgeRatio && edgeRatio.ok ? edgeRatio.ratio : null;
    rec.spacing = spacing && spacing.ok ? spacing.score : null;
    rec.edgeOrthogonality = edgeOrthogonality && edgeOrthogonality.ok ? edgeOrthogonality.score : null;
    rec.alignment = alignment && alignment.ok ? alignment.score : null;
    if (!isPlane) {
      rec.ok = false;
      rec.message = rec.message
        ? `${rec.message} [non-plane drawing]`
        : 'non-plane drawing';
    }
  }

  return rec;
}
