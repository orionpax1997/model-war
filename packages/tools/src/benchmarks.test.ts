/**
 * 基准目录的**内容**:登记册、说明表、排除项,以及三份脚本的编译诊断。
 *
 * ── 这份文件与门禁 `check:bench` 各管一半,分界是「能不能被机器重跑一遍」 ──────────
 * 门禁那侧(`benchmarks/run-benchmarks-gate.ts`)管的是**产物**:重编译一次,必须与入库产物
 * 逐字节一致,产物是裸脚本,入口在裸上下文里调得动。那些判决会 spawn `tsc`,一次十几秒,
 * 属于门禁那一档。
 * 这一侧管的是**记下来的东西**:目录里有哪些文件、说明表写了什么、体积对不对、
 * 「不可与旧四舱互比」那条口径在不在、重跑规则写没写、编译诊断的形状。
 *
 * ── 为什么登记册要写字面清单,而不是读目录再排序 ────────────────────────────────
 * 「数出来是三份」拦不住「有人往基准目录里放了第四份」。字面清单把「基准目录里有什么」
 * 变成一条要显式改的断言:加一份基准就是往 `BENCHMARK_NAMES` 里加一行,顺带就得在说明表里
 * 给它一行。这与真源包里那几条键数断言同一纪律(数目对了不等于集合对了)。
 *
 * ── 反例手法 ──────────────────────────────────────────────────────────────────
 * 在说明表里把 C 舱的标签改回「农民海」,或把体积数字改一位,或把「不可与旧四舱互比」那句删掉
 * ——三条各自让本文件对应的那条红。往 `benchmarks/` 里多放一个 `meta.json`(半截存档元数据)
 * 或一份 `farmer.js`(标定环的采集探针),让「目录逐字是这几份」那条红。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { RULESET_VERSION, SANDBOX_INJECTED_API_SYMBOLS } from "@model-war/schema";

import {
  BENCHMARK_NAMES,
  BENCHMARK_ROOT,
  PRODUCT_FILE,
  SOURCE_FILE,
  benchmarkFile,
  compileBenchmarkSource,
} from "./benchmarks/compile.ts";

/** 说明表(基准目录里唯一的那份 Markdown)。 */
const README = `${BENCHMARK_ROOT}/README.md`;

/**
 * 说明表的列。逐字写出而不是「数一数有几列」:列名是这份表与它的读者之间的约定,
 * 少一列(比如把体积两列合成一列)会让「体积分列记录」这条悄悄失守,而数目仍然是对的。
 */
const COLUMNS = [
  "目录",
  "策略标签(行为描述)",
  "标签的行为依据",
  "模型标识",
  "生成参数",
  "静态校验结果",
  "契约版本",
  "源码体积",
  "产物体积",
] as const;

/** 表头行与表体行都是 Markdown 表格行;这里只取基准那几行(`| \`cell-…\` |` 开头)。 */
const tableRows = (): readonly (readonly string[])[] => {
  const rows = readFileSync(README, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("| `cell-"))
    .map((line) =>
      line
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim()),
    );
  // 表头行按列名逐字断言;解析不出行不是「无事可查」,那会让下面每条都在空集上绿。
  expect(rows.length, "说明表里一份基准脚本都没有").toBe(BENCHMARK_NAMES.length);
  return rows;
};

/** 某一行里的一格;按列名取,免得行文改一改就把断言挪错位。 */
const cell = (row: readonly string[], column: string): string => {
  const at = COLUMNS.indexOf(column as (typeof COLUMNS)[number]);
  expect(at >= 0, `说明表里没有 ${column} 这一列`).toBe(true);
  return row[at] ?? "";
};

/** `8751 字节` → 8751。取不到数字就是 0,于是与磁盘大小对不上时当场红。 */
const bytesIn = (text: string): number => Number(/(\d+)\s*字节/.exec(text)?.[1] ?? "0");

it("说明表的表头逐字是这九列,体积分列记录不得合成一列", () => {
  const header = readFileSync(README, "utf8")
    .split("\n")
    .find((line) => line.startsWith("| 目录 |"));
  expect(header, "说明表的开头不是那张表").toBeDefined();
  const columns = (header ?? "")
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((name) => name.trim());
  expect(columns).toEqual([...COLUMNS]);
});

it("基准目录逐字是登记册上那三份的源码 + 产物,外加那份说明表", () => {
  const entries = readdirSync(BENCHMARK_ROOT, { withFileTypes: true })
    .map((entry) => entry.name)
    .sort();
  // `.gitkeep` 是空占位目录的占位符,本目录有内容之后它仍然留着(与 `rulesets/`、`docs/rules-v1/` 同一处置)。
  const expected = [...BENCHMARK_NAMES, "README.md", ".gitkeep"].sort();
  expect(entries, "基准目录里多出或少了东西").toEqual(expected);

  for (const name of BENCHMARK_NAMES) {
    expect(
      readdirSync(join(BENCHMARK_ROOT, name)).sort(),
      `${name} 里应当只有 ${SOURCE_FILE} 与 ${PRODUCT_FILE} 两份`,
    ).toEqual([PRODUCT_FILE, SOURCE_FILE].sort());
  }
});

it("按既有先例排除:采集探针、零产出存档、半截存档元数据都不在基准目录里", () => {
  // 逐条点名,因为「目录里只有那几份」那条断言说不出**为什么**只有那几份。
  // - 标定环的采集探针不是参赛脚本(它是标定环的测量工具);
  // - 某模型的零产出存档是失败记录,不是基准;
  // - 存档元数据的形状由生成管线那一格回填,现在写就是半截字段(比没有更坏)。
  const excluded = [
    "farmer.js",
    "farmer.calibration-v1.js",
    "cell-c-failed-attempts",
    "meta.json",
    "meta",
  ];
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      const relative = path.slice(`${BENCHMARK_ROOT}/`.length);
      if (excluded.some((name) => relative === name || relative.endsWith(`/${name}`))) {
        found.push(relative);
      }
    }
  };
  walk(BENCHMARK_ROOT);
  expect(found, "基准目录里混进了按既有先例该排除的东西").toEqual([]);
  expect(existsSync(`${BENCHMARK_ROOT}/meta.json`), "基准目录里有半截存档元数据").toBe(false);
});

it("说明表每行都有标签、模型标识、生成参数与静态校验结果,且标签是行为描述", () => {
  for (const row of tableRows()) {
    const dir = cell(row, "目录");
    const label = cell(row, "策略标签(行为描述)");
    expect(label, `${dir} 没写策略标签`).not.toBe("");
    // 「能力评级」那类词是评级不是描述:它们评价强弱,而说明表要说的是这份脚本做了什么。
    for (const rating of ["最强", "较弱", "垃圾", "菜", "水平高", "水平差", "S 级", "A级"]) {
      expect(label.includes(rating), `${dir} 的标签里出现了能力评级式的词「${rating}」`).toBe(
        false,
      );
    }
    expect(cell(row, "标签的行为依据"), `${dir} 的标签没有行为依据`).not.toBe("");
    expect(cell(row, "模型标识"), `${dir} 没写模型标识`).not.toBe("");
    expect(cell(row, "生成参数"), `${dir} 没写生成参数`).not.toBe("");
    expect(cell(row, "静态校验结果"), `${dir} 没写静态校验结果`).toContain("零违规");
  }
});

it("C 舱的标签沿用旧一轮的修正:占点(不采集),不是「农民海」", () => {
  const row = tableRows().find((candidate) => cell(candidate, "目录").includes("cell-c"));
  expect(row, "说明表里没有 C 舱那一行").toBeDefined();
  const label = cell(row ?? [], "策略标签(行为描述)");
  expect(label).toContain("占点(不采集)");
  expect(label, "C 舱的标签仍是旧标签「农民海」").not.toContain("农民海");

  // 行为依据那一格必须落在脚本自身的行为上(不造农民 / 不采集 / 经济死亡 / 停在相邻格),
  // 而不是落在「它强」上——这一栏存在的理由就是给这个标签兜底。
  const basis = cell(row ?? [], "标签的行为依据");
  for (const evidence of ["不造农民", "harvest", "transfer", "经济死亡"]) {
    expect(basis, `C 舱的行为依据里没有「${evidence}」这一条`).toContain(evidence);
  }
});

it("说明表里的体积逐个等于磁盘上的字节数,契约版本等于真源包的版本", () => {
  for (const row of tableRows()) {
    const dir = cell(row, "目录").replaceAll("`", "").replace(/\/$/, "");
    expect(BENCHMARK_NAMES).toContain(dir as (typeof BENCHMARK_NAMES)[number]);
    expect(bytesIn(cell(row, "源码体积")), `${dir} 的源码体积与磁盘上的字节数不符`).toBe(
      statSync(benchmarkFile(dir as (typeof BENCHMARK_NAMES)[number], SOURCE_FILE)).size,
    );
    expect(bytesIn(cell(row, "产物体积")), `${dir} 的产物体积与磁盘上的字节数不符`).toBe(
      statSync(benchmarkFile(dir as (typeof BENCHMARK_NAMES)[number], PRODUCT_FILE)).size,
    );
    expect(cell(row, "契约版本").replaceAll("`", ""), `${dir} 的契约版本与真源包不一致`).toBe(
      RULESET_VERSION,
    );
  }
});

it("说明表带着「不可与旧四舱互比」的口径,以及换契约版本时重跑不保留的规则", () => {
  const readme = readFileSync(README, "utf8");
  // 盲写那一轮的判读点名要求:收基准目录时必须带上这条口径。判据取逐字的那半句。
  expect(readme).toContain("不可与旧四舱的读数互比");
  // 重跑规则:「重跑」与「不保留」两个字都必须出现,只写一句「看情况」过不了。
  expect(readme).toMatch(/重跑[^\n]*不保留/);
  // 存档元数据的位置留着,但注明由哪一格回填——不留半截字段。
  expect(readme).toContain("存档元数据");
  expect(readme).toContain("生成管线那一格");
});

it("三份脚本的编译诊断只有那三类,且「名字未声明」逐个在注入面符号表里", () => {
  for (const name of BENCHMARK_NAMES) {
    const source = readFileSync(benchmarkFile(name, SOURCE_FILE), "utf8");
    const compiled = compileBenchmarkSource(source);
    const where = `${name} 的编译诊断`;

    // 零退出在这里是**坏消息**:类型面还没回填,零退出意味着某个东西替 API 填上了声明。
    expect(compiled.status, `${where} 编译通过了,类型面却还没回填`).not.toBe(0);

    const unexpected = compiled.diagnostics.filter((d) => d.cls === "unexpected");
    expect(
      unexpected.map((d) => d.line),
      `${where} 里有三类之外的诊断`,
    ).toEqual([]);

    const names = compiled.diagnostics
      .filter((d) => d.cls === "unresolved-name")
      .map((d) => d.name ?? "");
    expect(names.length, `${where} 一个「名字未声明」都没有,那它压根没用注入面`).toBeGreaterThan(0);
    for (const unresolved of names) {
      expect(
        SANDBOX_INJECTED_API_SYMBOLS,
        `${where} 用到了注入面符号表里没有的名字 \`${unresolved}\`,` +
          "那不是「类型面没回填」而是脚本用了运行时不存在的 API",
      ).toContain(unresolved);
    }
  }
});
