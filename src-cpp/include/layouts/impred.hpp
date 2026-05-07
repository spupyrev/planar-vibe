#pragma once
#include "graph.hpp"
#include "layout_result.hpp"
#include "planar_graph.hpp"

namespace planarvibe::layouts {
LayoutResult impred(const Graph& g, const pg::PosByStr* initial_positions = nullptr);
}
