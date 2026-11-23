// 跨 tick 只带数值过去,只带这一个 id,不带任何对象。
var assignedEnemyId = -1;

function loop() {
  const me = getMyIndex();
  const mine = getObjectsByType("unit", { owner: me });
  const foes = getObjectsByType("unit", { owner: foeOwnerOf(me) });

  for (let i = 0; i < mine.length; i += 1) {
    const unit = mine[i];
    if (unit === undefined) {
      // 数组下标可能取不到元素，判一下再用。
      continue;
    }
    const enemy = nearestEnemyId(unit, foes);
    if (enemy === null) {
      continue;
    }
    // 记忆里那个 id 本 tick 还在不在:重新查一次,不信上一 tick 拿到的对象。
    if (assignedEnemyId >= 0 && getObjectById(assignedEnemyId) === null) {
      assignedEnemyId = -1;
    }
    assignedEnemyId = enemy;

    // 每个单位本 tick 只提交这一条意图(见 §1.3);拿到码只是反馈,不是终裁。
    const result = attack(unit.id, enemy);
    if (isError(result)) {
      const code = errCode(result);
      if (code === ERR_INVALID_UNIT) {
        continue;
      }
    }
  }
}

/** 敌方的归属值:0..3 里除我以外的那一个。 */
function foeOwnerOf(me: number): number {
  return (me + 1) % 4;
}

/** 本 tick 最近的敌方单位 id,没有敌人时是 null。射程不归这里管:交给动作函数判。 */
function nearestEnemyId(
  unit: { x: number; y: number },
  foes: readonly { id: number; x: number; y: number }[],
): number | null {
  let best = -1;
  let bestRange = 0;
  for (const foe of foes) {
    const d = getRange(unit.x, unit.y, foe.x, foe.y);
    if (best === -1 || d < bestRange) {
      best = foe.id;
      bestRange = d;
    }
  }
  return best === -1 ? null : best;
}
