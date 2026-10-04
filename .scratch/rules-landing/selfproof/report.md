契约自证门禁：终稿契约 × 三份基准脚本 × 标定环的桩

口径（引用本读数时必须一起带）：
- 「整局 ≈440」是**单矿储量 125 时代、全矩阵平均**的数，**不是「四份基准脚本」的数**；
  基准脚本口径实测 351。这条命题的松紧度是被储量那一刀改掉的，不是被地图改掉的。
  本报告的数字另起一代：终稿契约 + 终稿基准脚本，与 440 / 351 都不可互比。
- **种子维度对消耗指标零方差**，每臂的有效独立样本只有 **4 个座位轮转**；
  本报告每臂 16 场 = 4 座位轮转 × 4 种子，**不得写成「16 场独立样本」，更不是「128 场独立样本」**。
- 消耗 = 全图储量 − 终局剩余，逐场校验恒等于全场采获之和（自洽校验见下）；分母是总储量
  （16 矿 × resourcePerSite 200 = 3200），不是单矿储量。
- 本轮三份脚本与 #13 那一轮的四份脚本**不可互比**（契约形态、移动层、错误处理三层都变了，
  抬头口径见 benchmarks/README.md）；可比的只有夹具、臂数、种子、判据与消耗口径。

夹具闸门：farmer6 四方自战 p100=479/479/479/479、delivered=3080/3080/3080/3080
（受控锚点 p100=479 / delivered=3080，逐字一致才跑正表）——一致，0% 漂移

产物：A=benchmarks/cell-a-melee-pressure/script.js　B=benchmarks/cell-b-expansion-economy/script.js　C=benchmarks/cell-c-claim-no-harvest/script.js

① 零静态违规：过（静态校验器逐份判定，--max-bytes 8831，来源：规则集文件的 scriptSizeLimit 仍是占位 0 → 取三份入库产物的最大值 8831 字节(地板值)）
   ✓ A benchmarks/cell-a-melee-pressure/script.js：退出码 0
   ✓ B benchmarks/cell-b-expansion-economy/script.js：退出码 0
   ✓ C benchmarks/cell-c-claim-no-harvest/script.js：退出码 0

② 正常终局：过（64 场 / 256 席，异常 tick 合计 0；终局原因 shortcut×28/victory×24/timeout×12）

③ 消耗 ≤ 总储量 1/4（配额 25% = 800）：过
   逐份脚本（每席位消耗 = 该席位采获；分母 = 总储量）
   A：席位 64｜中位 220（6.9%）｜最坏单席 380（11.9%）｜中位判定 过｜最坏单席判定 过
   B：席位 128｜中位 96（3.0%）｜最坏单席 200（6.3%）｜中位判定 过｜最坏单席判定 过
   C：席位 64｜中位 0（0.0%）｜最坏单席 0（0.0%）｜中位判定 过｜最坏单席判定 过
   逐臂整场（#13 那一轮的可比读数）
   P0/fixture：16 场｜中位 414（12.9%）｜最坏 513（16.0%）｜配额 800
   P1/corridor-split：16 场｜中位 516（16.1%）｜最坏 616（19.3%）｜配额 800
   P1/fortress-core：16 场｜中位 511（16.0%）｜最坏 579（18.1%）｜配额 800
   P1/open-clash：16 场｜中位 449（14.0%）｜最坏 492（15.4%）｜配额 800
   全批：64 场｜中位 475｜最坏 616｜超配额 0 场
   自洽校验「消耗 ≡ 全场采获」：逐场相等

④ 取策略互不相同：过（每一对至少 3 项指标相对差 ≥ 25%）
   A（64 席）：harvests=220 delivered=200 workerPeak=2 unitPeak=12 endMelee=8 workerSharePercent=31 captures=23 finalRank=1 eliminationPercent=31
   B（128 席）：harvests=96 delivered=80 workerPeak=6 unitPeak=9 endMelee=0 workerSharePercent=33 captures=0 finalRank=3 eliminationPercent=72
   C（64 席）：harvests=0 delivered=0 workerPeak=2 unitPeak=4 endMelee=0 workerSharePercent=11 captures=0 finalRank=2 eliminationPercent=94
   A vs B：分开 8/9 项｜harvests 56% delivered 60% workerPeak 67% unitPeak 25% endMelee 100% workerSharePercent 6% captures 100% finalRank 67% eliminationPercent 57%
   A vs C：分开 8/9 项｜harvests 100% delivered 100% workerPeak 0% unitPeak 67% endMelee 100% workerSharePercent 65% captures 100% finalRank 50% eliminationPercent 67%
   B vs C：分开 6/9 项｜harvests 100% delivered 100% workerPeak 67% unitPeak 56% endMelee 0% workerSharePercent 67% captures 0% finalRank 33% eliminationPercent 23%

桩与终稿契约的缺口（由兼容层补，不静默换口径）：
   - 座位自认:getMyIndex() → 按座位注入常量函数(与终稿同义)
   - 错误判别:isError / errCode → 按桩的裸字符串返回形态翻译(判断同义)
   - 错误码常量:7 个 ERR_* → 按真源包注入面目录逐个铺成同名同值字符串
   - 快照产线字段:site.producing → 脚本自己的订单簿 + getTick() 过期(与标定环老脚本同形)
   - getObjectsByType('player') → 宿主账本:初始资金 + 下单扣款 + 交付入账
   兼容层账本与引擎真值可能分叉的两处规模：产线忙被拒 328 次、基地易主退款 4 次。

换契约版本时：判据不变、门禁仍绿是正常的，四问的取值会全部变——上面的数字不是回归基线。
