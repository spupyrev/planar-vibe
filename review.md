# PlanarVibe Deep Code Review
 
## Scope
 
This review focuses on the algorithm implementation layer (`static/js/`), evaluating simplicity, readability, portability, de-duplication, dead code, and consistency. The goal is to prepare the codebase for porting to other languages and UI frameworks.
 
---
 
## 1. Architecture: UI/Algorithm Separation
 
### Current State
 
The codebase is structured as browser-global IIFEs (`(function(global) { ... })(window)`). Every module reads from and writes to `window.*`, creating an implicit dependency graph. The algorithm layer is *mostly* separable from the UI, but there are entanglements:
 
**Good separation:**
- Each layout algorithm exposes a pure `computeXxxPositions(nodeIds, edgePairs, options)` function that takes plain data and returns plain data. These are highly portable.
- `graph-utils.js`, `planarity-test.js`, and `metrics.js` are pure algorithmic code with no DOM or Cytoscape references.
 
**Problem areas:**
 
1. **`planarvibe-plugin.js` is a monolith.** At ~2625 lines, it mixes graph parsing, Cytoscape management, SVG rendering, cookie/localStorage persistence, status bar updates, metric plot generation, UI event binding, layout dispatch, and style management into a single file. This is the main blocker for portability.
 
2. **`playground-utils.js` straddles the boundary.** It contains both pure graph logic (`prepareTriangulatedLayoutData`, `prepareAugmentedTriangulation`, `originalFaceKeyForAugmentedFace`) and Cytoscape-specific code (`graphFromCy`, `applyPositionsToCy`, `applyAndFit`, `createIncrementalRenderer`). These should be in separate modules.
 
3. **Layout `applyXxxLayout` functions depend on Cytoscape.** Each layout file exports both a pure `compute` function and a Cy-coupled `apply` function. The `apply` functions are thin wrappers but couple algorithms to Cytoscape. For portability, these should live in the UI layer, not alongside the algorithms.
 
### Recommendation
 
Split into three layers:
- **Core** (portable, no browser/framework deps): `graph-utils`, `planarity-test`, `metrics`, all `computeXxxPositions` functions, `prepareTriangulatedLayoutData`.
- **Framework adapter** (Cytoscape-specific): `graphFromCy`, `applyPositionsToCy`, `createIncrementalRenderer`, all `applyXxxLayout` functions.
- **UI** (DOM/browser-specific): everything currently in `planarvibe-plugin.js`.
 
---
