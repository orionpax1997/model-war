/**
 * CLI 的**表面**行为:帮助文本、子命令登记、装载期拒跑、缺参/读不到的退出码。
 *
 * 不跑整场对局的那一批。真沙箱整场在 `cli-match.test.ts`,赛季在 `cli-season.test.ts`,
 * `verify` 复算在 `cli-verify.test.ts`——按主题分文件是为了让 vitest 的并行单位(文件)
 * 能吃满核:44 个同步用例挤在一个文件里只能排队。
 *
 * 断言对象是**打好的单文件产物**(`cli-harness.ts` 里打),不是 `src/index.ts` 里的内部函数
 * ——改了内部结构而让这些断言失效,就是坏断言。
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  COMMANDS,
  openMap,
  prepareCli,
  runInProcess,
  terrainWithOrbits,
  type CliHarness,
} from "./cli-harness.js";

let cli: CliHarness;

beforeAll(async () => {
  cli = await prepareCli();
});

afterAll(() => {
  cli.dispose();
});

it("帮助信息列出全部六条子命令", () => {
  const result = cli.run(["--help"]);
  expect(result.status).toBe(0);
  for (const command of COMMANDS) {
    expect(result.stdout).toContain(`modelwar ${command}`);
  }
});

it("未知子命令非零退出", () => {
  const result = cli.run(["not-a-command"]);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("未知子命令");
});

it("六条子命令都登记在册(帮助之外的入口也存在)", { timeout: 30_000 }, () => {
  for (const command of COMMANDS) {
    const result = cli.run([command, "--help"]);
    expect(result.status, `${command} --help 应当成功`).toBe(0);
    expect(result.stdout).toContain(`modelwar ${command}`);
  }
});

it("`gen` 不再是「未实现」:帮助里列出 --config / --root / --model", () => {
  // 用户故事 24。`commandHelpText` 不展开处理器私有选项,故三个串只能来自登记的 `usage`。
  const help = cli.run(["gen", "--help"]);
  expect(help.status).toBe(0);
  for (const option of [
    "--config",
    "--root",
    "--model",
    "--score-source-feedback",
    "--select-best-candidate",
  ]) {
    expect(help.stdout, `gen --help 应含 ${option}`).toContain(option);
  }
});

it("`gen` 缺 --config 时非零退出,不走「未实现」那条路径", () => {
  const result = cli.run(["gen"]);
  expect(result.status).not.toBe(0);
  expect(result.stderr).not.toContain("未实现");
  expect(result.stderr).toContain("--config");
});

it("`run` 不再是「未实现」:帮助里列出 --config", () => {
  const help = cli.run(["run", "--help"]);
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("--config");
});

it("`run` 缺 --config 时非零退出,不走「未实现」那条路径", () => {
  const result = cli.run(["run"]);
  expect(result.status).not.toBe(0);
  expect(result.stderr).not.toContain("未实现");
  expect(result.stderr).toContain("--config");
});

it("`map-lint` 不再走「未实现」那条路径", () => {
  const dir = cli.writePool([
    { name: "pool-a", orbitIndexes: [0] },
    { name: "pool-b", orbitIndexes: [1, 2] },
    { name: "pool-c", orbitIndexes: [3] },
  ]);
  const result = cli.run(["map-lint", dir]);
  expect(result.stderr).not.toContain("未实现");
  // 三张图合规(这里造的是同一套点位下的最小合规池),所以这一跑必须放行。
  expect(result.stdout).toContain("通过");
  expect(result.status).toBe(0);
});

it("`map-lint` 对不合法的地图池非零退出(退出码由处理器返回,不是 index.ts 给的)", () => {
  // 断言对象是退出码本身:`index.ts` 调完处理器无条件 `return 0`,处理器没有返回值通道,
  // 所以「非零退出」这条只能靠处理器把退出码一路返回到顶层。这里用一张改坏的图钉住它。
  const source = openMap();
  const rows = terrainWithOrbits(source, [0]);
  rows[0] = `${".".repeat(3)}#${".".repeat((rows[0]?.length ?? 0) - 4)}`;
  const dir = cli.writePool([
    { name: "pool-a", orbitIndexes: [0], terrain: rows },
    { name: "pool-b", orbitIndexes: [1, 2] },
    { name: "pool-c", orbitIndexes: [3] },
  ]);
  const result = cli.run(["map-lint", dir]);
  expect(result.status).not.toBe(0);
  expect(result.stdout).toContain("地形未四重旋转对称");
});

it("`map-lint` 拿到一个不存在的目录时非零退出", () => {
  // 「目录不存在」这一格:不给它一句明确的失败,调用方会把「没查」读成「通过」。
  const result = cli.run(["map-lint", join(cli.scratch, "no-such-pool")]);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("读不到目录");
});

it("`map-lint` 拿到一个空目录时判失败(而不是静默通过)", () => {
  const dir = join(cli.scratch, "pool-empty");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".gitkeep"), "");
  const result = cli.run(["map-lint", dir]);
  expect(result.status).not.toBe(0);
  expect(result.stdout).toContain("地图池里没有地图");
});

it("`replay` 不再走「未实现」那条路径:渲染器住在 replay 包(provider 登记的包)", () => {
  const path = cli.writeReplay([
    {
      type: "meta",
      schemaVersion: 1,
      ruleset: "v1",
      quickjsWasiVersion: null,
      sandboxRuntimeHash: null,
      wasiClock: null,
      wasiRandomFill: null,
      timezoneOffset: "+08:00",
      mapHash: "a".repeat(64),
      seed: 7,
      players: [{ model: "alpha", archiveRef: "archive/alpha/r1", seat: 0 }],
      runner: "stub",
    },
    {
      type: "tick",
      tick: 0,
      players: [],
      units: [],
      sites: [],
      events: [],
      stateHash: "c".repeat(64),
    },
  ]);
  const result = cli.run(["replay", path]);
  expect(result.stderr).not.toContain("未实现");
  expect(result.status).toBe(0);
  // 「runner 栏读不出来」的反例:这一条红,而后果是有人拿桩跑的读数当座位轮换的结论。
  expect(result.stdout).toContain("runner stub");
});

it("`replay` 读不到文件或缺参时按装载期拒跑退 1,不静默返回成功", () => {
  // 静默 0 的反例:这两条一起红——自动化流程把「没跑成」读成「跑通了」。
  expect(cli.run(["replay", join(cli.scratch, "no-such-replay.jsonl")]).status).toBe(1);
  expect(cli.run(["replay"]).status).toBe(1);
});

it("`--version` 报的版本与 apps/cli/package.json 一致", () => {
  // index.ts 里的 CLI_VERSION 是写死的(打包后不读盘),而"与 package.json 同步"这句
  // 光写在注释里没有任何东西在盯。这里把它变成断言:改了一边不改另一边,这条会红。
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const result = cli.run(["--version"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(`modelwar ${manifest.version} `);
});

it.each([
  "dropArchive",
  "scriptSha",
  "metaSha",
  "mapSha",
  "ruleset",
  // 存档 meta 记的沙箱 runtime hash 与本仓入库产物不符:拒跑,不静默换。
  "sandboxHash",
] as const)("`match` 装载期拒跑 %s 退 1,不静默 0", (tamper) => {
  const inputPath = cli.writeMatchInput({ tamper });
  const root = inputPath.slice(0, inputPath.indexOf("/runs/"));
  const result = cli.run(["match", inputPath, "--root", root]);
  expect(result.status, `${tamper} 应当按装载期拒跑退 1,stderr:\n${result.stderr}`).toBe(1);
});

it("`match` 缺参退 1,且处理器已登记(不再走「未实现」)", () => {
  const result = cli.run(["match"]);
  expect(result.status).toBe(1);
  // 「处理器住在 CLI 的 match 模块」不必再花一整场去证:`handler === undefined` 那条分支在
  // **调用处理器之前**就退 1(`apps/cli/src/index.ts`),所以任何一次真的走进去的调用都不会
  // 打印「未实现」——包括这一次缺参的。原先有单独一条跑满 600 tick 只为断言 stderr 不含它。
  expect(result.stderr).not.toContain("未实现");
});

it("`match` 读不到输入文件退 1", () => {
  expect(cli.run(["match", join(cli.scratch, "no-such-input.json")]).status).toBe(1);
});

it("report 只读归档，不触发对局，--model/--json 从唯一 CLI 输出生成报告", () => {
  const root = mkdtempSync(join(cli.scratch, "report-root-"));
  const slugDir = join(root, "archive", "alpha");
  mkdirSync(join(slugDir, "r1"), { recursive: true });
  writeFileSync(
    join(slugDir, "r1", "meta.json"),
    JSON.stringify({
      model: "alpha",
      protocolRounds: 1,
      generationLog: [
        JSON.stringify({ round: 1, sendMs: 15, usage: { prompt_tokens: 7, completion_tokens: 3 } }),
      ],
    }),
  );
  writeFileSync(
    join(slugDir, "observed-r1.jsonl"),
    `${JSON.stringify({ matchIndex: 0, delivered: 0, captures: 0, noScoreSource: true })}\n`,
  );
  const before = readFileSync(join(slugDir, "r1", "meta.json"), "utf8");
  const result = cli.run(["report", "--root", root, "--model", "alpha", "--json"]);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject([
    {
      model: "alpha",
      protocolRounds: 1,
      totals: { sendMs: { value: 15 }, input: { value: 7 }, output: { value: 3 } },
      observations: { observedMatches: 1, noScoreSource: 1 },
    },
  ]);
  expect(readFileSync(join(slugDir, "r1", "meta.json"), "utf8")).toBe(before);
  expect(existsSync(join(root, "runs"))).toBe(false);
  const help = cli.run(["report", "--help"]);
  expect(help.status).toBe(0);
  for (const option of ["--root", "--model", "--json"]) expect(help.stdout).toContain(option);
});

/**
 * 同进程与真进程的**表面输出**必须一致(ADR-0038 第一条)。
 *
 * 这条断言的存在理由是它自己的失败模式:入口拆成「可 import 的 `main` + 薄壳」之后,两条路径
 * 可能悄悄分叉——薄壳里多写一行 stdout、`main` 里依赖了只在进程里成立的全局状态。分叉不会让
 * 任何既有断言变红,只会让「同进程那一批用例」验的东西与「真跑一遍」验的东西逐渐不是一回事。
 */
it("同进程调用与真进程产物的表面输出一致", async () => {
  for (const args of [["--version"], ["--help"]] as const) {
    const spawned = cli.run([...args]);
    const inProcess = await runInProcess([...args]);
    expect(inProcess.status, `同进程 \`${args.join(" ")}\` 的退出码`).toBe(spawned.status);
    expect(inProcess.stdout, `同进程 \`${args.join(" ")}\` 的 stdout`).toBe(spawned.stdout);
    expect(inProcess.stderr, `同进程 \`${args.join(" ")}\` 的 stderr`).toBe(spawned.stderr);
  }
});
