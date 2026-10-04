/**
 * 「每个事实只有一个家」的一道**窄断言**:参赛脚本**入口签名的形态**归 `docs/rules-v1/api.md`
 * §1.1,设计四份文档与 `CONTEXT.md` 里不许再出现 `function loop` 这个字面量。
 *
 * ── 它补的是哪一个洞 ──
 * 入口签名是一条**契约事实**,它的家是面向模型那份 `api.md`(返回类型可省略,两种写法都对)。
 * 工程侧的 `hld` 需要的是另一件事:单文件、无模块语法、入口名固定为 `loop`——那三件事归它。
 * 两件事贴在一起时人只会看见一行,于是「在 hld 里写一句 `function loop(): void`」看起来只是
 * 随手引一下,实际上那一份会与 `api.md` 分叉,而且**没有任何东西会变红**:漂移检查只比生成区块,
 * 比不到散文。本轮收口时它真的分叉过两次(hld §2.2.2 与 §6.2 各留了一份带/不带返回类型的写法,
 * `api.md` 写的是可省略),修掉了但没钉住——所以钉一下。
 *
 * ── 判据为什么这么窄 ──
 * 只禁**那一个签名形态的字面量**,不禁 `loop()`:那四份文档里提到「四方 `loop()` 串行执行」
 * 「VM 调得动 `loop`」是工程叙述,禁掉就是收罚正常改写。禁形状不禁名字,误报面就压在这一行上。
 *
 * ── 为什么集合里只有设计四份 + `CONTEXT.md`,没有契约那两份 ──
 * `api.md` 是家;`rules.md` 是同伴,它引签名是**引用**不是**复制**。「引用还是复制」要看上下文,
 * 一条字面量断言判不了,硬把它拉进集合就是给门禁埋一个必然误报的口子。收窄到工程/规则/需求/
 * 可行性那侧,这五份里出现签名形态一定是复制,没有例外。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

/** 家:面向模型那份 API 契约。 */
const SIGNATURE_HOME = "docs/rules-v1/api.md";

/** 不许再抄一份的那些文档。 */
const NOT_THE_HOME = [
  "docs/hld.md",
  "docs/gdd.md",
  "docs/srs.md",
  "docs/fsr.md",
  "CONTEXT.md",
] as const;

const read = (relativeToRepoRoot: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${relativeToRepoRoot}`, import.meta.url)), "utf8");

/** 那一个字面量。反引号摘掉:签名在文档里是行内代码形态,摘与不摘是同一处。 */
const copiesEntrySignature = (text: string): boolean =>
  /function\s+loop/.test(text.replaceAll("`", ""));

it("判据不是恒红:带签名的那一份被判红,只提 `loop()` 的工程叙述放行", () => {
  expect(copiesEntrySignature("顶层声明 `function loop(): void` 作为入口。")).toBe(true);
  expect(copiesEntrySignature("顶层声明 `function loop()` 作为入口。")).toBe(true);
  // 只出现名字、不出现签名的,都是合法的工程叙述。
  expect(copiesEntrySignature("引擎按 playerIndex 0..3 串行执行四方 `loop()`。")).toBe(false);
  expect(copiesEntrySignature("`loop` 的 typeof 是 function。")).toBe(false);
});

it("家那份确实写着入口签名(正向对照:不是「没人写签名」的空断言)", () => {
  const home = read(SIGNATURE_HOME);
  expect(copiesEntrySignature(home)).toBe(true);
  // 家还额外说清了「返回类型可省略」——这条才是它作为家的理由,形状本身不算。
  expect(home).toContain("返回类型可省略");
});

it("设计四份文档与 CONTEXT 现在都不再抄入口签名", () => {
  for (const doc of NOT_THE_HOME) {
    expect(copiesEntrySignature(read(doc)), `${doc} 里出现了入口签名的第二份`).toBe(false);
  }
});
