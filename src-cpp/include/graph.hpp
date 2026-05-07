#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace planarvibe {

// Graph stores nodes as contiguous ints [0, n). The string names from the
// input (DOT / JSON) live in node_names[i] for round-tripping to JSON.
struct Graph {
    int n = 0;
    std::vector<std::string> node_names;          // size n
    std::unordered_map<std::string, int> name_to_id;
    std::vector<std::pair<int,int>> edges;        // unique undirected (u<v)
    std::vector<std::vector<int>> adjacency;      // size n, neighbor lists

    int add_node(const std::string& name) {
        auto it = name_to_id.find(name);
        if (it != name_to_id.end()) return it->second;
        int id = n++;
        name_to_id.emplace(name, id);
        node_names.push_back(name);
        adjacency.emplace_back();
        return id;
    }

    // Add an undirected edge; silently dedup self-loops and duplicates.
    // Insertion order matters: adjacency[u] appends v in the order the edge
    // was added (mirrors JS `this.adjacency[u].push(v); this.adjacency[v].push(u);`).
    // The stored `edges` preserves the (u, v) order of insertion too.
    void add_edge(int u, int v) {
        if (u == v) return;
        for (int nb : adjacency[u]) if (nb == v) return;  // duplicate
        adjacency[u].push_back(v);
        adjacency[v].push_back(u);
        edges.emplace_back(u, v);
    }
};

// FNV-1a-like hash mirroring JS hashString (Math.imul semantics).
inline uint32_t hash_string(const std::string& s, uint32_t seed) {
    uint32_t h = seed;
    for (char ch : s) {
        h ^= (uint32_t)(unsigned char)ch;
        h = (uint32_t)(h * (uint32_t)16777619);
    }
    return h;
}

inline double normalized_hash(const std::string& s, uint32_t seed) {
    return double(hash_string(s, seed)) / 4294967295.0;
}

inline std::string edge_key_str(const std::string& a, const std::string& b) {
    return (a < b) ? (a + "::" + b) : (b + "::" + a);
}

using Point = std::array<double, 2>;
// Sparse position map: one Point per node id, with an "is_set" mask. Simpler
// than std::optional<Point> for a Point-of-2-doubles hot path.
struct PositionMap {
    std::vector<Point> pos;
    std::vector<char> set; // 0/1
    // Grow-only resize: keep any existing entries, append zeros for new slots.
    void resize(int n) {
        if ((int)pos.size() < n) pos.resize(n, {0.0, 0.0});
        if ((int)set.size() < n) set.resize(n, 0);
    }
    void put(int i, double x, double y) { pos[i] = {x, y}; set[i] = 1; }
    bool has(int i) const { return (int)set.size() > i && set[i]; }
};

} // namespace planarvibe
