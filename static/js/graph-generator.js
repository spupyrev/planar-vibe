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

  function xTreeGraph(n) {
    var nodeCount = Math.max(1, Math.floor(Number(n) || 1));
    var lines = [];

    // Binary tree edges (heap indexing).
    for (var v = 2; v <= nodeCount; v += 1) {
      var parent = Math.floor(v / 2);
      lines.push(parent + ' ' + v);
    }

    // Connect consecutive vertices on each level.
    for (var level = 0; (1 << level) <= nodeCount; level += 1) {
      var start = 1 << level;
      var end = Math.min((1 << (level + 1)) - 1, nodeCount);
      for (var u = start; u < end; u += 1) {
        lines.push(u + ' ' + (u + 1));
      }
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

  function nonPlanarK6() {
    var lines = [];
    for (var i = 1; i <= 6; i += 1) {
      for (var j = i + 1; j <= 6; j += 1) {
        lines.push(i + ' ' + j);
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

  function randomPlanarGraphNM(n, m, seed) {
    var nodeCount = Math.max(3, Math.floor(Number(n) || 3));
    var maxEdges = 3 * nodeCount - 6;
    var targetEdges = Math.max(0, Math.min(maxEdges, Math.floor(Number(m) || 0)));
    var nextRand = createSeededRng(seed);

    var baseLines = maximalPlanar3Tree(nodeCount).trim().split('\n');
    var edges = [];
    for (var i = 0; i < baseLines.length; i += 1) {
      var parts = baseLines[i].trim().split(/\s+/);
      if (parts.length < 2) {
        continue;
      }
      edges.push([parts[0], parts[1]]);
    }

    while (edges.length > targetEdges) {
      var pick = Math.floor(nextRand() * edges.length);
      edges.splice(pick, 1);
    }

    var out = [];
    for (i = 0; i < edges.length; i += 1) {
      out.push(edges[i][0] + ' ' + edges[i][1]);
    }
    return out.join('\n') + '\n';
  }

  var SAMPLE1_WITH_COORDS = "v 0 -450 0\nv 1 150 -300\nv 2 0 450\nv 3 450 0\nv 4 -150 240\nv 5 -45 166\nv 6 -30 120\nv 7 210 0\nv 8 0 90\nv 9 150 -16\nv 10 0 60\nv 11 120 -30\nv 12 -30 30\nv 13 90 -60\nv 14 -60 -14\nv 15 60 -90\nv 16 -90 -46\nv 17 30 -120\nv 18 -90 -76\nv 19 14 -150\nv 20 -90 -106\nv 21 0 -180\nv 22 -120 -120\nv 23 0 -210\nv 24 -120 -166\nv 25 0 -240\nv 26 -136 -194\nv 27 0 -270\nv 28 -150 -223\nv 29 0 -300\nv 30 -134 -270\nv 31 0 -330\nv 32 -498 0\nv 33 0 498\nv 34 498 0\nv 35 76 240\nv 36 120 90\nv 37 330 0\nv 38 -35 392\nv 39 85 272\nv 40 2 286\nv 41 -60 300\nv 42 -5 332\nv 43 46 196\nv 44 60 150\nv 45 0 180\nv 46 -15 226\nv 47 55 362\nv 48 0 -498\nv 49 -90 -360\n0 2\n0 4\n0 6\n0 8\n0 10\n0 12\n0 14\n0 16\n0 18\n0 20\n0 22\n0 24\n0 26\n0 28\n0 30\n0 49\n0 32\n1 48\n1 31\n1 29\n1 27\n1 25\n1 23\n1 21\n1 19\n1 17\n1 15\n1 13\n1 11\n1 9\n1 7\n1 3\n2 33\n2 3\n2 47\n2 38\n3 34\n3 37\n4 38\n4 41\n4 35\n4 46\n4 5\n5 36\n5 6\n5 45\n6 7\n7 36\n7 37\n7 8\n8 9\n9 10\n10 11\n11 12\n12 13\n13 14\n14 15\n15 16\n16 17\n17 18\n18 19\n19 20\n20 21\n21 22\n22 23\n23 24\n24 25\n25 26\n26 27\n27 28\n28 29\n29 30\n30 31\n31 49\n32 48\n32 33\n33 34\n34 48\n35 37\n35 36\n35 43\n35 40\n36 44\n37 39\n37 47\n38 42\n39 40\n39 42\n40 41\n41 42\n42 47\n43 44\n43 46\n44 45\n45 46\n48 49\n";
  var SAMPLE2_WITH_COORDS = "v 0 448 351\nv 1 335 380\nv 2 392 10\nv 3 245 162\nv 4 214 41\nv 5 150 269\nv 6 539 25\nv 7 99 141\nv 8 217 478\nv 9 182 584\nv 10 156 391\nv 11 47 529\nv 12 281 273\nv 13 313 591\nv 14 10 387\nv 15 348 123\nv 16 603 353\nv 17 726 178\nv 18 548 159\nv 19 621 251\nv 20 441 208\nv 21 783 328\nv 22 674 442\nv 23 476 621\nv 24 587 662\nv 25 425 527\nv 26 404 720\nv 27 550 487\nv 28 696 581\nv 29 263 717\n0 15\n0 6\n0 2\n0 3\n1 3\n1 4\n1 7\n1 15\n15 7\n15 4\n15 2\n15 6\n6 2\n2 4\n2 3\n3 4\n4 7\n3 5\n1 5\n0 5\n0 16\n0 21\n0 17\n0 18\n1 18\n1 19\n1 22\n1 16\n16 22\n16 19\n16 17\n16 21\n21 17\n17 19\n17 18\n18 19\n19 22\n18 20\n1 20\n0 20\n23 29\n23 26\n23 24\n23 28\n28 24\n24 26\n24 25\n25 26\n26 29\n25 27\n27 0\n25 0\n24 0\n28 0\n27 1\n25 1\n26 1\n29 1\n23 1\n23 0\n8 14\n8 11\n8 9\n8 13\n13 9\n9 11\n9 10\n10 11\n11 14\n10 12\n1 12\n10 1\n11 1\n12 0\n10 0\n9 0\n13 0\n14 1\n8 1\n8 0\n12 15\n16 27\n";
  var SAMPLE3_WITH_COORDS = "v 1 1173 262\nv 2 669 -48\nv 3 166 262\nv 4 360 765\nv 5 979 765\nv 6 979 300\nv 7 669 107\nv 8 360 300\nv 9 476 630\nv 10 863 630\nv 11 824 223\nv 12 515 223\nv 13 437 455\nv 14 669 572\nv 15 902 455\nv 16 766 417\nv 17 730 322\nv 18 592 322\nv 19 553 417\nv 20 669 494\n1 2\n2 3\n3 4\n4 5\n5 1\n1 6\n7 2\n8 3\n9 4\n10 5\n15 6\n6 11\n11 7\n7 12\n12 8\n8 13\n13 9\n9 14\n14 10\n10 15\n16 17\n17 18\n18 19\n19 20\n20 16\n16 15\n20 14\n19 13\n18 12\n17 11\n";
  var SAMPLE4_WITH_COORDS = "v 1 555 1029\nv 2 1234 310\nv 3 555 151\nv 4 475 470\nv 5 715 470\nv 6 76 310\nv 7 914 310\nv 8 555 789\nv 9 555 710\nv 10 395 710\nv 11 395 630\nv 12 395 550\nv 13 475 550\nv 14 555 550\nv 15 635 550\nv 16 715 550\nv 17 635 710\nv 18 635 789\nv 19 1314 310\nv 20 954 71\nv 21 1154 310\nv 22 555 -249\nv 23 555 71\nv 24 -84 310\nv 25 1074 310\nv 26 -4 310\nv 27 994 310\nv 28 395 71\nv 29 475 71\nv 30 715 71\nv 31 635 151\nv 32 555 230\nv 33 555 310\nv 34 555 390\nv 35 475 230\nv 36 395 310\nv 37 395 390\nv 38 475 390\nv 39 635 230\nv 40 715 310\nv 41 715 390\nv 42 635 390\n1 2\n6 4\n4 5\n5 7\n7 3\n3 6\n1 7\n8 1\n9 8\n8 10\n10 11\n11 12\n12 13\n13 14\n14 15\n15 16\n16 17\n17 18\n18 8\n1 10\n1 18\n18 7\n7 16\n16 5\n5 14\n14 4\n4 12\n6 12\n10 6\n9 10\n9 11\n9 18\n9 17\n2 20\n19 20\n21 2\n2 19\n21 20\n20 22\n22 23\n23 3\n29 22\n22 31\n31 7\n27 7\n30 7\n27 30\n31 30\n27 25\n25 21\n1 21\n1 25\n21 22\n30 22\n31 23\n27 22\n25 22\n31 3\n1 27\n1 19\n1 24\n1 26\n26 28\n26 6\n28 6\n29 6\n28 29\n29 3\n29 23\n22 28\n26 22\n24 22\n24 26\n3 35\n3 39\n35 32\n39 32\n32 33\n33 34\n35 6\n35 36\n36 6\n39 40\n40 7\n7 39\n39 33\n35 33\n33 41\n33 42\n33 37\n33 38\n37 38\n41 42\n42 34\n34 38\n34 5\n42 5\n41 5\n34 4\n38 4\n37 4\n6 37\n7 41\n36 33\n40 33\n40 41\n36 37\n1 6\n9 13\n9 14\n9 12\n9 16\n9 15\n";
  var SAMPLE5_WITH_COORDS = "v 1 390 -109\nv 2 171 198\nv 3 171 -21\nv 4 -225 198\nv 5 -5 147\nv 6 104 111\nv 7 -49 23\nv 8 -93 -65\nv 9 -5 286\nv 10 39 375\nv 11 -72 374\nv 12 610 198\nv 13 346 87\nv 14 412 21\nv 15 368 418\nv 16 302 286\nv 17 434 286\nv 18 368 638\nv 19 654 638\nv 20 610 -26\nv 21 829 -26\nv 22 712 21\nv 23 1005 198\nv 24 807 111\nv 25 636 -329\nv 26 478 -287\nv 27 595 -213\nv 28 551 -125\nv 29 698 -241\nv 30 698 -109\nv 31 368 989\nv 32 127 638\nv 33 566 856\nv 34 258 725\nv 35 324 812\nv 36 654 945\nv 37 712 791\n1 2\n1 3\n2 3\n2 4\n4 3\n2 5\n2 6\n5 3\n6 3\n4 7\n7 3\n3 8\n4 8\n2 9\n9 4\n2 10\n10 9\n10 11\n9 11\n1 12\n12 2\n1 13\n13 2\n14 13\n1 14\n12 15\n15 2\n15 16\n16 2\n12 17\n17 15\n12 18\n18 2\n19 18\n12 19\n20 12\n20 1\n20 21\n21 12\n20 22\n22 21\n21 23\n12 23\n21 24\n12 24\n25 1\n25 20\n25 26\n26 1\n1 27\n27 20\n27 28\n1 28\n25 29\n29 20\n20 30\n29 30\n18 31\n19 31\n31 32\n18 32\n19 33\n33 31\n32 34\n18 35\n34 35\n18 34\n36 33\n36 19\n36 37\n19 37\n";

  var graphSamples = {
    sample1: SAMPLE1_WITH_COORDS,
    sample2: SAMPLE2_WITH_COORDS,
    sample3: SAMPLE3_WITH_COORDS,
    sample4: SAMPLE4_WITH_COORDS,
    sample5: SAMPLE5_WITH_COORDS,
    randomplanar1: randomPlanarGraphNM(30, 80, 30080),
    randomplanar2: randomPlanarGraphNM(50, 130, 50130),
    randomplanar3: randomPlanarGraphNM(50, 144, 50144),
    randomplanar4: randomPlanarGraphNM(60, 150, 60150),
    randomplanar5: randomPlanarGraphNM(70, 200, 70200),
    nonplanar1: nonPlanarK33(),
    nonplanar2: nonPlanarK6(),
    cycle20: cycleGraph(20),
    ladder20: ladderGraph(20),
    grid2x20: gridGraph(2, 20),
    grid4x20: gridGraph(4, 20),
    grid9x9: gridGraph(9, 9),
    wheel7: wheelGraph(7),
    xtree30: xTreeGraph(30),
    planar3tree10: maximalPlanar3Tree(10),
    planar3tree30: maximalPlanar3Tree(30),
    planar3tree100: maximalPlanar3Tree(100),
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
    xTreeGraph: xTreeGraph,
    maximalPlanar3Tree: maximalPlanar3Tree,
    nonPlanarK33: nonPlanarK33,
    nonPlanarK6: nonPlanarK6,
    nonPlanarK33PlusPath: nonPlanarK33PlusPath,
    createSeededRng: createSeededRng,
    planarStellationGraph: planarStellationGraph,
    randomPlanarGraphNM: randomPlanarGraphNM,
    getSample: getSample,
    defaultSample: 'sample1'
  };
})(window);
