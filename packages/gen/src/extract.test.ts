/**
 * 模型裸文本 → 编译用源码的剥包装函数(`extract.ts`)的对外可观察行为。
 *
 * 断言对象只有纯函数的输入输出字符串,不碰管线与子进程。回归形状来自本案 4 份 opus 原文
 * (`.scratch/opus-probe/run2-r{1,2,3,4}-assistant.txt`,r1–r3 纯围栏包裹、r4 中文引导语 +
 * 围栏;文件 8–10KB,不进本仓库,此处以内联的同形小夹具覆盖,全量原文另由一次性脚本逐字节核对):
 * 围栏行(首行 ```` ```typescript ````、尾行 ```` ``` ````)必须剥掉,内部代码行逐字节保留。
 */

import { expect, it } from "vitest";

import { extractScriptSource } from "./extract.js";

/** r1/r2 形:纯围栏包裹,闭围栏后无尾换行(与原文尾字节一致);剥后保留末行换行(围栏间原字节)。 */
const FENCED = "```typescript\nvar myIndex = -1;\nfunction loop() {\n  return 1;\n}\n```";
/** r4 形:中文引导语 + 空行 + 围栏包裹。 */
const PROSE_FENCED =
  "我看到问题了,下面是修复后的脚本:\n\n```typescript\nvar myIndex = -1;\nfunction loop() {\n  return 1;\n}\n```";
/** 围栏内代码本体(上两例剥离后的期望值,内部行原样,不 trim,末行换行保留)。 */
const INNER = "var myIndex = -1;\nfunction loop() {\n  return 1;\n}\n";

it("无围栏的干净输出逐字节不变(三种起手形:var / 注释 / type)", () => {
  const samples = [
    "var targetSiteId = -1;\nfunction loop(): void {\n  const me = getMyIndex();\n}",
    "// script.ts — 扩张运营:先经济后军事。\nvar x = 1;\nfunction loop() {\n  return x;\n}",
    "type ULike = { id: number; owner: number };\nfunction loop() {\n  return 1;\n}",
    "",
    "   \n  ",
  ];
  for (const sample of samples) {
    expect(extractScriptSource(sample)).toBe(sample);
  }
});

it("纯围栏包裹:去掉首尾围栏行,内部逐字节保留", () => {
  expect(extractScriptSource(FENCED)).toBe(INNER);
});

it("引导语 + 围栏:引导语与围栏同去,只留围栏内", () => {
  expect(extractScriptSource(PROSE_FENCED)).toBe(INNER);
});

it("围栏后还有尾随引导语:尾随部分同去", () => {
  const trailed = `${FENCED}\n希望对你有帮助!`;
  expect(extractScriptSource(trailed)).toBe(INNER);
});

it("只有开围栏无闭围栏:去掉开围栏行之后全取", () => {
  const unclosed = "```typescript\nvar myIndex = -1;\nfunction loop() {\n  return 1;\n}";
  expect(extractScriptSource(unclosed)).toBe(
    "var myIndex = -1;\nfunction loop() {\n  return 1;\n}",
  );
});

it("只有闭围栏(尾行单个围栏):去掉它,之前全留", () => {
  const closeOnly = "var myIndex = -1;\nfunction loop() {\n  return 1;\n}\n```";
  expect(extractScriptSource(closeOnly)).toBe(
    "var myIndex = -1;\nfunction loop() {\n  return 1;\n}",
  );
});

it("围栏语言标签变体(```ts / 无标签 / 大小写)都剥", () => {
  for (const open of ["```ts", "```", "```TypeScript"]) {
    expect(extractScriptSource(`${open}\nvar x = 1;\n\`\`\``)).toBe("var x = 1;\n");
  }
});

it("内部代码行不做任何改动(前导空格、空行原样保留)", () => {
  const inner = "var a = 1;\n\n  function loop() {\n    return a;\n  }";
  expect(extractScriptSource(`\`\`\`typescript\n${inner}\n\`\`\``)).toBe(`${inner}\n`);
});

it("空围栏(首尾相邻)给空串,不抛异常", () => {
  expect(extractScriptSource("```typescript\n```")).toBe("");
});
