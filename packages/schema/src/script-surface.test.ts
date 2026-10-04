/**
 * 参赛脚本可见面的**几张表之间**的不变量断言(宿主桥前缀 / 沙箱注入符号表 / 禁列全局名 /
 * 内置全局白名单),以及注入面自己的收录判据:「收脚本运行时能当值用到的名字」。
 *
 * ── 为什么落在这里,不在校验器里 ───────────────────────────────────────────────
 * 这些断言的对象是**表与表的关系**与**判据在表上的落法**,而这些表都是本包的事实
 * (经生成器分发到 `packages/tools`,规则层一个名字都不自己存)。放到校验器侧断言,得到的只会
 * 是「空集合里没有带前缀的名字」这种恒真的废话。
 *
 * ── 「类型名入表即红」这一条是本文件的核心护栏 ─────────────────────────────────
 * 它分两半,两半都要在:**编译期**那半是 `InjectedApiSymbolKind` 联合里没有 `"type"` 档
 * (见真源侧注释),所以给类型名标类别会 `tsc -b` 非零退出;**运行期**那半是下面那条逐字
 * 类型名清单。只写注释不落断言,类型名迟早会以「这不也是个名字吗」进来。
 *
 * 反例手法见各条注释:把一个类型名 / 一个带前缀的名字 / 一个禁列名字 / 一个内置全局名写进
 * `SANDBOX_INJECTED_API_SYMBOL_CATALOG`,对应那条立刻红。
 */

import { expect, it } from "vitest";

import {
  BUILTIN_GLOBAL_NAMES,
  FORBIDDEN_GLOBAL_NAMES,
  HOST_BRIDGE_PREFIX,
  SANDBOX_INJECTED_API_SYMBOL_CATALOG,
  SANDBOX_INJECTED_API_SYMBOLS,
  type InjectedApiSymbolKind,
} from "./index.js";

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

/**
 * **编译期护栏:类别联合里没有「类型」这一档。**
 *
 * 反例:往 `InjectedApiSymbolKind` 里加一档 `"type"` 并给 `UnitType` 标上它——本类型当场
 * 变成 `false`,`tsc -b` 非零退出。判据是「运行时能当值用到」,而类型名擦掉标注后什么也不剩,
 * 所以它连一个合法的类别都没有。类型被导出(`export type …`)是为了让这条断言不会随文件
 * 移动而失效,与 `ruleset.test.ts` 里那两条类型级断言同一惯例。
 */
export type InjectedSymbolKindsExcludeType = Assert<
  Equals<InjectedApiSymbolKind, Exclude<InjectedApiSymbolKind, "type">>
>;

/**
 * 注入面的**字面清单**。
 *
 * 写成字面量而不是从目录里数,是因为「数出来是 22」拦不住「有人往表里加了一个不该有的名字」
 * ——那正是要拦的那件事(与 `ruleset.test.ts` 的 21 键字面清单同一条纪律)。
 * 顺序即书写序:查询 6 → 动作 6 → 座位自认 1 → helper 2 → 错误码 7。
 * 逐字清单同时把 `ERR_*` 的命名钉死在本票:改码名就是改这一行,得走一次有意的变更。
 */
const EXPECTED_SYMBOLS: readonly string[] = [
  // 查询函数
  "getTick",
  "getObjectById",
  "getObjectsByType",
  "getRange",
  "getTerrainAt",
  "findPath",
  // 动作函数
  "move",
  "moveTo",
  "attack",
  "harvest",
  "transfer",
  "spawnUnit",
  // 座位自认入口
  "getMyIndex",
  // 错误判别 helper
  "isError",
  "errCode",
  // 错误码字符串
  "ERR_NOT_ENOUGH_RESOURCES",
  "ERR_INVALID_UNIT",
  "ERR_NOT_OWNER",
  "ERR_OUT_OF_RANGE",
  "ERR_INVALID_TARGET",
  "ERR_INVALID_SITE",
  "ERR_BAD_ARGS",
];

/**
 * API **类型面**上的名字(逐字清单,来自面向模型的契约草案 §1/§6)。
 *
 * 刻意写成一份可枚举的清单而不是一段散文:判据「不收类型名」要能被机器复查,就得先有一个
 * 能枚举的「类型名」集合。这份清单是本包对「类型面有哪些名字」的唯一已知枚举——类型面本身
 * 尚未落库(hld §6.2),所以它是**逐字清单**而不是从类型面投影出来的。
 */
const TYPE_FACE_NAMES: readonly string[] = [
  "UnitType",
  "IntentKind",
  "ErrCode",
  "ErrResult",
  "Snapshot",
  "Intent",
];

/**
 * 判据的「收」这一侧:22 个名字逐字在表里,不多不少,顺序即书写序。
 *
 * 反例:从真源里摘掉 `getMyIndex` 这一行,本条立刻红;往表里加任意一个名字(哪怕叫
 * `getResources`),本条也立刻红。它防的是「判据定了,表没跟上」与「有人顺手多加一个」。
 */
it("判据的收这一侧:注入面就是那 22 个名字,不多不少", () => {
  expect([...SANDBOX_INJECTED_API_SYMBOLS]).toEqual(EXPECTED_SYMBOLS);
});

/**
 * **机器断言:类型名入表即红(本票的核心护栏)。**
 *
 * 失败模式很具体:`UnitType` 这类名字被当成「脚本能用的名字」写进注入面,于是面向模型的文档
 * 告诉模型它有一个可引用的全局 `UnitType`,而擦掉类型标注后运行时根本没有这个名字——
 * 类型面与符号面分叉成了两个家,且分叉的那一头没有任何机器信号。
 *
 * 反例:往目录里加一条 `{ symbol: "UnitType", kind: "query" }`,本条红。
 */
it("判据的不收这一侧:类型面的名字一个都不许进注入面", () => {
  for (const name of TYPE_FACE_NAMES) {
    expect(
      SANDBOX_INJECTED_API_SYMBOLS,
      `${name} 是类型名,运行时没有这个值,不得入表`,
    ).not.toContain(name);
  }
});

/**
 * 每一行都标了类别,而类别只有「查询 / 动作 / 座位自认 / helper / 错误码」五档。
 *
 * 与上面那条逐字清单互补:清单按名字查,这一条按**形状**查——有人加了一个不叫已知类型名、
 * 但显然是个类型的东西,它在类别上就无处安放。
 *
 * 反例:给目录加一档类别、或删掉某行的 `kind`,本条红。
 */
it("每一行都有类别,且类别只有运行时那五档", () => {
  const expectedKinds: readonly InjectedApiSymbolKind[] = [
    "query",
    "action",
    "seat",
    "helper",
    "error-code",
  ];
  for (const entry of SANDBOX_INJECTED_API_SYMBOL_CATALOG) {
    expect(expectedKinds, `${entry.symbol} 的类别不在运行时那五档里`).toContain(entry.kind);
    expect(entry.reason, `${entry.symbol} 缺「为什么收」`).not.toBe("");
  }
  expect(new Set(SANDBOX_INJECTED_API_SYMBOL_CATALOG.map((entry) => entry.kind))).toEqual(
    new Set(expectedKinds),
  );
});

/**
 * **每一行都带一句「为什么收」;四个函数档还带签名,错误码那一档不带。**
 *
 * 分档的意义在这里兑现:函数档缺签名、错误码档多一个签名,两种形态错位都在 `tsc -b` 与本条上说话。
 * 运行期这一半查的是**渲染出来会不会是空格**——面向模型的 API 表把签名当一栏渲染,少了它那一栏
 * 就是空的,而模型会照着空的写。
 *
 * 签名同时也是「签名只此一家」的证据:文档里那一栏由它逐字渲染,不多不少。
 *
 * 反例:删掉某一行函数档的 `signature`(先把它改成可选字段才编得过),本条红。
 */
it("每一行都有「为什么收」,函数档都有签名而错误码档没有", () => {
  const signatures = new Set<string>();
  for (const entry of SANDBOX_INJECTED_API_SYMBOL_CATALOG) {
    expect(entry.reason, `${entry.symbol} 缺「为什么收」`).not.toBe("");
    if (entry.kind === "error-code") {
      // 它是一个字符串常量,不是函数:签名那一栏对它不存在,渲染时不留空。
      continue;
    }
    expect(entry.signature, `${entry.symbol} 是函数档,缺签名`).toMatch(/^\w+\(.*\):\s*\S/);
    expect(entry.signature, `${entry.symbol} 的签名里没有它自己的名字`).toContain(
      `${entry.symbol}(`,
    );
    signatures.add(entry.signature);
  }
  // 签名各不相同:两条一样的签名意味着其中一条写错了(或者两行其实说的是同一个函数)。
  expect(signatures.size, "签名有重复").toBe(
    SANDBOX_INJECTED_API_SYMBOL_CATALOG.filter((entry) => entry.kind !== "error-code").length,
  );
});

/**
 * 裸名字清单**由目录投影而来**:名字只有一处可改。
 *
 * 反例:在真源里再补一份 `SANDBOX_INJECTED_API_SYMBOLS` 字面量而目录没跟上(或反过来),
 * 本条立刻红——它守的是「一个事实一个家」,而逐个理由必须与名字住在一起。
 */
it("裸名字清单是目录的投影,不是一个事实的第二份抄本", () => {
  expect(SANDBOX_INJECTED_API_SYMBOLS).toEqual(
    SANDBOX_INJECTED_API_SYMBOL_CATALOG.map((entry) => entry.symbol),
  );
});

/**
 * **机器断言:注入面里不得出现带宿主桥前缀的名字。**
 *
 * 失败模式很具体:注入面里躺着一个带前缀的名字,而静态校验器按桥前缀规则一律判违规——
 * 于是同一个名字被执行器当注入 API 铺上、又被校验器拒掉,两头都坏。注入面那一侧今天**没有
 * 任何规则消费它**(放行它的是编译器的名字解析,hld §6.2),但这不减轻这条断言:桥走的是
 * 前缀约定,注入面走的是这张表,两者分属两条约定,而这条断言是它们唯一的机器保证。
 * 回填前它恒真,回填后它是活断言——这正是它当初被写在回填之前的原因。
 *
 * 反例:加进 `"__setSnapshot"`,本条红。
 */
it("注入面里没有带宿主桥前缀的名字", () => {
  const bridgeNamed = SANDBOX_INJECTED_API_SYMBOLS.filter((symbol) =>
    symbol.startsWith(HOST_BRIDGE_PREFIX),
  );
  expect(bridgeNamed, "带宿主桥前缀的名字属于宿主注入的桥,不属于沙箱注入面").toEqual([]);
});

/**
 * **机器断言:注入面与禁列不相交。**
 *
 * 注入面是「runtime 铺上、编译侧放行」的那一张,禁列是「校验器拒、runtime 不该有」的那一张。
 * 一个名字同时落在两张表里,静态校验器按判定链拒掉它,而 runtime 却铺了它——于是「注入面」
 * 的语义自相矛盾。
 *
 * 反例:把 `"Date"` 同时写进两张表,本条红。
 */
it("注入面与禁列不相交", () => {
  const intersection = FORBIDDEN_GLOBAL_NAMES.filter((name) =>
    SANDBOX_INJECTED_API_SYMBOLS.includes(name),
  );
  expect(intersection, "注入面与禁列相交").toEqual([]);
});

/**
 * **机器断言:注入面与内置全局白名单不相交。**
 *
 * 内置全局是 **JS 语言自己**定义在全局上的名字,注入面是 **沙箱 runtime 铺上去**的名字,
 * 两者的提供者不同。一个名字同时落在两张表里,「这个全局是谁给的」就有两个家:白名单说
 * 语言自带,注入面说 runtime 铺的——面向模型的文档渲染哪一张,决定了模型对它消失时怎么想。
 *
 * 反例:把 `"JSON"` 同时写进两张表,本条红。
 */
it("注入面与内置全局白名单不相交", () => {
  const intersection = BUILTIN_GLOBAL_NAMES.filter((name) =>
    SANDBOX_INJECTED_API_SYMBOLS.includes(name),
  );
  expect(intersection, "注入面与内置全局白名单相交").toEqual([]);
});

/**
 * 这张表只装**裸全局名**,成员路径不进这张表。`Math.random` 是成员路径(在禁列里),
 * 把成员路径塞进注入面会让「这个名字存不存在」这件事有两套查法。
 *
 * 反例:加进 `"Math.abs"` 或 `"getTick.now"` 这样的项,本条红。
 */
it("表里只有裸全局名,没有成员路径", () => {
  for (const symbol of SANDBOX_INJECTED_API_SYMBOLS) {
    expect(symbol.includes("."), `${symbol} 是成员路径,不属于这张表`).toBe(false);
    expect(symbol, `${symbol} 不是合法的标识符形态`).toMatch(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
  }
});

/**
 * 表内无重复,且判据生效期间不为空。
 *
 * 「不为空」这条会随判据变更变红,那是有意的:判据一旦撤销,空表就是正确答案,让人先改这里。
 * 「无重复」是因为这张表会被渲染进面向模型的文档,重复项在文档里是肉眼难查的错误。
 */
it("注入面表内无重复,且判据生效期间不为空", () => {
  expect(new Set(SANDBOX_INJECTED_API_SYMBOLS).size).toBe(SANDBOX_INJECTED_API_SYMBOLS.length);
  expect(SANDBOX_INJECTED_API_SYMBOLS.length, "判据已裁决,注入面不该退回空表").toBeGreaterThan(0);
});
