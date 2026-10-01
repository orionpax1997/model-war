# quickjs-wasi 语义核查(一手来源)

> **目录约定**:本仓库 `.scratch/` 下此前没有 `findings/` 子目录,这是新建的调研笔记目录,用于沉淀各 research 票的逐条论据;`.scratch/sandbox-budget/issues/` 是票文,本文件只承载被引用的事实与链接,不重复票的结论。

- 调研对象:**[vercel-labs/quickjs-wasi](https://github.com/vercel-labs/quickjs-wasi)**(npm 包 `quickjs-wasi`)+ 上游 [quickjs-ng/quickjs](https://github.com/quickjs-ng/quickjs) C 源码。**包身份证据**:npm tarball `package.json#repository.url = git://github.com/vercel-labs/quickjs-wasi.git`,且 GitHub 仓库 README 与 tarball 内 README 逐字一致(主线程在线核对)。
- **出处更正(主线程复核)**:npm tarball 的 `files` 只含 `dist/`、`quickjs.wasm`、`extensions/`,**不含 `c/interface.c` 与 `CHANGELOG.md`**——下文凡引"本地 `package/c/interface.c` / `package/CHANGELOG.md`"处,实读自 GitHub 仓库 main 分支:[c/interface.c](https://github.com/vercel-labs/quickjs-wasi/blob/main/c/interface.c)、[CHANGELOG.md](https://github.com/vercel-labs/quickjs-wasi/blob/main/CHANGELOG.md);引用内容已经主线程拉取原文件逐条复核吻合。
- npm tarball 实测版本:`quickjs-wasi@3.3.0`(本地通过 `npm pack` 落盘到 `/tmp/quickjs-wasi-src/package/`)。文中所有以"v3.3.0"指代的事实均来自该 tarball。
- HEAD([vercel-labs/quickjs-wasi](https://github.com/vercel-labs/quickjs-wasi) 的 main 分支)CHANGELOG 顶部显示的版本号为 v3.6.0(npm 上已有 3.6.2 实装,spike 目录已引入 3.6.2;以 npm 实装为准),且 v3.5.0 拉取了 quickjs-ng v0.16.2。v3.3.0 还在 quickjs-ng v0.15.1 时代。两边在中断与内存语义上行为一致;栈上限与默认扩展面在 HEAD 已演进,差异点会在相应小节单独标注。
- 票里引用本文件的格式:`见 [01-quickjs-wasi-semantics.md](../findings/01-quickjs-wasi-semantics.md) §X`。

---

## §0 包身份与构建链路(快速核对)

| 事实 | 出处 |
|---|---|
| 包名 `quickjs-wasi`,MIT,源码仓库 [vercel-labs/quickjs-wasi](https://github.com/vercel-labs/quickjs-wasi),零运行时三方依赖,要求 Node ≥ 22 | `npm pack quickjs-wasi@3.3.0` 得到的 `package/package.json`(type=module, license=MIT, repository.git=github.com/vercel-labs/quickjs-wasi);`README.md` §"Development — Prerequisites" 明示 Node ≥ 22 |
| QuickJS-NG 编译为 wasm32-wasip1 reactor(无 main,导出 `_initialize`、内存与 `__stack_pointer`) | `README.md` §"WASM Binary";`package/c/interface.c` 头注释 "compiled as a WASI reactor - no main()" |
| WASM 主模块导出 7 个 import:6 个 `wasi_snapshot_preview1` + `env.host_call`;`host_interrupt` 与 `host_promise_rejection` 在 v3 头部被新增为同模块 env.* 导入 | `package/c/interface.c` `__attribute__((import_module("env"), import_name("host_call")))` 等;v3 接口层 `__attribute__((import_module("env"), import_name("host_interrupt")))` 与 `host_promise_rejection`、`host_module_normalize`、`host_module_load`、`host_get_timezone_offset` 同列 |
| 主模块暴露的内存与 `__stack_pointer` 用于 snapshot | `README.md` §"What Gets Snapshotted" |
| `wasi` 工厂接收 `WebAssembly.Memory` 并返回任意 `wasi_snapshot_preview1` 覆盖,**主模块与所有扩展共用同一覆盖层** | `README.md` §"WASI Overrides";"Applies to both the main module and all loaded extensions" |

---

## §1 `interruptHandler`:存在 / 触发粒度 / 回调可否计数并中断

### 结论标签:**部分成立(粒度有出入),其余成立**

### 论据

1. **存在**:v3.3.0 README §"Interrupt Handler" 明示选项存在;`dist/index.js#QuickJS.instantiate()` 中 `hostInterrupt = () => vm.interruptHandler ? (vm.interruptHandler() ? 1 : 0) : 0`,作为 `env.host_interrupt` 导入供给 WASM;C 侧 `interrupt_handler_trampoline` 直接返回 `host_interrupt()` 的值(`c/interface.c`)。回调返回 `true` ⇒ C 返回非零 ⇒ QuickJS 中断当前执行 ⇒ 抛**不可被 JS `try/catch` 捕获**的异常(由 QuickJS-NG 的 `JS_SetUncatchableError` 标记),宿主侧以 `JSException` 形式拿到。
   - 上游证据:quickjs-ng 自身 `quickjs.c` 的 `__js_poll_interrupts` 在 handler 返回非零时执行 `JS_SetUncatchableError(ctx, …)`。`api-test.c` 的 `sync_call` / `async_call` 测试断言 `JS_IsUncatchableError(ctx, e) == true`。
   - 含义:guest 代码 `try { while(true){} } catch(e){}` 捕不到;但宿主 `try { vm.evalCode(...) } catch(e){}` 能捕到 `JSException`,hld §5.2 因此按"loop 抛异常"同轨处理是正确的。

2. **触发粒度(关键偏离)**:
   - hld §5.0 / §5.3 写"`interruptHandler` 按字节码指令触发,可做指令计数主判据"。
   - **实际粒度不是每条指令,而是每 10000 条 opcode 一次**:`quickjs.c:556` `JS_INTERRUPT_COUNTER_INIT = 10000`;`JSContext` 结构里有 `int interrupt_counter`(`quickjs.c:608`);`js_poll_interrupts`(`quickjs.c:8666-8670`)每条 opcode `if (unlikely(--ctx->interrupt_counter <= 0)) return __js_poll_interrupts(ctx);`,归零后由 `__js_poll_interrupts` 调 `rt->interrupt_handler` 并把计数器重置回 10000(`quickjs.c:8656`)。`js_poll_interrupts` 的调用点是 `JS_CallInternal` 主循环(`quickjs.c:8889`)与 `JS_ExecutePendingJob`(`quickjs.c:16802`)。
   - 含义:**用回调返回值做"指令计数"是可行的,但实际看到的是"每 10000 条触发一次",回调控件内自增 `count*10000` 是必要的;回调自身开销摊到每次触发,不是每次指令**(hld §5.3 已经写"回调须保持轻量",这一行**正确**)。
   - 公开 README 的措辞是"called approximately once per JS bytecode instruction"(§"Interrupt Handler"),与上游源码不符——这是文档与实现的不一致,需要在票里指出。

3. **回调计数能力**:`JSInterruptHandler` 签名是 `int (JSRuntime *rt, void *opaque)`(`quickjs.h:120` 附近 `typedef int JSInterruptHandler(JSRuntime *rt, void *opaque)`)。回调可读 opaque 指针(由 `JS_SetInterruptHandler` 注册时第三个参数传入)。quickjs-wasi 的实现是 `host_interrupt()` 无参 → 闭包捕获 `vm.interruptHandler`,回调里 `count++` 即可,等价。**成立**。

4. **VM 中断后可用性**:README §"Interrupt Handler" 明示 "The VM remains usable after an interrupt"。hld §5.2 表中"VM 中断后仍可用,无需重建"**成立**。

5. **async 路径**:`api-test.c` 的 `async_call` 显示当 `await` 把"未决的 promise"挂回 job 队列时,`JS_ExecutePendingJob` 仍会进入 `js_poll_interrupts` 触发中断,且 `JS_ExecutePendingJob` 返回 `-1` 同时把异常标为 `uncatchable`(参 §4)。**意味着宿主必须 `while(JS_IsJobPending) JS_ExecutePendingJob` 才能抓到 async 路径的超限**——这正是 quickjs-wasi 的 `executePendingJobs()` 内部循环。

### 一手来源链接

- 上游源码:`https://github.com/quickjs-ng/quickjs/blob/master/quickjs.c`(行号 556 / 608 / 8653-8670 / 8889 / 16802)
- 上游头文件:`https://github.com/quickjs-ng/quickjs/blob/master/quickjs.h`(`JS_SetInterruptHandler`、`JSInterruptHandler` 签名)
- 上游测试:`https://github.com/VadimZhestikov/quickjs-ng/blob/master/api-test.c`(sync_call / async_call,`JS_IsUncatchableError` 断言)
- 封装 README:本地 `package/README.md` §"Interrupt Handler"、"Memory Limits";本地 `package/dist/index.js`(hostInterrupt 闭包、`qjs_set_interrupt_handler(1)` 调用点)
- 封装 C 接口:本地 `package/c/interface.c` `interrupt_handler_trampoline`、`host_interrupt` extern 声明

---

## §2 `memoryLimit` 超限:可捕获 JS 异常 vs WASM trap / 宿主失败

### 结论标签:**成立**(以 v3.3.0 行为为准;v3.5.0 起更明确)

### 论据

1. **quickjs-wasi README §"Memory Limits"** 直白写:"When exceeded, allocations fail and surface as JS exceptions",并给出 `try { new Array(...) } catch (e) { console.log(e.message) // "allocation failure" }` 示例。

2. **上游实现路径**:`quickjs.c:1992-2016` 是 `js_calloc_rt` / `js_malloc_rt` / `js_realloc_rt`,都有同一守卫 `if (unlikely(s->malloc_size + size > s->malloc_limit - 1)) return NULL;`。malloc 失败后调用方立即 `JS_ThrowOutOfMemory(ctx)`(`quickjs.c:2097 / 2109 / 2121 / 2138 / 2595`),即一个内部 `InternalError`(quickjs.h `JS_ThrowOutOfMemory` 原型声明于 `quickjs.h:862`)。`InternalError` 是标准 `Error` 子类,**`try/catch` 可捕获**。

3. **CHANGELOG(HEAD)明确证据**:`package/CHANGELOG.md` 列出:
   - 3.5.0 PR #39:"Exceeding `memoryLimit` throws `InternalError: out of memory` again instead of a bare `null` (regression in 3.3.1): the limit is now enforced in the WASI malloc layer, which reserves headroom below the limit so the OOM error object can always be constructed."
   - 3.3.1 PR #33:"`memoryLimit` now actually bounds retained memory: the runtime is created with malloc functions that use wasi-libc's `malloc_usable_size` … Previously every allocation was accounted as overhead only, so retained ArrayBuffers/TypedArrays grew real memory without bound under any limit … Workloads near their configured limit may now throw where they silently over-allocated before."

   这说明 v3.3.0/v3.3.1 之间出现过一次"内存超限但抛 null 而不是异常"的回归,3.5.0 修回。**票文引用的事实应当按 v3.3.0 修过后的等价行为采信**,即"超限 → `InternalError: out of memory` → 可捕获"。

4. **hld §5.2 表 "内存超限" 行** 把这条记成"按第一行处理(可捕获,VM 继续可用)",与上游 + 封装一致。**成立**。

5. **VM 是否继续可用**:超限是 `try/catch` 能捕的 JS 异常,不会损坏 JSRuntime,VM 不需重建。

### 一手来源链接

- 上游源码:`https://github.com/quickjs-ng/quickjs/blob/master/quickjs.c`(1992 / 2015 / 2097 / 2109 / 2121 / 2138 / 2595)
- 上游头文件:`https://github.com/quickjs-ng/quickjs/blob/master/quickjs.h:862`(`JS_ThrowOutOfMemory` 原型)
- 封装 README:本地 `package/README.md` §"Memory Limits"
- 封装 CHANGELOG:本地 `package/CHANGELOG.md`(3.3.1 / 3.5.0 条目)

---

## §3 深递归栈溢出:WASM trap / 不可捕获 / VM 是否报废

### 结论标签:**成立(v3.3.0) / 部分成立(HEAD v3.6.0+,需实测确认)**

### 论据

1. **v3.3.0 / v3.5.0 阶段:深递归 ⇒ WASM trap,不可捕获**。
   - `package/README.md` §"Limitations and Future Work" 写:"**Stack size limit**: QuickJS-ng disables `JS_SetMaxStackSize` on WASI, so deep recursion causes a WASM trap (not a catchable exception)."
   - 上游 quickjs-ng `quickjs.c:3127` 的 `void JS_SetMaxStackSize(JSRuntime *rt, size_t stack_size)` **函数本身并未被 `__wasi__` 编译禁用**(搜索 `__wasi__` 在 `quickjs.c` 唯一一次出现的语义是排除 atomics,见 `quickjs.c:75`)。但 quickjs-wasi 的 v3.3.0 接口层不导出 `qjs_set_max_stack_size`——查 `package/c/interface.c` 与 `package/dist/index.js` 都没有该 export;`applyLimits()` 也只设置 `qjs_set_memory_limit`、`qjs_set_interrupt_handler`、`qjs_set_promise_rejection_handler`、`qjs_set_module_loader`。
   - 真正导致 trap 的是 **WASM 物理栈(wasi-sdk 默认 ~173 KB)** 与 QuickJS C-side 递归(解析器/求值器对深括号、深对象、深递归函数)之间的容量不匹配:
     - `package/CHANGELOG.md` v3.4.0 之后:"Increase WASM stack size to 1MB to prevent stack overflow traps. The default wasi-sdk stack (~173KB) is too small for QuickJS, recursive operations like `JSON.stringify` or devalue serialization at moderate depths cause hard WASM traps instead of catchable JS exceptions, since QuickJS-NG disables `JS_SetMaxStackSize` on WASI. 1MB is the optimal size … QuickJS's internal JS stack limit becomes the bottleneck."
     - 上游 issue quickjs-ng/quickjs#775、`#893`:在 WASI 构建上,JS 层 `JS_SetMaxStackSize` 跟踪的是 JS-level 栈,但 QuickJS C-side 的解析器/求值器在 WASM shadow stack(链接期固定)上递归,先于 JS-level 限制溢出。`MaxStackSize` 越大反而越糟。
     - 旁证:第三方绑定 fastschema/qjs#47(同样的 WASM trap,即使配了 `MaxStackSize: 64<<20`)。
   - 含义(对 hld 的影响):
     - 在 v3.3.0(以及到 v3.5.0)上,**没有 `maxStackSize` 选项**,hld §5.0 / §5.2 的"WASM trap 不可捕获 → 重建该方 VM"结论**成立**,且 VM 经 trap 后**不可继续使用**——wasm 模块的 shadow stack 进入不可信状态,只能 `QuickJS.restore()`(从一个新快照)或 `dispose()` 后再 `create()`。
     - 票文引用本节时应注明"按 v3.3.0 锁版行为",如果后续升到 v3.6.0,需要复核 hld §5.2 的"WASM trap → 重建"分支是否仍然唯一路径。

2. **HEAD v3.6.0+:出现可配置**的 `maxStackSize` 选项,可在 0..512 KB 区间设置(`MAX_STACK_SIZE = 512 * 1024`,本地 `src/index.ts:29`)。
   - `c/interface.c:545-547` 新增 `qjs_set_max_stack_size(size)` 包装 `JS_SetMaxStackSize`;`src/index.ts:241-252` 文档:"Maximum native stack space QuickJS may consume, in bytes. Must be an integer between 0 and MAX_STACK_SIZE. Set to 0 to disable the QuickJS stack guard."
   - `CHANGELOG.md` v3.6.0(PR #44, commit `28e4b60`):"Add the `maxStackSize` option and `MAX_STACK_SIZE` ceiling so WASI stack overflow can be caught by guest JavaScript without exhausting the physical WebAssembly stack."
   - 含义:**只要 `maxStackSize < 物理 wasm 栈大小`,QuickJS-NG 的 JS-level 栈检查会先触发并抛一个可捕获的 RangeError(典型形态 `RangeError: Maximum call stack size exceeded`)**——`build_backtrace()` 在低栈时可能爆栈导致异常物化失败(quickjs-ng/quickjs#893),但仍属 catchable 失败而非 trap。
   - **陷阱**:即便配 `maxStackSize`,若 JS 代码仍触发到物理 WASM 栈上限(如极端深括号表达式触发 quickjs-ng 解析器 C-side 递归),仍然 trap。`maxStackSize` 只把"guest JS-level 递归溢出"从 trap 转成可捕获异常。

### 一手来源链接

- 上游源码:`https://github.com/quickjs-ng/quickjs/blob/master/quickjs.c:3127`(JS_SetMaxStackSize 定义)
- 上游 issue:`https://github.com/quickjs-ng/quickjs/issues/775`、`https://github.com/quickjs-ng/quickjs/issues/893`
- 第三方绑定 issue:`https://github.com/fastschema/qjs/issues/47`
- 封装 README(v3.3.0 文本,仍是 main 分支当前可见的文本):本地 `package/README.md` §"Limitations and Future Work"
- 封装 CHANGELOG:本地 `package/CHANGELOG.md`(3.4.0 "Increase WASM stack size to 1MB"、3.6.0 "maxStackSize option")
- 封装 C 接口:本地 `package/c/interface.c` 头部 import 列表;HEAD `src/index.ts:29 / 241-252 / 940-943`、`c/interface.c:545-547`

---

## §4 `executePendingJobs` 的语义与"每 tick 排空"

### 结论标签:**成立**

### 论据

1. **`vm.executePendingJobs()` 内部是个 `while` 循环**:`package/dist/index.js` 的 `executePendingJobs()`:
   ```ts
   executePendingJobs() {
       let count = 0;
       while (this.exports.qjs_is_job_pending()) {
           const result = this.exports.qjs_execute_pending_job();
           if (result < 0) { … throw new Error(`Job execution error: …`); }
           count++;
       }
       return count;
   }
   ```
   即**每次宿主调用 `executePendingJobs()` 会把所有 pending 微任务排空**,直到 `JS_IsJobPending()` 报 0 才返回。
   - 上游 `JS_ExecutePendingJob`(`quickjs.c:16802`)自身也调用 `js_poll_interrupts(ctx)`,所以微任务路径上**同样受 interruptHandler 控制**。

2. **`JS_ExecutePendingJob` 失败语义**:返回 -1 时 `JS_HasException(ctx) == true`,且 `api-test.c` 的 `async_call` 显示异常是 **uncatchable**(`JS_IsUncatchableError(ctx, e) == true`)——和 §1 一致。所以 async 路径上如果脚本里 `await someAsync(); while(true){}`,unhandled rejection 与 interrupt 异常都会以 uncatchable 形式冒泡,宿主侧 `executePendingJobs()` 抛 `Error`。
   - 含义:宿主代码必须把 `executePendingJobs()` 的调用点包在 `try/catch`,否则异常会让宿主循环中断——这正是 hld §5.1"每 tick 排空"语义成立的前提。

3. **`while(true){}` 同步场景(无 await / Promise)**:第 1 tick `evalCode(loop)` 在 `interruptHandler` 第 N 次返回 true 时中断;若 host 立即再 `executePendingJobs()`,此时 job queue 为空,直接返回——不会跨 tick 残留。**成立**。
   - **跨 tick 残留的真实场景**:脚本里启动的 Promise(如 `queueMicrotask(...)` 或 `hostPromise(...).then(...)`)在 `loop()` 返回后还挂在 job queue 上,**只**通过 `executePendingJobs()` 才会被驱动。hld §5.1 的"每 tick 排空"指 host 在每个 tick 边界主动 `executePendingJobs()`,**而不是**一次 `loop()` 调用之内"每条指令都排"——这是不同层面的"排空"。quickjs-wasi 的实现只在 `evalCode` / `callFunction` 期间由 QuickJS-NG 自动驱动 promise 解析,跨 host 调用不驱动。

4. **`callFunction(loopFn)` 返回值**:从 `JS_ExecutePendingJob` 的视角,一次 `callFunction(loopFn)` 不一定把所有 async 工作跑完——如果 `loop()` 内部有未决 promise,这些 promise 的 `.then` 回调排队等待 `executePendingJobs()`,而 `loop()` 调用本身在 `evalCode` 的同步部分结束后就返回。这是 quickjs-wasi 的 `JS_EVAL_TYPE_GLOBAL` 与 `JS_EVAL_FLAG_ASYNC` / `JS_EVAL_TYPE_MODULE` 的差异来源。
   - hld §4.5 / §5.1 要求"每 tick 排空",**应当**在 `callFunction(loopFn)` 后**显式调一次** `vm.executePendingJobs()`,不是依赖 `callFunction` 自己排——这与 hld §5.1 措辞一致。

### 一手来源链接

- 上游源码:`https://github.com/quickjs-ng/quickjs/blob/master/quickjs.c:16802`(`JS_ExecutePendingJob` + `js_poll_interrupts` 调用)
- 上游测试:`https://github.com/VadimZhestikov/quickjs-ng/blob/master/api-test.c` `async_call`(unhandled rejection → `JS_IsUncatchableError`)
- 封装 README:本地 `package/README.md` §"Promises and Async Host Functions"(明示 host 需要在异步回调后 `vm.executePendingJobs()`)
- 封装 dist:本地 `package/dist/index.js` `executePendingJobs()` 实现

---

## §5 WASI 覆盖面与 PRNG 播种(同值 ⇒ 同序列)

### 结论标签:**成立**(对 clock_time_get 覆盖;Math.random PRNG 播种同值同序列)

### 论据

1. **`clock_time_get` / `random_get` / `fd_write` / `fd_close` / `fd_fdstat_get` / `fd_seek` 6 个 WASI 导入**:`package/dist/wasi-shim.js` 是默认实现,提供完整 6 个 host 函数,均可被用户 `wasi` 工厂返回值覆盖(`dist/index.js#QuickJS.instantiate()`:`wasiShim = { ...wasiBuiltins, ...wasiUserOverrides }`)。
   - `clock_time_get` 默认:`BigInt(Date.now()) * 1000000n`,支持 `CLOCK_REALTIME`(0)与 `CLOCK_MONOTONIC`(1)。
   - `random_get` 默认:`crypto.getRandomValues(bytes)`(浏览器/Node 22 自带 WebCrypto),回退 `Math.floor(Math.random() * 256)`。
   - `fd_write` 写 stdout/stderr,`fd_close`/`fd_fdstat_get`/`fd_seek` 返回 `ERRNO_NOSYS` / 仅对 1、2 fd 返回 OK。

2. **`timezoneOffset` 选项**:`package/dist/index.js#applyLimits()` 实现 host 的 `timezoneOffsetHandler` 注册;`c/interface.c` 顶部新加 `host_get_timezone_offset(hi, lo)` env.* import。`README.md` §"Timezone Offset" 文档 `'host'`(默认)、固定数字、`(timeSecs) => minutes` 三种形态。hld §5.1 写"固定为 0"——直接传数字 `0` 即可。

3. **PRNG 播种(`Math.random` 序列确定性)**:`package/README.md` §"WASI Overrides" 给出确定性证明:
   > "QuickJS uses a xorshift64* PRNG that is seeded once from the clock value during context creation. Override `clock_time_get` to control both `Date.now()` and the `Math.random()` seed"
   > 两个独立 VM 用同一固定 `clock_time_get`,`Math.random()` 返回同一浮点 `0.8130834347906803`。
   - 上游源码(`quickjs.c:604 / 2879-2882`):
     - `JSContext` 结构里 `uint64_t random_state;`(`quickjs.c:604`)
     - 上下文初始化时 `ctx->random_state = js__gettimeofday_us();`(`quickjs.c:2879`),若为 0 则修正为 1,并以 `xorshift64star(&ctx->random_state)` 生成 `hash_seed`
     - `xorshift64star` 原型在 `quickjs.c:1396`
   - 上游到 WASI 的链接路径:quickjs-ng 用 libc `gettimeofday()` ⇒ wasi-libc 把 `clock_gettime` 映射到 WASI `clock_time_get`(wasi-libc 标准实现)。**只要覆盖 `clock_time_get` 为定值,`js__gettimeofday_us()` 返回值就固定,`random_state` 也就固定,`Math.random()` 序列因此同值同序**。
   - hld §5.1 写的"QuickJS 内部 PRNG 以该值播种,同值即同 `Math.random()` 序列"**成立**。

4. **`random_get` 的覆盖需求**:hld §5.1 写"`random_get` 覆盖为确定性填充"。quickjs-wasi 默认 `random_get` 用 `crypto.getRandomValues`(宿主 WebCrypto,**非确定**)——所以为了让整场对局完全确定(不仅 `Math.random`、还覆盖到 wasi-libc 启动期 / 任何走 WASI libc `arc4random`/`getentropy` 的路径),`random_get` 也必须被宿主覆盖为定值。**hld 的覆盖策略成立**;如果 hld 后续要加载 crypto 扩展,`random_get` 还需给 `crypto.getRandomValues` 提供定值。

### 一手来源链接

- 封装 README:本地 `package/README.md` §"WASI Overrides"、"Timezone Offset"
- 封装 dist:本地 `package/dist/wasi-shim.js`(默认 6 函数)、`dist/index.js#QuickJS.instantiate()`(覆盖层合并)
- 封装 C 接口:本地 `package/c/interface.c`(`host_get_timezone_offset` import)
- 上游源码:`https://github.com/quickjs-ng/quickjs/blob/master/quickjs.c:604 / 1396 / 2879-2882`

---

## §6 `moduleLoader` 不配置时的行为 + 默认全局面

### 结论标签:**部分成立(场景区分) + 文档未承诺(默认全局面)**

### 论据

1. **`moduleLoader` 选项与 `evalCode` 默认**:
   - `package/dist/index.js#applyLimits()`:`if (opts.moduleLoader) { …; vm.exports.qjs_set_module_loader(1); }`——只有用户提供 `moduleLoader` 时才把 C 侧的 trampoline 开关打开。
   - 不提供 `moduleLoader`:
     - **script-mode(`JS_EVAL_TYPE_GLOBAL`,默认)**:`vm.evalCode(code, '<eval>', 0)` 不走模块加载器,`import` 语句不会被解析(QuickJS 解析器在 global 脚本里只把 `import` 当 `SyntaxError`)。所以"不配 moduleLoader 也能 `evalCode` 跑纯 global 脚本"**成立**。
     - **module-mode(`EvalFlags.TYPE_MODULE` / `JS_EVAL_TYPE_MODULE`)**:模块图的 `import` 解析需要 loader;quickjs-wasi 在不配 moduleLoader 时**没有任何 loader 注册**(因为 `qjs_set_module_loader(1)` 不会被调用,且 `c/interface.c` 的 trampoline 默认是静的)。`JS_Eval(ctx, source, …, JS_EVAL_TYPE_MODULE)` 会进入 `js_module_loader`——quickjs-wasi 的 C 侧在 `module_loader_trampoline` 走 `host_module_load(name, &len)` → 宿主层 `hostModuleLoad` 因 `vm.moduleLoadHandler === null` 返回 `0` → 抛 `ReferenceError: could not load module '<name>'`(参 `c/interface.c` 中 `module_loader_trampoline` 与 dist `index.js#hostModuleLoad`)。
   - **hld §6.2 静态校验行** "禁 `export` / `import`" 已经把模块系统挡在 gen 阶段,所以**引擎侧不需要"模块不配 loader"分支**——hld 把这个当"代价"写出来是描述性的,**无需修**。

2. **默认全局面实际有多大**:
   - v3.3.0 README 没有"intrinsics"概念,所有标准内置都打开(包括 `Date`、`Proxy`、`WeakRef`、`performance.now`、`atob`/`btoa`、`DOMException`、`SharedArrayBuffer` 类但不一定可共享、etc.)。
   - HEAD v3.5.0+ 增加了 `Intrinsics` 位掩码选项(`EvalFlags.TYPE_*` 同位 + `Intrinsics.ALL = 0xFFFFFFFF`),`qjs_init2(intrinsics)` 允许宿主关掉某个 intrinsics 子集(`BASE_OBJECTS` 始终开)。本地 `dist/index.js` 顶部 `Intrinsics` 常量表逐项列出可关闭项;`Intrinsics.ALL` 默认全部启用。
   - v3.3.0 tarball 的 `dist/index.js` **没有** `Intrinsics` 选项——v3.5.0 加的,所以 v3.3.0 锁版下面 = "全开"。

3. **默认扩展面(`.so`)**:
   - v3.3.0 / HEAD 都明确:**默认不加载任何 `.so`**。`extensions` 选项缺省;`QuickJSOptions.intrins` 或扩展均需 host 显式加载。
   - hld §5.1 写"不加载任何 `.so` 扩展(url/encoding/headers/crypto/structured-clone 均不启用)"**成立**。
   - 内置默认(global object)包括:
     - `Object`、`Function`、`Error`、`Array`、`Number`、`String`、`Boolean`、`Symbol`、JSON、RegExp、`Promise`、`Map`/`Set`、`WeakMap`/`WeakSet`、`Date`、`Proxy`/`Reflect`、`BigInt`、`ArrayBuffer` + 所有 TypedArray、`DataView`、`WeakRef`、`FinalizationRegistry`、`performance`、`atob`/`btoa`、`DOMException`、`Symbol.for`、`Symbol.*` 等等。
   - **关键禁止项**:hld §6.2 静态校验禁 `Date`、`Math.random`(后者其实是确定性 PRNG,静态禁是冗余纵深防御),脚本在沙箱内**还能见到** `Date`、`performance.now`、`atob`/`btoa`、`crypto`(无 `.so` 扩展时不暴露,全局默认没有)、`structuredClone`(无扩展不暴露)。
   - **真正的默认可见面表** 需要 §6.4 列实测,但**当前文档层无法穷举**(README 没有完整默认全局列表),这一项落"文档未承诺,须实测"。

4. **静态校验与运行时隔离的边界**:hld §6.2 的 `no-restricted-globals` 白名单才是真正限制脚本可见面的闸,quickjs-wasi 自身在默认 VM 里不会"主动删除" `Date` 等"污染源"。**两层防御**:静态校验挡在最外,运行时 WASI 覆盖把 `Date.now` 冻成定值,二者协同。

### 一手来源链接

- 封装 README:本地 `package/README.md` §"ES Modules"、"Extensions"(明示不加载 = 默认)
- 封装 dist:本地 `package/dist/index.js`(`Intrinsics` 位掩码、`applyLimits()` 的 moduleLoader 分支、`hostModuleLoad` 的 null handler 分支)
- 封装 C 接口:本地 `package/c/interface.c`(`module_loader_trampoline`、`module_normalizer_trampoline`、未配置时返回 `ReferenceError`)
- 封装 CHANGELOG:本地 `package/CHANGELOG.md`(3.5.0 PR #41 "Update quickjs-ng from v0.15.1 to v0.16.2" 等)

---

## §7 已被本调研确认成立 / 不成立的二级事实(顺手核对 hld §5 的相关语句)

| hld §5 引用语句 | 本调研结论 | 关键依据 |
|---|---|---|
| §5.0 "预算可复现:`interruptHandler` 按字节码指令触发" | **粒度不对**:每 10000 opcode 触发一次 | `quickjs.c:556 JS_INTERRUPT_COUNTER_INIT=10000` |
| §5.0 "`memoryLimit` 超限表现为可捕获的 JS 异常" | **成立** | quickjs-ng malloc 守卫 → `JS_ThrowOutOfMemory` → `InternalError`(可 `try/catch`) |
| §5.0 "`moduleLoader` 不配置(`import` 在静态校验期即拒绝)" | **成立**(但更准确的描述是"静态校验挡 import,运行时 global script 不需要 loader,module-mode 不配 loader 时 import 抛 `ReferenceError`") | `package/c/interface.c` `module_loader_trampoline`、`dist/index.js#applyLimits` |
| §5.0 "深递归无 `JS_SetMaxStackSize`,表现为 WASM trap 而非可捕获异常" | **v3.3.0 锁版下成立;HEAD v3.6.0+ 有 `maxStackSize` 选项**,需在 §5.0 增补"按锁版 v3.3.0 行为" | CHANGELOG v3.6.0 PR #44 |
| §5.1 "WASI 覆盖:`clock_time_get` 覆盖为固定值(冻结 `Date.now`/`new Date`;QuickJS 内部 PRNG 以该值播种,同值即同 `Math.random()` 序列)" | **成立** | `quickjs.c:2879 ctx->random_state = js__gettimeofday_us()`;`quickjs.c:1396 xorshift64star` |
| §5.1 "`random_get` 覆盖为确定性填充" | **成立**(需要 host 主动覆盖) | `wasi-shim.js#random_get` 默认 `crypto.getRandomValues`(非确定) |
| §5.1 "`timezoneOffset` 固定为 0" | **成立** | `dist/index.js#applyLimits` 接受固定数字 |
| §5.1 "不加载任何 `.so` 扩展" | **成立**(默认 `extensions` 缺省) | `QuickJSOptions.extensions?` 为可选 |
| §5.1 "`vm.executePendingJobs()` 每 tick 排空" | **成立**(方法本身 while-loop 排空) | `dist/index.js#executePendingJobs` |
| §5.2 "中断超限 VM 中断后仍可用,无需重建" | **成立** | README §"Interrupt Handler" 明示 VM 仍可用 |
| §5.2 "WASM trap 不可捕获 → 重建 VM" | **v3.3.0 成立;HEAD 加 maxStackSize 后部分 trap 可变可捕获** | CHANGELOG v3.6.0 |
| §5.3 "指令计数 … 回调须保持轻量" | **成立 + 应增补**:触发粒度 ~1/10000 opcode,回调内自增 `count*=10000` 或文档/票文显式说明 | `quickjs.c:556` |

---

## §8 必须实测(harness 票承接,文档层无法定论)

下列条目要么是封装层未承诺的实现细节,要么是依赖运行时行为必须用沙箱行为实测 harness 才能钉死的:

1. **interruptHandler 实测开销**:回调经 WASM 边界 `env.host_interrupt → hostInterrupt() → vm.interruptHandler()` 的单次调用耗时,以及每 10000 opcode 一次的摊销——决定 hld §12 #1 的指令上限取值。
2. **`maxStackSize` 阈值标定(若升 HEAD)**:在 0..512 KB 范围内,实际触发 `RangeError: Maximum call stack size exceeded` 的临界点;以及 WASM 物理 1 MB 栈与 maxStackSize 的关系——决定栈 trap 的实际频率。
3. **memoryLimit 阈值标定**:`malloc_usable_size` 在 wasi-libc 下的实际占用与配置的偏差;3.3.1 修复后的"headroom"具体数值——决定 hld §12 #2 的内存上限取值。
4. **默认全局面的穷举清单**:v3.3.0 锁版下"宿主不注入任何东西时,global 上还看得到哪些名字"——需要在 jsdom + quickjs-wasi 跑一个空 `evalCode('')` + dump global 来枚举;至少要把 `Date`、`performance`、`atob`/`btoa`、`console`(若有)、`structuredClone`(若有)、`crypto`(无扩展是否还在全局)钉死。
5. **WASI libc 启动期 `random_get` 调用次数**:首次 `JS_NewContext` 时 wasi-libc 的 `arc4random_buf`/`getentropy` 走 `random_get` 的次数与字节数,影响 PRNG 初始化阶段可复现性——目前 README 只承诺"覆盖即可",没说覆盖的次数。
6. **interruptHandler 在 `JS_ExecutePendingJob` 路径下的归零行为**:quickjs-ng 源码显示 `JS_ExecutePendingJob` 也调用 `js_poll_interrupts`,但计数器重置是否与同步路径完全一致——hld §5.2 async 路径行为依赖于它。
7. **`Promise` 在每 tick 内的最多排空次数 / 嵌套深度上限**:quickjs-NG 默认对 job 队列没有深度限制,但宿主实现的 `executePendingJobs()` 只跑一轮——脚本若 `while(!done) queueMicrotask(...)` 是否会被中断、是否会被 interrupt handler 兜住。
8. **Promise 跨 tick 残留的实际表现**:hld §5.1 假设"每 tick 排空"是 host 责任,实测需要确认:若 host 漏调 `executePendingJobs()`,那些回调在下一 tick `callFunction(loopFn)` 之前是否还会被驱动?`callFunction` 内部是否会顺带排一次?
9. **stack-size 与 JS-level 递归的对应**:QuickJS-NG 的 `JS_ThrowStackOverflow` 在嵌套函数调用与嵌套 JSON 序列化 / parser 这两类递归上的边界深度差——决定 `maxStackSize` 阈值是否需要按工作负载分档。
10. **module-mode 不配 loader 时**:`import './nonexistent'` 的具体异常类型与是否被 `try/catch` 捕获——hld §6.2 在静态层挡了 import,运行时是否还需要给 module-mode 显式 noop loader 是开放项。
11. **`random_get` 在 wasi-libc libc 启动期间的调用是否在 `JS_NewContext` 之前**:若在之前,覆盖 `random_get` 也要影响 QuickJS 启动时已经使用的随机源;若在之后,只影响运行时调用。需要时序验证。
12. **Memory accounting 真实误差**:v3.3.1 修复后"`memoryLimit` 现在实际约束保留内存"的具体误差量级——决定沙箱预算与 QuickJS `getMemoryUsage().mallocSize` 的口径是否对账。

---

## §9 给 map.md / 主线程的提示

- 票里只放结论与链接;细节全部在本文件。
- hld §5.0 / §5.3 涉及 `interruptHandler` 的措辞应改为"按每 10000 条 opcode 触发一次,host 自乘 10000 计数";或在 §5.0 增加"按 quickjs-wasi v3.3.0 锁版行为"明示。
- hld §5.0 的"深递归无 `JS_SetMaxStackSize`"在升级到 v3.6.0+ 时需要补一段"v3.6.0 起可配 `maxStackSize`,部分栈溢出转成可捕获 RangeError,WASM 物理栈 trap 仍存在"。
- 票 01 的"必须实测"清单(§8)已与 spike/harness 票承接——后者应把这 12 项填满。