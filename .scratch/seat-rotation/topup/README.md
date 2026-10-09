PROTOTYPE — THROWAWAY, WIPE ME.

票 04 灰区补矩阵的一次性脚本（`.scratch/seat-rotation/issues/04-conditional-topup-matrix.md`），
与 `../prototype/` 同口径：只为解锁决策而做的活，不是交付，不进任何门禁与生产代码。

- `make-topup-runs.mjs`：现造 16 局物料（H 异质 12 局 `[A,A,B,B]×3 图×4 轮换` + S 对称校准 4 局），
  落在 `runs/seat-rotation-topup/`（git 忽略）。形态沿
  `.scratch/contract-closure/make-runs.mjs` 的先例，矩阵定义见文件头。
- `judge-topup.mjs`：读每局 `input.json` + `replay.jsonl` 首行 meta + 末行 result，
  出按座位 / 座位×脚本 / 脚本总战绩三组读数；meta↔input 逐席核对 16/16 在内，
  不一致即报错退出。

跑法（真沙箱 16 局，计入 map 成本预算）：

  node packages/tools/src/benchmarks/run-benchmarks-gate.ts   # 先绿
  node .scratch/seat-rotation/topup/make-topup-runs.mjs
  for d in runs/seat-rotation-topup/*/; do
    node apps/cli/dist/modelwar.mjs match "$d/input.json" --root .
  done
  node .scratch/seat-rotation/topup/judge-topup.mjs
