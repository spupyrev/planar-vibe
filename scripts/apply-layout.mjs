import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import {
  createAlgorithmSpecs,
  loadBrowserModules,
  metricHeaders,
  parseEdgeListText
} from './report-shared.mjs';

const DEFAULT_TIMEOUT_MS = 30 * 1000;
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
const LOGO_COLORS = {
  blue: '#1060A8',
  black: '#111111'
};
const DEFAULT_VERTEX_SIZE = 6;
const APPLY_LAYOUT_EXPORT_VERTEX_SIZE = DEFAULT_VERTEX_SIZE * 2;
const DEFAULT_EDGE_WIDTH = 0.75;

export function createIo(io) {
  return {
    stdout: io && io.stdout ? io.stdout : process.stdout,
    stderr: io && io.stderr ? io.stderr : process.stderr
  };
}

export function usage(message, io) {
  const out = createIo(io);
  if (message) {
    out.stderr.write(`${message}\n\n`);
  }
  out.stderr.write(
    'Usage: ./scripts/apply_layout <graph-file> <graph-pattern> --algorithm <name|pattern> [--timeout 30] [--export=svg|pdf|filename.svg|filename.pdf]\n' +
    '       ./scripts/apply_layout <graph-file> <graph-pattern> --algorithms input,tutte,*balancer* [--timeout 30] [--export=svg|pdf]\n' +
    'Example: ./scripts/apply_layout benchmark/named.dot sample1 --algorithm air --export=sample1.svg\n'
  );
}

export function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

export function globToRegExp(pattern, flags = 'i') {
  const escaped = String(pattern || '')
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, flags);
}

export function matchesGlob(value, pattern) {
  return globToRegExp(pattern).test(String(value || ''));
}

export function datasetLabelFromPath(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
  }

  const positionals = [];
  const opts = {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    exportFormat: null,
    exportPath: null,
    algorithms: []
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === '--algorithm' || arg === '--algorithms') && i + 1 < argv.length) {
      opts.algorithms.push(...String(argv[i + 1]).split(',').map((s) => s.trim()).filter(Boolean));
      i += 1;
      continue;
    }
    if (arg.startsWith('--export=')) {
      const exportValue = String(arg.slice('--export='.length) || '');
      const lowerExportValue = exportValue.toLowerCase();
      if (lowerExportValue === 'svg' || lowerExportValue === 'pdf') {
        opts.exportFormat = lowerExportValue;
      } else {
        const ext = path.extname(exportValue).toLowerCase().replace(/^\./, '');
        opts.exportFormat = ext;
        opts.exportPath = exportValue;
      }
      continue;
    }
    if (arg === '--timeout' && i + 1 < argv.length) {
      opts.timeoutMs = Math.max(1000, Math.floor((Number(argv[i + 1]) || 30) * 1000));
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
  if (opts.algorithms.length === 0) {
    usage('Missing required --algorithm or --algorithms parameter.');
    process.exit(1);
  }
  if (opts.exportFormat && opts.exportFormat !== 'svg' && opts.exportFormat !== 'pdf') {
    usage(`Unknown export target: ${opts.exportPath || opts.exportFormat}`);
    process.exit(1);
  }
  return opts;
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

export function loadGraphs(filePath) {
  const abs = path.resolve(process.cwd(), filePath);
  const text = fs.readFileSync(abs, 'utf8');
  const dotGraphs = parseDotCollections(text);
  if (dotGraphs.length > 0) {
    return {
      dataset: datasetLabelFromPath(filePath),
      filePath,
      graphs: dotGraphs
    };
  }

  return {
    dataset: datasetLabelFromPath(filePath),
    filePath,
    graphs: [
      {
        graphName: datasetLabelFromPath(filePath),
        parsed: parseEdgeListText(text)
      }
    ]
  };
}

export function resolveAlgorithmSpec(specs, requestedName) {
  const requested = normalizeName(requestedName);
  if (requested === 'input') {
    return {
      key: 'input',
      label: 'Input'
    };
  }
  for (const spec of specs) {
    const candidates = [
      spec.key,
      spec.label,
      String(spec.key).replaceAll('_', '-'),
      String(spec.label).replaceAll('_', '-')
    ];
    if (candidates.some((candidate) => normalizeName(candidate) === requested)) {
      return spec;
    }
  }
  return null;
}

export function algorithmCandidates(algorithm) {
  return [
    algorithm.key,
    algorithm.label,
    String(algorithm.key).replaceAll('_', '-'),
    String(algorithm.label).replaceAll('_', '-')
  ].map(normalizeName);
}

export function normalizeGlobPattern(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9*]+/g, '');
}

export function resolveAlgorithmPatterns(availableAlgorithms, patterns) {
  if (!patterns || patterns.length === 0) {
    return availableAlgorithms.slice();
  }

  const selected = [];
  const seen = new Set();

  for (const rawPattern of patterns) {
    const pattern = String(rawPattern || '').trim();
    if (!pattern) {
      continue;
    }

    let matches = [];
    if (pattern.includes('*')) {
      const matcher = globToRegExp(normalizeGlobPattern(pattern));
      matches = availableAlgorithms.filter((algorithm) => (
        algorithmCandidates(algorithm).some((candidate) => matcher.test(candidate))
      ));
    } else {
      const exact = resolveAlgorithmSpec(availableAlgorithms, pattern);
      matches = exact ? [exact] : [];
    }

    if (matches.length === 0) {
      throw new Error(`No algorithms matched "${pattern}".`);
    }

    for (const match of matches) {
      if (seen.has(match.key)) {
        continue;
      }
      seen.add(match.key);
      selected.push(match);
    }
  }

  return selected;
}

export function formatValue(value, digits = 6) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : '--';
}

export function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function computeNodeFontSize(vertexSize) {
  return Math.max(4, Math.round(vertexSize * 0.9));
}

function writeAlignedField(io, width, label, value) {
  io.stdout.write(`${String(label).padEnd(width)} : ${value}\n`);
}

export function buildSvgMarkup(nodePosById, edgePairs, opts = {}) {
  const radius = Number.isFinite(opts.radius) ? opts.radius : DEFAULT_VERTEX_SIZE / 2;
  const edgeWidth = Number.isFinite(opts.edgeWidth) ? opts.edgeWidth : DEFAULT_EDGE_WIDTH;
  const pad = Math.max(24, radius + 8);
  const nodeIds = Object.keys(nodePosById || {});
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const id of nodeIds) {
    const p = nodePosById[id];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      continue;
    }
    minX = Math.min(minX, p.x - radius);
    minY = Math.min(minY, p.y - radius);
    maxX = Math.max(maxX, p.x + radius);
    maxY = Math.max(maxY, p.y + radius);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null;
  }

  const width = Math.max(1, Math.ceil(maxX - minX + 2 * pad));
  const height = Math.max(1, Math.ceil(maxY - minY + 2 * pad));
  const offsetX = -minX + pad;
  const offsetY = -minY + pad;
  const svg = [];
  if (opts.includeXmlDeclaration !== false) {
    svg.push('<?xml version="1.0" encoding="UTF-8"?>');
  }
  svg.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
  svg.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`);
  svg.push(`<g id="edges" stroke="${LOGO_COLORS.black}" stroke-width="${edgeWidth}" fill="none" stroke-linecap="round">`);
  for (const [u, v] of edgePairs) {
    const pu = nodePosById[String(u)];
    const pv = nodePosById[String(v)];
    if (!pu || !pv) {
      continue;
    }
    svg.push(`<line x1="${pu.x + offsetX}" y1="${pu.y + offsetY}" x2="${pv.x + offsetX}" y2="${pv.y + offsetY}"/>`);
  }
  svg.push('</g>');
  svg.push('<g id="nodes">');
  for (const id of nodeIds) {
    const p = nodePosById[id];
    if (!p) {
      continue;
    }
    const x = p.x + offsetX;
    const y = p.y + offsetY;
    svg.push(`<circle cx="${x}" cy="${y}" r="${radius}" fill="${LOGO_COLORS.blue}" stroke="${LOGO_COLORS.black}" stroke-width="0.5"/>`);
  }
  svg.push('</g>');
  svg.push('</svg>');
  return {
    markup: svg.join(''),
    width,
    height
  };
}

function escapePdfText(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export function buildPdfBuffer(nodePosById, edgePairs, opts = {}) {
  const radius = Number.isFinite(opts.radius) ? opts.radius : DEFAULT_VERTEX_SIZE / 2;
  const edgeWidth = Number.isFinite(opts.edgeWidth) ? opts.edgeWidth : DEFAULT_EDGE_WIDTH;
  const svg = buildSvgMarkup(nodePosById, edgePairs, { radius, edgeWidth });
  if (!svg) {
    return null;
  }

  const nodeIds = Object.keys(nodePosById || {});
  const content = [];
  content.push('1 1 1 rg 0 0 ' + svg.width + ' ' + svg.height + ' re f');
  content.push(`${edgeWidth} w`);
  content.push('0.0667 0.0667 0.0667 RG');
  content.push('1 J');
  for (const [u, v] of edgePairs) {
    const pu = nodePosById[String(u)];
    const pv = nodePosById[String(v)];
    if (!pu || !pv) {
      continue;
    }
    const x1 = pu.x - Math.min(...nodeIds.map((id) => nodePosById[id].x - radius)) + Math.max(24, radius + 8);
    const y1 = svg.height - (pu.y - Math.min(...nodeIds.map((id) => nodePosById[id].y - radius)) + Math.max(24, radius + 8));
    const x2 = pv.x - Math.min(...nodeIds.map((id) => nodePosById[id].x - radius)) + Math.max(24, radius + 8);
    const y2 = svg.height - (pv.y - Math.min(...nodeIds.map((id) => nodePosById[id].y - radius)) + Math.max(24, radius + 8));
    content.push(`${x1.toFixed(4)} ${y1.toFixed(4)} m ${x2.toFixed(4)} ${y2.toFixed(4)} l S`);
  }

  function circlePath(cx, cy, r) {
    const k = 0.5522847498307936;
    const c = r * k;
    return [
      `${(cx + r).toFixed(4)} ${cy.toFixed(4)} m`,
      `${(cx + r).toFixed(4)} ${(cy + c).toFixed(4)} ${(cx + c).toFixed(4)} ${(cy + r).toFixed(4)} ${cx.toFixed(4)} ${(cy + r).toFixed(4)} c`,
      `${(cx - c).toFixed(4)} ${(cy + r).toFixed(4)} ${(cx - r).toFixed(4)} ${(cy + c).toFixed(4)} ${(cx - r).toFixed(4)} ${cy.toFixed(4)} c`,
      `${(cx - r).toFixed(4)} ${(cy - c).toFixed(4)} ${(cx - c).toFixed(4)} ${(cy - r).toFixed(4)} ${cx.toFixed(4)} ${(cy - r).toFixed(4)} c`,
      `${(cx + c).toFixed(4)} ${(cy - r).toFixed(4)} ${(cx + r).toFixed(4)} ${(cy - c).toFixed(4)} ${(cx + r).toFixed(4)} ${cy.toFixed(4)} c`
    ].join(' ');
  }

  const minX = Math.min(...nodeIds.map((id) => nodePosById[id].x - radius));
  const minY = Math.min(...nodeIds.map((id) => nodePosById[id].y - radius));
  const pad = Math.max(24, radius + 8);
  for (const id of nodeIds) {
    const p = nodePosById[id];
    if (!p) {
      continue;
    }
    const x = p.x - minX + pad;
    const y = svg.height - (p.y - minY + pad);
    content.push('0.0627 0.3765 0.6588 rg');
    content.push(circlePath(x, y, radius) + ' b');
  }

  const stream = `${content.join('\n')}\n`;
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${svg.width} ${svg.height}] /Contents 4 0 R >>\nendobj\n`,
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}endstream\nendobj\n`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += object;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i < offsets.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'utf8');
}

export function sanitizeFileStem(name) {
  const stem = String(name || '').trim().replace(/[^\w.-]+/g, '_');
  return stem.length > 0 ? stem : 'graph';
}

export function exportDrawing(graphName, parsed, positions, format, outputPath = null) {
  if (!positions || !format) {
    return null;
  }
  const baseName = sanitizeFileStem(graphName);
  const absPath = outputPath
    ? path.resolve(process.cwd(), outputPath)
    : path.resolve(process.cwd(), `${baseName}.${format}`);
  if (format === 'svg') {
    const svg = buildSvgMarkup(positions, parsed.edgePairs, {
      radius: APPLY_LAYOUT_EXPORT_VERTEX_SIZE / 2,
      edgeWidth: DEFAULT_EDGE_WIDTH
    });
    if (!svg) {
      throw new Error(`Could not build SVG for ${graphName}`);
    }
    fs.writeFileSync(absPath, `${svg.markup}\n`, 'utf8');
    return absPath;
  }
  if (format === 'pdf') {
    const pdf = buildPdfBuffer(positions, parsed.edgePairs, {
      radius: APPLY_LAYOUT_EXPORT_VERTEX_SIZE / 2,
      edgeWidth: DEFAULT_EDGE_WIDTH
    });
    if (!pdf) {
      throw new Error(`Could not build PDF for ${graphName}`);
    }
    fs.writeFileSync(absPath, pdf);
    return absPath;
  }
  throw new Error(`Unsupported export format: ${format}`);
}

function printRecord(rec, io) {
  const out = createIo(io);
  const missing = METRIC_KEYS.filter((key) => !Number.isFinite(rec[key]));
  const metricLabelWidth = metricHeaders
    .filter(([metricKey]) => metricKey !== 'runtime')
    .reduce((max, [, label]) => Math.max(max, label.length), 0);
  out.stdout.write(`=== ${rec.graph} ===\n`);
  out.stdout.write(`Vertices: ${rec.n}\n`);
  out.stdout.write(`Edges: ${rec.m}\n`);
  out.stdout.write(`Algorithm: ${rec.algorithmLabel}\n`);
  out.stdout.write(`Status: ${rec.ok ? 'ok' : 'failed'}\n`);
  out.stdout.write(`Message: ${rec.message || '-'}\n`);
  writeAlignedField(out, metricLabelWidth, 'Runtime (s)', formatValue(rec.runtimeMs / 1000, 4));
  out.stdout.write(`Plane: ${rec.isPlane == null ? '--' : (rec.isPlane ? 'yes' : 'no')}\n`);

  for (const [metricKey, label] of metricHeaders) {
    if (metricKey === 'runtime') {
      continue;
    }
    writeAlignedField(out, metricLabelWidth, label, formatValue(rec[metricKey], 4));
  }

  if (missing.length > 0) {
    out.stdout.write(`Missing Metrics: ${missing.join(', ')}\n`);
  }
}

export function runOne(workerPath, algorithmKey, timeoutMs, dataset, graphName, parsed, includePositions) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    let settled = false;
    const worker = new Worker(workerPath, {
      workerData: {
        dataset,
        graphName,
        algorithmKey,
        parsed,
        includePositions: !!includePositions
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

    function failure(message, runtimeMs) {
      return {
        dataset,
        graph: graphName,
        n: parsed.nodeIds.length,
        m: parsed.edgePairs.length,
        algorithm: algorithmKey,
        algorithmLabel: algorithmKey,
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
        spacing: null,
        positions: null
      };
    }

    const timer = setTimeout(() => {
      finish(failure(`TLE (${Math.round(timeoutMs / 1000)}s)`, timeoutMs));
      worker.terminate().catch(function ignoreTerminateError() {});
    }, timeoutMs);

    worker.on('message', (msg) => {
      if (msg && msg.ok && msg.rec) {
        finish(msg.rec);
        return;
      }
      finish(failure(
        msg && msg.message ? String(msg.message) : 'Worker failed',
        Number(process.hrtime.bigint() - started) / 1e6
      ));
    });

    worker.on('error', (err) => {
      finish(failure(
        err && err.message ? err.message : String(err),
        Number(process.hrtime.bigint() - started) / 1e6
      ));
    });

    worker.on('exit', (code) => {
      if (settled || code === 0) {
        return;
      }
      finish(failure(
        `Worker exited with code ${code}`,
        Number(process.hrtime.bigint() - started) / 1e6
      ));
    });
  });
}

export function getWorkerPath() {
  return path.resolve(process.cwd(), 'scripts/run-dataset-algorithm-batch-worker.mjs');
}

export function getAvailableAlgorithmSpecs() {
  return [
    { key: 'input', label: 'Input' },
    ...createAlgorithmSpecs(loadBrowserModules())
  ];
}

export async function runCli(argv = process.argv.slice(2), io) {
  const out = createIo(io);
  const opts = parseArgs(argv);
  const dataset = loadGraphs(opts.filePath);

  const algorithms = getAvailableAlgorithmSpecs();
  const selectedAlgorithms = resolveAlgorithmPatterns(algorithms, opts.algorithms);

  const matchedGraphs = dataset.graphs.filter((graph) => matchesGlob(graph.graphName, opts.graphPattern));
  if (matchedGraphs.length === 0) {
    throw new Error(`No graphs in ${opts.filePath} matched "${opts.graphPattern}".`);
  }
  const runCount = matchedGraphs.length * selectedAlgorithms.length;
  if (opts.exportPath && runCount > 1) {
    if (selectedAlgorithms.length === 1) {
      throw new Error(`--export=${opts.exportPath} names one file, but "${opts.graphPattern}" matched ${matchedGraphs.length} graphs.`);
    }
    throw new Error(`--export=${opts.exportPath} names one file, but this command matched ${matchedGraphs.length} graphs and ${selectedAlgorithms.length} algorithms.`);
  }

  const workerPath = getWorkerPath();

  out.stdout.write(`Dataset File: ${dataset.filePath}\n`);
  out.stdout.write(`Graph Pattern: ${opts.graphPattern}\n`);
  out.stdout.write(`Matched Graphs: ${matchedGraphs.length}\n`);
  if (selectedAlgorithms.length === 1) {
    out.stdout.write(`Algorithm: ${selectedAlgorithms[0].label}\n`);
  } else {
    out.stdout.write(`Matched Algorithms: ${selectedAlgorithms.length}\n`);
    out.stdout.write(`Algorithms: ${selectedAlgorithms.map((algorithm) => algorithm.label).join(', ')}\n`);
  }
  out.stdout.write(`Timeout (s): ${formatValue(opts.timeoutMs / 1000, 4)}\n`);
  if (opts.exportFormat) {
    out.stdout.write(`Export: ${opts.exportPath || opts.exportFormat}\n`);
  }

  let runIndex = 0;
  for (let i = 0; i < matchedGraphs.length; i += 1) {
    const graph = matchedGraphs[i];
    for (let j = 0; j < selectedAlgorithms.length; j += 1) {
      const algorithm = selectedAlgorithms[j];
      runIndex += 1;
      const runLabel = selectedAlgorithms.length === 1
        ? graph.graphName
        : `${graph.graphName} :: ${algorithm.label}`;
      out.stdout.write(`\n[${runIndex}/${runCount}] Running ${runLabel}\n`);
      const rec = await runOne(
        workerPath,
        algorithm.key,
        opts.timeoutMs,
        dataset.dataset,
        graph.graphName,
        graph.parsed,
        !!opts.exportFormat
      );
      printRecord(rec, out);
      if (opts.exportFormat && rec.positions) {
        const exportGraphName = runCount === 1 ? graph.graphName : `${graph.graphName}-${algorithm.key}`;
        const exportedPath = exportDrawing(exportGraphName, graph.parsed, rec.positions, opts.exportFormat, opts.exportPath);
        out.stdout.write(`Exported ${opts.exportFormat.toUpperCase()} : ${path.relative(process.cwd(), exportedPath)}\n`);
      }
    }
  }
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
