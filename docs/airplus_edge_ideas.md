# AirPlus Ideas

Goal: improve `AirPlus` edge-length quality, especially edge-ratio / edge-length score, while keeping bounded-face areas approximately unchanged and the implementation simple.

## What We Know So Far

- `AirPlus` currently inherits Air's local Newton-like solver structure.
- The current area force law is one-sided:
  - small faces push strongly outward
  - large faces only push weakly
- Dummy triangles are still participating in the same objective as real triangles.
- On `sample5`, this can pin real boundary faces near the augmented outer cycle.

Two important concrete findings from debugging:

1. A tiny nonzero `edgeWeight` can change behavior dramatically.
- The reason is exact, not speculative:
- the edge term currently updates `force` and `entropy`
- but it does not update the local quadratic model coefficients `a,b,c`
- so the local Newton solve becomes inconsistent as soon as `edgeWeight > 0`

2. A naive symmetric area residual like `(area - targetArea) / targetArea` is too aggressive for the current solver.
- It can accept locally feasible moves that later create global geometric violations.
- So "just make oversized faces pull inward" is not safe in the current implementation.

Because of that, the most promising next ideas are the ones that:
- keep one combined objective
- keep the code simple
- and do not require a full redesign of the local Newton model

## Recommended Directions

### 1. Use gradient descent, not Newton, whenever the edge term is active

Idea:
- keep the current area-only Newton step when `edgeWeight = 0`
- but when `edgeWeight > 0`, stop using the `a,b,c` Newton solve
- instead use the actual combined local force as the search direction

Why it is promising:
- directly fixes the known inconsistency in the current implementation
- simple to implement
- preserves the existing line search / feasibility machinery

Why it may help:
- lets `AirPlus` use a real combined objective instead of a partially mismatched one
- avoids the dramatic "0 vs 0.000001" behavior we already observed

Main risk:
- first-order steps may be slower than Newton steps

This is the cleanest next experiment.

### 2. Use a smooth schedule for the edge term over sweeps

Idea:
- keep one combined objective throughout the run
- but start with small edge importance
- then gradually increase it over time

Example:
- sweep `0`: mostly face-driven
- later sweeps: edge term ramps up linearly or sigmoidally

Why it is promising:
- matches the intuition that early geometry is fragile
- lets the layout settle into a good planar basin before edge regularization becomes important

Why it may help:
- avoids the brittleness of a strong fixed edge term from the very first sweep
- keeps the implementation simple: just multiply the edge term by a sweep-dependent scalar

Main risk:
- if the edge term turns on too late, it may have no effect

### 3. Keep the old area force, but use a bounded inward correction on oversized real faces only

Idea:
- do not replace the old `targetArea / area` force
- add a second small correction term only for real faces that are much larger than target
- cap this correction so it cannot dominate the step

Why it is promising:
- keeps the existing stable area force law
- introduces just enough inward pressure to fight the "real faces pushed to outer boundary" problem

Why it may help:
- large real faces would no longer be nearly inert
- dummy faces would still keep their current barrier-like effect

Main risk:
- we already saw that naive inward terms can hurt both face score and edge ratio
- so the correction must be weak and explicitly capped

Practical note:
- this is only worth trying after fixing idea 1, because otherwise any nonzero edge-like correction still suffers from the solver inconsistency

### 4. Normalize real-face and dummy-face contributions by class totals

Idea:
- do not think only in terms of per-face weights
- set a total objective budget for:
  - real faces
  - dummy faces
- then divide that budget across faces in each class

Why it is promising:
- we already saw on `sample5` that there are far more dummy triangles than real ones
- so tiny per-face weights can still add up to a strong total dummy influence

Why it may help:
- makes the real/dummy tradeoff interpretable
- changing one slider really changes total influence, not just per-face influence

Main risk:
- if dummy total influence becomes too small, planarity support may weaken

This stays simple and directly targets a known problem.

### 5. Give dummy triangles a different objective role from real triangles

Idea:
- keep dummy triangles in the objective
- but do not ask them to match the same target-area rule as real triangles
- instead give them a mild regularizer such as:
  - stay positive
  - avoid becoming too tiny
  - avoid becoming too skinny

Why it is promising:
- the current issue is not just dummy weight
- it is that dummy faces are solving the same target-seeking problem as real faces

Why it may help:
- dummy triangles remain useful for geometric support
- but stop actively determining where real faces sit

Main risk:
- this is a somewhat larger change than ideas 1-4

This is still much simpler than a full redesign of Air.

### 6. Apply the edge objective only to original edges, with class-aware geometry support

Idea:
- compute edge-quality forces only on original graph edges
- let dummy structure influence the run only through face terms and feasibility checks

Why it is promising:
- the edge score we care about is defined on original edges
- dummy edges are scaffolding, not the product target

Why it may help:
- reduces fake incentives created by augmentation artifacts
- makes edge optimization line up with the metric we actually care about

Main risk:
- some weak dummy-edge support may still be useful for stability

This idea pairs well with ideas 2 and 4.

### 7. Use a one-sided short-edge penalty instead of a symmetric edge target

Idea:
- do not try to make every original edge match one common target
- only penalize original edges that are too short

Examples:
- hinge loss on short edges
- softplus penalty on short edges

Why it is promising:
- on bad outputs, the visual problem is often a handful of collapsed edges
- raising the minimum can improve the ratio without trying to "fix" already acceptable edges

Why it may help:
- aligns better with the actual edge-ratio goal
- simpler than modeling both short and long edges equally

Main risk:
- if only short edges are penalized, the drawing can drift unless face terms stay strong

This is a good fit for a simple combined objective.

### 8. Use a robust edge target, not a mean-like one

Idea:
- if we keep a target edge scale, make it robust
- use median or an upper quantile of original-edge lengths from the seed

Why it is promising:
- a robust target is less affected by a few already-bad edges
- it can bias the optimizer toward lifting the short-edge tail

Why it may help:
- gives the edge term a better reference scale without adding complexity

Main risk:
- if the target is too high, it can over-stretch the graph

This is a low-cost tuning direction, not a structural fix.

### 9. Give real outer-face vertices special treatment

Idea:
- real outer-face vertices are currently movable inside the fixed augmented outer cycle
- treat them differently from deep interior vertices

Possible simple variants:
- scale down dummy-face influence on real outer-face vertices
- partially anchor them to their initial positions
- only allow edge forces from original edges on those vertices

Why it is promising:
- the boundary problem is strongest exactly there
- we do not need the same rule for every vertex class

Why it may help:
- reduces the tendency of real boundary faces to get pinned against the dummy ring

Main risk:
- if anchoring is too strong, it can over-constrain the drawing

### 10. Use a cheap local geometric guard when inward/compressive terms are active

Idea:
- if we introduce any inward or compressive correction, add a small local geometry guard
- do not run a full global crossing test per candidate
- instead check nearby node-edge / edge-edge conflicts involving the moved vertex and its local dummy neighborhood

Why it is promising:
- we already diagnosed that the residual formulation failed via a tiny accepted move that created a dummy-node-on-edge event
- a local guard could catch that without the cost of a full global crossing test

Why it may help:
- makes future objective experiments safer
- directly targets the failure mode we actually observed

Main risk:
- local guards are easy to under-approximate if defined too narrowly

This is not itself an objective improvement, but it may unblock safer combined-objective experiments.

## Air Step Damping Ideas

These are specifically about replacing a hard move cap in `Air` with something smoother and more principled. They are not edge-objective ideas.

### A. Local geometry-aware cap

Idea:
- do not cap by a fixed fraction of outer-face diameter
- cap each vertex move by a local scale instead

Possible local scales:
- fraction of the shortest incident edge length
- fraction of the smallest altitude of an incident triangle
- minimum of those two

Why it is promising:
- cramped regions get protected automatically
- open regions can still move far
- much more closely tied to the geometry that actually breaks

Why it may help:
- keeps the stability benefit of damping
- avoids over-damping the whole graph because of one global scale

Main risk:
- local scales can be noisy on very irregular meshes

This is the cleanest direct replacement for a hard global cap.

### B. Smooth saturating damping

Idea:
- keep the proposed step direction
- but shrink large steps smoothly instead of clipping them at a hard threshold

Examples:
- `step *= 1 / (1 + ||d|| / s)`
- `step *= tanh(||d|| / s) / (||d|| / s)`

where `s` is a geometry scale

Why it is promising:
- no hard discontinuity
- easier to reason about as parameters vary
- very simple to implement

Why it may help:
- preserves small and medium steps almost exactly
- only softens unusually large steps

Main risk:
- still depends on choosing a good scale `s`

This is the simplest smoother alternative.

### C. Backtracking-derived damping

Idea:
- do not set a separate cap at all
- use the amount of backtracking already needed by the line search as the damping signal

Simple version:
- if a vertex repeatedly needs heavy backtracking, reduce future first-try step sizes for that vertex
- if a vertex usually accepts full steps, let it keep trying full steps

Why it is promising:
- uses information the solver already computes
- no extra geometry queries needed
- damping appears only where the solver is already struggling

Why it may help:
- avoids punishing easy vertices
- targets the actual unstable regions

Main risk:
- slightly more stateful
- per-vertex state must be managed carefully

This is a good adaptive option without much extra machinery.

### D. Trust-region radius per vertex

Idea:
- give each movable vertex a local radius
- proposed steps are limited by that radius
- radius grows after good accepted steps and shrinks after bad / stalled ones

Why it is promising:
- more principled than a fixed cap
- standard optimization idea
- adapts naturally to easy versus difficult regions

Why it may help:
- large safe moves remain possible
- unstable vertices get automatically damped

Main risk:
- more tuning and more state than the previous options

This is the most principled option, but not the simplest.

### E. Feasibility-margin damping

Idea:
- limit the step by how close incident triangles already are to degeneracy
- if the smallest incident area margin is small, damp more strongly
- if the local face margins are healthy, allow larger motion

Why it is promising:
- directly tied to Air’s real feasibility constraint
- does not depend on a global graph scale

Why it may help:
- protects exactly the vertices most likely to create local degeneracies
- still lets safe interior vertices move more freely

Main risk:
- only sees local area margins, not more global geometry issues

This is the most Air-specific damping rule.

## Lower-Priority Directions

These may still be useful later, but they are not the best next moves if we want simple code:

- full edge Hessian terms in the local quadratic model
- full lexicographic multi-objective acceptance
- a hard two-phase "Air then polish" pipeline
- completely removing dummy triangles from the objective

Why lower priority:
- they either add complexity
- or we already have evidence they are brittle in the current solver
- or they move away from the "single combined objective, simple implementation" goal

## Suggested Order

If we want to try ideas in a practical sequence, this is the best order:

1. Gradient step whenever the edge term is active.
2. Sweep-dependent edge-weight schedule.
3. Class-normalized real-vs-dummy face budgets.
4. Original-edges-only edge objective.
5. One-sided short-edge penalty.
6. Special handling for real outer-face vertices.
7. Dummy triangles with a different objective role.
8. Cheap local geometric guard for future inward-force experiments.

## What Success Should Look Like

For `sample5`, the target is not just "better edge ratio". A successful idea should:

- keep the drawing plane
- keep face-area score close to plain `Air`
- visibly stop real boundary faces from hugging the augmented outer ring
- improve edge ratio materially over the current bad `AirPlus` basin

If an idea only improves edge ratio by pushing real faces onto the boundary, it is not actually solving the right problem.
