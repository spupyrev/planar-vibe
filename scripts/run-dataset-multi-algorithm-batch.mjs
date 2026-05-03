import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { createAlgorithmSpecs, csvEscape, loadBrowserModules } from './report-shared.mjs';

const DEFAULT_TIMEOUT_MS = 30 * 1000;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_DATASET_FILES = [
  'benchmark/sample_graphs.dot',
  'benchmark/wiki.dot',
  'benchmark/gd_collection.dot',
  'benchmark/north.dot'
];
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

function datasetLabelFromPath(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

function getDefaultAlgorithms() {
  const specs = createAlgorithmSpecs(loadBrowserModules());
  return specs.map((spec) => String(spec.key));
}

function parseArgs(argv) {
  const opts = {
    algorithms: getDefaultAlgorithms(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    concurrency: DEFAULT_CONCURRENCY,
    outputCsv: path.join('evaluation_data', 'all-algorithms-4bench-results.csv'),
    scoresCsv: null,
    files: DEFAULT_DATASET_FILES.slice()
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--algorithms' && i + 1 < argv.length) {
      opts.algorithms = String(argv[i + 1]).split(',').map((s) => s.trim()).filter(Boolean);
      i += 1;
    } else if (arg === '--timeout-ms' && i + 1 < argv.length) {
      opts.timeoutMs = Math.max(1000, Math.floor(Number(argv[i + 1]) || DEFAULT_TIMEOUT_MS));
      i += 1;
    } else if (arg === '--concurrency' && i + 1 < argv.length) {
      opts.concurrency = Math.max(1, Math.floor(Number(argv[i + 1]) || DEFAULT_CONCURRENCY));
      i += 1;
    } else if (arg === '--output' && i + 1 < argv.length) {
      opts.outputCsv = String(argv[i + 1]);
      i += 1;
    } else if (arg === '--scores-output' && i + 1 < argv.length) {
      opts.scoresCsv = String(argv[i + 1]);
      i += 1;
    } else if (arg === '--files' && i + 1 < argv.length) {
      opts.files = String(argv[i + 1]).split(',').map((s) => s.trim()).filter(Boolean);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: node scripts/run-dataset-multi-algorithm-batch.mjs ' +
        '[--algorithms tutte,air,areagrad,...] [--timeout-ms 30000] [--concurrency 4] ' +
        '[--output evaluation_data/all-algorithms-4bench-results.csv] ' +
        '[--scores-output evaluation_data/all-algorithms-4bench-scores.csv] ' +
        '[--files benchmark/sample_graphs.dot,benchmark/wiki.dot,benchmark/gd_collection.dot,benchmark/north.dot]\n'
      );
      process.exit(0);
    }
  }

  return opts;
}

function defaultScoresPath(outputCsv) {
  const parsed = path.parse(outputCsv);
  const ext = parsed.ext || '.csv';
  return path.join(parsed.dir, `${parsed.name}-scores${ext}`);
}

function parseDotCollections(text) {
  const graphs = [];
  const lines = String(text || '').split(/\r?\n/);
  let current = null;

  function finishCurrent() {
    if (!current) {
      return;
    }
    graphs.push({
      graphName: current.graphName,
      parsed: {
        nodeIds: Array.from(current.nodes),
        edgePairs: current.edges,
        positionsById: current.positionsById
      }
    });
    current = null;
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line) {
      continue;
    }
    if (!current) {
      const start = line.match(/^(?:strict\s+)?graph\s+("?[^"{]+"?)\s*\{$/i);
      if (start) {
        current = {
          graphName: start[1].replace(/^"(.*)"$/, '$1').trim(),
          nodes: new Set(),
          edges: [],
          seen: new Set(),
          positionsById: {}
        };
      }
      continue;
    }
    if (line === '}') {
      finishCurrent();
      continue;
    }
    const statements = line.split(';');
    for (const statementRaw of statements) {
      const statement = statementRaw.trim();
      if (!statement) {
        continue;
      }
      if (statement === '}') {
        finishCurrent();
        break;
      }

      const vertexMatch = statement.match(/^v\s+("?[^"\s\[]+"?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)(?:\s+.*)?$/i);
      if (vertexMatch) {
        const id = vertexMatch[1].replace(/^"(.*)"$/, '$1');
        current.nodes.add(id);
        current.positionsById[id] = {
          x: Number(vertexMatch[2]),
          y: Number(vertexMatch[3])
        };
        continue;
      }

      const edgeMatch = statement.match(/^("?[^"\s\[]+"?)\s*--\s*("?[^"\s\[]+"?)/);
      if (edgeMatch) {
        const a = edgeMatch[1].replace(/^"(.*)"$/, '$1');
        const b = edgeMatch[2].replace(/^"(.*)"$/, '$1');
        if (a !== b) {
          current.nodes.add(a);
          current.nodes.add(b);
          const key = a < b ? `${a}::${b}` : `${b}::${a}`;
          if (!current.seen.has(key)) {
            current.seen.add(key);
            current.edges.push([a, b]);
          }
        }
        continue;
      }
      const nodeMatch = statement.match(/^("?[^"\s\[]+"?)$/);
      if (nodeMatch) {
        current.nodes.add(nodeMatch[1].replace(/^"(.*)"$/, '$1'));
      }
    }
  }

  finishCurrent();
  return graphs;
}

function loadDatasetGraphs(filePath) {
  const abs = path.resolve(process.cwd(), filePath);
  const text = fs.readFileSync(abs, 'utf8');
  return {
    dataset: datasetLabelFromPath(filePath),
    filePath,
    graphs: parseDotCollections(text)
  };
}

function emptyFailureRecord(job, runtimeMs, message) {
  return {
    dataset: job.dataset,
    graph: job.graphName,
    n: job.parsed.nodeIds.length,
    m: job.parsed.edgePairs.length,
    algorithm: job.algorithmKey,
    algorithmLabel: job.algorithmKey,
    runtimeMs,
    ok: false,
    message,
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
}

function runOne(workerPath, timeoutMs, job) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    let settled = false;
    const worker = new Worker(workerPath, {
      workerData: {
        dataset: job.dataset,
        graphName: job.graphName,
        algorithmKey: job.algorithmKey,
        parsed: job.parsed
      }
    });

    function finish(rec) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(rec);
    }

    const timer = setTimeout(() => {
      finish(emptyFailureRecord(job, timeoutMs, `TLE (${Math.round(timeoutMs / 1000)}s)`));
      worker.terminate().catch(function ignoreTerminateError() {});
    }, timeoutMs);

    worker.on('message', (msg) => {
      if (msg && msg.ok && msg.rec) {
        finish(msg.rec);
        return;
      }
      finish(emptyFailureRecord(
        job,
        Number(process.hrtime.bigint() - started) / 1e6,
        msg && msg.message ? String(msg.message) : 'Worker failed'
      ));
    });

    worker.on('error', (err) => {
      finish(emptyFailureRecord(
        job,
        Number(process.hrtime.bigint() - started) / 1e6,
        err && err.message ? err.message : String(err)
      ));
    });

    worker.on('exit', (code) => {
      if (settled || code === 0) {
        return;
      }
      finish(emptyFailureRecord(
        job,
        Number(process.hrtime.bigint() - started) / 1e6,
        `Worker exited with code ${code}`
      ));
    });
  });
}

function missingMetrics(rec) {
  return METRIC_KEYS.filter((key) => !Number.isFinite(rec[key]));
}

function classifyBreakage(rec) {
  if (rec.ok) {
    return missingMetrics(rec).length > 0 ? 'missing_metrics' : 'ok';
  }
  if (String(rec.message || '').startsWith('TLE')) {
    return 'tle';
  }
  return 'algorithm_failed';
}

function writeCsv(outPath, rows) {
  const header = [
    'dataset',
    'graph',
    'n',
    'm',
    'algorithm',
    'algorithmLabel',
    'runtimeMs',
    'ok',
    'message',
    'breakageType',
    'missingMetrics',
    'isPlane',
    ...METRIC_KEYS
  ];
  const lines = [header.join(',')];
  for (const rec of rows) {
    lines.push([
      csvEscape(rec.dataset),
      csvEscape(rec.graph),
      rec.n,
      rec.m,
      csvEscape(rec.algorithm),
      csvEscape(rec.algorithmLabel),
      csvEscape(Number.isFinite(rec.runtimeMs) ? rec.runtimeMs : ''),
      rec.ok ? '1' : '0',
      csvEscape(rec.message || ''),
      csvEscape(classifyBreakage(rec)),
      csvEscape(missingMetrics(rec).join('|')),
      csvEscape(rec.isPlane ?? ''),
      ...METRIC_KEYS.map((key) => csvEscape(rec[key] ?? ''))
    ].join(','));
  }
  fs.writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
}

function summarizeRows(rows) {
  const summary = {
    total: rows.length,
    breakages: 0,
    tle: 0,
    algorithmFailed: 0,
    missingMetrics: 0,
    byDataset: {},
    byAlgorithm: {}
  };

  for (const rec of rows) {
    const breakageType = classifyBreakage(rec);
    if (!summary.byDataset[rec.dataset]) {
      summary.byDataset[rec.dataset] = { total: 0, breakages: 0, tle: 0, algorithmFailed: 0, missingMetrics: 0 };
    }
    if (!summary.byAlgorithm[rec.algorithm]) {
      summary.byAlgorithm[rec.algorithm] = { total: 0, breakages: 0, tle: 0, algorithmFailed: 0, missingMetrics: 0 };
    }
    const datasetBucket = summary.byDataset[rec.dataset];
    const algBucket = summary.byAlgorithm[rec.algorithm];
    datasetBucket.total += 1;
    algBucket.total += 1;
    if (breakageType === 'ok') {
      continue;
    }
    summary.breakages += 1;
    datasetBucket.breakages += 1;
    algBucket.breakages += 1;
    if (breakageType === 'tle') {
      summary.tle += 1;
      datasetBucket.tle += 1;
      algBucket.tle += 1;
    } else if (breakageType === 'missing_metrics') {
      summary.missingMetrics += 1;
      datasetBucket.missingMetrics += 1;
      algBucket.missingMetrics += 1;
    } else {
      summary.algorithmFailed += 1;
      datasetBucket.algorithmFailed += 1;
      algBucket.algorithmFailed += 1;
    }
  }

  return summary;
}

function p50(values) {
  if (!values.length) {
    return null;
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function scoreMetricValue(rec, metricKey) {
  if (!rec.ok) {
    return 0;
  }
  return Number.isFinite(rec[metricKey]) ? rec[metricKey] : 0;
}

function computeEvaluationScores(rows, algorithmOrder) {
  const byAlgorithm = new Map();
  const labels = new Map();
  const order = [];
  const seen = new Set();

  function ensureAlgorithm(algorithm) {
    if (seen.has(algorithm)) {
      return;
    }
    seen.add(algorithm);
    order.push(algorithm);
  }

  for (const algorithm of algorithmOrder) {
    ensureAlgorithm(algorithm);
  }

  for (const rec of rows) {
    ensureAlgorithm(rec.algorithm);
    labels.set(rec.algorithm, rec.algorithmLabel || rec.algorithm);
    if (!byAlgorithm.has(rec.algorithm)) {
      byAlgorithm.set(rec.algorithm, []);
    }
    byAlgorithm.get(rec.algorithm).push(rec);
  }

  return order.map((algorithm) => {
    const algorithmRows = byAlgorithm.get(algorithm) || [];
    const metricP50 = {};
    for (const metricKey of METRIC_KEYS) {
      metricP50[metricKey] = p50(algorithmRows.map((rec) => scoreMetricValue(rec, metricKey)));
    }
    const presentMetrics = METRIC_KEYS
      .map((metricKey) => metricP50[metricKey])
      .filter((value) => Number.isFinite(value));
    const totalScore = presentMetrics.length
      ? presentMetrics.reduce((sum, value) => sum + value, 0) / presentMetrics.length
      : null;
    const breakageCounts = {
      tle: 0,
      algorithmFailed: 0,
      missingMetrics: 0
    };
    let successfulRuns = 0;
    for (const rec of algorithmRows) {
      const breakageType = classifyBreakage(rec);
      if (breakageType === 'ok') {
        successfulRuns += 1;
      } else if (breakageType === 'tle') {
        breakageCounts.tle += 1;
      } else if (breakageType === 'missing_metrics') {
        breakageCounts.missingMetrics += 1;
      } else {
        breakageCounts.algorithmFailed += 1;
      }
    }
    return {
      algorithm,
      algorithmLabel: labels.get(algorithm) || algorithm,
      totalRuns: algorithmRows.length,
      successfulRuns,
      breakages: algorithmRows.length - successfulRuns,
      ...breakageCounts,
      totalScore,
      metricP50
    };
  });
}

function writeScoresCsv(outPath, scores) {
  const header = [
    'algorithm',
    'algorithmLabel',
    'totalRuns',
    'successfulRuns',
    'breakages',
    'tle',
    'algorithmFailed',
    'missingMetrics',
    'totalScore',
    ...METRIC_KEYS.map((key) => `${key}P50`)
  ];
  const lines = [header.join(',')];
  for (const score of scores) {
    lines.push([
      csvEscape(score.algorithm),
      csvEscape(score.algorithmLabel),
      score.totalRuns,
      score.successfulRuns,
      score.breakages,
      score.tle,
      score.algorithmFailed,
      score.missingMetrics,
      csvEscape(score.totalScore ?? ''),
      ...METRIC_KEYS.map((key) => csvEscape(score.metricP50[key] ?? ''))
    ].join(','));
  }
  fs.writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
}

function formatScoreNumber(value) {
  return Number.isFinite(value) ? value.toFixed(6) : '--';
}

function printEvaluationScores(scores) {
  process.stdout.write('Evaluation scores (failures and missing metrics score 0.0 before p50):\n');
  for (const score of scores) {
    process.stdout.write(
      `${score.algorithm}: total_score=${formatScoreNumber(score.totalScore)}, ` +
      `runs=${score.totalRuns}, ok=${score.successfulRuns}, breakages=${score.breakages}\n`
    );
    process.stdout.write(
      `  metric_p50: ${METRIC_KEYS.map((key) => `${key}=${formatScoreNumber(score.metricP50[key])}`).join(', ')}\n`
    );
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const workerPath = path.resolve(process.cwd(), 'scripts/run-dataset-algorithm-batch-worker.mjs');
  const datasets = opts.files.map(loadDatasetGraphs);
  const jobs = [];
  for (const entry of datasets) {
    for (const graph of entry.graphs) {
      for (const algorithmKey of opts.algorithms) {
        jobs.push({
          dataset: entry.dataset,
          graphName: graph.graphName,
          parsed: graph.parsed,
          algorithmKey
        });
      }
    }
  }

  const rows = new Array(jobs.length);
  let nextIndex = 0;
  let completed = 0;

  async function workerLoop() {
    while (true) {
      const index = nextIndex;
      if (index >= jobs.length) {
        return;
      }
      nextIndex += 1;
      const job = jobs[index];
      const rec = await runOne(workerPath, opts.timeoutMs, job);
      rows[index] = rec;
      completed += 1;
      process.stdout.write(
        `[${completed}/${jobs.length}] ${job.dataset} :: ${job.graphName} :: ${job.algorithmKey} :: ${classifyBreakage(rec)}\n`
      );
    }
  }

  await Promise.all(Array.from({ length: opts.concurrency }, () => workerLoop()));

  const outPath = path.resolve(process.cwd(), opts.outputCsv);
  writeCsv(outPath, rows);
  const scoresPath = path.resolve(process.cwd(), opts.scoresCsv || defaultScoresPath(opts.outputCsv));
  const scores = computeEvaluationScores(rows, opts.algorithms);
  writeScoresCsv(scoresPath, scores);

  const summary = summarizeRows(rows);
  process.stdout.write(`Wrote ${path.relative(process.cwd(), outPath)}\n`);
  process.stdout.write(`Wrote ${path.relative(process.cwd(), scoresPath)}\n`);
  process.stdout.write(`Total rows: ${summary.total}\n`);
  process.stdout.write(`Breakages: ${summary.breakages}\n`);
  process.stdout.write(`TLE: ${summary.tle}\n`);
  process.stdout.write(`Algorithm failed: ${summary.algorithmFailed}\n`);
  process.stdout.write(`Missing metrics: ${summary.missingMetrics}\n`);
  for (const [dataset, bucket] of Object.entries(summary.byDataset)) {
    process.stdout.write(
      `${dataset}: total=${bucket.total}, breakages=${bucket.breakages}, ` +
      `tle=${bucket.tle}, algorithm_failed=${bucket.algorithmFailed}, missing_metrics=${bucket.missingMetrics}\n`
    );
  }
  for (const [algorithm, bucket] of Object.entries(summary.byAlgorithm)) {
    process.stdout.write(
      `${algorithm}: total=${bucket.total}, breakages=${bucket.breakages}, ` +
      `tle=${bucket.tle}, algorithm_failed=${bucket.algorithmFailed}, missing_metrics=${bucket.missingMetrics}\n`
    );
  }
  printEvaluationScores(scores);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
