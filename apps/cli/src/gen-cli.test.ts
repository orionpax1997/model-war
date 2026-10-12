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
/**
 * 起一个本地假端点，对任何请求都回 `scriptText`（缺省是过 tsc + 静态校验的合法脚本）。
 */
const startFakeEndpoint = async (
  scriptText: string = VALID_SCRIPT,
): Promise<{
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
          choices: [{ message: { role: "assistant", content: scriptText }, finish_reason: "stop" }],
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
  // 真试跑（冻结期最后一栏）从安装根读入口产物、地图与基准对手：三处符号链接，
  // 与编译/校验走安装面的fixture 纪律一致（只读，不写回仓库）。
  symlinkSync(join(repoRoot, "apps"), join(root, "apps"), "dir");
  symlinkSync(join(repoRoot, "maps"), join(root, "maps"), "dir");
  symlinkSync(join(repoRoot, "benchmarks"), join(root, "benchmarks"), "dir");

  mkdirSync(join(root, "docs", "rules-v2"), { recursive: true });
  writeFileSync(join(root, "docs", "rules-v2", "rules.md"), CONTRACT_RULES);
  writeFileSync(join(root, "docs", "rules-v2", "api.md"), CONTRACT_API);
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

/** 读回试跑观测文件（`archive/<slug>/observed-<runId>.jsonl`）的每一行；形状由入口那一侧写。 */
type ObservationRow = {
  readonly matchIndex: number;
  readonly delivered: number;
  readonly captures: number;
  readonly noScoreSource: boolean;
};

const readObservationLines = (path: string): readonly ObservationRow[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ObservationRow);

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

it("冒烟:假端点后端到端跑通 `gen`，退出 0，存档三件套落地", { timeout: 120_000 }, async () => {
  const endpoint = await startFakeEndpoint();
  try {
    const root = mkRoot(endpoint.baseUrl);
    const result = await runCli(["gen", "--config", "models.yaml", "--root", root]);
    expect(result.status, result.stderr).toBe(0);

    // 真打到了假端点：POST /chat/completions，带上 Bearer 鉴权头。
    expect(endpoint.requests).toHaveLength(1);
    expect(endpoint.requests[0]?.method).toBe("POST");
    expect(endpoint.requests[0]?.path).toBe("/chat/completions");
    expect(endpoint.requests[0]?.authorization).toBe("Bearer smoke-fake-key");

    // 三件套落地（单轮成功）。存档目录里除目录外只有那份观测文件（旁挂，不进三件套）。
    const slugDir = join(root, "archive", "alpha");
    const entries = readdirSync(slugDir, { withFileTypes: true });
    const runIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const sidecars = entries.filter((entry) => !entry.isDirectory()).map((entry) => entry.name);
    expect(runIds).toHaveLength(1);
    const runId = runIds[0] as string;
    // 失败记录不该出现在成功路径里。
    expect(runIds.some((name) => name.startsWith("failed-"))).toBe(false);
    expect(sidecars).toEqual([`observed-${runId}.jsonl`]);
    expect(existsSync(join(slugDir, runId, "script.ts"))).toBe(true);
    expect(existsSync(join(slugDir, runId, "script.js"))).toBe(true);
    expect(existsSync(join(slugDir, runId, "meta.json"))).toBe(true);

    const meta = JSON.parse(readFileSync(join(slugDir, runId, "meta.json"), "utf8")) as {
      protocolRounds: number;
      prompts: readonly string[];
    };
    expect(meta.protocolRounds).toBe(1);
    expect(meta.prompts).toHaveLength(1);

    // 试跑观测落地：三场各一行（这个候选整局无所作为，三场都命中「无得分来源」）。
    // 这是「留痕进得去 gen 的记录」那一条的接线断言——不落盘，这条缺口就还在。
    const observations = readObservationLines(join(slugDir, `observed-${runId}.jsonl`));
    expect(observations).toHaveLength(3);
    expect(observations.map((line) => line.matchIndex)).toEqual([0, 1, 2]);
    expect(
      observations.every(
        (line) => line.noScoreSource && line.delivered === 0 && line.captures === 0,
      ),
    ).toBe(true);
  } finally {
    await endpoint.close();
  }
});

/** 死循环惯犯：过得了 tsc 与静态校验，但每 tick 必然触碰事件计数上限。 */
const HABITUAL_SCRIPT = `function loop() {\n  while (true) {\n  }\n}\n`;

it(
  "试跑拦下惯犯:死循环脚本退出非零,失败记录分类 contract 且诊断含试跑明细",
  { timeout: 120_000 },
  async () => {
    const endpoint = await startFakeEndpoint(HABITUAL_SCRIPT);
    try {
      const root = mkRoot(endpoint.baseUrl);
      const result = await runCli(["gen", "--config", "models.yaml", "--root", root]);
      // 冻结失败 → 非零退出（早停：首场首 tick 即拦，不必跑满三场）。
      expect(result.status, result.stderr).toBe(1);

      // 不建存档目录，只留失败记录（旁证）+ 试跑观测，且记录指明是试跑拦的。
      const slugDir = join(root, "archive", "alpha");
      const names = readdirSync(slugDir);
      const failureName = names.find((name) => name.startsWith("failed-")) as string;
      expect(names).toEqual(expect.arrayContaining([failureName]));
      const record = JSON.parse(readFileSync(join(slugDir, failureName), "utf8")) as {
        runId: string;
        classification: string;
        diagnostics: readonly string[];
        message: string;
      };
      expect(record.classification).toBe("contract");
      expect(record.message).toContain("试跑");
      const diagnostics = record.diagnostics.join("\n");
      expect(diagnostics).toContain("试跑未通过");
      expect(diagnostics).toContain("控制流事件计数");

      // 被拦下的候选同样留观测（旁证不挑结论）：runId 与失败记录同源，行数 = 跑过的场数
      // （首场首 tick 即拦 → 早停，后面两场没跑，也就没有读数）。
      expect(names).toContain(`observed-${record.runId}.jsonl`);
      const observations = readObservationLines(join(slugDir, `observed-${record.runId}.jsonl`));
      expect(observations).toHaveLength(1);
      expect(observations[0]?.matchIndex).toBe(0);
    } finally {
      await endpoint.close();
    }
  },
);
