---
status: accepted
---

# 沙箱选型:quickjs-wasi,且不为"未来换 VM"预留抽象层

每方脚本运行在独立 QuickJS VM(WASM 实例)中,v0 选定 `quickjs-wasi`(QuickJS-NG 编译为 WASM 的快照型 JS 运行时),版本锁死到 `package.json`(锁版值与基线理由见 hld §5.0)。同时决定**不为"未来可能换 VM"保留抽象层**——那是投机抽象;host 侧 `Runner` 缝只为可测性存在,出现第二个真实 VM 实现之前不新增抽象层。机制细节归 hld §5,实测依据归 `.scratch/sandbox-budget/`;本 ADR 只记取舍。

## Considered Options

- **QuickJS 原生嵌入(node native addon)**:否——自带工具链与构建面,且把"一方失控"升级为进程级风险;WASM 线性内存隔离的审计面更小。
- **WASM + fuel 指令计量**:否——fuel 只管 WASM 指令,JS 语义层(异常/内存/异步排空)仍需自行拼装,WASM trap 滥用面反而更大。
- **isolated-vm(V8 isolate)**:否——JIT 与快照行为使确定性重放难证,预算计量无稳定挂点。
- **worker_threads 去全局**:否——"拿掉全局"的审计面大于"不给能力",且宿主时钟与线程调度会泄入对局。

## Consequences

- 换 VM 的真实成本 = 重写 `QuickJsRunner` + 重跑确定性与预算的全部实测,不是插拔——有意取舍,换取 v0 少一层间接。
- 升级 `quickjs-wasi` 必须重跑重放一致性测试与沙箱行为复测;上游缺陷(如 OOM 异常 fallback 抛 `null`)按"不 patch 宿主、留升级条款"处置(升级条款见 hld §5.3)。
