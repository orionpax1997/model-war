// harness.mjs —— 对局跑批 + 取证指标。
//
// 矩阵设计（gdd §3.3：座位必须在赛季内轮换，低下标先手的偏置由轮换摊平）：
//   - 逐字矩阵 M0：4 份盲写脚本逐字入舱（cell-d 用 v2），四方混战 × 种子 × 4 个循环座位旋转。
//     用途：契约忠实度取证（含 index 自认缺失的真实代价）。
//   - 镜像矩阵 M1/M2：把"脚本认不出自己座位"这一契约缺口在宿主侧补上（mirror.mjs 声明式改写），
//     用途：策略平衡取证（"若 index API 存在，平衡面是什么样"）。
//   - 探针对局 M3：额外 Cavalry 突袭探针（probes/raider.js，非盲写），用途：骑兵价值面 + 经济死亡后续命实例。
//   - 票 05 专项 M4：会采集的农民海探针（probes/farmer.js，4/8/12 三档规模）vs 混编爆兵，
//     用途：农民占比 / 占领效率 / 混编 vs 农民海胜率（cell-c 字面脚本不采集，判不了这条）。
//   - 票 03 专项 M5：农民海四方自战（经济吞吐拉满），用途：全图储量的枯竭时点剖面。
//
// 取证指标的口径全部写在本文件顶部注释与 results.md，09 收口时直接引用。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMap, makeLcg } from './map.mjs';
import { createGame, runTick, finishByTimeout, exportTerritoryScores } from './engine.mjs';
import { RULESET, chebyshev, APPLIED_OVERRIDES } from './ruleset.mjs';
import { createPlayerRuntime, createIdleRuntime } from './runtime.mjs';
import { mirrorSource } from './mirror.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BLIND = path.resolve(HERE, '../blind');

// --- 参赛脚本登记（sha256 钉死票 07 记录的初版原文；cell-d 以 v2 为参赛版本）---
export const SCRIPTS = {
  a: {
    cell: 'cell-a', model: 'deepseek-v4.1-flash', strategy: 'A 爆兵压制',
    file: path.join(BLIND, 'cell-a/work/script.v1.js'),
  },
  b: {
    cell: 'cell-b', model: 'MiniMax-M3', strategy: 'B 扩张运营',
    file: path.join(BLIND, 'cell-b/work/script.v1.js'),
  },
  c: {
    cell: 'cell-c', model: 'deepseek-v4.1-flash(thinking=low)', strategy: 'C 占点(不采集)',
    file: path.join(BLIND, 'cell-c/work/script.v1.js'),
  },
  d: {
    cell: 'cell-d', model: 'space-bunny-alpha', strategy: 'A 爆兵压制(交叉验证)',
    file: path.join(BLIND, 'cell-d/work/script.v2.js'),
  },
  raider: {
    cell: 'probe', model: '桩模拟器自写探针（非盲写）', strategy: 'R 骑兵突袭',
    file: path.join(HERE, 'probes/raider.js'),
  },
  // 票 09 的骑兵受控实验探针：同一份源码，两个键、只差注入的 `USE_CAVALRY`。
  // 它与 raider 的差别：**会占点**（raider 只打人不会占点，终局均领土分只有 4.7）。
  legion: {
    cell: 'probe', model: '桩模拟器自写探针（非盲写）', strategy: 'L 造兵探针·开骑兵',
    file: path.join(HERE, 'probes/legion.js'), inject: 'const USE_CAVALRY = true;\n',
  },
  legionNoCav: {
    cell: 'probe', model: '桩模拟器自写探针（非盲写）', strategy: 'L 造兵探针·不开骑兵',
    file: path.join(HERE, 'probes/legion.js'), inject: 'const USE_CAVALRY = false;\n',
  },
  // 农民海探针的三个规模档：同一份探针源码，宿主注入 WORKER_TARGET / HARVEST_PCT（票 05 规模敏感）
  farmer2: {
    cell: 'probe', model: '桩模拟器自写探针（非盲写）', strategy: '农民海 2 农（1 采 1 扩）',
    file: path.join(HERE, 'probes/farmer.js'), inject: 'const WORKER_TARGET = 2;\nconst HARVEST_PCT = 50;\n',
  },
  farmer4: {
    cell: 'probe', model: '桩模拟器自写探针（非盲写）', strategy: '农民海 4 农（2 采 2 扩）',
    file: path.join(HERE, 'probes/farmer.js'), inject: 'const WORKER_TARGET = 4;\nconst HARVEST_PCT = 50;\n',
  },
  farmer8: {
    cell: 'probe', model: '桩模拟器自写探针（非盲写）', strategy: '农民海 8 农（5 采 3 扩）',
    file: path.join(HERE, 'probes/farmer.js'), inject: 'const WORKER_TARGET = 8;\nconst HARVEST_PCT = 66;\n',
  },
  farmer6: {
    cell: 'probe', model: '桩模拟器自写探针（非盲写）', strategy: '农民海 6 农（4 采 2 扩）',
    file: path.join(HERE, 'probes/farmer.js'), inject: 'const WORKER_TARGET = 6;\nconst HARVEST_PCT = 66;\n',
  },
  farmer12: {
    cell: 'probe', model: '桩模拟器自写探针（非盲写）', strategy: '农民海 12 农（7 采 5 扩）',
    file: path.join(HERE, 'probes/farmer.js'), inject: 'const WORKER_TARGET = 12;\nconst HARVEST_PCT = 60;\n',
  },
};

const sourceCache = new Map();
export function loadSource(key) {
  if (!sourceCache.has(key)) {
    const def = SCRIPTS[key];
    if (!def) throw new Error(`unknown script key: ${key}`);
    // 探针的规模参数由宿主注入（探针源码里不写死，见 probes/farmer.js 头注）
    const text = def.inject ? `${def.inject}${fs.readFileSync(def.file, 'utf8')}` : fs.readFileSync(def.file, 'utf8');
    sourceCache.set(key, { text, def });
  }
  return sourceCache.get(key);
}

// --- 时间轴窗口（gdd §2，按 tickLimit 比例；±20% 浮动为验收带，票 03）---
export const WINDOWS = {
  open: [0, 40], firstContact: [40, 160], mid: [160, 400], final: [400, 600],
};

function emptyCount() {
  return { worker: 0, melee: 0, ranged: 0, cavalry: 0 };
}

// 单场对局：跑到分出胜负 / tickLimit 为止，并采集取证指标。
// seatScripts: [scriptKey|null, ...4]；mirror: 是否注入"脚本知道自己的座位"（契约缺口的宿主侧补丁）
export function playMatch({ seatScripts, seed, map, mirror = false, sampleEvery = 10, trace = true, includeEvents = false }) {
  const state = createGame({ map, trace });
  const runtimes = [null, null, null, null];
  const scriptInfo = [];
  for (let p = 0; p < 4; p++) {
    const key = seatScripts[p];
    if (!key) { runtimes[p] = createIdleRuntime(); scriptInfo.push(null); continue; }
    const { text, def } = loadSource(key);
    const source = mirror ? mirrorSource(key, text, p) : text;
    const rt = createPlayerRuntime({ source, playerIndex: p, map, label: key });
    runtimes[p] = rt;
    scriptInfo.push({ key, cell: def.cell, model: def.model, strategy: def.strategy, mirrored: mirror });
  }

  const series = [];        // 每 sampleEvery tick 一帧
  const perPlayer = [0, 1, 2, 3].map((p) => ({
    index: p,
    script: scriptInfo[p] ? scriptInfo[p].key : null,
    selfFallback: false,
    resources: RULESET.initialResources,
    unitPeak: 0,
    workerPeak: 0,
    economyDeadAt: null,
    militaryAtEconDeath: null,
    minesAtEconDeath: null,
    basesAtEconDeath: null,
    sitesCapturedAfterEconDeath: 0,
    survivedToTick: 0,
    eliminatedAt: null,
    workerShareEnd: 0,
    workerShareMean: 0,
    unitsByTypeEnd: emptyCount(),
    scoreEnd: 0,
    peakScore: 0,
    finalRank: null,
    scoreAtHalf: null,
    rankAtHalf: null,
    lastRankByScore: null,
    unitsNetLast100: null,   // 终局前 100 tick 的单位净增（P1-10“终局屯兵等超时”的取证）
    harvests: 0,
    delivered: 0,
    apiCalls: 0,
    pathCalls: 0,
    exceptionTicks: 0,
    identifiedIndex: null,   // 脚本自认的座位（取证：P0-1 的真实代价）
  }));

  let leaderChanges = 0;
  let lastLeader = null;
  let lastContestedTick = 0;
  let firstContactTick = null;
  let firstDamageTick = null;
  let firstKillTick = null;
  let firstSiteFlipTick = null;
  let firstExpansionTick = null;   // 任一方拿到第 2 个基地
  let workerShareSum = [0, 0, 0, 0];
  let workerShareSamples = 0;
  let decisionTick = null;         // 数学锁定（严判据：含资源换兵的可达摆动）
  let territoryLockTick = null;    // 领土锁定（松判据：只看剩下能占的地）
  let comeback = null;             // 末局名次与中途名次反转的实例
  let firstEliminationTick = null;
  const eliminationTicks = [];
  let contestedSiteTick = null;    // 首个"两方以上同时贴身抢同一点位"的中路争夺
  let multiContestSiteTick = null; // 首个"三个属主同抢一点位"的多方混战
  let firstBlockadeTick = null;    // 首个"敌方单位贴上我方点位"的骚扰/堵点时点

  const limit = RULESET.tickLimit;
  while (state.tick < limit && !state.outcome) {
    const t = state.tick;
    runTick(state, runtimes);

    // —— 时间轴事件 ——
    if (firstContactTick === null && state.stats.firstContact) firstContactTick = state.stats.firstContact.tick;
    if (firstDamageTick === null && state.stats.firstStrike) firstDamageTick = state.stats.firstStrike.tick;
    const deathsEvent = state.events.find((e) => e.tick === t && e.kind === 'units-destroyed');
    if (deathsEvent) {
      if (firstKillTick === null) firstKillTick = t;
      lastContestedTick = t;
    }
    const siteFlip = state.events.find((e) => e.tick === t && e.kind === 'site-captured');
    if (siteFlip) {
      if (firstSiteFlipTick === null) firstSiteFlipTick = t;
      lastContestedTick = t;
    }
    if (state.events.some((e) => e.tick === t && e.kind === 'player-eliminated')) {
      if (firstEliminationTick === null) firstEliminationTick = t;
      eliminationTicks.push(t);
    }

    // —— 每 tick 的轻量快照指标 ——
    const counts = [emptyCount(), emptyCount(), emptyCount(), emptyCount()];
    let mapRemaining = 0;
    for (const s of state.sites) {
      if (s.kind === 'resource') mapRemaining += s.remaining;
    }
    for (const u of state.units.values()) counts[u.owner][u.type] += 1;

    const scores = exportTerritoryScores(state);
    const basesOwned = [0, 0, 0, 0];
    const minesOwned = [0, 0, 0, 0];
    for (const s of state.sites) {
      if (s.owner < 0) continue;
      if (s.kind === 'base') basesOwned[s.owner] += 1; else minesOwned[s.owner] += 1;
    }
    if (firstExpansionTick === null && Math.max(...basesOwned) >= 2) firstExpansionTick = t;

    // 中路争夺：同一点位周边（Chebyshev ≤1）同时有两个以上属主的单位 = 两军抢同一点；
    // ≥3 个属主 = 真·多方混战。注：一个格子只能站一个单位，所以要看“周边”而不是“同格”。
    if (contestedSiteTick === null || multiContestSiteTick === null || firstBlockadeTick === null) {
      for (const s of state.sites) {
        const near = new Set();
        for (const u of state.units.values()) {
          if (Math.max(Math.abs(u.x - s.x), Math.abs(u.y - s.y)) > 1) continue;
          near.add(u.owner);
          if (s.owner >= 0 && u.owner !== s.owner && firstBlockadeTick === null) firstBlockadeTick = t;
        }
        if (near.size >= 2 && contestedSiteTick === null) contestedSiteTick = t;
        if (near.size >= 3 && multiContestSiteTick === null) multiContestSiteTick = t;
      }
    }

    // 经济死亡（gdd §5：无任何农民且 resources < 农民造价）
    for (let p = 0; p < 4; p++) {
      const pl = perPlayer[p];
      if (pl.economyDeadAt === null && counts[p].worker === 0 && state.players[p].resources < RULESET.roster.worker.cost && state.players[p].alive) {
        pl.economyDeadAt = t;
        // 经济死亡那一刻手里还剩多少兵？（决定“抢点续命”是否还有载体）
        pl.militaryAtEconDeath = counts[p].melee + counts[p].ranged + counts[p].cavalry;
        pl.minesAtEconDeath = minesOwned[p];
        pl.basesAtEconDeath = basesOwned[p];
      }
      // 经济死亡后的抢点续命：死亡 tick 之后由该方驱动的占领（该 tick 全部事件都算）
      if (pl.economyDeadAt !== null && pl.economyDeadAt < t) {
        for (const ev of state.events) {
          if (ev.kind === 'site-captured' && ev.tick === t && ev.owner === p) pl.sitesCapturedAfterEconDeath += 1;
        }
      }
      const total = counts[p].worker + counts[p].melee + counts[p].ranged + counts[p].cavalry;
      pl.unitPeak = Math.max(pl.unitPeak, total);
      pl.workerPeak = Math.max(pl.workerPeak, counts[p].worker);
      pl.survivedToTick = Math.max(pl.survivedToTick, t);
    }

    // 领先者变化（翻盘粗验）
    const best = scores.indexOf(Math.max(...scores));
    if (lastLeader !== null && best !== lastLeader) leaderChanges += 1;
    lastLeader = best;

    // 领土锁定（松判据）：领先分 > 落后方还可能拿到的全部领土分（不考虑资源换兵）
    if (territoryLockTick === null) {
      const sorted0 = [...scores].sort((a, b) => b - a);
      const lead0 = sorted0[0] - sorted0[1];
      const leader0 = scores.indexOf(sorted0[0]);
      let rest0 = 0;
      for (const s of state.sites) {
        if (s.owner === leader0) continue;
        rest0 += s.kind === 'base' ? RULESET.baseScore : RULESET.resourceScore;
      }
      if (lead0 > rest0) territoryLockTick = t;
    }
    // 数学锁定（严判据）：领先分 > 剩余可达摆动（领土 + 全图剩余资源可换的单位分）
    if (decisionTick === null) {
      const sorted = [...scores].sort((a, b) => b - a);
      const lead = sorted[0] - sorted[1];
      const leader = scores.indexOf(sorted[0]);
      let notOwnedByLeader = 0;
      for (const s of state.sites) {
        if (s.owner === leader) continue;
        notOwnedByLeader += s.kind === 'base' ? RULESET.baseScore : RULESET.resourceScore;
      }
      const chaserPool = mapRemaining + state.players.reduce((acc, pl, i) => (i === leader ? acc : acc + pl.resources), 0);
      const unitSwing = Math.floor(chaserPool / RULESET.unitCostDivisor);
      if (lead > notOwnedByLeader + unitSwing) decisionTick = t;
    }

    if (t % sampleEvery === 0 || state.outcome) {
      for (let p = 0; p < 4; p++) {
        const total = counts[p].worker + counts[p].melee + counts[p].ranged + counts[p].cavalry;
        const share = total > 0 ? counts[p].worker / total : 0;
        workerShareSum[p] += share;
      }
      workerShareSamples += 1;
      series.push({
        tick: t,
        mapRemaining,
        players: [0, 1, 2, 3].map((p) => ({
          p,
          script: perPlayer[p].script,
          res: state.players[p].resources,
          w: counts[p].worker, m: counts[p].melee, r: counts[p].ranged, c: counts[p].cavalry,
          b: basesOwned[p], n: minesOwned[p], score: scores[p], alive: state.players[p].alive,
        })),
      });
    }
    if (state.outcome) break;
  }
  if (!state.outcome) finishByTimeout(state);

  // —— 收口指标 ——
  const outcome = state.outcome;
  const totalResources = state.sites.filter((s) => s.kind === 'resource').length * RULESET.resourcePerSite;
  const depletion = computeDepletion(state.stats.remainingSamples, totalResources);
  const scores = exportTerritoryScores(state);

  for (let p = 0; p < 4; p++) {
    const pl = perPlayer[p];
    const last = series[series.length - 1].players[p];
    pl.scoreEnd = scores[p];
    pl.peakScore = Math.max(...series.map((s) => s.players[p].score));
    pl.unitsByTypeEnd = { w: last.w, m: last.m, r: last.r, c: last.c };
    // 终局前 100 tick 的单位净增（票 09 新增指标，補 P1-10 的证据缺口）：
    // 正值 = 终局前还在扩兵（“屯兵等超时”的候选行为）；series 每 sampleEvery=10 tick 一帧。
    {
      const endTick = series[series.length - 1].tick;
      let before = null;
      for (const s of series) { if (s.tick <= endTick - 100) before = s; else break; }
      if (before) {
        const b = before.players[p];
        pl.unitsNetLast100 = (last.w + last.m + last.r + last.c) - (b.w + b.m + b.r + b.c);
      } else {
        pl.unitsNetLast100 = null;   // 对局不足 100 tick 就没有窗口
      }
    }
    const totalEnd = last.w + last.m + last.r + last.c;
    pl.workerShareEnd = totalEnd > 0 ? last.w / totalEnd : 0;
    pl.workerShareMean = workerShareSamples > 0 ? workerShareSum[p] / workerShareSamples : 0;
    pl.finalRank = outcome.rankings[p];
    pl.harvests = state.stats.harvestedByPlayer[p];
    pl.delivered = state.stats.deliveredByPlayer[p];
    pl.alive = state.players[p].alive;
    pl.capsByDriver = { ...state.stats.sitesCapturedByPlayerDriver[p] };
    pl.capsByDriverTotal = Object.values(pl.capsByDriver).reduce((a, b) => a + b, 0);
    pl.apiCalls = runtimes[p].counters?.apiCalls ?? 0;
    pl.pathCalls = runtimes[p].counters?.pathCalls ?? 0;
    pl.exceptionTicks = state.players[p].exceptionTicks;
    pl.eliminatedAt = state.players[p].eliminatedAt;
    // 脚本自认座位（取证 P0-1）：模块级 MY_INDEX / myIndex / seat（cell-d 另记 selfFallback）。
    // 注意：这是**对局结束时**的读数，不是“认出的那个 tick”——快照里没有可回溯的自认时点，
    // 想要逐 tick 证据只能用 replay.mjs --events 配合探针脚本自己的日志。
    const rt = runtimes[p];
    if (rt.peek) {
      const exprs = [
        'typeof MY_INDEX !== "undefined" ? MY_INDEX : null',
        'typeof myIndex !== "undefined" ? myIndex : null',
        'typeof seat !== "undefined" ? seat : null',
      ];
      for (const expr of exprs) {
        let v;
        try { v = rt.peek(expr); } catch { v = null; }
        if (v !== null && v !== undefined && pl.identifiedIndex === null) {
          pl.identifiedIndex = v;
          break;
        }
      }
      try {
        if (rt.peek('typeof selfFallback !== "undefined" ? selfFallback : null') === true) pl.selfFallback = true;
      } catch { /* 该脚本没有这个变量 */ }
    }
    // 中途（tick=300）名次，用于翻盘判读
    const half = series.find((s) => s.tick >= 300) ?? series[series.length - 1];
    pl.scoreAtHalf = half.players[p].score;
    pl.rankAtHalf = rankByScoreAt(half)[p];
  }

  // 翻盘：中途排名末位 → 终局第 1
  const half = series.find((s) => s.tick >= 300) ?? series[series.length - 1];
  const halfRanks = rankByScoreAt(half);
  for (let p = 0; p < 4; p++) {
    if (halfRanks[p] === 4 && perPlayer[p].finalRank === 1) {
      comeback = { player: p, script: perPlayer[p].script, scoreAtHalf: perPlayer[p].scoreAtHalf, finalRank: 1 };
    }
  }

  return {
    comeback,
    ...(includeEvents ? { events: state.events } : {}),
    meta: {
      seed, mirror,
      variant: `${map.variant}@${map.size}`,
      mapOpts: map.name.includes('mines') ? { ownedMineOrbits: Number(/mines(\d)/.exec(map.name)?.[1]) } : {},
      seats: perPlayer.map((p) => (p.script ? { seat: p.index, script: p.script, ...SCRIPTS[p.script] } : null)),
      mapName: map.name,
    },
    outcome: {
      reason: outcome.reason,
      winner: outcome.winner,
      tick: state.tick,
      rankings: outcome.rankings,
      territoryScores: scores,
    },
    timeline: {
      firstContact: state.stats.firstContact ? state.stats.firstContact.tick : firstContactTick,
      firstContactDetail: state.stats.firstContact,
      firstStrike: state.stats.firstStrike,
      firstDamageTick,
      firstKillTick,
      firstSiteFlipTick,
      firstExpansionTick,
      contestedSiteTick,
      multiContestSiteTick,
      firstBlockadeTick,
      firstEliminationTick,
      eliminationTicks,
      decisionTick,
      territoryLockTick,
      lastContestedTick,
      outcomeTick: state.tick,
      leaderChanges,
    },
    depletion,
    economy: {
      totalResources,
      harvested: state.stats.harvested,
      remainingEnd: state.stats.remainingSamples[state.stats.remainingSamples.length - 1],
    },
    combat: {
      damageByType: state.stats.damageByType,
      killsByType: state.stats.killsByType,
      deathsByType: state.stats.deathsByType,
      damageTakenByType: state.stats.damageTakenByType,
      captureTicksByDriverType: state.stats.captureTicksByDriverType,
      sitesCapturedByDriverType: state.stats.sitesCapturedByDriverType,
      spawnOrders: state.stats.spawnOrders,
      spawnOrdersRejectedBusyBase: state.stats.spawnOrdersRejectedBusyBase,
      discardedIntents: state.stats.discardedIntents,
      discardedByKind: state.stats.discardedByKind,
      refunds: state.stats.refunds,
    },
    players: perPlayer,
    series,
  };
}

function rankByScoreAt(frame) {
  const order = [0, 1, 2, 3].sort((a, b) => frame.players[b].score - frame.players[a].score || a - b);
  const ranks = [];
  order.forEach((p, i) => { ranks[p] = i + 1; });
  return ranks;
}

// 枯竭时点：储量被采到 25% / 50% / 75% / 100% 的 tick（无则 null）
function computeDepletion(remainingSamples, total) {
  const out = { total, ticks: { p25: null, p50: null, p75: null, p100: null } };
  for (let t = 0; t < remainingSamples.length; t++) {
    const consumed = 1 - remainingSamples[t] / total;
    if (out.ticks.p25 === null && consumed >= 0.25) out.ticks.p25 = t;
    if (out.ticks.p50 === null && consumed >= 0.50) out.ticks.p50 = t;
    if (out.ticks.p75 === null && consumed >= 0.75) out.ticks.p75 = t;
    if (out.ticks.p100 === null && consumed >= 0.999) out.ticks.p100 = t;
  }
  out.remainingEnd = remainingSamples[remainingSamples.length - 1];
  out.remainingEndPct = Math.round((out.remainingEnd / total) * 1000) / 10;
  return out;
}

// --- 矩阵定义 ---
export function rotate(seats) {
  const out = [];
  for (let i = 0; i < seats.length; i++) out.push([...seats.slice(i), ...seats.slice(0, i)]);
  return out;
}

export const SEEDS = [11, 23, 37, 41, 59, 71, 83, 97];
export const SEEDS_PROBE = [11, 23, 41, 71];

// 矩阵维度：`variant@size`（夹具变体 × 夹具尺寸）。size=40 是“窗口达不到”的对照组（见 map.mjs 选型注）。
export const VARIANTS = ['center-fortress@64', 'open-four@64', 'center-fortress@40'];
export const PROBE_VARIANTS = ['center-fortress@64', 'open-four@64'];

export function buildMatrices({ variants = VARIANTS } = {}) {
  const jobs = [];
  for (const v of variants) {
    const [variant, sizeText] = v.split('@');
    const size = Number(sizeText);
    // M0 逐字 4 方混战
    for (const seats of rotate(['a', 'b', 'c', 'd'])) {
      for (const seed of SEEDS) jobs.push({ id: `M0/${v}/${seats.join('')}/s${seed}`, seatScripts: seats, seed, mirror: false, variant, size });
    }
    // M1 镜像 4 方混战
    for (const seats of rotate(['a', 'b', 'c', 'd'])) {
      for (const seed of SEEDS) jobs.push({ id: `M1/${v}/${seats.join('')}/s${seed}`, seatScripts: seats, seed, mirror: true, variant, size });
    }
    // M2 镜像 2+2 头对头（每对策略一个胜率口径；4 个循环座位旋转摊平先后手）
    const pairs = [['a', 'b'], ['a', 'c'], ['a', 'd'], ['b', 'c'], ['b', 'd'], ['c', 'd']];
    for (const [x, y] of pairs) {
      for (const seats of rotate([x, x, y, y])) {
        for (const seed of SEEDS) jobs.push({ id: `M2/${v}/${x}v${y}/${seats.join('')}/s${seed}`, seatScripts: seats, seed, mirror: true, variant, size });
      }
    }
    // M6 票 09 专项：同策略对称局（补 R2“唯一解”缺口）。同策略自战没有座位旋转维度
    // （四席同脚本），重复度靠 3 个夹具变体 × 8 个种子。
    for (const pair of ['aa', 'ad', 'dd']) {
      for (const seed of SEEDS) {
        jobs.push({
          id: `M6/${v}/${pair}/s${seed}`,
          seatScripts: [...pair].map((ch) => (ch === 'a' ? 'a' : 'd')),
          seed, mirror: true, variant, size,
          label: `M6-${pair}`,
        });
      }
    }
    // M7 票 09 专项：骑兵的**机制层受控实验**。同代码、同几何、同座位（4 轮转摊平先后手），
    // 只变 USE_CAVALRY：两个席位 legion（造骑兵）vs 两个席位 legionNoCav（不造）。
    // 为什么用 2v2 而不是四方自战：夹具的装饰墙打破了四重对称，四方自战里“哪个座位吃到地形红利”
    // 的方差大于“造不造骑兵”，会把实验信号洗掉（实测：四方自战 8 场里 1 个席位独得 4 倍兵力）。
    for (const seats of rotate(['legion', 'legion', 'legionNoCav', 'legionNoCav'])) {
      for (const seed of SEEDS) {
        jobs.push({
          id: `M7/${v}/cav-vs-nocav/${seats.join('|')}/s${seed}`,
          seatScripts: seats, seed, mirror: true, variant, size,
          label: 'M7-cav-vs-nocav',
        });
      }
    }
    if (!PROBE_VARIANTS.includes(v)) continue;
    // M3 探针对局：骑兵突袭探针参战（混战 1 份 + 四方探针自战 1 份）
    for (const seats of rotate(['a', 'b', 'c', 'raider'])) {
      for (const seed of SEEDS_PROBE) jobs.push({ id: `M3/${v}/mixed/${seats.join('')}/s${seed}`, seatScripts: seats, seed, mirror: true, variant, size });
    }
    for (const seats of rotate(['raider', 'raider', 'raider', 'raider'])) {
      for (const seed of SEEDS_PROBE) jobs.push({ id: `M3/${v}/selfplay/${seats.join('')}/s${seed}`, seatScripts: seats, seed, mirror: false, variant, size });
    }
    // M4 票 05 专项：混编（a/d 爆兵）vs 农民海（4/8/12 三档），各 2 席头对头 + 四方混编
    for (const fm of ['farmer4', 'farmer8', 'farmer12']) {
      for (const mix of ['a', 'd']) {
        for (const seats of rotate([mix, mix, fm, fm])) {
          for (const seed of SEEDS_PROBE) jobs.push({ id: `M4/${v}/${mix}v${fm}/${seats.join('')}/s${seed}`, seatScripts: seats, seed, mirror: true, variant, size });
        }
      }
      for (const seats of rotate(['a', 'd', fm, 'b'])) {
        for (const seed of SEEDS_PROBE) jobs.push({ id: `M4/${v}/mix${fm}/${seats.join('')}/s${seed}`, seatScripts: seats, seed, mirror: true, variant, size });
      }
    }    // M5 票 03 专项：枯竭剖面。同一策略四方自战，把“每家几个农民”与“开局给几圈矿”两个旋钮分开扫。
    for (const fm of ['farmer2', 'farmer4', 'farmer6', 'farmer8']) {
      for (const seed of SEEDS_PROBE) {
        jobs.push({
          id: `M5/${v}/${fm}-mines1/s${seed}`,
          seatScripts: [fm, fm, fm, fm], seed, mirror: true, variant, size,
          label: `${fm}-mines1`,
        });
      }
    }
    // M5 票 03 专项（承上）
    for (const mines of [2, 3]) {
      for (const seed of SEEDS_PROBE) {
        jobs.push({
          id: `M5/${v}/farmer6-mines${mines}/s${seed}`,
          seatScripts: ['farmer6', 'farmer6', 'farmer6', 'farmer6'], seed, mirror: true, variant, size,
          mapOpts: { ownedMineOrbits: mines }, label: `farmer6-mines${mines}`,
        });
      }
    }
    // M6 / M7（票 09 专项）已在上方 PROBE_VARIANTS 守卫之前生成，故跑满 3 个夹具变体。
  }
  return jobs;
}

// --- 真图装载（票 06）：把 maps/*.json 转成桩内形状 -----------------------------
//
// 为什么转换放在 harness 而不是新开模块：matchArgsOf 是跑批与重放共用的**唯一**入口，
// 「地图 + 种子 → 对局条件」必须是同一个纯函数，否则重放就会与跑批分叉。改动只有
// 「job 带 mapFile 时走读真图」这一条分支，buildMap 的既有行为一字未动。
//
// 四处形状差异（真图 JSON ↔ 桩内）：
//   1. 地形字符 `.`/`#` ↔ `'plain'`/`wall`；
//   2. 点位属主 `initialOwner`（中立 = null）↔ `owner`（中立 = -1）；
//   3. 桩内点位多两个占领进度字段 `progressOwner: -1` / `progress: 0`（JSON 侧没有 = 未被占领）；
//   4. 桩内资源点带 `remaining`，取值走 `RULESET.resourcePerSite`（**不写死**：map.mjs 里
//      曾经写死 125，导致 `--set resourcePerSite=200` 时地图与 harness 的分母不一致、枯竭全线失真）。
// 另有一处**形状不同但不需要转换**：真图的 `spawnUnits` 是 `{owner, type, offset:[dx,dy]}`（相对自家
// 主基地），桩内是绝对坐标 `{owner, type, x, y}`，所以这里要把 offset 加上该方主基地坐标展开。

const TERRAIN_CHARS = { '.': 'plain', '#': 'wall' };
const VARIANT_FILL_PERCENT = 50;   // 与 map.mjs 的常量同值（桩内那份没导出，只能各写一份并在此注明）

export function mapFromJson(json, seed = 1) {
  const { size } = json;
  if (json.terrain.length !== size) throw new Error(`terrain has ${json.terrain.length} rows, size=${size}`);
  const terrain = json.terrain.map((row) => {
    if (row.length !== size) throw new Error(`terrain row length ${row.length} != size ${size}`);
    return [...row].map((ch) => {
      const t = TERRAIN_CHARS[ch];
      if (!t) throw new Error(`unknown terrain char ${JSON.stringify(ch)}`);
      return t;
    });
  });

  const sites = json.sites.map((s) => ({
    id: s.id,
    kind: s.kind,
    x: s.x,
    y: s.y,
    owner: s.initialOwner === null ? -1 : s.initialOwner,
    progressOwner: -1,
    progress: 0,
    ...(s.kind === 'resource' ? { remaining: RULESET.resourcePerSite } : {}),
  }));

  // 起始单位：offset 相对该方主基地 → 绝对坐标
  const homes = new Map();
  for (const s of sites) if (s.kind === 'base' && s.owner >= 0) homes.set(s.owner, s);
  const spawnUnits = json.spawnUnits.map((u) => {
    const home = homes.get(u.owner);
    if (!home) throw new Error(`spawnUnit owner ${u.owner} has no home base`);
    const x = home.x + u.offset[0];
    const y = home.y + u.offset[1];
    if (x < 0 || y < 0 || x >= size || y >= size) throw new Error(`spawnUnit out of bounds at ${x},${y}`);
    return { owner: u.owner, type: u.type, x, y };
  });

  // 种子变体：与 map.mjs 同一套机制 —— 真图 JSON 给的是**静态候选轨道清单**，
  // 种子逐槽位独立判定 50% 是否填上（整条轨道填或不填，四重对称才成立）。
  // 输出 `variantSlots` 记的是**本次种子实际填了哪些**，与 buildMap 的输出语义一致。
  const rand = makeLcg(seed);
  const forbidden = new Set();
  for (const key of [...sites.map((s) => `${s.x},${s.y}`), ...spawnUnits.map((u) => `${u.x},${u.y}`)]) {
    const [sx, sy] = key.split(',').map(Number);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) forbidden.add(`${sx + dx},${sy + dy}`);
    }
  }
  const variantSlots = [];
  for (const slot of json.variantSlots) {
    const cells = slot.filter(([x, y]) => !forbidden.has(`${x},${y}`));
    if (rand() % 100 < VARIANT_FILL_PERCENT) {
      for (const [x, y] of cells) terrain[y][x] = 'wall';
      if (cells.length > 0) variantSlots.push(cells);
    }
  }

  return {
    name: `realmap/${json.name}/${size}`,
    variant: json.name,     // meta.variant 拼成 `<name>@<size>`，跑批产物里据此分辨三张真图
    size,
    seed,
    terrain,
    sites,
    spawnUnits,
    variantSlots,
  };
}

// job → playMatch 入参（runMatrix 与 replay.mjs 共用，保证重放与跑批同源）
// job.mapFile（票 06 新增，可选）：给了就读那张真图 JSON 并转桩内形状；没给走夹具 buildMap。
export function matchArgsOf(job) {
  const map = job.mapFile
    ? mapFromJson(JSON.parse(fs.readFileSync(job.mapFile, 'utf8')), job.seed)
    : buildMap(job.seed, { variant: job.variant, size: job.size, ...(job.mapOpts ?? {}) });
  return { seatScripts: job.seatScripts, seed: job.seed, map, mirror: job.mirror };
}

export function runMatrix(jobs, { onMatch } = {}) {
  const results = [];
  for (const job of jobs) {
    const r = playMatch(matchArgsOf(job));
    r.id = job.id;
    r.variant = `${job.variant}@${job.size}${job.label ? `/${job.label}` : ''}`;
    results.push(r);
    if (onMatch) onMatch(r);
  }
  return results;
}

export { chebyshev };
