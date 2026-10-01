# rules-v1 契约草案(prototype)

Type: prototype
Status: resolved
Blocked by: 03, 04, 05

## Question

做一份**throwaway 契约草案**(`docs/rules-v1` 的粗稿,放 `.scratch/rules-calibration/draft/`,不正式落库),供模型只读它生成基准脚本、并由人对措辞反应:

1. `rules.md` 骨架:机制说明、结算管线顺序(hld §4.3 的顺序即规范)、确定性约束显式说明(srs FR-10 AC3:哪些行为被禁止/裁决一致);
2. `api.md` 骨架:六类 intent 与查询/action 函数签名语义(srs FR-3 AC2:不读实现即可正确调用);
3. **异常与出局的披露措辞**(①「沙箱与预算机制定案」留下的尾巴):VM 重建会清零模块级记忆、`exceptionTicks` 续算不清零——这些算不算规则面事实、在 `rules.md` 写到什么颗粒度,若牵动 gdd《异常与出局》的表述在此提出修改建议;
4. 数值表位置留桩(正式版由 `schema` 包 + `rulesets/v1.json` 生成,hld §2.2.5),草案里直接贴已定案取值即可。

产出:可读草案 + 一份"措辞待裁清单"(哪里可能被模型误读)。这是原型,不是交付物——正式落库在图外 hand-off。

## Answer

分支说明:本票的问题是静态契约草案,prototype 技能的 LOGIC(可点击 HTML 状态机演示)/UI(多版式路由)两个分支都不适用——交付物取最接近 LOGIC 意图(“在写实现前先感受 API 形状”)的静态形态:纯 markdown 草案,无可运行代码。

交付物(4 文件,见 throwaway 分支 `prototype/06-rules-v1-contract-draft`):

- `.scratch/rules-calibration/draft/README.md`——throwaway 声明 + 盲写用法
- `.scratch/rules-calibration/draft/rules.md`——机制、七步管线(顺序即规范)、移动/经济/占领/战斗/胜负/异常/确定性约束、数值表(只贴 03/04/05 终值,其余 `TODO(归属)`)
- `.scratch/rules-calibration/draft/api.md`——快照语义、丢弃 vs 异常对照、查询/action 签名、最小 `loop()` 骨架、常量表
- `.scratch/rules-calibration/draft/wording-risks.md`——`原文→误读→改法` P0/P1/P2 共 15 条 + G1/G2/G3 三条 gdd 改字建议 + 待 07 追加的盲写卡点节

最高优先级待决项(07 盲写实证输入,06→终稿必须先结):

1. 脚本如何从快照认出自己的 index——草案只给候选 A/B + TODO,来源状态模型无答案;
2. 轮转优先 `(tick+index) mod 4` 取胜方向——来源只写“取胜者”,草案按“值大者胜”假设 + TODO;
3. `ERR_*` 全表中只有 `ERR_NOT_ENOUGH_RESOURCES` 在来源点名出现,其余为候选码,终稿以 `schema` 生成为准。

捕获:原型内容已提交至 throwaway 分支(分支外、无 main 合并),本票即上下文指针;main 只保留 srs v2.1 的验收口径变更(07 已改写为模型盲写,见该票)。
