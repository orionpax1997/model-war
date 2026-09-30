/**
 * 子命令登记表(hld §9)。
 *
 * 每条命令登记三件事:命令名与用法、承载它的包(hld §9 的"模块"列)、以及**该包必须导出的符号名**。
 * 登记与实际导出是两回事:符号还没落地时,CLI 显式失败而不是静默返回成功——
 * 自动化流程不得把"没实现"读成"跑通了"。
 *
 * `load` 用字面量动态 import:TS 在编译期就按 workspace `exports` 解析出目标包的类型
 * (包间类型引用经 exports + project references 解析,不用 paths),esbuild 在打包期把它们内联进单文件。
 */

export type CommandName = "gen" | "run" | "match" | "replay" | "verify" | "map-lint";

/** 子命令处理器:拿到的参数是该命令名之后的一切(子命令自带参数解析)。 */
export type CommandHandler = (args: readonly string[]) => Promise<void>;

export type CommandSpec = {
  readonly name: CommandName;
  readonly usage: string;
  readonly summary: string;
  /** 承载该命令的包 */
  readonly provider: string;
  /** 该包需要提供的导出名 */
  readonly handler: string;
  readonly load: () => Promise<unknown>;
};

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "gen",
    usage: "modelwar gen --config models.yaml",
    summary: "生成并冻结参赛脚本(可 --model <slug> 单跑)",
    provider: "@model-war/gen",
    handler: "generateAndFreeze",
    load: () => import("@model-war/gen"),
  },
  {
    name: "run",
    usage: "modelwar run --config season.yaml",
    summary: "整轮赛季 + 报告",
    provider: "@model-war/runner",
    handler: "runSeason",
    load: () => import("@model-war/runner"),
  },
  {
    name: "match",
    usage: "modelwar match <input.json>",
    summary: "单场对局(runner 与调试都走这条路径)",
    provider: "@model-war/engine",
    handler: "runMatch",
    load: () => import("@model-war/engine"),
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
    provider: "@model-war/engine",
    handler: "verifyReplay",
    load: () => import("@model-war/engine"),
  },
  {
    name: "map-lint",
    usage: "modelwar map-lint <maps/>",
    summary: "地图对称性与合法性校验",
    provider: "@model-war/schema",
    handler: "lintMaps",
    load: () => import("@model-war/schema"),
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
