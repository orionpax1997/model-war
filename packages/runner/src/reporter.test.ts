import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import type { RankPoints } from "./ranker.js";
import { rankSeason } from "./ranker.js";
import { renderReportJson, writeReportJson, type SeasonReport } from "./reporter.js";
import { scheduleSeason, type SeasonSchedulerDeps } from "./scheduler.js";

/**
 * `report.json` 的形状与「从写出的文件独立重算排名」(NFR-2)。
 *
 * 断言对象是**落盘后的文件**与它的内容,不是内部函数调用。NFR-2 那条尤其只从磁盘读
 * `report.json`,只用它的 `matches[].rankings` + `seats` + 顶层 `rankPoints` 重跑
 * `rankSeason`,与报告里的 `standings` 逐字段相等——证明报告端到端可复算。
 */

const scratch = mkdtempSync(join(tmpdir(), "modelwar-reporter-"));
afterAll(() => {
  rmSync(scratch, { force: true, recursive: true });
});

const MODELS = ["alpha", "beta", "gamma", "delta"] as const;

/** 造一个最小赛季根:4 份存档 + 1 张地图 + season.yaml(1 组合 × 1 图 × 4 种子)。 */
const buildSeasonRoot = (): { readonly root: string; readonly configPath: string } => {
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
      ruleset: "v1",
      validation: { passed: true, errors: [] },
      tscVersion: "7.0.2",
      scriptSha256: "a".repeat(64),
      sandboxRuntimeHash: "b".repeat(64),
    };
    writeFileSync(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  }
  mkdirSync(join(root, "maps"), { recursive: true });
  writeFileSync(join(root, "maps", "arena.json"), `${JSON.stringify({ name: "arena" })}\n`);
  writeFileSync(
    join(root, "season.yaml"),
    [
      'masterSeed: "seed-1"',
      "ruleset: v1",
      "seeds: 4",
      "outputDir: runs/fixture",
      "maps:",
      "  - arena",
      "participants:",
      ...MODELS.map((model) => `  - archive/${model}/r1`),
      "",
    ].join("\n"),
  );
  return { root, configPath: "season.yaml" };
};

/** 可控 match 桩:按 `(局目录名, 第几次尝试)` 决定退出码;码 0 时写一份合法回放。 */
const scriptedSpawn = (
  plan: (matchName: string, attempt: number) => number | null,
): SeasonSchedulerDeps => {
  const attempts = new Map<string, number>();
  return {
    spawnMatch: async (inputPath) => {
      const matchName = basename(dirname(inputPath));
      const attempt = (attempts.get(matchName) ?? 0) + 1;
      attempts.set(matchName, attempt);
      const code = plan(matchName, attempt);
      if (code === 0) {
        const replay = [
          JSON.stringify({ type: "meta", schemaVersion: 1, ruleset: "v1" }),
          JSON.stringify({
            type: "result",
            rankings: [1, 2, 3, 4],
            reason: "timeout",
            territoryScores: [0, 0, 0, 0],
          }),
          "",
        ].join("\n");
        writeFileSync(join(dirname(inputPath), "replay.jsonl"), replay);
      }
      return { code };
    },
  };
};

/** 跑一季并读回**写出的** `report.json`(临时根,真文件)。 */
const runAndReadReport = async (
  plan: (matchName: string, attempt: number) => number | null = () => 0,
): Promise<SeasonReport> => {
  const { root, configPath } = buildSeasonRoot();
  const code = await scheduleSeason(
    { root, configPath },
    { spawnMatch: scriptedSpawn(plan).spawnMatch },
  );
  expect(code).toBe(0);
  const written = readFileSync(join(root, "runs/fixture/report.json"), "utf8");
  return JSON.parse(written) as SeasonReport;
};

/** 只用报告自身的 `matches`(rankings + seats)与顶层 `rankPoints` 重算排名。 */
const recomputeStandings = (report: SeasonReport): ReturnType<typeof rankSeason> => {
  const players = [...new Set(report.matches.flatMap((match) => [...match.seats]))];
  return rankSeason(
    report.matches.map((match) => ({
      matchId: match.matchId,
      standings: match.seats.map((player, seat) => ({
        player,
        rank: match.rankings[seat] ?? 0,
      })),
    })),
    { players, rankPoints: report.rankPoints },
  );
};

it("renderReportJson 是纯函数:同输入恒同输出、末尾换行且可解析", () => {
  const report: SeasonReport = {
    runId: "2026-01-01T00-00-00-000Z",
    ruleset: "v1",
    masterSeed: "seed-1",
    rankPoints: [3, 2, 1, 0] as RankPoints,
    matches: [
      {
        matchId: "c0-arena-s0",
        inputPath: "runs/fixture/matches/c0-arena-s0/input.json",
        comboId: "c0",
        mapIndex: 0,
        seedIndex: 0,
        map: "arena",
        seed: 42,
        seats: ["archive/alpha/r1", "archive/beta/r1", "archive/gamma/r1", "archive/delta/r1"],
        rankings: [1, 2, 3, 4],
        reason: "timeout",
        perMatchScores: [3, 2, 1, 0],
      },
    ],
    standings: [],
    validationFailures: [],
    matchIssues: [],
  };
  const text = renderReportJson(report);
  expect(text).toBe(renderReportJson(report));
  expect(text.endsWith("\n")).toBe(true);
  expect(JSON.parse(text)).toEqual(report);
});

it("writeReportJson 落盘到磁盘:读回的文件与渲染文本逐字节相同", () => {
  const root = mkdtempSync(join(scratch, "write-"));
  const report = JSON.parse(renderReportJson(emptyReport())) as SeasonReport;
  const path = join(root, "nested", "report.json");
  writeReportJson(path, report);
  expect(readFileSync(path, "utf8")).toBe(renderReportJson(report));
});

it("NFR-2:只凭写出的 report.json 的 matches + rankPoints 重算,与 standings 逐字段相等", async () => {
  const report = await runAndReadReport();
  expect(report.matches).toHaveLength(4);
  expect(report.standings).toHaveLength(MODELS.length);
  expect(recomputeStandings(report)).toEqual(report.standings);
});

it("NFR-2:被剔除的失败局不进 matches、不计入分母,重算仍与 standings 一致", async () => {
  // 首发即退 2、重跑仍退 2 → 该局剔除;其余 3 局照常。
  const report = await runAndReadReport((name) => (name === "c0-arena-s0" ? 2 : 0));
  expect(report.matches).toHaveLength(3);
  expect(report.matchIssues).toHaveLength(1);
  expect(report.matchIssues[0]?.excludedFromRanking).toBe(true);
  // 剔除的局不在 matches(因而不在重算输入里),分母随之为 3。
  expect(report.standings.every((entry) => entry.countedMatches === 3)).toBe(true);
  expect(recomputeStandings(report)).toEqual(report.standings);
});

const emptyReport = (): SeasonReport => ({
  runId: "r",
  ruleset: "v1",
  masterSeed: "m",
  rankPoints: [3, 2, 1, 0],
  matches: [],
  standings: [],
  validationFailures: [],
  matchIssues: [],
});
