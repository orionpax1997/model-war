/**
 * 空转检测共享件(`vacuous.ts`)的自测:纯函数的行为,以及**每道门禁都用了它**的元断言。
 *
 * ── 为什么这份断言住在 unit 而不是 `gates.test.ts` ──────────────────────────────
 * `gates` project 存在的理由是那些用例**要 spawn 真实命令**(单条已实测 43s,所以不进退默认
 * `test`)。本文件一条命令都不跑,只读源码树——放在 `gate/vacuous.test.ts` 就落进 `unit`,
 * 于是它跟着默认链 `pnpm run test` 一起在每个 PR 上生效,而不是等人想起 `pnpm run test:gates`。
 * 一处新门禁忘了做空转检测,最晚在这里就变红。
 *
 * ── 元断言凭什么算「证明过自己」 ───────────────────────────────────────────────
 * 「没有门禁漏做」这句话在两种情形下会假绿,所以两条都钉住:
 *
 * 1. **枚举没找到门禁入口**(目录挪了、递归写错)——空清单会让断言永远绿。所以先自证规模:
 *    真实源码树里数到的门禁入口必须 ≥ 已知数量,且必须含一份点名认识的门禁。
 * 2. **判据本身被绕过**——头注里写一句 `vacuousReason(...)`、或只 import 不调用,都不算用。
 *    所以有两条反例喂假源码:删掉调用 → 红;只在注释里提它 / 只 import 不调用 → 红。
 *
 * 反例全部走**纯函数 + 篡改文本**,不改真实文件:与「门禁自测的两层」同一条纪律——
 * 反例要能现做现验,但不该把仓库树弄脏。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  VACUOUS_EXEMPT_ENTRIES,
  gatesMissingVacuousDetection,
  isAssertingGateEntry,
  vacuousReason,
  type GateSource,
} from "./vacuous.ts";

/** 本文件在 `<repo>/packages/tools/src/gate/` 下,上溯四层是仓库根。 */
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** 元断言的扫描范围:工具的源码树。门禁入口全在这一片里。 */
const TOOLS_SRC = "packages/tools/src";

/** 递归收一片源码树(仓库根相对路径 + 文本)。过滤(哪一个是门禁入口)交给判据自己。 */
const collectSources = (relativeDir: string): readonly GateSource[] => {
  const sources: GateSource[] = [];
  for (const entry of readdirSync(join(repoRoot, relativeDir), { withFileTypes: true })) {
    const path = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      sources.push(...collectSources(path));
    } else if (entry.name.endsWith(".ts")) {
      sources.push({ path, text: readFileSync(join(repoRoot, path), "utf8") });
    }
  }
  return sources;
};

/** 点名认识的那道门禁:只用来证明「枚举真的走进了 gate 目录」,不承担「全都在」的判决。 */
const KNOWN_ENTRY = "packages/tools/src/gate/run-no-float-gate.ts";

/** 已知的门禁入口数量下界。新加门禁只会让它更大——下界不是清单,不随成员变化而失效。 */
const KNOWN_ENTRY_COUNT = 10;

describe("空转检测共享件", () => {
  it("被检数量为正时返回空串,调用方不必再看计数", () => {
    expect(vacuousReason(1, { subject: "文件", scope: "packages/engine/src" })).toBe("");
    expect(vacuousReason(37, { subject: "文件", scope: "packages/engine/src" })).toBe("");
  });

  it("被检数量为 0 时返回一条中文理由:说清被检对象、作用域与判决", () => {
    const reason = vacuousReason(0, { subject: "预算键", scope: "rulesets/v1.json" });
    // 理由文案本身是可断言对象(与仓库现有的违规消息形态一致):
    expect(reason).toContain("0 个预算键");
    expect(reason).toContain("rulesets/v1.json");
    expect(reason).toContain("什么也没断言");
    expect(reason).toContain("按失败处理");
  });

  it("负数按 0 同族处理:集合被算成负数也是「没有东西被查过」", () => {
    expect(vacuousReason(-1, { subject: "文件", scope: "某片树" })).not.toBe("");
  });

  it("不抛错:空转是一种判定结果,不是异常", () => {
    expect(() => vacuousReason(0, { subject: "文件", scope: "某片树" })).not.toThrow();
  });
});

describe("元断言:每道门禁都做了空转检测", () => {
  /** 真实源码树里的门禁入口(不含免检入口)。 */
  const sources = collectSources(TOOLS_SRC);
  const entryPaths = sources
    .filter((source) => isAssertingGateEntry(source.path))
    .map((s) => s.path);

  it("枚举自证:真实源码树里数得到门禁入口,且走进了 gate 目录", () => {
    // 没有这一条,下面的「全都做了」可以因为「一个都没扫到」而永远绿。
    expect(entryPaths.length, "真实源码树里没数到门禁入口,元断言等于没跑").toBeGreaterThanOrEqual(
      KNOWN_ENTRY_COUNT,
    );
    expect(entryPaths).toContain(KNOWN_ENTRY);
  });

  it("真实源码树里没有一道门禁漏做空转检测", () => {
    expect(gatesMissingVacuousDetection(sources)).toEqual([]);
  });

  it("免检清单的每一条都仍然存在,且写了理由", () => {
    const paths = sources.map((source) => source.path);
    for (const exemption of VACUOUS_EXEMPT_ENTRIES) {
      // 改名 / 挪走之后豁免不能悄悄跟着失效:那会让「免检」变成一条没人看的死数据。
      expect(paths, `免检入口 ${exemption.path} 已经不在了,清单需要跟着改`).toContain(
        exemption.path,
      );
      expect(
        exemption.reason.trim().length,
        `${exemption.path} 的免检理由不能是空的`,
      ).toBeGreaterThan(0);
    }
  });

  it("反例①:去掉某道门禁的空转检测 → 这条元断言变红", () => {
    const original = sources.find((source) => source.path === KNOWN_ENTRY);
    expect(original, "点名的那道门禁不在扫描结果里").toBeDefined();
    const text = original?.text ?? "";
    // 前提自证:原样的源码是过的,否则下面那条「变红」证明不了任何事。
    expect(
      gatesMissingVacuousDetection([{ path: KNOWN_ENTRY, text }]),
      "原样的门禁源码就没过,反例不成立",
    ).toEqual([]);

    const tampered = text
      .split("\n")
      .filter((line) => !line.includes("vacuousReason"))
      .join("\n");
    expect(tampered, "篡改没有改动源码,反例不成立").not.toBe(text);
    expect(gatesMissingVacuousDetection([{ path: KNOWN_ENTRY, text: tampered }])).toEqual([
      KNOWN_ENTRY,
    ]);
  });

  it("反例②:将来新增的门禁入口自动进入视野,不必改任何名单", () => {
    // 路径形态就是判据:一个今天还不存在的入口,只要叫 `run-*-gate.ts`,就必须过这条断言。
    const future = "packages/tools/src/gate/run-future-probe-gate.ts";
    expect(isAssertingGateEntry(future)).toBe(true);
    expect(
      gatesMissingVacuousDetection([{ path: future, text: "export const nothing = 0;\n" }]),
    ).toEqual([future]);
  });

  it("反例③:只 import 不调用、或只在注释里提它,都不算用了它", () => {
    const onlyImport = [
      'import { vacuousReason } from "./vacuous.ts";',
      "",
      "export const nothing = 0;",
      "",
    ].join("\n");
    // 假绿的两种最省事的绕过方式,各喂一份。
    const onlyComment = [
      'import { vacuousReason } from "./vacuous.ts";',
      "",
      "/**",
      " * 这里「显然」用 vacuousReason(0, ...)——但注释不算调用。",
      " */",
      "export const nothing = 0;",
      "",
    ].join("\n");
    const path = "packages/tools/src/gate/run-comment-only-gate.ts";
    expect(gatesMissingVacuousDetection([{ path, text: onlyImport }])).toEqual([path]);
    expect(gatesMissingVacuousDetection([{ path, text: onlyComment }])).toEqual([path]);
  });
});
