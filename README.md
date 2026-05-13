# PlanarVibe

<p align="center">
  <img src="static/img/logo2.png" alt="PlanarVibe logo" width="360">
</p>

PlanarVibe is a self-contained toolkit for drawing planar graphs and evaluating drawing quality
with an [interactive playground](https://spupyrev.github.io/planar-vibe/).
Visit [gallery1](https://spupyrev.github.io/planar-vibe/gallery.html) and [gallery2](https://spupyrev.github.io/planar-vibe/layout-table-gd-collection.html) for a selection of generated drawings.

The implementation is available in **JavaScript** (either through a static browser page or Node.js command-line scripts), **Python**, and **C++** for command-line scripting.

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

Run one or more layouts using the JS implementation:

```bash
./scripts/apply-layout --implementation js benchmark/sample_graphs_coords.dot sample1 --algorithms input,tutte,*balancer*
```

Requires Node.js 18+.

## Python Usage

Run a layout using the Python implementation:

```bash
./scripts/apply-layout --implementation py benchmark/sample_graphs_coords.dot sample1 --algorithms air,reweight,fpp --out /tmp/sample1-layouts.json
```

Requires Python 3.10+.

## C++ Usage

Build the C++ binary:

```bash
make -C src-cpp
```

Run a layout using the C++ implementation:

```bash
./scripts/apply-layout --implementation cpp benchmark/sample_graphs_coords.dot sample1 --algorithms impred,hybrid --out /tmp/sample1-layouts.json
```

## License

MIT (see `LICENSE`)
