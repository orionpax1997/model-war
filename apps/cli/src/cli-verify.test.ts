/**
 * `verify`:按 input.json 重新执行 → 逐 tick hash 比对。
 *
 * 六条用例共用**一场** match。
 *
 * 它们原先各自 `match` 一次(一场 600 tick 约 4.5s),而要的输入逐字相同:
 * `writeMatchInput()` 无参时的产物是确定的。共用一场之后,要改回放的用例各改**自己的副本**
 * (`verify` 只按 `dirname(replay)/input.json` 找输入,同目录即可),所以不会串味,
 * 断言一字未减。`beforeAll` 的超时显式给了 120s:hook 默认 10s,一场 600 tick 远不止。
 */

import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { editReplay, prepareCli, type CliHarness } from "./cli-harness.js";

let cli: CliHarness;
let sharedMatch: { readonly replayPath: string; readonly root: string } | undefined;

/** 跑一局拿到回放路径与它的 root。 */
const matchToReplay = (): { readonly replayPath: string; readonly root: string } => {
  const inputPath = cli.writeMatchInput();
  const root = inputPath.slice(0, inputPath.indexOf("/runs/"));
  const matched = cli.run(["match", inputPath, "--root", root]);
  expect(matched.status, matched.stderr).toBe(0);
  return { replayPath: join(inputPath, "..", "replay.jsonl"), root };
};

beforeAll(async () => {
  cli = await prepareCli();
  sharedMatch = matchToReplay();
}, 120_000);

afterAll(() => {
  cli.dispose();
});

/** 取一份本用例专属的回放副本(与共享的那场同目录、同 `input.json`)。 */
const replayCopy = (suffix: string): readonly [string, string] => {
  // `-t` 单跑某一条时 `beforeAll` 也会跑,但万一某天 hook 被跳过,这里退回真跑一场。
  const shared = sharedMatch ?? matchToReplay();
  const copyPath = join(dirname(shared.replayPath), `replay-${suffix}.jsonl`);
  copyFileSync(shared.replayPath, copyPath);
  return [copyPath, shared.root];
};

it(
  "`verify` 按 input.json 重新执行:match → verify 逐 tick 一致,退出 0",
  { timeout: 120_000 },
  () => {
    const [replayPath, root] = replayCopy("ok");
    const verified = cli.run(["verify", replayPath, "--root", root]);
    expect(verified.status, verified.stderr).toBe(0);
    expect(verified.stdout).toContain("逐项一致");
  },
);

it("`verify` 读不到回放或缺参时按装载期拒跑退 1", () => {
  expect(cli.run(["verify", join(cli.scratch, "no-such-replay.jsonl")]).status).toBe(1);
  expect(cli.run(["verify"]).status).toBe(1);
});

it(
  "`verify` 改回放里一个数字即红:改一个 tick 的 stateHash(与自己载荷不符)退 1",
  { timeout: 120_000 },
  () => {
    const [replayPath, root] = replayCopy("tick-hash");
    editReplay(replayPath, (lines) => {
      const tick = lines[1];
      if (tick === undefined) {
        throw new Error("回放没有 tick 行");
      }
      // 改最后一位:stateHash 不再等于它自己载荷的摘要。
      const hash = String(tick["stateHash"]);
      tick["stateHash"] = `${hash.slice(0, -1)}${hash.endsWith("0") ? "1" : "0"}`;
    });
    expect(cli.run(["verify", replayPath, "--root", root]).status).toBe(1);
  },
);

it("`verify` 改末行 result 的一个数字即红,退 1", { timeout: 120_000 }, () => {
  const [replayPath, root] = replayCopy("result");
  editReplay(replayPath, (lines) => {
    const result = lines.at(-1);
    const rankings = result?.["rankings"];
    if (result === undefined || !Array.isArray(rankings)) {
      throw new Error("回放没有末行 result");
    }
    rankings[0] = Number(rankings[0]) + 1;
  });
  expect(cli.run(["verify", replayPath, "--root", root]).status).toBe(1);
});

it(
  "`verify` 核 meta 的运行时 hash 与本次执行是否一致:不一致即报错退 1,不静默换",
  { timeout: 120_000 },
  () => {
    const [replayPath, root] = replayCopy("runtime-hash");
    editReplay(replayPath, (lines) => {
      const meta = lines[0];
      if (meta === undefined) {
        throw new Error("回放没有 meta 行");
      }
      // 形状仍合法(64 位十六进制),但与本次产物 hash 不同。
      meta["sandboxRuntimeHash"] = "0".repeat(64);
    });
    const verified = cli.run(["verify", replayPath, "--root", root]);
    expect(verified.status).toBe(1);
    expect(verified.stderr).toContain("sandboxRuntimeHash");
  },
);

it(
  "`verify` 核 meta 的执行方式:存档写 stub 与本次真沙箱不符即退 1,不静默换",
  { timeout: 120_000 },
  () => {
    const [replayPath, root] = replayCopy("runner");
    editReplay(replayPath, (lines) => {
      const meta = lines[0];
      if (meta === undefined) {
        throw new Error("回放没有 meta 行");
      }
      // 形状仍合法(stub 那一支要求五个沙箱栏全为 null),但与本次真沙箱执行不符。
      meta["runner"] = "stub";
      for (const field of [
        "quickjsWasiVersion",
        "sandboxRuntimeHash",
        "wasiClock",
        "wasiRandomFill",
        "wasiTimezoneOffset",
      ]) {
        meta[field] = null;
      }
    });
    const verified = cli.run(["verify", replayPath, "--root", root]);
    expect(verified.status).toBe(1);
    expect(verified.stderr).toContain("执行方式不一致");
  },
);

it(
  "`verify` 回放里插一行非回放行即红:统一到 parseReplay 后不再静默忽略,退 1",
  { timeout: 120_000 },
  () => {
    const [replayPath, root] = replayCopy("bogus");
    // 自家 parseLines 是裸 cast:非回放行会被随后的 filter/find 静默忽略,verify 反而退 0;
    // 走 parseReplay 后这类行一律拒跑。这条测试盯着「唯一读入端」的统一不再被拆开。
    editReplay(replayPath, (lines) => {
      lines.splice(1, 0, { type: "bogus" });
    });
    expect(cli.run(["verify", replayPath, "--root", root]).status).toBe(1);
  },
);
