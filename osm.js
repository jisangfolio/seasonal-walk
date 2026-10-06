/* 계절길 · 서울 어디서나
   OpenStreetMap(Overpass)에서 받은 길·건물과 서울시 가로수 격자 파일을 계산 엔진의 지역 데이터로 바꾼다.
   브라우저(window.SWOsm)와 Node(require) 양쪽에서 쓴다. 화면과는 무관하다. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SWOsm = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 주 서버(overpass-api.de)를 먼저 쓰고, 막히거나 늦으면 나머지에 묻는다
  const ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass.private.coffee/api/interpreter'
  ];
  const STATUS = 'https://overpass-api.de/api/status';
  const HW_RE = '^(primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|residential|unclassified|living_street|service|footway|pedestrian|path|cycleway|track|steps)$';

  // 위도에 따른 1도당 미터(실험 01~04, 미리 받은 지역과 같은 식)
  function kOf(lat) {
    const p = lat * Math.PI / 180;
    return {
      kx: 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p),
      ky: 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p)
    };
  }
  function distM(a, b) {
    const k = kOf((a.lat + b.lat) / 2);
    return Math.hypot((a.lon - b.lon) * k.kx, (a.lat - b.lat) * k.ky);
  }

  // ---------------------------------------------------------------- 받을 범위
  // 출발→도착 방향으로 놓인 직사각형. 옆으로 0.5d+150m, 앞뒤로 0.25d+150m를 더 받는다.
  // 경로가 최단보다 50% 안팎 길어져도 대부분 이 안에 들어간다.
  // need=true면 이미 받은 범위를 다시 써도 되는지 볼 때 쓰는 작은 띠(옆 0.36d+80m, 앞뒤 0.15d+80m)
  function corridor(a, b, extra, need) {
    extra = extra || 0;
    const lat0 = (a.lat + b.lat) / 2, lon0 = (a.lon + b.lon) / 2, k = kOf(lat0);
    const ax = (a.lon - lon0) * k.kx, ay = (a.lat - lat0) * k.ky, bx = (b.lon - lon0) * k.kx, by = (b.lat - lat0) * k.ky;
    const d = Math.hypot(bx - ax, by - ay);
    const ux = d > 1e-6 ? (bx - ax) / d : 1, uy = d > 1e-6 ? (by - ay) / d : 0, vx = -uy, vy = ux;
    const e = (need ? Math.max(150, 0.15 * d + 80) : Math.max(250, 0.25 * d + 150)) + extra;
    const w = (need ? Math.max(200, 0.36 * d + 80) : Math.max(300, 0.5 * d + 150)) + extra;
    const xy = [[-e, -w], [d + e, -w], [d + e, w], [-e, w]].map(([u, v]) => [ax + ux * u + vx * v, ay + uy * u + vy * v]);
    const ll = xy.map(([x, y]) => [lat0 + y / k.ky, lon0 + x / k.kx]);
    return { d, ll, lat0, lon0 };
  }
  function bboxOf(ll, padM) {
    let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
    for (const p of ll) { s = Math.min(s, p[0]); n = Math.max(n, p[0]); w = Math.min(w, p[1]); e = Math.max(e, p[1]); }
    const k = kOf((s + n) / 2), pl = (padM || 0) / k.ky, po = (padM || 0) / k.kx;
    return [s - pl, w - po, n + pl, e + po];
  }
  // 점이 다각형 안에 있는지(위도·경도 평면 근사)
  function inPoly(lat, lon, ll) {
    let inside = false;
    for (let i = 0, j = ll.length - 1; i < ll.length; j = i++) {
      const yi = ll[i][0], xi = ll[i][1], yj = ll[j][0], xj = ll[j][1];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  // inner의 꼭짓점이 모두 outer 안에 있는지(경계에 걸친 점은 안쪽으로 tol m 당겨서 본다)
  function covers(outer, inner, tol) {
    tol = tol == null ? 10 : tol;
    let cl = 0, co = 0; for (const p of inner) { cl += p[0]; co += p[1]; }
    cl /= inner.length; co /= inner.length;
    const k = kOf(cl);
    return inner.every(p => {
      const dy = (p[0] - cl) * k.ky, dx = (p[1] - co) * k.kx, L = Math.hypot(dx, dy);
      const f = L > tol ? (L - tol) / L : 0;
      return inPoly(cl + dy * f / k.ky, co + dx * f / k.kx, outer);
    });
  }

  // ---------------------------------------------------------------- Overpass
  const polyStr = (ll) => ll.map(p => p[0].toFixed(6) + ' ' + p[1].toFixed(6)).join(' ');
  function qWays(ll) {
    return '[out:json][timeout:90];way["highway"~"' + HW_RE + '"](poly:"' + polyStr(ll) + '");out body geom qt;';
  }
  function qBlds(ll) {
    const P = '(poly:"' + polyStr(ll) + '")';
    return '[out:json][timeout:120];(way["building"]' + P + ';way["building:part"]' + P + ';);out tags geom qt;relation["building"]' + P + ';out body geom qt;';
  }
  // 길과 건물을 한 번에(여름·겨울 모드에서 처음 받을 때). 응답은 splitBoth로 나눈다.
  function qBoth(llWays, llBlds) {
    const P = '(poly:"' + polyStr(llBlds) + '")';
    return '[out:json][timeout:150];way["highway"~"' + HW_RE + '"](poly:"' + polyStr(llWays) + '");out body geom qt;' +
      '(way["building"]' + P + ';way["building:part"]' + P + ';);out tags geom qt;relation["building"]' + P + ';out body geom qt;';
  }
  function splitBoth(json) {
    const hw = [], bld = [];
    for (const el of (json && json.elements) || []) {
      if (el.type === 'way' && el.nodes && el.tags && el.tags.highway) hw.push(el); else bld.push(el);
    }
    return { hw: { osm3s: json.osm3s, elements: hw }, bld: { elements: bld } };
  }
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  function abortError() { const e = new Error('취소됐어요'); e.name = 'AbortError'; return e; }

  // 주 서버는 IP마다 동시에 2개까지만 받아서, 바로 앞 질의가 끝난 직후에는 429로 거절할 때가 있다.
  // 먼저 빈자리를 보고, 곧 나면 잠깐 기다리고, 오래 걸리면 다른 서버부터 묻는다.
  async function slotWait() {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 3000);
    try {
      const txt = await (await fetch(STATUS, { signal: ctl.signal })).text();
      const m = /(\d+) slots? available now/.exec(txt);
      if (m && +m[1] > 0) return 0;
      const secs = [...txt.matchAll(/in (\d+) seconds?/g)].map(x => +x[1]);
      return secs.length ? Math.min(...secs) : 0;
    } catch (e) { return 0; } finally { clearTimeout(t); }
  }

  // 서버에 묻는다. 한 서버가 hedge(ms) 안에 답이 없으면 다음 서버에도 같이 묻고, 먼저 온 답을 쓴다.
  // 실패하면 바로 다음 서버로 넘어간다. onRetry(횟수, 이유), onWait(초)로 진행 상황을 알린다.
  async function overpass(q, o) {
    o = o || {};
    let order = (o.endpoints || ENDPOINTS).slice();
    if (!o.endpoints) {
      const w = await slotWait();
      if (o.signal && o.signal.aborted) throw abortError();
      if (w > 0 && w <= 12) { if (o.onWait) o.onWait(w); await sleep(w * 1000 + 300); }
      else if (w > 12) order = order.slice(1).concat(order[0]);
    }
    const maxTries = o.tries || order.length + 1, hedge = o.hedge || 15000, perTry = o.timeout || 60000;
    return new Promise((resolve, reject) => {
      let started = 0, running = 0, done = false, last = '', hedgeTimer = null;
      const ctls = [];
      const finish = (err, val) => {
        if (done) return;
        done = true; clearTimeout(hedgeTimer);
        for (const c of ctls) c.abort();
        if (o.signal) o.signal.removeEventListener('abort', onAbort);
        if (err) reject(err); else resolve(val);
      };
      const onAbort = () => finish(abortError());
      if (o.signal) { if (o.signal.aborted) { finish(abortError()); return; } o.signal.addEventListener('abort', onAbort); }
      const launch = () => {
        if (done || started >= maxTries) return;
        const url = order[started % order.length];
        started++; running++;
        const ctl = new AbortController(); ctls.push(ctl);
        const timer = setTimeout(() => ctl.abort(), perTry);
        clearTimeout(hedgeTimer); hedgeTimer = setTimeout(() => { if (done || started >= maxTries) return; if (o.onRetry) o.onRetry(started, '응답이 늦음'); launch(); }, hedge);
        (async () => {
          let failed = false;
          try {
            const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, signal: ctl.signal });
            const t = await r.text();
            if (r.ok && /^\s*\{/.test(t)) {
              const j = JSON.parse(t);
              if (j.remark && /error|timeout|runtime|memory/i.test(j.remark)) { failed = true; last = '서버 시간 초과'; } else finish(null, j);
            } else { failed = true; last = r.status === 429 ? '요청이 많음(429)' : r.status === 504 ? '서버 시간 초과(504)' : 'HTTP ' + r.status; }
          } catch (e) {
            failed = true; last = e.name === 'AbortError' ? '응답 없음' : '연결 실패';
          } finally { clearTimeout(timer); running--; }
          if (done || !failed) return;
          if (o.onRetry) o.onRetry(started, last);
          if (started < maxTries) { clearTimeout(hedgeTimer); setTimeout(launch, 600); }
          else if (running === 0) { const err = new Error(last || 'Overpass 오류'); err.name = 'OverpassError'; finish(err); }
        })();
      };
      launch();
    });
  }

  // ---------------------------------------------------------------- 길
  const num = (s) => { const v = parseFloat(String(s == null ? '' : s).replace(',', '.')); return isFinite(v) ? v : NaN; };
  const T_M = /^(primary|primary_link|secondary|secondary_link|trunk|trunk_link)$/;
  const T_m = /^(tertiary|tertiary_link|residential|unclassified|living_street|service)$/;
  const T_f = /^(footway|pedestrian|path|cycleway|track)$/;
  function wayType(t) {
    const h = t.highway || '';
    if (T_M.test(h)) return 'M';
    if (T_m.test(h)) return 'm';
    if (h === 'steps') return 's';
    if (T_f.test(h)) return (t.footway === 'crossing' || t.cycleway === 'crossing' || t.path === 'crossing') ? 'c' : 'f';
    return null;
  }
  // 걸을 수 있는 길만: 지하·실내·통행 금지·자동차 전용은 뺀다(미리 받은 지역과 같은 규칙 + 자동차 전용도로)
  function walkable(t) {
    if (t.tunnel && t.tunnel !== 'no') return false;
    if (t.indoor && t.indoor !== 'no') return false;
    if (num(t.level) < 0 || num(t.layer) < 0) return false;
    if (t.motorroad === 'yes') return false;
    const foot = t.foot || '';
    if (foot === 'no') return false;
    if (/^(private|no)$/.test(t.access || '') && !/^(yes|designated|permissive)$/.test(foot)) return false;
    return true;
  }
  // 차도 반폭(m): 폭 → 차로 수 × 3.2 → 도로 등급 기본값
  function halfWidth(t, ty) {
    if (ty !== 'M' && ty !== 'm') return 0;
    const clamp = (v) => Math.max(2, Math.min(25, Math.round(v)));
    const w = num(t.width); if (w > 0) return clamp(w / 2);
    const ln = num(t.lanes); if (ln > 0) return clamp(ln * 3.2 / 2);
    const h = t.highway || '';
    if (/^(primary|trunk)/.test(h)) return 8;
    if (/^secondary/.test(h)) return 6;
    if (/^tertiary/.test(h)) return 4;
    return 3;
  }

  // ---------------------------------------------------------------- 건물
  function bldHeight(t) {
    let h = num(t.height);
    if (!(h > 0)) {
      const lv = num(t['building:levels']);
      if (lv > 0) {
        h = lv * 3.3;
        const rh = num(t['roof:height']), rl = num(t['roof:levels']);
        if (rh > 0) h += rh; else if (rl > 0) h += rl * 3.3;
      }
    }
    return h > 0 ? Math.min(h, 560) : 0;
  }
  function dp(pts, tol) {
    if (pts.length < 3) return pts.slice();
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const st = [[0, pts.length - 1]];
    while (st.length) {
      const [i, j] = st.pop(), a = pts[i], b = pts[j], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
      let md = -1, mi = -1;
      for (let k = i + 1; k < j; k++) {
        const p = pts[k];
        const d = L < 1e-9 ? Math.hypot(p[0] - a[0], p[1] - a[1]) : Math.abs(dx * (a[1] - p[1]) - dy * (a[0] - p[0])) / L;
        if (d > md) { md = d; mi = k; }
      }
      if (md > tol) { keep[mi] = 1; st.push([i, mi], [mi, j]); }
    }
    return pts.filter((_, k) => keep[k]);
  }
  function ringArea(p) { let s = 0; for (let i = 0, n = p.length; i < n; i++) { const a = p[i], b = p[(i + 1) % n]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; }
  // 다중다각형 관계의 바깥 고리를 끝점끼리 이어 붙인다
  function joinRings(segs) {
    const key = (g) => g.lat.toFixed(7) + ',' + g.lon.toFixed(7);
    const open = segs.filter(s => s && s.length > 1).map(s => s.filter(Boolean));
    const rings = [];
    while (open.length) {
      let cur = open.pop(), guard = 0;
      while (key(cur[0]) !== key(cur[cur.length - 1]) && guard++ < 5000) {
        const endK = key(cur[cur.length - 1]);
        let found = -1, rev = false;
        for (let i = 0; i < open.length; i++) {
          if (key(open[i][0]) === endK) { found = i; break; }
          if (key(open[i][open[i].length - 1]) === endK) { found = i; rev = true; break; }
        }
        if (found < 0) break;
        let nx = open.splice(found, 1)[0]; if (rev) nx = nx.slice().reverse();
        cur = cur.concat(nx.slice(1));
      }
      if (cur.length >= 4) rings.push(cur);
    }
    return rings;
  }
  // Overpass 건물 응답 → [{p:[[x,y]...], h(0이면 추정), part}]
  function bldPolys(json, toXY) {
    const out = [];
    for (const el of (json && json.elements) || []) {
      const t = el.tags || {};
      if (t.building === 'no' && !t['building:part']) continue;
      if (t.location === 'underground' || t.building === 'underground') continue;
      let rings = [];
      if (el.type === 'way' && el.geometry) rings = [el.geometry];
      else if (el.type === 'relation' && el.members) rings = joinRings(el.members.filter(m => m.type === 'way' && m.role !== 'inner' && m.geometry).map(m => m.geometry));
      const h = bldHeight(t), part = !t.building && !!t['building:part'];
      for (const g of rings) {
        let p = g.filter(Boolean).map(q => toXY(q.lat, q.lon));
        if (p.length > 1 && p[0][0] === p[p.length - 1][0] && p[0][1] === p[p.length - 1][1]) p.pop();
        if (p.length < 3) continue;
        p = dp(p.concat([p[0]]), 1.0); p.pop();
        if (p.length < 3 || Math.abs(ringArea(p)) < 30) continue;
        out.push({ p: p.map(q => [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10]), h, part });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- 가로수 격자
  // grid: {lat0, dlat, lon0, dlon, rows, cols}, bb: [남, 서, 북, 동]
  function cellKeys(grid, bb) {
    const keys = [];
    const r0 = Math.max(0, Math.floor((bb[0] - grid.lat0) / grid.dlat)), r1 = Math.min(grid.rows - 1, Math.floor((bb[2] - grid.lat0) / grid.dlat));
    const c0 = Math.max(0, Math.floor((bb[1] - grid.lon0) / grid.dlon)), c1 = Math.min(grid.cols - 1, Math.floor((bb[3] - grid.lon0) / grid.dlon));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) keys.push('r' + r + 'c' + c);
    return keys;
  }
  // 격자 파일들에서 범위 안 나무만 모은다. 위도·경도는 1e9배 정수 그대로(원본 값 그대로).
  function treesIn(cells, bb) {
    const sp = [], rd = [], spI = new Map(), rdI = new Map(), LA = [], LO = [], TS = [], TR = [];
    const s9 = Math.floor(bb[0] * 1e9), w9 = Math.floor(bb[1] * 1e9), n9 = Math.ceil(bb[2] * 1e9), e9 = Math.ceil(bb[3] * 1e9);
    for (const c of cells) {
      if (!c) continue;
      let la = 0, lo = 0;
      for (let i = 0; i < c.ts.length; i++) {
        la += c.tla[i]; lo += c.tlo[i];
        if (la < s9 || la > n9 || lo < w9 || lo > e9) continue;
        const sn = c.sp[c.ts[i]], rn = c.rd[c.tr[i]];
        let s = spI.get(sn); if (s === undefined) { s = sp.length; sp.push(sn); spI.set(sn, s); }
        let r = rdI.get(rn); if (r === undefined) { r = rd.length; rd.push(rn); rdI.set(rn, r); }
        LA.push(la); LO.push(lo); TS.push(s); TR.push(r);
      }
    }
    const delta = (a) => { const o = new Array(a.length); let p = 0; for (let i = 0; i < a.length; i++) { o[i] = a[i] - p; p = a[i]; } return o; };
    return { sp, rd, tla: delta(LA), tlo: delta(LO), ts: TS, tr: TR };
  }

  // ---------------------------------------------------------------- 지역 만들기
  // E: 계산 엔진, o: {id, name, cor(corridor), hw(Overpass 길 응답), trees(treesIn 결과)}
  function buildArea(E, o) {
    const lat0 = o.cor.lat0, lon0 = o.cor.lon0, k = kOf(lat0);
    const toX = (lon) => (lon - lon0) * k.kx, toY = (lat) => (lat - lat0) * k.ky;
    const nodeIdx = new Map(), NX = [], NY = [];
    const wt = [], wn = [], wh = [], wl = [], WV = [], names = [], nameIdx = new Map();
    let used = 0;
    for (const el of (o.hw && o.hw.elements) || []) {
      if (el.type !== 'way' || !el.geometry || !el.nodes || el.nodes.length !== el.geometry.length || el.nodes.length < 2) continue;
      const t = el.tags || {};
      const ty = wayType(t);
      if (!ty || !walkable(t)) continue;
      const idx = [];
      for (let i = 0; i < el.nodes.length; i++) {
        const g = el.geometry[i]; if (!g) continue;
        let n = nodeIdx.get(el.nodes[i]);
        if (n === undefined) { n = NX.length; nodeIdx.set(el.nodes[i], n); NX.push(Math.round(toX(g.lon) * 100) / 100); NY.push(Math.round(toY(g.lat) * 100) / 100); }
        idx.push(n);
      }
      if (idx.length < 2) continue;
      const nm = (t.name || '').trim();
      let ni = -1;
      if (nm) { ni = nameIdx.get(nm); if (ni === undefined) { ni = names.length; names.push(nm); nameIdx.set(nm, ni); } }
      wt.push(ty); wn.push(ni); wh.push(halfWidth(t, ty)); wl.push(idx.length);
      for (const n of idx) WV.push(n);
      used++;
    }
    const delta = (a) => { const out = new Array(a.length); let p = 0; for (let i = 0; i < a.length; i++) { out[i] = a[i] - p; p = a[i]; } return out; };
    const xy = o.cor.ll.map(p => [toX(p[1]), toY(p[0])]);
    const box = [Math.floor(Math.min(...xy.map(p => p[0]))), Math.floor(Math.min(...xy.map(p => p[1]))), Math.ceil(Math.max(...xy.map(p => p[0]))), Math.ceil(Math.max(...xy.map(p => p[1])))];
    const tr = o.trees || { sp: [], rd: [], tla: [], tlo: [], ts: [], tr: [] };
    const raw = {
      v: 2, id: o.id, name: o.name, lat0, lon0, kx: k.kx, ky: k.ky, box,
      osm: (o.hw && o.hw.osm3s && o.hw.osm3s.timestamp_osm_base) || '',
      names, nx: delta(NX), ny: delta(NY), wt: wt.join(''), wn, wh, wl, wv: delta(WV),
      bh: [], bp: '', bl: [], bv: [], gt: '', gl: [], gv: [], lw: [], ll: [], lv: [], st: [], lm: [],
      sp: tr.sp, rd: tr.rd, tla: tr.tla, tlo: tr.tlo, ts: tr.ts, tr: tr.tr
    };
    const A = E.decodeArea(raw);
    // 범위가 넓으면 그림자 격자를 조금 성기게(메모리 절약)
    const areaKm2 = (box[2] - box[0]) * (box[3] - box[1]) / 1e6;
    A.cell = areaKm2 > 9 ? 2 : 1.5;
    A.kind = 'osm'; A.cov = o.cor.ll; A.hasBld = false; A.wayCount = used;
    return A;
  }
  // 건물을 나중에 붙인다(여름·겨울 모드에서만 필요)
  function attachBuildings(E, A, json) {
    A.blds = E.makeBlds(bldPolys(json, A.toXY));
    A.hasBld = true;
    for (const key of Object.keys(A.cache)) if (/^shade|^winter/.test(key)) delete A.cache[key];
    return A.blds.length;
  }

  return { ENDPOINTS, kOf, distM, corridor, bboxOf, inPoly, covers, qWays, qBlds, qBoth, splitBoth, overpass, wayType, walkable, halfWidth, bldHeight, bldPolys, joinRings, cellKeys, treesIn, buildArea, attachBuildings };
});
