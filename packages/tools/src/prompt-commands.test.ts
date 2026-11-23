/**
 * 首条消息的命令清单判据(纯函数层)的自测。
 *
 * ── 为什么先测假世界 ──
 *
 * 真世界的反例(往 `SANDBOX_ROOTFS_FILES` 加一项、看门禁红)在 `gates.test.ts` 里,它证明的是
 * 「接线对」;这里证明的是**判据本身**:两个方向、分组、每项一句用途、缺项说明。喂假模板能
 * 把「少一条」「多一条」「放错组」「只点名不说用途」各打一次,而不必真改仓库。
 *
 * ── 断言的形状 ──
 *
 * 只断言「红/绿」与「点名了谁」。断言整句文案会让每次改措辞都动测试,而它守的是集合关系,
 * 不是措辞。
 */

import { expect, it } from "vitest";

import {
  absentToolFindings,
  commandListFindings,
  derivedCommandGroups,
  listedCommands,
} from "./prompt-commands.ts";

/** 两组齐备的假模板:与真模板同形(两个分组标题 + 每项一句用途 + 缺项说明)。 */
const TEMPLATE = [
  "## 沙箱里有什么",
  "",
  "### 静态二进制:通用命令",
  "",
  "- `bash` — 动作块的执行者。",
  "- `sed` — 取行段与就地改。",
  "",
  "### 工具薄壳:经通道交给宿主执行",
  "",
  "- `check` — 检查当前脚本。",
  "",
  "没有 `awk`,也没有 `sleep`:要等一会儿用 `read -t 1 </dev/null`。",
].join("\n");

const DERIVED = { binaries: ["bash", "sed"], shims: ["check"] };

const red = (findings: readonly { where: string; detail: string }[]): string =>
  findings.map((finding) => `${finding.where}:${finding.detail}`).join("\n");

it("分组规则:`bin/` 减薄壳是静态二进制,薄壳单独一组,两组的名字都排序", () => {
  expect(
    derivedCommandGroups(
      ["bin/sed", "bin/zsh", "bin/bash", "bin/check", "contract/api.md"],
      ["done", "check"],
    ),
  ).toEqual({ binaries: ["bash", "sed", "zsh"], shims: ["check", "done"] });
  // 清单里没有 `bin/` 前缀的项不参与(契约文件不是命令)。
  expect(derivedCommandGroups(["contract/api.md"], ["check"])).toEqual({
    binaries: [],
    shims: ["check"],
  });
});

it("解析:只收分组标题下面的清单项,行号指得到,用途原样留下", () => {
  const listed = listedCommands(TEMPLATE);
  expect(listed.map((item) => `${item.group}/${item.name}`)).toEqual([
    "binaries/bash",
    "binaries/sed",
    "shims/check",
  ]);
  expect(listed[1]?.index).toBe(6);
  expect(listed[1]?.purpose).toBe("取行段与就地改。");
  // 分组之外(顶层段落、其余标题下面)的清单项不算:它们不是命令清单的一部分。
  expect(listedCommands("## 别的\n\n- `nope` — 不在组里。")).toEqual([]);
});

it("两组集合相等时绿", () => {
  expect(commandListFindings(TEMPLATE, DERIVED)).toEqual([]);
  expect(absentToolFindings(TEMPLATE)).toEqual([]);
});

it("常量里加了、文案没加:红并点名那个命令", () => {
  const findings = commandListFindings(TEMPLATE, {
    binaries: [...DERIVED.binaries, "__probe"],
    shims: DERIVED.shims,
  });
  expect(findings).toHaveLength(1);
  expect(red(findings)).toContain("__probe");
});

it("文案里写了、常量里没有:红并点名那个命令", () => {
  const findings = commandListFindings(
    TEMPLATE.replace("- `sed` —", "- `python3` — 齐备。\n- `sed` —"),
    DERIVED,
  );
  expect(findings).toHaveLength(1);
  expect(red(findings)).toContain("python3");
});

it("把薄壳整个挪进静态二进制组:两组各报一次(模型会以为它是本地命令)", () => {
  const mixed = TEMPLATE.replace("- `sed` —", "- `check` — 混进来了。\n- `sed` —").replace(
    "- `check` — 检查当前脚本。",
    "",
  );
  const findings = commandListFindings(mixed, DERIVED);
  // 静态二进制组多一个 `check`;薄壳组缺 `check`。
  expect(findings.length).toBe(2);
  expect(red(findings)).toContain("check");
});

it("同一个名字两组都写:多出来的那一组报红(模型看到的是两条命令)", () => {
  const twice = TEMPLATE.replace("- `sed` —", "- `check` — 混进来了。\n- `sed` —");
  const findings = commandListFindings(twice, DERIVED);
  expect(findings).toHaveLength(1);
  expect(red(findings)).toContain("check");
});

it("只点名不说用途:红", () => {
  const findings = commandListFindings(TEMPLATE.replace("— 取行段与就地改。", "—"), DERIVED);
  expect(findings).toHaveLength(1);
  expect(red(findings)).toContain("sed");
});

it("同一个命令写两遍:红", () => {
  const findings = commandListFindings(
    TEMPLATE.replace("- `sed` —", "- `bash` — 又一遍。\n- `sed` —"),
    DERIVED,
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
