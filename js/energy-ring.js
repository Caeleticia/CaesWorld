/**
 * energy-ring.js —— 战斗卡牌右上角的能量环
 *
 * 只负责把 publicUnit 的能量数据画成 SVG / 数字；训练场与同屏共用。
 */
import { energyRingData } from "../engine/energy.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/**
 * 更新一个 .tbt-card-energy 容器。
 * @param {HTMLElement} box
 * @param {object} pub publicUnit
 */
export function updateEnergyRing(box, pub) {
  if (!box) return;
  const enabled = Boolean(pub && pub.energyEnabled && Number(pub.energyMax) > 0);
  if (!enabled) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  const display = pub.energyDisplay || "ring";
  if (display === "hidden") {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.hidden = false;
  box.dataset.display = display;
  const color = pub.energyColor || "#47A982";
  const outlineColor = pub.energyOutlineColor || "#ffffff";
  const rawOutlineWidth = Number(pub.energyOutlineWidth);
  const outlineWidth = Number.isFinite(rawOutlineWidth) ? Math.max(0, Math.min(100, rawOutlineWidth)) : 20;
  // 20 = 向外 2 个 SVG 单位；描边只画在轨道外侧，不再和轨道重叠。
  const outlineExtend = outlineWidth * 0.1;
  const rawBarWidth = Number(pub.energyBarWidth);
  const barWidth = Number.isFinite(rawBarWidth) ? Math.max(1, Math.min(100, rawBarWidth)) : 20;
  // 20 = 现有默认粗细；数值变大时外缘不动，只向内加粗。
  const barStroke = 2.8 * (barWidth / 20);
  const bgColor = pub.energyBgColor || "#000000";
  box.style.setProperty("--energy-color", color);
  box.style.setProperty("--energy-outline-color", outlineColor);
  box.style.setProperty("--energy-bg-color", bgColor);
  box.classList.toggle("has-shadow", pub.energyShadow !== false);

  const data = energyRingData(pub.energy, pub.energyMax, pub.energyPerRing);
  const label = `能量 ${Math.floor(data.energy)}/${data.max}`;
  box.title = label;
  box.setAttribute("aria-label", label);
  box.innerHTML = "";

  if (display === "text") {
    const text = document.createElement("span");
    text.className = "tbt-energy-text";
    text.textContent = `${Math.floor(data.energy)}/${data.max}`;
    box.append(text);
    return;
  }

  const svg = svgEl("svg", {
    class: "tbt-energy-svg",
    viewBox: "0 0 40 40",
    role: "img",
    "aria-label": label,
  });
  const outer = 17;
  const step = 4.2;
  data.rings.forEach((progress, i) => {
    // 每一环的外缘固定；条越粗，中心半径越向内移。
    const outerRadius = Math.max(2, outer - i * step);
    const stroke = Math.min(barStroke, outerRadius * 2);
    const radius = Math.max(0, outerRadius - stroke / 2);
    // 描边只覆盖轨道外侧：内缘贴着轨道外缘。
    if (outlineExtend > 0) {
      const outline = svgEl("circle", {
        class: "tbt-energy-outline",
        cx: 20,
        cy: 20,
        r: outerRadius + outlineExtend / 2,
        fill: "none",
        "stroke-width": outlineExtend,
      });
      svg.append(outline);
    }
    const circle = svgEl("circle", {
      class: "tbt-energy-track",
      cx: 20,
      cy: 20,
      r: radius,
      fill: "none",
      "stroke-width": stroke,
    });
    svg.append(circle);
    if (progress <= 0) return;
    const circumference = 2 * Math.PI * radius;
    const arc = svgEl("circle", {
      class: "tbt-energy-arc",
      cx: 20,
      cy: 20,
      r: radius,
      fill: "none",
      "stroke-width": stroke,
      transform: "rotate(-90 20 20)",
      "stroke-dasharray": `${circumference} ${circumference}`,
      "stroke-dashoffset": `${circumference * (1 - progress)}`,
    });
    svg.append(arc);
  });
  box.append(svg);

  if (display === "ringText" || display === "ringPercent") {
    const text = document.createElement("span");
    text.className = "tbt-energy-text";
    text.textContent =
      display === "ringPercent"
        ? `${Math.round((data.energy / Math.max(1, data.max)) * 100)}%`
        : String(Math.floor(data.energy));
    box.append(text);
  }
}
