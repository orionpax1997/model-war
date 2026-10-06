/**
 * CLI 退出码表(全局约定,写进 `docs/hld.md` §9 的 CLI 章节)。
 *
 * ── 为什么是一张表而不是每命令各定 ──
 *
 * 调度器只认退出码,不读日志;`runner` 的赛季编排要按码分流(合法的负/胜/超时对局也算成功,
 * 只有引擎故障与不确定超时进重跑/剔除条款)。散落在各命令里的字面量会让「3 到底是什么」
 * 每次都要回读某一处实现,所以口径收在这里一处。
 *
 * | 码 | 含义 |
 * |---|---|
 * | `0` | 正常(对局无论胜/负/超时/淘汰,只要产出合法 `result` 行即是 0) |
 * | `1` | 用法错或装载期校验错(缺参、读不到文件、输入/存档/地图/规则集未过校验) |
 * | `2` | 引擎崩溃(未捕获异常、确定性断言失败、WASM trap) |
 * | `3` | 不确定超时(nondeterministic-timeout;墙钟硬超时) |
 * | `4` | 其它内部错 |
 *
 * 细节另在 stderr 给一行 JSON(见 `reportFailure`),调度器只认码。
 */

/** 正常退出。规则内结果(胜/负/超时/淘汰)都归这里。 */
export const EXIT_OK = 0;

/** 用法错或装载期校验错。 */
export const EXIT_USAGE_OR_VALIDATION = 1;

/** 引擎崩溃(未捕获异常、确定性断言失败、WASM trap)。 */
export const EXIT_ENGINE_FAULT = 2;

/** 不确定超时(墙钟硬超时;票 07/09 的机制,本票只把码位定下来)。 */
export const EXIT_NONDETERMINISTIC_TIMEOUT = 3;

/** 其它内部错(如产物写盘失败)。 */
export const EXIT_INTERNAL = 4;

/** 一条失败:退出码 + 面向人的一句话 + 可选细节(面向模型层的诊断短句)。 */
export type CommandFailure = {
  readonly exitCode: number;
  readonly message: string;
  /** 追加在同一行前的人读细节(如校验器逐条诊断)。 */
  readonly details?: readonly string[];
};

/**
 * 把一条失败写到 stderr:先是人读的几行,末尾**一行 JSON**。
 *
 * 那行 JSON 是给自动化读的(调度器只认退出码,但排障时要有结构化的那一句)。逐字段原样透出,
 * 不做改写:改写的活归校验器的诊断渲染(它已经合并过同类错误)。
 */
export const reportFailure = (command: string, failure: CommandFailure): void => {
  process.stderr.write(`${command}: ${failure.message}\n`);
  for (const detail of failure.details ?? []) {
    process.stderr.write(`  ${detail}\n`);
  }
  process.stderr.write(
    `${JSON.stringify({
      command,
      exitCode: failure.exitCode,
      message: failure.message,
      details: failure.details ?? [],
    })}\n`,
  );
};
