/**
 * 子命令参数解析那一格（`--root` 与 `--observations` 两个带值的 flag）。
 *
 * 断言对象只有**解析结果**：值被摘到哪、位置参数剩下什么。这格是纯函数，起 VM 起子进程
 * 都不合适，真实调用点（`match` / `verify` / 试跑入口）的行为由各自的 e2e 覆盖。
 */

import { expect, it } from "vitest";

import { splitArgs } from "./args.js";

it("--root：值被摘走，不混进位置参数（顺序无关）", () => {
  expect(splitArgs(["match", "--root", "/install", "input.json"])).toEqual({
    root: "/install",
    observationsPath: undefined,
    positional: ["match", "input.json"],
  });
  // 顺序不该决定命令能不能跑：根写在后面同样摘得出来。
  expect(splitArgs(["input.json", "--root", "/install"])).toEqual({
    root: "/install",
    observationsPath: undefined,
    positional: ["input.json"],
  });
});

it("--observations：值被摘走，不混进位置参数", () => {
  expect(
    splitArgs([
      "candidate.js",
      "--root",
      "/install",
      "--observations",
      "/install/archive/alpha/observed-r1.jsonl",
    ]),
  ).toEqual({
    root: "/install",
    observationsPath: "/install/archive/alpha/observed-r1.jsonl",
    positional: ["candidate.js"],
  });
});

it("两个 flag 都在时各归各家，互不串味", () => {
  const split = splitArgs(["--observations", "/obs.jsonl", "--root", "/install", "a.js"]);
  expect(split.observationsPath).toBe("/obs.jsonl");
  expect(split.root).toBe("/install");
  expect(split.positional).toEqual(["a.js"]);
});

it("缺值 = 该 flag 不给（与不写同义），不把下一条吃成它的值", () => {
  expect(splitArgs(["candidate.js", "--observations"])).toEqual({
    root: undefined,
    observationsPath: undefined,
    positional: ["candidate.js"],
  });
});

it("值长得像 flag（下一条以 `-` 开头）→ 按缺值处理，不吃掉它", () => {
  // 少了这条规则，`--observations --root /x` 会把 `--root` 当成观测路径吃掉，
  // 真正的根反而落进位置参数（目录被当成 input.json 去 JSON.parse）。
  expect(splitArgs(["--observations", "--root", "/install", "input.json"])).toEqual({
    root: "/install",
    observationsPath: undefined,
    positional: ["input.json"],
  });
});

it("别的子命令不收的 flag 只是被摘走、不生效（解析归本格，生效归各子命令）", () => {
  // `match` 不读 `observationsPath`，但它也不会因此把这条当成位置参数。
  const split = splitArgs(["--observations", "/obs.jsonl", "input.json"]);
  expect(split.observationsPath).toBe("/obs.jsonl");
  expect(split.positional).toEqual(["input.json"]);
});

it("不带值的 flag 不进位置参数（既有行为：`-x` 这类不是位置参数）", () => {
  expect(splitArgs(["-x", "candidate.js"])).toEqual({
    root: undefined,
    observationsPath: undefined,
    positional: ["candidate.js"],
  });
});
