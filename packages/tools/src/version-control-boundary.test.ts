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
  const result = spawnSync("git", ["check-ignore", "--no-index", "-q", "--", path], {
    cwd: repoRoot,
  });
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

it("参赛脚本的编译产物入库:脚本 tsconfig 的 outDir 落在 dist 之外", () => {
  // 两头一起断言:`.gitignore` 里那条 dist/ 是无锚点规则(命中任意层级),而 hld §7.4 要求
  // 编译产物入库。所以脚本 tsconfig 的 outDir 必须是一个 git 放行的目录名——
  // 名字取自 `tsconfig.scripts.json`,这里断言的是「它真的过得了 git check-ignore」。
  expect(isIgnored("script-products/probe.js")).toBe(false);
  // 反面:同一个产物换个目录名就入库不了。这条不是装饰,它是上面那条成立的原因。
  expect(isIgnored("dist/probe.js")).toBe(true);
});

it("沙箱 runtime bundle 产物入库:落点不在任何 dist/ 下", () => {
  // 回放 meta 那一栏 `sandboxRuntimeHash` 必须能被第三方凭存档复算,前提是产物是提交物——
  // 所以它的落点必须过得了 git check-ignore(与 script-products 同一条纪律,ADR 0007)。
  expect(isIgnored("packages/engine/sandbox-runtime/runtime.iife.js")).toBe(false);
  // 反面:同一份产物若落在 dist/ 下就被忽略,入库无从谈起。
  expect(isIgnored("packages/engine/sandbox-runtime/dist/runtime.iife.js")).toBe(true);
});

it("沙箱行为探针输出入库:落点不被忽略", () => {
  // 探针输出落盘的唯一理由是「可复核」:指得出某个读数出自哪次运行。若落点被 `.gitignore` 吞掉,
  // 它就又变成 spike 里那个「引用了输出、而输出无处可查」的缺口(票 10)。
  expect(isIgnored(".scratch/sandbox-executor/probe-output/probes.txt")).toBe(false);
  expect(
    isIgnored(".scratch/sandbox-executor/probe-output/probe-03-interrupt-granularity.txt"),
  ).toBe(false);
});
