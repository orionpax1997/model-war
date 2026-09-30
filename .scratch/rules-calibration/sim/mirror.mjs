// mirror.mjs —— 声明式"座位注入"改写：给盲写脚本补上契约缺失的 index 自认能力。
//
// 为什么需要：契约草案 api.md §5 只给了候选 A/B 两种自认方式，来源状态模型既没有
// "you/isSelf" 字段，也没有 index 查询函数（票 14 记为 P0-1，已证实当前 schema 下无可行解）。
// 后果是逐字入舱时，部分脚本在非 0 号座位上会自认失败 → 整局不动作（见 results.md「P0-1 实证」）。
//
// 本文件只做一件事：把"脚本认座位"这一处替换为"宿主告诉它座位"，从而**单独隔离出**
// index 缺口对策略平衡证据的污染。改写是最小的、逐行可核对的：
//   cell-a: `if (MY_INDEX < 0) MY_INDEX = detectMyIndex();` → `if (MY_INDEX < 0) MY_INDEX = MIRROR_SEAT;`
//   cell-b: `const MY_INDEX: 0|1|2|3 = 0;` → `const MY_INDEX = MIRROR_SEAT;`
//   cell-c: `if (found >= 0) { myIndex = found; markState = 2; return true; }`（自标记回读的唯一落点）
//           → 直接钉为 `myIndex = MIRROR_SEAT; markState = 2; return true;`
//   cell-d: 不改写（自认机制在当前 schema 下可用）
// 逐字原文仍以 M0 矩阵跑过，取证以 M0 为准；M1/M2/M3 只用于策略平衡判读。
//
// cell-c 为什么也要注入：它的自标记是“取第一个落到目标格的单位的属主”，而 cell-c 的方向方案是
// `K_DIRS8[id % 8]`，任何一家同样用 `id % 8` 试探的脚本都会与它撞车；即便全场只有它自己试探，
// 目标格被别的单位占着也会让它整局认不出座位（open-four seed 11 实测：认成 0 号 → 整局不动作）。
// 这是**自认机制的脆弱性证据**，不是策略强弱证据，故策略矩阵里必须把它钉住。

import { SCRIPTS } from './harness.mjs';

const PATCHES = {
  a: [
    {
      find: 'if (MY_INDEX < 0) MY_INDEX = detectMyIndex();',
      replace: 'if (MY_INDEX < 0) MY_INDEX = MIRROR_SEAT;',
    },
  ],
  b: [
    {
      find: 'const MY_INDEX: 0|1|2|3 = 0;',
      replace: 'const MY_INDEX = MIRROR_SEAT;',
    },
  ],
  c: [
    {
      find: '  if (found >= 0) {\n    myIndex = found;\n    markState = 2;\n    return true;\n  }',
      replace: '  void found;\n  myIndex = MIRROR_SEAT;\n  markState = 2;\n  return true;',
    },
  ],
  d: [],
};

export function mirrorSource(key, text, seat) {
  const patches = PATCHES[key] ?? [];
  let out = text;
  for (const p of patches) {
    if (!out.includes(p.find)) {
      throw new Error(`mirror patch target not found for ${key}: ${p.find}`);
    }
    out = out.replace(p.find, p.replace);
  }
  return `const MIRROR_SEAT = ${seat};\n${out}`;
}

export function mirrorPatchList() {
  return Object.entries(PATCHES).map(([key, patches]) => ({
    script: key,
    cell: SCRIPTS[key].cell,
    patches,
  }));
}
