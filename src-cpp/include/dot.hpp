#pragma once

#include "graph.hpp"

#include <string>
#include <vector>

namespace planarvibe::dot {

// One graph parsed out of a DOT file.
struct ParsedGraph {
    std::string name;
    Graph graph;
    PositionMap positions;  // positions given via `v <id> x y;` lines
};

// Parse a DOT file with the dialect used by benchmark/*.dot:
//   graph <NAME> {
//     v <id> <x> <y>;         // node with coords
//     <u> -- <v>;             // undirected edge
//   }
// Line comments start with //. Multiple graphs per file supported.
// Throws std::runtime_error on I/O errors.
std::vector<ParsedGraph> parse_file(const std::string& path);

} // namespace planarvibe::dot
