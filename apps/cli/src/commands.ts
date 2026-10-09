/**
 * 子命令登记表(hld §9)。
 *
 * 每条命令登记三件事:命令名与用法、**将来导出该处理器的包**、以及该包必须导出的符号名。
 * 登记与实际导出是两回事:符号还没落地时,CLI 显式失败而不是静默返回成功——
 * 自动化流程不得把"没实现"读成"跑通了"。
 *
 * `provider` 是「处理器从哪个包来」,不是 hld §9 的「模块」列:后者写的是组装路径
 * (`apps/cli → replay`),而 `renderReplay` 这种处理器真正住在 `replay` 包里。两者含义不同,不互为校验。
 *
 * `load` 用字面量动态 import:TS 在编译期就按 workspace `exports` 解析出目标包的类型
 * (包间类型引用经 exports + project references 解析,不用 paths),esbuild 在打包期把它们内联进单文件。
 */

export type CommandName = "gen" | "run" | "match" | "replay" | "verify" | "map-lint";

/**
 * 子命令处理器:拿到的参数是该命令名之后的一切(子命令自带参数解析),**返回进程退出码**。
 *
 * ── 为什么是返回值而不是 `process.exitCode` ─────────────────────────────────
 * 处理器确实可以写 `process.exitCode = 1`,而且那样写也能过测试——**在 `index.ts` 的
 * 顶层 `process.exitCode = await main(...)` 之前跑完时不会丢**。它丢在下一句:顶层无条件把
 * `main` 的返回值赋给 `process.exitCode`,于是处理器设的 1 被 `main` 的 `return 0` 覆盖。
 * (`map-lint` 落地时正是这样:违规文本照打,退出码却是 0,cli.test.ts 的 e2e 断言当场变红。)
 *
 * 所以**退出码走返回值**,不走全局副作用:
 * - 全局通道在类型里**看不见**。`(args) => Promise<void>` 无法表达“我失败了”,于是
 *   `return 1` 被静默编译成 `return undefined` 而不是编译失败;
 * - 顶层那句无条件赋值让全局通道**必然**被覆盖,没有一条不依赖“执行顺序”的写法。
 *
 * 代价是退出码要显式穿过 `main` 一路回到顶层,这条链现在是类型检查盯着的。
 */
export type CommandHandler = (args: readonly string[]) => Promise<number>;

export type CommandSpec = {
  readonly name: CommandName;
  readonly usage: string;
  readonly summary: string;
  /** 将来导出该处理器的包(见文件头:`provider` 与 hld §9 的模块列含义不同) */
  readonly provider: string;
  /** 该包需要提供的导出名 */
  readonly handler: string;
  readonly load: () => Promise<unknown>;
};

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "gen",
    usage: "modelwar gen --config models.yaml [--root <仓库根>] [--model <slug>]",
    summary: "生成并冻结参赛脚本(可 --model <slug> 单跑)",
    provider: "@model-war/gen",
    handler: "generateAndFreeze",
    load: () => import("@model-war/gen"),
  },
  {
    name: "run",
    usage: "modelwar run --config season.yaml [--root <仓库根>]",
    summary: "整轮赛季 + 报告",
    provider: "@model-war/runner",
    handler: "runSeason",
    load: () => import("@model-war/runner"),
  },
  {
    name: "match",
    usage: "modelwar match <input.json>",
    summary: "执行一个对局(runner 与调试都走这条路径)",
    // 处理器住在 CLI 自己的模块里(同 `map-lint` 的先例):磁盘 I/O(hld §2.2.8)与 ajv 校验
    // 都在这一侧,engine 的 `runMatch` 是它调用的那个纯函数。所以承载模块是 `@model-war/cli`。
    provider: "@model-war/cli",
    handler: "runMatchCommand",
    load: () => import("./match/index.js"),
  },
  {
    name: "replay",
    usage: "modelwar replay <replay.jsonl>",
    summary: "终端 ASCII 回放,单步/暂停;只读回放,不依赖 engine",
    provider: "@model-war/replay",
    handler: "renderReplay",
    load: () => import("@model-war/replay"),
  },
  {
    name: "verify",
    usage: "modelwar verify <replay.jsonl>",
    summary: "按 input.json 重新执行,逐 tick hash 比对",
    // 处理器住在 CLI 自己的模块里(同 `match` / `map-lint` 的先例):它复用 `match` 的组装层与
    // engine 的 `runMatch`,而磁盘 I/O 与 ajv 校验都在这一侧。engine 的对外导出面仍恰好 `runMatch`,
    // 故 `verify` 不是 engine 的处理器。
    provider: "@model-war/cli",
    handler: "runVerifyCommand",
    load: () => import("./verify/index.js"),
  },
  {
    name: "map-lint",
    usage: "modelwar map-lint <maps/>",
    summary: "地图对称性与合法性校验",
    // map-lint 是 CLI 自己的模块(hld §3.1 的 `cli:… / map-lint`、§9 的模块列),不挂在 schema 上——
    // schema 只含类型、常量与 JSON Schema,无运行时代码(hld §3.2)。
    provider: "@model-war/cli",
    handler: "lintMaps",
    load: () => import("./map-lint/index.js"),
  },
];

export const findCommand = (name: string | undefined): CommandSpec | undefined =>
  COMMANDS.find((command) => command.name === name);

/** 从已载入的模块命名空间里取处理器;取不到就是"该命令还没实现"。 */
export const handlerOf = (loaded: unknown, name: string): CommandHandler | undefined => {
  if (typeof loaded !== "object" || loaded === null) {
    return undefined;
  }
  const candidate: unknown = Reflect.get(loaded, name);
  return typeof candidate === "function" ? (candidate as CommandHandler) : undefined;
};
