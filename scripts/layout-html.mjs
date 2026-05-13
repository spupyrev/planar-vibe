import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildHtml,
  runCli as runTableRenderer
} from './layout-html-renderer.mjs';

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
    name: 'gallery',
    outputPath: 'gallery.html',
    sources: [
      {
        cachePath: 'evaluation_data/sample-graphs-layout-table-cache.json'
      },
      {
        cachePath: 'evaluation_data/named-layout-table-cache.json'
      },
      {
        cachePath: 'evaluation_data/gd-collection-coords-layout-table-cache.json',
        sampleSize: 50,
        sampleSeed: 'gallery-gd-collection'
      }
    ]
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
    'Usage: ./scripts/layout-html [--only sample,named,gallery,gd-collection] [--list]\n'
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

function readLayoutTableCache(cachePath) {
  const absPath = path.resolve(process.cwd(), cachePath);
  const cache = JSON.parse(fs.readFileSync(absPath, 'utf8'));
  if (!cache || cache.schema !== 'planarvibe-layout-table-cache' || cache.version !== 1) {
    throw new Error(`Unsupported layout table cache: ${cachePath}`);
  }
  if (!cache.dataset || !Array.isArray(cache.algorithms) || !Array.isArray(cache.rows)) {
    throw new Error(`Malformed layout table cache: ${cachePath}`);
  }
  return cache;
}

function mergeAlgorithms(caches) {
  const algorithms = [];
  const seen = new Set();
  for (const cache of caches) {
    for (const algorithm of cache.algorithms) {
      if (!algorithm || !algorithm.key || seen.has(algorithm.key)) {
        continue;
      }
      seen.add(algorithm.key);
      algorithms.push(algorithm);
    }
  }
  return algorithms;
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function selectSourceRows(source, cache) {
  const rows = cache.rows || [];
  if (!source.sampleSize) {
    return rows;
  }
  const sampleSize = Math.max(0, Math.floor(source.sampleSize));
  const seed = source.sampleSeed || source.cachePath;
  return rows
    .map((row, index) => ({
      row,
      index,
      score: hashString(`${seed}:${row.graphName || ''}:${index}`)
    }))
    .sort((a, b) => {
      if (a.score !== b.score) {
        return a.score - b.score;
      }
      return a.index - b.index;
    })
    .slice(0, sampleSize)
    .map((entry) => entry.row);
}

function mergeRowsByGraphName(sources, caches) {
  const rows = [];
  const seen = new Set();
  for (let i = 0; i < caches.length; i += 1) {
    for (const row of selectSourceRows(sources[i], caches[i])) {
      if (!row || !row.graphName || seen.has(row.graphName)) {
        continue;
      }
      seen.add(row.graphName);
      rows.push(row);
    }
  }
  return rows;
}

function buildCombinedGallery(target, out) {
  const caches = target.sources.map((source) => {
    const cache = readLayoutTableCache(source.cachePath);
    out.stdout.write(`Read ${source.cachePath}\n`);
    return cache;
  });
  const dataset = {
    dataset: 'gallery',
    filePath: caches.map((cache) => cache.dataset.filePath).join(' + ')
  };
  const algorithms = mergeAlgorithms(caches);
  const rows = mergeRowsByGraphName(target.sources, caches);
  const html = buildHtml(dataset, '*', algorithms, rows);
  const absOutputPath = path.resolve(process.cwd(), target.outputPath);
  fs.writeFileSync(absOutputPath, html, 'utf8');
  out.stdout.write(`Wrote ${path.relative(process.cwd(), absOutputPath)}\n`);
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
      if (target.sources) {
        out.stdout.write(`${target.name}: ${target.sources.map((source) => source.cachePath).join(', ')} -> ${target.outputPath}\n`);
      } else {
        out.stdout.write(`${target.name}: ${target.cachePath} -> ${target.outputPath}\n`);
      }
    }
    return;
  }

  for (const target of targets) {
    if (target.sources) {
      out.stdout.write(`Refreshing ${target.outputPath} from ${target.sources.map((source) => source.cachePath).join(', ')}\n`);
      buildCombinedGallery(target, out);
      continue;
    }
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
