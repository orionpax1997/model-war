# PROTOTYPE 读数(一次性)

> **失效声明(整份读数只能作量级参考,不是标定依据)。** 下表取自**打过补丁的构建**——第 3 节
> 结论所依赖的「空脚本存活堆 600 tick 完全平」来自一份本地打过泄漏补丁、验证完即撤销的
> `packages/engine/dist/runner/quickjs.js`(见第 6 节);其 `sandboxRuntimeHash` 是**伪造值**
> `prototype-not-a-real-hash`(见 `readings-probe.mjs` 的 `head()`)。因此这批数**过不了 `verify`**,
> 也不得作为任何键的取值依据,只用于说明泄漏的量级与墙钟代价。快照泄漏一旦修复,这批数
> 再也复现不出来。

种子 20260101;事件计数粒度 5000;每 tick 末 runGC 后读 mallocSize。

| 场景 | 状态 | tick | 墙钟 ms | event p50/p95/max | api p50/p95/max | malloc p50/p95/max | loopMs p50/p95/max | error | hardTO |
|---|---|---|---|---|---|---|---|---|---|
| honest-a-open-clash | completed | 600 | 2497 | 0/5000/5000 | 3/33/33 | 197232/200184/200592 | 0/0/2 | 0 | 0 |
| honest-b-open-clash | completed | 600 | 3559 | 0/5000/5000 | 21/131/179 | 200952/205104/206504 | 0/0/1 | 0 | 0 |
| honest-c-open-clash | completed | 600 | 2779 | 0/5000/5000 | 5/101/131 | 195472/198360/199000 | 0/0/0 | 0 | 0 |
| honest-a-corridor-split | completed | 363 | 1748 | 0/5000/5000 | 3/63/84 | 197776/200264/200680 | 0/0/0 | 0 | 0 |
| honest-b-corridor-split | completed | 600 | 3436 | 0/5000/5000 | 47/135/179 | 201176/205784/206504 | 0/0/1 | 0 | 0 |
| honest-c-corridor-split | completed | 600 | 2889 | 0/5000/5000 | 5/114/131 | 195848/198760/199080 | 0/0/0 | 0 | 0 |
| honest-a-fortress-core | completed | 600 | 2448 | 0/5000/5000 | 3/33/33 | 197232/200184/200592 | 0/0/0 | 0 | 0 |
| honest-b-fortress-core | completed | 600 | 3539 | 0/5000/5000 | 25/134/174 | 201584/205464/206448 | 0/0/0 | 0 | 0 |
| honest-c-fortress-core | completed | 600 | 2888 | 0/5000/5000 | 29/93/131 | 196200/198360/199000 | 0/0/0 | 0 | 0 |
| honest-mixed-a-b-c-a | completed | 328 | 1543 | 0/5000/5000 | 7/106/133 | 198736/201416/203736 | 0/0/1 | 0 | 0 |
| adversarial-empty | completed | 600 | 2737 | 0/0/0 | 0/0/0 | 182904/182904/182904 | 0/0/0 | 0 | 0 |
| adversarial-spin | uncertain-timeout | 0 | 1005 | 12800000/12800000/12800000 | 0/0/0 | 182804/182804/182804 | 1003/1003/1003 | 1 | 1 |
| adversarial-api-bomb | uncertain-timeout | 0 | 1010 | 11200000/11200000/11200000 | 5599993/5599993/5599993 | 182884/182884/182884 | 1007/1007/1007 | 1 | 1 |
