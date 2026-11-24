/**
 * **规范 ChangeSet**:一次改动到底改了哪些文件,以及这件事的 Git 语义。
 *
 * 选择器的输入是"你改了什么"。这句话以前是三行命令(`git diff --name-only <ref>` +
 * `git diff --cached` + `ls-files --others`),它有三个洞,而且三个洞**都不会以报错的形式显形**:
 *
 * 1. **基准是两点比较。** `git diff <ref>` 拿的是 `<ref>` 与工作区的两点差:分支落后 `main` 时,
 *    `main` 自己的提交会被算成"你改了什么";分支领先时又刚好看着没问题——于是这个错误只在
 *    某些分支状态下出现,而表现是"多跑"或"少跑",两种都不报错。
 *    规范做法是拿**共同祖先**:`git merge-base <ref> HEAD`。它回答的是"从分叉点以来你改了什么",
 *    这正是选择器要问的问题。
 * 2. **`--no-renames` 把重命名报成"删一个 + 加一个"。** 于是**旧路径不再参与选择**——而观测 map
 *    里记的恰恰是旧路径(那批测试读过的输入是改名前的那个文件)。旧路径不进集合 = 那些测试不跑。
 * 3. **删除靠"盘上不存在"被动处理。** 删除的文件在 `files` 里缺席之后,下游每处 `exists()` 都
 *    各自决定怎么兜:有的当"未构建",有的干脆丢掉历史路径。这里给删除一个显式语义:
 *    路径**留在集合里**,状态是 `D`。
 *
 * ── 两件事必须分开算 ──
 *
 * **集合**(`files`)是"参与选择的文件":只有一份,去重、排序、POSIX 分隔。
 * **状态**(`staged` / `unstaged` / `untracked`)是**诊断**:给人看这次改动落在哪个 Git 阶段,
 * 不参与选择。混在一起算的典型错误是"同一文件 staged 之后又改了一次"被数成两个条目——
 * 于是同一个文件被送进选择器两次,或者输出里的条数和实际文件数对不上。
 *
 * 诊断自身的基准也各有各的正确取法:`staged` 是**索引对 HEAD**,`unstaged` 是**工作区对索引**。
 * 若把 `staged` 算成"索引对共同祖先",那么分支上所有已提交的文件都会显示成 staged,
 * 那份计数就不再是"暂存区里有什么",而是"相对分叉点改了什么"——与集合重复,失去诊断价值。
 *
 * ── ref 名字有几种写法,但它们指向同一个分支 ──
 *
 * 调用方写的是分支名(`main`),而这个分支在不同 checkout 形态下落成不同的全名:本地分支 `main`、
 * 远端跟踪分支 `origin/main`、或完整的 `refs/remotes/origin/main`。`actions/checkout` 在
 * `pull_request` 上检的是 detached 的 merge ref,**本地没有 `main`**,只有 `origin/main`——于是
 * `git merge-base main HEAD` 以「Not a valid object name main」失败。这不是"这个分支不存在",
 * 而是"它没落成本地分支"。所以 `sinceRef` 先解析成实际存在的名字(`resolveSinceRef`),再拿这个
 * 名字去算共同祖先:依次试 `main` / `origin/main` / `refs/remotes/origin/main`,三种都是**同一个
 * 分支的写法**,不是另一套语义——**不许**因为本地没有 `main` 就退回到两点比较。
 *
 * ── 失败必须显式 ──
 *
 * 拿不到 merge-base(三个名字都不存在、shallow clone 太浅、两个历史没有公共祖先)时抛
 * `MergeBaseError`,**不退回**两点比较:退回是一种静默的语义降级,而它的表现是多算或少算,
 * 两种都不报错。宁可红在"算不出基准"上,也不要绿在一个错的基准上。
 *
 * 两类失败分开报:名字一个都不存在(`rev-parse --verify` 全落空)与名字存在但没有公共历史
 * (git 在浅克隆下也只有这一句可说)是不同的问题,修法也不同——前者 `git fetch`,后者加深 clone。
 */

import { spawnSync } from "node:child_process";

/** `A` 新增、`M` 修改、`D` 删除、`R` 重命名(含复制)。 */
export type ChangeStatus = "A" | "M" | "D" | "R";

export interface ChangeEntry {
  readonly status: ChangeStatus;
  /** 仓库相对路径,分隔符统一 `/`。重命名时是**新**路径;删除时是那个已不存在的路径。 */
  readonly path: string;
  /** 只有重命名/复制才有:改名前的旧路径。 */
  readonly from?: string;
}

export interface ChangeSet {
  /** 调用方给的那个 ref(未做规范化,输出里原样回显)。 */
  readonly sinceRef: string;
  /**
   * `sinceRef` 实际认出来的 git 名字。本地分支不存在时会落到 `origin/<ref>`。
   * 算基准用的一直是它:输出里回显,读报的人不必猜"基准到底是哪个 main"。
   */
  readonly resolvedRef: string;
  /** 共同祖先。一切比较的基准;`sinceRef === "HEAD"` 时它就是 HEAD。 */
  readonly baseSha: string;
  readonly headSha: string;
  readonly entries: readonly ChangeEntry[];
  /** 诊断:索引相对 HEAD 有差异的文件。 */
  readonly staged: readonly string[];
  /** 诊断:工作区相对索引有差异的文件。 */
  readonly unstaged: readonly string[];
  /** 诊断:未跟踪、且没有被 `.gitignore` 排除的文件。 */
  readonly untracked: readonly string[];
  /**
   * 参与选择的文件集合:去重、排序、POSIX 分隔。
   * 删除的路径在,重命名的**两端**都在。
   */
  readonly files: readonly string[];
}

/** git 命令非零退出。携带 argv 与 stderr:报错要能指向具体那条命令。 */
export class GitError extends Error {
  readonly args: readonly string[];
  readonly stderr: string;

  constructor(args: readonly string[], stderr: string) {
    super(`git ${args.join(" ")} 失败:\n${stderr.trim()}`);
    this.name = "GitError";
    this.args = args;
    this.stderr = stderr;
  }
}

/**
 * 拿不到共同祖先。**不许**降级成两点比较:那会静默改变"你改了什么"的含义。
 *
 * 消息里给修法而不是只给结论——这条错误在 CI 上最可能出现(shallow clone),而看到它的人
 * 往往不知道该加深 clone 还是该换 ref。
 */
export class MergeBaseError extends Error {
  constructor(sinceRef: string, detail: string) {
    super(
      `算不出 \`${sinceRef}\` 与 HEAD 的共同祖先(${detail})。\n` +
        "拒绝退回两点比较:分支落后时它会把上游自己的改动算成你的。\n" +
        "修法:确认 ref 存在(`git fetch origin`)、改用具体 sha(`--since=<sha>`),或加深 clone" +
        "(`actions/checkout` 的 `fetch-depth: 0`)。",
    );
    this.name = "MergeBaseError";
  }
}

/** 跑一条 git 并返回 stdout。测试用它注入临时仓库的 cwd。 */
export type GitRun = (args: readonly string[]) => string;

export const gitRunIn =
  (cwd: string): GitRun =>
  (args) => {
    const result = spawnSync("git", [...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.status !== 0) throw new GitError(args, result.stderr);
    return result.stdout;
  };

/** 统一成 POSIX 分隔的仓库相对路径(`git` 在 Windows 上也给 `/`,这里只是防御)。 */
export const normalizePath = (path: string): string =>
  path.replace(/\\/g, "/").replace(/^\.\//, "");

/**
 * `sinceRef` 的候选写法:本地分支 → 远端跟踪分支 → 完整的 remote ref。
 *
 * 去重是为了报错可读:调用方已经写成 `origin/main` 时,不必再去试一遍 `origin/origin/main`,
 * 因为「试过哪些名字」这条清单是要给人照着查的。
 */
export const sinceRefCandidates = (sinceRef: string): readonly string[] => [
  ...new Set([sinceRef, `origin/${sinceRef}`, `refs/remotes/origin/${sinceRef}`]),
];

/** `sinceRef` 解析的结果:实际存在的那个名字,以及它指向的 commit。 */
export interface ResolvedRef {
  readonly name: string;
  readonly sha: string;
}

/**
 * 把 `sinceRef` 解析成一个确实存在的 commit。
 *
 * 只吞 `GitError`(`rev-parse --verify` 对不存在的名字正是非零退出);别的失败照旧抛出去——
 * 权限、坏仓库这类问题换名字重试一万次也不会好。
 *
 * 三个名字都不在才抛 `MergeBaseError`,消息里**列出试过哪几个**:只说"main 不存在"会让人以为
 * 是分支名写错,而实际最常见的形态是名字存在、只是没落成本地分支(远端有 `origin/main`)。
 */
export const resolveSinceRef = (run: GitRun, sinceRef: string): ResolvedRef => {
  const candidates = sinceRefCandidates(sinceRef);
  for (const name of candidates) {
    try {
      const sha = run(["rev-parse", "--verify", `${name}^{commit}`]).trim();
      if (sha !== "") return { name, sha };
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
    }
  }
  throw new MergeBaseError(
    sinceRef,
    `试过的名字都不存在:${candidates.map((name) => `\`${name}\``).join("、")}`,
  );
};

const splitNul = (stdout: string): readonly string[] =>
  stdout
    .split("\0")
    .filter((part) => part !== "")
    .map(normalizePath);

/**
 * 解析 `git diff --name-status -z`。
 *
 * `-z` 的形态是 `M\0path\0`,重命名是 `R100\0old\0new\0`——注意是**三段**:相似度分数粘在
 * 状态码后面(`R100`),用 `code.charAt(0)` 取状态、然后按三段推进。用 `-z` 而不是按行切,
 * 是因为路径里可以有空格与换行:按行切会在第一次遇到这种路径时**静默错位**,之后每一条都错。
 *
 * 未知状态(`T` 类型变化、`U` 未合并…)按修改处理:丢掉路径比错标状态更糟——丢掉路径意味着
 * 那个文件不参与选择,而这是这套机制最不能犯的错。
 */
export const parseNameStatus = (stdout: string): readonly ChangeEntry[] => {
  const parts = stdout.split("\0").filter((part) => part !== "");
  const entries: ChangeEntry[] = [];
  let index = 0;
  while (index < parts.length) {
    const code = parts[index] ?? "";
    index += 1;
    if (code === "") continue;
    const status = code.charAt(0);
    if (status === "R" || status === "C") {
      const from = parts[index];
      const to = parts[index + 1];
      if (from === undefined || to === undefined) {
        throw new Error(`解析 --name-status 失败:重命名条目缺少路径(${code})`);
      }
      index += 2;
      // 复制(`C`)同样两端都留:新路径是新文件,旧路径仍在被读。
      entries.push({ status: "R", path: normalizePath(to), from: normalizePath(from) });
      continue;
    }
    const path = parts[index];
    if (path === undefined) {
      throw new Error(`解析 --name-status 失败:状态 ${code} 后面没有路径`);
    }
    index += 1;
    const mapped: ChangeStatus = status === "A" || status === "D" || status === "M" ? status : "M";
    entries.push({ status: mapped, path: normalizePath(path) });
  }
  return entries;
};

/**
 * 一份 ChangeSet 的最终文件集合:两端都留、去重、排序。
 *
 * 排序用默认的码元序(不是 `localeCompare`):后者随 locale/ICU 变,同一份改动在两台机器上
 * 可能给出不同顺序,而"同样的改动 → 同样的输出"是这套机制可对照的前提。
 */
export const filesOf = (
  entries: readonly ChangeEntry[],
  untracked: readonly string[],
): readonly string[] => {
  const set = new Set<string>();
  for (const entry of entries) {
    set.add(entry.path);
    // 重命名的**旧路径也要留**:观测 map 里记的是旧路径,选择器要靠它把改动翻成测试候选。
    if (entry.from !== undefined) set.add(entry.from);
  }
  for (const path of untracked) set.add(normalizePath(path));
  set.delete("");
  return [...set].sort();
};

/**
 * 算一份规范 ChangeSet。
 *
 * `run` 注入是为了让测试能在**真**临时仓库里跑同一段代码:选择器最怕的是"测的是另写的
 * 简化版",所以这里不提供内存版 git 假件,只换 cwd。
 */
export const computeChangeSet = (input: {
  readonly run: GitRun;
  readonly sinceRef: string;
}): ChangeSet => {
  const { run, sinceRef } = input;
  const headSha = run(["rev-parse", "HEAD"]).trim();

  // 先把名字认成一个存在的 commit,再拿它算共同祖先:两步失败的原因不同(名字不存在 / 有名字但
  // 没有公共历史),报错要分得开,否则读报的人不知道该 `git fetch` 还是该加深 clone。
  const since = resolveSinceRef(run, sinceRef);

  let mergeBase: string;
  try {
    mergeBase = run(["merge-base", since.name, "HEAD"]).trim();
  } catch (error) {
    // shallow clone 太浅、两个历史无公共祖先,在 git 眼里都是同一条命令失败。
    // 这里统一翻译成"算不出基准",而不是让调用方去认 GitError 的 stderr 措辞。
    // 注意:没有公共祖先时 `git merge-base` 会**静默**非零退出(stderr 为空),所以不能把
    // stderr 直接当原因拼进消息——那会得到一句"失败:"后面空着。
    if (error instanceof GitError) {
      const reason =
        error.stderr.trim() === ""
          ? "两个历史没有公共祖先(浅克隆下父提交被截断)"
          : error.stderr.trim();
      throw new MergeBaseError(
        sinceRef,
        `已解析到 \`${since.name}\`,但 git merge-base 失败:${reason}`,
      );
    }
    throw error;
  }
  if (mergeBase === "") {
    throw new MergeBaseError(sinceRef, `已解析到 \`${since.name}\`,但 git merge-base 没有输出`);
  }
  const baseSha = mergeBase;

  // **工作区 vs 共同祖先**:已提交的、staged 的、unstaged 的一次算全(两者都反映在工作区里)。
  // `--find-renames` 让重命名带出 `from`;`-z` 防路径错位。
  const entries = parseNameStatus(
    run(["diff", "--name-status", "-z", "--find-renames", baseSha, "--"]),
  );

  const untracked = splitNul(run(["ls-files", "--others", "--exclude-standard", "-z"]));
  // 诊断口径:staged 是索引对 HEAD(暂存区里到底有什么),unstaged 是工作区对索引。
  const staged = splitNul(run(["diff", "--cached", "--name-only", "-z", "HEAD", "--"]));
  const unstaged = splitNul(run(["diff", "--name-only", "-z", "--"]));

  return {
    sinceRef,
    resolvedRef: since.name,
    baseSha,
    headSha,
    entries,
    staged: [...new Set(staged)].sort(),
    unstaged: [...new Set(unstaged)].sort(),
    untracked: [...new Set(untracked)].sort(),
    files: filesOf(entries, untracked),
  };
};

/** `computeChangeSet` 的便捷入口:在 `cwd` 里跑 git。 */
export const computeChangeSetIn = (cwd: string, sinceRef: string): ChangeSet =>
  computeChangeSet({ run: gitRunIn(cwd), sinceRef });

/**
 * 给人看的那几行。所有数字都是算出来的,不打样。
 *
 * 用词是"参与选择的文件"而不是"覆盖":集合只说明哪些文件进了选择器,不说明有测试保护它们
 * (ADR-0038 的措辞纪律)。
 */
export const describeChangeSet = (changeSet: ChangeSet): string => {
  const count = (status: ChangeStatus): number =>
    changeSet.entries.filter((entry) => entry.status === status).length;
  const short = (sha: string): string => sha.slice(0, 7);
  // 解析名字与调用方写的名字不同时才画箭头:本地有 `main` 的那些机器上不必看第二遍。
  const base =
    changeSet.resolvedRef === changeSet.sinceRef
      ? `基准 = \`${changeSet.sinceRef}\``
      : `基准 = \`${changeSet.sinceRef}\` → \`${changeSet.resolvedRef}\``;
  return (
    `ChangeSet(${base} 与 HEAD 的共同祖先 ${short(changeSet.baseSha)}):\n` +
    `  基准 ${short(changeSet.baseSha)} → HEAD ${short(changeSet.headSha)}\n` +
    `  staged ${String(changeSet.staged.length)} · unstaged ${String(changeSet.unstaged.length)}` +
    ` · untracked ${String(changeSet.untracked.length)}(诊断,不参与选择)\n` +
    `  新增 ${String(count("A"))} · 修改 ${String(count("M"))} · 删除 ${String(count("D"))}` +
    ` · 重命名 ${String(count("R"))} · 参与选择的文件 ${String(changeSet.files.length)}`
  );
};
