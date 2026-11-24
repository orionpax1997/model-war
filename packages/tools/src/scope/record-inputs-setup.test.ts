/**
 * 观测器的**归属**判据:模块加载期的读盘也要有"哪个测试文件"这一档。
 *
 * 为什么这条值得一个用例:`test-inputs/inputs.json` 曾经**根本不含**
 * `packages/engine/src/sandbox.test.ts` 与 `packages/engine/src/runner/quickjs.test.ts`——它们
 * 在模块顶层读 `rulesets/v1.json` 与 `fixtures/guest/*.js`,而那些读盘发生在任何 hook 之前。
 * 旧写法把文件级标签贴在 `beforeAll` 里,于是那批记录没有归属、被 `record()` 丢掉。后果不是
 * 报错,是**少跑**:改 `rulesets/v1.json` 时,引擎里真正读它的那两个测试不会被选中。
 *
 * 测法:把 env 备好,再动态 `import()` 真正的 setup 文件(带查询串绕开模块缓存)。它执行的是
 * 与录制时**同一段代码**,于是能断言两件事而不必起子进程:
 *
 * 1. 标签在 setup 的**模块作用域**就写好了,且是**文件**级(不带 `::`);
 * 2. 此后发生的读盘(绝对路径,与模块顶层读盘的形态一致)就落在那个文件名下。
 *
 * 用例级仍然覆盖它:`beforeEach` 会把标签细化成 `路径::用例名`,聚合按 `::` 前半段归并。
 * 这条也断言在下面(用的是同一份 setup 的 `beforeEach` 实现——直接改 env 模拟不了它,所以
 * 这里只断言**归并**不丢文件:`aggregate` 把两级标签收到同一个键下)。
 *
 * 注意:这条用例会给本进程装上观测器(和录制时一样),因此它自己写一个临时落点。
 * vitest 默认按文件隔离进程,补丁不会漏到别的测试文件。
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { aggregate } from "./test-inputs.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const setupPath = join(repoRoot, "vitest.record-inputs.setup.ts");
const thisFile = fileURLToPath(import.meta.url);

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Record {
  readonly t: string;
  readonly k: string;
  readonly p: string;
}

const recordsOf = (sink: string): readonly Record[] =>
  readFileSync(sink, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record);

describe("观测归属:模块加载期的读盘也落在文件名下", () => {
  it("setup 的模块作用域就贴好文件级标签,且此后读盘归属到它", async () => {
    const dir = mkdtempSync(join(tmpdir(), "model-war-record-setup-"));
    dirs.push(dir);
    const sink = join(dir, "inputs.jsonl");

    const saved = {
      inputs: process.env["MODELWAR_TEST_INPUTS_FILE"],
      root: process.env["MODELWAR_REPO_ROOT"],
      id: process.env["MODELWAR_TEST_ID"],
    };
    process.env["MODELWAR_TEST_INPUTS_FILE"] = sink;
    process.env["MODELWAR_REPO_ROOT"] = repoRoot;
    // 先抹掉标签:真正被验的是"setup 自己会把它写上",而不是这里替它写。
    delete process.env["MODELWAR_TEST_ID"];
    try {
      // 查询串绕开模块缓存:同一个进程里要真的执行一遍那段顶层代码。
      await import(`${pathToFileURL(setupPath).href}?record-setup-probe`);

      // 1. 文件级(不带 `::`):用例级标签要等 `beforeEach`,而模块加载期的读盘等不到那里。
      expect(process.env["MODELWAR_TEST_ID"]).toBe(thisFile);

      // 2. 模拟模块顶层那次读盘:绝对路径,与 `sandbox.test.ts` 的读法同形。
      readFileSync(join(repoRoot, "package.json"), "utf8");

      const record = recordsOf(sink).find((line) => line.p === "package.json");
      expect(
        record,
        "这次读盘没有留下记录:观测器没装上,或用例测的是一片没装补丁的 fs",
      ).toBeDefined();
      expect(record?.k).toBe("open");
      // 归属是**本文件**,不是一个空标签、也不是别的文件。
      expect(record?.t).toBe(thisFile);
    } finally {
      if (saved.inputs === undefined) delete process.env["MODELWAR_TEST_INPUTS_FILE"];
      else process.env["MODELWAR_TEST_INPUTS_FILE"] = saved.inputs;
      if (saved.root === undefined) delete process.env["MODELWAR_REPO_ROOT"];
      else process.env["MODELWAR_REPO_ROOT"] = saved.root;
      if (saved.id === undefined) delete process.env["MODELWAR_TEST_ID"];
      else process.env["MODELWAR_TEST_ID"] = saved.id;
    }
  });

  it("两级标签归并到同一个键(用例级的细粒度不分裂文件级归属)", () => {
    const jsonl = [
      JSON.stringify({
        t: join(repoRoot, "packages/engine/src/sandbox.test.ts"),
        k: "open",
        p: "rulesets/v1.json",
      }),
      JSON.stringify({
        t: `${join(repoRoot, "packages/engine/src/sandbox.test.ts")}::真 VM 跑一局`,
        k: "open",
        p: "maps/open-clash.json",
      }),
    ].join("\n");
    const map = aggregate(jsonl, repoRoot, "fingerprint");
    expect(Object.keys(map.files)).toEqual(["packages/engine/src/sandbox.test.ts"]);
    expect(map.files["packages/engine/src/sandbox.test.ts"]).toEqual([
      "maps/open-clash.json",
      "rulesets/v1.json",
    ]);
  });
});
