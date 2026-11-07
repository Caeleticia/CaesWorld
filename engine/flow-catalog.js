/**
 * flow-catalog.js —— 积木块总览（编辑器与解释器共用的一份定义）
 *
 * 每个积木：
 *   kind        积木类型 id（存档里节点的 type）
 *   group       所属大类（trigger/action/structure/logic/data）
 *   title       显示名
 *   subtitle    副标题（补充说明）
 *   color       上方附着色（由大类颜色派生，五种）
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
export const DATA_TYPES = Object.freeze(["targetset", "target", "number", "string", "condition"]);

export const DATA_TYPE_LABEL = Object.freeze({
  targetset: "目标集",
  target: "目标",
  number: "数字",
  string: "字符串",
  condition: "条件",
});

/** 大类：颜色 = 积木上方的附着色，也决定端口配色 */
export const BLOCK_GROUPS = Object.freeze({
  trigger: { label: "触发类", color: "#E4574C" },
  action: { label: "执行类", color: "#F08A2C" },
  structure: { label: "结构类", color: "#E6B422" },
  logic: { label: "条件类", color: "#3FA45B" },
  data: { label: "数据类", color: "#5FB0E6" },
});

const TRIGGER_EVENTS = Object.freeze([
  { value: "turnStart", label: "回合开始时" },
  { value: "turnEnd", label: "回合结束时" },
  { value: "unitTurnStart", label: "单位行动开始时" },
  { value: "unitTurnEnd", label: "单位行动结束时" },
  { value: "skillCast", label: "单位释放技能" },
  { value: "skillCastSelf", label: "单位释放该技能（仅本技能自身）" },
  { value: "attack", label: "单位攻击时" },
  { value: "attacked", label: "单位受击时" },
  { value: "lethalDamage", label: "单位受致命伤害时" },
  { value: "unitEnter", label: "单位入场时" },
  { value: "unitExit", label: "单位退场时" },
  { value: "heal", label: "单位回复生命时" },
  { value: "loseHp", label: "单位损失生命时" },
  { value: "always", label: "始终（每次数据更新都触发一次）" },
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
  { value: "pos", label: "pos(a,b) 正数化" },
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
  { value: "lastLose", label: "上一次损失的生命值", type: "number" },
  { value: "lastHpChange", label: "上一次变动的生命值（回复为正）", type: "number" },
  { value: "lastAttackTarget", label: "上一次攻击的目标", type: "target" },
  { value: "lastHitSource", label: "上一次受击的来源目标", type: "target" },
  { value: "effectStacks", label: "目标指定效果的层数", type: "number" },
  { value: "label", label: "标签", type: "string" },
  { value: "name", label: "名字", type: "string" },
  { value: "id", label: "id", type: "string" },
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
    subtitle: "满足条件时触发",
    note: "流程入口。技能流程可以放多个触发，每个触发执行它后面的内容；效果的每个触发是一条独立流程。",
    ports: [
      { id: "unit", label: "单位（可选）", direction: "in", type: "target" },
      { id: "condition", label: "条件（可选）", direction: "in", type: "condition" },
      { id: "next", direction: "out" },
    ],
    inflow: null,
    outflows: ["next"],
    options: [
      { key: "event", label: "触发条件", control: "select", options: TRIGGER_EVENTS, default: "unitTurnStart" },
      {
        key: "unitScope",
        label: "「自己」指谁",
        control: "select",
        options: [
          { value: "self", label: "持有该效果/技能的单位" },
          { value: "target", label: "触发事件的单位（回合开始/结束=行动者）" },
        ],
        default: "self",
      },
    ],
  });

  /* ---------------- 2 执行类 ---------------- */
  def({
    kind: "attack",
    group: "action",
    title: "攻击",
    subtitle: "进行一次攻击",
    ports: [
      { id: "in", direction: "in" },
      { id: "targets", label: "目标集", direction: "in", type: "targetset" },
      { id: "value", label: "数值", direction: "in", type: "number" },
      { id: "attribute", label: "属性（字符串）", direction: "in", type: "string" },
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
    note: "「无视减免」只跳过目标侧的防御 / 抗性 / 易伤，攻击方加成与暴击照常；「附加伤害」不吃任何加成、不看任何减免、不暴击，也不触发「单位攻击时」。",
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
    subtitle: "为目标附加一个效果",
    ports: [
      { id: "in", direction: "in" },
      { id: "targets", label: "目标集", direction: "in", type: "targetset" },
      { id: "effectId", label: "效果 id（字符串）", direction: "in", type: "string" },
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
    subtitle: "召唤单位到场上",
    ports: [
      { id: "in", direction: "in" },
      { id: "unitId", label: "召唤单位 id（字符串）", direction: "in", type: "string" },
      { id: "count", label: "数量（数值）", direction: "in", type: "number" },
      { id: "label", label: "标签（字符串）", direction: "in", type: "string" },
      { id: "next", direction: "out" },
    ],
    outflows: ["next"],
    options: [{ key: "ignoreLimit", label: "无视单位上限", control: "checkbox", default: false }],
  });
  def({
    kind: "summonChild",
    group: "action",
    title: "召唤子单位",
    subtitle: "为每个单位召唤子单位，父单位退场时子单位也退场",
    ports: [
      { id: "in", direction: "in" },
      { id: "targets", label: "目标集（父单位）", direction: "in", type: "targetset" },
      { id: "unitId", label: "单位 id（字符串）", direction: "in", type: "string" },
      { id: "count", label: "数量（数值）", direction: "in", type: "number" },
      { id: "label", label: "标签（字符串）", direction: "in", type: "string" },
      { id: "next", direction: "out" },
    ],
    outflows: ["next"],
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
    kind: "immuneDamage",
    group: "action",
    title: "免疫伤害",
    subtitle: "若目标即将受到伤害，免疫本次伤害",
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
    title: "强制退场",
    subtitle: "使目标强制退场",
    ports: [
      { id: "in", direction: "in" },
      { id: "targets", label: "目标集", direction: "in", type: "targetset" },
      { id: "next", direction: "out" },
    ],
    outflows: ["next"],
  });
  def({
    kind: "giveSkill",
    group: "action",
    title: "给予技能",
    subtitle: "持有该效果时获得一个额外技能",
    ports: [
      { id: "in", direction: "in" },
      { id: "skillId", label: "技能 id（字符串）", direction: "in", type: "string" },
      { id: "next", direction: "out" },
    ],
    outflows: ["next"],
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
    options: [{ key: "context", label: "循环内「7-1 当前目标站」指代", control: "select", default: "each", options: [
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
    group: "data",
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
    group: "data",
    title: "字符串",
    subtitle: "键入一个固定字符串",
    ports: [{ id: "str", direction: "out", type: "string" }],
    options: [{ key: "value", label: "字符串", control: "text", default: "" }],
  });
  def({
    kind: "math",
    group: "data",
    title: "运算",
    subtitle: "对数值进行运算",
    note: "max / min 的输入数量等于「已连接数 + 1」，连满后会再长出一个输入口。",
    ports: [{ id: "num", direction: "out", type: "number" }],
    options: [{ key: "operator", label: "运算", control: "select", options: MATH_OPERATORS, default: "add" }],
  });
  def({
    kind: "getUnit",
    group: "data",
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
    group: "data",
    title: "获取目标集",
    subtitle: "获取敌方/我方全体",
    ports: [{ id: "set", direction: "out", type: "targetset" }],
    options: [{ key: "side", label: "目标集", control: "select", options: SIDE_OPTIONS, default: "enemy" }],
  });
  def({
    kind: "chooseUnit",
    group: "data",
    title: "选择单位",
    subtitle: "由玩家在战斗中指定单位",
    ports: [
      { id: "targets", label: "目标集（可选范围）", direction: "in", type: "targetset" },
      { id: "set", direction: "out", type: "targetset" },
    ],
    options: [{ key: "multiple", label: "允许多选", control: "checkbox", default: true }],
  });
  def({
    kind: "setOp",
    group: "data",
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
    kind: "unitData",
    group: "data",
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
    group: "data",
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
    group: "data",
    title: "筛选目标集",
    subtitle: "保留满足条件的单位（指代用 7-1）",
    ports: [
      { id: "targets", label: "目标集", direction: "in", type: "targetset" },
      { id: "condition", label: "条件", direction: "in", type: "condition" },
      { id: "set", direction: "out", type: "targetset" },
    ],
  });
  def({
    kind: "contextUnit",
    group: "data",
    title: "遍历中的单位",
    subtitle: "占位符，指代遍历中选中的单位",
    ports: [{ id: "target", direction: "out", type: "target" }],
  });
  def({
    kind: "selfUnit",
    group: "data",
    title: "单位",
    subtitle: "获取指定单位",
    ports: [{ id: "target", direction: "out", type: "target" }],
    options: [{ key: "which", label: "单位", control: "select", options: [{ value: "self", label: "自己" }], default: "self" }],
  });

  /* ---------------- 7 补全（实现 5-8 的「用 5-9 指代」） ---------------- */
  def({
    kind: "contextSide",
    group: "data",
    title: "遍历中的阵营",
    subtitle: "占位符，指代遍历中选中单位的阵营（用于拼敌方/我方全体 - 当前目标）",
    ports: [{ id: "set", direction: "out", type: "targetset" }],
  });
  def({
    kind: "currentTarget",
    group: "data",
    title: "当前目标",
    subtitle: "技能被打出的目标（战斗中由玩家选定）",
    ports: [{ id: "set", direction: "out", type: "targetset" }],
  });
  def({
    kind: "triggerUnit",
    group: "data",
    title: "触发的单位",
    subtitle: "触发积木里连接的「单位」（没连则为本流程的拥有者）",
    ports: [{ id: "target", direction: "out", type: "target" }],
  });

  /* 运算：按选项生成固定输入端口 */
  const math = blocks.math;
  const op = math.options[0].default;
  math.dynamicInputs = true;
  math.fixedInputPorts = (options = {}) => MATH_FIXED_INPUTS[options.operator] || MATH_FIXED_INPUTS[op] || [];

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
