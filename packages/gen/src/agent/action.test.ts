/**
 * 动作块解析的单测:三种拒绝、`done` 哨兵的暴露、以及「整块一次 `bash -c`」的边界。
 *
 * 断言的都是**回给模型的字面结论**(命令原文 / 纠正消息说了什么),不是内部步骤:解析器的
 * 全部作用就是把一段文本变成这两种结论之一,中间过程没有第二个观察点。
 */

import { expect, it } from "vitest";
import {
  ACTION_REJECT_EXIT_CODE,
  doneSentinelLine,
  fencedBlocks,
  isEvaluateAction,
  parseAction,
} from "./action.js";

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

it("块内独占一行的 done 只暴露行号,不在这里切分", () => {
  const parsed = parseAction("```bash\nevaluate\ndone\necho 不该跑到\n```\n");
  expect(parsed).toEqual({
    kind: "ok",
    command: "evaluate\ndone\necho 不该跑到",
    doneAtLine: 1,
  });
});

it("`done` 必须是独占一行:句子里出现、或带别的参数都不算哨兵", () => {
  expect(doneSentinelLine("echo done")).toBeUndefined();
  expect(doneSentinelLine("done | cat")).toBeUndefined();
  expect(doneSentinelLine("\n  done  \n")).toBe(1);
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
