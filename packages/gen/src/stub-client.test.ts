import { expect, it } from "vitest";
import { fail, reply, replies, stubClient } from "./stub-client.js";

it("按序回放多段文本", async () => {
  const client = stubClient(replies(["第一段", "第二段"]));
  expect((await client.send([], {})).text).toBe("第一段");
  expect((await client.send([], {})).text).toBe("第二段");
});

it("回放缺省 finishReason = `stop`、usage = `{}`", async () => {
  const client = stubClient([reply("x")]);
  const response = await client.send([], {});
  expect(response.finishReason).toBe("stop");
  expect(response.usage).toEqual({});
});

it("可指定 finishReason(截断)与 usage", async () => {
  const client = stubClient([
    reply("半截", { finishReason: "length", usage: { output_tokens: 9 } }),
  ]);
  const response = await client.send([], {});
  expect(response.finishReason).toBe("length");
  expect(response.usage).toEqual({ output_tokens: 9 });
});

it("传输失败按脚本抛出同一错误对象", async () => {
  const boom = new Error("429 rate limited");
  const client = stubClient([fail(boom)]);
  await expect(client.send([], {})).rejects.toThrow(boom);
});

it("记下每次调用收到的 messages 与 params", async () => {
  const client = stubClient(replies(["ok"]));
  await client.send([{ role: "user", content: "契约全文" }], { temperature: 0.2 });
  expect(client.calls).toHaveLength(1);
  expect(client.calls[0]?.messages).toEqual([{ role: "user", content: "契约全文" }]);
  expect(client.calls[0]?.params).toEqual({ temperature: 0.2 });
});

it("脚本用尽后再调用即报错(不静默回空串)", async () => {
  const client = stubClient(replies(["only"]));
  await client.send([], {});
  await expect(client.send([], {})).rejects.toThrow(/脚本已用尽/);
});
