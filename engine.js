/* 계절길 계산 엔진: 화면과 무관한 순수 계산만 담는다. 브라우저(window.SWEngine)와 Node(require) 양쪽에서 쓴다. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SWEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- 수종 분류
  const F = { CHERRY: 1, IPAP: 2, SPRING: 4, FEMALE: 8, GINKGO: 16, RED: 32, ZELK: 64, YELLOW: 128, EVER: 256 };
  const FOLIAGE = F.GINKGO | F.RED | F.ZELK | F.YELLOW;

  function speciesFlags(sp) {
    const s = String(sp || '').replace(/\s/g, '');
    let f = 0;
    if (/벚/.test(s)) f |= F.CHERRY | F.SPRING | F.RED;
    if (/이팝/.test(s)) f |= F.IPAP | F.SPRING;
    if (/산수유|매화|매실|살구|목련|꽃사과|산딸|층층나무|칠엽수|마로니에|때죽|조팝|자두|복사|복숭아|배나무|사과나무|박태기/.test(s)) f |= F.SPRING;
    if (/^은행나무/.test(s)) f |= /암/.test(s) ? F.FEMALE : F.GINKGO;
    if (/단풍|대왕참|산딸|복자기|화살나무|마가목|신나무|붉나무/.test(s)) f |= F.RED;
    if (/^느티/.test(s)) f |= F.ZELK;
    if (/팽나무|튜울립|튤립|백합나무|계수나무/.test(s)) f |= F.YELLOW;
    if (/소나무|반송|잣나무|향나무|측백|주목|전나무|구상나무|가문비|히말라야|개잎갈|곰솔|해송|리기다|사철|동백|광나무|아왜|먼나무|후박/.test(s)) f |= F.EVER;
    return f;
  }

  // 수관 반지름(m), 수관 중심 높이(m)
  function crownOf(sp) {
    const s = String(sp || '').replace(/\s/g, '');
    if (/느티|버즘|플라타너스|회화|칠엽수|마로니에|팽나무|백합나무|튜울립|튤립|느릅|가죽나무|버들/.test(s)) return [4.5, 7];
    if (/은행/.test(s)) return [2.5, 6];
    if (/메타세쿼이아|가문비|전나무|측백|향나무|주목|구상/.test(s)) return [2, 4.5];
    if (/산수유|매화|매실|살구|목련|꽃사과|산딸|배롱|무궁화|때죽|조팝|자두|복사|대추|박태기/.test(s)) return [2, 3];
    return [3.2, 5];
  }

  // ---------------------------------------------------------------- 디코딩
  function cum(a) { const o = new Float64Array(a.length); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; o[i] = s; } return o; }
  function cum2(a) { const o = new Float64Array(a.length); let x = 0, y = 0; for (let i = 0; i + 1 < a.length; i += 2) { x += a[i]; y += a[i + 1]; o[i] = x; o[i + 1] = y; } return o; }
  function polyArea(p) { let s = 0; for (let i = 0, n = p.length; i < n; i++) { const a = p[i], b = p[(i + 1) % n]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; }
  function estHeight(area) { const fl = area < 100 ? 2 : area < 300 ? 3 : area < 800 ? 4 : area < 2000 ? 5 : area < 5000 ? 7 : 10; return fl * 3.3; }

  // 건물 목록: 높이가 없으면(0) 바닥 면적으로 층수를 추정한다
  function makeBlds(list) {
    return list.map(b => {
      const known = b.h > 0;
      return { p: b.p, h: known ? b.h : estHeight(Math.abs(polyArea(b.p))), est: !known, part: !!b.part };
    });
  }

  function splitPolys(lens, flat) {
    const out = []; let k = 0;
    for (let i = 0; i < lens.length; i++) { const p = []; for (let j = 0; j < lens[i]; j++, k += 2) p.push([flat[k], flat[k + 1]]); out.push(p); }
    return out;
  }

  function decodeArea(raw) {
    const A = { id: raw.id, name: raw.name, lat0: raw.lat0, lon0: raw.lon0, kx: raw.kx, ky: raw.ky, box: raw.box, osm: raw.osm, names: raw.names };
    A.toXY = (lat, lon) => [(lon - raw.lon0) * raw.kx, (lat - raw.lat0) * raw.ky];
    A.toLL = (x, y) => [raw.lat0 + y / raw.ky, raw.lon0 + x / raw.kx];

    // 보행 도로망
    const X = cum(raw.nx), Y = cum(raw.ny), N = X.length;
    const wv = cum(raw.wv);
    const ea = [], eb = [], et = [], en = [], eh = [], ew = [];
    let k = 0;
    const ways = [];
    for (let w = 0; w < raw.wl.length; w++) {
      const n = raw.wl[w], idx = [];
      for (let j = 0; j < n; j++) idx.push(wv[k + j]);
      k += n;
      ways.push({ t: raw.wt[w], name: raw.wn[w], hw: raw.wh[w], idx });
      for (let j = 0; j + 1 < n; j++) {
        const a = idx[j], b = idx[j + 1];
        if (a === b) continue;
        ea.push(a); eb.push(b); et.push(raw.wt[w]); en.push(raw.wn[w]); eh.push(raw.wh[w]); ew.push(w);
      }
    }
    const E = ea.length;
    const G = { N, E, X, Y, ea: Int32Array.from(ea), eb: Int32Array.from(eb), et, en: Int32Array.from(en), eh: Float32Array.from(eh), ew: Int32Array.from(ew), len: new Float64Array(E) };
    for (let e = 0; e < E; e++) G.len[e] = Math.hypot(X[G.eb[e]] - X[G.ea[e]], Y[G.eb[e]] - Y[G.ea[e]]);
    const deg = new Int32Array(N + 1);
    for (let e = 0; e < E; e++) { deg[G.ea[e] + 1]++; deg[G.eb[e] + 1]++; }
    for (let i = 0; i < N; i++) deg[i + 1] += deg[i];
    const fill = deg.slice(0, N), adjN = new Int32Array(2 * E), adjE = new Int32Array(2 * E);
    for (let e = 0; e < E; e++) { const a = G.ea[e], b = G.eb[e]; adjN[fill[a]] = b; adjE[fill[a]++] = e; adjN[fill[b]] = a; adjE[fill[b]++] = e; }
    G.off = deg; G.adjN = adjN; G.adjE = adjE;
    // 가장 큰 연결 요소
    const comp = new Int32Array(N).fill(-1); let best = -1, bestSize = 0, cid = 0;
    const stack = new Int32Array(N);
    for (let s = 0; s < N; s++) {
      if (comp[s] >= 0 || deg[s + 1] === deg[s]) continue;
      let sp = 0, size = 0; stack[sp++] = s; comp[s] = cid;
      while (sp) { const u = stack[--sp]; size++; for (let q = deg[u]; q < deg[u + 1]; q++) { const v = adjN[q]; if (comp[v] < 0) { comp[v] = cid; stack[sp++] = v; } } }
      if (size > bestSize) { bestSize = size; best = cid; }
      cid++;
    }
    G.comp = comp; G.main = best;
    A.G = G; A.ways = ways;

    // 노드 격자(가까운 노드 찾기)
    A.nodeGrid = gridIndex(30, N, i => [X[i], Y[i], X[i], Y[i]], i => comp[i] === best);
    // 구간 격자
    A.edgeGrid = gridIndex(25, E, e => { const a = G.ea[e], b = G.eb[e]; return [Math.min(X[a], X[b]), Math.min(Y[a], Y[b]), Math.max(X[a], X[b]), Math.max(Y[a], Y[b])]; });

    // 건물
    const bv = cum2(raw.bv);
    const bpolys = splitPolys(raw.bl, bv);
    A.blds = makeBlds(bpolys.map((p, i) => ({ p, h: raw.bh[i], part: raw.bp[i] === '1' })));
    // 녹지·물
    const gpolys = splitPolys(raw.gl, cum2(raw.gv));
    A.green = gpolys.map((p, i) => ({ t: raw.gt[i], p }));
    const lpolys = splitPolys(raw.ll, cum2(raw.lv));
    A.wlines = lpolys.map((p, i) => ({ w: raw.lw[i], p }));
    A.stations = (raw.st || []).map(s => ({ name: s[0], x: s[1], y: s[2], kind: 'station' }));
    A.landmarks = (raw.lm || []).map(s => ({ name: s[0], x: s[1], y: s[2], kind: 'landmark' }));

    // 가로수(원본 값: 위도·경도·수종·노선)
    const la = cum(raw.tla), lo = cum(raw.tlo), T = la.length;
    const tr = { n: T, lat: new Float64Array(T), lon: new Float64Array(T), x: new Float64Array(T), y: new Float64Array(T), sp: Int32Array.from(raw.ts), road: Int32Array.from(raw.tr), flags: new Int32Array(T), cr: new Float32Array(T), ch: new Float32Array(T) };
    const spFlags = raw.sp.map(speciesFlags), spCrown = raw.sp.map(crownOf);
    for (let i = 0; i < T; i++) {
      const lat = la[i] / 1e9, lon = lo[i] / 1e9;
      tr.lat[i] = lat; tr.lon[i] = lon;
      tr.x[i] = (lon - raw.lon0) * raw.kx; tr.y[i] = (lat - raw.lat0) * raw.ky;
      tr.flags[i] = spFlags[tr.sp[i]];
      tr.cr[i] = spCrown[tr.sp[i]][0]; tr.ch[i] = spCrown[tr.sp[i]][1];
    }
    A.trees = tr; A.species = raw.sp; A.roads = raw.rd;
    A.treeGrid = gridIndex(20, T, i => [tr.x[i], tr.y[i], tr.x[i], tr.y[i]]);
    assignTrees(A);
    A.cache = {};
    return A;
  }

  // ---------------------------------------------------------------- 격자 색인
  function gridIndex(cell, n, bboxOf, filter) {
    const map = new Map();
    for (let i = 0; i < n; i++) {
      if (filter && !filter(i)) continue;
      const b = bboxOf(i);
      const c0 = Math.floor(b[0] / cell), c1 = Math.floor(b[2] / cell), r0 = Math.floor(b[1] / cell), r1 = Math.floor(b[3] / cell);
      for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) {
        const key = c * 100003 + r;
        let arr = map.get(key); if (!arr) { arr = []; map.set(key, arr); } arr.push(i);
      }
    }
    return { cell, map };
  }
  function gridQuery(g, x0, y0, x1, y1, cb) {
    const c0 = Math.floor(x0 / g.cell), c1 = Math.floor(x1 / g.cell), r0 = Math.floor(y0 / g.cell), r1 = Math.floor(y1 / g.cell);
    for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) { const arr = g.map.get(c * 100003 + r); if (arr) for (const i of arr) cb(i); }
  }
  function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    let u = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0; u = u < 0 ? 0 : u > 1 ? 1 : u;
    return Math.hypot(ax + u * dx - px, ay + u * dy - py);
  }

  // 나무를 구간에 붙인다: 25m 안 가장 가까운 구간 + 8m 안 모든 구간 (실험 01~04와 같은 규칙)
  function assignTrees(A) {
    const G = A.G, tr = A.trees;
    const lists = Array.from({ length: G.E }, () => null);
    for (let i = 0; i < tr.n; i++) {
      const px = tr.x[i], py = tr.y[i];
      let best = -1, bd = 25.0001; const near = new Set();
      gridQuery(A.edgeGrid, px - 25, py - 25, px + 25, py + 25, e => {
        const a = G.ea[e], b = G.eb[e];
        const d = segDist(px, py, G.X[a], G.Y[a], G.X[b], G.Y[b]);
        if (d < bd) { bd = d; best = e; }
        if (d <= 8) near.add(e);
      });
      if (best >= 0) near.add(best);
      for (const e of near) { (lists[e] || (lists[e] = [])).push(i); }
    }
    A.edgeTrees = lists;
  }

  function edgeCount(A, flag) {
    const key = 'cnt' + flag;
    if (A.cache[key]) return A.cache[key];
    const out = new Float64Array(A.G.E), fl = A.trees.flags;
    for (let e = 0; e < A.G.E; e++) { const l = A.edgeTrees[e]; if (!l) continue; let c = 0; for (const i of l) if (fl[i] & flag) c++; out[e] = c; }
    return (A.cache[key] = out);
  }

  // ---------------------------------------------------------------- 경로
  function nearestNode(A, x, y) {
    const G = A.G; let best = -1, bd = Infinity;
    for (let r = 30; r <= 960 && best < 0; r *= 2) {
      gridQuery(A.nodeGrid, x - r, y - r, x + r, y + r, i => { const d = Math.hypot(G.X[i] - x, G.Y[i] - y); if (d < bd) { bd = d; best = i; } });
    }
    return best;
  }

  function dijkstra(A, src, dst, cost) {
    const G = A.G, N = G.N;
    const dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1);
    let hc = new Float64Array(1024), hn = new Int32Array(1024), size = 0;
    const push = (c, n) => {
      if (size === hc.length) { const c2 = new Float64Array(size * 2); c2.set(hc); hc = c2; const n2 = new Int32Array(size * 2); n2.set(hn); hn = n2; }
      let i = size++;
      while (i > 0) { const p = (i - 1) >> 1; if (hc[p] <= c) break; hc[i] = hc[p]; hn[i] = hn[p]; i = p; }
      hc[i] = c; hn[i] = n;
    };
    const pop = () => {
      const c = hc[0], n = hn[0]; size--;
      if (size > 0) {
        const lc = hc[size], ln = hn[size]; let i = 0;
        for (;;) { let l = 2 * i + 1; if (l >= size) break; if (l + 1 < size && hc[l + 1] < hc[l]) l++; if (hc[l] >= lc) break; hc[i] = hc[l]; hn[i] = hn[l]; i = l; }
        hc[i] = lc; hn[i] = ln;
      }
      popC = c; return n;
    };
    let popC = 0;
    dist[src] = 0; push(0, src);
    while (size) {
      const u = pop(), d = popC;
      if (d > dist[u]) continue;
      if (u === dst) break;
      for (let q = G.off[u]; q < G.off[u + 1]; q++) {
        const v = G.adjN[q], e = G.adjE[q], nd = d + cost[e];
        if (nd < dist[v]) { dist[v] = nd; prev[v] = e; push(nd, v); }
      }
    }
    if (src !== dst && prev[dst] < 0) return null;
    const edges = [], nodes = [dst]; let u = dst;
    while (u !== src) { const e = prev[u]; edges.push(e); u = G.ea[e] === u ? G.eb[e] : G.ea[e]; nodes.push(u); }
    edges.reverse(); nodes.reverse();
    let len = 0; for (const e of edges) len += G.len[e];
    return { nodes, edges, len, key: edges.join(',') };
  }

  function routeCoords(A, r) { return r.nodes.map(n => [A.G.X[n], A.G.Y[n]]); }

  // 경로 선에서 R m 안 나무
  function treesNear(A, r, R) {
    R = R || 15;
    const G = A.G, tr = A.trees, hit = new Set();
    for (const e of r.edges) {
      const a = G.ea[e], b = G.eb[e], ax = G.X[a], ay = G.Y[a], bx = G.X[b], by = G.Y[b];
      gridQuery(A.treeGrid, Math.min(ax, bx) - R, Math.min(ay, by) - R, Math.max(ax, bx) + R, Math.max(ay, by) + R, i => {
        if (hit.has(i)) return;
        if (segDist(tr.x[i], tr.y[i], ax, ay, bx, by) <= R) hit.add(i);
      });
    }
    return [...hit];
  }

  function viaNames(A, r) {
    const G = A.G, runs = [];
    for (const e of r.edges) {
      const n = G.en[e];
      const last = runs[runs.length - 1];
      if (last && last.n === n) last.len += G.len[e]; else runs.push({ n, len: G.len[e] });
    }
    const out = [];
    for (const run of runs) {
      if (run.n < 0 || run.len < 50) continue;
      const nm = A.names[run.n];
      if (out.length && out[out.length - 1] === nm) continue;
      out.push(nm);
    }
    // 너무 길면 긴 구간 위주로 4개
    if (out.length <= 4) return out;
    const totals = new Map(); for (const run of runs) if (run.n >= 0) totals.set(A.names[run.n], (totals.get(A.names[run.n]) || 0) + run.len);
    const keep = new Set([...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(x => x[0]));
    return out.filter(nm => keep.has(nm));
  }

  // ---------------------------------------------------------------- 해 위치
  function sunPos(ms, lat, lon) {
    const rad = Math.PI / 180;
    const d = (ms - 946728000000) / 86400000;
    const g = (357.529 + 0.98560028 * d) * rad;
    const q = 280.459 + 0.98564736 * d;
    const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
    const e = (23.439 - 0.00000036 * d) * rad;
    const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
    const dec = Math.asin(Math.sin(e) * Math.sin(L));
    const gmst = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
    const H = (gmst * 15 + lon) * rad - ra;
    const la = lat * rad;
    const alt = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(H));
    const az = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(H));
    return { alt: alt / rad, az: ((az / rad) + 360) % 360 };
  }
  // 한국 시각(KST) → UTC ms
  function kst(y, mo, d, h, mi) { return Date.UTC(y, mo - 1, d, h - 9, mi || 0); }

  // ---------------------------------------------------------------- 그림자
  function hull(points) {
    const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    lo.pop(); up.pop();
    return lo.concat(up);
  }

  // 해 위치에서 그림자 다각형 목록(볼록 다각형)
  function shadowPolys(A, sun, opts) {
    opts = opts || {};
    const polys = [];
    if (sun.alt <= 0.5) return { night: true, polys };
    const rad = Math.PI / 180, tanA = Math.tan(sun.alt * rad), sinA = Math.sin(sun.alt * rad);
    const ux = -Math.sin(sun.az * rad), uy = -Math.cos(sun.az * rad);
    for (const b of A.blds) {
      const L = Math.min(500, b.h / tanA), dx = ux * L, dy = uy * L;
      polys.push(hull(b.p.concat(b.p.map(q => [q[0] + dx, q[1] + dy]))));
    }
    const tr = A.trees;
    for (let i = 0; i < tr.n; i++) {
      if (opts.evergreenOnly && !(tr.flags[i] & F.EVER)) continue;
      const r = tr.cr[i], off = tr.ch[i] / tanA, a = Math.min(40, r / sinA);
      const cx = tr.x[i] + ux * off, cy = tr.y[i] + uy * off;
      const p = [];
      for (let k = 0; k < 10; k++) { const t = k / 10 * 2 * Math.PI, ca = Math.cos(t) * a, cb = Math.sin(t) * r; p.push([cx + ux * ca - uy * cb, cy + uy * ca + ux * cb]); }
      polys.push(p);
    }
    return { night: false, polys };
  }

  function makeRaster(A, cell, reuse) {
    const pad = 60, b = A.box;
    const x0 = b[0] - pad, y0 = b[1] - pad;
    const W = Math.ceil((b[2] - b[0] + 2 * pad) / cell), H = Math.ceil((b[3] - b[1] + 2 * pad) / cell);
    let data;
    if (reuse && reuse.length === W * H) { data = reuse; data.fill(0); } else data = new Uint8Array(W * H);
    return { x0, y0, cell, W, H, data };
  }
  function fillConvex(R, pts, val) {
    let ymin = Infinity, ymax = -Infinity;
    for (const p of pts) { if (p[1] < ymin) ymin = p[1]; if (p[1] > ymax) ymax = p[1]; }
    const c = R.cell;
    const r0 = Math.max(0, Math.ceil((ymin - R.y0) / c - 0.5)), r1 = Math.min(R.H - 1, Math.floor((ymax - R.y0) / c - 0.5));
    const n = pts.length;
    for (let r = r0; r <= r1; r++) {
      const yc = R.y0 + (r + 0.5) * c;
      let xl = Infinity, xr = -Infinity;
      for (let i = 0; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        if ((a[1] <= yc && b[1] >= yc) || (b[1] <= yc && a[1] >= yc)) {
          if (a[1] === b[1]) { xl = Math.min(xl, a[0], b[0]); xr = Math.max(xr, a[0], b[0]); }
          else { const x = a[0] + (yc - a[1]) * (b[0] - a[0]) / (b[1] - a[1]); if (x < xl) xl = x; if (x > xr) xr = x; }
        }
      }
      if (xl > xr) continue;
      const c0 = Math.max(0, Math.ceil((xl - R.x0) / c - 0.5)), c1 = Math.min(R.W - 1, Math.floor((xr - R.x0) / c - 0.5));
      const row = r * R.W;
      for (let cc = c0; cc <= c1; cc++) R.data[row + cc] = val;
    }
  }
  function rasterAt(R, x, y) {
    const c = Math.floor((x - R.x0) / R.cell), r = Math.floor((y - R.y0) / R.cell);
    if (c < 0 || r < 0 || c >= R.W || r >= R.H) return 255;
    return R.data[r * R.W + c];
  }

  // 구간 표본점: 차도는 양쪽 보도, 보행로는 가운데. 다른 차도 위에 떨어지는 점은 뺀다.
  const CELL = 1.5;
  function samples(A) {
    if (A.cache.samples) return A.cache.samples;
    const G = A.G;
    const mask = makeRaster(A, A.cell || CELL);
    for (let e = 0; e < G.E; e++) {
      const t = G.et[e]; if (t !== 'M' && t !== 'm') continue;
      const a = G.ea[e], b = G.eb[e], ax = G.X[a], ay = G.Y[a], bx = G.X[b], by = G.Y[b], L = G.len[e];
      if (L < 0.01) continue;
      const h = G.eh[e], nx = -(by - ay) / L * h, ny = (bx - ax) / L * h;
      fillConvex(mask, [[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]], 1);
    }
    const PX = [], PY = [], OK = [];
    const start = new Int32Array(G.E), cnt = new Int32Array(G.E), sides = new Uint8Array(G.E);
    for (let e = 0; e < G.E; e++) {
      const t = G.et[e], a = G.ea[e], b = G.eb[e], ax = G.X[a], ay = G.Y[a], bx = G.X[b], by = G.Y[b], L = G.len[e];
      const n = Math.max(1, Math.round(L / 3));
      start[e] = PX.length; cnt[e] = n;
      const road = (t === 'M' || t === 'm') && L > 0.01;
      sides[e] = road ? 3 : 1;
      const off = road ? G.eh[e] + 2.5 : 0;
      const nx = road ? -(by - ay) / L : 0, ny = road ? (bx - ax) / L : 0;
      const lines = road ? [1, -1, 0] : [0];
      for (const s of lines) {
        for (let k = 0; k < n; k++) {
          const u = (k + 0.5) / n, x = ax + (bx - ax) * u + nx * off * s, y = ay + (by - ay) * u + ny * off * s;
          PX.push(x); PY.push(y);
          OK.push(s === 0 ? 1 : (rasterAt(mask, x, y) === 0 ? 1 : 0));
        }
      }
    }
    return (A.cache.samples = { PX: Float64Array.from(PX), PY: Float64Array.from(PY), OK: Uint8Array.from(OK), start, cnt, sides });
  }

  function shadowRaster(A, sun, opts, reuse) {
    const R = makeRaster(A, A.cell || CELL, reuse);
    const sp = shadowPolys(A, sun, opts);
    if (sp.night) { R.data.fill(1); R.night = true; return R; }
    for (const p of sp.polys) fillConvex(R, p, 1);
    return R;
  }

  // 여름: 구간별 그늘 비율(그늘진 쪽 보도를 걷는다고 봄)
  function edgeShade(A, R) {
    const S = samples(A), G = A.G, out = new Float64Array(G.E);
    const inShade = new Uint8Array(S.PX.length);
    for (let i = 0; i < S.PX.length; i++) inShade[i] = rasterAt(R, S.PX[i], S.PY[i]) === 1 ? 1 : 0;
    for (let e = 0; e < G.E; e++) {
      const n = S.cnt[e], st = S.start[e];
      let best = -1;
      const nLines = S.sides[e] === 3 ? 2 : 1;
      for (let s = 0; s < nLines; s++) {
        let ok = 0, sh = 0;
        for (let k = 0; k < n; k++) { const i = st + s * n + k; if (!S.OK[i]) continue; ok++; sh += inShade[i]; }
        if (ok >= Math.max(1, 0.4 * n)) best = Math.max(best, sh / ok);
      }
      if (best < 0) { // 양쪽 다 쓸 수 없으면 가운데 선
        const base = st + (S.sides[e] === 3 ? 2 * n : 0); let sh = 0;
        for (let k = 0; k < n; k++) sh += inShade[base + k];
        best = sh / n;
      }
      out[e] = best;
    }
    return out;
  }

  // 겨울: 9~16시 정시 8번 그림자로 하루 일조(시간)와 응달(일조 2시간 미만) 비율
  function edgeSun(A, sunCnt) {
    const S = samples(A), G = A.G;
    const sunH = new Float64Array(G.E), ice = new Float64Array(G.E);
    for (let e = 0; e < G.E; e++) {
      const n = S.cnt[e], st = S.start[e];
      let bestH = -1, bestIce = 1;
      const nLines = S.sides[e] === 3 ? 2 : 1;
      for (let s = 0; s < nLines; s++) {
        let ok = 0, h = 0, ic = 0;
        for (let k = 0; k < n; k++) { const i = st + s * n + k; if (!S.OK[i]) continue; ok++; h += sunCnt[i]; if (sunCnt[i] < 2) ic++; }
        if (ok >= Math.max(1, 0.4 * n)) { const mh = h / ok; if (mh > bestH) { bestH = mh; bestIce = ic / ok; } }
      }
      if (bestH < 0) {
        const base = st + (S.sides[e] === 3 ? 2 * n : 0); let h = 0, ic = 0;
        for (let k = 0; k < n; k++) { h += sunCnt[base + k]; if (sunCnt[base + k] < 2) ic++; }
        bestH = h / n; bestIce = ic / n;
      }
      sunH[e] = bestH; ice[e] = bestIce;
    }
    return { sunH, ice };
  }

  // ---------------------------------------------------------------- 모드
  const MODES = {
    'spring-cherry': { season: 'spring', kind: 'trees', flag: F.CHERRY, cap: 0.30, label: '벚꽃길', what: '벚나무' },
    'spring-ipap': { season: 'spring', kind: 'trees', flag: F.IPAP, cap: 0.25, label: '이팝꽃길', what: '이팝나무' },
    'spring-all': { season: 'spring', kind: 'trees', flag: F.SPRING, cap: 0.25, label: '봄꽃길', what: '봄꽃 나무' },
    'summer-shade': { season: 'summer', kind: 'shade', cap: 0.25, label: '그늘길', what: '그늘' },
    'autumn-foliage': { season: 'autumn', kind: 'trees', flag: FOLIAGE, avoid: F.FEMALE, avoidPenalty: 60, cap: 0.25, label: '단풍길', what: '단풍 드는 나무' },
    'autumn-ginkgo': { season: 'autumn', kind: 'avoid', flag: F.FEMALE, cap: 0.35, label: '은행 냄새 피하기', what: '은행 암나무' },
    'winter-sun': { season: 'winter', kind: 'sun', cap: 0.25, label: '볕길', what: '응달' }
  };
  const SWEEP = [0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 9];
  const KS = [0.5, 1, 2, 3, 4, 6, 8, 12, 16, 24, 40, 64];
  const PS = [1, 2, 3, 5, 8, 12, 20, 30, 50, 80, 150, 300];

  // 모드별 그림자 계산을 준비(캐시)
  const SUMMER = { y: 2026, m: 7, d: 20 }, WINTER = { y: 2027, m: 1, d: 15 };
  function summerShade(A, hour) {
    const key = 'shade' + hour;
    if (A.cache[key]) return A.cache[key];
    const h = Math.floor(hour), mi = Math.round((hour - h) * 60);
    const [lat, lon] = A.toLL(0, 0);
    const sun = sunPos(kst(SUMMER.y, SUMMER.m, SUMMER.d, h, mi), lat, lon);
    const R = shadowRaster(A, sun, {});
    const res = { sun, shade: edgeShade(A, R) };
    return (A.cache[key] = res);
  }
  function winterSun(A) {
    if (A.cache.winter) return A.cache.winter;
    const [lat, lon] = A.toLL(0, 0);
    const S = samples(A), sunCnt = new Uint8Array(S.PX.length);
    // 시각마다 격자 하나를 다시 써서 메모리를 아낀다(결과는 8장을 한꺼번에 만든 것과 같다)
    let buf = null;
    for (let h = 9; h <= 16; h++) {
      const R = shadowRaster(A, sunPos(kst(WINTER.y, WINTER.m, WINTER.d, h, 0), lat, lon), { evergreenOnly: true }, buf);
      buf = R.night ? buf : R.data;
      for (let i = 0; i < S.PX.length; i++) if (rasterAt(R, S.PX[i], S.PY[i]) !== 1) sunCnt[i]++;
    }
    return (A.cache.winter = edgeSun(A, sunCnt));
  }

  function metricOf(A, mode, r, ctx) {
    const M = MODES[mode], G = A.G;
    if (M.kind === 'trees' || M.kind === 'avoid') {
      const near = treesNear(A, r, 15), fl = A.trees.flags;
      let v = 0, bad = 0;
      for (const i of near) { if (fl[i] & M.flag) v++; if (M.avoid && (fl[i] & M.avoid)) bad++; }
      return { v, bad, near };
    }
    if (M.kind === 'shade') {
      let s = 0; for (const e of r.edges) s += G.len[e] * ctx.shade[e];
      return { v: r.len ? s / r.len : 0 };
    }
    if (M.kind === 'sun') {
      let s = 0, ic = 0; for (const e of r.edges) { s += G.len[e] * ctx.sunH[e]; ic += G.len[e] * ctx.ice[e]; }
      return { v: r.len ? ic / r.len : 0, sunH: r.len ? s / r.len : 0 };
    }
  }
  // 후보 비교용 점수(클수록 좋음)
  function score(mode, m) {
    const M = MODES[mode];
    if (M.kind === 'trees') return m.v - (M.avoid ? 3 * (m.bad || 0) : 0);
    if (M.kind === 'avoid') return -m.v;
    if (M.kind === 'shade') return m.v;
    if (M.kind === 'sun') return -m.v + 0.02 * (m.sunH || 0);
    return 0;
  }
  function better(mode, a, b) {
    const sa = score(mode, a.m), sb = score(mode, b.m);
    return sa > sb + 1e-9 || (Math.abs(sa - sb) <= 1e-9 && a.len < b.len - 1e-9);
  }

  function plan(A, src, dst, mode, opts) {
    opts = opts || {};
    const M = MODES[mode], G = A.G;
    const ctx = {};
    if (M.kind === 'shade') ctx.shade = summerShade(A, opts.hour == null ? 18.5 : opts.hour).shade;
    if (M.kind === 'sun') Object.assign(ctx, winterSun(A));
    const base = dijkstra(A, src, dst, G.len);
    if (!base) return null;
    base.m = metricOf(A, mode, base, ctx);
    const cost = new Float64Array(G.E), seen = new Map([[base.key, base]]);
    const runs = [];
    if (M.kind === 'trees') {
      const cnt = edgeCount(A, M.flag), bad = M.avoid ? edgeCount(A, M.avoid) : null;
      for (const fl of [0.35, 0.15]) for (const K of KS) runs.push(e => G.len[e] * Math.max(fl, 1 - K * cnt[e] / Math.max(G.len[e], 1)) + (bad ? M.avoidPenalty * bad[e] : 0));
    } else if (M.kind === 'avoid') {
      const cnt = edgeCount(A, M.flag);
      for (const P of PS) runs.push(e => G.len[e] + P * cnt[e]);
    } else if (M.kind === 'shade') {
      for (const w of SWEEP) runs.push(e => G.len[e] * (1 + w * (1 - ctx.shade[e])));
    } else if (M.kind === 'sun') {
      for (const w of SWEEP) runs.push(e => G.len[e] * (1 + w * (ctx.ice[e] + 0.3 * (1 - ctx.sunH[e] / 8))));
    }
    for (const f of runs) {
      for (let e = 0; e < G.E; e++) cost[e] = f(e);
      const r = dijkstra(A, src, dst, cost);
      if (!r || seen.has(r.key)) continue;
      r.m = metricOf(A, mode, r, ctx);
      seen.set(r.key, r);
    }
    const cands = [...seen.values()].sort((a, b) => a.len - b.len);
    // 더 짧은데 효과도 같거나 나은 후보가 있으면 뺀다(파레토)
    const front = cands.filter(c => { const sc = score(mode, c.m); return !cands.some(o => { if (o === c) return false; const so = score(mode, o.m); return o.len <= c.len + 1e-9 && so >= sc - 1e-9 && (o.len < c.len - 1e-9 || so > sc + 1e-9); }); });
    const cap = opts.cap == null ? M.cap : opts.cap;
    // 한도 안에서 가장 효과가 큰 경로를 찾고, 그 효과의 90% 이상을 내는 경로 중 가장 짧은 것을 고른다
    const inCap = front.filter(c => c.len <= base.len * (1 + cap) + 1e-9);
    let best = base;
    for (const c of inCap) if (better(mode, c, best)) best = c;
    const s0 = score(mode, base.m), target = s0 + 0.9 * (score(mode, best.m) - s0);
    let pick = best;
    for (const c of inCap) if (score(mode, c.m) >= target - 1e-9 && c.len < pick.len) pick = c;
    return { mode, base, pick, best, cands: front, cap, ctx, verdict: verdict(mode, base, pick) };
  }

  function verdict(mode, base, pick) {
    const k = MODES[mode].kind, b = base.m, p = pick.m;
    if (pick === base) return { worth: false };
    if (k === 'trees') return { worth: p.v - b.v >= 10 || (b.v === 0 && p.v >= 5) };
    if (k === 'avoid') return { worth: b.v - p.v >= 10 || (b.v > 0 && (b.v - p.v) / b.v >= 0.5 && b.v - p.v >= 5) };
    if (k === 'shade') return { worth: p.v - b.v >= 0.10 };
    if (k === 'sun') return { worth: b.v - p.v >= 0.10 || p.sunH - b.sunH >= 0.5 };
    return { worth: false };
  }

  return { F, FOLIAGE, MODES, score, speciesFlags, crownOf, decodeArea, makeBlds, nearestNode, dijkstra, routeCoords, treesNear, viaNames, sunPos, kst, shadowPolys, plan, summerShade, winterSun, edgeCount, SUMMER, WINTER };
});
