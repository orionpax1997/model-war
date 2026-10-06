/**
 * 参赛脚本的**类型面**:脚本 API 的类型声明(hld §6.2「API 误用」那一行读的就是它)。
 *
 * ── 为什么它是全局声明而不是一个模块 ─────────────────────────────────────────
 * 参赛脚本是**单文件自包含**的一份 `script.ts`:它不从任何地方取模块,编译配置刻意不给模块解析器,
 * 所以它能引用的类型名只有这一个文件里声明的那些。所以本文件是 ambient(无 import/export),
 * 经 `tsconfig.scripts.json` 的 `typeRoots` + `types` 引入——而 `types` 是**唯一**引入它的位置。
 *
 * 放在 `packages/schema/script-api/` 而不是 `packages/schema/src/`:src 下的一切都进 `tsc -b packages/schema`
 * 的 program,一份 ambient 的全局声明进去之后,整个仓库的构建都会看见 `getTick` / `move` / `Snapshot`
 * 这些名字——于是仓库代码可以引用它们,而脚本侧引不引得到它们反倒没人管了。本目录在 src 之外,
 * 从不进任何 program(hld §3.2「本包无运行时代码」),对外的模块面也不受它影响(ADR-0003:
 * 模块面只有 `packages/schema/src/index.ts` 一个入口,本文件不是其中之一,因为它根本不是模块)。
 *
 * ── 与那张符号表是同源的两张脸,不是两处定义 ─────────────────────────────────
 * `packages/schema/src/script-surface.ts` 那张表回答「脚本运行时能拿到哪些**名字**」;
 * 本文件回答「拿到的那些值的**形状**对不对、参数给不给得过」。名字只有表里那一处,
 * 形状只有本文件这一处:两者由 `packages/tools/src/script-api/declarations.ts` 的严格读法
 * 在编译期与生成期各查一次对齐(22 个值逐条,不多不少)。
 *
 * 收录判据与符号表同一条,逐字照搬:**收脚本在运行时能把它当值用到的名字;不产生运行时值的名字一律不收。**
 * 所以下面这些 `type` 声明(擦掉类型标注后什么也不剩)对脚本是**不可引用**的值——它们是形状,
 * 不是能调的东西。而**数值一个都不在这里**:HP、造价、射程、预算、阈值全部归 `rulesets/*.json`
 * 那条生成链,在这里写死一个取值就是同一份事实第二个家。
 *
 * ── 为什么整份快照是深只读的 ─────────────────────────────────────────────────
 * 意图的 `check()` 的入参就是下面这份 `Snapshot`,而它**一个可写字段都没有**:不是靠「大家记得
 * 别改」,是类型形状里根本没有写入口。「`check()` 不会写引擎状态」因此是**类型事实**而不是纪律——
 * 一旦这份声明里给了写入口,那句话就退化成一句需要人遵守的约定,而引擎状态是全局唯一的对局真值。
 * (`apply()` 是唯一写入口,那是引擎内部的事,脚本侧连它的名字都看不见。)
 *
 * ── 与沙箱执行器的那条同步面 ────────────────────────────────────────────────
 * 类型面(形状)归本 feature;注入面(这些名字铺进 guest 的时机、桥函数在初始化后怎么删)归沙箱执行器。
 * 两者**同源于这一份形状,但只有一份形状**:某个名字在这里声明了而注入面铺不出来,
 * 那是注入面的缺陷,不是「这里漏了一个名字」。往这张脸补名字的唯一理由是形状变了,不是「沙箱那边少一个」。
 */

/** 座位下标。四方对称,固定 0..3。 */
type PlayerIndex = 0 | 1 | 2 | 3;

/** 点位属主:座位或中立(`-1`)。比座位号宽一格,因为点位可以被中立占着。 */
type Owner = -1 | PlayerIndex;

/** 四个兵种。数值属性(造价/速度/射程)不在这里,归 `rulesets/*.json`。 */
type UnitType = "worker" | "melee" | "ranged" | "cavalry";

/** 两类点位:基地与资源点。 */
type SiteKind = "base" | "resource";

/** 一条产线当前的订单:正在造哪个兵种、还要几个 tick。 */
type SiteProduction = { readonly type: UnitType; readonly remainingTicks: number };

/** 一个座位在快照里可读的四项。**座位号不在 `Player` 上也不在快照上**,只由 `getMyIndex()` 给出。 */
type Player = {
  /** 座位号 0..3。四方对称开局,这一栏是编号,不是靠位置反推出来的。 */
  readonly index: PlayerIndex;
  /** 全局共享资源池里的钱,无上限、不按基地分池。下单从这里扣。 */
  readonly resources: number;
  /** 本方是否还在局里。`false` 表示已被淘汰。 */
  readonly alive: boolean;
  /** 累计异常 tick 数。用来知道自己离判负出局还有多远。 */
  readonly exceptionTicks: number;
};

/** 一个单位在快照里可读的七项。 */
type Unit = {
  readonly id: number;
  readonly owner: PlayerIndex;
  readonly type: UnitType;
  readonly x: number;
  readonly y: number;
  readonly hp: number;
  /** 农民携带量;其余兵种恒为 0。 */
  readonly carrying: number;
};

/**
 * 一个点位在快照里可读的全部字段。
 *
 * 产线的当前订单是**点位上的那一个字段** `producing`,不是一张独立的队列表:一次只有一单,
 * 重复下单被静默丢弃(不扣款、不计异常、也不是错误码——别去 `isError` 它),正确写法是先读这一栏、
 * 是 `null` 才下单。这份形状与引擎的状态模型是**同一条形状**,不是它的投影。
 */
type Site = {
  readonly id: number;
  readonly kind: SiteKind;
  readonly x: number;
  readonly y: number;
  /** `-1` 是中立。 */
  readonly owner: Owner;
  /** 正在累积占领进度的那一方,进度落在 `progress` 上。 */
  readonly progressOwner: Owner;
  readonly progress: number;
  /** 仅资源点有:这个矿还剩多少资源。键不存在 = 不是资源点,`0` = 是资源点但已采空,两件事不压成一个取值。 */
  readonly remaining?: number;
  /** 这一条产线当前的订单,没有订单时是 `null`。开局每条产线都是空的。 */
  readonly producing: SiteProduction | null;
};

/**
 * 这一 tick 脚本能读到的全部状态。
 *
 * 刻意**不是**引擎状态的一个子集视图:快照是另一份逐字列出的形状,引擎内部的字段(对象 id 的分配器、
 * 终局结果之类)不在里面,别去找。加一栏引擎字段**不会**顺手把那一栏塞进脚本可见面。
 *
 * **座位不在这里。** 没有 `you`、没有 `isSelf`、也没有「自己那一号」这一栏——座位只从 `getMyIndex()` 读,
 * 那是它唯一的入口,这一格不留第二个。脚本也拿不到 `Snapshot` 这个对象本身:它通过 §3 那些查询函数读,
 * 而每个查询函数返回的都只是**本 tick 的副本**,下一 tick 全部作废,所以别把对象缓存到模块级变量里。
 */
type Snapshot = {
  readonly tick: number;
  readonly players: readonly Player[];
  readonly units: readonly Unit[];
  readonly sites: readonly Site[];
};

/**
 * `getObjectsByType("unit", …)` 的过滤条件。
 *
 * **`owner` 刻意放宽到 `number`**:它是一个筛选提示,不是判据——参数给不给得过由引擎在结算时按
 * 同一套界检查终裁,所以编译器在这里当裁判只会挡下「把 0..3 里的某个数从循环变量里取出来传进来」
 * 这种完全正当的写法(仓库里三份基准脚本与契约文档的骨架都这么写)。快照里的 `Unit.owner` /
 * `Site.owner` 两栏不放宽:那两栏是读回来的事实,精确到联合类型是值得的。
 */
type UnitFilter = { readonly owner?: number; readonly type?: UnitType };

/** `getObjectsByType("site", …)` 的过滤条件。`owner` 放宽的理由见 `UnitFilter`。 */
type SiteFilter = { readonly owner?: number; readonly kind?: SiteKind };

/** `getObjectsByType("player", …)` 的过滤条件。`owner` 放宽的理由见 `UnitFilter`。 */
type PlayerFilter = { readonly owner?: number };

/** 六种意图的判别式,与引擎的判别联合逐条一致。 */
type IntentKind = "move" | "moveTo" | "attack" | "harvest" | "transfer" | "spawnUnit";

/**
 * 一条意图。**脚本构造不了它**,动作函数替你构造——声明它是为了让这份形状有个可查的名字,
 * 而不是给脚本开一条绕过动作函数的入口。
 */
type Intent =
  | {
      readonly kind: "move";
      readonly unitId: number;
      readonly dx: -1 | 0 | 1;
      readonly dy: -1 | 0 | 1;
    }
  | { readonly kind: "moveTo"; readonly unitId: number; readonly x: number; readonly y: number }
  | { readonly kind: "attack"; readonly unitId: number; readonly targetId: number }
  | { readonly kind: "harvest"; readonly unitId: number; readonly siteId: number }
  | { readonly kind: "transfer"; readonly unitId: number }
  | { readonly kind: "spawnUnit"; readonly baseId: number; readonly unitType: UnitType };

/** 全表就这些码,没有别的。逐个的触发条件在契约文档的错误码表里。 */
type ErrCode =
  | "ERR_NOT_ENOUGH_RESOURCES"
  | "ERR_INVALID_UNIT"
  | "ERR_NOT_OWNER"
  | "ERR_OUT_OF_RANGE"
  | "ERR_INVALID_TARGET"
  | "ERR_INVALID_SITE"
  | "ERR_BAD_ARGS";

/**
 * 一个动作没生效时返回的那个值。**判它只能走那两个 helper**(`isError` / `errCode`):
 * 判据是「这次调用是不是错了」,不是「这个值长什么样」,所以 `typeof` 与真值都不是判据。
 *
 * 刻意做成一个对象而不是一个字符串:字符串形态会让 `typeof result === "string"` 这种写法
 * 在错误那一侧恰好为真,而它答的是形状不是对错——形态哪天一变,判定就静默地反了。
 */
type ErrResult = { readonly code: ErrCode };

// ── 查询函数:只读本 tick 的快照副本,不改引擎状态 ──────────────────────────────

/** 当前 tick 号。脚本每 tick 都要读一次时间轴。 */
declare function getTick(): number;

/** 按数值 id 取本 tick 快照里的那个单位或点位;取不到是 `null`。 */
declare function getObjectById(id: number): Unit | Site | null;

/** 按类型批量取快照对象。返回的数组是本 tick 的副本,数组本身可以重排,元素字段改不动。 */
declare function getObjectsByType(kind: "unit", filter?: UnitFilter): Unit[];

/** 按类型批量取快照对象。玩家的资源、存活与异常计数从这一档读。 */
declare function getObjectsByType(kind: "site", filter?: SiteFilter): Site[];

/** 按类型批量取快照对象。玩家的资源、存活与异常计数从这一档读。 */
declare function getObjectsByType(kind: "player", filter?: PlayerFilter): Player[];

/** 两点间 Chebyshev 距离。射程心算要读它算出来的那个数值。 */
declare function getRange(ax: number, ay: number, bx: number, by: number): number;

/**
 * 某格地形:`plain` 可走、`wall` 挡路、`out` 是地图边界之外。绕墙寻路之前先读它。
 *
 * 联合**就地写出**而不收成一个 `TerrainKind`:基准编译面要按返回类型推出桩的返回值,
 * 而一个名字推不出「它是个三值的字符串字面量联合」——就地写出来,推得出来,文档里也一眼看得到。
 */
declare function getTerrainAt(x: number, y: number): "plain" | "wall" | "out";

/** 寻路路径,走不通是 `null`。它计入 API 调用预算,而预算值不归这份声明。 */
declare function findPath(
  sx: number,
  sy: number,
  tx: number,
  ty: number,
): { readonly x: number; readonly y: number }[] | null;

// ── 动作函数:收集一条意图 + 参数界检查,合法性终裁归引擎 ──────────────────────

/** 走一步(含对角)。同一单位每 tick 只提交一条单位级意图。 */
declare function move(unitId: number, dx: -1 | 0 | 1, dy: -1 | 0 | 1): void | ErrResult;

/** 朝目标点走一步;路径由引擎沿 `findPath` 走。 */
declare function moveTo(unitId: number, x: number, y: number): void | ErrResult;

/** 攻击敌方单位。 */
declare function attack(unitId: number, targetId: number): void | ErrResult;

/** 在己方资源点采集。 */
declare function harvest(unitId: number, siteId: number): void | ErrResult;

/** 把携带量交给相邻己方基地。 */
declare function transfer(unitId: number): void | ErrResult;

/** 在己方基地下单出兵。产线已有订单时这一单被静默丢弃——先读 `site.producing`,空才下单。 */
declare function spawnUnit(baseId: number, unitType: UnitType): void | ErrResult;

// ── 座位自认:脚本唯一的「我是几号」来源 ──────────────────────────────────────

/**
 * 座位自认的**唯一**入口。快照里没有 `you`/`isSelf`,别靠单位位置反推座位。
 *
 * 返回值就地写成 `0 | 1 | 2 | 3`,理由与 `getTerrainAt` 相同(基准编译面要按它推出桩的值)。
 */
declare function getMyIndex(): 0 | 1 | 2 | 3;

// ── 错误判别 helper:把动作函数的返回值拆成可判的两步 ─────────────────────────

/** 判别第一步:这次调用是不是错了。不要用 `typeof` 或真值去猜。 */
declare function isError(result: void | ErrResult): boolean;

/** 判别第二步:取回那个错误码字符串。 */
declare function errCode(result: void | ErrResult): ErrCode;

// ── 错误码字符串:动作函数可能返回的那些值本身 ────────────────────────────────

declare const ERR_NOT_ENOUGH_RESOURCES: "ERR_NOT_ENOUGH_RESOURCES";
declare const ERR_INVALID_UNIT: "ERR_INVALID_UNIT";
declare const ERR_NOT_OWNER: "ERR_NOT_OWNER";
declare const ERR_OUT_OF_RANGE: "ERR_OUT_OF_RANGE";
declare const ERR_INVALID_TARGET: "ERR_INVALID_TARGET";
declare const ERR_INVALID_SITE: "ERR_INVALID_SITE";
declare const ERR_BAD_ARGS: "ERR_BAD_ARGS";
