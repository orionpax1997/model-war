/**
 * 真沙箱里的**异常与退出码**诊断:每次未捕获异常都落盘、guest 自由文本不进 JSONL、预算轨的
 * `used/limit` 不去重、引擎故障退 2 而不是静默 0。
 *
 * 与 `cli-match.test.ts`(整场能跑完)分开住:这两组各自要跑 5 场真沙箱对局,vitest 的并行
 * 单位是文件,挤在一个文件里只能排队。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { MatchObservationLine, Ruleset } from "@model-war/schema";
import { validateObservationLine } from "./validator.js";
import { prepareCli, type CliHarness } from "./cli-harness.js";

let cli: CliHarness;

beforeAll(async () => {
  cli = await prepareCli();
});

afterAll(() => {
  cli.dispose();
});

it(
  "异常详情落盘：正式 match 保留每次异常且拒绝 guest 自由文本进入 JSONL",
  { timeout: 30_000 },
  () => {
    const inputPath = cli.writeMatchInput({
      script: `function loop() {
    const secret = "SECRET-DO-NOT-PERSIST-" + "x".repeat(100000) + "<script>\\n";
    switch (getMyIndex()) {
      case 0: throw new TypeError(secret);
      case 1: missingDiagnosticFunction(); break;
      case 2: throw { name: "TypeError", message: secret, stack: secret };
      default: const e = new Error(secret); e.name = secret; e.stack = secret; throw e;
    }
  }`,
    });
    const root = inputPath.slice(0, inputPath.indexOf("/runs/"));
    const matched = cli.run(["match", inputPath, "--root", root]);
    expect(matched.status, matched.stderr).toBe(0);
    const path = join(dirname(inputPath), "observations.jsonl");
    const text = readFileSync(path, "utf8");
    const lines = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as MatchObservationLine);
    expect(lines.every((line) => validateObservationLine(line).ok)).toBe(true);
    expect(lines).toEqual(
      [0, 1, 2].flatMap((tick) =>
        ["TypeError", "ReferenceError", "unknown", "unknown"].map((errorName, seat) => ({
          type: "exception",
          tick,
          seat,
          exceptionTickLimit: 3,
          diagnostic: { category: "uncaught-exception", errorName },
        })),
      ),
    );
    expect(text.length).toBeLessThan(2000);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("<script>");
    const replayPath = join(dirname(inputPath), "replay.jsonl");
    const originalReplay = readFileSync(replayPath, "utf8");
    const verified = cli.run(["verify", replayPath, "--root", root]);
    expect(verified.status, verified.stderr).toBe(0);
    expect(cli.run(["match", inputPath, "--root", root]).status).toBe(0);
    expect(readFileSync(replayPath, "utf8")).toBe(originalReplay);
  },
);

it.each([
  {
    script: "function loop() { while (true) {} }",
    patch: {},
    categories: ["event-budget"],
    counts: 3,
  },
  {
    script: "function loop() { getTick(); getTick(); }",
    patch: { apiCallTickLimit: 2 },
    categories: ["api-budget"],
    counts: 3,
  },
  {
    script: "function loop() {}",
    patch: { memoryTickCeiling: 1 },
    categories: ["memory-budget"],
    counts: 3,
  },
  {
    script: "function loop() { getTick(); getTick(); }",
    patch: { apiCallTickLimit: 2, memoryTickCeiling: 1 },
    categories: ["memory-budget", "api-budget"],
    counts: 4,
  },
])(
  "异常详情落盘：真实预算 $categories 保留 used/limit，双轨不去重",
  { timeout: 30_000 },
  ({ script, patch, categories, counts }) => {
    const inputPath = cli.writeMatchInput({ script });
    const root = inputPath.slice(0, inputPath.indexOf("/runs/"));
    const rulesetPath = join(root, "rulesets", "v2.json");
    const ruleset = { ...JSON.parse(readFileSync(rulesetPath, "utf8")), ...patch } as Ruleset;
    writeFileSync(rulesetPath, JSON.stringify(ruleset));
    const matched = cli.run(["match", inputPath, "--root", root]);
    expect(matched.status, matched.stderr).toBe(0);
    const records = readFileSync(join(dirname(inputPath), "observations.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as MatchObservationLine);
    const exceptions = records.filter((line) => line.type === "exception");
    expect(exceptions).toHaveLength(4 * counts);
    expect(exceptions.every((line) => validateObservationLine(line).ok)).toBe(true);
    expect(
      exceptions
        .filter((line) => line.tick === 0 && line.seat === 2)
        .map((line) => line.diagnostic.category),
    ).toEqual(categories);
    for (const line of exceptions) {
      expect(line.exceptionTickLimit).toBe(3);
      const diagnostic = line.diagnostic;
      if (diagnostic.category === "uncaught-exception") throw new Error("预期预算诊断");
      const limit =
        diagnostic.category === "event-budget"
          ? ruleset.eventTickLimit
          : diagnostic.category === "api-budget"
            ? ruleset.apiCallTickLimit
            : ruleset.memoryTickCeiling;
      expect(diagnostic.limit).toBe(limit);
      expect(diagnostic.used).toBeGreaterThanOrEqual(limit);
      if (diagnostic.category === "api-budget") expect(diagnostic.used).toBe(2);
    }
    const ticks = readFileSync(join(dirname(inputPath), "replay.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((line) => line.type === "tick");
    expect(
      ticks.at(-1).players.map((player: { exceptionTicks: number }) => player.exceptionTicks),
    ).toEqual([counts, counts, counts, counts]);
  },
);

it("`match` 遇到引擎故障(真沙箱宿主 RangeError)退 2,不静默 0", { timeout: 120_000 }, () => {
  // 深递归栈溢出实测为 host 侧 `RangeError: Maximum call stack size exceeded`
  // (`isJSException: false`,见 hld §5.0 第 2 行):它既不是 guest 可捕获异常、也不在判罚轨,
  // 而是引擎故障 → 退出码 2(stderr 另给一行 JSON)。
  const inputPath = cli.writeMatchInput({
    script: "function loop(){ return (function f(){ return f(); })(); }\n",
  });
  const root = inputPath.slice(0, inputPath.indexOf("/runs/"));
  const result = cli.run(["match", inputPath, "--root", root]);
  expect(result.status, result.stderr).toBe(2);
  expect(result.stderr).toContain("引擎故障");
});
