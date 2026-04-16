(function (global) {
  'use strict';

  var GraphUtils = global.GraphUtils;
  var GeometryUtils = global.GeometryUtils;
  var CyRuntime = global.CyRuntime;
  var buildLayoutError = GraphUtils.buildLayoutError;
  var buildLayoutResult = GraphUtils.buildLayoutResult;
  var normalizePositionMapToViewport = GeometryUtils.normalizePositionMapToViewport;

  function graphToElements(graph) {
    var elements = [];
    var ids = Array.isArray(graph && graph.nodeIds) ? graph.nodeIds : [];
    var pairs = Array.isArray(graph && graph.edgePairs) ? graph.edgePairs : [];
    var i;
    for (i = 0; i < ids.length; i += 1) {
      elements.push({
        data: {
          id: String(ids[i]),
          label: String(ids[i])
        }
      });
    }
    for (i = 0; i < pairs.length; i += 1) {
      elements.push({
        data: {
          id: '__native__e' + i,
          source: String(pairs[i][0]),
          target: String(pairs[i][1])
        }
      });
    }
    return elements;
  }

  function applyInitialPositions(cy, currentPositions) {
    if (!cy || !currentPositions) {
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
    if (!cy) {
      return positions;
    }
    cy.nodes().forEach(function (node) {
      var p = node.position();
      positions[String(node.id())] = { x: p.x, y: p.y };
    });
    return positions;
  }

  function nativeLayoutOptions(name) {
    if (name === 'circle') {
      return { name: 'circle', fit: false, animate: false, padding: 24 };
    }
    if (name === 'grid') {
      return { name: 'grid', fit: false, animate: false, padding: 24 };
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
            ok: true,
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
        if (tempCy) {
          tempCy.destroy();
        }
        finishWith(buildLayoutError({
          message: (err && err.message) ? err.message : ('Cytoscape layout "' + layoutName + '" failed'),
          graph: graph
        }));
      }
    });
  }

  async function emitSingleIteration(options, result) {
    if (!result || !result.ok || !result.positions || typeof options.onIteration !== 'function') {
      return;
    }
    await options.onIteration({
      iter: 1,
      maxIters: 1,
      positions: result.positions
    });
  }

  function applyNativeLayout(cy, options, layoutName, label) {
    return CyRuntime.runLayout(cy, options, {
      compute: async function (graph, computeOptions) {
        var result = await runNativeLayout(graph, layoutName, computeOptions && computeOptions.currentPositions);
        await emitSingleIteration(computeOptions || {}, result);
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

  function applyCircleLayout(cy, options) {
    return applyNativeLayout(cy, options, 'circle', 'circle');
  }

  function applyGridLayout(cy, options) {
    return applyNativeLayout(cy, options, 'grid', 'grid');
  }

  function applyCoseLayout(cy, options) {
    return applyNativeLayout(cy, options, 'cose', 'cose');
  }

  global.PlanarVibeCytoscape = {
    applyCircleLayout: applyCircleLayout,
    applyGridLayout: applyGridLayout,
    applyCoseLayout: applyCoseLayout
  };
})(window);
