/**
 * 验收落点的存在性判据(`check:landings`)的**纯函数层**。
 *
 * ── 它补的是哪一个洞 ──
 *
 * `docs/hld.md` §11 那张表自称「验收不写在需求编号里,而是写在**能被跑出来的东西**上」。
 * 但它自己没有判据:一行落点可以指向一个不存在的脚本、一个不存在的子命令、一个不存在的文件,
 * 甚至干脆是散文,而表照旧绿着。这张表因此退化成了装饰——验收条款写在那儿,没人跑得动它。
 * 这里把「落点」变成可判的对象:**每行至少一个可执行 token,每个 token 按它自己的类别验存在性**。
 *
 * ── 四类落点,四种存在性 ──
 *
 * | 类别 | 形态 | 判据 |
 * |---|---|---|
 * | 命名脚本 | `` `check:foo` ``(或任何一个确实是脚本名的裸词) | 在 `package.json` 的 `scripts` 键集合里 |
 * | 命令行子命令 | `` `modelwar foo` `` | `foo` 在 `apps/cli/src/commands.ts` 的 `COMMANDS[].name` 里 |
 * | 文件路径 | `packages/…/x.ts`、`benchmarks/…/script.js` | 文件存在 **且** `git ls-files -- <path>` 有输出 |
 * | 目录 | `benchmarks/`(尾斜杠) | 目录存在、非空 **且** `git ls-files -- <dir>` 有输出 |
 *
 * 一条落点 token 只按它自己的类别判,不试别的类别:一个文件路径不存在时,不该被凑巧存在的
 * 同名脚本救回来。类别由**形态**决定(见 `classifyLandingToken`),不由人工登记。
 *
 * ── 为什么 token 以反引号为界 ──
 *
 * §11 的落点全部写在反引号里;散文里的普通词(`stateHash`、`预算结构门禁`)不该被当成落点去查。
 * 反引号是「这是一个可执行引用」的书写约定,判据就按这个约定读。反引号里的词**不是**落点
 * (四类都认不出)时**不算违规**:它可能只是顺带提到的名字——但一整行都认不出落点时才算违规,
 * 因为那一行的落点确实什么也跑不起来。
 *
 * ── 两类显式豁免,不是文件豁免 ──
 *
 * `` `node:crypto` ``、`` `role:slug` `` 的形态与命名脚本撞车(都是 `a:b`),但它们不是脚本:
 * 前者是 Node 内建模块名,后者是陪练池身份的数据字段占位。豁免**按前缀、逐条写理由**
 * (`SCRIPT_TOKEN_EXEMPTIONS`),不是「某份文档不查」——按文件豁免会同时放过未来真的写错的脚本名
 * (ADR-0008 明文否决的修法,散文判据那边同一条纪律)。
 *
 * ── 文档里以命名脚本形态出现的 token ──
 *
 * 同一条判据顺带覆盖 `docs/**`、`CONTEXT.md`、`README.md`、`AGENTS.md`:反引号里只要是脚本形态
 * (`a:b` 或 `a:b:c`)且不在脚本清单里,就红。这条抓的是「文档以门禁的名义指了一个不存在的命令」,
 * 那是决策记录变成假证据的最省事的方式。**`.pi/skills` 不在范围里**:那是外部技能文档,
 * 它引用的命令属于它自己的仓库。
 *
 * ── 纯函数,不碰盘 ──
 *
 * 读文件、跑 git 的是入口(`run-landing-gate.ts`),这里只收「已经读到的东西」。所以反例不必改
 * 真实文件:喂一份篡改文本 + 一份假世界(`LandingWorld`)就能验判据会红。`git` 出错的判决也在这里
 * 分家:**工具故障 ≠ 路径不存在**,两者要开不同的药方(见 `TrackedResult`)。
 */

/**
 * 落点表的家:**它就在 `docs/hld.md` 里,是手写表,不是生成物**。
 *
 * spec 明文否决「把落点表改造成生成表格」:那等于把家搬到生成器,与「每个事实只有一个家」冲突。
 * 所以判据只读这份文本,不生成它、不维护第二份。
 */
export const LANDING_DOC = "docs/hld.md";

/** §11 那一节的标题形态。用前缀判,标题措辞换了判据不跟着瞎。 */
const LANDING_HEADING = /^##\s+11\./;

/** 二级标题:**遇到下一个 `## ` 就说明 §11 已经结束**。 */
const NEXT_SECTION = /^##\s/;

/** 落点 token 的书写界:反引号片段(`docs` 里没有跨行反引号)。 */
const BACKTICKED = /`([^`\n]+)`/g;

/**
 * 命名脚本形态:`a:b`、`a:b:c`。前缀小写字母开头(与仓库的全部命名脚本一致:
 * `check:*` / `mutate:*` / `verify:fast` / `test:*` / `coupling:quickjs` / `setup:hooks` / `probes:*`)。
 *
 * 形态本身就是「这必须是一个真脚本」的声明:写进文档的 `check:foo` 若不在清单里,读文档的人
 * 会照着一条不存在的命令找结果。
 */
const SCRIPT_SHAPE = /^[a-z][a-z0-9-]*(:[a-z0-9-]+)+$/;

/** CLI 落点形态:`modelwar <子命令>`,后面可以跟参数(参数不参与判据)。裸 `modelwar` 是 bin 名,不算落点。 */
const CLI_SHAPE = /^modelwar\s+([a-z][a-z0-9-]*)(?:\s|$)/;

/** 文件落点的形态:带扩展名。判据只验存在性与版本库跟踪,不猜内容。 */
const FILE_EXTENSION = /\.[a-z0-9]+$/;

/**
 * 落点里可能出现的路径前缀(仓根那一级的真实目录)。
 *
 * 这是**窄口径**的核心:不加这一条,`stateHash`、`input.json` 这类散落在散文里的词会一个个
 * 变成「不存在的文件路径」。只有落在这些树下、且形状对得上(带扩展名或尾斜杠)的片段
 * 才是落点候选。
 */
export const LANDING_PATH_PREFIXES = [
  ".github/",
  "apps/",
  "benchmarks/",
  "docs/",
  "maps/",
  "packages/",
  "probes/",
  "prompts/",
  "rulesets/",
  "scripts/",
  "stryker/",
] as const;

/**
 * 与命名脚本形态撞车的**非脚本**前缀,逐条写理由。
 *
 * 为什么是前缀而不是文件名清单:豁免要能被一句话说清「这一类不是脚本」。按文件豁免
 * (例如「ADR 目录不查」)会同时放过未来真的写错的脚本名,那是 ADR-0008 明文否决的修法。
 */
export type ScriptTokenExemption = {
  /** token 的前缀。命中即「这不是脚本」,不再按脚本验存在性。 */
  readonly prefix: string;
  /** 为什么它不是脚本。 */
  readonly reason: string;
};

export const SCRIPT_TOKEN_EXEMPTIONS: readonly ScriptTokenExemption[] = [
  {
    prefix: "node:",
    reason: "Node 内建模块名(hld §3.2 的依赖面那一栏),不是仓库脚本",
  },
  {
    prefix: "role:",
    reason: "陪练池身份的数据字段占位(ADR-0025),不是仓库脚本",
  },
] as const;

/** 命中了哪一条豁免;没命中返回 `undefined`。 */
export const scriptTokenExemption = (token: string): ScriptTokenExemption | undefined =>
  SCRIPT_TOKEN_EXEMPTIONS.find((exemption) => token.startsWith(exemption.prefix));

/**
 * 落点 token 的类别。四类各自有一种存在性,合并成一类就会「因为类型不同而误报或漏报」。
 */
export type LandingTokenKind = "script" | "cli" | "file" | "dir";

/** 一条被认出来的落点 token。 */
export type LandingToken = {
  readonly kind: LandingTokenKind;
  /** 归一化后的值:CLI 子命令去掉 `modelwar ` 前缀与参数,其余原样;查存在性用它。 */
  readonly value: string;
  /** 反引号里的原文,写进违规消息用。 */
  readonly raw: string;
};

/**
 * 把反引号里的一个片段按**形态**归类;四类都认不出(或命中豁免)时返回 `undefined`。
 *
 * 顺序是有意的:CLI 与脚本先判(形态最具体),文件 / 目录最后判(要求已知前缀 + 形状)。
 * 命名脚本还有第二种认法:**裸词恰好是脚本名**(`coupling`、`scan`、`mutate`)。
 * 这两种认法合起来才让「一个命名脚本 token」与「散文里提到的一个词」分得开。
 */
export const classifyLandingToken = (
  raw: string,
  scripts: readonly string[],
): LandingToken | undefined => {
  const token = raw.trim();
  if (token === "" || scriptTokenExemption(token) !== undefined) {
    return undefined;
  }
  const cli = CLI_SHAPE.exec(token);
  const cliName = cli?.[1];
  if (cliName !== undefined) {
    return { kind: "cli", value: cliName, raw: token };
  }
  if (scripts.includes(token)) {
    return { kind: "script", value: token, raw: token };
  }
  if (SCRIPT_SHAPE.test(token)) {
    return { kind: "script", value: token, raw: token };
  }
  if (LANDING_PATH_PREFIXES.some((prefix) => token.startsWith(prefix))) {
    if (token.endsWith("/")) {
      return { kind: "dir", value: token, raw: token };
    }
    // 带扩展名才算文件路径:不加这一道,`packages/engine/src/snapshot` 这类前缀片段会被当成
    // 「不存在的文件」误报。
    return FILE_EXTENSION.test(token) ? { kind: "file", value: token, raw: token } : undefined;
  }
  return undefined;
};

/** 一段文本里的落点 token(按书写顺序)。 */
export const landingTokensIn = (
  text: string,
  scripts: readonly string[],
): readonly LandingToken[] =>
  [...text.matchAll(BACKTICKED)].flatMap((match) => {
    const raw = match[1];
    const token = raw === undefined ? undefined : classifyLandingToken(raw, scripts);
    return token === undefined ? [] : [token];
  });

/** 落点表的一行。`line` 是 1 起的行号,违规消息靠它指人。 */
export type LandingRow = {
  readonly line: number;
  /** 验收面(表格第一列)。 */
  readonly face: string;
  /** 落点单元格(表格第二列)。 */
  readonly landing: string;
};

/** 按 `|` 切出单元格:去掉首尾的定界竖线与每个单元格两侧的空白。 */
const cellsOf = (line: string): readonly string[] =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

/** 表头 / 分隔行:都不是落点行,数行数时不能算进去。 */
const isHeaderRow = (cells: readonly string[]): boolean => cells[0] === "验收面";

const isSeparatorRow = (cells: readonly string[]): boolean =>
  cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));

/**
 * 从 `docs/hld.md` 的文本里抽出 §11 那张表的落点行。
 *
 * 抽不到 §11(标题被改名 / 整节被删)时返回空数组——**空数组在入口那边按失败处理**:
 * 「没有落点行」不等于「落点全都存在」(空转检测的口径,`vacuous.ts`)。
 */
export const landingRowsIn = (text: string): readonly LandingRow[] => {
  const rows: LandingRow[] = [];
  let inSection = false;
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!inSection) {
      inSection = LANDING_HEADING.test(trimmed);
      continue;
    }
    if (NEXT_SECTION.test(trimmed)) {
      break;
    }
    if (!trimmed.startsWith("|")) {
      continue;
    }
    const cells = cellsOf(trimmed);
    if (cells.length < 2 || isHeaderRow(cells) || isSeparatorRow(cells)) {
      continue;
    }
    const [face = "", landing = ""] = cells;
    rows.push({ line: index + 1, face, landing });
  }
  return rows;
};

/**
 * 版本库跟踪状态。
 *
 * 三态而不是布尔:`git ls-files` **自己出错**(git 坏了、仓库不是 git 仓库)与「路径没被跟踪」
 * 是两件事。前者折算成「干净」是一条会一直绿的假门禁,折算成「路径不存在」则把工具故障报成
 * 内容问题——两者都白费,所以单列一支(`run-drift-gate.ts` 的第二刀同一条纪律)。
 */
export type TrackedResult =
  | { readonly kind: "tracked" }
  | { readonly kind: "untracked" }
  | { readonly kind: "git-error"; readonly detail: string };

/**
 * 判据要问外部世界的四件事(入口注入,纯函数不碰盘)。
 *
 * 把它写成「可注入的世界」而不是直接读盘,反例才能现做现验:喂一份「文件不存在」「目录空」
 * 「git 坏了」的假世界,红得当场、也不脏工作区。
 */
export type LandingWorld = {
  /** `package.json` 的 `scripts` 键集合。 */
  readonly scripts: readonly string[];
  /** `apps/cli/src/commands.ts` 里 `COMMANDS[].name` 的集合。 */
  readonly cliNames: readonly string[];
  /** 文件是否存在(仓库根相对路径)。 */
  readonly fileExists: (path: string) => boolean;
  /** 目录条目数;目录不存在时返回 0。 */
  readonly dirEntryCount: (path: string) => number;
  /** 路径的版本库跟踪状态。 */
  readonly trackedState: (path: string) => TrackedResult;
};

/** 一条违规:指到哪一行 / 哪一份文档,以及为什么红。 */
export type LandingFinding = {
  /** 违规所在(`<文档路径>:<行号>`)。 */
  readonly where: string;
  /** 中文说明。 */
  readonly detail: string;
};

/** 报告的规模自证:入口拿它做空转检测,门禁自测拿它证明「真的查过东西」。 */
export type LandingStats = {
  /** §11 的落点行数。 */
  readonly rows: number;
  /** 落点行里认出来的可执行 token 数。 */
  readonly tokens: number;
  /** CLI 子命令名个数(从源码文本抽出来的)。 */
  readonly cliNames: number;
  /** 被扫的文档份数。 */
  readonly docs: number;
};

/** `checkLandings` 的入参:已读到的文本 + 一份可注入的世界。 */
export type LandingGateInput = {
  /** `docs/hld.md` 的文本(落点表的家)。 */
  readonly hldText: string;
  /** 文档扫描面:路径 + 文本。`docs/**\/*.md` 与三份根文档。 */
  readonly docs: readonly LandingDoc[];
  readonly world: LandingWorld;
};

/** 一份被扫的文档。 */
export type LandingDoc = {
  readonly path: string;
  readonly text: string;
};

/** 一条 token 的存在性问题;`undefined` = 它真的存在。 */
const tokenProblem = (token: LandingToken, world: LandingWorld): string | undefined => {
  switch (token.kind) {
    case "script":
      return world.scripts.includes(token.value)
        ? undefined
        : `落点 \`${token.raw}\` 是命名脚本形态,但 \`package.json\` 的 scripts 里没有这个名字。`;
    case "cli":
      return world.cliNames.includes(token.value)
        ? undefined
        : `落点 \`${token.raw}\` 是 CLI 子命令,但 \`apps/cli/src/commands.ts\` 的 COMMANDS 里没有 ` +
            `\`${token.value}\`(现有:${world.cliNames.join("、") || "一个也没抽到"})。`;
    case "file":
      if (!world.fileExists(token.value)) {
        return `落点 \`${token.raw}\` 是文件路径,但磁盘上没有这个文件。`;
      }
      return trackedProblem(token, world.trackedState(token.value));
    case "dir": {
      if (world.dirEntryCount(token.value) === 0) {
        return `落点 \`${token.raw}\` 是目录,但它不存在或者是空的。`;
      }
      return trackedProblem(token, world.trackedState(token.value));
    }
  }
};

/** 文件与目录共用的那一半:存在只是第一关,没进版本库等于干净克隆里不存在。 */
const trackedProblem = (token: LandingToken, tracked: TrackedResult): string | undefined => {
  switch (tracked.kind) {
    case "tracked":
      return undefined;
    case "untracked":
      return `落点 \`${token.raw}\` 在磁盘上有,但 \`git ls-files\` 没有它:没进版本库,干净克隆里不存在。`;
    case "git-error":
      return (
        `落点 \`${token.raw}\` 的存在性没判成:\`git ls-files\` 自己出错了(${tracked.detail})。` +
        `这是检查失效,不是「路径不存在」。`
      );
  }
};

/**
 * 文档扫描面:反引号里**脚本形态**的 token 必须在脚本清单里。
 *
 * 只认脚本形态,不认文件 / 目录 / CLI——那三类在散文里出现的位置太多(引用一个源文件是正常的
 * 工程叙述),把它们也拉进来,这条判据就从「防错指命令」变成「防引用代码」,那是另一件事。
 */
export const scriptTokenFindings = (
  docs: readonly LandingDoc[],
  scripts: readonly string[],
): readonly LandingFinding[] =>
  docs.flatMap((doc) =>
    doc.text.split("\n").flatMap((line, index) => {
      const findings: LandingFinding[] = [];
      for (const match of line.matchAll(BACKTICKED)) {
        const token = match[1]?.trim() ?? "";
        if (
          token === "" ||
          scriptTokenExemption(token) !== undefined ||
          !SCRIPT_SHAPE.test(token) ||
          scripts.includes(token)
        ) {
          continue;
        }
        findings.push({
          where: `${doc.path}:${String(index + 1)}`,
          detail:
            `文档里以命名脚本形态出现的 \`${token}\` 不在 \`package.json\` 的 scripts 里:` +
            `照着它去找结果的人会找到「命令不存在」。`,
        });
      }
      return findings;
    }),
  );

/**
 * 判据本体:§11 每行至少一个可执行落点 token,且每个 token 按自己的类别存在;
 * 文档里脚本形态的 token 必须在脚本清单里。返回违规清单与规模自证。
 *
 * 规格自证(哪一行真的被查过)由 `stats` 交出去,入口用它做空转检测——
 * 「8 行里认出了 0 个 token」只有靠计数才看得出来。
 */
export const checkLandings = (
  input: LandingGateInput,
): { readonly findings: readonly LandingFinding[]; readonly stats: LandingStats } => {
  const rows = landingRowsIn(input.hldText);
  const findings: LandingFinding[] = [];
  let tokens = 0;

  for (const row of rows) {
    const found = landingTokensIn(row.landing, input.world.scripts);
    tokens += found.length;
    if (found.length === 0) {
      findings.push({
        where: `${LANDING_DOC}:${String(row.line)}`,
        detail:
          `验收面「${row.face}」的落点里没有一个可执行 token:一行落点至少要有一个命名脚本、` +
          `一条 \`modelwar <子命令>\`、一个文件路径或一个被跟踪的非空目录。散文不是落点——` +
          `它跑不起来,也就验收不了。`,
      });
      continue;
    }
    for (const token of found) {
      const problem = tokenProblem(token, input.world);
      if (problem !== undefined) {
        findings.push({ where: `${LANDING_DOC}:${String(row.line)}`, detail: problem });
      }
    }
  }

  return {
    findings: [...findings, ...scriptTokenFindings(input.docs, input.world.scripts)],
    stats: {
      rows: rows.length,
      tokens,
      cliNames: input.world.cliNames.length,
      docs: input.docs.length,
    },
  };
};

/**
 * 从 `apps/cli/src/commands.ts` 的**源码文本**里抽 `COMMANDS[].name`。
 *
 * 为什么读文本而不是 `import { COMMANDS }`:包图方向不允许(hld §3.2 —— 工具包不得 import
 * `apps/cli`),而另立一份子命令名单等于给「有哪些子命令」这件事造第二个家。源码文本是唯一
 * 那份真源的投影,和 `run-prose-gate.ts` 读规则集键清单源码同一条做法。
 *
 * 只切 `COMMANDS` 那一段,不扫全文:`CommandName` 那个联合类型也写着七个名字,把它一并捡进来
 * 会让「登记了但没实现的命令」看起来像已实现——那正是这条判据要挡住的东西。
 */
export const commandNamesFrom = (source: string): readonly string[] => {
  const start = source.indexOf("export const COMMANDS");
  if (start < 0) {
    return [];
  }
  const end = source.indexOf("\n];", start);
  const body = end < 0 ? source.slice(start) : source.slice(start, end);
  return [...body.matchAll(/\bname:\s*"([a-z][a-z0-9-]*)"/g)].flatMap((match) => {
    const name = match[1];
    return name === undefined ? [] : [name];
  });
};
