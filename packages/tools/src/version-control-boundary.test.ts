import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * 该路径是否被 .gitignore 命中。
 *
 * `--no-index`:断言的是忽略规则本身,而不是当前索引里的状态——否则一个已被跟踪的
 * 占位符会永远"看起来没被忽略",这条断言就测不到规则了。
 * 退出码 0 = 命中,1 = 未命中;其它退出码一律当作错误抛出,不静默折算成"未命中"。
 */
const isIgnored = (path: string): boolean => {
  const result = spawnSync("git", ["check-ignore", "--no-index", "-q", "--", path], { cwd: repoRoot });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status === 0) {
    return true;
  }
  if (result.status === 1) {
    return false;
  }
  throw new Error(`git check-ignore 意外退出码 ${result.status}: ${String(result.stderr)}`);
};

it("冻结脚本入库:archive/ 下的产物不被忽略", () => {
  expect(isIgnored("archive/.gitkeep")).toBe(false);
  expect(isIgnored("archive/openai/gpt-x/run-0001/script.ts")).toBe(false);
  expect(isIgnored("archive/openai/gpt-x/run-0001/script.js")).toBe(false);
  expect(isIgnored("archive/openai/gpt-x/run-0001/meta.json")).toBe(false);
});

it("对局运行产物不入库:runs/ 下的内容被忽略", () => {
  expect(isIgnored("runs/2026-09-30/replay.jsonl")).toBe(true);
  expect(isIgnored("runs/2026-09-30/result.json")).toBe(true);
  expect(isIgnored("runs/2026-09-30/report.md")).toBe(true);
  expect(isIgnored("runs/2026-09-30/matches/combo1-map-a-7/input.json")).toBe(true);
  expect(isIgnored("runs/2026-09-30/logs/engine.log")).toBe(true);
});

it("runs/ 的占位符自身不被忽略", () => {
  expect(isIgnored("runs/.gitkeep")).toBe(false);
});

it("构建产物与 tsbuildinfo 不入库", () => {
  expect(isIgnored("packages/engine/dist/index.js")).toBe(true);
  expect(isIgnored("packages/engine/tsconfig.tsbuildinfo")).toBe(true);
  expect(isIgnored("node_modules/.bin/tsc")).toBe(true);
});
