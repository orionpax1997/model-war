/**
 * 赛季端到端:`run` 跑通 fixture 赛季(真沙箱串行 4 局)、每局旁挂诊断、规则版本不一致的前置拒绝。
 *
 * 单独成文件:一局赛季是 4 场真沙箱对局,与 `cli-match.test.ts` 的单场断言不共享进程状态,
 * 分开住才能被 vitest 并行到不同 worker。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { prepareCli, type CliHarness } from "./cli-harness.js";

let cli: CliHarness;

beforeAll(async () => {
  cli = await prepareCli();
});

afterAll(() => {
  cli.dispose();
});

it(
  "`run` 跑通 fixture 赛季:退 0,report.json 落盘,每局 input.json 键集恰 5 项,目录命名确定",
  { timeout: 300_000 },
  () => {
    const { root } = cli.writeSeasonRoot();
    const result = cli.run(["run", "--config", "season.yaml", "--root", root]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("未实现");

    const report = JSON.parse(readFileSync(join(root, "runs/season/report.json"), "utf8")) as {
      matches: readonly { inputPath: string; rankings: readonly number[]; reason: string }[];
    };
    // 1 组合 × 1 图 × 4 种子,目录名 `<comboId>-<map>-s<seedIndex>` 确定。
    expect(report.matches.map((match) => match.inputPath)).toEqual([
      "runs/season/matches/c0-open-clash-s0/input.json",
      "runs/season/matches/c0-open-clash-s1/input.json",
      "runs/season/matches/c0-open-clash-s2/input.json",
      "runs/season/matches/c0-open-clash-s3/input.json",
    ]);
    for (const match of report.matches) {
      expect(match.rankings).toHaveLength(4);
      const input = JSON.parse(readFileSync(join(root, match.inputPath), "utf8")) as Record<
        string,
        unknown
      >;
      // 键集恰为对局输入的五项——多一个赛季字段即失败。
      expect(Object.keys(input)).toEqual(["archives", "map", "mapSha256", "seed", "ruleset"]);
    }
  },
);

it("异常详情落盘：正式赛季每局旁挂完整诊断，保持合法结果与名次", { timeout: 30_000 }, () => {
  const { root } = cli.writeSeasonRoot({
    script: 'function loop() { throw new TypeError("SECRET"); }',
  });
  const result = cli.run(["run", "--config", "season.yaml", "--root", root]);
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(readFileSync(join(root, "runs/season/report.json"), "utf8"));
  expect(report.matches).toHaveLength(4);
  for (const match of report.matches) {
    expect(match.rankings).toEqual([1, 1, 1, 1]);
    expect(match.reason).toBe("all-eliminated");
    const sidecar = readFileSync(
      join(dirname(join(root, match.inputPath)), "observations.jsonl"),
      "utf8",
    );
    const lines = sidecar
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toEqual(
      [0, 1, 2].flatMap((tick) =>
        [0, 1, 2, 3].map((seat) => ({
          type: "exception",
          tick,
          seat,
          exceptionTickLimit: 3,
          diagnostic: { category: "uncaught-exception", errorName: "TypeError" },
        })),
      ),
    );
    expect(sidecar).not.toContain("SECRET");
  }
});

it("`run` 规则版本不一致(存档 meta.ruleset ≠ 赛季 ruleset)→ 退 1,不物化任何对局", () => {
  const { root } = cli.writeSeasonRoot({ ruleset: "v1" });
  const result = cli.run(["run", "--config", "season.yaml", "--root", root]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("规则版本");
  // 前置拒绝在任何物化/子进程之前:赛季产物目录都不该出现。
  expect(existsSync(join(root, "runs/season"))).toBe(false);
});
