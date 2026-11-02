/**
 * 冻结期试跑（trial）的**计划**：一个可序列化、可校验、可 hash 的纯数据对象。
 *
 * ── 计划是什么 ──
 *
 * 一次试跑 = 「哪个候选、坐哪几个座位、对谁、在哪张图、用哪个种子」的全部取值。
 * 这里只放**形状**与 v1 的构造默认值；构造（把输入凑成计划并算摘要）、校验（能否由输入
 * 重建）与单场身份摘要都在 `@model-war/runner` 的 `trial-plan.ts`——本包不得依赖任何包
 * （没有 `node:crypto`），所以 hash 计算不在这儿。
 *
 * ── hash 覆盖什么 ──
 *
 * `planSha256` = 计划**正文**（除 `planSha256` 外的全部字段）按 canonical JSON（对象键排序、
 * 数组保序）序列化后的 sha256。于是：换种子、换座位、换地图、换一份对手摘要、换规则集或
 * 运行时摘要，摘要必变；反过来，正文任何一个字段被改而没有重算摘要，读入端一重建就能指出
 * 是哪一处不符。单场身份另算（`planSha256` + 候选脚本摘要 + 该场），见 runner 侧
 * `trialMatchInputSha256`。
 *
 * ── 为什么现在就把形状定死 ──
 *
 * v1 只是**填得少**：3 场、单图、候选恒 0 号位、三份基准脚本。多座位多图多陪练（网格）
 * 只填内容，不再改这里的形状；`matchesPerCandidate` 与 `matches` 的长度随之变大，
 * `scripts` 从「三份基准」换成「四份陪练」，`version` 随之升号。
 *
 * ── 版本怎么读 ──
 *
 * `version` 是计划的**形状契约**版本，不是观测行的版本（观测行另有 `version`）。
 * 历史存档（`optimization.version: 1`）没有 `plan` 字段是正常的：读取端明确报
 * 「版本 1、无计划字段」，不迁移、不回填（见 runner 侧 `archiveTrialPlanOf`）。
 */

/** 计划形状版本。v1 = 今天的三场单图试跑；网格化时升号，历史档按各自版本读。 */
export const TRIAL_PLAN_VERSION = 1 as const;

/** 陪练角色：v1 只有基准脚本（`benchmark`），网格起再加四份存档陪练。 */
export const TRIAL_SPARRING_ROLES = ["benchmark", "top", "mid", "last", "incumbent"] as const;
export type TrialSparringRole = (typeof TRIAL_SPARRING_ROLES)[number];

/** 候选的座位占位身份；候选自己的身份是它编译产物的 sha256，不进计划。 */
export const TRIAL_CANDIDATE_ID = "candidate" as const;

/** 计划里的一份对手（不含候选）。 */
export type TrialPlanScript = {
  /** v1：基准目录名；网格：陪练模型 slug。与 `role` 一起构成对手身份。 */
  readonly id: string;
  readonly role: TrialSparringRole;
  /** 来源指针：`benchmark:<name>` / `archive:<slug>/<runId>`（网格起）。 */
  readonly source: string;
  /** 脚本内容摘要（`script.js` 字节 sha256）；装载时现算并与此处比对。 */
  readonly scriptSha256: string;
};

/** 计划里的一张地图：名字与内容摘要。 */
export type TrialPlanMap = { readonly name: string; readonly sha256: string };

/** 座位号；四个座位恒满。 */
export type TrialPlanSeat = 0 | 1 | 2 | 3;

/** 计划里的一场：座位、种子、地图都由计划给定，执行器不再自己查表。 */
export type TrialPlanMatch = {
  /** 全局唯一且连续；观测行与结果都按它对齐。 */
  readonly matchIndex: number;
  /** 轮空的是哪一份陪练；v1 恒 0（三份基准全上）。 */
  readonly comboIndex: number;
  readonly seed: number;
  /** 每座位坐谁：脚本 id（候选固定叫 `candidate`）。 */
  readonly seats: readonly [string, string, string, string];
  /** 候选在本场坐哪；不是身份，是每场的参数。 */
  readonly candidateSeat: TrialPlanSeat;
  readonly map: string;
  readonly mapSha256: string;
};

/** 一次试跑的完整计划。正文全部字段进 `planSha256`；`planSha256` 自己不进。 */
export type TrialPlan = {
  readonly version: number;
  readonly ruleset: string;
  readonly rulesetSha256: string;
  readonly sandboxRuntimeHash: string;
  /** 对手们（不含候选），顺序即 v1 的座位序。 */
  readonly scripts: readonly TrialPlanScript[];
  readonly maps: readonly TrialPlanMap[];
  readonly matchesPerCandidate: number;
  readonly matches: readonly TrialPlanMatch[];
  readonly planSha256: string;
};

/**
 * ── 以下为 v1 的构造默认值（历史三场试跑的形状） ──
 *
 * 它们是**计划的默认内容**，不再是执行侧散落的常量：CLI 用它们造计划，执行器只读计划。
 * 网格化时这些取值会被计划的 v2 内容取代（种子改成每格一个固定值、地图变两张）。
 */

/** v1 固定种子：一场一个，三场对所有候选相同（可复现且公平）。 */
export const TRIAL_SEEDS = [101, 202, 303] as const;

/** v1 候选固定座位。 */
export const TRIAL_CANDIDATE_SEAT = 0 as const;

/** v1 单图：赛季当前地图（三张地图同尺寸，"小"无差别）。 */
export const TRIAL_MAP_NAME = "corridor-split" as const;

/** v1 场数：零容忍，K 场爆 1 次就打回。 */
export const TRIAL_MATCHES_PER_CANDIDATE = TRIAL_SEEDS.length;

/** v1 三份基准脚本的目录名；登记册真源在 `packages/tools/src/benchmarks/compile.ts`。 */
export const TRIAL_BENCHMARK_IDS = [
  "cell-a-melee-pressure",
  "cell-b-expansion-economy",
  "cell-c-claim-no-harvest",
] as const;

/** v1 四方身份：下标即座位（候选 0 号位 + 三个基准）。 */
export const TRIAL_PLAYER_IDS = [TRIAL_CANDIDATE_ID, ...TRIAL_BENCHMARK_IDS] as const;
