import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import {
  REPORT_INSTANCE_TIMEOUT_MS,
  benchmark,
  parseEdgeListText,
  loadBrowserModules
} from './report-shared.mjs';

function parseCsvLine(line) {
  const out = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === ',') {
      out.push(current);
      current = '';
    } else if (ch === '"') {
      inQuotes = true;
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

function readBaselineRows(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8').trim();
  const lines = text.split(/\r?\n/);
  const header = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const values = parseCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < header.length; j += 1) {
      row[header[j]] = values[j] ?? '';
    }
    if (row.algorithm === 'areagrad') {
      rows.push(row);
    }
  }
  return rows;
}

function numericOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function buildFailureRecord(graphName, runtimeMs, message) {
  return {
    graph: graphName,
    runtimeMs,
    ok: false,
    message: String(message || 'failed'),
    angle: null,
    face: null,
    edge: null,
    edgeRatio: null,
    spacing: null
  };
}

function runOneInstance(workerPath, graphName, timeoutMs) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    let settled = false;
    const worker = new Worker(workerPath, {
      workerData: {
        graphName,
        algorithmKey: 'areagrad'
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
        graphName,
        timeoutMs,
        `TLE (${Math.round(timeoutMs / 1000)}s)`
      ));
      worker.terminate().catch(function ignoreTerminateError() {});
    }, timeoutMs);

    worker.on('message', (msg) => {
      const runtimeMs = Number(process.hrtime.bigint() - started) / 1e6;
      if (msg && msg.ok && msg.rec) {
        finish({
          graph: graphName,
          runtimeMs: Number.isFinite(msg.rec.runtimeMs) ? msg.rec.runtimeMs : runtimeMs,
          ok: !!msg.rec.ok,
          message: msg.rec.message ? String(msg.rec.message) : '',
          angle: Number.isFinite(msg.rec.angle) ? msg.rec.angle : null,
          face: Number.isFinite(msg.rec.face) ? msg.rec.face : null,
          edge: Number.isFinite(msg.rec.edge) ? msg.rec.edge : null,
          edgeRatio: Number.isFinite(msg.rec.edgeRatio) ? msg.rec.edgeRatio : null,
          spacing: Number.isFinite(msg.rec.spacing) ? msg.rec.spacing : null
        });
      } else {
        finish(buildFailureRecord(
          graphName,
          runtimeMs,
          msg && msg.message ? msg.message : 'Instance failed'
        ));
      }
    });

    worker.on('error', (err) => {
      const runtimeMs = Number(process.hrtime.bigint() - started) / 1e6;
      finish(buildFailureRecord(
        graphName,
        runtimeMs,
        err && err.message ? err.message : String(err)
      ));
    });

    worker.on('exit', (code) => {
      if (settled) return;
      const runtimeMs = Number(process.hrtime.bigint() - started) / 1e6;
      finish(buildFailureRecord(
        graphName,
        runtimeMs,
        `Instance exited with code ${code}`
      ));
    });
  });
}

function compareRows(baselineRows, candidateRows, eps = 1e-9) {
  const candidateByGraph = new Map(candidateRows.map((row) => [row.graph, row]));
  const regressions = [];
  const improvements = [];
  const totals = {
    baselineFace: 0,
    candidateFace: 0,
    baselineOk: 0,
    candidateOk: 0
  };

  for (const base of baselineRows) {
    const cand = candidateByGraph.get(base.graph);
    const baseOk = String(base.ok) === '1';
    const baseFace = numericOrNull(base.face);
    totals.baselineOk += baseOk ? 1 : 0;
    totals.baselineFace += baseFace || 0;

    if (!cand) {
      regressions.push({ graph: base.graph, type: 'missing', baseline: base, candidate: null });
      continue;
    }

    totals.candidateOk += cand.ok ? 1 : 0;
    totals.candidateFace += cand.face || 0;

    if (baseOk && !cand.ok) {
      regressions.push({
        graph: base.graph,
        type: 'ok_to_fail',
        baseline: { ok: baseOk, face: baseFace, message: base.message || '' },
        candidate: { ok: cand.ok, face: cand.face, message: cand.message || '' }
      });
      continue;
    }

    if (!baseOk && cand.ok) {
      improvements.push({
        graph: base.graph,
        type: 'fail_to_ok',
        baseline: { ok: baseOk, face: baseFace, message: base.message || '' },
        candidate: { ok: cand.ok, face: cand.face, message: cand.message || '' }
      });
    }

    if (baseOk && cand.ok && baseFace !== null && cand.face !== null) {
      const delta = cand.face - baseFace;
      if (delta < -eps) {
        regressions.push({
          graph: base.graph,
          type: 'face_drop',
          delta,
          baseline: { face: baseFace, message: base.message || '' },
          candidate: { face: cand.face, message: cand.message || '' }
        });
      } else if (delta > eps) {
        improvements.push({
          graph: base.graph,
          type: 'face_gain',
          delta,
          baseline: { face: baseFace },
          candidate: { face: cand.face }
        });
      }
    }
  }

  return { regressions, improvements, totals };
}

async function main() {
  const csvPath = path.resolve(process.cwd(), 'report-data.csv');
  const baselineRows = await readBaselineRows(csvPath);
  const windowObj = loadBrowserModules();
  const Generator = windowObj.PlanarVibeGraphGenerator;
  const workerPath = path.resolve(process.cwd(), 'scripts/run-report-instance-worker.mjs');
  const timeoutMs = Number.isFinite(Number(process.env.REPORT_INSTANCE_TIMEOUT_MS))
    ? Math.max(1000, Math.floor(Number(process.env.REPORT_INSTANCE_TIMEOUT_MS)))
    : REPORT_INSTANCE_TIMEOUT_MS;

  const candidateRows = [];
  for (const graphName of benchmark) {
    const sample = Generator.getSample(graphName);
    if (!sample) {
      throw new Error(`Missing sample: ${graphName}`);
    }
    parseEdgeListText(sample);
    const rec = await runOneInstance(workerPath, graphName, timeoutMs);
    candidateRows.push(rec);
    process.stdout.write(`AreaGrad ${graphName} (${rec.ok ? 'ok' : 'fail'})\n`);
  }

  const summary = compareRows(baselineRows, candidateRows);
  process.stdout.write(JSON.stringify({
    baselineCount: baselineRows.length,
    candidateCount: candidateRows.length,
    regressions: summary.regressions,
    improvements: summary.improvements,
    totals: summary.totals
  }, null, 2) + '\n');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
