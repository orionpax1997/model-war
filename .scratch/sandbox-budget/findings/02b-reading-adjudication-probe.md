# 读数判据制探针:refcount 盲区、runGC 开销与读数封顶(票 06 第二轮)

票「OOM 异常被 guest 吞掉的 host 检测兜底」第二轮 grilling 的测量输入,修正并细化 [02](02-oom-swallow-detection.md) 的 ④⑤ 两项。

- 环境:`quickjs-wasi@3.6.2`,`memoryLimit = 8MB`,Node v24.15.0(Linux x64)。
- 复现:原始脚本与输出在 [spike/probe-06/](../spike/probe-06/)(`probe.mjs` 主探针、`diag.mjs` 单对象开销、`output.txt` 原始输出);未修改 spike 既有文件。
- **与 02 的冲突裁决**:02 ④ 的"`gcThreshold=∞` 即可让读数贴住峰值"**仅对循环引用成立**;02 ⑤ 的"`soft_limit = memoryLimit − 64KB`"**不是操作性模型**——本文 §3 的实测封顶为准。

## 结论总表

| # | 命题 | 结论 |
|---|---|---|
| 1 | 盲区闭合(`gcThreshold=∞` 封住丢引用) | **部分推翻**。QuickJS 是**引用计数**:plain 结构丢引用瞬间 `free`,与 `gcThreshold` 无关(丢 4.8MB plain 数组,mallocSize 差仅 72B)。**只有循环引用**呈现"读数贴住峰值"(default/∞ 皆然,因 auto-GC 阈值被引擎改写为 ~堆×1.5 后回收变稀);循环也只有手动 `runGC()` 稳定拆掉。⇒ "吞 OOM→丢引用→读数回落"的瞬时逃逸在 plain 结构下**真实存在** |
| 2 | `runGC()` 逐 tick 开销 | **0.5–3.3ms 固定扫描税**(2MB 堆 ~1.2ms / 7MB 堆 ~3.3ms 中位),回收量 ≈ 0(除非有循环垃圾,此时可回收 MB 级)。开销随堆中 atom/对象数线性增长 |
| 3 | 读数封顶 | **`memoryLimit − 最大单次分配`**(不是 −64KB:quickjs-ng 的 OOM 检查是 `malloc_size + size > malloc_limit − 1`)。实测 8KB 逐块分配:OOM 前 mallocSize 封顶 95.96%、OOM 后 98.12%(next_alloc ≈157KB);一次性分配 1MB 会封在 limit−1MB。`memoryUsedSize` 比 `mallocSize` 低 0.5–1MB(不含 free pool) |
| 4 | `gcThreshold` 语义 | 默认 256KB;设 `Infinity` 被 int 截断存为 `0`(=禁 auto-GC,与显式设 0 等价);**auto-GC 发生后引擎把阈值改写为 ~mallocSize×1.5**,手动设定不跨 auto-GC 周期存活;手动 `runGC()` 总是执行、不改写阈值。⇒ 想锁固定阈值须每 tick 重设,或干脆 0 + 手动 `runGC()` |

附:`new Array(1000).fill(0)` 真实成本 ≈ 8,622B(数据 8,000B + 块头/分配器开销/JS 对象属性,见 `probe-06/diag.mjs`)。

## 对票 06 判据设计的推论

1. 判据取 **tick 末 `runGC()` 后**读数(=存活集):与 auto-GC 时机无关、plain/cyclic 对称;瞬时垃圾(refcount 已还)与 Q5 接受的残余一致,不计入。
2. 阈值须取在 §3 封顶之下才有触发空间;取值归预算参数标定图。
3. "瞬时借满即还"型触顶尝试无法被读数判据抓到(refcount 即释)——堵死只能 patch 宿主(sticky OOM 标志),票 06 已裁决不 patch、留升级条款。
