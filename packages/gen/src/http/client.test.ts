/**
 * 真实 HTTP 客户端的契约测试:**本地假端点**(`node:http` 监听 `127.0.0.1:0`),不触真网、不需真凭证。
 *
 * 断言的外部可观察行为:发出去的请求(方法 / 路径 / 鉴权头 / body 形状)与读回来的统一形状
 * (`text` / `finishReason` / `usage`),以及失败分类。凭证用假 key 注入 `process.env`,
 * 并顺带钉住"错误消息绝不包含 key"。
 */

import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelConfig } from "../config.js";
import { generationParams, generationRequestEvidence } from "../generation-policy.js";
import { policyFixture } from "../generation-policy.fixture.js";
import { createHttpModelClient as createExportedModelClient } from "../index.js";
import type { ChatMessage, ModelClient } from "../model-client.js";
import { TransportError } from "../transport-error.js";
import { createHttpModelClient } from "./client.js";

const TEST_KEY_ENV = "TEST_HTTP_KEY";
const TEST_KEY_VALUE = "test-secret-key";

type Captured = {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly sessionId: string | undefined;
  readonly userAgent: string | undefined;
  readonly apiKey: string | undefined;
  readonly anthropicVersion: string | undefined;
  readonly body: unknown;
};

type Responder = (captured: Captured, res: ServerResponse) => void;

type FakeEndpoint = {
  readonly baseUrl: string;
  readonly requests: Captured[];
  readonly close: () => Promise<void>;
};

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/** 开一个 SSE 响应:假端点每次 `write` 就是独立一个 chunk,故能逐帧控制到达时机(测拆帧 / 空闲超时都靠它)。 */
const openSse = (res: ServerResponse): void => {
  res.writeHead(200, { "content-type": "text/event-stream" });
};

/** 写一帧 `data: <json>`:SSE 以空行分帧,写完不关连接,模拟真实流「一帧一帧到」。 */
const sseFrame = (res: ServerResponse, frame: unknown): void => {
  res.write(`data: ${JSON.stringify(frame)}\n\n`);
};

/** 写一段正文增量帧:线上正文本就摊在多帧,测试这样一帧一帧拼才贴近真实形状。 */
const sseContent = (res: ServerResponse, text: string): void => {
  sseFrame(res, { choices: [{ delta: { content: text }, finish_reason: null }] });
};

/** 收尾并关连接:客户端以 `[DONE]` 判定流正常结束,缺它就应算中断。 */
const sseDone = (res: ServerResponse): void => {
  res.write("data: [DONE]\n\n");
  res.end();
};

/** 索引取头的值可能是 `string[]`;测试只关心单值,取首个。 */
const singleHeader = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const startEndpoint = async (respond: Responder): Promise<FakeEndpoint> => {
  const requests: Captured[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
    });
    req.on("end", () => {
      const captured: Captured = {
        method: req.method ?? "",
        path: req.url ?? "",
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        sessionId: singleHeader(req.headers["x-opencode-session"]),
        userAgent: singleHeader(req.headers["user-agent"]),
        apiKey: singleHeader(req.headers["x-api-key"]),
        anthropicVersion: singleHeader(req.headers["anthropic-version"]),
        body: raw.length > 0 ? (JSON.parse(raw) as unknown) : undefined,
      };
      requests.push(captured);
      respond(captured, res);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("假端点没有拿到端口");
  }
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
};

const endpoints: FakeEndpoint[] = [];
const endpoint = async (respond: Responder): Promise<FakeEndpoint> => {
  const created = await startEndpoint(respond);
  endpoints.push(created);
  return created;
};

const config = (family: ModelConfig["endpointFamily"], baseUrl: string): ModelConfig => ({
  slug: "model-x",
  endpointFamily: family,
  baseUrl,
  modelId: "vendor/model-x",
  credentialEnvVar: TEST_KEY_ENV,
});

const user = (content: string): ChatMessage => ({ role: "user", content });

const expectTransportError = async (promise: Promise<unknown>): Promise<TransportError> => {
  try {
    await promise;
  } catch (cause) {
    if (cause instanceof TransportError) {
      return cause;
    }
    throw cause;
  }
  throw new Error("预期抛出 TransportError,但没有");
};

/** 缺凭证抛的是通用 `Error`(不是 TransportError),单独断言:消息点名变量名、且不触网。 */
const expectCredentialError = async (client: ModelClient): Promise<Error> => {
  try {
    await client.send([user("hi")], {});
  } catch (cause) {
    if (cause instanceof Error) {
      return cause;
    }
    throw cause;
  }
  throw new Error("预期缺凭证时抛错,但没有");
};

beforeEach(() => {
  process.env[TEST_KEY_ENV] = TEST_KEY_VALUE;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(endpoints.splice(0).map((created) => created.close()));
});

it("chat-completions:POST /chat/completions + Bearer 鉴权 + 流式 body 形状", async () => {
  const ep = await endpoint((_captured, res) =>
    json(res, 200, {
      choices: [{ message: { content: "脚本正文" }, finish_reason: "stop" }],
      usage: { total_tokens: 5 },
    }),
  );
  const client: ModelClient = createHttpModelClient(config("chat-completions", ep.baseUrl));

  const response = await client.send([user("hi")], { temperature: 0.3 });

  const request = ep.requests[0];
  expect(request?.method).toBe("POST");
  expect(request?.path).toBe("/chat/completions");
  expect(request?.authorization).toBe(`Bearer ${TEST_KEY_VALUE}`);
  expect(request?.contentType).toContain("application/json");
  expect(request?.userAgent).toBe("modelwar-gen");
  // 非 messages 族不发 x-api-key。
  expect(request?.apiKey).toBeUndefined();
  // 缺省不发会话头:保持对旧端点的请求字节不变。
  expect(request?.sessionId).toBeUndefined();
  // 声明了流式能力的端点族一律带流式字段发;这次回的是 application/json,客户端走回退路径解析。
  expect(request?.body).toEqual({
    model: "vendor/model-x",
    messages: [{ role: "user", content: "hi" }],
    temperature: 0.3,
    stream: true,
    stream_options: { include_usage: true },
  });
  expect(response).toMatchObject({
    text: "脚本正文",
    finishReason: "stop",
    usage: { total_tokens: 5 },
  });
});

it("chat-completions:content-type=application/json 时回退按一次性 JSON 解析(回退用例)", async () => {
  const ep = await endpoint((_captured, res) =>
    json(res, 200, {
      choices: [{ message: { content: "整段 JSON 也读得回" }, finish_reason: "stop" }],
      usage: { total_tokens: 9 },
    }),
  );
  const client = createHttpModelClient(config("chat-completions", ep.baseUrl));

  const response = await client.send([user("hi")], {});

  expect(response).toMatchObject({
    text: "整段 JSON 也读得回",
    finishReason: "stop",
    usage: { total_tokens: 9 },
  });
});

it("chat-completions:text/event-stream 多帧累积出与非流式同形的 text/finishReason/usage", async () => {
  const ep = await endpoint((_captured, res) => {
    openSse(res);
    sseFrame(res, { choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
    sseFrame(res, {
      choices: [{ delta: { reasoning_content: "让我想想…" }, finish_reason: null }],
    });
    sseContent(res, "脚本");
    sseContent(res, "正文");
    sseFrame(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
    sseFrame(res, {
      choices: [],
      usage: {
        prompt_tokens: 17800,
        completion_tokens: 900,
        completion_tokens_details: { reasoning_tokens: 640 },
      },
    });
    sseDone(res);
  });
  const client = createHttpModelClient(config("chat-completions", ep.baseUrl));

  const response = await client.send([user("hi")], {});

  expect(response).toMatchObject({
    text: "脚本正文",
    finishReason: "stop",
    usage: {
      prompt_tokens: 17800,
      completion_tokens: 900,
      completion_tokens_details: { reasoning_tokens: 640 },
    },
  });
});

it("chat-completions:一帧被切成两个 chunk 也拼得回(不假设一次 read 正好一帧)", async () => {
  const ep = await endpoint((_captured, res) => {
    openSse(res);
    const frame = `data: ${JSON.stringify({
      choices: [{ delta: { content: "切开的帧" }, finish_reason: "stop" }],
    })}\n\n`;
    const cut = 20;
    res.write(frame.slice(0, cut));
    setTimeout(() => {
      res.write(frame.slice(cut));
      res.write("data: [DONE]\n\n");
      res.end();
    }, 30);
  });
  const client = createHttpModelClient(config("chat-completions", ep.baseUrl), {
    timeoutMs: 2_000,
  });

  const response = await client.send([user("hi")], {});

  expect(response.text).toBe("切开的帧");
});

it("chat-completions:CRLF 行尾、注释行与 event/id 行都被容忍(只认 data: 行)", async () => {
  const ep = await endpoint((_captured, res) => {
    openSse(res);
    res.write(": 这是一条注释\r\n");
    res.write("event: message\r\n");
    res.write("id: 42\r\n");
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\r\n\r\n`,
    );
    res.write("data: [DONE]\r\n\r\n");
    res.end();
  });
  const client = createHttpModelClient(config("chat-completions", ep.baseUrl));

  const response = await client.send([user("hi")], {});

  expect(response).toMatchObject({ text: "ok", finishReason: "stop", usage: undefined });
});

it("chat-completions:SSE 截断帧 finish_reason=length 原样透传(重试交给 retry.ts,此处不重试)", async () => {
  const ep = await endpoint((_captured, res) => {
    openSse(res);
    sseContent(res, "半截脚本");
    sseFrame(res, { choices: [{ delta: {}, finish_reason: "length" }] });
    sseFrame(res, { choices: [], usage: { prompt_tokens: 1, completion_tokens: 8 } });
    sseDone(res);
  });
  const client = createHttpModelClient(config("chat-completions", ep.baseUrl));

  const response = await client.send([user("hi")], {});

  expect(response.finishReason).toBe("length");
  expect(response.text).toBe("半截脚本");
  expect(ep.requests).toHaveLength(1);
});

it("messages:text/event-stream 以 message_stop 收尾(无 [DONE]),thinking 增量不进正文", async () => {
  const ep = await endpoint((_captured, res) => {
    openSse(res);
    sseFrame(res, { type: "message_start", message: { usage: { input_tokens: 32 } } });
    sseFrame(res, {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "先想" },
    });
    sseFrame(res, {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "脚本" },
    });
    sseFrame(res, {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "正文" },
    });
    sseFrame(res, {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 2 },
    });
    sseFrame(res, { type: "message_stop" });
    res.end();
  });
  const client = createHttpModelClient(config("messages", ep.baseUrl));

  const response = await client.send([user("hi")], {});

  expect(response).toMatchObject({
    text: "脚本正文",
    finishReason: "stop",
    usage: { input_tokens: 32, output_tokens: 2 },
    stopDetails: { reason: "end_turn" },
  });
});

it("messages:SSE 在 message_stop 之前断掉 → TransportError retryable=true", async () => {
  const ep = await endpoint((_captured, res) => {
    openSse(res);
    sseFrame(res, {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "写到一半" },
    });
    res.end(); // 没有 message_stop
  });
  const client = createHttpModelClient(config("messages", ep.baseUrl));

  const error = await expectTransportError(client.send([user("hi")], {}));

  expect(error.retryable).toBe(true);
});

it("chat-completions:SSE 在 [DONE] 之前断掉 → TransportError retryable=true", async () => {
  const ep = await endpoint((_captured, res) => {
    openSse(res);
    sseContent(res, "写到一半");
    res.end(); // 没有 [DONE]
  });
  const client = createHttpModelClient(config("chat-completions", ep.baseUrl));

  const error = await expectTransportError(client.send([user("hi")], {}));

  expect(error.retryable).toBe(true);
  expect(error.message).toContain("收尾之前结束");
});

it("chat-completions:SSE 帧里带 error → TransportError retryable=true、消息不含凭证", async () => {
  const ep = await endpoint((_captured, res) => {
    openSse(res);
    sseContent(res, "开头");
    sseFrame(res, { error: { message: "upstream timeout", type: "server_error" } });
    sseDone(res);
  });
  const client = createHttpModelClient(config("chat-completions", ep.baseUrl));

  const error = await expectTransportError(client.send([user("hi")], {}));

  expect(error.retryable).toBe(true);
  expect(error.status).toBeUndefined();
  expect(error.message).toContain("upstream timeout");
  expect(error.message).not.toContain(TEST_KEY_VALUE);
});

it("chat-completions:帧间静默超过 timeoutMs → 空闲超时 TransportError(retryable=true、无 status)", async () => {
  const ep = await endpoint((_captured, res) => {
    openSse(res);
    sseContent(res, "起了个头");
    // 之后永不吐帧、也不收尾:让空闲计时器触发。
  });
  const client = createHttpModelClient(config("chat-completions", ep.baseUrl), { timeoutMs: 80 });

  const error = await expectTransportError(client.send([user("hi")], {}));

  expect(error.retryable).toBe(true);
  expect(error.status).toBeUndefined();
  expect(error.message).toContain("空闲");
});

it("chat-completions:总时长超过 timeoutMs 但帧间隔始终小于它 → 成功(证明超时是空闲口径)", async () => {
  const gapMs = 40;
  const ep = await endpoint((_captured, res) => {
    openSse(res);
    sseContent(res, "a");
    setTimeout(() => {
      sseContent(res, "b");
      setTimeout(() => {
        sseContent(res, "c");
        setTimeout(() => {
          sseFrame(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
          sseDone(res);
        }, gapMs);
      }, gapMs);
    }, gapMs);
  });
  // 单帧间隔 40ms,总时长 ≈120ms;若超时还是 wall-clock 口径,这条必然失败。
  const client = createHttpModelClient(config("chat-completions", ep.baseUrl), {
    timeoutMs: gapMs * 3,
  });

  const response = await client.send([user("hi")], {});

  expect(response.text).toBe("abc");
  expect(response.finishReason).toBe("stop");
});

it("messages:system 抽到顶层、不进 messages;stop_reason=max_tokens 归一成 length", async () => {
  const ep = await endpoint((_captured, res) =>
    json(res, 200, {
      content: [
        { type: "text", text: "ab" },
        { type: "text", text: "cd" },
      ],
      stop_reason: "max_tokens",
      usage: { output_tokens: 7 },
    }),
  );
  const client = createHttpModelClient(config("messages", ep.baseUrl));

  const response = await client.send(
    [
      { role: "system", content: "你是脚本作者" },
      { role: "user", content: "契约" },
      { role: "assistant", content: "上一轮回复" },
    ],
    { max_tokens: 4000, temperature: 0.5 },
  );

  const request = ep.requests[0];
  expect(request?.path).toBe("/messages");
  expect(request?.authorization).toBe(`Bearer ${TEST_KEY_VALUE}`);
  expect(request?.userAgent).toBe("modelwar-gen");
  expect(request?.apiKey).toBe(TEST_KEY_VALUE);
  expect(request?.body).toEqual({
    model: "vendor/model-x",
    max_tokens: 4000,
    temperature: 0.5,
    system: "你是脚本作者",
    messages: [
      { role: "user", content: "契约" },
      { role: "assistant", content: "上一轮回复" },
    ],
    stream: true,
  });
  expect(response).toMatchObject({
    text: "abcd",
    finishReason: "length",
    usage: { output_tokens: 7 },
  });
});

it("options.sessionId:发 x-opencode-session 头(缺省不发)", async () => {
  const ep = await endpoint((_captured, res) =>
    json(res, 200, {
      choices: [{ message: { content: "脚本正文" }, finish_reason: "stop" }],
      usage: { total_tokens: 5 },
    }),
  );
  const withSession = createHttpModelClient(config("chat-completions", ep.baseUrl), {
    sessionId: "modelwar-gen-run1-model-x",
  });
  await withSession.send([user("hi")], {});
  expect(ep.requests[0]?.sessionId).toBe("modelwar-gen-run1-model-x");

  const plain = createHttpModelClient(config("chat-completions", ep.baseUrl));
  await plain.send([user("hi")], {});
  expect(ep.requests[1]?.sessionId).toBeUndefined();
});

it("responses:POST /responses + body(model/input)+ output_text 拼接 + incomplete → length", async () => {
  const ep = await endpoint((_captured, res) =>
    json(res, 200, {
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [
        {
          type: "message",
          content: [
            { type: "output_text", text: "part1" },
            { type: "output_text", text: "part2" },
          ],
        },
      ],
      usage: { total_tokens: 3 },
    }),
  );
  const client = createHttpModelClient(config("responses", ep.baseUrl));

  const response = await client.send([{ role: "system", content: "s" }, user("u")], {});

  const request = ep.requests[0];
  expect(request?.path).toBe("/responses");
  expect(request?.authorization).toBe(`Bearer ${TEST_KEY_VALUE}`);
  expect(request?.userAgent).toBe("modelwar-gen");
  expect(request?.body).toEqual({
    model: "vendor/model-x",
    input: [
      { role: "system", content: "s" },
      { role: "user", content: "u" },
    ],
  });
  expect(response).toMatchObject({
    text: "part1part2",
    finishReason: "length",
    usage: { total_tokens: 3 },
  });
});

it("baseUrl 末尾斜杠不产生双斜杠", async () => {
  const ep = await endpoint((_captured, res) =>
    json(res, 200, { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
  );
  const client = createHttpModelClient(config("chat-completions", `${ep.baseUrl}/`));

  await client.send([user("hi")], {});

  expect(ep.requests[0]?.path).toBe("/chat/completions");
});

it("缺凭证环境变量:抛明确错误(点名变量名)、不发请求、消息不含任何 key", async () => {
  delete process.env.TEST_HTTP_MISSING_KEY;
  const ep = await endpoint((_captured, res) => json(res, 200, {}));
  const client = createHttpModelClient({
    ...config("chat-completions", ep.baseUrl),
    credentialEnvVar: "TEST_HTTP_MISSING_KEY",
  });

  const error = await expectCredentialError(client);

  expect(error).not.toBeInstanceOf(TransportError);
  expect(error.message).toContain("TEST_HTTP_MISSING_KEY");
  expect(ep.requests).toHaveLength(0);
});

it("429 → TransportError retryable=true、status=429;错误不含凭证", async () => {
  const ep = await endpoint((_captured, res) => json(res, 429, { error: "rate limited" }));
  const client = createHttpModelClient(config("chat-completions", ep.baseUrl));

  const error = await expectTransportError(client.send([user("hi")], {}));

  expect(error.retryable).toBe(true);
  expect(error.status).toBe(429);
  expect(error.message).not.toContain(TEST_KEY_VALUE);
});

it("500 → retryable=true", async () => {
  const ep = await endpoint((_captured, res) => json(res, 500, { error: "boom" }));
  const client = createHttpModelClient(config("chat-completions", ep.baseUrl));

  const error = await expectTransportError(client.send([user("hi")], {}));

  expect(error.retryable).toBe(true);
  expect(error.status).toBe(500);
});

it("400 → retryable=false、status=400", async () => {
  const ep = await endpoint((_captured, res) => json(res, 400, { error: "bad endpoint" }));
  const client = createHttpModelClient(config("chat-completions", ep.baseUrl));

  const error = await expectTransportError(client.send([user("hi")], {}));

  expect(error.retryable).toBe(false);
  expect(error.status).toBe(400);
});

it("超时(假端点 hang)→ retryable=true、无 status", async () => {
  const ep = await endpoint(() => {
    // 永不回应:让注入的极短超时触发。
  });
  const client = createHttpModelClient(config("chat-completions", ep.baseUrl), { timeoutMs: 40 });

  const error = await expectTransportError(client.send([user("hi")], {}));

  expect(error.retryable).toBe(true);
  expect(error.status).toBeUndefined();
});

it("包入口导出的 createHttpModelClient 即真实 HTTP 客户端:确实发出请求", async () => {
  const ep = await endpoint((_captured, res) =>
    json(res, 200, { choices: [{ message: { content: "via factory" }, finish_reason: "stop" }] }),
  );
  const client = createExportedModelClient(config("chat-completions", ep.baseUrl));

  const response = await client.send([user("hi")], {});

  expect(response.text).toBe("via factory");
  expect(ep.requests[0]?.path).toBe("/chat/completions");
});

it.each(["chat-completions", "messages", "responses"] as const)(
  "规范政策实际请求形状、完整上下文和停止状态：%s",
  async (family) => {
    const ep = await endpoint((_captured, res) =>
      json(
        res,
        200,
        family === "chat-completions"
          ? { choices: [{ message: { content: "script" }, finish_reason: "stop" }] }
          : family === "messages"
            ? { content: [{ type: "text", text: "script" }], stop_reason: "end_turn" }
            : {
                output: [{ type: "message", content: [{ type: "output_text", text: "script" }] }],
                status: "completed",
              },
      ),
    );
    const model = { ...config(family, ep.baseUrl), generationPolicy: policyFixture(family) };
    const messages: ChatMessage[] = [
      { role: "system", content: "complete system instruction" },
      user("complete rules / API / template"),
      { role: "assistant", content: "previous candidate" },
      user("complete diagnostic feedback"),
    ];
    const response = await createHttpModelClient(model).send(messages, generationParams(model));
    expect(ep.requests).toHaveLength(1);
    const captured = ep.requests[0];
    expect(captured?.body).toEqual({
      model: model.modelId,
      ...(family === "chat-completions"
        ? {
            reasoning_effort: "high",
            max_completion_tokens: 8192,
            messages,
            stream: true,
            stream_options: { include_usage: true },
          }
        : family === "messages"
          ? {
              thinking: { type: "adaptive" },
              output_config: { effort: "high" },
              max_tokens: 8192,
              system: messages[0]?.content,
              messages: messages.slice(1),
              stream: true,
            }
          : { reasoning: { effort: "high" }, max_output_tokens: 8192, input: messages }),
    });
    expect(captured?.authorization).toBe(
      family === "messages" ? undefined : `Bearer ${TEST_KEY_VALUE}`,
    );
    expect(captured?.apiKey).toBe(family === "messages" ? TEST_KEY_VALUE : undefined);
    expect(captured?.anthropicVersion).toBe(family === "messages" ? "2023-06-01" : undefined);
    expect(response).toEqual({
      text: "script",
      finishReason: "stop",
      usage: undefined,
      stopDetails:
        family === "responses"
          ? { status: "completed" }
          : { reason: family === "messages" ? "end_turn" : "stop" },
    });
  },
);

it.each(["bearer", "api-key", "both"] as const)(
  "Messages 代理按渠道头契约发送：%s",
  async (authentication) => {
    const ep = await endpoint((_captured, res) => json(res, 200, { stop_reason: "end_turn" }));
    const model = {
      ...config("messages", ep.baseUrl),
      generationPolicy: { ...policyFixture("messages"), transport: { authentication } },
    };
    await createHttpModelClient(model).send([user("hi")], generationParams(model));
    expect(ep.requests[0]?.authorization).toBe(
      authentication === "api-key" ? undefined : `Bearer ${TEST_KEY_VALUE}`,
    );
    expect(ep.requests[0]?.apiKey).toBe(authentication === "bearer" ? undefined : TEST_KEY_VALUE);
    expect(ep.requests[0]?.anthropicVersion).toBeUndefined();
  },
);

it("官方 Messages 默认 api-key 与版本头，离线拦截且不访问官方端点", async () => {
  const fetchStub = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify({ stop_reason: "end_turn" }), {
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchStub);
  const model = {
    ...config("messages", "https://api.anthropic.com/v1"),
    generationPolicy: {
      ...policyFixture("messages"),
      transport: { authentication: "bearer" as const },
    },
  };
  await createHttpModelClient(model).send([user("hi")], generationParams(model));
  expect(fetchStub).toHaveBeenCalledTimes(1);
  const [url, options] = fetchStub.mock.calls[0] ?? [];
  expect(url).toBe("https://api.anthropic.com/v1/messages");
  expect(options?.headers).toMatchObject({
    "x-api-key": TEST_KEY_VALUE,
    "anthropic-version": "2023-06-01",
  });
  expect(options?.headers).not.toHaveProperty("authorization");
  expect(generationRequestEvidence(model)?.transport).toEqual({
    authentication: "api-key",
    anthropicVersion: "2023-06-01",
  });
});

it("规范客户端先诊断非法参数或能力组合，不读取凭证、不探测渠道", async () => {
  const fetchStub = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchStub);
  const model = {
    ...config("responses", "https://fixture.invalid/v1"),
    credentialEnvVar: "UNREAD_KEY",
    generationPolicy: policyFixture("responses"),
  };
  expect(() =>
    createHttpModelClient({
      ...model,
      generationPolicy: {
        ...model.generationPolicy,
        reasoning: { ...model.generationPolicy.reasoning, control: "chat-effort" },
      },
    }),
  ).toThrow("不兼容");
  const client = createHttpModelClient(model);
  await expect(
    client.send([user("hi")], { ...generationParams(model), temperature: 0 }),
  ).rejects.toThrow("请求参数与规范政策不一致");
  expect(fetchStub).not.toHaveBeenCalled();
});
