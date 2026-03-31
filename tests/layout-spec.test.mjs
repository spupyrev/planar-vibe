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
    'static/js/graph-utils.js',
    'static/js/playground-utils.js',
    'static/js/layout-tutte.js',
    'static/js/layout-air.js',
    'static/js/layout-ppag.js',
    'static/js/layout-facebalancer.js',
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
const Metrics = modules.PlanarVibeMetrics;
const PlaygroundUtils = modules.PlaygroundUtils;
const Tutte = modules.PlanarVibeTutte;
const TutteAlgorithm = modules.PlanarVibeTutteAlgorithm;
const Air = modules.PlanarVibeAir;
const PPAG = modules.PlanarVibePPAG;
const FaceBalancer = modules.PlanarVibeFaceBalancer;
const CEG23 = modules.PlanarVibeCEG23Bfs;
const CEG23XY = modules.PlanarVibeCEG23Xy;
const ImPrEd = modules.PlanarVibeImPrEd;
const Reweight = modules.PlanarVibeReweightTutte;
const FDUniform = modules.PlanarVibeFDUniform;
const P3T = modules.PlanarVibeP3T;
const FPP = modules.PlanarVibeFPP;
const Schnyder = modules.PlanarVibeSchnyder;

const K4 = {
  name: 'K4',
  nodeIds: ['1', '2', '3', '4'],
  edgePairs: [
    ['1', '2'], ['1', '3'], ['1', '4'],
    ['2', '3'], ['2', '4'], ['3', '4']
  ]
};

const CUBE = {
  name: 'cube',
  nodeIds: ['1', '2', '3', '4', '5', '6', '7', '8'],
  edgePairs: [
    ['1', '2'], ['2', '3'], ['3', '4'], ['4', '1'],
    ['5', '6'], ['6', '7'], ['7', '8'], ['8', '5'],
    ['1', '5'], ['2', '6'], ['3', '7'], ['4', '8']
  ]
};

const OCTAHEDRON = {
  name: 'octahedron',
  nodeIds: ['1', '2', '3', '4', '5', '6'],
  edgePairs: [
    ['1', '2'], ['1', '3'], ['1', '4'], ['1', '5'],
    ['6', '2'], ['6', '3'], ['6', '4'], ['6', '5'],
    ['2', '3'], ['3', '4'], ['4', '5'], ['5', '2']
  ]
};

function projectOriginalPositions(graph, result) {
  const pos = result && (result.pos || result.posById);
  return GraphUtils.filterPositions(pos || {}, graph.nodeIds);
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
  assert.equal(Metrics.hasCrossingsFromPositions(posById, graph.edgePairs), false, `${label}: drawing has crossings`);
}

function assertFaceScoreRange(graph, posById, label) {
  const faceScore = Metrics.computeUniformFaceAreaScore(graph.nodeIds, graph.edgePairs, posById);
  assert.equal(faceScore.ok, true, `${label}: face score failed: ${faceScore.reason || ''}`);
  assert.ok(Number.isFinite(faceScore.quality), `${label}: face score is not finite`);
  assert.ok(faceScore.quality >= 0 && faceScore.quality <= 1, `${label}: face score out of range: ${faceScore.quality}`);
}

function assertNormalizedFailureResult(result, label) {
  assert.equal(result && result.ok, false, `${label}: expected failure result`);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'pos'), true, `${label}: missing pos`);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'posById'), true, `${label}: missing posById`);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'iters'), true, `${label}: missing iters`);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'iterations'), true, `${label}: missing iterations`);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'outerFace'), true, `${label}: missing outerFace`);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'graph'), true, `${label}: missing graph`);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'augmented'), true, `${label}: missing augmented`);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'status'), true, `${label}: missing status`);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'stopReason'), true, `${label}: missing stopReason`);
  assert.equal(result.pos, null, `${label}: expected pos to be null`);
  assert.equal(result.posById, null, `${label}: expected posById to be null`);
}

test('GraphUtils.normalizeGraphInput normalizes ids and edge pairs once', () => {
  const graph = GraphUtils.normalizeGraphInput([1, '2', 3], [[1, 2], ['2', 3]]);
  assert.deepEqual(JSON.parse(JSON.stringify(graph)), {
    nodeIds: ['1', '2', '3'],
    edgePairs: [['1', '2'], ['2', '3']]
  });
});

test('shared barycentric seed helpers produce finite plane drawings', () => {
  const prepared = PlaygroundUtils.prepareGraphAndLayoutData(CUBE, {
    failureLabel: 'Shared seed test',
    minNodeCount: 3
  });
  assert.equal(prepared && prepared.ok, true, prepared && (prepared.message || prepared.reason || 'shared seed prep failed'));
  const posById = GraphUtils.filterPositions(prepared.posById || {}, CUBE.nodeIds);
  assertFiniteOriginalPositions(CUBE, posById, `shared seed on ${CUBE.name}`);
  assertPlaneDrawing(CUBE, posById, `shared seed on ${CUBE.name}`);
  assertFaceScoreRange(CUBE, posById, `shared seed on ${CUBE.name}`);
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
        graph.nodeIds,
        graph.edgePairs,
        ['1', '2', '3'],
        {
          maxIters: 500,
          tolerance: 1e-8,
          initOptions: TutteAlgorithm.defaultOuterPlacementOptions({
            useSeedOuter: false
          })
        }
      );
    }
  },
  {
    name: 'Tutte compute',
    graph: CUBE,
    run(graph) {
      return Tutte.computeTutteLayout(graph.nodeIds, graph.edgePairs);
    }
  },
  {
    name: 'Air compute',
    graph: CUBE,
    run(graph) {
      return Air.computeAirPositions(graph.nodeIds, graph.edgePairs, {
        delayMs: 0,
        yieldEvery: 50,
        maxSweeps: 40
      });
    }
  },
  {
    name: 'PPAG compute',
    graph: CUBE,
    run(graph) {
      return PPAG.computePPAGPositions(graph.nodeIds, graph.edgePairs, {
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
      return FaceBalancer.computeFaceBalancerPositions(graph.nodeIds, graph.edgePairs, {
        delayMs: 0,
        maxIters: 20
      });
    }
  },
  {
    name: 'CEG23-bfs compute',
    graph: CUBE,
    run(graph) {
      return CEG23.computeCEG23BfsPositions(graph.nodeIds, graph.edgePairs, {
        maxIters: 1200
      });
    }
  },
  {
    name: 'CEG23-xy compute',
    graph: CUBE,
    run(graph) {
      return CEG23XY.computeCEG23XyPositions(graph.nodeIds, graph.edgePairs, {
        maxIters: 1200
      });
    }
  },
  {
    name: 'ImPrEd compute',
    graph: CUBE,
    run(graph) {
      return ImPrEd.computeImPrEdPositions(graph.nodeIds, graph.edgePairs, {
        delayMs: 0,
        maxIters: 40
      });
    }
  },
  {
    name: 'ReweightTutte compute',
    graph: CUBE,
    run(graph) {
      return Reweight.computeReweightTuttePositions(graph.nodeIds, graph.edgePairs, {
        maxOuterIters: 6,
        warmIters: 300,
        innerIters: 300,
        finalIters: 400
      });
    }
  },
  {
    name: 'FD-uniform compute',
    graph: CUBE,
    run(graph) {
      return FDUniform.computeFDUniformPositions(graph.nodeIds, graph.edgePairs, {
        maxIters: 120
      });
    }
  },
  {
    name: 'FPP compute',
    graph: OCTAHEDRON,
    run(graph) {
      return FPP.computeFPPPositions(graph.nodeIds, graph.edgePairs);
    }
  },
  {
    name: 'Schnyder compute',
    graph: OCTAHEDRON,
    run(graph) {
      return Schnyder.computeSchnyderPositions(graph.nodeIds, graph.edgePairs);
    }
  },
  {
    name: 'P3T compute',
    graph: K4,
    run(graph) {
      return P3T.computeP3TPositions(graph.nodeIds, graph.edgePairs);
    }
  }
];

for (const spec of layoutSpecs) {
  test(`${spec.name} returns a finite non-crossing drawing on ${spec.graph.name}`, async () => {
    await assertComputeSpec(spec);
  });
}

test('normalized failure shape is preserved for exported compute functions', async () => {
  const nonPlanarK5 = {
    nodeIds: ['1', '2', '3', '4', '5'],
    edgePairs: [
      ['1', '2'], ['1', '3'], ['1', '4'], ['1', '5'],
      ['2', '3'], ['2', '4'], ['2', '5'],
      ['3', '4'], ['3', '5'],
      ['4', '5']
    ]
  };

  const failureCases = [
    {
      name: 'Tutte barycentric primitive',
      run: () => TutteAlgorithm.computeBarycentricPositions([], [], [])
    },
    {
      name: 'Tutte compute',
      run: () => Tutte.computeTutteLayout(['1', '2'], [['1', '2']])
    },
    {
      name: 'CEG23-bfs compute',
      run: () => CEG23.computeCEG23BfsPositions(['1', '2'], [['1', '2']])
    },
    {
      name: 'CEG23-xy compute',
      run: () => CEG23XY.computeCEG23XyPositions(['1', '2'], [['1', '2']])
    },
    {
      name: 'ReweightTutte compute',
      run: () => Reweight.computeReweightTuttePositions(['1', '2'], [['1', '2']])
    },
    {
      name: 'FD-uniform compute',
      run: () => FDUniform.computeFDUniformPositions(['1', '2'], [['1', '2']])
    },
    {
      name: 'FPP compute',
      run: () => FPP.computeFPPPositions(nonPlanarK5.nodeIds, nonPlanarK5.edgePairs)
    },
    {
      name: 'Schnyder compute',
      run: () => Schnyder.computeSchnyderPositions(nonPlanarK5.nodeIds, nonPlanarK5.edgePairs)
    },
    {
      name: 'P3T compute',
      run: () => P3T.computeP3TPositions(CUBE.nodeIds, CUBE.edgePairs)
    }
  ];

  for (const failureCase of failureCases) {
    const result = await failureCase.run();
    assertNormalizedFailureResult(result, failureCase.name);
  }
});
