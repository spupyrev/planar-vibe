(function (global) {
  'use strict';

  function buildAdjacency(cy) {
    var adj = {};
    cy.nodes().forEach(function (node) {
      adj[node.id()] = [];
    });
    cy.edges().forEach(function (edge) {
      var s = edge.source().id();
      var t = edge.target().id();
      if (adj[s]) {
        adj[s].push(t);
      }
      if (adj[t]) {
        adj[t].push(s);
      }
    });
    return adj;
  }

  function detectCycle(cy, adj) {
    var visited = {};
    var inPath = {};
    var parent = {};
    var nodes = cy.nodes().toArray();

    function buildCycle(fromId, toId) {
      var cycle = [toId];
      var cur = fromId;
      while (cur !== undefined && cur !== toId) {
        cycle.push(cur);
        cur = parent[cur];
      }
      if (cur !== toId || cycle.length < 3) {
        return null;
      }
      return cycle;
    }

    function dfs(u, p) {
      visited[u] = true;
      inPath[u] = true;
      var ngh = adj[u] || [];

      for (var i = 0; i < ngh.length; i += 1) {
        var v = ngh[i];
        if (v === p) {
          continue;
        }
        if (!visited[v]) {
          parent[v] = u;
          var found = dfs(v, u);
          if (found) {
            return found;
          }
        } else if (inPath[v]) {
          var cyc = buildCycle(u, v);
          if (cyc) {
            return cyc;
          }
        }
      }

      inPath[u] = false;
      return null;
    }

    for (var i = 0; i < nodes.length; i += 1) {
      var id = nodes[i].id();
      if (!visited[id]) {
        parent[id] = undefined;
        var cycle = dfs(id, undefined);
        if (cycle) {
          return cycle;
        }
      }
    }
    return null;
  }

  function chooseOuterFace(cy, adj) {
    var cycle = detectCycle(cy, adj);
    if (cycle && cycle.length >= 3) {
      return cycle;
    }

    var nodes = cy.nodes().toArray();
    if (nodes.length >= 3) {
      return [nodes[0].id(), nodes[1].id(), nodes[2].id()];
    }
    return null;
  }

  function applyTutteLayout(cy) {
    var nodes = cy.nodes().toArray();
    if (nodes.length < 3) {
      return {
        ok: false,
        message: 'Tutte requires at least 3 vertices.'
      };
    }

    var adj = buildAdjacency(cy);
    var outerFace = chooseOuterFace(cy, adj);
    if (!outerFace || outerFace.length < 3) {
      return {
        ok: false,
        message: 'Could not find/build outer face for Tutte.'
      };
    }

    var coord = {};
    for (var i = 0; i < nodes.length; i += 1) {
      coord[nodes[i].id()] = { x: 0, y: 0 };
    }

    var R = 1000;
    var gamma = 2.0 * Math.PI / outerFace.length;
    for (var j = 0; j < outerFace.length; j += 1) {
      var v = outerFace[outerFace.length - j - 1];
      var x = R * Math.cos(gamma * (0.25 + j)) + 2.0 * R;
      var y = R * Math.sin(gamma * (0.25 + j)) + 2.0 * R;
      coord[v] = { x: x, y: y };
    }

    var outerSet = {};
    for (var k = 0; k < outerFace.length; k += 1) {
      outerSet[outerFace[k]] = true;
    }

    var iters = 0;
    var converged = false;
    while (!converged && iters < 1000) {
      converged = true;
      iters += 1;

      for (var n = 0; n < nodes.length; n += 1) {
        var id = nodes[n].id();
        if (outerSet[id]) {
          continue;
        }

        var ngh = adj[id] || [];
        if (ngh.length === 0) {
          continue;
        }

        var sx = 0;
        var sy = 0;
        for (var p = 0; p < ngh.length; p += 1) {
          var u = ngh[p];
          sx += coord[u].x;
          sy += coord[u].y;
        }
        var nx = sx / ngh.length;
        var ny = sy / ngh.length;

        if (Math.abs(coord[id].x - nx) > 1e-6 || Math.abs(coord[id].y - ny) > 1e-6) {
          coord[id] = { x: nx, y: ny };
          converged = false;
        }
      }
    }

    for (var q = 0; q < nodes.length; q += 1) {
      var nodeId = nodes[q].id();
      nodes[q].position(coord[nodeId]);
    }
    cy.fit(undefined, 24);

    return {
      ok: true,
      message: 'Applied Tutte (' + outerFace.length + '-vertex outer face, ' + iters + ' iters)'
    };
  }

  global.PlanarVibeTutte = {
    applyTutteLayout: applyTutteLayout
  };
})(window);
