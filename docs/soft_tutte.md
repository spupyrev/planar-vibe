## The simplest “slightly improved Tutte”

I would describe it as **Weighted Tutte with low-weight augmentation edges**.

### Input

* planar graph (G=(V,E)) with a fixed plane embedding
* optional augmentation edges (E_{aux})
* chosen outer face (C=(v_0,\dots,v_{k-1}))

### Output

* coordinates (p(v)\in\mathbb{R}^2)

## Step 1: choose the outer face well

use common method

## Step 2: place the outer face on a convex polygon

use common method

## Step 3: assign positive edge weights

This is the key change.

Vanilla Tutte solves, for every interior vertex (v),

[
p(v)=\frac{1}{\deg(v)}\sum_{u\in N(v)} p(u).
]

Replace that with

[
p(v)=\frac{1}{W(v)}\sum_{u\in N(v)} w_{vu},p(u),
\qquad
W(v)=\sum_{u\in N(v)} w_{vu}.
]

So each interior vertex is still a convex combination of its neighbors. The algorithm is still one linear solve. The only change is that neighbor influence is weighted.

That is the cleanest “slight improvement” to Tutte. Weighted stress-graph embeddings are exactly this direction. ([arXiv][1])

## Step 4: choose the weights for aesthetics

Here is a practical scheme a developer can implement quickly.

For each edge (e=(u,v)), define:

* (w_e = 1.0) for original edges
* (w_e = \varepsilon) for augmentation edges, with (\varepsilon\in[0.1,0.3])

This is the single most useful tweak if you augment before drawing:

* the augmentation still helps combinatorially
* but the fake edges do **not** dominate the geometry

Then optionally multiply by a local degree correction:

[
w_e \leftarrow \frac{w_e}{\sqrt{\deg(u)\deg(v)}}.
]

This reduces the tendency of hubs to over-pull the layout.

So a good default is:

[
w_{uv}=
\begin{cases}
1/\sqrt{\deg(u)\deg(v)} & \text{if } (u,v)\in E_{orig},[4pt]
\varepsilon/\sqrt{\deg(u)\deg(v)} & \text{if } (u,v)\in E_{aux}.
\end{cases}
]

This is still pure Tutte-style averaging.

## Step 5: solve the linear system

For each interior vertex (v),

[
W(v),p(v)-\sum_{u\in N(v)\cap I} w_{vu},p(u)
============================================

\sum_{u\in N(v)\cap C} w_{vu},p(u),
]

where (I) is the set of interior vertices and (C) the outer-face vertices.

Solve once for (x), once for (y).

That is it. No force iteration, no gradient descent, no extra optimization loop.

---

# Why this helps

This gives you three concrete improvements over vanilla Tutte.

## 1. Augmentation edges become “soft”

If you triangulate or add edges for connectivity, standard Tutte treats those edges exactly like real edges. That is often visually bad.

Giving them smaller weight preserves much more of the shape implied by the original graph. This follows the same weighted-stress idea studied in recent work on improving Tutte-style drawings. ([arXiv][1])

## 2. High-degree vertices stop dominating as much

Degree-normalized weights reduce visual collapse around hubs.


# Standalone algorithm description

## Weighted Tutte with soft augmentation edges

1. Compute a plane embedding of the planar graph.
2. Choose an outer face (C).
3. Place the vertices of (C) on a convex polygon.
4. For every edge (e):

   * if (e) is original, set (w_e=1/\sqrt{\deg(u)\deg(v)})
   * if (e) is added only for augmentation, set (w_e=\varepsilon/\sqrt{\deg(u)\deg(v)}), with (\varepsilon\approx 0.2)
5. For each interior vertex (v), solve
   [
   p(v)=\frac{1}{W(v)}\sum_{u\in N(v)} w_{vu}p(u).
   ]
6. Output the resulting coordinates.

---

# If you want one more tiny tweak

There is one additional modification that is still very close to Tutte:

## Boundary-jittered Tutte

After placing the outer face, perturb the boundary vertices by a very small amount to avoid accidental alignments or near-symmetries that cause flattening in weakly connected interiors.

This is tiny, but sometimes surprisingly effective.

