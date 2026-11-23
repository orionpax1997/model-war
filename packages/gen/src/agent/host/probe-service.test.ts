/**
 * `probe` 服务:读 `/workspace/script.ts` → 编译 → 跑完整计划的前 8 场 → 回三档文案。
 *
 * ── 这里钉的是服务的**契约**,不是网格 ──
 *
 * 真网格是 32 场真对局(实测约 90 秒),那是门禁/慢速测试的量级。执行器那一层由
 * `apps/cli/src/trial/grid.test.ts` 用缩小网格覆盖,三档文案由 `trial.test.ts` 覆盖;
 * 这里只钉服务自己那四条:**跑的是同一份计划的哪一段**、**计划对象有没有被动过**、
 * **两处拒绝不白花一次信息机会**、**产物不留痕**。
 *
 * ── 判据 5(计划不变)落在这一格 ──
 *
 * 计划由 `deps.plan()` 给——与 `evaluate` 是**同一个闭包**。探针只读它取覆盖场数的上界,
 * 一个字节都不改;`planSha256` 前后相等是那件事的读数面。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";
import { PROBE_MATCH_LIMIT, type TrialPlan } from "@model-war/schema";

import { gridPlanFixture } from "../../trial-plan.fixture.js";
import { createProbeService, type ProbeServiceDeps } from "./probe-service.js";
import type { CompileFn } from "./check-service.js";

const scratch: string[] = [];

const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SOURCE = "export function onTick(): void {}\n";

/** 一个工作区:`source` 缺席即「模型还没写 script.ts」。 */
const workspace = (source?: string): string => {
  const dir = tempDir("model-war-probe-test-");
  if (source !== undefined) writeFileSync(join(dir, "script.ts"), source, "utf8");
  return dir;
};

const compileOk: CompileFn = (options) => {
  const jsPath = join(options.stagingDir, "script.js");
  writeFileSync(jsPath, `// compiled from ${options.source}\n`, "utf8");
  return { ok: true, jsPath, diagnostics: "", tscVersion: "7.0.2" };
};

const compileFail: CompileFn = (options) => ({
  ok: false,
  jsPath: join(options.stagingDir, "script.js"),
  diagnostics: "script.ts(2,1): error TS1005: ';' expected.\nscript.ts(9,1): error TS2304: x.",
  tscVersion: "7.0.2",
});

const plan = gridPlanFixture();

/** 探针执行缝的桩:记下每次调用,回一段"充裕"档文案。 */
const recordingProbe = (calls: Array<{ artifactPath: string; matchLimit: number }>) => () => {
  return (request: { readonly artifactPath: string; readonly matchLimit: number }) => {
    calls.push({ artifactPath: request.artifactPath, matchLimit: request.matchLimit });
    return { passed: true, stdout: "probe：前 8 场跑完。最坏读数：事件 120/500（24%）。\n" };
  };
};

const depsOf = (overrides: Partial<ProbeServiceDeps> = {}): ProbeServiceDeps => {
  const calls: Array<{ artifactPath: string; matchLimit: number }> = [];
  return {
    root: tempDir("model-war-probe-root-"),
    model: "alpha",
    plan: () => plan,
    probe: recordingProbe(calls)(),
    compile: compileOk,
    ...overrides,
  };
};

it("跑的是**完整计划的前 8 场**:matchLimit 取 PROBE_MATCH_LIMIT,不是计划的全部场数", async () => {
  const calls: Array<{ artifactPath: string; matchLimit: number }> = [];
  const service = createProbeService(depsOf({ probe: recordingProbe(calls)() }));
  const outcome = await service({ workspaceDir: workspace(SOURCE) });
  expect(outcome.exitCode).toBe(0);
  expect(outcome.isError).toBeUndefined();
  expect(calls).toHaveLength(1);
  expect(calls[0]?.matchLimit).toBe(PROBE_MATCH_LIMIT);
  // 计划是 32 场,而探针只要 8 场:`min(PROBE_MATCH_LIMIT, matches.length)` 的两边都在验。
  expect(plan.matches.length).toBe(32);
});

it("判据 5（计划不变）：探针前后 `evaluate` 用的计划 `planSha256` 相等", async () => {
  // 同一个闭包(与 pipeline 的 `planOf:` 同形):探针跑完之后 evaluate 拿到的还是同一份对象。
  let built: TrialPlan | undefined;
  const planOf = (): TrialPlan => {
    built ??= gridPlanFixture();
    return built;
  };
  const service = createProbeService(depsOf({ plan: planOf, probe: recordingProbe([])() }));
  const before = planOf().planSha256;
  await service({ workspaceDir: workspace(SOURCE) });
  const after = planOf().planSha256;
  expect(after).toBe(before);
  // 而且探针没把计划换成一个裁剪过的:场数还是 32。
  expect(planOf().matches).toHaveLength(32);
});

it("计划比 8 场少时取计划场数(不越界、也不补场)", async () => {
  const shortPlan: TrialPlan = {
    ...plan,
    matches: plan.matches.slice(0, 3),
    matchesPerCandidate: 3,
  };
  const calls: Array<{ artifactPath: string; matchLimit: number }> = [];
  const service = createProbeService(
    depsOf({ plan: () => shortPlan, probe: recordingProbe(calls)() }),
  );
  await service({ workspaceDir: workspace(SOURCE) });
  expect(calls[0]?.matchLimit).toBe(3);
});

it("没有 `/workspace/script.ts` → 不编译、不跑,回一句可读的拒绝", async () => {
  const calls: Array<{ artifactPath: string; matchLimit: number }> = [];
  const service = createProbeService(depsOf({ probe: recordingProbe(calls)() }));
  const outcome = await service({ workspaceDir: workspace() });
  expect(outcome.exitCode).toBe(1);
  expect(outcome.stderr).toContain("/workspace/script.ts 不存在");
  expect(calls).toHaveLength(0);
});

it("编译不过 → 不跑,回最前面的几条 tsc 诊断(先用 check 修掉)", async () => {
  const calls: Array<{ artifactPath: string; matchLimit: number }> = [];
  const service = createProbeService(
    depsOf({ probe: recordingProbe(calls)(), compile: compileFail }),
  );
  const outcome = await service({ workspaceDir: workspace("x\n") });
  expect(outcome.exitCode).toBe(1);
  expect(outcome.stderr).toContain("编译不过");
  expect(outcome.stderr).toContain("error TS1005");
  expect(calls).toHaveLength(0);
});

it("越线(退出 1)不是 isError:它是一次跑完的工具调用,读数好坏在 stdout 里", async () => {
  const service = createProbeService(
    depsOf({
      probe: () => ({
        passed: false,
        stdout: "probe：前 8 场跑完。**已经越线**……\n",
      }),
    }),
  );
  const outcome = await service({ workspaceDir: workspace(SOURCE) });
  expect(outcome.exitCode).toBe(1);
  expect(outcome.isError).toBeUndefined();
  expect(outcome.stdout).toContain("已经越线");
});

it("编译产物不留痕:探针不产出候选,临时目录跑完即删", async () => {
  const seen: string[] = [];
  const service = createProbeService(
    depsOf({
      probe: (request) => {
        seen.push(request.artifactPath);
        // 跑的那一刻产物在盘上(与真入口一致)。
        expect(readFileSync(request.artifactPath, "utf8")).toContain("compiled from");
        return { passed: true, stdout: "probe：充裕。\n" };
      },
    }),
  );
  await service({ workspaceDir: workspace(SOURCE) });
  const artifact = seen[0];
  expect(artifact).toBeDefined();
  // 返回即删:再读同一路径是 ENOENT(探针没有"要留下的产物字节")。
  expect(() => readFileSync(artifact ?? "", "utf8")).toThrow(/ENOENT/u);
});

it("服务抛错不被吞掉(infra 由 dispatcher / pipeline 记,不在这里折成模型手滑)", async () => {
  const service = createProbeService(
    depsOf({
      probe: () => {
        throw new Error("装载面坏了");
      },
    }),
  );
  await expect(service({ workspaceDir: workspace(SOURCE) })).rejects.toThrow("装载面坏了");
});
