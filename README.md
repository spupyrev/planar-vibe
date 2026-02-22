# PlanarVibe

PlanarVibe is a browser app for experimenting with planar graph drawings.

Live app: https://spupyrev.github.io/planar-vibe/

## Features

- Paste an edge list or load built-in samples
- Samples `sample1..sample5` include embedded vertex coordinates
- Run layouts:
  - `Random`
  - `Circular`
  - `Force-Dir`
  - `Tutte`
  - `ImPrEd`
  - `CEG23-bfs`
  - `CEG23-xy`
  - `Reweight`
  - `P3T`
  - `FPP`
- Graph stats:
  - vertices, edges
  - planar, bipartite, planar 3-tree
- Drawing stats:
  - plane (`yes/no`, based on crossings in the current drawing)
  - `Angle Resolution Score`
  - `Face Areas Score`
  - `Edge Length Score`
  - `Edge-Length Ratio`
  - `Spacing-Uniformity`
  - clickable metric rows to show/hide each distribution plot
- Interactive/static mode switch (static mode is lower CPU)
- Vertex size and edge width sliders (persisted)
- SVG export

## Input format

You can provide:

1. Vertex coordinates:

```text
v id x y
```

2. Undirected edges:

```text
u v
```

- Blank lines are ignored
- Lines starting with `#` are ignored
- Duplicate edges are ignored
- If coordinates are provided, they are used as the initial drawing

## Local run

This is a static frontend app. Open `index.html` in a browser, or serve the folder with any static server.

## Tests

```bash
npm test
```

Requires Node.js 18+.

## License

MIT (see `LICENSE`)
