/**
 * 「假执行器」的接线:`sandbox` 被换成宿主 `bash`,通道仍然是真的。
 *
 * ── 为什么改 `sandbox.run` 而不是加一个 `executor` 注参 ──
 *
 * 生产路径上「怎么跑一步」只有一处(`sandbox.run`),加一个注参就是给它开第二条路,而那条只在
 * 测试里存在——那是最容易与真实路径分叉的东西。这里替掉的正是那一个调用点,不碰任何别的东西:
 * 宿主分派、两个服务、编译、校验、落档全部还是真实现。
 *
 * ── 它只替 `bash` 那一条路 ──
 *
 * `check` / `evaluate` / `finish` 根本不经过 `sandbox.run`(它们是 `tools.dispatch` 的调用),
 * 所以这层替身不需要认工具名,也不可能有「工具名被当成命令跑」那种错位——那正是旧版里
 * `TOOL_COMMANDS` 那张表存在的理由,现在它连同 fd 通道一起消失了(票 03)。
 *
 * ── 为什么这层替身能让「沙箱」与「内核能力」解耦 ──
 *
 * 真 `bwrap` 要非特权 user namespace,而常跑链(unit)不装它——那不是被测行为,是环境账。
 * 假执行器把这一层换掉,于是「动作 → 观测 → 候选 → 档案」这条链在常跑链上仍然全真,只有
 * 隔离本身是假的。真隔离由命名脚本 `verify:kernel` 那一侧验(`apps/cli/src/
 * agent-real-session.test.ts`)。
 *
 * ── 两个出口 ──
 *
 * - `withHostBash(handler)`:这一步要跑什么由调用方给(可以什么都不跑,只回固定观测);
 * - `withRealBash(workspaceDir)`:在宿主 `/bin/bash` 里真跑那块命令,并把 `/workspace` 前缀
 *   改写成临时工作区(模型写的路径是**沙箱视角**的,宿主上不成立)。
 *
 * 两者都把 `preflight` 一起换掉:真的自证要跑 bwrap,而这层替身的意思就是「不依赖内核能力」。
 * 「整批入口真的调过 preflight、失败即整批失败」由 `run.test.ts` 的注入失败用例验。
 */

import { spawnSync } from "node:child_process";

import type { AgentExecResult } from "./types.js";

/** 一次 `sandbox.run` 的替身:入参只要这两格,返回值只要四格。 */
export type SandboxRun = (request: {
  readonly command: string;
  readonly workspaceDir: string;
}) => Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>;

/**
 * 把 `sandbox` 整个换成假执行器(`run` + `preflight`),`finally` 里原样还回去。
 *
 * 它只收到 `bash` 那一条命令串:`check` / `evaluate` / `finish` 是宿主分派的工具调用,
 * 不到这一层来(旧版这里有一张「哪些命令是薄壳」的表,票 03 连它一起删了)。
 */
export const withHostBash = async <T>(
  handler: (command: string) => AgentExecResult | Promise<AgentExecResult>,
  run: () => Promise<T>,
): Promise<T> => {
  const mod = await import("./sandbox/index.js");
  const original = { run: mod.sandbox.run, preflight: mod.sandbox.preflight };
  const define = (key: "run" | "preflight", value: unknown): void => {
    Object.defineProperty(mod.sandbox, key, { configurable: true, writable: true, value });
  };
  define("preflight", () => ({ version: "test" }));
  define("run", async (request: Parameters<SandboxRun>[0]) => {
    const result = await handler(request.command);
    return { ...result, timedOut: result.timedOut ?? false };
  });
  try {
    return await run();
  } finally {
    define("preflight", original.preflight);
    define("run", original.run);
  }
};

/**
 * 在宿主 `bash` 里真跑那一块命令,并把 `/workspace` 映射到那个临时目录。
 *
 * ── 为什么要把 `/workspace` 换掉 ──
 *
 * 模型写的命令里是**沙箱视角**的绝对路径(`cat > /workspace/script.ts`)。真 bwrap 把工作区
 * bind 成 `/workspace`,所以那条路径在沙箱里成立;宿主上不成立。这里把前缀改写成真实路径再跑,
 * 于是「模型写的命令」与「工作区里真的出现了什么」这两件事在测试里也连得起来。
 *
 * 改写只换 `/workspace` 这个前缀,不动命令的其余字节——包括 heredoc 与管道。
 */
export const withRealBash = async <T>(workspaceDir: string, run: () => Promise<T>): Promise<T> =>
  await withHostBash((command) => {
    const executed = spawnSync(
      "/bin/bash",
      ["-c", command.replaceAll("/workspace", workspaceDir)],
      {
        cwd: workspaceDir,
        encoding: "utf8",
      },
    );
    return {
      stdout: executed.stdout,
      stderr: executed.stderr,
      exitCode: executed.status ?? 1,
    };
  }, run);
