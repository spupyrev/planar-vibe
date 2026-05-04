# GPT Layout Development Log

## Stage 1: Metric-Scored Public Candidate Selector

Goal: build a deterministic, robust baseline that does not modify existing algorithms. The layout will run a small portfolio of exported public layout compute methods, evaluate each valid plane drawing with the same ten metrics used by the benchmark, and apply the highest-scoring candidate.

Initial plan:
- Start with EdgeBalancer and FABalancer, because they are the strongest current baselines and optimize complementary metrics.
- Score candidates by the raw mean of the ten metric values for the current graph, with non-plane or incomplete drawings rejected.
- Keep timing conservative for unseen graphs by running only a small portfolio at first.
- Use train data only for sanity checks, not graph-specific memorization.

Pre-implementation estimate from existing train CSV: selecting between EdgeBalancer and FABalancer by per-graph mean metric score would score about `0.632994` on `planar_train.dot`, compared with EdgeBalancer `0.622226` and FABalancer `0.596484`.

Result: implemented `layout-gpt.js` as a public-candidate selector with rotation scoring. Full train command completed with 499/499 ok and total score `0.652673`.

Metric p50s:
- angular `0.541964`
- aspect `0.959148`
- convexity `0.250000`
- edge deviation `0.842777`
- edge ratio `0.392421`
- orthogonality `0.541365`
- face `0.923621`
- node uniformity `0.695652`
- alignment `0.641204`
- spacing `0.738579`

Candidate choices: EdgeBalancer 422, FABalancer 67, Tutte 10. The rotation sweep was a clear win over the initial estimate, mainly improving orientation-sensitive metrics while preserving planarity.

## Stage 2: Add Angular Candidate

Goal: test whether AngleBalancer adds useful candidates without making the default portfolio too slow. Existing broader benchmark data suggests a small gain when selecting among EdgeBalancer, FABalancer, and AngleBalancer, so prototype it behind the same node-count guard as FABalancer and keep it only if the full train score improves.

Result: discarded. Full train score was `0.652234` with 499/499 ok, below Stage 1's `0.652673`. Candidate choices were EdgeBalancer 395, FABalancer 48, AngleBalancer 49, Tutte 7. It improved angular resolution, aspect ratio, face, and alignment p50s, but the loss in edge-length metrics, node uniformity, and spacing outweighed those gains.

## Stage 3: Rotation Resolution

Goal: test whether a denser rotation sweep improves orientation-sensitive metrics. This is low algorithmic risk because rotation preserves planarity and all distance/area/angle ratios except viewport-axis metrics.

Result: kept. Changed rotation samples from 24 to 48 and skipped repeated crossing checks for rotated copies after validating the source candidate. Full train score improved to `0.655581` with 499/499 ok. Candidate choices: EdgeBalancer 423, FABalancer 65, Tutte 11.

Metric movement versus Stage 1:
- improved angular `0.541964 -> 0.545510`
- aspect slightly down `0.959148 -> 0.956947`
- convexity unchanged `0.250000`
- edge deviation slightly up `0.842777 -> 0.842881`
- edge ratio up `0.392421 -> 0.393243`
- orthogonality nearly unchanged `0.541365 -> 0.541264`
- face nearly unchanged `0.923621 -> 0.923618`
- node uniformity up `0.695652 -> 0.705882`
- alignment up `0.641204 -> 0.657457`
- spacing up `0.738579 -> 0.739010`

## Stage 4: Add Reweight Candidate

Goal: test whether Reweight adds useful face/spacing alternatives at acceptable cost. Existing broader benchmark data suggests a small selector gain when Reweight is available with EdgeBalancer and FABalancer, but this must be checked on the actual p50 objective.

Result: discarded. Full train score was `0.654451`, below Stage 3's `0.655581`. Reweight improved angular, face, alignment, and spacing p50s slightly, but lowered edge deviation and edge ratio enough to lose overall.

## Stage 5: Affine Transform Sweep

Goal: extend the rotation-only post-processing into a mild affine sweep. Any invertible affine transform preserves straight-line planarity, face-area ratios, and convexity, while changing aspect ratio, edge-length distribution, orthogonality, alignment, node uniformity, and spacing. Prototype determinant-one stretches around each candidate and keep the transform with the best ten-metric mean.

Result: kept. Full train score improved to `0.656319` with 499/499 ok. Candidate choices: EdgeBalancer 422, FABalancer 66, Tutte 11. Runtime stayed below the per-graph timeout on train (`p50 1335ms`, `p90 3268ms`, `p99 7815ms`, max `13758ms`). The affine sweep improved aspect ratio, orthogonality, node uniformity, alignment, and spacing, but reduced angular resolution and edge-length metrics.

Metric movement versus Stage 3:
- angular down `0.545510 -> 0.541660`
- aspect up `0.956947 -> 0.969844`
- convexity unchanged `0.250000`
- edge deviation down `0.842881 -> 0.836301`
- edge ratio down `0.393243 -> 0.380609`
- orthogonality up `0.541264 -> 0.554926`
- face unchanged `0.923618 -> 0.923621`
- node uniformity up `0.705882 -> 0.707317`
- alignment up `0.657457 -> 0.659690`
- spacing up `0.739010 -> 0.739223`

## Stage 6: Edge-Aware Affine Selection

Goal: keep the affine sweep, but bias candidate-transform scoring slightly toward edge-length deviation and edge ratio to avoid over-selecting stretched drawings that improve axis-dependent metrics at too much edge cost.

Result: discarded. Full train score fell to `0.651191` with 499/499 ok. Edge deviation and edge ratio improved relative to Stage 5, but angular resolution, convexity, face, and spacing dropped enough to make it clearly worse. Reverted to raw ten-metric mean scoring.

## Stage 7: Milder Affine Stretch Grid

Goal: keep the affine sweep, but reduce the maximum stretch from `1.32` to `1.20` with smaller intermediate steps. This should preserve some aspect/alignment/orthogonality gains while reducing the edge-length penalty observed in Stage 5.

Result: kept. Changed stretch factors to `[1, 1.04, 1.10, 1.20]`. Full train score improved to `0.657389` with 499/499 ok. Candidate choices: EdgeBalancer 426, FABalancer 62, Tutte 11. Runtime remained below timeout on train (`p50 1651ms`, `p90 3858ms`, `p99 9986ms`, max `17674ms`).

Metric movement versus Stage 5:
- angular down `0.541660 -> 0.540030`
- aspect up `0.969844 -> 0.975806`
- convexity unchanged `0.250000`
- edge deviation up `0.836301 -> 0.838991`
- edge ratio up `0.380609 -> 0.385764`
- orthogonality down `0.554926 -> 0.553419`
- face down `0.923621 -> 0.922569`
- node uniformity unchanged `0.707317`
- alignment up `0.659690 -> 0.661042`
- spacing down `0.739223 -> 0.738955`

## Stage 8: Finer Mild Affine Grid

Goal: test whether adding one extra mild stretch sample around the Stage 7 range improves per-graph transform selection without overfitting toward harsh stretching. Candidate grid: `[1, 1.03, 1.06, 1.10, 1.16, 1.22]`.

Result: discarded. Full train score was `0.657346`, slightly below Stage 7's `0.657389`, with 499/499 ok. The finer grid improved aspect ratio, orthogonality, and alignment but lost enough edge ratio, node uniformity, and spacing to fall behind. Reverted to the cheaper Stage 7 grid.

## Stage 9: Add FaceBalancer Candidate

Goal: test whether FaceBalancer provides useful extra candidates once the affine sweep is active. Earlier aggregate evidence was mixed, but FaceBalancer is comparatively cheap and may improve face/shape cases not covered by EdgeBalancer and FABalancer.

Result: discarded. Full train score was `0.657351`, slightly below Stage 7's `0.657389`, with 499/499 ok. FaceBalancer was selected 33 times and improved angular resolution, aspect ratio, orthogonality, face, and spacing p50s, but it lowered edge-length deviation, edge ratio, and alignment enough to lose overall. It also raised runtime (`p50 2012ms`, `p90 4809ms`, `p99 13462ms`), so the extra candidate was removed.

## Stage 10: Add Guarded Air Candidate

Goal: test whether Air adds useful face-area and spacing alternatives without disrupting the stronger edge-focused candidates. Existing cross-benchmark data suggests Air can win some selector cases, but it is weaker as a standalone layout, so prototype it as a last candidate behind a conservative node-count guard.

Result: kept. Full train score improved to `0.657499` with 499/499 ok, slightly above Stage 7's `0.657389`. Air was selected 29 times. The gain came from angular resolution, face uniformity, and spacing, while edge-length metrics and alignment slipped slightly. Runtime remained below timeout but increased (`p50 1714ms`, `p90 3827ms`, `p99 11509ms`, max `19194ms`), so the next stage should test a tighter Air guard.

## Stage 11: Tighten Air Guard

Goal: keep Air's small-case diversity while reducing risk on unseen larger graphs. In Stage 10, the slowest Air-selected train cases were around 90 nodes and had very poor edge-length ratios, so test lowering `airMaxNodes` from `120` to `80`.

Result: kept as a safer variant, but not the best scoring variant. Full train score was `0.657448` with 499/499 ok, below Stage 10's `0.657499` but still above Stage 7. Air selections dropped from 29 to 26. Runtime tail improved (`p99 8226ms` versus Stage 10's `11509ms`), though the max remained about `19250ms`. A CSV simulation suggested a better compromise: keep Air through the useful 90-node train range but reject Air results with extremely poor edge-length ratio.

## Stage 12: Air Edge-Ratio Floor

Goal: improve Air's candidate quality rather than only lowering its node guard. Prototype `airMaxNodes: 96` plus an Air-only final edge-ratio floor of `0.01`, so the selector can still use useful Air drawings around 90 nodes while rejecting the most degenerate Air wins.

Result: kept. Full train score improved to `0.657575` with 499/499 ok, the best so far. Air was selected 26 times, with `airMaxNodes: 96`; three degenerate Air candidates from Stage 10 were rejected by the `0.01` edge-ratio floor. Runtime stayed below timeout (`p50 1715ms`, `p90 3991ms`, `p99 10738ms`, max `16821ms`). Compared with Stage 7, the main gains were angular resolution, face uniformity, and spacing; edge-length metrics and alignment dropped slightly.

## Stage 13: Add Guarded ForceDir Candidate

Goal: test whether ForceDir adds useful small-graph alternatives. Broader benchmark data shows occasional selector wins, but ForceDir has a higher timeout risk, so prototype it only as a final candidate with `forceDirMaxNodes: 50` and a final edge-ratio floor.

Result: discarded. Full train score fell to `0.657098` with 499/499 ok. ForceDir was selected 20 times and improved angular resolution, orthogonality, face, alignment, and spacing, but it lowered edge-length deviation and edge ratio substantially. Runtime also worsened (`p50 2373ms`, `p90 6344ms`, `p99 13634ms`). Removed ForceDir and reverted to Stage 12.

## Stage 14: Denser Rotation Sweep

Goal: test whether increasing the post-processing rotation sweep from 48 to 64 samples improves orientation-sensitive metrics enough to offset the extra runtime. This is a low-risk geometric change because rotations preserve planarity, lengths, areas, and angles except for axis-dependent scores.

Result: kept. Full train score improved to `0.658235` with 499/499 ok, above Stage 12's `0.657575`. Candidate choices were EdgeBalancer 412, FABalancer 57, Air 24, Tutte 6. The main gain was alignment (`0.659690 -> 0.667075`), with smaller gains in aspect ratio, edge-length deviation, face, and spacing. Angular resolution and edge ratio dropped. Runtime increased but stayed under timeout (`p50 1990ms`, `p90 5277ms`, `p99 15271ms`, max `26063ms`).

## Stage 15: Intermediate 72-Sample Rotation Sweep

Goal: test whether a smaller increase beyond Stage 14 gives additional orientation gains without pushing tail runtime too close to the 30s timeout. Prototype `rotationSamples: 72` and keep only if it beats Stage 14 with acceptable runtime.

Result: score improved, but runtime is too close to the limit without another guard. Full train score was `0.658423` with 499/499 ok, above Stage 14's `0.658235`. Candidate choices were EdgeBalancer 413, FABalancer 53, Air 25, Tutte 8. The gains came from angular resolution, aspect ratio, edge-length metrics, and alignment, but node uniformity and spacing dropped. Runtime tail became risky (`p50 2544ms`, `p90 5996ms`, `p99 13134ms`, max `29332ms`), so the next stage should keep the 72-sample sweep only with an internal budget cutoff.

## Stage 16: Budget-Aware Transform Cutoff

Goal: keep Stage 15's higher-scoring 72-sample sweep while reducing timeout risk. Add a deadline check inside the rotation/affine transform loop so a candidate can return the best transform found so far instead of continuing past the layout budget.

Result: kept. Full train score stayed at Stage 15's `0.658423` with 499/499 ok, but runtime became much safer (`p50 2025ms`, `p90 4789ms`, `p99 14089ms`, max `20885ms`). Candidate choices were unchanged: EdgeBalancer 413, FABalancer 53, Air 25, Tutte 8. The cutoff is retained because it preserves quality while reducing timeout risk.

## Stage 17: 80-Sample Rotation Sweep With Cutoff

Goal: with the Stage 16 cutoff in place, test whether increasing `rotationSamples` from 72 to 80 gives another orientation-score gain without exceeding the budget. Keep only if the score improves and runtime remains comfortably under 30 seconds.

Result: kept. Full train score improved to `0.659115` with 499/499 ok, above Stage 16's `0.658423`. Candidate choices were EdgeBalancer 412, FABalancer 57, Air 24, Tutte 6. The main gains were node uniformity (`0.705882 -> 0.714286`), edge orthogonality, and spacing, while angular resolution and edge-length metrics dropped. Runtime remained acceptable with the cutoff (`p50 1960ms`, `p90 4860ms`, `p99 14740ms`, max `21586ms`).

## Stage 18: 96-Sample Rotation Sweep With Cutoff

Goal: test whether the rotation sweep still has headroom beyond 80 samples. With the budget cutoff in place, prototype `rotationSamples: 96` and keep it only if it improves Stage 17 without creating timeout pressure.

Result: kept. Full train score improved to `0.659595` with 499/499 ok, above Stage 17's `0.659115`. Candidate choices were EdgeBalancer 415, FABalancer 51, Air 25, Tutte 8. The largest gain was alignment (`0.667218 -> 0.675899`), with smaller gains in aspect ratio, edge-length deviation, and edge ratio. Angular resolution, edge orthogonality, face, node uniformity, and spacing slipped slightly. Runtime remained under the 30s timeout with the cutoff (`p50 2305ms`, `p90 6011ms`, `p99 16278ms`, max `26691ms`), so the extra samples are retained.

## Stage 19: Conservative Class-Specific Candidates

Goal: test whether targeted, structurally safe candidates help graph families that generic force/Tutte-style layouts do not specialize for. Add a GPT-only tree/path candidate for connected `m = n - 1` graphs and an exact rectangular-grid candidate for graphs that satisfy the `P_r x P_c` edge-count and degree signature. Both candidates are still validated and scored by the existing selector, so they should be kept only if they improve quality without harming the 30s budget.

Result: kept. Full train score improved to `0.660761` with 499/499 ok, above Stage 18's `0.659595`. The new candidates were selected on 11 graphs: tree 10 times and grid once (`grid4x20`). Candidate choices were EdgeBalancer 406, FABalancer 50, Air 25, Tree 10, Tutte 7, Grid 1. The largest aggregate gains were node uniformity (`0.708333 -> 0.714286`), edge ratio (`0.381601 -> 0.385115`), alignment, and edge orthogonality; edge-length deviation slipped slightly. Runtime stayed below timeout (`p50 2223ms`, `p90 5549ms`, `p99 15806ms`, max `28003ms`).

## Stage 20: Planar 3-Tree Candidate

Goal: test a very narrow class-specific candidate for planar 3-trees using the existing exported P3T implementation. The train set only contains one detected planar 3-tree, so this is mainly a hidden-benchmark generalization check; keep it only if it causes no aggregate or runtime regression and the selector uses it when helpful.

Result: kept as a neutral hidden-benchmark guard. Full train score was unchanged from Stage 19 at `0.660761` with 499/499 ok. P3T was not selected on the single train planar 3-tree; candidate choices remained EdgeBalancer 406, FABalancer 50, Air 25, Tree 10, Tutte 7, Grid 1. Runtime remained below timeout (`p50 2201ms`, `p90 5636ms`, `p99 14889ms`, max `27158ms`). Since the analyzer is strict, cheap, and caused no regression, the hook stays available for unseen planar 3-tree instances.

## Stage 21: Two-Row Grid Recovery

Goal: extend the exact rectangular-grid candidate to handle `2 x k` ladder grids. These have all vertices on the boundary, so the Stage 19 boundary-cycle recovery can be ambiguous even though the grid signature is clear. Add a separate rung-by-rung coordinate recovery for the two-row case and keep it only if it preserves Stage 20 quality and timing.

Result: kept. Full train score was unchanged from Stage 20 at `0.660761` with 499/499 ok, and a synthetic `2 x 10` ladder selected the grid candidate as intended. Candidate choices on train remained EdgeBalancer 406, FABalancer 50, Air 25, Tree 10, Tutte 7, Grid 1. Runtime stayed below timeout (`p50 2153ms`, `p90 5692ms`, `p99 15278ms`, max `27653ms`). The branch is retained for unseen two-row grid instances.

## Stage 22: Tighter Internal Budget

Goal: the canonical Stage 21 run reached a max runtime close to the 30s timeout, despite the stage run being safer. Test reducing the internal layout budget from 28s to 26s so slow instances return the best transform found earlier. Keep only if the p50 score remains at Stage 21 quality while improving timeout margin.

Result: kept. Full train score stayed at `0.660761` with 499/499 ok, matching Stage 21. Candidate choices were unchanged: EdgeBalancer 406, FABalancer 50, Air 25, Tree 10, Tutte 7, Grid 1. The stage run reduced the tail relative to the close canonical Stage 21 pass (`p50 2167ms`, `p90 5642ms`, `p99 15332ms`, max `27506ms`), so the 26s internal budget is retained.

## Stage 23: Radial Tree Candidate

Goal: trees are already handled better by the Stage 19 layered/path candidate, but hidden benchmarks may include stars or high-branching trees where a radial sector drawing gives more uniform edge lengths and angular resolution. Add a second tree-only candidate rooted at the tree center with child sectors sized by leaf count. Keep it only if the selector uses it without hurting aggregate quality or timeout margin.

Result: kept. Full train score improved to `0.660950` with 499/499 ok, above Stage 22's `0.660761`. RadialTree was selected 14 times, mostly replacing generic candidates or the layered tree on branching trees. Candidate choices were EdgeBalancer 399, FABalancer 50, Air 23, RadialTree 14, Tree 6, Tutte 6, Grid 1. The gain came from angular resolution (`0.541891 -> 0.544619`), aspect ratio, and spacing, while edge-length deviation slipped. Runtime stayed below timeout (`p50 2466ms`, `p90 5674ms`, `p99 18069ms`, max `26025ms`).

## Stage 24: Unicyclic Cycle-Core Candidate

Goal: several of the lowest-scoring remaining train graphs are connected unicyclic graphs (`m = n`) with many leaves attached to a core cycle. Prototype a structurally exact unicyclic candidate: find the unique cycle by leaf peeling, draw the cycle as a regular polygon, and route attached trees outward in disjoint radial sectors. Keep it only if the existing selector chooses it on real cases and improves aggregate quality without planarity or timeout regressions.

Result: promising but unsafe. Full train score rose sharply to `0.671556`, with Unicyclic selected 44 times and large gains in convexity, edge ratio, spacing, and angular resolution. However the run had one timeout (`g_90_3`, a 90-node tree), so this exact variant is not acceptable as the final state despite the quality gain.

## Stage 25: Safer Targeted Candidates Budget

Goal: keep the Stage 24 graph-class gains while restoring timeout margin. Lower the internal layout budget from `26000ms` to `22000ms` so the GPT selector leaves more room for worker-side benchmark metrics inside the 30s evaluator timeout. Keep only if the unicyclic/radial-tree gains survive and the full train run has 499/499 ok.

Result: kept. Full train score improved to `0.671752` with 499/499 ok, above Stage 23's safe `0.660950` and Stage 24's timeout-affected `0.671556`. Candidate choices were EdgeBalancer 361, FABalancer 50, Unicyclic 44, Air 20, RadialTree 14, Tree 6, Tutte 3, Grid 1. Runtime margin was restored (`p50 2848ms`, `p90 7275ms`, `p99 21213ms`, max `22690ms`). The main gains versus Stage 23 were convexity (`0.25 -> 0.333333`), edge ratio (`0.385115 -> 0.407053`), spacing, angular resolution, and edge-length deviation; node uniformity and edge orthogonality slipped slightly.

## Stage 26: Sparse Leaf-Spread Candidate

Goal: the lowest-scoring remaining train cases are mostly sparse connected graphs with small cores, many leaves, weak convexity, weak edge-length ratio, and weak spacing. Prototype a data-driven postprocess that takes the best eligible sparse base drawing, keeps the core fixed, and relocates pendant leaves into local angular gaps around their parent with near-median edge lengths. Validate with the existing planarity and metric selector so unsafe or lower-quality spread layouts are ignored.

Result: partially kept. The raw leaf-spread candidate improved full train score to `0.672081` with 499/499 ok and was selected 40 times, mostly replacing EdgeBalancer on sparse leaf-heavy graphs. It gave large angular-resolution gains on a few cases but also dropped edge-length ratio p50, so the idea needed a guard before being accepted.

## Stage 27: Leaf-Spread Edge-Ratio Guard

Goal: keep the useful sparse leaf-spread wins while preventing the selector from accepting layouts that buy angular resolution by collapsing edge-length ratio. Simulate guard rules against Stage 26, then add the simplest general guard if it improves the p50 aggregate.

Result: kept. Rejecting leaf-spread when its edge-ratio drops more than `0.16` below the seed drawing improved full train score to `0.672675` with 499/499 ok. LeafSpread remained selected 38 times. The guard improved the Stage 26 score and restored edge-ratio p50 while preserving most of the angular-resolution gains.

## Stage 28: Outerplanar Circular-Order Candidate

Goal: the low-score analysis showed a subset of sparse failures were outerplanar but drawn with concave faces. Detect outerplanar graphs by adding a universal outer hub and checking planarity; use the hub rotation as a cyclic vertex order and draw all vertices on a circle. This should produce a convex straight-line drawing for true outerplanar cases, while the existing crossing check and metric selector reject bad cases.

Result: kept. Full train score improved to `0.677311` with 499/499 ok. `outercircle` was selected 35 times. The main aggregate gain was convexity (`0.333333 -> 0.400000`) and spacing, with expected tradeoffs in edge ratio and edge-length deviation. Runtime stayed below timeout (`p50 2545ms`, `p90 6686ms`, `p99 20088ms`, max `25009ms`).

## Stage 29: Core-Tree Candidate

Goal: after the outerplanar pass, the remaining low-score graphs were mostly sparse connected graphs with a nontrivial 2-core plus attached trees. Prototype a core-first drawing: peel the graph to its 2-core, draw the core alone with EdgeBalancer, then place the peeled trees outward in deterministic sectors around their attachment vertices. Keep it only if the final full graph remains plane and the metric selector chooses it.

Result: kept. Full train score improved to `0.689137` with 499/499 ok. `coretree` was selected 112 times, replacing many unicyclic, outercircle, leafspread, and generic candidates. The biggest p50 gains were edge ratio (`0.391091 -> 0.439313`), angular resolution (`0.556467 -> 0.581511`), convexity (`0.400000 -> 0.428571`), edge-length deviation, face uniformity, and spacing; node uniformity, edge orthogonality, and alignment slipped. Guard simulations for those slipped metrics all reduced total score, so the plain metric selector is kept. Runtime remained under timeout (`p50 2997ms`, `p90 8187ms`, `p99 22019ms`, max `27151ms`).

## Stage 30: Bounded Metric Polish

Goal: the remaining low-score cases are usually valid drawings that are locally improvable but not captured by another structural class. Prototype a late deterministic local search from the selected drawing: try small node moves in fixed directions, keep only moves that preserve planarity and improve the actual ten-metric average, and stop under a strict evaluation/deadline budget. Apply it only to smaller low-quality drawings so it behaves like a cleanup pass rather than a replacement algorithm.

Result: kept. First, two wild-card ideas were discarded: re-adding raw public algorithm candidates from the Stage 26 sweep reduced the Stage 29 selector score, and a seed-preserving branch-spread prototype produced only small gains on a few sparse graphs. The bounded local metric polish was much stronger. With `polishMaxNodes: 50`, `polishMaxScore: 0.72`, and `polishMaxEvaluations: 450`, full train score improved from Stage 29's `0.689137` to `0.721459` with 499/499 ok and no breakages/TLE. The main p50 gains were convexity (`0.428571 -> 0.500000`), alignment (`0.674230 -> 0.762821`), spacing (`0.769123 -> 0.820887`), node uniformity (`0.695652 -> 0.733333`), edge orthogonality, face uniformity, edge ratio, and aspect ratio; edge-length deviation slipped slightly. Runtime stayed under timeout (`p50 3438ms`, `p90 8099ms`, `p99 22015ms`, max `23893ms`).

## Stage 31: Larger Low-Score Polish

Goal: after Stage 30, many of the remaining worst cases are sparse graphs just above the 50-node polish cutoff. Test extending the same deterministic polish pass up to 80 nodes, but cap the evaluation count lower for graphs above 50 nodes so the runtime tail remains below the 30s evaluator timeout.

Result: kept. Raising `polishMaxNodes` to `80` with `polishLargeNodeThreshold: 50` and `polishLargeMaxEvaluations: 320` improved 11 additional row scores and caused no row-score losses. Full train score improved to `0.721896` with 499/499 ok and no breakages/TLE. Aggregate gains were small but clean: alignment p50 improved by `+0.003818`, edge orthogonality by `+0.000884`, and aspect ratio by `+0.000123`, with angular resolution down `-0.000450`. Runtime remained safe (`p50 2852ms`, `p90 7718ms`, `p99 19102ms`, max `22017ms`).

## Stage 32: Ninety-Node Low-Score Polish

Goal: the Stage 31 bottom list still has a few low-score sparse graphs at 81-91 nodes, just above the polish guard. Focused cap sweeps showed that the existing larger-graph cap of 320 evaluations improves these cases without approaching the timeout, so test raising only `polishMaxNodes` from `80` to `96`.

Result: kept. Full train score improved from Stage 31's `0.721896` to `0.721962` with 499/499 ok and no breakages/TLE. Only three layouts changed, all gains: `g_89_1` (`0.574049 -> 0.609598`), `g_88_0` (`0.574812 -> 0.592318`), and `g_81_16` (`0.700836 -> 0.711313`). The p50 gain came from alignment (`+0.000735`) and face uniformity (`+0.000041`), while aspect ratio moved down slightly (`-0.000123`). Runtime stayed below timeout (`p50 2860ms`, `p90 7823ms`, `p99 20872ms`, max `23121ms`). No remaining train graph above 96 nodes was both below the score gate and eligible for this polish pass, so the guard was not broadened further.

## Stage 33: Mid-Score Polish Gate

Goal: the Stage 32 bottom tail is much better, but many 0.72-0.78 score drawings were not polished because the cleanup gate only allowed seeds at or below `0.72`. A focused option-only prototype on 35 unpolished graphs in that band produced 35 row-score gains and no losses, with average row gain about `+0.026`. Test raising `polishMaxScore` from `0.72` to `0.78` and keep it only if the full p50 aggregate and timeout margin improve.

Result: kept. Full train score improved from Stage 32's `0.721962` to `0.725067` with 499/499 ok and no breakages/TLE. The p50 gains came mainly from alignment (`+0.010216`), spacing (`+0.007942`), edge orthogonality (`+0.005555`), face uniformity (`+0.002894`), node uniformity, aspect ratio, edge ratio, and angular resolution; edge-length deviation slipped slightly (`-0.000903`). Runtime stayed below timeout (`p50 2908ms`, `p90 7986ms`, `p99 21625ms`, max `22019ms`). A row comparison found 65 changed layouts, with 64 gains and one tiny time-budget wobble on `g_88_0`.

## Stage 34: Upper-Mid Polish Gate

Goal: continue the same data-driven test for the next band. A focused option-only prototype on 35 unpolished 0.78-0.84 score drawings with `polishMaxScore: 0.84` produced 34 row-score gains, one unchanged case, no losses, and average row gain about `+0.025`. Test the full aggregate and timeout margin before keeping.

Result: kept. Full train score improved from Stage 33's `0.725067` to `0.727687` with 499/499 ok and no breakages/TLE. The p50 gains were concentrated in edge orthogonality (`+0.010767`), alignment (`+0.007741`), spacing (`+0.002793`), node uniformity, edge-length deviation, aspect ratio, and face uniformity. Runtime stayed below timeout (`p50 3231ms`, `p90 7643ms`, `p99 22010ms`, max `22025ms`). A row comparison found 102 changed layouts, with 100 gains and two small time-budget wobbles on already-low larger sparse cases.

## Stage 35: High-Score Polish Gate

Goal: test the remaining useful score band without making all high-quality drawings pay the cleanup cost. A focused `polishMaxScore: 0.90` prototype on 21 unpolished 0.84-0.90 drawings produced 17 row-score gains, four unchanged cases, no losses, and average row gain about `+0.0106`. Keep only if the full p50 aggregate improves and the slow grid/tree cases still stay under timeout.

Result: kept, but this is probably the last useful score-gate expansion for now. Full train score improved from Stage 34's `0.727687` to `0.727949` with 499/499 ok and no breakages/TLE. The p50 gains were small: edge-length deviation (`+0.001145`), alignment (`+0.000770`), edge orthogonality (`+0.000444`), face uniformity (`+0.000204`), and aspect ratio (`+0.000057`). Runtime stayed below timeout (`p50 3087ms`, `p90 7842ms`, `p99 22011ms`, max `22759ms`). The full run showed two low-tail time-budget wobbles, but sequential checks of `g_89_1`, `g_81_16`, and `grafo8507_75` reproduced the expected higher scores with 13-18s runtimes; those rows do not drive the p50 aggregate.

## Stage 36: Post-Polish Transform Sweep

Goal: the local polish pass accepts raw moved coordinates and does not re-run the rotation/affine transform sweep afterward. Since rotations and mild determinant-one stretches are already validated and useful for axis-sensitive metrics, test a bounded post-polish transform sweep for graphs up to 60 nodes. Keep only if it improves the full p50 aggregate without pushing the runtime tail toward the 30s timeout.

Result: discarded before full evaluation. A focused comparison against Stage 35 on 70 low-score and median-metric cases produced only 5 row-score gains, no losses, and average row gain `+0.000196`. The metric movement was mostly aspect-ratio improvement, which is already near saturation, with tiny negative movement in angular resolution, edge orthogonality, node uniformity, and spacing. The extra transform sweep is not worth the added runtime and complexity.

## Stage 37: Extra Public Candidate Seeds

Goal: now that the polish pass can clean up many seed drawings, retest whether public algorithms that previously lost as raw candidates become useful as alternate seeds. Add explicit candidate-name support for FaceBalancer, AngleBalancer, and Reweight, then prototype them in a focused selector portfolio before deciding whether to include any by default.

Initial focused result: mixed if the selector still polishes only one seed. On 40 low-score and median-metric cases, adding FaceBalancer/AngleBalancer/Reweight as raw seeds gave 3 wins and 3 losses (`avg +0.000625`). The losses happened because a slightly better raw extra candidate could steal the single polish pass from the default seed that would have polished better. Next prototype: keep the extra candidate-name support, but test polishing the top two raw seeds before selecting the final layout.

Second focused result: promising. With top-two polishing and the same extra seed portfolio, the 40-case focused set produced 13 wins, no losses, and average row gain `+0.003522`. The useful extra seeds were FaceBalancer and AngleBalancer; Reweight did not win in the focused set. Promote a guarded default version: add FaceBalancer and AngleBalancer only for graphs up to 60 nodes, polish the top two raw seeds only up to 60 nodes, and keep larger graphs on the old one-seed path.

Full-result note: the unguarded default improved train score to `0.729373` with 499/499 ok, but the p50 edge-ratio metric dropped sharply (`0.456904 -> 0.428166`). Row-level analysis showed the extra seeds were often real winners, while a subset bought those wins by stretching edge lengths. Continue with a runtime guard instead of accepting the unguarded version.

## Stage 38: Extra-Seed Edge-Ratio Guard

Goal: keep the Stage 37 alternate-seed gains while avoiding layouts that improve the ten-metric average mostly by giving up edge-length balance. Add a runtime selector guard for FaceBalancer/AngleBalancer/Reweight seeds: compare an extra-seed candidate against the best non-extra alternative available in the same run and reject it if its edge-ratio drops by more than `0.20`. Process non-extra polished seeds before extra polished seeds among the selected top-two seeds so the guard can compare against a polished baseline when one is available.

Result so far: kept as the new working baseline. The focused guard pass exposed one fallback issue, so the selector now polishes up to three seeds on small graphs and remembers the strongest non-extra edge-ratio reference. Full train score improved to `0.729572` with 499/499 ok, no breakages/TLE, and runtime still below timeout (`p50 4881ms`, `p90 12611ms`, `p99 22014ms`, max `22763ms`). This beats Stage 35's `0.727949` and unguarded Stage 37's `0.729373`; edge-ratio p50 recovered partway from Stage 37 (`0.428166 -> 0.438260`) while preserving most extra-seed gains.

## Stage 39: Medium Extra-Seed Window

Goal: several remaining low-score sparse graphs are just above the 60-node extra-seed cutoff. Test extending FaceBalancer/AngleBalancer seed eligibility and multi-seed polish beyond 60 nodes while keeping the Stage 38 edge-ratio guard. An 80-node focused probe showed the useful direct wins were all at 70 nodes or below, while 72-80 node cases mostly added deadline pressure, so narrow the full candidate to a 70-node window.

Result: discarded. The 70-node focused run looked positive on targeted low-score rows, but the full train score dipped to `0.729467` with 499/499 ok. Edge-ratio p50 improved (`0.438260 -> 0.442109`), but node-uniformity and spacing p50 slipped enough to lose aggregate score, and runtime rose (`p50 5270ms`, `p90 13866ms`). Restore the Stage 38 60-node cutoff.

## Stage 40: Core-Tutte Seed

Goal: the remaining bottom-tail graphs are mostly sparse connected graphs with a nontrivial 2-core and many attached trees. The current CoreTree seed draws the peeled core with EdgeBalancer before placing trees outward. Prototype a sibling candidate that draws the same 2-core with Tutte instead, then reuses the existing outward tree placement and metric selector. Keep only if it gives new wins on low-score sparse cases without disturbing the p50 aggregate or timeout margin.

Focused result: promising, with a size guard. On a 119-row set made from the bottom tail plus low-scoring CoreTree rows, an uncapped CoreTutte candidate produced 9 row gains, no losses, and 7 direct CoreTutte wins. A 50-node cap kept those direct wins but introduced a couple of larger-graph time-budget wobbles in the focused concurrent run. The meaningful CoreTutte gains were all at 30 nodes or below, so tighten the default candidate window to 30 nodes before trying a full train run.

Result: discarded. The 30-node capped full train run stayed valid with 499/499 ok, but total score fell to `0.727755`. CoreTutte produced real row-score wins, especially on a few small sparse graphs with poor convexity, but the accepted drawings lowered edge-ratio and node-uniformity p50 (`edgeRatio 0.438260 -> 0.428166`, `nodeUniformity 0.744681 -> 0.739130`). Simulated edge-drop guards on the Stage 40 rows still did not recover Stage 38's aggregate, so remove CoreTutte from the default selector.

## Stage 41: Public Algorithm Tail Sweep

Goal: before inventing another custom candidate, check whether any exported algorithm not currently used as a default GPT seed has strong raw layouts on the remaining bottom tail. Run CleanAir, AreaGrad, ForceDir, ImPrEd, FPP, Schnyder, CEG-bfs, and CEG-xy on the lowest 50 Stage 38 rows and compare row scores against GPT.

Result: discarded as default seed material. CleanAir failed on all 50 focused rows; AreaGrad, ForceDir, ImPrEd, CEG-bfs, and CEG-xy also had failures or timeouts. FPP and Schnyder were stable but much lower scoring. Among successful runs, no non-GPT algorithm beat GPT on any of the 50 rows. The per-algorithm average row-score deltas versus GPT were all strongly negative, so there is no obvious exported raw seed to add.

## Stage 42: Balanced Selector Weights

Goal: test whether the internal selector should optimize a metric-balanced score rather than the plain per-row average. The benchmark averages metric p50s, so a drawing can win the current selector by improving saturated metrics while lowering weaker median-driving metrics such as edge ratio, angular resolution, or edge orthogonality. Prototype optionized metric weights inside GPT only, run focused sweeps near the current bottom tail and p50 neighborhoods, and keep only if a full train run improves without runtime or planarity regressions.

Focused result: discarded. An aggressive weight vector improved focused `edgeRatio` and `edgeOrthogonality`, but lost too much aspect ratio, face uniformity, node uniformity, alignment, and spacing, dropping the focused p50 aggregate from `0.685322` to `0.683810`. A lighter vector was worse (`0.681099`) and also reduced convexity. Restore the plain average selector; the optionized prototype is not kept as a default behavior.

## Stage 43: Attachment Scale Variants

Goal: the remaining bottom rows often have extremely low edge-length ratio on sparse graphs with a core plus attached trees. Add narrow alternate candidates that reuse the existing unicyclic and core-tree constructions but vary only the outward tree spacing. The selector and planarity checks can keep useful compact/wide variants while ignoring variants that hurt the balanced row score. Start on the Stage 42 focused set and keep only if the gains survive a full train run with acceptable runtime.

Result so far: promising. The focused set improved from `0.682405` to `0.685635`, then the full train run improved from Stage 38's `0.729572` to `0.733957` with 499/499 ok and no breakages/TLE. The main p50 gain was edge ratio (`0.438260 -> 0.473581`), with additional gains in angular resolution, edge-length deviation, alignment, and spacing. Node uniformity and edge orthogonality slipped, so test a general tradeoff guard before finalizing.

## Stage 44: Attachment Variant Tradeoff Guard

Goal: keep the Stage 43 edge-ratio gains while rejecting compact/wide attachment variants that mostly buy row-score wins by sacrificing node uniformity. Simulate guards against Stage 43 rows, then prototype the simplest runtime rule: compare each attachment-scale variant with the best non-variant reference seen by the selector and reject it when node uniformity drops too much without a meaningful edge-ratio gain.

Result: kept. The full train run improved slightly over Stage 43, from `0.733957` to `0.733977`, with 499/499 ok and no breakages/TLE. The guard and polish ordering recovered edge orthogonality (`0.601878 -> 0.602799`) and face p50 (`0.951867 -> 0.951880`) while preserving the large Stage 43 edge-ratio gain (`0.473581`). Angular resolution and aspect ratio slipped very slightly, but the aggregate stayed positive. Runtime remained below timeout (`p50 5935ms`, `p90 13610ms`, `p99 22015ms`, max `26179ms`).

## Stage 45: Simpler General Version

Goal: prefer a general, maintainable algorithm over the higher Stage 44 train score. The user explicitly accepted a lower score around `0.727` if it removed over-training risk and left a simpler implementation.

Result: kept as final. Removed the late train-score-maximizing machinery: FaceBalancer/AngleBalancer/Reweight alternate seeds, multi-seed polish, extra-seed edge-ratio bookkeeping, compact/wide unicyclic and core-tree attachment variants, and attachment-variant tradeoff guards. The retained implementation is the broader general selector plus class-specific graph recognizers and one bounded polish pass.

Full train run (`evaluation_data/gpt-simplified-train-results.csv`) completed with 499/499 ok, no breakages/TLE, and total score `0.727890`. Metric p50s were angular resolution `0.582134`, aspect ratio `0.993807`, convexity `0.500000`, edge-length deviation `0.847692`, edge ratio `0.456904`, edge orthogonality `0.592523`, face `0.951662`, node uniformity `0.736842`, alignment `0.785712`, and spacing `0.831622`. Runtime stayed under the 30s timeout (`p50 3449ms`, `p90 8495ms`, `p99 22017ms`, max `26519ms`), and the canonical `evaluation_data/gpt-train-results.csv` artifacts were updated to this simpler run.

## Final Selected Version

Kept Stage 45. The implementation is a deterministic GPT selector over Tutte, EdgeBalancer, FABalancer, guarded Air, exact tree/path and radial-tree layouts, connected unicyclic layouts, exact rectangular grids including `2 x k` ladders, planar 3-trees, outerplanar circular-order drawings, sparse leaf-spread postprocessing, core-tree drawings, and a bounded metric-polish cleanup pass. Every candidate is validated for planarity, scored with the ten benchmark metrics, and passed through the 96-sample rotation plus determinant-one affine stretch sweep `[1, 1.04, 1.10, 1.20]` for graphs up to 160 nodes. The transform loop keeps the internal 22s budget cutoff to leave headroom for evaluator metrics. The polish pass is capped by graph size, seed score, evaluation count, and deadline, and runs once from the selected candidate.

Canonical full train run (`evaluation_data/gpt-train-results.csv`): `0.727890` with 499/499 ok and no breakages/TLE. Metric p50s were angular resolution `0.582134`, aspect ratio `0.993807`, convexity `0.500000`, edge-length deviation `0.847692`, edge ratio `0.456904`, edge orthogonality `0.592523`, face `0.951662`, node uniformity `0.736842`, alignment `0.785712`, and spacing `0.831622`. Internal choices from the run were Polish-EdgeBalancer 260, Polish-CoreTree 112, Polish-FABalancer 41, Polish-OuterCircle 20, Polish-LeafSpread-EdgeBalancer 18, Polish-Air 14, Polish-RadialTree 12, Polish-Unicyclic 7, Polish-Tree 6, Unicyclic 2, OuterCircle 2, EdgeBalancer 1, RadialTree 1, Grid 1, Polish-LeafSpread-FABalancer 1, and Polish-Tutte 1. Runtime stayed under the 30s timeout (`p50 3449ms`, `p90 8495ms`, `p99 22017ms`, max `26519ms`).
