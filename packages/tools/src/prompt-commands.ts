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
 * 所以判据是**集合相等**,两个方向都判,并且按组判:`bin/` 里除薄壳之外是静态二进制,薄壳是
 * 经通道交给宿主执行的三件工具。两组混着写也能让集合相等,但模型会以为 `evaluate` 是本地命令
 * ——那不是文案洁癖,它决定模型怎么用那三次额度。
 *
 * ── 为什么判的是模板文本,不是渲染结果 ──
 *
 * 挂在 `check:quick` 上的门禁必须零构建(hld §2.2.8、ADR-0003):渲染器住在 `@model-war/gen`,
 * import 它就让快门禁依赖一次 `tsc -b`。而模板里的清单是**剧本文本**——渲染只替换
 * `{{contractIndex}}` / `{{contractDigest}}` 两处,不碰这份清单。所以判模板等于判模型看到的那段
 * 文本,不需要跑渲染器。常量侧同样读源码文本(`rootfs-drift.ts` 的取法),理由相同。
 *
 * ── 落选方案:占位符渲染 ──
 *
 * 让 `prompts/agent.md` 里带一个 `{{sandboxCommands}}`,渲染时从常量生成清单,散文就不可能漂。
 * 落选的理由是**门禁会退化成拿自己与自己比**:生成清单的是 `@model-war/gen`,判清单的是快门禁,
 * 而快门禁不能 import 它,于是判据只能把生成逻辑抄一份——那正是本仓最不想要的第二个家。
 * 静态散文 + 集合相等的门禁把「谁是真源」留在一处(常量),把「文案是否跟上了」交给一条会红的判据。
 */

/** 模板的仓库相对路径。它是首条 `user` 消息的剧本(`agent-prompt.ts` 的 `loadAgentTemplate`)。 */
export const AGENT_TEMPLATE_PATH = "prompts/agent.md";

/** 一条违规。`where` 指到文件或那个命令名,报告里直接读得懂。 */
export type PromptCommandFinding = {
  readonly where: string;
  readonly detail: string;
};

/** 两组命令的名字:`binaries` 是静态 ELF,`shims` 是经通道交给宿主的薄壳。 */
export type CommandGroups = {
  readonly binaries: readonly string[];
  readonly shims: readonly string[];
};

/**
 * 从 rootfs 常量推出命令集合。
 *
 * 分组规则只有一条:`SANDBOX_ROOTFS_FILES` 里 `bin/` 开头的那些,**减掉** `SANDBOX_ROOTFS_SHIMS`
 * 是静态二进制,剩下的是薄壳。规则在这里写一次,散文与门禁都不另写一份「哪些是二进制」。
 */
export const derivedCommandGroups = (
  files: readonly string[],
  shims: readonly string[],
): CommandGroups => {
  const binNames = files.filter((path) => path.startsWith("bin/")).map((path) => path.slice(4));
  const shimNames = [...new Set(shims)].sort();
  const shimSet = new Set(shimNames);
  return {
    binaries: binNames.filter((name) => !shimSet.has(name)).sort(),
    shims: shimNames,
  };
};

/** 清单里的一行:`- \`名字\` — 用途`。`index` 是它在模板里的行号(1 起),报错时指得到。 */
export type ListedCommand = {
  readonly name: string;
  readonly purpose: string;
  readonly group: "binaries" | "shims";
  readonly index: number;
};

/** 标题行(`##` 到 `######`)。 */
const HEADING = /^#{2,6}\s/u;

/** 分组标题的判据:标题里出现「薄壳」归薄壳组,出现「静态」归二进制组,其余标题结束分组。 */
const groupOfHeading = (line: string): "binaries" | "shims" | undefined => {
  if (line.includes("薄壳")) return "shims";
  if (line.includes("静态")) return "binaries";
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
  let group: "binaries" | "shims" | undefined;
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
 * 集合相等(两个方向)+ 组内唯一 + 每项一句用途。空集合不在这里判——它是入口的空转判据。
 */
export const commandListFindings = (
  template: string,
  derived: CommandGroups,
): readonly PromptCommandFinding[] => {
  const listed = listedCommands(template);
  const findings: PromptCommandFinding[] = [];

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

  for (const group of ["binaries", "shims"] as const) {
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
    const groupName = group === "binaries" ? "静态二进制" : "工具薄壳";

    for (const name of want) {
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
            `命令清单点名了 \`${name.name}\`,而 rootfs 常量里没有它。模型照这条敲会拿到 ` +
            "`command not found`——要么把它加进 `SANDBOX_ROOTFS_FILES` 并重跑 `sandbox:rootfs:build`," +
            "要么把这行删掉。",
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
