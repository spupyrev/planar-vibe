// CLI mirroring src-python/scripts/apply_layout.py. Emits the same JSON
// schema the Python version emits, so compare_metrics.py reads both.
//
// Usage: apply_layout <benchmark.dot> <graph-name> <algorithm> [--out PATH]
//        apply_layout <benchmark.dot> <graph-name> --algorithms input,tutte,*balancer* [--out PATH]

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
#include <algorithm>
#include <cctype>
#include <cstring>
#include <fstream>
#include <iostream>
#include <regex>
#include <sstream>
#include <string>
#include <unordered_set>

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

struct AlgorithmSpec {
    std::string key;
    std::string label;
};

const std::vector<AlgorithmSpec>& available_algorithms() {
    static const std::vector<AlgorithmSpec> algs = {
        {"input", "Input"},
        {"random", "Random"},
        {"tutte", "Tutte"},
        {"fpp", "FPP"},
        {"schnyder", "Schnyder"},
        {"p3t", "Planar 3-tree"},
        {"reweight", "Reweight"},
        {"ceg_bfs", "CEG BFS"},
        {"ceg_xy", "CEG XY"},
        {"forcedir", "ForceDir"},
        {"air", "Air"},
        {"areagrad", "AreaGrad"},
        {"impred", "ImPrEd"},
        {"facebalancer", "FaceBalancer"},
        {"edgebalancer", "EdgeBalancer"},
        {"anglebalancer", "AngleBalancer"},
        {"fabalancer", "FABalancer"},
        {"gpt", "GPT"},
        {"claude", "Claude"},
    };
    return algs;
}

std::string normalize_name(const std::string& value, bool keep_star = false) {
    std::string out;
    for (unsigned char ch : value) {
        char c = (char)std::tolower(ch);
        if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || (keep_star && c == '*')) {
            out.push_back(c);
        }
    }
    return out;
}

std::string replace_underscores_with_hyphens(std::string value) {
    std::replace(value.begin(), value.end(), '_', '-');
    return value;
}

std::vector<std::string> algorithm_candidates(const AlgorithmSpec& spec) {
    std::vector<std::string> candidates = {
        normalize_name(spec.key),
        normalize_name(spec.label),
        normalize_name(replace_underscores_with_hyphens(spec.key)),
        normalize_name(replace_underscores_with_hyphens(spec.label)),
    };
    if (spec.key == "claude") {
        candidates.push_back("hybrid");
        candidates.push_back("claudehybrid");
    }
    return candidates;
}

std::regex glob_to_regex(const std::string& pattern) {
    std::string s = "^";
    for (char c : pattern) {
        if (c == '*') {
            s += ".*";
        } else {
            if (std::string(".+?^${}()|[]\\").find(c) != std::string::npos) s.push_back('\\');
            s.push_back(c);
        }
    }
    s += "$";
    return std::regex(s, std::regex::icase);
}

bool resolve_algorithm_patterns(const std::vector<std::string>& patterns,
                                std::vector<std::string>& out,
                                std::string& error) {
    std::unordered_set<std::string> seen;
    const auto& algs = available_algorithms();
    for (const auto& raw : patterns) {
        if (raw.empty()) continue;
        std::vector<std::string> matches;
        if (raw.find('*') != std::string::npos) {
            auto matcher = glob_to_regex(normalize_name(raw, true));
            for (const auto& alg : algs) {
                auto candidates = algorithm_candidates(alg);
                bool ok = std::any_of(candidates.begin(), candidates.end(),
                                      [&](const std::string& c) { return std::regex_match(c, matcher); });
                if (ok) matches.push_back(alg.key);
            }
        } else {
            std::string requested = normalize_name(raw);
            for (const auto& alg : algs) {
                auto candidates = algorithm_candidates(alg);
                bool ok = std::any_of(candidates.begin(), candidates.end(),
                                      [&](const std::string& c) { return c == requested; });
                if (ok) {
                    matches.push_back(alg.key);
                    break;
                }
            }
        }
        if (matches.empty()) {
            error = "No algorithms matched \"" + raw + "\".";
            return false;
        }
        for (const auto& key : matches) {
            if (seen.insert(key).second) out.push_back(key);
        }
    }
    return true;
}

std::vector<std::string> split_algorithm_patterns(const std::string& value) {
    std::vector<std::string> out;
    std::stringstream ss(value);
    std::string item;
    while (std::getline(ss, item, ',')) {
        size_t begin = item.find_first_not_of(" \t\r\n");
        size_t end = item.find_last_not_of(" \t\r\n");
        if (begin != std::string::npos) out.push_back(item.substr(begin, end - begin + 1));
    }
    return out;
}

LayoutResult input_layout(const Graph& g, const pg::PosByStr* initial_positions) {
    LayoutResult r;
    if (!initial_positions) {
        r.ok = false;
        r.message = "Input coordinates are missing or invalid for one or more vertices";
        return r;
    }
    PositionMap pm;
    pm.resize(g.n);
    for (int i = 0; i < g.n; ++i) {
        auto it = initial_positions->find(g.node_names[i]);
        if (it == initial_positions->end() ||
            !std::isfinite(it->second[0]) || !std::isfinite(it->second[1])) {
            r.ok = false;
            r.message = "Input coordinates are missing or invalid for one or more vertices";
            return r;
        }
        pm.put(i, it->second[0], it->second[1]);
    }
    r.ok = true;
    r.message = "Used input coordinates";
    r.positions = geo::normalize_position_map_to_viewport(pm);
    return r;
}

LayoutResult dispatch(const std::string& algorithm, const Graph& g,
                      const pg::PosByStr* initial_positions) {
    if (algorithm == "input") return input_layout(g, initial_positions);
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

struct RunRecord {
    std::string algorithm;
    double runtime_ms = 0;
    LayoutResult result;
};

RunRecord run_one_algorithm(const std::string& algorithm, const std::string& dataset,
                            const std::string& graph_name,
                            const dot::ParsedGraph& parsed,
                            const pg::PosByStr& explicit_positions) {
    pg::PosByStr initial_positions = (algorithm == "input")
        ? explicit_positions
        : initialize_mock_positions(parsed.graph.node_names,
                                     dataset + ":" + graph_name,
                                     explicit_positions.empty() ? nullptr : &explicit_positions);

    auto t0 = std::chrono::steady_clock::now();
    LayoutResult r = dispatch(algorithm, parsed.graph,
                              initial_positions.empty() ? nullptr : &initial_positions);
    auto t1 = std::chrono::steady_clock::now();
    double runtime_ms = std::chrono::duration<double, std::milli>(t1 - t0).count();
    if (r.ok) compute_all_metrics(parsed.graph, r.positions, r);
    return {algorithm, runtime_ms, std::move(r)};
}

void usage() {
    std::cerr << "usage: apply_layout <benchmark.dot> <graph-name> <algorithm> [--out PATH]\n"
              << "       apply_layout <benchmark.dot> <graph-name> --algorithms input,tutte,*balancer* [--out PATH]\n";
}

} // namespace

int main(int argc, char** argv) {
    std::vector<std::string> positionals;
    std::vector<std::string> raw_patterns;
    std::string out_path;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if ((arg == "--algorithm" || arg == "--algorithms") && i + 1 < argc) {
            auto parts = split_algorithm_patterns(argv[++i]);
            raw_patterns.insert(raw_patterns.end(), parts.begin(), parts.end());
            continue;
        }
        if (arg == "--out" && i + 1 < argc) {
            out_path = argv[++i];
            continue;
        }
        if (arg == "--help" || arg == "-h") {
            usage();
            return 0;
        }
        if (!arg.empty() && arg.rfind("--", 0) == 0) {
            usage();
            std::cerr << "unknown option: " << arg << "\n";
            return 2;
        }
        positionals.push_back(arg);
    }

    if (positionals.size() != 2 && positionals.size() != 3) {
        usage();
        return 2;
    }
    std::string bench_path = positionals[0];
    std::string graph_name = positionals[1];
    if (positionals.size() == 3) raw_patterns.push_back(positionals[2]);
    std::vector<std::string> algorithms;
    std::string alg_error;
    if (!resolve_algorithm_patterns(raw_patterns, algorithms, alg_error)) {
        std::cerr << alg_error << "\n";
        return 2;
    }
    if (algorithms.empty()) {
        usage();
        std::cerr << "missing required algorithm or --algorithms parameter\n";
        return 2;
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
    std::vector<RunRecord> records;
    for (const auto& algorithm : algorithms) {
        records.push_back(run_one_algorithm(algorithm, dataset, graph_name, *found, explicit_positions));
    }

    if (!out_path.empty()) {
        std::ofstream f(out_path);
        if (!f) {
            std::cerr << "cannot write " << out_path << "\n";
            return 2;
        }
        if (records.size() == 1) {
            const auto& rec = records[0];
            write_json(f, dataset, graph_name, rec.algorithm, found->graph, rec.runtime_ms, rec.result);
        } else {
            f << "[\n";
            for (size_t i = 0; i < records.size(); ++i) {
                const auto& rec = records[i];
                write_json(f, dataset, graph_name, rec.algorithm, found->graph, rec.runtime_ms, rec.result);
                if (i + 1 < records.size()) f << ",";
            }
            f << "]\n";
        }
    } else {
        if (records.size() == 1) {
            const auto& rec = records[0];
            write_json(std::cout, dataset, graph_name, rec.algorithm, found->graph, rec.runtime_ms, rec.result);
        } else {
            std::cout << "[\n";
            for (size_t i = 0; i < records.size(); ++i) {
                const auto& rec = records[i];
                write_json(std::cout, dataset, graph_name, rec.algorithm, found->graph, rec.runtime_ms, rec.result);
                if (i + 1 < records.size()) std::cout << ",";
            }
            std::cout << "]\n";
        }
    }
    return 0;
}
