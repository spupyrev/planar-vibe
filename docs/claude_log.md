# Agentic Layout — Development Log
 
## Target
 
Maximize the evaluation score on `planar_train.dot`: mean of p50 scores across 10 metrics. Baselines: **EdgeBalancer 0.622226**, **Hybrid 0.596484**.
 
Per-metric p50 of EdgeBalancer (reproduced locally, matches docs):
 
| metric | score |
|---|---|
| angularResolution | 0.517 |
| aspectRatio | 0.904 |
| convexity | 0.200 |
| edgeLengthDeviation | 0.849 |
| edgeRatio | 0.413 |
| edgeOrthogonality | 0.500 |
| face | 0.912 |
| nodeUniformity | 0.647 |
| alignment | 0.546 |
| spacing | 0.734 |
 
Biggest weak spots of the best current baseline: **convexity (0.20)**, **edgeRatio (0.41)**, **edgeOrthogonality (0.50)**, **angularResolution (0.52)**, **alignment (0.55)**. These are the levers to pull. The other metrics are already ≥ 0.65 at the baseline.
 
## Plan
 
- **Stage 0** — benchmark every existing layout once on `planar_train.dot` → build the ensemble candidate set.
- **Stage 1** — best-of-N ensemble: run top-K algorithms per graph, pick the highest-scoring plane result. Deterministic seeding via vertex-count hash.
- **Stage 2** — add planarity-preserving post-processing passes aimed at the weak metrics (convexity, orthogonality, edgeRatio, alignment).
- **Stage 3** — advanced: staged triangulation, per-graph ensembling with larger search, metric-driven parameter selection.
- **Stage 4** — final full-run + robustness (timeouts, determinism, log writeup).
 
## Stage 0 — Benchmark all existing layouts
 
**Goal:** Identify per-metric champions.
 
**Method:** Run every algorithm (tutte, air, cleanair, areagrad, facebalancer, edgebalancer, anglebalancer, hybrid, reweight, forcedir, impred, fpp, schnyder, ceg_bfs, ceg_xy) on `planar_train.dot` with 10s timeout.
 
**Results — total score, ranked:**
 
| algo | total | top metric(s) |
|---|---|---|
| edgebalancer | 0.622 | edgeLengthDeviation, edgeRatio, face, nodeUniformity, spacing |
| hybrid | 0.596 | edgeOrthogonality (0.604) |
| anglebalancer | 0.592 | angularResolution (0.65) |
| facebalancer | 0.586 | — |
| areagrad | 0.580 | — |
| air | 0.579 | — |
| reweight | 0.574 | — |
| forcedir | 0.572 | — |
| impred | 0.564 | — (15 breakages) |
| ceg_xy | 0.533 | — |
| tutte | 0.528 | aspectRatio (0.964) |
| ceg_bfs | 0.526 | angularResolution (0.675), very strong |
| schnyder | 0.480 | **alignment (0.853)** |
| fpp | 0.462 | **alignment (0.736)** |
| cleanair | 0.000 | 492/499 failed (not viable) |
 
**Per-metric champions:**
 
- angularResolution: **ceg_bfs (0.675)** >> edgebalancer (0.517)
- aspectRatio: tutte (0.964), edgebalancer (0.904)
- convexity: 8-way tie at 0.333; edgebalancer = 0.200 (loses)
- edgeLengthDeviation: **edgebalancer (0.849)** >> all else (≤0.69)
- edgeRatio: **edgebalancer (0.413)** >> ALL others ≤ 0.09 (massive gap — critical to preserve!)
- edgeOrthogonality: **hybrid (0.604)** > edgebalancer (0.500)
- face: edgebalancer (0.912), all others 0.65–0.94
- nodeUniformity: edgebalancer (0.647)
- alignment: **schnyder (0.853)**, fpp (0.736); edgebalancer only 0.546
- spacing: edgebalancer (0.734)
 
**Implications:**
 
1. EdgeBalancer is the single strongest algorithm — wins 5/10 metrics outright. Must stay in the ensemble.
2. **edgeRatio is a moat**. Only EdgeBalancer produces graphs with a meaningful edgeRatio. Any ensemble that picks "best-by-mean" for graphs where a non-EB variant wins by a slim margin will sacrifice edgeRatio. Need geomean or min-weighted selection.
3. **alignment** has huge headroom: schnyder 0.85 shows it's achievable; axis-align post-processing should close the gap.
4. **convexity** tops out at 0.33 naturally — need a targeted repair pass.
5. CEG-bfs has excellent angularResolution; worth including.
6. Hybrid leads edgeOrthogonality — worth including.
 
## Stage 2 — Selection & candidate variants
 
Tried:
- **v2** — added FaceBalancer/ReweightTutte, selection = `0.5*mean + 0.5*geomean`. Score: **0.6525** (slight regression). Geomean didn't meaningfully deprioritize bad-edgeRatio variants.
- **v3** — mean selection, added alignment-on-base variant (in addition to rot+align). Score: **0.6553** (same as v1).
- **v4** — v3 + Schnyder/CEGBfs/Tutte candidates. Score: **0.6553** (same). Low-total candidates never win per-graph mean selection.
 
**Plateau at ~0.655** with per-graph max-mean selection. Analysis:
- `aspectRatio=0.962`, `face=0.927`, `spacing=0.744`, `nodeUniformity=0.683` — near max already.
- `edgeRatio=0.342` — regression from EB's 0.413. Alignment hurts short edges.
- `alignment=0.670` — huge Schnyder-like headroom (0.85), but Schnyder loses other metrics.
- `convexity=0.286` — capped by optimizer; needs targeted repair.
- `angularResolution=0.554` — CEG-bfs hits 0.675 but at cost elsewhere.
 
Per-graph mean-best selection cannot break the ceiling because **each variant trades metrics**. Need qualitatively different moves that improve total without sacrificing any metric.
 
## Stage 3 — Local-move refinement
 
**v5 / v6**: after selecting the best candidate variant, run a greedy local-move polish pass.
 
For every vertex, try 8 deterministic directions at decaying step size. Keep the move only if the full 10-metric mean improves AND no edge-crossing is introduced. Planarity check uses direct segment intersection between the vertex's incident edges (at new position) and all non-incident edges. Step decay: 0.05 → 0.025 → ... once a pass yields no improvement.
 
**v5** (no time budget): 0.7025 but 4 TLE on n≈90 graphs.
 
**v6** (budget-aware: maxPasses & stepScale shrink for n>60 / n>90; wall-clock cap 6–12s):
 
| algo | total | angRes | aspect | conv | eDev | eRatio | orth | face | nodeU | align | spacing |
|---|---|---|---|---|---|---|---|---|---|---|---|
| edgebalancer | 0.622 | 0.517 | 0.904 | 0.200 | 0.849 | 0.413 | 0.500 | 0.912 | 0.647 | 0.546 | 0.734 |
| agentic v1 (best-of-N+rot+align) | 0.655 | 0.556 | 0.962 | 0.286 | 0.831 | 0.347 | 0.547 | 0.927 | 0.684 | 0.668 | 0.739 |
| **agentic v6 (+polish)** | **0.703** | 0.552 | **0.988** | **0.400** | 0.804 | 0.365 | **0.617** | **0.957** | **0.759** | **0.764** | **0.819** |
 
**Net: +0.080 over EdgeBalancer, +0.048 over v1.** All 10 metrics improved vs EB except `angularResolution` (-0.005), `edgeLengthDeviation` (-0.044), `edgeRatio` (-0.047). Biggest wins: alignment (+0.22), orth (+0.12), aspectRatio (+0.08), convexity (+0.20), spacing (+0.09), nodeUniformity (+0.11).
 
Runtime: zero TLE at 30s budget, zero breakages.
 
**v7 / v8 — polish refinements:**
- v7: more passes/budget on small graphs + rot2 + align2 after polish → **0.7077** (+0.005)
- v8: multi-start polish (top-3 variants get polished, best kept) → **0.7222** (+0.015, one TLE on grid4x20)
- v9 (v8 + tighter budget for n>75): **0.7223, zero TLE, zero breakages**.
 
## Summary (so far)
 
| version | description | total |
|---|---|---|
| EdgeBalancer (baseline) | — | 0.6222 |
| agentic v1 | best-of-4 (EB/Hybrid/AngleBal/AreaGrad) + rotation sweep + axis-align | 0.6548 |
| agentic v6 | v1 + budget-aware local polish | 0.7025 |
| agentic v7 | v6 + rot2/align2 + more passes | 0.7077 |
| agentic v8 | v7 + multi-start polish (top-3) | 0.7222 |
| agentic v9 | v8 + tighter n>75 budget | 0.7223 |
| agentic v10 | v9 + fine-grained second polish (step 0.015 → 0.001) | 0.7387 |
| agentic v11 | v10 + micro-polish (step 0.004 → 0.0003) + align3 | 0.7431 (3 TLE on dense graphs) |
| **agentic v12** | **v11 + 25s global budget cap across all stages** | **0.7435, 0 TLE, 0 breakages** |
 
**Net: +0.121 over EdgeBalancer, +0.147 over Hybrid.**
 
### Stage 3 observations
 
1. **Local polish is the single biggest lever** after ensembling. Going from "best-of-N + rot + align" (0.655) to "+polish" (0.703) was +0.048, and progressively finer polish phases pushed to 0.744. The optimizers in the base candidates produce layouts that are NOT local optima for the 10-metric mean — many small deterministic moves improve the score.
2. **Multi-start polish** (polishing top-3 variants and keeping the best) gave +0.015 — escaping local minima matters.
3. **Coarse-to-fine schedule** matters: 3 phases (step 0.04, 0.015, 0.004) stack to +0.020.
4. **Re-alignment after polish** (step-snap after the layout settled) cleans up alignment: +0.005–0.01 per phase.
5. **Weighted polish** didn't help in smoke — polish already finds the unweighted optimum.
6. **Adding more candidate layouts** (Schnyder, CEG-bfs, Tutte) didn't help — per-graph mean-selection never picks them.
7. **Geometric-mean selection** (penalizing low metrics) didn't improve the dataset-wide p50 — mean selection is already well-aligned with the metric.
 
Runtime: ~80 min for full run at concurrency=4. Mean runtime 6.5s / graph.
 
## Stage 4 — Finalization
 
1. **Code cleanup**: removed unused weighted-selection path, unused geomean/selection score, unused `tryRunCandidate` helper. File is ~610 lines, single-purpose.
2. **Determinism**: same input produces bit-exact identical output on 4/5 sample graphs; one (n=55) may differ in the 4th decimal due to budget cutoff behavior under scheduler variance. Aggregate score is stable across runs.
3. **Robustness**: global 25s budget cap ensures no single graph exceeds the 30s limit. All polish phases check the remaining time before starting.
4. **Breakage**: zero TLE, zero non-plane outputs, zero missing-metric rows across the full 499-graph set.
 
## Final architecture of `applyAgenticLayout` (v43)
 
```
1. Run candidate layouts in sequence:
   EdgeBalancer, Hybrid, AngleBalancer, AreaGrad, FaceBalancer, ReweightTutte.
   (Schnyder/CEGBfs/Tutte removed in v43 — won only 1.2% of graphs.)
2. For each successful candidate, generate 4 variants:
   base, +rot (best over 19 rotations of [0, π/2]),
   +rot+align (axis-snap after rotation), +align (axis-snap of base).
3. Select top-K variants by total score (K=1 for n>75, K=2 for 51-75, K=3 for n≤50).
4. Multi-start coarse polish from each top-K variant (8 directions, step ≈ 0.04·diag).
   Budget: 7s for n>75, 16s for 51-75, 22s for n≤50 (divided by K).
5. Re-rotate + re-align the polished result.
6. Fine-grained polish (step ≈ 0.015·diag → 0.001·diag).
7. Micro-polish (step ≈ 0.004·diag → 0.0003·diag).
8. Re-align, then:
   9.  Convexity repair (move reflex vertices toward face centroids).
   10. Micro-polish after convexity repair.
   11. Restart search (2-3 perturbations + polish, deterministic RNG seeded from graph hash).
   12. Orthogonality polish (axis-snap per-edge).
   13. Pair-vertex moves (stretch/compress/translate/scissor each edge).
   14. Settle polish (step 0.003·diag).
15. Iterative rot/align/polish loop (up to 3 iters; break on no improvement).
16. Wide-step escape polish (single-vertex moves at 0.15·diag to catch leap-frog improvements), followed by re-fine.
17. Output the highest-scoring plane result found.
    (Bottleneck-metric polish, briefly added in v36, removed in v43 — never produced a winner.)
```
 
Removed in v28: dedicated edgeRatio repair pass (redundant — never improved on top of the full pipeline).
Budget cap raised from 25s to 28s in v41 (mean runtime 12s, max 28s, zero TLE observed).
 
Global wall-clock budget of 25 s guards every phase. Each phase only runs if ≥0.3–1.5 s remains. All moves check planarity; only accepted if the 10-metric mean improves. The RNG used for restart perturbations is seeded deterministically from `(nodeIds, edgePairs)` so the same graph always produces the same output.
 
## Intermediate score (v12, before Stages 5–10)
 
**planar_train.dot, 499 graphs, 30 s/graph timeout, 4-way concurrency.**
 
| algo | total |
|---|---|
| EdgeBalancer (baseline) | 0.6222 |
| Hybrid (baseline) | 0.5965 |
| agentic v12 | 0.7435 (+0.121 over EB) |
 
Stages 5–31 added another +0.006 of improvement, for a **final score of 0.7492** (v43, budget=28s, zero TLE, zero breakages).
 
## What did not work
 
- **Extra candidate layouts** (Schnyder, CEGBfs, Tutte): never selected per-graph because their total score is too low; had no effect on the ensemble.
- **Geometric-mean selection**: doesn't change the p50-across-graphs per metric; slight regression.
- **Metric-weighted polish** (boost weak metrics' gradient): created one TLE without net gain.
- **Selection by `min + α·mean`**: not tried formally, but the experiments above suggest it wouldn't help since the candidates' distributions don't cleanly dominate each other per metric.
 
## Stages 5–8 — incremental refinements
 
Continued development after v12. All stages preserve zero TLE / zero breakages.
 
| version | description | total | Δ vs prev |
|---|---|---|---|
| v12 (prev final) | multi-start + coarse/fine/micro polish + re-align | 0.7435 | — |
| v13 | + convexity repair (move reflex vertices toward face centroid) | 0.7441 | +0.0006 |
| v14 | + edgeRatio repair (extend shortest edges outward) | 0.7441 | +0.0000 |
| v15 | + orthogonality polish (axis-snap non-axial edges) | 0.7455 | +0.0014 |
| v16 | + restart search (2–3 perturb-and-repolish iterations, deterministic RNG) | 0.7466 | +0.0011 |
| v17 | + pair-vertex moves (both endpoints of each edge moved simultaneously: stretch/compress/translate/scissor) | 0.7475 | +0.0009 |
| v18 | + iterative rot/align/polish loop (2-3 iterations at the very end) | 0.7485 | +0.0010 |
| v19 | + force Schnyder:base into polish top-K (n≤50) | 0.7483 | -0.0002 (reverted) |
| v20 | + larger perturbation restarts (scales up to 0.25·diag) | 0.7480 | -0.0005 (reverted) |
| v21 | + wide-step escape polish (single-vertex moves at 0.15·diag step + re-fine) | 0.7487 | +0.0002 |
| v22 | + simulated-annealing polish (late-stage, temp=0.008, cool=0.45) | 0.7487 | 0.0000 (reverted) |
| v23 | v21 with SA removed for code cleanliness — unchanged score | 0.7486 | ≈0 |
| v24 | + per-vertex adaptive step (try multiple step scales per vertex per pass on fine/micro polish, n≤35) | 0.7484 | -0.0002 (reverted) |
| v23 | the v23 state after SA and adaptive-step experiments; matches v21 in structure | 0.7486 | final (prior) |
| v25 | + Lloyd face-centroid relaxation polish | 0.7485 | -0.0001 (reverted) |
| v26 | + re-seed EdgeBalancer with polished positions | 0.7486 | 0.0000 (reverted) |
| v27 | + edge-rotation polish (rotate pair around midpoint) | 0.7484 | -0.0002 (reverted) |
| v28 | removed edgeRatio repair (ablation — always +0 in isolation) | 0.7489 | +0.0003 |
| v29 | further ablation — also removed convexity repair | 0.7479 | -0.0010 (reverted) |
| v30 | v28 config, confirmed score | 0.7488 | same as v28 |
| v31 | ablate pair-vertex moves | 0.7483 | -0.0005 (reverted) |
| v32 | ablate wide-step escape | 0.7481 | -0.0007 (reverted) |
| v33 | increase multi-start K (3→5 for n≤25, 3→4 for n≤50) | 0.7472 | -0.0016 (reverted) |
| v34 | increase coarse polishPasses (5→7, 4→5) | 0.7481 | -0.0007 (reverted) |
| v35 | ablate restart search | 0.7471 | -0.0017 (reverted) |
| v36 | + bottleneck-metric polish (weight=4 on weakest metric, max 0.002 total drop) | 0.7489 | +0.0001 |
| v37 | 2-stage bottleneck polish (weight 6 + finer weight 3) | 0.7489 | 0 (reverted to 1-stage) |
| v38 | + increase global budget 25s → 27s | 0.7490 | +0.0001 |
| v39 | budget 28.5s (max runtime 28.3s, zero TLE) | 0.7492 | +0.0002 |
| v41 | budget 28s — between 27.5s (0.7489) and 28.5s (0.7492) for safety margin | — | — |
| v43 | drop 3 weakest candidates (Schnyder/CEGBfs/Tutte, win <2%) + drop bottleneck polish (wins 0%) | 0.7492 | +0.0003 |
| v44 | ablate restart from v43 baseline | 0.7472 | -0.0020 (reverted, load-bearing) |
| v43 | data-driven ablation of never-winning tokens | 0.7492 | — |
| **simplified** | **rewritten for clarity (611 lines vs 1403); dropped pairMoves, orthPolish, wide-step; restored all 9 candidates; budget 25s** | **0.7471** | final — production |
 
### Stages 5–8 observations
 
1. **Targeted per-metric repair passes** (convexity, edgeRatio) individually added ≤0.001 each. Polish has largely absorbed their effect — the layouts are near local optima where reflex-vertex moves or edge-extensions mostly don't survive score comparison.
2. **Orthogonality axis-snap** for per-edge alignment added +0.0014. A little more productive than reflex repair because edges have a natural "snap target" (horizontal/vertical) that isn't naturally hit by the 8-direction polish.
3. **Restart/perturbation** (add small jitter, re-polish) added +0.0011. Most gains on small graphs where the budget permits 2–3 restarts. The perturbation scale (0.015–0.06 × diag) has to be small enough to mostly stay in good basins but big enough to occasionally escape.
4. **RNG determinism**: the perturbation RNG is seeded from the graph's canonical (nodeIds,edgePairs) hash, so the same graph always gets the same perturbations.
 
**Final cumulative improvement (v43, budget=28s): +0.127 over EdgeBalancer**, +0.153 over Hybrid.
 
| metric | EB | agentic v43 | Δ |
|---|---|---|---|
| angularResolution | 0.517 | 0.562 | +0.045 |
| aspectRatio | 0.904 | 0.999 | +0.095 |
| convexity | 0.200 | 0.500 | +0.300 |
| edgeLengthDeviation | 0.849 | 0.808 | -0.041 |
| edgeRatio | 0.413 | 0.415 | **+0.002** |
| edgeOrthogonality | 0.500 | 0.674 | +0.174 |
| face | 0.912 | 0.979 | +0.067 |
| nodeUniformity | 0.647 | 0.793 | +0.146 |
| alignment | 0.546 | 0.843 | +0.297 |
| spacing | 0.734 | 0.919 | +0.185 |
 
**9/10 metrics now beat EdgeBalancer**, including edgeRatio (which had regressed through v16). Only edgeLengthDeviation (-0.041) still below EB — this metric rewards having all edges the same length, which fundamentally conflicts with alignment/orthogonality (snapping to a grid makes some edges shorter than others).
 
## Stages 11–14 observations
 
After v18 (0.7485), four more exploration stages were tried. Only one added net score (v21: +0.0002):
 
- **Stage 11 (force Schnyder through polish)** — -0.0002. Schnyder's native layout has very high alignment but low everything else; polishing from it eats budget without producing a competitive layout. The fundamental issue: a layout that starts with edgeRatio ≈ 0.02 can't reach the EB basin via local moves — it's in a different topology of the score landscape.
- **Stage 12 (larger perturbation restarts, up to 0.25·diag)** — -0.0005. Large perturbations destroy the alignment structure that polish painstakingly builds; re-polishing can't fully recover because alignment is a discrete/greedy process, not a smooth gradient.
- **Stage 13 (wide-step escape polish, 0.15·diag single-vertex)** — +0.0002. Genuinely novel moves (large deterministic jumps, not random) do occasionally find leap-frog improvements; the best such move is usually one vertex "jumping over" a neighbor. Small but real gain.
- **Stage 14 (simulated annealing polish)** — 0.0000. Accept-worse with temp=0.008 didn't beat greedy improvement-only polish in the time available. Likely the landscape is smooth enough around v18's state that no barrier-crossing gives improvement.
 
**Stage 15 (per-vertex adaptive step polish)** — -0.0002. Trying multiple step sizes per vertex per pass costs too much budget for the marginal improvement on graphs where most vertices already converge at a single step. Pass-level step halving is enough.
 
**Conclusion**: the pipeline is near a wide, deep basin with ~0.749 ceiling. Future gains require either (a) more compute (longer polish budget per graph) or (b) qualitatively different candidate layouts that reach a genuinely different basin.
 
## Dead-end summary (Stages 11–15)
 
Five separate ideas, four of them didn't move the score:
 
| stage | idea | Δ | reason it didn't help |
|---|---|---|---|
| 11 | polish from Schnyder:base (force-include in top-K) | -0.0002 | Schnyder starts with edgeRatio ≈ 0.02; local polish can't reach EB basin |
| 12 | larger perturbation restarts (0.15–0.25·diag) | -0.0005 | big jitters destroy alignment; re-polish doesn't recover it |
| 13 | wide-step escape polish (0.15·diag single-vertex) | **+0.0002** | small genuine gain from leap-frog moves |
| 14 | simulated annealing polish (T=0.008, cool=0.45) | 0.0000 | landscape is smooth enough locally that accept-worse doesn't help |
| 15 | per-vertex adaptive step (multiple scales per vertex per pass) | -0.0002 | extra cost per vertex exceeds the benefit |
 
Only Stage 13 (wide-step) kept. Net gain of Stages 11–15: +0.0001 (0.7485 → 0.7486).
 
## Stages 16–19 observations
 
More structural explorations; most didn't help, but one ablation did.
 
| stage | idea | Δ | outcome |
|---|---|---|---|
| 16 | Lloyd face-centroid relaxation polish | -0.0001 | polish already finds these moves |
| 17 | re-seed EdgeBalancer with polished positions | 0.0000 | reseed rarely beats current best after re-optimization |
| 18 | edge-rotation polish (rotate pair around midpoint) | -0.0002 | conflicts with already-aligned edges |
| 19 | **ablate edgeRatio repair** (was 0 effect when added) | **+0.0003** | freeing ~2s budget per graph let other stages gain |
| 20 | additionally ablate convexity repair | -0.0010 | convexity repair still genuinely helps |
 
**Key finding**: budget is saturated. Adding a new stage usually costs budget elsewhere for no net gain. But *removing* a no-op stage (edgeRatio repair, which had been 0 when added on top of prior stages) lets other stages gain. Stage 19 validates that the pipeline can still improve via **intelligent budget reallocation**, not new moves.
 
Net gain of Stages 16–19: +0.0002 (0.7486 → 0.7488).
 
## Stages 20–28 observations
 
Exhaustive ablation confirmed every existing stage is load-bearing. Budget increase gave the only positive win.
 
| stage | idea | Δ | outcome |
|---|---|---|---|
| 20 | ablate convexity repair | -0.0010 | load-bearing — reverted |
| 21 | ablate pair-vertex moves | -0.0005 | load-bearing — reverted |
| 22 | ablate wide-step escape | -0.0007 | load-bearing — reverted |
| 23 | increase multi-start K | -0.0016 | each polish got less budget — reverted |
| 24 | more coarse-polish passes | -0.0007 | eats downstream budget — reverted |
| 25 | ablate restart search | -0.0017 | load-bearing — reverted |
| 26 | bottleneck-metric polish (weight=4) | +0.0001 | marginal gain, kept |
| 27 | 2-stage bottleneck polish | 0 | no gain over 1-stage, reverted |
| 28 | **global budget 25s → 28s** | **+0.0002** | **kept — the real win** |
 
**Takeaway**: the existing pipeline is tightly tuned; every stage contributes. No stage can be removed and no internal parameter improves. The only lever left was giving more wall-clock time. Max runtime 27.3s observed @ 27.5s budget, 28.3s @ 28.5s — scaling with budget. Chose 28s for a safety margin vs the 30s eval cap.
 
Net gain of Stages 20–28: +0.0003 (0.7488 → 0.7491).
 
## Stages 29–31 observations — data-driven ablation
 
Analyzed the winning-label CSV to discover:
 
1. **Candidate usage**: EdgeBalancer wins 68%, Hybrid 8%, AngleBalancer 9%, FaceBalancer 7%, ReweightTutte 4%, AreaGrad 3%. **Schnyder 0.2%, CEGBfs 0.4%, Tutte 0.6%** — nearly never. Dropped them.
2. **Late-stage token frequency** in winning labels:
   - `+micro` 98% (critical)
   - `+cvxpol` 80%
   - `+iterloop` 91%
   - `+cvx` 46%
   - `+orth` 34%
   - `+pair` 19%
   - `+wide` 13%
   - `+restart` 7% (still needed — ablating drops score -0.002)
   - **`+bot` 0%** — bottleneck polish from Stage 26 never produces a winner despite the small v38 improvement. Dropped.
3. **Initial variant frequency**: `rot` 41%, `rot+align` 37%, `base` 12%, `align` 9%. All four are useful; none can be dropped.
 
**Net gain Stages 29–31: +0.0004** (0.7488 → 0.7492). Data-driven ablation delivered more gain than all the creative new-algorithm stages combined.
 
## What could be tried next
 
After 18 versions, gains are down to +0.001 per stage. Remaining ideas:
 
- **Simulated annealing with accept-worse steps** (current restart only keeps improvements).
- **Face-area equalization pass**: move interior vertices toward face-centroids where allowed.
- **Polish from Schnyder's high-alignment layout** — currently ignored because its starting total is low, but with polish it could theoretically reach a very different basin with stronger alignment.
- **edgeLengthDeviation recovery**: the only remaining negative delta vs EB (-0.041). This metric rewards uniform edge lengths, which fundamentally conflicts with axis-snapping. Would need metric-weighted selection per graph.
- **Per-graph parameter tuning** via a small proxy score (e.g. pick step schedule based on graph density).
- **Timeout-dependent strategy**: with 60s budgets (vs 30s), polish would converge more fully; some of the "n>50 skip" heuristics could be relaxed.
 
 
 
 
 
 
 
 
## Stage 1 — Best-of-N ensemble + post-processing (v1)
 
**Implementation** (`static/js/layout-agentic.js`):
 
1. Run 4 candidate layouts in sequence: **EdgeBalancer**, **Hybrid**, **AngleBalancer**, **AreaGrad**.
2. For each candidate's output, generate 3 variants:
   - `base` — raw candidate output
   - `rot` — rotate positions around centroid to maximize total score over 19 angles ∈ [0, π/2]
   - `rot+align` — `rot` followed by `PlanarVibeAlignment.alignToAxisGreedy` (snaps nearly-aligned rows/columns)
3. Score each variant with the 10-metric evaluator (sum/10); pick highest-total that is plane.
4. Deterministic: starts from whatever `initializeMockCyPositions` seeded, which is already seeded by graph-dataset hash.
 
**Smoke test (50 graphs, 30s timeout):**
 
| algo | total | angRes | aspect | conv | eDev | eRatio | orth | face | nodeU | align | spacing |
|---|---|---|---|---|---|---|---|---|---|---|---|
| edgebalancer | 0.751 | 0.558 | 0.931 | 0.909 | 0.941 | 0.726 | 0.500 | 0.948 | 0.684 | 0.495 | 0.821 |
| **agentic v1** | **0.783** | 0.577 | 0.965 | 0.955 | 0.929 | 0.718 | 0.529 | 0.953 | 0.761 | **0.634** | 0.807 |
 
Δ vs EB on the subset: **+0.032**. Wins come primarily from `alignment` (+0.14 from rot+align post-processing), `nodeUniformity`, `aspectRatio`, `convexity`. The subset is easier than the full training set (EB scores 0.751 there vs 0.622 on full), so absolute numbers don't transfer linearly; relative lift should.
 
**Full planar_train (499 graphs, 30s timeout, 4-way concurrency):**
 
| algo | total | angRes | aspect | conv | eDev | eRatio | orth | face | nodeU | align | spacing |
|---|---|---|---|---|---|---|---|---|---|---|---|
| edgebalancer | 0.622 | 0.517 | 0.904 | 0.200 | **0.849** | **0.413** | 0.500 | 0.912 | 0.647 | 0.546 | 0.734 |
| **agentic v1** | **0.655** | 0.556 | 0.962 | 0.286 | 0.831 | 0.347 | 0.547 | 0.927 | 0.684 | 0.668 | 0.739 |
 
**Net +0.033** vs EdgeBalancer. Wins: alignment (+0.12), convexity (+0.09), aspectRatio (+0.06), orth (+0.05). Losses: edgeRatio (-0.07), edgeLengthDeviation (-0.02). The losses come from rotation+alignment stretching short edges and the Hybrid/AngleBalancer candidates often producing uneven edge lengths.
 
**Conclusion:** Stage 1 beats both baselines. Clear weak spots to target in Stage 2:
- `convexity` = 0.286 (still lowest, biggest upside)
- `edgeRatio` = 0.347 (regressed from EB — need to protect)
- `angularResolution` = 0.556
 
