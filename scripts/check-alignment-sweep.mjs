import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

import {
  benchmark,
  createAlgorithmSpecs,
  createMockCy,
  loadBrowserModules,
  parseEdgeListText,
  positionsFromCy,
  seedPositions
} from './report-shared.mjs';

async function runOneCase(graphName, algorithmKey) {
  const windowObj = loadBrowserModules();
  const algorithms = createAlgorithmSpecs(windowObj);
  const alg = algorithms.find((spec) => spec.key === algorithmKey);
  if (!alg) {
    return { kind: 'failure', type: 'unknown-algorithm', reason: algorithmKey };
  }

  const sample = windowObj.PlanarVibeGraphGenerator.getSample(graphName);
  if (!sample) {
    return { kind: 'failure', type: 'missing-sample', reason: graphName };
  }

  const parsed = parseEdgeListText(sample);
  const cy = createMockCy(parsed.nodeIds, parsed.edgePairs);
  seedPositions(cy, parsed.nodeIds, graphName);

  let result;
  try {
    result = await Promise.resolve(alg.run(cy));
  } catch (err) {
    return {
      kind: 'skip',
      reason: err && err.message ? err.message : String(err)
    };
  }

  if (!(result && result.ok)) {
    return {
      kind: 'skip',
      reason: result && result.message ? result.message : 'layout failed'
    };
  }

  const posById = positionsFromCy(cy);
  if (windowObj.GeometryUtils.hasPositionCrossings(posById, parsed.edgePairs)) {
    return { kind: 'skip', reason: 'non-plane drawing' };
  }

  const before = windowObj.PlanarVibeMetrics.computeAxisAlignmentScore(parsed.nodeIds, posById);
  const aligned = windowObj.PlanarVibeAlignment.alignToAxisGreedy(parsed.nodeIds, parsed.edgePairs, posById);
  if (!(aligned && aligned.ok)) {
    return {
      kind: 'failure',
      type: 'align-failed',
      reason: aligned && aligned.reason ? aligned.reason : 'unknown'
    };
  }

  const after = windowObj.PlanarVibeMetrics.computeAxisAlignmentScore(parsed.nodeIds, aligned.positions);
  if (!(before && before.ok && after && after.ok)) {
    return { kind: 'failure', type: 'metric-failed', reason: 'score unavailable' };
  }

  return {
    kind: 'ok',
    before: before.score,
    after: after.score,
    mergedX: aligned.mergedCountX,
    mergedY: aligned.mergedCountY
  };
}

function parseFilterList(value) {
  if (!value) return null;
  const items = String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? new Set(items) : null;
}

function runWorkerCase(scriptUrl, graphName, algorithmKey, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(scriptUrl, {
      type: 'module',
      workerData: {
        graphName,
        algorithmKey
      }
    });

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }

    const timer = setTimeout(() => {
      finish({ kind: 'skip', reason: `timeout ${timeoutMs}ms` });
      worker.terminate().catch(function ignoreTerminateError() {});
    }, timeoutMs);

    worker.on('message', (msg) => finish(msg));
    worker.on('error', (err) => {
      finish({
        kind: 'failure',
        type: 'worker-error',
        reason: err && err.message ? err.message : String(err)
      });
    });
    worker.on('exit', (code) => {
      if (!settled) {
        finish({
          kind: 'failure',
          type: 'worker-exit',
          reason: `exit ${code}`
        });
      }
    });
  });
}

async function main() {
  const graphFilter = parseFilterList(process.env.REPORT_GRAPHS);
  const algorithmFilter = parseFilterList(process.env.REPORT_ALGS);
  const timeoutMs = Number.isFinite(Number(process.env.ALIGN_SWEEP_TIMEOUT_MS))
    ? Math.max(1000, Math.floor(Number(process.env.ALIGN_SWEEP_TIMEOUT_MS)))
    : 30000;

  const windowObj = loadBrowserModules();
  const algorithms = createAlgorithmSpecs(windowObj)
    .filter((alg) => !algorithmFilter || algorithmFilter.has(alg.key));
  const graphs = benchmark.filter((graphName) => !graphFilter || graphFilter.has(graphName));

  const regressions = [];
  let okCount = 0;
  let skipped = 0;

  for (const graphName of graphs) {
    for (const alg of algorithms) {
      const res = await runWorkerCase(new URL(import.meta.url), graphName, alg.key, timeoutMs);
      if (res.kind === 'ok') {
        okCount += 1;
        if (res.after + 1e-12 < res.before) {
          regressions.push({
            graph: graphName,
            alg: alg.key,
            before: res.before,
            after: res.after,
            mergedX: res.mergedX,
            mergedY: res.mergedY
          });
        }
      } else if (res.kind === 'skip') {
        skipped += 1;
      } else {
        regressions.push({
          graph: graphName,
          alg: alg.key,
          type: res.type,
          reason: res.reason || ''
        });
      }
      process.stdout.write(`Checked ${graphName} :: ${alg.key} -> ${res.kind}\n`);
    }
  }

  process.stdout.write(`${JSON.stringify({
    okCount,
    skipped,
    regressionCount: regressions.length,
    regressions
  }, null, 2)}\n`);
}

if (isMainThread) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
} else {
  runOneCase(
    String(workerData && workerData.graphName ? workerData.graphName : ''),
    String(workerData && workerData.algorithmKey ? workerData.algorithmKey : '')
  ).then((result) => {
    parentPort.postMessage(result);
  }).catch((err) => {
    parentPort.postMessage({
      kind: 'failure',
      type: 'worker-error',
      reason: err && err.message ? err.message : String(err)
    });
  });
}
