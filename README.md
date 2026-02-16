# PlanarVibe

PlanarVibe is a browser app for experimenting with planar graph drawings.

Live app: https://spupyrev.github.io/planar-vibe/

## Features

- Paste an edge list or load built-in samples
- Run layouts:
  - `Random`
  - `Circular`
  - `Force-Dir`
  - `Tutte`
  - `P3T`
  - `FPP`
- Graph stats:
  - vertices, edges
  - planar, bipartite, planar 3-tree
- Drawing stats:
  - plane (`yes/no`, based on crossings in the current drawing)
  - face-area distribution plot
  - face-area quality score
- Interactive/static mode switch (static mode is lower CPU)
- SVG export

## Input format

Edge list, one undirected edge per line:

```text
u v
```

- Blank lines are ignored
- Lines starting with `#` are ignored
- Duplicate edges are ignored

## Local run

This is a static frontend app. Open `index.html` in a browser, or serve the folder with any static server.

## Tests

```bash
npm test
```

Requires Node.js 18+.

## License

MIT (see `LICENSE`)
