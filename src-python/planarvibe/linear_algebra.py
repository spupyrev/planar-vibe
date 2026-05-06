"""Small dense linear-algebra helpers shared by layout code.

Literal port of static/js/linear-algebra.js. Uses plain Python lists for row
ordering / pivoting to match the JS pivot semantics exactly; numeric output
should be bit-close to JS (modulo floating-point fma differences).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class LUFactor:
    LU: list[list[float]]
    piv: list[int]


def _clone_matrix(A: list[list[float]]) -> list[list[float]]:
    return [row[:] for row in A]


def lu_factorize(A: list[list[float]]) -> LUFactor | None:
    n = len(A)
    LU = _clone_matrix(A)
    piv = list(range(n))

    for k in range(n):
        pivot_row = k
        pivot_value = abs(LU[k][k])
        for i in range(k + 1, n):
            cand = abs(LU[i][k])
            if cand > pivot_value:
                pivot_value = cand
                pivot_row = i
        if not (pivot_value > 1e-12):
            return None
        if pivot_row != k:
            LU[k], LU[pivot_row] = LU[pivot_row], LU[k]
            piv[k], piv[pivot_row] = piv[pivot_row], piv[k]
        for i in range(k + 1, n):
            LU[i][k] /= LU[k][k]
            factor = LU[i][k]
            for j in range(k + 1, n):
                LU[i][j] -= factor * LU[k][j]
    return LUFactor(LU=LU, piv=piv)


def solve_lu_with_two_rhs(
    factor: LUFactor,
    b1: list[float],
    b2: list[float],
) -> tuple[list[float], list[float]] | None:
    n = len(b1)
    if n == 0:
        return ([], [])
    LU = factor.LU
    piv = factor.piv
    y1 = [0.0] * n
    y2 = [0.0] * n

    for i in range(n):
        y1[i] = b1[piv[i]]
        y2[i] = b2[piv[i]]
    for i in range(n):
        for j in range(i):
            y1[i] -= LU[i][j] * y1[j]
            y2[i] -= LU[i][j] * y2[j]

    x1 = [0.0] * n
    x2 = [0.0] * n
    for i in range(n - 1, -1, -1):
        sum1 = y1[i]
        sum2 = y2[i]
        for j in range(i + 1, n):
            sum1 -= LU[i][j] * x1[j]
            sum2 -= LU[i][j] * x2[j]
        diag = LU[i][i]
        if not (abs(diag) > 1e-12):
            return None
        x1[i] = sum1 / diag
        x2[i] = sum2 / diag
    return (x1, x2)


def solve_transpose_lu_with_two_rhs(
    factor: LUFactor,
    b1: list[float],
    b2: list[float],
) -> tuple[list[float], list[float]] | None:
    n = len(b1)
    if n == 0:
        return ([], [])
    LU = factor.LU
    piv = factor.piv
    z1 = [0.0] * n
    z2 = [0.0] * n

    for i in range(n):
        sum1 = b1[i]
        sum2 = b2[i]
        for j in range(i):
            sum1 -= LU[j][i] * z1[j]
            sum2 -= LU[j][i] * z2[j]
        diag = LU[i][i]
        if not (abs(diag) > 1e-12):
            return None
        z1[i] = sum1 / diag
        z2[i] = sum2 / diag

    w1 = [0.0] * n
    w2 = [0.0] * n
    for i in range(n - 1, -1, -1):
        acc1 = z1[i]
        acc2 = z2[i]
        for j in range(i + 1, n):
            acc1 -= LU[j][i] * w1[j]
            acc2 -= LU[j][i] * w2[j]
        w1[i] = acc1
        w2[i] = acc2

    x1 = [0.0] * n
    x2 = [0.0] * n
    for i in range(n):
        x1[piv[i]] = w1[i]
        x2[piv[i]] = w2[i]
    return (x1, x2)
