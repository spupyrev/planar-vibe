# Improving Default Tutte Embeddings: A Re-Implementation Guide

## Scope

This note summarizes practical ways to improve a default Tutte embedding for a planar graph with a fixed outer face.

Assumptions:
- you already have a **plane embedding**
- you have chosen a **convex outer face polygon**
- you can solve the standard linear Tutte system for interior vertices
- you want a method that stays relatively simple and is suitable as an initialization for later post-processing

The emphasis is on **specific steps that can be implemented directly**.

---

## 0. Baseline: default Tutte

Let the graph be \(G=(V,E)\), with outer-face vertices fixed at positions \(p_b\in\mathbb R^2\), and interior vertices unknown.

For each interior vertex \(i\), standard Tutte uses

\[
p_i = \frac{1}{\deg(i)}\sum_{j\sim i} p_j.
\]

Equivalently,

\[
\sum_{j\sim i} w_{ij}(p_i-p_j)=0
\]

with \(w_{ij}=1\) for all incident edges.

This produces a straight-line planar drawing when the outer face is convex, but it often has a common defect:

- interior vertices bunch up
- central faces become tiny
- the drawing occupies the available area poorly

Everything below is about reducing that defect while keeping the overall framework simple.

---

## 1. Replace uniform weights

The first thing to change is the weight assignment.

### 1.1 General weighted Tutte system

For every interior vertex \(i\), solve

\[
\sum_{j\sim i} w_{ij}(p_i-p_j)=0,
\]

with all \(w_{ij}>0\).

In matrix form, for x- and y-coordinates separately:

\[
L(w) x = b_x, \qquad L(w) y = b_y,
\]

where:
- \(L(w)\) is the weighted Laplacian restricted to interior vertices
- boundary contributions are moved to the right-hand side

For an interior vertex \(i\):
- diagonal entry: \(L_{ii} = \sum_{j\sim i} w_{ij}\)
- off-diagonal entry: \(L_{ij} = -w_{ij}\) if \((i,j)\in E\)

For a boundary neighbor \(j\), add \(w_{ij}p_j\) to the right-hand side.

### 1.2 Recommendation hierarchy

Use one of these, from simplest to stronger.

#### A. Mean value coordinates (MVC)

This is a geometric upgrade over uniform weights.

For a vertex \(i\), let its neighbors in cyclic order be \(j_1,\dots,j_k\). Given a current drawing, define for neighbor \(j_m\):

\[
\widetilde w_{i j_m} = \frac{\tan(\alpha_{m-1}/2)+\tan(\alpha_m/2)}{\|p_i-p_{j_m}\|},
\]

where \(\alpha_m\) is the angle at \(p_i\) between rays toward neighbors \(j_m\) and \(j_{m+1}\).

Then normalize if you want barycentric coefficients:

\[
\lambda_{i j_m} = \frac{\widetilde w_{i j_m}}{\sum_r \widetilde w_{i j_r}}.
\]

For solving the weighted Laplacian, the unnormalized positive weights \(\widetilde w\) are enough.

Implementation notes:
- MVC depends on the current geometry, so it is not a one-shot purely combinatorial rule.
- A practical use is: start from uniform Tutte, compute MVC weights from that drawing, solve again.
- One or two iterations are usually enough if you use MVC only as a refinement.

Pros:
- easy drop-in upgrade
- always positive
- usually improves local face shape

Cons:
- still harmonic in spirit
- usually does not fix strong global collapse by itself

#### B. Distance-based reweighting

This is the simplest practical upgrade that directly targets crowding.

Use current edge lengths and define

\[
w_{ij} = \frac{1}{(\|p_i-p_j\|+\varepsilon)^\alpha},
\]

with typical choices:
- \(\alpha \in [0.5, 2]\)
- \(\varepsilon\) small, e.g. \(10^{-6}\) times the drawing diameter

Recommended default:

\[
w_{ij} = \frac{1}{\|p_i-p_j\|+\varepsilon}.
\]

Interpretation:
- short edges get larger weights
- this changes the next harmonic solve so compressed regions react more strongly

Implementation notes:
- solve once with uniform weights
- compute new weights from current geometry
- solve again
- repeat 2 to 5 times
- clamp weights to a bounded range for stability, e.g.
  - \(w_{ij} \leftarrow \min(w_{\max}, \max(w_{\min}, w_{ij}))\)

Typical bounds:
- \(w_{\min}=10^{-3}\)
- \(w_{\max}=10^3\)

Pros:
- extremely simple
- usually more useful than BFS-depth weights
- integrates directly into an existing Tutte solver

Cons:
- still not a true global optimization method
- can overreact without damping or clamping

#### C. Structure-aware weights

The main idea is:

> weights should reflect how much graph mass lies in a certain direction.

This is the most promising structural improvement.

##### Special case: plane 3-trees

For plane 3-trees, use the recursive decomposition.

If a vertex \(v\) was inserted into triangle \((a,b,c)\), its three child regions have sizes \(s_a,s_b,s_c\), where:
- \(s_a\): size of the region opposite \(a\), inside triangle \((v,b,c)\)
- similarly for \(s_b,s_c\)

Choose barycentric coefficients

\[
\lambda_a = \frac{s_a+\tau}{s_a+s_b+s_c+3\tau},\quad
\lambda_b = \frac{s_b+\tau}{s_a+s_b+s_c+3\tau},\quad
\lambda_c = \frac{s_c+\tau}{s_a+s_b+s_c+3\tau},
\]

with small \(\tau>0\), e.g. \(\tau=1\).

Then place

\[
p_v = \lambda_a p_a + \lambda_b p_b + \lambda_c p_c.
\]

Interpretation:
- a larger descendant region gets a larger opposite area share
- this allocates room according to recursive mass instead of symmetry alone

If your implementation prefers edge weights, set

\[
w_{va}=\lambda_a,\quad w_{vb}=\lambda_b,\quad w_{vc}=\lambda_c.
\]

##### Beyond 3-trees: dual-tree / region-mass weights

For a general embedded planar graph, imitate the same idea using a rooted dual tree.

Procedure:
1. Build the dual graph.
2. Root it at the outer face.
3. Compute a spanning tree of the dual.
4. For each primal edge \(e\), let its dual edge point toward a subtree of faces.
5. Define a mass score \(m(e)\) = number of faces in that dual subtree.
6. Use \(m(e)\) to bias weights.

A simple formula:

\[
w_{ij} = \phi_{ij}\cdot \frac{1}{(\|p_i-p_j\|+\varepsilon)^\alpha},
\]

where \(\phi_{ij}\) is a structural multiplier such as

\[
\phi_{ij} = 1 + \beta \cdot \frac{m(ij)}{\max_e m(e)}.
\]

Typical range:
- \(\beta \in [0,2]\)

Interpretation:
- edges that act as gateways to large hidden regions get stronger influence
- this is a generic version of the 3-tree area-allocation idea

Pros:
- captures global structure better than BFS depth
- natural for embedded planar graphs

Cons:
- more heuristic outside 3-trees
- depends on the chosen dual tree, so it is not canonical

---

## 2. Iterate the weights

A single weighted solve is usually not enough.

Use an outer loop:

1. start from a current drawing \(p\)
2. compute weights from \(p\)
3. solve the weighted Tutte system to get new positions \(p'\)
4. optionally blend old and new positions
5. repeat until improvement stalls

### 2.1 Damped update

Instead of replacing \(p\leftarrow p'\) immediately, use

\[
p \leftarrow (1-\rho)p + \rho p',
\]

with \(\rho\in(0,1]\).

Recommended default:
- \(\rho = 0.5\)

This prevents unstable oscillation when geometry-dependent weights change a lot between iterations.

### 2.2 Stopping rule

Stop when either:
- max vertex movement is small relative to drawing diameter, e.g.
  \[
  \max_i \|p_i^{(t+1)}-p_i^{(t)}\| < 10^{-3}\cdot \text{diameter}
  \]
- or quality no longer improves significantly for 2 iterations
- or a fixed iteration budget is reached, e.g. 5 iterations

### 2.3 Suggested quality signals

Use one or more of:
- minimum interior edge length
- variance of edge lengths
- variance of face areas
- minimum face area
- vertex spacing score

A good simple choice is:

\[
Q = \text{minEdgeLength} - \lambda \cdot \text{stdDevFaceAreas},
\]

with \(\lambda\) tuned empirically.

---

## 3. Post-processing that actually fights collapse

MVC is mainly a smoother. If you want to improve spacing, use a post-process that explicitly pushes vertices apart or enlarges small faces.

All steps below assume:
- outer-face vertices stay fixed
- each update is small
- you reject or reduce a step if it would create edge crossings

### 3.1 Anti-smoothing

This is the opposite of Laplacian smoothing.

For an interior vertex \(i\), let

\[
\bar p_i = \frac{1}{\deg(i)}\sum_{j\sim i} p_j.
\]

Then update

\[
p_i' = p_i + \eta (p_i - \bar p_i).
\]

Interpretation:
- if a vertex sits too close to the average of its neighbors, push it away from that average
- this directly counteracts the “over-averaging” effect of Tutte

Recommended default:
- \(\eta \in [0.05, 0.2]\)
- 2 to 10 passes

Safety:
- after a pass, check whether any pair of edges that should not intersect now intersect
- if so, reduce \(\eta\) and retry

This is one of the easiest and most effective decompression steps.

### 3.2 Face-centroid expansion

For each face \(f\), compute its centroid \(c_f\).

For an interior vertex \(i\), accumulate a displacement from incident faces:

\[
d_i = \sum_{f\ni i} \omega_f (p_i-c_f).
\]

Then update

\[
p_i' = p_i + \eta d_i.
\]

Possible choice of \(\omega_f\):
- uniform: \(\omega_f=1\)
- inverse-area emphasis:
  \[
  \omega_f = \frac{1}{A_f+\varepsilon}
  \]

Interpretation:
- vertices of tiny faces are pushed away from the face centroid more strongly
- this enlarges cramped regions without needing any heavy machinery

Recommended default:
- use inverse-area weights
- \(\eta \in [0.001, 0.05]\), depending on drawing scale
- 2 to 10 passes

This is often more stable than explicit pairwise repulsion.

### 3.3 Edge-length equalization

Pick a target edge length \(\ell_{ij}\).

Simplest choice:
- all interior edges share a common target \(\ell\), such as the median current edge length

For vertex \(i\), accumulate

\[
d_i = \sum_{j\sim i}(\|p_i-p_j\|-\ell_{ij})\,\hat u_{ij},
\]

where

\[
\hat u_{ij} = \frac{p_j-p_i}{\|p_j-p_i\|+\varepsilon}.
\]

Then update

\[
p_i' = p_i + \eta d_i.
\]

Interpretation:
- short edges push endpoints apart
- long edges pull them together

Recommended default:
- \(\ell\) = median edge length
- \(\eta\in[0.01,0.1]\)
- 3 to 20 passes

Compared to anti-smoothing:
- more direct control over spacing
- slightly less stable if used aggressively

### 3.4 Short-range vertex repulsion

For each interior vertex \(i\), repel only nearby vertices.

A simple form:

\[
d_i = \sum_{j\ne i,\ \|p_i-p_j\|<r}
\frac{p_i-p_j}{(\|p_i-p_j\|+\varepsilon)^q}.
\]

Typical choices:
- \(q=2\) or \(3\)
- \(r\) = 2 to 4 times the median edge length

Then update

\[
p_i' = p_i + \eta d_i.
\]

Practical advice:
- skip neighbors if you want the effect to focus on nonadjacent crowding
- or include only vertices within 2 hops in the graph if you want a local effect

This can help, but it is usually the riskiest post-process in terms of creating crossings. Use it only with small steps and crossing checks.

---

## 4. MVC as a polish step

MVC is worth trying, but do not expect it to fix global spacing by itself.

Recommended use:
1. get a decent layout from weighted Tutte + reweighting
2. compute MVC weights from the current geometry
3. solve once
4. stop

This often improves:
- local angular quality
- mild face skew
- visual smoothness

But repeated MVC passes tend to smooth the drawing further, so do not iterate it many times if crowding is your main issue.

A safe mixed strategy is

\[
w_{ij}^{\text{mixed}} = \lambda w_{ij}^{\text{structural}} + (1-\lambda) w_{ij}^{\text{MVC}},
\]

with \(\lambda\in[0.5,0.9]\).

Interpretation:
- the structural term drives spacing
- the MVC term regularizes local shape

---

## 5. What not to rely on

### 5.1 Pure BFS-depth weights

A typical idea is:

\[
w_{ij} = c^{-\min(d(i),d(j))}
\]

where \(d(v)\) is distance from the boundary.

This can help a little, but in practice it is usually too weak because:
- it is only a boundary-bias heuristic
- it does not detect bottlenecks
- it does not allocate room based on actual hidden mass

Use it only as a baseline structural multiplier, not as the main method.

### 5.2 Single-shot weighted solve

Even good weights often need iteration because the geometry itself changes after solving.

### 5.3 Over-aggressive smoothing

Repeated Laplacian or MVC smoothing often makes central collapse worse.

---

## 6. A minimal practical pipeline

If you want one implementation that is still simple and likely to work better than default Tutte, use this.

### Inputs
- plane graph
- convex outer face coordinates

### Output
- straight-line planar drawing with improved spacing

### Algorithm

#### Step 1: uniform Tutte initialization
Solve the standard Tutte system with \(w_{ij}=1\).

#### Step 2: iterative distance-based reweighting
Repeat 3 to 5 times:
1. for every edge \((i,j)\), compute
   \[
   w_{ij} = \frac{1}{\|p_i-p_j\|+\varepsilon}
   \]
2. clamp to a chosen range
3. solve the weighted Tutte system
4. damp the update:
   \[
   p\leftarrow 0.5p + 0.5p'
   \]

Optional upgrade:
- multiply by a structural factor \(\phi_{ij}\) from region mass or dual-tree mass

#### Step 3: anti-smoothing
Run 3 to 5 passes of

\[
p_i' = p_i + \eta (p_i - \bar p_i)
\]

with \(\eta\approx 0.1\), reducing it if crossings appear.

#### Step 4: face-centroid expansion
Run 3 to 5 passes of

\[
p_i' = p_i + \eta \sum_{f\ni i} \frac{p_i-c_f}{A_f+\varepsilon}
\]

with a small \(\eta\).

#### Step 5: optional MVC polish
Compute MVC weights from the current geometry and solve once.

---

## 7. Re-implementation notes

### 7.1 Data you need

At minimum:
- adjacency list in cyclic order around each vertex
- list of boundary vertices
- coordinates of boundary vertices
- face list, or a way to enumerate incident faces

Useful extras:
- dual graph
- decomposition tree if your graph class has one

### 7.2 Solving the linear systems

You solve two linear systems with the same matrix:
- one for x
- one for y

Use any sparse symmetric positive definite solver if weights are positive.

### 7.3 Crossing checks

For post-processing, use a conservative check:
- test all nonadjacent edge pairs for intersection after a pass
- if any crossing appears, reduce step size and retry

For small to medium graphs, an \(O(m^2)\) check is often fine.

### 7.4 Numerical safety

Always use:
- a small \(\varepsilon\) in denominators
- weight clamping
- step-size damping

This matters more than theoretical elegance.

---

## 8. Main design principle

The core failure of default Tutte is that it is **pure averaging**.

So every successful improvement does at least one of these:
- changes the averaging weights based on geometry
- changes the weights based on global structure or hidden mass
- adds an explicit decompression step after solving

A useful summary is:
- **MVC** improves local shape
- **distance-based reweighting** improves spacing more directly
- **structure-aware mass weights** are the most promising graph-based idea
- **anti-smoothing + face expansion** are the simplest post-processes that actually fight collapse

---

## 9. Recommended first implementation

If you want the simplest serious version to build first, implement exactly this:

1. standard Tutte
2. 4 rounds of
   - \(w_{ij}=1/(\|p_i-p_j\|+\varepsilon)\)
   - weighted solve
   - 50% damping
3. 5 anti-smoothing passes
4. 5 face-centroid expansion passes

Only after that, consider adding:
- MVC polish
- structural multipliers from region mass

That sequence is simple, modular, and likely to give a clear improvement over default Tutte.

---

## 10. Exploration plan for this repo

This section turns the ideas above into a concrete exploration roadmap.

Project priorities:
- keep the implementation family recognizably Tutte-like
- prefer simple algorithms over heavy optimization loops
- judge ideas by benchmark quality, not by elegance alone
- preserve planarity and keep the outer face fixed

The intended comparison point is:
- **Default Tutte** as the baseline
- any new method should justify its added complexity with a clear metric gain

### 10.1 Evaluation rules

Every candidate should be evaluated on:
- the full 22-graph benchmark
- at least the difficult hand-checked samples `sample1` and `sample2`

Track these metrics:
- bounded face-area score
- edge-length uniformity score
- angle-resolution score
- edge-length ratio
- spacing score
- success count / crossing-free count
- runtime

Minimum acceptance requirements for a new method:
- no worse success count than the current practical baseline unless the quality gain is very large
- a clear gain on `sample1`
- improvement in at least one primary quality metric without obvious regressions elsewhere
- implementation complexity that stays proportional to the gain

For simplicity-first methods, prefer:
- a small fixed number of outer iterations
- exact weighted Tutte solves
- positive weights only
- no large nonlinear optimization state

### 10.2 Current algorithm roles

Use these names consistently when comparing methods:
- **Default Tutte**: one-shot weighted Tutte baseline
- **TutteAdaptive**: a lightweight improved Tutte with a few adaptive reweighting rounds
- **Reweight**: the stronger but heavier iterative reweighting method

Interpretation:
- `TutteAdaptive` should target the middle ground:
  better than default Tutte, much simpler than Reweight
- `Reweight` remains the "quality-first" reference, not the simplicity reference

### 10.3 Exploration order

The recommended order is from simplest and most promising to more speculative.

#### Phase A. Distance-reweighted Tutte

Goal:
- test the cleanest geometric reweighting rule from this note

Algorithm:
1. run standard Tutte
2. repeat 3 to 5 rounds:
   - set
     \[
     w_{ij} = \frac{1}{\|p_i-p_j\|+\varepsilon}
     \]
   - clamp weights
   - solve weighted Tutte
   - damp with
     \[
     p \leftarrow (1-\rho)p + \rho p'
     \]

Recommended defaults:
- 4 rounds
- \(\rho=0.5\)
- moderate weight clamping

Why this should be first:
- it is simple
- it directly targets crowding
- it is easier to reason about than face-pressure heuristics

Success criterion:
- clearly better than Default Tutte
- competitive with or better than `TutteAdaptive`

#### Phase B. Tutte + anti-smoothing

Goal:
- add the simplest explicit decompression step

Algorithm:
1. run a Tutte-based initializer
2. apply 3 to 5 anti-smoothing passes
3. reduce step size if crossings appear

Formula:
\[
p_i' = p_i + \eta(p_i-\bar p_i)
\]

Why this is attractive:
- conceptually simple
- tiny implementation footprint
- directly fights over-averaging

Main risk:
- can create crossings if the step is too aggressive

Success criterion:
- meaningful spacing improvement at very low complexity cost

#### Phase C. Tutte + face-centroid expansion

Goal:
- enlarge tiny faces more explicitly than reweighting alone

Algorithm:
1. run a Tutte-based initializer
2. apply 3 to 5 face-expansion passes
3. use inverse-area weights so tiny faces are pushed harder

Why this is attractive:
- aligned with the face-area metric
- still much simpler than a general optimizer

Main risk:
- may overemphasize face balance at the expense of angles or edge lengths

Success criterion:
- strong face-area improvement with stable planarity

#### Phase D. Combined lightweight pipeline

Goal:
- build the best "simple but strong" pipeline

Candidate pipeline:
1. distance-reweighted Tutte
2. anti-smoothing
3. face-centroid expansion

This is the main candidate for a new practical algorithm if Phases A-C all show value individually.

Decision rule:
- only keep the combined pipeline if it beats its simpler components by enough to justify the extra stages

#### Phase E. MVC polish

Goal:
- test MVC only in the role it seems best suited for: local cleanup

Algorithm:
1. start from a good layout produced by one of the methods above
2. compute MVC weights from the current geometry
3. solve once

Important constraint:
- do not make MVC the main improvement mechanism
- treat it as an optional polish only

Primary things to watch:
- angle quality
- local face skew
- visual smoothness

Secondary concern:
- repeated MVC passes are likely to reintroduce smoothing/collapse

Decision rule:
- keep this only if it gives a small but repeatable gain without hurting face balance

#### Phase F. Structure-aware mass weights

Goal:
- explore the most graph-structural idea in the note

Variants:
- dual-tree region-mass multiplier
- plane-3-tree-specific descendant-mass weights if a clean decomposition is available

Why this is interesting:
- it is graph-aware rather than purely geometric
- it may allocate space to hidden regions better than local edge-length rules

Why it is later:
- more implementation complexity
- more heuristic choices
- harder to debug and explain

Decision rule:
- only pursue this if simpler geometric methods plateau

### 10.4 Concrete algorithm candidates

These are the new algorithm names worth exploring.

#### 1. DistanceReweightedTutte

Definition:
- fixed small number of weighted Tutte re-solves
- weights from inverse edge length
- damping between rounds

Primary target:
- best simple replacement for Default Tutte

#### 2. TutteAntiSmooth

Definition:
- standard or weighted Tutte
- then anti-smoothing only

Primary target:
- cheapest possible decompression algorithm

#### 3. TutteFaceExpand

Definition:
- standard or weighted Tutte
- then face-centroid expansion only

Primary target:
- face-balance-focused post-processing baseline

#### 4. DistanceReweightedTuttePlus

Definition:
- distance reweighting
- anti-smoothing
- face expansion

Primary target:
- strongest "still simple" practical pipeline

#### 5. TutteMVCPolish

Definition:
- any good Tutte-like layout
- one MVC refinement solve

Primary target:
- local cleanup, not global decompression

#### 6. StructuralMassTutte

Definition:
- weighted Tutte with structural multipliers from dual-tree or region-mass information

Primary target:
- graph-aware room allocation

### 10.5 Benchmark protocol

For every candidate:

1. run on `sample1` and `sample2`
2. inspect the drawing visually
3. record all quality metrics
4. compare against:
   - Default Tutte
   - TutteAdaptive
   - Reweight
5. run the full 22-graph benchmark
6. store a summary table with:
   - success count
   - runtime
   - metric averages
   - per-graph gains/losses

Use these specific questions:
- does it substantially improve `sample1`?
- does it stay crossing-free on the benchmark?
- does it beat Default Tutte by enough to matter?
- does it approach Reweight quality without Reweight cost?

### 10.6 Decision policy

Use the following policy when deciding what to keep.

Keep a method if:
- it is clearly better than Default Tutte
- it is meaningfully simpler or more robust than Reweight
- its benchmark gains are repeatable

Reject or pause a method if:
- it only improves one metric slightly
- it hurts success count
- it mainly looks different rather than better
- it becomes too parameter-heavy

Prefer the simplest method that achieves:
- a substantial `sample1` gain
- benchmark-safe planarity
- broad average metric improvement

### 10.7 Recommended immediate next step

If only one new exploration should be implemented next, choose:

#### DistanceReweightedTutte

Reason:
- it is the cleanest serious idea in this note
- it matches the simplicity goal
- it directly targets collapse
- it gives a better scientific comparison against both Default Tutte and TutteAdaptive than jumping immediately to more elaborate post-processing

After that, the next most useful follow-up is:

#### Tutte + anti-smoothing

and then:

#### Tutte + face-centroid expansion

### 10.8 Overall strategy summary

The guiding strategy for this repo should be:

1. keep Tutte as the core solver
2. improve weights first
3. if weights are not enough, add one explicit decompression post-process
4. use MVC only as a light polish
5. move to structure-aware methods only if the simpler methods stop delivering

In short:
- **first explore distance-reweighted Tutte**
- **then explore anti-smoothing and face expansion**
- **treat MVC as optional polish**
- **treat structural mass weights as advanced work**
