(function (global) {
  'use strict';

  function parseEdgeList(input) {
    var lines = String(input || '').split(/\r?\n/);
    var nodes = new Set();
    var edges = [];
    var edgeKeys = new Set();
    var positionsById = {};
    var hasExplicitPositions = false;

    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i].trim();
      if (!line || line.charAt(0) === '#') {
        continue;
      }

      var parts = line.split(/\s+/);
      if (parts[0] === 'v' || parts[0] === 'V') {
        if (parts.length < 4) {
          throw new Error('Invalid line ' + (i + 1) + ': expected "v id x y".');
        }
        var vertexId = parts[1];
        var x = Number(parts[2]);
        var y = Number(parts[3]);
        if (!vertexId || !Number.isFinite(x) || !Number.isFinite(y)) {
          throw new Error('Invalid line ' + (i + 1) + ': expected finite coordinates in "v id x y".');
        }
        nodes.add(vertexId);
        positionsById[vertexId] = { x: x, y: y };
        hasExplicitPositions = true;
        continue;
      }

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
      edgeCount: edges.length,
      positionsById: positionsById,
      hasExplicitPositions: hasExplicitPositions
    };
  }

  function layoutOptions(parsedGraph) {
    if (!parsedGraph || parsedGraph.nodeCount === 0) {
      return { name: 'grid' };
    }

    return {
      name: 'cose',
      animate: false,
      randomize: false,
      idealEdgeLength: 80,
      nodeRepulsion: 5000,
      fit: true,
      padding: 24
    };
  }

  function layoutOptionsByName(name, parsedGraph) {
    if (name === 'circle') {
      return { name: 'circle', fit: true, padding: 24, animate: false };
    }
    if (name === 'grid') {
      return { name: 'grid', fit: true, padding: 24, animate: false };
    }
    return layoutOptions(parsedGraph);
  }

  global.PlanarVibePlugin = {
    parseEdgeList: parseEdgeList,
    layoutOptions: layoutOptions,
    layoutOptionsByName: layoutOptionsByName
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
    var DEFAULT_WORLD_WIDTH = 900;
    var DEFAULT_WORLD_HEIGHT = 620;
    var PREF_VERTEX_SIZE_KEY = 'planarvibe_vertex_size';
    var PREF_EDGE_WIDTH_KEY = 'planarvibe_edge_width';
    var PREF_INTERACTIVE_KEY = 'planarvibe_interactive_mode';
    var PREF_STATUS_COLLAPSED_KEY = 'planarvibe_status_collapsed';

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
    var isInteractive = readStorage(PREF_INTERACTIVE_KEY) !== '0';
    var isStatusCollapsed = readStorage(PREF_STATUS_COLLAPSED_KEY) === '1';
    var savedPositions = {};
    var savedViewport = null;
    var currentVisualizedInput = null;
    var layoutBusyState = null;

    function hashStringLocal(value, seed) {
      var hash = seed >>> 0;
      var text = String(value);
      for (var i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return hash >>> 0;
    }

    function normalizedHashLocal(value, seed) {
      return hashStringLocal(value, seed) / 4294967295;
    }

    function computeNodeFontSize(vertexSize) {
      return Math.max(6, Math.round(vertexSize * 0.45));
    }

    var cy = null;

    function createCyInstance() {
      return global.cytoscape({
        container: global.document.getElementById('cy'),
        elements: [],
        wheelSensitivity: 0.15,
        pixelRatio: 1,
        motionBlur: false,
        textureOnViewport: false,
        hideEdgesOnViewport: true,
        hideLabelsOnViewport: true,
        boxSelectionEnabled: false,
        autoungrabify: true,
        autounselectify: true,
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
              'curve-style': 'straight'
            }
          }
        ],
        layout: { name: 'grid' }
      });
    }

    cy = createCyInstance();

    function setStatus(message, isError) {
      var $status = global.$('#status');
      if (!$status.length) {
        return;
      }
      var $entry = global.$('<div class="status-entry"></div>').text(String(message || ''));
      if (isError) {
        $entry.addClass('is-error');
      }
      $status.append($entry);

      var $entries = $status.children('.status-entry');
      var maxEntries = 250;
      if ($entries.length > maxEntries) {
        $entries.slice(0, $entries.length - maxEntries).remove();
      }

      var el = $status.get(0);
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    }

    function setStatusPanelCollapsed(collapsed, persist) {
      isStatusCollapsed = !!collapsed;
      var $panel = global.$('.status-panel');
      $panel.toggleClass('is-collapsed', isStatusCollapsed);

      var $btn = global.$('#status-collapse-btn');
      if ($btn.length) {
        $btn.text(isStatusCollapsed ? '▸' : '▾');
        $btn.attr('aria-expanded', String(!isStatusCollapsed));
        $btn.attr('title', isStatusCollapsed ? 'Expand status bar' : 'Collapse status bar');
      }

      if (!isStatusCollapsed) {
        var el = global.$('#status').get(0);
        if (el) {
          el.scrollTop = el.scrollHeight;
        }
      }

      if (persist) {
        writeStorage(PREF_STATUS_COLLAPSED_KEY, isStatusCollapsed ? '1' : '0');
      }
    }

    function updateCreateGraphButtonState() {
      var value = global.$('#dotfile').val();
      var isSameAsVisualized = currentVisualizedInput !== null && value === currentVisualizedInput;
      global.$('#submit').prop('disabled', isSameAsVisualized);
    }

    function markCurrentInputAsVisualized() {
      currentVisualizedInput = global.$('#dotfile').val();
      updateCreateGraphButtonState();
    }

    function applyGraphAppearance() {
      if (!cy) {
        return;
      }
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

    function capturePositionsFromCy() {
      if (!cy) {
        return {};
      }
      var byId = {};
      cy.nodes().forEach(function (node) {
        var p = node.position();
        byId[String(node.id())] = { x: p.x, y: p.y };
      });
      return byId;
    }

    function captureViewportFromCy() {
      if (!cy) {
        return null;
      }
      return {
        zoom: cy.zoom(),
        pan: cy.pan(),
        width: cy.width(),
        height: cy.height()
      };
    }

    function saveViewportState(vp) {
      savedViewport = vp || null;
    }

    function applySavedViewportToCy() {
      if (!cy || !savedViewport) {
        return false;
      }
      if (!Number.isFinite(savedViewport.zoom) || !savedViewport.pan) {
        return false;
      }
      cy.zoom(savedViewport.zoom);
      cy.pan(savedViewport.pan);
      return true;
    }

    function applySavedPositionsToCy() {
      if (!cy || !savedPositions) {
        return false;
      }
      var changed = false;
      cy.nodes().forEach(function (node) {
        var id = String(node.id());
        var p = savedPositions[id];
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
          node.position({ x: p.x, y: p.y });
          changed = true;
        }
      });
      return changed;
    }

    function assignDeterministicPositionsForParsed(parsed) {
      var byId = {};
      if (!parsed || !parsed.elements) {
        return byId;
      }
      var width = DEFAULT_WORLD_WIDTH;
      var height = DEFAULT_WORLD_HEIGHT;
      var margin = 26;
      var xSpan = Math.max(width - margin * 2, 1);
      var ySpan = Math.max(height - margin * 2, 1);
      for (var i = 0; i < parsed.elements.length; i += 1) {
        var el = parsed.elements[i];
        if (!el || !el.data || el.data.source !== undefined || el.data.target !== undefined) {
          continue;
        }
        var id = String(el.data.id);
        byId[id] = {
          x: margin + normalizedHashLocal(id + ':x', 2166136261) * xSpan,
          y: margin + normalizedHashLocal(id + ':y', 33554467) * ySpan
        };
      }
      return byId;
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
        if (!cy) {
          renderStaticSnapshot();
        }
        writeStorage(PREF_VERTEX_SIZE_KEY, graphStylePrefs.vertexSize);
      });

      global.$('#edge-width-slider').on('input change', function () {
        graphStylePrefs.edgeWidth = Number(global.$(this).val()) || DEFAULT_EDGE_WIDTH;
        updateStyleControlsUI();
        applyGraphAppearance();
        if (!cy) {
          renderStaticSnapshot();
        }
        writeStorage(PREF_EDGE_WIDTH_KEY, graphStylePrefs.edgeWidth);
      });
    }

    function smallGraphCoordinatesSuffix() {
      if (!cy) {
        return '';
      }
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

    function graphSizeSuffix() {
      var vertices = 0;
      var edges = 0;
      if (currentParsed && Number.isFinite(currentParsed.nodeCount) && Number.isFinite(currentParsed.edgeCount)) {
        vertices = currentParsed.nodeCount;
        edges = currentParsed.edgeCount;
      } else if (cy) {
        vertices = cy.nodes().length;
        edges = cy.edges().length;
      }
      return ' | size: ' + vertices + 'V, ' + edges + 'E';
    }

    function setLayoutStatus(message, isError) {
      if (isError) {
        setStatus(message, true);
        clearDrawingStats('No plot');
        return;
      }
      setStatus(message + graphSizeSuffix() + smallGraphCoordinatesSuffix(), false);
      if (cy) {
        savedPositions = capturePositionsFromCy();
        saveViewportState(captureViewportFromCy());
        updateFaceAreaPlot();
        updateEdgeLengthPlot();
      }
    }

    function escapeXml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
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

    function buildSvgMarkup(nodePosById, edgePairs, opts) {
      var radius = opts.radius;
      var edgeWidth = opts.edgeWidth;
      var fontSize = opts.fontSize;
      var includeBackground = opts.includeBackground !== false;
      var forcedViewBox = opts.viewBox || null;
      var pad = Math.max(24, radius + 8);
      var nodeIds = Object.keys(nodePosById || {});
      var minX = Infinity;
      var minY = Infinity;
      var maxX = -Infinity;
      var maxY = -Infinity;
      var width = 0;
      var height = 0;
      var offsetX = 0;
      var offsetY = 0;
      var viewBox = '0 0 1 1';

      if (forcedViewBox) {
        minX = Number(forcedViewBox.minX);
        minY = Number(forcedViewBox.minY);
        width = Number(forcedViewBox.width);
        height = Number(forcedViewBox.height);
        if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(width) || !Number.isFinite(height) ||
            width <= 1e-9 || height <= 1e-9) {
          return null;
        }
        viewBox = minX + ' ' + minY + ' ' + width + ' ' + height;
      } else {
        for (var i = 0; i < nodeIds.length; i += 1) {
          var p = nodePosById[nodeIds[i]];
          if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
            continue;
          }
          minX = Math.min(minX, p.x - radius);
          minY = Math.min(minY, p.y - radius);
          maxX = Math.max(maxX, p.x + radius);
          maxY = Math.max(maxY, p.y + radius);
        }

        if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) {
          return null;
        }

        width = Math.max(1, Math.ceil(maxX - minX + 2 * pad));
        height = Math.max(1, Math.ceil(maxY - minY + 2 * pad));
        offsetX = -minX + pad;
        offsetY = -minY + pad;
        viewBox = '0 0 ' + width + ' ' + height;
      }

      var svg = [];
      svg.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="' + viewBox + '">');
      if (includeBackground) {
        svg.push('<rect x="' + minX + '" y="' + minY + '" width="' + width + '" height="' + height + '" fill="#ffffff"/>');
      }
      svg.push('<g id="edges" stroke="' + LOGO_COLORS.black + '" stroke-width="' + edgeWidth + '" fill="none" stroke-linecap="round">');
      for (var j = 0; j < edgePairs.length; j += 1) {
        var u = String(edgePairs[j][0]);
        var v = String(edgePairs[j][1]);
        var pu = nodePosById[u];
        var pv = nodePosById[v];
        if (!pu || !pv) {
          continue;
        }
        svg.push('<line x1="' + (pu.x + offsetX) + '" y1="' + (pu.y + offsetY) + '" x2="' + (pv.x + offsetX) + '" y2="' + (pv.y + offsetY) + '"/>');
      }
      svg.push('</g>');
      svg.push('<g id="nodes">');
      for (var k = 0; k < nodeIds.length; k += 1) {
        var id = nodeIds[k];
        var pn = nodePosById[id];
        if (!pn) {
          continue;
        }
        var x = pn.x + offsetX;
        var y = pn.y + offsetY;
        var label = escapeXml(id);
        svg.push('<circle cx="' + x + '" cy="' + y + '" r="' + radius + '" fill="' + LOGO_COLORS.blue + '" stroke="' + LOGO_COLORS.black + '" stroke-width="0.5"/>');
        svg.push('<text x="' + x + '" y="' + y + '" text-anchor="middle" dominant-baseline="middle" fill="#ffffff" font-size="' + fontSize + '" font-family="Segoe UI, Arial, sans-serif">' + label + '</text>');
      }
      svg.push('</g>');
      svg.push('</svg>');

      return {
        markup: svg.join(''),
        width: width,
        height: height,
        viewBox: viewBox
      };
    }

    function getPlotSize(plotId) {
      var el = global.document.getElementById(plotId);
      var w = el ? Math.max(220, Math.floor(el.clientWidth || el.getBoundingClientRect().width || 220)) : 220;
      var h = 120;
      return { width: w, height: h };
    }

    function getFacePlotSize() {
      return getPlotSize('stats-face-plot');
    }

    function getEdgePlotSize() {
      return getPlotSize('stats-edge-plot');
    }

    function getAnglePlotSize() {
      return getPlotSize('stats-angle-plot');
    }

    function clearPlot(plotId, qualityId, text) {
      var label = text || 'No data';
      var size = getPlotSize(plotId);
      global.$('#' + qualityId).text('--');
      global.$('#' + plotId)
        .attr('viewBox', '0 0 ' + size.width + ' ' + size.height)
        .attr('preserveAspectRatio', 'none')
        .html(
          '<rect x="0" y="0" width="' + size.width + '" height="' + size.height + '" fill="#fbfdff" />' +
          '<text x="' + (size.width / 2) + '" y="' + Math.floor(size.height / 2 + 4) + '" text-anchor="middle" fill="#7b8797" font-size="11">' + escapeXml(label) + '</text>'
        );
    }

    function clearFaceAreaPlot(text) {
      global.$('#stat-is-plane').text('--');
      clearPlot('stats-face-plot', 'stats-face-quality', text);
    }

    function clearEdgeLengthPlot(text) {
      clearPlot('stats-edge-plot', 'stats-edge-quality', text);
      global.$('#stats-edge-ratio').text('--');
    }

    function clearAngleResolutionPlot(text) {
      clearPlot('stats-angle-plot', 'stats-angle-quality', text);
    }

    function clearSpacingUniformity() {
      global.$('#stats-spacing-uniformity').text('--');
    }

    function clearDrawingStats(text) {
      clearFaceAreaPlot(text);
      clearEdgeLengthPlot(text);
      clearAngleResolutionPlot(text);
      clearSpacingUniformity();
    }

    function renderFaceAreaPlot(values, ideal, showLine) {
      var size = getFacePlotSize();
      var W = size.width;
      var H = size.height;
      var L = 36;
      var R = 8;
      var T = 8;
      var B = 20;
      var PW = W - L - R;
      var PH = H - T - B;
      var maxY = 5;
      var safeIdeal = Math.max(ideal, 1e-12);
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
        var normalizedY = values[i] / safeIdeal;
        pts += (i ? ' ' : '') + sx(i) + ',' + sy(Math.min(normalizedY, maxY));
      }

      var yIdeal = sy(1);
      var yMaxLabel = '5';

      var svg = '';
      svg += '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#fbfdff" />';
      svg += '<line x1="' + L + '" y1="' + (T + PH) + '" x2="' + (L + PW) + '" y2="' + (T + PH) + '" stroke="#a8b7cc" stroke-width="1" />';
      svg += '<line x1="' + L + '" y1="' + T + '" x2="' + L + '" y2="' + (T + PH) + '" stroke="#a8b7cc" stroke-width="1" />';
      svg += '<line x1="' + (L - 4) + '" y1="' + T + '" x2="' + (L + 4) + '" y2="' + T + '" stroke="#a8b7cc" stroke-width="1" />';
      svg += '<line x1="' + L + '" y1="' + yIdeal + '" x2="' + (L + PW) + '" y2="' + yIdeal + '" stroke="#ea9624" stroke-width="1" stroke-dasharray="3 3" />';
      if (showLine && values.length >= 1) {
        svg += '<polyline fill="none" stroke="#1060A8" stroke-width="1.5" points="' + pts + '" />';
      }
      var yTickX = L - 4;
      svg += '<text x="' + (yTickX - 3) + '" y="' + T + '" text-anchor="end" dominant-baseline="middle" fill="#5f6c80" font-size="10">' + yMaxLabel + '</text>';
      svg += '<text x="' + yTickX + '" y="' + (T + PH + 11) + '" text-anchor="end" fill="#5f6c80" font-size="10">0</text>';
      svg += '<text x="' + (L - 22) + '" y="' + (T + PH / 2) + '" text-anchor="middle" fill="#5f6c80" font-size="10" transform="rotate(-90 ' + (L - 22) + ' ' + (T + PH / 2) + ')">area</text>';
      svg += '<text x="' + (W - 4) + '" y="' + (H - 4) + '" text-anchor="end" fill="#5f6c80" font-size="10">faces sorted</text>';
      svg += '<text x="' + (L - 4) + '" y="' + yIdeal + '" text-anchor="end" dominant-baseline="middle" fill="#ea9624" font-size="10">ideal</text>';
      global.$('#stats-face-plot')
        .attr('viewBox', '0 0 ' + W + ' ' + H)
        .attr('preserveAspectRatio', 'none')
        .html(svg);
    }

    function renderEdgeLengthPlot(values, ideal) {
      var size = getEdgePlotSize();
      var W = size.width;
      var H = size.height;
      var L = 36;
      var R = 8;
      var T = 8;
      var B = 20;
      var PW = W - L - R;
      var PH = H - T - B;
      var maxY = 5;
      var safeIdeal = Math.max(ideal, 1e-12);
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
        var normalizedY = values[i] / safeIdeal;
        pts += (i ? ' ' : '') + sx(i) + ',' + sy(Math.min(normalizedY, maxY));
      }

      var yIdeal = sy(1);
      var yMaxLabel = '5';

      var svg = '';
      svg += '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#fbfdff" />';
      svg += '<line x1="' + L + '" y1="' + (T + PH) + '" x2="' + (L + PW) + '" y2="' + (T + PH) + '" stroke="#a8b7cc" stroke-width="1" />';
      svg += '<line x1="' + L + '" y1="' + T + '" x2="' + L + '" y2="' + (T + PH) + '" stroke="#a8b7cc" stroke-width="1" />';
      svg += '<line x1="' + (L - 4) + '" y1="' + T + '" x2="' + (L + 4) + '" y2="' + T + '" stroke="#a8b7cc" stroke-width="1" />';
      svg += '<line x1="' + L + '" y1="' + yIdeal + '" x2="' + (L + PW) + '" y2="' + yIdeal + '" stroke="#ea9624" stroke-width="1" stroke-dasharray="3 3" />';
      if (values.length >= 1) {
        svg += '<polyline fill="none" stroke="#1060A8" stroke-width="1.5" points="' + pts + '" />';
      }
      var yTickX = L - 4;
      svg += '<text x="' + (yTickX - 3) + '" y="' + T + '" text-anchor="end" dominant-baseline="middle" fill="#5f6c80" font-size="10">' + yMaxLabel + '</text>';
      svg += '<text x="' + yTickX + '" y="' + (T + PH + 11) + '" text-anchor="end" fill="#5f6c80" font-size="10">0</text>';
      svg += '<text x="' + (L - 22) + '" y="' + (T + PH / 2) + '" text-anchor="middle" fill="#5f6c80" font-size="10" transform="rotate(-90 ' + (L - 22) + ' ' + (T + PH / 2) + ')">length</text>';
      svg += '<text x="' + (W - 4) + '" y="' + (H - 4) + '" text-anchor="end" fill="#5f6c80" font-size="10">edges sorted</text>';
      svg += '<text x="' + (L - 4) + '" y="' + yIdeal + '" text-anchor="end" dominant-baseline="middle" fill="#ea9624" font-size="10">ideal</text>';
      global.$('#stats-edge-plot')
        .attr('viewBox', '0 0 ' + W + ' ' + H)
        .attr('preserveAspectRatio', 'none')
        .html(svg);
    }

    function renderAngleResolutionPlot(values, idealValues) {
      var size = getAnglePlotSize();
      var W = size.width;
      var H = size.height;
      var L = 36;
      var R = 8;
      var T = 8;
      var B = 20;
      var PW = W - L - R;
      var PH = H - T - B;
      var maxY = 5;
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
        var ideal = Math.max(idealValues[i], 1e-12);
        var ratio = values[i] / ideal;
        pts += (i ? ' ' : '') + sx(i) + ',' + sy(Math.min(ratio, maxY));
      }

      var yIdeal = sy(1);
      var yMaxLabel = '5';

      var svg = '';
      svg += '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#fbfdff" />';
      svg += '<line x1="' + L + '" y1="' + (T + PH) + '" x2="' + (L + PW) + '" y2="' + (T + PH) + '" stroke="#a8b7cc" stroke-width="1" />';
      svg += '<line x1="' + L + '" y1="' + T + '" x2="' + L + '" y2="' + (T + PH) + '" stroke="#a8b7cc" stroke-width="1" />';
      svg += '<line x1="' + (L - 4) + '" y1="' + T + '" x2="' + (L + 4) + '" y2="' + T + '" stroke="#a8b7cc" stroke-width="1" />';
      svg += '<line x1="' + L + '" y1="' + yIdeal + '" x2="' + (L + PW) + '" y2="' + yIdeal + '" stroke="#ea9624" stroke-width="1" stroke-dasharray="3 3" />';
      if (values.length >= 1) {
        svg += '<polyline fill="none" stroke="#1060A8" stroke-width="1.5" points="' + pts + '" />';
      }
      var yTickX = L - 4;
      svg += '<text x="' + (yTickX - 3) + '" y="' + T + '" text-anchor="end" dominant-baseline="middle" fill="#5f6c80" font-size="10">' + yMaxLabel + '</text>';
      svg += '<text x="' + yTickX + '" y="' + (T + PH + 11) + '" text-anchor="end" fill="#5f6c80" font-size="10">0</text>';
      svg += '<text x="' + (L - 22) + '" y="' + (T + PH / 2) + '" text-anchor="middle" fill="#5f6c80" font-size="10" transform="rotate(-90 ' + (L - 22) + ' ' + (T + PH / 2) + ')">ratio</text>';
      svg += '<text x="' + (W - 4) + '" y="' + (H - 4) + '" text-anchor="end" fill="#5f6c80" font-size="10">angles sorted</text>';
      svg += '<text x="' + (L - 4) + '" y="' + yIdeal + '" text-anchor="end" dominant-baseline="middle" fill="#ea9624" font-size="10">ideal</text>';
      global.$('#stats-angle-plot')
        .attr('viewBox', '0 0 ' + W + ' ' + H)
        .attr('preserveAspectRatio', 'none')
        .html(svg);
    }

    function getNodeIdsFromParsed(parsed) {
      var ids = [];
      if (!parsed || !parsed.elements) {
        return ids;
      }
      for (var i = 0; i < parsed.elements.length; i += 1) {
        var el = parsed.elements[i];
        if (!el || !el.data) {
          continue;
        }
        if (el.data.source !== undefined || el.data.target !== undefined) {
          continue;
        }
        ids.push(String(el.data.id));
      }
      return ids;
    }

    function setPlaneStat(isPlane) {
      if (isPlane === null || isPlane === undefined) {
        global.$('#stat-is-plane').text('--');
      } else {
        global.$('#stat-is-plane').text(isPlane ? 'yes' : 'no');
      }
    }

    function updateAngleResolutionScore(nodeIds, edgePairs, posById, hasCrossings) {
      if (hasCrossings) {
        clearAngleResolutionPlot('Drawing is not plane');
        return;
      }
      if (!global.PlanarVibeMetrics || !global.PlanarVibeMetrics.computeUniformAngleResolutionScore) {
        clearAngleResolutionPlot('Metrics unavailable');
        return;
      }
      var result = global.PlanarVibeMetrics.computeUniformAngleResolutionScore(nodeIds, edgePairs, posById);
      if (!result || !result.ok || !Number.isFinite(result.score) || !result.values || !result.idealValues) {
        clearAngleResolutionPlot((result && result.reason) ? result.reason : 'No data');
        return;
      }
      global.$('#stats-angle-quality').text(result.score.toFixed(3));
      renderAngleResolutionPlot(result.values, result.idealValues);
    }

    function updateFaceAreaPlot() {
      if (!currentParsed || !currentParsed.elements) {
        clearFaceAreaPlot('No graph');
        clearAngleResolutionPlot('No graph');
        return;
      }
      var edgePairs = edgePairsFromParsed(currentParsed);
      var posById = {};
      var nodeIds = [];
      if (cy) {
        nodeIds = cy.nodes().map(function (node) { return String(node.id()); });
        cy.nodes().forEach(function (node) {
          posById[String(node.id())] = node.position();
        });
      } else {
        nodeIds = getNodeIdsFromParsed(currentParsed);
        posById = savedPositions || {};
      }
      if (!nodeIds.length) {
        clearFaceAreaPlot('No graph');
        clearAngleResolutionPlot('No graph');
        return;
      }

      if (!global.PlanarVibeMetrics || !global.PlanarVibeMetrics.hasCrossingsFromPositions) {
        clearFaceAreaPlot('Metrics unavailable');
        clearAngleResolutionPlot('Metrics unavailable');
        setPlaneStat(null);
        return;
      }
      var hasCrossings = global.PlanarVibeMetrics.hasCrossingsFromPositions(posById, edgePairs);
      setPlaneStat(!hasCrossings);
      updateAngleResolutionScore(nodeIds, edgePairs, posById, hasCrossings);
      if (hasCrossings) {
        clearFaceAreaPlot('Drawing is not plane');
        setPlaneStat(false);
        return;
      }

      if (!global.PlanarVibeMetrics) {
        clearFaceAreaPlot('Metrics unavailable');
        return;
      }
      var result = null;
      if (cy && global.PlanarVibeMetrics.computeUniformFaceAreaScoreFromCy) {
        result = global.PlanarVibeMetrics.computeUniformFaceAreaScoreFromCy(cy, edgePairs);
      } else if (global.PlanarVibeMetrics.computeUniformFaceAreaScore) {
        result = global.PlanarVibeMetrics.computeUniformFaceAreaScore(nodeIds, edgePairs, posById);
      }
      if (!result) {
        clearFaceAreaPlot('Metrics unavailable');
        return;
      }
      if (!result.ok) {
        clearFaceAreaPlot(result.reason || 'No data');
        return;
      }
      renderFaceAreaPlot(result.values, result.ideal, !hasCrossings);
      updateFaceAreaQuality(result.values);
    }

    function updateEdgeLengthPlot() {
      if (!currentParsed || !currentParsed.elements) {
        clearEdgeLengthPlot('No graph');
        clearSpacingUniformity();
        return;
      }
      var edgePairs = edgePairsFromParsed(currentParsed);
      var posById = {};
      var nodeIds = [];
      if (cy) {
        nodeIds = cy.nodes().map(function (node) { return String(node.id()); });
        cy.nodes().forEach(function (node) {
          posById[String(node.id())] = node.position();
        });
      } else {
        nodeIds = getNodeIdsFromParsed(currentParsed);
        posById = savedPositions || {};
      }
      if (!nodeIds.length) {
        clearEdgeLengthPlot('No graph');
        clearSpacingUniformity();
        return;
      }
      if (!global.PlanarVibeMetrics || !global.PlanarVibeMetrics.computeUniformEdgeLengthScore) {
        clearEdgeLengthPlot('Metrics unavailable');
        clearSpacingUniformity();
        return;
      }
      var result = global.PlanarVibeMetrics.computeUniformEdgeLengthScore(edgePairs, posById);
      if (!result.ok) {
        clearEdgeLengthPlot(result.reason || 'No data');
        clearSpacingUniformity();
        return;
      }
      renderEdgeLengthPlot(result.values, result.ideal);
      updateEdgeLengthQuality(result.values);
      updateEdgeLengthRatio(edgePairs, posById);
      updateSpacingUniformity(nodeIds, posById);
    }

    function updateFaceAreaQuality(values) {
      if (!global.PlanarVibeMetrics || !global.PlanarVibeMetrics.computeDistributionQuality) {
        global.$('#stats-face-quality').text('--');
        return;
      }
      var quality = global.PlanarVibeMetrics.computeDistributionQuality(values);
      global.$('#stats-face-quality').text(quality === null ? '--' : quality.toFixed(3));
    }

    function updateEdgeLengthQuality(values) {
      if (!global.PlanarVibeMetrics || !global.PlanarVibeMetrics.computeDistributionQuality) {
        global.$('#stats-edge-quality').text('--');
        return;
      }
      var quality = global.PlanarVibeMetrics.computeDistributionQuality(values);
      global.$('#stats-edge-quality').text(quality === null ? '--' : quality.toFixed(3));
    }

    function updateEdgeLengthRatio(edgePairs, posById) {
      if (!global.PlanarVibeMetrics || !global.PlanarVibeMetrics.computeEdgeLengthRatio) {
        global.$('#stats-edge-ratio').text('--');
        return;
      }
      var ratio = global.PlanarVibeMetrics.computeEdgeLengthRatio(edgePairs, posById);
      if (!ratio || !ratio.ok || !Number.isFinite(ratio.ratio)) {
        global.$('#stats-edge-ratio').text('--');
        return;
      }
      global.$('#stats-edge-ratio').text(ratio.ratio.toFixed(3));
    }

    function updateSpacingUniformity(nodeIds, posById) {
      if (!global.PlanarVibeMetrics || !global.PlanarVibeMetrics.computeSpacingUniformityScore) {
        clearSpacingUniformity();
        return;
      }
      var result = global.PlanarVibeMetrics.computeSpacingUniformityScore(nodeIds, posById);
      if (!result || !result.ok || !Number.isFinite(result.score)) {
        clearSpacingUniformity();
        return;
      }
      global.$('#stats-spacing-uniformity').text(result.score.toFixed(3));
    }

    function renderStaticSnapshot() {
      if (!currentParsed || !currentParsed.elements) {
        global.$('#cy-static-svg').empty();
        return;
      }
      var edgePairs = edgePairsFromParsed(currentParsed);
      var forcedViewBox = null;
      var wrapEl = global.document.getElementById('cy-static-wrap');
      if (savedViewport && wrapEl) {
        var zoom = Number(savedViewport.zoom);
        var pan = savedViewport.pan || {};
        var w = Math.max(1, Number(savedViewport.width) || wrapEl.clientWidth || 0);
        var h = Math.max(1, Number(savedViewport.height) || wrapEl.clientHeight || 0);
        if (Number.isFinite(zoom) && zoom > 1e-9 && Number.isFinite(pan.x) && Number.isFinite(pan.y) && w > 0 && h > 0) {
          forcedViewBox = {
            minX: (-pan.x) / zoom,
            minY: (-pan.y) / zoom,
            width: w / zoom,
            height: h / zoom
          };
        }
      }
      if (!forcedViewBox) {
        forcedViewBox = {
          minX: 0,
          minY: 0,
          width: DEFAULT_WORLD_WIDTH,
          height: DEFAULT_WORLD_HEIGHT
        };
      }
      var snapshot = buildSvgMarkup(savedPositions, edgePairs, {
        radius: graphStylePrefs.vertexSize / 2,
        edgeWidth: graphStylePrefs.edgeWidth,
        fontSize: computeNodeFontSize(graphStylePrefs.vertexSize),
        includeBackground: false,
        viewBox: forcedViewBox
      });
      if (!snapshot) {
        global.$('#cy-static-svg').empty();
        return;
      }
      var inner = snapshot.markup
        .replace(/^<svg[^>]*>/, '')
        .replace(/<\/svg>\s*$/, '');
      global.$('#cy-static-svg')
        .attr('viewBox', snapshot.viewBox)
        .attr('preserveAspectRatio', 'xMidYMid meet')
        .html(inner);
    }

    function setModeUi() {
      global.$('#interactive-toggle').prop('checked', isInteractive);
      global.$('#cy').toggle(isInteractive);
      global.$('#cy-static-wrap').toggle(!isInteractive);
      global.$('.layout-toolbar').show();
      global.$('.style-controls').show();
      global.$('#vertex-size-slider').prop('disabled', false);
      global.$('#vertex-size-control-row').css('opacity', '1');
      global.$('#edge-width-slider').prop('disabled', false);
      global.$('#edge-width-control-row').css('opacity', '1');
      global.$('#reset-zoom-btn').prop('disabled', !isInteractive);
    }

    function setInteractiveMode(nextInteractive, persistPreference, suppressStatus) {
      if (persistPreference === undefined) {
        persistPreference = true;
      }
      if (suppressStatus === undefined) {
        suppressStatus = false;
      }
      if (nextInteractive === isInteractive) {
        return;
      }
      isInteractive = !!nextInteractive;
      if (persistPreference) {
        writeStorage(PREF_INTERACTIVE_KEY, isInteractive ? '1' : '0');
      }

      if (!isInteractive) {
        if (cy) {
          savedPositions = capturePositionsFromCy();
          saveViewportState(captureViewportFromCy());
          cy.destroy();
          cy = null;
        }
        setModeUi();
        renderStaticSnapshot();
        if (!suppressStatus) {
          setStatus('Static mode enabled', false);
        }
        return;
      }

      setModeUi();
      cy = createCyInstance();
      applyGraphAppearance();
      if (currentParsed && currentParsed.elements) {
        cy.add(currentParsed.elements);
        if (!applySavedPositionsToCy()) {
          if (global.PlanarVibeRandom && typeof global.PlanarVibeRandom.applyRandomLayout === 'function') {
            global.PlanarVibeRandom.applyRandomLayout(cy);
          }
          normalizeLayoutScale();
          saveViewportState(captureViewportFromCy());
        } else if (!applySavedViewportToCy()) {
          cy.fit(undefined, 24);
          saveViewportState(captureViewportFromCy());
        }
      }
      updateStatistics(currentParsed);
      updateFaceAreaPlot();
      updateEdgeLengthPlot();
      if (!suppressStatus) {
        setStatus('Interactive mode enabled', false);
      }
    }

    function normalizeLayoutScale() {
      if (!cy) {
        return;
      }
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
      global.$('#stat-vertices').text(String(Number(s.vertexCount) || 0));
      global.$('#stat-edges').text(String(Number(s.edgeCount) || 0));
      global.$('#stat-is-planar').prop('checked', !!s.isPlanar).prop('disabled', true);
      global.$('#stat-is-bipartite').prop('checked', !!s.isBipartite).prop('disabled', true);
      global.$('#stat-is-planar-3-tree').prop('checked', !!s.isPlanar3Tree).prop('disabled', true);
    }

    function setLayoutEnabled(layoutName, isEnabled) {
      var $btn = global.$('.layout-btn[data-layout="' + layoutName + '"]');
      $btn.prop('disabled', !isEnabled);
      if (!isEnabled) {
        $btn.removeClass('is-active');
      }
    }

    function setTutteEnabled(isEnabled) {
      setLayoutEnabled('tutte', isEnabled);
    }

    function setCEG23BfsEnabled(isEnabled) {
      setLayoutEnabled('ceg23-bfs', isEnabled);
    }

    function setCEG23XyEnabled(isEnabled) {
      setLayoutEnabled('ceg23-xy', isEnabled);
    }

    function setP3TEnabled(isEnabled) {
      setLayoutEnabled('p3t', isEnabled);
    }

    function setFPPEnabled(isEnabled) {
      setLayoutEnabled('fpp', isEnabled);
    }

    function setReweightTutteEnabled(isEnabled) {
      setLayoutEnabled('reweighttutte', isEnabled);
    }

    function setPlanarButtonsDisabled() {
      setTutteEnabled(false);
      setCEG23BfsEnabled(false);
      setCEG23XyEnabled(false);
      setP3TEnabled(false);
      setFPPEnabled(false);
      setReweightTutteEnabled(false);
    }

    function updateStatistics(parsed) {
      if (!cy) {
        setStatistics({ vertexCount: 0, edgeCount: 0, isPlanar: false, isBipartite: false, isPlanar3Tree: false });
        clearDrawingStats('Graph hidden');
        setPlanarButtonsDisabled();
        return;
      }
      if (!parsed || !parsed.elements) {
        setStatistics({ vertexCount: 0, edgeCount: 0, isPlanar: false, isBipartite: false, isPlanar3Tree: false });
        clearDrawingStats('No graph');
        setPlanarButtonsDisabled();
        return;
      }
      if (!global.PlanarVibePlanarityTest || !global.PlanarVibePlanarityTest.computePlanarEmbedding) {
        setStatistics({ vertexCount: cy.nodes().length, edgeCount: edgePairsFromParsed(parsed).length, isPlanar: false, isBipartite: false, isPlanar3Tree: false });
        clearDrawingStats('No plot');
        setPlanarButtonsDisabled();
        return;
      }
      var nodeIds = cy.nodes().map(function (node) { return String(node.id()); });
      var edgePairs = edgePairsFromParsed(parsed);
      var embedding = global.PlanarVibePlanarityTest.computePlanarEmbedding(nodeIds, edgePairs);
      var isPlanar = !!(embedding && embedding.ok);
      var isBipartite = !!(global.PlanarVibeMetrics && global.PlanarVibeMetrics.isBipartiteGraph &&
        global.PlanarVibeMetrics.isBipartiteGraph(nodeIds, edgePairs));
      var isPlanar3Tree = false;
      if (isPlanar && global.PlanarVibePlanarityTest.isPlanar3Tree) {
        isPlanar3Tree = !!global.PlanarVibePlanarityTest.isPlanar3Tree(nodeIds, edgePairs);
      }
      setStatistics({
        vertexCount: nodeIds.length,
        edgeCount: edgePairs.length,
        isPlanar: isPlanar,
        isBipartite: isBipartite,
        isPlanar3Tree: isPlanar3Tree
      });
      setTutteEnabled(isPlanar);
      setCEG23BfsEnabled(isPlanar);
      setCEG23XyEnabled(isPlanar);
      setP3TEnabled(isPlanar3Tree);
      setFPPEnabled(isPlanar);
      setReweightTutteEnabled(isPlanar);
    }

    function drawGraph() {
      try {
        currentParsed = global.PlanarVibePlugin.parseEdgeList(global.$('#dotfile').val());

        function applyParsedPositionsIfAny() {
          if (!currentParsed || !currentParsed.hasExplicitPositions) {
            return false;
          }
          var fallback = assignDeterministicPositionsForParsed(currentParsed);
          cy.nodes().forEach(function (node) {
            var id = String(node.id());
            var p = currentParsed.positionsById && currentParsed.positionsById[id];
            if (!p) {
              p = fallback[id];
            }
            if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
              node.position({ x: p.x, y: p.y });
            }
          });
          normalizeLayoutScale();
          setLayoutStatus('Applied input coordinates', false);
          return true;
        }

        if (!cy) {
          setInteractiveMode(true, false, true);
          cy.elements().remove();
          cy.add(currentParsed.elements);
          savedPositions = {};
          saveViewportState(null);
          updateStatistics(currentParsed);
          if (!applyParsedPositionsIfAny()) {
            applyLayout('random');
          }
          setInteractiveMode(false, false, true);
          markCurrentInputAsVisualized();
          setStatus('Graph rendered in static mode', false);
          return;
        }
        cy.elements().remove();
        cy.add(currentParsed.elements);
        savedPositions = {};
        saveViewportState(null);
        updateStatistics(currentParsed);
        if (!applyParsedPositionsIfAny()) {
          applyLayout('random');
        }
        markCurrentInputAsVisualized();
        setStatus('Drawn ' + currentParsed.nodeCount + ' nodes and ' + currentParsed.edgeCount + ' edges', false);
      } catch (error) {
        setStatistics({ vertexCount: 0, edgeCount: 0, isPlanar: false, isBipartite: false, isPlanar3Tree: false });
        clearDrawingStats('Parse error');
        setPlanarButtonsDisabled();
        updateCreateGraphButtonState();
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

    function pasteStaticGraph(name, displayName) {
      var sampleGraph = global.PlanarVibeGraphGenerator.getSample(name);
      if (!sampleGraph) {
        setStatus('Unknown sample: ' + name, true);
        return;
      }

      // Keep sample selects in sync with the currently loaded sample.
      var sampleSelectIds = [
        '#sample-main-select',
        '#sample-nonplanar-select',
        '#sample-misc-select',
        '#sample-3tree-select',
        '#sample-grid-select',
        '#sample-random-planar-select'
      ];
      for (var i = 0; i < sampleSelectIds.length; i += 1) {
        var $select = global.$(sampleSelectIds[i]);
        if (!$select.length) {
          continue;
        }
        if ($select.find('option[value="' + String(name) + '"]').length > 0) {
          $select.val(String(name));
        } else {
          $select.prop('selectedIndex', 0);
        }
        $select.toggleClass('is-default', String($select.val() || '') === '');
      }

      if (displayName) {
        setStatus('Loaded sample: ' + String(displayName), false);
      }
      global.$('#dotfile').val(sampleGraph);
      drawGraph();
    }

    function applyLayout(layoutName, options) {
      var opts = options || {};
      var temporaryStaticRun = !!opts.temporaryStaticRun;
      if (!cy) {
        if (!currentParsed || !currentParsed.elements) {
          setStatus('Load a graph first', true);
          return;
        }
        setInteractiveMode(true, false, true);
        applyLayout(layoutName, { temporaryStaticRun: true });
        return;
      }
      if (cy.nodes().length === 0) {
        return;
      }
      setSelectedLayoutButton(layoutName);

      if (layoutName === 'random') {
        if (!global.PlanarVibeRandom || typeof global.PlanarVibeRandom.applyRandomLayout !== 'function') {
          setStatus('Random layout module is missing', true);
          return;
        }
        global.PlanarVibeRandom.applyRandomLayout(cy);
        normalizeLayoutScale();
        setLayoutStatus('Applied random coordinates', false);
        if (temporaryStaticRun) {
          setInteractiveMode(false, false, true);
        }
        return;
      }

      if (layoutName === 'tutte') {
        runSpecialLayout({
          layoutName: 'tutte',
          disabledMessage: 'Tutte layout requires a planar graph',
          missingMessage: 'Tutte layout module is missing',
          module: global.PlanarVibeTutte,
          methodName: 'applyTutteLayout'
        }, function () {
          if (temporaryStaticRun) {
            setInteractiveMode(false, false, true);
          }
        });
        return;
      }

      if (layoutName === 'ceg23-bfs') {
        runSpecialLayout({
          layoutName: 'ceg23-bfs',
          disabledMessage: 'CEG23-bfs layout requires a planar graph',
          missingMessage: 'CEG23-bfs layout module is missing',
          module: global.PlanarVibeCEG23Bfs,
          methodName: 'applyCEG23BfsLayout'
        }, function () {
          if (temporaryStaticRun) {
            setInteractiveMode(false, false, true);
          }
        });
        return;
      }

      if (layoutName === 'ceg23-xy') {
        runSpecialLayout({
          layoutName: 'ceg23-xy',
          disabledMessage: 'CEG23-xy layout requires a planar graph',
          missingMessage: 'CEG23-xy layout module is missing',
          module: global.PlanarVibeCEG23Xy,
          methodName: 'applyCEG23XyLayout'
        }, function () {
          if (temporaryStaticRun) {
            setInteractiveMode(false, false, true);
          }
        });
        return;
      }

      if (layoutName === 'p3t') {
        runSpecialLayout({
          layoutName: 'p3t',
          disabledMessage: 'P3T layout requires a planar 3-tree',
          missingMessage: 'P3T layout module is missing',
          module: global.PlanarVibeP3T,
          methodName: 'applyP3TLayout'
        }, function () {
          if (temporaryStaticRun) {
            setInteractiveMode(false, false, true);
          }
        });
        return;
      }

      if (layoutName === 'fpp') {
        runSpecialLayout({
          layoutName: 'fpp',
          disabledMessage: 'FPP layout requires a planar graph',
          missingMessage: 'FPP layout module is missing',
          module: global.PlanarVibeFPP,
          methodName: 'applyFPPLayout'
        }, function () {
          if (temporaryStaticRun) {
            setInteractiveMode(false, false, true);
          }
        });
        return;
      }

      if (layoutName === 'reweighttutte') {
        normalizeLayoutScale();
        runSpecialLayout({
          layoutName: 'reweighttutte',
          disabledMessage: 'ReweightTutte layout requires a planar graph',
          missingMessage: 'ReweightTutte layout module is missing',
          module: global.PlanarVibeReweightTutte,
          methodName: 'applyReweightTutteLayout',
          buildMethodOptions: function () {
            return {
              onIteration: function (progress) {
                if (!progress) {
                  return;
                }
                var parts = [];
                parts.push('Reweight step ' + progress.iter + '/' + progress.maxIters);
                if (Number.isFinite(progress.faceAreaScore)) {
                  parts.push('face score ' + progress.faceAreaScore.toFixed(3));
                }
                if (Number.isFinite(progress.faceAreaMinRatio) && Number.isFinite(progress.faceAreaMaxRatio)) {
                  parts.push('area ratio min/avg ' + progress.faceAreaMinRatio.toFixed(2) + ', max/avg ' + progress.faceAreaMaxRatio.toFixed(2));
                }
                if (Number.isFinite(progress.boundedFaceCount)) {
                  parts.push('faces ' + progress.boundedFaceCount);
                }
                setStatus(parts.join(' | '), false);
              }
            };
          },
          normalizeOnSuccess: false,
          disableOtherButtonsWhileRunning: true
        }, function () {
          if (temporaryStaticRun) {
            setInteractiveMode(false, false, true);
          }
        });
        return;
      }

      var layout = cy.layout(global.PlanarVibePlugin.layoutOptionsByName(layoutName, currentParsed));
      if (layout && layout.one) {
        layout.one('layoutstop', function () {
          normalizeLayoutScale();
          setLayoutStatus('Applied ' + layoutName + ' layout', false);
          if (temporaryStaticRun) {
            setInteractiveMode(false, false, true);
          }
        });
      } else {
        setTimeout(function () {
          normalizeLayoutScale();
          setLayoutStatus('Applied ' + layoutName + ' layout', false);
          if (temporaryStaticRun) {
            setInteractiveMode(false, false, true);
          }
        }, 0);
      }
      layout.run();
    }

    function runSpecialLayout(config, onDone) {
      var name = config.layoutName;
      var shouldNormalizeOnSuccess = config.normalizeOnSuccess !== false;
      var shouldDisableOthers = !!config.disableOtherButtonsWhileRunning;
      if (global.$('.layout-btn[data-layout="' + name + '"]').prop('disabled')) {
        setStatus(config.disabledMessage, true);
        if (typeof onDone === 'function') onDone();
        return;
      }
      if (!config.module || typeof config.module[config.methodName] !== 'function') {
        setStatus(config.missingMessage, true);
        if (typeof onDone === 'function') onDone();
        return;
      }
      if (shouldDisableOthers) {
        enterLayoutBusy(name);
      }
      var methodOptions = null;
      if (typeof config.buildMethodOptions === 'function') {
        methodOptions = config.buildMethodOptions();
      }
      if (!methodOptions) {
        methodOptions = {};
      }

      var result = config.module[config.methodName](cy, methodOptions);
      if (result && typeof result.then === 'function') {
        result.then(function (resolved) {
          if (resolved && resolved.ok && shouldNormalizeOnSuccess) {
            normalizeLayoutScale();
          }
          setLayoutStatus(resolved && resolved.message ? resolved.message : ('Applied ' + name + ' layout'), !(resolved && resolved.ok));
          if (shouldDisableOthers) {
            restoreLayoutBusy();
          }
          if (typeof onDone === 'function') onDone();
        }).catch(function (err) {
          setLayoutStatus((err && err.message) ? err.message : ('Failed ' + name + ' layout'), true);
          if (shouldDisableOthers) {
            restoreLayoutBusy();
          }
          if (typeof onDone === 'function') onDone();
        });
        return;
      }
      if (result && result.ok && shouldNormalizeOnSuccess) {
        normalizeLayoutScale();
      }
      setLayoutStatus(result && result.message ? result.message : ('Applied ' + name + ' layout'), !(result && result.ok));
      if (shouldDisableOthers) {
        restoreLayoutBusy();
      }
      if (typeof onDone === 'function') onDone();
    }

    function setSelectedLayoutButton(layoutName) {
      global.$('.layout-btn').removeClass('is-active');
      global.$('.layout-btn[data-layout="' + layoutName + '"]').addClass('is-active');
    }

    function enterLayoutBusy(activeLayoutName) {
      var snapshot = [];
      global.$('.layout-btn').each(function () {
        var $btn = global.$(this);
        var name = String($btn.data('layout') || '');
        snapshot.push({ name: name, disabled: !!$btn.prop('disabled') });
        if (name !== activeLayoutName) {
          $btn.prop('disabled', true);
        }
      });
      layoutBusyState = snapshot;
    }

    function restoreLayoutBusy() {
      if (!layoutBusyState) {
        return;
      }
      for (var i = 0; i < layoutBusyState.length; i += 1) {
        var item = layoutBusyState[i];
        global.$('.layout-btn[data-layout="' + item.name + '"]').prop('disabled', !!item.disabled);
      }
      layoutBusyState = null;
    }

    function resetZoom() {
      if (!cy) {
        return;
      }
      if (cy.nodes().length === 0) {
        return;
      }
      cy.fit(undefined, 20);
      cy.center();
      saveViewportState(captureViewportFromCy());
      setStatus('Zoom reset', false);
    }

    function exportSvg() {
      if (!cy) {
        var staticMarkup = String(global.$('#cy-static-svg').html() || '').trim();
        if (!staticMarkup) {
          setStatus('Nothing to export', true);
          return;
        }
        var staticViewBox = global.$('#cy-static-svg').attr('viewBox') || '0 0 1000 700';
        var staticSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + staticViewBox + '">' + staticMarkup + '</svg>';
        var staticBlob = new Blob([staticSvg], { type: 'image/svg+xml;charset=utf-8' });
        var staticUrl = URL.createObjectURL(staticBlob);
        var staticLink = global.document.createElement('a');
        staticLink.href = staticUrl;
        staticLink.download = 'planarvibe-drawing.svg';
        global.document.body.appendChild(staticLink);
        staticLink.click();
        global.document.body.removeChild(staticLink);
        URL.revokeObjectURL(staticUrl);
        setStatus('Saved SVG', false);
        return;
      }
      var nodes = cy.nodes();
      if (!nodes || nodes.length === 0) {
        setStatus('Nothing to export', true);
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
        setStatus('Cannot export: invalid node positions', true);
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
      setStatus('Saved SVG', false);
    }

    function showDrawingMetricPlot(targetId) {
      var ids = ['stats-angle-plot-wrap', 'stats-face-plot-wrap', 'stats-edge-plot-wrap'];
      var $target = global.$('#' + targetId);
      var targetIsVisible = $target.length && !$target.hasClass('is-hidden');

      if (targetIsVisible) {
        for (var j = 0; j < ids.length; j += 1) {
          global.$('#' + ids[j]).addClass('is-hidden');
        }
        return;
      }

      for (var i = 0; i < ids.length; i += 1) {
        var id = ids[i];
        var $el = global.$('#' + id);
        if (!$el.length) {
          continue;
        }
        $el.toggleClass('is-hidden', id !== targetId);
      }
    }

    function bindUiEvents() {
      var sampleSelectIds = [
        '#sample-main-select',
        '#sample-nonplanar-select',
        '#sample-misc-select',
        '#sample-3tree-select',
        '#sample-grid-select',
        '#sample-random-planar-select'
      ];

      function updateSampleSelectVisualState($select) {
        if (!$select || !$select.length) {
          return;
        }
        var isDefault = String($select.val() || '') === '';
        $select.toggleClass('is-default', isDefault);
      }

      function bindSampleSelect(selectId) {
        global.$(selectId).on('change', function () {
          var $select = global.$(this);
          updateSampleSelectVisualState($select);
          var sampleName = String($select.val() || '');
          if (!sampleName) {
            return;
          }
          for (var i = 0; i < sampleSelectIds.length; i += 1) {
            var otherId = sampleSelectIds[i];
            if (otherId === selectId) {
              continue;
            }
            var $other = global.$(otherId);
            if ($other.length) {
              $other.prop('selectedIndex', 0);
              updateSampleSelectVisualState($other);
            }
          }
          var groupLabel = String($select.find('option:first').text() || 'Sample').trim();
          var optionLabel = String($select.find('option:selected').text() || sampleName).trim();
          pasteStaticGraph(sampleName, groupLabel + ' / ' + optionLabel);
        });
      }

      global.$('#graph-form').on('submit', function (event) {
        event.preventDefault();
        checkTextArea();
      });

      global.$('#dotfile').on('input change', function () {
        updateCreateGraphButtonState();
      });

      global.$('.sample-link').on('click', function (event) {
        event.preventDefault();
        var sampleName = global.$(this).data('sample');
        if (sampleName) {
          pasteStaticGraph(String(sampleName));
        }
      });

      for (var s = 0; s < sampleSelectIds.length; s += 1) {
        bindSampleSelect(sampleSelectIds[s]);
        updateSampleSelectVisualState(global.$(sampleSelectIds[s]));
      }

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

      global.$('#interactive-toggle').on('change', function () {
        setInteractiveMode(global.$(this).is(':checked'));
      });

      global.$('.drawing-metric-link').on('click', function (event) {
        event.preventDefault();
        var target = global.$(this).data('target');
        if (target) {
          showDrawingMetricPlot(String(target));
        }
      });

      global.$('#status-collapse-btn').on('click', function () {
        setStatusPanelCollapsed(!isStatusCollapsed, true);
      });

      global.$('#status-clear-btn').on('click', function () {
        global.$('#status').empty();
      });
    }

    bindUiEvents();
    initStyleControls();
    setStatusPanelCollapsed(isStatusCollapsed, false);

    clearDrawingStats(isInteractive ? 'No graph' : 'Static mode');
    pasteStaticGraph(global.PlanarVibeGraphGenerator.defaultSample);

    if (!isInteractive && cy) {
      savedPositions = capturePositionsFromCy();
      saveViewportState(captureViewportFromCy());
      cy.destroy();
      cy = null;
      renderStaticSnapshot();
      setStatus('Static mode enabled', false);
    }

    updateCreateGraphButtonState();

    setModeUi();

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

})(window);
