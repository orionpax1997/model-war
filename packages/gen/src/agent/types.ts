/**
 * loop 的注入缝与它的产出形状。
 *
 * ── 三个缝,三个负责方 ──
 *
 * | 缝 | 谁提供 | 本票做什么 |
 * |---|---|---|
 * | `ModelClient` | 既有端口(`model-client.ts`),真实实现 = HTTP 适配器 | 只调 `send`,不关心端点族 |
 * | `AgentExecutor` | 执行器(票 03 的 `sandbox.run`)后面挂宿主服务(票 04 的 dispatcher) | 只把「一块命令 + done 行号」交给它 |
 * | `EvaluateProbe` | 评测网格(票 06) | 本段只有类型与占位实现:loop **不直接调它**,它挂在宿主服务后面 |
 *
 * ── 为什么 `EvaluateProbe` 在 loop 的请求类型里,却不由 loop 调用 ──
 *
 * 一次 `evaluate` 是模型在 bash 块里叫人跑的,不是 loop 主动发起的(ADR-0030「没有提交动作,
 * `evaluate` 就是提交」)。所以把 probe 放在 `host` 上而不是放在 loop 的调用面上:loop 只把
 * `host.requestHandler` 递给执行器,真正回答 `evaluate` 请求的是宿主服务,它手里才有 probe。
 * 这样「谁执行」与「谁计数」都留在宿主侧,模型无论用循环还是子 shell 调用都只能打到薄壳。
 *
 * ── 步记录与终止原因直接复用 schema ──
 *
 * `ArchiveStep` / `ArchiveTermination` 的形状是票 01 定死的档案契约,loop 只负责填值。
 * 在这里重写一份同名类型,等于给同一个事实两个家。
 */

import type {
  ArchiveOptimizationCandidateAgent,
  ArchiveStep,
  ArchiveStepResult,
  ArchiveTermination,
} from "@model-war/schema";

import type { RequestHandler } from "./sandbox/index.js";

/** 会话的终止原因(ADR-0032):六个取值,与落档判据正交。 */
export type AgentTermination = ArchiveTermination;

/** 一步的过程记录条目,形状由票 01 的档案契约定死。 */
export type AgentStep = ArchiveStep;

/**
 * 一步的执行请求。
 *
 * `doneAtLine` 是**块内独占一行 `done`** 的行号(0 起),切分与停块归宿主侧(票 04):
 * 解析层只回答「有没有、在第几行」,执行层决定「跑哪一半」。
 */
export type AgentExecRequest = {
  /** 步号,1 起。 */
  readonly step: number;
  /** 整块原文,原样交给一次 `bash -c`。 */
  readonly command: string;
  readonly doneAtLine?: number;
  /** 宿主服务(fd 3)的端:给了就说明这一场会话有宿主;本段不接。 */
  readonly requestHandler?: RequestHandler;
};

/** 一步的执行结果。命令自己的非零退出不是异常;起不来才是(执行器 reject)。 */
export type AgentExecResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  /** 被单步墙钟杀掉(执行器自己的读数,只作记录)。 */
  readonly timedOut?: boolean;
  /** 这一步被块级 `done` 哨兵终止:`done` 之前的命令照常执行,之后的不执行。 */
  readonly done?: boolean;
  /** 结果侧证据(`tsc` / `contract` 与错误码);没有结果时缺席,不写空壳。 */
  readonly result?: ArchiveStepResult;
  /** 这一步里那次 `evaluate` 评出的候选(由宿主服务产出)。 */
  readonly candidate?: ArchiveOptimizationCandidateAgent;
};

/** 执行一步。 */
export type AgentExecutor = (request: AgentExecRequest) => Promise<AgentExecResult>;

/** 一次评测的结论。`failed` 是「跑了但没产出候选」,不是「沙箱坏了」。 */
export type EvaluateOutcome =
  | { readonly kind: "candidate"; readonly candidate: ArchiveOptimizationCandidateAgent }
  | { readonly kind: "failed"; readonly stderr: string };

/**
 * 评测探针:票 06 才接真实网格。本段只有类型与不接线的占位实现。
 *
 * ── 为什么它不叫 `TrialProbe` ──
 *
 * 那个名字在 `trial.ts` 里已经被 one-shot 形态的「试跑探针」占了(跑缩小的预算试跑)。两者是
 * 不同概念:那个是「这份脚本跑起来会不会飞」,这个是「这张网格上排第几」。共用一个名字会让
 * 接线时看不出自己在接哪一个,而 ADR-0030 已裁掉「冒烟试跑」那一档——所以这里按概念命名。
 */
export interface EvaluateProbe {
  evaluate(): Promise<EvaluateOutcome>;
}

/**
 * 宿主侧服务面。
 *
 * `requestHandler` 是票 03 的执行器与票 04 的 dispatcher 之间那条 fd 通道的宿主端;
 * `evaluate` 是 `evaluate` 请求背后的网格。两者一起交给 loop,是因为它们回答的是同一类问题
 * ——「沙箱里那条命令实际做了什么」——而 loop 对两者都不该有第二套认识。
 */
export type AgentToolHost = {
  readonly requestHandler: RequestHandler;
  readonly evaluate: EvaluateProbe;
};

/**
 * 一步的发送侧证据(轮号等于步号,ADR-0031/0035)。
 *
 * 生成日志行的完整形状归接线的票;本段只留「这一次调用几枪、被谁停的、多少钱」——
 * 那是 loop 唯一知道的东西,也是 `attempts` 归并(截断重试不占步)唯一能被观察到的地方。
 */
export type AgentTurnEvidence =
  | {
      readonly kind: "response";
      /** 轮号 = 步号(1 起)。 */
      readonly round: number;
      /** 这一步用了几次模型调用:第二次只可能是截断重试。 */
      readonly attempts: number;
      readonly finishReason: string;
      readonly usage: unknown;
      /** 这一步花在模型上的时间(覆盖全部 attempts,不含退避:退避归传输层)。 */
      readonly sendMs: number;
    }
  | {
      /**
       * 传输重试耗尽的那一次调用。
       *
       * 它**不进过程记录、不进协议轮数**(ADR-0031):轮号给的是「本来要成为第几步」,只为让
       * 生成日志那一行有位置可挂。
       */
      readonly kind: "transport";
      readonly round: number;
    };
