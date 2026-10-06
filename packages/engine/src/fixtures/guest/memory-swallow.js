/* eslint-disable no-unused-vars -- `loop` 是宿主每 tick 调用的入口,脚本内部不引用它 */

// 沙箱夹具(票 08):与 `memory-hoard.js` 同一条臂,但把「撑到分配上限时转成的 OOM 异常」
// **在 guest 内 `try/catch` 吞掉**,并把已经分到手的那些块保持存活。
//
// 它钉的是「判据不依赖 guest 异常可见性」:异常在 guest 里被吃掉、宿主全程看不到(宿主不读、
// 也不捕获 guest 异常),判据照样从 tick 末强制回收之后的存活堆读数判出。
//
// 宿主侧的落点:判据读的是 `getMemoryUsage().mallocSize`,与 guest 有没有抛出、抛了有没有被接住
// 都无关。这条夹具因此与「分配上限超限转 guest 可见异常」那条断言是**两件事**,分开用例。

let hoard = null;

function loop() {
  if (hoard === null) {
    hoard = [];
    for (;;) {
      try {
        hoard.push(Array.from({ length: 4096 }, () => 7));
      } catch (_error) {
        // 吞掉分配上限转成的 OOM:它不越出 guest。攥着的块仍可达,读数仍在判罚线之上。
        break;
      }
    }
  }
}
