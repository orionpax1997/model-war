/**
 * 试跑计划：形状、摘要稳定性、篡改拒绝、单场身份与历史档读取。
 *
 * 断言对象都是**外部可观察的行为**：计划里有哪些场/种子/座位、同一输入两次构造的摘要、
 * 改任一字段后摘要是否变、被改过的计划是否被拒且报出哪一处不符、存档读出来是什么。
 * 不碰盘、不起 VM。
 */

import { expect, it } from "vitest";
import {
  TRIAL_BENCHMARK_IDS,
  TRIAL_PLAN_VERSION,
  TRIAL_SPARRING_ROLES,
  type JsonValue,
  type TrialPlan,
} from "@model-war/schema";

import { hashOf } from "./canonical.js";
import {
  archiveTrialPlanOf,
  buildTrialPlan,
  checkTrialPlan,
  readTrialPlan,
  trialMatchInputSha256,
  trialPlanMismatch,
  type BuildTrialPlanInput,
} from "./trial-plan.js";

const facts: BuildTrialPlanInput = {
  ruleset: "v2",
  rulesetSha256: "9".repeat(64),
  sandboxRuntimeHash: "8".repeat(64),
  scripts: TRIAL_BENCHMARK_IDS.map((id, index) => ({
    id,
    role: "benchmark",
    source: `benchmark:${id}`,
    scriptSha256: String(index + 1).repeat(64),
  })),
  maps: [{ name: "corridor-split", sha256: "f".repeat(64) }],
};

const plan = buildTrialPlan(facts);

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

it("v1 计划：单图三场，座位 = 候选 + 三份基准，候选 0 号位，种子逐场固定且连续编号", () => {
  expect(plan.version).toBe(TRIAL_PLAN_VERSION);
  expect(plan.matchesPerCandidate).toBe(3);
  expect(plan.matches.map((match) => match.matchIndex)).toEqual([0, 1, 2]);
  expect(plan.matches.map((match) => match.seed)).toEqual([101, 202, 303]);
  expect(plan.matches.map((match) => match.comboIndex)).toEqual([0, 0, 0]);
  expect(plan.maps).toEqual([{ name: "corridor-split", sha256: "f".repeat(64) }]);
  expect(plan.scripts.map((script) => script.id)).toEqual([...TRIAL_BENCHMARK_IDS]);
  expect(plan.scripts.map((script) => script.source)).toEqual(
    TRIAL_BENCHMARK_IDS.map((id) => `benchmark:${id}`),
  );
  for (const match of plan.matches) {
    expect(match.seats).toEqual([
      "candidate",
      TRIAL_BENCHMARK_IDS[0],
      TRIAL_BENCHMARK_IDS[1],
      TRIAL_BENCHMARK_IDS[2],
    ]);
    expect(match.candidateSeat).toBe(0);
    expect(match.map).toBe("corridor-split");
    expect(match.mapSha256).toBe("f".repeat(64));
  }
  // 计划只收对手：候选不占 role，也不进 scripts。
  expect(plan.scripts.some((script) => script.id === "candidate")).toBe(false);
  expect(plan.scripts.every((script) => TRIAL_SPARRING_ROLES.includes(script.role))).toBe(true);
});

it("同一份事实两次构造：整份计划（含 planSha256）逐字相同", () => {
  expect(buildTrialPlan(structuredClone(facts))).toStrictEqual(plan);
  expect(trialPlanMismatch(plan, buildTrialPlan(facts))).toBeNull();
});

it("改任一事实字段 → planSha256 必变（含对手摘要、地图摘要、规则集与运行时）", () => {
  const scripts = (index: number, patch: Partial<BuildTrialPlanInput["scripts"][number]>) =>
    facts.scripts.map((script, position) =>
      position === index ? { ...script, ...patch } : script,
    );
  const variants: readonly { readonly what: string; readonly input: BuildTrialPlanInput }[] = [
    { what: "ruleset", input: { ...facts, ruleset: "v1" } },
    { what: "rulesetSha256", input: { ...facts, rulesetSha256: "a".repeat(64) } },
    { what: "sandboxRuntimeHash", input: { ...facts, sandboxRuntimeHash: "b".repeat(64) } },
    { what: "scripts[1].id", input: { ...facts, scripts: scripts(1, { id: "another" }) } },
    { what: "scripts[1].role", input: { ...facts, scripts: scripts(1, { role: "top" }) } },
    {
      what: "scripts[1].source",
      input: { ...facts, scripts: scripts(1, { source: "archive:another/run" }) },
    },
    {
      what: "scripts[1].scriptSha256",
      input: { ...facts, scripts: scripts(1, { scriptSha256: "c".repeat(64) }) },
    },
    {
      what: "maps[0].name",
      input: { ...facts, maps: [{ name: "open-clash", sha256: "f".repeat(64) }] },
    },
    {
      what: "maps[0].sha256",
      input: { ...facts, maps: [{ name: "corridor-split", sha256: "d".repeat(64) }] },
    },
  ];
  const digests = new Set([plan.planSha256]);
  for (const variant of variants) {
    const digest = buildTrialPlan(variant.input).planSha256;
    expect(digest, variant.what).not.toBe(plan.planSha256);
    digests.add(digest);
  }
  // 九个字段各自落到不同的摘要，不是「一变全变、彼此不可分」。
  expect(digests.size).toBe(variants.length + 1);
});

it("由事实重建的计划自校验通过；摘要与正文一致", () => {
  expect(() => checkTrialPlan(plan)).not.toThrow();
  const { planSha256, ...body } = plan;
  expect(planSha256).toBe(hashOf(JSON.parse(JSON.stringify(body)) as JsonValue));
});

it("改座位 / 改种子 / 改地图：校验拒绝并指明是哪一处", () => {
  expect(() =>
    checkTrialPlan(
      matchPatched(1, {
        seats: [
          TRIAL_BENCHMARK_IDS[0],
          "candidate",
          TRIAL_BENCHMARK_IDS[1],
          TRIAL_BENCHMARK_IDS[2],
        ],
      }),
    ),
  ).toThrow(/matches\[1\]\.seats/);
  expect(() => checkTrialPlan(matchPatched(1, { seed: 999 }))).toThrow(/matches\[1\]\.seed/);
  expect(() => checkTrialPlan(matchPatched(0, { candidateSeat: 1 }))).toThrow(
    /matches\[0\]\.candidateSeat/,
  );
  expect(() => checkTrialPlan(matchPatched(2, { map: "open-clash" }))).toThrow(/matches\[2\]\.map/);
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
          index === 0 ? { ...match, seed: 404 } : match,
        ),
      }),
    ),
  ).toThrow(/matches\[0\]\.seed/);
});

it("换一份对手摘要：改了正文却没重算摘要即拒，且指出摘要不符", () => {
  const swapped = tampered({
    scripts: plan.scripts.map((script, index) =>
      index === 1 ? { ...script, scriptSha256: "e".repeat(64) } : script,
    ),
  });
  expect(() => checkTrialPlan(swapped)).toThrow(/planSha256/);
});

it("与预期计划逐字段比：对手摘要、规则集、运行时这三处各能指名", () => {
  const other = buildTrialPlan({
    ...facts,
    sandboxRuntimeHash: "7".repeat(64),
    scripts: facts.scripts.map((script, index) =>
      index === 2 ? { ...script, scriptSha256: "6".repeat(64) } : script,
    ),
  });
  expect(trialPlanMismatch(plan, other)).toMatch(/sandboxRuntimeHash/);
  const onlyScript = buildTrialPlan({
    ...facts,
    scripts: facts.scripts.map((script, index) =>
      index === 2 ? { ...script, scriptSha256: "6".repeat(64) } : script,
    ),
  });
  expect(trialPlanMismatch(plan, onlyScript)).toMatch(/scripts\[2\]\.scriptSha256/);
});

it("构造输入本身不合法：对手数、候选占位、重复 id、未知角色、多张地图都指名拒绝", () => {
  const scripts = facts.scripts;
  expect(() => buildTrialPlan({ ...facts, scripts: scripts.slice(0, 2) })).toThrow(
    /scripts 必须是 3/,
  );
  expect(() =>
    buildTrialPlan({
      ...facts,
      scripts: scripts.map((script, index) =>
        index === 0 ? { ...script, id: "candidate" } : script,
      ),
    }),
  ).toThrow(/scripts\[0\]\.id/);
  expect(() =>
    buildTrialPlan({
      ...facts,
      scripts: scripts.map((script) => ({ ...script, id: scripts[0]!.id })),
    }),
  ).toThrow(/scripts id 必须互异/);
  expect(() =>
    buildTrialPlan({
      ...facts,
      scripts: scripts.map((script, index) =>
        index === 0 ? { ...script, role: "rival" as never } : script,
      ),
    }),
  ).toThrow(/scripts\[0\]\.role/);
  expect(() => buildTrialPlan({ ...facts, maps: [] })).toThrow(/maps v1 只有一张地图/);
  expect(() => buildTrialPlan({ ...facts, rulesetSha256: "not-a-digest" })).toThrow(
    /rulesetSha256/,
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

it("计划读入关闭额外字段与未知版本，不做宽松兜底", () => {
  const stored = JSON.parse(JSON.stringify(plan)) as Record<string, JsonValue>;
  expect(() => readTrialPlan({ ...stored, extra: 1 })).toThrow(/不接受额外字段 extra/);
  expect(() => readTrialPlan({ ...stored, version: 2 })).toThrow(/plan\.version/);
  expect(() => readTrialPlan({ ...stored, scripts: undefined })).toThrow(/plan\.scripts 缺失/);
});
