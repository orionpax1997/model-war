import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import {
  boundParameterNames,
  describeHandCopiedValue,
  handCopiedValuesIn,
} from "./rules-doc-prose.ts";

const rulesDoc = fileURLToPath(new URL("../../../docs/rules-v1/rules.md", import.meta.url));

/** 一段正文 + 一张生成区块,拼成门禁真正吃的那份文件形状。 */
const withValueTable = (prose: string): string =>
  [
    prose,
    "<!-- generated:rules-v1-value-table:begin -->",
    "| `carryLimit` | 20 | resources |",
    "<!-- generated:rules-v1-value-table:end -->",
    "",
  ].join("\n");

it("门禁的名字清单从键清单推来:21 个键 + 兵种子字段 + 两个派生常量", () => {
  const names = boundParameterNames();
  for (const key of ["tickLimit", "resourcePerSite", "worker", "cavalry", "unitCostDivisor"]) {
    expect(names, `键 ${key} 不在这道门禁的视野里`).toContain(key);
  }
  // 兵种键的子字段以限定名出现:散文最可能抄的就是「worker 的造价」那六个数。
  expect(names).toContain("worker.cost");
  expect(names).toContain("cavalry.spawnTicks");
  expect(names).toContain("FULL_PRODUCTION_COST_RATE");
});

it("收窄门禁:生成区块之外出现「键名 = 数字」就红,区块之内不红", () => {
  // 反例:草案抄过的三种写法各来一次。
  for (const prose of [
    "携带上限:`carryLimit`(=20)",
    "资源点:有限储量 resourcePerSite=125",
    "满载一次需要 captureTicks: 10 个 tick",
    "反向写法同样算:200 = `resourcePerSite`",
    "限定名也算:`worker.cost` 是 4",
  ]) {
    const hits = handCopiedValuesIn(withValueTable(prose));
    expect(hits.length, `这一句没被判红:${prose}`).toBeGreaterThan(0);
  }

  // 同一批数字待在**生成区块里**是它们的 rightful home:数值表里每一格都是「键名 = 数字」,
  // 判据若把那一份也算进来,门禁一开工就红,于是只能被关掉。
  expect(handCopiedValuesIn(withValueTable("正文里没有取值。")).length).toBe(0);
});

it("收窄门禁:正文的正常数字、时间轴分段、示例坐标、倍数关系一律放行", () => {
  const prose = [
    "时间轴按 `tickLimit` 的比例分段:0–40 开矿出兵,160–400 中后期争夺。",
    "示例(3×3 坐标系):A(0,0)→(1,1)、B(2,2)→(1,1)。",
    "骑兵的速度是其余兵种的两倍,造价不低于近战的两倍。",
    "射程只有相邻一格;见 §10 数值表的 `cavalry.range`。",
    "占用离矿近的格子会让往返少走 4 格,吞吐按 §10 的 `harvestRate` 折算。",
    "TODO(→ 机制契约:七步 tick 结算管线,本节未排期)",
  ].join("\n");
  expect(handCopiedValuesIn(withValueTable(prose))).toEqual([]);
});

it("收窄门禁:报告指得出是哪一行哪一个键", () => {
  const hits = handCopiedValuesIn(withValueTable("第一行。\n携带上限 `carryLimit`(=20)。"));
  expect(hits).toHaveLength(1);
  const hit = hits[0];
  expect(hit?.key).toBe("carryLimit");
  expect(hit?.line).toBe(2);
  expect(describeHandCopiedValue(hit!), describeHandCopiedValue(hit!)).toContain("第 2 行");
  expect(describeHandCopiedValue(hit!)).toContain("carryLimit");
});

it("收窄门禁:更长的标识符里含有键名不算命中", () => {
  expect(handCopiedValuesIn(withValueTable("结算器读 myTickLimitOf = 600 去做什么。"))).toEqual([]);
});

it("规则文档正文现在没有手抄的第二份取值", () => {
  const hits = handCopiedValuesIn(readFileSync(rulesDoc, "utf8"));
  expect(
    hits.map((hit) => describeHandCopiedValue(hit)).join("\n"),
    "规则文档的生成区块之外出现了键名绑数字",
  ).toBe("");
});
