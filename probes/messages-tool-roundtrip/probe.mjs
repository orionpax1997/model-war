/**
 * `messages` 族(Anthropic 形状)的工具调用往返探针。
 *
 * 判的是三件事,每件一次真请求:
 *   ① 不带 `tools`:端点接受这个席位(基线,排除「整套端点被拒」);
 *   ② 带 `tools`:返回 `stop_reason: "tool_use"` 且 `content` 里有 `tool_use` 块
 *      ——「声明形状会不会 400」有了答案;
 *   ③ 把 assistant 的 `content` 原样回显、再发一条 `role: "user"` 的 `tool_result` 块
 *      ——「`tool_result` 能否配对」有了答案。
 *
 * 它**不判**翻译正确性:那是 `packages/gen/src/http/endpoints.ts` 的事,这里只给协议事实。
 *
 * 用法(凭证从仓库根的 `.env` 读,不落进脚本):
 *   node probes/messages-tool-roundtrip/probe.mjs
 *   node probes/messages-tool-roundtrip/probe.mjs --json /tmp/messages-tool-roundtrip.json
 *
 * 退出码:0 = 三步都到了预期形状;1 = 有一步没到(会把原始响应体打出来)。
 */

import { readFileSync, writeFileSync } from "node:fs";

const BASE = "https://api.commandcode.ai/provider/v1";
const MODEL = "claude-haiku-5-5";

const envFrom = (path) =>
  Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^["']|["']$/g, "")];
      }),
  );

const env = envFrom(new URL("../../.env", import.meta.url));
const key = env.COMMAND_CODE_API_KEY;
if (!key) {
  console.error("缺 COMMAND_CODE_API_KEY:从仓库根的 .env 读,脚本里不留凭证。");
  process.exit(1);
}

const tool = {
  name: "bash",
  description: "在沙箱里执行一条命令串。",
  input_schema: {
    type: "object",
    properties: { command: { type: "string", description: "一条 bash 命令串" } },
    required: ["command"],
    additionalProperties: false,
  },
};

const post = async (body) => {
  const startedAt = Date.now();
  const response = await fetch(`${BASE}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, ms: Date.now() - startedAt, text, json };
};

const findings = [];
const record = (label, result, summary) => {
  findings.push({ label, status: result.status, ms: result.ms, summary, raw: result.text });
  console.log(`\n── ${label} → HTTP ${result.status} (${result.ms} ms)`);
  console.log(JSON.stringify(summary, null, 2));
  if (result.status !== 200) console.log(result.text);
};

// ── ① 不带 tools ──────────────────────────────────────────────────────────────
const plain = await post({
  model: MODEL,
  max_tokens: 64,
  messages: [{ role: "user", content: "say hi" }],
});
record("① 不带 tools", plain, {
  stop_reason: plain.json?.stop_reason,
  blocks: (plain.json?.content ?? []).map((block) => block.type),
});

// ── ② 带 tools ────────────────────────────────────────────────────────────────
const withTools = await post({
  model: MODEL,
  max_tokens: 256,
  messages: [{ role: "user", content: "List the files in / using bash." }],
  tools: [tool],
});
const toolUse = (withTools.json?.content ?? []).find((block) => block.type === "tool_use");
record("② 带 tools", withTools, {
  stop_reason: withTools.json?.stop_reason,
  blocks: (withTools.json?.content ?? []).map((block) => block.type),
  tool_use: toolUse && {
    id: toolUse.id,
    name: toolUse.name,
    // `input` 是对象,不是 JSON 字符串——这是本族与 chat 族最实质的差别。
    inputType: typeof toolUse.input,
    input: toolUse.input,
  },
});

// ── ③ 回传 tool_result ────────────────────────────────────────────────────────
let roundTrip;
if (toolUse) {
  roundTrip = await post({
    model: MODEL,
    max_tokens: 256,
    messages: [
      { role: "user", content: "List the files in / using bash." },
      // assistant 的 content 原样回显(含 tool_use 块),这是 Anthropic 要求的形状。
      { role: "assistant", content: withTools.json.content },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUse.id, content: "bin\netc\nhome" }],
      },
    ],
    tools: [tool],
  });
  record("③ 回传 tool_result", roundTrip, {
    stop_reason: roundTrip.json?.stop_reason,
    blocks: (roundTrip.json?.content ?? []).map((block) => block.type),
  });
} else {
  record("③ 回传 tool_result", { status: 0, ms: 0, text: "跳过:①没有给出 tool_use" }, {
    skipped: "no tool_use to send back",
  });
}

const jsonPathAt = process.argv.indexOf("--json");
if (jsonPathAt !== -1 && process.argv[jsonPathAt + 1]) {
  writeFileSync(process.argv[jsonPathAt + 1], `${JSON.stringify(findings, null, 2)}\n`);
  console.log(`\n原始响应已写入 ${process.argv[jsonPathAt + 1]}`);
}

const ok =
  plain.status === 200 &&
  withTools.status === 200 &&
  withTools.json?.stop_reason === "tool_use" &&
  toolUse !== undefined &&
  roundTrip?.status === 200;
console.log(
  ok
    ? "\n✓ 三步都到了预期形状:端点接受 tools,返回 tool_use,接受 tool_result 配对。"
    : "\n✗ 有一步没到预期形状,见上面的原始响应体。",
);
process.exit(ok ? 0 : 1);
