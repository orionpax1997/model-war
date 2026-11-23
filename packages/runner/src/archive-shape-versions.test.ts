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

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
