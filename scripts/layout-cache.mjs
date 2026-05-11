import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCli as runCacheTarget } from './layout-cache-runner.mjs';

export const LAYOUT_TABLE_CACHE_ALGORITHMS = [
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

function withInput(algorithms) {
  return ['input', ...algorithms];
}

export const LAYOUT_TABLE_CACHE_TARGETS = [
  {
    name: 'sample',
    graphFile: 'benchmark/sample_graphs_coords.dot',
    graphPattern: '*',
    outputPath: 'evaluation_data/sample-graphs-layout-table-cache.json',
    algorithms: withInput(LAYOUT_TABLE_CACHE_ALGORITHMS)
  },
  {
    name: 'named',
    graphFile: 'benchmark/named.dot',
    graphPattern: '*',
    outputPath: 'evaluation_data/named-layout-table-cache.json',
    algorithms: LAYOUT_TABLE_CACHE_ALGORITHMS
  },
  {
    name: 'gd-collection-coords',
    graphFile: 'benchmark/gd_collection_coords.dot',
    graphPattern: '*',
    outputPath: 'evaluation_data/gd-collection-coords-layout-table-cache.json',
    algorithms: withInput(LAYOUT_TABLE_CACHE_ALGORITHMS)
  },
  {
    name: 'gd-collection',
    graphFile: 'benchmark/gd_collection.dot',
    graphPattern: '*',
    outputPath: 'evaluation_data/gd-collection-layout-table-cache.json',
    algorithms: LAYOUT_TABLE_CACHE_ALGORITHMS
  },
  {
    name: 'north',
    graphFile: 'benchmark/north.dot',
    graphPattern: '*',
    outputPath: 'evaluation_data/north-layout-table-cache.json',
    algorithms: LAYOUT_TABLE_CACHE_ALGORITHMS
  },
  {
    name: 'rome',
    graphFile: 'benchmark/rome.dot',
    graphPattern: '*',
    outputPath: 'evaluation_data/rome-layout-table-cache.json',
    algorithms: LAYOUT_TABLE_CACHE_ALGORITHMS
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
    'Usage: ./scripts/layout-cache ' +
    '[--only sample,named,gd-collection-coords,gd-collection,north,rome] ' +
    '[--timeout 30] [--concurrency 4] [--cpp-bin src-cpp/build/apply_layout] [--list]\n'
  );
}

function parseArgs(argv) {
  const opts = {
    only: null,
    timeout: '30',
    concurrency: '4',
    cppBin: 'src-cpp/build/apply_layout',
    list: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--only' && i + 1 < argv.length) {
      opts.only = String(argv[i + 1]).split(',').map((s) => s.trim()).filter(Boolean);
      i += 1;
      continue;
    }
    if (arg === '--timeout' && i + 1 < argv.length) {
      opts.timeout = String(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--concurrency' && i + 1 < argv.length) {
      opts.concurrency = String(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--cpp-bin' && i + 1 < argv.length) {
      opts.cppBin = String(argv[i + 1]);
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
    return LAYOUT_TABLE_CACHE_TARGETS;
  }
  const byName = new Map(LAYOUT_TABLE_CACHE_TARGETS.map((target) => [target.name, target]));
  return only.map((name) => {
    const target = byName.get(name);
    if (!target) {
      throw new Error(`Unknown cache target: ${name}`);
    }
    return target;
  });
}

function formatTarget(target) {
  return [
    `${target.name}:`,
    `${target.graphFile}`,
    `"${target.graphPattern}"`,
    `--algorithms ${target.algorithms.join(',')}`,
    `--output ${target.outputPath}`
  ].join(' ');
}

export async function runCli(argv = process.argv.slice(2), io) {
  const out = createIo(io);
  const opts = parseArgs(argv);
  const targets = selectTargets(opts.only);

  if (opts.list) {
    for (const target of targets) {
      out.stdout.write(`${formatTarget(target)}\n`);
    }
    return;
  }

  for (const target of targets) {
    out.stdout.write(`Rebuilding ${target.outputPath} from ${target.graphFile} using C++\n`);
    await runCacheTarget(
      [
        target.graphFile,
        target.graphPattern,
        '--algorithms', target.algorithms.join(','),
        '--timeout', opts.timeout,
        '--concurrency', opts.concurrency,
        '--cpp-bin', opts.cppBin,
        '--output', target.outputPath
      ],
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
