import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

import {
  createIo,
  getAvailableAlgorithmSpecs,
  loadGraphs,
  matchesGlob,
  resolveAlgorithmPatterns
} from './apply-layout-js.mjs';

const DEFAULT_TIMEOUT_MS = 30 * 1000;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_OUTPUT = path.join('evaluation_data', 'layout-table-cache-cpp.json');
const DEFAULT_CPP_BIN = path.join('src-cpp', 'build', 'apply_layout');
const CACHE_SCHEMA = 'planarvibe-layout-table-cache';
const CACHE_VERSION = 1;
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

function usage(message, io) {
  const out = createIo(io);
  if (message) {
    out.stderr.write(`${message}\n\n`);
  }
  out.stderr.write(
    'Usage: node scripts/layout-cache-runner.mjs <graph-file> <graph-pattern> ' +
    '[--algorithms gpt,claude,tutte|*balancer*|*] [--timeout 30] [--concurrency 1] ' +
    '[--cpp-bin src-cpp/build/apply_layout] [--output evaluation_data/layout-table-cache-cpp.json]\n'
  );
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
  }

  const positionals = [];
  const opts = {
    algorithms: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    concurrency: DEFAULT_CONCURRENCY,
    outputPath: DEFAULT_OUTPUT,
    cppBin: DEFAULT_CPP_BIN
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--algorithms' && i + 1 < argv.length) {
      opts.algorithms = String(argv[i + 1]).split(',').map((s) => s.trim()).filter(Boolean);
      i += 1;
      continue;
    }
    if (arg === '--timeout' && i + 1 < argv.length) {
      opts.timeoutMs = Math.max(1000, Math.floor((Number(argv[i + 1]) || 30) * 1000));
      i += 1;
      continue;
    }
    if (arg === '--concurrency' && i + 1 < argv.length) {
      opts.concurrency = Math.max(1, Math.floor(Number(argv[i + 1]) || DEFAULT_CONCURRENCY));
      i += 1;
      continue;
    }
    if (arg === '--cpp-bin' && i + 1 < argv.length) {
      opts.cppBin = String(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--output' && i + 1 < argv.length) {
      opts.outputPath = String(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      usage(`Unknown option: ${arg}`);
      process.exit(1);
    }
    positionals.push(arg);
  }

  if (positionals.length !== 2) {
    usage('Expected exactly 2 positional arguments: <graph-file> <graph-pattern>.');
    process.exit(1);
  }
  opts.filePath = String(positionals[0]);
  opts.graphPattern = String(positionals[1]);
  return opts;
}

function writeJsonFile(filePath, value) {
  const absPath = path.resolve(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return absPath;
}

function positionsFromCpp(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const out = {};
  for (const [id, pos] of Object.entries(value)) {
    if (Array.isArray(pos) && pos.length >= 2) {
      const x = Number(pos[0]);
      const y = Number(pos[1]);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        out[id] = { x, y };
      }
      continue;
    }
    if (pos && typeof pos === 'object') {
      const x = Number(pos.x);
      const y = Number(pos.y);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        out[id] = { x, y };
      }
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function metricValue(metrics, key) {
  const value = metrics && metrics[key];
  return Number.isFinite(value) ? value : null;
}

function convertCppRecord(record, dataset, graph, algorithm) {
  const metrics = record && record.metrics && typeof record.metrics === 'object'
    ? record.metrics
    : null;
  const rec = {
    dataset: dataset.dataset,
    graph: graph.graphName,
    n: graph.parsed.nodeIds.length,
    m: graph.parsed.edgePairs.length,
    algorithm: algorithm.key,
    algorithmLabel: algorithm.label,
    runtimeMs: Number.isFinite(record && record.runtime_ms) ? record.runtime_ms : null,
    ok: !!(record && record.ok),
    message: record && record.message ? String(record.message) : '',
    isPlane: metrics && typeof metrics.isPlane === 'boolean' ? (metrics.isPlane ? 1 : 0) : null,
    positions: positionsFromCpp(record && record.positions)
  };

  for (const key of METRIC_KEYS) {
    rec[key] = metricValue(metrics, key);
  }

  if (rec.ok && rec.isPlane === 0) {
    rec.ok = false;
    rec.message = rec.message ? `${rec.message} [non-plane drawing]` : 'non-plane drawing';
  }
  return rec;
}

function failureRecord(dataset, graph, algorithm, message, runtimeMs) {
  const rec = {
    dataset: dataset.dataset,
    graph: graph.graphName,
    n: graph.parsed.nodeIds.length,
    m: graph.parsed.edgePairs.length,
    algorithm: algorithm.key,
    algorithmLabel: algorithm.label,
    runtimeMs,
    ok: false,
    message,
    isPlane: null,
    positions: null
  };
  for (const key of METRIC_KEYS) {
    rec[key] = null;
  }
  return rec;
}

function runCppOne(cppBin, timeoutMs, tempDir, dataset, graph, algorithm) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const outPath = path.join(
      tempDir,
      `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
    );
    const child = execFile(
      path.resolve(process.cwd(), cppBin),
      [dataset.filePath, graph.graphName, algorithm.key, '--out', outPath],
      {
        cwd: process.cwd(),
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024
      },
      (err, stdout, stderr) => {
        const runtimeMs = Number(process.hrtime.bigint() - started) / 1e6;
        try {
          if (err) {
            const timedOut = err.killed || err.signal === 'SIGTERM';
            const message = timedOut
              ? `TLE (${Math.round(timeoutMs / 1000)}s)`
              : (stderr.trim() || stdout.trim() || err.message || 'C++ layout failed');
            resolve(failureRecord(dataset, graph, algorithm, message, timedOut ? timeoutMs : runtimeMs));
            return;
          }
          const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
          resolve(convertCppRecord(parsed, dataset, graph, algorithm));
        } catch (parseErr) {
          resolve(failureRecord(
            dataset,
            graph,
            algorithm,
            parseErr && parseErr.message ? parseErr.message : String(parseErr),
            runtimeMs
          ));
        } finally {
          fs.rmSync(outPath, { force: true });
        }
      }
    );
    child.on('error', () => {});
  });
}

async function runJobs(jobs, opts, tempDir, out) {
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
      const rec = await runCppOne(opts.cppBin, opts.timeoutMs, tempDir, job.dataset, job.graph, job.algorithm);
      job.row.results.push(rec);
      completed += 1;
      out.stdout.write(`[${completed}/${jobs.length}] ${job.graph.graphName} :: ${job.algorithm.label}\n`);
    }
  }

  await Promise.all(Array.from({ length: Math.min(opts.concurrency, jobs.length) }, () => workerLoop()));
}

export async function runCli(argv = process.argv.slice(2), io) {
  const out = createIo(io);
  const opts = parseArgs(argv);
  const dataset = loadGraphs(opts.filePath);
  const algorithms = resolveAlgorithmPatterns(getAvailableAlgorithmSpecs(), opts.algorithms);
  const matchedGraphs = dataset.graphs.filter((graph) => matchesGlob(graph.graphName, opts.graphPattern));
  if (matchedGraphs.length === 0) {
    throw new Error(`No graphs in ${dataset.filePath} matched "${opts.graphPattern}".`);
  }
  const cppBinPath = path.resolve(process.cwd(), opts.cppBin);
  if (!fs.existsSync(cppBinPath)) {
    throw new Error(`C++ binary not found: ${opts.cppBin}. Run make -C src-cpp first.`);
  }

  const rows = matchedGraphs.map((graph) => ({
    graphName: graph.graphName,
    parsed: graph.parsed,
    results: []
  }));
  const jobs = [];
  for (let i = 0; i < matchedGraphs.length; i += 1) {
    for (const algorithm of algorithms) {
      jobs.push({ dataset, graph: matchedGraphs[i], row: rows[i], algorithm });
    }
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'planarvibe-cpp-cache-'));
  try {
    await runJobs(jobs, opts, tempDir, out);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const order = new Map(algorithms.map((algorithm, index) => [algorithm.key, index]));
  for (const row of rows) {
    row.results.sort((a, b) => order.get(a.algorithm) - order.get(b.algorithm));
  }

  const cache = {
    schema: CACHE_SCHEMA,
    version: CACHE_VERSION,
    generatedAt: new Date().toISOString(),
    dataset: {
      name: dataset.dataset,
      filePath: dataset.filePath
    },
    graphPattern: opts.graphPattern,
    algorithms,
    rows
  };
  const absOutputPath = writeJsonFile(opts.outputPath, cache);
  out.stdout.write(`Wrote ${path.relative(process.cwd(), absOutputPath)}\n`);
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMainModule) {
  runCli().catch((err) => {
    usage(undefined, { stderr: process.stderr });
    process.stderr.write(`${err && err.message ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
