/**
 * harness 身份:人维护的叙事版本 + 对**显式行为清单**取的 sha256(ADR-0029)。
 *
 * ── 为什么哈希的是清单,不是源码 ──
 *
 * 源码哈希会因为一次重构就变,那是噪音;清单只在其行为真的改了时变,而那正是「换 harness」
 * 的定义。所以清单里写的是模型面对的世界:动作语法、可见二进制、挂载、网络、配额、服务形状、
 * **工具收不收参数**、观测出口、deadline、截断上限与比例、上下文守卫、工具链、收工命令的语义。
 *
 * ── 清单**不含**两样东西 ──
 *
 * 1. **档案形状**(`archiveSchemaVersion`):档案是那个世界留下的**记录**,是消费侧格式。
 *    混进来之后,任何纯序列化的重构都会让榜断代,把「换了 harness」稀释成「改了 JSON 排版」;
 *    而真正的读兼容问题它又解决不了(装载器没法靠一个叙事哈希判断「这份档案能不能读」)。
 * 2. **退避参数**(`RETRY` 的枪数与等待):那是测量条件的抗噪设置,不是模型能感知的行为面。
 *    把 `maxRetries` 从 3 调到 5 就让所有模型的历史成绩不可比,是荒谬的(ADR-0036)。
 *
 * 单测把这两条写成断言(清单序列化后不含那些名字),因为「清单里没有它」是一件会被人顺手
 * 加回来而没人发现的事。
 *
 * ── 数字不在本文件里再抄一遍 ──
 *
 * 截断上限取自 `truncate.ts`、步数与墙钟取自 `limits.ts`、配额取自真源包的
 * `EVALUATE_CALL_LIMIT`、单步墙钟与通道 fd 取自执行器、挂载与网络**直接取 bwrap 的
 * 参数表**。所以本文件没有第二份取值:改真源,清单跟着变,digest 跟着断代。
 */

import { createHash } from "node:crypto";

import { EVALUATE_CALL_LIMIT, SANDBOX_ROOTFS_FILES } from "@model-war/schema";

import { ACTION_REJECT_EXIT_CODE, ACTION_REJECT_REASONS } from "./action.js";
import { AGENT_MAX_STEPS, AGENT_TOTAL_WALL_CLOCK_MS, CONTEXT_GUARD } from "./limits.js";
import { PROTOCOL_EXIT_CODE } from "./host/dispatcher.js";
import { bwrapArgv } from "./sandbox/argv.js";
import { CHANNEL_FD, DEFAULT_STEP_WALL_CLOCK_MS } from "./sandbox/execute.js";
import {
  OBSERVATION_LIMITS,
  RAW_PATHOLOGICAL_LIMIT_BYTES,
  truncateObservation,
} from "./truncate.js";

/** 人维护的叙事版本。换 harness 时人改它,digest 由门禁算。 */
export const HARNESS_VERSION = "bash-mini/0.1";

/**
 * 受限工具的三个名字。它们必须是 rootfs 里真实存在的薄壳(单测比对清单)。
 *
 * 收工工具叫 `finish`:`done` 是 bash 保留字,裸写一行就是语法错误,薄壳不可达(ADR-0032 修订)。
 */
export const HOST_SERVICE_TOOLS = ["check", "evaluate", "finish"] as const;

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
  readonly actionSyntax: {
    /**
     * ⚠️ **占位格,票 06 要删掉它**。
     *
     * 它记的是旧协议里的东西(`bash` 围栏标记),而新协议里没有围栏——动作是一次工具调用。
     * 票 02 删了 `ACTION_FENCE_TAG` 常量,这一格因此失去真源;为了不把整个 `harnessManifest()`
     * 的改形塞进票 02(那是票 06 的范围),这里先记一个中性的占位值让它继续编译。
     * 同一批里 `blocks` / `multiLine` / `observationRole` / `rejectExitCode` 四格也要一起重写。
     */
    readonly fenceTag: string;
    readonly blocks: "exactly-one";
    readonly multiLine: "one-bash-c";
    readonly observationRole: "user";
    readonly rejects: readonly string[];
    readonly rejectExitCode: number;
  };
  /**
   * 收工工具这一格:它是沙箱里的一条真命令(`bin/finish` 薄壳),不是文本标记。
   *
   * 键名叫 `finish`(与模型看到的那条命令同名),子键说的是**行为**:它经通道上报、由宿主在
   * 本步结束后收工、照常占一步;而 `stopsRemainingCommands: false` 是这一版的行为放宽——
   * 整块由 `bash` 解析,`finish` 之后写的行**仍会执行**。
   *
   * 档案侧的 `action.kind: "done"` / `termination: "done"` 是 v3 形状里的常量,不跟着改名:
   * 改它等于升 `archiveSchemaVersion`,而旧档要照旧可读。
   */
  readonly finish: {
    readonly command: "finish";
    readonly form: "rootfs-shim";
    readonly signal: "host-channel";
    readonly stopsRemainingCommands: false;
    readonly endsSession: true;
    readonly countsAsStep: true;
  };
  readonly visibleBinaries: readonly string[];
  /** bwrap 的参数表:挂载面、命名空间、环境都在里面(直接取自执行器,不抄一份)。 */
  readonly sandboxArgv: readonly string[];
  readonly network: "unshared" | "present";
  readonly quotas: { readonly evaluate: number; readonly check: "counts-as-step" };
  readonly services: {
    readonly tools: readonly string[];
    readonly shape: "host-side-service";
    readonly channelFd: number;
    /**
     * 参数面:两个服务型工具(`check` / `evaluate`)**都不收参数**。
     *
     * 它们做什么由「当前的 `/workspace/script.ts`」唯一决定,命令行没有可填的东西。所以
     * `evaluate --help` 这类试探是一条**被拒**的请求:模型看到一句用法 + 非零退出码,评测不执行、
     * 配额也不消耗(判据在 `host/dispatcher.ts`,这里记录模型撞得到的那一面)。
     *
     * 它进清单的理由与别的格一样:它不是「内部实现细节」,而是模型会试、试了会拿到不同结果的
     * 一条行为面——以前那一次试探会真的跑掉 91 秒与一次额度。
     */
    readonly args: {
      readonly accepted: false;
      /** 被拒时模型看到的退出码(协议误用,与「工具不可用」同档)。 */
      readonly exitCode: number;
      /** 被拒的那一次不执行、不占 `evaluate` 配额。 */
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
      fenceTag: "none",
      blocks: "exactly-one",
      multiLine: "one-bash-c",
      observationRole: "user",
      rejects: ACTION_REJECT_REASONS,
      rejectExitCode: ACTION_REJECT_EXIT_CODE,
    },
    finish: {
      command: "finish",
      form: "rootfs-shim",
      signal: "host-channel",
      stopsRemainingCommands: false,
      endsSession: true,
      countsAsStep: true,
    },
    visibleBinaries: SANDBOX_ROOTFS_FILES.filter((file) => file.startsWith("bin/")),
    sandboxArgv: argv,
    network: argv.includes("--unshare-net") ? "unshared" : "present",
    // 配额取 **dispatcher 执行的那个**常量(`EVALUATE_CALL_LIMIT`),不是它的同值邻居:
    // 清单要记录的是「模型撞得到的判据」。两者同源只在这一处(out of `tool-channel.ts`)。
    quotas: { evaluate: EVALUATE_CALL_LIMIT, check: "counts-as-step" },
    services: {
      tools: HOST_SERVICE_TOOLS,
      shape: "host-side-service",
      channelFd: CHANNEL_FD,
      // 退出码取自 dispatcher(执行那条判据的地方),清单不另写一个数字。
      args: { accepted: false, exitCode: PROTOCOL_EXIT_CODE, consumesQuota: false },
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
    // 工具链只写形状:`check` 用哪一版 tsc 由 harnessVersion 吸收(ADR-0029)。
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
 * ⚠️ 这一版是**过渡值**:票 02 只改了 `actionSyntax.rejects` 的四个名字(拒绝档从围栏块那四族
 * 换成工具调用那四族),清单的其余格子(围栏标记、`blocks`、`observationRole`、`finish` 的形状、
 * `services.channelFd` 与 `tools`)要等票 06 才重写。票 06 落地后这个数还会再变一次——那是有意的
 * 断代:一个「协议已经换了」的世界不该与旧世界共用一个身份。
 */
export const HARNESS_DIGEST = "78a36d1e7d2c11ac650a5fbeb90dce9588e671c1b63e4781365f874b91c5a821";

/** 现算的身份:`harnessVersion` + `harnessDigest`,落进档案的就是这两个。 */
export const harnessIdentity = (): { version: string; digest: string } => ({
  version: HARNESS_VERSION,
  digest: digestOf(harnessManifest()),
});
