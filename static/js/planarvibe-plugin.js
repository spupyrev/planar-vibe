(function (global) {
  'use strict';

  // Browser application controller for the PlanarVibe UI, including input
  // handling, visualization state, status reporting, and algorithm dispatch.

  var viewportDefaults = global.PlanarVibeViewportDefaults || {};
  if (!Number.isFinite(viewportDefaults.width)) {
    viewportDefaults.width = 900;
  }
  if (!Number.isFinite(viewportDefaults.height)) {
    viewportDefaults.height = 620;
  }
  global.PlanarVibeViewportDefaults = viewportDefaults;

  function parseEdgeList(input) {
    var lines = String(input || '').split(/\r?\n/);
    var nodes = new Set();
    var edges = [];
    var edgeKeys = new Set();
    var positionsById = {};
    var labelsById = {};
    var classesById = {};
    var hasExplicitPositions = false;

    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i].trim();
      if (!line || line.charAt(0) === '#') {
        continue;
      }

      var parts = line.split(/\s+/);
      if (parts[0] === 'v' || parts[0] === 'V') {
        if (parts.length < 4) {
          throw new Error('Invalid line ' + (i + 1) + ': expected "v id x y [label] [class]".');
        }
        var vertexId = parts[1];
        var x = Number(parts[2]);
        var y = Number(parts[3]);
        if (!vertexId || !Number.isFinite(x) || !Number.isFinite(y)) {
          throw new Error('Invalid line ' + (i + 1) + ': expected finite coordinates in "v id x y [label] [class]".');
        }
        nodes.add(vertexId);
        positionsById[vertexId] = { x: x, y: y };
        labelsById[vertexId] = parts.length >= 5 ? parts[4] : vertexId;
        classesById[vertexId] = parts.length >= 6 ? parts[5] : '';
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
      var nodeEl = {
        data: {
          id: id,
          label: labelsById[id] !== undefined ? labelsById[id] : id
        }
      };
      if (classesById[id]) {
        nodeEl.classes = classesById[id];
      }
      nodeElements.push(nodeEl);
    });

    var parsedOuterFace = null;
    if (hasExplicitPositions) {
      var edgePairs = edges.map(function (edge) {
        return [String(edge.data.source), String(edge.data.target)];
      });
      var embedding = global.PlanarGraphUtils.extractEmbeddingFromPositions(
        nodeElements.map(function (nodeEl) { return String(nodeEl.data.id); }),
        edgePairs,
        positionsById
      );
      if (embedding && embedding.ok && Array.isArray(embedding.outerFace) && embedding.outerFace.length >= 3) {
        parsedOuterFace = embedding.outerFace.slice().map(String);
      }
    }

    return {
      elements: nodeElements.concat(edges),
      nodeCount: nodeElements.length,
      edgeCount: edges.length,
      outerFace: parsedOuterFace,
      positionsById: positionsById,
      labelsById: labelsById,
      classesById: classesById,
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

  global.PlanarVibePlugin = {
    parseEdgeList: parseEdgeList,
    layoutOptions: layoutOptions,
    viewportDefaults: global.PlanarVibeViewportDefaults
  };

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
    var DEFAULT_VERTEX_SIZE = 6;
    var DEFAULT_EDGE_WIDTH = 0.75;
    var DEFAULT_WORLD_WIDTH = global.PlanarVibeViewportDefaults.width;
    var DEFAULT_WORLD_HEIGHT = global.PlanarVibeViewportDefaults.height;
    var DRAWING_TOP_CLEARANCE_PX = 28;
    var PREF_VERTEX_SIZE_KEY = 'planarvibe_vertex_size';
    var PREF_EDGE_WIDTH_KEY = 'planarvibe_edge_width';
    var PREF_INTERACTIVE_KEY = 'planarvibe_interactive_mode';
    var PREF_STATUS_COLLAPSED_KEY = 'planarvibe_status_collapsed';

    function sharedLayoutMethodOptions(overrides) {
      return Object.assign(
        {},
        { augmentationMethod: 'outer-cycle' },
        overrides || {}
      );
    }

    function readStorage(name) {
      try {
        if (global.localStorage) {
          return global.localStorage.getItem(name);
        }
      } catch (e) {}
      return null;
    }

    function writeStorage(name, value) {
      try {
        if (global.localStorage) {
          global.localStorage.setItem(name, String(value));
        }
      } catch (e) {}
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
    var isInteractive = readStorage(PREF_INTERACTIVE_KEY) === '1';
    var isStatusCollapsed = readStorage(PREF_STATUS_COLLAPSED_KEY) === '1';
    var currentPositionsCache = {};
    var savedViewport = null;
    var currentVisualizedInput = null;
    var layoutBusyState = null;
    var showDebugAugmentation = false;
    var currentDebugState = null;

    function computeNodeFontSize(vertexSize) {
      return Math.max(4, Math.round(vertexSize * 0.9));
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
        autoungrabify: false,
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
            selector: 'node.dummy-node',
            style: {
              'background-color': '#7a1f1f',
              'border-color': '#3d0d0d'
            }
          },
          {
            selector: 'edge',
            style: {
              'line-color': LOGO_COLORS.black,
              'width': graphStylePrefs.edgeWidth,
              'curve-style': 'straight'
            }
          },
          {
            selector: 'edge.debug-overlay',
            style: {
              'line-color': '#7a1f1f',
              'line-style': 'dashed'
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
      var text = String(message || '');
      var $entry = global.$('<div class="status-entry"></div>').text(text);
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

    function collectStatusText() {
      var $status = global.$('#status');
      if (!$status.length) {
        return '';
      }
      var lines = [];
      $status.children('.status-entry').each(function () {
        lines.push(global.$(this).text());
      });
      return lines.join('\n');
    }

    async function copyStatusToClipboard() {
      var text = collectStatusText();
      if (!text) {
        setStatus('Status bar is empty', true);
        return false;
      }

      try {
        if (global.navigator && global.navigator.clipboard && typeof global.navigator.clipboard.writeText === 'function') {
          await global.navigator.clipboard.writeText(text);
          setStatus('Copied status bar to clipboard', false);
          return true;
        }
      } catch (err) {
        // Fall through to execCommand fallback.
      }

      var textarea = global.document ? global.document.createElement('textarea') : null;
      if (!textarea || !global.document || !global.document.body) {
        setStatus('Clipboard copy is unavailable', true);
        return false;
      }

      textarea.value = text;
      textarea.setAttribute('readonly', 'readonly');
      textarea.style.position = 'fixed';
      textarea.style.top = '-1000px';
      textarea.style.left = '-1000px';
      global.document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();

      var copied = false;
      try {
        copied = !!(global.document.execCommand && global.document.execCommand('copy'));
      } catch (err2) {
        copied = false;
      }
      global.document.body.removeChild(textarea);

      if (copied) {
        setStatus('Copied status bar to clipboard', false);
        return true;
      }

      setStatus('Clipboard copy failed', true);
      return false;
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

    function isDebugOverlayNode(node) {
      return !!(node && typeof node.hasClass === 'function' && node.hasClass('debug-overlay'));
    }

    function saveViewportState(vp) {
      savedViewport = vp || null;
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
          x: margin + global.GraphUtils.normalizedHash(id + ':x', 2166136261) * xSpan,
          y: margin + global.GraphUtils.normalizedHash(id + ':y', 33554467) * ySpan
        };
      }
      return byId;
    }

    function applyDeterministicPositionsToCy(parsed) {
      if (!cy || !parsed || !parsed.elements) {
        return false;
      }
      var positions = assignDeterministicPositionsForParsed(parsed);
      cy.nodes().forEach(function (node) {
        var id = String(node.id());
        var p = positions[id];
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
          node.position({ x: p.x, y: p.y });
        }
      });
      setCurrentPositions(positions);
      fitCurrentDrawingViewport();
      return true;
    }

    function setCurrentPositions(posById) {
      currentPositionsCache = global.GeometryUtils.copyPositionMap(posById || {});
      return currentPositionsCache;
    }

    function getCurrentPositions() {
      if (cy) {
        return global.CyRuntime.currentPositionsFromCy(cy);
      }
      if (Object.keys(currentPositionsCache).length > 0) {
        return global.GeometryUtils.copyPositionMap(currentPositionsCache);
      }
      if (currentParsed && currentParsed.hasExplicitPositions && currentParsed.positionsById) {
        return global.GeometryUtils.copyPositionMap(currentParsed.positionsById);
      }
      return assignDeterministicPositionsForParsed(currentParsed);
    }

    function applyPositionMapToCurrentDrawing(posById) {
      if (cy) {
        global.CyRuntime.applyPositionsToCy(cy, posById);
        setCurrentPositions(global.CyRuntime.currentPositionsFromCy(cy));
        saveViewportState(global.CyRuntime.captureViewportFromCy(cy));
        return;
      }
      setCurrentPositions(posById);
      renderStaticSnapshot();
    }

    function buildDebugOverlayData() {
      var debug = currentDebugState;
      if (!showDebugAugmentation || !debug) {
        return null;
      }
      var dummyIds = Array.isArray(debug.dummyIds) ? debug.dummyIds.map(String) : [];
      var dummyPositionsById = debug.dummyPositionsById || {};
      var dummyLabelById = debug.dummyLabelById || {};
      var renderIdByDummyId = {};
      var labelsById = {};
      var classesById = {};
      var positionsById = {};
      var edgePairs = [];
      var edgeClassByKey = {};
      var i;

      for (i = 0; i < dummyIds.length; i += 1) {
        var dummyId = String(dummyIds[i]);
        var renderId = '__dbg__' + dummyId;
        renderIdByDummyId[dummyId] = renderId;
        labelsById[renderId] = dummyLabelById[dummyId] !== undefined ? String(dummyLabelById[dummyId]) : dummyId;
        classesById[renderId] = 'dummy-node debug-overlay';
        if (dummyPositionsById[dummyId] && Number.isFinite(dummyPositionsById[dummyId].x) && Number.isFinite(dummyPositionsById[dummyId].y)) {
          positionsById[renderId] = {
            x: dummyPositionsById[dummyId].x,
            y: dummyPositionsById[dummyId].y
          };
        }
      }

      var addedEdgePairs = Array.isArray(debug.addedEdgePairs) ? debug.addedEdgePairs : [];
      for (i = 0; i < addedEdgePairs.length; i += 1) {
        var u = String(addedEdgePairs[i][0]);
        var v = String(addedEdgePairs[i][1]);
        var ru = renderIdByDummyId[u] || u;
        var rv = renderIdByDummyId[v] || v;
        edgePairs.push([ru, rv]);
        edgeClassByKey[global.GraphUtils.edgeKey(ru, rv)] = 'debug-overlay';
      }

      return {
        positionsById: positionsById,
        labelsById: labelsById,
        classesById: classesById,
        edgePairs: edgePairs,
        edgeClassByKey: edgeClassByKey
      };
    }

    function setCurrentDebugState(debugState) {
      currentDebugState = debugState || null;
      if (cy) {
        global.CyRuntime.syncOverlayInCy(cy, buildDebugOverlayData());
      } else {
        renderStaticSnapshot();
      }
    }

    function clearCurrentDebugState() {
      setCurrentDebugState(null);
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
        setCurrentPositions(global.CyRuntime.currentPositionsFromCy(cy));
        saveViewportState(global.CyRuntime.captureViewportFromCy(cy));
        updateFaceAreaPlot();
        updateEdgeLengthPlot();
      }
    }

    function progressDebug(progress) {
      return (progress && progress.debug) ? progress.debug : {};
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
      var labelsById = opts.labelsById || {};
      var classesById = opts.classesById || {};
      var edgeClassByKey = opts.edgeClassByKey || {};
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
        var edgeClass = String(edgeClassByKey[global.GraphUtils.edgeKey(u, v)] || '');
        var isDebugEdge = edgeClass.indexOf('debug-overlay') !== -1;
        svg.push(
          '<line x1="' + (pu.x + offsetX) + '" y1="' + (pu.y + offsetY) + '" x2="' + (pv.x + offsetX) + '" y2="' + (pv.y + offsetY) + '"' +
          ' stroke="' + (isDebugEdge ? '#7a1f1f' : LOGO_COLORS.black) + '"' +
          ' stroke-dasharray="' + (isDebugEdge ? '4 3' : 'none') + '"/>'
        );
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
        var label = escapeXml(
          labelsById[id] !== undefined
            ? labelsById[id]
            : id
        );
        var nodeClass = String(classesById[id] || '');
        var fill = nodeClass.indexOf('dummy-node') !== -1 ? '#7a1f1f' : LOGO_COLORS.blue;
        var stroke = nodeClass.indexOf('dummy-node') !== -1 ? '#3d0d0d' : LOGO_COLORS.black;
        svg.push('<circle cx="' + x + '" cy="' + y + '" r="' + radius + '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="0.5"/>');
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
      global.$('#stats-convexity').text('--');
      clearPlot('stats-face-plot', 'stats-face-quality', text);
    }

    function clearEdgeMetrics() {
      global.$('#stats-edge-ratio').text('--');
      global.$('#stats-edge-deviation').text('--');
      global.$('#stats-edge-orthogonality').text('--');
      global.$('#stats-aspect-ratio').text('--');
      global.$('#stats-node-uniformity').text('--');
    }

    function clearAngleResolutionPlot(text) {
      clearPlot('stats-angle-plot', 'stats-angle-quality', text);
    }

    function clearDrawingStats(text) {
      clearFaceAreaPlot(text);
      clearAngleResolutionPlot(text);
      clearEdgeMetrics();
      global.$('#stats-overall-score').text('--');
      global.$('#stats-spacing-uniformity').text('--');
      global.$('#stats-axis-alignment').text('--');
      setAlignEnabled(false);
    }

    function renderLinePlot(plotId, options) {
      var opts = options || {};
      var values = Array.isArray(opts.values) ? opts.values : [];
      var maxY = opts.maxY;
      var size = getPlotSize(plotId);
      var W = size.width;
      var H = size.height;
      var L = 36;
      var T = 8;
      var R = 8;
      var B = 20;
      var PW = W - L - R;
      var PH = H - T - B;

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
      for (var i = 0; i < values.length; i += 1) {
        var yValue = typeof opts.valueAt === 'function' ? opts.valueAt(i, values[i]) : values[i];
        if (opts.clampMin !== false) {
          yValue = Math.max(0, yValue);
        }
        pts += (i ? ' ' : '') + sx(i) + ',' + sy(Math.min(yValue, maxY));
      }

      var yIdeal = sy(1);
      var yMaxLabel = String(maxY);

      var svg = '';
      svg += '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#fbfdff" />';
      svg += '<line x1="' + L + '" y1="' + (T + PH) + '" x2="' + (L + PW) + '" y2="' + (T + PH) + '" stroke="#a8b7cc" stroke-width="1" />';
      svg += '<line x1="' + L + '" y1="' + T + '" x2="' + L + '" y2="' + (T + PH) + '" stroke="#a8b7cc" stroke-width="1" />';
      svg += '<line x1="' + (L - 4) + '" y1="' + T + '" x2="' + (L + 4) + '" y2="' + T + '" stroke="#a8b7cc" stroke-width="1" />';
      svg += '<line x1="' + L + '" y1="' + yIdeal + '" x2="' + (L + PW) + '" y2="' + yIdeal + '" stroke="#ea9624" stroke-width="1" stroke-dasharray="3 3" />';
      if (opts.showLine !== false && values.length >= 1) {
        svg += '<polyline fill="none" stroke="#1060A8" stroke-width="1.5" points="' + pts + '" />';
      }
      var yTickX = L - 4;
      svg += '<text x="' + (yTickX - 3) + '" y="' + T + '" text-anchor="end" dominant-baseline="middle" fill="#5f6c80" font-size="10">' + yMaxLabel + '</text>';
      svg += '<text x="' + yTickX + '" y="' + (T + PH + 11) + '" text-anchor="end" fill="#5f6c80" font-size="10">0</text>';
      svg += '<text x="' + (L - 22) + '" y="' + (T + PH / 2) + '" text-anchor="middle" fill="#5f6c80" font-size="10" transform="rotate(-90 ' + (L - 22) + ' ' + (T + PH / 2) + ')">' + opts.yLabel + '</text>';
      svg += '<text x="' + (W - 4) + '" y="' + (H - 4) + '" text-anchor="end" fill="#5f6c80" font-size="10">' + opts.xLabel + '</text>';
      svg += '<text x="' + (L - 4) + '" y="' + yIdeal + '" text-anchor="end" dominant-baseline="middle" fill="#ea9624" font-size="10">ideal</text>';
      global.$('#' + plotId)
        .attr('viewBox', '0 0 ' + W + ' ' + H)
        .attr('preserveAspectRatio', 'none')
        .html(svg);
    }

    function renderFaceAreaPlot(values, idealValues, showLine) {
      var pairs = [];
      var i;
      for (i = 0; i < values.length; i += 1) {
        pairs.push({
          value: values[i],
          ideal: Array.isArray(idealValues) && idealValues.length === values.length
            ? idealValues[i]
            : (Number.isFinite(idealValues) ? idealValues : 1)
        });
      }
      pairs.sort(function (a, b) {
        var ra = a.value / Math.max(a.ideal, 1e-12);
        var rb = b.value / Math.max(b.ideal, 1e-12);
        return ra - rb;
      });
      values = pairs.map(function (pair) { return pair.value; });
      var ideals = pairs.map(function (pair) { return pair.ideal; });

      renderLinePlot('stats-face-plot', {
        values: values,
        maxY: 5,
        yLabel: 'area',
        xLabel: 'faces sorted',
        showLine: showLine,
        clampMin: false,
        valueAt: function (idx, value) {
          return value / Math.max(ideals[idx], 1e-12);
        }
      });
    }

    function renderAngleResolutionPlot(values) {
      renderLinePlot('stats-angle-plot', {
        values: values,
        maxY: 1,
        yLabel: 'score',
        xLabel: 'vertices sorted'
      });
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

    function updateAngleResolutionScore(graph, posById) {
      if (!global.PlanarVibeMetrics || !global.PlanarVibeMetrics.computeAngularResolutionScore) {
        clearAngleResolutionPlot('Metrics unavailable');
        return;
      }
      var result = global.PlanarVibeMetrics.computeAngularResolutionScore(graph, posById);
      if (!result || !result.ok || !Number.isFinite(result.score) || !result.values) {
        clearAngleResolutionPlot((result && result.reason) ? result.reason : 'No data');
        return;
      }
      global.$('#stats-angle-quality').text(result.score.toFixed(3));
      renderAngleResolutionPlot(result.values);
    }

    function okNumber(result, fieldName) {
      return result && result.ok && Number.isFinite(result[fieldName]) ? result[fieldName] : null;
    }

    function setOverallScoreFromValues(values) {
      if (!Array.isArray(values) || values.length !== 10) {
        global.$('#stats-overall-score').text('--');
        return;
      }
      var total = 0;
      for (var i = 0; i < values.length; i += 1) {
        if (!Number.isFinite(values[i])) {
          global.$('#stats-overall-score').text('--');
          return;
        }
        total += values[i];
      }
      global.$('#stats-overall-score').text((total / values.length).toFixed(3));
    }

    function updateOverallScore(graph, nodeIds, edgePairs, posById) {
      var metrics = global.PlanarVibeMetrics;
      if (!metrics ||
          !global.GeometryUtils ||
          typeof global.GeometryUtils.hasPositionCrossings !== 'function' ||
          typeof metrics.computeAngularResolutionScore !== 'function' ||
          typeof metrics.computeAspectRatioScore !== 'function' ||
          typeof metrics.computeConvexityScore !== 'function' ||
          typeof metrics.computeEdgeLengthDeviationScore !== 'function' ||
          typeof metrics.computeEdgeLengthRatio !== 'function' ||
          typeof metrics.computeEdgeOrthogonalityScore !== 'function' ||
          typeof metrics.computeUniformFaceAreaScore !== 'function' ||
          typeof metrics.computeNodeUniformityScore !== 'function' ||
          typeof metrics.computeAxisAlignmentScore !== 'function' ||
          typeof metrics.computeSpacingUniformityScore !== 'function') {
        global.$('#stats-overall-score').text('--');
        return;
      }
      if (global.GeometryUtils.hasPositionCrossings(posById, edgePairs)) {
        global.$('#stats-overall-score').text('--');
        return;
      }
      var embedding = global.PlanarGraphUtils.extractEmbeddingFromPositions(nodeIds, edgePairs, posById);
      var values = [
        okNumber(metrics.computeAngularResolutionScore(graph, posById), 'score'),
        okNumber(metrics.computeAspectRatioScore(nodeIds, posById), 'score'),
        okNumber(metrics.computeConvexityScore(nodeIds, edgePairs, posById, embedding), 'score'),
        okNumber(metrics.computeEdgeLengthDeviationScore(edgePairs, posById), 'score'),
        okNumber(metrics.computeEdgeLengthRatio(edgePairs, posById), 'ratio'),
        okNumber(metrics.computeEdgeOrthogonalityScore(edgePairs, posById), 'score'),
        okNumber(metrics.computeUniformFaceAreaScore(nodeIds, edgePairs, posById, embedding), 'quality'),
        okNumber(metrics.computeNodeUniformityScore(nodeIds, posById), 'score'),
        okNumber(metrics.computeAxisAlignmentScore(nodeIds, posById), 'score'),
        okNumber(metrics.computeSpacingUniformityScore(nodeIds, posById), 'score')
      ];
      setOverallScoreFromValues(values);
    }

    function updateFaceAreaPlot() {
      if (!currentParsed || !currentParsed.elements) {
        clearFaceAreaPlot('No graph');
        clearAngleResolutionPlot('No graph');
        global.$('#stats-overall-score').text('--');
        setAlignEnabled(false);
        return;
      }
      var edgePairs = edgePairsFromParsed(currentParsed);
      var nodeIds = getNodeIdsFromParsed(currentParsed);
      var posById = getCurrentPositions();
      if (!nodeIds.length) {
        clearFaceAreaPlot('No graph');
        clearAngleResolutionPlot('No graph');
        global.$('#stats-overall-score').text('--');
        setAlignEnabled(false);
        return;
      }

      if (!global.GeometryUtils || typeof global.GeometryUtils.hasPositionCrossings !== 'function') {
        clearFaceAreaPlot('Metrics unavailable');
        clearAngleResolutionPlot('Metrics unavailable');
        setPlaneStat(null);
        global.$('#stats-overall-score').text('--');
        setAlignEnabled(false);
        return;
      }
      var graph = global.GraphUtils.createGraph(nodeIds, edgePairs);
      var hasCrossings = global.GeometryUtils.hasPositionCrossings(posById, edgePairs);
      setPlaneStat(!hasCrossings);
      setAlignEnabled(!hasCrossings);
      updateAngleResolutionScore(graph, posById);
      if (hasCrossings) {
        clearFaceAreaPlot('Drawing is not plane');
        setPlaneStat(false);
        global.$('#stats-overall-score').text('--');
        return;
      }

      if (!global.PlanarVibeMetrics) {
        clearFaceAreaPlot('Metrics unavailable');
        global.$('#stats-overall-score').text('--');
        setAlignEnabled(false);
        return;
      }
      var result = null;
      var convexity = null;
      var embedding = global.PlanarGraphUtils.extractEmbeddingFromPositions(nodeIds, edgePairs, posById);
      if (cy && global.PlanarVibeMetrics.computeUniformFaceAreaScoreFromCy) {
        result = global.PlanarVibeMetrics.computeUniformFaceAreaScoreFromCy(cy, edgePairs, embedding);
      } else if (global.PlanarVibeMetrics.computeUniformFaceAreaScore) {
        result = global.PlanarVibeMetrics.computeUniformFaceAreaScore(nodeIds, edgePairs, posById, embedding);
      }
      if (!result) {
        clearFaceAreaPlot('Metrics unavailable');
        global.$('#stats-overall-score').text('--');
        setAlignEnabled(false);
        return;
      }
      if (global.PlanarVibeMetrics.computeConvexityScore) {
        convexity = global.PlanarVibeMetrics.computeConvexityScore(nodeIds, edgePairs, posById, embedding);
      }
      if (!result.ok) {
        clearFaceAreaPlot(result.reason || 'No data');
        global.$('#stats-overall-score').text('--');
        return;
      }
      renderFaceAreaPlot(result.values, result.idealValues, !hasCrossings);
      global.$('#stats-face-quality').text(
        Number.isFinite(result.quality) ? result.quality.toFixed(3) : '--'
      );
      global.$('#stats-convexity').text(
        convexity && convexity.ok && Number.isFinite(convexity.score) ? convexity.score.toFixed(3) : '--'
      );
    }

    function updateEdgeLengthPlot() {
      if (!currentParsed || !currentParsed.elements) {
        clearEdgeMetrics();
        global.$('#stats-overall-score').text('--');
        global.$('#stats-spacing-uniformity').text('--');
        global.$('#stats-axis-alignment').text('--');
        setAlignEnabled(false);
        return;
      }
      var edgePairs = edgePairsFromParsed(currentParsed);
      var nodeIds = getNodeIdsFromParsed(currentParsed);
      var posById = getCurrentPositions();
      if (!nodeIds.length) {
        clearEdgeMetrics();
        global.$('#stats-overall-score').text('--');
        global.$('#stats-spacing-uniformity').text('--');
        global.$('#stats-axis-alignment').text('--');
        setAlignEnabled(false);
        return;
      }
      var graph = global.GraphUtils.createGraph(nodeIds, edgePairs);
      updateScalarMetric('#stats-edge-ratio', 'computeEdgeLengthRatio', [edgePairs, posById], 'ratio');
      updateScalarMetric('#stats-edge-deviation', 'computeEdgeLengthDeviationScore', [edgePairs, posById], 'score');
      updateScalarMetric('#stats-edge-orthogonality', 'computeEdgeOrthogonalityScore', [edgePairs, posById], 'score');
      updateScalarMetric('#stats-aspect-ratio', 'computeAspectRatioScore', [nodeIds, posById], 'score');
      updateScalarMetric('#stats-node-uniformity', 'computeNodeUniformityScore', [nodeIds, posById], 'score');
      updateScalarMetric('#stats-spacing-uniformity', 'computeSpacingUniformityScore', [nodeIds, posById], 'score');
      updateScalarMetric('#stats-axis-alignment', 'computeAxisAlignmentScore', [nodeIds, posById], 'score');
      updateOverallScore(graph, nodeIds, edgePairs, posById);
    }

    function updateScalarMetric(selector, methodName, args, fieldName) {
      var metrics = global.PlanarVibeMetrics;
      if (!metrics || typeof metrics[methodName] !== 'function') {
        global.$(selector).text('--');
        return;
      }
      var result = metrics[methodName].apply(metrics, args);
      var value = okNumber(result, fieldName);
      global.$(selector).text(Number.isFinite(value) ? value.toFixed(3) : '--');
    }

    function computeDrawingCenter(posById) {
      var keys = Object.keys(posById || {});
      var sx = 0;
      var sy = 0;
      var count = 0;
      for (var i = 0; i < keys.length; i += 1) {
        var p = posById[keys[i]];
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
          continue;
        }
        sx += p.x;
        sy += p.y;
        count += 1;
      }
      if (count < 1) {
        return { x: 0, y: 0 };
      }
      return { x: sx / count, y: sy / count };
    }

    function runAutoRotation() {
      if (layoutBusyState) {
        setStatus('Wait for the current layout to finish first', true);
        return;
      }
      if (!currentParsed || !currentParsed.elements) {
        setStatus('Load a graph first', true);
        return;
      }
      if (!global.PlanarVibeRotation || typeof global.PlanarVibeRotation.computeOptimalWeightedEdgeRotation !== 'function') {
        setStatus('Rotation module is missing', true);
        return;
      }
      if (!global.GeometryUtils || typeof global.GeometryUtils.rotatePositionMap !== 'function') {
        setStatus('Planar graph utilities are missing', true);
        return;
      }

      var edgePairs = edgePairsFromParsed(currentParsed);
      var posById = getCurrentPositions();
      var center = computeDrawingCenter(posById);
      var result = global.PlanarVibeRotation.computeOptimalWeightedEdgeRotation(edgePairs, posById);
      if (!result || !result.ok || !Number.isFinite(result.angle)) {
        setStatus((result && result.reason) ? result.reason : 'Rotate failed', true);
        return;
      }
      if (!result.improved) {
        var noChangeMessage = 'Rotate made no changes';
        if (Number.isFinite(result.matchedCountBefore0) &&
            Number.isFinite(result.matchedCountBefore1) &&
            Number.isFinite(result.matchedCountBefore3) &&
            Number.isFinite(result.matchedCountBefore5)) {
          noChangeMessage += ' | edges <=0/1/' + result.thresholdDeg3 + '/' + result.thresholdDeg5 + 'deg: ' +
            result.matchedCountBefore0 + '/' + result.matchedCountBefore1 + '/' + result.matchedCountBefore3 + '/' + result.matchedCountBefore5;
        }
        setStatus(noChangeMessage + graphSizeSuffix() + smallGraphCoordinatesSuffix(), false);
        return;
      }

      var rotated = global.GeometryUtils.rotatePositionMap(posById, center, result.angle);
      applyPositionMapToCurrentDrawing(rotated);
      fitCurrentDrawingViewport();
      updateFaceAreaPlot();
      updateEdgeLengthPlot();

      var degrees = result.angle * 180 / Math.PI;
      var message = 'Rotated drawing by ' + degrees.toFixed(1) + ' deg';
      if (Number.isFinite(result.scoreBefore) && Number.isFinite(result.scoreAfter)) {
        message += ' | weighted near-horizontal bands score ' + result.scoreBefore.toFixed(3) + ' -> ' + result.scoreAfter.toFixed(3);
      }
      if (Number.isFinite(result.matchedCountBefore0) && Number.isFinite(result.matchedCountAfter0) &&
          Number.isFinite(result.matchedCountBefore1) && Number.isFinite(result.matchedCountAfter1) &&
          Number.isFinite(result.matchedCountBefore3) && Number.isFinite(result.matchedCountAfter3) &&
          Number.isFinite(result.matchedCountBefore5) && Number.isFinite(result.matchedCountAfter5)) {
        message += ' | edges <=0/1/' + result.thresholdDeg3 + '/' + result.thresholdDeg5 + 'deg ' +
          result.matchedCountBefore0 + '/' + result.matchedCountBefore1 + '/' + result.matchedCountBefore3 + '/' + result.matchedCountBefore5 +
          ' -> ' +
          result.matchedCountAfter0 + '/' + result.matchedCountAfter1 + '/' + result.matchedCountAfter3 + '/' + result.matchedCountAfter5;
      }
      setStatus(message + graphSizeSuffix() + smallGraphCoordinatesSuffix(), false);
    }

    function runAxisAlignment() {
      if (layoutBusyState) {
        setStatus('Wait for the current layout to finish first', true);
        return;
      }
      if (!currentParsed || !currentParsed.elements) {
        setStatus('Load a graph first', true);
        return;
      }
      if (!global.PlanarVibeAlignment || typeof global.PlanarVibeAlignment.alignToAxisGreedy !== 'function') {
        setStatus('Axis-alignment module is missing', true);
        return;
      }
      if (!global.GeometryUtils || typeof global.GeometryUtils.hasPositionCrossings !== 'function') {
        setStatus('Planar graph utilities are missing', true);
        return;
      }

      var nodeIds = getNodeIdsFromParsed(currentParsed);
      var edgePairs = edgePairsFromParsed(currentParsed);
      var posById = getCurrentPositions();
      if (!nodeIds.length) {
        setStatus('No graph', true);
        return;
      }
      if (global.GeometryUtils.hasPositionCrossings(posById, edgePairs)) {
        setAlignEnabled(false);
        setStatus('Align requires a plane drawing', true);
        return;
      }

      var result = global.PlanarVibeAlignment.alignToAxisGreedy(nodeIds, edgePairs, posById);
      if (!result || !result.ok) {
        setStatus((result && result.reason) ? result.reason : 'Align failed', true);
        return;
      }
      if (!result.changed) {
        setStatus('Align made no changes' + graphSizeSuffix() + smallGraphCoordinatesSuffix(), false);
        setAlignEnabled(true);
        return;
      }

      applyPositionMapToCurrentDrawing(result.positions);
      updateFaceAreaPlot();
      updateEdgeLengthPlot();

      var message = 'Aligned axes (x merges ' + result.mergedCountX + ', y merges ' + result.mergedCountY + ')';
      if (Number.isFinite(result.scoreBefore) && Number.isFinite(result.scoreAfter)) {
        message += ' | score ' + result.scoreBefore.toFixed(3) + ' -> ' + result.scoreAfter.toFixed(3);
      }
      setStatus(message + graphSizeSuffix() + smallGraphCoordinatesSuffix(), false);
    }

    function buildVisibleSnapshotData() {
      var basePositions = getCurrentPositions();
      var baseEdgePairs = currentParsed ? edgePairsFromParsed(currentParsed) : [];
      var labelsById = Object.assign({}, currentParsed && currentParsed.labelsById ? currentParsed.labelsById : {});
      var classesById = Object.assign({}, currentParsed && currentParsed.classesById ? currentParsed.classesById : {});
      var edgeClassByKey = {};
      var nodePosById = {};
      var edgePairs = baseEdgePairs.slice();
      var keys = Object.keys(basePositions);
      var i;

      for (i = 0; i < keys.length; i += 1) {
        var id = keys[i];
        var p = basePositions[id];
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
          nodePosById[id] = { x: p.x, y: p.y };
        }
      }

      var overlay = buildDebugOverlayData();
      if (overlay) {
        var overlayIds = Object.keys(overlay.positionsById);
        for (i = 0; i < overlayIds.length; i += 1) {
          var overlayId = overlayIds[i];
          nodePosById[overlayId] = {
            x: overlay.positionsById[overlayId].x,
            y: overlay.positionsById[overlayId].y
          };
          labelsById[overlayId] = overlay.labelsById[overlayId];
          classesById[overlayId] = overlay.classesById[overlayId];
        }
        edgePairs = edgePairs.concat(overlay.edgePairs);
        Object.assign(edgeClassByKey, overlay.edgeClassByKey);
      }

      return {
        nodePosById: nodePosById,
        edgePairs: edgePairs,
        labelsById: labelsById,
        classesById: classesById,
        edgeClassByKey: edgeClassByKey
      };
    }

    function computeStaticFitViewport() {
      var wrapEl = global.document.getElementById('cy-static-wrap');
      var snapshotData = buildVisibleSnapshotData();
      if (!wrapEl || !snapshotData) {
        return null;
      }
      var nodeIds = Object.keys(snapshotData.nodePosById || {});
      if (nodeIds.length === 0) {
        return null;
      }

      var radius = graphStylePrefs.vertexSize / 2;
      var margin = Math.max(24, radius + 8);
      var topMargin = margin + DRAWING_TOP_CLEARANCE_PX;
      var minX = Infinity;
      var minY = Infinity;
      var maxX = -Infinity;
      var maxY = -Infinity;
      for (var i = 0; i < nodeIds.length; i += 1) {
        var p = snapshotData.nodePosById[nodeIds[i]];
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
          continue;
        }
        minX = Math.min(minX, p.x - radius - margin);
        minY = Math.min(minY, p.y - radius - topMargin);
        maxX = Math.max(maxX, p.x + radius + margin);
        maxY = Math.max(maxY, p.y + radius + margin);
      }
      if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) {
        return null;
      }

      var width = Math.max(1, Math.floor(wrapEl.clientWidth || wrapEl.getBoundingClientRect().width || DEFAULT_WORLD_WIDTH));
      var height = Math.max(1, Math.floor(wrapEl.clientHeight || wrapEl.getBoundingClientRect().height || DEFAULT_WORLD_HEIGHT));
      var boxWidth = Math.max(1e-9, maxX - minX);
      var boxHeight = Math.max(1e-9, maxY - minY);
      var zoom = Math.min(width / boxWidth, height / boxHeight);
      if (!Number.isFinite(zoom) || zoom <= 1e-9) {
        zoom = 1;
      }
      return {
        zoom: zoom,
        pan: {
          x: -minX * zoom + (width - boxWidth * zoom) / 2,
          y: -minY * zoom + (height - boxHeight * zoom) / 2
        },
        width: width,
        height: height
      };
    }

    function computeCurrentDrawingFitBounds(posById, nodeIds) {
      var ids = Array.isArray(nodeIds) ? nodeIds : [];
      var radius = graphStylePrefs.vertexSize / 2;
      var margin = Math.max(24, radius + 8);
      var topMargin = margin + DRAWING_TOP_CLEARANCE_PX;
      var minX = Infinity;
      var minY = Infinity;
      var maxX = -Infinity;
      var maxY = -Infinity;
      for (var i = 0; i < ids.length; i += 1) {
        var p = posById ? posById[String(ids[i])] : null;
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
          continue;
        }
        minX = Math.min(minX, p.x - radius - margin);
        minY = Math.min(minY, p.y - radius - topMargin);
        maxX = Math.max(maxX, p.x + radius + margin);
        maxY = Math.max(maxY, p.y + radius + margin);
      }
      if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) {
        return null;
      }
      return { x1: minX, y1: minY, x2: maxX, y2: maxY };
    }

    function renderStaticSnapshot() {
      if (!currentParsed || !currentParsed.elements) {
        global.$('#cy-static-svg').empty();
        return;
      }
      var snapshotData = buildVisibleSnapshotData();
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
        var fitViewport = computeStaticFitViewport();
        if (fitViewport) {
          saveViewportState(fitViewport);
          forcedViewBox = {
            minX: (-fitViewport.pan.x) / fitViewport.zoom,
            minY: (-fitViewport.pan.y) / fitViewport.zoom,
            width: fitViewport.width / fitViewport.zoom,
            height: fitViewport.height / fitViewport.zoom
          };
        }
      }
      var snapshot = buildSvgMarkup(snapshotData.nodePosById, snapshotData.edgePairs, {
        radius: graphStylePrefs.vertexSize / 2,
        edgeWidth: graphStylePrefs.edgeWidth,
        fontSize: computeNodeFontSize(graphStylePrefs.vertexSize),
        includeBackground: false,
        viewBox: forcedViewBox,
        labelsById: snapshotData.labelsById,
        classesById: snapshotData.classesById,
        edgeClassByKey: snapshotData.edgeClassByKey
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
      var interactionLabel = isInteractive ? 'Disable graph interaction' : 'Enable graph interaction';
      global.$('#interactive-toggle-btn')
        .attr('title', interactionLabel)
        .attr('aria-label', interactionLabel)
        .attr('aria-pressed', isInteractive ? 'true' : 'false')
        .toggleClass('is-inactive', !isInteractive);
      global.$('#show-augmentation-toggle').prop('checked', showDebugAugmentation);
      global.$('.debug-augmentation-toggle').toggleClass('is-checked', showDebugAugmentation);
      global.$('#cy').toggle(isInteractive);
      global.$('#cy-static-wrap').toggle(!isInteractive);
      global.$('.layout-toolbar').show();
      global.$('.style-controls').show();
      global.$('#vertex-size-slider').prop('disabled', false);
      global.$('#vertex-size-control-row').css('opacity', '1');
      global.$('#edge-width-slider').prop('disabled', false);
      global.$('#edge-width-control-row').css('opacity', '1');
      global.$('#reset-zoom-btn').prop('disabled', !isInteractive && !(currentParsed && currentParsed.elements));
    }

    function setDebugAugmentationVisible(visible, suppressStatus) {
      showDebugAugmentation = !!visible;
      global.$('#show-augmentation-toggle').prop('checked', showDebugAugmentation);
      global.$('.debug-augmentation-toggle').toggleClass('is-checked', showDebugAugmentation);
      if (cy) {
        global.CyRuntime.syncOverlayInCy(cy, buildDebugOverlayData());
      } else {
        renderStaticSnapshot();
      }
      if (!suppressStatus) {
        if (showDebugAugmentation) {
          setStatus(currentDebugState
            ? 'Showing augmentation debug overlay'
            : 'Debug overlay enabled (no algorithm debug state yet)', false);
        } else {
          setStatus('Hiding augmentation debug overlay', false);
        }
      }
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
          setCurrentPositions(global.CyRuntime.currentPositionsFromCy(cy));
          saveViewportState(global.CyRuntime.captureViewportFromCy(cy));
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
        if (!global.CyRuntime.restorePositionsToCy(cy, currentPositionsCache)) {
          if (global.PlanarVibeRandom && typeof global.PlanarVibeRandom.applyLayout === 'function') {
            global.PlanarVibeRandom.applyLayout(cy, {});
          }
          saveViewportState(global.CyRuntime.captureViewportFromCy(cy));
        } else if (!global.CyRuntime.applyViewportToCy(cy, savedViewport)) {
          fitCurrentDrawingViewport();
        }
        global.CyRuntime.syncOverlayInCy(cy, buildDebugOverlayData());
      }
      updateStatistics(currentParsed);
      updateFaceAreaPlot();
      updateEdgeLengthPlot();
      if (!suppressStatus) {
        setStatus('Interactive mode enabled', false);
      }
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
      setLayoutButtonDisabled($btn, !isEnabled);
      if (!isEnabled) {
        $btn.removeClass('is-active').attr('aria-pressed', 'false');
      }
    }

	    function setLayoutButtonDisabled($btn, isDisabled) {
      $btn
        .prop('disabled', !!isDisabled)
        .toggleClass('disabled', !!isDisabled)
        .attr('aria-disabled', isDisabled ? 'true' : 'false');
	    }

    function setAlignEnabled(isEnabled) {
      global.$('#align-axis-btn').prop('disabled', !isEnabled);
    }

    function setAlwaysAvailableLayoutButtonsEnabled(isEnabled) {
      setLayoutEnabled('circle', isEnabled);
      setLayoutEnabled('grid', isEnabled);
      setLayoutEnabled('cose', isEnabled);
      setLayoutEnabled('random', isEnabled);
      setLayoutEnabled('gpt', isEnabled);
      setLayoutEnabled('claude', isEnabled);
    }

    function setPlanarButtonsDisabled() {
      setLayoutEnabled('tutte', false);
      setLayoutEnabled('air', false);
      setLayoutEnabled('areagrad', false);
      setLayoutEnabled('facebalancer', false);
      setLayoutEnabled('edgebalancer', false);
      setLayoutEnabled('anglebalancer', false);
      setLayoutEnabled('fabalancer', false);
      setLayoutEnabled('impred', false);
      setLayoutEnabled('ceg-bfs', false);
      setLayoutEnabled('ceg-xy', false);
      setLayoutEnabled('p3t', false);
      setLayoutEnabled('fpp', false);
      setLayoutEnabled('schnyder', false);
      setLayoutEnabled('reweight', false);
      setLayoutEnabled('forcedir', false);
      setAlignEnabled(false);
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
      var nodeIds = getNodeIdsFromParsed(parsed);
      var edgePairs = edgePairsFromParsed(parsed);
      var graph = global.GraphUtils.createGraph(nodeIds, edgePairs);
      var embedding = global.PlanarVibePlanarityTest.computePlanarEmbedding(nodeIds, edgePairs);
      var isPlanar = !!(embedding && embedding.ok);
      var isBipartite = !!(global.PlanarVibeMetrics && global.PlanarVibeMetrics.isBipartiteGraph &&
        global.PlanarVibeMetrics.isBipartiteGraph(graph));
      var isPlanar3Tree = false;
      if (isPlanar) {
        isPlanar3Tree = !!global.PlanarVibePlanarityTest.isPlanar3Tree(graph);
      }
      setStatistics({
        vertexCount: nodeIds.length,
        edgeCount: edgePairs.length,
        isPlanar: isPlanar,
        isBipartite: isBipartite,
        isPlanar3Tree: isPlanar3Tree
      });
      setAlwaysAvailableLayoutButtonsEnabled(true);
      setLayoutEnabled('tutte', isPlanar);
      setLayoutEnabled('air', isPlanar);
      setLayoutEnabled('areagrad', isPlanar);
      setLayoutEnabled('facebalancer', isPlanar);
      setLayoutEnabled('edgebalancer', isPlanar);
      setLayoutEnabled('anglebalancer', isPlanar);
      setLayoutEnabled('fabalancer', isPlanar);
      setLayoutEnabled('impred', isPlanar);
      setLayoutEnabled('ceg-bfs', isPlanar);
      setLayoutEnabled('ceg-xy', isPlanar);
      setLayoutEnabled('p3t', isPlanar3Tree);
      setLayoutEnabled('fpp', isPlanar);
      setLayoutEnabled('schnyder', isPlanar);
      setLayoutEnabled('reweight', isPlanar);
      setLayoutEnabled('forcedir', isPlanar);
      setAlignEnabled(false);
    }

    function drawGraph() {
      try {
        currentParsed = global.PlanarVibePlugin.parseEdgeList(global.$('#dotfile').val());
        clearCurrentDebugState();
        clearSelectedLayoutButton();

        function applyParsedPositionsIfAny() {
          if (!currentParsed || !currentParsed.hasExplicitPositions) {
            return false;
          }
          var fallback = assignDeterministicPositionsForParsed(currentParsed);
          var rawPositions = {};
          cy.nodes().forEach(function (node) {
            var id = String(node.id());
            var p = currentParsed.positionsById && currentParsed.positionsById[id];
            if (!p) {
              p = fallback[id];
            }
            if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
              rawPositions[id] = { x: p.x, y: p.y };
            }
          });
          var normalizedPositions = (global.GeometryUtils && typeof global.GeometryUtils.normalizePositionMapToViewport === 'function')
            ? global.GeometryUtils.normalizePositionMapToViewport(rawPositions)
            : rawPositions;
          cy.nodes().forEach(function (node) {
            var id = String(node.id());
            var p = normalizedPositions[id];
            if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
              node.position({ x: p.x, y: p.y });
            }
          });
          if (cy) {
            fitCurrentDrawingViewport();
          }
          setLayoutStatus('Applied input coordinates', false);
          return true;
        }

        if (!cy) {
          setInteractiveMode(true, false, true);
          cy.elements().remove();
          cy.add(currentParsed.elements);
          setCurrentPositions({});
          saveViewportState(null);
          updateStatistics(currentParsed);
          if (!applyParsedPositionsIfAny()) {
            applyDeterministicPositionsToCy(currentParsed);
          }
          setInteractiveMode(false, false, true);
          markCurrentInputAsVisualized();
          setStatus('Graph rendered in static mode', false);
          return;
        }
        cy.elements().remove();
        cy.add(currentParsed.elements);
        setCurrentPositions({});
        saveViewportState(null);
        updateStatistics(currentParsed);
        if (!applyParsedPositionsIfAny()) {
          applyLayout('random', { suppressActiveSelection: true });
        }
        markCurrentInputAsVisualized();
        var drawnMessage = 'Drawn ' + currentParsed.nodeCount + ' nodes and ' + currentParsed.edgeCount + ' edges';
        if (Array.isArray(currentParsed.outerFace) && currentParsed.outerFace.length >= 3) {
          drawnMessage += ' (' + currentParsed.outerFace.length + '-vertex outer face)';
        }
        setStatus(drawnMessage, false);
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

    var layoutConfigs = {
      circle: {
        disabledMessage: 'Circle layout is currently unavailable',
        getModule: function () { return global.PlanarVibeCytoscape; },
        methodName: 'applyCircleLayout'
      },
      grid: {
        disabledMessage: 'Grid layout is currently unavailable',
        getModule: function () { return global.PlanarVibeCytoscape; },
        methodName: 'applyGridLayout'
      },
      cose: {
        disabledMessage: 'Force-directed layout is currently unavailable',
        getModule: function () { return global.PlanarVibeCytoscape; },
        methodName: 'applyCoseLayout'
      },
      random: {
        disabledMessage: 'Random layout is currently unavailable',
        getModule: function () { return global.PlanarVibeRandom; },
        methodName: 'applyLayout'
      },
      impred: {
        disabledMessage: 'ImPrEd layout is currently unavailable',
        getModule: function () { return global.PlanarVibeImPrEd; },
        methodName: 'applyLayout',
        buildMethodOptions: function () {
          return sharedLayoutMethodOptions({
            onIteration: function (progress) {
              if (!progress) return;
              var debug = progressDebug(progress);
              var msg = 'ImPrEd step ' + progress.iter + '/' + progress.maxIters +
                ' | moved ' + progress.movedVertices +
                ' | max move ' + progress.maxMove.toFixed(2) +
                ' | cap ' + debug.moveCap.toFixed(2);
              setStatus(msg, false);
            }
          });
        }
      },
      tutte: {
        disabledMessage: 'Tutte layout requires a planar graph',
        getModule: function () { return global.PlanarVibeTutte; },
        methodName: 'applyLayout',
        buildMethodOptions: function () {
          return sharedLayoutMethodOptions();
        }
      },
      air: {
        disabledMessage: 'Air layout requires a planar graph',
        getModule: function () { return global.PlanarVibeAir; },
        methodName: 'applyLayout',
        buildMethodOptions: function () {
          return sharedLayoutMethodOptions({
            onIteration: function (progress) {
              if (!progress) return;
              var debug = progressDebug(progress);
              var parts = [];
              parts.push('Air sweep ' + progress.iter + '/' + progress.maxIters);
              if (Number.isFinite(progress.maxRelError)) {
                parts.push('face err ' + progress.maxRelError.toFixed(3));
              }
              if (Number.isFinite(debug.maxForce)) {
                parts.push('max force ' + debug.maxForce.toExponential(2));
              }
              if (Number.isFinite(progress.maxMove)) {
                parts.push('max move ' + progress.maxMove.toExponential(2));
              }
              if (Number.isFinite(debug.acceptedCount)) {
                parts.push('accepted ' + debug.acceptedCount);
              }
              if (Number.isFinite(debug.plateauWindowImprovementAbs) &&
                  Number.isFinite(debug.plateauWindow)) {
                parts.push('dErr[' + debug.plateauWindow + '] ' + debug.plateauWindowImprovementAbs.toExponential(2));
              }
              if (Number.isFinite(debug.boundedFaceCount)) {
                parts.push('faces ' + debug.boundedFaceCount);
              }
              setStatus(parts.join(' | '), false);
            }
          });
        }
      },
      areagrad: {
        disabledMessage: 'AreaGrad layout requires a planar graph',
        getModule: function () { return global.PlanarVibeAreaGrad; },
        methodName: 'applyLayout',
        buildMethodOptions: function () {
          return sharedLayoutMethodOptions({
            onIteration: function (progress) {
              if (!progress) return;
              var debug = progressDebug(progress);
              var parts = [];
              parts.push('AreaGrad step ' + progress.iter + '/' + progress.maxIters);
              if (Number.isFinite(progress.objective)) {
                parts.push('obj ' + progress.objective.toFixed(3));
              }
              if (Number.isFinite(progress.tradeoffScore)) {
                parts.push('tradeoff ' + progress.tradeoffScore.toFixed(3));
              }
              if (Number.isFinite(progress.maxRelError)) {
                parts.push('face err ' + progress.maxRelError.toFixed(3));
              }
              if (Number.isFinite(debug.gradNorm)) {
                parts.push('grad ' + debug.gradNorm.toExponential(2));
              }
              if (Number.isFinite(progress.maxMove)) {
                parts.push('max move ' + progress.maxMove.toExponential(2));
              }
              if (Number.isFinite(debug.lineSearchSteps)) {
                parts.push('backtracks ' + debug.lineSearchSteps);
              }
              setStatus(parts.join(' | '), false);
            }
          });
        }
      },
      facebalancer: {
        disabledMessage: 'FaceBalancer layout requires a planar graph',
        getModule: function () { return global.PlanarVibeFaceBalancer; },
        methodName: 'applyLayout',
        buildMethodOptions: function () {
          return sharedLayoutMethodOptions({
            onIteration: function (progress) {
              if (!progress) return;
              var debug = progressDebug(progress);
              var parts = [];
              parts.push('FaceBalancer step ' + progress.iter + '/' + progress.maxIters);
              if (Number.isFinite(progress.objective)) {
                parts.push('obj ' + progress.objective.toFixed(3));
              }
              if (Number.isFinite(debug.gradNorm)) {
                parts.push('grad ' + debug.gradNorm.toExponential(2));
              }
              if (Number.isFinite(progress.maxRelError)) {
                parts.push('face err ' + progress.maxRelError.toFixed(3));
              }
              setStatus(parts.join(' | '), false);
            }
          });
        }
      },
      edgebalancer: {
        disabledMessage: 'EdgeBalancer layout requires a planar graph',
        getModule: function () { return global.PlanarVibeEdgeBalancer; },
        methodName: 'applyLayout',
        buildMethodOptions: function () {
          return sharedLayoutMethodOptions({
            onIteration: function (progress) {
              if (!progress) return;
              var debug = progressDebug(progress);
              var parts = [];
              parts.push('EdgeBalancer step ' + progress.iter + '/' + progress.maxIters);
              if (Number.isFinite(progress.edgeLengthDeviation)) {
                parts.push('edge deviation ' + progress.edgeLengthDeviation.toFixed(3));
              }
              if (Number.isFinite(progress.edgeLengthRatio)) {
                parts.push('min/max ' + progress.edgeLengthRatio.toFixed(3));
              }
              if (Number.isFinite(progress.objective)) {
                parts.push('obj ' + progress.objective.toFixed(3));
              }
              if (Number.isFinite(debug.gradNorm)) {
                parts.push('grad ' + debug.gradNorm.toExponential(2));
              }
              if (Number.isFinite(progress.maxLogDeviation)) {
                parts.push('log spread ' + progress.maxLogDeviation.toFixed(3));
              }
              setStatus(parts.join(' | '), false);
            }
          });
        }
      },
      anglebalancer: {
        disabledMessage: 'AngleBalancer layout requires a planar graph',
        getModule: function () { return global.PlanarVibeAngleBalancer; },
        methodName: 'applyLayout',
        buildMethodOptions: function () {
          return sharedLayoutMethodOptions({
            onIteration: function (progress) {
              if (!progress) return;
              var parts = [];
              parts.push('AngleBalancer step ' + progress.iter + '/' + progress.maxIters);
              if (Number.isFinite(progress.angleResolutionScore)) {
                parts.push('angle score ' + progress.angleResolutionScore.toFixed(3));
              }
              if (Number.isFinite(progress.objective)) {
                parts.push('obj ' + progress.objective.toFixed(3));
              }
              if (Number.isFinite(progress.maxAngleResidual)) {
                parts.push('max resid ' + progress.maxAngleResidual.toFixed(3));
              }
              if (Number.isFinite(progress.minAngleRatio)) {
                parts.push('min ratio ' + progress.minAngleRatio.toFixed(3));
              }
              if (Number.isFinite(progress.gradNorm)) {
                parts.push('grad ' + progress.gradNorm.toExponential(2));
              }
              if (Number.isFinite(progress.maxMove)) {
                parts.push('max move ' + progress.maxMove.toExponential(2));
              }
              setStatus(parts.join(' | '), false);
            }
          });
        }
      },
      fabalancer: {
        disabledMessage: 'FABalancer layout requires a planar graph',
        getModule: function () { return global.PlanarVibeFABalancer; },
        methodName: 'applyLayout',
        buildMethodOptions: function () {
          return sharedLayoutMethodOptions({
            onIteration: function (progress) {
              if (!progress) return;
              var debug = progressDebug(progress);
              var parts = [];
              var stageLabel = progress.stageLabel || progress.stage || 'joint';
              var stageText = 'FABalancer ' + stageLabel;
              if (Number.isFinite(progress.stageIndex) && Number.isFinite(progress.stageCount)) {
                stageText += ' ' + progress.stageIndex + '/' + progress.stageCount;
              }
              if (Number.isFinite(progress.maxIters) && progress.maxIters > 0) {
                stageText += ' step ' + progress.iter + '/' + progress.maxIters;
              } else if (Number.isFinite(progress.iter) && progress.iter >= 0) {
                stageText += ' step ' + progress.iter;
              }
              parts.push(stageText);
              if (Number.isFinite(progress.faceAreaScore)) {
                parts.push('face score ' + progress.faceAreaScore.toFixed(3));
              }
              if (Number.isFinite(progress.angleResolutionScore)) {
                parts.push('angle score ' + progress.angleResolutionScore.toFixed(3));
              }
              if (Number.isFinite(progress.objective)) {
                parts.push('obj ' + progress.objective.toFixed(3));
              }
              if (Number.isFinite(progress.tradeoffScore)) {
                parts.push('tradeoff ' + progress.tradeoffScore.toFixed(3));
              }
              setStatus(parts.join(' | '), false);
            }
          });
        }
      },
      'ceg-bfs': {
        disabledMessage: 'CEG-bfs layout requires a planar graph',
        getModule: function () { return global.PlanarVibeCEGBfs; },
        methodName: 'applyLayout',
        buildMethodOptions: function () {
          return sharedLayoutMethodOptions();
        }
      },
      'ceg-xy': {
        disabledMessage: 'CEG-xy layout requires a planar graph',
        getModule: function () { return global.PlanarVibeCEGXy; },
        methodName: 'applyLayout',
        buildMethodOptions: function () {
          return sharedLayoutMethodOptions();
        }
      },
      p3t: {
        disabledMessage: 'P3T layout requires a planar 3-tree',
        getModule: function () { return global.PlanarVibeP3T; },
        methodName: 'applyLayout'
      },
      fpp: {
        disabledMessage: 'FPP layout requires a planar graph',
        getModule: function () { return global.PlanarVibeFPP; },
        methodName: 'applyLayout',
        buildMethodOptions: function () {
          return sharedLayoutMethodOptions();
        }
      },
      schnyder: {
        disabledMessage: 'Schnyder layout requires a planar graph',
        getModule: function () { return global.PlanarVibeSchnyder; },
        methodName: 'applyLayout',
        buildMethodOptions: function () {
          return sharedLayoutMethodOptions();
        }
      },
      reweight: {
        disabledMessage: 'Reweight layout requires a planar graph',
        getModule: function () { return global.PlanarVibeReweight; },
        methodName: 'applyLayout',
        buildMethodOptions: function () {
          return sharedLayoutMethodOptions({
            onIteration: function (progress) {
              if (!progress) {
                return;
              }
              var debug = progressDebug(progress);
              var parts = [];
              parts.push('Reweight step ' + progress.iter + '/' + progress.maxIters);
              if (Number.isFinite(progress.faceAreaScore)) {
                parts.push('face score ' + progress.faceAreaScore.toFixed(3));
              }
              if (Number.isFinite(debug.faceAreaMinRatio) && Number.isFinite(debug.faceAreaMaxRatio)) {
                parts.push('area ratio min/avg ' + debug.faceAreaMinRatio.toFixed(2) + ', max/avg ' + debug.faceAreaMaxRatio.toFixed(2));
              }
              if (Number.isFinite(debug.boundedFaceCount)) {
                parts.push('faces ' + debug.boundedFaceCount);
              }
              setStatus(parts.join(' | '), false);
            }
          });
        }
      },
      forcedir: {
        disabledMessage: 'ForceDir layout requires a planar graph',
        getModule: function () { return global.PlanarVibeForceDir; },
        methodName: 'applyLayout',
        buildMethodOptions: function () {
          return sharedLayoutMethodOptions({
            onIteration: function (progress) {
              var debug = progressDebug(progress);
              if (!progress || progress.iter % 10 !== 0) {
                return;
              }
              setStatus(
                'ForceDir step ' + progress.iter + '/' + progress.maxIters +
                ' | accepted ' + debug.accepted +
                ' | rejected ' + debug.rejected,
                false
              );
            }
          });
        }
      },
      gpt: {
        disabledMessage: 'GPT layout is currently unavailable',
        getModule: function () { return global.PlanarVibeGPT; },
        methodName: 'applyLayout',
        buildMethodOptions: function () {
          return sharedLayoutMethodOptions();
        }
      },
      claude: {
        disabledMessage: 'Claude layout is currently unavailable',
        getModule: function () { return global.PlanarVibeClaude; },
        methodName: 'applyLayout',
        buildMethodOptions: function () {
          return sharedLayoutMethodOptions();
        }
      }
    };

    function applyLayout(layoutName, options) {
      var opts = options || {};
      var temporaryStaticRun = !!opts.temporaryStaticRun;
      if (!cy) {
        if (!currentParsed || !currentParsed.elements) {
          setStatus('Load a graph first', true);
          return;
        }
        setInteractiveMode(true, false, true);
        applyLayout(layoutName, Object.assign({}, opts, { temporaryStaticRun: true }));
        return;
      }
      if (cy.nodes().length === 0) {
        return;
      }
      if (!opts.suppressActiveSelection) {
        setSelectedLayoutButton(layoutName);
      }
      clearCurrentDebugState();

      function afterLayoutDone() {
        if (temporaryStaticRun) {
          setInteractiveMode(false, false, true);
        }
      }

      var layoutConfig = layoutConfigs[layoutName];
      if (!layoutConfig) {
        setStatus('Unknown layout: ' + layoutName, true);
        return;
      }

      runManagedLayout({
        layoutName: layoutName,
        disabledMessage: layoutConfig.disabledMessage,
        module: layoutConfig.getModule(),
        methodName: layoutConfig.methodName,
        buildMethodOptions: layoutConfig.buildMethodOptions
      }, afterLayoutDone);
    }

	    function runAfterBusyPaint(fn) {
	      var schedule = typeof global.setTimeout === 'function'
	        ? global.setTimeout.bind(global)
	        : (typeof setTimeout === 'function' ? setTimeout : null);
	      var raf = typeof global.requestAnimationFrame === 'function'
	        ? global.requestAnimationFrame.bind(global)
	        : (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null);
	      if (raf && schedule) {
	        raf(function () {
	          schedule(fn, 0);
	        });
	        return;
	      }
	      if (schedule) {
	        schedule(fn, 0);
	        return;
	      }
	      fn();
	    }

	    function runManagedLayout(config, onDone) {
	      var name = config.layoutName;
	      if (global.$('.layout-btn[data-layout="' + name + '"]').prop('disabled')) {
	        setStatus(config.disabledMessage, true);
	        if (typeof onDone === 'function') onDone();
	        return;
	      }
	      if (layoutBusyState) {
	        setStatus('Wait for the current layout to finish first', true);
	        if (typeof onDone === 'function') onDone();
	        return;
	      }
	      enterLayoutBusy(name);
	      var methodOptions = null;
	      if (typeof config.buildMethodOptions === 'function') {
	        methodOptions = config.buildMethodOptions();
	      }
	      if (!methodOptions) {
	        methodOptions = {};
	      }

	      runAfterBusyPaint(function () {
	        var result;
	        try {
	          result = config.module[config.methodName](cy, methodOptions);
	        } catch (err) {
	          setLayoutStatus((err && err.message) ? err.message : ('Failed ' + name + ' layout'), true);
	          restoreLayoutBusy();
	          if (typeof onDone === 'function') onDone();
	          return;
	        }
	        if (result && typeof result.then === 'function') {
	          result.then(function (resolved) {
	            setCurrentDebugState(resolved && resolved.ok && resolved.debugState ? resolved.debugState : null);
	            setLayoutStatus(resolved && resolved.message ? resolved.message : ('Applied ' + name + ' layout'), !(resolved && resolved.ok));
	            restoreLayoutBusy();
	            if (typeof onDone === 'function') onDone();
	          }).catch(function (err) {
	            setLayoutStatus((err && err.message) ? err.message : ('Failed ' + name + ' layout'), true);
	            restoreLayoutBusy();
	            if (typeof onDone === 'function') onDone();
	          });
	          return;
	        }
	        setCurrentDebugState(result && result.ok && result.debugState ? result.debugState : null);
	        setLayoutStatus(result && result.message ? result.message : ('Applied ' + name + ' layout'), !(result && result.ok));
	        restoreLayoutBusy();
	        if (typeof onDone === 'function') onDone();
	      });
	    }

    function setSelectedLayoutButton(layoutName) {
      global.$('.layout-btn')
        .removeClass('is-active')
        .attr('aria-pressed', 'false');
      global.$('.layout-btn[data-layout="' + layoutName + '"]')
        .addClass('is-active')
        .attr('aria-pressed', 'true');
    }

    function clearSelectedLayoutButton() {
      global.$('.layout-btn')
        .removeClass('is-active')
        .attr('aria-pressed', 'false');
    }

	    function enterLayoutBusy(activeLayoutName) {
	      global.$('.layout-btn').each(function () {
	        var $btn = global.$(this);
	        var name = String($btn.data('layout') || '');
	        if (name !== activeLayoutName) {
	          setLayoutButtonDisabled($btn, true);
	        }
	      });
	      layoutBusyState = true;
	    }

	    function restoreLayoutBusy() {
	      if (!layoutBusyState) {
	        return;
	      }
	      layoutBusyState = null;
	      updateStatistics(currentParsed);
	    }

    function resetZoom() {
      if (!cy) {
        if (!currentParsed || !currentParsed.elements) {
          return;
        }
        saveViewportState(computeStaticFitViewport());
        renderStaticSnapshot();
        setStatus('Scale reset', false);
        return;
      }
      if (cy.nodes().length === 0) {
        return;
      }
      fitCurrentDrawingViewport();
      setStatus('Zoom reset', false);
    }

    function fitCurrentDrawingViewport() {
      if (!cy) {
        if (!currentParsed || !currentParsed.elements) {
          return;
        }
        saveViewportState(computeStaticFitViewport());
        renderStaticSnapshot();
        return;
      }
      if (cy.nodes().length === 0) {
        return;
      }
      var nodeIds = currentParsed ? getNodeIdsFromParsed(currentParsed) : [];
      var bounds = computeCurrentDrawingFitBounds(getCurrentPositions(), nodeIds);
      if (bounds) {
        cy.fit(bounds, 0);
      } else {
        cy.fit(undefined, 20);
        cy.center();
      }
      saveViewportState(global.CyRuntime.captureViewportFromCy(cy));
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
        var isDummy = typeof node.hasClass === 'function' && node.hasClass('dummy-node');
        svg.push('<circle cx="' + x + '" cy="' + y + '" r="' + radius + '" fill="' + (isDummy ? '#7a1f1f' : LOGO_COLORS.blue) + '" stroke="' + (isDummy ? '#3d0d0d' : LOGO_COLORS.black) + '" stroke-width="0.5"/>');
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
      var ids = ['stats-angle-plot-wrap', 'stats-face-plot-wrap'];
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

      global.$('#show-augmentation-toggle').on('change', function () {
        setDebugAugmentationVisible(global.$(this).is(':checked'));
      });

      global.$('#interactive-toggle-btn').on('click', function () {
        setInteractiveMode(!isInteractive);
      });

      global.$('#rotate-graph-btn').on('click', function () {
        runAutoRotation();
      });

      global.$('#align-axis-btn').on('click', function () {
        runAxisAlignment();
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

      global.$('#status-copy-btn').on('click', function () {
        copyStatusToClipboard();
      });
    }

    bindUiEvents();
    initStyleControls();
    clearSelectedLayoutButton();
    setStatusPanelCollapsed(isStatusCollapsed, false);

    clearDrawingStats(isInteractive ? 'No graph' : 'Static mode');
    pasteStaticGraph(global.PlanarVibeGraphGenerator.defaultSample);

    if (!isInteractive && cy) {
      setCurrentPositions(global.CyRuntime.currentPositionsFromCy(cy));
      saveViewportState(global.CyRuntime.captureViewportFromCy(cy));
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
