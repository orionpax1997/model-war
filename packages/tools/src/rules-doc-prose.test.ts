import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { RULESET_KEY_CATALOG } from "@model-war/schema";

import {
  PROSE_SCANNED_DIRS,
  boundParameterNamesFrom,
  describeHandCopiedValue,
  documentsInDir,
  handCopiedValuesIn,
  keyNamesFromRulesetSource,
  proseScanTargets,
} from "./rules-doc-prose.ts";

/** 本文件在 `<repo>/packages/tools/src/` 下,上溯三级是仓库根。 */
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const RULESET_KEYS_SOURCE = "packages/schema/src/ruleset-keys.ts";
const sourceText = readFileSync(`${repoRoot}${RULESET_KEYS_SOURCE}`, "utf8");

/** 门禁入口用的那一份名字全集(从源码文本抽,不 import 真源包——那是零构建的代价与收益)。 */
const NAMES = boundParameterNamesFrom(sourceText);

const read = (relative: string): string => readFileSync(`${repoRoot}${relative}`, "utf8");

/** 一段正文 + 一张生成区块,拼成门禁真正吃的那份文件形状。 */
const withValueTable = (prose: string): string =>
  [
    prose,
    "<!-- generated:rules-v1-value-table:begin -->",
    "| `carryLimit` | 20 | resources |",
    "<!-- generated:rules-v1-value-table:end -->",
    "",
  ].join("\n");

it("源码文本抽出的名字集合与键清单一致(抽取退化时这条先红)", () => {
  // 这条对照是「读源码文本」那条绕法的代价所在:抽取规则跟着真源改写而退化时,门禁会静默失明,
  // 所以这里直接用真源包编译后的键清单对账。测试可以 import 真源包——vitest 会先跑构建。
  const expected: string[] = Object.keys(RULESET_KEY_CATALOG);
  for (const [key, entry] of Object.entries(RULESET_KEY_CATALOG)) {
    if (entry.schema.type !== "object") continue;
    for (const field of entry.schema.required) expected.push(`${key}.${field}`);
  }
  expect([...keyNamesFromRulesetSource(sourceText)].sort()).toEqual(expected.sort());
});

it("门禁的名字全集:源码抽出的键名 + 兵种限定名 + 两个派生常量", () => {
  for (const name of ["tickLimit", "resourcePerSite", "worker", "cavalry", "unitCostDivisor"]) {
    expect(NAMES, `键 ${name} 不在这道门禁的视野里`).toContain(name);
  }
  // 兵种键的子字段以限定名出现:散文最可能抄的就是「worker 的造价」那六个数。
  expect(NAMES).toContain("worker.cost");
  expect(NAMES).toContain("cavalry.spawnTicks");
  expect(NAMES).toContain("FULL_PRODUCTION_COST_RATE");
  expect(NAMES).toContain("SPAWN_TICKS_COEFFICIENT");
  expect(NAMES).toHaveLength(21 + 4 * 6 + 2);
});

it("空转反例:抽不到名字时返回空清单,由门禁入口按失败处理", () => {
  // 源码形状变了 / 文件读错了,这里必须是「0 个名字」而不是「恰好没有命中」——前者门禁入口
  // 用 `vacuousReason` 判红,后者会变成一条永远绿的假门禁。
  expect(keyNamesFromRulesetSource("")).toEqual([]);
  expect(keyNamesFromRulesetSource("export const RULESET_KEY_CATALOG = {};")).toEqual([]);
  expect(boundParameterNamesFrom("")).toHaveLength(2); // 只剩手写的两个派生常量名
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
    const hits = handCopiedValuesIn(withValueTable(prose), NAMES);
    expect(hits.length, `这一句没被判红:${prose}`).toBeGreaterThan(0);
  }

  // 同一批数字待在**生成区块里**是它们的 rightful home:数值表里每一格都是「键名 = 数字」,
  // 判据若把那一份也算进来,门禁一开工就红,于是只能被关掉。
  expect(handCopiedValuesIn(withValueTable("正文里没有取值。"), NAMES).length).toBe(0);
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
  expect(handCopiedValuesIn(withValueTable(prose), NAMES)).toEqual([]);
});

it("变更记账例外:数字紧邻箭头时放行(正向、反向、四种字形)", () => {
  for (const prose of [
    "预算终值改了两处:`eventTickLimit` 10000→50000。",
    "预算终值改了两处:eventTickLimit 10000 -> 50000。",
    "反向记账同样放行:50000←`eventTickLimit`。",
    "反向记账同样放行:50000 <- eventTickLimit。",
    "带空格也认:`apiCallTickLimit` 300 → 800。",
    "旧值在箭头左侧的另一种写法:`carryLimit` 20 ← 30。",
  ]) {
    expect(handCopiedValuesIn(withValueTable(prose), NAMES), `这句被误判:${prose}`).toEqual([]);
  }
});

it("变更记账例外不扩大:非箭头两侧照旧红,箭头只在别处不算", () => {
  for (const prose of [
    "静态陈述照旧红:`eventTickLimit` 10000。",
    "静态陈述照旧红:eventTickLimit: 10000",
    // 箭头在这一行里,但没贴着命中的那个数字:这不是记账,是「静态陈述 + 一句无关的对比」。
    "静态陈述夹着别处的箭头:`carryLimit` 20,而另见 30→40。",
    "反向写法照旧红:200 = `resourcePerSite`",
  ]) {
    expect(
      handCopiedValuesIn(withValueTable(prose), NAMES).length,
      `这句该红却放行了:${prose}`,
    ).toBeGreaterThan(0);
  }
});

it("收窄门禁:报告指得出是哪一行哪一个键", () => {
  const hits = handCopiedValuesIn(withValueTable("第一行。\n携带上限 `carryLimit`(=20)。"), NAMES);
  expect(hits).toHaveLength(1);
  const hit = hits[0];
  expect(hit?.key).toBe("carryLimit");
  expect(hit?.line).toBe(2);
  const said = describeHandCopiedValue(hit!, "docs/rules-v1/api.md");
  expect(said).toContain("第 2 行");
  expect(said).toContain("carryLimit");
  // 报告里的文档名是调用方给的:两份契约文档共用这一个函数,指错文件名比不报更坏。
  expect(said.startsWith("docs/rules-v1/api.md ")).toBe(true);
});

it("收窄门禁:更长的标识符里含有键名不算命中", () => {
  expect(
    handCopiedValuesIn(withValueTable("结算器读 myTickLimitOf = 600 去做什么。"), NAMES),
  ).toEqual([]);
});

it("扫描集含 ADR 整目录与基准说明:例外只能靠形态,不能靠位置", () => {
  const labels = proseScanTargets(repoRoot).map((target) => target.label);
  // 四份契约文档一份都不能少(模型真读的就是它们)。
  expect(labels).toContain("docs/rules-v1/rules.md");
  expect(labels).toContain("docs/rules-v1/api.md");
  expect(labels).toContain("docs/rules-v2/rules.md");
  expect(labels).toContain("docs/rules-v2/api.md");
  expect(labels).toContain("benchmarks/README.md");
  // ADR 是整目录,不是豁免:至少有一份 ADR 进了扫描集。
  expect(labels.some((label) => label.startsWith("docs/adr/"))).toBe(true);
  // 目录展开按路径排序:两次运行的输出要能 diff。
  const adr = labels.filter((label) => label.startsWith("docs/adr/"));
  expect(adr).toEqual([...adr].sort());
});

it("目录展开:不存在目录返回空(空转反例),真实目录按路径排序", () => {
  const [dir] = PROSE_SCANNED_DIRS;
  expect(dir).toBeDefined();
  expect(documentsInDir("/tmp/definitely-not-a-repo", dir!)).toEqual([]);
  const labels = documentsInDir(repoRoot, dir!).map((target) => target.label);
  expect(labels.length).toBeGreaterThan(0);
  expect(labels).toEqual([...labels].sort());
});

it("扫描集里的文档现在没有手抄的第二份取值", () => {
  // 扫的集合是显式清单 + ADR 整目录,不是「扫到谁算谁」:少列一份就是少一个家。
  // gdd 不在集合里,理由见模块头注。
  for (const target of proseScanTargets(repoRoot)) {
    const hits = handCopiedValuesIn(read(target.path), NAMES);
    expect(
      hits.map((hit) => describeHandCopiedValue(hit, target.label)).join("\n"),
      `${target.label} 的生成区块之外出现了键名绑数字`,
    ).toBe("");
  }
});

it("现有的三处变更记账命中靠箭头例外放行,而不是靠不扫那份文件", () => {
  // 这三处是接线前就存在的散文(ADR-0011 与基准说明),一个字都不改。
  // 断言分两半:①它们确实被扫到,且判据放行;②把箭头改成 `=` 之后同一条判据立刻判红——
  // 证明放行来自形态判定,而不是「这份文件压根没进视野」。
  for (const target of [
    "docs/adr/0011-v1-scripts-migrate-to-v2-without-regen.md",
    "benchmarks/README.md",
  ]) {
    const file = read(target);
    expect(handCopiedValuesIn(file, NAMES), `${target} 里的变更记账被误判`).toEqual([]);
    const flattened = file.replaceAll("\n", " ");
    expect(
      handCopiedValuesIn(flattened.replaceAll("→", "="), NAMES).length,
      `${target} 里那处记账没有真的落在判据视野里,这条「自然转绿」是空话`,
    ).toBeGreaterThan(0);
  }
});
