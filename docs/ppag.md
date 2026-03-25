Yes. The simplest serious alternative is:

## **Projected Area-Gradient Descent**

It is much simpler than both Air and the barycentric optimizer.

### Core idea

Work directly in vertex coordinates. Optimize a very simple energy:

[
E(x,y)=\sum_{f\in F}\left(\frac{A_f}{A^\star}-1\right)^2
;+;
\lambda \sum_{uv\in E}\left(\frac{|p_u-p_v|^2}{\ell_0^2}-1\right)^2
]

where:

* (A_f) = area of original bounded face (f)
* (A^\star) = target equal area
* second term is optional edge regularization
* outer-face vertices are fixed

Then do plain gradient descent, but **reject any step that makes a triangulation triangle nonpositive**.

That is it.

---

# Why this is much simpler

Compared with the two existing methods, this removes:

* barycentric weights
* LU solves
* adjoints
* Newton/Hessian machinery
* entropy formulas
* per-vertex special cases

You only need:

* triangle areas
* derivatives of triangle areas
* a line search with triangle-positivity checks

A student can implement it from scratch.

---

# Why it may still work well

Your two current methods are good because they do two things:

1. push face areas toward equality
2. try to stay in the valid planar embedding class

This simpler method does the same two things, just more directly:

1. use the gradient of face-area error
2. project onto the feasible region by backtracking until all triangulation triangles stay positive

So it has the right geometry, just with much less machinery.

---

# The actual algorithm

## Step 1: triangulate once

Triangulate the plane graph with noncrossing diagonals.

Let (T) be the triangulation.

Original face areas are computed as sums of triangulation triangle areas.

## Step 2: initialize

Use any valid planar straight-line drawing:

* your current seed
* Tutte
* whatever already works

Fix the outer face.

## Step 3: define the energy

Use

[
E = E_{\text{area}} + \lambda E_{\text{edge}}
]

with

[
E_{\text{area}}=\sum_f \left(\frac{A_f}{A^\star}-1\right)^2
]

and optionally

[
E_{\text{edge}}=\sum_{uv\in E} \left(\frac{|p_u-p_v|^2}{\ell_0^2}-1\right)^2
]

where (\ell_0^2) can be the initial average squared edge length.

## Step 4: compute the gradient

For each original face, distribute its area-error gradient to the vertices of the triangulation triangles inside it.

The triangle-area derivatives are trivial:

for triangle ((a,b,c)),

[
\frac{\partial \Delta}{\partial x_a}=\frac12(y_b-y_c),\quad
\frac{\partial \Delta}{\partial x_b}=\frac12(y_c-y_a),\quad
\frac{\partial \Delta}{\partial x_c}=\frac12(y_a-y_b)
]

[
\frac{\partial \Delta}{\partial y_a}=\frac12(x_c-x_b),\quad
\frac{\partial \Delta}{\partial y_b}=\frac12(x_a-x_c),\quad
\frac{\partial \Delta}{\partial y_c}=\frac12(x_b-x_a)
]

So the whole gradient is just accumulated local contributions.

## Step 5: take a gradient step

For interior vertices only:

[
p_v^{new}=p_v-\eta \nabla_v E
]

## Step 6: backtracking feasibility check

If any triangulation triangle has signed area (\le \varepsilon), shrink the step:

[
\eta \leftarrow \beta \eta
]

with (\beta\in(0,1)), say `0.5`, and retry.

Also accept only if energy decreases.

This is the key simplification: **planarity handling becomes one short backtracking loop**.

---

# Pseudocode

```text
repeat:
    compute all triangle areas
    compute original face areas
    compute E
    compute gradient g on interior vertices

    eta = eta0
    repeat:
        trial = current positions - eta * g
        if any triangulation triangle area <= eps:
            eta = beta * eta
            continue
        compute trial energy Etrial
        if Etrial < E:
            accept trial
            break
        eta = beta * eta
    until eta < etaMin

    stop if max move is tiny or energy improvement is tiny
```

That is basically the full method.

---

# Why this is 10x simpler

Because there are only 4 moving parts:

1. triangulation bookkeeping
2. area computation
3. gradient accumulation
4. backtracking line search with positivity check

No hidden coordinate system, no factorization, no local Newton, no dual pressures.

---

# Will it be as good?

Honest answer: probably **not always**, but it may be **surprisingly close**.

My guess is:

* on easy and medium instances: probably close
* on hard instances: somewhat worse than Air
* but much easier to stabilize and maintain

And because it is so simple, you can cheaply add small improvements.

---

# The two simplest upgrades

If the plain version is not quite enough, add only these:

## 1. Momentum

Use

[
v_{t+1}=\mu v_t-\eta \nabla E,\qquad p_{t+1}=p_t+v_{t+1}
]

This often helps a lot, and is still trivial.

## 2. Vertex normalization

Clip the gradient or normalize very large vertex moves so one bad face does not throw the layout.

Still simple.

---

# A second simple option

If you want something even more “student-friendly” than gradient descent:

## **Local Pressure Relaxation**

For each original face define pressure

[
p_f = \frac{A^\star-A_f}{A^\star}
]

For each interior vertex, move it by the sum of incident face pressure gradients:

[
\Delta p_v = \sum_{f\ni v} p_f \nabla_v A_f
]

Then do one damped step and reject if any triangulation triangle flips.

This is basically a stripped-down Air without entropy, Hessian, or Newton. Just first-order local pressure balancing.

It may be even easier to code than full gradient descent.

---

# My recommendation

If your goal is:

* **much simpler**
* **still good**
* **student-reimplementable**

I would try this first:

## **Planar Projected Area Gradient (PPAG)**

That would be my name for it.

Pipeline:

1. triangulate
2. initialize with any valid drawing
3. minimize area variance in coordinates
4. reject any step that flips a triangulation triangle
5. stop when motion and improvement are tiny

---

# Ideas for SIMPLICITY AND QUALITY improvements

Items tagged `[TAKEN]` were adopted into the current PPAG after full-benchmark comparison.
Items tagged `[TAKEN via ...]` are covered by an earlier accepted change.

## 1) How to make it simpler

### A. Collapse the stopping logic to 3 rules [TAKEN]

Right now you have:

* global/rms area target,
* gradient threshold,
* small-move + small-improvement patience,
* plateau window + plateau patience. 

That is the biggest avoidable complexity. Replace all of it with:

* stop if `maxRelError <= tolAreaGlobal`
* stop if `acceptedCount === 0` in a full sweep
* stop if `iter === maxIters`

This lets you delete:

* `computePlateauProgress`
* `updateStallCounters`
* `classifyPPAGState`
* `tolGrad`, `moveTolRel`, `moveTolAbs`, `energyTolRel`, `energyTolAbs`, `patience`, `plateauWindow`, `plateauPatience`, `plateauObjTolAbs`, `plateauObjTolRel` from the public option surface. 

That is a large simplicity win with little practical loss.

### B. Make `state` triangle-only [TAKEN]

`computePPAGState` currently does two jobs:

* compute residual/objective,
* optionally build a full gradient map and max gradient norm. 

But your step computation only needs:

* current residuals,
* local incident geometry for the current vertex. 

So simplify `state` to:

* `objective`
* `residuals`
* `maxRelError`
* `rmsRelError`

Drop `gradient` and `maxGradNorm` entirely. That removes `createGradientMap` from the main flow and makes `computePPAGState` much easier to explain. 

### C. Inline “trial move” instead of copying all positions [TAKEN]

`buildVertexTrialPosition` clones the whole position map for every trial step. 

For simplicity and speed, do this instead:

* save old `(x,y)`
* write tentative `(x,y)` directly into `posById[vertexId]`
* test positivity / objective
* keep or revert

That removes one helper and a lot of object churn. It also fits incremental UI just fine, since you only publish after accepted moves or after a sweep.

### D. Separate “solver core event” from UI/runtime event [TAKEN]

`solvePPAG` currently knows too much about reporting shape: `onIteration`, `onStepComplete`, renderer yield decisions, move stats payload size. `applyPPAGLayout` also wraps that again. 

Keep incrementality, but reduce the interface to one callback:

* `onSweep({ iter, positions, objective, maxRelError, acceptedCount })`

Then let `applyPPAGLayout` adapt that to the renderer/UI. Same behavior, smaller mental model.

### E. Reduce options to a short “control panel” [TAKEN]

The real core knobs are only:

* `maxIters`
* `maxVertexMoveRel`
* `localDamping`
* `stepShrink`
* `minStepScale`
* `tolAreaGlobal`
* `renderEvery` / `yieldEvery` / `delayMs` for UI 

Everything else is advanced noise. Even if you keep internal defaults, don’t expose them all.

### F. Remove dead-feeling option: `initialMoveRel` [TAKEN]

I do not see `initialMoveRel` actually used in the solver. If that’s correct, delete it. 

## 2) How to improve quality without hurting simplicity much

### A. Add one tiny regularizer: stay near seed positions

Best quality-per-complexity improvement.

Right now the objective is only area equalization of augmented triangles. 
That can overreact to dummy structure and produce ugly drift.

Add:

* `lambdaDisp * ||p_v - p_v^0||^2`

Only for movable vertices, with small `lambdaDisp`.

Why this is good:

* very simple mathematically,
* very easy to explain,
* stabilizes intermediate drawings,
* reduces ugly vertex wandering,
* helps when augmentation dummies distort the target.

Implementation-wise, it only changes the local 2×2 solve:

* add `lambdaDisp` to diagonal
* add `-lambdaDisp * (current - seed)` to the RHS

So complexity barely changes.

### C. Use a better vertex order each sweep [TAKEN]

Current order is fixed by `movableVertices`. 
That makes the solver order-dependent.

Simple fix:

* at start of each sweep, sort vertices by max incident `|residual|`, descending.

This gives you:

* faster visible early improvement,
* better intermediate UI states,
* often fewer sweeps.

It only needs one cheap per-vertex score computed from existing residuals.

### D. Use local objective for accept/reject, not full global objective

Currently each candidate move recomputes full `computePPAGState(...)` just to decide acceptance. 

You can improve both simplicity-of-behavior and efficiency by using only incident triangles of the moved vertex for trial evaluation:

* old local energy from incident triangles
* new local energy after tentative move
* accept if local energy decreases and positivity holds

Then do one full recomputation at end of sweep for reporting/UI.

This is a strong change, but still simple because it matches the local step model. It also makes intermediate behavior more responsive.

Caveat: it is a slightly greedier approximation than full global acceptance. In practice here I’d expect it to be fine because only incident triangles change when one vertex moves in a triangulation.

### E. Add a very cheap anti-skinny term only if needed

If you want one more quality term beyond displacement, use something minimal like:

* penalty for incident triangles whose area drops close to `tolAreaPositive`
* or penalty for very short edge lengths around moved vertex

I would **not** add full angle optimization. Too much complexity.
Displacement regularization gives better quality-per-complexity.


Agreed — if the seed positions are random, anchoring to them is the wrong bias.

The good news is you can still improve quality with **local, geometry-only** changes that fit your current incremental solver very naturally.

## Best replacements for the seed-position idea

### 1. Add a **shape regularizer**, not a position regularizer

Your current objective is only triangle area equalization. That is why it can create skinny or awkward triangles even when area residuals improve. The current residual/energy is purely area-based. 

The simplest good addition is a **small anti-skinny penalty** on incident triangles of the moved vertex.

Two practical versions:

**Option A: edge-length balance inside each triangle**
For each incident triangle, add a small penalty like:

* `(maxEdge² / minEdge² - 1)`
  or a smoother variant based on pairwise edge-length differences.

**Option B: altitude floor / compactness**
For each incident triangle, add a small penalty that grows when

* `area / (sum edge²)` gets too small.

I would choose **B**. It is closer to “avoid slivers” and needs no global reference drawing.

Why this is attractive:

* local only,
* no dependency on initial positions,
* same accept/reject structure,
* easy to evaluate only on incident triangles.

### 2. Update vertices by **worst local error first** [TAKEN via 2C]

Right now the per-vertex move is already based on incident triangle residuals. 
So the cheapest quality improvement is to reorder vertices each sweep by something like:

* `max |residual|` over incident triangles, or
* sum of squared residuals over incident triangles.

That improves intermediate UI states a lot:

* the worst regions get fixed first,
* each sweep looks more purposeful,
* very little extra code.

This is one of the highest quality-per-complexity changes.

### 3. Treat dummy vertices as second-class citizens

Since the optimization is on augmented triangles, dummy structure can steer the result too much. Your code already distinguishes augmented/dummy info in setup/reporting. 

A very simple quality improvement:

* sweep original movable vertices first,
* sweep dummy vertices after,
* or sweep dummy vertices every other iteration.

That usually improves visible quality without complicating the solver much.

## Simple quality improvements I’d actually recommend

If you want the smallest changes with the best payoff, I’d do these three:

### A. Add a tiny local compactness term

Keep area equalization as primary, but accept a move based on:

* `localEnergy = areaEnergy + λ * shapeEnergy`

where `shapeEnergy` is computed only on incident triangles.

Use a very small `λ`, just enough to discourage slivers.

This barely changes the design:

* `computeLocalDelta(...)` stays the same structure, still a 2×2 local step built from incident triangles. 
* `incidentTrianglesStayPositive(...)` stays as-is. 
* backtracking stays as-is.
* only trial scoring changes.

Even easier: don’t put the shape term into the linearized solve at first. Just use it in **accept/reject**. That is simpler than differentiating it immediately.

### B. Sort vertices each sweep by local badness [TAKEN via 2C]

This is almost free and improves both intermediate and final quality.

Use:

* `score(v) = max |residual|` of incident triangles

Then process high-score vertices first.

### C. Slow down dummy vertices

Very low-complexity, often high benefit.

Example policy:

* every sweep: original vertices
* every 2nd sweep: dummy vertices

## Simplicity improvements that still fit your UI constraint

Since you must stay incremental, I’d simplify in ways that do **not** change that architecture:

### 1. Remove gradient-based stopping entirely [TAKEN via 1B]

You compute a global gradient map and max gradient norm in `computePPAGState(...)`, but the core move already uses only local incident data. 
This is the easiest chunk to remove.

Then `computePPAGState(...)` becomes just:

* residuals
* objective
* maxRelError
* rmsRelError

Much simpler.

### 2. Remove plateau/stall machinery [TAKEN via 1A]

`classifyPPAGState(...)` and the related counters/options are a lot of complexity for limited value. 

Use only:

* success if `maxRelError <= tol`
* stalled if a whole sweep accepts no moves
* otherwise continue until `maxIters`

That is enough for an incremental UI algorithm.

### 3. Trial moves should be in-place + revert [TAKEN via 1C]

`buildVertexTrialPosition(...)` copies the full position map for each trial step. 
That is both more code and more churn than needed.

Simpler:

* save old `(x,y)`
* write tentative `(x,y)`
* test positivity / trial energy
* keep or restore

That preserves your incremental reporting model perfectly.
