/**
 * 收工命令 `finish` 的**行为判据**:真 `bash` + 真薄壳 + 真 dispatcher,不起 bwrap。
 *
 * ── 这个文件取代了 `done.test.ts`(块级哨兵) ──
 * 旧判据是「宿主按整行的 `done` 把块切开、切掉后半段」。那条判据有两个死结:一是它与 bash 循环
 * 的收尾 (`for … done`) 撞车,`bash -c` 拿到半截块报语法错误、整场会话报废;二是 `done` 是
 * bash 的**保留字**,裸写一行就是语法错误,薄壳根本不可达——「`done` 是一条命令」这句话在
 * bash 里不成立。于是收工命令改成 `finish`,块不再切,收工由薄壳经通道上报。
 *
 * ── 钉住四件事 ──
 * 1. **块不被切断**:`for … do … done` / `while … done` 整块跑完,退出码 0,每一步的副作用都在;
 * 2. **`finish` 之后的行仍然执行**(这一版的行为放宽,正面断言,用副作用文件证明);
 * 3. **一行 `finish` 就是收工**:薄壳被调用、宿主记下 `finishRequested()`;
 * 4. **改名理由可复算**:裸写一行 `done` 会让整块语法错误、薄壳一次都没被调到。
 *
 * 空块 / 两块 / 非 `bash` 标记仍是拒绝(退出码 64),XML 形状单独一档并进身份清单。
 */

import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { ACTION_REJECT_EXIT_CODE, ACTION_REJECT_REASONS, parseAction } from "../action.js";
import { harnessManifest } from "../identity.js";
import { createSessionTools, type CheckService, type EvaluateService } from "./index.js";

const SHIM_SOURCE = fileURLToPath(new URL("../shim/shim.sh", import.meta.url));

const root = mkdtempSync(join(tmpdir(), "model-war-finish-test-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 把薄壳的字节拷成某个工具名(它靠 `$0` 认自己是谁),供 `PATH` 找。 */
const installShim = (tool: string): string => {
  const dir = mkdtempSync(join(root, `${tool}-`));
  const target = join(dir, tool);
  copyFileSync(SHIM_SOURCE, target);
  chmodSync(target, 0o755);
  return dir;
};

const checkStub: CheckService = async () => ({ exitCode: 0, stdout: "", stderr: "" });
const evaluateStub: EvaluateService = async () => ({ exitCode: 0, stdout: "", stderr: "" });

/** 一个真会话工具面:薄壳打到它,`finishRequested()` 就是生产实现。 */
const session = (): ReturnType<typeof createSessionTools> =>
  createSessionTools({
    workspaceDir: root,
    deadlineAtMs: Date.now() + 60_000,
    check: checkStub,
    evaluate: evaluateStub,
  });

type BlockRun = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly requests: readonly string[];
};

/**
 * 跑一块命令:**真 `bash -c`**,整块原样(宿主不切块),`PATH` 里放真薄壳,fd 3 接到真 dispatcher。
 *
 * 不起 bwrap 的理由与 `shim.test.ts` 相同:这里要判的是「块怎么被解析、薄壳有没有被调到」,
 * 那条路只需要一条 socketpair。真沙箱下的同一条路归 `check:sandbox`。
 */
const runBlock = async (options: {
  readonly block: string;
  readonly path: readonly string[];
  readonly cwd: string;
  readonly tools?: ReturnType<typeof createSessionTools>;
}): Promise<BlockRun> => {
  const child = spawn("bash", ["-c", options.block], {
    cwd: options.cwd,
    env: { ...process.env, PATH: [...options.path, process.env.PATH ?? ""].join(":") },
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (stdout === null || stderr === null) {
    throw new Error("拿不到两路输出:stdio 配置与 Node 的行为不符");
  }
  stdout.on("data", (chunk: Buffer) => out.push(chunk));
  stderr.on("data", (chunk: Buffer) => err.push(chunk));

  const requests: string[] = [];
  const stream = child.stdio[3];
  if (stream === null || stream === undefined) {
    throw new Error("拿不到 fd 3:Node 没有为它建 socketpair");
  }
  if (options.tools !== undefined) {
    const handler = options.tools.requestHandlerFor(1);
    // `stdio[2+]` 在 POSIX 上是双向 socketpair,Node 的类型写成单向流。
    const duplex = stream as unknown as {
      on(event: "data", listener: (chunk: Buffer) => void): unknown;
      write(chunk: string): boolean;
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
        void handler(line).then((response) => duplex.write(`${response}\n`));
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

describe("块不被切断", () => {
  it("`for … do … done`:整块跑完、退出码 0、每一次迭代的副作用都在", async () => {
    const dir = mkdtempSync(join(root, "for-"));
    const run = await runBlock({
      block: [
        "for f in a b c; do",
        '  printf "%s" "$f" >> seq.txt',
        "done",
        'printf "tail" > tail.txt',
      ].join("\n"),
      path: [installShim("finish")],
      cwd: dir,
      tools: session(),
    });
    // 旧世界里收尾的 `done` 被当哨兵,块只剩半截:exit 2 且什么也没写。
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(readFileSync(join(dir, "seq.txt"), "utf8")).toBe("abc");
    expect(existsSync(join(dir, "tail.txt"))).toBe(true);
  });

  it("`while … done`:同一件事,循环读完整个文件", async () => {
    const dir = mkdtempSync(join(root, "while-"));
    writeFileSync(join(dir, "in.txt"), "x\ny\nz\n", "utf8");
    const run = await runBlock({
      block: [
        "while IFS= read -r line; do",
        '  printf "[%s]" "$line" >> seen.txt',
        "done < in.txt",
      ].join("\n"),
      path: [installShim("finish")],
      cwd: dir,
      tools: session(),
    });
    expect(run.code).toBe(0);
    expect(readFileSync(join(dir, "seen.txt"), "utf8")).toBe("[x][y][z]");
  });
});

describe("收工是命令,不是「之后的命令不执行」", () => {
  it("`finish` 之后的行**确实执行**(行为放宽,用副作用文件证明)", async () => {
    const dir = mkdtempSync(join(root, "after-"));
    const tools = session();
    const run = await runBlock({
      block: ["printf 'before' > before.txt", "finish", "printf 'after' > after.txt"].join("\n"),
      path: [installShim("finish")],
      cwd: dir,
      tools,
    });
    expect(run.code).toBe(0);
    expect(existsSync(join(dir, "before.txt"))).toBe(true);
    // 旧语义下这里为 false;这一版是**放宽**:bash 已经解析了整块,之后的行照跑。
    expect(existsSync(join(dir, "after.txt"))).toBe(true);
    // 收工信号仍然成立:宿主收到了那条请求。
    expect(tools.finishRequested()).toBe(true);
    expect(run.requests).toEqual(['{"tool":"finish","args":[]}']);
  });

  it("整块只有一行 `finish`:薄壳被调到、请求上报、退出码 0", async () => {
    const dir = mkdtempSync(join(root, "only-"));
    const tools = session();
    expect(tools.finishRequested()).toBe(false);
    const run = await runBlock({ block: "finish", path: [installShim("finish")], cwd: dir, tools });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
    expect(tools.finishRequested()).toBe(true);
  });

  it("改名理由可复算:裸写一行 `done` 让整块语法错误,薄壳一次都没被调到", async () => {
    const dir = mkdtempSync(join(root, "reserved-"));
    const run = await runBlock({
      block: "printf 'before' > before.txt\ndone\nprintf 'after' > after.txt",
      // 就算把薄壳装成 `done` 放在 PATH 上也没用:bash 在**解析**阶段就把它当保留字拒了。
      path: [installShim("done")],
      cwd: dir,
    });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("done");
    expect(run.requests).toEqual([]);
    // 前一段照跑(按顶层命令逐条解析),之后的一行不跑:这正是「一个正常写法打掉整块」。
    expect(existsSync(join(dir, "before.txt"))).toBe(true);
    expect(existsSync(join(dir, "after.txt"))).toBe(false);
  });
});

describe("被拒的格式:仍然是零执行,退出码不变", () => {
  const rejected = (block: string): ReturnType<typeof parseAction> => parseAction(block);

  it("空回复 / 两块 / 非 bash 标记:三种都被拒,退出码仍是 64", () => {
    expect(rejected("我想先想想。")).toMatchObject({ kind: "reject", reason: "no-block" });
    expect(rejected("```bash\nls\n```\n```bash\nwc -l a\n```")).toMatchObject({
      kind: "reject",
      reason: "multiple-blocks",
    });
    expect(rejected("```ts\nconst x = 1;\n```")).toMatchObject({
      kind: "reject",
      reason: "non-bash",
    });
    expect(ACTION_REJECT_EXIT_CODE).toBe(64);
  });

  it("空块本身不是拒绝:交给 shell 空转,不在解析层猜意图", () => {
    expect(parseAction("```bash\n```")).toEqual({ kind: "ok", command: "" });
  });

  it("XML 工具调用单独一档,并且作为「拒过的形状」进身份清单", () => {
    const parsed = rejected("<tool_call>\n<function=bash>\n</function>\n</tool_call>");
    expect(parsed).toMatchObject({ kind: "reject", reason: "xml-tool-call" });
    expect(harnessManifest().actionSyntax.rejects).toEqual([...ACTION_REJECT_REASONS]);
    expect(harnessManifest().actionSyntax.rejects).toContain("xml-tool-call");
  });
});
