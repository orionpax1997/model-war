/**
 * 宿主侧的 **dispatcher**:薄壳通道的应答端,也是配额与会话墙钟的唯一判据源。
 *
 * ── 它只做三件判定(ADR-0033「薄壳走 fd,宿主是唯一的判据源」) ──
 * 1. 工具名在**白名单**里(`check` / `evaluate` / `done`);
 * 2. `evaluate` 的**调用次数**未超会话上限(默认 `EVALUATE_CALL_LIMIT` = 3);
 * 3. 会话**墙钟**未到点。
 *
 * 三条任一不成立,就回一份**伪造的 stderr + 非零退出码**且**真执行函数一次都不调**。模型无论用
 * 循环、管道还是子 shell 调用薄壳,都只能打到这一层:它碰不到计数器,也碰不到 deadline。
 *
 * ── 为什么「不信请求里的任何字段」 ──
 * 请求是模型可构造的(它能把任意字节写进 fd 3)。所以配额只按**调用次数**计,请求里的 `args`
 * 与任何多出来的键都**不解释**——`parseToolRequest` 只校验形状,额外键一律忽略。这条不是洁癖:
 * 「请求里带 `remaining=2` 就少扣一次」是一种只要存在一次就会被模型学会的旁路。
 *
 * ── 会话墙钟是宿主的判据,不是沙箱单步墙钟(ADR-0029) ──
 * 单步墙钟(`sandbox.run` 的 `wallClockMs`)防的是「这一步挂住」,它的语义是**杀进程**,不是
 * deadline。会话墙钟在这里:到点即拒,连执行都不开始——一个已经没时间跑 tsc 的会话,让 tsc
 * 跑起来再被杀掉,只会把「预算耗尽」写成一次莫名其妙的工具失败。
 *
 * ── 为什么是工厂函数而不是模块级状态 ──
 * `evaluate` 的「三次」是**会话级**的。写成模块级全局,第二个会话会继承第一个会话的计数,而且
 * 并发跑两场会话时计数互相吃。所以每次会话 `createSessionTools(...)` 一次,状态封在闭包里。
 *
 * ── 薄壳伪造不出响应 ──
 * 本模块**只写**响应、**只读**请求。沙箱那一侧往 fd 3 写一行「响应形状」的字节,到了这里就是
 * 一条形状不合的**请求**,得到一条非零退出码的拒绝;它不会被执行、不会被当成响应回灌给谁。
 * 这条性质由「管道的另一端只在宿主进程里」保住,不靠协议里的任何标记。
 */

import {
  EVALUATE_CALL_LIMIT,
  TOOL_NAMES,
  parseToolRequest,
  serializeToolResponse,
  type ToolResponse,
} from "@model-war/schema";

import type { CheckService } from "./check-service.js";
import type { EvaluateService } from "./evaluate-service.js";

/** 拒绝时用的退出码:与「命令跑了但失败」同档(模型看到的是一次失败的工具调用)。 */
export const REFUSAL_EXIT_CODE = 1;

/** 协议误用(不是一条工具请求)的退出码:与薄壳自己的「工具不可用」一致。 */
export const PROTOCOL_EXIT_CODE = 2;

/** 配额用完时的伪造 stderr。文案固定,便于断言与让模型知道「别再试了」。 */
export const QUOTA_EXHAUSTED_MESSAGE = `evaluate: 工具不可用:本会话的评测额度已用完(${String(EVALUATE_CALL_LIMIT)}/${String(EVALUATE_CALL_LIMIT)} 次)。`;

/** 会话墙钟到点时的伪造 stderr 前缀(后面跟工具名)。 */
export const SESSION_EXPIRED_MESSAGE = "工具不可用:会话墙钟已到点,这一次不执行。";

/** 白名单之外的工具名。 */
export const UNKNOWN_TOOL_MESSAGE = `工具不可用:不在受限工具白名单里(${TOOL_NAMES.join(" / ")})。`;

/** dispatcher 的依赖:两个服务 + 会话的两个判据。 */
export type SessionToolsOptions = {
  /** 这一步 bind 成 `/workspace` 的宿主目录:服务读的就是它里面的 `script.ts`。 */
  readonly workspaceDir: string;
  /** 会话墙钟的**绝对**到点时刻(epoch ms)。宿主的唯一 deadline 判据。 */
  readonly deadlineAtMs: number;
  readonly check: CheckService;
  readonly evaluate: EvaluateService;
  /** `evaluate` 的会话上限;缺省 `EVALUATE_CALL_LIMIT`(3)。 */
  readonly evaluateLimit?: number;
  /** 时钟注入缝(单测用)。缺省 `Date.now`。 */
  readonly now?: () => number;
};

/**
 * 一个会话的工具面。`requestHandler` 直接喂给 `sandbox.run({ requestHandler })`。
 */
export type SessionTools = {
  /** 一行请求进、一行响应出。**永不抛错**:抛错在传输层会被吞掉,薄壳就等到死了。 */
  readonly requestHandler: (line: string) => Promise<string>;
  /** 已执行的 `evaluate` 次数(超限被拒的不算)。 */
  readonly evaluateCalls: () => number;
  /** 模型有没有通过薄壳喊过 `done`(权威信号仍是宿主侧块切分,见 `done.ts`)。 */
  readonly doneRequested: () => boolean;
  /** 会话墙钟是否已到点。 */
  readonly expired: () => boolean;
  /** 距到点还剩多少毫秒(已过期时为 0)。 */
  readonly remainingMs: () => number;
};

/** 一条拒绝响应:非零退出码 + 伪造 stderr,`result` 缺席(没有真执行,就没有派生视图)。 */
const refusal = (exitCode: number, stderr: string): ToolResponse => ({
  exitCode,
  stdout: "",
  stderr: `${stderr}\n`,
});

/**
 * 造一个会话的工具面。
 *
 * `deadlineAtMs` 由调用方算(会话起点 + 总墙钟预算);本模块只比对,不定义那个预算的取值——
 * 它是会话级预算的键,真源不在这一票。
 */
export const createSessionTools = (options: SessionToolsOptions): SessionTools => {
  const limit = options.evaluateLimit ?? EVALUATE_CALL_LIMIT;
  const now = options.now ?? Date.now;
  let evaluateCalls = 0;
  let done = false;

  const expired = (): boolean => now() >= options.deadlineAtMs;
  const remainingMs = (): number => Math.max(0, options.deadlineAtMs - now());

  const dispatch = async (line: string): Promise<ToolResponse> => {
    const parsed = parseToolRequest(line);
    if (!parsed.ok) {
      // 沙箱侧写进来的任意字节都落在这里(包括「响应形状」的伪造行):它是请求,不是响应。
      return refusal(PROTOCOL_EXIT_CODE, `工具不可用:不是一条工具请求(${parsed.reason})。`);
    }
    const tool = parsed.request.tool;

    if (!(TOOL_NAMES as readonly string[]).includes(tool)) {
      return refusal(REFUSAL_EXIT_CODE, `${tool}: ${UNKNOWN_TOOL_MESSAGE}`);
    }
    if (expired()) {
      return refusal(REFUSAL_EXIT_CODE, `${tool}: ${SESSION_EXPIRED_MESSAGE}`);
    }

    switch (tool) {
      case "check":
        return await options.check({ workspaceDir: options.workspaceDir });
      case "evaluate": {
        if (evaluateCalls >= limit) {
          return refusal(REFUSAL_EXIT_CODE, QUOTA_EXHAUSTED_MESSAGE);
        }
        // 计数发生在调用之前:一次**尝试**就是一次调用。服务自己抛错也一样算用掉了额度,
        // 否则「让服务失败」就成了一条刷额度的路。
        evaluateCalls += 1;
        return await options.evaluate({
          workspaceDir: options.workspaceDir,
          call: evaluateCalls,
        });
      }
      default:
        // `done` 的权威判定在宿主侧的块切分(`splitDoneBlock`),薄壳被调到只在模型把它写进
        // 管道之类的地方;那是「认得但不做事」的一条合法请求。
        done = true;
        return { exitCode: 0, stdout: "", stderr: "" };
    }
  };

  const requestHandler = async (line: string): Promise<string> => {
    let response: ToolResponse;
    try {
      response = await dispatch(line);
    } catch (error) {
      // 服务的异常不往传输层扔:那里会把它吞掉(见 `execute.ts`),薄壳就等到单步墙钟为止。
      const message = error instanceof Error ? error.message : String(error);
      response = refusal(REFUSAL_EXIT_CODE, `工具服务内部错误(${message})`);
    }
    return serializeToolResponse(response);
  };

  return {
    requestHandler,
    evaluateCalls: () => evaluateCalls,
    doneRequested: () => done,
    expired,
    remainingMs,
  };
};
