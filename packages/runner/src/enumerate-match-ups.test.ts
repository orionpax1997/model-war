import { expect, it } from "vitest";
import { RULESET_VERSION } from "@model-war/schema";
import { enumerateMatchUps } from "./index.js";

it("C(4,N) 组合的数量正确", () => {
  expect(enumerateMatchUps(["a", "b", "c", "d"])).toHaveLength(1);
  expect(enumerateMatchUps(["a", "b", "c", "d", "e"])).toHaveLength(5);
  expect(enumerateMatchUps(["a", "b", "c", "d", "e", "f"])).toHaveLength(15);
});

it("不足四人时不产生组合", () => {
  expect(enumerateMatchUps(["a", "b", "c"])).toHaveLength(0);
});

it("每个组合是四个互不相同的座位", () => {
  for (const matchUp of enumerateMatchUps(["a", "b", "c", "d", "e", "f"])) {
    expect(new Set(matchUp.seats).size).toBe(4);
  }
});

it("结果只依赖名册内容,不依赖入参顺序", () => {
  expect(enumerateMatchUps(["e", "b", "d", "a", "c"])).toEqual(enumerateMatchUps(["a", "b", "c", "d", "e"]));
});

it("名册去重后重复名不再参与组合", () => {
  expect(enumerateMatchUps(["a", "a", "b", "c", "d"])).toHaveLength(1);
});

it("每个组合都钉住规则集版本", () => {
  for (const matchUp of enumerateMatchUps(["a", "b", "c", "d"])) {
    expect(matchUp.ruleset).toBe(RULESET_VERSION);
  }
});
