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

import type { JsonValue, RulesetVersion } from "./index.js";

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

/**
 * 变体槽位的元素形状——**过渡形态,尚未定稿**。
 *
 * 槽位的字段形状随 gdd《开放项》#2 的地图设计一并定稿(hld §7.2 原话)。
 * 在那之前,本类型取 `JsonValue`:我们连「一个槽位是不是对象」都不知道——
 * 槽位也可能是一段轴索引或一个坐标对。**写窄一点就是替地图图做决定**,
 * 而替它做决定的后果是 A 节点回来时那次回填变成返工,而不是计划内变更。
 *
 * 因此 JSON Schema 侧对应的是一个**不带任何约束**的 schema,`description` 里同样写着
 * 「待 A 节点回填」。回填时这三处(本类型、schema 的 description、map-lint 的四重对称断言)
 * 一次改完。
 */
export type MapVariantSlot = JsonValue;

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
      // **过渡形状,待地图图(A 节点)回填**:元素刻意不加任何约束。
      // 槽位要表达什么目前没有定论,写窄就是替地图图做决定;空 schema 的含义是
      // 「这里不校验」而不是「这里没有形状」,回填的触发条件是 A 节点产出地图图。
      description:
        "变体槽位(待回填):**元素形状尚未定稿**,等地图图(A 节点)定 gdd《开放项》#2 后一次回填(本 schema + MapVariantSlot 类型 + map-lint 的四重对称断言)。当前元素不施加任何约束;它同时被 map-lint 施加四重旋转对称的断言。",
      items: {},
    },
  },
} as const;
