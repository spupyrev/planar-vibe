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
