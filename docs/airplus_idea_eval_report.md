# AirPlus Idea Evaluation Report

Date: `2026-04-14`

Scope:
- evaluate the `AirPlus` improvement ideas from [airplus_edge_ideas.md](./airplus_edge_ideas.md)
- use `sample5` as the target case
- compare each prototype against:
  - input coordinates
  - plain `Air`
  - current `AirPlus` baseline

Raw data:
- [airplus_idea_eval_results.json](./airplus_idea_eval_results.json)

Experiment harness:
- [scripts/evaluate-airplus-ideas.mjs](/home/spupyrev/research/planar_layouts/planar-vibe/scripts/evaluate-airplus-ideas.mjs)

Important note:
- these were targeted prototypes, not polished production implementations
- the goal was to learn which directions are worth deeper work

## Baselines

Input drawing on `sample5`:
- face-area score: `0.8572`
- edge-length score: `0.9459`
- edge ratio: `0.1859`
- plane: `true`

Plain `Air` on `sample5`:
- face-area score: `0.8526`
- edge-length score: `0.9317`
- edge ratio: `0.0562`
- plane: `true`

Current `AirPlus` baseline:
- face-area score: `0.8029`
- edge-length score: `0.9180`
- edge ratio: `0.0335`
- plane: `true`

Takeaway:
- the current checked-in `AirPlus` is much worse than plain `Air` on `sample5`
- so the first job is not “make AirPlus slightly better”
- it is “get AirPlus back onto a good path at all”

## Summary Table

| Variant | Plane | Face Score | Edge Score | Edge Ratio | Verdict |
|---|---:|---:|---:|---:|---|
| Current `AirPlus` | yes | `0.8029` | `0.9180` | `0.0335` | bad |
| Idea 1: two-phase edge polish | yes | `0.8521` | `0.9417` | `0.1515` | promising |
| Idea 2: short original edges strongly | yes | `0.8029` | `0.9180` | `0.0335` | bad |
| Idea 3: hinge penalty on short edges | yes | `0.8173` | `0.9177` | `0.0335` | bad |
| Idea 4: face-slack trust region | yes | `0.8029` | `0.9180` | `0.0335` | bad |
| Idea 5: local face-area guard | yes | `0.8029` | `0.9180` | `0.0335` | bad |
| Idea 6: dummy edges by role | yes | `0.8029` | `0.9180` | `0.0335` | bad |
| Idea 7: ignore internal dummy structure | yes | `0.8029` | `0.9180` | `0.0335` | bad |
| Idea 8: focus on worst edges only | yes | `0.8029` | `0.9180` | `0.0335` | bad |
| Idea 9: mean-target ablation | yes | `0.8029` | `0.9180` | `0.0335` | bad |
| Idea 10: lexicographic acceptance | yes | `0.8029` | `0.9180` | `0.0335` | bad |

## Per-Idea Findings

### Current AirPlus baseline

Result:
- much worse than plain `Air`
- edge ratio drops from `0.0562` (`Air`) to `0.0335`
- face score also drops significantly

Interpretation:
- current `AirPlus` is not a useful baseline on `sample5`
- it appears to be trapped in a bad local basin and/or overreacting to the mixed edge term

### Idea 1. Two-phase optimization: Air first, then edge polish

Prototype behavior:
- run the stable Air-like phase first
- then run a light post-pass that tries to improve short original edges
- only keep moves that preserve local face feasibility and improve the local short-edge objective

Result:
- face score: `0.8521`
- edge-length score: `0.9417`
- edge ratio: `0.1515`
- plane: `true`

Interpretation:
- this is the only idea that clearly worked
- it recovered almost all of plain `Air`’s face quality
- it improved edge ratio into the target neighborhood for `sample5`

Why it likely worked:
- it separated the two goals instead of forcing one scalar local objective to do everything
- the edge-improvement step acted after the layout already had a reasonable face-area structure

Status:
- most promising next direction

### Idea 2. Only penalize short original edges strongly

Prototype behavior:
- turned up short-edge pressure
- reduced long-edge and dummy-edge influence

Result:
- no measurable change from the bad current `AirPlus` basin

Interpretation:
- simply reweighting the one-phase mixed objective is not enough
- stronger pressure alone did not redirect the optimizer

### Idea 3. Use a hinge penalty on short edges

Prototype behavior:
- switched the edge term to a one-sided penalty on short edges

Result:
- face score improved a little over current `AirPlus`
- edge ratio did not improve at all

Interpretation:
- a better penalty shape by itself is still not enough inside the current local solve
- again, the optimization appears stuck in the same basin

### Idea 4. Face-preserving trust region

Prototype behavior:
- reduced step size when nearby triangles had less area slack

Result:
- no measurable change from current `AirPlus`

Interpretation:
- good as a safety mechanism
- not useful as a primary edge-quality driver on its own

### Idea 5. Local face-area deviation constraint

Prototype behavior:
- rejected candidate moves that worsened local face-area error too much

Result:
- no measurable change from current `AirPlus`

Interpretation:
- helpful as a guardrail
- not sufficient to create better edge layouts by itself

### Idea 6. Weight dummy edges separately by role

Prototype behavior:
- distinguished dummy edges touching original vertices from dummy-only edges

Result:
- no measurable change from current `AirPlus`

Interpretation:
- dummy-edge weighting alone is too weak a lever
- likely still worth keeping as a detail inside a better overall method

### Idea 7. Ignore internal dummy structure after initialization

Prototype behavior:
- removed internal dummy edges from the edge objective

Result:
- no measurable change from current `AirPlus`

Interpretation:
- this idea did not help by itself
- likely because the one-phase optimizer was already stuck before dummy influence mattered

### Idea 8. Optimize only the worst edges each sweep

Prototype behavior:
- concentrated edge weight on the shortest initial original edges

Result:
- no measurable change from current `AirPlus`

Interpretation:
- focus selection alone is not enough if the underlying move-selection rule stays the same

### Idea 9. Use quantile/robust targets instead of mean targets

Prototype behavior:
- ablated the current quantile target back to a mean target for comparison

Result:
- no measurable change from current `AirPlus`

Interpretation:
- target statistic choice is not the bottleneck here
- the current bad behavior is dominated by the solve path, not by whether the target is mean or quantile

Important note:
- current `AirPlus` already includes a quantile target, so this experiment was really an ablation
- the result says “quantile vs mean is not the decisive issue on sample5”

### Idea 10. Lexicographic acceptance

Prototype behavior:
- tried to prefer edge-improving moves while allowing only limited face-quality degradation

Result:
- no measurable metric improvement
- status became `deadlock`

Interpretation:
- the prototype version was too weak to escape the same basin
- but the basic idea is still conceptually sound
- it may need a better candidate generator, not just a different accept/reject rule

## What Worked

Only one direction clearly worked:

1. Two-phase optimization.
- first get a good face-area drawing
- then run a dedicated edge-improvement pass

This was the only idea that:
- stayed plane
- preserved face score near plain `Air`
- materially improved edge ratio

On `sample5`, it moved:
- edge ratio from `0.0562` (`Air`) to `0.1515`
- edge-length score from `0.9317` to `0.9417`
- while keeping face score essentially the same as plain `Air`

## What Did Not Work

These ideas did not produce useful gains by themselves in the current solver shape:
- stronger short-edge weighting
- one-sided hinge penalty
- trust-region scaling
- local face-area guard
- dummy-edge role weighting
- ignoring internal dummy structure
- worst-edge subset focus
- target-statistic changes
- lexicographic acceptance alone

Common pattern:
- these are all still variants of “change the one-phase local objective/acceptance rule a bit”
- on `sample5`, they all stayed in the same poor basin

## Main Conclusion

The dominant lesson from this pass is:

`AirPlus` should not try to become an edge optimizer by only perturbing the existing one-phase Air local step.

That approach was consistently ineffective.

The best path forward is:
- keep the stable Air phase for face-area quality
- then add a separate, carefully guarded edge-improvement phase

In other words:
- goal separation works
- coefficient tweaking does not

## Recommended Next Steps

1. Build a production-quality version of Idea 1.
- Keep the two-phase structure.
- Add stronger local face guards.
- Add explicit plane checks only at accepted moves, not in every tiny inner trial.

2. Fold in the best “supporting” ideas into that second phase.
- dummy-edge role weighting
- one-sided short-edge objective
- local face-area guard

3. Keep the main Air phase simple.
- do not keep adding more pressure terms to the same Newton step
- the experiments suggest that is not the right place to solve edge quality

## Bottom Line

For `sample5`, the targeted pass says:

- `Two-phase edge polish`: yes
- basically every one-phase Air objective tweak: no

That is the clearest actionable result from this evaluation.
