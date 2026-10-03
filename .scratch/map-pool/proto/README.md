# PROTOTYPE（throwaway，勿在实现期引用代码）

三张 64×64 墙图的原型。跑法：

```bash
node .scratch/map-pool/proto/report.mjs      # 全部度量（结论在 findings.md）
node .scratch/map-pool/proto/render.mjs      # 生成 maps.html（双击打开）
node .scratch/map-pool/proto/dump-terrain.mjs # 落 terrain-*.txt（64 行 '.'/'#'）
node .scratch/map-pool/proto/author-check.mjs # 作者面回显 + 卫生告警
```

- `quad.mjs`：**墙形的权威定义**（三张图的象限形状表 + 4 重旋转展开器）。
- `metrics.mjs`：BFS 路径拉伸、首触/枯竭估算、Jaccard、候选轨道体检。
- `findings.md`：**结论**（Q1/Q2/Q3 + 两条顺带发现）。
- `maps.html`：可双击的渲染（三图并排 / 中心放大 / 绕路热力 / variant 种子）。
  URL 参数：`?zoom=1&heat=1&sites=0&seed=23`。
- `corridor-try.mjs`：廊道图门宽/门位的一次性对比试验（留档说明为什么是 5 格）。
- `shot-*.png`：我自己看图时截的屏。
