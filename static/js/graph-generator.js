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

  var SAMPLE6_WITH_COORDS = "v 0 3611 3150\nv 1 1430 3151\nv 2 2517 1260\nv 3 2945 2438\nv 4 2861 2513\nv 5 2836 2526\nv 6 2844 2528\nv 7 2877 2537\nv 8 2843 2539\nv 9 2849 2544\nv 10 2871 2561\nv 11 2841 2551\nv 12 2849 2555\nv 13 2880 2572\nv 14 2998 2632\n0 1\n0 2\n0 3\n0 14\n1 2\n2 3\n3 4\n3 7\n3 14\n4 5\n4 6\n4 7\n5 6\n6 7\n7 8\n7 9\n7 10\n7 14\n8 9\n9 10\n10 11\n10 12\n10 13\n10 14\n11 12\n12 13\n13 14\n";
  var SAMPLE7_WITH_COORDS = "v 0 540 270\nv 1 720 90\nv 2 210 450\nv 3 480 360\nv 4 480 180\nv 5 210 90\nv 6 390 270\nv 7 720 450\nv 8 150 510\nv 9 300 270\nv 10 310 225\nv 11 315 300\nv 12 255 270\nv 13 630 270\nv 14 675 270\nv 15 620 225\nv 16 615 300\n0 1\n0 3\n0 6\n0 7\n1 4\n1 5\n1 7\n2 3\n2 5\n2 6\n2 7\n4 6\n5 6\n5 8\n7 8\n7 13\n9 2\n9 5\n9 6\n9 11\n10 5\n10 6\n10 9\n11 2\n11 6\n12 2\n12 5\n12 9\n13 0\n13 1\n13 14\n14 1\n14 7\n15 0\n15 1\n15 13\n16 0\n16 7\n16 13\n";

  var OCT174_WITH_COORDS = "v 0 2866 2500\nv 1 1135 2501\nv 2 2000 2467\nv 3 2173 2442\nv 4 2000 2360\nv 5 1827 2443\nv 6 2381 2475\nv 7 2416 2470\nv 8 2243 2464\nv 9 2416 2449\nv 10 2381 2432\nv 11 2243 2421\nv 12 2173 1953\nv 13 1998 1000\nv 14 1826 1954\nv 15 1758 2421\nv 16 1619 2433\nv 17 1585 2449\nv 18 1758 2464\nv 19 1585 2471\nv 20 1619 2476\nv 21 2035 2452\nv 22 2000 2447\nv 23 1966 2452\nv 24 2035 2409\nv 25 1966 2409\nv 26 2000 2426\nv 27 2380 1791\nv 28 2241 1681\nv 29 2415 1981\nv 30 2416 2253\nv 31 2242 2225\nv 32 2381 2335\nv 33 2423 2430\nv 34 2326 2417\nv 35 2499 2445\nv 36 2582 2463\nv 37 2492 2452\nv 38 2589 2466\nv 39 2548 2468\nv 40 2409 2456\nv 41 2499 2467\nv 42 2499 2471\nv 43 2409 2465\nv 44 2548 2476\nv 45 2589 2483\nv 46 2492 2478\nv 47 2582 2484\nv 48 2499 2483\nv 49 2326 2477\nv 50 2423 2482\nv 51 2174 2487\nv 52 1827 2487\nv 53 2000 2494\nv 54 1578 2482\nv 55 1675 2477\nv 56 1502 2484\nv 57 1419 2485\nv 58 1509 2479\nv 59 1412 2484\nv 60 1453 2477\nv 61 1592 2466\nv 62 1502 2472\nv 63 1502 2467\nv 64 1592 2457\nv 65 1453 2469\nv 66 1412 2467\nv 67 1509 2453\nv 68 1419 2464\nv 69 1502 2446\nv 70 1675 2417\nv 71 1578 2431\nv 72 1619 2335\nv 73 1757 2226\nv 74 1584 2254\nv 75 1584 1982\nv 76 1756 1682\nv 77 1618 1791\nv 78 2201 2470\nv 79 2250 2469\nv 80 2173 2467\nv 81 2132 2461\nv 82 2167 2456\nv 83 2118 2456\nv 84 2077 2454\nv 85 2083 2451\nv 86 2049 2456\nv 87 2007 2458\nv 88 2000 2455\nv 89 1993 2458\nv 90 1952 2456\nv 91 1917 2451\nv 92 1924 2454\nv 93 1883 2457\nv 94 1834 2456\nv 95 1869 2461\nv 96 1827 2467\nv 97 1751 2469\nv 98 1799 2470\nv 99 2284 2441\nv 100 2298 2436\nv 101 2250 2435\nv 102 2166 2417\nv 103 2132 2401\nv 104 2118 2405\nv 105 2076 2403\nv 106 2049 2396\nv 107 2083 2413\nv 108 2083 2426\nv 109 2049 2423\nv 110 2076 2429\nv 111 2035 2436\nv 112 1966 2436\nv 113 2000 2439\nv 114 2000 2443\nv 115 1966 2444\nv 116 2035 2444\nv 117 2076 2446\nv 118 2049 2448\nv 119 2083 2447\nv 120 2250 2456\nv 121 2298 2462\nv 122 2284 2458\nv 123 2034 2116\nv 124 2000 2035\nv 125 1965 2116\nv 126 1799 2401\nv 127 1751 2414\nv 128 1827 2399\nv 129 1869 2401\nv 130 1834 2417\nv 131 1882 2405\nv 132 1924 2403\nv 133 1917 2413\nv 134 1952 2396\nv 135 1993 2390\nv 136 2000 2399\nv 137 2007 2390\nv 138 2173 2399\nv 139 2250 2413\nv 140 2201 2401\nv 141 1924 2429\nv 142 1952 2423\nv 143 1917 2426\nv 144 1751 2435\nv 145 1702 2437\nv 146 1716 2441\nv 147 1716 2458\nv 148 1703 2462\nv 149 1751 2457\nv 150 1917 2447\nv 151 1952 2448\nv 152 1924 2446\nv 153 2367 2471\nv 154 2340 2469\nv 155 2333 2470\nv 156 2367 2437\nv 157 2333 2431\nv 158 2340 2434\nv 159 2033 1572\nv 160 1964 1572\nv 161 1999 1763\nv 162 1668 2432\nv 163 1633 2437\nv 164 1661 2435\nv 165 1661 2469\nv 166 1633 2471\nv 167 1668 2470\nv 168 2007 2450\nv 169 1993 2450\nv 170 2000 2451\nv 171 2000 2413\nv 172 1993 2416\nv 173 2007 2416\n0 1\n0 2\n0 3\n0 4\n0 6\n0 7\n0 9\n0 10\n0 12\n0 13\n0 27\n0 29\n0 30\n0 32\n0 33\n0 35\n0 36\n0 38\n0 39\n0 41\n0 42\n0 44\n0 45\n0 47\n0 48\n0 50\n0 51\n0 53\n1 2\n1 4\n1 5\n1 13\n1 14\n1 16\n1 17\n1 19\n1 20\n1 52\n1 53\n1 54\n1 56\n1 57\n1 59\n1 60\n1 62\n1 63\n1 65\n1 66\n1 68\n1 69\n1 71\n1 72\n1 74\n1 75\n1 77\n2 3\n2 5\n2 6\n2 8\n2 18\n2 20\n2 21\n2 23\n2 49\n2 50\n2 51\n2 52\n2 54\n2 55\n2 78\n2 80\n2 81\n2 83\n2 84\n2 86\n2 87\n2 89\n2 90\n2 92\n2 93\n2 95\n2 96\n2 98\n3 4\n3 5\n3 7\n3 8\n3 9\n3 11\n3 21\n3 22\n3 24\n3 26\n3 40\n3 41\n3 42\n3 43\n3 82\n3 83\n3 84\n3 85\n3 99\n3 101\n3 102\n3 104\n3 105\n3 107\n3 108\n3 110\n3 111\n3 113\n3 114\n3 116\n3 117\n3 119\n3 120\n3 122\n4 5\n4 10\n4 11\n4 12\n4 14\n4 15\n4 16\n4 24\n4 25\n4 31\n4 32\n4 33\n4 34\n4 70\n4 71\n4 72\n4 73\n4 103\n4 104\n4 105\n4 106\n4 123\n4 125\n4 126\n4 128\n4 129\n4 131\n4 132\n4 134\n4 135\n4 137\n4 138\n4 140\n5 15\n5 17\n5 18\n5 19\n5 22\n5 23\n5 25\n5 26\n5 61\n5 62\n5 63\n5 64\n5 91\n5 92\n5 93\n5 94\n5 112\n5 113\n5 114\n5 115\n5 130\n5 131\n5 132\n5 133\n5 141\n5 143\n5 144\n5 146\n5 147\n5 149\n5 150\n5 152\n6 7\n6 8\n6 46\n6 47\n6 48\n6 49\n6 78\n6 79\n6 153\n6 155\n7 8\n7 43\n7 44\n7 45\n7 46\n7 121\n7 122\n7 153\n7 154\n8 79\n8 80\n8 81\n8 82\n8 120\n8 121\n8 154\n8 155\n9 10\n9 11\n9 37\n9 38\n9 39\n9 40\n9 99\n9 100\n9 156\n9 158\n10 11\n10 34\n10 35\n10 36\n10 37\n10 139\n10 140\n10 156\n10 157\n11 100\n11 101\n11 102\n11 103\n11 138\n11 139\n11 157\n11 158\n12 13\n12 14\n12 28\n12 29\n12 30\n12 31\n12 123\n12 124\n12 159\n12 161\n13 14\n13 27\n13 28\n13 76\n13 77\n13 159\n13 160\n14 73\n14 74\n14 75\n14 76\n14 124\n14 125\n14 160\n14 161\n15 16\n15 17\n15 127\n15 128\n15 129\n15 130\n15 144\n15 145\n15 162\n15 164\n16 17\n16 67\n16 68\n16 69\n16 70\n16 126\n16 127\n16 162\n16 163\n17 64\n17 65\n17 66\n17 67\n17 145\n17 146\n17 163\n17 164\n18 19\n18 20\n18 94\n18 95\n18 96\n18 97\n18 148\n18 149\n18 165\n18 167\n19 20\n19 58\n19 59\n19 60\n19 61\n19 147\n19 148\n19 165\n19 166\n20 55\n20 56\n20 57\n20 58\n20 97\n20 98\n20 166\n20 167\n21 22\n21 23\n21 85\n21 86\n21 87\n21 88\n21 118\n21 119\n21 168\n21 170\n22 23\n22 115\n22 116\n22 117\n22 118\n22 151\n22 152\n22 168\n22 169\n23 88\n23 89\n23 90\n23 91\n23 150\n23 151\n23 169\n23 170\n24 25\n24 26\n24 106\n24 107\n24 108\n24 109\n24 136\n24 137\n24 171\n24 173\n25 26\n25 133\n25 134\n25 135\n25 136\n25 142\n25 143\n25 171\n25 172\n26 109\n26 110\n26 111\n26 112\n26 141\n26 142\n26 172\n26 173\n27 28\n27 29\n28 29\n30 31\n30 32\n31 32\n33 34\n33 35\n34 35\n36 37\n36 38\n37 38\n39 40\n39 41\n40 41\n42 43\n42 44\n43 44\n45 46\n45 47\n46 47\n48 49\n48 50\n49 50\n51 52\n51 53\n52 53\n54 55\n54 56\n55 56\n57 58\n57 59\n58 59\n60 61\n60 62\n61 62\n63 64\n63 65\n64 65\n66 67\n66 68\n67 68\n69 70\n69 71\n70 71\n72 73\n72 74\n73 74\n75 76\n75 77\n76 77\n78 79\n78 80\n79 80\n81 82\n81 83\n82 83\n84 85\n84 86\n85 86\n87 88\n87 89\n88 89\n90 91\n90 92\n91 92\n93 94\n93 95\n94 95\n96 97\n96 98\n97 98\n99 100\n99 101\n100 101\n102 103\n102 104\n103 104\n105 106\n105 107\n106 107\n108 109\n108 110\n109 110\n111 112\n111 113\n112 113\n114 115\n114 116\n115 116\n117 118\n117 119\n118 119\n120 121\n120 122\n121 122\n123 124\n123 125\n124 125\n126 127\n126 128\n127 128\n129 130\n129 131\n130 131\n132 133\n132 134\n133 134\n135 136\n135 137\n136 137\n138 139\n138 140\n139 140\n141 142\n141 143\n142 143\n144 145\n144 146\n145 146\n147 148\n147 149\n148 149\n150 151\n150 152\n151 152\n153 154\n153 155\n154 155\n156 157\n156 158\n157 158\n159 160\n159 161\n160 161\n162 163\n162 164\n163 164\n165 166\n165 167\n166 167\n168 169\n168 170\n169 170\n171 172\n171 173\n172 173\n";
  var graphSamples = {
    sample1: SAMPLE1_WITH_COORDS,
    sample2: SAMPLE2_WITH_COORDS,
    sample3: SAMPLE3_WITH_COORDS,
    sample4: SAMPLE4_WITH_COORDS,
    sample5: SAMPLE5_WITH_COORDS,
    sample6: SAMPLE6_WITH_COORDS,
    sample7: SAMPLE7_WITH_COORDS,
    randomplanar1: randomPlanarGraphNM(30, 80, 30080),
    randomplanar2: randomPlanarGraphNM(50, 130, 50130),
    randomplanar3: randomPlanarGraphNM(50, 144, 50144),
    randomplanar4: randomPlanarGraphNM(60, 150, 60150),
    randomplanar5: randomPlanarGraphNM(70, 200, 70200),
    nonplanar1: nonPlanarK33(),
    nonplanar2: nonPlanarK6(),
    cycle20: cycleGraph(20),
    ladder20: ladderGraph(20),
    oct174: OCT174_WITH_COORDS,
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
