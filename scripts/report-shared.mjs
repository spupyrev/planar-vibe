import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

export const REPORT_DATA_CSV = 'report-data.csv';
export const REPORT_INSTANCE_TIMEOUT_MS = 60 * 1000;

export const benchmark = [
  'sample1', 'sample2', 'sample3', 'sample4', 'sample5', 'sample6', 'sample7',
  'planar3tree10', 'planar3tree30', 'planar3tree100',
  'cycle20', 'xtree30', 'oct174',
  'grid2x10', 'grid2x20', 'grid4x20', 'grid9x9',
  'randomplanar1', 'randomplanar2', 'randomplanar3', 'randomplanar4', 'randomplanar5'
];

export const metricHeaders = [
  ['runtime', 'Runtime (s)'],
  ['angularResolution', 'Angular Resolution'],
  ['aspectRatio', 'Aspect Ratio'],
  ['convexity', 'Convexity'],
  ['edgeLengthDeviation', 'Edge-Length Deviation'],
  ['edgeRatio', 'Edge-Length Ratio'],
  ['edgeOrthogonality', 'Edge Orthogonality'],
  ['face', 'Face-Area Uniformity'],
  ['nodeUniformity', 'Node Uniformity'],
  ['alignment', 'Axis Alignment'],
  ['spacing', 'Spacing Uniformity']
];

function sharedLayoutMethodOptions(layoutName, overrides) {
  let key = String(layoutName || '').toLowerCase();
  if (key === 'ceg_bfs') key = 'ceg-bfs';
  if (key === 'ceg_xy') key = 'ceg-xy';
  let base = {};
  if (key === 'air' ||
      key === 'cleanair' ||
      key === 'areagrad' ||
      key === 'facebalancer' ||
      key === 'edgebalancer' ||
      key === 'anglebalancer' ||
      key === 'fabalancer' ||
      key === 'reweight' ||
      key === 'forcedir' ||
      key === 'impred') {
    base = {
      delayMs: 0,
      renderEvery: 2,
      yieldEvery: 5
    };
  }

  return Object.assign({}, base, overrides || {});
}

export function createAlgorithmSpecs(windowObj) {
  return [
    {
      key: 'tutte',
      label: 'Tutte',
      run: (cy) => windowObj.PlanarVibeTutte.applyLayout(cy)
    },
    {
      key: 'air',
      label: 'Air',
      run: (cy) => windowObj.PlanarVibeAir.applyLayout(cy, sharedLayoutMethodOptions('air'))
    },
    {
      key: 'cleanair',
      label: 'CleanAir',
      run: (cy) => windowObj.PlanarVibeCleanAir.applyLayout(cy, sharedLayoutMethodOptions('cleanair'))
    },
    {
      key: 'areagrad',
      label: 'AreaGrad',
      run: (cy) => windowObj.PlanarVibeAreaGrad.applyLayout(cy, sharedLayoutMethodOptions('areagrad'))
    },
    {
      key: 'facebalancer',
      label: 'FaceBalancer',
      run: (cy) => windowObj.PlanarVibeFaceBalancer.applyLayout(cy, sharedLayoutMethodOptions('facebalancer'))
    },
    {
      key: 'edgebalancer',
      label: 'EdgeBalancer',
      run: (cy) => windowObj.PlanarVibeEdgeBalancer.applyLayout(cy, sharedLayoutMethodOptions('edgebalancer'))
    },
    {
      key: 'anglebalancer',
      label: 'AngleBalancer',
      run: (cy) => windowObj.PlanarVibeAngleBalancer.applyLayout(cy, sharedLayoutMethodOptions('anglebalancer'))
    },
    {
      key: 'fabalancer',
      label: 'FABalancer',
      run: (cy) => windowObj.PlanarVibeFABalancer.applyLayout(cy, sharedLayoutMethodOptions('fabalancer'))
    },
    {
      key: 'gpt',
      label: 'GPT',
      run: (cy) => windowObj.PlanarVibeGPT.applyLayout(cy, sharedLayoutMethodOptions('gpt'))
    },
    {
      key: 'reweight',
      label: 'Reweight',
      run: (cy) => windowObj.PlanarVibeReweight.applyLayout(cy, sharedLayoutMethodOptions('reweight'))
    },
    {
      key: 'forcedir',
      label: 'ForceDir',
      run: (cy) => windowObj.PlanarVibeForceDir.applyLayout(cy, sharedLayoutMethodOptions('forcedir'))
    },
    {
      key: 'impred',
      label: 'ImPrEd',
      run: (cy) => windowObj.PlanarVibeImPrEd.applyLayout(cy, sharedLayoutMethodOptions('impred'))
    },
    {
      key: 'fpp',
      label: 'FPP',
      run: (cy) => windowObj.PlanarVibeFPP.applyLayout(cy)
    },
    {
      key: 'schnyder',
      label: 'Schnyder',
      run: (cy) => windowObj.PlanarVibeSchnyder.applyLayout(cy)
    },
    {
      key: 'ceg_bfs',
      label: 'CEG-bfs',
      run: (cy) => windowObj.PlanarVibeCEGBfs.applyLayout(cy)
    },
    {
      key: 'ceg_xy',
      label: 'CEG-xy',
      run: (cy) => windowObj.PlanarVibeCEGXy.applyLayout(cy)
    }
  ];
}

export function parseEdgeListText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const nodes = new Set();
  const edges = [];
  const seen = new Set();
  const positionsById = {};

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'v' || parts[0] === 'V') {
      if (parts.length >= 2) nodes.add(parts[1]);
      if (parts.length >= 4) {
        const x = Number(parts[2]);
        const y = Number(parts[3]);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          positionsById[String(parts[1])] = { x, y };
        }
      }
      continue;
    }
    if (parts.length < 2) continue;
    const a = parts[0];
    const b = parts[1];
    if (a === b) continue;
    nodes.add(a);
    nodes.add(b);
    const k = a < b ? `${a}::${b}` : `${b}::${a}`;
    if (seen.has(k)) continue;
    seen.add(k);
    edges.push([a, b]);
  }

  return { nodeIds: [...nodes], edgePairs: edges, positionsById };
}

function hashStringToSeed(text) {
  let h = 2166136261 >>> 0;
  const s = String(text || '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function createSeededRng(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return function next() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function createMockCy(nodeIds, edgePairs) {
  const nodeMap = new Map();
  let zoomLevel = 1;
  let panOffset = { x: 0, y: 0 };
  const widthPx = 900;
  const heightPx = 620;
  const edgeObjs = edgePairs.map(([u, v], i) => ({
    _id: `e${i}`,
    _u: String(u),
    _v: String(v),
    id() { return this._id; },
    source() { return { id: () => this._u }; },
    target() { return { id: () => this._v }; }
  }));

  const nodeObjs = nodeIds.map((id) => {
    const obj = {
      _id: String(id),
      _pos: { x: 0, y: 0 },
      id() { return this._id; },
      data(key) { return key === 'label' ? this._id : undefined; },
      position(pos) {
        if (pos === undefined) return { x: this._pos.x, y: this._pos.y };
        this._pos = { x: Number(pos.x) || 0, y: Number(pos.y) || 0 };
      }
    };
    nodeMap.set(obj._id, obj);
    return obj;
  });

  const nodesArr = nodeObjs;
  nodesArr.toArray = function toArray() { return nodeObjs.slice(); };

  return {
    _fitCalls: 0,
    nodes() { return nodesArr; },
    edges() { return edgeObjs; },
    width() { return widthPx; },
    height() { return heightPx; },
    zoom(value) {
      if (value === undefined) return zoomLevel;
      zoomLevel = Number(value) || 1;
      return zoomLevel;
    },
    pan(value) {
      if (value === undefined) return { x: panOffset.x, y: panOffset.y };
      panOffset = value && Number.isFinite(value.x) && Number.isFinite(value.y)
        ? { x: value.x, y: value.y }
        : { x: 0, y: 0 };
      return { x: panOffset.x, y: panOffset.y };
    },
    getElementById(id) {
      return nodeMap.get(String(id)) || { position() {} };
    },
    fit() { this._fitCalls += 1; },
    batch(fn) { if (typeof fn === 'function') fn(); },
    elements() {
      return {
        remove() {}
      };
    }
  };
}

export function seedPositions(cy, nodeIds, seedKey) {
  const byId = new Map();
  for (const node of cy.nodes()) byId.set(String(node.id()), node);
  const rng = createSeededRng(hashStringToSeed(seedKey));
  const span = Math.max(400, 30 * Math.sqrt(Math.max(1, nodeIds.length)) * 10);
  for (let i = 0; i < nodeIds.length; i += 1) {
    const id = String(nodeIds[i]);
    const node = byId.get(id);
    const jitter = i * 1e-4;
    node.position({
      x: span * rng() + jitter,
      y: span * rng() + jitter
    });
  }
}

export function initializeMockCyPositions(cy, nodeIds, seedKey, inputPositions, geometryUtils) {
  seedPositions(cy, nodeIds, seedKey);

  const rawPositions = positionsFromCy(cy);
  let hasExplicitInput = false;
  for (const id0 of nodeIds) {
    const id = String(id0);
    const p = inputPositions && inputPositions[id];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      continue;
    }
    rawPositions[id] = { x: p.x, y: p.y };
    hasExplicitInput = true;
  }

  const finalPositions = hasExplicitInput &&
    geometryUtils &&
    typeof geometryUtils.normalizePositionMapToViewport === 'function'
    ? geometryUtils.normalizePositionMapToViewport(rawPositions)
    : rawPositions;

  const byId = new Map();
  for (const node of cy.nodes()) {
    byId.set(String(node.id()), node);
  }
  for (const id of Object.keys(finalPositions)) {
    const node = byId.get(String(id));
    const p = finalPositions[id];
    if (!node || !p) {
      continue;
    }
    node.position({ x: p.x, y: p.y });
  }
  return finalPositions;
}

export function positionsFromCy(cy) {
  const out = {};
  for (const n of cy.nodes()) {
    const p = n.position();
    out[String(n.id())] = { x: p.x, y: p.y };
  }
  return out;
}

export function loadBrowserModules() {
  const windowObj = {};
  windowObj.window = windowObj;

  const context = vm.createContext({
    window: windowObj,
    console,
    Math,
    Set,
    Map,
    Array,
    Object,
    String,
    Number,
    Promise,
    setTimeout,
    clearTimeout
  });

  const files = [
    'static/js/graph-generator.js',
    'static/js/planarvibe-plugin.js',
    'static/js/linear-algebra.js',
    'static/js/geometry-utils.js',
    'static/js/planar-graph-utils.js',
    'static/js/graph-utils.js',
    'static/js/planarity-test.js',
    'static/js/metrics.js',
    'static/js/rotation.js',
    'static/js/alignment.js',
    'static/js/layout-preprocessing.js',
    'static/js/cy-runtime.js',
    'static/js/layout-tutte.js',
    'static/js/layout-random.js',
    'static/js/layout-air.js',
    'static/js/layout-cleanair.js',
    'static/js/layout-areagrad.js',
    'static/js/layout-facebalancer.js',
    'static/js/layout-edgebalancer.js',
    'static/js/layout-anglebalancer.js',
    'static/js/layout-fabalancer.js',
    'static/js/layout-gpt.js',
    'static/js/layout-reweight.js',
    'static/js/layout-forcedir.js',
    'static/js/layout-impred.js',
    'static/js/layout-fpp.js',
    'static/js/layout-schnyder.js',
    'static/js/layout-ceg.js',
    'static/js/layout-p3t.js'
  ];

  for (const rel of files) {
    const abs = path.resolve(process.cwd(), rel);
    const code = fs.readFileSync(abs, 'utf8');
    new vm.Script(code, { filename: rel }).runInContext(context);
  }
  return windowObj;
}

export function nsMs(startNs, endNs) {
  return Number(endNs - startNs) / 1e6;
}

export function formatScore(v) {
  return Number.isFinite(v) ? v.toFixed(3) : '--';
}

export function formatMs(ms) {
  return Number.isFinite(ms) ? (ms / 1000).toFixed(1) : '--';
}

export function esc(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function benefitFromRecord(rec, metricKey) {
  if (!rec || !rec.ok) return null;
  const value = rec[metricKey];
  if (!Number.isFinite(value)) return null;
  return value;
}

export function computeNormalizedRows(rows, algorithms, headers) {
  for (const row of rows) {
    row.norm = {};
    for (const alg of algorithms) {
      row.norm[alg.key] = {};
      for (const [metricKey] of headers) {
        row.norm[alg.key][metricKey] = null;
      }
    }

    for (const [metricKey] of headers) {
      let opt = null;
      for (const alg of algorithms) {
        const rec = row.alg[alg.key];
        const value = benefitFromRecord(rec, metricKey);
        if (!Number.isFinite(value)) continue;
        if (metricKey === 'runtime') {
          if (opt === null || value < opt) opt = value;
        } else if (opt === null || value > opt) {
          opt = value;
        }
      }
      if (!(Number.isFinite(opt) && opt > 0)) continue;
      for (const alg of algorithms) {
        const rec = row.alg[alg.key];
        const value = benefitFromRecord(rec, metricKey);
        if (!Number.isFinite(value)) continue;
        if (metricKey === 'runtime') {
          row.norm[alg.key][metricKey] = Math.max(0, Math.min(1, opt / value));
        } else {
          row.norm[alg.key][metricKey] = Math.max(0, Math.min(1, value / opt));
        }
      }
    }
  }
}

export function computeSummary(rows, algorithms, headers, reducer) {
  const out = {};
  for (const alg of algorithms) {
    out[alg.key] = {};
    for (const [metricKey] of headers) {
      const values = [];
      for (const row of rows) {
        const v = row.norm && row.norm[alg.key] ? row.norm[alg.key][metricKey] : null;
        if (Number.isFinite(v)) values.push(v);
      }
      out[alg.key][metricKey] = reducer(values);
    }
  }
  return out;
}

export function mean(values) {
  if (!values || values.length === 0) return null;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

export function geomean(values) {
  if (!values || values.length === 0) return null;
  let hasZero = false;
  let sumLog = 0;
  let cnt = 0;
  for (const v of values) {
    if (!(v >= 0)) continue;
    if (v === 0) {
      hasZero = true;
      continue;
    }
    sumLog += Math.log(v);
    cnt += 1;
  }
  if (hasZero) return 0;
  if (cnt === 0) return null;
  return Math.exp(sumLog / cnt);
}

export function csvEscape(value) {
  const text = String(value ?? '');
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function parseOptionalNumber(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
