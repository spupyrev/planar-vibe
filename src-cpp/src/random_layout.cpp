#include "layouts/random_layout.hpp"

#include <algorithm>
#include <cmath>

namespace planarvibe::layouts {

// Literal port of static/js/layout-random.js via the Python port's
// compute_random_positions. Node id is hashed with seeds 2166136261 (x) and
// 33554467 (y); the result is a deterministic scatter in a viewport box.
LayoutResult random_layout(const Graph& g) {
    LayoutResult r;
    r.ok = true;
    r.message = "Applied random coordinates";
    r.positions.resize(g.n);
    const double WIDTH = 900.0;
    const double HEIGHT = 620.0;
    const double MARGIN = 26.0;
    double width_px = std::max(WIDTH, 320.0);
    double height_px = std::max(HEIGHT, 260.0);
    double x_span = std::max(width_px - MARGIN * 2, 1.0);
    double y_span = std::max(height_px - MARGIN * 2, 1.0);
    for (int i = 0; i < g.n; ++i) {
        const std::string& name = g.node_names[i];
        double x = MARGIN + normalized_hash(name + ":x", 2166136261u) * x_span;
        double y = MARGIN + normalized_hash(name + ":y", 33554467u) * y_span;
        r.positions.put(i, x, y);
    }
    return r;
}

} // namespace planarvibe::layouts
