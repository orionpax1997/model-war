/**
 * 档案形状**两版并认**（v3 与 v4）：读兼容、v3 不迁移、v4 的逐字字节那一格。
 *
 * ── 三组判据 ──
 *
 * 1. **v3 真档照旧读得出来**：`fixtures/archive/v3-glyph-cluster/` 是 `archive/glyph-cluster/
 *    2026-11-19T11-29-52-739Z` 的瘦身副本（来源与改写清单见 fixtures 的 README）。它是 v3 的
 *    12 步 `bash` + 3 步 `evaluate`、`termination: wall-clock`——报告读出的每一格都该与改之前
 *    逐字相同，因为**读侧不该因为写侧换代而改口径**。
 * 2. **v4 档读得出来，而 `toolCall` 是逐字字节**：`fixtures/archive/v4-tool-call/` 里第一步的
 *    `argumentsJson` 用 `\u003c` 转义、第五步带多余空格，两者都与 `action.command` 解析后的值
 *    **不同形**。报告必须按 `argumentsJson` 原样给出，不得按 `action.command` 重编码。
 * 3. **v3 档不许出现 v4 才有的形状**：塞一条 `{kind:"check"}` 的步、或给某个步挂 `toolCall`，
 *    装载期拒读并**点名**（`check` / `toolCall`），而不是笼统的「形状不合法」。
 *
 * 第三组是「v3 不许有 check」这条验收的落点：JSON Schema 收的是**并集**（`if/then` 在 runner 的
 * `z.fromJSONSchema` 上不支持，两套并排进 `oneOf` 又会同时命中），所以按版本的排除写在装载期，
 * 见 `archiveShapeIssuesOf` 的 `archive-step-shape`。
 */

import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, expect, it } from "vitest";

import { readArchiveReports, runArchiveReport } from "./archive-report.js";
import {
  archiveShapeIssuesOf,
  archiveShapeVersionOf,
  optimizationMetaOf,
} from "./archive-optimization.js";

const scratch = mkdtempSync(join(tmpdir(), "modelwar-archive-shape-versions-"));
afterAll(() => rmSync(scratch, { force: true, recursive: true }));

const FIXTURE_ROOT = fileURLToPath(new URL("./fixtures/archive", import.meta.url));

/** 把一份入库夹具复制成临时报告根（报告按 `<root>/archive/...` 扫）。 */
const copyFixture = (name: string): string => {
  const root = mkdtempSync(join(scratch, `${name}-`));
  cpSync(join(FIXTURE_ROOT, name), root, { recursive: true });
  return root;
};

const V3_SLUG = "fixture-v3-glyph-cluster";
const V3_RUN = "2026-01-03T00-00-00-001Z";
const V4_SLUG = "fixture-v4-tool-call";
const V4_RUN = "2026-01-04T00-00-00-001Z";

const markdownOf = async (root: string): Promise<string> => {
  const out: string[] = [];
  const code = await runArchiveReport(["--root", root], {
    stdout: (text) => out.push(text),
    stderr: () => {},
  });
  expect(code).toBe(0);
  return out.join("");
};

/** `report --json` 的那份输出：形状格与步级的逐字读数都从它读。 */
const jsonOf = async (root: string): Promise<readonly Record<string, unknown>[]> => {
  const out: string[] = [];
  const code = await runArchiveReport(["--root", root, "--json"], {
    stdout: (text) => out.push(text),
    stderr: () => {},
  });
  expect(code).toBe(0);
  return JSON.parse(out.join("")) as readonly Record<string, unknown>[];
};

const metaOf = (root: string, slug: string, runId: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(root, "archive", slug, runId, "meta.json"), "utf8")) as Record<
    string,
    unknown
  >;

// ── v3：真档照旧读得出来（写侧只写 4，读侧 3 与 4 都认） ──────────────────────

it("v3 真档（glyph-cluster 的瘦身副本）：装载、报告读出，步级表 12 bash + 3 evaluate", async () => {
  const root = copyFixture("v3-glyph-cluster");
  const stored = metaOf(root, V3_SLUG, V3_RUN);
  // 形状没被迁移:它仍是 3,不会被读侧悄悄改成 4。
  expect(stored["archiveSchemaVersion"]).toBe(3);
  expect(archiveShapeVersionOf(stored)).toBe(3);
  expect(archiveShapeIssuesOf(stored as never)).toEqual([]);

  const reports = readArchiveReports(root);
  expect(reports).toHaveLength(1);
  const report = reports[0]!;
  expect(report.kind).toBe("success");
  expect(report.shape.archiveSchemaVersion).toBe(3);
  expect(report.shape.termination).toBe("wall-clock");
  expect(report.shape.atStep).toBe(15);
  expect(report.protocolRounds).toBe(15);
  expect(report.candidateStages).toBe(3);

  // 动作标签逐条与真档一致:`check` 那时不是独立一档(它是 `bash` 命令串的末尾)。
  const kinds = report.steps?.entries.map((entry) => entry.action);
  expect(kinds).toEqual([
    "bash",
    "bash",
    "bash",
    "bash",
    "bash",
    "bash",
    "bash",
    "evaluate",
    "bash",
    "bash",
    "evaluate",
    "bash",
    "bash",
    "bash",
    "evaluate",
  ]);
  // v3 档没有工具调用信封:每一格都是 `null`,不会凭空造出一个。
  expect(report.steps?.entries.every((entry) => entry.toolCall === null)).toBe(true);

  // 报告逐字与升版**之前**存下来的那一份相同:读侧的口径不该因为写侧换代而变一个字。
  // golden 是 `archive/glyph-cluster/2026-11-19T11-29-52-739Z` 在 3→4 之前跑出来的那一份
  // (改造前的读数),它与瘦身副本的差别只在 model/runId/prompt 正文——那几处已随夹具改写。
  const markdown = await markdownOf(root);
  const golden = readFileSync(join(FIXTURE_ROOT, "v3-glyph-cluster.golden.md"), "utf8");
  expect(markdown).toBe(golden);
});

// ── v4：新形状读得出来，且 `toolCall` 是逐字字节 ──────────────────────────────

it("v4 档：装载、报告读出,六档动作各归各档(bash / check / probe / evaluate / done)", async () => {
  const root = copyFixture("v4-tool-call");
  const stored = metaOf(root, V4_SLUG, V4_RUN);
  expect(stored["archiveSchemaVersion"]).toBe(4);
  expect(archiveShapeVersionOf(stored)).toBe(4);
  expect(archiveShapeIssuesOf(stored as never)).toEqual([]);
  // 优化段的读入端也认它(形状版本 4 与优化段版本 3 是同一个 agent 形态的两种读法)。
  expect(optimizationMetaOf(stored)).toBeDefined();

  const reports = readArchiveReports(root);
  expect(reports).toHaveLength(1);
  const report = reports[0]!;
  expect(report.kind).toBe("success");
  expect(report.shape.archiveSchemaVersion).toBe(4);
  expect(report.protocolRounds).toBe(7);
  // 五个声明的工具在同一条 steps 里都有写者:`check` / `probe` 两档不再被投影成 `null`。
  expect(report.steps?.entries.map((entry) => entry.action)).toEqual([
    "bash",
    "check",
    "probe",
    "evaluate",
    "bash",
    "evaluate",
    "done",
  ]);
  // `check` 那一步的结果侧证据照旧读得出(通过时是空集合)。
  expect(report.steps?.entries[1]?.result).toEqual({ kind: "tsc", errorCodes: [] });

  const markdown = await markdownOf(root);
  expect(markdown).toContain(`## ${V4_SLUG} · success`);
  expect(markdown).toContain("archiveSchemaVersion=4");
  expect(markdown).toContain("| 2 | check |");
  expect(markdown).toContain("| 3 | probe |");
});

it("v4 档的步级表：check / probe 那两行**逐字**渲染成它自己的名字，与 bash / evaluate / done 同一档", async () => {
  const root = copyFixture("v4-tool-call");
  const markdown = await markdownOf(root);
  // 步级表在「### 步级度量」那一节里（上面还有一张不带动作列的逐轮表，别拿错那七行）。
  const lines = markdown.split("\n");
  const header = lines.findIndex((line) => line.startsWith("| 步 | 动作 |"));
  expect(header).toBeGreaterThanOrEqual(0);
  // 步级表到下一个空行结束（后面紧跟着候选表，也是 `| 数字 |` 开头）。
  const rows: string[] = [];
  for (const line of lines.slice(header + 2)) {
    if (line === "") break;
    rows.push(line);
  }
  // 夹具的七步一行一条，动作列就是 schema 里的档名本身——不加括号、不写成 `bash(check)`。
  expect(rows).toEqual([
    "| 1 | bash | null | null | 41 | 0 | 1500 | null | null | null | round==step |",
    "| 2 | check | null | null | 512 | 12000 | 2000 | 500 | null | tsc（0 个错误码） | round==step |",
    "| 3 | probe | null | null | 18300 | 24000 | 2500 | 500 | null | null | round==step |",
    "| 4 | evaluate | null | null | 104400 | 96000 | 3000 | 500 | null | null | round==step |",
    "| 5 | bash | null | null | 39 | 210000 | 3500 | 500 | null | null | round==step |",
    "| 6 | evaluate | null | null | 101200 | 330000 | 4000 | 500 | null | null | round==step |",
    "| 7 | done | null | null | 2 | 448000 | 4500 | 500 | null | null | round==step |",
  ]);
});

it("v4 档的候选序：`evaluate` 那两行逐字，动作标签是提交时注为空", async () => {
  const root = copyFixture("v4-tool-call");
  const markdown = await markdownOf(root);
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.startsWith("候选序（"));
  expect(start).toBeGreaterThanOrEqual(0);
  // 段尾落在下一个空行：这一节的列表项后面紧跟「工具调用」那一节，也会以 `- 第 N 步` 开头。
  const entries: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line === "") break;
    if (line.startsWith("- 第 ")) entries.push(line);
  }
  expect(entries).toEqual([
    "- 第 4 步：scriptSha256=f7747648a56061a6b7a535a3e86fb4730e0ccd859b82b4667f3dafb3859b12b4",
    "- 第 6 步：scriptSha256=7c2543feb8f72905ca63ce51da99152aed2ece14bad53db0476b04f63721be25；与上一次提交（第 4 步）字节不同；之间经过 1 步（5:bash）",
  ]);
  // 提交那两步的动作是 `evaluate`，所以那两行一个字的注都没有（不是「不是提交」也不是旧文案）。
  expect(entries.every((entry) => !entry.includes("不是提交"))).toBe(true);
  expect(entries.every((entry) => !entry.includes("还跑了别的命令"))).toBe(true);
});

it("`report --json` 的形状格：v3 一档、v4 一档，各照实打印自己的版本号", async () => {
  const v3 = (await jsonOf(copyFixture("v3-glyph-cluster")))[0]!;
  expect((v3["shape"] as Record<string, unknown>)["archiveSchemaVersion"]).toBe(3);
  const v4 = (await jsonOf(copyFixture("v4-tool-call")))[0]!;
  expect((v4["shape"] as Record<string, unknown>)["archiveSchemaVersion"]).toBe(4);
});

it("v4 的「那一步到底干了什么」可复原：`raw` 空串但有 `toolCall` 的步给出工具名与命令", async () => {
  const root = copyFixture("v4-tool-call");
  // 夹具自证：「模型当时说了什么」是空串——照旧读法，这一步在档案里等于什么都没发生。
  const stored = metaOf(root, V4_SLUG, V4_RUN) as {
    readonly steps: readonly { readonly raw?: string }[];
  };
  expect(stored.steps.map((step) => step.raw)).toEqual(["", "", "", "", "", "", ""]);

  const report = (await jsonOf(root))[0]!;
  type Step = {
    readonly action: unknown;
    readonly command: string | null;
    readonly toolCall: { readonly name: string; readonly argumentsJson: string } | null;
  };
  const steps = ((report["steps"] as Record<string, unknown>)["entries"] as readonly Step[]) ?? [];
  const first = steps[0]!;
  // 读侧的证据链：工具名来自 `toolCall.name`，命令来自 `action.command`（不是从 argumentsJson 重解）。
  expect(first.toolCall).toEqual({
    name: "bash",
    argumentsJson:
      '{"command":"cp /contract/examples/minimal.ts /workspace/script.ts \\u003c /dev/null"}',
  });
  expect(first.command).toBe("cp /contract/examples/minimal.ts /workspace/script.ts < /dev/null");
  // 两者**不同形**：把它按 `argumentsJson` 重解一份会得到同样值，但那是另一个家；读侧只搬不算。
  expect(first.command).toContain("<");
  expect(first.toolCall!.argumentsJson).toContain("\\u003c");
  // 但命令那一格只在 `bash` 档有：`check` / `probe` / `evaluate` / `done` 都是 `null`。
  expect(steps.slice(1).map((step) => step.command)).toEqual([
    null,
    null,
    null,
    "cat > /workspace/script.ts <<'EOF'\nfunction loop() {}\nEOF",
    null,
    null,
  ]);
  // 逐字字节那一节里两个都给：读者看得出它们在哪里分岔。
  const markdown = await markdownOf(root);
  expect(markdown).toContain(
    '- 第 1 步：name=bash；command=cp /contract/examples/minimal.ts /workspace/script.ts < /dev/null；argumentsJson={"command":"cp /contract/examples/minimal.ts /workspace/script.ts \\u003c /dev/null"}',
  );
});

it("**逐字字节**:报告只按 `argumentsJson` 给,不按 `action.command` 重编码", async () => {
  const root = copyFixture("v4-tool-call");
  const stored = metaOf(root, V4_SLUG, V4_RUN) as {
    steps: readonly {
      action: { kind: string; command?: string };
      toolCall?: { name: string; argumentsJson: string };
    }[];
  };
  const first = stored.steps[0]!;
  const fifth = stored.steps[4]!;
  // 夹具自证:两种写法都与解析后的 `command` **不同形**——否则这条用例证明不了「不重编码」。
  expect(first.toolCall!.argumentsJson).toContain("\\u003c");
  expect(first.toolCall!.argumentsJson).not.toContain("<");
  expect(first.toolCall!.argumentsJson).not.toBe(JSON.stringify({ command: first.action.command }));
  expect(fifth.toolCall!.argumentsJson).toContain('{ "command" : ');
  expect(fifth.toolCall!.argumentsJson).not.toBe(JSON.stringify({ command: fifth.action.command }));

  const report = readArchiveReports(root)[0]!;
  // 读侧搬的就是那一串,一个字节都不改。
  expect(report.steps?.entries[0]?.toolCall).toEqual({
    name: "bash",
    argumentsJson: first.toolCall!.argumentsJson,
  });
  expect(report.steps?.entries[4]?.toolCall).toEqual({
    name: "bash",
    argumentsJson: fifth.toolCall!.argumentsJson,
  });
  // 而 `action.command` 是它的派生值:两者不同形(那正是「一个家」的意义)。
  expect(first.action.command).toContain("<");
  expect(first.action.command).not.toContain("\\u003c");

  const markdown = await markdownOf(root);
  // 报告里出现的是原文(`\u003c`),不是重编码后的 `<`。
  expect(markdown).toContain('argumentsJson={"command":"cp /contract/examples/minimal.ts');
  expect(markdown).toContain("\\u003c");
});

// ── v3 与 v4 的**唯一**差别：v3 档不许出现 v4 才有的形状 ──────────────────────

/** 造一份最小的 v3 档（单步、无候选），好往里塞不该有的形状。 */
const writeMinimalV3 = (root: string, step: Record<string, unknown>): void => {
  const dir = join(root, "archive", "v3mut", "2026-01-05T00-00-00-001Z");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "meta.json"),
    `${JSON.stringify(
      {
        archiveSchemaVersion: 3,
        model: "v3mut",
        modelVersion: "fixture/v3-model",
        generatedAt: "2026-01-05T00:00:00.000Z",
        protocolRounds: 1,
        prompts: ["任务:写 script.ts"],
        steps: [step],
        generationLog: [
          JSON.stringify({ round: 1, kind: "converged", responseConverged: true, model: "v3mut" }),
        ],
        contextLength: 262144,
        harnessVersion: "bash-mini/0.1",
        harnessDigest: "3".repeat(64),
        termination: "done",
        atStep: 1,
        ruleset: "v2",
        validation: { passed: true, errors: [] },
        tscVersion: "7.0.2",
        scriptSha256: "0".repeat(64),
        sandboxRuntimeHash: "b".repeat(64),
      },
      null,
      2,
    )}\n`,
  );
};

const STEP_BASE = {
  step: 1,
  stdout: "",
  stderr: "",
  exitCode: 0,
  atMs: 0,
  harnessMs: 1,
} as const;

it("v3 档塞一条 check 动作:拒读,并且**点名** check", () => {
  const root = mkdtempSync(join(scratch, "v3-check-"));
  writeMinimalV3(root, { ...STEP_BASE, action: { kind: "check" } });
  const [issue] = archiveShapeIssuesOf(
    JSON.parse(
      readFileSync(join(root, "archive", "v3mut", "2026-01-05T00-00-00-001Z", "meta.json"), "utf8"),
    ) as never,
  );
  expect(issue?.kind).toBe("archive-step-shape");
  // 点名的是那个动作,不是笼统的「形状不合法」。
  expect(issue?.message).toContain("check");
  expect(issue?.pointer).toBe("/steps/0/action/kind");

  // 报告侧同样拒读:整条记录记成 read issue(不是把 v3 读成「差不多对」)。
  const issues: string[] = [];
  expect(readArchiveReports(root, { onReadIssue: (item) => issues.push(item.reason) })).toEqual([]);
  expect(issues).toHaveLength(1);
});

it("v3 档塞一条 probe 动作:同样拒读并点名 probe", () => {
  const root = mkdtempSync(join(scratch, "v3-probe-"));
  writeMinimalV3(root, { ...STEP_BASE, action: { kind: "probe" } });
  const issues = archiveShapeIssuesOf(
    JSON.parse(
      readFileSync(join(root, "archive", "v3mut", "2026-01-05T00-00-00-001Z", "meta.json"), "utf8"),
    ) as never,
  );
  expect(issues[0]?.message).toContain("probe");
});

it("v3 档的步带 `toolCall`:拒读(工具调用信封是 v4 的形状)", () => {
  const root = mkdtempSync(join(scratch, "v3-toolcall-"));
  writeMinimalV3(root, {
    ...STEP_BASE,
    action: { kind: "bash", command: "ls /contract" },
    toolCall: { name: "bash", argumentsJson: '{"command":"ls /contract"}' },
  });
  const [issue] = archiveShapeIssuesOf(
    JSON.parse(
      readFileSync(join(root, "archive", "v3mut", "2026-01-05T00-00-00-001Z", "meta.json"), "utf8"),
    ) as never,
  );
  expect(issue?.kind).toBe("archive-step-shape");
  expect(issue?.pointer).toBe("/steps/0/toolCall");
  expect(issue?.message).toContain("toolCall");
});

it("同样的形状放进 v4 档就合法:两版的差别只有这一条,不是两套读法", () => {
  const root = mkdtempSync(join(scratch, "v4-check-"));
  writeMinimalV3(root, {
    ...STEP_BASE,
    action: { kind: "check" },
    toolCall: { name: "check", argumentsJson: "{}" },
  });
  const path = join(root, "archive", "v3mut", "2026-01-05T00-00-00-001Z", "meta.json");
  const meta = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  // 把形状版本从 3 改成 4:同样的步立刻合法。
  writeFileSync(path, `${JSON.stringify({ ...meta, archiveSchemaVersion: 4 }, null, 2)}\n`);
  const stored = JSON.parse(readFileSync(path, "utf8")) as never;
  expect(archiveShapeVersionOf(stored)).toBe(4);
  expect(archiveShapeIssuesOf(stored)).toEqual([]);
  const report = readArchiveReports(root)[0]!;
  // 同一份步在 v4 下合法:动作投影成 `check`(v3 下它是拒读理由,不是动作)。
  expect(report.steps?.entries[0]?.action).toBe("check");
  expect(report.steps?.entries[0]?.toolCall).toEqual({ name: "check", argumentsJson: "{}" });
});

// ── 失败档：v4 的拒绝档诊断只给条数，四档名字不住在读侧 ────────────────────────

/**
 * 造一份最小的 v4 失败档（`failed-<runId>.json`），`termination: action-parse`。
 *
 * 诊断正文按 gen 侧 `diagnosticLines` 的形状写（「第 N 步(none,exit 64): …」），并**故意**把
 * 票 02 的四档名字塞进去：读侧若手抄了那四个名字，这份档就会在报告里把名字回显出来。
 */
const writeMinimalV4Failure = (root: string): void => {
  const slugDir = join(root, "archive", "v4fail");
  mkdirSync(slugDir, { recursive: true });
  writeFileSync(
    join(slugDir, "failed-2026-01-06T00-00-00-001Z.json"),
    `${JSON.stringify(
      {
        archiveSchemaVersion: 4,
        model: "v4fail",
        modelVersion: "fixture/v4-model",
        generatedAt: "2026-01-06T00:00:00.000Z",
        runId: "2026-01-06T00-00-00-001Z",
        protocolRounds: 1,
        prompts: ["任务:写 script.ts"],
        steps: [
          {
            step: 1,
            action: { kind: "none" },
            stdout: "",
            stderr: "这一步没有发起任何工具调用",
            exitCode: 64,
            atMs: 0,
            harnessMs: 1,
          },
        ],
        generationLog: [JSON.stringify({ round: 1, kind: "converged", responseConverged: true })],
        contextLength: 262144,
        harnessVersion: "bash-mini/0.1",
        harnessDigest: "4".repeat(64),
        termination: "action-parse",
        atStep: 1,
        ruleset: "v2",
        validation: { passed: false, errors: [] },
        tscVersion: "7.0.2",
        scriptSha256: "0".repeat(64),
        sandboxRuntimeHash: "b".repeat(64),
        classification: "contract",
        diagnostics: [
          "第 1 步(none,exit 64): no-tool-call",
          "第 1 步(none,exit 64): multiple-tool-calls",
          "第 1 步(none,exit 64): unknown-tool 与 malformed-arguments 都在这里",
        ],
        message: "连续三次动作解析失败",
      },
      null,
      2,
    )}\n`,
  );
};

it("v4 失败档：`终止=action-parse` 照实打印，诊断只给条数、不回显正文", async () => {
  const root = mkdtempSync(join(scratch, "v4-failure-"));
  writeMinimalV4Failure(root);
  const [report] = readArchiveReports(root);
  expect(report?.kind).toBe("failure");
  expect(report?.shape.archiveSchemaVersion).toBe(4);
  expect(report?.shape.termination).toBe("action-parse");
  expect(report?.failure).toEqual({ classification: "contract", diagnosticsCount: 3 });

  const markdown = await markdownOf(root);
  // 终止原因照实打印——那是失败档「怎么停的」的唯一读数。
  expect(markdown).toContain("终止=action-parse（第 1 步）");
  expect(markdown).toContain("- 诊断条数：3（原文不公开）");
  // 四档名字的真源是 gen 的 `ACTION_REJECT_REASONS`，读侧不搬也不猜：正文一个字都不出现。
  for (const reason of [
    "no-tool-call",
    "multiple-tool-calls",
    "unknown-tool",
    "malformed-arguments",
  ])
    expect(markdown).not.toContain(reason);
});

it("读侧不手抄四档拒绝名：它们只住在 `packages/gen` 的 `ACTION_REJECT_REASONS` 里", () => {
  const sources = readdirSync(new URL("./", import.meta.url))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8"));
  // 正向自证：真的读到了源码（空数组会让下面的断言变成空判据）。
  expect(sources.some((source) => source.includes("archiveShapeVersionOf"))).toBe(true);
  for (const reason of [
    "no-tool-call",
    "multiple-tool-calls",
    "unknown-tool",
    "malformed-arguments",
  ])
    expect(sources.filter((source) => source.includes(reason))).toEqual([]);
});
