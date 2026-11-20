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
 * 执行器是「跑一步 `bash`」,这个是「一次工具调用该找谁」。
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
    }
  | {
      /**
       * 驱动一次**工具调用**:直接问 `packages/gen/dist/agent/host` 的 dispatcher。
       *
       * 它不是「跑一步」:新协议里 `check` / `evaluate` / `finish` 根本不进沙箱,所以这条
       * 判据也不需要 bwrap——它证明的是「宿主分派对得上真服务」这一半(真 tsc + 真静态校验),
       * 沙箱那一半由 `run` 那几条判据证明。
       */
      readonly action: "dispatch";
      readonly workspaceDir: string;
      readonly tool: string;
      readonly argumentsJson: string;
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
      /** `action: "dispatch"` 交回的那份 `ToolOutcome`(原样,不做序列化)。 */
      readonly outcome?: {
        readonly exitCode: number;
        readonly stdout: string;
        readonly stderr: string;
        readonly isError?: boolean;
      };
    }
  | { readonly ok: false; readonly message: string };

/**
 * 子进程里的那段胶水。它只做三件事:读一行 JSON、调一个入口、写一行 JSON。
 *
 * 顶层 `await` 可用(`--input-type=module`)。任何异常都折成 `{ ok: false, message }`,
 * 让门禁读到的是「执行器说了什么」,而不是一段没有上下文的栈。
 *
 * 两条路:跑一步(`sandbox.run`)与问一次工具调用(`tools.dispatch`)。后者在这里造**真**的
 * 会话工具面(dispatcher + check 服务);它的 `evaluate` 接假计划与假试跑(真网格在 gen 侧验)。
 * 断言全在门禁那边,这段胶水只负责装配。
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
  } else if (request.action === "dispatch") {
    const host = await import(hostEntry);
    // ── 名字在这里是跨包的字面量,tsc 看不见 ──
    //
    // 这个桥接是靠动态 import 拼起来的:入口路径是算出来的,所以 gen 把
    // dispatch(step, call) 改名或改形时,这里不会报类型错——它只会在运行期变成
    // TypeError,而那条错会被读成「门禁自己坏了」。所以先确认拿到的是函数,不是祈祷。
    const dispatch = host.createSessionTools === undefined ? undefined : true;
    if (dispatch === undefined) {
      throw new Error("执行器桥接:host 入口没有交出 createSessionTools —— 装配入口改名了,这里要跟着改");
    }
    const tools = host.createSessionTools({
      workspaceDir: request.workspaceDir,
      deadlineAtMs: Date.now() + 600000,
      check: host.createCheckService({ root: repoRoot }),
      evaluate: host.createEvaluateService({
        root: repoRoot,
        model: "gate",
        runId: "gate",
        // 计划与试跑都是桩:这两条判据证明的是「工具调用 → 宿主分派 → 真服务」,
        // 真网格(计划搬运、32 场、观测)在 gen 侧的单测与 e2e 里验。
        plan: () => {
          throw new Error("gate 的分派判据不接真网格");
        },
        trial: () => ({ passed: true, stdout: "gate 假试跑" }),
      }),
    });
    if (typeof tools.dispatch !== "function") {
      throw new Error(
        "执行器桥接:createSessionTools 没有交出 dispatch —— 分派入口改名或改形了,这里要跟着改",
      );
    }
    const outcome = await tools.dispatch(1, {
      name: request.tool,
      argumentsJson: request.argumentsJson,
    });
    reply({ ok: true, outcome });
  } else {
    const started = performance.now();
    const result = await sandbox.run({
      command: request.command,
      workspaceDir: request.workspaceDir,
      rootfsDir: request.rootfsDir,
      wallClockMs: request.wallClockMs,
    });
    reply({ ok: true, ...result, wallClockMs: Math.round(performance.now() - started) });
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
