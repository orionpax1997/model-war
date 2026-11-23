/**
 * 契约包那三条散文判据与骨架抽取的自测。
 *
 * ── 为什么这些用例必须包含「正向对照」 ──
 *
 * 三条判据都是「找出违规」。一条判据只要写宽一点,它就永远不会红,而**永远绿的判据与没有判据
 * 是同一种东西**。所以每个判据都配一份两面的用例:造一处违规(必须报)、拿仓库里真实的那份
 * (必须不报)。后者是这份自测里最要紧的一条:它同时证明「判据不是恒红」。
 *
 * ── 抽取那几条为什么要造字符串而不是读真文件 ──
 *
 * 真文件只有一种形态(§6 现在是好的)。抽取器的失败路径——小节标题被改写、骨架被移走、
 * §6 里又贴了一段完整脚本、围栏没闭合——在真文件上全走不到。而这几条正是它存在的理由:
 * 抽取失败必须报错,**不能**悄悄产出一份空文件或另一段的块,那会被模型 `cp` 走。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import {
  CONTRACT_DIR,
  CONTRACT_FILES,
  CONTRACT_INDEX_PATH,
  directoryFindings,
  indexCoverageFindings,
  mentionedMountPaths,
  writableWorldFindings,
} from "./contract-package.ts";
import { skeletonFromApiDoc } from "./generate/minimal-skeleton.ts";

/** 本文件在 `<repo>/packages/tools/src/` 下,上溯三级是仓库根。 */
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const read = (relative: string): string => readFileSync(`${repoRoot}${relative}`, "utf8");

/** 契约目录下递归收出来的文件,路径相对 `CONTRACT_DIR`。与门禁入口里那份读法一致。 */
const actualContractFiles = (): readonly string[] => {
  const found: string[] = [];
  const visit = (relative: string): void => {
    const absolute = join(repoRoot, CONTRACT_DIR, relative);
    if (!existsSync(absolute)) {
      return;
    }
    if (statSync(absolute).isDirectory()) {
      for (const entry of readdirSync(absolute)) {
        visit(relative === "" ? entry : `${relative}/${entry}`);
      }
      return;
    }
    found.push(relative);
  };
  visit("");
  return found;
};

/** 一份最小可用的假 API 文档:`§6` + 一个含入口声明的 ts 块。 */
const apiDoc = (sectionBody: string): string =>
  [
    "# 假契约",
    "",
    "## 5. 上一节",
    "",
    "```ts",
    "const unrelated = 1;",
    "```",
    "",
    "## 6. 骨架",
    "",
    sectionBody,
    "",
    "## 7. 下一节",
    "",
  ].join("\n");

const runnableBlock = "```ts\nfunction loop() {\n  return;\n}\n```";

it("抽取:§6 里恰好一个含入口声明的 ts 块时,取它的正文并补一个换行", () => {
  expect(skeletonFromApiDoc(apiDoc(runnableBlock))).toBe("function loop() {\n  return;\n}\n");
});

it("抽取:只取 §6 那一段,不把相邻小节的块算进来", () => {
  // 上一节里也有一个 ts 块,但它不含入口声明;把它算进来就是「抽错的那一份被模型 cp 走」。
  expect(skeletonFromApiDoc(apiDoc(runnableBlock))).toContain("function loop");
  expect(skeletonFromApiDoc(apiDoc(runnableBlock))).not.toContain("const unrelated");
});

it("抽取:小节编号被改写时报错,不猜「大概是后一节」", () => {
  // 定位锚是**编号**不是标题文字:标题措辞可以改(「最小 `loop()` 骨架」换一种写法仍然对),
  // 编号被改成「六、」或去掉,抽取器就找不到它——此时报错而不是去猜下一节。
  const renumbered = apiDoc(runnableBlock).replace("## 6. 骨架", "## 六、骨架");
  expect(() => skeletonFromApiDoc(renumbered)).toThrow(/找不到 §6 的小节标题/);
});

it("抽取:标题措辞改了但编号还在时照旧抽得到(锁的是编号,不是措辞)", () => {
  const reworded = apiDoc(runnableBlock).replace("## 6. 骨架", "## 6. 一份能跑的最小骨架");
  expect(skeletonFromApiDoc(reworded)).toContain("function loop");
});

it("抽取:§6 里一个可运行块都没有时报错(不许产出空文件)", () => {
  expect(() => skeletonFromApiDoc(apiDoc("这一节暂时是空的。"))).toThrow(/一个都没有/);
});

it("抽取:§6 里有两个可运行块时报错,不替人在两块之间挑一块", () => {
  const two = apiDoc(`${runnableBlock}\n\n再贴一段:\n\n${runnableBlock}`);
  expect(() => skeletonFromApiDoc(two)).toThrow(/2 个/);
});

it("抽取:围栏没闭合时报错,半段正文不能当骨架用", () => {
  expect(() => skeletonFromApiDoc(apiDoc("```ts\nfunction loop() {\n"))).toThrow(/没闭合的围栏块/);
});

it("判据一:目录说明点名的挂载路径里,句末标点不会被当成路径的一部分", () => {
  expect([
    ...mentionedMountPaths("先读 `/contract/api.md`。再读 `/contract/rules.md`,最后看骨架。"),
  ]).toEqual(["api.md", "rules.md"]);
});

it("判据一:四条少写一条时报出来(只判「提到的都存在」会放过它)", () => {
  const findings = indexCoverageFindings(
    "`/contract/README.md` 与 `/contract/rules.md` 与 `/contract/api.md`",
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]?.detail).toContain("/contract/examples/minimal.ts");
});

it("判据一:点名了清单外的路径时报出来", () => {
  const readme = CONTRACT_FILES.map((file) => `\`/contract/${file}\``).join(" 与 ");
  const findings = indexCoverageFindings(`${readme} 还有 \`/contract/notes.md\``);
  expect(findings).toHaveLength(1);
  expect(findings[0]?.where).toBe("/contract/notes.md");
});

it("判据二:目录说明里出现可写面时报出来", () => {
  expect(writableWorldFindings("把骨架复制到 `/workspace` 再改。")).not.toHaveLength(0);
  expect(writableWorldFindings("骨架是只读的,照抄即可。")).toHaveLength(0);
});

it("判据三:清单里的文件缺失、以及目录里多出清单外的文件,两个方向都报", () => {
  const missing = directoryFindings(["README.md", "rules.md", "api.md"]);
  expect(missing).toHaveLength(1);
  expect(missing[0]?.where).toBe("docs/rules-v2/examples/minimal.ts");

  const extra = directoryFindings([...CONTRACT_FILES, "notes.md"]);
  expect(extra).toHaveLength(1);
  expect(extra[0]?.where).toBe("docs/rules-v2/notes.md");

  expect(directoryFindings(CONTRACT_FILES)).toHaveLength(0);
});

it("正向对照:仓库里那份目录说明与那份目录,三条判据全部通过", () => {
  const readme = read(CONTRACT_INDEX_PATH);
  // 一份真实存在的目录说明:如果它对这三条全红,那么判据不是在挑漂移,是在收罚正常改写。
  expect(indexCoverageFindings(readme)).toHaveLength(0);
  expect(writableWorldFindings(readme)).toHaveLength(0);
  // 目录那一侧拿真实读盘的结果判,不是拿清单自己判自己——后者是一句恒真的断言。
  expect(directoryFindings(actualContractFiles())).toHaveLength(0);
});
