/**
 * 契约包(`/contract`)的清单与散文判据。
 *
 * ── 契约包是**一个**目录,不是四份互不相干的文件 ──
 *
 * `/contract` 挂进去的四条全部来自 `docs/rules-v2/`:`README.md`(目录说明)、`rules.md`、
 * `api.md`、`examples/minimal.ts`(从 `api.md` §6 抽出的骨架)。塌缩成「契约目录就是挂载源」
 * 之后,「模型读到的契约」与「仓库里那份契约」是同一批字节,所以**一份清单就够了**:本文件这份
 * `CONTRACT_FILES`。挂载器、生成链、门禁都读它,不再各存一份。
 *
 * 版本号不在这份清单里:版本住在目录名(`docs/rules-v2/`),它的三处一致判据归
 * `apps/cli/src/validator.ts`。契约包**身份**是整棵树的内容哈希,口径在 ADR-0037:算法在
 * `contract-tree.ts`(边上的模块),取值是 `@model-war/schema` 的 `CONTRACT_TREE_HASH`(消费方是
 * 生成侧渲染的首条消息末行)。分工的理由写在那里的头注:这里只管「四条叫什么、各在哪」。
 *
 * ── 三条判据,守的是三种不同的漂 ──
 *
 * 1. **目录说明与实际目录一致**:README 里点名的每一条都得在清单里、都在盘上;清单里每一条也得
 *    被 README 点名。两边任缺一头,模型读到的目录说明就是错的——而它是**首条消息的全部内容**
 *    (ADR-0030),档案里只存这一条(ADR-0031),复核时没有第二份可对。
 * 2. **说明里不许出现可写面**:`/workspace` 属于这次会话的任务与硬约束,不属于按版本冻结的契约
 *    目录。两处都写就出现了「同一句话两个家」,而只读那一份改不了、prompt 那份能改——漂移方向
 *    固定,迟早不一致。判据是一行正则,代价为零。
 * 3. **目录里不许有清单外的文件**:多出来的文件不会被挂载,但它看起来像是契约的一部分。
 *    「四条」这个数字由清单承担,不由人记。
 *
 * ── 零构建 ──
 *
 * 只 import node 内置模块。挂在 `check:quick` 上的门禁必须零构建(hld §2.2.8、ADR-0003),
 * 而本模块要同时被那道门禁与 (将来的) 挂载器读取,所以它不碰 `@model-war/schema`。
 */

/** 契约目录。它是挂载源,也是版本号的家(三处一致判据归 `apps/cli/src/validator.ts`)。 */
export const CONTRACT_DIR = "docs/rules-v2";

/**
 * 挂载的四条,路径相对 `CONTRACT_DIR`。**顺序就是模型该读的顺序**:先看目录说明,再读机制,
 * 再读 API,最后拿骨架起手。
 */
export const CONTRACT_FILES = ["README.md", "rules.md", "api.md", "examples/minimal.ts"] as const;

/** 目录说明。它单独有名字,因为三条判据里有两条只对它说话。 */
export const CONTRACT_INDEX = "README.md";

/** 目录说明的仓库相对路径。 */
export const CONTRACT_INDEX_PATH = `${CONTRACT_DIR}/${CONTRACT_INDEX}`;

/** 一条违规。`where` 指到文件或那个 token,报告里直接读得懂。 */
export type ContractFinding = {
  readonly where: string;
  readonly detail: string;
};

/** 文件在沙箱里被读到的路径。挂载点固定是 `/contract`,与契约目录名里的版本号无关。 */
export const mountPathOf = (file: string): string => `/contract/${file}`;

/**
 * README 里出现的 `/contract/<path>` 一律取出来。
 *
 * 只认**看起来像路径**的那些字符(字母数字与 `._/-`),所以句末的标点与中文不会被吞进来——
 * 否则「`/contract/api.md`。」会被当成一个叫 `api.md。` 的文件,报出一句没人看得懂的错。
 */
const MOUNT_TOKEN = /\/contract\/([A-Za-z0-9._/-]+)/g;

/** README 里点名了哪些挂载路径。重复出现只算一条,报告里不重复报。 */
export const mentionedMountPaths = (readme: string): ReadonlySet<string> =>
  new Set([...readme.matchAll(MOUNT_TOKEN)].map((match) => match[1] ?? ""));

/**
 * 判据一:目录说明与挂载清单互相对得上。
 *
 * 两个方向都判。只判「提到的都存在」会放过「四条只写了三条」——那正是最可能的形态:
 * 有人加了第五条挂载,忘了改说明;或者说明里删了一条,而挂载还在。
 */
export const indexCoverageFindings = (readme: string): readonly ContractFinding[] => {
  const mentioned = mentionedMountPaths(readme);
  const findings: ContractFinding[] = [];

  for (const path of [...mentioned].sort()) {
    if (!(CONTRACT_FILES as readonly string[]).includes(path)) {
      findings.push({
        where: mountPathOf(path),
        detail:
          `目录说明点名了 ${mountPathOf(path)},但它不在挂载清单里(\`CONTRACT_FILES\`)。` +
          `模型照这条去读会撞上一个不存在的文件。`,
      });
    }
  }

  for (const file of CONTRACT_FILES) {
    if (!mentioned.has(file)) {
      findings.push({
        where: CONTRACT_INDEX_PATH,
        detail:
          `目录说明没有点名 ${mountPathOf(file)}。四条里少写一条,模型就不知道它存在——` +
          `而这份说明是首条消息的全部内容,档案里没有第二份可对。`,
      });
    }
  }

  return findings;
};

/** 判据二:目录说明里不许出现可写面。理由见文件头注第 2 条。 */
export const writableWorldFindings = (readme: string): readonly ContractFinding[] =>
  readme.includes("/workspace")
    ? [
        {
          where: CONTRACT_INDEX_PATH,
          detail:
            "目录说明里出现了 `/workspace`。可写面与交付物路径属于**这次会话**的任务与硬约束" +
            "(ADR-0032 的 `system` / 首条 `user` 分界),不属于按版本冻结的契约目录:" +
            "两处都写就是同一句话两个家,而只读那一份改不了。",
        },
      ]
    : [];

/**
 * 判据三:目录里实际有的文件 == 挂载清单。
 *
 * `present` 传目录下**递归**收出来的仓库相对路径(相对 `CONTRACT_DIR`)。多出来的文件不会被
 * 挂载,却看起来像契约的一部分;少了的文件则让挂载点在运行时缺一条。
 */
export const directoryFindings = (present: readonly string[]): readonly ContractFinding[] => {
  const have = new Set(present);
  const findings: ContractFinding[] = [];

  for (const file of CONTRACT_FILES) {
    if (!have.has(file)) {
      findings.push({
        where: `${CONTRACT_DIR}/${file}`,
        detail: `挂载清单里的这一条在目录里不存在。挂载点会有四个位置里缺一个。`,
      });
    }
  }
  for (const file of [...have].sort()) {
    if (!(CONTRACT_FILES as readonly string[]).includes(file)) {
      findings.push({
        where: `${CONTRACT_DIR}/${file}`,
        detail:
          `目录里多了一份不在挂载清单里的文件。它不会被挂载,却看起来像契约的一部分;` +
          `要进契约就把它加进 \`CONTRACT_FILES\` 与目录说明,不进就从契约目录挪走。`,
      });
    }
  }

  return findings;
};
