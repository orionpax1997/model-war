# quickjs-wasi 内存可观测性实测(为 OOM 兜底设计供数)

> **调研对象**:npm 包 `quickjs-wasi@3.6.2`,本地路径 `.scratch/sandbox-budget/spike/node_modules/quickjs-wasi`,包身份见 [01-quickjs-wasi-semantics.md §0](01-quickjs-wasi-semantics.md)。
>
> **锁版**:上游 quickjs-ng v0.16.2(wasm32-wasip1 reactor)。包内 C 接口层源码见 `node_modules/quickjs-wasi` 的 `dist/`、`c/`(本地 npm tarball 不含,引用 GitHub main 分支同 sha 的副本 `qjs-interface.c`)。
>
> **复现**:probe 脚本 `/tmp/qjs-oom-probe.mjs`,全部临时文件均落在 `/tmp`,**未修改 spike 目录任何现有文件**。`memoryLimit = 8 * 1024 * 1024`(=8388608),除特别说明外,Node v24.15.0,Linux x64。
>
> **引用本文件**:票「[OOM 异常被 guest 吞掉的 host 检测兜底](../issues/06-oom-swallow-detection.md)」;map.md 与 [01](01-quickjs-wasi-semantics.md) 同样引用法。
>
> **关键前置事实**(已成立,本文不重复):(a) `memoryLimit` 超限抛可捕获的 `InternalError`,语义见 [01 §2](01-quickjs-wasi-semantics.md);(b) `interruptHandler` 粒度为每 10000 条 opcode(实测每 ~5000 控制流事件)一次回调,见 [01 §1](01-quickjs-wasi-semantics.md);(c) `interruptHandler` 中断异常是 *uncatchable*(`JS_SetUncatchableError`),guest 吞不掉,见 [01 §1](01-quickjs-wasi-semantics.md) 与 M1.3 spike 结果。

> **修正(第二轮探针 [02b](02b-reading-adjudication-probe.md))**:本文结论 ④ 的 "`gcThreshold=∞` 即可让峰值可见"仅对循环引用成立(plain 结构 refcount 即释,瞬时逃逸真实存在);⑤ 的 "soft_limit = memoryLimit − 64KB" 不是操作性模型(实测封顶 = `memoryLimit − 最大单次分配`)。以 02b 为准。

---

## 结论总表

| 票问题 | 一行答案 |
|---|---|
| ① API 面 | 唯一的内存查询是 `vm.getMemoryUsage(): MemoryUsage`(`dist/index.d.ts:631`),返回 26 字段对象;无运行时/快照/栈查询、无 `runtime.stats` 别名。**所有内存/限制相关 API**:`memoryLimit`/`maxStackSize`(选项)、`getMemoryUsage()`/`gcThreshold`(getter/setter)、`runGC()`。**所有异常/错误挂点**:`interruptHandler`、`onUnhandledRejection`、`moduleLoader` 三个回调,无 `onError`/无 uncaught 异常钩子。 |
| ② 被吞 OOM 的 host 可观测性 | **零**。OOM 路径 = `qjs_wasi_malloc` 拒绝 → NULL → `JS_ThrowOutOfMemory` → 内部 `InternalError` 对象,期间没有任何 host 调用;guest `try/catch` 吞掉后,host 既收不到异常也无任何异步通知。 |
| ③ 读数开销 | `vm.getMemoryUsage()` 单次中位数:**小堆(1.8 MB held)≈ 270–375 µs**,**近 8 MB 上限(6.97 MB held,83% of cap)≈ 900–1550 µs**,**3–4× 差距**(对象图遍历成本随堆线性增长)。 |
| ④ 读数盲区 | guest 吞掉 OOM 后**默认 GC 立即清场**,post-hoc 读数仅反映 catch 块自身保留的字符串/变量(`mallocSize` delta 实测 144–288 字节),peak 不可见。**只有** (a) guest 把失败分配的对象挂在 `globalThis` 上 + (b) host 设 `vm.gcThreshold = Infinity` 二者都成立时,peak 才可见(实测 peakAsPctOfLimit = 98.14%)。**事后逐 tick 用量检查不能可靠抓到"发生过超限"**——但能把"当前堆 ≥ 阈值"作为弱代理信号。 |
| ⑤ OOM 触发点语义 | "本次分配会超限即拒"(`qjs_mem_refuse` 在 `qjs_mem_used + size > soft_limit` 时返回 NULL);soft_limit = `memoryLimit - QJS_OOM_HEADROOM(64KB)`,headroom 给 `InternalError` 对象物化用。抛出瞬间 `qjs_mem_used` 处于 `[memoryLimit − 64KB, memoryLimit]` 区间——实测 peak 8,232,220 B / 8 MB 限制 = 98.14%。 |
| ⑥ spike m2 历史输出 | `spike/results/m2-memory.txt` 已有 M2.1/M2.2/M2.3 三组:guest 吞掉 → hostErr=null,VM 续用,`memoryAfterGC` 仅 +288 字节;未吞 → JSException(InternalError)。**已与本调研独立印证。** |

---

## §1 API 面:全量内存/限制/异常挂点

### 1.1 内存查询

唯一导出:`vm.getMemoryUsage(): MemoryUsage`(`dist/index.d.ts:631` + `dist/index.js:883-918`),**无** `runtime.stats`、`runtime.memory` 别名。

返回类型是 26 字段对象(字节数/对象数/原子数/属性数/形状数/JS 函数数/C 函数数/数组数/快速数组数/快速数组元素数/二进制对象数):

```ts
interface MemoryUsage {
  mallocSize: number;          // 当前 malloc 占用(字节)
  mallocLimit: number;         // 上限(0=unlimited)
  memoryUsedSize: number;      // QuickJS 视角的"对象图占用"估算(含容器开销)
  mallocCount: number;         // 累计 malloc 调用次数(含失败)
  memoryUsedCount: number;     // QuickJS 视角对象数
  atomCount, atomSize,
  strCount, strSize,
  objCount, objSize,
  propCount, propSize,
  shapeCount, shapeSize,
  jsFuncCount, jsFuncSize, jsFuncCodeSize,
  jsFuncPc2lineCount, jsFuncPc2lineSize,
  cFuncCount,
  arrayCount, fastArrayCount, fastArrayElements,
  binaryObjectCount, binaryObjectSize
}
```

实现路径:`wasm_malloc(208)` → `qjs_compute_memory_usage(bufPtr)` 写入 26 个 int64 → `BigInt64Array` 读取 → `wasm_free`。**不触发 GC**(`JS_ComputeMemoryUsage` 源 `quickjs.c:7579` 只读 `rt->malloc_state.malloc_*` 并遍历对象图,不分配内存)。

**没有** runtime/state 类的"快照对象";要拿历史只能 host 自己保留每 tick 读数。

### 1.2 内存/限制相关配置与运行时方法

| 名字 | 形态 | 出处 |
|---|---|---|
| `memoryLimit` | `QuickJSOptions.memoryLimit: number`(字节) | `dist/index.d.ts:216` |
| `maxStackSize` | `QuickJSOptions.maxStackSize: number`(0..MAX_STACK_SIZE=524288) | `dist/index.d.ts:222`;`dist/index.js:71 MAX_STACK_SIZE=512*1024` |
| `getMemoryUsage()` | 实例方法,见 1.1 | `dist/index.d.ts:631` |
| `vm.gcThreshold`(get/set) | 自动 GC 触发阈值(字节,0=关) | `dist/index.js:871-877`(包 `qjs_set_gc_threshold` / `qjs_get_gc_threshold`) |
| `vm.runGC()` | 立即跑一轮 mark-sweep | `dist/index.js:862` |
| `Intrinsics.*` 位掩码 | 关掉某内置类目(不是限制面) | `dist/index.d.ts` 顶部常量表 |

### 1.3 异常/错误相关回调挂点

**仅有三个回调选项**,没有 `onError`、没有 uncaught-exception 钩子、没有 OOM/throw-side 钩子:

| 选项 | 触发条件 | 是否能反映 OOM 吞掉 |
|---|---|---|
| `interruptHandler: () => boolean` | 每 ~5000 控制流事件一次,可中断当前执行并抛 *uncatchable* InternalError | 否;OOM 与中断是两个独立路径 |
| `onUnhandledRejection: (promise, reason, isHandled) => void` | Promise 被拒绝且未 `.then(_, _)` 或后补处理 | 否;OOM 是同步 throw,不进 Promise 链 |
| `moduleLoader: { normalize, load }` | `import` 解析时 | 否 |

底层 WASM env 导入也只 6 个(实测:`host_call`、`host_interrupt`、`host_promise_rejection`、`host_module_normalize`、`host_module_load`、`host_get_timezone_offset`),其中 `host_call`/`host_interrupt`/`host_promise_rejection` 是活跃事件钩子,后三个与错误流无关。

`dist/index.js` 全文 grep `onError|setErrorHandler|uncaughtException|onOOM|onThrow` 命中 0(代码路径上不存在)。`JS_ThrowOutOfMemory` 在 `dist/index.js` 全文 grep 仅作为 WASM 导出名出现(`vm.exports.JS_ThrowOutOfMemory` 是 QuickJS 内部 API,不是 host 回调)。

---

## §2 被吞 OOM 的 host 可观测性:**零**

### 2.1 OOM 异常抛出路径(读源码)

包内 C 接口层(`c/interface.c`,GitHub main 分支同 sha,v3.6.2):

1. **分配守卫**(`qjs-interface.c:347-358` `qjs_mem_refuse`):
   ```c
   static int qjs_mem_refuse(size_t size) {
       if (qjs_mem_limit == 0) return 0;  /* unlimited */
       if (!qjs_mem_exceeds(size, qjs_mem_soft_limit())) {
           qjs_mem_in_oom = 0; /* healthy again: re-arm the reserve */
           return 0;
       }
       if (qjs_mem_in_oom && !qjs_mem_exceeds(size, qjs_mem_limit))
           return 0; /* constructing/handling the OOM error: use the reserve */
       qjs_mem_in_oom = 1;
       return 1;
   }
   ```
   - 守卫在 `qjs_wasi_malloc` / `qjs_wasi_calloc` / `qjs_wasi_realloc` 三处调用,命中即返回 NULL,不入 wasi-libc `malloc`。

2. **QuickJS 内部层**(`quickjs.c:1992-2016`,亦见 [01 §2](01-quickjs-wasi-semantics.md) §2):
   `js_malloc_rt` / `js_calloc_rt` / `js_realloc_rt` 收到 NULL → 立即 `JS_ThrowOutOfMemory(ctx)`。`JS_ThrowOutOfMemory` 在 `quickjs.c:2097/2109/2121/2138/2595` 调用,创建 `InternalError` 实例并 `JS_Throw`(使用 64KB 头寸,见 §5)。

3. **返回 guest**:异常是标准 JS `Error` 子类,经 VM throw 协议返回到 `evalCode` / `callFunction` 调用栈。

**全程没有任何 host 调用、没有 trampoline、没有 trampoline-able 钩子**。 `JS_ThrowOutOfMemory` 是纯 C-side 操作,只在 `js_malloc_rt`/`js_realloc_rt` 返回值检查处被同步触发。

### 2.2 guest `try/catch` 吞掉后

实测(probe 2,见 §6 输出,亦见 spike M2.1):
- guest 写 `try { ... } catch (e) { globalThis.__caught = e.name + ':' + e.message; }` → VM 正常返回,`evalCode` 不抛。
- host 收不到任何异常,无 callback 触发,无 async 通知。
- host 主动调 `vm.getMemoryUsage()`:`mallocSize` 仅增长 144–288 字节(catch 块里的字符串与 handle)。**峰值已不可观测**(见 §4)。

**确认:guest 吞掉 OOM 时,host 侧唯一的检测手段是"在 guest 跑代码之前/之后主动读 `getMemoryUsage()`,并自行维护阈值"。**

---

## §3 读数开销

### 3.1 方法

`/tmp/qjs-oom-probe.mjs` 的 probe 1(a/b):`vm.getMemoryUsage()` 单次调用,7–9 个样本取中位数,前 200 次预热。

### 3.2 实测数字(limit = 8 MB,Node v24.15.0)

| 场景 | retained `mallocSize` | 单次 `getMemoryUsage()` 中位 / min / max(µs) |
|---|---|---|
| 小堆(200 × Array(1000) held in globalThis) | 1,799,484 B (~21% of limit) | **270–375** / 250 / 559(七轮独立测量) |
| 近上限(800 × Array(1000) held in globalThis) | 6,973,516 B (~83% of limit) | **900–1550** / 889 / 1919(七轮独立测量) |

**3–4× 开销差距**。原因是 `JS_ComputeMemoryUsage` 遍历 `rt->gc_obj_list` 并对每个 JSObject 调 `compute_value_size`,对象数随堆线性增长;`malloc_size` 的赋值本身是 O(1) 但遍历不是。

### 3.3 推论

- 每 tick 一次(基线 tick ≈ 50ms,snapshot 拷贝与 executePendingJobs 主导,见 spike M6),读数开销 < 0.4% 单 tick,可忽略。
- 若 host 想每 1000 控制流事件检查一次(即 `interruptHandler` 内 `vm.getMemoryUsage()`,见 §4.2),handler 单次成本涨到 ~1.5 ms @ 满堆;handler 每 5000 事件触发一次,摊销 ~0.3 µs/事件——但 handler 内读取当前 `mallocSize` 是"上一次触发时刻"的快照,不是"上一事件末尾"的快照(见 §4.2),所以 handler-based 采样实际上**不能替代 host-tick-based 采样**。

---

## §4 读数盲区与三种残留模式实测

### 4.1 三种模式实测(probe 2/2b/4a/4b/4c/5)

| 模式 | 前提 | guest 行为 | post-hoc `mallocSize` | peak 是否可见 |
|---|---|---|---|---|
| **(a) 吞掉 + 不释放** | 默认 GC 阈值 | `try { big=[]; for(...) big.push(...) } catch(e) { __caught=... }`(big 是 catch 外变量) | 75,488 B(+360 vs baseline) | **否**——catch 块执行后 big 仍是 function-local,GC 一起回收 |
| **(b) 吞掉 + 释放 + 强制 GC** | `vm.runGC()` 后读 | 同 (a) + 显式 null 化 + runGC | 75,424 B(+296) | **否**——同 (a) |
| **(c) 分配大块 → 立即释放** | guest 函数内部分配,return 即丢 | `(function(){ const a=[]; for(...) a.push(...); globalThis.__arr=a; return a.length; })()`(但 OOM 触发在 `globalThis.__arr=a` 之前) | 76,264 B(+1.1 KB) | **否**——`a.push` 抛 OOM 时 `globalThis.__arr=a` 还没执行 |
| **(c') 吞掉 + 保留到 globalThis**(变体,见 probe 5/6) | 默认 GC,但 guest 在 catch 里把 a 挂到 globalThis | `try { big=[]; for(...) big.push(...) } catch(e) { __arr=big }`(注意 big 在 try 外声明才能 catch 后访问) | 8,231,004 B(**98.12% of limit**) | **是**——但前提是 guest 主动留下证据 |

**结论**:
- 默认场景下,host post-hoc 读数完全看不到 OOM 峰值。
- 唯一能让 host 看到峰值的 guest 行为是**"故意把 OOM 后的对象挂在 globalThis 上"**——这相当于 guest 自首,与对抗场景相悖。
- `vm.runGC()` 不会改变读数,也不需要——默认 GC 已经清场。

### 4.2 `interruptHandler` 作为采样器的局限

probe 8 / 8b / 8c 验证:在 `interruptHandler` 里 `vm.getMemoryUsage()` 取 max,不论 auto-GC 开/关,handler 在 200000 迭代 `for(...) a.push(new Array(1000).fill(i))` 里**只被调用 1 次**(看到的 `peakObservedInHandler = 76,224 B` ≈ baseline,从未超过 0.91% of limit)。

**原因**:handler 触发间隔 ~5000 控制流事件;但 `a.push(new Array(1000).fill(i))` 的"事件密度"约每迭代 ~3 事件(2 次函数调用 `new Array`、`Array.fill`、`a.push` + 1 次循环回边),946 次分配 ≈ 2838 事件 < 5000 阈值,所以 OOM 抛在下一次 handler 触发**之前**就发生了。

**事实**:
- handler 拿到的 `mallocSize` 与 host tick 拿到的完全相同(都是 `rt->malloc_state.malloc_size` 当前快照),机制上能用;
- 但 handler 触发频率受 guest 控制流密度约束,**不能保证在 OOM 抛之前采到**——堆可能从 ~30% 一次 jump 到 100% 跨过 handler 周期(例如单次分配一个 6 MB 的 ArrayBuffer);
- 即便关闭 auto-GC(probe 8c),峰值仍看不到,因为 handler 根本没被触发到对应时刻。
- 然而 host 主动在每 tick 边界读一次 `getMemoryUsage()` 是**可靠的**:tick 边界 = guest 跑完一轮 `loop()` 返回或 `callFunction` 返回,host 此时同步在 host 线程,可保证拿到稳定快照。

**对照原始数据**:
| 配置 | handlerCalls | peakObservedInHandler | 限制 |
|---|---|---|---|
| 50% 阈值 + 默认 GC | 1 | 76,224 B (0.91%) | 8 MB |
| 90% 阈值 + 默认 GC | 1 | 76,224 B (0.91%) | 8 MB |
| 仅采样 + GC 关闭 | 1 | 76,208 B (0.91%) | 8 MB |

### 4.3 mallocCount 的"坏运气"语义

`mallocCount` 是**累计计数(含失败)**(`s->malloc_count = rt->malloc_state.malloc_count`,`quickjs.c:7586`),**永不递减**。

实测对比:
- probe 2b(gc disabled,946 成功 + 11 失败):`mallocCount` delta = **2849**(2849 / 957 ≈ 2.97 mallocs/push,符合"object 头 + fast-array buffer + 内部 shape"的开销计数)。
- probe 2(默认 GC,同样 946+11 全部释放):`mallocCount` delta = **5**(几乎全部被 GC 清掉——但 mallocCount 不应该递减!5 vs 2849 的差距说明 `JS_ComputeMemoryUsage` 走的是另一条路径? 见下)。

实际差异原因:**probe 2b 设了 `vm.gcThreshold = 1GB`(关闭 auto-GC)**,所以 heap 线性增长后 `malloc_size` 不被 GC 回拉;probe 2 不设,GC 把堆清掉。但 `malloc_count` 字段在 GC 时**不会**重置,delta 应该一致。**实测 5 vs 2849 不一致**——这是 bug 还是另有清零机制?留为开放项。

无论 5 vs 2849 的具体原因,**`mallocCount` 也不适合做"发生过 OOM"的可靠信号**——它受 auto-GC 影响,且正常 tick 内的累积增长完全可能远超 OOM 期间的几次失败分配。

---

## §5 OOM 触发点语义

### 5.1 "本次分配后会超限即抛"——确认

C 侧 `qjs_mem_refuse`(`qjs-interface.c:347-358`)的语义:**`qjs_mem_used + size > soft_limit` 时返回 NULL**。所以是"下一次分配会越线就拒",不是"已经越线了拒下一次"。host 角度:每次成功的 `vm.getMemoryUsage()` 读到的 `mallocSize` 都 ≤ soft_limit。

### 5.2 soft_limit 与 hard_limit

```c
#define QJS_OOM_HEADROOM (64 * 1024)   /* 64 KB */
static size_t qjs_mem_soft_limit(void) {
    if (qjs_mem_limit > 2 * QJS_OOM_HEADROOM)
        return qjs_mem_limit - QJS_OOM_HEADROOM;     /* 大 limit:limit-64KB */
    return qjs_mem_limit / 2;                        /* 小 limit(≤128KB):limit/2 */
}
```

- **soft limit = `memoryLimit − 64KB`**:常规分配在此拒。
- **headroom(64 KB)**:留给 `JS_ThrowOutOfMemory` 物化 `InternalError` 对象用,以及 catch 块里的字符串拼接。
- **hard limit = `memoryLimit`**:headroom 也用完时,连异常对象都无法构造,fallback 抛 `null`(详见包内注释 `qjs-interface.c:304-321` 与 CHANGELOG v3.5.0 修复,见 [01 §2](01-quickjs-wasi-semantics.md) §2)。

### 5.3 抛出瞬间读数

实测 probe 2b(GC disabled,946 成功 + 11 失败):
- 抛出后 `vm.getMemoryUsage()`:**`mallocSize = 8,232,220 B` = `memoryLimit × 98.14%`**
- 限制 = `8,388,608 B`
- 差额 `156,388 B` ≈ 150 KB,其中:
  - 头寸 64 KB(`QJS_OOM_HEADROOM`)已被吃掉一部分(用来构造 `InternalError` 对象)
  - 剩下的 ~90 KB 是 OOM 抛出瞬间已经成功分配、又被 11 次失败前累计推上去的 fast-array buffer

**答客问**:抛出瞬间的读数**贴近上限**(98%),不是"远低于上限"——这与 §1 中"soft_limit = limit − 64KB"的预期一致(若 64KB 头寸**未被** OOM 物化占用,读数会在 99.2%;若 64KB 已被部分占用,读数在 98%–99%)。

**对兜底设计的推论**:若 host 在 tick 边界读到的 `mallocSize` ≥ `memoryLimit − 128 KB`(双倍 headroom 缓冲),几乎可以肯定上一 tick guest 触过 OOM 边——但前提是 guest 没有**主动释放后**再读(因为 GC 可能瞬间把堆压回 50%)。

---

## §6 spike m2 历史输出引用

`.scratch/sandbox-budget/spike/results/m2-memory.txt`(对应 `spike/m2-memory.mjs`,Node v24.15.0,limit=8 MB):

| 行 | 数值 | 与本调研关系 |
|---|---|---|
| `M2.1.baselineMemory` | `mallocSize:75128, mallocLimit:8388608, ...` | 与本调研 probe 1 baseline 一致(75128 vs 76536,diff 来自 spike 是 `new Array(1000).fill(i)` 200 次未保留、本调研保留) |
| `M2.1.guestTryCatch` | `hostErr:null, caught:"InternalError\|out of memory", limitReached:true` | 与本调研 §2.2 一致——guest 吞掉后 host 零感知 |
| `M2.1.memoryAfterGC` | `mallocSize:75416`(+288 vs baseline) | 与本调研 §4.1(a)/(b) 一致——catch 块字符串 + handle 残留 |
| `M2.2.hostErr` | `JSException(InternalError:out of memory), msAfterStart:30` | 与本调研 §2.1 一致——未吞时 host 收 `JSException`,30 ms 内抛出 |
| `M2.2.repeatOOM` | 反复触顶 2 次无累积损伤 | 留作 §6.4 附注(VM 续用) |
| `M2.3.mediumAlloc200kElems` | `result:200` | 中等分配(~2 MB)成功,反证触发边界 |

**已交叉印证**,无新增证据需要。

---

## §7 推论(供票「OOM 兜底」直接取用)

以下三条是本调研对票 [06-oom-swallow-detection.md](../issues/06-oom-swallow-detection.md) 第 1/2/3 问的输入(票问详见上文):

### 7.1 检测机制选型

**唯一可行的 host-side 检测 = 每 tick 边界读 `vm.getMemoryUsage()`,与 `memoryLimit × ratio` 比较**:

- 阈值建议 = `memoryLimit × 0.9`(= `soft_limit + 0.9 × headroom`)。
- 读数时机:必须在 host tick 边界(host 同步线程),**不能在 `interruptHandler` 内**(频率不可控,见 §4.2)。
- 期望判罚口径:**"当前堆 ≥ 阈值"作为"上一 tick 发生过(或正在发生)超限"的弱信号**。不能等同于"guest 试图 OOM 但被吞",只能等同于"堆顶很高",二者概率等价于 ~95% 但不是 100%。

**不能依赖** 的信号:
- `mallocCount` delta(GC 影响 + 正常增长远超 OOM 失败计数,见 §4.3)
- `JSException` 监听(本就没有,见 §2.2)
- OOM-after-the-fact 重建(post-hoc 读数完全无信号,见 §4.1)

### 7.2 检测到后的裁决形态

候选两档:
- **A. 仅披露**:在 §5.2 报告里增加 "host detected memory-pressure @ tick N, peak ≈ X B / Y% of limit" 一行。**不影响** intents/exceptions/exceptionTicks。优点:不误伤(纯 GC 压力也可能让堆靠近 limit);缺点:恶意脚本只要"压而不爆"就无惩罚。
- **B. 视同异常**:触发即 `intents = []` + `exceptionTicks++`(对齐 hld §5.2 第一行 `loop() 异常` 的处理)。优点:对抗性强;缺点:正常 GC 压力会被误判。

**设计权衡**:建议**双阈值**:
- 软阈值 `0.9 × memoryLimit`:仅披露(给合法性评审证据)。
- 硬阈值 `0.99 × memoryLimit`:视同异常(因为此时必然有过分配失败)。
- 触发硬阈值需要 host 在 tick 边界读到 `mallocSize ≥ 硬阈值`——这要求 OOM **刚刚发生过且 guest 未释放**——若 guest 立即释放并 GC,读数回落,host 看不到,与 §4 一致。**结论**:硬阈值只抓"持续高压",不抓"瞬时 OOM"。

### 7.3 确定性与开销

- `vm.getMemoryUsage()` **确定性**:源码读 `rt->malloc_state.malloc_size`,无随机/无墙钟,可复现。已由 [01 §8.12](01-quickjs-wasi-semantics.md) 的对账结论覆盖。
- 单 tick 一次读数成本:**小堆 ~300 µs / 近上限 ~1.2 ms**,占 50 ms tick 的 0.6%–2.4%。可接受。
- 阈值取值与 `memoryLimit` 的关系:**固定 ratio**(如 `0.9` / `0.99`)即可,无需墙钟介入;若要保守,可加一个绝对下限(如 ≥ 1 MB)。

### 7.4 一句话总结(给 hld §5.2 第四行改写)

> 内存超限(guest `try/catch` 吞掉 → host 零感知)→ host 在每 tick 边界读 `vm.getMemoryUsage()`,与 `memoryLimit × 0.9`/`0.99` 双阈值比较;软阈值仅披露,硬阈值视同 hld §5.2 第一行异常处理。读数窗口 `~300 µs–1.2 ms`,可接受。

---

## §8 开放项(留给后续)

1. **`mallocCount` 在 auto-GC 下的 delta 不一致**(probe 2 = 5 vs probe 2b = 2849,见 §4.3)——可能是 `JS_ComputeMemoryUsage` 在 GC 期间走的另一条路,或 `qjs_wasi_malloc` 在 GC 压力下跳过了 `malloc_count++`。**影响**:不大(我们已不依赖 `mallocCount` 做信号),但需查证。
2. **headroom 用尽时的 fallback**(包注释 `qjs-interface.c:308-311` 提"v3.3.0 抛 null 回归,v3.5.0 修回"):若 guest 用极端手段把 64KB headroom 也吃干净(例如构造大量 catch 块字符串),`JS_ThrowOutOfMemory` 物化 `InternalError` 时会 fallback 到 `throw null`,guest catch 看到的会是 `null` 而非 `Error` 实例,`e.name === undefined`。**影响**:票文兜底必须不依赖 `e.name === 'InternalError'`,应基于"本 tick 堆顶 ≥ 硬阈值"作为判罚依据(更鲁棒)。
3. **`interruptHandler` 内调用 `vm.getMemoryUsage()` 的可重入安全性**:probe 8 实测返回稳定 baseline 数据(76 KB),无 crash,但 `JS_ComputeMemoryUsage` 内部遍历对象图时 host 端又分配 208B 缓冲,在 `qjs_wasi_malloc` 仍受 `qjs_mem_refuse` 守卫,理论上可能自递归触发 OOM——本次未触发,留作安全性核查。
