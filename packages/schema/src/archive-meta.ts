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

import { ARCHIVE_SELECTION_JSON_SCHEMA, type ArchiveSelection } from "./selection-plan.js";
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
export const OPTIMIZATION_FEEDBACK_ROUNDS = 2 as const;
export const OPTIMIZATION_STAGES = [0, 1, 2] as const;

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

export type ArchiveOptimization = ArchiveOptimizationV1 | ArchiveOptimizationGrid;

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
};

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
    generatedAt: {
      type: "string",
      minLength: 1,
      description: "生成日期,冻结时刻。只作留档,任何计算都不读它,所以不约束它的具体格式。",
    },
    protocolRounds: {
      type: "integer",
      minimum: 0,
      description:
        "协议迭代轮数。与 prompts 的长度**双存**,装载期断言两者相等(双存的理由同 spawnTicks:两处都留才既可读又可判)。",
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
    selection: ARCHIVE_SELECTION_JSON_SCHEMA,
    optimization: {
      // 版本分派：两版是**两个完整形状**（各自的 `additionalProperties: false` 与必填集），
      // 所以 v1 档带 `plan` / v2 档缺 `plan` 都只能匹配不上，而不是被宽松放行。
      // 用 `oneOf` 而不是就地改 `const`：历史档不迁移，两种形状同时合法。
      oneOf: [OPTIMIZATION_V1_JSON_SCHEMA, OPTIMIZATION_GRID_JSON_SCHEMA],
    },
    sandboxRuntimeHash: {
      ...SHA256,
      description:
        "沙箱 runtime 的 hash(hld §5)。同一个脚本换一副沙箱跑,结果不保证一致,故它与产物哈希同样是必检项。",
    },
  },
} as const;
