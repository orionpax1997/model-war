/**
 * runner 包:赛季调度、排名与报告(hld §3.1)。
 * 依赖方向单向:runner → schema;**不得 import engine**——runner 只以子进程 + 文件消费对局产物(hld §3.2)。
 *
 * 本文件是**对外唯一入口**,只做再导出(域文件之间经这里互相看见的旧约定:枚举主体在
 * `./enumerate.js` 而不是本文件,是为了避免 `index → scheduler → index` 的包内环——见该文件头注)。
 *
 * 四段各司其职:
 * - `enumerate`:全部 4 人组合 × M 张地图 × K 个种子,带座位轮换与确定性种子;
 * - `season-config`:`season.yaml` 的形状与装载(取值缺省语义由调用方注入);
 * - `ranker`:名次积分纯函数 `rankSeason`;
 * - `scheduler`:`runSeason` 处理器与可测核心 `scheduleSeason`(串行赛季,票 06)。
 */

export * from "./enumerate.js";
export * from "./ranker.js";
export * from "./season-config.js";
export * from "./scheduler.js";
