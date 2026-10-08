/**
 * 失败路径的对外可观察行为(票 05;契约 §3;CONTEXT.md《校验失败记录》)。
 *
 * 断言对象只有**写出的文件与字节、退出码、失败记录的内容**:`failed-<runId>.json` 的形状、
 * 不建存档目录、多模型串行、`--model` 单跑。桩(`stubClient`)是唯一注入缝,离线可跑。
 *
 * ── 为什么失败记录的用例与 `pipeline.test.ts` 不重复 ──
 *
 * `pipeline.test.ts` 盯的是**单模型**的 `ModelOutcome`(分类 / prompts / 日志);本文件盯的是
 * **编排层**落盘:写失败记录、成功与失败并存、串行隔离、过滤。同一条结论在两处出现的角度不同:
 * 前者是「管线判了什么」,后者是「编排层据此写了什么」。
 */

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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RULESET_VERSION } from "@model-war/schema";
import { afterAll, expect, it } from "vitest";
import type { ModelConfig } from "./config.js";
import type { ChatMessage, ModelClient, ModelParams, ModelResponse } from "./model-client.js";
import { runGeneration } from "./run.js";
import { fail, replies, reply, stubClient, type StubStep } from "./stub-client.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const scratch = mkdtempSync(`${tmpdir()}/modelwar-failure-`);
afterAll(() => rmSync(scratch, { force: true, recursive: true }));

const CONTRACT_RULES = "# rules\n\n机制正文:这里是规则契约。\n";
const CONTRACT_API = "# api\n\nAPI 正文:这里是接口契约。\n";
/** 过得了 tsc 与静态校验的最简脚本(成功路径)。 */
const VALID_SCRIPT = `var ticks = 0;\nfunction loop() {\n  ticks += 1;\n  return ticks;\n}\n`;
/** 过不了 tsc(引用未定义名 `missingName` → TS2304)——驱动 `kind: "tsc"` 那一栏。 */
const TSC_FAIL_SCRIPT = `function loop() {\n  return missingName;\n}\n`;
/** 撞上 blocking 违规(禁列全局名 `Date`)——驱动 `kind: "contract"` 那一栏。 */
const BLOCKING_SCRIPT = `function loop() {\n  return Date.now();\n}\nloop();\n`;

/** 把仓库的安装面(编译与校验的依赖)接进临时根(`--root` 在真实使用里就是安装根)。 */
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
const writeRoot = (modelsYaml: string): string => {
  const root = mkdtempSync(`${scratch}/root-`);
  installRuntime(root);
  mkdirSync(join(root, "docs", "rules-v1"), { recursive: true });
  writeFileSync(join(root, "docs", "rules-v1", "rules.md"), CONTRACT_RULES);
  writeFileSync(join(root, "docs", "rules-v1", "api.md"), CONTRACT_API);
  mkdirSync(join(root, "prompts"), { recursive: true });
  writeFileSync(join(root, "prompts", "base.md"), "契约:\n\n{{contract}}\n");
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

/** 只读目录里的唯一那条文件名(多于 / 少于一条即抛,避免测试里写非空断言)。 */
const onlyEntry = (dir: string): string => {
  const entries = readdirSync(dir);
  if (entries.length !== 1) {
    throw new Error(`期望 ${dir} 下恰好一项,收到 ${JSON.stringify(entries)}`);
  }
  return entries[0] as string;
};

/** 读一条失败记录(路径由文件名给全)。 */
const readRecord = (dir: string, name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;

it("用尽轮数:写失败记录(逐轮 prompt 链 + 逐轮日志 + 最终诊断 + 分类),不建存档目录", async () => {
  const root = writeRoot(configOf(entry("alpha", ["    protocolRounds: 2"])));
  const stub = stubClient(replies([BLOCKING_SCRIPT, BLOCKING_SCRIPT]));
  const code = await runGeneration({
    root,
    configPath: "models.yaml",
    createClient: () => stub,
  });
  expect(code).toBe(1);
  expect(stub.calls).toHaveLength(2);

  const slugDir = join(root, "archive", "alpha");
  // 「只有失败记录」:没有 <runId>/ 目录,也没有 .tmp- 残留。
  const name = onlyEntry(slugDir);
  expect(name).toMatch(/^failed-.*\.json$/);

  const record = readRecord(slugDir, name);
  // 形状家契约(迁移后仍成立):键序即书写序——schema `FailureRecord` 的 11 键按此序序列化。
  expect(Object.keys(record)).toEqual([
    "model",
    "modelVersion",
    "generatedAt",
    "runId",
    "ruleset",
    "classification",
    "protocolRounds",
    "prompts",
    "generationLog",
    "diagnostics",
    "message",
  ]);
  // 逐字节纪律:2 空格缩进 + 末尾换行(`writeFailureRecord` 的 `JSON.stringify(record, null, 2)}` + `\n`)。
  const raw = readFileSync(join(slugDir, name), "utf8");
  expect(raw).toBe(`${JSON.stringify(record, null, 2)}\n`);
  expect(record.model).toBe("alpha");
  expect(record.modelVersion).toBe("provider/alpha");
  expect(record.ruleset).toBe(RULESET_VERSION);
  expect(record.classification).toBe("contract");
  // 轮数自洽:已收敛轮数 = prompt 条数 = 日志条数 = 2。
  expect(record.protocolRounds).toBe(2);
  expect(record.prompts).toHaveLength(2);
  expect(record.generationLog).toHaveLength(2);
  // 逐轮 prompt 链:第 1 轮 = 初次生成(含契约),第 2 轮已把上一轮的校验文本追加进来。
  const prompts = record.prompts as readonly string[];
  expect(prompts[0]).toContain(CONTRACT_RULES);
  expect(prompts[1]).toContain("禁列全局名");
  // 逐轮生成日志:两轮都是 contract 驱动,round 依次 1、2。
  const logs = (record.generationLog as readonly string[]).map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  expect(logs.map((log) => log.round)).toEqual([1, 2]);
  expect(logs.every((log) => log.kind === "contract")).toBe(true);
  // 最终诊断是校验器 stdout 的非空行。
  expect((record.diagnostics as readonly string[]).join("\n")).toContain("禁列全局名");
  expect(record.message).toContain("静态校验未通过");
  // runId 与文件名自洽。
  expect(name).toBe(`failed-${String(record.runId)}.json`);
  // 明确:没有一个以 runId 命名的存档目录。
  expect(existsSync(join(slugDir, String(record.runId)))).toBe(false);
});

it("一批两模型一败一成:失败记录与成功三件套并存,退出码非零(tsc 失败)", async () => {
  const root = writeRoot(
    configOf(entry("alpha", ["    protocolRounds: 1"]), entry("beta", ["    protocolRounds: 1"])),
  );
  const alpha = stubClient([reply(TSC_FAIL_SCRIPT)]);
  const beta = stubClient([reply(VALID_SCRIPT)]);
  const code = await runGeneration({
    root,
    configPath: "models.yaml",
    createClient: (config: ModelConfig): ModelClient => (config.slug === "alpha" ? alpha : beta),
  });
  expect(code).toBe(1);

  // 失败者:只有失败记录,分类 tsc,日志 kind=tsc 且带 TS 错误码。
  const alphaDir = join(root, "archive", "alpha");
  const record = readRecord(alphaDir, onlyEntry(alphaDir));
  expect(record.classification).toBe("tsc");
  expect(record.protocolRounds).toBe(1);
  const log = JSON.parse((record.generationLog as readonly string[])[0] as string) as Record<
    string,
    unknown
  >;
  expect(log.kind).toBe("tsc");
  expect(log.errorCodes).toContain("TS2304");
  expect((record.diagnostics as readonly string[]).join("\n")).toContain("TS2304");

  // 成功者:三件套齐。
  const betaDir = join(root, "archive", "beta");
  const betaRun = onlyEntry(betaDir);
  expect(existsSync(join(betaDir, betaRun, "script.ts"))).toBe(true);
  expect(existsSync(join(betaDir, betaRun, "script.js"))).toBe(true);
  expect(existsSync(join(betaDir, betaRun, "meta.json"))).toBe(true);
});

it("一批两模型一败一成:失败记录与成功三件套并存,退出码非零(transport 耗尽)", async () => {
  const root = writeRoot(
    configOf(entry("alpha", ["    protocolRounds: 1"]), entry("beta", ["    protocolRounds: 1"])),
  );
  // 不可重试的错误(缺凭证这类普通 Error)→ 立即收口,不重试、不等待,分类 transport。
  const alpha = stubClient([fail(new Error("缺凭证"))]);
  const beta = stubClient([reply(VALID_SCRIPT)]);
  const code = await runGeneration({
    root,
    configPath: "models.yaml",
    createClient: (config: ModelConfig): ModelClient => (config.slug === "alpha" ? alpha : beta),
  });
  expect(code).toBe(1);

  const alphaDir = join(root, "archive", "alpha");
  const record = readRecord(alphaDir, onlyEntry(alphaDir));
  expect(record.classification).toBe("transport");
  // 传输在某一轮耗尽时那一轮没有结论:已收敛轮数 0,链与日志都空,只有诊断与原因。
  expect(record.protocolRounds).toBe(0);
  expect(record.prompts).toEqual([]);
  expect(record.generationLog).toEqual([]);
  expect((record.diagnostics as readonly string[]).join("\n")).toContain("缺凭证");
  expect(record.message).toContain("传输失败");

  // 成功者照旧冻结。
  const betaDir = join(root, "archive", "beta");
  expect(existsSync(join(betaDir, onlyEntry(betaDir), "meta.json"))).toBe(true);
});

it("`--model` 只跑一个:未选中的模型既不冻结也不写失败记录", async () => {
  const root = writeRoot(
    configOf(entry("alpha", ["    protocolRounds: 2"]), entry("beta", ["    protocolRounds: 1"])),
  );
  const alpha = stubClient(replies([BLOCKING_SCRIPT, BLOCKING_SCRIPT]));
  const beta = stubClient([reply(VALID_SCRIPT)]);
  const code = await runGeneration({
    root,
    configPath: "models.yaml",
    modelFilter: "alpha",
    createClient: (config: ModelConfig): ModelClient => (config.slug === "alpha" ? alpha : beta),
  });
  expect(code).toBe(1);
  expect(alpha.calls).toHaveLength(2);
  // 未被选中的 beta 一次都没被调用,`archive/beta` 也不存在。
  expect(beta.calls).toHaveLength(0);
  expect(existsSync(join(root, "archive", "beta"))).toBe(false);
  expect(onlyEntry(join(root, "archive", "alpha"))).toMatch(/^failed-/);
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

it("多模型串行:一个模型的全部轮次先于另一个模型的第一次调用", async () => {
  const root = writeRoot(
    configOf(entry("alpha", ["    protocolRounds: 2"]), entry("beta", ["    protocolRounds: 2"])),
  );
  // 记录每次 `send` 的顺序(桩在编排层这一侧可见的最早信号):串行时 A 的两轮必须先于 B 的第 1 轮。
  const order: string[] = [];
  const recording = (slug: string, steps: readonly StubStep[]): ModelClient => {
    const inner = stubClient(steps);
    return {
      send: (messages: readonly ChatMessage[], params: ModelParams): Promise<ModelResponse> => {
        order.push(`${slug}:${String(inner.calls.length + 1)}`);
        return inner.send(messages, params);
      },
    };
  };
  const alpha = recording("alpha", replies([BLOCKING_SCRIPT, BLOCKING_SCRIPT]));
  const beta = recording("beta", replies([BLOCKING_SCRIPT, BLOCKING_SCRIPT]));

  const code = await runGeneration({
    root,
    configPath: "models.yaml",
    createClient: (config: ModelConfig): ModelClient => (config.slug === "alpha" ? alpha : beta),
  });
  expect(code).toBe(1);
  expect(order).toEqual(["alpha:1", "alpha:2", "beta:1", "beta:2"]);
});
