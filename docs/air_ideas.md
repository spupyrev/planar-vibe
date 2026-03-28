# Air Optimization Ideas

## Goals

1. Simplicity of the code
2. Speed of the algorithm
3. Quality of results

## Baseline

Current baseline is the fresh `report-data.csv` / `report.html` run from this session.

Observed baseline issues:
- `Air` times out on `planar3tree100`
- `Air` times out on `oct174`

## Candidate Ideas

1. Remove per-candidate global crossing checks during local line search.
   Hypothesis: this is the biggest hot spot. Keep only augmented-triangle feasibility inside the sweep and one final original-graph crossing check at the end.

2. Skip crossing checks for accepted sweeps unless some vertex actually moved by more than a meaningful threshold.

3. Fuse the initial `evaluateLocalState(...)` call in the sweep with the first iteration of `solveBalancedPosition(...)` to avoid duplicated work.

4. Precompute static local edge geometry for each incident triangle entry, so `evaluateLocalState(...)` does less object chasing.

5. Replace small `{x,y}` object churn in hot loops with scalar locals.

6. Cache per-vertex incident entry arrays and lengths in a more compact structure.

7. Reorder vertices each sweep by last known force / local error so hard vertices are fixed first.

8. Stop sweeping vertices whose local force has stayed below threshold for several rounds.

9. Add a cheap active-set: if a move only perturbs nearby faces slightly, revisit only affected vertices first.

10. Reduce default `maxNewtonIter` if line search almost always stops much earlier.

11. Tighten Newton damping / fallback so fewer rejected backtracking attempts are tried.

12. Replace entropy Armijo with a cheaper local accept test if the quality impact is small.

13. Compute original-face errors incrementally rather than recomputing every face sum each sweep.

14. Remove or simplify plateau/stall machinery if it is not helping runtime or quality enough.

15. Early-stop on large graphs using a looser tolerance schedule, then optionally polish only if the face score is still poor.

16. Use a two-phase mode: fast coarse Air sweeps, then a short polish phase.

17. Use a better seed only for the graphs that currently time out, if this materially reduces Air iterations without complicating the core too much.

18. Batch several vertex updates before recomputing expensive global stats.

## Experiment Log

### Idea 1. Remove per-candidate global crossing checks during local line search

Status: kept

Reason:
- In the current Air sweep, each local step tries candidate positions and calls a full original-graph crossing check inside the backtracking loop.
- This is likely much more expensive than the local triangle-feasibility test.
- If augmented triangulation positivity already preserves planarity of `H`, then the repeated original-graph crossing checks are probably redundant inside the sweep.

Keep criteria:
- Significant speedup, ideally enough to eliminate or reduce current TLEs.
- No major quality regression on average.
- Code should get simpler, not more complex.

Conclusion:
- Keep.
- Code became simpler: the inner backtracking loop now accepts locally feasible candidates directly and leaves the original-graph crossing check to the final result.
- Full-benchmark result versus the previous Air baseline:
  - runtime: `896850.134 ms -> 72760.268 ms` (`-91.89%`, about `12.3x` faster)
  - face total: `17.915278817814 -> 19.890296284922` (`+11.02%`)
  - edge total: `18.424592958741 -> 20.333874463444` (`+10.36%`)
  - success count: `20/22 -> 22/22`
- The two previous TLEs disappeared:
  - `planar3tree100`: `TLE -> ok`
  - `oct174`: `TLE -> ok`
- On the previously successful cases, reported face/edge scores stayed unchanged.

### Idea 3. Reuse local state between sweep setup and Newton iterations

Status: kept

Reason:
- The sweep already computes `currentState` for each movable vertex before calling `solveBalancedPosition(...)`.
- The Newton solver then immediately recomputes the same local state at the current position.
- After accepting a Newton trial, the solver also recomputes that accepted state at the start of the next Newton iteration.
- Reusing that state is simple and keeps the solver math unchanged.

Conclusion:
- Keep.
- Code impact is modest: `solveBalancedPosition(...)` now accepts optional `entries` and `initialState`, and it carries forward the accepted `qState` instead of recomputing it immediately.
- Full-benchmark result versus the Idea 1 baseline:
  - runtime: `72760.268 ms -> 60569.223 ms` (`-16.76%`)
  - face total: unchanged at `19.890296284922`
  - edge total: unchanged at `20.333874463444`
- success count: unchanged at `22/22`
- This is a clean speed win with no measured quality regression.

### Idea 15. Reduce default `maxSweeps`

Status: dropped

Reason:
- Many of the remaining slow Air runs still end with `status max_sweeps`.
- Lowering the default sweep budget is a very simple way to probe whether late iterations are mostly wasted work.

Conclusion:
- Drop.
- Tested change: reduce default `maxSweeps` from `200` to `120`.
- Full-benchmark result versus the Idea 3 baseline:
  - runtime: `60569.223 ms -> 34147.644 ms` (`-43.62%`)
  - face total: `19.890296284922 -> 19.638229826623` (`-1.27%`)
  - edge total: `20.333874463444 -> 20.328059335337` (`-0.03%`)
  - success count: unchanged at `22/22`
- The average face regression looks small, but it hides several material losses:
  - `sample5`: `-0.107917`
  - `grid2x20`: `-0.033395`
  - `oct174`: `-0.025987`
  - `randomplanar4`: `-0.023220`
  - `randomplanar1`: `-0.017131`
  - `planar3tree100`: `-0.013843`
- This is too much quality damage for a blanket default change.

### Idea 10. Reduce default `maxNewtonIter`

Status: kept

Reason:
- Air still spends a lot of time inside per-vertex Newton refinement.
- After Ideas 1 and 3, the remaining cost is more likely to come from repeated local Newton work than from bookkeeping.
- Lowering the default Newton budget is a simple change and is narrower than reducing whole sweeps.

Conclusion:
- Keep.
- Tested change: reduce default `maxNewtonIter` from `40` to `20`.
- Full-benchmark result versus the Idea 3 baseline:
  - runtime: `60569.223 ms -> 36114.491 ms` (`-40.37%`)
  - face total: effectively unchanged (`19.890296284922 -> 19.890296284074`)
  - edge total: effectively unchanged (`20.333874463444 -> 20.333874463392`)
  - success count: unchanged at `22/22`
- All observed score differences were at floating-point-noise scale.
- This is a very strong keep: much faster, simpler defaults, and no meaningful quality loss.

### Idea 5. Remove sweep-wide position-copy churn for move stats

Status: kept

Reason:
- Air copied the full position map at the start of every sweep only to compute movement stats afterward.
- After that scan, Air overwrote `maxMove` and `avgMove` with values it had already tracked during the sweep.
- The copy/scan was therefore mostly redundant and especially wasteful on large graphs.

Conclusion:
- Keep.
- Code is simpler: no per-sweep `copyPositions(...)`, no sweep-end full-graph move-stat recomputation.
- Full-benchmark result versus the Idea 10 baseline:
  - runtime: `36114.491 ms -> 31924.305 ms` (`-11.60%`)
  - face total: unchanged at `19.890296284074`
- edge total: unchanged at `20.333874463392`
- success count: unchanged at `22/22`
- This is another clean speed win with zero observed quality cost.

### Idea 11. Loosen the local Newton force tolerance

Status: kept

Reason:
- Even with `maxNewtonIter` reduced, Air may still spend too much time polishing a vertex beyond what the global objective can notice.
- The default `tolForceVertex = 1e-10` is extremely strict for an interactive/layout heuristic.

Conclusion:
- Keep.
- Tested change: raise default `tolForceVertex` from `1e-10` to `1e-8`.
- Full-benchmark result versus the Idea 5 baseline:
  - runtime: `31924.305 ms -> 16563.094 ms` (`-48.12%`)
  - face total: effectively unchanged (`19.890296284074 -> 19.890296285029`)
  - edge total: effectively unchanged (`20.333874463392 -> 20.333874463458`)
  - success count: unchanged at `22/22`
- This is another clear keep: much faster and no meaningful quality change.

### Idea 8. Loosen the sweep-level force threshold

Status: dropped

Reason:
- After loosening the local Newton tolerance, the sweep-level `tolForceGlobal` also looked suspiciously strict.
- If nearly balanced vertices were still entering the sweep loop, skipping them could have been a cheap win.

Conclusion:
- Drop.
- Tested change: raise default `tolForceGlobal` from `1e-8` to `1e-6`.
- Full-benchmark result versus the Idea 11 baseline:
  - runtime: `16563.094 ms -> 16246.376 ms` (`-1.91%`)
  - face total: unchanged
  - edge total: unchanged
- success count: unchanged at `22/22`
- The gain is too small to matter.

### Idea 11b. Loosen the local Newton force tolerance further

Status: kept

Reason:
- The first relaxation of `tolForceVertex` was a huge win with no quality loss.
- That strongly suggested the solver was still over-polishing local vertex balances.

Conclusion:
- Keep.
- Tested change: raise default `tolForceVertex` again from `1e-8` to `1e-6`.
- Full-benchmark result versus the Idea 11 baseline:
  - runtime: `16563.094 ms -> 9291.702 ms` (`-43.90%`)
  - face total: effectively unchanged (`19.890296285029 -> 19.890296283861`)
  - edge total: effectively unchanged (`20.333874463458 -> 20.333874463471`)
  - success count: unchanged at `22/22`
- This is another strong keep.

### Idea 10b. Reduce default `maxNewtonIter` further

Status: kept

Reason:
- After loosening `tolForceVertex`, the per-vertex Newton budget likely became even less necessary.
- The previous `20`-iteration cap still looked conservative.

Conclusion:
- Keep.
- Tested change: reduce default `maxNewtonIter` from `20` to `10`.
- Full-benchmark result versus the Idea 11b baseline:
  - runtime: `9291.702 ms -> 6969.204 ms` (`-25.00%`)
  - face total: `19.890296283861 -> 19.907493784028` (`+0.0865%`)
- edge total: `20.333874463471 -> 20.328633480108` (`-0.0258%`)
- success count: unchanged at `22/22`
- This is still comfortably inside the acceptable quality range and is worth keeping.

### Idea 10c. Reduce default `maxNewtonIter` to `5`

Status: dropped

Reason:
- After the successful `20 -> 10` reduction, it was worth checking where the Newton-iteration budget finally starts to hurt quality.

Conclusion:
- Drop.
- Tested change: reduce default `maxNewtonIter` from `10` to `5`.
- Full-benchmark result versus the Idea 10b baseline:
  - runtime: `6969.204 ms -> 5935.407 ms` (`-14.83%`)
  - face total: `19.907493784028 -> 19.913329222055` (`+0.0293%`)
  - edge total: `20.328633480108 -> 20.331750427355` (`+0.0153%`)
  - success count: unchanged at `22/22`
- The aggregate numbers are fine, but the per-graph behavior becomes uneven:
  - `grid2x20`: `0.888998 -> 0.869614` (`-0.019384`)
  - `randomplanar5`: `0.605663 -> 0.601681` (`-0.003981`)
  - `grid2x10`: `0.965022 -> 0.989901` (`+0.024879`)
- This is the point where the solver starts trading one ladder case against another, so `10` is the safer default.

### Idea 12. Remove the Armijo margin in local acceptance

Status: dropped

Reason:
- Once the local Newton budget is already small, the remaining line-search condition might just be needless conservatism.

Conclusion:
- Drop.
- Tested change: default `armijo` from `1e-4` to `0`.
- Full-benchmark result versus the Idea 10b baseline:
  - runtime: `6969.204 ms -> 7117.620 ms` (`+2.13%`, slower)
  - face total: unchanged
  - edge total: unchanged
  - success count: unchanged at `22/22`
- No benefit, so there is no reason to keep the change.
