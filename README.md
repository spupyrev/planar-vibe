# PlanarVibe

PlanarVibe is a standalone implementation of graph drawing algorithms, focused on planar graph layouts and drawing-quality metrics.

It is available in JavaScript, either through a static browser page or Node.js command-line scripts, and in Python for command-line layout runs and scripting.

## Features

- Broad collection of theoretical, force-directed, and optimization-based graph drawing algorithms
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

Run a JS layout from the command line:

```bash
./scripts/apply_layout benchmark/named.dot sample1 --algorithm tutte --timeout 30
```

Run multiple JS layouts with a glob:

```bash
./scripts/apply_layout benchmark/sample_graphs_coords.dot sample1 --algorithms input,tutte,*balancer*
```

## Python Usage

Install the Python package in editable mode:

```bash
python3 -m pip install -e src-python
```

Run a Python layout and print JSON:

```bash
python3 src-python/scripts/apply_layout.py benchmark/named.dot sample1 tutte
```

Write the Python result to a file:

```bash
python3 src-python/scripts/apply_layout.py benchmark/named.dot sample1 tutte --out /tmp/sample1-tutte.json
```

Requires Node.js 18+ and Python 3.10+.

## License

MIT (see `LICENSE`)
