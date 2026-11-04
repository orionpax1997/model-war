/**
 * 陪练池装载：身份解析、摘要校验、缺档拒绝、在位取最近一次、代位标注。
 *
 * 断言对象都是**外部可观察的行为**：交回的四份是什么（id/role/source/摘要）、拒绝理由里
 * 点了谁的名、在位落到哪一份存档。全部用临时夹具根，不把「本地存在真实 archive」当硬前提；
 * 对真实 `archive/` 的核对放在最后一例，本地没有那几份存档时整例跳过。
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

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
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

const realTop = TRIAL_SPARRING_LADDER[0];
const realArchivePresent = existsSync(
  join(repoRoot, "archive", realTop.id, realTop.runId, "script.js"),
);

it.skipIf(!realArchivePresent)(
  "真实 archive（本地有才断言）：钉死的三份摘要与盘上字节一致，在位落到该模型最近一次存档",
  () => {
    const result = loadSparringPool({ root: repoRoot, model: "gpt-6.1-sol" });
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
    const latest = latestArchiveRunId(repoRoot, "gpt-6.1-sol");
    expect(incumbent.script.id).toBe("incumbent:gpt-6.1-sol");
    expect(incumbent.script.source).toBe(`archive:gpt-6.1-sol/${latest ?? ""}`);
    // 摘要 = 盘上字节的 sha256（复算认编译产物）。
    expect(incumbent.script.scriptSha256).toBe(
      createHash("sha256")
        .update(readFileSync(join(repoRoot, incumbent.path)))
        .digest("hex"),
    );
    // 真实数据里那条「不能取字典序最大」的旁挂目录：最新档是 10-19，不是 feedback 目录。
    if (
      existsSync(
        join(
          repoRoot,
          "archive/deepseek-v4.1-flash/feedback-2026-10-12T06-44-23-721Z-8477e747/script.js",
        ),
      )
    ) {
      expect(latestArchiveRunId(repoRoot, "deepseek-v4.1-flash")).toBe("2026-10-19T06-30-58-195Z");
    }
    // 代位档的那份存档也在库里时，摘要同样对得上钉死值。
    if (
      existsSync(
        join(
          repoRoot,
          "archive",
          TRIAL_SPARRING_SUBSTITUTE.id,
          TRIAL_SPARRING_SUBSTITUTE.runId,
          "script.js",
        ),
      )
    ) {
      const substitute = loadSparringPool({
        root: repoRoot,
        model: "never-generated-model",
      });
      expect(substitute.ok).toBe(true);
      if (substitute.ok) {
        expect(substitute.pool.scripts[3]!.script.scriptSha256).toBe(
          TRIAL_SPARRING_SUBSTITUTE.scriptSha256,
        );
      }
    }
  },
);
