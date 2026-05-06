"""Aggregate JS vs Python metric comparison across a benchmark corpus.

For each (layout, graph) pair:
  - Ensure JS golden JSON exists (freeze on demand)
  - Run Python apply_layout, extract 10 metrics
  - Collect (py_metric, js_metric) pairs

Emits a summary table: for each (layout, metric), the mean JS score,
mean Python score, and mean relative diff across graphs.

Usage:
  python3 src-python/scripts/compare_metrics.py \
      --benchmark benchmark/planar_train.dot \
      [--max-graphs 30] \
      [--algorithm tutte --algorithm fpp ...] \
      [--out aggregate.csv]
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "src-python"))
from planarvibe import benchmarks  # noqa: E402

# Pin BLAS to 1 thread per worker so runtimes are comparable with JS (single-threaded)
# and parallelism happens at the graph level instead of inside numpy.
for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
           "NUMEXPR_NUM_THREADS", "BLIS_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

METRIC_KEYS = [
    "angularResolution", "aspectRatio", "convexity",
    "edgeLengthDeviation", "edgeRatio", "edgeOrthogonality",
    "face", "nodeUniformity", "alignment", "spacing",
]

ALL_ALGORITHMS = [
    "tutte", "fpp", "schnyder", "reweight", "ceg_bfs", "ceg_xy",
    "forcedir", "air", "areagrad", "impred",
    "facebalancer", "edgebalancer", "anglebalancer", "fabalancer",
    "gpt", "claude",
]

NODE_BIN = os.environ.get("NODE_BIN", "node")


def _load_json(path: Path) -> dict:
    with path.open() as fh:
        return json.load(fh)


def _freeze_js(algorithm: str, dot_file: Path, graph_name: str, out_path: Path) -> dict | None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    driver = REPO_ROOT / "src-python" / "scripts" / "js_driver.mjs"
    proc = subprocess.run(
        [NODE_BIN, str(driver), str(dot_file), graph_name, algorithm],
        cwd=str(REPO_ROOT), capture_output=True, text=True, timeout=180,
    )
    if proc.returncode != 0:
        return None
    try:
        rec = json.loads(proc.stdout.strip())
    except json.JSONDecodeError:
        return None
    out_path.write_text(json.dumps(rec, indent=2) + "\n", encoding="utf-8")
    return rec


def _run_python(algorithm: str, dot_file: Path, graph_name: str, out_path: Path, timeout: float = 180) -> dict | None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    apply_script = REPO_ROOT / "src-python" / "scripts" / "apply_layout.py"
    try:
        proc = subprocess.run(
            [sys.executable, str(apply_script), str(dot_file), graph_name, algorithm,
             "--out", str(out_path)],
            cwd=str(REPO_ROOT), capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "message": f"TLE ({int(timeout)}s)", "timed_out": True}
    if proc.returncode != 0:
        return None
    try:
        return json.loads(out_path.read_text())
    except (json.JSONDecodeError, FileNotFoundError):
        return None


def _extract_metrics(record: dict) -> dict:
    """JS golden stores metrics under 'metrics' with JS key names; so does Python."""
    m = record.get("metrics") if record else None
    if not isinstance(m, dict):
        return {k: None for k in METRIC_KEYS}
    out = {}
    for key in METRIC_KEYS:
        v = m.get(key)
        out[key] = v if isinstance(v, (int, float)) else None
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--benchmark", required=True)
    ap.add_argument("--max-graphs", type=int, default=None)
    ap.add_argument("--algorithm", action="append", default=[])
    ap.add_argument("--graphs-sample", choices=["first", "spread"], default="spread",
                    help="How to subset graphs when --max-graphs is set")
    ap.add_argument("--out", help="Path for raw CSV dump")
    ap.add_argument("--workers", type=int, default=min(16, os.cpu_count() or 1),
                    help="Parallel worker threads (each runs a JS/Py subprocess)")
    args = ap.parse_args()

    bench_path = (REPO_ROOT / args.benchmark).resolve()
    bench = benchmarks.load_benchmark(bench_path)
    graphs = bench.graphs
    if args.max_graphs and len(graphs) > args.max_graphs:
        if args.graphs_sample == "spread":
            step = len(graphs) / args.max_graphs
            graphs = [graphs[int(step * i)] for i in range(args.max_graphs)]
        else:
            graphs = graphs[: args.max_graphs]
    algorithms = args.algorithm or ALL_ALGORITHMS

    # Aggregation: algorithms × metrics -> list of (js, py) pairs
    per_alg_metric = {alg: {m: [] for m in METRIC_KEYS} for alg in algorithms}
    per_alg_mean_score = {alg: [] for alg in algorithms}
    per_alg_counts = {alg: {"ok_both": 0, "fail_js": 0, "fail_py": 0, "py_timeout": 0} for alg in algorithms}
    per_alg_runtime = {alg: {"js_ms": [], "py_ms": []} for alg in algorithms}

    rows = []  # (algorithm, graph, metric, js, py) — for CSV dump

    def _run_one(algorithm: str, entry) -> tuple:
        graph_name = entry.graph_name
        golden = REPO_ROOT / "src-python" / "tests" / "golden" / algorithm / bench.dataset / f"{graph_name}.json"
        if not golden.exists():
            js_rec = _freeze_js(algorithm, bench_path, graph_name, golden)
        else:
            js_rec = _load_json(golden)
        py_out = Path(f"/tmp/cmp_py_{algorithm}_{graph_name}.json")
        py_rec = _run_python(algorithm, bench_path, graph_name, py_out)
        return (algorithm, graph_name, js_rec, py_rec)

    tasks = [(alg, entry) for entry in graphs for alg in algorithms]
    total = len(tasks)
    start = time.monotonic()
    done_count = 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = {ex.submit(_run_one, alg, entry): (alg, entry) for (alg, entry) in tasks}
        for fut in as_completed(futures):
            algorithm, graph_name, js_rec, py_rec = fut.result()
            done_count += 1
            if done_count % 50 == 0 or done_count == total:
                elapsed = time.monotonic() - start
                print(f"[{done_count}/{total}] elapsed {elapsed:.1f}s", flush=True)

            js_ok = bool(js_rec and js_rec.get("ok"))
            py_ok = bool(py_rec and py_rec.get("ok"))
            if not js_ok:
                per_alg_counts[algorithm]["fail_js"] += 1
            if not py_ok:
                per_alg_counts[algorithm]["fail_py"] += 1
                if py_rec and py_rec.get("timed_out"):
                    per_alg_counts[algorithm]["py_timeout"] += 1
            if js_rec and isinstance(js_rec.get("runtime_ms"), (int, float)):
                per_alg_runtime[algorithm]["js_ms"].append(js_rec["runtime_ms"])
            if py_rec and isinstance(py_rec.get("runtime_ms"), (int, float)):
                per_alg_runtime[algorithm]["py_ms"].append(py_rec["runtime_ms"])
            if js_ok and py_ok:
                per_alg_counts[algorithm]["ok_both"] += 1
                js_m = _extract_metrics(js_rec)
                py_m = _extract_metrics(py_rec)
                js_mean = sum((js_m[k] or 0) for k in METRIC_KEYS) / len(METRIC_KEYS)
                py_mean = sum((py_m[k] or 0) for k in METRIC_KEYS) / len(METRIC_KEYS)
                per_alg_mean_score[algorithm].append((js_mean, py_mean))
                for mk in METRIC_KEYS:
                    j = js_m[mk]
                    p = py_m[mk]
                    if j is not None and p is not None:
                        per_alg_metric[algorithm][mk].append((j, p))
                    rows.append((algorithm, graph_name, mk, j, p))
    elapsed = time.monotonic() - start
    print(f"\nCompleted in {elapsed:.1f}s using {args.workers} workers", flush=True)

    # Print summary table
    header = f"\n{'layout':<15} | {'ok':>4} | {'js_f':>4} | {'py_f':>4} | {'py_tle':>6} | {'js_mean':>8} | {'py_mean':>8} | {'Δscore':>8} | {'js_ms':>8} | {'py_ms':>8} | {'py/js':>6}"
    print(header)
    print("-" * len(header))
    for alg in algorithms:
        counts = per_alg_counts[alg]
        pairs = per_alg_mean_score[alg]
        jsrt = per_alg_runtime[alg]["js_ms"]
        pyrt = per_alg_runtime[alg]["py_ms"]
        js_ms_mean = (sum(jsrt) / len(jsrt)) if jsrt else None
        py_ms_mean = (sum(pyrt) / len(pyrt)) if pyrt else None
        ratio = (py_ms_mean / js_ms_mean) if (js_ms_mean and js_ms_mean > 0 and py_ms_mean) else None
        if pairs:
            js_mean = sum(p[0] for p in pairs) / len(pairs)
            py_mean = sum(p[1] for p in pairs) / len(pairs)
            delta = py_mean - js_mean
            js_ms_s = f"{js_ms_mean:>8.1f}" if js_ms_mean is not None else "     -- "
            py_ms_s = f"{py_ms_mean:>8.1f}" if py_ms_mean is not None else "     -- "
            ratio_s = f"{ratio:>6.1f}" if ratio is not None else "    --"
            print(f"{alg:<15} | {counts['ok_both']:>4} | {counts['fail_js']:>4} | {counts['fail_py']:>4} | {counts['py_timeout']:>6} | {js_mean:>8.4f} | {py_mean:>8.4f} | {delta:>+8.4f} | {js_ms_s} | {py_ms_s} | {ratio_s}")
        else:
            js_ms_s = f"{js_ms_mean:>8.1f}" if js_ms_mean is not None else "     -- "
            py_ms_s = f"{py_ms_mean:>8.1f}" if py_ms_mean is not None else "     -- "
            ratio_s = f"{ratio:>6.1f}" if ratio is not None else "    --"
            print(f"{alg:<15} | {counts['ok_both']:>4} | {counts['fail_js']:>4} | {counts['fail_py']:>4} | {counts['py_timeout']:>6} |      --  |      --  |      --  | {js_ms_s} | {py_ms_s} | {ratio_s}")

    # Per-metric breakdown
    print("\nPer-metric breakdown (JS mean -> Python mean):")
    mkey_header = "layout".ljust(15) + " | " + " | ".join(f"{k[:6]:>6}" for k in METRIC_KEYS)
    print(mkey_header)
    print("-" * len(mkey_header))
    for alg in algorithms:
        cells = [alg.ljust(15)]
        for mk in METRIC_KEYS:
            pairs = per_alg_metric[alg][mk]
            if pairs:
                j = sum(p[0] for p in pairs) / len(pairs)
                p = sum(p[1] for p in pairs) / len(pairs)
                cells.append(f"{p - j:>+6.3f}")
            else:
                cells.append("  --  ")
        print(cells[0] + " | " + " | ".join(cells[1:]))

    if args.out:
        with open(args.out, "w") as fh:
            fh.write("algorithm,graph,metric,js,py\n")
            for (alg, g, mk, j, p) in rows:
                js_str = f"{j:.6f}" if j is not None else ""
                py_str = f"{p:.6f}" if p is not None else ""
                fh.write(f"{alg},{g},{mk},{js_str},{py_str}\n")
        print(f"\nWrote raw CSV: {args.out}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
