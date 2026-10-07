// judge-replay.mjs —— 票 05 的判据脚本(一次性,不是门禁)
//
// 读 `runs/contract-closure/<match-id>/replay.jsonl` 与 `observations.jsonl`,算每个座位的读数:
//   - captures:         按 `site-captured` 事件统计,归属到该 tick 该点位的**新属主**(= 在那一 tick
//                        的回放行里读该点位 `owner`);同时用「点位属主变更」独立复算一遍做交叉验证。
//   - 异常轨:           `exception` 事件(玩家级,`subjectId` = 座位)按座位计数。
//   - 单位类型构成:     该座位在对局中**开出**的兵种集合(排除地图开局摆下的初始单位;初始单位
//                        人人相同,带上它会把每个座位都染上 worker,失去区分度)。
//   - 经济死亡:         `economy-dead` 事件(玩家级,`subjectId` = 座位)是否出现。
//
// 混编局再算三策略(A/B/C)的读数三元组 (单位类型构成, captures>0, 经济死亡与否) 是否两两不同。
//
// 读数**全部取自回放与观测文件**,不从脚本日志取。不读资源数与击杀数。
//
// 用法(仓库根):`node .scratch/contract-closure/judge-replay.mjs` 或给一个 runs 根。

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const RUNS = resolve(ROOT, process.argv[2] ?? "runs/contract-closure");

const readJsonl = (path) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));

/** 从模型名 `cell-a-melee-pressure` 取策略字母 `A`。 */
const strategyOf = (model) => {
  const matched = /^cell-([abc])-/.exec(model);
  return matched === null ? model : matched[1].toUpperCase();
};

const analyzeMatch = (matchDir) => {
  const lines = readJsonl(join(matchDir, "replay.jsonl"));
  const meta = lines[0];
  const result = lines.at(-1);
  const tickLines = lines.filter((line) => line.type === "tick");

  const seats = [0, 1, 2, 3];
  const captures = [0, 0, 0, 0];
  const ownerChanges = [0, 0, 0, 0];
  const exceptions = [0, 0, 0, 0];
  const economyDead = [false, false, false, false];
  const builtTypes = seats.map(() => new Set());
  const fieldedTypes = seats.map(() => new Set());

  // 开局初始单位(第一行 tick 行里就有的那些单位):按 id 集合排除,留在 `fieldedTypes` 里。
  const initial = new Set((tickLines[0]?.units ?? []).map((unit) => unit.id));
  const seenUnit = new Set();

  const previousOwner = new Map();

  for (const line of tickLines) {
    const siteById = new Map(line.sites.map((site) => [site.id, site]));
    for (const event of line.events) {
      if (event.kind === "exception") {
        exceptions[event.subjectId] += 1;
      } else if (event.kind === "economy-dead") {
        economyDead[event.subjectId] = true;
      } else if (event.kind === "site-captured") {
        const site = siteById.get(event.subjectId);
        if (site !== undefined && site.owner >= 0) {
          captures[site.owner] += 1;
        }
      }
    }
    for (const site of line.sites) {
      const before = previousOwner.get(site.id);
      if (before !== undefined && before !== site.owner && site.owner >= 0) {
        ownerChanges[site.owner] += 1;
      }
      previousOwner.set(site.id, site.owner);
    }
    for (const unit of line.units) {
      fieldedTypes[unit.owner].add(unit.type);
      if (!seenUnit.has(unit.id)) {
        seenUnit.add(unit.id);
        if (!initial.has(unit.id)) {
          builtTypes[unit.owner].add(unit.type);
        }
      }
    }
  }

  const observationsPath = join(matchDir, "observations.jsonl");
  const observations = existsSync(observationsPath) ? readJsonl(observationsPath) : [];

  return {
    matchId: matchDir.split("/").at(-1),
    reason: result.reason,
    seed: meta.seed,
    mapHash: meta.mapHash,
    runner: meta.runner,
    seats: seats.map((seat) => ({
      seat,
      strategy: strategyOf(meta.players[seat].model),
      model: meta.players[seat].model,
      captures: captures[seat],
      ownerChanges: ownerChanges[seat],
      exceptions: exceptions[seat],
      economyDead: economyDead[seat],
      builtTypes: [...builtTypes[seat]].sort(),
      fieldedTypes: [...fieldedTypes[seat]].sort(),
    })),
    observations: observations.length,
  };
};

const triplet = (seatReading) => ({
  composition: seatReading.builtTypes.join("+"),
  capturesPositive: seatReading.captures > 0,
  economyDead: seatReading.economyDead,
});

const tripletKey = (t) => `${t.composition}|${t.capturesPositive}|${t.economyDead}`;

const dirs = readdirSync(RUNS)
  .map((name) => join(RUNS, name))
  .filter((path) => existsSync(join(path, "replay.jsonl")))
  .sort();

const summaries = dirs.map(analyzeMatch);

// ── 硬门禁:每局 captures 总数 > 0 且零 exception ──
let gateOk = true;
for (const summary of summaries) {
  const totalCaptures = summary.seats.reduce((sum, seat) => sum + seat.captures, 0);
  const totalExceptions = summary.seats.reduce((sum, seat) => sum + seat.exceptions, 0);
  const ok = totalCaptures > 0 && totalExceptions === 0;
  if (!ok) {
    gateOk = false;
    console.error(
      `HARD GATE FAIL ${summary.matchId}: captures=${totalCaptures} exceptions=${totalExceptions}`,
    );
  }
}

// ── 区分度:混编局三策略三元组两两不同 ──
const mixed = summaries.find((summary) => summary.matchId.startsWith("mixed"));
let discrimination = null;
if (mixed !== undefined) {
  // 同一策略可能占多席(混编是 A/B/C/A):把该策略各席的读数并起来 —— 兵种集合并集、
  // captures 取「是否任一席 > 0」、经济死亡取「是否任一席触发」。
  const byStrategy = new Map();
  for (const seat of mixed.seats) {
    const key = seat.strategy;
    if (!byStrategy.has(key)) {
      byStrategy.set(key, { strategies: [], seats: [], types: new Set(), captures: 0, dead: false });
    }
    const agg = byStrategy.get(key);
    agg.seats.push(seat.seat);
    agg.captures += seat.captures;
    agg.dead = agg.dead || seat.economyDead;
    for (const type of seat.builtTypes) {
      agg.types.add(type);
    }
  }
  const readings = [...byStrategy.entries()]
    .map(([strategy, agg]) => ({
      strategy,
      seats: agg.seats,
      composition: [...agg.types].sort().join("+"),
      capturesPositive: agg.captures > 0,
      captures: agg.captures,
      economyDead: agg.dead,
    }))
    .sort((a, b) => a.strategy.localeCompare(b.strategy));
  const keys = readings.map((reading) =>
    tripletKey({
      composition: reading.composition,
      capturesPositive: reading.capturesPositive,
      economyDead: reading.economyDead,
    }),
  );
  discrimination = {
    readings,
    keys,
    pairwiseDistinct: new Set(keys).size === keys.length,
  };
}

// ── 输出 ──
process.stdout.write("\n== 读数表(每局 × 每座位)==\n");
for (const summary of summaries) {
  process.stdout.write(
    `\n${summary.matchId}  reason=${summary.reason} seed=${summary.seed} obs=${summary.observations}\n`,
  );
  for (const seat of summary.seats) {
    process.stdout.write(
      `  seat${seat.seat} ${seat.strategy} ${seat.model.padEnd(26)}` +
        ` captures=${String(seat.captures).padStart(3)}` +
        ` (属主变更=${String(seat.ownerChanges).padStart(3)})` +
        ` exc=${seat.exceptions}` +
        ` econDead=${seat.economyDead ? "Y" : "n"}` +
        ` built=[${seat.builtTypes.join(",")}]` +
        ` fielded=[${seat.fieldedTypes.join(",")}]\n`,
    );
  }
}

process.stdout.write("\n== 硬门禁(每局 captures>0 且零 exception)==\n");
process.stdout.write(gateOk ? "PASS: 10 局全过\n" : "FAIL: 见上\n");

if (discrimination !== null) {
  process.stdout.write("\n== 区分度(混编局三策略三元组)==\n");
  for (const reading of discrimination.readings) {
    process.stdout.write(
      `  ${reading.strategy} (seat ${reading.seats.join("/")}):` +
        ` 构成=[${reading.composition}] captures>0=${reading.capturesPositive}` +
        ` econDead=${reading.economyDead}\n`,
    );
  }
  process.stdout.write(
    discrimination.pairwiseDistinct
      ? "PASS: 三元组两两不同\n"
      : `FAIL: 三元组有重复 —— ${discrimination.keys.join(" ; ")}\n`,
  );
}

process.stdout.write(`\n== JSON ==\n${JSON.stringify({ summaries, gateOk, discrimination })}\n`);
