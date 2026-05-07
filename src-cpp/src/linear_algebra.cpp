#include "linear_algebra.hpp"

#include <cmath>

namespace planarvibe::la {

std::optional<LUFactor> lu_factorize(const std::vector<std::vector<double>>& A) {
    int n = (int)A.size();
    LUFactor f;
    f.LU = A;  // copy
    f.piv.resize(n);
    for (int i = 0; i < n; ++i) f.piv[i] = i;

    auto& LU = f.LU;
    for (int k = 0; k < n; ++k) {
        int pivot_row = k;
        double pivot_value = std::abs(LU[k][k]);
        for (int i = k + 1; i < n; ++i) {
            double cand = std::abs(LU[i][k]);
            if (cand > pivot_value) { pivot_value = cand; pivot_row = i; }
        }
        if (!(pivot_value > 1e-12)) return std::nullopt;
        if (pivot_row != k) {
            std::swap(LU[k], LU[pivot_row]);
            std::swap(f.piv[k], f.piv[pivot_row]);
        }
        for (int i = k + 1; i < n; ++i) {
            LU[i][k] /= LU[k][k];
            double factor = LU[i][k];
            for (int j = k + 1; j < n; ++j) {
                LU[i][j] -= factor * LU[k][j];
            }
        }
    }
    return f;
}

std::optional<std::pair<std::vector<double>, std::vector<double>>>
solve_lu_with_two_rhs(const LUFactor& f,
                      const std::vector<double>& b1,
                      const std::vector<double>& b2) {
    int n = (int)b1.size();
    if (n == 0) return std::make_pair(std::vector<double>{}, std::vector<double>{});
    const auto& LU = f.LU;
    const auto& piv = f.piv;
    std::vector<double> y1(n), y2(n);
    for (int i = 0; i < n; ++i) { y1[i] = b1[piv[i]]; y2[i] = b2[piv[i]]; }
    for (int i = 0; i < n; ++i) {
        for (int j = 0; j < i; ++j) {
            y1[i] -= LU[i][j] * y1[j];
            y2[i] -= LU[i][j] * y2[j];
        }
    }
    std::vector<double> x1(n), x2(n);
    for (int i = n - 1; i >= 0; --i) {
        double s1 = y1[i], s2 = y2[i];
        for (int j = i + 1; j < n; ++j) {
            s1 -= LU[i][j] * x1[j];
            s2 -= LU[i][j] * x2[j];
        }
        double diag = LU[i][i];
        if (!(std::abs(diag) > 1e-12)) return std::nullopt;
        x1[i] = s1 / diag;
        x2[i] = s2 / diag;
    }
    return std::make_pair(std::move(x1), std::move(x2));
}

std::optional<std::pair<std::vector<double>, std::vector<double>>>
solve_transpose_lu_with_two_rhs(const LUFactor& f,
                                const std::vector<double>& b1,
                                const std::vector<double>& b2) {
    int n = (int)b1.size();
    if (n == 0) return std::make_pair(std::vector<double>{}, std::vector<double>{});
    const auto& LU = f.LU;
    const auto& piv = f.piv;
    std::vector<double> z1(n), z2(n);
    for (int i = 0; i < n; ++i) {
        double s1 = b1[i], s2 = b2[i];
        for (int j = 0; j < i; ++j) {
            s1 -= LU[j][i] * z1[j];
            s2 -= LU[j][i] * z2[j];
        }
        double diag = LU[i][i];
        if (!(std::abs(diag) > 1e-12)) return std::nullopt;
        z1[i] = s1 / diag;
        z2[i] = s2 / diag;
    }
    std::vector<double> w1(n), w2(n);
    for (int i = n - 1; i >= 0; --i) {
        double a1 = z1[i], a2 = z2[i];
        for (int j = i + 1; j < n; ++j) {
            a1 -= LU[j][i] * w1[j];
            a2 -= LU[j][i] * w2[j];
        }
        w1[i] = a1; w2[i] = a2;
    }
    std::vector<double> x1(n), x2(n);
    for (int i = 0; i < n; ++i) { x1[piv[i]] = w1[i]; x2[piv[i]] = w2[i]; }
    return std::make_pair(std::move(x1), std::move(x2));
}

} // namespace planarvibe::la
