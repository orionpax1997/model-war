/**
 * 契约包身份(整树 sha256)的自测。
 *
 * ── 三条性质是口径的一部分,不是实现细节 ──
 *
 *  把身份口径写死成「范围 = 挂载清单四条、按路径排序、逐条 `path` + `\0` + 字节、sha256 小写
 * 十六进制」。其中两条**看不见**的后果必须用例钉住,否则换一种实现照样绿:
 *
 * - 对输入顺序不敏感:排序在函数内做。换个顺序就换一串 hex 的实现,会让「谁是第一个文件」这种
 *   与身份无关的事实决定档案的身份。
 * - 对分隔符敏感:`path\0bytes` 的串接若丢了分隔符,`("a", "bc")` 与 `("ab", "c")` 会撞成同一个值。
 *
 * ── 最后一节断言的是「门禁那条缝」而非门禁本身 ──
 *
 * 门禁读真源包的**源码文本**取入库常量(快门禁零构建,`@model-war/schema` 的 exports 指向 `dist`),
 * 那条缝的失效方式很安静:常量声明被改写 ⇒ 抽取返回 `undefined` ⇒ 门禁红(这条有兜),但若抽取
 * 抽出的是**另一条**同形声明,门禁就会拿着一个假的 pin 去比。所以这里断言「抽取结果 == 真源包的
 * 那个常量」,与 `gate/quickjs-coupling.test.ts` 把冻结副本钉在真源包上同一条纪律。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CONTRACT_TREE_HASH } from "@model-war/schema";
import { expect, it } from "vitest";

import { CONTRACT_DIR, CONTRACT_FILES } from "./contract-package.ts";
import {
  CONTRACT_IDENTITY_SOURCE,
  CONTRACT_TREE_HASH_CONSTANT,
  contractTreeDigest,
  contractTreeFindings,
  pinnedContractTreeHash,
  type ContractTreeEntry,
} from "./contract-tree.ts";

/** 本文件在 `<repo>/packages/tools/src/` 下,上溯三级是仓库根。 */
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const entry = (path: string, text: string): ContractTreeEntry => ({
  path,
  bytes: Buffer.from(text, "utf8"),
});

const entries = [entry("api.md", "API 正文"), entry("README.md", "目录说明")] as const;

it("整树哈希是 64 位小写十六进制", () => {
  expect(contractTreeDigest(entries)).toMatch(/^[0-9a-f]{64}$/);
});

it("对输入顺序不敏感:排序在函数内做", () => {
  const reversed = [...entries].reverse();
  expect(contractTreeDigest(reversed)).toBe(contractTreeDigest(entries));
});

it("不改动入参(排序不就地做)", () => {
  const input = [entry("b.md", "b"), entry("a.md", "a")];
  contractTreeDigest(input);
  expect(input.map((item) => item.path)).toEqual(["b.md", "a.md"]);
});

it("对文件字节的变化敏感:改一个字节就换一串 hex", () => {
  const before = contractTreeDigest(entries);
  const after = contractTreeDigest([entries[0], entry("README.md", "目录说明!")]);
  expect(after).not.toBe(before);
});

it("对路径的变化敏感:字节不变、改名也换 hex", () => {
  const renamed = [entries[0], entry("INDEX.md", "目录说明")];
  expect(contractTreeDigest(renamed)).not.toBe(contractTreeDigest(entries));
});

it("`path` 与字节之间有分隔符:边界处的切分不同即不同的树", () => {
  // 没有 `\0` 时这两对会串接成同一段字节("ab" + "c" == "a" + "bc"),
  // 身份就分不出「两个文件」与「一个名字更长的文件」。
  const split = [entry("a", "bc")];
  const joined = [entry("ab", "c")];
  expect(contractTreeDigest(split)).not.toBe(contractTreeDigest(joined));
});

it("空清单按失败报,不折算成一个合法的空哈希", () => {
  expect(() => contractTreeDigest([])).toThrow(/为空/);
});

it("重复路径按失败报:同一棵树不能有两种字节", () => {
  expect(() => contractTreeDigest([entry("a.md", "1"), entry("a.md", "2")])).toThrow(/重复路径/);
});

// ── 入库常量:抽取这条缝 + 「现算 == 入库」 ──────────────────────────────────

const identitySource = readFileSync(join(repoRoot, CONTRACT_IDENTITY_SOURCE), "utf8");

it("从真源包源码文本抽取出的 pin == 真源包导出的常量", () => {
  // 门禁读不到 dist,只能读源码文本;这里断言那条缝指向的正是 `@model-war/schema` 导出的那一个值。
  expect(pinnedContractTreeHash(identitySource)).toBe(CONTRACT_TREE_HASH);
});

it("抽不出常量时返回 undefined,不猜一个值", () => {
  expect(pinnedContractTreeHash('export const OTHER = "x";')).toBeUndefined();
  expect(
    pinnedContractTreeHash(`export const ${CONTRACT_TREE_HASH_CONSTANT} = "not-hex";`),
  ).toBeUndefined();
});

it("抽不出常量时判据按失败报(不按「无事可查」放过)", () => {
  const findings = contractTreeFindings({ entries, identitySource: "" });
  expect(findings).toHaveLength(1);
  expect(findings[0]?.detail).toContain(CONTRACT_TREE_HASH_CONSTANT);
});

it("现算与入库不一致时报出两串 hex 与处方", () => {
  const findings = contractTreeFindings({
    entries,
    identitySource: `export const ${CONTRACT_TREE_HASH_CONSTANT} =\n  "${"0".repeat(64)}";`,
  });
  expect(findings).toHaveLength(1);
  expect(findings[0]?.where).toBe(CONTRACT_IDENTITY_SOURCE);
  expect(findings[0]?.detail).toContain(contractTreeDigest(entries));
  expect(findings[0]?.detail).toContain("0".repeat(64));
});

it("挂在盘上的四条,现算 == 入库常量", () => {
  // 门禁(`gate:contract`)跑的是同一条判据;这里再钉一次,是因为它红了的意思是
  // 「档案里那串身份已经指不到眼前的字节了」,属于不该只在某一处被发现的事。
  const onDisk = CONTRACT_FILES.map((path) => ({
    path,
    bytes: readFileSync(join(repoRoot, CONTRACT_DIR, path)),
  }));
  expect(contractTreeFindings({ entries: onDisk, identitySource })).toEqual([]);
  expect(contractTreeDigest(onDisk)).toBe(CONTRACT_TREE_HASH);
});
