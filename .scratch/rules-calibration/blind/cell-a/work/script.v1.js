// ===== rules-v1 参赛脚本（初版 v1）=====
// 策略取向：A 爆兵压制——优先生产战斗单位，尽早争夺与压制。
// 自认候选：A（快照 players 数组顺序=座位）；实现上以 move() 返回值探测兜底。
// 轮转方向假设：值大者胜，(tick + playerIndex) mod 4 大者取得同格竞争。

type UnitType = 'worker' | 'melee' | 'ranged' | 'cavalry';

const CARRY_LIMIT: number = 20;
const WORKER_TARGET: number = 3;
const BIG: number = 1000000000;

const DIRS: number[][] = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1]
];

let MY_INDEX: number = -1;

// 快照无 productions 查询接口，本地记录自己下过的生产单，避免重复下单。
let pendingBaseIds: number[] = [];
let pendingLeft: number[] = [];
let pendingTypes: string[] = [];

function spawnTicksOf(t: string): number {
  if (t === 'worker') return 2;
  if (t === 'melee') return 4;
  if (t === 'ranged') return 6;
  return 8;
}

function rangeOf(t: string): number {
  if (t === 'ranged') return 2;
  return 1;
}

function isError(r: unknown): boolean {
  if (r === undefined || r === null) return false;
  if (typeof r === 'string') return true;
  if (typeof r === 'object') {
    const o: any = r;
    if (typeof o.err === 'string' || o.ok === false) return true;
  }
  return false;
}

// 候选 A：players 数组顺序=座位。容器拿不到自身下标，故先按 owner 探测：
// 对某方单位发 move(0,0)，合法（非错误）返回者即己方。全部无差别则退回 A=0。
function detectMyIndex(): number {
  for (let idx = 0; idx < 4; idx++) {
    const us: any[] = getObjectsByType('unit', { owner: idx as any }) as any[];
    if (!us || us.length === 0) continue;
    const r: any = move(us[0].id, 0, 0);
    if (!isError(r)) return idx;
  }
  return 0;
}

function nearestBy(u: any, arr: any[]): any {
  let best: any = null;
  let bd: number = BIG;
  let bid: number = BIG;
  for (let i = 0; i < arr.length; i++) {
    const o: any = arr[i];
    const d: number = getRange(u.x, u.y, o.x, o.y);
    if (d < bd || (d === bd && o.id < bid)) {
      bd = d;
      bid = o.id;
      best = o;
    }
  }
  return best;
}

function nearestEnemyUnit(u: any, arr: any[]): any {
  let best: any = null;
  let bd: number = BIG;
  let bhp: number = BIG;
  let bid: number = BIG;
  for (let i = 0; i < arr.length; i++) {
    const o: any = arr[i];
    const d: number = getRange(u.x, u.y, o.x, o.y);
    const better: boolean =
      d < bd || (d === bd && (o.hp < bhp || (o.hp === bhp && o.id < bid)));
    if (better) {
      bd = d;
      bhp = o.hp;
      bid = o.id;
      best = o;
    }
  }
  return best;
}

function pickAdjacentFree(x: number, y: number, allUnits: any[]): any {
  for (let i = 0; i < DIRS.length; i++) {
    const nx: number = x + DIRS[i][0];
    const ny: number = y + DIRS[i][1];
    if (getTerrainAt(nx, ny) !== 'plain') continue;
    let occ: boolean = false;
    for (let j = 0; j < allUnits.length; j++) {
      if (allUnits[j].x === nx && allUnits[j].y === ny) {
        occ = true;
        break;
      }
    }
    if (!occ) return { x: nx, y: ny };
  }
  return null;
}

function deliver(u: any, ownBases: any[]): void {
  const base: any = nearestBy(u, ownBases);
  if (!base) return;
  if (getRange(u.x, u.y, base.x, base.y) <= 1) transfer(u.id);
  else moveTo(u.id, base.x, base.y);
}

function actWorker(
  u: any,
  ownBases: any[],
  ownRes: any[],
  neutralRes: any[],
  allUnits: any[]
): void {
  if (u.carrying >= CARRY_LIMIT) {
    deliver(u, ownBases);
    return;
  }
  const site: any = nearestBy(u, ownRes);
  if (site) {
    const d: number = getRange(u.x, u.y, site.x, site.y);
    const onSite: boolean = u.x === site.x && u.y === site.y;
    if (d <= 1 && !onSite) {
      harvest(u.id, site.id);
      return;
    }
    const cell: any = pickAdjacentFree(site.x, site.y, allUnits);
    if (cell) {
      moveTo(u.id, cell.x, cell.y);
      return;
    }
    moveTo(u.id, site.x, site.y);
    return;
  }
  const ns: any = nearestBy(u, neutralRes);
  if (ns) {
    moveTo(u.id, ns.x, ns.y);
    return;
  }
  if (u.carrying > 0) {
    deliver(u, ownBases);
    return;
  }
  const base: any = nearestBy(u, ownBases);
  if (base) moveTo(u.id, base.x, base.y);
}

function actCombat(u: any, enemyUnits: any[], enemySites: any[]): void {
  const e: any = nearestEnemyUnit(u, enemyUnits);
  if (e) {
    const d: number = getRange(u.x, u.y, e.x, e.y);
    if (d <= rangeOf(u.type)) {
      attack(u.id, e.id);
      return;
    }
    moveTo(u.id, e.x, e.y);
    return;
  }
  const s: any = nearestBy(u, enemySites);
  if (s) moveTo(u.id, s.x, s.y);
}

function actProduce(ownBases: any[], ownUnits: any[]): void {
  let workers: number = 0;
  let melee: number = 0;
  let ranged: number = 0;
  for (let i = 0; i < ownUnits.length; i++) {
    const t: string = ownUnits[i].type;
    if (t === 'worker') workers++;
    else if (t === 'melee') melee++;
    else if (t === 'ranged') ranged++;
  }
  for (let i = 0; i < pendingTypes.length; i++) {
    const t: string = pendingTypes[i];
    if (t === 'worker') workers++;
    else if (t === 'melee') melee++;
    else if (t === 'ranged') ranged++;
  }
  for (let b = 0; b < ownBases.length; b++) {
    const base: any = ownBases[b];
    let busy: boolean = false;
    for (let p = 0; p < pendingBaseIds.length; p++) {
      if (pendingBaseIds[p] === base.id) {
        busy = true;
        break;
      }
    }
    if (busy) continue;
    let type: string = 'melee';
    if (workers < WORKER_TARGET) type = 'worker';
    else if ((melee + ranged) % 5 === 4) type = 'ranged';
    const r: any = spawnUnit(base.id, type as UnitType);
    if (!isError(r)) {
      pendingBaseIds.push(base.id);
      pendingLeft.push(spawnTicksOf(type));
      pendingTypes.push(type);
      if (type === 'worker') workers++;
      else if (type === 'melee') melee++;
      else if (type === 'ranged') ranged++;
    }
  }
}

function loop(): void {
  if (MY_INDEX < 0) MY_INDEX = detectMyIndex();
  const me: number = MY_INDEX;

  const nB: number[] = [];
  const nL: number[] = [];
  const nT: string[] = [];
  for (let i = 0; i < pendingBaseIds.length; i++) {
    const left: number = pendingLeft[i] - 1;
    if (left > 0) {
      nB.push(pendingBaseIds[i]);
      nL.push(left);
      nT.push(pendingTypes[i]);
    }
  }
  pendingBaseIds = nB;
  pendingLeft = nL;
  pendingTypes = nT;

  const allUnits: any[] = getObjectsByType('unit') as any[];
  const allSites: any[] = getObjectsByType('site') as any[];

  const ownUnits: any[] = [];
  const enemyUnits: any[] = [];
  for (let i = 0; i < allUnits.length; i++) {
    if (allUnits[i].owner === me) ownUnits.push(allUnits[i]);
    else enemyUnits.push(allUnits[i]);
  }

  const ownBases: any[] = [];
  const ownRes: any[] = [];
  const neutralRes: any[] = [];
  const enemySites: any[] = [];
  for (let i = 0; i < allSites.length; i++) {
    const s: any = allSites[i];
    if (s.kind === 'base') {
      if (s.owner === me) ownBases.push(s);
    } else if (s.owner === me) {
      ownRes.push(s);
    } else if (s.owner === -1) {
      neutralRes.push(s);
    }
    if (s.owner !== me) enemySites.push(s);
  }

  for (let i = 0; i < ownUnits.length; i++) {
    const u: any = ownUnits[i];
    if (u.type === 'worker') actWorker(u, ownBases, ownRes, neutralRes, allUnits);
    else actCombat(u, enemyUnits, enemySites);
  }

  actProduce(ownBases, ownUnits);
}
