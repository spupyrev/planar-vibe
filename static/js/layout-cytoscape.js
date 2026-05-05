(function (global) {
  'use strict';

  var GraphUtils = global.GraphUtils;
  var GeometryUtils = global.GeometryUtils;
  var CyRuntime = global.CyRuntime;
  var buildLayoutError = GraphUtils.buildLayoutError;
  var buildLayoutResult = GraphUtils.buildLayoutResult;
  var emitSingleIteration = global.LayoutPreprocessing.emitSingleIteration;
  var normalizePositionMapToViewport = GeometryUtils.normalizePositionMapToViewport;

  function graphToElements(graph) {
    var ids = Array.isArray(graph && graph.nodeIds) ? graph.nodeIds : [];
    var pairs = Array.isArray(graph && graph.edgePairs) ? graph.edgePairs : [];
    return ids.map(function (id) {
      return {
        data: {
          id: String(id),
          label: String(id)
        }
      };
    }).concat(pairs.map(function (edge, i) {
      return {
        data: {
          id: '__native__e' + i,
          source: String(edge[0]),
          target: String(edge[1])
        }
      };
    }));
  }

  function applyInitialPositions(cy, currentPositions) {
    if (!currentPositions) {
      return;
    }
    cy.nodes().forEach(function (node) {
      var p = currentPositions[String(node.id())];
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        node.position({ x: p.x, y: p.y });
      }
    });
  }

  function collectPositions(cy) {
    var positions = {};
    cy.nodes().forEach(function (node) {
      var p = node.position();
      positions[String(node.id())] = { x: p.x, y: p.y };
    });
    return positions;
  }

  function nativeLayoutOptions(name) {
    if (name === 'circle' || name === 'grid') {
      return { name: name, fit: false, animate: false, padding: 24 };
    }
    return {
      name: 'cose',
      animate: false,
      randomize: false,
      idealEdgeLength: 80,
      nodeRepulsion: 5000,
      fit: false,
      padding: 24
    };
  }

  function runNativeLayout(graph, layoutName, currentPositions) {
    return new Promise(function (resolve) {
      var tempCy = null;
      function finishWith(result) {
        if (tempCy) {
          tempCy.destroy();
          tempCy = null;
        }
        resolve(result);
      }
      try {
        tempCy = global.cytoscape({
          headless: true,
          styleEnabled: false,
          elements: graphToElements(graph)
        });
        applyInitialPositions(tempCy, currentPositions);
        var layout = tempCy.layout(nativeLayoutOptions(layoutName));

        function buildSuccessResult() {
          var positions = normalizePositionMapToViewport(collectPositions(tempCy));
          finishWith(buildLayoutResult({
            nodeIds: graph.nodeIds.slice(),
            edgePairs: graph.edgePairs.slice(),
            graph: graph,
            positions: positions
          }));
        }

        if (layout && typeof layout.one === 'function') {
          layout.one('layoutstop', buildSuccessResult);
        } else {
          global.setTimeout(buildSuccessResult, 0);
        }

        if (layout && typeof layout.run === 'function') {
          layout.run();
          return;
        }

        finishWith(buildLayoutError({
          message: 'Cytoscape layout "' + layoutName + '" is unavailable',
          graph: graph
        }));
      } catch (err) {
        finishWith(buildLayoutError({
          message: (err && err.message) ? err.message : ('Cytoscape layout "' + layoutName + '" failed'),
          graph: graph
        }));
      }
    });
  }

  function applyNativeLayout(cy, options, layoutName, label) {
    return CyRuntime.runLayout(cy, options, {
      initialFitBounds: function (ctx) {
        var defaults = global.PlanarVibeViewportDefaults || {};
        var width = Number.isFinite(defaults.width) ? defaults.width : 900;
        var height = Number.isFinite(defaults.height) ? defaults.height : 620;
        return { x1: 0, y1: 0, x2: width, y2: height };
      },
      computePositions: async function (_prepared, computeOptions) {
        var graph = computeOptions.graph;
        var result = await runNativeLayout(graph, layoutName, computeOptions.currentPositions);
        await emitSingleIteration(computeOptions, result);
        return result;
      },
      buildResult: function () {
        return {
          ok: true,
          message: 'Applied ' + label + ' layout'
        };
      },
      failureMessage: label + ' failed'
    });
  }

  global.PlanarVibeCytoscape = {
    applyCircleLayout: function (cy, options) {
      return applyNativeLayout(cy, options, 'circle', 'circle');
    },
    applyGridLayout: function (cy, options) {
      return applyNativeLayout(cy, options, 'grid', 'grid');
    },
    applyCoseLayout: function (cy, options) {
      return applyNativeLayout(cy, options, 'cose', 'cose');
    }
  };
})(window);
