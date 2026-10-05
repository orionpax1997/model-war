/**
 * 冻结脚本存档的 `meta.json` 形状(hld §7.4)。**类型与 JSON Schema 同文件、同一次书写**,
 * 纪律与 `map.ts` 一致:TypeScript 是真源、JSON Schema 手工对齐(ADR-0003),
 * 漂移由 `apps/cli` 校验器那条缝的双过 fixture 与「必填键集合 === 键联合」的类型级断言兜住。
 *
 * ── 十一项逐项来自 hld §7.4(`docs/hld.md:714-715`),不是本文件的取舍 ────────────
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
 * | sandbox-runtime hash | `sandboxRuntimeHash` | 同一个脚本换一副沙箱跑,结果不保证一致(FR-3) |
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
 * (hld §3.2、spec《校验器:落在 CLI 应用》)。跨字段判据(版本三处一致、哈希与实测是否相等、
 * 轮数与 prompt 条数是否相等)归 `apps/cli` 的装载期断言。
 */

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

/** 冻结脚本 `meta.json` 的全部内容。十一项**全部必填**,没有可选键。 */
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
    sandboxRuntimeHash: {
      ...SHA256,
      description:
        "沙箱 runtime 的 hash(hld §5)。同一个脚本换一副沙箱跑,结果不保证一致(FR-3),故它与产物哈希同样是必检项。",
    },
  },
} as const;
