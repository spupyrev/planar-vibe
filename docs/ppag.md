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

