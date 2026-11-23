/**
 * `evaluate` 的会话级调用上限(ADR-0030:三次,总量固定、自由分配)。
 *
 * ── 这个模块现在只剩这一个常量,而且**是有意的** ──
 *
 * 它以前是「薄壳—宿主通道」的协议体:一行 JSON 一请求、一行 JSON 一响应,键序、七条转义表、
 * `stderr` 居末都是协议的一部分(因为对面是沙箱里的 `bash`,没有 `jq`)。那条通道与它的三个
 * 薄壳副本已整套删除(票 03):`check` / `evaluate` / `finish` 现在是**工具调用**,由宿主分派,
 * 模型在沙箱里连那个路径都没有。协议体跟着消失,只剩下面这个数。
 *
 * 名字因此有点窄(文件还叫 `tool-channel.ts`,内容已无通道),但**没有改名**:`archive-meta.ts`
 * 从这条 import 边上单向取配额,那条依赖方向本身是一条判据(`tool-channel.test.ts` 用源码文本
 * 钉住「档案形状不许反过来成为 harness 配额的真源」)。挪文件会让那条判据变成一条关于路径的
 * 噪音;等票 06 重定清单时一起收。
 *
 * ── 这个数是 **harness 配额的真源**,方向只有一条 ──
 *
 * 它同时被三处读:dispatcher **执行**它(超限即拒且不执行)、harness 身份清单**记录**它
 * (`identity.ts` 的 `quotas.evaluate`)、档案形状侧的 `OPTIMIZATION_CANDIDATE_LIMIT` 从它**派生**
 * (「一份档案最多几个候选」= 「一次会话最多几次真评测」——候选就是真评出成绩的 `evaluate`)。
 *
 * ── 为什么不能反过来(以前就是反的) ──
 *
 * 上一版写成 `EVALUATE_CALL_LIMIT = OPTIMIZATION_CANDIDATE_LIMIT`,于是**档案形状成了 harness
 * 配额的真源**:档案侧一旦放宽候选数(纯消费侧格式的改动),harness 的配额与 `harnessDigest`
 * 就跟着断代。这正是 ADR-0029 把「档案形状」排除出身份清单要防的耦合——档案是那个世界留下的
 * 记录,不是那个世界本身;记录换个排版不该让榜断代。
 *
 * 所以这个字面量的家在这里(harness 侧的执行判据),`archive-meta.ts` 单向从这里取。
 */
export const EVALUATE_CALL_LIMIT = 3 as const;
