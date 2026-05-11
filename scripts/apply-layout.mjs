#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    '  --export svg|pdf|PATH                               JS implementation only.\n' +
    '  --help, -h                                          Show this help.\n'
  );
}

export function parseDispatcherArgs(argv) {
  const forwarded = [];
  let implementation = DEFAULT_IMPLEMENTATION;
  let sawHelp = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      sawHelp = true;
      forwarded.push(arg);
      continue;
    }
    if (arg === '--implementation' && i + 1 < argv.length) {
      implementation = normalizeImplementation(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith('--implementation=')) {
      implementation = normalizeImplementation(arg.slice('--implementation='.length));
      continue;
    }
    forwarded.push(arg);
  }

  return { implementation, forwarded, sawHelp };
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

  const { command, args } = commandForImplementation(parsed.implementation, parsed.forwarded);
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio });
    child.on('error', (err) => {
      process.stderr.write(`Failed to run ${parsed.implementation} implementation: ${err.message}\n`);
      resolve(2);
    });
    child.on('close', (code, signal) => {
      if (signal) {
        process.stderr.write(`Implementation exited due to signal ${signal}\n`);
        resolve(1);
      } else {
        resolve(code ?? 0);
      }
    });
  });
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
