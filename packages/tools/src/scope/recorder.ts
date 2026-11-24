/**
 * 测试输入的**观测器**(ADR-0038 第三条)。
 *
 * 为什么是观测而不是声明:依赖图只看得见 `import`。本仓最贵的那批用例读的是**路径**
 * ——`rulesets/*.json`、`maps/*.yaml`、wasm、`sandbox-rootfs/` 里的产物字节。这些输入
 * 在图上没有任何边,靠人列清单就会腐烂,而腐烂的方向是"少跑",少跑不报错。
 *
 * 观测的可信度来自一条性质:**凡是真正被读到的东西都会留下痕迹**。它不需要谁去枚举
 * "还有没有第四类输入",因为它记录的是行为,不是意图。
 *
 * ── 它怎么被装上的(vitest 的两个坑都在这里)──
 *
 * 1. **不能靠 `NODE_OPTIONS` 进 worker。** vitest 给 worker 的 env 里会剔掉 `NODE_OPTIONS`
 *    (它自己要塞 loader),所以 `--import` 只落到主进程——实测:标签写进了 worker 的
 *    env,而 `fs` 的补丁在别的 pid 上,两边对不上,一条记录都落不下来。于是改成由
 *    `record-setup.ts` 在**测试进程内**调用 `installRecorder()`。
 * 2. **子进程要显式注入。** `spawn` 出去的打好的 CLI 产物是另一个进程,要让它也记录,
 *    就得在 `env` 里放 `NODE_OPTIONS`。只在调用方自己传了 `env` 时才补是不够的:多数
 *    spawn 不传 `env`,靠继承,而继承不保证跨过 vitest 那一层——所以这里**总是**造一份
 *    env 递过去。
 *
 * ── 三条实现约束 ──
 *
 * - **只记仓库内的路径**:`node_modules`、`.git`、临时目录会把 map 淹掉。
 * - **只记 `open` 与 `spawn`**:`stat` / `access` 报告的是"探测",不是"输入"。
 * - **每条记录立刻落盘**:缓冲到 `exit` 时一次写,在 worker 里等不到那个事件(实测没有
 *   一次 flush 发生),而丢记录的方向是"少跑"。
 *
 * ── 一条边界:嵌套的测试运行不继承观测器 ──
 *
 * `spawn` 注入的本意是让**打好的 CLI 产物**里的读盘也进 map。但逐文件探针
 * (`related-probe.ts`)在一个用例里 spawn `vitest related …`——那是**整套测试的又一次运行**。
 * 把观测器递进去,里面那批测试的读盘会被记到**外层那个用例**头上(标签是继承来的),map 里于
 * 是出现"探针测试读了 651 个文件",进而"改任意源码都选中探针自身"。归错档比不记更坏:它造出
 * 一条不存在的边,而那条边还很贵。所以对 `vitest` 这个执行体,不注入也不继承观测变量。
 *
 * 未观测 ≠ 没读:模块**加载期**的读盘(在 `beforeAll` 贴标签之前)落不下来——对照物是
 * `packages/engine/src/sandbox.test.ts`,它在模块顶层读了 `rulesets/v1.json` 与
 * `fixtures/guest/*.js`,而 map 里根本没有这一项。补齐需要另开一笔:标签来自
 * `expect.getState()`,加载期还没有它。
 */

import { createRequire } from "node:module";

// **不要**在这里 `import ... from "node:fs"`。
//
// ESM 从 CJS 取命名导出时,绑定在**该命名空间的创建时刻**取值;`import { appendFileSync }`
// 一旦执行,`node:fs` 的命名空间就建好了、`readFileSync` 的旧值也定死了,之后再改 CJS 对象
// 也改不到任何人的绑定上。实测:补丁装成功、`record()` 一次都没被调用。
// 所以本文件对 `node:fs` 只用 `require`:它拿到的是那个**会被别人读到**的对象本身。
const require = createRequire(import.meta.url);
const fsCjs = require("node:fs") as Record<string, unknown> & {
  appendFileSync: (path: string, data: string) => void;
};
const nodeModule = require("node:module") as { syncBuiltinESMExports: () => void };
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 本文件的 `--import` 形态:注入子进程时用。 */
export const RECORDER_URL = pathToFileURL(
  fileURLToPath(new URL("./recorder.ts", import.meta.url)),
).href;

/** 观测链路的三个环境变量:递进子进程时要带,遇到嵌套测试运行时要剥。 */
const OBSERVER_ENV: readonly string[] = [
  "MODELWAR_TEST_INPUTS_FILE",
  "MODELWAR_REPO_ROOT",
  "MODELWAR_TEST_ID",
];

/**
 * 嵌套的测试执行体(`node_modules/vitest/vitest.mjs`)。命中的 spawn 不继承观测器——理由
 * 见文件头注的最后一段。
 */
const NESTED_RUNNER = /(^|[\\/])vitest(?:\.mjs)?$/;

const target = (): string | undefined => process.env["MODELWAR_TEST_INPUTS_FILE"];

// 必须 `resolve` 一次:`MODELWAR_REPO_ROOT` 常带尾斜杠(`new URL("../../../../")` 的形态),
// 而下面的前缀比较是 `root + sep`——带着尾斜杠就变成 `…/model-war//`,于是**每个**路径都
// 被判成"仓库外",一条记录都落不下来。这个失败是静默的:map 只是空的。
const repoRoot = (): string => resolve(process.env["MODELWAR_REPO_ROOT"] ?? process.cwd());

/**
 * 第一参可以是 `string` / `Buffer` / `URL` / fd。只认前三种。
 *
 * URL 形态在本仓很常见(`readFileSync(new URL("../../package.json", import.meta.url))`),
 * 漏掉它等于漏掉一整类输入,而且漏得无声——map 只是少几行,没人会发现。
 */
const repoRelative = (path: unknown): string | undefined => {
  const asPath =
    path instanceof URL
      ? fileURLToPath(path)
      : Buffer.isBuffer(path)
        ? path.toString()
        : typeof path === "string"
          ? path
          : undefined;
  if (asPath === undefined || asPath === "") return undefined;
  if (asPath.startsWith("file://")) return repoRelative(fileURLToPath(asPath));
  if (!asPath.startsWith(sep)) return undefined;
  const root = repoRoot();
  const absolute = resolve(asPath);
  if (!absolute.startsWith(root + sep)) return undefined;
  for (const skip of [join(root, "node_modules"), join(root, ".git")]) {
    if (absolute.startsWith(skip + sep)) return undefined;
  }
  return absolute.slice(root.length + 1);
};

const record = (kind: "open" | "spawn", path: string | undefined): void => {
  const sink = target();
  if (sink === undefined || path === undefined) return;
  const test = process.env["MODELWAR_TEST_ID"];
  // 没有测试归属的记录是框架自己的 I/O(读配置、transform 依赖),不是被测行为的输入。
  if (test === undefined || test === "") return;
  try {
    fsCjs.appendFileSync(sink, `${JSON.stringify({ t: test, k: kind, p: path })}\n`);
  } catch {
    // 落盘失败不能反过来让被测用例变红:观测是判据的**输入**,不是判据本身。
  }
};

let installed = false;

/**
 * 装上观测。幂等——setup 文件与可能的手工调用都不会重复包装。
 *
 * 返回是否装上,让调用方(以及测试)能区分「不需要装」与「装失败」。
 */
export const installRecorder = (): boolean => {
  if (installed || target() === undefined) return installed;
  installed = true;
  const fs = fsCjs;
  const promises = fs["promises"] as Record<string, unknown> | undefined;
  const child = require("node:child_process") as Record<string, unknown>;

  const wrap = (
    holder: Record<string, unknown> | undefined,
    name: string,
    pickPath: (args: readonly unknown[]) => unknown,
  ): void => {
    const original = holder?.[name];
    if (typeof original !== "function") return;
    (holder as Record<string, unknown>)[name] = function patched(
      this: unknown,
      ...args: unknown[]
    ) {
      record("open", repoRelative(pickPath(args)));
      return (original as (...inner: unknown[]) => unknown).apply(this, args);
    };
  };

  const first = (args: readonly unknown[]): unknown =>
    typeof args[0] === "number" ? undefined : args[0];
  for (const name of ["readFileSync", "openSync", "createReadStream"]) wrap(fs, name, first);
  for (const name of ["readFile", "open"]) wrap(promises, name, first);

  /**
   * `spawn` 家族:记下"跑了哪个脚本",并把观测器**递进子进程**。
   *
   * 总是造一份 env:多数 spawn 不传 `env`(靠继承),而继承跨不过 vitest 那一层。
   */
  for (const name of ["spawnSync", "spawn", "execFileSync"]) {
    const original = child[name];
    if (typeof original !== "function") continue;
    child[name] = function patched(this: unknown, ...args: unknown[]) {
      const argv = Array.isArray(args[1]) ? (args[1] as unknown[]) : [];
      const script = argv.find(
        (arg): arg is string => typeof arg === "string" && !arg.startsWith("-"),
      );
      record("spawn", script === undefined ? repoRelative(args[0]) : repoRelative(script));

      const optionsIndex = Array.isArray(args[1]) ? 2 : 1;
      const existing = args[optionsIndex];
      const options =
        existing !== null && typeof existing === "object"
          ? { ...(existing as Record<string, unknown>) }
          : {};
      const env = { ...((options["env"] as Record<string, string> | undefined) ?? process.env) };
      if (script !== undefined && NESTED_RUNNER.test(script)) {
        // 嵌套的测试运行:观测器不进这一层。环境变量也得剥干净——`vitest.config.ts` 的
        // `RECORD_EXEC_ARGV` 只看 `MODELWAR_TEST_INPUTS_FILE`,留着它,子进程的 worker 会
        // 自己把观测器装上(而 `NODE_OPTIONS` 那条路已经被 vitest 剔掉了)。
        for (const key of OBSERVER_ENV) delete env[key];
      } else {
        const already = env["NODE_OPTIONS"] ?? "";
        if (!already.includes(RECORDER_URL)) {
          env["NODE_OPTIONS"] = `${already} --import=${RECORDER_URL}`.trim();
        }
        for (const key of OBSERVER_ENV) {
          const value = process.env[key];
          if (value !== undefined) env[key] = value;
        }
      }
      options["env"] = env;
      if (optionsIndex === 1) {
        // `spawnSync(file, options)` 这种形态:args[1] 是 options,不是数组。
        args[1] = options;
      } else {
        args[2] = options;
      }
      return (original as (...inner: unknown[]) => unknown).apply(this, args);
    };
  }
  /**
   * **关键一步**:把改动同步到 builtin 的 ESM 命名导出。
   *
   * 前面那些补丁只改了 CJS 对象(`require("node:fs")` 拿到的那个)。应用代码写的是
   * `import { readFileSync } from "node:fs"`,它绑的是 builtin 的**命名空间**——两份东西。
   * 不调这个函数,补丁对 ESM 消费者完全不可见(实测:补丁装成功,`record()` 一次都没被调用)。
   */
  nodeModule.syncBuiltinESMExports();
  return true;
};

/**
 * 被 `--import` 加载时**立刻**装上。
 *
 * 这一行是整个观测链路的落点:worker 进程在加载任何应用模块之前执行它,于是
 * `import { readFileSync } from "node:fs"` 的绑定在链接时就已经指向补丁后的函数。
 * 由 `record-setup.ts` 再调一次是兜底(幂等),那条路径在模块链接之后,补不到已有的绑定。
 */
if (target() !== undefined) installRecorder();
