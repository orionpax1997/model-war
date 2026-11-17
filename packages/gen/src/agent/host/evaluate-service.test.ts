/**
 * `evaluate` 服务:本票只接**缝**与**拒绝语义**,不接真网格(那是票 06)。
 *
 * 要钉住的三件:
 * 1. 提交面——评的是**当前** `/workspace/script.ts` 那份字节(它的 sha256 与编译产物都交回);
 * 2. 观测出口——stdout 只给一行聚合 + 完整观测文件路径,明细由试跑写进 `/workspace/.observations/<n>.md`;
 * 3. 拒绝语义——没有脚本、或脚本编译不过,**不跑试跑**(一次信息机会不该被白花)。
 *
 * 候选快照的命名与落点归票 06,所以这里不断言任何 `observed-<runId>-…` 的路径。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Hex } from "../../archive.js";
import type { CompileFn } from "./check-service.js";
import { createEvaluateService } from "./evaluate-service.js";

const workspaces: string[] = [];

const workspace = (source?: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "model-war-evaluate-test-"));
  workspaces.push(dir);
  if (source !== undefined) writeFileSync(join(dir, "script.ts"), source, "utf8");
  return dir;
};

afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const compileOk: CompileFn = (options) => {
  const jsPath = join(options.stagingDir, "script.js");
  writeFileSync(jsPath, `// compiled from ${String(options.source.length)} 字节`, "utf8");
  return { ok: true, jsPath, diagnostics: "", tscVersion: "7.0.2" };
};

const compileFail: CompileFn = (options) => ({
  ok: false,
  jsPath: join(options.stagingDir, "script.js"),
  diagnostics: "script.ts(2,1): error TS1005: ';' expected.\nscript.ts(9,1): error TS2304: x.",
  tscVersion: "7.0.2",
});

/** 假试跑:记录入参、按观测文件路径落一份「明细」,回一行聚合。 */
const probe = (options: { readonly passed?: boolean; readonly stdout?: string } = {}) => {
  const calls: Array<{
    root: string;
    model: string;
    artifactPath: string;
    observationsPath: string;
  }> = [];
  const trial = (request: {
    readonly root: string;
    readonly model: string;
    readonly artifactPath: string;
    readonly observationsPath: string;
  }) => {
    calls.push({
      root: request.root,
      model: request.model,
      artifactPath: request.artifactPath,
      observationsPath: request.observationsPath,
    });
    // 试跑入口照观测路径整份重写(与 `runTrialScript` 的契约一致)。
    writeFileSync(request.observationsPath, "逐场一行\n", "utf8");
    expect(existsSync(request.artifactPath)).toBe(true);
    expect(readFileSync(request.artifactPath, "utf8")).toContain("// compiled");
    return {
      passed: options.passed ?? true,
      stdout: options.stdout ?? "对差 +1.25(首行是聚合,其余在观测文件)\n第二行细节",
    };
  };
  return { calls, trial };
};

describe("提交面:评的是当前 `/workspace/script.ts`", () => {
  it("交回源路径、字节的 sha256、编译产物与观测路径", async () => {
    const source = "export function onTick(): void {}\n";
    const dir = workspace(source);
    const { calls, trial } = probe();
    const service = createEvaluateService({ root: "/root", model: "m", trial, compile: compileOk });

    const outcome = await service({ workspaceDir: dir, call: 1 });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.submission).toBeDefined();
    expect(outcome.submission?.workspacePath).toBe("/workspace/script.ts");
    expect(outcome.submission?.hostPath).toBe(join(dir, "script.ts"));
    expect(outcome.submission?.scriptSha256).toBe(sha256Hex(Buffer.from(source, "utf8")));
    expect(outcome.submission?.observationsPath).toBe("/workspace/.observations/1.md");
    // 试跑拿到的是**这次**编译出来的产物,不是让试跑自己去工作区里找。
    expect(calls.length).toBe(1);
    expect(calls[0]?.model).toBe("m");
    expect(calls[0]?.root).toBe("/root");
  });

  it("观测目录由本服务建好,试跑按那份路径落盘", async () => {
    const dir = workspace("x\n");
    const { calls, trial } = probe();
    const service = createEvaluateService({ root: "/root", model: "m", trial, compile: compileOk });

    await service({ workspaceDir: dir, call: 2 });

    const written = calls[0]?.observationsPath ?? "";
    expect(written).toBe(join(dir, ".observations", "2.md"));
    expect(readFileSync(written, "utf8")).toBe("逐场一行\n");
  });
});

describe("观测出口:一行聚合 + 完整观测路径", () => {
  it("stdout 只有两行,第二行是模型能直接读的绝对路径", async () => {
    const dir = workspace("x\n");
    const { trial } = probe();
    const service = createEvaluateService({ root: "/root", model: "m", trial, compile: compileOk });

    const outcome = await service({ workspaceDir: dir, call: 1 });
    expect(outcome.stdout.split("\n").filter((line) => line !== "")).toEqual([
      "evaluate:通过 · 对差 +1.25(首行是聚合,其余在观测文件)",
      "完整观测:/workspace/.observations/1.md",
    ]);
    expect(outcome.stderr).toBe("");
  });

  it("试跑没过时退出码非零,判定从「通过」变「拦下」", async () => {
    const dir = workspace("x\n");
    const { trial } = probe({ passed: false, stdout: "超出预算:tick 上限\n细节" });
    const service = createEvaluateService({ root: "/root", model: "m", trial, compile: compileOk });

    const outcome = await service({ workspaceDir: dir, call: 1 });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toContain("evaluate:拦下 · 超出预算:tick 上限");
  });
});

describe("拒绝语义:不白花一次信息机会", () => {
  it("没有 `/workspace/script.ts` 时不跑试跑", async () => {
    const dir = workspace();
    const { calls, trial } = probe();
    const service = createEvaluateService({ root: "/root", model: "m", trial, compile: compileOk });

    const outcome = await service({ workspaceDir: dir, call: 1 });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("/workspace/script.ts 不存在");
    expect(outcome.submission).toBeUndefined();
    expect(calls.length).toBe(0);
  });

  it("编译不过时不跑试跑,并把最前面的诊断交回去(先修再提交)", async () => {
    const dir = workspace("x\n");
    const { calls, trial } = probe();
    const service = createEvaluateService({
      root: "/root",
      model: "m",
      trial,
      compile: compileFail,
    });

    const outcome = await service({ workspaceDir: dir, call: 1 });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("编译不过");
    expect(outcome.stderr).toContain("error TS1005");
    expect(outcome.submission).toBeUndefined();
    expect(calls.length).toBe(0);
    // 观测目录也不该被建出来:那会让「没评过」看起来像「评过」。
    expect(existsSync(join(dir, ".observations"))).toBe(false);
  });
});
