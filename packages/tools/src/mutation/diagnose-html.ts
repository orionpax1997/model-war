/**
 * 诊断结果的 HTML 渲染:纯函数,输入诊断结构,输出一个自包含的 HTML 页面。
 *
 * ── 为什么要有 HTML 这一版 ────────────────────────────────────────────────
 *
 * Markdown 那版是给「拿着终端读」的人看的(仓库里的一切都是这样交付的);
 * 但变异诊断的读者常常是**要拍板的人**:这个人刚接受过一次基线下降,
 * 现在要决定下一步是补测试、收窄变异范围,还是修测量口径。
 * 拍板的人要看的是「哪几片最该动、动它们要花什么」,这在终端里读表格很费劲。
 *
 * 所以这里做一版给人看的:
 *   · 一个页面看完,不用在八个桶之间做心算(每片一条堆叠条,颜色即桶);
 *   · 开头三张卡片直接给「先看哪里」(按数据排序,不是编辑观点);
 *   · 每张结论卡把「现象」和「下一步动作」分开排版,不用自己去猜「那所以呢」;
 *   · 零外部依赖(不联网、不引 CDN、不带图片),单文件可以直接发给别人。
 *
 * 它与 Markdown 版**同源**:两份渲染吃的是同一份 `ShardDiagnosis[]`,不存在
 * 「HTML 说的和 Markdown 不一样」的可能。判据仍然只在 `diagnose.ts` 与
 * `structural-attribution.ts` 里;这份 HTML 是观测产物,不是判据。
 */

import type { Bucket, ShardDiagnosis } from "./diagnose.ts";
import type { DiagnosisMeta } from "./diagnose-markdown.ts";

/** 桶 → 人读的名字(与 Markdown 版一致)。 */
const BUCKET_LABEL: Readonly<Record<Bucket, string>> = {
  killed: "真杀",
  timeout: "超时",
  "survived-value": "存活·值",
  "survived-structure": "存活·结构",
  "survived-logic": "存活·逻辑",
  uncovered: "未覆盖·真",
  unobservable: "未覆盖·不可测",
  other: "其它",
};

/** 桶 → 颜色(堆叠条与图例共用)。真杀是绿的,不可测是灰的,存活是红的。 */
const BUCKET_COLOR: Readonly<Record<Bucket, string>> = {
  killed: "#2b8a3e",
  timeout: "#e8590c",
  "survived-value": "#f03e3e",
  "survived-structure": "#c92a2a",
  "survived-logic": "#a61e4d",
  uncovered: "#1971c2",
  unobservable: "#868e96",
  other: "#ced4da",
};

/** 结论标志 → 人读的名字(与 Markdown 版一致)。 */
const FLAG_LABEL: Readonly<Record<string, string>> = {
  "static-doubt": "静态变异体口径存疑",
  "timeout-noise": "超时噪声",
  unobservable: "不可测(测不到)",
  "real-gap": "真缺口(该补测试)",
  "value-survived": "值替换存活",
  "scope-partial": "报告不是全范围跑",
  clean: "无结构性成因",
};

/** 结论标志 → 边框色(红=要动手,黄=要留意,绿=没事,蓝=先去核实)。 */
const FLAG_COLOR: Readonly<Record<string, string>> = {
  "static-doubt": "#c92a2a",
  "timeout-noise": "#e8590c",
  unobservable: "#7048e8",
  "real-gap": "#1971c2",
  "value-survived": "#e8590c",
  "scope-partial": "#1098ad",
  clean: "#2b8a3e",
};

/** HTML 转义:报告里的路径与结论都来自文件,不能直接当 HTML 塞进去。 */
const escape = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const pct = (value: number): string => `${value.toFixed(2)}%`;

/** 头号问题在内部是标志名的串(给机器读的);给人看的版本要翻成中文。 */
const headlineText = (headline: string): string =>
  headline
    .split(" / ")
    .map((kind) => FLAG_LABEL[kind] ?? kind)
    .join("、");

/**
 * 行内的强调与代码:结论文本写的时候带 `**强调**` 与 `` `代码` ``,
 * Markdown 那版由渲染器处理,HTML 这版得自己转——不然页面上会露出星号与反引号。
 * 先转义再替换:顺序反了就会把转义出来的实体再当标记处理。
 */
const inline = (text: string): string =>
  escape(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");

/** 桶里某一类的占比(用于堆叠条的宽度)。分母为 0 时给 0,不产生 NaN。 */
const widthOf = (count: number, total: number): string =>
  total > 0 ? `${((count / total) * 100).toFixed(2)}%` : "0%";

/** 一片的一条堆叠条:每段一个桶,宽度按占该片有效变异体的比例。 */
const stackBar = (diagnosis: ShardDiagnosis): string => {
  const total = diagnosis.valid;
  const segments = (Object.keys(BUCKET_LABEL) as readonly Bucket[])
    .filter((bucket) => diagnosis.buckets[bucket] > 0)
    .map(
      (bucket) =>
        `<span class="seg" style="width:${widthOf(diagnosis.buckets[bucket], total)};` +
        `background:${BUCKET_COLOR[bucket]}" title="${BUCKET_LABEL[bucket]} ` +
        `${diagnosis.buckets[bucket]} 个">` +
        `<span class="sr">${BUCKET_LABEL[bucket]} ${diagnosis.buckets[bucket]} 个</span>` +
        `</span>`,
    )
    .join("");
  return `<div class="stack" role="img" aria-label="变异体构成">${segments}</div>`;
};

/** 图例(只列出这一份报告里真出现过的桶)。 */
const legend = (diagnoses: readonly ShardDiagnosis[]): string => {
  const present = (Object.keys(BUCKET_LABEL) as readonly Bucket[]).filter((bucket) =>
    diagnoses.some((d) => d.buckets[bucket] > 0),
  );
  return (
    `<div class="legend">` +
    present
      .map(
        (bucket) =>
          `<span class="lg"><i style="background:${BUCKET_COLOR[bucket]}"></i>` +
          `${BUCKET_LABEL[bucket]}</span>`,
      )
      .join("") +
    `</div>`
  );
};

/** 分数块:三个分数并排,每个带一条细进度条。 */
const scoreBlock = (diagnosis: ShardDiagnosis): string => {
  const cell = (label: string, value: number, hint: string): string =>
    `<div class="score"><div class="score-v">${pct(value)}</div>` +
    `<div class="score-l">${label}</div>` +
    `<div class="score-h">${hint}</div>` +
    `<div class="meter"><span style="width:${value.toFixed(2)}%"></span></div></div>`;
  return (
    `<div class="scores">` +
    cell("原始分", diagnosis.score, "Stryker 口径,与入库基线可比") +
    cell("去超时分", diagnosis.scoreExcludingTimeout, "把「测试挂死」从分子里拿掉") +
    cell("可信分", diagnosis.credibleScore, "真杀 ÷ (真杀 + 真缺口)") +
    `</div>`
  );
};

/** 一片的一张结论卡:现象与「下一步动作」分开。 */
const flagCard = (kind: string, note: string, action: string, share: number): string =>
  `<div class="flag" style="--edge:${FLAG_COLOR[kind] ?? "#868e96"}">` +
  `<div class="flag-h"><span class="flag-t">${escape(FLAG_LABEL[kind] ?? kind)}</span>` +
  `<span class="flag-s">占 ${pct(share * 100)}</span></div>` +
  `<p class="flag-n">${inline(note)}</p>` +
  `<p class="flag-a"><b>下一步</b>${inline(action)}</p>` +
  `</div>`;

/** 概览表:每片一行 + 可信分的迷你条。 */
const overviewTable = (diagnoses: readonly ShardDiagnosis[]): string => {
  const head =
    "<tr><th>分片</th><th>变异体</th><th>真杀</th><th>超时</th>" +
    "<th>存活</th><th>未覆盖</th><th>原始分</th><th>去超时分</th>" +
    "<th>可信分</th><th>静态存活</th><th>要动的地方</th></tr>";
  const rows = diagnoses
    .map((d) => {
      const b = d.buckets;
      const survived = b["survived-value"] + b["survived-structure"] + b["survived-logic"];
      const uncovered = b.uncovered + b.unobservable;
      return (
        `<tr><td class="shard-name">${escape(d.shard)}</td>` +
        `<td>${d.valid}</td><td class="ok">${b.killed}</td><td class="warn">${b.timeout}</td>` +
        `<td class="bad">${survived}</td><td>${uncovered}</td>` +
        `<td>${pct(d.score)}</td><td>${pct(d.scoreExcludingTimeout)}</td>` +
        `<td><span class="mini"><span style="width:${d.credibleScore.toFixed(2)}%"></span></span>` +
        `${pct(d.credibleScore)}</td>` +
        `<td>${d.staticSurvivors}/${d.staticMutants}</td>` +
        `<td class="act">${escape(headlineText(d.headline))}</td></tr>`
      );
    })
    .join("");
  return `<table class="ov"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
};

/** 一片的文件构成表(可排序)。 */
const fileTable = (diagnosis: ShardDiagnosis, limit: number): string => {
  const head =
    "<tr><th>文件</th><th>变异体</th><th>真杀</th><th>超时</th>" +
    "<th>存活·值</th><th>存活·结构</th><th>存活·逻辑</th>" +
    "<th>未覆盖·真</th><th>未覆盖·不可测</th><th>静态</th></tr>";
  const rows = diagnosis.files
    .slice(0, limit)
    .map((f) => {
      const b = f.buckets;
      return (
        `<tr><td class="path">${escape(f.file)}</td><td>${f.total}</td><td class="ok">${b.killed}</td>` +
        `<td class="warn">${b.timeout}</td><td class="bad">${b["survived-value"]}</td>` +
        `<td class="bad">${b["survived-structure"]}</td><td class="bad">${b["survived-logic"]}</td>` +
        `<td>${b.uncovered}</td><td>${b.unobservable}</td><td>${f.staticMutants}</td></tr>`
      );
    })
    .join("");
  return (
    `<div class="tw"><table class="files sortable"><thead>${head}</thead>` +
    `<tbody>${rows}</tbody></table></div>`
  );
};

/**
 * 开头的三张卡片:「先看哪里」。
 *
 * 三张卡片的取舍都从数据里算,不写编辑观点:
 *   ① 口径存疑片(静态变异体几乎全存活)——它们的高分/低分都不能当质量读;
 *   ② 可信分最低的三片——最可能被当成「测试弱」而其实不是;
 *   ③ 这份报告不做什么(不改基线、不进任何链)——避免读者误以为它是一道门禁。
 */
const tldr = (diagnoses: readonly ShardDiagnosis[]): string => {
  const suspect = diagnoses.filter(
    (d) => d.staticMutants >= 20 && d.staticSurvivors / d.staticMutants >= 0.8,
  );
  const lowest = [...diagnoses].sort((a, b) => a.credibleScore - b.credibleScore).slice(0, 3);
  const card = (title: string, body: string, tone: string): string =>
    `<div class="tcard ${tone}"><h3>${escape(title)}</h3>${body}</div>`;

  const suspectCard = card(
    "静态变异体几乎全存活的那几片",
    suspect.length === 0
      ? "<p>没有出现「静态变异体几乎全存活」的片。</p>"
      : `<p>${suspect
          .map(
            (d) =>
              `<b>${escape(d.shard)}</b> — 静态变异体存活 ${d.staticSurvivors}/${d.staticMutants}` +
              `(${pct((d.staticSurvivors / d.staticMutants) * 100)})`,
          )
          .join("<br>")}</p>` +
          `<p class="dim">入选口径:静态变异体 ≥ 20 个且存活率 ≥ 80%。静态变异体在模块加载期执行,` +
          `若测试环境没有真的重载,变异根本没生效——存活是假的。已实测坐实:schema 片报存活的那只变异,` +
          `手工按同一位置注入后测试当场红。</p>` +
          `<p class="dim"><b>所以:这几片里静态变异体那部分分数,不能当质量证据读。</b></p>`,
    "red",
  );

  const lowestCard = card(
    "最可能被误诊成「测试弱」的三片",
    `<ol class="rank">${lowest
      .map(
        (d) =>
          `<li><b>${escape(d.shard)}</b> — 可信分 ${pct(d.credibleScore)}` +
          `<span class="dim">(${escape(headlineText(d.headline))})</span></li>`,
      )
      .join("")}</ol>` +
      `<p class="dim">可信分 = 真杀 ÷ (真杀 + 真缺口)。它低的片要分清:是「测不到」还是「没钉住」。</p>`,
    "blue",
  );

  const scopeCard = card(
    "这份报告不做什么",
    "<p>它<b>不改基线</b>、<b>不是门禁</b>、不在任何流水线或常跑链上。</p>" +
      '<p class="dim">棘轮只回答「比上次低不低」;这份报告回答「为什么低」,' +
      "两者分开才有意义。抬基线仍然是所有者显式决定的事。</p>" +
      '<p class="dim">复跑:<code>pnpm run mutation:diagnose</code></p>',
    "gray",
  );

  return `<div class="tgrid">${suspectCard}${lowestCard}${scopeCard}</div>`;
};

/** 页面样式。深浅色都跟系统走;打印时压掉装饰。 */
const STYLE = `
:root{
  --bg:#f8f9fa; --panel:#ffffff; --ink:#1a1d21; --dim:#5c6670; --line:#e3e6ea;
  --accent:#1971c2;
}
@media (prefers-color-scheme: dark){
  :root{ --bg:#141618; --panel:#1c1f22; --ink:#e6e8ea; --dim:#9aa4ae; --line:#2c3136; --accent:#74c0fc; }
}
*{box-sizing:border-box}
body{
  margin:0; padding:0 20px 72px; background:var(--bg); color:var(--ink);
  font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB",
       "Microsoft YaHei",Roboto,"Helvetica Neue",sans-serif;
}
.wrap{max-width:1180px;margin:0 auto}
header{padding:36px 0 8px;border-bottom:1px solid var(--line);margin-bottom:28px}
h1{font-size:28px;margin:0 0 8px;letter-spacing:.2px}
h2{font-size:20px;margin:40px 0 12px;padding-bottom:8px;border-bottom:1px solid var(--line)}
h3{font-size:16px;margin:0 0 10px}
p{margin:8px 0}
.lede{font-size:17px;color:var(--ink);max-width:70ch}
.meta{color:var(--dim);font-size:13px}
.dim{color:var(--dim);font-size:13px}
code{background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:1px 5px;
     font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

/* 开头的三张卡 */
.tgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin:8px 0 6px}
.tcard{background:var(--panel);border:1px solid var(--line);border-top:3px solid var(--dim);
       border-radius:10px;padding:14px 16px}
.tcard.red{border-top-color:#c92a2a}
.tcard.blue{border-top-color:#1971c2}
.tcard.gray{border-top-color:#868e96}
.tcard h3{font-size:15px}
.rank{margin:4px 0;padding-left:20px}
.rank li{margin:4px 0}

/* 概览表 */
table{border-collapse:collapse;width:100%;background:var(--panel);border:1px solid var(--line);
      border-radius:10px;overflow:hidden;font-size:14px}
th,td{padding:7px 10px;text-align:right;border-bottom:1px solid var(--line);white-space:nowrap}
th{background:var(--panel);color:var(--dim);font-weight:600;font-size:13px;position:sticky;top:0}
th:first-child,td:first-child{text-align:left}
tbody tr:last-child td{border-bottom:none}
td.ok{color:#2b8a3e} td.warn{color:#e8590c} td.bad{color:#e03131}
.shard-name{font-weight:600}
td.act{text-align:left;white-space:normal;color:var(--dim);min-width:16ch}
.mini{display:inline-block;width:64px;height:7px;background:var(--line);border-radius:4px;
      overflow:hidden;vertical-align:middle;margin-right:6px}
.mini>span{display:block;height:100%;background:var(--accent)}
.files .path{text-align:left;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px}
.files th{cursor:pointer}
.files th:hover{color:var(--accent)}
.tw{overflow-x:auto}

/* 每片 */
.shard{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px 20px;
       margin:16px 0}
.shard h2{margin:0 0 4px;border:none;padding:0;font-size:19px}
.stack{display:flex;height:22px;border-radius:6px;overflow:hidden;margin:12px 0 6px;background:var(--line)}
.stack .seg{height:100%;display:block}
.legend{display:flex;flex-wrap:wrap;gap:12px;margin:4px 0 12px;font-size:12.5px;color:var(--dim)}
.lg i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.scores{display:flex;flex-wrap:wrap;gap:26px;margin:12px 0 4px}
.score{min-width:150px}
.score-v{font-size:22px;font-weight:650;letter-spacing:.3px}
.score-l{font-size:13px;color:var(--dim)}
.score-h{font-size:12px;color:var(--dim);min-height:18px}
.meter{height:6px;background:var(--line);border-radius:4px;overflow:hidden;margin-top:6px;max-width:220px}
.meter>span{display:block;height:100%;background:var(--accent)}
.flags{display:grid;gap:10px;margin:14px 0}
.flag{border:1px solid var(--line);border-left:4px solid var(--edge);border-radius:8px;padding:10px 14px;background:var(--bg)}
.flag-h{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
.flag-t{font-weight:650}
.flag-s{font-size:12px;color:var(--dim)}
.flag-n{margin:4px 0}
.flag-a{margin:4px 0;padding-top:6px;border-top:1px dashed var(--line);font-size:14px}
.flag-a b{display:inline-block;background:var(--edge);color:#fff;border-radius:4px;
          padding:0 6px;font-size:12px;margin-right:8px}
.callout{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--accent);
         border-radius:8px;padding:12px 16px;margin:10px 0}
.callout h3{font-size:14px;color:var(--accent)}
footer{margin-top:48px;padding-top:16px;border-top:1px solid var(--line);color:var(--dim);font-size:13px}
ul.notes{padding-left:20px}
ul.notes li{margin:5px 0}
@media print{
  body{background:#fff;color:#000;padding:0}
  .shard,.tcard,table{break-inside:avoid}
  .files th{position:static}
}
`;

/** 排序脚本:点表头按列排。数字按数字比,其余按字符串比。 */
const SCRIPT = `
(function(){
  var num=/^-?\\d+(\\.\\d+)?%?$/;
  function value(cell){
    var t=cell.textContent.trim();
    if(num.test(t)) return parseFloat(t);
    return t;
  }
  document.querySelectorAll('table.sortable').forEach(function(table){
    var ths=table.querySelectorAll('thead th');
    ths.forEach(function(th,idx){
      th.addEventListener('click',function(){
        var asc=th.dataset.dir!=='asc';
        ths.forEach(function(o){delete o.dataset.dir});
        th.dataset.dir=asc?'asc':'desc';
        var body=table.tBodies[0];
        var rows=Array.prototype.slice.call(body.rows);
        rows.sort(function(a,b){
          var x=value(a.cells[idx]), y=value(b.cells[idx]);
          if(typeof x==='number'&&typeof y==='number') return asc?x-y:y-x;
          return asc?String(x).localeCompare(String(y),'zh'):String(y).localeCompare(String(x),'zh');
        });
        rows.forEach(function(r){body.appendChild(r)});
      });
    });
  });
})();
`;

/** 渲染整份 HTML 报告。 */
export const renderDiagnosisHtml = (
  diagnoses: readonly ShardDiagnosis[],
  meta: DiagnosisMeta,
  fileLimit = 12,
): string => {
  const shardSections = diagnoses
    .map((d) => {
      const time = meta.reportTimes[d.shard] ?? "时间未知";
      const flags = d.flags
        .map((flag) => flagCard(flag.kind, flag.note, flag.action, flag.share))
        .join("");
      const staticNote =
        d.staticMutants > 0
          ? `<p class="dim">静态变异体 ${d.staticMutants} 个,存活 ${d.staticSurvivors} 个` +
            `(静态变异体在模块加载期执行,覆盖归因不可用,存活存疑)。` +
            `实测里静态变异体有时是能被杀的(gen-core 153/247、runner 148/310),` +
            `所以「几乎全存活」不是常态,而是测量失效的信号。</p>`
          : "";
      return (
        `<section class="shard" id="shard-${escape(d.shard)}">` +
        `<h2>${escape(d.shard)}</h2>` +
        `<p class="meta">报告时间:${escape(time)} · 有效变异体 ${d.valid}` +
        `(另 ${d.total - d.valid} 个不进分母)</p>` +
        stackBar(d) +
        scoreBlock(d) +
        staticNote +
        `<div class="flags">${flags}</div>` +
        `<h3>文件构成(前 ${fileLimit} 行,按「真缺口 + 超时 + 不可测」排序;点表头可排序)</h3>` +
        fileTable(d, fileLimit) +
        `</section>`
      );
    })
    .join("");

  const missing =
    meta.missingShards.length > 0
      ? `<div class="callout"><h3>本次没有读到这些分片的报告</h3>` +
        `<p>${escape(meta.missingShards.join("、"))}。缺报告的片不进统计` +
        `(要跑 <code>pnpm run mutate:&lt;分片&gt;</code> 才有)。</p></div>`
      : "";

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>变异分片可解释性诊断</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>变异分片可解释性诊断</h1>
  <p class="lede">这份报告回答一个问题:<b>某片变异分数低,是因为测试弱、因为测不到、还是因为口径不对?</b>
  三种成因对应三种完全不同的下一步,混在一个数字里读不出来,所以这里把它们拆成八桶。</p>
  <p class="meta">生成时刻:${escape(meta.generatedAt)}</p>
</header>

${tldr(diagnoses)}

<h2>分片总览</h2>
<p class="dim">口径:<b>原始分</b> = Stryker 口径(Timeout 计入已检测),与入库基线可比;
<b>去超时分</b> = 把 Timeout 从分子里拿掉;<b>可信分</b> = 真杀 ÷ (真杀 + 真缺口);
<b>静态存活</b> = 静态变异体里存活的 / 总数(判定存疑的那一栏)。
分片之间<b>不可横向比较</b>——跨包覆盖在沙箱里指向仓库外,丢成 NoCoverage/Survived。</p>
${legend(diagnoses)}
${overviewTable(diagnoses)}
${missing}

<h2>机制级归因(影响面不可按文件判定)</h2>
<div class="callout">
  <h3>${escape(meta.mechanism.kind)}</h3>
  <p>${inline(meta.mechanism.reason)}</p>
  <p><b>处置方向</b>${inline(meta.mechanism.remedy)}</p>
</div>

<h2>逐片明细</h2>
${shardSections}

<h2>怎么读这份报告</h2>
<ul class="notes">
  <li><b>存活·逻辑</b>与<b>未覆盖·真</b>是<b>补测试的靶子</b>:行为没有被断言钉住,补测试会真的提高分数。</li>
  <li><b>存活·值</b>多半是等价变异体,或断言只钉「表之间的关系」不钉「表的内容」——两种成因都要人判。</li>
  <li><b>未覆盖·不可测</b>不是测试质量结论:要么把文件移出变异范围,要么换夹具让它可测。把它算进「测试弱」会让低分片被误诊。</li>
  <li><b>超时</b>被 Stryker 计入「已检测」,所以「测试挂死」会伪装成「测试抓得住」;原始分与去超时分之差就是这部分。</li>
  <li><b>分片之间不可横向比较</b>。上面那张表里每片各自成立,不排名。</li>
</ul>

<footer>
  <p>产物,不是判据:重跑即刷新,不入库。判据在 <code>packages/tools/src/mutation/diagnose.ts</code>
  与 <code>structural-attribution.ts</code>。Markdown 版:<code>reports/mutation/diagnosis.md</code>。</p>
</footer>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`;
};
