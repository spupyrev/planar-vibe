# Layout Algorithm Review

Scope: `static/js/layout-*.js`

Goal: identify large refactors and cleanup opportunities that preserve current benchmark quality while reducing code, option surface, and duplicated logic.

## Cross-Cutting Priorities

- Extract a shared triangulated-augmentation data builder. `Air`, `PPAG`, and the optimization family all rebuild triangle incidence, bounded-face lists, outer-face exclusion, and initial area statistics in slightly different ways.
- Normalize the result contract. Some augmented layouts return augmented coordinates in `result.positions` (`Air`, `PPAG`, `ReweightTutte`), while others expose only original-node positions there and keep augmented positions separate (`Tutte`, `CEG23`, `AngleBalancer`, `FaceBalancer`, `EdgeBalancer`, `Hybrid`). Pick one convention.
- Standardize option handling. Several files honor caller options via `resolve*Option`, but `Air` and `AngleBalancer` overwrite important knobs with hardcoded values.

## Tutte

- `isOuterDummyVertexId` relies on a string prefix convention (`static/js/layout-tutte.js:46-48`). Push dummy-vertex type metadata into preprocessing instead of parsing ids in the solver.

## Air

- `fillAirSettings` overwrites most tuning knobs instead of defaulting them (`static/js/layout-air.js:294-320`). Today many options are effectively dead. Either honor caller-supplied values or make AIR explicitly fixed-parameter and remove the unused option surface.
- `buildAirData` duplicates triangulated-face bookkeeping that also exists in `PPAG` and the optimizer family (`static/js/layout-air.js:27-127`). Extract a shared `buildTriangulatedFaceData`.
- AIR returns augmented coordinates in `result.positions` (`static/js/layout-air.js:611-666`). That differs from several other augmented layouts and makes downstream consumers inconsistent.

## PPAG

- `preparePPAGState` does not carry `baseEmbedding`, but `computePPAGPositions` passes `prepared.baseEmbedding` into the face-area metric (`static/js/layout-ppag.js:263-321`, `static/js/layout-ppag.js:494`). This is a real bug: the metric can fail spuriously because the embedding is missing.
- Progress debug emits `state.gradNorm`, but `computePPAGState` never computes that field (`static/js/layout-ppag.js:169-183`, `static/js/layout-ppag.js:416`). Drop the field or compute it.
- Like AIR, PPAG rebuilds triangulated-face incidence from scratch and returns augmented positions in `result.positions` (`static/js/layout-ppag.js:31-81`, `static/js/layout-ppag.js:449-499`). Unify both.

## EdgeBalancer

- `buildInitialLogitSeed(data, weights, opts)` has an unused `opts` parameter (`static/js/layout-edgebalancer.js:223`). Remove it.
- Objective weights are mostly hardcoded inside `buildEdgeBalancerData` (`static/js/layout-edgebalancer.js:54-220`). Promote them to explicit constants and stop pretending they are tunable.

## AngleBalancer

- `fillAngleSettings` overwrites `options.maxIters` unconditionally (`static/js/layout-anglebalancer.js:45-53`). That makes the public knob dead and benchmark sweeps misleading.
- The hardcoded constant block is large and file-local (`static/js/layout-anglebalancer.js:27-43`). If those values are intentional, centralize them with the other balancers so comparisons stay honest.

## Hybrid

- `copyPositionMap` duplicates `GeometryUtils.copyPositionMap` (`static/js/layout-fabalancer.js:459-469`).

## CEG23-bfs

- `solveAugmentedWeightedLayout` takes `maxIters` but ignores it (`static/js/layout-ceg23.js:523`). This is dead API and misleading because the solve is exact, not iterative.
- The current degeneracy handling rotates the whole drawing through a hardcoded list of tiny angles (`static/js/layout-ceg23.js:148-165`). Replace that with deterministic tie-breaking in the ordering/orientation logic instead of repeated micro-rotation probes.

## CEG23-xy

- Same dead `maxIters` parameter problem as `CEG23-bfs` (`static/js/layout-ceg23.js:523`).
- `rotateForSpread` is again a brute-force workaround (`static/js/layout-ceg23.js:148-165`); prefer stable sorting/tie-breaking over geometric nudging.

## ImPrEd

- The main inefficiency is algorithmic: `computeNodeForces` is all-pairs, and `computeMovementLimits` scans every edge for every vertex on every iteration (`static/js/layout-impred.js:150-252`, `static/js/layout-impred.js:253-289`). If benchmark graphs grow, this is the first place where a spatial index or edge bucketing would pay off.
- Crossing checks are incorrectly gated on `Metrics` being loaded (`static/js/layout-impred.js:530-552`). Crossing validation should be unconditional.

## ReweightTutte

- `barycentricLayoutWeighted(..., maxIters, ...)` ignores `maxIters` (`static/js/layout-reweight.js:28`).
- `adjustWeights` takes an unused `faces` parameter (`static/js/layout-reweight.js:85`).
- Like AIR/PPAG, the final result returns augmented positions in `result.positions` (`static/js/layout-reweight.js:328-439`). Normalize it to the same contract used by the cleaner augmented layouts.

## FD-uniform

- The dominant cost is repeated global scanning: nearest-neighbor computation is O(n^2), and each candidate move checks crossings against essentially all edges (`static/js/layout-fd-uniform.js:23-57`, `static/js/layout-fd-uniform.js:72-129`, `static/js/layout-fd-uniform.js:151-281`). That is fine for small benchmarks, but it is the obvious scalability wall.

## FPP

- `undirectedKey` reimplements `GraphUtils.edgeKey` locally (`static/js/layout-fpp.js:185-187`).

## Schnyder

- `candidateOuterTriples` only tries the first embedding edge and its mirror (`static/js/layout-schnyder.js:453-462`). That is a brittle heuristic. Prefer iterating actual outer-face triples or at least all outer-face orientations before falling back to overlap repair.
- `contract` uses `candidates.shift()` as a queue (`static/js/layout-schnyder.js:91`), which is avoidable O(n^2) work. Use a head index.
