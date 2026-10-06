/* eslint-disable no-unused-vars -- `loop` 是宿主每 tick 调用的入口,脚本内部不引用它 */

// 沙箱夹具(票 07 双计数之「API 轰炸」那一臂):在一个 tick 里对注入的查询 API 连打数万次。
//
// 为什么它证明的是 **API 调用计数**这一轨:纯计算死循环一个 API 都不调(由 `eventTickLimit` 抓),
// 而本夹具把算力花在查询调用上——每 tick 十万次 `getObjectsByType` / `getTick`,由 `apiCallTickLimit`
// 抓。这正是「两条轨互为盲区、必须成对」的另一半。
//
// 为什么它在打完之**后**仍下一笔 `move`:超限时宿主**作废该座位本 tick 的全部意图**,那笔 move
// 就不该出现在交回里。这条「作废」是规则的一部分(单位原地待命),而它必须有一个可断言的入口——
// 未超限时同一笔 move 会照常交回,超限时消失,两次一比就钉住了「只作废,不改世界」。
//
// 确定性:调用次数是常量,输出只由这一 tick 的快照与常量决定;不读时间、不引入随机、不跨 tick 记忆。

const FLOOD = 50000;

function loop() {
  for (let i = 0; i < FLOOD; i++) {
    getObjectsByType("unit");
    getTick();
  }
  move(0, 1, 0);
}
