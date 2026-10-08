/**
 * `ModelClient` 的真实 HTTP 适配器(hld §2.2.6,唯一允许联网的代码)。
 *
 * ── 零厂商 SDK ──
 *
 * 只走 Node 内置的 `fetch`。三家端点族的差异全在 `endpoints.ts` 的翻译层,这里只管
 * 「拼 URL → 挂鉴权头 → POST → 按状态码分类失败」。引厂商 SDK 会让依赖面随节点扩张,
 * 而本期真正需要的是三条稳定的 HTTP 形状。
 *
 * ── 凭证 ──
 *
 * 只从 `process.env[config.credentialEnvVar]` 读,拼成 `Authorization: Bearer <key>`。
 * **绝不**把 key 写进任何错误 / 日志 / 存档:错误消息里只出现变量名与 URL,不出现值。
 * 缺变量时立刻抛一个明确错误(点名变量名),而不是发一个没有鉴权头的请求等 401。
 *
 * ── 失败分类(契约 §2.1)──
 *
 * 429 / 5xx / 网络失败 / 超时 → `TransportError.retryable = true`(票 06 重发同一轮);
 * 其余 4xx → `retryable = false`。截断不走这里,见 `endpoints.ts` 的 `finishReason`。
 */

import type { ModelConfig } from "../config.js";
import type { ModelClient, ModelResponse } from "../model-client.js";
import { TransportError } from "../transport-error.js";
import { endpointSpec } from "./endpoints.js";

/**
 * 单次请求的 wall-clock 上限。
 *
 * 这是 **gen 内部工程参数**,不进 `rulesets/*.json`(那管对局规则与数值)。给一个宽裕值:
 * 契约体量大、模型出整段脚本可能很慢;真正的「重发同一轮」由票 06 的退避层按 `retryable` 决定。
 */
export const DEFAULT_TIMEOUT_MS = 120_000;

/** `createHttpModelClient` 的可选覆盖:测试用极短超时避免拖慢(生产不传)。 */
export type HttpModelClientOptions = {
  /** 覆盖 `DEFAULT_TIMEOUT_MS`(毫秒);缺省用常量。 */
  readonly timeoutMs?: number;
};

/** 拼接 `baseUrl` 与端点路径:去掉 baseUrl 末尾斜杠、补上路径前导斜杠,绝不产生 `//`。 */
const joinUrl = (baseUrl: string, path: string): string => {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
};

/** 429 与 5xx 是「过一会儿可能成功」的一类;其余 4xx 是请求本身的问题,重发无益。 */
const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;

/** 响应体片段:只用于让错误可诊断,截断到定长,绝不含请求头里的凭证。 */
const bodySnippet = (body: string): string => {
  const trimmed = body.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
};

const reasonOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** 读凭证:缺失即抛明确错误(只点名变量名,不泄露任何值)。 */
const readCredential = (config: ModelConfig): string => {
  const value = process.env[config.credentialEnvVar];
  if (value === undefined || value.length === 0) {
    throw new Error(
      `模型 ${config.slug} 缺凭证:环境变量 ${config.credentialEnvVar} 未设置或为空。` +
        `请导出该变量,或写入 <root>/.env(凭证绝不入库、不进日志)。`,
    );
  }
  return value;
};

/**
 * 造一个真实 HTTP 客户端。`options` 只用于测试注入超时;**契约签名是 `(config) => ModelClient`**,
 * 第二参数可选,不传即用 `DEFAULT_TIMEOUT_MS`。
 */
export const createHttpModelClient = (
  config: ModelConfig,
  options: HttpModelClientOptions = {},
): ModelClient => {
  const spec = endpointSpec(config.endpointFamily);
  const url = joinUrl(config.baseUrl, spec.path);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    send: async (messages, params): Promise<ModelResponse> => {
      const credential = readCredential(config);
      const payload = JSON.stringify(spec.buildBody(config, messages, params));

      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${credential}`,
          },
          body: payload,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) {
        // 网络失败 / DNS / 连接被拒 / 超时(AbortSignal.timeout 触发的 abort)都到这里,一律可重试。
        throw new TransportError(`请求 ${url} 失败:${reasonOf(cause)}`, { retryable: true });
      }

      let rawBody: string;
      try {
        rawBody = await response.text();
      } catch (cause) {
        throw new TransportError(`读 ${url} 的响应失败:${reasonOf(cause)}`, {
          retryable: true,
          status: response.status,
        });
      }

      if (!response.ok) {
        throw new TransportError(
          `端点 ${url} 返回 ${String(response.status)} ${response.statusText}: ${bodySnippet(rawBody)}`,
          { retryable: isRetryableStatus(response.status), status: response.status },
        );
      }

      let json: unknown;
      try {
        json = JSON.parse(rawBody) as unknown;
      } catch {
        throw new TransportError(
          `端点 ${url} 返回的不是合法 JSON(HTTP ${String(response.status)})`,
          {
            retryable: false,
            status: response.status,
          },
        );
      }
      return spec.parseResponse(json);
    },
  };
};
