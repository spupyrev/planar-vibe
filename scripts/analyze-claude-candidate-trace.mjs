import fs from 'node:fs';

const DEFAULT_TRACE = '/tmp/claude-candidate-trace.json';

function parseArgs(argv) {
  const opts = {
    trace: DEFAULT_TRACE,
    top: 20
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === '--trace' || arg === '--input') && i + 1 < argv.length) {
      opts.trace = String(argv[++i]);
    } else if (arg === '--top' && i + 1 < argv.length) {
      opts.top = Math.max(0, Math.floor(Number(argv[++i]) || 0));
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: node scripts/analyze-claude-candidate-trace.mjs ' +
        '[--trace /tmp/claude-candidate-trace.json] [--top 20]\n'
      );
      process.exit(0);
    }
  }
  return opts;
}

function candidateRows(rec) {
  const rows = [];
  let current = null;
  for (const event of rec.events || []) {
    if (event.kind === 'candidate') {
      current = {
        label: event.label,
        candidateMs: Number(event.ms) || 0,
        expandMs: 0,
        variants: [],
        bestVariant: null,
        prefixBest: null,
        prefixBestLabel: null
      };
      rows.push(current);
    } else if (event.kind === 'expandVariants' && current && current.label === event.label) {
      current.expandMs = Number(event.ms) || 0;
      current.variants = event.extra && Array.isArray(event.extra.variants)
        ? event.extra.variants.filter((variant) => variant && Number.isFinite(variant.total))
        : [];
      for (const variant of current.variants) {
        if (!current.bestVariant || variant.total > current.bestVariant.total) {
          current.bestVariant = variant;
        }
      }
    } else if (event.kind === 'prefixBest' && current && current.label === event.label) {
      current.prefixBest = event.extra && event.extra.best ? event.extra.best.total : null;
      current.prefixBestLabel = event.extra && event.extra.best ? event.extra.best.label : null;
    }
  }
  return rows;
}

function queuedBalancerInfo(rec) {
  const out = {};
  for (const event of rec.events || []) {
    if (event.kind !== 'candidateQueued' || !event.extra) continue;
    out[event.label] = {
      interiorAugVertices: event.extra.interiorAugVertices,
      augNodes: event.extra.augNodes,
      augEdges: event.extra.augEdges,
      skipped: !!event.extra.skipped
    };
  }
  return out;
}

function bestOfVariants(rows) {
  let best = null;
  for (const row of rows) {
    if (!row.bestVariant) continue;
    if (!best || row.bestVariant.total > best.total) {
      best = {
        label: row.bestVariant.label,
        total: row.bestVariant.total,
        candidate: row.label
      };
    }
  }
  return best;
}

function simulate(rec, policy) {
  const rows = candidateRows(rec);
  const balancers = queuedBalancerInfo(rec);
  const accepted = [];
  let ms = 0;
  let best = null;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!policy.include(row, rec, { index: i, best, balancers, accepted })) {
      continue;
    }
    accepted.push(row);
    ms += row.candidateMs;
    if (policy.expand(row, rec, { index: i, best, balancers, accepted })) {
      ms += row.expandMs;
      if (row.bestVariant && (!best || row.bestVariant.total > best.total)) {
        best = {
          label: row.bestVariant.label,
          total: row.bestVariant.total,
          candidate: row.label
        };
      }
    } else {
      const base = row.variants.find((variant) => String(variant.label).endsWith(':base'));
      if (base && (!best || base.total > best.total)) {
        best = {
          label: base.label,
          total: base.total,
          candidate: row.label
        };
      }
    }
    if (policy.stopAfter(row, rec, { index: i, best, balancers, accepted })) {
      break;
    }
  }

  return {
    ms,
    best,
    accepted: accepted.map((row) => row.label)
  };
}

function candidateWork(row) {
  return row.candidateMs + row.expandMs;
}

function isLateFallback(label) {
  return label === 'Schnyder' || label === 'CEGBfs' || label === 'Tutte';
}

function shouldSkipLateFallbacks(rec) {
  return rec.n + rec.m >= 150;
}

function isHeavyBalancer(label) {
  return label === 'FABalancer' || label === 'AngleBalancer';
}

function hasLargeAugmentedBalancer(rec, balancers) {
  const infos = Object.values(balancers);
  return infos.some((info) => (
    Number.isFinite(info.interiorAugVertices) && info.interiorAugVertices > 250
  ) || (
    Number.isFinite(info.augEdges) && info.augEdges > 1500
  ));
}

function hasLargeAugmentedEdgeCount(balancers) {
  return Object.values(balancers).some((info) => (
    Number.isFinite(info.augEdges) && info.augEdges > 1500
  ));
}

function buildPolicies() {
  const always = () => true;
  const expandAlways = () => true;
  const stopNever = () => false;
  const policies = [
    {
      name: 'full',
      include: always,
      expand: expandAlways,
      stopAfter: stopNever
    },
    {
      name: 'no-late-fallbacks',
      include: (row) => !isLateFallback(row.label),
      expand: expandAlways,
      stopAfter: stopNever
    },
    {
      name: 'skip-heavy-balancers-on-large-aug',
      include: (row, rec, ctx) => !(hasLargeAugmentedBalancer(rec, ctx.balancers) && isHeavyBalancer(row.label)),
      expand: expandAlways,
      stopAfter: stopNever
    },
    {
      name: 'skip-heavy-large-aug-no-late',
      include: (row, rec, ctx) => {
        if (isLateFallback(row.label)) return false;
        if (hasLargeAugmentedBalancer(rec, ctx.balancers) && isHeavyBalancer(row.label)) return false;
        return true;
      },
      expand: expandAlways,
      stopAfter: stopNever
    },
    {
      name: 'final-size-policy',
      include: (row, rec, ctx) => {
        if (shouldSkipLateFallbacks(rec) && isLateFallback(row.label)) return false;
        if (hasLargeAugmentedEdgeCount(ctx.balancers) && isHeavyBalancer(row.label)) return false;
        return true;
      },
      expand: expandAlways,
      stopAfter: stopNever
    },
    {
      name: 'structural-edge-areagrad-reweight',
      include: (row) => (
        row.label === 'Tree' ||
        row.label === 'RadialTree' ||
        row.label === 'Unicyclic' ||
        row.label === 'Grid' ||
        row.label === 'OuterCircle' ||
        row.label === 'CoreTree' ||
        row.label === 'EdgeBalancer' ||
        row.label === 'AreaGrad' ||
        row.label === 'Reweight'
      ),
      expand: expandAlways,
      stopAfter: stopNever
    },
    {
      name: 'stop-after-reweight',
      include: always,
      expand: expandAlways,
      stopAfter: (row) => row.label === 'Reweight'
    },
    {
      name: 'stop-after-areagrad',
      include: always,
      expand: expandAlways,
      stopAfter: (row) => row.label === 'AreaGrad'
    },
    {
      name: 'oracle-first-final',
      include: always,
      expand: expandAlways,
      stopAfter: (row, rec, ctx) => {
        const fullBest = bestOfVariants(candidateRows(rec));
        return fullBest && ctx.best && Math.abs(ctx.best.total - fullBest.total) <= 1e-12;
      }
    }
  ];

  for (const k of [1, 2, 3, 4, 5]) {
    policies.push({
      name: `prefix-${k}`,
      include: (row, rec, ctx) => ctx.index < k,
      expand: expandAlways,
      stopAfter: (row, rec, ctx) => ctx.index + 1 >= k
    });
  }

  return policies;
}

function summarizePolicy(records, policy) {
  const rows = [];
  for (const rec of records) {
    const full = simulate(rec, buildPolicies()[0]);
    const sim = simulate(rec, policy);
    const fullTotal = full.best ? full.best.total : null;
    const simTotal = sim.best ? sim.best.total : null;
    rows.push({
      graph: rec.graph,
      n: rec.n,
      m: rec.m,
      fullMs: full.ms,
      ms: sim.ms,
      ratio: full.ms > 0 ? sim.ms / full.ms : null,
      fullBest: full.best,
      best: sim.best,
      totalDelta: Number.isFinite(fullTotal) && Number.isFinite(simTotal) ? simTotal - fullTotal : null,
      accepted: sim.accepted
    });
  }
  const validRows = rows.filter((row) => Number.isFinite(row.ratio));
  const deltas = rows
    .filter((row) => Number.isFinite(row.totalDelta))
    .map((row) => row.totalDelta);
  return {
    name: policy.name,
    rows,
    avgRatio: validRows.reduce((sum, row) => sum + row.ratio, 0) / Math.max(1, validRows.length),
    maxRatio: validRows.reduce((max, row) => Math.max(max, row.ratio), 0),
    avgDelta: deltas.reduce((sum, delta) => sum + delta, 0) / Math.max(1, deltas.length),
    minDelta: deltas.reduce((min, delta) => Math.min(min, delta), Infinity),
    unchanged: deltas.filter((delta) => Math.abs(delta) <= 1e-12).length,
    count: rows.length
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const data = JSON.parse(fs.readFileSync(opts.trace, 'utf8'));
  const records = Array.isArray(data.graphs) ? data.graphs : [];
  const policies = buildPolicies();
  const summaries = policies.map((policy) => summarizePolicy(records, policy));

  summaries.sort((a, b) => {
    if (a.minDelta !== b.minDelta) return b.minDelta - a.minDelta;
    return a.avgRatio - b.avgRatio;
  });

  console.log('policy,count,avgRuntimeRatio,maxRuntimeRatio,avgTotalDelta,minTotalDelta,unchanged');
  for (const summary of summaries) {
    console.log([
      summary.name,
      summary.count,
      summary.avgRatio.toFixed(3),
      summary.maxRatio.toFixed(3),
      summary.avgDelta.toFixed(9),
      summary.minDelta.toFixed(9),
      summary.unchanged
    ].join(','));
  }

  console.log('\nDETAILS');
  for (const summary of summaries.slice(0, opts.top)) {
    console.log(`\n${summary.name}`);
    for (const row of summary.rows) {
      const work = candidateRows(records.find((rec) => rec.graph === row.graph))
        .map((candidate) => `${candidate.label}:${(candidateWork(candidate) / 1000).toFixed(1)}s`)
        .join(' ');
      console.log(
        `${row.graph}\t${row.n}V/${row.m}E\t` +
        `${(row.ms / 1000).toFixed(1)}s/${(row.fullMs / 1000).toFixed(1)}s\t` +
        `ratio=${row.ratio.toFixed(3)}\t` +
        `delta=${Number.isFinite(row.totalDelta) ? row.totalDelta.toFixed(9) : 'NA'}\t` +
        `best=${row.best ? row.best.label : 'NA'}\t` +
        `accepted=${row.accepted.join('|')}\t` +
        `work=${work}`
      );
    }
  }
}

main();
