/* 계절길 · 서울 어디서나: 지도, 검색, 결과 카드 */
(function () {
  'use strict';
  const E = window.SWEngine, O = window.SWOsm, SEOUL = window.SW_SEOUL;
  const $ = (id) => document.getElementById(id);
  const WALK = 75;          // m/분
  const MAXD = 3500;        // 출발·도착 직선거리 한도(m)
  const MIND = 40;
  const TREE_MIN = 0.07;    // 이보다 멀리 보면 가로수 점을 그리지 않는다(px/m)
  const BIN = 500;          // 가로수 그리기 묶음(m)
  const EMBED = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------------------------------------------------------------- 화면 좌표(서울시청 기준 평면, m)
  const D = (() => { const lat0 = 37.5665, lon0 = 126.978, k = O.kOf(lat0); return { lat0, lon0, kx: k.kx, ky: k.ky }; })();
  const ll2d = (lat, lon) => [(lon - D.lon0) * D.kx, (lat - D.lat0) * D.ky];
  const d2ll = (x, y) => [D.lat0 + y / D.ky, D.lon0 + x / D.kx];
  // 지역 좌표 → 화면 좌표(둘 다 위도·경도에 선형이라 정확하다)
  const affine = (A) => ({ a: D.kx / A.kx, d: D.ky / A.ky, e: (A.lon0 - D.lon0) * D.kx, f: (A.lat0 - D.lat0) * D.ky });

  // ---------------------------------------------------------------- 미리 받아 둔 지역과 예시
  const PRESETS = {
    jongno: { label: '종로·광화문', file: 'data/jongno.js', lat0: 37.57215, lon0: 126.983, box: [-928, -816, 928, 816] },
    yeouido: { label: '여의도', file: 'data/yeouido.js', lat0: 37.5255, lon0: 126.928, box: [-1459, -999, 1459, 999] }
  };
  for (const p of Object.values(PRESETS)) { const k = O.kOf(p.lat0); p.kx = k.kx; p.ky = k.ky; }
  const fromPreset = (id, x, y) => { const p = PRESETS[id]; return { lat: p.lat0 + y / p.ky, lon: p.lon0 + x / p.kx }; };
  const station = (nm) => { const s = SEOUL.stations.find(q => q[0] === nm); return s ? { lat: s[1], lon: s[2] } : null; };
  const EXAMPLES = [
    { label: '종각역 → 미국대사관', a: Object.assign(fromPreset('jongno', 16, -219), { name: '종각역' }), b: Object.assign(fromPreset('jongno', -455, 116), { name: '미국대사관' }) },
    { label: '여의도 윤중로 벚꽃', mode: 'spring-cherry', a: Object.assign(fromPreset('yeouido', -327, -425), { name: '여의도역' }), b: Object.assign(fromPreset('yeouido', -887, 279), { name: '국회의사당역' }) },
    { label: '강남역 → 역삼역', a: Object.assign(station('강남역') || { lat: 37.4979, lon: 127.0276 }, { name: '강남역' }), b: Object.assign(station('역삼역') || { lat: 37.5007, lon: 127.0365 }, { name: '역삼역' }) }
  ];

  const SEASONS = {
    spring: { label: '봄', modes: ['spring-cherry', 'spring-ipap', 'spring-all'] },
    summer: { label: '여름', modes: ['summer-shade'] },
    autumn: { label: '가을', modes: ['autumn-foliage', 'autumn-ginkgo'] },
    winter: { label: '겨울', modes: ['winter-sun'] }
  };
  const MODE_UI = {
    'spring-cherry': { chip: '벚꽃', note: '2026년 서울 벚꽃은 3월 29일에 피었어요(평년 4월 8일). 여의도 윤중로도 같은 날 피었어요. 피고 1~2주 사이가 절정이에요.' },
    'spring-ipap': { chip: '이팝꽃', note: '이팝나무는 보통 5월 초·중순에 흰 꽃이 펴요.' },
    'spring-all': { chip: '봄꽃 전체', note: '산수유·매화(3월) → 벚꽃·목련·살구(4월) → 이팝·때죽·칠엽수(5월) 순서로 펴요.' },
    'summer-shade': { chip: '그늘길', note: '2026년 7월 20일 해 위치로 건물과 가로수 그림자를 계산해요. 차도는 그늘진 쪽 보도를 걷는다고 봐요.' },
    'autumn-foliage': { chip: '단풍길', note: '서울 도심 가로수 단풍은 보통 10월 말~11월 중순이에요. 은행 암나무 옆은 피해서 골라요.' },
    'autumn-ginkgo': { chip: '은행 냄새 피하기', note: '은행 열매는 보통 9월 말~11월에 떨어져요. 가로수 데이터에 암나무 표시가 있는 곳에서만 쓸 수 있어요(자치구마다 달라요).' },
    'winter-sun': { chip: '볕길', note: '2027년 1월 15일 9~16시 그림자로 하루 볕 드는 시간을 계산해요. 하루 2시간도 해가 안 드는 곳을 응달(빙판 주의)로 봐요.' }
  };

  const S = { A: null, B: null, mode: null, hour: 18.5, winterHour: 12, cap: {}, armed: 'B', res: null, busy: false };
  let cur = null;           // 지금 경로를 계산한 지역
  const areas = [];         // 받아 둔 지역(최근 것이 앞)
  let osmSeq = 0;

  // ---------------------------------------------------------------- 날짜 → 기본 계절
  function defaultMode(d) {
    const m = d.getMonth() + 1, day = d.getDate();
    if (m >= 3 && m <= 5) return (m === 3 || (m === 4 && day <= 20)) ? 'spring-cherry' : 'spring-ipap';
    if (m >= 6 && m <= 8) return 'summer-shade';
    if (m >= 9 && m <= 11) return 'autumn-foliage';
    return 'winter-sun';
  }
  const seasonOfMode = (mode) => E.MODES[mode].season;
  const needsBld = (mode) => mode === 'summer-shade' || mode === 'winter-sun';
  const inSeoul = (p) => O.inPoly(p.lat, p.lon, SEOUL.boundary);

  // ---------------------------------------------------------------- 파일 읽기
  const scripts = new Map();
  function loadScript(src) {
    if (scripts.has(src)) return scripts.get(src);
    const pr = new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = src; s.async = true;
      s.onload = res; s.onerror = () => { scripts.delete(src); rej(new Error(src + ' 파일을 불러오지 못했어요')); };
      document.head.appendChild(s);
    });
    scripts.set(src, pr);
    return pr;
  }
  async function gunzipB64(b64) {
    const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    if (!('DecompressionStream' in window)) throw new Error('이 브라우저는 압축 해제를 지원하지 않아요. 최신 브라우저로 열어 주세요.');
    const ds = new DecompressionStream('gzip');
    return await new Response(new Blob([bin]).stream().pipeThrough(ds)).text();
  }

  // ---------------------------------------------------------------- 색
  let C = {}, DARK = false;
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    C = {
      land: v('--land'), park: v('--park'), water: v('--water'), bld: v('--bld'), bldEdge: v('--bld-edge'),
      road: v('--road'), roadCase: v('--road-case'), path: v('--path'), pathCase: v('--path-case'),
      shadow: v('--shadow'), label: v('--label'), halo: v('--halo'), ink: v('--ink'), muted: v('--muted'),
      short: v('--short'), shortCase: v('--short-case'), pick: v('--pick'), pickCase: v('--pick-case'), ice: v('--ice'),
      tFaint: v('--t-faint'), tCherry: v('--t-cherry'), tIpap: v('--t-ipap'), tSpring: v('--t-spring'), tGinkgo: v('--t-ginkgo'), tFemale: v('--t-female'),
      tRed: v('--t-red'), tZelk: v('--t-zelk'), tYellow: v('--t-yellow'), tGreen: v('--t-green'), tEver: v('--t-ever'), station: v('--station'),
      cov: v('--cov')
    };
    DARK = v('--tile-mode') === 'dark';
  }
  function invHex(h) {
    const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); if (!m) return '#ffffff';
    const n = parseInt(m[1], 16) ^ 0xffffff; return '#' + n.toString(16).padStart(6, '0');
  }

  // ---------------------------------------------------------------- 지역 그리기용 경로(타일이 안 될 때)
  function ccw(p) { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return s >= 0 ? p : p.slice().reverse(); }
  function addPoly(path, pts) { const p = ccw(pts); path.moveTo(p[0][0], p[0][1]); for (let i = 1; i < p.length; i++) path.lineTo(p[i][0], p[i][1]); path.closePath(); }
  function areaPaths(A) {
    if (A.P) return A.P;
    const P = { park: new Path2D(), water: new Path2D(), blds: new Path2D(), road: {} };
    for (const g of A.green) addPoly(g.t === 'w' ? P.water : P.park, g.p);
    P.wl = A.wlines.map(l => { const p = new Path2D(); p.moveTo(l.p[0][0], l.p[0][1]); for (let i = 1; i < l.p.length; i++) p.lineTo(l.p[i][0], l.p[i][1]); return { w: l.w, p }; });
    for (const b of A.blds) if (!b.part) addPoly(P.blds, b.p);
    for (const t of ['M', 'm', 'f', 's', 'c']) P.road[t] = new Path2D();
    const G = A.G;
    for (const w of A.ways) { const p = P.road[w.t] || P.road.f; const ix = w.idx; p.moveTo(G.X[ix[0]], G.Y[ix[0]]); for (let i = 1; i < ix.length; i++) p.lineTo(G.X[ix[i]], G.Y[ix[i]]); }
    A.P = P;
    A.labels = streetLabels(A);
    return P;
  }
  function streetLabels(A) {
    const G = A.G, best = new Map();
    for (const w of A.ways) {
      if (w.name < 0 || !(w.t === 'M' || w.t === 'm' || w.t === 'f')) continue;
      let L = 0; for (let i = 1; i < w.idx.length; i++) L += Math.hypot(G.X[w.idx[i]] - G.X[w.idx[i - 1]], G.Y[w.idx[i]] - G.Y[w.idx[i - 1]]);
      const nm = A.names[w.name], o = best.get(nm);
      if (!o || L > o.L) best.set(nm, { w, L });
    }
    const out = [], T = affine(A);
    for (const [nm, o] of best) {
      if (o.L < 80) continue;
      const ix = o.w.idx; let acc = 0; const half = o.L / 2;
      for (let i = 1; i < ix.length; i++) {
        const ax = G.X[ix[i - 1]], ay = G.Y[ix[i - 1]], bx = G.X[ix[i]], by = G.Y[ix[i]], sl = Math.hypot(bx - ax, by - ay);
        if (acc + sl >= half) { const u = (half - acc) / (sl || 1); out.push({ text: nm, x: T.a * (ax + (bx - ax) * u) + T.e, y: T.d * (ay + (by - ay) * u) + T.f, dx: bx - ax, dy: by - ay, L: o.L, pri: (o.w.t === 'M' ? 2 : o.w.t === 'm' ? 1 : 0) * 1e5 + o.L }); break; }
        acc += sl;
      }
    }
    return out.sort((a, b) => b.pri - a.pri);
  }

  // ---------------------------------------------------------------- 가로수 묶음(서울 전체, 화면 좌표)
  function treeGroups(mode) {
    const F = E.F;
    switch (mode) {
      case 'spring-cherry': return [['tCherry', F.CHERRY, '벚나무류']];
      case 'spring-ipap': return [['tIpap', F.IPAP, '이팝나무']];
      case 'spring-all': return [['tCherry', F.CHERRY, '벚나무류'], ['tIpap', F.IPAP, '이팝나무'], ['tSpring', F.SPRING & ~F.CHERRY & ~F.IPAP, '그 밖의 봄꽃 나무']];
      case 'summer-shade': return [['tGreen', -1, '가로수(그늘)']];
      case 'autumn-foliage': return [['tGinkgo', F.GINKGO, '은행나무'], ['tRed', F.RED, '단풍나무·벚나무 등'], ['tZelk', F.ZELK, '느티나무'], ['tYellow', F.YELLOW, '팽나무 등'], ['tFemale', F.FEMALE, '은행 암나무']];
      case 'autumn-ginkgo': return [['tGinkgo', F.GINKGO, '은행나무(암수 모름)'], ['tFemale', F.FEMALE, '은행 암나무']];
      case 'winter-sun': return [['tEver', F.EVER, '상록수(겨울 그늘)']];
    }
    return [];
  }
  const cells = new Map(); // key → {state, x, y, fl, bins}
  function cellData(key) {
    let c = cells.get(key);
    if (c) return c;
    c = { state: 'loading' };
    cells.set(key, c);
    loadScript('data/trees/' + key + '.js').then(() => {
      const raw = window.SW_TREES && window.SW_TREES[key];
      if (!raw) throw new Error('no data');
      Object.assign(c, prepCell(raw), { state: 'ok', raw });
      layerVer++; draw();
    }).catch(() => { c.state = 'err'; });
    return c;
  }
  function prepCell(raw) {
    const n = raw.ts.length, x = new Float64Array(n), y = new Float64Array(n), fl = new Int32Array(n);
    const spFlags = raw.sp.map(E.speciesFlags), bins = new Map();
    let la = 0, lo = 0;
    for (let i = 0; i < n; i++) {
      la += raw.tla[i]; lo += raw.tlo[i];
      const p = ll2d(la / 1e9, lo / 1e9); x[i] = p[0]; y[i] = p[1]; fl[i] = spFlags[raw.ts[i]];
      const bx = Math.floor(p[0] / BIN), by = Math.floor(p[1] / BIN), k = bx * 100003 + by;
      let b = bins.get(k); if (!b) { b = { bx, by, idx: [], paths: {} }; bins.set(k, b); }
      b.idx.push(i);
    }
    return { x, y, fl, bins: [...bins.values()] };
  }
  function binPaths(c, b, mode) {
    if (b.paths[mode]) return b.paths[mode];
    const groups = treeGroups(mode), faint = new Path2D(), paths = groups.map(() => new Path2D());
    for (const i of b.idx) {
      const f = c.fl[i]; let g = -1;
      for (let k = groups.length - 1; k >= 0; k--) { const gf = groups[k][1]; if (gf === -1 || (f & gf)) { g = k; break; } }
      const p = g < 0 ? faint : paths[g];
      p.moveTo(c.x[i], c.y[i]); p.lineTo(c.x[i] + 0.01, c.y[i]);
    }
    return (b.paths[mode] = { faint, groups: paths, colors: groups.map(g => g[0]) });
  }
  function ensureCells(keys) { return Promise.all(keys.filter(k => SEOUL.cells.includes(k)).map(k => { const c = cellData(k); return c.state === 'ok' ? null : loadScript('data/trees/' + k + '.js'); })); }

  // ---------------------------------------------------------------- 캔버스와 보기
  const cv = $('map'), ctx = cv.getContext('2d');
  let W = 0, H = 0, DPR = 1, V = { cx: 0, cy: 0, s: 0.02 }, drawQueued = false, frameNo = 0;
  let shadowPath = null, routeDraw = null;
  function resize() {
    const r = cv.getBoundingClientRect(); W = r.width; H = r.height;
    DPR = Math.min(window.devicePixelRatio || 1, 2.5);
    cv.width = Math.max(1, Math.round(W * DPR)); cv.height = Math.max(1, Math.round(H * DPR));
    if (!resize.done && W > 0) { resize.done = true; home(); }
    draw();
  }
  function fitView(b, pad) {
    const w = Math.max(1, b[2] - b[0]), h = Math.max(1, b[3] - b[1]);
    const s = Math.min((W - 2 * pad) / w, (H - 2 * pad) / h);
    return { cx: (b[0] + b[2]) / 2, cy: (b[1] + b[3]) / 2, s: Math.max(0.004, Math.min(4, s)) };
  }
  let seoulBox = null;
  function home() {
    if (!W) return;
    if (S.A && S.B) {
      const a = ll2d(S.A.lat, S.A.lon), b = ll2d(S.B.lat, S.B.lon);
      const m = Math.max(140, Math.hypot(a[0] - b[0], a[1] - b[1]) * 0.28);
      V = fitView([Math.min(a[0], b[0]) - m, Math.min(a[1], b[1]) - m, Math.max(a[0], b[0]) + m, Math.max(a[1], b[1]) + m], 24);
    } else if (S.A || S.B) {
      const p = S.A || S.B, q = ll2d(p.lat, p.lon); V = { cx: q[0], cy: q[1], s: 0.6 };
    } else {
      if (!seoulBox) { const pts = SEOUL.boundary.map(p => ll2d(p[0], p[1])); seoulBox = [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))]; }
      V = fitView(seoulBox, 12);
    }
    draw();
  }
  const toScreen = (x, y) => [W / 2 + (x - V.cx) * V.s, H / 2 - (y - V.cy) * V.s];
  const toMap = (sx, sy) => [V.cx + (sx - W / 2) / V.s, V.cy - (sy - H / 2) / V.s];
  function mapT(c) { c.setTransform(V.s * DPR, 0, 0, -V.s * DPR, (W / 2 - V.cx * V.s) * DPR, (H / 2 + V.cy * V.s) * DPR); }
  function areaT(c, A) { mapT(c); const T = affine(A); c.transform(T.a, 0, 0, T.d, T.e, T.f); }
  const mapTransform = () => mapT(ctx), areaTransform = (A) => areaT(ctx, A);
  function draw() { if (drawQueued) return; drawQueued = true; requestAnimationFrame(() => { drawQueued = false; drawNow(); }); }

  // ---------------------------------------------------------------- 지도 타일(OpenStreetMap)
  const tiles = new Map();
  let tileOK = false, tileErr = 0;
  const lon2tx = (lon, z) => (lon + 180) / 360 * Math.pow(2, z);
  const lat2ty = (lat, z) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z); };
  const tx2lon = (x, z) => x / Math.pow(2, z) * 360 - 180;
  const ty2lat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / Math.pow(2, z); return 180 / Math.PI * Math.atan(Math.sinh(n)); };
  const tileZoom = () => Math.max(10, Math.min(19, Math.round(Math.log2(V.s * 156543.03 * Math.cos(D.lat0 * Math.PI / 180)))));
  const vectorMode = () => !tileOK && tileErr >= 4;
  function getTile(z, x, y) {
    const key = z + '/' + x + '/' + y;
    let t = tiles.get(key);
    if (!t) {
      t = { img: new Image(), ok: false, err: false, used: 0 };
      t.img.decoding = 'async';
      t.img.onload = () => { t.ok = true; tileOK = true; draw(); };
      t.img.onerror = () => { t.err = true; tileErr++; if (vectorMode()) draw(); };
      t.img.src = 'https://tile.openstreetmap.org/' + key + '.png';
      tiles.set(key, t);
      if (tiles.size > 320) pruneTiles();
    }
    t.used = frameNo;
    return t;
  }
  function pruneTiles() {
    const list = [...tiles.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [k, t] of list.slice(0, 120)) { if (!t.ok && !t.err) { t.img.onload = t.img.onerror = null; t.img.src = ''; } tiles.delete(k); }
  }
  function drawTiles() {
    const z = tileZoom(), n = Math.pow(2, z);
    const [la0, lo0] = d2ll(...toMap(0, 0)), [la1, lo1] = d2ll(...toMap(W, H));
    const tx0 = Math.max(0, Math.floor(lon2tx(lo0, z))), tx1 = Math.min(n - 1, Math.floor(lon2tx(lo1, z)));
    const ty0 = Math.max(0, Math.floor(lat2ty(la0, z))), ty1 = Math.min(n - 1, Math.floor(lat2ty(la1, z)));
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > 140) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const a = toScreen(...ll2d(ty2lat(ty, z), tx2lon(tx, z))), b = toScreen(...ll2d(ty2lat(ty + 1, z), tx2lon(tx + 1, z)));
      const X0 = Math.floor(a[0] * DPR), Y0 = Math.floor(a[1] * DPR), X1 = Math.ceil(b[0] * DPR), Y1 = Math.ceil(b[1] * DPR);
      const t = getTile(z, tx, ty);
      if (t.ok) { ctx.drawImage(t.img, X0, Y0, X1 - X0, Y1 - Y0); continue; }
      for (let dz = 1; dz <= 5 && z - dz >= 0; dz++) {
        const p = tiles.get((z - dz) + '/' + (tx >> dz) + '/' + (ty >> dz));
        if (p && p.ok) { const sz = 256 / (1 << dz), sx = (tx - ((tx >> dz) << dz)) * sz, sy = (ty - ((ty >> dz) << dz)) * sz; ctx.drawImage(p.img, sx, sy, sz, sz, X0, Y0, X1 - X0, Y1 - Y0); break; }
      }
    }
  }
  // 타일 색을 눌러 가로수·경로가 잘 보이게: 밝은 화면은 채도를 빼고, 어두운 화면은 뒤집어 회색으로
  function toneTiles() {
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    const w = cv.width, h = cv.height;
    if (DARK) {
      ctx.globalCompositeOperation = 'difference'; ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'saturation'; ctx.fillStyle = '#808080'; ctx.globalAlpha = 0.9; ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = C.land; ctx.globalAlpha = 0.42; ctx.fillRect(0, 0, w, h);
    } else {
      ctx.globalCompositeOperation = 'saturation'; ctx.fillStyle = '#808080'; ctx.globalAlpha = 0.72; ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = C.land; ctx.globalAlpha = 0.3; ctx.fillRect(0, 0, w, h);
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- 그리기
  // 그림자와 가로수 점은 따로 그려 두고(TL), 지도를 끄는 동안에는 그 그림을 옮기기만 한다.
  // 움직임이 멈추고 0.15초가 지나면 새 위치에서 다시 그린다.
  const TL = { cv: document.createElement('canvas'), key: '', vk: '', V: null, t: 0 };
  let layerVer = 0, lastMove = 0, prevVK = '';
  function renderLayer(key, vk) {
    const c = TL.cv;
    if (c.width !== cv.width || c.height !== cv.height) { c.width = cv.width; c.height = cv.height; }
    const g = c.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, c.width, c.height);
    g.lineCap = 'round'; g.lineJoin = 'round';
    if (cur && shadowPath) { areaT(g, cur); g.fillStyle = C.shadow; g.fill(shadowPath); }
    drawTrees(g);
    TL.key = key; TL.vk = vk; TL.V = { cx: V.cx, cy: V.cy, s: V.s };
  }
  function blitLayer() {
    if (!TL.V) return;
    const k = V.s / TL.V.s;
    ctx.setTransform(k, 0, 0, k, DPR * (W / 2 * (1 - k) + (TL.V.cx - V.cx) * V.s), DPR * (H / 2 * (1 - k) - (TL.V.cy - V.cy) * V.s));
    ctx.drawImage(TL.cv, 0, 0);
  }
  function drawNow() {
    frameNo++;
    const s = V.s, vec = vectorMode();
    const vk = V.cx + ',' + V.cy + ',' + V.s, now = performance.now();
    if (vk !== prevVK) { prevVK = vk; lastMove = now; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    // 어두운 화면은 타일을 뒤집으므로 바탕도 뒤집은 색으로 깔아 둔다
    ctx.fillStyle = vec ? C.land : (DARK ? invHex(C.land) : C.land);
    ctx.fillRect(0, 0, cv.width, cv.height);
    if (!vec) { drawTiles(); toneTiles(); }
    const A = cur;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (vec && A) drawVectorBase(A);
    // 서울 경계(멀리서 볼 때)
    if (s < 0.06) {
      mapTransform();
      const p = new Path2D(); SEOUL.boundary.forEach((q, i) => { const d = ll2d(q[0], q[1]); if (i) p.lineTo(d[0], d[1]); else p.moveTo(d[0], d[1]); }); p.closePath();
      ctx.strokeStyle = C.muted; ctx.lineWidth = 1.5 / s; ctx.setLineDash([5 / s, 4 / s]); ctx.stroke(p); ctx.setLineDash([]);
    }
    // 받은 범위
    if (A && A.kind === 'osm') {
      mapTransform();
      const p = new Path2D(); A.cov.forEach((q, i) => { const d = ll2d(q[0], q[1]); if (i) p.lineTo(d[0], d[1]); else p.moveTo(d[0], d[1]); }); p.closePath();
      ctx.strokeStyle = C.cov; ctx.lineWidth = 1.2 / s; ctx.setLineDash([6 / s, 5 / s]); ctx.stroke(p); ctx.setLineDash([]);
    }
    // 그림자·가로수(따로 그려 둔 그림)
    const key = S.mode + '|' + layerVer + '|' + DARK + '|' + cv.width + 'x' + cv.height + '|' + (A ? A.id : '');
    const same = TL.vk === vk;
    if (TL.key !== key || !TL.V || (!same && now - lastMove >= 140)) renderLayer(key, vk);
    else if (!same) { clearTimeout(TL.t); TL.t = setTimeout(draw, 150); }
    blitLayer();
    // 경로
    if (A && routeDraw) {
      areaTransform(A);
      for (const r of routeDraw) {
        ctx.strokeStyle = r.caseColor; ctx.lineWidth = (r.w + 4) / s; ctx.stroke(r.path);
        ctx.strokeStyle = r.color; ctx.lineWidth = r.w / s; ctx.stroke(r.path);
        if (r.ice) { ctx.strokeStyle = C.ice; ctx.lineWidth = (r.w - 1.5) / s; ctx.setLineDash([3 / s, 3 / s]); ctx.stroke(r.ice); ctx.setLineDash([]); }
      }
    }
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (vec) drawLabels(A);
    drawMarker(S.A, '출', C.ink); drawMarker(S.B, '도', C.pick);
    updateScale();
    $('attr-tiles').hidden = vec;
  }
  function drawVectorBase(A) {
    const P = areaPaths(A), s = V.s;
    areaTransform(A);
    ctx.fillStyle = C.park; ctx.fill(P.park);
    ctx.fillStyle = C.water; ctx.fill(P.water);
    ctx.strokeStyle = C.water; for (const l of P.wl) { ctx.lineWidth = Math.max(l.w, 1.5 / s); ctx.stroke(l.p); }
    const RW = { M: [11, 8.4, 2.2], m: [6.4, 4.3, 1.3], f: [3.4, 1.9, 0.7], s: [3.4, 1.9, 0.7] };
    for (const t of ['f', 's', 'm', 'M']) { ctx.strokeStyle = t === 'f' || t === 's' ? C.pathCase : C.roadCase; ctx.lineWidth = Math.max(RW[t][0], RW[t][2] / s + 1 / s); ctx.stroke(P.road[t]); }
    for (const t of ['f', 's', 'm', 'M']) { ctx.strokeStyle = t === 'f' || t === 's' ? C.path : C.road; ctx.lineWidth = Math.max(RW[t][1], RW[t][2] / s); if (t === 's') ctx.setLineDash([1, 1]); ctx.stroke(P.road[t]); ctx.setLineDash([]); }
    ctx.strokeStyle = C.pathCase; ctx.lineWidth = Math.max(2.2, 0.7 / s); ctx.setLineDash([1.6, 1.2]); ctx.stroke(P.road.c); ctx.setLineDash([]);
    ctx.fillStyle = C.bld; ctx.fill(P.blds);
    if (s > 0.6) { ctx.strokeStyle = C.bldEdge; ctx.lineWidth = 0.6 / s; ctx.stroke(P.blds); }
  }
  function drawTrees(g) {
    const s = V.s;
    if (s < TREE_MIN || !S.mode) return;
    const [x0, y1] = toMap(0, 0), [x1, y0] = toMap(W, H);
    const [la0, lo0] = d2ll(x0, y0), [la1, lo1] = d2ll(x1, y1);
    const keys = O.cellKeys(SEOUL.grid, [la0, lo0, la1, lo1]).filter(k => SEOUL.cells.includes(k));
    const vis = [];
    for (const k of keys) {
      const c = cellData(k);
      if (c.state !== 'ok') continue;
      for (const b of c.bins) {
        if ((b.bx + 1) * BIN < x0 - 20 || b.bx * BIN > x1 + 20 || (b.by + 1) * BIN < y0 - 20 || b.by * BIN > y1 + 20) continue;
        vis.push(binPaths(c, b, S.mode));
      }
    }
    if (!vis.length) return;
    mapT(g);
    g.lineCap = 'round';
    const dot = s < 0.2 ? 2.2 : Math.min(7, Math.max(2.6, 1.6 + s * 1.1));
    if (s >= 0.25) { g.strokeStyle = C.tFaint; g.lineWidth = dot * 0.62 / s; for (const v of vis) g.stroke(v.faint); }
    if (s >= 0.12) { g.strokeStyle = C.halo; g.lineWidth = (dot + (s < 0.2 ? 1 : 1.6)) / s; for (const v of vis) for (const p of v.groups) g.stroke(p); }
    for (const v of vis) v.groups.forEach((p, k) => { g.strokeStyle = C[v.colors[k]]; g.lineWidth = dot / s; g.stroke(p); });
  }
  function drawLabels(A) {
    const boxes = [];
    const hit = (b) => boxes.some(o => !(b[2] < o[0] || b[0] > o[2] || b[3] < o[1] || b[1] > o[3]));
    const font = (px, wgt) => wgt + ' ' + px + 'px ' + getComputedStyle(document.body).fontFamily;
    for (const p of [S.A, S.B]) if (p) { const [x, y] = toScreen(...ll2d(p.lat, p.lon)); boxes.push([x - 14, y - 14, x + 14, y + 14]); }
    if (V.s >= 0.05) {
      for (const st of SEOUL.stations) {
        const [x, y] = toScreen(...ll2d(st[1], st[2]));
        if (x < -50 || y < -20 || x > W + 50 || y > H + 20) continue;
        ctx.font = font(12.5, 600);
        const tw = ctx.measureText(st[0]).width, b = [x - tw / 2 - 2, y - 22, x + tw / 2 + 2, y - 6];
        if (hit(b)) continue;
        boxes.push(b, [x - 5, y - 5, x + 5, y + 5]);
        ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fillStyle = C.station; ctx.strokeStyle = C.halo; ctx.lineWidth = 2; ctx.fill(); ctx.stroke();
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
        ctx.strokeStyle = C.halo; ctx.lineWidth = 3.4; ctx.strokeText(st[0], x, y - 14); ctx.fillStyle = C.ink; ctx.fillText(st[0], x, y - 14);
      }
    }
    if (!A || V.s < 0.35) return;
    areaPaths(A);
    ctx.font = font(11, 500);
    for (const l of A.labels) {
      const [x, y] = toScreen(l.x, l.y);
      if (x < -80 || y < -20 || x > W + 80 || y > H + 20) continue;
      const tw = ctx.measureText(l.text).width;
      if (tw > l.L * V.s * 0.9) continue;
      let ang = Math.atan2(-l.dy, l.dx);
      if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
      const c = Math.abs(Math.cos(ang)), sn = Math.abs(Math.sin(ang)), hw = (tw * c + 12 * sn) / 2, hh = (tw * sn + 12 * c) / 2;
      const b = [x - hw, y - hh, x + hw, y + hh];
      if (hit(b)) continue;
      boxes.push(b);
      ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.strokeStyle = C.halo; ctx.lineWidth = 3.2; ctx.strokeText(l.text, 0, 0);
      ctx.fillStyle = C.label; ctx.fillText(l.text, 0, 0);
      ctx.restore();
    }
  }
  function drawMarker(p, ch, color) {
    if (!p) return;
    const [x, y] = toScreen(...ll2d(p.lat, p.lon));
    ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.strokeStyle = C.halo; ctx.lineWidth = 3; ctx.fill(); ctx.stroke();
    ctx.fillStyle = C.halo; ctx.font = '700 11.5px ' + getComputedStyle(document.body).fontFamily; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(ch, x, y + 0.5);
  }
  function updateScale() {
    const m = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000].find(v => v * V.s >= 60) || 10000;
    $('scale-bar').style.width = Math.round(m * V.s) + 'px';
    $('scale-txt').textContent = m >= 1000 ? (m / 1000) + ' km' : m + ' m';
  }

  // ---------------------------------------------------------------- 지도 조작
  const ptrs = new Map(); let gesture = null;
  function zoomAt(f, sx, sy) {
    const [mx, my] = toMap(sx, sy);
    const ns = Math.min(8, Math.max(0.006, V.s * f));
    V.cx = mx - (sx - W / 2) / ns; V.cy = my + (sy - H / 2) / ns; V.s = ns;
    draw();
  }
  const local = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  function markerAt(sx, sy) {
    for (const k of ['B', 'A']) { const p = S[k]; if (!p) continue; const [x, y] = toScreen(...ll2d(p.lat, p.lon)); if (Math.hypot(x - sx, y - sy) < 18) return k; }
    return null;
  }
  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId);
    const p = local(e); ptrs.set(e.pointerId, p);
    if (ptrs.size === 1) { const mk = markerAt(p[0], p[1]); gesture = { start: p, moved: false, marker: mk }; cv.classList.add('dragging'); }
    else gesture = Object.assign(gesture || {}, { moved: true, marker: null });
  });
  cv.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const p = local(e), prev = ptrs.get(e.pointerId);
    ptrs.set(e.pointerId, p);
    if (ptrs.size === 1 && gesture) {
      if (Math.hypot(p[0] - gesture.start[0], p[1] - gesture.start[1]) > 5) gesture.moved = true;
      if (gesture.marker && gesture.moved) { const [lat, lon] = d2ll(...toMap(p[0], p[1])); S[gesture.marker] = { lat, lon, name: null }; draw(); }
      else if (gesture.moved) { V.cx -= (p[0] - prev[0]) / V.s; V.cy += (p[1] - prev[1]) / V.s; draw(); }
    } else if (ptrs.size === 2) {
      const ids = [...ptrs.keys()], o = ptrs.get(ids[0] === e.pointerId ? ids[1] : ids[0]);
      const d0 = Math.hypot(prev[0] - o[0], prev[1] - o[1]), d1 = Math.hypot(p[0] - o[0], p[1] - o[1]);
      if (d0 > 0) zoomAt(d1 / d0, (p[0] + o[0]) / 2, (p[1] + o[1]) / 2);
    }
  });
  function endPtr(e) {
    if (!ptrs.has(e.pointerId)) return;
    const p = ptrs.get(e.pointerId); ptrs.delete(e.pointerId);
    if (!ptrs.size) {
      cv.classList.remove('dragging');
      if (gesture && gesture.marker && gesture.moved) { const [lat, lon] = d2ll(...toMap(p[0], p[1])); setPoint(gesture.marker, lat, lon, null, false); }
      else if (gesture && !gesture.moved && e.type === 'pointerup') {
        const [lat, lon] = d2ll(...toMap(p[0], p[1]));
        const k = S.armed;
        setPoint(k, lat, lon, null, false);
        if (k === 'A') arm('B');
      }
      gesture = null;
    }
  }
  cv.addEventListener('pointerup', endPtr);
  cv.addEventListener('pointercancel', endPtr);
  cv.addEventListener('wheel', (e) => { e.preventDefault(); const p = local(e); zoomAt(Math.exp(-e.deltaY * 0.0016), p[0], p[1]); }, { passive: false });
  cv.addEventListener('dblclick', (e) => { const p = local(e); zoomAt(1.8, p[0], p[1]); });
  $('z-in').addEventListener('click', () => zoomAt(1.5, W / 2, H / 2));
  $('z-out').addEventListener('click', () => zoomAt(1 / 1.5, W / 2, H / 2));
  $('z-home').addEventListener('click', () => home());

  // ---------------------------------------------------------------- 출발·도착
  function setPoint(k, lat, lon, name, fit) {
    S[k] = { lat, lon, name: name || null };
    $('q-' + k).value = name || '지도에서 고른 곳';
    // 다른 쪽이 너무 멀면 비우고 그쪽을 고르게 한다
    const o = k === 'A' ? 'B' : 'A', lab = (x) => x === 'A' ? '출발지' : '도착지';
    if (!inSeoul(S[k])) note(lab(k) + '가 서울 밖이에요. 서울 안에서만 찾을 수 있어요.');
    else if (S[o] && O.distM(S[k], S[o]) > MAXD) {
      S[o] = null; $('q-' + o).value = ''; arm(o);
      note('새 ' + lab(k) + '에서 ' + (MAXD / 1000) + 'km 넘게 떨어져서 ' + lab(o) + '를 비웠어요. ' + lab(o) + '를 다시 골라 주세요.');
    }
    S.res = null; routeDraw = null;
    if (fit) { if (S.A && S.B) home(); else { const q = ll2d(lat, lon); V.cx = q[0]; V.cy = q[1]; V.s = Math.max(V.s, 0.6); } }
    draw(); schedule();
  }
  function arm(k) { S.armed = k; $('arm-A').setAttribute('aria-pressed', String(k === 'A')); $('arm-B').setAttribute('aria-pressed', String(k === 'B')); }
  $('arm-A').addEventListener('click', () => arm('A'));
  $('arm-B').addEventListener('click', () => arm('B'));
  $('swap').addEventListener('click', () => {
    const a = S.A; S.A = S.B; S.B = a;
    for (const k of ['A', 'B']) $('q-' + k).value = S[k] ? (S[k].name || '지도에서 고른 곳') : '';
    S.res = null; routeDraw = null; draw(); schedule();
  });

  // 검색: 지하철역·장소 이름은 바로, 그 밖은 OpenStreetMap(Nominatim)에서 찾는다
  const keyOf = (s) => String(s || '').replace(/\s+/g, '').replace(/\(.*?\)/g, '').replace(/역$/, '').toLowerCase();
  const PLACES = SEOUL.stations.map(s => ({ name: s[0], lat: s[1], lon: s[2], kind: '지하철역', key: keyOf(s[0]) }))
    .concat(SEOUL.places.map(s => ({ name: s[0], lat: s[1], lon: s[2], kind: '장소', key: keyOf(s[0]) })));
  function shortAddr(dn) {
    const parts = String(dn || '').split(',').map(s => s.trim()).filter(s => s && !/^\d+$/.test(s) && s !== '대한민국' && s !== '서울특별시' && s !== '서울');
    return parts.slice(1, 4).reverse().join(' ');
  }
  function setupSearch(k) {
    const inp = $('q-' + k), list = $('sug-' + k);
    let items = [], active = -1, seq = 0;
    const close = () => { list.hidden = true; inp.setAttribute('aria-expanded', 'false'); inp.removeAttribute('aria-activedescendant'); };
    function render() {
      list.innerHTML = items.map((it, i) => '<li role="option" id="sug-' + k + '-' + i + '" data-i="' + i + '" aria-selected="' + (i === active) + '"' + (it.kind ? ' class="' + it.kind + '"' : '') + '><b>' + esc(it.name) + '</b><span>' + esc(it.sub || '') + '</span></li>').join('');
      list.hidden = !items.length; inp.setAttribute('aria-expanded', String(!!items.length));
      if (active >= 0) inp.setAttribute('aria-activedescendant', 'sug-' + k + '-' + active); else inp.removeAttribute('aria-activedescendant');
    }
    function suggest() {
      const raw = inp.value.trim(), q = keyOf(raw);
      if (!q) { items = []; render(); return; }
      items = PLACES.filter(p => p.key.includes(q))
        .sort((a, b) => (Number(b.key.startsWith(q)) - Number(a.key.startsWith(q))) || a.name.length - b.name.length)
        .slice(0, 7).map(p => ({ name: p.name, sub: p.kind, lat: p.lat, lon: p.lon }));
      items.push({ name: '‘' + raw + '’ 장소 찾기', sub: 'OpenStreetMap 검색', kind: 'search', q: raw });
      active = 0; render();
    }
    async function nominatim(q) {
      const my = ++seq;
      items = [{ name: '찾고 있어요…', sub: q, kind: 'wait' }]; active = -1; render();
      try {
        const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&accept-language=ko&countrycodes=kr&bounded=1&viewbox=126.76,37.72,127.19,37.41&q=' + encodeURIComponent(q);
        const r = await fetch(url);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        if (my !== seq) return;
        items = j.map(x => ({ lat: +x.lat, lon: +x.lon, name: x.name || String(x.display_name || '').split(',')[0], sub: shortAddr(x.display_name) }))
          .filter(x => isFinite(x.lat) && inSeoul(x)).slice(0, 6);
        if (!items.length) items = [{ name: '서울 안에서 못 찾았어요', sub: '다른 이름으로 찾거나 지도를 눌러 고르세요', kind: 'wait' }];
        active = items[0].kind ? -1 : 0; render();
      } catch (e) {
        if (my !== seq) return;
        items = [{ name: '검색 서버에 닿지 않아요', sub: '지도를 눌러서 고를 수 있어요', kind: 'wait' }]; active = -1; render();
      }
    }
    function choose(i) {
      const it = items[i]; if (!it || it.kind === 'wait') return;
      if (it.kind === 'search') { nominatim(it.q); return; }
      items = []; close(); seq++;
      setPoint(k, it.lat, it.lon, it.name, true);
      inp.blur();
      if (k === 'A' && !S.B) { arm('B'); $('q-B').focus(); }
    }
    inp.addEventListener('input', suggest);
    inp.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'ArrowDown' && items.length) { active = Math.min(items.length - 1, active + 1); render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp' && items.length) { active = Math.max(0, active - 1); render(); e.preventDefault(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (items.length && active >= 0) choose(active); else if (inp.value.trim()) nominatim(inp.value.trim()); }
      else if (e.key === 'Escape') { close(); }
    });
    list.addEventListener('mousedown', (e) => e.preventDefault());
    list.addEventListener('click', (e) => { const li = e.target.closest('[data-i]'); if (li) choose(+li.dataset.i); });
    // 누르면 비워서 바로 새로 칠 수 있게(지금 값은 흐린 안내 글자로 보여 준다)
    const shown = () => S[k] ? (S[k].name || '지도에서 고른 곳') : '';
    inp.addEventListener('focus', () => { arm(k); if (inp.value === shown()) { inp.placeholder = shown() || '역 이름이나 장소 검색'; inp.value = ''; } });
    inp.addEventListener('blur', () => setTimeout(() => { close(); inp.placeholder = '역 이름이나 장소 검색'; if (document.activeElement !== inp) inp.value = shown(); }, 180));
  }
  setupSearch('A'); setupSearch('B');

  $('gps').addEventListener('click', () => {
    const btn = $('gps');
    if (!navigator.geolocation) { note('이 브라우저는 위치를 알려 주지 않아요.'); return; }
    btn.disabled = true; btn.textContent = '위치 확인 중…';
    navigator.geolocation.getCurrentPosition((pos) => {
      btn.disabled = false; btn.textContent = '내 위치를 출발지로';
      const p = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      if (!inSeoul(p)) { note('지금 위치가 서울 밖이에요. 서울 안에서만 찾을 수 있어요.'); return; }
      setPoint('A', p.lat, p.lon, '내 위치', true); arm('B');
    }, (err) => {
      btn.disabled = false; btn.textContent = '내 위치를 출발지로';
      note(err && err.code === 1 ? '위치 권한이 꺼져 있어요. 브라우저 설정에서 켜거나 검색으로 고르세요.' : '위치를 가져오지 못했어요.');
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  });
  function note(t) { $('od-note').textContent = t; clearTimeout(note.t); note.t = setTimeout(() => { $('od-note').textContent = ''; }, 6000); }

  $('examples').innerHTML = EXAMPLES.map((x, i) => '<button type="button" class="chip" data-ex="' + i + '">' + esc(x.label) + '</button>').join('');
  $('examples').addEventListener('click', (e) => { const b = e.target.closest('[data-ex]'); if (b) useExample(+b.dataset.ex); });
  function useExample(i) {
    const x = EXAMPLES[i];
    S.A = { lat: x.a.lat, lon: x.a.lon, name: x.a.name }; S.B = { lat: x.b.lat, lon: x.b.lon, name: x.b.name };
    $('q-A').value = x.a.name; $('q-B').value = x.b.name;
    if (x.mode && x.mode !== S.mode) { S.mode = x.mode; S.sel = null; renderSeasonTabs(); }
    S.res = null; routeDraw = null; arm('B'); home(); schedule(0);
  }

  // ---------------------------------------------------------------- 모드
  function renderSeasonTabs() {
    const season = seasonOfMode(S.mode);
    $('seasons').innerHTML = Object.entries(SEASONS).map(([k, v]) => '<button type="button" role="tab" data-season="' + k + '" aria-selected="' + (k === season) + '" class="season s-' + k + '">' + v.label + '</button>').join('');
    const modes = SEASONS[season].modes;
    $('submodes').innerHTML = modes.length > 1 ? modes.map(m => '<button type="button" class="chip" data-mode="' + m + '" aria-pressed="' + (m === S.mode) + '">' + MODE_UI[m].chip + '</button>').join('') : '';
    $('season-note').textContent = MODE_UI[S.mode].note;
    const today = new Date();
    $('today-note').textContent = S.mode === defaultMode(today) ? '오늘(' + (today.getMonth() + 1) + '월 ' + today.getDate() + '일)에 맞춰 ' + SEASONS[season].label + ' 모드로 골라 뒀어요.' : '';
    $('time-row').hidden = S.mode !== 'summer-shade';
    $('winter-row').hidden = S.mode !== 'winter-sun';
    const capPct = Math.round((S.cap[S.mode] != null ? S.cap[S.mode] : E.MODES[S.mode].cap) * 100);
    $('cap').value = capPct; $('cap-out').textContent = '+' + capPct + '%';
    if (!needsBld(S.mode)) $('sun-info').textContent = '';
    renderLegend();
  }
  $('seasons').addEventListener('click', (e) => { const b = e.target.closest('[data-season]'); if (!b) return; setMode(SEASONS[b.dataset.season].modes[0]); });
  $('submodes').addEventListener('click', (e) => { const b = e.target.closest('[data-mode]'); if (!b) return; setMode(b.dataset.mode); });
  function setMode(m) { S.mode = m; S.sel = null; renderSeasonTabs(); updateShadowLayer(); draw(); schedule(); }
  $('cap').addEventListener('input', (e) => { S.cap[S.mode] = +e.target.value / 100; $('cap-out').textContent = '+' + e.target.value + '%'; schedule(); });
  function fmtHour(h) { const hh = Math.floor(h), mm = Math.round((h - hh) * 60); return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0'); }
  $('hour').addEventListener('input', (e) => { S.hour = +e.target.value; $('hour-out').textContent = fmtHour(S.hour); syncTimeChips(); updateShadowLayer(); schedule(250); });
  $('time-chips').addEventListener('click', (e) => { const b = e.target.closest('[data-h]'); if (!b) return; S.hour = +b.dataset.h; $('hour').value = S.hour; $('hour-out').textContent = fmtHour(S.hour); syncTimeChips(); updateShadowLayer(); schedule(); });
  function syncTimeChips() { for (const b of $('time-chips').querySelectorAll('[data-h]')) b.setAttribute('aria-pressed', String(+b.dataset.h === S.hour)); }
  $('whour').addEventListener('input', (e) => { S.winterHour = +e.target.value; $('whour-out').textContent = fmtHour(S.winterHour); updateShadowLayer(); });

  function updateShadowLayer() {
    shadowPath = null; layerVer++;
    const A = cur;
    if (!A || !needsBld(S.mode) || !A.hasBld) { draw(); return; }
    const [lat, lon] = A.toLL(0, 0);
    let sun, ever = false;
    if (S.mode === 'summer-shade') { const h = Math.floor(S.hour), mi = Math.round((S.hour - h) * 60); sun = E.sunPos(E.kst(E.SUMMER.y, E.SUMMER.m, E.SUMMER.d, h, mi), lat, lon); }
    else { sun = E.sunPos(E.kst(E.WINTER.y, E.WINTER.m, E.WINTER.d, S.winterHour, 0), lat, lon); ever = true; }
    const sp = E.shadowPolys(A, sun, { evergreenOnly: ever });
    if (sp.night) { shadowPath = new Path2D(); shadowPath.rect(-1e5, -1e5, 2e5, 2e5); }
    else { const p = new Path2D(); for (const poly of sp.polys) addPoly(p, poly); shadowPath = p; }
    $('sun-info').textContent = '해 높이 ' + Math.round(sun.alt) + '° · 방위 ' + Math.round(sun.az) + '°';
    draw();
  }
  function renderLegend() {
    const groups = treeGroups(S.mode);
    const items = groups.map(g => '<span class="lg"><i class="dot" style="background:var(' + cssVar(g[0]) + ')"></i>' + g[2] + '</span>');
    items.unshift('<span class="lg"><i class="ln" style="background:var(--short)"></i>최단</span><span class="lg"><i class="ln" style="background:var(--pick)"></i>' + E.MODES[S.mode].label + '</span>');
    if (needsBld(S.mode)) items.push('<span class="lg"><i class="sq"></i>그림자</span>');
    if (S.mode === 'winter-sun') items.push('<span class="lg"><i class="ln ice"></i>응달 구간</span>');
    if (cur && cur.kind === 'osm') items.push('<span class="lg"><i class="ln cov"></i>길 정보를 받은 범위</span>');
    $('legend').innerHTML = items.join('');
  }
  const cssVar = (k) => '--' + k.replace(/^t([A-Z])/, (m, c) => 't-' + c.toLowerCase()).replace(/[A-Z]/g, c => '-' + c.toLowerCase());

  // ---------------------------------------------------------------- 지역 고르기·받기
  function presetCovers(id, a, b) {
    const p = PRESETS[id], m = 120;
    return [a, b].every(q => { const x = (q.lon - p.lon0) * p.kx, y = (q.lat - p.lat0) * p.ky; return x > p.box[0] + m && x < p.box[2] - m && y > p.box[1] + m && y < p.box[3] - m; });
  }
  // 이미 받은 범위가 이번 출발·도착에 필요한 띠를 덮으면 다시 쓴다
  function findArea(a, b) {
    const need = O.corridor(a, b, 0, true).ll;
    for (const A of areas) {
      if (A.kind === 'preset' ? presetCovers(A.presetId, a, b) : O.covers(A.cov, need)) return A;
    }
    return null;
  }
  async function loadPreset(id) {
    const p = PRESETS[id];
    window.SW_DATA = window.SW_DATA || {};
    if (!window.SW_DATA[id]) await loadScript(p.file);
    const raw = JSON.parse(await gunzipB64(window.SW_DATA[id]));
    const A = E.decodeArea(raw);
    A.kind = 'preset'; A.presetId = id; A.hasBld = true;
    const c = [[p.box[0], p.box[1]], [p.box[2], p.box[1]], [p.box[2], p.box[3]], [p.box[0], p.box[3]]];
    A.cov = c.map(([x, y]) => A.toLL(x, y));
    areas.unshift(A);
    return A;
  }
  let pending = null;
  function trimAreas() {
    let n = 0;
    for (let i = 0; i < areas.length; i++) if (areas[i].kind === 'osm' && ++n > 3 && areas[i] !== cur) { areas.splice(i, 1); i--; }
  }
  async function loadOsm(a, b) {
    const cor = O.corridor(a, b);
    if (pending && O.covers(pending.cov, O.corridor(a, b, 0, true).ll)) return pending.promise;
    if (pending) pending.ctl.abort();
    const ctl = new AbortController();
    const t0 = Date.now();
    const promise = (async () => {
      progress('OpenStreetMap에서 길 정보를 받고 있어요', t0, cor.d);
      const bb = O.bboxOf(cor.ll, 40), keys = O.cellKeys(SEOUL.grid, bb).filter(k => SEOUL.cells.includes(k));
      const [hw] = await Promise.all([
        O.overpass(O.qWays(cor.ll), { signal: ctl.signal, onRetry: (n, why) => progress('서버가 바빠서 다시 묻고 있어요 (' + why + ', ' + n + '번째)', t0, cor.d) }),
        ensureCells(keys)
      ]);
      progress('가로수를 길에 붙이고 있어요', t0, cor.d);
      await nextFrame();
      const trees = O.treesIn(keys.map(k => window.SW_TREES[k]), bb);
      const A = O.buildArea(E, { id: 'osm' + (++osmSeq), name: '고른 범위', cor, hw, trees });
      if (!A.G.E) throw Object.assign(new Error('이 범위에는 걸을 수 있는 길 정보가 없어요'), { name: 'EmptyArea' });
      A.ends = [{ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon }];
      A.loadMs = Date.now() - t0;
      areas.unshift(A); trimAreas();
      return A;
    })();
    pending = { cov: cor.ll, promise, ctl };
    try { return await promise; } finally { if (pending && pending.promise === promise) pending = null; }
  }
  async function loadBuildings(A) {
    if (!A.bldPromise) {
      const t0 = Date.now(), ll = O.corridor(A.ends[0], A.ends[1], 120).ll;
      A.bldPromise = (async () => {
        progress('그림자 계산에 쓸 건물 정보를 받고 있어요', t0);
        const j = await O.overpass(O.qBlds(ll), { onRetry: (n, why) => progress('서버가 바빠서 다시 묻고 있어요 (' + why + ', ' + n + '번째)', t0) });
        O.attachBuildings(E, A, j);
        A.P = null;
      })();
      A.bldPromise.catch((e) => { A.bldPromise = null; e.what = '건물 정보'; });
    }
    return A.bldPromise;
  }
  const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));

  // ---------------------------------------------------------------- 계산
  let timer = null, runId = 0, tick = null;
  function schedule(delay) { clearTimeout(timer); timer = setTimeout(run, delay == null ? 60 : delay); }
  function setBusy(on, text) { S.busy = on; $('busy').hidden = !on; if (text) $('busy-txt').textContent = text; }
  function progress(text, t0, d) {
    clearInterval(tick);
    const paint = () => {
      const sec = Math.round((Date.now() - t0) / 1000);
      setBusy(true, text + (sec >= 2 ? ' · ' + sec + '초' : ''));
      $('result').innerHTML = '<div class="loading"><span class="spin"></span><p>' + esc(text) + (sec >= 2 ? ' <span class="mono">' + sec + '초</span>' : '') + '</p></div>' +
        '<p class="fine">처음 고른 범위는 공개 OpenStreetMap 서버에서 받아요. 보통 5~30초 걸리고, 받은 범위 안에서는 바로 계산해요.' + (d > 2200 ? ' 거리가 멀수록 오래 걸려요.' : '') + '</p>';
    };
    paint(); tick = setInterval(paint, 1000);
  }
  function stopProgress() { clearInterval(tick); tick = null; setBusy(false); }
  function showMsg(html, cls) {
    stopProgress(); routeDraw = null; S.res = null; draw();
    $('result').innerHTML = '<p class="' + (cls || 'empty') + '">' + html + '</p>';
  }
  function setCur(A) {
    if (cur !== A) { cur = A; shadowPath = null; renderLegend(); }
    $('area-note').textContent = areaNote(A);
  }
  function areaNote(A) {
    const t = A.trees.n.toLocaleString('ko-KR');
    if (A.kind === 'preset') return '미리 받아 둔 ' + PRESETS[A.presetId].label + ' 데이터 · 가로수 ' + t + '그루';
    const day = A.osm ? A.osm.slice(0, 10).replace(/-/g, '.') : '';
    return 'OpenStreetMap' + (day ? ' ' + day + ' 기준' : '') + ' 길 ' + A.wayCount.toLocaleString('ko-KR') + '개 · 가로수 ' + t + '그루' + (A.loadMs ? ' · 받는 데 ' + Math.max(1, Math.round(A.loadMs / 1000)) + '초' : '');
  }
  function snapTo(A, p) {
    const [x, y] = A.toXY(p.lat, p.lon), n = E.nearestNode(A, x, y);
    if (n < 0) return null;
    const [lat, lon] = A.toLL(A.G.X[n], A.G.Y[n]);
    return { n, lat, lon, off: Math.hypot(A.G.X[n] - x, A.G.Y[n] - y) };
  }

  async function run() {
    const id = ++runId;
    if (!S.A || !S.B) { stopProgress(); renderResult(null); return; }
    const d = O.distM(S.A, S.B);
    for (const k of ['A', 'B']) if (!inSeoul(S[k])) return showMsg((k === 'A' ? '출발지' : '도착지') + '가 서울 밖이에요. 가로수 데이터가 서울시 것이라 서울 안에서만 찾을 수 있어요.', 'warn');
    if (d < MIND) return showMsg('출발지와 도착지가 너무 가까워요. 조금 떨어진 곳을 골라 주세요.', 'warn');
    if (d > MAXD) return showMsg('두 곳이 직선으로 ' + (d / 1000).toFixed(1) + 'km 떨어져 있어요. 걷기 경로는 직선 ' + (MAXD / 1000) + 'km(걸어서 1시간 안팎) 안에서만 찾아요.', 'warn');
    let A;
    try {
      A = findArea(S.A, S.B);
      if (!A) {
        const pid = Object.keys(PRESETS).find(k => presetCovers(k, S.A, S.B) && !areas.some(x => x.presetId === k));
        if (pid) { progress('미리 받아 둔 ' + PRESETS[pid].label + ' 데이터를 여는 중이에요', Date.now()); A = await loadPreset(pid); }
        else A = await loadOsm(S.A, S.B);
      }
      if (id !== runId) return;
      if (needsBld(S.mode) && !A.hasBld) { await loadBuildings(A); if (id !== runId) return; }
    } catch (err) {
      if (id !== runId || err.name === 'AbortError') return;
      console.error(err);
      stopProgress(); routeDraw = null; S.res = null; draw();
      const why = err.name === 'EmptyArea' ? esc(err.message) : (err.what || '길 정보') + '를 받지 못했어요' + (err.message ? ' (' + esc(err.message) + ')' : '') + '. 공개 서버가 바쁠 때가 있어요. 잠시 뒤 다시 해 보세요.';
      $('result').innerHTML = '<p class="err">' + why + '</p><p><button type="button" class="linkbtn" id="retry">다시 시도</button></p>';
      $('retry').addEventListener('click', () => schedule(0));
      return;
    }
    clearInterval(tick); tick = null;
    setCur(A);
    const sa = snapTo(A, S.A), sb = snapTo(A, S.B);
    if (!sa || !sb) return showMsg('가까운 곳에 걸을 수 있는 길이 없어요. 길 위나 길 가까이를 골라 주세요.', 'warn');
    const moved = [];
    if (sa.off > 80) moved.push('출발지 ' + Math.round(sa.off) + 'm');
    if (sb.off > 80) moved.push('도착지 ' + Math.round(sb.off) + 'm');
    S.A = Object.assign({}, S.A, { lat: sa.lat, lon: sa.lon }); S.B = Object.assign({}, S.B, { lat: sb.lat, lon: sb.lon });
    if (!shadowPath && needsBld(S.mode)) updateShadowLayer();
    const needShade = (S.mode === 'summer-shade' && !A.cache['shade' + S.hour]) || (S.mode === 'winter-sun' && !A.cache.winter);
    setBusy(needShade, S.mode === 'winter-sun' ? '9~16시 그림자로 하루 볕을 계산하고 있어요' : '그림자를 계산하고 있어요');
    if (needShade) $('result').innerHTML = '<div class="loading"><span class="spin"></span><p>' + esc($('busy-txt').textContent) + '</p></div>';
    await nextFrame();
    if (id !== runId) return;
    try {
      const t0 = performance.now();
      const capv = S.cap[S.mode] != null ? S.cap[S.mode] : E.MODES[S.mode].cap;
      const res = E.plan(A, sa.n, sb.n, S.mode, { hour: S.hour, cap: capv });
      setBusy(false);
      if (!res) return showMsg('두 곳을 잇는 걸을 수 있는 길을 못 찾았어요. 강이나 큰길 건너편이면 조금 옮겨 보세요.', 'warn');
      res.ms = performance.now() - t0; res.area = A; res.moved = moved;
      S.res = res; S.sel = null;
      renderResult(res);
      writeHash();
    } catch (err) {
      console.error(err); setBusy(false);
      $('result').innerHTML = '<p class="err">계산하다 문제가 생겼어요: ' + esc(err.message || err) + '</p>';
    }
  }

  // ---------------------------------------------------------------- 결과
  const fmtM = (m) => Math.round(m).toLocaleString('ko-KR') + 'm';
  const mins = (m) => Math.max(1, Math.round(m / WALK));
  function metricText(mode, m, big) {
    const M = E.MODES[mode];
    if (M.kind === 'trees') return big ? m.v + '<small>그루</small>' : M.what + ' ' + m.v + '그루';
    if (M.kind === 'avoid') return big ? m.v + '<small>그루</small>' : '은행 암나무 ' + m.v + '그루';
    if (M.kind === 'shade') return big ? Math.round(m.v * 100) + '<small>%</small>' : '그늘 ' + Math.round(m.v * 100) + '%';
    if (M.kind === 'sun') return big ? Math.round(m.v * 100) + '<small>%</small>' : '응달 ' + Math.round(m.v * 100) + '%';
  }
  function metricLabel(mode) {
    const M = E.MODES[mode];
    if (M.kind === 'trees') return '15m 안 ' + M.what;
    if (M.kind === 'avoid') return '15m 안 은행 암나무';
    if (M.kind === 'shade') return '그늘진 비율(' + fmtHour(S.hour) + ')';
    return '응달 비율(하루 볕 2시간 미만)';
  }
  function speciesBreak(A, r, max) {
    const tr = A.trees, cnt = new Map();
    for (const i of r.m.near || E.treesNear(A, r, 15)) { const nm = A.species[tr.sp[i]]; cnt.set(nm, (cnt.get(nm) || 0) + 1); }
    return [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, max || 3).map(([k, v]) => esc(k) + ' ' + v).join(' · ');
  }
  function routeRoadsFor(A, r, flag) {
    const tr = A.trees, cnt = new Map();
    for (const i of (r.m.near || [])) if (tr.flags[i] & flag) { const rd = A.roads[tr.road[i]] || '기타'; cnt.set(rd, (cnt.get(rd) || 0) + 1); }
    return [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => esc(k) + ' ' + v).join(' · ');
  }
  function card(A, r, kind, res) {
    const mode = res.mode, M = E.MODES[mode], base = res.base, isPick = kind === 'pick', delta = r.len - base.len;
    const via = E.viaNames(A, r);
    let sub = '';
    if (M.kind === 'trees' || M.kind === 'avoid') {
      const roads = routeRoadsFor(A, r, M.flag);
      sub = (roads ? '<p class="sub">' + M.what + ': ' + roads + '</p>' : '') + '<p class="sub">15m 안 많은 나무: ' + (speciesBreak(A, r, 3) || '없음') + '</p>';
      if (M.avoid) sub += '<p class="sub">은행 암나무 ' + (r.m.bad || 0) + '그루</p>';
    } else if (M.kind === 'sun') sub = '<p class="sub">하루 평균 볕 ' + r.m.sunH.toFixed(1) + '시간 (9~16시 기준)</p>';
    else if (M.kind === 'shade') sub = '<p class="sub">' + fmtHour(S.hour) + ' 기준, 그늘진 쪽 보도로 걸을 때</p>';
    return '<div class="card ' + (isPick ? 'pick' : 'short') + '">' +
      '<h3><i class="ln" style="background:var(' + (isPick ? '--pick' : '--short') + ')"></i>' + (isPick ? (res.manual ? '고른 경로' : M.label) : '최단 경로') + '</h3>' +
      (via.length ? '<p class="via">' + via.map(esc).join(' → ') + '</p>' : '') +
      '<div class="nums"><span class="num">' + fmtM(r.len).replace('m', '<small>m</small>') + '</span><span class="num">' + mins(r.len) + '<small>분</small></span>' + (isPick && delta > 0.5 ? '<span class="delta">+' + Math.round(delta) + 'm · ' + (Math.round(delta / WALK) ? '+' + Math.round(delta / WALK) + '분' : '1분 안') + '</span>' : '') + '</div>' +
      '<div class="metric"><span class="mlabel">' + metricLabel(mode) + '</span><span class="mval">' + metricText(mode, r.m, true) + '</span></div>' + sub + '</div>';
  }
  function headline(res) {
    const A = res.area, M = E.MODES[res.mode], b = res.base, p = res.sel || res.pick;
    const d = Math.round(p.len - b.len), dm = Math.round(d / WALK);
    if (M.kind === 'avoid' && b.m.v === 0 && !A.trees.flags.some(f => f & E.F.FEMALE)) return '<p class="verdict warn">이 범위의 가로수 데이터에는 은행 암나무 표시가 없어요(자치구마다 표시 방식이 달라요). 은행나무 전체를 보려면 단풍길을 써 보세요.</p>';
    if (p === b) {
      if (M.kind === 'trees' && b.m.v >= 10) return '<p class="verdict">최단 경로가 곧 ' + M.label + '이에요. 그대로 걸어도 ' + M.what + ' ' + b.m.v + '그루를 지나요.</p>';
      if (M.kind === 'avoid' && b.m.v === 0) return '<p class="verdict">최단 경로에 은행 암나무가 없어요. 그대로 걸으면 돼요.</p>';
      if (M.kind === 'trees' && b.m.v === 0 && res.cands.every(c => c.m.v === 0)) return '<p class="verdict">이 근처 가로수에는 ' + M.what + '가 거의 없어요. 다른 계절 모드나 다른 길을 골라 보세요.</p>';
      return '<p class="verdict">우회 한도 안에서는 더 나은 길이 없어요. 최단 경로로 가세요.' + (res.cands.length > 1 ? ' 한도를 늘리면 다른 길이 나와요.' : '') + '</p>';
    }
    const from = metricText(res.mode, b.m, false), to = metricText(res.mode, p.m, false).replace(/^[^0-9]*/, '');
    const gain = '<b>+' + d + 'm(' + (dm ? '약 ' + dm + '분' : '1분 안') + ')</b> 더 걸으면 ' + from + ' → <b>' + to + '</b>';
    if (!res.verdict.worth && !res.sel) return '<p class="verdict">' + gain + '. 차이가 작아서 최단 경로로 가도 괜찮아요.</p>';
    return '<p class="verdict good">' + gain + '</p>';
  }
  function chart(res) {
    const cands = res.cands, M = E.MODES[res.mode], b = res.base, p = res.sel || res.pick;
    if (cands.length < 2) return '';
    const pct = M.kind === 'shade' || M.kind === 'sun';
    const val = (c) => pct ? c.m.v * 100 : c.m.v;
    const maxV = Math.max(1, ...cands.map(val));
    const capLen = b.len * (1 + res.cap);
    const rows = cands.slice(0, 8).map((c, i) => {
      const d = c.len - b.len, over = c.len > capLen + 1e-9, v = val(c);
      const lab = c === b ? '최단' : '+' + Math.round(d) + 'm';
      const sub = c === b ? fmtM(b.len) : '+' + Math.round(d / b.len * 100) + '%';
      return '<li><button type="button" class="cand' + (c === p ? ' on' : '') + (over ? ' over' : '') + '" data-i="' + i + '" aria-pressed="' + (c === p) + '">' +
        '<span class="lab"><b>' + lab + '</b> ' + sub + '</span><span class="track"><span style="width:' + (100 * v / maxV).toFixed(1) + '%"></span></span>' +
        '<span class="v">' + (pct ? Math.round(v) + '%' : v + '그루') + '</span></button></li>';
    }).join('');
    const what = M.kind === 'avoid' ? '은행 암나무(적을수록 좋아요)' : M.kind === 'sun' ? '응달(적을수록 좋아요)' : M.kind === 'shade' ? '그늘' : M.what;
    return '<figure class="cands"><figcaption>더 걸을수록 달라지는 ' + what + ' · 눌러서 지도에서 보기</figcaption><ol>' + rows + '</ol>' +
      (cands.some(c => c.len > capLen + 1e-9) ? '<p class="fine">흐린 줄은 지금 우회 한도(+' + Math.round(res.cap * 100) + '%) 밖의 경로예요.</p>' : '') + '</figure>';
  }
  function renderResult(res) {
    const box = $('result');
    if (!res) { box.innerHTML = '<p class="empty">출발지와 도착지를 검색하거나 지도를 눌러 정하세요.</p>'; routeDraw = null; draw(); return; }
    const A = res.area, p = res.sel || res.pick;
    box.innerHTML = headline(res) + '<div class="cards">' + card(A, res.base, 'base', res) + (p !== res.base ? card(A, p, 'pick', Object.assign({}, res, { manual: !!res.sel })) : '') + '</div>' + chart(res) +
      '<p class="fine">계산 ' + Math.round(res.ms) + 'ms · 출발·도착은 가장 가까운 보행로 지점에 맞췄어요' + (res.moved.length ? '(' + res.moved.join(', ') + ' 옮김)' : '') + '.' + (EMBED ? '' : ' <button type="button" class="linkbtn" id="copy-link">이 경로 링크 복사</button>') + '</p>';
    const cl = $('copy-link');
    if (cl) cl.addEventListener('click', async () => { writeHash(); try { await navigator.clipboard.writeText(location.href); cl.textContent = '복사했어요'; } catch (e) { cl.textContent = '복사가 막혀 있어요. 주소창 링크를 쓰세요'; } setTimeout(() => { cl.textContent = '이 경로 링크 복사'; }, 2500); });
    const cl2 = box.querySelector('.cands');
    if (cl2) cl2.addEventListener('click', (e) => { const c = e.target.closest('[data-i]'); if (!c) return; const r = res.cands[+c.dataset.i]; res.sel = r === res.pick ? null : r; renderResult(res); });
    const mk = (r) => { const path = new Path2D(); const pts = E.routeCoords(A, r); path.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]); return path; };
    routeDraw = [{ path: mk(res.base), color: C.short, caseColor: C.shortCase, w: 4.5 }];
    if (p !== res.base) routeDraw.push({ path: mk(p), color: C.pick, caseColor: C.pickCase, w: 5 });
    if (res.mode === 'winter-sun') {
      const ctxW = res.ctx, G = A.G;
      routeDraw.forEach((item, k) => {
        const r = k === 0 ? res.base : p, ice = new Path2D(); let any = false;
        for (const e of r.edges) if (ctxW.ice[e] >= 0.5) { ice.moveTo(G.X[G.ea[e]], G.Y[G.ea[e]]); ice.lineTo(G.X[G.eb[e]], G.Y[G.eb[e]]); any = true; }
        if (any) item.ice = ice;
      });
    }
    draw();
  }

  // ---------------------------------------------------------------- 주소창 상태
  const f6 = (v) => (Math.round(v * 1e6) / 1e6).toString();
  function writeHash() {
    if (!S.A || !S.B) return;
    const q = new URLSearchParams();
    q.set('f', f6(S.A.lat) + ',' + f6(S.A.lon)); q.set('t', f6(S.B.lat) + ',' + f6(S.B.lon));
    if (S.A.name) q.set('fn', S.A.name);
    if (S.B.name) q.set('tn', S.B.name);
    q.set('m', S.mode);
    if (S.mode === 'summer-shade') q.set('h', S.hour);
    if (S.cap[S.mode] != null) q.set('c', Math.round(S.cap[S.mode] * 100));
    try { history.replaceState(null, '', '#' + q.toString()); } catch (e) { /* 일부 환경은 막혀 있어요 */ }
  }
  function readHash() { try { return Object.fromEntries(new URLSearchParams(location.hash.slice(1)).entries()); } catch (e) { return {}; } }
  const parseLL = (s) => { if (!s) return null; const [lat, lon] = s.split(',').map(Number); return isFinite(lat) && isFinite(lon) ? { lat, lon } : null; };

  // ---------------------------------------------------------------- 시작
  function init() {
    readColors();
    const h = readHash();
    S.mode = E.MODES[h.m] ? h.m : defaultMode(new Date());
    if (h.h && isFinite(+h.h)) S.hour = Math.min(19.5, Math.max(7, +h.h));
    if (h.c && isFinite(+h.c)) S.cap[S.mode] = Math.min(0.8, Math.max(0, +h.c / 100));
    $('hour').value = S.hour; $('hour-out').textContent = fmtHour(S.hour); syncTimeChips();
    $('whour').value = S.winterHour; $('whour-out').textContent = fmtHour(S.winterHour);
    renderSeasonTabs();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onTheme = () => { readColors(); layerVer++; if (S.res) renderResult(S.res); draw(); };
    if (mq.addEventListener) mq.addEventListener('change', onTheme);
    const fa = parseLL(h.f), ta = parseLL(h.t);
    if (fa && ta) {
      S.A = Object.assign(fa, { name: h.fn || null }); S.B = Object.assign(ta, { name: h.tn || null });
      $('q-A').value = S.A.name || '지도에서 고른 곳'; $('q-B').value = S.B.name || '지도에서 고른 곳';
    } else {
      const x = EXAMPLES[0];
      S.A = { lat: x.a.lat, lon: x.a.lon, name: x.a.name }; S.B = { lat: x.b.lat, lon: x.b.lon, name: x.b.name };
      $('q-A').value = x.a.name; $('q-B').value = x.b.name;
    }
    arm('B');
    if ('ResizeObserver' in window) new ResizeObserver(resize).observe(cv); else window.addEventListener('resize', resize);
    resize();
    schedule(0);
  }
  window.SWApp = { S, get cur() { return cur; }, areas, setMode, setPoint, useExample, home, get V() { return V; }, setView(v) { Object.assign(V, v); draw(); }, drawNow, bump() { layerVer++; }, tiles, cells };
  init();
})();
