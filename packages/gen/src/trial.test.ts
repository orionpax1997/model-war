/**
 * 试跑子进程封装：退出码 + stdout，与 `validate.ts` 调校验器同形。
 *
 * 不起真入口：临时根里放一个假可执行入口（小段 Node 脚本），断言退出码映射
 *（0 过 / 1 拦 / 其它大声失败）与参数转发（`<产物> --root <根> --observations <路径>`）。
 * 真入口的行为
 * 由手工冒烟与 `gen-cli` e2e 覆盖——这里只钉封装这一层。
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, it } from "vitest";

import { runTrialScript } from "./trial.js";

const scratch = mkdtempSync(`${tmpdir()}/modelwar-gen-trial-`);
afterAll(() => rmSync(scratch, { force: true, recursive: true }));

/** 观测文件路径在这层只是「调用方给的一个路径」；真路径由 `observations.ts` 造。 */
const OBS_PATH = join(scratch, "observed-fake.jsonl");

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
  const result = runTrialScript({ root, artifactPath: artifact, observationsPath: OBS_PATH });
  expect(result.passed).toBe(true);
  expect(result.stdout).toBe("试跑通过：3 场无预算超限。\n");
});

it("退出 1 → 拦下，stdout 逐字交回（回喂文本，不加前后缀）", () => {
  const feedback = "试跑未通过：第 1 场第 0 tick 触发预算超限。\n";
  const { root, artifact } = fakeRoot(
    `process.stdout.write(${JSON.stringify(feedback)});\nprocess.exitCode = 1;\n`,
  );
  const result = runTrialScript({ root, artifactPath: artifact, observationsPath: OBS_PATH });
  expect(result.passed).toBe(false);
  // 严格相等：回喂的是子进程 stdout 逐字，不是 includes。
  expect(result.stdout).toBe(feedback);
});

it("退出 2（infra）→ 大声失败，不回喂（抛错，不交回结论）", () => {
  const { root, artifact } = fakeRoot(
    'process.stderr.write("试跑装载失败：读不到候选产物\\n");\nprocess.exitCode = 2;\n',
  );
  expect(() =>
    runTrialScript({ root, artifactPath: artifact, observationsPath: OBS_PATH }),
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
    artifactPath: artifact,
    observationsPath: join(root, "archive", "alpha", "observed-r1.jsonl"),
  });
  expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual([
    artifact,
    "--root",
    root,
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
  runTrialScript({ root, artifactPath: artifact, observationsPath });
  const argv = JSON.parse(readFileSync(marker, "utf8")) as readonly string[];
  expect(argv[argv.length - 1]).toBe(observationsPath);
});
