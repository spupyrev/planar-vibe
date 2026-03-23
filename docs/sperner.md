# Sperner

`Sperner` is a recursive planar layout algorithm for a planar graph.
Internally, the input graph is first augmented by face stellation so that the working graph is a triangulated plane graph. The final coordinates are reported only for the original vertices.

The implementation uses one global BFS tree, a recursive separator placement, and then a fixed-boundary harmonic refinement to obtain a plane straight-line drawing.

## Algorithm

### Global preprocessing

1. Compute a planar embedding and choose the outer face.
2. Augment every non-triangular face by face stellation.
3. Choose three outer-face corner vertices `A`, `B`, `C` spaced roughly evenly along the outer face.
4. Add a fake root adjacent to `A`, `B`, `C` conceptually, and run one BFS tree `T` from these three corners.
5. Color every vertex by the branch of `T` through which it reaches the root:
   - color `A`
   - color `B`
   - color `C`

This BFS tree and coloring are reused for all recursive steps.

### Recursive subproblem

A recursive subproblem consists of:

- a triangulated disk `G_R`
- a simple boundary cycle `C_R`
- fixed coordinates for every vertex on `C_R`

Here "triangulated disk" means that every face of `G_R` except the outer face bounded by `C_R` is a triangle.
The boundary `C_R` itself can have any length at least `3`; in particular, recursive subproblems are usually not triangles.

The base case is therefore:

- stop as soon as no unplaced vertex lies strictly inside `C_R`

Equivalently, recursion stops when the current subproblem is already completely represented by its boundary cycle, regardless of whether that boundary is a triangle, quadrilateral, pentagon, or a larger polygon.

### Three-color step

If all three colors appear on the boundary of the current region, the algorithm does the following.

1. Find a tricolored facial triangle
   - `v_A v_B v_C`
2. Follow the BFS tree from these three vertices until each path first reaches the current boundary.
   This gives three pairwise internally disjoint shortest tree paths:
   - `P_A = (a = a_0, ..., a_k = v_A)`
   - `P_B = (b = b_0, ..., b_l = v_B)`
   - `P_C = (c = c_0, ..., c_m = v_C)`
3. Build the induced separator subgraph on:
   - the current boundary vertices
   - all vertices of `P_A, P_B, P_C`
   - `v_A, v_B, v_C`
4. This separator splits the current region into smaller regions.

#### Coordinates in the three-color step

Let `a`, `b`, `c` be the three boundary vertices where the three separator tree paths first hit the current boundary cycle `C_R`.
These are the three anchor vertices used for the current separator placement; they need not be the only distinguished vertices on `C_R`, and the rest of the boundary may contain arbitrarily many additional vertices.

Let the separator-induced child regions opposite `a, b, c` contain `m_A, m_B, m_C` interior vertices, respectively.

Define:

- `alpha_A = 2 m_A + 1`
- `alpha_B = 2 m_B + 1`
- `alpha_C = 2 m_C + 1`

Then the central separator point is

- `q_R = (alpha_A p(a) + alpha_B p(b) + alpha_C p(c)) / (alpha_A + alpha_B + alpha_C)`

The path vertices are placed on straight segments from the boundary to `q_R`.

For `P_A = (a_0, ..., a_k)` with `a_0 = a`:

- `p(a_i) = (1 - i/(k+1)) p(a) + (i/(k+1)) q_R`

Similarly, for `P_B = (b_0, ..., b_l)` with `b_0 = b` and `P_C = (c_0, ..., c_m)` with `c_0 = c`:

- `p(b_j) = (1 - j/(l+1)) p(b) + (j/(l+1)) q_R`
- `p(c_h) = (1 - h/(m+1)) p(c) + (h/(m+1)) q_R`

In particular:

- `p(v_A) = p(a_k)`
- `p(v_B) = p(b_l)`
- `p(v_C) = p(c_m)`

So in the three-color case every newly introduced separator vertex lies on one of the three rays toward the point `q_R`.

Every bounded face of the induced separator subgraph becomes the boundary of a new recursive subproblem. Those child boundaries are again simple polygonal cycles, not necessarily triangles.

### Two-color step

If exactly two colors appear on the boundary, the algorithm uses the two-color analogue.

1. Find a bichromatic edge with endpoint colors matching the two boundary colors.
2. Follow the global BFS tree from the two endpoints to the first boundary vertices of the same colors.
3. Use the induced separator subgraph on:
   - the current boundary
   - the two tree paths
   - the bichromatic edge
4. Recurse on all bounded faces of this induced separator.

#### Coordinates in the two-color step

Let `a` and `b` be the two boundary vertices where the two separator tree paths first hit the current boundary cycle `C_R`.
Let `q_R` be the midpoint of the segment `ab`:

- `q_R = (p(a) + p(b)) / 2`

If `P_A = (a_0, ..., a_k)` with `a_0 = a` and `P_B = (b_0, ..., b_l)` with `b_0 = b`, then:

- `p(a_i) = (1 - i/(k+1)) p(a) + (i/(k+1)) q_R`
- `p(b_j) = (1 - j/(l+1)) p(b) + (j/(l+1)) q_R`

### Harmonic fill

If a recursive region does not expose a usable Sperner separator, its remaining interior vertices are filled by a fixed-boundary harmonic solve inside the current boundary.

### Final planarization step

After all recursive coordinates are assigned, the algorithm runs one global fixed-boundary harmonic refinement on the triangulated augmentation while keeping the outer boundary fixed.
This produces the final plane drawing used for the output.

A final Tutte repair step is used only if a degenerate crossing remains after the harmonic refinement.

## P3T as a special case

`P3T` is the special case where a recursive three-color region contains exactly one inserted separator vertex `v` and no additional path vertices.
Then:

- `v_A = v_B = v_C = v`
- the three child regions are exactly the three child triangles of the planar 3-tree insertion
- `m_A, m_B, m_C` are exactly the descendant counts used by `P3T`

Therefore the Sperner coordinate formula becomes

- `p(v) = (alpha_A p(A) + alpha_B p(B) + alpha_C p(C)) / (alpha_A + alpha_B + alpha_C)`

with

- `alpha_A = 2 m_A + 1`
- `alpha_B = 2 m_B + 1`
- `alpha_C = 2 m_C + 1`

which is exactly the `P3T` placement rule.

## Evaluation

The evaluation below uses the current report benchmark with 21 graphs.

| Graph | Face Areas Score | Edge Length Score |
|---|---:|---:|
| `sample1` | 0.455 | 0.853 |
| `sample2` | 0.397 | 0.849 |
| `sample3` | 0.405 | 0.768 |
| `sample4` | 0.367 | 0.761 |
| `sample5` | 0.223 | 0.838 |
| `sample6` | 0.389 | 0.652 |
| `sample7` | 0.445 | 0.852 |
| `planar3tree10` | 0.446 | 0.822 |
| `planar3tree30` | 0.352 | 0.845 |
| `planar3tree100` | 0.351 | 0.825 |
| `cycle20` | 1.000 | 0.563 |
| `xtree30` | 0.131 | 0.708 |
| `oct174` | 0.591 | 0.935 |
| `grid2x20` | 0.846 | 0.843 |
| `grid4x20` | 0.145 | 0.644 |
| `grid9x9` | 0.146 | 0.671 |
| `randomplanar1` | 0.412 | 0.844 |
| `randomplanar2` | 0.425 | 0.854 |
| `randomplanar3` | 0.565 | 0.861 |
| `randomplanar4` | 0.482 | 0.868 |
| `randomplanar5` | 0.457 | 0.863 |
| `mean` | 0.430 | 0.796 |
| `geomean` | 0.383 | 0.790 |

## Encountered Problems

During implementation, several theoretical and practical issues showed up.

### 1. Recursive subproblems are not triangular

The original graph is triangulated, but the recursion is performed on the bounded faces of the induced separator subgraph.
Those faces are generally not triangles: they are unions of many triangular faces of the original graph.

So the correct recursive object is:

- a triangulated disk with a fixed polygonal boundary

not:

- a single triangle

This is why the base case had to be changed from “triangle” to “no interior vertices inside the current polygonal boundary”.

### 2. Three-color separators do not appear in every child region

After the first separator step, many child regions expose only two colors on their boundary, and some expose only one color.
So a pure “apply Sperner again” recursion is not sufficient.

The implementation therefore uses:

- a three-color separator step when all three colors are present
- a two-color analogue when exactly two colors are present
- a harmonic fill when no useful separator remains

### 3. Straight spoke placement alone was not robust enough

Placing separator vertices and path vertices on straight rays gives a good recursive scaffold, but it was not stable enough to guarantee a crossing-free final drawing on all benchmark graphs by itself.

In particular:

- some child regions became geometrically thin
- some induced subproblems inherited awkward polygonal boundaries
- one benchmark grid instance still produced a crossing after the recursive placement

Because of this, the implementation adds a fixed-boundary harmonic refinement after the recursive placement.

### 4. One benchmark still needed a final repair

After the recursive placement and global harmonic refinement, `grid2x20` still produced a crossing.
To ensure that all benchmark graphs are drawn in a planar way, the implementation applies one final Tutte repair if a crossing remains.

So the current implementation is best described as:

- a Sperner-style recursive initializer
- followed by a harmonic planarization stage
- with a final Tutte repair only in the rare degenerate case

### 5. The implemented algorithm is weaker than the ideal theory

The clean theoretical story is fully recursive and separator-driven.
The implemented version keeps that separator logic, but uses harmonic subroutines to make the method robust on the full benchmark set.

So the current implementation should be viewed as:

- a practical first version of `Sperner`

rather than:

- the final pure recursive separator algorithm

## Pseudocode

```text
SPERNER-LAYOUT(G)
Input:
  planar graph G
Output:
  straight-line planar drawing of G

1. Compute a planar embedding of G
2. Augment every non-triangular face by face stellation, obtaining G+
3. Choose three outer-face corner vertices A, B, C
4. Run one BFS from the three corners and fix one BFS tree T
5. Color every vertex by its BFS-tree branch through A, B, or C
6. Place the outer boundary on a convex polygon
7. Call RECURSE(region = whole graph of G+, boundary = outer face)
8. Run one global fixed-boundary harmonic refinement on G+
9. If crossings still remain, run one Tutte repair
10. Return coordinates of the original vertices of G


RECURSE(G_R, C_R)
Input:
  triangulated disk G_R
  fixed boundary cycle C_R with already assigned coordinates

1. If no unplaced vertex lies strictly inside C_R, return
2. Inspect the colors appearing on the boundary C_R

3. If all three colors appear on C_R:
   a. Find a tricolored facial triangle (v_A, v_B, v_C)
   b. Follow the global BFS tree from v_A, v_B, v_C
      until each path first hits C_R
   c. Let these paths be P_A, P_B, P_C
   d. Build the induced separator subgraph H_R on:
      - C_R
      - P_A, P_B, P_C
      - v_A, v_B, v_C
   e. Let a, b, c be the first boundary hits of P_A, P_B, P_C on C_R
   f. Compute the three opposite-region sizes m_A, m_B, m_C
   g. Define:
      alpha_A = 2 m_A + 1
      alpha_B = 2 m_B + 1
      alpha_C = 2 m_C + 1
   h. Compute:
      q_R = (alpha_A p(a) + alpha_B p(b) + alpha_C p(c))
            / (alpha_A + alpha_B + alpha_C)
   i. Place every path vertex of P_A, P_B, P_C by linear interpolation
      on the segments toward q_R
   j. Recurse on every bounded face of H_R
   k. Return

4. If exactly two colors appear on C_R:
   a. Find a bichromatic edge (u, v)
   b. Follow the global BFS tree from u and v
      until each path first hits C_R
   c. Build the induced separator subgraph H_R on:
      - C_R
      - the two tree paths
      - the edge (u, v)
   d. Let a and b be the first boundary hits of the two tree paths on C_R
   e. Let q_R be the midpoint of a and b
   f. Place the two path families by linear interpolation toward q_R
   g. Recurse on every bounded face of H_R
   h. Return

5. Otherwise:
   a. Fill the region by a fixed-boundary harmonic solve
   b. Return
```
