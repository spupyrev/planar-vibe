import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  metricHeaders,
  parseCsv,
  parseOptionalNumber
} from './report-shared.mjs';

const METRICS = metricHeaders
  .filter(([key]) => key !== 'runtime')
  .map(([key, label]) => ({ key, label }));

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
    'Usage: ./scripts/aggregate-metric <csv-file> --metric=<metric|pattern>[,<metric|pattern>]\n' +
    'Example: ./scripts/aggregate-metric evaluation_data/all-algorithms-4bench-results.csv --metric="*"\n'
  );
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
  }

  const positionals = [];
  const opts = {
    metricPatterns: []
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--metric' && i + 1 < argv.length) {
      opts.metricPatterns.push(...splitPatterns(argv[i + 1]));
      i += 1;
      continue;
    }
    if (arg.startsWith('--metric=')) {
      opts.metricPatterns.push(...splitPatterns(arg.slice('--metric='.length)));
      continue;
    }
    if (arg.startsWith('--')) {
      usage(`Unknown option: ${arg}`);
      process.exit(1);
    }
    positionals.push(arg);
  }

  if (positionals.length !== 1) {
    usage('Expected exactly one CSV file argument.');
    process.exit(1);
  }
  if (opts.metricPatterns.length === 0) {
    usage('Missing required --metric parameter.');
    process.exit(1);
  }

  opts.csvPath = String(positionals[0]);
  return opts;
}

function splitPatterns(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9*]+/g, '');
}

function globToRegExp(pattern) {
  const escaped = String(pattern)
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function metricCandidates(metric) {
  return [
    metric.key,
    metric.label,
    String(metric.key).replaceAll('_', '-'),
    String(metric.label).replaceAll('_', '-')
  ].map(normalizeName);
}

export function resolveMetricPatterns(availableMetrics, patterns) {
  const selected = [];
  const seen = new Set();

  for (const rawPattern of patterns) {
    const pattern = String(rawPattern || '').trim();
    if (!pattern) {
      continue;
    }

    let matches = [];
    if (pattern.includes('*')) {
      const matcher = globToRegExp(normalizeName(pattern));
      matches = availableMetrics.filter((metric) => (
        metricCandidates(metric).some((candidate) => matcher.test(candidate))
      ));
    } else {
      const requested = normalizeName(pattern);
      matches = availableMetrics.filter((metric) => (
        metricCandidates(metric).some((candidate) => candidate === requested)
      ));
    }

    if (matches.length === 0) {
      throw new Error(`No metrics matched "${pattern}".`);
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

function loadRows(csvPath) {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`Missing CSV file: ${csvPath}`);
  }
  const records = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  if (records.length < 2) {
    throw new Error(`CSV file is empty: ${csvPath}`);
  }

  const header = records[0];
  const index = Object.fromEntries(header.map((name, i) => [name, i]));
  for (const key of ['dataset', 'algorithm', 'algorithmLabel', 'ok']) {
    if (!(key in index)) {
      throw new Error(`CSV is missing column: ${key}`);
    }
  }

  const rows = [];
  for (let r = 1; r < records.length; r += 1) {
    const record = records[r];
    if (!record.length || record.every((value) => value === '')) {
      continue;
    }
    rows.push({ record, index });
  }
  return { header, index, rows };
}

function pushValue(map, key, value) {
  if (!Number.isFinite(value)) {
    return;
  }
  if (!map.has(key)) {
    map.set(key, []);
  }
  map.get(key).push(value);
}

function tCritical95(df) {
  const table = [
    null,
    12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
    2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
    2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042
  ];
  if (df <= 0) return 0;
  if (df < table.length) return table[df];
  if (df <= 40) return 2.021;
  if (df <= 60) return 2.000;
  if (df <= 120) return 1.980;
  return 1.960;
}

export function summarize(values) {
  const n = values.length;
  if (n === 0) {
    return null;
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  if (n === 1) {
    return { n, mean, ci: 0 };
  }
  let ss = 0;
  for (const value of values) {
    ss += (value - mean) ** 2;
  }
  const sd = Math.sqrt(ss / (n - 1));
  const ci = tCritical95(n - 1) * sd / Math.sqrt(n);
  return { n, mean, ci };
}

function formatNumber(value) {
  return Number.isFinite(value) ? value.toFixed(3) : '--';
}

function formatSummary(summary, includeN = false) {
  if (!summary) {
    return '--';
  }
  const text = `${formatNumber(summary.mean)} +- ${formatNumber(summary.ci)}`;
  return includeN ? `${text} (n=${summary.n})` : text;
}

function padCell(value, width, align) {
  const text = String(value ?? '');
  return align === 'right' ? text.padStart(width, ' ') : text.padEnd(width, ' ');
}

function markdownTable(headers, rows, alignments) {
  const widths = headers.map((header, i) => {
    let width = String(header).length;
    for (const row of rows) {
      width = Math.max(width, String(row[i] ?? '').length);
    }
    return width;
  });

  const aligns = headers.map((_, i) => alignments && alignments[i] ? alignments[i] : 'left');
  const separator = widths.map((width, i) => (
    aligns[i] === 'right' ? `${'-'.repeat(Math.max(3, width - 1))}:` : '-'.repeat(Math.max(3, width))
  ));
  const formatRow = (row) => `| ${row.map((cell, i) => padCell(cell, widths[i], aligns[i])).join(' | ')} |`;

  return [
    formatRow(headers),
    formatRow(separator),
    ...rows.map(formatRow)
  ].join('\n');
}

function renderMetric(metric, aggregates, out) {
  const { algorithms, algorithmLabels, datasets, byAlgorithm, byDatasetAlgorithm } = aggregates;

  out.stdout.write(`## ${metric.label} (${metric.key})\n\n`);
  out.stdout.write('Across all benchmarks, successful runs only. Values are mean +- 95% CI.\n\n');
  const overallRows = [];
  for (const algorithm of algorithms) {
    const summary = summarize(byAlgorithm.get(algorithm) || []);
    overallRows.push([
      algorithmLabels.get(algorithm) || algorithm,
      summary ? String(summary.n) : '0',
      formatSummary(summary)
    ]);
  }
  out.stdout.write(`${markdownTable(
    ['Algorithm', 'n', 'Mean +- CI'],
    overallRows,
    ['left', 'right', 'right']
  )}\n`);

  out.stdout.write('\nBy benchmark, successful runs only. Values are mean +- 95% CI.\n\n');
  const benchmarkRows = [];
  for (const algorithm of algorithms) {
    const cells = datasets.map((dataset) => (
      formatSummary(summarize(byDatasetAlgorithm.get(`${dataset}\t${algorithm}`) || []), true)
    ));
    benchmarkRows.push([algorithmLabels.get(algorithm) || algorithm, ...cells]);
  }
  out.stdout.write(`${markdownTable(
    ['Algorithm', ...datasets],
    benchmarkRows,
    ['left', ...datasets.map(() => 'right')]
  )}\n`);
  out.stdout.write('\n');
}

function aggregateForMetric(rows, index, metric) {
  const byAlgorithm = new Map();
  const byDatasetAlgorithm = new Map();
  const algorithmLabels = new Map();
  const algorithmOrder = [];
  const seenAlgorithms = new Set();
  const datasetSet = new Set();

  for (const { record } of rows) {
    if (record[index.ok] !== '1') {
      continue;
    }
    const dataset = record[index.dataset];
    const algorithm = record[index.algorithm];
    const algorithmLabel = record[index.algorithmLabel] || algorithm;
    const value = parseOptionalNumber(record[index[metric.key]]);
    if (!Number.isFinite(value)) {
      continue;
    }

    if (!seenAlgorithms.has(algorithm)) {
      seenAlgorithms.add(algorithm);
      algorithmOrder.push(algorithm);
    }
    algorithmLabels.set(algorithm, algorithmLabel);
    datasetSet.add(dataset);
    pushValue(byAlgorithm, algorithm, value);
    pushValue(byDatasetAlgorithm, `${dataset}\t${algorithm}`, value);
  }

  return {
    algorithms: algorithmOrder,
    algorithmLabels,
    datasets: [...datasetSet].sort((a, b) => a.localeCompare(b)),
    byAlgorithm,
    byDatasetAlgorithm
  };
}

export async function runCli(argv = process.argv.slice(2), io) {
  const out = createIo(io);
  const opts = parseArgs(argv);
  const { index, rows } = loadRows(opts.csvPath);
  const availableMetrics = METRICS.filter((metric) => metric.key in index);
  const selectedMetrics = resolveMetricPatterns(availableMetrics, opts.metricPatterns);

  out.stdout.write(`# Metric Aggregates\n\n`);
  out.stdout.write(`Input: \`${opts.csvPath}\`\n\n`);
  out.stdout.write(`Metrics: ${selectedMetrics.map((metric) => metric.key).join(', ')}\n\n`);

  for (const metric of selectedMetrics) {
    renderMetric(metric, aggregateForMetric(rows, index, metric), out);
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
