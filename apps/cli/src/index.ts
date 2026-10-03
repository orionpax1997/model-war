#!/usr/bin/env node
/**
 * modelwar:唯一用户面与唯一 bin(hld §9)。
 *
 * 本文件只做路由:解析全局参数 → 找到子命令 → 动态加载承载它的包 → 调用处理器。
 * 六个子命令的实现在各自包里,本文件不含任何业务逻辑。
 *
 * 参数切分:子命令名之前的部分是全局参数(`--help` / `--version`),之后的原样交给子命令——
 * 子命令各自解析自己的参数(`--config models.yaml` 之类),本文件不猜它们的选项。
 */

import { parseArgs } from "node:util";
import { RULESET_VERSION } from "@model-war/schema";
import { COMMANDS, findCommand, handlerOf, type CommandSpec } from "./commands.js";

/** 与 apps/cli/package.json 的 version 同步;打包后不读盘,故在此写死。 */
const CLI_VERSION = "0.0.0";

const helpText = (): string =>
  [
    `modelwar ${CLI_VERSION} — 四人对称 RTS 对战平台`,
    "",
    "用法:modelwar <子命令> [参数]",
    "",
    "子命令:",
    ...COMMANDS.map((command) => `  ${command.usage.padEnd(34)}${command.summary}`),
    "",
    "全局参数:",
    "  -h, --help     打印本帮助",
    "  -v, --version  打印版本与规则集版本",
  ].join("\n");

/**
 * 一条子命令的 `--help`。
 *
 * `承载模块` 那行**刻意不写「待导出」**:登记表里的 `handler` 是「该包应当导出的符号名」,
 * 而「登记」与「实际导出」是两回事——那个「尚未导出」的判据由 `handlerOf` 在**调用时**给出,
 * 并以「未实现 + 非零退出」呈现(自动化流程不得把「没实现」读成「跑通了」)。
 * 在帮助文本里写死「待导出」的话,处理器落地后这句就变成一句自己打自己脸的假话。
 */
const commandHelpText = (command: CommandSpec): string =>
  [
    `用法:${command.usage}`,
    "",
    command.summary,
    `承载模块:${command.provider}(处理器 ${command.handler})`,
  ].join("\n");

/** 在第一个非选项 token 处切开:其后(含它自己)属子命令。 */
const splitAtCommand = (argv: readonly string[]): { head: string[]; tail: string[] } => {
  const at = argv.findIndex((token) => !token.startsWith("-"));
  return at === -1
    ? { head: [...argv], tail: [] }
    : { head: argv.slice(0, at), tail: argv.slice(at) };
};

const main = async (argv: readonly string[]): Promise<number> => {
  const { head, tail } = splitAtCommand(argv);
  const { values } = parseArgs({
    args: head,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.version === true) {
    process.stdout.write(`modelwar ${CLI_VERSION} (ruleset ${RULESET_VERSION})\n`);
    return 0;
  }

  const [name, ...args] = tail;
  if (values.help === true || name === "help") {
    if (name === undefined || name === "help") {
      process.stdout.write(`${helpText()}\n`);
      return 0;
    }
    const requested = findCommand(name);
    if (requested === undefined) {
      return unknownCommand(name);
    }
    process.stdout.write(`${commandHelpText(requested)}\n`);
    return 0;
  }

  if (name === undefined) {
    process.stderr.write(`${helpText()}\n`);
    return 1;
  }

  const command = findCommand(name);
  if (command === undefined) {
    return unknownCommand(name);
  }
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${commandHelpText(command)}\n`);
    return 0;
  }

  let loaded: unknown;
  try {
    loaded = await command.load();
  } catch (cause) {
    process.stderr.write(
      `modelwar ${command.name}: 无法载入 ${command.provider}(先跑 \`pnpm run build\`): ${
        cause instanceof Error ? cause.message : String(cause)
      }\n`,
    );
    return 1;
  }

  const handler = handlerOf(loaded, command.handler);
  if (handler === undefined) {
    process.stderr.write(
      `modelwar ${command.name}: 未实现——${command.provider} 尚未导出 ${command.handler}。\n`,
    );
    return 1;
  }
  // 退出码由处理器返回,不走 `process.exitCode`:顶层那句无条件赋值会把它覆盖成这里的
  // `return 0`,理由与 `CommandHandler` 上那段注释同源。
  return handler(args);
};

const unknownCommand = (name: string): number => {
  process.stderr.write(`modelwar: 未知子命令 ${name}\n\n${helpText()}\n`);
  return 1;
};

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (cause) {
  process.stderr.write(`modelwar: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
}
