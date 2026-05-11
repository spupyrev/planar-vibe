import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCli as runTableRenderer } from './layout-html-renderer.mjs';

export const LAYOUT_TABLE_REFRESH_TARGETS = [
  {
    name: 'sample',
    cachePath: 'evaluation_data/sample-graphs-layout-table-cache.json',
    outputPath: 'layout-table-sample.html'
  },
  {
    name: 'named',
    cachePath: 'evaluation_data/named-layout-table-cache.json',
    outputPath: 'layout-table-named.html'
  },
  {
    name: 'gd-collection',
    cachePath: 'evaluation_data/gd-collection-coords-layout-table-cache.json',
    outputPath: 'layout-table-gd-collection.html'
  }
];

function createIo(io) {
  return {
    stdout: io && io.stdout ? io.stdout : process.stdout,
    stderr: io && io.stderr ? io.stderr : process.stderr
  };
}

function usage(message, io) {
  const out = createIo(io);
  if (message) {
    out.stderr.write(`${message}\n\n`);
  }
  out.stderr.write(
    'Usage: ./scripts/layout-html [--only sample,named,gd-collection] [--list]\n'
  );
}

function parseArgs(argv) {
  const opts = {
    only: null,
    list: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--only' && i + 1 < argv.length) {
      opts.only = String(argv[i + 1]).split(',').map((s) => s.trim()).filter(Boolean);
      i += 1;
      continue;
    }
    if (arg === '--list') {
      opts.list = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    usage(`Unknown option: ${arg}`);
    process.exit(1);
  }
  return opts;
}

function selectTargets(only) {
  if (!only || only.length === 0) {
    return LAYOUT_TABLE_REFRESH_TARGETS;
  }
  const byName = new Map(LAYOUT_TABLE_REFRESH_TARGETS.map((target) => [target.name, target]));
  return only.map((name) => {
    const target = byName.get(name);
    if (!target) {
      throw new Error(`Unknown layout table target: ${name}`);
    }
    return target;
  });
}

export async function runCli(argv = process.argv.slice(2), io) {
  const out = createIo(io);
  const opts = parseArgs(argv);
  const targets = selectTargets(opts.only);

  if (opts.list) {
    for (const target of targets) {
      out.stdout.write(`${target.name}: ${target.cachePath} -> ${target.outputPath}\n`);
    }
    return;
  }

  for (const target of targets) {
    out.stdout.write(`Refreshing ${target.outputPath} from ${target.cachePath}\n`);
    await runTableRenderer(
      ['--from-cache', target.cachePath, '--output', target.outputPath],
      io
    );
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
