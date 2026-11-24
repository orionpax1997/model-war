/**
 * 观测边界里**唯一一条会改变记录内容**的规则:嵌套的测试运行不继承观测器。
 *
 * 为什么值得一条用例:`related-probe.test.ts` 在一个用例里 spawn `vitest related …`,而那次
 * 运行会把**整套测试**再跑一递。观测器一旦被递进去,里面那批测试的读盘就全记到外层那个用例
 * 头上——实测过一次:map 里出现「探针测试读了 651 个文件」,于是改任意源码都会选中探针自身
 * (25s),而那条边本来不存在。归错档比不记更坏,所以这条边界不能只写在注释里。
 *
 * 测法:起两个**临时子进程**,它们只把 `MODELWAR_*` 与 `NODE_OPTIONS` 打回来。一个叫
 * `vitest/vitest.mjs`(命中嵌套执行体),一个叫 `child.mjs`(普通子进程,CLI 产物的替身)。
 * 断言两者拿到的 env 不同:普通子进程**必须**拿到观测变量(否则 CLI 里的读盘会静默漏掉),
 * 嵌套那个**必须**一个都没有。
 *
 * 观测器只在 `MODELWAR_TEST_INPUTS_FILE` 存在时安装,而常跑链上它通常不存在,所以这里自己
 * 建一个临时落点、设好环境变量再调 `installRecorder()`——否则这条用例测的是一片没装补丁的
 * `child_process`。vitest 默认按文件隔离进程,这些全局补丁不会漏到别的测试文件。
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { installRecorder } from "./recorder.ts";

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface ChildEnv {
  readonly inputs: string | null;
  readonly repoRoot: string | null;
  readonly testId: string | null;
  readonly nodeOptions: string | null;
}

const openSandbox = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "model-war-recorder-"));
  dirs.push(dir);
  return dir;
};

/** 子进程做的事只有一个:把自己的 env 打回来。 */
const DUMP = `process.stdout.write(JSON.stringify({
  inputs: process.env.MODELWAR_TEST_INPUTS_FILE ?? null,
  repoRoot: process.env.MODELWAR_REPO_ROOT ?? null,
  testId: process.env.MODELWAR_TEST_ID ?? null,
  nodeOptions: process.env.NODE_OPTIONS ?? null,
}));`;

const writeScript = (path: string, body = DUMP): string => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  return path;
};

/** 在**已装探测补丁**的进程里 spawn 一个脚本,返回子进程看到的 env。 */
const spawnAndReadEnv = (script: string, repoRoot: string): ChildEnv => {
  const result = spawnSync(process.execPath, [script], { encoding: "utf8", cwd: repoRoot });
  expect(result.status, `子进程没跑起来:${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as ChildEnv;
};

describe("观测器不该被递进嵌套的测试运行", () => {
  it("普通子进程照旧继承观测变量(打好的 CLI 产物的读盘要能记到)", () => {
    const root = openSandbox();
    const sink = join(root, "inputs.jsonl");
    process.env["MODELWAR_TEST_INPUTS_FILE"] = sink;
    process.env["MODELWAR_REPO_ROOT"] = root;
    process.env["MODELWAR_TEST_ID"] = `${root}/fake.test.ts::某个用例`;
    expect(installRecorder(), "观测器没装上,这条用例什么也没测").toBe(true);

    const env = spawnAndReadEnv(writeScript(join(root, "child.mjs")), root);
    expect(env.inputs).toBe(sink);
    expect(env.repoRoot).toBe(root);
    expect(env.testId).toContain("fake.test.ts::某个用例");
    expect(env.nodeOptions ?? "").toContain("--import=");

    // 副作用留痕:子进程自身的 spawn 也进了 map(spawn 是输入之一)。
    expect(readFileSync(sink, "utf8")).toContain("child.mjs");
  });

  it("嵌套的 `vitest.mjs` 一个观测变量都不继承(它跑的是同一批测试,归错档比不记更坏)", () => {
    const root = openSandbox();
    const sink = join(root, "inputs.jsonl");
    process.env["MODELWAR_TEST_INPUTS_FILE"] = sink;
    process.env["MODELWAR_REPO_ROOT"] = root;
    process.env["MODELWAR_TEST_ID"] = `${root}/fake.test.ts::某个用例`;
    expect(installRecorder()).toBe(true);

    // 与真实路径同形:`node_modules/vitest/vitest.mjs`。
    const nested = writeScript(join(root, "node_modules", "vitest", "vitest.mjs"));
    const env = spawnAndReadEnv(nested, root);
    expect(env.inputs).toBeNull();
    expect(env.repoRoot).toBeNull();
    expect(env.testId).toBeNull();
    expect(env.nodeOptions ?? "").not.toContain("--import=");
  });
});
