/**
 * engine/index.js —— 战斗引擎统一出口
 *
 *   import { ContentRegistry, createBattle, calculateDamage } from "./engine/index.js";
 *
 * 分层：
 *   constants   枚举 / 默认值 / id 规则
 *   math        四系表、浮点近似、可复现随机
 *   units       单位卡
 *   skills      技能卡
 *   modifiers   效果加成累加
 *   stats       实时面板
 *   damage      伤害公式（纯函数）
 *   targeting   站位 / 占位 / 计数 / 索敌
 *   buffs       运行时效果
 *   registry    内容注册表
 *   battle      战斗流程
 *   storage     序列化 / 校验 / 存档
 */
export * from "./constants.js";
export * from "./math.js";
export * from "./units.js";
export * from "./skills.js";
export * from "./modifiers.js";
export * from "./stats.js";
export * from "./damage.js";
export * from "./targeting.js";
export * from "./buffs.js";
export * from "./registry.js";
export * from "./battle.js";
export * from "./storage.js";
export * from "./flow-catalog.js";
export * from "./flow.js";
export * from "./editor.js";
export * from "./pack.js";
