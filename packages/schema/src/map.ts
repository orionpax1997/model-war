/**
 * 地图形状(hld §7.2)。**类型与 JSON Schema 同文件、同一次书写**。
 *
 * 为什么同文件:两者是同一份形状的两种表述(ADR-0003 的裁决是「TypeScript 是上游、
 * JSON Schema 手工对齐,不引代码生成」),而手工对齐的失败模式从来不是「写不出来」,
 * 是「改了一处忘了另一处」。放进同一个模块,让两处贴在一起,靠阅读就能发现漂移;
 * 真正的兜底在 `apps/cli` 的校验器那条缝上:一组 fixture 两侧都过,加一条类型级断言
 * 要求「schema 的必填键集合」等于「类型的键联合」。
 *
 * 本模块**不含运行时代码**:交付的是数据(常量)与类型。ajv 校验器不在这儿
 * ——真源包不依赖任何包,也不能依赖 ajv(hld §3.2、spec《校验器:落在 CLI 应用》)。
 *
 * 逐条约束的归属:hld §7.2 给的是字段与形态,点位与单位类型的**取值集合**归 gdd,
 * 尺寸/坐标的**跨字段自洽**(terrain 的行长等于 size、点位不越界、四重对称)归 map-lint。
 * 本模块只管「单份 JSON 自身是否长得对」,管不到跨字段那条线。
 */

import type { RulesetVersion } from "./index.js";

/** 点位种类。取值的语义归 gdd《地图与点位》:主基地与资源点两类,中立与否由 initialOwner 表达。 */
export type MapSiteKind = "base" | "resource";

/**
 * 地图上声明的一个点位。坐标是网格坐标,原点与朝向由地图图(A 节点)定稿;
 * 这里只保证是非负整数,不与 size 比较(跨字段约束 map-lint 才管得了)。
 */
export type MapSite = {
  readonly id: number;
  readonly kind: MapSiteKind;
  readonly x: number;
  readonly y: number;
  /**
   * 开局属主的座位号;`null` = 中立点。gdd 明确中立基地与「其余点为中立」是既有设计,
   * 所以中立必须可表达——把它写死成整数会让一张合法地图在装载期被拒。
   */
  readonly initialOwner: number | null;
};

/**
 * 初始单位。围绕主基地摆放,**由地图声明,引擎不硬编码**(hld §7.2)。
 * `type` 此刻是自由字符串:四条兵种线的键名归 gdd 与规则集那一侧(02 票),
 * 在两处各定一份兵种名集合只会造出第二真源。
 */
export type MapSpawnUnit = {
  readonly owner: number;
  readonly type: string;
  /** 相对该方主基地的偏移 `[dx, dy]`。 */
  readonly offset: readonly [number, number];
};

/** 一个网格坐标对 `[x, y]`。模块内的别名,不对外再导出——本文件对外的名字只有下面那两个。 */
type GridCoord = readonly [number, number];

/**
 * 变体槽位的元素形状:**一条完整四重旋转轨道的 4 个坐标对**。
 *
 * ── 为什么取定长 4 元组,而不是「数组 + 长度断言」 ────────────────────────────
 * 「一个槽位 = 一条完整四重轨道」是本类型的**全部**内容。长度 4 一旦落在类型上,
 * 构造不出来的数据就构造不出来:引擎侧把四个坐标填进去,对称性自动成立,不必在运行时
 * 重新实现一次旋转。于是 map-lint 的对称断言从「旋转之后整张图自洽」退化成「这 4 格是不是
 * 其中某格的旋转轨道」,而后者在类型层面已经几乎保证了——**不变量从运行时断言挪进了类型层**。
 *
 * 另两条被否掉的取法各有一句理由:**不是「一个代表元坐标」**,那会把旋转塞回引擎(多一层间接),
 * 而校验器照样要重算轨道才能判;**不是「一个带语义字段的对象」**,现在没有语义可填,
 * 一个空框架是负债,等有语义时再加字段比先留位置便宜。
 *
 * 「槽位不得压点位及其八邻域」「槽位格不得与地形里已有的墙格重叠」都是**跨字段**判据,
 * JSON Schema 表达不了,归 map-lint;本类型管不到,也不试图管。
 *
 * ── 历史注记(已回填,留档) ───────────────────────────────────────────────────
 * 本类型一度取 `JsonValue`,JSON Schema 侧对应一个不带任何约束的元素 schema。当时的推理是:
 * **写窄一点就是替地图图做决定**,而替它做决定的后果是那次回填变成返工而不是计划内变更——
 * 那时连「一个槽位是不是对象」都不知道,它也可能是一段轴索引或一个坐标对。
 * 地图图已经产出地图,这个前提没了,于是收成上面的形状。**留这段不是怀旧**:后来者若想再把
 * 类型放宽回 `JsonValue`,应当先看见当初量到了什么,而不是把同一个问题重新论证一遍。
 */
export type MapVariantSlot = readonly [GridCoord, GridCoord, GridCoord, GridCoord];

/** 一张地图的全部内容(hld §7.2 的七字段)。七个字段全部必填,没有可选键。 */
export type MapDefinition = {
  readonly name: string;
  readonly size: number;
  readonly rulesetMin: RulesetVersion;
  readonly terrain: readonly string[];
  readonly sites: readonly MapSite[];
  readonly spawnUnits: readonly MapSpawnUnit[];
  readonly variantSlots: readonly MapVariantSlot[];
};

/**
 * 地图的 JSON Schema(hld §2.2.5:形状定义归真源包所有)。
 *
 * 以导出的**数据对象**形态存在而不是独立 `.json` 文件(ADR-0003):ajv 接受 JS 对象,
 * 而 `description` 是写给模型看的说明,写在 `.ts` 里自然,顺带避开 `resolveJsonModule`
 * 与本仓库编译配置的组合风险。
 *
 * 两条纪律:
 * - `additionalProperties: false` 一律关掉。这是「类型是真源、schema 手工对齐」这条路线
 *   的主要代价补偿——不关掉的话,手写 schema 只是一份注释。
 * - 形状之外一概不管:规则版本的下界是**跨字段的版本比较**,JSON Schema 表达不了,
 *   由 `apps/cli` 的校验器在装载期判。
 */
export const MAP_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "model-war 地图定义",
  description:
    "一张地图的静态数据(hld §7.2)。跨字段自洽(terrain 行长等于 size、点位不越界、四重对称)由 map-lint 判,本 schema 只管单份 JSON 的形状。",
  type: "object",
  additionalProperties: false,
  required: ["name", "size", "rulesetMin", "terrain", "sites", "spawnUnits", "variantSlots"],
  properties: {
    name: {
      type: "string",
      minLength: 1,
      description: "地图标识。地图池内唯一,是 input.json 与回放里认地图的依据。",
    },
    size: {
      type: "integer",
      minimum: 1,
      description:
        "网格边长。terrain 的行数与每行长度都必须等于它——这是跨字段约束,JSON Schema 表达不了,归 map-lint。",
    },
    rulesetMin: {
      type: "string",
      pattern: "^v[0-9]+$",
      description:
        "本地图要求的**最低**规则集版本。判据是 `1 ≤ rulesetMin ≤ RULESET_VERSION`(v0 之类未发布过的版本不认);规则集升到 v2 时声明 v1 的图仍合法,不必改图。错配在装载期拒跑,不静默降级。",
    },
    terrain: {
      type: "array",
      minItems: 1,
      description: "行字符串,'.'=平原,'#'=墙。",
      items: { type: "string", pattern: "^[.#]+$" },
    },
    sites: {
      type: "array",
      minItems: 1,
      description:
        "点位。数量不变量(每方主基地数、资源点成组)由 gdd 规定、由 map-lint 断言,这里只管形状。",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "x", "y", "initialOwner"],
        properties: {
          id: { type: "integer", minimum: 0, description: "点位编号,对局内唯一。" },
          kind: {
            type: "string",
            enum: ["base", "resource"],
            description: "点位种类:主基地或资源点。",
          },
          x: { type: "integer", minimum: 0, description: "网格横坐标。" },
          y: { type: "integer", minimum: 0, description: "网格纵坐标。" },
          initialOwner: {
            type: ["integer", "null"],
            description: "开局属主的座位号;null = 中立点(gdd 明确存在中立基地与中立资源点)。",
          },
        },
      },
    },
    spawnUnits: {
      type: "array",
      minItems: 1,
      description: "初始单位,围绕主基地摆放,由地图声明,引擎不硬编码。",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["owner", "type", "offset"],
        properties: {
          owner: { type: "integer", minimum: 0, description: "属主座位号。" },
          type: {
            type: "string",
            minLength: 1,
            description: "兵种名。取值集合归 gdd 与规则集那一侧,这里不复制第二份名单。",
          },
          offset: {
            type: "array",
            minItems: 2,
            maxItems: 2,
            description: "相对该方主基地的偏移 [dx, dy]。",
            items: { type: "integer" },
          },
        },
      },
    },
    variantSlots: {
      type: "array",
      description:
        "变体槽位:**静态候选轨道清单**。每个元素是一条完整四重旋转轨道的 4 个坐标对,种子只决定从候选里选哪些填上墙(不计入风格多样性,见 gdd《地图变体》)。候选是否压住点位及其八邻域、是否与地形里已有的墙格重叠,是跨字段判据,归 map-lint。",
      items: {
        type: "array",
        minItems: 4,
        maxItems: 4,
        description: "一条完整四重旋转轨道:恰好 4 个坐标对。",
        items: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          description: "一个网格坐标 [x, y]。",
          items: { type: "integer", minimum: 0 },
        },
      },
    },
  },
} as const;
