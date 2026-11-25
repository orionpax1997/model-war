/**
 * 命名规范门禁的纯函数层:把「脚本怎么起名」写成可判定的四条。
 *
 * ── 为什么要有这一道 ──────────────────────────────────────────────────────
 * `package.json` 的 `scripts` 是这个仓库**唯一**的执行入口清单(AGENTS.md「门禁以命名脚本为
 * 唯一执行入口」)。清单一旦长出第二套命名维度,读的人就没法从一个名字推出「它归哪一层、
 * 会不会判定、跑完改不改工作树」。历史上有四种前缀指向同一性质(`check:*` / 裸 `coupling` /
 * `lint:types` / `test:gates`),一个词指三种性质(`check:budget` 判定、`check:budget-recheck`
 * 复算、`probes:budget` 采集),还有两个裸名与作用域不符(`mutate` 只跑一片、`check` 是全量)。
 * 这些都不是笔误,是**没有判据**的必然结果:没人能 red 的时候,名字只会越来越随意。
 *
 * ── 四条判据 ──────────────────────────────────────────────────────────────
 * 1. **名字形态**:闭集命名空间 + 至多三段。新增一条脚本时,它必须落进某个既有动词下。
 * 2. **层脚本只串联**:`quick` / `verify` / `verify:wide` / `verify:kernel` / `nightly` 的值里
 *    只许出现 `pnpm run <命名脚本>`。这是「同一命令两处定义」的根治:改动前 `--project` 的
 *    字面量在三条脚本里各有一份拷贝,改一处漏两处就是静默少跑。
 * 3. **`--project` 只有一个家**:只有 `test` 与 `test:kernel` 可以出现它,并且各自必须真的
 *    指向对应的 project。判据的用处不是禁止重复,而是让重复**受控**:谁再写第四份就红。
 * 4. **层表跟着走**:`docs/hld.md` §2.2.7 那张表必须点名全部层脚本,并且给三个新命名空间
 *    (`gate:` / `observe:` / `mutate:` / `test:`)留出位置。表与清单分家时,读文档的人会照着
 *    一条不存在的命令找结果——同一件事在 `gate:landings` 那边已经按 token 逐条验过,
 *    这里补的是「层这一格有没有漏」。
 *
 * 判据全部只读文本,零构建:它跑在 `quick` 里,必须贴得住每一轮编辑循环。
 */

/** 一条违规。`where` 是 `package.json` 的脚本名或 `docs/hld.md` 的节名。 */
export type ScriptsGateViolation = {
  readonly where: string;
  readonly detail: string;
};

/**
 * 人唯一需要记的入口。层脚本的值只许是 `pnpm run <命名脚本>` 的串联。
 *
 * 增删这一格要同时改 `docs/hld.md` §2.2.7 与 CI 的归属判断,所以它是显式清单、不是前缀推导。
 */
export const LAYER_SCRIPTS = [
  "quick",
  "verify",
  "verify:wide",
  "verify:kernel",
  "nightly",
] as const;

/**
 * 名字形态的闭集。
 *
 * 裸名只留生态通行词(`fmt` / `lint` / `build` / `clean` / `prepare` / `generate`)与层名;
 * 其余一律进 `<动词>:<对象>[:<子项>]`,动词闭集为 `setup` / `build` / `gate` / `test` /
 * `mutate` / `observe`。三段是上限——`mutate:engine:processor`、`gate:budget:recheck`
 * 这类「分片 / 子命令」用最后一段表达。
 */
const NAME_SHAPE =
  /^(?:fmt|lint|build|clean|prepare|generate|quick|verify|test|nightly|verify:[a-z0-9-]+|(?:setup|build|gate|test|mutate|observe):[a-z0-9-]+(?::[a-z0-9-]+)?)$/u;

/** 层脚本里不许出现的工具入口词:出现即「这一层开始自己制定命令」,而不是组合命名脚本。 */
const TOOL_ENTRY =
  /(?:^|[\s&|;])(?:node|npx|tsx|tsc|vitest|stryker|oxlint|oxfmt|depcruise|bash)(?![\w-])/u;

/** 层脚本允许的唯一形态:一段 `pnpm run <名字>`。 */
const CHAIN_LINK = /^pnpm run [A-Za-z0-9:_-]+$/u;

/** `--project` 的字面量(取项目名,供「各自指向对应 project」那半条判据用)。 */
const PROJECT_LITERAL = /--project\s+([A-Za-z0-9_-]+)/gu;

/** `--project` 允许出现的两个家,以及各自必须点到的 project。 */
const PROJECT_HOMES: Readonly<Record<string, readonly string[]>> = {
  test: ["unit", "property"],
  "test:property": ["property"],
  "test:gates": ["gates"],
  "test:slow": ["slow"],
  "test:kernel": ["sandbox"],
  /** 采集入口:它跑的是 unit 里的一条探针夹具,不是门禁。 */
  "observe:budget": ["unit"],
};

/** 1. 每个脚本名都必须落在闭集形态里。 */
export const scriptNameFindings = (
  scripts: Readonly<Record<string, string>>,
): readonly ScriptsGateViolation[] =>
  Object.keys(scripts)
    .filter((name) => !NAME_SHAPE.test(name))
    .map((name) => ({
      where: name,
      detail: `脚本名不在命名规范里:动词闭集是 setup/build/gate/test/mutate/observe,裸名只留 fmt/lint/build/clean/prepare/generate 与层名,最多三段。`,
    }));

/**
 * 2. 层脚本只串联命名脚本;3. `--project` 只在 `test` / `test:kernel` 里。
 *
 * 两条合成一次遍历:它们看的是同一份 `scripts` 文本,分开写会让「值里到底有什么」被解析两次。
 */
export const layerScriptFindings = (
  scripts: Readonly<Record<string, string>>,
): readonly ScriptsGateViolation[] => {
  const violations: ScriptsGateViolation[] = [];
  for (const layer of LAYER_SCRIPTS) {
    const value = scripts[layer];
    if (value === undefined) {
      violations.push({
        where: layer,
        detail: `层脚本缺失:${LAYER_SCRIPTS.join(" / ")} 是人唯一需要记的入口,少一个就有一档没人跑。`,
      });
      continue;
    }
    for (const link of value.split("&&").map((part) => part.trim())) {
      if (!CHAIN_LINK.test(link)) {
        violations.push({
          where: layer,
          detail: `层脚本只能串联命名脚本("${link}"):内联工具命令会让同一条命令出现第二份定义。`,
        });
      }
    }
    const tool = TOOL_ENTRY.exec(value);
    if (tool !== null) {
      violations.push({
        where: layer,
        detail: `层脚本里出现了工具入口词 "${tool[0].trim()}":命令的定义家是它自己那条脚本,不是层。`,
      });
    }
  }

  for (const [name, value] of Object.entries(scripts)) {
    const projects = [...value.matchAll(PROJECT_LITERAL)].map((match) => match[1] ?? "");
    const expected = PROJECT_HOMES[name];
    if (expected === undefined) {
      if (projects.length > 0) {
        violations.push({
          where: name,
          detail: `--project 只许出现在 ${Object.keys(PROJECT_HOMES).join(" / ")} 里:在别处再写一份,「改了一处」就会看起来像「改了全部」。`,
        });
      }
      continue;
    }
    const missing = expected.filter((project) => !projects.includes(project));
    if (missing.length > 0) {
      violations.push({
        where: name,
        detail: `缺 project ${missing.join(" / ")}:这一条脚本的默认覆盖面被改窄了。`,
      });
    }
  }
  return violations;
};

/** §2.2.7 那一节的文本(到下一个 `####` 标题为止)。抽不到就是 `undefined`。 */
export const layerSectionText = (hldText: string): string | undefined => {
  const start = /^####\s+2\.2\.7\b.*$/mu.exec(hldText);
  if (start === null) return undefined;
  const from = (start.index ?? 0) + start[0].length;
  const rest = hldText.slice(from);
  const next = /^####\s/mu.exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
};

/** 层表里必须出现的命名空间前缀:每个新动词都要在表里有一个位置。 */
const REQUIRED_PREFIXES = ["gate:", "observe:", "mutate:", "test:"] as const;

/** 4. `docs/hld.md` §2.2.7 的层表必须点名全部层脚本,并给每个动词留出位置。 */
export const layerTableFindings = (hldText: string): readonly ScriptsGateViolation[] => {
  const section = layerSectionText(hldText);
  if (section === undefined) {
    return [
      {
        where: "docs/hld.md",
        detail: "抽不到 §2.2.7:层表是归属判断的家,抽不到就没人知道哪条脚本归哪一层。",
      },
    ];
  }
  const violations: ScriptsGateViolation[] = [];
  for (const layer of LAYER_SCRIPTS) {
    if (!section.includes(`\`${layer}\``)) {
      violations.push({
        where: "docs/hld.md §2.2.7",
        detail: `层表里没有 \`${layer}\`:这一档在文档里没人认领。`,
      });
    }
  }
  for (const prefix of REQUIRED_PREFIXES) {
    if (!section.includes(`\`${prefix}`)) {
      violations.push({
        where: "docs/hld.md §2.2.7",
        detail: `层表里没有一个 \`${prefix}*\` 入口:命名空间加了,归属层没加。`,
      });
    }
  }
  return violations;
};

/** 四条判据合一。空数组 = 干净。 */
export const scriptsGateFindings = (input: {
  readonly scripts: Readonly<Record<string, string>>;
  readonly hldText: string;
}): readonly ScriptsGateViolation[] => [
  ...scriptNameFindings(input.scripts),
  ...layerScriptFindings(input.scripts),
  ...layerTableFindings(input.hldText),
];
