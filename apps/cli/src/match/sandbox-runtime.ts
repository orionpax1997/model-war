/**
 * 沙箱 runtime 的**实测哈希**:01 票那条 `sandboxRuntimeHash` 判据要比的就是这个值。
 *
 * ── 现在为什么是桩的一个固定摘要 ──
 *
 * `sandboxRuntimeHash` 的本义是「同一个脚本换一副沙箱跑,结果不保证一致(FR-3)」——它是
 * **真沙箱**那副 runtime(QuickJS + WASI 产物)的 sha256。而沙箱执行器在本仓尚未落地(它是
 * `packages/runner` 那一格的后续),仓库里**没有**那份 runtime 产物可哈希。
 *
 * 桩这一格(空转对局)有两条路:跳过这条判据,或给它一个**确定的、双方共用的**桩值。
 * 选后者:跳过会让 01 票那条判据在 match 这条路上**形同虚设**(meta 里随便写一个哈希都能过),
 * 而两条路都要由「谁在跑」这个事实决定,于是**判据本身**在桩与真沙箱之间保持同一份实现:
 * 同一份 meta 在桩下要匹配桩值、在真沙箱下要匹配真值,判据代码一行不改。
 *
 * **这不是一个可以一直凑合的值**:沙箱执行器落地时,本函数改成对那份产物求 sha256,
 * 届时 01 票那条判据自动从「比桩值」切到「比真值」,而 match 的装载期一行不用改。
 * 桩值取**模块路径 + 版本常量**的 sha256:它随本仓规则集版本而变,于是「换一个规则集版本的
 * 存档拿过来跑」这件事在桩下就已经会红,而不是等到真沙箱。
 */

import { createHash } from "node:crypto";

import { RULESET_VERSION } from "@model-war/schema";

/**
 * 桩执行器那一副 runtime 的摘要。取「模块标识 + 规则集版本」的 sha256:它是确定的
 * (两侧算出同一个值),且随规则集版本变化(版本错配时立刻红)。
 */
export const stubSandboxRuntimeHash = (): string =>
  createHash("sha256").update(`stub-runner/${RULESET_VERSION}`).digest("hex");

/**
 * 实测的 sandbox-runtime 哈希。**真沙箱落地后**,本函数改为对 runtime 产物求 sha256;
 * 装载期的调用点与 01 票那条判据都不动。
 */
export const measureSandboxRuntimeHash = (): string => stubSandboxRuntimeHash();
