// tables.mjs —— 把逐场数据聚成取证证据表（生成 data/tables.md）。
// 这里只出数字与口径，不下“成立/失衡”的结论（结论归 results.md 与 09 收口）。

// --- 基础统计工具 ---
function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const r1 = (x) => (x === null || x === undefined ? '—' : Math.round(x * 10) / 10);
const pct = (x) => (x === null || x === undefined ? '—' : `${Math.round(x * 1000) / 10}%`);

function dist(values) {
  const v = values.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
  if (v.length === 0) return { n: 0, min: null, p25: null, p50: null, p75: null, max: null, mean: null };
  return {
    n: v.length,
    min: v[0],
    p25: quantile(v, 0.25),
    p50: quantile(v, 0.5),
    p75: quantile(v, 0.75),
    max: v[v.length - 1],
    mean: v.reduce((a, b) => a + b, 0) / v.length,
  };
}
// 窗口带：gdd §2 的四段窗口，验收允许 ±20% 浮动
function band(w) { return [Math.round(w[0] * 0.8), Math.round(w[1] * 1.2)]; }
function distRow(label, values, window, foot = '—') {
  const d = dist(values);
  const span = window ? band(window) : null;
  const inWin = span ? values.filter((x) => x >= span[0] && x <= span[1]).length : null;
  return `| ${label} | ${d.n} | ${r1(d.min)} | ${r1(d.p25)} | ${r1(d.p50)} | ${r1(d.p75)} | ${r1(d.max)} | ${r1(d.mean)} | ${span ? `±20% 带 [${span[0]}, ${span[1]}]：${inWin}/${d.n}` : foot} |`;
}
function r2v(x) { return Math.round(x * 100) / 100; }
const DIST_HEADER = '| 指标 | n | min | p25 | 中位 | p75 | max | 均值 | 落在设计窗口 |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|';

function groupBy(results, keyFn) {
  const m = new Map();
  for (const r of results) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

const matrixOf = (id) => id.split('/')[0];
const labelOf = (id) => {
  const p = id.split('/');
  return { matrix: p[0], variant: p[1], detail: p[2], seats: p[3], seed: p[4] };
};

export function buildTables(results, duels, manifest) {
  const L = [];
  const push = (s = '') => L.push(s);

  push('# 桩模拟器取证数据表（自动生成）');
  push();
  push(`生成时间：${manifest.generatedAt}｜node ${manifest.node}｜对局数：${results.length}｜地图变体：${manifest.variants.join(' / ')}`);
  push();
  push('本文件只放**数字**。判读（成立/失衡、回流指向）在 [results.md](../results.md)。');
  push('重算：`node --disable-warning=ExperimentalWarning run-all.mjs`（先跑 `selftest.mjs` 验结算语义）；只改表格口径用 `--tables-only`。');
  push();
  push('三条口径提醒（读表前先看，否则会高估样本量）：');
  push('');
  push('1. **“种子”只驱动装饰性墙体微扰**（`map.mjs` 的 `VARIANT_SLOT_REPS` 按 30% 概率整轨填墙），点位布局与出生点固定。所以 8 个种子 = 同一布局的 8 种墙体花纹，**不是 8 张独立地图**；本轮没有覆盖“换点位拓扑”的鲁棒性（留给票 09）。');
  push('2. **矩阵之间不可直接横比**：`M0` 保留逐字入舱（含自认失败的不动座位），`M1/M2/M3` 注入真实座位；`M4/M5` 是自写探针局（`cell = probe`），它们刻意“莽”，只用于把机制单独拎出来，不参与策略排名。');
  push('3. **规则细节的歧义都在 `results.md` 的“桩模拟器的解释性决策”里列明**（出兵格占用、产线重复下单、轮转冲突、采空后开采等），这些是 throwaway 夹具的假设，不是正式引擎规范。');
  push();
  push('## 0. 参赛脚本与派生改写');
  push();
  push('| 键 | 舱 | 模型 | 策略 | 源文件 | sha256（前 12） |');
  push('|---|---|---|---|---|---|');
  for (const [k, v] of Object.entries(manifest.scripts)) {
    push(`| \`${k}\` | ${v.cell} | ${v.model} | ${v.strategy} | \`${v.file}\` | \`${v.sha256.slice(0, 12)}\` |`);
  }
  push();
  push('座位注入改写（仅用于隔离 P0-1 的影响，逐字矩阵 M0 不用它）：');
  push();
  for (const p of manifest.mirrorPatches) {
    push(`- \`${p.script}\`（${p.cell}）：${p.patches.length === 0 ? '不改写（自认机制在当前 schema 下可用）' : p.patches.map((x) => `\`${x.find}\` → \`${x.replace}\``).join('；')}`);
  }
  push();

  // ============ 1. 时间轴 ============
  push('## 1. 时间轴分布（gdd §2；窗口 0–40 / 40–160 / 160–400 / 400–600，±20% 浮动）');
  push();
  for (const variant of manifest.variants) {
    const rows = results.filter((r) => r.meta.variant === variant);
    if (rows.length === 0) continue;
    push(`### 1.${manifest.variants.indexOf(variant) + 1} 变体 \`${variant}\`（全矩阵 ${rows.length} 场）`);
    push();
    push(DIST_HEADER);
    // 窗口按 gdd §2 的 4 段（tickLimit=600）：0~1/15=0–40 开局、1/15~4/15=40–160 中路争夺、
    // 4/15~2/3=160–400 滚雪球/决战、2/3~600=400–600 决战收口
    push(distRow('首触（任意敌对单位 Chebyshev ≤2）｜窗口 0–40', rows.map((r) => r.timeline.firstContact), [0, 40]));
    push(distRow('首伤（首个有效开火）｜窗口 0–40', rows.map((r) => r.timeline.firstDamageTick), [0, 40]));
    push(distRow('首杀（首个单位死亡）｜窗口 0–40', rows.map((r) => r.timeline.firstKillTick), [0, 40]));
    push(distRow('首个易主 tick（首次占领发生）｜窗口 0–40', rows.map((r) => r.timeline.firstSiteFlipTick), [0, 40]));
    push(distRow('首方扩张（任一方拿到第 2 个基地）｜窗口 0–40', rows.map((r) => r.timeline.firstExpansionTick), [0, 40]));
    push(distRow('首次两方贴身抢同一点位（中路争夺）｜窗口 40–160', rows.map((r) => r.timeline.contestedSiteTick), [40, 160]));
    push(distRow('首次三方同抢一点位（决战）｜窗口 160–400', rows.map((r) => r.timeline.multiContestSiteTick), [160, 400]));
    push(distRow('首次敌方踩我方点位（堵点/骚扰）', rows.map((r) => r.timeline.firstBlockadeTick), null));
    push(distRow('首次淘汰', rows.map((r) => r.timeline.firstEliminationTick), null));
    push(distRow('结局 tick（分胜负或超时）｜窗口 400–600', rows.map((r) => r.outcome.tick), [400, 600]));
    push(distRow('数学锁定 tick（领先 > 剩余可达摆动）', rows.map((r) => r.timeline.decisionTick), null));
    push(distRow('最后争夺 tick（最后一次占领或死亡）', rows.map((r) => r.timeline.lastContestedTick), null));
    push();
    const decided = rows.filter((r) => r.timeline.decisionTick !== null);
    const outcomeDist = dist(rows.map((r) => r.outcome.tick));
    const firstElimDist = dist(rows.map((r) => r.timeline.firstEliminationTick));
    const before24 = rows.filter((r) => r.outcome.tick < 400).length;
    const timeout = rows.filter((r) => r.outcome.reason === 'timeout').length;
    const victory = rows.filter((r) => r.outcome.reason === 'victory').length;
    const shortcut = rows.filter((r) => r.outcome.reason === 'shortcut').length;
    // 尾段空转：自“结果已定”（严判据锁定 / 领土锁定，取先到者；都没锁就用最后一次争夺）到结局
    const tailOf = (r) => {
      const t = r.timeline;
      const mark = [t.decisionTick, t.territoryLockTick, t.lastContestedTick].filter((x) => x !== null);
      return mark.length === 0 ? null : Math.max(0, r.outcome.tick - Math.min(...mark));
    };
    const tailDist = dist(rows.map(tailOf).filter((x) => x !== null));
    const lockTerritory = rows.filter((r) => r.timeline.territoryLockTick !== null).length;
    push(`- **收口原因**：全点位胜 ${victory} / 捷径胜 ${shortcut} / 超时 ${timeout}`);
    push(`- **在 2/3（tick 400）前就结束**：${before24}/${rows.length} 场（${pct(before24 / rows.length)}）`);
    push(`- **数学锁定**（严判据，含资源换兵的可达摆动）：${decided.length}/${rows.length} 场；**领土锁定**（松判据，只看剩地）：${lockTerritory}/${rows.length} 场`);
    push(`- **尾段空转**（“结果已定/最后争夺” → 结局）：中位 ${r1(tailDist.p50)}、均值 ${r1(tailDist.mean)} tick，占 tickLimit 均 ${pct(tailDist.mean / 600)}（n=${tailDist.n}）`);
    push(`- **首淘汰 → 结局**的中位间距：${r1(outcomeDist.p50 - firstElimDist.p50)} tick`);
    push();
  }

  // §1.4 收口时点按矩阵：混在一起看会被某一类矩阵拉偏，判读时要能拆开
  push('### 1.4 收口时点按矩阵拆（判读“滚雪球快慢”时必须拆矩阵看）');
  push();
  push('| 矩阵 | 场次 | 结局 tick 中位 | 400 前结束 | 全点位胜 | 捷径胜 | 超时 | 尾段空转中位 |');
  push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const m of [...new Set(results.map((r) => matrixOf(r.id)))].sort()) {
    const sub = results.filter((r) => matrixOf(r.id) === m);
    const tails = sub.map((r) => {
      const t = r.timeline;
      const mark = [t.decisionTick, t.territoryLockTick, t.lastContestedTick].filter((x) => x !== null);
      return mark.length === 0 ? null : Math.max(0, r.outcome.tick - Math.min(...mark));
    }).filter((x) => x !== null);
    const od = dist(sub.map((r) => r.outcome.tick));
    const td = dist(tails);
    push(`| ${m} | ${sub.length} | ${r1(od.p50)} | ${sub.filter((r) => r.outcome.tick < 400).length} (${pct(sub.filter((r) => r.outcome.tick < 400).length / sub.length)}) | ${sub.filter((r) => r.outcome.reason === 'victory').length} | ${sub.filter((r) => r.outcome.reason === 'shortcut').length} | ${sub.filter((r) => r.outcome.reason === 'timeout').length} | ${r1(td.p50)} |`);
  }
  push();

  // ============ 2. P0-1：index 自认的实证代价 ============
  push('## 2. P0-1 实证：脚本能否认出自己的座位（逐字矩阵 M0）');
  push();
  push('口径：读脚本的模块级 `MY_INDEX` / `myIndex`（`cell-d` 另记 `selfFallback`）。认错或认不出 → 该座位全程不动作。');
  push();
  const m0 = results.filter((r) => matrixOf(r.id) === 'M0');
  push('| 脚本 | 座位 | 场次 | 认出正确座位 | 认成 0 号 | 认不出 | 认错时的产出（单位/交付资源） | 对局名次 1 的次数 |');
  push('|---|---|---:|---:|---:|---:|---|---:|');
  for (const key of ['a', 'b', 'c', 'd']) {
    for (const seat of [0, 1, 2, 3]) {
      const cells = m0.map((r) => r.players[seat]).filter((p) => p.script === key);
      if (cells.length === 0) continue;
      const correct = cells.filter((p) => p.identifiedIndex === seat).length;
      const wrongZero = cells.filter((p) => p.identifiedIndex === 0 && seat !== 0).length;
      const none = cells.filter((p) => p.identifiedIndex === null).length;
      const wrong = cells.filter((p) => p.identifiedIndex !== null && p.identifiedIndex !== seat).length;
      const prod = cells.reduce((a, p) => a + p.unitsByTypeEnd.w + p.unitsByTypeEnd.m + p.unitsByTypeEnd.r + p.unitsByTypeEnd.c, 0) / cells.length;
      const delivered = cells.reduce((a, p) => a + p.delivered, 0) / cells.length;
      const wins = cells.filter((p) => p.finalRank === 1).length;
      push(`| \`${key}\` | ${seat} | ${cells.length} | ${correct} | ${wrongZero} | ${none + wrong} | ${r1(prod)} 单位 / ${r1(delivered)} 资源 | ${wins} |`);
    }
  }
  push();
  const inertShare = (() => {
    let bad = 0;
    let tot = 0;
    for (const r of m0) {
      for (const p of r.players) {
        if (!p.script) continue;
        tot += 1;
        if (p.identifiedIndex === null || p.identifiedIndex !== p.index) bad += 1;
      }
    }
    return { bad, tot };
  })();
  push(`- **逐字入舱时，有 ${inertShare.bad}/${inertShare.tot} 个“座位”认错了自己（或认不出）**，即 ${pct(inertShare.bad / inertShare.tot)} 的参赛位在整局中不动作。`);
  push();

  // ============ 3. 策略胜率（镜像矩阵）============
  push('## 3. 策略胜率与领地效率（M1 四方混战 + M2 二对二，均为座位注入后）');
  push();
  for (const variant of manifest.variants) {
    push(`### 3.${manifest.variants.indexOf(variant) + 1} \`${variant}\``);
    push();
    push('| 矩阵 | 脚本 | 场次 | 第 1 名 | 前 2 | 均领土分 | 均存活单位造价 | 终局农民占比 | 农民驱动占领点数 | 全部占领点数 | 易主/席位 | 每次易主的终局领土收益 |');
    push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    const byMatrix = groupBy(results, (r) => matrixOf(r.id));
    for (const [matrix, allSub] of byMatrix) {
      const sub = allSub.filter((r) => r.meta.variant === variant);
      if (sub.length === 0) continue;
      const byScript = new Map();
      for (const r of sub) {
        for (const p of r.players) {
          if (!p.script) continue;
          if (!byScript.has(p.script)) byScript.set(p.script, []);
          byScript.get(p.script).push(p);
        }
      }
      const capTotals = new Map();
      for (const r of sub) {
        for (const t of ['worker', 'melee', 'ranged', 'cavalry']) {
          capTotals.set(t, (capTotals.get(t) ?? 0) + (r.combat.sitesCapturedByDriverType[t] ?? 0));
        }
      }
      for (const [key, ps] of byScript) {
        const n = ps.length;
        const r1n = ps.filter((p) => p.finalRank === 1).length;
        const r2n = ps.filter((p) => p.finalRank <= 2).length;
        const score = ps.reduce((a, p) => a + p.scoreEnd, 0) / n;
        const unitCost = ps.reduce((a, p) => a
          + p.unitsByTypeEnd.w * 4 + p.unitsByTypeEnd.m * 8 + p.unitsByTypeEnd.r * 12 + p.unitsByTypeEnd.c * 16, 0) / n;
        const ws = ps.reduce((a, p) => a + p.workerShareEnd, 0) / n;
        const caps = ps.reduce((a, p) => a + p.capsByDriver.worker, 0);
        const capsAll = ps.reduce((a, p) => a + p.capsByDriverTotal, 0);
        // 每次易主的终局领土收益 = 终局领土分 / 本席位累计易主次数。
        // 它把"刷点数量"和"点留下来"分开：数字大 = 占的点能留住（滚雪球），小 = 点的 churn。
        const yieldPerFlip = ps.reduce((a, p) => a + p.scoreEnd / Math.max(1, p.capsByDriverTotal), 0) / n;
        push(`| ${matrix} | \`${key}\` | ${n} | ${r1n} (${pct(r1n / n)}) | ${r2n} (${pct(r2n / n)}) | ${r1(score)} | ${r1(unitCost)} | ${pct(ws)} | ${caps} | ${capsAll} | ${r1(capsAll / n)} | ${r2v(yieldPerFlip)} |`);
      }
    }
    push();
  }

  // ============ 4. 头对头胜率 ============
  push('## 4. 头对头胜率（M2 二对二：每种策略 2 席，4 个循环座位旋转 × 种子）');
  push();
  push('| 对局 | 变体 | 场次 | X 拿下第 1 的席位 | X 前 2 的席位 | X 赢整局 | Y 拿下第 1 的席位 | Y 前 2 的席位 | 无胜者 |');
  push('|---|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const [key, sub] of groupBy(results.filter((r) => matrixOf(r.id) === 'M2'), (r) => `${labelOf(r.id).detail}|${r.meta.variant}`)) {
    const [pair, variant] = key.split('|');
    const [x, y] = pair.split('v');
    const cells = sub.flatMap((r) => r.players.map((p) => ({ p, r })));
    const xs = cells.filter((c) => c.p.script === x);
    const ys = cells.filter((c) => c.p.script === y);
    const xRank1 = xs.filter((c) => c.p.finalRank === 1).length;
    const yRank1 = ys.filter((c) => c.p.finalRank === 1).length;
    const xTop2 = xs.filter((c) => c.p.finalRank <= 2).length;
    const yTop2 = ys.filter((c) => c.p.finalRank <= 2).length;
    // “赢整局”：胜者席位（winner）属 X / 属 Y；剩下的多为超时无胜者
    const winX = sub.filter((r) => r.outcome.winner !== null && r.players[r.outcome.winner].script === x).length;
    const winY = sub.filter((r) => r.outcome.winner !== null && r.players[r.outcome.winner].script === y).length;
    const noWinner = sub.length - winX - winY;
    push(`| ${x} vs ${y} | ${variant} | ${sub.length} | ${xRank1}/${xs.length} (${pct(xRank1 / xs.length)}) | ${xTop2}/${xs.length} (${pct(xTop2 / xs.length)}) | ${winX} (${pct(winX / sub.length)}) | ${yRank1}/${ys.length} (${pct(yRank1 / ys.length)}) | ${yTop2}/${ys.length} (${pct(yTop2 / ys.length)}) | ${noWinner} |`);
  }
  push();

  // ============ 5. 农民海检验（05 票判定标准）============
  push('## 5. 农民海抢点检验（gdd #4 / 票 05 判定标准）');
  push();
  {
    const all = results;
    const byType = { worker: 0, melee: 0, ranged: 0, cavalry: 0 };
    const capType = { worker: 0, melee: 0, ranged: 0, cavalry: 0 };
    const capTicksType = { worker: 0, melee: 0, ranged: 0, cavalry: 0 };
    for (const r of all) {
      for (const t of ['worker', 'melee', 'ranged', 'cavalry']) {
        byType[t] += r.combat.deathsByType[t] ?? 0;
        capType[t] += r.combat.sitesCapturedByDriverType[t] ?? 0;
        capTicksType[t] += r.combat.captureTicksByDriverType[t] ?? 0;
      }
    }
    const totalCap = Object.values(capType).reduce((a, b) => a + b, 0) || 1;
    const totalTicks = Object.values(capTicksType).reduce((a, b) => a + b, 0) || 1;
    push('| 兵种 | 死亡数 | 每次易主的驱动 tick 数（占领效率） | 占全部易主的份额 | 占全部占领 tick 的份额 |');
    push('|---|---:|---:|---:|---:|');
    for (const t of ['worker', 'melee', 'ranged', 'cavalry']) {
      push(`| ${t} | ${byType[t]} | ${capType[t] === 0 ? '—' : r1(capTicksType[t] / capType[t])} | ${pct(capType[t] / totalCap)} | ${pct(capTicksType[t] / totalTicks)} |`);
    }
    push();
    push('### 5.1 农民海 vs 混编（M4 专项：会采集的农民海探针 vs 爆兵混编，各 2 席）');
    push();
    push('| 脚本 | 席位样本 | 第 1 名 | 前 2 | 均领土分 | 终局农民占比 | 全程农民占比 | 均交付资源 | 农民驱动易主 / 全部易主 | 经济死亡 | 死亡时残兵 | 死亡后抢到点 |');
    push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    const allSeats = all.flatMap((r) => r.players.map((p) => ({ p, r })));
    const keys = ['farmer4', 'farmer8', 'farmer12', 'a', 'd', 'b', 'c', 'raider'];
    for (const key of keys) {
      const cells = allSeats.filter((c) => c.p.script === key);
      if (cells.length === 0) continue;
      const n = cells.length;
      const died = cells.filter((c) => c.p.economyDeadAt !== null);
      push(`| \`${key}\` | ${n} | ${cells.filter((c) => c.p.finalRank === 1).length} (${pct(cells.filter((c) => c.p.finalRank === 1).length / n)}) | ${cells.filter((c) => c.p.finalRank <= 2).length} (${pct(cells.filter((c) => c.p.finalRank <= 2).length / n)}) | ${r1(cells.reduce((a, c) => a + c.p.scoreEnd, 0) / n)} | ${pct(cells.reduce((a, c) => a + c.p.workerShareEnd, 0) / n)} | ${pct(cells.reduce((a, c) => a + c.p.workerShareMean, 0) / n)} | ${r1(cells.reduce((a, c) => a + c.p.delivered, 0) / n)} | ${cells.reduce((a, c) => a + c.p.capsByDriver.worker, 0)} / ${cells.reduce((a, c) => a + c.p.capsByDriverTotal, 0)} | ${died.length} | ${r2v(died.reduce((a, c) => a + c.p.militaryAtEconDeath, 0) / (died.length || 1))} | ${died.filter((c) => c.p.sitesCapturedAfterEconDeath > 0).length} |`);
    }
    push();
    push('### 5.2 “经济死亡后抢点续命”是否有载体（gdd §5 的续命条款）');
    push();
    const diedAll = allSeats.filter((c) => c.p.economyDeadAt !== null);
    const withArmy = diedAll.filter((c) => c.p.militaryAtEconDeath > 0);
    const withSite = withArmy.filter((c) => c.p.sitesCapturedAfterEconDeath > 0);
    const withMineAtDeath = diedAll.filter((c) => c.p.minesAtEconDeath > 0);
    push(`- 经济死亡席位共 **${diedAll.length}** 个（全部矩阵）；其中死亡时**手里还有兵**的 ${withArmy.length} 个、**手里还有自家矿**的 ${withMineAtDeath.length} 个。`);
    push(`- 其中**真的在死亡后又抢到了点**的：**${withSite.length}** 个${withArmy.length === 0 ? `（注：没有任何席位在保住兵的前提下经济死亡，所以 gdd §5 的“残兵抢点续命”条款在本轮全部 ${all.length} 场里都没有被执行的机会）` : ''}。`);
    if (withSite.length > 0) {
      push();
      push('| 实例 | 脚本 | 经济死亡 tick | 死亡时残兵 | 死亡后抢点数 | 撑到 tick | 终局名次 |');
      push('|---|---|---:|---:|---:|---:|---:|');
      for (const c of withSite.slice(0, 12)) {
        push(`| ${c.r.id} | \`${c.p.script}\` | ${c.p.economyDeadAt} | ${c.p.militaryAtEconDeath} | ${c.p.sitesCapturedAfterEconDeath} | ${c.p.survivedToTick} | ${c.p.finalRank} |`);
      }
    }
    push();
  }

  // ============ 6. 枯竭时点 ============
  push('## 6. 资源枯竭时点（gdd #3；票 03 目标：约 tick 500 = 5/6 × tickLimit 采空）');
  push();
  push('### 6.1 全矩阵');
  push();
  push(DIST_HEADER);
  const dq = (k) => results.map((r) => r.depletion.ticks[k]);
  push(distRow('25% 储量被采完的 tick', dq('p25'), null));
  push(distRow('50% 被采完的 tick', dq('p50'), null));
  push(distRow('75% 被采完的 tick', dq('p75'), null));
  push(distRow('100% 采空（全局枯竭）的 tick', dq('p100'), null));
  push();
  const full = results.filter((r) => r.depletion.ticks.p100 !== null).length;
  const rem = results.reduce((a, r) => a + r.depletion.remainingEndPct, 0) / results.length;
  push(`- 走完 600 tick 仍未采空：${results.length - full}/${results.length} 场；**采空发生过**：${full} 场。`);
  push(`- 结束时全图剩余储量均值：**${pct(rem / 100)}**（即平均只消耗了 ${pct(1 - rem / 100)}）。`);
  push();
  push('### 6.2 M5 专项：农民海四方自战（把经济吞吐拉到本夹具上限）');
  push();
  push('口径：每方各自采集/交付；“全场交付合计”是 4 方交付之和。`minesK` = 开局归属各家的资源圈数（前 K 圈，含距家 6/11/20 tick 的外/中/内圈）。');
  push();
  push('| 探针 | 变体 | 场次 | 全场交付合计均值 | 结束剩余储量 | 25% | 50% | 75% | 100% | 结局 tick |');
  push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const [key, sub] of groupBy(results.filter((r) => matrixOf(r.id) === 'M5'), (r) => `${labelOf(r.id).detail}|${r.meta.variant}`)) {
    const [fm, variant] = key.split('|');
    const n = sub.length;
    const deliv = sub.reduce((a, r) => a + r.players.reduce((x, p) => x + p.delivered, 0), 0) / n;
    const remPct = sub.reduce((a, r) => a + r.depletion.remainingEndPct, 0) / n;
    const tk = (k) => { const v = sub.map((r) => r.depletion.ticks[k]).filter((x) => x !== null).sort((a, b) => a - b); return v.length ? `${r1(v[Math.floor(v.length / 2)])}` : '—'; };
    push(`| \`${fm}\` | ${variant} | ${n} | ${r1(deliv)} | ${pct(remPct / 100)} | ${tk('p25')} | ${tk('p50')} | ${tk('p75')} | ${tk('p100')} | ${r1(sub.reduce((a, r) => a + r.outcome.tick, 0) / n)} |`);
  }
  push();

  // ============ 7. 战斗面归因 + C 约束实证 ============
  push('## 7. 战斗面归因与 C1~C7 对局实证');
  push();
  {
    const dmg = { worker: 0, melee: 0, ranged: 0, cavalry: 0 };
    const kills = { worker: 0, melee: 0, ranged: 0, cavalry: 0 };
    const deaths = { worker: 0, melee: 0, ranged: 0, cavalry: 0 };
    for (const r of results) {
      for (const t of ['worker', 'melee', 'ranged', 'cavalry']) {
        dmg[t] += r.combat.damageByType[t] ?? 0;
        kills[t] += r.combat.killsByType[t] ?? 0;
        deaths[t] += r.combat.deathsByType[t] ?? 0;
      }
    }
    const totalDmg = Object.values(dmg).reduce((a, b) => a + b, 0) || 1;
    push('| 兵种 | 输出伤害 | 伤害份额 | 击杀数 | 被击杀数 | 击杀/被击杀 |');
    push('|---|---:|---:|---:|---:|---:|');
    for (const t of ['worker', 'melee', 'ranged', 'cavalry']) {
      push(`| ${t} | ${dmg[t]} | ${pct(dmg[t] / totalDmg)} | ${kills[t]} | ${deaths[t]} | ${deaths[t] === 0 ? '—' : r1(kills[t] / deaths[t])} |`);
    }
    push();
    const firstStrike = results.map((r) => r.timeline.firstStrike).filter(Boolean);
    const byAtk = {};
    for (const f of firstStrike) byAtk[f.attackerType] = (byAtk[f.attackerType] ?? 0) + 1;
    push(`- **首血兵种分布**（${firstStrike.length} 场有首血）：` + Object.entries(byAtk).map(([k, v]) => `${k} ${v} (${pct(v / firstStrike.length)})`).join('、'));
    push(`- **骑兵的实战存在感**：输出伤害份额 ${pct(dmg.cavalry / totalDmg)}、击杀 ${kills.cavalry}、被击杀 ${deaths.cavalry}（${results.length} 场四方混战 + 探针局）。`);
    push();
  }
  push('### 7.1 站桩对拼与速度消融（同一套结算语义，夹具地图开阔无墙）');
  push();
  push('| 实验 | 口径 | A 方 | B 方 | 等成本 | 胜方 | A 剩余 HP | B 剩余 HP | 决胜 tick |');
  push('|---|---|---|---|---:|---|---:|---:|---:|');
  for (const d of duels.duels) {
    push(`| ${d.id} | ${d.label} | ${d.typeA} × ${d.nA} | ${d.typeB} × ${d.nB} | ${d.costA}=${d.costB} | **${d.winner}** | ${pct(d.hpKeptPctA / 100)} | ${pct(d.hpKeptPctB / 100)} | ${d.decisiveTick} |`);
  }
  push();
  push(`- **C6**（远程贴身即溃）：满血远程 hp=${duels.c6.rangedHp}，单个近战需 ${duels.c6.meleeNeeded} 击；实测被击杀 tick = **${duels.c6.ticksToKill}**（判据 ≤2）→ ${duels.c6.pass ? '成立' : '不成立'}。`);
  push(`- **C4/C5**（算术）：HP/造价 ${JSON.stringify(duels.arithmetic.hpPerCost)}；伤害/造价 ${JSON.stringify(duels.arithmetic.dmgPerCost)}；近战双最高 = ${duels.arithmetic.c4.hpPerCostHighest && duels.arithmetic.c4.dmgPerCostHighest}；骑兵速度 2× = ${duels.arithmetic.c5.cavalrySpeed2x}，造价 ≥ 2× 近战 = ${duels.arithmetic.c5.cavalryCostGte2xMelee}。`);
  push(`- **C7**（经济）：单农回路 ${duels.c7.cycle} tick → 收入 ${duels.c7.workerIncome}/tick；单基地满产烧钱率 ${JSON.stringify(duels.c7.burnPerBase)}（= 单农收入的 ${JSON.stringify(duels.c7.burnVsIncome)} 倍）；硬约束成立 = ${duels.c7.hardConstraint}，落在 2–4× 舒适带 = ${JSON.stringify(duels.c7.comfortableBand)}。`);
  push();
  push('### 7.2 占领遇战（E 系列：受控遭遇，用来把“占领效率”从混战里剥出来）');
  push();
  push('口径：目标是一个中立基地，进攻方无经济无生产（= 经济死亡后的残兵），守方是站点邻格的近战驻防；'
    + '进攻方 doctrine = 射程内有守方就打、否则直走目标格、站上去冻结；守方 doctrine = 贴住最近进攻单位打。');
  push();
  push('| 实验 | 编制 | 等造价 | 驻防数 | 占领成功 | 占领 tick | 进攻存活 | 守方存活 | 终局点位属主 |');
  push('|---|---|---:|---:|---|---:|---:|---:|---:|');
  for (const d of duels.assaults) {
    push(`| ${d.id} | ${d.attacker} × ${d.nAtt} | ${d.costAtt} | ${d.defenders} | ${d.captured ? '**是**' : '否'} | ${d.capturedAt ?? '—'} | ${d.attAlive}/${d.nAtt} | ${d.defAlive}/${d.defenders} | ${d.siteOwner === 0 ? '进攻方' : (d.siteOwner === 1 ? '守方' : '中立')} |`);
  }
  push();
  push('| 等造价扫描（守方固定 3 驻防） | 编制 | 占领成功 | 占领 tick | 进攻存活 | 守方存活 |');
  push('|---|---|---|---:|---:|---:|');
  for (const d of duels.assaultGrid) {
    push(`| ${d.label} | ${d.attacker} × ${d.nAtt} | ${d.captured ? '**是**' : '否'} | ${d.capturedAt ?? '—'} | ${d.attAlive}/${d.nAtt} | ${d.defAlive}/${d.defenders} |`);
  }
  push();
  push('### 7.3 骑兵价值的因果消融（“价值全部来自速度”检验）');
  push();
  push('| 实验 | 几何 | 骑兵速度 | 农损 | 近战损 | 骑兵损 | 首个农击杀 tick | 首个骑兵损失 tick |');
  push('|---|---|---:|---:|---:|---:|---:|---:|');
  for (const r of Object.values(duels.raids)) {
    push(`| ${r.id} | ${r.label} | ${r.cavalrySpeed} | ${r.workersLost}/${r.workers} | ${r.meleeLost}/${r.melee} | ${r.cavLost}/${r.cavalry} | ${r.firstWorkerKill ?? '—'} | ${r.firstCavLoss ?? '—'} |`);
  }
  push();

  // ============ 8. 对局结构质量 ============
  push('## 8. 对局结构质量（gdd 支柱 1：戏剧性优先）');
  push();
  {
    const lc = results.map((r) => r.timeline.leaderChanges);
    const comebacks = results.flatMap((r) => (r.comeback ? [{ id: r.id, ...r.comeback }] : []));
    const dist2 = dist(lc);
    push(`- **领先者易手次数**（每 5 tick 采样的领土分榜首变化）：中位 ${r1(dist2.p50)}、p75 ${r1(dist2.p75)}、max ${r1(dist2.max)}、均值 ${r1(dist2.mean)}；发生 ≥3 次易手的 ${results.filter((r) => r.timeline.leaderChanges >= 3).length}/${results.length} 场。`);
    push(`- **翻盘实例**（tick≥300 时排第 4 → 终局第 1）：**${comebacks.length}** 场${comebacks.length > 0 ? `，例：${comebacks.slice(0, 3).map((c) => `${c.id}(${c.script} 中途分 ${c.scoreAtHalf})`).join('、')}` : ''}。`);
    // 名次跃升分布：中途（tick≈300）名次 → 终局名次，0 = 持平，负 = 上升
    const gains = results.flatMap((r) => r.players
      .filter((p) => p.rankAtHalf !== null && p.finalRank !== null)
      .map((p) => p.rankAtHalf - p.finalRank));
    const dGain = dist(gains);
    const gainWins = gains.filter((g) => g > 0).length;
    push(`- **名次跃升**（中途名次 − 终局名次，正数=上升）：n=${dGain.n}，上升过一次的 ${gainWins} 次（${pct(gainWins / dGain.n)}），最大上升 ${dGain.max}，均值 ${r2v(dGain.mean)}。`);
    // 尾段空转：自“结果已定/最后争夺”到结局（与 §1 同一口径）
    const tail = results.map((r) => {
      const t = r.timeline;
      const mark = [t.decisionTick, t.territoryLockTick, t.lastContestedTick].filter((x) => x !== null);
      return mark.length === 0 ? null : Math.max(0, r.outcome.tick - Math.min(...mark));
    }).filter((x) => x !== null);
    const dTail = dist(tail);
    push(`- **尾段空转**（“结果已定（锁定/最后争夺）” → 结局）：中位 ${r1(dTail.p50)} tick、p75 ${r1(dTail.p75)}、均值 ${r1(dTail.mean)} tick，占 tickLimit 均 ${pct(dTail.mean / 600)}；超过 100 tick 的 ${tail.filter((x) => x > 100).length}/${tail.length} 场。`);
    const firstElim = dist(results.map((r) => r.timeline.firstEliminationTick));
    const outcomes = dist(results.map((r) => r.outcome.tick));
    push(`- **首淘汰**中位 ${r1(firstElim.p50)} tick、**结局**中位 ${r1(outcomes.p50)} tick —— 两者间距中位 ${r1(outcomes.p50 - firstElim.p50)} tick。`);
    // 终局前 100 tick 的单位净增（票 09 新增指标，补 P1-10「终局前屯兵等超时」的证据缺口）：
    // 正值 = 结局前还在扩兵。因为无脚本靠超时靠分获胜且无脚本“卖兵换分”，正值只能读作扩兵而非摆烂。
    const net = results.flatMap((r) => r.players.map((p) => p.unitsNetLast100));
    const dNet = dist(net);
    const grow = net.filter((x) => x > 0).length;
    const shrink = net.filter((x) => x < 0).length;
    const flush = net.filter((x) => x < 0 && x <= -8).length;   // 一次性弃掉 8+ 个单位 ≈ “卖兵换分”
    push(`- **终局前 100 tick 的单位净增**（补 P1-10 证据缺口）：n=${dNet.n}，中位 ${r1(dNet.p50)}、p25 ${r1(dNet.p25)}、p75 ${r1(dNet.p75)}、min ${r1(dNet.min)}、max ${r1(dNet.max)}；净增 ${grow}、净减 ${shrink}、其中一次性弃掉 ≥8 个单位（≈“卖兵换分”）${flush} 次。`);
  }
  push();

  // ============ 9. 契约忠实度：异常、丢弃 intent、生产挂起 ============
  push('## 9. 契约忠实度（异常 / 丢弃 intent / 出兵格挂起）');
  push();
  {
    const exc = results.flatMap((r) => r.players.map((p) => p.exceptionTicks));
    const disc = results.map((r) => r.combat.discardedIntents);
    const busy = results.map((r) => r.combat.spawnOrdersRejectedBusyBase);
    const orders = results.map((r) => r.combat.spawnOrders);
    const refunds = results.map((r) => r.combat.refunds);
    const kindTotals = {};
    for (const r of results) {
      for (const [k, v] of Object.entries(r.combat.discardedByKind ?? {})) kindTotals[k] = (kindTotals[k] ?? 0) + v;
    }
    // 盲写脚本与自写探针分开统计：探针是故意“莽”的（每 tick 都想下单），会把契约口径冲淡
    const isProbe = (r) => r.meta.seats.every((s) => s && s.cell === 'probe');
    const blindOnly = results.filter((r) => !isProbe(r));
    const sum = (rs, f) => rs.reduce((a, r) => a + f(r), 0);
    const excBlind = sum(blindOnly, (r) => r.players.reduce((a, p) => a + p.exceptionTicks, 0));
    push(`- **异常 tick**（loop 抛异常等）：全场合计 ${exc.reduce((a, b) => a + b, 0)}，其中盲写脚本（4 份）${excBlind} —— 契约的“丢单不罚、写崩才丢整 tick”区分在实战中没有触发点。`);
    push(`- **被丢弃的 intent**：全场合计 ${disc.reduce((a, b) => a + b, 0)}，分布 ${Object.entries(kindTotals).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('、') || '—'}；只看盲写脚本：${sum(blindOnly, (r) => r.combat.discardedIntents)}。`);
    push(`- **重复下单（产线忙）被丢弃**：全场 ${busy.reduce((a, b) => a + b, 0)}，有效下单 ${orders.reduce((a, b) => a + b, 0)} 次；只看盲写脚本：丢弃 ${sum(blindOnly, (r) => r.combat.spawnOrdersRejectedBusyBase)} / 下单 ${sum(blindOnly, (r) => r.combat.spawnOrders)}。脚本被迫自记生产队列（快照 productions 无按基地查询入口，票 14 P0-N3）的直接代价。`);
    push(`- **资源不足被拒的单**（\`ERR_NOT_ENOUGH_RESOURCES\`）：${kindTotals['spawnUnit:ERR_NOT_ENOUGH_RESOURCES'] ?? 0} —— 脚本在下单前自记资源是可行的，但会与“交付挂账/退款”产生漂移。`);
    push(`- **基地易主退款**事件：合计 ${refunds.reduce((a, b) => a + b, 0)} 次（盲写 ${sum(blindOnly, (r) => r.combat.refunds)}）。`);
  }
  push();

  // ============ 10. 票 09 专项：M6 同策略对称局 / M7 骑兵开关实验 ============
  push('## 10. 票 09 专项：M6 同策略对称局 / M7 骑兵开关实验');
  push();
  {
    const m6 = results.filter((r) => matrixOf(r.id) === 'M6');
    if (m6.length > 0) {
      const byPair = groupBy(m6, (r) => labelOf(r.id).detail);
      push('### 10.1 M6 同策略对称局（补 R2 “唯一解”缺口的证据）');
      push();
      push('| 组 | 场次 | 结局 tick 中位 | 收口原因（全点位/捷径/超时） | 末位翻盘夺冠 | 终局前 100 tick 单位净增中位 |');
      push('|---|---:|---:|---|---:|---:|');
      for (const [pair, rs] of byPair) {
        const reasons = { victory: 0, shortcut: 0, timeout: 0 };
        for (const r of rs) reasons[r.outcome.reason] = (reasons[r.outcome.reason] ?? 0) + 1;
        const comebacks = rs.filter((r) => r.comeback).length;
        const net = dist(rs.flatMap((r) => r.players.map((p) => p.unitsNetLast100)));
        push(`| ${pair} | ${rs.length} | ${r1(dist(rs.map((r) => r.outcome.tick)).p50)} | ${reasons.victory ?? 0} / ${reasons.shortcut ?? 0} / ${reasons.timeout ?? 0} | ${comebacks} | ${r1(net.p50)} |`);
      }
      push();
      push('> 读法：同策略自战里“有没有一方稳定获胜” = 策略层是否单调。座位不参与判定（四席同脚本），重复度靠 3 个夹具变体 × 4 个种子。');
      push();
    }
    const m7 = results.filter((r) => matrixOf(r.id) === 'M7');
    if (m7.length > 0) {
      push('### 10.2 M7 骑兵开关实验（机制层受控：同代码、同几何、同座位，只变造不造骑兵）');
      push();
      push('| 实验臂 | 席位 | 平均终局名次 | 第 1 名占比 | 领土分中位 | 结局 tick 中位 | 超时率 |');
      push('|---|---:|---:|---:|---:|---:|---:|');
      const armOf = (p) => (p.script === 'legion' ? '造骑兵' : '不造骑兵');
      for (const arm of ['造骑兵', '不造骑兵']) {
        const seatsIn = m7.flatMap((r) => r.players.filter((p) => armOf(p) === arm));
        if (seatsIn.length === 0) continue;
        const ranks = seatsIn.map((p) => p.finalRank).filter((x) => x !== null);
        const firsts = seatsIn.filter((p) => p.finalRank === 1).length;
        const gameOutcomes = m7.filter((r) => r.players.some((p) => armOf(p) === arm));
        push(`| ${arm} | ${seatsIn.length}（${gameOutcomes.length} 场） | ${r2v(ranks.reduce((a, b) => a + b, 0) / ranks.length)} | ${pct(firsts / seatsIn.length)} | ${r1(dist(seatsIn.map((p) => p.scoreEnd)).p50)} | ${r1(dist(gameOutcomes.map((r) => r.outcome.tick)).p50)} | ${pct(gameOutcomes.filter((r) => r.outcome.reason === 'timeout').length / gameOutcomes.length)} |`);
      }
      push();
      {
        const dmg = m7.reduce((a, r) => a + (r.combat.damageByType.cavalry ?? 0), 0);
        const allDmg = m7.reduce((a, r) => a + ['worker', 'melee', 'ranged', 'cavalry'].reduce((b, t) => b + (r.combat.damageByType[t] ?? 0), 0), 0) || 1;
        push(`- **全场骑兵伤害份额**（两臂混合，结算只按全场归因、不按席位）：${pct(dmg / allDmg)}。`);
      }
      push('> 读法：这是**机制层**的因果隔离（同一份探针源码、2v2 同场、4 轮转摊平先后手，只改生产序列）；它回答不了“真实模型会不会自造骑兵”（gdd §8 #10 已把后者记为不可归因缺口）。');
      push();
    }
  }

  // ============ 附：逐场明细索引 ============
  push('## 附. 逐场数据');
  push();
  push('完整逐场记录（含每 10 tick 一帧的序列）见 [matches.json](./matches.json)；首条示例：');
  push();
  const first = results[0];
  if (first) {
    push('```json');
    push(JSON.stringify({
      id: first.id,
      meta: first.meta,
      outcome: first.outcome,
      timeline: first.timeline,
      depletion: first.depletion,
      combat: first.combat,
      players: first.players.map((p) => ({
        seat: p.index, script: p.script, identifiedIndex: p.identifiedIndex, finalRank: p.finalRank,
        scoreEnd: p.scoreEnd, workerShareEnd: p.workerShareEnd, economyDeadAt: p.economyDeadAt,
        sitesCapturedAfterEconDeath: p.sitesCapturedAfterEconDeath, unitsByTypeEnd: p.unitsByTypeEnd,
      })),
    }, null, 1));
    push('```');
  }
  return L.join('\n') + '\n';
}
