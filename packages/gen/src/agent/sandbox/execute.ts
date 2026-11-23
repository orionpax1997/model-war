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
 * 裁决的另一半。所以宿主服务请求在途时它冻结(`agent/budget-clock.ts`):那段时间这一步只是在等一行
 * 响应,不是在跑。
 *
 * ── fd 3:宿主与薄壳之间唯一的通道 ──
 * `stdio` 的第 4 项给 `"pipe"`,POSIX 上 Node 为它建的是 **socketpair**,所以那是一个**双向**
 * fd:薄壳往里写一行请求,也从那读一行响应。宿主这一端只在宿主进程里(`child.stdio[3]`),
 * 跨步读不到;每一步一对新管道。**协议体的字段集不在这里**:它落在 `@model-war/schema` 的
 * 协议模块(`tool-channel.ts`)里;本模块只提供传输(一行进、一行出)与那个 `requestHandler`
 * 缝——接上它的是宿主侧 dispatcher(`agent/host`),沙箱那一侧永远只看得到一行 JSON。
 *
 * ── 输出上限 ──
 * 采集有一个字节上限,理由与生成侧的截断口径(ADR-0032 的三条键级上限)无关:那是「模型该看到
 * 多少」,这是「宿主不该被一条 `cat` 打爆内存」。8 MiB 远高于三档截断上限,所以它永远不会
 * 改变模型看到的内容,只在模型写出病态输出时保住宿主。
 */

import { spawn } from "node:child_process";

import { TOOL_CHANNEL_FD } from "@model-war/schema";

import { bwrapArgv, type StepCommand, type StepLimits } from "./argv.js";
import { createBudgetClock, type BudgetClock } from "../budget-clock.js";

/** 宿主侧收请求的那一端。一行请求进,一行响应出。 */
export type RequestHandler = (requestLine: string) => string | Promise<string>;

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
  /**
   * 通道的宿主侧服务:一行请求进、一行响应出。
   *
   * 生产实现是 `createSessionTools(...).requestHandler`(`agent/host`,带白名单、`evaluate`
   * 配额与会话墙钟)。给了就按行转发;不给则 fd 3 照样打开(薄壳据此判断通道在不在),但宿主
   * 不读不写——那一步里任何受限工具都会以「工具不可用」退出 2。
   */
  readonly requestHandler?: RequestHandler;
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
 * 通道用的 fd 序号。真源是 `@model-war/schema` 的 `TOOL_CHANNEL_FD`(薄壳与协议体同一份);
 * 这里只是给执行器一个本地名字,别在两处各写一个 `3`。
 */
export const CHANNEL_FD = TOOL_CHANNEL_FD;

/** `child.stdio[3]` 的类型太宽;只认「既能读又能写」的那种,不猜。 */
type DuplexChannel = {
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  write(chunk: string): boolean;
  destroy(): void;
};

const isDuplexChannel = (stream: unknown): stream is DuplexChannel =>
  typeof stream === "object" &&
  stream !== null &&
  "on" in stream &&
  "write" in stream &&
  "destroy" in stream &&
  typeof (stream as { write?: unknown }).write === "function";

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
    stdio: ["ignore", "pipe", "pipe", "pipe"],
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
  // ADR-0029:「服务调用不受单步约束,只受总墙钟约束」。这一步阻塞在宿主服务上(`evaluate`
  // 要跑一整张网格)的那段时间在通道里冻结、回包后续上。不冻的后果不是慢,而是错杀一次真
  // 评测:观测原料与网格汇总已经落盘,而这一步以 `timedOut` 收场,会话留下半个提交。
  const clock: BudgetClock = createBudgetClock({
    limitMs: wallClockMs,
    onExpire: () => {
      timedOut = true;
      killTree(child.pid ?? -1, "SIGTERM");
      escalation = setTimeout(() => killTree(child.pid ?? -1, "SIGKILL"), KILL_GRACE_MS);
    },
  });
  clock.start();

  const channel = child.stdio[CHANNEL_FD];
  const stopChannel = wireChannel(channel, request.requestHandler, clock);

  return await new Promise<SandboxStepResult>((resolve, reject) => {
    child.on("error", (error: Error) => {
      clock.stop();
      if (escalation !== undefined) clearTimeout(escalation);
      stopChannel();
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
      stopChannel();
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

/**
 * 把 fd 3 接上(或不接)。返回一个收尾函数:无论成败都要关掉,否则宿主这边留着一个半开的
 * socket,进程退出后才被回收。
 *
 * 一行进、一行出;按到达顺序**串行**处理(响应要按序回给同一端)。请求行按 `\n` 切,
 * 多字节字符不会被切断(Buffer 上切,切完再解码)。
 *
 * 服务请求**在途**期间把单步墙钟冻结(`clock.pause` / `resume`):那段时间里这一步只是在等一行
 * 响应,不是沙箱在跑(ADR-0029「服务调用不受单步约束」)。
 */
const wireChannel = (
  stream: unknown,
  handler: RequestHandler | undefined,
  clock: BudgetClock,
): (() => void) => {
  if (!isDuplexChannel(stream)) {
    return () => {
      // 没有通道可接:这一步的薄壳会以「工具不可用」退出 2,那是设计好的行为。
    };
  }
  if (handler === undefined) {
    // 通道开着、宿主不读:那一步里的薄壳会以「工具不可用」退出 2(那是设计好的行为)。
    return () => {
      stream.destroy();
    };
  }

  let pending = Buffer.alloc(0);
  let queue: Promise<void> = Promise.resolve();

  const respond = (line: string): void => {
    queue = queue.then(async () => {
      clock.pause();
      try {
        const response = await handler(line);
        stream.write(`${response}\n`);
      } catch {
        // 服务自己保证「永远回一行」(`agent/host` 的 dispatcher 把异常折成伪造响应);
        // 真漏到这里也只丢一条响应,由薄壳变成「脚本工具不可用」,传输层不发明一套语义。
      } finally {
        clock.resume();
      }
    });
  };

  stream.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const newline = pending.indexOf(0x0a);
      if (newline < 0) break;
      const line = pending.subarray(0, newline).toString("utf8");
      pending = pending.subarray(newline + 1);
      if (line !== "") respond(line);
    }
  });
  // 通道断开不是这一步的失败:模型可能没调用任何薄壳。
  stream.on("error", () => {
    // 忽略:另一端关了。
  });

  return () => {
    stream.destroy();
  };
};
