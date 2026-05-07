#!/usr/bin/env python3
"""Compare JS, Python, and C++ layout/metric output on a benchmark.

Usage:
  python3 scripts/compare-implementations.py \
      --benchmark benchmark/sample_graphs_coords.dot \
      --top 20
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src-python"))

from planarvibe import benchmarks  # noqa: E402

for _v in (
    "OMP_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "MKL_NUM_THREADS",
    "NUMEXPR_NUM_THREADS",
    "BLIS_NUM_THREADS",
):
    os.environ.setdefault(_v, "1")

METRIC_KEYS = [
    "angularResolution",
    "aspectRatio",
    "convexity",
    "edgeLengthDeviation",
    "edgeRatio",
    "edgeOrthogonality",
    "face",
    "nodeUniformity",
    "alignment",
    "spacing",
]

DEFAULT_ALGORITHMS = [
    "input",
    "random",
    "tutte",
    "fpp",
    "schnyder",
    "reweight",
    "ceg_bfs",
    "ceg_xy",
    "forcedir",
    "air",
    "areagrad",
    "impred",
    "facebalancer",
    "edgebalancer",
    "anglebalancer",
    "fabalancer",
    "gpt",
    "claude",
]

ALL_KNOWN_ALGORITHMS = DEFAULT_ALGORITHMS[:6] + ["p3t"] + DEFAULT_ALGORITHMS[6:]
IMPLEMENTATIONS = ("js", "python", "cpp")


def _split_csv(values: list[str]) -> list[str]:
    out: list[str] = []
    for raw in values or []:
        out.extend(x.strip() for x in str(raw).split(",") if x.strip())
    return out


def _safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", str(value))


def _load_json_file(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _run_command(cmd: list[str], timeout: float, output_path: Path | None = None) -> dict:
    start = time.monotonic()
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "message": f"TLE ({int(timeout)}s)",
            "timed_out": True,
            "wall_s": time.monotonic() - start,
        }
    wall_s = time.monotonic() - start
    if proc.returncode != 0:
        msg = (proc.stderr.strip() or proc.stdout.strip() or f"exit {proc.returncode}")[:1000]
        return {"ok": False, "message": msg, "wall_s": wall_s}

    if output_path is not None:
        rec = _load_json_file(output_path)
    else:
        try:
            rec = json.loads(proc.stdout.strip())
        except json.JSONDecodeError:
            rec = None
    if not isinstance(rec, dict):
        return {"ok": False, "message": "Could not parse JSON output", "wall_s": wall_s}
    rec["wall_s"] = wall_s
    return rec


def _run_one(
    impl: str,
    algorithm: str,
    dot_file: Path,
    graph_name: str,
    tmp_dir: Path,
    timeout: float,
    node_bin: str,
    cpp_bin: str,
) -> tuple[str, str, str, dict]:
    if impl == "js":
        cmd = [
            node_bin,
            str(REPO_ROOT / "src-python" / "scripts" / "js_driver.mjs"),
            str(dot_file),
            graph_name,
            algorithm,
        ]
        rec = _run_command(cmd, timeout)
    elif impl == "python":
        out_path = tmp_dir / f"python_{_safe_name(algorithm)}_{_safe_name(graph_name)}.json"
        cmd = [
            sys.executable,
            str(REPO_ROOT / "src-python" / "scripts" / "apply_layout.py"),
            str(dot_file),
            graph_name,
            algorithm,
            "--out",
            str(out_path),
        ]
        rec = _run_command(cmd, timeout, out_path)
    elif impl == "cpp":
        out_path = tmp_dir / f"cpp_{_safe_name(algorithm)}_{_safe_name(graph_name)}.json"
        cmd = [cpp_bin, str(dot_file), graph_name, algorithm, "--out", str(out_path)]
        rec = _run_command(cmd, timeout, out_path)
    else:
        raise ValueError(f"Unknown implementation: {impl}")
    return impl, algorithm, graph_name, rec


def _metric_value(record: dict, key: str) -> float | None:
    m = record.get("metrics") if isinstance(record, dict) else None
    if not isinstance(m, dict):
        return None
    value = m.get(key)
    return float(value) if isinstance(value, (int, float)) and math.isfinite(value) else None


def _total_score(record: dict) -> float | None:
    values = [_metric_value(record, key) for key in METRIC_KEYS]
    if any(v is None for v in values):
        return None
    return sum(v or 0.0 for v in values) / len(METRIC_KEYS)


def _range(values: dict[str, float]) -> float:
    return max(values.values()) - min(values.values())


def _format_value(value: float | None) -> str:
    if value is None:
        return "--"
    return f"{value:.12g}"


def _display_path(path: Path) -> str:
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def _write_csv(path: Path, metric_rows: list[dict], total_rows: list[dict], failures: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(
            fh,
            fieldnames=[
                "kind",
                "algorithm",
                "graph",
                "metric",
                "range",
                "js",
                "python",
                "cpp",
                "implementation",
                "message",
            ],
        )
        writer.writeheader()
        for row in total_rows:
            writer.writerow({"kind": "total", **row, "implementation": "", "message": ""})
        for row in metric_rows:
            writer.writerow({"kind": "metric", **row, "implementation": "", "message": ""})
        for row in failures:
            writer.writerow({
                "kind": "failure",
                "algorithm": row["algorithm"],
                "graph": row["graph"],
                "metric": "",
                "range": "",
                "js": "",
                "python": "",
                "cpp": "",
                "implementation": row["implementation"],
                "message": row["message"],
            })


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--benchmark", required=True, help="Path to a .dot benchmark file.")
    parser.add_argument("--algorithm", "--algorithms", action="append", default=[],
                        help="Algorithm(s) to run. May be repeated or comma-separated. Default: comparable set without p3t.")
    parser.add_argument("--exclude", action="append", default=[],
                        help="Algorithm(s) to exclude. May be repeated or comma-separated.")
    parser.add_argument("--include-p3t", action="store_true",
                        help="Include p3t in the default algorithm set.")
    parser.add_argument("--graph", action="append", default=[],
                        help="Graph name(s) to include. May be repeated or comma-separated. Default: all.")
    parser.add_argument("--max-graphs", type=int, default=None)
    parser.add_argument("--graphs-sample", choices=["first", "spread"], default="spread")
    parser.add_argument("--workers", type=int, default=min(8, os.cpu_count() or 1))
    parser.add_argument("--timeout", type=float, default=420.0, help="Timeout per implementation run, seconds.")
    parser.add_argument("--top", type=int, default=20, help="Number of largest rows to print.")
    parser.add_argument("--out", help="Optional CSV output path.")
    parser.add_argument("--node-bin", default=os.environ.get("NODE_BIN", "node"))
    parser.add_argument("--cpp-bin", default=str(REPO_ROOT / "src-cpp" / "build" / "apply_layout"))
    parser.add_argument("--max-metric-range", type=float, default=None,
                        help="Exit nonzero if the largest metric range exceeds this threshold.")
    parser.add_argument("--max-total-range", type=float, default=None,
                        help="Exit nonzero if the largest total-score range exceeds this threshold.")
    parser.add_argument("--fail-on-failure", action="store_true",
                        help="Exit nonzero if any implementation run fails.")
    args = parser.parse_args()

    bench_path = (REPO_ROOT / args.benchmark).resolve()
    bench = benchmarks.load_benchmark(bench_path)
    graphs = bench.graphs

    requested_graphs = set(_split_csv(args.graph))
    if requested_graphs:
        graphs = [g for g in graphs if g.graph_name in requested_graphs]
    if args.max_graphs and len(graphs) > args.max_graphs:
        if args.graphs_sample == "spread":
            step = len(graphs) / args.max_graphs
            graphs = [graphs[int(step * i)] for i in range(args.max_graphs)]
        else:
            graphs = graphs[:args.max_graphs]
    if not graphs:
        print("No graphs selected.", file=sys.stderr)
        return 2

    requested_algorithms = _split_csv(args.algorithm)
    if requested_algorithms:
        algorithms = requested_algorithms
    else:
        algorithms = ALL_KNOWN_ALGORITHMS[:] if args.include_p3t else DEFAULT_ALGORITHMS[:]
    excludes = set(_split_csv(args.exclude))
    algorithms = [alg for alg in algorithms if alg not in excludes]
    if not algorithms:
        print("No algorithms selected.", file=sys.stderr)
        return 2

    print(f"Benchmark: {_display_path(bench_path)}")
    print(f"Graphs: {len(graphs)}")
    print(f"Algorithms: {len(algorithms)} ({', '.join(algorithms)})")
    print(f"Runs: {len(graphs) * len(algorithms) * len(IMPLEMENTATIONS)}")
    print(f"Workers: {args.workers}, timeout: {args.timeout:g}s")

    results: dict[tuple[str, str], dict[str, dict]] = {
        (alg, entry.graph_name): {} for alg in algorithms for entry in graphs
    }
    failures: list[dict] = []
    tasks = [(impl, alg, entry.graph_name) for alg in algorithms for entry in graphs for impl in IMPLEMENTATIONS]
    total = len(tasks)
    done = 0
    started = time.monotonic()
    last_report = started

    with tempfile.TemporaryDirectory(prefix="planarvibe-impl-compare-") as tmp_raw:
        tmp_dir = Path(tmp_raw)
        with ThreadPoolExecutor(max_workers=args.workers) as executor:
            futures = [
                executor.submit(
                    _run_one,
                    impl,
                    alg,
                    bench_path,
                    graph_name,
                    tmp_dir,
                    args.timeout,
                    args.node_bin,
                    args.cpp_bin,
                )
                for impl, alg, graph_name in tasks
            ]
            for future in as_completed(futures):
                impl, alg, graph_name, rec = future.result()
                results[(alg, graph_name)][impl] = rec
                if not rec.get("ok"):
                    failures.append({
                        "implementation": impl,
                        "algorithm": alg,
                        "graph": graph_name,
                        "message": str(rec.get("message") or "failed"),
                    })
                done += 1
                now = time.monotonic()
                if done == total or done % 50 == 0 or now - last_report >= 30:
                    print(f"progress {done}/{total} elapsed={now - started:.1f}s failures={len(failures)}", flush=True)
                    last_report = now

    metric_rows: list[dict] = []
    total_rows: list[dict] = []
    ok_triples = 0
    missing_triples = 0

    for alg in algorithms:
        for entry in graphs:
            graph_name = entry.graph_name
            recs = results[(alg, graph_name)]
            if len(recs) != len(IMPLEMENTATIONS) or not all(recs.get(impl, {}).get("ok") for impl in IMPLEMENTATIONS):
                missing_triples += 1
                continue
            ok_triples += 1

            total_values = {impl: _total_score(recs[impl]) for impl in IMPLEMENTATIONS}
            if all(v is not None for v in total_values.values()):
                values = {impl: float(total_values[impl]) for impl in IMPLEMENTATIONS}
                total_rows.append({
                    "algorithm": alg,
                    "graph": graph_name,
                    "metric": "total",
                    "range": _range(values),
                    "js": values["js"],
                    "python": values["python"],
                    "cpp": values["cpp"],
                })

            for metric in METRIC_KEYS:
                values = {impl: _metric_value(recs[impl], metric) for impl in IMPLEMENTATIONS}
                if all(v is not None for v in values.values()):
                    numeric = {impl: float(values[impl]) for impl in IMPLEMENTATIONS}
                    metric_rows.append({
                        "algorithm": alg,
                        "graph": graph_name,
                        "metric": metric,
                        "range": _range(numeric),
                        "js": numeric["js"],
                        "python": numeric["python"],
                        "cpp": numeric["cpp"],
                    })

    metric_rows.sort(key=lambda r: r["range"], reverse=True)
    total_rows.sort(key=lambda r: r["range"], reverse=True)

    elapsed = time.monotonic() - started
    print(f"\nCompleted in {elapsed:.1f}s")
    print(f"Comparable triples: {ok_triples}/{len(algorithms) * len(graphs)}")
    print(f"Failures: {len(failures)}")
    if failures:
        print("\nFailures:")
        for row in failures[:args.top]:
            print(f"  {row['implementation']:<6} {row['algorithm']:<13} {row['graph']:<12} {row['message'][:160]}")

    print("\nTop Metric Ranges:")
    for row in metric_rows[:args.top]:
        print(
            f"{row['range']:.12g}  {row['algorithm']:<13} {row['graph']:<12} {row['metric']:<20} "
            f"js={_format_value(row['js'])} py={_format_value(row['python'])} cpp={_format_value(row['cpp'])}"
        )

    print("\nTop Total Ranges:")
    for row in total_rows[:args.top]:
        print(
            f"{row['range']:.12g}  {row['algorithm']:<13} {row['graph']:<12} "
            f"js={_format_value(row['js'])} py={_format_value(row['python'])} cpp={_format_value(row['cpp'])}"
        )

    max_metric = metric_rows[0]["range"] if metric_rows else 0.0
    max_total = total_rows[0]["range"] if total_rows else 0.0
    print(f"\nMax metric range: {_format_value(max_metric)}")
    print(f"Max total range: {_format_value(max_total)}")

    if args.out:
        _write_csv(Path(args.out), metric_rows, total_rows, failures)
        print(f"Wrote CSV: {args.out}")

    if args.fail_on_failure and failures:
        return 1
    if args.max_metric_range is not None and max_metric > args.max_metric_range:
        return 1
    if args.max_total_range is not None and max_total > args.max_total_range:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
