/**
 * 参赛脚本可见面的**名单类**真源:宿主桥前缀、禁列全局名、沙箱注入的 API 符号表。
 *
 * 注入面符号表那一件已经不是纯名单:它的一行带**签名**(函数档)与**一句触发条件**(全档),
 * 因为面向模型的契约文档就是照着这张表渲染的,签名与触发条件各只该有一个家。
 * 「落在丢弃还是异常」那半张表在 `script-outcome.ts`,理由见那里的头注。
 *
 * 与 `builtin-globals.ts` 同属一张名单类数据的家(hld §6.2:名单由 `schema` 提供,
 * 与沙箱 runtime 暴露的 API 面同源)。消费者一个名字都不许自己存:
 * - **静态校验器**(D 节点,`packages/tools`):禁 `__*` 前缀、禁列全局名,两件事的规则形态
 *   全在它那边,本文件只提供「什么算桥前缀 / 哪些名字被禁」;
 * - **沙箱执行器**(G 节点):注入面按同一张符号表铺。
 *   两侧同源保证的是「注入面与静态校验读的是一张表」,**不是**「校验器能判这个名字存不存在」
 *   ——后者归编译器的名字解析,而它要的是类型面,符号表给不出;类型面尚未回填(hld §6.2
 *   「全局白名单」与「API 误用」两行)。
 *
 * 分界线(ADR-0003):「谁在运行时决定这个值」归实现包,「这个值叫什么、什么形状」归本文件。
 * 门禁怎么查(AST 遍历、违规产出、退出码)归工具包;数值型的上限不进名单——
 * 顶层脚本体积上限的取值在 `rulesets/*.json`,它不是名字,hld §6.2 那一行写得很明确。
 *
 * ── 本文件里的「交接单 …」是一律历史出处,不是当前依据 ──────────────────────────
 *
 * 标定环那份一次性交接单(`.scratch/rules-calibration/handoff.md`)**已作废**(它搬运的三样东西
 * 各自落库之后就没有第二个家了)。下面若干处引用它(座位自认 P0-1 / P0-N4、错误判别 P0-N2、
 * `ERR_BASE_BUSY` 可查询化那一格),记的是「这一条当初是被谁裁定的」这桩来历,
 * **不构成对当前事实的引用**。收与不收的当前依据只有上面那一句收录判据与下面逐条的理由:
 * 形状与名字归本文件,数值归 `rulesets/vN.json`,机制与语义归 gdd。要改收录范围,改本文件,
 * 不回那份单子。与 `ruleset-keys.ts` 头注里同一条声明同一处置——那里管键,这里管名字。
 */

/**
 * 宿主桥的命名前缀:任何以它开头的符号都是宿主注入的桥,静态校验器一律禁。
 *
 * 之所以是**前缀**而不是一张桥名清单:桥函数在初始化后即被删除(hld §6.2 记的
 * 「桥函数初始化后被删除」),所以参赛脚本能看见的桥永远是运行时才有的那一个;
 * 能在静态层判定的只有命名约定本身。「什么算宿主桥」与「桥在初始化后被删」
 * 是同一套约定,存两处就等于多了一处定义——这是它住在真源包、且以常量而不是
 * 正则交出的原因:正则会让消费者各自决定锚点与大小写敏感。
 */
export const HOST_BRIDGE_PREFIX: string = "__";

/**
 * 禁列的确定性污染源(hld §6.2「确定性污染源」一栏)。
 *
 * 收录判据:**在宿主时钟定格的前提下仍然不可复算的读数**,或者**能读到「跑到哪儿了」的量**。
 * 运行时 WASI 已把 `clock_time_get` 覆盖成常量,所以 `Date` 拿不到真实时间;禁它属纵深防御。
 * 逐条理由:
 * - `Date`——确定性污染源。即便宿主时钟定格,取到的仍是「被定格的值」而不是脚本自算的量,
 *   换个宿主配置它就变了,复算判据不能建立在这种值上;
 * - `Math.random`——非确定源,直接违反对局可复算(hld §1)。它不是内置全局名而是一个成员路径,
 *   但禁令的对象与全局名同类(同一个标识符链上的一次确定性污染),因此与全局名同表;
 *   真要分开会得到一张只有四个元素的表和一张只有一元素的表,裁决它们的差别不带来任何收益;
 * - `performance`——「跑到哪儿了」的读数,依赖挂钟且随宿主负载抖动;
 * - `queueMicrotask`——调度原语:微任务的执行时机不是脚本可复算的一部分,拿它派生顺序即不可复算。
 *
 * 与 `ALLOWED_MATH_MEMBERS` 的关系是**两个方向**:那里的判据是「整数闭包」,是「哪些成员收」;
 * 这里判据是「不可复算」,是「哪些一律禁」。`Math.random` 两条都沾——它不在允许名单里(产出非整数、
 * 且非确定),也在这里显式列出,因为「禁名单里有一个名字」比「它碰巧不在允许名单里」更难被后来者读错。
 */
export const FORBIDDEN_GLOBAL_NAMES: readonly string[] = [
  "Date",
  "Math.random",
  "performance",
  "queueMicrotask",
];

/**
 * 注入面表上一行的**类别**。
 *
 * **这五档就是判据在运行时一侧的全部形态,刻意没有「类型」这一档**:类别联合里没有它,
 * 于是给一个类型名标类别会在 `tsc -b` 当场编译不过。这是「类型名入表即红」的编译期那一半,
 * 运行期那一半(逐字类型名清单)是 `script-surface.test.ts` 里的机器断言。
 *
 * 另四个方向同样不该出现,它们各自另有机器断言兜着,不在这个联合里:`"builtin"`(内置全局名
 * 归 `BUILTIN_GLOBAL_NAMES`,两表不相交)、`"forbidden"`(归 `FORBIDDEN_GLOBAL_NAMES`)、
 * `"bridge"`(归 `HOST_BRIDGE_PREFIX` 那条前缀约定)、`"value"`(数值归 `rulesets/*.json`)。
 */
export type InjectedApiSymbolKind =
  /** 查询函数:只读本 tick 的快照副本,不改引擎状态。 */
  | "query"
  /** 动作函数:收集一条意图 + 参数界检查,合法性终裁归引擎。 */
  | "action"
  /** 座位自认入口:脚本唯一的「我是几号」来源。 */
  | "seat"
  /** 错误判别 helper:把动作函数的返回值拆成可判的两步。 */
  | "helper"
  /** 错误码字符串:动作函数可能返回的那个值本身。 */
  | "error-code";

/** 表上一行的公共部分:全局名 + 一句「为什么收」。 */
type InjectedApiSymbolBase = {
  /** 全局名。表上的成员一律是裸标识符,不是 `A.b` 那样的成员路径。 */
  readonly symbol: string;
  /** 一句「为什么收」。面向模型的那份契约文档直接渲染它,所以它写给模型看。 */
  readonly reason: string;
};

/**
 * 注入面表上一行:名字、类别、**为什么收**,以及按类别各自要带的那一样东西。
 *
 * 理由不是装饰:它是判据在这个名字上的一次应用,也是加名字的门槛。加不进来的名字先问
 * 「它运行时是个值吗」,答不上来就停在这一步,不必再问「能不能通融」——没有通融这一档。
 *
 * **按 `kind` 分成两个形态**,而不是把签名与后果都做成可选字段:可选字段意味着「忘了给」
 * 与「这一档本来就没有」在类型上不可分,而那份文档正是照着这张表渲染的——少一个签名渲染成
 * 一个空格,模型照着写就少一个参数。分档之后,函数档**不可能**没有签名,错误码档**不可能**
 * 有一个签名,两者各由 `tsc -b` 兜着。
 */
export type InjectedApiSymbolEntry = InjectedApiFunctionEntry | InjectedErrorCodeEntry;

/**
 * 四个函数档(查询 / 动作 / 座位自认 / 错误判别 helper):调得起来的一个函数,所以有签名。
 *
 * ── 签名这一栏归谁:现在住在这里,回填触发条件是类型面 ──
 *
 * 签名是**类型面**的事实(`hld` §6.2 那一行「API 误用」读的就是类型面),而类型面尚未落库。
 * 面向模型的契约文档必须现在就把签名写出来,所以它由本目录这一处书写,并被 API 表逐字渲染——
 * **同一个字符串只有一个家**,而「文档里那一份」是它的投影,不是抄本。
 *
 * 类型面回填那天,这一栏改为从类型面投影,与 `SANDBOX_INJECTED_API_SYMBOLS` 同一句纪律:
 * **位置留着,回填有触发条件**。触发条件就是类型面里那些函数声明本身——它们存在的那天,
 * 本目录不再自己写签名,只引用。在那之前多抄一份的风险由 `packages/tools` 的漂移检查兜着。
 */
export type InjectedApiFunctionEntry = InjectedApiSymbolBase & {
  readonly kind: Exclude<InjectedApiSymbolKind, "error-code">;
  /** 面向模型的那一栏签名:`名字(参数): 返回值`。逐字渲染进契约文档的 API 表。 */
  readonly signature: string;
};

/**
 * 错误码档:它不是一个函数,是一个**字符串常量**,所以没有签名。
 *
 * 它落在「丢弃」还是「异常」不在本文件里写:那一半是结算后果,归 `script-outcome.ts`,
 * 两边由 `script-surface.test.ts` 与 `script-outcome.test.ts` 各查一半并互相点名
 * (每个码恰好落在一行、每行引用的名字都是真的错误码)。原因写在那个文件的头注里。
 */
export type InjectedErrorCodeEntry = InjectedApiSymbolBase & {
  readonly kind: "error-code";
};

/**
 * 沙箱注入的 API 符号表:表上的每一个成员,沙箱 runtime 就必须真的把它铺进 guest。
 *
 * ── 收录判据:一句话,对所有候选名一视同仁 ──
 *
 *   **收:脚本在运行时能把它当值用到的名字。** 即脚本代码里写下这个名字,它就有一个运行时的
 *   值(一个函数、一个字符串常量)可读可调;把类型标注擦掉之后剩下的那个标识符,就是这张表
 *   上的一个成员。
 *
 *   判据只有这一种形态:**不产生运行时值的名字一律不收**。没有第三种形态,也没有
 *   「但这个例外」的口子——「运行时是个值」要么成立要么不成立,不存在需要人裁量的中间态。
 *
 * ── 明确不收:逐条理由,理由本身也是判据的实例 ──
 *
 * - **类型名**(`UnitType` / `IntentKind` / `ErrCode` 这类)——它们擦掉类型标注后不剩任何
 *   运行时值:名字活在**类型面**上,而类型面是「API 误用」那条判据(hld §6.2)读的东西。
 *   两张脸各管一件事:这张表管「脚本运行时能拿到哪些名字」,类型面管「拿到的值形状对不对、
 *   参数类型给不给得过」。把类型名塞进这张表,类型面与符号面就分叉成了两个家,而分叉的形状
 *   正是「文档说能用、编译后压根没有这个名字」。
 * - **数值**——预算类 8 键(墙钟、内存、事件/API 计数、体积上限)与兵种类六项属性归
 *   `rulesets/*.json` 那条生成链,已经是另一张表。收在这里等于同一份事实两个家。
 *
 * ── 错误码字符串与函数同表,`ERR_*` 的命名在本文件定死 ──
 *
 *   命名规则:`ERR_` 前缀 + 失效原因的**全大写名词短语**;**一条原因一个码**,按动作函数做
 *   界检查时能查出的**那一件事**命名,不按返回值的形状命名(形状归 `isError` / `errCode`)。
 *   全表 7 个,逐条理由见下面各行。
 *
 *   `ERR_BASE_BUSY` **不收**:同一产线重复下单不是错误而是静默丢弃(不扣款、不计异常),
 *   那一格由快照的 `producing` 字段供给(交接单「`ERR_BASE_BUSY` 可查询化」的裁决)。把一个
 *   非错误的状态做成错误码,是让模型去 `isError` 一个它其实不该问的东西。
 *
 *   每个码落在「丢弃」还是「异常」**不在本文件里写**:那一半是结算后果,归 `script-outcome.ts`
 *   的后果行。两个方向由测试各查一半并互相点名(每个码恰好落在一行、每行引用的名字都是真的错误码),
 *   所以「码表」与「丢弃 vs 异常对照表」不会各自长出一份答案。
 *
 * ── 逐个名字为什么收(判据的实例;加名字的门槛就是这些行) ──
 *
 * 查询函数——读出来的是一个值,所以收:
 * - `getTick` —— 当前 tick 号;脚本每 tick 都要读一次时间轴。
 * - `getObjectById` —— 按数值 id 取本 tick 快照里的那个对象;是取单个快照值的入口。
 * - `getObjectsByType` —— 按类型批量取快照对象(unit / site / player,可带过滤);同一个快照值的
 *   批量入口。**`player` 这一档是收口「快照里有、API 面里没有」那一条的落点**:玩家的资源、存活与
 *   异常计数只在这一档里读得到,产线的当前订单则挂在 `site.producing` 上(见下面的 `ERR_BASE_BUSY`
 *   那一段),两者都不需要脚本自己记。
 * - `getRange` —— 两点间 Chebyshev 距离;射程心算要读它算出来的那个数值。
 * - `getTerrainAt` —— 某格地形(`plain`/`wall`/`out`);绕墙寻路前先读它。
 * - `findPath` —— 寻路路径是一串坐标点,读得到的就是值。它计入 API 调用预算,而**预算值不归
 *   这张表**(数值归 `rulesets/*.json`),归的是它这个函数本身。
 *
 * 动作函数——调用即得到一个返回值(成功的 `void` 或一个 `ERR_*`),所以收:
 * - `move` —— 走一步(含对角),提交一条单位级意图。
 * - `moveTo` —— 朝目标点走一步,提交一条单位级意图;路径由引擎沿 `findPath` 走。
 * - `attack` —— 攻击敌方单位,提交一条单位级意图。
 * - `harvest` —— 在己方资源点采集,提交一条单位级意图。
 * - `transfer` —— 把携带量交给相邻己方基地,提交一条单位级意图。
 * - `spawnUnit` —— 在己方基地下单出兵,提交一条**玩家级**意图。
 *
 * 座位自认:
 * - `getMyIndex` —— 座位自认的**唯一**正式入口(交接单 P0-1、P0-N4:草案里「候选 A/B 二选一」
 *   的措辞作废)。脚本由此读到自己是 0..3 里的几号,返回值就是那个数值;往快照加
 *   `you`/`isSelf` 标记的方案已被否掉,那个字段并不存在。
 *
 * 错误判别 helper(交接单 P0-N2:`ErrResult` 必须显式判别,禁止让模型拿 `typeof`/真值去猜):
 * - `isError` —— 「这次调用是不是错了」的布尔;显式判别的第一步。
 * - `errCode` —— 取回那个错误码字符串;显式判别的第二步,读出来的正是一个 `ERR_*` 值。
 *
 * 错误码字符串:
 * - `ERR_NOT_ENOUGH_RESOURCES` —— 下单资金不足;**唯一在来源文档里被点名过**的错误码。
 * - `ERR_INVALID_UNIT` —— 动作函数点名的单位 id 不存在。
 * - `ERR_NOT_OWNER` —— 动作函数点名的单位/基地不归本方;沙箱内即时返回,**不用于自认座位**
 *   (它答的是「这个 id 是不是我的」,不是「我是谁」)。
 * - `ERR_OUT_OF_RANGE` —— 射程外。
 * - `ERR_INVALID_TARGET` —— 目标非法(如把基地当攻击目标)。
 * - `ERR_INVALID_SITE` —— 点位类型或归属不对(如把基地当资源点采集)。
 * - `ERR_BAD_ARGS` —— 参数越界(如 `move` 的 `dx`/`dy` 不是 -1/0/1)。
 *
 * ── 这张表不被静态校验器的任何规则消费 ──
 *
 * 静态校验器判「这个名字存不存在」是**编译器名字解析**的职责,而它读的是**类型面**,不是这张
 * 表(hld §6.2「API 误用」那一行)。两侧**不得互相引用为依据**:校验器那一侧的依据是编译器
 * 的名字解析规则,这张表的依据是上面那一句判据。把任一侧当成另一侧的证明,两条链就会在其中
 * 一侧被改动时悄悄分叉,而分叉的形状正是「文档说能用、编译器说不能用」。
 *
 * 本表的消费者是**面向模型的 API 契约文档**(直接进 prompt)与将来的沙箱执行器,两者读的都是
 * 名字本身;`packages/tools` 那边只有一个读取点(查询封装),没有任何规则调用它。
 *
 * ── 交接给沙箱执行器(G)的那一格:填「怎么注入」,不是「注入哪些名字」 ──
 *
 * 名字在本表已经定稿。G 那一格回来填的是:runtime bundle 的形状、这些名字铺进 guest 的时机、
 * 以及桥函数在初始化后怎么删(`HOST_BRIDGE_PREFIX` 管的是命名约定,注入面走的是本表,两者
 * 在本文件里必须分清)。G 若要改名,那是**改本表并重跑 `pnpm run generate`**,不是在 G 里
 * 另定一份——「注入面与沙箱 runtime 暴露的 API 面同源」要防的就是同一个名字两个家。
 */
export const SANDBOX_INJECTED_API_SYMBOL_CATALOG: readonly InjectedApiSymbolEntry[] = [
  {
    symbol: "getTick",
    kind: "query",
    reason: "当前 tick 号;脚本每 tick 都要读一次时间轴,读出来是个数值。",
    signature: "getTick(): number",
  },
  {
    symbol: "getObjectById",
    kind: "query",
    reason: "按数值 id 取本 tick 快照里的那个对象;是取单个快照值的入口。",
    signature: "getObjectById(id: number): Unit | Site | null",
  },
  {
    symbol: "getObjectsByType",
    kind: "query",
    reason:
      "按类型批量取快照对象(unit / site / player,可带过滤);同一个快照值的批量入口。" +
      "四个座位的资源、存活与异常计数也从这里读,不必在脚本里另记一份。",
    signature:
      "getObjectsByType(kind: 'unit' | 'site' | 'player', filter?: " +
      "{ owner?: -1|0|1|2|3; type?: UnitType; kind?: 'base' | 'resource' }): " +
      "(Unit | Site | Player)[]",
  },
  {
    symbol: "getRange",
    kind: "query",
    reason: "两点间 Chebyshev 距离;射程心算要读它算出来的那个数值。",
    signature: "getRange(ax: number, ay: number, bx: number, by: number): number",
  },
  {
    symbol: "getTerrainAt",
    kind: "query",
    reason: "某格地形(`plain`/`wall`/`out`);绕墙寻路之前先读它。",
    signature: "getTerrainAt(x: number, y: number): 'plain' | 'wall' | 'out'",
  },
  {
    symbol: "findPath",
    kind: "query",
    reason: "寻路路径是一串坐标点,读得到的就是值;它计入 API 调用预算,而预算值不归这张表。",
    signature:
      "findPath(sx: number, sy: number, tx: number, ty: number): { x: number; y: number }[] | null",
  },
  {
    symbol: "move",
    kind: "action",
    reason: "走一步(含对角),提交一条单位级意图。",
    signature: "move(unitId: number, dx: -1|0|1, dy: -1|0|1): void | ErrResult",
  },
  {
    symbol: "moveTo",
    kind: "action",
    reason: "朝目标点走一步,提交一条单位级意图;路径由引擎沿 `findPath` 走。",
    signature: "moveTo(unitId: number, x: number, y: number): void | ErrResult",
  },
  {
    symbol: "attack",
    kind: "action",
    reason: "攻击敌方单位,提交一条单位级意图。",
    signature: "attack(unitId: number, targetId: number): void | ErrResult",
  },
  {
    symbol: "harvest",
    kind: "action",
    reason: "在己方资源点采集,提交一条单位级意图。",
    signature: "harvest(unitId: number, siteId: number): void | ErrResult",
  },
  {
    symbol: "transfer",
    kind: "action",
    reason: "把携带量交给相邻己方基地,提交一条单位级意图。",
    signature: "transfer(unitId: number): void | ErrResult",
  },
  {
    symbol: "spawnUnit",
    kind: "action",
    reason: "在己方基地下单出兵,提交一条玩家级意图。",
    signature: "spawnUnit(baseId: number, unitType: UnitType): void | ErrResult",
  },
  {
    symbol: "getMyIndex",
    kind: "seat",
    reason: "座位自认的唯一正式入口;快照里没有 `you`/`isSelf` 标记,别靠单位位置反推座位。",
    signature: "getMyIndex(): 0|1|2|3",
  },
  {
    symbol: "isError",
    kind: "helper",
    reason: "「这次调用是不是错了」的布尔,显式判别的第一步;不要用 typeof 或真值去猜。",
    signature: "isError(result: void | ErrResult): boolean",
  },
  {
    symbol: "errCode",
    kind: "helper",
    reason: "取回那个错误码字符串,显式判别的第二步;读出来的正是一个 `ERR_*` 值。",
    signature: "errCode(result: void | ErrResult): ErrCode",
  },
  {
    symbol: "ERR_NOT_ENOUGH_RESOURCES",
    kind: "error-code",
    reason: "下单资金不足;唯一在来源文档里被点名过的错误码。",
  },
  {
    symbol: "ERR_INVALID_UNIT",
    kind: "error-code",
    reason: "动作函数点名的单位 id 不存在。",
  },
  {
    symbol: "ERR_NOT_OWNER",
    kind: "error-code",
    reason: "点名的单位/基地不归本方;沙箱内即时返回,不用于自认座位。",
  },
  {
    symbol: "ERR_OUT_OF_RANGE",
    kind: "error-code",
    reason: "射程外。",
  },
  {
    symbol: "ERR_INVALID_TARGET",
    kind: "error-code",
    reason: "目标非法(如把基地当攻击目标)。",
  },
  {
    symbol: "ERR_INVALID_SITE",
    kind: "error-code",
    reason: "点位类型或归属不对(如把基地当资源点采集)。",
  },
  {
    symbol: "ERR_BAD_ARGS",
    kind: "error-code",
    reason: "参数越界(如 `move` 的 `dx`/`dy` 不是 -1/0/1)。",
  },
];

/**
 * 注入面的裸名字清单,**由上面的目录投影而来**,不另存一份。
 *
 * 投影而不是再抄一份字面量:名字只有一处可改(`…_CATALOG`),而「名字 + 类别 + 为什么收」
 * 三样一起是可枚举的数据,面向模型的契约文档按它逐行渲染(票 05)。
 */
export const SANDBOX_INJECTED_API_SYMBOLS: readonly string[] =
  SANDBOX_INJECTED_API_SYMBOL_CATALOG.map((entry) => entry.symbol);
