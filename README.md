# PlanarVibe

PlanarVibe is a lightweight browser playground for drawing and experimenting with planar graph layouts.
It runs as a static web app (HTML/CSS/JS only) and uses Cytoscape.js for rendering.

See it in action: https://spupyrev.github.io/planar-vibe/

## Supported Layout Algorithms

- `Random`: deterministic coordinates based on node IDs
- `Circular`: Cytoscape circle layout
- `Force-Dir`: Cytoscape COSE layout
- `Tutte`: fixes an outer cycle (or fallback triangle), then relaxes interior vertices by neighbor averaging

## Usage

1. Open the app.
2. Paste an edge list (or click a sample link).
3. Click `Create Graph`.
4. Switch layouts using:
   - `Random`
   - `Circular`
   - `Force-Dir`
   - `Tutte`
5. Use the top-right reset icon to refit the view.

On startup, the app auto-loads the default sample (`sample1`) and draws it.

## License

MIT (see `LICENSE`).
