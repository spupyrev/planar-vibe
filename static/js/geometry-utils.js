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

  function segmentsIntersectStrict(a, b, c, d, eps) {
    var o1 = triangleArea2(a, b, c);
    var o2 = triangleArea2(a, b, d);
    var o3 = triangleArea2(c, d, a);
    var o4 = triangleArea2(c, d, b);

    return (((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps)) &&
      ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps)));
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

  function alignOuterFaceEdgeHorizontally(posById, outerFace) {
    var face = Array.isArray(outerFace) ? outerFace.map(String) : [];
    if (face.length < 2) {
      return copyPositionMap(posById);
    }
    var bestIndex = -1;
    var bestLength2 = -1;
    for (var i = 0; i < face.length; i += 1) {
      var a = posById ? posById[face[i]] : null;
      var b = posById ? posById[face[(i + 1) % face.length]] : null;
      if (!a || !b || !Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(b.x) || !Number.isFinite(b.y)) {
        continue;
      }
      var dx = b.x - a.x;
      var dy = b.y - a.y;
      var len2 = dx * dx + dy * dy;
      if (len2 > bestLength2) {
        bestLength2 = len2;
        bestIndex = i;
      }
    }
    if (!(bestIndex >= 0) || !(bestLength2 > 1e-18)) {
      return copyPositionMap(posById);
    }
    var start = posById[face[bestIndex]];
    var end = posById[face[(bestIndex + 1) % face.length]];
    var angle = Math.atan2(end.y - start.y, end.x - start.x);
    return rotatePositionMap(posById, computeFaceCentroid(posById, face), -angle);
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

  global.GraphGeometryUtils = {
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
    orientFaceCCW: orientFaceCCW,
    outerFaceDiameter: outerFaceDiameter,
    triangleArea2: triangleArea2,
    segmentsIntersectStrict: segmentsIntersectStrict,
    segmentsIntersectOrTouch: segmentsIntersectOrTouch,
    computeDrawingDiameter: computeDrawingDiameter,
    copyPositionMap: copyPositionMap,
    computeFaceCentroid: computeFaceCentroid,
    rotatePositionMap: rotatePositionMap,
    alignOuterFaceEdgeHorizontally: alignOuterFaceEdgeHorizontally,
    hasPositionCrossings: hasPositionCrossings
  };
})(window);
