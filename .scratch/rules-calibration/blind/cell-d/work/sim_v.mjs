// work/sim.mjs —— 本地冒烟台：按 rules.md §2 管线粗略复现，只为验证脚本不崩、能出活。
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('./script.v1.js', import.meta.url), 'utf8');

const W = 32, H = 32;
let nextId = 1;
const nid = () => nextId++;

const terrain = [];
for (let y = 0; y < H; y++) { terrain.push(new Array(W).fill('plain')); }
// 装饰性墙体（成组四重对称）
const wallCells = [];
for (let x=8;x<24;x++){ if(x!==15) { wallCells.push([x,8]); wallCells.push([x,23]); } }
for (let y=8;y<24;y++){ if(y!==15){ wallCells.push([8,y]); wallCells.push([23,y]); } }
for (const [x,y] of wallCells) terrain[y][x] = 'wall';

const sites = [];
const addSite = (kind,x,y,owner) => { sites.push({id:nid(),kind,x,y,owner,progressOwner:-1,progress:0,remaining: kind==='resource'?125:undefined}); };
const basePos = [[2,2],[29,2],[2,29],[29,29]];
for (let p=0;p<4;p++) addSite('base', basePos[p][0], basePos[p][1], p);
const resPos = [[6,2],[2,6],[25,2],[29,6],[6,29],[2,25],[25,29],[29,25],
                [12,3],[3,12],[28,12],[12,28],[10,10],[21,10],[10,21],[21,21]];
for (const [x,y] of resPos) addSite('resource', x, y, -1);

const players = [];
for (let p=0;p<4;p++) players.push({index:p, resources:24, alive:true, exceptionTicks:0, units:[], queues:new Map()});
const units = new Map();

const siteAt = (x,y) => sites.find(s=>s.x===x&&s.y===y);
const unitAt = (x,y) => { for (const u of units.values()) if (u.x===x&&u.y===y) return u; return null; };
const freeNeighbor = (x,y) => { const offs=[[0,1],[1,0],[0,-1],[-1,0],[1,1],[1,-1],[-1,1],[-1,-1]];
  for (const [dx,dy] of offs) { const nx=x+dx, ny=y+dy; if (nx>=0&&ny>=0&&nx<W&&ny<H&&terrain[ny][nx]==='plain'&&!unitAt(nx,ny)) return {x:nx,y:ny}; } return null; };

for (let p=0;p<4;p++){ for(let k=0;k<3;k++){ const c0 = freeNeighbor(basePos[p][0], basePos[p][1]); if (c0) { const u={id:nid(),owner:p,type:'worker',x:c0.x,y:c0.y,hp:2,carrying:0}; units.set(u.id,u); players[p].units.push(u.id); } } }

const COST={worker:4,melee:8,ranged:12,cavalry:16}, HP={worker:2,melee:12,ranged:4,cavalry:6},
      DMG={worker:0,melee:3,ranged:2,cavalry:2}, RANGE={worker:1,melee:1,ranged:2,cavalry:1},
      SPAWN={worker:2,melee:4,ranged:6,cavalry:8};

function makeCtx(seat, log) {
  const sandbox = {};
  let intents = [];
  const unitById = id => units.get(id) || null;
  const pushUnit = (u) => intents.push({kind:'unit', unitId:u.id, ...u});
  Object.assign(sandbox, {
    getTick: () => sim.tick,
    getRange: (ax,ay,bx,by) => Math.max(Math.abs(ax-bx),Math.abs(ay-by)),
    getTerrainAt: (x,y) => (x<0||y<0||x>=W||y>=H) ? 'out' : terrain[y][x],
    getObjectById: (id) => { const u=unitById(id); if(u) return {id:u.id,owner:u.owner,type:u.type,x:u.x,y:u.y,hp:u.hp,carrying:u.carrying};
      const s = sites.find(s=>s.id===id); if (s) return {...s}; return null; },
    getObjectsByType: (kind, filter) => {
      if (kind==='unit') { let arr=[...units.values()].filter(u=>!filter||filter.owner===undefined||u.owner===filter.owner);
        return arr.map(u=>({id:u.id,owner:u.owner,type:u.type,x:u.x,y:u.y,hp:u.hp,carrying:u.carrying})); }
      let arr=[...sites];
      if (filter){ if(filter.kind) arr=arr.filter(s=>s.kind===filter.kind);
        if(filter.owner!==undefined) arr=arr.filter(s=>filter.owner===-1 ? s.owner===-1 : s.owner===filter.owner); }
      return arr.map(s=>({id:s.id,kind:s.kind,x:s.x,y:s.y,owner:s.owner,progressOwner:s.progressOwner,progress:s.progress,remaining:s.remaining}));
    },
    findPath: () => null,
    move: (unitId,dx,dy) => { const u=unitById(unitId); if(!u) return 'ERR_INVALID_UNIT'; if(u.owner!==seat) return 'ERR_NOT_OWNER'; if(Math.abs(dx)>1||Math.abs(dy)>1) return 'ERR_BAD_ARGS';
      intents.push({kind:'move',unitId,dx,dy}); },
    moveTo: (unitId,x,y) => { intents.push({kind:'moveTo',unitId,x,y}); },
    attack: (unitId,targetId) => { intents.push({kind:'attack',unitId,targetId}); },
    harvest: (unitId,siteId) => { intents.push({kind:'harvest',unitId,siteId}); },
    transfer: (unitId) => { intents.push({kind:'transfer',unitId}); },
    spawnUnit: (baseId,type) => { const s=sites.find(s=>s.id===baseId);
      if(!s||s.kind!=='base') return 'ERR_INVALID_SITE'; if(s.owner!==seat) return 'ERR_NOT_OWNER';
      if(players[seat].resources < COST[type]) return 'ERR_NOT_ENOUGH_RESOURCES';
      players[seat].resources -= COST[type];
      players[seat].queues.set(baseId,{type,ticksLeft:SPAWN[type]});
      return null; },
  });
  const ctx = vm.createContext(sandbox);
  vm.runInContext(SRC.replace('var MY_INDEX = 0;', `var MY_INDEX = ${seat};`), ctx);
  return { ctx, drain: () => { const r = intents; intents = []; return r; } };
}

const sim = { tick: 0 };
const seats = [0,1,2,3].map(s => makeCtx(s));
let winner = null, exceptions = 0;

for (let tick = 0; tick < 600 && !winner; tick++) {
  sim.tick = tick;
  const allIntents = [];
  for (let p=0;p<4;p++){ if(!players[p].alive) continue;
    try { seats[p].ctx.loop(); allIntents.push(...seats[p].drain()); }
    catch(e){ players[p].exceptionTicks++; exceptions++; allIntents.length = allIntents.length; }
  }
  // 1. validate: 每单位只留最后一条
  const perUnit = new Map();
  for (const it of allIntents){ if(it.kind==='unit'||it.unitId!==undefined){ perUnit.set(it.unitId, it); } }
  const valid = [];
  for (const [uid, it] of [...perUnit.entries()].sort((a,b)=>a[0]-b[0])) {
    const u = units.get(uid); if(!u) continue;
    if (it.kind==='move'){ const nx=u.x+it.dx, ny=u.y+it.dy;
      if(nx<0||ny<0||nx>=W||ny>=H||terrain[ny][nx]!=='plain') continue; valid.push({...it, nx, ny}); }
    else if (it.kind==='attack'){ const t=units.get(it.targetId); if(!t||t.owner===u.owner||DMG[u.type]<=0) continue;
      if (Math.max(Math.abs(u.x-t.x),Math.abs(u.y-t.y))>RANGE[u.type]) continue; valid.push(it); }
    else if (it.kind==='harvest'){ const s=sites.find(s=>s.id===it.siteId);
      if(!s||s.kind!=='resource'||s.owner!==u.owner||u.type!=='worker') continue;
      if(Math.max(Math.abs(u.x-s.x),Math.abs(u.y-s.y))>1||u.carrying>=20) continue; valid.push(it); }
    else if (it.kind==='transfer'){ const bs=sites.filter(s=>s.kind==='base'&&s.owner===u.owner&&Math.max(Math.abs(u.x-s.x),Math.abs(u.y-s.y))<=1);
      if(!bs.length||u.carrying<=0) continue; valid.push({...it, baseId:bs.sort((a,b)=>a.id-b.id)[0].id}); }
  }
  // 2. movement
  const movers = valid.filter(v=>v.kind==='move');
  const occStart = new Set([...units.values()].map(u=>u.x+','+u.y));
  const claims = new Map();
  for (const m of movers){ const k=m.nx+','+m.ny; if(!claims.has(k)) claims.set(k,[]); claims.get(k).push(m); }
  const moving = new Set();
  for (const [k, list] of claims){
    const byPrio = list.map(m=>({m,p:((tick+unitOwner(m.unitId))%4)})).sort((a,b)=>b.p-a.p);
    const win = byPrio[0].m;
    if (occStart.has(k) || moving.has(win.unitId)) continue;
    moving.add(win.unitId);
    const u = units.get(win.unitId); u.x = win.nx; u.y = win.ny;
    if (u.type==='cavalry'){ /* 简化：不做二次移动 */ }
  }
  function unitOwner(id){ const u=units.get(id); return u?u.owner:0; }
  // 3. combat
  const dmg = new Map();
  for (const a of valid.filter(v=>v.kind==='attack')){ const at=units.get(a.unitId); if(!at) continue;
    dmg.set(a.targetId,(dmg.get(a.targetId)||0)+DMG[at.type]); }
  for (const [tid, d] of dmg){ const t=units.get(tid); if(t) t.hp -= d; }
  for (const [id,u] of [...units]){ if(u.hp<=0){ units.delete(id); const pl=players[u.owner]; pl.units=pl.units.filter(x=>x!==id); } }
  // 4. objectTick
  for (const s of sites){
    const occ = [...units.values()].filter(u=>u.x===s.x&&u.y===s.y).sort((a,b)=>a.id-b.id);
    if (occ.length){ const d=occ[0];
      if (d.owner===s.owner){ /* 冻结 */ }
      else { if (s.progressOwner!==d.owner){ s.progressOwner=d.owner; s.progress=1; } else s.progress++;
        if (s.progress>=10){ s.owner=d.owner; s.progress=0; s.progressOwner=-1; } } }
  }
  for (const h of valid.filter(v=>v.kind==='harvest')){ const u=units.get(h.unitId); const s=sites.find(s=>s.id===h.siteId);
    if(u&&s&&u.carrying<20){ u.carrying++; if(s.remaining!==undefined) s.remaining--; } }
  for (const t of valid.filter(v=>v.kind==='transfer')){ const u=units.get(t.unitId); if(u){ players[u.owner].resources+=u.carrying; u.carrying=0; } }
  for (let p=0;p<4;p++){ if(!players[p].alive) continue;
    for (const [bid, q] of [...players[p].queues]){ const b=sites.find(s=>s.id===bid);
      if (!b || b.owner!==p){ players[p].queues.delete(bid); if(b) players[p].resources += COST[q.type]; continue; }
      if (q.ticksLeft>0){ q.ticksLeft--; continue; }
      const c=freeNeighbor(b.x,b.y);
      if(!c) continue;
      const u={id:nid(),owner:p,type:q.type,x:c.x,y:c.y,hp:HP[q.type],carrying:0};
      units.set(u.id,u); players[p].units.push(u.id); players[p].queues.delete(bid); } }
  // 5. evaluate
  for (let p=0;p<4;p++){ if(!players[p].alive) continue;
    if (players[p].units.length===0 && !sites.some(s=>s.kind==='base'&&s.owner===p)){
      players[p].alive=false; for(const s of sites) if(s.owner===p){s.owner=-1;s.progressOwner=-1;s.progress=0;} } }
  const alive = players.filter(p=>p.alive);
  if (alive.length===1) winner = 'shortcut:'+alive[0].index;
  else if (sites.every(s=>s.owner===alive[0]?.index) && alive.length>0) winner='all-sites:'+alive[0].index;
}
console.log('tick', sim.tick, 'winner', winner, 'exceptions', exceptions,
  'alive', players.map(p=>`${p.index}:${p.alive?'A':'x'} u${p.units.length} r${p.resources} b${sites.filter(s=>s.kind==='base'&&s.owner===p.index).length} e${sites.filter(s=>s.kind==='resource'&&s.owner===p.index).length}`).join(' | '));
