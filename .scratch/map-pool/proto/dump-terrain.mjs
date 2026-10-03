// PROTOTYPE (throwaway) —— 把三张图的 terrain 落成 64 行 '.'/'#' 纯文本（可直接抄进 map JSON 的 terrain 字段）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STYLES, buildStyled } from './quad.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
for (const style of STYLES) {
  const { grid } = buildStyled(style.key);
  const text = [
    `# ${style.label}（${style.key}）· 64×64 · 墙 ${grid.flat().filter((c) => c === '#').length} 格`,
    `# ${style.intent}`,
    `# 四重旋转对称由构造保证（象限形状 + 4 次 rot(x,y)=(63-y,x)）。'.'=平原 '#'=墙。`,
    ...grid.map((row) => row.join('')),
    '',
  ].join('\n');
  const file = path.join(HERE, `terrain-${style.key}.txt`);
  fs.writeFileSync(file, text);
  console.log('写出 ' + file);
}
