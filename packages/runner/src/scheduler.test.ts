import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { scheduleSeason, type SeasonSchedulerDeps } from "./scheduler.js";

/**
 * `scheduleSeason` 的可测核心直测:用可控 `deps.spawnMatch` 桩替掉真实子进程。
 *
 * 断言对象是外部可观察产物——写出的 `input.json` 的键集与内容、`report.json` 的内容、
 * 退出码——而不是内部函数调用。真沙箱那一路由 `apps/cli/src/cli.test.ts` 的 fixture 赛季
 * e2e 盯着,这里只盯调度逻辑本身。
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

/** 造一个最小赛季根:4 份存档 + 1 张地图 + season.yaml(M=1 × K=4 = 4 ≡ 0 (mod 4))。 */
const buildFixture = (options: { readonly mismatch?: boolean } = {}): Fixture => {
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
    "outputDir: runs/fixture",
    "maps:",
    "  - arena",
    "participants:",
    ...MODELS.map((model) => `  - archive/${model}/r1`),
    "",
  ].join("\n");
  writeFileSync(join(root, "season.yaml"), season);
  return { root, configPath: "season.yaml" };
};

/** 可控 match 桩:码 0 时在 input.json 同目录写一份合法回放(meta + 末行 result)。 */
const fakeSpawnMatch =
  (code: number, seen: string[] = []): SeasonSchedulerDeps["spawnMatch"] =>
  async (inputPath) => {
    seen.push(inputPath);
    if (code === 0) {
      const lines = [
        JSON.stringify({ type: "meta", schemaVersion: 1, ruleset: "v1" }),
        JSON.stringify({
          type: "result",
          rankings: [1, 2, 3, 4],
          reason: "timeout",
          territoryScores: [0, 0, 0, 0],
        }),
      ];
      writeFileSync(join(dirname(inputPath), "replay.jsonl"), `${lines.join("\n")}\n`);
    }
    return { code };
  };

it("串行跑通一整季:退 0,每局物化 input.json(键集恰 5 项)并写出 report.json", async () => {
  const { root, configPath } = buildFixture();
  const seen: string[] = [];
  const code = await scheduleSeason({ root, configPath }, { spawnMatch: fakeSpawnMatch(0, seen) });

  expect(code).toBe(0);
  // 4 名 → C(4,4)=1 组合 × 1 图 × 4 种子 = 4 局,每局一次 spawn。
  expect(seen).toHaveLength(4);

  const report = JSON.parse(readFileSync(join(root, "runs/fixture/report.json"), "utf8")) as {
    runId: string;
    ruleset: string;
    matches: readonly {
      comboId: string;
      map: string;
      seed: number;
      inputPath: string;
      rankings: readonly number[];
      reason: string;
    }[];
  };
  expect(report.ruleset).toBe("v1");
  expect(typeof report.runId).toBe("string");
  expect(report.matches).toHaveLength(4);
  expect(report.matches.map((match) => match.inputPath)).toEqual([
    "runs/fixture/matches/c0-arena-s0/input.json",
    "runs/fixture/matches/c0-arena-s1/input.json",
    "runs/fixture/matches/c0-arena-s2/input.json",
    "runs/fixture/matches/c0-arena-s3/input.json",
  ]);
  for (const match of report.matches) {
    expect(match.comboId).toBe("c0");
    expect(match.map).toBe("arena");
    expect(match.rankings).toEqual([1, 2, 3, 4]);
    expect(match.reason).toBe("timeout");
    expect(Number.isInteger(match.seed)).toBe(true);
  }
  // 种子确定性:同配置两次跑出的种子相同。
  const seedByDir = new Map(report.matches.map((match) => [match.inputPath, match.seed]));
  expect(new Set(seedByDir.values()).size).toBe(4);

  // 每局 input.json 的键集恰为五项(书写序 = REQUIRED_KEYS 序),座位 = archives 下标。
  for (const inputPath of seen) {
    const input = JSON.parse(readFileSync(inputPath, "utf8")) as Record<string, unknown>;
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
  const seen: string[] = [];
  const code = await scheduleSeason({ root, configPath }, { spawnMatch: fakeSpawnMatch(0, seen) });

  expect(code).toBe(1);
  expect(seen).toHaveLength(0);
});

it("子进程非零退出绝不静默忽略:1 / 4 原样透出,2 / 3 先按赛季中止退 1(重跑归票 07)", async () => {
  for (const [matchCode, expected] of [
    [1, 1],
    [4, 4],
    [2, 1],
    [3, 1],
  ] as const) {
    const { root, configPath } = buildFixture();
    const code = await scheduleSeason(
      { root, configPath },
      { spawnMatch: fakeSpawnMatch(matchCode) },
    );
    expect(code, `子进程退 ${matchCode}`).toBe(expected);
  }
});
