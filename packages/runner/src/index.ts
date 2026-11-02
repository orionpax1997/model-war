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
 * - `scheduler`:`runSeason` 处理器与可测核心 `scheduleSeason`(并发赛季 + 退出码驱动的重跑/剔除);
 * - `reporter`:`report.json` 的形状与序列化(纯函数 `renderReportJson` + 薄壳落盘),
 *   以及人类面产物 `report.md` / `narrative/<对局>.md`(纯函数 `renderReportMarkdown` /
 *   `renderNarrative` + 薄壳 `writeReportArtifacts`)。
 */

export * from "./enumerate.js";
export * from "./ranker.js";
export * from "./reporter.js";
export * from "./season-config.js";
export * from "./scheduler.js";

export * from "./archive-report.js";

export * from "./selection.js";
export * from "./archive-optimization.js";

// 试跑计划的构造、校验与单场身份摘要（纯数据 + hash，不起 VM）。
// `canonical.ts` 是 `planSha256` 的序列化真源，与选拔计划共用。
export * from "./canonical.js";
export * from "./trial-plan.js";

// 网格计分：一张跑满的网格 → 候选唯一的分数（平均名次积分，分母恒等于计划场数）。
// 算术只有 `ranker.ts` 一处真源，本格只做「场次齐不齐」与「读数属不属于这一格」的把关。
export * from "./trial-score.js";

// 陪练池：四份钉死的身份 → 盘上真实字节 + 现算的内容摘要（读盘，但不起 VM）。
export * from "./sparring-pool.js";
