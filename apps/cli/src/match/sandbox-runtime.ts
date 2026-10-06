/**
 * 沙箱 runtime 的**实测哈希**:01 票那条 `sandboxRuntimeHash` 判据要比的就是这个值。
 *
 * ── 它现在是什么 ──
 *
 * 沙箱执行器已落地(票 03),runtime bundle 也已成形并入库(票 04):产物是
 * `packages/engine/sandbox-runtime/runtime.iife.js`(路径真源在 `@model-war/schema` 的
 * `SANDBOX_RUNTIME_ARTIFACT_PATH`),它的字节 sha256 就是真源包里的 `SANDBOX_RUNTIME_HASH`,
 * 也就是回放 meta 那一栏 `sandboxRuntimeHash` 的**唯一真源**。
 *
 * 判据因此从「比桩值」切到「比真值」,而 `match` 的装载期调用点一行不用改。
 *
 * ── 为什么 `measureSandboxRuntimeHash()` 返回常量而不是当场读盘 ──
 *
 * 常量与入库产物字节的一致性由**门禁**担保(`check:runtime` 比「现算 == 入库」「入库 hash ==
 * 常量」两段,见 `packages/tools/src/sandbox-runtime/run-runtime-drift-gate.ts`)。CLI 打包后
 * 不持有仓库根的可靠锚点(`import.meta.url` 会指到 `dist/`),当场读盘反而会把「判据锚定确切
 * 字节」这件事换成「判据锚定运行目录」——那是本票要消灭的漂移。读盘入口留给需要**逐字节核对**
 * 的调用方(门禁与 VM 载入测试),它们都从仓库根出发。
 *
 * ── 桩值为什么必须消失 ──
 *
 * 旧实现取 `sha256("stub-runner/" + RULESET_VERSION)`——一个与任何真实字节都无关的假值。
 * 它在桩下能骗过判据,在真沙箱下会与产物 hash 不符。真源已由产物给出,那条路就此删除。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SANDBOX_RUNTIME_ARTIFACT_PATH, SANDBOX_RUNTIME_HASH } from "@model-war/schema";

/** 入库 runtime bundle 产物的字节 sha256,即 `sandboxRuntimeHash` 的真值(真源见 `@model-war/schema`)。 */
export const measureSandboxRuntimeHash = (): string => SANDBOX_RUNTIME_HASH;

/**
 * 从仓库根读入库产物的字节。供需要**逐字节核对**的调用方(门禁 / VM 载入测试)使用;
 * 判据侧走 `measureSandboxRuntimeHash()` 的常量,理由见文件头注。
 */
export const readSandboxRuntimeBytes = (root: string): Buffer =>
  readFileSync(join(root, SANDBOX_RUNTIME_ARTIFACT_PATH));

/** 入库产物字节的 sha256(现算)。与 `measureSandboxRuntimeHash()` 比对即为「常量 == 产物」的核对。 */
export const sandboxRuntimeHashOf = (root: string): string =>
  createHash("sha256").update(readSandboxRuntimeBytes(root)).digest("hex");
