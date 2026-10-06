"use strict";
(() => {
  // packages/engine/src/pathfinding/find-path.ts
  var STEP = 2;
  var HEURISTIC_SCALE = 2;
  var DIRECTIONS = [
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1]
  ];
  var indexOf = (x, y, size) => y * size + x;
  var passable = (terrain, size, x, y) => {
    if (x < 0 || y < 0 || x >= size || y >= size) {
      return false;
    }
    return terrain[y]?.[x] !== true;
  };
  var heuristic = (from, to) => HEURISTIC_SCALE * Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y));
  var less = (left, right, f) => f[left] < f[right] || f[left] === f[right] && left < right;
  var heapPush = (heap, node, f) => {
    heap.push(node);
    let at = heap.length - 1;
    while (at > 0) {
      const parent = at - 1 >> 1;
      if (!less(heap[at], heap[parent], f)) {
        break;
      }
      [heap[at], heap[parent]] = [heap[parent], heap[at]];
      at = parent;
    }
  };
  var heapPop = (heap, f) => {
    if (heap.length === 0) {
      return void 0;
    }
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let at = 0;
      for (; ; ) {
        const left = at * 2 + 1;
        const right = left + 1;
        let smallest = at;
        if (left < heap.length && less(heap[left], heap[smallest], f)) {
          smallest = left;
        }
        if (right < heap.length && less(heap[right], heap[smallest], f)) {
          smallest = right;
        }
        if (smallest === at) {
          break;
        }
        [heap[at], heap[smallest]] = [heap[smallest], heap[at]];
        at = smallest;
      }
    }
    return top;
  };
  var findPath = (terrain, size, from, to) => {
    if (!passable(terrain, size, to.x, to.y)) {
      return null;
    }
    if (from.x === to.x && from.y === to.y) {
      return [{ x: from.x, y: from.y }];
    }
    const count = size * size;
    const best = new Int32Array(count).fill(-1);
    const estimate = new Int32Array(count).fill(-1);
    const parent = new Int32Array(count).fill(-1);
    const closed = new Uint8Array(count);
    const start = indexOf(from.x, from.y, size);
    const goal = indexOf(to.x, to.y, size);
    best[start] = 0;
    estimate[start] = heuristic(from, to);
    const open = [];
    heapPush(open, start, estimate);
    while (true) {
      const current = heapPop(open, estimate);
      if (current === void 0) {
        return null;
      }
      if (current === goal) {
        break;
      }
      if (closed[current] === 1) {
        continue;
      }
      closed[current] = 1;
      const cx = current % size;
      const cy = Math.floor(current / size);
      for (const [dx, dy] of DIRECTIONS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!passable(terrain, size, nx, ny)) {
          continue;
        }
        const next = indexOf(nx, ny, size);
        if (closed[next] === 1) {
          continue;
        }
        const tentative = best[current] + STEP;
        if (best[next] === -1 || tentative < best[next]) {
          best[next] = tentative;
          parent[next] = current;
          estimate[next] = tentative + heuristic({ x: nx, y: ny }, to);
          heapPush(open, next, estimate);
        }
      }
    }
    const path = [];
    let node = goal;
    while (node !== -1) {
      path.push({ x: node % size, y: Math.floor(node / size) });
      node = parent[node];
    }
    return path.reverse();
  };

  // packages/engine/src/world/state.ts
  var UNIT_TYPES = ["worker", "melee", "ranged", "cavalry"];
  var isUnitType = (value) => UNIT_TYPES.includes(value);

  // packages/engine/src/processor/intent-verdicts.ts
  var INTENT_ERR_CODES = [
    "ERR_NOT_ENOUGH_RESOURCES",
    "ERR_INVALID_UNIT",
    "ERR_NOT_OWNER",
    "ERR_OUT_OF_RANGE",
    "ERR_INVALID_TARGET",
    "ERR_INVALID_SITE",
    "ERR_BAD_ARGS"
  ];
  var OK = { ok: true };
  var SILENT = { ok: false, code: null };
  var fail = (code) => ({ ok: false, code });
  var unitById = (view, id) => view.units.find((unit) => unit.id === id);
  var siteById = (view, id) => view.sites.find((site) => site.id === id);
  var playerOf = (view, seat2) => view.players.find((player) => player.index === seat2);
  var costOf = (ruleset, unitType) => ruleset.statsOf(unitType).cost;
  var chebyshev = (left, right) => Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
  var canHarvest = (unit) => unit.type === "worker";
  var inBounds = (view, x, y) => x >= 0 && y >= 0 && x < view.size && y < view.size;
  var isWall = (view, x, y) => view.terrain[y]?.[x] === true;
  var moveTargetOf = (unit, intent) => {
    if (intent.kind === "moveTo") {
      return { x: intent.x, y: intent.y };
    }
    if (intent.dx === 0 && intent.dy === 0) {
      return null;
    }
    return { x: unit.x + intent.dx, y: unit.y + intent.dy };
  };
  var nearestFriendlyResourceSite = (view, seat2, unit, ruleset) => {
    const range = ruleset.statsOf(unit.type).range;
    for (const site of view.sites) {
      if (site.kind !== "resource" || site.owner !== seat2) {
        continue;
      }
      if ((site.remaining ?? 0) <= 0) {
        continue;
      }
      if (chebyshev(unit, site) <= range) {
        return site;
      }
    }
    return void 0;
  };
  var nearestFriendlyBaseSite = (view, seat2, unit, ruleset) => {
    const range = ruleset.statsOf(unit.type).range;
    for (const site of view.sites) {
      if (site.kind !== "base" || site.owner !== seat2) {
        continue;
      }
      if (chebyshev(unit, site) <= range) {
        return site;
      }
    }
    return void 0;
  };
  var moveVerdict = (view, seat2, intent) => {
    const unit = unitById(view, intent.unitId);
    if (unit === void 0) {
      return fail("ERR_INVALID_UNIT");
    }
    if (unit.owner !== seat2) {
      return fail("ERR_NOT_OWNER");
    }
    if (intent.kind === "move" && (Math.abs(intent.dx) > 1 || Math.abs(intent.dy) > 1)) {
      return fail("ERR_BAD_ARGS");
    }
    const target = moveTargetOf(unit, intent);
    if (target === null) {
      return fail("ERR_BAD_ARGS");
    }
    if (!inBounds(view, target.x, target.y) || isWall(view, target.x, target.y)) {
      return fail("ERR_INVALID_TARGET");
    }
    return OK;
  };
  var attackVerdict = (view, seat2, rules2, intent) => {
    const attacker = unitById(view, intent.unitId);
    if (attacker === void 0) {
      return fail("ERR_INVALID_UNIT");
    }
    if (attacker.owner !== seat2) {
      return fail("ERR_NOT_OWNER");
    }
    if (rules2 !== null && rules2.statsOf(attacker.type).damage <= 0) {
      return fail("ERR_INVALID_TARGET");
    }
    if (siteById(view, intent.targetId) !== void 0) {
      return fail("ERR_INVALID_TARGET");
    }
    const target = unitById(view, intent.targetId);
    if (target === void 0) {
      return fail("ERR_INVALID_UNIT");
    }
    if (target.owner === seat2) {
      return fail("ERR_INVALID_TARGET");
    }
    if (rules2 !== null && chebyshev(attacker, target) > rules2.statsOf(attacker.type).range) {
      return fail("ERR_OUT_OF_RANGE");
    }
    return OK;
  };
  var harvestVerdict = (view, seat2, rules2, intent) => {
    const unit = unitById(view, intent.unitId);
    if (unit === void 0) {
      return fail("ERR_INVALID_UNIT");
    }
    if (unit.owner !== seat2) {
      return fail("ERR_NOT_OWNER");
    }
    if (!canHarvest(unit)) {
      return fail("ERR_INVALID_UNIT");
    }
    if (rules2 !== null && unit.carrying >= rules2.raw.carryLimit) {
      return fail("ERR_INVALID_TARGET");
    }
    if (rules2 === null) {
      return OK;
    }
    if (nearestFriendlyResourceSite(view, seat2, unit, rules2) === void 0) {
      return fail("ERR_INVALID_SITE");
    }
    return OK;
  };
  var transferVerdict = (view, seat2, rules2, intent) => {
    const unit = unitById(view, intent.unitId);
    if (unit === void 0) {
      return fail("ERR_INVALID_UNIT");
    }
    if (unit.owner !== seat2) {
      return fail("ERR_NOT_OWNER");
    }
    if (unit.carrying <= 0) {
      return fail("ERR_INVALID_TARGET");
    }
    if (rules2 !== null && nearestFriendlyBaseSite(view, seat2, unit, rules2) === void 0) {
      return fail("ERR_INVALID_SITE");
    }
    return OK;
  };
  var spawnVerdict = (view, seat2, rules2, intent) => {
    const site = siteById(view, intent.baseId);
    if (site === void 0) {
      return fail("ERR_INVALID_SITE");
    }
    if (site.kind !== "base") {
      return fail("ERR_INVALID_SITE");
    }
    if (site.owner !== seat2) {
      return fail("ERR_NOT_OWNER");
    }
    const player = playerOf(view, seat2);
    if (player === void 0) {
      return fail("ERR_INVALID_SITE");
    }
    if (rules2 !== null && player.resources < costOf(rules2, intent.unitType)) {
      return fail("ERR_NOT_ENOUGH_RESOURCES");
    }
    if (site.producing !== null) {
      return SILENT;
    }
    return OK;
  };

  // packages/engine/src/sandbox-runtime/index.ts
  var guest = globalThis;
  var setup = guest["__setSnapshot"];
  var seat = setup?.seat ?? 0;
  var injectedRuleset = setup?.ruleset;
  var rules = injectedRuleset === void 0 ? null : { raw: injectedRuleset, statsOf: (unitType) => injectedRuleset[unitType] };
  var snapshot = null;
  var pending = [];
  var apiCalls = 0;
  var EMPTY = { tick: -1, size: 0, terrain: [], players: [], units: [], sites: [] };
  var world = () => snapshot ?? EMPTY;
  guest["__setSnapshot"] = (next) => {
    snapshot = next;
    pending = [];
    apiCalls = 0;
  };
  guest["__drainIntents"] = () => {
    const drained = pending;
    pending = [];
    return { intents: drained, apiCalls };
  };
  guest.getTick = () => {
    apiCalls += 1;
    return snapshot === null ? -1 : snapshot.tick;
  };
  guest.getObjectById = (id) => {
    apiCalls += 1;
    if (snapshot === null) {
      return null;
    }
    const unit = snapshot.units.find((candidate) => candidate.id === id);
    if (unit !== void 0) {
      return unit;
    }
    return snapshot.sites.find((candidate) => candidate.id === id) ?? null;
  };
  guest.getObjectsByType = (kind, filter) => {
    apiCalls += 1;
    if (snapshot === null) {
      return [];
    }
    if (kind === "unit") {
      return snapshot.units.filter(
        (unit) => (filter?.owner === void 0 || unit.owner === filter.owner) && (filter?.type === void 0 || unit.type === filter.type)
      );
    }
    if (kind === "site") {
      return snapshot.sites.filter(
        (site) => (filter?.owner === void 0 || site.owner === filter.owner) && (filter?.kind === void 0 || site.kind === filter.kind)
      );
    }
    if (kind === "player") {
      const players = snapshot.players.filter(
        (player) => filter?.owner === void 0 || player.index === filter.owner
      );
      return players;
    }
    return [];
  };
  guest.getRange = (ax, ay, bx, by) => {
    apiCalls += 1;
    return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
  };
  guest.getTerrainAt = (x, y) => {
    apiCalls += 1;
    if (snapshot === null || x < 0 || y < 0 || x >= snapshot.size || y >= snapshot.size) {
      return "out";
    }
    return snapshot.terrain[y]?.[x] === true ? "wall" : "plain";
  };
  guest.findPath = (sx, sy, tx, ty) => {
    apiCalls += 1;
    if (snapshot === null) {
      return null;
    }
    return findPath(snapshot.terrain, snapshot.size, { x: sx, y: sy }, { x: tx, y: ty });
  };
  var settle = (verdict, intent) => {
    pending.push(intent);
    if (verdict.ok || verdict.code === null) {
      return void 0;
    }
    return { code: verdict.code };
  };
  guest.move = (unitId, dx, dy) => {
    apiCalls += 1;
    const intent = { kind: "move", unitId, dx, dy };
    return settle(moveVerdict(world(), seat, intent), intent);
  };
  guest.moveTo = (unitId, x, y) => {
    apiCalls += 1;
    const intent = { kind: "moveTo", unitId, x, y };
    return settle(moveVerdict(world(), seat, intent), intent);
  };
  guest.attack = (unitId, targetId) => {
    apiCalls += 1;
    const intent = { kind: "attack", unitId, targetId };
    return settle(attackVerdict(world(), seat, rules, intent), intent);
  };
  guest.harvest = (unitId, siteId) => {
    apiCalls += 1;
    const intent = { kind: "harvest", unitId, siteId };
    return settle(harvestVerdict(world(), seat, rules, intent), intent);
  };
  guest.transfer = (unitId) => {
    apiCalls += 1;
    const intent = { kind: "transfer", unitId };
    return settle(transferVerdict(world(), seat, rules, intent), intent);
  };
  guest.spawnUnit = (baseId, unitType) => {
    apiCalls += 1;
    if (!isUnitType(unitType)) {
      return { code: "ERR_BAD_ARGS" };
    }
    const intent = { kind: "spawnUnit", baseId, unitType };
    return settle(spawnVerdict(world(), seat, rules, intent), intent);
  };
  guest.getMyIndex = () => seat;
  guest.isError = (result) => result !== null && typeof result === "object";
  guest.errCode = (result) => result.code;
  for (const code of INTENT_ERR_CODES) {
    guest[code] = code;
  }
})();
