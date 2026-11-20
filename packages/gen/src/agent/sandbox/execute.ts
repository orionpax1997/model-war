/**
 * 执行一步:`spawn` 一次 bwrap,收集两路输出,墙钟到点杀整棵进程树,交回
 * `{ stdout, stderr, exitCode, timedOut }`。
 *
 * ── 一步 = 一棵全新的进程树 + 一对全新的管道 ──
 * 沙箱实例是 **per-invocation** 的:没有可复用的旧实例。所以「上一步的后台进程活到下一步」
 * 不是一条需要维护的不变量,而是定义使然——bwrap 的 pid 1 退出时,内核会 SIGKILL 掉该命名空间
 * 里的全部残留进程(`pid_namespaces(7)`)。连续性只由工作区提供(同一个宿主目录),不由进程提供。
 * 依据见 ADR-0033「两个生命周期是分开的,别混」。
 *
 * ── 墙钟到点:杀的是**整棵**进程树,不是那一个 pid ──
 * `spawn` 带 `detached: true`,子进程因此是一个进程组的组长,`kill(-pid)` 打的是整组;
 * 而 bwrap 里的命令又跑在 `--new-session` 拉起的新会话里(所以组信号到不了它)——那一层由
 * `--die-with-parent`(PDEATHSIG)与 PID 命名空间的 init 死亡共同兜住:杀掉 bwrap 本身,
 * 内核把命名空间里的进程一起收走。先 SIGTERM 让正常退出,宽限期内没走就 SIGKILL,
 * 然后仍然等 `close`——不等就等于把回收交给运气。
 *
 * ── 这个钟只计**沙箱自身**的时间 ──
 * 它只杀挂起,不是 deadline(ADR-0029);而「服务调用不受单步约束,只受总墙钟约束」是同一句
 * 裁决的另一半。新协议下那一半由**位置**保住,不由停表保住:宿主服务是 `dispatch` 的一次调用,
 * 根本不经过 `sandbox.run`,所以沙箱这只钟从来不会把一次评测计进自己的账上。
 *
 * ── 这里只有一条管道对:stdin 关掉,stdout / stderr 各一路 ──
 *
 * `stdio` 曾经是四个 `"pipe"`:第 4 个是继承给沙箱里薄壳的 fd 3,一行请求进、一行响应出,
 * 对面是沙箱里 `bash` 手写的序列化。那条通道**已删除**(票 03):`check` / `evaluate` /
 * `finish` 不再是沙箱里的命令,而是模型发起的工具调用,由宿主分派(`agent/host`)。所以这一步
 * 只是「起一个 bwrap、收两路输出、墙钟到点杀整棵树」——没有第二个方向。
 *
 * ── 输出上限 ──
 * 采集有一个字节上限,理由与生成侧的截断口径(ADR-0032 的三条键级上限)无关:那是「模型该看到
 * 多少」,这是「宿主不该被一条 `cat` 打爆内存」。8 MiB 远高于三档截断上限,所以它永远不会
 * 改变模型看到的内容,只在模型写出病态输出时保住宿主。
 */

import { spawn } from "node:child_process";

import { bwrapArgv, type StepCommand, type StepLimits } from "./argv.js";
import { createBudgetClock, type BudgetClock } from "../budget-clock.js";

/** 一步的入参。 */
export type SandboxStepRequest = {
  /** 模型写的那段 shell 原文,整块交给 `bash -c`。 */
  readonly command: string;
  /** 这一步 bind 成 `/workspace` 的宿主目录。 */
  readonly workspaceDir: string;
  /** 入库 rootfs 的宿主路径。 */
  readonly rootfsDir: string;
  /** 单步墙钟上限(毫秒)。默认 `DEFAULT_STEP_WALL_CLOCK_MS`;超时即 `timedOut: true`。 */
  readonly wallClockMs?: number;
  /** 覆盖 bwrap 路径(测试 / 调试用)。 */
  readonly bwrapPath?: string;
  /** 覆盖单步额度。 */
  readonly limits?: StepLimits;
};

/** 一步的结果。**`timedOut` 与「命令非零退出」必须分得开**:前者的 `exitCode` 无意义。 */
export type SandboxStepResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
};

/** 宿主侧收集输出的字节上限(理由见头注)。 */
export const OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;

/** 单步墙钟默认值。真正的一步上限归会话级预算(票 07),这里是「一步不该跑过两分钟」。
 *
 * 取值是 harness 身份项(ADR-0029 的 `deadline.stepWallClockMs`),口径也是:它只计**沙箱
 * 自身执行**的时间,宿主服务在途时冻结(`agent/budget-clock.ts`)。改口径不改取值,所以 `harnessDigest`
 * 不动——它描述的是裁决后的语义,不是「有没有实现对」。
 */
export const DEFAULT_STEP_WALL_CLOCK_MS = 120_000;
/** SIGTERM 之后等多久升级到 SIGKILL。 */
export const KILL_GRACE_MS = 2_000;

/** 被墙钟杀掉时交回的退出码(借 `timeout(1)` 的口径,不冒充命令自己的退出码)。 */
export const TIMEOUT_EXIT_CODE = 124;

/**
 * 杀整棵进程树:先打进程组,再补那一枪打组长本身。
 *
 * 不用 `child.kill()`:`child.kill()` 只打 bwrap 那一个 pid,而「组里还有谁」是这一步的
 * 实现细节(见头注)。两条都试、失败都吞掉——进程可能已经死了,那不是错误。
 */
const killTree = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal);
  } catch {
    // 组已经不在了(或没有权限),下一枪打组长本身。
  }
  try {
    process.kill(pid, signal);
  } catch {
    // 已经退出:这是这条路径的正常结局。
  }
};

/** 一次输出采集:累积到上限为止,超出的字节丢弃(不截断、不抛错,只标一句)。 */
type Collector = {
  readonly push: (chunk: Buffer) => void;
  readonly text: () => string;
  readonly truncated: () => boolean;
};

const collector = (): Collector => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  return {
    push: (chunk) => {
      if (bytes >= OUTPUT_LIMIT_BYTES) {
        truncated = true;
        return;
      }
      const room = OUTPUT_LIMIT_BYTES - bytes;
      if (chunk.byteLength > room) {
        chunks.push(chunk.subarray(0, room));
        bytes += room;
        truncated = true;
        return;
      }
      chunks.push(chunk);
      bytes += chunk.byteLength;
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
    truncated: () => truncated,
  };
};

/**
 * 跑一步。
 *
 * `spawn` 失败(ENOENT 之类)是**基础设施失败**,不是「命令失败」:reject 出去,由调用方把它
 * 当会话级失败处理。命令自己的非零退出不是异常——它的退出码与两路输出原样交回。
 */
export const runStep = async (request: SandboxStepRequest): Promise<SandboxStepResult> => {
  const wallClockMs = request.wallClockMs ?? DEFAULT_STEP_WALL_CLOCK_MS;
  const command: StepCommand = {
    command: request.command,
    workspaceDir: request.workspaceDir,
    rootfsDir: request.rootfsDir,
    ...(request.limits === undefined ? {} : { limits: request.limits }),
  };

  const child = spawn(request.bwrapPath ?? "bwrap", [...bwrapArgv(command)], {
    // detached:子进程成为进程组组长,`kill(-pid)` 才打得到整组(见头注)。
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdout = collector();
  const stderr = collector();
  const stdoutPipe = child.stdout;
  const stderrPipe = child.stderr;
  if (stdoutPipe === null || stderrPipe === null) {
    // 不该发生:上面 stdio 里两路都写着 "pipe"。写出来是为了把「拿不到输出」变成一次明确的
    // 失败,而不是安静地交回空字符串——那种静默会让「模型什么都没说」与「宿主没收到」同形。
    killTree(child.pid ?? -1, "SIGKILL");
    throw new Error("沙箱执行器拿不到 stdout/stderr 管道(stdio 配置与 Node 的行为不符)");
  }
  stdoutPipe.on("data", (chunk: Buffer) => stdout.push(chunk));
  stderrPipe.on("data", (chunk: Buffer) => stderr.push(chunk));

  let timedOut = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  // ── 单步墙钟只计**沙箱自身执行**的时间 ──
  //
  // ADR-0029:「服务调用不受单步约束,只受总墙钟约束」。新世界里这条口径由**位置**保住:
  // 一次 `evaluate` 是宿主的 `dispatch` 调用,不经过 `runStep`,所以它根本不计进这只钟——
  // 旧世界的做法是「服务请求在途时把钟冻住」,那是为了同一件事花的一份实现代价,现在没了。
  const clock: BudgetClock = createBudgetClock({
    limitMs: wallClockMs,
    onExpire: () => {
      timedOut = true;
      killTree(child.pid ?? -1, "SIGTERM");
      escalation = setTimeout(() => killTree(child.pid ?? -1, "SIGKILL"), KILL_GRACE_MS);
    },
  });
  clock.start();

  return await new Promise<SandboxStepResult>((resolve, reject) => {
    child.on("error", (error: Error) => {
      clock.stop();
      if (escalation !== undefined) clearTimeout(escalation);
      reject(
        new Error(
          `沙箱执行器起不来(${request.bwrapPath ?? "bwrap"}):${error.message}。` +
            "这不是命令失败:preflight 应该先拦住它。",
        ),
      );
    });
    child.on("close", (code, signal) => {
      clock.stop();
      if (escalation !== undefined) clearTimeout(escalation);
      const settled = stdout.truncated() || stderr.truncated();
      const notes = settled
        ? `\n[sandbox] 两路输出超过 ${String(OUTPUT_LIMIT_BYTES)} 字节上限,其余字节被宿主侧丢弃。`
        : "";
      resolve({
        stdout: stdout.text(),
        stderr: stderr.text() + notes,
        // 被信号杀掉时 `code` 是 null:给一个不冒充命令退出码的值(见 `TIMEOUT_EXIT_CODE`)。
        exitCode: code ?? (timedOut ? TIMEOUT_EXIT_CODE : signal === null ? 1 : 137),
        timedOut,
      });
    });
  });
};
