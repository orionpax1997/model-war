/**
 * CLI 接线冒烟(Testing Decisions 的既有缝:子进程 + 本地假端点)。
 *
 * spawn **打好的单文件 CLI 产物** `modelwar gen --config models.yaml --root <临时根>`,端点指向
 * `node:http` 起的**本地假服务**(回一个过得了 tsc + 静态校验的合法脚本),`.env` 写在临时根里提供
 * 假凭证;断言退出码 0 + `archive/<slug>/<runId>/` 三件套落地。
 *
 * ── 为什么不改 `cli.test.ts` ──
 *
 * 契约 §6 给 05 留的缝是「补一条 CLI 子进程冒烟」;`cli.test.ts` 的既有断言(帮助文本、未实现路径、
 * match/verify/map-lint e2e)不在本票范围。这里新开一个文件,既不把那条 27KB 的用例集撑得更大,
 * 也让这条冒烟的可观察面(真打一次 HTTP、真编一次 tsc)单独成篇。
 *
 * ── 为什么用异步 `spawn` 而不是 `spawnSync` ──
 *
 * 假端点跑在**本进程**里:`spawnSync` 会阻塞本进程事件循环,子进程的请求就永远等不到响应(死锁)。
 * 所以这里 await 子进程退出的同时让事件循环继续转(端点才能应答)。
 *
 * ── 为什么不在这里再跑一次 `tsc -b` ──
 *
 * `vitest.global-setup.ts` 在任何测试模块加载前已把工作区包的 `dist/` 备齐,esbuild 才解析得到
 * `@model-war/gen` 的 `exports`。再补一次会与 `cli.test.ts` 的 `beforeAll` 并发写同一份 dist。
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { RULESET_VERSION } from "@model-war/schema";
import { afterAll, beforeAll, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const entry = fileURLToPath(new URL("./index.ts", import.meta.url));

const CONTRACT_RULES = "# rules\n\n机制正文:这里是规则契约。\n";
const CONTRACT_API = "# api\n\nAPI 正文:这里是接口契约。\n";
/** 过得了 tsc 与静态校验的最简脚本:假服务的回文本。 */
const VALID_SCRIPT = `var ticks = 0;\nfunction loop() {\n  ticks += 1;\n  return ticks;\n}\n`;

/** 本次冒烟用的假凭证环境变量:取唯一名,避免与宿主已有变量撞车(loadEnvFile 不该依赖覆盖语义)。 */
const CREDENTIAL_ENV_VAR = `GEN_CLI_SMOKE_KEY_${String(Date.now())}`;

let bundle = "";
let scratch = "";

beforeAll(async () => {
  scratch = mkdtempSync(`${tmpdir()}/modelwar-gen-cli-`);
  bundle = `${scratch}/modelwar.mjs`;
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    outfile: bundle,
  });
});

afterAll(() => {
  rmSync(scratch, { force: true, recursive: true });
});

/** 假服务观察到的一次请求。 */
type Captured = {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
};

/**
 * 起一个本地假端点,对任何请求都回一个合法脚本(chat-completions 方言)。返回值里带上收到的请求,
 * 好让断言能钉住「CLI 真的按配置打到了这个端点、带上了鉴权头」。
 */
const startFakeEndpoint = async (): Promise<{
  readonly baseUrl: string;
  readonly requests: readonly Captured[];
  readonly close: () => Promise<void>;
}> => {
  const requests: Captured[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
    });
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        authorization: req.headers.authorization,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            { message: { role: "assistant", content: VALID_SCRIPT }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("假端点没有拿到端口");
  }
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
};

/** 造一个装得上 gen 管线的临时根(与 `gen-archive.test.ts` 同一形态:安装面走符号链接)。 */
const mkRoot = (baseUrl: string): string => {
  const root = mkdtempSync(`${scratch}/root-`);
  symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"), "dir");
  symlinkSync(join(repoRoot, "packages"), join(root, "packages"), "dir");
  symlinkSync(join(repoRoot, "tsconfig.scripts.json"), join(root, "tsconfig.scripts.json"));

  mkdirSync(join(root, "docs", "rules-v1"), { recursive: true });
  writeFileSync(join(root, "docs", "rules-v1", "rules.md"), CONTRACT_RULES);
  writeFileSync(join(root, "docs", "rules-v1", "api.md"), CONTRACT_API);
  mkdirSync(join(root, "prompts"), { recursive: true });
  writeFileSync(join(root, "prompts", "base.md"), "契约:\n\n{{contract}}\n");
  mkdirSync(join(root, "rulesets"), { recursive: true });
  writeFileSync(
    join(root, "rulesets", `${RULESET_VERSION}.json`),
    readFileSync(join(repoRoot, "rulesets", `${RULESET_VERSION}.json`)),
  );
  writeFileSync(
    join(root, "models.yaml"),
    [
      "models:",
      "  - slug: alpha",
      "    endpointFamily: chat-completions",
      `    baseUrl: ${baseUrl}`,
      "    modelId: provider/alpha-1",
      `    credentialEnvVar: ${CREDENTIAL_ENV_VAR}`,
      "    protocolRounds: 1",
      "",
    ].join("\n"),
  );
  // 凭证只从环境变量读;`.env` 只是本机便利(存在才加载),绝不入库。
  writeFileSync(join(root, ".env"), `${CREDENTIAL_ENV_VAR}=smoke-fake-key\n`);
  return root;
};

/** 跑 CLI 子进程到退出;异步等待,让本进程的假端点能应答(见文件头注)。 */
const runCli = (
  args: readonly string[],
): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundle, ...args], { cwd: repoRoot });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });

it("冒烟:假端点后端到端跑通 `gen`,退出 0,存档三件套落地", { timeout: 120_000 }, async () => {
  const endpoint = await startFakeEndpoint();
  try {
    const root = mkRoot(endpoint.baseUrl);
    const result = await runCli(["gen", "--config", "models.yaml", "--root", root]);
    expect(result.status, result.stderr).toBe(0);

    // 真打到了假端点:POST /chat/completions,带上 Bearer 鉴权头。
    expect(endpoint.requests).toHaveLength(1);
    expect(endpoint.requests[0]?.method).toBe("POST");
    expect(endpoint.requests[0]?.path).toBe("/chat/completions");
    expect(endpoint.requests[0]?.authorization).toBe("Bearer smoke-fake-key");

    // 三件套落地(单轮成功)。
    const slugDir = join(root, "archive", "alpha");
    const runIds = readdirSync(slugDir);
    expect(runIds).toHaveLength(1);
    const runId = runIds[0] as string;
    expect(existsSync(join(slugDir, runId, "script.ts"))).toBe(true);
    expect(existsSync(join(slugDir, runId, "script.js"))).toBe(true);
    expect(existsSync(join(slugDir, runId, "meta.json"))).toBe(true);
    // 失败记录不该出现在成功路径里。
    expect(runIds.some((name) => name.startsWith("failed-"))).toBe(false);

    const meta = JSON.parse(readFileSync(join(slugDir, runId, "meta.json"), "utf8")) as {
      protocolRounds: number;
      prompts: readonly string[];
    };
    expect(meta.protocolRounds).toBe(1);
    expect(meta.prompts).toHaveLength(1);
  } finally {
    await endpoint.close();
  }
});
