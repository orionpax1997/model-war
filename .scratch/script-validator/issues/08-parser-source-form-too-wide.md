# 08:解析层的源形态比入口契约宽(script 形态按 `lang: "ts"` 解析)

Type: task
Status: ready-for-agent
Blocked by:

## 来源

`.scratch/script-validator` 这个 feature 的票 06(四份盲写脚本验收)里的发现,
由该 feature 的收口 merger 复核确认。**本票不在那个 feature 的范围内**,因为它取决于
参赛脚本的编译配置(归 E)何时落地。

## 现象

`packages/tools/src/parse-source.ts` 对 script 源形态走的是:

```ts
parseSync(kind === "script" ? "script.ts" : "source.ts", source, { lang: "ts", sourceType: kind });
```

即**源形态选了 `.ts` 文件名、`lang` 固定 `ts`**。后果:一份**未经编译**的参赛脚本
(带 `function loop(): void`、`Map<number, number>`、`as` 断言)能直接拿退出码 0,
而契约(hld §6.2「四条规则跑在编译产物上」)写死校验器唯一的源形态是**编译后的 script-mode JS**。

实测证据(票 06,2026-10-03):四份盲写脚本 cell-a/b/c 都带 TS 注解(cell-a 5 处 `as`、
cell-c 7 处 `as` + 7 处 `Map<`,三份各有 1 处 `function loop(): void`),原样通过。

## 判据

**这不是误伤**:误伤是「合规脚本被拒」,这里是「判据更宽,放行了不该由本工具判的东西」。
两者的失效方向相反,不能一起处置——这也是票 06 决定按兵不动的原因。

## 为什么现在不修

1. `tsc` 那一步是 **E 的编译步骤**的交付物。在它落地之前收紧,有可能把 E 交出的某种编译配置判死。
2. 收紧方式本身还没定:要么 `parse-source.ts` 对 script 形态改用 `lang: "js"`(文件名与 `lang` 一起改),
   要么在校验入口处显式声明源形态并据此选解析器。两种做法对「注释是否算源码」的答案不同
   (注释在两种源形态下都存在,但 JS 的解析器对 TS 特有的注释里写法可能有别)。

## 触发条件与验收

- **触发条件**:参赛脚本的编译配置(脚本 tsconfig,归 E)落地。
  在那之前本票不动——它不是「忘了做」,是「现在做会判死一个还没交出来的东西」。
- **验收**:
  ① 决定收紧的形态与落点(解析层 `lang` 还是入口声明源形态),写进 hld §6.2;
  ② 用例钉住「带 TS 注解的源码被拒」,并钉住「编译后的 JS 产物仍然放行」——
     **只钉前者会有人把产物一起拒掉**,那正是误伤;
  ③ 四份盲写脚本重跑一遍,确认仍然零违规(它们带 TS 注解,收紧后必然要重新判读:
     它们本来就不是编译产物)。

## Answer