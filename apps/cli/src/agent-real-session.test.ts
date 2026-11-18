/**
 * 一场**真会话**的端到端验证:`bwrap` 真起进程、档案真落盘、真装载得进。
 *
 * ── 为什么不做成「打真模型」的用例 ──
 *
 * 打真模型要凭证与网络,而凭证不进版本库(`models.yaml` 被 gitignore)。那种用例在 CI 里
 * 只有两条路:skip(等于没有)或常红(等于噪声)。所以这里换掉的只有**模型**那一端:
 * `stubClient` 回一段固定的动作序列,其余——沙箱隔离、单步墙钟、fd 3 通道、宿主服务、
 * 冻结期编译与静态校验、档案组装与装载——全部是真实现。
 *
 * 这正是票面允许的那条替代:「有凭证缺失时用 `stubClient` + 真 bwrap 的形态验证『档案写得
 * 出来、装载得进』——但必须真跑一次 bwrap,不许全程假执行器」。
 *
 * ── 它证明什么、不证明什么 ──
 *
 * 证明:一条从「模型说要做什么」到「盘上有一份可装载的 v3 档案」的路是通的,而且中间每一站
 * 都是真的(隔离、通道、编译、校验、装载器)。
 * 不证明:模型行为。那是模型的属性,不是管线的属性(ADR-0029 已把这句话写进「等价这件事的
 * 能力边界」)。
 *
 * ── 判据是「装载器不红」 ──
 *
 * `readArchiveReports` 是读侧的入口:它对 v3 形状、候选关系、文件字节哈希逐条校验。它读得出来
 * 就说明这份档**自洽**:身份字段成套、轮数等于过程记录条数、候选的旁挂文件真的在且哈希对得
 * 上、起止 prompt 条数符合公式。
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, expect, it } from "vitest";
import { RULESET_VERSION, TRIAL_MATCHES_PER_CANDIDATE, type ArchiveMeta } from "@model-war/schema";
import { readArchiveReports } from "@model-war/runner";

import { HARNESS_DIGEST, HARNESS_VERSION, generateOneModel } from "@model-war/gen";
import type { ModelConfig } from "@model-war/gen";
import { completeGridTrial, gridPlanFixture, reply, stubClient } from "@model-war/gen";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const scratch = mkdtempSync(join(tmpdir(), "modelwar-real-session-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const SCRIPT = `var ticks = 0;
function loop() {
  ticks += 1;
  return ticks;
}
`;

/**
 * 造一个能给**真沙箱**用的安装根。
 *
 * `bwrap` 只把两棵子树 bind 进沙箱(入库 rootfs 的 `bin/` 与 `contract/`),所以这里需要的是
 * 宿主侧的安装面:规则集(`check` 服务读体积上限)、符号链接回仓库的依赖(冻结期要跑真 tsc
 * 与真静态校验器)。
 */
const mkRoot = (): string => {
  const root = mkdtempSync(join(scratch, "root-"));
  for (const relative of ["node_modules", "packages"])
    symlinkSync(join(repoRoot, relative), join(root, relative), "dir");
  writeFileSync(
    join(root, "tsconfig.scripts.json"),
    readFileSync(join(repoRoot, "tsconfig.scripts.json")),
  );
  mkdirSync(join(root, "rulesets"), { recursive: true });
  writeFileSync(
    join(root, "rulesets", `${RULESET_VERSION}.json`),
    readFileSync(join(repoRoot, `rulesets/${RULESET_VERSION}.json`)),
  );
  return root;
};

const configOf = (): ModelConfig => ({
  slug: "alpha",
  endpointFamily: "chat-completions",
  baseUrl: "https://example.invalid/v1",
  modelId: "vendor/alpha",
  credentialEnvVar: "TEST_KEY",
  channelId: "test-channel",
  contextLength: 100_000,
});

it("真 bwrap 的一场会话:写出可装载的 v3 档案", { timeout: 180_000 }, async () => {
  const root = mkRoot();
  const workspaceDir = join(root, "ws");
  mkdirSync(workspaceDir, { recursive: true });

  // 四步:写脚本 → 跑 check → evaluate → done。每一步都是一次真的 `sandbox.run`。
  const model = stubClient([
    reply(`\`\`\`bash\ncat > /workspace/script.ts <<'EOF'\n${SCRIPT}EOF\n\`\`\``),
    reply("```bash\ncheck\n```"),
    reply("```bash\nevaluate\n```"),
    reply("```bash\ndone\n```"),
  ]);

  const outcome = await generateOneModel(
    {
      root,
      runId: "r-real",
      agentPrompt: { user: "任务:在 /workspace 写 script.ts", system: "协议:每一步一个动作块" },
      createClient: () => model,
      workspaceDir,
      // 时钟取当下:会话墙钟 = 起点 + 1800s。
      now: () => new Date(),
      // 试跑桩:这条用例验的是「真 bwrap + 真通道 + 真档案」,网格本身由 `check:gen-grid`
      // 那一侧用真子进程验。桩写的是**形状真实**的一整张网格(32 行观测 + 旁挂汇总),
      // 于是「有候选 → 成功档 → 报告读得出候选」这一整条链在真沙箱下走过一遍(票 05 残余风险 3:
      // `freezeFromCandidate` 在真 bwrap 下没走过)。
      trial: completeGridTrial(),
      trialPlan: () => gridPlanFixture(),
    },
    configOf(),
  );

  expect(outcome.kind).toBe("frozen");
  const meta = JSON.parse(
    readFileSync(join(root, "archive/alpha/r-real/meta.json"), "utf8"),
  ) as ArchiveMeta;

  // ── 身份与形状 ──
  expect(meta.archiveSchemaVersion).toBe(3);
  expect(meta.harnessVersion).toBe(HARNESS_VERSION);
  expect(meta.harnessDigest).toBe(HARNESS_DIGEST);
  expect(meta.contextLength).toBe(100_000);
  expect(meta.termination).toBe("done");
  expect(meta.atStep).toBe(4);

  // ── 步 = 一次模型调用;四步里第三步那次 evaluate 产出一个候选 ──
  expect(meta.steps).toHaveLength(4);
  expect(meta.protocolRounds).toBe(4);
  expect(meta.prompts).toHaveLength(1);
  expect(meta.steps?.map((step) => step.action.kind)).toEqual(["bash", "bash", "evaluate", "done"]);

  // ── 真沙箱里跑出来的东西真的在:写文件那步的退出码是 0,check 那步有 tsc 版本 ──
  expect(meta.steps?.[0]?.exitCode).toBe(0);
  expect(meta.steps?.[1]?.stdout).toContain("类型检查通过");
  // 结果侧证据:check 那一步带着契约侧的规则标签(通过时是空集合)。
  expect(meta.steps?.[1]?.result).toBeUndefined();
  // evaluate 那一步真的产出了观测出口。
  expect(meta.steps?.[2]?.stdout).toContain("完整观测");

  // ── 候选的旁挂快照真的在盘上,哈希对得上 ──
  expect(meta.optimization).toMatchObject({ version: 3 });
  const optimization = meta.optimization as unknown as {
    candidates: {
      step: number;
      scriptFile: string;
      observationsFile: string;
      scriptSha256: string;
      score: { countedMatches: number };
    }[];
  };
  // 候选条数 1..3:这次只评了一次。
  expect(optimization.candidates).toHaveLength(1);
  const candidate = optimization.candidates[0]!;
  expect(candidate.step).toBe(3);
  const candidateBytes = readFileSync(join(root, "archive/alpha", candidate.scriptFile));
  expect(candidateBytes.byteLength).toBeGreaterThan(0);
  // 候选条目的 `scriptSha256` 是**产物**字节的哈希(报告侧复算的就是它)。
  expect(createHash("sha256").update(candidateBytes).digest("hex")).toBe(candidate.scriptSha256);
  // 冻结的三件套就是胜者(这里只有一个候选 = 末位候选)的那份产物字节。
  expect(meta.scriptSha256).toBe(candidate.scriptSha256);
  expect(readFileSync(join(root, "archive/alpha/r-real/script.js")).equals(candidateBytes)).toBe(
    true,
  );
  expect(readFileSync(join(root, "archive/alpha/r-real/script.ts"), "utf8")).toBe(
    readFileSync(join(root, "archive/alpha", `${candidate.observationsFile}.candidate.ts`), "utf8"),
  );
  // 成绩取的是网格汇总那一份(32 场的分母),不是某个局部读数。
  expect(candidate.score.countedMatches).toBe(TRIAL_MATCHES_PER_CANDIDATE);

  // ── 装载器读得出来:这一步才是「可装载」的判据 ──
  const [report] = readArchiveReports(root);
  expect(report?.protocolRounds).toBe(4);
  expect(report?.rounds).toHaveLength(4);
  // 报告侧认得出这个候选:字节哈希对得上、观测行数等于计划场数(32)。
  expect(report?.kind).toBe("success");
  // 只有一个候选:它既是首候选也是末候选(没有 selection 时胜者取末位,ADR-0030/0031)。
  expect(report?.intermediateCandidates).toHaveLength(0);
  expect(report?.initialCandidate?.scriptFile).toBe(candidate.scriptFile);
  expect(report?.initialCandidate?.scriptState).toBe("verified");
  expect(report?.initialCandidate?.observations.state).toBe("recorded");
  expect(report?.initialCandidate?.observations.observedMatches).toBe(TRIAL_MATCHES_PER_CANDIDATE);
  expect(report?.finalCandidate?.scriptFile).toBe(candidate.scriptFile);
  expect(report?.frozenCandidate?.scriptFile).toBe(candidate.scriptFile);
  // 报告侧也认得出这张网格给出的分数(它读的就是候选条目里的那一格)。
  expect(report?.initialCandidate?.score?.countedMatches).toBe(TRIAL_MATCHES_PER_CANDIDATE);
});

it(
  "真 bwrap 的一场零候选会话:落成同形失败档,装载器同样读得出来",
  { timeout: 180_000 },
  async () => {
    const root = mkRoot();
    const workspaceDir = join(root, "ws");
    mkdirSync(workspaceDir, { recursive: true });

    // 只 done、不 evaluate:一个候选都没有(ADR-0030「失败 = 一个候选都没有」)。
    const model = stubClient([reply("```bash\nls /contract\n```"), reply("```bash\ndone\n```")]);

    const outcome = await generateOneModel(
      {
        root,
        runId: "r-real-fail",
        agentPrompt: { user: "任务:在 /workspace 写 script.ts", system: "协议:每一步一个动作块" },
        createClient: () => model,
        workspaceDir,
        now: () => new Date(),
        trial: completeGridTrial(),
        trialPlan: () => gridPlanFixture(),
      },
      configOf(),
    );

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    // 失败档与成功档**同键集合**:过程记录、身份、终止原因都在(ADR-0031)。
    expect(outcome.agent.steps).toHaveLength(2);
    expect(outcome.agent.termination).toBe("done");
    expect(outcome.agent.atStep).toBe(2);
    expect(outcome.failure.prompts).toEqual([]);

    // 第一步真的跑在沙箱里:`ls /contract` 列出了契约目录那四个文件。
    expect(outcome.agent.steps[0]?.stdout).toContain("README.md");
    expect(outcome.agent.steps[0]?.exitCode).toBe(0);
  },
);
