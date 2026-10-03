/**
 * 校验器的属性测试(spec《Testing Decisions》第三缝):**任意** JSON 值进去,
 * 要么被接受、要么给出结构化诊断,**永不抛未捕获异常**。
 *
 * 这条性质是手写用例覆盖不到的:一份畸形文件(键叫 `__proto__`、数组套对象套 null、
 * 天文数字、深度嵌套)不该让进程带着栈回退码崩掉——而「手写 schema + 手写 ajv 关键字」
 * 恰恰是最容易在某一种怪输入上炸掉的组合。
 */

import fc from "fast-check";
// fast-check 自己也叫 `JsonValue`（且它的数组不带索引签名，与本仓那个不是一个类型），
// 所以这里改名导入：两个同名不同形的 JsonValue 混用，编译期会报一个与性质无关的错。
import type { JsonValue } from "@model-war/schema";
import { expect, it } from "vitest";

import type { MapValidation } from "./validator.js";
import { validateMap } from "./validator.js";

/**
 * 任意 JSON 值。fast-check 自带 `fc.jsonValue()`,但它导出的 `JsonValue` 与本仓那个
 * 不是同一个类型(它的数组不带索引签名),所以在这里过一道:类型不同而值域相同,
 * 而这个转换本身正是属性要探的那条边界——来自别的世界的值也得接得住。
 */
const anyJson = (): fc.Arbitrary<JsonValue> => fc.jsonValue() as fc.Arbitrary<JsonValue>;

/** `result` 恒在（抛了就是 undefined），这样调用方不必先缩窄才能读它。 */
type Attempt = { readonly thrown: string | undefined; readonly result: MapValidation | undefined };

/**
 * 把抛出的理由收进返回值里,而不是让断言本身先崩掉:
 * 属性要断言的正是「不抛」,断言动作必须先活着。
 */
const attempt = (value: JsonValue): Attempt => {
  try {
    return { thrown: undefined, result: validateMap(value) };
  } catch (cause) {
    return { thrown: cause instanceof Error ? cause.message : String(cause), result: undefined };
  }
};

// 本文件按 dist 里的工作区包跑（import `@model-war/schema` 发生在模块加载时刻，
// 补构建是 vitest.global-setup.ts 的活）。

it("任意 JSON 值:接受,或给出结构化诊断——永不抛未捕获异常", () => {
  fc.assert(
    fc.property(anyJson(), (value) => {
      const tried = attempt(value);
      expect(tried.thrown, `校验器对 ${JSON.stringify(value)} 抛了异常`).toBeUndefined();
      const result = tried.result;
      if (result === undefined) {
        return;
      }
      if (result.ok) {
        // 接受时给出去的必须是能当地图用的对象,不是原样透传一个别的东西。
        expect(typeof result.map).toBe("object");
        expect(result.map).toBe(value);
        return;
      }
      // 拒绝时两层诊断都要有内容,否则「拒绝了」等于没告诉任何人哪儿不对。
      expect(result.machineDiagnostics.length).toBeGreaterThan(0);
      expect(result.modelDiagnostics.length).toBeGreaterThan(0);
      for (const diagnostic of result.machineDiagnostics) {
        expect(diagnostic.pointer.startsWith("/")).toBe(true);
        expect(diagnostic.keyword).not.toBe("");
        expect(diagnostic.message).not.toBe("");
      }
      // 面向模型层的行数不会多于机器层的条数(合并只会变少),且每行都带 JSON 指针。
      expect(result.modelDiagnostics.length).toBeLessThanOrEqual(result.machineDiagnostics.length);
      for (const line of result.modelDiagnostics) {
        expect(line).toContain("/");
      }
    }),
  );
});

it("判定只取决于值本身:同一份输入两次校验给出同一个结果", () => {
  fc.assert(
    fc.property(anyJson(), (value) => {
      expect(attempt(value)).toEqual(attempt(value));
    }),
  );
});

it("JSON 往返不改变判定(校验器不得依赖对象原型或引用身份)", () => {
  fc.assert(
    fc.property(anyJson(), (value) => {
      const parsed = JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
      expect(attempt(parsed)).toEqual(attempt(value));
    }),
  );
});
