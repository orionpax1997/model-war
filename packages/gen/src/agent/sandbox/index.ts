/**
 * 沙箱执行器的对外面:一个 `sandbox.run(...)`、一个 `sandbox.preflight(...)`。
 *
 * ── 交接缝(票 04 / 05 从这里接) ──
 * - `sandbox.run({ command, workspaceDir, requestHandler? })` → `{ stdout, stderr, exitCode, timedOut }`
 *   每步一次调用,每步一棵新进程树。工作区是**会话级**的(宿主持有、持久),沙箱实例是
 *   **步级**的(一步一个,不可复用)——连续性由工作区提供,不由沙箱提供。
 * - `requestHandler` 是薄壳—宿主通道(fd 3)的**唯一入口**:给了就按「一行进、一行出」把请求
 *   转给它。协议体在 `@model-war/schema` 的 `tool-channel.ts`,应答端是
 *   `agent/host` 的 `createSessionTools(...).requestHandler`;执行器只负责那条 fd 的开关。
 * - `sandbox.preflight()` 是启动自证:失败即抛,**不降级**到宿主进程。它的接线位置是**批入口**
 *   (`run.ts` 的 `runGeneration`,一批一次、在第一次模型调用之前):自证问的是「这台机器的
 *   内核能力够不够」,一批之内不会变,而每步重做只是把同一件事问 N 遍。
 *
 * ── 为什么默认 rootfs 路径从模块自身位置往上数 ──
 * rootfs 是入库产物,路径真源在 `@model-war/schema`(`SANDBOX_ROOTFS_DIR`,相对仓库根)。
 * 运行时不知道「仓库根」,但**知道自己在哪**:`packages/gen/{src,dist}/agent/sandbox/` 往上
 * 五层就是仓库根——源码形态与编译形态层数相同,所以两种跑法算出同一个根。需要别的根(测试、
 * 换个安装根)时显式传 `rootfsDir`。
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SANDBOX_ROOTFS_DIR } from "@model-war/schema";

import { runStep, type SandboxStepRequest, type SandboxStepResult } from "./execute.js";
import { assertSandboxReady, type PreflightOptions } from "./preflight.js";

export type { RequestHandler, SandboxStepRequest, SandboxStepResult } from "./execute.js";
export type { StepLimits } from "./argv.js";
export type { PreflightOptions } from "./preflight.js";
export {
  CHANNEL_FD,
  DEFAULT_STEP_WALL_CLOCK_MS,
  OUTPUT_LIMIT_BYTES,
  TIMEOUT_EXIT_CODE,
} from "./execute.js";
export { BWRAP_MIN_VERSION, preflightFailureMessage } from "./preflight.js";
export { LIMIT_FAILURE_EXIT_CODE, STEP_LIMITS } from "./argv.js";

/** 本模块所在的安装根(仓库根)。源码形态与编译形态层数相同,见头注。 */
const INSTALL_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

/** 入库 rootfs 的默认宿主路径:安装根 + schema 里的相对路径。 */
export const defaultRootfsDir = (installRoot: string = INSTALL_ROOT): string =>
  join(installRoot, SANDBOX_ROOTFS_DIR);

/** 这一步的入参;`rootfsDir` 可省略,省略时用 `defaultRootfsDir()`。 */
export type SandboxRunRequest = Omit<SandboxStepRequest, "rootfsDir"> & {
  readonly rootfsDir?: string;
};

/** preflight 的入参;同上,`rootfsDir` 可省略。 */
export type SandboxPreflightRequest = Omit<PreflightOptions, "rootfsDir"> & {
  readonly rootfsDir?: string;
};

/**
 * 执行器。两个方法,不暴露内部步骤:调用方只该知道「这一步跑完了没有、模型看到了什么」。
 */
export const sandbox = {
  /** 启动自证。失败抛 `Error`(文本里带三种已知成因)。 */
  preflight: (request: SandboxPreflightRequest = {}): { readonly version: string } =>
    assertSandboxReady({
      rootfsDir: request.rootfsDir ?? defaultRootfsDir(),
      ...(request.bwrapPath === undefined ? {} : { bwrapPath: request.bwrapPath }),
    }),

  /** 跑一步。命令自己的非零退出不是异常;起不来才是(reject)。 */
  run: async (request: SandboxRunRequest): Promise<SandboxStepResult> =>
    await runStep({
      ...request,
      rootfsDir: request.rootfsDir ?? defaultRootfsDir(),
    }),
} as const;
