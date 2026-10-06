// 서울 길 격자 파일(data/ways/*.js)을 OpenStreetMap(Overpass)에서 다시 만든다.
// GitHub Actions(.github/workflows/refresh-osm.yml)가 한 달에 한 번 돌린다. 직접 돌릴 때: node tools/build-ways.js [칸 이름…]
// - 칸마다 길 수가 이전보다 30% 넘게 줄면(서버가 일부만 돌려준 경우) 그 칸은 바꾸지 않는다.
// - 서버 오류로 못 받은 칸도 그대로 두고 다음 칸으로 넘어간다. 시간이 95분을 넘으면 남은 칸은 다음 달로 미룬다.
// - 건너뛴 칸이 있으면 받은 칸은 저장한 뒤 실패(종료 코드 1)로 끝내서 Actions에 표시되게 한다.
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const O = require(path.join(ROOT, 'osm.js'));

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const STATUS = 'https://overpass-api.de/api/status';
const HW_RE = '^(primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|residential|unclassified|living_street|service|footway|pedestrian|path|cycleway|track|steps)$';
const BUDGET_MS = +(process.env.BUDGET_MIN || 95) * 60000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function readSeoul() {
  const src = fs.readFileSync(path.join(ROOT, 'data', 'seoul.js'), 'utf8');
  return JSON.parse(src.slice(src.indexOf('=') + 1).trim().replace(/;\s*$/, ''));
}
function readCell(key) {
  const f = path.join(ROOT, 'data', 'ways', key + '.js');
  if (!fs.existsSync(f)) return null;
  const src = fs.readFileSync(f, 'utf8');
  return JSON.parse(src.slice(src.indexOf(']=') + 2).trim().replace(/;\s*$/, ''));
}
async function waitSlot() {
  for (let i = 0; i < 30; i++) {
    try {
      const t = await (await fetch(STATUS)).text();
      const m = /(\d+) slots? available now/.exec(t);
      if (m && +m[1] > 0) return;
      const secs = [...t.matchAll(/in (\d+) seconds?/g)].map(x => +x[1]);
      await sleep(((secs.length ? Math.min(...secs) : 5) + 1) * 1000);
    } catch (e) { return; }
  }
}
async function query(q) {
  let last = '';
  for (let a = 0; a < 8; a++) {
    const url = ENDPOINTS[[0, 0, 1, 0, 0, 1, 2, 0][a]];
    if (url === ENDPOINTS[0]) await waitSlot();
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 240000);
    try {
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': 'seasonal-walk-data-refresh (GitHub Actions)' }, signal: ctl.signal });
      const t = await r.text();
      if (!r.ok || t.trim()[0] !== '{') throw new Error('HTTP ' + r.status);
      const j = JSON.parse(t);
      if (j.remark && /error|timeout|runtime|memory/i.test(j.remark)) throw new Error('remark: ' + j.remark.slice(0, 80));
      return j;
    } catch (e) { last = String(e.message || e); log('  retry', a + 1, url.split('/')[2], last); await sleep(5000 * (a + 1)); }
    finally { clearTimeout(tm); }
  }
  throw new Error('Overpass failed: ' + last);
}

(async () => {
  const t0 = Date.now();
  const SEOUL = readSeoul(), G = SEOUL.grid;
  const keys = process.argv.slice(2).length ? process.argv.slice(2) : SEOUL.ways;
  let newest = SEOUL.waysDate || '', done = 0;
  const bad = [];
  for (const key of keys) {
    if (Date.now() - t0 > BUDGET_MS) { bad.push(key + ' (시간 초과, 다음에)'); continue; }
    const r = +/r(\d+)/.exec(key)[1], c = +/c(\d+)/.exec(key)[1];
    const s = G.lat0 + r * G.dlat, w = G.lon0 + c * G.dlon, n = s + G.dlat, e = w + G.dlon;
    const q = '[out:json][timeout:180];way["highway"~"' + HW_RE + '"](' + s.toFixed(4) + ',' + w.toFixed(4) + ',' + n.toFixed(4) + ',' + e.toFixed(4) + ');out body geom qt;';
    const t1 = Date.now();
    let enc;
    try { enc = O.encodeWays(await query(q)); } catch (err) { bad.push(key + ' (' + err.message + ')'); log(key, 'SKIP', err.message); continue; }
    const old = readCell(key);
    if (old && enc.ids.length < old.ids.length * 0.7) { bad.push(key + ' ' + old.ids.length + '→' + enc.ids.length); log(key, 'SKIP (too few ways)', old.ids.length, '→', enc.ids.length); continue; }
    fs.mkdirSync(path.join(ROOT, 'data', 'ways'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'data', 'ways', key + '.js'), '(window.SW_WAYS=window.SW_WAYS||{})[' + JSON.stringify(key) + ']=' + JSON.stringify(enc) + ';\n');
    if (enc.osm > newest) newest = enc.osm;
    if (!SEOUL.ways.includes(key)) SEOUL.ways = SEOUL.ways.concat([key]).sort();
    done++;
    log(key, 'ways', (old ? old.ids.length + '→' : '') + enc.ids.length, Date.now() - t1, 'ms');
  }
  SEOUL.waysDate = newest;
  fs.writeFileSync(path.join(ROOT, 'data', 'seoul.js'), 'window.SW_SEOUL=' + JSON.stringify(SEOUL) + ';\n');
  log('done', done + '/' + keys.length, 'cells, OSM', newest);
  if (bad.length) { console.error('건너뛴 칸(이전 파일 그대로):', bad.join(', ')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
