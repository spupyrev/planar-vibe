# Layout Algorithms Overview

Notation used below: `n` = number of original vertices, `m` = number of original edges, `k` = number of interior vertices in the augmented graph, `F` = number of bounded triangles after augmentation, `T` = number of outer optimization sweeps.
For the barycentric solvers, the current code uses a dense LU factorization, so the dominant solve cost is `O(k^3)` even when the classical method admits a faster sparse implementation.

## Shared Preprocessing (`layout-preprocessing.js`, 389 LOC)
This file is the common entry point for most custom layouts rather than a standalone drawing style.
Its job is to turn an arbitrary planar input into a well-posed plane graph with a chosen outer face, a triangulated augmentation, and a verified barycentric seed drawing.
The implementation first tries to extract an embedding from the current positions; if that fails, it falls back to a planarity test and embedding routine.
It then chooses an outer face, augments the graph either by outer-cycle triangulation or face stellation, and records which vertices and edges are dummy artifacts.
Finally, it computes an initial weighted Tutte drawing on the augmented graph and rejects the result if any face is degenerate or any crossing appears.
In other words, every later optimizer starts from a plane straight-line drawing whose outer face is fixed and whose bounded regions are triangulated.
Pseudocode:
```text
extract_or_compute_embedding(G)
choose_outer_face(embedding, method)
H <- triangulate_or_augment(G, embedding, outer_face)
seed <- weighted_tutte(H, augmented_outer_face)
verify(seed has no crossings and no zero-area faces)
return {G, H, embedding, outer_face, seed, dummy metadata}
```
Complexity: LOC 389. Time is near-linear for embedding and augmentation plus one dense barycentric solve `O(k^3)`; space is `O(n + m + k^2)` in the current dense implementation.
References: closest lineage is [Tutte 1963](https://doi.org/10.1112/plms/s3-13.1.743); there is no single paper for this exact preprocessing bundle because it is a repo-level support pipeline.

## Tutte (`layout-tutte.js`, 384 LOC)
This is the repository's implementation of weighted Tutte barycentric embedding on an augmented plane graph.
The outer face is fixed on a convex polygon, and every interior vertex is placed at the weighted average of its neighbors.
The code assigns lower weights to augmentation edges and optionally scales all weights by endpoint degree, which keeps dummy triangulation edges from dominating the geometry.
Solving the x- and y-systems gives a straight-line convex drawing on the augmented graph; the code then projects the result back to the original vertices and checks for crossings.
This method is the main seed layout used by the more advanced optimizers.
Pseudocode:
```text
prepare augmented plane graph H with fixed outer face C
place vertices of C on a convex polygon
assign positive edge weights w_uv
for each interior vertex v: sum_u w_vu * (p[v] - p[u]) = 0
solve one linear system for x and one for y
discard dummy vertices and return original coordinates
```
Complexity: LOC 384. Current code is `O(k^3 + m)` because of dense LU on the interior system; sparse solvers can reduce the practical solve cost.
References: [Tutte 1963](https://doi.org/10.1112/plms/s3-13.1.743), and for the weighted-stress viewpoint used by the newer variants, [Chiu, Eppstein, Goodrich 2023](https://arxiv.org/abs/2307.10527).

## Schnyder (`layout-schnyder.js`, 594 LOC)
This file implements a Schnyder-wood style grid drawing for triangulated plane graphs.
After triangulation, it chooses an outer triangle, computes a contraction order, builds the three directed edge sets of the realizer, and derives combinatorial coordinates from subtree and prefix counts.
Those coordinates are then converted into screen positions and normalized.
Because the code works in finite-precision screen space, it also includes a practical post-processing step that gently separates coincident vertices if that can be done without introducing crossings.
The result is close to the classical integer-grid Schnyder construction, but with a final normalization to the repository viewport.
Pseudocode:
```text
triangulate graph and choose outer triangle (a, b, c)
compute contraction order L
construct Schnyder realizer with labels 1, 2, 3
compute combinatorial x/y coordinates from subtree counts
map integer coordinates to screen space
if overlaps remain: try local overlap resolution without crossings
```
Complexity: LOC 594. The classical method is linear after triangulation; the current implementation is roughly `O(n + m)` for the core realizer plus extra crossing/overlap checks that can push worst-case behavior toward `O(n^2)`.
References: [Schnyder 1990](https://dblp.org/rec/conf/soda/Schnyder90), plus the readable reconstruction at [Eppstein's Geometry in Action page](https://ics.uci.edu/~eppstein/gina/schnyder/).

## FPP (`layout-fpp.js`, 633 LOC)
This file implements the de Fraysseix-Pach-Pollack shift method through an explicit canonical ordering.
The graph is first triangulated so that the outer face is a triangle.
The code then repeatedly shells off a valid outer-cycle vertex, records the contour segment that will host it later, and reverses that elimination order to obtain the canonical insertion order.
During reconstruction, it maintains the current contour, shifts whole contour layers to the right when needed, and inserts each new vertex at the intersection of a `+1` and a `-1` diagonal.
That is the classical FPP recipe, expressed in mutable contour data structures rather than in the textbook tree representation.
Pseudocode:
```text
triangulate G and compute a canonical ordering v1, v2, ..., vn
place v1, v2, v3 at (0,0), (2,0), (1,1)
maintain outer contour from v1 to v2
for k = 4..n:
    find consecutive contour neighbors of vk
    shift interior/right contour layers
    place vk at diagonal intersection and splice it into contour
```
Complexity: LOC 633. The classical FPP algorithm is linear; the present implementation uses repeated contour scans and set updates, so a practical upper bound is `O(n^2)` after triangulation.
References: [de Fraysseix, Pach, Pollack 1990](https://doi.org/10.1007/BF02122694).

## P3T (`layout-p3t.js`, 157 LOC)
This file targets planar 3-trees and closely follows the recursive insertion structure of that graph family.
It first checks that the input is a planar 3-tree and extracts the elimination order.
It then rebuilds the graph from the outer triangle inward, counting how many later insertions fall inside each clique.
Each inserted vertex is placed as a weighted barycentric combination of the three parent vertices, where the weights are proportional to the sizes of the three subcliques.
This produces a drawing in which the recursive face decomposition is explicit and the face sizes are balanced in the same combinatorial way as the insertion tree.
Pseudocode:
```text
verify that G is a planar 3-tree and get elimination records
reverse elimination order to get insertion order
recursively count how many descendants lie in each clique
place outer triangle on a large circle
for each inserted vertex v in clique (a, b, c):
    place v as weighted average of a, b, c using subtree sizes
```
Complexity: LOC 157. Time `O(n)` once the planar 3-tree structure is known. Space `O(n)`.
References: closest paper match is [Biedl et al. 2013, "Drawing planar 3-trees with given face areas"](https://doi.org/10.1016/j.comgeo.2012.09.004); the repository implementation is a simplified equal-area style realization of that recursive clique idea.

## CEG BFS and XY (`layout-ceg.js`, 712 LOC)
This file implements two weighted-Tutte layouts inspired by recent work on improving stress-graph drawings.
`CEG-bfs` computes a baseline Tutte drawing, assigns each vertex a multi-source BFS depth from the outer face, and re-solves the drawing with edges weighted more strongly near the boundary.
`CEG-xy` starts from a baseline Tutte drawing, extracts a left-to-right orientation and two spanning trees, estimates how strongly edges should contribute to x-spread and y-spread, combines the two weight maps, and solves again.
In both cases the algorithmic idea is "do not change the solver; change the spring weights so the same barycentric equations produce a more spread-out drawing."
The implementation is faithful to the broad weighted-stress philosophy, but the `xy` branch is best described as paper-inspired rather than paper-identical.
Pseudocode:
```text
compute baseline weighted Tutte drawing on augmented graph
if BFS mode:
    depth[v] <- BFS distance from outer face
    set w_uv proportional to r^(-min(depth[u], depth[v]))
if XY mode:
    infer left-to-right orientation and spread trees from baseline
    build x-spread and y-spread weights, then average them
solve weighted Tutte again and project to original vertices
```
Complexity: LOC 712. Each solve is `O(k^3)` in the current dense code; the extra BFS/orientation/tree work is `O(n log n + m)` at most, so the overall cost is dominated by two or three dense solves.
References: [Chiu, Eppstein, Goodrich 2023](https://arxiv.org/abs/2307.10527). In this repository, `CEG-bfs` is the closer match, while `CEG-xy` is a heuristic adaptation of the spread/morph idea.

## Reweight (`layout-reweight.js`, 490 LOC)
This method iteratively modifies the edge weights of a Tutte embedding to make bounded face areas more uniform.
Starting from the shared barycentric seed, it measures every bounded face area relative to the outer face.
Faces that are too small accumulate positive "pressure" and faces that are too large accumulate negative pressure.
Those pressures are pushed back onto incident edges, creating a new weight field, and the weighted Tutte system is solved again with the outer face fixed.
The process repeats until either movements stabilize or the iteration limit is reached.
Pseudocode:
```text
initialize all edge weights to 1 and fix outer-face positions
repeat:
    solve weighted Tutte system
    measure bounded face areas
    update per-face pressure from log(target_area / actual_area)
    rescale edges using adjacent face areas and pressures
until movement or iteration stopping rule triggers
```
Complexity: LOC 490. Time `O(T * k^3)` in the current code because every outer iteration performs a dense barycentric solve; auxiliary face and pressure updates are linear in the augmented graph size.

## AreaGrad (`layout-areagrad.js`, 628 LOC)
AreaGrad can be read as projected area-gradient descent on a triangulated augmentation.
After building the augmented triangles and a Tutte seed, the code computes the relative area error of every bounded triangle against a common target area.
For each movable vertex it forms a tiny local normal equation from the gradients of the incident triangle areas, giving a damped Gauss-Newton style update direction.
That direction is accepted only if all incident triangles stay positively oriented and if the global area energy decreases.
The method is therefore local in its updates but global in its accept/reject test.
Pseudocode:
```text
triangulate and compute target area = outer_area / number_of_triangles
repeat:
    compute residual r_t = area_t / target_area - 1 for all triangles
    visit movable vertices from worst local error to best
    solve a 2x2 damped local system for the vertex move
    backtrack until triangle positivity and objective decrease hold
until target error, stall, or iteration limit
```
Complexity: LOC 628. In the current implementation, worst-case time is about `O(T * n * F)`, because many candidate moves recompute the full triangle residual state; for planar triangulations this is roughly quadratic per sweep.

## Air (`layout-air.js`, 795 LOC)
AIR treats each incident triangle around a movable vertex as exerting a pressure-like force inversely proportional to its current area.
For a single vertex, the ideal location is the point where the weighted sum of these local pressure forces is balanced.
The code solves that local balance problem with a short Newton search plus Armijo backtracking, then sweeps over all movable vertices repeatedly.
Outer-ring triangles are down-weighted slightly so that the boundary does not dominate the balancing process.
Global stopping uses face-area error, force balance, movement size, and a small plateau detector.
Pseudocode:
```text
build triangulated augmented graph and target triangle area
repeat over sweeps:
    for each movable vertex v:
        evaluate local pressure force from incident triangles
        run a few Newton steps to find a better balanced position
        accept a shortened step only if all local triangles remain positive
    recompute global face-area and force statistics
until realized, stalled, deadlocked, or max sweeps
```
Complexity: LOC 795. With bounded degree in planar triangulations, the local Newton updates are effectively constant-size, so the method is close to `O(T * n)` per run; the dominant extra work is recomputing global statistics each sweep.
References: the closest direct source is Kleist's dissertation chapter on the air-pressure method, which defines face pressure, vertex force balance, and entropy for prescribed-area plane drawings: [Kleist 2018, Section 8.1](./../cpp_examples/kleist_linda.pdf). That chapter explicitly states that the method is inspired by [Felsner 2014, "Exploiting air-pressure to map floorplans on point sets"](https://doi.org/10.7155/jgaa.00318), where air pressure is used to prove area-universality for rectangular layouts.

## ForceDir (`layout-forcedir.js`, 545 LOC)
This is a force-directed post-processor whose objective is more uniform spacing rather than strict face-area control.
It combines three ingredients: attractive forces along original edges, repulsive forces between all vertex pairs, and extra local terms that push each vertex toward a more uniform nearest-neighbor distance profile.
A candidate move is rejected immediately if it would introduce an edge crossing, so the method can refine a plane seed while staying plane.
The code also tracks the best spacing score seen during the run and returns that best snapshot rather than blindly returning the last iterate.
Pseudocode:
```text
start from plane seed and compute target edge length from median edge length
repeat:
    estimate nearest-neighbor statistics
    for each movable vertex:
        add edge attraction, all-pairs repulsion, and spacing-uniformity forces
        cap the step and reject it if it creates a crossing
    keep the best crossing-free spacing score seen so far
until movement or step-size stopping rule
```
Complexity: LOC 545. Time is about `O(T * n^2)` on planar graphs, due to all-pairs distance calculations, nearest-neighbor scans, and crossing checks for candidate moves.
References: there is no exact prior paper for this particular uniformity heuristic; the closest lineage is [Eades 1984](https://cir.nii.ac.jp/crid/1573387448853684864) and [Fruchterman-Reingold 1991](https://doi.org/10.1002/spe.4380211102).

## ImPrEd (`layout-impred.js`, 686 LOC)
ImPrEd is a plane-preserving force-directed refinement based on Bertault's crossing-preservation idea.
It begins from a plane seed layout and computes three force types: node-node repulsion, edge attraction, and node-edge repulsion from the closest point on nearby non-incident edges.
To keep the drawing plane, the algorithm computes directional movement limits by ray shooting from each vertex, uses those limits to cap the allowed displacement in angular sectors, and shrinks or rolls back moves that would create crossings.
A momentum term accelerates accepted directions, while rejected or rolled-back vertices have their velocity damped.
This makes the method feel like a cautious force-directed optimizer that is aware of the planar embedding at every step.
Pseudocode:
```text
start from a plane seed and fix the outer-face vertices
repeat:
    compute node, edge, and node-edge forces
    estimate sector-wise safe movement limits for every vertex
    move each non-fixed vertex with capped momentum
    if crossings appear: rollback only the most responsible vertices
until no movement, movement convergence, or iteration limit
```
Complexity: LOC 686. Time is roughly `O(T * n^2)` on planar graphs because each iteration computes dense geometric interactions, directional limits, and possible rollback checks over many edge pairs.
References: the direct reference for this implementation is [Simonetto, Archambault, Auber, Bourqui 2011, "ImPrEd: An Improved Force-Directed Algorithm that Prevents Nodes from Crossing Edges"](https://doi.org/10.1111/j.1467-8659.2011.01956.x). For historical context, ImPrEd is introduced there as an improved version of PrEd, the earlier plane-preserving force-directed method of [Bertault 2000](https://doi.org/10.1016/S0020-0190(00)00042-9).

## Common Framework for the Balancers
FaceBalancer, AngleBalancer, EdgeBalancer, and FABalancer all share the same optimization backbone.
They start from an augmented triangulated plane graph with the outer face fixed on a convex polygon.
For every interior augmented vertex, the variables are logits attached to the cyclically ordered neighbors in the embedding.
A row-wise softmax turns those logits into positive barycentric coefficients, so each interior vertex remains a convex combination of its neighbors.
Given one choice of logits, the algorithm realizes coordinates by solving a weighted Tutte-style linear system.
The objective is then evaluated on the realized drawing, not directly on the logits.
Gradients are obtained by differentiating through the linear solve with an adjoint system, and the logits are updated by L-BFGS with backtracking line search and geometric feasibility checks.
As a result, all four methods preserve the same "soft Tutte" realization model; what changes from one variant to another is only the objective being optimized and, in the FABalancer case, the schedule in which objectives are applied.
Pseudocode:
```text
initialize logits from Tutte-style edge weights
repeat:
    softmax logits row-by-row to get barycentric coefficients
    solve the induced barycentric linear system for coordinates
    evaluate drawing-quality objective and feasibility barriers
    compute adjoint gradient with respect to the logits
    take an L-BFGS step with backtracking
until convergence or stopping rule
```
Complexity: for all four balancers, one optimization step is dominated by one dense primal solve and one dense adjoint solve, so the running time is roughly `O(T * k^3)` in the current implementation.

## FaceBalancer (`layout-facebalancer.js`, 969 LOC)
FaceBalancer uses the common balancer framework with a face-area objective.
Its main term measures how far each original bounded face area is from the mean bounded-face area of the drawing.
The implementation adds log barriers that keep augmented triangles positive, prevent original faces from collapsing, and discourage excessively short edges.
In effect, the shared soft-Tutte realization is adjusted until the original faces become more equal in area while the augmented drawing remains geometrically valid.
Pseudocode:
```text
run the common balancer framework
compute original-face areas from the augmented triangles
objective <- area variance + face barrier + edge barrier
```
Complexity: LOC 969. Time `O(T * k^3)` because every L-BFGS step evaluates the objective through one dense primal solve and one dense adjoint solve; geometry bookkeeping is linear in the augmented graph.

## AngleBalancer (`layout-anglebalancer.js`, 1102 LOC)
AngleBalancer keeps the same shared realization model but replaces the face-area objective by an angular one.
For every original vertex, it enumerates wedges in the rotation system and compares each realized wedge angle to the target value `2π / deg(v)`.
The loss penalizes squared angle residuals and adds a barrier that keeps wedges away from zero.
Face-orientation and triangle-positivity checks are still present, but now only as feasibility guards around an angular-resolution objective.
Pseudocode:
```text
run the common balancer framework
for each original vertex, enumerate wedges in rotation order
target each wedge angle to 2π / degree(center)
objective <- angle residuals + angle barrier + face feasibility barriers
```
Complexity: LOC 1102. Time `O(T * k^3)` in the current dense implementation, with linear extra work to evaluate wedge angles and face barriers on each step.

## EdgeBalancer (`layout-edgebalancer.js`, 1118 LOC)
EdgeBalancer again uses the common framework, but its objective is defined on the lengths of the original edges.
The implementation measures edge lengths in log space, which makes multiplicative distortions easier to handle.
It combines three terms: variance of log edge lengths, a smooth absolute-deviation term, and a soft range term that narrows the gap between the longest and shortest edges.
The usual face barriers remain in place only to preserve a valid plane drawing while the optimization tries to equalize edge lengths without enforcing one brittle target value.
Pseudocode:
```text
run the common balancer framework
measure original edge lengths and log-lengths
objective <- log-variance + smooth log-deviation + soft range penalty
add face-area barriers to stop flips and collapses
```
Complexity: LOC 1118. Time `O(T * k^3)` because each iteration performs dense primal and adjoint solves; the edge statistics themselves are linear in the number of original edges.

## FABalancer (`layout-fabalancer.js`, 1809 LOC)
FABalancer is the staged version of the same common framework.
Instead of fixing one objective for the whole run, it changes the objective over time.
It first runs a short face-oriented warm stage to keep bounded regions healthy, then switches to an angle-oriented stage that also penalizes vertical deviation so that many edges become nearly horizontal, and finally applies a greedy axis-alignment pass.
The key design choice is therefore not a new realization model but a staged schedule of objectives.
The final scoring combines face-area quality and angular quality through a geometric mean tradeoff score.
Pseudocode:
```text
stage 1: run the common framework with a face-dominant objective
stage 2: restart from stage 1 and run it with angle + horizontality
stage 3: greedily align near-axis edges if planarity is preserved
after each stage, report angle score, face score, and tradeoff score
return the aligned original-vertex drawing
```
Complexity: LOC 1809. Time is roughly `O((T1 + T2) * k^3)` for the two optimization stages, plus a small final alignment pass; in practice it is the most expensive layout in the codebase.
