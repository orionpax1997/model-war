/**
 * 参赛脚本静态校验的调用封装:以**子进程**调 `packages/tools` 的校验器源码入口
 * (hld §6.2「API 误用」那一行;契约 §3)。
 *
 * ── 为什么是子进程 + 退出码 + stdout,而不是 import 它的库 ──
 *
 * 校验器入口的对外契约只有三样:**退出码 = 放行/拦、stdout = 面向模型的文本、参数**。
 * 直接 `import` 它的库会把它的源码并进生成管线的 program(它以源码形态由 Node 的类型擦除
 * 执行);给它补一个 `bin` 会把内部校验动作塞进用户面。所以生成管线只经子进程消费它,
 * 与 spec《调用的形状:子进程 + 退出码》一致。
 *
 * ── 体积上限的取值来源 ──
 *
 * `--max-bytes` 是校验器入口的参数名,而**取值**来自 `<root>/rulesets/<RULESET_VERSION>.json`
 * 的 `scriptSizeLimit`(v1 = 32768)。校验器不给默认值(缺参即失败),所以这里必须从规则集
 * 读出一个真值,而不是顺手写一个常量——写死就绕开了「冻结期以 rulesets 取值硬拦」这一条。
 *
 * ── 两个相位 ──
 *
 * `iteration` 期体积超限只提示(退出码 0),`freeze` 期才硬拦(退出码 1)。相位是调用方给的,
 * 判定链自己按它分流,这里只负责把相位透传给入口。
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { RULESET_VERSION } from "@model-war/schema";

/** 校验相位:迭代期(提示)与冻结期(硬拦)。与校验器入口的 `--phase` 取值一一对应。 */
export type ScriptLintPhase = "iteration" | "freeze";

export type ValidateResult = {
  /** 退出码 0 = 放行(含只有非 blocking 提示);非 0 = 拦。 */
  readonly passed: boolean;
  /** 校验器 stdout,**面向模型的文本**——唯一允许回喂给模型的内容(票 04 消费)。 */
  readonly stdout: string;
  /** 面向作者的失败条目;通过时为空数组(`meta.validation.errors` 的来源)。 */
  readonly errors: readonly string[];
};

/** 校验器源码入口在仓库根下的相对位置。 */
const VALIDATOR_ENTRY = join("packages", "tools", "src", "validate", "run-validate-script.ts");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 从 `<root>/rulesets/<RULESET_VERSION>.json` 读 `scriptSizeLimit`。
 *
 * 读不到文件、JSON 不合法、或键不是非负整数 → 抛错(不返回一个默认上限)。
 */
export const scriptSizeLimit = (root: string): number => {
  const path = join(root, "rulesets", `${RULESET_VERSION}.json`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`读不到规则集 ${path}(scriptSizeLimit 的真源):${reason}`);
  }
  const limit = isRecord(parsed) ? parsed.scriptSizeLimit : undefined;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0) {
    throw new Error(
      `规则集 ${path} 的 "scriptSizeLimit" 必须是非负整数,收到 ${JSON.stringify(limit)}`,
    );
  }
  return limit;
};

const nonEmptyLines = (text: string): readonly string[] =>
  text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

/**
 * 调校验器入口。`artifactPath` 是编译产物(`script.js`)的路径。
 *
 * 参数顺序照入口的用法串:`<产物文件> --max-bytes <N> --phase <iteration|freeze>`。
 */
export const validateScript = (options: {
  readonly root: string;
  readonly artifactPath: string;
  readonly maxBytes: number;
  readonly phase: ScriptLintPhase;
}): ValidateResult => {
  const entry = join(options.root, VALIDATOR_ENTRY);
  const result = spawnSync(
    process.execPath,
    [
      entry,
      options.artifactPath,
      "--max-bytes",
      String(options.maxBytes),
      "--phase",
      options.phase,
    ],
    { encoding: "utf8" },
  );
  if (result.error !== undefined) {
    throw result.error;
  }
  const stdout = result.stdout ?? "";
  const passed = (result.status ?? -1) === 0;
  return { passed, stdout, errors: passed ? [] : nonEmptyLines(stdout) };
};
