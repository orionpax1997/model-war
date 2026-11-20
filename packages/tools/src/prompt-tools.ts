/**
 * 首条消息的「宿主工具」一节 + `system` 里点到的工具名,与**工具声明**是不是同一批
 * (根脚本 `check:prompt-tools`)。
 *
 * ── 它守的是什么 ──
 *
 * 模型对「能调用哪些工具」的认知有两个来源,它们必须说同一件事:
 *
 * - **API 层的工具声明**(`packages/gen/src/agent/tools.ts` 的 `AGENT_TOOLS`):模型在请求里真看到
 *   的那一份,决定它**能调**什么;
 * - **首条消息的「宿主工具」一节**(`prompts/agent.md`)与 **`system` 里点的名**
 *   (`prompts/agent-system.md`):决定它**知道该去调**什么。
 *
 * 只改一半的形状有两种,两种都不报错:声明里加了 `probe` 而文案没提,模型不会去用它(能力在,
 * 但它不知道);文案里写了 `evaluate` 而声明里改了名,模型照着调,拿一次 `unknown-tool` 拒绝换
 * 一条纠正。所以判据是**集合相等**,两个方向都判。
 *
 * ── 为什么本文件与 `prompt-commands.ts` 是两条门禁 ──
 *
 * 首条消息的两节各有**不同的真源**:二进制那一节的真源是 `SANDBOX_ROOTFS_FILES`(归
 * `check:prompt-commands`),宿主工具这一节的真源是 `AGENT_TOOLS` 声明(归本门禁)。一个判据对住
 * 一个真源,红的时候才指得准该改哪一边。
 *
 * 两节的分界线**不是硬编码的名单**,而是从两个真源推出来的:声明里与 `bin/` 里某个命令**同名**
 * 的那个工具(`bash`)是沙箱那一侧的——模型通过它敲沙箱里的命令,所以它在二进制一节里点名;
 * 其余的都是宿主工具,在这一节里点名。这条推导让「加一个工具」只有一处需要改(声明),
 * 而「它该写在哪一节」由结构回答。
 *
 * ── 零构建:读源码文本,不 import 真源包 ──
 *
 * 本门禁挂在 `check:quick` 上,而快门禁必须零构建(`@model-war/gen` 与 `@model-war/schema` 的
 * `exports` 都指向 `dist/`,import 就让这条链依赖一次 `tsc -b`,hld §2.2.8、ADR-0003)。
 * 所以工具名与 rootfs 清单都按**源码文本**取(`rootfs-drift.ts` 的 `literalBody` 那一套)。
 * 抽不出来时**按失败处理并说明原因**,不静默放行——那正是「判据失明但门禁全绿」的形态。
 *
 * 这份源码文本读取是**被迫的重复**(第三处,前两处是 `prompts/agent.md` 的模板文本与 schema 的
 * 常量源码):`packages/gen/src/agent/tools.ts` 的头注写着「改常量写法就同步改门禁取法」。
 */

import {
  AGENT_TEMPLATE_PATH,
  HOST_TOOL_GROUP_HEADING,
  type PromptCommandFinding,
  listedCommands,
  purposeFindings,
} from "./prompt-commands.ts";

/**
 * 工具声明的家(仓库相对)。**唯一真源**:五个工具的名字与描述只写在那里。
 *
 * 字面量在本仓是两处(本文件、`tools.ts` 自己的头注里那句话说的是同一件事),理由同
 * `prompt-commands.ts` 的「路径字面量的三份」:零构建下不得 import `@model-war/gen`。
 */
export const AGENT_TOOLS_SOURCE = "packages/gen/src/agent/tools.ts";

/**
 * `system` 模板的仓库相对路径。它原样进 `system` 消息(`agent-prompt.ts` 的
 * `loadAgentSystemTemplate`)。
 *
 * 与 `AGENT_SYSTEM_TEMPLATE_NAME`(`packages/gen/src/agent-prompt.ts`,那份是文件名不是路径)
 * 是同一件事的两处字面量,理由同上。读不到时由入口的空转判据当场红。
 */
export const AGENT_SYSTEM_PATH = "prompts/agent-system.md";

/** `AGENT_TOOLS` 声明里每个工具的开头:`name: "..."`。 */
const DECLARED_NAME = /\bname:\s*"([A-Za-z][A-Za-z0-9-]*)"/gu;

/** `AGENT_TOOLS` 那段数组字面量的两端。抽不到任一端 = 判据失明,入口按失败处理。 */
const ARRAY_START = /export const AGENT_TOOLS = \[/u;
const ARRAY_END = /\] as const;/u;

/** 声明抽出来的结论。抽不出来时带原因返回,调用方按失败处理(不猜、不跳过)。 */
export type DeclaredTools =
  | { readonly ok: true; readonly names: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * 从 `AGENT_TOOLS` 的源码文本里抽**声明的工具名**(顺序即声明顺序)。
 *
 * 先切出那段数组再取 `name:`,不在整个文件里搜——文件头注与类型定义里也会出现 `name: "…"`
 * 这种字样(草稿、示例),整文件搜会把它们当成工具。
 *
 * 抽不出来或抽到空时返回原因:那意味着声明的写法变了(`satisfies`、跨文件拼装、函数生成),
 * 入口必须红并说明「改写法就同步改取法」,而不是把「读到 0 个工具」当成「集合相等」。
 */
export const declaredToolNamesFrom = (source: string): DeclaredTools => {
  const start = ARRAY_START.exec(source);
  if (start === null) {
    return {
      ok: false,
      reason:
        `从 ${AGENT_TOOLS_SOURCE} 的源码文本里找不到 \`export const AGENT_TOOLS = [\`:本门禁零构建、` +
        "只能按这个形状取名字。改过声明的写法就同步改本门禁的取法(`declaredToolNamesFrom`)。",
    };
  }
  const rest = source.slice(start.index + start[0].length);
  const end = ARRAY_END.exec(rest);
  const body = end === null ? rest : rest.slice(0, end.index);
  const names = [...body.matchAll(DECLARED_NAME)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
  if (names.length === 0) {
    return {
      ok: false,
      reason:
        `在 ${AGENT_TOOLS_SOURCE} 的 \`AGENT_TOOLS\` 数组里没取到任何 \`name: "…"\`:` +
        "抽不到名字时「集合相等」会退化成空 == 空,按失败处理。",
    };
  }
  return { ok: true, names };
};

/**
 * `system` 模板里那些**不是工具名**、却必须用反引号括起来的技术词。
 *
 * 判据是「`system` 里每个反引号括起来的单词,要么是声明的工具名,要么在这一条清单里」。
 * 为什么要求逐条登记:一个反引号单词出现在 `system` 里,读者(模型)会把它当**协议里的名字**
 * 读——它要么是一个工具,要么是一件被指名道姓的东西。没有第三条路,所以清单必须是**闭合**的:
 * 新写一个反引号单词而不登记,门禁红一次,由人决定它是工具(去声明里加)还是别的东西(登记理由)。
 * 这与 `gate/landing-gate.ts` 的 `SCRIPT_TOKEN_EXEMPTIONS` 同一条纪律:**豁免要能一句话说清**
 * 「这一类不是工具名」,而不是按文件或按位置豁免。
 */
export type NonToolToken = {
  /** 那个反引号里的单词。 */
  readonly token: string;
  /** 为什么它不是工具名。 */
  readonly reason: string;
};

export const NON_TOOL_TOKENS: readonly NonToolToken[] = [
  {
    token: "command",
    reason: "`bash` 的参数名(`{command}`),是参数不是工具:它的形状由工具声明说,不自成一次调用",
  },
] as const;

/** `system` 里被反引号括起来的**单个小写单词**(含连字符):形状上可能是工具名的那些。 */
const BACKTICKED_WORD = /`([a-z][a-z0-9-]*)`/gu;

/** 从 `system` 模板里取「形状上是工具名」的那些词(去重、排序)。 */
export const mentionedToolWords = (systemTemplate: string): readonly string[] =>
  [
    ...new Set(
      [...systemTemplate.matchAll(BACKTICKED_WORD)].flatMap((match) =>
        match[1] === undefined ? [] : [match[1]],
      ),
    ),
  ].sort();

/**
 * 「宿主工具」一节的判决:标题逐字在场 + 每项一句用途 + 组内唯一 + 集合相等(两个方向)。
 *
 * `sandboxCommands` 是 rootfs `bin/` 里的命令名(调用方从 `SANDBOX_ROOTFS_FILES` 推出)。
 * 它只用来**分界**:声明里与它同名的工具归二进制那一节(那一节由 `check:prompt-commands` 对住),
 * 其余在本节。
 *
 * 空集合不在这里判——它是入口的空转判据。
 */
export const hostToolFindings = (
  template: string,
  declared: readonly string[],
  sandboxCommands: readonly string[],
): readonly PromptCommandFinding[] => {
  const findings: PromptCommandFinding[] = [];
  const listed = listedCommands(template);

  if (!template.split("\n").some((line) => line.trim() === HOST_TOOL_GROUP_HEADING)) {
    findings.push({
      where: AGENT_TEMPLATE_PATH,
      detail:
        `首条消息里没有那条分组标题 \`${HOST_TOOL_GROUP_HEADING}\`(宿主工具组):` +
        "分组靠它逐字认,改了词就等于把这一节从清单里抹掉——这一行保持逐字不变," +
        "措辞放进它下面的清单项里。",
    });
  }

  findings.push(...purposeFindings(listed, "hostTools"));

  const got = listed.filter((item) => item.group === "hostTools");
  const seen = new Set<string>();
  for (const item of got) {
    if (seen.has(item.name)) {
      findings.push({
        where: `${AGENT_TEMPLATE_PATH}:${String(item.index)}`,
        detail: `宿主工具清单里 \`${item.name}\` 出现了不止一次。重复点名会让「一共能调什么」读不清。`,
      });
    }
    seen.add(item.name);
  }

  const sandbox = new Set(sandboxCommands);
  const want = declared.filter((name) => !sandbox.has(name));
  const have = new Set(got.map((item) => item.name));

  for (const name of want) {
    if (!have.has(name)) {
      findings.push({
        where: `${AGENT_TEMPLATE_PATH}:宿主工具`,
        detail:
          `工具声明里有 \`${name}\`,而首条消息的宿主工具一节没有它。` +
          "模型不会去调一个没被点名的工具:能力在声明里,但它不知道,于是一整个工具白给。" +
          `补一行清单项:名字 \`${name}\`、破折号、一句用途。`,
      });
    }
  }
  for (const item of got) {
    if (want.includes(item.name)) continue;
    findings.push({
      where: `${AGENT_TEMPLATE_PATH}:${String(item.index)}`,
      detail: declared.includes(item.name)
        ? `宿主工具一节点名了 \`${item.name}\`,而它由沙箱里的 \`bin/${item.name}\` 提供:` +
          "模型通过它敲沙箱里的命令,所以它的名字归静态二进制那一节,不在这里。"
        : `宿主工具一节点名了 \`${item.name}\`,而工具声明里没有它。模型会照着去调一个不存在的` +
          "工具,拿一次拒绝换一条纠正——要么把它加进 `AGENT_TOOLS`,要么把这行删掉。",
    });
  }

  return findings;
};

/**
 * `system` 模板的判决:它点到的每个反引号单词都得有个着落。
 *
 * 两个方向不同:
 * - **是工具名** ⇒ 必须在声明里(否则 `system` 在教模型调一个不存在的工具);
 * - **不是工具名** ⇒ 必须在 `NON_TOOL_TOKENS` 里,并且每条带理由(见那处注释)。
 *
 * 反方向(声明里有而 `system` 没提)不判:`system` 说协议,不必把五个工具逐个点名——工具列表
 * 的家是工具声明与首条消息的宿主工具一节。
 */
export const systemMentionFindings = (
  systemTemplate: string,
  declared: readonly string[],
): readonly PromptCommandFinding[] => {
  const findings: PromptCommandFinding[] = [];
  for (const token of mentionedToolWords(systemTemplate)) {
    if (declared.includes(token)) continue;
    const exempt = NON_TOOL_TOKENS.find((entry) => entry.token === token);
    if (exempt !== undefined) continue;
    findings.push({
      where: AGENT_SYSTEM_PATH,
      detail:
        `\`system\` 里点了名 \`${token}\`,而它既不在工具声明(${declared.join(" / ")})里,` +
        "也不是登记过的非工具词。模型会把反引号里的词当协议里的名字读:要么它是一个工具" +
        "(那去 `AGENT_TOOLS` 里加),要么它不是(那在 `NON_TOOL_TOKENS` 里登记一句理由)。",
    });
  }
  return findings;
};
