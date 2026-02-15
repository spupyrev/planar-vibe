(function (global) {
  'use strict';

  function createSeededRng(seed) {
    var state = (Math.floor(Number(seed) || 1) >>> 0) || 1;
    return function next() {
      state = (Math.imul(1664525, state) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  function cycleGraph(n) {
    var lines = [];
    for (var i = 1; i <= n; i += 1) {
      var j = i === n ? 1 : i + 1;
      lines.push(i + ' ' + j);
    }
    return lines.join('\n') + '\n';
  }

  function ladderGraph(n) {
    var lines = [];
    for (var i = 1; i < n; i += 1) {
      lines.push(i + ' ' + (i + 1));
      lines.push((n + i) + ' ' + (n + i + 1));
    }
    for (var j = 1; j <= n; j += 1) {
      lines.push(j + ' ' + (n + j));
    }
    return lines.join('\n') + '\n';
  }

  function gridGraph(rows, cols) {
    var lines = [];
    function id(r, c) {
      return (r - 1) * cols + c;
    }

    for (var r = 1; r <= rows; r += 1) {
      for (var c = 1; c <= cols; c += 1) {
        if (c < cols) {
          lines.push(id(r, c) + ' ' + id(r, c + 1));
        }
        if (r < rows) {
          lines.push(id(r, c) + ' ' + id(r + 1, c));
        }
      }
    }
    return lines.join('\n') + '\n';
  }

  function wheelGraph(n) {
    var lines = [];
    var cycleSize = n - 1;
    var center = n;

    for (var i = 1; i <= cycleSize; i += 1) {
      var j = i === cycleSize ? 1 : i + 1;
      lines.push(i + ' ' + j);
    }
    for (var k = 1; k <= cycleSize; k += 1) {
      lines.push(k + ' ' + center);
    }
    return lines.join('\n') + '\n';
  }

  function maximalPlanar3Tree(n) {
    var nodeCount = Math.max(3, Math.floor(Number(n) || 3));
    var edges = [];
    var edgeSet = new Set();
    var faces = [];

    function addEdge(u, v) {
      var a = Math.min(u, v);
      var b = Math.max(u, v);
      var key = a + ' ' + b;
      if (edgeSet.has(key)) {
        return;
      }
      edgeSet.add(key);
      edges.push(a + ' ' + b);
    }

    // Base K3
    addEdge(1, 2);
    addEdge(2, 3);
    addEdge(1, 3);
    faces.push([1, 2, 3]);

    for (var v = 4; v <= nodeCount; v += 1) {
      // Deterministic face choice: cycle through current faces.
      var pick = (v * 2654435761 >>> 0) % faces.length;
      var face = faces[pick];
      var a = face[0];
      var b = face[1];
      var c = face[2];

      addEdge(v, a);
      addEdge(v, b);
      addEdge(v, c);

      // Replace chosen face by 3 new triangular faces.
      faces.splice(pick, 1);
      faces.push([v, a, b]);
      faces.push([v, b, c]);
      faces.push([v, c, a]);
    }

    // Canonical order for stable output.
    edges.sort(function (lhs, rhs) {
      var la = lhs.split(' ').map(Number);
      var ra = rhs.split(' ').map(Number);
      if (la[0] !== ra[0]) {
        return la[0] - ra[0];
      }
      return la[1] - ra[1];
    });

    return edges.join('\n') + '\n';
  }

  function nonPlanarK33() {
    var left = [1, 2, 3];
    var right = [4, 5, 6];
    var lines = [];

    for (var i = 0; i < left.length; i += 1) {
      for (var j = 0; j < right.length; j += 1) {
        lines.push(left[i] + ' ' + right[j]);
      }
    }
    return lines.join('\n') + '\n';
  }

  function nonPlanarK33PlusPath(n, seed) {
    var nodeCount = Math.max(6, Math.floor(Number(n) || 6));
    var lines = nonPlanarK33().trim().split('\n');
    var nextRand = createSeededRng(seed);

    if (nodeCount >= 7) {
      for (var v = 7; v <= nodeCount; v += 1) {
        var parent = 1 + Math.floor(nextRand() * (v - 1));
        lines.push(parent + ' ' + v);
      }
    }

    return lines.join('\n') + '\n';
  }

  function planarStellationGraph(n, cycleSize, seed) {
    var nodeCount = Math.max(3, Math.floor(Number(n) || 3));
    var baseCycle = Math.max(3, Math.floor(Number(cycleSize) || 6));
    var nextRand = createSeededRng(seed);
    if (baseCycle > nodeCount) {
      baseCycle = nodeCount;
    }

    var edges = [];
    var edgeSet = new Set();
    var faces = [];

    function addEdge(u, v) {
      var a = Math.min(u, v);
      var b = Math.max(u, v);
      var key = a + ' ' + b;
      if (edgeSet.has(key)) {
        return;
      }
      edgeSet.add(key);
      edges.push(key);
    }

    // Start from a simple cycle.
    var outer = [];
    for (var i = 1; i <= baseCycle; i += 1) {
      outer.push(i);
    }
    for (i = 1; i <= baseCycle; i += 1) {
      var j = i === baseCycle ? 1 : i + 1;
      addEdge(i, j);
    }

    // Keep one interior face for stellation.
    faces.push(outer.slice());

    for (var v = baseCycle + 1; v <= nodeCount; v += 1) {
      var pick = Math.floor(nextRand() * faces.length);
      var face = faces[pick];

      // Stellation: connect new vertex to all boundary vertices of chosen face.
      for (i = 0; i < face.length; i += 1) {
        addEdge(v, face[i]);
      }

      // Replace chosen face by fan faces; non-picked faces may still be larger.
      faces.splice(pick, 1);
      for (i = 0; i < face.length; i += 1) {
        var a = face[i];
        var b = face[(i + 1) % face.length];
        faces.push([v, a, b]);
      }
    }

    edges.sort(function (lhs, rhs) {
      var la = lhs.split(' ').map(Number);
      var ra = rhs.split(' ').map(Number);
      if (la[0] !== ra[0]) {
        return la[0] - ra[0];
      }
      return la[1] - ra[1];
    });

    return edges.join('\n') + '\n';
  }

  var graphSamples = {
    sample1: '0 2\n0 4\n0 6\n0 8\n0 10\n0 12\n0 14\n0 16\n0 18\n0 20\n0 22\n0 24\n0 26\n0 28\n0 30\n0 49\n0 32\n1 48\n1 31\n1 29\n1 27\n1 25\n1 23\n1 21\n1 19\n1 17\n1 15\n1 13\n1 11\n1 9\n1 7\n1 3\n2 33\n2 3\n2 47\n2 38\n3 34\n3 37\n4 38\n4 41\n4 35\n4 46\n4 5\n5 36\n5 6\n5 45\n6 7\n7 36\n7 37\n7 8\n8 9\n9 10\n10 11\n11 12\n12 13\n13 14\n14 15\n15 16\n16 17\n17 18\n18 19\n19 20\n20 21\n21 22\n22 23\n23 24\n24 25\n25 26\n26 27\n27 28\n28 29\n29 30\n30 31\n31 49\n32 48\n32 33\n33 34\n34 48\n35 37\n35 36\n35 43\n35 40\n36 44\n37 39\n37 47\n38 42\n39 40\n39 42\n40 41\n41 42\n42 47\n43 44\n43 46\n44 45\n45 46\n48 49\n',
    sample2: '0 15\n0 6\n0 2\n0 3\n1 3\n1 4\n1 7\n1 15\n15 7\n15 4\n15 2\n15 6\n6 2\n2 4\n2 3\n3 4\n4 7\n3 5\n1 5\n0 5\n0 16\n0 21\n0 17\n0 18\n1 18\n1 19\n1 22\n1 16\n16 22\n16 19\n16 17\n16 21\n21 17\n17 19\n17 18\n18 19\n19 22\n18 20\n1 20\n0 20\n23 29\n23 26\n23 24\n23 28\n28 24\n24 26\n24 25\n25 26\n26 29\n25 27\n27 0\n25 0\n24 0\n28 0\n27 1\n25 1\n26 1\n29 1\n23 1\n23 0\n8 14\n8 11\n8 9\n8 13\n13 9\n9 11\n9 10\n10 11\n11 14\n10 12\n1 12\n10 1\n11 1\n12 0\n10 0\n9 0\n13 0\n14 1\n8 1\n8 0\n12 15\n16 27\n',
    sample3: nonPlanarK33(),
    cycle20: cycleGraph(20),
    ladder20: ladderGraph(20),
    grid9x9: gridGraph(9, 9),
    wheel7: wheelGraph(7),
    planar3tree30: maximalPlanar3Tree(30),
    nonplanar30: nonPlanarK33PlusPath(30),
    planarstellation30: planarStellationGraph(30, 8)
  };

  function getSample(name) {
    return graphSamples[name] || null;
  }

  global.PlanarVibeGraphGenerator = {
    cycleGraph: cycleGraph,
    ladderGraph: ladderGraph,
    gridGraph: gridGraph,
    wheelGraph: wheelGraph,
    maximalPlanar3Tree: maximalPlanar3Tree,
    nonPlanarK33: nonPlanarK33,
    nonPlanarK33PlusPath: nonPlanarK33PlusPath,
    createSeededRng: createSeededRng,
    planarStellationGraph: planarStellationGraph,
    getSample: getSample,
    defaultSample: 'sample1'
  };
})(window);
