/**
 * 门禁:沙箱**真跑起来**是什么样(根脚本 `check:sandbox`)。
 *
 * 用法:`pnpm run check:sandbox`(命名脚本里先 `pnpm run build`,这一条要加载执行器的编译形态)。
 *
 * ── 七件事,一件都不能 skip ──
 *
 * 下面七条对应 `main()` 里的七个 `Outcome`,一条一个入口;前五条判「沙箱本身」,后两条判
 * 「宿主工具这条路」——`check` / `evaluate` / `finish` 不在沙箱里,所以这两条判的是两个方向:
 * 沙箱里**没有**它们(模型没有那条路),宿主分派**跑得通**它们(那条路真的通向一个服务)。
 *
 * 1. **可用性**:驱动生产执行器的 `sandbox.preflight()`。失败即红,红在**这一行**,而不是变成
 *    后面一串莫名失败的用例。ADR-0033 的立场是「不可用就跳过」的反面:跳过会让环境变化
 *    (Ubuntu 收紧非特权 userns)悄悄变成一整排静默通过的检查。
 * 2. **无网络**:沙箱的网络命名空间里只许有 `lo`(结构),且 `/dev/tcp` 连一个外部地址必须
 *    失败(行为)。刻意不要求「宿主自己连得上外网」——那会让门禁随机器今天的网络状况红绿。
 * 3. **后台进程不残留**:`cmd &` 之后这一步必须**立即返回**,且宿主 `/proc` 里查不到那个进程。
 *    同样配正对照:某一步正在跑时,宿主 `/proc` 里**看得到**它——否则「查不到」只是因为扫描
 *    本身看不见东西(空转)。正对照用一步死循环跑满墙钟,顺带把「墙钟到点杀整棵进程树」
 *    这条也真跑一遍(`timedOut` 必须为真)。
 * 4. **rootfs 漂移**:复用 `check:sandbox-rootfs` 的六条判据(同 `rootfs-check.ts` 一份实现)。
 *    这条放这里是因为「沙箱里跑的东西」与「入库的内容物」是同一件事的两面:前者证明隔离成立,
 *    后者证明隔离住的正是那份字节。
 * 5. **命令真能用**:`sed` / `head` / `tail` / `wc` 各跑一条最小调用,并各断言 stdout 逐字节
 *    相符。这条判据的形状与其余六条不同:它不问「文件在不在」(那是 `check:sandbox-rootfs`
 *    的事),它问「模型敲下去之后能不能拿到它想要的字节」——`sed -i` 改得动文件、`sed -n`
 *    取得到 `api.md` 的中间段。没有它们时,`cat` 只能吐出 16 KiB 截断后的首尾两段,中间那
 *    一半模型**结构性读不到**;而「文件在库里」与「模型读得到」是两件事。
 * 6. **沙箱里没有宿主工具**:`check` / `evaluate` / `finish` / `probe` 在沙箱的 PATH 上都敲不到,
 *    且 `/bin` 的内容物与入库清单逐个相等。它取代了旧版的「薄壳通道」那条判据(通道与薄壳
 *    已删除):判的不是「那条缝接上没有」,而是「那条路不存在」。
 * 7. **宿主分派跑通 check**:驱动 `tools.dispatch(1, {name:"check"})`,让真 `check` 服务跑一次
 *    tsc 与静态校验,断言回包是 `ToolOutcome`、退出码、stdout 与写回工作区的 `.check.txt`。
 *
 * 第 5 条只管四份 coreutils 那一个面;第 6、7 条是宿主工具那一面。两面的差别是「沙箱能跑命令」
 * 与「模型调得动宿主工具」——后者不成立时共享的仍然是一条绿而不是一堆红。
 *
 * ── 真会话那条在本门禁之后跑,不在这份文件里 ──
 *
 * 「一场真会话在这套隔离里走得完」那一条住在 `apps/cli/src/agent-real-session.test.ts`
 * (vitest 的 `sandbox` project),由根脚本 `check:sandbox` 紧跟本门禁之后跑。它必须读
 * `packages/gen` 与 `packages/runner` 的编译形态,而工具包不得 import 它们(hld §3.2),
 * 所以它不能写在这里。顺序是先隔离、后会话:隔离不成立时,那一条的结论没有意义。
 *
 * ── 为什么它不挂在 `check` / `check:quick` 上 ──
 * 它需要内核能力(非特权 user namespace)与系统装的 `bubblewrap`。挂进常跑链,「全量门禁红了」
 * 会同时意味着「提交内容有问题」与「这台机器没装 bubblewrap」——两种处方混成一条红。所以它是
 * 自己那条命名脚本 + nightly 的硬腿(`.github/workflows/nightly.yml`),安装走 `pnpm run setup:sandbox`。
 *
 * ── 为什么断言全在门禁这边 ──
 * 执行器住在 `packages/gen`,工具包不能 import 它(hld §3.2),所以门禁**把执行器当黑盒驱动**
 * (`executor-bridge.ts`):起子进程、喂一份 JSON、读回结果。断言——包括「什么算失败」——只写在
 * 这里,执行器那边一行判据也没有。
 *
 * 退出码:0 = 七件事全成立;1 = 任一条不成立(含空转)。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { CONTRACT_DIR } from "../contract-package.ts";
import { vacuousReason } from "../gate/vacuous.ts";
import { driveExecutor, EXECUTOR_ENTRY, type BridgeRequest } from "./executor-bridge.ts";
import { checkRootfsTree, rootfsCheckSummary } from "./rootfs-check.ts";
import { sandboxRootfsConstantsFrom, SCHEMA_CONSTANTS_SOURCE } from "./rootfs-drift.ts";

/** 本文件在 `<repo>/packages/tools/src/sandbox-rootfs/` 下,上溯四层是仓库根。 */
const repoRoot = resolve(import.meta.dirname, "../../../..");

/** 无网络那条判据用的目标。裸 IP:沙箱里没有 DNS,用域名会把「解析不了」当成「连不上」。 */
const NETWORK_TARGET = { host: "1.1.1.1", port: 443 } as const;

/** 后台进程判据里「立即返回」的口径。一步的回包要远小于单步墙钟(默认 120 s)。 */
const IMMEDIATE_RETURN_MS = 5_000;

/** 后台进程判据里的探针:bash 死循环,不需要 rootfs 里存在 `sleep`(那里只有 bash 与 coreutils)。 */
const spin = (nonce: string): string => `# ${nonce}\nwhile :; do :; done`;

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** 宿主 `/proc` 里有几个进程的命令行含这个串。自己这个进程不算(它不该含,含了也排除掉)。 */
const processesMentioning = (nonce: string): readonly string[] => {
  const hits: string[] = [];
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/u.test(pid) || pid === String(process.pid)) continue;
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
      if (cmdline.includes(nonce)) hits.push(`${pid}: ${cmdline}`);
    } catch {
      // 进程在扫描与读取之间退出了:那是常态,不是错误。
    }
  }
  return hits;
};

/** 一次判据的结果:一条说明 + 0..n 条违规。 */
type Outcome = { readonly line: string; readonly failures: readonly string[] };

const main = async (): Promise<number> => {
  const outcomes: Outcome[] = [];
  const workspaceDir = mkdtempSync(join(tmpdir(), "model-war-sandbox-gate-"));
  const note = "（这一条不成立时,下面的检查结果不代表提交内容有问题）";

  try {
    const preflight = await driveExecutor(repoRoot, {
      action: "preflight",
      rootfsDir: join(repoRoot, "packages/gen/sandbox-rootfs"),
    });
    outcomes.push(
      preflight.ok
        ? {
            line: `✓ 可用性:preflight 通过(bwrap ${String(preflight.version)};rootfs 的最小挂载集跑得起来)`,
            failures: [],
          }
        : { line: "✗ 可用性:preflight 失败", failures: [preflight.message] },
    );

    // ①' 执行器没有编译形态时,后面每一条都会以「起不来」红——先说清这一点。
    if (!preflight.ok) {
      report(outcomes, note);
      return 1;
    }

    outcomes.push(await networkOutcome(workspaceDir));
    outcomes.push(await noHostPathOutcome(workspaceDir));
    outcomes.push(await dispatchOutcome(workspaceDir));
    outcomes.push(await coreutilsOutcome(workspaceDir));
    outcomes.push(await backgroundOutcome(workspaceDir));
    outcomes.push(rootfsOutcome());
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }

  report(outcomes, note);
  return outcomes.some((outcome) => outcome.failures.length > 0) ? 1 : 0;
};

/**
 * 判据 2:沙箱内出不了网。
 *
 * ├ 两条断言,一条结构、一条行为 ┤
 * - **结构**:沙箱里的 `/proc/net/dev` 只许有 `lo`。`--unshare-net` 给的是一个全新的网络
 *   命名空间,里面没有一块能往外发包的设备;少了这条参数的话,沙箱看到的会是**宿主自己**那一组
 *   接口。这条不需要外网,所以它不会因为「这台机器今天上不了网」而红。
 * - **行为**:`/dev/tcp` 连一个外部地址必须失败。它只在一个方向上会红:连**成功**了。
 *   连不上既可能是隔离生效,也可能是这台机器本来就没有路由——所以单独的「连不上」不是判据,
 *   它只是结构那条的旁证。
 *
 * 这里刻意**不**要求「宿主自己连得上外网」:那会让门禁随机器今天的网络状况红绿,而它要断言的
 * 是沙箱的隔离,不是机器的连通性。反过来说,「连上了」永远是真 bug,不需要正对照。
 */
const networkOutcome = async (workspaceDir: string): Promise<Outcome> => {
  const failures: string[] = [];
  const result = await driveExecutor(repoRoot, {
    action: "run",
    rootfsDir: join(repoRoot, "packages/gen/sandbox-rootfs"),
    workspaceDir,
    wallClockMs: 30_000,
    command: [
      "cat /proc/net/dev",
      "printf '\\n---\\n'",
      `if exec 3<>/dev/tcp/${NETWORK_TARGET.host}/${String(NETWORK_TARGET.port)} 2>/dev/null; then`,
      "  printf 'tcp=reachable\\n'",
      "else",
      "  printf 'tcp=blocked\\n'",
      "fi",
    ].join("\n"),
  });
  if (!result.ok) {
    return { line: "✗ 无网络", failures: [`沙箱里跑连通性探针时执行器报错:${result.message}`] };
  }

  const stdout = result.stdout ?? "";
  const [interfacesPart = "", behaviourPart = ""] = stdout.split("\n---\n");
  const interfaces = [...interfacesPart.matchAll(/^\s*([A-Za-z0-9_.@-]+):/gmu)].map(
    (match) => match[1] ?? "",
  );
  const foreign = interfaces.filter((name) => name !== "lo");
  if (foreign.length > 0) {
    failures.push(
      `沙箱里的网络接口除了 lo 还有 ${foreign.join(" / ")}:这不是一个断网的命名空间,` +
        "模型可以往外发包(而沙箱隔离的前提之一就是它连不出去)。",
    );
  }
  if (!behaviourPart.includes("tcp=blocked")) {
    failures.push(
      `沙箱里居然连上了 ${NETWORK_TARGET.host}:${String(NETWORK_TARGET.port)}` +
        `(stdout ${JSON.stringify(behaviourPart.trim())},退出码 ${String(result.exitCode)})。` +
        "无网络是这条沙箱的结构性事实,它不成立就等于整套隔离的前提不成立。",
    );
  }

  return failures.length === 0
    ? {
        line:
          "✓ 无网络:沙箱的网络命名空间里只有 lo(没有一块能往外发包的设备)," +
          `且连 ${NETWORK_TARGET.host}:${String(NETWORK_TARGET.port)} 失败`,
        failures,
      }
    : { line: "✗ 无网络", failures };
};

/**
 * 判据 6:沙箱里**没有**通往宿主工具的那条路。
 *
 * ── 它取代了旧版的「薄壳通道」那条判据 ──
 *
 * 旧版在沙箱里 `echo` 一次薄壳,断言宿主收到恰好一行 JSON——那条判据测的是 fd 3 本身,而 fd 3
 * 已整套删除(票 03)。换来的这条测的是**删除后的主张**:`check` / `evaluate` / `finish` 在沙箱里
 * 连名字都没有,`/bin` 的内容物与清单逐个相等。
 *
 * 它为什么不是空转:模型在沙箱里能敲的东西就是 `ls /bin` 的这份清单。少一个(清单说有、盘上没有)
 * 与多一个(盘上有、清单没有)都会让「模型看见的世界 == 入库的那棵树」不再成立;而那三个名字
 * 一旦重新出现在 `bin/` 里,「宿主是唯一执行者」立刻退回旧世界的脆弱版本——一条 `#!/bin/sh`
 * 的脚本能做的事,和一条命令能做的一样多。
 */
const noHostPathOutcome = async (workspaceDir: string): Promise<Outcome> => {
  const failures: string[] = [];
  const result = await driveExecutor(repoRoot, {
    action: "run",
    rootfsDir: join(repoRoot, "packages/gen/sandbox-rootfs"),
    workspaceDir,
    wallClockMs: 30_000,
    command: [
      // `command -v` 只看 PATH 与可执行位:它与模型敲下去之后的解析是同一条判据。
      "for t in check evaluate finish probe; do",
      `  if command -v "$t" >/dev/null 2>&1; then printf 'present:%s\\n' "$t"; fi`,
      "done",
      // 分隔行用 `%s` 而不是把它写进格式串:`printf '---\\n'` 会把 `--` 当成选项前缀。
      `printf '%s\\n' '---'`,
      "ls /bin",
    ].join("\n"),
  });
  if (!result.ok) {
    failures.push(`在沙箱里查 \`/bin\` 时执行器报错:${result.message}`);
    return { line: "✗ 沙箱里没有宿主工具", failures };
  }

  const [absentPart = "", binPart = ""] = (result.stdout ?? "").split("---\n");
  const present = absentPart
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("present:"))
    .map((line) => line.slice("present:".length));
  if (present.length > 0) {
    failures.push(
      `宿主工具名在沙箱里敲得到:${present.join(" / ")}。它们必须是**工具调用**,` +
        "不是沙箱里的命令——名字一旦落在 `bin/` 里,模型就能用 shell 语法绕过任何分派判据。",
    );
  }

  const manifest = sandboxRootfsConstantsFrom(
    readFileSync(join(repoRoot, SCHEMA_CONSTANTS_SOURCE), "utf8"),
  );
  if (!manifest.ok) {
    failures.push(manifest.reason);
    return { line: "✗ 沙箱里没有宿主工具", failures };
  }
  const expected = manifest.constants.files
    .filter((path) => path.startsWith("bin/"))
    .map((path) => path.slice("bin/".length))
    .sort();
  const actual = binPart
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .sort();
  // 两侧排序后逐字节比:多一个、少一个、改个名字都在这里显形。
  if (expected.join(" ") !== actual.join(" ")) {
    failures.push(
      `沙箱里的 \`/bin\` 与入库清单不一致:清单 ${expected.join(" / ")},` +
        `沙箱 ${actual.join(" / ")}。这份差要么是 rootfs 组装漏了文件,要么是挂载面变了。`,
    );
  }

  return failures.length === 0
    ? {
        line:
          `✓ 沙箱里没有宿主工具:\`check\` / \`evaluate\` / \`finish\` / \`probe\` 在 PATH 上都敲不到,` +
          `\`/bin\` 的 ${String(expected.length)} 个名字与入库清单逐个相等`,
        failures,
      }
    : { line: "✗ 沙箱里没有宿主工具", failures };
};

/**
 * 判据 7:宿主分派真的跑通一次 `check`——真 `createSessionTools`、真 `check` 服务(真 tsc +
 * 真静态校验器)。
 *
 * ── 它取代了旧版的「薄壳跑通 check」 ──
 *
 * 旧版让沙箱里的薄壳经 fd 3 把请求送到宿主,断言那条命令的退出码与 stdout;它测的整条链里有
 * 两环(薄壳、fd 3)已删除。新版把这两环换成**工具调用**这一环:门禁驱动 `tools.dispatch(1, call)`,
 * 断言回包是 `ToolOutcome`、`check` 服务真的跑了、全文真的写回工作区。链路短了,而判据的
 * 主张没变:**模型调到的东西背后是一个真在跑的服务,不是一个占位**。
 *
 * 它为什么不是空转:输入是契约里那份最小骸骨(`/contract/examples/minimal.ts` 的宿主副本,
 * 就是模型第一步 `cp` 的那一份)。没有它就得在门禁里手写一份「恰好能编译」的脚本,而那是
 * 第二份真源。期望的字节(`类型检查通过`、`.check.txt` 里的 `# 类型检查`)都是服务自己写的,
 * 门禁只说「它写出来了」。
 */
const dispatchOutcome = async (workspaceDir: string): Promise<Outcome> => {
  const failures: string[] = [];
  const toolWorkspace = join(workspaceDir, "dispatch");
  mkdirSync(toolWorkspace, { recursive: true });
  writeFileSync(
    join(toolWorkspace, "script.ts"),
    readFileSync(join(repoRoot, CONTRACT_DIR, "examples", "minimal.ts")),
  );

  // 真 tsc 要几秒;这条缝自己的保险丝比它宽。
  const result = await driveExecutor(
    repoRoot,
    {
      action: "dispatch",
      workspaceDir: toolWorkspace,
      tool: "check",
      argumentsJson: "{}",
    },
    180_000,
  );

  if (!result.ok) {
    failures.push(`宿主分派 \`check\` 时报错:${result.message}`);
    return { line: "✗ 宿主分派跑通 check", failures };
  }
  const outcome = result.outcome;
  if (outcome === undefined) {
    failures.push(
      "分派没有交回结果:这一条要证明的是「工具调用背后是一个真服务」," +
        "拿不到回包时它什么都没证明。",
    );
    return { line: "✗ 宿主分派跑通 check", failures };
  }
  if (outcome.isError === true) {
    failures.push(
      `\`check\` 被拒了(isError):${JSON.stringify(outcome.stderr.slice(0, 400))}。` +
        "这份输入是契约里那份可编译的骸骨,它该过。",
    );
  }
  if (outcome.exitCode !== 0) {
    failures.push(
      `\`check\` 的退出码是 ${String(outcome.exitCode)}(期望 0;` +
        `stdout ${JSON.stringify(outcome.stdout.slice(0, 400))},` +
        `stderr ${JSON.stringify(outcome.stderr.slice(0, 400))})。` +
        "这份输入是契约里那份可编译的骸骨,它该过。",
    );
  }
  if (!outcome.stdout.includes("类型检查通过")) {
    failures.push(
      `\`check\` 的 stdout 没有「类型检查通过」:${JSON.stringify(outcome.stdout.slice(0, 400))}。` +
        "要么结果没有解回 stdout,要么服务根本没被调到。",
    );
  }
  const fullTextPath = join(toolWorkspace, ".check.txt");
  const full = existsSync(fullTextPath) ? readFileSync(fullTextPath, "utf8") : "";
  if (!full.includes("# 类型检查")) {
    failures.push(
      `宿主没有把全文写回 ${fullTextPath}:"模型按需去读"这条观测出口当场不成立` +
        `(文件${existsSync(fullTextPath) ? "存在但内容不对" : "不存在"})。`,
    );
  }

  return failures.length === 0
    ? {
        line:
          "✓ 宿主分派跑通 check:真 dispatcher + 真 check 服务,tsc 与静态校验真的跑了," +
          "回包是 `ToolOutcome`(不是一行 JSON),stdout 与 .check.txt 都对得上",
        failures,
      }
    : { line: "✗ 宿主分派跑通 check", failures };
};

/** 一条最小调用:沙箱里跑什么、期望 stdout 是哪些字节。 */
type CommandProbe = {
  /** 报告里怎么称呼这一条(命令名)。 */
  readonly tool: string;
  /** 沙箱里的命令。工作目录是 `/workspace`(可写),所以探针文件写相对路径。 */
  readonly command: string;
  /** 期望的 stdout,**逐字节**比,不比「包含」。 */
  readonly stdout: string;
};

/**
 * 判据 5:新增的四个 coreutils **真能用**,不是「文件在库里」。
 *
 * ── 为什么这条不能由 `check:sandbox-rootfs` 承担 ──
 *
 * 那边判的是字节与清单(静态 ELF、树哈希、逐字节副本),它证明「这四份二进制入库了」。
 * 但模型要的是「敲 `sed -n '120,240p' /contract/api.md` 就能读到中间段」——两件事之间隔着
 * 一次真执行:参数被 static 版接住、`sed -i` 在 `/workspace` 上改得动、`wc -l` 读得到重定向。
 * 一条 `if [ -x /bin/sed ]` 的探针会把这三件全放过,所以这里每条都断言**输出字节**。
 *
 * 期望值不手抄:`sed` 那条取的是 `/contract/api.md` 的第 120–121 行(现算),其余三条取的是
 * 探针自己写下的字节。前者顺带证明「中间段可达」那处能力洞真的补上了——`cat` 在 16 KiB 上限
 * 下吐不出那一段。
 */
const coreutilsOutcome = async (workspaceDir: string): Promise<Outcome> => {
  const failures: string[] = [];
  const probeWorkspace = join(workspaceDir, "coreutils");
  mkdirSync(probeWorkspace, { recursive: true });

  // 中间段的期望值现算自真源。抽不出非空的一段时按失败报:空期望 == 什么都没断言。
  const apiLines = readFileSync(join(repoRoot, CONTRACT_DIR, "api.md"), "utf8").split("\n");
  const apiSlice = `${apiLines.slice(119, 121).join("\n")}\n`;
  if (apiSlice.trim() === "" || !apiLines[119]) {
    failures.push(
      `判据自己空了:\`${CONTRACT_DIR}/api.md\` 的第 120–121 行读不到内容,` +
        "「sed 取得到中间段」这条此时什么都没断言。",
    );
    return { line: "✗ coreutils 真能用", failures };
  }

  const probes: readonly CommandProbe[] = [
    {
      // 取行段 + 就地改:`sed -i` 是「改一行不必整份重写」那处能力洞的唯一补法。
      tool: "sed",
      command: [
        "printf 'a\\nb\\nc\\n' > sed.txt",
        "sed -i 's/^b$/B/' sed.txt",
        "sed -n '1,2p' sed.txt",
      ].join("\n"),
      stdout: "a\nB\n",
    },
    {
      // 中间段:这就是 `cat` 在 16 KiB 截断下读不到的那一半。
      tool: "sed(中间段)",
      command: "sed -n '120,121p' /contract/api.md",
      stdout: apiSlice,
    },
    {
      tool: "head",
      command: "printf 'a\\nb\\nc\\n' > head.txt\nhead -c 4 head.txt",
      stdout: "a\nb\n",
    },
    {
      tool: "tail",
      command: "printf 'a\\nb\\nc\\n' > tail.txt\ntail -n 1 tail.txt",
      stdout: "c\n",
    },
    {
      tool: "wc",
      command: "printf 'a\\nb\\nc\\n' > wc.txt\nwc -l < wc.txt",
      stdout: "3\n",
    },
  ];

  for (const probe of probes) {
    const result = await driveExecutor(
      repoRoot,
      {
        action: "run",
        rootfsDir: join(repoRoot, "packages/gen/sandbox-rootfs"),
        workspaceDir: probeWorkspace,
        wallClockMs: 30_000,
        command: probe.command,
      },
      60_000,
    );
    if (!result.ok) {
      failures.push(`沙箱里跑 \`${probe.tool}\` 时执行器报错:${result.message}`);
      continue;
    }
    if (result.exitCode !== 0) {
      failures.push(
        `\`${probe.tool}\` 在沙箱里的退出码是 ${String(result.exitCode)}(期望 0;` +
          `stderr ${JSON.stringify((result.stderr ?? "").slice(0, 300))})。这四件是 rootfs 内容物里的静态二进制,` +
          "跑不起来说明入库的字节与 `PROVENANCE.md` 说的那份不是同一份。",
      );
      continue;
    }
    if ((result.stdout ?? "") !== probe.stdout) {
      failures.push(
        `\`${probe.tool}\` 的 stdout 是 ${JSON.stringify(result.stdout ?? "")},` +
          `期望 ${JSON.stringify(probe.stdout)}。命令跑起来了但给出的字节不对——` +
          "这条判的是「工具能用」,不是「文件在」。",
      );
    }
  }

  return failures.length === 0
    ? {
        line:
          "✓ coreutils 真能用:`sed -n` / `sed -i` / `head -c` / `tail -n` / `wc -l` 各跑一条最小调用," +
          "stdout 逐字节相符(`sed -n '120,121p' /contract/api.md` 取到了 16 KiB 截断下读不到的中间段)",
        failures,
      }
    : { line: "✗ coreutils 真能用", failures };
};

/** 判据 3:后台进程不残留;正对照是「某一步在跑时宿主看得见它」。 */
const backgroundOutcome = async (workspaceDir: string): Promise<Outcome> => {
  const failures: string[] = [];
  const rootfsDir = join(repoRoot, "packages/gen/sandbox-rootfs");
  const request = (command: string, wallClockMs: number): BridgeRequest => ({
    action: "run",
    rootfsDir,
    workspaceDir,
    command,
    wallClockMs,
  });

  // 正对照先做:一步死循环跑满墙钟,中途宿主 `/proc` 里必须能看见这个串。
  const liveNonce = `mwsandbox-live-${String(Date.now())}`;
  const live = driveExecutor(repoRoot, request(spin(liveNonce), 1_500));
  await sleep(700);
  const seenWhileRunning = processesMentioning(liveNonce);
  const liveResult = await live;
  if (!liveResult.ok) {
    failures.push(`跑正对照那一步时执行器报错:${liveResult.message}`);
  } else {
    if (seenWhileRunning.length === 0) {
      failures.push(
        `正对照不成立:一步正在跑时,宿主 /proc 里找不到命令行含 ${liveNonce} 的进程。` +
          "此时「查不到残留」只说明扫描本身看不见东西,那条判据是空转。",
      );
    }
    if (liveResult.timedOut !== true) {
      failures.push(
        "宿主侧墙钟到点没有杀掉这一步(`timedOut` 不是 true):单步墙钟上限没有生效," +
          "一步写个死循环就能把整场会话的预算吃光。",
      );
    }
    if (processesMentioning(liveNonce).length > 0) {
      failures.push("墙钟杀掉那一步之后,宿主 /proc 里仍能看到它的进程:进程树没有被回收。");
    }
  }

  // 判据本体:`cmd &` 之后这一步必须立即返回,且那个后台进程不许活过这一步。
  const nonce = `mwsandbox-leftover-${String(Date.now())}`;
  const background = await driveExecutor(
    repoRoot,
    request(`${spin(nonce)} & printf started`, 30_000),
  );
  if (!background.ok) {
    failures.push(`跑后台进程那一步时执行器报错:${background.message}`);
  } else {
    if (background.stdout?.trim() !== "started") {
      failures.push(
        `后台进程那一步的 stdout 是 ${JSON.stringify(background.stdout)}(期望 "started"):` +
          "`cmd &` 之后这一步没有正常结束。",
      );
    }
    if ((background.wallClockMs ?? Number.POSITIVE_INFINITY) > IMMEDIATE_RETURN_MS) {
      failures.push(
        `\`cmd &\` 之后这一步用了 ${String(background.wallClockMs)} ms 才返回` +
          `(上限 ${String(IMMEDIATE_RETURN_MS)} ms):harness 在等一个不该等的东西。`,
      );
    }
    // 给内核一点时间收尸,再判残留。
    await sleep(300);
    const leftover = processesMentioning(nonce);
    if (leftover.length > 0) {
      failures.push(
        `这一步结束后,宿主 /proc 里仍有 ${String(leftover.length)} 个进程:` +
          `${leftover.join(" | ")}。\`cmd &\` 活过了这一步——步数上限、配额与「成绩取最后一次 ` +
          "evaluate 的版本」三件事的前提当场失效。",
      );
    }
  }

  return failures.length === 0
    ? {
        line:
          "✓ 后台进程不残留:`cmd &` 之后这一步立即返回,宿主 /proc 里查不到它" +
          "(正对照:一步在跑时宿主看得见它,墙钟到点也确实杀掉了整棵进程树)",
        failures,
      }
    : { line: "✗ 后台进程不残留", failures };
};

/** 判据 4:rootfs 漂移(与 `check:sandbox-rootfs` 同一份判据)。 */
const rootfsOutcome = (): Outcome => {
  const check = checkRootfsTree(repoRoot);
  const vacuous = vacuousReason(check.files, {
    subject: "入库 rootfs 的内容物文件",
    scope: check.dir === "" ? "packages/gen/sandbox-rootfs" : check.dir,
  });
  if (vacuous !== "") {
    return { line: "✗ rootfs 漂移", failures: [vacuous] };
  }
  if (check.findings.length > 0) {
    return {
      line: "✗ rootfs 漂移",
      failures: check.findings.map((finding) => `${finding.where}:${finding.detail}`),
    };
  }
  return { line: `✓ ${rootfsCheckSummary(check, "rootfs 漂移:")}`, failures: [] };
};

/** 把四条结论打成一份报告,并做一次空转检测。 */
const report = (outcomes: readonly Outcome[], note: string): void => {
  // 空转:一条判据都没跑成,或一条都没真正断言(全被前面的失败吞掉)。共享件在 `gate/vacuous.ts`。
  const asserted = outcomes.filter((outcome) => outcome.line.startsWith("✓")).length;
  const vacuous = vacuousReason(asserted, {
    subject: "真正跑通的沙箱判据",
    scope:
      "可用性 / 无网络 / 沙箱里没有宿主工具 / 宿主分派跑通 check / coreutils 真能用 / 后台进程 / rootfs 漂移",
  });

  for (const outcome of outcomes) {
    (outcome.failures.length === 0 ? process.stdout : process.stderr).write(`${outcome.line}\n`);
    for (const failure of outcome.failures) {
      process.stderr.write(`  ✗ ${failure}\n`);
    }
  }
  if (vacuous !== "") {
    process.stderr.write(`✗ ${vacuous}${note}\n`);
  }
  const failed = outcomes.some((outcome) => outcome.failures.length > 0);
  process.stdout.write(
    `check:sandbox:${failed ? "红" : `绿(执行器入口 ${EXECUTOR_ENTRY},七件事全部真跑)`}\n`,
  );
};

process.exitCode = await main();
