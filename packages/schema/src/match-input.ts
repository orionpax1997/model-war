/**
 * 单个对局的输入物化件 `input.json` 的形状(hld §7.4 末条:「4 × 存档路径 + 地图 + 种子 +
 * ruleset 版本 + 各文件 hash」)。**类型与 JSON Schema 同文件、同一次书写**,纪律与
 * `map.ts` 一致(ADR-0003:TypeScript 是真源,JSON Schema 手工对齐)。
 *
 * ── 这一格是「形状定死,不加 PENDING_SHAPES 条目」 ────────────────────────────
 *
 * `pending.ts` 原来挂着的那三条的共同特征是「字段随那一票的实现才确定」,而本形状的字段
 * 已被 hld §7.4 **逐项列全**,不属那一类。所以它不进 `PENDING_SHAPES`——留成 pending 意味着
 * 要么写一份 `pending.ts` 头注明令禁止的放行额外属性的空 schema,要么跳过读入端校验,
 * 两条都是那条纪律点名要拒的(理由逐字记在 `pending.ts` 里,不在这里重复)。
 *
 * ── 它不含赛季配置,这一条是硬约束 ────────────────────────────────────────────
 *
 * 赛季配置(`season.yaml`:参赛名单、地图池、种子数、并发度、名次分)归 hld §8,**不进本文件**。
 * 理由不是洁癖:FR-7 AC3 要的是「任意一个对局可凭 input.json 复算」,而复算一件对局只需要
 * 座位上的四份存档、一张地图、一个种子、一份规则集。塞进赛季参数之后,这份文件就会长成
 * 第二个 `season.yaml`,而它的生命周期是**每场一份**——一个每场一份的赛季配置既复算不了什么,
 * 又让「这份对局用的是哪套赛季参数」这个问题有两个家。头注里把这条写死,是因为后来者
 * 「顺手把并发度也带上」几乎不需要理由。
 *
 * ── 形状一次定死 ────────────────────────────────────────────────────────────
 * 字段与嵌套形状由本文件定死,runner 的物化那一票**只填值**;改字段要走一次有意的变更
 * (理由与 `archive-meta.ts` 同一条:已落库的对局输入会被报告与复算链引用)。
 *
 * ── 本模块不含运行时代码 ────────────────────────────────────────────────────
 * ajv 校验器不在这儿(真源包不依赖任何包,hld §3.2);跨字段判据(规则集版本三处一致、
 * 各文件哈希与实测是否相等)归 `apps/cli` 的装载期断言。
 */

/** 一个座位上的参赛者:存档路径与那一份存档的文件哈希。数组下标即座位号 `playerIndex`。 */
export type MatchInputArchive = {
  /** 存档路径 `archive/<modelSlug>/<runId>/`。 */
  readonly archivePath: string;
  /** 该存档 `script.js` 的 sha256(小写十六进制 64 位)。复算认编译产物。 */
  readonly scriptSha256: string;
  /** 该存档 `meta.json` 的 sha256(小写十六进制 64 位)。 */
  readonly metaSha256: string;
};

/** 座位数。四人对称(PRD 定位),故取**定长 4 元组**而不是「数组 + 长度断言」。 */
export type MatchInputArchives = readonly [
  MatchInputArchive,
  MatchInputArchive,
  MatchInputArchive,
  MatchInputArchive,
];

/** 单个对局的输入物化件。五项**全部必填**,没有可选键。 */
export type MatchInput = {
  /** 四方存档,**下标即座位号 0..3**。故座位不需要另立一格:错位的风险是「谁坐哪」写错,而不是「座位」缺一格。 */
  readonly archives: MatchInputArchives;
  /** 地图标识,与 `maps/*.json` 里的 `name` 同名(地图池内唯一)。 */
  readonly map: string;
  /** 该地图 JSON 文件的 sha256(小写十六进制 64 位)。 */
  readonly mapSha256: string;
  /** 种子。规则集本身无对局内随机过程,种子驱动地图变体(hld §7.3)。 */
  readonly seed: number;
  /** 本对局所用的规则集版本,必须与本仓版本常量、取值文件名、规则文档目录名三处一致。 */
  readonly ruleset: string;
};

/** 键序即 `required` 序、`input.json` 的书写序,不容另定一处。 */
const REQUIRED_KEYS = ["archives", "map", "mapSha256", "seed", "ruleset"] as const;

/** sha256 的形状:小写十六进制 64 位。散列的**表示**归本 schema,取值比对归装载期。 */
const SHA256 = {
  type: "string",
  pattern: "^[0-9a-f]{64}$",
} as const;

/**
 * 对局输入 `input.json` 的 JSON Schema(hld §2.2.5:形状定义归真源包所有)。
 *
 * 与另两份同纪律:`additionalProperties: false` 一律关掉(**含嵌套**,`archives` 的元素那一层);
 * 跨字段判据(规则集版本三处一致、各文件哈希与实测是否相等)归 `apps/cli` 在装载期判。
 */
export const MATCH_INPUT_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "model-war 对局输入物化件",
  description:
    "单个对局的输入物化件 input.json(hld §7.4):4 × 存档路径 + 地图 + 种子 + 规则集版本 + 各文件 hash。" +
    "**不含赛季配置**——赛季配置归 hld §8,复算一件对局只需要座位上的四份存档、一张地图、一个种子与一份规则集。" +
    "版本三处一致与哈希比对由 apps/cli 在装载期判,本 schema 只管单份 JSON 的形状。",
  type: "object",
  additionalProperties: false,
  required: REQUIRED_KEYS,
  properties: {
    archives: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      description:
        "四方存档,下标即座位号 playerIndex(0..3)。座位轮换由 runner 在物化时算好落进这个下标(hld §8.1)," +
        "本文件只承载结果。",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["archivePath", "scriptSha256", "metaSha256"],
        properties: {
          archivePath: {
            type: "string",
            minLength: 1,
            description: "存档路径 archive/<modelSlug>/<runId>/。",
          },
          scriptSha256: {
            ...SHA256,
            description: "该存档 script.js 的 sha256。复算认编译产物,不认定版源码。",
          },
          metaSha256: {
            ...SHA256,
            description:
              "该存档 meta.json 的 sha256。meta 同样要钉住:换一份 meta 换的就是另一份存档。",
          },
        },
      },
    },
    map: {
      type: "string",
      minLength: 1,
      description: "地图标识,与 maps/*.json 里的 name 同名。",
    },
    mapSha256: {
      ...SHA256,
      description: "地图 JSON 文件的 sha256。地图被改过而种子不变,变体就会在另一个地形上落。",
    },
    seed: {
      type: "integer",
      minimum: 0,
      description: "种子,驱动地图变体的确定性选择(hld §7.3)。",
    },
    ruleset: {
      type: "string",
      pattern: "^v[0-9]+$",
      description:
        "本对局所用的规则集版本。必须与本仓版本常量、rulesets/vN.json 的文件名、docs/rules-vN/ 的目录名三处一致,错配即拒跑(hld §7.1)。",
    },
  },
} as const;
