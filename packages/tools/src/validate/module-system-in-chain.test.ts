/**
 * 模块系统规则在**判定链与入口两层**上的对外行为(票 02 的一半验收面;另一半在
 * `rules/module-system.test.ts`)。断言对象只有两件:一段源码被接受还是被带诊断拒绝,
 * 以及一个入口以什么退出码结束、往 stdout 打印了什么——生成管线只读这两样。
 *
 * **为什么单独成文件**:判定链槽位顺序钉在 `pipeline.test.ts`、入口的参数与退出码钉在
 * `run-validate-script.test.ts`,那两处是本 feature 多张票共同的落点。本文件只放模块系统
 * 这一张票自己的两条链上用例,不去抢别人的位置(diff 冲突由 merger 解)。
 *
 * 进 `unit` project:它验的是本 feature 的交付物,不是仓库门禁(本工具不进 `check`),
 * 与 `run-validate-script.test.ts` 同一条理由。产物文件落在系统临时目录里,理由同那份文件。
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, expect, it } from "vitest";

import { validateScriptSource } from "../index.ts";

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const entry = here("./run-validate-script.ts");

const OPTS = { maxBytes: 1_000_000, phase: "freeze" } as const;

/** 五种形态的样本。`form` 是诊断文本里必须出现的那个形态名。 */
const FORMS: readonly { readonly case: string; readonly source: string; readonly form: string }[] =
  [
    { case: "静态 export", source: "export const a = 1;\n", form: "export" },
    { case: "静态 import", source: 'import { a } from "std";\n', form: "import" },
    { case: "动态 import()", source: 'const p = import("std");\n', form: "import()" },
    { case: "require", source: 'const r = require("std");\n', form: "require" },
    { case: "动态 eval", source: "eval(s);\n", form: "eval" },
  ];

const workDir = mkdtempSync(join(tmpdir(), "script-validator-02-"));
let counter = 0;

const artifact = (source: string): string => {
  counter += 1;
  const file = resolve(workDir, `artifact-${counter}.js`);
  writeFileSync(file, source, "utf8");
  return file;
};

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** 按契约的方式调入口:产物文件 + 必填的两个旋钮。 */
const run = (source: string): { readonly status: number; readonly stdout: string } => {
  const result = spawnSync(
    process.execPath,
    [entry, artifact(source), "--max-bytes", "100000", "--phase", "freeze"],
    { encoding: "utf8" },
  );
  if (result.error !== undefined) {
    throw result.error;
  }
  return { status: result.status ?? -1, stdout: result.stdout };
};

it("五种形态经判定链都判成模块系统违规,且一律拦截", () => {
  for (const { case: name, source } of FORMS) {
    const violations = validateScriptSource(source, OPTS);
    expect(
      violations.map((violation) => violation.rule),
      name,
    ).toEqual(["module-system"]);
    expect(
      violations.every((violation) => violation.blocking),
      name,
    ).toBe(true);
  }
});

it("五种形态经入口都被拦:退出码非零,诊断里点名那个形态", () => {
  for (const { case: name, source, form } of FORMS) {
    const outcome = run(source);
    expect(outcome.status, name).not.toBe(0);
    expect(outcome.stdout, name).toContain("模块系统");
    expect(outcome.stdout, name).toContain(form);
  }
});

it("干净产物仍然放行:模块系统这一级没有误伤", () => {
  const outcome = run("function loop() { return Math.floor(1); }\nloop();\n");
  expect(outcome.status).toBe(0);
  expect(outcome.stdout).toContain("脚本静态校验通过");
});

it("新增这一级不破坏全序稳定:混着禁列的违规按位置排,两次校验逐项相同", () => {
  const source = `function loop() {
  const a = Date.now();
  const b = import("std");
  const c = eval(s);
  return a + b + c;
}
`;
  const where = (): readonly string[] =>
    validateScriptSource(source, OPTS).map((violation) => `${violation.rule} @ ${violation.line}`);
  expect(where()).toEqual(["forbidden-global @ 2", "module-system @ 3", "module-system @ 4"]);
  expect(validateScriptSource(source, OPTS)).toEqual(validateScriptSource(source, OPTS));
});

it("解析失败独占结果:带 import 的残树不产出模块系统违规", () => {
  const violations = validateScriptSource('import { a } from "std";\nconst b = ;\n', OPTS);
  expect(violations.map((violation) => violation.rule)).toEqual(["syntax-error"]);
});

it("同类合并:五种形态落在同一个类别上,并成一行", () => {
  const source = FORMS.map(({ source: one }) => one).join("");
  const outcome = run(source);
  expect(outcome.status).toBe(1);
  const merged = outcome.stdout.split("\n").filter((line) => line.includes("模块系统"));
  expect(merged).toHaveLength(1);
  expect(merged[0]).toContain("5 处");
});
