import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import type { ArchiveMeta, FailureRecord, TrialTerminalSummary } from "@model-war/schema";
import { readArchiveReports, runArchiveReport } from "./archive-report.js";

const scratch = mkdtempSync(join(tmpdir(), "modelwar-archive-report-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const rootOf = (): string => mkdtempSync(join(scratch, "root-"));
const writeRecord = (
  root: string,
  kind: "success" | "failure",
  logs: readonly unknown[],
  protocolRounds = logs.length,
  model = "alpha",
): void => {
  const identity = {
    model,
    modelVersion: "snapshot-1",
    generatedAt: "2026-10-12T00:00:00Z",
    ruleset: "v2",
    protocolRounds,
    prompts: Array.from({ length: protocolRounds }, (_, i) => `prompt ${i + 1}`),
    generationLog: logs.map((log) => (typeof log === "string" ? log : JSON.stringify(log))),
  };
  const record: ArchiveMeta | FailureRecord =
    kind === "success"
      ? {
          ...identity,
          validation: { passed: true, errors: [] },
          tscVersion: "7.0.2",
          scriptSha256: "a".repeat(64),
          sandboxRuntimeHash: "b".repeat(64),
        }
      : {
          ...identity,
          runId: "r1",
          classification: "transport",
          diagnostics: ["transport exhausted"],
          message: "传输重试耗尽",
        };
  const dir = join(root, "archive", model, kind === "success" ? "r1" : "");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, kind === "success" ? "meta.json" : "failed-r1.json"),
    JSON.stringify(record),
  );
};

it("归档报告从 meta 的 JSON 字符串日志读取实际轮数与逐轮/合计 sendMs", () => {
  const root = rootOf();
  writeRecord(root, "success", [
    { round: 1, sendMs: 32 },
    { round: 2, sendMs: 68 },
  ]);
  expect(readArchiveReports(root)).toMatchObject([
    {
      kind: "success",
      model: "alpha",
      runId: "r1",
      protocolRounds: 2,
      source: "archive/alpha/r1/meta.json",
      rounds: [
        { round: 1, sendMs: 32 },
        { round: 2, sendMs: 68 },
      ],
      totals: { sendMs: { value: 100, recordedTotal: 100, recordedRounds: 2, expectedRounds: 2 } },
    },
  ]);
});

it("FailureRecord 与成功档用同一读取边界，传输失败只报告已收敛轮次并保留分类与原因", () => {
  const root = rootOf();
  writeRecord(root, "failure", [{ round: 1, sendMs: 21 }]);
  expect(readArchiveReports(root)).toMatchObject([
    {
      kind: "failure",
      model: "alpha",
      runId: "r1",
      protocolRounds: 1,
      source: "archive/alpha/failed-r1.json",
      failure: {
        classification: "transport",
        diagnosticsCount: 1,
      },
      totals: { sendMs: { value: 21 } },
    },
  ]);
});

it("Opus 兼容 usage 的 completion_tokens=3292 不被 output_tokens=0 覆盖，billing 与 cache 明细不重复加总", () => {
  const root = rootOf();
  const usage = {
    prompt_tokens: 27772,
    completion_tokens: 3292,
    total_tokens: 31064,
    usage_semantic: "openai",
    usage_source: "anthropic",
    input_tokens: 27772,
    output_tokens: 0,
    billing_usage: {
      source: "claude_messages",
      semantic: "anthropic",
      claude_usage: {
        input_tokens: 4,
        cache_creation_input_tokens: 27768,
        cache_read_input_tokens: 0,
        output_tokens: 3292,
        cache_creation: { ephemeral_5m_input_tokens: 27768 },
      },
    },
    prompt_tokens_details: {
      cached_tokens: 0,
      cached_creation_tokens: 27768,
      cache_write_tokens: 27768,
    },
    completion_tokens_details: { reasoning_tokens: 0 },
  };
  writeRecord(root, "success", [{ round: 1, sendMs: 32210, usage }]);
  expect(readArchiveReports(root)).toMatchObject([
    {
      rounds: [
        {
          usage: {
            input: { value: 27772, source: "usage.prompt_tokens" },
            output: {
              value: 3292,
              source: "usage.completion_tokens",
              conflict: true,
              candidates: [
                { source: "usage.completion_tokens", value: 3292 },
                { source: "usage.output_tokens", value: 0 },
                { source: "usage.billing_usage.claude_usage.output_tokens", value: 3292 },
              ],
            },
            cacheRead: { value: 0 },
            cacheWrite: { value: 27768 },
            reasoning: { value: 0 },
          },
        },
      ],
      totals: { input: { value: 27772 }, output: { value: 3292 }, cacheWrite: { value: 27768 } },
    },
  ]);
});

it("Haiku 真实字段 output_tokens_details.thinking_tokens 保留 reasoning=13094", () => {
  const root = rootOf();
  // claude-haiku / 2026-10-10T16-31-38-484Z 的最小 usage 字段形状。
  const usage = { output_tokens_details: { thinking_tokens: 13094 } };
  writeRecord(root, "success", [{ round: 1, usage }]);
  expect(readArchiveReports(root)).toMatchObject([
    {
      rounds: [
        {
          usage: {
            reasoning: {
              value: 13094,
              source: "usage.output_tokens_details.thinking_tokens",
              state: "recorded",
              conflict: false,
              candidates: [{ source: "usage.output_tokens_details.thinking_tokens", value: 13094 }],
            },
          },
        },
      ],
      totals: {
        reasoning: { value: 13094, recordedTotal: 13094, recordedRounds: 1, expectedRounds: 1 },
      },
    },
  ]);
});

it("Luna 真实字段 input_tokens_details.cache_write_tokens 保留 cacheWrite=20392", () => {
  const root = rootOf();
  // gpt-6-luna / 2026-10-11T10-23-55-807Z 的最小 usage 字段形状。
  const usage = { input_tokens_details: { cache_write_tokens: 20392 } };
  writeRecord(root, "success", [{ round: 1, usage }]);
  expect(readArchiveReports(root)).toMatchObject([
    {
      rounds: [
        {
          usage: {
            cacheWrite: {
              value: 20392,
              source: "usage.input_tokens_details.cache_write_tokens",
              state: "recorded",
              conflict: false,
              candidates: [
                { source: "usage.input_tokens_details.cache_write_tokens", value: 20392 },
              ],
            },
          },
        },
      ],
      totals: {
        cacheWrite: { value: 20392, recordedTotal: 20392, recordedRounds: 1, expectedRounds: 1 },
      },
    },
  ]);
});

it("旧档、空/部分日志与缺失 sendMs 不伪造零或完整合计，保留可读轮次与坏行", () => {
  const root = rootOf();
  writeRecord(
    root,
    "success",
    [{ round: 1, usage: { prompt_tokens: 10 } }, "legacy text", { round: 3, sendMs: 7 }],
    3,
    "partial",
  );
  writeRecord(root, "failure", [], 0, "empty");
  const reports = readArchiveReports(root);
  expect(reports).toMatchObject([
    {
      model: "empty",
      protocolRounds: 0,
      log: { state: "empty", recordedLines: 0, readableRounds: 0 },
      rounds: [],
      totals: { sendMs: { value: null, recordedTotal: null } },
    },
    {
      model: "partial",
      protocolRounds: 3,
      log: {
        state: "partial",
        recordedLines: 3,
        readableRounds: 2,
        issues: [{ line: 2, reason: "日志行 JSON 不合法" }],
      },
      rounds: [
        { round: 1, sendMs: null },
        { round: 3, sendMs: 7 },
      ],
      totals: {
        sendMs: { value: null, recordedTotal: 7, recordedRounds: 1, expectedRounds: 3 },
        input: { value: null, recordedTotal: 10 },
      },
    },
  ]);
});

it("原生 Anthropic 输入含独立 cache 读写，Responses reasoning 是输出明细；显式 null/缺键/冲突保留来源", () => {
  const root = rootOf();
  writeRecord(
    root,
    "success",
    [
      {
        round: 1,
        usage: {
          input_tokens: 4,
          output_tokens: 9,
          cache_read_input_tokens: 6,
          cache_creation_input_tokens: 10,
          cache_creation: { ephemeral_5m_input_tokens: 10 },
        },
      },
    ],
    1,
    "anthropic",
  );
  writeRecord(
    root,
    "success",
    [
      {
        round: 1,
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          input_tokens_details: { cached_tokens: 40 },
          output_tokens_details: { reasoning_tokens: 20 },
        },
      },
    ],
    1,
    "responses",
  );
  writeRecord(
    root,
    "success",
    [
      {
        round: 1,
        usage: {
          prompt_tokens: 0,
          input_tokens: 3,
          completion_tokens: 5,
          prompt_tokens_details: { cached_creation_tokens: null },
        },
      },
    ],
    1,
    "null",
  );
  expect(readArchiveReports(root)).toMatchObject([
    {
      model: "anthropic",
      rounds: [
        {
          usage: {
            input: {
              value: 20,
              source:
                "usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens",
            },
          },
        },
      ],
      totals: { input: { value: 20 }, cacheRead: { value: 6 }, cacheWrite: { value: 10 } },
    },
    {
      model: "null",
      rounds: [
        {
          usage: {
            input: { value: null, state: "unknown", source: null, conflict: true },
            cacheWrite: {
              value: null,
              state: "null",
              source: "usage.prompt_tokens_details.cached_creation_tokens",
            },
            cacheRead: { value: null, state: "missing", source: null },
            reasoning: { value: null, state: "missing" },
          },
        },
      ],
    },
    {
      model: "responses",
      totals: {
        input: { value: 100 },
        output: { value: 25 },
        cacheRead: { value: 40 },
        reasoning: { value: 20 },
      },
    },
  ]);
});

it("observed-runId 只汇总实际逐场读数；缺文件为缺失、空文件为空，额外回喂前候选不并入", () => {
  const root = rootOf();
  writeRecord(root, "success", [{ round: 1 }], 1, "measured");
  writeRecord(root, "success", [], 1, "old");
  writeRecord(root, "failure", [], 0, "empty");
  writeFileSync(join(root, "archive/empty/observed-r1.jsonl"), "");
  writeFileSync(
    join(root, "archive/measured/observed-r1.jsonl"),
    [
      JSON.stringify({ matchIndex: 0, delivered: 0, captures: 0, noScoreSource: true }),
      JSON.stringify({ matchIndex: 1, delivered: 20, captures: 0, noScoreSource: false }),
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "archive/measured/observed-r1-round-1.jsonl"),
    JSON.stringify({ matchIndex: 0, delivered: 0, captures: 0, noScoreSource: true }),
  );
  expect(readArchiveReports(root)).toMatchObject([
    { model: "empty", observations: { state: "empty", observedMatches: 0, noScoreSource: 0 } },
    {
      model: "measured",
      observations: {
        state: "recorded",
        candidate: "last-completed-trial",
        source: "archive/measured/observed-r1.jsonl",
        observedMatches: 2,
        noScoreSource: 1,
        readings: [
          { matchIndex: 0, delivered: 0, captures: 0, noScoreSource: true },
          { matchIndex: 1, delivered: 20, captures: 0, noScoreSource: false },
        ],
      },
    },
    {
      model: "old",
      observations: { state: "missing", observedMatches: null, noScoreSource: null },
    },
  ]);
});

it("最终与 round 观测拒绝额外键及替换必需键，非法行不计入读数", () => {
  const root = rootOf();
  writeRecord(root, "success", [{ round: 1 }]);
  const valid = { matchIndex: 0, delivered: 0, captures: 0, noScoreSource: true };
  const scored = { matchIndex: 1, delivered: 20, captures: 0, noScoreSource: false };
  const text = [
    JSON.stringify(valid),
    JSON.stringify({ ...scored, extra: "unexpected" }),
    JSON.stringify({ matchIndex: 2, delivered: 0, captures: 0, extra: true }),
    JSON.stringify(scored),
  ].join("\n");
  writeFileSync(join(root, "archive/alpha/observed-r1.jsonl"), text);
  writeFileSync(join(root, "archive/alpha/observed-r1-round-1.jsonl"), text);
  const expected = {
    state: "partial",
    observedMatches: 2,
    noScoreSource: 1,
    readings: [valid, scored],
    issues: [
      { line: 2, reason: "观测行形状不合法" },
      { line: 3, reason: "观测行形状不合法" },
    ],
  };
  expect(readArchiveReports(root)).toMatchObject([
    {
      observations: expected,
      candidateObservations: [{ ...expected, protocolRound: 1 }],
    },
  ]);
});

it("部分观测拒计坏行、重复下标和矛盾 noScoreSource；已读对局计数可见且不伪装完整", () => {
  const root = rootOf();
  writeRecord(root, "success", [{ round: 1 }]);
  const valid = { matchIndex: 0, delivered: 0, captures: 0, noScoreSource: true };
  writeFileSync(
    join(root, "archive/alpha/observed-r1.jsonl"),
    [
      JSON.stringify(valid),
      "truncated",
      JSON.stringify(valid),
      JSON.stringify({ matchIndex: 2, delivered: 20, captures: 0, noScoreSource: true }),
      "",
    ].join("\n"),
  );
  expect(readArchiveReports(root)).toMatchObject([
    {
      observations: {
        state: "partial",
        observedMatches: 1,
        noScoreSource: 1,
        readings: [valid],
        issues: [{ line: 2 }, { line: 3 }, { line: 4 }],
      },
    },
  ]);
});

it("只读 report CLI 从同一归档公共 seam 输出 JSON，--model 只读指定模型", async () => {
  const root = rootOf();
  writeRecord(root, "success", [
    { round: 1, sendMs: 12, usage: { prompt_tokens: 8, completion_tokens: 4 } },
  ]);
  mkdirSync(join(root, "archive/broken/r1"), { recursive: true });
  writeFileSync(join(root, "archive/broken/r1/meta.json"), "bad JSON");
  const stdout: string[] = [];
  const stderr: string[] = [];
  expect(
    await runArchiveReport(["--root", root, "--model", "alpha", "--json"], {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    }),
  ).toBe(0);
  expect(JSON.parse(stdout.join(""))).toMatchObject([
    {
      model: "alpha",
      totals: { sendMs: { value: 12 }, input: { value: 8 }, output: { value: 4 } },
    },
  ]);
  expect(stderr).toEqual([]);
});

it("report 默认 Markdown 展示逐轮/合计、usage 来源冲突与观测候选口径，缺失明确 null", async () => {
  const root = rootOf();
  writeRecord(
    root,
    "failure",
    [
      { round: 1, sendMs: 10, usage: { prompt_tokens: 8, completion_tokens: 4, output_tokens: 0 } },
      { round: 2 },
    ],
    2,
  );
  const stdout: string[] = [];
  expect(
    await runArchiveReport(["--root", root], {
      stdout: (text) => stdout.push(text),
      stderr: () => {},
    }),
  ).toBe(0);
  const md = stdout.join("");
  for (const expected of [
    "# 生成归档报告",
    "archive/alpha/failed-r1.json",
    "协议轮数：2",
    "| 1 | 10 | 8 | null |",
    "| 2 | null | null | null |",
    "已记录小计 10；覆盖 1/2",
    "usage.completion_tokens",
    "usage.output_tokens=0",
    "冲突",
    "null",
    "最后完成试跑",
    "回喂前",
    "不重复加总",
    "失败分类：transport",
  ])
    expect(md).toContain(expected);
});

it("Markdown 各轮与合计都展示 cache/reasoning 和来源/null 状态，并披露后续轮冲突与坏日志", async () => {
  const root = rootOf();
  writeRecord(
    root,
    "success",
    [
      { round: 1, sendMs: 12, usage: { prompt_tokens: 10, completion_tokens: 5 } },
      {
        round: 2,
        sendMs: 20,
        usage: {
          prompt_tokens: 11,
          completion_tokens: 6,
          output_tokens: 0,
          prompt_tokens_details: { cached_tokens: 4, cached_creation_tokens: null },
          completion_tokens_details: { reasoning_tokens: 3 },
        },
      },
      "日志第 3 行",
    ],
    3,
  );
  const output: string[] = [];
  await runArchiveReport(["--root", root], {
    stdout: (text) => output.push(text),
    stderr: () => {},
  });
  const md = output.join("");
  for (const text of [
    "缓存读",
    "缓存写",
    "推理",
    "合计",
    "已记录小计 21",
    "usage.prompt_tokens_details.cached_creation_tokens",
    "null（显式 null）",
    "missing",
    "第 2 轮",
    "usage.output_tokens=0",
    "日志第 3 行",
  ])
    expect(md).toContain(text);
});

it("usage 整体缺键/null/空对象各有状态；原生 Anthropic 缓存缺项不能被当零凑完整输入", () => {
  const root = rootOf();
  writeRecord(
    root,
    "success",
    [
      { round: 1 },
      { round: 2, usage: null },
      { round: 3, usage: {} },
      { round: 4, usage: { input_tokens: 4, cache_read_input_tokens: 6, output_tokens: 2 } },
    ],
    4,
  );
  expect(readArchiveReports(root)).toMatchObject([
    {
      rounds: [
        { usageState: "missing" },
        { usageState: "null" },
        { usageState: "recorded" },
        {
          usage: {
            input: {
              value: null,
              state: "missing",
              source:
                "usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens",
            },
            cacheRead: { value: 6 },
            cacheWrite: { value: null, state: "missing" },
          },
        },
      ],
      totals: {
        input: { value: null, recordedTotal: null },
        output: { value: null, recordedTotal: 2 },
      },
    },
  ]);
});

it("billing_usage-only Anthropic 也可归一，保留嵌套来源且不同缓存时长明细不加第二次", () => {
  const root = rootOf();
  writeRecord(root, "success", [
    {
      round: 1,
      usage: {
        billing_usage: {
          semantic: "anthropic",
          claude_usage: {
            input_tokens: 4,
            cache_read_input_tokens: 6,
            cache_creation_input_tokens: 10,
            output_tokens: 9,
            cache_creation: { ephemeral_5m_input_tokens: 10 },
          },
        },
      },
    },
  ]);
  expect(readArchiveReports(root)).toMatchObject([
    {
      totals: { input: { value: 20 }, output: { value: 9 }, cacheWrite: { value: 10 } },
      rounds: [
        {
          usage: {
            input: {
              value: 20,
              source:
                "usage.billing_usage.claude_usage.input_tokens + usage.billing_usage.claude_usage.cache_read_input_tokens + usage.billing_usage.claude_usage.cache_creation_input_tokens",
            },
            output: { source: "usage.billing_usage.claude_usage.output_tokens" },
          },
        },
      ],
    },
  ]);
});

it("读取器跳过无 meta 的非存档目录；report 错误参数/缺 archive 明确非零，合法空 archive 返回空报告", async () => {
  const root = rootOf();
  mkdirSync(join(root, "archive/alpha/scratch"), { recursive: true });
  expect(readArchiveReports(root)).toEqual([]);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = {
    stdout: (text: string) => stdout.push(text),
    stderr: (text: string) => stderr.push(text),
  };
  expect(await runArchiveReport(["--root", root, "--json"], io)).toBe(0);
  expect(JSON.parse(stdout.join(""))).toEqual([]);
  expect(await runArchiveReport(["--unknown"], io)).toBe(1);
  expect(await runArchiveReport(["--root", rootOf()], io)).toBe(1);
  expect(stderr.join(" ")).toContain("modelwar report:");
});

it("逐协议轮候选观测独立列出；精确 final 只反映最后候选，不累加回喂前读数", () => {
  const root = rootOf();
  writeRecord(root, "success", [{ round: 1 }, { round: 2 }, { round: 3 }]);
  const before = JSON.stringify({ matchIndex: 0, delivered: 0, captures: 0, noScoreSource: true });
  const final = JSON.stringify({ matchIndex: 0, delivered: 20, captures: 1, noScoreSource: false });
  const directory = join(root, "archive/alpha");
  writeFileSync(join(directory, "observed-r1-round-1.jsonl"), before);
  writeFileSync(join(directory, "observed-r1-round-3.jsonl"), final);
  writeFileSync(join(directory, "observed-r1.jsonl"), final);
  writeFileSync(join(directory, "observed-r1-round-4.jsonl"), before);
  writeFileSync(join(directory, "observed-r10-round-2.jsonl"), before);
  expect(readArchiveReports(root)).toMatchObject([
    {
      observations: {
        candidate: "final-candidate",
        protocolRound: 3,
        source: "archive/alpha/observed-r1.jsonl",
        observedMatches: 1,
        noScoreSource: 0,
      },
      candidateObservations: [
        {
          protocolRound: 1,
          state: "recorded",
          source: "archive/alpha/observed-r1-round-1.jsonl",
          observedMatches: 1,
          noScoreSource: 1,
        },
        {
          protocolRound: 3,
          state: "recorded",
          source: "archive/alpha/observed-r1-round-3.jsonl",
          observedMatches: 1,
          noScoreSource: 0,
        },
      ],
    },
  ]);
});

it("input_tokens 缺所有缓存字段时按 semantic 判断总输入；不明口径保留安全数字来源而不补零", () => {
  const root = rootOf();
  const native = {
    input_tokens: 4,
    output_tokens: 9,
    usage_semantic: "anthropic",
    usage_source: "anthropic",
  };
  const ambiguous = { input_tokens: 4, output_tokens: 9 };
  const compatible = {
    input_tokens: 4,
    output_tokens: 9,
    usage_semantic: "openai",
    usage_source: "anthropic",
  };
  writeRecord(root, "success", [
    { round: 1, usage: native },
    { round: 2, usage: ambiguous },
    { round: 3, usage: compatible },
  ]);
  expect(readArchiveReports(root)).toMatchObject([
    {
      rounds: [
        {
          usage: {
            input: {
              value: null,
              state: "missing",
              semantic: "total-input",
              source:
                "usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens",
              candidates: [{ source: "usage.input_tokens", value: 4 }],
            },
            cacheRead: { value: null, state: "missing" },
            cacheWrite: { value: null, state: "missing" },
          },
        },
        {
          usage: {
            input: {
              value: null,
              state: "unknown",
              semantic: "unknown",
              source: "usage.input_tokens",
              candidates: [{ source: "usage.input_tokens", value: 4 }],
            },
          },
        },
        {
          usage: {
            input: {
              value: 4,
              state: "recorded",
              semantic: "total-input",
              source: "usage.input_tokens",
            },
          },
        },
      ],
      totals: { input: { value: null, recordedTotal: 4, recordedRounds: 1, expectedRounds: 3 } },
    },
  ]);
});

it("失败记录也按协议轮保留坏行/空候选观测，旧 final 不因相似或较早 round 被误称最终候选", async () => {
  const root = rootOf();
  const before = JSON.stringify({ matchIndex: 0, delivered: 0, captures: 0, noScoreSource: true });
  writeRecord(root, "failure", [{ round: 1 }, { round: 2 }, { round: 3 }], 3, "failure");
  writeFileSync(join(root, "archive/failure/observed-r1-round-1.jsonl"), before);
  writeFileSync(join(root, "archive/failure/observed-r1-round-2.jsonl"), "");
  writeFileSync(join(root, "archive/failure/observed-r1-round-3.jsonl"), `${before}\nbroken`);
  writeRecord(root, "success", [{ round: 1 }, { round: 2 }], 2, "legacy");
  writeFileSync(join(root, "archive/legacy/observed-r1-round-1.jsonl"), before);
  writeFileSync(join(root, "archive/legacy/observed-r1-round-2.jsonl"), `${before}\nbroken`);
  writeFileSync(join(root, "archive/legacy/observed-r1.jsonl"), before);
  expect(readArchiveReports(root)).toMatchObject([
    {
      model: "failure",
      observations: { state: "missing", candidate: null, protocolRound: null },
      candidateObservations: [
        { protocolRound: 1, state: "recorded", observedMatches: 1, noScoreSource: 1 },
        { protocolRound: 2, state: "empty", observedMatches: 0, noScoreSource: 0 },
        {
          protocolRound: 3,
          state: "partial",
          observedMatches: 1,
          noScoreSource: 1,
          issues: [{ line: 2 }],
        },
      ],
    },
    {
      model: "legacy",
      observations: { candidate: "last-completed-trial", protocolRound: null, observedMatches: 1 },
    },
  ]);
  const stdout: string[] = [];
  expect(
    await runArchiveReport(["--root", root], {
      stdout: (text) => stdout.push(text),
      stderr: () => {},
    }),
  ).toBe(0);
  const md = stdout.join("");
  expect(md).toContain("逐候选观测（不合计）");
  expect(md).toContain(
    "协议轮 3：partial；实际场数 1；noScoreSource 1；来源：archive/failure/observed-r1-round-3.jsonl",
  );
  expect(md).toContain("协议轮 3 观测第 2 行");
  expect(md).toContain("候选标记：last-completed-trial");
});

it("失败记录自带已有候选时分别标识初次/中间候选并核对 hash，最终恒为空", async () => {
  const root = rootOf();
  writeRecord(root, "failure", [{ round: 1 }, { round: 2 }, { round: 3 }, { round: 4 }], 4);
  // 候选 0（round 1）与候选 1（round 2）的独占旁挂；round 3 是预算失败轮，无描述符。
  const js0 = "function loop() { return 0; }\n";
  const js1 = "function loop() { return 1; }\n";
  const sha0 = createHash("sha256").update(js0).digest("hex");
  const sha1 = createHash("sha256").update(js1).digest("hex");
  writeFileSync(join(root, "archive/alpha/observed-r1-round-1.jsonl.candidate.js"), js0);
  writeFileSync(join(root, "archive/alpha/observed-r1-round-2.jsonl.candidate.js"), js1);
  const line = JSON.stringify({
    matchIndex: 0,
    delivered: 0,
    captures: 0,
    noScoreSource: true,
  });
  writeFileSync(join(root, "archive/alpha/observed-r1-round-1.jsonl"), `${line}\n`);
  writeFileSync(join(root, "archive/alpha/observed-r1-round-2.jsonl"), `${line}\n`);
  writeFileSync(join(root, "archive/alpha/observed-r1-round-3.jsonl"), `${line}\n`);
  const path = join(root, "archive/alpha/failed-r1.json");
  const record = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(
    path,
    JSON.stringify({
      ...record,
      candidates: [
        {
          stage: 0,
          protocolRound: 1,
          scriptFile: "observed-r1-round-1.jsonl.candidate.js",
          observationsFile: "observed-r1-round-1.jsonl",
          scriptSha256: sha0,
        },
        {
          stage: 1,
          protocolRound: 2,
          scriptFile: "observed-r1-round-2.jsonl.candidate.js",
          observationsFile: "observed-r1-round-2.jsonl",
          scriptSha256: sha1,
        },
      ],
    }),
  );
  const [report] = readArchiveReports(root);
  expect(report?.kind).toBe("failure");
  expect(report?.initialCandidate).toMatchObject({
    stage: 0,
    protocolRound: 1,
    scriptState: "verified",
    scriptSha256: sha0,
  });
  expect(report?.intermediateCandidates.map((candidate) => candidate.stage)).toEqual([1]);
  expect(report?.finalCandidate).toBeNull();
  // 描述符优先于旧逐轮列表：预算失败的 round 3 不冒充候选。
  expect(report?.candidateObservations.map((candidate) => candidate.protocolRound)).toEqual([1, 2]);
  const stdout: string[] = [];
  expect(
    await runArchiveReport(["--root", root], {
      stdout: (text) => stdout.push(text),
      stderr: () => {},
    }),
  ).toBe(0);
  const md = stdout.join("");
  expect(md).toContain("### 初次候选（协议轮 1）");
  expect(md).toContain("### 中间候选（协议轮 2）");
  expect(md).not.toContain("### 最终候选");
  expect(md).toContain("失败分类");
});

it("排除已写 meta 但尚未 rename 的 .tmp-* staging 目录", () => {
  const root = rootOf();
  writeRecord(root, "success", [{ round: 1, sendMs: 12 }]);
  const staging = join(root, "archive/alpha/.tmp-r2");
  mkdirSync(staging);
  writeFileSync(join(staging, "meta.json"), JSON.stringify({ model: "alpha", protocolRounds: 1 }));
  expect(readArchiveReports(root).map((report) => report.runId)).toEqual(["r1"]);
});

it("metadata model 必须等于枚举 slug，拒绝借其他模型目录读取观测", () => {
  const root = rootOf();
  writeRecord(root, "success", [{ round: 1 }]);
  writeRecord(root, "success", [{ round: 1 }], 1, "beta");
  writeFileSync(
    join(root, "archive/alpha/r1/meta.json"),
    JSON.stringify({ model: "beta", protocolRounds: 1 }),
  );
  writeFileSync(
    join(root, "archive/beta/observed-r1.jsonl"),
    JSON.stringify({ matchIndex: 0, delivered: 9, captures: 0, noScoreSource: false }),
  );
  const issues: { source: string; reason: string }[] = [];
  expect(
    readArchiveReports(root, { model: "alpha", onReadIssue: (issue) => issues.push(issue) }),
  ).toEqual([]);
  expect(issues).toHaveLength(1);
  expect(issues[0]?.source).toBe("archive/alpha/r1/meta.json");
  expect(issues[0]?.reason).toContain("候选身份不合法");
});

it.each(["missing", "unreadable"])(
  "Markdown 的 %s 观测标记无可用观测，不称最后完成试跑",
  async (state) => {
    const root = rootOf();
    writeRecord(root, "success", [{ round: 1 }]);
    if (state === "unreadable") mkdirSync(join(root, "archive/alpha/observed-r1.jsonl"));
    const stdout: string[] = [];
    expect(
      await runArchiveReport(["--root", root], {
        stdout: (text) => stdout.push(text),
        stderr: () => {},
      }),
    ).toBe(0);
    const report = stdout.join("").split("## alpha · success")[1]!;
    expect(report).toContain(`观测状态：${state}`);
    expect(report).toContain("无可用观测：实际场数 null；noScoreSource null");
    expect(report).not.toContain("最后完成试跑");
    expect(readArchiveReports(root)[0]?.observations.candidate).toBeNull();
  },
);

it.each(["{", JSON.stringify({ model: "alpha" })])(
  "单坏 meta %s 不吞其他有效报告，读取 issues 披露来源且不伪造零值记录",
  async (badMeta) => {
    const root = rootOf();
    writeRecord(root, "success", [{ round: 1, sendMs: 17 }]);
    writeRecord(root, "failure", [{ round: 1, sendMs: 23 }], 1, "beta");
    const bad = join(root, "archive/alpha/bad");
    mkdirSync(bad);
    writeFileSync(join(bad, "meta.json"), badMeta);
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(
      await runArchiveReport(["--root", root, "--json"], {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      }),
    ).toBe(1);
    expect(JSON.parse(stdout.join(""))).toMatchObject([
      {
        kind: "success",
        model: "alpha",
        runId: "r1",
        protocolRounds: 1,
        totals: { sendMs: { value: 17 } },
      },
      { kind: "failure", model: "beta", protocolRounds: 1, totals: { sendMs: { value: 23 } } },
    ]);
    expect(stderr.join("")).toContain("archive/alpha/bad/meta.json");
    expect(stderr.join("")).toContain("读取记录失败");
    expect(() => readArchiveReports(root)).toThrow();
    const readIssues: { source: string; reason: string }[] = [];
    expect(
      readArchiveReports(root, { onReadIssue: (issue) => readIssues.push(issue) }),
    ).toHaveLength(2);
    expect(readIssues).toHaveLength(1);
    stdout.length = 0;
    stderr.length = 0;
    expect(
      await runArchiveReport(["--root", root], {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      }),
    ).toBe(1);
    expect(stdout.join("")).toContain("## alpha · success");
    expect(stdout.join("")).toContain("## beta · failure");
    expect(stderr.join("")).toContain("archive/alpha/bad/meta.json");
  },
);

it("无声明语义的冲突 usage 不按路径顺序采值或混入小计，保留原始候选", () => {
  const root = rootOf();
  const ambiguous = {
    prompt_tokens: 10,
    input_tokens: 20,
    completion_tokens: 7,
    output_tokens: 0,
    prompt_tokens_details: { cached_tokens: 3, cached_creation_tokens: 4 },
    input_tokens_details: { cached_tokens: 6, cache_write_tokens: 8 },
    completion_tokens_details: { reasoning_tokens: 2 },
    output_tokens_details: { reasoning_tokens: 5 },
  };
  writeRecord(root, "success", [
    { round: 1, usage: ambiguous },
    { round: 2, usage: { usage_semantic: "openai", prompt_tokens: 11, completion_tokens: 9 } },
  ]);
  const report = readArchiveReports(root)[0]!;
  expect(report.rounds[0]).not.toHaveProperty("rawUsage");
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "reasoning"] as const) {
    expect(report.rounds[0]?.usage[field]).toMatchObject({
      value: null,
      state: "unknown",
      source: null,
      conflict: true,
    });
    expect(report.rounds[0]?.usage[field].candidates).toHaveLength(2);
    expect(report.totals[field].value).toBeNull();
    expect(report.totals[field].recordedRounds).toBe(
      field === "input" || field === "output" ? 1 : 0,
    );
  }
  expect(report.totals.input.recordedTotal).toBe(11);
  expect(report.totals.output.recordedTotal).toBe(9);
  expect(report.totals.cacheRead.recordedTotal).toBeNull();
});

it.each(["openai", "anthropic"])(
  "明确 %s usage 语义优先对应字段，真实零和显式 null 不被其他路径覆盖",
  (semantic) => {
    const root = rootOf();
    const usage = {
      usage_semantic: semantic,
      prompt_tokens: 100,
      input_tokens: 4,
      completion_tokens: 0,
      output_tokens: 9,
      prompt_tokens_details: { cached_tokens: 0, cached_creation_tokens: null },
      cache_read_input_tokens: 6,
      cache_creation_input_tokens: 10,
      completion_tokens_details: { reasoning_tokens: 0 },
      output_tokens_details: { thinking_tokens: 8 },
    };
    writeRecord(root, "success", [{ round: 1, usage }]);
    expect(readArchiveReports(root)[0]?.rounds[0]?.usage).toMatchObject(
      semantic === "openai"
        ? {
            input: { value: 100, source: "usage.prompt_tokens" },
            output: { value: 0, source: "usage.completion_tokens", conflict: true },
            cacheRead: {
              value: 0,
              source: "usage.prompt_tokens_details.cached_tokens",
              conflict: true,
            },
            cacheWrite: {
              value: null,
              state: "null",
              source: "usage.prompt_tokens_details.cached_creation_tokens",
            },
            reasoning: {
              value: 0,
              source: "usage.completion_tokens_details.reasoning_tokens",
              conflict: true,
            },
          }
        : {
            input: {
              value: 20,
              source:
                "usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens",
            },
            output: { value: 9, source: "usage.output_tokens", conflict: true },
            cacheRead: { value: 6, source: "usage.cache_read_input_tokens", conflict: true },
            cacheWrite: { value: 10, source: "usage.cache_creation_input_tokens" },
            reasoning: {
              value: 8,
              source: "usage.output_tokens_details.thinking_tokens",
              conflict: true,
            },
          },
    );
  },
);

const actionFactsOf = () => {
  const errors = {
    ERR_NOT_ENOUGH_RESOURCES: 0,
    ERR_INVALID_UNIT: 0,
    ERR_NOT_OWNER: 0,
    ERR_OUT_OF_RANGE: 0,
    ERR_INVALID_TARGET: 0,
    ERR_INVALID_SITE: 0,
    ERR_BAD_ARGS: 0,
  };
  return {
    version: 1,
    scriptSha256: "a".repeat(64),
    seed: 101,
    seat: 0,
    complete: true,
    observedTicks: 12,
    missingTicks: 0,
    calls: { move: 3, moveTo: 2, attack: 0, harvest: 4, transfer: 1, spawnUnit: 2 },
    errors: {
      move: { ...errors, ERR_BAD_ARGS: 1 },
      moveTo: { ...errors },
      attack: { ...errors },
      harvest: { ...errors },
      transfer: { ...errors },
      spawnUnit: { ...errors, ERR_NOT_ENOUGH_RESOURCES: 1 },
    },
    effects: {
      movedSteps: 2,
      harvestedAmount: 8,
      deliveredAmount: 4,
      captureEvents: 1,
      productionOrdersStarted: 1,
    },
  };
};

it("新版行动事实保留原四栏读数，逐候选独立读取并核对最终编译 JS hash", () => {
  const root = rootOf();
  writeRecord(root, "success", [{ round: 1 }, { round: 2 }]);
  const directory = join(root, "archive/alpha");
  const actionFacts = actionFactsOf();
  const reading = { matchIndex: 0, delivered: 0, captures: 0, noScoreSource: true, actionFacts };
  const final = JSON.stringify(reading);
  writeFileSync(
    join(directory, "observed-r1-round-1.jsonl"),
    JSON.stringify({
      ...reading,
      actionFacts: { ...actionFacts, scriptSha256: "c".repeat(64) },
    }),
  );
  writeFileSync(join(directory, "observed-r1-round-2.jsonl"), final);
  writeFileSync(join(directory, "observed-r1.jsonl"), final);
  expect(readArchiveReports(root)).toMatchObject([
    {
      observations: {
        state: "recorded",
        candidate: "final-candidate",
        protocolRound: 2,
        observedMatches: 1,
        noScoreSource: 1,
        readings: [reading],
        issues: [],
      },
      candidateObservations: [
        { protocolRound: 1, readings: [{ actionFacts: { scriptSha256: "c".repeat(64) } }] },
        { protocolRound: 2, readings: [reading] },
      ],
    },
  ]);
});

it("最终文件与最后 round 相同仍拒绝与 meta 编译 JS hash 不符的事实", () => {
  const root = rootOf();
  writeRecord(root, "success", [{ round: 1 }]);
  const directory = join(root, "archive/alpha");
  const actionFacts = { ...actionFactsOf(), scriptSha256: "c".repeat(64) };
  const text = JSON.stringify({
    matchIndex: 0,
    delivered: 0,
    captures: 0,
    noScoreSource: true,
    actionFacts,
  });
  writeFileSync(join(directory, "observed-r1.jsonl"), text);
  writeFileSync(join(directory, "observed-r1-round-1.jsonl"), text);
  expect(readArchiveReports(root)).toMatchObject([
    {
      observations: {
        state: "partial",
        candidate: "last-completed-trial",
        protocolRound: null,
        readings: [],
        issues: [{ line: 1, reason: "行动事实与 meta 编译 JS hash 不一致" }],
      },
      candidateObservations: [{ protocolRound: 1, state: "recorded", readings: [{ actionFacts }] }],
    },
  ]);
});

it.each([
  ["完整声明与缺失 tick 矛盾", { ...actionFactsOf(), missingTicks: 1 }],
  ["不完整声明却没有缺失 tick", { ...actionFactsOf(), complete: false }],
  [
    "错误总数超过调用数",
    {
      ...actionFactsOf(),
      errors: {
        ...actionFactsOf().errors,
        move: { ...actionFactsOf().errors.move, ERR_BAD_ARGS: 2, ERR_INVALID_UNIT: 2 },
      },
    },
  ],
  ["种子不属于该对局下标", { ...actionFactsOf(), seed: 202 }],
  ["非候选座位", { ...actionFactsOf(), seat: 1 }],
  ["未知版本", { ...actionFactsOf(), version: 2 }],
  ["非法 hash", { ...actionFactsOf(), scriptSha256: "typescript-source" }],
  [
    "缺少公开错误码",
    {
      ...actionFactsOf(),
      errors: { ...actionFactsOf().errors, attack: {} },
    },
  ],
  [
    "额外错误码",
    {
      ...actionFactsOf(),
      errors: {
        ...actionFactsOf().errors,
        move: { ...actionFactsOf().errors.move, ERR_PRIVATE: 0 },
      },
    },
  ],
  ["额外行动", { ...actionFactsOf(), calls: { ...actionFactsOf().calls, findPath: 0 } }],
  ["参数泄漏", { ...actionFactsOf(), parameters: "secret-coordinate" }],
  ["效果额外键", { ...actionFactsOf(), effects: { ...actionFactsOf().effects, x: 42 } }],
  ["负数计数", { ...actionFactsOf(), calls: { ...actionFactsOf().calls, move: -1 } }],
  ["非整数效果", { ...actionFactsOf(), effects: { ...actionFactsOf().effects, movedSteps: 0.5 } }],
  ["不安全整数", { ...actionFactsOf(), observedTicks: Number.MAX_SAFE_INTEGER + 1 }],
  ["零观测却有调用", { ...actionFactsOf(), observedTicks: 0 }],
  ["显式 null", null],
])("报告拒绝%s的行动事实，不将损坏行转成零行动", async (_label, actionFacts) => {
  const root = rootOf();
  writeRecord(root, "success", [{ round: 1 }]);
  const text = JSON.stringify({
    matchIndex: 0,
    delivered: 0,
    captures: 0,
    noScoreSource: true,
    actionFacts,
  });
  const directory = join(root, "archive/alpha");
  writeFileSync(join(directory, "observed-r1.jsonl"), text);
  writeFileSync(join(directory, "observed-r1-round-1.jsonl"), text);
  const report = readArchiveReports(root)[0]!;
  for (const observations of [report.observations, ...report.candidateObservations]) {
    expect(observations.state).toBe("partial");
    expect(observations.readings).toEqual([]);
    expect(observations.issues).toHaveLength(1);
  }
  expect(report.observations.candidate).not.toBe("final-candidate");
  const output: string[] = [];
  await runArchiveReport(["--root", root, "--json"], {
    stdout: (text) => output.push(text),
    stderr: () => {},
  });
  expect(output.join("")).not.toContain("secret-coordinate");
  expect(output.join("")).not.toContain("ERR_PRIVATE");
});

it("同一候选的各对局事实须属于同一编译 JS,不同候选 hash 可不同", () => {
  const root = rootOf();
  writeRecord(root, "failure", [{ round: 1 }, { round: 2 }]);
  const directory = join(root, "archive/alpha");
  const first = {
    matchIndex: 0,
    delivered: 0,
    captures: 0,
    noScoreSource: true,
    actionFacts: actionFactsOf(),
  };
  const other = {
    ...first,
    matchIndex: 1,
    actionFacts: { ...actionFactsOf(), seed: 202, scriptSha256: "c".repeat(64) },
  };
  writeFileSync(
    join(directory, "observed-r1-round-1.jsonl"),
    [first, other].map((line) => JSON.stringify(line)).join("\n"),
  );
  writeFileSync(join(directory, "observed-r1-round-2.jsonl"), JSON.stringify(other));
  expect(readArchiveReports(root)[0]?.candidateObservations).toMatchObject([
    {
      protocolRound: 1,
      state: "partial",
      readings: [first],
      issues: [{ line: 2, reason: "同一候选行动事实的编译 JS hash 不一致" }],
    },
    { protocolRound: 2, state: "recorded", readings: [other], issues: [] },
  ]);
});

it("Markdown 按候选/对局展示覆盖与公开事实,区分快照读数和宿主结算效果", async () => {
  const root = rootOf();
  writeRecord(root, "success", [{ round: 1 }]);
  const directory = join(root, "archive/alpha");
  const text = JSON.stringify({
    matchIndex: 0,
    delivered: 0,
    captures: 0,
    noScoreSource: true,
    actionFacts: actionFactsOf(),
  });
  writeFileSync(join(directory, "observed-r1.jsonl"), text);
  writeFileSync(join(directory, "observed-r1-round-1.jsonl"), text);
  const output: string[] = [];
  await runArchiveReport(["--root", root], {
    stdout: (text) => output.push(text),
    stderr: () => {},
  });
  const md = output.join("");
  for (const expected of [
    "逐候选观测（不合计）",
    "快照读数：delivered=0，captures=0",
    "scriptSha256=" + "a".repeat(64),
    "seed=101",
    "seat=0",
    "complete=true",
    "observedTicks=12，missingTicks=0",
    "调用数（不等于成功）",
    "move=3",
    "harvest=4",
    "公开即时错误",
    "move: ",
    "ERR_BAD_ARGS=1",
    "ERR_NOT_ENOUGH_RESOURCES=1",
    "宿主结算效果",
    "movedSteps=2",
    "harvestedAmount=8",
    "deliveredAmount=4",
    "captureEvents=1",
    "productionOrdersStarted=1",
  ])
    expect(md).toContain(expected);
  expect(md).not.toContain("成功次数");
});

it("不完整事实保留覆盖证据与 JSON 原计数,Markdown 不把已记录零写成零行动", async () => {
  const root = rootOf();
  writeRecord(root, "failure", [{ round: 1 }]);
  const facts = actionFactsOf();
  const incomplete = {
    ...facts,
    complete: false,
    observedTicks: 0,
    missingTicks: 3,
    calls: { move: 0, moveTo: 0, attack: 0, harvest: 0, transfer: 0, spawnUnit: 0 },
    errors: {
      ...facts.errors,
      move: { ...facts.errors.move, ERR_BAD_ARGS: 0 },
      spawnUnit: { ...facts.errors.spawnUnit, ERR_NOT_ENOUGH_RESOURCES: 0 },
    },
  };
  const legacy = { matchIndex: 1, delivered: 0, captures: 0, noScoreSource: true };
  writeFileSync(
    join(root, "archive/alpha/observed-r1-round-1.jsonl"),
    [
      { matchIndex: 0, delivered: 0, captures: 0, noScoreSource: true, actionFacts: incomplete },
      legacy,
    ]
      .map((line) => JSON.stringify(line))
      .join("\n"),
  );
  const report = readArchiveReports(root)[0]!;
  expect(report.candidateObservations[0]).toMatchObject({
    state: "recorded",
    readings: [{ actionFacts: incomplete }, legacy],
  });
  const output: string[] = [];
  await runArchiveReport(["--root", root], {
    stdout: (text) => output.push(text),
    stderr: () => {},
  });
  const md = output.join("");
  expect(md).toContain("complete=false");
  expect(md).toContain("observedTicks=0，missingTicks=3");
  expect(md).toContain("不完整行动事实：计数未展示；缺失不解释为零行动");
  expect(md).toContain("行动事实缺失；缺失不解释为零行动");
  expect(md).not.toContain("move=0");
  expect(md).not.toContain("ERR_BAD_ARGS=0");
  expect(md).not.toContain("deliveredAmount=4");
});

it("损坏观测 JSON 的错误提示不回显原载荷或私有参数", async () => {
  const root = rootOf();
  writeRecord(root, "success", [{ round: 1 }]);
  writeFileSync(join(root, "archive/alpha/observed-r1.jsonl"), "secret-coordinate");
  for (const format of [[], ["--json"]]) {
    const output: string[] = [];
    await runArchiveReport(["--root", root, ...format], {
      stdout: (text) => output.push(text),
      stderr: () => {},
    });
    expect(output.join("")).not.toContain("secret-coordinate");
    expect(output.join("")).toContain("观测行 JSON 不合法");
  }
});

const writeOptimization = (root: string) => {
  writeRecord(root, "success", [{ round: 1 }, { round: 2 }, { round: 3 }, { round: 4 }]);
  const directory = join(root, "archive/alpha");
  const candidates = ([0, 1, 2] as const).map((stage) => {
    const protocolRound = stage + 2;
    const script = `function loop(){ return ${stage}; }\n`;
    const scriptSha256 = createHash("sha256").update(script).digest("hex");
    const observationsFile = `observed-r1-round-${protocolRound}.jsonl`;
    const scriptFile = `${observationsFile}.candidate.js`;
    writeFileSync(join(directory, scriptFile), script);
    writeFileSync(
      join(directory, observationsFile),
      [101, 202, 303]
        .map((seed, matchIndex) =>
          JSON.stringify({
            matchIndex,
            delivered: stage * 10,
            captures: 0,
            noScoreSource: stage === 0,
            actionFacts: { ...actionFactsOf(), scriptSha256, seed },
          }),
        )
        .join("\n") + "\n",
    );
    return { stage, protocolRound, scriptFile, observationsFile, scriptSha256 };
  });
  const metaPath = join(directory, "r1/meta.json");
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  const optimization = { version: 1, feedbackRounds: 2, trialSeeds: [101, 202, 303], candidates };
  writeFileSync(
    metaPath,
    JSON.stringify({ ...meta, scriptSha256: candidates[2]!.scriptSha256, optimization }),
  );
  writeFileSync(
    join(directory, "r1/script.js"),
    readFileSync(join(directory, candidates[2]!.scriptFile)),
  );
  writeFileSync(
    join(directory, "observed-r1.jsonl"),
    readFileSync(join(directory, candidates[2]!.observationsFile)),
  );
  return { directory, metaPath, optimization };
};

it("优化归档按真实 JS hash 单列初次、中间与最终候选，诊断修复不冒充初次候选", async () => {
  const root = rootOf();
  const { optimization } = writeOptimization(root);
  expect(readArchiveReports(root)).toMatchObject([
    {
      initialCandidate: {
        stage: 0,
        protocolRound: 2,
        scriptState: "verified",
        scriptSha256: optimization.candidates[0]!.scriptSha256,
        scriptSource: "archive/alpha/observed-r1-round-2.jsonl.candidate.js",
        observations: {
          source: "archive/alpha/observed-r1-round-2.jsonl",
          state: "recorded",
          observedMatches: 3,
          noScoreSource: 3,
        },
      },
      intermediateCandidates: [
        { stage: 1, protocolRound: 3, observations: { observedMatches: 3, noScoreSource: 0 } },
      ],
      finalCandidate: {
        stage: 2,
        protocolRound: 4,
        scriptState: "verified",
        scriptSha256: optimization.candidates[2]!.scriptSha256,
        observations: {
          source: "archive/alpha/observed-r1-round-4.jsonl",
          state: "recorded",
          observedMatches: 3,
          noScoreSource: 0,
        },
      },
    },
  ]);
  const stdout: string[] = [];
  expect(
    await runArchiveReport(["--root", root], {
      stdout: (text) => stdout.push(text),
      stderr: () => {},
    }),
  ).toBe(0);
  expect(stdout.join("")).toContain("初次候选（协议轮 2）");
  expect(stdout.join("")).toContain("最终候选（协议轮 4）");
  expect(stdout.join("")).toContain(optimization.candidates[0]!.scriptSha256);
  expect(stdout.join("")).toContain(optimization.candidates[2]!.scriptSha256);
});

it.each([
  "missing-observations",
  "missing-script",
  "changed-script",
  "wrong-facts-hash",
  "wrong-seed",
  "wrong-seat",
  "bad-counts",
])("优化候选 %s 明确披露归属问题，不混入初末观测或捏造零值", (problem) => {
  const root = rootOf();
  const { directory, optimization } = writeOptimization(root);
  const first = optimization.candidates[0]!;
  const observationsPath = join(directory, first.observationsFile);
  if (problem === "missing-observations") rmSync(observationsPath);
  else if (problem === "missing-script") rmSync(join(directory, first.scriptFile));
  else if (problem === "changed-script")
    writeFileSync(join(directory, first.scriptFile), "replaced");
  else {
    const rows = readFileSync(observationsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    for (const row of rows) {
      if (problem === "wrong-facts-hash")
        row.actionFacts.scriptSha256 = optimization.candidates[2]!.scriptSha256;
      if (problem === "wrong-seed") row.actionFacts.seed = 999;
      if (problem === "wrong-seat") row.actionFacts.seat = 1;
      if (problem === "bad-counts") row.actionFacts.errors.move.ERR_BAD_ARGS = 4;
    }
    writeFileSync(observationsPath, rows.map((row) => JSON.stringify(row)).join("\n"));
  }
  const report = readArchiveReports(root)[0]!;
  expect(report.finalCandidate).toMatchObject({
    scriptState: "verified",
    observations: { state: "recorded", observedMatches: 3, noScoreSource: 0 },
  });
  expect(report.initialCandidate?.observations.readings).toEqual([]);
  expect(report.initialCandidate?.observations.state).toBe(
    problem === "missing-observations" ? "missing" : "partial",
  );
  expect(report.initialCandidate?.observations.observedMatches).toBe(
    problem === "missing-observations" ||
      problem === "missing-script" ||
      problem === "changed-script"
      ? null
      : 0,
  );
  if (problem !== "missing-observations")
    expect(report.initialCandidate?.observations.issues.length).toBeGreaterThan(0);
});

it.each([
  [
    "路径穿越",
    (meta: {
      scriptSha256: string;
      optimization: ReturnType<typeof writeOptimization>["optimization"];
    }) => {
      meta.optimization.candidates[0]!.scriptFile = "../secret.js";
    },
  ],
  [
    "反斜线路径",
    (meta: {
      scriptSha256: string;
      optimization: ReturnType<typeof writeOptimization>["optimization"];
    }) => {
      meta.optimization.candidates[0]!.observationsFile = "dir\\secret.jsonl";
    },
  ],
  [
    "阶段重复",
    (meta: {
      scriptSha256: string;
      optimization: ReturnType<typeof writeOptimization>["optimization"];
    }) => {
      meta.optimization.candidates[1]!.stage = 0;
    },
  ],
  [
    "轮次倒序",
    (meta: {
      scriptSha256: string;
      optimization: ReturnType<typeof writeOptimization>["optimization"];
    }) => {
      meta.optimization.candidates[1]!.protocolRound = 1;
    },
  ],
  [
    "轮次越界",
    (meta: {
      scriptSha256: string;
      optimization: ReturnType<typeof writeOptimization>["optimization"];
    }) => {
      meta.optimization.candidates[2]!.protocolRound = 5;
    },
  ],
  [
    "最终 hash 不符",
    (meta: {
      scriptSha256: string;
      optimization: ReturnType<typeof writeOptimization>["optimization"];
    }) => {
      meta.scriptSha256 = "c".repeat(64);
    },
  ],
  [
    "共享观测文件",
    (meta: {
      scriptSha256: string;
      optimization: ReturnType<typeof writeOptimization>["optimization"];
    }) => {
      meta.optimization.candidates[1]!.observationsFile =
        meta.optimization.candidates[0]!.observationsFile;
    },
  ],
  [
    "错误试跑 seed",
    (meta: {
      scriptSha256: string;
      optimization: ReturnType<typeof writeOptimization>["optimization"];
    }) => {
      meta.optimization.trialSeeds = [101, 202, 999];
    },
  ],
])("公开报告拒绝 %s 的新优化 manifest", async (_name, mutate) => {
  const root = rootOf();
  const { metaPath } = writeOptimization(root);
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  mutate(meta);
  writeFileSync(metaPath, JSON.stringify(meta));
  const errors: string[] = [];
  expect(
    await runArchiveReport(["--root", root, "--json"], {
      stdout: () => {},
      stderr: (text) => errors.push(text),
    }),
  ).toBe(1);
  expect(errors.join("")).toContain("优化");
});

it("优化档的 round diagnostics 与兼容最终观测不能绕过实际候选 hash 核验", () => {
  const root = rootOf();
  const { directory, optimization } = writeOptimization(root);
  writeFileSync(join(directory, optimization.candidates[0]!.scriptFile), "tampered initial");
  writeFileSync(join(directory, optimization.candidates[2]!.scriptFile), "tampered final");
  const report = readArchiveReports(root)[0]!;
  expect(report.candidateObservations[0]?.readings).toEqual([]);
  expect(report.observations.readings).toEqual([]);
  expect(report.observations.candidate).toBeNull();
});

it("优化档兼容观测的协议轮取最终描述符，不借用包含额外诊断的总轮数", () => {
  const root = rootOf();
  const { metaPath } = writeOptimization(root);
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  meta.protocolRounds = 5;
  meta.prompts.push("diagnostic");
  writeFileSync(metaPath, JSON.stringify(meta));
  expect(readArchiveReports(root)[0]?.observations).toMatchObject({
    candidate: "final-candidate",
    protocolRound: 4,
  });
});

it("优化候选仍兼容旧四栏，越出固定三场范围的下标不能冒充候选试跑", () => {
  const root = rootOf();
  const { directory, optimization } = writeOptimization(root);
  writeFileSync(
    join(directory, optimization.candidates[0]!.observationsFile),
    JSON.stringify({
      matchIndex: 3,
      delivered: 0,
      captures: 0,
      noScoreSource: true,
    }),
  );
  expect(readArchiveReports(root)[0]?.initialCandidate?.observations).toMatchObject({
    state: "partial",
    observedMatches: 0,
    readings: [],
    issues: [{ line: 1 }],
  });
});

it("所有公开出口对白名单外旧日志/失败载荷保密，包括已知 token 字段中的非数字", async () => {
  const root = rootOf();
  const secret = "PRIVATE_PROVIDER_PROMPT_CREDENTIAL";
  const usage = {
    prompt_tokens: secret,
    completion_tokens: { prompt: secret },
    input_tokens: [secret],
    output_tokens: 7,
    credential: secret,
    unknownNumeric: 98237423,
    prompt_tokens_details: { cached_tokens: secret, cached_creation_tokens: { body: secret } },
    output_tokens_details: { reasoning_tokens: secret, thinking_tokens: { message: secret } },
    billing_usage: { claude_usage: { output_tokens: secret, input_tokens: secret } },
  };
  writeRecord(
    root,
    "failure",
    [
      {
        round: 1,
        usage,
        prompt: secret,
        response: secret,
        rawUsage: { body: secret },
        finishReason: secret,
        stopDetails: { status: secret, reason: secret },
        params: {
          stop: secret,
          logit_bias: { [secret]: 100 },
          max_tokens: 100,
          reasoning: { effort: "high", body: secret },
        },
        requestEvidence: {
          configId: secret,
          backendIdentity: secret,
          diagnostics: [secret],
          credential: secret,
          endpointFamily: "chat-completions",
          policy: {
            endpoint: {
              family: "chat-completions",
              official: { status: "documented", source: secret },
              channel: { status: "accepted", source: secret },
            },
            reasoning: {
              intent: "high",
              control: "unverified",
              official: { status: secret },
              channel: { status: "unverified", source: secret },
            },
            output: { field: "server-default", includesReasoning: "unknown", source: secret },
          },
          transport: { authentication: "bearer", apiKey: secret, anthropicVersion: secret },
        },
        attemptEvidence: [
          {
            attempt: 1,
            outcome: "response",
            usage,
            stopDetails: { reason: secret },
            message: secret,
          },
          {
            attempt: 2,
            outcome: "transport-error",
            usage,
            message: secret,
            stopDetails: { reason: secret },
          },
          { attempt: 3, outcome: secret, usage },
        ],
      },
      `broken ${secret}`,
      { round: 1, usage },
    ],
    1,
  );
  const path = join(root, "archive/alpha/failed-r1.json");
  const failure = JSON.parse(readFileSync(path, "utf8"));
  failure.prompts = [secret];
  failure.diagnostics = [secret, { message: secret }];
  failure.message = secret;
  failure.classification = secret;
  writeFileSync(path, JSON.stringify(failure));
  const report = readArchiveReports(root)[0]!;
  const serialized = JSON.stringify(report);
  expect(serialized).not.toContain(secret);
  expect(serialized).not.toContain("98237423");
  expect(serialized).not.toContain("rawUsage");
  expect(report.failure).toEqual({ classification: "unknown", diagnosticsCount: 2 });
  expect(report.rounds[0]).toMatchObject({
    requestEvidence: { configId: "alpha", configIdMatches: false, backendIdentity: "unverified" },
    params: {
      values: { max_tokens: 100, reasoning: { effort: "high" } },
      samplingBiasConfigured: true,
    },
    usage: { output: { value: null }, input: { value: null } },
    stop: { reason: { value: null, state: "unknown" } },
    attemptCoverage: "partial",
    attempts: [{ attempt: 1 }, { attempt: 2, usage: { output: { value: null } } }],
  });
  for (const format of [[], ["--json"]]) {
    const output: string[] = [];
    expect(
      await runArchiveReport(["--root", root, ...format], {
        stdout: (text) => output.push(text),
        stderr: (text) => output.push(text),
      }),
    ).toBe(0);
    expect(output.join("")).not.toContain(secret);
    expect(output.join("")).not.toContain("rawUsage");
  }
  // 记录本身损坏时回调、抛错和 CLI stderr 也不暴露 JSON.parse 的原文片段。
  writeFileSync(path, `{"prompt":"${secret}"`);
  const issues: unknown[] = [];
  expect(readArchiveReports(root, { onReadIssue: (issue) => issues.push(issue) })).toEqual([]);
  expect(JSON.stringify(issues)).not.toContain(secret);
  expect(() => readArchiveReports(root)).toThrow("记录 JSON");
  for (const format of [[], ["--json"]]) {
    const output: string[] = [];
    expect(
      await runArchiveReport(["--root", root, ...format], {
        stdout: (text) => output.push(text),
        stderr: (text) => output.push(text),
      }),
    ).toBe(1);
    expect(output.join("")).not.toContain(secret);
  }
});

it("规范未收敛 transport 末行保留尝试用量但不增加收敛轮数/收敛合计", async () => {
  const root = rootOf();
  writeRecord(
    root,
    "failure",
    [
      {
        round: 1,
        sendMs: 10,
        usage: { prompt_tokens: 8, completion_tokens: 4 },
        responseConverged: true,
        finishReason: "stop",
        attemptEvidence: [
          { attempt: 1, outcome: "response", usage: { prompt_tokens: 8, completion_tokens: 4 } },
        ],
      },
      {
        round: 2,
        kind: "transport",
        responseConverged: false,
        sendMs: 30,
        usage: { prompt_tokens: 999 },
        finishReason: "stop", // untrusted extra fields are ignored
        attemptEvidence: [
          {
            attempt: 1,
            outcome: "response",
            finishReason: "length",
            stopDetails: { status: "incomplete", reason: "max_output_tokens" },
            usage: { prompt_tokens: 12, completion_tokens: 5 },
          },
          { attempt: 2, outcome: "transport-error" },
        ],
      },
    ],
    1,
  );
  const [report] = readArchiveReports(root);
  expect(report).toMatchObject({
    protocolRounds: 1,
    log: { state: "complete", recordedLines: 2, readableRounds: 1, issues: [] },
    budget: {
      model: {
        convergedResponses: 1,
        recordedAttempts: 3,
        attemptEvidenceRounds: 2,
        expectedAttemptEvidenceRounds: 2,
        responseAttemptsWithUsage: 2,
        transportErrors: 1,
        unknownConsumptionAttempts: 1,
      },
    },
    totals: { sendMs: { value: 10 }, input: { value: 8 }, output: { value: 4 } },
    rounds: [
      { responseConverged: true },
      {
        round: 2,
        responseConverged: false,
        sendMs: 30,
        usageState: "missing",
        usage: { input: { value: null } },
        stop: { finishReason: { value: null, state: "missing" } },
        attempts: [
          {
            stop: { status: { value: "incomplete" }, reason: { value: "max_output_tokens" } },
            usage: { input: { value: 12 } },
          },
          { usage: { input: { value: null } } },
        ],
      },
    ],
  });
  const output: string[] = [];
  await runArchiveReport(["--root", root], {
    stdout: (text) => output.push(text),
    stderr: () => {},
  });
  expect(output.join("")).toContain("第 2 轮：未收敛 transport 尝试");
  expect(output.join("")).toContain("消费未知");
  expect(output.join("")).not.toContain("999");
});

it.each(["wrong-round", "not-last", "success", "converged"])(
  "非法 transport %s 不冒充收敛响应",
  (problem) => {
    const root = rootOf();
    const transport = {
      round: problem === "wrong-round" ? 3 : 2,
      kind: "transport",
      responseConverged: problem === "converged",
      sendMs: 99,
    };
    writeRecord(
      root,
      problem === "success" ? "success" : "failure",
      [{ round: 1, sendMs: 10 }, transport, ...(problem === "not-last" ? ["broken"] : [])],
      1,
    );
    const [report] = readArchiveReports(root);
    expect(report?.log.state).toBe("partial");
    expect(report?.rounds).toHaveLength(1);
    expect(report?.totals.sendMs.value).toBe(10);
  },
);

it("缺少本轮标识不把历史失败认作本轮失败，明确标识后分开计数同模型成功/失败", async () => {
  const root = rootOf();
  writeRecord(root, "failure", [], 0);
  const failurePath = join(root, "archive/alpha/failed-r1.json");
  const failed = JSON.parse(readFileSync(failurePath, "utf8"));
  rmSync(failurePath);
  writeFileSync(
    join(root, "archive/alpha/failed-old.json"),
    JSON.stringify({ ...failed, runId: "old" }),
  );
  writeRecord(root, "success", [{ round: 1 }]);
  writeRecord(root, "failure", [], 0, "beta");
  expect(readArchiveReports(root).every((report) => report.runScope === "unscoped")).toBe(true);
  expect(readArchiveReports(root, { runId: "r1" })).toMatchObject([
    { model: "alpha", kind: "failure", runId: "old", runScope: "historical" },
    { model: "alpha", kind: "success", runId: "r1", runScope: "current-run" },
    { model: "beta", kind: "failure", runId: "r1", runScope: "current-run" },
  ]);
  const output: string[] = [];
  await runArchiveReport(["--root", root, "--run-id", "r1"], {
    stdout: (text) => output.push(text),
    stderr: () => {},
  });
  expect(output.join("")).toContain("本轮：成功记录 1；失败记录 1");
  expect(output.join("")).toContain("历史：成功记录 0；失败记录 1");
});

// 手算 timeout：存活方 10/6/6 分排名 1/2/2；淘汰候选仍有两骑兵 32 造价、5 分但第4名。
const terminalSummaryOf = (seed = 101): TrialTerminalSummary => ({
  version: 1,
  seed,
  tick: 12,
  reason: "timeout",
  weights: { baseScore: 4, resourceScore: 1, unitCostDivisor: 6 },
  unitCosts: { worker: 4, melee: 8, ranged: 12, cavalry: 16 },
  rankPoints: [3, 2, 1, 0],
  players: [
    {
      seat: 0,
      player: "candidate",
      controlledBases: 0,
      controlledResources: 0,
      survivingUnits: { worker: 0, melee: 0, ranged: 0, cavalry: 2 },
      survivingUnitCost: 32,
      score: { bases: 0, resources: 0, units: 5 },
      territoryScore: 5,
      rank: 4,
      rankPoints: 0,
      alive: false,
      eliminatedAtTick: 7,
    },
    {
      seat: 1,
      player: "cell-a-melee-pressure",
      controlledBases: 1,
      controlledResources: 1,
      survivingUnits: { worker: 2, melee: 0, ranged: 0, cavalry: 0 },
      survivingUnitCost: 8,
      score: { bases: 4, resources: 1, units: 1 },
      territoryScore: 6,
      rank: 2,
      rankPoints: 1.5,
      alive: true,
      eliminatedAtTick: null,
    },
    {
      seat: 2,
      player: "cell-b-expansion-economy",
      controlledBases: 1,
      controlledResources: 1,
      survivingUnits: { worker: 2, melee: 0, ranged: 0, cavalry: 0 },
      survivingUnitCost: 8,
      score: { bases: 4, resources: 1, units: 1 },
      territoryScore: 6,
      rank: 2,
      rankPoints: 1.5,
      alive: true,
      eliminatedAtTick: null,
    },
    {
      seat: 3,
      player: "cell-c-claim-no-harvest",
      controlledBases: 2,
      controlledResources: 1,
      survivingUnits: { worker: 2, melee: 0, ranged: 0, cavalry: 0 },
      survivingUnitCost: 8,
      score: { bases: 8, resources: 1, units: 1 },
      territoryScore: 10,
      rank: 1,
      rankPoints: 3,
      alive: true,
      eliminatedAtTick: null,
    },
  ],
});

it("公开报告在没有行动事实时仍完整展示真实终局、四方结果和计分审计", async () => {
  const root = rootOf();
  writeRecord(root, "failure", [{ round: 1 }]);
  const summary = terminalSummaryOf();
  const line = {
    matchIndex: 0,
    delivered: 0,
    captures: 0,
    noScoreSource: true,
    terminalSummary: summary,
  };
  for (const name of ["observed-r1.jsonl", "observed-r1-round-1.jsonl"])
    writeFileSync(join(root, "archive/alpha", name), JSON.stringify(line));
  const report = readArchiveReports(root)[0]!;
  for (const observations of [report.observations, ...report.candidateObservations]) {
    expect(observations.state).toBe("recorded");
    expect(observations.readings).toEqual([line]);
  }
  const json: string[] = [];
  expect(
    await runArchiveReport(["--root", root, "--json"], {
      stdout: (text) => json.push(text),
      stderr: () => {},
    }),
  ).toBe(0);
  expect(JSON.parse(json.join(""))[0].candidateObservations[0].readings[0].terminalSummary).toEqual(
    summary,
  );
  const markdown: string[] = [];
  expect(
    await runArchiveReport(["--root", root], {
      stdout: (text) => markdown.push(text),
      stderr: () => {},
    }),
  ).toBe(0);
  const md = markdown.join("");
  for (const expected of [
    "终局事实 v1",
    "seed=101",
    "tick=12（已执行 tick 数／下一 tick 编号）",
    "reason=timeout",
    "baseScore=4",
    "resourceScore=1",
    "unitCostDivisor=6",
    "单位造价：worker=4；melee=8；ranged=12；cavalry=16",
    "名次积分表：3/2/1/0",
    "seat=0；player=candidate",
    "seat=1；player=cell-a-melee-pressure",
    "seat=2；player=cell-b-expansion-economy",
    "seat=3；player=cell-c-claim-no-harvest",
    "controlledBases=0；controlledResources=0",
    "controlledBases=2；controlledResources=1",
    "survivingUnits：worker=0；melee=0；ranged=0；cavalry=2",
    "survivingUnitCost=32",
    "score：bases=0；resources=0；units=5",
    "territoryScore=5；rank=4；rankPoints=0；alive=false；eliminatedAtTick=7",
    "territoryScore=6；rank=2；rankPoints=1.5；alive=true；eliminatedAtTick=null",
    "territoryScore=10；rank=1；rankPoints=3",
    "行动事实缺失",
  ])
    expect(md).toContain(expected);
});

it("公开报告将旧终局明确标未知而不补零，行动覆盖不完整仍展示独立的真实终局", async () => {
  const root = rootOf();
  writeRecord(root, "failure", [{ round: 1 }]);
  const legacy = { matchIndex: 0, delivered: 0, captures: 0, noScoreSource: true };
  const row = {
    ...legacy,
    matchIndex: 1,
    actionFacts: { ...actionFactsOf(), seed: 202, complete: false, missingTicks: 1 },
    terminalSummary: terminalSummaryOf(202),
  };
  writeFileSync(
    join(root, "archive/alpha/observed-r1-round-1.jsonl"),
    [legacy, row].map((value) => JSON.stringify(value)).join("\n"),
  );
  expect(readArchiveReports(root)[0]?.candidateObservations[0]?.readings).toEqual([legacy, row]);
  const output: string[] = [];
  await runArchiveReport(["--root", root], {
    stdout: (text) => output.push(text),
    stderr: () => {},
  });
  const md = output.join("");
  expect(md).toContain("终局事实未知；缺失不解释为零分、零名次积分或未淘汰。");
  expect(md).toContain("终局事实 v1：seed=202");
  expect(md).toContain("不完整行动事实：计数未展示");
  const legacySection = md.split("对局下标 0")[1]!.split("对局下标 1")[0]!;
  expect(legacySection).not.toContain("territoryScore=");
  expect(legacySection).not.toContain("rankPoints=");
  expect(legacySection).not.toContain("alive=");
});

it("公开报告拒绝形状合法但终局计分矛盾的摘要，不将其标记为完整候选观测", async () => {
  const root = rootOf();
  const { directory, optimization } = writeOptimization(root);
  const candidate = optimization.candidates[2]!;
  const invalid = terminalSummaryOf();
  const text = JSON.stringify({
    matchIndex: 0,
    delivered: 0,
    captures: 0,
    noScoreSource: true,
    terminalSummary: {
      ...invalid,
      players: [{ ...invalid.players[0], territoryScore: 999 }, ...invalid.players.slice(1)],
    },
  });
  writeFileSync(join(directory, candidate.observationsFile), text);
  writeFileSync(join(directory, "observed-r1.jsonl"), text);
  const report = readArchiveReports(root)[0]!;
  for (const observations of [
    report.finalCandidate!.observations,
    report.observations,
    report.candidateObservations.at(-1)!,
  ]) {
    expect(observations.state).toBe("partial");
    expect(observations.readings).toEqual([]);
    expect(observations.issues).toHaveLength(1);
  }
  expect(report.observations.candidate).not.toBe("final-candidate");
  for (const format of [[], ["--json"]]) {
    const output: string[] = [];
    await runArchiveReport(["--root", root, ...format], {
      stdout: (text) => output.push(text),
      stderr: () => {},
    });
    expect(output.join("")).not.toContain("999");
  }
});

// 公开报告接缝的畸形输入回归；只看安全读数与公开 JSON/Markdown，不测私有 helper。
const terminalWithPlayer = (seat: number, fields: Record<string, unknown>) => {
  const summary = terminalSummaryOf();
  return {
    ...summary,
    players: summary.players.map((player, index) =>
      index === seat ? { ...player, ...fields } : player,
    ),
  };
};
it.each<[string, unknown]>([
  [
    "shortcut四方仍存活",
    {
      ...terminalSummaryOf(),
      reason: "shortcut",
      players: terminalSummaryOf().players.map((player) => ({
        ...player,
        alive: true,
        eliminatedAtTick: null,
        rank: [4, 2, 2, 1][player.seat],
        rankPoints: [0, 1.5, 1.5, 3][player.seat],
      })),
    },
  ],
  ["victory非胜者仍控点", { ...terminalSummaryOf(), reason: "victory" }],
  [
    "淘汰方仍控基地",
    terminalWithPlayer(0, {
      controlledBases: 1,
      score: { bases: 4, resources: 0, units: 5 },
      territoryScore: 9,
    }),
  ],
  [
    "淘汰方仍控资源点",
    terminalWithPlayer(0, {
      controlledResources: 1,
      score: { bases: 0, resources: 1, units: 5 },
      territoryScore: 6,
    }),
  ],
  [
    "completed零tick",
    {
      ...terminalSummaryOf(),
      tick: 0,
      players: terminalSummaryOf().players.map((player) => ({
        ...player,
        alive: true,
        eliminatedAtTick: null,
      })),
    },
  ],
  ...[0, 1].map((aliveCount): [string, unknown] => [
    `timeout仅${String(aliveCount)}方存活`,
    {
      ...terminalSummaryOf(),
      players: terminalSummaryOf().players.map((player) => ({
        ...player,
        controlledBases: 0,
        controlledResources: 0,
        score: { bases: 0, resources: 0, units: player.score.units },
        territoryScore: player.score.units,
        alive: player.seat < aliveCount,
        eliminatedAtTick: player.seat < aliveCount ? null : 7,
        rank: aliveCount === 1 && player.seat > 0 ? 2 : 1,
        rankPoints: aliveCount === 1 ? (player.seat === 0 ? 3 : 1) : 1.5,
      })),
    },
  ]),
  [
    "victory胜者也无控点",
    {
      ...terminalSummaryOf(),
      reason: "victory",
      players: terminalSummaryOf().players.map((player) => ({
        ...player,
        controlledBases: 0,
        controlledResources: 0,
        score: { bases: 0, resources: 0, units: player.score.units },
        territoryScore: player.score.units,
        rank: [4, 1, 2, 2][player.seat],
        rankPoints: [0, 3, 1.5, 1.5][player.seat],
      })),
    },
  ],
  ["null", null],
  ["部分摘要", { version: 1, seed: 101 }],
  ["未知版本", { ...terminalSummaryOf(), version: 2 }],
  ["未知原因", { ...terminalSummaryOf(), reason: "HOST_SECRET_TERMINAL" }],
  ["seed错配", terminalSummaryOf(202)],
  ["额外顶层载荷", { ...terminalSummaryOf(), raw: "HOST_SECRET_TERMINAL" }],
  [
    "额外权重载荷",
    {
      ...terminalSummaryOf(),
      weights: { ...terminalSummaryOf().weights, raw: "HOST_SECRET_TERMINAL" },
    },
  ],
  [
    "额外造价载荷",
    {
      ...terminalSummaryOf(),
      unitCosts: { ...terminalSummaryOf().unitCosts, raw: "HOST_SECRET_TERMINAL" },
    },
  ],
  ["额外玩家载荷", terminalWithPlayer(0, { raw: "HOST_SECRET_TERMINAL" })],
  [
    "额外单位载荷",
    terminalWithPlayer(0, {
      survivingUnits: {
        ...terminalSummaryOf().players[0].survivingUnits,
        raw: "HOST_SECRET_TERMINAL",
      },
    }),
  ],
  [
    "额外计分载荷",
    terminalWithPlayer(0, {
      score: { ...terminalSummaryOf().players[0].score, raw: "HOST_SECRET_TERMINAL" },
    }),
  ],
  ["缺一方", { ...terminalSummaryOf(), players: terminalSummaryOf().players.slice(1) }],
  ["缺积分位次", { ...terminalSummaryOf(), rankPoints: [3, 2, 1] }],
  ["座位重复", terminalWithPlayer(1, { seat: 0 })],
  ["候选身份错配", terminalWithPlayer(0, { player: "host-secret-terminal" })],
  ["基准身份错配", terminalWithPlayer(1, { player: "host-secret-terminal" })],
  ["单位造价矛盾", terminalWithPlayer(0, { survivingUnitCost: 31 })],
  ["基地分矛盾", terminalWithPlayer(1, { score: { bases: 5, resources: 1, units: 1 } })],
  ["资源分矛盾", terminalWithPlayer(1, { score: { bases: 4, resources: 2, units: 1 } })],
  ["单位分矛盾", terminalWithPlayer(1, { score: { bases: 4, resources: 1, units: 2 } })],
  ["存活有淘汰时间", terminalWithPlayer(1, { eliminatedAtTick: 0 })],
  ["淘汰无时间", terminalWithPlayer(0, { eliminatedAtTick: null })],
  ["淘汰时间等于已执行tick", terminalWithPlayer(0, { eliminatedAtTick: 12 })],
  ["假competition名次", terminalWithPlayer(2, { rank: 3 })],
  ["假并列积分", terminalWithPlayer(2, { rankPoints: 2 })],
  ["全淘汰却仍存活", { ...terminalSummaryOf(), reason: "all-eliminated" }],
  [
    "胜者已淘汰",
    { ...terminalWithPlayer(3, { alive: false, eliminatedAtTick: 11 }), reason: "victory" },
  ],
  [
    "零除数",
    { ...terminalSummaryOf(), weights: { ...terminalSummaryOf().weights, unitCostDivisor: 0 } },
  ],
  ["负数计数", terminalWithPlayer(0, { controlledBases: -1 })],
  ["小数计数", terminalWithPlayer(0, { controlledResources: 0.5 })],
  ["不安全整数", { ...terminalSummaryOf(), tick: Number.MAX_SAFE_INTEGER + 1 }],
  [
    "单位乘法溢出",
    {
      ...terminalSummaryOf(),
      unitCosts: { ...terminalSummaryOf().unitCosts, cavalry: Number.MAX_SAFE_INTEGER },
    },
  ],
  [
    "基地乘法溢出",
    {
      ...terminalSummaryOf(),
      weights: { ...terminalSummaryOf().weights, baseScore: Number.MAX_SAFE_INTEGER },
    },
  ],
  [
    "积分计算溢出",
    {
      ...terminalSummaryOf(),
      rankPoints: [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 1, 0],
    },
  ],
])("公开报告拒绝%s的终局事实且不泄漏载荷", async (_label, summary) => {
  const root = rootOf();
  writeRecord(root, "failure", [{ round: 1 }]);
  writeFileSync(
    join(root, "archive/alpha/observed-r1-round-1.jsonl"),
    JSON.stringify({
      matchIndex: 0,
      delivered: 0,
      captures: 0,
      noScoreSource: true,
      terminalSummary: summary,
    }),
  );
  const observations = readArchiveReports(root)[0]!.candidateObservations[0]!;
  expect(observations).toMatchObject({ state: "partial", readings: [], observedMatches: 0 });
  expect(observations.issues).toHaveLength(1);
  for (const format of [[], ["--json"]]) {
    const output: string[] = [];
    expect(
      await runArchiveReport(["--root", root, ...format], {
        stdout: (text) => output.push(text),
        stderr: () => {},
      }),
    ).toBe(0);
    expect(output.join("")).not.toMatch(/HOST_SECRET_TERMINAL|host-secret-terminal|territoryScore/);
  }
});

it.each(["victory", "shortcut", "all-eliminated"] as const)(
  "公开报告保存%s的真实排序，胜者优先及淘汰时间不改成领土分排名",
  async (reason) => {
    const root = rootOf();
    writeRecord(root, "failure", [{ round: 1 }]);
    const summary = terminalSummaryOf();
    const players = summary.players.map((player) => {
      if (reason === "all-eliminated")
        return {
          ...player,
          controlledBases: 0,
          controlledResources: 0,
          score: { bases: 0, resources: 0, units: player.score.units },
          territoryScore: player.score.units,
          alive: false,
          eliminatedAtTick: [7, 9, 9, 11][player.seat],
        };
      // victory 的非胜者已无点位；更高领土分来自残留兵力，shortcut 可保留淘汰兵力。
      const survivingUnits =
        player.seat === 2
          ? { worker: 0, melee: 0, ranged: 0, cavalry: 3 }
          : player.seat === 3
            ? { worker: 0, melee: 0, ranged: 0, cavalry: 4 }
            : player.survivingUnits;
      const survivingUnitCost = [32, 8, 48, 64][player.seat]!;
      const score =
        player.seat === 1
          ? player.score
          : { bases: 0, resources: 0, units: [5, 1, 8, 10][player.seat]! };
      const alive = player.seat === 1 || (reason === "victory" && player.seat > 1);
      return {
        ...player,
        controlledBases: player.seat === 1 ? 1 : 0,
        controlledResources: player.seat === 1 ? 1 : 0,
        survivingUnits,
        survivingUnitCost,
        score,
        territoryScore: player.seat === 1 ? 6 : score.units,
        alive,
        eliminatedAtTick: alive ? null : [7, 0, 9, 11][player.seat],
        rank: [4, 1, 3, 2][player.seat],
        rankPoints: [0, 3, 1, 2][player.seat],
      };
    });
    const terminalSummary = { ...summary, reason, players };
    writeFileSync(
      join(root, "archive/alpha/observed-r1-round-1.jsonl"),
      JSON.stringify({
        matchIndex: 0,
        delivered: 0,
        captures: 0,
        noScoreSource: true,
        terminalSummary,
      }),
    );
    expect(readArchiveReports(root)[0]!.candidateObservations[0]!).toMatchObject({
      state: "recorded",
      readings: [{ terminalSummary }],
    });
    const output: string[] = [];
    await runArchiveReport(["--root", root], {
      stdout: (text) => output.push(text),
      stderr: () => {},
    });
    expect(output.join("")).toContain(`reason=${reason}`);
    expect(output.join("")).toContain(
      reason === "all-eliminated"
        ? "territoryScore=1；rank=2；rankPoints=1.5；alive=false；eliminatedAtTick=9"
        : "territoryScore=6；rank=1；rankPoints=3；alive=true；eliminatedAtTick=null",
    );
  },
);

it("终局摘要可展示但不放宽完整候选的脚本身份与固定seed边界", () => {
  const root = rootOf();
  const { directory, optimization } = writeOptimization(root);
  const candidate = optimization.candidates[2]!;
  const rows = [101, 202, 303].map((seed, matchIndex) => ({
    matchIndex,
    delivered: 0,
    captures: 0,
    noScoreSource: true,
    terminalSummary: terminalSummaryOf(seed),
  }));
  const text = rows.map((row) => JSON.stringify(row)).join("\n");
  writeFileSync(join(directory, candidate.observationsFile), text);
  writeFileSync(join(directory, "observed-r1.jsonl"), text);
  expect(readArchiveReports(root)[0]!).toMatchObject({
    observations: { candidate: "final-candidate", readings: rows },
    finalCandidate: {
      scriptState: "verified",
      observations: { state: "recorded", readings: rows },
    },
  });
  writeFileSync(join(directory, candidate.scriptFile), "changed candidate bytes");
  expect(readArchiveReports(root)[0]!).toMatchObject({
    observations: { candidate: null, state: "partial", readings: [] },
    finalCandidate: { scriptState: "mismatch" },
  });
});
