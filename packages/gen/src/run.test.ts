import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RULESET_VERSION } from "@model-war/schema";
import { afterAll, expect, it } from "vitest";
import type { ModelConfig } from "./config.js";
import type { ModelClient } from "./model-client.js";
import { generateAndFreeze, runGeneration } from "./run.js";
import { fail, reply, stubClient, type StubClient } from "./stub-client.js";
import { terminalSummaryFixture } from "./terminal-summary.fixture.js";
import { gridPlanFixture } from "./trial-plan.fixture.js";

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const scratch = mkdtempSync(`${tmpdir()}/modelwar-run-`);
afterAll(() => rmSync(scratch, { force: true, recursive: true }));

const CONTRACT_RULES = "# rules\n\n机制正文:这里是规则契约。\n";
const CONTRACT_API = "# api\n\nAPI 正文:这里是接口契约。\n";
/** 一份能过编译与静态校验的最简参赛脚本(回文本要真的能进存档)。 */
const VALID_SCRIPT = `var ticks = 0;\nfunction loop() {\n  ticks += 1;\n  return ticks;\n}\n`;

/**
 * 把仓库的安装面(编译与校验的依赖)接进临时根:`--root` 在真实使用里就是安装根。
 * 用符号链接而不是拷贝,让 fixture 与仓库同源。
 */
const installRuntime = (root: string): void => {
  symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"), "dir");
  symlinkSync(join(repoRoot, "packages"), join(root, "packages"), "dir");
  symlinkSync(join(repoRoot, "tsconfig.scripts.json"), join(root, "tsconfig.scripts.json"));
  mkdirSync(join(root, "rulesets"), { recursive: true });
  writeFileSync(
    join(root, "rulesets", `${RULESET_VERSION}.json`),
    readFileSync(join(repoRoot, "rulesets", `${RULESET_VERSION}.json`)),
  );
};

/** 造一个临时根:契约两份文档 + `prompts/base.md` + `models.yaml` + 安装面。 */
const writeRoot = (modelsYaml: string, baseTemplate = "契约:\n\n{{contract}}\n"): string => {
  const root = mkdtempSync(`${scratch}/root-`);
  installRuntime(root);
  mkdirSync(join(root, "docs", "rules-v2"), { recursive: true });
  writeFileSync(join(root, "docs", "rules-v2", "rules.md"), CONTRACT_RULES);
  writeFileSync(join(root, "docs", "rules-v2", "api.md"), CONTRACT_API);
  mkdirSync(join(root, "prompts"), { recursive: true });
  writeFileSync(join(root, "prompts", "base.md"), baseTemplate);
  writeFileSync(join(root, "models.yaml"), modelsYaml);
  return root;
};

/** 一条模型条目的 YAML(缩进正确的若干行)。 */
const entry = (slug: string, extra: readonly string[] = []): readonly string[] => [
  `  - slug: ${slug}`,
  "    endpointFamily: chat-completions",
  "    baseUrl: https://example.test/v1",
  `    modelId: provider/${slug}`,
  "    credentialEnvVar: GEN_TEST_KEY",
  ...extra,
];

const configOf = (...entries: readonly (readonly string[])[]): string =>
  ["models:", ...entries.flat()].join("\n") + "\n";

// 说明：本文件凡真的走到编译 / 试跑的用例都显式放宽超时。`unit` project 没有全局
// `testTimeout`（默认 5s），而一条用例要真跑 tsc、真写契约与安装面符号链接；全量并发下
// 这些耗时会被同时跑的重用例抬高（实测单跑 1s 的用例在全量里能到 5s 以上）。
it("顺利路径:经端口发一次请求、回得合法脚本,退出码 0", { timeout: 30_000 }, async () => {
  const root = writeRoot(configOf(entry("alpha")));
  const stub = stubClient([reply(VALID_SCRIPT)]);
  const code = await runGeneration({
    root,
    configPath: "models.yaml",
    createClient: () => stub,
    trial: () => ({ passed: true, stdout: "" }),
  });
  expect(code).toBe(0);
  expect(stub.calls).toHaveLength(1);
});

it("一次调用发出的 messages 含完整契约与模板渲染结果(user 角色)", { timeout: 30_000 }, async () => {
  // 本用例只关心第 1 轮发出的 prompt 形状;钉死单轮,避免桩脚本用尽干扰。
  const root = writeRoot(configOf(entry("alpha", ["    protocolRounds: 1"])));
  const stub = stubClient([reply("x")]);
  await runGeneration({ root, configPath: "models.yaml", createClient: () => stub });
  const call = stub.calls[0];
  expect(call?.messages).toHaveLength(1);
  expect(call?.messages[0]?.role).toBe("user");
  const content = call?.messages[0]?.content ?? "";
  expect(content).toContain(CONTRACT_RULES);
  expect(content).toContain(CONTRACT_API);
  expect(content).toContain("契约:");
});

it("配置里的 strategy 进 prompt;params 透传给端口", { timeout: 30_000 }, async () => {
  const root = writeRoot(
    configOf(
      entry("alpha", [
        "    strategy: 占点不采集",
        "    protocolRounds: 1",
        "    params:",
        "      temperature: 0.2",
      ]),
    ),
    "策略:{{strategy}}\n\n契约:\n\n{{contract}}\n",
  );
  const stub = stubClient([reply("x")]);
  await runGeneration({ root, configPath: "models.yaml", createClient: () => stub });
  expect(stub.calls[0]?.messages[0]?.content).toContain("占点不采集");
  expect(stub.calls[0]?.params).toEqual({ temperature: 0.2 });
});

it(
  "模型没配 strategy 时,发出的 prompt 不留 `{{strategy}}` 也不留空占位",
  { timeout: 30_000 },
  async () => {
    const root = writeRoot(
      configOf(entry("alpha", ["    protocolRounds: 1"])),
      "策略:{{strategy}}\n\n{{contract}}\n",
    );
    const stub = stubClient([reply("x")]);
    await runGeneration({ root, configPath: "models.yaml", createClient: () => stub });
    const content = stub.calls[0]?.messages[0]?.content ?? "";
    expect(content).not.toContain("{{strategy}}");
    expect(content).not.toContain("策略:");
    expect(content).toContain(CONTRACT_RULES);
  },
);

it("`--model` 只跑选中的那一个,其余模型不发请求", { timeout: 30_000 }, async () => {
  const root = writeRoot(configOf(entry("alpha"), entry("beta")));
  const alpha = stubClient([reply(VALID_SCRIPT)]);
  const beta = stubClient([reply(VALID_SCRIPT)]);
  const code = await runGeneration({
    root,
    configPath: "models.yaml",
    modelFilter: "beta",
    createClient: (config: ModelConfig): ModelClient => (config.slug === "beta" ? beta : alpha),
    trial: () => ({ passed: true, stdout: "" }),
  });
  expect(code).toBe(0);
  expect(beta.calls).toHaveLength(1);
  expect((alpha as StubClient).calls).toHaveLength(0);
});

it("`--model` 指向未登记的 slug 即报错(不静默跑零个)", async () => {
  const root = writeRoot(configOf(entry("alpha")));
  await expect(
    runGeneration({
      root,
      configPath: "models.yaml",
      modelFilter: "nope",
      createClient: () => stubClient([]),
    }),
  ).rejects.toThrow(/没有 slug 为 "nope"/);
});

it("单模型失败不吞:退出码非零", async () => {
  const root = writeRoot(configOf(entry("alpha")));
  const stub = stubClient([fail(new Error("429 rate limited"))]);
  const code = await runGeneration({ root, configPath: "models.yaml", createClient: () => stub });
  expect(code).toBe(1);
});

it("契约目录缺失即报错(不内嵌副本降级)", async () => {
  const root = writeRoot(configOf(entry("alpha")));
  rmSync(join(root, "docs"), { force: true, recursive: true });
  await expect(
    runGeneration({ root, configPath: "models.yaml", createClient: () => stubClient([]) }),
  ).rejects.toThrow(/找不到规则契约目录/);
});

it("`generateAndFreeze` 缺 `--config` 即非零退出", async () => {
  expect(await generateAndFreeze([])).toBe(1);
});

it("`generateAndFreeze` 拿到未知参数即非零退出", async () => {
  expect(await generateAndFreeze(["--bogus", "x"])).toBe(1);
});

it("`generateAndFreeze` 解析出 root 后加载 `<root>/.env`(存在才加载)", async () => {
  const root = writeRoot(configOf(entry("alpha")));
  const key = `MW_GEN_TEST_ENV_${String(Date.now())}`;
  writeFileSync(join(root, ".env"), `${key}=loaded\n`);
  try {
    // 默认客户端是真实 HTTP 客户端(`packages/gen/src/http/client.ts`,此处未接假端点)
    // → 每个模型失败 → 非零;但 `.env` 已在跑管线之前加载。
    const code = await generateAndFreeze(["--root", root, "--config", "models.yaml"]);
    expect(code).toBe(1);
    expect(process.env[key]).toBe("loaded");
  } finally {
    delete process.env[key];
  }
});

it(
  "runGeneration 显式选项贯通：两次事实优化后第三个有效候选冻结",
  { timeout: 30_000 },
  async () => {
    const root = writeRoot(configOf(entry("alpha", ["    protocolRounds: 3"])));
    const stub = stubClient([reply(VALID_SCRIPT), reply(VALID_SCRIPT), reply(VALID_SCRIPT)]);
    const code = await runGeneration({
      root,
      configPath: "models.yaml",
      createClient: () => stub,
      scoreSourceFeedback: true,
      // 计划与观测都按注入桩来：真 `--plan` 要读本地冻结档案（`archive/` 不入库）。
      trialPlan: () => gridPlanFixture(),
      trial: ({ artifactPath, observationsPath, plan }) => {
        if (plan === undefined) throw new Error("试跑桩需要计划");
        const readings = plan.matches.map((match) => ({
          matchIndex: match.matchIndex,
          delivered: 0,
          captures: 0,
          noScoreSource: true,
          terminalSummary: terminalSummaryFixture(match.seed, "timeout", match.seats),
        }));
        writeFileSync(
          observationsPath,
          readings.map((row) => JSON.stringify(row)).join("\n") + "\n",
        );
        writeFileSync(
          `${observationsPath}.grid.json`,
          JSON.stringify({
            version: plan.version,
            plan,
            // 汇总说的是这份候选脚本（执行器认编译产物字节）。
            scriptSha256: sha256(readFileSync(artifactPath)),
            // 桩写的终局是四方并列 rank 1（`terminalSummaryFixture` 的 timeout 口径）：
            // 每场各得 (3+2+1+0)/4 = 1.5 名次积分 → 32 场共 48 分，均分仍是 1.5。
            // 分母恒等于计划声明的场数，不因零交付而缩小（生成侧只验形状，不重算分数）。
            score: {
              totalPoints: 48,
              averagePoints: 1.5,
              countedMatches: plan.matchesPerCandidate,
            },
            matches: plan.matches.map((match) => ({
              matchIndex: match.matchIndex,
              seed: match.seed,
              candidateSeat: match.candidateSeat,
              map: match.map,
              mapSha256: match.mapSha256,
            })),
          }),
        );
        return { passed: true, stdout: "" };
      },
    });
    expect(code).toBe(0);
    expect(stub.calls).toHaveLength(3);
  },
);

it.each([{ flags: [] }, { flags: ["--select-best-candidate"] }])(
  "gen CLI 接受事实反馈与选拔无值开关 %j 并继续读取配置",
  async ({ flags }) => {
    const root = mkdtempSync(`${scratch}/cli-opt-in-`);
    const messages: string[] = [];
    const original = process.stderr.write;
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      messages.push(String(chunk));
      return true;
    };
    try {
      expect(
        await generateAndFreeze([
          "--score-source-feedback",
          ...flags,
          "--root",
          root,
          "--config",
          "missing.yaml",
        ]),
      ).toBe(1);
      expect(messages.join("")).toContain("missing.yaml");
      expect(messages.join("")).not.toContain("未知参数");
    } finally {
      process.stderr.write = original;
    }
  },
);

it("CLI 选拔开关要求事实反馈，在读配置与首次请求前报错", async () => {
  const code = await generateAndFreeze([
    "--config",
    "absent.yaml",
    "--root",
    scratch,
    "--select-best-candidate",
  ]);
  expect(code).toBe(1);
});

it(
  "网格执行失败（预算触限用尽）即整批失败：不建存档目录，失败记录就位",
  { timeout: 30_000 },
  async () => {
    const root = writeRoot(configOf(entry("alpha")));
    // 五轮各回一份字节不同的候选：每一轮都是一次**新的**候选尝试（棋格被拦下，不是同一份字节
    // 换轮次）。复用来源池只收录“已通过”的阶段（`pipeline.ts` 的 `acceptedGrids`），本用例
    // 没有任何阶段通过，所以池子始终为空——即便五轮回同一份字节也不会被复用。字节各异
    // 是为了让“五次尝试 = 五份不同候选”在用例里成立，而不是靠同一份字节凑数。
    const stub = stubClient(
      Array.from({ length: 5 }, (_, index) =>
        reply(
          `var ticks = 0;\nfunction loop() {\n  ticks += ${String(index + 2)};\n  return ticks;\n}\n`,
        ),
      ),
    );
    const code = await runGeneration({
      root,
      configPath: "models.yaml",
      createClient: () => stub,
      scoreSourceFeedback: true,
      trialPlan: () => gridPlanFixture(),
      // 网格执行失败（预算触限）：pipeline 归 `contract` / `trial` 段，五轮响应用尽即整批失败。
      trial: () => ({ passed: false, stdout: "预算诊断\n" }),
    });
    expect(code).toBe(1);
    expect(stub.calls).toHaveLength(5);
    const archived = readdirSync(join(root, "archive", "alpha"));
    // 没有存档目录：`<runId>/` 那样的目录一个都不该有（失败的尝试只留下候选旁挂文件）。
    expect(archived.filter((name) => /^\d{4}-\d{2}-\d{2}T/.test(name))).toEqual([]);
    const records = archived.filter((name) => name.startsWith("failed-"));
    expect(records).toHaveLength(1);
    const record = JSON.parse(
      readFileSync(join(root, "archive", "alpha", records[0]!), "utf8"),
    ) as {
      classification: string;
      message: string;
      protocolRounds: number;
    };
    expect(record.classification).toBe("contract");
    expect(record.message).toContain("冻结期试跑未通过");
    expect(record.protocolRounds).toBe(5);
  },
);
