import fs from 'node:fs';
import path from 'node:path';

import {
  csvEscape,
  metricHeaders,
  parseCsv,
  parseOptionalNumber
} from './report-shared.mjs';

const DEFAULT_INPUT_CSV = 'evaluation_data/all-algorithms-4bench-results.csv';
const DEFAULT_OUTPUT_DIR = 'evaluation_data';
const DEFAULT_REPORT_MD = 'docs/metric-correlations.md';
const PAIRS_CSV = 'metric-correlations-pairs.csv';
const PEARSON_MATRIX_CSV = 'metric-correlations-pearson.csv';
const SPEARMAN_MATRIX_CSV = 'metric-correlations-spearman.csv';

function mean(values) {
  if (!values || values.length === 0) {
    return null;
  }
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  return sum / values.length;
}

function pearson(xs, ys) {
  if (!xs || !ys || xs.length !== ys.length || xs.length < 2) {
    return null;
  }
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  if (!(dx2 > 0) || !(dy2 > 0)) {
    return null;
  }
  return num / Math.sqrt(dx2 * dy2);
}

function averageRanks(values) {
  const indexed = values.map((value, index) => ({ value, index }));
  indexed.sort((a, b) => a.value - b.value);
  const ranks = new Array(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i + 1;
    while (j < indexed.length && indexed[j].value === indexed[i].value) {
      j += 1;
    }
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k += 1) {
      ranks[indexed[k].index] = avgRank;
    }
    i = j;
  }
  return ranks;
}

function spearman(xs, ys) {
  if (!xs || !ys || xs.length !== ys.length || xs.length < 2) {
    return null;
  }
  return pearson(averageRanks(xs), averageRanks(ys));
}

function parseArgs(argv) {
  const opts = {
    inputCsv: DEFAULT_INPUT_CSV,
    outputDir: DEFAULT_OUTPUT_DIR,
    reportMd: DEFAULT_REPORT_MD
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input' && i + 1 < argv.length) {
      opts.inputCsv = String(argv[i + 1]);
      i += 1;
    } else if (arg === '--output-dir' && i + 1 < argv.length) {
      opts.outputDir = String(argv[i + 1]);
      i += 1;
    } else if (arg === '--report' && i + 1 < argv.length) {
      opts.reportMd = String(argv[i + 1]);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: node scripts/analyze-metric-correlations.mjs ' +
        '[--input evaluation_data/all-algorithms-4bench-results.csv] ' +
        '[--output-dir evaluation_data] [--report docs/metric-correlations.md]\n'
      );
      process.exit(0);
    }
  }

  return opts;
}

function loadMetricRows(csvPath, metricKeys) {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`Missing ${csvPath}`);
  }
  const raw = fs.readFileSync(csvPath, 'utf8');
  const records = parseCsv(raw);
  if (records.length < 2) {
    throw new Error(`CSV file is empty: ${csvPath}`);
  }

  const header = records[0];
  const index = Object.fromEntries(header.map((name, i) => [name, i]));
  const required = ['ok'].concat(metricKeys);
  for (const key of required) {
    if (!(key in index)) {
      throw new Error(`CSV is missing column: ${key}`);
    }
  }

  const rows = [];
  const datasets = new Set();
  const algorithms = new Set();
  let totalRows = 0;
  let skippedRows = 0;
  for (let r = 1; r < records.length; r += 1) {
    const record = records[r];
    if (!record.length || record.every((value) => value === '')) {
      continue;
    }
    totalRows += 1;
    if ('dataset' in index && record[index.dataset]) {
      datasets.add(record[index.dataset]);
    }
    if ('algorithm' in index && record[index.algorithm]) {
      algorithms.add(record[index.algorithm]);
    }
    if (record[index.ok] !== '1') {
      skippedRows += 1;
      continue;
    }
    const row = {};
    for (const key of metricKeys) {
      row[key] = parseOptionalNumber(record[index[key]]);
    }
    rows.push(row);
  }
  return {
    rows,
    summary: {
      totalRows,
      successfulRows: rows.length,
      skippedRows,
      datasets: [...datasets].sort(),
      algorithms: [...algorithms].sort()
    }
  };
}

function buildPairs(rows, metrics) {
  const pairs = [];
  for (let i = 0; i < metrics.length; i += 1) {
    for (let j = i + 1; j < metrics.length; j += 1) {
      const xs = [];
      const ys = [];
      for (const row of rows) {
        const x = row[metrics[i].key];
        const y = row[metrics[j].key];
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          continue;
        }
        xs.push(x);
        ys.push(y);
      }
      pairs.push({
        metricA: metrics[i].key,
        labelA: metrics[i].label,
        metricB: metrics[j].key,
        labelB: metrics[j].label,
        n: xs.length,
        pearson: pearson(xs, ys),
        spearman: spearman(xs, ys)
      });
    }
  }

  pairs.sort((a, b) => {
    const aScore = Number.isFinite(a.spearman) ? Math.abs(a.spearman) : -1;
    const bScore = Number.isFinite(b.spearman) ? Math.abs(b.spearman) : -1;
    if (bScore !== aScore) {
      return bScore - aScore;
    }
    const aPearson = Number.isFinite(a.pearson) ? Math.abs(a.pearson) : -1;
    const bPearson = Number.isFinite(b.pearson) ? Math.abs(b.pearson) : -1;
    return bPearson - aPearson;
  });
  return pairs;
}

function formatNumber(value) {
  return Number.isFinite(value) ? value.toFixed(6) : '';
}

function metricLabel(metric) {
  return metric.label;
}

function buildMatrixCsv(metrics, pairs, key) {
  const byPair = new Map();
  for (const pair of pairs) {
    byPair.set(`${pair.metricA}\t${pair.metricB}`, pair[key]);
    byPair.set(`${pair.metricB}\t${pair.metricA}`, pair[key]);
  }

  const lines = [
    ['metric', ...metrics.map(metricLabel)].map(csvEscape).join(',')
  ];
  for (const rowMetric of metrics) {
    const cells = [csvEscape(rowMetric.label)];
    for (const colMetric of metrics) {
      if (rowMetric.key === colMetric.key) {
        cells.push('1.000000');
      } else {
        cells.push(csvEscape(formatNumber(byPair.get(`${rowMetric.key}\t${colMetric.key}`))));
      }
    }
    lines.push(cells.join(','));
  }
  return `${lines.join('\n')}\n`;
}

function buildMarkdownMatrix(metrics, pairs, key) {
  const byPair = new Map();
  for (const pair of pairs) {
    byPair.set(`${pair.metricA}\t${pair.metricB}`, pair[key]);
    byPair.set(`${pair.metricB}\t${pair.metricA}`, pair[key]);
  }

  const lines = [
    `| Metric | ${metrics.map(metricLabel).join(' | ')} |`,
    `| --- | ${metrics.map(() => '---:').join(' | ')} |`
  ];
  for (const rowMetric of metrics) {
    const cells = [rowMetric.label];
    for (const colMetric of metrics) {
      if (rowMetric.key === colMetric.key) {
        cells.push('1.000');
      } else {
        const value = byPair.get(`${rowMetric.key}\t${colMetric.key}`);
        cells.push(Number.isFinite(value) ? value.toFixed(3) : '--');
      }
    }
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return lines;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const csvPath = path.resolve(process.cwd(), opts.inputCsv);
  const outputDir = path.resolve(process.cwd(), opts.outputDir);
  const reportPath = path.resolve(process.cwd(), opts.reportMd);
  const metrics = metricHeaders
    .filter(([key]) => key !== 'runtime')
    .map(([key, label]) => ({ key, label }));
  const { rows, summary } = loadMetricRows(csvPath, metrics.map((metric) => metric.key));
  const pairs = buildPairs(rows, metrics);

  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });

  const pairsPath = path.join(outputDir, PAIRS_CSV);
  const pearsonPath = path.join(outputDir, PEARSON_MATRIX_CSV);
  const spearmanPath = path.join(outputDir, SPEARMAN_MATRIX_CSV);

  const csvLines = [['metricA', 'labelA', 'metricB', 'labelB', 'n', 'pearson', 'spearman'].join(',')];
  for (const pair of pairs) {
    csvLines.push([
      csvEscape(pair.metricA),
      csvEscape(pair.labelA),
      csvEscape(pair.metricB),
      csvEscape(pair.labelB),
      pair.n,
      csvEscape(formatNumber(pair.pearson)),
      csvEscape(formatNumber(pair.spearman))
    ].join(','));
  }
  fs.writeFileSync(pairsPath, `${csvLines.join('\n')}\n`, 'utf8');
  fs.writeFileSync(pearsonPath, buildMatrixCsv(metrics, pairs, 'pearson'), 'utf8');
  fs.writeFileSync(spearmanPath, buildMatrixCsv(metrics, pairs, 'spearman'), 'utf8');

  const topPairs = pairs.slice(0, 20);
  const mdLines = [
    '# Metric Correlations',
    '',
    `Input: \`${opts.inputCsv}\``,
    '',
    `Rows: ${summary.totalRows}`,
    `Successful runs used: ${summary.successfulRows}`,
    `Skipped rows: ${summary.skippedRows}`,
    `Datasets: ${summary.datasets.join(', ')}`,
    `Algorithms: ${summary.algorithms.join(', ')}`,
    '',
    'Primary statistic: Spearman rank correlation. Pearson is included as a secondary linear-correlation check.',
    '',
    '## Spearman Matrix',
    '',
    ...buildMarkdownMatrix(metrics, pairs, 'spearman'),
    '',
    '## Strongest Pairs',
    '',
    '| Metric A | Metric B | n | Pearson | Spearman |',
    '| --- | --- | ---: | ---: | ---: |'
  ];
  for (const pair of topPairs) {
    mdLines.push(`| ${pair.labelA} | ${pair.labelB} | ${pair.n} | ${formatNumber(pair.pearson) || '--'} | ${formatNumber(pair.spearman) || '--'} |`);
  }
  mdLines.push('');
  mdLines.push('Generated files:');
  mdLines.push(`- \`${path.relative(process.cwd(), pairsPath)}\``);
  mdLines.push(`- \`${path.relative(process.cwd(), spearmanPath)}\``);
  mdLines.push(`- \`${path.relative(process.cwd(), pearsonPath)}\``);
  fs.writeFileSync(reportPath, `${mdLines.join('\n')}\n`, 'utf8');

  process.stdout.write(
    `Wrote ${path.relative(process.cwd(), pairsPath)}, ` +
    `${path.relative(process.cwd(), spearmanPath)}, ` +
    `${path.relative(process.cwd(), pearsonPath)}, and ` +
    `${path.relative(process.cwd(), reportPath)} from ${rows.length} successful runs\n`
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
