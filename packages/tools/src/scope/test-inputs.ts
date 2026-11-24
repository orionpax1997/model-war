/**
 * 观测 map 的聚合、落盘与比对(ADR-0038 第三条)。
 *
 * 输入是 `recorder.ts` 写的 JSONL(一条 = 某次 `open` / `spawn`),输出是**按测试文件归并**
 * 的 map:
 *
 * ```json
 * {
 *   "version": 2,
 *   "fingerprint": "…",
 *   "files": { "packages/engine/src/sandbox.test.ts": ["rulesets/basic.json", …] }
 * }
 * ```
 *
 * 为什么按文件归并、不按用例:选中的单位是文件(vitest 的并行单位也是文件)。用例级的粒度
 * 记了但没用上,留着是因为事后想拆就拆不出来了。
 *
 * 为什么要入库:判据随仓库走。与 ADR-0027 让变异基线随仓库走是同一条理由——CI 产物 14 天
 * 就过期,而"哪段代码读哪个文件"是一年都不会变的事实。
 *
 * ── 快照的有效性(票 T5)──
 *
 * "入库"这条理由有一个副作用:map 会比产出它的机器活得久。recorder 换了 hook、`vitest.config.ts`
 * 换了 project 划分、schema 加了字段之后,旧 map 仍然是一份自洽的 JSON——于是它继续被当判据,
 * 而它错的方向恰好是**少记**(少记 = 少跑 = 绿)。所以 map 带一枚**内容指纹**:录制时把产出它
 * 的那几个文件的内容一起哈希进去,读的时候比一次。对不上就**当作过期**,不许假定"也许还对"。
 *
 * 指纹只哈希内容,不掺时间、不掺机器、不掺提交 sha:同一份输入在任何地方重录都得到同一枚指纹,
 * 于是漂移只会来自真的改动。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const INPUTS_MAP_PATH = "test-inputs/inputs.json";

/**
 * 落盘格式的版本。它同时被哈希进指纹里(见 `fingerprintOf`):schema 变了 = 旧 map 读出来的东西
 * 不再是同一件事,即便那三个文件一个字没改。
 */
export const INPUTS_SCHEMA = 2;

/**
 * **产出 map 的那几个文件**。改它们等于换了一台观测仪器,而不是换了被测代码。
 *
 * - `recorder.ts`:决定哪些 API 被 hook。改它,map 的边界就变了(可能变窄)。
 * - `vitest.record-inputs.setup.ts`:把"当前是哪个测试文件"贴成记录标签。标签一错,map 归错档。
 * - `vitest.config.ts`:决定哪个文件属于哪个 project。project 划分变了,`test:all` 的池子就变了,
 *   map 里"谁读什么"的集合也就不再是同一批测试跑出来的。
 * - 本文件(`test-inputs.ts`):聚合口径本身——`isInputPath` / `OUTPUT_PREFIXES` 决定哪些路径
 *   算输入、怎么归并成键。它一宽松,map 就**静默变窄**(少记 = 少跑),而指纹不变的话
 *   没人会发现那是新口径录出来的。
 * - `run-inputs.ts`:录的是哪条命令、什么时候取指纹。录制口径一变(比如改成只跑一部分
 *   project),旧 map 照样"自洽",但它已经不是同一台仪器录的那份东西。
 *
 * 后两条是本轮补的:它们**同样能只让 map 变窄**,而原来的指纹看不见它们——保护一个口径,
 * 却漏掉定义这个口径的两个装配点,那枚指纹就只保护了一半。
 *
 * 代价是有意接受的:改这五个文件就要重录一次(实测约 110s),漂移检查本来也只在 nightly 上。
 */
export const WATCHED_FILES: readonly string[] = [
  "packages/tools/src/scope/recorder.ts",
  "vitest.record-inputs.setup.ts",
  "vitest.config.ts",
  "packages/tools/src/scope/test-inputs.ts",
  "packages/tools/src/scope/run-inputs.ts",
];

/** 被监视的文件不见了也**进指纹**:删掉它,map 同样不再是它当初是的那份东西。 */
export const MISSING_FILE = "<missing>";

export interface InputsMap {
  readonly version: number;
  /** 录制时的 `currentFingerprint`;空串 = 旧快照(见 `isSnapshotCurrent`)。 */
  readonly fingerprint: string;
  readonly files: Record<string, readonly string[]>;
}

/**
 * 一组文本的内容指纹(sha256 截断到 16 个十六进制字符)。
 *
 * 每段前面写长度:否则 `["ab", "c"]` 与 `["a", "bc"]` 会撞在一起,而这两者是不同的输入。
 * 开头写 schema 号同理——它也是"这份 map 由什么产出"的一部分。
 */
export const fingerprintOf = (parts: readonly string[]): string => {
  const hash = createHash("sha256");
  hash.update(`inputs-schema:${String(INPUTS_SCHEMA)}\n`);
  for (const part of parts) hash.update(`${String(part.length)}\n${part}\n`);
  return hash.digest("hex").slice(0, 16);
};

/** 仓库里**现在**该有的指纹;与入库 map 的 `fingerprint` 不等即过期。 */
export const currentFingerprint = (repoRoot: string): string =>
  fingerprintOf(
    WATCHED_FILES.map((file) => {
      const path = join(repoRoot, file);
      return existsSync(path) ? readFileSync(path, "utf8") : MISSING_FILE;
    }),
  );

/**
 * 快照还能当判据吗?**只有一种情况能**:录制时留下的指纹非空,且与现在的一致。
 *
 * 空指纹一律判过期:旧快照(无指纹)与"没说清"是同一件事,而没说不许被当成"大概没事"。
 */
export const isSnapshotCurrent = (input: {
  readonly map: InputsMap;
  readonly fingerprint: string;
}): boolean => input.map.fingerprint !== "" && input.map.fingerprint === input.fingerprint;

/**
 * 快照过期时的红消息。**过期即红**:`undefined` = 还能当判据。
 *
 * 为什么不是"警告一句然后照旧用":旧 map 的失效方向是**少记**——recorder 换了 hook、project
 * 划分变了之后,它会安静地少几条观测,于是选择器少选一批测试,而少选不报错。既然"用过期的
 * 判据"与"没有判据"是同一件事,就必须在**拿它当判据之前**停下。
 *
 * 消息里三个要素缺一不可:两个指纹(谁跟谁对不上)、"为什么指纹能决定这件事"、两条命令
 * (`observe:inputs:accept` 重录、`observe:inputs` 复核,后者是防止重录把变窄写进仓库)。
 *
 * **它只存在一处**:录制的比对(`run-inputs.ts`)与 `check` 的红线都直接调这里。两处各写一段
 * 近似文本的时候,两段会各自漂——一边说清了"仪器变了",另一边还在说"逐条差异"。
 */
export const snapshotStaleMessage = (input: {
  readonly map: InputsMap;
  readonly fingerprint: string;
}): string | undefined => {
  if (isSnapshotCurrent(input)) return undefined;
  const recorded = input.map.fingerprint === "" ? "(空:旧快照没有指纹)" : input.map.fingerprint;
  const watched = WATCHED_FILES.map((file) => `    ${file}`).join("\n");
  return (
    `观测快照过期:入库指纹 ${recorded},现在是 ${input.fingerprint}。\n` +
    `指纹覆盖产出这张 map 的 ${String(WATCHED_FILES.length)} 个装配点:\n` +
    `${watched}\n` +
    "仪器变了,旧 map 里「谁读什么」不再是同一回事,逐条差异也已无意义。\n" +
    "拿它判「有没有测试观测到」只会少跑,所以这里直接红。\n" +
    "重录:`node --run observe:inputs:accept`(约 110s);复核:`node --run observe:inputs`\n" +
    "(重录变窄等于少跑,复核就是在拦这件事)。\n"
  );
};

/**
 * 这些前缀下的路径是**产物**,不是输入:测试写它们、报告落它们。记进来会让 map 把"我刚写的
 * 报告"当成"我依赖的输入",于是改一个报告路径就触发一批无关用例。
 */
const OUTPUT_PREFIXES: readonly string[] = [
  "reports/",
  "runs/",
  ".vitest/",
  ".stryker-tmp/",
  ".scratch/",
  ".workspaces/",
  "node_modules/",
  ".git/",
];

export const isInputPath = (path: string): boolean =>
  path !== "" && !OUTPUT_PREFIXES.some((prefix) => path.startsWith(prefix));

interface Line {
  /** `<测试文件>::<用例名>`,setup 文件贴的标签。 */
  readonly t: string;
  readonly k: "open" | "spawn";
  readonly p: string;
}

const parseLines = (jsonl: string): readonly Line[] =>
  jsonl
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Line];
      } catch {
        // 进程被杀时最后一行可能不完整。丢一条记录比让整次比对失败便宜。
        return [];
      }
    });

/**
 * 把 JSONL 聚合成入库的形状。键是**仓库相对**的测试文件路径,值是它读到的仓库内路径(排序去重)。
 *
 * 归一化这一步不能省:标签来自 `expect.getState().testPath`,它是**绝对路径**。直接把绝对路径
 * 写进 map,键就与 `git diff` 给的相对路径对不上——选择器永远匹配不到,而且匹配不到是静默的
 * (只是少跑)。同一台机器上它还带着 home 目录,换个 clone 位置 map 就全废。
 */
export const aggregate = (jsonl: string, repoRoot: string, fingerprint: string): InputsMap => {
  const prefix = `${repoRoot.replace(/\/+$/, "")}/`;
  const relative = (path: string): string =>
    path.startsWith(prefix) ? path.slice(prefix.length) : path;
  const byFile = new Map<string, Set<string>>();
  for (const line of parseLines(jsonl)) {
    const file = relative(line.t.split("::")[0] ?? "");
    if (file === "" || !isInputPath(line.p)) continue;
    const set = byFile.get(file) ?? new Set<string>();
    set.add(line.p);
    byFile.set(file, set);
  }
  const files: Record<string, readonly string[]> = {};
  for (const file of [...byFile.keys()].sort()) {
    files[file] = [...(byFile.get(file) ?? [])].sort();
  }
  return { version: INPUTS_SCHEMA, fingerprint, files };
};

/**
 * 读入库 map。**刻意对旧格式宽容**:旧快照(没有 `fingerprint`)读得出来,只是指纹为空串,
 * 由 `isSnapshotCurrent` 判为过期。读的时候不炸、判的时候炸——这样红的发生在"拿它当判据"那一刻,
 * 消息才能指向重录命令,而不是变成一条解析错误。
 */
export const loadInputsMap = (repoRoot: string): InputsMap => {
  const path = join(repoRoot, INPUTS_MAP_PATH);
  if (!existsSync(path)) return { version: INPUTS_SCHEMA, fingerprint: "", files: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<InputsMap>;
  return {
    version: INPUTS_SCHEMA,
    fingerprint: typeof parsed.fingerprint === "string" ? parsed.fingerprint : "",
    files: parsed.files ?? {},
  };
};

export const writeInputsMap = (repoRoot: string, map: InputsMap): void => {
  const path = join(repoRoot, INPUTS_MAP_PATH);
  mkdirSync(dirname(path), { recursive: true });
  const files: Record<string, readonly string[]> = {};
  for (const file of Object.keys(map.files).sort()) files[file] = map.files[file] ?? [];
  writeFileSync(
    path,
    `${JSON.stringify({ version: INPUTS_SCHEMA, fingerprint: map.fingerprint, files }, null, 2)}\n`,
  );
};

export interface Drift {
  /** 新出现的测试文件 → 它们读到的输入。 */
  readonly addedFiles: readonly string[];
  /** 不再出现的测试文件。 */
  readonly removedFiles: readonly string[];
  /** 已有文件新增/移除了哪些输入。 */
  readonly changedFiles: readonly {
    readonly file: string;
    readonly added: readonly string[];
    readonly removed: readonly string[];
  }[];
}

export const diffInputs = (before: InputsMap, after: InputsMap): Drift => {
  const addedFiles: string[] = [];
  const removedFiles: string[] = [];
  const changedFiles: { file: string; added: string[]; removed: string[] }[] = [];
  for (const file of Object.keys(after.files)) {
    if (before.files[file] === undefined) addedFiles.push(file);
  }
  for (const file of Object.keys(before.files)) {
    if (after.files[file] === undefined) {
      removedFiles.push(file);
      continue;
    }
    const beforeSet = new Set(before.files[file] ?? []);
    const afterSet = new Set(after.files[file] ?? []);
    const added = [...afterSet].filter((path) => !beforeSet.has(path));
    const removed = [...beforeSet].filter((path) => !afterSet.has(path));
    if (added.length > 0 || removed.length > 0) changedFiles.push({ file, added, removed });
  }
  return { addedFiles, removedFiles, changedFiles };
};

export const isClean = (drift: Drift): boolean =>
  drift.addedFiles.length === 0 &&
  drift.removedFiles.length === 0 &&
  drift.changedFiles.length === 0;

/** 反向索引:某个路径被哪些测试文件读到。选择器用它把"改了这个文件"翻成"要跑哪些文件"。 */
export const invert = (map: InputsMap): ReadonlyMap<string, ReadonlySet<string>> => {
  const index = new Map<string, Set<string>>();
  for (const [file, inputs] of Object.entries(map.files)) {
    for (const input of inputs) {
      const set = index.get(input) ?? new Set<string>();
      set.add(file);
      index.set(input, set);
    }
  }
  return index;
};
