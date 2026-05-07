// Tiny test runner. Just `assert` macros wrapped so failures print.

#include "dot.hpp"
#include "graph.hpp"
#include "planarity.hpp"
#include "layouts/random_layout.hpp"

#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <string>

using namespace planarvibe;

#define EXPECT(cond) do { \
    if (!(cond)) { std::fprintf(stderr, "FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); std::exit(1); } \
} while (0)

static void test_graph_add() {
    Graph g;
    int a = g.add_node("a");
    int b = g.add_node("b");
    int a2 = g.add_node("a");
    EXPECT(a == 0);
    EXPECT(b == 1);
    EXPECT(a2 == 0);
    EXPECT(g.n == 2);
    g.add_edge(a, b);
    g.add_edge(b, a);  // duplicate, should dedup
    g.add_edge(a, a);  // self loop, ignored
    EXPECT(g.edges.size() == 1);
    EXPECT(g.adjacency[a].size() == 1);
}

static void test_dot_parse() {
    // Round-trip via a temp file.
    const char* path = "/tmp/_pvibe_test.dot";
    {
        std::ofstream f(path);
        f << "graph g1 {\n"
             "  v 0 1.5 2.5;\n"
             "  v 1 3.0 4.0;\n"
             "  0 -- 1;\n"
             "  2 -- 1;\n"
             "  // comment\n"
             "}\n";
    }
    auto parsed = dot::parse_file(path);
    EXPECT(parsed.size() == 1);
    const auto& p = parsed[0];
    EXPECT(p.name == "g1");
    EXPECT(p.graph.n == 3);
    EXPECT(p.graph.edges.size() == 2);
    // node "0" should have its position
    int id0 = p.graph.name_to_id.at("0");
    EXPECT(p.positions.has(id0));
    EXPECT(p.positions.pos[id0][0] == 1.5);
    EXPECT(p.positions.pos[id0][1] == 2.5);
}

static void test_random_layout_smoke() {
    Graph g;
    g.add_node("a"); g.add_node("b"); g.add_node("c");
    g.add_edge(0, 1); g.add_edge(1, 2);
    auto r = layouts::random_layout(g);
    EXPECT(r.ok);
    EXPECT((int)r.positions.pos.size() == g.n);
    // Metrics are computed by apply_layout.cpp, not by the layout itself.
}

static void test_planarity_k4() {
    // K4 is planar; 4 triangular faces.
    using namespace planarvibe::planarity;
    std::vector<std::string> ids = {"0","1","2","3"};
    std::vector<std::pair<std::string,std::string>> edges = {
        {"0","1"},{"0","2"},{"0","3"},{"1","2"},{"1","3"},{"2","3"}};
    auto emb = compute_planar_embedding(ids, edges);
    EXPECT(emb.ok);
    EXPECT(emb.faces.size() == 4);
    // Every face in K4 is a triangle.
    for (const auto& f : emb.faces) EXPECT(f.size() == 3);
    EXPECT(emb.outer_face.size() == 3);
}

static void test_planarity_k5_nonplanar() {
    using namespace planarvibe::planarity;
    std::vector<std::string> ids = {"0","1","2","3","4"};
    std::vector<std::pair<std::string,std::string>> edges;
    for (int i = 0; i < 5; ++i)
        for (int j = i+1; j < 5; ++j)
            edges.emplace_back(std::to_string(i), std::to_string(j));
    auto emb = compute_planar_embedding(ids, edges);
    EXPECT(!emb.ok);
}

int main() {
    test_graph_add();
    test_dot_parse();
    test_random_layout_smoke();
    test_planarity_k4();
    test_planarity_k5_nonplanar();
    std::printf("OK  all tests passed\n");
    return 0;
}
