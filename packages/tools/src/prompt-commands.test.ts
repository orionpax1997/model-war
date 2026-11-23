/**
 * 首条消息的命令清单判据(纯函数层)的自测。
 *
 * ── 为什么先测假世界 ──
 *
 * 真世界的反例(往 `SANDBOX_ROOTFS_FILES` 加一项、看门禁红)在 `gates.test.ts` 里,它证明的是
 * 「接线对」;这里证明的是**判据本身**:两个方向、分组、每项一句用途、缺项说明。喂假模板能
 * 把「少一条」「多一条」「放错组」「只点名不说用途」各打一次,而不必真改仓库。
 *
 * ── 判据收窄之后本文件只测二进制那一半 ──
 *
 * 宿主工具那一节的判决归 `prompt-tools.test.ts`(`check:prompt-tools`)。本文件仍测**解析**
 * (分组靠两条标题认),因为二进制那一节的边界就是靠它划出来的。
 *
 * ── 断言的形状 ──
 *
 * 只断言「红/绿」与「点名了谁」。断言整句文案会让每次改措辞都动测试,而它守的是集合关系,
 * 不是措辞。
 */

import { expect, it } from "vitest";

import {
  BINARY_GROUP_HEADING,
  HOST_TOOL_GROUP_HEADING,
  absentToolFindings,
  commandListFindings,
  derivedBinaries,
  listedCommands,
} from "./prompt-commands.ts";

/** 两组齐备的假模板:与真模板同形(两个分组标题 + 每项一句用途 + 缺项说明)。 */
const TEMPLATE = [
  "## 沙箱里有什么",
  "",
  BINARY_GROUP_HEADING,
  "",
  "- `bash` — 命令串的执行者。",
  "- `sed` — 取行段与就地改。",
  "",
  HOST_TOOL_GROUP_HEADING,
  "",
  "- `check` — 检查当前脚本。",
  "",
  "没有 `awk`,也没有 `sleep`:要等一会儿用 `read -t 1 </dev/null`。",
].join("\n");

const BINARIES = ["bash", "sed"];

const red = (findings: readonly { where: string; detail: string }[]): string =>
  findings.map((finding) => `${finding.where}:${finding.detail}`).join("\n");

it("分组规则:`bin/` 里每一个都是命令名,`contract/` 那类不是命令", () => {
  expect(derivedBinaries(["bin/sed", "bin/zsh", "bin/bash", "contract/api.md"])).toEqual([
    "bash",
    "sed",
    "zsh",
  ]);
  expect(derivedBinaries(["contract/api.md"])).toEqual([]);
});

it("解析:只收分组标题下面的清单项,行号指得到,用途原样留下", () => {
  const listed = listedCommands(TEMPLATE);
  expect(listed.map((item) => `${item.group}/${item.name}`)).toEqual([
    "binaries/bash",
    "binaries/sed",
    "hostTools/check",
  ]);
  expect(listed[1]?.index).toBe(6);
  expect(listed[1]?.purpose).toBe("取行段与就地改。");
  // 分组之外(顶层段落、其余标题下面)的清单项不算:它们不是命令清单的一部分。
  expect(listedCommands("## 别的\n\n- `nope` — 不在组里。")).toEqual([]);
});

it("分组标题换词:红在标题上,而不是报一堆「沙箱里有而清单没写」", () => {
  // 反例必须落在**二进制**那条标题上:宿主工具那条归 `check:prompt-tools`,
  // 在这里改它只会让二进制那一节被整段抹掉,报的就不是标题那一条了。
  const renamed = TEMPLATE.replace(BINARY_GROUP_HEADING, "### 本地命令");
  const findings = commandListFindings(renamed, BINARIES);
  const text = red(findings);
  expect(text).toContain("分组标题");
  expect(text).toContain(BINARY_GROUP_HEADING);
  // 第一条就是标题那条:标题不对时下面那句「沙箱里有而清单没写」是噪声,指错了地方。
  expect(findings[0]?.detail).toContain("没有那条分组标题");
});

it("两组集合相等时绿", () => {
  expect(commandListFindings(TEMPLATE, BINARIES)).toEqual([]);
  expect(absentToolFindings(TEMPLATE)).toEqual([]);
});

it("常量里加了、文案没加:红并点名那个命令", () => {
  const findings = commandListFindings(TEMPLATE, [...BINARIES, "__probe"]);
  expect(findings).toHaveLength(1);
  expect(red(findings)).toContain("__probe");
});

it("文案里写了、常量里没有:红并点名那个命令", () => {
  const findings = commandListFindings(
    TEMPLATE.replace("- `sed` —", "- `python3` — 齐备。\n- `sed` —"),
    BINARIES,
  );
  expect(findings).toHaveLength(1);
  expect(red(findings)).toContain("python3");
});

it("宿主工具写进二进制那一节:红在「沙箱里没有它」那一侧", () => {
  // 这一条守的是分节的意义:写着 `check` 却放在二进制一节,模型会以为它是本地命令。
  const mixed = TEMPLATE.replace("- `sed` —", "- `check` — 混进来了。\n- `sed` —");
  const findings = commandListFindings(mixed, BINARIES);
  expect(findings).toHaveLength(1);
  expect(red(findings)).toContain("check");
});

it("只点名不说用途:红", () => {
  const findings = commandListFindings(TEMPLATE.replace("— 取行段与就地改。", "—"), BINARIES);
  expect(findings).toHaveLength(1);
  expect(red(findings)).toContain("sed");
});

it("同一个命令写两遍:红", () => {
  const findings = commandListFindings(
    TEMPLATE.replace("- `sed` —", "- `bash` — 又一遍。\n- `sed` —"),
    BINARIES,
  );
  expect(red(findings)).toContain("不止一次");
});

it("缺项说明与替代写法:删掉那句话即红,删掉 `read -t` 也红", () => {
  const withoutSentence = TEMPLATE.split("\n")
    .filter((line) => !line.startsWith("没有 "))
    .join("\n");
  const missing = absentToolFindings(withoutSentence);
  // 一句话同时说清 awk、sleep 与 read -t:删了它,两条各报一次,替代写法那一条也报。
  expect(missing.length).toBe(3);
  expect(red(missing)).toContain("awk");
  expect(red(missing)).toContain("sleep");

  const withoutAlternative = TEMPLATE.replace("`read -t 1 </dev/null`", "别的方式");
  expect(red(absentToolFindings(withoutAlternative))).toContain("read -t");
});
