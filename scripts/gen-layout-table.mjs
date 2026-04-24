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
} from './apply-layout.mjs';

const DEFAULT_TIMEOUT_MS = 30 * 1000;
const DEFAULT_OUTPUT = 'layout-table.html';

export function usage(message, io) {
  const out = createIo(io);
  if (message) {
    out.stderr.write(`${message}\n\n`);
  }
  out.stderr.write(
    'Usage: ./scripts/gen_layout_table <graph-file> <graph-pattern> [--algorithms input,tutte,air|*balancer*|*] [--timeout 30] [--output layout-table.html]\n' +
    'Example: ./scripts/gen_layout_table benchmark/sample_graphs_coords.dot "sample*" --algorithms input,tutte,*balancer* --output layout-table.html\n'
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
    outputPath: DEFAULT_OUTPUT
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

function renderCellSvg(graph, rec) {
  if (!rec.positions) {
    return '';
  }
  const svg = buildSvgMarkup(rec.positions, graph.parsed.edgePairs, { includeXmlDeclaration: false });
  return svg ? svg.markup : '';
}

function renderCell(graph, rec) {
  const statusClass = rec.ok ? 'is-ok' : 'is-fail';
  const pieces = [];
  pieces.push(`<div class="cell-status ${statusClass}">${escapeXml(rec.ok ? 'ok' : 'failed')}</div>`);
  const svg = renderCellSvg(graph, rec);
  if (svg) {
    pieces.push(`<div class="drawing">${svg}</div>`);
  } else {
    pieces.push('<div class="cell-error">No drawing available</div>');
  }
  if (!rec.ok) {
    pieces.push(`<div class="cell-message">${escapeXml(rec.message || 'failed')}</div>`);
  } else {
    if (!svg) {
      pieces.push('<div class="cell-message">Drawing export was unavailable</div>');
    }
  }
  pieces.push(`<div class="cell-meta">runtime ${formatValue(rec.runtimeMs / 1000, 4)} s</div>`);
  return pieces.join('');
}

function buildHtml(dataset, regexText, algorithms, rows) {
  const headerCells = algorithms.map((alg) => `<th scope="col">${escapeXml(alg.label)}</th>`).join('');
  const bodyRows = rows.map((row) => {
    const graphLabel = `${row.graphName} (${row.parsed.nodeIds.length}v, ${row.parsed.edgePairs.length}e)`;
    const cells = row.results.map((result) => `<td>${renderCell(row, result)}</td>`).join('');
    return `<tr><th scope="row">${escapeXml(graphLabel)}</th>${cells}</tr>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Layout Table</title>
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
      margin: 0;
      font-family: "Segoe UI", Arial, sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, #fff7df 0, transparent 30%),
        linear-gradient(180deg, #f8f5ee 0%, #f1ebdd 100%);
    }
    main {
      padding: 24px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 28px;
    }
    .summary {
      margin: 0 0 20px;
      color: var(--muted);
    }
    .table-wrap {
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
      z-index: 2;
      background: #efe7d6;
      padding: 12px;
      min-width: 260px;
    }
    tbody th {
      position: sticky;
      left: 0;
      z-index: 1;
      min-width: 220px;
      padding: 12px;
      text-align: left;
      background: #f7f2e7;
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
  </style>
</head>
<body>
  <main>
    <h1>Layout Table</h1>
    <p class="summary">Dataset: ${escapeXml(dataset.filePath)} | Regex: /${escapeXml(regexText)}/ | Graphs: ${rows.length} | Algorithms: ${algorithms.length}</p>
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

export async function runCli(argv = process.argv.slice(2), io) {
  const out = createIo(io);
  const opts = parseArgs(argv);
  const dataset = loadGraphs(opts.filePath);

  const matchedGraphs = dataset.graphs.filter((graph) => matchesGlob(graph.graphName, opts.graphPattern));
  if (matchedGraphs.length === 0) {
    throw new Error(`No graphs in ${opts.filePath} matched "${opts.graphPattern}".`);
  }

  const availableAlgorithms = getAvailableAlgorithmSpecs();
  const selectedAlgorithms = resolveAlgorithmPatterns(availableAlgorithms, opts.algorithms);

  const workerPath = getWorkerPath();
  const rows = [];
  for (let i = 0; i < matchedGraphs.length; i += 1) {
    const graph = matchedGraphs[i];
    out.stdout.write(`[${i + 1}/${matchedGraphs.length}] ${graph.graphName}\n`);
    const results = [];
    for (let j = 0; j < selectedAlgorithms.length; j += 1) {
      const algorithm = selectedAlgorithms[j];
      out.stdout.write(`  - ${algorithm.label}\n`);
      const rec = await runOne(
        workerPath,
        algorithm.key,
        opts.timeoutMs,
        dataset.dataset,
        graph.graphName,
        graph.parsed,
        true
      );
      results.push(rec);
    }
    rows.push({
      graphName: graph.graphName,
      parsed: graph.parsed,
      results
    });
  }

  const html = buildHtml(dataset, opts.graphPattern, selectedAlgorithms, rows);
  const absOutputPath = path.resolve(process.cwd(), opts.outputPath);
  fs.writeFileSync(absOutputPath, html, 'utf8');
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
