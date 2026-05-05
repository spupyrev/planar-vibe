(function (global) {
  'use strict';

  // Geometric primitives and drawing checks shared across graph layouts.

  function polygonArea2(face, posById) {
    if (!face || face.length < 3) return 0;
    var sum = 0;
    for (var i = 0; i < face.length; i += 1) {
      var a = posById[String(face[i])];
      var b = posById[String(face[(i + 1) % face.length])];
      if (!a || !b) return 0;
      sum += a.x * b.y - b.x * a.y;
    }
    return sum;
  }

  function polygonAreaAbs(face, posById) {
    return Math.abs(polygonArea2(face, posById)) / 2;
  }

  function pointAdd(p, q) {
    return { x: p.x + q.x, y: p.y + q.y };
  }

  function pointSub(p, q) {
    return { x: p.x - q.x, y: p.y - q.y };
  }

  function pointScale(s, p) {
    return { x: s * p.x, y: s * p.y };
  }

  function pointDot(p, q) {
    return p.x * q.x + p.y * q.y;
  }

  function pointRot90(p) {
    return { x: -p.y, y: p.x };
  }

  function pointNorm(p) {
    return Math.sqrt(pointDot(p, p));
  }

  function vecDot(a, b) {
    var s = 0;
    for (var i = 0; i < a.length; i += 1) {
      s += a[i] * b[i];
    }
    return s;
  }

  function vecNorm(a) {
    return Math.sqrt(vecDot(a, a));
  }

  function vecAddScaled(a, b, alpha) {
    var out = new Array(a.length);
    for (var i = 0; i < a.length; i += 1) {
      out[i] = a[i] + alpha * b[i];
    }
    return out;
  }

  function vecSub(a, b) {
    var out = new Array(a.length);
    for (var i = 0; i < a.length; i += 1) {
      out[i] = a[i] - b[i];
    }
    return out;
  }

  function vecScale(a, alpha) {
    var out = new Array(a.length);
    for (var i = 0; i < a.length; i += 1) {
      out[i] = alpha * a[i];
    }
    return out;
  }

  function createZeroVector(n) {
    var length = Math.max(0, Math.floor(Number(n) || 0));
    var out = new Array(length);
    for (var i = 0; i < length; i += 1) {
      out[i] = 0;
    }
    return out;
  }

  function computeQuantile(values, q) {
    if (!values || values.length === 0) {
      return null;
    }
    var qq = Number.isFinite(q) ? Math.max(0, Math.min(1, q)) : 0.2;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var idx = qq * (sorted.length - 1);
    var lo = Math.floor(idx);
    var hi = Math.ceil(idx);
    var t = idx - lo;
    if (lo === hi) {
      return sorted[lo];
    }
    return sorted[lo] * (1 - t) + sorted[hi] * t;
  }

  function collectPositiveGaps(sortedValues, range) {
    var gaps = [];
    if (!sortedValues || sortedValues.length < 2) {
      return gaps;
    }
    var minPositiveGap = Math.max(1e-12, (Number.isFinite(range) ? range : 0) * 1e-12);
    for (var i = 1; i < sortedValues.length; i += 1) {
      var gap = sortedValues[i] - sortedValues[i - 1];
      if (gap > minPositiveGap) {
        gaps.push(gap);
      }
    }
    return gaps;
  }

  function orientFaceCCW(face, posById) {
    var out = face.slice().map(String);
    if (polygonArea2(out, posById) < 0) {
      out.reverse();
    }
    return out;
  }

  function outerFaceDiameter(posById, outerFace) {
    var face = Array.isArray(outerFace) ? outerFace : [];
    var diameter = 0;
    for (var i = 0; i < face.length; i += 1) {
      var a = posById[String(face[i])];
      if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) continue;
      for (var j = i + 1; j < face.length; j += 1) {
        var b = posById[String(face[j])];
        if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
        var dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (dist > diameter) {
          diameter = dist;
        }
      }
    }
    return diameter > 1e-12 ? diameter : 1;
  }

  function triangleArea2(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }

  function pointEquals(a, b, eps) {
    return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
  }

  function pointOnSegment(a, b, p, eps) {
    return (
      Math.min(a.x, b.x) - eps <= p.x && p.x <= Math.max(a.x, b.x) + eps &&
      Math.min(a.y, b.y) - eps <= p.y && p.y <= Math.max(a.y, b.y) + eps
    );
  }

  function pointOnSegmentInterior(a, b, p, eps) {
    if (!pointOnSegment(a, b, p, eps)) {
      return false;
    }
    if (Math.abs(triangleArea2(a, b, p)) > eps) {
      return false;
    }
    if (Math.abs(p.x - a.x) <= eps && Math.abs(p.y - a.y) <= eps) {
      return false;
    }
    if (Math.abs(p.x - b.x) <= eps && Math.abs(p.y - b.y) <= eps) {
      return false;
    }
    return true;
  }

  function segmentsIntersectOrTouch(a, b, c, d, eps) {
    var o1 = triangleArea2(a, b, c);
    var o2 = triangleArea2(a, b, d);
    var o3 = triangleArea2(c, d, a);
    var o4 = triangleArea2(c, d, b);

    if (((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps)) &&
        ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps))) {
      return true;
    }

    if (Math.abs(o1) <= eps && pointOnSegment(a, b, c, eps)) return true;
    if (Math.abs(o2) <= eps && pointOnSegment(a, b, d, eps)) return true;
    if (Math.abs(o3) <= eps && pointOnSegment(c, d, a, eps)) return true;
    if (Math.abs(o4) <= eps && pointOnSegment(c, d, b, eps)) return true;
    return false;
  }

  function computeDrawingDiameter(nodeIds, posById) {
    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    for (var i = 0; i < nodeIds.length; i += 1) {
      var id = String(nodeIds[i]);
      var p = posById ? posById[id] : null;
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        continue;
      }
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return 1;
    }
    var dx = maxX - minX;
    var dy = maxY - minY;
    var d = Math.sqrt(dx * dx + dy * dy);
    return d > 1e-9 ? d : 1;
  }

  function copyPositionMap(posById) {
    var out = {};
    var keys = Object.keys(posById || {});
    for (var i = 0; i < keys.length; i += 1) {
      var id = keys[i];
      var p = posById[id];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        continue;
      }
      out[id] = { x: p.x, y: p.y };
    }
    return out;
  }

  function filterPositionMap(posById, nodeIds) {
    var ids = Array.isArray(nodeIds) ? nodeIds.slice() : [];
    var out = {};
    for (var i = 0; i < ids.length; i += 1) {
      var id = ids[i];
      var p = posById ? posById[id] : null;
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        continue;
      }
      out[id] = { x: p.x, y: p.y };
    }
    return out;
  }

  function normalizePositionMapToViewport(posById) {
    var source = copyPositionMap(posById || {});
    var ids = Object.keys(source);
    if (ids.length === 0) {
      return source;
    }
    var defaults = global.PlanarVibeViewportDefaults || {};
    var width = Number.isFinite(defaults.width) ? defaults.width : 900;
    var height = Number.isFinite(defaults.height) ? defaults.height : 620;
    var padding = 24;
    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    var i;

    for (i = 0; i < ids.length; i += 1) {
      var p = source[ids[i]];
      if (!p) {
        continue;
      }
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return source;
    }

    var boxW = maxX - minX;
    var boxH = maxY - minY;
    var innerW = Math.max(1, width - 2 * padding);
    var innerH = Math.max(1, height - 2 * padding);

    if (boxW < 1e-9 && boxH < 1e-9) {
      for (i = 0; i < ids.length; i += 1) {
        source[ids[i]] = { x: width / 2, y: height / 2 };
      }
      return source;
    }

    var safeW = Math.max(boxW, 1e-9);
    var safeH = Math.max(boxH, 1e-9);
    var scale = Math.min(innerW / safeW, innerH / safeH);
    if (!Number.isFinite(scale) || scale <= 0) {
      scale = 1;
    }
    var offsetX = (width - boxW * scale) / 2;
    var offsetY = (height - boxH * scale) / 2;
    for (i = 0; i < ids.length; i += 1) {
      var id = ids[i];
      var point = source[id];
      source[id] = {
        x: (point.x - minX) * scale + offsetX,
        y: (point.y - minY) * scale + offsetY
      };
    }
    return source;
  }

  function computeFaceCentroid(posById, face) {
    var ids = Array.isArray(face) ? face : [];
    var sx = 0;
    var sy = 0;
    var count = 0;
    for (var i = 0; i < ids.length; i += 1) {
      var p = posById[String(ids[i])];
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

  function rotatePositionMap(posById, center, angle) {
    var out = {};
    var c = Math.cos(angle);
    var s = Math.sin(angle);
    var keys = Object.keys(posById || {});
    for (var i = 0; i < keys.length; i += 1) {
      var id = keys[i];
      var p = posById[id];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        continue;
      }
      var dx = p.x - center.x;
      var dy = p.y - center.y;
      out[id] = {
        x: center.x + c * dx - s * dy,
        y: center.y + s * dx + c * dy
      };
    }
    return out;
  }

  function hasPositionCrossings(posById, edgePairs) {
    var EPS = 1e-9;
    var i;
    var j;

    for (i = 0; i < edgePairs.length; i += 1) {
      var s1 = String(edgePairs[i][0]);
      var t1 = String(edgePairs[i][1]);
      var p1 = posById[s1];
      var q1 = posById[t1];
      if (!p1 || !q1) {
        continue;
      }

      for (j = i + 1; j < edgePairs.length; j += 1) {
        var s2 = String(edgePairs[j][0]);
        var t2 = String(edgePairs[j][1]);
        if (s1 === s2 || s1 === t2 || t1 === s2 || t1 === t2) {
          continue;
        }
        var p2 = posById[s2];
        var q2 = posById[t2];
        if (!p2 || !q2) {
          continue;
        }

        if (segmentsIntersectOrTouch(p1, q1, p2, q2, EPS)) {
          return true;
        }
      }
    }

    var nodeIds = Object.keys(posById || {});
    for (i = 0; i < nodeIds.length; i += 1) {
      var id = String(nodeIds[i]);
      var p = posById[id];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        continue;
      }
      for (j = 0; j < edgePairs.length; j += 1) {
        var u = String(edgePairs[j][0]);
        var v = String(edgePairs[j][1]);
        if (id === u || id === v) {
          continue;
        }
        var a = posById[u];
        var b = posById[v];
        if (!a || !b) {
          continue;
        }
        var area2 = triangleArea2(a, b, p);
        if (Math.abs(area2) <= EPS && pointOnSegmentInterior(a, b, p, EPS)) {
          return true;
        }
      }
    }

    return false;
  }

  global.GeometryUtils = {
    polygonArea2: polygonArea2,
    polygonAreaAbs: polygonAreaAbs,
    pointAdd: pointAdd,
    pointSub: pointSub,
    pointScale: pointScale,
    pointDot: pointDot,
    pointRot90: pointRot90,
    pointNorm: pointNorm,
    pointEquals: pointEquals,
    pointOnSegment: pointOnSegment,
    pointOnSegmentInterior: pointOnSegmentInterior,
    vecDot: vecDot,
    vecNorm: vecNorm,
    vecAddScaled: vecAddScaled,
    vecSub: vecSub,
    vecScale: vecScale,
    createZeroVector: createZeroVector,
    computeQuantile: computeQuantile,
    collectPositiveGaps: collectPositiveGaps,
    orientFaceCCW: orientFaceCCW,
    outerFaceDiameter: outerFaceDiameter,
    triangleArea2: triangleArea2,
    segmentsIntersectOrTouch: segmentsIntersectOrTouch,
    computeDrawingDiameter: computeDrawingDiameter,
    copyPositionMap: copyPositionMap,
    filterPositionMap: filterPositionMap,
    normalizePositionMapToViewport: normalizePositionMapToViewport,
    computeFaceCentroid: computeFaceCentroid,
    rotatePositionMap: rotatePositionMap,
    hasPositionCrossings: hasPositionCrossings
  };
})(window);
