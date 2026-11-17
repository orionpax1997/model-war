import { USAGE_NUMERIC_FIELDS, USAGE_ENUM_FIELDS } from "@model-war/schema";
import type { EndpointFamily } from "./config.js";
import type { ModelResponse } from "./model-client.js";
import { isRecord } from "./record.js";

/** 用量口径：报告靠它选「哪个字段算输入 / 缓存」那一套读法。 */
export type UsageCaliber = "openai" | "anthropic";

/**
 * 端点族 → 用量口径（**缺省值**）。
 *
 * 报告靠 `usage_semantic` 选「哪个字段算输入 / 缓存」那一套读法；本包以前从不写它，于是多路径
 * 都有值时按容器顺序取第一个、冲突时置 `unknown`。端点族是本地已知事实，能给出一个不缺省的默认。
 * 但它不等于上游形状：chat 线协议也可能回 anthropic 字段，所以服务端回显过的口径不被覆盖。
 * Google 的 `usageMetadata` 自成一套，没有对应枚举，不写——不往枚举里塞第四个值。
 */
export const usageCaliberOf = (family: EndpointFamily): UsageCaliber | undefined =>
  family === "messages" ? "anthropic" : family === "generate-content" ? undefined : "openai";

const objectAt = (root: unknown, path: string): Record<string, unknown> => {
  const value =
    path === ""
      ? root
      : path
          .split(".")
          .reduce<unknown>(
            (parent, key) =>
              isRecord(parent) && Object.hasOwn(parent, key) ? parent[key] : undefined,
            root,
          );
  return isRecord(value) ? value : {};
};
const setProjected = (
  root: Record<string, unknown>,
  path: string,
  value: number | string | null,
): void => {
  const parts = path.split(".");
  const key = parts.pop()!;
  let parent = root;
  for (const part of parts) {
    if (!isRecord(parent[part])) parent[part] = {};
    parent = parent[part] as Record<string, unknown>;
  }
  parent[key] = value;
};

/** 只保留已知数字与语义枚举，不保存模型原文、prompt、错误体；重叠字段不相加。 */
export const projectUsage = (
  usage: unknown,
  caliber?: UsageCaliber,
): Readonly<Record<string, unknown>> | undefined => {
  if (!isRecord(usage)) return undefined;
  const projected: Record<string, unknown> = {};
  for (const [path, fields] of Object.entries(USAGE_NUMERIC_FIELDS)) {
    const parent = objectAt(usage, path);
    for (const key of fields) {
      if (!Object.hasOwn(parent, key)) continue;
      const value = parent[key];
      if (
        value === null ||
        (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
      )
        setProjected(projected, path === "" ? key : `${path}.${key}`, value);
    }
  }
  for (const [path, allowed] of Object.entries(USAGE_ENUM_FIELDS)) {
    const parts = path.split(".");
    const key = parts.pop()!;
    const parent = objectAt(usage, parts.join("."));
    if (!Object.hasOwn(parent, key)) continue;
    const value = parent[key];
    if (typeof value === "string" && (allowed as readonly string[]).includes(value))
      setProjected(projected, path, value);
  }
  // 端点族口径只补缺省：回显描述的是服务端**实际采用的字段约定**，比我们按线协议推断的单一口径
  // 更贴近事实（Opus 兼容中转就是 chat 线协议 + anthropic 字段）。回显了任一字段就整对保留。
  const echoed =
    Object.hasOwn(projected, "usage_semantic") || Object.hasOwn(projected, "usage_source");
  // 空 usage 不能被口径字段伪装成「有读数」。
  if (caliber !== undefined && !echoed && Object.keys(projected).length > 0) {
    projected.usage_semantic = caliber;
    projected.usage_source = caliber;
  }
  return Object.keys(projected).length === 0 ? undefined : projected;
};

export type AttemptEvidence = {
  readonly attempt: number;
  readonly outcome: "response" | "transport-error";
  readonly finishReason?: string;
  readonly stopDetails?: ModelResponse["stopDetails"];
  readonly usage?: Readonly<Record<string, unknown>>;
};

export const responseAttemptEvidence = (
  attempt: number,
  response: ModelResponse,
  caliber?: UsageCaliber,
): AttemptEvidence => {
  const usage = projectUsage(response.usage, caliber);
  return {
    attempt,
    outcome: "response",
    finishReason: response.finishReason,
    ...(response.stopDetails === undefined
      ? {}
      : {
          stopDetails: {
            ...(response.stopDetails.reason === undefined
              ? {}
              : { reason: response.stopDetails.reason }),
            ...(response.stopDetails.status === undefined
              ? {}
              : { status: response.stopDetails.status }),
          },
        }),
    ...(usage === undefined ? {} : { usage }),
  };
};
