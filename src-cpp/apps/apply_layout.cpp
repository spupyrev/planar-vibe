// CLI mirroring src-python/scripts/apply_layout.py. Emits the same JSON
// schema the Python version emits, so compare_metrics.py reads both.
//
// Usage: apply_layout <benchmark.dot> <graph-name> <algorithm> [--out PATH]

#include "dot.hpp"
#include "geometry.hpp"
#include "graph.hpp"
#include "json.hpp"
#include "layout_result.hpp"
#include "metrics.hpp"
#include "planar_graph.hpp"
#include "layouts/air.hpp"
#include "layouts/anglebalancer.hpp"
#include "layouts/areagrad.hpp"
#include "layouts/ceg.hpp"
#include "layouts/claude.hpp"
#include "layouts/edgebalancer.hpp"
#include "layouts/fabalancer.hpp"
#include "layouts/facebalancer.hpp"
#include "layouts/forcedir.hpp"
#include "layouts/gpt.hpp"
#include "layouts/impred.hpp"
#include "layouts/fpp.hpp"
#include "layouts/p3t.hpp"
#include "layouts/random_layout.hpp"
#include "layouts/reweight.hpp"
#include "layouts/schnyder.hpp"
#include "layouts/tutte.hpp"

#include <chrono>
#include <cstring>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>

using namespace planarvibe;

namespace {

// Linear-congruential RNG matching src-python/scripts/apply_layout.py :: _seeded_rng.
struct SeededRng {
    uint32_t state;
    explicit SeededRng(uint32_t seed) : state(seed == 0 ? 1u : seed) {}
    double next() {
        state = (uint32_t)(state * 1664525u + 1013904223u);
        return (double)state / 4294967296.0;
    }
};

// FNV-like hash used as seed input. Mirrors Python's _hash_string_to_seed.
uint32_t hash_string_to_seed(const std::string& s) {
    uint32_t h = 2166136261u;
    for (char ch : s) {
        h ^= (uint32_t)(unsigned char)ch;
        h = (uint32_t)(h * 16777619u);
    }
    return h;
}

// Mirrors report-shared.mjs initializeMockCyPositions via src-python's
// _initialize_mock_positions. For parity with JS runtime, every layout invocation
// is seeded with dataset:graph-name — producing deterministic non-empty positions
// that the layout preprocessing can use to extract an embedding when the random
// drawing happens to be crossing-free (notably on trees / near-trees).
pg::PosByStr initialize_mock_positions(
    const std::vector<std::string>& node_ids, const std::string& seed_key,
    const pg::PosByStr* explicit_positions) {
    SeededRng rng(hash_string_to_seed(seed_key));
    double span = std::max(400.0, 30.0 * std::sqrt(std::max(1, (int)node_ids.size())) * 10.0);
    pg::PosByStr raw;
    for (size_t i = 0; i < node_ids.size(); ++i) {
        double jitter = i * 1e-4;
        double x = span * rng.next() + jitter;
        double y = span * rng.next() + jitter;
        raw[node_ids[i]] = {x, y};
    }
    bool has_explicit = false;
    if (explicit_positions) {
        for (const auto& nid : node_ids) {
            auto it = explicit_positions->find(nid);
            if (it == explicit_positions->end()) continue;
            if (!std::isfinite(it->second[0]) || !std::isfinite(it->second[1])) continue;
            raw[nid] = it->second;
            has_explicit = true;
        }
    }
    if (has_explicit) {
        // normalize to viewport like Python does — but only when explicit coords are present.
        PositionMap pm;
        pm.resize((int)node_ids.size());
        for (size_t i = 0; i < node_ids.size(); ++i) {
            auto it = raw.find(node_ids[i]);
            if (it != raw.end()) pm.put((int)i, it->second[0], it->second[1]);
        }
        auto normalized = geo::normalize_position_map_to_viewport(pm);
        pg::PosByStr out;
        for (size_t i = 0; i < node_ids.size(); ++i) {
            if (normalized.has((int)i)) out[node_ids[i]] = normalized.pos[i];
        }
        return out;
    }
    return raw;
}

std::string basename_stem(const std::string& path) {
    size_t slash = path.find_last_of("/\\");
    std::string fname = (slash == std::string::npos) ? path : path.substr(slash + 1);
    size_t dot = fname.find_last_of('.');
    return (dot == std::string::npos) ? fname : fname.substr(0, dot);
}

LayoutResult dispatch(const std::string& algorithm, const Graph& g,
                      const pg::PosByStr* initial_positions) {
    if (algorithm == "random") return layouts::random_layout(g);
    if (algorithm == "tutte") return layouts::tutte(g, initial_positions);
    if (algorithm == "reweight") return layouts::reweight(g, initial_positions);
    if (algorithm == "fpp") return layouts::fpp(g, initial_positions);
    if (algorithm == "schnyder") return layouts::schnyder(g, initial_positions);
    if (algorithm == "p3t") return layouts::p3t(g);
    if (algorithm == "ceg_bfs") return layouts::ceg_bfs(g, initial_positions);
    if (algorithm == "ceg_xy") return layouts::ceg_xy(g, initial_positions);
    if (algorithm == "forcedir") return layouts::forcedir(g, initial_positions);
    if (algorithm == "facebalancer") return layouts::facebalancer(g, initial_positions);
    if (algorithm == "edgebalancer") return layouts::edgebalancer(g, initial_positions);
    if (algorithm == "anglebalancer") return layouts::anglebalancer(g, initial_positions);
    if (algorithm == "fabalancer") return layouts::fabalancer(g, initial_positions);
    if (algorithm == "air") return layouts::air(g, initial_positions);
    if (algorithm == "areagrad") return layouts::areagrad(g, initial_positions);
    if (algorithm == "impred") return layouts::impred(g, initial_positions);
    if (algorithm == "gpt") return layouts::gpt(g, initial_positions);
    if (algorithm == "claude") return layouts::claude(g, initial_positions);
    LayoutResult r;
    r.ok = false;
    r.message = "algorithm not implemented: " + algorithm;
    return r;
}

// Mirrors compute_all_metrics from src-python/scripts/apply_layout.py.
void compute_all_metrics(const Graph& g, const PositionMap& pos, LayoutResult& r) {
    // Planarity by brute crossings (isPlane flag).
    bool is_plane = !geo::has_position_crossings(pos, g.edges);
    r.is_plane = is_plane;

    // Score helper: extract `score` (or nullopt) and add to r.metrics; if
    // missing we don't add the key at all, matching `pick` in the Python
    // apply_layout — missing -> JSON null.
    auto add_score = [&](const std::string& key, const metrics::MetricResult& mr) {
        if (mr.ok && mr.score) r.metrics[key] = *mr.score;
    };
    auto add_quality = [&](const std::string& key, const metrics::MetricResult& mr) {
        if (mr.ok && mr.quality) r.metrics[key] = *mr.quality;
    };
    auto add_ratio = [&](const std::string& key, const metrics::MetricResult& mr) {
        if (mr.ok && mr.ratio) r.metrics[key] = *mr.ratio;
    };

    add_score("angularResolution", metrics::compute_angular_resolution_score(g, pos));
    add_score("aspectRatio", metrics::compute_aspect_ratio_score(g.n, pos));
    add_score("edgeLengthDeviation", metrics::compute_edge_length_deviation_score(g.edges, pos));
    add_ratio("edgeRatio", metrics::compute_edge_length_ratio(g.edges, pos));
    add_score("edgeOrthogonality", metrics::compute_edge_orthogonality_score(g.edges, pos));
    add_score("nodeUniformity", metrics::compute_node_uniformity_score(g.n, pos));
    add_score("alignment", metrics::compute_axis_alignment_score(g.n, pos));
    add_score("spacing", metrics::compute_spacing_uniformity_score(g.n, pos));

    // face / convexity require a planar embedding from the positions.
    if (is_plane) {
        // Build string-keyed inputs.
        std::vector<std::string> name_ids = g.node_names;
        std::vector<std::pair<std::string,std::string>> name_edges;
        name_edges.reserve(g.edges.size());
        for (const auto& [u, v] : g.edges) name_edges.emplace_back(g.node_names[u], g.node_names[v]);
        std::unordered_map<std::string, Point> pos_by_name;
        for (int i = 0; i < g.n; ++i) {
            if (pos.has(i)) pos_by_name[g.node_names[i]] = pos.pos[i];
        }
        auto emb_opt = pg::extract_embedding_from_positions(name_ids, name_edges, pos_by_name);
        if (emb_opt) {
            metrics::FaceMetricInput fin{&emb_opt->faces, &emb_opt->outer_face};
            auto fm = metrics::compute_uniform_face_area_score(fin, pos_by_name);
            add_quality("face", fm);
            auto cm = metrics::compute_convexity_score(fin, pos_by_name, name_ids);
            add_score("convexity", cm);
        }
    }
}

void write_json(std::ostream& os, const std::string& dataset,
                const std::string& graph_name, const std::string& algorithm,
                const Graph& g, double runtime_ms, const LayoutResult& r) {
    os << "{\n";
    os << "  \"dataset\": "; json::write_string(os, dataset); os << ",\n";
    os << "  \"graph\": "; json::write_string(os, graph_name); os << ",\n";
    os << "  \"algorithm\": "; json::write_string(os, algorithm); os << ",\n";
    os << "  \"n\": " << g.n << ",\n";
    os << "  \"m\": " << g.edges.size() << ",\n";
    os << "  \"runtime_ms\": "; json::write_double(os, runtime_ms); os << ",\n";
    os << "  \"ok\": " << (r.ok ? "true" : "false") << ",\n";
    os << "  \"message\": "; json::write_string(os, r.message); os << ",\n";

    // positions
    if (r.ok && (int)r.positions.pos.size() == g.n) {
        os << "  \"positions\": {\n";
        bool first = true;
        for (int i = 0; i < g.n; ++i) {
            if (!first) os << ",\n";
            first = false;
            os << "    ";
            json::write_string(os, g.node_names[i]);
            os << ": [";
            json::write_double(os, r.positions.pos[i][0]);
            os << ", ";
            json::write_double(os, r.positions.pos[i][1]);
            os << "]";
        }
        os << "\n  },\n";
    } else {
        os << "  \"positions\": null,\n";
    }

    // metrics: when layout is ok, always emit the block (with isPlane + every
    // successfully-computed key). Missing metrics are omitted, matching the
    // Python apply_layout behaviour of nulls via `pick`.
    if (r.ok) {
        os << "  \"metrics\": {\n";
        os << "    \"isPlane\": " << (r.is_plane ? "true" : "false");
        // Emit in a stable order that matches Python/JS output for easier diff.
        static const char* kOrder[] = {
            "angularResolution", "aspectRatio", "convexity",
            "edgeLengthDeviation", "edgeRatio", "edgeOrthogonality",
            "face", "nodeUniformity", "alignment", "spacing"
        };
        for (const char* k : kOrder) {
            auto it = r.metrics.find(k);
            if (it == r.metrics.end()) {
                os << ",\n    ";
                json::write_string(os, k);
                os << ": null";
            } else {
                os << ",\n    ";
                json::write_string(os, k);
                os << ": ";
                json::write_double(os, it->second);
            }
        }
        os << "\n  }\n";
    } else {
        os << "  \"metrics\": null\n";
    }
    os << "}\n";
}

} // namespace

int main(int argc, char** argv) {
    if (argc < 4) {
        std::cerr << "usage: apply_layout <benchmark.dot> <graph-name> <algorithm> [--out PATH]\n";
        return 2;
    }
    std::string bench_path = argv[1];
    std::string graph_name = argv[2];
    std::string algorithm  = argv[3];
    std::string out_path;
    for (int i = 4; i < argc; ++i) {
        if (std::strcmp(argv[i], "--out") == 0 && i + 1 < argc) {
            out_path = argv[++i];
        }
    }

    std::vector<dot::ParsedGraph> parsed;
    try {
        parsed = dot::parse_file(bench_path);
    } catch (const std::exception& e) {
        std::cerr << "error: " << e.what() << "\n";
        return 2;
    }

    const dot::ParsedGraph* found = nullptr;
    for (const auto& p : parsed) {
        if (p.name == graph_name) { found = &p; break; }
    }
    if (!found) {
        std::cerr << "No graph named " << graph_name << " in " << bench_path << "\n";
        return 2;
    }

    // Build explicit positions map from DOT `v <id> x y` lines (may be empty).
    pg::PosByStr explicit_positions;
    for (int i = 0; i < found->graph.n; ++i) {
        if (found->positions.has(i)) {
            explicit_positions[found->graph.node_names[i]] = found->positions.pos[i];
        }
    }
    std::string dataset = basename_stem(bench_path);
    // For 'input' layout, pass explicit positions directly (not mock).
    pg::PosByStr initial_positions = (algorithm == "input")
        ? explicit_positions
        : initialize_mock_positions(found->graph.node_names,
                                     dataset + ":" + graph_name,
                                     explicit_positions.empty() ? nullptr : &explicit_positions);

    auto t0 = std::chrono::steady_clock::now();
    LayoutResult r = dispatch(algorithm, found->graph,
                              initial_positions.empty() ? nullptr : &initial_positions);
    auto t1 = std::chrono::steady_clock::now();
    double runtime_ms = std::chrono::duration<double, std::milli>(t1 - t0).count();

    if (r.ok) compute_all_metrics(found->graph, r.positions, r);

    if (!out_path.empty()) {
        std::ofstream f(out_path);
        if (!f) {
            std::cerr << "cannot write " << out_path << "\n";
            return 2;
        }
        write_json(f, dataset, graph_name, algorithm, found->graph, runtime_ms, r);
    } else {
        write_json(std::cout, dataset, graph_name, algorithm, found->graph, runtime_ms, r);
    }
    return 0;
}
