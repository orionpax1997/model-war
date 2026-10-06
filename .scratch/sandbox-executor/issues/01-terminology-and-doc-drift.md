# 01 · 术语与文档漂移

Type: task
Status: resolved

## 需求

在实现沙箱执行器之前,先把几处术语/文档漂移修平。它们与实现无关,而 spec 会逐处引用改后的 hld 行号——边引边改会有一批行号要返工。

## 已知漂移

1. `docs/srs.md:61`(FR-4 AC2)用「指令」,而 `CONTEXT.md` 已把「指令计数」列为必须避开的旧称(直线代码不计量,名不副实)。
2. `docs/hld.md` 多处把执行器缝叫 `Runner`,而代码与 `docs/adr/0005` 用 `SeatRunner`;`CONTEXT.md` 里没有这个词条。
3. `docs/hld.md:573` 把缝描述成 `init` / `tick` / `dispose` 三方法——与 ADR 0005 的「就是那两次宿主桥调用」和已交付的 `SeatRunner`(两方法)直接冲突。
4. `.scratch/sandbox-budget/issues/02-*.md:30` 与 `05-*.md:21` 的断言加总写成 7/4/1,而 `spike/FINDINGS.md` §7 的表实际是 6/4/1(共 11 条)。

## Answer

全部已改:

- `docs/srs.md:61`:`指令` → `控制流事件`(预约名与 `CONTEXT.md` 一致)。
- `docs/hld.md` 四处 `Runner` → `SeatRunner`:`361`(模块表)、`395`(依赖方向那行)、`551`(边界说明)、`573`(执行器缝)。其中 `573` 的三方法形状改成两方法(`setSnapshot` / `drainIntents`,指针指向 `docs/adr/0005`),并补一句「执行器不持生命周期,建 VM 与 `dispose` 归组装层」。
- `CONTEXT.md`:补 `SeatRunner` 词条;`Avoid` 两项——`Runner`(旧称,会掩盖「缝按座位而不是按对局」)与生命周期协议形状(`init` / `tick` / `dispose`,已被 ADR 0005 否掉)。
- `.scratch/sandbox-budget/issues/02-sandbox-spike-harness.md:30` 与 `05-verdict-sandbox-and-budget.md:21`:加总改成 6/4/1。

**刻意未动**:

- `docs/gdd.md:99` 的「该 tick 指令集为空」不是计数口径(它指该 tick 的指令/订单集合),不改。
- `docs/hld.md:733` 的 `runner` 是回放 meta 的判别式**字段名**,不改。
- `docs/hld.md:109` 的 `StubRunner` 是测试替身的名字,不是缝的名字,不改。
