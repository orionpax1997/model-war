/**
 * 面向模型的 API 文档与注入面符号表之间的**双向**机器断言。
 *
 * ── 为什么断言的对象是「落库的那份文档」而不是「生产函数的输出」 ──────────────────
 * 生产函数的输出按定义与真源一致,对着它断言等于什么都不查。这里读的是**工作树里那份
 * `docs/rules-v1/api.md`**:它才是模型读到的东西,而它可以因为三种原因与符号表分叉——
 * 改了真源没重跑生成器、区块正文被手改、以及**有人在文档里多写了一个名字**。
 * 最后一种任何「生成器输出 vs 真源」的检查都看不见:多出来的名字不在真源里,生成器不会去覆盖它,
 * 而模型会照着它写脚本。
 *
 * ── 两个方向各自抓什么 ────────────────────────────────────────────────────────
 * - **文档 ⊆ 符号表**(文档多写一个名字即红):多写的那个名字对沙箱 runtime 压根不存在,
 *   模型照着写就是一次「API 误用」,而且错得静默(运行时报名字未定义,静态层无从判)。
 * - **符号表 ⊆ 文档**(符号表里有、文档里没有的名字也要报):这是**漏披露**——模型会当它不存在,
 *   于是走一条更笨的路(比如自己算 Chebyshev 距离,或者靠位置反推座位)。
 *
 * ── 怎么从文档里取名字而不解析整篇 Markdown ───────────────────────────────────
 * 只取**两行定界标记之间**、且**表格首列是反引号包着的标识符**的那些行。ADR-0004 之所以否掉
 * 「解析 Markdown 抽标识符」那条路,是因为它要扫全篇散文、误报面极大;限定在生成区块的表头列上,
 * 误报面就只剩「表里第一格写了个反引号标识符」这一种,而那本来就该红。
 * 抽取的机械是 `section.ts` 那一份,与漂移检查抽的是同一段字节。
 *
 * ── 反例手法 ──────────────────────────────────────────────────────────────────
 * 在区块正文里加一行 `| \`getResources\` | … | … |`(方向一红),或删掉一行 `| \`getTick\` | … |`(方向二红)。
 * 两条都在别的用例里做成「红 → 还原 → 绿」的闭环;这里只查判决,还原由漂移门禁那一节做。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, it } from "vitest";

import { SANDBOX_INJECTED_API_SYMBOL_CATALOG, SCRIPT_OUTCOME_CATALOG } from "@model-war/schema";

import { readSection, sectionMarker } from "./generate/section.ts";

/** 契约文档里 API 面那一份。仓库根起的相对路径,与生成物落点同一记法。 */
const API_DOC = resolve(import.meta.dirname, "../../../docs/rules-v1/api.md");

/** 符号表里的 22 个名字,以及那一档的错误码。**投影**而来,与生成器取的是同一份数据。 */
const SYMBOLS: readonly string[] = SANDBOX_INJECTED_API_SYMBOL_CATALOG.map((e) => e.symbol);
const ERROR_CODES: readonly string[] = SANDBOX_INJECTED_API_SYMBOL_CATALOG.filter(
  (entry) => entry.kind === "error-code",
).map((entry) => entry.symbol);

/**
 * 抽出一个生成区块的正文;抽不出就是**当场红**,不按「无事可查」放过。
 *
 * 与 `section.ts` 同一纪律:抽不出分成「整段没了」与「只剩一端」两态,这里合起来报同一个红,
 * 因为对读者来说处方一样(把标记与正文写回去)。若这里放过,下面两条断言就变成在空串上跑,
 * 而空串与符号表的交集是空集——**两条都会绿**。
 */
const sectionContent = (id: string): string => {
  const read = readSection(readFileSync(API_DOC, "utf8"), sectionMarker(id));
  expect(read.state, `${API_DOC} 里抽不出区块 \`${id}\`,下面的断言会在空串上跑`).toBe("found");
  return read.state === "found" ? read.content : "";
};

/** 表头列是反引号包着的标识符的那些行,即 API 表与错误码表的行。 */
const NAME_CELL = /^\|\s*`([A-Za-z_$][A-Za-z0-9_$]*)`\s*\|/;

/** 按字典序排一份字符串清单。集合比较与书写序无关,所以先排——手写比较器也只此一份。 */
const sorted = (names: readonly string[]): readonly string[] =>
  [...names].sort((a, b) => a.localeCompare(b));

/** 区块里出现的全部表头列名字(可重复,顺序即书写序)。 */
const nameCells = (content: string): readonly string[] =>
  content
    .split("\n")
    .map((line) => NAME_CELL.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);

/**
 * **方向一:文档里收进表的每个 API 名字都在符号表里。**
 *
 * 反例:在 API 表里加一行 `| \`getResources\` | \`getResources(): number\` | 手写的一行。 |`,本条红。
 */
it("API 文档里的每个 API 名字都在注入面符号表里", () => {
  const documented = nameCells(sectionContent("api-v1-api-surface"));
  expect(documented.length, "API 表与错误码表一行都没有,断言会在空集上绿").toBeGreaterThan(0);
  for (const name of documented) {
    expect(
      SYMBOLS,
      `文档里出现了符号表没有的名字 \`${name}\`,模型照着写就会调用一个不存在的 API`,
    ).toContain(name);
  }
});

/**
 * **方向二:符号表里的每个名字都在 API 文档里出现,一个不缺。**
 *
 * 这是漏披露那一侧,也是更隐蔽的一侧:少了 `getMyIndex`,模型会去靠单位位置反推座位(明令禁止的写法);
 * 少了某个错误码,它就压根不知道自己会拿到什么。
 *
 * 反例:从 API 表里删掉 `| \`getTick\` | … |` 那一行,本条红。
 */
it("注入面符号表里的每个名字都在 API 文档里披露", () => {
  const documented = nameCells(sectionContent("api-v1-api-surface"));
  for (const name of SYMBOLS) {
    expect(
      documented,
      `符号表里有 \`${name}\`,而 API 文档的表里没有它——模型会当它不存在`,
    ).toContain(name);
  }
});

/**
 * **错误码集合两边逐字相同**,且每个码都有一句非空的触发条件。
 *
 * 「全定」这件事的机器形态:符号表里的七个码全部落在文档的错误码表上,一个不多一个不少。
 * 触发条件那一列非空,是因为**半截的码表比没有码表更坏**——模型会把「有码名、没有触发条件」
 * 读成「这个码什么情况下都会来」,于是到处去判它。
 *
 * 反例:从真源里删掉 `ERR_BAD_ARGS` 那一行(只删文档不改真源),本条红。
 */
it("错误码集合在文档与符号表之间逐字相同,且每码都带一句触发条件", () => {
  const content = sectionContent("api-v1-api-surface");
  const rows = content
    .split("\n")
    .filter((line) => line.startsWith(`| \`ERR_`))
    .map((line) =>
      line
        .replace(/^\|\s*/, "")
        .replace(/\s*\|\s*$/, "")
        .split(/\s+\|\s+/),
    );
  // 空串不会蒙对:集合与 `ERROR_CODES` 逐字相等,一行缺格会多出一个空串而当场红。
  const documented = rows.map((cells) => cells[0]?.replace(/^`|`$/g, "") ?? "");
  expect(sorted(documented), "文档里的错误码集合与符号表不一致").toEqual(sorted(ERROR_CODES));
  for (const cells of rows) {
    expect(cells.length, `错误码行少一列:\n${cells.join(" | ")}`).toBe(3);
    expect(cells[1]?.trim(), "错误码缺一句触发条件(半截的码表比没有码表更坏)").not.toBe("");
    // 第三列是「落在哪类」,只允许那两个字:模型据此决定要不要兜,多出第三种读不出来。
    expect(["丢弃", "异常"], `「落在哪类」那一列不是那两个字:\n${cells.join(" | ")}`).toContain(
      cells[2]?.trim(),
    );
  }
});

/**
 * **「丢弃 vs 异常」对照表与错误码表说的是同一件事。**
 *
 * 断言的是对照表那一节里被点名的错误码集合:每个码恰好出现在一行里。少了它,对照表就漏了某个码;
 * 多了它,对照表里就有一个符号表里没有的码——两者都是模型读到的契约在自相矛盾。
 *
 * 反例:从对照表某一行里删掉 `\`ERR_BAD_ARGS\``,本条红。
 */
it("丢弃 vs 异常对照表里被点名的错误码与符号表一致", () => {
  const content = sectionContent("api-v1-outcome-table");
  const named = [...content.matchAll(/`(ERR_[A-Z_]+)`/g)].map((matched) => matched[1] ?? "");
  expect(named.length, "对照表一个错误码都没点名").toBeGreaterThan(0);
  expect(sorted([...new Set(named)]), "对照表点名的错误码与符号表不一致").toEqual(
    sorted(ERROR_CODES),
  );
  // 每一行都带类:对照表的价值全在「这一行落在哪一类」上,缺了它就退化成一张情形清单。
  for (const entry of SCRIPT_OUTCOME_CATALOG) {
    expect(content, `后果行「${entry.situation.slice(0, 12)}…」没落进对照表`).toContain(
      entry.situation.slice(0, 12),
    );
  }
});
