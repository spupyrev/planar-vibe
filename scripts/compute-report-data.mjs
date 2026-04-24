import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import {
  REPORT_DATA_CSV,
  REPORT_INSTANCE_TIMEOUT_MS,
  benchmark,
  createAlgorithmSpecs,
  csvEscape,
  loadBrowserModules,
  parseEdgeListText
} from './report-shared.mjs';

function parseFilterList(value) {
  if (!value) return null;
  const items = String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? new Set(items) : null;
}

function buildFailureRecord(generatedAt, graphName, alg, graphInfo, runtimeMs, message) {
  return {
    generatedAt,
    graph: graphName,
    n: graphInfo.n,
    m: graphInfo.m,
    algorithm: alg.key,
    algorithmLabel: alg.label,
    runtimeMs,
    ok: false,
    message: String(message || 'failed'),
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
}

function runOneInstance(workerPath, generatedAt, graphName, alg, graphInfo, timeoutMs) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    let settled = false;
    const worker = new Worker(workerPath, {
      workerData: {
        graphName,
        algorithmKey: alg.key
      }
    });

    function finish(rec) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(rec);
    }

    const timer = setTimeout(() => {
      finish(buildFailureRecord(
        generatedAt,
        graphName,
        alg,
        graphInfo,
        timeoutMs,
        `TLE (${Math.round(timeoutMs / 1000)}s)`
      ));
      worker.terminate().catch(function ignoreTerminateError() {});
    }, timeoutMs);

    worker.on('message', (msg) => {
      const runtimeMs = Number(process.hrtime.bigint() - started) / 1e6;
      if (msg && msg.ok && msg.rec) {
        finish({
          generatedAt,
          graph: graphName,
          n: graphInfo.n,
          m: graphInfo.m,
          algorithm: alg.key,
          algorithmLabel: alg.label,
          runtimeMs: Number.isFinite(msg.rec.runtimeMs) ? msg.rec.runtimeMs : runtimeMs,
          ok: !!msg.rec.ok,
          message: msg.rec.message ? String(msg.rec.message) : '',
          angularResolution: Number.isFinite(msg.rec.angularResolution) ? msg.rec.angularResolution : null,
          aspectRatio: Number.isFinite(msg.rec.aspectRatio) ? msg.rec.aspectRatio : null,
          convexity: Number.isFinite(msg.rec.convexity) ? msg.rec.convexity : null,
          edgeLengthDeviation: Number.isFinite(msg.rec.edgeLengthDeviation) ? msg.rec.edgeLengthDeviation : null,
          edgeRatio: Number.isFinite(msg.rec.edgeRatio) ? msg.rec.edgeRatio : null,
          edgeOrthogonality: Number.isFinite(msg.rec.edgeOrthogonality) ? msg.rec.edgeOrthogonality : null,
          face: Number.isFinite(msg.rec.face) ? msg.rec.face : null,
          nodeUniformity: Number.isFinite(msg.rec.nodeUniformity) ? msg.rec.nodeUniformity : null,
          alignment: Number.isFinite(msg.rec.alignment) ? msg.rec.alignment : null,
          spacing: Number.isFinite(msg.rec.spacing) ? msg.rec.spacing : null
        });
      } else {
        finish(buildFailureRecord(
          generatedAt,
          graphName,
          alg,
          graphInfo,
          runtimeMs,
          msg && msg.message ? msg.message : 'Instance failed'
        ));
      }
    });

    worker.on('error', (err) => {
      const runtimeMs = Number(process.hrtime.bigint() - started) / 1e6;
      finish(buildFailureRecord(
        generatedAt,
        graphName,
        alg,
        graphInfo,
        runtimeMs,
        err && err.message ? err.message : String(err)
      ));
    });

    worker.on('exit', (code) => {
      if (settled) return;
      const runtimeMs = Number(process.hrtime.bigint() - started) / 1e6;
      finish(buildFailureRecord(
        generatedAt,
        graphName,
        alg,
        graphInfo,
        runtimeMs,
        `Instance exited with code ${code}`
      ));
    });
  });
}

async function main() {
  const windowObj = loadBrowserModules();
  const Generator = windowObj.PlanarVibeGraphGenerator;
  const graphFilter = parseFilterList(process.env.REPORT_GRAPHS);
  const algorithmFilter = parseFilterList(process.env.REPORT_ALGS);
  const algorithms = createAlgorithmSpecs(windowObj).filter((alg) => !algorithmFilter || algorithmFilter.has(alg.key));
  const graphs = benchmark.filter((graphName) => !graphFilter || graphFilter.has(graphName));
  const generatedAt = new Date().toISOString();
  const instanceTimeoutMs = Number.isFinite(Number(process.env.REPORT_INSTANCE_TIMEOUT_MS))
    ? Math.max(1000, Math.floor(Number(process.env.REPORT_INSTANCE_TIMEOUT_MS)))
    : REPORT_INSTANCE_TIMEOUT_MS;
  const workerPath = path.resolve(process.cwd(), 'scripts/run-report-instance-worker.mjs');

  if (algorithms.length === 0) {
    throw new Error('REPORT_ALGS filter excluded all algorithms');
  }
  if (graphs.length === 0) {
    throw new Error('REPORT_GRAPHS filter excluded all benchmark graphs');
  }

  const header = [
    'generatedAt',
    'graph',
    'n',
    'm',
    'algorithm',
    'algorithmLabel',
    'runtimeMs',
    'ok',
    'message',
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

  const lines = [header.join(',')];

  for (const graphName of graphs) {
    const sample = Generator.getSample(graphName);
    if (!sample) throw new Error(`Missing sample: ${graphName}`);
    const parsed = parseEdgeListText(sample);
    const graphInfo = { n: parsed.nodeIds.length, m: parsed.edgePairs.length };

    for (const alg of algorithms) {
      const rec = await runOneInstance(workerPath, generatedAt, graphName, alg, graphInfo, instanceTimeoutMs);
      lines.push([
        csvEscape(rec.generatedAt),
        csvEscape(rec.graph),
        rec.n,
        rec.m,
        csvEscape(rec.algorithm),
        csvEscape(rec.algorithmLabel),
        csvEscape(Number.isFinite(rec.runtimeMs) ? rec.runtimeMs : ''),
        rec.ok ? '1' : '0',
        csvEscape(rec.message),
        csvEscape(rec.angularResolution ?? ''),
        csvEscape(rec.aspectRatio ?? ''),
        csvEscape(rec.convexity ?? ''),
        csvEscape(rec.edgeLengthDeviation ?? ''),
        csvEscape(rec.edgeRatio ?? ''),
        csvEscape(rec.edgeOrthogonality ?? ''),
        csvEscape(rec.face ?? ''),
        csvEscape(rec.nodeUniformity ?? ''),
        csvEscape(rec.alignment ?? ''),
        csvEscape(rec.spacing ?? '')
      ].join(','));

      process.stdout.write(`Done ${graphName} :: ${alg.label} (${rec.ok ? 'ok' : 'fail'})\n`);
    }
  }

  const outPath = path.resolve(process.cwd(), REPORT_DATA_CSV);
  fs.writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
  process.stdout.write(`Wrote ${REPORT_DATA_CSV}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
