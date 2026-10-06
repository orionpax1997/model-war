/* eslint-disable no-unused-vars -- `loop` 是宿主每 tick 调用的入口,脚本内部不引用它 */

// 沙箱夹具(票 08,「已接受的残余」那一臂):tick 内**瞬时借满**与 `memory-hoard.js` 同量级的
// 一大块内存,随即在同一个 tick 里放手。
//
// 判据读的是 tick 末强制回收**之后**的存活堆:这一块在读数那一刻已经不可达、已被回收,因此
// **不判罚**。这是「不判罚」而不是「漏判」——分配始终没有跨过 tick 边界存活;分配上限本身也
// 没有被突破。它与 `memory-hoard.js` 的分配量刻意取成一致:攥住会判、借完即还不判,两条合起来
// 才说明这条 residual 不是空断言。
//
// 确定性:分配量是常量,不引入随机、不读时间。

const HOARD_SIZE = 240000;

function burn() {
  const chunk = [];
  for (let i = 0; i < HOARD_SIZE; i++) {
    chunk.push({ i: i, tag: "t" });
  }
  return chunk;
}

function loop() {
  // 借满 → 立即放手:返回值不落到任何可达处,函数返回后整块成为垃圾。
  burn();
}
