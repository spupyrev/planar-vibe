#pragma once

// Dense LU with partial pivoting. Literal port of static/js/linear-algebra.js.
// Used by Tutte / balancers. For nI×nI systems with ~graph-n size.

#include <optional>
#include <vector>

namespace planarvibe::la {

struct LUFactor {
    std::vector<std::vector<double>> LU;  // n×n
    std::vector<int> piv;                 // size n
};

std::optional<LUFactor> lu_factorize(const std::vector<std::vector<double>>& A);

// Solve L U x = P b for two right-hand sides simultaneously.
// Returns (x1, x2). std::nullopt if the factor has zero pivots (should not
// happen if lu_factorize succeeded, but guarded for symmetry).
std::optional<std::pair<std::vector<double>, std::vector<double>>>
solve_lu_with_two_rhs(const LUFactor& f,
                     const std::vector<double>& b1,
                     const std::vector<double>& b2);

// Solve (L U)^T x = b, i.e. P^T U^T L^T x = b. Also for two RHS.
std::optional<std::pair<std::vector<double>, std::vector<double>>>
solve_transpose_lu_with_two_rhs(const LUFactor& f,
                                const std::vector<double>& b1,
                                const std::vector<double>& b2);

} // namespace planarvibe::la
