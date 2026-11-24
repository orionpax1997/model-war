/**
 * 「改动半径」自身的判据。它盯的不是业务行为,而是**这套选择器还准不准**。
 *
 * 为什么选择器需要判据:漏一条规则的后果是「那部分代码改了却没人跑它的测试」,而它**不会**
 * 以报错的形式自己显形——恰恰相反,它会给出一个绿。所以这里用几条断言把两端都钉住:
 *
 * - 表里的规则必须**指向一个真实存在的路径**(写了一条没人命中的规则 = 你脑补了一个目录);
 *   “存在”有两种:在盘上,或被 `.gitignore` 覆盖——后者是本机才有的输入(`archive/`、
 *   `reports/`、`models.yaml`),干净克隆里本来就没有,而规则**必须**收它们;
 * - 仓库顶层与每个包都必须在某一端的覆盖下(新增包、新增顶层目录即红);
 * - 源码改动必须能映射到产物(映射不出来就等于图看不见它,静默少选);
 * - 产物不在盘上时必须退回全量,而不是照旧少选。
 *
 * 这些全是静态读文件或纯函数调用,0.4s 级——便宜是因为它读的是**入库事实**,不是跑一遍。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, matchesGlob, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildOutputsOf, workspacesOf } from "./build-outputs.js";
import type { ChangeEntry } from "./change-set.js";
import {
  ALWAYS,
  GATES_CASES,
  GRAPH_BLIND_TESTS,
  IGNORED_AREAS,
  RADIUS,
  SUITES,
  UnregisteredPathError,
  decide,
  probeApplies,
} from "./change-radius.js";
import { describeDeleted, probeTargets, runsFor, unobservedGap } from "./check.js";
import { STRUCTURAL_TESTS } from "./related-probe.js";
import {
  currentFingerprint,
  isInputPath,
  loadInputsMap,
  snapshotStaleMessage,
} from "./test-inputs.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const workspaces = workspacesOf(repoRoot);
const built = (): boolean => true;

const manifest = (): { scripts: Record<string, string> } =>
  JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };

const unexplainable = (paths: readonly string[]): string => `\n  ${paths.join("\n  ")}`;

const decideOn = (paths: readonly string[]) => decide({ paths, workspaces, exists: built });

/**
 * 这个路径是否被 `.gitignore` **规则**命中(本机才会有的输入)。
 *
 * 为什么要这一半:`RADIUS` 里有一批**不入库**的输入(`archive/`、`reports/`、`runs/`、
 * `models.yaml`、`season.yaml`)。它们在开发者机器上存在、在干净克隆(CI)上不存在,于是一句
 * “每条规则指向的路径都必须 `existsSync`”就成了“本机有没有那份产物”的测量仪:本地永远绿、
 * CI 永远红。而删掉这些规则又会让本地输入不进选择(ADR-0038:表要让本地输入也进半径)。
 *
 * 判据因此分两档成立:在盘上,或者**被忽略规则覆盖**;两档都不是才是“脑补了一个目录”。
 * 第二种成立方式必须能证明——`archives/` 这种拼错的名字过不了这一关。
 *
 * `--no-index`:断言的是规则本身,不看索引状态(否则一个已被跟踪的占位符会永远“看起来没被
 * 忽略”)。退出码 0 = 命中,1 = 未命中;其它退出码(比如 git 本身跑不起来)一律抛错——**不静默
 * 折算成“未命中”**,那种折算正是让判据在 CI 上红的东西。同一份小小的判定在
 * `../version-control-boundary.test.ts` 里也有一份,那里断言的是“这些本地产物不入库”本身。
 *
 * 为什么还要试一次带尾斜线的写法:`.gitignore` 里的 `/archive/`、`reports/` 是**目录规则**,
 * 而一条不存在的路径在 git 眼里"不知道是不是目录"——`git check-ignore -- archive` 退出 1,
 * `-- archive/` 才命中。清克隆里恰好就是那条路径不存在的形状,不补这一次它照样会红。
 */
const ignoredByGit = (path: string): boolean => checkIgnore(path) || checkIgnore(`${path}/`);

/** 单次 `git check-ignore`:0 = 命中,1 = 未命中,其它一律抛错(不静默折算成“未命中”)。 */
const checkIgnore = (path: string): boolean => {
  const result = spawnSync("git", ["check-ignore", "--no-index", "-q", "--", path], {
    cwd: repoRoot,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git check-ignore 意外退出码 ${String(result.status)}:${String(result.stderr)}`);
};

const configText = (): string =>
  readFileSync(fileURLToPath(new URL("../../../../vitest.config.ts", import.meta.url)), "utf8");

describe("表:引用的脚本与路径都真实存在", () => {
  it.each([...ALWAYS, ...SUITES, "test:related", "check", "observe:inputs"])(
    "%s 在 package.json 里",
    (script) => {
      expect(manifest().scripts[script], `package.json 里没有 ${script}`).toBeDefined();
    },
  );

  it("规则里出现的 suite 都在 SUITES 里(没有偷偷多一个测试族)", () => {
    const allowed = new Set(SUITES);
    for (const rule of RADIUS) {
      for (const suite of rule.suites) {
        expect(allowed.has(suite), `${rule.area} 引用了未登记的测试族 ${suite}`).toBe(true);
      }
    }
  });

  it("每条规则指向的路径真实存在,或是一个被 .gitignore 覆盖的本机输入(拼错即红)", () => {
    const bogus = RADIUS.map((rule) => rule.area).filter(
      (area) => !existsSync(join(repoRoot, area)) && !ignoredByGit(area),
    );
    expect(
      bogus,
      `这些路径既不在盘上,也没被 .gitignore 覆盖——表里写了一个从来就不存在的地方:` +
        `\n  ${bogus.join("\n  ")}`,
    ).toEqual([]);
  });

  /**
   * 上面那条判据自己也要能红:一个“永远成立”的判据等于没写。
   *
   * 它同时把两向都钉住——盘上有的、被忽略规则覆盖的算存在;凭空写的名字不算。
   */
  it("判据本身分得出三档:盘上有的、被忽略覆盖的、凭空写的名字", () => {
    expect(ignoredByGit("no-such-area-from-nowhere")).toBe(false);
    expect(existsSync(join(repoRoot, "packages/tools/src/scope"))).toBe(true);
    // `archive/` 在干净克隆里不存在(CI 就是这个形状),但它是被规则覆盖的本机输入。
    expect(ignoredByGit("archive") || existsSync(join(repoRoot, "archive"))).toBe(true);
  });

  it("每条规则都写了 why(读的人不必翻代码就能判断它该不该改)", () => {
    for (const rule of RADIUS) {
      expect(rule.why.length, `${rule.area} 的 why 太短,等于没写`).toBeGreaterThan(10);
    }
  });
});

describe("覆盖:仓库没有盲区", () => {
  it("根目录每个条目都被覆盖(新增顶层目录即红)", () => {
    const covered = new Set([...RADIUS.map((rule) => rule.area), ...IGNORED_AREAS]);
    // `apps` / `packages` 由下一条断言覆盖:它们的每个子包都必须有可映射的编译目录。
    const workspaceRoots = new Set(["apps", "packages"]);
    const uncovered = readdirSync(repoRoot, { withFileTypes: true })
      .map((entry) => entry.name)
      .filter(
        (name) =>
          !workspaceRoots.has(name) &&
          !covered.has(name) &&
          ![...covered].some((area) => area.startsWith(`${name}/`)),
      );
    expect(uncovered, `这些顶层条目没有规则:${uncovered.join(", ")}`).toEqual([]);
  });

  it("apps/ 与 packages/ 下的每个包都能进依赖图(有 tsconfig 的 rootDir/outDir)", () => {
    for (const parent of ["apps", "packages"]) {
      for (const child of readdirSync(join(repoRoot, parent))) {
        const dir = `${parent}/${child}`;
        expect(
          workspaces.some((workspace) => workspace.dir === dir),
          `${dir} 没有可映射的编译目录:它的源码改动进不了依赖图,选择器会静默少选`,
        ).toBe(true);
      }
    }
  });

  it("只产声明的包(packages/tools)只映射到 .d.ts,不许映射出不存在的 .js", () => {
    const tools = workspaces.find((workspace) => workspace.dir === "packages/tools");
    expect(
      tools?.emitDeclarationOnly,
      "packages/tools 的 emitDeclarationOnly 变了,映射要跟着改",
    ).toBe(true);
    const outputs = buildOutputsOf("packages/tools/src/scope/change-radius.ts", workspaces);
    expect(outputs).toEqual(["packages/tools/dist/scope/change-radius.d.ts"]);
  });

  it("每个包的源码都能映射到产物(映射是空的那条边就是断的)", () => {
    for (const workspace of workspaces) {
      const probe = `${workspace.dir}/${workspace.rootDir}/index.ts`;
      expect(
        existsSync(join(repoRoot, probe)),
        `${workspace.dir} 没有 ${workspace.rootDir}/index.ts`,
      ).toBe(true);
      expect(buildOutputsOf(probe, workspaces).length, `${probe} 映射不出产物`).toBeGreaterThan(0);
    }
  });
});

describe("decide:图与表各管半边", () => {
  it("只改散文时,一步测试都不用跑", () => {
    const decision = decideOn(["docs/hld.md"]);
    expect(decision.scripts).toEqual([...ALWAYS]);
    expect(decision.graphFiles).toEqual([]);
  });

  it("改引擎源码时交给图,并把源码与两个产物都递过去", () => {
    const decision = decideOn(["packages/engine/src/runner/quickjs.ts"]);
    expect(decision.scripts).toEqual([...ALWAYS]);
    expect(decision.graphFiles).toEqual([
      "packages/engine/dist/runner/quickjs.d.ts",
      "packages/engine/dist/runner/quickjs.js",
      "packages/engine/src/runner/quickjs.ts",
    ]);
  });

  it("改 tools 时额外跑门禁自测(它住在独立 project 里,图选不到)", () => {
    const decision = decideOn(["packages/tools/src/index.ts"]);
    expect(decision.scripts).toContain("test:gates");
    expect(decision.graphFiles.length).toBeGreaterThan(0);
  });

  it("改规则取值时跑真 VM 那一族(数据文件进不了图)", () => {
    const decision = decideOn(["rulesets/basic.json"]);
    expect(decision.scripts).toEqual([...ALWAYS, "test:vm"]);
    expect(decision.graphFiles).toEqual([]);
  });

  it("改依赖锁定文件时保守到全量", () => {
    expect(decideOn(["pnpm-lock.yaml"]).scripts).toEqual([...ALWAYS, "test:all"]);
  });

  it("多个路径取并集,顺序稳定(ALWAYS 先,其余按 SUITES)", () => {
    const decision = decideOn([
      "packages/tools/src/index.ts",
      "docs/hld.md",
      "rulesets/basic.json",
    ]);
    expect(decision.scripts).toEqual([...ALWAYS, "test:vm", "test:gates"]);
  });

  it("全量被选中时把它的子集收掉(同一批文件不该跑第二遍)", () => {
    const decision = decideOn([
      "pnpm-lock.yaml",
      "rulesets/basic.json",
      "packages/tools/src/index.ts",
    ]);
    expect(decision.scripts).toEqual([...ALWAYS, "test:gates", "test:all"]);
  });

  it("产物不在盘上时退回全量,而不是照旧少选", () => {
    const decision = decide({
      paths: ["packages/engine/src/runner/quickjs.ts"],
      workspaces,
      exists: () => false,
    });
    expect(decision.notBuilt.length).toBe(2);
    expect(decision.scripts).toEqual([...ALWAYS, "test:all"]);
  });

  /**
   * **删除的文件没有产物可言。**
   *
   * `notBuilt` 问的是"还在的文件跟上构建了吗",而删除的文件的产物永远不会出现——拿它去
   * 触发退回全量,得到的是一个没有事实支撑的 `test:all`(本分支删掉三份 `landing-gate` 时实测:
   * `radius: test:all`)。它与 `总会问"有没有测试候选"` 是同一个根因的两面:**删除不是改动**。
   *
   * 三条断言盯三个方向:删除不进 `notBuilt`;`M` / `A` 的产物缺失**仍然**进(不能把"没构建"
   * 整类放过);删了又建不算删除(它仍有行为,产物照旧必须存在)。
   */
  it("删除的条目不进 `notBuilt`(删一个源码文件不该把计划退回全量)", () => {
    const gone = "packages/engine/src/runner/quickjs.ts";
    const decision = decide({ paths: [gone], workspaces, exists: () => false, deleted: [gone] });
    expect(decision.notBuilt).toEqual([]);
    expect(decision.scripts).not.toContain("test:all");
  });

  it("反方向:`M` / `A` 的产物缺失仍然进 `notBuilt`(「没构建」整类不能被放过)", () => {
    const live = "packages/engine/src/runner/quickjs.ts";
    // 不传 `deleted` = 路径还在(修改/新增两种状态的形状相同:文件存在、产物缺失)。
    const decision = decide({ paths: [live], workspaces, exists: () => false });
    expect(decision.notBuilt.length).toBe(2);
    expect(decision.scripts).toContain("test:all");
  });

  it("删了又建不算删除:它仍有行为,产物照旧必须存在", () => {
    const rewritten = "packages/engine/src/runner/quickjs.ts";
    // 口径只有一份:删除集合由 `probeTargets` 算,这里递过去而不是另写一条过滤。
    const targets = probeTargets({
      entries: [
        { status: "D", path: rewritten },
        { status: "A", path: rewritten },
      ],
      files: [rewritten],
    });
    expect(targets.deleted).toEqual([]);
    const decision = decide({
      paths: [rewritten],
      workspaces,
      exists: () => false,
      deleted: targets.deleted,
    });
    expect(decision.notBuilt.length).toBe(2);
    expect(decision.scripts).toContain("test:all");
  });

  it("没登记的路径**抛错**而不是跳过(静默跳过等于假绿)", () => {
    expect(() => decideOn(["future-pkg/src/index.ts"])).toThrow(UnregisteredPathError);
  });

  it("前缀不会误吞相邻名字(apps/cli 不该吃掉 apps/cli-tools)", () => {
    expect(() => decideOn(["apps/cli-tools/src/index.ts"])).toThrow(UnregisteredPathError);
  });
});

describe("链的组成:编辑循环窄,收口宽", () => {
  it("默认 test 不含真 VM / 进程级 e2e(否则每次业务改动都付 290s 的账)", () => {
    const test = manifest().scripts["test"] ?? "";
    expect(test).not.toContain("--project e2e");
    expect(test).not.toContain("--project vm");
  });

  it("收口的 verify 走单池 test:all,不是默认 test", () => {
    // 三腿的顺序也是判据:便宜的先跑,红了就在两秒内退出,不会先跑完 70s 的测试。
    expect((manifest().scripts["verify"] ?? "").split(" && ")).toEqual([
      "node --run quick",
      "node --run gate:static",
      "node --run test:all",
    ]);
  });

  it("test:all 就是老的全量口径:all + property", () => {
    const all = manifest().scripts["test:all"] ?? "";
    expect(all).toContain("--project all");
    expect(all).toContain("--project property");
    // 分片不许混进来:那会把同一批文件跑第二遍。
    expect(all).not.toContain("--project unit");
    expect(all).not.toContain("--project e2e");
    expect(all).not.toContain("--project vm");
  });

  it("收口用的 all 项目没有排除 e2e / vm", () => {
    const config = configText();
    const start = config.indexOf('name: "all"');
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = config.slice(start);
    const next = rest.indexOf('name: "', 10);
    const block = next < 0 ? rest : rest.slice(0, next);
    expect(block).not.toContain("E2E_TESTS");
    expect(block).not.toContain("VM_TESTS");
  });

  it("每个 project 都至少被一条命名脚本覆盖", () => {
    const config = configText();
    const projects = [...config.matchAll(/name: "([a-z]+)"/g)].map((match) => match[1] ?? "");
    expect(projects.length).toBeGreaterThan(5);
    const scripts = manifest().scripts;
    for (const project of projects) {
      const covered = Object.entries(scripts).some(
        ([name, command]) =>
          (name.startsWith("test") || name.startsWith("verify")) &&
          command.includes(`--project ${project}`),
      );
      expect(covered, `没有任何 test*/verify* 脚本会跑 project ${project}`).toBe(true);
    }
  });
});

/**
 * 观测 map(ADR-0038 第三条)自己的判据。
 *
 * 它盯的是这个机制**还活着**,以及它记下的东西**都能被解释**。后一条比它看起来重要:map 是
 * 判据的输入,一条无法解释的输入意味着选择器对它是瞎的——而"瞎"的表现是少跑,不是报错。
 * 换句话说,这条断言把「我没想到的第四类输入」从"不可能发现"变成"下一次录就红"。
 */
describe("观测 map:它自己也要有判据", () => {
  const map = loadInputsMap(repoRoot);
  const inputs = [...new Set(Object.values(map.files).flat())];

  it("map 非空,且键都是仓库里真实存在的测试文件(空 map 等于观测没接上)", () => {
    const keys = Object.keys(map.files);
    expect(
      keys.length,
      "观测 map 是空的:recorder 没装上,或 execArgv 没接进 worker",
    ).toBeGreaterThan(20);
    expect(inputs.length, "一条输入都没记到,观测没有实际作用").toBeGreaterThan(50);
    const missing = keys.filter((key) => !existsSync(join(repoRoot, key)));
    expect(missing, `这些键不是真实的测试文件:${missing.join(", ")}`).toEqual([]);
  });

  it("每个被观测到的输入都能被选择器解释(没有第四类输入)", () => {
    const unexplained: string[] = [];
    for (const input of inputs) {
      try {
        decide({ paths: [input], workspaces, exists: built });
      } catch {
        unexplained.push(input);
      }
    }
    expect(
      unexplained,
      "这些输入被读到过,但选择器对它们没有说法——加一条 RADIUS 规则或让它能被映射:" +
        unexplainable(unexplained),
    ).toEqual([]);
  });

  it("map 里没有混进产物路径(报告与对局产物不是输入)", () => {
    expect(inputs.filter((input) => !isInputPath(input))).toEqual([]);
  });

  it("recorder 挂在 worker 的 execArgv 上(拆掉它 map 会静默变空)", () => {
    const config = configText();
    expect(config, "worker 的 execArgv 没接上 recorder").toContain("execArgv: RECORD_EXEC_ARGV");
    expect(config, "recorder 的装载位置不在 config 里").toContain("RECORD_SETUP");
    expect(config, "收口那次跑(all)必须带录制开关").toContain("RECORD_EXEC_ARGV");
  });

  /**
   * **快照过期即红**(票 T6)。指纹对不上时不许继续拿旧 map 判"有没有观测":旧 map 的
   * 失效方向是少记,而少记读出来就是"没人看这块"——两个完全不同的红混成一条。
   *
   * 第一条断言同时是**入库快照的新鲜度门禁**:改了 `WATCHED_FILES` 里的任一装配点
   * (recorder / setup / `vitest.config.ts` / 聚合口径 / 录制口径)就必须重录,
   * 不重录这里就红(并且消息里直接给出两条命令)。
   *
   * 它唯一不跑的情形是**正在录制**(`observe:inputs` 自己跑的那趟 `test:all`):那一刻正在
   * 被写的就是它要断言的那份快照。这不是把红改成跳过——录制结束后同一条断言在 `test`、
   * `check` 上照样跑,而"没重录"的后果仍会以上面那两条命令的形式回来。
   */
  it("快照过期即红:消息里有两个指纹与两条重录命令", () => {
    const current = currentFingerprint(repoRoot);
    if (process.env["MODELWAR_TEST_INPUTS_FILE"] === undefined) {
      expect(
        snapshotStaleMessage({ map, fingerprint: current }),
        `入库快照与现在的观测仪器对不上:重录 \`node --run observe:inputs:accept\``,
      ).toBeUndefined();
    }
    const stale = snapshotStaleMessage({ map, fingerprint: "deadbeefdeadbeef" }) ?? "";
    expect(stale).toContain("deadbeefdeadbeef");
    expect(stale).toContain(map.fingerprint);
    expect(stale).toContain("node --run observe:inputs:accept");
    expect(stale).toContain("node --run observe:inputs");
    // 空指纹(旧快照)一样过期:"没说清"不许被当成"大概没事"。
    expect(
      snapshotStaleMessage({ map: { ...map, fingerprint: "" }, fingerprint: current }),
      "空指纹被当成新鲜快照了",
    ).toBeDefined();
  });
});

/**
 * **结构测试不是行为证据**(票 T6)。
 *
 * `dependency-boundary.test.ts` 这类测试读 `dist`、spawn depcruise,断言的是**别的文件的
 * 形状**(依赖方向、文档归属、版本边界)。在"这个改动的测试候选里有没有人看着行为"这个问题
 * 上它们不算数:记成"有候选"等于用一张图纸证明一栋楼。
 *
 * 这里盯的是 `check.ts` 的**判定表**(`unobservedGap`——它直接跑上红线):结构测试那一条
 * 必须给出"只有结构测试被选中"并点名缘由,而且不能有任何一种红悄悄返回 `undefined`、从
 * 而在 `main` 里变成绿。
 */
describe("结构测试不算行为证据", () => {
  it("只有结构测试被选中 → 上红线,消息点名那是别的文件的形状", () => {
    const structural = STRUCTURAL_TESTS[0] ?? "";
    const gap = unobservedGap("packages/engine/src/runner/quickjs.ts", {
      kind: "structural-only",
      structural: [structural],
    });
    expect(gap).toBeDefined();
    expect(gap?.why).toContain("只有结构测试被选中");
    expect(gap?.why).toContain("别的文件的形状");
    // 点名是哪一个:不点名的话读的人只看到一条抽象的红。
    expect(gap?.why).toContain(structural);
  });

  it("真跑过就不登记;确知为零 / 全 skip 都算红(只有 `ran` 是绿)", () => {
    expect(
      unobservedGap("x.ts", { kind: "ran", behavior: ["a.test.ts"], structural: [], tests: 3 }),
    ).toBeUndefined();
    expect(unobservedGap("x.ts", { kind: "no-tests" })).toBeDefined();
    expect(unobservedGap("x.ts", { kind: "all-skipped", files: ["a.test.ts"] })).toBeDefined();
  });
});

/**
 * 红线自己也要有出路。
 *
 * 「改动无人观测即红」只在两种情况下可执行:债务表在它指向的位置,且每条登记的路径都真实存在。
 * 否则 agent 拿到一条红、按提示去登记、却发现那张表根本不存在——这比不红更坏。
 */
describe("未覆盖红线:红要有出路", () => {
  const debt = (): readonly string[] => {
    const text = readFileSync(join(repoRoot, "coverage-debt.txt"), "utf8");
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => (line.split("#")[0] ?? "").trim());
  };

  it("coverage-debt.txt 存在,且登记的路径都真实存在", () => {
    expect(existsSync(join(repoRoot, "coverage-debt.txt"))).toBe(true);
    const stale = debt().filter((path) => !existsSync(join(repoRoot, path)));
    expect(stale, `债务表里有不存在的路径(表自己腐烂了):${stale.join(", ")}`).toEqual([]);
  });

  it("开了 mustObserve 的规则,map 里都有观测到它(否则第一次改就红且无解)", () => {
    const map = loadInputsMap(repoRoot);
    const observed = new Set(Object.values(map.files).flat());
    const blind = RADIUS.filter((rule) => rule.mustObserve === true).filter(
      (rule) =>
        ![...observed].some((path) => path === rule.area || path.startsWith(`${rule.area}/`)),
    );
    expect(
      blind.map((rule) => rule.area),
      `这些规则要求必须观测,但 map 里一条都没有——红线会立刻误伤`,
    ).toEqual([]);
  });

  it("`check` 只有一条命令,没有并列的第二档", () => {
    const scripts = manifest().scripts;
    expect(scripts["check"], "check 是 agent 唯一入口").toBeDefined();
    expect(scripts["check:full"], "档位不该以脚本形式存在(--full 才是收口)").toBeUndefined();
    expect(scripts["verify:scoped"], "旧名字仍在:agent 会看到两个入口").toBeUndefined();
  });
});

/**
 * **删除不是改动:探针与图对它都无话可说。**
 *
 * 删除的路径按 ChangeSet 的语义**留在**集合里(状态 `D`,见 `change-set.ts`):它参与选择,否则
 * "改了什么"就少了一块。但它不能进逐文件探针：`vitest related` 问的是一个**已不存在的文件**,
 * 答不出任何东西;而探针这一层只承认"确知为零"与"确知跑过",答不出 = 红。于是每一次删文件都会
 * 拿到一条假红,而假红的处方是"给一个已删掉的文件补用例"——做不到,也不应该做。
 *
 * 删除要保的性质是另一条:**没带走没人发现的依赖**。它由 `tsc -b` 与全量测试兜——两者都是
 * "删了就在原地喊"的形状,不需要有人预先知道这个文件被谁用。
 *
 * 四条断言盯三个方向:删除不进探针也不进 gap（否则假红）;说明行真的出现并点明由谁兜
 * (静默跳过与"没人观测"在输出上是同一句话);以及**反方向**——只放行 `D`,`M` / `A` / `R`
 * 的未观测仍然红。没有最后一条,这条口径就会从"删除没有行为"滑成"不知道的都放过"。
 */
describe("删除:探针与图都无话可说", () => {
  const GONE = "packages/tools/src/gate/landing-gate.ts";
  const entry = (status: ChangeEntry["status"], path: string, from?: string): ChangeEntry =>
    from === undefined ? { status, path } : { status, path, from };

  it("删除的路径进 `deleted` 而不进探针清单(不进探针就没有 gap:假红在这一层被挡住)", () => {
    const targets = probeTargets({ entries: [entry("D", GONE)], files: [GONE] });
    expect(targets.probe).toEqual([]);
    expect(targets.deleted).toEqual([GONE]);
    // gaps 的唯一来源是探针对每个**未观测文件**问出来的结论。把它走一遍:
    const gaps = targets.probe.filter(
      (path) => unobservedGap(path, { kind: "no-tests" }) !== undefined,
    );
    expect(gaps, `删除的路径进了 gaps(删掉的文件答不出用例数,这不是"没人观测")`).toEqual([]);
  });

  it("说明行必须出现且点名路径 + 点明由 `tsc -b` 与全量测试兜(不静默跳过)", () => {
    const note = probeTargets({ entries: [entry("D", GONE)], files: [GONE] }).note;
    expect(note).toContain(GONE);
    expect(note).toContain("tsc -b");
    expect(note).toContain("全量测试");
    // 没有删除时不许凭空多出一行:说明行只描述真实存在的那几条。
    expect(describeDeleted([])).toBe("");
    expect(probeTargets({ entries: [entry("M", GONE)], files: [GONE] }).note).toBe("");
  });

  it("反方向:`M` / `A` 的未观测仍然红(删除的口径只对 `D`)", () => {
    for (const status of ["M", "A"] as const) {
      const targets = probeTargets({ entries: [entry(status, GONE)], files: [GONE] });
      expect(targets.probe, `${status} 被当成删除了`).toEqual([GONE]);
      expect(targets.deleted).toEqual([]);
      expect(targets.note).toBe("");
      // 它进了探针清单,探针答"零候选"就上红线。
      expect(unobservedGap(GONE, { kind: "no-tests" })).toBeDefined();
    }
  });

  it("删了又建回来 / 重命名的旧侧仍有行为可问,照常探(豁免不能漏成少跑)", () => {
    const targets = probeTargets({
      entries: [
        entry("D", "a/rewritten.ts"),
        entry("A", "a/rewritten.ts"),
        entry("R", "a/renamed.ts", "a/original.ts"),
        entry("D", "a/really-gone.ts"),
      ],
      files: ["a/original.ts", "a/really-gone.ts", "a/renamed.ts", "a/rewritten.ts"],
    });
    expect(targets.probe).toEqual(["a/original.ts", "a/renamed.ts", "a/rewritten.ts"]);
    expect(targets.deleted).toEqual(["a/really-gone.ts"]);
  });
});

/**
 * 门禁自测的**粒度**。
 *
 * `gates` project 只含一个文件(`gates.test.ts`,89 条 / 实测 166s),所以"改了什么 → 跑哪几族"
 * 在 project 层面是 0/1,真正的粒度只能来自**用例名过滤**(`-t`)。用例名以门禁名开头,于是
 * 「改哪个实现文件 → 哪一批用例」是一条可数的对应关系(`GATES_CASES`)。这组断言盯三件:
 *
 * - **选择器自身不进 gates**:它的判据(`test-layers` / `plan` / `change-set`)住在 `unit` 池子里,
 *   依赖图能选中它。补上 166s 不是"更稳",是把"改判据"变成"不敢改判据"。
 * - **改某道门禁只跑它的那几条**:实测 `-t "禁浮点门禁"` = 2 条 / 6.79s。
 * - **模式必须真的命中**:`-t` 是名字过滤,改了用例名的措辞,模式就静默失效——而失效的表现是
 *   **少跑**。所以这里拿每个模式去数一遍真实的 `it("…")`,0 命中即红。
 */
describe("门禁自测的粒度:按文件缩到 -t 子集", () => {
  const GATES_TEST = "packages/tools/src/gates.test.ts";

  /**
   * `gates.test.ts` 里的用例名。只认**行首**的 `it("…")`:文件里还嵌着一批探针源码字符串
   * (例如测试纪律那几条的假用例),它们不是本文件的用例,数进来会让死模式混过去。
   */
  const caseNames = (): readonly string[] =>
    [...readFileSync(join(repoRoot, GATES_TEST), "utf8").matchAll(/^it\("([^"]*)"/gmu)].map(
      (match) => match[1] ?? "",
    );

  it("改选择器自身完全不进 gates(判据在 unit 池子里,图能选中)", () => {
    const decision = decideOn(["packages/tools/src/scope/check.ts"]);
    expect(decision.scripts).not.toContain("test:gates");
    expect(decision.gatesPatterns).toEqual([]);
  });

  it("改某道门禁只跑它的 -t 子集(实测 2 passed | 87 skipped,整族 89 条)", () => {
    const decision = decideOn(["packages/tools/src/gate/no-float-gate.ts"]);
    expect(decision.scripts).toContain("test:gates");
    expect(decision.gatesPatterns).toEqual(["禁浮点门禁"]);
  });

  it("公共基础设施映射不出模式 → 整族(不知道影响哪几条,就一条不少地跑)", () => {
    const decision = decideOn(["packages/tools/src/gates-harness.ts"]);
    expect(decision.scripts).toContain("test:gates");
    expect(decision.gatesPatterns).toEqual([]);
  });

  it("GATES_CASES 的每条路径真实存在,且每条都给了至少一个模式", () => {
    const entries = Object.entries(GATES_CASES);
    expect(entries.length, "GATES_CASES 空了:门禁自测又退回整族").toBeGreaterThan(0);
    const missing = entries
      .map(([path]) => path)
      .filter((path) => !existsSync(join(repoRoot, path)));
    expect(missing, `GATES_CASES 指向了不存在的文件:${missing.join(", ")}`).toEqual([]);
    const empty = entries.filter(([, patterns]) => patterns.length === 0).map(([path]) => path);
    expect(empty, `这些文件映射到了空模式(空 = 整族,等于白写):${empty.join(", ")}`).toEqual([]);
  });

  it("每个模式都真的命中 gates.test.ts 的用例,且不是命中全部(0 命中 = 静默少跑)", () => {
    const names = caseNames();
    // 抽不出名字时下面两条会"空数组相等"地静默成立,所以先钉住样本量。
    expect(names.length, `没从 ${GATES_TEST} 抽出用例名`).toBeGreaterThan(50);
    const patterns = [...new Set(Object.values(GATES_CASES).flat())].sort();
    const dead = patterns
      .filter((pattern) => !names.some((name) => new RegExp(pattern, "u").test(name)))
      .map((pattern) => `死模式(0 命中):${pattern}`);
    expect(dead, dead.join("; ")).toEqual([]);
    // 一个命中全部用例的模式等于没缩:它只会让人以为"缩过了"。
    const broad = patterns
      .filter((pattern) => names.every((name) => new RegExp(pattern, "u").test(name)))
      .map((pattern) => `命中全部用例的模式:${pattern}`);
    expect(broad, broad.join("; ")).toEqual([]);
  });

  /**
   * **没有文件级 `-t` 归属的用例。**
   *
   * 上一条断言只验了一个方向:「每个模式都命中至少一条用例」。反方向当时是空的:在
   * `gates.test.ts` 里新增一条**不带门禁名前缀**的用例,再改它测的那道门禁,只会跑旧子集,
   * 没有任何东西会红——少跑的那一条永远不响。
   *
   * 所以每条用例必须落在两边之一:**命中至少一个 `GATES_CASES` 模式**,或者**登记在这张
   * 名单里并写清为什么没有归属**。新增一条未归类的用例 → 红,逼人做一次判断:
   * 给它一个模式(改某道门禁时只跑那几条),还是承认它是族级/整链的东西(改它时整族跑)。
   *
   * 名单的每一条都要有一个**说得出来的理由**,理由按家族写(同族的多条用例共享一句):
   * 家族之间没有归属的原因不一样,而按条复制同一句只会让人去猜哪句是真的。
   */
  const UNATTRIBUTED_CASES: readonly {
    readonly why: string;
    readonly titles: readonly string[];
  }[] = [
    {
      why: "链路:被测试物是「整条命名脚本在空壳上退出 0」,映射不到一个实现文件——它跑的就是 package.json 里的链",
      titles: [
        "quick(格式 + lint + 工具版本耦合)在空壳上退出 0",
        "gate:types(quick + tsc -b + 类型感知 lint)退出 0",
        "gate:deps(依赖门禁)退出 0,且报告的巡航规模不为零",
        "test:property(长时属性测试)退出 0",
      ],
    },
    {
      why: "外部命令:被测试物是仓库外的工具(oxfmt / oxlint / tsc / depcruise)与它们的配置,缩不缩文件都落在同一道门禁里",
      titles: [
        "依赖门禁:engine 一旦 import runner 或 gen 就红,撤掉即绿",
        "依赖门禁:runner 一旦 import engine 就红,撤掉即绿",
        "依赖门禁:gen 一旦 import engine / runner / replay 就红,撤掉即绿",
        "依赖门禁:engine 运行时一旦 import 第二个内建模块就红,撤掉即绿",
        "格式门禁:未格式化的文件被拦下,由 oxfmt 修好后放行",
        "参赛脚本的编译配置在格式门禁的覆盖范围内:它排版坏掉就红,按字节还原 → 绿",
        "lint 门禁:被禁写法被拦下,改正后放行",
        "类型感知门禁:tsc 编得过的类型级违规让 gate:types 红,撤掉即绿",
      ],
    },
    {
      why: "oxlint 插件规则:被测试物是 packages/tools/src/rules/ 下的一整套规则,不是单道门禁实现",
      titles: [
        "测试纪律门禁:集中测试 / 禁用测试 / 用例体内无断言各自变红,还原后放行",
        "测试纪律门禁:断言写在用例体之外 → 变红(它属于每条用例的前提时除外)",
        "测试纪律门禁:抛了异常但不检查消息变红,补上期望消息后放行",
        "条件跳过(skipIf / runIf)的现有用法不被测试纪律的三条规则命中",
      ],
    },
    {
      why: "生成器与生成物:一次改动同时涉及生成器、真源与产物树,按实现文件缩只会给出错的安全感",
      titles: [
        "生成物漂移检查:改真源不重跑 → 变红,重跑并提交 → 变绿",
        "生成物漂移检查:生成物被删 → 变红,还原 → 变绿",
        "生成物漂移检查:生成物被手改 → 变红,按字节还原 → 变绿",
        "生成物漂移检查:新增一件生成物但没进版本库 → 变红",
        "生成物漂移检查:工作树里有与生成物无关的未提交内容时不误报",
        "生成物漂移检查挂在全量门禁末尾,且不进快门禁",
        "生成物漂移检查:区块形态——改正文、删整段、改标记都判红,改散文不管",
        "生成器:区块正文被手改后重跑 → 填回去且不动散文;标记没了则拒绝硬填",
        "生成物漂移检查:规则文档数值表——改取值不重跑 → 变红,两份文档同时说话,还原 → 变绿",
        "生成物漂移检查:手改数值表区块正文 → 变红,手改表外散文 → 内容判定沉默,还原 → 变绿",
        "生成物漂移检查:API 表区块——改真源不重跑 → 变红,手改区块正文 → 变红,还原 → 变绿",
      ],
    },
    {
      why: "散文真源:被测试物是整仓散文与 rules-doc-prose.ts 两处,表里没有它的文件级映射(改它时整族跑,方向是多跑)",
      titles: [
        "散文禁抄取值门禁:静态陈述变红,还原变绿",
        "散文禁抄取值门禁:变更记账(旧值 → 新值)放行",
        "散文禁抄取值门禁:抽不出参数名时按失败处理(空转反例)",
        "散文禁抄取值门禁挂在 gate:static,且没被挪进按需 / 慢链",
      ],
    },
    {
      why: "入库产物与自证:门禁比对的另一半是磁盘上的产物 / 清单,失败点常在产物侧而不在实现文件侧;且它们按需或挂在全量末尾,不进常跑链",
      titles: [
        "基准产物门禁:入库的产物与源码分叉 → 变红,按字节还原 → 变绿",
        "基准产物门禁挂在全量门禁末尾,且不进快门禁",
        "runtime bundle 门禁:手改入库产物一个字节 → 红,按字节还原 → 绿",
        "runtime bundle 门禁挂在全量门禁末尾,且不进快门禁",
        "rootfs 门禁:清单与磁盘双向比对(少一份红、多一份也红、还原即绿)",
        "契约自证门禁按需跑:不在 check 里,但有独立入口与反例覆盖",
      ],
    },
    {
      why: "分层事实:断言的是 vitest.config.ts 的 project 划分——一份配置,不是某个门禁实现",
      titles: [
        "gates 不在 unit 的拾取范围里(否则 check 会套娃成叉炸弹)",
        "真 bwrap 的用例不在常跑入口上(sandbox project)",
        "慢的那一半(slow project)不被任何常跑入口拾取",
      ],
    },
    {
      why: "版本耦合:被测试物是 toolchain-coupling.ts 与仓库根的版本钉,表里没有这条文件级映射",
      titles: ["工具版本耦合断言:配套为 0,错位为 1"],
    },
    {
      why: "变异与扫描:被测试物是 stryker 配置、入库基线与几个只在按需入口上的脚本",
      titles: [
        "Stryker 分片清单与配置同名:已播种的片有入库基线与串了棘轮门禁的入口脚本",
        "engine-processor 分片仍限定结算管线,且棘轮不设绝对阈值",
        "属性测试(*.prop.ts)不进任何分片的变异范围:它们是测试,不是生产代码",
        "抬基线命令在场,但不在任何流水线、常跑入口、末尾复核组与变异入口上",
        "变异诊断入口在场,但不在任何常跑入口与流水线上,且不改判据",
        "测试纪律规则的诊断入口在场,但不在任何常跑入口与流水线上,且不改判据",
        "三个观测入口都在场,但不在任何常跑入口与流水线上,且不改判据",
        "反例:抬基线命令被塞进 quick → 断言红,还原 → 绿(纯文本,不真改 package.json)",
        "跑完变异入口的棘轮比较后,入库基线的字节不变",
        "真实跑一次 mutate:replay 之后,stryker/baseline/replay.json 的字节逐字不变",
        "抬基线命令:缺分片非零、未知分片非零、已知分片只写临时路径、空转报告拒绝入基线",
        "抬基线命令只抬本分片:指到别的分片的基线上 → 非零,且那份文件原样不动",
        "棘轮门禁:低一分夹具 → 红,等于/高于 → 绿,无基线 → 首次,判不了 → 红",
      ],
    },
  ];

  it("反方向:每条用例要么命中一个模式,要么登记在「没有归属」名单里", () => {
    const names = caseNames();
    expect(names.length, `没从 ${GATES_TEST} 抽出用例名`).toBeGreaterThan(50);

    // 模式引自表,不在这里另拄一份:上一条断言已经验过它们都活着。
    const patterns = [...new Set(Object.values(GATES_CASES).flat())].sort();

    // 名单本身不许腐烂:非空、每组都写了理由、组内非空、没有重复登记。
    expect(UNATTRIBUTED_CASES.length, "名单空了:这条断言会静默成立").toBeGreaterThan(0);
    const registered: string[] = [];
    for (const group of UNATTRIBUTED_CASES) {
      expect(group.why.length, "有一条理由等于没写").toBeGreaterThan(10);
      expect(group.titles.length, `${group.why} 下面一条用例都没有`).toBeGreaterThan(0);
      registered.push(...group.titles);
    }
    const duplicated = registered.filter((title, index) => registered.indexOf(title) !== index);
    expect(duplicated, `这些用例被登记了两次:${duplicated.join(", ")}`).toEqual([]);

    // 登记的名字必须真的存在于用例集合里:改名 / 删用例之后留下的幽灵条目会让人以为它还被盯着。
    const ghosts = registered.filter((title) => !names.includes(title));
    expect(ghosts, `名单里的这些用例在 ${GATES_TEST} 里不存在:${ghosts.join(", ")}`).toEqual([]);

    // 反方向的主体:漏一条新的未归类用例,这里就红。
    const matches = (name: string): boolean =>
      patterns.some((pattern) => new RegExp(pattern, "u").test(name));
    const unclassified = names.filter((name) => !matches(name) && !registered.includes(name));
    expect(
      unclassified,
      "这些用例既没命中任何 -t 模式,也没登记为「没有归属」——改对应的门禁实现时它们不会被执行:" +
        `\n  ${unclassified.join("\n  ")}`,
    ).toEqual([]);

    // 反向的反向:登记成"没有归属"却已经被某个模式命中 = 名单里的一句假话,该删掉。
    const stale = registered.filter(matches);
    expect(stale, `这些用例其实已经有 -t 归属了,从名单里删掉:${stale.join(", ")}`).toEqual([]);
  });

  it("计划里真的带上了模式(runsFor 把它填进 RunItem,执行时才变成 -t)", () => {
    const scripts = manifest().scripts;
    const gatesOf = (paths: readonly string[]) =>
      runsFor({ scripts, decision: decideOn(paths) }).filter((item) => item.kind === "gates");
    expect(gatesOf(["packages/tools/src/gate/no-float-gate.ts"])).toEqual([
      { kind: "gates", patterns: ["禁浮点门禁"] },
    ]);
    expect(gatesOf(["packages/tools/src/gates-harness.ts"])).toEqual([
      { kind: "gates", patterns: [] },
    ]);
  });

  it("多道门禁同时命中时取模式并集(并集 ⊇ 每一条,不会比单文件少跑)", () => {
    const decision = decideOn([
      "packages/tools/src/gate/no-float-gate.ts",
      "packages/tools/src/gate/budget-gate.ts",
    ]);
    expect(decision.gatesPatterns).toEqual(["禁浮点门禁", "预算结构门禁"]);
  });
});

/**
 * **测试文件的归属:配置说了算,不是目录说了算。**
 *
 * 兜底规则(`packages/tools` → `test:gates`)曾经连测试文件一起吞:改一行 `ci.test.ts`——
 * 它 import 的是 `./scope/check.ts`,是**选择器自己的 CI 判据**——就要重跑 89 条 / 166s 的
 * 门禁自测。而这类文件的判据就是它自己:`vitest related` 会把它选出来(实测 `ci.test.ts` →
 * 1 个文件 / 17 条 / 1.06s)。
 *
 * 判据不在目录名里,在 `vitest.config.ts` 的 project 划分里。所以这里的对账**从配置推导**:
 * 哪些测试文件被 `all` project 拾取(→ 图看得见,兜底豁免),哪些没有(→ 图看不见,仍由兜底
 * 补整族)。手写的那份清单(`GRAPH_BLIND_TESTS`)是输入,不是判据。
 *
 * 为什么**不**用 `packages/tools/src/*.test.ts` 这种前缀通配一把扫:`gates.test.ts` 与
 * `gates-slow.test.ts` 恰好也在这个前缀下,它们分别属于 `gates` / `slow` project,被 `all`
 * 显式排除。一网打尽的后果是改门禁自测自己时一条都不跑——那是**少跑**,比多跑坏得多。
 */
describe("测试文件的归属:配置说了算,不是兜底说了算", () => {
  type ProjectConfig = {
    readonly name: string;
    readonly include: readonly string[];
    readonly exclude: readonly string[];
  };

  /**
   * `vitest.config.ts` 的 project 表。**import 它而不是抄它的文本**:`include` / `exclude` 里的
   * 常量(`GATES_TEST`、`E2E_TESTS`…)在这一步已经求值,抄文本就是抄第二份判据。
   */
  const projectsOf = async (): Promise<readonly ProjectConfig[]> => {
    // specifier 放在变量里:根配置不在 `packages/tools` 这个编译单元里(rootDir 不含仓库根),
    // 而运行时的 Node 类型擦除直接执行它——仓库本来就是这么跑 `check.ts` 的。
    const specifier = pathToFileURL(join(repoRoot, "vitest.config.ts")).href;
    const loaded = (await import(specifier)) as {
      default: { test: { projects: readonly { test: ProjectConfig }[] } };
    };
    return loaded.default.test.projects.map((project) => project.test);
  };

  /** 配置说这个 project 拾取这个文件吗(include 命中且 exclude 不命中)。 */
  const picks = (project: ProjectConfig, file: string): boolean =>
    project.include.some((glob) => matchesGlob(file, glob)) &&
    !project.exclude.some((glob) => matchesGlob(file, glob));

  /** `packages/tools/src` 下所有测试文件(仓库相对、POSIX 分隔、已排序)。 */
  const toolsTestFiles = (): readonly string[] =>
    readdirSync(join(repoRoot, "packages/tools/src"), { recursive: true, encoding: "utf8" })
      .map((name) => name.split(sep).join("/"))
      .filter((name) => /\.(?:test|prop)\.ts$/u.test(name))
      .map((name) => `packages/tools/src/${name}`)
      .sort();

  const allProject = async (): Promise<ProjectConfig> => {
    const project = (await projectsOf()).find((candidate) => candidate.name === "all");
    expect(project, "vitest.config.ts 里没有 all project:这条断言的上游变了").toBeDefined();
    return project as ProjectConfig;
  };

  it("图看不见的测试文件清单,与 `all` project 的 include/exclude 一致(清单会腐烂,所以对账)", async () => {
    const all = await allProject();
    const derived = toolsTestFiles().filter((file) => !picks(all, file));
    expect(derived.length, "一个都没推出来:下面的对账会静默成立").toBeGreaterThan(0);
    expect(
      [...GRAPH_BLIND_TESTS].sort(),
      "GRAPH_BLIND_TESTS 与 `all` project 的拾取结果不一致(改 project 划分就得跟)",
    ).toEqual(derived);
  });

  it("图看得见的测试文件一律不走兜底(改它只跑它自己,不拖 89 条门禁自测)", async () => {
    const all = await allProject();
    const visible = toolsTestFiles().filter((file) => picks(all, file));
    expect(visible.length, "一个测试文件都没数到:这条断言会静默成立").toBeGreaterThan(20);
    // 反例本身就是本票的起因:`ci.test.ts` 是选择器的 CI 判据,却在兜底里。
    expect(visible, "ci.test.ts 不在 `all` 的拾取范围里了:归属判据要重新看").toContain(
      "packages/tools/src/ci.test.ts",
    );
    const dragging = visible.filter((file) => decideOn([file]).scripts.includes("test:gates"));
    expect(
      dragging,
      `这些测试文件还在拖门禁自测(它们自己的判据就是自己):${dragging.join(", ")}`,
    ).toEqual([]);
  });

  it("反方向:图看不见的测试文件仍被选中(豁免不能漏成少跑)", () => {
    const bare = new Set(["quick", "gate:static"]);
    const missing = GRAPH_BLIND_TESTS.filter(
      (file) => !decideOn([file]).scripts.some((script) => !bare.has(script)),
    );
    expect(missing, `这些文件改了就没人跑了:${missing.join(", ")}`).toEqual([]);
  });

  /**
   * **跑错族比少跑更陉。** `gates-slow.test.ts` 属于 `slow` project(nightly 的那一半),
   * 而兜底 (`packages/tools` → `test:gates`) 会把改它的人送去门禁自测:多跑 166s,而它自己
   * 一条都没跑。目标族**不手写**,从 `vitest.config.ts` 推导:拾取它的 project → 带那个
   * `--project` 的命名脚本。
   */
  it("gates-slow.test.ts 落到拾取它的 project 的入口,而不是门禁自测", async () => {
    const file = "packages/tools/src/gates-slow.test.ts";
    const projects = (await projectsOf()).filter((project) => picks(project, file));
    expect(
      projects.map((project) => project.name),
      "拾取它的 project 变了",
    ).toEqual(["slow"]);

    const scripts = manifest().scripts;
    const entries = Object.entries(scripts)
      .filter(
        ([name, command]) =>
          name.startsWith("test") &&
          projects.every(({ name: p }) => command.includes(`--project ${p}`)),
      )
      .map(([name]) => name);
    expect(
      entries.length,
      `没有任何脚本跑 project ${projects.map((p) => p.name).join(",")}`,
    ).toBeGreaterThan(0);

    const decision = decideOn([file]);
    expect(
      entries.some((entry) => decision.scripts.includes(entry)),
      `计划里没有拾取它的那一族(实际:${decision.scripts.join(", ")})`,
    ).toBe(true);
    // 反方向:不能顺手把它当门禁自测——那是跑错族,而跑错族不会报错。
    expect(decision.scripts).not.toContain("test:gates");
  });

  /**
   * **`sandbox` 族的测试文件**:表指名拾取它的那一族,探针不再问它。
   *
   * 缺任何一半都会退回「留一行债」的形状——只加族规则,探针照样拿 `--project all` 去问、
   * 答「0 条」,把「问错了池子」读成「没人看着它」;只豁免不加规则,则谁也不跑它自己那一族,
   * 改坏了没有任何声音。目标族名从 `vitest.config.ts` 推导,与上一条用同一份判据。
   */
  it.each(["apps/cli/src/gen-cli.test.ts", "apps/cli/src/agent-real-session.test.ts"])(
    "%s 落到拾取它的那一族,并退出逐文件探针",
    async (file) => {
      const projects = (await projectsOf()).filter((project) => picks(project, file));
      expect(
        projects.map((project) => project.name),
        "拾取它的 project 变了",
      ).toEqual(["sandbox"]);

      const entries = Object.entries(manifest().scripts)
        .filter(
          ([name, command]) =>
            name.startsWith("test") &&
            projects.every(({ name: project }) => command.includes(`--project ${project}`)),
        )
        .map(([name]) => name);
      expect(entries.length, `没有任何脚本跑 ${file} 所在的 project`).toBeGreaterThan(0);

      const decision = decideOn([file]);
      expect(
        entries.some((entry) => decision.scripts.includes(entry)),
        `计划里没有拾取它的那一族(实际:${decision.scripts.join(", ")})`,
      ).toBe(true);

      // 探针写死问 `--project all`:它答不出这个文件的候选,而 0 条会被读成「确知为零」。
      expect(probeApplies(file), `${file} 仍会进逐文件探针,而它不在 all 的池子里`).toBe(false);
      // 反方向:池子里的测试文件照旧问图——豁免只对池子外的那几族开。
      expect(probeApplies("packages/tools/src/ci.test.ts")).toBe(true);
    },
  );

  it("`decide([packages/tools/src/ci.test.ts])` 不含 test:gates(本票的起因)", () => {
    const decision = decideOn(["packages/tools/src/ci.test.ts"]);
    expect(decision.scripts).not.toContain("test:gates");
    // 归属是"交图",不是"什么都不跑":它的产物要递过去。
    expect(decision.graphFiles).toContain("packages/tools/src/ci.test.ts");
  });

  it("GATES_CASES 的每条都还活着(给测试文件写的映射是死条目,红)", () => {
    const dead = Object.keys(GATES_CASES).filter(
      (file) => !decideOn([file]).scripts.includes("test:gates"),
    );
    expect(dead, `这些映射永远不会生效(文件已被豁免或不再走兜底):${dead.join(", ")}`).toEqual([]);
  });
});
