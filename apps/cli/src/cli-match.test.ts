/**
 * 真沙箱里的**整场对局**:`match` 跑满 600 tick 写回放、真实基准脚本当执行体、`--root` 的
 * 解析顺序。
 *
 * 这批用例每一例都要起一个真 bwrap 沙箱跑完整场(4–8s),是本仓最贵的一组进程级断言。
 * 与 `cli.test.ts`(表面)、`cli-season.test.ts`(赛季)、`cli-verify.test.ts`(复算)、
 * `cli-observation.test.ts`(异常与退出码)分开住,是为了让 vitest 按文件并行——vitest 的
 * 并行单位是文件,挤在一个文件里的用例只能排队。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { prepareCli, sandboxRuntimeHash, type CliHarness } from "./cli-harness.js";

let cli: CliHarness;

beforeAll(async () => {
  cli = await prepareCli();
});

afterAll(() => {
  cli.dispose();
});

it(
  "`match` 跑完一整场到超时,退出 0,回放落盘且能被 `replay` 渲染(真沙箱)",
  { timeout: 120_000 },
  () => {
    const inputPath = cli.writeMatchInput();
    const runDir = join(inputPath, "..");
    const root = inputPath.slice(0, inputPath.indexOf("/runs/"));
    const result = cli.run(["match", inputPath, "--root", root]);
    // 「规则内结果一律 0」:超时是**合法结果**,不是失败。
    expect(result.status, result.stderr).toBe(0);
    const replayPath = join(runDir, "replay.jsonl");
    const lines = readFileSync(replayPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0].type).toBe("meta");
    // 真沙箱:runner 是 quickjs,五个沙箱栏都是真值(不是 null)。
    expect(lines[0].runner).toBe("quickjs");
    expect(lines[0].sandboxRuntimeHash).toBe(sandboxRuntimeHash);
    expect(lines[0].quickjsWasiVersion).toBeTruthy();
    expect(lines[0].wasiClock).toBeTruthy();
    expect(lines[0].wasiRandomFill).toBeTruthy();
    expect(lines[0].wasiTimezoneOffset).toBeTruthy();
    expect(lines.at(-1).type).toBe("result");
    // 600 tick + meta + result。
    expect(lines).toHaveLength(602);
    // 回放能渲染:第二条命令看得到画面。
    const shown = cli.run(["replay", replayPath]);
    expect(shown.status).toBe(0);
    expect(shown.stdout).toContain("runner quickjs");
  },
);

/**
 * `--root` 写在位置参数**前面**也要解析成选项。
 *
 * 反例:把参数摘取写成 `args.filter((arg) => !arg.startsWith("-"))`,`--root` 的**值**
 * 不以 `-` 开头,于是它被当成位置参数、`positional[0]` 成了根目录——一个目录被拿去
 * `JSON.parse`。用法串把 `<input.json>` 写在前面只是惯例,参数顺序不该决定命令能不能跑。
 *
 * 断言**报错指名的是哪个对象**:故意给一个不存在的输入文件。报错点 `no-such-input.json`
 * = `--root` 被吃成选项、位置参数仍是那个文件;报错点临时根 = 顺序一错就换了对象。
 * 「整场能跑完」由本文件其它用例证,不必再用一场 600 tick 重复买一次(那要 8s)。
 */
it("`match` 的 `--root` 写在 <input.json> 前面也能解析成选项", () => {
  const missing = join(cli.scratch, "no-such-input.json");
  const result = cli.run(["match", "--root", cli.scratch, missing]);
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain("no-such-input.json");
});
