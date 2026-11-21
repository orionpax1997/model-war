/**
 * 一场**假执行器**下的完整会话:动作 → 观测 → 候选 → v3 档案 → 装载。
 *
 * ── 它为什么在这里,以及它与 `agent-real-session.test.ts` 的分工 ──
 *
 * 「档案写得出来、装载得进」这条判据在常跑链上就必须有人盯着,而它**不需要**内核能力:
 * 沙箱只负责「命令跑在哪一层进程里」,`check` / `evaluate` 的答案、编译、校验、落档都不经过它。
 * 所以这里把执行器换成宿主 `bash`(`@model-war/gen/testing` 的 `withRealBash`),通道、宿主服务与
 * 归档三侧全部是真实现。同一套断言在真 bwrap 下的那一份住
 * `apps/cli/src/agent-real-session.test.ts`,由命名脚本 `check:sandbox` 跑(那里有 bubblewrap);
 * 本文件跑在 `unit`(常跑链),不装 bubblewrap 也绿。
 *
 * 两个文件断言的是**同一件事**,不是两件事:一份证明「这条链在真隔离里也通」,一份证明「它在
 * 每轮编辑循环里也通」。少了前一份,沙箱与管线会各绿各的;少了这一份,闸门就只剩门禁那一侧,
 * 而门禁不在 `verify:fast` 上。
 *
 * ── 判据是「装载器不红」 ──
 *
 * `readArchiveReports` 是读侧入口:它对 v3 形状、候选关系、文件字节哈希逐条校验。它读得出来,
 * 就说明这份档**自洽**:身份字段成套、轮数等于过程记录条数、候选的旁挂文件真的在且哈希对得上。
 */

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

import { afterAll, expect, it } from "vitest";
import {
  ARCHIVE_SCHEMA_VERSION,
  RULESET_VERSION,
  TRIAL_MATCHES_PER_CANDIDATE,
  type ArchiveMeta,
} from "@model-war/schema";
import { readArchiveReports } from "@model-war/runner";
import {
  HARNESS_DIGEST,
  HARNESS_VERSION,
  TransportError,
  completeGridTrial,
  fail,
  generateOneModel,
  gridPlanFixture,
  stubClient,
  toolCall,
  type ModelConfig,
} from "@model-war/gen";
import { withRealBash } from "@model-war/gen/testing";

/** 一次 `bash` 工具调用:参数是原始 JSON 字符串,与渠道形状同构(桩不帮忙序列化)。 */
const bashOf = (command: string) => toolCall("bash", JSON.stringify({ command }));

/** 一次不收参数的工具调用(`check` / `probe` / `evaluate` / `finish`)。 */
const toolOf = (name: string) => toolCall(name, "{}");

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "modelwar-agent-session-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * 造一个能真跑整条链的安装根:符号链接回仓库的依赖(真 tsc、真静态校验器、真薄壳)与规则集
 * (`check` 服务读体积上限)。
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

it("一场会话:写出可装载的 v3 档案,报告读得出候选", { timeout: 120_000 }, async () => {
  const root = mkRoot();
  const workspaceDir = join(root, "ws");
  mkdirSync(workspaceDir, { recursive: true });

  // 四步:写脚本 → 跑 check → evaluate → done。工具命令经通道打到宿主服务,其余在宿主 bash 里跑。
  // 第一步写脚本。这里用 heredoc 而不是首条消息的起手式(`cp`):假执行器只把 `/workspace`
  // 改写成宿主路径,`/contract` 在宿主上不存在——「沙箱里有没有 `cp`」是**内容物**的事实,
  // 只有真 bwrap 那条用例(以及 `check:sandbox-rootfs` 的文件集门禁)能判它。
  const model = stubClient([
    bashOf("cat > /workspace/script.ts <<'EOF'\nfunction loop() {}\nEOF"),
    toolOf("check"),
    toolOf("evaluate"),
    toolOf("finish"),
  ]);

  const outcome = await withRealBash(workspaceDir, () =>
    generateOneModel(
      {
        root,
        runId: "r-fake",
        agentPrompt: { user: "任务:在 /workspace 写 script.ts", system: "协议:每一步一个动作块" },
        createClient: () => model,
        workspaceDir,
        now: () => new Date(),
        // 试跑桩:形状真实的一整张网格(32 行观测 + 旁挂汇总)。真子进程那张网格由
        // `check:gen-grid` 验,这里验的是「有候选 → 成功档 → 报告读得出」。
        trial: completeGridTrial(),
        trialPlan: () => gridPlanFixture(),
      },
      configOf(),
    ),
  );

  expect(outcome.kind).toBe("frozen");
  const meta = JSON.parse(
    readFileSync(join(root, "archive/alpha/r-fake/meta.json"), "utf8"),
  ) as ArchiveMeta;

  // ── 身份与形状 ──
  expect(meta.archiveSchemaVersion).toBe(ARCHIVE_SCHEMA_VERSION);
  expect(meta.harnessVersion).toBe(HARNESS_VERSION);
  expect(meta.harnessDigest).toBe(HARNESS_DIGEST);
  expect(meta.contextLength).toBe(100_000);
  expect(meta.termination).toBe("done");
  expect(meta.atStep).toBe(4);

  // ── 步 = 一次模型调用;四步里第三步那次 evaluate 产出一个候选 ──
  expect(meta.steps).toHaveLength(4);
  expect(meta.protocolRounds).toBe(4);
  expect(meta.prompts).toHaveLength(1);
  // `check` 现在是独立一档:新世界里没有一次 `bash -c` 跑过它。
  expect(meta.steps?.map((step) => step.action.kind)).toEqual([
    "bash",
    "check",
    "evaluate",
    "done",
  ]);
  // 假执行器改写的是路径前缀,不是服务:`check` 仍然真跑了 tsc。
  expect(meta.steps?.[0]?.exitCode).toBe(0);
  expect(meta.steps?.[1]?.stdout).toContain("类型检查通过");
  // evaluate 那一步真的产出了观测出口(聚合对差表 + 一行路径)。
  expect(meta.steps?.[2]?.stdout).toContain("完整观测");

  // ── 候选的旁挂快照在盘上,哈希对得上 ──
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
  expect(optimization.candidates).toHaveLength(1);
  const candidate = optimization.candidates[0]!;
  expect(candidate.step).toBe(3);
  const candidateBytes = readFileSync(join(root, "archive/alpha", candidate.scriptFile));
  expect(candidateBytes.byteLength).toBeGreaterThan(0);
  // 候选条目的 `scriptSha256` 是**产物**字节的哈希(报告侧复算的就是它)。
  expect(createHash("sha256").update(candidateBytes).digest("hex")).toBe(candidate.scriptSha256);
  // 冻结的三件套就是胜者(这里只有一个候选 = 末位候选)的那份字节。
  expect(meta.scriptSha256).toBe(candidate.scriptSha256);
  expect(readFileSync(join(root, "archive/alpha/r-fake/script.js")).equals(candidateBytes)).toBe(
    true,
  );
  expect(readFileSync(join(root, "archive/alpha/r-fake/script.ts"))).toEqual(
    readFileSync(join(root, "archive/alpha", `${candidate.observationsFile}.candidate.ts`)),
  );

  // ── 装载器读得出来:这一步才是「可装载」的判据 ──
  const [report] = readArchiveReports(root);
  expect(report?.protocolRounds).toBe(4);
  expect(report?.rounds).toHaveLength(4);
  expect(report?.kind).toBe("success");
  // 只有一个候选:它既是首候选也是末候选(没有 selection 时胜者取末位,ADR-0030/0031)。
  expect(report?.intermediateCandidates).toHaveLength(0);
  expect(report?.initialCandidate?.scriptFile).toBe(candidate.scriptFile);
  expect(report?.initialCandidate?.scriptState).toBe("verified");
  expect(report?.initialCandidate?.observations.state).toBe("recorded");
  expect(report?.initialCandidate?.observations.observedMatches).toBe(TRIAL_MATCHES_PER_CANDIDATE);
  expect(report?.frozenCandidate?.scriptFile).toBe(candidate.scriptFile);
  expect(report?.initialCandidate?.score?.countedMatches).toBe(TRIAL_MATCHES_PER_CANDIDATE);
  // 没退避过的会话写 `0`（真的等了 0），而不是缺数据：读侧读到的是 0 而不是 null。
  expect(
    meta.generationLog.map((line) => (JSON.parse(line) as { backoffMs?: number }).backoffMs),
  ).toEqual([0, 0, 0, 0]);
  expect(report?.contamination?.backoffMs).toBe(0);
});

it("零候选会话:落成同形失败档,且 archive/<slug>/ 里不留旁挂产物", async () => {
  const root = mkRoot();
  const workspaceDir = join(root, "ws");
  mkdirSync(workspaceDir, { recursive: true });

  // 只 done、不 evaluate:一个候选都没有(ADR-0030「失败 = 一个候选都没有」)。
  const model = stubClient([bashOf("ls /contract"), toolOf("finish")]);

  const outcome = await withRealBash(workspaceDir, () =>
    generateOneModel(
      {
        root,
        runId: "r-fake-fail",
        agentPrompt: { user: "任务:在 /workspace 写 script.ts", system: "协议:每一步一个动作块" },
        createClient: () => model,
        workspaceDir,
        now: () => new Date(),
        trial: completeGridTrial(),
        trialPlan: () => gridPlanFixture(),
      },
      configOf(),
    ),
  );

  expect(outcome.kind).toBe("failed");
  if (outcome.kind !== "failed") return;
  // 失败档与成功档**同键集合**:过程记录、身份、终止原因都在(ADR-0031)。
  expect(outcome.agent.steps).toHaveLength(2);
  expect(outcome.agent.termination).toBe("done");
  expect(outcome.agent.atStep).toBe(2);
  expect(outcome.failure.prompts).toEqual([]);
  // 发布不变量「失败只写 failed-<runId>.json」:这里连失败记录都没写(generateOneModel 不收口),
  // 所以目录该是空的。
  expect(readdirSync(join(root, "archive/alpha"))).toEqual([]);
});

it("429 两次:实测退避落进日志行,报告受污染读数读到同一个合计", { timeout: 120_000 }, async () => {
  // ADR-0036 的两段判据（累计退避 / 429 次数）里，前一段原先没有落点：报告写着「生成侧日志行
  // 还不记退避时延」。这条用例是那段判据的写→读往返：会话真撞两次 429、真退避，报告读到合计。
  //
  // 「真退避」靠注入的时钟与 `sleep` 达成（不真坐 1s / 2s，否则这条用例会跟机器负载赛跑）：
  // `sleep` 每次让钟多走 137 ms，于是「实测 = 钟走了多少」与「请求值之和」在这条用例里是两个
  // 不同的数，记错哪一个当场就露。
  const root = mkRoot();
  const workspaceDir = join(root, "ws");
  mkdirSync(workspaceDir, { recursive: true });

  const base = Date.now();
  let requested = 0;
  let clock = 0;
  // 第一步连吃两次 429（退避 1s → 2s）后成功，其余三步照「一场会话」那条用例的剧本走完，
  // 于是这份档是成功档：`meta.json` 里既有候选、也有四行生成日志。
  const model = stubClient([
    fail(new TransportError("被限流", { retryable: true, status: 429 })),
    fail(new TransportError("被限流", { retryable: true, status: 429 })),
    bashOf("cat > /workspace/script.ts <<'EOF'\nfunction loop() {}\nEOF"),
    toolOf("check"),
    toolOf("evaluate"),
    toolOf("finish"),
  ]);

  const outcome = await withRealBash(workspaceDir, () =>
    generateOneModel(
      {
        root,
        runId: "r-backoff",
        agentPrompt: { user: "任务:在 /workspace 写 script.ts", system: "协议:每一步一个动作块" },
        createClient: () => model,
        workspaceDir,
        now: () => new Date(base + clock),
        sleep: async (ms) => {
          requested += ms;
          clock += ms + 137;
        },
        trial: completeGridTrial(),
        trialPlan: () => gridPlanFixture(),
      },
      configOf(),
    ),
  );

  expect(outcome.kind).toBe("frozen");
  const meta = JSON.parse(
    readFileSync(join(root, "archive/alpha/r-backoff/meta.json"), "utf8"),
  ) as ArchiveMeta;
  const logs = meta.generationLog.map(
    (line) => JSON.parse(line) as { backoffMs?: number; attemptEvidence?: unknown[] },
  );
  // 第一步：两次 429 + 一次成功 = 三条尝试证据，退避记账取实测而不是请求值。
  expect(logs[0]?.attemptEvidence).toHaveLength(3);
  expect(logs[0]?.backoffMs).toBe(clock);
  expect(logs[0]?.backoffMs).toBeGreaterThan(requested);
  expect(requested).toBeGreaterThanOrEqual(3_000);
  // 其余三步没退避：写 0（真的等了 0），不是缺数据。
  expect(logs.slice(1).map((line) => line.backoffMs)).toEqual([0, 0, 0]);

  const [report] = readArchiveReports(root);
  expect(report?.rounds[0]?.backoffMs).toBe(clock);
  // 合计 = 四轮的退避之和；两段判据都读得出来，这一段不再靠 429 次数独撑。
  expect(report?.contamination).toEqual({
    state: "clean",
    rateLimitedAttempts: 2,
    backoffMs: clock,
    reasons: [],
  });
});
