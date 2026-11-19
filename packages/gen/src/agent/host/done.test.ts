/**
 * `done` 哨兵:块级切分。两条判据,各自都有反面:
 *
 * 1. **切在第一个独占一行的 `done` 上**——它之前的命令照常执行,之后的一行都不执行
 *    (用真 `bash -c` 跑一遍,落两个文件来证明);
 * 2. **仍然是一次 `bash -c`**——不是「执行两段」。这条用「执行函数恰好被调用一次、且命令就是
 *    切完的那段」钉住:切成两段的话,`cd`、变量、`set -e` 都会在 `done` 那一行断掉。
 *
 * 为什么不测「命令的字节里不含 done 之后的部分」这种实现细节,而是真跑一遍:这条判据的全部意义
 * 是「模型写的东西没有发生」,那就得看`文件到底有没有出现`。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { splitDoneBlock } from "./done.js";

const dirs: string[] = [];

const workdir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "model-war-done-test-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("切分", () => {
  it("没有 done 时原样交回,`ended` 为 false", () => {
    const command = "echo a\necho b";
    expect(splitDoneBlock(command)).toEqual({ body: command, ended: false });
  });

  it("done 之前的那段照原样留下,之后的一行不留", () => {
    expect(splitDoneBlock("echo a\necho b\ndone\necho c")).toEqual({
      body: "echo a\necho b",
      ended: true,
    });
  });

  it("只有 done 的块:执行的是空命令,并且以 done 结束", () => {
    expect(splitDoneBlock("done")).toEqual({ body: "", ended: true });
  });

  it("缩进的 done 也算(模型常缩进);`echo done` / `done=1` 不算", () => {
    expect(splitDoneBlock("echo a\n   done  \necho b").ended).toBe(true);
    expect(splitDoneBlock("echo done\necho b").ended).toBe(false);
    expect(splitDoneBlock("done | cat").ended).toBe(false);
    expect(splitDoneBlock("done=1\necho $done").ended).toBe(false);
    expect(splitDoneBlock("printf 'done'\necho b").ended).toBe(false);
    expect(splitDoneBlock("# done\necho b").ended).toBe(false);
  });

  it("只切第一个 done:它之后的内容(包括再一个 done)都不执行", () => {
    expect(splitDoneBlock("echo a\ndone\necho b\ndone")).toEqual({ body: "echo a", ended: true });
  });

  it("已知边界:`for … do … done` 的收尾 `done` 也会被当成哨兵", () => {
    // 真档案里撞到过:`archive/minimax-m3.1-flash/2026-11-18T08-48-17-718Z` 第 19 步
    // (`for f in …; do … done` 的诊断块)被判成「这一块以 done 结束」,切掉后半段之后剩下一个
    // 没有收尾的 `for`,于是 `bash -c` 报语法错误、退出码 2。
    //
    // 这是 ADR-0032 明确接受的边界(「不做 shell 解析;漏的那一面是『该停没停』」):over-stop
    // 只丢命令,under-stop 会让 `done` 之后的命令真的跑起来。所以这里不改判据,只把这一格
    // 写进契约——它会被再撞到,而下次撞到的人应该一眼认出这是已知行为。
    expect(splitDoneBlock("for f in a b; do\n  echo $f\ndone\necho tail")).toEqual({
      body: "for f in a b; do\n  echo $f",
      ended: true,
    });
  });

  it("已知边界:heredoc 里独占一行的 done 也会被当成哨兵", () => {
    // 判据是「整行去空白等于 done」,不做 shell 解析——ADR-0032 明确否掉了静态解析命令这条路,
    // 代价是这一格:模型想在 heredoc 里原样写一行 done 的话会被切掉。宁可这样,也不要让
    // 「该停没停」发生(那会让 done 之后的命令真的跑起来)。
    expect(splitDoneBlock("cat <<'EOF'\ndone\nEOF").ended).toBe(true);
  });
});

describe("执行形态:切完之后仍然是一次 bash -c", () => {
  it("执行函数恰好被调用一次,命令就是切完的那段", async () => {
    const calls: string[] = [];
    const runStep = async (command: string): Promise<void> => {
      const split = splitDoneBlock(command);
      calls.push(split.body);
    };
    await runStep("echo a\necho b\ndone\necho c");
    expect(calls).toEqual(["echo a\necho b"]);
  });

  it("done 之前的命令真的执行了,之后的一行都没执行(真 bash)", () => {
    const dir = workdir();
    const command = [
      "printf 'before' > before.txt",
      "printf 'also-before' > also-before.txt",
      "done",
      "printf 'after' > after.txt",
      "printf 'also-after' > also-after.txt",
    ].join("\n");

    const split = splitDoneBlock(command);
    execFileSync("bash", ["-c", split.body], { cwd: dir });

    expect(split.ended).toBe(true);
    expect(existsSync(join(dir, "before.txt"))).toBe(true);
    expect(existsSync(join(dir, "also-before.txt"))).toBe(true);
    expect(existsSync(join(dir, "after.txt"))).toBe(false);
    expect(existsSync(join(dir, "also-after.txt"))).toBe(false);
  });

  it("`evaluate && done` 的自然写法:前半段执行,`done` 本身不会被当成命令跑", () => {
    const dir = workdir();
    const command = "printf 'evaluated' > evaluated.txt && true\ndone";
    const split = splitDoneBlock(command);
    execFileSync("bash", ["-c", split.body], { cwd: dir });
    expect(existsSync(join(dir, "evaluated.txt"))).toBe(true);
    expect(split.body.includes("done")).toBe(false);
  });
});
