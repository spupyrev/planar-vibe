(function (global) {
  'use strict';

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

  var graphSamples = {
    sample1: '0 2\n0 4\n0 6\n0 8\n0 10\n0 12\n0 14\n0 16\n0 18\n0 20\n0 22\n0 24\n0 26\n0 28\n0 30\n0 49\n0 32\n1 48\n1 31\n1 29\n1 27\n1 25\n1 23\n1 21\n1 19\n1 17\n1 15\n1 13\n1 11\n1 9\n1 7\n1 3\n2 33\n2 3\n2 47\n2 38\n3 34\n3 37\n4 38\n4 41\n4 35\n4 46\n4 5\n5 36\n5 6\n5 45\n6 7\n7 36\n7 37\n7 8\n8 9\n9 10\n10 11\n11 12\n12 13\n13 14\n14 15\n15 16\n16 17\n17 18\n18 19\n19 20\n20 21\n21 22\n22 23\n23 24\n24 25\n25 26\n26 27\n27 28\n28 29\n29 30\n30 31\n31 49\n32 48\n32 33\n33 34\n34 48\n35 37\n35 36\n35 43\n35 40\n36 44\n37 39\n37 47\n38 42\n39 40\n39 42\n40 41\n41 42\n42 47\n43 44\n43 46\n44 45\n45 46\n48 49\n',
    sample2: '0 15\n0 6\n0 2\n0 3\n1 3\n1 4\n1 7\n1 15\n15 7\n15 4\n15 2\n15 6\n6 2\n2 4\n2 3\n3 4\n4 7\n3 5\n1 5\n0 5\n0 16\n0 21\n0 17\n0 18\n1 18\n1 19\n1 22\n1 16\n16 22\n16 19\n16 17\n16 21\n21 17\n17 19\n17 18\n18 19\n19 22\n18 20\n1 20\n0 20\n23 29\n23 26\n23 24\n23 28\n28 24\n24 26\n24 25\n25 26\n26 29\n25 27\n27 0\n25 0\n24 0\n28 0\n27 1\n25 1\n26 1\n29 1\n23 1\n23 0\n8 14\n8 11\n8 9\n8 13\n13 9\n9 11\n9 10\n10 11\n11 14\n10 12\n1 12\n10 1\n11 1\n12 0\n10 0\n9 0\n13 0\n14 1\n8 1\n8 0\n12 15\n16 27\n',
    cycle20: cycleGraph(20),
    ladder20: ladderGraph(20),
    grid9x9: gridGraph(9, 9),
    wheel7: '1 2\n2 3\n3 4\n4 5\n5 6\n6 1\n1 7\n2 7\n3 7\n4 7\n5 7\n6 7\n'
  };

  function getSample(name) {
    return graphSamples[name] || null;
  }

  global.PlanarVibeSamples = {
    getSample: getSample,
    defaultSample: 'sample1'
  };
})(window);
