#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  exportDrawing,
  loadGraphs
} from './apply-layout-js.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_IMPLEMENTATION = 'cpp';

export function normalizeImplementation(value = DEFAULT_IMPLEMENTATION) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'js' || normalized === 'javascript') {
    return 'js';
  }
  if (normalized === 'cpp' || normalized === 'c++') {
    return 'cpp';
  }
  if (normalized === 'python' || normalized === 'py') {
    return 'python';
  }
  throw new Error(`Unknown implementation: ${value}`);
}

function usage(message, stream = process.stderr) {
  if (message) {
    stream.write(`${message}\n\n`);
  }
  stream.write(
    'Usage: ./scripts/apply-layout <graph-file> <graph-name> --algorithm <name|pattern> [options]\n' +
    '       ./scripts/apply-layout <graph-file> <graph-name> --algorithms input,tutte,*balancer* [options]\n' +
    '       ./scripts/apply-layout <graph-file> <graph-name> <algorithm> [options]\n\n' +
    'Options:\n' +
    '  --implementation js|javascript|cpp|c++|python|py   Choose implementation; default: cpp.\n' +
    '  --out PATH                                          Write JSON output; cpp/python only.\n' +
    '  --timeout SECONDS                                   JS implementation only.\n' +
    '  --export svg|pdf|PATH                               Export drawing as SVG/PDF.\n' +
    '  --help, -h                                          Show this help.\n'
  );
}

function parseExportValue(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    throw new Error('--export requires svg, pdf, or an output path.');
  }
  const lower = raw.toLowerCase();
  if (lower === 'svg' || lower === 'pdf') {
    return { raw, format: lower, outputPath: null };
  }
  const ext = path.extname(raw).toLowerCase().replace(/^\./, '');
  if (ext !== 'svg' && ext !== 'pdf') {
    throw new Error(`Unknown export target: ${raw}`);
  }
  return { raw, format: ext, outputPath: raw };
}

export function parseDispatcherArgs(argv) {
  const forwarded = [];
  let implementation = DEFAULT_IMPLEMENTATION;
  let sawHelp = false;
  let exportRequest = null;
  let outPath = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      sawHelp = true;
      forwarded.push(arg);
      continue;
    }
    if (arg === '--implementation') {
      if (i + 1 >= argv.length) {
        throw new Error('--implementation requires js, cpp, or python.');
      }
      implementation = normalizeImplementation(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith('--implementation=')) {
      implementation = normalizeImplementation(arg.slice('--implementation='.length));
      continue;
    }
    if (arg === '--export') {
      if (i + 1 >= argv.length) {
        throw new Error('--export requires svg, pdf, or an output path.');
      }
      exportRequest = parseExportValue(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith('--export=')) {
      exportRequest = parseExportValue(arg.slice('--export='.length));
      continue;
    }
    if (arg === '--out' && i + 1 < argv.length) {
      outPath = argv[i + 1];
      forwarded.push(arg, argv[i + 1]);
      i += 1;
      continue;
    }
    forwarded.push(arg);
  }

  const parsed = { implementation, forwarded, sawHelp };
  if (exportRequest) parsed.exportRequest = exportRequest;
  if (outPath) parsed.outPath = outPath;
  return parsed;
}

export function commandForImplementation(implementation, forwarded) {
  const impl = normalizeImplementation(implementation);
  if (impl === 'js') {
    return {
      command: process.execPath,
      args: [path.join(SCRIPT_DIR, 'apply-layout-js.mjs'), ...forwarded]
    };
  }
  if (impl === 'python') {
    return {
      command: 'python3',
      args: [path.join(REPO_ROOT, 'src-python', 'scripts', 'apply_layout.py'), ...forwarded]
    };
  }
  return {
    command: path.join(REPO_ROOT, 'src-cpp', 'build', 'apply_layout'),
    args: forwarded
  };
}

function stdioForChild(stdio) {
  if (stdio === 'inherit') {
    return 'inherit';
  }
  return ['ignore', 'pipe', 'pipe'];
}

function writeToIo(stdio, streamName, chunk) {
  if (stdio === 'inherit') {
    process[streamName].write(chunk);
    return;
  }
  const stream = stdio && stdio[streamName];
  if (stream && typeof stream.write === 'function') {
    stream.write(chunk);
  }
}

function spawnCommand(command, args, stdio) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: stdioForChild(stdio) });
    if (stdio !== 'inherit') {
      child.stdout?.on('data', (chunk) => writeToIo(stdio, 'stdout', String(chunk)));
      child.stderr?.on('data', (chunk) => writeToIo(stdio, 'stderr', String(chunk)));
    }
    child.on('error', (err) => {
      writeToIo(stdio, 'stderr', `Failed to run implementation: ${err.message}\n`);
      resolve(2);
    });
    child.on('close', (code, signal) => {
      if (signal) {
        writeToIo(stdio, 'stderr', `Implementation exited due to signal ${signal}\n`);
        resolve(1);
      } else {
        resolve(code ?? 0);
      }
    });
  });
}

function normalizePositions(positions) {
  if (!positions || typeof positions !== 'object') {
    return null;
  }
  const out = {};
  for (const [id, p] of Object.entries(positions)) {
    if (Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]))) {
      out[id] = { x: Number(p[0]), y: Number(p[1]) };
    } else if (p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))) {
      out[id] = { x: Number(p.x), y: Number(p.y) };
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function recordsFromPayload(payload) {
  return Array.isArray(payload) ? payload : [payload];
}

function renderExports(records, graphFile, exportRequest, stdio) {
  if (exportRequest.outputPath && records.length > 1) {
    throw new Error(`--export=${exportRequest.outputPath} names one file, but this command matched ${records.length} layouts.`);
  }

  const dataset = loadGraphs(graphFile);
  const graphsByName = new Map(dataset.graphs.map((graph) => [graph.graphName, graph]));

  for (const rec of records) {
    const positions = normalizePositions(rec.positions);
    if (!positions) {
      continue;
    }
    const graph = graphsByName.get(rec.graph);
    if (!graph) {
      throw new Error(`No graph named ${rec.graph} in ${graphFile}.`);
    }
    const exportGraphName = records.length === 1
      ? rec.graph
      : `${rec.graph}-${rec.algorithm}`;
    const exportedPath = exportDrawing(
      exportGraphName,
      graph.parsed,
      positions,
      exportRequest.format,
      exportRequest.outputPath
    );
    writeToIo(stdio, 'stdout', `Exported ${exportRequest.format.toUpperCase()} : ${path.relative(process.cwd(), exportedPath)}\n`);
  }
}

async function runWithWrapperExport(parsed, stdio) {
  const graphFile = parsed.forwarded[0];
  if (!graphFile) {
    usage('Expected <graph-file> before --export.');
    return 2;
  }

  let tmpDir = null;
  let jsonPath = parsed.outPath;
  const forwarded = parsed.forwarded.slice();
  if (!jsonPath) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'planarvibe-apply-layout-'));
    jsonPath = path.join(tmpDir, 'layout.json');
    forwarded.push('--out', jsonPath);
  }

  const { command, args } = commandForImplementation(parsed.implementation, forwarded);
  const code = await spawnCommand(command, args, stdio);
  if (code !== 0) {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    return code;
  }

  try {
    const payload = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    renderExports(recordsFromPayload(payload), graphFile, parsed.exportRequest, stdio);
  } catch (err) {
    writeToIo(stdio, 'stderr', `${err && err.message ? err.message : String(err)}\n`);
    return 2;
  } finally {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return 0;
}

export function runCli(argv = process.argv.slice(2), stdio = 'inherit') {
  let parsed;
  try {
    parsed = parseDispatcherArgs(argv);
  } catch (err) {
    usage(err.message);
    return Promise.resolve(2);
  }

  if (parsed.sawHelp) {
    usage(null, process.stdout);
    return Promise.resolve(0);
  }

  if (parsed.exportRequest && parsed.implementation !== 'js') {
    return runWithWrapperExport(parsed, stdio);
  }

  const forwarded = parsed.exportRequest
    ? [...parsed.forwarded, `--export=${parsed.exportRequest.raw}`]
    : parsed.forwarded;
  const { command, args } = commandForImplementation(parsed.implementation, forwarded);
  return spawnCommand(command, args, stdio);
}

const isMainModule = (() => {
  if (!process.argv[1]) {
    return false;
  }
  return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
})();

if (isMainModule) {
  const code = await runCli();
  process.exitCode = code;
}
