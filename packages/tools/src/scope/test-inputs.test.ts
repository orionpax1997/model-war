/**
 * 观测快照的**有效性**(票 T5)。断言顺序与票里的编号一致。
 *
 * 这里测的不是"map 记得对不对"(那是 `test-layers.test.ts` 对入库 map 的判据),而是
 * **这张 map 还有没有资格当判据**。两者失败的方向不一样:记错了会多跑,而过期了会**少跑**,
 * 且少跑不报错——所以过期必须有声音。
 *
 * 临时仓库(`mkdtempSync`)的作用是把"文件在不在、内容是什么"变成可控输入:指纹的每一种
 * 变化(改内容 / 删文件 / 换个目录放同样的内容)都要能单独演一遍。
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { workspacesOf } from "./build-outputs.js";
import { RADIUS, decide, mustObserve, suitesFor } from "./change-radius.js";
import {
  INPUTS_SCHEMA,
  type InputsMap,
  MISSING_FILE,
  WATCHED_FILES,
  aggregate,
  currentFingerprint,
  fingerprintOf,
  invert,
  isSnapshotCurrent,
  loadInputsMap,
  writeInputsMap,
} from "./test-inputs.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** 前三个被监视文件的路径;测试里用它们当临时仓库的键,不写字面量。 */
const [RECORDER = "", SETUP = "", CONFIG = ""] = WATCHED_FILES;

/** 一份"所有被监视文件都不存在"的指纹,用来验删除也进指纹。 */
const allMissing = (contentOfFirst: string): readonly string[] => [
  contentOfFirst,
  ...WATCHED_FILES.slice(1).map(() => MISSING_FILE),
];

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** 一个空的临时仓库;`files` 按仓库相对路径写盘(自动建目录)。 */
const openRepo = (files: Record<string, string> = {}): string => {
  const dir = mkdtempSync(join(tmpdir(), "model-war-inputs-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) write(dir, path, content);
  return dir;
};

const write = (dir: string, path: string, content: string): void => {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
};

/** 一行 recorder 的记录:哪个测试文件的哪个用例读了哪个路径。 */
const line = (testFile: string, path: string): string =>
  `${JSON.stringify({ t: `${testFile}::某个用例`, k: "open", p: path })}\n`;

describe("内容指纹:同一份输入在任何地方都是同一枚", () => {
  it("同内容稳定,不同内容不同", () => {
    expect(fingerprintOf(["a", "b"])).toBe(fingerprintOf(["a", "b"]));
    expect(fingerprintOf(["a", "b"])).not.toBe(fingerprintOf(["a", "c"]));
  });

  it('分段边界有意义:`["ab","c"]` 与 `["a","bc"]` 不是同一份输入', () => {
    expect(fingerprintOf(["ab", "c"])).not.toBe(fingerprintOf(["a", "bc"]));
  });

  it("指纹只由内容决定:同样的内容,不同的仓库路径得到同一枚", () => {
    const left = openRepo({ [RECORDER]: "recorder", [SETUP]: "setup", [CONFIG]: "config" });
    const right = openRepo({ [RECORDER]: "recorder", [SETUP]: "setup", [CONFIG]: "config" });
    expect(currentFingerprint(left)).toBe(currentFingerprint(right));
  });

  it("被监视的文件不见了也进指纹(删除 ≠ 没发生)", () => {
    const complete = openRepo({
      [RECORDER]: "recorder",
      [SETUP]: "setup",
      [CONFIG]: "config",
    });
    const missing = openRepo({ [RECORDER]: "recorder" });
    expect(currentFingerprint(missing)).not.toBe(currentFingerprint(complete));
    // 期望值从 `WATCHED_FILES` 的长度推出来:监视名单增减时,这里跟着走而不是写死条数。
    expect(currentFingerprint(missing)).toBe(fingerprintOf(allMissing("recorder")));
  });
});

describe("监视名单本身不许腐烂", () => {
  it("`WATCHED_FILES` 每一条在这棵树里真实存在(改名即红,而不是静默不盯)", () => {
    for (const file of WATCHED_FILES) {
      expect(existsSync(join(repoRoot, file)), `${file} 不存在:监视名单指向了旧路径`).toBe(true);
    }
  });

  it("这棵树的指纹算得出来,且是 16 位十六进制", () => {
    expect(currentFingerprint(repoRoot)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("快照过期:空指纹不许冒充判据", () => {
  const current = "0123456789abcdef";
  const empty: InputsMap = { version: INPUTS_SCHEMA, fingerprint: "", files: {} };

  it("空指纹(旧快照)→ 过期", () => {
    expect(isSnapshotCurrent({ map: empty, fingerprint: current })).toBe(false);
  });

  it("指纹不同 → 过期", () => {
    const map: InputsMap = { ...empty, fingerprint: "ffffffffffffffff" };
    expect(isSnapshotCurrent({ map, fingerprint: current })).toBe(false);
  });

  it("指纹相同 → 有效", () => {
    const map: InputsMap = { ...empty, fingerprint: current };
    expect(isSnapshotCurrent({ map, fingerprint: current })).toBe(true);
  });
});

describe("聚合与落盘:指纹跟着 map 走完一个来回", () => {
  const jsonl = [
    line("/repo/packages/engine/src/sandbox.test.ts", "rulesets/basic.json"),
    line("/repo/packages/engine/src/sandbox.test.ts", ".scratch/ignored.json"),
  ].join("");

  it("`aggregate` 产出的 map 带指纹与 schema 版本", () => {
    const map = aggregate(jsonl, "/repo", "abc123");
    expect(map.fingerprint).toBe("abc123");
    expect(map.version).toBe(INPUTS_SCHEMA);
    expect(map.files).toEqual({
      "packages/engine/src/sandbox.test.ts": ["rulesets/basic.json"],
    });
  });

  it("`writeInputsMap` / `loadInputsMap` 往返保留指纹", () => {
    const dir = openRepo();
    const map = aggregate(jsonl, "/repo", "abc123");
    writeInputsMap(dir, map);
    expect(loadInputsMap(dir)).toEqual(map);
  });

  it("旧快照(version: 1,无指纹)读出来指纹是空串 → 视为过期", () => {
    const dir = openRepo({
      "test-inputs/inputs.json": JSON.stringify({
        version: 1,
        files: { "packages/engine/src/sandbox.test.ts": ["rulesets/basic.json"] },
      }),
    });
    const map = loadInputsMap(dir);
    expect(map.fingerprint).toBe("");
    expect(map.files).toEqual({ "packages/engine/src/sandbox.test.ts": ["rulesets/basic.json"] });
    expect(isSnapshotCurrent({ map, fingerprint: currentFingerprint(dir) })).toBe(false);
  });
});

/**
 * 新输入文件的保守回退(票 T5)。
 *
 * 这里曾经有一张导出叫 `INPUT_ROOTS`(把 `mustObserve` 规则投影成 `{area, suites}`),而它
 * **没有任何生产消费者**——唯一用处就是拿它对着 `RADIUS` 自证。那种断言恒真:两边都由
 * `RADIUS` 算出来,它红了只能说明投影函数写错。
 *
 * 真正要保的性质是**行为**:一个观测 map 里没有的文件,照样被选中保守的那一族;而若那条
 * 规则的回退是空的,"新文件没人看"就真的无处可退。于是这里不投影、不比对表,直接问选择器。
 */
describe("Input Root:新输入文件有地方可退(问行为,不问表)", () => {
  const workspaces = workspacesOf(repoRoot);

  it("每条 mustObserve 规则的回退非空(空 = 新文件退回什么都不跑)", () => {
    const rules = RADIUS.filter((rule) => rule.mustObserve === true);
    expect(rules.length, "没有 mustObserve 规则:这张表已经没什么可保护的").toBeGreaterThan(0);
    for (const rule of rules) {
      // `suites` 空 = "新文件退回什么都不跑" = 静默少选,正是这组断言要防的那件事。
      expect(rule.suites.length, `${rule.area} 的保守回退是空的`).toBeGreaterThan(0);
    }
  });

  it("未观测的新文件:map 里没有它,仍选中该区域的 suites,且 mustObserve 为真", () => {
    const file = "rulesets/zz-unrecorded.json";
    // 前提钉住:它真的不在盘上、真的不在 map 里。否则下面验的就是另一件事。
    expect(existsSync(join(repoRoot, file)), "这条断言要一个盘上不存在的新文件").toBe(false);
    expect(invert(loadInputsMap(repoRoot)).get(file), "map 里居然有它").toBeUndefined();

    const decision = decide({
      paths: [file],
      workspaces,
      // 盘上有什么全不影响这条判据:回退是表的性质,不是磁盘的性质。
      exists: () => false,
    });
    expect(decision.scripts).toContain("test:vm");
    expect(decision.graphFiles, "数据文件进不了图,这条腿为空才是正常的").toEqual([]);
    // 没人观测到它 → 未观测红线的条件成立。它红得起来,是因为回退给了候选;
    // 回退为空时这里同样成立却没有候选——那才是要防的静默少选。
    expect(mustObserve({ path: file, workspaces })).toBe(true);
  });

  it("已删除的文件仍选中 test:vm(旧路径仍在 ChangeSet 里,盘上已经没了)", () => {
    const file = "rulesets/zz-deleted.json";
    expect(existsSync(join(repoRoot, file)), "这条断言要一个已被删除的路径").toBe(false);
    // 删除走的是同一套前缀规则:判据不读磁盘,只读路径。
    expect(suitesFor(file)).toEqual(["test:vm"]);
    expect(decide({ paths: [file], workspaces, exists: () => false }).scripts).toContain("test:vm");
  });
});
