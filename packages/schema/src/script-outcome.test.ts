/**
 * 「没生效」那张后果表与注入面符号表之间的**双向**不变量断言。
 *
 * ── 为什么落在这个包而不是文档那侧 ─────────────────────────────────────────────
 * 这两条断言的对象是**两张表之间的关系**:每个错误码恰好落在一行上,每一行引用的名字都真的是
 * 一个错误码。两边都是本包的事实(经生成器渲染进面向模型的契约文档),所以断言在这里;
 * 文档那一侧由 `packages/tools` 的漂移检查与它的 API 名对照断言各管一半。
 *
 * ── 这两条为什么不是「顺手看一眼」 ─────────────────────────────────────────────
 * 错位是**静默**的:一个码落进两行,两边各自都读得通;一个码哪行都不落,对照表里就少一行而没人
 * 知道少的是它。而模型是把这份文档当契约读的——它照着「这个码在哪一类」决定要不要兜,
 * 兜错了就是整局白跑。所以这两条要像键数断言一样按「坏了的反例」写。
 *
 * 反例手法见各条注释:把一个码加进第二行、把一行里的名字改成一个函数名、把一行删掉。
 */

import { expect, it } from "vitest";

import {
  SANDBOX_INJECTED_API_SYMBOL_CATALOG,
  SCRIPT_OUTCOME_BY_CODE,
  SCRIPT_OUTCOME_CATALOG,
  SCRIPT_OUTCOME_CLASSES,
} from "./index.js";
import type { ScriptOutcomeKind } from "./index.js";

/** 符号表里那一档的码名。**投影**而来,与生成器取的是同一份数据。 */
const ERROR_CODES: readonly string[] = SANDBOX_INJECTED_API_SYMBOL_CATALOG.filter(
  (entry) => entry.kind === "error-code",
).map((entry) => entry.symbol);

/**
 * **每个错误码恰好落在一行上。**
 *
 * 失败模式有三种,都静默:① 一个码落进两行 → 两张表(错误码表 / 对照表)对它各说一套;
 * ② 一个码哪行都不落 → 对照表里没有它,错误码表里「落在哪类」那一格渲染不出来;
 * ③ 后果表里引用了一个符号表没有的名字 → 那个名字对应的码压根不存在。
 *
 * 反例:往第二行的 `codes` 里再加一个 `"ERR_BAD_ARGS"`,本条红。
 */
it("每个错误码恰好落在一行后果上", () => {
  const listed = SCRIPT_OUTCOME_CATALOG.flatMap((entry) => entry.codes);
  expect([...listed].sort(), "同一个码落进了两行后果").toEqual([...ERROR_CODES].sort());
  // `SCRIPT_OUTCOME_BY_CODE` 是那张对照表与错误码表共同的取数口,它必须与目录同源:
  // 它是投影,所以上面那条断言过了它就不会与目录分叉;这一条把「投影」这件事本身钉住。
  expect([...SCRIPT_OUTCOME_BY_CODE.keys()].sort()).toEqual([...ERROR_CODES].sort());
  expect(SCRIPT_OUTCOME_BY_CODE.size, "投影表的大小与被引用的码数不符").toBe(ERROR_CODES.length);
});

/**
 * **后果行引用的每个名字都是真的错误码**,不是函数名、不是类型名。
 *
 * 反例:把某一行的 `ERR_OUT_OF_RANGE` 改成 `"move"` 或 `"UnitType"`,本条红。
 * 反例二:在 `codes` 里写一个符号表没有的 `"ERR_NO_SIGHT"`,上面那条(逐字相等)也会红。
 */
it("后果行引用的名字都来自错误码那一档", () => {
  for (const entry of SCRIPT_OUTCOME_CATALOG) {
    for (const code of entry.codes) {
      expect(ERROR_CODES, `${code} 不是符号表里的错误码,不能被一行后果引用`).toContain(code);
    }
  }
});

/**
 * **两类后果都有行,而且只有这两类。**
 *
 * 「两类都有行」防的是「某一类定义得整整齐齐,却没有一种情形落在上面」——那等于模型读到一张
 * 空的分类表,而真相是后果只有一种。「只有这两类」防的是有人加第三档:多一档,「要不要兜」
 * 就重新变成一次判断,而这正是这张表存在的理由。
 *
 * 反例:把某一行改成第三档(并给类加一个键),本条红。
 */
it("后果只有丢弃与异常两类,且两类都有行", () => {
  const used = SCRIPT_OUTCOME_CATALOG.map((entry) => entry.kind);
  const expected: readonly ScriptOutcomeKind[] = ["discard", "exception"];
  expect([...new Set(used)].sort(), "落进后果表的类不是那两档").toEqual([...expected]);
  for (const kind of expected) {
    expect(
      used.filter((used) => used === kind).length,
      `${kind} 这一类在后果表里一行都没有`,
    ).toBeGreaterThan(0);
    // 类上的措辞是逐字渲染进模型看得见的文档的,空着会让那一栏渲染成空白。
    const consequence = SCRIPT_OUTCOME_CLASSES[kind];
    expect(consequence.label, `${kind} 缺面向模型的两个字`).not.toBe("");
    expect(consequence.loss, `${kind} 缺「丢的是什么」`).not.toBe("");
    expect(consequence.tally, `${kind} 缺「累计在哪儿」`).not.toBe("");
  }
  expect(Object.keys(SCRIPT_OUTCOME_CLASSES).sort(), "类只有这两档,不多不少").toEqual([
    ...expected,
  ]);
});

/**
 * **「资金不足无效」与「`loop()` 抛异常」是两个不同的后果。**
 *
 * 这组对照是那张对照表最要紧的一格,也是措辞裁决明确点名要保住的一组:两者都发生在
 * 「脚本想干的事没干成」的路上,但一个只丢那一条意图(不扣款、不计异常),另一个把整个 tick
 * 置空并给累计计数加一。把它们并成一行,模型就会以为「写崩 `loop()`」也是丢单条,然后写出
 * 一个每 tick 都崩、却以为自己什么都没丢的脚本。
 *
 * 反例:把「`loop()` 抛异常」那一行的 `kind` 改成 `"discard"`(或者把两行的 `situation`
 * 写成同一句),本条红。
 */
it("资金不足无效与 `loop()` 抛异常必须落在不同的后果行上", () => {
  const rowOf = (needle: string) =>
    SCRIPT_OUTCOME_CATALOG.filter((entry) => entry.situation.includes(needle));
  const insufficient = rowOf("资金不足");
  const crashed = rowOf("`loop()` 抛异常");
  expect(insufficient.length, "「资金不足无效」这一行不见了").toBe(1);
  expect(crashed.length, "「`loop()` 抛异常」这一行不见了").toBe(1);
  expect(insufficient[0]?.codes, "资金不足这一行必须挂着那个码").toEqual([
    "ERR_NOT_ENOUGH_RESOURCES",
  ]);
  // 抛异常那一行**不返回码**:它是整 tick 的判罚,不是某一次调用的返回值。给它挂一个码
  // 会让模型去 `isError` 一个它压根拿不到的东西。
  expect(crashed[0]?.codes, "`loop()` 抛异常不返回错误码,它是整 tick 的判罚").toEqual([]);
  expect(insufficient[0]?.kind).toBe("discard");
  expect(crashed[0]?.kind).toBe("exception");
});
