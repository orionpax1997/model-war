/**
 * 门禁:首条消息的「宿主工具」一节 + `system` 里点的名 == 工具声明,且 `probe` 那一项的场数
 * == `PROBE_MATCH_LIMIT`(根脚本 `check:prompt-tools`)。
 *
 * 用法:`node packages/tools/src/gate/run-prompt-tools-gate.ts`
 *
 * ── 两侧各读什么、为什么这么读 ──
 *
 * - **声明侧**:`packages/gen/src/agent/tools.ts` 的**源码文本**(`AGENT_TOOLS` 里逐个
 *   `name: "…"`)。不 import `@model-war/gen`:它的 `exports` 指向 `dist/`,import 就让这条快门禁
 *   依赖一次 `tsc -b`(hld §2.2.8、ADR-0003)。
 * - **文案侧**:`prompts/agent.md`(宿主工具那一节)与 `prompts/agent-system.md`(点了哪些工具名)
 *   的**模板文本**。渲染器只替换两个占位符、不碰这两段,判模板等于判模型真的读到的那段。
 * - **常量侧**:`packages/schema/src/probe-limits.ts` 的 `PROBE_MATCH_LIMIT`。工具声明里的
 *   "前 N 场"是**从它派生**的模板字符串(gen 侧 import 得动),而 `prompts/agent.md` 那一句是
 *   手写散文——两份手写的同一个数就是这份门禁现在盯的那个漂:上面那条集合判据只比 `name:`,
 *   散文里写死"前 8 场"时改常量不会有任何东西变红。
 * - **分界**:`packages/schema/src/sandbox-rootfs.ts` 的 `SANDBOX_ROOTFS_FILES` 里 `bin/` 的名字,
 *   用来把声明里「与沙箱命令同名」的那个工具(`bash`)留给二进制那一节
 *   (`check:prompt-commands` 判它)。这条分界是**从两个真源推的**,不是手写名单。
 *
 * 判据本身在 `prompt-tools.ts`(纯函数,可用假世界喂)。这里只做读盘、空转检测与退出码。
 *
 * ── 为什么它在 `check:quick` 上 ──
 *
 * 与 `check:prompt-commands` 同一个理由:一个构建、一次网络、一个内核能力都不需要,读四份文本比
 * 三个集合加一个数。它守的是「加了一个工具而文案没跟上」「文案在教模型调一个不存在的工具」
 * 与「模型读到的场数与它能调的探针不一致」——前者让一整个工具白给,中间那个让模型每一步都拿
 * 一次 `unknown-tool` 拒绝,最后那个让模型误判自己的覆盖面。日常入口是 `verify:fast`,
 * 抓不到等于没有。
 *
 * 退出码:0 = 四个真源互相说同一件事;1 = 任一处违规,或门禁自己失效(抽不出声明 / 抽不出
 * 场数 / 读到空)。
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  AGENT_TEMPLATE_PATH,
  derivedBinaries,
  type PromptCommandFinding,
} from "../prompt-commands.ts";
import {
  AGENT_SYSTEM_PATH,
  AGENT_TOOLS_SOURCE,
  PROBE_LIMITS_SOURCE,
  declaredToolNamesFrom,
  hostToolFindings,
  probeCountFindings,
  probeMatchLimitFrom,
  systemMentionFindings,
} from "../prompt-tools.ts";
import {
  SCHEMA_CONSTANTS_SOURCE,
  sandboxRootfsConstantsFrom,
} from "../sandbox-rootfs/rootfs-drift.ts";
import { vacuousReason } from "./vacuous.ts";

/** 本文件在 `<repo>/packages/tools/src/gate/` 下,上溯四层是仓库根。 */
const repoRoot = resolve(import.meta.dirname, "../../../..");

/** 读一份仓库内的文本;读不到返回空串,由空转判据报出来(不在读盘处抛,报告形态统一)。 */
const read = (relative: string): string =>
  existsSync(resolve(repoRoot, relative)) ? readFileSync(resolve(repoRoot, relative), "utf8") : "";

const main = (): number => {
  const template = read(AGENT_TEMPLATE_PATH);
  const systemTemplate = read(AGENT_SYSTEM_PATH);

  const declared = declaredToolNamesFrom(read(AGENT_TOOLS_SOURCE));
  if (!declared.ok) {
    process.stderr.write(`工具清单门禁:${declared.reason}\n`);
    return 1;
  }

  const parsed = sandboxRootfsConstantsFrom(read(SCHEMA_CONSTANTS_SOURCE));
  if (!parsed.ok) {
    process.stderr.write(`工具清单门禁:${parsed.reason}\n`);
    return 1;
  }
  const sandboxCommands = derivedBinaries(parsed.constants.files);

  const probeLimit = probeMatchLimitFrom(read(PROBE_LIMITS_SOURCE));
  if (!probeLimit.ok) {
    process.stderr.write(`工具清单门禁:${probeLimit.reason}\n`);
    return 1;
  }

  // 空转:任一侧读到空,「集合相等」就退化成空 == 空——那是一条什么都没断言的绿。
  const vacuous = [
    vacuousReason(template.trim().length, {
      subject: "首条消息模板的正文",
      scope: AGENT_TEMPLATE_PATH,
    }),
    vacuousReason(systemTemplate.trim().length, {
      subject: "`system` 模板的正文",
      scope: AGENT_SYSTEM_PATH,
    }),
    vacuousReason(sandboxCommands.length, {
      subject: "rootfs 常量推出的命令",
      scope: SCHEMA_CONSTANTS_SOURCE,
    }),
  ].filter((reason) => reason !== "");
  if (vacuous.length > 0) {
    process.stderr.write(`工具清单门禁:${vacuous.join("")}\n`);
    return 1;
  }

  const findings: readonly PromptCommandFinding[] = [
    ...hostToolFindings(template, declared.names, sandboxCommands),
    ...systemMentionFindings(systemTemplate, declared.names),
    ...probeCountFindings(template, probeLimit.limit),
  ];

  for (const finding of findings) {
    process.stderr.write(`✗ ${finding.where}:${finding.detail}\n`);
  }

  const hostTools = declared.names.filter((name) => !sandboxCommands.includes(name));
  const scale =
    `声明的工具 ${String(declared.names.length)} 个(${declared.names.join(" / ")}),` +
    `其中宿主工具 ${String(hostTools.length)} 个(` +
    (hostTools.length === 0 ? "空" : hostTools.join(" / ")) +
    `),其余归静态二进制那一节;探针场数常量是 ${String(probeLimit.limit)}`;
  process.stdout.write(
    findings.length === 0
      ? `✓ 工具清单门禁:${scale};首条消息的宿主工具一节与声明逐项相等,` +
          "`system` 里点的每个名字都有着落。\n工具清单门禁:绿(模型看到的就是能调的)\n"
      : `工具清单门禁:红(${String(findings.length)} 处)。${scale}。` +
          "声明与文案必须说同一件事——模型只能看见声明,却照着文案行动。\n",
  );
  return findings.length === 0 ? 0 : 1;
};

process.exitCode = main();
