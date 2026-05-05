# PlanarVibe Simplification Report
 
Scope: `static/js/` (browser code). Tests and scripts may be adjusted to match.
Explicitly excluded from deep restructuring per user request: `layout-gpt.js`,
`layout-claude.js`, `layout-edgebalancer.js`, `layout-facebalancer.js`,
`layout-anglebalancer.js`, `layout-fabalancer.js` (self-contained by design).
 
Each finding is stated as WHERE (file:line), WHAT, and SUGGESTED CHANGE, ordered
roughly by impact / ease-of-change ratio.
 
---
 
## 1. `planarvibe-plugin.js` — controller (3425 lines)
 
### 1.1 Dead branch in `sharedLayoutMethodOptions` (HIGH value, trivial change)
 
**WHERE:** `planarvibe-plugin.js:176–203`
 
**WHAT:** The 14-name `if (key === 'air' || … || key === 'claude')` block sets
`base = {}`, which is the same value `base` was just initialized to at line 180.
The long Object.assign merges `base` (always `{}`), a spurious second `{}`, the
outer-cycle flag, and overrides — so the entire name-list branch is dead.
 
```js
var base = {};
if (key === 'air' || key === 'cleanair' || … || key === 'claude') {
  base = {};      // no-op
}
var mergedOverrides = Object.assign({}, base, {}, …);   // base === {}
```
 
**SUGGESTED CHANGE:** Collapse to:
```js
function sharedLayoutMethodOptions(overrides) {
  return Object.assign(
    {},
    useOuterCycleAugmentation ? { augmentationMethod: 'outer-cycle' } : {},
    overrides || {}
  );
}
```
Also drop the `layoutName` parameter and the unused `ceg_bfs`/`ceg_xy`
normalization. All 14 call sites already pass the canonical layout name.
 
---
 
### 1.2 `temporaryStaticRun` callback duplicated 23 times
 
**WHERE:** `planarvibe-plugin.js:2013–2608` — every layout branch ends with:
```js
}, function () {
  if (temporaryStaticRun) {
    setInteractiveMode(false, false, true);
  }
});
```
The pattern appears at lines 2042, 2056, 2070, 2084, 2111, 2128, 2173, 2218,
2261, 2295, 2335, 2377, 2424, 2441, 2458, 2472, 2486, 2500, 2536, 2566, 2583,
2600 (23 occurrences, verified by grep).
 
**SUGGESTED CHANGE:** Extract once:
```js
function afterLayoutDone() {
  if (temporaryStaticRun) setInteractiveMode(false, false, true);
}
```
Pass `afterLayoutDone` to every `runManagedLayout` call. Saves ~65 LOC.
 
---
 
### 1.3 `applyLayout` dispatcher — 23 near-identical branches
 
**WHERE:** `planarvibe-plugin.js:2013–2608` (~595 lines)
 
**WHAT:** Every layout is a hand-written `if (layoutName === 'x') { runManagedLayout({…}, done); return; }` block. The only per-layout variations are the module global, the disabled message, and an optional `buildMethodOptions` that wires a progress formatter onto `onIteration`.
 
**SUGGESTED CHANGE:** Replace with a table. One entry per layout:
```js
var LAYOUTS = {
  random: { module: () => global.PlanarVibeRandom, disabledMessage: 'Random layout is currently unavailable' },
  tutte:  { module: () => global.PlanarVibeTutte,  disabledMessage: 'Tutte layout requires a planar graph' },
  air:    { module: () => global.PlanarVibeAir,    disabledMessage: 'Air layout requires a planar graph',
            formatProgress: airProgressFormatter },
  // …
};
```
Then `applyLayout` becomes a single ~20-line dispatcher that looks up the entry
and invokes `runManagedLayout`. Per-layout `onIteration` formatters can also be
extracted one-per-function — they are currently anonymous functions embedded
inside `buildMethodOptions` and duplicate the `progressDebug(progress)` + `parts
= []` + `setStatus(parts.join(' | '))` skeleton at least 10 times.
**Estimated saving: 400–500 LOC.**
 
---
 
### 1.4 Per-metric update functions are a 7-way copy-paste
 
**WHERE:** `planarvibe-plugin.js:1261–1350`
(`updateEdgeLengthRatio`, `updateSpacingUniformity`, `updateEdgeLengthDeviation`,
`updateEdgeOrthogonality`, `updateAspectRatio`, `updateNodeUniformity`,
`updateAxisAlignment`)
 
**WHAT:** Each function is structurally identical:
```js
if (!global.PlanarVibeMetrics || !…computeX) { $('#stats-x').text('--'); return; }
var r = …computeX(args);
if (!r || !r.ok || !Number.isFinite(r.score)) { $('#stats-x').text('--'); return; }
$('#stats-x').text(r.score.toFixed(3));
```
(Note: `computeEdgeLengthRatio` returns `.ratio`; all others return `.score`.)
 
**SUGGESTED CHANGE:** A config array + a single `updateScalarMetric` helper,
described in a 20-line block. Together with §3.3 below (the metrics-module
existence check is already dead), this collapses to ~35 LOC. **Saving: ~55 LOC.**
 
---
 
### 1.5 Two plot renderers are 90 % identical
 
**WHERE:** `planarvibe-plugin.js:919–991` (`renderFaceAreaPlot`) vs.
`993–1043` (`renderAngleResolutionPlot`). Both build the same axis frame, the
same ticks, the same "ideal" reference line, the same labels; they differ only
in Y-range (5 vs 1), Y label text, X label text, and whether to show the
polyline.
 
**SUGGESTED CHANGE:** Extract a single `renderLinePlot(plotId, {values, maxY,
yLabel, xLabel, showLine, normalizeBy})` and call it from both. Also the unused
local variables `R` and `B` at lines 942/944 and 998/1000 can be dropped (both
are computed padding but never read). **Saving: ~50 LOC.**
 
---
 
### 1.6 Redundant `validateRequirements` machinery
 
**WHERE:** `planarvibe-plugin.js:2610–3015` (~405 lines)
(`firstMissingFunction` → `missingUtilitiesByGroup` → `validateRequiredDependencies`
→ `validateRequirements` → `syncUnavailableLayoutButtons` →
`unavailableLayoutMessages`)
 
**WHAT:** The script-tag load order in `index.html:308–336` is fixed; every
`PlanarVibeX` module is always loaded (or it would `ReferenceError` when
another module reads it at import time). There is no plugin system, no dynamic
loading, no "missing dependency" failure mode in practice. The 12-entry `groups`
map, the 23-entry `layoutChecks` table, and `unavailableLayoutMessages` cache
exist only to produce a friendlier error message if something *were* missing.
 
**SUGGESTED CHANGE:** Delete the entire block (lines 2610–3015) and the
supporting `unavailableLayoutMessages` state (line 269) and
`syncUnavailableLayoutButtons` (lines 1797–1809). Disable the
`!isPlanar`/`!isPlanar3Tree` buttons from `updateStatistics`
(lines 1872–1887) directly — that is the only dynamic-disable that matters.
**Saving: ~420 LOC**, at the cost of one extra line in `index.html` comments
noting the load order.
 
---
 
### 1.7 Cookie fallback is unreachable
 
**WHERE:** `planarvibe-plugin.js:205–242` (`writeCookie`, `readCookie`,
`readStorage`, `writeStorage`)
 
**WHAT:** Every modern browser supports `localStorage`. The `try { localStorage…
} catch` is there to handle private-browsing quota errors, and those errors
are rare — but the cookie fallback is both rare AND meaningless, because
any preference that fails to read from `localStorage` will *also* be set via
`document.cookie` only to be read back on next visit… again through the
localStorage-preferred `readStorage`. So the cookie value is essentially
write-only.
 
**SUGGESTED CHANGE:** Delete `writeCookie`/`readCookie` and reduce
`readStorage`/`writeStorage` to direct `localStorage` access wrapped in
`try`/`catch` returning `null` on failure. Remove the unused
`GRAPH_STYLE_COOKIE_DAYS` constant. **Saving: ~35 LOC.**
 
---
 
### 1.8 `numericMetricValue` is unnecessary dispatch
 
**WHERE:** `planarvibe-plugin.js:1085–1096`, called 10× at lines 1140–1149.
 
**WHAT:** Three branches on a `key` string, each looking at a different field
(`ratio`, `quality`, `score`). The caller (`updateOverallScore`) already knows
which metric it is calling and which field it wants.
 
**SUGGESTED CHANGE:** Inline the extraction at each of the 10 call sites, or
teach `computeEdgeLengthRatio` / `computeUniformFaceAreaScore` to also expose a
uniform `.score` field (they already return `.ratio`/`.quality` respectively;
just add a matching `score` alias in the metric). **Saving: ~15 LOC.**
 
---
 
### 1.9 `layoutBusyState` snapshot is over-engineered
 
**WHERE:** `planarvibe-plugin.js:3093–3116` (`enterLayoutBusy`,
`restoreLayoutBusy`)
 
**WHAT:** The entry path snapshots every button's `.prop('disabled')` so it can
be restored later. But nothing changes button disability during a layout run
except `restoreLayoutBusy` itself; the "source of truth" is the combination of
(a) current planarity of the graph, which doesn't change during the run, and
(b) `unavailableLayoutMessages`, which also does not change.
 
**SUGGESTED CHANGE:** After §1.6, disability is purely a function of current
graph properties. Replace the snapshot with a simple `re-run updateStatistics
disability logic` on restore. **Saving: ~15 LOC.**
 
---
 
### 1.10 Dead planarity-only paths
 
**WHERE:** `planarvibe-plugin.js:95`, `1848`, `1857`, `1862` — checks like
`if (!global.PlanarGraphUtils … )` and
`if (!global.PlanarVibePlanarityTest.computePlanarEmbedding)`. The scripts are
loaded unconditionally in `index.html`.
 
**SUGGESTED CHANGE:** Remove these guards (same rationale as §1.6).
 
---
 
### 1.11 Redundant `cy` double-checks
 
**WHERE:** `planarvibe-plugin.js:2013–2025` — `applyLayout` first checks
`if (!cy)` and either recurses with `temporaryStaticRun:true` (after which `cy`
is guaranteed non-null) or falls through. Inside each layout branch we then
reference `cy` safely. But `setInteractiveMode(true, false, true)` at line 2021
itself re-asserts `cy`, and every `runManagedLayout` inside uses the closure's
`cy`. No change needed per-se — the structure is fine — but the recursive
`applyLayout(layoutName, { temporaryStaticRun: true })` could simply be
"setInteractiveMode(true); then fall through" without the recursion, saving a
subtle double-dispatch.
 
**SUGGESTED CHANGE:** Replace the recursive call with an early-phase flag and a
single dispatch, so `temporaryStaticRun` and `setInteractiveMode` are not
entangled with the dispatcher.
 
---
 
## 2. `graph-utils.js`
 
### 2.1 Synonym fields in `buildLayoutResult`
 
**WHERE:** `graph-utils.js:182–222`
 
**WHAT:** `buildLayoutResult` emits both `positions` and `posById`, both `iters`
and `iterations`, and both `status` and `stopReason`. grep shows:
- `posById: …` and `positions: …` are both set in the exported object — all
  layouts construct their result via this helper, so both fields are always
  populated identically.
- In actual callers, layouts set `stopReason` (see `layout-anglebalancer.js`,
  `layout-forcedir.js`, `layout-reweight.js`, `layout-facebalancer.js`), but
  `status` as an alias is never read.
- `.iterations` is not read anywhere outside `buildLayoutResult` itself. All
  callers read `.iters`.
 
**SUGGESTED CHANGE:** Keep `posById`, `iters`, and `stopReason`. Drop the
`positions`, `iterations`, and `status` aliases (both from the result object
and from the input fallback-chains). **Saving: ~20 LOC** and one class of
bugs ("did I set positions or posById?").
 
---
 
### 2.2 `faceKey` reverse-rotation is over-kill
 
**WHERE:** `graph-utils.js:58–74`
 
**WHAT:** Canonicalizes an unordered face by trying all rotations of the face
*and* of the reversed face (O(n²) building-string work). For face-equality in
an undirected planar embedding this is correct but wasteful; many callers use
`faceKey` only for keying a set. Only in a handful of places are the two
orientations actually distinct.
 
**SUGGESTED CHANGE:** Worth auditing all `faceKey` call sites (13 across the
code-base per my search). Where orientation doesn't matter, reverse rotations
are needed; where it does, they are harmful. If the answer is "never
orientation-sensitive", keep as-is — it's cheap for the small faces in
practice. Defer if no hot-spot shows up.
 
---
 
### 2.3 `buildLayoutStatusMessage` hard-codes 11 fields
 
**WHERE:** `graph-utils.js:224–279`
 
**WHAT:** The helper knows about `outerFaceVertexCount`, `boundedFaceCount`,
`vertexCount`, `dummyCount`, `iters`, `outerSteps`, `accepted`, `rejected`,
`status`, `stopReason`, `maxRelError`, `faceAreaScore`, `faceAreaMinRatio`,
`faceAreaMaxRatio`, and `extraParts`. Callers always populate a subset.
 
**SUGGESTED CHANGE:** Replace with a generic `buildLayoutStatusMessage(name,
parts)` where each layout builds its own `parts` array. This moves the
per-layout formatter (several of which already exist as ad-hoc code in
planarvibe-plugin.js §1.3) into one place per layout module. Minor saving
(~20 LOC) but much clearer contract.
 
---
 
### 2.4 Unused internal helpers exported? — correction
 
A subagent flagged `hashString`, `resolveIntOption`, `resolveNonNegativeOption`
as exported-but-unused. **They are NOT exported** (I verified
`graph-utils.js:321–336`). Ignore that claim. `resolveFunctionOption` IS
exported and is used externally — keep it.
 
---
 
## 3. `geometry-utils.js`
 
### 3.1 `normalizePositionMapToViewport` options are always defaulted
 
**WHERE:** `geometry-utils.js:219–279`
 
**WHAT:** Accepts `{width, height, padding}`. Only one caller exists
(`planarvibe-plugin.js:1913`) and it passes no options.
 
**SUGGESTED CHANGE:** Drop the `options` parameter entirely. Inline the
viewport defaults (`PlanarVibeViewportDefaults` + padding=24). **Saving:
~15 LOC.**
 
---
 
### 3.2 `hasPositionCrossings` is O(E² + N·E)
 
**WHERE:** `geometry-utils.js:322–380`
 
Not a simplification per se, but worth noting: the point-on-edge pass
(lines 354–377) iterates every node × every edge, and is called every time
metrics update. For large graphs this dominates. No change suggested here —
just flagging.
 
---
 
## 4. `metrics.js`
 
### 4.1 `computeQuantile` and `collectPositiveGaps` duplicated
 
**WHERE:** `metrics.js:102–131` vs. `alignment.js:18–47`
 
**WHAT:** Identical implementations (verified byte-for-byte on the helpers'
signatures; callers are local-only in each file).
 
**SUGGESTED CHANGE:** Promote both helpers into `GeometryUtils` or a new
`math-utils.js` module, or simply into `alignment.js` if `metrics.js`'s
consumers are the only ones left. **Saving: ~30 LOC.**
 
---
 
### 4.2 `buildWeightedDistributionResult` returns redundant fields
 
**WHERE:** `metrics.js:93–99`
 
Returns `{ ok, values, ideal, idealValues, quality }`. `ideal` is the scalar
`1/n` (the uniform value) while `idealValues` is the array of per-item
uniform weights; `ideal` is read by exactly one UI caller
(`planarvibe-plugin.js:1221` — as a fallback when `idealValues` is absent, which
never happens for "ok" results). Drop `ideal` from the "ok" path.
 
---
 
### 4.3 `isBipartiteGraph` self-loop pre-check
 
**WHERE:** `metrics.js:849–855`
 
The loop `if (u === v) return false` is redundant — `GraphUtils.Graph` already
rejects self-loops at construction (`graph-utils.js:117–119`). The BFS alone is
correct. **Saving: ~6 LOC.**
 
---
 
## 5. `linear-algebra.js`
 
### 5.1 `cloneMatrix` exported but only used internally
 
**WHERE:** `linear-algebra.js:6, 140`
 
Only internal caller is `luFactorize` at line 16. No external callers across
the entire repo (verified).
 
**SUGGESTED CHANGE:** Remove from the export map. **Saving: 1 line + clarity.**
 
---
 
## 6. `alignment.js`
 
### 6.1 `copyPositions` duplicates `GeometryUtils.copyPositionMap`
 
**WHERE:** `alignment.js:7–15` (uses at lines 356, 398, 423)
 
Identical to `GeometryUtils.copyPositionMap`.
 
**SUGGESTED CHANGE:** Delete `copyPositions`, call `GeometryUtils.copyPositionMap`.
 
---
 
### 6.2 Defensive GeometryUtils/Metrics checks
 
**WHERE:** `alignment.js:332–336, 358`
 
Same argument as §1.6: load order in `index.html` guarantees these modules.
Drop the guards.
 
---
 
## 7. `planar-graph-utils.js`
 
### 7.1 Load-order assertion at top of module
 
**WHERE:** `planar-graph-utils.js:8–10`
 
```js
if (!GeometryUtils) {
  throw new Error('GeometryUtils must be loaded before PlanarGraphUtils');
}
```
 
`index.html:309` loads `geometry-utils.js` before `planar-graph-utils.js`. The
throw is unreachable in the deployed app.
 
**SUGGESTED CHANGE:** Remove. If you want a check, keep it as an `assert` in
dev mode only; or move the check to a single startup assertion in
`planarvibe-plugin.js`.
 
---
 
## 8. Layout modules (narrow scope per user request)
 
### 8.1 `emitSingleIteration` duplicated 6 times
 
**WHERE:**
- `layout-random.js:9`
- `layout-cytoscape.js:121`
- `layout-tutte.js:20`
- `layout-p3t.js:10`
- `layout-fpp.js:18`
- `layout-schnyder.js:19`
 
All 6 copies are the same: check that `options.onIteration` is a function and
synthesize a `{iter:1, maxIters:1, …}` event.
 
**SUGGESTED CHANGE:** Add `LayoutPreprocessing.emitSingleIteration(options,
result)` (or put it on `GraphUtils`) and delete the six copies.
**Saving: ~50 LOC**, better consistency.
 
---
 
### 8.2 Dead `augmentationOptions` plumbing
 
**WHERE:** `layout-air.js:316–317, 583`,
`layout-areagrad.js:251–252, 445`,
`layout-preprocessing.js:58–141`
 
`augmentationOptions` is accepted by Air and AreaGrad and passed through to
`LayoutPreprocessing.augmentGraph`. No caller sets it — `planarvibe-plugin.js`
only sets `augmentationMethod`. `layout-fpp.js:14–16` and
`layout-schnyder.js:15–17` define `FPP_PREPARE_OPTIONS` /
`SCHNYDER_PREPARE_OPTIONS` with `triangulateOuterFace: true`, passed only by
themselves.
 
**SUGGESTED CHANGE:** Either fold `{triangulateOuterFace: true}` into the FPP /
Schnyder preprocessing default (since those are the only two real consumers),
or remove the whole `augmentationOptions` parameter from Air/AreaGrad and from
`augmentGraph`'s signature. **Saving: ~25 LOC.**
 
---
 
### 8.3 `layout-tutte.js` `fixedOuterPos` never supplied
 
**WHERE:** `layout-tutte.js:105–111`
 
`placeOuterFaceVertices` checks `opts.fixedOuterPos`. Only `layout-reweight.js`
and `layout-ceg.js` populate `fixedOuterPos` — both reach
`placeOuterFaceVertices` through other paths (not via Tutte's caller).
 
**SUGGESTED CHANGE:** Since CEG and Reweight both call `placeOuterFaceVertices`
via `global.PlanarVibeTutte`, `fixedOuterPos` is actually reachable through
them. Re-verify with a grep; if reweight/ceg depend on it, keep. If not,
remove the branch. (My grep shows reweight/ceg DO use it — keep.)
 
---
 
### 8.4 `buildTutteOuterPositions` export
 
**WHERE:** `layout-tutte.js:278–330`
 
Exported at line 330. grep shows **zero external callers** (only internal use
at line 295).
 
**SUGGESTED CHANGE:** Remove from exports.
 
---
 
### 8.5 `layout-cleanair.js` inconsistent `onIteration: null`
 
**WHERE:** `layout-cleanair.js:925, 931`
 
Explicitly forces `onIteration: null` instead of letting the iterator no-op.
Cosmetic; harmonize with the pattern used elsewhere.
 
---
 
### 8.6 `layout-random.js`, `layout-cytoscape.js`, `layout-p3t.js` — minimal use of `buildLayoutStatusMessage`
 
**WHERE:** `layout-random.js:80`, `layout-cytoscape.js:147–149`,
`layout-p3t.js:140–142`
 
Each calls `buildLayoutStatusMessage` with 1–2 fields. Since the helper's
value is in combining many fields, direct-string returns would be clearer for
single-shot layouts.
 
**SUGGESTED CHANGE:** Use plain template literals for these three. Minor
(~6 LOC).
 
---
 
## 9. Summary of estimated impact
 
| Area | Change | Est. LOC saved |
|---|---|---|
| 1.1 `sharedLayoutMethodOptions` dead branch | trivial | ~20 |
| 1.2 `temporaryStaticRun` callback dedup | mechanical | ~65 |
| 1.3 `applyLayout` → dispatch table | medium | ~450 |
| 1.4 metric-update 7-way dedup | mechanical | ~55 |
| 1.5 plot renderer dedup | medium | ~50 |
| 1.6 delete `validateRequirements` machinery | mechanical | ~420 |
| 1.7 remove cookie fallback | trivial | ~35 |
| 1.8 inline `numericMetricValue` | trivial | ~15 |
| 1.9 simplify `layoutBusyState` | small | ~15 |
| 1.10 delete planarity-guard checks | trivial | ~10 |
| 2.1 drop positions/iterations/status aliases | small | ~20 |
| 2.3 generic `buildLayoutStatusMessage` | small | ~20 |
| 3.1 `normalizePositionMapToViewport` options | trivial | ~15 |
| 4.1 dedup quantile/gaps helpers | trivial | ~30 |
| 4.3 drop self-loop pre-check | trivial | ~6 |
| 5.1 drop `cloneMatrix` export | trivial | ~1 |
| 6.1 drop `copyPositions` | trivial | ~10 |
| 6.2 drop defensive checks | trivial | ~10 |
| 7.1 drop planar-graph-utils load assert | trivial | ~3 |
| 8.1 dedup `emitSingleIteration` | mechanical | ~50 |
| 8.2 dead `augmentationOptions` plumbing | small | ~25 |
| 8.4 drop `buildTutteOuterPositions` export | trivial | ~1 |
| **Total** | | **~1300 LOC** (~5.5 %) |
 
## 10. Suggested sequencing
 
Apply in this order to keep each step small and reviewable. Most are
independent; where there's a dependency, it's noted.
 
1. **Trivial deletions** (1.1, 1.7, 1.10, 3.1, 4.3, 5.1, 6.1, 6.2, 7.1,
   8.4). Each is a 5–40 line local change. ~100 LOC.
2. **Alias cleanup in `graph-utils.js`** (2.1). Touches many layout modules
   but each change is mechanical. ~20 LOC + cross-module renames.
3. **Dedup helpers** (1.2, 4.1, 8.1). Extract once, delete duplicates. ~145 LOC.
4. **`validateRequirements` deletion** (1.6). Do this before §1.3 so the
   `unavailableLayoutMessages` logic is out of the way. ~420 LOC.
5. **Metric-update table** (1.4). Small, self-contained. ~55 LOC.
6. **Plot renderer dedup** (1.5). Self-contained. ~50 LOC.
7. **Layout dispatch table** (1.3). The biggest change; best done last so
   prior cleanups have trimmed the per-layout wiring (§1.2 and §1.6 in
   particular). ~450 LOC.
 
Notes:
- **Excluded modules** (GPT, Claude, the four Balancers) participate only in
  §1.2 (callback), §1.3 (dispatcher entry), §1.6 (unavailable-message cache),
  §2.1 (aliases). None of those touch their internals.
- **Tests** will need updates where they read the removed export
  `LinearAlgebraUtils.cloneMatrix` (none, per grep) or call
  `PlanarVibeTutte.buildTutteOuterPositions` (none, per grep). Most changes
  are caller-invisible.
- **Scripts** (`scripts/*.mjs`) read layout results via the shared helpers;
  confirm they don't rely on `.positions` vs `.posById` before applying §2.1.
