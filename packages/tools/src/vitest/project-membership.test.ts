import { describe, expect, it } from "vitest";
import { parseListedFiles, resolveProject, type ListedFile } from "./project-membership.ts";

/**
 * 判据的反例:归属是**算**出来的,所以配置搬家只是换一份输入,不是换一段代码。
 *
 * 用例里的列表都取自 `vitest list --filesOnly --json` 的真实形状(绝对路径 + projectName,
 * 同一个文件在多个池里出现则多条),不是脑补的数据结构。
 */
const REPO = "/repo";
const PROBE = "packages/engine/src/runner/probe-harness.test.ts";

const GATES = "packages/tools/src/gates.test.ts";
const SLOW_GATES = "packages/tools/src/gates-slow.test.ts";
const CLI = "apps/cli/src/cli.test.ts";

const entry = (projectName: string, path: string): ListedFile => ({
  file: `${REPO}/${path}`,
  projectName,
});

/** 收口用的全集池(`all`)+ 几个窄池,与真实配置同形(全集比任何窄池都宽)。 */
const listed: readonly ListedFile[] = [
  entry("all", PROBE),
  entry("vm", PROBE),
  entry("all", GATES),
  entry("unit", GATES),
  entry("all", SLOW_GATES),
  entry("slow", SLOW_GATES),
  entry("all", CLI),
  entry("e2e", CLI),
];

describe("归属:取最窄的那个池", () => {
  it("`all` 与 `vm` 都收时算到 `vm`(全集池只是收口副本)", () => {
    expect(resolveProject(listed, PROBE)).toEqual({
      kind: "resolved",
      project: "vm",
      candidates: ["vm", "all"],
    });
  });

  it("搬回 `unit` 时算到 `unit`:同一条规则覆盖 a8c1de3 前后的两种配置", () => {
    const before: readonly ListedFile[] = [
      entry("all", PROBE),
      entry("unit", PROBE),
      entry("all", GATES),
      entry("all", CLI),
      entry("all", SLOW_GATES),
    ];
    expect(resolveProject(before, PROBE)).toMatchObject({ project: "unit" });
  });

  it("搬进昂贵池也算得出来(不为「常见池」写特例)", () => {
    const moved: readonly ListedFile[] = [
      entry("all", PROBE),
      entry("slow", PROBE),
      entry("slow", SLOW_GATES),
      entry("all", GATES),
      entry("all", CLI),
    ];
    expect(resolveProject(moved, PROBE)).toMatchObject({ project: "slow" });
  });

  it("并列时按名字兜底:同一份配置每次都算出同一个答案", () => {
    const tie: readonly ListedFile[] = [entry("b", PROBE), entry("a", PROBE)];
    expect(resolveProject(tie, PROBE)).toMatchObject({ project: "a" });
    expect(resolveProject([...tie].reverse(), PROBE)).toMatchObject({
      project: "a",
    });
  });

  it("没有 project 收它 → 说「没人收」,不挑默认值硬跑", () => {
    const resolution = resolveProject(listed, "packages/engine/src/runner/nope.test.ts");
    expect(resolution.kind).toBe("unlisted");
    expect(resolution.kind === "unlisted" ? resolution.reason : "").toContain(
      "没有任何 project 收",
    );
  });
});

describe("解析:形状不对要抛错,不能当空数组", () => {
  it("读得进真实形状,允许前后有噪音行", () => {
    const output = `some plugin log line\n${JSON.stringify(listed)}\n`;
    expect(parseListedFiles(output)).toHaveLength(listed.length);
  });

  it("没有 JSON 数组 → 抛错(空数组会被误读成「没人收」)", () => {
    expect(() => parseListedFiles("no json here")).toThrow(/没有 JSON 数组/u);
  });

  it("形状不对 → 抛错", () => {
    expect(() => parseListedFiles('[{"file":"/repo/a.test.ts"}]')).toThrow(/形状不是/u);
  });
});
