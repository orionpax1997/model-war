import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import type { FailureRecord, ReplayEvent, ReplayLine } from "@model-war/schema";
import { ReplayReadError } from "@model-war/replay";
import type { RankPoints } from "./ranker.js";
import { rankSeason } from "./ranker.js";
import {
  renderNarrative,
  renderReportJson,
  renderReportMarkdown,
  selectRepresentativeMatches,
  summarizeNarrative,
  writeReportArtifacts,
  writeReportJson,
  type MatchIssue,
  type SeasonMatchReport,
  type SeasonReport,
} from "./reporter.js";
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

// ── 票 09:叙事 narrative/<对局>.md ──────────────────────────────────────────

const ROSTER = ["alpha", "beta", "gamma", "delta"] as const;

/** 一份四方 meta 行:座位 0..3 = alpha/beta/gamma/delta(座位 → 模型名的唯一映射源)。 */
const metaLine = (): ReplayLine => ({
  type: "meta",
  schemaVersion: 1,
  ruleset: "v1",
  timezoneOffset: "+00:00",
  mapHash: "0".repeat(16),
  seed: 7,
  players: ROSTER.map((model, seat) => ({
    model,
    archiveRef: `archive/${model}/r1`,
    seat: seat as 0 | 1 | 2 | 3,
  })),
  runner: "stub",
  quickjsWasiVersion: null,
  sandboxRuntimeHash: null,
  wasiClock: null,
  wasiRandomFill: null,
  wasiTimezoneOffset: null,
});

const tickLine = (tick: number, events: readonly ReplayEvent[]): ReplayLine => ({
  type: "tick",
  tick,
  players: [],
  units: [],
  sites: [],
  events,
  stateHash: "x",
});

it("renderNarrative 是 events 的纯函数:同集合同文本,反转 events 也不变", () => {
  const events: readonly ReplayEvent[] = [
    { kind: "victory", subjectId: 0 },
    { kind: "first-contact", subjectId: 3 },
    { kind: "unit-destroyed", subjectId: 9 },
  ];
  const forward = [metaLine(), tickLine(5, events)];
  const reversed = [metaLine(), tickLine(5, [...events].reverse())];
  expect(renderNarrative(forward)).toBe(renderNarrative(forward));
  expect(renderNarrative(reversed)).toBe(renderNarrative(forward));
});

it("renderNarrative 渲染七种事件,座位级事件映到模型名,单位 / 点位只给数值 id", () => {
  const events: readonly ReplayEvent[] = [
    { kind: "exception", subjectId: 1 },
    { kind: "first-contact", subjectId: 7 },
    { kind: "unit-destroyed", subjectId: 8 },
    { kind: "site-captured", subjectId: 5 },
    { kind: "economy-dead", subjectId: 2 },
    { kind: "player-eliminated", subjectId: 3 },
    { kind: "victory", subjectId: 0 },
  ];
  const md = renderNarrative([metaLine(), tickLine(20, events)]);
  expect(md).toContain("beta 异常出局");
  expect(md).toContain("首触 · 单位 #7");
  expect(md).toContain("单位 #8 阵亡");
  expect(md).toContain("点位 #5 易主");
  expect(md).toContain("gamma 经济死亡");
  expect(md).toContain("delta 出局");
  expect(md).toContain("alpha 获胜");
  // 抬头明说信息上限:只读 events 流、不回溯状态。
  expect(md).toContain("只读回放的 `events` 流");
  expect(md).toContain("不重解析 `units` / `sites`");
});

it("renderNarrative 对没有 events / 没有名册的 meta 也不崩", () => {
  const bare = { type: "meta", schemaVersion: 1, ruleset: "v1" } as unknown as ReplayLine;
  const md = renderNarrative([bare, tickLine(1, [])]);
  expect(md).toContain("- (本局无事件)");
});

it("summarizeNarrative 取前三条时间线并标注总数", () => {
  const events: readonly ReplayEvent[] = [
    { kind: "first-contact", subjectId: 1 },
    { kind: "unit-destroyed", subjectId: 2 },
    { kind: "victory", subjectId: 0 },
    { kind: "unit-destroyed", subjectId: 3 },
  ];
  const summary = summarizeNarrative(renderNarrative([metaLine(), tickLine(3, events)]));
  expect(summary).toContain("首触 · 单位 #1");
  expect(summary).toContain("共 4 条事件");
});

// ── 票 09:report.md ───────────────────────────────────────────────────────────

const matchReport = (
  matchId: string,
  rankings: readonly [number, number, number, number],
): SeasonMatchReport => ({
  matchId,
  inputPath: `runs/fixture/matches/${matchId}/input.json`,
  comboId: "c0",
  mapIndex: 0,
  seedIndex: Number(matchId.slice(-1)),
  map: "arena",
  seed: 100,
  seats: ["archive/alpha/r1", "archive/beta/r1", "archive/gamma/r1", "archive/delta/r1"],
  rankings,
  reason: "timeout",
  perMatchScores: [3, 2, 1, 0],
});

/** 四局、四模型各赢一局的名次表:好让代表性选择逐局取一。 */
const reportWithFourWinners = (): SeasonReport => ({
  ...emptyReport(),
  matches: [
    matchReport("c0-arena-s0", [1, 2, 3, 4]),
    matchReport("c0-arena-s1", [2, 1, 3, 4]),
    matchReport("c0-arena-s2", [3, 2, 1, 4]),
    matchReport("c0-arena-s3", [4, 2, 3, 1]),
  ],
  standings: ROSTER.map((model, index) => ({
    player: `archive/${model}/r1`,
    totalPoints: 4 - index,
    countedMatches: 4,
    averagePoints: (4 - index) / 4,
    rank: index + 1,
  })),
});

it("selectRepresentativeMatches 挑法确定:逐模型取其最好名次的一局,去重取前 limit 篇", () => {
  const report = reportWithFourWinners();
  expect(selectRepresentativeMatches(report)).toEqual([
    "c0-arena-s0",
    "c0-arena-s1",
    "c0-arena-s2",
  ]);
  expect(selectRepresentativeMatches(report)).toEqual(selectRepresentativeMatches(report));
});

const failureRecordFixture = (): FailureRecord => ({
  model: "alpha",
  modelVersion: "snapshot-1",
  generatedAt: "2026-01-01T00:00:00Z",
  runId: "gen-run-1",
  ruleset: "v1",
  classification: "tsc",
  protocolRounds: 5,
  prompts: ["prompt 1"],
  generationLog: ["log 1"],
  diagnostics: ["diag 1"],
  message: "编译没过",
});

const matchIssueFixture = (): MatchIssue => ({
  matchId: "c0-arena-s0",
  inputPath: "runs/fixture/matches/c0-arena-s0/input.json",
  comboId: "c0",
  mapIndex: 0,
  seedIndex: 0,
  map: "arena",
  seed: 100,
  reason: "engine-crash",
  exitCode: 2,
  rerunCount: 1,
  excludedFromRanking: true,
});

it("report.md 不含任何统计性 / 名次可信宣称,且两份失败分两节、各带来源指针", () => {
  const report: SeasonReport = {
    ...reportWithFourWinners(),
    validationFailures: [failureRecordFixture()],
    matchIssues: [matchIssueFixture()],
  };
  const md = renderReportMarkdown({
    report,
    representatives: [{ matchId: "c0-arena-s0", summary: "t1 · alpha 获胜" }],
  });

  for (const forbidden of ["统计显著", "显著", "置信区间", "可信", "p 值", "Elo"]) {
    expect(md, `报告不该出现统计性宣称:${forbidden}`).not.toContain(forbidden);
  }

  // 规则版本标注 + 排名表头 + 代表性叙事引用。
  expect(md).toContain("规则版本 `v1`");
  expect(md).toContain("| 名次 | 模型 | 赛季总分 | 有效局数 | 对局均分 |");
  expect(md).toContain("| 1 | alpha |");
  expect(md).toContain("[c0-arena-s0](narrative/c0-arena-s0.md)");

  // 两节分开、不合并:失败记录的指针落在校验失败节内,且在对局问题节之前。
  expect(md).toContain("## 校验失败名单");
  expect(md).toContain("## 对局问题清单");
  const failHeading = md.indexOf("## 校验失败名单");
  const failPointer = md.indexOf("`archive/alpha/failed-gen-run-1.json`");
  const issueHeading = md.indexOf("## 对局问题清单");
  expect(failHeading).toBeGreaterThanOrEqual(0);
  expect(failHeading).toBeLessThan(failPointer);
  expect(failPointer).toBeLessThan(issueHeading);
  // 对局问题条目带回输入路径指针。
  expect(md).toContain("> 来源:§8.4 执行期披露");
  expect(md).toContain("`runs/fixture/matches/c0-arena-s0/input.json`");
});

it("renderReportMarkdown 是纯函数:同输入恒同输出", () => {
  const input = { report: reportWithFourWinners(), representatives: [] };
  expect(renderReportMarkdown(input)).toBe(renderReportMarkdown(input));
});

// ── 票 09:落盘端到端(每局叙事 + report.md + 校验失败名单读盘) ──────────────

it("落盘端到端:每局都有 narrative/<对局>.md,report.md 引用它们并含两份名单", async () => {
  const { root, configPath } = buildSeasonRoot();
  // 放一条 gen 侧失败记录,验证报告会读出来并带来源指针。
  writeFileSync(
    join(root, "archive", "alpha", "failed-gen-run-1.json"),
    `${JSON.stringify(failureRecordFixture(), null, 2)}\n`,
  );
  const code = await scheduleSeason(
    { root, configPath },
    { spawnMatch: scriptedSpawn(() => 0).spawnMatch },
  );
  expect(code).toBe(0);

  const report = JSON.parse(
    readFileSync(join(root, "runs/fixture/report.json"), "utf8"),
  ) as SeasonReport;
  expect(report.validationFailures).toHaveLength(1);

  for (const match of report.matches) {
    const narrativePath = join(root, "runs/fixture/narrative", `${match.matchId}.md`);
    expect(existsSync(narrativePath), `${match.matchId} 缺叙事`).toBe(true);
    expect(readFileSync(narrativePath, "utf8")).toContain("只读回放的 `events` 流");
  }

  const reportMd = readFileSync(join(root, "runs/fixture/report.md"), "utf8");
  expect(reportMd).toContain("## 排名");
  expect(reportMd).toContain("## 校验失败名单");
  expect(reportMd).toContain("## 对局问题清单");
  expect(reportMd).toContain("`archive/alpha/failed-gen-run-1.json`");
  expect(reportMd).toContain("alpha");
  // report.md 只引用代表性几篇(不是全部),但仍指向 narrative/ 下的对局文件。
  expect(reportMd).toContain("narrative/");
  expect(reportMd).toMatch(/\[c0-arena-s\d\]\(narrative\/c0-arena-s\d\.md\)/);
});

// ── S2:每局都有叙事(含被剔除的失败局) ───────────────────────────────────────

it("S2:被剔除的失败局也有一篇 narrative(说明被排除),成功局叙事照旧齐全", async () => {
  const { root, configPath } = buildSeasonRoot();
  // s0 首发退 2、重跑仍退 2 → 该局剔除(桩不写回放,模拟崩溃局没有回放)。
  const code = await scheduleSeason(
    { root, configPath },
    { spawnMatch: scriptedSpawn((name) => (name === "c0-arena-s0" ? 2 : 0)).spawnMatch },
  );
  expect(code).toBe(0);

  const report = JSON.parse(
    readFileSync(join(root, "runs/fixture/report.json"), "utf8"),
  ) as SeasonReport;
  expect(report.matches).toHaveLength(3);
  expect(report.matchIssues).toHaveLength(1);

  // 被剔除的局也有叙事,内容说明「被排除」与原因,不静默缺文件。
  const excludedPath = join(root, "runs/fixture/narrative", "c0-arena-s0.md");
  expect(existsSync(excludedPath)).toBe(true);
  const excluded = readFileSync(excludedPath, "utf8");
  expect(excluded).toContain("已排除出排名");
  expect(excluded).toContain("引擎崩溃");

  // 每个成功局也都有叙事。
  for (const match of report.matches) {
    expect(existsSync(join(root, "runs/fixture/narrative", `${match.matchId}.md`))).toBe(true);
  }
});

// ── S3:reporter 经 @model-war/replay 的 parseReplay 读回放 ────────────────────

it("S3:reporter 读回放走 parseReplay——坏回放抛 ReplayReadError(而非就地实现的行读取)", () => {
  const outputDir = mkdtempSync(join(scratch, "bad-replay-"));
  const matchId = "c0-arena-s0";
  mkdirSync(join(outputDir, "matches", matchId), { recursive: true });
  writeFileSync(join(outputDir, "matches", matchId, "replay.jsonl"), "{ 这不是合法 JSON\n");
  const report: SeasonReport = { ...emptyReport(), matches: [matchReport(matchId, [1, 2, 3, 4])] };
  expect(() => writeReportArtifacts(outputDir, report)).toThrow(ReplayReadError);
});
