/**
 * 冻结脚本存档的 `meta.json` 形状(hld §7.4)。**类型与 JSON Schema 同文件、同一次书写**,
 * 纪律与 `map.ts` 一致:TypeScript 是真源、JSON Schema 手工对齐(ADR-0003),
 * 漂移由 `apps/cli` 校验器那条缝的双过 fixture 与「必填键集合 === 键联合」的类型级断言兜住。
 *
 * ── 十一项逐项来自 hld §7.4(`docs/hld.md` 的冻结脚本存档一节),不是本文件的取舍 ────────────
 *
 * | hld 的措辞 | 字段 | 为什么是这个形状 |
 * |---|---|---|
 * | 模型名 | `model` | 与 `archive/<modelSlug>/` 的目录名同源(§7.4 的拓扑) |
 * | 模型版本/快照标识 | `modelVersion` | 「版本/快照」是一格:模型那边按快照冻结,不按 git tag 冻结 |
 * | 生成日期 | `generatedAt` | 冻结时刻,只作留档,任何计算都不读它 |
 * | 协议迭代轮数 | `protocolRounds` | 与 `prompts` 的长度**双存**,装载期断言两者相等 |
 * | 完整 prompt(逐轮) | `prompts` | 逐轮 prompt 按轮次先后排列,下标即轮次 |
 * | 生成日志 | `generationLog` | 逐行一条;日志是复现「这份脚本怎么来的」的唯一凭据 |
 * | ruleset 版本 | `ruleset` | 与本仓版本常量、取值文件名三处一致,装载期判 |
 * | 校验结果 | `validation` | 静态校验器(hld §6.2)那次的结论,连同失败条目一起留档 |
 * | tsc 版本 | `tscVersion` | `script.js` 由哪一版 tsc 编译出来,复算要能对上 |
 * | `script.js` 的 sha256 | `scriptSha256` | 复算认的是**编译产物**,不是定版源码 |
 * | sandbox-runtime hash | `sandboxRuntimeHash` | 同一个脚本换一副沙箱跑,结果不保证一致 |
 *
 * ── 可选的 `channelId`:渠道身份,历史档没有它是事实而不是缺陷 ──────────────────
 *
 * 榜键四维是 `rulesetVersion + modelVersion + harnessVersion + channelId`(票 03 的裁决)。
 * `modelVersion` 那一格回答「哪一版模型」,`channelId` 回答「从哪条渠道、哪个档位调到的」——
 * 同一个 `baseUrl`(如 `/provider/v1`)可以挂多个档位,差别在可用 modelId 与配额窗口,
 * 所以它推不出来,必须写入档。
 *
 * **它不进 `required`**:2026-11 之前冻结的档源自还没有这个字段的渠道(opencode),那些档
 * 没有它,回填等于伪造证据。装载期因此不得因缺它拒跑——与 `optimization` / `selection`
 * 同一条纪律:新档写,老档不迁移。
 *
 * ── 档案形状版本:一档一读法,不靠猜 ────────────────────────────────────────
 *
 * 本文件里有**三个版本号,各管一件事**(ADR-0031):
 *
 * | 版本号 | 管什么 | 落在哪个键 |
 * |---|---|---|
 * | 档案形状版本 | 这份文件按哪种形状读(读兼容契约) | `archiveSchemaVersion` |
 * | 优化段版本 | 优化段内部的形状变体 | `optimization.version` |
 * | harness 身份 | 模型当时面对的世界(叙事版本 + 行为清单哈希) | `harnessVersion` / `harnessDigest` |
 *
 * 三者同进同出会漂移,所以关系写死成断言(装载期判,判据与措辞在 runner 的
 * `archiveShapeIssuesOf` / `validateArchiveCandidateRelations` 一处,**两个读入端共用**):
 * **档案形状版本为 3 时,优化段版本必须是 3 或优化段缺席**;反过来,**带了 agent 字段却缺
 * `archiveSchemaVersion: 3` 即报错**。这两个方向合起来正是「新形状不许被老读法读进去,
 * 老形状不许被悄悄当成新形状」。
 *
 * 为什么不用 JSON Schema 的 `if/then` 表达这条关系:读入端有两条——`apps/cli` 的 ajv 与
 * runner 的 `z.fromJSONSchema`——而后者不支持条件 schema(`if/then/else` 直接报错)。把一条
 * 判据写进只有一半读者能执行的位置,等于让它在一半路径上失效,所以它归装载期断言。
 *
 * ── 形状一次定死:生成管线落地时只填值,不改形状 ───────────────────────────────
 *
 * 这十一项与它们的嵌套形状**由本文件定死**,生成管线(gen 侧那一票)落地时**只填值**。
 * 改字段要走一次有意的变更,像改一个错误码名那样:改一处就波及已经冻结在 `archive/` 里的
 * 每一份 `meta.json`,以及每份引用了它的 `input.json`。**理由写在这里是因为直觉会骗人**:
 * 后来者看到「元数据还差一个字段」时,最自然的动作是往 schema 里加一个够用的键,而那正是
 * 让「形状一次定死」这句话失效的动作。半截字段与放行额外属性的空 schema 同样被禁
 * (`pending.ts` 的头注是那两条纪律的家)。
 *
 * ── 本模块不含运行时代码 ──────────────────────────────────────────────────────
 * 交付的是类型与 JSON Schema 数据。ajv 校验器不在这儿:真源包不依赖任何包,也不能依赖 ajv
 * (hld §3.2)。跨字段判据(版本三处一致、哈希与实测是否相等、
 * 轮数与 prompt 条数是否相等)归 `apps/cli` 的装载期断言。
 */

import {
  ARCHIVE_AGENT_SELECTION_JSON_SCHEMA,
  ARCHIVE_GRID_SELECTION_JSON_SCHEMA,
  ARCHIVE_SELECTION_JSON_SCHEMA,
  type ArchiveSelection,
} from "./selection-plan.js";
import { TRIAL_GRID_SCORE_JSON_SCHEMA, type TrialGridScore } from "./trial-grid-summary.js";
import {
  TRIAL_MATCHES_PER_CANDIDATE,
  TRIAL_PLAN_JSON_SHAPE,
  TRIAL_PLAN_SCRIPT_JSON_SCHEMA,
  TRIAL_SEEDS,
  TRIAL_SPARRING_ROLE_ORDER,
  type TrialPlan,
  type TrialPlanScript,
} from "./trial-plan.js";
import type { JsonValue } from "./index.js";

/**
 * 统一事实优化的跨进程政策；只有数据，没有运行时判定。
 *
 * ── 两版并行，历史档不改写 ──
 *
 * `OPTIMIZATION_VERSION`（v1）= 三场单图试跑：种子是三个固定值，没有计划、没有陪练清单，
 * 候选也没有分数。`OPTIMIZATION_GRID_VERSION`（v2）= 评测网格（每候选整张网格）：计划、
 * 四份陪练身份、每个候选的网格分数与场数、同字节复用的来源都进档。
 *
 * v1 是**历史档的形状**，不是「待迁走的旧东西」：`archive/` 里已冻结的档不迁移、不回填，
 * 读入端按 `version` 分派（见 runner 的 `validateArchiveCandidateRelations` 与
 * `archiveTrialPlanOf`）。所以这里不改 v1 的类型与 const，只另写一版。
 */
export const OPTIMIZATION_VERSION = 1 as const;
export const OPTIMIZATION_GRID_VERSION = 2 as const;
/**
 * v3 = 分步（agent）形态的候选序（ADR-0031）。
 *
 * 只有 `{version, candidates}`：候选条数 1..3、**没有 `stage`**。`stage` 连同它对应的
 * 阶段机制一起消失（ADR-0032），候选的数组下标就是「第几次评测」，末位即最终候选。
 * 阶段概念的其余下游（反馈轮数、跨阶段复用、网格计划与陪练身份）也随之作废，所以 v3 的
 * 优化段里既不写 `feedbackRounds`，也不写 `plan` / `sparring` / `reusedFromStage`。
 */
export const OPTIMIZATION_AGENT_VERSION = 3 as const;
export const OPTIMIZATION_FEEDBACK_ROUNDS = 2 as const;
export const OPTIMIZATION_STAGES = [0, 1, 2] as const;

/**
 * 评测配额（= 一份档案最多几个候选）。三次 `evaluate` 是**上限**，不是下限。
 *
 * 与 `OPTIMIZATION_STAGES.length` 数值相同是巧合而不是同一个事实：那张表是 v1/v2 的
 * 三阶段下标，本常量是分步形态的调用配额。改一个不意味着改另一个。
 */
export const OPTIMIZATION_CANDIDATE_LIMIT = 3 as const;

/**
 * 档案形状版本（ADR-0031「三个版本号各管一件事」的第一件：档案级的**读兼容契约**）。
 *
 * 它必填于**新档**、缺席于历史档；装载器与报告按它分派，不认识的版本**拒读**而不是猜。
 * 它是唯一能覆盖「失败档没有优化段」的版本号——优化段版本回答不了「这份文件按哪种形状读」。
 */
export const ARCHIVE_SCHEMA_VERSION = 3 as const;

export type ArchiveOptimizationCandidate = {
  readonly stage: (typeof OPTIMIZATION_STAGES)[number];
  /** 全局 1 起协议轮号，包含诊断修复响应，不包含传输重试。 */
  readonly protocolRound: number;
  /** 相对 archive/<slug>/ 的独占旁挂 basename。 */
  readonly scriptFile: string;
  readonly observationsFile: string;
  readonly scriptSha256: string;
  /**
   * 这一阶段候选**实际发出**的生成参数（`generationParams()` 的返回值，原样落档）。
   * 新档必写；旧档（本字段出现前冻结）没有它，读入侧按可选处理。
   */
  readonly params?: JsonValue;
  /**
   * v2 起必填：这张网格给它的**唯一**分数（网格平均名次积分）。
   * 生成侧不重算分数——它逐字来自该轮的 `<观测文件>.grid.json`（算术真源在 runner 的
   * `trial-score.ts`），v2 的 schema 把这一栏写进 `required`。
   */
  readonly score?: TrialGridScore;
  /**
   * v2 起必填：这张网格的场数（= 计划声明的场数，当前 32）。
   * 与 `score.countedMatches` 双存，装载期断言两者相等——「少跑几场凑个好看的均分」在形状层就写不出来。
   */
  readonly matchCount?: number;
  /**
   * v2：编译产物字节与**更早阶段**相同时，复用的是哪一阶段的网格结果。
   * 复用不是「跳过校验」：逐场证据必须与来源逐字一致，装载期按它核对来源、字节与分数。
   */
  readonly reusedFromStage?: (typeof OPTIMIZATION_STAGES)[number];
};

/** 计划里的一份陪练身份（四份陪练写进存档时原样搬过来）。 */
export type ArchiveOptimizationSparring = Pick<
  TrialPlanScript,
  "id" | "role" | "source" | "scriptSha256"
>;

/** v1：三场单图试跑（历史档）。种子固定三条；计划与陪练身份在 v2 才有。 */
export type ArchiveOptimizationV1 = {
  readonly version: typeof OPTIMIZATION_VERSION;
  readonly feedbackRounds: typeof OPTIMIZATION_FEEDBACK_ROUNDS;
  readonly trialSeeds: typeof TRIAL_SEEDS;
  /** 装载端校验 stage 顺序、协议轮号递增及最终候选 hash 关系。 */
  readonly candidates: readonly ArchiveOptimizationCandidate[];
};

/**
 * v2：评测网格（每候选整张网格）。
 *
 * 种子**不在这里单列**：网格的种子是逐场事实（`plan.matches[].seed`），计划摘要覆盖它们。
 * 再存一份 `trialSeeds` 就是同一件事的第二个家，而 v2 的种子本来就不是「三个」。
 */
export type ArchiveOptimizationGrid = {
  readonly version: typeof OPTIMIZATION_GRID_VERSION;
  readonly feedbackRounds: typeof OPTIMIZATION_FEEDBACK_ROUNDS;
  /** 完整试跑计划（含 `planSha256`）：这批候选跑的是哪张网格，只由它回答。 */
  readonly plan: TrialPlan;
  /** 四份陪练身份（与 `plan.scripts` 同形，装载期逐项比对）。 */
  readonly sparring: readonly ArchiveOptimizationSparring[];
  readonly candidates: readonly ArchiveOptimizationCandidate[];
};

export type ArchiveOptimization =
  | ArchiveOptimizationV1
  | ArchiveOptimizationGrid
  | ArchiveOptimizationAgent;

/**
 * 一步（一次模型调用）的过程记录条目（ADR-0031 / ADR-0032）。
 *
 * 最小键集合现在定死：装载器要靠它判完整性。`raw`（模型原文）与 `result`（结果侧证据）
 * 是可选键——ADR-0031 已裁决「条目可选键不升形状版本」，ADR-0036 沿用同一条先例。
 */
export type ArchiveStepAction =
  /** 整块交给一次 `bash -c`；`command` 是执行的那段原文。 */
  | { readonly kind: "bash"; readonly command: string }
  /** 整块去空白后恰为 `evaluate`：这一次 `evaluate` 产出一个候选。 */
  | { readonly kind: "evaluate" }
  /** 被块级 `done` 哨兵终止。 */
  | { readonly kind: "done" }
  /**
   * 这一步**没有可执行的动作**：零个块 / 多个块 / 块标记不是 `bash`，或者响应两次都被输出上限
   * 截断而转了格式反馈。命令一条都没跑，但这一步照样计入步数与过程记录（ADR-0032「`done` 不是
   * 免费出口」的同一条计数口径：一次模型调用就是一步）。
   *
   * 为什么不复用 `bash` 加一个空 `command`：空命令在 `bash` 那一格是不合法的（`minLength: 1`），
   * 而放宽它等于让「跑了空 shell」与「什么都没跑」在档案里同形——后者恰恰是校准 harness 时最
   * 想看见的那种步。
   */
  | { readonly kind: "none" };

/** 结果侧证据：这一轮被什么驱动、编译错误码（发送侧证据在 `generationLog` 里）。 */
export type ArchiveStepResult = {
  readonly kind: "tsc" | "contract";
  readonly errorCodes: readonly string[];
};

export type ArchiveStep = {
  /** 步号，1 起；等于 `generationLog` 里那一行的 `round`。 */
  readonly step: number;
  readonly action: ArchiveStepAction;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  /** 模型当时的原始文本（与发回去的字节同源）。不截断：截它会让模型看到自己被砍断的代码。 */
  readonly raw?: string;
  /** 步起点相对会话起点的偏移（毫秒）。 */
  readonly atMs: number;
  /** 沙箱执行加观测回填（毫秒）。 */
  readonly harnessMs: number;
  readonly result?: ArchiveStepResult;
};

/**
 * v3 的候选：**没有 `stage`**，`step` 是那次 `evaluate` 的步号。
 *
 * 数组下标即「第几次评测」；末位即最终候选（`optimization` 缺席时也就是胜者）。
 * `score` / `matchCount` 必填：成绩取最后一次 `evaluate` 评的那个版本，且分母不许缩。
 */
export type ArchiveOptimizationCandidateAgent = {
  readonly step: number;
  /** 相对 archive/<slug>/ 的独占旁挂 basename。 */
  readonly scriptFile: string;
  readonly observationsFile: string;
  readonly scriptSha256: string;
  /** 这一次 `evaluate` 时实际发出的生成参数（端点原生形状，原样落档）。 */
  readonly params?: JsonValue;
  readonly score: TrialGridScore;
  readonly matchCount: number;
};

/**
 * 两种形态的候选：one-shot（带 `stage` / `protocolRound`）与 v3（带 `step`）。
 *
 * 失败记录是**两种形态共用**的一份文件（ADR-0031「失败档与成功档同形」），所以它的候选栏
 * 必须容得下两版；读入端按档案形状版本分派（见 runner 的 `failureCandidatesOf`）。
 */
export type AnyArchiveOptimizationCandidate =
  | ArchiveOptimizationCandidate
  | ArchiveOptimizationCandidateAgent;

/** v3：分步形态的候选序（1..3 条，无 `stage`，无计划——网格计划不进这份档案）。 */
export type ArchiveOptimizationAgent = {
  readonly version: typeof OPTIMIZATION_AGENT_VERSION;
  readonly candidates: readonly ArchiveOptimizationCandidateAgent[];
};

/** 一轮协议迭代的完整 prompt。刻意不写成带元字段的对象——见头注「逐轮」那一栏。 */
export type ArchivePrompt = string;

/**
 * 静态校验器那次的结论。
 *
 * **为什么是「结论 + 失败条目」两格,而不是一个布尔**:`passed: true` 单独存在时,
 * 「判了什么」无处可查,而冻结档的用处恰恰是日后回答「这份脚本当时凭什么被放行」。
 * 失败条目是**面向作者**的文本,不是 ajv 诊断(后者由读入端当场现产,不进档)。
 */
export type ArchiveValidation = {
  /** 静态校验器(hld §6.2)那一次是否通过。 */
  readonly passed: boolean;
  /** 失败条目;`passed` 为真时取空数组。两格都必填——「没失败」与「没查」不是同一件事。 */
  readonly errors: readonly string[];
};

/** 冻结脚本 `meta.json` 的全部内容。十一项必填；优化旁证可选，旧档兼容。 */
export type ArchiveMeta = {
  readonly model: string;
  readonly modelVersion: string;
  /**
   * 渠道身份(含档位,如 `commandcode-goat-2026-11`)。
   *
   * 可选:本字段出现前冻结的历史档没有它,那些档仍要能装载、能回放、能进报告。
   * 新档由生成管线必写(配置里的 `channelId` 是必填项)。
   */
  readonly channelId?: string;
  readonly generatedAt: string;
  /** 协议迭代轮数,与 `prompts` 的长度双存,装载期断言两者相等。 */
  readonly protocolRounds: number;
  /** 逐轮完整 prompt,下标即轮次(0 起),长度必须等于 `protocolRounds`。 */
  readonly prompts: readonly ArchivePrompt[];
  /** 生成日志,逐行一条。 */
  readonly generationLog: readonly string[];
  readonly ruleset: string;
  readonly validation: ArchiveValidation;
  readonly tscVersion: string;
  /** `script.js` 的 sha256(小写十六进制 64 位)。复算认编译产物,不认 `script.ts`。 */
  readonly scriptSha256: string;
  /** 沙箱 runtime 的 hash(小写十六进制 64 位)。 */
  readonly sandboxRuntimeHash: string;
  readonly optimization?: ArchiveOptimization;
  readonly selection?: ArchiveSelection;
  /**
   * 档案形状版本。**新档必写**、历史档缺席（ADR-0031）。
   *
   * `additionalProperties: false` 与「一档一读法」的冲突由它解开：装载器先看这一格分派，
   * 带 agent 字段却没有它、或写了个不认识的数字，一律拒读（不猜、不降级）。
   */
  readonly archiveSchemaVersion?: typeof ARCHIVE_SCHEMA_VERSION;
  /** 模型席位的上下文窗口（token）。档案自足优先：历史报告不用今天的配置解释昨天的行为。 */
  readonly contextLength?: number;
  /** harness 的叙事版本（如 `bash-mini/0.1`）：人维护的「模型面对的世界」的代号。 */
  readonly harnessVersion?: string;
  /** harness 行为清单的 sha256（ADR-0029）：动作语法、挂载、配额、观测出口、截断上限…… */
  readonly harnessDigest?: string;
  /** 这一次会话是怎么停的（ADR-0032）。与落档判据正交：停止原因不决定是否成功。 */
  readonly termination?: ArchiveTermination;
  /** 终止发生在第几步（0 = 一次模型调用都没有成功）。 */
  readonly atStep?: number;
  /** 过程记录：一步一条，与协议轮数同义（零步会话写 `[]`）。 */
  readonly steps?: readonly ArchiveStep[];
};

/**
 * 终止原因（ADR-0032）：`done` / 步数耗尽 / 总墙钟耗尽 / 上下文守卫 / 连续三次动作解析失败 /
 * 传输重试耗尽。它只决定循环怎么停，不决定落档——有候选就是成功档。
 */
export const ARCHIVE_TERMINATIONS = [
  "done",
  "max-steps",
  "wall-clock",
  "context",
  "action-parse",
  "transport",
] as const;
export type ArchiveTermination = (typeof ARCHIVE_TERMINATIONS)[number];

/**
 * agent 形态**独有**的顶层键（不含 `archiveSchemaVersion` 本身）。
 *
 * 两个用途：装载期判「带 agent 字段却缺 `archiveSchemaVersion: 3`」，以及 v3 的必写清单。
 * 它们排在同一个表里，是因为「哪些键属于新形态」是同一个事实——分成两张表迟早分叉。
 */
export const AGENT_ARCHIVE_FIELD_KEYS = [
  "steps",
  "contextLength",
  "harnessVersion",
  "harnessDigest",
  "termination",
  "atStep",
] as const;

/** v3 档案必须同批写出的键（`archiveSchemaVersion` + 上面六个）。JSON Schema 表达不了条件必填。 */
export const AGENT_ARCHIVE_REQUIRED_KEYS = [
  "archiveSchemaVersion",
  ...AGENT_ARCHIVE_FIELD_KEYS,
] as const;

/** 键序即 `required` 序、`meta.json` 的书写序,不容另定一处。 */
const REQUIRED_KEYS = [
  "model",
  "modelVersion",
  "generatedAt",
  "protocolRounds",
  "prompts",
  "generationLog",
  "ruleset",
  "validation",
  "tscVersion",
  "scriptSha256",
  "sandboxRuntimeHash",
] as const;

/** sha256 的形状:小写十六进制 64 位。散列的**表示**归本 schema,取值比对归装载期。 */
const SHA256 = {
  type: "string",
  pattern: "^[0-9a-f]{64}$",
} as const;

/**
 * 候选一格的属性表（v1 / v2 / 失败记录共用一份写法）。
 *
 * 两版**只差在必填集**：v1（历史档）没有 `score` / `matchCount`，所以它们不进那一版的
 * `required`；v2 必须写。属性表不复制——否则「候选长什么样」就会有两个家。
 */
const OPTIMIZATION_CANDIDATE_PROPERTIES = {
  stage: { type: "integer", enum: OPTIMIZATION_STAGES },
  protocolRound: { type: "integer", minimum: 1 },
  scriptFile: { type: "string", pattern: "^(?!.*\\.\\.)[A-Za-z0-9][A-Za-z0-9._-]*$" },
  observationsFile: {
    type: "string",
    pattern: "^(?!.*\\.\\.)[A-Za-z0-9][A-Za-z0-9._-]*$",
  },
  scriptSha256: SHA256,
  // 故意不进 `required`：本字段出现前冻结的档没有它，旧档要能继续装载。
  // 新档的必写由生成侧（pipeline 的候选构造点）保证，不在 schema 里区分新旧。
  params: {
    type: "object",
    description:
      "这一阶段候选实际发出的生成参数（端点原生形状，原样落档），供事后查证「当时发的是什么」。",
  },
  // v2 起必填（见 `OPTIMIZATION_CANDIDATE_GRID_JSON_SCHEMA`）：分数逐字来自该轮 `.grid.json`。
  score: TRIAL_GRID_SCORE_JSON_SCHEMA,
  // v2 起必填：这张网格的场数（= 计划声明的场数）。
  matchCount: { type: "integer", const: TRIAL_MATCHES_PER_CANDIDATE },
  // v2：同字节复用的来源阶段；缺席 = 本轮自己跑了网格。
  reusedFromStage: { type: "integer", enum: OPTIMIZATION_STAGES },
} as const;

/**
 * 候选一格的形状（**宽松那一版**）：v1 档与失败记录用它——历史档没有分数，
 * 失败记录里的候选也可能来自网格之前的中途失败。
 */
export const ARCHIVE_OPTIMIZATION_CANDIDATE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["stage", "protocolRound", "scriptFile", "observationsFile", "scriptSha256"],
  properties: OPTIMIZATION_CANDIDATE_PROPERTIES,
} as const;

/** v2 的候选：在宽松那一版上把 `score` 与 `matchCount` 改成必填。 */
const OPTIMIZATION_CANDIDATE_GRID_JSON_SCHEMA = {
  ...ARCHIVE_OPTIMIZATION_CANDIDATE_JSON_SCHEMA,
  required: [...ARCHIVE_OPTIMIZATION_CANDIDATE_JSON_SCHEMA.required, "score", "matchCount"],
} as const;

/** v1 的优化旁证：三场单图试跑（历史档形状，不迁移、不回填）。 */
const OPTIMIZATION_V1_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "feedbackRounds", "trialSeeds", "candidates"],
  properties: {
    version: { type: "integer", const: OPTIMIZATION_VERSION },
    feedbackRounds: { type: "integer", const: OPTIMIZATION_FEEDBACK_ROUNDS },
    trialSeeds: {
      type: "array",
      minItems: TRIAL_SEEDS.length,
      maxItems: TRIAL_SEEDS.length,
      items: [
        { type: "integer", const: TRIAL_SEEDS[0] },
        { type: "integer", const: TRIAL_SEEDS[1] },
        { type: "integer", const: TRIAL_SEEDS[2] },
      ],
      additionalItems: false,
    },
    candidates: {
      type: "array",
      minItems: OPTIMIZATION_STAGES.length,
      maxItems: OPTIMIZATION_STAGES.length,
      items: ARCHIVE_OPTIMIZATION_CANDIDATE_JSON_SCHEMA,
    },
  },
} as const;

/** v2 的优化旁证：评测网格（计划 + 四份陪练身份 + 每候选的分数与场次 + 复用来源）。 */
const OPTIMIZATION_GRID_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "feedbackRounds", "plan", "sparring", "candidates"],
  properties: {
    version: { type: "integer", const: OPTIMIZATION_GRID_VERSION },
    feedbackRounds: { type: "integer", const: OPTIMIZATION_FEEDBACK_ROUNDS },
    // 计划正文（不含方言声明）；「能否由事实重建」归 runner 的 `checkTrialPlan`。
    plan: TRIAL_PLAN_JSON_SHAPE,
    sparring: {
      type: "array",
      minItems: TRIAL_SPARRING_ROLE_ORDER.length,
      maxItems: TRIAL_SPARRING_ROLE_ORDER.length,
      items: TRIAL_PLAN_SCRIPT_JSON_SCHEMA,
    },
    candidates: {
      type: "array",
      minItems: OPTIMIZATION_STAGES.length,
      maxItems: OPTIMIZATION_STAGES.length,
      items: OPTIMIZATION_CANDIDATE_GRID_JSON_SCHEMA,
    },
  },
} as const;

/** 一步的动作：判别联合（`bash` / `evaluate` / `done`）。`smoke` 不在 v3 的联合里。 */
const ARCHIVE_STEP_ACTION_JSON_SCHEMA = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "command"],
      properties: {
        kind: { type: "string", const: "bash" },
        command: { type: "string", minLength: 1 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: { kind: { type: "string", const: "evaluate" } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: { kind: { type: "string", const: "done" } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: { kind: { type: "string", const: "none" } },
    },
  ],
} as const;

/** 结果侧证据：驱动来源与编译错误码（发送侧证据在 `generationLog` 里，不在这里）。 */
const ARCHIVE_STEP_RESULT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "errorCodes"],
  properties: {
    kind: { type: "string", enum: ["tsc", "contract"] },
    errorCodes: { type: "array", items: { type: "string", minLength: 1 } },
  },
} as const;

/**
 * 一步的过程记录条目：最小键集合现在定死（装载器要靠它判完整性）。
 *
 * `stdout` / `stderr` 不写 `minLength`：空输出是合法事实。`raw` 与 `result` 可选，
 * 且它们的缺席不是「不完整」——ADR-0031 已把「可选键不升形状版本」定成先例。
 */
export const ARCHIVE_STEP_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["step", "action", "stdout", "stderr", "exitCode", "atMs", "harnessMs"],
  properties: {
    step: { type: "integer", minimum: 1 },
    action: ARCHIVE_STEP_ACTION_JSON_SCHEMA,
    stdout: { type: "string" },
    stderr: { type: "string" },
    exitCode: { type: "integer" },
    raw: { type: "string" },
    atMs: { type: "integer", minimum: 0 },
    harnessMs: { type: "integer", minimum: 0 },
    result: ARCHIVE_STEP_RESULT_JSON_SCHEMA,
  },
} as const;

/** v3 的候选：无 `stage`，`step` 是那次 `evaluate` 的步号；`score` / `matchCount` 必填。 */
export const ARCHIVE_OPTIMIZATION_CANDIDATE_AGENT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["step", "scriptFile", "observationsFile", "scriptSha256", "score", "matchCount"],
  properties: {
    step: { type: "integer", minimum: 1 },
    scriptFile: { type: "string", pattern: "^(?!.*\\.\\.)[A-Za-z0-9][A-Za-z0-9._-]*$" },
    observationsFile: {
      type: "string",
      pattern: "^(?!.*\\.\\.)[A-Za-z0-9][A-Za-z0-9._-]*$",
    },
    scriptSha256: SHA256,
    params: {
      type: "object",
      description: "这一次 `evaluate` 时实际发出的生成参数（端点原生形状，原样落档）。",
    },
    score: TRIAL_GRID_SCORE_JSON_SCHEMA,
    matchCount: { type: "integer", const: TRIAL_MATCHES_PER_CANDIDATE },
  },
} as const;

/** v3 的优化段：只有 `{version, candidates}`；条数 1..3（三次评测是上限，不是下限）。 */
const OPTIMIZATION_AGENT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "candidates"],
  properties: {
    version: { type: "integer", const: OPTIMIZATION_AGENT_VERSION },
    candidates: {
      type: "array",
      minItems: 1,
      maxItems: OPTIMIZATION_CANDIDATE_LIMIT,
      items: ARCHIVE_OPTIMIZATION_CANDIDATE_AGENT_JSON_SCHEMA,
    },
  },
} as const;

/**
 * 冻结脚本存档 `meta.json` 的 JSON Schema(hld §2.2.5:形状定义归真源包所有)。
 *
 * 与 `MAP_JSON_SCHEMA` / `RULESET_JSON_SCHEMA` 同纪律:
 * - `additionalProperties: false` 一律关掉,**含嵌套**(`validation` 那一层)。不关掉的话,
 *   手写 schema 只是一份注释,而且会让人以为「存档已校验」。
 * - 形状之外一概不管:版本三处一致、`scriptSha256` 与实测是否相等、`protocolRounds`
 *   与 `prompts.length` 是否相等,都是**跨字段**判断,draft-07 表达不了,归 `apps/cli`。
 * - **刻意不写放行额外属性的空 schema**,也不写半截字段(理由见头注与 `pending.ts` 头注)。
 */
export const ARCHIVE_META_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "model-war 冻结脚本存档 meta",
  description:
    "冻结脚本存档的元数据(hld §7.4),十一项全部必填。形状由本文件一次定死,生成管线落地时只填值;" +
    "版本三处一致、产物哈希与实测是否相等、轮数与 prompt 条数是否相等,由 apps/cli 在装载期判," +
    "本 schema 只管单份 JSON 的形状。",
  type: "object",
  additionalProperties: false,
  required: REQUIRED_KEYS,
  properties: {
    archiveSchemaVersion: {
      type: "integer",
      const: ARCHIVE_SCHEMA_VERSION,
      description:
        "档案形状版本(读兼容契约)。新档必写、历史档缺席;不认识的版本拒读而不是猜。它与优化段版本、harness 身份三者各管一件事。",
    },
    contextLength: {
      type: "integer",
      minimum: 1,
      description:
        "模型席位的上下文窗口(token)。档案自足优先:历史报告不用今天的 models.yaml 解释昨天的行为。它不进 harnessDigest——窗口是席位的属性,塞进 digest 会让同一个 harness 在两个窗口不同的模型上算出两个身份。",
    },
    harnessVersion: {
      type: "string",
      minLength: 1,
      description: "harness 的叙事版本(如 bash-mini/0.1):人维护的「模型面对的世界」的代号。",
    },
    harnessDigest: {
      ...SHA256,
      description:
        "harness 行为清单的 sha256(动作语法、可见二进制、挂载、网络、配额、服务、观测出口、deadline、截断上限与比例、守卫、工具链、done 语义)。清单不含档案形状与退避参数。",
    },
    termination: {
      enum: ARCHIVE_TERMINATIONS,
      description:
        "这一次会话是怎么停的。与落档判据正交:done / 步数耗尽 / 墙钟耗尽 / 上下文守卫 / 动作解析失败 / 传输耗尽都立即停,有候选就是成功档。",
    },
    atStep: {
      type: "integer",
      minimum: 0,
      description: "终止发生在第几步(0 = 一次模型调用都没有成功)。",
    },
    steps: {
      type: "array",
      description:
        "过程记录:一步一条(一次模型调用 = 一步),与协议轮数同义,零步会话写空数组。它不进优化段——优化段装的是产物,过程记录装的是经过。",
      items: ARCHIVE_STEP_JSON_SCHEMA,
    },
    model: {
      type: "string",
      minLength: 1,
      description: "模型名。与 archive/<modelSlug>/<runId>/ 的目录名同源(hld §7.4 的拓扑)。",
    },
    modelVersion: {
      type: "string",
      minLength: 1,
      description:
        "模型版本/快照标识。模型侧按**快照**冻结而不按 git tag 冻结,故这是一格而不是两格:同一个版本号对应多份快照时,复算要认的是后者。",
    },
    channelId: {
      type: "string",
      minLength: 1,
      description:
        "渠道身份(含档位,如 commandcode-goat-2026-11)。榜键四维之一:同一 baseUrl 可以挂多个档位,差别在可用 modelId 与配额窗口,从 URL 推不出来。**刻意不进 required**:本字段出现前冻结的历史档没有它,回填等于伪造证据。",
    },
    generatedAt: {
      type: "string",
      minLength: 1,
      description: "生成日期,冻结时刻。只作留档,任何计算都不读它,所以不约束它的具体格式。",
    },
    protocolRounds: {
      type: "integer",
      minimum: 0,
      description:
        "协议迭代轮数。与 prompts 的长度**双存**,装载期断言两者相等(双存的理由同 spawnTicks:两处都留才既可读又可判)。v3 档案里它等于 steps 的条数(一次模型调用 = 一步 = 一轮),起始 prompt 的条数则是零步为零、否则为一。",
    },
    prompts: {
      type: "array",
      description:
        "逐轮完整 prompt,下标即轮次。刻意不写成带元字段的对象:现在每轮除了文本没有别的可填字段,一个空框架是负债(同 MapVariantSlot 头注里「不是带语义字段的对象」那一条)。",
      items: { type: "string", minLength: 1 },
    },
    generationLog: {
      type: "array",
      description: "生成日志,逐行一条。",
      items: { type: "string", minLength: 1 },
    },
    ruleset: {
      type: "string",
      pattern: "^v[0-9]+$",
      description:
        "冻结这份脚本时所用的规则集版本。必须与本仓版本常量、rulesets/vN.json 的文件名、docs/rules-vN/ 的目录名一致,装载期错配即拒跑,不静默降级(hld §7.1)。",
    },
    validation: {
      type: "object",
      description:
        "静态校验器(hld §6.2)那一次的结论。结论与失败条目两格都必填:「没失败」与「没查」不是同一件事。",
      additionalProperties: false,
      required: ["passed", "errors"],
      properties: {
        passed: { type: "boolean", description: "静态校验是否通过。" },
        errors: {
          type: "array",
          description: "面向作者的失败条目;通过时取空数组。",
          items: { type: "string", minLength: 1 },
        },
      },
    },
    tscVersion: {
      type: "string",
      minLength: 1,
      description:
        "把 script.ts 编译成 script-mode script.js 的 tsc 版本(hld §6.2/§7.4)。复算要能对上同一版编译器。",
    },
    scriptSha256: {
      ...SHA256,
      description:
        "script.js 的 sha256。**复算认编译产物,不认定版源码**——同一份 script.ts 换一版 tsc 会产出不同的 script.js,所以哈希取在产物这一侧。装载期与实测比对,不等即拒跑。",
    },
    selection: {
      // 与 `optimization` 同一条纪律：三版是**三个完整形状**（各自的 `additionalProperties: false`
      // 与必填集），所以 v1 档带 `plan.seeds` / v2 档带 `plan.scripts` / v3 档带 `stage` 都只能
      // 匹配上自己那一支，而不是被宽松放行。历史档不迁移，三种形状同时合法。
      oneOf: [
        ARCHIVE_SELECTION_JSON_SCHEMA,
        ARCHIVE_GRID_SELECTION_JSON_SCHEMA,
        ARCHIVE_AGENT_SELECTION_JSON_SCHEMA,
      ],
    },
    optimization: {
      // 版本分派：三版是**三个完整形状**（各自的 `additionalProperties: false` 与必填集），
      // 所以 v1 档带 `plan` / v2 档缺 `plan` / v3 档带 `stage` 都只能匹配不上，而不是被宽松放行。
      // 用 `oneOf` 而不是就地改 `const`：历史档不迁移，三种形状同时合法。
      oneOf: [
        OPTIMIZATION_V1_JSON_SCHEMA,
        OPTIMIZATION_GRID_JSON_SCHEMA,
        OPTIMIZATION_AGENT_JSON_SCHEMA,
      ],
    },
    sandboxRuntimeHash: {
      ...SHA256,
      description:
        "沙箱 runtime 的 hash(hld §5)。同一个脚本换一副沙箱跑,结果不保证一致,故它与产物哈希同样是必检项。",
    },
  },
} as const;
