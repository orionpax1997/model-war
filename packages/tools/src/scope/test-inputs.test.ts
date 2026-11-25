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
import { DERIVED_RULES, isDerived } from "./ignored-inputs.js";
import { RADIUS, decide, mustObserve, suitesFor } from "./change-radius.js";
import {
  INPUTS_SCHEMA,
  type InputsMap,
  type InputScope,
  MISSING_FILE,
  WATCHED_FILES,
  aggregate,
  classifyInput,
  currentFingerprint,
  fingerprintOf,
  inputScopeOf,
  invert,
  isInputPath,
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

/**
 * 观测口径**按类**判定,不按条目枚举,也不按「这台机器上有没有」。
 *
 * 起因是一个真事:`apps/cli/dist/modelwar.mjs` 由 `pnpm --filter apps/cli build` 里的 esbuild
 * 产出,标准链(`tsc -b`)不产出它。它在的机器上,`dependency-boundary` 那两个测试 spawn 的
 * `depcruise` 会多 open 一条;于是同一份代码在「手工 build 过」的机器上录出来的 map 多两条,
 * `observe:inputs` 红在一句「你构建过」上。那两句红跟代码没关系,是口径把**派生物**当成了输入。
 *
 * 这一组断言钉住三件事:
 *
 * 1. 口径与门禁白名单**同源**(`DERIVED_RULES`),覆盖同一批形状;
 * 2. 反方向:`apps/cli/dist/modelwar.mjs` 一句话就被判成「派生、不算输入」;
 * 3. 排除**看得见**:`aggregate` 把丢掉的东西交给 `onExcluded`,不是静默丢弃。
 */
describe("观测口径:按类排除派生,不随本机是否构建而变", () => {
  /** 没有源码在背后的世界(干净机器 / 打包器的额外产物)。 */
  const unbacked: InputScope = { backedArtifact: () => false };
  /** 有源码在背后的世界(每个产物都是某个 `src/*.ts` 的下一跳)。 */
  const backed: InputScope = { backedArtifact: () => true };

  it("`apps/cli/dist/modelwar.mjs` 是派生,不算输入(本票的反方向)", () => {
    const verdict = classifyInput({ path: "apps/cli/dist/modelwar.mjs", ...unbacked });
    expect(verdict).toMatchObject({ kind: "excluded", reason: "derived" });
    // 真实这棵树上也是同一个结论:它背后没有 `apps/cli/src/modelwar.ts`。
    expect(
      isInputPath({ path: "apps/cli/dist/modelwar.mjs", ...inputScopeOf(repoRoot) }),
      "本机若真有 apps/cli/src/modelwar.ts,这条断言的立论就不成立了——先看那个文件",
    ).toBe(false);
    expect(existsSync(join(repoRoot, "apps/cli/src/modelwar.ts"))).toBe(false);
  });

  it("有源码在背后的 dist 产物仍然是输入(测试真的该读 dist 时走的是这一格)", () => {
    // 测试读 `apps/cli/dist/match/assemble.js`:那是 `src/match/assemble.ts` 的产物,改源码要能
    // 顺着它找到读它的测试——所以它在 map 里是**对的**,不许一刀切掉。
    const real = inputScopeOf(repoRoot);
    expect(existsSync(join(repoRoot, "apps/cli/src/match/assemble.ts"))).toBe(true);
    expect(isInputPath({ path: "apps/cli/dist/match/assemble.js", ...real })).toBe(true);
    expect(isInputPath({ path: "packages/engine/dist/index.js", ...real })).toBe(true);
    // 判据是「背后有没有源码」,不是「在不在 dist 下」:同一路径换个世界就反过来。
    expect(isInputPath({ path: "apps/cli/dist/match/assemble.js", ...unbacked })).toBe(false);
  });

  it("派生形状按整段 / 后缀判定,任意深度都算,且不误吞相邻名字", () => {
    for (const path of [
      "packages/x/node_modules/a/index.js",
      "apps/cli/node_modules/@model-war/engine/package.json",
      "packages/x/tsconfig.tsbuildinfo",
      "packages/x/.vitest/report.json",
      ".stryker-tmp/sandbox-1/index.js",
    ]) {
      expect(isInputPath({ path, ...backed }), `${path} 被当成输入了`).toBe(false);
    }
    for (const path of [
      "packages/runner/src/distribution.ts",
      "packages/runner/src/nodes_modules.ts",
      "packages/tools/src/scope/test-inputs.ts",
      "rulesets/v2.json",
      "maps/open-clash.json",
      "packages/engine/sandbox-runtime/runtime.iife.js",
    ]) {
      expect(isInputPath({ path, ...backed }), `${path} 被排除了`).toBe(true);
    }
  });

  it("落点产物(顶层)不是输入:reports/ runs/ .scratch/ .workspaces/ .git/", () => {
    for (const path of [
      "reports/mutation/mutation.json",
      "runs/2026-10-16/replay.jsonl",
      ".scratch/spec.md",
      ".workspaces/wt-01/x.ts",
      ".git/config",
    ]) {
      expect(classifyInput({ path, ...backed }), path).toMatchObject({
        kind: "excluded",
        reason: "output",
      });
    }
  });

  /**
   * **两处口径覆盖同一批形状**(本票第一条)。
   *
   * 观测口径(`classifyInput`)与门禁白名单(`DERIVED_RULES`)共用一张表,这一条是它的外部证据:
   * 每条形状都造一个样本来,两边一起问。往 `DERIVED_RULES` 里加一种形状而观测口径没跟上、或
   * 反过来在 `OUTPUT_ROOTS` 里塞进一个「派生」形状,这里就红。
   */
  it("派生白名单的每一条形状,观测口径都认(同源;改一边不改另一边在这里红)", () => {
    expect(DERIVED_RULES.length).toBeGreaterThan(0);
    for (const rule of DERIVED_RULES) {
      const sample =
        rule.kind === "segment"
          ? `packages/probe/${rule.value}/index.js`
          : `packages/probe/x${rule.value}`;
      // 门禁那一侧:它是派生(允许被读,不必登记)。
      expect(isDerived(sample), `${rule.value} 不在门禁的派生白名单里`).toBe(true);
      // 观测那一侧:它不进 map(没有源码在背后时)。`dist/` 那一格是例外中的例外:
      // 有源码在背后时它**算输入**,见上一条。
      const verdict = classifyInput({ path: sample, ...unbacked });
      expect(verdict, `${rule.value} 这种形状混进了输入 map`).toMatchObject({
        kind: "excluded",
        reason: "derived",
      });
      // 反过来:观测口径排除的「派生」必须真的是门禁认的那种派生,不许自己发明一类。
      expect(isDerived(sample), `${rule.value} 被观测口径排除了,却不被门禁当成派生`).toBe(true);
    }
  });

  it("排除是可见的:`aggregate` 把丢掉的东西交给 onExcluded,不是静默丢弃", () => {
    const test = "packages/engine/src/sandbox.test.ts";
    const jsonl = [
      line(test, "rulesets/v2.json"),
      line(test, "reports/mutation/mutation.json"),
      line(test, "apps/cli/dist/modelwar.mjs"),
    ].join("");
    const dropped: { path: string; why: string }[] = [];
    const map = aggregate(jsonl, "/repo", "fp", (path, verdict) => {
      dropped.push({ path, why: verdict.why });
    });
    expect(map.files[test], "真输入被一起丢了").toEqual(["rulesets/v2.json"]);
    expect(dropped.map((entry) => entry.path).sort()).toEqual([
      "apps/cli/dist/modelwar.mjs",
      "reports/mutation/mutation.json",
    ]);
    // 每条排除都带理由:审计的人能从日志里读出「为什么它不算输入」。
    for (const entry of dropped)
      expect(entry.why, `${entry.path} 被丢掉了却没说为什么`).not.toBe("");
  });

  it("同一份 jsonl,盘上有没有源码决定 `dist/` 算不算输入(不静默,也不迷信路径)", () => {
    const test = "packages/x/src/a.test.ts";
    const repo = openRepo({
      "packages/x/tsconfig.json": JSON.stringify({
        compilerOptions: { rootDir: "src", outDir: "dist" },
      }),
      "packages/x/src/a.ts": "export const a = 1;\n",
    });
    const jsonl = [
      line(test, "packages/x/dist/a.js"),
      line(test, "packages/x/dist/bundle.mjs"),
    ].join("");
    const dropped: string[] = [];
    const map = aggregate(jsonl, repo, "fp", (path) => dropped.push(path));
    // `a.js` 有 `src/a.ts` 在背后 → 是输入;`bundle.mjs` 没有 → 排除。
    expect(map.files[test]).toEqual(["packages/x/dist/a.js"]);
    expect(dropped).toEqual(["packages/x/dist/bundle.mjs"]);
  });
});
