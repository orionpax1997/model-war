/**
 * 试跑计划：网格形状、摘要覆盖、篡改拒绝、单场身份、汇总投影与历史档读取。
 *
 * 断言对象都是**外部可观察的行为**：计划里有哪些场/组合/座位/种子/地图、同一输入两次构造的
 * 摘要、改任一字段后摘要是否变、被改过的计划是否被拒且报出哪一处不符、汇总是否拒绝缺场/多场。
 * 不碰盘、不起 VM。
 */

import { expect, it } from "vitest";
import {
  TRIAL_CANDIDATE_ID,
  TRIAL_GRID_MAP_NAMES,
  TRIAL_GRID_SEED_BASE,
  TRIAL_MATCHES_PER_CANDIDATE,
  TRIAL_PLAN_VERSION,
  TRIAL_SPARRING_LADDER,
  TRIAL_SPARRING_SUBSTITUTE,
  type JsonValue,
  type TrialPlan,
  type TrialPlanScript,
} from "@model-war/schema";

import { hashOf } from "./canonical.js";
import { gridReadingsFixture } from "./trial-grid.fixture.js";
import {
  archiveTrialPlanOf,
  buildTrialGridSummary,
  buildTrialPlan,
  checkTrialPlan,
  readTrialPlan,
  trialMatchInputSha256,
  trialPlanMismatch,
  type BuildTrialPlanInput,
} from "./trial-plan.js";

/** 四份陪练的事实（榜首/中位/末位 + 在位）：形状与 `loadSparringPool` 交回的一致。 */
const sparringScripts: readonly TrialPlanScript[] = [
  ...TRIAL_SPARRING_LADDER.map((identity) => ({
    id: `${identity.role}:${identity.id}`,
    role: identity.role,
    source: `archive:${identity.id}/${identity.runId}`,
    scriptSha256: identity.scriptSha256,
  })),
  {
    id: `incumbent:${TRIAL_SPARRING_SUBSTITUTE.id}`,
    role: "incumbent" as const,
    source: `archive:${TRIAL_SPARRING_SUBSTITUTE.id}/${TRIAL_SPARRING_SUBSTITUTE.runId}#substitute`,
    scriptSha256: TRIAL_SPARRING_SUBSTITUTE.scriptSha256,
  },
];

const maps = [
  { name: TRIAL_GRID_MAP_NAMES[0], sha256: "f".repeat(64) },
  { name: TRIAL_GRID_MAP_NAMES[1], sha256: "e".repeat(64) },
] as const;

const facts: BuildTrialPlanInput = {
  ruleset: "v2",
  rulesetSha256: "9".repeat(64),
  sandboxRuntimeHash: "8".repeat(64),
  scripts: sparringScripts,
  maps,
};

const plan = buildTrialPlan(facts);

const scriptOf = (index: number): TrialPlanScript => sparringScripts[index]!;

/** 按「正文变了但摘要没重算」的方式改计划（最像被人手改过存档的那一类）。 */
const tampered = (patch: Partial<TrialPlan>): TrialPlan => ({ ...plan, ...patch });

/** 连摘要一起重算的篡改：正文自洽，但仍然不是这份事实能推出来的计划。 */
const rehashed = (patch: Partial<TrialPlan>): TrialPlan => {
  const { planSha256, ...body } = { ...plan, ...patch };
  void planSha256;
  return { ...body, planSha256: hashOf(body as unknown as JsonValue) } as TrialPlan;
};

const matchPatched = (index: number, patch: Partial<TrialPlan["matches"][number]>): TrialPlan =>
  tampered({
    matches: plan.matches.map((match, position) =>
      position === index ? { ...match, ...patch } : match,
    ),
  });

it("网格形状：4 组合 × 4 座位 × 2 图 = 32 场，场序连续且种子由场次唯一决定", () => {
  expect(plan.version).toBe(TRIAL_PLAN_VERSION);
  expect(plan.matchesPerCandidate).toBe(TRIAL_MATCHES_PER_CANDIDATE);
  expect(plan.matches).toHaveLength(32);
  expect(plan.matches.map((match) => match.matchIndex)).toEqual(
    Array.from({ length: 32 }, (_, index) => index),
  );
  expect(plan.matches.map((match) => match.seed)).toEqual(
    Array.from({ length: 32 }, (_, index) => TRIAL_GRID_SEED_BASE + index),
  );
  // 种子不是维度：没有重复种子，也没有 101/202/303（v1 试跑）或 401/402/403（选拔）。
  const seeds = plan.matches.map((match) => match.seed);
  expect(new Set(seeds).size).toBe(seeds.length);
  for (const forbidden of [101, 202, 303, 401, 402, 403]) expect(seeds).not.toContain(forbidden);
  // 计划只收对手：候选不占 role，也不进 scripts；身份是角色限定的 `<role>:<slug>`。
  expect(plan.scripts).toHaveLength(4);
  expect(plan.scripts.some((script) => script.id === TRIAL_CANDIDATE_ID)).toBe(false);
  expect(plan.scripts.map((script) => script.role)).toEqual(["top", "mid", "last", "incumbent"]);
  for (const script of plan.scripts) expect(script.id.startsWith(`${script.role}:`)).toBe(true);
  expect(plan.maps).toEqual([...maps]);
});

it("组合枚举完整：四个组合各轮空一份陪练，每种组合 8 场且每个在座陪练出场 8 次", () => {
  const combos = new Set(plan.matches.map((match) => match.comboIndex));
  expect([...combos].sort()).toEqual([0, 1, 2, 3]);
  for (const comboIndex of [0, 1, 2, 3]) {
    const matches = plan.matches.filter((match) => match.comboIndex === comboIndex);
    expect(matches).toHaveLength(8);
    const omitted = scriptOf(comboIndex)!.id;
    const appearances = new Map<string, number>();
    for (const match of matches) {
      expect(match.seats).not.toContain(omitted);
      expect(new Set(match.seats).size).toBe(4);
      for (const id of match.seats) {
        if (id === TRIAL_CANDIDATE_ID) continue;
        appearances.set(id, (appearances.get(id) ?? 0) + 1);
      }
    }
    // 轮空的那一份一场不上；其余三份在每种组合里各坐 8 次（座位偏置被轮转摊平）。
    expect(appearances.get(omitted)).toBeUndefined();
    expect([...appearances.values()]).toEqual([8, 8, 8]);
  }
  // 跨组合：每份陪练在四种组合里的三种上场，共 24 次。
  for (const script of sparringScripts) {
    const count = plan.matches.filter((match) => match.seats.includes(script.id)).length;
    expect(count, script.id).toBe(24);
  }
});

it("座位轮转：候选在四个座位各 8 场，两张图各 16 场", () => {
  const seats = new Map<number, number>();
  const mapCounts = new Map<string, number>();
  for (const match of plan.matches) {
    seats.set(match.candidateSeat, (seats.get(match.candidateSeat) ?? 0) + 1);
    mapCounts.set(match.map, (mapCounts.get(match.map) ?? 0) + 1);
    // 座位表与 candidateSeat 必须互相说明：候选那个位置就叫 candidate。
    expect(match.seats[match.candidateSeat]).toBe(TRIAL_CANDIDATE_ID);
    expect(match.mapSha256).toBe(
      match.map === TRIAL_GRID_MAP_NAMES[0] ? maps[0].sha256 : maps[1].sha256,
    );
  }
  expect([...seats.keys()].sort()).toEqual([0, 1, 2, 3]);
  expect([...seats.values()]).toEqual([8, 8, 8, 8]);
  expect(mapCounts.get(TRIAL_GRID_MAP_NAMES[0])).toBe(16);
  expect(mapCounts.get(TRIAL_GRID_MAP_NAMES[1])).toBe(16);
  // 每个组合内部候选也各坐一次（不是「四个组合全挤在同一座位」）。
  for (const comboIndex of [0, 1, 2, 3]) {
    const comboSeats = plan.matches
      .filter((match) => match.comboIndex === comboIndex)
      .map((match) => match.candidateSeat);
    expect(new Set(comboSeats)).toEqual(new Set([0, 1, 2, 3]));
  }
});

it("同一份事实两次构造：整份计划（含 planSha256）逐字相同", () => {
  expect(buildTrialPlan(structuredClone(facts))).toStrictEqual(plan);
  expect(trialPlanMismatch(plan, buildTrialPlan(facts))).toBeNull();
});

it("planSha256 覆盖陪练身份、组合、座位、地图摘要与种子：改任一处摘要必变", () => {
  const scripts = (index: number, patch: Partial<TrialPlanScript>): BuildTrialPlanInput => ({
    ...facts,
    scripts: sparringScripts.map((script, position) =>
      position === index ? { ...script, ...patch } : script,
    ),
  });
  const variants: readonly { readonly what: string; readonly input: BuildTrialPlanInput }[] = [
    { what: "ruleset", input: { ...facts, ruleset: "v1" } },
    { what: "rulesetSha256", input: { ...facts, rulesetSha256: "a".repeat(64) } },
    { what: "sandboxRuntimeHash", input: { ...facts, sandboxRuntimeHash: "b".repeat(64) } },
    { what: "scripts[0].id", input: scripts(0, { id: "top:another-model" }) },
    {
      what: "scripts[1].source",
      input: scripts(1, { source: "archive:minimax-m3.1-flash/2026-10-14T00-00-00-000Z" }),
    },
    { what: "scripts[2].scriptSha256", input: scripts(2, { scriptSha256: "c".repeat(64) }) },
    {
      what: "scripts[3].source（去掉代位标注）",
      input: scripts(3, {
        source: `archive:${TRIAL_SPARRING_SUBSTITUTE.id}/${TRIAL_SPARRING_SUBSTITUTE.runId}`,
      }),
    },
    {
      what: "maps[1].sha256",
      input: { ...facts, maps: [maps[0], { ...maps[1], sha256: "d".repeat(64) }] },
    },
  ];
  const digests = new Set([plan.planSha256]);
  for (const variant of variants) {
    const digest = buildTrialPlan(variant.input).planSha256;
    expect(digest, variant.what).not.toBe(plan.planSha256);
    digests.add(digest);
  }
  // 八个字段各自落到不同的摘要，不是「一变全变、彼此不可分」。
  expect(digests.size).toBe(variants.length + 1);
});

it("由事实重建的计划自校验通过；摘要与正文一致", () => {
  expect(() => checkTrialPlan(plan)).not.toThrow();
  const { planSha256, ...body } = plan;
  expect(planSha256).toBe(hashOf(JSON.parse(JSON.stringify(body)) as JsonValue));
});

it("改座位 / 改种子 / 改地图 / 改组合：校验拒绝并指明是哪一处", () => {
  const seatSwap = [scriptOf(1)!.id, TRIAL_CANDIDATE_ID, scriptOf(2)!.id, scriptOf(3)!.id] as const;
  expect(() => checkTrialPlan(matchPatched(1, { seats: seatSwap }))).toThrow(/matches\[1\]\.seats/);
  expect(() => checkTrialPlan(matchPatched(1, { seed: 999 }))).toThrow(/matches\[1\]\.seed/);
  expect(() => checkTrialPlan(matchPatched(0, { candidateSeat: 1 }))).toThrow(
    /matches\[0\]\.candidateSeat/,
  );
  expect(() => checkTrialPlan(matchPatched(2, { map: TRIAL_GRID_MAP_NAMES[1] }))).toThrow(
    /matches\[2\]\.map/,
  );
  expect(() => checkTrialPlan(matchPatched(3, { comboIndex: 2 }))).toThrow(
    /matches\[3\]\.comboIndex/,
  );
  expect(() => checkTrialPlan(tampered({ matches: plan.matches.slice(0, 2) }))).toThrow(
    /matches 长度不符/,
  );
});

it("座位/种子连摘要一起重算也拒：场次由事实派生，不是随手写的", () => {
  expect(() => checkTrialPlan(rehashed({ matches: plan.matches }))).not.toThrow();
  expect(() =>
    checkTrialPlan(
      rehashed({
        matches: plan.matches.map((match, index) =>
          index === 0
            ? {
                ...match,
                seats: [
                  ...match.seats,
                ].reverse() as unknown as TrialPlan["matches"][number]["seats"],
              }
            : match,
        ),
      }),
    ),
  ).toThrow(/matches\[0\]\.seats/);
});

it("换一份陪练摘要：改了正文却没重算摘要即拒，指名 planSha256", () => {
  const swapped = tampered({
    scripts: plan.scripts.map((script, index) =>
      index === 1 ? { ...script, scriptSha256: "e".repeat(64) } : script,
    ),
  });
  expect(() => checkTrialPlan(swapped)).toThrow(/planSha256/);
  expect(
    trialPlanMismatch(
      plan,
      buildTrialPlan({
        ...facts,
        scripts: sparringScripts.map((script, index) =>
          index === 1 ? { ...script, scriptSha256: "e".repeat(64) } : script,
        ),
      }),
    ),
  ).toMatch(/scripts\[1\]\.scriptSha256/);
});

it("同一 slug 可按角色并存（候选就是在位模型时）：角色限定 id 让计划不撞名", () => {
  const sameSlug = sparringScripts.map((script, index) =>
    index === 0
      ? { ...script, id: `top:${TRIAL_SPARRING_SUBSTITUTE.id}` }
      : index === 3
        ? { ...script, id: `incumbent:${TRIAL_SPARRING_SUBSTITUTE.id}` }
        : script,
  );
  const built = buildTrialPlan({ ...facts, scripts: sameSlug });
  expect(built.scripts.map((script) => script.id)).toContain(`top:${TRIAL_SPARRING_SUBSTITUTE.id}`);
  expect(built.scripts.map((script) => script.id)).toContain(
    `incumbent:${TRIAL_SPARRING_SUBSTITUTE.id}`,
  );
  expect(new Set(built.scripts.map((script) => script.id)).size).toBe(4);
  expect(() => checkTrialPlan(built)).not.toThrow();
});

it("构造输入本身不合法：陪练数、候选占位、重复 id、未知角色、id 与角色不配、地图数都指名拒绝", () => {
  expect(() => buildTrialPlan({ ...facts, scripts: sparringScripts.slice(0, 3) })).toThrow(
    /scripts 必须是 4/,
  );
  expect(() =>
    buildTrialPlan({
      ...facts,
      scripts: sparringScripts.map((script, index) =>
        index === 0 ? { ...script, id: TRIAL_CANDIDATE_ID } : script,
      ),
    }),
  ).toThrow(/scripts\[0\]\.id/);
  // 同一份 id 抄到别的角色上：先被「id 与角色不配」拦（角色限定 id 让撞名不再可能）。
  expect(() =>
    buildTrialPlan({
      ...facts,
      scripts: sparringScripts.map((script, index) =>
        index === 1 ? { ...script, id: scriptOf(0)!.id } : script,
      ),
    }),
  ).toThrow(/scripts\[1\]\.id/);
  expect(() =>
    buildTrialPlan({
      ...facts,
      scripts: sparringScripts.map((script, index) =>
        index === 0 ? { ...script, role: "rival" as never } : script,
      ),
    }),
  ).toThrow(/scripts\[0\]\.role/);
  // 基准脚本角色属于 v1 历史取值：网格计划不用它。
  expect(() =>
    buildTrialPlan({
      ...facts,
      scripts: sparringScripts.map((script, index) =>
        index === 0
          ? { ...script, role: "benchmark" as const, source: "benchmark:cell-a-melee-pressure" }
          : script,
      ),
    }),
  ).toThrow(/scripts\[0\]\.role/);
  // id 的角色前缀与 role 必须一致（否则座位表无法说明「哪一份」）。
  expect(() =>
    buildTrialPlan({
      ...facts,
      scripts: sparringScripts.map((script, index) =>
        index === 1 ? { ...script, id: `top:${script.id.split(":")[1]}` } : script,
      ),
    }),
  ).toThrow(/scripts\[1\]\.id/);
  expect(() => buildTrialPlan({ ...facts, maps: [maps[0]] })).toThrow(/maps 必须是/);
  expect(() => buildTrialPlan({ ...facts, maps: [maps[1], maps[0]] })).toThrow(/maps\[0\]\.name/);
  expect(() => buildTrialPlan({ ...facts, rulesetSha256: "not-a-digest" })).toThrow(
    /rulesetSha256/,
  );
});

it("汇总 = 计划的投影：32 场齐才写，缺一场/多一场/重复一场即拒", () => {
  // 每场都有终局事实（候选全胜）：汇总现在还要落分数，缺终局就没法算。
  const readings = gridReadingsFixture(plan);
  const summary = buildTrialGridSummary({
    plan,
    scriptSha256: "a".repeat(64),
    readings,
  });
  expect(summary.version).toBe(TRIAL_PLAN_VERSION);
  expect(summary.plan).toBe(plan);
  expect(summary.scriptSha256).toBe("a".repeat(64));
  expect(summary.matches).toEqual(
    plan.matches.map((match) => ({
      matchIndex: match.matchIndex,
      seed: match.seed,
      candidateSeat: match.candidateSeat,
      map: match.map,
      mapSha256: match.mapSha256,
    })),
  );
  // 候选每场都是第一名 → 32 × 3 = 96，分母恒等于计划声明的场数。
  expect(summary.score).toEqual({
    totalPoints: 96,
    averagePoints: 3,
    countedMatches: TRIAL_MATCHES_PER_CANDIDATE,
  });
  expect(() =>
    buildTrialGridSummary({ plan, scriptSha256: "a".repeat(64), readings: readings.slice(1) }),
  ).toThrow(/缺少计划里的第 0 场/);
  expect(() =>
    buildTrialGridSummary({
      plan,
      scriptSha256: "a".repeat(64),
      readings: [...readings, { matchIndex: TRIAL_MATCHES_PER_CANDIDATE }],
    }),
  ).toThrow(/多出计划之外的第 32 场/);
  expect(() =>
    buildTrialGridSummary({
      plan,
      scriptSha256: "a".repeat(64),
      readings: [...readings, { matchIndex: 0 }],
    }),
  ).toThrow(/同一场出现了多条读数/);
  expect(() => buildTrialGridSummary({ plan, scriptSha256: "not-a-digest", readings })).toThrow(
    /scriptSha256/,
  );
});

it("单场身份：同计划同候选脚本同场次相同；换一场或换候选脚本即变", () => {
  const scriptSha256 = "a".repeat(64);
  const first = plan.matches[0]!;
  expect(trialMatchInputSha256(plan, scriptSha256, first)).toBe(
    trialMatchInputSha256(plan, scriptSha256, plan.matches[0]!),
  );
  expect(trialMatchInputSha256(plan, scriptSha256, first)).not.toBe(
    trialMatchInputSha256(plan, scriptSha256, plan.matches[1]!),
  );
  expect(trialMatchInputSha256(plan, scriptSha256, first)).not.toBe(
    trialMatchInputSha256(plan, "b".repeat(64), first),
  );
  expect(trialMatchInputSha256(plan, scriptSha256, first)).not.toBe(
    trialMatchInputSha256(
      buildTrialPlan({ ...facts, rulesetSha256: "c".repeat(64) }),
      scriptSha256,
      first,
    ),
  );
});

it("历史存档（版本 1、无 plan 字段）明确报「无计划字段」，不迁移也不回填", () => {
  const archive = archiveTrialPlanOf({
    version: 1,
    feedbackRounds: 2,
    trialSeeds: [101, 202, 303],
  });
  expect(archive.kind).toBe("absent");
  if (archive.kind !== "absent") return;
  expect(archive.version).toBe(1);
  expect(archive.note).toContain("版本 1");
  expect(archive.note).toContain("无计划字段");
});

it("新存档带计划：读回完全一致；被改过的计划在读入处即被拒", () => {
  const stored = JSON.parse(JSON.stringify(plan)) as JsonValue;
  expect(archiveTrialPlanOf({ version: 2, plan: stored })).toEqual({ kind: "plan", plan });
  expect(() =>
    archiveTrialPlanOf({
      version: 2,
      plan: {
        ...(stored as unknown as Record<string, JsonValue>),
        matches: plan.matches.map((match, index) =>
          index === 1 ? { ...match, seed: 404 } : match,
        ),
      },
    }),
  ).toThrow(/matches\[1\]\.seed/);
  expect(() => archiveTrialPlanOf({ version: 1 })).not.toThrow();
  expect(() => archiveTrialPlanOf(null)).toThrow(/optimization 必须是对象/);
});

it("计划读入认 JSON Schema：正例读回逐字相同，缺字段/额外字段/未知版本都拒", () => {
  const stored = JSON.parse(JSON.stringify(plan)) as Record<string, JsonValue>;
  expect(readTrialPlan(stored)).toEqual(plan);
  expect(() => readTrialPlan({ ...stored, extra: 1 })).toThrow(/plan 形状不合法/);
  const { planSha256, ...withoutDigest } = stored;
  void planSha256;
  expect(() => readTrialPlan(withoutDigest)).toThrow(/plan 形状不合法/);
  expect(() => readTrialPlan({ ...stored, version: 1 })).toThrow(/plan 形状不合法/);
  expect(() => readTrialPlan({ ...stored, matchesPerCandidate: 3 })).toThrow(/plan 形状不合法/);
});
