/* engine.js — Create Aeronautics ship & shape studio
   Fork of the createmod.com balloon/propeller generator engine (same math,
   same output for the balloon and propeller cores), rewritten for speed and
   grown into a full studio:
   - per-slice ellipse fill instead of a triple nested loop with per-point math
   - flat Uint8Array voxel grids instead of string-keyed Sets
   - frontier-based shell peeling (O(volume + surface)) instead of repeated full-grid scans
   - typed-array output, min-shifted to origin
   - interior volume (enclosed air) computed for the Create Aeronautics burner rule
     (1 burner per 500 blocks of internal volume, 1.5 lift per heated block)
   - crystal module: imperfect rhombus crystal shard ships (seeded inconsistencies:
     jitter, twist, lean, asymmetric taper, truncation, cracks, inclusions)
   - shapes module: classic primitives (sphere, cylinder, cone, pyramid, torus, dome)
   - requirement math (mathFor / propMath) + a schematic reader for the lab
 */
'use strict';
(function (global) {
  var clamp = function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; };
  var ROUND = function (x) { return x >= 0 ? Math.floor(x + .5) : -Math.floor(-x + .5); };

  var WOOL = 7, LOG = 8, SAIL = 9, PLANK = 1;

  /* Catmull-Rom interpolation for spline-defined profiles */
  function profileRadius(pts, y) {
    var n = pts.length;
    if (y <= pts[0].y) return pts[0].r;
    if (y >= pts[n - 1].y) return pts[n - 1].r;
    for (var k = 0; k < n - 1; k++) {
      if (y >= pts[k].y && y <= pts[k + 1].y) {
        var p0 = pts[Math.max(0, k - 1)], p1 = pts[k], p2 = pts[k + 1], p3 = pts[Math.min(n - 1, k + 2)];
        var t = (y - p1.y) / Math.max(1e-9, p2.y - p1.y);
        var t2 = t * t, t3 = t2 * t;
        return 0.5 * ((2 * p1.r) + (-p0.r + p2.r) * t + (2 * p0.r - 5 * p1.r + 4 * p2.r - p3.r) * t2 + (-p0.r + 3 * p1.r - 3 * p2.r + p3.r) * t3);
      }
    }
    return pts[n - 1].r;
  }

  function growable(init) {
    return { arr: new Int32Array(init), n: 0 };
  }
  function push(g, v) {
    if (g.n === g.arr.length) {
      var nb = new Int32Array(g.arr.length * 2);
      nb.set(g.arr);
      g.arr = nb;
    }
    g.arr[g.n++] = v;
  }

  function genBalloon(p) {
    p = p || {};
    var L = clamp(Math.round(p.lengthX || 12), 6, 500);
    var W = clamp(Math.round(p.widthZ || 12), 4, 250);
    var H = clamp(Math.round(p.heightY || 16), 4, 250);
    var cm  = clamp(+p.cylinderMid   || 0, 0, .85);
    var ft  = clamp(+p.frontTaper    || 0, 0, 1);
    var rt  = clamp(+p.rearTaper     || 0, 0, 1);
    var tf  = clamp(+p.topFlatten    || 0, 0, .5);
    var bf  = clamp(+p.bottomFlatten || 0, 0, .5);
    var hollow = p.hollow !== false;
    var shellK = hollow ? clamp(Math.round(p.shell || 1), 1, 5) : 0;
    var ribOn  = !!p.ribEnabled;
    var ribSp  = clamp(Math.round(p.ribSpacing || 4), 2, 12);
    var ribOff = clamp(Math.round(p.ribOffset || 0), 0, ribSp - 1);
    var keelOn = !!p.keelEnabled;
    var keelD  = clamp(Math.round(p.keelDepth || 1), 1, 10);
    var finOn  = !!p.finEnabled, sfinOn = !!p.sideFinEnabled;
    var finH   = clamp(Math.round(p.finHeight || 2), 2, 15);
    var finL   = clamp(Math.round(p.finLength || 3), 3, 20);

    var X = L + 2, Y = H + 2, Z = W + 2;
    var padB = keelOn ? keelD : 0;                 // headroom below (keel)
    var padT = (finOn || sfinOn) ? finH + 2 : 0;   // headroom above (fins)
    var padZ = (finOn || sfinOn) ? finH + 2 : 0;   // headroom both z sides (side fins)
    var GY = Y + padB + padT, GZ = Z + 2 * padZ;
    var grid = new Uint8Array(X * GY * GZ);        // 1 = inside ellipsoid
    var taken = new Uint8Array(X * GY * GZ);       // 1 = part of generated structure
    var outType = new Uint8Array(X * GY * GZ);     // block type (0 = WOOL)
    var idx = function (x, y, z) { return (x * GY + y) * GZ + z; };

    var A = L / 2, B = H / 2, C = W / 2;
    var g = A * cm, Re = Math.max(1, A - g), Ie = Math.floor(A);
    var By = Math.floor(B), Cz = Math.floor(C);
    var yB = padB, zB = padZ;

    /* per-x-slice precompute (normalized s and taper factor) */
    var sArr = new Float64Array(X), tArr = new Float64Array(X);
    for (var x = 0; x < X; x++) {
      var a = x - Ie, s;
      if (g > 0 && Math.abs(a) <= g) s = 0;
      else { var r2 = Math.abs(a) - (g > 0 ? g : 0); s = r2 / Re; if (a < 0) s = -s; }
      sArr[x] = s;
      var sf = Math.abs(s);
      tArr[x] = 1 + (s < 0 ? ft : s > 0 ? rt : 0) * sf * sf * 3;
    }

    /* solid fill */
    var solid = 0;
    if (p.profile && p.profile.length > 1) {
      /* spline profile of revolution (balloonshaper-style): radius per height,
         Catmull-Rom interpolated, round cross-section */
      var pts = p.profile.slice().sort(function (a, b) { return a.y - b.y; });
      var pscale = p.profileScale || 1;
      var radii = new Float64Array(Y);
      for (var py = 0; py < Y; py++) {
        var yn = py / (Y - 1);
        var rr = profileRadius(pts, yn);
        radii[py] = (Math.min(L, W) / 2) * rr * pscale;
      }
      var cxp = Math.floor(L / 2), czp = Math.floor(W / 2);
      for (var py2 = 0; py2 < Y; py2++) {
        var R = radii[py2];
        var base = idx(0, py2 + yB, zB);
        if (R < 0.5) {
          /* very thin throat: a single center block (the one-block center) */
          var ti = base + cxp * GY * GZ + czp;
          grid[ti] = 1; solid++;
          continue;
        }
        var R2 = R * R;
        var x0 = Math.max(0, Math.floor(cxp - R + 1e-9)), x1 = Math.min(X - 1, Math.ceil(cxp + R - 1e-9));
        for (var px = x0; px <= x1; px++) {
          var dx = px - cxp;
          var d2 = dx * dx;
          if (d2 > R2) continue;
          var zh = Math.floor(Math.sqrt(R2 - d2) + 1e-9);
          var z0 = Math.max(0, czp - zh), z1 = Math.min(Z - 1, czp + zh);
          var pb = base + px * GY * GZ;
          for (var pz = z0; pz <= z1; pz++) { grid[pb + pz] = 1; solid++; }
        }
      }
    } else {
    var invB = 1 / B, invC = 1 / C;
    for (var x2 = 0; x2 < X; x2++) {
      var s2 = sArr[x2] * sArr[x2], t = tArr[x2];
      for (var y = 0; y < Y; y++) {
        var o = (y - By) * invB;
        if (o < 0) o *= 1 - tf * .5;
        else if (o > 0) o *= 1 - bf * .5;
        o *= t;
        var d2 = s2 + o * o;
        if (d2 > 1) continue;
        /* i is also scaled by the taper factor in the original formula
           (i *= t), so the z half-width must be divided by t */
        var r = Math.floor(Math.sqrt(1 - d2) * C / t + 1e-9);
        var z0 = Cz - r, z1 = Cz + r;
        if (z0 < 0) z0 = 0;
        if (z1 > Z - 1) z1 = Z - 1;
        var base = idx(x2, y + yB, zB);
        for (var z = z0; z <= z1; z++) { grid[base + z] = 1; solid++; }
      }
    }
    }

    var interior = 0, solidCovered = 0;
    var outCells = growable(1024);

    if (hollow) {
      /* peel shell layers from the surface inward */
      var frontier = growable(1024);
      var gy = GY, gz = GZ;
      for (var i = 0; i < grid.length; i++) {
        if (!grid[i]) continue;
        var xi = (i / (gy * gz)) | 0, rem = i - xi * gy * gz, yi = (rem / gz) | 0, zi = rem - yi * gz;
        var surf = (xi === 0) || (xi === X - 1) || (yi === 0) || (yi === GY - 1) || (zi === 0) || (zi === GZ - 1) ||
          !grid[i - gy * gz] || !grid[i + gy * gz] || !grid[i - gz] || !grid[i + gz] || !grid[i - 1] || !grid[i + 1];
        if (surf) { taken[i] = 1; outType[i] = WOOL; push(frontier, i); push(outCells, i); }
      }
      for (var k = 2; k <= shellK; k++) {
        var next = growable(frontier.n);
        for (var f = 0; f < frontier.n; f++) {
          var ci = frontier.arr[f];
          var cx = (ci / (gy * gz)) | 0, crem = ci - cx * gy * gz, cy = (crem / gz) | 0, cz = crem - cy * gz;
          if (cx > 0) { var n1 = ci - gy * gz; if (grid[n1] && !taken[n1]) { taken[n1] = 1; outType[n1] = WOOL; push(next, n1); push(outCells, n1); } }
          if (cx < X - 1) { var n2 = ci + gy * gz; if (grid[n2] && !taken[n2]) { taken[n2] = 1; outType[n2] = WOOL; push(next, n2); push(outCells, n2); } }
          if (cy > 0) { var n3 = ci - gz; if (grid[n3] && !taken[n3]) { taken[n3] = 1; outType[n3] = WOOL; push(next, n3); push(outCells, n3); } }
          if (cy < GY - 1) { var n4 = ci + gz; if (grid[n4] && !taken[n4]) { taken[n4] = 1; outType[n4] = WOOL; push(next, n4); push(outCells, n4); } }
          if (cz > 0) { var n5 = ci - 1; if (grid[n5] && !taken[n5]) { taken[n5] = 1; outType[n5] = WOOL; push(next, n5); push(outCells, n5); } }
          if (cz < GZ - 1) { var n6 = ci + 1; if (grid[n6] && !taken[n6]) { taken[n6] = 1; outType[n6] = WOOL; push(next, n6); push(outCells, n6); } }
        }
        frontier = next;
      }
    } else {
      /* solid balloon: everything is output */
      for (var i2 = 0; i2 < grid.length; i2++) {
        if (grid[i2]) { taken[i2] = 1; outType[i2] = WOOL; push(outCells, i2); }
      }
    }

    /* ribs: shell cells on the rib grid become LOG, with inner "tab" anchors in WOOL.
       NOTE: the rib list is snapshotted first — the original engine iterates the
       fixed rib list, so tabs must not cascade into the interior. */
    if (ribOn) {
      var ribCells = [];
      for (var q = 0; q < outCells.n; q++) {
        var ri0 = outCells.arr[q];
        var rx0 = (ri0 / (GY * GZ)) | 0;
        if (rx0 % ribSp === ribOff && outType[ri0] === WOOL) ribCells.push(ri0);
      }
      for (var qq = 0; qq < ribCells.length; qq++) {
        var ri = ribCells[qq];
        var rx = (ri / (GY * GZ)) | 0;
        outType[ri] = LOG;
        var rrem = ri - rx * GY * GZ, ry = (rrem / GZ) | 0, rz = rrem - ry * GZ;
        if (rx > 0) { var v1 = ri - GY * GZ; if (grid[v1] && !taken[v1]) { taken[v1] = 1; outType[v1] = WOOL; push(outCells, v1); } }
        if (rx < X - 1) { var v2 = ri + GY * GZ; if (grid[v2] && !taken[v2]) { taken[v2] = 1; outType[v2] = WOOL; push(outCells, v2); } }
        if (ry > 0) { var v3 = ri - GZ; if (grid[v3] && !taken[v3]) { taken[v3] = 1; outType[v3] = WOOL; push(outCells, v3); } }
        if (ry < GY - 1) { var v4 = ri + GZ; if (grid[v4] && !taken[v4]) { taken[v4] = 1; outType[v4] = WOOL; push(outCells, v4); } }
        if (rz > 0) { var v5 = ri - 1; if (grid[v5] && !taken[v5]) { taken[v5] = 1; outType[v5] = WOOL; push(outCells, v5); } }
        if (rz < GZ - 1) { var v6 = ri + 1; if (grid[v6] && !taken[v6]) { taken[v6] = 1; outType[v6] = WOOL; push(outCells, v6); } }
      }
    }

    /* keel: LOG column below the lowest shell cell at the center z, for each x */
    if (keelOn) {
      var zC = Cz + zB;
      for (var x3 = 0; x3 < X; x3++) {
        var U = -1;
        for (var y3 = 0; y3 < GY; y3++) {
          if (taken[idx(x3, y3, zC)]) { U = y3; break; }
        }
        if (U >= 0) {
          for (var w = 1; w <= keelD; w++) {
            var kc = idx(x3, U - w, zC);
            if (taken[kc]) { outType[kc] = LOG; }          /* overwrite type if already built */
            else { taken[kc] = 1; outType[kc] = LOG; push(outCells, kc); }
          }
        }
      }
    }

    /* tail fin: PLANK stack above the highest shell cell at the center z, rear section */
    if (finOn) {
      var te = X - finL - 1, x0 = Math.max(0, te);
      var yV = By + yB, zC2 = Cz + zB;
      for (var x4 = x0; x4 < X; x4++) {
        var prog = (x4 - te) / finL;
        var topH = Math.ceil(finH * (1 - prog));
        var top = -1;
        for (var y4 = GY - 1; y4 >= 0; y4--) {
          if (taken[idx(x4, y4, zC2)]) { top = y4; break; }
        }
        if (top >= 0) {
          for (var r2 = 1; r2 <= topH; r2++) {
            var fc = idx(x4, top + r2, zC2);
            if (taken[fc]) { outType[fc] = PLANK; }
            else { taken[fc] = 1; outType[fc] = PLANK; push(outCells, fc); }
          }
        }
        var sideH = Math.ceil(finH * .7 * (1 - prog));
        if (taken[idx(x4, yV, zC2)]) {
          for (var k2 = 1; k2 <= sideH; k2++) {
            var c1 = idx(x4, yV, zC2 - k2), c2 = idx(x4, yV, zC2 + k2);
            if (taken[c1]) { outType[c1] = PLANK; } else { taken[c1] = 1; outType[c1] = PLANK; push(outCells, c1); }
            if (taken[c2]) { outType[c2] = PLANK; } else { taken[c2] = 1; outType[c2] = PLANK; push(outCells, c2); }
          }
        }
      }
    }

    /* side fins: PLANK at min/max z of the center-height row, rear section */
    if (sfinOn) {
      var te2 = X - finL - 1, x02 = Math.max(0, te2);
      var yH = By + yB;
      for (var x5 = x02; x5 < X; x5++) {
        var prog2 = (x5 - te2) / finL;
        var xw = Math.ceil(finH * .7 * (1 - prog2));
        var mn = -1, mx = -1;
        for (var z5 = 0; z5 < GZ; z5++) {
          if (taken[idx(x5, yH, z5)]) { if (mn < 0) mn = z5; mx = z5; }
        }
        if (mn >= 0) {
          for (var xw2 = 1; xw2 <= xw; xw2++) {
            var f1 = idx(x5, yH, mn - xw2), f2 = idx(x5, yH, mx + xw2);
            if (taken[f1]) { outType[f1] = PLANK; } else { taken[f1] = 1; outType[f1] = PLANK; push(outCells, f1); }
            if (taken[f2]) { outType[f2] = PLANK; } else { taken[f2] = 1; outType[f2] = PLANK; push(outCells, f2); }
          }
        }
      }
    }

    /* minimal envelope: eliminate redundant blocks. Keep only cells that touch
       air — inner shell layers, rib anchors etc. add weight but no volume
       (your build method: the layer above replaces the support below it). */
    if (hollow && p.prune) {
      var pruned = growable(outCells.n);
      for (var p0 = 0; p0 < outCells.n; p0++) {
        var pc = outCells.arr[p0];
        var px = (pc / (GY * GZ)) | 0, prem = pc - px * GY * GZ, py = (prem / GZ) | 0, pz = prem - py * GZ;
        var touchesAir = px === 0 || px === X - 1 || py === 0 || py === GY - 1 || pz === 0 || pz === GZ - 1 ||
          !grid[pc - GY * GZ] || !grid[pc + GY * GZ] || !grid[pc - GZ] || !grid[pc + GZ] || !grid[pc - 1] || !grid[pc + 1];
        if (touchesAir) push(pruned, pc);
      }
      outCells = pruned;
    }

    /* interior (enclosed air) = solid cells not covered by structure */
    for (var q2 = 0; q2 < outCells.n; q2++) {
      if (grid[outCells.arr[q2]]) solidCovered++;
    }
    interior = solid - solidCovered;

    /* emit typed arrays. Coordinates match the original engine: y is shifted so
       min y = 0 (keel extends below), x/z stay raw (side fins may go negative). */
    var n = outCells.n;
    var minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1e9, maxY = -1e9, maxZ = -1e9;
    for (var e = 0; e < n; e++) {
      var ci2 = outCells.arr[e];
      var ex = (ci2 / (GY * GZ)) | 0, erem = ci2 - ex * GY * GZ, ey = (erem / GZ) | 0, ez = erem - ey * GZ;
      if (ex < minX) minX = ex; if (ex > maxX) maxX = ex;
      if (ey < minY) minY = ey; if (ey > maxY) maxY = ey;
      if (ez < minZ) minZ = ez; if (ez > maxZ) maxZ = ez;
    }
    var yShift = minY < 0 ? -minY : 0;
    var positions = new Int16Array(n * 3), types = new Uint8Array(n);
    var wool = 0, logs = 0, planks = 0;
    for (var e2 = 0; e2 < n; e2++) {
      var ci3 = outCells.arr[e2];
      var ex2 = (ci3 / (GY * GZ)) | 0, erem2 = ci3 - ex2 * GY * GZ, ey2 = (erem2 / GZ) | 0, ez2 = erem2 - ey2 * GZ;
      positions[e2 * 3] = ex2;
      positions[e2 * 3 + 1] = ey2 + yShift;
      positions[e2 * 3 + 2] = ez2 - zB;
      var tp = outType[ci3] || WOOL;
      types[e2] = tp;
      if (tp === LOG) logs++; else if (tp === PLANK) planks++; else wool++;
    }

    /* optional: also emit the solid cells (for the cut-section guide view),
       in the same coordinate frame as the structure output */
    var solidPositions = null;
    if (p.includeSolid && solid <= 2000000) {
      solidPositions = new Int16Array(solid * 3);
      var si = 0;
      for (var gi = 0; gi < grid.length && si < solid; gi++) {
        if (!grid[gi]) continue;
        var gx = (gi / (GY * GZ)) | 0, grm = gi - gx * GY * GZ, gy = (grm / GZ) | 0, gz = grm - gy * GZ;
        solidPositions[si * 3] = gx;
        solidPositions[si * 3 + 1] = gy + yShift;
        solidPositions[si * 3 + 2] = gz - zB;
        si++;
      }
    }

    return {
      positions: positions,
      types: types,
      count: n,
      interior: hollow ? interior : 0,
      solid: solid,
      solidPositions: solidPositions,
      wool: wool, logs: logs, planks: planks,
      minX: minX, minY: minY + yShift, minZ: minZ,
      maxX: maxX, maxY: maxY + yShift, maxZ: maxZ,
      hollow: hollow
    };
  }

  function genProp(p) {
    p = p || {};
    var F = clamp(Math.round(p.blades || 2), 2, 12);
    var C = clamp(Math.round(p.length || 10), 3, 50);
    var rootC = clamp(Math.round(p.rootChord || 3), 1, 40);
    var tipC = clamp(Math.round(p.tipChord === undefined ? 1 : p.tipChord), 0, 40);
    var sweep = clamp(+p.sweepDegrees || 0, 0, 90) * Math.PI / 180;
    var swept = !!p.swept;
    var curved = p.airfoilShape === 'curved';
    var mat = p.bladeMaterial === 'sail' ? SAIL : WOOL;
    var vert = p.orientation === 'vertical';
    var rot = clamp(+p.rotation || 0, 0, 360) * Math.PI / 180;

    var pts = [];
    var seen = {};
    for (var f = 0; f < F; f++) {
      var W = f / F * 2 * Math.PI + rot;
      for (var w = 0; w <= C + 1e-9; w += 0.35) {
        var j = w / C;
        var b = rootC + (tipC - rootC) * j;
        if (curved) b += Math.sin(j * Math.PI) * Math.min(1.3, rootC * 0.4);
        if (b < 0.5) continue;
        var l = W;
        if (swept) l += sweep * j;
        var S = Math.max(0, (b - 1) / 2);
        for (var T = -S; T <= S + 1e-9; T += 0.35) {
          var zc = ROUND(w * Math.cos(l) - T * Math.sin(l));
          var xc = ROUND(w * Math.sin(l) + T * Math.cos(l));
          var key = zc + ',' + xc;
          if (seen[key]) continue;
          seen[key] = 1;
          if (vert) pts.push(zc, xc, 0);
          else pts.push(zc, 0, xc);
        }
      }
    }
    /* forceCenter: exactly ONE hub block — the bearing mounts there. The
       blade-plane points are deduped by (zc, xc), so the hub is naturally a
       single block; the previous pass tested the packed array's constant
       middle coordinate for horizontal props (pts[q+1] is always 0 there),
       which wiped the ENTIRE root row of the first blade — the bug this
       replaces. forceCenter only tops the hub up if a parameter set ever
       leaves it out; rows always keep all of their blocks. */
    if (p.forceCenter) {
      var hubIdx = -1;
      for (var q = 0; q < pts.length; q += 3) {
        var zcH = pts[q], xcH = vert ? pts[q + 1] : pts[q + 2];
        if (zcH === 0 && xcH === 0) { hubIdx = q; break; }
      }
      if (hubIdx === -1) pts.push(0, 0, 0);
    }

    var n = pts.length / 3;
    var minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1, maxY = -1, maxZ = -1;
    for (var e = 0; e < n; e++) {
      var px = pts[e * 3], py = pts[e * 3 + 1], pz = pts[e * 3 + 2];
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
      if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
    }
    var positions = new Int16Array(n * 3), types = new Uint8Array(n);
    for (var e2 = 0; e2 < n; e2++) {
      positions[e2 * 3] = pts[e2 * 3] - minX;
      positions[e2 * 3 + 1] = pts[e2 * 3 + 1] - minY;
      positions[e2 * 3 + 2] = pts[e2 * 3 + 2] - minZ;
      types[e2] = mat;
    }
    return {
      positions: positions,
      types: types,
      count: n,
      interior: 0, solid: n,
      wool: mat === WOOL ? n : 0, logs: 0, planks: 0,
      minX: 0, minY: 0, minZ: 0,
      maxX: maxX - minX, maxY: maxY - minY, maxZ: maxZ - minZ,
      center: [-minX, -minY, -minZ],   /* the single hub block, in shifted coords */
      hollow: false
    };
  }

  /* ============ wings module: copycat-wing planforms ============
     Grounded in Create Propulsion: Simulated source (github.com/KyivSec/create_propulsion_simulated):
     block ids createpropulsionsimulated:{copycat_wing, copycat_wing_8, copycat_wing_12},
     16×8/12/14×16 px flat panels. */
  var WING = 12;

  /* ---- copycat wings: tapered / delta planform, optional mirror ---- */
  function genWings(p) {
    p = p || {};
    var span = clamp(Math.round(p.halfSpan || 12), 3, 64);
    var rootC = clamp(Math.round(p.rootChord || 6), 1, 40);
    var tipC = p.planform === 'delta' ? 1 : clamp(Math.round(p.tipChord || 2), 1, 40);
    var sweep = clamp(Math.round(p.sweepBlocks === undefined ? 3 : p.sweepBlocks), 0, span);
    var mirror = p.mirror !== false;
    var seen = {}, pts = [];
    function add(x, z) {
      var key = x + ',' + z;
      if (seen[key]) return;
      seen[key] = 1;
      pts.push(x, 0, z);
    }
    for (var x = 0; x < span; x++) {
      var t = span > 1 ? x / (span - 1) : 0;
      var chord = Math.max(1, Math.round(rootC + (tipC - rootC) * t));
      var zc = Math.round(sweep * t);
      var z0 = zc - Math.floor(chord / 2), z1 = z0 + chord - 1;
      for (var z = z0; z <= z1; z++) {
        add(x, z);
        if (mirror) add(x, -z);
      }
    }
    var n = pts.length / 3;
    var minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1, maxY = -1, maxZ = -1;
    for (var e = 0; e < n; e++) {
      var px = pts[e * 3], py = pts[e * 3 + 1], pz = pts[e * 3 + 2];
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
      if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
    }
    var positions = new Int16Array(n * 3), types = new Uint8Array(n), props = new Uint8Array(n);
    for (var e2 = 0; e2 < n; e2++) {
      positions[e2 * 3] = pts[e2 * 3] - minX;
      positions[e2 * 3 + 1] = pts[e2 * 3 + 1] - minY;
      positions[e2 * 3 + 2] = pts[e2 * 3 + 2] - minZ;
      types[e2] = WING;
    }
    return {
      positions: positions, types: types, props: props, count: n,
      interior: 0, solid: n, solidPositions: null,
      wool: 0, logs: 0, planks: 0,
      minX: 0, minY: 0, minZ: 0, maxX: maxX - minX, maxY: maxY - minY, maxZ: maxZ - minZ,
      hollow: false,
      span: span, area: n, wingBlock: p.wingBlock || 'copycat_wing'
    };
  }

  /* ---- gondola: removed by request — see ship generator phase ---- */

  /* ============ crystal module: rhombus crystal shards ============
     A voxel crystal in the Blade & Sorcery shard style: DOUBLE-TERMINATED —
     a point at BOTH ends (the /\ over \/ diamond), widest at the middle
     (midY, with an optional straight midBand prism). LIES HORIZONTAL by
     default — the long axis runs along X, tip forward, like a bullet in
     flight (upright is one click away). Hollow by default: the
     cavity is the hot-air interior (1 adjustable burner per 500 blocks,
     1.5 lift per heated block — AeroPhysics config) — the studio reports
     the requirements, you fit the interior. No deck, no drive.
     Crystals are deliberately IMPERFECT, like the real thing: seeded
     per-vertex jitter, twist, lean, asymmetric taper, top truncation,
     cracks (sealed grooves — the shard is always airtight) and
     inclusions (patchwork variants: any mix of glass and glow blocks).
     Every imperfection is a slider; the same seed + params always reproduce
     the same crystal, so share links and tests are deterministic. */
  var CRYSTAL = 20, INCLUSION = 21, AIRBURNER = 22, PROPBEARING = 23,
      PROPELLER = 24, STEERWHEEL = 25, THROTTLE = 26, ASSEMBLER = 27;
  /* inclusion variants beyond the first use the reserved 28..99 band:
     variant 0 stays INCLUSION, variant i>=1 is INCLUSION_V + i - 1 */
  var INCLUSION_V = 28;

  /* mulberry32 — tiny deterministic PRNG: one seed, one crystal */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* peel the outermost k cell-layers of a solid grid into a hull mask.
     Shared by the crystal and shapes modules (balloon keeps its own
     frontier peel for block-for-block parity with the original engine). */
  function shellPeel(grid, X, Y, Z, k) {
    var total = X * Y * Z;
    var hull = new Uint8Array(total);
    var hullCount = 0;
    var frontier = [];
    var YZ = Y * Z;
    for (var i = 0; i < total; i++) {
      if (!grid[i]) continue;
      var xi = (i / YZ) | 0, rem = i - xi * YZ, yi = (rem / Z) | 0, zi = rem - yi * Z;
      var surf = xi === 0 || xi === X - 1 || yi === 0 || yi === Y - 1 || zi === 0 || zi === Z - 1 ||
        !grid[i - YZ] || !grid[i + YZ] || !grid[i - Z] || !grid[i + Z] || !grid[i - 1] || !grid[i + 1];
      if (surf) { hull[i] = 1; hullCount++; frontier.push(i); }
    }
    for (var layer = 2; layer <= k; layer++) {
      var next = [];
      for (var f = 0; f < frontier.length; f++) {
        var ci = frontier[f];
        var cx = (ci / YZ) | 0, crem = ci - cx * YZ, cy = (crem / Z) | 0, cz = crem - cy * Z;
        if (cx > 0) { var n1 = ci - YZ; if (grid[n1] && !hull[n1]) { hull[n1] = 1; hullCount++; next.push(n1); } }
        if (cx < X - 1) { var n2 = ci + YZ; if (grid[n2] && !hull[n2]) { hull[n2] = 1; hullCount++; next.push(n2); } }
        if (cy > 0) { var n3 = ci - Z; if (grid[n3] && !hull[n3]) { hull[n3] = 1; hullCount++; next.push(n3); } }
        if (cy < Y - 1) { var n4 = ci + Z; if (grid[n4] && !hull[n4]) { hull[n4] = 1; hullCount++; next.push(n4); } }
        if (cz > 0) { var n5 = ci - 1; if (grid[n5] && !hull[n5]) { hull[n5] = 1; hullCount++; next.push(n5); } }
        if (cz < Z - 1) { var n6 = ci + 1; if (grid[n6] && !hull[n6]) { hull[n6] = 1; hullCount++; next.push(n6); } }
      }
      frontier = next;
    }
    return { hull: hull, count: hullCount };
  }

  /* 6-connected flood fill: labels every empty cell OUTSIDE air (1) or
     SEALED interior air (2). Airtightness in the game is face-tight —
     diagonal gaps are not paths — so this is the exact seal check. */
  function airLabels(grid, X, Y, Z) {
    var total = X * Y * Z, YZ = Y * Z;
    var lab = new Uint8Array(total);
    var stack = [];
    var seed = function (i) { if (!grid[i] && !lab[i]) { lab[i] = 1; stack.push(i); } };
    for (var x = 0; x < X; x++) for (var y = 0; y < Y; y++) { seed(x * YZ + y * Z); seed(x * YZ + y * Z + Z - 1); }
    for (var y = 0; y < Y; y++) for (var z = 0; z < Z; z++) { seed(y * Z + z); seed((X - 1) * YZ + y * Z + z); }
    for (var x = 0; x < X; x++) for (var z = 0; z < Z; z++) { seed(x * YZ + z); seed(x * YZ + (Y - 1) * Z + z); }
    while (stack.length) {
      var i = stack.pop();
      var xi = (i / YZ) | 0, rem = i - xi * YZ, yi = (rem / Z) | 0, zi = rem - yi * Z;
      var nbs = [];
      if (xi > 0) nbs.push(i - YZ);
      if (xi < X - 1) nbs.push(i + YZ);
      if (yi > 0) nbs.push(i - Z);
      if (yi < Y - 1) nbs.push(i + Z);
      if (zi > 0) nbs.push(i - 1);
      if (zi < Z - 1) nbs.push(i + 1);
      for (var n2 = 0; n2 < nbs.length; n2++) {
        var j = nbs[n2];
        if (!grid[j] && !lab[j]) { lab[j] = 1; stack.push(j); }
      }
    }
    for (var k2 = 0; k2 < total; k2++) if (!grid[k2] && !lab[k2]) lab[k2] = 2;
    return lab;
  }

  /* inclusion type codes: variant 0 keeps the classic INCLUSION code,
     further variants live in the reserved 28..99 band */
  function isIncType(t) {
    return t === INCLUSION || (t >= INCLUSION_V && t < 100);
  }

  function genCrystal(p) {
    p = p || {};
    var H = clamp(Math.round(p.heightY || 44), 6, 200);
    var BX = clamp(Math.round(p.baseDiagX || 16), 5, 100);
    var BZ = clamp(Math.round(p.baseDiagZ || 10), 5, 100);
    /* odd center = a single block at the cross-section middle;
       even center = the middle falls on a 2×2 block junction */
    var centerMode = p.centerMode === 'even' ? 'even' : 'odd';
    if (centerMode === 'odd') { BX = BX | 1; BZ = BZ | 1; }
    else { if (BX % 2 === 1) BX--; if (BZ % 2 === 1) BZ--; if (BX < 4) BX = 4; if (BZ < 4) BZ = 4; }
    var n = clamp(Math.round(p.facets || 4), 3, 10);
    var taperPower = clamp(+p.taperPower || 1, 0.35, 1.8);
    var midY = clamp(+p.midY || 0.45, 0.2, 0.8);
    var midBand = clamp(+(p.midBand === undefined ? 0.12 : p.midBand), 0, Math.min(0.5, 2 * Math.min(midY, 1 - midY)));
    var topCrop = clamp(+p.topCrop || 0, 0, 0.5);
    var twistDeg = clamp(+p.twistDeg || 0, 0, 180) * Math.PI / 180;
    var leanX = clamp(+(p.leanX === undefined ? 1 : p.leanX), 0, 20);   /* nose dip, in BLOCKS (0 = straight) */
    var leanZ = clamp(+p.leanZ || 0, 0, 20);   /* sideways lean, in blocks */
    var asym = clamp(+p.asym || 0, 0, 0.5);
    var jitter = clamp(+(p.jitter === undefined ? 0.1 : p.jitter), 0, 0.4);
    var crackCount = clamp(Math.round(p.crackCount === undefined ? 2 : p.crackCount), 0, 20);
    /* inclusions are a percentage of the hull — big crystals carry
       proportionally more patch material. Legacy raw cluster counts
       (inclusionCount) are still accepted. */
    var inclusionPct, legacyInc = -1;
    if (p.inclusionPct !== undefined) inclusionPct = clamp(+p.inclusionPct, 0, 100);
    else if (p.inclusionCount !== undefined) { inclusionPct = 0; legacyInc = clamp(Math.round(p.inclusionCount), 0, 400); }
    else inclusionPct = 3;
    var hollow = p.hollow !== false;
    var shell = hollow ? clamp(Math.round(p.shell || 1), 1, 3) : 0;
    var seed = clamp(Math.round(p.seed === undefined ? 1337 : p.seed), 0, 9999);
    var blockMass = clamp(+p.blockMass || 1, 0.1, 100);
    var payload = clamp(+p.payload || 0, 0, 1000000);
    /* horizontal = the shard lies along X like a bullet in flight (the tip
       points +X); vertical = standing upright. The shard is always built
       around the Y axis internally and the coords are swapped on emit. */
    var orientation = p.orientation === 'vertical' ? 'vertical' : 'horizontal';
    var lying = orientation === 'horizontal';
    var rand = mulberry32(seed + 1);

    var RX0 = BX / 2, RZ0 = BZ / 2;
    /* the nose dip is baked INTO the slice centers instead of being applied
       as a shear at emit time (a shear breaks face-connectivity and opens
       the hull), so the X pad must cover the whole dip swing */
    var padX = Math.ceil(jitter * RX0 + leanX) + 2, padZ = Math.ceil(jitter * RZ0) + 2;
    var X = Math.ceil(BX + leanX) + 2 * padX;
    var Z = Math.ceil(BZ + leanZ) + 2 * padZ;
    var Y = H;
    var total = X * Y * Z;
    var grid = new Uint8Array(total);
    var idx = function (x, y, z) { return (x * Y + y) * Z + z; };
    var cx0 = X / 2, cz0 = Z / 2;

    /* ---- profile: double-terminated shard (point at BOTH ends, widest at
       midY with an optional straight middle band) — the /\ over \/ shape ---- */
    var tLo = midY - midBand / 2, tHi = midY + midBand / 2;
    function shapeF(t) {
      if (t <= 0) return 0;
      if (t >= 1) return topCrop;
      if (t < tLo) return Math.pow(t / Math.max(1e-6, tLo), taperPower);
      if (t > tHi) {
        var u = (t - tHi) / Math.max(1e-6, 1 - tHi);
        return topCrop + (1 - topCrop) * Math.pow(1 - u, taperPower);
      }
      return 1;
    }

    var solid = 0;
    var rMaxByY = new Float64Array(Y);   /* per-slice radius — cracks must not carve the thin tips */
    for (var y = 0; y < Y; y++) {
      var t = y / Math.max(1, H - 1);
      var f = shapeF(t);
      var RX = RX0 * Math.pow(f, 1 + asym);
      var RZ = RZ0 * Math.pow(f, 1 - asym);
      /* baked nose dip: lying drops the nose in the world-Y direction
         (internal X), upright slants the top tip +X */
      var cxp = cx0 + (lying ? -Math.round(leanX * t) : Math.round(leanX * t)), czp = cz0 + leanZ * t;
      var twist = twistDeg * t;
      var vx = new Float64Array(n), vz = new Float64Array(n);
      for (var i2 = 0; i2 < n; i2++) {
        var a = i2 * 2 * Math.PI / n + twist;
        var rj = 1 + jitter * (rand() * 2 - 1);
        vx[i2] = cxp + RX * Math.cos(a) * rj;
        vz[i2] = czp + RZ * Math.sin(a) * rj;
      }
      var rMax = Math.max(RX, RZ) * (1 + jitter);
      rMaxByY[y] = rMax;

      if (rMax < 1.05) {   /* below ~1 cell the polygon fill and the single-cell
         branch could disagree on the center cell and zig-zag the tip into
         diagonal-only contacts — keep the whole thin tip one chain */
        /* sharp tip: a single center block, so the shard truly comes to a
           point. The tip is the cell CONTAINING the slice center (floor) —
           one block over from the rounded cell — which lines the point up
           with the body's center column: the chain joins the hull face-first
           with no extra bridging block. */
        var gx0 = clamp(Math.floor(cxp), 0, X - 1), gz0 = clamp(Math.floor(czp), 0, Z - 1);
        var ti = idx(gx0, y, gz0);
        if (!grid[ti]) { grid[ti] = 1; solid++; }
        continue;
      }
      function inPoly(px, pz) {
        var inside = false;
        for (var i3 = 0, j3 = n - 1; i3 < n; j3 = i3++) {
          if (((vz[i3] > pz) !== (vz[j3] > pz)) &&
              (px < (vx[j3] - vx[i3]) * (pz - vz[i3]) / (vz[j3] - vz[i3]) + vx[i3])) inside = !inside;
        }
        return inside;
      }
      var gx0b = Math.max(0, Math.floor(cxp - rMax)), gx1 = Math.min(X - 1, Math.ceil(cxp + rMax));
      var gz0b = Math.max(0, Math.floor(czp - rMax)), gz1 = Math.min(Z - 1, Math.ceil(czp + rMax));
      for (var gx = gx0b; gx <= gx1; gx++) {
        for (var gz = gz0b; gz <= gz1; gz++) {
          if (!inPoly(gx + 0.5, gz + 0.5)) continue;
          var gi = idx(gx, y, gz);
          if (!grid[gi]) { grid[gi] = 1; solid++; }
        }
      }
    }

    /* ---- cracks: a short random line of missing material, carved into the
       solid from the surface. The hull is peeled AFTER the carving, so every
       crack becomes a sealed groove — its walls are the new hull — and the
       cavity can never vent. ---- */
    /* how deep each solid cell sits below the open surface — cracks carve
       only the shell layers, never into the cavity core */
    var crackDepth = hollow ? shell : 1;
    var surfCells = [];
    var surfDepth = new Int16Array(total);
    var depthFrontier = [];
    for (var s2 = 0; s2 < total; s2++) {
      if (!grid[s2]) continue;
      var sx3 = (s2 / (Y * Z)) | 0, srm3 = s2 - sx3 * Y * Z, sy3 = (srm3 / Z) | 0, sz3 = srm3 - sy3 * Z;
      var onSurf = (sx3 === 0 || sx3 === X - 1 || sy3 === 0 || sy3 === Y - 1 || sz3 === 0 || sz3 === Z - 1) ||
        !grid[s2 - Y * Z] || !grid[s2 + Y * Z] || !grid[s2 - Z] || !grid[s2 + Z] || !grid[s2 - 1] || !grid[s2 + 1];
      if (onSurf) { surfCells.push(s2); surfDepth[s2] = 1; depthFrontier.push(s2); }
    }
    for (var depth = 2; depth <= crackDepth; depth++) {
      var nextFrontier = [];
      for (var df = 0; df < depthFrontier.length; df++) {
        var d0 = depthFrontier[df];
        var dx0 = (d0 / (Y * Z)) | 0, drm = d0 - dx0 * Y * Z, dy0 = (drm / Z) | 0, dz0 = drm - dy0 * Z;
        if (dx0 > 0) { var dn1 = d0 - Y * Z; if (grid[dn1] && !surfDepth[dn1]) { surfDepth[dn1] = depth; nextFrontier.push(dn1); } }
        if (dx0 < X - 1) { var dn2 = d0 + Y * Z; if (grid[dn2] && !surfDepth[dn2]) { surfDepth[dn2] = depth; nextFrontier.push(dn2); } }
        if (dy0 > 0) { var dn3 = d0 - Z; if (grid[dn3] && !surfDepth[dn3]) { surfDepth[dn3] = depth; nextFrontier.push(dn3); } }
        if (dy0 < Y - 1) { var dn4 = d0 + Z; if (grid[dn4] && !surfDepth[dn4]) { surfDepth[dn4] = depth; nextFrontier.push(dn4); } }
        if (dz0 > 0) { var dn5 = d0 - 1; if (grid[dn5] && !surfDepth[dn5]) { surfDepth[dn5] = depth; nextFrontier.push(dn5); } }
        if (dz0 < Z - 1) { var dn6 = d0 + 1; if (grid[dn6] && !surfDepth[dn6]) { surfDepth[dn6] = depth; nextFrontier.push(dn6); } }
      }
      depthFrontier = nextFrontier;
    }
    var crackOrigins = [];
    for (var ck = 0; ck < crackCount; ck++) {
      if (!surfCells.length) break;
      var o = surfCells[Math.floor(rand() * surfCells.length)];
      var ox = (o / (Y * Z)) | 0, oy = ((o - ox * Y * Z) / Z) | 0, oz = o - ox * Y * Z - oy * Z;
      var dx = rand() * 2 - 1, dy = rand() * 2 - 1, dz = rand() * 2 - 1;
      var dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      dx /= dl; dy /= dl; dz /= dl;
      var clen = 3 + Math.floor(rand() * 10);
      var r2 = Math.ceil(clen + 1.1);
      var cx0b = Math.max(0, ox - r2), cx1b = Math.min(X - 1, ox + r2);
      var cy0b = Math.max(0, oy - r2), cy1b = Math.min(Y - 1, oy + r2);
      var cz0b = Math.max(0, oz - r2), cz1b = Math.min(Z - 1, oz + r2);
      var removed = 0;
      for (var cxx = cx0b; cxx <= cx1b; cxx++) {
        for (var cyy = cy0b; cyy <= cy1b; cyy++) {
          for (var czz = cz0b; czz <= cz1b; czz++) {
            var c = cxx * Y * Z + cyy * Z + czz;
            if (!grid[c]) continue;
            /* never carve the thin tip zones — the end points must stay connected */
            if (rMaxByY[cyy] < 2) continue;
            /* carve only the shell layers, never into the cavity core */
            if (surfDepth[c] < 1 || surfDepth[c] > crackDepth) continue;
            var rx = cxx - ox, ry = cyy - oy, rz = czz - oz;
            var proj = rx * dx + ry * dy + rz * dz;
            if (proj < 0 || proj > clen) continue;
            var px2 = rx - proj * dx, py2 = ry - proj * dy, pz2 = rz - proj * dz;
            if (px2 * px2 + py2 * py2 + pz2 * pz2 <= 1.1) {
              grid[c] = 0;
              solid--;
              removed++;
            }
          }
        }
      }
      if (removed) crackOrigins.push(o);
    }

    /* ---- airtight seal #1: any sealed air pocket left inside the solid (a
       rasterization bubble, or a crack that never reached the surface) is
       filled with crystal before the hull is peeled. ---- */
    var pocketsFilled = 0;
    var bubbleFills = [];
    var sealLab = airLabels(grid, X, Y, Z);
    for (var q2 = 0; q2 < total; q2++) {
      if (sealLab[q2] === 2) {
        grid[q2] = 1;
        solid++;
        pocketsFilled++;
        bubbleFills.push(q2);
      }
    }
    var cracksMade = 0;
    for (var co = 0; co < crackOrigins.length; co++) if (!grid[crackOrigins[co]]) cracksMade++;

    /* ---- hull: peel the carved, sealed solid. The skin is the complete
       boundary of the solid, so the shell is airtight by construction and
       the cavity is one connected interior. ---- */
    var hullMask, hullCells = [];
    if (hollow) {
      hullMask = shellPeel(grid, X, Y, Z, shell).hull;
    } else {
      hullMask = grid;
    }
    for (var h = 0; h < total; h++) if (hullMask[h]) hullCells.push(h);
    var hullSet = new Uint8Array(total);
    for (var hc = 0; hc < hullCells.length; hc++) hullSet[hullCells[hc]] = 1;
    /* repair cells added below are buried inside the hull — they are
       emitted as crystal (so no air pocket survives in the built shard)
       but excluded from inclusion patches (patches must stay visible) */
    var sealedFill = new Uint8Array(total);
    if (hollow) {
      for (var bf = 0; bf < bubbleFills.length; bf++) {
        hullSet[bubbleFills[bf]] = 1;
        hullCells.push(bubbleFills[bf]);
        sealedFill[bubbleFills[bf]] = 1;
      }
    }

    /* add a cell to the hull: existing solid (buried core) is just emitted,
       open air becomes fresh crystal */
    var bridgeCell = function (m) {
      if (hullSet[m]) return false;
      if (!grid[m]) { grid[m] = 1; solid++; }
      hullSet[m] = 1;
      hullCells.push(m);
      return true;
    };
    /* connect the hull: the skin must be ONE face-connected piece, or the
       assembler cannot join it (diagonal-only contacts fall apart in game).
       Bridge junctions between DIFFERENT 6-connected pieces only — a full
       diagonal closure would chain into the cavity and fill it. */
    var closeHull = function () {
      var bridged = 0;
      for (var pass = 0; pass < 8; pass++) {
        /* union-find over hull cells: face-adjacent cells are unioned first,
           so the find() components are exactly the 6-connected pieces */
        var parent = new Int32Array(total);
        var find = function (a) {
          var root = a;
          while (parent[root] !== root) root = parent[root];
          while (parent[a] !== root) { var nxt = parent[a]; parent[a] = root; a = nxt; }
          return root;
        };
        for (var hc2 = 0; hc2 < hullCells.length; hc2++) parent[hullCells[hc2]] = hullCells[hc2];
        var union = function (a, b) {
          var ra = find(a), rb = find(b);
          if (ra !== rb) parent[ra] = rb;
        };
        for (var hc2b = 0; hc2b < hullCells.length; hc2b++) {
          var cc0 = hullCells[hc2b];
          var cx6 = (cc0 / (Y * Z)) | 0, crm6 = cc0 - cx6 * Y * Z, cy6 = (crm6 / Z) | 0, cz6 = crm6 - cy6 * Z;
          var cnbs6 = [];
          if (cx6 > 0) cnbs6.push(cc0 - Y * Z);
          if (cx6 < X - 1) cnbs6.push(cc0 + Y * Z);
          if (cy6 > 0) cnbs6.push(cc0 - Z);
          if (cy6 < Y - 1) cnbs6.push(cc0 + Z);
          if (cz6 > 0) cnbs6.push(cc0 - 1);
          if (cz6 < Z - 1) cnbs6.push(cc0 + 1);
          for (var cn6 = 0; cn6 < cnbs6.length; cn6++) {
            if (hullSet[cnbs6[cn6]]) union(cc0, cnbs6[cn6]);
          }
        }
        /* bridge diagonal junctions between different pieces: one bridge per
           merge (a spanning set, not a full closure) — prefer open-air cells
           so the cavity keeps its volume */
        var passBridged = 0;
        for (var hc3 = 0; hc3 < hullCells.length; hc3++) {
          var bc = hullCells[hc3];
          var bx5 = (bc / (Y * Z)) | 0, brm = bc - bx5 * Y * Z, by5 = (brm / Z) | 0, bz5 = brm - by5 * Z;
          for (var ox5 = -1; ox5 <= 1; ox5++) {
            var nx5 = bx5 + ox5;
            if (nx5 < 0 || nx5 >= X) continue;
            for (var oy5 = -1; oy5 <= 1; oy5++) {
              var ny5 = by5 + oy5;
              if (ny5 < 0 || ny5 >= Y) continue;
              for (var oz5 = -1; oz5 <= 1; oz5++) {
                var nz5 = bz5 + oz5;
                if (nz5 < 0 || nz5 >= Z) continue;
                if (!ox5 && !oy5 && !oz5) continue;
                if (!(ox5 * oy5 || ox5 * oz5 || oy5 * oz5)) continue;
                var nc3 = nx5 * Y * Z + ny5 * Z + nz5;
                if (!hullSet[nc3]) continue;
                if (find(bc) === find(nc3)) continue;
                var m1 = (bx5 + ox5) * Y * Z + by5 * Z + bz5;
                var m2 = bx5 * Y * Z + (by5 + oy5) * Z + bz5;
                var m3 = bx5 * Y * Z + by5 * Z + (bz5 + oz5);
                var join = function (a, b) { union(a, b); union(bc, a); };
                var br = function (m) { if (bridgeCell(m)) parent[m] = m; };
                var m4 = (bx5 + ox5) * Y * Z + (by5 + oy5) * Z + bz5;
                /* only bridge across OPEN air (the outside surface or a
                   crack groove) — a cavity-side step must never be bridged,
                   or the bridges would eat the cavity block by block */
                if (grid[m1] && grid[m2] && grid[m3] && grid[m4]) continue;
                if (ox5 && oy5 && oz5) {
                  br(m1);
                  br(m4);
                  if (hullSet[m1] && hullSet[m4]) join(m1, m4);
                } else if (ox5 && oy5) {
                  if (!hullSet[m1] && !grid[m1]) br(m1);
                  if (!hullSet[m1] && !hullSet[m2]) br(m2);
                  if (hullSet[m1]) join(m1, bc);
                  else if (hullSet[m2]) join(m2, bc);
                } else if (ox5 && oz5) {
                  if (!hullSet[m1] && !grid[m1]) br(m1);
                  if (!hullSet[m1] && !hullSet[m3]) br(m3);
                  if (hullSet[m1]) join(m1, bc);
                  else if (hullSet[m3]) join(m3, bc);
                } else {
                  if (!hullSet[m2] && !grid[m2]) br(m2);
                  if (!hullSet[m2] && !hullSet[m3]) br(m3);
                  if (hullSet[m2]) join(m2, bc);
                  else if (hullSet[m3]) join(m3, bc);
                }
                union(bc, nc3);
                passBridged++;
              }
            }
          }
        }
        bridged += passBridged;
        if (!passBridged) break;
      }
      return bridged;
    };
        /* stranded core pieces: a deep crack (or a bridge wall) can pinch the
       cavity in two. Fill every core piece except the largest with crystal,
       so the ship's cavity stays one connected air region and no air gap is
       left unconnected. */
    var fillStranded = function () {
      var filled = 0;
      var coreId = new Int32Array(total);
      var coreSizes = [];
      for (var q3 = 0; q3 < total; q3++) {
        if (!grid[q3] || hullSet[q3] || coreId[q3]) continue;
        var cid = coreSizes.length + 1;
        var cstack = [q3];
        coreId[q3] = cid;
        var csz = 0;
        while (cstack.length) {
          var cc2 = cstack.pop(); csz++;
          var cx4 = (cc2 / (Y * Z)) | 0, crm4 = cc2 - cx4 * Y * Z, cy4 = (crm4 / Z) | 0, cz4 = crm4 - cy4 * Z;
          var cnbs = [];
          if (cx4 > 0) cnbs.push(cc2 - Y * Z);
          if (cx4 < X - 1) cnbs.push(cc2 + Y * Z);
          if (cy4 > 0) cnbs.push(cc2 - Z);
          if (cy4 < Y - 1) cnbs.push(cc2 + Z);
          if (cz4 > 0) cnbs.push(cc2 - 1);
          if (cz4 < Z - 1) cnbs.push(cc2 + 1);
          for (var cn = 0; cn < cnbs.length; cn++) {
            var cnb = cnbs[cn];
            if (grid[cnb] && !hullSet[cnb] && !coreId[cnb]) { coreId[cnb] = cid; cstack.push(cnb); }
          }
        }
        coreSizes.push(csz);
      }
      var mainCore = 0, mainCoreSize = 0;
      for (var mc = 0; mc < coreSizes.length; mc++) {
        if (coreSizes[mc] > mainCoreSize) { mainCoreSize = coreSizes[mc]; mainCore = mc + 1; }
      }
      for (var q4 = 0; q4 < total; q4++) {
        if (coreId[q4] && coreId[q4] !== mainCore) {
          hullSet[q4] = 1;
          hullCells.push(q4);
          sealedFill[q4] = 1;
          pocketsFilled++;
          filled++;
        }
      }
      return filled;
    };
    /* drop floating chips (a crack can split off a shard) — keep only the
       main body, so nothing floats loose from the ship */
    var dropChips = function () {
      var compLab2 = new Int32Array(total);
      var compSizes2 = [];
      for (var fc3 = 0; fc3 < hullCells.length; fc3++) {
        var fc4 = hullCells[fc3];
        if (compLab2[fc4]) continue;
        var cid2 = compSizes2.length + 1;
        var fstack2 = [fc4];
        compLab2[fc4] = cid2;
        var csz2 = 0;
        while (fstack2.length) {
          var fc5 = fstack2.pop(); csz2++;
          var fx2 = (fc5 / (Y * Z)) | 0, frm2 = fc5 - fx2 * Y * Z, fy2 = (frm2 / Z) | 0, fz2 = frm2 - fy2 * Z;
          var fnbs2 = [];
          if (fx2 > 0) fnbs2.push(fc5 - Y * Z);
          if (fx2 < X - 1) fnbs2.push(fc5 + Y * Z);
          if (fy2 > 0) fnbs2.push(fc5 - Z);
          if (fy2 < Y - 1) fnbs2.push(fc5 + Z);
          if (fz2 > 0) fnbs2.push(fc5 - 1);
          if (fz2 < Z - 1) fnbs2.push(fc5 + 1);
          for (var fn2 = 0; fn2 < fnbs2.length; fn2++) {
            var fnb2 = fnbs2[fn2];
            if (hullSet[fnb2] && !compLab2[fnb2]) { compLab2[fnb2] = cid2; fstack2.push(fnb2); }
          }
        }
        compSizes2.push(csz2);
      }
      var mainId2 = 0, mainSize2 = 0;
      for (var mc2 = 0; mc2 < compSizes2.length; mc2++) {
        if (compSizes2[mc2] > mainSize2) { mainSize2 = compSizes2[mc2]; mainId2 = mc2 + 1; }
      }
      if (mainId2) {
        for (var dc = hullCells.length - 1; dc >= 0; dc--) {
          var dc0 = hullCells[dc];
          if (compLab2[dc0] && compLab2[dc0] !== mainId2) {
            grid[dc0] = 0;
            hullSet[dc0] = 0;
            solid--;
            hullCells.splice(dc, 1);
          }
        }
      }
    };

    /* seal-and-connect: repeat bridging + stranded fills until stable, then
       drop chips and refill any air pocket the bridges walled off */
    for (var cycle = 0; cycle < 4; cycle++) {
      if (!hollow) { closeHull(); dropChips(); break; }
      if (!closeHull() && !fillStranded()) break;
    }
    closeHull();
    dropChips();
    var sealLab2 = airLabels(grid, X, Y, Z);
    for (var q5 = 0; q5 < total; q5++) {
      if (sealLab2[q5] === 2) {
        grid[q5] = 1;
        solid++;
        pocketsFilled++;
        hullSet[q5] = 1;
        hullCells.push(q5);
        sealedFill[q5] = 1;
      }
    }

    var hullCount = hullCells.length;
    var cellType = new Uint8Array(total);   /* 0 none, 1 crystal, 2+ inclusion variant */
    for (var h2 = 0; h2 < hullCells.length; h2++) cellType[hullCells[h2]] = 1;
    var interior = hollow ? solid - hullCount : 0;

    /* ---- inclusions: glass OR glow patches replacing hull cells, for
       crystal texturing. Each variant is a material with its own share of
       the hull, grown as seeded blobs — patches, not a sprinkle — so e.g.
       three glass variants read as natural patchwork texture. Legacy
       single-variant params (inclusionMaterial + inclusionPct, or a raw
       inclusionCount of clusters) still work as variant 0. ---- */
    var variants = [];
    if (Array.isArray(p.inclusions) && p.inclusions.length) {
      for (var v0 = 0; v0 < p.inclusions.length && v0 < 72; v0++) {
        var ve = p.inclusions[v0] || {};
        variants.push({ material: String(ve.material || 'sea_lantern'), pct: clamp(+ve.pct || 0, 0, 100), count: 0 });
      }
    } else {
      variants.push({ material: p.inclusionMaterial || 'sea_lantern', pct: inclusionPct, count: 0 });
    }
    var inclusionTotal = 0;
    for (var vi = 0; vi < variants.length; vi++) {
      var vt = variants[vi];
      var vtTarget = legacyInc >= 0 ? -1 : Math.round(vt.pct / 100 * hullCount);
      var vtLimit = legacyInc >= 0 ? legacyInc : 5000;
      var placed = 0, stalls = 0;
      for (var inc = 0; inc < vtLimit; inc++) {
        if (legacyInc < 0 && placed >= vtTarget) break;
        if (legacyInc < 0 && stalls >= 200) break;
        if (!hullCells.length) break;
        var before = placed;
        var start = hullCells[Math.floor(rand() * hullCells.length)];
        if (cellType[start] !== 1 || sealedFill[start]) { stalls++; continue; }
        var size = 3 + Math.floor(rand() * 8);   /* a patch of 3–10 blocks */
        var queue = [start], seen = {};
        var placedNow = 0;
        while (queue.length && placedNow < size) {
          var q = queue.pop();
          if (seen[q] || cellType[q] !== 1 || sealedFill[q]) continue;
          seen[q] = 1;
          cellType[q] = 2 + vi;
          placedNow++;
          var qx = (q / (Y * Z)) | 0, qrm = q - qx * Y * Z, qy = (qrm / Z) | 0, qz = qrm - qy * Z;
          var opts = [];
          if (qx > 0) opts.push(q - Y * Z);
          if (qx < X - 1) opts.push(q + Y * Z);
          if (qy > 0) opts.push(q - Z);
          if (qy < Y - 1) opts.push(q + Z);
          if (qz > 0) opts.push(q - 1);
          if (qz < Z - 1) opts.push(q + 1);
          while (opts.length) queue.push(opts.splice(Math.floor(rand() * opts.length), 1)[0]);
        }
        placed += placedNow;
        if (placed === before) stalls++; else stalls = 0;
      }
      vt.count = placed;
      inclusionTotal += placed;
    }

/* ---- emit: the pure shard (no deck, no drive — you fit the interior) ---- */
    var nCells = hullCells.length;
    var positions = new Int16Array(nCells * 3), types = new Uint8Array(nCells);
    var ci = 0, crystalCount = 0;   /* inclusionTotal is counted during patch placement */
    for (var h4 = 0; h4 < hullCells.length; h4++) {
      var cc = hullCells[h4];
      var cxx = (cc / (Y * Z)) | 0, crm2 = cc - cxx * Y * Z, cyy = (crm2 / Z) | 0, czz = crm2 - cyy * Z;
      /* horizontal: swap the long axis into X (bullet in flight, tip +X).
         The nose dip is already baked into the slice centers, so this is a
         pure axis swap — face-adjacency is preserved, the hull is airtight. */
      positions[ci * 3] = lying ? cyy : cxx;
      positions[ci * 3 + 1] = lying ? cxx : cyy;
      positions[ci * 3 + 2] = czz;
      var vIdx = cellType[cc] - 2;
      if (vIdx >= 0) types[ci] = vIdx === 0 ? INCLUSION : INCLUSION_V + vIdx - 1;
      else { types[ci] = CRYSTAL; crystalCount++; }
      ci++;
    }
    var minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1e9, maxY = -1e9, maxZ = -1e9;
    for (var e = 0; e < nCells; e++) {
      var px3 = positions[e * 3], py3 = positions[e * 3 + 1], pz3 = positions[e * 3 + 2];
      if (px3 < minX) minX = px3; if (px3 > maxX) maxX = px3;
      if (py3 < minY) minY = py3; if (py3 > maxY) maxY = py3;
      if (pz3 < minZ) minZ = pz3; if (pz3 > maxZ) maxZ = pz3;
    }
    var yShift = -minY;   /* sit on the grid in either orientation */
    if (yShift) for (var e2 = 0; e2 < nCells; e2++) positions[e2 * 3 + 1] += yShift;
    minY += yShift; maxY += yShift;

    /* the shard's INTERNAL center — the middle of the long axis at the
       widest cross-section. The NBT center marker goes here, so the pasted
       crystal carries its true center reference. */
    var cT = 0.5;
    var cDip = Math.round(leanX * cT);
    var cix = Math.floor(cx0 + (lying ? -cDip : cDip));
    var ciy = Math.floor((H - 1) / 2);
    var ciz = Math.floor(cz0 + leanZ * cT);
    var centerCell = lying ? { x: ciy, y: cix + yShift, z: ciz } : { x: cix, y: ciy + yShift, z: ciz };

    var solidPositions = null;
    if (p.includeSolid && solid <= 2000000) {
      solidPositions = new Int16Array(solid * 3);
      var si = 0;
      for (var gi2 = 0; gi2 < total && si < solid; gi2++) {
        if (!grid[gi2]) continue;
        var gx2 = (gi2 / (Y * Z)) | 0, grm2 = gi2 - gx2 * Y * Z, gy2 = (grm2 / Z) | 0, gz2 = grm2 - gy2 * Z;
        solidPositions[si * 3] = lying ? gy2 : gx2;
        solidPositions[si * 3 + 1] = (lying ? gx2 : gy2) + yShift;
        solidPositions[si * 3 + 2] = gz2;
        si++;
      }
    }

    /* ponder-style build steps */
    var steps = [
      { text: 'Start at the tail point and build out to the widest band — this half opens the cavity.', blocks: [] },
      { text: 'Close the nose half down to the tip — the cavity is now sealed.', blocks: [] },
      { text: 'Set the inclusion patches into the hull where the guide shows them.', blocks: [] }
    ];
    var lowEnd = lying ? minX : 0;   /* positions are y-shifted; the tail tip is at minX (lying) or y 0 (upright) */
    for (var i5 = 0; i5 < nCells; i5++) {
      var vv = positions[i5 * 3 + (lying ? 0 : 1)];
      if (isIncType(types[i5])) steps[2].blocks.push(i5);
      else if (vv <= lowEnd + H * tLo + 1) steps[0].blocks.push(i5);
      else steps[1].blocks.push(i5);
    }
    steps = steps.filter(function (s) { return s.blocks.length > 0; });

    var burners = interior > 0 ? Math.max(1, Math.ceil(interior / 500)) : 0;
    var lift = interior * 1.5;
    var mass = (nCells + burners) * blockMass + payload;
    return {
      positions: positions, types: types, steps: steps, count: nCells,
      interior: interior, solid: solid, solidPositions: solidPositions,
      wool: 0, logs: 0, planks: 0,
      minX: minX, minY: minY, minZ: minZ, maxX: maxX, maxY: maxY, maxZ: maxZ,
      hollow: hollow,
      center: centerCell,
      crystalCount: crystalCount, inclusionTotal: inclusionTotal, cracksMade: cracksMade, inclusionPct: inclusionPct,
      inclusions: variants.map(function (vv) { return { material: vv.material, pct: vv.pct, count: vv.count }; }),
      pocketsFilled: pocketsFilled,
      burners: burners, lift: lift, mass: mass, net: lift - mass,
      blockMass: blockMass, payload: payload, seed: seed,
      facets: n, heightY: H, baseDiagX: BX, baseDiagZ: BZ, midBand: midBand, midY: midY,
      orientation: orientation, centerMode: centerMode, leanX: leanX, leanZ: leanZ
    };
  }

  /* ============ shapes module: classic building primitives ============
     sphere / ellipsoid, cylinder, cone, pyramid, torus, dome — hollow or
     solid, with shell thickness. The same real material blocks as the rest
     of the site (wool, planks, logs, glass). */
  function shapeDims(kind, sx, sy, sz) {
    if (kind === 'torus') {
      var R = sx / 2, r = Math.min(sy, sz) / 2;
      return { X: Math.ceil(2 * (R + r)) + 2, Y: Math.ceil(2 * r) + 2, Z: Math.ceil(2 * (R + r)) + 2 };
    }
    return { X: sx + 2, Y: sy + 2, Z: sz + 2 };
  }

  function genShapes(p) {
    p = p || {};
    var kind = p.kind || 'sphere';
    var sx = clamp(Math.round(p.sizeX || 20), 3, 200);
    var sy = clamp(Math.round(p.sizeY || 20), 3, 200);
    var sz = clamp(Math.round(p.sizeZ || 20), 3, 200);
    var hollow = p.hollow !== false;
    var shell = hollow ? clamp(Math.round(p.shell || 1), 1, 3) : 0;
    var axis = p.axis || 'y';
    var dims = shapeDims(kind, sx, sy, sz);
    var X = dims.X, Y = dims.Y, Z = dims.Z;
    var total = X * Y * Z;
    if (total > 24000000) {   /* cap grid size: scale everything down */
      var sc = Math.sqrt(24000000 / total);
      sx = Math.max(3, Math.floor(sx * sc)); sy = Math.max(3, Math.floor(sy * sc)); sz = Math.max(3, Math.floor(sz * sc));
      dims = shapeDims(kind, sx, sy, sz);
      X = dims.X; Y = dims.Y; Z = dims.Z;
      total = X * Y * Z;
    }
    var grid = new Uint8Array(total);
    var solid = 0;
    var A = sx / 2, B = sy / 2, C = sz / 2;
    var R = A, r = Math.min(B, C);
    var cx = X / 2, cy = Y / 2, cz = Z / 2;
    var YZ = Y * Z;
    for (var gx = 0; gx < X; gx++) {
      var dX = gx + 0.5 - cx;
      for (var gy = 0; gy < Y; gy++) {
        var dY = gy + 0.5 - cy;
        for (var gz = 0; gz < Z; gz++) {
          var dZ = gz + 0.5 - cz;
          var hit = false;
          if (kind === 'sphere' || kind === 'ellipsoid') {
            var nx = dX / A, ny = dY / B, nz = dZ / C;
            hit = nx * nx + ny * ny + nz * nz <= 1;
          } else if (kind === 'dome') {
            var nx2 = dX / A, ny2 = dY / B, nz2 = dZ / C;
            hit = dY >= 0 && nx2 * nx2 + ny2 * ny2 + nz2 * nz2 <= 1;
          } else if (kind === 'cylinder') {
            var nx3 = dX / A, ny3 = dY / B, nz3 = dZ / C;
            hit = axis === 'y' ? nx3 * nx3 + nz3 * nz3 <= 1
              : axis === 'x' ? ny3 * ny3 + nz3 * nz3 <= 1
              : nx3 * nx3 + ny3 * ny3 <= 1;
          } else if (kind === 'cone') {
            var tt = axis === 'y' ? (gy - 0.5) / sy : axis === 'x' ? (gx - 0.5) / sx : (gz - 0.5) / sz;
            var kk = Math.max(0, 1 - tt);
            var nx4 = dX / A, ny4 = dY / B, nz4 = dZ / C;
            hit = axis === 'y' ? (nx4 * nx4 + nz4 * nz4 <= kk * kk)
              : axis === 'x' ? (ny4 * ny4 + nz4 * nz4 <= kk * kk)
              : (nx4 * nx4 + ny4 * ny4 <= kk * kk);
          } else if (kind === 'pyramid') {
            var tt2 = (gy - 0.5) / sy;
            var kk2 = Math.max(0, 1 - tt2);
            hit = Math.abs(dX) <= A * kk2 + 0.5 && Math.abs(dZ) <= C * kk2 + 0.5 && gy >= 0.5 && gy <= sy + 0.5;
          } else if (kind === 'torus') {
            var rr = Math.sqrt(dX * dX + dZ * dZ);
            hit = (rr - R) * (rr - R) + dY * dY <= r * r;
          }
          if (hit) { grid[gx * YZ + gy * Z + gz] = 1; solid++; }
        }
      }
    }
    var hullCount = 0;
    var outCount = 0;
    var outType = new Uint8Array(total);
    if (hollow) {
      var peel = shellPeel(grid, X, Y, Z, shell);
      outType = peel.hull;
      hullCount = peel.count;
      outCount = hullCount;
    } else {
      outType = grid;
      outCount = solid;
      hullCount = solid;
    }
    var interior = solid - hullCount;
    var n = outCount;
    var positions = new Int16Array(n * 3), types = new Uint8Array(n);
    var mat = p.material === 'planks' ? PLANK : p.material === 'log' ? LOG : p.material === 'glass' ? CRYSTAL : WOOL;
    var ci = 0;
    var minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1e9, maxY = -1e9, maxZ = -1e9;
    for (var i = 0; i < total; i++) {
      if (!outType[i]) continue;
      var gx3 = (i / YZ) | 0, rem = i - gx3 * YZ, gy3 = (rem / Z) | 0, gz3 = rem - gy3 * Z;
      positions[ci * 3] = gx3;
      positions[ci * 3 + 1] = gy3;
      positions[ci * 3 + 2] = gz3;
      types[ci] = mat;
      ci++;
      if (gx3 < minX) minX = gx3; if (gx3 > maxX) maxX = gx3;
      if (gy3 < minY) minY = gy3; if (gy3 > maxY) maxY = gy3;
      if (gz3 < minZ) minZ = gz3; if (gz3 > maxZ) maxZ = gz3;
    }
    return {
      positions: positions, types: types, count: n,
      interior: interior, solid: solid, solidPositions: null,
      wool: mat === WOOL ? n : 0, logs: mat === LOG ? n : 0, planks: mat === PLANK ? n : 0,
      minX: minX, minY: minY, minZ: minZ, maxX: maxX, maxY: maxY, maxZ: maxZ,
      hollow: hollow, kind: kind, sizeX: sx, sizeY: sy, sizeZ: sz
    };
  }

  /* ============ requirement math ============
     The actual requirements for a generated shape, grounded in Create
     Aeronautics 1.3.0 config (AeroPhysics / AeroBlockConfigs):
       hotAirStrength = 1.5 mass units lifted per heated block
       hotAirBurnerMaxHotAir = 500 blocks per adjustable burner */
  function mathFor(r, blockMass, payload) {
    var bm = clamp(+blockMass || 1, 0.1, 100);
    var pl = clamp(+payload || 0, 0, 1000000);
    var burners = r.interior > 0 ? Math.ceil(r.interior / 500) : 0;
    var covered = burners * 500;
    var lift = r.interior * 1.5;
    var mass = (r.count + burners) * bm + pl;
    return {
      burners: burners, covered: covered, waste: burners ? covered - r.interior : 0,
      lift: lift, mass: mass, net: lift - mass, flies: lift >= mass,
      volWool: r.count ? r.interior / r.count : 0
    };
  }

  /* propeller requirements: swept disc geometry + material totals */
  function propMath(p, r) {
    var L = clamp(+p.length || 10, 3, 50);
    var F = clamp(Math.round(p.blades || 4), 2, 12);
    var discDia = 2 * L;
    var discArea = Math.PI * L * L;
    var perBlade = (r.count - 1) / F;   /* the single hub block is shared by all blades */
    var solidity = discArea > 0 ? r.count / discArea : 0;
    return {
      blades: F, total: r.count, perBlade: perBlade,
      discDia: discDia, discArea: discArea, solidity: solidity,
      bearings: 1, material: p.bladeMaterial || 'wool'
    };
  }

  /* ============ balance checker: center of mass ============
     Approximate per-block masses, Create-style. The handful of known-heavy
     Create blocks carry the mod's familiar weights; everything else counts
     as one mass unit — the same assumption as the blockMass slider. */
  var MASS_TABLE = {
    'create:andesite_casing': 4, 'create:brass_casing': 5, 'create:copper_casing': 4,
    'create:industrial_iron_block': 6, 'create:shaft': 2, 'create:cogwheel': 3,
    'create:large_cogwheel': 3, 'create:flywheel': 4, 'create:fluid_tank': 3,
    'create:blaze_burner': 2, 'create:steam_engine': 8, 'create:mechanical_pump': 3,
    'create:water_wheel': 8, 'create:large_water_wheel': 12,
    'aeronautics:adjustable_burner': 2, 'simulated:physics_assembler': 3,
    'minecraft:heavy_core': 5
  };
  function massOf(name) {
    if (!name) return 1;
    if (MASS_TABLE[name] !== undefined) return MASS_TABLE[name];
    return 1;
  }

  /* weighted center of mass of [{x,y,z,m}] entries (cell-center coords) */
  function comFor(entries) {
    var sx = 0, sy = 0, sz = 0, m = 0;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      sx += e.x * e.m; sy += e.y * e.m; sz += e.z * e.m; m += e.m;
    }
    if (m <= 0) return { x: 0, y: 0, z: 0, mass: 0 };
    return { x: sx / m, y: sy / m, z: sz / m, mass: m };
  }

  /* Turn a parsed schematic back into a renderable block model: every block
     becomes a voxel typed 100+paletteIndex (the UI colours these by name). */
  function blocksToResult(audit) {
    var n = audit.blocks.length;
    var positions = new Int16Array(n * 3), types = new Uint8Array(n);
    var minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1e9, maxY = -1e9, maxZ = -1e9;
    for (var i = 0; i < n; i++) {
      var b = audit.blocks[i];
      positions[i * 3] = b.x;
      positions[i * 3 + 1] = b.y;
      positions[i * 3 + 2] = b.z;
      types[i] = Math.min(255, 100 + b.state);
      if (b.x < minX) minX = b.x; if (b.x > maxX) maxX = b.x;
      if (b.y < minY) minY = b.y; if (b.y > maxY) maxY = b.y;
      if (b.z < minZ) minZ = b.z; if (b.z > maxZ) maxZ = b.z;
    }
    return {
      positions: positions, types: types, count: n,
      interior: 0, solid: n, solidPositions: null,
      wool: 0, logs: 0, planks: 0,
      minX: minX, minY: minY, minZ: minZ, maxX: maxX, maxY: maxY, maxZ: maxZ,
      hollow: false, fromSchematic: true
    };
  }

  /* Full 6-axis balance report for a weighted block set, vs a reference
     center. Measures everything the user can feel in flight:
     - back/forth (X) and left/right (Z): COM offset vs the middle
     - up/down (Y): COM height — low hangs like a pendulum, high is tippy
     - tilt (roll about the nose axis): left vs right mass split
     - pan (pitch about the lateral axis): front vs back mass split
     - yaw: front-half side offset vs back-half side offset — opposite sides
       twist the craft about the vertical axis
     Each axis gets a status (ok / wonky / bad) and the whole set gets one
     verdict: PERFECTLY STRAIGHT, WONKY or UNEVEN. */
  function balanceReport(entries, center) {
    var com = comFor(entries);
    var M = com.mass || 1;
    var dx = com.x - center.x, dy = com.y - center.y, dz = com.z - center.z;
    var mFront = 0, mBack = 0, mLeft = 0, mRight = 0, mTop = 0, mBottom = 0;
    var frontZ = 0, backZ = 0;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var z = e.z - center.z;
      if (e.x >= center.x) { mFront += e.m; frontZ += e.m * z; }
      else { mBack += e.m; backZ += e.m * z; }
      if (e.z >= center.z) mRight += e.m; else mLeft += e.m;
      if (e.y >= center.y) mTop += e.m; else mBottom += e.m;
    }
    /* yaw twist: if the front half sits on one side and the back half on the
       other, the craft spins about Y when it pitches — blocks of separation */
    var yawTwist = (mFront ? frontZ / mFront : 0) - (mBack ? backZ / mBack : 0);
    var tilt = (mRight - mLeft) / M;   /* signed fraction of mass on the right */
    var pan = (mFront - mBack) / M;    /* signed fraction of mass up front */
    var axis = function (name, value, wonky) {
      var a = Math.abs(value);
      var s = a <= 0.5 ? 'ok' : (a <= wonky ? 'wonky' : 'bad');
      return { name: name, value: value, status: s };
    };
    var axes = {
      backForth: axis('back/forth', dx, 2),
      leftRight: axis('left/right', dz, 2),
      upDown: axis('up/down', dy, 2),
      tilt: axis('tilt (roll)', dz, 2),   /* roll is driven by the same side offset */
      pan: axis('pan (pitch)', dx, 2),    /* pitch is driven by the front/back offset */
      yaw: axis('yaw', yawTwist, 3)
    };
    var worst = 'ok';
    for (var k in axes) {
      if (axes[k].status === 'wonky' && worst === 'ok') worst = 'wonky';
      if (axes[k].status === 'bad') worst = 'bad';
    }
    /* per-axis fix instructions, in mass-blocks (mass × blocks to shift) */
    var fixes = [];
    if (Math.abs(dx) > 0.5) fixes.push('shift ~' + Math.round(M * Math.abs(dx)).toLocaleString() + ' mass-blocks toward the ' + (dx > 0 ? 'tail' : 'nose'));
    if (Math.abs(dz) > 0.5) fixes.push('shift ~' + Math.round(M * Math.abs(dz)).toLocaleString() + ' mass-blocks toward the ' + (dz > 0 ? 'left' : 'right'));
    if (Math.abs(dy) > 0.5) fixes.push(dy > 0 ? 'lower heavy blocks (COM sits high — tippy)' : 'COM sits low — stable, nothing to fix');
    if (Math.abs(yawTwist) > 0.5) fixes.push('yaw twist: move mass from the front-' + (frontZ / Math.max(mFront, 1) > 0 ? 'right' : 'left') + ' to the back-' + (backZ / Math.max(mBack, 1) > 0 ? 'left' : 'right'));
    return {
      com: com, center: center, mass: M,
      offset: { x: dx, y: dy, z: dz },
      splits: { front: mFront, back: mBack, left: mLeft, right: mRight, top: mTop, bottom: mBottom },
      tilt: tilt, pan: pan, yawTwist: yawTwist,
      axes: axes, verdict: worst, fixes: fixes
    };
  }

  /* Balance verdict, in two parts:
     - the ship's INTERNAL balance: its COM vs its own bbox middle (what you
       fix by moving blocks around inside the ship)
     - the CRAFT balance: hull + ship together, with the ship pasted so its
       COM lands on the shard's middle plus the user's placement offsets
       (what the overlay shows — and what the ship position sliders trim). */
  function comCheck(crystal, audit, shipX, shipZ) {
    shipX = +shipX || 0; shipZ = +shipZ || 0;
    var entries = [];
    for (var b = 0; b < audit.blocks.length; b++) {
      var blk = audit.blocks[b];
      var nm = audit.palette[blk.state] ? audit.palette[blk.state].name : 'minecraft:stone';
      entries.push({ x: blk.x + 0.5, y: blk.y + 0.5, z: blk.z + 0.5, m: massOf(nm) });
    }
    var shipCom = comFor(entries);
    var shipCenter = audit.center;
    if (!shipCenter) {
      var mnx = 1e9, mny = 1e9, mnz = 1e9, mxx = -1e9, mxy = -1e9, mxz = -1e9;
      for (var b0 = 0; b0 < audit.blocks.length; b0++) {
        var b1 = audit.blocks[b0];
        if (b1.x < mnx) mnx = b1.x; if (b1.x > mxx) mxx = b1.x;
        if (b1.y < mny) mny = b1.y; if (b1.y > mxy) mxy = b1.y;
        if (b1.z < mnz) mnz = b1.z; if (b1.z > mxz) mxz = b1.z;
      }
      shipCenter = { x: (mnx + mxx + 1) / 2, y: (mny + mxy + 1) / 2, z: (mnz + mxz + 1) / 2 };
    }
    var crystalCenter = {
      x: (crystal.minX + crystal.maxX + 1) / 2,
      y: (crystal.minY + crystal.maxY + 1) / 2,
      z: (crystal.minZ + crystal.maxZ + 1) / 2
    };
    var cEntries = [];
    for (var i = 0; i < crystal.count; i++) {
      cEntries.push({
        x: crystal.positions[i * 3] + 0.5,
        y: crystal.positions[i * 3 + 1] + 0.5,
        z: crystal.positions[i * 3 + 2] + 0.5,
        m: 1
      });
    }
    var crystalCom = comFor(cEntries);
    var ship = balanceReport(entries, shipCenter);
    /* the ship is pasted so its COM lands on the shard's middle + placement
       offsets; the combined craft's balance is measured against the middle */
    var place = {
      x: crystalCenter.x + shipX,
      y: crystalCenter.y,
      z: crystalCenter.z + shipZ
    };
    var shift = {
      x: place.x - shipCom.x,
      y: place.y - shipCom.y,
      z: place.z - shipCom.z
    };
    var combinedEntries = cEntries.slice();
    for (var c = 0; c < entries.length; c++) {
      combinedEntries.push({
        x: entries[c].x + shift.x,
        y: entries[c].y + shift.y,
        z: entries[c].z + shift.z,
        m: entries[c].m
      });
    }
    var combined = balanceReport(combinedEntries, crystalCenter);
    var offset = ship.offset;
    var combinedOffset = combined.offset;
    var balanced = ship.verdict === 'ok';
    /* where the ship position sliders should go to zero the combined COM:
       off = (Mc/Ms) * (center - crystalCom) — one click auto-trim */
    var autoTrim = {
      x: (crystalCom.mass / Math.max(1, shipCom.mass)) * (crystalCenter.x - crystalCom.x),
      z: (crystalCom.mass / Math.max(1, shipCom.mass)) * (crystalCenter.z - crystalCom.z)
    };
    return {
      shipCom: shipCom, shipCenter: shipCenter, crystalCenter: crystalCenter, crystalCom: crystalCom,
      offset: offset, combinedOffset: combinedOffset, balanced: balanced,
      shipMass: shipCom.mass, crystalMass: crystalCom.mass, totalMass: shipCom.mass + crystalCom.mass,
      ship: ship, combined: combined, shift: shift, autoTrim: autoTrim
    };
  }

  /* Merge the crystal hull and the ship schematic into one renderable model.
     The ship is shifted so its COM lands exactly on the crystal's middle —
     the visual truth of the balance check. */
  function overlay(crystal, audit, shipX, shipZ) {
    var ck = comCheck(crystal, audit, shipX, shipZ);
    var sx = Math.round(ck.shift.x);
    var sy = Math.round(ck.shift.y);
    var sz = Math.round(ck.shift.z);
    var ship = blocksToResult(audit);
    var n = crystal.count + ship.count;
    var positions = new Int16Array(n * 3), types = new Uint8Array(n);
    var ci = 0;
    for (var i = 0; i < crystal.count; i++) {
      positions[ci * 3] = crystal.positions[i * 3];
      positions[ci * 3 + 1] = crystal.positions[i * 3 + 1];
      positions[ci * 3 + 2] = crystal.positions[i * 3 + 2];
      types[ci] = crystal.types[i];
      ci++;
    }
    for (var j = 0; j < ship.count; j++) {
      positions[ci * 3] = ship.positions[j * 3] + sx;
      positions[ci * 3 + 1] = ship.positions[j * 3 + 1] + sy;
      positions[ci * 3 + 2] = ship.positions[j * 3 + 2] + sz;
      types[ci] = ship.types[j];
      ci++;
    }
    var minX = Math.min(crystal.minX, ship.minX + sx), minY = Math.min(crystal.minY, ship.minY + sy), minZ = Math.min(crystal.minZ, ship.minZ + sz);
    var maxX = Math.max(crystal.maxX, ship.maxX + sx), maxY = Math.max(crystal.maxY, ship.maxY + sy), maxZ = Math.max(crystal.maxZ, ship.maxZ + sz);
    return {
      positions: positions, types: types, count: n,
      interior: crystal.interior, solid: crystal.solid,
      wool: 0, logs: 0, planks: 0,
      minX: minX, minY: minY, minZ: minZ, maxX: maxX, maxY: maxY, maxZ: maxZ,
      hollow: crystal.hollow, overlayCheck: ck
    };
  }

  /* ============ schematic lab: read .schem / .nbt files ============
     Sponge v2 (the format this site exports) is the vanilla structure
     format: root compound with DataVersion, size, palette (Name +
     Properties) and a blocks list of pos/state. Parsed client-side so
     the lab can audit any schematic: material totals, mass, and a
     Create Aeronautics block census. */
  function inflateGz(bytes) {
    if (typeof DecompressionStream !== 'undefined') {
      var stream = new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')));
      return stream.arrayBuffer();
    }
    return Promise.reject(new Error('no DecompressionStream'));
  }

  function nbtRead(buf, off) {
    off = off || 0;
    var tag = buf[off]; off++;
    if (tag === 0) return { tag: 0, name: '', value: null, off: off };
    var nameLen = (buf[off] << 8) | buf[off + 1]; off += 2;
    var name = '';
    for (var i = 0; i < nameLen; i++) name += String.fromCharCode(buf[off + i]);
    off += nameLen;
    var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    var r = nbtPayload(tag, dv, off);
    return { tag: tag, name: name, value: r.value, off: r.off };
  }
  function nbtPayload(tag, dv, off) {
    var i, len, str, arr, lst, ent, v, comp = {};
    switch (tag) {
      case 1: return { value: dv.getInt8(off), off: off + 1 };
      case 2: return { value: dv.getInt16(off), off: off + 2 };
      case 3: return { value: dv.getInt32(off), off: off + 4 };
      case 4: return { value: dv.getBigInt64(off), off: off + 8 };
      case 5: return { value: dv.getFloat32(off), off: off + 4 };
      case 6: return { value: dv.getFloat64(off), off: off + 8 };
      case 7:
        len = dv.getInt32(off); off += 4;
        arr = new Uint8Array(len);
        for (i = 0; i < len; i++) arr[i] = dv.getUint8(off + i);
        return { value: arr, off: off + len };
      case 8:
        len = dv.getUint16(off); off += 2;
        str = '';
        for (i = 0; i < len; i++) str += String.fromCharCode(dv.getUint8(off + i));
        return { value: str, off: off + len };
      case 9:
        var et = dv.getUint8(off); off += 1;
        len = dv.getInt32(off); off += 4;
        lst = [];
        if (et === 0) return { value: lst, off: off };
        for (i = 0; i < len; i++) {
          if (et === 10) {
            comp = {};
            while (true) {
              var nt = dv.getUint8(off);
              if (nt === 0) { off++; break; }
              /* legacy (pre-1.20.2) schematics wrap each list member in an
                 empty-name compound (0a 00 00) — peek and skip it */
              if (nt === 10 && dv.getUint16(off + 1) === 0) { off += 3; continue; }
              var nl = dv.getUint16(off + 1); off += 3;
              var nm = '';
              for (var j = 0; j < nl; j++) nm += String.fromCharCode(dv.getUint8(off + j));
              off += nl;
              var np = nbtPayload(nt, dv, off);
              comp[nm] = { tag: nt, value: np.value };
              off = np.off;
            }
            lst.push(comp);
          } else {
            var p2 = nbtPayload(et, dv, off);
            lst.push(p2.value);
            off = p2.off;
          }
        }
        return { value: lst, off: off };
      case 10:
        while (true) {
          var t2 = dv.getUint8(off);
          if (t2 === 0) { off++; break; }
          var nl2 = dv.getUint16(off + 1); off += 3;
          var nm2 = '';
          for (var j2 = 0; j2 < nl2; j2++) nm2 += String.fromCharCode(dv.getUint8(off + j2));
          off += nl2;
          var r2 = nbtPayload(t2, dv, off);
          comp[nm2] = { tag: t2, value: r2.value };
          off = r2.off;
        }
        return { value: comp, off: off };
      case 11:
        len = dv.getInt32(off); off += 4;
        arr = new Int32Array(len);
        for (i = 0; i < len; i++) arr[i] = dv.getInt32(off + i * 4);
        return { value: arr, off: off + len * 4 };
      case 12:
        len = dv.getInt32(off); off += 4;
        arr = new Array(len);
        for (i = 0; i < len; i++) arr[i] = dv.getBigInt64(off + i * 8);
        return { value: arr, off: off + len * 8 };
    }
    return { value: null, off: off };
  }

  function analyzeSchematic(bytes, opts) {
    opts = opts || {};
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var isGz = u8.length > 2 && u8[0] === 0x1f && u8[1] === 0x8b;
    var work = isGz ? inflateGz(u8)
      : Promise.resolve(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
    return work.then(function (ab) {
      var buf = new Uint8Array(ab);
      var root;
      try { root = nbtRead(buf); }
      catch (e) { return { ok: false, error: 'corrupt NBT data' }; }
      if (root.tag !== 10) return { ok: false, error: 'not an NBT root compound' };
      var v = root.value;
      var palette = [];
      if (v.palette && v.palette.tag === 9) {
        for (var i = 0; i < v.palette.value.length; i++) {
          var pe = v.palette.value[i];
          if (!pe.Name || pe.Name.value === undefined) continue;
          var props = null;
          if (pe.Properties) {
            props = {};
            for (var pk in pe.Properties.value) props[pk] = pe.Properties.value[pk].value;
          }
          palette.push({ name: pe.Name.value, props: props });
        }
      }
      var blocks = [];
      if (v.blocks && v.blocks.tag === 9) {
        for (var b = 0; b < v.blocks.value.length; b++) {
          var be = v.blocks.value[b];
          if (!be.pos || !be.state) continue;
          var pos = be.pos.value, st = be.state.value;
          blocks.push({ x: pos[0], y: pos[1], z: pos[2], state: st });
        }
      }
      /* Litematica .litematic: Metadata + Regions with a packed BlockStates
         long array (vanilla LSB-first variable-bit packing) */
      if ((!palette.length || !blocks.length) && v.Regions && v.Regions.tag === 10) {
        var regMap = v.Regions.value || {};
        var regKey = Object.keys(regMap)[0];
        var reg = regKey && regMap[regKey] ? regMap[regKey].value : null;
        var litPal = reg && reg.BlockStatePalette && reg.BlockStatePalette.tag === 9 ? reg.BlockStatePalette.value : null;
        var litStates = reg && reg.BlockStates ? reg.BlockStates.value : null;
        if (litPal && litPal.length && litStates) {
          palette = [];
          for (var li0 = 0; li0 < litPal.length; li0++) {
            var lpe = litPal[li0];
            if (!lpe.Name) continue;
            var lprops = null;
            if (lpe.Properties) {
              lprops = {};
              for (var lpk in lpe.Properties.value) lprops[lpk] = lpe.Properties.value[lpk].value;
            }
            palette.push({ name: lpe.Name.value, props: lprops });
          }
          var lsize = reg.Size && reg.Size.value ? reg.Size.value : null;
          var lsx = lsize && lsize.x ? lsize.x.value : 0;
          var lsy = lsize && lsize.y ? lsize.y.value : 0;
          var lsz = lsize && lsize.z ? lsize.z.value : 0;
          if (lsx > 0 && lsy > 0 && lsz > 0 && palette.length) {
            var lbits = Math.max(2, 32 - Math.clz32(palette.length - 1));
            var lvol = lsx * lsy * lsz;
            var lmask = (1 << lbits) - 1;
            blocks = [];
            for (var li2 = 0; li2 < lvol; li2++) {
              var bitPos = li2 * lbits;
              var lli = Math.floor(bitPos / 64);
              var lbo = bitPos % 64;
              var lv = (litStates[lli] >> BigInt(lbo)) & BigInt(lmask);
              if (lbo + lbits > 64 && lli + 1 < litStates.length) {
                lv |= (litStates[lli + 1] & ((1n << BigInt(lbo + lbits - 64)) - 1n)) << BigInt(64 - lbo);
              }
              var idx = Number(lv);
              if (idx >= palette.length) continue;
              var pn = palette[idx].name;
              if (pn === 'minecraft:air' || pn === 'minecraft:cave_air' || pn === 'minecraft:void_air') continue;
              blocks.push({
                x: li2 % lsx,
                y: Math.floor(li2 / (lsx * lsz)) % lsy,
                z: Math.floor(li2 / lsx) % lsz,
                state: idx
              });
            }
          }
        }
      }
      if (!palette.length || !blocks.length) return { ok: false, error: 'no palette/blocks — not a Sponge v2, structure or Litematica schematic' };
      var counts = new Array(palette.length).fill(0);
      var minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1e9, maxY = -1e9, maxZ = -1e9;
      for (var k = 0; k < blocks.length; k++) {
        var st2 = blocks[k].state;
        if (st2 >= 0 && st2 < counts.length) counts[st2]++;
        var bx = blocks[k].x, by = blocks[k].y, bz = blocks[k].z;
        if (bx < minX) minX = bx; if (bx > maxX) maxX = bx;
        if (by < minY) minY = by; if (by > maxY) maxY = by;
        if (bz < minZ) minZ = bz; if (bz > maxZ) maxZ = bz;
      }
      var list = [];
      for (var m = 0; m < palette.length; m++) {
        if (counts[m] > 0) list.push({ name: palette[m].name, count: counts[m], props: palette[m].props });
      }
      list.sort(function (a, b) { return b.count - a.count; });
      var ns = {};
      var aero = { envelope: 0, burner: 0, levitite: 0, propeller: 0, bearing: 0, assembler: 0, steering: 0, throttle: 0 };
      for (var q = 0; q < list.length; q++) {
        var nm = list[q].name;
        var colon = nm.indexOf(':');
        var space = colon >= 0 ? nm.slice(0, colon) : 'unknown';
        ns[space] = (ns[space] || 0) + list[q].count;
        if (nm === 'aeronautics:adjustable_burner') aero.burner += list[q].count;
        else if (/^aeronautics:.*_envelope$/.test(nm)) aero.envelope += list[q].count;
        else if (nm === 'aeronautics:levitite' || nm === 'aeronautics:pearlescent_levitite') aero.levitite += list[q].count;
        else if (nm === 'aeronautics:wooden_propeller' || nm === 'aeronautics:andesite_propeller' || nm === 'aeronautics:smart_propeller') aero.propeller += list[q].count;
        else if (nm === 'aeronautics:propeller_bearing' || nm === 'aeronautics:gyroscopic_propeller_bearing') aero.bearing += list[q].count;
        else if (nm === 'simulated:physics_assembler') aero.assembler += list[q].count;
        else if (nm === 'simulated:steering_wheel') aero.steering += list[q].count;
        else if (nm === 'simulated:throttle_lever') aero.throttle += list[q].count;
      }
      var total = blocks.length;
      var bm = clamp(+opts.blockMass || 1, 0.1, 100);
      var pl = clamp(+opts.payload || 0, 0, 1000000);
      /* center of mass (weighted by the Create-style mass table) vs the
         middle of the occupied bounding box */
      var entries = [];
      for (var c2 = 0; c2 < blocks.length; c2++) {
        var bb = blocks[c2];
        var nmc = palette[bb.state] ? palette[bb.state].name : 'minecraft:stone';
        entries.push({ x: bb.x + 0.5, y: bb.y + 0.5, z: bb.z + 0.5, m: massOf(nmc) });
      }
      var com = comFor(entries);
      var center = { x: (minX + maxX + 1) / 2, y: (minY + maxY + 1) / 2, z: (minZ + maxZ + 1) / 2 };
      var comOffset = { x: com.x - center.x, y: com.y - center.y, z: com.z - center.z };
      var comBalanced = Math.abs(comOffset.x) <= 1 && Math.abs(comOffset.y) <= 1 && Math.abs(comOffset.z) <= 1;
      return {
        ok: true, gzipped: isGz, total: total,
        dataVersion: v.DataVersion ? v.DataVersion.value : null,
        size: { x: maxX - minX + 1, y: maxY - minY + 1, z: maxZ - minZ + 1 },
        min: { x: minX, y: minY, z: minZ },
        palette: list, namespaces: ns, aero: aero,
        blocks: blocks, com: com, center: center, comOffset: comOffset, comBalanced: comBalanced,
        comMass: com.mass,
        mass: total * bm + pl, blockMass: bm, payload: pl
      };
    }, function (err) {
      return { ok: false, error: 'gzip inflate failed: ' + err };
    });
  }

  var GEN_FNS = {
    balloon: genBalloon, prop: genProp, wings: genWings,
    crystal: genCrystal, shapes: genShapes
  };
  function gen(kind, params) {
    var f = GEN_FNS[kind];
    return f ? f(params) : genBalloon(params);
  }

  global.Gen = {
    genBalloon: genBalloon, genProp: genProp,
    genWings: genWings, genCrystal: genCrystal, genShapes: genShapes,
    mathFor: mathFor, propMath: propMath,
    analyzeSchematic: analyzeSchematic, nbtRead: nbtRead, inflateGz: inflateGz,
    massOf: massOf, comFor: comFor, blocksToResult: blocksToResult,
    comCheck: comCheck, overlay: overlay, balanceReport: balanceReport,
    mulberry32: mulberry32,
    gen: gen
  };
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
