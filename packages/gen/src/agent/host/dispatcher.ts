/**
 * 宿主侧的 **dispatcher**:工具调用的受理端,也是配额与会话墙钟的唯一判据源。
 *
 * ── 它做的三件判定(ADR-0033「宿主是唯一的判据源」) ──
 * 1. 工具名在**白名单**里(工具声明减掉 `bash`,后者由 loop 交给沙箱);
 * 2. `evaluate` 的**调用次数**未超会话上限(默认 `EVALUATE_CALL_LIMIT` = 3),
 *    以及 `probe` 自己的上限(默认 `PROBE_CALL_LIMIT` = 5,与那三次互不侵占);
 * 3. 会话**墙钟**未到点。
 *
 * 三条任一不成立,就回一份 `isError: true` 的结果且**真执行函数一次都不调**。
 *
 * ── 模型没有那条路径,而不是「敲不到别的路径」 ──
 *
 * 旧世界靠「沙箱里只有薄壳 + 薄壳只能打宿主」保住这条前提:模型能用 `sh` 语法绕过 PATH,能往
 * 继承的 fd 上写任意字节,宿主只能逐字节校验它。现在 `check` / `evaluate` / `finish` **不在
 * 沙箱里**:rootfs 的 `bin/` 里没有这三个名字,模型够得着的只有一次工具调用,而工具调用由宿主
 * 分派。前提因此从「敲不到别的路径」升级成「没有那个路径」——这里不再需要解析任何人写的字节,
 * 入参是**结构化的**,不是一段可能被伪造的文本。
 *
 * ── 为什么仍然不信请求里的任何东西 ──
 *
 * 动作层(`agent/action.ts`)已经判过「恰好一次调用、名字在声明集合里、`arguments` 形状对」,
 * 但那是**生成侧**的判据;host 这一层是**执行侧**的判据,它自己再判一遍名字与参数面。两层的
 * 重叠是有意的:动作层决定「这一步要不要执行」,这里决定「执行什么、执行几次」。参数面在两层
 * 都判,读的是同一处真源(`tools.ts` 的 `acceptsArgumentsOf`)。
 *
 * ── 会话墙钟是宿主的判据,不是沙箱单步墙钟(ADR-0029) ──
 * 单步墙钟(`sandbox.run` 的 `wallClockMs`)防的是「这一步挂住」,它的语义是**杀进程**,不是
 * deadline。会话墙钟在这里:到点即拒,连执行都不开始——一个已经没时间跑 tsc 的会话,让 tsc
 * 跑起来再被杀掉,只会把「预算耗尽」写成一次莫名其妙的工具失败。
 *
 * ── 为什么是工厂函数而不是模块级状态 ──
 * `evaluate` 的「三次」是**会话级**的。写成模块级全局,第二个会话会继承第一个会话的计数,而且
 * 并发跑两场会话时计数互相吃。所以每次会话 `createSessionTools(...)` 一次,状态封在闭包里。
 */

import { EVALUATE_CALL_LIMIT, PROBE_CALL_LIMIT, type ToolOutcome } from "@model-war/schema";

import { HOST_SERVICE_TOOLS, acceptsArgumentsOf, type ToolCall, type ToolName } from "../tools.js";
import type { CheckService } from "./check-service.js";
import type { EvaluateService } from "./evaluate-service.js";
import type { ProbeService } from "./probe-service.js";

/** 拒绝时用的退出码:与「命令跑了但失败」同档(模型看到的是一次失败的工具调用)。 */
export const REFUSAL_EXIT_CODE = 1;

/** 参数误用的退出码:与「工具不可用」分开,便于读侧把两类拒绝区分开。 */
export const PROTOCOL_EXIT_CODE = 2;

/**
 * 配额用完时的拒绝文案。
 *
 * 文案本身**不是给人读的,是给模型读的**:它要说清「别再试了」与「试了也不会执行」。改的是
 * 载体——旧世界把它塞进一条伪造的 `stderr`(让模型以为命令失败),新世界它是一条
 * `isError: true` 的工具结果。
 */
export const QUOTA_EXHAUSTED_MESSAGE = `evaluate: 工具不可用:本会话的评测额度已用完(${String(EVALUATE_CALL_LIMIT)}/${String(EVALUATE_CALL_LIMIT)} 次)。`;

/**
 * 探针额度用完时的拒绝文案:与 `QUOTA_EXHAUSTED_MESSAGE` **同形**(同一个载体、同一种说法),
 * 只换工具名与那个数。
 *
 * 为什么探针需要有上限:一次探针 = 跑 8 场 ≈ 21.6 s。不设上限,"跑前 8 场"就是一条免费的
 * 无限循环——模型可以一直问而不付任何代价,会话墙钟会在那里被吃掉,而它本可以用来改脚本。
 */
export const PROBE_QUOTA_EXHAUSTED_MESSAGE = `probe: 工具不可用:本会话的探针额度已用完(${String(PROBE_CALL_LIMIT)}/${String(PROBE_CALL_LIMIT)} 次)。`;

/** 会话墙钟到点时的拒绝文案(前面拼工具名)。 */
export const SESSION_EXPIRED_MESSAGE = "工具不可用:会话墙钟已到点,这一次不执行。";

/** 白名单之外的工具名。名单从工具声明派生(`tools.ts` 的 `HOST_SERVICE_TOOLS`),不另抄。 */
export const UNKNOWN_TOOL_MESSAGE = `工具不可用:不在受限工具白名单里(${HOST_SERVICE_TOOLS.join(" / ")})。`;

/**
 * 两个服务型工具的用法。**都不接受参数**:它们做什么由「当前的 `/workspace/script.ts`」唯一
 * 决定,命令行没有可填的东西。
 *
 * ── 为什么要有这一条 ──
 *
 * 模型偶尔会先试探用法(`evaluate --help`)。旧世界里那会被当成一次真评测执行——白花 91 秒与
 * 一次额度(`archive/mimo-v2.6-flash/2026-11-18T08-12-18-087Z` 第 8 步)。而「不接受参数」是
 * 一条**结构性**事实,不是可以商量的输入:放行多余参数只会让它以为那些参数生效了。
 */
export const TOOL_USAGE = {
  check: "用法:check(不接受参数)——检查当前 /workspace/script.ts 的类型与静态校验,计一步。",
  probe:
    "用法:probe(不接受参数)——把当前 /workspace/script.ts 跑完整计划的前 8 场," +
    "回每一条预算轨的最坏占用读数,计一步、占用一次探针额度。",
  evaluate:
    "用法:evaluate(不接受参数)——把当前 /workspace/script.ts 送去跑一次完整评测,计一步、占用一次配额。",
} as const;

/** 带参数时的拒绝:一句用法 + 点名多出来的参数(不执行、不吃配额)。 */
const argumentRefusal = (
  tool: "check" | "probe" | "evaluate",
  argumentsJson: string,
): ToolOutcome =>
  refusal(
    PROTOCOL_EXIT_CODE,
    `${tool}: ${TOOL_USAGE[tool]}\n` +
      `参数不被接受:${argumentsJson}。` +
      "这些工具都只看当前的 /workspace/script.ts,没有可传的参数。",
  );

/**
 * 声明里「不收参数」的那个形状,`arguments` 原文是不是就是它。
 *
 * 空串与 `{}` 都算「没带参数」——不少渠道对不收参数的工具给的就是空串,把它判成一次参数误用
 * 会拒掉一条合法调用。动作层已经判过同一件事(它更严格:多余键归 `malformed-arguments`),
 * 这里是执行侧的第二道。
 */
const hasNoArguments = (argumentsJson: string): boolean => {
  const trimmed = argumentsJson.trim();
  return trimmed === "" || trimmed === "{}";
};

/** dispatcher 的依赖:两个服务 + 会话的两个判据。 */
export type SessionToolsOptions = {
  /** 这一步 bind 成 `/workspace` 的宿主目录:服务读的就是它里面的 `script.ts`。 */
  readonly workspaceDir: string;
  /** 会话墙钟的**绝对**到点时刻(epoch ms)。宿主的唯一 deadline 判据。 */
  readonly deadlineAtMs: number;
  readonly check: CheckService;
  readonly evaluate: EvaluateService;
  /**
   * 探针服务。**可选**:跨包的那段字面量桥(`packages/tools` 的 `executor-bridge`)造工具面时
   * 不传它——那一侧归票 04。缺席时 `probe` 是一条 fail-closed 的拒绝(不是静默成功,也不是
   * 当成 `finish`),于是那条桥上"没有探针"这件事与"探针被拒"在读侧是同一件事。
   */
  readonly probe?: ProbeService;
  /** `evaluate` 的会话上限;缺省 `EVALUATE_CALL_LIMIT`(3)。 */
  readonly evaluateLimit?: number;
  /** `probe` 的会话上限;缺省 `PROBE_CALL_LIMIT`(5)。与 `evaluate` 的额度互不侵占。 */
  readonly probeLimit?: number;
  /** 时钟注入缝(单测用)。缺省 `Date.now`。 */
  readonly now?: () => number;
};

/**
 * 一个会话的工具面。
 *
 * `dispatch(step, call)` 收下**这一步的那一次调用**:步号是显式入参,不是会话级的一个槽。
 * 它要用来给候选证据族起名(`observed-<runId>-round-<步>`)——槽的写法要靠「先写进去、执行完
 * 再取走」的时序保住,而时序一旦错位,证据会挂到另一步上,读侧完全看不出来。
 */
export type SessionTools = {
  /**
   * 受理一次工具调用。**永不抛错**:服务抛出的异常折成一条 `isError: true` 的结果。
   *
   * 抛错会让调用方(执行器)把一次「服务坏了」记成「模型这一步挂了」,而两者的处方完全不同:
   * 前者要人去修环境,后者模型能自己改。所以异常在这里收口,带着它自己的那句话。
   */
  readonly dispatch: (step: number, call: ToolCall) => Promise<ToolOutcome>;
  /** 已执行的 `evaluate` 次数(超限被拒的不算)。 */
  readonly evaluateCalls: () => number;
  /** 已执行的 `probe` 次数(超限被拒的不算)。与 `evaluateCalls` 各记各的。 */
  readonly probeCalls: () => number;
  /** 模型有没有通过 `finish` 工具报过「收工」(`termination: "done"` 的唯一真源)。 */
  readonly finishRequested: () => boolean;
  /** 会话墙钟是否已到点。 */
  readonly expired: () => boolean;
  /** 距到点还剩多少毫秒(已过期时为 0)。 */
  readonly remainingMs: () => number;
};

/** 一条拒绝结果:`isError: true` + 一段给模型读的文案,`result` 缺席(没有真执行)。 */
const refusal = (exitCode: number, stderr: string): ToolOutcome => ({
  exitCode,
  stdout: "",
  stderr: `${stderr}\n`,
  isError: true,
});

/**
 * 造一个会话的工具面。
 *
 * `deadlineAtMs` 由调用方算(会话起点 + 总墙钟预算);本模块只比对,不定义那个预算的取值——
 * 它是会话级预算的键,真源不在这一票。
 */
export const createSessionTools = (options: SessionToolsOptions): SessionTools => {
  const limit = options.evaluateLimit ?? EVALUATE_CALL_LIMIT;
  const probeLimit = options.probeLimit ?? PROBE_CALL_LIMIT;
  const now = options.now ?? Date.now;
  let evaluateCalls = 0;
  let probeCalls = 0;
  let finish = false;

  const expired = (): boolean => now() >= options.deadlineAtMs;
  const remainingMs = (): number => Math.max(0, options.deadlineAtMs - now());

  const dispatch = async (step: number, call: ToolCall): Promise<ToolOutcome> => {
    // 白名单 = 声明减 `bash`(`find` 而不是 `includes`,因为它同时完成类型窄化)。
    const tool: ToolName | undefined = HOST_SERVICE_TOOLS.find((name) => name === call.name);
    if (tool === undefined) {
      // `bash` 也落在这条:它由 loop 交给沙箱执行,不经宿主分派。
      return refusal(REFUSAL_EXIT_CODE, `${call.name}: ${UNKNOWN_TOOL_MESSAGE}`);
    }
    if (expired()) {
      return refusal(REFUSAL_EXIT_CODE, `${tool}: ${SESSION_EXPIRED_MESSAGE}`);
    }

    // 参数面在**执行与计数之前**判:被拒的一次不是一次评测,不扣额度。
    // 判据从工具声明派生(`acceptsArgumentsOf`),与动作层同一个真源。
    if (!acceptsArgumentsOf(tool) && !hasNoArguments(call.argumentsJson)) {
      if (tool === "check" || tool === "probe" || tool === "evaluate") {
        return argumentRefusal(tool, call.argumentsJson);
      }
      return refusal(
        PROTOCOL_EXIT_CODE,
        `${tool}: 不接受参数(收到的 arguments 是 ${call.argumentsJson})。` +
          "它做什么由当前的 /workspace/script.ts 唯一决定。",
      );
    }

    switch (tool) {
      case "check":
        return await options.check({ workspaceDir: options.workspaceDir });
      case "probe": {
        const probe = options.probe;
        if (probe === undefined) {
          // 没接上服务时 fail-closed:既不静默成功,也不当成收工。
          return refusal(REFUSAL_EXIT_CODE, `${tool}: 工具不可用:这个工具的执行体还没有接上。`);
        }
        if (probeCalls >= probeLimit) {
          return refusal(REFUSAL_EXIT_CODE, PROBE_QUOTA_EXHAUSTED_MESSAGE);
        }
        // 计数发生在调用之前,理由与 `evaluate` 逐字相同(见下一格):一次**尝试**就是一次调用,
        // 否则「让服务失败」就成了一条刷额度的路。
        probeCalls += 1;
        return await probe({ workspaceDir: options.workspaceDir });
      }
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
          step,
        });
      }
      case "finish":
        // 收工是**这一步的请求**:模型调它,会话在这一步结束后停。新世界里一次调用就是一个
        // 动作,所以旧版「`finish` 之后的行仍然执行」那条放宽在这里没有对应物。
        finish = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      default:
        // 四个宿主工具都已接线,只剩 `bash` 落在这里(它在白名单外,见上面那条 `find`)。
        // fail-closed:一个走不到的分支也不许静默成功。
        return refusal(REFUSAL_EXIT_CODE, `${String(tool)}: ${UNKNOWN_TOOL_MESSAGE}`);
    }
  };

  return {
    dispatch: async (step, call) => {
      try {
        return await dispatch(step, call);
      } catch (error) {
        // 服务的异常不折成「模型写错了」:它带着自己的那句话,标记成**工具调用失败**,
        // 由读它的那一侧(执行器 / pipeline 的 facts)决定这算不算 infra。
        const message = error instanceof Error ? error.message : String(error);
        return refusal(REFUSAL_EXIT_CODE, `工具服务内部错误(${message})`);
      }
    },
    evaluateCalls: () => evaluateCalls,
    probeCalls: () => probeCalls,
    finishRequested: () => finish,
    expired,
    remainingMs,
  };
};
