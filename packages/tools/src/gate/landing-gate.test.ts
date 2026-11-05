/**
 * 验收落点判据纯函数层的单测:四类 token 的归类、每行至少一个落点、以及各类的不存在与
 * 「git 坏了 ≠ 路径不存在」。
 *
 * 落 `unit` project(一条命令都不跑),跟着默认链 `pnpm run test` 走;真门禁的退出码与反例
 * 在 `gates.test.ts` 的「验收落点门禁」那一节。
 *
 * 反例统一走**纯函数 + 篡改文本 + 假世界**:不改真实文件,也不脏工作区——与 `vacuous.test.ts`
 * 同一条纪律。假世界(`LandingWorld`)的作用是让「文件不存在」「目录空」「git 出错」这三种
 * 外部状态能在同一条用例里各自现做现验。
 */

import { expect, it } from "vitest";

import {
  LANDING_DOC,
  checkLandings,
  classifyLandingToken,
  commandNamesFrom,
  landingRowsIn,
  landingTokensIn,
  scriptTokenExemption,
  scriptTokenFindings,
  type LandingDoc,
  type LandingWorld,
  type TrackedResult,
} from "./landing-gate.ts";

const SCRIPTS = ["check:prose", "check:landings", "coupling", "scan"] as const;
const CLI_NAMES = ["verify", "map-lint"] as const;

/** 默认世界:文件与目录都存在且被跟踪。单个用例按需要覆盖其中一项。 */
const world = (overrides: Partial<LandingWorld> = {}): LandingWorld => ({
  scripts: [...SCRIPTS],
  cliNames: [...CLI_NAMES],
  fileExists: () => true,
  dirEntryCount: () => 3,
  trackedState: (): TrackedResult => ({ kind: "tracked" }),
  ...overrides,
});

const kindOf = (raw: string): string | undefined => classifyLandingToken(raw, [...SCRIPTS])?.kind;

it("四类落点各按形态归类:命名脚本 / CLI 子命令 / 文件路径 / 目录", () => {
  // 命名脚本的两种认法:脚本形态(`a:b`)与「裸词恰好是脚本名」。
  expect(kindOf("check:not-in-manifest")).toBe("script");
  expect(kindOf("coupling")).toBe("script");
  // CLI:裸 `modelwar` 是 bin 名,不是子命令;带参数时只取子命令名。
  expect(classifyLandingToken("modelwar verify", [...SCRIPTS])).toEqual({
    kind: "cli",
    value: "verify",
    raw: "modelwar verify",
  });
  expect(classifyLandingToken("modelwar verify <replay.jsonl>", [...SCRIPTS])?.value).toBe(
    "verify",
  );
  expect(kindOf("modelwar")).toBeUndefined();
  // 文件路径与目录:要求已知前缀 + 形状(带扩展名 / 尾斜杠)。
  expect(kindOf("packages/engine/src/snapshot/read-only-isolation.test.ts")).toBe("file");
  expect(kindOf("benchmarks/")).toBe("dir");
  // 散文里顺带提到的名字四类都认不出,不算落点(否则 `stateHash` 会变成「不存在的文件」)。
  expect(kindOf("stateHash")).toBeUndefined();
  expect(kindOf("预算结构门禁")).toBeUndefined();
});

it("两类显式豁免带理由:`node:` 内建与 `role:` 数据字段都不当脚本", () => {
  expect(scriptTokenExemption("node:crypto")?.reason).toContain("内建模块");
  expect(scriptTokenExemption("role:slug")?.reason).toContain("数据字段");
  expect(scriptTokenExemption("check:prose")).toBeUndefined();
  // 豁免 = 「这不是落点」,所以只有它的那一行仍然算「一个可执行 token 都没有」。
  expect(kindOf("node:util")).toBeUndefined();
  expect(kindOf("role:slug")).toBeUndefined();
});

const TABLE = [
  "## 11. 验收落点",
  "",
  "| 验收面 | 落点 |",
  "|---|---|",
  "| 只读隔离 | `packages/engine/src/snapshot/read-only-isolation.test.ts` |",
  "| 四方对等 | `modelwar map-lint` + `benchmarks/` |",
  "",
  "## 12. 开放项",
  "",
  "| 验收面 | 落点 |",
  "|---|---|",
  "| 不该被算进来 | `check:not-in-manifest` |",
].join("\n");

it("只抽 §11 那张表:表头、分隔行与下一节的表格都不算落点行", () => {
  const rows = landingRowsIn(TABLE);
  expect(rows).toHaveLength(2);
  expect(rows[0]?.face).toBe("只读隔离");
  expect(rows[0]?.line).toBe(5);
  // 下一节里的同名表不属于 §11:把它数进来,「行数」就不再是「验收面的个数」。
  expect(rows.map((row) => row.face)).not.toContain("不该被算进来");
});

it("抽不到 §11 时返回空数组(空数组在入口那边按失败处理)", () => {
  expect(landingRowsIn("## 别的节\n\n正文\n")).toEqual([]);
});

it("一段文本里的落点 token 按书写顺序收集,认不出的不占位", () => {
  const tokens = landingTokensIn("散文 `stateHash` + `modelwar verify` + `benchmarks/`", [
    ...SCRIPTS,
  ]);
  expect(tokens.map((token) => token.kind)).toEqual(["cli", "dir"]);
});

it("全绿:每行都有存在的落点,统计口径给出规模自证", () => {
  const report = checkLandings({
    hldText: TABLE,
    docs: [{ path: "docs/hld.md", text: "见 `check:prose`。" }],
    world: world(),
  });
  expect(report.findings).toEqual([]);
  expect(report.stats).toEqual({ rows: 2, tokens: 3, cliNames: 2, docs: 1 });
});

it("一行落点全是散文 → 红:那一行什么也跑不起来", () => {
  const report = checkLandings({
    hldText: TABLE.replace("`modelwar map-lint` + `benchmarks/`", "属性测试 + 一键复算"),
    docs: [],
    world: world(),
  });
  expect(report.findings).toHaveLength(1);
  expect(report.findings[0]?.where).toBe(`${LANDING_DOC}:6`);
  expect(report.findings[0]?.detail).toContain("没有一个可执行 token");
  expect(report.findings[0]?.detail).toContain("散文不是落点");
});

it("文件路径不存在 → 红;存在但没进版本库 → 红(两种处方不同)", () => {
  const missing = checkLandings({
    hldText: TABLE,
    docs: [],
    world: world({ fileExists: (path) => !path.endsWith(".test.ts") }),
  });
  expect(missing.findings).toHaveLength(1);
  expect(missing.findings[0]?.detail).toContain("磁盘上没有这个文件");

  const untracked = checkLandings({
    hldText: TABLE,
    docs: [],
    world: world({ trackedState: () => ({ kind: "untracked" }) }),
  });
  // 目录也要被跟踪:两条落点(token 里的文件与目录)各报一次。
  expect(untracked.findings).toHaveLength(2);
  expect(untracked.findings[0]?.detail).toContain("没进版本库");
});

it("git 自己出错 ≠ 路径不存在:按「检查失效」报,不折算成干净也不折算成不存在", () => {
  const report = checkLandings({
    hldText: TABLE,
    docs: [],
    world: world({ trackedState: () => ({ kind: "git-error", detail: "退出码 128:fatal" }) }),
  });
  expect(report.findings).toHaveLength(2);
  for (const finding of report.findings) {
    expect(finding.detail).toContain("检查失效");
    expect(finding.detail).toContain("退出码 128");
    expect(finding.detail).not.toContain("磁盘上没有这个文件");
  }
});

it("目录存在但是空的 → 红:空目录里没有任何可跑的东西", () => {
  const report = checkLandings({
    hldText: TABLE,
    docs: [],
    world: world({ dirEntryCount: () => 0 }),
  });
  expect(report.findings).toHaveLength(1);
  expect(report.findings[0]?.detail).toContain("不存在或者是空的");
});

it("脚本形态的 token 不在脚本清单里 → 红;CLI 子命令不在登记表里 → 红", () => {
  const badScript = checkLandings({
    hldText: TABLE.replace("`benchmarks/`", "`check:no-such-gate`"),
    docs: [],
    world: world(),
  });
  expect(badScript.findings).toHaveLength(1);
  expect(badScript.findings[0]?.detail).toContain("scripts 里没有这个名字");

  const badCli = checkLandings({
    hldText: TABLE.replace("`modelwar map-lint`", "`modelwar no-such-command`"),
    docs: [],
    world: world(),
  });
  expect(badCli.findings).toHaveLength(1);
  expect(badCli.findings[0]?.detail).toContain("COMMANDS 里没有");
});

const doc = (path: string, text: string): LandingDoc => ({ path, text });

it("文档里脚本形态的 token 必须存在;豁免按前缀、不按文件", () => {
  const docs = [
    doc("docs/adr/0005.md", "那个 `engine:runner` 缝与 `node:crypto`、`role:slug`。"),
    doc("docs/hld.md", "跑 `check:prose` 与 `coupling`。"),
  ];
  const findings = scriptTokenFindings(docs, [...SCRIPTS]);
  // `engine:runner` 是子系统名写成了脚本形态 → 红(ADR-0005 就是被这一条抓出来的)。
  expect(findings).toHaveLength(1);
  expect(findings[0]?.where).toBe("docs/adr/0005.md:1");
  expect(findings[0]?.detail).toContain("engine:runner");
  // 豁免只作用于那两个前缀:同一份文档里别的东西照查。
  expect(findings[0]?.detail).not.toContain("node:crypto");
  expect(findings[0]?.detail).not.toContain("role:slug");
});

it("control:同一条文档扫描在脚本存在时全绿", () => {
  const docs = [doc("docs/hld.md", "跑 `check:prose`、`coupling`、`node:util`。")];
  expect(scriptTokenFindings(docs, [...SCRIPTS])).toEqual([]);
});

it("从 COMMANDS 源码文本抽子命令名:只切那一段,不捡 CommandName 联合类型", () => {
  const source = [
    'export type CommandName = "ghost" | "verify";',
    "",
    "export const COMMANDS: readonly CommandSpec[] = [",
    "  {",
    '    name: "verify",',
    '    usage: "modelwar verify <replay.jsonl>",',
    "  },",
    "];",
  ].join("\n");
  // `ghost` 只出现在类型里(登记了但没实现):认它等于把「没实现」读成「有」。
  expect(commandNamesFrom(source)).toEqual(["verify"]);
  expect(commandNamesFrom("export const other = 1;\n")).toEqual([]);
});
