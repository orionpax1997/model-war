/**
 * 真实 HTTP 客户端的契约测试:**本地假端点**(`node:http` 监听 `127.0.0.1:0`),不触真网、不需真凭证。
 *
 * 断言的外部可观察行为:发出去的请求(方法 / 路径 / 鉴权头 / body 形状)与读回来的统一形状
 * (`text` / `finishReason` / `usage`),以及失败分类。凭证用假 key 注入 `process.env`,
 * 并顺带钉住"错误消息绝不包含 key"。
 */

import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createModelClient } from "../client-factory.js";
import type { ModelConfig } from "../config.js";
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
  await Promise.all(endpoints.splice(0).map((created) => created.close()));
});

it("chat-completions:POST /chat/completions + Bearer 鉴权 + body 形状", async () => {
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
  expect(request?.body).toEqual({
    model: "vendor/model-x",
    messages: [{ role: "user", content: "hi" }],
    temperature: 0.3,
  });
  expect(response).toEqual({ text: "脚本正文", finishReason: "stop", usage: { total_tokens: 5 } });
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
  expect(request?.body).toEqual({
    model: "vendor/model-x",
    max_tokens: 4000,
    temperature: 0.5,
    system: "你是脚本作者",
    messages: [
      { role: "user", content: "契约" },
      { role: "assistant", content: "上一轮回复" },
    ],
  });
  expect(response).toEqual({ text: "abcd", finishReason: "length", usage: { output_tokens: 7 } });
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
  expect(request?.body).toEqual({
    model: "vendor/model-x",
    input: [
      { role: "system", content: "s" },
      { role: "user", content: "u" },
    ],
  });
  expect(response).toEqual({
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

it("createModelClient 委托到真实 HTTP 客户端:确实发出请求", async () => {
  const ep = await endpoint((_captured, res) =>
    json(res, 200, { choices: [{ message: { content: "via factory" }, finish_reason: "stop" }] }),
  );
  const client = createModelClient(config("chat-completions", ep.baseUrl));

  const response = await client.send([user("hi")], {});

  expect(response.text).toBe("via factory");
  expect(ep.requests[0]?.path).toBe("/chat/completions");
});
