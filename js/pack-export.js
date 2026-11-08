/**
 * pack-export.js —— 把「卡包文件」打成模组 ZIP（编辑器导出 / 旧 JSON 模组导出共用）
 *
 *   <id>.zip
 *   └── <id>/
 *       ├── <id>.json
 *       ├── README.md
 *       ├── images/<单位 id 最后一个字段>.<png|jpg|…>
 *       └── icons/
 *           ├── skill/<技能 id 最后一个字段>.<png|jpg|…>
 *           └── effect/<效果 id 最后一个字段>.<png|jpg|…>
 *
 * 图片 / 图标来源由调用方给一个 resolveImage(card)（一般是 engine 的 resolveCardImage）：
 * data URL、blob URL、assets/ 相对路径都能被 fetch 到，取到字节后放进包里。
 */
import { buildModZip, imageMime } from "./mod-zip.js";
import { PLACEHOLDER_IMAGE } from "../engine/index.js";

const EXT_BY_MIME = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
};
const EXT_SET = new Set(Object.values(EXT_BY_MIME));
const errText = (err) => String((err && err.message) || err);

/** 单位 id 的最后一个字段（modname_unit_unit1 → unit1） */
export function lastFieldOfId(id) {
  if (typeof id !== "string") return "";
  const parts = id.split("_").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

/** 图片扩展名：优先 blob 的 MIME，其次 URL 后缀，兜底 png */
export function extForImage(mime = "", url = "") {
  const byMime = EXT_BY_MIME[String(mime || "").toLowerCase()];
  if (byMime) return byMime;
  const path = String(url || "").split(/[?#]/)[0];
  const m = path.match(/\.([a-z0-9]+)$/i);
  const ext = m ? m[1].toLowerCase() : "";
  return EXT_SET.has(ext) ? ext : "png";
}

function bytesToBase64(bytes) {
  if (typeof btoa !== "function") throw new Error("当前环境不支持 base64 编码");
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** 图片字节 → data URL（导入 ZIP 到编辑器时把卡面内嵌进工程） */
export function bytesToDataUrl(bytes, mime = "application/octet-stream") {
  return `data:${mime || "application/octet-stream"};base64,${bytesToBase64(bytes)}`;
}

/** 生成 README.md 的默认内容 */
export function buildPackReadme(file, images = [], icons = []) {
  const data = file && typeof file === "object" ? file : {};
  const id = String(data.id || "");
  const name = String(data.name || id || "模组");
  const lines = [`# ${name}`, "", `- 模组 id：\`${id}\``];
  if (data.version !== undefined && data.version !== null && data.version !== "") {
    lines.push(`- 版本：${data.version}`);
  }
  if (data.author) lines.push(`- 作者：${data.author}`);
  const units = Array.isArray(data.units) ? data.units : [];
  const skills = Array.isArray(data.skills) ? data.skills : [];
  const effects = Array.isArray(data.effects) ? data.effects : [];
  lines.push(`- 内容：单位 ${units.length} · 技能 ${skills.length} · 效果 ${effects.length}`);
  const desc = String(data.description || "").trim();
  if (desc) lines.push("", desc);

  const art = new Map((images || []).map((name) => [String(name).replace(/\.[^.]+$/, "").toLowerCase(), name]));
  const iconMap = (kind) =>
    new Map(
      (icons || [])
        .filter((item) => item && item.kind === kind && item.name)
        .map((item) => [String(item.name).replace(/\.[^.]+$/, "").toLowerCase(), item.name])
    );
  const skillIcons = iconMap("skill");
  const effectIcons = iconMap("effect");

  if (units.length) {
    lines.push("", "## 单位与卡面", "");
    for (const unit of units) {
      if (!unit || !unit.id) continue;
      const file2 = art.get(lastFieldOfId(unit.id).toLowerCase());
      lines.push(`- \`${unit.id}\` · ${unit.name || ""} → ${file2 ? `images/${file2}` : "（暂无卡面）"}`);
    }
  }
  if (skills.length) {
    lines.push("", "## 技能与图标", "");
    for (const skill of skills) {
      if (!skill || !skill.id) continue;
      const file2 = skillIcons.get(lastFieldOfId(skill.id).toLowerCase());
      lines.push(`- \`${skill.id}\` · ${skill.name || ""} → ${file2 ? `icons/skill/${file2}` : "（暂无图标）"}`);
    }
  }
  if (effects.length) {
    lines.push("", "## 效果与图标", "");
    for (const effect of effects) {
      if (!effect || !effect.id) continue;
      const file2 = effectIcons.get(lastFieldOfId(effect.id).toLowerCase());
      lines.push(`- \`${effect.id}\` · ${effect.name || ""} → ${file2 ? `icons/effect/${file2}` : "（暂无图标）"}`);
    }
  }

  lines.push(
    "",
    "## 卡面规则",
    "",
    "单位卡面放在 `images/`，文件名取单位 id 的最后一个字段，扩展名不限（png / jpg / webp…）。",
    "例如 `study_unit_littleempire` 对应 `images/littleempire.jpg`。"
  );
  lines.push(
    "",
    "## 图标规则",
    "",
    "技能图标放在 `icons/skill/`，效果图标放在 `icons/effect/`；文件名取 id 的最后一个字段，扩展名不限。",
    "例如 `study_skill_choco` 对应 `icons/skill/choco.png`，`study_effect_math` 对应 `icons/effect/math.png`。",
    ""
  );
  return lines.join("\n");
}

/**
 * 把一个卡包文件打成模组 ZIP。
 * @param {object} file packFileOf() 的形状（kind: "caeworld-pack"）
 * @param {{
 *   packId?: string,
 *   readme?: string,
 *   resolveImage?: (card: object) => string
 * }} [options] resolveImage 同时用于单位卡面、技能图标、效果图标
 * @returns {Promise<{bytes: Uint8Array, name: string, images: string[], icons: Array<{kind: string, name: string}>, warnings: string[]}>}
 */
export async function makePackZip(file, { packId = "", readme = "", resolveImage = null } = {}) {
  const data = file && typeof file === "object" ? file : {};
  const id = String(packId || data.id || "mod");
  const warnings = [];
  const images = [];
  const icons = [];
  const seen = { unit: new Set(), skill: new Set(), effect: new Set() };
  // 导出后的 JSON 里不再保留 data URL 图片（图片已经在 images/ / icons/ 里），避免包体积翻倍
  const packFile = JSON.parse(JSON.stringify(data));
  const units = Array.isArray(packFile.units) ? packFile.units : [];
  const skills = Array.isArray(packFile.skills) ? packFile.skills : [];
  const effects = Array.isArray(packFile.effects) ? packFile.effects : [];

  const resolveUrl = (card) => {
    try {
      return String((resolveImage ? resolveImage(card) : "") || "");
    } catch {
      return "";
    }
  };
  const isPlaceholder = (url) =>
    !url || url === PLACEHOLDER_IMAGE || url.startsWith("data:image/svg+xml;charset=utf-8,%3Csvg");

  for (const unit of units) {
    if (!unit || typeof unit !== "object" || !unit.id) continue;
    if (unit.image === null) continue; // 显式占位图
    const key = lastFieldOfId(unit.id);
    if (!key) continue;
    if (seen.unit.has(key)) {
      warnings.push(`单位卡面重名，已跳过：${unit.id} → ${key}`);
      continue;
    }
    const url = resolveUrl(unit);
    if (isPlaceholder(url)) continue;

    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (!bytes.length) throw new Error("卡面文件为空");
      images.push({ name: `${key}.${extForImage(blob.type, url)}`, data: bytes });
      // 卡面落地成 images/<key>.* 后，JSON 里用「默认短 id」即可
      unit.image = "";
      seen.unit.add(key);
    } catch (err) {
      // 默认路径找不到图很常见（占位图由界面兜底），只在显式指定图片时提示
      const explicit = typeof unit.image === "string" && unit.image.trim();
      if (explicit || url.startsWith("blob:") || url.startsWith("data:")) {
        warnings.push(`${unit.id}: 卡面读取失败（${errText(err)}）`);
      }
    }
  }

  const collectIcons = async (cards, kind, folder) => {
    for (const card of cards) {
      if (!card || typeof card !== "object" || !card.id) continue;
      if (card.image === null) continue;
      const key = lastFieldOfId(card.id);
      if (!key) continue;
      if (seen[kind].has(key)) {
        warnings.push(`${kind === "skill" ? "技能" : "效果"}图标重名，已跳过：${card.id} → ${key}`);
        continue;
      }
      const url = resolveUrl(card);
      if (isPlaceholder(url)) continue;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (!bytes.length) throw new Error("图标文件为空");
        icons.push({ kind, name: `${key}.${extForImage(blob.type, url)}`, data: bytes });
        card.image = "";
        seen[kind].add(key);
      } catch (err) {
        const explicit = typeof card.image === "string" && card.image.trim();
        if (explicit || url.startsWith("blob:") || url.startsWith("data:")) {
          warnings.push(`${card.id}: ${folder} 读取失败（${errText(err)}）`);
        }
      }
    }
  };
  await collectIcons(skills, "skill", "技能图标");
  await collectIcons(effects, "effect", "效果图标");

  const text = String(readme || "").trim()
    ? readme
    : buildPackReadme(
        packFile,
        images.map((i) => i.name),
        icons.map((i) => ({ kind: i.kind, name: i.name }))
      );
  const bytes = buildModZip({ rootDir: id, json: packFile, readme: text, images, icons });
  return {
    bytes,
    name: `${id}.zip`,
    images: images.map((i) => i.name),
    icons: icons.map((i) => ({ kind: i.kind, name: i.name })),
    warnings,
  };
}

/**
 * 导入 ZIP 时把包内图片内嵌成 data URL（写进卡片的 image 字段，随工程一起保存）。
 * @param {{images?: Array, icons?: Record<string, Array>}} pack
 * @param {Map<string, Uint8Array>} entries
 * @param {Array<object>} cards
 * @param {"unit"|"skill"|"effect"} kind
 * @returns {{matched: number, images: number}}
 */
export function applyPackImagesToCards(pack, entries, cards, kind = "unit") {
  const list =
    kind === "unit"
      ? (pack && pack.images) || []
      : (pack && pack.icons && pack.icons[kind]) || [];
  const art = new Map();
  for (const img of list) {
    const bytes = entries && entries.get && entries.get(img.path);
    if (!bytes || !bytes.length) continue;
    art.set(img.key, bytesToDataUrl(bytes, imageMime(img.path)));
  }
  let matched = 0;
  for (const card of Array.isArray(cards) ? cards : []) {
    if (!card || typeof card !== "object" || !card.id) continue;
    const key = lastFieldOfId(card.id).toLowerCase();
    const data = key ? art.get(key) : "";
    if (data) {
      card.image = data;
      matched += 1;
    }
  }
  return { matched, images: art.size };
}

/** 兼容旧调用：只处理单位卡面 */
export function applyPackImagesToUnits(pack, entries, units) {
  return applyPackImagesToCards(pack, entries, units, "unit");
}
