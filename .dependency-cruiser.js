/**
 * 依赖门禁:把 hld §3.2 的包依赖方向写成可执行断言,挂在全量门禁 `check` 上。
 *
 * ── 巡航的是 dist 而不是 src(读代码前请先看这一段) ──
 * dependency-cruiser 18.4.0 只认 acorn(JS)与 TypeScript 编译器(TS)。
 * 本仓库的编译器是 TypeScript 7.0.2,**不再有 JS 编程 API**(`transpileModule` 不存在),
 * 而 dependency-cruiser 把可用编译器硬编码为 `>=2.0.0 <7.0.0`。实测:
 *
 *     $ depcruise packages/engine/src --info
 *       x typescript   >=2.0.0 <7.0.0   -
 *       x .ts          (不可扫描)
 *     $ depcruise packages/engine/src
 *       ✔ no dependency violations found (0 modules, 0 dependencies cruised)   ← exit 0,静默失效
 *
 * 也就是说:直接巡航 src 会得到一个**永远为 0 且看起来全绿**的假门禁。
 * 因此巡航入口是 `tsc -b` 的产物 `packages/任一包/dist` 与 `apps/cli/dist`——acorn 能解析,
 * import 说明符原样保留。代价:依赖门禁必须排在 `tsc -b` 之后(`check:deps` 自己就带 tsc -b)。
 *
 * ── `to.path` 匹配的是 specifier 还是 resolved realpath ──
 * 两者**互斥**:dist 未 build 时 `to.path` 是 `@model-war/replay`,
 * build 之后是 `packages/replay/dist/index.js`。本文件的每条架构规则都用
 * `(?:specifier|resolved)` 交替式,两种状态都成立——门禁因此不依赖构建产物是否就绪。
 * 另外:depcruise 会**剥掉 `node:` 前缀**(`import "node:fs"` ⇒ `to.path === "fs"`),
 * 所以内置模块一律用 `dependencyTypes: ["core"]` + `pathNot` 表达,绝不写 `'^node:'`。
 *
 * ── 规则的作用域:只管运行时代码,测试代码豁免 ──
 * 依据是 hld §3.2 已有的那条:门禁约束的是运行时行为,而测试代码不进对局进程。
 * 测试与属性测试文件必然要读盘、spawn 进程、依赖 vitest。
 * (`node:*` 那条禁令本身只作用于 engine,对 tools 谈「禁令生效与否」没有意义。)
 *
 * ── `packages/tools` **有意**在本图的巡航范围之外 ──
 * 该包以源码形态执行(`emitDeclarationOnly`,dist 里没有 .js),因此它不在本图的巡航范围内
 * (实测巡航出的模块里一个 tools 的都没有)。这是取舍不是疏漏:让该包产 `.js` 就要让快门禁
 * 付一次构建,而快门禁必须零构建(hld §2.2.1 的 Node 下限成因之一,ADR-0003 有实测数字)。
 * 缺掉的覆盖面分两块,一块已补、一块仍开着:
 *
 *   - **第三方依赖面:已由 `check:declared-deps` 兜住。** `packages/tools/src/gate/declared-deps-gate.ts`
 *     读 `packages/tools/package.json` 的 `dependencies` 与该包运行时源码里的每一个 import 说明符,
 *     两者对不上即非零退出(根脚本 `check:declared-deps`,挂在 `check` 末尾;零构建,与 `check:deps`
 *     读 dist 的形态互补)。门禁规则本身在 `packages/tools/src/rules/declared-deps.ts`。
 *     此前这里记的是「没人兜底」,并点名仓库正吃着这条:`src/parse-source.ts` import `oxc-parser`
 *     (经 `src/index.ts` 再导出)而 package.json 一个都没声明。那处偷跑已改成正式声明
 *     (现在 `oxc-parser` 在 tools 的 `dependencies` 里)。
 *     为什么不能用本文件顺手管掉:本文件巡航的是 `.js`,而 `allowImportingTsExtensions` 下编译出的
 *     说明符仍写 `.ts`(本包 import 一律带 `.ts` 扩展名,见它的 tsconfig),depcruise 解析不动。
 *   - **包图方向:只由 tsc 兜,本门禁看不到。** tools 正式声明了 `@model-war/schema` 为依赖并加了
 *     project reference(hld §3.2:工具包只允许 import 真源包这一个根包,这条边指向依赖图的根)。
 *     pnpm 只软链已声明的包,于是 `packages/tools/src` 里 import `@model-war/engine` ⇒ **TS2307**,
 *     `tsc -b` 非零退出。注意这条边是新的(混合传输的生成器一侧,ADR-0003),而**编译器只拦「没声明」,
 *     拦不住「声明了但方向反了」**——真源包不得反向 import tools 这条,仍靠规范而非门禁。
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */

/** 测试与属性测试文件:门禁对它们一律豁免。 */
const TEST_FILE = "[.](?:test|prop)[.](?:[cm]?[jt]sx?)$";

/** 某个包的源码目录。`src|dist` 交替,使得同一份规则在巡航 src 或 dist 时都成立。 */
const filesOf = (dir) => `^${dir}/(?:src|dist)/`;

/** 指向某个 workspace 包的边:specifier 形态与 resolved 形态二选一。 */
const toPackage = (name) => `^@model-war/${name}$|^packages/${name}/dist/`;

export default {
  forbidden: [
    // ── 基线卫生:没有这三条,上面那些方向规则可能因为图本身是坏的而永不触发 ──
    {
      name: "no-circular",
      severity: "error",
      comment: "包内与包间都不得出现环:有环时「谁依赖谁」的方向规则失去意义",
      from: {},
      to: { circular: true },
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      comment: "解析不出来的 import 一律拒:它同时意味着 tsc -b 前的构建产物缺失或拼写错误",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "not-to-deprecated",
      severity: "error",
      from: {},
      to: { dependencyTypes: ["deprecated"] },
    },

    // ── hld §3.2:schema 无运行时代码、不依赖任何包 ──
    {
      name: "schema-has-no-dependencies",
      severity: "error",
      comment: "hld §3.2:schema 只含类型、常量与 JSON Schema;各包共享数据格式定义不违反隔离条款",
      from: { path: filesOf("packages/schema"), pathNot: TEST_FILE },
      to: { pathNot: "^packages/schema/dist/" },
    },

    // ── hld §3.2:replay 只依赖 schema(包内相对 import 天然放行) ──
    {
      name: "replay-may-only-depend-on-schema",
      severity: "error",
      comment:
        "hld §3.2:replay 只依赖 schema;行格式与 hash 原语不得反向依赖写入方。" +
        "hld 只对 engine 钉死了内建模块白名单,replay 这边 stateHash 合法用 node:crypto(hld §2.2.5)," +
        "因此本规则放行 core 一档,只约束包图",
      from: { path: filesOf("packages/replay"), pathNot: TEST_FILE },
      to: {
        pathNot: `^packages/replay/dist/|${toPackage("schema")}`,
        dependencyTypesNot: ["core"],
      },
    },

    // ── hld §3.2:engine 不 import runner / gen ──
    {
      name: "engine-must-not-depend-on-runner-or-gen",
      severity: "error",
      comment: "hld §3.2:engine 不 import runner/gen;gen 永不进对局进程(NFR-4 AC2)",
      from: { path: filesOf("packages/engine"), pathNot: TEST_FILE },
      to: { path: `${toPackage("runner")}|${toPackage("gen")}` },
    },

    // ── hld §3.2:runner 与 gen 都只以子进程 + 文件消费对局产物,不得 import engine;gen 另禁 runner/replay ──
    {
      name: "runner-must-not-depend-on-engine",
      severity: "error",
      comment: "hld §3.2:runner 不得 import engine",
      from: { path: filesOf("packages/runner"), pathNot: TEST_FILE },
      to: { path: toPackage("engine") },
    },
    // 名单是三个而不是一个:hld §3.2 只明写了 `gen ⇎ engine`,另外两条的依据是 FR-5 AC1 与它
    // 在 hld §6.2 的同义句「`gen` 代码中不存在对战结果回传路径」——engine 之外,runner(跑对局、
    // 把产物落 `runs/`)与 replay(读对局产物)是另外两条能拿到对局结果的边,任何一条都足以把
    // 结果带回生成环节。三条共用一条规则、沿用 `(?:specifier|resolved)` 交替式:理由是同一个(AC1),
    // 拆成三条只会复制三份注释,且将来漏改其中一条时另外两条照样绿。
    {
      name: "gen-must-not-depend-on-engine-runner-replay",
      severity: "error",
      comment:
        "hld §3.2 + FR-5 AC1(hld §6.2:gen 代码中不存在对战结果回传路径):gen 禁 import 任何 result 类型。" +
        "engine 持有对局结果类型(RunMatchParams / RunMatchResult),runner 跑对局并把产物落 runs/," +
        "replay 读对局产物——三条边各是一条回喂通路",
      from: { path: filesOf("packages/gen"), pathNot: TEST_FILE },
      to: { path: `${toPackage("engine")}|${toPackage("runner")}|${toPackage("replay")}` },
    },

    // ── hld §2.2.8 / §3.2:engine 运行时只允许 node:crypto 一个内置模块 ──
    {
      name: "engine-runtime-only-allows-node-crypto",
      severity: "error",
      comment:
        "hld §2.2.8:engine 除 stateHash 外禁一切 node:*,等于用 lint 证明纯函数。" +
        "depcruise 剥掉 node: 前缀,所以内建模块按 dependencyTypes core 匹配、路径写作 ^crypto$",
      from: { path: filesOf("packages/engine"), pathNot: TEST_FILE },
      to: { dependencyTypes: ["core"], pathNot: "^crypto$" },
    },
  ],

  options: {
    // 巡航入口是命令行位置参数(见 package.json 的 check:deps):packages/*/dist 与 apps/*/dist。
    // 不能用 includeOnly——它对 from/to 两侧同时生效,会把指向包外的边(内建模块)整片删掉。
    // 也不能 exclude dist——包间 import 解析后正落在 dist 上,排掉它等于排掉全部跨包边。
    doNotFollow: { path: "node_modules" },
    exclude: { path: "node_modules" },
    // workspace 的跨包解析走 exports。depcruise 默认 exportsFields 为空数组(即完全不读 exports),
    // 不显式打开的话跨包 import 永远解析不出来。
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      // 默认条件集不含 import/require,而 vitest / fast-check 的 exports["."] 只有这两个条件,
      // 于是它们会被误判为 unresolved(测试文件因此会假报 not-to-unresolvable)。
      conditionNames: ["import", "require", "node", "default"],
    },
    // mono-repo 必需:把根往上的 package.json 依赖合并进来,否则 npm-dev 判定会误报。
    combinedDependencies: true,
  },
};
