/* 계절길 화면: 지도 그리기, 입력, 결과 카드 */
(function () {
  'use strict';
  const E = window.SWEngine;
  const $ = (id) => document.getElementById(id);
  const WALK = 75; // m/분
  const EMBED = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();

  const AREAS = {
    jongno: { label: '종로·광화문', file: 'data/jongno.js', defA: '종각역', defB: '미국대사관' },
    yeouido: { label: '여의도', file: 'data/yeouido.js', defA: '여의도역', defB: '국회의사당역' }
  };
  const SEASONS = {
    spring: { label: '봄', modes: ['spring-cherry', 'spring-ipap', 'spring-all'] },
    summer: { label: '여름', modes: ['summer-shade'] },
    autumn: { label: '가을', modes: ['autumn-foliage', 'autumn-ginkgo'] },
    winter: { label: '겨울', modes: ['winter-sun'] }
  };
  const MODE_UI = {
    'spring-cherry': { chip: '벚꽃', note: '2026년 서울 벚꽃은 3월 29일에 피었어요(평년 4월 8일). 여의도 윤중로도 같은 날 피었어요. 피고 1~2주 사이가 절정이에요.' },
    'spring-ipap': { chip: '이팝꽃', note: '이팝나무는 보통 5월 초·중순에 흰 꽃이 펴요. 종로 일대에 특히 많아요.' },
    'spring-all': { chip: '봄꽃 전체', note: '산수유·매화(3월) → 벚꽃·목련·살구(4월) → 이팝·때죽·칠엽수(5월) 순서로 펴요.' },
    'summer-shade': { chip: '그늘길', note: '2026년 7월 20일 해 위치로 건물과 가로수 그림자를 계산해요. 차도는 그늘진 쪽 보도를 걷는다고 봐요.' },
    'autumn-foliage': { chip: '단풍길', note: '서울 도심 가로수 단풍은 보통 10월 말~11월 중순이에요. 은행 암나무 옆은 피해서 골라요.' },
    'autumn-ginkgo': { chip: '은행 냄새 피하기', note: '은행 열매는 보통 9월 말~11월에 떨어져요. 자치구 데이터에 암나무 표시가 있을 때만 쓸 수 있어요.' },
    'winter-sun': { chip: '볕길', note: '2027년 1월 15일 9~16시 그림자로 하루 볕 드는 시간을 계산해요. 하루 2시간도 해가 안 드는 곳을 응달(빙판 주의)로 봐요.' }
  };

  const S = { area: 'jongno', A: null, B: null, mode: null, hour: 18.5, winterHour: 12, cap: {}, armed: 'A', areas: {}, res: null, sel: null, busy: false };
  let cur = null; // 현재 지역 데이터

  // ---------------------------------------------------------------- 날짜 → 기본 계절
  function defaultMode(d) {
    const m = d.getMonth() + 1, day = d.getDate();
    if (m >= 3 && m <= 5) return (m === 3 || (m === 4 && day <= 20)) ? 'spring-cherry' : 'spring-ipap';
    if (m >= 6 && m <= 8) return 'summer-shade';
    if (m >= 9 && m <= 11) return 'autumn-foliage';
    return 'winter-sun';
  }
  const seasonOfMode = (mode) => E.MODES[mode].season;

  // ---------------------------------------------------------------- 데이터 읽기
  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error(src + ' 를 불러오지 못했어요')); document.head.appendChild(s); });
  }
  async function gunzipB64(b64) {
    const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    if (!('DecompressionStream' in window)) throw new Error('이 브라우저는 압축 해제를 지원하지 않아요. 최신 브라우저로 열어 주세요.');
    const ds = new DecompressionStream('gzip');
    return await new Response(new Blob([bin]).stream().pipeThrough(ds)).text();
  }
  async function getArea(id) {
    if (S.areas[id]) return S.areas[id];
    window.SW_DATA = window.SW_DATA || {};
    if (!window.SW_DATA[id]) await loadScript(AREAS[id].file);
    const raw = JSON.parse(await gunzipB64(window.SW_DATA[id]));
    const A = E.decodeArea(raw);
    buildPaths(A);
    A.places = A.stations.concat(A.landmarks);
    S.areas[id] = A;
    return A;
  }

  // ---------------------------------------------------------------- 색
  let C = {};
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    C = {
      land: v('--land'), park: v('--park'), water: v('--water'), bld: v('--bld'), bldEdge: v('--bld-edge'),
      road: v('--road'), roadCase: v('--road-case'), path: v('--path'), pathCase: v('--path-case'),
      shadow: v('--shadow'), label: v('--label'), halo: v('--halo'), ink: v('--ink'), muted: v('--muted'),
      short: v('--short'), shortCase: v('--short-case'), pick: v('--pick'), pickCase: v('--pick-case'), ice: v('--ice'),
      tFaint: v('--t-faint'), tCherry: v('--t-cherry'), tIpap: v('--t-ipap'), tSpring: v('--t-spring'), tGinkgo: v('--t-ginkgo'), tFemale: v('--t-female'),
      tRed: v('--t-red'), tZelk: v('--t-zelk'), tYellow: v('--t-yellow'), tGreen: v('--t-green'), tEver: v('--t-ever'), station: v('--station')
    };
  }

  // ---------------------------------------------------------------- 지도 경로(Path2D)
  function ccw(p) { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return s >= 0 ? p : p.slice().reverse(); }
  function addPoly(path, pts) { const p = ccw(pts); path.moveTo(p[0][0], p[0][1]); for (let i = 1; i < p.length; i++) path.lineTo(p[i][0], p[i][1]); path.closePath(); }
  function buildPaths(A) {
    const P = { park: new Path2D(), water: new Path2D(), blds: new Path2D(), road: {} };
    for (const g of A.green) addPoly(g.t === 'w' ? P.water : P.park, g.p);
    P.wl = A.wlines.map(l => { const p = new Path2D(); p.moveTo(l.p[0][0], l.p[0][1]); for (let i = 1; i < l.p.length; i++) p.lineTo(l.p[i][0], l.p[i][1]); return { w: l.w, p }; });
    for (const b of A.blds) if (!b.part) addPoly(P.blds, b.p);
    for (const t of ['M', 'm', 'f', 's', 'c']) P.road[t] = new Path2D();
    const G = A.G;
    for (const w of A.ways) { const p = P.road[w.t] || P.road.f; const ix = w.idx; p.moveTo(G.X[ix[0]], G.Y[ix[0]]); for (let i = 1; i < ix.length; i++) p.lineTo(G.X[ix[i]], G.Y[ix[i]]); }
    A.P = P;
    A.labels = streetLabels(A);
  }
  function streetLabels(A) {
    const G = A.G, best = new Map();
    for (const w of A.ways) {
      if (w.name < 0 || !(w.t === 'M' || w.t === 'm' || w.t === 'f')) continue;
      let L = 0; for (let i = 1; i < w.idx.length; i++) L += Math.hypot(G.X[w.idx[i]] - G.X[w.idx[i - 1]], G.Y[w.idx[i]] - G.Y[w.idx[i - 1]]);
      const nm = A.names[w.name], o = best.get(nm);
      if (!o || L > o.L) best.set(nm, { w, L });
    }
    const out = [];
    for (const [nm, o] of best) {
      if (o.L < 80) continue;
      const ix = o.w.idx; let acc = 0, half = o.L / 2;
      for (let i = 1; i < ix.length; i++) {
        const ax = G.X[ix[i - 1]], ay = G.Y[ix[i - 1]], bx = G.X[ix[i]], by = G.Y[ix[i]], sl = Math.hypot(bx - ax, by - ay);
        if (acc + sl >= half) { const u = (half - acc) / (sl || 1); out.push({ text: nm, x: ax + (bx - ax) * u, y: ay + (by - ay) * u, dx: bx - ax, dy: by - ay, L: o.L, pri: (o.w.t === 'M' ? 2 : o.w.t === 'm' ? 1 : 0) * 1e5 + o.L }); break; }
        acc += sl;
      }
    }
    return out.sort((a, b) => b.pri - a.pri);
  }

  // 모드별 나무 색 묶음
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
  function buildTreePaths(A, mode) {
    const key = 'tp_' + mode; if (A[key]) return A[key];
    const tr = A.trees, groups = treeGroups(mode);
    const faint = new Path2D(), paths = groups.map(() => new Path2D());
    for (let i = 0; i < tr.n; i++) {
      const f = tr.flags[i]; let g = -1;
      for (let k = groups.length - 1; k >= 0; k--) { const gf = groups[k][1]; if (gf === -1 || (f & gf)) { g = k; break; } }
      const p = g < 0 ? faint : paths[g];
      p.moveTo(tr.x[i], tr.y[i]); p.lineTo(tr.x[i] + 0.01, tr.y[i]);
    }
    return (A[key] = { faint, groups: groups.map((g, k) => ({ color: g[0], label: g[2], path: paths[k] })) });
  }

  // ---------------------------------------------------------------- 캔버스
  const cv = $('map'), ctx = cv.getContext('2d');
  let W = 0, H = 0, DPR = 1, V = { cx: 0, cy: 0, s: 1 }, HOMEV = null;
  let shadowPath = null, routeDraw = null, drawQueued = false;
  function resize() {
    const r = cv.getBoundingClientRect(); W = r.width; H = r.height;
    DPR = Math.min(window.devicePixelRatio || 1, 2.5);
    cv.width = Math.max(1, Math.round(W * DPR)); cv.height = Math.max(1, Math.round(H * DPR));
    if (cur && !HOMEV) home();
    draw();
  }
  function fitView(b, pad) {
    const w = b[2] - b[0], h = b[3] - b[1];
    const s = Math.min((W - 2 * pad) / w, (H - 2 * pad) / h);
    return { cx: (b[0] + b[2]) / 2, cy: (b[1] + b[3]) / 2, s: Math.max(0.05, s) };
  }
  function home() {
    if (!cur || !W) return;
    if (S.A && S.B) {
      const pad = 600 / Math.max(1, Math.hypot(S.A.x - S.B.x, S.A.y - S.B.y));
      const m = Math.max(140, Math.hypot(S.A.x - S.B.x, S.A.y - S.B.y) * 0.28);
      V = fitView([Math.min(S.A.x, S.B.x) - m, Math.min(S.A.y, S.B.y) - m, Math.max(S.A.x, S.B.x) + m, Math.max(S.A.y, S.B.y) + m], 24);
      void pad;
    } else V = fitView(cur.box, 16);
    HOMEV = { ...V };
    draw();
  }
  const toScreen = (x, y) => [W / 2 + (x - V.cx) * V.s, H / 2 - (y - V.cy) * V.s];
  const toMap = (sx, sy) => [V.cx + (sx - W / 2) / V.s, V.cy - (sy - H / 2) / V.s];
  function mapTransform() { ctx.setTransform(V.s * DPR, 0, 0, -V.s * DPR, (W / 2 - V.cx * V.s) * DPR, (H / 2 + V.cy * V.s) * DPR); }
  function draw() { if (drawQueued) return; drawQueued = true; requestAnimationFrame(() => { drawQueued = false; drawNow(); }); }

  function drawNow() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.fillStyle = C.land || '#E6EAE2'; ctx.fillRect(0, 0, W, H);
    if (!cur) return;
    const A = cur, P = A.P, s = V.s;
    mapTransform();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.fillStyle = C.park; ctx.fill(P.park);
    ctx.fillStyle = C.water; ctx.fill(P.water);
    ctx.strokeStyle = C.water; for (const l of P.wl) { ctx.lineWidth = Math.max(l.w, 1.5 / s); ctx.stroke(l.p); }
    const RW = { M: [11, 8.4, 2.2], m: [6.4, 4.3, 1.3], f: [3.4, 1.9, 0.7], s: [3.4, 1.9, 0.7] };
    for (const t of ['f', 's', 'm', 'M']) { ctx.strokeStyle = t === 'f' || t === 's' ? C.pathCase : C.roadCase; ctx.lineWidth = Math.max(RW[t][0], RW[t][2] / s + 1 / s); ctx.stroke(P.road[t]); }
    for (const t of ['f', 's', 'm', 'M']) { ctx.strokeStyle = t === 'f' || t === 's' ? C.path : C.road; ctx.lineWidth = Math.max(RW[t][1], RW[t][2] / s); if (t === 's') ctx.setLineDash([1, 1]); ctx.stroke(P.road[t]); ctx.setLineDash([]); }
    ctx.strokeStyle = C.pathCase; ctx.lineWidth = Math.max(2.2, 0.7 / s); ctx.setLineDash([1.6, 1.2]); ctx.stroke(P.road.c); ctx.setLineDash([]);
    if (shadowPath) { ctx.fillStyle = C.shadow; ctx.fill(shadowPath); }
    ctx.fillStyle = C.bld; ctx.fill(P.blds);
    if (s > 0.6) { ctx.strokeStyle = C.bldEdge; ctx.lineWidth = 0.6 / s; ctx.stroke(P.blds); }
    // 가로수
    const TP = buildTreePaths(A, S.mode);
    const dot = Math.min(7, Math.max(2.6, 1.6 + s * 1.1));
    ctx.lineCap = 'round';
    ctx.strokeStyle = C.tFaint; ctx.lineWidth = dot * 0.62 / s; ctx.stroke(TP.faint);
    for (const g of TP.groups) { ctx.strokeStyle = C.halo; ctx.lineWidth = (dot + 1.6) / s; ctx.stroke(g.path); }
    for (const g of TP.groups) { ctx.strokeStyle = C[g.color]; ctx.lineWidth = dot / s; ctx.stroke(g.path); }
    // 경로
    if (routeDraw) {
      for (const r of routeDraw) {
        ctx.strokeStyle = r.caseColor; ctx.lineWidth = (r.w + 4) / s; ctx.setLineDash(r.dash ? r.dash.map(v => v / s) : []); ctx.stroke(r.path);
        ctx.strokeStyle = r.color; ctx.lineWidth = r.w / s; ctx.stroke(r.path); ctx.setLineDash([]);
        if (r.ice) { ctx.strokeStyle = C.ice; ctx.lineWidth = (r.w - 1.5) / s; ctx.setLineDash([3 / s, 3 / s]); ctx.stroke(r.ice); ctx.setLineDash([]); }
      }
    }
    // 화면 좌표: 이름표와 표지
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    drawLabels(A);
    drawMarker(S.A, '출', C.ink); drawMarker(S.B, '도', C.pick);
    updateScale();
  }

  function drawLabels(A) {
    const boxes = [];
    const hit = (b) => boxes.some(o => !(b[2] < o[0] || b[0] > o[2] || b[3] < o[1] || b[1] > o[3]));
    const font = (px, wgt) => wgt + ' ' + px + 'px ' + getComputedStyle(document.body).fontFamily;
    // 표지 자리 비워 두기
    for (const p of [S.A, S.B]) if (p) { const [x, y] = toScreen(p.x, p.y); boxes.push([x - 14, y - 14, x + 14, y + 14]); }
    // 역·장소
    const places = A.places || [];
    for (const p of places) {
      const [x, y] = toScreen(p.x, p.y);
      if (x < -50 || y < -20 || x > W + 50 || y > H + 20) continue;
      const st = p.kind === 'station';
      ctx.font = font(st ? 12.5 : 11.5, st ? 600 : 500);
      const tw = ctx.measureText(p.name).width;
      const b = [x - tw / 2 - 2, y - 22, x + tw / 2 + 2, y - 6];
      if (hit(b)) continue;
      boxes.push(b, [x - 5, y - 5, x + 5, y + 5]);
      ctx.beginPath(); ctx.arc(x, y, st ? 4.5 : 3.2, 0, Math.PI * 2);
      ctx.fillStyle = st ? C.station : C.muted; ctx.strokeStyle = C.halo; ctx.lineWidth = 2; ctx.fill(); ctx.stroke();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
      ctx.strokeStyle = C.halo; ctx.lineWidth = 3.4; ctx.strokeText(p.name, x, y - 14);
      ctx.fillStyle = st ? C.ink : C.muted; ctx.fillText(p.name, x, y - 14);
    }
    // 길 이름
    if (V.s < 0.35) return;
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
    const [x, y] = toScreen(p.x, p.y);
    ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.strokeStyle = C.halo; ctx.lineWidth = 3; ctx.fill(); ctx.stroke();
    ctx.fillStyle = C.halo; ctx.font = '700 11.5px ' + getComputedStyle(document.body).fontFamily; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(ch, x, y + 0.5);
  }
  function updateScale() {
    const m = [10, 20, 50, 100, 200, 500, 1000].find(v => v * V.s >= 60) || 1000;
    $('scale-bar').style.width = Math.round(m * V.s) + 'px';
    $('scale-txt').textContent = m >= 1000 ? (m / 1000) + ' km' : m + ' m';
  }

  // ---------------------------------------------------------------- 지도 조작
  const ptrs = new Map(); let gesture = null;
  function zoomAt(f, sx, sy) {
    const [mx, my] = toMap(sx, sy);
    const minS = HOMEV ? HOMEV.s * 0.35 : 0.05;
    const ns = Math.min(12, Math.max(minS, V.s * f));
    V.cx = mx - (sx - W / 2) / ns; V.cy = my + (sy - H / 2) / ns; V.s = ns;
    draw();
  }
  const local = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  function markerAt(sx, sy) {
    for (const k of ['B', 'A']) { const p = S[k]; if (!p) continue; const [x, y] = toScreen(p.x, p.y); if (Math.hypot(x - sx, y - sy) < 18) return k; }
    return null;
  }
  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId);
    const p = local(e); ptrs.set(e.pointerId, p);
    if (ptrs.size === 1) { const mk = markerAt(p[0], p[1]); gesture = { start: p, last: p, moved: false, marker: mk, t: Date.now() }; cv.classList.add('dragging'); }
    else gesture = Object.assign(gesture || {}, { moved: true, marker: null });
  });
  cv.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const p = local(e), prev = ptrs.get(e.pointerId);
    ptrs.set(e.pointerId, p);
    if (ptrs.size === 1 && gesture) {
      if (Math.hypot(p[0] - gesture.start[0], p[1] - gesture.start[1]) > 5) gesture.moved = true;
      if (gesture.marker) { const [mx, my] = toMap(p[0], p[1]); S[gesture.marker] = { x: mx, y: my, name: null }; draw(); }
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
      if (gesture && gesture.marker && gesture.moved) { const [mx, my] = toMap(p[0], p[1]); setPoint(gesture.marker, mx, my, null); }
      else if (gesture && !gesture.moved && e.type === 'pointerup') { const [mx, my] = toMap(p[0], p[1]); setPoint(S.armed, mx, my, null); if (S.armed === 'A') arm('B'); }
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
  function snap(x, y) { const n = E.nearestNode(cur, x, y); return { n, x: cur.G.X[n], y: cur.G.Y[n] }; }
  function setPoint(k, x, y, name) {
    const s = snap(x, y);
    S[k] = { x: s.x, y: s.y, n: s.n, name: name || null };
    syncSelects(); schedule();
  }
  function arm(k) { S.armed = k; $('arm-A').setAttribute('aria-pressed', String(k === 'A')); $('arm-B').setAttribute('aria-pressed', String(k === 'B')); }
  $('arm-A').addEventListener('click', () => arm('A'));
  $('arm-B').addEventListener('click', () => arm('B'));
  $('swap').addEventListener('click', () => { const a = S.A; S.A = S.B; S.B = a; syncSelects(); schedule(); });
  function fillSelects() {
    for (const k of ['A', 'B']) {
      const sel = $('sel-' + k);
      const opts = ['<option value="">지도에서 고른 곳</option>'];
      const group = (label, list) => { if (list.length) opts.push('<optgroup label="' + label + '">' + list.map(p => '<option value="' + p.name + '">' + p.name + '</option>').join('') + '</optgroup>'); };
      group('지하철역', cur.stations.slice().sort((a, b) => a.name.localeCompare(b.name, 'ko')));
      group('장소', cur.landmarks.slice().sort((a, b) => a.name.localeCompare(b.name, 'ko')));
      sel.innerHTML = opts.join('');
    }
  }
  function syncSelects() { for (const k of ['A', 'B']) { const p = S[k]; $('sel-' + k).value = p && p.name ? p.name : ''; } }
  for (const k of ['A', 'B']) $('sel-' + k).addEventListener('change', (e) => {
    const p = cur.places.find(q => q.name === e.target.value);
    if (p) { setPoint(k, p.x, p.y, p.name); home(); }
  });

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
    renderLegend();
  }
  $('seasons').addEventListener('click', (e) => { const b = e.target.closest('[data-season]'); if (!b) return; setMode(SEASONS[b.dataset.season].modes[0]); });
  $('submodes').addEventListener('click', (e) => { const b = e.target.closest('[data-mode]'); if (!b) return; setMode(b.dataset.mode); });
  function setMode(m) { S.mode = m; S.sel = null; renderSeasonTabs(); updateShadowLayer(); schedule(); }
  $('cap').addEventListener('input', (e) => { S.cap[S.mode] = +e.target.value / 100; $('cap-out').textContent = '+' + e.target.value + '%'; S.sel = null; schedule(); });
  function fmtHour(h) { const hh = Math.floor(h), mm = Math.round((h - hh) * 60); return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0'); }
  $('hour').addEventListener('input', (e) => { S.hour = +e.target.value; $('hour-out').textContent = fmtHour(S.hour); syncTimeChips(); updateShadowLayer(); schedule(250); });
  $('time-chips').addEventListener('click', (e) => { const b = e.target.closest('[data-h]'); if (!b) return; S.hour = +b.dataset.h; $('hour').value = S.hour; $('hour-out').textContent = fmtHour(S.hour); syncTimeChips(); updateShadowLayer(); schedule(); });
  function syncTimeChips() { for (const b of $('time-chips').querySelectorAll('[data-h]')) b.setAttribute('aria-pressed', String(+b.dataset.h === S.hour)); }
  $('whour').addEventListener('input', (e) => { S.winterHour = +e.target.value; $('whour-out').textContent = fmtHour(S.winterHour); updateShadowLayer(); });

  function updateShadowLayer() {
    shadowPath = null;
    if (!cur) return draw();
    let sun = null, ever = false;
    const [lat, lon] = cur.toLL(0, 0);
    if (S.mode === 'summer-shade') { const h = Math.floor(S.hour), mi = Math.round((S.hour - h) * 60); sun = E.sunPos(E.kst(E.SUMMER.y, E.SUMMER.m, E.SUMMER.d, h, mi), lat, lon); }
    else if (S.mode === 'winter-sun') { sun = E.sunPos(E.kst(E.WINTER.y, E.WINTER.m, E.WINTER.d, S.winterHour, 0), lat, lon); ever = true; }
    if (sun) {
      const sp = E.shadowPolys(cur, sun, { evergreenOnly: ever });
      if (sp.night) { shadowPath = new Path2D(); shadowPath.rect(-1e5, -1e5, 2e5, 2e5); }
      else { const p = new Path2D(); for (const poly of sp.polys) addPoly(p, poly); shadowPath = p; }
      $('sun-info').textContent = '해 높이 ' + Math.round(sun.alt) + '° · 방위 ' + Math.round(sun.az) + '°';
    }
    draw();
  }

  function renderLegend() {
    const groups = treeGroups(S.mode);
    const items = groups.map(g => '<span class="lg"><i class="dot" style="background:var(' + cssVar(g[0]) + ')"></i>' + g[2] + '</span>');
    items.unshift('<span class="lg"><i class="ln" style="background:var(--short)"></i>최단</span><span class="lg"><i class="ln" style="background:var(--pick)"></i>' + E.MODES[S.mode].label + '</span>');
    if (S.mode === 'summer-shade' || S.mode === 'winter-sun') items.push('<span class="lg"><i class="sq"></i>그림자</span>');
    if (S.mode === 'winter-sun') items.push('<span class="lg"><i class="ln ice"></i>응달 구간</span>');
    $('legend').innerHTML = items.join('');
  }
  const cssVar = (k) => '--' + k.replace(/^t([A-Z])/, (m, c) => 't-' + c.toLowerCase()).replace(/[A-Z]/g, c => '-' + c.toLowerCase());

  // ---------------------------------------------------------------- 계산
  let timer = null, runId = 0;
  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(compute, delay == null ? 60 : delay);
  }
  function setBusy(on, text) { S.busy = on; $('busy').hidden = !on; if (text) $('busy-txt').textContent = text; }
  function compute() {
    if (!cur || !S.A || !S.B) { renderResult(null); return; }
    const id = ++runId;
    const needShade = (S.mode === 'summer-shade' && !cur.cache['shade' + S.hour]) || (S.mode === 'winter-sun' && !cur.cache.winter);
    if (needShade) setBusy(true, S.mode === 'winter-sun' ? '9~16시 그림자로 하루 볕을 계산하고 있어요' : '그림자를 계산하고 있어요');
    setTimeout(() => {
      if (id !== runId) return;
      try {
        const t0 = performance.now();
        const capv = S.cap[S.mode] != null ? S.cap[S.mode] : E.MODES[S.mode].cap;
        const res = E.plan(cur, S.A.n, S.B.n, S.mode, { hour: S.hour, cap: capv });
        res.ms = performance.now() - t0;
        S.res = res; S.sel = null;
        renderResult(res);
        writeHash();
      } catch (err) { console.error(err); $('result').innerHTML = '<p class="err">계산하다 문제가 생겼어요: ' + String(err.message || err) + '</p>'; }
      setBusy(false);
    }, needShade ? 40 : 0);
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
  function speciesBreak(r, max) {
    const tr = cur.trees, cnt = new Map();
    for (const i of r.m.near || E.treesNear(cur, r, 15)) { const nm = cur.species[tr.sp[i]]; cnt.set(nm, (cnt.get(nm) || 0) + 1); }
    return [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, max || 3).map(([k, v]) => k + ' ' + v).join(' · ');
  }
  function routeRoadsFor(r, flag) {
    const tr = cur.trees, cnt = new Map();
    for (const i of (r.m.near || [])) if (tr.flags[i] & flag) { const rd = cur.roads[tr.road[i]] || '기타'; cnt.set(rd, (cnt.get(rd) || 0) + 1); }
    return [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => k + ' ' + v).join(' · ');
  }
  function card(r, kind, res) {
    const mode = res.mode, M = E.MODES[mode], base = res.base;
    const isPick = kind === 'pick';
    const delta = r.len - base.len;
    const via = E.viaNames(cur, r);
    let sub = '';
    if (M.kind === 'trees' || M.kind === 'avoid') {
      const roads = routeRoadsFor(r, M.flag);
      sub = (roads ? '<p class="sub">' + M.what + ': ' + roads + '</p>' : '') + '<p class="sub">15m 안 많은 나무: ' + (speciesBreak(r, 3) || '없음') + '</p>';
      if (M.avoid) sub += '<p class="sub">은행 암나무 ' + (r.m.bad || 0) + '그루</p>';
    } else if (M.kind === 'sun') sub = '<p class="sub">하루 평균 볕 ' + r.m.sunH.toFixed(1) + '시간 (9~16시 기준)</p>';
    else if (M.kind === 'shade') sub = '<p class="sub">' + fmtHour(S.hour) + ' 기준, 그늘진 쪽 보도로 걸을 때</p>';
    return '<div class="card ' + (isPick ? 'pick' : 'short') + '">' +
      '<h3><i class="ln" style="background:var(' + (isPick ? '--pick' : '--short') + ')"></i>' + (isPick ? (res.manual ? '고른 경로' : M.label) : '최단 경로') + '</h3>' +
      (via.length ? '<p class="via">' + via.join(' → ') + '</p>' : '') +
      '<div class="nums"><span class="num">' + fmtM(r.len).replace('m', '<small>m</small>') + '</span><span class="num">' + mins(r.len) + '<small>분</small></span>' + (isPick && delta > 0.5 ? '<span class="delta">+' + Math.round(delta) + 'm · ' + (Math.round(delta / WALK) ? '+' + Math.round(delta / WALK) + '분' : '1분 안') + '</span>' : '') + '</div>' +
      '<div class="metric"><span class="mlabel">' + metricLabel(mode) + '</span><span class="mval">' + metricText(mode, r.m, true) + '</span></div>' + sub + '</div>';
  }
  function headline(res) {
    const M = E.MODES[res.mode], b = res.base, p = res.sel || res.pick;
    const d = Math.round(p.len - b.len), dm = Math.round(d / WALK);
    if (M.kind === 'avoid' && b.m.v === 0 && !cur.trees.flags.some(f => f & E.F.FEMALE)) return '<p class="verdict warn">이 지역 데이터에는 은행 암나무 표시가 없어요. 이 모드는 종로·광화문에서 써 보세요.</p>';
    if (p === b) {
      if (M.kind === 'trees' && b.m.v >= 10) return '<p class="verdict">최단 경로가 곧 ' + M.label + '이에요. 그대로 걸어도 ' + M.what + ' ' + b.m.v + '그루를 지나요.</p>';
      if (M.kind === 'avoid' && b.m.v === 0) return '<p class="verdict">최단 경로에 은행 암나무가 없어요. 그대로 걸으면 돼요.</p>';
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
    if (!res) { box.innerHTML = '<p class="empty">지도를 눌러 출발지와 도착지를 정하세요.</p>'; routeDraw = null; draw(); return; }
    const p = res.sel || res.pick;
    box.innerHTML = headline(res) + '<div class="cards">' + card(res.base, 'base', res) + (p !== res.base ? card(p, 'pick', Object.assign({}, res, { manual: !!res.sel })) : '') + '</div>' + chart(res) +
      '<p class="fine">계산 ' + Math.round(res.ms) + 'ms · 출발·도착은 가장 가까운 보행로 지점에 맞췄어요.' + (EMBED ? '' : ' <button type="button" class="linkbtn" id="copy-link">이 경로 링크 복사</button>') + '</p>';
    const cl = $('copy-link');
    if (cl) cl.addEventListener('click', async () => { writeHash(); try { await navigator.clipboard.writeText(location.href); cl.textContent = '복사했어요'; } catch (e) { cl.textContent = '복사가 막혀 있어요. 주소창 링크를 쓰세요'; } setTimeout(() => { cl.textContent = '이 경로 링크 복사'; }, 2500); });
    const cl2 = box.querySelector('.cands');
    if (cl2) cl2.addEventListener('click', (e) => { const c = e.target.closest('[data-i]'); if (!c) return; const r = res.cands[+c.dataset.i]; res.sel = r === res.pick ? null : r; renderResult(res); });
    // 지도 경로
    const mk = (r) => { const path = new Path2D(); const pts = E.routeCoords(cur, r); path.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]); return path; };
    routeDraw = [{ path: mk(res.base), color: C.short, caseColor: C.shortCase, w: 4.5 }];
    if (p !== res.base) {
      const item = { path: mk(p), color: C.pick, caseColor: C.pickCase, w: 5 };
      routeDraw.push(item);
    }
    if (res.mode === 'winter-sun') {
      const ctxW = res.ctx, G = cur.G;
      for (const item of routeDraw) {
        const r = item === routeDraw[0] ? res.base : p; const ice = new Path2D(); let any = false;
        for (const e of r.edges) if (ctxW.ice[e] >= 0.5) { ice.moveTo(G.X[G.ea[e]], G.Y[G.ea[e]]); ice.lineTo(G.X[G.eb[e]], G.Y[G.eb[e]]); any = true; }
        if (any) item.ice = ice;
      }
    }
    draw();
  }

  // ---------------------------------------------------------------- 주소창 상태
  function writeHash() {
    if (!S.A || !S.B) return;
    const q = new URLSearchParams({ a: S.area, m: S.mode, f: Math.round(S.A.x) + ',' + Math.round(S.A.y), t: Math.round(S.B.x) + ',' + Math.round(S.B.y) });
    if (S.mode === 'summer-shade') q.set('h', S.hour);
    if (S.cap[S.mode] != null) q.set('c', Math.round(S.cap[S.mode] * 100));
    try { history.replaceState(null, '', '#' + q.toString()); } catch (e) { /* 일부 환경은 막혀 있어요 */ }
  }
  function readHash() {
    try { const q = new URLSearchParams(location.hash.slice(1)); return Object.fromEntries(q.entries()); } catch (e) { return {}; }
  }

  // ---------------------------------------------------------------- 지역 바꾸기
  async function setArea(id, init) {
    S.area = id;
    for (const b of document.querySelectorAll('[data-area]')) b.setAttribute('aria-pressed', String(b.dataset.area === id));
    setBusy(true, AREAS[id].label + ' 데이터를 불러오고 있어요');
    try {
      cur = await getArea(id);
    } catch (err) { setBusy(false); $('result').innerHTML = '<p class="err">' + (err.message || err) + '</p>'; return; }
    setBusy(false);
    fillSelects();
    const h = init || {};
    const place = (nm) => cur.places.find(p => p.name === nm);
    const parseXY = (s) => { if (!s) return null; const [x, y] = s.split(',').map(Number); return isFinite(x) && isFinite(y) ? [x, y] : null; };
    const fa = parseXY(h.f), ta = parseXY(h.t);
    const a = fa ? { x: fa[0], y: fa[1] } : place(AREAS[id].defA) || cur.stations[0];
    const b = ta ? { x: ta[0], y: ta[1] } : place(AREAS[id].defB) || cur.stations[1];
    S.A = null; S.B = null;
    if (a) { const s = snap(a.x, a.y); S.A = { x: s.x, y: s.y, n: s.n, name: a.name || null }; }
    if (b) { const s = snap(b.x, b.y); S.B = { x: s.x, y: s.y, n: s.n, name: b.name || null }; }
    syncSelects(); arm('B');
    $('area-note').textContent = cur.name + ' · 가로수 ' + cur.trees.n.toLocaleString('ko-KR') + '그루 · 보행로 ' + Math.round(sumLen() / 1000) + 'km';
    HOMEV = null; home();
    renderSeasonTabs(); updateShadowLayer(); schedule(0);
  }
  function sumLen() { let s = 0; for (let e = 0; e < cur.G.E; e++) s += cur.G.len[e]; return s; }
  for (const b of document.querySelectorAll('[data-area]')) b.addEventListener('click', () => { if (b.dataset.area !== S.area) setArea(b.dataset.area); });

  // ---------------------------------------------------------------- 시작
  function init() {
    readColors();
    const h = readHash();
    S.mode = E.MODES[h.m] ? h.m : defaultMode(new Date());
    if (h.h && isFinite(+h.h)) S.hour = Math.min(19.5, Math.max(7, +h.h));
    if (h.c && isFinite(+h.c)) S.cap[S.mode] = Math.min(0.8, Math.max(0, +h.c / 100));
    $('hour').value = S.hour; $('hour-out').textContent = fmtHour(S.hour); syncTimeChips();
    $('whour').value = S.winterHour; $('whour-out').textContent = fmtHour(S.winterHour);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onTheme = () => { readColors(); if (S.res) renderResult(S.res); draw(); };
    if (mq.addEventListener) mq.addEventListener('change', onTheme);
    if ('ResizeObserver' in window) new ResizeObserver(resize).observe(cv); else window.addEventListener('resize', resize);
    resize();
    setArea(AREAS[h.a] ? h.a : 'jongno', h);
  }
  window.SWApp = { S, get cur() { return cur; }, setArea, setMode, setPoint };
  init();
})();
