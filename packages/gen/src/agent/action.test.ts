/**
 * 动作块解析的单测:拒绝形状、与「整块一次 `bash -c`」的边界。
 *
 * 断言的都是**回给模型的字面结论**(命令原文 / 纠正消息说了什么),不是内部步骤:解析器的
 * 全部作用就是把一段文本变成这两种结论之一,中间过程没有第二个观察点。
 */

import { expect, it } from "vitest";
import { ACTION_REJECT_EXIT_CODE, fencedBlocks, isEvaluateAction, parseAction } from "./action.js";

it("恰好一个 bash 块:整块原文交出去,多行也算一块", () => {
  const parsed = parseAction(
    "先看一眼契约。\n\n```bash\nls /contract\ncat /contract/README.md\n```\n",
  );
  expect(parsed).toEqual({
    kind: "ok",
    command: "ls /contract\ncat /contract/README.md",
  });
});

it("零个块:不执行、只回纠正消息,并说清「恰好一个 bash 块」", () => {
  const parsed = parseAction("我想先想想。");
  expect(parsed.kind).toBe("reject");
  if (parsed.kind !== "reject") return;
  expect(parsed.reason).toBe("no-block");
  expect(parsed.correction).toContain("没有 ```bash 代码块");
  expect(parsed.correction).toContain("**恰好一个** `bash` 代码块");
  expect(parsed.correction).toContain("计入步数");
});

it("纠正消息带逐字正例与逐字反例,并标出这一次踩到的是哪一种", () => {
  const parsed = parseAction("我想先想想。");
  if (parsed.kind !== "reject") throw new Error("期望被拒");
  // 正例是逐字的、最小可执行的:模型抄一行就能过。
  expect(parsed.correction).toContain("```bash\nls /workspace\n```");
  // 每条反例逐字在场——这是「拒过什么」的可读证据,不只是「格式不对」。
  expect(parsed.correction).toContain("<function=bash>");
  expect(parsed.correction).toContain("<parameter=command>ls /workspace</parameter=command>");
  expect(parsed.correction).toContain("```ts");
  expect(parsed.correction).toContain("const x = 1;");
  // 被点名的是零块那条,其余几条不带标记。
  expect(parsed.correction).toContain("那个块本身不存在」。 ◀");
  expect(parsed.correction.match(/^- .*◀$/gmu)).toHaveLength(1);
  // 句子里的条数由数组长度生成:数一数消息真列了几条,那句话必须说同一个数。
  // 写死一个数字时,加第五种会让这句话变成谎话,而没有任何断言会红——这一条就是那条断言。
  const listed = (parsed.correction.match(/^- /gmu) ?? []).length;
  expect(parsed.correction).toContain(`${String(listed)} 种都会被拒`);
});

it("XML 工具调用单独一档:被拒的是 `<function=bash>` 那一处,不是泛泛的「格式不对」", () => {
  // deepseek-v4.1-flash / mimo-v2.6-flash 在 2026-11-19 两次都是这个形状,三次都不改。
  const parsed = parseAction(
    [
      "跑一下。",
      "<tool_call>",
      "<function=bash>",
      "<parameter=command>ls /workspace</parameter=command>",
      "</function>",
      "</tool_call>",
    ].join("\n"),
  );
  expect(parsed.kind).toBe("reject");
  if (parsed.kind !== "reject") return;
  expect(parsed.reason).toBe("xml-tool-call");
  expect(parsed.correction).toContain("XML 工具调用形状");
  expect(parsed.correction).toContain("被拒的是 `<function=bash>` 这一处");
  // 它不收：拒绝就一条命令都不执行，没有第二条语法。
  expect(parsed.correction).toContain("没有任何命令被执行");
});

it("多个块:一个都不执行,纠正消息点名「有几个块」", () => {
  const parsed = parseAction("```bash\nls\n```\n\n```bash\ncat a\n```\n");
  expect(parsed.kind).toBe("reject");
  if (parsed.kind !== "reject") return;
  expect(parsed.reason).toBe("multiple-blocks");
  expect(parsed.correction).toContain("有 2 个代码块");
  // 纠正消息要给出「怎么一次跑完」的处方,否则模型下一步只能再猜一次。
  expect(parsed.correction).toContain("写进同一个块");
});

it("非 bash 标记(解释用的 ts 块):不执行,纠正消息点名标记是什么", () => {
  const parsed = parseAction("```ts\nconst x = 1;\n```\n");
  expect(parsed.kind).toBe("reject");
  if (parsed.kind !== "reject") return;
  expect(parsed.reason).toBe("non-bash");
  expect(parsed.correction).toContain("它的标记是 ```ts,不是 ```bash");
});

it("块内的 done 原样留在命令里,解析层不切块也不报行号", () => {
  // 收工是薄壳上报给宿主的一个请求;本层既不认行也不切块——整块原样交出去。本层曾经另报
  // 一份「行号」,而那份行号一路传到执行器却从没被读过——同一件事的两份判据,删掉的是多余的那一份。
  const parsed = parseAction("```bash\nevaluate\ndone\necho 之后的行照跑\n```\n");
  expect(parsed).toEqual({ kind: "ok", command: "evaluate\ndone\necho 之后的行照跑" });
});

it("围栏必须独占一行:行内反引号不算动作块", () => {
  expect(fencedBlocks("这是行内的 ```bash 标记,不是块")).toEqual([]);
  // 关围栏只认光杆:块内的 ```ts 是正文。
  expect(fencedBlocks("```bash\necho ```ts\n```")).toEqual([{ tag: "bash", body: "echo ```ts" }]);
});

it("没写收尾围栏的块跑到文本结尾:意图是清楚的,不为一个缺行浪费一步", () => {
  expect(parseAction("```bash\nls\n")?.kind).toBe("ok");
  expect(parseAction("```bash\nls\n")).toEqual({ kind: "ok", command: "ls\n" });
});

it("块为空也算一个块:交给 shell 去空转,不在解析层猜意图", () => {
  expect(parseAction("```bash\n```")).toEqual({ kind: "ok", command: "" });
});

it("`evaluate` 动作只认整块:拼了别的东西就是 bash", () => {
  expect(isEvaluateAction("\nevaluate\n")).toBe(true);
  expect(isEvaluateAction("evaluate && done")).toBe(false);
  expect(isEvaluateAction("evaluate; echo hi")).toBe(false);
});

it("「没有动作可执行」的退出码与薄壳的 2 分得开", () => {
  // 薄壳(票 04)用 2 说「工具不可用」;解析被拒是「你没写出可执行的动作」,借 EX_USAGE。
  expect(ACTION_REJECT_EXIT_CODE).toBe(64);
});

it("写坏的 XML 工具调用(带 id、闭合标签对不上)仍归 xml-tool-call 一档", () => {
  // `archive/hy4-flash/failed-2026-11-19T05-24-41-903Z` 第 3 步的原文形状:
  // 标签名后面跟 `:id`,中间夹 `</content></invoke>`。它是同一个不服从的写法,不是「只说了话」。
  const raw =
    "<tool_calls:6124c78e><tool_call:6124c78e>bash>\nfinish\n</bash>\n</content></invoke>";
  const parsed = parseAction(raw);
  expect(parsed.kind).toBe("reject");
  if (parsed.kind !== "reject") return;
  expect(parsed.reason).toBe("xml-tool-call");
});
