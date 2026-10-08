/**
 * 生成管线的编排层与 CLI 处理器入口(hld §2.2.6 / §9)。
 *
 * ── 票 01 的边界:走到"拿到脚本文本"为止 ──
 *
 * 本票只把输入接起来:根解析 → 读配置 → 读契约 → 读模板 → 对每个模型经 `ModelClient` 端口
 * 发一次请求、回得文本。**不编译、不落存档**——那是票 02 的活。`sendOnce` 就是那条缝:
 * 票 02 会把它换成 `pipeline.ts` 的逐轮 `generateOneModel`(编译 + 校验 + 回喂 + 原子冻结,
 * 返回 `ModelOutcome`)。本文件保留 `GenerationRequest` 这一组共享参数(契约 §2),让替换点
 * 只需改一个函数体、不动签名。
 *
 * ── 根解析复用 `match` 的约定 ──
 *
 * 默认 cwd,`--root` 覆盖,`--config` 相对根。`.env` 在根解析之后加载(存在才加载),凭证只经
 * `process.env[credentialEnvVar]` 读——票 01 不读凭证,但要保证根解析与加载时机正确,
 * 让票 08 的真实客户端直接可用。
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createModelClient } from "./client-factory.js";
import { loadModelsConfig, type ModelConfig } from "./config.js";
import { readRuleDocs, type RuleDocs } from "./contract.js";
import type { ChatMessage, ModelClient } from "./model-client.js";
import { loadBaseTemplate, renderBaseTemplate } from "./prompt.js";

/**
 * 单模型一次生成的全部共享输入(契约 §2)。由 `runGeneration` 组装一次、按模型复用;
 * 票 02 的 `generateOneModel(request, config)` 从这里取它需要的一切。
 */
export type GenerationRequest = {
  readonly root: string;
  readonly runId: string;
  readonly docs: RuleDocs;
  readonly template: string;
  readonly createClient: (config: ModelConfig) => ModelClient;
  readonly now: () => Date;
  readonly maxRounds?: number;
};

export type GenerationOptions = {
  readonly root: string;
  /** `--config` 的取值,相对 `root`(传绝对路径亦按 `resolve` 归一)。 */
  readonly configPath: string;
  /** `--model <slug>`:只跑一个模型。 */
  readonly modelFilter?: string;
  /** 测试注入桩;缺省用真实 HTTP 客户端(票 08 之前会抛"未实现")。 */
  readonly createClient?: (config: ModelConfig) => ModelClient;
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

/** 时间戳形态的 `runId`:`:`/`.` 换成 `-`,让它能直接当目录名(票 02 会用它建存档目录)。 */
const runIdOf = (at: Date): string => at.toISOString().replaceAll(":", "-").replace(".", "-");

/**
 * 单模型一次:组装 prompt → 经端口发一次请求 → 回得脚本文本。
 *
 * **票 02 的替换点**:这里会换成 `pipeline.ts` 的 `generateOneModel(request, config)`,
 * 把"一次发送"扩成"逐轮 编译 → 校验 → 失败回喂、上限 `protocolRounds`",并返回 `ModelOutcome`。
 */
const sendOnce = async (request: GenerationRequest, config: ModelConfig): Promise<string> => {
  const prompt = renderBaseTemplate(request.template, request.docs, config.strategy);
  const messages: readonly ChatMessage[] = [{ role: "user", content: prompt }];
  const response = await request.createClient(config).send(messages, config.params ?? {});
  return response.text;
};

/**
 * 多模型编排:读配置 + 契约 + 模板,逐模型串行生成。
 *
 * 返回进程退出码:全部模型发出且拿到文本 = 0,任一失败 = 1。票 01 **不落存档、不编译**:
 * 回得的脚本文本作为中间结果留在 `generated` 里(其形状即票 02 接手的输入)。
 */
export const runGeneration = async (options: GenerationOptions): Promise<number> => {
  const root = resolve(options.root);
  const config = loadModelsConfig(resolve(root, options.configPath));
  const docs = readRuleDocs(root);
  const template = loadBaseTemplate(root);
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

  const createClient = options.createClient ?? createModelClient;
  const request: GenerationRequest = {
    root,
    runId: runIdOf(now()),
    docs,
    template,
    createClient,
    now,
  };

  // 票 01 的中间结果:每模型回得的脚本文本。票 02 会在这里接上编译/校验/冻结。
  const generated: { readonly slug: string; readonly script: string }[] = [];
  for (const model of selected) {
    try {
      const script = await sendOnce(request, model);
      generated.push({ slug: model.slug, script });
    } catch (cause) {
      process.stderr.write(`modelwar gen: 模型 ${model.slug} 生成失败:${messageOf(cause)}\n`);
    }
  }
  return generated.length === selected.length ? EXIT_OK : EXIT_FAILED;
};

/** `gen` 的三个选项;`-h/--help` 已由 CLI 路由层拦截,不进处理器。 */
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
  } = { root: undefined, config: undefined, model: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined || !arg.startsWith("-")) {
      throw new Error(`gen 不接受位置参数:${String(arg)}`);
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
  // 真实读取在票 08;此处只保证加载时机正确、且不把文件内容写进任何日志。
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
