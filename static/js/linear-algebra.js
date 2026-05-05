(function (global) {
  'use strict';

  // Small dense linear-algebra helpers shared by layout and initialization code.

  function cloneMatrix(A) {
    var out = new Array(A.length);
    for (var i = 0; i < A.length; i += 1) {
      out[i] = A[i].slice();
    }
    return out;
  }

  function luFactorize(A) {
    var n = A.length;
    var LU = cloneMatrix(A);
    var piv = new Array(n);
    var i;
    var j;

    for (i = 0; i < n; i += 1) {
      piv[i] = i;
    }
    for (var k = 0; k < n; k += 1) {
      var pivotRow = k;
      var pivotValue = Math.abs(LU[k][k]);
      for (i = k + 1; i < n; i += 1) {
        var cand = Math.abs(LU[i][k]);
        if (cand > pivotValue) {
          pivotValue = cand;
          pivotRow = i;
        }
      }
      if (!(pivotValue > 1e-12)) {
        return null;
      }
      if (pivotRow !== k) {
        var tmpRow = LU[k];
        LU[k] = LU[pivotRow];
        LU[pivotRow] = tmpRow;
        var tmpPivot = piv[k];
        piv[k] = piv[pivotRow];
        piv[pivotRow] = tmpPivot;
      }
      for (i = k + 1; i < n; i += 1) {
        LU[i][k] /= LU[k][k];
        var factor = LU[i][k];
        for (j = k + 1; j < n; j += 1) {
          LU[i][j] -= factor * LU[k][j];
        }
      }
    }
    return { LU: LU, piv: piv };
  }

  function solveLUWithTwoRhs(factor, b1, b2) {
    var n = b1.length;
    if (n === 0) return { x1: [], x2: [] };
    var LU = factor.LU;
    var piv = factor.piv;
    var y1 = new Array(n);
    var y2 = new Array(n);
    var i;
    var j;

    for (i = 0; i < n; i += 1) {
      y1[i] = b1[piv[i]];
      y2[i] = b2[piv[i]];
    }
    for (i = 0; i < n; i += 1) {
      for (j = 0; j < i; j += 1) {
        y1[i] -= LU[i][j] * y1[j];
        y2[i] -= LU[i][j] * y2[j];
      }
    }

    var x1 = new Array(n);
    var x2 = new Array(n);
    for (i = n - 1; i >= 0; i -= 1) {
      var sum1 = y1[i];
      var sum2 = y2[i];
      for (j = i + 1; j < n; j += 1) {
        sum1 -= LU[i][j] * x1[j];
        sum2 -= LU[i][j] * x2[j];
      }
      var diag = LU[i][i];
      if (!(Math.abs(diag) > 1e-12)) return null;
      x1[i] = sum1 / diag;
      x2[i] = sum2 / diag;
    }
    return { x1: x1, x2: x2 };
  }

  function solveTransposeLUWithTwoRhs(factor, b1, b2) {
    var n = b1.length;
    if (n === 0) return { x1: [], x2: [] };
    var LU = factor.LU;
    var piv = factor.piv;
    var z1 = new Array(n);
    var z2 = new Array(n);
    var i;
    var j;

    for (i = 0; i < n; i += 1) {
      var sum1 = b1[i];
      var sum2 = b2[i];
      for (j = 0; j < i; j += 1) {
        sum1 -= LU[j][i] * z1[j];
        sum2 -= LU[j][i] * z2[j];
      }
      var diag = LU[i][i];
      if (!(Math.abs(diag) > 1e-12)) return null;
      z1[i] = sum1 / diag;
      z2[i] = sum2 / diag;
    }

    var w1 = new Array(n);
    var w2 = new Array(n);
    for (i = n - 1; i >= 0; i -= 1) {
      var acc1 = z1[i];
      var acc2 = z2[i];
      for (j = i + 1; j < n; j += 1) {
        acc1 -= LU[j][i] * w1[j];
        acc2 -= LU[j][i] * w2[j];
      }
      w1[i] = acc1;
      w2[i] = acc2;
    }

    var x1 = new Array(n);
    var x2 = new Array(n);
    for (i = 0; i < n; i += 1) {
      x1[piv[i]] = w1[i];
      x2[piv[i]] = w2[i];
    }
    return { x1: x1, x2: x2 };
  }

  global.LinearAlgebraUtils = {
    luFactorize: luFactorize,
    solveLUWithTwoRhs: solveLUWithTwoRhs,
    solveTransposeLUWithTwoRhs: solveTransposeLUWithTwoRhs
  };
})(window);
