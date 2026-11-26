/**
 * harness 身份:人维护的叙事版本 + 对**显式行为清单**取的 sha256。
 *
 * ── 为什么哈希的是清单,不是源码 ──
 *
 * 源码哈希会因为一次重构就变,那是噪音;清单只在其行为真的改了时变,而那正是「换 harness」
 * 的定义。所以清单里写的是模型面对的世界:动作语法、**工具面**(声明集合、谁收参数、并行调用
 * 被拒、探针回什么读数)、可见二进制、挂载、网络、配额、服务形状、观测出口、deadline、截断
 * 上限与比例、上下文守卫、工具链、收工命令的语义。
 *
 * ── 清单**不含**两样东西 ──
 *
 * 1. **档案形状**(`archiveSchemaVersion`):档案是那个世界留下的**记录**,是消费侧格式。
 *    混进来之后,任何纯序列化的重构都会让榜断代,把「换了 harness」稀释成「改了 JSON 排版」;
 *    而真正的读兼容问题它又解决不了(装载器没法靠一个叙事哈希判断「这份档案能不能读」)。
 * 2. **退避参数**(`RETRY` 的枪数与等待):那是测量条件的抗噪设置,不是模型能感知的行为面。
 *    把 `maxRetries` 从 3 调到 5 就让所有模型的历史成绩不可比,是荒谬的。
 *
 * 单测把这两条写成断言(清单序列化后不含那些名字),因为「清单里没有它」是一件会被人顺手
 * 加回来而没人发现的事。
 *
 * ── 数字不在本文件里再抄一遍 ──
 *
 * 截断上限取自 `truncate.ts`、步数与墙钟取自 `limits.ts`、配额取自真源包的
 * `EVALUATE_CALL_LIMIT` / `PROBE_CALL_LIMIT`、探针的三个数取自 `probe-limits.ts`、单步墙钟取自
 * 执行器、工具名与参数面取自工具声明(`tools.ts`)、挂载与网络**直接取 bwrap 的参数表**。
 * 所以本文件没有第二份取值:改真源,清单跟着变,digest 跟着断代。
 */

import { createHash } from "node:crypto";

import {
  EVALUATE_CALL_LIMIT,
  PROBE_CALL_LIMIT,
  PROBE_MATCH_LIMIT,
  PROBE_NEAR_LIMIT_RATIO,
  SANDBOX_ROOTFS_FILES,
} from "@model-war/schema";

import { ACTION_REJECT_REASONS, type ActionRejectReason } from "./action.js";
import { AGENT_MAX_STEPS, AGENT_TOTAL_WALL_CLOCK_MS, CONTEXT_GUARD } from "./limits.js";
import { bwrapArgv } from "./sandbox/argv.js";
import { DEFAULT_STEP_WALL_CLOCK_MS } from "./sandbox/execute.js";
import { HOST_SERVICE_TOOLS, TOOL_NAMES, acceptsArgumentsOf } from "./tools.js";
import {
  OBSERVATION_LIMITS,
  RAW_PATHOLOGICAL_LIMIT_BYTES,
  truncateObservation,
} from "./truncate.js";

/**
 * 人维护的叙事版本。换 harness 时人改它,digest 由门禁算。
 *
 * ── 为什么从 `bash-mini/0.1` 换成 `tool-call/1.0` ──
 *
 * 旧代号里的 `bash-mini` 到后期只剩「一步一个 shell」这一层意思(`mini` 指抄 mini-swe-agent 的
 * 三条铁律),但读者会把它读成「协议还是 bash 那套文本协议」——而协议已经换成原生的工具调用
 * (修订)。代号是给人看的那一半身份,它撒谎与清单撒谎同性质。
 *
 * 读侧**不按它分派**:`harnessVersion` 只是记录,所以换代号不会让任何旧档读不出来;断代的是
 * digest。
 */
export const HARNESS_VERSION = "tool-call/1.0";

/**
 * 宿主受理的工具名:**从工具声明派生**(`tools.ts` 的 `HOST_SERVICE_TOOLS` = 五个声明减 `bash`)。
 *
 * 本文件以前在这里手写一份 `["check","evaluate","finish"]`,与 `tool-channel.ts` 的那一份同名
 * 双份;两份各说一遍「必须是沙箱里真实存在的薄壳」。薄壳已删(票 03),清单与声明现在是同一个
 * 集合的两个投影,所以只留声明那一份。
 *
 * 新世界里宿主受理的是**四个**名字(`check` / `probe` / `evaluate` / `finish`),它们都不在沙箱
 * 的 `bin/` 里——「敲不到」升级成「没有那个路径」(修订②)。
 */
export { HOST_SERVICE_TOOLS };

/**
 * 观测告警里必须出现的**可执行方向**。
 *
 * 它是一份「存在性」清单:每一格在 digest 里的取值是 `present` / `absent`,由真跑一次截断、
 * 看文案里有没有这句话得出。所以删掉一条处方不只是少了一行帮助文本,而是换了一个 harness——
 * 这正是它该有的代价:模型学不会「怎么在 16 KiB 上限下工作」时,harness 的行为已经变了。
 */
export const OBSERVATION_ADVICE_HINTS = [
  "head -c",
  "tail -c",
  "sed -n",
  "grep -n",
  "/workspace/out.txt",
] as const;

/** 清单本身。键名就是「模型面对的世界」的栏目,不按档案的形状排。 */
export type HarnessManifest = {
  /**
   * 动作语法:这一步**恰好一次工具调用**。
   *
   * ── 旧协议的痕迹一个都不要留 ──
   *
   * 清单的作用是「模型当时面对的世界」,所以描述旧协议的那几格(`fenceTag`、`rejectExitCode`、
   * 以及 `finish.stopsRemainingCommands`)全部删了:围栏标记不存在了、拒绝的载体是一次工具结果
   * 而不是 shell 退出码、一次调用就是一个动作所以没有「之后的行」。留着任何一格就是清单在说谎。
   */
  readonly actionSyntax: {
    /** 零次被执行、两次以上也被拒:一步就是一次调用(理由见本文件的头注)。 */
    readonly blocks: "exactly-one-tool-call";
    /** `bash` 的 `command` 是**一条命令串**:换行、`&&`、`for … do … done` 都交给同一个 shell。 */
    readonly multiLine: "one-command-string";
    /** 观测回给模型的角色。有 `tool_call_id` 可配对了,所以是 `tool`(修订)。 */
    readonly observationRole: "tool";
    /** 被拒的形状族:真源在 `action.ts` 的 `ACTION_REJECT_REASONS`,清单不另抄一份。 */
    readonly rejects: readonly ActionRejectReason[];
  };
  /**
   * 收工工具这一格:它是模型发起的一次**工具调用**,不是沙箱里的命令、也不是文本标记。
   *
   * 档案侧的 `action.kind: "done"` / `termination: "done"` 是 v4 形状里的常量,不跟着改名:
   * 改它等于再升一次 `archiveSchemaVersion`,而旧档要照旧可读。
   */
  readonly finish: {
    readonly command: "finish";
    readonly form: "tool-call";
    readonly signal: "tool-result";
    readonly endsSession: true;
    readonly countsAsStep: true;
  };
  readonly visibleBinaries: readonly string[];
  /** bwrap 的参数表:挂载面、命名空间、环境都在里面(直接取自执行器,不抄一份)。 */
  readonly sandboxArgv: readonly string[];
  readonly network: "unshared" | "present";
  /**
   * 配额。三格都是**计数发生在调用之前**的同一个判据(超限即拒、真执行函数零调用)。
   *
   * `probe` 与 `evaluate` 互不侵占:探针不产出候选、不占那三次里的任何一次。
   */
  readonly quotas: {
    readonly evaluate: number;
    readonly probe: number;
    readonly check: "counts-as-step";
  };
  /**
   * **工具面**:模型这一轮请求里真的看见的那五个声明。
   *
   * 它进清单的理由与别的格一样——它是模型面对的世界的一部分:工具名、谁收参数、并行调用被拒、
   * 探针回什么形状的读数。这些都在 API 层写得下,比叙述文档里一段散文更硬。
   *
   * 三格各自回答一件事:
   * - `tools` / `acceptsArguments`:声明了什么(`AGENT_TOOLS` 派生,不手写第二份);
   * - `parallelCalls`:一步多次调用的**判据**是拒绝(不是排版偏好);
   * - `probe`:探针的读数事实。它属于**工具面**而不是配额面:模型要知道的不是「能调几次」,
   *   而是「它回的是最坏占用读数、不是二值判定」——后者把「探针绿 = 整张网格通过」变成了
   *   一句假安心(漏检率 2/4)。
   */
  readonly toolSurface: {
    readonly tools: readonly string[];
    readonly acceptsArguments: Readonly<Record<string, boolean>>;
    readonly parallelCalls: "rejected";
    readonly probe: {
      readonly matchLimit: number;
      readonly nearLimitRatio: number;
      readonly returns: "peak-usage";
    };
  };
  readonly services: {
    /**
     * 宿主侧工具:`bash` 之外的全部声明(由 `tools.ts` 的 `HOST_SERVICE_TOOLS` 派生)。
     *
     * 它们**不在沙箱里**:rootfs 的 `bin/` 里没有这四个名字,模型够得着的只有一次工具调用。
     */
    readonly tools: readonly string[];
    readonly shape: "host-side-service";
    /**
     * 参数面:四个服务型工具(`check` / `probe` / `evaluate` / `finish`)**都不收参数**。
     *
     * 它们做什么由「当前的 `/workspace/script.ts`」唯一决定,命令行没有可填的东西。所以
     * `evaluate --help` 这类试探是一条**被拒**的请求:模型看到一句用法 + 非零退出码,评测不执行、
     * 配额也不消耗(判据在 `host/dispatcher.ts`,这里记录模型撞得到的那一面)。
     *
     * 旧清单里还有一格 `exitCode`:它记的是「被拒时会撞到 shell 退出码」。工具调用没有退出码
     * 这一层(结果是一条 `isError: true` 的工具结果),那一格已删。
     */
    readonly args: {
      readonly accepted: false;
      /** 被拒的那一次不执行、不占 `evaluate` / `probe` 配额。 */
      readonly consumesQuota: false;
    };
  };
  readonly observation: {
    readonly keys: readonly string[];
    readonly stdout: { readonly limitBytes: number; readonly headRatio: string };
    readonly stderr: { readonly limitBytes: number; readonly headRatio: string };
    readonly raw: { readonly limitBytes: number; readonly rule: "pathological-only" };
    readonly advice: readonly string[];
  };
  readonly deadline: {
    readonly maxSteps: number;
    readonly totalWallClockMs: number;
    readonly stepWallClockMs: number;
  };
  readonly contextGuard: { readonly ratio: string; readonly basis: string };
  readonly toolchain: { readonly check: string };
};

const ratioOf = (headParts: number, parts: number): string =>
  `${String(headParts)}/${String(parts)}`;

/**
 * 造清单。**纯函数**:同一份真源产出同一份字节,没有读盘、没有时钟、没有环境。
 *
 * bwrap 的两条路径参数换成占位符:清单描述的是形状(挂哪儿、什么可写),不是这一台机器上
 * 那个绝对路径——把 `/home/...` 写进身份,会让换一台机器就断代。
 */
export const harnessManifest = (): HarnessManifest => {
  const argv = bwrapArgv({
    command: "<command>",
    workspaceDir: "<workspace>",
    rootfsDir: "<rootfs>",
  });
  // 真跑一次截断,看处方里到底有什么:存在性由此得出,不靠人手同步。
  const advisorySample = truncateObservation(
    "stdout",
    "x".repeat(OBSERVATION_LIMITS.stdout.limitBytes + 1),
  );
  return {
    actionSyntax: {
      blocks: "exactly-one-tool-call",
      multiLine: "one-command-string",
      observationRole: "tool",
      rejects: ACTION_REJECT_REASONS,
    },
    finish: {
      command: "finish",
      form: "tool-call",
      signal: "tool-result",
      endsSession: true,
      countsAsStep: true,
    },
    visibleBinaries: SANDBOX_ROOTFS_FILES.filter((file) => file.startsWith("bin/")),
    sandboxArgv: argv,
    network: argv.includes("--unshare-net") ? "unshared" : "present",
    // 配额取 **dispatcher 执行的那个**常量(`EVALUATE_CALL_LIMIT` / `PROBE_CALL_LIMIT`),不是它的
    // 同值邻居:清单要记录的是「模型撞得到的判据」。
    quotas: { evaluate: EVALUATE_CALL_LIMIT, probe: PROBE_CALL_LIMIT, check: "counts-as-step" },
    toolSurface: {
      // 名字与「收不收参数」都从声明派生(`tools.ts`):这里写第二份就会与声明分叉。
      tools: TOOL_NAMES,
      acceptsArguments: Object.fromEntries(
        TOOL_NAMES.map((name) => [name, acceptsArgumentsOf(name)]),
      ),
      parallelCalls: "rejected",
      probe: {
        matchLimit: PROBE_MATCH_LIMIT,
        nearLimitRatio: PROBE_NEAR_LIMIT_RATIO,
        returns: "peak-usage",
      },
    },
    services: {
      // 名字取自工具声明(`tools.ts` 的 `HOST_SERVICE_TOOLS`),不是本文件的手写副本。
      tools: HOST_SERVICE_TOOLS,
      shape: "host-side-service",
      args: { accepted: false, consumesQuota: false },
    },
    observation: {
      keys: ["stdout", "stderr"],
      stdout: {
        limitBytes: OBSERVATION_LIMITS.stdout.limitBytes,
        headRatio: ratioOf(OBSERVATION_LIMITS.stdout.headParts, OBSERVATION_LIMITS.stdout.parts),
      },
      stderr: {
        limitBytes: OBSERVATION_LIMITS.stderr.limitBytes,
        headRatio: ratioOf(OBSERVATION_LIMITS.stderr.headParts, OBSERVATION_LIMITS.stderr.parts),
      },
      raw: { limitBytes: RAW_PATHOLOGICAL_LIMIT_BYTES, rule: "pathological-only" },
      advice: OBSERVATION_ADVICE_HINTS.map(
        (hint) => `${hint}:${advisorySample.includes(hint) ? "present" : "absent"}`,
      ),
    },
    deadline: {
      maxSteps: AGENT_MAX_STEPS,
      totalWallClockMs: AGENT_TOTAL_WALL_CLOCK_MS,
      stepWallClockMs: DEFAULT_STEP_WALL_CLOCK_MS,
    },
    contextGuard: {
      ratio: ratioOf(CONTEXT_GUARD.numerator, CONTEXT_GUARD.denominator),
      basis: "previous-usage.input-tokens",
    },
    // 工具链只写形状:`check` 用哪一版 tsc 由 harnessVersion 吸收。
    toolchain: { check: "tsc + static-validator" },
  };
};

/**
 * 键序无关的序列化。
 *
 * `JSON.stringify` 的顺序等于书写顺序,于是「把两个键对调一下」就会改变 digest——那笔噪音会
 * 让一次纯整理看起来像换了 harness。排序之后,只有**取值**参与身份。
 */
const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

/** 对任意一份清单取 digest。测试用它证明「某一格真的参与身份」。 */
export const digestOf = (manifest: HarnessManifest): string =>
  createHash("sha256").update(stableStringify(manifest)).digest("hex");

/**
 * 入库的期望 digest:现算一次、写在这里、由单测证明「现算 == 入库」。
 *
 * 它是**入库常量**而不是运行时现算,与 `SANDBOX_ROOTFS_TREE_HASH` 同一条纪律:判据锚定确切
 * 取值,回填时必须有人有意改这一行,于是「上限变了但没人注意」在 diff 里看得见。
 *
 * ⚠️ 这一版是**协议断代那一版**:清单从「文本围栏块 + fd 3 薄壳通道」的形状换成「原生工具调用」
 * 的形状——删了 `actionSyntax.fenceTag` / `rejectExitCode` 与 `finish.stopsRemainingCommands`,
 * 删了 `services.channelFd` 与 `services.args.exitCode`,`observationRole` 从 `user` 改成 `tool`,
 * `quotas` 多了 `probe`,并新增了整格 `toolSurface`。旧世界与新世界不共用一个身份:同一个称号下的
 * 成绩跨越这个点不可比。
 *
 * 票 07 的五场真会话必须附上**这一个数**:工具面或提示词任何一处再动,它们就全部作废。
 */
export const HARNESS_DIGEST = "e0ead2a99e9c7f0a09b43678fe6253f43756a3b8a7b4d9f399a5b2993ed459fe";

/** 现算的身份:`harnessVersion` + `harnessDigest`,落进档案的就是这两个。 */
export const harnessIdentity = (): { version: string; digest: string } => ({
  version: HARNESS_VERSION,
  digest: digestOf(harnessManifest()),
});
