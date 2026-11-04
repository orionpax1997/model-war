/**
 * 存档优化旁证的**版本分派**：v2（评测网格）的正例与反例，以及 v1 历史档仍然可读。
 *
 * 断言对象是 `optimizationMetaOf` / `validateArchiveCandidateRelations` 这两个读入端函数：
 * 形状归 JSON Schema（v1 / v2 两个完整分支，`oneOf` 分派），跨字段关系归这里的分派判据。
 *
 * ── 为什么 v1 也要有用例 ──
 *
 * `archive/` 里已冻结的档不改写、不迁移。任何「顺手收紧一下老档」的改动都会让历史档读不进来，
 * 所以 v1 有一条**真实档**（本地存在才跑）与一条合成档两条断言，v2 的每条新判据也各有反例。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import { optimizationMetaOf, validateArchiveCandidateRelations } from "./archive-optimization.js";
import { trialGridPlanFixture } from "./trial-grid.fixture.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const plan = trialGridPlanFixture();
const sha = (seed: string): string => seed.repeat(64);

const baseMeta = () => ({
  model: "alpha",
  modelVersion: "provider/alpha-1",
  generatedAt: "2026-01-01T00:00:00.000Z",
  protocolRounds: 3,
  prompts: ["初始", "第一轮事实回喂", "第二轮事实回喂"],
  generationLog: ["{}"],
  ruleset: plan.ruleset,
  validation: { passed: true, errors: [] },
  tscVersion: "7.0.2",
  sandboxRuntimeHash: plan.sandboxRuntimeHash,
});

const sparringOf = (): readonly unknown[] =>
  plan.scripts.map(({ id, role, source, scriptSha256 }) => ({ id, role, source, scriptSha256 }));

/** 一份候选记录的 v2 形状（分数与场数必写）；分数用 48/32 = 1.5 这一组自洽值。 */
type CandidateFixture = {
  readonly stage: 0 | 1 | 2;
  readonly protocolRound: number;
  readonly scriptFile: string;
  readonly observationsFile: string;
  readonly scriptSha256: string;
  readonly score: {
    readonly totalPoints: number;
    readonly averagePoints: number;
    readonly countedMatches: number;
  };
  readonly matchCount: number;
  readonly reusedFromStage?: 0 | 1 | 2;
};

const candidateOf = (
  stage: 0 | 1 | 2,
  scriptSha256 = sha(String(stage + 1)),
): CandidateFixture => ({
  stage,
  protocolRound: stage + 1,
  scriptFile: `observed-r1-round-${String(stage + 1)}.jsonl.candidate.js`,
  observationsFile: `observed-r1-round-${String(stage + 1)}.jsonl`,
  scriptSha256,
  score: { totalPoints: 48, averagePoints: 1.5, countedMatches: 32 },
  matchCount: 32,
});

/** v2 档：`scriptSha256` 认最后一个候选（没有选拔时最终 hash 的那条判据）。 */
const gridMetaOf = (
  options: {
    readonly candidates?: readonly CandidateFixture[];
    readonly sparring?: readonly unknown[];
    readonly plan?: unknown;
  } = {},
): unknown => {
  const candidates = options.candidates ?? [candidateOf(0), candidateOf(1), candidateOf(2)];
  return {
    ...baseMeta(),
    scriptSha256: candidates[2]?.scriptSha256 ?? sha("1"),
    optimization: {
      version: 2,
      feedbackRounds: 2,
      plan: options.plan ?? plan,
      sparring: options.sparring ?? sparringOf(),
      candidates,
    },
  };
};

it("v2 档：网格计划、四份陪练身份、每候选分数与场数一致即通过", () => {
  const meta = optimizationMetaOf(gridMetaOf());
  expect(meta?.optimization?.version).toBe(2);
  expect(validateArchiveCandidateRelations(meta!)).toBeUndefined();
});

it.each([
  [
    "缺整份计划",
    () => {
      const value = gridMetaOf() as { optimization: Record<string, unknown> };
      return { ...value, optimization: { ...value.optimization, plan: undefined } };
    },
  ],
  [
    "缺候选分数",
    () => {
      const candidates = [candidateOf(0), candidateOf(1), candidateOf(2)];
      const value = gridMetaOf({ candidates }) as { optimization: Record<string, unknown> };
      const withoutScore = { ...candidates[1] } as Record<string, unknown>;
      Reflect.deleteProperty(withoutScore, "score");
      return {
        ...value,
        optimization: {
          ...value.optimization,
          candidates: [candidates[0], withoutScore, candidates[2]],
        },
      };
    },
  ],
  [
    "缺场数",
    () => {
      const candidates = [candidateOf(0), candidateOf(1), candidateOf(2)];
      const value = gridMetaOf({ candidates }) as { optimization: Record<string, unknown> };
      const withoutCount = { ...candidates[0] } as Record<string, unknown>;
      Reflect.deleteProperty(withoutCount, "matchCount");
      return {
        ...value,
        optimization: {
          ...value.optimization,
          candidates: [withoutCount, candidates[1], candidates[2]],
        },
      };
    },
  ],
  [
    "多带 v1 的 trialSeeds",
    () => {
      const value = gridMetaOf() as { optimization: Record<string, unknown> };
      return { ...value, optimization: { ...value.optimization, trialSeeds: [101, 202, 303] } };
    },
  ],
  [
    "缺陪练身份",
    () => {
      const value = gridMetaOf() as { optimization: Record<string, unknown> };
      return { ...value, optimization: { ...value.optimization, sparring: undefined } };
    },
  ],
])("v2 档形状缺项即被拒（%s）", (_label, build) => {
  expect(() => optimizationMetaOf(build())).toThrow(/优化存档元数据形状不合法/);
});

it("v2 档：计划被改过（种子动了而摘要没重算）即被拒", () => {
  const tampered = {
    ...plan,
    matches: plan.matches.map((match, index) =>
      index === 0 ? { ...match, seed: match.seed + 1 } : match,
    ),
  };
  expect(() => optimizationMetaOf(gridMetaOf({ plan: tampered }))).toThrow(
    /matches\[0\]\.seed 不符/,
  );
});

it("v2 档：陪练身份与计划不同序或被换掉即被拒", () => {
  const sparring = sparringOf();
  const swapped = [sparring[1], sparring[0], sparring[2], sparring[3]];
  expect(() => optimizationMetaOf(gridMetaOf({ sparring: swapped }))).toThrow(
    /陪练身份与网格计划不一致/,
  );
});

it("v2 档：候考场数与计划不符、均分与总分不自洽即被拒", () => {
  const wrongCount = { ...candidateOf(0), matchCount: 31 };
  expect(() =>
    optimizationMetaOf(gridMetaOf({ candidates: [wrongCount, candidateOf(1), candidateOf(2)] })),
  ).toThrow(/优化存档元数据形状不合法/);

  const good = candidateOf(0);
  const wrongAverage = { ...good, score: { ...good.score, totalPoints: 47 } };
  expect(() =>
    optimizationMetaOf(gridMetaOf({ candidates: [wrongAverage, candidateOf(1), candidateOf(2)] })),
  ).toThrow(/均分与总分不一致/);
});

it("v2 档：同字节必须复用，复用来源必须是更早的同字节阶段，且分数逐位相同", () => {
  const same = sha("a");
  const reused = {
    ...candidateOf(1, same),
    reusedFromStage: 0 as const,
  };
  const source = candidateOf(0, same);
  // 正例：第 1 阶段复用第 0 阶段，分数一致。
  expect(
    optimizationMetaOf(gridMetaOf({ candidates: [source, reused, candidateOf(2)] })),
  ).toBeDefined();

  // 同字节却没写复用来源 → 拒。
  expect(() =>
    optimizationMetaOf(gridMetaOf({ candidates: [source, candidateOf(1, same), candidateOf(2)] })),
  ).toThrow(/同字节候选必须复用/);

  // 复用来源指向自己/更晚阶段，或指向不同字节的阶段 → 拒。
  expect(() =>
    optimizationMetaOf(
      gridMetaOf({
        candidates: [source, { ...reused, reusedFromStage: 1 as const }, candidateOf(2)],
      }),
    ),
  ).toThrow(/复用来源必须指向更早的同字节候选/);
  expect(() =>
    optimizationMetaOf(
      gridMetaOf({
        candidates: [source, { ...reused, reusedFromStage: 2 as const }, candidateOf(2)],
      }),
    ),
  ).toThrow(/复用来源必须指向更早的同字节候选/);

  // 复用但分数与来源不同 → 拒（复用阶段不许另有一份成绩）。
  const divergent = {
    ...reused,
    score: { totalPoints: 50, averagePoints: 50 / 32, countedMatches: 32 },
  };
  expect(() =>
    optimizationMetaOf(gridMetaOf({ candidates: [source, divergent, candidateOf(2)] })),
  ).toThrow(/复用候选的网格分数必须与来源逐位相同/);
});

it("v1 档（合成）：三场试跑形状仍照原判据通过，不要求计划与分数", () => {
  const scriptSha256 = sha("f");
  const value = {
    ...baseMeta(),
    scriptSha256,
    optimization: {
      version: 1,
      feedbackRounds: 2,
      trialSeeds: [101, 202, 303],
      candidates: [0, 1, 2].map((stage) => ({
        stage,
        protocolRound: stage + 1,
        scriptFile: `observed-r1-round-${String(stage + 1)}.jsonl.candidate.js`,
        observationsFile: `observed-r1-round-${String(stage + 1)}.jsonl`,
        scriptSha256,
      })),
    },
  };
  const meta = optimizationMetaOf(value);
  expect(meta?.optimization?.version).toBe(1);
  // 原判据仍然生效：阶段顺序被倒过来即拒。
  const reversed = structuredClone(value) as { optimization: { candidates: unknown[] } };
  reversed.optimization.candidates.reverse();
  expect(() => optimizationMetaOf(reversed)).toThrow(/优化候选阶段、协议轮或独占文件关系不合法/);
});

const realV1 = join(
  repoRoot,
  "archive",
  "claude-opus-5-5",
  "2026-10-16T08-40-12-578Z",
  "meta.json",
);
it.skipIf(!existsSync(realV1))(
  "真实 archive（本地有才断言）：v1 历史档仍可读，不因 v2 判据收严被拒",
  () => {
    const meta = optimizationMetaOf(JSON.parse(readFileSync(realV1, "utf8")));
    expect(meta?.optimization?.version).toBe(1);
    expect(meta?.optimization).not.toHaveProperty("plan");
    expect(meta?.optimization?.candidates).toHaveLength(3);
  },
);
