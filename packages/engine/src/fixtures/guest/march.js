/* eslint-disable no-unused-vars -- `loop` 是宿主每 tick 调用的入口,脚本内部不引用它 */

// 沙箱夹具:全军朝最近的敌方单位走一格(真沙箱路径的集成夹具,不是一次性探针)。
//
// 入口名固定 `loop()`,由宿主每 tick 调用。它只用注入面里的 `getMyIndex` / `getObjectsByType`
// / `move` 三样(最小骨架),因此它同时钉住「引擎收到的意图真的走过了步 0 → 校验 → 结算」:
// 座位认错时 `move` 的属主校验会否掉每一单,单位一步都不动。
//
// 确定性:输出只由这一 tick 的只读快照决定,不读 `Date`、不读 `Math.random()`、不跨 tick 记忆
// (座位只读一次存进模块级变量)。

let myIndex = -1;

function chebyshev(ax, ay, bx, by) {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

function nearest(from, candidates) {
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = chebyshev(from.x, from.y, candidate.x, candidate.y);
    if (
      distance < bestDistance ||
      (distance === bestDistance && best !== null && candidate.id < best.id)
    ) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function loop() {
  if (myIndex < 0) {
    myIndex = getMyIndex();
  }
  const units = getObjectsByType("unit");
  const mine = [];
  const enemies = [];
  for (const unit of units) {
    if (unit.owner === myIndex) {
      mine.push(unit);
    } else {
      enemies.push(unit);
    }
  }
  for (const unit of mine) {
    const target = nearest(unit, enemies);
    if (target === null) {
      continue;
    }
    const dx = Math.sign(target.x - unit.x);
    const dy = Math.sign(target.y - unit.y);
    if (dx === 0 && dy === 0) {
      continue;
    }
    move(unit.id, dx, dy);
  }
}
