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
 *
 * ── 已知缺口(且比先前记的更宽) ──
 * `packages/tools` 以源码形态执行(`emitDeclarationOnly`,dist 里没有 .js),因此它**不在本图的
 * 巡航范围内**——实测巡航出的 21 个模块里一个 tools 的都没有。它缺掉的覆盖面分两块,一块有人
 * 兜底、一块没人兜底:
 *
 *   - **包图方向:有人兜底。** tools 现在正式声明了 `@model-war/schema` 为依赖并加了 project
 *     reference(hld §3.2:工具包只允许 import 真源包这一个根包,这条边指向依赖图的根)。
 *     所以兜底不再靠「压根没软链」这条副作用,而是靠 TypeScript 自己:package.json 里
 *     `dependencies` 只列了 schema,pnpm 只软链它一个,于是
 *     实测:`packages/tools/src` 里 import `@model-war/engine` ⇒ **TS2307**,`tsc -b` 非零退出。
 *     也就是说 tools → 其它包的反向边会被编译器拦住,只是拦它的是 tsc 而不是本门禁。
 *     代价记在这里:那条边是新的(混合传输的生成器一侧,ADR-0003),而**编译器只拦「没声明」,
 *     拦不住「声明了但方向反了」**——真源包不得反向 import tools 这条,仍靠规范而非门禁。
 *   - **第三方依赖面:没人兜底。** 先前这里写的是「pnpm 隔离 node_modules + TS2307 兜住,
 *     引用未声明的包必然编译失败」——**这句是错的**,已按实测更正。Node 与 TypeScript 的模块解析
 *     一路向上找 `node_modules`,而 workspace 根把所有 devDependency 都摆平了,于是
 *     `packages/tools/src` 可以 import `ajv` / `fast-check` / `esbuild` / `vitest` / `oxc-parser`
 *     而 `tsc -b` 退出 0,尽管 `packages/tools/package.json` 一个都没声明。
 *     TS2307 只对「整条祖先链上都没装」的包触发(实测 `lodash` ⇒ TS2307)。
 *     仓库此刻正吃这条:packages/tools/src/index.ts import `oxc-parser` 就是未声明的。
 *     所以**「声明即依赖」这条纪律在 tools 包里目前只靠自觉,没有机器门禁**。
 *
 * 另:`node:*` 那条禁令本身只作用于 engine,对 tools 谈「禁令生效与否」没有意义。
 *
 * 补上这一块有两条路,留给出下一个碰 tools 包的人(都不在本 ticket 的范围内):
 * 给 tools 装上 `tsc --noResolve` 之类的自举检查,或把它也纳入某个会产出 .js 的编译路径。
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

    // ── hld §3.2:runner 与 gen 只以子进程 + 文件消费对局产物,不得 import engine ──
    {
      name: "runner-must-not-depend-on-engine",
      severity: "error",
      comment: "hld §3.2:runner 不得 import engine",
      from: { path: filesOf("packages/runner"), pathNot: TEST_FILE },
      to: { path: toPackage("engine") },
    },
    {
      name: "gen-must-not-depend-on-engine",
      severity: "error",
      comment: "hld §3.2:gen 禁 import 任何 result 类型(FR-5 AC1)",
      from: { path: filesOf("packages/gen"), pathNot: TEST_FILE },
      to: { path: toPackage("engine") },
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
