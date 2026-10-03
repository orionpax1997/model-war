// PROTOTYPE (throwaway) —— 生成单文件 HTML：三图并排 + 中心放大 + 绕路热力 + 度量表。
// 用法：node .scratch/map-pool/proto/render.mjs  →  .scratch/map-pool/proto/maps.html（双击打开）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL, jaccard, wallSet, pct, bfs, auditVariantSlots, chebyshev, BASELINE_FIRST_CONTACT, BASELINE_DEPLETION } from './metrics.mjs';
import { expand, ring, flat, poly, rect, hline, vline, SIZE, orbit4, buildStyled } from './quad.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const R = ALL();

// --- variant 候选轨道：按种子整条填或不填（沿用桩的 LCG 与 50% 填充率）---
function makeLcg(seed) {
  let s = (seed % 2147483646) + 1;
  return () => { s = (s * 48271) % 2147483647; return s; };
}
const slotsFor = (seed) => {
  const rand = makeLcg(seed);
  const base = buildStyled('open');
  const forbidden = new Set();
  for (const s of [...base.sites, ...base.spawnUnits]) {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) forbidden.add(`${s.x + dx},${s.y + dy}`);
  }
  const reps = [[3, 3], [14, 3], [3, 26], [3, 45], [26, 3], [38, 3], [59, 16], [59, 40]];
  const out = [];
  reps.forEach(([x, y]) => {
    const cells = orbit4(x, y);
    if (cells.some(([cx, cy]) => forbidden.has(`${cx},${cy}`))) return;
    if (rand() % 100 < 50) out.push(...cells);
  });
  return new Set(out.map(([x, y]) => `${x},${y}`));
};

// --- 每张图的数据包 ---
const VIEWS = R.map((r) => {
  // 绕路热力：以 0 号家为源做 BFS，detour = BFS − Chebyshev
  const home0 = r.siteList.find((s) => s.kind === 'base' && s.owner === 0);
  const plain = r.grid.map((row) => row.map((c) => (c === '#' ? 'wall' : 'plain')));
  const dist = bfs(r.grid, [[home0.x, home0.y]]);
  const detour = [];
  for (let y = 0; y < SIZE; y++) {
    const row = [];
    for (let x = 0; x < SIZE; x++) {
      const d = dist[y * SIZE + x];
      row.push(d === -1 ? 99 : d - chebyshev(home0.x, home0.y, x, y));
    }
    detour.push(row);
  }
  return {
    key: r.key,
    label: r.style.label,
    intent: r.style.intent,
    grid: r.grid.map((row) => row.join('')),
    sites: r.siteList.map((s) => ({ x: s.x, y: s.y, kind: s.kind, owner: s.owner })),
    spawn: r.spawnUnits.map((u) => ({ x: u.x, y: u.y, owner: u.owner })),
    detour,
    m: r,
  };
});

const OPEN_THICK = flat(
  poly([21, 9], [22, 9], [22, 10], [23, 9], [23, 10]), rect(12, 20, 3, 3), hline(29, 7, 10), hline(28, 8, 9),
  poly([13, 5], [14, 5], [14, 6], [15, 5], [15, 6]), rect(21, 19, 3, 3), hline(11, 24, 26),
  poly([5, 22], [5, 23], [6, 23], [6, 22], [6, 24]), vline(30, 24, 26), hline(30, 16, 18),
  poly([2, 4], [2, 5], [3, 5], [3, 4], [3, 6]),
);
const INNER = () => ring(21, 42, [[25, 21], [26, 21], [27, 21], [28, 21], [29, 21]]);
const OUTER = (k = 0) => ring(13 + k, 50 - k, [[17 + k, 13 + k], [18 + k, 13 + k], [19 + k, 13 + k]]);
const controls = [
  { name: '对照 A：开阔图加密度（同风格，只是墙更多）', grid: expand(OPEN_THICK) },
  ...[1, 2, 3, 4, 6, 8].map((k) => ({ name: `对照 B${k}：廊道只把外环内移 ${k} 格`, grid: expand(flat(INNER(), OUTER(k))) })),
  { name: '对照 C：只剩内环（外环整个没了）', grid: expand(INNER()) },
  { name: '对照 D：廊道再加第三层环', grid: expand(flat(INNER(), OUTER(0), ring(6, 57, [[10, 6], [11, 6], [12, 6]]))) },
].map((c) => ({ ...c, jOpen: jaccard(wallSet(c.grid), R[0].walls), jCorr: jaccard(wallSet(c.grid), R[1].walls), cells: wallSet(c.grid).size }));

const slotSets = {};
for (const seed of [1, 11, 23, 37]) slotSets[seed] = [...slotsFor(seed)];

// 预先算好要写进文案的几个数（避免在模板里套模板）
const realPairs = [];
for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) realPairs.push(jaccard(R[i].walls, R[j].walls));
const realLo = Math.min(...realPairs).toFixed(3);
const realHi = Math.max(...realPairs).toFixed(3);
const probeShift1 = jaccard(wallSet(expand(flat(INNER(), OUTER(1)))), R[1].walls).toFixed(3);
const probeThicker = jaccard(wallSet(expand(OPEN_THICK)), R[0].walls).toFixed(3);

const data = { views: VIEWS, controls, slotSets, size: SIZE, meta: { firstContact: BASELINE_FIRST_CONTACT, depletion: BASELINE_DEPLETION }, audit: auditVariantSlots() };

const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>model-war 地图池原型 · 三张 64×64 墙图</title>
<style>
  :root { --paper:#f4f1e8; --ink:#1d1c22; --wall:#2a2733; --line:#d9d3c4; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px 28px 80px; background:var(--paper); color:var(--ink);
         font:14px/1.6 -apple-system,"PingFang SC","Noto Sans CJK SC",sans-serif; }
  h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:16px; margin:36px 0 10px; padding-bottom:6px; border-bottom:1px solid var(--line); }
  .sub { color:#6b6656; margin:0 0 14px; }
  .bar { display:flex; gap:14px; align-items:center; flex-wrap:wrap; margin:0 0 18px; padding:10px 12px;
         border:1px solid var(--line); border-radius:8px; background:#fffdf7; }
  label { display:inline-flex; gap:5px; align-items:center; cursor:pointer; user-select:none; }
  .row { display:flex; gap:26px; flex-wrap:wrap; align-items:flex-start; }
  .card h3 { font-size:14px; margin:0 0 2px; } .card p { margin:0 0 8px; color:#6b6656; font-size:12px; max-width:420px; }
  .grid { display:grid; gap:1px; background:var(--line); border:1px solid var(--line); }
  .cell { width:7px; height:7px; } .zoom .cell { width:15px; height:15px; }
  .cell.plain { background:#fbf9f2; } .cell.wall { background:var(--wall); }
  .cell.site { border-radius:2px; }
  .cell.res { background:#b8d8a8; }
  .cell.res.own { background:#4e9a52; } .cell.res.neutral { background:#d8e8cf; }
  .cell.neutral { background:#cfc7b2; } .cell.center { background:#e8a13c; }
  .cell.home0 { background:#3b6fd4; } .cell.home1 { background:#d4553b; }
  .cell.home2 { background:#3fa06a; } .cell.home3 { background:#b04fc0; }
  .cell.spawn { box-shadow: inset 0 0 0 2px #fff; border-radius:50%; }
  table { border-collapse:collapse; margin:6px 0 18px; font-size:13px; }
  th, td { border:1px solid var(--line); padding:4px 10px; text-align:left; background:#fffdf7; }
  th { background:#efe9da; font-weight:600; }
  code { background:#efe9da; padding:1px 5px; border-radius:4px; }
  .ok { color:#2f7a3f; } .bad { color:#b03a2e; } .muted { color:#6b6656; }
  .legend span { display:inline-flex; align-items:center; gap:4px; margin-right:14px; }
  .sw { width:12px; height:12px; border-radius:2px; display:inline-block; border:1px solid #0002; }
  .heat0 { background:#fbf9f2; } .heat1 { background:#ffe9a8; } .heat2 { background:#ffc46b; } .heat3 { background:#f98d4b; } .heat4 { background:#e0523c; }
  .note { border-left:3px solid #e8a13c; background:#fff8e8; padding:10px 14px; margin:10px 0; max-width:900px; }
</style></head><body>
<h1>model-war 节点 A · 地图池原型：开阔 / 廊道 / 要塞 三张 64×64</h1>
<p class="sub">PROTOTYPE · throwaway · 点位三图锁死（4 主 + 8 中立 + 16 资源，沿用标定环 <code>center-fortress@64</code>），差异 100% 来自 terrain。四重旋转对称由构造保证（象限形状 + 4 次旋转）。</p>

<div class="bar">
  <label><input type="checkbox" id="tSites" checked> 显示点位</label>
  <label><input type="checkbox" id="tHeat"> 绕路热力（0 号家 BFS − 直线）</label>
  <label><input type="checkbox" id="tZoom"> 只看中心 24×24（Q1：中心基地块违不违和）</label>
  <label>variant 种子 <select id="seed"><option value="0">不填</option><option value="1">1</option><option value="11">11</option><option value="23">23</option><option value="37">37</option></select></label>
  <span class="muted" id="slotInfo"></span>
</div>

<div class="legend" style="margin-bottom:16px">
  <span><i class="sw" style="background:#2a2733"></i>墙</span>
  <span><i class="sw" style="background:#3b6fd4"></i>0 号家</span><span><i class="sw" style="background:#d4553b"></i>1 号家</span>
  <span><i class="sw" style="background:#3fa06a"></i>2 号家</span><span><i class="sw" style="background:#b04fc0"></i>3 号家</span>
  <span><i class="sw" style="background:#e8a13c"></i>中心中立基地（2×2）</span>
  <span><i class="sw" style="background:#cfc7b2"></i>边路中立基地</span>
  <span><i class="sw" style="background:#4e9a52"></i>自家矿</span>
  <span><i class="sw" style="background:#d8e8cf"></i>中立矿</span>
  <span><i class="sw" style="background:#fff;border:1px solid #999"></i>起始农民</span>
</div>

<div class="row" id="maps"></div>

<h2>2 · 度量总表</h2>
${(() => {
  const row = (label, fn) => `<tr><th>${label}</th>${VIEWS.map((v) => `<td>${fn(v.m)}</td>`).join('')}</tr>`;
  return `<table><tr><th></th>${VIEWS.map((v) => `<th>${v.label}</th>`).join('')}</tr>
  ${row('墙格 / 密度', (m) => `${m.wallCount} / ${pct(m.density)}`)}
  ${row('矿路 d（家→最近自家矿）', (m) => m.mineTrips.map((t) => t.path).join(' / '))}
  ${row('中路推进（家→中心基地，直线→路径）', (m) => m.centerReach.map((t) => `${t.cheb}→${t.path}`).join(' '))}
  ${row('六对路径（直线→路径）', (m) => m.pairs.map((p) => `${p.i}${p.j}:${p.cheb}→${p.path}`).join('  '))}
  ${row('路径拉伸 mean / p90 / max', (m) => `${m.stretch.mean.toFixed(2)} / ${m.stretch.p90.toFixed(2)} / ${m.stretch.max.stretch.toFixed(2)}`)}
  ${row('最绕的一对', (m) => `${m.stretch.max.pair}（${m.stretch.max.cheb}→${m.stretch.max.path}）`)}
  ${row('首触估算（六对里的最早）', (m) => `<b>${m.estFirstContact.toFixed(0)}</b> tick（最晚一对 ${m.latestPair.est.toFixed(0)}）`)}
  ${row('枯竭估算', (m) => `<b>${m.estDepletion.toFixed(0)}</b> tick`)}
  </table>`;
})()}
<p class="muted">基线：首触 ${BASELINE_FIRST_CONTACT} tick 与枯竭 ${BASELINE_DEPLETION} tick 都取自标定环<strong>全平原</strong>夹具的实测中位（<code>results-rerun.md</code>）。估算口径写在 <code>proto/metrics.mjs</code> 头注：首触 = 基线 + 绕路格数/2（两家对进，各走一半）；枯竭 = 基线 ×(2d+20)/32（一次满载采集 20 tick）。</p>

<h2>3 · Jaccard 墙体相似度（spec 初版阈值 0.2）</h2>
<table><tr><th>图对</th><th>Jaccard</th><th>0.2 判据</th></tr>
${(() => {
  let out = '';
  for (let i = 0; i < VIEWS.length; i++) for (let j = i + 1; j < VIEWS.length; j++) {
    const v = jaccard(R[i].walls, R[j].walls);
    out += `<tr><td>${VIEWS[i].label} vs ${VIEWS[j].label}</td><td><b>${v.toFixed(4)}</b></td><td class="${v < 0.2 ? 'ok' : 'bad'}">${v < 0.2 ? '✓ 过' : '✗ 不过'}</td></tr>`;
  }
  for (const c of controls) {
    const worst = Math.max(c.jOpen, c.jCorr);
    out += `<tr><td class="muted">${c.name}（${c.cells} 格）</td><td>开阔 ${c.jOpen.toFixed(3)} / 廊道 ${c.jCorr.toFixed(3)}</td><td class="${worst < 0.2 ? 'bad' : 'ok'}">${worst < 0.2 ? '✗ 0.2 挡不住' : '✓ 被 0.2 挡住'}</td></tr>`;
  }
  return out;
})()}
</table>
<div class="note">校准读法：真图两两 <b>${realLo} – ${realHi}</b>；而「结构相同、只把外环挪 1 格」就已经是 <b>${probeShift1}</b>，「同风格只加密度」是 <b>${probeThicker}</b>。真图与「结构相关」之间有一道很宽的缝（0.025 ↔ 0.19），而 0.2 恰好落在这道缝的<b>外侧</b>——它会放过「两张图共享一整圈环带」这种情况。建议阈值收到 <b>0.15</b>（真图余量 6 倍，最小的结构共享探针 0.19 仍被挡住），而不是放宽。</div>

<h2>4 · variantSlots 候选轨道体检</h2>
<table><tr><th>代表元</th>${data.audit.all.map((o) => `<th>${o.rep.join(',')}</th>`).join('')}</tr>
<tr><th>八邻域干净格数</th>${data.audit.all.map((o) => `<td>${o.clean.length} / 4</td>`).join('')}</tr></table>
<p>8 条轨道全部干净 = <b>32 格 = 0.781% 全图</b>，没有任何半条轨道。<span class="muted">（handoff/spec 里写的「过滤后剩 20 格 / 0.488%」是 <code>seed=1</code> 时被填上的 5 条轨道，不是过滤结果——静态候选清单不能是种子相关的数。）</span></p>

<h2>5 · 怎么读这张表（Q1 怎么看）</h2>
<p>勾上「只看中心 24×24」，并排比三张图的中心：<strong>开阔图</strong>的中心是一个<em>没有任何墙</em>的 2×2 中立基地块；<strong>廊道图</strong>的中心被内环围着（4 个 5 格口）；<strong>要塞图</strong>的中心被 r=3 的紧环围着（4 个 2 格门），且中心基地到次内圈矿的路径从 7 拉到 11。</p>

<script>
const DATA = ${JSON.stringify(data)};
const S = DATA.size;
const $ = (id) => document.getElementById(id);
// URL 参数可预设视图：?zoom=1&heat=1&sites=0&seed=23
const QS = new URLSearchParams(location.search);
if (QS.has('zoom')) $('tZoom').checked = QS.get('zoom') === '1';
if (QS.has('heat')) $('tHeat').checked = QS.get('heat') === '1';
if (QS.has('sites')) $('tSites').checked = QS.get('sites') === '1';
if (QS.has('seed')) $('seed').value = QS.get('seed');
const PALETTE = ['#3b6fd4', '#d4553b', '#3fa06a', '#b04fc0'];
const esc = (s) => s;

function cellClass(v, x, y, opts) {
  const g = v.grid[y][x];
  if (g === '#') return 'wall';
  if (opts.heat) {
    const d = v.detour[y][x];
    if (d >= 6) return 'heat4'; if (d >= 4) return 'heat3'; if (d >= 2) return 'heat2'; if (d >= 1) return 'heat1';
  }
  if (opts.sites) {
    const s = v.sites.find((s) => s.x === x && s.y === y);
    if (s) {
      if (s.kind === 'base') {
        if (s.owner >= 0) return 'home' + s.owner;
        return (Math.abs(s.x - 31.5) < 8 && Math.abs(s.y - 31.5) < 8) ? 'center' : 'neutral';
      }
      return (s.owner >= 0 ? 'res own' : 'res neutral');
    }
    if (v.spawn.some((u) => u.x === x && u.y === y)) return 'spawn';
  }
  return 'plain';
}

function render() {
  const opts = { sites: $('tSites').checked, heat: $('tHeat').checked, zoom: $('tZoom').checked };
  const seed = +$('seed').value;
  const slots = seed ? new Set(DATA.slotSets[seed].map(([x, y]) => x + ',' + y)) : null;
  $('slotInfo').textContent = slots ? \`本种子填了 \${slots.size} 格候选墙（整条轨道填或不填）\` : '';
  const x0 = opts.zoom ? 20 : 0, x1 = opts.zoom ? 44 : S, y0 = opts.zoom ? 20 : 0, y1 = opts.zoom ? 44 : S;
  $('maps').innerHTML = DATA.views.map((v) => {
    let cells = '';
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const isWall = v.grid[y][x] === '#' || (slots && slots.has(x + ',' + y));
      const cls = isWall ? 'wall' : cellClass(v, x, y, opts);
      cells += \`<div class="cell \${cls}"></div>\`;
    }
    const m = v.m;
    return \`<div class="card">
      <h3>\${v.label}</h3>
      <p>\${v.intent}<br>墙 \${m.wallCount} 格（\${(m.density * 100).toFixed(1)}%）· 矿路 d=\${m.mineTrips.map((t) => t.path).join('/')} · 中路 \${m.centerReach[0].cheb}→\${m.centerReach[0].path} · 首触估算 \${m.estFirstContact.toFixed(0)} · 枯竭估算 \${m.estDepletion.toFixed(0)}</p>
      <div class="grid \${opts.zoom ? 'zoom' : ''}" style="grid-template-columns:repeat(\${x1 - x0},auto)">\${cells}</div>
    </div>\`;
  }).join('');
}
['tSites', 'tHeat', 'tZoom', 'seed'].forEach((id) => $(id).addEventListener('change', render));
render();
</script>
</body></html>`;

fs.writeFileSync(path.join(HERE, 'maps.html'), html);
console.log('写出 ' + path.join(HERE, 'maps.html') + `（${(html.length / 1024).toFixed(0)} KB，双击打开）`);
