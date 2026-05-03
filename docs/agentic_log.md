# Agentic Layout Development Log

## Stage 1: Metric-Scored Public Candidate Selector

Goal: build a deterministic, robust baseline that does not modify existing algorithms. The layout will run a small portfolio of exported public layout compute methods, evaluate each valid plane drawing with the same ten metrics used by the benchmark, and apply the highest-scoring candidate.

Initial plan:
- Start with EdgeBalancer and Hybrid, because they are the strongest current baselines and optimize complementary metrics.
- Score candidates by the raw mean of the ten metric values for the current graph, with non-plane or incomplete drawings rejected.
- Keep timing conservative for unseen graphs by running only a small portfolio at first.
- Use train data only for sanity checks, not graph-specific memorization.

Pre-implementation estimate from existing train CSV: selecting between EdgeBalancer and Hybrid by per-graph mean metric score would score about `0.632994` on `planar_train.dot`, compared with EdgeBalancer `0.622226` and Hybrid `0.596484`.

Result: implemented `layout-agentic.js` as a public-candidate selector with rotation scoring. Full train command completed with 499/499 ok and total score `0.652673`.

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

Candidate choices: EdgeBalancer 422, Hybrid 67, Tutte 10. The rotation sweep was a clear win over the initial estimate, mainly improving orientation-sensitive metrics while preserving planarity.

## Stage 2: Add Angular Candidate

Goal: test whether AngleBalancer adds useful candidates without making the default portfolio too slow. Existing broader benchmark data suggests a small gain when selecting among EdgeBalancer, Hybrid, and AngleBalancer, so prototype it behind the same node-count guard as Hybrid and keep it only if the full train score improves.

Result: discarded. Full train score was `0.652234` with 499/499 ok, below Stage 1's `0.652673`. Candidate choices were EdgeBalancer 395, Hybrid 48, AngleBalancer 49, Tutte 7. It improved angular resolution, aspect ratio, face, and alignment p50s, but the loss in edge-length metrics, node uniformity, and spacing outweighed those gains.

## Stage 3: Rotation Resolution

Goal: test whether a denser rotation sweep improves orientation-sensitive metrics. This is low algorithmic risk because rotation preserves planarity and all distance/area/angle ratios except viewport-axis metrics.

Result: kept. Changed rotation samples from 24 to 48 and skipped repeated crossing checks for rotated copies after validating the source candidate. Full train score improved to `0.655581` with 499/499 ok. Candidate choices: EdgeBalancer 423, Hybrid 65, Tutte 11.

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

## Stage 4: Add ReweightTutte Candidate

Goal: test whether ReweightTutte adds useful face/spacing alternatives at acceptable cost. Existing broader benchmark data suggests a small selector gain when ReweightTutte is available with EdgeBalancer and Hybrid, but this must be checked on the actual p50 objective.

Result: discarded. Full train score was `0.654451`, below Stage 3's `0.655581`. Reweight improved angular, face, alignment, and spacing p50s slightly, but lowered edge deviation and edge ratio enough to lose overall.

## Stage 5: Affine Transform Sweep

Goal: extend the rotation-only post-processing into a mild affine sweep. Any invertible affine transform preserves straight-line planarity, face-area ratios, and convexity, while changing aspect ratio, edge-length distribution, orthogonality, alignment, node uniformity, and spacing. Prototype determinant-one stretches around each candidate and keep the transform with the best ten-metric mean.

Result: kept. Full train score improved to `0.656319` with 499/499 ok. Candidate choices: EdgeBalancer 422, Hybrid 66, Tutte 11. Runtime stayed below the per-graph timeout on train (`p50 1335ms`, `p90 3268ms`, `p99 7815ms`, max `13758ms`). The affine sweep improved aspect ratio, orthogonality, node uniformity, alignment, and spacing, but reduced angular resolution and edge-length metrics.

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

Result: kept. Changed stretch factors to `[1, 1.04, 1.10, 1.20]`. Full train score improved to `0.657389` with 499/499 ok. Candidate choices: EdgeBalancer 426, Hybrid 62, Tutte 11. Runtime remained below timeout on train (`p50 1651ms`, `p90 3858ms`, `p99 9986ms`, max `17674ms`).

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
