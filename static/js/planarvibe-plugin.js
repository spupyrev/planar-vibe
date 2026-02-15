(function (global) {
  'use strict';

  function parseEdgeList(input) {
    var lines = String(input || '').split(/\r?\n/);
    var nodes = new Set();
    var edges = [];
    var edgeKeys = new Set();

    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i].trim();
      if (!line || line.charAt(0) === '#') {
        continue;
      }

      var parts = line.split(/\s+/);
      if (parts.length < 2) {
        throw new Error('Invalid line ' + (i + 1) + ': expected "source target".');
      }

      var source = parts[0];
      var target = parts[1];

      if (!source || !target) {
        throw new Error('Invalid line ' + (i + 1) + ': missing source or target.');
      }

      nodes.add(source);
      nodes.add(target);

      var key = source < target ? source + '::' + target : target + '::' + source;
      if (edgeKeys.has(key)) {
        continue;
      }
      edgeKeys.add(key);

      edges.push({
        data: {
          id: 'e' + edges.length,
          source: source,
          target: target
        }
      });
    }

    var nodeElements = [];
    nodes.forEach(function (id) {
      nodeElements.push({
        data: {
          id: id,
          label: id
        }
      });
    });

    return {
      elements: nodeElements.concat(edges),
      nodeCount: nodeElements.length,
      edgeCount: edges.length
    };
  }

  function layoutOptions(parsedGraph) {
    if (!parsedGraph || parsedGraph.nodeCount === 0) {
      return { name: 'grid' };
    }

    return {
      name: 'cose',
      animate: true,
      randomize: false,
      idealEdgeLength: 80,
      nodeRepulsion: 5000,
      fit: true,
      padding: 24
    };
  }

  function hashString(value, seed) {
    var hash = seed >>> 0;
    for (var i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function normalizedHash(value, seed) {
    return hashString(String(value), seed) / 4294967295;
  }

  function applyDeterministicRandomPositions(cy) {
    var width = Math.max(cy.width(), 320);
    var height = Math.max(cy.height(), 260);
    var margin = 26;
    var xSpan = Math.max(width - margin * 2, 1);
    var ySpan = Math.max(height - margin * 2, 1);

    cy.nodes().forEach(function (node) {
      var id = node.id();
      var x = margin + normalizedHash(id + ':x', 2166136261) * xSpan;
      var y = margin + normalizedHash(id + ':y', 33554467) * ySpan;
      node.position({ x: x, y: y });
    });
    cy.fit(undefined, 20);
  }

  function layoutOptionsByName(name, parsedGraph) {
    if (name === 'circle') {
      return { name: 'circle', fit: true, padding: 24, animate: true };
    }
    if (name === 'grid') {
      return { name: 'grid', fit: true, padding: 24, animate: true };
    }
    return layoutOptions(parsedGraph);
  }

  global.PlanarVibePlugin = {
    parseEdgeList: parseEdgeList,
    layoutOptions: layoutOptions,
    layoutOptionsByName: layoutOptionsByName,
    applyDeterministicRandomPositions: applyDeterministicRandomPositions
  };
})(window);
