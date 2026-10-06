/**
 * 引擎侧的错误码投影(票 06):`INTENT_ERR_CODES` 必须与真源包符号表里的 `error-code` 项逐字相同。
 *
 * runtime bundle 不能 import 真源包(`@model-war/schema` 整个被打进来不划算,且 engine 的 manifest
 * 上只有 `@model-war/replay` 这一条依赖),所以 guest 铺的七个 `ERR_*` 名字只能落在一份**投影**上。
 * 这条断言就是那份投影的看门人:符号表里加/删一个码而投影没跟上,这里当场红。
 *
 * 类型面那边有同一条断言的另一半(`packages/tools/src/api-doc.test.ts` 查「类型面声明出来的值名
 * 与符号表逐字相同」)。三处名字(符号表 / 类型面 / 注入面)因此两两对齐,而真源只有一处。
 */

import { SANDBOX_INJECTED_API_SYMBOLS } from "@model-war/replay";
import { expect, it } from "vitest";

import { INTENT_ERR_CODES } from "./intent-verdicts.js";

it("引擎侧的 ERR_* 投影与真源包符号表的 error-code 项逐字相同", () => {
  const fromTable = SANDBOX_INJECTED_API_SYMBOLS.filter((name) => name.startsWith("ERR_")).sort();
  expect([...INTENT_ERR_CODES].sort()).toEqual(fromTable);
  expect(fromTable.length, "符号表里一个错误码都没有,这条断言就成了空断言").toBeGreaterThan(0);
});
