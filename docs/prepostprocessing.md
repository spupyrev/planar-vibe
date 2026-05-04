# Pre- and Post-Processing Tricks

The implementation uses two practical engineering layers around the layout
algorithms:

1. a preprocessing layer that augments the input graph before layout, and
2. a post-processing layer that makes the final drawing more visually aligned.

Both layers are deliberately heuristic. They are not the main layout algorithm;
they make the algorithms easier to run reliably on arbitrary planar inputs and
make the output easier to read.

## Preprocessing: Graph Augmentation

Most custom layouts in this repository do not work directly on the raw input
graph. They first call `LayoutPreprocessing.prepareGraphData`, which builds a
plane augmented graph.

The motivation is that many planar drawing algorithms are much simpler on a
triangulated plane graph:

- every bounded face has a predictable local structure;
- angular and face-area objectives can enumerate wedges and triangles without
  special cases for large faces;
- barycentric/Tutte-style initialization has a fixed outer boundary and a
  connected interior system;
- downstream algorithms can use one common embedding representation instead of
  rediscovering faces themselves.

The augmented graph is temporary. The final layout is projected back to the
original vertices, while dummy vertices and augmentation edges are used only as
scaffolding.

### Step 1: Choose a Plane Embedding

Preprocessing first needs a rotation system and a chosen outer face.

If the input already has valid coordinates and those coordinates form a
crossing-free drawing, the code extracts the embedding from the drawing:

1. sort each vertex's neighbors by geometric angle around the vertex;
2. trace faces by walking directed half-edges through that rotation system;
3. choose the largest-area face as the outer face.

If coordinates are missing or invalid, preprocessing falls back to the planar
embedding returned by the planarity test.

For the default augmentation method, `outer-cycle`, the code prefers the outer
face visible in the current drawing when available. This preserves the user's
mental model: the boundary they see remains the boundary used by the solver.

### Step 2: Add an Outer Dummy Cycle

The default method is `triangulateByOuterCycle`.

Given the selected outer face

```text
v0, v1, ..., v(k-1)
```

the code creates one dummy vertex per outer-face occurrence:

```text
d0, d1, ..., d(k-1)
```

Then for each `i`, it adds edges:

```text
di -- vi
di -- v(i+1)
di -- d(i+1)
```

with indices modulo `k`.

The new outer face becomes the dummy cycle:

```text
d0, d1, ..., d(k-1)
```

The old outer boundary is now inside the graph, surrounded by a one-face-thick
ring of dummy triangles.

This trick is useful because real-world input may have an awkward outer face:
it may be long, non-triangular, or even contain repeated articulation vertices
in the face walk. Wrapping it in a fresh dummy cycle gives the solver a simple,
distinct outer boundary while preserving the original graph inside it.

### Step 3: Triangulate Non-Triangular Interior Faces

After the outer cycle is added, every non-triangular face except the selected
outer face is triangulated.

For a simple face, the idea is face stellation:

1. add a dummy vertex inside the face;
2. connect that dummy vertex to every vertex on the face boundary;
3. update the local rotation order so the embedding remains consistent.

For faces whose boundary walk repeats a vertex, the implementation first splits
the walk into simple segments. It may create a short chain of dummy vertices
instead of a single center dummy. This avoids introducing duplicate edges or
multi-edges when an articulation vertex appears more than once on a face walk.

After each local modification, faces are recomputed from the updated rotation
system. At the end, the augmented embedding is checked to ensure every
non-outer face is a triangle.

### Alternative: Face Stellation Only

The older `face-stellation` mode skips the dummy outer cycle and triangulates
non-triangular interior faces directly. It can optionally triangulate the outer
face too.

This is simpler, but less robust for drawings with complicated or repeated
outer-face walks. The outer-cycle method is the default because it isolates the
layout algorithm from those boundary complications.

### Data Returned to Layouts

Preprocessing returns both the original and augmented worlds:

- `graph`: the original graph;
- `augmentedGraph`: the temporary graph with dummy vertices and edges;
- `embedding`: the augmented embedding and rotation system;
- `outerFace`: the selected original outer face;
- `augmentedOuterFace`: the outer face used by the augmented solver;
- `augmentedDummyCount`, `outerDummyIds`, and added-edge metadata for debugging.

Most layouts solve on `augmentedGraph`, then call
`GeometryUtils.filterPositionMap(..., graph.nodeIds)` or equivalent logic to
keep only original vertex coordinates in the returned drawing.

## Post-Processing: Rotation and Axis Alignment

Post-processing happens after a drawing already exists. It never changes graph
topology; it only changes coordinates.

The motivation is visual readability. Many algorithms produce valid planar
drawings whose important edges are almost horizontal or whose vertices almost
share coordinate lines. Humans read these drawings better when near-misses are
made exact, as long as the operation does not create crossings.

There are two independent post-processing operations:

1. rotate the entire drawing to make long edges as horizontal as possible;
2. greedily align nearby vertex coordinates to common `x` and `y` lines.

### Rotation: Make Edges Near-Horizontal

The rotation operation is implemented by
`PlanarVibeRotation.computeOptimalWeightedEdgeRotation`.

It searches for a single angle applied to the whole drawing. Since rotating the
entire drawing is a rigid motion, it preserves all distances, angles, crossings,
and the embedding. Only the orientation relative to the screen changes.

The objective is a weighted near-horizontal score:

1. for each edge, compute its length and angle;
2. measure the edge's deviation from the nearest horizontal direction;
3. give full credit to exactly horizontal edges;
4. give partial credit to edges within the default `5` degree band, using a
   smooth cosine falloff;
5. weight each edge by its geometric length.

The score also records exact, 1-degree, 3-degree, and 5-degree match counts for
diagnostics.

The search is deliberately simple and reimplementable:

1. score the current drawing at angle `0`;
2. sample many candidate angles over a half-turn period, because horizontal
   direction repeats every `pi` radians;
3. add exact candidates that would make each existing edge exactly horizontal;
4. locally refine the best angle by trying smaller steps left and right;
5. accept the angle only if it improves the score or the tie-break diagnostics.

Once an angle is selected, the UI rotates every vertex around the drawing
centroid:

```text
x' = cx + cos(a) * (x - cx) - sin(a) * (y - cy)
y' = cy + sin(a) * (x - cx) + cos(a) * (y - cy)
```

Because this is a rigid rotation, no explicit planarity check is needed after
the operation.

### Axis Alignment: Merge Nearby Coordinate Lines

Axis alignment is implemented by `PlanarVibeAlignment.alignToAxisGreedy`.

Unlike rotation, this step can change edge slopes and local geometry. Therefore
it only accepts a coordinate merge if the resulting drawing is still plane.

The operation runs separately on the `x` and `y` axes. For one axis:

1. collect all coordinates on that axis;
2. sort them;
3. estimate a data-dependent tolerance from small consecutive gaps;
4. group coordinates already within the base tolerance;
5. greedily merge adjacent groups whose gap is within a larger merge tolerance;
6. after each tentative merge, run a crossing check;
7. keep the merge only if the drawing remains crossing-free.

The merged coordinate is the weighted average of the two group coordinates,
weighted by group size:

```text
merged = (coordA * sizeA + coordB * sizeB) / (sizeA + sizeB)
```

The automatic tolerance is also intentionally simple:

```text
baseTolerance = 2 * quantile_0.2(positive consecutive gaps)
mergeTolerance = 1.5 * baseTolerance
```

with caps, minimums, and fallbacks for degenerate cases. This makes the pass
scale with the drawing instead of depending on screen pixels or a fixed graph
size.

After trying the `x` axis, the code compares the internal axis-alignment score
before and after the pass. It keeps the `x` result only if the score does not
decrease. Then it repeats the same process for `y`.

The returned result includes:

- the new position map;
- whether any merge was accepted;
- how many `x` and `y` groups were merged;
- the before/after axis-alignment score;
- the tolerances used on each axis.

The FABalancer layout runs this alignment pass automatically at the end,
for up to a small fixed number of passes. The UI also exposes it as a manual
"Align to grid" operation for any current plane drawing.

## Reimplementation Checklist

To reproduce these tricks in another codebase:

1. represent the plane graph with a rotation order at every vertex;
2. trace faces from directed half-edges;
3. choose a stable outer face, preferably from the user's current drawing when
   one exists;
4. wrap the selected outer face in a dummy cycle;
5. stellate all remaining non-triangular interior faces, splitting repeated
   face walks as needed to avoid duplicate edges;
6. run the layout on the augmented graph;
7. discard dummy vertices before returning the final drawing;
8. optionally rotate the final drawing by the best global near-horizontal
   objective;
9. optionally merge nearby `x` and `y` coordinate groups, accepting only merges
   that preserve planarity.
