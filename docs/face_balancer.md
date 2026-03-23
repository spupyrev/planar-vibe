# FaceBalancer

This document gives a complete implementation recipe for drawing a **plane graph** with **all bounded faces as equal in area as possible**, while preserving the given embedding and keeping the drawing planar at every iteration.

The method is:

1. Triangulate the given plane graph.
2. Fix the outer-face vertices on a strictly convex polygon.
3. Parameterize all interior vertex positions by **positive barycentric weights**.
4. Optimize the weights to minimize the variance of the original face areas.
5. Recover the straight-line drawing from the optimized weights.

The parameterization guarantees planarity at every step, so there is no need to test edge crossings during optimization.

This document is self-contained and uses only basic numerical linear algebra and calculus. No third-party libraries are assumed.

---

## 1. Problem statement

### Input

You are given a **plane graph** `G`, meaning:

- the graph is planar,
- a specific combinatorial embedding is fixed,
- the clockwise/counterclockwise order of edges around each vertex is part of the input.

You are also given:

- the list of bounded faces of `G`,
- the outer face of `G`,
- a triangulation `T` of the embedding obtained by adding non-crossing diagonals inside faces,
- fixed coordinates for the vertices on the outer face of `T`, placed on a strictly convex polygon.

### Output

A straight-line planar drawing of the original graph `G` such that the bounded face areas are as equal as possible.

---

## 2. High-level idea

The main obstacle is preserving planarity during optimization. Directly optimizing vertex coordinates is awkward because you must prevent edge crossings and face flips.

Instead, optimize over **barycentric weights**.

For each interior vertex `u`, choose positive weights on its neighbors summing to 1, and require:

\[
p_u = \sum_{v \in N(u)} \lambda_{u,v} \, p_v.
\]

Here `p_u = (x_u, y_u)` is the position of `u`.

If the outer-face vertices are fixed on a strictly convex polygon and every interior vertex is expressed as a strict convex combination of its neighbors, then the resulting straight-line drawing of the triangulation is planar and every face is convex.

Therefore, if we use the weights as optimization variables, every iterate remains planar automatically.

---

## 3. Data model

Assume the triangulated plane graph is

- `T = (V, E)`

with:

- `B`: ordered list of boundary vertices (the outer face),
- `I = V \ B`: interior vertices.

For each interior vertex `u`:

- `N[u] = [v_0, v_1, ..., v_{d-1}]`: the neighbor list of `u` in any fixed order,
- `deg(u) = len(N[u])`.

You also need:

- `outer_pos[b] = (x_b, y_b)` for each `b in B`,
- `orig_faces`: the list of bounded faces of the original graph `G`,
- `tris_in_face[f]`: for each original face `f`, the list of triangles of `T` contained in `f`.

The triangulation edges are auxiliary only. They are used to parameterize the drawing and compute face areas. After optimization, ignore the auxiliary edges and keep only the original edges of `G`.

---

## 4. Optimization variables

For each interior vertex `u` and each neighbor index `k`, introduce a real number:

\[
\theta_{u,k} \in \mathbb{R}.
\]

These are unconstrained variables.

Convert them to positive weights using a row-wise softmax:

\[
\lambda_{u,k} = \frac{e^{\theta_{u,k}}}{\sum_{j=0}^{d-1} e^{\theta_{u,j}}}.
\]

Then automatically:

- `lambda[u][k] > 0`,
- `sum_k lambda[u][k] = 1`.

Let `v_k = N[u][k]`. Then the barycentric equation is:

\[
p_u = \sum_{k=0}^{d-1} \lambda_{u,k} \, p_{v_k}.
\]

---

## 5. Linear systems for coordinates

### 5.1 Interior vertex indexing

Assign each interior vertex an index:

- `idx[u] in {0, 1, ..., nI-1}` where `nI = |I|`.

We solve separately for the x-coordinates and y-coordinates of the interior vertices.

### 5.2 Matrix construction

For each interior vertex `u`, the barycentric equation becomes:

\[
p_u - \sum_{v \in N(u)\cap I} \lambda_{u,v} p_v
=
\sum_{b \in N(u)\cap B} \lambda_{u,b} p_b.
\]

This yields a linear system:

\[
L X = b_x, \qquad L Y = b_y.
\]

Where:

- `X[i] = x_u` for `u` with `idx[u] = i`,
- `Y[i] = y_u`.

The matrix `L` is `nI x nI` and defined by:

- `L[idx[u], idx[u]] = 1`,
- if `v in I` is a neighbor of `u`, then `L[idx[u], idx[v]] -= lambda_{u,v}`.

The right-hand sides accumulate contributions from boundary neighbors:

- if `b in B` is a neighbor of `u`, then
  - `b_x[idx[u]] += lambda_{u,b} * outer_pos[b].x`,
  - `b_y[idx[u]] += lambda_{u,b} * outer_pos[b].y`.

### 5.3 Solving

Solve the two systems:

- `X = solve_linear_system(L, b_x)`
- `Y = solve_linear_system(L, b_y)`

This gives the coordinates of all interior vertices.

---

## 6. Triangle and face areas

### 6.1 Signed area of a triangle

For points `a=(x_a,y_a)`, `b=(x_b,y_b)`, `c=(x_c,y_c)` define:

\[
\Delta(a,b,c)
=
\frac{1}{2}
\Bigl(
(x_b-x_a)(y_c-y_a)
-
(x_c-x_a)(y_b-y_a)
\Bigr).
\]

In a valid planar triangulation with consistent face orientation, these areas are positive.

### 6.2 Area of an original face

Each original face `f` is partitioned by triangulation into triangles. Its area is:

\[
A_f = \sum_{\tau \in \mathrm{tris\_in\_face}[f]} \Delta(\tau).
\]

---

## 7. Objective function

Let:

- `m = number of original bounded faces`.

The total bounded area is:

\[
A_{\text{tot}} = \sum_{f} A_f.
\]

The target equal area is:

\[
A^\star = \frac{A_{\text{tot}}}{m}.
\]

Define the residual of each face:

\[
r_f = \frac{A_f}{A^\star} - 1.
\]

The optimization objective is:

\[
E = \sum_f r_f^2.
\]

This is the relative squared face-area variance around the target.

A perfect equal-area drawing has `E = 0`.

---

## 8. Gradient of the objective

The optimizer needs the gradient of `E` with respect to all logits `theta[u][k]`.

Compute it in two stages:

1. compute derivatives of `E` with respect to interior coordinates `X` and `Y`,
2. use an adjoint solve to convert these into derivatives with respect to `theta`.

---

## 9. Derivatives of triangle area with respect to coordinates

For triangle `(a,b,c)`,

\[
\Delta = \frac{1}{2}\bigl((x_b-x_a)(y_c-y_a) - (x_c-x_a)(y_b-y_a)\bigr).
\]

Its coordinate derivatives are:

\[
\frac{\partial \Delta}{\partial x_a} = \frac{1}{2}(y_b-y_c),
\qquad
\frac{\partial \Delta}{\partial x_b} = \frac{1}{2}(y_c-y_a),
\qquad
\frac{\partial \Delta}{\partial x_c} = \frac{1}{2}(y_a-y_b),
\]

\[
\frac{\partial \Delta}{\partial y_a} = \frac{1}{2}(x_c-x_b),
\qquad
\frac{\partial \Delta}{\partial y_b} = \frac{1}{2}(x_a-x_c),
\qquad
\frac{\partial \Delta}{\partial y_c} = \frac{1}{2}(x_b-x_a).
\]

For each original face `f`:

\[
\frac{\partial E}{\partial A_f}
=
2 \left(\frac{A_f}{A^\star} - 1\right)\frac{1}{A^\star}
=
\frac{2 r_f}{A^\star}.
\]

Define:

\[
c_f = \frac{2 r_f}{A^\star}.
\]

Then for each triangle inside face `f`, accumulate `c_f` times the triangle-area coordinate derivatives into global vectors:

- `zX[i] = dE/dX[i]`
- `zY[i] = dE/dY[i]`

for interior vertices only.

---

## 10. Adjoint method

The coordinate systems are:

\[
L X = b_x, \qquad L Y = b_y.
\]

The matrix `L` depends on the logits `theta`, and so do `X` and `Y`.

Instead of differentiating `X` and `Y` separately with respect to every logit, solve two adjoint systems:

\[
L^T \alpha_x = zX, \qquad L^T \alpha_y = zY.
\]

Then the derivative with respect to each logit can be computed locally.

---

## 11. Logit-to-weight derivative

Fix an interior vertex `u`. Let its local softmax weights be:

\[
w_k = \lambda_{u,k}, \qquad k=0,\dots,d-1.
\]

Then:

\[
\frac{\partial w_j}{\partial \theta_{u,k}}
=
w_j (\delta_{jk} - w_k).
\]

Only row `u` of the matrix `L` depends on the logits of `u`.

Let the neighbor positions be:

- `p_k = (x_k, y_k)` for neighbor `N[u][k]`.

Define the weighted neighbor means:

\[
\bar{x}_u = \sum_{j=0}^{d-1} w_j x_j,
\qquad
\bar{y}_u = \sum_{j=0}^{d-1} w_j y_j.
\]

Then:

\[
\sum_j \frac{\partial L_{u,j}}{\partial \theta_{u,k}} X_j
=
- w_k (x_k - \bar{x}_u),
\]

\[
\sum_j \frac{\partial L_{u,j}}{\partial \theta_{u,k}} Y_j
=
- w_k (y_k - \bar{y}_u).
\]

Therefore the gradient of the objective with respect to each local logit is:

\[
\frac{\partial E}{\partial \theta_{u,k}}
=
-
\alpha_x[u] \cdot \bigl(-w_k(x_k-\bar{x}_u)\bigr)
-
\alpha_y[u] \cdot \bigl(-w_k(y_k-\bar{y}_u)\bigr).
\]

Equivalently:

\[
\frac{\partial E}{\partial \theta_{u,k}}
=
w_k \Bigl(
\alpha_x[u](x_k-\bar{x}_u)
+
\alpha_y[u](y_k-\bar{y}_u)
\Bigr).
\]

This is the formula to implement.

---

## 12. Complete pseudocode

### 12.1 Top-level solve

```text
function equalize_face_areas(T, B, outer_pos, orig_faces, tris_in_face,
                             num_restarts, max_iters,
                             grad_tol, step_tol):

    I = vertices(T) minus B
    build idx[u] for u in I
    build neighbor lists N[u] for u in I

    best_E = +infinity
    best_theta = null
    best_pos = null
    best_face_areas = null

    for restart from 0 to num_restarts-1:

        if restart == 0:
            theta = initialize_zero_logits(I, N)
        else:
            theta = initialize_random_logits(I, N, sigma = 0.1)

        theta = lbfgs_optimize(theta,
                               T, B, outer_pos,
                               I, idx, N,
                               orig_faces, tris_in_face,
                               max_iters, grad_tol, step_tol)

        (E, grad, pos, face_areas) =
            evaluate_objective_and_gradient(theta,
                                            T, B, outer_pos,
                                            I, idx, N,
                                            orig_faces, tris_in_face)

        if E < best_E:
            best_E = E
            best_theta = deep_copy(theta)
            best_pos = pos
            best_face_areas = face_areas

    return (best_theta, best_pos, best_face_areas, best_E)
```

---

### 12.2 Objective and gradient

```text
function evaluate_objective_and_gradient(theta,
                                         T, B, outer_pos,
                                         I, idx, N,
                                         orig_faces, tris_in_face):

    lambda = softmax_weights(theta, I, N)

    (L, bx, by) = build_linear_system(lambda, T, B, outer_pos, I, idx, N)

    X = solve_linear_system(L, bx)
    Y = solve_linear_system(L, by)

    pos = assemble_positions(X, Y, I, idx, B, outer_pos)

    # Compute triangle areas
    tri_area = empty map
    for each triangle tau=(a,b,c) in faces(T):
        tri_area[tau] = signed_area(pos[a], pos[b], pos[c])

    # Compute original face areas
    face_areas = empty map
    total_area = 0
    for each face f in orig_faces:
        A = 0
        for each triangle tau in tris_in_face[f]:
            A += tri_area[tau]
        face_areas[f] = A
        total_area += A

    m = number of faces in orig_faces
    Astar = total_area / m

    residual = empty map
    E = 0
    for each face f in orig_faces:
        r = face_areas[f] / Astar - 1
        residual[f] = r
        E += r * r

    # Coordinate gradients dE/dX and dE/dY on interior vertices
    zX = zero vector of length |I|
    zY = zero vector of length |I|

    for each face f in orig_faces:
        coeff = 2 * residual[f] / Astar

        for each triangle tau=(a,b,c) in tris_in_face[f]:
            accumulate_triangle_area_gradient(coeff, a, b, c,
                                              pos, I, idx, zX, zY)

    # Adjoint solves
    alphaX = solve_linear_system(transpose(L), zX)
    alphaY = solve_linear_system(transpose(L), zY)

    # Gradient with respect to logits
    grad = same shape as theta

    for each interior vertex u in I:
        d = length(N[u])

        meanx = 0
        meany = 0
        for k from 0 to d-1:
            v = N[u][k]
            wk = lambda[u][k]
            meanx += wk * pos[v].x
            meany += wk * pos[v].y

        iu = idx[u]
        for k from 0 to d-1:
            v = N[u][k]
            wk = lambda[u][k]
            grad[u][k] =
                wk * ( alphaX[iu] * (pos[v].x - meanx)
                     + alphaY[iu] * (pos[v].y - meany) )

    return (E, grad, pos, face_areas)
```

---

### 12.3 Softmax weights

```text
function softmax_weights(theta, I, N):

    lambda = same shape as theta

    for each interior vertex u in I:
        d = length(N[u])

        m = theta[u][0]
        for k from 1 to d-1:
            if theta[u][k] > m:
                m = theta[u][k]

        Z = 0
        tmp = array length d

        for k from 0 to d-1:
            tmp[k] = exp(theta[u][k] - m)
            Z += tmp[k]

        for k from 0 to d-1:
            lambda[u][k] = tmp[k] / Z

    return lambda
```

---

### 12.4 Build linear system

```text
function build_linear_system(lambda, T, B, outer_pos, I, idx, N):

    nI = |I|
    L = zero matrix nI x nI
    bx = zero vector length nI
    by = zero vector length nI

    boundary_set = set(B)

    for each interior vertex u in I:
        iu = idx[u]
        L[iu][iu] = 1

        d = length(N[u])
        for k from 0 to d-1:
            v = N[u][k]
            w = lambda[u][k]

            if v in boundary_set:
                bx[iu] += w * outer_pos[v].x
                by[iu] += w * outer_pos[v].y
            else:
                iv = idx[v]
                L[iu][iv] -= w

    return (L, bx, by)
```

---

### 12.5 Assemble positions

```text
function assemble_positions(X, Y, I, idx, B, outer_pos):

    pos = empty map

    for each boundary vertex b in B:
        pos[b] = outer_pos[b]

    for each interior vertex u in I:
        iu = idx[u]
        pos[u] = (X[iu], Y[iu])

    return pos
```

---

### 12.6 Triangle signed area

```text
function signed_area(pa, pb, pc):

    return 0.5 * ( (pb.x - pa.x) * (pc.y - pa.y)
                 - (pc.x - pa.x) * (pb.y - pa.y) )
```

---

### 12.7 Triangle-area gradient accumulation

```text
function accumulate_triangle_area_gradient(coeff, a, b, c,
                                           pos, I, idx, zX, zY):

    xa = pos[a].x
    ya = pos[a].y
    xb = pos[b].x
    yb = pos[b].y
    xc = pos[c].x
    yc = pos[c].y

    dAx_a = 0.5 * (yb - yc)
    dAx_b = 0.5 * (yc - ya)
    dAx_c = 0.5 * (ya - yb)

    dAy_a = 0.5 * (xc - xb)
    dAy_b = 0.5 * (xa - xc)
    dAy_c = 0.5 * (xb - xa)

    if a in idx:
        ia = idx[a]
        zX[ia] += coeff * dAx_a
        zY[ia] += coeff * dAy_a

    if b in idx:
        ib = idx[b]
        zX[ib] += coeff * dAx_b
        zY[ib] += coeff * dAy_b

    if c in idx:
        ic = idx[c]
        zX[ic] += coeff * dAx_c
        zY[ic] += coeff * dAy_c
```

---

## 13. Optimizer: L-BFGS pseudocode

Any smooth unconstrained optimizer works. L-BFGS is a good default.

The pseudocode below is enough to implement a working version from scratch.

### 13.1 Flattening

Store all logits in one vector `q`. Provide routines:

- `pack(theta) -> q`
- `unpack(q) -> theta`

All vector operations below are on `q`.

### 13.2 Two-loop recursion

```text
function lbfgs_direction(g, S, Y, Rho):
    # returns approximate inverse-Hessian times gradient
    # S[i] = s_i = q_{i+1} - q_i
    # Y[i] = y_i = g_{i+1} - g_i
    # Rho[i] = 1 / dot(y_i, s_i)

    m = length(S)
    alpha = array length m
    q = copy(g)

    for i from m-1 downto 0:
        alpha[i] = Rho[i] * dot(S[i], q)
        q = q - alpha[i] * Y[i]

    if m > 0:
        gamma = dot(S[m-1], Y[m-1]) / dot(Y[m-1], Y[m-1])
    else:
        gamma = 1

    r = gamma * q

    for i from 0 to m-1:
        beta = Rho[i] * dot(Y[i], r)
        r = r + S[i] * (alpha[i] - beta)

    return -r
```

### 13.3 Backtracking line search

```text
function backtracking_line_search(q, E, g, d, evaluate):
    alpha = 1.0
    c1 = 1e-4
    tau = 0.5

    gtd = dot(g, d)

    while true:
        q_new = q + alpha * d
        (E_new, g_new, pos_new, face_areas_new) = evaluate(q_new)

        if E_new <= E + c1 * alpha * gtd:
            return (alpha, E_new, g_new, pos_new, face_areas_new)

        alpha = alpha * tau

        if alpha < 1e-12:
            return (0, E, g, null, null)
```

### 13.4 Main L-BFGS loop

```text
function lbfgs_optimize(theta0,
                        T, B, outer_pos,
                        I, idx, N,
                        orig_faces, tris_in_face,
                        max_iters, grad_tol, step_tol):

    q = pack(theta0)

    define evaluate(q_input):
        theta_input = unpack(q_input)
        (E, grad_theta, pos, face_areas) =
            evaluate_objective_and_gradient(theta_input,
                                            T, B, outer_pos,
                                            I, idx, N,
                                            orig_faces, tris_in_face)
        g = pack(grad_theta)
        return (E, g, pos, face_areas)

    (E, g, pos, face_areas) = evaluate(q)

    memory = 10
    S = empty list
    Y = empty list
    Rho = empty list

    for iter from 0 to max_iters-1:

        if norm(g) < grad_tol:
            break

        d = lbfgs_direction(g, S, Y, Rho)

        (alpha, E_new, g_new, pos_new, face_areas_new) =
            backtracking_line_search(q, E, g, d, evaluate)

        if alpha == 0:
            break

        q_new = q + alpha * d
        s = q_new - q
        y = g_new - g

        if norm(s) < step_tol:
            q = q_new
            break

        ys = dot(y, s)
        if ys > 1e-14:
            if length(S) == memory:
                remove first element from S
                remove first element from Y
                remove first element from Rho

            append s to S
            append y to Y
            append (1 / ys) to Rho

        q = q_new
        E = E_new
        g = g_new

    return unpack(q)
```

---

## 14. Linear solver from scratch

You need a routine:

- `solve_linear_system(A, b)`

Since no dependencies are allowed, the simplest implementation is dense Gaussian elimination with partial pivoting.

That is acceptable for small or medium graphs.

### 14.1 Gaussian elimination with partial pivoting

```text
function solve_linear_system(A, b):
    # A is an n x n matrix, b is a vector length n
    # returns x such that A x = b

    n = number of rows of A
    M = copy of A
    rhs = copy of b

    # Forward elimination
    for k from 0 to n-1:

        # Pivot selection
        pivot_row = k
        pivot_value = abs(M[k][k])

        for i from k+1 to n-1:
            if abs(M[i][k]) > pivot_value:
                pivot_value = abs(M[i][k])
                pivot_row = i

        if pivot_value == 0:
            error "singular matrix"

        # Swap rows if needed
        if pivot_row != k:
            swap rows M[k] and M[pivot_row]
            swap rhs[k] and rhs[pivot_row]

        # Eliminate below pivot
        for i from k+1 to n-1:
            factor = M[i][k] / M[k][k]
            M[i][k] = 0
            for j from k+1 to n-1:
                M[i][j] -= factor * M[k][j]
            rhs[i] -= factor * rhs[k]

    # Back substitution
    x = zero vector length n
    for i from n-1 downto 0:
        s = rhs[i]
        for j from i+1 to n-1:
            s -= M[i][j] * x[j]
        x[i] = s / M[i][i]

    return x
```

For larger graphs, replace this with a sparse solver, but the algorithm itself does not depend on doing so.

---

## 15. Initialization

Use either:

- all-zero logits,
- or small random perturbations around zero.

### 15.1 Uniform initial weights

If `theta[u][k] = 0` for all `u,k`, then all weights at each vertex are uniform:

\[
\lambda_{u,k} = \frac{1}{\deg(u)}.
\]

This is a good default initialization.

### 15.2 Random restarts

For restart number greater than 0:

- initialize `theta[u][k]` as small random values, for example in `[-0.1, 0.1]`.

This helps escape poor local minima.

---

## 16. Stopping criteria

Good practical stopping conditions are:

- gradient norm smaller than `1e-8`,
- line-search step norm smaller than `1e-12`,
- maximum iteration count reached.

Recommended defaults:

- `num_restarts = 10`
- `max_iters = 300`
- `grad_tol = 1e-8`
- `step_tol = 1e-12`

---

## 17. Output drawing

After optimization:

1. keep the final coordinates of all vertices,
2. draw only the original edges of `G`,
3. ignore the auxiliary triangulation diagonals.

The resulting drawing is straight-line and planar, because it is a subdrawing of the planar triangulation.

---

## 18. Why planarity is guaranteed

At every iteration:

- the outer face is fixed and strictly convex,
- all barycentric weights are positive,
- each interior vertex is a strict convex combination of its neighbors.

Under this parameterization, the resulting straight-line drawing of the triangulation is planar with convex faces. Therefore, every iterate is valid.

This is why the algorithm never needs edge-crossing tests or inequality constraints.

---

## 19. Numerical notes

### 19.1 Softmax stability

Always subtract the maximum logit before exponentiating:

\[
\lambda_k = \frac{e^{\theta_k - m}}{\sum_j e^{\theta_j - m}},
\qquad m = \max_j \theta_j.
\]

This prevents overflow.

### 19.2 Degenerate triangles

The parameterization should avoid invalid drawings, but triangles may become numerically very small near difficult optima. If needed, add a small regularization term penalizing short edges or very small triangle areas.

### 19.3 Dense vs sparse implementation

The formulas are the same either way. A dense solver is enough to implement the algorithm exactly. Sparse data structures only improve speed.

---

## 20. Minimal implementation checklist

A complete implementation needs these functions:

- `softmax_weights`
- `build_linear_system`
- `solve_linear_system`
- `assemble_positions`
- `signed_area`
- `accumulate_triangle_area_gradient`
- `evaluate_objective_and_gradient`
- `lbfgs_direction`
- `backtracking_line_search`
- `lbfgs_optimize`
- `equalize_face_areas`

With those routines, the algorithm is fully specified.

---

## 21. Summary

The exact implementation pipeline is:

1. Triangulate the plane graph.
2. Fix the outer face on a strictly convex polygon.
3. Store one unconstrained logit per interior-vertex/neighbor pair.
4. Convert logits to positive weights by softmax.
5. Solve barycentric linear systems for the interior coordinates.
6. Compute original face areas by summing triangulation triangle areas.
7. Minimize the relative squared face-area error using L-BFGS.
8. Use adjoint solves to compute the gradient efficiently.
9. After convergence, discard auxiliary diagonals and keep the original graph drawing.

This gives a practical, exact, dependency-free specification of the algorithm.

---
