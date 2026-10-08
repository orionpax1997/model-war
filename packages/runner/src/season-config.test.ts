import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { DEFAULT_RANK_POINTS } from "./ranker.js";
import { loadSeasonConfig } from "./season-config.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const scratch = mkdtempSync(`${tmpdir()}/modelwar-season-`);
afterAll(() => rmSync(scratch, { force: true, recursive: true }));

let seq = 0;
const writeConfig = (text: string): string => {
  seq += 1;
  const path = join(scratch, `season-${String(seq)}.yaml`);
  writeFileSync(path, text, "utf8");
  return path;
};

/** 四条参赛存档的最小合法名册(M = 1、K = 1 的均摊由测试各自显式给出)。 */
const roster = [
  "participants:",
  "  - archive/a/r1",
  "  - archive/b/r1",
  "  - archive/c/r1",
  "  - archive/d/r1",
].join("\n");

it("仓库根的 season.example.yaml 读得通,且与本赛季 5 条参赛集一致", () => {
  const config = loadSeasonConfig(join(repoRoot, "season.example.yaml"));
  expect(config).toMatchObject({
    masterSeed: "2026-m4",
    ruleset: "v1",
    seeds: 4,
    concurrency: 8,
    rankPoints: [3, 2, 1, 0],
    maps: ["corridor-split", "fortress-core", "open-clash"],
  });
  expect(config.participants).toEqual([
    "archive/deepseek-v4-flash/2026-10-08T05-12-42-057Z",
    "archive/deepseek-v4.1-flash/<runId>",
    "archive/gpt-6-luna/<runId>",
    "archive/mimo-v2.6-flash/<runId>",
    "archive/muse-spark-1.3-contributor/<runId>",
  ]);
  expect(config.outputDir).toBeUndefined();
});

it("只写必填四项也合法,可选字段缺席(不是 undefined 键)", () => {
  const config = loadSeasonConfig(
    writeConfig(["masterSeed: m", "ruleset: v1", "seeds: 4", roster, ""].join("\n")),
  );
  expect(config.masterSeed).toBe("m");
  expect(config.seeds).toBe(4);
  expect(config.participants).toHaveLength(4);
  expect(Object.hasOwn(config, "concurrency")).toBe(false);
  expect(Object.hasOwn(config, "rankPoints")).toBe(false);
  expect(Object.hasOwn(config, "maps")).toBe(false);
  expect(Object.hasOwn(config, "outputDir")).toBe(false);
});

it("含全部可选字段时逐项读入", () => {
  const config = loadSeasonConfig(
    writeConfig(
      [
        "masterSeed: m",
        "ruleset: v1",
        "concurrency: 2",
        "rankPoints:",
        "  - 5",
        "  - 3",
        "  - 1",
        "  - 0",
        "maps:",
        "  - m1",
        "  - m2",
        "seeds: 2",
        roster,
        "outputDir: runs/x",
        "",
      ].join("\n"),
    ),
  );
  expect(config.concurrency).toBe(2);
  expect(config.rankPoints).toEqual([5, 3, 1, 0]);
  expect(config.maps).toEqual(["m1", "m2"]);
  expect(config.outputDir).toBe("runs/x");
});

it("缺必填字段:逐字段点名,并一次看完", () => {
  const path = writeConfig([roster, ""].join("\n"));
  expect(() => loadSeasonConfig(path)).toThrow(/masterSeed[\s\S]*ruleset[\s\S]*seeds/);
});

it("ruleset 与当前版本不一致时明确报错", () => {
  const path = writeConfig(["masterSeed: m", "ruleset: v2", "seeds: 4", roster, ""].join("\n"));
  expect(() => loadSeasonConfig(path)).toThrow(/ruleset.*v2/);
});

it("seeds 必须是 ≥1 的整数", () => {
  for (const bad of ["0", "-1", "1.5", "四"]) {
    const path = writeConfig(
      ["masterSeed: m", "ruleset: v1", `seeds: ${bad}`, roster, ""].join("\n"),
    );
    expect(() => loadSeasonConfig(path), `seeds=${bad}`).toThrow(/seeds/);
  }
});

it("参赛者少于 4 条明确报错", () => {
  const path = writeConfig(
    [
      "masterSeed: m",
      "ruleset: v1",
      "seeds: 4",
      "participants:",
      "  - archive/a/r1",
      "  - archive/b/r1",
      "  - archive/c/r1",
      "",
    ].join("\n"),
  );
  expect(() => loadSeasonConfig(path)).toThrow(/participants.*至少/);
});

it("participants 不是数组时报错", () => {
  const path = writeConfig(
    ["masterSeed: m", "ruleset: v1", "seeds: 4", "participants: 5", ""].join("\n"),
  );
  expect(() => loadSeasonConfig(path)).toThrow(/participants/);
});

it("participants 含非字符串项时报错", () => {
  const path = writeConfig(
    [
      "masterSeed: m",
      "ruleset: v1",
      "seeds: 4",
      "participants:",
      "  - archive/a/r1",
      "  - archive/b/r1",
      "  - archive/c/r1",
      "  - 42",
      "",
    ].join("\n"),
  );
  expect(() => loadSeasonConfig(path)).toThrow(/participants\[3\]/);
});

it("显式给出 maps 时 M × K ≢ 0 (mod 4) 报错", () => {
  const path = writeConfig(
    ["masterSeed: m", "ruleset: v1", "maps:", "  - m1", "  - m2", "seeds: 3", roster, ""].join(
      "\n",
    ),
  );
  expect(() => loadSeasonConfig(path)).toThrow(/M × K/);
});

it("缺省 maps 时判不了 M,均摊条件留给枚举器(不误报)", () => {
  const config = loadSeasonConfig(
    writeConfig(["masterSeed: m", "ruleset: v1", "seeds: 3", roster, ""].join("\n")),
  );
  expect(config.maps).toBeUndefined();
  expect(config.seeds).toBe(3);
});

it("rankPoints 长度不是 4 时报清晰错误", () => {
  const path = writeConfig(
    [
      "masterSeed: m",
      "ruleset: v1",
      "seeds: 4",
      "rankPoints:",
      "  - 3",
      "  - 2",
      "  - 1",
      roster,
      "",
    ].join("\n"),
  );
  expect(() => loadSeasonConfig(path)).toThrow(/rankPoints.*长度/);
});

it("rankPoints 含非有限数时报清晰错误", () => {
  const path = writeConfig(
    [
      "masterSeed: m",
      "ruleset: v1",
      "seeds: 4",
      "rankPoints:",
      "  - 3",
      "  - 2",
      "  - 1",
      "  - x",
      roster,
      "",
    ].join("\n"),
  );
  expect(() => loadSeasonConfig(path)).toThrow(/rankPoints.*有限/);
});

it("concurrency 必须是 ≥1 的整数", () => {
  const path = writeConfig(
    ["masterSeed: m", "ruleset: v1", "concurrency: 0", "seeds: 4", roster, ""].join("\n"),
  );
  expect(() => loadSeasonConfig(path)).toThrow(/concurrency/);
});

it("顶层不是映射时报错", () => {
  expect(() => loadSeasonConfig(writeConfig("- a\n- b\n"))).toThrow(/顶层/);
});

it("YAML 语法错误报错(带文件路径)", () => {
  expect(() => loadSeasonConfig(writeConfig("masterSeed: [\n"))).toThrow(/YAML 解析失败/);
});

it("读不到文件即报错", () => {
  expect(() => loadSeasonConfig(join(scratch, "no-such.yaml"))).toThrow(/读不到赛季配置/);
});

it("rankPoints 默认 [3,2,1,0],且不进 rulesets/", () => {
  expect(DEFAULT_RANK_POINTS).toEqual([3, 2, 1, 0]);
  const ruleset = readFileSync(join(repoRoot, "rulesets", "v1.json"), "utf8");
  expect(ruleset).not.toContain("rankPoints");
});

it("S4(zod 聚合):多个字段同时出错时仍是一份「一次看完」的清单", () => {
  // 缺 masterSeed / ruleset,seeds 取值错,concurrency 取值错:四条各点名字段、按 schema 序排列。
  const path = writeConfig(["seeds: 0", "concurrency: -1", roster, ""].join("\n"));
  expect(() => loadSeasonConfig(path)).toThrow(
    /masterSeed[\s\S]*ruleset[\s\S]*seeds[\s\S]*concurrency/,
  );
});
