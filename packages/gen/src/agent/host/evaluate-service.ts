/**
 * `evaluate` 服务:宿主侧的**提交 + 试跑**,经薄壳通道交给沙箱里的模型。
 *
 * ── `evaluate` 就是提交(ADR-0030) ──
 * 模型写文件、叫 `evaluate`,宿主读**当前** `/workspace/script.ts` 送去跑整张网格;成绩取
 * **最后一次** `evaluate` 评的那个版本。所以本服务的第一步是把「当前这份文件」定下来:
 * 记它的 sha256,并把编译产物交给试跑入口——而不是让试跑自己去 `/workspace` 里找。
 *
 * ── 本票只接缝,不接真网格 ──
 * 真网格(计划搬运、32 场、聚合对差表、逐场明细)→ 票 06;**候选快照的命名与落点也归票 06**。
 * 这里做的三件事是它到时候要用到的那个形状:
 *
 * 1. **提交面**:`submission` 交回「读的是哪个路径、字节的 sha256、编译产物在哪、观测写在哪」;
 * 2. **观测出口**:stdout 只给**一行**聚合与完整观测文件路径(`/workspace/.observations/<n>.md`),
 *    明细落文件由模型按需读(ADR-0030「观测外置,而不是压缩」);
 * 3. **拒绝语义**:没有 `/workspace/script.ts`、或者它编译不过,就**不跑试跑**并回一条非零退出码
 *    的观测——「提交一份编译不过的脚本」不该消耗一次信息机会。
 *
 * ── 编译产物落在宿主临时目录,调用返回即删 ──
 * 这是本票的临时形状,不是最终形状:票 06 要把这一步换成候选快照(沿用既有逐候选产物命名族
 * `observed-<runId>-round-<步号>.candidate.{ts,js}`),那时 `submission.artifactPath` 才会在
 * 返回之后仍然有效。所以在票 06 落地之前,**别把 `artifactPath` 带出这一次调用**。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolResponse } from "@model-war/schema";

import { SCRIPT_SOURCE_NAME, sha256Hex } from "../../archive.js";
import { compileScript, type CompileResult } from "../../compile.js";
import type { TrialProbe } from "../../trial.js";
import {
  CHECK_DIAGNOSTIC_LIMIT,
  tscDiagnostics,
  WORKSPACE_SCRIPT_PATH,
  type CompileFn,
} from "./check-service.js";

/** 观测目录(工作区里的名字)。逐次评测一份,`<n>` = 第几次评测。 */
export const OBSERVATIONS_DIR_NAME = ".observations";

/** 观测目录在沙箱里的绝对路径。 */
export const OBSERVATIONS_DIR_PATH = `/workspace/${OBSERVATIONS_DIR_NAME}`;

/** 一次提交的身份:票 06 拿它去落候选快照,本票只用它把「评的是哪份字节」说清。 */
export type EvaluateSubmission = {
  /** 沙箱视角的源路径(恒为 `/workspace/script.ts`)。 */
  readonly workspacePath: string;
  /** 宿主视角的源路径(本服务读到的那一份)。 */
  readonly hostPath: string;
  /** 源字节的 sha256。 */
  readonly scriptSha256: string;
  /** 编译产物(宿主临时目录里那份;**返回即删**,见头注)。 */
  readonly artifactPath: string;
  /** 完整观测文件(沙箱视角)。 */
  readonly observationsPath: string;
};

/** 一次 `evaluate` 的结论:协议响应 + 提交身份。 */
export type EvaluateOutcome = ToolResponse & { readonly submission?: EvaluateSubmission };

/** 一次 `evaluate` 的入参。`call` 是第几次评测(1 起,由 dispatcher 的计数器给)。 */
export type EvaluateRequest = {
  readonly workspaceDir: string;
  readonly call: number;
};

/** 服务形态:给 dispatcher 调的那一个函数。 */
export type EvaluateService = (request: EvaluateRequest) => Promise<EvaluateOutcome>;

/** `createEvaluateService` 的依赖。 */
export type EvaluateServiceDeps = {
  /** 安装根(仓库根)。 */
  readonly root: string;
  /** 正在被生成的模型 slug(试跑入口要它:在位陪练 = 它自己最近一次冻结存档)。 */
  readonly model: string;
  /** 试跑探针:生产走 `runTrialScript`,测试与 gate 注入假实现(**本票不接真网格**)。 */
  readonly trial: TrialProbe;
  readonly compile?: CompileFn;
  /** 失败观测里给多少条 tsc 诊断;缺省与 `check` 同档。 */
  readonly diagnosticLimit?: number;
};

/** 只取第一行:stdout 要的是「一行聚合」,明细归观测文件。 */
const firstLine = (text: string): string => {
  const line = text
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  return line ?? "";
};

/**
 * 造一个 `evaluate` 服务。
 *
 * 计数器**不在这里**:「本会话已用几次」是会话级状态,归 dispatcher(它是每个会话一份的
 * 实例)。本服务只负责「评这一次」,把第几次作为入参收下,用它给观测文件起名。
 */
export const createEvaluateService = (deps: EvaluateServiceDeps): EvaluateService => {
  const compile = deps.compile ?? compileScript;
  const limit = deps.diagnosticLimit ?? CHECK_DIAGNOSTIC_LIMIT;

  return async (request: EvaluateRequest): Promise<EvaluateOutcome> => {
    const hostPath = join(request.workspaceDir, SCRIPT_SOURCE_NAME);
    let source: string;
    try {
      source = readFileSync(hostPath, "utf8");
    } catch {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `evaluate:${WORKSPACE_SCRIPT_PATH} 不存在:先把脚本写到那里再提交。\n`,
      };
    }

    const stagingDir = mkdtempSync(join(tmpdir(), "model-war-evaluate-"));
    try {
      const compiled: CompileResult = compile({
        root: deps.root,
        stagingDir,
        source,
      });
      if (!compiled.ok) {
        const entries = tscDiagnostics(compiled.diagnostics).slice(0, limit);
        return {
          exitCode: 1,
          stdout: "",
          stderr: ["evaluate:提交的脚本编译不过,这一次不评(先用 check 修掉):", ...entries].join(
            "\n",
          ),
        };
      }

      const observationsName = `${String(request.call)}.md`;
      const observationsHostPath = join(
        request.workspaceDir,
        OBSERVATIONS_DIR_NAME,
        observationsName,
      );
      mkdirSync(join(request.workspaceDir, OBSERVATIONS_DIR_NAME), { recursive: true });
      const observationsPath = `${OBSERVATIONS_DIR_PATH}/${observationsName}`;

      const result = deps.trial({
        root: deps.root,
        model: deps.model,
        artifactPath: compiled.jsPath,
        observationsPath: observationsHostPath,
      });

      const aggregate = firstLine(result.stdout);
      const verdict = result.passed ? "通过" : "拦下";
      return {
        exitCode: result.passed ? 0 : 1,
        stdout:
          `evaluate:${verdict}${aggregate === "" ? "" : ` · ${aggregate}`}\n` +
          `完整观测:${observationsPath}\n`,
        stderr: "",
        submission: {
          workspacePath: WORKSPACE_SCRIPT_PATH,
          hostPath,
          scriptSha256: sha256Hex(Buffer.from(source, "utf8")),
          artifactPath: compiled.jsPath,
          observationsPath,
        },
      };
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
    }
  };
};
