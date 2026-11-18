/**
 * CLI 接线冒烟(Testing Decisions 的既有缝:子进程 + 本地假端点)。
 *
 * spawn **打好的单文件 CLI 产物** `modelwar gen --config models.yaml --root <临时根>`,端点指向
 * `node:http` 起的**本地假服务**(回一个过得了 tsc + 静态校验的合法脚本),`.env` 写在临时根里提供
 * 假凭证;断言退出码 0 + `archive/<slug>/<runId>/` 三件套落地。
 *
 * ── 为什么不改 `cli.test.ts` ──
 *
 * 契约 §6 给 05 留的缝是「补一条 CLI 子进程冒烟」;`cli.test.ts` 的既有断言(帮助文本、未实现路径、
 * match/verify/map-lint e2e)不在本文件范围。这里新开一个文件,既不把那条 27KB 的用例集撑得更大,
 * 也让这条冒烟的可观察面(真打一次 HTTP、真编一次 tsc)单独成篇。
 *
 * ── 为什么用异步 `spawn` 而不是 `spawnSync` ──
 *
 * 假端点跑在**本进程**里:`spawnSync` 会阻塞本进程事件循环,子进程的请求就永远等不到响应(死锁)。
 * 所以这里 await 子进程退出的同时让事件循环继续转(端点才能应答)。
 *
 * ── 为什么不在这里再跑一次 `tsc -b` ──
 *
 * `vitest.global-setup.ts` 在任何测试模块加载前已把工作区包的 `dist/` 备齐,esbuild 才解析得到
 * `@model-war/gen` 的 `exports`。再补一次会与 `cli.test.ts` 的 `beforeAll` 并发写同一份 dist。
 */

import { spawn } from "node:child_process";
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
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  RULESET_VERSION,
  TRIAL_GRID_MAP_NAMES,
  TRIAL_GRID_SUMMARY_SUFFIX,
  TRIAL_MATCHES_PER_CANDIDATE,
  TRIAL_SPARRING_LADDER,
  TRIAL_SPARRING_SUBSTITUTE,
} from "@model-war/schema";
import { afterAll, beforeAll, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const entry = fileURLToPath(new URL("./index.ts", import.meta.url));

const CONTRACT_RULES = "# rules\n\n机制正文:这里是规则契约。\n";
const CONTRACT_API = "# api\n\nAPI 正文:这里是接口契约。\n";
/** 契约目录说明(首条消息全量内联的那一份)。 */
const CONTRACT_INDEX = "# contract\n\n- rules.md:机制\n- api.md:接口\n";
/**
 * 一条「把脚本写进 /workspace」的动作块。
 *
 * 走 heredoc:模型在沙箱里写文件的自然写法,也是 ADR-0032 举的那一种(重定向 + heredoc)。
 * 写成动作块而不是裸脚本正文,是 agent 形态与 one-shot 的分界线——裸正文不会被解析成任何动作。
 */
const writeScriptAction = (body: string): string =>
  `\`\`\`bash\ncat > /workspace/script.ts <<'EOF'\n${body}EOF\n\`\`\``;

/** 首条 `user` 的模板:两个占位符都得在,否则渲染器明确报错。 */
const AGENT_TEMPLATE = "{{contractIndex}}\n\n任务:\n\ncontract: {{contractDigest}}\n";
/** `system` 的模板:原样使用,不渲染。 */
const AGENT_SYSTEM_TEMPLATE = "# 协议:每一步一个动作块\n\n恰好一个 ```bash 块。\n";
/** 过得了 tsc 与静态校验的最简脚本:假服务的回文本。 */
const VALID_SCRIPT = `var ticks = 0;\nfunction loop() {\n  ticks += 1;\n  return ticks;\n}\n`;

/**
 * 评测网格要四份**真存档陪练**（钉死内容摘要），而 `archive/` 不入库：没有本地冻结档案的机器上
 * 这两条端到端跑不起来（陪练池装载会明确拒绝，这正是它该做的事）。所以按仓库既有纪律
 * （`sparring-pool.test.ts` 同款）显式跳过，而不是把摘要校验放宽成「有就用」。
 */
const substituteSlug = TRIAL_SPARRING_SUBSTITUTE.id;
const substituteRunId = TRIAL_SPARRING_SUBSTITUTE.runId;
const archivePresent = [
  ...TRIAL_SPARRING_LADDER.map((identity) => [identity.id, identity.runId] as const),
  [substituteSlug, substituteRunId] as const,
].every(([slug, runId]) => existsSync(join(repoRoot, "archive", slug, runId, "script.js")));

/** 本次冒烟用的假凭证环境变量:取唯一名,避免与宿主已有变量撞车(loadEnvFile 不该依赖覆盖语义)。 */
const CREDENTIAL_ENV_VAR = `GEN_CLI_SMOKE_KEY_${String(Date.now())}`;

let bundle = "";
let scratch = "";

beforeAll(async () => {
  scratch = mkdtempSync(`${tmpdir()}/modelwar-gen-cli-`);
  bundle = `${scratch}/modelwar.mjs`;
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    outfile: bundle,
  });
});

afterAll(() => {
  rmSync(scratch, { force: true, recursive: true });
});

/** 假服务观察到的一次请求。 */
type Captured = {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
};

/**
 * 起一个本地假端点(chat-completions 方言),按序回放 `contents`。
 *
 * ── 为什么是**一串**而不是一句 ──
 *
 * agent 形态下一次会话有多步,每步一次模型调用,而每步该回什么由**上一步的观测**决定:
 * 先写脚本、再 `evaluate`、最后 `done`。回同一句会让会话永远停在第一步的意图上。
 * 剧本用尽后重复最后一句(那是「模型不再有新动作」的最接近模拟)。
 *
 * 返回值带上收到的请求,好让断言能钉住「CLI 真的按配置打到了这个端点、带上了鉴权头」。
 */
const startFakeEndpoint = async (
  contents: readonly string[] = [VALID_SCRIPT],
): Promise<{
  readonly baseUrl: string;
  readonly requests: readonly Captured[];
  readonly close: () => Promise<void>;
}> => {
  const requests: Captured[] = [];
  let call = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
    });
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        authorization: req.headers.authorization,
      });
      const content = contents[call] ?? contents[contents.length - 1] ?? "";
      call += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("假端点没有拿到端口");
  }
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
};

/** 造一个装得上 gen 管线的临时根(与 `gen-archive.test.ts` 同一形态:安装面走符号链接)。 */
const mkRoot = (baseUrl: string): string => {
  const root = mkdtempSync(`${scratch}/root-`);
  symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"), "dir");
  symlinkSync(join(repoRoot, "packages"), join(root, "packages"), "dir");
  symlinkSync(join(repoRoot, "tsconfig.scripts.json"), join(root, "tsconfig.scripts.json"));
  // 真试跑（冻结期最后一栏）从安装根读入口产物、地图与基准对手：三处符号链接，
  // 与编译/校验走安装面的fixture 纪律一致（只读，不写回仓库）。
  symlinkSync(join(repoRoot, "apps"), join(root, "apps"), "dir");
  symlinkSync(join(repoRoot, "maps"), join(root, "maps"), "dir");
  symlinkSync(join(repoRoot, "benchmarks"), join(root, "benchmarks"), "dir");
  // 四份存档陪练：只把 `script.js` 符号链接进来（**不要**链接整个 archive 目录——
  // 那是读盘面的根，gen 会往 `<root>/archive/<slug>/` 里写候选与证据）。
  for (const identity of TRIAL_SPARRING_LADDER) {
    const dir = join(root, "archive", identity.id, identity.runId);
    mkdirSync(dir, { recursive: true });
    symlinkSync(
      join(repoRoot, "archive", identity.id, identity.runId, "script.js"),
      join(dir, "script.js"),
    );
  }
  const substituteDir = join(root, "archive", substituteSlug, substituteRunId);
  mkdirSync(substituteDir, { recursive: true });
  symlinkSync(
    join(repoRoot, "archive", substituteSlug, substituteRunId, "script.js"),
    join(substituteDir, "script.js"),
  );

  mkdirSync(join(root, "docs", "rules-v2"), { recursive: true });
  writeFileSync(join(root, "docs", "rules-v2", "rules.md"), CONTRACT_RULES);
  writeFileSync(join(root, "docs", "rules-v2", "api.md"), CONTRACT_API);
  // 契约目录说明:首条消息全量内联的就是它(agent 形态的契约正文不进消息,只给目录)。
  writeFileSync(join(root, "docs", "rules-v2", "README.md"), CONTRACT_INDEX);
  // 首条 user 与 system 的模板:agent 形态下这两份是**必读盘**的输入,缺了不静默降级。
  mkdirSync(join(root, "prompts"), { recursive: true });
  writeFileSync(join(root, "prompts", "agent.md"), AGENT_TEMPLATE);
  writeFileSync(join(root, "prompts", "agent-system.md"), AGENT_SYSTEM_TEMPLATE);
  mkdirSync(join(root, "rulesets"), { recursive: true });
  // 网格是 32 场：把 tick 上限压到 4，让端到端稳定在秒级（断言的是接线，不是对局长度）。
  const ruleset = JSON.parse(
    readFileSync(join(repoRoot, "rulesets", `${RULESET_VERSION}.json`), "utf8"),
  ) as Record<string, unknown>;
  writeFileSync(
    join(root, "rulesets", `${RULESET_VERSION}.json`),
    JSON.stringify({ ...ruleset, tickLimit: 4 }),
  );
  writeFileSync(
    join(root, "models.yaml"),
    [
      "models:",
      "  - slug: alpha",
      "    endpointFamily: chat-completions",
      `    baseUrl: ${baseUrl}`,
      "    modelId: provider/alpha-1",
      `    credentialEnvVar: ${CREDENTIAL_ENV_VAR}`,
      "    channelId: gen-test-channel",
      // agent 形态的上下文守卫要窗口大小才判得了「再发一次会不会越过 80%」,
      // 读不到就拒跑而不是静默跳过守卫(pipeline.ts 那条前置判据)。
      "    contextLength: 100000",
      "",
    ].join("\n"),
  );
  // 凭证只从环境变量读;`.env` 只是本机便利(存在才加载),绝不入库。
  writeFileSync(join(root, ".env"), `${CREDENTIAL_ENV_VAR}=smoke-fake-key\n`);
  return root;
};

/** 生产形态的工作区落点:`<root>/.workspaces/<slug>/<runId>/`(见 `pipeline.ts`)。 */
const workspaceOf = (root: string, runId: string): string =>
  join(root, ".workspaces", "alpha", runId);

/** 读回试跑观测文件（`archive/<slug>/observed-<runId>.jsonl`）的每一行；形状由入口那一侧写。 */
type ObservationRow = {
  readonly matchIndex: number;
  readonly delivered: number;
  readonly captures: number;
  readonly noScoreSource: boolean;
};

const readObservationLines = (path: string): readonly ObservationRow[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ObservationRow);

/** 跑 CLI 子进程到退出;异步等待,让本进程的假端点能应答(见文件头注)。 */
const runCli = (
  args: readonly string[],
): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundle, ...args], { cwd: repoRoot });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });

it.skipIf(!archivePresent)(
  "冒烟:假端点后端到端跑通一次会话(票 06 前零候选,落同形失败档)",
  { timeout: 120_000 },
  async () => {
    // 一次 agent 会话三步:写脚本 → evaluate(提交并跑满整张网格) → done。
    const endpoint = await startFakeEndpoint([
      writeScriptAction(VALID_SCRIPT),
      "```bash\nevaluate\n```",
      "```bash\ndone\n```",
    ]);
    try {
      const root = mkRoot(endpoint.baseUrl);
      const result = await runCli(["gen", "--config", "models.yaml", "--root", root]);
      // ── 票 06 之前:CLI 路径的 `evaluateScoring` 是占位(恒 `undefined`),所以一次会话
      // 跑得完、档落得下,但**没有成绩** → 零候选 → 失败档、退出 1(ADR-0030)。
      //
      // 这条用例验的是**接线**:CLI → 真 HTTP 适配器 → 假端点 → 单会话 loop → 落档。
      // 票 06 把真网格接上之后,这里应当改成 `expect(result.status).toBe(0)` 并断言
      // 三件套 + `optimization.version === 3`——那是同一条链,只是最后一步有了成绩。
      expect(result.status, result.stderr).toBe(1);

      // 真打到了假端点：POST /chat/completions，带上 Bearer 鉴权头；三步各一次调用。
      expect(endpoint.requests).toHaveLength(3);
      for (const request of endpoint.requests) {
        expect(request.method).toBe("POST");
        expect(request.path).toBe("/chat/completions");
        expect(request.authorization).toBe("Bearer smoke-fake-key");
      }

      // 零候选:落的是失败档(不是三件套目录)。旁挂的观测与网格汇总仍然留着——
      // 失败档恰恰是校准 harness 的主要证据(ADR-0031)。
      const slugDir = join(root, "archive", "alpha");
      const names = readdirSync(slugDir);
      const failureName = names.find((name) => name.startsWith("failed-")) as string;
      expect(failureName).toBeDefined();
      expect(names.some((name) => /^\d/u.test(name))).toBe(false);
      const record = JSON.parse(readFileSync(join(slugDir, failureName), "utf8")) as {
        runId: string;
        archiveSchemaVersion: number;
      };
      expect(record.archiveSchemaVersion).toBe(3);
      const runId = record.runId;
      // 本段一次候选都不产出,所以 `archive/<slug>/` 下只有那份失败档:
      // 候选快照(逐候选命名族)跟候选序一起出现,那是票 06 接上成绩之后才有的东西。
      expect(names).toEqual([failureName]);
      // 观测与网格汇总落在**工作区**里（`/workspace/.observations/<n>.md` + `.grid.json`）:
      // 那是 ADR-0030「观测外置」的落点（模型按需读,不常驻上下文）。把它们搬进
      // `archive/<slug>/observed-...jsonl` 那个命名族是票 06 的事,本段不越界。
      //
      // 但这里仍然断言它**真的落了盘并跑满了整张网格**:一次评测不能没有痕迹。
      const observationsDir = join(workspaceOf(root, runId), ".observations");
      // 观测一份 + 它的网格汇总(旁挂,`<观测>.grid.json`)。
      expect(readdirSync(observationsDir).sort()).toEqual([
        "1.md",
        `1.md${TRIAL_GRID_SUMMARY_SUFFIX}`,
      ]);
      const grid = JSON.parse(
        readFileSync(join(observationsDir, `1.md${TRIAL_GRID_SUMMARY_SUFFIX}`), "utf8"),
      ) as { plan: { matches: readonly { map: string }[] } };
      expect(grid.plan.matches).toHaveLength(TRIAL_MATCHES_PER_CANDIDATE);
      expect([...new Set(grid.plan.matches.map((match) => match.map))]).toEqual([
        ...TRIAL_GRID_MAP_NAMES,
      ]);

      // 试跑观测落地：整张网格 32 场各一行（这个候选整局无所作为，场场命中「无得分来源」）。
      // 这是「留痕进得去 gen 的记录」那一条的接线断言——不落盘，那条缺口就还在。
      // 落点是工作区（`/workspace/.observations/<n>.md`），由模型按需读；它写的就是 JSONL 行。
      const observations = readObservationLines(join(observationsDir, "1.md"));
      expect(observations).toHaveLength(TRIAL_MATCHES_PER_CANDIDATE);
      expect(observations.map((line) => line.matchIndex)).toEqual(
        Array.from({ length: TRIAL_MATCHES_PER_CANDIDATE }, (_, index) => index),
      );
      expect(
        observations.every(
          (line) => line.noScoreSource && line.delivered === 0 && line.captures === 0,
        ),
      ).toBe(true);
      // 失败档与成功档同键集合(ADR-0031):过程记录、身份、终止原因都在。
      const meta = record as unknown as {
        archiveSchemaVersion: number;
        protocolRounds: number;
        prompts: readonly string[];
        steps: readonly { action: { kind: string } }[];
        termination: string;
        atStep: number;
        harnessDigest: string;
        harnessVersion: string;
        contextLength: number;
      };
      expect(meta.archiveSchemaVersion).toBe(3);
      // v3 的公式:轮数 = 过程记录条数;起始 prompt 恒一条(不是每步一份)。
      expect(meta.protocolRounds).toBe(3);
      expect(meta.steps).toHaveLength(3);
      expect(meta.steps.map((step) => step.action.kind)).toEqual(["bash", "evaluate", "done"]);
      expect(meta.prompts).toHaveLength(1);
      expect(meta.termination).toBe("done");
      expect(meta.atStep).toBe(3);
      // 身份从第一份 agent 档起就写(ADR-0034)。
      expect(meta.harnessDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(meta.harnessVersion).toBe("bash-mini/0.1");
      expect(meta.contextLength).toBe(100_000);
    } finally {
      await endpoint.close();
    }
  },
);

/** 死循环惯犯：过得了 tsc 与静态校验，但每 tick 必然触碰事件计数上限。 */
const HABITUAL_SCRIPT = `function loop() {\n  while (true) {\n  }\n}\n`;

it.skipIf(!archivePresent)(
  "试跑拦下惯犯:死循环脚本退出非零,失败记录分类 contract 且诊断含试跑明细",
  { timeout: 120_000 },
  async () => {
    // 写惯犯脚本 → evaluate(真试跑,32 场照样判拦)。被拦下的一次不产出候选,
    // 所以这次会话零候选 → 失败档(ADR-0030「失败 = 一个候选都没有」)。
    const endpoint = await startFakeEndpoint([
      writeScriptAction(HABITUAL_SCRIPT),
      "```bash\nevaluate\n```",
      "```bash\ndone\n```",
    ]);
    try {
      const root = mkRoot(endpoint.baseUrl);
      const result = await runCli(["gen", "--config", "models.yaml", "--root", root]);
      // 冻结失败 → 非零退出。网格不再早停：跑满 32 场照样判拦。
      expect(result.status, result.stderr).toBe(1);

      // 不建存档目录，只留失败记录（旁证）+ 试跑观测，且记录指明是试跑拦的。
      const slugDir = join(root, "archive", "alpha");
      const names = readdirSync(slugDir);
      const failureName = names.find((name) => name.startsWith("failed-")) as string;
      expect(failureName).toBeDefined();
      const record = JSON.parse(readFileSync(join(slugDir, failureName), "utf8")) as {
        runId: string;
        classification: string;
        diagnostics: readonly string[];
        message: string;
        steps: readonly { action: { kind: string }; stdout: string; exitCode: number }[];
        termination: string;
      };
      expect(record.classification).toBe("contract");
      // v3 失败档与成功档同键集合：过程记录与终止原因都在。
      expect(record.termination).toBe("done");
      expect(record.steps).toHaveLength(3);
      expect(record.steps[1]?.action.kind).toBe("evaluate");
      // 那次 evaluate 非零退出（试跑拦下），且**明细在 stdout**（服务的正常输出，不是错误流）。
      expect(record.steps[1]?.exitCode).not.toBe(0);
      expect(record.message).toContain("evaluate");
      // 诊断取自那次 evaluate 的**正常输出**(stdout):服务的 verdict 就是拦下原因。
      // 只看 `stderr` 会把这条写成空诊断——那是失败档唯一能回答「为什么没成绩」的地方。
      const diagnostics = record.diagnostics.join("\n");
      expect(diagnostics).toContain("试跑未通过");

      // 网格真的跑满了一张(拦下是试跑的结论,不是「没跑」)。
      const observationsDir = join(workspaceOf(root, record.runId), ".observations");
      expect(readdirSync(observationsDir)).toContain("1.md");
    } finally {
      await endpoint.close();
    }
  },
);
