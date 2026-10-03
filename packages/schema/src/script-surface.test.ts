/**
 * 参赛脚本可见面的**两张表之间**的不变量断言(宿主桥前缀 / 沙箱注入符号表 / 禁列全局名)。
 *
 * ── 为什么落在这里,不在校验器里 ───────────────────────────────────────────────
 * 这三条断言的对象是**表与表的关系**,而这三张表都是本包的事实(经生成器分发到
 * `packages/tools`,规则层一个名字都不自己存)。放到校验器侧断言,得到的只能是
 * 「空集合里没有带前缀的名字」这种恒真的废话——注入表现在还空着,它在回填之前
 * 什么也不保证,而它必须在场:回填那天,一条守在那里的断言就是拦绳。
 *
 * 反例手法:把一个带前缀的名字写进 `SANDBOX_INJECTED_API_SYMBOLS`(真源里),对应那条立刻红。
 */

import { expect, it } from "vitest";

import {
  FORBIDDEN_GLOBAL_NAMES,
  HOST_BRIDGE_PREFIX,
  SANDBOX_INJECTED_API_SYMBOLS,
} from "./index.js";

/**
 * **机器断言:沙箱注入符号表里不得出现带宿主桥前缀的名字。**
 *
 * 失败模式很具体:注入面里躺着一个带前缀的名字,而静态校验器把带前缀的名字一律判违规,
 * 于是「校验器放行但运行时报未定义」与「校验器拦掉一个执行器本该注入的符号」两头都坏——
 * 桥走的是前缀约定,注入面走的是这张表,两者分属两条约定,而这条断言是它们唯一的机器保证。
 * 真源侧 `SANDBOX_INJECTED_API_SYMBOLS` 的头注把这一点写成了纪律:桥与注入面必须分清。
 *
 * 当前恒真(表为空),而恒真正是它此刻该有的样子:断言在沙箱执行器回填注入面之前就位,
 * 回填那天它才开始干活。反例:加进 `"__setSnapshot"`,本条红。
 */
it("注入面里没有带宿主桥前缀的名字", () => {
  const bridgeNamed = SANDBOX_INJECTED_API_SYMBOLS.filter((symbol) =>
    symbol.startsWith(HOST_BRIDGE_PREFIX),
  );
  expect(bridgeNamed, "带宿主桥前缀的名字属于宿主注入的桥,不属于沙箱注入面").toEqual([]);
});

/**
 * 注入面与禁列不得相交,方向与上一条同类:注入面是「校验器放行、runtime 铺上」的那一张,
 * 禁列是「校验器拒、runtime 不该有」的那一张。一个名字同时落在两张表里,
 * 静态校验器按判定链先判禁列于是拒掉它,而 runtime 却铺了它——于是「注入面」的语义自相矛盾。
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
 * 注入面里没有重复。注入面是「每个名字铺一次」的承诺,重复项会让 runtime 那侧多铺一次,
 * 而多铺一次在真实沙箱里是一次没人预料到的重定义。
 *
 * 反例:把同一个名字写两遍,本条红。
 */
it("注入面表内无重复", () => {
  expect(new Set(SANDBOX_INJECTED_API_SYMBOLS).size).toBe(SANDBOX_INJECTED_API_SYMBOLS.length);
});
