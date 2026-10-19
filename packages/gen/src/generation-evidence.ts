import { USAGE_NUMERIC_FIELDS, USAGE_ENUM_FIELDS } from "@model-war/schema";
import type { ModelResponse } from "./model-client.js";
import { isRecord } from "./record.js";

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
export const projectUsage = (usage: unknown): Readonly<Record<string, unknown>> | undefined => {
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
): AttemptEvidence => {
  const usage = projectUsage(response.usage);
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
