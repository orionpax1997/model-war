---
status: accepted
---

# 沙箱 runtime bundle 以确切字节进版本库,漂移门禁判「现算 == 入库」

沙箱运行时(guest 侧 API 面)从 `packages/engine/src/sandbox-runtime/index.ts` 经 esbuild 打成**单文件 IIFE**,产物落 `packages/engine/sandbox-runtime/runtime.iife.js` 并**提交入库**;它的字节 sha256 就是回放 meta 那一栏 `sandboxRuntimeHash` 的唯一真源,常量写在真源包(`@model-war/schema` 的 `SANDBOX_RUNTIME_HASH`)。一道独立的漂移门禁(`check:runtime`)比「现打一次 == 入库产物」与「入库 sha256 == 常量」,并钉住产物不含模块语法。据此,CLI 里那个用 `sha256("stub-runner/" + RULESET_VERSION)` 拼出来的假哈希被删除。机制细节归 hld §5;判据与验收归 spec。

## Considered Options

- **CI 现算(runner 每次构建一遍,不把产物提交)**:落选——回放 meta 那一栏哈希是**第三方凭存档复算**的前提,而复算的前提是「版本库里那串确切字节」。产物只在 CI 里现算,等于把「这一年那局对局用的字节」托付给一条流水线配置与当时的工具链;流水线一改、缓存一清,同一个存档就算不回来了。判据锚定确切字节这条纪律据此被推翻。
- **构建缓存现算(本地缓存产物,命中即复用)**:落选——缓存命中与否是**环境事实**,不是版本库事实。开了缓存的门禁比的是「现算 == 缓存」,而缓存本身没有第三方可核对的出处;缓存未命中时它又退回「现算 == 现算」,是一道永远为绿的假门禁。它是 CI 现算的同一处错误换了个更不可见的藏法。
- **产物入库(采纳)**:入库产物是仓库里的一串确切字节,任何克隆都能逐字节核对;门禁比的是「现算 == 入库」,红的时候具体指得出第一个不同的字节。

## Consequences

- **产物与源码可以分叉,因此必须有一道门禁盯着**:产物入库后,改源码不重跑构建会让库里的产物停在旧版,而它照样能被 VM 载入、照样算得出 hash——不盯着就是「入库的产物是旧的,门禁跑的还是绿的」。`check:runtime` 的三段判定(现算 == 入库 / 入库 sha256 == 常量 / 不含模块语法)把这条堵死。
- **门禁必须与另外两道产物门禁分作三条**:`check:drift` 管「名单类数据 → 生成物」、`check:bench` 管 tsc 编译产物、本条管 esbuild 构建产物。产出方式不同,合表会让一道门禁同时管两种东西、判定三段也跟着分叉。
- **产物落点不得在任何 `dist/` 下**:`.gitignore` 里那条 `dist/` 是无锚点规则(命中任意层级),落进去就进不了版本库,「入库」当场成空话。落点选 `packages/engine/sandbox-runtime/`,与源码同族但不同层;`version-control-boundary.test.ts` 双向钉住。
- **产物必须是裸脚本(IIFE),不能含模块语法**:脚本与运行时同处一个全局环境,带 `import` / `export` 的产物在 QuickJS 的**载入期**就是 `SyntaxError`。门禁按语句开头匹配静态 `import` / `export` / 动态 `import()` / `require(`,不按子串——产物带着源码注释,注释里可能逐字写着「不 import 任何模块」。
- **常量与产物的一致性由门禁担保,不靠人记**:CLI 的 `measureSandboxRuntimeHash()` 返回常量(打包后它不持有仓库根的可靠锚点,当场读盘会把「判据锚定确切字节」换成「判据锚定运行目录」);需要逐字节核对的调用方(门禁、VM 载入测试)从仓库根读产物。改产物后必须重算并手写常量,`check:runtime` 发现不一致即红。
- **产物 hash 与运行时版本一并可被后续票写进回放 meta**:`@model-war/schema` 导出产物 sha256、`quickjs-wasi` 版本与产物相对路径三件;这条 ADR 只保证它们**可读、可核对**,写进 meta 是回放写出侧(组装层)的账。
