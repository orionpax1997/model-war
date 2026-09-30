import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vitest";

/**
 * 命令行的外部可观察行为只有两件:帮助信息列出哪几条子命令,以及未实现的子命令怎么退。
 *
 * 断言对象是**打好的单文件产物**,不是 `src/index.ts` 里的内部函数——改了内部结构而
 * 让这些断言失效,就是坏断言(见 spec《Testing Decisions》)。所以这里跑真实的 bundle。
 */

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const entry = fileURLToPath(new URL("./index.ts", import.meta.url));

const COMMANDS = ["gen", "run", "match", "replay", "verify", "map-lint"] as const;

let bundle = "";
let scratch = "";

const run = (args: readonly string[]) =>
  spawnSync(process.execPath, [bundle, ...args], { cwd: repoRoot, encoding: "utf8" });

beforeAll(async () => {
  // 各包的 exports 指向 dist/,先让类型闸门把 dist 备齐。增量构建是空操作(实测 ~0.1s)。
  const typecheck = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../../../node_modules/typescript/bin/tsc", import.meta.url)),
      "-b",
      "--pretty",
      "false",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  expect(typecheck.status, `tsc -b 失败:\n${typecheck.stdout}${typecheck.stderr}`).toBe(0);

  scratch = mkdtempSync(`${tmpdir()}/modelwar-cli-`);
  bundle = `${scratch}/modelwar.mjs`;
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    outfile: bundle,
  });
});

afterAll(() => {
  rmSync(scratch, { force: true, recursive: true });
});

it("帮助信息列出全部六条子命令", () => {
  const result = run(["--help"]);
  expect(result.status).toBe(0);
  for (const command of COMMANDS) {
    expect(result.stdout).toContain(`modelwar ${command}`);
  }
});

it("未知子命令非零退出", () => {
  const result = run(["not-a-command"]);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("未知子命令");
});

it("六条子命令都登记在册(帮助之外的入口也存在)", () => {
  for (const command of COMMANDS) {
    const result = run([command, "--help"]);
    expect(result.status, `${command} --help 应当成功`).toBe(0);
    expect(result.stdout).toContain(`modelwar ${command}`);
  }
});

it.each(COMMANDS)("未实现的 %s 显式失败,不静默返回成功", (command) => {
  const result = run([command]);
  expect(result.status).not.toBe(0);
  // 退出码非零还不够:必须是"未实现"这条路径,而不是别处的崩溃。
  expect(result.stderr).toContain("未实现");
});
