/**
 * 通道协议体:一行 JSON 的**字节形态**是不是那份。
 *
 * 为什么这些断言值得写:消费者是沙箱里的 `bash`(它按分隔串切字段,没有 JSON 解析器),所以
 * 「键序固定」「字符串里不出现裸引号」「响应只有一行」不是风格,是**协议**。这里钉住的是
 * 序列化与解析的往返,以及每一条「薄壳靠它切字段」的前提。
 *
 * 真 `bash` 那一侧的往返在 `packages/gen/src/agent/shim/shim.test.ts`(它直接吃本模块的
 * 序列化输出);两处合起来才是「协议两侧对得上」。
 */

import { describe, expect, it } from "vitest";

import {
  TOOL_NAMES,
  escapePayload,
  parseToolRequest,
  parseToolResponse,
  serializeToolRequest,
  serializeToolResponse,
  type ToolResponse,
} from "./tool-channel.js";

const roundTrip = (response: ToolResponse): ToolResponse => {
  const parsed = parseToolResponse(serializeToolResponse(response));
  if (!parsed.ok) throw new Error(`响应解析失败:${parsed.reason}`);
  return parsed.response;
};

describe("响应的字节形态", () => {
  it("两路输出逐字节往返(多行、引号、反斜杠、制表、中文)", () => {
    const response: ToolResponse = {
      exitCode: 3,
      stdout: 'line1\nline2 "quoted" \\backslash\\ and a literal \\n\n\ttabbed 中文 ✓\n',
      stderr: "err tail\n",
      result: { kind: "tsc", errorCodes: ["TS1005", "TS2322"] },
    };
    expect(roundTrip(response)).toEqual(response);
  });

  it('响应恒为一行,且以 `"}` 收尾(`stderr` 是最后一个字段,薄壳按它切尾巴)', () => {
    const line = serializeToolResponse({ exitCode: 0, stdout: "a\nb", stderr: "c\nd" });
    expect(line.includes("\n")).toBe(false);
    expect(line.endsWith('"}')).toBe(true);
  });

  it("键序固定:`exitCode` → `result` → `stdout` → `stderr`", () => {
    const line = serializeToolResponse({
      exitCode: 0,
      stdout: "out",
      stderr: "err",
      result: { kind: "contract", errorCodes: ["禁列全局名"] },
    });
    expect(
      line.indexOf('"exitCode"') < line.indexOf('"result"') &&
        line.indexOf('"result"') < line.indexOf('"stdout"') &&
        line.indexOf('"stdout"') < line.indexOf('"stderr"'),
    ).toBe(true);
    // 没有结果时写 `null` 而不是省键:字段数不摇摆,薄壳那条切法才只有一种。
    expect(serializeToolResponse({ exitCode: 0, stdout: "", stderr: "" })).toContain(
      '"result":null',
    );
  });

  it('字符串里的引号一律转义:分隔串 `,"stdout":"` 不可能出现在内容里', () => {
    const line = serializeToolResponse({
      exitCode: 0,
      stdout: '","stdout":"',
      stderr: "",
    });
    // 内容里那一段被转义成 `\",\"stdout\":\"`,于是「第一次出现」只可能是真的字段边界。
    expect(line.split(',"stdout":"').length).toBe(2);
    expect(roundTrip({ exitCode: 0, stdout: '","stdout":"', stderr: "" }).stdout).toBe(
      '","stdout":"',
    );
  });

  it("其余控制字节写成 `\\u00XX` 的字面拼法,不破坏「一行」", () => {
    const line = serializeToolResponse({ exitCode: 0, stdout: "a\u001bb\u0000c", stderr: "" });
    expect(line).toContain("\\u001b");
    expect(line).toContain("\\u0000");
    expect(line.includes("\u001b")).toBe(false);
  });

  it("寄生字节改不了退出码:`exitCode` 是数字而不是从字符串里读出来的", () => {
    const response = roundTrip({ exitCode: 7, stdout: '",\n"exitCode":0', stderr: "" });
    expect(response.exitCode).toBe(7);
  });
});

describe("escapePayload", () => {
  it("只转义那七个与非文本控制字节,中文与普通标点原样", () => {
    expect(escapePayload('a"b\\c\nd\te\rf\fg\bh')).toBe('a\\"b\\\\c\\nd\\te\\rf\\fg\\bh');
    expect(escapePayload("中文、标点:✓")).toBe("中文、标点:✓");
  });
});

describe("请求的形状", () => {
  it("参数字段可以缺席(薄壳永远写它,手写的请求不必)", () => {
    expect(parseToolRequest('{"tool":"check"}')).toEqual({
      ok: true,
      request: { tool: "check", args: [] },
    });
    expect(parseToolRequest('{"tool":"evaluate","args":["--x"]}')).toEqual({
      ok: true,
      request: { tool: "evaluate", args: ["--x"] },
    });
  });

  it("多出来的键一律忽略、永不解释(「额度」不能从请求侧生效)", () => {
    const parsed = parseToolRequest('{"tool":"evaluate","args":[],"remaining":99,"quota":99}');
    expect(parsed).toEqual({ ok: true, request: { tool: "evaluate", args: [] } });
  });

  it("不是一条工具请求的字节被拒,理由可读", () => {
    for (const line of ["", "   ", "not json", "[]", "null", '{"args":[]}', '{"tool":""}']) {
      const parsed = parseToolRequest(line);
      expect(parsed.ok).toBe(false);
      expect(parsed.ok ? "" : parsed.reason.length > 0).toBe(true);
    }
    expect(parseToolRequest('{"tool":"check","args":[1]}').ok).toBe(false);
  });

  it("一份请求走 `serializeToolRequest` 能原样读回", () => {
    const line = serializeToolRequest({ tool: "check", args: ['a"b', "c\\d"] });
    expect(line.includes("\n")).toBe(false);
    expect(parseToolRequest(line)).toEqual({
      ok: true,
      request: { tool: "check", args: ['a"b', "c\\d"] },
    });
  });
});

describe("响应解析", () => {
  it("`result.kind` 只认 tsc / contract", () => {
    expect(
      parseToolResponse(
        '{"exitCode":0,"result":{"kind":"smoke","errorCodes":[]},"stdout":"","stderr":""}',
      ).ok,
    ).toBe(false);
  });

  it("缺 `exitCode` 或两路输出不是字符串时拒", () => {
    expect(parseToolResponse('{"stdout":"","stderr":""}').ok).toBe(false);
    expect(parseToolResponse('{"exitCode":0,"stdout":1,"stderr":""}').ok).toBe(false);
    expect(parseToolResponse('{"exitCode":1.5,"stdout":"","stderr":""}').ok).toBe(false);
  });
});

describe("工具名取值域", () => {
  it("三个受限工具,`done` 也在里面(它被写进管道时仍是一条合法请求)", () => {
    expect([...TOOL_NAMES]).toEqual(["check", "evaluate", "done"]);
  });
});
