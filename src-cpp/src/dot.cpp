#include "dot.hpp"

#include <cctype>
#include <fstream>
#include <sstream>
#include <stdexcept>

namespace planarvibe::dot {

namespace {

std::string trim(const std::string& s) {
    size_t a = 0;
    while (a < s.size() && std::isspace((unsigned char)s[a])) ++a;
    size_t b = s.size();
    while (b > a && std::isspace((unsigned char)s[b-1])) --b;
    return s.substr(a, b - a);
}

std::string strip_line_comment(const std::string& s) {
    auto pos = s.find("//");
    if (pos == std::string::npos) return s;
    return s.substr(0, pos);
}

std::string unquote(const std::string& s) {
    if (s.size() >= 2 && s.front() == '"' && s.back() == '"') {
        return s.substr(1, s.size() - 2);
    }
    return s;
}

bool starts_with_graph_block(const std::string& line, std::string& name_out) {
    // Match optional 'strict' then 'graph <name> {'.
    std::istringstream iss(line);
    std::string tok;
    if (!(iss >> tok)) return false;
    if (tok == "strict") { if (!(iss >> tok)) return false; }
    if (tok != "graph" && tok != "Graph" && tok != "GRAPH") return false;
    std::string name;
    if (!(iss >> name)) return false;
    // The '{' may be glued or separate.
    if (!name.empty() && name.back() == '{') {
        name.pop_back();
        name = trim(name);
    } else {
        std::string brace;
        if (!(iss >> brace) || brace != "{") return false;
    }
    name_out = unquote(trim(name));
    return true;
}

// Parse the contents of a single statement (';'-delimited inside a block).
// Dispatches to vertex/edge/node.
struct Builder {
    Graph g;
    PositionMap pos;
    // For dedup: edges tracked via graph.add_edge's O(deg) check.
};

void handle_statement(Builder& b, const std::string& stmt) {
    if (stmt.empty()) return;
    std::istringstream iss(stmt);
    std::string a;
    if (!(iss >> a)) return;

    if (a == "v" || a == "V") {
        std::string vid;
        if (!(iss >> vid)) return;
        vid = unquote(vid);
        double x = 0, y = 0;
        bool have_xy = bool(iss >> x) && bool(iss >> y);
        int id = b.g.add_node(vid);
        if ((int)b.pos.pos.size() < b.g.n) b.pos.resize(b.g.n);
        if (have_xy) b.pos.put(id, x, y);
        return;
    }

    // Edge: "A -- B" possibly followed by attrs we ignore.
    std::string op;
    if (iss >> op && op == "--") {
        std::string bid;
        if (!(iss >> bid)) return;
        std::string bv = unquote(bid);
        std::string av = unquote(a);
        int u = b.g.add_node(av);
        int v = b.g.add_node(bv);
        b.pos.resize(b.g.n);
        b.g.add_edge(u, v);
        return;
    }

    // Bare node.
    int id = b.g.add_node(unquote(a));
    (void)id;
    b.pos.resize(b.g.n);
}

} // namespace

std::vector<ParsedGraph> parse_file(const std::string& path) {
    std::ifstream in(path);
    if (!in) throw std::runtime_error("cannot open DOT file: " + path);
    std::vector<ParsedGraph> out;
    std::string line;

    Builder cur;
    bool in_block = false;
    std::string cur_name;

    while (std::getline(in, line)) {
        std::string s = trim(strip_line_comment(line));
        if (s.empty()) continue;

        if (!in_block) {
            if (starts_with_graph_block(s, cur_name)) {
                in_block = true;
                cur = Builder{};
            }
            continue;
        }

        // Inside a block. Watch for the closing '}' possibly sharing a line.
        // Split on ';' and '}'.
        std::string buf;
        for (char ch : s) {
            if (ch == ';') {
                std::string stmt = trim(buf);
                if (!stmt.empty()) handle_statement(cur, stmt);
                buf.clear();
            } else if (ch == '}') {
                std::string stmt = trim(buf);
                if (!stmt.empty()) handle_statement(cur, stmt);
                buf.clear();
                // Finish this graph.
                cur.pos.resize(cur.g.n);
                out.push_back({cur_name, std::move(cur.g), std::move(cur.pos)});
                cur = Builder{};
                in_block = false;
            } else {
                buf.push_back(ch);
            }
        }
        if (in_block) {
            std::string rest = trim(buf);
            if (!rest.empty()) handle_statement(cur, rest);
        }
    }

    return out;
}

} // namespace planarvibe::dot
