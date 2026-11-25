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
import { INPUT_ROOTS, RADIUS } from "./change-radius.js";
import {
  INPUTS_SCHEMA,
  type InputsMap,
  MISSING_FILE,
  WATCHED_FILES,
  aggregate,
  currentFingerprint,
  fingerprintOf,
  isSnapshotCurrent,
  loadInputsMap,
  writeInputsMap,
} from "./test-inputs.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** 三个被监视文件的路径;测试里用它们当临时仓库的键,不写字面量。 */
const [RECORDER = "", SETUP = "", CONFIG = ""] = WATCHED_FILES;

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
    expect(currentFingerprint(missing)).toBe(
      fingerprintOf(["recorder", MISSING_FILE, MISSING_FILE]),
    );
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

describe("Input Root:新输入文件有地方可退", () => {
  it("非空:没有任何区域声明「内容必须被观测到」,这张表就无从推导", () => {
    expect(INPUT_ROOTS.length).toBeGreaterThan(0);
  });

  it("每个成员都能在 RADIUS 里找到对应的 mustObserve 规则,且 `suites` 非空", () => {
    for (const root of INPUT_ROOTS) {
      const rule = RADIUS.find((candidate) => candidate.area === root.area);
      expect(rule, `${root.area} 在 RADIUS 里没有规则`).toBeDefined();
      expect(rule?.mustObserve, `${root.area} 不是 mustObserve 规则`).toBe(true);
      // `suites` 空 = "新文件退回什么都不跑" = 静默少选,正是这张表要防的那件事。
      expect(root.suites.length, `${root.area} 的保守回退是空的`).toBeGreaterThan(0);
      expect(root.suites).toEqual(rule?.suites);
    }
  });

  it("反过来也成立:`mustObserve` 的每条规则都在表里(推导不会漏)", () => {
    const observed = RADIUS.filter((rule) => rule.mustObserve === true).map((rule) => rule.area);
    expect(INPUT_ROOTS.map((root) => root.area)).toEqual(observed);
  });
});
