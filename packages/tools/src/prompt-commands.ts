/**
 * 首条消息里的**命令清单**与沙箱里真实存在的东西是不是同一批(根脚本 `check:prompt-commands`)。
 *
 * ── 它守的是什么 ──
 *
 * 模型对「沙箱里有什么」的全部认知来自首条消息那一份散文:它读不到 `packages/schema/src/sandbox-rootfs.ts`,
 * 也敲不出 `ls /bin` 之外的第二个信息源。于是这份散文与 rootfs 常量之间有两种漂,两种都会让模型
 * 拿步数去撞 127:
 *
 * - **常量里加了、散文没加**:模型不知道那个命令存在——它不会去试一个没被点名的东西。上一轮的
 *   `api.md` 中间段读不到就是这个形状:字节在那里,取它的工具不在 `bin/` 里,而散文只说「两条命令」。
 * - **散文里写了、常量里没有**:模型照着散文敲,拿到 `command not found`,然后是纠正、重试、浪费步。
 *
 * 所以判据是**集合相等**,两个方向都判,并且按组判:`bin/` 里是静态二进制,另一组是**宿主工具**
 * (它们不在沙箱里,是模型发起的工具调用)。两组混着写也能让集合相等,但模型会以为 `evaluate`
 * 是本地命令——那不是文案洁癖,它决定模型怎么用那三次额度。
 *
 * ── 宿主工具那一组的两半,本票只接一半 ──
 *
 * 这一组以前从 schema 里那张「哪几个 `bin/` 名字不是二进制」的薄壳表推出来。薄壳与那张表
 * 都已删除(票 03,见 `docs/adr/0029-bash-mini-harness-identity.md`),它的唯一真源现在是
 * `packages/gen/src/agent/tools.ts` 的 `AGENT_TOOLS` 声明,本文件按**源码文本**取名字
 * (零构建:工具包不得 import `@model-war/gen`)。
 *
 * 只判「文案点了名 ⇒ 声明里有它」这**一个**方向:反方向(声明里有而文案没写)要等首条消息
 * 换成「宿主工具」那一节,而那是票 04 的文案工作;它同时新增 `check:prompt-tools` 把两个方向
 * 都判上。在那之前,这里不能要求文案点名 `probe`——声明里有它,而文案还没改。
 *
 * ── 为什么判的是模板文本,不是渲染结果 ──
 *
 * 挂在 `check:quick` 上的门禁必须零构建(hld §2.2.8、ADR-0003):渲染器住在 `@model-war/gen`,
 * import 它就让快门禁依赖一次 `tsc -b`。而模板里的清单是**剧本文本**——渲染只替换
 * `{{contractIndex}}` / `{{contractDigest}}` 两处,不碰这份清单。所以判模板等于判模型看到的那段
 * 文本,不需要跑渲染器。常量侧同样读源码文本(`rootfs-drift.ts` 的取法),理由相同。
 *
 * ── 路径字面量的三份:`prompts/agent.md` 为什么不能合 ──
 *
 * 这条路径在本仓有三处字面量:`AGENT_TEMPLATE_PATH`(本文件)、`AGENT_TEMPLATE_NAME`
 * (`packages/gen/src/agent-prompt.ts`,渲染器的读盘点)、`AGENT_TEMPLATE_FILE`
 * (`gates.test.ts`,反例探针要改那份真实模板)。**它是被迫重复,不是第二份真源**:
 * 零构建纪律下工具包不能 import `@model-war/gen`(hld §2.2.8、ADR-0003),而渲染器住在那里;
 * 反过来 gen 也不该为了一条路径去 import 一个门禁包。与 `SCHEMA_CONSTANTS_SOURCE` 同类——
 * 那份 schema 源码路径也不得不由门禁自己写一遍。
 *
 * 重复的代价被**读盘即错**抵住:三处任一写错,读的是不存在的文件,而空转判据当场红
 * (`run-prompt-commands-gate.ts` 的 `vacuousReason`:模板读到空就报「首条消息模板的正文」)。
 * 所以它是 **fail-closed 的重复**——漂了不会静默放过。
 *
 * ── 落选方案:占位符渲染 ──
 *
 * 让 `prompts/agent.md` 里带一个 `{{sandboxCommands}}`,渲染时从常量生成清单,散文就不可能漂。
 * 落选的理由是**门禁会退化成拿自己与自己比**:生成清单的是 `@model-war/gen`,判清单的是快门禁,
 * 而快门禁不能 import 它,于是判据只能把生成逻辑抄一份——那正是本仓最不想要的第二个家。
 * 静态散文 + 集合相等的门禁把「谁是真源」留在一处(常量),把「文案是否跟上了」交给一条会红的判据。
 */

import { staticBinariesOf } from "./sandbox-rootfs/rootfs-drift.ts";

/**
 * 模板的仓库相对路径。它是首条 `user` 消息的剧本(`agent-prompt.ts` 的 `loadAgentTemplate`)。
 *
 * 字面量在本仓有三份(本文件 / `agent-prompt.ts` / `gates.test.ts`),理由与「读不到即红」的
 * 兜底见文件头注「路径字面量的三份」。
 */
export const AGENT_TEMPLATE_PATH = "prompts/agent.md";

/** 静态二进制那一组的标题行。模板里必须**逐字**出现它:分组靠这一行认,换了词就是另一组。 */
export const BINARY_GROUP_HEADING = "### 静态二进制:通用命令";

/**
 * 第二组(宿主工具)的标题行。同上,逐字。
 *
 * ⚠️ 它的**名字与内容此刻都是旧的**:文案还是「工具薄壳:经通道交给宿主执行」,而引擎里既没有
 * 薄壳也没有通道。票 04 会把这一节的标题与清单一起改成「宿主工具」,那时这个常量跟着改名
 * (`HOST_TOOL_GROUP_HEADING`)。本票不动它,是因为**文案是票 04 的**,而门禁必须与文案说同一
 * 件事——改一半会让 `check:prompt-commands` 当场红。
 */
export const SHIM_GROUP_HEADING = "### 工具薄壳:经通道交给宿主执行,不是二进制";

/** 一条违规。`where` 指到文件或那个命令名,报告里直接读得懂。 */
export type PromptCommandFinding = {
  readonly where: string;
  readonly detail: string;
};

/** 两组名字:`binaries` 是沙箱里敲得到的静态 ELF,`hostTools` 是模型调用的宿主工具。 */
export type CommandGroups = {
  readonly binaries: readonly string[];
  readonly hostTools: readonly string[];
};

/** `bin/<名字>` → `<名字>`。清单项、报告与门禁说的都是名字,不是路径。 */
const commandNameOf = (path: string): string => path.slice("bin/".length);

/**
 * 推出两组名字。
 *
 * 静态二进制那一组:`SANDBOX_ROOTFS_FILES` 里 `bin/` 开头的**全部**。这条规则的家**不在这里**:
 * 它住在 `sandbox-rootfs/rootfs-drift.ts` 的 `staticBinariesOf`——rootfs 漂移判据(「哪几份必须
 * 是静态 ELF」)与本判据问的是同一件事,同包、零构建,所以直接复用,不另写一份「哪些是二进制」。
 *
 * 宿主工具那一组:调用方给(门禁从 `AGENT_TOOLS` 的源码文本里取,理由见文件头注)。这里只做
 * 两件本判据自己的事:把路径换成名字、去重排序(清单里一个名字只该出现一次)。
 */
export const derivedCommandGroups = (
  files: readonly string[],
  hostTools: readonly string[],
): CommandGroups => ({
  binaries: staticBinariesOf(files).map(commandNameOf),
  hostTools: [...new Set(hostTools)].sort(),
});

/** 工具声明的源码文本(相对仓库根)。零构建下这是取工具名的唯一途径。 */
export const AGENT_TOOLS_SOURCE = "packages/gen/src/agent/tools.ts";

/**
 * 从 `AGENT_TOOLS` 的源码文本里取名字。
 *
 * 取法与 `rootfs-drift.ts` 读 schema 常量同源:先切出 `AGENT_TOOLS = [...]` 那一段,再取段内的
 * `name: "..."`。**切整段**而不是全文件搜,是因为文件里别处也会出现 `name: "xxx"` 这种字样
 * (头注就在讲这条取法本身)。
 *
 * 抽不出来时返回空数组,由入口按空转判红(`run-prompt-commands-gate.ts` 的 `vacuousReason`)——
 * 抽不出来即静默放行,正是这套判据最容易漏的形状。宿主工具那一组要减掉 `bash`:它是沙箱里
 * 敲的,归静态二进制那一组。
 */
export const hostToolNamesFrom = (source: string): readonly string[] => {
  const array = /export const AGENT_TOOLS = \[([\s\S]*?)\] as const;/u.exec(source);
  const body = array?.[1];
  if (body === undefined) return [];
  return [...body.matchAll(/\bname: "([A-Za-z][A-Za-z0-9-]*)"/gu)]
    .flatMap((match) => (match[1] === undefined ? [] : [match[1]]))
    .filter((name) => name !== "bash");
};

/** 清单里的一行:`- \`名字\` — 用途`。`index` 是它在模板里的行号(1 起),报错时指得到。 */
export type ListedCommand = {
  readonly name: string;
  readonly purpose: string;
  readonly group: "binaries" | "hostTools";
  readonly index: number;
};

/** 标题行(`##` 到 `######`)。 */
const HEADING = /^#{2,6}\s/u;

/**
 * 分组标题的判据:**逐字**等于某条分组标题,其余标题结束分组。
 *
 * 早先的判据是「标题里含『静态』/『薄壳』」,那是一条按词猜组的规则:模板把标题改成
 * 「本地命令」或「宿主工具」,清单就被静默归错组(甚至整组不算),而门禁会把它报成
 * 「沙箱里有而清单没写」——诊断指错了地方。所以判据换成常量与模板共享的两条字面量:
 * 模板写什么,这里就认什么;模板换了词,`commandListFindings` 的第一条判据当场红。
 */
const groupOfHeading = (line: string): "binaries" | "hostTools" | undefined => {
  const heading = line.trim();
  if (heading === SHIM_GROUP_HEADING) return "hostTools";
  if (heading === BINARY_GROUP_HEADING) return "binaries";
  return undefined;
};

/**
 * 一行清单项。名字只取**第一对反引号**里的第一段(`sed -i 's/a/b/'` 这种用法写在用途里)。
 *
 * 分隔符认三种破折号,因为排版会被人顺手统一;用途没写成的行由 `commandListFindings` 报。
 */
const LISTED_COMMAND = /^\s*-\s+`([^`]+)`\s*[—–-]+\s*(\S.*)$/u;

/** 模板里被点名、且在某个命令分组下面的那些行。 */
export const listedCommands = (template: string): readonly ListedCommand[] => {
  const listed: ListedCommand[] = [];
  let group: "binaries" | "hostTools" | undefined;
  template.split("\n").forEach((line, offset) => {
    if (HEADING.test(line)) {
      group = groupOfHeading(line);
      return;
    }
    if (group === undefined) return;
    const match = LISTED_COMMAND.exec(line);
    if (match === null) return;
    const name = (match[1] ?? "").trim();
    const purpose = (match[2] ?? "").trim();
    if (name === "") return;
    listed.push({ name, purpose, group, index: offset + 1 });
  });
  return listed;
};

/** 单行用途的判据。两个字以下等于没说:「`wc` — 计数」也够,「`wc` —」不够。 */
const MIN_PURPOSE_CHARS = 2;

/**
 * 集合关系 + 组内唯一 + 每项一句用途 + 两条分组标题逐字在场。
 *
 * 两个方向不是对称的,理由见文件头注「宿主工具那一组的两半」:
 * - 静态二进制那一组**两个方向都判**(多一条、少一条都红);
 * - 宿主工具那一组只判「文案点了名 ⇒ 声明里有它」。反方向要等票 04 改写文案,否则声明的
 *   `probe` 会让这条门禁当场红在一个**还没轮到改**的文件上。
 *
 * 空集合不在这里判——它是入口的空转判据。
 */
export const commandListFindings = (
  template: string,
  derived: CommandGroups,
): readonly PromptCommandFinding[] => {
  const listed = listedCommands(template);
  const findings: PromptCommandFinding[] = [];

  // 两条分组标题先判:标题缺席时下面那堆「沙箱里有而清单没写」全是噪声,
  // 真正该改的是那一行标题(或者它被挪走了)。
  const headings = [
    [BINARY_GROUP_HEADING, "静态二进制"],
    [SHIM_GROUP_HEADING, "工具薄壳"],
  ] as const;
  for (const [heading, groupName] of headings) {
    if (!template.split("\n").some((line) => line.trim() === heading)) {
      findings.push({
        where: AGENT_TEMPLATE_PATH,
        detail:
          `首条消息里没有那条分组标题 \`${heading}\`(${groupName}组):分组靠它逐字认,` +
          "改了词就等于把整组从清单里抹掉——这一行保持逐字不变,措辞放进它下面的清单项里。",
      });
    }
  }

  for (const item of listed) {
    if (item.purpose.length < MIN_PURPOSE_CHARS) {
      findings.push({
        where: `${AGENT_TEMPLATE_PATH}:${String(item.index)}`,
        detail:
          `命令清单里的 \`${item.name}\` 没写用途。模型读到的是名字,不是用法:` +
          "「有这个命令」与「拿它干什么」两件事都得说,否则它还是得靠试。",
      });
    }
  }

  for (const group of ["binaries", "hostTools"] as const) {
    const want = derived[group];
    const got = listed.filter((item) => item.group === group);
    const seen = new Set<string>();
    for (const item of got) {
      if (seen.has(item.name)) {
        findings.push({
          where: `${AGENT_TEMPLATE_PATH}:${String(item.index)}`,
          detail: `命令清单里 \`${item.name}\` 出现了不止一次。重复点名会让「一共有什么」读不清。`,
        });
      }
      seen.add(item.name);
    }
    const have = new Set(got.map((item) => item.name));
    const wantSet = new Set(want);
    const groupName = group === "binaries" ? "静态二进制" : "宿主工具";

    // 「声明里有、文案没写」只对静态二进制组判:宿主工具那一组的反方向归票 04 的
    // `check:prompt-tools`(它与改写后的文案一起落地)。
    for (const name of group === "binaries" ? want : []) {
      if (!have.has(name)) {
        findings.push({
          where: `${AGENT_TEMPLATE_PATH}:${groupName}`,
          detail:
            `沙箱里有 \`${name}\`(它由 rootfs 常量推出,属于${groupName}组),而首条消息的命令清单没有它。` +
            "模型不会去试一个没被点名的命令:能力在 `bin/` 里,但它不知道,于是拿步数去撞 127。" +
            `补一行清单项:名字 \`${name}\`、破折号、一句用途。`,
        });
      }
    }
    for (const name of got) {
      if (!wantSet.has(name.name)) {
        findings.push({
          where: `${AGENT_TEMPLATE_PATH}:${String(name.index)}`,
          detail:
            group === "binaries"
              ? `命令清单点名了 \`${name.name}\`,而 rootfs 常量里没有它。模型照这条敲会拿到 ` +
                "`command not found`——要么把它加进 `SANDBOX_ROOTFS_FILES` 并重跑 " +
                "`sandbox:rootfs:build`,要么把这行删掉。"
              : `命令清单点名了 \`${name.name}\`,而工具声明里没有它。模型会照着去调一个不存在的` +
                "工具,拿一次拒绝换一条纠正——要么把它加进 `AGENT_TOOLS`,要么把这行删掉。",
        });
      }
    }
  }

  return findings;
};

/**
 * 第二类判据:**清单旁边要说清没有哪几件,以及等价写法**。
 *
 * `awk` / `sleep` 是被裁掉的两件(理由见票与 ADR),而它们恰恰是模型最常用的两件:`sleep` 不写出来,
 * 模型就会写它,然后拿 127 换一条纠正;`awk` 不写出来,模型会把「读不到中间段」归因成文件坏了。
 * 所以判据不是「散文提过这两个词」,而是「模板里有一句说它们**没有**,并且给出了替代写法」。
 */
export const absentToolFindings = (template: string): readonly PromptCommandFinding[] => {
  const lines = template.split("\n");
  const findings: PromptCommandFinding[] = [];
  for (const name of ["awk", "sleep"]) {
    const said = lines.some(
      (line) => line.includes(name) && /没有|不存在|not available/u.test(line),
    );
    if (!said) {
      findings.push({
        where: AGENT_TEMPLATE_PATH,
        detail:
          `首条消息没有说清 \`${name}\` 不存在。它是模型最会顺手写的命令之一:不说,` +
          "模型就会写它、拿一次 `command not found`,再花一步改正。",
      });
    }
  }
  if (!template.includes("read -t")) {
    findings.push({
      where: AGENT_TEMPLATE_PATH,
      detail:
        "首条消息没有给出 `sleep` 的等价写法(`read -t 1 </dev/null`)。只说「没有 sleep」" +
        "等于把一条必败的指令留下,模型仍然会去等一会儿——而沙箱里没有别的时间工具。",
    });
  }
  return findings;
};
