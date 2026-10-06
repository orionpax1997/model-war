# rules-v1 API

> 脚本 API 的签名与语义;机制、结算顺序与确定性约束在 [`rules.md`](./rules.md),两份合起来是一份
> 自包含契约(hld §6.1)。
>
> 本文件里的四组表(API 表与错误码表、常量表、「丢弃 vs 异常」对照表、数值常量表)是**生成物**:
> 它们由真源包与 `rulesets/v1.json` 渲染,改表不改这份文档——手改表会被生成物漂移检查判红。
> 其余各节(§1 脚本形态与座位自认、§2 快照面与错误面、§4 那节正文、§6 骨架)是**手写散文**,
> 里面有类型声明块与可运行示例,示例同样受编译门禁看管。

## 1. 脚本形态与座位自认

你交的是**一份文件**:单个 TypeScript 源文件,交付名 `script.ts`。文件顶层声明一个入口函数 `loop()`,
引擎每个 tick 调它一次,调完收走它这一 tick 提交的全部意图,然后叫下一个 tick。

```ts
// script.ts:交付的就是这一个文件。顶层声明入口 loop,返回类型可省略。
// 模块级变量跨 tick 保留,所以变量里只放数值,不放过期的对象。
var mineSiteId = -1;

function loop() {
  const me = getMyIndex();
  const sites = getObjectsByType("site", { owner: me, kind: "resource" });
  for (let i = 0; i < sites.length; i += 1) {
    const site = sites[i];
    if (site === undefined) {
      // 数组下标可能取不到元素,判一下再用。
      continue;
    }
    mineSiteId = site.id;
  }
}
```

### 1.1 形态:只留一种写法

- **入口是顶层声明的 `function loop()`,返回类型可省略。** 写成 `function loop()` 或 `function loop(): void`
  都对;不写返回类型不算错。引擎不读它的返回值——要交出去的是调动作函数提交的那些意图,不是返回值。
- **顶层可以有任意多个变量与辅助函数**,它们在文件载入时建一次,顺序即书写顺序。辅助函数要声明在顶层
  (`function f() {}` 或 `const f = () => {}` 都行);写在 `loop()` 里面的定义只活本 tick。
- **禁模块语法**:整个文件里不许出现 `import`、`export`、`require`,也不许动态 `eval`——脚本不从任何
  地方取代码,运行时拿到的代码只有它自己这一份。
- **禁非确定源与宿主桥**:`Date`、`Math.random`、`performance`、`queueMicrotask` 这四个名字不可用,
  `__` 前缀的全局(`__` 开头的是宿主注入的桥)也不可用。沙箱里没有定时器、没有 I/O、没有别的宿主能力,
  整个可见面就是 §3 表里那些 API 名字,加上标准 ECMAScript 的纯函数。
- **全整数运算**:坐标、id、tick、距离、携带量、资源数全是整数,没有半格也没有百分比;本契约里出现除法的
  地方都整除。不要为了「保险」套一层 `Math.floor`,更不要引入浮点中间量。
- **产物是裸脚本**:编译产物没有任何模块语法,注入沙箱后被直接调用(这一条的实测形态见 §6 末尾)。

### 1.2 座位自认:只有一个正式入口

`getMyIndex()` 返回 `0 | 1 | 2 | 3`,它是脚本**唯一**的「我是几号」来源。读一次存进模块级变量即可——
它的取值整局不变,不需要每 tick 重读,重读也无害。

**不要靠单位位置反推座位。** 四方是对称开局:四家看到的开局形状完全一样,四家跑同一份脚本,
靠「我的单位站在哪儿」反推出的座位号算出来恰好是同一个数,于是四家都以为自己是同一号。
四方混战实测就是这样:同款位置法脚本互相误判,把别人的动作当成自己的动作,该防的方向与该打的目标
全错。快照里没有 `you`、也没有 `isSelf` 标记,那个字段不存在,不要去找。

「某个 id 是不是我的」是另一个问题,由动作函数回答:拿一个非己方的 id 去调动作函数,会立刻拿到
`ERR_NOT_OWNER`(沙箱内即时返回,那一行在 §3 的错误码表里)。那个码答的是「这个 id 归不归我」,
不是「我是谁」——它不用于自认座位。

### 1.3 每单位每 tick 只写一条意图

**同一个单位在一个 tick 内提交多条单位级意图,只留最后一条**:前面的静默作废,不写事件流、不计异常、
不扣款(这一行在 §4 那张对照表里)。`move` / `moveTo` / `attack` / `harvest` / `transfer` 是单位级意图,
`spawnUnit` 是玩家级意图、不受这条约束。

所以每个 tick 对每个单位最多调一次上面那五个函数里的任意一个。同一 tick 想做两件事(走一步再攻击),
先想清楚这一 tick 哪一个更重要,只提交那一个;拿不准就只提交移动——目标没到位就开打多半落在射程外,
拿到的只是一个被丢弃的意图。

### 1.4 跨 tick 记忆:只存数值

模块级变量跨 tick 保留(什么时候不保留见 [`rules.md`](./rules.md) §8.2)。按这三条写:

- **只存数值,和你自己算出来的东西**:id、坐标、tick 号、计数,都可以留在模块级变量里带到下一 tick。
- **不缓存对象引用**。`getObjectById` / `getObjectsByType` / `findPath` 返回的都只是**本 tick 的快照副本**,
  下一 tick 世界已经变了;把上一 tick 拿到的那个对象存起来接着用,读到的就是过期状态——它不会跟着
  单位一起死,也不会跟着点位换主。
- **不缓存查询结果**。别把「某 tick 查过矿在哪」写成一张表留着复用:归属会变(点位可被占领与易主)、
  单位会死、资源会采空。下一 tick 要用,就下一 tick 再查一次。查询花的是调用预算(见 §4),不是命。

## 2. 快照面与错误面

### 2.1 快照形状

每个 tick 引擎把世界拷成一份副本放进你的脚本容器,你通过第 3 节那些查询函数读它。**你不会收到一个
可以直接翻的 `Snapshot` 对象**:它是容器里的东西,查询函数是它的门。这一 tick 拿到的副本在下 tick
全部作废(§1.4),所以下面这份形状的每个字段都是「本 tick 此刻的值」。

快照的全部字段就下面这些,**字段名照这一份写**——本文档里没有第二份字段清单:

```ts
type UnitType = 'worker' | 'melee' | 'ranged' | 'cavalry';

type Player = {
  /** 座位号 0..3。四方对称开局,这一栏不是靠位置反推出来的,是编号。 */
  index: 0 | 1 | 2 | 3;
  /** 全局共享资源池里的钱,无上限、不按基地分池。下单从这里扣。 */
  resources: number;
  /** 本方是否还在局里。false 表示已被淘汰。 */
  alive: boolean;
  /** 累计异常 tick 数。用来知道自己离判负出局还有多远。 */
  exceptionTicks: number;
};

type Unit = {
  id: number;
  owner: 0 | 1 | 2 | 3;
  type: UnitType;
  x: number;
  y: number;
  hp: number;
  /** 农民携带量;其余兵种恒为 0。 */
  carrying: number;
};

type Site = {
  id: number;
  kind: 'base' | 'resource';
  x: number;
  y: number;
  /** -1 是中立。 */
  owner: -1 | 0 | 1 | 2 | 3;
  /** 正在累积占领进度的那一方,进度落在 progress 上。 */
  progressOwner: -1 | 0 | 1 | 2 | 3;
  progress: number;
  /** 仅资源点有:这个矿还剩多少资源。 */
  remaining?: number;
  /**
   * 这一条产线当前的订单,没有订单时是 null。
   * 开局每条产线都是空的,所以开局读到的就是 null;null 不等于「字段不存在」。
   */
  producing: { type: UnitType; remainingTicks: number } | null;
};
```

形状上有三件事要知道:

- **座位不在快照里。** 没有 `you`、没有 `isSelf`,也没有「自己那一号」这一栏——座位只从
  `getMyIndex()` 读(§1.2),那一栏是它的唯一入口。
- **产线的当前订单挂在基地上,不是一张独立的队列表。** 四个座位的产线状态全在 `producing` 这一栏里,
  所以你不需要、也不该在脚本里另记一份队列(下一小节说这件事)。
- **快照只给读得到的东西。** 引擎内部的那些字段(对象 id 的分配器、终局结果之类)不在快照里,别去找。

**这一段现在是类型面的一份投影,不再是等待回填的承诺。** 引擎的状态模型里已经有这份形状
(`packages/engine` 的 `Site` 有 `producing` 与 `remaining`,产线就是 `Site` 上的一栏,不是独立的
`Production` 类型),而脚本 API 的**类型声明面也已回填**(家是 `packages/schema/script-api/index.d.ts`,
`tsconfig.scripts.json` 的 `types` 经它引入,见 [ADR-0006](../adr/0006-script-api-type-surface-lands-in-engine.md))。
上面那份形状与类型面**逐字段一致**——`type Player` / `type Unit` / `type Site` 三个块的字段名与次序
两边相同,由 `packages/tools/src/api-doc.test.ts` 的机器断言盯着(改一边不改另一边即红)。

`ErrResult`、`Intent` 这两个类型名现在的家也在类型面。字段名不改——改字段名要走一次有意的变更,
像改一个错误码名那样;它的唯一去处就是那份声明本身,上面这一块要跟着同步(机器断言会盯着,分叉即红)。

### 2.2 玩家侧三项与产线订单:在哪读

**钱、存活、异常计数**——`getObjectsByType("player")` 一次读回四个座位,每行按 `index` 编号;你自己的
那一行是 `index === getMyIndex()`。三个字段都是**每 tick 重读一次**的东西,不需要你记:

- `resources`:你的钱。下单从这里扣,采集往这里加;能不能买得起,每一 tick 都重新看一眼。
- `alive`:你还在不在局里。为 `false` 时你已被淘汰(机制见 [`rules.md`](./rules.md) §7.2)。
- `exceptionTicks`:累计异常 tick 数。离 `exceptionTickLimit`(取值见第 5 节)还有多远,这一栏告诉你。

**产线的当前订单**——每个 `kind === 'base'` 的点位上有 `producing`。它是 `null` 就是这条产线空着;
不是 `null` 就是 `{ type, remainingTicks }`:正在造哪个兵种、还要几个 tick。

这两句必须一起读,单看任何一句都会把脚本写坏:

- **一条产线一次只有一个订单。** 下单那一刻就占住这条产线,一直占到出兵格空出来续出那一步
  (机制见 [`rules.md`](./rules.md) §4.4)。
- **这条产线已经有订单时再下单,那一单被静默丢弃:不扣款、不计异常、队列不变。** 它既不是错误码,
  也不计入 `exceptionTicks`——所以别去 `isError` 它,也别指望能拿到一个码来告诉你「它忙」。

正因为一次只有一个,重复下单才必然落空;而落空什么也不罚,这就是错误码表里**没有**「产线忙」
这一码的原因(那一格由 `producing` 供给)。**正确写法是先读 `producing`,是 `null` 才下单**:
不必自己记队列,也不必靠重复下单去试探队列状态。开局时每条产线都是空的,所以开局就该下第一单。

### 2.3 错误面:只有两步判别

每一个动作函数都返回 `void | ErrResult`(签名逐字在第 3 节的 API 表里)。`void` 那一侧就是「这一条意图
已提交」。**判别只有两步,也只有这两步**:

```ts
const result = spawnUnit(baseId, "melee");
if (isError(result)) {
  const code = errCode(result); // 「错误码表」里的那一个码
} else {
  // 这一条意图已提交;合法性终裁在结算时按同一套界检查做。
}
```

**不许用 `typeof`、不许用真值去猜。** 一句原因:它们答的是「这个值长什么样 / 这个值是不是真的」,
不是「这次调用是不是错了」,而**这两种形态下它们都可能给错答案**:

- **真值**判据今天碰巧对得上,只因为「成功那一侧恒为 `undefined`(假值)、错误那一侧恰好恒为真值」
  这两条巧合。而 `ErrResult` 的**承载形态**(是对象还是字符串)本文档不披露——它是类型面事实,尚未
  回填。承载形态一旦换掉,`if (result)` 与 `!result` 就在同一条调用上给出相反的答案,而它是**静默**
  的:出错的那一 tick 会被读成「没出错」,脚本对着一条根本没提交的意图继续往下走。
- **`typeof`** 判据的依据同样只是那个未披露的形态:`typeof` 只能区分「对象」与「字符串」这类**形状**,
  答不出「这个值是不是错误」。形态从字符串换成对象的那一天,`typeof result === "string"` 从
  `true` 变 `false`,错还是那个错,判定却反了。

换成 helper 就没有这个问题:回填那天改的是 `ErrResult` 的承载形态,`isError` / `errCode` 的签名不变,
**你的脚本一行都不用改**。这就是它们是唯一入口的原因。

下面这份是一段完整可跑的 `loop()`:读玩家侧三项、读产线队列、空才下单、返回值走那两步判别。

```ts
// 完整的 loop:读钱 → 看产线空不空 → 空才下单 → 两步判别返回值。
function loop() {
  const me = getMyIndex();
  const players = getObjectsByType("player");
  const mine = players[me];
  if (mine === undefined) {
    // 数组下标可能取不到元素,判一下再用(§1 的写法)。
    return;
  }

  const bases = getObjectsByType("site", { owner: me, kind: "base" });
  for (let i = 0; i < bases.length; i += 1) {
    const base = bases[i];
    if (base === undefined) {
      continue;
    }
    // 队列状态在快照里,开局就有这一栏:非 null 就是这条产线已经有订单,这一 tick 不要再下。
    // (重复下单不扣款也不计异常,可它同样什么也不产出——所以判据是这一栏,不是重发一次试试。)
    if (base.producing !== null) {
      continue;
    }
    // 钱是从快照读的,不是自己记的:一个 tick 一个数,别跨 tick 留着它。
    if (mine.resources <= 0) {
      // 一分钱都没有时下单必然拿到 ERR_NOT_ENOUGH_RESOURCES,那一单什么也不产出(见下)。
      continue;
    }
    // 买什么兵种、留多少钱,那是策略,本文档不管;这一份只示范「空才下单」与两步判别。
    const result = spawnUnit(base.id, "melee");
    if (!isError(result)) {
      continue; // 这一单已提交;出兵与续出的时机归引擎
    }
    // 到了这里就是错了。判错、取码只有那两个 helper,不用 typeof、不用真值。
    const code = errCode(result);
    if (code === ERR_NOT_ENOUGH_RESOURCES) {
      // 这一单无效:钱一个不少、队列不变(第 4 节那张对照表里「丢弃」那一类)。
      continue;
    }
    // 其余那些码答的是「这一条意图为什么没生效」,同样落在「丢弃」:本 tick 其余意图照常结算。
  }
}
```

错误码表里每一行都标了它落在哪一类,后果与累计逐条在第 4 节那张对照表里;落在「丢弃」的那一整类都不会清掉你的跨 tick
记忆,也不会把本 tick 的其余意图一起丢掉。

## 3. API 表、错误码表与常量表

这一节三张表与第 5 节那一张表是生成物:名字、签名、触发条件逐字来自注入面符号表
(`packages/schema/src/script-surface.ts`),每个错误码落在「丢弃」还是「异常」来自后果行
(`packages/schema/src/script-outcome.ts`)。文档里没有第二份抄本。

<!-- generated:api-v1-api-surface:begin -->
> 本节三张表是**生成物**,勿手改:由 `packages/tools/src/generate/api-surface.ts` 从
> `packages/schema/src/script-surface.ts`(注入面符号表)与 `packages/schema/src/script-outcome.ts`(后果行)产出。
> **API 表的「签名」那一栏投影自类型面**
> `packages/schema/script-api/index.d.ts`,它才是签名的家(符号表不再自己写一份)。
> 改真源后跑 `pnpm run generate`;手改会在下一次生成时被原样覆盖,并被生成物漂移检查
> (`check:drift`)判红。

**API 表**

**查询函数**——只读本 tick 的快照副本,不改引擎状态。

| 函数 | 签名 | 一句语义 |
| --- | --- | --- |
| `getTick` | `getTick(): number` | 当前 tick 号;脚本每 tick 都要读一次时间轴,读出来是个数值。 |
| `getObjectById` | `getObjectById(id: number): Unit \| Site \| null` | 按数值 id 取本 tick 快照里的那个对象;是取单个快照值的入口。 |
| `getObjectsByType` | `getObjectsByType(kind: "unit", filter?: UnitFilter): Unit[] / getObjectsByType(kind: "site", filter?: SiteFilter): Site[] / getObjectsByType(kind: "player", filter?: PlayerFilter): Player[]` | 按类型批量取快照对象(unit / site / player,可带过滤);同一个快照值的批量入口。四个座位的资源、存活与异常计数也从这里读,不必在脚本里另记一份。 |
| `getRange` | `getRange(ax: number, ay: number, bx: number, by: number): number` | 两点间 Chebyshev 距离;射程心算要读它算出来的那个数值。 |
| `getTerrainAt` | `getTerrainAt(x: number, y: number): "plain" \| "wall" \| "out"` | 某格地形(`plain`/`wall`/`out`);绕墙寻路之前先读它。 |
| `findPath` | `findPath(sx: number, sy: number, tx: number, ty: number): { readonly x: number; readonly y: number }[] \| null` | 寻路路径是一串坐标点,读得到的就是值;它计入 API 调用预算,而预算值不归这张表。 |

**动作函数**——收集一条意图 + 参数界检查,不直写引擎。

| 函数 | 签名 | 一句语义 |
| --- | --- | --- |
| `move` | `move(unitId: number, dx: -1 \| 0 \| 1, dy: -1 \| 0 \| 1): void \| ErrResult` | 走一步(含对角),提交一条单位级意图。 |
| `moveTo` | `moveTo(unitId: number, x: number, y: number): void \| ErrResult` | 朝目标点走一步,提交一条单位级意图;路径由引擎沿 `findPath` 走。 |
| `attack` | `attack(unitId: number, targetId: number): void \| ErrResult` | 攻击敌方单位,提交一条单位级意图。 |
| `harvest` | `harvest(unitId: number, siteId: number): void \| ErrResult` | 在己方资源点采集,提交一条单位级意图。 |
| `transfer` | `transfer(unitId: number): void \| ErrResult` | 把携带量交给相邻己方基地,提交一条单位级意图。 |
| `spawnUnit` | `spawnUnit(baseId: number, unitType: UnitType): void \| ErrResult` | 在己方基地下单出兵,提交一条玩家级意图。 |

**座位自认**——脚本唯一的「我是几号」来源,不用于判断某个 id 是不是我的。

| 函数 | 签名 | 一句语义 |
| --- | --- | --- |
| `getMyIndex` | `getMyIndex(): 0 \| 1 \| 2 \| 3` | 座位自认的唯一正式入口;快照里没有 `you`/`isSelf` 标记,别靠单位位置反推座位。 |

**错误判别 helper**——把动作函数的返回值拆成可判的两步。

| 函数 | 签名 | 一句语义 |
| --- | --- | --- |
| `isError` | `isError(result: void \| ErrResult): boolean` | 「这次调用是不是错了」的布尔,显式判别的第一步;不要用 typeof 或真值去猜。 |
| `errCode` | `errCode(result: void \| ErrResult): ErrCode` | 取回那个错误码字符串,显式判别的第二步;读出来的正是一个 `ERR_*` 值。 |

**错误码表**——全表就下面这些,没有别的。每一行都标出它落在哪一类,而这两类的后果不同:
「丢弃」= 只丢这一条意图:本 tick 其余意图照常结算,不扣款、不计异常。「异常」= 本 tick 该方的**全部**意图置空(原地待命),这一 tick 白跑。
模型据此决定要不要兜。

| 错误码 | 一句触发条件 | 落在哪类 |
| --- | --- | --- |
| `ERR_NOT_ENOUGH_RESOURCES` | 下单资金不足;唯一在来源文档里被点名过的错误码。 | 丢弃 |
| `ERR_INVALID_UNIT` | 动作函数点名的单位 id 不存在。 | 丢弃 |
| `ERR_NOT_OWNER` | 点名的单位/基地不归本方;沙箱内即时返回,不用于自认座位。 | 丢弃 |
| `ERR_OUT_OF_RANGE` | 射程外。 | 丢弃 |
| `ERR_INVALID_TARGET` | 目标非法(如把基地当攻击目标)。 | 丢弃 |
| `ERR_INVALID_SITE` | 点位类型或归属不对(如把基地当资源点采集)。 | 丢弃 |
| `ERR_BAD_ARGS` | 参数越界(如 `move` 的 `dx`/`dy` 不是 -1/0/1)。 | 丢弃 |

**常量表**——本表只有错误码字符串这一半。类型名(`UnitType` / `IntentKind` / `ErrResult` /
`Snapshot` / `Intent`)归类型面,数值归「数值常量表」一节,两者都不进本表。

```ts
type ErrCode =
  | 'ERR_NOT_ENOUGH_RESOURCES'
  | 'ERR_INVALID_UNIT'
  | 'ERR_NOT_OWNER'
  | 'ERR_OUT_OF_RANGE'
  | 'ERR_INVALID_TARGET'
  | 'ERR_INVALID_SITE'
  | 'ERR_BAD_ARGS';
```

判一次调用错没错,只有上面那两个 helper 这一条路:`isError(result)` 判有没有出错,
`errCode(result)` 取回码字符串。**不要用 `typeof`、不要用真值去猜**——返回值是
`void | ErrResult` 的联合,猜它的形状等于替终稿写一份判定。

```ts
const result = move(unitId, 0, 1);
if (isError(result)) {
  // 这一条意图没生效:落在哪一类、丢的是什么,见「错误码表」与第 4 节那张对照表。
  const code = errCode(result); // 取回「错误码表」里的那一个码(全表 7 个)
} else {
  // 这一条意图已提交;合法性终裁在结算时按同一套界检查做。
}
```

沙箱内即时返回的码只是**反馈**:合法性终裁在结算时按同一套界检查再做一遍,所以拿到一个码
也不等于这一步一定生效(同一 tick 里单位已经没了、目标已经死了,都可能让一条已提交的意图作废)。

<!-- generated:api-v1-api-surface:end -->

## 4. 丢弃 vs 异常

这一节那张表是生成物。**两类后果的机制与完整披露**(界检查为什么在沙箱内即时返回一次、越权调用的
完整清单、超预算三类分别怎么判)归 [`rules.md`](./rules.md) §8 的异常披露;这里只给模型判断
「要不要兜」所需的那一半:每一种没生效各丢什么。

<!-- generated:api-v1-outcome-table:begin -->
> 本表是**生成物**,勿手改:由 `packages/tools/src/generate/api-surface.ts` 从
> `packages/schema/src/script-outcome.ts`(后果行)与 `packages/schema/src/script-surface.ts`(错误码名)产出。
> 改真源后跑 `pnpm run generate`;手改会在下一次生成时被原样覆盖,并被生成物漂移检查
> (`check:drift`)判红。

**两类后果**

| 类 | 丢的是什么 | 累计 |
| --- | --- | --- |
| 丢弃 | 只丢这一条意图:本 tick 其余意图照常结算,不扣款、不计异常。 | 不计入 `exceptionTicks`。 |
| 异常 | 本 tick 该方的**全部**意图置空(原地待命),这一 tick 白跑。 | 给 `exceptionTicks` 加一;累计达 `exceptionTickLimit` 则判负出局(机制见 rules.md §8)。 |

**对照表**——每一种「没生效」各占一行。`相关错误码` 一栏是按名字从后果行投影的:
一个码恰好落在一行,所以上面错误码表里「落在哪类」那一栏与这里逐条一致,不会两处各写一份。

| 情形 | 落在哪类 | 这一行的后果 | 例子 | 相关错误码 |
| --- | --- | --- | --- | --- |
| 同一单位在一 tick 内提交了多条单位级意图:取最后一条,前面的静默作废。 | 丢弃 | 被覆盖的那些意图不留任何痕迹:不写事件流、不计异常、不扣款。 | 同一农民连调两次 `move`,只有最后一次生效——所以每单位每 tick 只写最终意图。 | — |
| 动作函数的界检查没过:点名的单位或基地不存在、不归本方、射程外、目标非法、点位类型不对、参数越界。 | 丢弃 | 沙箱内即时返回对应错误码,引擎在结算时按同一套界检查再裁一次;该条意图无效。 | `attack` 打基地、`harvest` 指基地、无攻击能力的单位调 `attack`。 | `ERR_INVALID_UNIT`、`ERR_NOT_OWNER`、`ERR_OUT_OF_RANGE`、`ERR_INVALID_TARGET`、`ERR_INVALID_SITE`、`ERR_BAD_ARGS` |
| `spawnUnit` 资金不足:这一单下单无效。 | 丢弃 | 不占产线队列、不扣款,资金一个不少地留着。 | 钱不够买下一个兵种时再下单 → 这一单无效,钱一个不少地留着(换个兵种也一样)。 | `ERR_NOT_ENOUGH_RESOURCES` |
| `loop()` 抛异常:算力或 API 调用超预算、越权调用(调不存在的 API、调已删的宿主桥)、内存超限转成的异常、栈溢出。 | 异常 | 本 tick 该方全部意图置空;容器续用、跨 tick 记忆保留,下一 tick 从头再来。 | 死循环被截停;调了一个不存在的 `fly()`。 | — |
| tick 末存活堆占用 ≥ `memoryTickCeiling`。 | 异常 | 与 `loop()` 抛异常同后果:判据锚定读数,tick 内瞬时触顶后自行释放的分配不判。 | 本 tick 分配很大但当场释放,读数没超 → 不判罚。 | — |
| 引擎级故障(极罕见,脚本写不出也测不出)。 | 异常 | 除置空外还防御性重建该方容器:模块级记忆清零,异常计数由持久化值续算、不清零。 | 这一行的唯一用途是让脚本知道「记忆极 rare 会丢」,别的照常写。 | — |

一句话记法:写错参数最多丢一条,写崩 `loop()` 才丢整 tick;累计的判罚走 `exceptionTickLimit`
(取值见「数值常量表」),完整的异常披露在 [`rules.md`](./rules.md) §8。

<!-- generated:api-v1-outcome-table:end -->

## 5. 数值常量表

下面这张表与 [`rules.md`](./rules.md) §10 **逐字节相同**:两份由同一个生成函数产出,改取值时两处一起
变,不存在「一份新一份旧」的中间态。

<!-- generated:api-v1-value-table:begin -->
> 本表是**生成物**,勿手改:由 `packages/tools/src/generate/rules-value-table.ts` 从
> `rulesets/v1.json` 与 `packages/schema/src/ruleset-keys.ts`(键清单)产出。
> 改真源后跑 `pnpm run generate`;手改会在下一次生成时被原样覆盖,并被生成物漂移检查
> (`check:drift`)判红。

**参数取值**

| 键 | 值 | 量纲 | 说明 |
| --- | --- | --- | --- |
| `tickLimit` | 600 | tick | 对局上限(总 tick 数)。超时走终局名次结算,不由超时判负。 |
| `captureTicks` | 10 | tick | 占领一个点位所需的累积 tick。基地与资源点**统一单值**,不分类型(gdd《地图与点位》)。 |
| `initialResources` | 16 | resources | 开局资金。保证 tick 0 就能在「补经济」与「补兵」之间作选择;下界取 0(开局一无所有是自洽的)。 |
| `harvestRate` | 1 | resources/tick | 单个农民在一个有效采集 tick 里获得的资源量。 |
| `carryLimit` | 20 | resources | 单个农民可携带的资源上限;满载一次需 `⌈carryLimit ÷ harvestRate⌉` 个有效采集 tick。 |
| `resourcePerSite` | 200 | resources/site | 单个资源点的总储量。与 `tickLimit` 共同决定枯竭压力是否真实存在。 |
| `baseScore` | 4 | score | 每控制一个主基地的终局分。 |
| `resourceScore` | 1 | score | 每控制一个资源点的终局分。 |
| `unitCostDivisor` | 6 | divisor | 存活单位总造价分的除数:该项加分为 `⌊Σ 存活单位造价 ÷ unitCostDivisor⌋`(分)。 |
| `exceptionTickLimit` | 未定 | exceptions | 累计异常判负阈值(次/整局)。达它则该方判负出局,点位回归中立。 |
| `eventTickLimit` | 未定 | events/tick | 单 tick 的控制流事件计数上限(次/tick):以循环回边 / 函数调用 / 函数返回为一格累计。达顶则本 tick 该方 intents 全部丢弃并计一次异常。 |
| `apiCallTickLimit` | 未定 | calls/tick | 单 tick 的 API 调用计数上限(次/tick)。与控制流事件计数互为盲区:前者抓纯计算死循环,后者抓 API 轰炸。 |
| `memoryLimit` | 未定 | bytes | VM 线性内存的分配上限(bytes)。上限本身不可突破,超限转成可捕获的 JS 异常。 |
| `memoryTickCeiling` | 未定 | bytes | 内存判据的判罚线(bytes):每 tick 末 `runGC()` 后的存活堆读数达它即视同一次异常。软阈是它的 `MEMORY_SOFT_THRESHOLD_RATIO` 倍,是**纯展示项**、不入键清单。 |
| `wallClockSoftLimit` | 未定 | milliseconds | 单 tick `loop()` 的墙钟软限(ms)。**只观测**:写进回放与报告披露,不参与判罚。 |
| `wallClockHardTimeout` | 未定 | milliseconds | 墙钟硬超时(ms),**只作废该场**:标记 `nondeterministic-timeout` 后按重跑 / 剔除处理,不判负(墙钟受机器负载影响,参与判罚会破坏可复算性)。 |
| `scriptSizeLimit` | 未定 | bytes | 顶层脚本体积上限(bytes),封「直线代码不计量、大循环体放大每格工作量」的计数盲区。它是**规则集里的数值键**,与沙箱注入的 API 名表是两件事(hld §6.2 的「不进名单」说的是后者)。 |

**兵种属性**

| 兵种 | 造价 | 生命 | 伤害 | 射程 | 速度 | 生产耗时 | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `worker` | 4 | 2 | 0 | 1 | 1 | 2 | 农民:无攻击能力,全图最脆弱的高价值目标。 |
| `melee` | 8 | 12 | 3 | 1 | 1 | 4 | 近战:性价比标杆。 |
| `ranged` | 12 | 4 | 2 | 2 | 1 | 6 | 远程:阵地输出,贴身即溃。 |
| `cavalry` | 16 | 6 | 2 | 1 | 2 | 8 | 骑兵:价值全部来自速度。 |

生产耗时一列按 `⌈造价 × SPAWN_TICKS_COEFFICIENT⌉` **现算**,不是抄进表的第二份取值。

**派生量(入表,不入键清单)**

| 派生量 | 公式 | 值 |
| --- | --- | --- |
| 内存软阈 | `MEMORY_SOFT_THRESHOLD_RATIO × memoryTickCeiling` | 未定 |
| 单基地满产烧钱率 | `FULL_PRODUCTION_COST_RATE` | 2 |
<!-- generated:api-v1-value-table:end -->

「未定」的含义、「内存软阈为什么进表不进键清单」与「生产耗时为什么是算出来的」三处分工写在
[`rules.md`](./rules.md) §10 的表后说明里,不在此复述。

## 6. 最小 `loop()` 骨架

一份能跑的脚本最少做三件事:认出自己、读这一 tick 的快照、给每个单位提交一条意图。下面这份骨架
各写了一遍,可以当起点改。

```ts
// 跨 tick 只带数值过去,只带这一个 id,不带任何对象。
var assignedEnemyId = -1;

function loop() {
  const me = getMyIndex();
  const mine = getObjectsByType("unit", { owner: me });
  const foes = getObjectsByType("unit", { owner: foeOwnerOf(me) });

  for (let i = 0; i < mine.length; i += 1) {
    const unit = mine[i];
    if (unit === undefined) {
      // 数组下标可能取不到元素，判一下再用。
      continue;
    }
    const enemy = nearestEnemyId(unit, foes);
    if (enemy === null) {
      continue;
    }
    // 记忆里那个 id 本 tick 还在不在:重新查一次,不信上一 tick 拿到的对象。
    if (assignedEnemyId >= 0 && getObjectById(assignedEnemyId) === null) {
      assignedEnemyId = -1;
    }
    assignedEnemyId = enemy;

    // 每个单位本 tick 只提交这一条意图(见 §1.3);拿到码只是反馈,不是终裁。
    const result = attack(unit.id, enemy);
    if (isError(result)) {
      const code = errCode(result);
      if (code === ERR_INVALID_UNIT) {
        continue;
      }
    }
  }
}

/** 敌方的归属值:0..3 里除我以外的那一个。 */
function foeOwnerOf(me: number): number {
  return (me + 1) % 4;
}

/** 本 tick 最近的敌方单位 id,没有敌人时是 null。射程不归这里管:交给动作函数判。 */
function nearestEnemyId(
  unit: { x: number; y: number },
  foes: readonly { id: number; x: number; y: number }[],
): number | null {
  let best = -1;
  let bestRange = 0;
  for (const foe of foes) {
    const d = getRange(unit.x, unit.y, foe.x, foe.y);
    if (best === -1 || d < bestRange) {
      best = foe.id;
      bestRange = d;
    }
  }
  return best === -1 ? null : best;
}
```

三条硬约束在这份骨架里的位置:座位只从 `getMyIndex()` 来(§1.2),跨 tick 只带 `assignedEnemyId`
这一个数值过去而 `mine` / `foes` 每 tick 重新查(§1.4),每个单位每 tick 只 `attack` 一次(§1.3)。
返回值走 `isError` / `errCode` 两步判别,不猜形状(§2.3)。

这份骨架与 §1、§2 那两份例子都由仓库的编译门禁**真编译过**,用的就是参赛脚本那份编译配置:所以它们没有
模块语法、没有 Node 与 DOM 的名字、没有非确定源,也没有别处的类型错误。示例本身也受门禁看管——
把它改坏,门禁会红。
