"use strict";
(() => {
  // packages/engine/src/pathfinding/find-path.ts
  var z = 2;
  var ee = 2;
  var ne = [
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1]
  ];
  var w = (e, n, r) => n * r + e;
  var h = (e, n, r, t) => {
    if (r < 0 || t < 0 || r >= n || t >= n) {
      return false;
    }
    return e[t]?.[r] !== true;
  };
  var C = (e, n) => ee * Math.max(Math.abs(e.x - n.x), Math.abs(e.y - n.y));
  var G = (e, n, r) => r[e] < r[n] || r[e] === r[n] && e < n;
  var B = (e, n, r) => {
    e.push(n);
    let t = e.length - 1;
    while (t > 0) {
      const o = t - 1 >> 1;
      if (!G(e[t], e[o], r)) {
        break;
      }
      [e[t], e[o]] = [e[o], e[t]];
      t = o;
    }
  };
  var re = (e, n) => {
    if (e.length === 0) {
      return void 0;
    }
    const r = e[0];
    const t = e.pop();
    if (e.length > 0) {
      e[0] = t;
      let o = 0;
      for (; ; ) {
        const a = o * 2 + 1;
        const u = a + 1;
        let l = o;
        if (a < e.length && G(e[a], e[l], n)) {
          l = a;
        }
        if (u < e.length && G(e[u], e[l], n)) {
          l = u;
        }
        if (l === o) {
          break;
        }
        [e[o], e[l]] = [e[l], e[o]];
        o = l;
      }
    }
    return r;
  };
  var H = (e, n, r, t) => {
    if (!h(e, n, t.x, t.y)) {
      return null;
    }
    if (r.x === t.x && r.y === t.y) {
      return [{ x: r.x, y: r.y }];
    }
    const o = n * n;
    const a = new Int32Array(o).fill(-1);
    const u = new Int32Array(o).fill(-1);
    const l = new Int32Array(o).fill(-1);
    const S = new Uint8Array(o);
    const b = w(r.x, r.y, n);
    const v = w(t.x, t.y, n);
    a[b] = 0;
    u[b] = C(r, t);
    const x = [];
    B(x, b, u);
    while (true) {
      const _ = re(x, u);
      if (_ === void 0) {
        return null;
      }
      if (_ === v) {
        break;
      }
      if (S[_] === 1) {
        continue;
      }
      S[_] = 1;
      const Q = _ % n;
      const X = Math.floor(_ / n);
      for (const [Z, $] of ne) {
        const V = Q + Z;
        const U = X + $;
        if (!h(e, n, V, U)) {
          continue;
        }
        const E = w(V, U, n);
        if (S[E] === 1) {
          continue;
        }
        const D = a[_] + z;
        if (a[E] === -1 || D < a[E]) {
          a[E] = D;
          l[E] = _;
          u[E] = D + C({ x: V, y: U }, t);
          B(x, E, u);
        }
      }
    }
    const g = [];
    let N = v;
    while (N !== -1) {
      g.push({ x: N % n, y: Math.floor(N / n) });
      N = l[N];
    }
    return g.reverse();
  };

  // packages/engine/src/world/state.ts
  var te = ["worker", "melee", "ranged", "cavalry"];
  var M = (e) => te.includes(e);

  // packages/engine/src/processor/intent-verdicts.ts
  var F = [
    "ERR_NOT_ENOUGH_RESOURCES",
    "ERR_INVALID_UNIT",
    "ERR_NOT_OWNER",
    "ERR_OUT_OF_RANGE",
    "ERR_INVALID_TARGET",
    "ERR_INVALID_SITE",
    "ERR_BAD_ARGS"
  ];
  var c = { ok: true };
  var oe = { ok: false, code: null };
  var i = (e) => ({ ok: false, code: e });
  var m = (e, n) => e.units.find((r) => r.id === n);
  var W = (e, n) => e.sites.find((r) => r.id === n);
  var ae = (e, n) => e.players.find((r) => r.index === n);
  var ie = (e, n) => e.statsOf(n).cost;
  var k = (e, n) => Math.max(Math.abs(e.x - n.x), Math.abs(e.y - n.y));
  var Re = (e) => e.type === "worker";
  var de = (e, n, r) => n >= 0 && r >= 0 && n < e.size && r < e.size;
  var se = (e, n, r) => e.terrain[r]?.[n] === true;
  var le = (e, n) => {
    if (n.kind === "moveTo") {
      return { x: n.x, y: n.y };
    }
    if (n.dx === 0 && n.dy === 0) {
      return null;
    }
    return { x: e.x + n.dx, y: e.y + n.dy };
  };
  var ue = (e, n, r, t) => {
    const o = t.statsOf(r.type).range;
    for (const a of e.sites) {
      if (a.kind !== "resource" || a.owner !== n) {
        continue;
      }
      if ((a.remaining ?? 0) <= 0) {
        continue;
      }
      if (k(r, a) <= o) {
        return a;
      }
    }
    return void 0;
  };
  var _e = (e, n, r, t) => {
    const o = t.statsOf(r.type).range;
    for (const a of e.sites) {
      if (a.kind !== "base" || a.owner !== n) {
        continue;
      }
      if (k(r, a) <= o) {
        return a;
      }
    }
    return void 0;
  };
  var L = (e, n, r) => {
    const t = m(e, r.unitId);
    if (t === void 0) {
      return i("ERR_INVALID_UNIT");
    }
    if (t.owner !== n) {
      return i("ERR_NOT_OWNER");
    }
    if (r.kind === "move" && (Math.abs(r.dx) > 1 || Math.abs(r.dy) > 1)) {
      return i("ERR_BAD_ARGS");
    }
    const o = le(t, r);
    if (o === null) {
      return i("ERR_BAD_ARGS");
    }
    if (!de(e, o.x, o.y) || se(e, o.x, o.y)) {
      return i("ERR_INVALID_TARGET");
    }
    return c;
  };
  var j = (e, n, r, t) => {
    const o = m(e, t.unitId);
    if (o === void 0) {
      return i("ERR_INVALID_UNIT");
    }
    if (o.owner !== n) {
      return i("ERR_NOT_OWNER");
    }
    if (r !== null && r.statsOf(o.type).damage <= 0) {
      return i("ERR_INVALID_TARGET");
    }
    if (W(e, t.targetId) !== void 0) {
      return i("ERR_INVALID_TARGET");
    }
    const a = m(e, t.targetId);
    if (a === void 0) {
      return i("ERR_INVALID_UNIT");
    }
    if (a.owner === n) {
      return i("ERR_INVALID_TARGET");
    }
    if (r !== null && k(o, a) > r.statsOf(o.type).range) {
      return i("ERR_OUT_OF_RANGE");
    }
    return c;
  };
  var K = (e, n, r, t) => {
    const o = m(e, t.unitId);
    if (o === void 0) {
      return i("ERR_INVALID_UNIT");
    }
    if (o.owner !== n) {
      return i("ERR_NOT_OWNER");
    }
    if (!Re(o)) {
      return i("ERR_INVALID_UNIT");
    }
    if (r !== null && o.carrying >= r.raw.carryLimit) {
      return i("ERR_INVALID_TARGET");
    }
    if (r === null) {
      return c;
    }
    if (ue(e, n, o, r) === void 0) {
      return i("ERR_INVALID_SITE");
    }
    return c;
  };
  var Y = (e, n, r, t) => {
    const o = m(e, t.unitId);
    if (o === void 0) {
      return i("ERR_INVALID_UNIT");
    }
    if (o.owner !== n) {
      return i("ERR_NOT_OWNER");
    }
    if (o.carrying <= 0) {
      return i("ERR_INVALID_TARGET");
    }
    if (r !== null && _e(e, n, o, r) === void 0) {
      return i("ERR_INVALID_SITE");
    }
    return c;
  };
  var q = (e, n, r, t) => {
    const o = W(e, t.baseId);
    if (o === void 0) {
      return i("ERR_INVALID_SITE");
    }
    if (o.kind !== "base") {
      return i("ERR_INVALID_SITE");
    }
    if (o.owner !== n) {
      return i("ERR_NOT_OWNER");
    }
    const a = ae(e, n);
    if (a === void 0) {
      return i("ERR_INVALID_SITE");
    }
    if (r !== null && a.resources < ie(r, t.unitType)) {
      return i("ERR_NOT_ENOUGH_RESOURCES");
    }
    if (o.producing !== null) {
      return oe;
    }
    return c;
  };

  // packages/engine/src/sandbox-runtime/index.ts
  var R = globalThis;
  var J = R["__setSnapshot"];
  var I = J?.seat ?? 0;
  var P = J?.ruleset;
  var O = P === void 0 ? null : { raw: P, statsOf: (e) => P[e] };
  var d = null;
  var A = [];
  var s = 0;
  var y = {
    move: 0,
    moveTo: 0,
    attack: 0,
    harvest: 0,
    transfer: 0,
    spawnUnit: 0
  };
  var f = {
    move: {
      ERR_NOT_ENOUGH_RESOURCES: 0,
      ERR_INVALID_UNIT: 0,
      ERR_NOT_OWNER: 0,
      ERR_OUT_OF_RANGE: 0,
      ERR_INVALID_TARGET: 0,
      ERR_INVALID_SITE: 0,
      ERR_BAD_ARGS: 0
    },
    moveTo: {
      ERR_NOT_ENOUGH_RESOURCES: 0,
      ERR_INVALID_UNIT: 0,
      ERR_NOT_OWNER: 0,
      ERR_OUT_OF_RANGE: 0,
      ERR_INVALID_TARGET: 0,
      ERR_INVALID_SITE: 0,
      ERR_BAD_ARGS: 0
    },
    attack: {
      ERR_NOT_ENOUGH_RESOURCES: 0,
      ERR_INVALID_UNIT: 0,
      ERR_NOT_OWNER: 0,
      ERR_OUT_OF_RANGE: 0,
      ERR_INVALID_TARGET: 0,
      ERR_INVALID_SITE: 0,
      ERR_BAD_ARGS: 0
    },
    harvest: {
      ERR_NOT_ENOUGH_RESOURCES: 0,
      ERR_INVALID_UNIT: 0,
      ERR_NOT_OWNER: 0,
      ERR_OUT_OF_RANGE: 0,
      ERR_INVALID_TARGET: 0,
      ERR_INVALID_SITE: 0,
      ERR_BAD_ARGS: 0
    },
    transfer: {
      ERR_NOT_ENOUGH_RESOURCES: 0,
      ERR_INVALID_UNIT: 0,
      ERR_NOT_OWNER: 0,
      ERR_OUT_OF_RANGE: 0,
      ERR_INVALID_TARGET: 0,
      ERR_INVALID_SITE: 0,
      ERR_BAD_ARGS: 0
    },
    spawnUnit: {
      ERR_NOT_ENOUGH_RESOURCES: 0,
      ERR_INVALID_UNIT: 0,
      ERR_NOT_OWNER: 0,
      ERR_OUT_OF_RANGE: 0,
      ERR_INVALID_TARGET: 0,
      ERR_INVALID_SITE: 0,
      ERR_BAD_ARGS: 0
    }
  };
  var ye = { tick: -1, size: 0, terrain: [], players: [], units: [], sites: [] };
  var T = () => d ?? ye;
  R["__setSnapshot"] = (e) => {
    d = e;
    A = [];
    s = 0;
    y = { move: 0, moveTo: 0, attack: 0, harvest: 0, transfer: 0, spawnUnit: 0 };
    f = {
      move: {
        ERR_NOT_ENOUGH_RESOURCES: 0,
        ERR_INVALID_UNIT: 0,
        ERR_NOT_OWNER: 0,
        ERR_OUT_OF_RANGE: 0,
        ERR_INVALID_TARGET: 0,
        ERR_INVALID_SITE: 0,
        ERR_BAD_ARGS: 0
      },
      moveTo: {
        ERR_NOT_ENOUGH_RESOURCES: 0,
        ERR_INVALID_UNIT: 0,
        ERR_NOT_OWNER: 0,
        ERR_OUT_OF_RANGE: 0,
        ERR_INVALID_TARGET: 0,
        ERR_INVALID_SITE: 0,
        ERR_BAD_ARGS: 0
      },
      attack: {
        ERR_NOT_ENOUGH_RESOURCES: 0,
        ERR_INVALID_UNIT: 0,
        ERR_NOT_OWNER: 0,
        ERR_OUT_OF_RANGE: 0,
        ERR_INVALID_TARGET: 0,
        ERR_INVALID_SITE: 0,
        ERR_BAD_ARGS: 0
      },
      harvest: {
        ERR_NOT_ENOUGH_RESOURCES: 0,
        ERR_INVALID_UNIT: 0,
        ERR_NOT_OWNER: 0,
        ERR_OUT_OF_RANGE: 0,
        ERR_INVALID_TARGET: 0,
        ERR_INVALID_SITE: 0,
        ERR_BAD_ARGS: 0
      },
      transfer: {
        ERR_NOT_ENOUGH_RESOURCES: 0,
        ERR_INVALID_UNIT: 0,
        ERR_NOT_OWNER: 0,
        ERR_OUT_OF_RANGE: 0,
        ERR_INVALID_TARGET: 0,
        ERR_INVALID_SITE: 0,
        ERR_BAD_ARGS: 0
      },
      spawnUnit: {
        ERR_NOT_ENOUGH_RESOURCES: 0,
        ERR_INVALID_UNIT: 0,
        ERR_NOT_OWNER: 0,
        ERR_OUT_OF_RANGE: 0,
        ERR_INVALID_TARGET: 0,
        ERR_INVALID_SITE: 0,
        ERR_BAD_ARGS: 0
      }
    };
  };
  R["__drainIntents"] = () => {
    const e = A;
    A = [];
    return { intents: e, apiCalls: s, actionFacts: { calls: y, errors: f } };
  };
  R.getTick = () => {
    s += 1;
    return d === null ? -1 : d.tick;
  };
  R.getObjectById = (e) => {
    s += 1;
    if (d === null) {
      return null;
    }
    const n = d.units.find((r) => r.id === e);
    if (n !== void 0) {
      return n;
    }
    return d.sites.find((r) => r.id === e) ?? null;
  };
  R.getObjectsByType = (e, n) => {
    s += 1;
    if (d === null) {
      return [];
    }
    if (e === "unit") {
      return d.units.filter(
        (r) => (n?.owner === void 0 || r.owner === n.owner) && (n?.type === void 0 || r.type === n.type)
      );
    }
    if (e === "site") {
      return d.sites.filter(
        (r) => (n?.owner === void 0 || r.owner === n.owner) && (n?.kind === void 0 || r.kind === n.kind)
      );
    }
    if (e === "player") {
      const r = d.players.filter(
        (t) => n?.owner === void 0 || t.index === n.owner
      );
      return r;
    }
    return [];
  };
  R.getRange = (e, n, r, t) => {
    s += 1;
    return Math.max(Math.abs(e - r), Math.abs(n - t));
  };
  R.getTerrainAt = (e, n) => {
    s += 1;
    if (d === null || e < 0 || n < 0 || e >= d.size || n >= d.size) {
      return "out";
    }
    return d.terrain[n]?.[e] === true ? "wall" : "plain";
  };
  R.findPath = (e, n, r, t) => {
    s += 1;
    if (d === null) {
      return null;
    }
    return H(d.terrain, d.size, { x: e, y: n }, { x: r, y: t });
  };
  var p = (e, n) => {
    A.push(n);
    if (e.ok || e.code === null) {
      return void 0;
    }
    f[n.kind][e.code] += 1;
    return { code: e.code };
  };
  R.move = (e, n, r) => {
    s += 1;
    y.move += 1;
    const t = { kind: "move", unitId: e, dx: n, dy: r };
    return p(L(T(), I, t), t);
  };
  R.moveTo = (e, n, r) => {
    s += 1;
    y.moveTo += 1;
    const t = { kind: "moveTo", unitId: e, x: n, y: r };
    return p(L(T(), I, t), t);
  };
  R.attack = (e, n) => {
    s += 1;
    y.attack += 1;
    const r = { kind: "attack", unitId: e, targetId: n };
    return p(j(T(), I, O, r), r);
  };
  R.harvest = (e, n) => {
    s += 1;
    y.harvest += 1;
    const r = { kind: "harvest", unitId: e, siteId: n };
    return p(K(T(), I, O, r), r);
  };
  R.transfer = (e) => {
    s += 1;
    y.transfer += 1;
    const n = { kind: "transfer", unitId: e };
    return p(Y(T(), I, O, n), n);
  };
  R.spawnUnit = (e, n) => {
    s += 1;
    y.spawnUnit += 1;
    if (!M(n)) {
      f.spawnUnit.ERR_BAD_ARGS += 1;
      return { code: "ERR_BAD_ARGS" };
    }
    const r = { kind: "spawnUnit", baseId: e, unitType: n };
    return p(q(T(), I, O, r), r);
  };
  R.getMyIndex = () => I;
  R.isError = (e) => e !== null && typeof e === "object";
  R.errCode = (e) => e.code;
  for (const e of F) {
    R[e] = e;
  }
})();
