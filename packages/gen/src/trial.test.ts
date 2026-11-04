/**
 * 试跑子进程封装：退出码 + stdout，与 `validate.ts` 调校验器同形。
 *
 * 不起真入口：临时根里放一个假可执行入口（小段 Node 脚本），断言退出码映射
 *（0 过 / 1 拦 / 其它大声失败）与参数转发（`<产物> --root <根> --model <slug>
 * --observations <路径> [--expected-plan <文件>]`）。
 * 真入口的行为
 * 由手工冒烟与 `gen-cli` e2e 覆盖——这里只钉封装这一层。
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, it } from "vitest";

import { prepareTrialPlan, runTrialScript } from "./trial.js";
import { gridPlanFixture } from "./trial-plan.fixture.js";

const scratch = mkdtempSync(`${tmpdir()}/modelwar-gen-trial-`);
afterAll(() => rmSync(scratch, { force: true, recursive: true }));

/** 观测文件路径在这层只是「调用方给的一个路径」；真路径由 `observations.ts` 造。 */
const OBS_PATH = join(scratch, "observed-fake.jsonl");
/** 模型 slug：在位陪练随它而定，所以造计划与跑试跑都要转发它。 */
const MODEL = "alpha";

/** 在临时根里放一个假试跑入口：`body` 是 Node 脚本正文，返回它的调用约定所需路径。 */
const fakeRoot = (body: string): { readonly root: string; readonly artifact: string } => {
  const root = mkdtempSync(`${scratch}/root-`);
  mkdirSync(join(root, "apps", "cli", "dist", "trial"), { recursive: true });
  writeFileSync(join(root, "apps", "cli", "dist", "trial", "run-trial-script.js"), body, "utf8");
  const artifact = join(root, "candidate.js");
  writeFileSync(artifact, "function loop() {}\n", "utf8");
  return { root, artifact };
};

it("退出 0 → 通过，stdout 原样交回（调用方在通过时忽略它）", () => {
  const { root, artifact } = fakeRoot(
    'process.stdout.write("试跑通过：3 场无预算超限。\\n");\nprocess.exitCode = 0;\n',
  );
  const result = runTrialScript({
    root,
    model: MODEL,
    artifactPath: artifact,
    observationsPath: OBS_PATH,
  });
  expect(result.passed).toBe(true);
  expect(result.stdout).toBe("试跑通过：3 场无预算超限。\n");
});

it("退出 1 → 拦下，stdout 逐字交回（回喂文本，不加前后缀）", () => {
  const feedback = "试跑未通过：第 1 场第 0 tick 触发预算超限。\n";
  const { root, artifact } = fakeRoot(
    `process.stdout.write(${JSON.stringify(feedback)});\nprocess.exitCode = 1;\n`,
  );
  const result = runTrialScript({
    root,
    model: MODEL,
    artifactPath: artifact,
    observationsPath: OBS_PATH,
  });
  expect(result.passed).toBe(false);
  // 严格相等：回喂的是子进程 stdout 逐字，不是 includes。
  expect(result.stdout).toBe(feedback);
});

it("退出 2（infra）→ 大声失败，不回喂（抛错，不交回结论）", () => {
  const { root, artifact } = fakeRoot(
    'process.stderr.write("试跑装载失败：读不到候选产物\\n");\nprocess.exitCode = 2;\n',
  );
  expect(() =>
    runTrialScript({ root, model: MODEL, artifactPath: artifact, observationsPath: OBS_PATH }),
  ).toThrow(/2/);
});

it("参数转发：入口收到的位置参数、--root、--observations 与调用方给的一致", () => {
  const marker = join(scratch, `argv-${String(Date.now())}.json`);
  const { root, artifact } = fakeRoot(
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\n` +
      "process.exitCode = 0;\n",
  );
  // 观测路径逐字转发，不 resolve、不改写：入口把它当成 gen 指定的那一个落盘点。
  runTrialScript({
    root,
    model: MODEL,
    artifactPath: artifact,
    observationsPath: join(root, "archive", "alpha", "observed-r1.jsonl"),
  });
  expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual([
    artifact,
    "--root",
    root,
    "--model",
    MODEL,
    "--observations",
    join(root, "archive", "alpha", "observed-r1.jsonl"),
  ]);
});

it("观测路径由调用方给，不由封装自造（gen 那一侧才是路径的真源）", () => {
  // 封装自己拼路径 = 「路径有两个家」。这条断言盯住它只转发、不生成。
  const marker = join(scratch, `argv-obs-${String(Date.now())}.json`);
  const { root, artifact } = fakeRoot(
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\n` +
      "process.exitCode = 0;\n",
  );
  const observationsPath = join(scratch, "别处.jsonl");
  runTrialScript({ root, model: MODEL, artifactPath: artifact, observationsPath });
  const argv = JSON.parse(readFileSync(marker, "utf8")) as readonly string[];
  expect(argv[argv.length - 1]).toBe(observationsPath);
});

it("--plan 模式只转发 --plan --root --model 并把子进程打印的计划原样交回", () => {
  const { root } = fakeRoot(
    "process.stdout.write(JSON.stringify({ version: 1, planSha256: 'a'.repeat(64), argv: process.argv.slice(2) }));\n" +
      "process.exitCode = 0;\n",
  );
  const plan = prepareTrialPlan(root, MODEL) as unknown as {
    readonly version: number;
    readonly argv: readonly string[];
  };
  expect(plan.version).toBe(1);
  // gen 不猜参数顺序：入口契约是「--plan 在前，--root / --model 在后」。
  expect(plan.argv).toEqual(["--plan", "--root", root, "--model", MODEL]);
});

it("给了计划就转发 --expected-plan：临时计划文件在子进程读得到，跑完即删", () => {
  const seen = join(scratch, `expected-plan-${String(Date.now())}.json`);
  const report = join(scratch, `argv-plan-${String(Date.now())}.json`);
  const { root, artifact } = fakeRoot(
    `const fs = require("node:fs");\n` +
      `const argv = process.argv.slice(2);\n` +
      `const at = argv.indexOf("--expected-plan");\n` +
      `fs.copyFileSync(argv[at + 1], ${JSON.stringify(seen)});\n` +
      `fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify(argv));\n` +
      `process.exitCode = 0;\n`,
  );
  runTrialScript({
    root,
    model: MODEL,
    artifactPath: artifact,
    observationsPath: OBS_PATH,
    plan: gridPlanFixture(),
  });
  // 交回入口的是**同一份**计划（32 场、含 planSha256），不是摘要或路径字符串。
  const forwarded = JSON.parse(readFileSync(seen, "utf8")) as { readonly matches: unknown[] };
  expect(forwarded.matches).toHaveLength(32);
  const argv = JSON.parse(readFileSync(report, "utf8")) as readonly string[];
  const at = argv.indexOf("--expected-plan");
  expect(at).toBeGreaterThan(0);
  // 临时目录跑完即删：入口拿到的那条路径已经不存在。
  expect(() => readFileSync(argv[at + 1]!, "utf8")).toThrow();
});

it("--plan 模式失败：非 0 退出与坏 JSON 都大声失败，不交回半个计划", () => {
  const failed = fakeRoot(
    'process.stderr.write("试跑计划装载失败:读不到基准脚本\n");\nprocess.exitCode = 2;\n',
  );
  expect(() => prepareTrialPlan(failed.root, MODEL)).toThrow(/2/);
  const garbage = fakeRoot('process.stdout.write("not json");\nprocess.exitCode = 0;\n');
  expect(() => prepareTrialPlan(garbage.root, MODEL)).toThrow(/输出不完整/);
});
