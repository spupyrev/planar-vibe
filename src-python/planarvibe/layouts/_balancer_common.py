"""Shared numpy primitives for the L-BFGS balancers.

These replace the per-iteration hot paths in the facebalancer / edgebalancer /
anglebalancer / fabalancer inner loops. Called many times per optimization
(one per trial step); build-once data should be produced by the caller.

Semantics are identical to the scalar Python / JS versions (bug-for-bug);
numpy just gives us C-speed batched arithmetic.
"""

from __future__ import annotations

import numpy as np


def precompute_flat_indices(row_start, row_length, neighbor_aug_indices,
                            neighbor_interior_indices, q_size):
    """Build flat arrays used by softmax / L-matrix assembly / grad step.

    Returns dict with:
      row_i_flat: (qsize,) int — which interior row each flat entry belongs to
      row_start_np: (nI,) int
      row_length_np: (nI,) int
      neighbor_aug_flat: (qsize,) int — augmented index of each flat entry
      interior_n_flat: (qsize,) int — interior index or -1
      valid_mask: (qsize,) bool — interior_n_flat >= 0
    """
    nI = len(row_start)
    row_start_np = np.asarray(row_start, dtype=np.int64)
    row_length_np = np.asarray(row_length, dtype=np.int64)

    row_i_flat = np.zeros(q_size, dtype=np.int64)
    neighbor_aug_flat = np.zeros(q_size, dtype=np.int64)
    interior_n_flat = np.full(q_size, -1, dtype=np.int64)
    for i in range(nI):
        s = row_start[i]
        l = row_length[i]
        if l == 0:
            continue
        row_i_flat[s:s + l] = i
        neighbor_aug_flat[s:s + l] = neighbor_aug_indices[i]
        interior_n_flat[s:s + l] = neighbor_interior_indices[i]
    valid_mask = interior_n_flat >= 0
    return {
        "row_i_flat": row_i_flat,
        "row_start_np": row_start_np,
        "row_length_np": row_length_np,
        "neighbor_aug_flat": neighbor_aug_flat,
        "interior_n_flat": interior_n_flat,
        "valid_mask": valid_mask,
    }


def softmax_ragged(q, flat):
    """Row-wise softmax over q using flat-index precomputation.

    Mirrors the scalar `_softmax_into` loop used in each balancer:
    subtract per-row max for numerical stability; if Z==0, fall back to uniform.
    """
    row_start_np = flat["row_start_np"]
    row_length_np = flat["row_length_np"]
    row_i_flat = flat["row_i_flat"]
    nI = row_start_np.size

    # Per-row max via reduceat. Rows with length==0 must be handled: reduceat
    # gives nonsense for empty segments; we ignore via row_length_np mask.
    # If length is 0, that row contributes no flat entries, so no harm.
    valid_rows = row_length_np > 0
    if not valid_rows.any():
        return np.zeros_like(q)

    # np.maximum.reduceat works segment-by-segment using consecutive starts;
    # empty segments would read junk. With row_length 0 possible, need to be careful.
    # But since row_start_np has one entry per row and these are just positions,
    # a zero-length row would have row_start[i] == row_start[i+1] and reduceat
    # at i would take just element row_start[i] (the start of next segment)
    # which belongs to row i+1. Its result is unused because row_length_np[i]==0
    # means no flat entries map back via row_i_flat[k]==i, so indexing skips it.
    # So it's safe even with zero-length rows.
    if q.size == 0:
        return np.zeros(0)
    maxes = np.maximum.reduceat(q, row_start_np)
    shifted = q - maxes[row_i_flat]
    ex = np.exp(shifted)
    Z = np.add.reduceat(ex, row_start_np)
    # Fallback for Z <= 0 -> uniform per row
    bad_rows = ~(Z > 0)
    if bad_rows.any():
        uniform = np.where(row_length_np > 0, 1.0 / np.maximum(row_length_np, 1), 0.0)
        Z = np.where(bad_rows, 1.0, Z)  # avoid divide-by-zero next line
        lam = ex / Z[row_i_flat]
        lam[bad_rows[row_i_flat]] = uniform[row_i_flat[bad_rows[row_i_flat]]]
        return lam
    return ex / Z[row_i_flat]


def build_L_and_b(lam, flat, x0, y0, nI):
    """Assemble the nI×nI matrix L and right-hand-side bx, by for one trial.

    L starts as identity; for each flat entry k with interior_n_flat[k]>=0,
    subtract lam[k] from L[row_i_flat[k], interior_n_flat[k]]. For flat entries
    pointing to boundary nodes, accumulate lam[k] * x0[aug], lam[k] * y0[aug]
    into bx / by.
    """
    L = np.eye(nI)
    bx = np.zeros(nI)
    by = np.zeros(nI)
    valid = flat["valid_mask"]
    row_i = flat["row_i_flat"]
    interior_n = flat["interior_n_flat"]
    neighbor_aug = flat["neighbor_aug_flat"]
    if valid.any():
        np.add.at(L, (row_i[valid], interior_n[valid]), -lam[valid])
    if (~valid).any():
        inv = ~valid
        w_inv = lam[inv]
        aug_inv = neighbor_aug[inv]
        rows_inv = row_i[inv]
        np.add.at(bx, rows_inv, w_inv * x0[aug_inv])
        np.add.at(by, rows_inv, w_inv * y0[aug_inv])
    return L, bx, by


def realize_state_np(q, flat, x0, y0, interior_aug_np, nI):
    """Solve L [x,y]^T = [bx,by]^T; return lam, L, bx, by, x, y (np arrays).

    Returns (ok, data_or_reason). On success, data is a dict with
    'lambda', 'L', 'bx', 'by', 'x', 'y'. On failure, reason string.
    L is kept around because the caller needs both the primal solve (already
    done) and an adjoint/transpose solve later on a zX, zY.
    """
    lam = softmax_ragged(q, flat)
    L, bx, by = build_L_and_b(lam, flat, x0, y0, nI)
    try:
        primal = np.linalg.solve(L, np.column_stack([bx, by]))
    except np.linalg.LinAlgError:
        return False, "linear-solve-failed"
    x1 = primal[:, 0]
    x2 = primal[:, 1]
    x = x0.copy()
    y = y0.copy()
    x[interior_aug_np] = x1
    y[interior_aug_np] = x2
    return True, {"lambda": lam, "L": L, "x": x, "y": y}


def adjoint_solve_np(L, zX, zY):
    """Solve L^T [a,b] = [zX, zY] for the adjoint step."""
    try:
        adj = np.linalg.solve(L.T, np.column_stack([zX, zY]))
    except np.linalg.LinAlgError:
        return None
    return adj[:, 0], adj[:, 1]


def assemble_grad_vec(lam, flat, ax1, ax2, x, y):
    """Given adjoint ax1, ax2 (shape nI), produce grad_vec (shape qsize).

    Mirrors the 'for each interior row, compute weighted mean over its
    neighbors, then grad[row_offset + k] = lam[k] * (ax1 * (x-meanx) + ax2 * (y-meany))'
    loop in each balancer.
    """
    row_start_np = flat["row_start_np"]
    row_i_flat = flat["row_i_flat"]
    neighbor_aug = flat["neighbor_aug_flat"]
    xk = x[neighbor_aug]
    yk = y[neighbor_aug]
    # Per-row weighted means. With ragged rows we use reduceat over the flat array.
    if lam.size == 0:
        return np.zeros(0)
    meanx_per_row = np.add.reduceat(lam * xk, row_start_np)
    meany_per_row = np.add.reduceat(lam * yk, row_start_np)
    grad = lam * (ax1[row_i_flat] * (xk - meanx_per_row[row_i_flat])
                  + ax2[row_i_flat] * (yk - meany_per_row[row_i_flat]))
    return grad


def lbfgs_direction_np(g, S, Y, Rho):
    """L-BFGS two-loop recursion. S/Y are lists of 1-D np arrays, Rho list of floats."""
    m = len(S)
    alpha = [0.0] * m
    q = g.copy()
    for i in range(m - 1, -1, -1):
        alpha[i] = Rho[i] * float(S[i] @ q)
        q = q - alpha[i] * Y[i]
    gamma = 1.0
    if m > 0:
        denom = float(Y[m - 1] @ Y[m - 1])
        if denom > 1e-14:
            gamma = float(S[m - 1] @ Y[m - 1]) / denom
    r = gamma * q
    for i in range(m):
        beta = Rho[i] * float(Y[i] @ r)
        r = r + (alpha[i] - beta) * S[i]
    return -r


def scatter_triangle_gradients(tri_a, tri_b, tri_c, coeff, x, y, zX, zY, nI,
                               interior_index_by_aug):
    """Accumulate per-triangle gradients onto zX, zY.

    dA/dxA = 0.5*(yB - yC); etc. (same formula as scalar version.)
    tri_a, tri_b, tri_c: (F,) augmented indices.
    coeff: (F,) multiplier.
    """
    dAxA = 0.5 * (y[tri_b] - y[tri_c])
    dAxB = 0.5 * (y[tri_c] - y[tri_a])
    dAxC = 0.5 * (y[tri_a] - y[tri_b])
    dAyA = 0.5 * (x[tri_c] - x[tri_b])
    dAyB = 0.5 * (x[tri_a] - x[tri_c])
    dAyC = 0.5 * (x[tri_b] - x[tri_a])

    ia = interior_index_by_aug[tri_a]
    ib = interior_index_by_aug[tri_b]
    ic = interior_index_by_aug[tri_c]

    ma = ia >= 0
    mb = ib >= 0
    mc = ic >= 0
    if ma.any():
        np.add.at(zX, ia[ma], (coeff * dAxA)[ma])
        np.add.at(zY, ia[ma], (coeff * dAyA)[ma])
    if mb.any():
        np.add.at(zX, ib[mb], (coeff * dAxB)[mb])
        np.add.at(zY, ib[mb], (coeff * dAyB)[mb])
    if mc.any():
        np.add.at(zX, ic[mc], (coeff * dAxC)[mc])
        np.add.at(zY, ic[mc], (coeff * dAyC)[mc])


def scatter_edge_gradients(edge_u, edge_v, coeff, dx, dy, zX, zY,
                           interior_index_by_aug):
    """Scatter per-edge gradient contributions.

    For each edge (u, v) with multiplier coeff[i], scatter
    (+coeff*dx, +coeff*dy) onto u's interior slot and (-coeff*dx, -coeff*dy)
    onto v's interior slot.
    """
    iu = interior_index_by_aug[edge_u]
    iv = interior_index_by_aug[edge_v]
    mu = iu >= 0
    mv = iv >= 0
    if mu.any():
        np.add.at(zX, iu[mu], (coeff * dx)[mu])
        np.add.at(zY, iu[mu], (coeff * dy)[mu])
    if mv.any():
        np.add.at(zX, iv[mv], (-coeff * dx)[mv])
        np.add.at(zY, iv[mv], (-coeff * dy)[mv])
