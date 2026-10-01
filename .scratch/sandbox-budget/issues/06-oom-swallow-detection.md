# OOM 异常被 guest 吞掉的 host 检测兜底(grilling)

Type: grilling
Status: resolved
Blocked by: 02

## Question

实测(spike [FINDINGS §2](../spike/FINDINGS.md#2-内存上限memorylimit)):`memoryLimit` 超限抛 `InternalError: out of memory`,**guest `try/catch` 可捕可吞**,guest 吞掉时 host 全程无感知(`hostErr: null`)。hld §5.2 第四行"内存超限……触发情况在报告中披露"因此**缺检测机制**——脚本只要包一层 try/catch 就能让超限不留痕迹。这是异常裁决面的洞,与 trap 滥用面无关(由票「WASM trap 滥用的约束设计」拆出),单独成票设计 host 兜底:

1. **检测机制选型**:逐 tick `getMemoryUsage()` 阈值(超阈即视为披露事件)?异常钩子(quickjs-wasi 是否提供等价挂点,须查证)?还是两者取一/并用?
2. **检测到后的裁决形态**:仅披露(不判罚)?还是视同 §5.2 第一行异常(intents 置空 + `exceptionTicks++`)?注意 guest 可吞 ⇒ "发生过超限"与"当前占用高"是两回事,阈值检测抓的是后者。
3. **确定性与开销**:逐 tick 查询的开销量级;阈值取值与 `memoryLimit` 的关系(是否留水位线);判定是否可复现(不涉墙钟)。
4. **文档落点**:hld §5.2 裁决表第四行与 §5.3 内存上限行的改写;是否牵动 gdd《异常与出局》。

产出:机制选型 + 裁决形态 + hld 改写建议,供票「定案:沙箱选型与预算裁决形态」汇总裁决。

## Answer

**读数判据制**:内存预算判据从"OOM 事件"改锚为"tick 末存活堆读数"——guest 吞 OOM 时 host 零痕迹([findings/02 §②](../findings/02-oom-swallow-detection.md)),事件不可确证;判据锚定读数后吞与不吞同罪,且不依赖 guest 异常可见性。残余:"瞬时借满即还"型触顶尝试不判罚(refcount 即释,[findings/02b §1](../findings/02b-reading-adjudication-probe.md);上限 `memoryLimit` 本身不可突破,能力对所有选手平等);**不 patch 宿主**,留升级条款。

裁决记录:堵死逃逸、同轨判罚、不因"吞"加刑(防御式 `try/catch` 不罚);立不变量并精确化为**"预算判据必须锚定 host 可直接测量的量,不依赖 guest 异常可见性"**;精度优先(宁漏判不误伤,升级条款沿此预授权);判据 = tick 末 `runGC()` 后读数(GC 后存活集,plain/cyclic 对称,与 auto-GC 时机无关);软/硬双阈值(仿 §5.3 墙钟软/硬先例)。

### hld 裁决表修改建议(供票「定案:沙箱选型与预算裁决形态」汇总裁决,文档改动在定案后执行)

**A. §5.2 裁决表——原第四行(内存超限)替换为"内存判据"行**(第一行、trap 行、越权行沿票「WASM trap 滥用的约束设计」改写建议不变):

| 情形 | 处理 | 确定性 |
|---|---|---|
| 内存判据超限(该 tick 末存活堆读数 ≥ `memoryTickCeiling`) | 视同第一行(intents 置空 + `exceptionTicks++`);判据于每 tick 末 `runGC()` 后取 `getMemoryUsage().mallocSize`(与分配上限同记账口径),纯记账、可复现;**guest 吞掉 OOM 不影响判据**——判据锚定读数,不依赖异常可见性。残余条款:tick 内瞬时触顶后自行释放的分配不触发判据(分配上限本身不可突破),已在规则文档披露 | ✅ |

未被 guest 捕获的超限异常仍走第一行(host 可见)。表下注脚追加两句:"预算判据锚定 host 可直接测量的量,不依赖 guest 异常可见性";"OOM 异常身份不可靠(headroom 耗尽时 fallback 抛 `null`),引擎判定不得依赖 `e.name`"。

**B. §5.3 表格——内存侧三层**:
- "内存上限"行:`memoryLimit` = 引擎分配上限,超限转 JS 异常(未捕获按 §5.2 第一行);**上限本身不可突破**;
- 新增"内存判据"行:软/硬双阈值——硬 `memoryTickCeiling`(ruleset 参数)判罚 = 同第一行;软阈值(0.8×硬,推导)仅写报告披露 `memory-pressure`;实现 = 每 tick 末 `runGC()` → `getMemoryUsage()`,固定成本 0.5–3.3ms(标定注脚,入 NFR-3 考量);
- 参数表追加 `memoryTickCeiling` 入 `rulesets/v1.json`(取值归预算参数标定图)。

**C. §5.3 设计理由处补不变量句**:**"预算判据必须锚定 host 可直接测量的量,不依赖 guest 异常可见性"**(依据:guest 吞 OOM 时 host 零痕迹,findings 02/02b 两轮实证)。

**D. gdd《异常与出局》补一条,rules-vN 同披露**:**"内存判据:每 tick 末按该方存活堆占用判定,达 `memoryTickCeiling` 视同该 tick 异常;tick 内瞬时触顶后自行释放的分配不判罚(分配上限 `memoryLimit` 本身不可突破)。"**

**E. 确认项(供定案票)**:
1. 内存侧预算形态 = `memoryLimit`(硬上限)+ `memoryTickCeiling`(判罚线)+ 软阈值(观测)三层;
2. 标定注脚:硬阈值须 > 正常脚本 tick 末存活峰值 + 余量;**读数封顶 ≈ `memoryLimit − 最大单次分配`**(64KB 余量说法被实测修正,不采用);
3. `runGC()` 逐 tick 0.5–3.3ms 固定税入 NFR-3 考量;
4. **升级条款**:若赛中"瞬时触顶即释放"型脚本普遍牟利 → patch quickjs-wasi 加 sticky OOM 标志,判据回到确证事件(后备设计已评估,触发条件由运营定)。
