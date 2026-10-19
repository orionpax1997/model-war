import { expect, it } from "vitest";
import {
  type ArchiveSelection,
  type ReplayResultLine,
  type SelectionPlan,
} from "@model-war/schema";
import {
  buildArchiveSelection,
  buildSelectionPlan,
  selectionInputSha256,
  validateSelection,
  type SelectionCandidateEvidence,
} from "./selection.js";
import { perMatchScores } from "./ranker.js";

const plan = buildSelectionPlan({
  ruleset: "v2",
  rulesetSha256: "9".repeat(64),
  sandboxRuntimeHash: "f".repeat(64),
  map: "arena",
  mapSha256: "e".repeat(64),
  baselines: [
    { id: "idle", scriptSha256: "a".repeat(64) },
    { id: "rush", scriptSha256: "b".repeat(64) },
    { id: "gather", scriptSha256: "c".repeat(64) },
  ],
});
const evidence = (
  ranks: readonly [number, number, number],
  identical = false,
  inputPlan: SelectionPlan = plan,
): SelectionCandidateEvidence[] =>
  ([0, 1, 2] as const).map((stage) => {
    const scriptSha256 = (identical ? "d" : String(stage)).repeat(64);
    return {
      stage,
      protocolRound: stage * 2 + 1,
      scriptSha256,
      sourceSha256: String(stage + 4).repeat(64),
      matches: inputPlan.matches.map((match) => {
        const rank = ranks[stage];
        const rest = [1, 2, 3, 4].filter((value) => value !== rank);
        let other = 0;
        const rankings = match.seats.map((seat) => (seat === "candidate" ? rank : rest[other++]!));
        const result: ReplayResultLine = {
          type: "result",
          rankings: [rankings[0]!, rankings[1]!, rankings[2]!, rankings[3]!],
          reason: "timeout",
          territoryScores: [0, 0, 0, 0],
        };
        return {
          matchIndex: match.matchIndex,
          inputSha256: selectionInputSha256(inputPlan, scriptSha256, match),
          result,
        };
      }),
    };
  });

it("计划固定三 seed、十二场、整组循环左移，基准相对环形顺序和输入 hash 确定", () => {
  expect(plan.matches).toHaveLength(12);
  for (const seed of [401, 402, 403]) {
    const matches = plan.matches.filter((match) => match.seed === seed);
    expect(matches.map((match) => match.candidateSeat)).toEqual([0, 3, 2, 1]);
    expect(matches.map((match) => match.seats)).toEqual([
      ["candidate", "idle", "rush", "gather"],
      ["idle", "rush", "gather", "candidate"],
      ["rush", "gather", "candidate", "idle"],
      ["gather", "candidate", "idle", "rush"],
    ]);
  }
  expect(buildSelectionPlan(plan)).toEqual(plan);
  expect(buildSelectionPlan({ ...plan, mapSha256: "d".repeat(64) }).planSha256).not.toBe(
    plan.planSha256,
  );
});

it.each([
  [[1, 2, 4], 0, "highest-average-points"],
  [[2, 1, 4], 1, "highest-average-points"],
  [[4, 2, 1], 2, "highest-average-points"],
  [[4, 4, 4], 2, "later-stage"],
  [[1, 1, 4], 1, "later-stage"],
  [[4, 1, 1], 2, "later-stage"],
  [[1, 4, 1], 2, "later-stage"],
  [[1, 2, 2], 0, "highest-average-points"],
] as const)(
  "完整比赛名次 %j 选择阶段 %i；零交付、淘汰与正常 timeout 仍使用十二分母",
  (ranks, winner, reason) => {
    const selection = buildArchiveSelection(plan, evidence(ranks));
    expect(selection.selected.stage).toBe(winner);
    expect(selection.reason).toBe(reason);
    expect(selection.candidates.map((candidate) => candidate.stage)).toEqual([0, 1, 2]);
    for (const candidate of selection.candidates) {
      expect(candidate.countedMatches).toBe(12);
      expect(candidate.averagePoints).toBe(4 - ranks[candidate.stage]);
      expect(
        candidate.matches.every((match) =>
          match.result.territoryScores.every((score) => score === 0),
        ),
      ).toBe(true);
    }
    expect(validateSelection(JSON.parse(JSON.stringify(selection)))).toEqual(selection);
  },
);

it("四方全零并列均分与既有 ranker 一致；合法 all-eliminated 不构成选拔失败", () => {
  const candidates = evidence([1, 1, 1]).map((candidate) => ({
    ...candidate,
    matches: candidate.matches.map((match) => ({
      ...match,
      result: {
        ...match.result,
        reason: "all-eliminated" as const,
        rankings: [1, 1, 1, 1] as const,
      },
    })),
  }));
  const selection = buildArchiveSelection(plan, candidates);
  expect(selection.selected.stage).toBe(2);
  expect(selection.reason).toBe("later-stage");
  expect(selection.candidates.map((candidate) => candidate.averagePoints)).toEqual([1.5, 1.5, 1.5]);
  const scores = perMatchScores(
    "all-zero",
    ["a", "b", "c", "d"].map((player) => ({ player, rank: 1 })),
  );
  expect(selection.candidates[0]?.matches[0]?.candidatePoints).toBe(scores[0]);
});

it("同 JS 不同 TS/阶段保留三份身份，可用相同完整证据声明复用", () => {
  const candidates = evidence([2, 2, 2], true);
  const selection = buildArchiveSelection(
    plan,
    candidates.map((candidate) => ({
      ...candidate,
      ...(candidate.stage === 0 ? {} : { reusedFromStage: 0 as const }),
    })),
  );
  expect(selection.selected).toMatchObject({
    stage: 2,
    protocolRound: 5,
    sourceSha256: "6".repeat(64),
  });
  expect(new Set(selection.candidates.map((candidate) => candidate.scriptSha256)).size).toBe(1);
  expect(new Set(selection.candidates.map((candidate) => candidate.sourceSha256)).size).toBe(3);
  expect(selection.candidates[2]?.reusedFromStage).toBe(0);
  expect(() => buildArchiveSelection(plan, evidence([1, 2, 3], true))).toThrow(/同 JS/);
});

it.each([
  [[1, 1, 1], 0],
  [[1, 1, 4], 0],
  [[4, 1, 1], 1],
] as const)("旧 earlier-stage 记录 %j 按旧算法验证阶段 %i，拒绝错胜者和理由", (ranks, stage) => {
  const current = buildArchiveSelection(plan, evidence(ranks));
  const candidate = current.candidates[stage]!;
  const legacy: ArchiveSelection = {
    ...current,
    selected: {
      stage: candidate.stage,
      protocolRound: candidate.protocolRound,
      scriptSha256: candidate.scriptSha256,
      sourceSha256: candidate.sourceSha256,
    },
    reason: "earlier-stage",
  };
  expect(validateSelection(JSON.parse(JSON.stringify(legacy)))).toEqual(legacy);
  expect(() => validateSelection({ ...legacy, selected: current.selected })).toThrow(/胜者/);
  expect(() => validateSelection({ ...legacy, reason: "later-stage" })).toThrow(/胜者/);
});

it("最高集合的胜者与理由必须同时匹配，非法或不适用的理由不能绕过复算", () => {
  const tied = buildArchiveSelection(plan, evidence([1, 1, 4]));
  for (const reason of [
    "highest-average-points",
    "earlier-protocol-round",
    "script-hash",
    "invalid",
  ])
    expect(() => validateSelection({ ...tied, reason })).toThrow();
  for (const stage of [0, 2]) {
    const candidate = tied.candidates[stage]!;
    expect(() =>
      validateSelection({
        ...tied,
        selected: {
          stage: candidate.stage,
          protocolRound: candidate.protocolRound,
          scriptSha256: candidate.scriptSha256,
          sourceSha256: candidate.sourceSha256,
        },
      }),
    ).toThrow(/胜者/);
  }
  const unique = buildArchiveSelection(plan, evidence([1, 2, 2]));
  for (const reason of ["earlier-stage", "later-stage"])
    expect(() => validateSelection({ ...unique, reason })).toThrow(/理由/);
});

it("缺场、重复场次、错 input/candidate hash、伪造计分、计划或胜者不能通过验证", () => {
  const good = buildArchiveSelection(plan, evidence([2, 1, 4]));
  type MutableJson<T> = T extends string
    ? string
    : T extends number
      ? number
      : T extends readonly (infer Element)[]
        ? MutableJson<Element>[]
        : { -readonly [Key in keyof T]: MutableJson<T[Key]> };
  const mutations: ((value: MutableJson<ArchiveSelection>) => void)[] = [
    (value) => value.candidates[0]!.matches.pop(),
    (value) => (value.candidates[0]!.matches[1]!.matchIndex = 0),
    (value) => (value.candidates[0]!.matches[0]!.inputSha256 = "a".repeat(64)),
    (value) => (value.candidates[0]!.scriptSha256 = "a".repeat(64)),
    (value) => (value.candidates[0]!.matches[0]!.candidatePoints = 3),
    (value) => (value.candidates[0]!.averagePoints = 3),
    (value) => (value.candidates[0]!.matches[0]!.result.rankings = [1, 1, 2, 4]),
    (value) => (value.candidates[0]!.matches[0]!.result.type = "tick"),
    (value) => (value.plan.planSha256 = "a".repeat(64)),
    (value) => (value.plan.matches[0]!.candidateSeat = 2),
    (value) => (value.plan.seeds[0] = 101),
    (value) => (value.selected.stage = 2),
    (value) => (value.reason = "earlier-stage"),
    (value) => (value.candidates[2]!.reusedFromStage = 0),
  ];
  for (const mutate of mutations) {
    const changed = JSON.parse(JSON.stringify(good)) as MutableJson<ArchiveSelection>;
    mutate(changed);
    expect(() => validateSelection(changed)).toThrow();
  }
});

it("结果完成顺序可变，输出按阶段与场次排序；不接受缩小分母或缺少最终阶段", () => {
  const candidates = evidence([2, 1, 4]);
  expect(
    buildArchiveSelection(
      plan,
      [...candidates]
        .reverse()
        .map((candidate) => ({ ...candidate, matches: [...candidate.matches].reverse() })),
    ),
  ).toEqual(buildArchiveSelection(plan, candidates));
  expect(() => buildArchiveSelection(plan, candidates.slice(0, 2))).toThrow();
  expect(() =>
    buildArchiveSelection(
      plan,
      candidates.map((candidate) => ({ ...candidate, matches: candidate.matches.slice(0, 11) })),
    ),
  ).toThrow(/十二/);
});
