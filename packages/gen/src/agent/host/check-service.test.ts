/**
 * `check` 服务:截断、落盘与结果侧的小集合。
 *
 * 三条判据都从 ADR-0030 的「观测外置」来,所以每条都要有反面:
 * 1. stdout 只给**前 20 条 + 总数**,且那个总数是真的总数(不是被截断后的长度);
 * 2. 全文在 `/workspace/.check.txt`,**一条都不少**(否则「模型按需去读」读不到东西);
 * 3. `result` 是稳定的小集合(tsc 的 `TSxxxx` / 契约的规则标签),不是原文。
 *
 * 编译与静态校验都是注入的:这里要断的是本服务的行为,不是 tsc 会不会报错。真 tsc 那一次在
 * `verify:kernel` 的真 bwrap 路径上跑(薄壳 → fd → 真 tsc)。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CompileResult } from "../../compile.js";
import type { ValidateResult } from "../../validate.js";
import {
  CHECK_FULL_TEXT_NAME,
  contractRuleLabels,
  createCheckService,
  tscDiagnostics,
  tscErrorCodes,
  type CompileFn,
  type ValidateFn,
} from "./check-service.js";

const workspaces: string[] = [];

const workspace = (source?: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "model-war-check-test-"));
  workspaces.push(dir);
  if (source !== undefined) writeFileSync(join(dir, "script.ts"), source, "utf8");
  return dir;
};

afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const diagnosticsOf = (count: number): string =>
  [
    "script.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    ...Array.from(
      { length: count - 1 },
      (_, index) => `script.ts(${String(index + 2)},1): error TS1005: ';' expected.`,
    ),
  ].join("\n");

const compileOk =
  (diagnostics = ""): CompileFn =>
  (options) => {
    const jsPath = join(options.stagingDir, "script.js");
    writeFileSync(jsPath, "// compiled", "utf8");
    return { ok: true, jsPath, diagnostics, tscVersion: "7.0.2" } satisfies CompileResult;
  };

const compileFail =
  (diagnostics: string): CompileFn =>
  (options) => ({
    ok: false,
    jsPath: join(options.stagingDir, "script.js"),
    diagnostics,
    tscVersion: "7.0.2",
  });

const validateWith =
  (result: ValidateResult): ValidateFn =>
  () =>
    result;

describe("tsc 诊断:前 20 条 + 总数 + 全文", () => {
  it("25 条 → stdout 只给 20 条并报总数,全文 25 条都在 `.check.txt`", async () => {
    const dir = workspace("const x: number = 'nope';\n");
    const service = createCheckService({ root: "/root", compile: compileFail(diagnosticsOf(25)) });
    const response = await service({ workspaceDir: dir });

    expect(response.exitCode).toBe(1);
    expect(response.stderr).toBe("");
    expect(response.stdout).toContain("共 25 条");
    expect(response.stdout).toContain("这里给前 20 条");
    expect(response.stdout).toContain(`全文在 /workspace/${CHECK_FULL_TEXT_NAME}`);
    expect(response.stdout).toContain("(其余 5 条未列出");
    expect(response.stdout.split("\n").filter((line) => line.startsWith("script.ts(")).length).toBe(
      20,
    );
    // 类型检查没过就不进静态校验:说清这一点,别让模型以为是校验器没输出。
    expect(response.stdout).toContain("静态校验没有跑");

    const full = readFileSync(join(dir, CHECK_FULL_TEXT_NAME), "utf8");
    expect(full.split("\n").filter((line) => line.startsWith("script.ts(")).length).toBe(25);
    expect(full).toContain("# 类型检查(tsc 7.0.2)");
    expect(full).toContain("# 静态校验");
    expect(full).toContain("类型检查未通过,未进入静态校验");
  });

  it("结果侧只留去重、排序的 `TSxxxx`", async () => {
    const dir = workspace("x\n");
    const service = createCheckService({
      root: "/root",
      compile: compileFail(
        [
          "script.ts(1,1): error TS2322: a",
          "script.ts(2,1): error TS1005: b",
          "script.ts(3,1): error TS2322: c",
        ].join("\n"),
      ),
    });
    const response = await service({ workspaceDir: dir });
    expect(response.result).toEqual({ kind: "tsc", errorCodes: ["TS1005", "TS2322"] });
  });

  it("诊断条目只认带 TS 码的行(汇总行不算一条)", () => {
    const text = [
      "script.ts(1,1): error TS2322: a",
      "Found 1 error in script.ts:1",
      "",
      "script.ts(3,9): warning TS6133: 'x' is declared but never read.",
    ].join("\n");
    expect(tscDiagnostics(text).length).toBe(2);
    expect(tscErrorCodes(text)).toEqual(["TS2322", "TS6133"]);
  });
});

describe("静态校验:违规按类别合并后仍是「前若干条 + 总数」", () => {
  const violations = [
    "脚本静态校验未通过:4 处违规,按类别合并成 2 条。",
    "- [拦截] 禁列全局名 · 2 处 · 位置 3:1、4:1 · 不允许使用 Date",
    "- [拦截] 宿主桥前缀 · 2 处 · 位置 5:1、6:1 · 不允许使用 __host__",
  ].join("\n");

  it("stdout 带抬头与计数,`.check.txt` 是校验器的完整输出,`result` 是规则标签", async () => {
    const dir = workspace("x\n");
    const service = createCheckService({
      root: "/root",
      maxBytes: 32768,
      compile: compileOk(),
      validate: validateWith({ passed: false, stdout: `${violations}\n`, errors: [] }),
    });
    const response = await service({ workspaceDir: dir });

    expect(response.exitCode).toBe(1);
    expect(response.stdout).toContain("类型检查通过(tsc 7.0.2)。");
    expect(response.stdout).toContain("共 3 条");
    expect(response.stdout).toContain("- [拦截] 禁列全局名");
    expect(response.result).toEqual({
      kind: "contract",
      errorCodes: [...contractRuleLabels(violations.split("\n"))],
    });
    const full = readFileSync(join(dir, CHECK_FULL_TEXT_NAME), "utf8");
    expect(full).toContain(violations);
    expect(full).toContain("没有诊断。");
  });

  it("通过且没有违规:退出码 0,不产生 `result`", async () => {
    const dir = workspace("x\n");
    const headline = "脚本静态校验通过:没有违规。";
    const service = createCheckService({
      root: "/root",
      maxBytes: 32768,
      compile: compileOk(),
      validate: validateWith({ passed: true, stdout: `${headline}\n`, errors: [] }),
    });
    const response = await service({ workspaceDir: dir });
    expect(response.exitCode).toBe(0);
    expect(response.stdout).toContain(headline);
    expect(response.result).toBeUndefined();
  });

  it("只有提示(不拦截)时退出码仍是 0,但 `result` 留下那一类标签", async () => {
    const dir = workspace("x\n");
    const hint = [
      "脚本静态校验通过,但有 1 处提示(不拦截),按类别合并成 1 条。",
      "- [提示] 脚本体积 · 1 处 · 位置 无位置 · 脚本 40000 字节,超过 32768 的上限",
    ].join("\n");
    const service = createCheckService({
      root: "/root",
      maxBytes: 32768,
      compile: compileOk(),
      validate: validateWith({ passed: true, stdout: `${hint}\n`, errors: [] }),
    });
    const response = await service({ workspaceDir: dir });
    expect(response.exitCode).toBe(0);
    expect(response.result).toEqual({ kind: "contract", errorCodes: ["脚本体积"] });
  });

  it("违规行的标签抽取只认那一种形状", () => {
    expect(
      contractRuleLabels([
        "脚本静态校验未通过:2 处违规,按类别合并成 1 条。",
        "- [拦截] 模块系统 · 1 处 · 位置 1:1 · 不允许 import",
      ]),
    ).toEqual(["模块系统"]);
    expect(contractRuleLabels(["没有方括号的行"])).toEqual([]);
  });
});

describe("拒绝语义", () => {
  it("没有 `/workspace/script.ts` 就不编译,直接回一条非零退出码", async () => {
    const dir = workspace();
    let compiled = 0;
    const service = createCheckService({
      root: "/root",
      compile: (options) => {
        compiled += 1;
        return compileOk()(options);
      },
    });
    const response = await service({ workspaceDir: dir });
    expect(response.exitCode).toBe(1);
    expect(response.stderr).toContain("/workspace/script.ts 不存在");
    expect(response.stdout).toBe("");
    expect(compiled).toBe(0);
  });
});
