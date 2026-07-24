import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const outputRoot = path.resolve(scriptDir, "..", "html");
const toPosix = (value) => value.split(path.sep).join("/");

async function walk(root) {
  const files = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(absolutePath)));
    else files.push(absolutePath);
  }
  return files;
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const files = await walk(outputRoot);
const htmlFiles = files.filter((file) => file.endsWith(".html"));
const existing = new Set(files.map((file) => path.normalize(file).toLowerCase()));
const htmlCache = new Map();
const errors = [];
let checkedLinks = 0;

for (const htmlFile of htmlFiles) {
  const html = await fs.readFile(htmlFile, "utf8");
  htmlCache.set(path.normalize(htmlFile).toLowerCase(), html);
  const attributePattern = /\b(?:href|src)="([^"]+)"/g;
  for (const match of html.matchAll(attributePattern)) {
    const rawValue = match[1].replaceAll("&amp;", "&");
    if (
      !rawValue ||
      /^(?:https?:|mailto:|tel:|data:|javascript:)/i.test(rawValue)
    ) {
      continue;
    }
    checkedLinks += 1;
    const hashIndex = rawValue.indexOf("#");
    const pathname = decode(
      hashIndex < 0 ? rawValue : rawValue.slice(0, hashIndex),
    );
    const fragment = decode(
      hashIndex < 0 ? "" : rawValue.slice(hashIndex + 1),
    );
    const target = pathname
      ? path.resolve(path.dirname(htmlFile), pathname)
      : htmlFile;
    const targetKey = path.normalize(target).toLowerCase();
    if (!existing.has(targetKey)) {
      errors.push(
        `${toPosix(path.relative(outputRoot, htmlFile))}: ${rawValue} -> 文件不存在`,
      );
      continue;
    }
    if (fragment && target.endsWith(".html")) {
      const targetHtml =
        htmlCache.get(targetKey) ?? (await fs.readFile(target, "utf8"));
      const escapedFragment = fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const idPattern = new RegExp(`\\bid="${escapedFragment.replaceAll('"', "&quot;")}"`);
      if (!idPattern.test(targetHtml)) {
        errors.push(
          `${toPosix(path.relative(outputRoot, htmlFile))}: ${rawValue} -> 锚点不存在`,
        );
      }
    }
  }
}

if (errors.length) {
  console.error(`站点检查失败，共 ${errors.length} 个问题：`);
  errors.slice(0, 100).forEach((error) => console.error(`- ${error}`));
  if (errors.length > 100) console.error(`- 其余 ${errors.length - 100} 个问题已省略`);
  process.exitCode = 1;
} else {
  console.log(
    `站点检查通过：${htmlFiles.length} 个 HTML 页面，${checkedLinks} 个本地链接/资源引用均有效。`,
  );
}
