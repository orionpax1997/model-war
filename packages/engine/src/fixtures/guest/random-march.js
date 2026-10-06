/* eslint-disable no-unused-vars -- `loop` 是宿主每 tick 调用的入口,脚本内部不引用它 */

// 反向自证夹具:每 tick 让每个己方单位朝依赖 `Math.random()` 的方向走一格。
//
// 它只用于集成测试的第四条用例(「同一条十列断言会红」):三件套把随机源钉在冻钟上,
// 所以换一个冻钟读数就等于换一条随机序列,回放随之改变。若三件套没生效(种子来自宿主真钟),
// 同一份脚本的十次重跑本就不会得到同一序列,那一条断言也就不是空断言。
//
// 入口名固定 `loop()`。

let myIndex = -1;

function loop() {
  if (myIndex < 0) {
    myIndex = getMyIndex();
  }
  for (const unit of getObjectsByType("unit", { owner: myIndex })) {
    const dx = Math.random() < 0.5 ? 1 : -1;
    const dy = Math.random() < 0.5 ? 1 : 0;
    move(unit.id, dx, dy);
  }
}
