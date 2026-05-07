#include "planar_graph.hpp"
#include "geometry.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace planarvibe::pg {

namespace {

std::string ekey(const std::string& a, const std::string& b) {
    return (a < b) ? (a + "::" + b) : (b + "::" + a);
}

bool is_finite(double x) { return std::isfinite(x); }

// Compare neighbors by (angle, dist, id). Mirrors Python _compare_neighbors.
struct NeighborCmp {
    Point pu;
    const PosByStr* pos;
    bool operator()(const std::string& a, const std::string& b) const {
        auto ia = pos->find(a);
        auto ib = pos->find(b);
        if (ia == pos->end() || ib == pos->end()) return a < b;
        double aa = std::atan2(ia->second[1] - pu[1], ia->second[0] - pu[0]);
        double ab = std::atan2(ib->second[1] - pu[1], ib->second[0] - pu[0]);
        if (std::abs(aa - ab) > 1e-12) return aa > ab;
        double da = (ia->second[0] - pu[0]) * (ia->second[0] - pu[0])
                   + (ia->second[1] - pu[1]) * (ia->second[1] - pu[1]);
        double db = (ib->second[0] - pu[0]) * (ib->second[0] - pu[0])
                   + (ib->second[1] - pu[1]) * (ib->second[1] - pu[1]);
        if (std::abs(da - db) > 1e-12) return da < db;
        return a < b;
    }
};

// Sort string keys in "JS Object.keys" order: numeric (as integers) first, then strings in insertion order.
// We don't have insertion-order from an unordered_map, so the caller provides the preferred order.
std::vector<std::string> js_object_keys(
        const std::unordered_map<std::string, std::vector<std::string>>& rot,
        const std::vector<std::string>& insertion_order) {
    std::vector<std::pair<long long, std::string>> indexed;
    std::vector<std::string> rest;
    // Track which keys are actually in `rot`, in insertion order.
    for (const auto& k : insertion_order) {
        if (!rot.count(k)) continue;
        // Try parse as integer.
        try {
            size_t pos;
            long long n = std::stoll(k, &pos, 10);
            if (pos == k.size() && n >= 0 && std::to_string(n) == k) {
                indexed.emplace_back(n, k);
            } else {
                rest.push_back(k);
            }
        } catch (...) {
            rest.push_back(k);
        }
    }
    std::sort(indexed.begin(), indexed.end(), [](auto& a, auto& b){ return a.first < b.first; });
    std::vector<std::string> out;
    out.reserve(indexed.size() + rest.size());
    for (auto& p : indexed) out.push_back(p.second);
    for (auto& s : rest) out.push_back(s);
    return out;
}

} // namespace

bool same_cyclic_direction(const std::vector<std::string>& a,
                           const std::vector<std::string>& b) {
    if (a.size() != b.size() || a.empty()) return false;
    int n = (int)a.size();
    for (int off = 0; off < n; ++off) {
        bool ok = true;
        for (int i = 0; i < n; ++i) {
            if (a[(off + i) % n] != b[i]) { ok = false; break; }
        }
        if (ok) return true;
    }
    return false;
}

bool same_cyclic_either_direction(const std::vector<std::string>& a,
                                  const std::vector<std::string>& b) {
    if (same_cyclic_direction(a, b)) return true;
    std::vector<std::string> rb(b.rbegin(), b.rend());
    return same_cyclic_direction(a, rb);
}

int find_face_index(const std::vector<std::vector<std::string>>& faces,
                    const std::vector<std::string>& face, bool allow_reverse) {
    for (int i = 0; i < (int)faces.size(); ++i) {
        if (same_cyclic_direction(faces[i], face)) return i;
        if (allow_reverse && same_cyclic_either_direction(faces[i], face)) return i;
    }
    return -1;
}

int find_outer_face_index(const std::vector<std::vector<std::string>>& faces,
                          const std::vector<std::string>& outer) {
    if (faces.empty() || outer.empty()) return -1;
    return find_face_index(faces, outer, true);
}

std::optional<std::unordered_map<std::string, std::vector<std::string>>>
build_rotation_from_positions(
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const PosByStr& pos) {
    std::unordered_map<std::string, std::vector<std::string>> adjacency;
    for (const auto& nid : node_ids) adjacency[nid] = {};
    for (const auto& [a, b] : edge_pairs) {
        if (!adjacency.count(a) || !adjacency.count(b)) return std::nullopt;
        adjacency[a].push_back(b);
        adjacency[b].push_back(a);
    }
    std::unordered_map<std::string, std::vector<std::string>> rotation;
    for (const auto& u : node_ids) {
        auto it = pos.find(u);
        if (it == pos.end()) return std::nullopt;
        if (!is_finite(it->second[0]) || !is_finite(it->second[1])) return std::nullopt;
        std::vector<std::string> nb = adjacency[u];
        NeighborCmp cmp{it->second, &pos};
        // Stable sort for determinism.
        std::stable_sort(nb.begin(), nb.end(), cmp);
        rotation[u] = std::move(nb);
    }
    return rotation;
}

std::vector<std::vector<std::string>> extract_faces_from_rotation_map(
    const std::unordered_map<std::string, std::vector<std::string>>& rotation) {
    // We don't have insertion order for unordered_map; but Python's JS-order
    // mimic sorts numeric keys numerically then falls back to insertion. We
    // approximate with "numeric first, then lex" — sufficient for benchmark
    // graphs whose ids are pure integers.
    std::vector<std::string> insertion;
    insertion.reserve(rotation.size());
    for (const auto& [k, _] : rotation) insertion.push_back(k);
    std::sort(insertion.begin(), insertion.end());  // non-numeric fallback
    std::vector<std::string> order = js_object_keys(rotation, insertion);

    std::unordered_set<std::string> seen;
    std::vector<std::vector<std::string>> faces;
    auto half = [](const std::string& u, const std::string& v) { return u + "|" + v; };
    for (const auto& u : order) {
        auto it = rotation.find(u);
        if (it == rotation.end()) continue;
        for (const auto& v : it->second) {
            std::string sk = half(u, v);
            if (seen.count(sk)) continue;
            std::string start_u = u, start_v = v;
            std::string cu = start_u, cv = start_v;
            std::vector<std::string> face;
            while (true) {
                std::string ck = half(cu, cv);
                if (seen.count(ck)) break;
                seen.insert(ck);
                face.push_back(cu);
                auto itn = rotation.find(cv);
                if (itn == rotation.end() || itn->second.empty()) { face.clear(); break; }
                const auto& adj = itn->second;
                auto iter = std::find(adj.begin(), adj.end(), cu);
                if (iter == adj.end()) { face.clear(); break; }
                int idx = (int)(iter - adj.begin());
                int prev = (idx - 1 + (int)adj.size()) % (int)adj.size();
                std::string next_v = adj[prev];
                cu = cv;
                cv = next_v;
                if (cu == start_u && cv == start_v) break;
            }
            if (face.size() >= 3) faces.push_back(std::move(face));
        }
    }
    return faces;
}

std::optional<planarity::StringEmbedding> extract_embedding_from_positions(
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const PosByStr& pos) {
    // Requires finite positions, no crossings.
    for (const auto& nid : node_ids) {
        auto it = pos.find(nid);
        if (it == pos.end()) return std::nullopt;
        if (!is_finite(it->second[0]) || !is_finite(it->second[1])) return std::nullopt;
    }
    // Crossing check — build int-edge PositionMap from the string pos.
    // Use insertion order of node_ids for int mapping.
    std::unordered_map<std::string,int> idx;
    for (const auto& n : node_ids) { if (!idx.count(n)) idx[n] = (int)idx.size(); }
    PositionMap pm;
    pm.resize((int)node_ids.size());
    for (const auto& [k, v] : pos) {
        auto it = idx.find(k);
        if (it == idx.end()) continue;
        pm.put(it->second, v[0], v[1]);
    }
    std::vector<std::pair<int,int>> int_edges;
    for (const auto& [u, v] : edge_pairs) {
        auto iu = idx.find(u), iv = idx.find(v);
        if (iu == idx.end() || iv == idx.end()) continue;
        int_edges.emplace_back(iu->second, iv->second);
    }
    if (geo::has_position_crossings(pm, int_edges)) return std::nullopt;

    auto rot = build_rotation_from_positions(node_ids, edge_pairs, pos);
    if (!rot) return std::nullopt;
    auto faces = extract_faces_from_rotation_map(*rot);
    if (faces.empty()) return std::nullopt;

    // Build a StringEmbedding.
    planarity::StringEmbedding emb;
    emb.ok = true;
    emb.id_by_index = node_ids;
    for (size_t i = 0; i < node_ids.size(); ++i) emb.index_by_id[node_ids[i]] = (int)i;
    emb.edges = edge_pairs;
    emb.rotation.reserve(node_ids.size());
    for (const auto& nid : node_ids) {
        auto it = rot->find(nid);
        emb.rotation.push_back(it != rot->end() ? it->second : std::vector<std::string>{});
    }
    emb.faces = std::move(faces);
    auto lf = largest_area_face(emb.faces, pos);
    if (lf) emb.outer_face = *lf;
    return emb;
}

void insert_before(std::vector<std::string>& lst,
                   const std::string& before_value,
                   const std::string& value) {
    auto it = std::find(lst.begin(), lst.end(), before_value);
    if (it == lst.end()) throw std::runtime_error("Could not locate face wedge while updating rotation");
    if (std::find(lst.begin(), lst.end(), value) != lst.end()) return;
    lst.insert(it, value);
}

std::optional<std::vector<std::string>> largest_area_face(
    const std::vector<std::vector<std::string>>& faces,
    const PosByStr& pos) {
    std::optional<std::vector<std::string>> best;
    double best_area = -1.0;
    for (const auto& f : faces) {
        if (f.size() < 3) continue;
        // Compute polygon area via string pos.
        int n = (int)f.size();
        double total = 0.0;
        bool bad = false;
        for (int i = 0; i < n; ++i) {
            auto ia = pos.find(f[i]);
            auto ib = pos.find(f[(i + 1) % n]);
            if (ia == pos.end() || ib == pos.end()) { bad = true; break; }
            total += ia->second[0] * ib->second[1] - ib->second[0] * ia->second[1];
        }
        if (bad) continue;
        double area = std::abs(total) / 2.0;
        if (area > best_area + 1e-9) {
            best_area = area;
            best = f;
        } else if (std::abs(area - best_area) <= 1e-9 && best && f.size() > best->size()) {
            best = f;
        }
    }
    return best;
}

// --- PlanarEmbedding methods ---

PlanarEmbedding PlanarEmbedding::from_embedding_object(
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const planarity::StringEmbedding& emb,
    const std::vector<std::string>& outer) {
    PlanarEmbedding pe;
    pe.node_ids = node_ids;
    pe.edge_pairs = edge_pairs;
    for (size_t i = 0; i < node_ids.size(); ++i) pe.index_by_id[node_ids[i]] = (int)i;
    for (const auto& nid : node_ids) {
        auto it = emb.index_by_id.find(nid);
        if (it != emb.index_by_id.end() && it->second >= 0 && it->second < (int)emb.rotation.size()) {
            pe.rotation_by_id[nid] = emb.rotation[it->second];
        } else {
            pe.rotation_by_id[nid] = {};
        }
    }
    pe.outer_face = outer;
    for (const auto& [u, v] : edge_pairs) pe.edge_set.insert(ekey(u, v));
    if (!emb.faces.empty()) pe.faces = emb.faces;
    else pe.recompute_faces();
    return pe;
}

std::optional<PlanarEmbedding> PlanarEmbedding::from_drawing(
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const PosByStr& pos) {
    auto rot = build_rotation_from_positions(node_ids, edge_pairs, pos);
    if (!rot) return std::nullopt;
    auto faces = extract_faces_from_rotation_map(*rot);
    if (faces.empty()) return std::nullopt;
    PlanarEmbedding pe;
    pe.node_ids = node_ids;
    pe.edge_pairs = edge_pairs;
    for (size_t i = 0; i < node_ids.size(); ++i) pe.index_by_id[node_ids[i]] = (int)i;
    pe.rotation_by_id = std::move(*rot);
    pe.faces = std::move(faces);
    for (const auto& [u, v] : edge_pairs) pe.edge_set.insert(ekey(u, v));
    auto lf = largest_area_face(pe.faces, pos);
    if (lf) pe.outer_face = *lf;
    return pe;
}

void PlanarEmbedding::recompute_faces() {
    faces = extract_faces_from_rotation_map(rotation_by_id);
}

bool PlanarEmbedding::has_face(const std::vector<std::string>& face) const {
    return find_face_index(faces, face) >= 0;
}

std::optional<std::vector<std::string>> PlanarEmbedding::get_face(
    const std::vector<std::string>& face) const {
    int idx = find_face_index(faces, face);
    if (idx < 0) return std::nullopt;
    return faces[idx];
}

std::string PlanarEmbedding::next_dummy_id(const std::string& prefix) const {
    std::string base = prefix.empty() ? std::string("@dummy") : prefix;
    std::string nid = base;
    int suffix = 0;
    while (index_by_id.count(nid)) {
        ++suffix;
        nid = base + std::to_string(suffix);
    }
    return nid;
}

bool PlanarEmbedding::add_edge(const std::string& u, const std::string& v) {
    std::string k = ekey(u, v);
    if (edge_set.count(k)) return false;
    edge_set.insert(k);
    edge_pairs.emplace_back(u, v);
    return true;
}

void PlanarEmbedding::set_outer_face(const std::vector<std::string>& face) {
    auto matched = get_face(face);
    if (!matched) throw std::runtime_error("Requested outer face is not present in the embedding");
    outer_face = *matched;
}

planarity::StringEmbedding PlanarEmbedding::to_embedding_object() const {
    planarity::StringEmbedding emb;
    emb.ok = true;
    emb.id_by_index = node_ids;
    for (size_t i = 0; i < node_ids.size(); ++i) emb.index_by_id[node_ids[i]] = (int)i;
    emb.edges = edge_pairs;
    emb.rotation.reserve(node_ids.size());
    for (const auto& nid : node_ids) {
        auto it = rotation_by_id.find(nid);
        emb.rotation.push_back(it != rotation_by_id.end() ? it->second : std::vector<std::string>{});
    }
    emb.faces = faces;
    emb.outer_face = outer_face;
    return emb;
}

// --- triangulation ---

namespace {

// Split face into segments separated by repeated vertices. Mirrors
// split_face_into_segments in Python.
std::vector<std::vector<std::string>> split_face_into_segments(const std::vector<std::string>& face) {
    if (face.empty()) return {};
    std::vector<std::string> walk = face;
    if (walk.back() != walk.front()) walk.push_back(walk.front());

    std::vector<std::vector<std::string>> segments;
    std::vector<std::string> current;
    std::unordered_set<std::string> seen;
    std::unordered_map<std::string,int> counts;
    for (const auto& c : face) counts[c]++;

    for (const auto& v : walk) {
        if (!seen.count(v)) {
            current.push_back(v);
            seen.insert(v);
            continue;
        }
        if (!current.empty()) segments.push_back(current);
        current = {v};
        seen = {v};
    }
    if (current.size() > 1
        || (current.size() == 1 && current[0] != walk.front())
        || (current.size() == 1 && current[0] == walk.front() && counts[current[0]] > 1)) {
        segments.push_back(current);
    }
    return segments;
}

struct TriangulateFaceOptions {
    std::string dummy_prefix = "@dummy";
    bool new_outer_face = false;
    std::vector<std::string>* created_dummy_ids = nullptr;  // if set, append
};

// Stellate (insert a center dummy) for one face. Returns dummy-count added.
int triangulate_face(PlanarEmbedding& pe, const std::vector<std::string>& face,
                     const TriangulateFaceOptions& opts) {
    auto matched_opt = pe.get_face(face);
    if (!matched_opt) throw std::runtime_error("Face not found in embedding");
    const auto& matched = *matched_opt;
    if (matched.size() < 3) throw std::runtime_error("Cannot stellate a face with fewer than 3 vertices");

    auto create_dummy = [&]() -> std::string {
        std::string d = pe.next_dummy_id(opts.dummy_prefix);
        pe.index_by_id[d] = (int)pe.node_ids.size();
        pe.node_ids.push_back(d);
        pe.rotation_by_id[d] = {};
        if (opts.created_dummy_ids) opts.created_dummy_ids->push_back(d);
        return d;
    };

    auto link_dummy_to_dummy = [&](const std::string& prev_d, const std::string& next_d) {
        if (!pe.add_edge(prev_d, next_d)) throw std::runtime_error("Dummy path introduced a duplicate edge");
        pe.rotation_by_id[prev_d].push_back(next_d);
        pe.rotation_by_id[next_d].push_back(prev_d);
    };

    auto link_dummy_to_boundary = [&](const std::string& dummy, const std::string& vertex, const std::string& prev_boundary) {
        if (!pe.add_edge(dummy, vertex)) throw std::runtime_error("Face triangulation still produced a multi-edge");
        insert_before(pe.rotation_by_id[vertex], prev_boundary, dummy);
        pe.rotation_by_id[dummy].push_back(vertex);
    };

    auto segments = split_face_into_segments(matched);
    std::string first_vertex = matched.front();
    std::string previous_boundary = matched.back();
    std::vector<std::string> dummy_ids;
    int dummy_count = 0;

    for (size_t i = 0; i < segments.size(); ++i) {
        std::string d = create_dummy();
        dummy_ids.push_back(d);
        ++dummy_count;
        if (i > 0) {
            std::string prev_d = dummy_ids[i - 1];
            std::string prev_seg_last = segments[i - 1].back();
            link_dummy_to_dummy(prev_d, d);
            link_dummy_to_boundary(d, prev_seg_last, prev_d);
        }
        previous_boundary = (i > 0) ? segments[i - 1].back() : matched.back();
        for (const auto& vraw : segments[i]) {
            link_dummy_to_boundary(d, vraw, previous_boundary);
            previous_boundary = vraw;
        }
    }

    if (dummy_ids.size() > 2) {
        std::string center = create_dummy();
        ++dummy_count;
        if (!pe.add_edge(center, first_vertex))
            throw std::runtime_error("Face triangulation still produced a multi-edge");
        insert_before(pe.rotation_by_id[first_vertex], dummy_ids.back(), center);
        pe.rotation_by_id[center].push_back(first_vertex);
        for (const auto& d : dummy_ids) {
            if (!pe.add_edge(center, d)) throw std::runtime_error("Face triangulation still produced a multi-edge");
            pe.rotation_by_id[d].push_back(center);
            pe.rotation_by_id[center].push_back(d);
        }
    }

    pe.recompute_faces();
    if (opts.new_outer_face) {
        pe.set_outer_face({dummy_ids.front(), matched[0], matched[1]});
    }
    return dummy_count;
}

struct InteriorResult { bool ok = true; std::string reason; int dummy_count = 0; };

InteriorResult triangulate_interior_faces(PlanarEmbedding& pe,
                                          const std::vector<std::string>& outer_face) {
    InteriorResult res;
    auto faces_snapshot = pe.faces;
    for (const auto& f : faces_snapshot) {
        if (f.size() <= 3) continue;
        if (same_cyclic_either_direction(f, outer_face)) continue;
        try {
            res.dummy_count += triangulate_face(pe, f, {});
        } catch (const std::exception& e) {
            res.ok = false;
            res.reason = e.what();
            return res;
        }
    }
    return res;
}

struct OuterResult { bool ok = true; std::string reason; int dummy_count = 0; std::vector<std::string> outer_dummy_ids; };

OuterResult triangulate_outer_face_if_requested(PlanarEmbedding& pe,
                                               const std::vector<std::string>& outer_face,
                                               const TriangulateOptions& opts) {
    OuterResult res;
    if (!opts.triangulate_outer_face || outer_face.size() <= 3) return res;
    try {
        TriangulateFaceOptions fopts;
        fopts.dummy_prefix = "@outerDummy";
        fopts.new_outer_face = true;
        fopts.created_dummy_ids = &res.outer_dummy_ids;
        res.dummy_count = triangulate_face(pe, outer_face, fopts);
    } catch (const std::exception& e) {
        res.ok = false;
        res.reason = e.what();
    }
    return res;
}

} // namespace

// add_outer_face_cycle: mirror Python PlanarEmbedding.add_outer_face_cycle.
std::vector<std::string> PlanarEmbedding::add_outer_face_cycle(
    const std::vector<std::string>& face,
    const std::string& outer_dummy_prefix) {
    auto matched_opt = get_face(face);
    if (!matched_opt) throw std::runtime_error("Outer face not found in embedding");
    const auto& matched = *matched_opt;
    if (matched.size() < 3) throw std::runtime_error("Outer-cycle augmentation requires at least 3 boundary vertices");
    if (outer_face.empty() || !same_cyclic_direction(outer_face, matched)) {
        throw std::runtime_error("Outer-cycle augmentation requires the chosen outer face");
    }

    std::vector<std::string> dummy_ids;
    dummy_ids.reserve(matched.size());
    for (size_t i = 0; i < matched.size(); ++i) {
        std::string d = next_dummy_id(outer_dummy_prefix);
        index_by_id[d] = (int)node_ids.size();
        node_ids.push_back(d);
        rotation_by_id[d] = {};
        dummy_ids.push_back(d);
    }
    int n = (int)matched.size();
    for (int i = 0; i < n; ++i) {
        const std::string& v = matched[i];
        const std::string& nxt = matched[(i + 1) % n];
        const std::string& prev = matched[(i - 1 + n) % n];
        const std::string& dc = dummy_ids[i];
        const std::string& dp = dummy_ids[(i - 1 + n) % n];
        const std::string& dn = dummy_ids[(i + 1) % n];

        add_edge(dc, v);
        add_edge(dc, nxt);
        add_edge(dc, dn);

        insert_before(rotation_by_id[v], prev, dc);
        insert_before(rotation_by_id[v], prev, dp);

        rotation_by_id[dc] = {dp, v, nxt, dn};
    }
    recompute_faces();
    set_outer_face(dummy_ids);
    return dummy_ids;
}

TriangulationCheck analyze_internally_triangulated(
    const planarity::StringEmbedding& emb,
    const std::vector<std::string>& outer_face) {
    if (!emb.ok) return {false, "Embedding is not internally triangulated: valid embedding required"};
    if (emb.faces.empty()) return {false, "Embedding is not internally triangulated: faces are missing"};
    int outer_idx = find_outer_face_index(emb.faces, outer_face);
    if (outer_idx < 0) return {false, "Embedding is not internally triangulated: outer face not found in embedding"};
    for (int i = 0; i < (int)emb.faces.size(); ++i) {
        if (i == outer_idx) continue;
        if (emb.faces[i].size() != 3) return {false, "Embedding is not internally triangulated: non-outer face is not a triangle"};
    }
    return {true, ""};
}

std::vector<std::string> choose_longest_face_from_embedding(
    const planarity::StringEmbedding& emb) {
    std::vector<std::string> best;
    for (const auto& f : emb.faces) {
        if (f.size() < 3) continue;
        if (best.empty() || f.size() > best.size()) best = f;
    }
    if (!best.empty()) return best;
    return emb.outer_face;
}

TriangulationResult triangulate_by_face_stellation(
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const planarity::StringEmbedding& emb,
    const std::vector<std::string>& outer_face,
    const TriangulateOptions& opts) {
    TriangulationResult r;
    if (!emb.ok) { r.reason = "triangulateByFaceStellation requires a planar embedding"; return r; }
    if (outer_face.size() < 3) { r.reason = "triangulateByFaceStellation requires an outer face"; return r; }
    PlanarEmbedding pe = PlanarEmbedding::from_embedding_object(node_ids, edge_pairs, emb, outer_face);
    auto ir = triangulate_interior_faces(pe, outer_face);
    if (!ir.ok) { r.reason = ir.reason; return r; }
    auto orr = triangulate_outer_face_if_requested(pe, outer_face, opts);
    if (!orr.ok) { r.reason = orr.reason; return r; }
    r.ok = true;
    r.dummy_count = ir.dummy_count + orr.dummy_count;
    r.embedding = pe.to_embedding_object();
    r.node_ids = pe.node_ids;
    r.edge_pairs = pe.edge_pairs;
    r.outer_face = r.embedding.outer_face;
    r.outer_dummy_ids = std::move(orr.outer_dummy_ids);
    return r;
}

TriangulationResult triangulate_by_outer_cycle(
    const std::vector<std::string>& node_ids,
    const std::vector<std::pair<std::string,std::string>>& edge_pairs,
    const planarity::StringEmbedding& emb,
    const std::vector<std::string>& outer_face,
    const TriangulateOptions& opts) {
    TriangulationResult r;
    if (!emb.ok) { r.reason = "triangulateByOuterCycle requires a planar embedding"; return r; }
    if (outer_face.size() < 3) { r.reason = "triangulateByOuterCycle requires an outer face"; return r; }
    PlanarEmbedding pe = PlanarEmbedding::from_embedding_object(node_ids, edge_pairs, emb, outer_face);

    std::vector<std::string> outer_dummy_ids;
    try {
        outer_dummy_ids = pe.add_outer_face_cycle(outer_face);
    } catch (const std::exception& e) {
        r.reason = e.what();
        return r;
    }
    int dummy_count = (int)outer_dummy_ids.size();
    std::vector<std::string> current_outer = pe.outer_face.empty() ? outer_face : pe.outer_face;

    auto ir = triangulate_interior_faces(pe, current_outer);
    if (!ir.ok) { r.reason = ir.reason; return r; }
    dummy_count += ir.dummy_count;

    auto orr = triangulate_outer_face_if_requested(pe, current_outer, opts);
    if (!orr.ok) { r.reason = orr.reason; return r; }
    dummy_count += orr.dummy_count;

    auto final_emb = pe.to_embedding_object();
    const auto& check_outer = final_emb.outer_face.empty() ? current_outer : final_emb.outer_face;
    auto tri = analyze_internally_triangulated(final_emb, check_outer);
    if (!tri.ok) {
        r.reason = "Outer-cycle augmentation did not produce an internally triangulated embedding: " + tri.reason;
        return r;
    }
    r.ok = true;
    r.dummy_count = dummy_count;
    r.embedding = final_emb;
    r.node_ids = pe.node_ids;
    r.edge_pairs = pe.edge_pairs;
    r.outer_face = final_emb.outer_face;
    r.outer_dummy_ids.insert(r.outer_dummy_ids.end(), outer_dummy_ids.begin(), outer_dummy_ids.end());
    r.outer_dummy_ids.insert(r.outer_dummy_ids.end(), orr.outer_dummy_ids.begin(), orr.outer_dummy_ids.end());
    return r;
}

} // namespace planarvibe::pg
