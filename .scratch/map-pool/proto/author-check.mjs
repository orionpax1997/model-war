// PROTOTYPE (throwaway) —— 作者面的回显：全图 64×64 ASCII + 卫生告警。
import { SIZE, STYLES, buildStyled, assertRotMatchesStub } from './quad.mjs';

const first = buildStyled(STYLES[0].key);
assertRotMatchesStub(first);

const siteAt = new Map();
for (const s of first.sites) {
  const key = `${s.x},${s.y}`;
  let mark = 'o';
  if (s.kind === 'base') {
    if (s.owner >= 0) mark = String(s.owner);
    else {
      // 中心 2×2（x,y 皆在 26/37）vs 边路
      const cx = Math.abs(s.x - 31.5);
      const cy = Math.abs(s.y - 31.5);
      mark = Math.max(cx, cy) < 8 ? 'C' : 'n';
    }
  }
  siteAt.set(key, mark);
}
const unitAt = new Set(first.spawnUnits.map((u) => `${u.x},${u.y}`));

for (const style of STYLES) {
  const { grid } = buildStyled(style.key);
  const bad = [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (grid[y][x] !== '#') continue;
      for (const [key] of siteAt) {
        const [sx, sy] = key.split(',').map(Number);
        if (Math.max(Math.abs(sx - x), Math.abs(sy - y)) <= 1) bad.push(`墙(${x},${y}) 落在点位 ${key} 的八邻域`);
      }
      for (const key of unitAt) {
        const [ux, uy] = key.split(',').map(Number);
        if (ux === x && uy === y) bad.push(`墙(${x},${y}) 压住起始农民`);
      }
    }
  }
  let walls = 0;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (grid[y][x] === '#') walls++;
  console.log(`\n=== ${style.label}（${style.key}）${walls} 墙格 ${(walls / (SIZE * SIZE) * 100).toFixed(2)}% —— ${style.intent}`);
  for (let y = 0; y < SIZE; y++) {
    let line = '';
    for (let x = 0; x < SIZE; x++) {
      if (grid[y][x] === '#') line += '#';
      else if (unitAt.has(`${x},${y}`)) line += 'w';
      else line += siteAt.get(`${x},${y}`) ?? '.';
    }
    console.log(line);
  }
  console.log(`卫生告警 ${bad.length} 条`);
  for (const b of bad.slice(0, 20)) console.log('  ! ' + b);
}
console.log('\n图例：# 墙  0-3 自家主基地  n 边路中立基地  C 中心中立基地  o 资源点  w 起始农民');
