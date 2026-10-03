/**
 * 内置全局白名单(`BUILTIN_GLOBAL_NAMES`)的断言:判据的两个方向、两表不相交。
 *
 * 这里断言的是**名单与判据的关系**,不是任何函数的行为——这张表的消费者是规则文档的生成与
 * 编译器的名字解析(见真源侧头注),本包内没有读取它的规则,因此没有别的断言面。
 * 每条都配了**能被弄红的反例**(手法记在各条注释里):把一个名字挪进/挪出这张表就能弄红,
 * 改判据的文字而不同步名单则弄不红——所以判据那一句本身由下面的方向用例守着。
 */

import { expect, it } from "vitest";

import { BUILTIN_GLOBAL_NAMES, FORBIDDEN_GLOBAL_NAMES, HOST_BRIDGE_PREFIX } from "./index.js";

/**
 * 判据的「收」这一侧:一组现有的内置全局必须都在表里。
 *
 * 反例:从真源里摘掉 `JSON` 这一行,第一条立刻红。它防的是「判据定了,表没跟上」——
 * 也就是先前那个「判据未裁决故空着」的状态换个名字回来。
 */
it("判据的收这一侧:一组现有的内置全局都在表里", () => {
  for (const name of ["JSON", "Object", "Array", "Map", "Set", "Number", "String", "Math"]) {
    expect(BUILTIN_GLOBAL_NAMES, `${name} 满足判据,必须在白名单里`).toContain(name);
  }
});

/**
 * 判据的「不收」这一侧:不满足判据的名字一个都不许在表里,且它们都在禁列里。
 *
 * `Date`/`performance` 与 `Math.random` 这三个是判据与禁列**同向**的那组:
 * 判据给出的理由与禁列逐条一致,所以它们只出现在禁列里。反例:把 `Date` 加进白名单,
 * 本条与下面那条不相交断言同时红。
 */
it("判据的不收这一侧:与禁列同向的名字不在表里,且都在禁列里", () => {
  for (const name of ["Date", "performance", "Math.random"]) {
    expect(BUILTIN_GLOBAL_NAMES, `${name} 不满足判据,不得进白名单`).not.toContain(name);
    expect(FORBIDDEN_GLOBAL_NAMES, `${name} 应当在禁列里`).toContain(name);
  }
});

/**
 * **机器断言:内置全局白名单与禁列不得相交。**
 *
 * 相交的失败模式很具体:白名单里躺着一个禁列名字,于是「白名单放行了禁列」。
 * 判定链把禁列排在白名单之前判,是为了在这种情况下也不放行,但次序只是兜底,真正的护栏是这里。
 * 反例:把 `Date` 同时写进两张表,本条红。
 */
it("两表不相交:白名单里不许有禁列名字", () => {
  const intersection = BUILTIN_GLOBAL_NAMES.filter((name) => FORBIDDEN_GLOBAL_NAMES.includes(name));
  expect(intersection, "白名单与禁列相交").toEqual([]);
});

/**
 * 这张表只装**全局名**,成员路径不进这张表。`Math.random` 是成员路径(在禁列里),
 * 把它塞进来是这张表最可能被犯的形态错误,所以单独钉一条。
 *
 * 反例:加进 `"Math.abs"` 这样的项,本条红。
 */
it("表里只有全局名,没有成员路径", () => {
  for (const name of BUILTIN_GLOBAL_NAMES) {
    expect(name.includes("."), `${name} 是成员路径,不属于这张表`).toBe(false);
  }
});

/**
 * 表里没有宿主桥的名字。桥是宿主注入的(静态校验器一律禁),与内置全局是相反的两张表,
 * 这里钉一条是为了让「把注入面/桥的名字抄进白名单」这件事当场红。
 *
 * 反例:加进 `"__setSnapshot"`,本条红。
 */
it("表里没有宿主桥前缀的名字", () => {
  for (const name of BUILTIN_GLOBAL_NAMES) {
    expect(name.startsWith(HOST_BRIDGE_PREFIX), `${name} 带宿主桥前缀,不属于这张表`).toBe(false);
  }
});

/**
 * 表内无重复,且不为空。
 *
 * 「不为空」这条会随判据变更变红,那是有意的:判据一旦撤销,空表就是正确答案,让人先改这里。
 * 「无重复」是因为这张表会被渲染进面向模型的文档,重复项在文档里是肉眼难查的错误。
 */
it("表内无重复,且判据生效期间不为空", () => {
  expect(new Set(BUILTIN_GLOBAL_NAMES).size, "表内有重复名字").toBe(BUILTIN_GLOBAL_NAMES.length);
  expect(BUILTIN_GLOBAL_NAMES.length, "判据已裁决,表不该退回空表").toBeGreaterThan(0);
});
