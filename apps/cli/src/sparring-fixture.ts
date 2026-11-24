/**
 * 入库的陪练档 fixture：四份钉死身份的 `script.js` 字节，以及由它拼出的**只差档案**的安装根。
 *
 * ── 为什么要有这份东西 ──
 *
 * 评测网格的四份陪练是钉死的内容摘要（`TRIAL_SPARRING_LADDER` / `TRIAL_SPARRING_SUBSTITUTE` 的
 * `scriptSha256`），`loadSparringPool` 拿它与盘上字节逐字比。而 `archive/` 不入库，于是
 * 「装得起四份陪练」这件事在本机成立、在干净克隆与 CI 上不成立——此前三条端到端用例因此
 * `it.skipIf(!archivePresent)` 静默跳过。跳过的那一条不是断言弱，是**零条**：`--plan` 的
 * 逐字比对、`--expected-plan` 的指名路径一次都没被跑过。
 *
 * 现在那四份字节入库在 `fixtures/archive/sparring-pool/`（只留 `script.js`，逐字节副本；
 * 来源与「为什么不能裁剪」写在它的 README 里），用例读 fixture、不再读仓库根的 `archive/`。
 *
 * ── 安装根为什么造而不是直接用仓库根 ──
 *
 * 计划由**安装面**派生：规则集摘要、两张图的字节摘要、四份陪练的字节摘要、runtime 摘要。
 * `--root` 指仓库根等于让断言读「本机恰好有哪几份存档」——本机与 CI 会得出不同计划（本机的
 * `gpt-6.1-sol` 有自己的档，就在位走自己那份；干净克隆走代位）。所以这里造一个最小安装根：
 * 除 `archive/` 之外全部符号链接回仓库，`archive/` 只放 fixture 里的四份——计划于是在任何机器上
 * 逐字相同，`#substitute` 那条分支也由用例显式钉住。
 *
 * ── 只读，不写 ──
 *
 * 这里建的全是临时根（`mkdtemp`）下的符号链接，仓库根一个字节都不写：需要落盘产物的用例
 * （`gen-cli.test.ts`）自己造可写根，只从这里取四份 `script.js` 的路径。
 */

import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TRIAL_SPARRING_LADDER, TRIAL_SPARRING_SUBSTITUTE } from "@model-war/schema";

/** 仓库根：安装面里除 `archive/` 之外的部分都指回这里。 */
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

/** fixture 根（`<这里>/archive/<slug>/<runId>/script.js`，与安装面同形）。 */
export const SPARRING_FIXTURE_ROOT = fileURLToPath(
  new URL("./fixtures/archive/sparring-pool", import.meta.url),
);

/** fixture 里的四份陪练：顺序同计划（榜首 → 中位 → 末位 → 在位代位）。 */
export const SPARRING_FIXTURE_SCRIPTS: readonly {
  readonly slug: string;
  readonly runId: string;
}[] = [
  ...TRIAL_SPARRING_LADDER.map((identity) => ({
    slug: identity.id,
    runId: identity.runId,
  })),
  { slug: TRIAL_SPARRING_SUBSTITUTE.id, runId: TRIAL_SPARRING_SUBSTITUTE.runId },
];

/** 某一份陪练 `script.js` 的盘上位置（`root` 缺省为 fixture 根）。 */
export const sparringScriptPathIn = (
  script: { readonly slug: string; readonly runId: string },
  root: string = SPARRING_FIXTURE_ROOT,
): string => join(root, "archive", script.slug, script.runId, "script.js");

/**
 * 建一个只差档案的安装根：`rulesets/` `maps/` `packages/`（runtime bundle）与 `node_modules/`
 * （quickjs wasm）符号链接回仓库，`archive/` 按 `sparring` 决定放 fixture 还是干脆缺席。
 *
 * `sparring: "none"` 是「四份陪练缺档」的反例面：装载必须指名失败，而不是静默降级成一场不跑。
 */
export const sparringInstallRoot = (options: {
  readonly scratch: string;
  readonly sparring: "fixture" | "none";
}): string => {
  const root = mkdtempSync(join(options.scratch, `install-${options.sparring}-`));
  for (const name of ["rulesets", "maps", "packages", "node_modules"]) {
    symlinkSync(join(repoRoot, name), join(root, name), "dir");
  }
  if (options.sparring === "none") return root;
  for (const script of SPARRING_FIXTURE_SCRIPTS) {
    const dir = join(root, "archive", script.slug, script.runId);
    mkdirSync(dir, { recursive: true });
    symlinkSync(sparringScriptPathIn(script), join(dir, "script.js"));
  }
  return root;
};
