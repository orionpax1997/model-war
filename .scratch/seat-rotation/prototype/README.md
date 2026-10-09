PROTOTYPE — THROWAWAY, WIPE ME.

一次性 seat-reduce 探针（`.scratch/seat-rotation/issues/01-seat-reduce-probe.md`），
回答：首轮赛季 60 局各座位胜率/均分（Wilson 95% 区间）、落差定档（绿/灰/红）、补不补矩阵。

形态偏离说明：prototype 技能默认 logic 分支产出单文件 HTML（LOGIC.md），
但本票在 issue 里已明定形态——“一次性脚本放 `.scratch/seat-rotation/prototype/`，
读数落 `.scratch/seat-rotation/readings.md` 并附原始 log”。问题是“对一批已跑完的
对局做纯后处理 reduce”，没有状态机可供手感验证，HTML 壳无意义，故按票执行、
不套 HTML 形态。本目录只有脚本 + 本 README，不进任何门禁与生产代码。

跑法（零成本纯后处理，不碰引擎/网络）：

  node .scratch/seat-rotation/prototype/seat-reduce.mjs runs/<runId>/report.json

第二独立路径对数（抽查 4 局）：同一命令内自动用 `matches/<对局>/replay.jsonl` 的
meta 行 `players[].seat` + 末行 `result.rankings` 与 `report.json` 的 `matches[]`
条目交叉核对，不一致即报错退出。
