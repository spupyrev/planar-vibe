# PlanarVibe

<p align="center">
  <img src="static/img/logo2.png" alt="PlanarVibe logo" width="360">
</p>

PlanarVibe is a self-contained toolkit for drawing planar graphs and evaluating drawing quality
with an [interactive playground](https://spupyrev.github.io/planar-vibe/).

It is available in **JavaScript** (either through a static browser page or Node.js command-line scripts), **Python**, and **C++** for command-line scripting.

## Features

- Broad collection of theoretical, force-directed, and optimization-based planar graph drawing algorithms
- Drawing-quality metrics for planarity, angular resolution, aspect ratio, convexity, edge lengths, face areas, node distribution, alignment, and spacing
- A collection of planar graph instances for benchmarking
- Command-line layout runners for batch experiments and scripting
- Interactive browser view with drawing inspection and SVG export

## Input Format

Use one undirected edge per line:

```text
u v
```

Optional vertex coordinates can be provided with:

```text
v id x y
```

Blank lines and lines starting with `#` are ignored. Duplicate edges are ignored. If coordinates are provided, they are used as the initial drawing.

## JavaScript Usage

Run the app by opening `index.html`, or serve the repository:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

Run one or more layouts. The public CLI defaults to the C++ implementation:

```bash
./scripts/apply-layout benchmark/sample_graphs_coords.dot sample1 --algorithms input,tutte,*balancer*
```

Choose a different implementation with `--implementation`:

```bash
./scripts/apply-layout --implementation js benchmark/sample_graphs_coords.dot sample1 --algorithms input,tutte,*balancer*
./scripts/apply-layout --implementation py benchmark/sample_graphs_coords.dot sample1 --algorithms input,tutte,*balancer* --out /tmp/sample1-layouts.json
```

Requires Node.js 18+ for the wrapper and JS implementation, Python 3.10+ for
the Python implementation, and a built C++ binary for the default path.

## C++ Usage

Build the C++ binary:

```bash
make -C src-cpp
```

The public `apply-layout` wrapper uses this binary by default:

```bash
./scripts/apply-layout benchmark/sample_graphs_coords.dot sample1 --algorithms input,tutte,*balancer* --out /tmp/sample1-layouts.json
```

## License

MIT (see `LICENSE`)
