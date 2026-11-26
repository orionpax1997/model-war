/**
 * CLI 接线冒烟(Testing Decisions 的既有缝:子进程 + 本地假端点)。
 *
 * spawn **打好的单文件 CLI 产物** `modelwar gen --config models.yaml --root <临时根>`,端点指向
 * `node:http` 起的**本地假服务**(回一个过得了 tsc + 静态校验的合法脚本),`.env` 写在临时根里提供
 * 假凭证;断言退出码 0 + `archive/<slug>/<runId>/` 三件套落地。
 *
 * ── 它归 `sandbox` project,不归 `unit` ──
 *
 * 它是**真沙箱**的端到端冒烟:bwrap 真起、真网格 32 场真跑,那要非特权 user namespace 与系统装的
 * bubblewrap,而常跑链(`pnpm run test`)不装。收进 `unit` 的后果与 `agent-real-session.test.ts`
 * 完全相同:「全量门禁红了」同时意味着「提交内容有问题」与「这台机器没装 bubblewrap」,两种处方
 * 混成一条红。所以它和那条真会话一起归 `sandbox`(`pnpm run verify:kernel` 的 `--project sandbox`)。
 *
 * 这条归属是**被内核探针抓出来的**(`vitest.kernel-guard.setup.ts` 落地后的第一例):在此之前它
 * 一直挂在 `unit` 上,而且靠 `it.skipIf(!archivePresent)` 让它在「没有冻档的机器」上静默 skip——
 * `archive/` 不入库,于是本机与 CI 两边都不报红,一条要内核能力的用例就这么藏住了。
 *
 * 那四份陪练 `script.js` 现在入库在 `apps/cli/src/fixtures/archive/`(逐字节副本,摘要钉的就是
 * 字节),`mkRoot` 只从那里取,所以本文件不再有任何 `skipIf`:在任何机器上两条都跑。
 *
 * ── 移走不等于丢掉覆盖 ──
 *
 * 拆开看它断言的四样东西,各自都有快链上的那一份:
 * - CLI 产物的 argv 与退出码约定:`cli.test.ts`(`gen --help` 列出的选项、缺 `--config` 非零退出)
 *   与 `packages/gen/src/run.test.ts`(`generateAndFreeze` 的解析、`--model` 选取、`.env` 加载);
 * - 「一次 evaluate 产出可装载档案 + 成功/失败两档」:`gen-archive.test.ts` 与
 *   `agent-session-archive.test.ts` 用**同一份** `withRealBash` 替身验同一条链;
 * - HTTP 适配器真的打了那个端点、带上了 Bearer 鉴权:`packages/gen/src/http/client.test.ts`
 *   直接对着假端点验;
 * - 真网格 32 场跑满:**本文件上面那两条**(真 bwrap + 真 CLI 子进程 + 真 32 场)。原来这条挂在
 *   `gate:gen-grid` 上,那条门禁已删除:它读 gitignored 的 `archive/`(干净克隆跑不起来)、桩停在
 *   代码块协议上(每轮被拒成 `no-tool-call`,kind=failed 却没人跑),又不在任何链上。
 * 本文件不可替代的那一样是「这四层同时在一条 CLI 进程里成立」——它仍然被验,只是在对的那条链上。
 *
 * ── 为什么不给子进程 CLI 注入假执行器 ──
 *
 * `withRealBash` 是 `import` 形态的替身,它换的是**本进程**那份 `sandbox` 对象;而本文件 spawn 的是
 * 打好的单文件产物,替身跟着打包进 bundle 意味着在生产 CLI 上开一个测试专用开关——那正是禁止项。
 * 另一条路是给子进程塞一个假 `bwrap`(把执行器换成 `/bin/bash` 的 shim),但那要自己重新实现
 * rootfs 挂载面与 fd 3 语义;一旦实现得与生产不同,这条冒烟就变成在验 shim 自己的正确性。
 *
 * ── 为什么用异步 `spawn` 而不是 `spawnSync` ──
 *
 * 假端点跑在**本进程**里:`spawnSync` 会阻塞本进程事件循环,子进程的请求就永远等不到响应(死锁)。
 * 所以这里 await 子进程退出的同时让事件循环继续转(端点才能应答)。
 *
 * ── 为什么不在这里再跑一次 `tsc -b` ──
 *
 * `vitest.global-setup.ts` 在任何测试模块加载前已把工作区包的 `dist/` 备齐,esbuild 才解析得到
 * `@model-war/gen` 的 `exports`。再补一次就是并发写同一份 dist——没有任何收益,只有竞态。
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
import { HARNESS_VERSION } from "@model-war/gen";
import {
  ARCHIVE_SCHEMA_VERSION,
  RULESET_VERSION,
  TRIAL_GRID_MAP_NAMES,
  TRIAL_GRID_SUMMARY_SUFFIX,
  TRIAL_MATCHES_PER_CANDIDATE,
  TRIAL_SPARRING_LADDER,
  TRIAL_SPARRING_SUBSTITUTE,
} from "@model-war/schema";
import { afterAll, beforeAll, expect, it } from "vitest";

import { sparringScriptPathIn } from "./sparring-fixture.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const entry = fileURLToPath(new URL("./index.ts", import.meta.url));

const CONTRACT_RULES = "# rules\n\n机制正文:这里是规则契约。\n";
const CONTRACT_API = "# api\n\nAPI 正文:这里是接口契约。\n";
/** 契约目录说明(首条消息全量内联的那一份)。 */
const CONTRACT_INDEX = "# contract\n\n- rules.md:机制\n- api.md:接口\n";
/**
 * 一条「把脚本写进 /workspace」的工具调用。
 *
 * 走 heredoc:模型在沙箱里写文件的自然写法,也是常见的那一种(重定向 + heredoc)。
 * 写成 `bash` 的 `command` 而不是裸脚本正文,是 agent 形态与 one-shot 的分界线——裸正文不会
 * 被解析成任何动作。
 */
const writeScriptAction = (name: string, body: string): FakeToolCall => ({
  name,
  argumentsJson: JSON.stringify({ command: `cat > /workspace/script.ts <<'EOF'\n${body}EOF` }),
});

/** 一次不收参数的工具调用(`check` / `probe` / `evaluate` / `finish`)。 */
const toolAction = (name: string): FakeToolCall => ({ name, argumentsJson: "{}" });

/** 首条 `user` 的模板:两个占位符都得在,否则渲染器明确报错。 */
const AGENT_TEMPLATE = "{{contractIndex}}\n\n任务:\n\ncontract: {{contractDigest}}\n";
/** `system` 的模板:原样使用,不渲染。 */
const AGENT_SYSTEM_TEMPLATE = "# 协议:每一步一次工具调用\n\n恰好一次调用。\n";
/** 过得了 tsc 与静态校验的最简脚本:假服务的回文本。 */
const VALID_SCRIPT = `var ticks = 0;\nfunction loop() {\n  ticks += 1;\n  return ticks;\n}\n`;

/**
 * 评测网格要四份**真存档陪练**（钉死内容摘要）。它们的 `script.js` 字节入库在
 * `apps/cli/src/fixtures/archive/`（来源与「为什么不能裁剪」写在那里的 README），所以本文件
 * 读 fixture 而不读仓库根的 `archive/`——后者不入库，过去让这两条在干净克隆与 CI 上静默 skip。
 */
const substituteSlug = TRIAL_SPARRING_SUBSTITUTE.id;
const substituteRunId = TRIAL_SPARRING_SUBSTITUTE.runId;

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
 * 假端点的一步:一次 `tool_calls` 响应(线协议全形状)。
 *
 * `content` 刻意留空(工具调用那一轮模型通常不说话),`arguments` 是**字符串**——渠道形状就是
 * 这样,解析归动作层,不归传输层。
 */
type FakeToolCall = { readonly name: string; readonly argumentsJson: string };

/**
 * 起一个本地假端点(chat-completions 方言),按序回放 `turns`。
 *
 * ── 为什么是**一串**而不是一句 ──
 *
 * agent 形态下一次会话有多步,每步一次模型调用,而每步该回什么由**上一步的观测**决定:
 * 先写脚本、再 `evaluate`、最后 `done`。回同一句会让会话永远停在第一步的意图上。
 * 剧本用尽后重复最后一步(那是「模型不再有新动作」的最接近模拟)。
 *
 * 返回值带上收到的请求,好让断言能钉住「CLI 真的按配置打到了这个端点、带上了鉴权头」。
 */
const startFakeEndpoint = async (
  turns: readonly FakeToolCall[] = [
    {
      name: "bash",
      argumentsJson: JSON.stringify({
        command: `cat > /workspace/script.ts <<'EOF'\n${VALID_SCRIPT}EOF`,
      }),
    },
  ],
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
      const turn = turns[call] ??
        turns[turns.length - 1] ?? { name: "finish", argumentsJson: "{}" };
      call += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: `call-${String(call)}`,
                    type: "function",
                    function: { name: turn.name, arguments: turn.argumentsJson },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
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
  // 源是**入库 fixture**，不是仓库根的 `archive/`（后者不入库，见文件头注）。
  for (const identity of TRIAL_SPARRING_LADDER) {
    const dir = join(root, "archive", identity.id, identity.runId);
    mkdirSync(dir, { recursive: true });
    symlinkSync(
      sparringScriptPathIn({ slug: identity.id, runId: identity.runId }),
      join(dir, "script.js"),
    );
  }
  const substituteDir = join(root, "archive", substituteSlug, substituteRunId);
  mkdirSync(substituteDir, { recursive: true });
  symlinkSync(
    sparringScriptPathIn({ slug: substituteSlug, runId: substituteRunId }),
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

it(
  "冒烟:假端点后端到端跑通一次会话(真网格 32 场,有候选即成功档)",
  { timeout: 120_000 },
  async () => {
    // 一次 agent 会话三步:写脚本 → evaluate(提交并跑满整张网格) → done。
    const endpoint = await startFakeEndpoint([
      writeScriptAction("bash", VALID_SCRIPT),
      toolAction("evaluate"),
      toolAction("finish"),
    ]);
    try {
      const root = mkRoot(endpoint.baseUrl);
      const result = await runCli(["gen", "--config", "models.yaml", "--root", root]);
      // 这条用例验的是**接线**:CLI → 真 HTTP 适配器 → 假端点 → 单会话 loop → 真网格 → 落档。
      // 真网格接上之后,那次 evaluate 有成绩 → 有候选 → 成功档、退出 0。
      expect(result.status, result.stderr).toBe(0);

      // 真打到了假端点：POST /chat/completions，带上 Bearer 鉴权头；三步各一次调用。
      expect(endpoint.requests).toHaveLength(3);
      for (const request of endpoint.requests) {
        expect(request.method).toBe("POST");
        expect(request.path).toBe("/chat/completions");
        expect(request.authorization).toBe("Bearer smoke-fake-key");
      }

      // 有候选 → 三件套目录(不是 failed-*.json)。
      const slugDir = join(root, "archive", "alpha");
      const names = readdirSync(slugDir);
      expect(names.some((name) => name.startsWith("failed-"))).toBe(false);
      const runId = names.find((name) => /^\d/u.test(name)) as string;
      expect(runId).toBeDefined();
      expect(existsSync(join(slugDir, runId, "script.js"))).toBe(true);

      const meta = JSON.parse(readFileSync(join(slugDir, runId, "meta.json"), "utf8")) as {
        archiveSchemaVersion: number;
        protocolRounds: number;
        prompts: readonly string[];
        steps: readonly { action: { kind: string }; stdout: string }[];
        termination: string;
        atStep: number;
        harnessDigest: string;
        harnessVersion: string;
        contextLength: number;
        scriptSha256: string;
        optimization: {
          version: number;
          candidates: readonly {
            step: number;
            scriptFile: string;
            observationsFile: string;
            scriptSha256: string;
            score: { countedMatches: number };
            matchCount: number;
          }[];
        };
      };
      expect(meta.archiveSchemaVersion).toBe(ARCHIVE_SCHEMA_VERSION);
      // v3 的公式:轮数 = 过程记录条数;起始 prompt 恒一条(不是每步一份)。
      expect(meta.protocolRounds).toBe(3);
      expect(meta.steps).toHaveLength(3);
      expect(meta.steps.map((step) => step.action.kind)).toEqual(["bash", "evaluate", "done"]);
      expect(meta.prompts).toHaveLength(1);
      expect(meta.termination).toBe("done");
      expect(meta.atStep).toBe(3);
      // 身份从第一份 agent 档起就写。
      expect(meta.harnessDigest).toMatch(/^[0-9a-f]{64}$/);
      // 用真源常量,不抄字面量:票 06 把代号换成 `tool-call/1.0` 时这条断言留在了旧世界,
      // 而它只在 sandbox 项目里跑,`verify` 覆盖不到——抄字面量就会这样静默过期。
      expect(meta.harnessVersion).toBe(HARNESS_VERSION);
      expect(meta.contextLength).toBe(100_000);

      // evaluate 那一步的 stdout 只给聚合对差表与一行路径(「观测外置」)。
      const evaluateStdout = meta.steps[1]?.stdout ?? "";
      expect(evaluateStdout).toContain("evaluate:通过");
      expect(evaluateStdout).toContain("一、对差表");
      expect(evaluateStdout).toContain("完整观测:/workspace/.observations/1.md");
      expect(evaluateStdout).not.toContain("二、逐场一行");

      // ── 候选:一次 evaluate 一条,无 `stage`,步号即那一步 ──
      expect(meta.optimization.version).toBe(3);
      expect(meta.optimization.candidates).toHaveLength(1);
      const candidate = meta.optimization.candidates[0]!;
      expect(candidate.step).toBe(2);
      expect(Object.hasOwn(candidate, "stage")).toBe(false);
      expect(candidate.observationsFile).toBe(`observed-${runId}-round-2.jsonl`);
      expect(candidate.scriptFile).toBe(`${candidate.observationsFile}.candidate.js`);
      expect(candidate.matchCount).toBe(TRIAL_MATCHES_PER_CANDIDATE);
      expect(candidate.score.countedMatches).toBe(TRIAL_MATCHES_PER_CANDIDATE);

      // 快照三件套都在档案目录里(既有命名族,不新建目录)。
      for (const name of [
        candidate.observationsFile,
        `${candidate.observationsFile}${TRIAL_GRID_SUMMARY_SUFFIX}`,
        candidate.scriptFile,
        `${candidate.observationsFile}.candidate.ts`,
      ])
        expect(existsSync(join(slugDir, name)), name).toBe(true);

      // 胜者就是末位候选(没有 selection):冻结的三件套与候选条目字节同源。
      const candidateBytes = readFileSync(join(slugDir, candidate.scriptFile));
      expect(meta.scriptSha256).toBe(candidate.scriptSha256);
      expect(readFileSync(join(slugDir, runId, "script.js")).equals(candidateBytes)).toBe(true);
      expect(readFileSync(join(slugDir, runId, "script.ts"), "utf8")).toBe(
        readFileSync(join(slugDir, `${candidate.observationsFile}.candidate.ts`), "utf8"),
      );

      // 网格真的跑满了整张:观测原料进档案,派生视图进工作区。
      const grid = JSON.parse(
        readFileSync(
          join(slugDir, `${candidate.observationsFile}${TRIAL_GRID_SUMMARY_SUFFIX}`),
          "utf8",
        ),
      ) as { plan: { matches: readonly { map: string }[] }; scriptSha256: string };
      expect(grid.plan.matches).toHaveLength(TRIAL_MATCHES_PER_CANDIDATE);
      expect([...new Set(grid.plan.matches.map((match) => match.map))]).toEqual([
        ...TRIAL_GRID_MAP_NAMES,
      ]);
      expect(grid.scriptSha256).toBe(candidate.scriptSha256);
      const observations = readObservationLines(join(slugDir, candidate.observationsFile));
      expect(observations).toHaveLength(TRIAL_MATCHES_PER_CANDIDATE);
      expect(observations.map((line) => line.matchIndex)).toEqual(
        Array.from({ length: TRIAL_MATCHES_PER_CANDIDATE }, (_, index) => index),
      );
      expect(
        observations.every(
          (line) => line.noScoreSource && line.delivered === 0 && line.captures === 0,
        ),
      ).toBe(true);

      // 派生视图(聚合 + 逐场 + 最差三场)留在工作区,不进档案。
      const observationsDir = join(workspaceOf(root, runId), ".observations");
      expect(readdirSync(observationsDir)).toEqual(["1.md"]);
      const view = readFileSync(join(observationsDir, "1.md"), "utf8");
      expect(view).toContain("二、逐场一行");
      expect(view).toContain("三、最差三场");
    } finally {
      await endpoint.close();
    }
  },
);

/** 死循环惯犯：过得了 tsc 与静态校验，但每 tick 必然触碰事件计数上限。 */
const HABITUAL_SCRIPT = `function loop() {\n  while (true) {\n  }\n}\n`;

it(
  "试跑拦下惯犯:死循环脚本退出非零,失败记录分类 contract 且诊断含试跑明细",
  { timeout: 120_000 },
  async () => {
    // 写惯犯脚本 → evaluate(真试跑,32 场照样判拦)。被拦下的一次不产出候选,
    // 所以这次会话零候选 → 失败档(「失败 = 一个候选都没有」)。
    const endpoint = await startFakeEndpoint([
      writeScriptAction("bash", HABITUAL_SCRIPT),
      toolAction("evaluate"),
      toolAction("finish"),
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
