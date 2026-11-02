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

/**
 * ── 陪练池：四份**钉死**的身份（2026-11-02 拍定，不随榜单滚动重算） ──
 *
 * 名次来源：`runs/2026-11-02T04-53-46-815Z`（规则 v2、season-s2、840 局）。
 *
 * | 席位 | 模型 | 名次 / 赛季总分 |
 * |---|---|---|
 * | 榜首 `top` | claude-opus-5-5 | #1 / 915 |
 * | 中位 `mid` | minimax-m3.1-flash | #6（10 席的中位）/ 456 |
 * | 末位 `last` | glm-5.3-flash | #10 / 169.5 |
 * | 在位代位 `incumbent` | muse-spark-1.3-contributor | #9 / 212.5（首次生成无存档时顶替） |
 *
 * 在位脚本（`incumbent`）**不在这张表里**：它是「正在被优化的那个模型自己最近一次冻结存档」，
 * 名字随模型而定，由 `@model-war/runner` 的 `loadSparringPool` 读盘解析；该模型一份存档都没有时
 * 用下面的代位档，并在来源指针上标 `#substitute`。
 *
 * 身份是**数据**，不是「按赛季名次自动挑」：榜单滚动不改这里。要换池子就改这份表并重算摘要——
 * 计划摘要覆盖 `scriptSha256`，所以换一份脚本必然换计划身份（见 `packages/runner/src/trial-plan.ts`）。
 * `scriptSha256` 是 `script.js` **字节**的 sha256（复算认编译产物，与存档 meta 的 `scriptSha256`
 * 同一口径），由装载方现算并与这里比对，不符即拒绝。
 */

/** 榜单侧的三份钉死身份（在位那份不在此列，见上面 `TRIAL_SPARRING_LADDER` 的头注）。 */
export type TrialSparringLadderRole = Exclude<TrialSparringRole, "benchmark" | "incumbent">;

/** 一份钉死的陪练身份：模型 slug + 冻结存档 + 期望内容摘要。 */
export type TrialSparringIdentity = {
  readonly role: TrialSparringLadderRole;
  /** 模型 slug，= `archive/` 下的一级目录名，也是计划里的对手 `id`。 */
  readonly id: string;
  /** 冻结存档的运行标识，= `archive/<id>/` 下的二级目录名。 */
  readonly runId: string;
  readonly scriptSha256: string;
};

/** 代位档身份：没有 `role`，用它时角色仍是在位（来源带 `#substitute`）。 */
export type TrialSparringSubstituteIdentity = Omit<TrialSparringIdentity, "role">;

/** 榜首 / 中位 / 末位三份钉死的身份（顺序即计划里 `scripts` 的前三位）。 */
export const TRIAL_SPARRING_LADDER = [
  {
    role: "top",
    id: "claude-opus-5-5",
    runId: "2026-10-16T08-40-12-578Z",
    scriptSha256: "899b957f894bf706c710e90fa84bfeaafccbdd82c3c3f75f8c296ad84deface7",
  },
  {
    role: "mid",
    id: "minimax-m3.1-flash",
    runId: "2026-10-13T13-48-45-729Z",
    scriptSha256: "c80854d390033017e0cb7ae6200726fdcb3caa7e5b7111b73830a2df53e907a7",
  },
  {
    role: "last",
    id: "glm-5.3-flash",
    runId: "2026-10-13T22-30-50-602Z",
    scriptSha256: "8dab28493d18f6d2fa4c14a65a9bfcdacbc267455a53741d3567bbc9c9e37e63",
  },
] as const satisfies readonly TrialSparringIdentity[];

/** 在位代位档：模型首次生成、尚无任何冻结存档时顶替在位脚本的那一份。 */
export const TRIAL_SPARRING_SUBSTITUTE = {
  id: "muse-spark-1.3-contributor",
  runId: "2026-10-13T12-34-16-218Z",
  scriptSha256: "9558cb9aa659eccc37838fce8078bfdbde1a12465b5bc1ad16b1a8eca3f0a1c1",
} as const satisfies TrialSparringSubstituteIdentity;

/** 计划里四份陪练的顺序：榜首 → 中位 → 末位 → 在位（座位轮转按整组轮转，顺序即身份序）。 */
export const TRIAL_SPARRING_ROLE_ORDER = ["top", "mid", "last", "incumbent"] as const;

/** 代位来源指针的后缀：`archive:<slug>/<runId>#substitute`（拼法在 runner 的 `sparring-pool.ts`）。 */
export const TRIAL_SUBSTITUTE_SOURCE_SUFFIX = "#substitute" as const;
