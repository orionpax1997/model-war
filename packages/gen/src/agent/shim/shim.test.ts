/**
 * 薄壳(真 `bash`)与协议体(真序列化)之间的往返。
 *
 * ── 为什么这不是「又一个协议测试」 ──
 * 沙箱里的薄壳没有 `jq`,它按**分隔串**切字段。所以「协议改了键序」「转义表多了一个」「载荷里
 * 出现了裸引号」这三件事都不会在 TypeScript 那侧暴露——它们只在真 `bash` 里炸。这个文件因此
 * 不 mock 任何一侧:一边是 `shim.sh` 的字节(拷成 `check` / `evaluate` / `finish` 再执行),另一边是
 * `@model-war/schema` 的 `serializeToolResponse`。
 *
 * 不需要 bwrap:fd 3 是一条 `socketpair`(Node 对 `stdio[2+] = "pipe"` 的实现),宿主这一端在
 * 测试进程里就够。真 bwrap 下的同一条路在 `check:sandbox` 里跑。
 *
 * ── 覆盖的四件事 ──
 * 1. 请求:恰好一行、是 JSON、工具名取自 `$0`、参数按转义表拼;
 * 2. 响应:退出码与两路输出逐字节落地(多行、引号、反斜杠、制表、中文);
 * 3. 形态不对的响应 / 通道关掉:退出码 2 与一句可读的 stderr,不静默、不冒充成功;
 * 4. 没有 fd 3:退出码 2 并说明「宿主通道未打开」。
 */

import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { parseToolRequest, serializeToolResponse, type ToolResponse } from "@model-war/schema";

const SHIM_SOURCE = fileURLToPath(new URL("./shim.sh", import.meta.url));

const root = mkdtempSync(join(tmpdir(), "model-war-shim-test-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 把薄壳拷成某个工具名(它靠 `$0` 认自己是谁)。 */
const shimAs = (tool: string): string => {
  const target = join(root, tool);
  copyFileSync(SHIM_SOURCE, target);
  chmodSync(target, 0o755);
  return target;
};

type ShimRun = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly requests: readonly string[];
};

/**
 * 跑一次薄壳。`respond` 拿到宿主收到的请求行,交回要写回去的响应行;交回 `null` 表示关掉通道
 * (模拟宿主没了)。`channel: false` 表示这一步根本没有 fd 3。
 */
const runShim = async (options: {
  readonly tool: string;
  readonly args?: readonly string[];
  readonly respond?: (request: string) => string | null;
  readonly channel?: boolean;
}): Promise<ShimRun> => {
  const binary = shimAs(options.tool);
  const channel = options.channel ?? true;
  const child = spawn(binary, [...(options.args ?? [])], {
    stdio: channel ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (stdout === null || stderr === null) {
    throw new Error("拿不到薄壳的两路输出:stdio 配置与 Node 的行为不符");
  }
  stdout.on("data", (chunk: Buffer) => out.push(chunk));
  stderr.on("data", (chunk: Buffer) => err.push(chunk));

  const requests: string[] = [];
  if (channel) {
    const stream = child.stdio[3];
    if (stream === null || stream === undefined) {
      throw new Error("拿不到 fd 3:Node 没有为它建 socketpair");
    }
    // `stdio[2+]` 在 POSIX 上是**双向**的 socketpair,但 Node 的类型把它写成单向流。
    const duplex = stream as unknown as {
      on(event: "data", listener: (chunk: Buffer) => void): unknown;
      write(chunk: string): boolean;
      end(): void;
    };
    let pending = Buffer.alloc(0);
    duplex.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const newline = pending.indexOf(0x0a);
        if (newline < 0) break;
        const line = pending.subarray(0, newline).toString("utf8");
        pending = pending.subarray(newline + 1);
        requests.push(line);
        const response = options.respond?.(line) ?? null;
        if (response === null) duplex.end();
        else duplex.write(`${response}\n`);
      }
    });
  }

  const code = await new Promise<number | null>((resolve) => {
    child.on("close", (value) => resolve(value));
  });
  return {
    code,
    stdout: Buffer.concat(out).toString("utf8"),
    stderr: Buffer.concat(err).toString("utf8"),
    requests,
  };
};

describe("请求:一行 JSON,工具名取自 $0", () => {
  it("三个名字各自报自己的名字,并且只写一行", async () => {
    for (const tool of ["check", "evaluate", "finish"]) {
      const run = await runShim({
        tool,
        respond: () => serializeToolResponse({ exitCode: 0, stdout: "", stderr: "" }),
      });
      expect(run.requests.length).toBe(1);
      expect(parseToolRequest(run.requests[0] ?? "")).toEqual({
        ok: true,
        request: { tool, args: [] },
      });
    }
  });

  it("参数按转义表拼进 `args`(引号与反斜杠不会把那一行拆坏)", async () => {
    const run = await runShim({
      tool: "check",
      args: ["--diff", 'a"b', "c\\d", "换 行"],
      respond: () => serializeToolResponse({ exitCode: 0, stdout: "", stderr: "" }),
    });
    expect(run.requests.length).toBe(1);
    expect(parseToolRequest(run.requests[0] ?? "")).toEqual({
      ok: true,
      request: { tool: "check", args: ["--diff", 'a"b', "c\\d", "换 行"] },
    });
  });
});

describe("响应:退出码与两路输出逐字节落地", () => {
  const response: ToolResponse = {
    exitCode: 3,
    result: { kind: "tsc", errorCodes: ["TS2322"] },
    stdout: 'line1\nline2 "quoted" \\backslash\\ and a literal \\n\n\ttab 中文 ✓\n',
    stderr: "err tail\n",
  };

  it("两路输出与退出码都按宿主给的字节落地(不补换行、不改写)", async () => {
    const run = await runShim({ tool: "check", respond: () => serializeToolResponse(response) });
    expect(run.code).toBe(3);
    expect(run.stdout).toBe(response.stdout);
    expect(run.stderr).toBe(response.stderr);
  });

  it("空输出与退出码 0:什么都不多写", async () => {
    const run = await runShim({
      tool: "evaluate",
      respond: () => serializeToolResponse({ exitCode: 0, stdout: "", stderr: "" }),
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });

  it("伪造的拒绝与真拒绝同形:宿主给的退出码与 stderr 原样交给调用方", async () => {
    const refusal: ToolResponse = {
      exitCode: 1,
      stdout: "",
      stderr: "evaluate: 工具不可用:本会话的评测额度已用完(3/3 次)。\n",
    };
    const run = await runShim({ tool: "evaluate", respond: () => serializeToolResponse(refusal) });
    expect(run.code).toBe(1);
    expect(run.stderr).toBe(refusal.stderr);
  });
});

describe("形态不对的响应:退出码 2,不冒充成功", () => {
  it("不是 JSON 的一行", async () => {
    const run = await runShim({ tool: "check", respond: () => "pong" });
    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("不是协议形状");
  });

  it("缺 `stderr` 字段的一行(哪怕它是合法 JSON)", async () => {
    const run = await runShim({
      tool: "check",
      respond: () => '{"exitCode":0,"result":null,"stdout":"x"}',
    });
    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("不是协议形状");
  });

  it("通道被关掉(宿主没了):退出码 2,不挂住", async () => {
    const run = await runShim({ tool: "check", respond: () => null });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("宿主通道已关闭");
  });
});

describe("没有通道就没有工具", () => {
  it("fd 3 没打开时退出码 2,并说明是通道没开", async () => {
    const run = await runShim({ tool: "check", channel: false });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("宿主通道未打开");
  });
});

/**
 * 信任方向的结构性断言:**沙箱侧写不出自己的响应**。
 *
 * fd 3 是 `socketpair` 的两端之一:沙箱进程往它写的东西到**宿主**去,而它读到的只能是宿主
 * 写回来的东西——写不会回环到自己这一端。所以「薄壳里植入一段、伪造成工具的响应」在物理上
 * 不可行,不需要协议里的任何标记来支撑。这条测试把那个物理事实跑一遍,因为整套配额与「成绩取
 * 最后一次 evaluate 的版本」都建立在它上。
 */
describe("信任方向:沙箱侧伪造不出响应", () => {
  it("写一行「响应形状」的字节到 fd 3,读到的是宿主回的那一行,不是自己写的那一行", async () => {
    const forged = '{"exitCode":0,"result":null,"stdout":"pwned","stderr":""}';
    const script = [
      `printf '%s\\n' '${forged}' >&3`,
      "IFS= read -r reply <&3",
      "printf '%s' \"$reply\"",
    ].join("\n");

    const child = spawn("bash", ["-c", script], { stdio: ["ignore", "pipe", "ignore", "pipe"] });
    const out: Buffer[] = [];
    const stdout = child.stdout;
    if (stdout === null) throw new Error("拿不到 stdout");
    stdout.on("data", (chunk: Buffer) => out.push(chunk));

    const seen: string[] = [];
    const stream = child.stdio[3] as unknown as {
      on(event: "data", listener: (chunk: Buffer) => void): unknown;
      write(chunk: string): boolean;
    };
    /** 宿主写回去的那一行。它是**唯一**的响应来源:沙箱自己写的那一行永远不会回到自己这里。 */
    const hostLine = serializeToolResponse({
      exitCode: 1,
      stdout: "由宿主写的一行\n",
      stderr: "",
    });
    let pending = Buffer.alloc(0);
    stream.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      const newline = pending.indexOf(0x0a);
      if (newline < 0) return;
      seen.push(pending.subarray(0, newline).toString("utf8"));
      // 宿主这边才是「响应方向」:它只往沙箱写,从不把沙箱写来的字节回涌。
      stream.write(`${hostLine}\n`);
    });

    const code = await new Promise<number | null>((resolve) => {
      child.on("close", (value) => resolve(value));
    });

    // 沙箱写出去的那一行到了宿主手里:在宿主眼里它只是一条**请求**。
    expect(seen).toEqual([forged]);
    // 沙箱读回来的那一行是宿主写的那一行。
    expect(Buffer.concat(out).toString("utf8")).toBe(hostLine);
    expect(Buffer.concat(out).toString("utf8")).not.toContain("pwned");
    expect(code).toBe(0);
  });
});
