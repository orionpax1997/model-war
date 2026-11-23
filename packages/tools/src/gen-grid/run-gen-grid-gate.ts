/**
 * 门禁:**一次 `evaluate` 真跑满一张网格**(根脚本 `gate:gen-grid`)。
 *
 * ```
 * pnpm run gate:gen-grid
 * ```
 *
 * ── 它证明什么 ──
 *
 * 单测里的试跑探针是桩(「形状真实」,不是「真跑的」)。这份门禁用**真子进程**的试跑入口把
 * 32 场真的跑一遍,判四件外部可观察的事:
 *
 * 1. **完整**:观测 JSONL 恰 32 行、`matchIndex` 恰 0..31,旁挂 `.grid.json` 的计划也是 32 场;
 * 2. **身份**:候选条目的 `observationsFile` / `scriptFile` 落在既有命名族里,产物哈希与盘上
 *    字节一致,`meta.scriptSha256` 等于末位候选那一份(胜者取末位,ADR-0030);
 * 3. **观测外置**:`evaluate` 的 stdout 只给聚合对差表与一行路径,逐场明细留在
 *    `/workspace/.observations/<n>.md`,档案里只有观测**原料**与候选身份;
 * 4. **耗时在同一个量级**:与既有试跑一致(同一张计划、同一个入口),所以把实测耗时打出来
 *    供人对照——它不设绝对阈值(那是机器账,不是正确性账),只在超过硬上限时报红。
 *
 * ── 为什么不放进 `verify:kernel` ──
 *
 * `verify:kernel` 判的是**隔离**(可用性、无网络、进程回收、rootfs 漂移),它的前提是内核能力
 * 与 `bubblewrap`。这一条判的是**网格**,不碰内核,却需要一份别的东西:四份钉死的陪练存档
 * (`archive/` 不入库)。把两件事混进一条腿,「沙箱坏了」与「这台机器没有陪练存档」会变成同一条红。
 * 代价是它得自己有一条命名脚本(与 `gate:limits` / `gate:selfproof` 同层:按需 + 夜间可挂)。
 *
 * ── 为什么它不 skip ──
 *
 * 陪练存档缺席时**退非零并说清楚缺哪一份**:一台没有存档的机器本来也跑不了真网格,把它写成
 * 「跳过」会让下次真跑时的第一场静默变成 0 场——那正是空转检测要拦的形态(CONTEXT.md)。
 *
 * ── 为什么用子进程驱动 ──
 *
 * 生成侧在 `packages/gen`,门禁在 `packages/tools`;hld §3.2 只允许工具包 import 真源包
 * (schema)。所以这里沿用 `sandbox-rootfs/executor-bridge.ts` 的同一条缝:起一个子进程,
 * 让它 `await import(<gen 的 dist 入口>)`、跑一次 `generateOneModel`,把事实写成一行 JSON 交回。
 * 断言全在门禁这边。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  TRIAL_GRID_SUMMARY_SUFFIX,
  TRIAL_MATCHES_PER_CANDIDATE,
  TRIAL_SPARRING_LADDER,
  TRIAL_SPARRING_SUBSTITUTE,
} from "@model-war/schema";

import { vacuousReason } from "../gate/vacuous.ts";

/** 本文件在 `<repo>/packages/tools/src/gen-grid/` 下,上溯四级是仓库根。 */
const repoRoot = resolve(import.meta.dirname, "../../../..");

/** 生成侧的编译形态入口(`gate:gen-grid` 的命名脚本先 `pnpm run build`)。 */
const GEN_ENTRY = "packages/gen/dist/index.js";

/** 实测耗时的硬上限:超过它就不是「慢机器」而是「这条路径挂住了」。 */
const ELAPSED_CEILING_MS = 15 * 60 * 1_000;

/** 四份陪练的身份(与计划装载同一份真源):缺哪一份就指名哪一份。 */
const SPARRING = [
  ...TRIAL_SPARRING_LADDER.map((identity) => ({ slug: identity.id, runId: identity.runId })),
  { slug: TRIAL_SPARRING_SUBSTITUTE.id, runId: TRIAL_SPARRING_SUBSTITUTE.runId },
];

/** 子进程交回的一份事实(见 `ADAPTER` 的注释:它只搬运,不判定)。 */
type GridFacts = {
  readonly ok: boolean;
  readonly message?: string;
  readonly elapsedMs?: number;
  readonly root?: string;
  readonly runId?: string;
  readonly kind?: string;
  readonly evaluateStdout?: string;
  readonly archive?: readonly string[];
  readonly candidates?: readonly {
    readonly step: number;
    readonly scriptFile: string;
    readonly observationsFile: string;
    readonly scriptSha256: string;
    readonly matchCount: number;
    readonly score: { readonly countedMatches: number; readonly averagePoints: number };
  }[];
  readonly scriptSha256?: string;
  readonly observationLines?: number;
  readonly observationIndexes?: readonly number[];
  readonly planMatches?: number;
  readonly gridScriptSha256?: string;
  readonly viewLines?: number;
  readonly frozenScriptMatchesCandidate?: boolean;
  readonly frozenSourceMatchesCandidate?: boolean;
};

/**
 * 子进程里的那段胶水:跑一次 `generateOneModel`(真计划、真试跑、桩模型),把事实写成一行 JSON。
 *
 * 它**不做任何断言**——判据全在门禁这边;它只回答「盘上到底有什么」。
 */
const ADAPTER = `
const [entryPath, root, mainArchive] = process.argv.slice(1);
const { cpSync, mkdirSync, readFileSync, readdirSync, mkdtempSync, symlinkSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const gen = await import(entryPath);

const SCRIPT = "var ticks = 0;\\nfunction loop() {\\n  ticks += 1;\\n  return ticks;\\n}\\n";
const RUN_ID = "2026-12-01T00-00-00-000Z";

const sparring = [
  ["claude-opus-5-5", "2026-10-16T08-40-12-578Z"],
  ["minimax-m3.1-flash", "2026-10-13T13-48-45-729Z"],
  ["glm-5.3-flash", "2026-10-13T22-30-50-602Z"],
  ["muse-spark-1.3-contributor", "2026-10-13T12-34-16-218Z"],
];
const installRoot = mkdtempSync(join(tmpdir(), "model-war-gen-grid-"));
for (const relative of ["node_modules", "packages", "apps", "maps", "benchmarks"])
  symlinkSync(join(root, relative), join(installRoot, relative), "dir");
writeFileSync(join(installRoot, "tsconfig.scripts.json"), readFileSync(join(root, "tsconfig.scripts.json")));
mkdirSync(join(installRoot, "rulesets"), { recursive: true });
writeFileSync(join(installRoot, "rulesets", "v2.json"), readFileSync(join(root, "rulesets", "v2.json")));
for (const [slug, sparringRunId] of sparring) {
  const dir = join(installRoot, "archive", slug, sparringRunId);
  mkdirSync(dir, { recursive: true });
  for (const name of ["script.js", "meta.json"]) {
    cpSync(join(mainArchive, slug, sparringRunId, name), join(dir, name));
  }
}
const workspaceDir = join(installRoot, "ws");
mkdirSync(workspaceDir, { recursive: true });

const model = gen.stubClient([
  gen.reply("\\u0060\\u0060\\u0060bash\\ncat > /workspace/script.ts <<'EOF'\\n" + SCRIPT + "EOF\\n\\u0060\\u0060\\u0060"),
  gen.reply("\\u0060\\u0060\\u0060bash\\nevaluate\\n\\u0060\\u0060\\u0060"),
  gen.reply("\\u0060\\u0060\\u0060bash\\nfinish\\n\\u0060\\u0060\\u0060"),
]);

const startedAt = Date.now();
let outcome;
try {
  outcome = await gen.generateOneModel(
    {
      root: installRoot,
      runId: RUN_ID,
      agentPrompt: { user: "任务:在 /workspace 写 script.ts", system: "协议:每一步一个动作块" },
      createClient: () => model,
      workspaceDir,
      now: () => new Date(),
    },
    {
      slug: "alpha",
      endpointFamily: "chat-completions",
      baseUrl: "https://example.invalid/v1",
      modelId: "verifier/alpha-1",
      credentialEnvVar: "GEN_GRID_KEY",
      channelId: "gen-grid-gate",
      contextLength: 200000,
    },
  );
} catch (cause) {
  process.stdout.write(JSON.stringify({ ok: false, message: cause instanceof Error ? cause.message : String(cause) }) + "\\n");
  process.exit(0);
}
const elapsedMs = Date.now() - startedAt;

const slugDir = join(installRoot, "archive", "alpha");
const candidates = (outcome.kind === "frozen" ? outcome.meta.optimization?.candidates : undefined) ?? [];
const first = candidates[0];
const observations = first === undefined ? [] : readFileSync(join(slugDir, first.observationsFile), "utf8").trim().split("\\n").filter((line) => line.length > 0);
const grid = first === undefined ? undefined : JSON.parse(readFileSync(join(slugDir, first.observationsFile + ".grid.json"), "utf8"));
const viewPath = join(workspaceDir, ".observations", "1.md");
process.stdout.write(JSON.stringify({
  ok: true,
  elapsedMs,
  root: installRoot,
  runId: RUN_ID,
  kind: outcome.kind,
  evaluateStdout: outcome.kind === "frozen" ? outcome.meta.steps?.[1]?.stdout ?? "" : "",
  archive: readdirSync(slugDir),
  candidates,
  scriptSha256: outcome.kind === "frozen" ? outcome.meta.scriptSha256 : undefined,
  observationLines: observations.length,
  observationIndexes: observations.map((line) => JSON.parse(line).matchIndex),
  planMatches: grid === undefined ? undefined : grid.plan.matches.length,
  gridScriptSha256: grid === undefined ? undefined : grid.scriptSha256,
  viewLines: (await import("node:fs")).existsSync(viewPath) ? readFileSync(viewPath, "utf8").split("\\n").length : 0,
  frozenScriptMatchesCandidate: first === undefined ? false : readFileSync(join(slugDir, RUN_ID, "script.js")).equals(readFileSync(join(slugDir, first.scriptFile))),
  frozenSourceMatchesCandidate: first === undefined ? false : readFileSync(join(slugDir, RUN_ID, "script.ts"), "utf8") === readFileSync(join(slugDir, first.observationsFile + ".candidate.ts"), "utf8"),
}) + "\\n");
`;

/** 一次驱动结果:交给本文件判据。 */
const drive = async (
  mainArchive: string,
  timeoutMs = ELAPSED_CEILING_MS + 60_000,
): Promise<GridFacts> => {
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", ADAPTER, join(repoRoot, GEN_ENTRY), repoRoot, mainArchive],
    { cwd: repoRoot },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const fuse = setTimeout(() => {
    child.kill("SIGKILL");
  }, timeoutMs);
  const status = await new Promise<number | null>((done) => {
    child.on("close", (code) => done(code));
    child.on("error", () => done(null));
  });
  clearTimeout(fuse);
  const line = Buffer.concat(stdout).toString("utf8").trim().split("\n").at(-1) ?? "";
  if (line === "")
    return {
      ok: false,
      message:
        `跑真网格的子进程没有交回结果(退出码 ${String(status)}):` +
        `${Buffer.concat(stderr).toString("utf8").trim()}`,
    };
  try {
    return JSON.parse(line) as GridFacts;
  } catch {
    return { ok: false, message: `跑真网格的子进程交回的不是 JSON:${line}` };
  }
};

const main = async (): Promise<number> => {
  // ── 前置:四份陪练存档在不在(缺哪一份就说哪一份) ──
  const mainArchive = join(repoRoot, "archive");
  const missing = SPARRING.filter(
    (identity) => !existsSync(join(mainArchive, identity.slug, identity.runId, "script.js")),
  );
  if (missing.length > 0) {
    const list = missing
      .map((identity) => `${identity.slug}/${identity.runId}/script.js`)
      .join("、");
    process.stderr.write(
      `✗ 真网格跑不起来:缺 ${String(missing.length)} 份陪练存档(${list})。\n` +
        "  陪练池是钉死的四份身份,换一份就换一张网格——所以这里不收「有就用」,也不 skip。\n" +
        `  这些档不在版本控制里(\`archive/\` 被 gitignore),本机要先跑过一次真实生成才有。\n`,
    );
    return 1;
  }

  const facts = await drive(mainArchive);
  if (!facts.ok) {
    process.stderr.write(`✗ 跑真网格失败:${facts.message ?? ""}\n`);
    return 1;
  }

  const failures: string[] = [];
  const expectedMatches = TRIAL_MATCHES_PER_CANDIDATE;

  if (facts.kind !== "frozen")
    failures.push(`会话没落成成功档(kind = ${String(facts.kind)}):有候选才算成功。`);

  const candidates = facts.candidates ?? [];
  const vacuous = vacuousReason(candidates.length, {
    subject: "候选条目",
    scope: "真网格跑完之后的 optimization.candidates",
  });
  if (vacuous !== "") failures.push(vacuous);
  if (candidates.length > 3)
    failures.push(`候选 ${String(candidates.length)} 条:评测配额是三次,不是三次以上。`);

  for (const candidate of candidates) {
    const step = String(candidate.step);
    // 命名族与步号一一对上(报告侧按这两条判完整性)。
    if (!candidate.observationsFile.endsWith(`-round-${step}.jsonl`))
      failures.push(`候选的观测文件名 ${candidate.observationsFile} 与步号 ${step} 对不上。`);
    if (candidate.scriptFile !== `${candidate.observationsFile}.candidate.js`)
      failures.push(`候选的 scriptFile ${candidate.scriptFile} 不是观测文件的 .candidate.js。`);
    // 场数与分数分母都等于计划场数(不许缩分母)。
    if (candidate.matchCount !== expectedMatches)
      failures.push(
        `候选场数 ${String(candidate.matchCount)} ≠ ${String(expectedMatches)}(分母不许缩)。`,
      );
    if (candidate.score.countedMatches !== expectedMatches)
      failures.push(
        `候选分数的分母 ${String(candidate.score.countedMatches)} ≠ ${String(expectedMatches)}。`,
      );
    // 盘上的字节就是那条候选说的字节。
    for (const name of [
      candidate.observationsFile,
      candidate.scriptFile,
      `${candidate.observationsFile}.candidate.ts`,
      `${candidate.observationsFile}${TRIAL_GRID_SUMMARY_SUFFIX}`,
    ]) {
      if (!(facts.archive ?? []).includes(name)) failures.push(`候选证据族缺文件:${name}。`);
    }
  }

  if (facts.observationLines !== expectedMatches)
    failures.push(
      `观测 ${String(facts.observationLines)} 行 ≠ ${String(expectedMatches)}(没跑满整张网格)。`,
    );
  const indexes = facts.observationIndexes ?? [];
  if (indexes.join(",") !== Array.from({ length: expectedMatches }, (_, index) => index).join(","))
    failures.push(`观测的 matchIndex 不是 0..${String(expectedMatches - 1)}(缺场或重复)。`);
  if (facts.planMatches !== expectedMatches)
    failures.push(
      `旁挂汇总里的计划 ${String(facts.planMatches)} 场 ≠ ${String(expectedMatches)}。`,
    );
  if (facts.gridScriptSha256 !== candidates[0]?.scriptSha256)
    failures.push("旁挂汇总说的是另一份产物(scriptSha256 不符)。");
  // 胜者取末位候选:冻结的三件套与末位那一份字节同源。
  const final = candidates[candidates.length - 1];
  if (final !== undefined && facts.scriptSha256 !== final.scriptSha256)
    failures.push("meta.scriptSha256 不是末位候选的产物哈希(成绩取最后一次 evaluate 的那一版)。");
  if (facts.frozenScriptMatchesCandidate !== true)
    failures.push("冻结的 script.js 与末位候选字节不相等。");
  if (facts.frozenSourceMatchesCandidate !== true)
    failures.push("冻结的 script.ts 与末位候选源码不相等。");

  // 观测外置:stdout 只有聚合 + 指针,逐场明细在文件里。
  const stdout = facts.evaluateStdout ?? "";
  if (!stdout.includes("一、对差表")) failures.push("evaluate 的 stdout 上没有聚合对差表。");
  if (stdout.includes("二、逐场一行"))
    failures.push("evaluate 的 stdout 上出现了逐场明细(那该在观测文件里)。");
  if (!/完整观测:\/workspace\/\.observations\/\d+\.md/u.test(stdout))
    failures.push("evaluate 的 stdout 上没有「完整观测:<路径>」那一行。");
  if ((facts.viewLines ?? 0) < 40) failures.push("工作区里那份完整观测太短(逐场明细没落盘?)。");

  const elapsedMs = facts.elapsedMs ?? 0;
  if (elapsedMs > ELAPSED_CEILING_MS)
    failures.push(
      `跑一张网格用了 ${String(elapsedMs)} ms,超过硬上限 ${String(ELAPSED_CEILING_MS)} ms。`,
    );

  if (failures.length > 0) {
    process.stderr.write("✗ 一次 evaluate 真跑满一张网格\n");
    for (const failure of failures) process.stderr.write(`  ✗ ${failure}\n`);
    return 1;
  }
  process.stdout.write(
    `✓ 一次 evaluate 真跑满一张网格:${String(expectedMatches)} 场齐、候选 ${String(candidates.length)} 条、` +
      `胜者=末位候选、观测外置(${String(facts.viewLines ?? 0)} 行在工作区)。` +
      `实测耗时 ${(elapsedMs / 1_000).toFixed(1)}s(与既有试跑同一个入口,同一张计划)。\n` +
      `  落点:${facts.root}(${String(facts.runId)};archive/alpha/ 下 ${String((facts.archive ?? []).length)} 个条目)\n`,
  );
  return 0;
};

process.exitCode = await main();
