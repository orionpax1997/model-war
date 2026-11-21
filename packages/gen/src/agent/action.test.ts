/**
 * 动作解析的单测:四个接受路径、四个拒绝路径,以及纠正消息的逐字自洽性。
 *
 * 断言的都是**回给模型的字面结论**(工具名与参数原文 / 纠正消息说了什么),不是内部步骤:
 * 解析器的全部作用就是把一串 `ToolCall` 变成这两种结论之一,中间过程没有第二个观察点。
 */

import { expect, it } from "vitest";

import { ACTION_REJECT_EXIT_CODE, ACTION_REJECT_REASONS, parseAction } from "./action.js";
import type { ToolCall } from "./tools.js";

const call = (name: string, args: unknown): ToolCall => ({
  name,
  argumentsJson: typeof args === "string" ? args : JSON.stringify(args),
});

/** 一条拒绝的解析结果,顺带钉住档名。 */
const rejectOf = (
  parsed: ReturnType<typeof parseAction>,
  reason: (typeof ACTION_REJECT_REASONS)[number],
): Extract<ReturnType<typeof parseAction>, { kind: "reject" }> => {
  if (parsed.kind !== "reject") throw new Error("期望被拒");
  expect(parsed.reason).toBe(reason);
  return parsed;
};

/** 纠正消息里「反例那一栏」的全部列表项(含它们缩进的样本行)。 */
const rejectLines = (correction: string): readonly string[] => {
  const lines = correction.split("\n");
  const start = lines.findIndex((line) => line.startsWith("❌ 反例"));
  return lines.slice(start + 1).filter((line) => line.startsWith("- "));
};

// ── 四个接受路径 ────────────────────────────────────────────────────────────

it("bash:那条命令串原样交出去(含换行),`argumentsJson` 也原样保留", () => {
  const argumentsJson = '{"command":"ls /contract\\ncat /contract/README.md"}';
  const parsed = parseAction([{ name: "bash", argumentsJson }]);
  expect(parsed).toEqual({
    kind: "ok",
    tool: "bash",
    argumentsJson,
    command: "ls /contract\ncat /contract/README.md",
  });
});

it("check / probe / evaluate / finish:不收参数,空对象与空串两种形状都过", () => {
  for (const name of ["check", "probe", "evaluate", "finish"] as const) {
    expect(parseAction([call(name, {})])).toMatchObject({ kind: "ok", tool: name });
    // 空串是常见形状(不少渠道对不收参数的工具给的就是空串),它不是「坏 JSON」。
    expect(parseAction([{ name, argumentsJson: "" }])).toMatchObject({ kind: "ok", tool: name });
    expect(parseAction([{ name, argumentsJson: "  " }])).toMatchObject({ kind: "ok", tool: name });
    // 这四个工具**没有** `command` 这一格:它只对 `bash` 有意义。
    const parsed = parseAction([call(name, {})]);
    expect(parsed.kind === "ok" && "command" in parsed).toBe(false);
  }
});

// ── 四个拒绝路径 ────────────────────────────────────────────────────────────

it("零次调用:只说了话,纠正消息说清「一次都没有」", () => {
  const parsed = rejectOf(parseAction([]), "no-tool-call");
  expect(parsed.correction).toContain("没有发起任何工具调用");
  expect(parsed.correction).toContain("**恰好一次**工具调用");
  expect(parsed.correction).toContain("计入步数");
});

it("多于一次调用:一次都不执行,纠正消息说清发起了几次", () => {
  const parsed = rejectOf(
    parseAction([call("bash", { command: "ls" }), call("bash", { command: "cat a" })]),
    "multiple-tool-calls",
  );
  expect(parsed.correction).toContain("发起了 2 次工具调用");
  // 处方要落在「怎么一次跑完」上,否则模型下一步只能再猜一次。
  expect(parsed.correction).toContain("同一条");
});

it("工具名不认识:点名那个名字,并列出声明的五个", () => {
  const parsed = rejectOf(parseAction([call("shell", { command: "ls" })]), "unknown-tool");
  expect(parsed.correction).toContain("`shell`");
  expect(parsed.correction).toContain("bash / check / probe / evaluate / finish");
});

it("参数坏了:坏 JSON / 形状不符 / 多余键都归同一档,纠正消息带那串字节的开头", () => {
  for (const bad of [
    { name: "bash", argumentsJson: '{"command": }' },
    { name: "bash", argumentsJson: '{"command": ""}' },
    { name: "bash", argumentsJson: '{"command": "ls", "extra": 1}' },
    { name: "bash", argumentsJson: '{"cmd": "ls"}' },
    { name: "bash", argumentsJson: "[]" },
    { name: "check", argumentsJson: '{"command": "ls"}' },
    { name: "evaluate", argumentsJson: "{oops" },
  ] as const) {
    const parsed = rejectOf(parseAction([bad]), "malformed-arguments");
    expect(parsed.correction).toContain("arguments 不能用");
  }
  // 点名被拒的是哪个工具的那一串:不同工具的处方不同(一个要 `{command}`,一个不许带参数)。
  expect(
    rejectOf(parseAction([{ name: "check", argumentsJson: '{"x":1}' }]), "malformed-arguments")
      .correction,
  ).toContain("`check` 时给的 arguments");
  expect(
    rejectOf(parseAction([{ name: "bash", argumentsJson: "{oops" }]), "malformed-arguments")
      .correction,
  ).toContain("{oops");
});

// ── 纠正消息的逐字自洽 ───────────────────────────────────────────────────────

it("纠正消息带逐字正例与逐字反例,并标出这一次踩到的是哪一种", () => {
  const parsed = rejectOf(parseAction([]), "no-tool-call");
  // 正例是逐字的、可直接照抄的:四个工具各一条。
  expect(parsed.correction).toContain(`bash {"command": "ls /workspace"}`);
  expect(parsed.correction).toContain("check {}");
  expect(parsed.correction).toContain("evaluate {}");
  expect(parsed.correction).toContain("finish {}");
  // 每条反例逐字在场——这是「拒过什么」的可读证据,不只是「格式不对」。
  expect(parsed.correction).toContain("我想先把 script.ts 读完");
  expect(parsed.correction).toContain('shell {"command": "ls /workspace"}');
  expect(parsed.correction).toContain('bash {"command": }');
  // 被点名的是零次那条,其余几条不带标记。
  expect(parsed.correction.match(/^- .*◀$/gmu)).toHaveLength(1);
  // 句子里的条数由数组长度生成:数一数消息真列了几条,那句话必须说同一个数。
  // 写死一个数字时,加第五种会让这句话变成谎话,而没有任何断言会红——这一条就是那条断言。
  const listed = rejectLines(parsed.correction).length;
  expect(listed).toBe(ACTION_REJECT_REASONS.length);
  expect(parsed.correction).toContain(`${String(listed)} 种都会被拒`);
});

it("四档各有各的逐字反例:◀ 只会标在这一次踩到的那种上", () => {
  const cases = [
    [parseAction([]), "no-tool-call"],
    [parseAction([call("bash", { command: "ls" }), call("check", {})]), "multiple-tool-calls"],
    [parseAction([call("nope", {})]), "unknown-tool"],
    [parseAction([{ name: "bash", argumentsJson: "{" }]), "malformed-arguments"],
  ] as const;
  for (const [parsed, reason] of cases) {
    const rejectedOne = rejectOf(parsed, reason);
    // 恰好一条被标;标的那一条在反例表里排第 (档名在枚举里的下标 + 1) 位。
    const marked = rejectLines(rejectedOne.correction).filter((line) => line.endsWith("◀"));
    expect(marked).toHaveLength(1);
    expect(rejectLines(rejectedOne.correction).indexOf(marked[0]!)).toBe(
      ACTION_REJECT_REASONS.indexOf(reason),
    );
  }
});

it("「没有动作可执行」的退出码仍是 64", () => {
  expect(ACTION_REJECT_EXIT_CODE).toBe(64);
});
