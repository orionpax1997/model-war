/**
 * loop 的注入缝与它的产出形状。
 *
 * ── 三个缝,三个负责方 ──
 *
 * | 缝 | 谁提供 | 本票做什么 |
 * |---|---|---|
 * | `ModelClient` | 既有端口(`model-client.ts`),真实实现 = HTTP 适配器 | 只调 `send`,不关心端点族 |
 * | `AgentExecutor` | 执行器(票 03 的 `sandbox.run`)后面挂宿主服务(票 04 的 dispatcher) | 只把整块原文交给它 |
 *
 * ── 为什么这里没有「评测探针」这个缝 ──
 *
 * 一次 `evaluate` 是模型在 bash 块里叫人跑的,不是 loop 主动发起的(ADR-0030「没有提交动作,
 * `evaluate` 就是提交」)。所以网格挂在**宿主服务**后面(`agent/host/evaluate-service.ts`),
 * loop 只从执行器的回包里搬运「这一步真评出成绩了」这个事实(`AgentExecResult.submission`)。
 * 给它另开一条 loop 侧的注入缝,等于给「谁执行 `evaluate`」造第二个答案。
 *
 * ── 步记录与终止原因直接复用 schema ──
 *
 * `ArchiveStep` / `ArchiveTermination` 的形状是票 01 定死的档案契约,loop 只负责填值。
 * 在这里重写一份同名类型,等于给同一个事实两个家。
 */

import type { ArchiveStep, ArchiveStepResult, ArchiveTermination } from "@model-war/schema";

import type { ToolCall } from "./tools.js";

/** 会话的终止原因(ADR-0032):六个取值,与落档判据正交。 */
export type AgentTermination = ArchiveTermination;

/** 一步的过程记录条目,形状由票 01 的档案契约定死。 */
export type AgentStep = ArchiveStep;

/**
 * 一步的执行请求:**这一次调用的工具名与参数原文**,加上 `bash` 的派生命令串。
 *
 * ── 为什么是工具调用,而不是一段命令串 ──
 *
 * 旧形状是 `{ step, command }`,非 `bash` 的工具把**工具名**塞进 `command` 那一格,指望沙箱里
 * 有同名薄壳认得它。那是过渡态(票 03 的边界):两个意思挤在一格,而「哪一个是命令、哪一个是
 * 工具调用」只能靠字符串猜。现在执行器拿到的就是解析后的动作:`call` 说「调了谁、参数原文是
 * 什么」,`command` 是 `bash` 那一步的派生值。
 *
 * 收工(`finish`)也一样走这条:它是执**行器**的事吗?不,它是宿主的事——执行器把非 `bash`
 * 的调用原样交给 `tools.dispatch`,自己只负责 `bash` 那一条路。
 */
export type AgentExecRequest = {
  /** 步号,1 起。 */
  readonly step: number;
  /** 这一步发起的**那一次**工具调用(名字 + `arguments` 原文,逐字不改写)。 */
  readonly call: ToolCall;
  /**
   * `bash` 那一步要跑的命令串:动作层从 `call.argumentsJson` 解析并校验过的**派生值**。
   * 其余四个工具没有这一格(它们做什么由 `/workspace/script.ts` 决定)。
   */
  readonly command?: string;
};

/** 一步的执行结果。命令自己的非零退出不是异常;起不来才是(执行器 reject)。 */
export type AgentExecResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  /** 被单步墙钟杀掉(执行器自己的读数,只作记录)。 */
  readonly timedOut?: boolean;
  /**
   * 这一步里宿主**收下了**一次收工请求(`finish` 工具被受理)。
   *
   * 字段名是 `done` 而工具叫 `finish`——**这是有意的不一致,不是漏改**:它与档案枚举
   * `action.kind: "done"`(`packages/schema/src/archive-meta.ts`)同源,该枚举是 v3 形状里的
   * 常量,改名等于升 `archiveSchemaVersion`(与 `identity.finish` 那处同源)。
   *
   * 判据是**宿主收下了那次调用**,不是「模型调了一个叫 finish 的东西」:被拒的 `finish`
   * (会话到点、参数误用)不算收工,这一点与旧世界的薄壳同理——那时的拒绝也不会置位。
   */
  readonly done?: boolean;
  /** 结果侧证据(`tsc` / `contract` 与错误码);没有结果时缺席,不写空壳。 */
  readonly result?: ArchiveStepResult;
  /**
   * 这一步里**真评出过成绩**的那次 `evaluate` 的提交身份。
   *
   * 它是宿主服务的事实,loop 只搬运(见 `pipeline.ts` 的「宿主侧的事实怎么回到步骤上」)。
   * 候选条目的 `step` 由 loop 填(步号),`score` 与 `matchCount` 由网格填(`pipeline.ts` 的评分接缝)。
   */
  readonly submission?: {
    readonly scriptSha256: string;
    readonly hostPath: string;
    readonly observationsPath: string;
    /** 编出这份产物的 tsc 版本：冻结时要写进 `meta.tscVersion`，所以随身份一起搬运。 */
    readonly tscVersion: string;
  };
  /** 这是第几次 `evaluate`(1 起,由 dispatcher 的计数器给)。 */
  readonly evaluateCall?: number;
  /**
   * 这一次**工具调用**本身失败(宿主拒绝 / 服务抛错),不是「命令跑了但非零退出」。
   *
   * 旧世界把两者混成一个伪造的退出码,读侧只能靠文案猜。这一位是从 `ToolOutcome` 原样搬过来
   * 的**唯一依据**:loop 用它守住「被拒的 `finish` 不是收工」那条判据。
   */
  readonly isError?: boolean;
};

/** 执行一步。 */
export type AgentExecutor = (request: AgentExecRequest) => Promise<AgentExecResult>;

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
      /** 死之前用了几枪(1 = 一次就死;2 = 第一枪被截断、第二枪死在连接上)。 */
      readonly attempts: number;
    };
