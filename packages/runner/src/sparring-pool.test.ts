/**
 * 陪练池装载：身份解析、摘要校验、缺档拒绝、在位取最近一次、代位标注。
 *
 * 断言对象都是**外部可观察的行为**：交回的四份是什么（id/role/source/摘要）、拒绝理由里
 * 点了谁的名、在位落到哪一份存档。全部用临时夹具根，不把「本地存在真实 archive」当硬前提；
 * 对钉死身份的核对放在最后一例，读的是入库副本 `fixtures/archive/sparring-ladder/`，同样不用本机档案。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, expect, it } from "vitest";
import {
  TRIAL_SPARRING_LADDER,
  TRIAL_SPARRING_SUBSTITUTE,
  type TrialSparringIdentity,
} from "@model-war/schema";

import { latestArchiveRunId, loadSparringPool, sparringPoolScriptsOf } from "./sparring-pool.js";

const scratch = mkdtempSync(join(tmpdir(), "modelwar-sparring-pool-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const sha256 = (bytes: string): string => createHash("sha256").update(bytes).digest("hex");

/** 在夹具根里落一份存档（三件套只写 `script.js` 与 `meta.json`：装载只认前者的字节）。 */
const writeArchive = (root: string, slug: string, runId: string, code: string): string => {
  const dir = join(root, "archive", slug, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "script.js"), code);
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ model: slug, generatedAt: runId }));
  return sha256(code);
};

const codeOf = (label: string): string => `"use strict";\n// ${label}\nfunction loop() {}\n`;

/**
 * 夹具池：三份榜单档 + 一份代位档，摘要按盘上字节现算。
 *
 * 模型 slug 与运行标识**故意与真实榜无关**：这里要钉的是「怎么解析」，不是「谁在榜上」。
 */
const fixture = () => {
  const root = mkdtempSync(join(scratch, "root-"));
  const ladder: readonly TrialSparringIdentity[] = (
    [
      ["top", "ladder-top", "2026-10-01T00-00-00-001Z"],
      ["mid", "ladder-mid", "2026-10-02T00-00-00-002Z"],
      ["last", "ladder-last", "2026-10-03T00-00-00-003Z"],
    ] as const
  ).map(([role, id, runId]) => ({
    role,
    id,
    runId,
    scriptSha256: writeArchive(root, id, runId, codeOf(id)),
  }));
  const substitute = {
    id: "stand-in",
    runId: "2026-09-01T00-00-00-000Z",
    scriptSha256: writeArchive(root, "stand-in", "2026-09-01T00-00-00-000Z", codeOf("stand-in")),
  };
  return { root, ladder, substitute };
};

it("成功装载：四份按 榜首→中位→末位→在位 交回，摘要取自盘上字节，来源指到存档路径", () => {
  const { root, ladder, substitute } = fixture();
  const result = loadSparringPool({ root, model: "brand-new-model", ladder, substitute });
  expect(result.ok, result.ok ? "" : result.reason).toBe(true);
  if (!result.ok) return;
  const { pool } = result;
  expect(pool.model).toBe("brand-new-model");
  expect(pool.scripts.map((entry) => entry.script.role)).toEqual([
    "top",
    "mid",
    "last",
    "incumbent",
  ]);
  // id 是**角色限定**的 `<role>:<slug>`：候选模型自己就是榜首/中位/末位之一时不撞名。
  expect(pool.scripts.map((entry) => entry.script.id)).toEqual([
    "top:ladder-top",
    "mid:ladder-mid",
    "last:ladder-last",
    `incumbent:${substitute.id}`,
  ]);
  expect(pool.scripts.map((entry) => entry.script.source)).toEqual([
    "archive:ladder-top/2026-10-01T00-00-00-001Z",
    "archive:ladder-mid/2026-10-02T00-00-00-002Z",
    "archive:ladder-last/2026-10-03T00-00-00-003Z",
    `archive:${substitute.id}/${substitute.runId}#substitute`,
  ]);
  expect(pool.scripts.map((entry) => entry.script.scriptSha256)).toEqual([
    ...[...ladder].map((identity) => identity.scriptSha256),
    substitute.scriptSha256,
  ]);
  // 源码与摘要出自同一份字节：执行器不必再读一次盘。
  expect(pool.scripts.map((entry) => entry.code)).toEqual([
    codeOf("ladder-top"),
    codeOf("ladder-mid"),
    codeOf("ladder-last"),
    codeOf("stand-in"),
  ]);
  expect(pool.scripts.map((entry) => entry.path)).toEqual([
    "archive/ladder-top/2026-10-01T00-00-00-001Z/script.js",
    "archive/ladder-mid/2026-10-02T00-00-00-002Z/script.js",
    "archive/ladder-last/2026-10-03T00-00-00-003Z/script.js",
    `archive/${substitute.id}/${substitute.runId}/script.js`,
  ]);
  // 计划要的那一格：四份身份，可直接喂 `buildTrialPlan` 的 `scripts`。
  expect(sparringPoolScriptsOf(pool)).toEqual(pool.scripts.map((entry) => entry.script));
  // 代位是来源（`#substitute`）而不是另一个角色，人话留痕里说清是谁顶的谁。
  expect(pool.notes.join("\n")).toContain("还没有冻结存档");
  expect(pool.notes.join("\n")).toContain(substitute.id);
});

it("摘要不符即拒绝：理由指名角色、模型、运行标识、期望与实际摘要", () => {
  const { root, ladder, substitute } = fixture();
  const mid = ladder[1]!;
  const tampered = loadSparringPool({
    root,
    model: "brand-new-model",
    ladder: ladder.map((identity, index) =>
      index === 1 ? { ...identity, scriptSha256: "0".repeat(64) } : identity,
    ),
    substitute,
  });
  expect(tampered.ok).toBe(false);
  if (tampered.ok) return;
  expect(tampered.reason).toContain("中位");
  expect(tampered.reason).toContain(mid.id);
  expect(tampered.reason).toContain(mid.runId);
  expect(tampered.reason).toContain(`archive/${mid.id}/${mid.runId}/script.js`);
  expect(tampered.reason).toContain("0".repeat(64));
  expect(tampered.reason).toContain(mid.scriptSha256);

  // 反过来也一样：钉死值没动、盘上字节被改（「文件被改过」那一路）。
  writeArchive(root, mid.id, mid.runId, codeOf("patched-by-hand"));
  const rewritten = loadSparringPool({ root, model: "brand-new-model", ladder, substitute });
  expect(rewritten.ok).toBe(false);
  if (rewritten.ok) return;
  expect(rewritten.reason).toContain("内容摘要不符");
  expect(rewritten.reason).toContain(mid.id);
  expect(rewritten.reason).toContain(sha256(codeOf("patched-by-hand")));
});

it("缺档即拒绝：理由指名缺的是哪一份，不崩、不静默跳过", () => {
  const { root, ladder, substitute } = fixture();
  const last = ladder[2]!;
  rmSync(join(root, "archive", last.id, last.runId), { recursive: true, force: true });
  const result = loadSparringPool({ root, model: "brand-new-model", ladder, substitute });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toContain("末位");
  expect(result.reason).toContain(last.id);
  expect(result.reason).toContain(last.runId);
  expect(result.reason).toContain(`archive/${last.id}/${last.runId}/script.js`);
  expect(result.reason).toContain("读不到");
  // 存档目录还在、只是那一跑没落 `script.js`：理由指向「那一跑没落产物」，不提拓存档。
  expect(result.reason).toContain("该运行标识下没有 script.js");
  expect(result.reason).not.toContain("整个不存在");
});

it("整个 archive/<slug>/ 不在时理由说清是要拓存档（新 worktree / 干净克隆的真形状）", () => {
  // 真会话常见的那一种：worktree 里 `archive/` 是 gitignored，一份都没有。
  // 与「目录在但缺 script.js」是两种成因，做法也不同，所以文案必须能分开。
  const { root, ladder, substitute } = fixture();
  const last = ladder[2]!;
  rmSync(join(root, "archive", last.id), { recursive: true, force: true });
  expect(existsSync(join(root, "archive", last.id))).toBe(false);
  const result = loadSparringPool({ root, model: "brand-new-model", ladder, substitute });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toContain(last.id);
  expect(result.reason).toContain(`archive/${last.id}/`);
  expect(result.reason).toContain("整个不存在");
  // 指向可做的事：拓存档，且指到写那条命令的文档。
  expect(result.reason).toContain("archive/");
  expect(result.reason).toContain("README");
});

it("在位取该模型最近一次冻结存档：字典序最大的旁挂目录不算，且摘要随文件而定", () => {
  const { root, ladder, substitute } = fixture();
  const model = "incumbent-model";
  writeArchive(root, model, "2026-10-01T00-00-00-001Z", codeOf("old"));
  const latest = "2026-10-19T06-30-58-195Z";
  const latestSha = writeArchive(root, model, latest, codeOf("newest"));
  // 旁挂目录：与存档目录同层，名字以 `f` 开头，字典序比任何 `2…` 都大。
  const feedback = "feedback-2026-10-20T00-00-00-000Z-deadbeef";
  writeArchive(root, model, feedback, codeOf("feedback"));

  expect(latestArchiveRunId(root, model)).toBe(latest);
  // 「名字排序取最大」会选中旁挂目录——这就是不能那么取的理由。
  expect(feedback.localeCompare(latest)).toBeGreaterThan(0);

  const result = loadSparringPool({ root, model, ladder, substitute });
  expect(result.ok, result.ok ? "" : result.reason).toBe(true);
  if (!result.ok) return;
  const incumbent = result.pool.scripts[3]!.script;
  expect(incumbent.role).toBe("incumbent");
  expect(incumbent.id).toBe(`incumbent:${model}`);
  expect(incumbent.source).toBe(`archive:${model}/${latest}`);
  expect(incumbent.scriptSha256).toBe(latestSha);
  expect(result.pool.notes.join("\n")).toContain(latest);
});

it("该模型一份存档都没有：在位以代位档顶替并标注 #substitute（目录只有旁挂件也算没有）", () => {
  const { root, ladder, substitute } = fixture();
  const model = "never-generated";
  mkdirSync(join(root, "archive", model), { recursive: true });
  // 只有失败记录，没有冻结存档目录。
  writeFileSync(
    join(root, "archive", model, "failed-2026-10-01T00-00-00-000Z.json"),
    JSON.stringify({ reason: "compile-failed" }),
  );
  expect(latestArchiveRunId(root, model)).toBeUndefined();

  const result = loadSparringPool({ root, model, ladder, substitute });
  expect(result.ok, result.ok ? "" : result.reason).toBe(true);
  if (!result.ok) return;
  const incumbent = result.pool.scripts[3]!;
  expect(incumbent.script).toEqual({
    id: `incumbent:${substitute.id}`,
    role: "incumbent",
    source: `archive:${substitute.id}/${substitute.runId}#substitute`,
    scriptSha256: substitute.scriptSha256,
  });
  expect(result.pool.notes.join("\n")).toContain("还没有冻结存档");
  expect(result.pool.notes.join("\n")).toContain("顶替");
});

/**
 * 钉死身份对着**入库副本**验，不对着本机 `archive/`：`fixtures/archive/sparring-ladder/` 是从真实
 * `archive/` 里逐字节裁出来的 `script.js`（来源与裁剪清单见那里 README）。`archive/` 不入库，按它
 * 守卫只会让这一例在干净克隆上沉默地 skip——而「钉死的摘要与盘上字节一致」正是它唯一要证的事。
 *
 * 副本里同时保住了 `latestArchiveRunId` 要分辨的目录结构：同一个 `<slug>/` 下既有真存档目录，
 * 也有一条 `feedback-<runId>-<hash>` 旁挂目录（它也带 `script.js`，名字排在所有 `20…` 之后）。
 */
const LADDER_FIXTURE_ROOT = fileURLToPath(
  new URL("./fixtures/archive/sparring-ladder", import.meta.url),
);

/** 旁挂目录：`'f' > '2'`，按名字排序取最大就会挑中它而不是真存档。 */
const SIDECAR = "feedback-2026-10-12T06-44-23-721Z-8477e747";

it("钉死的三份摘要与入库副本的字节一致，在位落到该模型最近一次存档", () => {
  const result = loadSparringPool({ root: LADDER_FIXTURE_ROOT, model: "gpt-6.1-sol" });
  expect(result.ok, result.ok ? "" : result.reason).toBe(true);
  if (!result.ok) return;
  expect(result.pool.scripts.slice(0, 3).map((entry) => entry.script)).toEqual(
    TRIAL_SPARRING_LADDER.map((identity) => ({
      id: `${identity.role}:${identity.id}`,
      role: identity.role,
      source: `archive:${identity.id}/${identity.runId}`,
      scriptSha256: identity.scriptSha256,
    })),
  );
  const incumbent = result.pool.scripts[3]!;
  // 副本里 `gpt-6.1-sol` 有两档：取时间上最新那一档，不是字典序最大（两者在这批数据上恰好都
  // 指向它，真正的分辨点在同层那条 `feedback-…` 目录上，见下）。
  const latest = latestArchiveRunId(LADDER_FIXTURE_ROOT, "gpt-6.1-sol");
  expect(latest).toBe("2026-10-13T14-27-39-119Z");
  expect(incumbent.script.id).toBe("incumbent:gpt-6.1-sol");
  expect(incumbent.script.source).toBe(`archive:gpt-6.1-sol/${latest ?? ""}`);
  // 摘要 = 盘上字节的 sha256（复算认编译产物），与在位选中的是哪一档无关地逐字节核。
  expect(incumbent.script.scriptSha256).toBe(
    createHash("sha256")
      .update(readFileSync(join(LADDER_FIXTURE_ROOT, incumbent.path)))
      .digest("hex"),
  );
  // 与存档同级的旁挂目录（`feedback-<runId>-<hash>`，也带 `script.js`）：不入选。
  const picked = latestArchiveRunId(LADDER_FIXTURE_ROOT, "deepseek-v4.1-flash");
  expect(picked).toBe("2026-10-12T05-24-53-183Z");
  if (picked === undefined) return;
  // 名字排序取最大会挑中旁挂目录——这就是不能那么取的理由。
  expect(SIDECAR.localeCompare(picked)).toBeGreaterThan(0);
  // 选中的那一档是真存档（`script.js` 在位），不是旁的目录。
  expect(
    existsSync(join(LADDER_FIXTURE_ROOT, "archive", "deepseek-v4.1-flash", picked, "script.js")),
  ).toBe(true);
  // 代位档：该模型一份存档都没有时顶上，摘要同样对得上钉死值。
  const substitute = loadSparringPool({
    root: LADDER_FIXTURE_ROOT,
    model: "never-generated-model",
  });
  expect(substitute.ok).toBe(true);
  if (substitute.ok) {
    expect(substitute.pool.scripts[3]!.script.scriptSha256).toBe(
      TRIAL_SPARRING_SUBSTITUTE.scriptSha256,
    );
  }
});
