# CEG23 Paper Check

Scope:
- check whether `CEG23-xy` in `static/js/layout-ceg23.js` matches the paper algorithm
- list the concrete discrepancies
- outline how to address them

Primary source:
- Alvin Chiu, David Eppstein, Michael T. Goodrich, "Manipulating Weights to Improve Stress-Graph Drawings of 3-Connected Planar Graphs", 2023
- PDF: https://ics.uci.edu/~goodrich/pubs/C-240.pdf
- Bibliographic page: https://ics.uci.edu/~eppstein/pubs/graph-all.html

## Verdict

`CEG23-bfs` is reasonably close to the paper's BFS-spread idea.

`CEG23-xy` is not a faithful implementation of the paper's `xy-morph`. It is a heuristic inspired by the paper, but it does not implement the paper's `x-spread` / `y-spread` construction, and therefore its `xy` result is also not the paper's `xy-morph`.

## What The Paper Actually Does

From the paper:

- Start with an unweighted Tutte drawing and rotate it if necessary so no edge is vertical.
- Sort vertices by x-coordinate and orient edges from left to right, producing an `st`-orientation.
- Choose new x-coordinates that are as evenly spaced as possible while respecting that ordering.
- Build two directed spanning trees in the oriented graph:
  - `T1` directed out of the leftmost vertex
  - `Tn` directed into the rightmost vertex
- For each directed edge `vi vj`, compute a path-count term `n_ij`, then set the edge weight proportional to `n_ij / (x_j - x_i)`.
- Solve the weighted Tutte system with those weights to get the `x-spread` drawing.
- Do the analogous construction for `y-spread`.
- Construct `xy-morph` by averaging the two coefficient matrices:
  - `Lambda_1/2 = 0.5 * Lambda_0 + 0.5 * Lambda_1`

Relevant passages in the PDF:
- x-spread setup and path-count weights: p.3-p.4
- `xy-morph`: p.4
- BFS-spread: p.4
- optional "kaleidoscope" rotations: p.4-p.5

## Current Implementation

Current `CEG23-xy`:

- prepares an augmented planar graph
- solves a uniform-weight Tutte baseline
- ranks vertices by the baseline `x` and `y` coordinates
- assigns heuristic edge weights from rank gaps:
  - `w = alpha + (|rank(u) - rank(v)| + 1)^beta`
- averages the `x` and `y` heuristic edge weights
- solves weighted Tutte again

Relevant code:
- ranking and spread weights: `static/js/layout-ceg23.js:97-155`
- `CEG23-xy` pipeline: `static/js/layout-ceg23.js:287-333`
- shared augmentation/prep: `static/js/layout-ceg23.js:158-198`

## Specific Discrepancies

### 1. The weight formula is wrong for the paper's `x-spread` / `y-spread`

Current code uses:

- `w = alpha + (|rank(u) - rank(v)| + 1)^beta`

in `buildSpreadWeights(...)`.

The paper does not use rank-gap weights. It uses:

- a left-to-right `st`-orientation
- evenly spaced target coordinates
- path counts through two directed spanning trees
- weights proportional to `n_ij / (x_j - x_i)`

This is the main discrepancy.

How to address:
- replace `buildSpreadWeights(...)` with a real paper-style spread-weight builder
- compute `n_ij / delta_x` for `x-spread`
- do the analogous construction for `y-spread`

### 2. The code never constructs the paper's `st`-orientation

The paper explicitly says to sort vertices by x-coordinate and orient edges from left to right to obtain an `st`-orientation.

Current code only computes ranks. It never:

- orients edges
- checks or enforces `st` conditions
- builds the directed structure needed by the paper

How to address:
- after the baseline Tutte solve, orient every edge from smaller x to larger x
- if ties remain, break them deterministically after a tiny rotation or symbolic perturbation
- store the directed graph explicitly for subsequent tree/path computations

### 3. The code never chooses evenly spaced target coordinates

The paper's spread construction depends on target coordinates that are "as evenly spaced as possible" while respecting the sorted order.

Current code uses only ordinal ranks, not target coordinate values.

That means it has no analogue of the paper's `x_j - x_i` denominator except a crude proxy via rank differences.

How to address:
- build explicit target coordinates for the sorted order
- simplest paper-aligned choice: assign equally spaced target values across the ordered vertices
- use those coordinate gaps in the weight formula

### 4. The code is missing the two-tree path-count construction

The paper computes path counts using:

- a tree `T1` directed out of the leftmost vertex
- a tree `Tn` directed into the rightmost vertex

and then counts how many selected paths use each edge.

Current code has none of this machinery.

How to address:
- build `T1` and `Tn` in the directed orientation
- compute the descendant-degree sums described in the paper
- derive `n_ij` for each directed edge
- convert those values into positive undirected edge weights for the weighted Tutte solve

### 5. The paper rotates the initial drawing to avoid vertical edges; the code does not

The paper says the initial unweighted Tutte drawing is rotated if necessary so no edge is vertical.

Current code only calls `alignOuterFaceEdgeHorizontally(...)` after solving. That is not the same thing.

Why this matters:
- the paper's left-to-right orientation depends on strict x-order along every edge
- vertical edges break that construction

How to address:
- before building the spread orientation, test whether any edge is vertical or nearly vertical
- if so, rotate the baseline drawing by a small angle until all edge x-differences are nonzero
- optionally expose the paper's "kaleidoscope" rotation sweep as a separate experimental mode

### 6. The implementation runs on an augmented graph, not directly on the paper's input class

The paper is about `3-connected planar graphs`.

Current code first runs the shared repo augmentation pipeline, potentially adding:

- augmentation edges
- dummy vertices

and then computes the layout on that augmented graph before projecting back.

This may be a valid repo extension, but it is not the same algorithmic setting as the paper.

How to address:
- add a strict "paper mode" that runs only on already 3-connected plane graphs without augmentation
- if repo-wide support for weaker graphs is still desired, keep that as a documented extension rather than the base implementation

### 7. The current `xy` stage averages heuristic edge weights, not paper-derived spread systems

The paper's `xy-morph` averages the coefficient matrices of the true `x-spread` and `y-spread` drawings.

Current code does average two weight maps, but those maps are already non-paper heuristics, so the resulting `xy` drawing is not the paper's morph.

How to address:
- first implement real `x-spread` and `y-spread`
- then form `xy-morph` from those two systems with `lambda = 0.5`
- keep arbitrary `lambdaX` only as an optional extension, not as the paper-faithful default

## What Looks Reasonable Today

The current `CEG23-bfs` is much closer to the paper:

- it uses simultaneous BFS from the outer face
- it assigns weights decaying by depth
- it re-solves a weighted Tutte drawing

The main deviations there are repo-level extensions:

- augmentation to handle broader graph classes
- optional `min` / `avg` / `max` endpoint-depth modes

So the big correctness concern is `CEG23-xy`, not `CEG23-bfs`.

## Recommended Fix Plan

### Phase 1. Add a paper-faithful `x-spread` builder

Implement a new internal pipeline:

1. compute unweighted Tutte on the target graph
2. rotate slightly so no edge is vertical
3. sort vertices by x
4. orient edges left-to-right
5. choose evenly spaced target x-values
6. build `T1` and `Tn`
7. compute `n_ij`
8. set weights `n_ij / delta_x`
9. solve weighted Tutte

Do this first before touching `xy-morph`.

### Phase 2. Build `y-spread` from the same construction

Two reasonable ways:

- run the same code on the baseline drawing rotated by 90 degrees
- or implement the same logic directly on y-order

The rotation-based implementation is usually the safest way to stay faithful to the paper's "spread by a different direction" description.

### Phase 3. Implement paper `xy-morph`

Once true `x-spread` and `y-spread` exist:

- use the same outer polygon `P`
- form `Lambda_half = 0.5 * Lambda_x + 0.5 * Lambda_y`
- solve once more to get the morph

### Phase 4. Only then add repo-specific extensions

After the paper-faithful path works:

- optional augmentation support
- optional `lambdaX != 0.5`
- optional kaleidoscope rotation sweep
- optional exact-vs-iterative solver choice

These should be clearly labeled as extensions, not confused with the paper algorithm.

## Bottom Line

If we want to keep the current code as-is, it should be renamed mentally to something like:

- `CEG23-inspired xy heuristic`

If we want a true implementation of the paper, `CEG23-xy` needs a substantial rewrite of the weight-construction stage.
