/**
 * flow-catalog.js —— 积木块总览（编辑器与解释器共用的一份定义）
 *
 * 每个积木：
 *   kind        积木类型 id（存档里节点的 type）
 *   group       所属大类（trigger/action/structure/logic/data/variable）
 *   title       显示名
 *   subtitle    副标题（补充说明）
 *   color       上方附着色（由大类颜色派生）
 *   ports       端口定义：direction = in/out，type = 数据类型（数据端口必须带 type）
 *   options     可选设置（下拉/勾选/文本框）
 *   inflow      输入流端点名（执行流从哪个端口进来，默认 "in"）
 *   outflows    输出流端点（真分支/假分支、循环体/结束）
 *   note        说明
 *
 * 执行流（上一个积木 → 下一个积木）只连「无类型的流端口」，在画布上显示在积木上方；
 * 数据连接（带类型的端口）在积木两侧。
 * 端口名（id）会被积木流程存档引用，不要随意改名。
 */

/** 数据类型 */
export const DATA_TYPES = Object.freeze(["targetset", "target", "number", "string", "condition", "any"]);

export const DATA_TYPE_LABEL = Object.freeze({
  targetset: "目标集",
  target: "目标",
  number: "数字",
  string: "字符串",
  condition: "条件",
  any: "任意",
});

/** 变量类型（声明变量时选；布尔在流程里就是 condition 数据类型） */
export const VARIABLE_TYPES = Object.freeze([
  { value: "number", label: "数字" },
  { value: "string", label: "字符串" },
  { value: "boolean", label: "布尔" },
  { value: "unit", label: "单位" },
  { value: "targetset", label: "目标集" },
]);

/** 变量类型 → 「声明变量」值输入端口的数据类型 */
export function variablePortType(type) {
  if (type === "string") return "string";
  if (type === "boolean") return "condition";
  if (type === "unit") return "target";
  if (type === "targetset") return "targetset";
  return "number";
}

/** 大类：颜色 = 积木上方的附着色，也决定端口配色 */
export const BLOCK_GROUPS = Object.freeze({
  trigger: { label: "触发类", color: "#E4574C" },
  action: { label: "执行类", color: "#F08A2C" },
  structure: { label: "结构类", color: "#E6B422" },
  logic: { label: "条件类", color: "#3FA45B" },
  "data-op": { label: "运算", color: "#5FB0E6" },
  "data-unit": { label: "单位", color: "#4A9FD8" },
  "data-set": { label: "目标集", color: "#78C8F0" },
  variable: { label: "变量类", color: "#9B59B6" },
});

/**
 * 可以接「单位集」并**按集合里的单位分别独立触发**的事件。
 *
 * 语义：
 *   · 触发积木接了「单位集」→ 集合里每个满足条件的单位各跑一次流程，
 *     流程里的「自己」= 这个单位，「触发的单位」仍然是事件涉及的单位；
 *   · 没接「单位集」→ 和旧版一样，只按「自己」判定一次。
 *
 * 不在这里的事件保持旧语义（单位集只作为条件求值的范围）。
 */
export const MULTI_TARGET_TRIGGER_EVENTS = Object.freeze([
  "unitTurnStart",
  "unitTurnEnd",
  "skillCast",
  "skillResolved",
  "attack",
  "allyAttack",
  "attacked",
  "lethalDamage",
  "unitEnter",
  "unitExit",
  "heal",
  "loseHp",
  "hpChanged",
]);

export function isMultiTargetTriggerEvent(event) {
  return MULTI_TARGET_TRIGGER_EVENTS.includes(String(event || ""));
}

const TRIGGER_EVENTS = Object.freeze([
  { value: "turnStart", label: "回合开始时" },
  { value: "turnEnd", label: "回合结束时" },
  { value: "unitTurnStart", label: "单位行动开始时", multi: true },
  { value: "unitTurnEnd", label: "单位行动结束时", multi: true },
  { value: "skillCast", label: "单位释放技能", multi: true },
  { value: "skillCastSelf", label: "单位释放该技能（仅本技能自身）" },
  { value: "skillResolved", label: "单位技能结算后", multi: true },
  { value: "attack", label: "单位攻击时", multi: true },
  { value: "allyAttack", label: "我方单位攻击时", multi: true },
  { value: "attacked", label: "单位受击时", multi: true },
  { value: "lethalDamage", label: "单位受致命伤害时", multi: true },
  { value: "unitEnter", label: "单位入场时", multi: true },
  { value: "unitExit", label: "单位退场时", multi: true },
  { value: "heal", label: "单位回复生命时", multi: true },
  { value: "loseHp", label: "单位损失生命时", multi: true },
  { value: "hpChanged", label: "单位生命变动时（回复 / 损失都算）", multi: true },
  { value: "always", label: "始终（每次数据更新都触发一次）" },
  { value: "broadcast", label: "接收到广播" },
]);

const COMPARE_OPERATORS = Object.freeze([
  { value: "==", label: "= 等于" },
  { value: "!=", label: "≠ 不等于" },
  { value: ">", label: "> 大于" },
  { value: ">=", label: "≥ 大于等于" },
  { value: "<", label: "< 小于" },
  { value: "<=", label: "≤ 小于等于" },
]);

const MATH_OPERATORS = Object.freeze([
  { value: "add", label: "a + b" },
  { value: "sub", label: "a - b" },
  { value: "mul", label: "a × b" },
  { value: "div", label: "a ÷ b" },
  { value: "mod", label: "a mod b（取余）" },
  { value: "pos", label: "a^b（幂）" },
  { value: "log", label: "log_a(b) 对数" },
  { value: "perm", label: "P(a,b) 排列" },
  { value: "comb", label: "C(a,b) 组合" },
  { value: "max", label: "最大值（无限输入）" },
  { value: "min", label: "最小值（无限输入）" },
  { value: "round", label: "四舍五入(a)" },
  { value: "abs", label: "绝对值(a)" },
  { value: "ceil", label: "向上取整(a)" },
  { value: "floor", label: "向下取整(a)" },
]);

/** 运算积木的固定输入数（max/min 是无限输入，始终「已连接数 + 1」） */
export const MATH_FIXED_INPUTS = Object.freeze({
  add: ["a", "b"],
  sub: ["a", "b"],
  mul: ["a", "b"],
  div: ["a", "b"],
  mod: ["a", "b"],
  pos: ["a", "b"],
  log: ["a", "b"],
  perm: ["a", "b"],
  comb: ["a", "b"],
  round: ["a"],
  abs: ["a"],
  ceil: ["a"],
  floor: ["a"],
  max: [],
  min: [],
});

const UNIT_DATA_FIELDS = Object.freeze([
  { value: "atk", label: "攻击力", type: "number" },
  { value: "def", label: "防御力", type: "number" },
  { value: "hp", label: "生命值", type: "number" },
  { value: "hpMax", label: "生命值上限", type: "number" },
  { value: "lastAttackDamage", label: "上一次攻击的伤害", type: "number" },
  { value: "lastAttackHits", label: "上一次攻击命中的目标数", type: "number" },
  { value: "lastHeal", label: "上一次回复的生命值", type: "number" },
  { value: "lastHealSource", label: "上一次回复的来源", type: "target" },
  { value: "lastLose", label: "上一次损失的生命值", type: "number" },
  { value: "lastHpChange", label: "上一次变动的生命值（回复为正）", type: "number" },
  { value: "lastHitDamage", label: "上一次受到的伤害（未截断）", type: "number" },
  { value: "lastAttackTarget", label: "上一次攻击的目标", type: "target" },
  { value: "lastHitSource", label: "上一次受击的来源目标", type: "target" },
  { value: "effectStacks", label: "目标指定效果的层数", type: "number" },
  { value: "children", label: "子单位数量", type: "number" },
  { value: "faction", label: "阵营", type: "string" },
  { value: "label", label: "标签", type: "string" },
  { value: "name", label: "名字", type: "string" },
  { value: "id", label: "id（卡牌 id）", type: "string" },
  { value: "uid", label: "uid（战斗内唯一）", type: "string" },
]);

const SIDE_OPTIONS = Object.freeze([
  { value: "enemy", label: "敌方全体" },
  { value: "ally", label: "我方全体" },
]);

const BASE_SIDES = Object.freeze(["ally", "enemy"]);

/**
 * 构建积木表。参数用于「无限输入数」这类与具体流程相关的规则。
 * @param {{extraInputs?: Record<string, number>}} [ctx] extraInputs: nodeId → 已连接输入数（max/min 用）
 */
export function buildFlowCatalog(ctx = {}) {
  const extra = ctx.extraInputs || {};
  const blocks = {};

  const def = (spec) => {
    // 端口：方向、是否带类型
    const ports = (spec.ports || []).map((p) => ({
      id: p.id,
      label: p.label || "",
      direction: p.direction,
      type: p.type || null,
      // 只在特定触发事件下显示的端口（例如「接收到广播」的两个输出）
      ...(p.triggerOnly ? { triggerOnly: p.triggerOnly } : {}),
    }));
    blocks[spec.kind] = {
      note: "",
      options: [],
      inflow: spec.ports && spec.ports.some((p) => p.direction === "in") ? "in" : null,
      outflows: [],
      fixedInputs: null,
      ...spec,
      color: BLOCK_GROUPS[spec.group].color,
      ports,
    };
  };

  /* ---------------- 1 触发类 ---------------- */
  def({
    kind: "trigger",
    group: "trigger",
    title: "触发",
    subtitle: "满足条件时触发（可接单位集按单位分别触发）",
    note: "流程入口。技能流程可以放多个触发，每个触发执行它后面的内容；效果的每个触发是一条独立流程。\n\n「单位集」的语义由「单位集触发方式」决定：\n· each（新，默认）：只对 12 种可多目标事件生效——集合里**每个**满足条件的单位各独立跑一次，流程里的「自己」= 这个单位，「触发的单位」仍是事件对象；没接单位集 = 只看自己。\n· any（旧）：集合只作为条件求值范围（任意一个满足就继续一次，集合为空则不继续），流程里的「自己」仍按 unitScope 取。\n· 其它事件只有 any 语义（单位集只参与条件求值）。\n\n旧卡（没有 unitMode）加载时会自动迁移：条件用了「遍历中的单位 / 遍历中的阵营」→ any；条件只依赖自己 / 触发的单位 → 删掉单位集连线（等价于新语义）。\n\n技能释放条件：把布尔条件接到「单位释放该技能」触发的「条件」输入；不接 = 始终可释放。\n\n「接收到广播」：由「广播」积木发出；触发积木上的广播 id / 广播内容留空 = 任意，两个都填时同时匹配。该触发额外提供两个字符串输出「收到的广播 id / 内容」。",
    ports: [
      { id: "unit", label: "单位集（可选；each 时按单位分别触发）", direction: "in", type: "targetset" },
      { id: "condition", label: "条件（可选；技能释放条件）", direction: "in", type: "condition" },
      { id: "next", direction: "out" },
      // 仅「接收到广播」时显示：本次收到的广播 id / 内容
      { id: "broadcastId", label: "收到的广播 id", direction: "out", type: "string", triggerOnly: "broadcast" },
      { id: "broadcastContent", label: "收到的广播内容", direction: "out", type: "string", triggerOnly: "broadcast" },
    ],
    inflow: null,
    outflows: ["next"],
    options: [
      { key: "event", label: "触发条件", control: "select", options: TRIGGER_EVENTS, default: "unitTurnStart" },
      {
        key: "unitScope",
        label: "「自己」指谁（any / 没接单位集时生效）",
        control: "select",
        options: [
          { value: "self", label: "持有该效果/技能的单位" },
          { value: "target", label: "触发事件的单位（回合开始/结束=行动者）" },
        ],
        default: "self",
      },
      {
        key: "unitMode",
        label: "单位集触发方式",
        control: "select",
        options: [
          { value: "each", label: "按集合里的每个单位分别独立触发（新）" },
          { value: "any", label: "只判定集合里是否有一个满足（旧）" },
        ],
        default: "each",
      },
      // 仅「接收到广播」时出现的两个键入框：留空 = 匹配任意
      { key: "broadcastId", label: "广播 id（留空 = 任意）", control: "text", default: "", showIf: { event: "broadcast" } },
      { key: "broadcastContent", label: "广播内容（留空 = 任意）", control: "text", default: "", showIf: { event: "broadcast" } },
    ],
  });

  /* ---------------- 2 执行类 ---------------- */
  def({
    kind: "attack",
    group: "action",
    title: "攻击",
    subtitle: "进行一次攻击（多个目标同时命中）",
    ports: [
      { id: "in", direction: "in" },
      { id: "targets", label: "目标集", direction: "in", type: "targetset" },
      { id: "value", label: "数值", direction: "in", type: "number" },
      { id: "attribute", label: "属性（字符串）", direction: "in", type: "string" },
      { id: "source", label: "伤害来源（可选，默认自己）", direction: "in", type: "target" },
      { id: "next", direction: "out" },
    ],
    outflows: ["next"],
    options: [
      {
        key: "attribute",
        label: "属性（未连接时用）",
        control: "select",
        options: [
          { value: "physical", label: "物理" },
          { value: "magic", label: "魔法" },
          { value: "spirit", label: "精神" },
          { value: "origin", label: "本源" },
        ],
        default: "physical",
      },
      {
        key: "ignoreReduction",
        label: "无视减免（跳过防御 / 抗性 / 易伤）",
        control: "checkbox",
        default: false,
      },
      {
        key: "additional",
        label: "附加伤害（不视为攻击，无视加成和减免）",
        control: "checkbox",
        default: false,
      },
    ],
    note: "「无视减免」只跳过目标侧的防御 / 抗性 / 易伤，攻击方加成与暴击照常；「附加伤害」不吃任何加成、不看任何减免、不暴击，也不触发「单位攻击时」。目标集里有多个单位时，它们属于同一次攻击动作，命中同时结算；要依次攻击请把「攻击」放进遍历 / 次数 / 条件循环。「伤害来源」留空就是流程拥有者自己；持续伤害可以接到「效果的施加者」，让击杀归属 / 日志记到施加者头上。属性选「本源」时伤害无视一切减免与「免疫伤害」，但仍算一次受击（会触发「单位受击时」）。",
  });
  def({
    kind: "heal",
    group: "action",
    title: "回复",
    subtitle: "回复一些血量",
    ports: [
      { id: "in", direction: "in" },
      { id: "targets", label: "目标集", direction: "in", type: "targetset" },
      { id: "value", label: "数值", direction: "in", type: "number" },
      { id: "next", direction: "out" },
    ],
    outflows: ["next"],
  });
  def({
    kind: "setHp",
    group: "action",
    title: "设置血量",
    subtitle: "直接强制设置血量",
    ports: [
      { id: "in", direction: "in" },
      { id: "targets", label: "目标集", direction: "in", type: "targetset" },
      { id: "value", label: "数值", direction: "in", type: "number" },
      { id: "next", direction: "out" },
    ],
    outflows: ["next"],
  });
  def({
    kind: "attachEffect",
    group: "action",
    title: "附加效果",
    subtitle: "为目标附加一个效果，可指定层数",
    note: "「层数」可以接数值积木，也可以直接在积木上键入；留空默认 1 层。效果卡开启层数计数后才按层数叠加，上限看 maxStacks。",
    ports: [
      { id: "in", direction: "in" },
      { id: "targets", label: "目标集", direction: "in", type: "targetset" },
      { id: "effectId", label: "效果 id（字符串）", direction: "in", type: "string" },
      { id: "value", label: "层数", direction: "in", type: "number" },
      { id: "next", direction: "out" },
    ],
    outflows: ["next"],
  });
  def({
    kind: "removeEffect",
    group: "action",
    title: "移除效果",
    subtitle: "移除目标身上的一个效果",
    note: "附加效果按层数叠加：同一效果每附加一次算 1 层，层数为 0 时移除。默认不可被「移除效果」移除，勾选「强制移除」才可以。",
    ports: [
      { id: "in", direction: "in" },
      { id: "targets", label: "目标集", direction: "in", type: "targetset" },
      { id: "effectId", label: "效果 id（选择「指定效果」时）", direction: "in", type: "string" },
      { id: "value", label: "数值（移除层数）", direction: "in", type: "number" },
      { id: "next", direction: "out" },
    ],
    outflows: ["next"],
    options: [
      {
        key: "mode",
        label: "移除",
        control: "select",
        default: "specified",
        options: [
          { value: "specified", label: "指定效果" },
          { value: "onePositive", label: "一个正面效果" },
          { value: "oneNegative", label: "一个负面效果" },
          { value: "allPositive", label: "全部正面效果" },
          { value: "allNegative", label: "全部负面效果" },
          { value: "all", label: "全部效果" },
        ],
      },
      { key: "force", label: "强制移除（可移除不可解除的效果）", control: "checkbox", default: false },
    ],
  });
  def({
    kind: "summon",
    group: "action",
    title: "召唤单位",
    subtitle: "召唤单位到场上；单位 id 留空 = 召唤自己；无视上限时没空格会溢出同格",
    note: "「阵营」：我方 / 敌方（默认我方），按流程拥有者的阵营判断；「无视单位上限」会同时绕过场上单位数量和空格限制：没有空格时，溢出的单位放在召唤者（或父单位）的格子里，且不占格，不会堵死后续召唤 / 补场。",
    ports: [
      { id: "in", direction: "in" },
      { id: "unitId", label: "召唤单位 id（字符串）", direction: "in", type: "string" },
      { id: "count", label: "数量（数值）", direction: "in", type: "number" },
      { id: "label", label: "标签（字符串）", direction: "in", type: "string" },
      { id: "next", direction: "out" },
    ],
    outflows: ["next"],
    options: [
      {
        key: "side",
        label: "阵营",
        control: "select",
        options: [
          { value: "ally", label: "我方" },
          { value: "enemy", label: "敌方" },
        ],
        default: "ally",
      },
      { key: "ignoreLimit", label: "无视单位上限", control: "checkbox", default: false },
    ],
  });
  def({
    kind: "summonChild",
    group: "action",
    title: "召唤子单位",
    subtitle: "为每个单位召唤子单位，父单位退场时子单位也退场；目标集 / 单位 id 留空 = 自己",
    note: "和「召唤单位」一样支持「无视单位上限」：数量 / 空格满了时溢出到父单位的格子（不占格）。",
    ports: [
      { id: "in", direction: "in" },
      { id: "targets", label: "目标集（父单位）", direction: "in", type: "targetset" },
      { id: "unitId", label: "单位 id（字符串）", direction: "in", type: "string" },
      { id: "count", label: "数量（数值）", direction: "in", type: "number" },
      { id: "label", label: "标签（字符串）", direction: "in", type: "string" },
      { id: "next", direction: "out" },
    ],
    outflows: ["next"],
    options: [{ key: "ignoreLimit", label: "无视单位上限", control: "checkbox", default: false }],
  });
  def({
    kind: "skipTurn",
    group: "action",
    title: "跳过行动",
    subtitle: "若目标正在行动，跳过本次行动",
    ports: [
      { id: "in", direction: "in" },
      { id: "targets", label: "目标集", direction: "in", type: "targetset" },
      { id: "next", direction: "out" },
    ],
    outflows: ["next"],
  });
  def({
    kind: "extraAction",
    group: "action",
    title: "额外行动",
    subtitle: "增加目标单位本回合剩余的可动次数",
    note: "数值为负时可以扣减可动次数。只影响本回合；回合开始时剩余次数会重置为角色的「每回合可动次数」。",
    ports: [
      { id: "in", direction: "in" },
      { id: "targets", label: "目标集", direction: "in", type: "targetset" },
      { id: "value", label: "增加次数", direction: "in", type: "number" },
      { id: "next", direction: "out" },
    ],
    outflows: ["next"],
  });
  def({
    kind: "immuneDamage",
    group: "action",
    title: "免疫伤害",
    subtitle: "若目标即将受到伤害，免疫本次伤害（本源伤害不受影响）",
    note: "放在「单位受击时」流程里，把这一组伤害记 0。本源伤害虽然也会触发受击时，但它不受「免疫伤害」影响——要挡本源请用无敌档位。",
    ports: [
      { id: "in", direction: "in" },
      { id: "targets", label: "目标集", direction: "in", type: "targetset" },
      { id: "next", direction: "out" },
    ],
    outflows: ["next"],
  });
  def({
    kind: "forceExit",
    group: "action",
    title: "退场",
    subtitle: "让目标退场；勾「强制退场」则不会被拒绝退场拦下",
    note: "普通退场可以被「拒绝退场」取消；勾上「强制退场」后无视拒绝退场，直接退场。两种都会被「超级无敌」拦下；「无敌」只吃强制退场。",
    ports: [
      { id: "in", direction: "in" },
      { id: "targets", label: "目标集", direction: "in", type: "targetset" },
      { id: "next", direction: "out" },
    ],
    outflows: ["next"],
    options: [{ key: "force", label: "强制退场", control: "checkbox", default: false }],
  });
  def({
    kind: "refuseExit",
    group: "action",
    title: "拒绝退场",
    subtitle: "取消本次「退场时」并回复血量",
    note: "只在「退场时」触发里有效：把这次退场取消，并按选项回血（回复满 / 回复至指定值）。强制退场不能被拒绝；超级无敌本来就不吃退场。「目标集」可选：接了以后只有正在退场的单位在这个集合里才拒绝（不接 = 就是它自己）。",
    ports: [
      { id: "in", direction: "in" },
      { id: "targets", label: "目标集（可选；默认正在退场的单位）", direction: "in", type: "targetset" },
      { id: "value", label: "回复至（可选；不接用积木上的数字）", direction: "in", type: "number" },
      { id: "next", direction: "out" },
    ],
    outflows: ["next"],
    options: [
      {
        key: "mode",
        label: "回复",
        control: "select",
        default: "full",
        options: [
          { value: "full", label: "回复满" },
          { value: "to", label: "回复至指定值" },
        ],
      },
      { key: "value", label: "回复至", control: "number", default: 1, showIf: { mode: "to" } },
    ],
  });
  def({
    kind: "transferAttack",
    group: "action",
    title: "转移攻击",
    subtitle: "把本次受到的攻击改到另一个单位身上",
    note: "通常放在「单位受击时」流程里：来源 = 本来要挨打的单位（不接就是它自己），对象 = 替它挨打的单位。只改这一次伤害；对象自己的「受击时」会照常触发。本源伤害默认不能转移，勾上「强制转移」才可以。",
    ports: [
      { id: "in", direction: "in" },
      { id: "from", label: "来源（本来受击的单位）", direction: "in", type: "targetset" },
      { id: "to", label: "对象（转移后受击的单位）", direction: "in", type: "targetset" },
      { id: "next", direction: "out" },
    ],
    outflows: ["next"],
    options: [{ key: "force", label: "强制转移（本源伤害也能转）", control: "checkbox", default: false }],
  });
  def({
    kind: "giveSkill",
    group: "action",
    title: "给予技能",
    subtitle: "临时获得一个额外技能（不随效果移除；效果挂载技能请用效果表单）",
    ports: [
      { id: "in", direction: "in" },
      { id: "skillId", label: "技能 id（字符串）", direction: "in", type: "string" },
      { id: "next", direction: "out" },
    ],
    outflows: ["next"],
  });
  def({
    kind: "broadcast",
    group: "action",
    title: "广播",
    subtitle: "把一条广播排到本次流程结束后发出",
    note: "跨单位通信：执行到这里时先记下广播，等本次流程（含它触发的嵌套流程）全部结束后再统一发出，避免广播互相嵌套导致递归。所有持有「接收到广播」触发、且广播 id / 内容匹配的单位会在广播事件里执行各自的流程。广播 id / 内容既可以接线，也可以直接在积木上键入。",
    ports: [
      { id: "in", direction: "in" },
      { id: "id", label: "广播 id（字符串）", direction: "in", type: "string" },
      { id: "content", label: "广播内容（字符串）", direction: "in", type: "string" },
      { id: "next", direction: "out" },
    ],
    outflows: ["next"],
    options: [
      { key: "id", label: "广播 id（未接线时使用）", control: "text", default: "" },
      { key: "content", label: "广播内容（未接线时使用）", control: "text", default: "" },
    ],
  });

  /* ---------------- 3 结构类 ---------------- */
  def({
    kind: "branch",
    group: "structure",
    title: "条件分支",
    subtitle: "根据条件执行不同分支",
    ports: [
      { id: "in", direction: "in" },
      { id: "condition", label: "条件", direction: "in", type: "condition" },
      { id: "true", label: "真分支", direction: "out" },
      { id: "false", label: "假分支", direction: "out" },
    ],
    outflows: ["true", "false"],
  });
  def({
    kind: "whileLoop",
    group: "structure",
    title: "条件循环",
    subtitle: "当条件满足时循环执行",
    ports: [
      { id: "in", direction: "in" },
      { id: "condition", label: "条件", direction: "in", type: "condition" },
      { id: "body", label: "循环体", direction: "out" },
      { id: "end", label: "结束", direction: "out" },
    ],
    outflows: ["body", "end"],
  });
  def({
    kind: "forEach",
    group: "structure",
    title: "遍历循环",
    subtitle: "遍历目标集中的目标",
    ports: [
      { id: "in", direction: "in" },
      { id: "targets", label: "目标集", direction: "in", type: "targetset" },
      { id: "body", label: "循环体", direction: "out" },
      { id: "end", label: "结束", direction: "out" },
    ],
    outflows: ["body", "end"],
    options: [{ key: "context", label: "循环内「遍历中的单位」指代", control: "select", default: "each", options: [
      { value: "each", label: "本次遍历的单位" },
      { value: "stay", label: "不变" },
    ] }],
  });
  def({
    kind: "repeatLoop",
    group: "structure",
    title: "次数循环",
    subtitle: "按次数循环执行",
    ports: [
      { id: "in", direction: "in" },
      { id: "count", label: "数值（次数）", direction: "in", type: "number" },
      { id: "body", label: "循环体", direction: "out" },
      { id: "end", label: "结束", direction: "out" },
    ],
    outflows: ["body", "end"],
  });

  /* ---------------- 4 条件类 ---------------- */
  const conditionBinary = (kind, title, subtitle) =>
    def({
      kind,
      group: "logic",
      title,
      subtitle,
      ports: [
        { id: "a", label: "条件 A", direction: "in", type: "condition" },
        { id: "b", label: "条件 B", direction: "in", type: "condition" },
        { id: "out", direction: "out", type: "condition" },
      ],
    });
  def({
    kind: "sameUnit",
    group: "logic",
    title: "是同一单位",
    subtitle: "比较两个单位引用是否指向同一个战斗单位",
    note: "按战斗内 uid 比较；同名 / 同卡的不同单位也不会混淆。常用于判断「触发者是不是自己的父单位」。",
    ports: [
      { id: "a", label: "单位 A", direction: "in", type: "target" },
      { id: "b", label: "单位 B", direction: "in", type: "target" },
      { id: "out", direction: "out", type: "condition" },
    ],
  });
  def({
    kind: "exitSaved",
    group: "logic",
    title: "本次退场已被拒绝",
    subtitle: "当前退场是否已经被别的效果救回",
    note: "只在「退场时」触发的流程里有意义：同一退场请求里，前面的效果已经执行过「拒绝退场」时输出为真。用于多个救场效果 / 多个同名单位时，让后面那个不要再消耗自己的资源。",
    ports: [{ id: "out", direction: "out", type: "condition" }],
  });
  def({
    kind: "exitForced",
    group: "logic",
    title: "本次退场是强制退场",
    subtitle: "当前退场是否无法被拒绝",
    note: "只在「退场时」触发的流程里有意义：强制退场不能被「拒绝退场」取消。用「非」接上它，可以避免在强制退场时白白消耗效果 / 层数。",
    ports: [{ id: "out", direction: "out", type: "condition" }],
  });
  def({
    kind: "compare",
    group: "logic",
    title: "比较",
    subtitle: "比较两个数值/字符串",
    ports: [
      { id: "a", label: "数值/字符串", direction: "in", type: "any" },
      { id: "b", label: "数值/字符串", direction: "in", type: "any" },
      { id: "out", direction: "out", type: "condition" },
    ],
    // 比较的两个输入画在积木两侧（左 A、右 B），不是上方
    span: true,
    options: [{ key: "operator", label: "比较符", control: "select", options: COMPARE_OPERATORS, default: ">=" }],
  });
  conditionBinary("and", "与", "逻辑与");
  conditionBinary("or", "或", "逻辑或");
  def({
    kind: "not",
    group: "logic",
    title: "非",
    subtitle: "逻辑非",
    ports: [
      { id: "a", label: "条件", direction: "in", type: "condition" },
      { id: "out", direction: "out", type: "condition" },
    ],
  });
  conditionBinary("xor", "异或", "逻辑异或");
  conditionBinary("xnor", "同或", "逻辑同或");

  /* ---------------- 5 数据类 ---------------- */
  def({
    kind: "number",
    group: "data-op",
    title: "数值",
    subtitle: "键入一个固定数值",
    ports: [{ id: "num", direction: "out", type: "number" }],
    options: [
      {
        key: "mode",
        label: "数值来源",
        control: "select",
        default: "const",
        options: [
          { value: "const", label: "键入" },
          { value: "range", label: "范围内随机整数" },
          { value: "pi", label: "π" },
          { value: "e", label: "e" },
        ],
      },
      { key: "value", label: "数值", control: "number", default: 0, showIf: { mode: "const" } },
      { key: "min", label: "最小", control: "number", default: 0, showIf: { mode: "range" } },
      { key: "max", label: "最大", control: "number", default: 10, showIf: { mode: "range" } },
    ],
  });
  def({
    kind: "string",
    group: "data-op",
    title: "字符串",
    subtitle: "键入一个固定字符串",
    ports: [{ id: "str", direction: "out", type: "string" }],
    options: [{ key: "value", label: "字符串", control: "text", default: "" }],
  });
  def({
    kind: "math",
    group: "data-op",
    title: "运算",
    subtitle: "对数值进行运算",
    note: "max / min 的输入数量等于「已连接数 + 1」，连满后会再长出一个输入口。",
    ports: [{ id: "num", direction: "out", type: "number" }],
    options: [{ key: "operator", label: "运算", control: "select", options: MATH_OPERATORS, default: "add" }],
  });
  def({
    kind: "getUnit",
    group: "data-unit",
    title: "获取单位",
    subtitle: "从目标集中取第几个单位",
    ports: [
      { id: "targets", label: "目标集", direction: "in", type: "targetset" },
      { id: "index", label: "第几个", direction: "in", type: "number" },
      { id: "target", direction: "out", type: "target" },
    ],
  });
  def({
    kind: "targetSide",
    group: "data-set",
    title: "获取目标集",
    subtitle: "获取敌方/我方全体",
    ports: [{ id: "set", direction: "out", type: "targetset" }],
    options: [{ key: "side", label: "目标集", control: "select", options: SIDE_OPTIONS, default: "enemy" }],
    note: "「敌方 / 我方」按两阵营简化处理：取「自己所在阵营 / 对立阵营」。多阵营或要按单位所属阵营取人时，请用「单位所属的阵营」。计数不再影响目标集；选中限制会按施放者阵营排除「不可被敌方选中 / 不可被我方选中 / 不可选中」的单位（想显式命中它们请用「全部单位」/「筛选目标集」）。",
  });
  def({
    kind: "factionSet",
    group: "data-set",
    title: "单位所属的阵营",
    subtitle: "输入一个单位，获取该单位所属阵营的全体单位",
    note: "不依赖两阵营假设：按单位身上记录的阵营取同阵营的存活单位。单位留空 = 自己。默认包含不计数单位（计数只影响阵营单位数量上限）；取消勾选「包含不计数单位」才会排除它们。旧名「按单位的阵营」，现统一为「单位所属的阵营」。",
    ports: [
      { id: "unit", label: "单位（可空＝自己）", direction: "in", type: "target" },
      { id: "set", direction: "out", type: "targetset" },
    ],
    options: [{ key: "includeUncounted", label: "包含不计数单位（默认勾选）", control: "checkbox", default: true }],
  });
  def({
    kind: "allUnits",
    group: "data-set",
    title: "全部单位",
    subtitle: "场上所有存活单位",
    note: "多阵营时用来按「获取单位数据 → 阵营」自行筛选；默认包含全部存活单位（不计数单位也算单位）。",
    ports: [{ id: "set", direction: "out", type: "targetset" }],
    options: [{ key: "countedOnly", label: "只取计数单位（默认不勾选）", control: "checkbox", default: false }],
  });
  def({
    kind: "currentEffect",
    group: "data-op",
    title: "当前效果",
    subtitle: "正在执行的这个效果的 id",
    note: "只能在效果流程里用；技能流程里没有「当前效果」，读到空字符串。用来代替手写的效果 id 字符串，效果改名 / 复制卡时不用再改积木。",
    ports: [{ id: "str", direction: "out", type: "string" }],
  });
  def({
    kind: "effectSource",
    group: "data-unit",
    title: "效果的施加者",
    subtitle: "读取某个效果的施加者",
    note: "「效果 id」留空 = 当前正在执行的效果；「持有者」留空 = 流程拥有者。「施加者」是最后一次附加该效果的单位；没有记录（卡面初始效果 / 系统施加）时输出空。",
    ports: [
      { id: "effectId", label: "效果 id（可空＝当前效果）", direction: "in", type: "string" },
      { id: "unit", label: "持有者（可空＝自己）", direction: "in", type: "target" },
      { id: "target", direction: "out", type: "target" },
    ],
  });
  def({
    kind: "effectSourceSide",
    group: "data-set",
    title: "效果的施加者阵营（旧版，已隐藏）",
    subtitle: "获取施加者所属阵营的全体单位",
    note: "优先按施加者当前阵营取；施加者已经不在场时，用附加效果时记下的阵营快照。没有施加者时输出空集。「效果 id」「持有者」用法同「效果的施加者」。",
    ports: [
      { id: "effectId", label: "效果 id（可空＝当前效果）", direction: "in", type: "string" },
      { id: "unit", label: "持有者（可空＝自己）", direction: "in", type: "target" },
      { id: "set", direction: "out", type: "targetset" },
    ],
    options: [{ key: "includeUncounted", label: "包含不计数单位（默认勾选）", control: "checkbox", default: true }],
    hidden: true,
  });
  def({
    kind: "chooseUnit",
    group: "data-unit",
    title: "选择单位",
    subtitle: "由玩家在战斗中指定单位",
    ports: [
      { id: "targets", label: "目标集（可选范围）", direction: "in", type: "targetset" },
      { id: "set", direction: "out", type: "targetset" },
    ],
    options: [
      { key: "count", label: "最多可选", control: "number", default: 1, min: 1, max: 99 },
      { key: "mustFill", label: "必须选满", control: "checkbox", default: false },
      { key: "eachTime", label: "每次重选（执行到这块就重选一次）", control: "checkbox", default: false },
    ],
    note: "流程里放了「选择单位」的技能，战斗界面会先让玩家点选目标再释放；「最多可选」是这次能让玩家点几个（默认 1），不勾「必须选满」时可以少选几个直接放。默认同一次施放里只问一次（循环里也只问一次）；勾「每次重选」后，流程每执行到这个积木都重新让玩家选（适合循环里逐个选人）。全体攻击 / 固定目标的技能不需要放它。候选集里带进来的单位仍会按施放者阵营检查选中限制。",
  });
  def({
    kind: "setOp",
    group: "data-set",
    title: "集合运算",
    subtitle: "对目标集进行集合运算",
    ports: [
      { id: "a", label: "目标集 A", direction: "in", type: "targetset" },
      { id: "b", label: "目标集 B", direction: "in", type: "targetset" },
      { id: "set", direction: "out", type: "targetset" },
    ],
    options: [{
      key: "operator",
      label: "运算",
      control: "select",
      default: "intersect",
      options: [
        { value: "intersect", label: "交集" },
        { value: "union", label: "并集" },
        { value: "diff", label: "相对差集 A - B" },
      ],
    }],
  });
  def({
    kind: "setCount",
    group: "data-op",
    title: "目标集的单位数",
    subtitle: "数一数目标集里有几个单位",
    note: "输出这个目标集里实际有几个单位（空集为 0），常用于「我方单位数」「子单位数量」这类判断。",
    ports: [
      { id: "set", label: "目标集", direction: "in", type: "targetset" },
      { id: "count", direction: "out", type: "number" },
    ],
  });
  def({
    kind: "unitData",
    group: "data-op",
    title: "获取单位数据",
    subtitle: "获取某个单位的数据字段",
    ports: [
      { id: "unit", label: "目标", direction: "in", type: "target" },
      { id: "effectId", label: "效果 id（层数字段用）", direction: "in", type: "string" },
      { id: "value", direction: "out", type: "any" },
    ],
    options: [{ key: "field", label: "字段", control: "select", options: UNIT_DATA_FIELDS, default: "hp" }],
  });
  def({
    kind: "selfData",
    group: "data-op",
    title: "自己的数值",
    subtitle: "直接读取流程拥有者自己的数据字段",
    note: "不需要连「目标」，永远取流程的拥有者（技能施放者 / 效果持有者）。字段与「获取单位数据」相同。",
    ports: [
      { id: "effectId", label: "效果 id（层数字段用）", direction: "in", type: "string" },
      { id: "value", label: "值（类型随字段）", direction: "out", type: "any" },
    ],
    options: [{ key: "field", label: "字段", control: "select", options: UNIT_DATA_FIELDS, default: "atk" }],
  });
  def({
    kind: "filterSet",
    group: "data-set",
    title: "筛选目标集",
    subtitle: "保留满足条件的单位（条件里用「遍历中的单位」指代当前单位）",
    ports: [
      { id: "targets", label: "目标集", direction: "in", type: "targetset" },
      { id: "condition", label: "条件", direction: "in", type: "condition" },
      { id: "set", direction: "out", type: "targetset" },
    ],
  });
  def({
    kind: "contextUnit",
    group: "data-unit",
    title: "遍历中的单位",
    subtitle: "占位符，指代遍历中选中的单位",
    ports: [{ id: "target", direction: "out", type: "target" }],
  });
  def({
    kind: "selfUnit",
    group: "data-unit",
    title: "单位",
    subtitle: "获取指定单位",
    ports: [{ id: "target", direction: "out", type: "target" }],
    options: [{ key: "which", label: "单位", control: "select", options: [{ value: "self", label: "自己" }], default: "self" }],
  });

  def({
    kind: "childUnits",
    group: "data-set",
    title: "全部子单位",
    subtitle: "取某个单位的全部存活子单位（召唤 / 分裂出来的）",
    note: "不接「单位」时取流程拥有者自己。只统计还活着、并且当初是用「召唤子单位」挂在这个单位下面的子单位；父单位退场时子单位会一起退场。",
    ports: [
      { id: "unit", label: "单位（可选，默认自己）", direction: "in", type: "target" },
      { id: "set", direction: "out", type: "targetset" },
    ],
  });
  def({
    kind: "parentUnit",
    group: "data-unit",
    title: "父单位",
    subtitle: "取某个单位的父单位（召唤它的那个单位）",
    note: "不接「单位」时取流程拥有者自己。不是召唤出来的单位、或父单位已经不在场时输出为空。",
    ports: [
      { id: "unit", label: "单位（可选，默认自己）", direction: "in", type: "target" },
      { id: "target", direction: "out", type: "target" },
    ],
  });
  def({
    kind: "actingUnit",
    group: "data-unit",
    title: "操作中的单位",
    subtitle: "执行类积木正在逐个处理的这个目标",
    note: "攻击 / 回复 / 附加效果 / 移除效果 / 额外行动等执行类积木一次处理多个目标时，会逐个目标结算；这个积木就是「当前正在处理的那个目标」，用来读它自己的数值。和「遍历中的单位」互相独立：循环里的「遍历中的单位」不会因为执行类积木而改变，这个积木也不会因为循环而改变。不在执行类积木的目标处理里时为空。",
    ports: [{ id: "target", label: "操作中的单位", direction: "out", type: "target" }],
  });

  /* ---------------- 6 变量类 ---------------- */
  // 变量的作用域是「一次流程执行」：每次释放技能 / 触发流程都会重新声明，
  // 流程跑完就清空，因此不跨回合保存，不同技能可以放心用同名变量。
  def({
    kind: "declareVariable",
    group: "variable",
    title: "声明变量",
    subtitle: "创建一个变量并赋值",
    note: "变量只在本次流程执行内有效：每次释放技能 / 触发流程都会重新声明，流程结束即清空，不跨回合保存；不同技能可以用同名变量互不影响。「值」不连线时按类型取默认值（数字 0 / 字符串空 / 布尔 false / 单位空 / 目标集空集）。",
    ports: [
      { id: "in", direction: "in" },
      { id: "value", label: "值", direction: "in", type: "number" },
      { id: "next", direction: "out" },
    ],
    outflows: ["next"],
    options: [
      { key: "name", label: "变量名", control: "text", default: "var" },
      { key: "type", label: "类型", control: "select", options: VARIABLE_TYPES, default: "number" },
    ],
  });
  def({
    kind: "readVariable",
    group: "variable",
    title: "读取变量",
    subtitle: "读取变量的当前值",
    note: "变量必须先「声明」。未声明时读到空值；每次都读最新值（不进流程值缓存），可以直接接到攻击数值、比较、条件等输入。",
    volatile: true,
    ports: [{ id: "value", label: "变量值（类型随变量）", direction: "out", type: "any" }],
    options: [{ key: "name", label: "变量名", control: "text", default: "var" }],
  });
  def({
    kind: "setVariable",
    group: "variable",
    title: "设置变量值",
    subtitle: "把变量改成新的值",
    note: "按声明时的类型转换后写入；变量未声明时不做任何事。",
    ports: [
      { id: "in", direction: "in" },
      { id: "value", label: "新的变量值", direction: "in", type: "any" },
      { id: "next", direction: "out" },
    ],
    outflows: ["next"],
    options: [{ key: "name", label: "变量名", control: "text", default: "var" }],
  });
  def({
    kind: "addVariable",
    group: "variable",
    title: "增加变量值",
    subtitle: "给数字变量加上一个值",
    note: "只对声明为「数字」的变量生效；未声明或非数字变量时不做任何事。",
    ports: [
      { id: "in", direction: "in" },
      { id: "value", label: "增加值", direction: "in", type: "number" },
      { id: "next", direction: "out" },
    ],
    outflows: ["next"],
    options: [{ key: "name", label: "变量名", control: "text", default: "var" }],
  });

  /* ---------------- 补全：让「筛选目标集」的条件可以用「遍历中的单位」指代 ---------------- */
  def({
    kind: "contextSide",
    group: "data-set",
    title: "遍历中的阵营",
    subtitle: "占位符，指代遍历中选中单位的阵营（用于拼敌方/我方全体 - 当前目标）",
    ports: [{ id: "set", direction: "out", type: "targetset" }],
  });
  def({
    kind: "currentTarget",
    group: "data-set",
    title: "当前目标",
    subtitle: "技能被打出的目标（战斗中由玩家选定）",
    ports: [{ id: "set", direction: "out", type: "targetset" }],
  });
  def({
    kind: "triggerUnit",
    group: "data-unit",
    title: "触发的单位",
    subtitle: "触发积木里连接的「单位」（没连则为本流程的拥有者）",
    ports: [{ id: "target", direction: "out", type: "target" }],
  });
  def({
    kind: "healSource",
    group: "data-unit",
    title: "回复来源",
    subtitle: "本次回复事件的治疗者",
    note: "只在「单位回复生命时」触发的流程里有值；不在回复触发里输出空。用来判断是父单位、自己还是别的单位治疗了某个友方。",
    ports: [{ id: "target", direction: "out", type: "target" }],
  });

  /* 运算：按选项生成固定输入端口 */
  const math = blocks.math;
  const op = math.options[0].default;
  math.dynamicInputs = true;
  math.fixedInputPorts = (options = {}) => MATH_FIXED_INPUTS[options.operator] || MATH_FIXED_INPUTS[op] || [];

  /** 数据类内部排序：运算 → 单位 → 目标集；编辑器按 order 排，不依赖定义顺序 */
  const DATA_ORDER = {
    number: 1, string: 2, math: 3, unitData: 4, selfData: 5, currentEffect: 6,
    getUnit: 11, chooseUnit: 12, selfUnit: 13, contextUnit: 14, triggerUnit: 15, effectSource: 16, actingUnit: 17,
    parentUnit: 18, childUnits: 19, setCount: 20,
    targetSide: 21, factionSet: 22, allUnits: 23, setOp: 24, filterSet: 25, contextSide: 26, currentTarget: 27,
    effectSourceSide: 28,
  };
  for (const [kind, order] of Object.entries(DATA_ORDER)) {
    if (blocks[kind]) blocks[kind].order = order;
  }

  return { blocks, DATA_TYPES, BLOCK_GROUPS, TRIGGER_EVENTS, UNIT_DATA_FIELDS, MATH_OPERATORS };
}

/**
 * 某个积木在给定选项下最终需要的输入端口（用于编辑器画「+1 输入」与连线校验）。
 * @param {object} block catalog 中的积木定义
 * @param {object} options 节点选项
 * @param {number} [connectedCount] 已连接的输入数（max/min 用）
 */
export function inputPortIds(block, options = {}, connectedCount = 0) {
  if (block.kind === "math") {
    const list = MATH_FIXED_INPUTS[options.operator] || [];
    if (list.length > 0) return list.slice();
    // 无限输入：已连接数 + 1
    const n = Math.max(1, connectedCount + 1);
    return Array.from({ length: n }, (_, i) => `in${i + 1}`);
  }
  return block.ports.filter((p) => p.direction === "in" && p.id !== "in").map((p) => p.id);
}

/** 所有可连数据的输出端口 */
export function outputPortIds(block) {
  return block.ports.filter((p) => p.direction === "out" && p.type).map((p) => p.id);
}
