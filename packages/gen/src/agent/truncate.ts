/**
 * 观测截断:三条键级上限,截断发生在**生成侧**(ADR-0032「每步的字节由三条键级上限管」)。
 *
 * ── 为什么这里截断,而不是在写档案时截 ──
 *
 * 线性历史每步重发,所以某一步的输出会被后续每一步重复付费。上限因此是**上下文决策**:
 * 模型看到的字节必须就是落盘的字节(ADR-0031),否则「档案里记的是模型当时看到的」当场作废,
 * 而且省下来的上下文是假的——那段字节上一轮已经是响应 token,已经付过费了。
 *
 * ── 三条键各一个上限,不共享 ──
 *
 * | 键 | 上限 | 保留 | 理由 |
 * |---|---|---|---|
 * | `stdout` | 16 KiB | 头 30% / 尾 70% | 诊断尾部常有汇总 |
 * | `stderr` | 4 KiB | 头 70% / 尾 30% | 类型检查的第一条错误在全量诊断的开头 |
 * | `raw`(模型原文) | **不截断**(仅 64 KiB 病态保护) | — | 上一轮已是响应 token,回传不增加新信息成本 |
 *
 * 一个合计上限会让 stderr 短的步骤被允许更长的 stdout——模型无法预测自己的预算。
 *
 * ── 超限时给的是处方,不是一行标记 ──
 *
 * 只告诉模型「你被截了」等于白截:它下一步的动作通常就是重跑同一条命令换个输出。告警里必须
 * 有 `head` / `tail` / `sed -n` / `grep` / 重定向到文件这几条**可执行**的方向,以及被省略的
 * 字节数——那是它唯一能学会「怎么在 16 KiB 上限下工作」的地方。这段文案的存在性进 harness
 * 身份清单(`agent/identity.ts`),删掉它等于换了一个 harness。
 *
 * ── 截断按字节,不按字符 ──
 *
 * 上限的口径是字节(它同时是上下文与磁盘的账)。切点落在多字节字符中间时往回退到完整序列:
 * 交出一个半个汉字既不是原字节,也不是一个可读的输出。
 */

/** 两条有上限的观测键。`raw` 不在此列:它只有病态保护。 */
export type ObservationKey = "stdout" | "stderr";

/** 一条键的上限与保留比例(头部占 `headParts / parts`,尾部拿剩下的)。 */
export type ObservationLimit = {
  readonly limitBytes: number;
  readonly headParts: number;
  readonly parts: number;
};

/**
 * 两条键的上限。**数字的真源就是这里**:身份清单(`agent/identity.ts`)从这里取,不另抄一份。
 */
export const OBSERVATION_LIMITS: Readonly<Record<ObservationKey, ObservationLimit>> = {
  stdout: { limitBytes: 16 * 1024, headParts: 3, parts: 10 },
  stderr: { limitBytes: 4 * 1024, headParts: 7, parts: 10 },
};

/**
 * 模型原文的病态保护上限。
 *
 * 它不是「原文的上限」:ADR-0032 已裁原文不截断,理由是截它的收益本来就是假的。这里只兜住
 * 病态输出(`cat` 一个巨大文件再原样贴回来),否则一条消息就能把宿主内存与档案一起打穿。
 */
export const RAW_PATHOLOGICAL_LIMIT_BYTES = 64 * 1024;

/**
 * 响应被输出上限截断、重试一枪之后仍然截断时回给模型的格式反馈(ADR-0032)。
 *
 * 与解析被拒同一个退出码:两者都是「这一步没有可执行的动作」,而不是命令失败。
 */
export const TRUNCATED_RESPONSE_FEEDBACK = [
  "你的这次回复在输出上限处被截断,所以没有动作被执行(连续两次都截断)。",
  "",
  "协议:每一轮回复里**恰好一个** `bash` 代码块,它就是这一步的全部动作。",
  "回复越长越容易被上限切断,所以下一步请更简洁:只给一个动作块,解释压到最短。",
  "如果需要读很多东西,把读取拆到后面几步去做,不要在一次回复里贴出来。",
  "",
  "这一步已经计入步数。",
].join("\n");

/** 一个 UTF-8 序列的完整长度;首字节不合法时按 1(交给解码器做替换,不在这里猜)。 */
const sequenceLength = (lead: number): number => {
  if (lead < 0x80) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((lead & 0xf8) === 0xf0) return 4;
  return 1;
};

/** 去掉尾部可能不完整的序列:末尾的续字节数与首字节声明的长度对不上就整段不要。 */
const trimIncompleteTail = (bytes: Buffer): Buffer => {
  let index = bytes.length - 1;
  let continuations = 0;
  while (index >= 0 && (bytes[index]! & 0xc0) === 0x80) {
    index -= 1;
    continuations += 1;
  }
  if (index < 0) {
    return bytes;
  }
  return continuations + 1 >= sequenceLength(bytes[index]!) ? bytes : bytes.subarray(0, index);
};

/** 去掉头部可能不完整的序列:开头的续字节没有首字节,整段不要。 */
const trimIncompleteHead = (bytes: Buffer): Buffer => {
  let index = 0;
  while (index < bytes.length && (bytes[index]! & 0xc0) === 0x80) {
    index += 1;
  }
  return bytes.subarray(index);
};

/**
 * 告警块:被省略的字节数 + 可执行的方向。
 *
 * 位置放在「保留的开头」与「保留的结尾」之间,因为它描述的是中间那段被丢掉的东西;而没有
 * 任何尾段被保留时,它照样读得通(数字会说出来被丢的到底是哪一头)。
 */
const truncationBanner = (
  key: ObservationKey,
  limit: ObservationLimit,
  totalBytes: number,
  keptHead: number,
  keptTail: number,
  omitted: number,
): string =>
  [
    `[观测被截断] ${key} 共 ${String(totalBytes)} 字节,本步上限 ${String(limit.limitBytes)} 字节:` +
      `保留开头 ${String(keptHead)} 字节与结尾 ${String(keptTail)} 字节,其余 ${String(omitted)} 字节被省略。`,
    "上面的内容就是这一步能看到的全部;重跑同一条命令不会换出更多字节。",
    "下一步可以定向读,不要整读:",
    "- `head -c 4096 <文件>` / `tail -c 4096 <文件>`:只看开头或结尾的字节;",
    "- `sed -n '120,180p' <文件>`:只看指定行段;",
    "- `grep -n '<模式>' <文件>`:把范围收窄到命中行;",
    "- 或者把输出重定向到 `/workspace/out.txt`,再用上面三条按需读。",
  ].join("\n");

/**
 * 按一条上限截断文本。**纯函数**:同一输入同一上限产出同一份字节。
 *
 * 恰好等于上限时不截断(上限是「允许到这么多」,不是「必须小于」);超出一个字节就按比例
 * 保留头尾,并把两端之间的一切换成告警。
 */
export const truncateText = (
  text: string,
  key: ObservationKey,
  limit: ObservationLimit,
): string => {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= limit.limitBytes) {
    return text;
  }
  const headBytes = Math.floor((limit.limitBytes * limit.headParts) / limit.parts);
  const tailBytes = limit.limitBytes - headBytes;
  const head = trimIncompleteTail(bytes.subarray(0, headBytes));
  const tail = trimIncompleteHead(bytes.subarray(bytes.byteLength - tailBytes));
  const omitted = bytes.byteLength - head.byteLength - tail.byteLength;
  const banner = truncationBanner(
    key,
    limit,
    bytes.byteLength,
    head.byteLength,
    tail.byteLength,
    omitted,
  );
  const parts = [head.toString("utf8"), banner, tail.toString("utf8")];
  return parts.filter((part) => part !== "").join("\n");
};

/** 按键截断一条观测。`key` 决定用哪条上限,也决定告警里点名的是哪一路输出。 */
export const truncateObservation = (key: ObservationKey, text: string): string =>
  truncateText(text, key, OBSERVATION_LIMITS[key]);

/**
 * 模型原文的病态保护:64 KiB 以内逐字节原样,超出才截。
 *
 * 与观测截断的区别要写清:它**不是**一条上限,只在病态输入上生效;生效时在末尾补一句说明,
 * 因为那一段原文已经不再等于模型写的东西,读者需要知道这一点。
 */
export const clampRaw = (text: string): string => {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= RAW_PATHOLOGICAL_LIMIT_BYTES) {
    return text;
  }
  const head = trimIncompleteTail(bytes.subarray(0, RAW_PATHOLOGICAL_LIMIT_BYTES));
  return `${head.toString("utf8")}\n[模型原文超过 ${String(RAW_PATHOLOGICAL_LIMIT_BYTES)} 字节的病态保护上限,其余 ${String(bytes.byteLength - head.byteLength)} 字节被省略]`;
};
