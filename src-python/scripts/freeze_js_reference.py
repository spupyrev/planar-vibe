"""Freeze JS layout output as golden reference data.

Runs the JS pipeline via a tiny Node driver (src-python/scripts/js_driver.mjs)
for a given benchmark × algorithm matrix and writes one JSON per (graph, algo)
to src-python/tests/golden/<algorithm>/<dataset>/<graph>.json.

Does NOT modify any JS source.

Usage (from repo root):
  python src-python/scripts/freeze_js_reference.py \
      --benchmark benchmark/sample_graphs_coords.dot \
      --algorithm tutte \
      [--graph sample1]
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DRIVER = REPO_ROOT / "src-python" / "scripts" / "js_driver.mjs"
GOLDEN_ROOT = REPO_ROOT / "src-python" / "tests" / "golden"

# All algorithm keys available in the JS pipeline (see createAlgorithmSpecs in
# scripts/report-shared.mjs). Random is covered via the 'input' pseudo-algo for
# graphs with embedded coords; for graphs without coords we'd need to add it.
ALGORITHMS = [
    "tutte", "air", "cleanair", "areagrad",
    "facebalancer", "edgebalancer", "anglebalancer", "fabalancer",
    "gpt", "claude",
    "reweight", "forcedir", "impred",
    "fpp", "schnyder",
    "ceg_bfs", "ceg_xy",
    "p3t",
]


def _import_benchmarks():
    sys.path.insert(0, str(REPO_ROOT / "src-python"))
    from planarvibe import benchmarks  # noqa: WPS433
    return benchmarks


def freeze_one(
    node_bin: str,
    dot_file: Path,
    graph_name: str,
    algorithm: str,
    out_path: Path,
) -> dict:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [node_bin, str(DRIVER), str(dot_file), graph_name, algorithm],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        return {
            "ok": False,
            "message": proc.stderr.strip() or f"driver exited {proc.returncode}",
            "dataset": dot_file.stem,
            "graph": graph_name,
            "algorithm": algorithm,
        }
    try:
        rec = json.loads(proc.stdout.strip())
    except json.JSONDecodeError as exc:
        return {
            "ok": False,
            "message": f"driver output not JSON: {exc}; stdout={proc.stdout[:200]!r}",
            "dataset": dot_file.stem,
            "graph": graph_name,
            "algorithm": algorithm,
        }
    out_path.write_text(json.dumps(rec, indent=2) + "\n", encoding="utf-8")
    return rec


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--benchmark", required=True, help="Path to a .dot benchmark file (relative to repo root).")
    parser.add_argument("--algorithm", action="append", default=[], help="Algorithm key(s) to freeze. Repeatable. Default: all.")
    parser.add_argument("--graph", action="append", default=[], help="Graph name(s) to include. Default: all graphs in the benchmark.")
    parser.add_argument("--node", default=os.environ.get("NODE_BIN", "/local/home/spupyrev/opt/node-v16.20.2-linux-x64/bin/node"), help="Path to node binary.")
    parser.add_argument("--max-graphs", type=int, default=None, help="Freeze only the first N graphs (useful for iteration).")
    args = parser.parse_args()

    benchmarks = _import_benchmarks()
    bench_path = (REPO_ROOT / args.benchmark).resolve()
    if not bench_path.exists():
        print(f"Benchmark not found: {bench_path}", file=sys.stderr)
        return 2
    bench = benchmarks.load_benchmark(bench_path)
    graphs = bench.graphs
    if args.graph:
        wanted = set(args.graph)
        graphs = [g for g in graphs if g.graph_name in wanted]
    if args.max_graphs is not None:
        graphs = graphs[: args.max_graphs]

    algorithms = args.algorithm or ALGORITHMS

    failures = 0
    for algorithm in algorithms:
        for graph_entry in graphs:
            out_path = GOLDEN_ROOT / algorithm / bench.dataset / f"{graph_entry.graph_name}.json"
            print(f"  freezing {bench.dataset} :: {graph_entry.graph_name} :: {algorithm}", flush=True)
            rec = freeze_one(args.node, bench_path, graph_entry.graph_name, algorithm, out_path)
            if not rec.get("ok", False):
                failures += 1
                print(f"    failed: {rec.get('message')}", flush=True)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
