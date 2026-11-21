/**
 * 生成管线的编排层与 CLI 处理器入口(hld §2.2.6 / §9)。
 *
 * ── 边界:单轮到原子冻结 ──
 *
 * 本文件是编排层:根解析 → 读配置 → 读契约 → 读模板 → 对每个选中模型调 `pipeline.ts` 的
 * `generateOneModel`(发一次 → 编译 → 迭代期校验 → 冻结期校验 → 原子冻结,返回 `ModelOutcome`)。
 * 单模型失败不中断整批:**写失败记录文件**(`archive/<slug>/failed-<runId>.json`,写盘见
 * `packages/gen/src/failure.ts`)再记账,成功者照旧冻结。`GenerationRequest` 这一组共享参数(契约 §2)
 * 由本文件组装一次、按模型复用。
 *
 * ── 根解析复用 `match` 的约定 ──
 *
 * 默认 cwd,`--root` 覆盖,`--config` 相对根。`.env` 在根解析之后加载(存在才加载),凭证只经
 * `process.env[credentialEnvVar]` 读——本模块不读凭证,但要保证根解析与加载时机正确,
 * 让 `packages/gen/src/http/client.ts` 的真实客户端直接可用。
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadModelsConfig, type ModelConfig } from "./config.js";
import { writeFailureRecord } from "./failure.js";
import { SANDBOX_ROOTFS_DIR, type TrialPlan } from "@model-war/schema";
import type { AgentPrompt } from "./agent-prompt.js";
import type { TrialProbe, TrialProbeScript } from "./trial.js";
import { createHttpModelClient } from "./http/client.js";
import type { ModelClient } from "./model-client.js";
import type { RetrySleep } from "./retry.js";
import { sandbox } from "./agent/sandbox/index.js";
import { generateOneModel, type EvaluateScoring } from "./pipeline.js";

/**
 * 单模型一次生成的全部共享输入(契约 §2)。由 `runGeneration` 组装一次、按模型复用;
 * `generateOneModel(request, config)` 从这里取它需要的一切。
 */
export type GenerationRequest = {
  readonly root: string;
  readonly runId: string;
  /**
   * 首条 `user` 与 `system` 的成品文本(`loadAgentPrompt(root, identity)` 的返回值)。
   *
   * 缺席时 `generateOneModel` 现读一次盘(生产路径)。测试注入它,于是「首条消息长什么样」与
   * 「loop 怎么跑」可以分开钉住,不必为了一个用例造一份完整契约目录。
   */
  readonly agentPrompt?: AgentPrompt;
  readonly createClient: (config: ModelConfig) => ModelClient;
  readonly now: () => Date;
  /**
   * 沙箱里 bind 成 `/workspace` 的宿主目录。缺席即 `archive/<slug>/.workspace-<runId>`
   * (一跑一份,不跨会话复用:上一位模型的残留会变成下一位的起手式)。
   */
  readonly workspaceDir?: string;
  /** 覆盖会话步数上限(默认 `AGENT_MAX_STEPS`);测试用它把边界压到个位数。 */
  readonly maxSteps?: number;
  /** 覆盖会话总墙钟(默认 `AGENT_TOTAL_WALL_CLOCK_MS`)。 */
  readonly totalWallClockMs?: number;
  /** 覆盖单步墙钟(默认执行器的 `DEFAULT_STEP_WALL_CLOCK_MS`)。 */
  readonly stepWallClockMs?: number;
  /**
   * 入库 rootfs 的宿主路径。缺省即 `<root>/packages/gen/sandbox-rootfs`。
   *
   * ── 为什么由 `root` 推,而不是执行器自己按模块位置上溯 ──
   *
   * 执行器的 `defaultRootfsDir()` 从模块自身位置往上数五层,在源码与 `dist` 形态下都对——但
   * CLI 是**打包成单文件**跑的(esbuild 把 gen 打进入口 bundle),那时模块位置在临时目录里,
   * 上溯五层得到的是 `/`,沙箱因此报 `Can't find source path /packages/...`。
   *
   * `--root` 的语义本来就是「安装根」(hld §9),rootfs 也在它下面,所以这里按它推——bundle
   * 形态与源码形态算出同一个路径。
   */
  readonly rootfsDir?: string;
  /**
   * 退避等待的实现。缺席即真等(`setTimeout`)。
   *
   * 与 `retryTransport` 的 `sleep` 是同一个缝,理由也同一条:真等 1s / 2s 的用例会跟机器负载
   * 赛跑,而「退避序列算得对不对」由 `retry.test.ts` 判。这里需要它的地方更窄——验证**退避记账
   * 取的是实测而不是请求值**:注入一个推进虚拟时钟的实现,于是「等了多少」与「请求了多少」可以
   * 人为拉开,而那正是这条判据的全部。生产路径永远走真等。
   */
  readonly sleep?: RetrySleep;
  /**
   * 试跑探针(被 `evaluate` 服务调,一次评测一张整网格)。缺席即真子进程
   * (`runTrialScript`):生产路径上没有「假网格」这回事。测试注入桩。
   */
  readonly trial?: TrialProbe;
  /**
   * 探针的执行缝(被 `probe` 服务调,跑完整计划的前 N 场)。缺席即真子进程
   * (`runTrialProbeScript`,同一个试跑入口的 `--match-limit` 模式)。测试注入桩。
   */
  readonly probeScript?: TrialProbeScript;
  /**
   * 评测网格计划的搬运缝(一次会话一张)。缺席即 spawn 试跑入口的 `--plan` 模式现场搬。
   *
   * 注入它的地方只有测试:搬计划要读盘算摘要(规则集/地图/四份陪练字节),而单测的临时根里
   * 没有安装面。生产路径永远走真入口——**不提供「不比对计划」这一档**,因为计划是网格的身份。
   */
  readonly trialPlan?: (options: { readonly root: string; readonly model: string }) => TrialPlan;
  /**
   * 一次 `evaluate` 的**成绩**从哪来(`pipeline.ts` 的 `EvaluateScoring`)。
   *
   * 缺席即真网格(`scoreFromCandidateEvidence` 读候选旁挂的 `.grid.json`)。测试注入它,
   * 把「成绩」与「网格」拆开验。
   */
  readonly evaluateScoring?: EvaluateScoring;
};

export type GenerationOptions = {
  readonly root: string;
  /** `--config` 的取值,相对 `root`(传绝对路径亦按 `resolve` 归一)。 */
  readonly configPath: string;
  /** `--model <slug>`:只跑一个模型。 */
  readonly modelFilter?: string;
  /** 测试注入桩;缺省用真实 HTTP 客户端(`http/client.ts`,唯一允许联网的代码)。 */
  readonly createClient?: (config: ModelConfig) => ModelClient;
  /** 首条 prompt 的注入缝(缺省现读盘)。 */
  readonly agentPrompt?: AgentPrompt;
  /** 会话预算与工作区的覆盖缝(测试用)。 */
  readonly workspaceDir?: string;
  /** rootfs 的覆盖缝;缺省由 `root` 推。 */
  readonly rootfsDir?: string;
  readonly maxSteps?: number;
  readonly totalWallClockMs?: number;
  readonly stepWallClockMs?: number;
  /** 评测探针、计划搬运与成绩接缝(生产路径全部走真实现)。 */
  readonly trial?: TrialProbe;
  /** 探针(`probe` 工具)的执行缝;缺省真子进程。 */
  readonly probeScript?: TrialProbeScript;
  readonly trialPlan?: (options: { readonly root: string; readonly model: string }) => TrialPlan;
  readonly evaluateScoring?: EvaluateScoring;
  /**
   * 沙箱启动自证(ADR-0033「执行器启动时先自证」)。缺省即真的 `sandbox.preflight()`。
   *
   * 缺省之外只有测试会注入它:自证要真跑 bwrap,而单测不允许依赖内核能力(常跑链不装
   * bubblewrap)。注入的失败实现是「不可用就整批失败」那条路径的唯一验法。
   */
  readonly preflight?: () => void;
};

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** 一批里出没出错之外没有别的信息,进程退出码只回答"全成 / 有败"。 */
const EXIT_OK = 0;
const EXIT_FAILED = 1;

const writeFailure = (message: string): number => {
  process.stderr.write(`modelwar gen: ${message}\n`);
  return EXIT_FAILED;
};

/** 时间戳形态的 `runId`:`:`/`.` 换成 `-`,让它能直接当目录名(也用于建存档目录)。 */
const runIdOf = (at: Date): string => at.toISOString().replaceAll(":", "-").replace(".", "-");

/**
 * 会话 ID 派生:`modelwar-gen-<runId>-<slug>`。两段都已是目录安全形态,拼接即稳定:
 * 同一模型一次冻结的多轮回喂与重试共用它,跨模型、跨批次互不相同。
 */
const sessionIdOf = (runId: string, slug: string): string => `modelwar-gen-${runId}-${slug}`;

/**
 * 多模型编排:读配置 + 契约 + 模板,逐模型串行跑 `generateOneModel`。
 *
 * 第一件事是**沙箱启动自证**(`sandbox.preflight`,一批一次):执行器起不来就整批失败,一个
 * 会话都不启动、不回落宿主进程(ADR-0033)。自证通过之后才进模型循环。
 *
 * 返回进程退出码:全部模型冻结成功 = 0,任一失败 = 1。单模型失败不中断整批(失败的模型把诊断
 * 打到 stderr,并写一条 `archive/<slug>/failed-<runId>.json` 失败记录,其余照跑)。三类失败
 * (`tsc` / `contract` / `transport`)都写失败记录;写失败记录本身出错也按该模型失败记账,不崩整批。
 * 模型之间**串行**(模型内并发固定 1):`for … await` 保证前一个模型的全部轮次结束后才开下一个。
 */
export const runGeneration = async (options: GenerationOptions): Promise<number> => {
  const root = resolve(options.root);
  const config = loadModelsConfig(resolve(root, options.configPath));
  const now = (): Date => new Date();

  const selected =
    options.modelFilter === undefined
      ? config.models
      : config.models.filter((model) => model.slug === options.modelFilter);
  if (options.modelFilter !== undefined && selected.length === 0) {
    throw new Error(
      `模型配置里没有 slug 为 "${options.modelFilter}" 的条目(--model 只能选已登记的模型)`,
    );
  }

  // runId 与 generatedAt 取同一个时刻:前者进目录名 / 失败记录文件名,后者进记录里的留档位。
  const startedAt = now();
  const runId = runIdOf(startedAt);
  // 由安装根推 rootfs:打包形态下执行器的模块位置上溯不可用(见 `GenerationRequest.rootfsDir`)。
  const rootfsDir = options.rootfsDir ?? join(root, SANDBOX_ROOTFS_DIR);

  // ── 启动自证:一批一次,失败即整批失败(ADR-0033) ──
  //
  // 位置在**第一次模型调用之前**:等到第一步 `sandbox.run` 才炸,钱已经花了、模型已经跑了
  // 一步,而失败会以「这一步怎么了」的面目出现——那是最容易归错因的一种红。放在这里,整批
  // 一个会话都不会启动,报错就是「这台机器的沙箱起不来」本身(文本里带三种已知成因)。
  //
  // 粒度是**每批一次**而不是每步一次:自证问的是「这台机器的内核能力够不够」,它在一批之内
  // 不会变;逐步重做只是把同一件事问 N 遍,而它要真起一次 bwrap。
  //
  // 也**不降级**:拿不到沙箱就换宿主进程跑,等于造出第二套威胁模型(ADR-0033「不可用就失败,
  // 不降级」)。所以这里直接抛,编排层把它收成非零退出。
  (
    options.preflight ??
    ((): void => {
      sandbox.preflight({ rootfsDir });
    })
  )();
  // 默认客户端包一层,把会话 ID 传进去(测试注入桩保持原样)。绑定必须在 runId 就绪之后,
  // 且 ID 由 runId + slug 确定性派生——pipeline 每轮现造客户端,重试重走 send,若在里面
  // 现生成随机 ID,多轮回喂会拿到不同会话,直接违反服务端的缓存要求。
  const createClient =
    options.createClient ??
    ((config: ModelConfig): ModelClient =>
      createHttpModelClient(config, { sessionId: sessionIdOf(runId, config.slug) }));
  const request: GenerationRequest = {
    root,
    runId,
    createClient,
    now,
    rootfsDir,
    ...(options.agentPrompt === undefined ? {} : { agentPrompt: options.agentPrompt }),
    ...(options.workspaceDir === undefined ? {} : { workspaceDir: options.workspaceDir }),
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    ...(options.totalWallClockMs === undefined
      ? {}
      : { totalWallClockMs: options.totalWallClockMs }),
    ...(options.stepWallClockMs === undefined ? {} : { stepWallClockMs: options.stepWallClockMs }),
    ...(options.trial === undefined ? {} : { trial: options.trial }),
    ...(options.probeScript === undefined ? {} : { probeScript: options.probeScript }),
    ...(options.trialPlan === undefined ? {} : { trialPlan: options.trialPlan }),
    ...(options.evaluateScoring === undefined ? {} : { evaluateScoring: options.evaluateScoring }),
  };

  let failures = 0;
  for (const model of selected) {
    try {
      const outcome = await generateOneModel(request, model);
      if (outcome.kind === "frozen") {
        continue;
      }
      failures += 1;
      // 失败记录是给报告侧的旁证:写盘失败(权限 / 撞名)也按该模型失败记账,不抛不崩整批。
      const written = writeFailureRecord({
        root,
        model: model.slug,
        modelVersion: model.modelId,
        channelId: model.channelId,
        generatedAt: startedAt.toISOString(),
        runId: outcome.runId,
        failure: outcome.failure,
        agent: outcome.agent,
      });
      if (!written.ok) {
        process.stderr.write(
          `modelwar gen: 模型 ${model.slug} 的失败记录写盘失败:${written.reason}\n`,
        );
      }
      process.stderr.write(
        `modelwar gen: 模型 ${model.slug} 未通过(${outcome.failure.classification}):` +
          `${outcome.failure.message}\n`,
      );
      for (const line of outcome.failure.diagnostics) {
        process.stderr.write(`  ${line}\n`);
      }
    } catch (cause) {
      failures += 1;
      process.stderr.write(`modelwar gen: 模型 ${model.slug} 生成失败:${messageOf(cause)}\n`);
    }
  }
  return failures === 0 ? EXIT_OK : EXIT_FAILED;
};

/** `gen` 的选项;`-h/--help` 已由 CLI 路由层拦截,不进处理器。 */
type GenArgs = {
  readonly root: string | undefined;
  readonly config: string | undefined;
  readonly model: string | undefined;
};

const parseGenArgs = (args: readonly string[]): GenArgs => {
  const parsed: {
    root: string | undefined;
    config: string | undefined;
    model: string | undefined;
  } = {
    root: undefined,
    config: undefined,
    model: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined || !arg.startsWith("-")) {
      throw new Error(`gen 不接受位置参数:${String(arg)}`);
    }
    // 阶段机器与它的两个开关一起消失(ADR-0032):agent 形态没有阶段,`evaluate` 就是提交。
    // 传进来就明确拒掉,而不是静默忽略——一个被忽略的开关会让人以为它生效了。
    if (arg === "--select-best-candidate" || arg === "--score-source-feedback") {
      throw new Error(`${arg} 已随阶段机器一起移除(agent 形态下 evaluate 就是提交,没有阶段可推进)`);
    }
    const value = args[index + 1];
    if (value === undefined) {
      throw new Error(`${arg} 缺值`);
    }
    index += 1;
    if (arg === "--root") {
      parsed.root = value;
    } else if (arg === "--config") {
      parsed.config = value;
    } else if (arg === "--model") {
      parsed.model = value;
    } else {
      throw new Error(`未知参数:${arg}`);
    }
  }
  return parsed;
};

/**
 * CLI 处理器(`commands.ts` 登记的导出名)。解析 `--config` / `--root` / `--model`,
 * 加载 `<root>/.env`(存在才加载),调 `runGeneration`。
 *
 * 用法错 / 配置或契约出错 → 明确报错 + 非零退出(不静默返回成功)。
 */
export const generateAndFreeze = async (args: readonly string[]): Promise<number> => {
  let parsed: GenArgs;
  try {
    parsed = parseGenArgs(args);
  } catch (cause) {
    return writeFailure(messageOf(cause));
  }
  if (parsed.config === undefined) {
    return writeFailure("缺 --config <models.yaml>(用法:modelwar gen --config models.yaml)");
  }

  const root = resolve(parsed.root ?? process.cwd());
  // 凭证从环境变量读;`.env` 只是本机便利,存在才加载,不存在不报错(hld §9)。
  // 真实读取在 `packages/gen/src/http/client.ts`;此处只保证加载时机正确、且不把文件内容写进任何日志。
  const envFile = join(root, ".env");
  if (existsSync(envFile)) {
    try {
      process.loadEnvFile(envFile);
    } catch (cause) {
      return writeFailure(`加载 ${envFile} 失败:${messageOf(cause)}`);
    }
  }

  const options: GenerationOptions = {
    root,
    configPath: parsed.config,
    ...(parsed.model !== undefined ? { modelFilter: parsed.model } : {}),
  };
  try {
    return await runGeneration(options);
  } catch (cause) {
    return writeFailure(messageOf(cause));
  }
};
