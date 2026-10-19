import { expect, it } from "vitest";
import { parseTrialTerminalSummary } from "./terminal-summary.js";
import { terminalSummaryFixture } from "./terminal-summary.fixture.js";

it("公共读入接受01真实手算终态，并重建独立的白名单数据", () => {
  const value = terminalSummaryFixture();
  const parsed = parseTrialTerminalSummary(value, 0);
  expect(parsed).toEqual(value);
  expect(parsed).not.toBe(value);
  expect(parsed?.players[0]).not.toBe(value.players[0]);
  expect(parsed?.players[0].survivingUnits).not.toBe(value.players[0].survivingUnits);
  expect(parsed?.players[0].score).not.toBe(value.players[0].score);
  expect(parsed?.weights).not.toBe(value.weights);
  expect(parsed?.unitCosts).not.toBe(value.unitCosts);
  expect(parsed?.rankPoints).not.toBe(value.rankPoints);
});

it.each<[string, (value: ReturnType<typeof terminalSummaryFixture>) => void]>([
  [
    "victory非胜者仍控点",
    (s) => {
      s.reason = "victory";
      s.players[0].rankPoints = 3;
      for (const player of s.players.slice(1)) {
        player.rank = 2;
        player.rankPoints = 1;
      }
    },
  ],
  [
    "淘汰方仍控基地与资源点",
    (s) => {
      s.players[0].alive = false;
      s.players[0].eliminatedAtTick = 0;
      s.players[0].rank = 4;
      s.players[0].rankPoints = 0;
      for (const player of s.players.slice(1)) player.rankPoints = 2;
    },
  ],
  [
    "completed零tick",
    (s) => {
      s.tick = 0;
    },
  ],
  [
    "座位重复",
    (s) => {
      s.players[1].seat = 0;
    },
  ],
  [
    "基准身份错配",
    (s) => {
      s.players[1].player = "provider-secret";
    },
  ],
  [
    "候选身份错配",
    (s) => {
      s.players[0].player = "another-candidate";
    },
  ],
  [
    "兵种造价之和不符",
    (s) => {
      s.players[0].survivingUnitCost = 9;
    },
  ],
  [
    "基地分不符",
    (s) => {
      s.players[0].score.bases = 5;
    },
  ],
  [
    "资源分不符",
    (s) => {
      s.players[0].score.resources = 2;
    },
  ],
  [
    "单位分不符",
    (s) => {
      s.players[0].score.units = 2;
    },
  ],
  [
    "领土分不符",
    (s) => {
      s.players[0].territoryScore = 7;
    },
  ],
  [
    "存活却有淘汰时间",
    (s) => {
      s.players[0].eliminatedAtTick = 0;
    },
  ],
  [
    "淘汰却无时间",
    (s) => {
      s.players[0].alive = false;
    },
  ],
  [
    "淘汰时间等于执行tick数",
    (s) => {
      s.players[0].alive = false;
      s.players[0].eliminatedAtTick = 1;
    },
  ],
  [
    "计分乘法溢出",
    (s) => {
      s.weights.baseScore = Number.MAX_SAFE_INTEGER;
      s.players[0].controlledBases = 2;
    },
  ],
  [
    "兵种乘法溢出",
    (s) => {
      s.unitCosts.worker = Number.MAX_SAFE_INTEGER;
    },
  ],
])("公共读入拒绝跨字段不一致：%s", (_name, corrupt) => {
  const value = terminalSummaryFixture();
  corrupt(value);
  expect(parseTrialTerminalSummary(value, 0)).toBeNull();
});

it("公共读入固定三seed、matchIndex整数与完整闭合schema，不容纳缺失或额外载荷", () => {
  for (const [index, seed] of [101, 202, 303].entries()) {
    expect(parseTrialTerminalSummary(terminalSummaryFixture(seed), index)).not.toBeNull();
  }
  for (const index of [-1, 0.5, 3, NaN])
    expect(parseTrialTerminalSummary(terminalSummaryFixture(), index)).toBeNull();
  for (const value of [
    undefined,
    null,
    {},
    { ...terminalSummaryFixture(), seed: 202 },
    { ...terminalSummaryFixture(), providerRaw: "HOST_SECRET" },
    {
      ...terminalSummaryFixture(),
      weights: { ...terminalSummaryFixture().weights, extra: "HOST_SECRET" },
    },
    {
      ...terminalSummaryFixture(),
      unitCosts: { ...terminalSummaryFixture().unitCosts, extra: "HOST_SECRET" },
    },
    { ...terminalSummaryFixture(), rankPoints: [3, 2, 1] },
    { ...terminalSummaryFixture(), players: terminalSummaryFixture().players.slice(1) },
  ])
    expect(parseTrialTerminalSummary(value, 0)).toBeNull();
});

it("拒绝四方仍存活、名次合法却伪称shortcut的终局", () => {
  const s = terminalSummaryFixture(101, "shortcut");
  s.players[0].rankPoints = 3;
  for (const player of s.players.slice(1)) {
    player.rank = 2;
    player.rankPoints = 1;
  }
  expect(parseTrialTerminalSummary(s, 0)).toBeNull();
});

it.each([0, 1])("timeout不能有%s方存活，否则步5已提前结束", (aliveCount) => {
  const s = terminalSummaryFixture();
  for (const player of s.players) {
    const alive = player.seat < aliveCount;
    Object.assign(player, {
      controlledBases: 0,
      controlledResources: 0,
      score: { bases: 0, resources: 0, units: 1 },
      territoryScore: 1,
      alive,
      eliminatedAtTick: alive ? null : 0,
      rank: aliveCount === 1 && !alive ? 2 : 1,
      rankPoints: aliveCount === 1 ? (alive ? 3 : 1) : 1.5,
    });
  }
  expect(parseTrialTerminalSummary(s, 0)).toBeNull();
});

it("victory必须确实控制至少一个点位，不能由零控点残兵伪称全点位获胜", () => {
  const s = terminalSummaryFixture(101, "victory");
  for (const player of s.players) {
    player.controlledBases = 0;
    player.controlledResources = 0;
    player.score.bases = 0;
    player.score.resources = 0;
    player.territoryScore = player.score.units;
    player.rank = player.seat === 0 ? 1 : 2;
    player.rankPoints = player.seat === 0 ? 3 : 1;
  }
  expect(parseTrialTerminalSummary(s, 0)).toBeNull();
});

it.each(["victory", "shortcut"] as const)(
  "%s胜者优先于更高残留单位分，非胜者无控点且并列占据2..4",
  (reason) => {
    const s = terminalSummaryFixture(101, reason);
    s.players[0].controlledResources = 0;
    s.players[0].score.resources = 0;
    s.players[0].territoryScore = 5;
    s.players[0].rankPoints = 3;
    for (const p of s.players.slice(1)) {
      Object.assign(p, {
        controlledBases: 0,
        controlledResources: 0,
        survivingUnits: { worker: 0, melee: 0, ranged: 0, cavalry: 3 },
        survivingUnitCost: 48,
        score: { bases: 0, resources: 0, units: 8 },
        territoryScore: 8,
        alive: reason === "victory",
        eliminatedAtTick: reason === "victory" ? null : 0,
        rank: 2,
        rankPoints: 1,
      });
    }
    expect(parseTrialTerminalSummary(s, 0)).toEqual(s);
  },
);

it("timeout存活优先于淘汰残留单位分，并核对competition ranks [4,2,2,1]积分", () => {
  const s = terminalSummaryFixture();
  s.tick = 10;
  Object.assign(s.players[0], {
    alive: false,
    eliminatedAtTick: 0,
    controlledBases: 0,
    controlledResources: 0,
    survivingUnits: { worker: 0, melee: 0, ranged: 0, cavalry: 2 },
    survivingUnitCost: 32,
    score: { bases: 0, resources: 0, units: 5 },
    territoryScore: 5,
    rank: 4,
    rankPoints: 0,
  });
  for (const p of [s.players[1], s.players[2]])
    Object.assign(p, {
      controlledResources: 0,
      survivingUnits: { worker: 0, melee: 0, ranged: 0, cavalry: 0 },
      survivingUnitCost: 0,
      score: { bases: 4, resources: 0, units: 0 },
      territoryScore: 4,
      rank: 2,
      rankPoints: 1.5,
    });
  s.players[3].rankPoints = 3;
  expect(parseTrialTerminalSummary(s, 0)).toEqual(s);
  s.players[0].rank = 2;
  expect(parseTrialTerminalSummary(s, 0)).toBeNull();
});

it("all-eliminated按淘汰时间降序而非残留分数排序，同tick并列", () => {
  const s = terminalSummaryFixture(101, "all-eliminated");
  s.tick = 10;
  for (const p of s.players) {
    p.controlledBases = 0;
    p.controlledResources = 0;
    p.score.bases = 0;
    p.score.resources = 0;
    p.territoryScore = p.score.units;
    p.alive = false;
    p.eliminatedAtTick = 0;
    p.rank = 4;
    p.rankPoints = 0;
  }
  s.players[1].eliminatedAtTick = 5;
  s.players[1].rank = 2;
  s.players[1].rankPoints = 1.5;
  s.players[2].eliminatedAtTick = 5;
  s.players[2].rank = 2;
  s.players[2].rankPoints = 1.5;
  s.players[3].eliminatedAtTick = 9;
  s.players[3].rank = 1;
  s.players[3].rankPoints = 3;
  expect(parseTrialTerminalSummary(s, 0)).toEqual(s);
  s.players[1].rank = 3;
  expect(parseTrialTerminalSummary(s, 0)).toBeNull();
});

it.each<[string, (value: ReturnType<typeof terminalSummaryFixture>) => void]>([
  [
    "假competition跳号",
    (s) => {
      s.players[1].rank = 2;
    },
  ],
  [
    "假并列积分",
    (s) => {
      s.players[0].rankPoints = 3;
    },
  ],
  [
    "并列均分总和溢出",
    (s) => {
      s.rankPoints = [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 1, 0];
    },
  ],
  [
    "victory并列rank1",
    (s) => {
      s.reason = "victory";
    },
  ],
  [
    "shortcut并列rank1",
    (s) => {
      s.reason = "shortcut";
    },
  ],
  [
    "all-eliminated仍存活",
    (s) => {
      s.reason = "all-eliminated";
    },
  ],
])("公共读入拒绝名次或原因不一致：%s", (_name, corrupt) => {
  const s = terminalSummaryFixture();
  corrupt(s);
  expect(parseTrialTerminalSummary(s, 0)).toBeNull();
});
