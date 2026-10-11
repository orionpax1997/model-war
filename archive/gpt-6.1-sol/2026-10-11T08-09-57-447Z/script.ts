var militaryStage = 0;
var campaignId = -1;

type PointValue = { x: number; y: number };

function squareDistance(a: PointValue, b: PointValue): number {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  return dx > dy ? dx : dy;
}

function accepted(result: void | ErrResult): boolean {
  if (isError(result)) {
    const code = errCode(result);
    if (code === ERR_NOT_ENOUGH_RESOURCES) {
      return false;
    }
    return false;
  }
  return true;
}

function advance(
  unit: Unit,
  target: PointValue,
  occupied: ReadonlySet<string>,
  reserved: Set<string>,
  tick: number,
): void {
  if (unit.x === target.x && unit.y === target.y) {
    return;
  }

  const dx: -1 | 0 | 1 =
    target.x < unit.x ? -1 : target.x > unit.x ? 1 : 0;
  const dy: -1 | 0 | 1 =
    target.y < unit.y ? -1 : target.y > unit.y ? 1 : 0;
  const nextX = unit.x + dx;
  const nextY = unit.y + dy;
  const key = nextX + ":" + nextY;

  if (!occupied.has(key) && !reserved.has(key)) {
    if (getTerrainAt(nextX, nextY) === "plain") {
      if (accepted(move(unit.id, dx, dy))) {
        reserved.add(key);
      }
      return;
    }
    moveTo(unit.id, target.x, target.y);
    return;
  }

  const directionStart = (tick + unit.id) % 8;
  let bestDx: -1 | 0 | 1 = 0;
  let bestDy: -1 | 0 | 1 = 0;
  let bestDistance = 1000000000;
  let found = false;

  for (let n = 0; n < 8; n += 1) {
    const direction = (directionStart + n) % 8;
    const sx: -1 | 0 | 1 =
      direction === 0 || direction === 1 || direction === 7 ? 1 :
      direction === 3 || direction === 4 || direction === 5 ? -1 : 0;
    const sy: -1 | 0 | 1 =
      direction === 1 || direction === 2 || direction === 3 ? 1 :
      direction === 5 || direction === 6 || direction === 7 ? -1 : 0;
    const x = unit.x + sx;
    const y = unit.y + sy;
    const nextKey = x + ":" + y;
    if (occupied.has(nextKey) || reserved.has(nextKey)) {
      continue;
    }
    const ax = Math.abs(target.x - x);
    const ay = Math.abs(target.y - y);
    const distance = ax > ay ? ax : ay;
    if (distance >= bestDistance || getTerrainAt(x, y) !== "plain") {
      continue;
    }
    found = true;
    bestDistance = distance;
    bestDx = sx;
    bestDy = sy;
  }

  if (found && accepted(move(unit.id, bestDx, bestDy))) {
    reserved.add((unit.x + bestDx) + ":" + (unit.y + bestDy));
  }
}

function loop(): void {
  const me = getMyIndex();
  const tick = getTick();
  const players = getObjectsByType("player");
  let money = 0;
  let alive = false;
  for (let i = 0; i < players.length && i < 4; i += 1) {
    const player = players[i];
    if (player !== undefined && player.index === me) {
      money = player.resources;
      alive = player.alive;
      break;
    }
  }
  if (!alive) {
    return;
  }

  const own = getObjectsByType("unit", { owner: me });
  const all = getObjectsByType("unit");
  const sites = getObjectsByType("site");
  const bases = getObjectsByType("site", { owner: me, kind: "base" });
  const mines = getObjectsByType("site", { owner: me, kind: "resource" });
  const occupied = new Set<string>();
  const reserved = new Set<string>();
  const enemies: Unit[] = [];
  const mineLoads = new Map<number, number>();
  const claimed = new Set<number>();

  let workers = 0;
  let melee = 0;
  let ranged = 0;
  let cavalry = 0;
  let pendingWorkers = 0;
  let pendingMelee = 0;
  let pendingRanged = 0;
  let productive = 0;

  for (let i = 0; i < all.length && i < 192; i += 1) {
    const unit = all[i];
    if (unit === undefined) {
      continue;
    }
    occupied.add(unit.x + ":" + unit.y);
    if (unit.owner !== me && enemies.length < 24) {
      enemies.push(unit);
    }
  }

  for (let i = 0; i < own.length && i < 128; i += 1) {
    const unit = own[i];
    if (unit === undefined) {
      continue;
    }
    if (unit.type === "worker") {
      workers += 1;
    } else if (unit.type === "melee") {
      melee += 1;
    } else if (unit.type === "ranged") {
      ranged += 1;
    } else {
      cavalry += 1;
    }
  }

  for (let i = 0; i < mines.length && i < 24; i += 1) {
    const mine = mines[i];
    if (mine !== undefined && mine.remaining !== undefined && mine.remaining > 0) {
      productive += 1;
    }
  }

  for (let i = 0; i < bases.length && i < 8; i += 1) {
    const base = bases[i];
    if (base === undefined || base.producing === null) {
      continue;
    }
    if (base.producing.type === "worker") {
      pendingWorkers += 1;
    } else if (base.producing.type === "melee") {
      pendingMelee += 1;
    } else if (base.producing.type === "ranged") {
      pendingRanged += 1;
    }
  }

  const firstBase = bases[0];
  const firstUnit = own[0];
  const home: PointValue | null =
    firstBase !== undefined ? firstBase :
    firstUnit !== undefined ? firstUnit : null;
  if (home === null) {
    return;
  }

  let threat: Unit | null = null;
  let threatDistance = 1000000000;
  for (let i = 0; i < enemies.length; i += 1) {
    const enemy = enemies[i];
    if (enemy === undefined) {
      continue;
    }
    const d = squareDistance(home, enemy);
    if (d <= 6 && d < threatDistance) {
      threat = enemy;
      threatDistance = d;
    }
  }

  const soldiers = melee + ranged + cavalry;
  const workerTarget = productive > 0 ? Math.min(8, productive * 2 + 2) : 2;
  if (
    militaryStage === 0 &&
    workers >= Math.min(6, workerTarget) &&
    soldiers >= 6 &&
    money >= 12 &&
    tick >= 40
  ) {
    militaryStage = 1;
  }

  let campaign: Site | null = null;
  let campaignScore = 1000000000;
  const siteStart = sites.length === 0 ? 0 : tick % sites.length;
  for (let i = 0; i < sites.length && i < 32; i += 1) {
    const site = sites[(siteStart + i) % sites.length];
    if (site === undefined || site.owner === me) {
      continue;
    }
    if (militaryStage === 0 && bases.length > 0 && site.owner !== -1) {
      continue;
    }
    let score = squareDistance(home, site) * 5;
    if (site.owner !== -1) {
      score += 24;
    }
    if (site.kind === "base") {
      score -= bases.length === 0 ? 1000 : 12;
    }
    if (site.id === campaignId) {
      score -= 16;
    }
    if (site.progressOwner === me) {
      score -= site.progress * 2;
    }
    if (score < campaignScore) {
      campaign = site;
      campaignScore = score;
    }
  }
  campaignId = campaign === null ? -1 : campaign.id;

  let expansionWorkers = 0;
  const start = own.length === 0 ? 0 : tick % own.length;
  for (let step = 0; step < own.length && step < 20; step += 1) {
    const unit = own[(start + step) % own.length];
    if (unit === undefined) {
      continue;
    }

    if (unit.type === "worker") {
      let base: Site | null = null;
      let baseDistance = 1000000000;
      for (let j = 0; j < bases.length && j < 8; j += 1) {
        const candidate = bases[j];
        if (candidate === undefined) {
          continue;
        }
        const d = squareDistance(unit, candidate);
        if (d < baseDistance) {
          base = candidate;
          baseDistance = d;
        }
      }

      if (unit.carrying > 0 && base !== null && baseDistance <= 1) {
        transfer(unit.id);
        continue;
      }

      let danger: Unit | null = null;
      let dangerDistance = 5;
      for (let j = 0; j < enemies.length; j += 1) {
        const enemy = enemies[j];
        if (enemy === undefined || enemy.type === "worker") {
          continue;
        }
        const d = squareDistance(unit, enemy);
        if (d < dangerDistance) {
          danger = enemy;
          dangerDistance = d;
        }
      }
      if (danger !== null) {
        const sx = unit.x < danger.x ? -3 : unit.x > danger.x ? 3 : 0;
        const sy = unit.y < danger.y ? -3 : unit.y > danger.y ? 3 : 0;
        const retreat = dangerDistance <= 2 ?
          { x: unit.x + sx, y: unit.y + sy } :
          base === null ? home : base;
        advance(unit, retreat, occupied, reserved, tick);
        continue;
      }

      let mine: Site | null = null;
      let mineScore = 1000000000;
      for (let j = 0; j < mines.length && j < 24; j += 1) {
        const candidate = mines[j];
        if (
          candidate === undefined ||
          candidate.remaining === undefined ||
          candidate.remaining <= 0
        ) {
          continue;
        }
        const d = squareDistance(unit, candidate);
        const score = d * 4 + (mineLoads.get(candidate.id) ?? 0) * 16;
        if (score < mineScore) {
          mine = candidate;
          mineScore = score;
        }
      }

      if (
        unit.carrying >= 20 ||
        (unit.carrying > 0 && mine === null) ||
        (unit.carrying >= 8 && money < 4)
      ) {
        if (base !== null) {
          advance(unit, base, occupied, reserved, tick);
        } else if (campaign !== null) {
          advance(unit, campaign, occupied, reserved, tick);
        }
        continue;
      }

      if (
        campaign !== null &&
        campaign.owner === -1 &&
        unit.carrying === 0 &&
        expansionWorkers === 0 &&
        !claimed.has(campaign.id) &&
        (workers >= 4 || mine === null) &&
        (bases.length === 0 || squareDistance(home, campaign) <= 16) &&
        (
          !occupied.has(campaign.x + ":" + campaign.y) ||
          (unit.x === campaign.x && unit.y === campaign.y)
        )
      ) {
        expansionWorkers += 1;
        claimed.add(campaign.id);
        advance(unit, campaign, occupied, reserved, tick);
        continue;
      }

      if (mine !== null) {
        mineLoads.set(mine.id, (mineLoads.get(mine.id) ?? 0) + 1);
        const d = squareDistance(unit, mine);
        if (d <= 1) {
          harvest(unit.id, mine.id);
        } else {
          advance(unit, mine, occupied, reserved, tick);
        }
        continue;
      }

      if (base !== null && baseDistance === 0) {
        const goal = campaign === null ?
          { x: base.x + 2, y: base.y } : campaign;
        advance(unit, goal, occupied, reserved, tick);
      } else if (bases.length === 0 && campaign !== null) {
        advance(unit, campaign, occupied, reserved, tick);
      }
      continue;
    }

    const range = unit.type === "ranged" ? 2 : 1;
    let victim: Unit | null = null;
    let victimScore = 1000000000;
    for (let j = 0; j < enemies.length; j += 1) {
      const enemy = enemies[j];
      if (enemy === undefined || squareDistance(unit, enemy) > range) {
        continue;
      }
      const score = enemy.hp * 3 - (enemy.type === "worker" ? 8 : 0);
      if (score < victimScore) {
        victim = enemy;
        victimScore = score;
      }
    }
    if (victim !== null) {
      if (getRange(unit.x, unit.y, victim.x, victim.y) <= range) {
        attack(unit.id, victim.id);
        continue;
      }
    }

    if (threat !== null) {
      advance(unit, threat, occupied, reserved, tick);
    } else if (campaign !== null) {
      if (claimed.has(campaign.id) && squareDistance(unit, campaign) <= 2) {
        if (firstBase !== undefined && unit.x === firstBase.x && unit.y === firstBase.y) {
          advance(
            unit,
            { x: firstBase.x + 2, y: firstBase.y },
            occupied,
            reserved,
            tick,
          );
        }
      } else {
        advance(unit, campaign, occupied, reserved, tick);
      }
    } else {
      const mine = mines[0];
      const rally = mine !== undefined ? mine :
        { x: home.x + 2, y: home.y };
      advance(unit, rally, occupied, reserved, tick);
    }
  }

  for (let i = 0; i < bases.length && i < 4; i += 1) {
    const base = bases[i];
    if (base === undefined || base.producing !== null) {
      continue;
    }
    const totalWorkers = workers + pendingWorkers;
    const totalMelee = melee + pendingMelee;
    const totalRanged = ranged + pendingRanged;
    let choice: UnitType = "melee";
    let cost = 8;

    if (
      totalWorkers === 0 ||
      (
        productive > 0 &&
        totalWorkers < workerTarget &&
        (
          totalWorkers < 4 ||
          (threat === null && totalMelee + totalRanged >= 2)
        )
      )
    ) {
      choice = "worker";
      cost = 4;
    } else if (
      militaryStage > 0 &&
      totalMelee >= 6 &&
      totalRanged * 4 < totalMelee &&
      money >= 16
    ) {
      choice = "ranged";
      cost = 12;
    }

    const reserve = choice !== "worker" && totalWorkers < 3 ? 4 : 0;
    if (money < cost + reserve) {
      continue;
    }

    if (accepted(spawnUnit(base.id, choice))) {
      money -= cost;
      if (choice === "worker") {
        pendingWorkers += 1;
      } else if (choice === "melee") {
        pendingMelee += 1;
      } else {
        pendingRanged += 1;
      }
    }
  }
}