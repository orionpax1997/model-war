# Map:座位轮换实效定案

Label: wayfinder:map
Status: resolved

## Destination

交出「座位偏置量级 + 是否需要规则侧动作」的决策：判据文本回流关闭 `docs/hld.md` §12 #3，B 节点/frontier/波次关闭，`handoff` 交出去；若轮换摊不平，只写触发条件交回 gdd，不动机制。附四列登记表活表（座位 / 样本量 / 偏置读数 / 判据）作决策载体，活表见 `readings.md` §2（真模型 4 行，补充观察）与 §5.4（基准 8 行，可进判据），两表估量不同、不可相加。本图只出决策，不出交付物。

## Notes

- 域：`docs/gdd.md` §3.3（轮转优先与偏置公式、座位必须轮换的机制家）、`docs/hld.md` §8.1（座位轮换公式 `(mapIndex + seedIndex) mod 4`、`M×K ≡ 0 (mod 4)` 均摊断言）与 §12 #3（唯一待关的工程侧开放项，口径只有一句话）；验收锚 `docs/diagrams/v0-milestone-dag.md` 迷雾层 B 行。机制侧的家在 gdd，B 只引用不改。
- 每个 session 走 `grilling` + `domain-modeling`；按票型另走 `research` / `prototype`（`task` 票是为了解锁决策而做的活，不是交付）。
- 口径铁律（入口两轮 grilling 已定，见下；复述一次，票里不再重议）：
  - 两个公式别混：座位轮换 = `(mapIndex + seedIndex) mod 4`（`hld §8.1`）；`(tick + playerIndex) mod 4` 是轮转优先（`gdd §3.3`），是被测的偏置源，不是轮换本身。
  - 座位 = `archives` 下标 = `playerIndex`；`input.json` 无 seat 字段，座位只能靠排 `archives` 顺序控制；`modelwar match` 只认 positional[0] + `--root`，不能指定 seat。
  - 独立样本 = 轮换位置 × 异质脚本组合数；地图是对称复本只作分层，不乘进样本数；扩种子不增座位维度的信息量（gdd #12/#13）。
  - 判据只吃基准脚本（cell-a / cell-b / cell-c 两两对打，cell-a vs cell-b 优先；同脚本对称局只作校准基线）；真模型脚本只作补充观察，不进判据。
  - 「摊平」指赛季尺度各座位胜率差收敛，不是单局公平（单局偏置按 `gdd §3.3` 本来就存在）。
  - 预锁线（票「摊平阈值与判据文本拍板」落判据文本，此处是输入不是结论）：最大 seat 胜率落差 < 10% 且附各座位 Wilson 95% 区间；< 5% 是干净通过备注线；10–15% 灰区触发补矩阵；> 15% 直接判摊不平走回流。
  - 成本预算：真沙箱 ≤ 100 局（含 `c3-corridor-split-s2` 确定性崩溃 1 局按 hld §8.4 重跑剔除的预留）。
  - 可执行门禁（落 `packages/tools` 的可复跑形态）明确出本图；摊不平的 gdd 旧注更正由规则侧做，B 只在 handoff 里指针过去。
- 证据路线：先对 I 的首轮 60 局做 seat reduce（`report.json` 的 `matches[]` 已有 `seats[4]` / `rankings[4]` / `perMatchScores[4]`，纯后处理零成本），再按读数决定是否补 12–16 局小矩阵。注：首轮 `report.json` 随 `runs/**` 被 gitignore 排除未保留，实际按同一配置重跑 60 局取数（`readings.md` §0），占用预算 60 局；累计真沙箱 76/100（票 04 记）。
- 每个事实只有一个家：决策只写进票的 `## Answer`，本图只留一行 gist + 链接；引用票一律用票名。
- 票纪律：`Status:` + `## Answer` + 验收勾选必须回写；快反馈 `pnpm run check:quick` + 相关测试；全部票落地后收口跑一次 `pnpm run verify:fast`（专项门禁非默认，除非验收明确需要并说明原因）；收尾走 `code-review` 双轴。
- 环境坑：`git status --porcelain` 被包装成输出字面量 `ok`，判工作区用 `git diff HEAD` + `git ls-files --others --exclude-standard` 交叉确认；`find` / `grep` 也可能被替换。提交信息禁止 `Co-Authored-By`。凭据只写变量名；`season.yaml` / `models.yaml` 只引用 `credentialEnvVar`。
- tracker：本地 markdown（docs/agents/issue-tracker.md）。

## Decisions so far

<!-- 一行一张已决票:[票名](issues/NN-slug.md) + 一行答案 gist -->

- [首轮60局seat-reduce探针](issues/01-seat-reduce-probe.md)：真模型 60 局落差 51.7% 红档，补充观察不进判据，只构成触发补测基准小矩阵的理由；轮换均衡已验证（每座位×模型恰 12 局）。
- [样本量与显著性判据依据](issues/02-sample-power-basis.md)：判据走混合口径（n=60，±10.7pp）；补矩阵价值在覆盖面不在宽度；chi-square 永不做绿灯。
- [摊平阈值与判据文本拍板](issues/03-flattening-criterion.md)：判据文本定稿（绿 <10%、<5% 备注线、灰 10–15%、红 >15%；两条触发线：落差落灰区 / 任一座位 Wilson 下限 <20%；前置闸对称校准须拉平），由票 05 原样回流 hld §12 #3。
- [灰区补矩阵](issues/04-conditional-topup-matrix.md)：基准 H 异质 12 局落差 58.3% 红 + S 对称校准 4 局（判不动），读数回填 `readings.md` §5 / §5.4 八行；累计真沙箱 76/100。
- [终verdict与handoff](issues/05-final-verdict-handoff.md)：verdict 红档触发交回（H 落差 58.3% 红、两条触发线全中），触发条件交回 gdd §3.3（`docs/gdd.md:93`），本图不动机制；hld §12 #3 回流 + DAG 关闭 + handoff 交出，本图 resolved。

## Not yet specified

<!-- 朝向目的地、现在还提不出尖锐问题的迷雾;等前沿推进后毕业成票 -->

- **真模型补充观察看不看**：已毕业（票 01）：看，补充观察口径——真模型 60 局红档只构成触发补测的理由，不进判据；判定等基准矩阵 + 判据文本。
- **摊不平回流的 gdd 新票具体内容**：触发条件写法等票「终 verdict 与 handoff」落；若结论是绿，此雾消散，不成票。
- **小 n 下 Wilson 区间过宽时的替代口径**：等票「样本量与显著性判据依据」的研究结论；大概率只落成票「摊平阈值与判据文本拍板」的附件，不成票。

## Out of scope

<!-- 超出目的地的工作:不毕业,目的地重画才回来 -->

- **gdd 机制改动**（轮转优先公式、方向「值大者胜」、排期要求 `M×K ≡ 0 (mod 4)`）：B 若测出摊不平只写触发条件交回，改归规则侧。
- **gdd §3.3 的 `(4-d)/4` 旧注更正**：方向定死后的遗留措辞，归规则侧改，B 只在 handoff 里指针过去，不顺手改。
- **可执行门禁落 `packages/tools`**：每赛季可复用的门禁形态出本图；将来要做另开交付节点。
- **真模型脚本进判据**：口径外，只作补充观察。
- **种子数 K 重裁**：A 已定 K=4，本图只用结论。
- **D1 桩数据作新结论**：1336 场桩结论只作历史背景，不作为 B 的证据（桩 ≠ 真沙箱；`check:selfproof` 的 64 场读数同理不可用，形态可抄）。
- **V0 收口动作本身**：B 只交 `handoff`，收口由外层做。
