/**
 * 本季参赛模型配置的加载与校验(hld §2.2.6 的「模型配置」行)。
 *
 * ── 为什么类型与校验住在 gen 包内,而**不**进 `@model-war/schema` ──
 *
 * schema 收的是**跨进程交换的数据形状**(规则集 / 地图 / 存档 meta / 对局输入 / 回放行 /
 * 终局结果五类)。`models.yaml` 只被 gen 读一次、从不经进程边界,也不进对局——把它塞进
 * schema 会让「schema 里有什么」这条边界失去意义(ADR-0003)。故它是 gen 的私有类型。
 *
 * ── 为什么逐字段汇总报错,而不是遇到第一条就抛 ──
 *
 * 改配置的人要的是一份**一次看完**的清单:缺三个字段时逐条修,而不是修一个重跑一次。
 * 每条都点名 `models[序号]` 与字段名,再在末尾拼进文件路径。
 */

import { readFileSync } from "node:fs";
import type { ModelParams } from "./model-client.js";
import { parseYamlSubset } from "./yaml-lite.js";

/** 三条端点族:本期已开通模型全落在它们里(hld §2.2.6)。新增一族才需要动适配层。 */
export type EndpointFamily = "chat-completions" | "messages" | "responses";

export const ENDPOINT_FAMILIES: readonly EndpointFamily[] = [
  "chat-completions",
  "messages",
  "responses",
];

/** 一条模型条目。必填五项之外,其余是可选项(缺省语义见各自注释)。 */
export type ModelConfig = {
  readonly slug: string;
  readonly endpointFamily: EndpointFamily;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly credentialEnvVar: string;
  /** 契约 + prompt 的 token 预算核对用;缺省即不核对。 */
  readonly contextLength?: number;
  /** 模型调用总轮数,**含初次生成**(默认 5,gen 内部默认;hld §2.2.6)。 */
  readonly protocolRounds?: number;
  /** 策略取向一行文;缺省即模板里的 `{{strategy}}` 整段不注入。 */
  readonly strategy?: string;
  /** 透传给端点族的参数(temperature 等);缺省即空。 */
  readonly params?: ModelParams;
};

export type ModelsConfig = {
  readonly models: readonly ModelConfig[];
};

/** 配置加载失败的统一出口:把逐字段问题拼成一份一次看完的清单。 */
const configError = (filePath: string, issues: readonly string[]): Error =>
  new Error(`模型配置无效(${filePath}):\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readSource = (filePath: string): string => {
  try {
    return readFileSync(filePath, "utf8");
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`读不到模型配置 ${filePath}:${reason}`);
  }
};

const parseSource = (source: string, filePath: string): unknown => {
  try {
    return parseYamlSubset(source, filePath);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`模型配置 YAML 解析失败(${filePath}):${reason}`);
  }
};

/** 必填字符串:读取并校验,缺失或类型不符时把一条问题记进 `issues`。 */
const requiredString = (
  entry: Record<string, unknown>,
  key: string,
  label: string,
  issues: string[],
): string | undefined => {
  const value = entry[key];
  if (typeof value !== "string" || value.length === 0) {
    issues.push(`${label}:必填字段 "${key}" 缺失或不是非空字符串`);
    return undefined;
  }
  return value;
};

/** 可选正整数(protocolRounds / contextLength):给了就必须是 ≥1 的整数。 */
const optionalPositiveInteger = (
  entry: Record<string, unknown>,
  key: string,
  label: string,
  issues: string[],
): number | undefined => {
  const value = entry[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    issues.push(`${label}:可选字段 "${key}" 必须是 ≥1 的整数`);
    return undefined;
  }
  return value;
};

const parseEndpointFamily = (
  entry: Record<string, unknown>,
  label: string,
  issues: string[],
): EndpointFamily | undefined => {
  const value = entry.endpointFamily;
  if (ENDPOINT_FAMILIES.includes(value as EndpointFamily)) {
    return value as EndpointFamily;
  }
  issues.push(
    `${label}:必填字段 "endpointFamily" 取值 "${String(value)}" 未知(应取 ${ENDPOINT_FAMILIES.join(
      " / ",
    )})`,
  );
  return undefined;
};

const parseParams = (
  entry: Record<string, unknown>,
  label: string,
  issues: string[],
): ModelParams | undefined => {
  const value = entry.params;
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    issues.push(`${label}:可选字段 "params" 必须是键值对映射`);
    return undefined;
  }
  return value;
};

const parseEntry = (entry: unknown, index: number, issues: string[]): ModelConfig | undefined => {
  const label = `models[${index}]`;
  if (!isRecord(entry)) {
    issues.push(`${label}:条目必须是键值对映射`);
    return undefined;
  }

  const slug = requiredString(entry, "slug", label, issues);
  const endpointFamily = parseEndpointFamily(entry, label, issues);
  const baseUrl = requiredString(entry, "baseUrl", label, issues);
  const modelId = requiredString(entry, "modelId", label, issues);
  const credentialEnvVar = requiredString(entry, "credentialEnvVar", label, issues);
  const contextLength = optionalPositiveInteger(entry, "contextLength", label, issues);
  const protocolRounds = optionalPositiveInteger(entry, "protocolRounds", label, issues);
  const strategy = entry.strategy;
  if (strategy !== undefined && typeof strategy !== "string") {
    issues.push(`${label}:可选字段 "strategy" 必须是字符串`);
  }
  const params = parseParams(entry, label, issues);

  if (
    slug === undefined ||
    endpointFamily === undefined ||
    baseUrl === undefined ||
    modelId === undefined ||
    credentialEnvVar === undefined ||
    (strategy !== undefined && typeof strategy !== "string") ||
    (entry.params !== undefined && params === undefined)
  ) {
    return undefined;
  }

  return {
    slug,
    endpointFamily,
    baseUrl,
    modelId,
    credentialEnvVar,
    ...(contextLength !== undefined ? { contextLength } : {}),
    ...(protocolRounds !== undefined ? { protocolRounds } : {}),
    ...(strategy !== undefined ? { strategy } : {}),
    ...(params !== undefined ? { params } : {}),
  };
};

const assertUniqueSlugs = (models: readonly ModelConfig[], filePath: string): void => {
  const seen = new Set<string>();
  const issues: string[] = [];
  for (const model of models) {
    if (seen.has(model.slug)) {
      issues.push(`"slug" 重复:${model.slug}(存档目录以 slug 分家,必须唯一)`);
    }
    seen.add(model.slug);
  }
  if (issues.length > 0) {
    throw configError(filePath, issues);
  }
};

/**
 * 从 `models.yaml` 读入并校验本季参赛配置。
 *
 * 缺必填字段 / `endpointFamily` 未知 / 缺 `credentialEnvVar` / 条目为空 / slug 重复 → 抛错,
 * 消息里逐条点名是哪个条目的哪个字段。
 */
export const loadModelsConfig = (filePath: string): ModelsConfig => {
  const data = parseSource(readSource(filePath), filePath);
  if (!isRecord(data)) {
    throw configError(filePath, ["顶层必须是一个键值对映射,含 models 数组"]);
  }
  const rawModels = data.models;
  if (!Array.isArray(rawModels)) {
    throw configError(filePath, ['顶层 "models" 必须是数组']);
  }
  if (rawModels.length === 0) {
    // 空清单静默返回 0 会把"没配"读成"跑通了";本仓对空集合一律按失败处理(与门禁同一口径)。
    throw configError(filePath, ['"models" 至少要有 1 条模型(空清单会让 gen 静默无产出)']);
  }

  const issues: string[] = [];
  const models: ModelConfig[] = [];
  rawModels.forEach((entry, index) => {
    const parsed = parseEntry(entry, index, issues);
    if (parsed !== undefined) {
      models.push(parsed);
    }
  });

  if (issues.length > 0) {
    throw configError(filePath, issues);
  }
  assertUniqueSlugs(models, filePath);
  return { models };
};
