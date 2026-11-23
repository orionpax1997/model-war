/**
 * 截断的单测:边界(恰好等于上限 / 超一字节)、两对保留比例、只留头 / 只留尾、多字节安全、
 * 告警里必须有可执行的方向与被省略的字节数,以及原文的病态保护。
 */

import { expect, it } from "vitest";
import {
  OBSERVATION_LIMITS,
  RAW_PATHOLOGICAL_LIMIT_BYTES,
  TRUNCATED_RESPONSE_FEEDBACK,
  clampRaw,
  truncateObservation,
  truncateText,
  type ObservationLimit,
} from "./truncate.js";

const bytesOf = (text: string): number => Buffer.byteLength(text, "utf8");

/** 造一条恰好 `size` 字节、可定位的文本:`a` 重复到 `size-1`,再补一个标记行首字符。 */
const filler = (size: number): string => "a".repeat(size);

const custom = (limitBytes: number, headParts: number, parts: number): ObservationLimit => ({
  limitBytes,
  headParts,
  parts,
});

it("恰好等于上限:一个字节都不动(上限是「允许到这么多」)", () => {
  const text = filler(OBSERVATION_LIMITS.stdout.limitBytes);
  expect(truncateObservation("stdout", text)).toBe(text);
});

it("超一字节:只省略那一个字节,并把数字说出来", () => {
  const limit = OBSERVATION_LIMITS.stdout;
  const text = filler(limit.limitBytes + 1);
  const truncated = truncateObservation("stdout", text);
  expect(truncated).toContain("共 16385 字节");
  expect(truncated).toContain("其余 1 字节被省略");
  // 保留量仍填满上限。
  expect(bytesOf(truncated.split("\n")[0] ?? "")).toBe(
    Math.floor((limit.limitBytes * limit.headParts) / limit.parts),
  );
});

it("stdout 头 30% / 尾 70%,stderr 头 70% / 尾 30%", () => {
  // 20000 字节:开头四个 H、结尾四个 T,中间全是 x。
  const text = `${"H".repeat(4)}${"x".repeat(19_992)}${"T".repeat(4)}`;
  const stdout = truncateObservation("stdout", text);
  const stderr = truncateObservation("stderr", text);
  // 两路的保留量与方向不同,同一个输入因此不会被同一种截法处理。
  expect(stdout).toContain("stdout 共 20000 字节");
  expect(stdout).toContain("保留开头 4915 字节与结尾 11469 字节");
  expect(stderr).toContain("stderr 共 20000 字节");
  expect(stderr).toContain("保留开头 2867 字节与结尾 1229 字节");
  expect(stdout.startsWith("HHHH")).toBe(true);
  expect(stdout.endsWith("TTTT")).toBe(true);
  expect(stderr.endsWith("TTTT")).toBe(true);
});

it("只留尾(头段为零):告警说得清被丢的是开头", () => {
  const truncated = truncateText(filler(100), "stdout", custom(10, 0, 10));
  expect(truncated.endsWith("aaaaaaaaaa")).toBe(true);
  expect(truncated).toContain("保留开头 0 字节与结尾 10 字节");
  expect(truncated).toContain("其余 90 字节被省略");
});

it("只留头(尾段为零):告警说得清被丢的是结尾", () => {
  const truncated = truncateText(filler(100), "stdout", custom(10, 10, 10));
  expect(truncated.startsWith("aaaaaaaaaa")).toBe(true);
  expect(truncated).toContain("保留开头 10 字节与结尾 0 字节");
  expect(truncated).toContain("其余 90 字节被省略");
});

it("切点落在多字节字符中间时退回完整序列:不交出半个汉字", () => {
  // 每个汉字 3 字节;上限 7 字节 → 头 3 字节(正好一个汉字)、尾 4 字节(落在字符中间)。
  const text = "一二三四五六七八九十";
  const truncated = truncateText(text, "stdout", custom(7, 1, 2));
  expect(truncated.startsWith("一")).toBe(true);
  // 尾巴那 4 字节里的续字节被跳过,剩下完整的字。
  expect(truncated).not.toContain("\uFFFD");
  expect(truncated.endsWith("十")).toBe(true);
});

it("告警里必须给可执行的方向与被省略的字节数", () => {
  const truncated = truncateObservation("stdout", filler(20_000));
  for (const hint of ["head -c", "tail -c", "sed -n", "grep -n", "/workspace/out.txt"]) {
    expect(truncated).toContain(hint);
  }
  expect(truncated).toContain("重跑同一条命令不会换出更多字节");
});

it("模型原文不截断:64 KiB 以内逐字节原样", () => {
  const text = "x".repeat(RAW_PATHOLOGICAL_LIMIT_BYTES);
  expect(clampRaw(text)).toBe(text);
});

it("模型原文只有病态保护:超过 64 KiB 才截,并说明已经不等于原文", () => {
  const text = "x".repeat(RAW_PATHOLOGICAL_LIMIT_BYTES + 1);
  const clamped = clampRaw(text);
  expect(clamped).toContain("病态保护上限");
  expect(clamped).toContain("其余 1 字节被省略");
  expect(clamped.startsWith("x".repeat(RAW_PATHOLOGICAL_LIMIT_BYTES))).toBe(true);
});

it("截断是纯函数:同一输入同一上限产出同一份字节", () => {
  const text = filler(50_000);
  expect(truncateObservation("stdout", text)).toBe(truncateObservation("stdout", text));
});

it("截断响应的格式反馈点名「连续两次都截断」并给处方", () => {
  expect(TRUNCATED_RESPONSE_FEEDBACK).toContain("连续两次都截断");
  expect(TRUNCATED_RESPONSE_FEEDBACK).toContain("更简洁");
  expect(TRUNCATED_RESPONSE_FEEDBACK).toContain("计入步数");
});
