/* eslint-disable no-unused-vars -- `loop` 是宿主每 tick 调用的入口,脚本内部不引用它 */

// 沙箱夹具(票 08 内存判据,「撑内存」那一臂):在**第一 tick** 种下一大块跨 tick 存活的堆,
// 之后一动不动地攥着它。
//
// 为什么一次只种一块、而不是每 tick 再种一块:判据读数取在 tick 末强制回收**之后**,这一块
// 存活堆因此逐 tick 稳定地压在判罚线之上。若每 tick 续种,堆会一路涨到分配上限、转成 guest
// 异常,那测的就成了「分配上限」而不是「判罚线」——两件事在票 08 的用例里分开断言。
//
// 确定性:分配量是常量,读数逐 tick 稳定,不引入随机、不读时间、不跨 tick 依赖快照。

let hoard = null;

function loop() {
  if (hoard === null) {
    hoard = [];
    for (let i = 0; i < 240000; i++) {
      hoard.push({ i: i, tag: "h" });
    }
  }
}
