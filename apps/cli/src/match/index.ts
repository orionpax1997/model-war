/**
 * `modelwar match <input.json> [--root <仓库根>]` 的处理器:装载 → 校验 → 真沙箱跑一局 → 写回放 → 映射退出码。
 *
 * ── 为什么这一格在 `apps/cli` 而不在 engine ──
 *
 * 磁盘 I/O(hld §2.2.8)与 ajv 校验(那**唯一**一个实例)都在这一侧。engine 的 `runMatch` 是纯函数:
 * 吃已装载的世界、吐回放行。所以「装载期拒跑(退出码 1)」与「跑起来(0/2)」的分界正好落在
 * `assemble()` 的边界上——它之前的一切都是装载期。
 *
 * ── `match` 就是「每对局一个子进程」的子进程本身 ──
 *
 * 纯函数式入口:读一份物化输入 → 写产物。本票不做 spawn、不做进程池(那是调度节点的账)。
 * `match` **默认走真沙箱**,桩路径只作测试入口,不进 CLI 公开面(它由引擎单测覆盖)。
 *
 * ── 退出码表(全局,写进 hld §9) ──
 *
 * - `0`:产出了一份合法 `result` 行。**胜/负/超时/四方全淘汰/席位异常出局/经济死亡全都是 0**——
 *   gdd 的异常与出局机制意味着一份**完全正常**的对局可以带着异常出局的席位;给它非零码会让
 *   赛季按 hld §8.4 的崩溃条款重跑并剔除,让合法对局从报告里消失。
 * - `1`:用法错或装载期拒跑(缺参、读不到文件、输入/存档/地图/规则集未过校验、沙箱字节读不到)。
 * - `2`:引擎自身故障(未捕获异常、确定性断言失败、WASM trap)。
 * - `3`:不确定超时(墙钟硬超时;机制归票 07/09,这里把码位定下来)。
 * - `4`:其它内部错(如回放写盘失败)。
 *
 * 细节另在 stderr 给一行 JSON(见 `reportFailure`),调度器只认退出码。
 *
 * ── 为什么规则集版本三处一致在这里判,不在 engine ──
 *
 * hld §7.1 自陈「被校验过不等于被装载时校验过」:`rulesets/vN.json` 的文件名与 `docs/rules-vN/`
 * 的目录名都要读盘才知道,engine 拿不到这两个名字。错配即拒(FR-10 AC2),不静默降级。
 */

import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { splitArgs } from "../args.js";
import {
  EXIT_ENGINE_FAULT,
  EXIT_INTERNAL,
  EXIT_OK,
  EXIT_USAGE_OR_VALIDATION,
  reportFailure,
  type CommandFailure,
} from "../exit-codes.js";
import { assemble, executeMatch } from "./assemble.js";

export const runMatchCommand = async (args: readonly string[]): Promise<number> => {
  const { root: rootArg, positional } = splitArgs(args);
  const inputPath = positional[0];
  if (inputPath === undefined) {
    const failure: CommandFailure = {
      exitCode: EXIT_USAGE_OR_VALIDATION,
      message: "用法:modelwar match <input.json> [--root <仓库根>]",
    };
    reportFailure("modelwar match", failure);
    return failure.exitCode;
  }
  const root = resolve(rootArg ?? process.cwd());

  const assembled = assemble(inputPath, root);
  if (!assembled.ok) {
    reportFailure("modelwar match", assembled.failure);
    return assembled.failure.exitCode;
  }

  // ── 跑一局(真沙箱) ──
  let executed;
  try {
    executed = await executeMatch(assembled.run);
  } catch (cause) {
    // 走到这里的是**引擎自身故障**(未捕获异常/确定性断言失败/WASM trap),不是装载期拒跑——
    // 装载期的每一条都在 `assemble()` 里显式返回了。
    const failure: CommandFailure = {
      exitCode: EXIT_ENGINE_FAULT,
      message: `引擎故障:${cause instanceof Error ? cause.stack : String(cause)}`,
    };
    reportFailure("modelwar match", failure);
    return failure.exitCode;
  }

  // ── 写回放 ──
  // 回放与输入物化件同目录(hld §7.5 的拓扑:`matches/<...>/replay.jsonl`)。
  const replayPath = join(dirname(resolve(inputPath)), "replay.jsonl");
  try {
    writeFileSync(replayPath, `${executed.lines.join("\n")}\n`);
  } catch (cause) {
    const failure: CommandFailure = {
      exitCode: EXIT_INTERNAL,
      message: `回放写盘失败 ${replayPath}:${cause instanceof Error ? cause.message : String(cause)}`,
    };
    reportFailure("modelwar match", failure);
    return failure.exitCode;
  }
  process.stdout.write(
    `modelwar match: ${String(executed.tickCount)} tick 已结算,` +
      `回放写入 ${replayPath}(runner=quickjs,${executed.result.reason})\n`,
  );
  return EXIT_OK;
};
