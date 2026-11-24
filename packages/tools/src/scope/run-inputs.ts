/**
 * 录制测试输入并比对入库 map(ADR-0038 第三条)。
 *
 * ```
 * pnpm run observe:inputs            # 录制 + 与入库比对,有差异即红
 * pnpm run observe:inputs:accept     # 录制并写回入库 map(漂移被看过之后才允许)
 * ```
 *
 * 为什么默认是"比对即红"而不是"自动更新":map 是**判据的输入**。自动更新等于判据自己改自己,
 * 而它改的方向通常是变窄(少记一条输入 → 少跑一批测试 → 绿)。
 *
 * 漂移意味着**某段代码的副作用面变了**——那本身值得被看见,不该悄悄过去。这条与 `gate:rootfs`
 * 同一个形状:入库产物只能被显式重写,不能被链路顺手刷新。
 *
 * map 还带一枚**内容指纹**(`WATCHED_FILES`:recorder + setup + `vitest.config.ts` + 聚合与录制
 * 口径本身)。它管的是比漂移更早的一件事:这份 map 还是不是同一台"仪器"录的。仪器变了
 * (改了 hook、改了 project 划分、改了聚合/录制口径),逐条差异就没意义了——所以这里先报过期、
 * 再谈差异。那段话只有一处(`test-inputs.ts` 的 `snapshotStaleMessage`):`check` 与这里共用它。
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregate,
  currentFingerprint,
  diffInputs,
  isClean,
  loadInputsMap,
  snapshotStaleMessage,
  writeInputsMap,
} from "./test-inputs.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const main = (): number => {
  const accept = process.argv.includes("--accept");
  const scratch = mkdtempSync(join(tmpdir(), "modelwar-inputs-"));
  const jsonl = join(scratch, "inputs.jsonl");

  // 指纹在**录制开始前**取:那次跑的就是这版 recorder / setup / project 划分。跑完再取等于把
  // "录制期间有人改了 config" 藏起来——而那正是这张 map 与那次运行对不上的原因。
  const fingerprint = currentFingerprint(repoRoot);

  // 先跑一遍全量,边跑边记。观测器由 vitest 的 worker `execArgv` 装上(见 vitest.config.ts),
  // 子进程靠 spawn 包装显式注入——所以打好的 CLI 产物里的读盘同样进这张 map。
  const run = spawnSync(process.execPath, ["--run", "test:all"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      MODELWAR_REPO_ROOT: repoRoot,
      MODELWAR_TEST_INPUTS_FILE: jsonl,
    },
  });
  if (run.status !== 0) {
    process.stderr.write(
      `\n录制时的测试运行本身红了(退出码 ${String(run.status)}),先修它再来录输入。\n`,
    );
    rmSync(scratch, { recursive: true, force: true });
    return run.status ?? 1;
  }

  // 指纹在**录制开始时**取:那次跑的就是这版 recorder / setup / project 划分。跑完再取会把
  // "录制期间有人改了 config" 这回事藏起来。
  const recorded = aggregate(readFileSync(jsonl, "utf8"), repoRoot, fingerprint);
  rmSync(scratch, { recursive: true, force: true });

  const testCount = Object.keys(recorded.files).length;
  if (testCount === 0) {
    process.stderr.write(
      "观测一条记录都没有:recorder 没装上,或 setup 文件没把标签写进 MODELWAR_TEST_ID。\n" +
        "空 map 会让选择器静默退回「只靠依赖图」,而依赖图看不见数据文件——所以这里直接红。\n",
    );
    return 1;
  }

  const before = loadInputsMap(repoRoot);
  if (accept) {
    writeInputsMap(repoRoot, recorded);
    process.stdout.write(
      `已写回 ${String(testCount)} 个测试文件的输入(此前 ${String(Object.keys(before.files).length)} 个),` +
        `指纹 ${fingerprint}。\n`,
    );
    return 0;
  }

  // 指纹对不上时,map 的逐条差异没有意义:两份不是同一个仪器录的。先把这件事说出来,
  // 再把人引到重录命令上——否则读的人会去逐个看差异,而看懂了也修不了。
  // 文本不在这里写:`check` 的红线用的是同一段(`snapshotStaleMessage`),两处写两份就会各自漂。
  const stale = snapshotStaleMessage({ map: before, fingerprint });
  if (stale !== undefined) {
    process.stderr.write(`\n${stale}`);
    return 1;
  }

  const drift = diffInputs(before, recorded);
  if (isClean(drift)) {
    process.stdout.write(`输入 map 与入库一致:${String(testCount)} 个测试文件。\n`);
    return 0;
  }

  const show = (label: string, items: readonly string[]): void => {
    if (items.length === 0) return;
    process.stdout.write(`${label}(${String(items.length)}):\n`);
    for (const item of items.slice(0, 12)) process.stdout.write(`  ${item}\n`);
    if (items.length > 12) process.stdout.write(`  … 另有 ${String(items.length - 12)} 条\n`);
  };
  process.stderr.write("输入 map 漂移了——某段代码的副作用面变了:\n");
  show("新增的测试文件", drift.addedFiles);
  show("消失的测试文件", drift.removedFiles);
  for (const changed of drift.changedFiles.slice(0, 8)) {
    show(`${changed.file} 新增的输入`, changed.added);
    show(`${changed.file} 不再读的输入`, changed.removed);
  }
  if (drift.changedFiles.length > 8) {
    process.stderr.write(`… 另有 ${String(drift.changedFiles.length - 8)} 个测试文件的输入变了\n`);
  }
  process.stderr.write(
    "\n这些差异不是错的,但必须被看过:`pnpm run observe:inputs:accept` 写回入库 map。\n" +
      "别习惯性 accept——map 变窄等于少跑,而少跑不报错。\n",
  );
  return 1;
};

process.exitCode = main();
