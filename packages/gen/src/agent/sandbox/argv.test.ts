/**
 * 一步的**形状**:bwrap 参数表与 `ulimit` 包装。纯函数,不 spawn、不需要内核能力。
 *
 * ── 为什么这些断言值得写 ──
 * 参数表是这条沙箱的**全部隔离内容**:少一条 `--unshare-net`,沙箱就有网;少一条
 * `--cap-drop ALL`,命名空间里就有全部 capability;把命令拼进脚本字符串而不是走位置参数,
 * 一层转义就会让「模型写的命令」与「真正跑的命令」不再逐字节同源。这些都不会以「命令失败」
 * 的形式出现,只会以「隔离没生效」的形式出现——而那正是最难在事后发现的一类。
 *
 * 真跑内核的那部分(可用性 / 无网络 / 后台进程回收)在 `pnpm run check:sandbox`:它需要非特权
 * user namespace,不属于常跑链的依赖。
 */

import { describe, expect, it } from "vitest";

import { bwrapArgv, preflightArgv, STEP_LIMITS, stepPrelude, type StepCommand } from "./argv.js";

const rootfsDir = "/repo/packages/gen/sandbox-rootfs";
const workspaceDir = "/tmp/ws";

const argvOf = (command = "echo hi"): readonly string[] =>
  bwrapArgv({ command, workspaceDir, rootfsDir } satisfies StepCommand);

/** 某个选项后面跟着的参数(取第一次出现)。找不到时返回 `undefined`。 */
const valueAfter = (argv: readonly string[], flag: string): string | undefined => {
  const at = argv.indexOf(flag);
  return at < 0 ? undefined : argv[at + 1];
};

describe("一步的 bwrap 参数表", () => {
  it("根从空的 tmpfs 开始:第一个动作必须是 --tmpfs /", () => {
    // 顺序不是排版偏好:先 `--tmpfs /` 才谈得上「往里 bind 什么」;反过来的话宿主根会先在场,
    // 「可见面是从空根里长出白名单」这句话就不成立了。
    expect(argvOf().slice(0, 2)).toEqual(["--tmpfs", "/"]);
  });

  it("只从入库 rootfs 挂 bin/ 与 contract/,并把工作区 bind 成唯一可写面", () => {
    const argv = argvOf();
    expect(valueAfter(argv, "--ro-bind")).toBe(`${rootfsDir}/bin`);
    expect(argv[argv.indexOf("--ro-bind") + 2]).toBe("/bin");
    const contractAt = argv.indexOf("--ro-bind", argv.indexOf("--ro-bind") + 1);
    expect(argv[contractAt + 1]).toBe(`${rootfsDir}/contract`);
    expect(argv[contractAt + 2]).toBe("/contract");
    expect(valueAfter(argv, "--bind")).toBe(workspaceDir);
    expect(argv[argv.indexOf("--bind") + 2]).toBe("/workspace");
    // 唯一可写面:表里只有一个 `--bind`(其余挂载都是 `--ro-bind` / 伪文件系统)。
    expect(argv.filter((item) => item === "--bind")).toHaveLength(1);
    expect(argv).not.toContain("/tmp");
  });

  it("不 bind 宿主 /usr、/lib、/bin:宿主根目录一个 inode 都不出现", () => {
    const argv = argvOf();
    // 挂载源只有三样:入库 rootfs 的 bin/、它的 contract/、这一步的工作区。宿主目录一个都不在。
    const sources = argv.flatMap((item, index) =>
      item === "--ro-bind" || item === "--bind" ? [argv[index + 1] ?? ""] : [],
    );
    expect(sources).toEqual([`${rootfsDir}/bin`, `${rootfsDir}/contract`, workspaceDir]);
    for (const hostPath of ["/usr", "/lib", "/lib64", "/bin", "/etc"]) {
      expect(sources, `${hostPath} 出现在挂载源里`).not.toContain(hostPath);
    }
    // 容器里的 `/bin` 出现两次,两处都是**目标**而不是源:挂载点,以及 PATH 的值。
    expect(argv.filter((item) => item === "/bin")).toHaveLength(2);
    expect(valueAfter(argv, "--setenv")).toBe("PATH");
    expect(argv[argv.indexOf("--setenv") + 2]).toBe("/bin");
  });

  it("六个命名空间、能力清零、新会话、随父死、环境清空,一条不少", () => {
    const argv = argvOf();
    for (const flag of [
      "--unshare-user",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--unshare-net",
      "--unshare-cgroup-try",
      "--new-session",
      "--die-with-parent",
      "--clearenv",
    ]) {
      expect(argv, `${flag} 缺了`).toContain(flag);
    }
    expect(valueAfter(argv, "--cap-drop")).toBe("ALL");
    // 环境只有 PATH 与 HOME 两条:宿主环境变量(含凭证)一条都不漏进来。
    expect(argv.filter((item) => item === "--setenv")).toHaveLength(2);
    expect(valueAfter(argv, "--setenv")).toBe("PATH");
    expect(valueAfter(argv, "--chdir")).toBe("/workspace");
  });

  it("命令原文走位置参数,不拼进脚本字符串", () => {
    // 命令里带引号、分号、`$()`:整段必须原样是**一个** argv 元素。拼进 `bash -c` 的脚本文本
    // 就要付一层转义,而转义一错,「模型写的命令」与「真正跑的命令」就不再同源。
    const command = `echo "a b"; printf '%s\\n' $(date +%s)`;
    const argv = argvOf(command);
    expect(argv.at(-1)).toBe(command);
    expect(argv.at(-2)).toBe("sandbox-step");
    expect(argv.at(-3)).toBe(stepPrelude(STEP_LIMITS));
    expect(argv.at(-4)).toBe("-c");
    expect(argv.at(-5)).toBe("/bin/bash");
  });

  it("每步的 shell 外面包着三条 ulimit", () => {
    const prelude = stepPrelude({ processes: 10, addressSpaceKib: 2048, cpuSeconds: 3 });
    expect(prelude).toContain("ulimit -u 10");
    expect(prelude).toContain("ulimit -v 2048");
    expect(prelude).toContain("ulimit -t 3");
    // 限额设不上时不许静默继续:退出码与「命令自己失败」分开。
    expect(prelude).toContain("exit 125");
    expect(prelude).not.toContain("|| true");
    // 最后换掉外层 shell:`-c` 里的命令在同一个进程里跑,不多留一层额度占用。
    expect(prelude.trimEnd().endsWith(`exec /bin/bash -c "$1"`)).toBe(true);
  });

  it("preflight 的最小调用复用同一批隔离参数(不是一套「更简单」的)", () => {
    const argv = preflightArgv(rootfsDir);
    for (const flag of ["--unshare-user", "--unshare-net", "--cap-drop", "--die-with-parent"]) {
      expect(argv).toContain(flag);
    }
    // 它不挂工作区:自证只问「命名空间建不建得起来」,不碰这一步要写的东西。
    expect(argv).not.toContain("--bind");
    expect(argv.at(-2)).toBe("-c");
    expect(argv.at(-1)).toContain("preflight-ok");
  });
});
