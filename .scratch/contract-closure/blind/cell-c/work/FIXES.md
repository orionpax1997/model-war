# FIXES 记录（work/ 内）

- 轮 0（初版）：写出 `script.v1.ts`，同内容复制为工作副本 `script.ts`。策略取向 C：占点不采集。
  - 静态自检：无 `import`/`export`/`require`/`eval`；无 `Date`/`Math.*`/`performance`/`queueMicrotask`/`__*`。
  - 仅调用 api.md §3 的 API 名字；每单位每 tick 至多一条单位级意图；下单先读 `producing`。
  - 用仓库同款 tsc 配 stub 类型面跑 `--strict --noUnusedLocals`，通过（0 错误）。

- 轮 1（编译面修正）：按回喂的 5 条 TS 诊断修正类型层。
  - 根因：`tsconfig` 开启 `noUncheckedIndexedAccess` 后，对 `tgtX / tgtY / tgtP` 这三个 `number[]` 的下标读取类型是 `number | undefined`：
    - L101/L111 `getRange(u.x, u.y, tgtX[k], tgtY[k])`；
    - L102/L112 `tgtP[k] * 100000`；
    - L126 `moveTo(u.id, tgtX[pick], tgtY[pick])`。
  - 改法：仅在这 5 处下标读取上追加 TS 非空断言 `!`（纯类型层，编译后即消失，无运行时行为）。策略取向与全部行动逻辑一字未改；全文同类写法已自查，其余下标读取都已有 `undefined` 守卫。
  - 复验：配 stub 类型面跑 `--strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --noUnusedLocals --noUnusedParameters`，0 错误。
  - 产物：`work/script.final.ts`（`work/script.ts` 同步为同一内容，逐字节一致）。
