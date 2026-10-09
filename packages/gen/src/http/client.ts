/**
 * `ModelClient` 的真实 HTTP 适配器(hld §2.2.6,唯一允许联网的代码)。
 *
 * ── 零厂商 SDK ──
 *
 * 只走 Node 内置的 `fetch` 与 `TextDecoder`。三家端点族的差异全在 `endpoints.ts` 的翻译层,
 * 这里只管「拼 URL → 挂鉴权头 → POST → 按 content-type 把响应读回 → 按状态码分类失败」。
 * 引厂商 SDK / SSE 库会让依赖面随节点扩张,而本期真正需要的是三条稳定的 HTTP 形状。
 *
 * ── 为什么 chat-completions 走 SSE,而不是一次性 JSON ──
 *
 * 真实赛季实测:单次生成 150–176 s,而网关在 ~130 s 上就回 HTTP 524(origin 超时)——一次性
 * 响应在这条链路上永远读不到。SSE(`text/event-stream`)让字节从头就开始流动,既绕开 origin
 * 的空闲超时,也把「多久算久」从「整次请求多长」改成「两次读到数据之间隔多久」。只有
 * `endpoints.ts` 里声明了 `streaming` 的端点族才走这条路;其余按 content-type 回退到一次性
 * JSON——服务商忽略 `stream`、照旧回整段 JSON 时,同一条代码路径仍然可用。
 *
 * ── 凭证 ──
 *
 * 只从 `process.env[config.credentialEnvVar]` 读,拼成 `Authorization: Bearer <key>`。
 * **绝不**把 key 写进任何错误 / 日志 / 存档:错误消息里只出现变量名与 URL,不出现值。
 * 缺变量时立刻抛一个明确错误(点名变量名),而不是发一个没有鉴权头的请求等 401。
 *
 * ── 失败分类(契约 §2.1)──
 *
 * 429 / 5xx / 网络失败 / **空闲超时** / 流在 `[DONE]` 前断掉 / 帧里带 `error` →
 * `TransportError.retryable = true`(票 06 重发同一轮);其余 4xx → `retryable = false`。
 * 截断(`finishReason === "length"`)不走这里,见 `endpoints.ts`。
 */

import type { ModelConfig } from "../config.js";
import type { ModelClient, ModelResponse } from "../model-client.js";
import { isRecord } from "../record.js";
import { TransportError } from "../transport-error.js";
import { endpointSpec, type StreamAccumulator } from "./endpoints.js";

/**
 * 两次读到数据之间的**空闲**上限(毫秒),不是整次请求的 wall-clock 上限。
 *
 * ── 为什么是空闲口径 ──
 *
 * 慢但一直在出字的生成是合法的:给总时长设限会把它误杀(实测推理型模型单次要 150–176 s),
 * 而真问题(网关 524)本就是「origin 多久没收到字节」的空闲超时。于是计时器在**每次读到一段
 * 数据时重置**:流式下即「两帧之间最多静默这么久」;非流式响应没有中途数据可重置,退化成
 * 「整段响应的上限」,与非流式时代等价。
 *
 * 这是 **gen 内部工程参数**:不进 `rulesets/*.json`(那管对局规则与数值),也不接 `models.yaml`
 * 的 per-model 旋钮——它与 `retry.ts` 的 `RETRY` 同性质,单一真源就是本常量。
 */
export const DEFAULT_TIMEOUT_MS = 300_000;

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

/** `content-type` 含 `text/event-stream` 才按 SSE 读;忽略 `stream`、照旧回整段 JSON 时自然回退。 */
const isEventStream = (response: Response): boolean =>
  (response.headers.get("content-type") ?? "").includes("text/event-stream");

/**
 * 取 SSE 一行的 `data:` 载荷;返回 `undefined` 表示这行不成一帧:
 * 空行(帧分隔)、`:` 开头的注释行、`event:` / `id:` 等其它字段行。容忍 CRLF 的行尾 `\r`。
 */
const dataPayloadOf = (line: string): string | undefined => {
  const body = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (!body.startsWith("data:")) {
    return undefined;
  }
  const rest = body.slice("data:".length);
  return rest.startsWith(" ") ? rest.slice(1) : rest;
};

/**
 * 解析一帧 `data:` 载荷。
 *
 * 不是合法 JSON → 网关给了我们不认识的东西(连接噪声 / 被截断的半帧),判可重试;顶层带非空
 * `error`(网关在流中报错)→ 同样判可重试,并把片段留在消息里便于定位。两者都是「重发一次
 * 可能正好避开」的传输故障,故不走 `endpoints.ts` 的翻译层。
 */
const parseSseFrame = (payload: string, url: string): unknown => {
  let frame: unknown;
  try {
    frame = JSON.parse(payload) as unknown;
  } catch {
    throw new TransportError(`端点 ${url} 的流里有一帧不是合法 JSON:${bodySnippet(payload)}`, {
      retryable: true,
    });
  }
  if (isRecord(frame) && frame.error !== undefined && frame.error !== null) {
    throw new TransportError(`端点 ${url} 的流里返回了错误帧:${bodySnippet(payload)}`, {
      retryable: true,
    });
  }
  return frame;
};

/** `readEventStream` 的入参:响应、累积器,以及两个计时回调(重置 / 是否已空闲超时)。 */
type EventStreamRead = {
  readonly response: Response;
  readonly url: string;
  readonly accumulator: StreamAccumulator;
  readonly timeoutMs: number;
  /** 每读到一段数据调用一次:客户端据此重置空闲计时器。 */
  readonly onData: () => void;
  /** 空闲计时器是否已触发(用于把中断归类成超时,而不是普通读失败)。 */
  readonly timedOut: () => boolean;
};

/**
 * 逐帧读 `text/event-stream` 直到 `[DONE]`,交给累积器拼回统一形状。
 *
 * 帧之间用空行分隔、行尾可能是 `\r\n`,一帧还可能被 TCP 切在两个 chunk 中间——所以按 `\n`
 * 切行、最后一段不完整的留在缓冲里等下一个 chunk,**不假设**「一次 read 正好一帧」。
 *
 * 失败归类:JSON 解析失败 / 错误帧 / `[DONE]` 之前流就结束 → `retryable: true`;空闲超时触发的
 * 中断**不挂 `status`**(与「连接都没建立起来」的超时同一形状),其余读失败挂已知的状态码。
 */
const readEventStream = async (options: EventStreamRead): Promise<ModelResponse> => {
  const { response, url, accumulator } = options;
  const body = response.body;
  if (body === null) {
    throw new TransportError(`端点 ${url} 声明了 text/event-stream 却没有响应体`, {
      retryable: true,
      status: response.status,
    });
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawDone = false;

  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      options.onData();
      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const payload = dataPayloadOf(line);
        if (payload === undefined) {
          continue;
        }
        if (payload === "[DONE]") {
          sawDone = true;
          break;
        }
        accumulator.push(parseSseFrame(payload, url));
      }
      if (sawDone) {
        break;
      }
    }
  } catch (cause) {
    if (cause instanceof TransportError) {
      throw cause;
    }
    throw new TransportError(
      options.timedOut()
        ? `端点 ${url} 的流空闲超过 ${String(options.timeoutMs)}ms 没有数据,已中断`
        : `读 ${url} 的流失败:${reasonOf(cause)}`,
      options.timedOut() ? { retryable: true } : { retryable: true, status: response.status },
    );
  } finally {
    // 已在 `[DONE]` 处提前退出时,去掉尾部未处理的数据并关掉连接;读失败时 cancel 会 reject,忽略。
    await reader.cancel().catch(() => undefined);
  }

  if (!sawDone) {
    throw new TransportError(`端点 ${url} 的流在 [DONE] 之前结束(连接被中途切断)`, {
      retryable: true,
      status: response.status,
    });
  }
  return accumulator.result();
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
  const streaming = spec.streaming;
  const url = joinUrl(config.baseUrl, spec.path);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    send: async (messages, params): Promise<ModelResponse> => {
      const credential = readCredential(config);
      // 声明了流式能力的端点族一律带流式字段发;响应是不是真流式仍按 content-type 分派。
      const body = JSON.stringify(
        streaming === undefined
          ? spec.buildBody(config, messages, params)
          : streaming.buildBody(config, messages, params),
      );

      const controller = new AbortController();
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let idleTimedOut = false;
      /** 重置空闲计时器:每收到一段数据(响应头 / 每个 chunk)都算「还在动」。 */
      const armIdleTimer = (): void => {
        if (idleTimer !== undefined) {
          clearTimeout(idleTimer);
        }
        idleTimer = setTimeout(() => {
          idleTimedOut = true;
          controller.abort();
        }, timeoutMs);
      };
      const disarmIdleTimer = (): void => {
        if (idleTimer !== undefined) {
          clearTimeout(idleTimer);
          idleTimer = undefined;
        }
      };

      armIdleTimer();

      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${credential}`,
          },
          body,
          signal: controller.signal,
        });
      } catch (cause) {
        // 网络失败 / DNS / 连接被拒 / 空闲超时(手动 abort)都到这里,一律可重试。
        disarmIdleTimer();
        throw new TransportError(
          idleTimedOut
            ? `请求 ${url} 后 ${String(timeoutMs)}ms 没有收到响应头(空闲超时)`
            : `请求 ${url} 失败:${reasonOf(cause)}`,
          { retryable: true },
        );
      }
      // 响应头到了:从这一时刻起重新计空闲。
      armIdleTimer();

      try {
        if (response.ok && streaming !== undefined && isEventStream(response)) {
          return await readEventStream({
            response,
            url,
            accumulator: streaming.createAccumulator(),
            timeoutMs,
            onData: armIdleTimer,
            timedOut: () => idleTimedOut,
          });
        }

        let rawBody: string;
        try {
          rawBody = await response.text();
        } catch (cause) {
          throw idleTimedOut
            ? new TransportError(`端点 ${url} 在 ${String(timeoutMs)}ms 内没有读完响应(空闲超时)`, {
                retryable: true,
              })
            : new TransportError(`读 ${url} 的响应失败:${reasonOf(cause)}`, {
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
      } finally {
        disarmIdleTimer();
      }
    },
  };
};
