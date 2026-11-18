/**
 * 门禁驱动生产执行器的**那一条缝**:把「沙箱跑一步」变成一次子进程 + 一份 JSON。
 *
 * ── 为什么是子进程,不是 import ──
 * 执行器住在 `packages/gen`(它是生成侧的生产代码),而门禁住在 `packages/tools`;hld §3.2 的
 * 包图规定工具包只允许 import 真源包 `@model-war/schema`,tools → gen 这条边不合法。所以门禁
 * **把执行器当黑盒驱动**:起一个子进程,让它 `await import(<gen 的 dist 入口>)`,从 stdin 读一份
 * JSON 请求、往 stdout 写一份 JSON 结果。
 *
 * ── 为什么适配脚本是一段字符串,而不是仓里另一个 .ts ──
 * 如果适配脚本落在 `packages/tools/src` 下并 `import "@model-war/gen"`,`check:declared-deps`
 * 会(正确地)判它未声明依赖;而给 tools 加一条指向 gen 的依赖是把包图反过来。所以它是一段
 * **通用胶水**(跑一个动作、把结果写成 JSON),写在字符串里随子进程一起过去:断言全在门禁这边,
 * 执行器那边一行判据也没有。`import(<变量>)` 里没有说明符字面量,因此也不构成一条待声明的依赖。
 *
 * ── 为什么不让门禁自己拼 bwrap 参数 ──
 * 那样「门禁验证的沙箱」与「模型实际跑的沙箱」是两个东西,参数一改就悄悄分叉。这一层要证明的
 * 是**生产执行器**在这台机器上的行为,所以它必须驱动生产代码本身。
 */

import { spawn } from "node:child_process";
import { join } from "node:path";

/** 执行器的编译形态入口(相对仓库根)。`check:sandbox` 的命名脚本先 `pnpm run build`。 */
export const EXECUTOR_ENTRY = "packages/gen/dist/agent/sandbox/index.js";

/**
 * 宿主侧工具服务的编译形态入口(相对仓库根)。与执行器同一个包、同一棵树的两个位置:
 * 执行器是「跑一步」,这个是「这一步里的薄壳该找谁」。
 */
export const HOST_ENTRY = "packages/gen/dist/agent/host/index.js";

/** 一次驱动请求。`action` 只有两种:自证与跑一步。 */
export type BridgeRequest =
  | { readonly action: "preflight"; readonly rootfsDir: string }
  | {
      readonly action: "run";
      readonly rootfsDir: string;
      readonly workspaceDir: string;
      readonly command: string;
      readonly wallClockMs: number;
      /**
       * 通道的宿主侧要从「不接」、「回显」还是「接真的工具服务」:
       *
       * - `none`:fd 3 不开;
       * - `echo`:回显收到的每一行——只证明 fd 3 **开得出来、关得掉**;
       * - `tools`:接 `packages/gen/dist/agent/host` 的真 dispatcher(真 `check` 服务)。
       *   这条是「薄壳 → fd → 宿主服务」整条链的唯一真跑路径。
       */
      readonly channel: "none" | "echo" | "tools";
    };

/** 一次驱动结果。`ok: false` 时 `message` 是执行器抛出来的那段文本(自证失败就是它)。 */
export type BridgeReply =
  | {
      readonly ok: true;
      readonly version?: string;
      readonly stdout?: string;
      readonly stderr?: string;
      readonly exitCode?: number;
      readonly timedOut?: boolean;
      readonly wallClockMs?: number;
      readonly channelRequests?: readonly string[];
    }
  | { readonly ok: false; readonly message: string };

/**
 * 子进程里的那段胶水。它只做三件事:读一行 JSON、调执行器、写一行 JSON。
 *
 * 顶层 `await` 可用(`--input-type=module`)。任何异常都折成 `{ ok: false, message }`,
 * 让门禁读到的是「执行器说了什么」,而不是一段没有上下文的栈。
 *
 * `channel: "tools"` 那一路在这里造**真**的会话工具面(dispatcher + check 服务);它的
 * `evaluate` 接假计划与假试跑(真网格在 gen 侧验)。断言全在门禁那边，这段胶水只负责装配。
 */
export const EXECUTOR_ADAPTER = `
const entry = process.argv[1];
const hostEntry = process.argv[2];
const repoRoot = process.argv[3];
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const reply = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
try {
  const request = JSON.parse(input);
  const { sandbox } = await import(entry);
  if (request.action === "preflight") {
    reply({ ok: true, version: sandbox.preflight({ rootfsDir: request.rootfsDir }).version });
  } else {
    const received = [];
    let requestHandler;
    if (request.channel === "echo") {
      requestHandler = (line) => { received.push(line); return line; };
    } else if (request.channel === "tools") {
      const host = await import(hostEntry);
      const tools = host.createSessionTools({
        workspaceDir: request.workspaceDir,
        deadlineAtMs: Date.now() + 600000,
        check: host.createCheckService({ root: repoRoot }),
        evaluate: host.createEvaluateService({
          root: repoRoot,
          model: "gate",
          runId: "gate",
          // 计划与试跑都是桩：这条通道判据证明的是「薄壳 → fd → 宿主服务」，
          // 真网格（计划搬运、32 场、观测）在 gen 侧的单测与 e2e 里验。
          plan: () => {
            throw new Error("gate 通道判据不接真网格");
          },
          trial: () => ({ passed: true, stdout: "gate 假试跑" }),
        }),
      });
      requestHandler = (line) => { received.push(line); return tools.requestHandler(line); };
    }
    const started = performance.now();
    const result = await sandbox.run({
      command: request.command,
      workspaceDir: request.workspaceDir,
      rootfsDir: request.rootfsDir,
      wallClockMs: request.wallClockMs,
      ...(requestHandler === undefined ? {} : { requestHandler }),
    });
    reply({ ok: true, ...result, channelRequests: received, wallClockMs: Math.round(performance.now() - started) });
  }
} catch (error) {
  reply({ ok: false, message: error instanceof Error ? error.message : String(error) });
}
`;

/**
 * 驱动一次。异步(`spawn` 而不是 `spawnSync`):门禁要在这一步**正在跑**的时候去宿主 `/proc`
 * 里找那个探针进程(正对照),同步调用会把观察者一起阻塞住。
 *
 * `timeoutMs` 是这道缝自己的保险丝:执行器挂住时门禁要红,不能跟着挂住。
 */
export const driveExecutor = async (
  repoRoot: string,
  request: BridgeRequest,
  timeoutMs = 120_000,
): Promise<BridgeReply> => {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      EXECUTOR_ADAPTER,
      join(repoRoot, EXECUTOR_ENTRY),
      join(repoRoot, HOST_ENTRY),
      repoRoot,
    ],
    { cwd: repoRoot },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(JSON.stringify(request));

  const killed = { value: false };
  const fuse = setTimeout(() => {
    killed.value = true;
    child.kill("SIGKILL");
  }, timeoutMs);

  const status = await new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
    child.on("error", () => resolve(null));
  });
  clearTimeout(fuse);

  if (killed.value) {
    return { ok: false, message: `驱动执行器的子进程超过 ${String(timeoutMs)} ms 没有返回` };
  }
  const line = Buffer.concat(stdout).toString("utf8").trim().split("\n").at(-1) ?? "";
  if (line === "") {
    return {
      ok: false,
      message:
        `驱动执行器的子进程没有交回结果(退出码 ${String(status)}):` +
        `${Buffer.concat(stderr).toString("utf8").trim()}`,
    };
  }
  try {
    return JSON.parse(line) as BridgeReply;
  } catch {
    return { ok: false, message: `驱动执行器的子进程交回的不是 JSON:${line}` };
  }
};
