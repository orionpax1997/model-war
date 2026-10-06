/**
 * `modelwar verify <replay.jsonl> [--root <仓库根>]` 的处理器(hld §9;NFR-2 的复算链)。
 *
 * ── 它做什么 ──
 *
 * 按 `dirname(replay)/input.json` **重新执行**这一局(与 `match` 同一套真沙箱组装),然后:
 *
 * 1. 核回放 meta 的执行方式、`quickjs-wasi` 版本、runtime hash 与三件套是否与本次执行一致——
 *    不一致即报错,**不静默换**(拿桩跑的读数当结论、拿旧 runtime 复算,都是这条要挡的);
 * 2. 逐 tick 比 `stateHash`:既核「每一行的 `stateHash` 等于它自己载荷的摘要」(改回放里一个
 *    数字即红),也核「本次重算的每一 tick hash 与存档逐项相同」;
 * 3. 比末行 `result`。
 *
 * ── 为什么不起子进程、退出码 ──
 *
 * `verify` 复用 `assemble` + `executeMatch`(引擎的 `runMatch`),不 spawn。
 * 比对结论一致为 0、不一致或用法/校验错为 1;重算时的引擎故障按其性质分码——未捕获异常 2、
 * 不确定超时 3(hld §9 的退出码表)。它是 CI 的入口,调用方只认退出码。
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  stateHashOf,
  type ReplayLine,
  type ReplayResultLine,
  type ReplayTickLine,
} from "@model-war/replay";

import { splitArgs } from "../args.js";
import {
  EXIT_ENGINE_FAULT,
  EXIT_NONDETERMINISTIC_TIMEOUT,
  EXIT_OK,
  EXIT_USAGE_OR_VALIDATION,
  reportFailure,
  type CommandFailure,
} from "../exit-codes.js";
import { assemble, executeMatch } from "../match/assemble.js";
import { validateReplayMetaLine } from "../validator.js";

const COMMAND = "modelwar verify";

/** 一条可比对的差异。全部收齐再一次报,而不是发现第一条就退——排障时「差了几处」是有用的。 */
const refuse = (message: string, details: readonly string[] = []): number => {
  reportFailure(COMMAND, { exitCode: EXIT_USAGE_OR_VALIDATION, message, details });
  return EXIT_USAGE_OR_VALIDATION;
};

const parseLines = (raw: string): readonly ReplayLine[] =>
  raw.split("\n").flatMap((text, at) => {
    if (text.trim() === "") {
      return [];
    }
    try {
      return [JSON.parse(text) as ReplayLine];
    } catch (cause) {
      throw new Error(
        `第 ${String(at + 1)} 行不是合法 JSON:` +
          `${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  });

/** 逐 tick 比:先核每一行自洽,再核与本次重算逐项相同。返回差异清单(空即一致)。 */
const compareTicks = (
  archived: readonly ReplayTickLine[],
  fresh: readonly ReplayTickLine[],
): readonly string[] => {
  const differences: string[] = [];
  for (const line of archived) {
    const { stateHash, ...payload } = line;
    const own = stateHashOf(payload);
    if (own !== stateHash) {
      differences.push(
        `tick ${String(line.tick)}:回放里记的 stateHash ${stateHash} 与它自己载荷的摘要 ${own} 不符`,
      );
    }
  }
  if (archived.length !== fresh.length) {
    differences.push(
      `tick 行数不一致:存档 ${String(archived.length)} 行,本次重算 ${String(fresh.length)} 行`,
    );
    return differences;
  }
  archived.forEach((line, index) => {
    const other = fresh[index];
    if (other !== undefined && line.stateHash !== other.stateHash) {
      differences.push(
        `tick ${String(line.tick)}:存档 stateHash ${line.stateHash} ≠ 本次 ${other.stateHash}`,
      );
    }
  });
  return differences;
};

const resultDifferences = (
  archived: ReplayResultLine,
  fresh: ReplayResultLine,
): readonly string[] =>
  JSON.stringify(archived) === JSON.stringify(fresh)
    ? []
    : [`末行 result 不一致:存档 ${JSON.stringify(archived)},本次 ${JSON.stringify(fresh)}`];

export const runVerifyCommand = async (args: readonly string[]): Promise<number> => {
  const { root: rootArg, positional } = splitArgs(args);
  const replayPath = positional[0];
  if (replayPath === undefined) {
    return refuse("用法:modelwar verify <replay.jsonl> [--root <仓库根>]");
  }
  const root = resolve(rootArg ?? process.cwd());

  // ── 读存档回放 ──
  let archivedLines: readonly ReplayLine[];
  try {
    archivedLines = parseLines(readFileSync(replayPath, "utf8"));
  } catch (cause) {
    return refuse(
      `读不了回放 ${replayPath}:${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const metaLine = archivedLines.find((line) => line.type === "meta");
  if (metaLine === undefined) {
    return refuse(`${replayPath} 的第一行不是 meta 行`);
  }
  const metaValidation = validateReplayMetaLine(metaLine);
  if (!metaValidation.ok) {
    return refuse("回放 meta 行未通过校验", metaValidation.modelDiagnostics);
  }
  const meta = metaValidation.meta;

  // ── 按 input.json 重新装载(与 match 同一套组装) ──
  const inputPath = join(dirname(resolve(replayPath)), "input.json");
  const assembled = assemble(inputPath, root);
  if (!assembled.ok) {
    return refuse(assembled.failure.message, assembled.failure.details);
  }
  const head = assembled.run.head;
  if (head.runner !== "quickjs") {
    // 组装层恒造真沙箱头;这里不是失败,而是本模块的前提被破坏——显式报出,不静默。
    return refuse("内部不一致:组装层交出的不是真沙箱的 meta 头");
  }

  // ── 核执行方式 / 版本 / hash / 三件套:不一致即报错,不静默换 ──
  const mismatches: string[] = [];
  if (meta.runner !== head.runner) {
    mismatches.push(`执行方式不一致:存档 ${meta.runner} ≠ 本次 ${head.runner}`);
  }
  const readings: readonly (readonly [string, string | null, string])[] = [
    ["quickjsWasiVersion", meta.quickjsWasiVersion, head.quickjsWasiVersion],
    ["sandboxRuntimeHash", meta.sandboxRuntimeHash, head.sandboxRuntimeHash],
    ["wasiClock", meta.wasiClock, head.wasiClock],
    ["wasiRandomFill", meta.wasiRandomFill, head.wasiRandomFill],
    ["wasiTimezoneOffset", meta.wasiTimezoneOffset, head.wasiTimezoneOffset],
  ];
  for (const [field, archived, expected] of readings) {
    if (archived !== expected) {
      mismatches.push(`${field} 不一致:存档 ${String(archived)} ≠ 本次 ${expected}`);
    }
  }
  if (mismatches.length > 0) {
    return refuse("回放 meta 与本次执行不一致(执行方式 / 版本 / hash / 三件套)", mismatches);
  }

  // ── 重新执行 ──
  let executed;
  try {
    executed = await executeMatch(assembled.run);
  } catch (cause) {
    const failure: CommandFailure = {
      exitCode: EXIT_ENGINE_FAULT,
      message: `引擎故障:${cause instanceof Error ? cause.stack : String(cause)}`,
    };
    reportFailure(COMMAND, failure);
    return failure.exitCode;
  }
  if (executed.status === "uncertain-timeout") {
    // 存档回放是「跑完的一局」,重算却硬超时——环境变了或引擎坏了。不静默换、也不当成比对差异:
    // 按全局退出码表的「不确定超时」轨(3),与 `match` 同一码。
    const failure: CommandFailure = {
      exitCode: EXIT_NONDETERMINISTIC_TIMEOUT,
      message: `重算遇到不确定超时(第 ${String(executed.tick)} tick)——存档回放本不应硬超时`,
    };
    reportFailure(COMMAND, failure);
    return failure.exitCode;
  }

  // ── 逐 tick 比对 + 末行 ——
  const archivedTicks = archivedLines.filter(
    (line): line is ReplayTickLine => line.type === "tick",
  );
  const freshTicks = executed.lines
    .map((line) => JSON.parse(line) as ReplayLine)
    .filter((line): line is ReplayTickLine => line.type === "tick");
  const archivedResult = archivedLines.findLast(
    (line): line is ReplayResultLine => line.type === "result",
  );
  if (archivedResult === undefined) {
    return refuse(`${replayPath} 没有末行 result`);
  }

  const differences = [
    ...compareTicks(archivedTicks, freshTicks),
    ...resultDifferences(archivedResult, executed.result),
  ];
  if (differences.length > 0) {
    return refuse(`回放与本次执行不一致(${String(differences.length)} 处)`, differences);
  }

  process.stdout.write(
    `modelwar verify: ${String(executed.tickCount)} tick 逐项一致,末行 result 一致(${executed.result.reason})\n`,
  );
  return EXIT_OK;
};
