(function (global) {
  'use strict';

  var CyRuntime = global.CyRuntime;
  var Metrics = global.PlanarVibeMetrics;
  var GeometryUtils = global.GeometryUtils;
  var GraphUtils = global.GraphUtils;
  var PlanarGraphUtils = global.PlanarGraphUtils;
  var Planarity = global.PlanarVibePlanarityTest;
  var PlanarVibeTutte = global.PlanarVibeTutte;
  var LinearAlgebraUtils = global.LinearAlgebraUtils;
  var buildLayoutError = GraphUtils.buildLayoutError;
  var buildLayoutResult = GraphUtils.buildLayoutResult;
  var buildLayoutStatusMessage = GraphUtils.buildLayoutStatusMessage;
  var collectMovableVertices = GraphUtils.collectMovableVertices;
  var filterPositions = GeometryUtils.filterPositionMap;
  var hasPositionCrossings = GeometryUtils.hasPositionCrossings;
  var orientFaceCCW = GeometryUtils.orientFaceCCW;
  var pointAdd = GeometryUtils.pointAdd;
  var pointDot = GeometryUtils.pointDot;
  var pointNorm = GeometryUtils.pointNorm;
  var pointRot90 = GeometryUtils.pointRot90;
  var pointScale = GeometryUtils.pointScale;
  var pointSub = GeometryUtils.pointSub;
  var polygonArea2 = GeometryUtils.polygonArea2;
  var polygonAreaAbs = GeometryUtils.polygonAreaAbs;
  var resolveFunctionOption = GraphUtils.resolveFunctionOption;
  var luFactorize = LinearAlgebraUtils.luFactorize;
  var solveLUWithTwoRhs = LinearAlgebraUtils.solveLUWithTwoRhs;

  var CLEAN_AIR_CONFIG = {
    maxSweeps: 200,
    maxNewtonIter: 20,
    tolForceGlobal: 1e-8,
    tolForceVertex: 1e-8,
    tolAreaGlobal: 1e-3,
    tolAreaPositive: 1e-12,
    minEntropyGain: 1e-12,
    minObjectiveGain: 1e-12,
    armijo: 1e-4,
    minStep: Math.pow(2, -40),
    globalStepRel: 0.25,
    lmStepRel: 0.5,
    patternSearchMaxDim: 14,
    patternSearchMaxSteps: 250,
    patternSearchMinStep: 1e-6,
    continuationEnabled: true,
    continuationInitialStep: 0.25,
    continuationMaxStep: 0.25,
    continuationMinStep: 1 / 4096,
    continuationMaxStages: 80,
    continuationStageTol: 2e-2,
    deadlockPatience: 2
  };

  function normalizeCleanAirOptions(options) {
    var raw = options || {};
    return {
      onIteration: resolveFunctionOption(raw.onIteration, null)
    };
  }

  function chooseLongestFace(embedding) {
    var faces = embedding && Array.isArray(embedding.faces) ? embedding.faces : [];
    var best = null;
    for (var i = 0; i < faces.length; i += 1) {
      var face = faces[i];
      if (Array.isArray(face) && face.length > 3 && (!best || face.length > best.length)) {
        best = face.slice().map(String);
      }
    }
    if (best) return best;
    for (i = 0; i < faces.length; i += 1) {
      face = faces[i];
      if (Array.isArray(face) && face.length >= 3 && (!best || face.length > best.length)) {
        best = face.slice().map(String);
      }
    }
    return best || (embedding && Array.isArray(embedding.outerFace) ? embedding.outerFace.slice().map(String) : null);
  }

  function extractOriginalEmbedding(graph) {
    var embedding = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
    if (!embedding || !embedding.ok) {
      return buildLayoutError({ message: 'CleanAir requires a planar graph' });
    }
    return buildLayoutResult({
      embedding: embedding,
      outerFace: chooseLongestFace(embedding)
    });
  }

  function buildBoundedFaceRecords(embedding, outerFace, posById, targetScale) {
    var faces = Array.isArray(embedding.faces) ? embedding.faces : [];
    var outerIndex = PlanarGraphUtils.findOuterFaceIndex(faces, outerFace || []);
    var records = [];
    var targetTotal = 0;
    var scale = Number.isFinite(targetScale) && targetScale > 0 ? targetScale : 1;
    for (var i = 0; i < faces.length; i += 1) {
      if (i === outerIndex) continue;
      var rawFace = faces[i];
      if (!Array.isArray(rawFace) || rawFace.length < 3) continue;
      var targetArea = scale * (rawFace.length - 2);
      if (!(targetArea > 0)) continue;
      records.push({
        index: i,
        vertices: orientFaceCCW(rawFace.slice().map(String), posById),
        targetArea: targetArea,
        finalTargetArea: targetArea,
        seedTargetArea: targetArea
      });
      targetTotal += targetArea;
    }
    return {
      records: records,
      targetTotal: targetTotal
    };
  }

  function boundedTargetTotalForOuter(embedding, outerFace) {
    var faces = Array.isArray(embedding.faces) ? embedding.faces : [];
    var outerIndex = PlanarGraphUtils.findOuterFaceIndex(faces, outerFace || []);
    var total = 0;
    for (var i = 0; i < faces.length; i += 1) {
      if (i === outerIndex) continue;
      var face = faces[i];
      if (Array.isArray(face) && face.length >= 3) {
        total += face.length - 2;
      }
    }
    return total;
  }

  function computeTutteSeedPositions(graph) {
    if (!PlanarVibeTutte || typeof PlanarVibeTutte.computeTutteLayout !== 'function') {
      return buildLayoutError({ message: 'CleanAir initialization failed: Tutte layout is unavailable' });
    }
    var result = PlanarVibeTutte.computeTutteLayout(graph, {});
    if (!result || !result.ok || !result.positions) {
      return buildLayoutError({
        message: result && result.message
          ? result.message
          : 'CleanAir initialization failed: Tutte layout failed'
      });
    }
    return result;
  }

  function buildIncidentFaceData(graph, faceRecords) {
    var incident = {};
    var i;
    for (i = 0; i < graph.nodeIds.length; i += 1) {
      incident[String(graph.nodeIds[i])] = [];
    }
    for (i = 0; i < faceRecords.length; i += 1) {
      var face = faceRecords[i].vertices;
      for (var j = 0; j < face.length; j += 1) {
        var v = String(face[j]);
        if (!incident[v]) incident[v] = [];
        incident[v].push({
          faceIndex: i,
          left: String(face[(j - 1 + face.length) % face.length]),
          right: String(face[(j + 1) % face.length])
        });
      }
    }
    return incident;
  }

  function polygonAreaWithPoint(face, posById, vertexId, point) {
    var sum = 0;
    for (var i = 0; i < face.length; i += 1) {
      var aId = String(face[i]);
      var bId = String(face[(i + 1) % face.length]);
      var a = aId === vertexId ? point : posById[aId];
      var b = bId === vertexId ? point : posById[bId];
      if (!a || !b) return 0;
      sum += a.x * b.y - b.x * a.y;
    }
    return sum / 2;
  }

  function evaluateLocalState(vertexId, entries, faces, posById, point, tolAreaPositive) {
    var feasible = true;
    var force = { x: 0, y: 0 };
    var entropy = 0;
    var a = 0;
    var b = 0;
    var c = 0;

    for (var i = 0; i < entries.length; i += 1) {
      var entry = entries[i];
      var face = faces[entry.faceIndex];
      var leftPos = posById[entry.left];
      var rightPos = posById[entry.right];
      if (!face || !leftPos || !rightPos) {
        feasible = false;
        continue;
      }

      var area = polygonAreaWithPoint(face.vertices, posById, vertexId, point);
      if (!(area > tolAreaPositive)) {
        feasible = false;
        continue;
      }

      var s = pointSub(leftPos, rightPos);
      var r = pointRot90(s);
      var pressure = face.targetArea / area;
      force.x += pressure * r.x;
      force.y += pressure * r.y;
      entropy += -face.targetArea * Math.log(Math.max(pressure, 1e-300));

      var coeff = -0.25 * face.targetArea / (area * area);
      a += coeff * r.x * r.x;
      b += coeff * r.x * r.y;
      c += coeff * r.y * r.y;
    }

    return {
      feasible: feasible,
      force: force,
      entropy: entropy,
      a: a,
      b: b,
      c: c
    };
  }

  function solveBalancedPosition(vertexId, cleanAirData, posById, opts) {
    var p = { x: posById[vertexId].x, y: posById[vertexId].y };
    var entries = opts.entries;
    var state = opts.initialState;
    if (!entries || entries.length === 0) {
      return { pos: p, forceNorm: 0, stalled: false };
    }

    for (var iter = 0; iter < opts.maxNewtonIter; iter += 1) {
      if (!state) {
        state = evaluateLocalState(vertexId, entries, cleanAirData.faces, posById, p, opts.tolAreaPositive);
      }
      if (!state.feasible) {
        return { pos: p, forceNorm: Infinity, stalled: true };
      }

      var forceNorm = pointNorm(state.force);
      if (forceNorm <= opts.tolForceVertex) {
        return { pos: p, forceNorm: forceNorm, stalled: false };
      }

      var g = { x: 0.5 * state.force.x, y: 0.5 * state.force.y };
      var det = state.a * state.c - state.b * state.b;
      var d;
      if (det > 1e-18) {
        d = {
          x: (state.b * g.y - state.c * g.x) / det,
          y: (state.b * g.x - state.a * g.y) / det
        };
        if (!Number.isFinite(d.x) || !Number.isFinite(d.y)) {
          d = { x: g.x, y: g.y };
        }
      } else {
        d = { x: g.x, y: g.y };
      }

      if (pointDot(g, d) <= 0) {
        d = { x: g.x, y: g.y };
      }

      var alpha = 1;
      var accepted = false;
      while (alpha >= opts.minStep) {
        var q = pointAdd(p, pointScale(alpha, d));
        var qState = evaluateLocalState(vertexId, entries, cleanAirData.faces, posById, q, opts.tolAreaPositive);
        if (qState.feasible &&
            qState.entropy >= state.entropy + opts.armijo * alpha * pointDot(g, d)) {
          p = q;
          state = qState;
          accepted = true;
          break;
        }
        alpha *= 0.5;
      }

      if (!accepted) {
        return { pos: p, forceNorm: forceNorm, stalled: true };
      }
    }

    var finalState = state || evaluateLocalState(vertexId, entries, cleanAirData.faces, posById, p, opts.tolAreaPositive);
    return {
      pos: p,
      forceNorm: finalState.feasible ? pointNorm(finalState.force) : Infinity,
      stalled: false
    };
  }

  function wouldKeepPlane(vertexId, candidate, posById, edgePairs) {
    var old = posById[vertexId];
    posById[vertexId] = candidate;
    var crossed = hasPositionCrossings(posById, edgePairs);
    posById[vertexId] = old;
    return !crossed;
  }

  function computeCleanAirStats(cleanAirData, posById, movableVertices) {
    var maxRelError = 0;
    var totalEntropy = 0;
    for (var i = 0; i < cleanAirData.faces.length; i += 1) {
      var face = cleanAirData.faces[i];
      var area = polygonAreaAbs(face.vertices, posById);
      var rel = Math.abs(area - face.targetArea) / Math.max(face.targetArea, 1e-12);
      if (!Number.isFinite(rel)) rel = Infinity;
      if (rel > maxRelError) maxRelError = rel;
      if (area > 0) {
        totalEntropy += -face.targetArea * Math.log(Math.max(face.targetArea / area, 1e-300));
      }
    }

    var maxForce = 0;
    var balancedCount = 0;
    for (i = 0; i < movableVertices.length; i += 1) {
      var v = String(movableVertices[i]);
      var state = evaluateLocalState(
        v,
        cleanAirData.incident[v] || [],
        cleanAirData.faces,
        posById,
        posById[v],
        CLEAN_AIR_CONFIG.tolAreaPositive
      );
      var force = state.feasible ? pointNorm(state.force) : Infinity;
      if (force > maxForce) maxForce = force;
      if (force <= CLEAN_AIR_CONFIG.tolForceGlobal) balancedCount += 1;
    }

    return {
      maxRelError: maxRelError,
      maxForce: maxForce,
      balancedCount: balancedCount,
      entropy: totalEntropy,
      boundedFaceCount: cleanAirData.faces.length
    };
  }

  function computeGlobalEntropy(cleanAirData, posById, tolAreaPositive) {
    var total = 0;
    for (var i = 0; i < cleanAirData.faces.length; i += 1) {
      var face = cleanAirData.faces[i];
      var area = polygonAreaAbs(face.vertices, posById);
      if (!(area > tolAreaPositive)) {
        return -Infinity;
      }
      total += -face.targetArea * Math.log(Math.max(face.targetArea / area, 1e-300));
    }
    return total;
  }

  function tryGlobalPressureStep(state, currentEntropy) {
    var graph = state.graph;
    var posById = state.posById;
    var cleanAirData = state.cleanAirData;
    var movableVertices = state.movableVertices;
    var directions = {};
    var maxForce = 0;
    var i;

    for (i = 0; i < movableVertices.length; i += 1) {
      var v = String(movableVertices[i]);
      var local = evaluateLocalState(
        v,
        cleanAirData.incident[v] || [],
        cleanAirData.faces,
        posById,
        posById[v],
        CLEAN_AIR_CONFIG.tolAreaPositive
      );
      if (!local.feasible) {
        continue;
      }
      var forceNorm = pointNorm(local.force);
      if (forceNorm <= CLEAN_AIR_CONFIG.tolForceGlobal) {
        continue;
      }
      directions[v] = local.force;
      if (forceNorm > maxForce) maxForce = forceNorm;
    }

    if (!(maxForce > 0)) {
      return { accepted: false, forceBalanced: true };
    }

    var outerArea = polygonAreaAbs(state.outerFace, posById);
    var maxStep = CLEAN_AIR_CONFIG.globalStepRel * Math.sqrt(Math.max(outerArea, 1));
    var directionScale = maxStep / maxForce;
    var alpha = 1;
    while (alpha >= CLEAN_AIR_CONFIG.minStep) {
      var candidatePositions = {};
      for (i = 0; i < graph.nodeIds.length; i += 1) {
        var id = String(graph.nodeIds[i]);
        var p = posById[id];
        var d = directions[id];
        candidatePositions[id] = d
          ? {
            x: p.x + alpha * directionScale * d.x,
            y: p.y + alpha * directionScale * d.y
          }
          : { x: p.x, y: p.y };
      }
      if (!hasPositionCrossings(candidatePositions, graph.edgePairs)) {
        var entropy = computeGlobalEntropy(
          cleanAirData,
          candidatePositions,
          CLEAN_AIR_CONFIG.tolAreaPositive
        );
        if (Number.isFinite(entropy) && entropy > currentEntropy + CLEAN_AIR_CONFIG.minEntropyGain) {
          var movedCount = 0;
          var maxMove = 0;
          var sumMove = 0;
          for (i = 0; i < movableVertices.length; i += 1) {
            v = String(movableVertices[i]);
            d = directions[v];
            if (!d) continue;
            var old = posById[v];
            var next = candidatePositions[v];
            var move = pointNorm(pointSub(next, old));
            posById[v] = next;
            movedCount += 1;
            sumMove += move;
            if (move > maxMove) maxMove = move;
          }
          return {
            accepted: true,
            movedVertices: movedCount,
            maxMove: maxMove,
            avgMove: movedCount > 0 ? sumMove / movedCount : 0,
            entropy: entropy
          };
        }
      }
      alpha *= 0.5;
    }

    return { accepted: false, forceBalanced: false };
  }

  function computeAreaErrorObjective(cleanAirData, posById, tolAreaPositive) {
    var loss = 0;
    for (var i = 0; i < cleanAirData.faces.length; i += 1) {
      var face = cleanAirData.faces[i];
      var area = polygonArea2(face.vertices, posById) / 2;
      if (!(area > tolAreaPositive)) {
        return Infinity;
      }
      var rel = (area - face.targetArea) / Math.max(face.targetArea, 1e-12);
      loss += 0.5 * rel * rel;
    }
    return loss;
  }

  function computeAreaSystem(state, posById) {
    var cleanAirData = state.cleanAirData;
    var movableVertices = state.movableVertices;
    var dim = 2 * movableVertices.length;
    var indexById = {};
    var i;
    var j;
    for (i = 0; i < movableVertices.length; i += 1) {
      indexById[String(movableVertices[i])] = i;
    }

    var JTJ = new Array(dim);
    var JTr = new Array(dim);
    for (i = 0; i < dim; i += 1) {
      JTJ[i] = new Array(dim);
      for (j = 0; j < dim; j += 1) {
        JTJ[i][j] = 0;
      }
      JTr[i] = 0;
    }

    var loss = 0;
    var maxRelError = 0;
    for (i = 0; i < cleanAirData.faces.length; i += 1) {
      var face = cleanAirData.faces[i];
      var area = polygonArea2(face.vertices, posById) / 2;
      if (!(area > CLEAN_AIR_CONFIG.tolAreaPositive)) {
        return {
          ok: false,
          reason: 'nonpositive-face',
          faceIndex: face.index,
          area: area
        };
      }
      var target = Math.max(face.targetArea, 1e-12);
      var residual = (area - face.targetArea) / target;
      var absRel = Math.abs(residual);
      if (absRel > maxRelError) maxRelError = absRel;
      loss += 0.5 * residual * residual;

      var row = new Array(dim);
      for (j = 0; j < dim; j += 1) row[j] = 0;
      for (j = 0; j < face.vertices.length; j += 1) {
        var v = String(face.vertices[j]);
        var vi = indexById[v];
        if (vi === undefined) continue;
        var left = String(face.vertices[(j - 1 + face.vertices.length) % face.vertices.length]);
        var right = String(face.vertices[(j + 1) % face.vertices.length]);
        var r = pointRot90(pointSub(posById[left], posById[right]));
        row[2 * vi] += 0.5 * r.x / target;
        row[2 * vi + 1] += 0.5 * r.y / target;
      }
      for (j = 0; j < dim; j += 1) {
        JTr[j] += row[j] * residual;
        for (var k = 0; k < dim; k += 1) {
          JTJ[j][k] += row[j] * row[k];
        }
      }
    }

    return {
      ok: true,
      loss: loss,
      maxRelError: maxRelError,
      gradNorm: Math.sqrt(JTr.reduce(function (sum, value) {
        return sum + value * value;
      }, 0)),
      JTJ: JTJ,
      JTr: JTr,
      indexById: indexById,
      dim: dim
    };
  }

  function clonePositionMap(posById, nodeIds) {
    var out = {};
    for (var i = 0; i < nodeIds.length; i += 1) {
      var id = String(nodeIds[i]);
      var p = posById[id];
      out[id] = p ? { x: p.x, y: p.y } : { x: 0, y: 0 };
    }
    return out;
  }

  function replaceStatePositions(state, positions) {
    state.posById = clonePositionMap(positions, state.graph.nodeIds);
    state.positions = state.posById;
  }

  function initializeContinuationTargets(faceRecords, posById) {
    for (var i = 0; i < faceRecords.length; i += 1) {
      var face = faceRecords[i];
      face.finalTargetArea = face.targetArea;
      var seedArea = polygonArea2(face.vertices, posById) / 2;
      face.seedTargetArea = seedArea > CLEAN_AIR_CONFIG.tolAreaPositive
        ? seedArea
        : face.finalTargetArea;
    }
  }

  function setContinuationTargets(cleanAirData, t) {
    var clamped = Math.max(0, Math.min(1, t));
    var total = 0;
    for (var i = 0; i < cleanAirData.faces.length; i += 1) {
      var face = cleanAirData.faces[i];
      var seed = Number.isFinite(face.seedTargetArea) ? face.seedTargetArea : face.targetArea;
      var finalTarget = Number.isFinite(face.finalTargetArea) ? face.finalTargetArea : face.targetArea;
      face.targetArea = (1 - clamped) * seed + clamped * finalTarget;
      total += face.targetArea;
    }
    cleanAirData.targetTotal = total;
  }

  function boundedFacesArePositive(cleanAirData, posById) {
    for (var i = 0; i < cleanAirData.faces.length; i += 1) {
      var area = polygonArea2(cleanAirData.faces[i].vertices, posById) / 2;
      if (!(area > CLEAN_AIR_CONFIG.tolAreaPositive)) {
        return false;
      }
    }
    return true;
  }

  function applyCandidatePositions(posById, candidatePositions, movableVertices) {
    var movedCount = 0;
    var maxMove = 0;
    var sumMove = 0;
    for (var i = 0; i < movableVertices.length; i += 1) {
      var id = String(movableVertices[i]);
      var old = posById[id];
      var next = candidatePositions[id];
      if (!old || !next) continue;
      var move = pointNorm(pointSub(next, old));
      posById[id] = next;
      movedCount += 1;
      sumMove += move;
      if (move > maxMove) maxMove = move;
    }
    return {
      movedVertices: movedCount,
      maxMove: maxMove,
      avgMove: movedCount > 0 ? sumMove / movedCount : 0
    };
  }

  function tryLevenbergMarquardtAreaStep(state, currentSystem) {
    var graph = state.graph;
    var posById = state.posById;
    var movableVertices = state.movableVertices;
    var dim = currentSystem.dim;
    if (dim === 0) {
      return { accepted: false, reason: 'no-movable-vertices' };
    }
    if (!(currentSystem.gradNorm > 0)) {
      return { accepted: false, reason: 'zero-gradient' };
    }

    var outerArea = polygonAreaAbs(state.outerFace, posById);
    var maxStep = CLEAN_AIR_CONFIG.lmStepRel * Math.sqrt(Math.max(outerArea, 1));
    var zero = new Array(dim);
    var i;
    for (i = 0; i < dim; i += 1) zero[i] = 0;

    var lambdas = [
      1e-10, 1e-8, 1e-6, 1e-4, 1e-2,
      1, 100, 1e4, 1e6, 1e8
    ];
    var diagnostics = {
      singular: 0,
      nonfiniteStep: 0,
      nonpositiveFace: 0,
      crossings: 0,
      noImprovement: 0,
      maxRelIncrease: 0,
      tested: 0,
      bestLoss: Infinity,
      bestMaxRelError: Infinity,
      bestAlpha: 0,
      bestLambda: null
    };
    var bestStrictCandidate = null;
    var bestRelaxedCandidate = null;

    for (var li = 0; li < lambdas.length; li += 1) {
      var lambda = lambdas[li];
      var A = new Array(dim);
      var b = new Array(dim);
      for (i = 0; i < dim; i += 1) {
        A[i] = currentSystem.JTJ[i].slice();
        A[i][i] += lambda * Math.max(currentSystem.JTJ[i][i], 1e-8);
        b[i] = -currentSystem.JTr[i];
      }
      var factor = luFactorize(A);
      var solved = factor ? solveLUWithTwoRhs(factor, b, zero) : null;
      if (!solved || !solved.x1) {
        diagnostics.singular += 1;
        continue;
      }
      var step = solved.x1;
      var stepNorm = 0;
      var finite = true;
      for (i = 0; i < movableVertices.length; i += 1) {
        var sx = step[2 * i];
        var sy = step[2 * i + 1];
        if (!Number.isFinite(sx) || !Number.isFinite(sy)) {
          finite = false;
          break;
        }
        var sn = Math.sqrt(sx * sx + sy * sy);
        if (sn > stepNorm) stepNorm = sn;
      }
      if (!finite || !(stepNorm > 0)) {
        diagnostics.nonfiniteStep += 1;
        continue;
      }

      var stepScale = stepNorm > maxStep ? maxStep / stepNorm : 1;
      var alpha = 1;
      while (alpha >= CLEAN_AIR_CONFIG.minStep) {
        diagnostics.tested += 1;
        var candidatePositions = clonePositionMap(posById, graph.nodeIds);
        for (i = 0; i < movableVertices.length; i += 1) {
          var id = String(movableVertices[i]);
          var p = posById[id];
          candidatePositions[id] = {
            x: p.x + alpha * stepScale * step[2 * i],
            y: p.y + alpha * stepScale * step[2 * i + 1]
          };
        }
        if (!boundedFacesArePositive(state.cleanAirData, candidatePositions)) {
          diagnostics.nonpositiveFace += 1;
          alpha *= 0.5;
          continue;
        }
        if (hasPositionCrossings(candidatePositions, graph.edgePairs)) {
          diagnostics.crossings += 1;
          alpha *= 0.5;
          continue;
        }
        var candidateSystem = computeAreaSystem(state, candidatePositions);
        if (!candidateSystem.ok) {
          diagnostics.nonpositiveFace += 1;
          alpha *= 0.5;
          continue;
        }
        if (candidateSystem.loss < diagnostics.bestLoss) {
          diagnostics.bestLoss = candidateSystem.loss;
          diagnostics.bestMaxRelError = candidateSystem.maxRelError;
          diagnostics.bestAlpha = alpha * stepScale;
          diagnostics.bestLambda = lambda;
        }
        if (candidateSystem.loss < currentSystem.loss - CLEAN_AIR_CONFIG.minObjectiveGain) {
          var candidate = {
            positions: candidatePositions,
            system: candidateSystem,
            lambda: lambda,
            alpha: alpha * stepScale
          };
          if (candidateSystem.maxRelError <= currentSystem.maxRelError + CLEAN_AIR_CONFIG.minObjectiveGain) {
            if (!bestStrictCandidate || candidateSystem.loss < bestStrictCandidate.system.loss) {
              bestStrictCandidate = candidate;
            }
          } else {
            diagnostics.maxRelIncrease += 1;
            if (state.allowRelaxedAreaSteps &&
                (!bestRelaxedCandidate || candidateSystem.loss < bestRelaxedCandidate.system.loss)) {
              bestRelaxedCandidate = candidate;
            }
            alpha *= 0.5;
            continue;
          }
          break;
        }
        diagnostics.noImprovement += 1;
        alpha *= 0.5;
      }
    }

    var bestCandidate = bestStrictCandidate || bestRelaxedCandidate;
    if (bestCandidate) {
      var moveStats = applyCandidatePositions(posById, bestCandidate.positions, movableVertices);
      return {
        accepted: true,
        movedVertices: moveStats.movedVertices,
        maxMove: moveStats.maxMove,
        avgMove: moveStats.avgMove,
        loss: bestCandidate.system.loss,
        maxRelError: bestCandidate.system.maxRelError,
        gradNorm: bestCandidate.system.gradNorm,
        lambda: bestCandidate.lambda,
        alpha: bestCandidate.alpha,
        diagnostics: diagnostics
      };
    }

    return {
      accepted: false,
      reason: diagnostics.tested > 0 ? 'no-acceptable-lm-step' : 'no-linear-solve',
      diagnostics: diagnostics,
      loss: currentSystem.loss,
      gradNorm: currentSystem.gradNorm,
      maxRelError: currentSystem.maxRelError
    };
  }

  function buildPatternSearchDirections(dim) {
    var directions = [];
    var i;
    var j;
    for (i = 0; i < dim; i += 1) {
      var d = new Array(dim);
      var e = new Array(dim);
      for (j = 0; j < dim; j += 1) {
        d[j] = 0;
        e[j] = 0;
      }
      d[i] = 1;
      e[i] = -1;
      directions.push(d);
      directions.push(e);
    }
    for (i = 0; i < dim; i += 1) {
      for (j = i + 1; j < dim; j += 1) {
        var signs = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
        for (var si = 0; si < signs.length; si += 1) {
          d = new Array(dim);
          for (var k = 0; k < dim; k += 1) d[k] = 0;
          d[i] = signs[si][0] / Math.SQRT2;
          d[j] = signs[si][1] / Math.SQRT2;
          directions.push(d);
        }
      }
    }
    return directions;
  }

  function makePatternCandidate(state, direction, step) {
    var graph = state.graph;
    var posById = state.posById;
    var movableVertices = state.movableVertices;
    var candidatePositions = clonePositionMap(posById, graph.nodeIds);
    for (var i = 0; i < movableVertices.length; i += 1) {
      var id = String(movableVertices[i]);
      var p = posById[id];
      candidatePositions[id] = {
        x: p.x + step * direction[2 * i],
        y: p.y + step * direction[2 * i + 1]
      };
    }
    return candidatePositions;
  }

  function tryPatternSearchAreaStep(state, currentSystem) {
    var graph = state.graph;
    var movableVertices = state.movableVertices;
    var dim = 2 * movableVertices.length;
    if (dim === 0) {
      return { accepted: false, reason: 'no-movable-vertices' };
    }
    if (dim > CLEAN_AIR_CONFIG.patternSearchMaxDim) {
      return { accepted: false, reason: 'pattern-dimension-limit' };
    }

    var directions = buildPatternSearchDirections(dim);
    var outerArea = polygonAreaAbs(state.outerFace, state.posById);
    var step = 0.25 * Math.sqrt(Math.max(outerArea, 1));
    var current = currentSystem;
    var acceptedAny = false;
    var totalMove = { movedVertices: 0, maxMove: 0, avgMove: 0 };
    var diagnostics = {
      accepted: 0,
      shrink: 0,
      tested: 0,
      crossings: 0,
      nonpositiveFace: 0,
      noImprovement: 0,
      maxRelIncrease: 0,
      finalStep: step
    };

    for (var iter = 0; iter < CLEAN_AIR_CONFIG.patternSearchMaxSteps &&
         step >= CLEAN_AIR_CONFIG.patternSearchMinStep &&
         current.maxRelError > CLEAN_AIR_CONFIG.tolAreaGlobal; iter += 1) {
      var bestStrictPositions = null;
      var bestStrictSystem = current;
      var bestRelaxedPositions = null;
      var bestRelaxedSystem = current;
      for (var di = 0; di < directions.length; di += 1) {
        diagnostics.tested += 1;
        var candidatePositions = makePatternCandidate(state, directions[di], step);
        if (!boundedFacesArePositive(state.cleanAirData, candidatePositions)) {
          diagnostics.nonpositiveFace += 1;
          continue;
        }
        if (hasPositionCrossings(candidatePositions, graph.edgePairs)) {
          diagnostics.crossings += 1;
          continue;
        }
        var candidateSystem = computeAreaSystem(state, candidatePositions);
        if (!candidateSystem.ok) {
          diagnostics.nonpositiveFace += 1;
          continue;
        }
        if (candidateSystem.loss < current.loss - CLEAN_AIR_CONFIG.minObjectiveGain) {
          if (candidateSystem.maxRelError <= current.maxRelError + CLEAN_AIR_CONFIG.minObjectiveGain) {
            if (!bestStrictPositions || candidateSystem.loss < bestStrictSystem.loss) {
              bestStrictSystem = candidateSystem;
              bestStrictPositions = candidatePositions;
            }
          } else {
            diagnostics.maxRelIncrease += 1;
            if (state.allowRelaxedAreaSteps &&
                (!bestRelaxedPositions || candidateSystem.loss < bestRelaxedSystem.loss)) {
              bestRelaxedSystem = candidateSystem;
              bestRelaxedPositions = candidatePositions;
            }
          }
        } else {
          diagnostics.noImprovement += 1;
        }
      }

      var bestPositions = bestStrictPositions || bestRelaxedPositions;
      var bestSystem = bestStrictPositions ? bestStrictSystem : bestRelaxedSystem;
      if (bestPositions) {
        var moveStats = applyCandidatePositions(state.posById, bestPositions, movableVertices);
        acceptedAny = true;
        diagnostics.accepted += 1;
        current = bestSystem;
        totalMove.movedVertices = moveStats.movedVertices;
        totalMove.maxMove = Math.max(totalMove.maxMove, moveStats.maxMove);
        totalMove.avgMove = moveStats.avgMove;
      } else {
        step *= 0.5;
        diagnostics.shrink += 1;
      }
      diagnostics.finalStep = step;
    }

    if (!acceptedAny) {
      return {
        accepted: false,
        reason: 'no-pattern-step',
        diagnostics: diagnostics,
        loss: currentSystem.loss,
        gradNorm: currentSystem.gradNorm,
        maxRelError: currentSystem.maxRelError
      };
    }
    return {
      accepted: true,
      movedVertices: totalMove.movedVertices,
      maxMove: totalMove.maxMove,
      avgMove: totalMove.avgMove,
      loss: current.loss,
      maxRelError: current.maxRelError,
      gradNorm: current.gradNorm,
      diagnostics: diagnostics
    };
  }

  function tryGlobalAreaErrorStep(state, currentLoss) {
    var graph = state.graph;
    var posById = state.posById;
    var cleanAirData = state.cleanAirData;
    var movableVertices = state.movableVertices;
    var movableSet = {};
    var gradients = {};
    var i;
    var j;

    for (i = 0; i < movableVertices.length; i += 1) {
      var id = String(movableVertices[i]);
      movableSet[id] = true;
      gradients[id] = { x: 0, y: 0 };
    }

    for (i = 0; i < cleanAirData.faces.length; i += 1) {
      var face = cleanAirData.faces[i];
      var area = polygonAreaAbs(face.vertices, posById);
      if (!(area > CLEAN_AIR_CONFIG.tolAreaPositive)) {
        return { accepted: false };
      }
      var rel = (area - face.targetArea) / Math.max(face.targetArea, 1e-12);
      var coeff = 0.5 * rel / Math.max(face.targetArea, 1e-12);
      for (j = 0; j < face.vertices.length; j += 1) {
        var v = String(face.vertices[j]);
        if (!movableSet[v]) continue;
        var left = String(face.vertices[(j - 1 + face.vertices.length) % face.vertices.length]);
        var right = String(face.vertices[(j + 1) % face.vertices.length]);
        var r = pointRot90(pointSub(posById[left], posById[right]));
        gradients[v].x += coeff * r.x;
        gradients[v].y += coeff * r.y;
      }
    }

    var maxGrad = 0;
    for (i = 0; i < movableVertices.length; i += 1) {
      id = String(movableVertices[i]);
      var gradNorm = pointNorm(gradients[id]);
      if (gradNorm > maxGrad) maxGrad = gradNorm;
    }
    if (!(maxGrad > 0)) {
      return { accepted: false };
    }

    var outerArea = polygonAreaAbs(state.outerFace, posById);
    var maxStep = CLEAN_AIR_CONFIG.globalStepRel * Math.sqrt(Math.max(outerArea, 1));
    var directionScale = maxStep / maxGrad;
    var alpha = 1;
    while (alpha >= CLEAN_AIR_CONFIG.minStep) {
      var candidatePositions = {};
      for (i = 0; i < graph.nodeIds.length; i += 1) {
        id = String(graph.nodeIds[i]);
        var p = posById[id];
        var g = gradients[id];
        candidatePositions[id] = g
          ? {
            x: p.x - alpha * directionScale * g.x,
            y: p.y - alpha * directionScale * g.y
          }
          : { x: p.x, y: p.y };
      }
      if (!hasPositionCrossings(candidatePositions, graph.edgePairs)) {
        var loss = computeAreaErrorObjective(
          cleanAirData,
          candidatePositions,
          CLEAN_AIR_CONFIG.tolAreaPositive
        );
        if (Number.isFinite(loss) && loss < currentLoss - CLEAN_AIR_CONFIG.minObjectiveGain) {
          var movedCount = 0;
          var maxMove = 0;
          var sumMove = 0;
          for (i = 0; i < movableVertices.length; i += 1) {
            id = String(movableVertices[i]);
            g = gradients[id];
            if (!g) continue;
            var old = posById[id];
            var next = candidatePositions[id];
            var move = pointNorm(pointSub(next, old));
            posById[id] = next;
            movedCount += 1;
            sumMove += move;
            if (move > maxMove) maxMove = move;
          }
          return {
            accepted: true,
            movedVertices: movedCount,
            maxMove: maxMove,
            avgMove: movedCount > 0 ? sumMove / movedCount : 0,
            loss: loss
          };
        }
      }
      alpha *= 0.5;
    }

    return { accepted: false };
  }

  function tryGlobalAreaNewtonStep(state, currentLoss) {
    var graph = state.graph;
    var posById = state.posById;
    var cleanAirData = state.cleanAirData;
    var movableVertices = state.movableVertices;
    var dim = 2 * movableVertices.length;
    if (dim === 0) {
      return { accepted: false };
    }

    var indexById = {};
    var i;
    var j;
    for (i = 0; i < movableVertices.length; i += 1) {
      indexById[String(movableVertices[i])] = i;
    }

    var JTJ = new Array(dim);
    var JTr = new Array(dim);
    for (i = 0; i < dim; i += 1) {
      JTJ[i] = new Array(dim);
      for (j = 0; j < dim; j += 1) {
        JTJ[i][j] = 0;
      }
      JTr[i] = 0;
    }

    for (i = 0; i < cleanAirData.faces.length; i += 1) {
      var face = cleanAirData.faces[i];
      var area = polygonAreaAbs(face.vertices, posById);
      if (!(area > CLEAN_AIR_CONFIG.tolAreaPositive)) {
        return { accepted: false };
      }
      var target = Math.max(face.targetArea, 1e-12);
      var residual = (area - face.targetArea) / target;
      var row = new Array(dim);
      for (j = 0; j < dim; j += 1) row[j] = 0;
      for (j = 0; j < face.vertices.length; j += 1) {
        var v = String(face.vertices[j]);
        var vi = indexById[v];
        if (vi === undefined) continue;
        var left = String(face.vertices[(j - 1 + face.vertices.length) % face.vertices.length]);
        var right = String(face.vertices[(j + 1) % face.vertices.length]);
        var r = pointRot90(pointSub(posById[left], posById[right]));
        row[2 * vi] += 0.5 * r.x / target;
        row[2 * vi + 1] += 0.5 * r.y / target;
      }
      for (j = 0; j < dim; j += 1) {
        JTr[j] += row[j] * residual;
        for (var k = 0; k < dim; k += 1) {
          JTJ[j][k] += row[j] * row[k];
        }
      }
    }

    var lambdas = [1e-8, 1e-6, 1e-4, 1e-2, 1, 100];
    var zero = new Array(dim);
    for (i = 0; i < dim; i += 1) zero[i] = 0;
    var outerArea = polygonAreaAbs(state.outerFace, posById);
    var maxStep = 2 * CLEAN_AIR_CONFIG.globalStepRel * Math.sqrt(Math.max(outerArea, 1));

    for (var li = 0; li < lambdas.length; li += 1) {
      var lambda = lambdas[li];
      var A = new Array(dim);
      var b = new Array(dim);
      for (i = 0; i < dim; i += 1) {
        A[i] = JTJ[i].slice();
        A[i][i] += lambda * Math.max(JTJ[i][i], 1e-8);
        b[i] = -JTr[i];
      }
      var factor = luFactorize(A);
      var solved = factor ? solveLUWithTwoRhs(factor, b, zero) : null;
      if (!solved || !solved.x1) continue;
      var step = solved.x1;
      var stepNorm = 0;
      for (i = 0; i < movableVertices.length; i += 1) {
        var sx = step[2 * i];
        var sy = step[2 * i + 1];
        var sn = Math.sqrt(sx * sx + sy * sy);
        if (sn > stepNorm) stepNorm = sn;
      }
      if (!(stepNorm > 0)) continue;
      var stepScale = stepNorm > maxStep ? maxStep / stepNorm : 1;
      var alpha = 1;
      while (alpha >= CLEAN_AIR_CONFIG.minStep) {
        var candidatePositions = {};
        for (i = 0; i < graph.nodeIds.length; i += 1) {
          var id = String(graph.nodeIds[i]);
          var p = posById[id];
          vi = indexById[id];
          candidatePositions[id] = vi === undefined
            ? { x: p.x, y: p.y }
            : {
              x: p.x + alpha * stepScale * step[2 * vi],
              y: p.y + alpha * stepScale * step[2 * vi + 1]
            };
        }
        if (!hasPositionCrossings(candidatePositions, graph.edgePairs)) {
          var loss = computeAreaErrorObjective(
            cleanAirData,
            candidatePositions,
            CLEAN_AIR_CONFIG.tolAreaPositive
          );
          if (Number.isFinite(loss) && loss < currentLoss - CLEAN_AIR_CONFIG.minObjectiveGain) {
            var movedCount = 0;
            var maxMove = 0;
            var sumMove = 0;
            for (i = 0; i < movableVertices.length; i += 1) {
              id = String(movableVertices[i]);
              p = posById[id];
              var next = candidatePositions[id];
              var move = pointNorm(pointSub(next, p));
              posById[id] = next;
              movedCount += 1;
              sumMove += move;
              if (move > maxMove) maxMove = move;
            }
            return {
              accepted: true,
              movedVertices: movedCount,
              maxMove: maxMove,
              avgMove: movedCount > 0 ? sumMove / movedCount : 0,
              loss: loss
            };
          }
        }
        alpha *= 0.5;
      }
    }

    return { accepted: false };
  }

  function buildCleanAirState(graph, options) {
    var opts = normalizeCleanAirOptions(options);
    var embeddingResult = extractOriginalEmbedding(graph);
    if (!embeddingResult.ok) {
      return embeddingResult;
    }
    var embedding = embeddingResult.embedding;
    var preferredOuterFace = embeddingResult.outerFace;
    if (!Array.isArray(preferredOuterFace) || preferredOuterFace.length < 3) {
      return buildLayoutError({ message: 'CleanAir could not determine an outer face' });
    }
    var n = graph.nodeIds.length;
    var m = graph.edgePairs.length;
    var isQuadrangulation = m === 2 * n - 4;
    var isTriangulation = m === 3 * n - 6;
    if (!isQuadrangulation && !isTriangulation) {
      return buildLayoutError({
        message: 'CleanAir requires a quadrangulated graph (m = 2n - 4) or triangulated graph (m = 3n - 6)'
      });
    }

    var outerFace = preferredOuterFace.slice().map(String);
    var rawTargetTotal = boundedTargetTotalForOuter(embedding, outerFace);
    if (!(rawTargetTotal > 0)) {
      return buildLayoutError({ message: 'CleanAir requires at least one bounded face' });
    }
    var initial = computeTutteSeedPositions(graph);
    if (!initial.ok || !initial.positions || hasPositionCrossings(initial.positions, graph.edgePairs)) {
      return buildLayoutError({ message: 'CleanAir initialization produced a non-plane drawing' });
    }
    var posById = initial.positions;
    var fixedOuterArea = polygonAreaAbs(outerFace, posById);
    if (!(fixedOuterArea > 0)) {
      return buildLayoutError({ message: 'CleanAir initialization produced a degenerate outer face' });
    }
    var targetScale = fixedOuterArea / rawTargetTotal;

    var faceBuild = buildBoundedFaceRecords(embedding, outerFace, posById, targetScale);
    if (faceBuild.records.length === 0) {
      return buildLayoutError({ message: 'CleanAir requires at least one bounded face' });
    }
    initializeContinuationTargets(faceBuild.records, posById);
    var incident = buildIncidentFaceData(graph, faceBuild.records);
    var movableVertices = collectMovableVertices(graph.nodeIds, outerFace);
    return buildLayoutResult({
      graph: graph,
      embedding: embedding,
      outerFace: outerFace,
      posById: posById,
      positions: posById,
      seedPositions: clonePositionMap(posById, graph.nodeIds),
      allowRelaxedAreaSteps: false,
      movableVertices: movableVertices,
      opts: opts,
      cleanAirData: {
        faces: faceBuild.records,
        incident: incident,
        targetTotal: faceBuild.targetTotal
      }
    });
  }

  async function runCleanAirIterations(state, options) {
    var graph = state.graph;
    var posById = state.posById;
    var cleanAirData = state.cleanAirData;
    var movableVertices = state.movableVertices;
    var status = 'max_sweeps';
    var lastStats = computeCleanAirStats(cleanAirData, posById, movableVertices);
    var deadSweeps = 0;
    var lastMoveStats = { movedVertices: 0, avgMove: 0, maxMove: 0, acceptedCount: 0 };
    var lastStep = null;

    if (lastStats.maxRelError <= CLEAN_AIR_CONFIG.tolAreaGlobal) {
      lastStats.sweeps = 0;
      return {
        status: 'realized',
        stats: lastStats,
        moveStats: lastMoveStats,
        hasCrossings: hasPositionCrossings(posById, graph.edgePairs)
      };
    }

    for (var sweep = 1; sweep <= CLEAN_AIR_CONFIG.maxSweeps; sweep += 1) {
      var currentSystem = computeAreaSystem(state, posById);
      if (!currentSystem.ok) {
        status = currentSystem.reason || 'invalid-area-state';
        lastStep = currentSystem;
        break;
      }

      var lmStep = tryLevenbergMarquardtAreaStep(state, currentSystem);
      if (!lmStep.accepted) {
        var patternStep = tryPatternSearchAreaStep(state, currentSystem);
        if (patternStep.accepted) {
          lmStep = patternStep;
        } else if (lmStep.diagnostics && patternStep.diagnostics) {
          lmStep.patternDiagnostics = patternStep.diagnostics;
        }
      }
      lastStep = lmStep;
      var acceptedCount = lmStep.accepted ? lmStep.movedVertices : 0;
      var maxMove = lmStep.accepted ? lmStep.maxMove : 0;
      var avgMove = lmStep.accepted ? lmStep.avgMove : 0;

      lastMoveStats = {
        movedVertices: acceptedCount,
        avgMove: avgMove,
        maxMove: maxMove,
        acceptedCount: acceptedCount
      };
      lastStats = computeCleanAirStats(cleanAirData, posById, movableVertices);
      var maxRelErr = lastStats.maxRelError;
      lastStats.maxMove = maxMove;
      lastStats.avgMove = lastMoveStats.avgMove;
      lastStats.acceptedCount = acceptedCount;
      lastStats.sweeps = sweep;
      lastStats.objective = lmStep.accepted ? lmStep.loss : currentSystem.loss;
      lastStats.gradNorm = lmStep.accepted ? lmStep.gradNorm : currentSystem.gradNorm;
      lastStats.failureReason = lmStep.accepted ? null : lmStep.reason;
      lastStats.lmDiagnostics = lmStep.diagnostics || null;
      lastStats.patternDiagnostics = lmStep.patternDiagnostics || null;

      if (options.onIteration) {
        await options.onIteration({
          iter: sweep,
          maxIters: CLEAN_AIR_CONFIG.maxSweeps,
          status: status,
          positions: posById,
          movedVertices: acceptedCount,
          maxMove: maxMove,
          avgMove: lastMoveStats.avgMove,
          maxRelError: maxRelErr,
          debug: {
            maxForce: lastStats.maxForce,
            balancedCount: lastStats.balancedCount,
            acceptedCount: acceptedCount,
            deadSweepCount: deadSweeps,
            boundedFaceCount: lastStats.boundedFaceCount,
            objective: lastStats.objective,
            gradNorm: lastStats.gradNorm,
            failureReason: lastStats.failureReason,
            lmDiagnostics: lastStats.lmDiagnostics,
            patternDiagnostics: lastStats.patternDiagnostics
          }
        });
      }

      if (maxRelErr <= CLEAN_AIR_CONFIG.tolAreaGlobal) {
        status = 'realized';
        break;
      }

      if (acceptedCount === 0) {
        deadSweeps += 1;
      } else {
        deadSweeps = 0;
      }
      if (deadSweeps >= CLEAN_AIR_CONFIG.deadlockPatience) {
        status = 'blocked';
        break;
      }
    }

    return {
      status: status,
      stats: lastStats,
      moveStats: lastMoveStats,
      lastStep: lastStep,
      hasCrossings: hasPositionCrossings(posById, graph.edgePairs)
    };
  }

  async function runContinuationIterations(state) {
    var diagnostics = {
      enabled: true,
      acceptedStages: 0,
      rejectedStages: 0,
      stages: [],
      finalT: 0,
      minStepReached: false
    };
    var t = 0;
    var step = CLEAN_AIR_CONFIG.continuationInitialStep;
    var lastResult = null;

    replaceStatePositions(state, state.seedPositions);
    setContinuationTargets(state.cleanAirData, 0);

    for (var stage = 0;
         stage < CLEAN_AIR_CONFIG.continuationMaxStages && t < 1;
         stage += 1) {
      var fromT = t;
      var toT = Math.min(1, t + step);
      var backupPositions = clonePositionMap(state.posById, state.graph.nodeIds);

      setContinuationTargets(state.cleanAirData, toT);
      state.allowRelaxedAreaSteps = false;
      var result = await runCleanAirIterations(state, { onIteration: null });

      if (result.status !== 'realized') {
        replaceStatePositions(state, backupPositions);
        setContinuationTargets(state.cleanAirData, toT);
        state.allowRelaxedAreaSteps = true;
        var relaxedResult = await runCleanAirIterations(state, { onIteration: null });
        var strictErr = result.stats && Number.isFinite(result.stats.maxRelError)
          ? result.stats.maxRelError
          : Infinity;
        var relaxedErr = relaxedResult.stats && Number.isFinite(relaxedResult.stats.maxRelError)
          ? relaxedResult.stats.maxRelError
          : Infinity;
        if (relaxedResult.status === 'realized' || relaxedErr < strictErr) {
          result = relaxedResult;
          result.relaxedContinuationStage = true;
        } else {
          replaceStatePositions(state, backupPositions);
          setContinuationTargets(state.cleanAirData, toT);
        }
        state.allowRelaxedAreaSteps = false;
      }
      lastResult = result;

      var stats = result.stats || {};
      var stageError = Number.isFinite(stats.maxRelError) ? stats.maxRelError : Infinity;
      var finalStage = toT >= 1;
      diagnostics.stages.push({
        from: fromT,
        to: toT,
        step: step,
        status: result.status,
        maxRelError: Number.isFinite(stageError) ? stageError : null,
        failureReason: stats.failureReason || null,
        relaxed: !!result.relaxedContinuationStage,
        acceptedInexact: result.status !== 'realized' &&
          !finalStage &&
          stageError <= CLEAN_AIR_CONFIG.continuationStageTol
      });

      if (result.status === 'realized' ||
          (!finalStage && stageError <= CLEAN_AIR_CONFIG.continuationStageTol)) {
        t = toT;
        diagnostics.acceptedStages += 1;
        diagnostics.finalT = t;
        step = Math.min(CLEAN_AIR_CONFIG.continuationMaxStep, step * 1.5);
        continue;
      }

      replaceStatePositions(state, backupPositions);
      setContinuationTargets(state.cleanAirData, fromT);
      diagnostics.rejectedStages += 1;
      step *= 0.5;
      if (step < CLEAN_AIR_CONFIG.continuationMinStep) {
        diagnostics.minStepReached = true;
        break;
      }
    }

    if (t >= 1 && lastResult) {
      lastResult.continuationDiagnostics = diagnostics;
      return lastResult;
    }

    setContinuationTargets(state.cleanAirData, 1);
    var finalStats = computeCleanAirStats(state.cleanAirData, state.posById, state.movableVertices);
    finalStats.sweeps = lastResult && lastResult.stats ? lastResult.stats.sweeps : 0;
    finalStats.failureReason = diagnostics.minStepReached
      ? 'continuation-min-step'
      : 'continuation-stage-limit';
    return {
      status: 'blocked',
      stats: finalStats,
      moveStats: { movedVertices: 0, avgMove: 0, maxMove: 0, acceptedCount: 0 },
      continuationDiagnostics: diagnostics,
      hasCrossings: hasPositionCrossings(state.posById, state.graph.edgePairs)
    };
  }

  async function computeCleanAirPositions(graph, options) {
    var state = buildCleanAirState(graph, options || {});
    if (!state.ok) {
      return buildLayoutError(state);
    }
    if (state.cleanAirData.faces.length === 0) {
      return buildLayoutResult({
        graph: graph,
        outerFace: state.outerFace,
        positions: filterPositions(state.posById, graph.nodeIds),
        status: 'realized',
        boundedFaceCount: 0,
        faceAreaScore: null,
        maxRelError: 0
      });
    }

    var solveResult = await runCleanAirIterations(state, state.opts);
    var continuationDiagnostics = null;
    if (solveResult.status !== 'realized' && CLEAN_AIR_CONFIG.continuationEnabled) {
      var directResult = solveResult;
      var directPositions = clonePositionMap(state.posById, graph.nodeIds);
      var continuationResult = await runContinuationIterations(state);
      continuationDiagnostics = continuationResult.continuationDiagnostics || null;
      var directErr = directResult && directResult.stats &&
        Number.isFinite(directResult.stats.maxRelError)
        ? directResult.stats.maxRelError
        : Infinity;
      var continuationErr = continuationResult && continuationResult.stats &&
        Number.isFinite(continuationResult.stats.maxRelError)
        ? continuationResult.stats.maxRelError
        : Infinity;
      if (continuationResult.status === 'realized' || continuationErr < directErr) {
        solveResult = continuationResult;
      } else {
        replaceStatePositions(state, directPositions);
        setContinuationTargets(state.cleanAirData, 1);
        solveResult = directResult;
        solveResult.continuationDiagnostics = continuationDiagnostics;
      }
    } else {
      setContinuationTargets(state.cleanAirData, 1);
    }
    var finalPositions = filterPositions(state.posById, graph.nodeIds);
    if (solveResult.hasCrossings) {
      return buildLayoutError({
        graph: graph,
        outerFace: state.outerFace,
        message: 'CleanAir produced a non-plane drawing',
        status: solveResult.status,
        maxRelError: solveResult.stats ? solveResult.stats.maxRelError : null,
        boundedFaceCount: state.cleanAirData.faces.length
      });
    }

    var faceScore = Metrics.computeUniformFaceAreaScore(
      graph.nodeIds,
      graph.edgePairs,
      finalPositions,
      state.embedding
    );
    var stats = solveResult.stats || {};
    var message = buildLayoutStatusMessage('CleanAir', {
      outerFaceVertexCount: state.outerFace.length,
      boundedFaceCount: state.cleanAirData.faces.length,
      status: solveResult.status,
      maxRelError: Number.isFinite(stats.maxRelError) ? stats.maxRelError : null,
      faceAreaScore: faceScore && faceScore.ok ? faceScore.quality : null
    });

    return buildLayoutResult({
      graph: graph,
      outerFace: state.outerFace,
      positions: finalPositions,
      status: solveResult.status,
      message: message,
      faceAreaScore: faceScore && faceScore.ok ? faceScore.quality : null,
      maxRelError: Number.isFinite(stats.maxRelError) ? stats.maxRelError : null,
      boundedFaceCount: state.cleanAirData.faces.length,
      targetTotal: state.cleanAirData.targetTotal,
      failureReason: stats.failureReason || null,
      lmDiagnostics: stats.lmDiagnostics || null,
      continuationDiagnostics: continuationDiagnostics || solveResult.continuationDiagnostics || null,
      dummyCount: 0,
      iters: Number.isFinite(stats.sweeps) ? stats.sweeps : null
    });
  }

  async function applyCleanAirLayout(cy, options) {
    return CyRuntime.runLayout(cy, options, {
      initialFitBounds: function (ctx) {
        return CyRuntime.computePositionBounds(ctx.currentPositions) ||
          { x1: -1, y1: -1, x2: 1, y2: 1 };
      },
      computePositions: computeCleanAirPositions,
      buildResult: function (ctx) {
        var result = ctx.result;
        return {
          ok: true,
          status: result.status,
          message: result.message,
          faceAreaScore: result.faceAreaScore,
          maxRelError: result.maxRelError,
          failureReason: result.failureReason,
          lmDiagnostics: result.lmDiagnostics,
          boundedFaceCount: result.boundedFaceCount,
          dummyCount: 0,
          iters: result.iters,
          debugState: null
        };
      },
      failureMessage: 'CleanAir failed'
    });
  }

  global.PlanarVibeCleanAir = {
    computeCleanAirPositions: computeCleanAirPositions,
    applyCleanAirLayout: applyCleanAirLayout
  };
})(window);
