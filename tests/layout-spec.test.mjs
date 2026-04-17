import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

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
    Number
  });

  const files = [
    'static/js/planarity-test.js',
    'static/js/metrics.js',
    'static/js/linear-algebra.js',
    'static/js/geometry-utils.js',
    'static/js/planar-graph-utils.js',
    'static/js/graph-utils.js',
    'static/js/layout-preprocessing.js',
    'static/js/cy-runtime.js',
    'static/js/layout-tutte.js',
    'static/js/layout-air.js',
    'static/js/layout-ppag.js',
    'static/js/layout-facebalancer.js',
    'static/js/layout-edgebalancer.js',
    'static/js/layout-anglebalancer.js',
    'static/js/layout-fabalancer.js',
    'static/js/layout-ceg23.js',
    'static/js/layout-impred.js',
    'static/js/layout-reweight.js',
    'static/js/layout-fd-uniform.js',
    'static/js/layout-p3t.js',
    'static/js/layout-fpp.js',
    'static/js/layout-schnyder.js'
  ];

  for (const rel of files) {
    const abs = path.resolve(process.cwd(), rel);
    const code = fs.readFileSync(abs, 'utf8');
    new vm.Script(code, { filename: rel }).runInContext(context);
  }

  return window;
}

const modules = loadBrowserModules();
const GraphUtils = modules.GraphUtils;
const GeometryUtils = modules.GeometryUtils;
const LayoutPreprocessing = modules.LayoutPreprocessing;
const Metrics = modules.PlanarVibeMetrics;
const Tutte = modules.PlanarVibeTutte;
const TutteAlgorithm = modules.PlanarVibeTutte;
const Air = modules.PlanarVibeAir;
const PPAG = modules.PlanarVibePPAG;
const FaceBalancer = modules.PlanarVibeFaceBalancer;
const EdgeBalancer = modules.PlanarVibeEdgeBalancer;
const AngleBalancer = modules.PlanarVibeAngleBalancer;
const Hybrid = modules.PlanarVibeHybrid;
const CEG23 = modules.PlanarVibeCEG23Bfs;
const CEG23XY = modules.PlanarVibeCEG23Xy;
const ImPrEd = modules.PlanarVibeImPrEd;
const Reweight = modules.PlanarVibeReweightTutte;
const FDUniform = modules.PlanarVibeFDUniform;
const P3T = modules.PlanarVibeP3T;
const FPP = modules.PlanarVibeFPP;
const Schnyder = modules.PlanarVibeSchnyder;

const K4 = Object.assign(GraphUtils.createGraph(
  ['1', '2', '3', '4'],
  [
    ['1', '2'], ['1', '3'], ['1', '4'],
    ['2', '3'], ['2', '4'], ['3', '4']
  ]
), { name: 'K4' });

const CUBE = Object.assign(GraphUtils.createGraph(
  ['1', '2', '3', '4', '5', '6', '7', '8'],
  [
    ['1', '2'], ['2', '3'], ['3', '4'], ['4', '1'],
    ['5', '6'], ['6', '7'], ['7', '8'], ['8', '5'],
    ['1', '5'], ['2', '6'], ['3', '7'], ['4', '8']
  ]
), { name: 'cube' });

const OCTAHEDRON = Object.assign(GraphUtils.createGraph(
  ['1', '2', '3', '4', '5', '6'],
  [
    ['1', '2'], ['1', '3'], ['1', '4'], ['1', '5'],
    ['6', '2'], ['6', '3'], ['6', '4'], ['6', '5'],
    ['2', '3'], ['3', '4'], ['4', '5'], ['5', '2']
  ]
), { name: 'octahedron' });

function projectOriginalPositions(graph, result) {
  const pos = result && (result.positions || result.posById);
  return GeometryUtils.filterPositionMap(pos || {}, graph.nodeIds);
}

function assertFiniteOriginalPositions(graph, posById, label) {
  assert.equal(Object.keys(posById).length, graph.nodeIds.length, `${label}: original vertex count mismatch`);
  for (const id of graph.nodeIds) {
    const pos = posById[String(id)];
    assert.ok(pos, `${label}: missing position for ${id}`);
    assert.equal(Number.isFinite(pos.x), true, `${label}: non-finite x for ${id}`);
    assert.equal(Number.isFinite(pos.y), true, `${label}: non-finite y for ${id}`);
  }
}

function assertPlaneDrawing(graph, posById, label) {
  assert.equal(GeometryUtils.hasPositionCrossings(posById, graph.edgePairs), false, `${label}: drawing has crossings`);
}

function assertFaceScoreRange(graph, posById, label) {
  const faceScore = Metrics.computeUniformFaceAreaScore(graph.nodeIds, graph.edgePairs, posById);
  assert.equal(faceScore.ok, true, `${label}: face score failed: ${faceScore.reason || ''}`);
  assert.ok(Number.isFinite(faceScore.quality), `${label}: face score is not finite`);
  assert.ok(faceScore.quality >= 0 && faceScore.quality <= 1, `${label}: face score out of range: ${faceScore.quality}`);
}

function assertNormalizedFailureResult(result, label) {
  assert.equal(result && result.ok, false, `${label}: expected failure result`);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'positions'), true, `${label}: missing positions`);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'posById'), true, `${label}: missing posById`);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'iters'), true, `${label}: missing iters`);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'iterations'), true, `${label}: missing iterations`);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'outerFace'), true, `${label}: missing outerFace`);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'graph'), true, `${label}: missing graph`);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'augmented'), true, `${label}: missing augmented`);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'status'), true, `${label}: missing status`);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'stopReason'), true, `${label}: missing stopReason`);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'pos'), false, `${label}: unexpected pos alias`);
  assert.equal(result.positions, null, `${label}: expected positions to be null`);
  assert.equal(result.posById, null, `${label}: expected posById to be null`);
}

test('GraphUtils.createGraph requires canonical string ids and edge pairs', () => {
  assert.throws(() => GraphUtils.createGraph(
    [1, '2', 3],
    [[1, 2], ['2', 3]]
  ), /Graph node ids must be strings/);

  const graph = GraphUtils.createGraph(
    ['1', '2', '3'],
    [['1', '2'], ['2', '3']]
  );
  assert.deepEqual(JSON.parse(JSON.stringify({
    nodeIds: graph.nodeIds,
    edgePairs: graph.edgePairs,
    adjacency: graph.adjacency
  })), {
    nodeIds: ['1', '2', '3'],
    edgePairs: [['1', '2'], ['2', '3']],
    adjacency: {
      '1': ['2'],
      '2': ['1', '3'],
      '3': ['2']
    }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(Array.from(graph.adjacencySets['1']))), ['2']);
  assert.deepEqual(JSON.parse(JSON.stringify(Array.from(graph.adjacencySets['2']).sort())), ['1', '3']);
  assert.deepEqual(JSON.parse(JSON.stringify(Array.from(graph.adjacencySets['3']))), ['2']);
});

test('shared barycentric seed helpers produce finite plane drawings', () => {
  const prepared = LayoutPreprocessing.prepareGraphAndLayoutData(CUBE, {
    failureLabel: 'Shared seed test'
  });
  assert.equal(prepared && prepared.ok, true, prepared && (prepared.message || prepared.reason || 'shared seed prep failed'));
  const posById = GeometryUtils.filterPositionMap(prepared.posById || {}, CUBE.nodeIds);
  assertFiniteOriginalPositions(CUBE, posById, `shared seed on ${CUBE.name}`);
  assertPlaneDrawing(CUBE, posById, `shared seed on ${CUBE.name}`);
  assertFaceScoreRange(CUBE, posById, `shared seed on ${CUBE.name}`);
});

test('placeOuterFaceVertices places the first outer-face edge horizontally by construction', () => {
  const face = ['a', 'b', 'c', 'd', 'e'];
  const pos = Tutte.placeOuterFaceVertices(face, face, Tutte.defaultOuterPlacementOptions());
  const a = pos.a;
  const b = pos.b;
  assert.ok(a && b, 'expected outer-face vertices to be placed');
  assert.ok(Math.abs(a.y - b.y) < 1e-9, `expected first edge to be horizontal, got dy=${b.y - a.y}`);
});

async function assertComputeSpec(spec) {
  const result = await spec.run(spec.graph);
  assert.equal(result && result.ok, true, `${spec.name} failed on ${spec.graph.name}: ${result && (result.message || result.reason || result.stopReason || result.status)}`);

  const posById = projectOriginalPositions(spec.graph, result);
  assertFiniteOriginalPositions(spec.graph, posById, `${spec.name} on ${spec.graph.name}`);
  assertPlaneDrawing(spec.graph, posById, `${spec.name} on ${spec.graph.name}`);
  assertFaceScoreRange(spec.graph, posById, `${spec.name} on ${spec.graph.name}`);
}

const layoutSpecs = [
  {
    name: 'Tutte barycentric primitive',
    graph: K4,
    run(graph) {
      return TutteAlgorithm.computeBarycentricPositions(
        graph,
        ['1', '2', '3'],
        {
          weights: TutteAlgorithm.buildTutteWeights(graph, graph),
          initOptions: TutteAlgorithm.defaultOuterPlacementOptions()
        }
      );
    }
  },
  {
    name: 'Tutte compute',
    graph: CUBE,
    run(graph) {
      return Tutte.computeTutteLayout(graph, {});
    }
  },
  {
    name: 'Air compute',
    graph: CUBE,
    run(graph) {
      return Air.computeAirPositions(graph, {
        delayMs: 0,
        yieldEvery: 50
      });
    }
  },
  {
    name: 'PPAG compute',
    graph: CUBE,
    run(graph) {
      return PPAG.computePPAGPositions(graph, {
        delayMs: 0,
        yieldEvery: 50,
        maxIters: 120
      });
    }
  },
  {
    name: 'FaceBalancer compute',
    graph: CUBE,
    run(graph) {
      return FaceBalancer.computeFaceBalancerPositions(graph, {
        delayMs: 0,
        maxIters: 20
      });
    }
  },
  {
    name: 'EdgeBalancer compute',
    graph: CUBE,
    run(graph) {
      return EdgeBalancer.computeEdgeBalancerPositions(graph, {
        delayMs: 0,
        maxIters: 20
      });
    }
  },
  {
    name: 'AngleBalancer compute',
    graph: CUBE,
    run(graph) {
      return AngleBalancer.computeAngleBalancerPositions(graph, {
        delayMs: 0
      });
    }
  },
  {
    name: 'Hybrid compute',
    graph: CUBE,
    run(graph) {
      return Hybrid.computeHybridPositions(graph, {
        delayMs: 0
      });
    }
  },
  {
    name: 'CEG23-bfs compute',
    graph: CUBE,
    run(graph) {
      return CEG23.computeCEG23BfsPositions(graph, {
        maxIters: 1200
      });
    }
  },
  {
    name: 'CEG23-xy compute',
    graph: CUBE,
    run(graph) {
      return CEG23XY.computeCEG23XyPositions(graph, {
        maxIters: 1200
      });
    }
  },
  {
    name: 'ImPrEd compute',
    graph: CUBE,
    run(graph) {
      return ImPrEd.computeImPrEdPositions(graph, {
        delayMs: 0,
        maxIters: 40
      });
    }
  },
  {
    name: 'ReweightTutte compute',
    graph: CUBE,
    run(graph) {
      return Reweight.computeReweightTuttePositions(graph, {
        maxOuterIters: 6,
        innerIters: 300,
        finalIters: 400
      });
    }
  },
  {
    name: 'FD-uniform compute',
    graph: CUBE,
    run(graph) {
      return FDUniform.computeFDUniformPositions(graph, {
        maxIters: 120
      });
    }
  },
  {
    name: 'FPP compute',
    graph: OCTAHEDRON,
    run(graph) {
      return FPP.computeFPPPositions(graph);
    }
  },
  {
    name: 'Schnyder compute',
    graph: OCTAHEDRON,
    run(graph) {
      return Schnyder.computeSchnyderPositions(graph);
    }
  },
  {
    name: 'P3T compute',
    graph: K4,
    run(graph) {
      return P3T.computeP3TPositions(graph);
    }
  }
];

for (const spec of layoutSpecs) {
  test(`${spec.name} returns a finite non-crossing drawing on ${spec.graph.name}`, async () => {
    await assertComputeSpec(spec);
  });
}

test('normalized failure shape is preserved for exported compute functions', async () => {
  const nonPlanarK5 = GraphUtils.createGraph(
    ['1', '2', '3', '4', '5'],
    [
      ['1', '2'], ['1', '3'], ['1', '4'], ['1', '5'],
      ['2', '3'], ['2', '4'], ['2', '5'],
      ['3', '4'], ['3', '5'],
      ['4', '5']
    ]
  );
  const emptyGraph = GraphUtils.createGraph([], []);
  const singleEdgeGraph = GraphUtils.createGraph(['1', '2'], [['1', '2']]);

  const failureCases = [
    {
      name: 'Tutte barycentric primitive',
      run: () => TutteAlgorithm.computeBarycentricPositions(emptyGraph, [], {
        weights: TutteAlgorithm.buildTutteWeights(emptyGraph, emptyGraph)
      })
    },
    {
      name: 'Tutte compute',
      run: () => Tutte.computeTutteLayout(singleEdgeGraph, {})
    },
    {
      name: 'CEG23-bfs compute',
      run: () => CEG23.computeCEG23BfsPositions(singleEdgeGraph, {})
    },
    {
      name: 'CEG23-xy compute',
      run: () => CEG23XY.computeCEG23XyPositions(singleEdgeGraph, {})
    },
    {
      name: 'ReweightTutte compute',
      run: () => Reweight.computeReweightTuttePositions(singleEdgeGraph, {})
    },
    {
      name: 'FD-uniform compute',
      run: () => FDUniform.computeFDUniformPositions(singleEdgeGraph, {})
    },
    {
      name: 'FPP compute',
      run: () => FPP.computeFPPPositions(nonPlanarK5)
    },
    {
      name: 'Schnyder compute',
      run: () => Schnyder.computeSchnyderPositions(nonPlanarK5)
    },
    {
      name: 'P3T compute',
      run: () => P3T.computeP3TPositions(CUBE)
    }
  ];

  for (const failureCase of failureCases) {
    const result = await failureCase.run();
    assertNormalizedFailureResult(result, failureCase.name);
  }
});
