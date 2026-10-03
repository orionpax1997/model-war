/**
 * 参赛脚本静态校验器的入口:校验一份**编译后的产物文件**,打印面向模型的文本,按结果设退出码。
 *
 * ```
 * node packages/tools/src/validate/run-validate-script.ts <产物文件> --max-bytes <N> --phase <iteration|freeze>
 * ```
 *
 * ── 为什么是子进程 + 退出码 ──────────────────────────────────────────────────
 * 生成管线以子进程调它,拿退出码与标准输出——**这两个就是本工具对外的全部契约**。
 * 候选里它最省事也最一致:直接 import 这个包不可行(它以源码形态由 Node 的类型擦除执行,
 * 入口指向源码,会把它的源码并进生成管线的 program);新增 CLI 子命令会把一个内部校验动作
 * 塞进唯一用户面。理由与实测见 spec《调用的形状:子进程 + 退出码》。
 * 因此**没有 `--json`**:结构化违规数组是库层的导出(`index.ts`),生成管线只读退出码与 stdout。
 *
 * ── 退出码 ──────────────────────────────────────────────────────────────────
 * 0 = 放行(含「只有提示」的情形),1 = 有拦截项、参数不对、文件读不到、或工具自身失效。
 * 不区分多种失败:调用方只需要知道「能不能进下一轮」。
 *
 * ── 两路输出 ────────────────────────────────────────────────────────────────
 * **stdout 是面向模型层的文本**,一个字节都不掺别的:生成管线把它原样转给参赛脚本的作者。
 * 用法说明与文件读失败走 stderr——那两类是**给调用方的**,转给模型只会浪费迭代预算。
 *
 * ── `--max-bytes` 必填,校验器不给默认值 ────────────────────────────────────
 * 取值在规则集文件里,那是生成管线(E)的交付物,现在不存在。写一个默认值就是给一个未定值编答案,
 * 所以缺参数按失败处理(退出码 1 + 用法),而不是悄悄拿某个数顶上。
 */

import { readFileSync } from "node:fs";

import { validateScriptSource } from "./pipeline.ts";
import { renderViolations } from "./render-violations.ts";
import type { ScriptLintPhase } from "../rules/script-lint.ts";

const USAGE =
  "用法:node packages/tools/src/validate/run-validate-script.ts <产物文件> --max-bytes <N> --phase <iteration|freeze>";

type Options =
  | {
      readonly ok: true;
      readonly file: string;
      readonly maxBytes: number;
      readonly phase: ScriptLintPhase;
    }
  | { readonly ok: false; readonly reason: string };

const PHASES: readonly ScriptLintPhase[] = ["iteration", "freeze"];

/**
 * 解析命令行。纯函数,不碰文件系统。
 *
 * 参数表**没有默认值**:没给的 `--max-bytes` 与 `--phase` 都是失败而不是「不查」——
 * 一条校验命令若能在缺参数时照样返回 0,调用方就会把「没查」误读成「通过」。
 */
const parseArgs = (argv: readonly string[]): Options => {
  let file: string | undefined;
  let maxBytes: number | undefined;
  let phase: ScriptLintPhase | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--max-bytes" || arg === "--phase") {
      const value = argv[index + 1];
      index += 1;
      if (value === undefined) {
        return { ok: false, reason: `${arg} 缺值。` };
      }
      if (arg === "--max-bytes") {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 0) {
          return { ok: false, reason: `--max-bytes 必须是非负整数,收到 "${value}"。` };
        }
        maxBytes = parsed;
      } else if (PHASES.includes(value as ScriptLintPhase)) {
        phase = value as ScriptLintPhase;
      } else {
        return { ok: false, reason: `--phase 只能是 iteration 或 freeze,收到 "${value}"。` };
      }
      continue;
    }
    if (arg.startsWith("--")) {
      return { ok: false, reason: `未知参数 ${arg}。` };
    }
    if (file !== undefined) {
      return { ok: false, reason: `只接受一个产物文件,收到第二个: ${arg}。` };
    }
    file = arg;
  }

  if (file === undefined) {
    return { ok: false, reason: "缺少产物文件参数。" };
  }
  if (maxBytes === undefined) {
    return { ok: false, reason: "缺少必填参数 --max-bytes(校验器不给默认值)。" };
  }
  if (phase === undefined) {
    return { ok: false, reason: "缺少必填参数 --phase(iteration 或 freeze)。" };
  }
  return { ok: true, file, maxBytes, phase };
};

const main = (argv: readonly string[]): number => {
  const options = parseArgs(argv);
  if (!options.ok) {
    process.stderr.write(`${options.reason}\n${USAGE}\n`);
    return 1;
  }

  // 读字节而不是读字符串:体积规则量的是产物的字节数,「解码成字符串再按 UTF-8 算回去」
  // 在产物不是合法 UTF-8 时会算出另一个数(替换字符占 3 字节)。字节数由这里交给判定链。
  let bytes: Buffer;
  try {
    bytes = readFileSync(options.file);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`读不到产物文件 ${options.file}:${reason}\n`);
    return 1;
  }

  const violations = validateScriptSource(bytes.toString("utf8"), {
    maxBytes: options.maxBytes,
    phase: options.phase,
    byteLength: bytes.byteLength,
  });
  process.stdout.write(renderViolations(violations));

  return violations.some((violation) => violation.blocking) ? 1 : 0;
};

process.exitCode = main(process.argv.slice(2));
