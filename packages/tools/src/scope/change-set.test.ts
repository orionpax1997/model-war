/**
 * `ChangeSet` 的 Git 语义。**每个用例都在临时仓库里真跑 git**。
 *
 * 为什么不造假件:`ChangeSet` 的全部价值在于"Git 到底怎么回答",而 `--name-status -z` 的三段
 * 格式、重命名检测的相似度门槛、`merge-base` 在分支落后时的取值,这些都是 git 自己的行为。
 * 用内存假件测出来的只是"我以为 git 会这么回答"。所以这里只替换 `cwd`(每个用例一个
 * `mkdtempSync` 仓库),被测代码一行不改。
 *
 * 每个 `it` 对应票里的一条断言,顺序与票一致;11、12 是 CI 上真实红过的那两类(ref 名字没落成本地
 * 分支 / 三个名字都不存在),它们排在同一条 `--since` 语义的后半段,所以接着往后编号。
 *
 * 临时仓库的两处必要设置:
 * - `-c user.name/-c user.email`:CI 与全新机器上未必有全局身份,没有它 `git commit` 直接失败,
 *   而失败原因与 ChangeSet 无关。
 * - `-c commit.gpgsign=false`:宿主机若全局开了签名,临时仓库没有密钥,同样会把环境问题
 *   报成被测代码的问题。
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type ChangeSet,
  GitError,
  MergeBaseError,
  computeChangeSetIn,
  describeChangeSet,
  filesOf,
  parseNameStatus,
} from "./change-set.js";

const dirs: string[] = [];

const IDENTITY: readonly string[] = [
  "-c",
  "user.name=ChangeSet Test",
  "-c",
  "user.email=changeset@example.invalid",
  "-c",
  "commit.gpgsign=false",
];

interface TempRepo {
  readonly dir: string;
  /** 带身份跑 git,返回 stdout;非零退出抛错(测试自己的错,不是被测代码的)。 */
  readonly git: (...args: string[]) => string;
  readonly write: (path: string, content: string) => void;
  /** `add -A` 后提交,返回提交 sha。 */
  readonly commit: (message: string) => string;
  /** 被测入口:在被测仓库里算 ChangeSet。 */
  readonly changeSet: (sinceRef: string) => ChangeSet;
}

const openRepo = (): TempRepo => {
  const dir = mkdtempSync(join(tmpdir(), "model-war-changeset-"));
  dirs.push(dir);
  const git = (...args: string[]): string => {
    const result = spawnSync("git", [...IDENTITY, ...args], { cwd: dir, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`临时仓库里 git ${args.join(" ")} 失败:\n${result.stderr}`);
    }
    return result.stdout;
  };
  git("init", "-q", "-b", "main");
  const write = (path: string, content: string): void => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content, "utf8");
  };
  const commit = (message: string): string => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD").trim();
  };
  return { dir, git, write, commit, changeSet: (sinceRef) => computeChangeSetIn(dir, sinceRef) };
};

const occurrences = (files: readonly string[], path: string): number =>
  files.filter((candidate) => candidate === path).length;

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true });
});

describe("ChangeSet", () => {
  it("1. 分支落后 main 时,集合里只有分支自己的改动(基准是共同祖先,不是 main 的尖端)", () => {
    const repo = openRepo();
    repo.write("base.txt", "base\n");
    const baseSha = repo.commit("base");

    repo.git("checkout", "-q", "-b", "topic");
    repo.write("topic.ts", "export const topic = 1;\n");
    repo.commit("topic 自己的改动");

    repo.git("checkout", "-q", "main");
    repo.write("main-only.ts", "export const upstream = 1;\n");
    repo.commit("上游在 main 上又走了几步");
    repo.git("checkout", "-q", "topic");

    const changeSet = repo.changeSet("main");

    expect(changeSet.resolvedRef, "本地有 main 时不许被改写成 origin/main").toBe("main");
    expect(changeSet.baseSha, "基准必须是共同祖先,而不是 main 的尖端").toBe(baseSha);
    expect(changeSet.files).toContain("topic.ts");
    expect(changeSet.files, "main 独有的改动不属于这次改动").not.toContain("main-only.ts");
  });

  it("2. 分支上已提交的文件在集合里(两点比较能算对的这一半也不能丢)", () => {
    const repo = openRepo();
    repo.write("base.txt", "base\n");
    repo.commit("base");
    repo.git("checkout", "-q", "-b", "topic");
    repo.write("committed.ts", "export const committed = 1;\n");
    repo.commit("提交一个文件");
    repo.write("another.ts", "export const another = 1;\n");
    repo.commit("再提交一个");

    const changeSet = repo.changeSet("main");

    expect(changeSet.files).toEqual(["another.ts", "committed.ts"]);
    expect(changeSet.entries.map((entry) => entry.status)).toEqual(["A", "A"]);
    expect(changeSet.headSha).not.toBe(changeSet.baseSha);
  });

  it("3. 只 staged / 只 unstaged / 两者都有 → 集合里各出现一次", () => {
    const repo = openRepo();
    repo.write("staged-only.txt", "v1\n");
    repo.write("unstaged-only.txt", "v1\n");
    repo.write("both.txt", "v1\n");
    repo.commit("base");

    repo.write("staged-only.txt", "v2\n");
    repo.git("add", "staged-only.txt");
    repo.write("unstaged-only.txt", "v2\n");
    // 同一个文件:先 staged,再在暂存之后改一次。诊断两端都该看到它,集合里只能有一次。
    repo.write("both.txt", "v2\n");
    repo.git("add", "both.txt");
    repo.write("both.txt", "v3\n");

    const changeSet = repo.changeSet("HEAD");

    expect(changeSet.files).toEqual(["both.txt", "staged-only.txt", "unstaged-only.txt"]);
    expect(occurrences(changeSet.files, "both.txt"), "同一文件不许被数成两条").toBe(1);
    expect(
      changeSet.entries.filter((entry) => entry.path === "both.txt"),
      "entries 也不许重复",
    ).toHaveLength(1);
    expect(changeSet.staged).toEqual(["both.txt", "staged-only.txt"]);
    expect(changeSet.unstaged).toEqual(["both.txt", "unstaged-only.txt"]);
  });

  it("4. untracked 在集合里;被 .gitignore 排除的不在", () => {
    const repo = openRepo();
    repo.write(".gitignore", "ignored.txt\nignored-dir/\n");
    repo.write("tracked.txt", "v1\n");
    repo.commit("base");

    repo.write("new-file.txt", "new\n");
    repo.write("ignored.txt", "ignored\n");
    repo.write("ignored-dir/data.txt", "ignored\n");

    const changeSet = repo.changeSet("HEAD");

    expect(changeSet.files).toContain("new-file.txt");
    expect(changeSet.files, "忽略文件不许进集合,更不许影响计数").not.toContain("ignored.txt");
    expect(changeSet.untracked).toEqual(["new-file.txt"]);
  });

  it("5. 删除的文件仍在集合里,状态是 D(不靠「盘上不存在」被动处理)", () => {
    const repo = openRepo();
    repo.write("keep.txt", "keep\n");
    repo.write("gone.txt", "gone\n");
    repo.commit("base");

    rmSync(join(repo.dir, "gone.txt"));

    const changeSet = repo.changeSet("HEAD");

    expect(changeSet.entries).toContainEqual({ status: "D", path: "gone.txt" });
    expect(changeSet.files, "删除的路径必须留下:观测 map 与表规则都按旧路径记").toContain(
      "gone.txt",
    );
  });

  it("6. 重命名:旧路径与新路径都在集合里,status 为 R 且 from 是旧路径", () => {
    const repo = openRepo();
    repo.write("old-name.ts", "export const value = 1;\n");
    repo.write("untouched.txt", "keep\n");
    const baseSha = repo.commit("base");

    repo.git("mv", "old-name.ts", "new-name.ts");
    repo.commit("改名");

    const changeSet = repo.changeSet(baseSha);

    const renamed = changeSet.entries.filter((entry) => entry.status === "R");
    expect(renamed).toHaveLength(1);
    expect(renamed[0]?.path).toBe("new-name.ts");
    expect(renamed[0]?.from).toBe("old-name.ts");
    // 集合里只有改名这件事实的两端;没改动的 `untouched.txt` 不在,说明比较的不是全量文件清单。
    expect(changeSet.files).toEqual(["new-name.ts", "old-name.ts"]);
  });

  it("7. sinceRef 不存在 → MergeBaseError(显式失败,且消息给出修法)", () => {
    const repo = openRepo();
    repo.write("base.txt", "base\n");
    repo.commit("base");

    let caught: unknown;
    try {
      repo.changeSet("no-such-ref");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MergeBaseError);
    expect(caught, "不许退回两点比较:那是静默的语义降级").not.toBeInstanceOf(GitError);
    const message = caught instanceof MergeBaseError ? caught.message : "";
    expect(message).toMatch(/共同祖先/);
    expect(message, "报错要给出修法,不只给结论").toMatch(/fetch-depth|git fetch/);
  });

  it("8. --since=HEAD:只有工作区的改动(已提交的不算)", () => {
    const repo = openRepo();
    repo.write("keep.txt", "v1\n");
    repo.write("other.txt", "v1\n");
    repo.commit("base");
    repo.write("committed.ts", "export const committed = 1;\n");
    repo.commit("这次分支上的提交(不该出现在 --since=HEAD 里)");

    repo.write("keep.txt", "v2\n");
    repo.git("add", "keep.txt");
    repo.write("other.txt", "v2\n");
    repo.write("untracked.txt", "new\n");

    const changeSet = repo.changeSet("HEAD");

    expect(changeSet.baseSha).toBe(changeSet.headSha);
    expect(changeSet.files).toEqual(["keep.txt", "other.txt", "untracked.txt"]);
    expect(changeSet.staged).toEqual(["keep.txt"]);
    expect(changeSet.unstaged).toEqual(["other.txt"]);
    expect(changeSet.untracked).toEqual(["untracked.txt"]);
  });

  it("9. 输出顺序稳定:两次调用逐字节相同,且 files 是有序的", () => {
    const repo = openRepo();
    repo.write("keep.txt", "v1\n");
    repo.commit("base");
    for (const path of ["b.ts", "a.ts", "dir/c.ts", "Z.ts"]) repo.write(path, `${path}\n`);

    const first = repo.changeSet("HEAD");
    const second = repo.changeSet("HEAD");

    expect(first.files.length).toBeGreaterThan(3);
    expect(JSON.stringify(second), "同样的输入必须给同样的输出").toBe(JSON.stringify(first));
    expect(first.files).toEqual([...first.files].sort());
  });

  it("10. parseNameStatus:含空格/换行的路径与 R100 三段都解析正确(纯函数)", () => {
    const stdout = `${[
      "M",
      "dir/with space.ts",
      "R100",
      "old path.ts",
      "new path.ts",
      "A",
      "multi\nline.ts",
      "T",
      "dir\\windows.ts",
    ].join("\0")}\0`;

    const entries = parseNameStatus(stdout);

    expect(entries).toEqual([
      { status: "M", path: "dir/with space.ts" },
      { status: "R", path: "new path.ts", from: "old path.ts" },
      { status: "A", path: "multi\nline.ts" },
      // 未知状态(T 类型变化)按修改处理:丢路径比错标状态更糟。
      { status: "M", path: "dir/windows.ts" },
    ]);
    expect(filesOf(entries, ["untracked file.ts"])).toEqual([
      "dir/windows.ts",
      "dir/with space.ts",
      "multi\nline.ts",
      "new path.ts",
      "old path.ts",
      "untracked file.ts",
    ]);
    expect(parseNameStatus("")).toEqual([]);
  });

  it("11. 只有 `origin/main`、没有本地 `main` 时,`--since=main` 仍能算出集合(PR 上的形状)", () => {
    const repo = openRepo();
    repo.write("base.txt", "base\n");
    const baseSha = repo.commit("base");

    // 这就是 `actions/checkout` 在 `pull_request` 上的形状:检到 detached 的 merge ref,
    // 本地没有 `main`,远端跟踪分支倒是有一个。
    repo.git("update-ref", "refs/remotes/origin/main", baseSha);
    repo.git("checkout", "-q", "--detach");
    repo.git("branch", "-D", "main");
    repo.write("topic.ts", "export const topic = 1;\n");
    repo.commit("分支自己的改动");

    // 前提先立起:本地真的没有 `main`。否则这条用例测的是另一回事。
    expect(
      () => repo.git("rev-parse", "--verify", "main^{commit}"),
      "临时仓库里不许还有本地 main",
    ).toThrow(/git rev-parse --verify main\^\{commit\} 失败/u);

    const changeSet = computeChangeSetIn(repo.dir, "main");

    expect(changeSet.resolvedRef, "`main` 应落到 `origin/main`").toBe("origin/main");
    expect(changeSet.sinceRef, "调用方写的名字原样回显,不许被改掉").toBe("main");
    expect(changeSet.baseSha, "共同祖先仍是 origin/main 与 HEAD 那个").toBe(baseSha);
    expect(changeSet.files).toEqual(["topic.ts"]);
    // 报告里要看得见解析到了哪个名字:不让人猜基准到底是哪个 main。
    expect(describeChangeSet(changeSet)).toContain("`main` → `origin/main`");
  });

  it("12. 三个名字都不存在 → MergeBaseError,且列出试过的名字", () => {
    const repo = openRepo();
    repo.write("base.txt", "base\n");
    repo.commit("base");

    let caught: unknown;
    try {
      repo.changeSet("no-such-branch");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MergeBaseError);
    const message = caught instanceof MergeBaseError ? caught.message : "";
    // 只报"main 不存在"会让人以为分支名写错;这里要把试过的三种写法都摆出来。
    for (const tried of [
      "`no-such-branch`",
      "`origin/no-such-branch`",
      "`refs/remotes/origin/no-such-branch`",
    ]) {
      expect(message, `报错里必须列出试过的名字:${tried}`).toContain(tried);
    }
    expect(message).toMatch(/git fetch/);
  });
});
