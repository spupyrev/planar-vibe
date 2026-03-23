# Air

This section gives a complete, dependency-free description of the air-pressure algorithm
from Section 8 of Kleist's dissertation. To make the procedure fully implementable, this
document fixes the graph class to the case that is actually proved to support the move
step: a plane triangulation with positive target areas on all inner faces.

The algorithm keeps the outer face fixed. It repeatedly picks one unbalanced inner vertex,
computes the unique position where the force on that vertex becomes zero while all incident
triangles stay non-degenerate, and moves the vertex there. A round-robin selection rule is
used so the method is deterministic and attentive.

Implementation note for this codebase:

- The UI layout implementation uses this triangulation-based method as an internal solver
  for making the original bounded face areas as equal as possible.
- If an original bounded face is not triangular, the implementation stellates that face by
  adding one auxiliary center vertex and splitting the face into triangles.
- The target area of an original bounded face is the common desired bounded-face area.
  Each auxiliary triangle inside that face receives an equal share of that target.
- The outer face is kept as a fixed convex polygon and is not part of the equal-area
  objective.

## 1. Input and Output

Input:

- A plane triangulation `T = (V, E, F)` with a fixed combinatorial embedding.
- For every vertex `v`, its initial coordinates `pos[v] = (x_v, y_v)`.
- The outer face `f_out`, whose three vertices are fixed forever.
- A positive target area `A[f] > 0` for every inner face `f`.
- The initial drawing must be a straight-line planar drawing with all inner faces oriented
  counterclockwise and all inner face areas positive.
- The outer triangle area must equal `sum_f A[f]` over all inner faces.

Output:

- Either a drawing whose face areas match the targets up to tolerance, or a deadlock:
  every inner vertex is balanced but some face area is still wrong.

This is the exact behavior proved in Section 8 for triangulations: the process converges to
either a realizing drawing or a deadlock.

## 2. Required Data Structures

Use only plain arrays and maps.

- `vertices`: array of vertex ids.
- `faces`: array of inner triangular faces.
- `faceVerts[f] = [a, b, c]`, always listed counterclockwise.
- `targetArea[f] = A[f]`.
- `isOuterVertex[v]`.
- For each inner vertex `v`, store its incident faces in cyclic order around `v`.

For a triangulation, each incident face of `v` contributes one opposite edge. If the
neighbors of `v` in cyclic order are

`u[0], u[1], ..., u[k-1]`,

then the incident faces are exactly

`f[i] = (u[i], v, u[(i+1) mod k])`

in counterclockwise order around `v`.

For each pair `(v, f[i])`, precompute:

- `left[v][i]  = u[i]`
- `right[v][i] = u[(i+1) mod k]`

These remain valid because the embedding never changes.

## 3. Geometry Primitives

Implement the following scalar and vector operations.

For vectors `p = (px, py)` and `q = (qx, qy)`:

- `sub(p, q) = (px - qx, py - qy)`
- `add(p, q) = (px + qx, py + qy)`
- `mul(s, p) = (s * px, s * py)`
- `dot(p, q) = px*qx + py*qy`
- `cross(p, q) = px*qy - py*qx`
- `rot90(p) = (-py, px)`  // counterclockwise rotation by 90 degrees
- `norm(p) = sqrt(dot(p, p))`

Signed area of a triangle:

`signedArea(a, b, c) = 0.5 * cross(b - a, c - a)`

Since all inner faces are stored counterclockwise, every current face area must satisfy
`signedArea(a, b, c) > 0`.

## 4. Pressure, Force, and Entropy

For a fixed inner vertex `v`, only the faces incident to `v` matter while moving `v`.
Assume face `f[i] = (u[i], v, u[i+1])` in counterclockwise order.

Define

- `s_i = pos[u[i]] - pos[u[i+1]]`
- `r_i = rot90(s_i)`

If `p` is a candidate position of `v`, the area of the incident triangle is

`area_i(p) = 0.5 * cross(pos[u[i]] - pos[u[i+1]], p - pos[u[i+1]])`

Equivalently,

`area_i(p) = 0.5 * dot(r_i, p - pos[u[i+1]])`

The candidate position is feasible if and only if all `area_i(p) > 0`. For a triangulation,
this condition is exactly what is needed for moving `v` without creating crossings.

Pressure of face `f[i]` at `p`:

`pressure_i(p) = targetArea[f[i]] / area_i(p)`

Force contribution of that face on `v`:

`force_i(p) = pressure_i(p) * r_i`

Total force on `v`:

`F_v(p) = sum_i force_i(p)`

Vertex `v` is balanced at `p` iff `F_v(p) = (0, 0)`.

Local entropy contributed by incident faces:

`E_v(p) = sum_i -targetArea[f[i]] * log(pressure_i(p))`

Because `pressure_i(p) = targetArea[f[i]] / area_i(p)`, this is the same as

`E_v(p) = constant + sum_i targetArea[f[i]] * log(area_i(p))`

The constant can be ignored when optimizing. The gradient of `E_v` is

`grad E_v(p) = 0.5 * F_v(p)`

The Hessian is

`H_v(p) = -(1/4) * sum_i (targetArea[f[i]] / area_i(p)^2) * (r_i r_i^T)`

This is a `2 x 2` matrix. For triangulations with positive target areas it is negative
definite on the feasible region, so the balanced position is unique.

If `r_i = (rx_i, ry_i)`, then the Hessian entries are

- `a = -(1/4) * sum_i targetArea[f[i]] * rx_i * rx_i / area_i(p)^2`
- `b = -(1/4) * sum_i targetArea[f[i]] * rx_i * ry_i / area_i(p)^2`
- `c = -(1/4) * sum_i targetArea[f[i]] * ry_i * ry_i / area_i(p)^2`

so `H_v(p) = [[a, b], [b, c]]`.

## 5. Numerical Solver for the Balanced Position

Section 8 proves existence and uniqueness of the balanced position, but not a closed-form
formula. The implementation below uses damped Newton ascent on `E_v(p)`. It needs only
`log`, `sqrt`, and basic arithmetic.

Parameters:

- `tolForceVertex = 1e-10`
- `tolAreaPositive = 1e-14`
- `maxNewtonIter = 50`
- `armijo = 1e-4`
- `minStep = 2^-40`

Helper routines:

`localState(v, p)` returns:

- `feasible`: true iff every `area_i(p) > tolAreaPositive`
- all `area_i(p)`
- if feasible:
  - all `pressure_i(p)`
  - force `F_v(p)`
  - entropy `E_v(p)`
  - Hessian entries `a, b, c`

If `feasible` is false, the routine does not evaluate `log(area_i(p))`.

Pseudocode:

```text
function solveBalancedPosition(v, currentPos):
    p = currentPos

    repeat at most maxNewtonIter times:
        state = localState(v, p)
        if any state.area_i <= tolAreaPositive:
            error("current position became degenerate")

        F = state.force
        if norm(F) <= tolForceVertex:
            return p

        g = 0.5 * F
        H = state.hessian   // [[a, b], [b, c]]

        det = a*c - b*b
        if det <= 0:
            d = g
        else:
            // Solve H d = -g exactly for a 2x2 matrix.
            d.x = (b*g.y - c*g.x) / det
            d.y = (b*g.x - a*g.y) / det
            if not finite(d.x) or not finite(d.y):
                d = g

        if dot(g, d) <= 0:
            d = g

        alpha = 1.0
        accepted = false
        while alpha >= minStep:
            q = p + alpha * d
            qState = localState(v, q)

            if qState.feasible and
               qState.entropy >= state.entropy + armijo * alpha * dot(g, d):
                p = q
                accepted = true
                break

            alpha = 0.5 * alpha

        if not accepted:
            return p

    return p
```

Notes:

- Returning `p` after a failed line search is safe. It means the numerical solver stalled.
  The caller should then treat the vertex as effectively balanced if `norm(F_v(p))` is
  already tiny; otherwise it may stop with a numerical-failure status.
- In practice, because the entropy is smooth and strictly concave on the feasible region,
  the Newton step with backtracking is stable.

## 6. Global Air-Pressure Iteration

Use a deterministic round-robin rule over inner vertices. This is attentive because every
vertex is revisited infinitely often unless the algorithm stops.

Parameters:

- `tolForceGlobal = 1e-8`
- `tolAreaGlobal = 1e-8`
- `tolMove = 1e-15`
- `maxSweeps = 100000`

Relative face-area error:

`relErr(f) = abs(area(f) - targetArea[f]) / targetArea[f]`

Balanced test for one vertex:

`balanced(v) <=> norm(F_v(pos[v])) <= tolForceGlobal`

Realized test:

`realized <=> max_f relErr(f) <= tolAreaGlobal`

Deadlock test:

`deadlock <=> realized is false and every inner vertex is balanced`

Pseudocode:

```text
function airPressureTriangulation():
    innerVertices = all non-outer vertices in a fixed order

    for sweep in 1 .. maxSweeps:
        movedSomething = false

        for v in innerVertices:
            F = forceAtCurrentPosition(v)
            if norm(F) <= tolForceGlobal:
                continue

            oldPos = pos[v]
            newPos = solveBalancedPosition(v, oldPos)
            pos[v] = newPos

            if norm(newPos - oldPos) > tolMove:
                movedSomething = true

        if maxFaceRelativeError() <= tolAreaGlobal:
            return SUCCESS

        allBalanced = true
        for v in innerVertices:
            if norm(forceAtCurrentPosition(v)) > tolForceGlobal:
                allBalanced = false
                break

        if allBalanced:
            return DEADLOCK

        if not movedSomething:
            return STALLED

    return MAX_SWEEPS_REACHED
```

## 7. How to Compute `forceAtCurrentPosition(v)`

For each incident face `f[i] = (u[i], v, u[i+1])`:

1. Compute `s_i = pos[u[i]] - pos[u[i+1]]`.
2. Compute `r_i = rot90(s_i)`.
3. Compute `a_i = 0.5 * cross(pos[u[i]] - pos[u[i+1]], pos[v] - pos[u[i+1]])`.
4. Compute `p_i = targetArea[f[i]] / a_i`.
5. Add `p_i * r_i` to the force sum.

This is enough; there is no need to normalize `r_i`.

## 8. How to Compute the Face Error

For every inner face `f = (a, b, c)`:

`currentArea[f] = signedArea(pos[a], pos[b], pos[c])`

The face must remain counterclockwise, so `currentArea[f] > 0`.

Then compute:

`relErr(f) = abs(currentArea[f] - targetArea[f]) / targetArea[f]`

The current drawing is accepted when the maximum relative error over all inner faces is at
most `tolAreaGlobal`.

## 9. Complexity

Let `deg(v)` be the degree of vertex `v`.

- One force evaluation at `v` costs `O(deg(v))`.
- One Newton iteration for `v` costs `O(deg(v))`.
- One balanced-position solve costs `O(maxNewtonIter * deg(v))`.
- One full sweep over all inner vertices costs
  `O(maxNewtonIter * sum_v deg(v)) = O(maxNewtonIter * |E|)`.

In a triangulation, `|E| = O(|V|)`, so one sweep is linear in the graph size up to the
Newton iteration cap.

## 10. Scope and Limitations

This document intentionally describes the fully implementable version supported by the
proofs in Section 8:

- plane triangulations,
- positive target areas,
- fixed outer triangle,
- per-vertex moves to the unique balanced position.

The dissertation also proves that plane cubic graphs have no deadlocks, but it does not
provide a complete move procedure for them analogous to the triangulation case. So a
complete implementation-ready algorithm should not claim more than the triangulation case.
