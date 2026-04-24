import fs from 'node:fs';
import path from 'node:path';

import {
  REPORT_DATA_CSV,
  computeNormalizedRows,
  computeSummary,
  esc,
  formatMs,
  formatScore,
  geomean,
  mean,
  metricHeaders,
  parseCsv,
  parseOptionalNumber
} from './report-shared.mjs';

function cellValueHtml(v, bestValue) {
  if (!Number.isFinite(v)) return '--';
  const txt = formatScore(v);
  if (Number.isFinite(bestValue) && Math.abs(v - bestValue) <= 1e-12) {
    return `<strong>${txt}</strong>`;
  }
  return txt;
}

function cellRuntimeHtml(v, bestValue) {
  if (!Number.isFinite(v)) return '--';
  const txt = formatMs(v);
  if (Number.isFinite(bestValue) && Math.abs(v - bestValue) <= 1e-12) {
    return `<strong>${txt}</strong>`;
  }
  return txt;
}

function groupStartAttr(isGroupStart) {
  return isGroupStart ? ' class="group-start"' : '';
}

function computeSummaryBestValues(summaryByAlg, algorithms) {
  const bestByMetric = {};
  for (const [metricKey] of metricHeaders) {
    let best = null;
    for (const alg of algorithms) {
      const value = summaryByAlg[alg.key]?.[metricKey];
      if (!Number.isFinite(value)) continue;
      if (metricKey === 'runtime') {
        if (best === null || value < best) best = value;
      } else if (best === null || value > best) {
        best = value;
      }
    }
    bestByMetric[metricKey] = best;
  }
  return bestByMetric;
}

function buildSummaryData(rows, algorithms) {
  const meanSummary = computeSummary(rows, algorithms, metricHeaders, mean);
  const geomeanSummary = computeSummary(rows, algorithms, metricHeaders, geomean);
  const meanRuntimeSummary = {};
  const geomeanRuntimeSummary = {};
  for (const alg of algorithms) {
    const vals = [];
    for (const row of rows) {
      const rec = row.alg[alg.key];
      if (rec && rec.ok && Number.isFinite(rec.runtimeMs)) vals.push(rec.runtimeMs);
    }
    meanRuntimeSummary[alg.key] = mean(vals);
    geomeanRuntimeSummary[alg.key] = geomean(vals);
  }
  const meanSummaryAll = {};
  const geomeanSummaryAll = {};
  for (const alg of algorithms) {
    meanSummaryAll[alg.key] = { ...meanSummary[alg.key], runtime: meanRuntimeSummary[alg.key] };
    geomeanSummaryAll[alg.key] = { ...geomeanSummary[alg.key], runtime: geomeanRuntimeSummary[alg.key] };
  }
  return {
    meanSummary,
    geomeanSummary,
    meanRuntimeSummary,
    geomeanRuntimeSummary,
    meanBestByMetric: computeSummaryBestValues(meanSummaryAll, algorithms),
    geomeanBestByMetric: computeSummaryBestValues(geomeanSummaryAll, algorithms)
  };
}

function buildAlgorithmGroupedTable(rows, algorithms, summaryData) {
  let html = '';
  html += '<div class="wrap"><table><thead>\n<tr>';
  html += '<th rowspan="2">Graph</th><th rowspan="2">n</th><th rowspan="2">m</th>';
  for (let i = 0; i < algorithms.length; i += 1) {
    const alg = algorithms[i];
    html += `<th colspan="${metricHeaders.length}"${groupStartAttr(i > 0)}>${esc(alg.label)}</th>`;
  }
  html += '</tr>\n<tr>';
  for (let i = 0; i < algorithms.length; i += 1) {
    for (let j = 0; j < metricHeaders.length; j += 1) {
      const [, label] = metricHeaders[j];
      html += `<th${groupStartAttr(j === 0)}>${esc(label)}</th>`;
    }
  }
  html += '</tr>\n</thead><tbody>\n';

  for (const row of rows) {
    const rowBestByMetric = {};
    for (const [metricKey] of metricHeaders) {
      if (metricKey === 'runtime') {
        rowBestByMetric[metricKey] = null;
        continue;
      }
      let best = null;
      for (const alg of algorithms) {
        const v = row.norm[alg.key][metricKey];
        if (!Number.isFinite(v)) continue;
        if (best === null || v > best) best = v;
      }
      rowBestByMetric[metricKey] = best;
    }

    let bestRuntimeMs = null;
    for (const alg of algorithms) {
      const rec = row.alg[alg.key];
      if (!rec || !rec.ok || !Number.isFinite(rec.runtimeMs)) continue;
      if (bestRuntimeMs === null || rec.runtimeMs < bestRuntimeMs) bestRuntimeMs = rec.runtimeMs;
    }

    html += `<tr><td>${esc(row.graph)}</td><td>${row.n}</td><td>${row.m}</td>`;
    for (const alg of algorithms) {
      const r = row.alg[alg.key];
      const title = r && r.message ? ` title="${esc(r.message)}"` : '';
      if (!r || !r.ok) {
        for (let j = 0; j < metricHeaders.length; j += 1) {
          html += `<td${j === 0 ? ' class="fail group-start"' : ' class="fail"'}${title}>--</td>`;
        }
      } else {
        const nrm = row.norm[alg.key];
        for (let j = 0; j < metricHeaders.length; j += 1) {
          const [metricKey] = metricHeaders[j];
          if (metricKey === 'runtime') {
            html += `<td class="group-start"${title}>${cellRuntimeHtml(r.runtimeMs, bestRuntimeMs)}</td>`;
          } else {
            html += `<td>${cellValueHtml(nrm[metricKey], rowBestByMetric[metricKey])}</td>`;
          }
        }
      }
    }
    html += '</tr>\n';
  }

  html += '<tr class="summary"><td>mean</td><td>--</td><td>--</td>';
  for (const alg of algorithms) {
    for (let j = 0; j < metricHeaders.length; j += 1) {
      const [metricKey] = metricHeaders[j];
      if (metricKey === 'runtime') {
        html += `<td class="group-start">${cellRuntimeHtml(summaryData.meanRuntimeSummary[alg.key], summaryData.meanBestByMetric.runtime)}</td>`;
      } else {
        html += `<td>${cellValueHtml(summaryData.meanSummary[alg.key][metricKey], summaryData.meanBestByMetric[metricKey])}</td>`;
      }
    }
  }
  html += '</tr>\n';

  html += '<tr class="summary"><td>geomean</td><td>--</td><td>--</td>';
  for (const alg of algorithms) {
    for (let j = 0; j < metricHeaders.length; j += 1) {
      const [metricKey] = metricHeaders[j];
      if (metricKey === 'runtime') {
        html += `<td class="group-start">${cellRuntimeHtml(summaryData.geomeanRuntimeSummary[alg.key], summaryData.geomeanBestByMetric.runtime)}</td>`;
      } else {
        html += `<td>${cellValueHtml(summaryData.geomeanSummary[alg.key][metricKey], summaryData.geomeanBestByMetric[metricKey])}</td>`;
      }
    }
  }
  html += '</tr>\n';

  html += '</tbody></table></div>\n';
  return html;
}

function buildMetricGroupedTable(rows, algorithms, summaryData) {
  let html = '';
  html += '<div class="wrap"><table><thead>\n<tr>';
  html += '<th rowspan="2">Graph</th><th rowspan="2">n</th><th rowspan="2">m</th>';
  for (let i = 0; i < metricHeaders.length; i += 1) {
    const [, label] = metricHeaders[i];
    html += `<th colspan="${algorithms.length}"${groupStartAttr(i > 0)}>${esc(label)}</th>`;
  }
  html += '</tr>\n<tr>';
  for (let i = 0; i < metricHeaders.length; i += 1) {
    const [metricKey] = metricHeaders[i];
    for (let j = 0; j < algorithms.length; j += 1) {
      const alg = algorithms[j];
      const short = metricKey === 'runtime' ? alg.label : alg.label;
      html += `<th${groupStartAttr(j === 0)}>${esc(short)}</th>`;
    }
  }
  html += '</tr>\n</thead><tbody>\n';

  for (const row of rows) {
    const rowBestByMetric = {};
    for (const [metricKey] of metricHeaders) {
      let best = null;
      for (const alg of algorithms) {
        const rec = row.alg[alg.key];
        if (!rec || !rec.ok) continue;
        const value = metricKey === 'runtime' ? rec.runtimeMs : row.norm[alg.key][metricKey];
        if (!Number.isFinite(value)) continue;
        if (metricKey === 'runtime') {
          if (best === null || value < best) best = value;
        } else if (best === null || value > best) {
          best = value;
        }
      }
      rowBestByMetric[metricKey] = best;
    }

    html += `<tr><td>${esc(row.graph)}</td><td>${row.n}</td><td>${row.m}</td>`;
    for (const [metricKey] of metricHeaders) {
      for (let j = 0; j < algorithms.length; j += 1) {
        const alg = algorithms[j];
        const r = row.alg[alg.key];
        const title = r && r.message ? ` title="${esc(r.message)}"` : '';
        if (!r || !r.ok) {
          html += `<td${j === 0 ? ' class="fail group-start"' : ' class="fail"'}${title}>--</td>`;
          continue;
        }
        if (metricKey === 'runtime') {
          html += `<td${j === 0 ? ' class="group-start"' : ''}${title}>${cellRuntimeHtml(r.runtimeMs, rowBestByMetric.runtime)}</td>`;
        } else {
          html += `<td${j === 0 ? ' class="group-start"' : ''}>${cellValueHtml(row.norm[alg.key][metricKey], rowBestByMetric[metricKey])}</td>`;
        }
      }
    }
    html += '</tr>\n';
  }

  for (const summaryName of ['mean', 'geomean']) {
    const isMean = summaryName === 'mean';
    html += `<tr class="summary"><td>${summaryName}</td><td>--</td><td>--</td>`;
    for (const [metricKey] of metricHeaders) {
      for (let j = 0; j < algorithms.length; j += 1) {
        const alg = algorithms[j];
        if (metricKey === 'runtime') {
          const value = isMean ? summaryData.meanRuntimeSummary[alg.key] : summaryData.geomeanRuntimeSummary[alg.key];
          const best = isMean ? summaryData.meanBestByMetric.runtime : summaryData.geomeanBestByMetric.runtime;
          html += `<td${j === 0 ? ' class="group-start"' : ''}>${cellRuntimeHtml(value, best)}</td>`;
        } else {
          const value = isMean ? summaryData.meanSummary[alg.key][metricKey] : summaryData.geomeanSummary[alg.key][metricKey];
          const best = isMean ? summaryData.meanBestByMetric[metricKey] : summaryData.geomeanBestByMetric[metricKey];
          html += `<td${j === 0 ? ' class="group-start"' : ''}>${cellValueHtml(value, best)}</td>`;
        }
      }
    }
    html += '</tr>\n';
  }

  html += '</tbody></table></div>\n';
  return html;
}

function loadRowsFromCsv(csvPath) {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`Missing ${path.basename(csvPath)}. Run: node scripts/compute-report-data.mjs`);
  }

  const raw = fs.readFileSync(csvPath, 'utf8');
  const records = parseCsv(raw);
  if (records.length < 2) {
    throw new Error(`CSV file is empty: ${csvPath}`);
  }

  const header = records[0];
  const index = Object.fromEntries(header.map((name, i) => [name, i]));
  const required = [
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
    'face',
    'convexity',
    'edgeLengthDeviation',
    'edgeRatio',
    'edgeOrthogonality',
    'aspectRatio',
    'nodeUniformity',
    'alignment',
    'spacing'
  ];
  for (const key of required) {
    if (!(key in index)) throw new Error(`CSV is missing column: ${key}`);
  }

  const rowsByGraph = new Map();
  const algorithms = [];
  const algorithmSeen = new Set();
  let generatedAt = null;

  for (let r = 1; r < records.length; r += 1) {
    const record = records[r];
    if (!record.length || record.every((value) => value === '')) continue;
    const graph = record[index.graph];
    const algorithmKey = record[index.algorithm];
    const algorithmLabel = record[index.algorithmLabel];
    const n = Number(record[index.n]);
    const m = Number(record[index.m]);
    if (!rowsByGraph.has(graph)) {
      rowsByGraph.set(graph, { graph, n, m, alg: {} });
    }
    if (!algorithmSeen.has(algorithmKey)) {
      algorithms.push({ key: algorithmKey, label: algorithmLabel });
      algorithmSeen.add(algorithmKey);
    }
    if (!generatedAt && record[index.generatedAt]) generatedAt = record[index.generatedAt];

    rowsByGraph.get(graph).alg[algorithmKey] = {
      runtimeMs: parseOptionalNumber(record[index.runtimeMs]),
      ok: record[index.ok] === '1',
      message: record[index.message] || '',
      angularResolution: parseOptionalNumber(record[index.angularResolution]),
      face: parseOptionalNumber(record[index.face]),
      convexity: parseOptionalNumber(record[index.convexity]),
      edgeLengthDeviation: parseOptionalNumber(record[index.edgeLengthDeviation]),
      edgeRatio: parseOptionalNumber(record[index.edgeRatio]),
      edgeOrthogonality: parseOptionalNumber(record[index.edgeOrthogonality]),
      aspectRatio: parseOptionalNumber(record[index.aspectRatio]),
      nodeUniformity: parseOptionalNumber(record[index.nodeUniformity]),
      alignment: parseOptionalNumber(record[index.alignment]),
      spacing: parseOptionalNumber(record[index.spacing])
    };
  }

  return {
    generatedAt,
    algorithms,
    rows: [...rowsByGraph.values()]
  };
}

async function main() {
  const csvPath = path.resolve(process.cwd(), REPORT_DATA_CSV);
  const { generatedAt, algorithms, rows } = loadRowsFromCsv(csvPath);

  computeNormalizedRows(rows, algorithms, metricHeaders);
  const summaryData = buildSummaryData(rows, algorithms);

  let html = '';
  html += '<!doctype html>\n<html><head><meta charset="utf-8">\n';
  html += '<title>PlanarVibe Benchmark Report</title>\n';
  html += '<style>\n';
  html += 'body{font:13px/1.4 Arial,sans-serif;margin:16px;color:#222;}\n';
  html += 'h1{font-size:20px;margin:0 0 6px;}\n';
  html += '.meta{color:#555;margin-bottom:12px;}\n';
  html += '.wrap{overflow:auto;border:1px solid #ccc;max-height:84vh;}\n';
  html += 'table{border-collapse:collapse;min-width:1800px;width:max-content;}\n';
  html += 'th,td{border:1px solid #ddd;padding:4px 6px;white-space:nowrap;text-align:right;}\n';
  html += 'th:first-child,td:first-child{text-align:left;position:sticky;left:0;background:#fff;z-index:2;}\n';
  html += 'thead th{position:sticky;top:0;background:#f7f7f7;z-index:3;}\n';
  html += 'thead tr:nth-child(2) th{font-weight:normal;font-size:12px;}\n';
  html += '.group-start{border-left:3px solid #6f7f99 !important;}\n';
  html += 'td.fail{background:#fff4f4;color:#a00;}\n';
  html += 'tr.summary td{background:#f9f9f9;color:darkblue;font-weight:normal;}\n';
  html += 'h2{font-size:16px;margin:18px 0 8px;}\n';
  html += '</style></head><body>\n';
  html += `<h1>PlanarVibe Benchmark Report</h1><div class="meta">Metrics source: ${esc(path.basename(csvPath))} | data generated: ${esc(generatedAt || 'unknown')} | values are normalized to [0,1] per graph/metric (1 = best algorithm)</div>\n`;
  html += '<h2>Algorithms First</h2>\n';
  html += buildAlgorithmGroupedTable(rows, algorithms, summaryData);
  html += '<h2>Metrics First</h2>\n';
  html += buildMetricGroupedTable(rows, algorithms, summaryData);
  html += '</body></html>\n';

  fs.writeFileSync(path.resolve(process.cwd(), 'report.html'), html, 'utf8');
  process.stdout.write(`Wrote report.html with ${rows.length} graph rows from ${path.basename(csvPath)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
