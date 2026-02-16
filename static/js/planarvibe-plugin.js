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

(function (global) {
  'use strict';

  function initBrowserApp() {
    if (!global.document || typeof global.cytoscape !== 'function' || typeof global.$ !== 'function') {
      return false;
    }
    if (!global.PlanarVibePlugin || !global.PlanarVibeGraphGenerator) {
      return false;
    }
    if (global.__PlanarVibeAppInitialized) {
      return true;
    }
    global.__PlanarVibeAppInitialized = true;

    var LOGO_COLORS = {
      blue: '#1060A8',
      orange: '#EA9624',
      green: '#609818',
      ink: '#103870',
      black: '#111111'
    };

    var currentParsed = null;
    var GRAPH_STYLE_COOKIE_DAYS = 365;
    var DEFAULT_VERTEX_SIZE = 15;
    var DEFAULT_EDGE_WIDTH = 1;
    var PREF_VERTEX_SIZE_KEY = 'planarvibe_vertex_size';
    var PREF_EDGE_WIDTH_KEY = 'planarvibe_edge_width';

    function writeCookie(name, value, days) {
      var d = new Date();
      d.setTime(d.getTime() + (days * 24 * 60 * 60 * 1000));
      global.document.cookie = name + '=' + encodeURIComponent(String(value)) + ';expires=' + d.toUTCString() + ';path=/;SameSite=Lax';
    }

    function readCookie(name) {
      var prefix = name + '=';
      var parts = global.document.cookie ? global.document.cookie.split(';') : [];
      for (var i = 0; i < parts.length; i += 1) {
        var c = parts[i].trim();
        if (c.indexOf(prefix) === 0) {
          return decodeURIComponent(c.substring(prefix.length));
        }
      }
      return null;
    }

    function readStorage(name) {
      try {
        if (global.localStorage) {
          var v = global.localStorage.getItem(name);
          if (v !== null && v !== undefined) {
            return v;
          }
        }
      } catch (e) {}
      return readCookie(name);
    }

    function writeStorage(name, value) {
      try {
        if (global.localStorage) {
          global.localStorage.setItem(name, String(value));
        }
      } catch (e) {}
      writeCookie(name, value, GRAPH_STYLE_COOKIE_DAYS);
    }

    function readNumericPreference(name, fallback, min, max) {
      var raw = readStorage(name);
      var value = Number(raw);
      if (!Number.isFinite(value)) {
        return fallback;
      }
      if (value < min || value > max) {
        return fallback;
      }
      return value;
    }

    var graphStylePrefs = {
      vertexSize: readNumericPreference(PREF_VERTEX_SIZE_KEY, DEFAULT_VERTEX_SIZE, 4, 20),
      edgeWidth: readNumericPreference(PREF_EDGE_WIDTH_KEY, DEFAULT_EDGE_WIDTH, 0.25, 5)
    };

    function computeNodeFontSize(vertexSize) {
      return Math.max(6, Math.round(vertexSize * 0.45));
    }

    var cy = global.cytoscape({
      container: global.document.getElementById('cy'),
      elements: [],
      wheelSensitivity: 0.15,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': LOGO_COLORS.blue,
            'border-color': LOGO_COLORS.black,
            'border-width': 0.5,
            'label': 'data(label)',
            'color': '#ffffff',
            'font-size': computeNodeFontSize(graphStylePrefs.vertexSize),
            'text-valign': 'center',
            'text-halign': 'center',
            'width': graphStylePrefs.vertexSize,
            'height': graphStylePrefs.vertexSize
          }
        },
        {
          selector: 'edge',
          style: {
            'line-color': LOGO_COLORS.black,
            'width': graphStylePrefs.edgeWidth,
            'curve-style': 'bezier'
          }
        }
      ],
      layout: { name: 'grid' }
    });

    function setStatus(message, isError) {
      global.$('#status').text(message).css('color', isError ? '#ba1b1b' : LOGO_COLORS.ink);
    }

    function applyGraphAppearance() {
      cy.style()
        .selector('node')
        .style({
          'width': graphStylePrefs.vertexSize,
          'height': graphStylePrefs.vertexSize,
          'font-size': computeNodeFontSize(graphStylePrefs.vertexSize)
        })
        .selector('edge')
        .style({
          'width': graphStylePrefs.edgeWidth
        })
        .update();
    }

    function updateStyleControlsUI() {
      global.$('#vertex-size-slider').val(String(graphStylePrefs.vertexSize));
      global.$('#edge-width-slider').val(String(graphStylePrefs.edgeWidth));
      global.$('#vertex-size-value').text(String(graphStylePrefs.vertexSize));
      global.$('#edge-width-value').text(String(graphStylePrefs.edgeWidth));
    }

    function initStyleControls() {
      updateStyleControlsUI();
      applyGraphAppearance();

      global.$('#vertex-size-slider').on('input change', function () {
        graphStylePrefs.vertexSize = Number(global.$(this).val()) || DEFAULT_VERTEX_SIZE;
        updateStyleControlsUI();
        applyGraphAppearance();
        writeStorage(PREF_VERTEX_SIZE_KEY, graphStylePrefs.vertexSize);
      });

      global.$('#edge-width-slider').on('input change', function () {
        graphStylePrefs.edgeWidth = Number(global.$(this).val()) || DEFAULT_EDGE_WIDTH;
        updateStyleControlsUI();
        applyGraphAppearance();
        writeStorage(PREF_EDGE_WIDTH_KEY, graphStylePrefs.edgeWidth);
      });
    }

    function smallGraphCoordinatesSuffix() {
      if (cy.nodes().length === 0 || cy.nodes().length > 10) {
        return '';
      }

      var nodes = cy.nodes().toArray().slice();
      nodes.sort(function (a, b) {
        var ai = String(a.id());
        var bi = String(b.id());
        var an = Number(ai);
        var bn = Number(bi);
        var aNum = Number.isFinite(an);
        var bNum = Number.isFinite(bn);
        if (aNum && bNum) {
          return an - bn;
        }
        return ai.localeCompare(bi);
      });

      var parts = [];
      for (var i = 0; i < nodes.length; i += 1) {
        var node = nodes[i];
        var p = node.position();
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
          continue;
        }
        parts.push(node.id() + '=(' + Math.round(p.x) + ',' + Math.round(p.y) + ')');
      }
      if (parts.length === 0) {
        return '';
      }
      return ' | coords: ' + parts.join(' ');
    }

    function setLayoutStatus(message, isError) {
      if (isError) {
        setStatus(message, true);
        clearFaceAreaPlot('No plot');
        return;
      }
      setStatus(message + smallGraphCoordinatesSuffix(), false);
      updateFaceAreaPlot();
    }

    function escapeXml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
    }

    function getFacePlotSize() {
      var el = global.document.getElementById('stats-face-plot');
      var w = el ? Math.max(220, Math.floor(el.clientWidth || el.getBoundingClientRect().width || 220)) : 220;
      var h = 120;
      return { width: w, height: h };
    }

    function clearFaceAreaPlot(text) {
      var label = text || 'No data';
      var size = getFacePlotSize();
      global.$('#stats-face-plot')
        .attr('viewBox', '0 0 ' + size.width + ' ' + size.height)
        .attr('preserveAspectRatio', 'none')
        .html(
        '<rect x="0" y="0" width="' + size.width + '" height="' + size.height + '" fill="#fbfdff" />' +
        '<text x="' + (size.width / 2) + '" y="' + Math.floor(size.height / 2 + 4) + '" text-anchor="middle" fill="#7b8797" font-size="11">' + escapeXml(label) + '</text>' +
        ''
      );
    }

    function renderFaceAreaPlot(values, ideal, showLine) {
      var size = getFacePlotSize();
      var W = size.width;
      var H = size.height;
      var L = 46;
      var R = 8;
      var T = 8;
      var B = 20;
      var PW = W - L - R;
      var PH = H - T - B;
      var maxY = Math.max(5 * ideal, 1e-9);
      var i;

      function sx(idx) {
        if (values.length <= 1) {
          return L + PW / 2;
        }
        return L + (idx / (values.length - 1)) * PW;
      }
      function sy(v) {
        return T + PH - (v / maxY) * PH;
      }

      var pts = '';
      for (i = 0; i < values.length; i += 1) {
        pts += (i ? ' ' : '') + sx(i) + ',' + sy(Math.min(values[i], maxY));
      }

      var yIdeal = sy(ideal);
      var yMaxLabel = maxY.toFixed(3);
      var yIdealLabel = ideal.toFixed(3);

      var svg = '';
      svg += '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#fbfdff" />';
      svg += '<line x1="' + L + '" y1="' + (T + PH) + '" x2="' + (L + PW) + '" y2="' + (T + PH) + '" stroke="#a8b7cc" stroke-width="1" />';
      svg += '<line x1="' + L + '" y1="' + T + '" x2="' + L + '" y2="' + (T + PH) + '" stroke="#a8b7cc" stroke-width="1" />';
      svg += '<line x1="' + L + '" y1="' + yIdeal + '" x2="' + (L + PW) + '" y2="' + yIdeal + '" stroke="#ea9624" stroke-width="1" stroke-dasharray="3 3" />';
      if (showLine && values.length >= 1) {
        svg += '<polyline fill="none" stroke="#1060A8" stroke-width="1.5" points="' + pts + '" />';
      }
      var yTickX = L - 4;
      svg += '<text x="' + yTickX + '" y="' + (T + 11) + '" text-anchor="end" fill="#5f6c80" font-size="10">' + yMaxLabel + '</text>';
      svg += '<text x="' + yTickX + '" y="' + (T + PH + 11) + '" text-anchor="end" fill="#5f6c80" font-size="10">0</text>';
      svg += '<text x="' + (W - 4) + '" y="' + (H - 4) + '" text-anchor="end" fill="#5f6c80" font-size="10">faces sorted</text>';
      svg += '<text x="' + yTickX + '" y="' + (yIdeal - 11) + '" text-anchor="end" fill="#ea9624" font-size="10">ideal</text>';
      svg += '<text x="' + yTickX + '" y="' + (yIdeal - 1) + '" text-anchor="end" fill="#ea9624" font-size="10">' + yIdealLabel + '</text>';
      global.$('#stats-face-plot')
        .attr('viewBox', '0 0 ' + W + ' ' + H)
        .attr('preserveAspectRatio', 'none')
        .html(svg);
    }

    function edgePairsFromParsed(parsed) {
      var pairs = [];
      if (!parsed || !parsed.elements) {
        return pairs;
      }
      for (var i = 0; i < parsed.elements.length; i += 1) {
        var el = parsed.elements[i];
        if (el && el.data && el.data.source !== undefined && el.data.target !== undefined) {
          pairs.push([String(el.data.source), String(el.data.target)]);
        }
      }
      return pairs;
    }

    function hasDrawingCrossings() {
      var edges = cy.edges().toArray();
      var EPS = 1e-9;

      function orient(a, b, c) {
        return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      }

      function onSegment(a, b, c) {
        return (
          Math.min(a.x, b.x) - EPS <= c.x && c.x <= Math.max(a.x, b.x) + EPS &&
          Math.min(a.y, b.y) - EPS <= c.y && c.y <= Math.max(a.y, b.y) + EPS
        );
      }

      function pointsEqual(a, b) {
        return Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS;
      }

      function properIntersect(a, b, c, d) {
        var o1 = orient(a, b, c);
        var o2 = orient(a, b, d);
        var o3 = orient(c, d, a);
        var o4 = orient(c, d, b);

        if (((o1 > EPS && o2 < -EPS) || (o1 < -EPS && o2 > EPS)) &&
            ((o3 > EPS && o4 < -EPS) || (o3 < -EPS && o4 > EPS))) {
          return true;
        }

        if (Math.abs(o1) <= EPS && onSegment(a, b, c) && !pointsEqual(c, a) && !pointsEqual(c, b)) return true;
        if (Math.abs(o2) <= EPS && onSegment(a, b, d) && !pointsEqual(d, a) && !pointsEqual(d, b)) return true;
        if (Math.abs(o3) <= EPS && onSegment(c, d, a) && !pointsEqual(a, c) && !pointsEqual(a, d)) return true;
        if (Math.abs(o4) <= EPS && onSegment(c, d, b) && !pointsEqual(b, c) && !pointsEqual(b, d)) return true;
        return false;
      }

      for (var i = 0; i < edges.length; i += 1) {
        var e1 = edges[i];
        var s1 = String(e1.source().id());
        var t1 = String(e1.target().id());
        var p1 = e1.source().position();
        var q1 = e1.target().position();
        if (!p1 || !q1) {
          continue;
        }

        for (var j = i + 1; j < edges.length; j += 1) {
          var e2 = edges[j];
          var s2 = String(e2.source().id());
          var t2 = String(e2.target().id());
          if (s1 === s2 || s1 === t2 || t1 === s2 || t1 === t2) {
            continue;
          }
          var p2 = e2.source().position();
          var q2 = e2.target().position();
          if (!p2 || !q2) {
            continue;
          }

          if (properIntersect(p1, q1, p2, q2)) {
            return true;
          }
        }
      }
      return false;
    }

    function updateFaceAreaPlot() {
      if (!currentParsed || !currentParsed.elements || cy.nodes().length === 0) {
        clearFaceAreaPlot('No graph');
        return;
      }
      if (!global.PlanarVibeMetrics || !global.PlanarVibeMetrics.computeFaceAreaDistributionFromCy) {
        clearFaceAreaPlot('Metrics unavailable');
        return;
      }
      var edgePairs = edgePairsFromParsed(currentParsed);
      var result = global.PlanarVibeMetrics.computeFaceAreaDistributionFromCy(cy, edgePairs);
      if (!result.ok) {
        clearFaceAreaPlot(result.reason || 'No data');
        return;
      }
      renderFaceAreaPlot(result.values, result.ideal, !hasDrawingCrossings());
    }

    function normalizeLayoutScale() {
      var nodes = cy.nodes();
      if (!nodes || nodes.length === 0) {
        return;
      }
      var minX = Infinity;
      var minY = Infinity;
      var maxX = -Infinity;
      var maxY = -Infinity;
      nodes.forEach(function (node) {
        var p = node.position();
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
          return;
        }
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      });
      if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) {
        return;
      }
      var width = maxX - minX;
      var height = maxY - minY;
      var pad = 24;
      var targetWidth = 900;
      var targetHeight = 620;
      var safeW = Math.max(1e-9, width);
      var safeH = Math.max(1e-9, height);
      var scale = Math.min((targetWidth - 2 * pad) / safeW, (targetHeight - 2 * pad) / safeH);
      if (!Number.isFinite(scale) || scale <= 0) {
        return;
      }
      if (width < 1e-9 && height < 1e-9) {
        var single = nodes[0];
        if (single) {
          single.position({ x: targetWidth / 2, y: targetHeight / 2 });
        }
        cy.fit(undefined, 24);
        return;
      }
      nodes.forEach(function (node) {
        var p = node.position();
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
          return;
        }
        node.position({
          x: (p.x - minX) * scale + pad,
          y: (p.y - minY) * scale + pad
        });
      });
      cy.fit(undefined, 24);
    }

    function setStatistics(stats) {
      var s = stats || {};
      global.$('#stat-is-planar').prop('checked', !!s.isPlanar).prop('disabled', true);
      global.$('#stat-is-bipartite').prop('checked', !!s.isBipartite).prop('disabled', true);
      global.$('#stat-is-planar-3-tree').prop('checked', !!s.isPlanar3Tree).prop('disabled', true);
    }

    function setTutteEnabled(isEnabled) {
      var $btn = global.$('.layout-btn[data-layout="tutte"]');
      $btn.prop('disabled', !isEnabled);
      if (!isEnabled) {
        $btn.removeClass('is-active');
      }
    }

    function setP3TEnabled(isEnabled) {
      var $btn = global.$('.layout-btn[data-layout="p3t"]');
      $btn.prop('disabled', !isEnabled);
      if (!isEnabled) {
        $btn.removeClass('is-active');
      }
    }

    function setFPPEnabled(isEnabled) {
      var $btn = global.$('.layout-btn[data-layout="fpp"]');
      $btn.prop('disabled', !isEnabled);
      if (!isEnabled) {
        $btn.removeClass('is-active');
      }
    }

    function isBipartiteGraph(nodeIds, edgePairs) {
      var adjacency = {};
      for (var i = 0; i < nodeIds.length; i += 1) {
        adjacency[String(nodeIds[i])] = [];
      }
      for (i = 0; i < edgePairs.length; i += 1) {
        var u = String(edgePairs[i][0]);
        var v = String(edgePairs[i][1]);
        if (u === v) {
          return false;
        }
        if (!adjacency[u]) adjacency[u] = [];
        if (!adjacency[v]) adjacency[v] = [];
        adjacency[u].push(v);
        adjacency[v].push(u);
      }

      var color = {};
      for (i = 0; i < nodeIds.length; i += 1) {
        var start = String(nodeIds[i]);
        if (color[start] !== undefined) continue;
        color[start] = 0;
        var queue = [start];
        var head = 0;
        while (head < queue.length) {
          var x = queue[head];
          head += 1;
          var neigh = adjacency[x] || [];
          for (var j = 0; j < neigh.length; j += 1) {
            var y = neigh[j];
            if (color[y] === undefined) {
              color[y] = 1 - color[x];
              queue.push(y);
            } else if (color[y] === color[x]) {
              return false;
            }
          }
        }
      }
      return true;
    }

    function updateStatistics(parsed) {
      if (!parsed || !parsed.elements) {
        setStatistics({ isPlanar: false, isBipartite: false, isPlanar3Tree: false });
        clearFaceAreaPlot('No graph');
        setTutteEnabled(false);
        setP3TEnabled(false);
        setFPPEnabled(false);
        return;
      }
      if (!global.PlanarVibePlanarityTest || !global.PlanarVibePlanarityTest.computePlanarEmbedding) {
        setStatistics({ isPlanar: false, isBipartite: false, isPlanar3Tree: false });
        clearFaceAreaPlot('No plot');
        setTutteEnabled(false);
        setP3TEnabled(false);
        setFPPEnabled(false);
        return;
      }
      var nodeIds = cy.nodes().map(function (node) { return String(node.id()); });
      var edgePairs = edgePairsFromParsed(parsed);
      var embedding = global.PlanarVibePlanarityTest.computePlanarEmbedding(nodeIds, edgePairs);
      var isPlanar = !!(embedding && embedding.ok);
      var isBipartite = isBipartiteGraph(nodeIds, edgePairs);
      var isPlanar3Tree = false;
      if (isPlanar && global.PlanarVibePlanarityTest.isPlanar3Tree) {
        isPlanar3Tree = !!global.PlanarVibePlanarityTest.isPlanar3Tree(nodeIds, edgePairs);
      }
      setStatistics({ isPlanar: isPlanar, isBipartite: isBipartite, isPlanar3Tree: isPlanar3Tree });
      setTutteEnabled(isPlanar);
      setP3TEnabled(isPlanar3Tree);
      setFPPEnabled(isPlanar);
    }

    function drawGraph() {
      try {
        currentParsed = global.PlanarVibePlugin.parseEdgeList(global.$('#dotfile').val());
        cy.elements().remove();
        cy.add(currentParsed.elements);
        updateStatistics(currentParsed);
        applyLayout('random');
        setLayoutStatus('Drawn ' + currentParsed.nodeCount + ' nodes and ' + currentParsed.edgeCount + ' edges (random coordinates)', false);
      } catch (error) {
        setStatistics({ isPlanar: false, isBipartite: false, isPlanar3Tree: false });
        clearFaceAreaPlot('Parse error');
        setTutteEnabled(false);
        setP3TEnabled(false);
        setFPPEnabled(false);
        setStatus(error.message, true);
      }
    }

    function checkTextArea() {
      var value = global.$('#dotfile').val().trim();
      if (!value) {
        setStatus('Please paste a graph first', true);
        return false;
      }
      drawGraph();
      return false;
    }

    function pasteStaticGraph(name) {
      var sampleGraph = global.PlanarVibeGraphGenerator.getSample(name);
      if (!sampleGraph) {
        setStatus('Unknown sample: ' + name + '.', true);
        return;
      }
      global.$('#dotfile').val(sampleGraph);
      drawGraph();
    }

    function applyLayout(layoutName) {
      if (cy.nodes().length === 0) {
        return;
      }
      setSelectedLayoutButton(layoutName);

      if (layoutName === 'random') {
        global.PlanarVibePlugin.applyDeterministicRandomPositions(cy);
        normalizeLayoutScale();
        setLayoutStatus('Applied random coordinates', false);
        return;
      }

      if (layoutName === 'tutte') {
        if (global.$('.layout-btn[data-layout="tutte"]').prop('disabled')) {
          setStatus('Tutte layout requires a planar graph.', true);
          return;
        }
        var result = global.PlanarVibeTutte.applyTutteLayout(cy);
        if (result.ok) normalizeLayoutScale();
        setLayoutStatus(result.message, !result.ok);
        return;
      }

      if (layoutName === 'p3t') {
        if (global.$('.layout-btn[data-layout="p3t"]').prop('disabled')) {
          setStatus('P3T layout requires a planar 3-tree.', true);
          return;
        }
        if (!global.PlanarVibeP3T || !global.PlanarVibeP3T.applyP3TLayout) {
          setStatus('P3T layout module is missing.', true);
          return;
        }
        result = global.PlanarVibeP3T.applyP3TLayout(cy);
        if (result.ok) normalizeLayoutScale();
        setLayoutStatus(result.message, !result.ok);
        return;
      }

      if (layoutName === 'fpp') {
        if (global.$('.layout-btn[data-layout="fpp"]').prop('disabled')) {
          setStatus('FPP layout requires a planar graph.', true);
          return;
        }
        if (!global.PlanarVibeFPP || !global.PlanarVibeFPP.applyFPPLayout) {
          setStatus('FPP layout module is missing.', true);
          return;
        }
        var fppResult = global.PlanarVibeFPP.applyFPPLayout(cy);
        if (fppResult.ok) normalizeLayoutScale();
        setLayoutStatus(fppResult.message, !fppResult.ok);
        return;
      }

      var layout = cy.layout(global.PlanarVibePlugin.layoutOptionsByName(layoutName, currentParsed));
      if (layout && layout.one) {
        layout.one('layoutstop', function () {
          normalizeLayoutScale();
          setLayoutStatus('Applied ' + layoutName + ' layout', false);
        });
      } else {
        setTimeout(function () {
          normalizeLayoutScale();
          setLayoutStatus('Applied ' + layoutName + ' layout', false);
        }, 0);
      }
      layout.run();
    }

    function setSelectedLayoutButton(layoutName) {
      global.$('.layout-btn').removeClass('is-active');
      global.$('.layout-btn[data-layout="' + layoutName + '"]').addClass('is-active');
    }

    function resetZoom() {
      if (cy.nodes().length === 0) {
        return;
      }
      cy.fit(undefined, 20);
      cy.center();
      setStatus('Zoom reset.', false);
    }

    function exportSvg() {
      var nodes = cy.nodes();
      if (!nodes || nodes.length === 0) {
        setStatus('Nothing to export.', true);
        return;
      }
      var vertexSize = graphStylePrefs.vertexSize;
      var edgeWidth = graphStylePrefs.edgeWidth;
      var radius = vertexSize / 2;
      var fontSize = computeNodeFontSize(vertexSize);
      var pad = Math.max(24, radius + 8);
      var minX = Infinity;
      var minY = Infinity;
      var maxX = -Infinity;
      var maxY = -Infinity;
      nodes.forEach(function (node) {
        var p = node.position();
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
        minX = Math.min(minX, p.x - radius);
        minY = Math.min(minY, p.y - radius);
        maxX = Math.max(maxX, p.x + radius);
        maxY = Math.max(maxY, p.y + radius);
      });
      if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) {
        setStatus('Cannot export: invalid node positions.', true);
        return;
      }
      var width = Math.max(1, Math.ceil(maxX - minX + 2 * pad));
      var height = Math.max(1, Math.ceil(maxY - minY + 2 * pad));
      var offsetX = -minX + pad;
      var offsetY = -minY + pad;
      var svg = [];
      svg.push('<?xml version="1.0" encoding="UTF-8"?>');
      svg.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">');
      svg.push('<rect x="0" y="0" width="' + width + '" height="' + height + '" fill="#ffffff"/>');
      svg.push('<g id="edges" stroke="' + LOGO_COLORS.black + '" stroke-width="' + edgeWidth + '" fill="none" stroke-linecap="round">');
      cy.edges().forEach(function (edge) {
        var s = edge.source().position();
        var t = edge.target().position();
        if (!s || !t || !Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(t.x) || !Number.isFinite(t.y)) return;
        svg.push('<line x1="' + (s.x + offsetX) + '" y1="' + (s.y + offsetY) + '" x2="' + (t.x + offsetX) + '" y2="' + (t.y + offsetY) + '"/>');
      });
      svg.push('</g>');
      svg.push('<g id="nodes">');
      nodes.forEach(function (node) {
        var p = node.position();
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
        var x = p.x + offsetX;
        var y = p.y + offsetY;
        var label = escapeXml(node.data('label') !== undefined ? node.data('label') : node.id());
        svg.push('<circle cx="' + x + '" cy="' + y + '" r="' + radius + '" fill="' + LOGO_COLORS.blue + '" stroke="' + LOGO_COLORS.black + '" stroke-width="0.5"/>');
        svg.push('<text x="' + x + '" y="' + y + '" text-anchor="middle" dominant-baseline="middle" fill="#ffffff" font-size="' + fontSize + '" font-family="Segoe UI, Arial, sans-serif">' + label + '</text>');
      });
      svg.push('</g>');
      svg.push('</svg>');
      var blob = new Blob([svg.join('')], { type: 'image/svg+xml;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var link = global.document.createElement('a');
      link.href = url;
      link.download = 'planarvibe-drawing.svg';
      global.document.body.appendChild(link);
      link.click();
      global.document.body.removeChild(link);
      URL.revokeObjectURL(url);
      setStatus('Saved SVG.', false);
    }

    function bindUiEvents() {
      global.$('#graph-form').on('submit', function (event) {
        event.preventDefault();
        checkTextArea();
      });

      global.$('.sample-link').on('click', function (event) {
        event.preventDefault();
        var sampleName = global.$(this).data('sample');
        if (sampleName) {
          pasteStaticGraph(String(sampleName));
        }
      });

      global.$('.layout-btn').on('click', function () {
        var layoutName = global.$(this).data('layout');
        if (layoutName) {
          applyLayout(String(layoutName));
        }
      });

      global.$('#reset-zoom-btn').on('click', function () {
        resetZoom();
      });

      global.$('#save-svg-btn').on('click', function () {
        exportSvg();
      });
    }

    global.checkTextArea = checkTextArea;
    global.pasteStaticGraph = pasteStaticGraph;
    global.applyLayout = applyLayout;
    global.resetZoom = resetZoom;
    global.exportSvg = exportSvg;

    bindUiEvents();
    initStyleControls();
    clearFaceAreaPlot('No graph');
    pasteStaticGraph(global.PlanarVibeGraphGenerator.defaultSample);
    return true;
  }

  function autoInit() {
    initBrowserApp();
  }

  if (global.document) {
    if (global.document.readyState === 'complete' || global.document.readyState === 'interactive') {
      setTimeout(autoInit, 0);
    } else if (typeof global.addEventListener === 'function') {
      global.addEventListener('DOMContentLoaded', autoInit);
    }
  }

  global.PlanarVibePlugin.initBrowserApp = initBrowserApp;
})(window);
