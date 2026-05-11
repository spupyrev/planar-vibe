"""Benchmark DOT file loader.

Mirrors the tiny DOT parser used by scripts/apply-layout-js.mjs (parseDotCollections).
Reads `graph <name> { ... }` blocks with two kinds of statements:
  - vertex with coords:  v <id> <x> <y> ;
  - edge:                <u> -- <v> ;
Line comments `// ...` and blank lines are ignored.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class ParsedGraph:
    """Container for a parsed graph matching JS `{nodeIds, edgePairs, positionsById}`."""

    node_ids: list[str] = field(default_factory=list)
    edge_pairs: list[tuple[str, str]] = field(default_factory=list)
    positions_by_id: dict[str, tuple[float, float]] = field(default_factory=dict)


@dataclass
class BenchmarkGraph:
    graph_name: str
    parsed: ParsedGraph


@dataclass
class Benchmark:
    dataset: str
    file_path: str
    graphs: list[BenchmarkGraph]


_GRAPH_START = re.compile(r'^(?:strict\s+)?graph\s+("?[^"{]+"?)\s*\{$', re.IGNORECASE)
_VERTEX = re.compile(
    r'^v\s+("?[^"\s\[]+"?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)(?:\s+.*)?$',
    re.IGNORECASE,
)
_EDGE = re.compile(r'^("?[^"\s\[]+"?)\s*--\s*("?[^"\s\[]+"?)')
_NODE = re.compile(r'^("?[^"\s\[]+"?)$')


def _unquote(s: str) -> str:
    if len(s) >= 2 and s[0] == '"' and s[-1] == '"':
        return s[1:-1]
    return s


def parse_dot_collections(text: str) -> list[BenchmarkGraph]:
    graphs: list[BenchmarkGraph] = []
    current: dict | None = None

    def finish_current() -> None:
        nonlocal current
        if current is None:
            return
        parsed = ParsedGraph(
            node_ids=list(current["nodes"]),
            edge_pairs=list(current["edges"]),
            positions_by_id=dict(current["positions"]),
        )
        graphs.append(BenchmarkGraph(graph_name=current["name"], parsed=parsed))
        current = None

    for raw_line in text.splitlines():
        # strip // line comments
        line = re.sub(r'//.*$', '', raw_line).strip()
        if not line:
            continue

        if current is None:
            m = _GRAPH_START.match(line)
            if m:
                current = {
                    "name": _unquote(m.group(1).strip()),
                    "nodes": [],  # preserve insertion order
                    "_nodes_seen": set(),
                    "edges": [],
                    "seen": set(),
                    "positions": {},
                }
            continue

        if line == "}":
            finish_current()
            continue

        for statement_raw in line.split(";"):
            statement = statement_raw.strip()
            if not statement:
                continue
            if statement == "}":
                finish_current()
                break

            m = _VERTEX.match(statement)
            if m:
                vid = _unquote(m.group(1))
                if vid not in current["_nodes_seen"]:
                    current["_nodes_seen"].add(vid)
                    current["nodes"].append(vid)
                current["positions"][vid] = (float(m.group(2)), float(m.group(3)))
                continue

            m = _EDGE.match(statement)
            if m:
                a = _unquote(m.group(1))
                b = _unquote(m.group(2))
                if a != b:
                    for x in (a, b):
                        if x not in current["_nodes_seen"]:
                            current["_nodes_seen"].add(x)
                            current["nodes"].append(x)
                    key = f"{a}::{b}" if a < b else f"{b}::{a}"
                    if key not in current["seen"]:
                        current["seen"].add(key)
                        current["edges"].append((a, b))
                continue

            m = _NODE.match(statement)
            if m:
                vid = _unquote(m.group(1))
                if vid not in current["_nodes_seen"]:
                    current["_nodes_seen"].add(vid)
                    current["nodes"].append(vid)

    finish_current()
    return graphs


def parse_edge_list_text(text: str) -> ParsedGraph:
    """Fallback edge-list parser (mirrors parseEdgeListText in report-shared.mjs)."""
    parsed = ParsedGraph()
    seen_nodes: set[str] = set()
    seen_edges: set[str] = set()

    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if parts[0] in ("v", "V"):
            if len(parts) >= 2:
                vid = parts[1]
                if vid not in seen_nodes:
                    seen_nodes.add(vid)
                    parsed.node_ids.append(vid)
            if len(parts) >= 4:
                try:
                    x = float(parts[2])
                    y = float(parts[3])
                    parsed.positions_by_id[parts[1]] = (x, y)
                except ValueError:
                    pass
            continue
        if len(parts) < 2:
            continue
        a, b = parts[0], parts[1]
        if a == b:
            continue
        for x in (a, b):
            if x not in seen_nodes:
                seen_nodes.add(x)
                parsed.node_ids.append(x)
        key = f"{a}::{b}" if a < b else f"{b}::{a}"
        if key not in seen_edges:
            seen_edges.add(key)
            parsed.edge_pairs.append((a, b))

    return parsed


def load_benchmark(file_path: str | Path) -> Benchmark:
    path = Path(file_path)
    text = path.read_text(encoding="utf-8")
    dot_graphs = parse_dot_collections(text)
    dataset = path.stem
    if dot_graphs:
        return Benchmark(dataset=dataset, file_path=str(path), graphs=dot_graphs)
    fallback = parse_edge_list_text(text)
    return Benchmark(
        dataset=dataset,
        file_path=str(path),
        graphs=[BenchmarkGraph(graph_name=dataset, parsed=fallback)],
    )
