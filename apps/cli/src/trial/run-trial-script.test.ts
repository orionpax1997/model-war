/**
 * 试跑入口（子进程）的**协议面**：参数、计划打印、`--expected-plan` 比对与退出码。
 *
 * ── 这里不跑整张网格 ──
 *
 * 整张网格是 32 场真对局（实测约 90 秒），那是门禁/慢速测试的量级。执行器本身的形状（每格一行
 * 观测、不早停、汇总与计划逐字一致）由 `grid.test.ts` 用**缩小网格**在进程内覆盖；这里只钉
 * 「入口这一层」：缺参数怎么退、`--plan` 打印什么、预期计划不符时退出 2 并指名哪一处、以及
 * 什么都不写（不覆盖既有证据）。
 *
 * ── 为什么 `--plan` 那两条要 `skipIf` ──
 *
 * 造计划要把四份陪练解析到 `archive/<slug>/<runId>/script.js` 并比对**钉死的内容摘要**。
 * 夹具造不出「摘要刚好等于钉死值」的字节（那正是摘要的意义），所以这两条只在本地有真存档时跑；
 * 计划的形状与摘要覆盖由 `packages/runner/src/trial-plan.test.ts` 无盘覆盖。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, expect, it } from "vitest";
import {
  RULESET_VERSION,
  TRIAL_GRID_MAP_NAMES,
  TRIAL_GRID_SEED_BASE,
  TRIAL_MATCHES_PER_CANDIDATE,
  TRIAL_SPARRING_LADDER,
  type JsonValue,
  type TrialPlan,
} from "@model-war/schema";
import { hashOf } from "@model-war/runner";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "modelwar-trial-entry-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const archivePresent = TRIAL_SPARRING_LADDER.every((identity) =>
  existsSync(join(repoRoot, "archive", identity.id, identity.runId, "script.js")),
);

const invoke = (args: readonly string[]) =>
  spawnSync(
    process.execPath,
    [join(repoRoot, "apps/cli/dist/trial/run-trial-script.js"), ...args],
    { encoding: "utf8", timeout: 30_000 },
  );

/** 一个**没有归档陪练**的安装面：四份陪练缺档，装载必须指名失败而不是静默降级。 */
const installWithoutSparring = (): string => {
  const root = mkdtempSync(join(scratch, "root-"));
  for (const name of ["packages", "node_modules", "maps", "apps"]) {
    symlinkSync(join(repoRoot, name), join(root, name), "dir");
  }
  mkdirSync(join(root, "rulesets"));
  writeFileSync(
    join(root, "rulesets", `${RULESET_VERSION}.json`),
    readFileSync(join(repoRoot, "rulesets", `${RULESET_VERSION}.json`)),
  );
  return root;
};

const MODEL = "gpt-6.1-sol";

it("缺 --model 即退出 2 并给出用法：在位陪练随模型而定，不能猜", () => {
  const result = invoke(["--plan", "--root", repoRoot]);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("缺 --model");
  expect(result.stderr).toContain("--model");
});

it("缺候选产物即退出 2 并给出用法", () => {
  const result = invoke(["--root", repoRoot, "--model", MODEL]);
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("缺候选产物参数");
});

it("陪练缺档即退出 2 并指名是哪一份：装载失败不是计划、也不跑任何一场", () => {
  const root = installWithoutSparring();
  const result = invoke(["--plan", "--root", root, "--model", "brand-new-model"]);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(2);
  expect(result.stdout).toBe("");
  // 指名到「哪一份、哪个路径」：榜首（top）那一份的存档脚本读不到。
  expect(result.stderr).toContain("陪练池装载失败");
  expect(result.stderr).toContain("top");
  expect(result.stderr).toContain("script.js");

  const observations = join(scratch, "never.jsonl");
  const ran = invoke([
    join(root, "candidate.js"),
    "--root",
    root,
    "--model",
    "brand-new-model",
    "--observations",
    observations,
  ]);
  expect(ran.status, ran.stderr).toBe(2);
  expect(existsSync(observations)).toBe(false);
});

it.skipIf(!archivePresent)(
  "--plan 打印网格计划：32 场、两张图、四份角色限定陪练、摘要可由正文复算，两次逐字相同",
  { timeout: 60_000 },
  () => {
    const first = invoke(["--plan", "--root", repoRoot, "--model", MODEL]);
    expect(first.error).toBeUndefined();
    expect(first.status, first.stderr).toBe(0);
    const plan = JSON.parse(first.stdout) as TrialPlan;
    expect(plan.version).toBe(2);
    expect(plan.matches).toHaveLength(TRIAL_MATCHES_PER_CANDIDATE);
    expect(plan.matchesPerCandidate).toBe(TRIAL_MATCHES_PER_CANDIDATE);
    expect(plan.matches.map((match) => match.seed)).toEqual(
      Array.from({ length: 32 }, (_, index) => TRIAL_GRID_SEED_BASE + index),
    );
    // 地图摘要取自盘上字节（两张都读，顺序固定）。
    expect(plan.maps.map((map) => map.name)).toEqual([...TRIAL_GRID_MAP_NAMES]);
    for (const map of plan.maps) {
      expect(map.sha256).toBe(
        createHash("sha256")
          .update(readFileSync(join(repoRoot, "maps", `${map.name}.json`)))
          .digest("hex"),
      );
    }
    // 四份陪练：角色限定 id、存档来源、摘要取自同一份字节。
    expect(plan.scripts.map((script) => script.role)).toEqual(["top", "mid", "last", "incumbent"]);
    for (const script of plan.scripts) {
      expect(script.id.startsWith(`${script.role}:`)).toBe(true);
      expect(script.source.startsWith("archive:")).toBe(true);
      expect(script.scriptSha256).toMatch(/^[0-9a-f]{64}$/);
    }
    // 候选四个座位各 8 场；每张图 16 场。
    const seats = new Map<number, number>();
    const maps = new Map<string, number>();
    for (const match of plan.matches) {
      seats.set(match.candidateSeat, (seats.get(match.candidateSeat) ?? 0) + 1);
      maps.set(match.map, (maps.get(match.map) ?? 0) + 1);
    }
    expect([...seats.values()]).toEqual([8, 8, 8, 8]);
    expect([...maps.values()]).toEqual([16, 16]);
    // 摘要只覆盖正文：剥掉它再复算必须逐字相等；同一次安装面两次打印逐字相同。
    const { planSha256, ...body } = plan;
    expect(planSha256).toBe(hashOf(JSON.parse(JSON.stringify(body)) as JsonValue));
    const second = invoke(["--plan", "--root", repoRoot, "--model", MODEL]);
    expect(second.stdout).toBe(first.stdout);
  },
);

it.skipIf(!archivePresent)(
  "--expected-plan 与现场事实不符 → 退出 2、指名具体路径、一个字都不写",
  { timeout: 60_000 },
  () => {
    const printed = invoke(["--plan", "--root", repoRoot, "--model", MODEL]);
    expect(printed.status, printed.stderr).toBe(0);
    const plan = JSON.parse(printed.stdout) as TrialPlan;
    const candidatePath = join(scratch, "candidate.js");
    writeFileSync(candidatePath, "function loop() {}\n");

    const observations = join(scratch, "tampered.jsonl");
    const tampered: TrialPlan = {
      ...plan,
      matches: plan.matches.map((match, index) => (index === 1 ? { ...match, seed: 999 } : match)),
    };
    const planPath = join(scratch, "tampered-plan.json");
    writeFileSync(planPath, JSON.stringify(tampered));
    const ran = invoke([
      candidatePath,
      "--root",
      repoRoot,
      "--model",
      MODEL,
      "--observations",
      observations,
      "--expected-plan",
      planPath,
    ]);
    expect(ran.status, ran.stderr).toBe(2);
    expect(ran.stdout).toBe("");
    expect(ran.stderr).toMatch(/matches\[1\]\.seed/);
    expect(existsSync(observations)).toBe(false);
    expect(existsSync(`${observations}.grid.json`)).toBe(false);

    // 连摘要一起重算也不行：场次由事实派生，改了就重建不出来。
    const { planSha256, ...body } = tampered;
    void planSha256;
    const rehashedPath = join(scratch, "rehashed-plan.json");
    writeFileSync(
      rehashedPath,
      JSON.stringify({ ...body, planSha256: hashOf(JSON.parse(JSON.stringify(body))) }),
    );
    const rehashed = invoke([
      candidatePath,
      "--root",
      repoRoot,
      "--model",
      MODEL,
      "--observations",
      observations,
      "--expected-plan",
      rehashedPath,
    ]);
    expect(rehashed.status, rehashed.stderr).toBe(2);
    expect(rehashed.stderr).toMatch(/matches\[1\]\.seed/);
    expect(existsSync(observations)).toBe(false);
  },
);
