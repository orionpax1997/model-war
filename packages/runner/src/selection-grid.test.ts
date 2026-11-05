/**
 * v2 选拔（评测网格）：排序用生成阶段分数、复算只校不对。
 *
 * 断言对象都是**外部可观察的行为**：谁赢、理由是什么、哪些证据被拒、拒得指不指得到某一处。
 * 网格是真形状（32 场，组合 × 座位 × 图），但一场对局都不跑——观测行是纯数据，
 * 复算比对吃的是「两批行是不是同一批」。
 */

import { expect, it } from "vitest";
import {
  SELECTION_GRID_VERSION,
  TRIAL_CANDIDATE_ID,
  TRIAL_GRID_MAP_NAMES,
  TRIAL_GRID_SEED_BASE,
  TRIAL_MATCHES_PER_CANDIDATE,
  TRIAL_SPARRING_LADDER,
  TRIAL_SPARRING_SUBSTITUTE,
  type JsonValue,
  type SelectionGridCandidate,
  type TrialGridScore,
  type TrialPlan,
  type TrialPlanMatch,
  type TrialPlanScript,
} from "@model-war/schema";

import { canonicalJson, hashOf } from "./canonical.js";
import {
  buildArchiveGridSelection,
  compareSelectionGridRecompute,
  observationRowSha256,
  selectionGridMatchEvidence,
  validateGridSelection,
  verifyGridSelectionEvidence,
} from "./selection-grid.js";
import { buildTrialPlan, trialMatchInputSha256 } from "./trial-plan.js";

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

const plan = buildTrialPlan({
  ruleset: "v2",
  rulesetSha256: "9".repeat(64),
  sandboxRuntimeHash: "8".repeat(64),
  scripts: sparringScripts,
  maps: [
    { name: TRIAL_GRID_MAP_NAMES[0], sha256: "f".repeat(64) },
    { name: TRIAL_GRID_MAP_NAMES[1], sha256: "e".repeat(64) },
  ],
});

/** 候选在某场里拿第 `rank` 名，其余三方按名次升序补满（与座位无关的写法）。 */
const rankingsWith = (match: TrialPlanMatch, rank: number): readonly number[] => {
  const rest = [1, 2, 3, 4].filter((value) => value !== rank);
  let cursor = 0;
  return match.seats.map((_, seat) => (seat === match.candidateSeat ? rank : rest[cursor++]!));
};

/**
 * 一张网格的观测行（生成阶段的原文形状里计分与比对用得上的那几栏）。
 *
 * 刻意保留 `delivered/captures/actionFacts` 之类与计分无关的栏：逐场比对必须把整行当一回事，
 * 只比名次就够的话，「同一格换了另一场比赛」是可以不被发现的。
 */
const rowsOf = (
  target: TrialPlan,
  rankOf: (match: TrialPlanMatch) => number,
  noise = 0,
): readonly JsonValue[] =>
  target.matches.map((match) => {
    const rankings = rankingsWith(match, rankOf(match));
    return {
      matchIndex: match.matchIndex,
      delivered: noise,
      captures: 0,
      noScoreSource: noise === 0,
      actionFacts: {
        version: 1,
        scriptSha256: "a".repeat(64),
        seed: match.seed,
        seat: match.candidateSeat,
      },
      terminalSummary: {
        version: 1,
        seed: match.seed,
        tick: 400,
        reason: "victory",
        weights: { baseScore: 4, resourceScore: 1, unitCostDivisor: 6 },
        unitCosts: { worker: 4, melee: 8, ranged: 12, cavalry: 16 },
        rankPoints: [3, 2, 1, 0],
        players: match.seats.map((player, seat) => ({
          seat,
          player,
          rank: rankings[seat]!,
          territoryScore: 6,
        })),
      },
    };
  });

/** 候选在每场拿第 `rank` 名（其余三方按名次补满）时的分数：积分表 3/2/1/0。 */
const scoreOf = (target: TrialPlan, rank: number): TrialGridScore => {
  const points = [3, 2, 1, 0][rank - 1] ?? 0;
  const totalPoints = points * target.matchesPerCandidate;
  return {
    totalPoints,
    averagePoints: totalPoints / target.matchesPerCandidate,
    countedMatches: target.matchesPerCandidate,
  };
};

/** 四方并列（每场每人 1.5 分）时的分数。 */
const tiedScore = (target: TrialPlan): TrialGridScore => ({
  totalPoints: 1.5 * target.matchesPerCandidate,
  averagePoints: 1.5,
  countedMatches: target.matchesPerCandidate,
});

/** 三份候选：`ranks[stage]` = 候选在每场拿第几名。 */
const candidateOf = (
  target: TrialPlan,
  stage: 0 | 1 | 2,
  rank: number,
  options: { readonly identical?: boolean } = {},
): SelectionGridCandidate => {
  const scriptSha256 = (options.identical === true ? "d" : String(stage)).repeat(64);
  // 同字节候选的网格证据本来就该是同一份（生成管线直接复用那一份）。
  const rows = rowsOf(target, () => rank, options.identical === true ? 0 : stage);
  const score = scoreOf(target, rank);
  return {
    stage,
    protocolRound: stage * 2 + 1,
    scriptSha256,
    sourceSha256: String(stage + 4).repeat(64),
    score,
    matches: selectionGridMatchEvidence({ plan: target, scriptSha256, rows, score }),
  };
};

const selectionOf = (
  ranks: readonly [number, number, number],
  options: { readonly identical?: boolean } = {},
): ReturnType<typeof buildArchiveGridSelection> =>
  buildArchiveGridSelection(
    plan,
    ([0, 1, 2] as const).map((stage) => candidateOf(plan, stage, ranks[stage], options)),
  );

type MutableJson<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends readonly (infer Element)[]
      ? MutableJson<Element>[]
      : { -readonly [Key in keyof T]: MutableJson<T[Key]> };

const mutable = (value: unknown): MutableJson<ReturnType<typeof selectionOf>> =>
  JSON.parse(JSON.stringify(value)) as MutableJson<ReturnType<typeof selectionOf>>;

it("计划就是生成阶段那张网格：32 场、四个座位各 8 场、两张图各 16 场、种子逐格派生", () => {
  expect(plan.matches).toHaveLength(TRIAL_MATCHES_PER_CANDIDATE);
  expect(plan.matchesPerCandidate).toBe(TRIAL_MATCHES_PER_CANDIDATE);
  expect(plan.matches.map((match) => match.seed)).toEqual(
    Array.from({ length: TRIAL_MATCHES_PER_CANDIDATE }, (_, index) => TRIAL_GRID_SEED_BASE + index),
  );
  const seats = new Map<number, number>();
  const maps = new Map<string, number>();
  for (const match of plan.matches) {
    seats.set(match.candidateSeat, (seats.get(match.candidateSeat) ?? 0) + 1);
    maps.set(match.map, (maps.get(match.map) ?? 0) + 1);
    expect(match.seats[match.candidateSeat]).toBe(TRIAL_CANDIDATE_ID);
  }
  // 座位号 0..3：显式按数值升序比，与原默认字符串排序同序（一位数字的字典序即数值序）。
  expect([...seats.entries()].sort((left, right) => left[0] - right[0])).toEqual([
    [0, 8],
    [1, 8],
    [2, 8],
    [3, 8],
  ]);
  expect([...maps.values()]).toEqual([16, 16]);
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
  "32 场网格名次 %j 选阶段 %i，理由 %s（决胜顺序不变：均分 → 较晚阶段 → 更早轮 → 脚本摘要）",
  (ranks, winner, reason) => {
    const selection = selectionOf(ranks);
    expect(selection.version).toBe(SELECTION_GRID_VERSION);
    expect(selection.selected.stage).toBe(winner);
    expect(selection.reason).toBe(reason);
    expect(selection.candidates.map((candidate) => candidate.stage)).toEqual([0, 1, 2]);
    for (const candidate of selection.candidates) {
      expect(candidate.score.countedMatches).toBe(TRIAL_MATCHES_PER_CANDIDATE);
      expect(candidate.score.averagePoints).toBe(4 - ranks[candidate.stage]);
      expect(candidate.matches).toHaveLength(TRIAL_MATCHES_PER_CANDIDATE);
    }
    expect(validateGridSelection(JSON.parse(JSON.stringify(selection)))).toEqual(selection);
  },
);

it("四方同一名次（并列均分）与候选全败都不缩分母：计分照走 32 场", () => {
  const allTied = buildArchiveGridSelection(
    plan,
    ([0, 1, 2] as const).map((stage) => {
      const scriptSha256 = String(stage).repeat(64);
      const rows = rowsOf(plan, () => 1).map((row) => {
        const terminal = (row as { terminalSummary: { players: { rank: number }[] } })
          .terminalSummary;
        for (const player of terminal.players) player.rank = 1;
        return row;
      });
      const score = tiedScore(plan);
      return {
        stage,
        protocolRound: stage + 1,
        scriptSha256,
        sourceSha256: String(stage + 4).repeat(64),
        score,
        matches: selectionGridMatchEvidence({ plan, scriptSha256, rows, score }),
      };
    }),
  );
  expect(allTied.candidates.map((candidate) => candidate.score.averagePoints)).toEqual([
    1.5, 1.5, 1.5,
  ]);
  expect(allTied.selected.stage).toBe(2);
  expect(allTied.reason).toBe("later-stage");
  expect(() => selectionOf([1, 4, 4])).not.toThrow();
  expect(selectionOf([1, 4, 4]).selected.stage).toBe(0);
});

it("同字节候选沿用复用记账，但每个阶段的证据都必须与来源逐场逐位相同", () => {
  const claimReuse = (values: readonly SelectionGridCandidate[]) =>
    values.map((candidate, index) => ({
      ...candidate,
      ...(index === 0 ? {} : { reusedFromStage: 0 as const }),
    }));

  const evidence = ([0, 1, 2] as const).map((stage) =>
    candidateOf(plan, stage, 2, { identical: true }),
  );
  // 同字节却不声明复用：形状上就写不出来（复用不是可选项）。
  expect(() => buildArchiveGridSelection(plan, evidence)).toThrow(/必须复用/);
  const reused = buildArchiveGridSelection(plan, claimReuse(evidence));
  expect(reused.candidates[2]?.reusedFromStage).toBe(0);
  expect(new Set(reused.candidates.map((candidate) => candidate.scriptSha256)).size).toBe(1);
  expect(new Set(reused.candidates.map((candidate) => candidate.sourceSha256)).size).toBe(3);
  expect(reused.selected).toMatchObject({ stage: 2, sourceSha256: "6".repeat(64) });
  expect(reused.reason).toBe("later-stage");
  // 复用来源的证据被改：来源的逐场摘要不能与本体分家。
  const tampered = claimReuse(evidence).map((candidate, index) =>
    index === 0
      ? {
          ...candidate,
          matches: candidate.matches.map((match, position) =>
            position === 7 ? { ...match, observationSha256: "a".repeat(64) } : match,
          ),
        }
      : candidate,
  );
  expect(() => buildArchiveGridSelection(plan, tampered)).toThrow(/复用证据/);
});

it("复用证据的比对按内容走：生成阶段那 32 行与记录逐场对上才算数", () => {
  const evidence = candidateOf(plan, 0, 1);
  const rows = rowsOf(plan, () => 1, 0);
  expect(() =>
    verifyGridSelectionEvidence({ plan, candidate: evidence, rows, score: evidence.score }),
  ).not.toThrow();
  // 伪造某一行的内容（总分不变）：逐场比对必须拒。
  const forged = rows.map((row, index) =>
    index === 5 ? { ...(row as Record<string, JsonValue>), delivered: 9 } : row,
  );
  expect(() =>
    verifyGridSelectionEvidence({ plan, candidate: evidence, rows: forged, score: evidence.score }),
  ).toThrow(/第 5 场/);
  // 伪造分数（总和不动、均分动了）：分数三元组逐位比。
  expect(() =>
    verifyGridSelectionEvidence({
      plan,
      candidate: evidence,
      rows,
      score: { ...evidence.score, averagePoints: 1.5 },
    }),
  ).toThrow(/分数/);
});

it("计划不符（换图 / 换座位 / 换种子 / 换陪练摘要）拒绝，并指到具体位置", () => {
  const base = selectionOf([1, 2, 4]);
  const mutations: readonly ((value: MutableJson<typeof base>) => void)[] = [
    (value) => {
      value.plan.matches[3]!.seed = 999;
      value.plan.planSha256 = "a".repeat(64);
    },
    (value) => {
      value.plan.matches[5]!.seats = [
        value.plan.matches[5]!.seats[1]!,
        value.plan.matches[5]!.seats[0]!,
        value.plan.matches[5]!.seats[2]!,
        value.plan.matches[5]!.seats[3]!,
      ];
      value.plan.planSha256 = "a".repeat(64);
    },
    (value) => {
      value.plan.maps[1]!.sha256 = "b".repeat(64);
      value.plan.planSha256 = "a".repeat(64);
    },
    (value) => {
      value.plan.scripts[1]!.scriptSha256 = "c".repeat(64);
      value.plan.planSha256 = "a".repeat(64);
    },
    (value) => {
      value.plan.matches[13]!.map = TRIAL_GRID_MAP_NAMES[0];
      value.plan.planSha256 = "a".repeat(64);
    },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const changed = mutable(base);
    mutate(changed);
    // 座位 / 种子 / 地图由事实派生，重建一步就能指到具体场次或地图；陪练**摘要**是事实而不是
    // 派生量，改它只能落在 `planSha256` 上（与生成阶段给的计划逐字比由 CLI 侧做）。
    expect(() => validateGridSelection(changed), `mutation ${String(index)}`).toThrow(
      index === 3 ? /planSha256/ : /matches\[|maps\[/,
    );
  }
});

it("逐场证据与分数三元组的篡改都被拒（缺场、重复场、伪造单场身份、伪造积分、改胜者）", () => {
  // `observationSha256` 不在这一层判：它要与盘上那 32 行观测比才有意义（CLI 的
  // `verifyGridSelectionEvidence` 与「观测行证据」用例各自钉住那一条）。
  const good = selectionOf([2, 1, 4]);
  // 每条篡改都要落在**它该落在的那一关**:形状、缺场/重复场、单场身份、单场积分、均分、
  // 阶段顺序、复用来源、胜者与理由。消息取自 `selection-grid.ts` 的 `fail(...)`。
  const mutations: readonly ((value: MutableJson<typeof good>) => void)[] = [
    (value) => value.candidates[0]!.matches.pop(),
    (value) => (value.candidates[0]!.matches[1]!.matchIndex = 0),
    (value) => (value.candidates[0]!.matches[0]!.inputSha256 = "a".repeat(64)),
    (value) => (value.candidates[0]!.matches[0]!.candidatePoints = 3),
    (value) => (value.candidates[0]!.score.totalPoints = 96),
    (value) => (value.candidates[0]!.score.averagePoints = 3),
    (value) => (value.candidates[0]!.score.countedMatches = 12),
    (value) => (value.candidates[0]!.scriptSha256 = "a".repeat(64)),
    (value) => (value.candidates[0]!.stage = 1),
    (value) => (value.candidates[2]!.reusedFromStage = 0),
    (value) => (value.selected.stage = 2),
    (value) => (value.reason = "later-stage"),
    (value) => (value.reason = "earlier-stage"),
    (value) => (value.version = 1),
  ];
  const expectedMessages = [
    "记录形状不合法或缺少完整网格证据",
    "第 1 场证据缺失或场次不符",
    "单场身份摘要不一致",
    "逐场名次积分之和与分数总分不一致",
    "均分与总分不一致",
    "均分与总分不一致",
    "记录形状不合法或缺少完整网格证据",
    "单场身份摘要不一致",
    "候选阶段或协议轮不一致",
    "复用来源必须指向更早的同字节候选",
    "胜者身份或选择理由与决胜顺序不一致",
    "胜者身份或选择理由与决胜顺序不一致",
    "记录形状不合法或缺少完整网格证据",
    "记录形状不合法或缺少完整网格证据",
  ] as const;
  expect(mutations).toHaveLength(expectedMessages.length);
  for (const [index, mutate] of mutations.entries()) {
    const changed = mutable(good);
    mutate(changed);
    expect(() => validateGridSelection(changed), `mutation ${String(index)}`).toThrow(
      expectedMessages[index],
    );
  }
});

it("复算比对逐场逐字：某一场不同即拒（总分相同也不算一致），分数三元组逐位比", () => {
  const generated = rowsOf(plan, () => 1);
  const score = scoreOf(plan, 1);
  expect(() =>
    compareSelectionGridRecompute({
      plan,
      generated,
      // 行序打乱也算相同：比的是场，不是书写顺序。
      recomputed: [...generated].reverse(),
      generatedScore: score,
      recomputedScore: { ...score },
    }),
  ).not.toThrow();

  const changedRow = generated.map((row, index) =>
    index === 30 ? { ...(row as Record<string, JsonValue>), captures: 1 } : row,
  );
  expect(() =>
    compareSelectionGridRecompute({
      plan,
      generated,
      recomputed: changedRow,
      generatedScore: score,
      recomputedScore: { ...score },
    }),
  ).toThrow(/第 30 场/);

  expect(() =>
    compareSelectionGridRecompute({
      plan,
      generated,
      recomputed: generated,
      generatedScore: score,
      recomputedScore: { ...score, totalPoints: 49 },
    }),
  ).toThrow(/分数/);

  expect(() =>
    compareSelectionGridRecompute({
      plan,
      generated,
      recomputed: generated.slice(0, 31),
      generatedScore: score,
      recomputedScore: { ...score },
    }),
  ).toThrow(/第 31 场/);
});

it("观测行证据：缺场、重复场、身份不符、名次非竞争排名、积分之和与总分不一致都拒", () => {
  const rows = rowsOf(plan, () => 1);
  const score = scoreOf(plan, 1);
  const scriptSha256 = "1".repeat(64);
  expect(
    selectionGridMatchEvidence({ plan, scriptSha256, rows, score }).map(
      (match) => match.matchIndex,
    ),
  ).toEqual(Array.from({ length: TRIAL_MATCHES_PER_CANDIDATE }, (_, index) => index));

  const patch = (index: number, change: (row: Record<string, JsonValue>) => void) =>
    rows.map((row, position) => {
      if (position !== index) return row;
      const copy = JSON.parse(JSON.stringify(row)) as Record<string, JsonValue>;
      change(copy);
      return copy;
    });
  const terminalOf = (row: Record<string, JsonValue>) =>
    row["terminalSummary"] as unknown as {
      seed: number;
      players: { seat: number; player: string; rank: number }[];
    };

  expect(() =>
    selectionGridMatchEvidence({ plan, scriptSha256, rows: rows.slice(1), score }),
  ).toThrow(/缺少计划里的第 0 场/);
  expect(() =>
    selectionGridMatchEvidence({ plan, scriptSha256, rows: [...rows, rows[0]!], score }),
  ).toThrow(/多条读数|多行观测/);
  expect(() =>
    selectionGridMatchEvidence({
      plan,
      scriptSha256,
      rows: patch(4, (row) => {
        terminalOf(row).seed = 1;
      }),
      score,
    }),
  ).toThrow(/第 4 场的终局种子/);
  expect(() =>
    selectionGridMatchEvidence({
      plan,
      scriptSha256,
      rows: patch(6, (row) => {
        terminalOf(row).players[0]!.player = "someone-else";
      }),
      score,
    }),
  ).toThrow(/第 6 场座位 0/);
  // 四方并列（整张网格都并列）：每场每人 1.5 分，校验的是「逐场积分之和 = 总分」。
  const tiedRows = patch(9, (row) => {
    for (const player of terminalOf(row).players) player.rank = 1;
  });
  expect(() =>
    selectionGridMatchEvidence({ plan, scriptSha256, rows: tiedRows, score: tiedScore(plan) }),
  ).toThrow(/逐场名次积分之和/);
  expect(() =>
    selectionGridMatchEvidence({
      plan,
      scriptSha256,
      rows: patch(9, (row) => {
        terminalOf(row).players[0]!.rank = 2;
      }),
      score,
    }),
  ).toThrow(/第 9 场/);
  expect(() =>
    selectionGridMatchEvidence({ plan, scriptSha256, rows, score: { ...score, totalPoints: 47 } }),
  ).toThrow(/逐场名次积分之和/);
  expect(() =>
    selectionGridMatchEvidence({
      plan,
      scriptSha256,
      rows,
      score: { ...score, countedMatches: 12 },
    }),
  ).toThrow(/分母/);
});

it("观测行摘要只认内容：键序不同同一摘要，值不同即不同", () => {
  const row = { matchIndex: 0, delivered: 0, captures: 0 };
  expect(observationRowSha256(row as JsonValue)).toBe(
    observationRowSha256({ captures: 0, delivered: 0, matchIndex: 0 } as JsonValue),
  );
  expect(observationRowSha256(row as JsonValue)).not.toBe(
    observationRowSha256({ ...row, captures: 1 } as JsonValue),
  );
  expect(observationRowSha256(row as JsonValue)).toBe(hashOf(row as JsonValue));
  expect(canonicalJson(row as JsonValue)).toBe(
    JSON.stringify({ captures: 0, delivered: 0, matchIndex: 0 }),
  );
});

it("单场身份摘要覆盖计划、候选与那一场：计划或候选一改，身份就不同", () => {
  const match = plan.matches[7]!;
  const base = trialMatchInputSha256(plan, "1".repeat(64), match);
  expect(trialMatchInputSha256(plan, "1".repeat(64), match)).toBe(base);
  expect(trialMatchInputSha256(plan, "2".repeat(64), match)).not.toBe(base);
  expect(trialMatchInputSha256(plan, "1".repeat(64), plan.matches[8]!)).not.toBe(base);
});
