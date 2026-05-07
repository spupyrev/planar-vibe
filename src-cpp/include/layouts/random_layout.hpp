#pragma once

#include "graph.hpp"
#include "layout_result.hpp"

namespace planarvibe::layouts {

// Stub random placement. C1 will port the real JS layout-random. For C0 we
// just place nodes on a unit circle and compute zero metrics — enough to
// exercise the I/O round-trip.
LayoutResult random_layout(const Graph& g);

} // namespace planarvibe::layouts
