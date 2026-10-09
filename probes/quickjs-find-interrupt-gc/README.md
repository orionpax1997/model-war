# quickjs-find-interrupt-gc 复现

quickjs-ng `Array.prototype.find` 家族在**中断点**上二次释放元素(上游
[quickjs-ng#1792](https://github.com/quickjs-ng/quickjs/issues/1792)),导致随后任一
`runGC()` 命中断言、WASM trap、子进程 `exitCode 2`。本目录是确定性复现与规避验证。

两个脚本都**不依赖网络 / 凭证**。

## `repro-minimal.mjs` —— 上游缺陷最小复现(不 import 引擎)

直接驱动 `quickjs-wasi`:谓词恒假 + 中断处理器恒真,反复调 `find`;终有一次中断落在
find 每轮顶部的检查处,异常出口把上一轮已释放的元素再释放一次,随后 `runGC()` 断言崩溃。

```sh
node probes/quickjs-find-interrupt-gc/repro-minimal.mjs          # 原生 find:exit 2(断言崩溃)
node probes/quickjs-find-interrupt-gc/repro-minimal.mjs --shim   # 等价 JS 实现:exit 0
```

## `repro-match.mjs` —— 引擎级确定性复现(真实冻结存档组合)

重建 season 票 11 那一局的 `input.json`(map `corridor-split`、seed `2936867027`、
四席 = [`mimo-v2.6-flash`, `muse-spark-1.3-contributor`, `deepseek-v4-flash`,
`gpt-6-luna`],均取仓库内 `archive/*/2026-10-09T01-09-09-599Z/`,sha256 现算),再跑
`modelwar match`。

```sh
pnpm run build && pnpm --filter @model-war/cli build
node probes/quickjs-find-interrupt-gc/repro-match.mjs
```

修复前:该局在 gpt-6-luna 座位的 VM 上,tick 58 的 find 内被中断 → 下一次强制回收触发
`Assertion failed: JS_REF_COUNT(p) > 0 (gc_decref_child: 7365)` /
`JS_REF_COUNT(sh) == 0 (js_free_shape0: 5816)` → exit 2。
修复后:跑满 600 tick → exit 0。

## 规避与副作用

规避落在 `packages/engine/src/runner/array-search-shim.ts`:建 VM、载入脚本前由宿主
`evalCode` 一段等价的 JS 实现覆盖 `find` / `findIndex` / `findLast` / `findLastIndex`。
它只换实现、不新增全局名、不动 guest runtime bundle 字节(其 sha256 被每份存档 meta 钉住),
因此不破坏存档校验。

**已知副作用**:原生的 `js_array_find` 每个元素只烧约 1 格控制流事件,而 JS 实现每元素约
2.5 格(200000 元素的 find:原生 40 次中断回调 ≈ 20 万事件,JS 实现约 100 次 ≈ 50 万事件)。
`eventTickLimit` 是控制流事件计数轨,故 find 用得多、又接近上限的座位可能比修复前更早触限。
这是「把 C 内建换成 JS 实现」的固有代价,不是内存判据语义的改变。

## 正确修法(上游)

给 `js_array_find` 的循环在 `JS_FreeValue(ctx, val)` 之后补一句 `val = JS_UNDEFINED;`
(或异常出口只在 `val` 仍被持有时释放)。这需要重新编译 quickjs-ng 的 wasm;本仓当前
`quickjs-wasi@3.6.2` 是其 npm 最新版,`packages/runner` 之外无从升级,故先用上面这条
宿主侧规避。
