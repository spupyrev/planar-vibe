import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildSvgMarkup,
  createIo,
  escapeXml,
  formatValue,
  getAvailableAlgorithmSpecs,
  getWorkerPath,
  matchesGlob,
  loadGraphs,
  resolveAlgorithmPatterns,
  runOne
} from './apply-layout-js.mjs';

const DEFAULT_TIMEOUT_MS = 30 * 1000;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_OUTPUT = 'layout-table.html';
const DEFAULT_CACHE_OUTPUT = path.join('evaluation_data', 'layout-table-cache.json');
const CACHE_SCHEMA = 'planarvibe-layout-table-cache';
const CACHE_VERSION = 1;
const SCORE_METRIC_KEYS = [
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
const DISPLAY_ALGORITHM_ORDER = [
  'input',
  'gpt',
  'claude',
  'schnyder',
  'fpp',
  'tutte',
  'ceg_bfs',
  'ceg_xy',
  'reweight',
  'forcedir',
  'impred',
  'air',
  'anglebalancer',
  'edgebalancer',
  'facebalancer'
];
const DISPLAY_ALGORITHM_LABELS = new Map([
  ['input', 'Human'],
  ['gpt', 'GPTHybrid'],
  ['claude', 'ClaudeHybrid']
]);

export function usage(message, io) {
  const out = createIo(io);
  if (message) {
    out.stderr.write(`${message}\n\n`);
  }
  out.stderr.write(
    'Usage: node scripts/layout-html-renderer.mjs <graph-file> <graph-pattern> [--algorithms input,tutte,air|*balancer*|*] [--timeout 30] [--output layout-table.html] [--cache-output evaluation_data/layout-table-cache.json]\n' +
    '       node scripts/layout-html-renderer.mjs --from-cache evaluation_data/layout-table-cache.json [--output layout-table.html]\n' +
    '       node scripts/layout-html-renderer.mjs <graph-file> <graph-pattern> --cache-only [--algorithms input,tutte,air|*balancer*|*] [--timeout 30] [--concurrency 1] [--update-cache] [--checkpoint-interval 0] [--output evaluation_data/layout-table-cache.json]\n' +
    'Example: ./scripts/layout-html --only sample\n' +
    'Example: node scripts/layout-html-renderer.mjs --from-cache evaluation_data/sample-layout-table-cache.json --output layout-table.html\n'
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
    outputPath: null,
    cacheOutputPath: null,
    cacheOnly: false,
    fromCachePath: null,
    updateCache: false,
    checkpointInterval: 0
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cache-only') {
      opts.cacheOnly = true;
      continue;
    }
    if (arg === '--update-cache') {
      opts.updateCache = true;
      continue;
    }
    if (arg === '--from-cache' && i + 1 < argv.length) {
      opts.fromCachePath = String(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--cache-output' && i + 1 < argv.length) {
      opts.cacheOutputPath = String(argv[i + 1]);
      i += 1;
      continue;
    }
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
    if (arg === '--checkpoint-interval' && i + 1 < argv.length) {
      opts.checkpointInterval = Math.max(0, Math.floor(Number(argv[i + 1]) || 0));
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

  if (opts.fromCachePath) {
    if (positionals.length !== 0) {
      usage('--from-cache does not accept <graph-file> or <graph-pattern> arguments.');
      process.exit(1);
    }
    if (opts.cacheOnly) {
      usage('--cache-only cannot be combined with --from-cache.');
      process.exit(1);
    }
    if (opts.updateCache) {
      usage('--update-cache cannot be combined with --from-cache.');
      process.exit(1);
    }
    if (opts.algorithms) {
      usage('--algorithms cannot be used when rendering from cache.');
      process.exit(1);
    }
    opts.outputPath = opts.outputPath || DEFAULT_OUTPUT;
    return opts;
  }

  if (positionals.length !== 2) {
    usage('Expected exactly 2 positional arguments: <graph-file> <graph-pattern>.');
    process.exit(1);
  }

  opts.filePath = String(positionals[0]);
  opts.graphPattern = String(positionals[1]);
  opts.outputPath = opts.outputPath || (opts.cacheOnly ? DEFAULT_CACHE_OUTPUT : DEFAULT_OUTPUT);
  return opts;
}

function displayAlgorithmLabel(algorithm) {
  return DISPLAY_ALGORITHM_LABELS.get(algorithm.key) || algorithm.label;
}

function orderAlgorithmsForDisplay(algorithms) {
  const displayOrder = new Map(DISPLAY_ALGORITHM_ORDER.map((key, index) => [key, index]));
  return [...algorithms].sort((a, b) => {
    const ai = displayOrder.has(a.key) ? displayOrder.get(a.key) : Number.MAX_SAFE_INTEGER;
    const bi = displayOrder.has(b.key) ? displayOrder.get(b.key) : Number.MAX_SAFE_INTEGER;
    if (ai !== bi) {
      return ai - bi;
    }
    return String(a.key || '').localeCompare(String(b.key || ''));
  });
}

function renderCellSvg(graph, rec) {
  if (!rec.positions) {
    return '';
  }
  const svg = buildSvgMarkup(rec.positions, graph.parsed.edgePairs, { includeXmlDeclaration: false });
  return svg ? svg.markup : '';
}

function meanMetricScore(rec) {
  const values = SCORE_METRIC_KEYS.map((key) => rec[key]);
  if (values.some((value) => !Number.isFinite(value))) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function renderCell(graph, rec, algorithmLabel) {
  const statusClass = rec.ok ? 'is-ok' : 'is-fail';
  const pieces = [];
  if (!rec.ok) {
    pieces.push(`<div class="cell-status ${statusClass}">${escapeXml('failed')}</div>`);
  }
  const svg = renderCellSvg(graph, rec);
  const labelAttr = ` data-label="${escapeXml(algorithmLabel)}"`;
  if (svg) {
    pieces.push(`<div class="drawing"${labelAttr}>${svg}</div>`);
  } else {
    pieces.push(`<div class="cell-error"${labelAttr}>No drawing available</div>`);
  }
  if (!rec.ok) {
    pieces.push(`<div class="cell-message">${escapeXml(rec.message || 'failed')}</div>`);
  } else {
    if (!svg) {
      pieces.push('<div class="cell-message">Drawing export was unavailable</div>');
    }
  }
  const score = meanMetricScore(rec);
  pieces.push(`<div class="cell-meta">runtime ${formatValue(rec.runtimeMs / 1000, 1)} s | score ${formatValue(score, 3)}</div>`);
  return pieces.join('');
}

export function buildHtml(dataset, regexText, algorithms, rows) {
  const displayAlgorithms = orderAlgorithmsForDisplay(algorithms);
  const headerCells = displayAlgorithms.map((alg) => `<th scope="col">${escapeXml(displayAlgorithmLabel(alg))}</th>`).join('');
  const bodyRows = rows.map((row) => {
    const graphLabel = [
      escapeXml(row.graphName),
      `<span class="graph-size">|V| = ${row.parsed.nodeIds.length}, |E| = ${row.parsed.edgePairs.length}</span>`
    ].join('<br>');
    const resultsByAlgorithm = new Map(row.results.map((result) => [result.algorithm, result]));
    const cells = displayAlgorithms.map((algorithm) => {
      const result = resultsByAlgorithm.get(algorithm.key);
      const algorithmLabel = displayAlgorithmLabel(algorithm);
      return `<td>${result ? renderCell(row, result, algorithmLabel) : `<div class="cell-error" data-label="${escapeXml(algorithmLabel)}">No result available</div>`}</td>`;
    }).join('');
    return `<tr><th scope="row">${graphLabel}</th>${cells}</tr>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PlanarVibe: Gallery</title>
  <link href="static/img/favicon.png" type="image/ico" rel="shortcut icon" />
  <style>
    :root {
      --bg: #f6f3ea;
      --panel: #fffdf8;
      --ink: #1b2430;
      --muted: #6b7280;
      --line: #d8d2c2;
      --accent: #1060A8;
      --ok: #23673c;
      --fail: #8b2e2e;
    }
    * { box-sizing: border-box; }
    body {
      height: 100vh;
      margin: 0;
      font-family: "Segoe UI", Arial, sans-serif;
      color: var(--ink);
      overflow: hidden;
      background:
        radial-gradient(circle at top left, #fff7df 0, transparent 30%),
        linear-gradient(180deg, #f8f5ee 0%, #f1ebdd 100%);
    }
    main {
      height: 100vh;
      min-height: 0;
      padding: 24px;
      display: flex;
      flex-direction: column;
    }
    .summary {
      margin: 0 0 20px;
      color: var(--muted);
    }
    .table-wrap {
      flex: 1 1 0;
      min-height: 0;
      overflow: auto;
      border: 1px solid var(--line);
      background: var(--panel);
      box-shadow: 0 10px 30px rgba(17, 17, 17, 0.08);
    }
    table {
      width: max-content;
      min-width: 100%;
      border-collapse: collapse;
    }
    th, td {
      border: 1px solid var(--line);
      vertical-align: top;
      background: rgba(255, 253, 248, 0.96);
    }
    thead th {
      position: sticky;
      top: 0;
      z-index: 3;
      background: #efe7d6;
      padding: 12px;
      min-width: 260px;
    }
    thead th:first-child {
      left: 0;
      z-index: 4;
    }
    tbody th {
      position: sticky;
      left: 0;
      z-index: 2;
      min-width: 220px;
      padding: 12px;
      text-align: left;
      background: #f7f2e7;
    }
    .graph-size {
      display: inline-block;
      margin-top: 4px;
      color: var(--muted);
      font-weight: 500;
      white-space: nowrap;
    }
    td {
      padding: 10px;
      width: 260px;
    }
    .cell-status {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 8px;
    }
    .cell-status.is-ok {
      color: var(--ok);
      background: #e3f1e8;
    }
    .cell-status.is-fail {
      color: var(--fail);
      background: #f7e1e1;
    }
    .drawing {
      width: 220px;
      height: 150px;
      margin: 0 auto 8px;
      border: 1px solid var(--line);
      background: #ffffff;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .drawing svg {
      width: 220px;
      height: 150px;
      display: block;
    }
    .cell-error {
      min-height: 150px;
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      color: var(--fail);
      font-size: 13px;
      padding: 12px;
      background: #fff8f8;
      border: 1px dashed #dfb3b3;
      margin-bottom: 8px;
    }
    .cell-meta {
      color: var(--muted);
      font-size: 12px;
      text-align: center;
    }
    .cell-message {
      margin-bottom: 8px;
      color: var(--fail);
      font-size: 13px;
      text-align: center;
    }
    @media (max-width: 720px) {
      body {
        height: auto;
        min-height: 100vh;
        overflow: auto;
        background: #f8f5ee;
      }
      main {
        height: auto;
        min-height: 100vh;
        padding: 12px;
        display: block;
      }
      .summary {
        margin: 0 0 12px;
        font-size: 14px;
        line-height: 1.35;
        max-width: 100%;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .table-wrap {
        overflow: visible;
        border: 0;
        background: transparent;
        box-shadow: none;
      }
      table,
      thead,
      tbody,
      tr,
      th,
      td {
        display: block;
        width: 100%;
      }
      table {
        min-width: 0;
        border-collapse: separate;
        border-spacing: 0;
      }
      thead {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
      }
      tbody tr {
        margin: 0 0 16px;
        overflow: hidden;
        border: 1px solid var(--line);
        background: var(--panel);
        box-shadow: 0 6px 18px rgba(17, 17, 17, 0.08);
      }
      tbody th {
        position: static;
        min-width: 0;
        padding: 12px;
        border: 0;
        border-bottom: 1px solid var(--line);
        background: #efe7d6;
      }
      td {
        width: 100%;
        padding: 12px;
        border-width: 0 0 1px;
      }
      td:last-child {
        border-bottom: 0;
      }
      .drawing,
      .cell-error {
        position: relative;
      }
      .drawing::before,
      .cell-error::before {
        display: block;
        position: absolute;
        top: 6px;
        left: 6px;
        z-index: 1;
        margin: 0;
        padding: 3px 7px;
        color: #ffffff;
        background: rgba(16, 96, 168, 0.9);
        border-radius: 4px;
        font-size: 13px;
        font-weight: 700;
        line-height: 1.2;
        content: attr(data-label);
      }
      .drawing {
        width: 100%;
        max-width: 340px;
        height: auto;
        aspect-ratio: 22 / 15;
      }
      .drawing svg {
        width: 100%;
        height: 100%;
      }
      .cell-error {
        min-height: 120px;
      }
    }
  </style>
</head>
<body>
  <main>
    <p class="summary">Dataset: ${escapeXml(dataset.filePath)} | Graphs: ${rows.length} | Algorithms: ${algorithms.length}</p>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Graph</th>
            ${headerCells}
          </tr>
        </thead>
        <tbody>
          ${bodyRows}
        </tbody>
      </table>
    </div>
  </main>
</body>
</html>
`;
}

function writeTextFile(filePath, content) {
  const absPath = path.resolve(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf8');
  return absPath;
}

function writeJsonFile(filePath, value) {
  return writeTextFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function buildCacheRecord(dataset, graphPattern, algorithms, rows) {
  return {
    schema: CACHE_SCHEMA,
    version: CACHE_VERSION,
    generatedAt: new Date().toISOString(),
    dataset: {
      name: dataset.dataset,
      filePath: dataset.filePath
    },
    graphPattern,
    algorithms,
    rows
  };
}

function readCacheRecord(cachePath) {
  const absPath = path.resolve(process.cwd(), cachePath);
  const cache = JSON.parse(fs.readFileSync(absPath, 'utf8'));
  if (!cache || cache.schema !== CACHE_SCHEMA || cache.version !== CACHE_VERSION) {
    throw new Error(`Unsupported layout table cache: ${cachePath}`);
  }
  if (!cache.dataset || !Array.isArray(cache.algorithms) || !Array.isArray(cache.rows)) {
    throw new Error(`Malformed layout table cache: ${cachePath}`);
  }
  return cache;
}

function mergeAlgorithmSpecs(existingAlgorithms, selectedAlgorithms) {
  const merged = [];
  const seen = new Set();
  for (const algorithm of [...(existingAlgorithms || []), ...selectedAlgorithms]) {
    if (!algorithm || !algorithm.key || seen.has(algorithm.key)) {
      continue;
    }
    seen.add(algorithm.key);
    merged.push(algorithm);
  }
  return merged;
}

function findCacheResult(row, algorithmKey) {
  return row && Array.isArray(row.results)
    ? row.results.find((result) => result && result.algorithm === algorithmKey)
    : null;
}

function sortRowResults(row, algorithms) {
  const order = new Map(algorithms.map((algorithm, index) => [algorithm.key, index]));
  row.results.sort((a, b) => {
    const ai = order.has(a.algorithm) ? order.get(a.algorithm) : Number.MAX_SAFE_INTEGER;
    const bi = order.has(b.algorithm) ? order.get(b.algorithm) : Number.MAX_SAFE_INTEGER;
    if (ai !== bi) {
      return ai - bi;
    }
    return String(a.algorithm || '').localeCompare(String(b.algorithm || ''));
  });
}

function readExistingCacheForUpdate(cachePath, dataset, out) {
  const absPath = path.resolve(process.cwd(), cachePath);
  if (!fs.existsSync(absPath)) {
    return null;
  }
  const cache = readCacheRecord(cachePath);
  if (!cache.dataset || cache.dataset.filePath !== dataset.filePath) {
    throw new Error(
      `Refusing to update ${cachePath}: cached dataset is ${cache.dataset && cache.dataset.filePath ? cache.dataset.filePath : 'unknown'}, ` +
      `but requested ${dataset.filePath}.`
    );
  }
  out.stdout.write(`Read ${path.relative(process.cwd(), absPath)}\n`);
  return cache;
}

async function runMissingJobs(jobs, workerPath, timeoutMs, concurrency, out, onJobComplete) {
  if (jobs.length === 0) {
    out.stdout.write('All selected algorithm results were already cached.\n');
    return;
  }

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
      const rec = await runOne(
        workerPath,
        job.algorithm.key,
        timeoutMs,
        job.dataset.dataset,
        job.graph.graphName,
        job.graph.parsed,
        true
      );
      job.row.results.push(rec);
      completed += 1;
      if (onJobComplete) {
        onJobComplete(completed);
      }
      out.stdout.write(`[${completed}/${jobs.length}] ${job.graph.graphName} :: ${job.algorithm.label}\n`);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => workerLoop()));
}

async function buildRows(dataset, graphPattern, selectedAlgorithms, timeoutMs, out, opts = {}) {
  const matchedGraphs = dataset.graphs.filter((graph) => matchesGlob(graph.graphName, graphPattern));
  if (matchedGraphs.length === 0) {
    throw new Error(`No graphs in ${dataset.filePath} matched "${graphPattern}".`);
  }

  const existingRowsByName = new Map();
  if (opts.existingCache) {
    for (const row of opts.existingCache.rows) {
      existingRowsByName.set(row.graphName, row);
    }
  }

  const rows = matchedGraphs.map((graph) => {
    const existingRow = existingRowsByName.get(graph.graphName);
    if (!existingRow) {
      return {
        graphName: graph.graphName,
        parsed: graph.parsed,
        results: []
      };
    }
    return {
      ...existingRow,
      parsed: existingRow.parsed || graph.parsed,
      results: Array.isArray(existingRow.results) ? existingRow.results.slice() : []
    };
  });

  const workerPath = getWorkerPath();
  const jobs = [];
  for (let i = 0; i < matchedGraphs.length; i += 1) {
    const graph = matchedGraphs[i];
    const row = rows[i];
    for (let j = 0; j < selectedAlgorithms.length; j += 1) {
      const algorithm = selectedAlgorithms[j];
      if (opts.existingCache && findCacheResult(row, algorithm.key)) {
        continue;
      }
      jobs.push({ dataset, graph, row, algorithm });
    }
  }
  const algorithmsForSort = opts.algorithmsForSort || selectedAlgorithms;
  const sortAllRows = () => {
    for (const row of rows) {
      sortRowResults(row, algorithmsForSort);
    }
  };
  await runMissingJobs(jobs, workerPath, timeoutMs, opts.concurrency || DEFAULT_CONCURRENCY, out, (completed) => {
    if (!opts.onCheckpoint || !opts.checkpointInterval || completed % opts.checkpointInterval !== 0) {
      return;
    }
    sortAllRows();
    opts.onCheckpoint(rows, completed, jobs.length);
  });

  sortAllRows();
  if (opts.onCheckpoint && jobs.length > 0) {
    opts.onCheckpoint(rows, jobs.length, jobs.length);
  }
  return rows;
}

export async function runCli(argv = process.argv.slice(2), io) {
  const out = createIo(io);
  const opts = parseArgs(argv);

  if (opts.fromCachePath) {
    const cache = readCacheRecord(opts.fromCachePath);
    const dataset = {
      dataset: cache.dataset.name,
      filePath: cache.dataset.filePath
    };
    const html = buildHtml(dataset, cache.graphPattern, cache.algorithms, cache.rows);
    const absOutputPath = writeTextFile(opts.outputPath, html);
    out.stdout.write(`Read ${path.relative(process.cwd(), path.resolve(process.cwd(), opts.fromCachePath))}\n`);
    out.stdout.write(`Wrote ${path.relative(process.cwd(), absOutputPath)}\n`);
    return;
  }

  const dataset = loadGraphs(opts.filePath);

  const availableAlgorithms = getAvailableAlgorithmSpecs();
  const selectedAlgorithms = resolveAlgorithmPatterns(availableAlgorithms, opts.algorithms);
  const cacheOutputPath = opts.cacheOutputPath || opts.outputPath;
  const existingCache = opts.updateCache && opts.cacheOnly
    ? readExistingCacheForUpdate(cacheOutputPath, dataset, out)
    : null;
  const algorithms = mergeAlgorithmSpecs(existingCache ? existingCache.algorithms : [], selectedAlgorithms);
  const writeCheckpoint = opts.cacheOnly && opts.updateCache && opts.checkpointInterval > 0
    ? (rows, completed, total) => {
        const checkpointCache = buildCacheRecord(dataset, opts.graphPattern, algorithms, rows);
        const absCheckpointPath = writeJsonFile(cacheOutputPath, checkpointCache);
        out.stdout.write(`Checkpoint ${completed}/${total}: wrote ${path.relative(process.cwd(), absCheckpointPath)}\n`);
      }
    : null;
  const rows = await buildRows(dataset, opts.graphPattern, selectedAlgorithms, opts.timeoutMs, out, {
    existingCache,
    concurrency: opts.concurrency,
    algorithmsForSort: algorithms,
    checkpointInterval: opts.checkpointInterval,
    onCheckpoint: writeCheckpoint
  });
  const cache = buildCacheRecord(dataset, opts.graphPattern, algorithms, rows);

  if (opts.cacheOnly) {
    const absCachePath = writeJsonFile(cacheOutputPath, cache);
    out.stdout.write(`Wrote ${path.relative(process.cwd(), absCachePath)}\n`);
    return;
  }

  if (opts.cacheOutputPath) {
    const absCachePath = writeJsonFile(opts.cacheOutputPath, cache);
    out.stdout.write(`Wrote ${path.relative(process.cwd(), absCachePath)}\n`);
  }

  const html = buildHtml(dataset, opts.graphPattern, selectedAlgorithms, rows);
  const absOutputPath = writeTextFile(opts.outputPath, html);
  out.stdout.write(`Wrote ${path.relative(process.cwd(), absOutputPath)}\n`);
}

const isMainModule = (() => {
  if (!process.argv[1]) {
    return false;
  }
  return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
})();

if (isMainModule) {
  runCli().catch((err) => {
    usage(undefined, { stderr: process.stderr });
    process.stderr.write(`${err && err.message ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
