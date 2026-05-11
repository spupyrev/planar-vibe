#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import { csvEscape, parseCsv } from './report-shared.mjs';

const DEFAULT_RESULTS_CSV = path.join('evaluation_data', 'all-algorithms-4bench-results.csv');
const DEFAULT_CACHE_FILES = [
  path.join('evaluation_data', 'named-layout-table-cache.json'),
  path.join('evaluation_data', 'gd-collection-layout-table-cache.json'),
  path.join('evaluation_data', 'north-layout-table-cache.json'),
  path.join('evaluation_data', 'rome-layout-table-cache.json')
];
const DEFAULT_ALGORITHMS = [
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
  'facebalancer',
  'gpt',
  'claude'
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
const HEADER = [
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

function usage() {
  process.stderr.write(
    'Usage: ./scripts/results-csv ' +
    '[--results evaluation_data/all-algorithms-4bench-results.csv] ' +
    `[--algorithms ${DEFAULT_ALGORITHMS.join(',')}] ` +
    '[--caches evaluation_data/named-layout-table-cache.json,...]\n'
  );
}

function parseArgs(argv) {
  const opts = {
    resultsCsv: DEFAULT_RESULTS_CSV,
    cacheFiles: DEFAULT_CACHE_FILES.slice(),
    algorithms: DEFAULT_ALGORITHMS.slice()
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--results' && i + 1 < argv.length) {
      opts.resultsCsv = argv[i + 1];
      i += 1;
    } else if (arg === '--caches' && i + 1 < argv.length) {
      opts.cacheFiles = argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean);
      i += 1;
    } else if (arg === '--algorithms' && i + 1 < argv.length) {
      opts.algorithms = argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (opts.algorithms.length === 0) {
    throw new Error('At least one algorithm is required.');
  }
  if (opts.cacheFiles.length === 0) {
    throw new Error('At least one cache file is required.');
  }

  return opts;
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

function normalizeCell(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }
  return value;
}

function displayAlgorithmLabel(rec) {
  return rec.algorithm === 'input' ? 'Human' : rec.algorithmLabel;
}

function recordToCsvRow(rec) {
  return [
    rec.dataset,
    rec.graph,
    rec.n,
    rec.m,
    rec.algorithm,
    displayAlgorithmLabel(rec),
    Number.isFinite(rec.runtimeMs) ? rec.runtimeMs : '',
    rec.ok ? '1' : '0',
    rec.message || '',
    classifyBreakage(rec),
    missingMetrics(rec).join('|'),
    normalizeCell(rec.isPlane),
    ...METRIC_KEYS.map((key) => normalizeCell(rec[key]))
  ].map(csvEscape);
}

function csvRowToRecord(row, columnIndex) {
  return Object.fromEntries(HEADER.map((column) => [column, row[columnIndex[column]] ?? '']));
}

function cacheRecordKey(dataset, graph, algorithm) {
  return `${dataset}\u0000${graph}\u0000${algorithm}`;
}

function loadCacheRecords(cacheFiles, algorithmSet) {
  const records = new Map();
  const sourceCounts = new Map();

  for (const filePath of cacheFiles) {
    const cache = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const dataset = cache.dataset?.name;
    if (!dataset) {
      throw new Error(`${filePath} does not have dataset.name`);
    }
    for (const row of cache.rows || []) {
      for (const result of row.results || []) {
        if (!algorithmSet.has(result.algorithm)) {
          continue;
        }
        const rec = {
          dataset: result.dataset ?? dataset,
          graph: result.graph ?? row.graphName,
          n: result.n ?? row.parsed?.nodeIds?.length ?? '',
          m: result.m ?? row.parsed?.edgePairs?.length ?? '',
          algorithm: result.algorithm,
          algorithmLabel: result.algorithmLabel || result.algorithm,
          runtimeMs: result.runtimeMs,
          ok: Boolean(result.ok),
          message: result.message || '',
          isPlane: result.isPlane,
          ...Object.fromEntries(METRIC_KEYS.map((key) => [key, result[key]]))
        };
        records.set(cacheRecordKey(rec.dataset, rec.graph, rec.algorithm), rec);
        sourceCounts.set(rec.algorithm, (sourceCounts.get(rec.algorithm) || 0) + 1);
      }
    }
  }

  return { records, sourceCounts };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const algorithmSet = new Set(opts.algorithms);
  const { records: cacheRecords, sourceCounts } = loadCacheRecords(opts.cacheFiles, algorithmSet);
  const resultsPath = path.resolve(process.cwd(), opts.resultsCsv);
  const csv = parseCsv(fs.readFileSync(resultsPath, 'utf8'));
  if (csv.length === 0) {
    throw new Error(`${opts.resultsCsv} is empty`);
  }
  const header = csv[0];
  if (header.join('\u0000') !== HEADER.join('\u0000')) {
    throw new Error(`${opts.resultsCsv} has an unexpected header`);
  }
  const columnIndex = Object.fromEntries(header.map((column, index) => [column, index]));

  const outputRows = [HEADER.map(csvEscape)];
  let removedExisting = 0;
  let inserted = 0;
  const emittedCacheKeys = new Set();
  const bodyRows = csv.slice(1);

  function flushCacheRows(dataset, graph) {
    for (const algorithm of opts.algorithms) {
      const key = cacheRecordKey(dataset, graph, algorithm);
      const rec = cacheRecords.get(key);
      if (!rec) {
        continue;
      }
      outputRows.push(recordToCsvRow(rec));
      emittedCacheKeys.add(key);
      inserted += 1;
    }
  }

  for (let i = 0; i < bodyRows.length; i += 1) {
    const row = bodyRows[i];
    const rec = csvRowToRecord(row, columnIndex);
    const rowCacheKey = cacheRecordKey(rec.dataset, rec.graph, rec.algorithm);
    if (algorithmSet.has(rec.algorithm) && cacheRecords.has(rowCacheKey)) {
      removedExisting += 1;
    } else {
      outputRows.push(row.map(csvEscape));
    }

    const next = bodyRows[i + 1] ? csvRowToRecord(bodyRows[i + 1], columnIndex) : null;
    if (!next || next.dataset !== rec.dataset || next.graph !== rec.graph) {
      flushCacheRows(rec.dataset, rec.graph);
    }
  }

  for (const [key, rec] of cacheRecords) {
    if (emittedCacheKeys.has(key)) {
      continue;
    }
    outputRows.push(recordToCsvRow(rec));
    emittedCacheKeys.add(key);
    inserted += 1;
  }

  fs.writeFileSync(resultsPath, `${outputRows.map((row) => row.join(',')).join('\n')}\n`, 'utf8');
  process.stdout.write(`Updated ${path.relative(process.cwd(), resultsPath)}\n`);
  process.stdout.write(`Removed existing selected rows: ${removedExisting}\n`);
  process.stdout.write(`Inserted cache rows: ${inserted}\n`);
  for (const algorithm of opts.algorithms) {
    process.stdout.write(`${algorithm}: cache rows=${sourceCounts.get(algorithm) || 0}\n`);
  }
}

main();
