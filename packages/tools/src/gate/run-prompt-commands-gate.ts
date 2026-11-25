/**
 * 门禁:首条消息里的命令清单 == 沙箱里真实存在的东西(根脚本 `gate:prompt:commands`)。
 *
 * 用法:`node packages/tools/src/gate/run-prompt-commands-gate.ts`
 *
 * ── 两侧各读什么、为什么这么读 ──
 *
 * - **常量侧**:`packages/schema/src/sandbox-rootfs.ts` 的**源码文本**——取法与
 *   `gate:rootfs` 同一份(`rootfs-drift.ts` 的 `sandboxRootfsConstantsFrom`)。
 *   不 import 真源包:它的 `exports` 指向 `dist/`,import 就让这条快门禁依赖一次 `tsc -b`。
 * - **文案侧**:`prompts/agent.md` 的**模板文本**。渲染器只替换 `{{contractIndex}}` /
 *   `{{contractDigest}}` 两处,不碰命令清单——判模板等于判模型真的读到的那段。渲染器住在
 *   `@model-war/gen`,同样 import 不得(零构建)。
 *
 * 判据本身在 `prompt-commands.ts`(纯函数,可用假世界喂)。这里只做读盘、空转检测与退出码。
 *
 * **只判二进制那一节**:宿主工具那一节的真源是工具声明,归 `gate:prompt:tools`
 * (`run-prompt-tools-gate.ts`)。一条门禁对住一个真源,红的时候才指得准改哪一边。
 *
 * ── 为什么它在 `quick` 上 ──
 *
 * 一个构建、一次网络、一个内核能力都不需要:读两份文本,比两个集合。它守的是「加了一个二进制
 * 而文案没跟上」——那件事没有别的东西会红(rootfs 漂移门禁只证明字节,不证明模型知情),
 * 而它的代价是模型拿步数去撞 127。日常入口是 `verify`,抓不到等于没有。
 *
 * 退出码:0 = 集合相等且缺项说明在场;1 = 任一处违规,或门禁自己失效(空转)。
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  AGENT_TEMPLATE_PATH,
  absentToolFindings,
  commandListFindings,
  derivedBinaries,
  listedCommands,
  type PromptCommandFinding,
} from "../prompt-commands.ts";
import {
  SCHEMA_CONSTANTS_SOURCE,
  sandboxRootfsConstantsFrom,
} from "../sandbox-rootfs/rootfs-drift.ts";
import { vacuousReason } from "./vacuous.ts";

/** 本文件在 `<repo>/packages/tools/src/gate/` 下,上溯四层是仓库根。 */
const repoRoot = resolve(import.meta.dirname, "../../../..");

const main = (): number => {
  const template = existsSync(resolve(repoRoot, AGENT_TEMPLATE_PATH))
    ? readFileSync(resolve(repoRoot, AGENT_TEMPLATE_PATH), "utf8")
    : "";
  const parsed = sandboxRootfsConstantsFrom(
    readFileSync(resolve(repoRoot, SCHEMA_CONSTANTS_SOURCE), "utf8"),
  );
  if (!parsed.ok) {
    process.stderr.write(`命令清单门禁:${parsed.reason}\n`);
    return 1;
  }

  const binaries = derivedBinaries(parsed.constants.files);
  // 空转只判「模板里解析得出命令清单吗」:两节都算。若只数二进制那一节,标题一换词
  // 就会先掉进空转分支,报的是「读到 0 条命令」——而真正该改的是那一行标题(诊断指错地方)。
  const listed = listedCommands(template);

  // 空转:两侧任一侧读到空,集合相等就变成「空 == 空」——那是一条什么都没断言的绿。
  const vacuous = [
    vacuousReason(template.trim().length, {
      subject: "首条消息模板的正文",
      scope: AGENT_TEMPLATE_PATH,
    }),
    vacuousReason(binaries.length, {
      subject: "rootfs 常量推出的命令",
      scope: SCHEMA_CONSTANTS_SOURCE,
    }),
    vacuousReason(listed.length, {
      subject: "首条消息里点名的命令",
      scope: AGENT_TEMPLATE_PATH,
    }),
  ].filter((reason) => reason !== "");
  if (vacuous.length > 0) {
    process.stderr.write(`命令清单门禁:${vacuous.join("")}\n`);
    return 1;
  }

  const findings: readonly PromptCommandFinding[] = [
    ...commandListFindings(template, binaries),
    ...absentToolFindings(template),
  ];

  for (const finding of findings) {
    process.stderr.write(`✗ ${finding.where}:${finding.detail}\n`);
  }
  const scale = `静态二进制 ${String(binaries.length)} 条(${binaries.join(" / ")})`;
  process.stdout.write(
    findings.length === 0
      ? `✓ 命令清单门禁:${scale}——首条消息里的静态二进制清单与 rootfs 常量逐项相等,` +
          "缺项(awk / sleep)与替代写法都在。宿主工具那一节归 `gate:prompt:tools`。\n" +
          "命令清单门禁:绿(模型看到的就是沙箱里有的)\n"
      : `命令清单门禁:红(${String(findings.length)} 处)。${scale}。` +
          "改文案或改常量,两者必须说同一件事——模型只知道文案那一份。\n",
  );
  return findings.length === 0 ? 0 : 1;
};

process.exitCode = main();
