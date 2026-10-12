/**
 * 试跑观测文件的**位置与命名**(`archive/<slug>/observed-<runId>.jsonl`;hld §7.4)。
 *
 * 这里只钉两件事:它落在哪一层、叫什么。为什么不能进 `meta.json`、为什么与
 * `failed-<runId>.json` 并列而不在 `<runId>/` 里,理由归 `observations.ts` 的头注与 hld,
 * 本文件不重复。文件里那几行读数由试跑入口写(`apps/cli/src/trial/observations.ts`),
 * 本包只负责算出路径并交给子进程——**本包不解析那几行**,所以这里没有读回用例。
 */

import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

import { FAILURE_RECORD_PREFIX } from "@model-war/schema";
import { expect, it } from "vitest";

import { observationsPathOf } from "./observations.js";

it("落在 archive/<slug>/ 下,与三件套目录、失败记录同一层(不在 <runId>/ 里)", () => {
  expect(observationsPathOf("/install", "alpha", "2026-01-01T00-00-00-000Z")).toBe(
    join("/install", "archive", "alpha", "observed-2026-01-01T00-00-00-000Z.jsonl"),
  );
});

it("前缀与后缀都让报告侧「只扫 failed-*.json」那条过滤器扫不到它", () => {
  // 报告侧按 `failed-` 前缀 + `.json` 后缀挑失败记录(`packages/runner/src/reporter.ts`);
  // 两个特征各错开一个,新增旁挂文件就不会被那条过滤器误当成失败记录。
  const name = basename(observationsPathOf("/install", "alpha", "r1"));
  expect(name.startsWith(FAILURE_RECORD_PREFIX)).toBe(false);
  expect(name.endsWith(".json")).toBe(false);
});

it("纯路径计算:调用它不建目录也不落文件(写盘是入口那一侧的事)", () => {
  const root = mkdtempSync(`${tmpdir()}/modelwar-gen-observations-`);
  const path = observationsPathOf(root, "alpha", "r1");
  expect(existsSync(path)).toBe(false);
  expect(existsSync(join(root, "archive", "alpha"))).toBe(false);
});
