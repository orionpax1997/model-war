/**
 * `probe` 服务:把当前 `/workspace/script.ts` 拿去跑**完整计划的前 N 场**,回每一条预算轨的
 * 最坏占用读数——不是过/不过。
 *
 * ── 它解决的是哪一类失败(spec「第二个失败面」) ──
 *
 * `evaluate` 是二值的:**拦下**只说明"这份脚本跑不了",而为了得到这一句,一次真评测要跑
 * 74–79 s 并占掉三次配额里的**一次**。真档里 `minimax` 三把 `evaluate` 全花在同一件学不到新东西的
 * 事上(脚本打爆行动预算),三次 ≈ 284 s;而 `check`(tsc + 静态校验,~0.55 s)四次全绿、
 * 看不到任何运行期占用。所以模型手上缺的是一个**便宜且带信息量的自检**:21.6 s,回
 * "最坏那一 tick 用了 480/500(96%)"。
 *
 * ── 为什么它是"读数"而不是一个更便宜的判定 ──
 *
 * 前缀对真档四例预算触限的**漏检率是 2/4**:二值判定在一半情况下给的是假安心,而"你只用了
 * 24% / 你已贴边 96%"在任何结果下都成立。那四例的场号与来历只写在 `@model-war/schema` 的
 * `probe-limits.ts` 漏检率一段(本节不复述,免得两份分叉)。三档文案
 * (已越线 / 贴边 / 充裕)与那两句免责在 `apps/cli/src/trial/trial.ts` 的 `probeReportOf`。
 *
 * ── 它不占 `evaluate` 的额度,也不产出候选 ──
 *
 * 不写观测、不落候选快照、不碰 `evaluateCalls`。它有自己的计数器(`PROBE_CALL_LIMIT`,
 * 判据在 `dispatcher.ts`,计数发生在调用**之前**),否则一次探针就是一条免费无限循环的路。
 *
 * ── 三个拒绝都不白花模型的一次信息机会 ──
 *
 * 1. 没有 `/workspace/script.ts` → 不编译、不跑;
 * 2. 编译不过 → 不跑,回最前面的几条 tsc 诊断(先用 `check` 修掉);
 * 3. 子进程 infra(装载面坏了、网格起不来) → 抛出,由 dispatcher 折成一条 `isError` 结果,
 *    再往上一层的 pipeline 记 infra(候选不该为环境背账)。
 *
 * ── 计划从哪儿来:同一个惰性源 ──
 *
 * `deps.plan()` 与 `evaluate` 是**同一个闭包**(`pipeline.ts` 的 `planOf:` 只搬一次)。探针顺手
 * 把它取下来,于是"这张网格是什么"在**第一次 `evaluate` 之前**就被验证过一次:计划搬不出来时,
 * 模型在一次便宜的探针里就知道,而不是把一次 74 s 的评测赔进去。计划对象只用于取覆盖场数的
 * 上界,**不进子进程**(`--expected-plan` 那条比对是 `evaluate` 的判据,不是探针的)。
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROBE_MATCH_LIMIT, type ToolOutcome, type TrialPlan } from "@model-war/schema";

import { SCRIPT_SOURCE_NAME } from "../../archive.js";
import { compileScript, type CompileResult } from "../../compile.js";
import type { TrialProbeScript } from "../../trial.js";
import {
  CHECK_DIAGNOSTIC_LIMIT,
  tscDiagnostics,
  WORKSPACE_SCRIPT_PATH,
  type CompileFn,
} from "./check-service.js";

/** 一次 `probe` 的入参。**没有步号**:探针不落任何带名字的证据,不需要"第几步"来命名。 */
export type ProbeRequest = {
  /** 这一步 bind 成 `/workspace` 的宿主目录:服务读的就是它里面的 `script.ts`。 */
  readonly workspaceDir: string;
};

/** `createProbeService` 的依赖。 */
export type ProbeServiceDeps = {
  /** 安装根(仓库根)。 */
  readonly root: string;
  /** 正在被生成的模型 slug(探针入口要它:在位陪练 = 它自己最近一次冻结存档)。 */
  readonly model: string;
  /**
   * 本次会话那张网格的计划。**惰性**给,而且与 `evaluate` 是**同一份**(见文件头注):
   * 它只用来取"探针覆盖几场"的上界,不进子进程。
   */
  readonly plan: () => TrialPlan;
  /** 探针的执行缝:生产走 `runTrialProbeScript`(同一个试跑入口的 `--match-limit` 模式)。 */
  readonly probe: TrialProbeScript;
  readonly compile?: CompileFn;
  /** 编译失败时回多少条 tsc 诊断;缺省与 `check` 同档。 */
  readonly diagnosticLimit?: number;
};

/** 服务形态:给 dispatcher 调的那一个函数。 */
export type ProbeService = (request: ProbeRequest) => Promise<ToolOutcome>;

/**
 * 造一个 `probe` 服务。
 *
 * 计数器**不在这里**:「本会话已用几次」归 dispatcher(会话级状态,一次会话一份实例)。
 * 这里只负责"探这一次"——它也因此没有可被第二次调用影响的内部状态。
 */
export const createProbeService = (deps: ProbeServiceDeps): ProbeService => {
  const compile = deps.compile ?? compileScript;
  const limit = deps.diagnosticLimit ?? CHECK_DIAGNOSTIC_LIMIT;

  return async (request: ProbeRequest): Promise<ToolOutcome> => {
    let source: string;
    try {
      source = readFileSync(join(request.workspaceDir, SCRIPT_SOURCE_NAME), "utf8");
    } catch {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `probe:${WORKSPACE_SCRIPT_PATH} 不存在:先把脚本写到那里再探。\n`,
      };
    }

    const stagingDir = mkdtempSync(join(tmpdir(), "model-war-probe-"));
    try {
      const compiled: CompileResult = compile({ root: deps.root, stagingDir, source });
      if (!compiled.ok) {
        const entries = tscDiagnostics(compiled.diagnostics).slice(0, limit);
        return {
          exitCode: 1,
          stdout: "",
          stderr: ["probe:提交的脚本编译不过,这一次不探(先用 check 修掉):", ...entries].join("\n"),
        };
      }

      // 计划与 evaluate 同一个惰性源:探针先把它取一次(见文件头注《计划从哪儿来》)。
      const plan = deps.plan();
      const matchLimit = Math.min(PROBE_MATCH_LIMIT, plan.matches.length);
      const result = await deps.probe({
        root: deps.root,
        model: deps.model,
        artifactPath: compiled.jsPath,
        matchLimit,
      });

      // 退出码原样留着:0 = 前 N 场没越线,1 = 已越线。**都不是 `isError`**——它是一次
      // 被受理并跑完的工具调用,读数好坏是 `stdout` 里那段文案的事。
      return { exitCode: result.passed ? 0 : 1, stdout: result.stdout, stderr: "" };
    } finally {
      // 编译产物只在这一次调用里活着:探针不产出候选,没有要留下的产物字节。
      rmSync(stagingDir, { recursive: true, force: true });
    }
  };
};
