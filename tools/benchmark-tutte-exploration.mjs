import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function parseEdgeListText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const nodes = new Set();
  const edges = [];
  const seen = new Set();

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts[0] === 'v' || parts[0] === 'V') {
      if (parts.length >= 2) {
        nodes.add(String(parts[1]));
      }
      continue;
    }
    if (parts.length < 2) {
      continue;
    }
    const a = String(parts[0]);
    const b = String(parts[1]);
    if (a === b) {
      continue;
    }
    nodes.add(a);
    nodes.add(b);
    const key = a < b ? `${a}::${b}` : `${b}::${a}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    edges.push([a, b]);
  }

  return { nodeIds: [...nodes], edgePairs: edges };
}

function loadBrowserModules() {
  const window = {};
  window.window = window;

  const context = vm.createContext({
    window,
    console,
    Math,
    Set,
    Map,
    Array,
    Object,
    String,
    Number,
    Promise
  });

  const files = [
    'static/js/graph-generator.js',
    'static/js/planarity-test.js',
    'static/js/metrics.js',
    'static/js/linear-algebra.js',
    'static/js/geometry-utils.js',
    'static/js/planar-graph-utils.js',
    'static/js/graph-utils.js',
    'static/js/playground-utils.js',
    'static/js/layout-tutte.js',
    'static/js/layout-reweight.js',
    'static/js/layout-tutte-explore.js'
  ];

  for (const rel of files) {
    const abs = path.resolve(process.cwd(), rel);
    const code = fs.readFileSync(abs, 'utf8');
    new vm.Script(code, { filename: rel }).runInContext(context);
  }

  return window;
}

function nowNs() {
  return process.hrtime.bigint();
}

function nsToMs(ns) {
  return Number(ns) / 1e6;
}

async function measureAsync(fn) {
  const start = nowNs();
  const value = await fn();
  return {
    value,
    ms: nsToMs(nowNs() - start)
  };
}

function average(rows, key) {
  let total = 0;
  let count = 0;
  for (const row of rows) {
    if (Number.isFinite(row[key])) {
      total += row[key];
      count += 1;
    }
  }
  return count > 0 ? total / count : null;
}

function summarizeRuns(rows) {
  const okRows = rows.filter((row) => row.ok);
  const failedGraphs = rows.filter((row) => !row.ok).map((row) => row.graph);
  return {
    runs: rows.length,
    successes: okRows.length,
    avgMs: average(rows, 'ms'),
    avgFaceScore: average(okRows, 'faceScore'),
    avgEdgeScore: average(okRows, 'edgeScore'),
    avgAngleScore: average(okRows, 'angleScore'),
    avgEdgeRatio: average(okRows, 'edgeRatio'),
    avgSpacingScore: average(okRows, 'spacingScore'),
    avgIters: average(okRows, 'iters'),
    failedGraphs
  };
}

function projectPositions(GraphUtils, graph, result) {
  return GraphUtils.filterPositions((result && (result.pos || result.posById)) || {}, graph.nodeIds);
}

function collectMetrics(modules, graph, posById) {
  const Metrics = modules.PlanarVibeMetrics;
  const GraphUtils = modules.GraphUtils;
  const face = Metrics.computeUniformFaceAreaScore(graph.nodeIds, graph.edgePairs, posById);
  const edge = Metrics.computeUniformEdgeLengthScore(graph.edgePairs, posById);
  const angle = Metrics.computeUniformAngleResolutionScore(graph.nodeIds, graph.edgePairs, posById);
  const ratio = Metrics.computeEdgeLengthRatio(graph.edgePairs, posById);
  const spacing = Metrics.computeSpacingUniformityScore(graph.nodeIds, posById);
  const crossings = GraphUtils.hasPositionCrossings(posById, graph.edgePairs);
  return {
    face,
    edge,
    angle,
    ratio,
    spacing,
    crossings
  };
}

async function main() {
  const modules = loadBrowserModules();
  const Generator = modules.PlanarVibeGraphGenerator;
  const graphNames = JSON.parse(fs.readFileSync(path.resolve('docs/edgebalancer_objective_baseline.json'), 'utf8')).benchmark;
  const graphs = graphNames.map((name) => ({
    name,
    ...parseEdgeListText(Generator.getSample(name))
  }));

  const algorithms = [
    {
      name: 'Tutte',
      run(graph) {
        return modules.PlanarVibeTutte.computeTutteLayout(graph.nodeIds, graph.edgePairs);
      }
    },
    {
      name: 'ReweightTutte',
      run(graph) {
        return modules.PlanarVibeReweightTutte.computeReweightTuttePositions(graph.nodeIds, graph.edgePairs, {
          maxOuterIters: 6,
          warmIters: 1200,
          innerIters: 1600,
          finalIters: 1600,
          delayMs: 0
        });
      }
    },
    {
      name: 'DistanceReweightedTutte',
      run(graph) {
        return modules.PlanarVibeDistanceReweightedTutte.computeDistanceReweightedTuttePositions(graph.nodeIds, graph.edgePairs);
      }
    },
    {
      name: 'TutteAntiSmooth',
      run(graph) {
        return modules.PlanarVibeTutteAntiSmooth.computeTutteAntiSmoothPositions(graph.nodeIds, graph.edgePairs);
      }
    },
    {
      name: 'TutteFaceExpand',
      run(graph) {
        return modules.PlanarVibeTutteFaceExpand.computeTutteFaceExpandPositions(graph.nodeIds, graph.edgePairs);
      }
    },
    {
      name: 'DistanceReweightedTuttePlus',
      run(graph) {
        return modules.PlanarVibeDistanceReweightedTuttePlus.computeDistanceReweightedTuttePlusPositions(graph.nodeIds, graph.edgePairs);
      }
    }
  ];

  const rows = [];
  for (const graph of graphs) {
    for (const algorithm of algorithms) {
      const measured = await measureAsync(async () => algorithm.run(graph));
      const result = measured.value;
      const row = {
        graph: graph.name,
        algorithm: algorithm.name,
        ms: measured.ms,
        ok: false,
        iters: result && Number.isFinite(result.iters) ? result.iters : null,
        faceScore: null,
        edgeScore: null,
        angleScore: null,
        edgeRatio: null,
        spacingScore: null,
        crossings: null,
        message: result && (result.message || result.reason || result.status || result.stopReason || null)
      };

      if (result && result.ok) {
        const posById = projectPositions(modules.GraphUtils, graph, result);
        const metrics = collectMetrics(modules, graph, posById);
        row.crossings = metrics.crossings;
        row.faceScore = metrics.face.ok ? metrics.face.quality : null;
        row.edgeScore = metrics.edge.ok ? metrics.edge.quality : null;
        row.angleScore = metrics.angle.ok ? metrics.angle.score : null;
        row.edgeRatio = metrics.ratio.ok ? metrics.ratio.ratio : null;
        row.spacingScore = metrics.spacing.ok ? metrics.spacing.score : null;
        row.ok = !metrics.crossings &&
          metrics.face.ok &&
          metrics.edge.ok &&
          metrics.angle.ok &&
          metrics.ratio.ok &&
          metrics.spacing.ok;
        if (!row.ok && !row.message) {
          row.message = metrics.crossings ? 'crossings' : 'metric failure';
        }
      }

      rows.push(row);
    }
  }

  const summary = {};
  for (const algorithm of algorithms) {
    summary[algorithm.name] = summarizeRuns(rows.filter((row) => row.algorithm === algorithm.name));
  }

  const focusGraphs = ['sample1', 'sample2'];
  const focus = {};
  for (const graphName of focusGraphs) {
    focus[graphName] = rows
      .filter((row) => row.graph === graphName)
      .map((row) => ({
        algorithm: row.algorithm,
        ok: row.ok,
        faceScore: row.faceScore,
        edgeScore: row.edgeScore,
        angleScore: row.angleScore,
        edgeRatio: row.edgeRatio,
        spacingScore: row.spacingScore,
        ms: row.ms,
        iters: row.iters
      }));
  }

  const report = {
    benchmarkDate: new Date().toISOString(),
    graphNames,
    algorithms: algorithms.map((algorithm) => algorithm.name),
    summary,
    focus,
    rows
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
