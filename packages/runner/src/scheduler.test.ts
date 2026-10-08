import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { scheduleSeason, type SeasonSchedulerDeps } from "./scheduler.js";

/**
 * `scheduleSeason` 的可测核心直测:用可控 `deps.spawnMatch` 桩替掉真实子进程。
 *
 * 断言对象是外部可观察产物——写出的 `input.json` 的键集与内容、`report.json` 的内容(含问题
 * 清单)、退出码、每局被 spawn 的次数——而不是内部函数调用。真沙箱那一路由
 * `apps/cli/src/cli.test.ts` 的 fixture 赛季 e2e 盯着,这里只盯调度逻辑本身(票 07 的
 * 并发池、退出码 2/3 重跑一次、1/4/null 中止、确定性排序)。
 */

const scratch = mkdtempSync(join(tmpdir(), "modelwar-scheduler-"));
afterAll(() => {
  rmSync(scratch, { force: true, recursive: true });
});

const MODELS = ["alpha", "beta", "gamma", "delta"] as const;

type Fixture = {
  readonly root: string;
  readonly configPath: string;
};

/** 固定时钟:让两次跑的 runId 一致,「并发 vs 串行逐字节相同」才有可比性。 */
const FIXED_NOW = (): Date => new Date("2026-01-01T00:00:00.000Z");

/**
 * 造一个最小赛季根:4 份存档 + 1 张地图 + season.yaml(M=1 × K=4 = 4 ≡ 0 (mod 4))。
 *
 * 可选 `concurrency` 写进 `season.yaml`;`now` 固定 runId;`outputDir` 固定产物目录名。
 */
const buildFixture = (
  options: {
    readonly mismatch?: boolean;
    readonly concurrency?: number;
    readonly outputDir?: string;
  } = {},
): Fixture => {
  const root = mkdtempSync(join(scratch, "root-"));
  for (const model of MODELS) {
    const dir = join(root, "archive", model, "r1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "script.js"), "function loop(){ return []; }\n");
    const meta = {
      model,
      modelVersion: "snapshot-1",
      generatedAt: "2026-01-01T00:00:00Z",
      protocolRounds: 1,
      prompts: [`prompt ${model}`],
      generationLog: [`generated ${model}`],
      ruleset: options.mismatch === true && model === "alpha" ? "v2" : "v1",
      validation: { passed: true, errors: [] },
      tscVersion: "7.0.2",
      scriptSha256: "a".repeat(64),
      sandboxRuntimeHash: "b".repeat(64),
    };
    writeFileSync(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  }
  mkdirSync(join(root, "maps"), { recursive: true });
  writeFileSync(join(root, "maps", "arena.json"), `${JSON.stringify({ name: "arena" })}\n`);
  const season = [
    'masterSeed: "seed-1"',
    "ruleset: v1",
    "seeds: 4",
    `outputDir: ${options.outputDir ?? "runs/fixture"}`,
    ...(options.concurrency !== undefined ? [`concurrency: ${options.concurrency}`] : []),
    "maps:",
    "  - arena",
    "participants:",
    ...MODELS.map((model) => `  - archive/${model}/r1`),
    "",
  ].join("\n");
  writeFileSync(join(root, "season.yaml"), season);
  return { root, configPath: "season.yaml" };
};

/** 在 `input.json` 同目录写一份合法回放(meta + 末行 result)。 */
const writeFakeReplay = (inputPath: string, reason = "timeout"): void => {
  const lines = [
    JSON.stringify({ type: "meta", schemaVersion: 1, ruleset: "v1" }),
    JSON.stringify({
      type: "result",
      rankings: [1, 2, 3, 4],
      reason,
      territoryScores: [0, 0, 0, 0],
    }),
  ];
  writeFileSync(join(dirname(inputPath), "replay.jsonl"), `${lines.join("\n")}\n`);
};

type ScriptedSpawn = {
  readonly spawnMatch: SeasonSchedulerDeps["spawnMatch"];
  /** 某局目录被 spawn 的次数(断言「重跑一次」= 2)。 */
  readonly attemptsOf: (matchName: string) => number;
};

/**
 * 可控 match 桩:按 `(局目录名, 第几次尝试)` 决定退出码;码 0 时写一份合法回放。
 *
 * 按**局目录名**分脚本而非全局序列,是为了在并发下每局的行为仍然确定(池完成顺序不影响
 * 「哪一局拿到哪段脚本」)。缺省回放 `reason` 可覆写。
 */
const scriptedSpawn = (
  plan: (matchName: string, attempt: number) => number | null,
  resultReason = "timeout",
): ScriptedSpawn => {
  const attempts = new Map<string, number>();
  return {
    spawnMatch: async (inputPath) => {
      const matchName = basename(dirname(inputPath));
      const attempt = (attempts.get(matchName) ?? 0) + 1;
      attempts.set(matchName, attempt);
      const code = plan(matchName, attempt);
      if (code === 0) {
        writeFakeReplay(inputPath, resultReason);
      }
      return { code };
    },
    attemptsOf: (matchName) => attempts.get(matchName) ?? 0,
  };
};

type ReportShape = {
  runId: string;
  ruleset: string;
  masterSeed: string;
  rankPoints: readonly number[];
  matches: readonly {
    matchId: string;
    comboId: string;
    mapIndex: number;
    seedIndex: number;
    map: string;
    seed: number;
    inputPath: string;
    seats: readonly string[];
    rankings: readonly number[];
    reason: string;
    perMatchScores: readonly number[];
  }[];
  standings: readonly {
    player: string;
    totalPoints: number;
    countedMatches: number;
    averagePoints: number;
    rank: number;
  }[];
  validationFailures: readonly unknown[];
  matchIssues: readonly {
    matchId: string;
    comboId: string;
    mapIndex: number;
    seedIndex: number;
    map: string;
    seed: number;
    inputPath: string;
    reason: string;
    exitCode: number;
    rerunCount: number;
    excludedFromRanking: boolean;
  }[];
};

const readReport = (root: string, outputDir = "runs/fixture"): ReportShape =>
  JSON.parse(readFileSync(join(root, outputDir, "report.json"), "utf8")) as ReportShape;

it("跑通一整季:退 0,每局物化 input.json(键集恰 5 项)并写出 report.json", async () => {
  const { root, configPath } = buildFixture();
  const stub = scriptedSpawn(() => 0);
  const code = await scheduleSeason({ root, configPath }, { spawnMatch: stub.spawnMatch });

  expect(code).toBe(0);

  const report = readReport(root);
  expect(report.ruleset).toBe("v1");
  expect(typeof report.runId).toBe("string");
  expect(report.masterSeed).toBe("seed-1");
  expect(report.rankPoints).toEqual([3, 2, 1, 0]);
  expect(report.matches).toHaveLength(4);
  expect(report.matchIssues).toHaveLength(0);
  expect(report.validationFailures).toEqual([]);
  expect(report.matches.map((match) => match.inputPath)).toEqual([
    "runs/fixture/matches/c0-arena-s0/input.json",
    "runs/fixture/matches/c0-arena-s1/input.json",
    "runs/fixture/matches/c0-arena-s2/input.json",
    "runs/fixture/matches/c0-arena-s3/input.json",
  ]);
  expect(report.matches.map((match) => match.matchId)).toEqual([
    "c0-arena-s0",
    "c0-arena-s1",
    "c0-arena-s2",
    "c0-arena-s3",
  ]);
  expect(report.matches.map((match) => match.comboId)).toEqual(["c0", "c0", "c0", "c0"]);
  expect(report.matches.map((match) => match.mapIndex)).toEqual([0, 0, 0, 0]);
  expect(report.matches.map((match) => match.seedIndex)).toEqual([0, 1, 2, 3]);
  for (const match of report.matches) {
    expect(match.comboId).toBe("c0");
    expect(match.map).toBe("arena");
    expect(match.rankings).toEqual([1, 2, 3, 4]);
    // 名次 [1,2,3,4] 下默认 [3,2,1,0] → 每座位得分就是 rankPoints 本身。
    expect(match.perMatchScores).toEqual([3, 2, 1, 0]);
    // 四个座位就是四个存档引用(轮换因局而异),集合恒为全员。
    expect([...match.seats].sort()).toEqual(MODELS.map((model) => `archive/${model}/r1`).sort());
    expect(match.reason).toBe("timeout");
    expect(Number.isInteger(match.seed)).toBe(true);
  }
  // s0 的轮换位移为 0,座位即 slug 升序的基准序列(alpha, beta, delta, gamma)。
  expect(report.matches[0]?.seats).toEqual(
    [...MODELS].sort().map((model) => `archive/${model}/r1`),
  );
  expect(new Set(report.matches.map((match) => match.seed)).size).toBe(4);

  // standings 是 rankSeason 的输出:桩回放的 rankings 恒为 [1,2,3,4]（按座位）,而座位逐局轮换,
  // 故每人各拿一次 1/2/3/4 名 → 总分 3+2+1+0 = 6,四人同分并列第 1。
  expect(report.standings).toHaveLength(4);
  for (const entry of report.standings) {
    expect(entry.countedMatches).toBe(4);
    expect(entry.totalPoints).toBe(6);
    expect(entry.rank).toBe(1);
  }
  expect(report.standings[0]?.player).toBe("archive/alpha/r1");

  // 每局 input.json 的键集恰为五项(书写序 = REQUIRED_KEYS 序),座位 = archives 下标。
  for (const match of report.matches) {
    const input = JSON.parse(readFileSync(join(root, match.inputPath), "utf8")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(input)).toEqual(["archives", "map", "mapSha256", "seed", "ruleset"]);
    const archives = input["archives"] as readonly Record<string, unknown>[];
    expect(archives).toHaveLength(4);
    for (const archive of archives) {
      expect(Object.keys(archive)).toEqual(["archivePath", "scriptSha256", "metaSha256"]);
    }
  }
});

it("规则版本前置拒绝:任一存档 meta.ruleset 与赛季声明不一致 → 退 1,不 spawn 任何一局", async () => {
  const { root, configPath } = buildFixture({ mismatch: true });
  const stub = scriptedSpawn(() => 0);
  const code = await scheduleSeason({ root, configPath }, { spawnMatch: stub.spawnMatch });

  expect(code).toBe(1);
  expect(stub.attemptsOf("c0-arena-s0")).toBe(0);
});

// ── 退出码分流(只认退出码) ────────────────────────────────────────────────

it("退出码 2:首发触发 → 恰好重跑一次,第二次成功则该局入报告、不进问题清单", async () => {
  const { root, configPath } = buildFixture({ concurrency: 1 });
  const stub = scriptedSpawn((name, attempt) => (name === "c0-arena-s0" && attempt === 1 ? 2 : 0));
  const code = await scheduleSeason({ root, configPath }, { spawnMatch: stub.spawnMatch });

  expect(code).toBe(0);
  const report = readReport(root);
  expect(stub.attemptsOf("c0-arena-s0")).toBe(2);
  expect(report.matchIssues).toHaveLength(0);
  expect(report.matches).toHaveLength(4);
  expect(report.matches.map((match) => match.inputPath)).toContain(
    "runs/fixture/matches/c0-arena-s0/input.json",
  );
});

it("退出码 2 连续两次 → 入问题清单(engine-crash)、排除出 matches、报告仍含该局", async () => {
  const { root, configPath } = buildFixture({ concurrency: 1 });
  const stub = scriptedSpawn((name) => (name === "c0-arena-s0" ? 2 : 0));
  const code = await scheduleSeason({ root, configPath }, { spawnMatch: stub.spawnMatch });

  expect(code).toBe(0);
  // 只重跑一次:总共两次 spawn,绝不无限重试。
  expect(stub.attemptsOf("c0-arena-s0")).toBe(2);

  const report = readReport(root);
  expect(report.matches).toHaveLength(3);
  expect(report.matches.map((match) => match.inputPath)).not.toContain(
    "runs/fixture/matches/c0-arena-s0/input.json",
  );
  expect(report.matchIssues).toHaveLength(1);
  const problem = report.matchIssues[0];
  expect(problem?.matchId).toBe("c0-arena-s0");
  expect(problem?.comboId).toBe("c0");
  expect(problem?.mapIndex).toBe(0);
  expect(problem?.seedIndex).toBe(0);
  expect(problem?.map).toBe("arena");
  expect(Number.isInteger(problem?.seed)).toBe(true);
  expect(problem?.inputPath).toBe("runs/fixture/matches/c0-arena-s0/input.json");
  expect(problem?.reason).toBe("engine-crash");
  expect(problem?.exitCode).toBe(2);
  expect(problem?.rerunCount).toBe(1);
  expect(problem?.excludedFromRanking).toBe(true);
  // 被剔除的局不进 matches，也不进均分分母:每人只计 3 局(s0 被剔, s1..s3 含全员)。
  const short = report.standings.find((entry) => entry.countedMatches === 3);
  expect(short).toBeDefined();
  expect(report.standings.every((entry) => entry.countedMatches === 3)).toBe(true);
});

it("退出码 3 连续两次 → 入问题清单(nondeterministic-timeout)、排除出 matches", async () => {
  const { root, configPath } = buildFixture({ concurrency: 1 });
  const stub = scriptedSpawn((name) => (name === "c0-arena-s1" ? 3 : 0));
  const code = await scheduleSeason({ root, configPath }, { spawnMatch: stub.spawnMatch });

  expect(code).toBe(0);
  expect(stub.attemptsOf("c0-arena-s1")).toBe(2);
  const report = readReport(root);
  expect(report.matches).toHaveLength(3);
  expect(report.matchIssues).toHaveLength(1);
  expect(report.matchIssues[0]?.reason).toBe("nondeterministic-timeout");
  expect(report.matchIssues[0]?.exitCode).toBe(3);
  expect(report.matchIssues[0]?.inputPath).toBe("runs/fixture/matches/c0-arena-s1/input.json");
});

it("退出码 3 首发、重跑成功 → 该局入报告、问题清单空", async () => {
  const { root, configPath } = buildFixture({ concurrency: 1 });
  const stub = scriptedSpawn((name, attempt) => (name === "c0-arena-s2" && attempt === 1 ? 3 : 0));
  const code = await scheduleSeason({ root, configPath }, { spawnMatch: stub.spawnMatch });

  expect(code).toBe(0);
  expect(stub.attemptsOf("c0-arena-s2")).toBe(2);
  expect(readReport(root).matchIssues).toHaveLength(0);
});

it("退出码 1 / 4 → 赛季级中止并按该码返回(不静默剔除、不重跑)", async () => {
  for (const [abortCode, expected] of [
    [1, 1],
    [4, 4],
  ] as const) {
    const { root, configPath } = buildFixture({ concurrency: 1 });
    // 第一局即踩中中止码;后面的局不该再被 spawn(整体中止)。
    const stub = scriptedSpawn((name) => (name === "c0-arena-s0" ? abortCode : 0));
    const code = await scheduleSeason({ root, configPath }, { spawnMatch: stub.spawnMatch });
    expect(code, `子进程退 ${abortCode}`).toBe(expected);
    // 中止码不重跑:只调了一次。
    expect(stub.attemptsOf("c0-arena-s0")).toBe(1);
  }
});

it("被信号杀(null)或未知退出码 → 赛季级中止(不静默丢弃、不进重跑轨)", async () => {
  for (const abortCode of [null, 7] as const) {
    const { root, configPath } = buildFixture({ concurrency: 1 });
    const stub = scriptedSpawn(() => abortCode);
    const code = await scheduleSeason({ root, configPath }, { spawnMatch: stub.spawnMatch });
    expect(code, `子进程回 ${String(abortCode)}`).toBe(1);
    expect(stub.attemptsOf("c0-arena-s0")).toBe(1);
  }
});

it("子进程无法启动(spawn 抛错)→ 赛季级中止", async () => {
  const { root, configPath } = buildFixture({ concurrency: 1 });
  const code = await scheduleSeason(
    { root, configPath },
    {
      spawnMatch: () => Promise.reject(new Error("spawn modelwar ENOENT")),
    },
  );
  expect(code).toBe(1);
});

it("码 0 的规则内结果(胜/全灭,含内存判负)绝不被误判为崩溃:不进问题清单", async () => {
  for (const reason of ["victory", "all-eliminated"] as const) {
    const { root, configPath } = buildFixture({ concurrency: 1 });
    const stub = scriptedSpawn(() => 0, reason);
    const code = await scheduleSeason({ root, configPath }, { spawnMatch: stub.spawnMatch });
    expect(code).toBe(0);
    const report = readReport(root);
    expect(report.matchIssues).toHaveLength(0);
    expect(report.matches.every((match) => match.reason === reason)).toBe(true);
    expect(report.matches).toHaveLength(4);
  }
});

// ── 并发 vs 串行:产出逐字节相同 ───────────────────────────────────────────

it("同一 fixture 下并发 4 与串行 1 产出的 report.json 逐字节相同", async () => {
  const serial = buildFixture({ concurrency: 1 });
  const parallel = buildFixture({ concurrency: 4 });

  const serialCode = await scheduleSeason(
    { root: serial.root, configPath: serial.configPath, now: FIXED_NOW },
    { spawnMatch: scriptedSpawn(() => 0).spawnMatch },
  );
  const parallelCode = await scheduleSeason(
    { root: parallel.root, configPath: parallel.configPath, now: FIXED_NOW },
    { spawnMatch: scriptedSpawn(() => 0).spawnMatch },
  );
  expect(serialCode).toBe(0);
  expect(parallelCode).toBe(0);

  const serialBytes = readFileSync(join(serial.root, "runs/fixture/report.json"));
  const parallelBytes = readFileSync(join(parallel.root, "runs/fixture/report.json"));
  expect(parallelBytes.equals(serialBytes)).toBe(true);

  // 顺带钉住:即使并发,输入也各自落在自己的目录(互不干扰)。
  const report = readReport(parallel.root);
  expect(new Set(report.matches.map((match) => match.inputPath)).size).toBe(4);
});
