/*!
 * Cae'sWorld — menus.js
 * 菜单结构（纯数据）+ 图标路径表。
 * 本轮只做 UI：每个入口对应一个“占位视图”，不含玩法逻辑。
 *
 * 字段：id 唯一标识 / label 标签名 / icon 图标（SvgIcons 键）/ desc 一行说明 /
 *       options 子项 [{id,label,desc,badge}] / placeholder 占位视图文案 / tag 标签上的角标
 */
(function (CW) {
  'use strict';

  const MENUS = [
    {
      id: 'play',
      label: '游玩',
      en: 'Play',
      icon: 'play',
      desc: '四种对局模式',
      options: [
        { id: 'play.local', label: '同屏', en: 'Local', desc: '同一块屏幕上，和朋友轮流出牌', icon: 'users' },
        { id: 'play.rogue', label: '肉鸽', en: 'Rogue', desc: '一局接一局，构筑你的卡组', icon: 'dice' },
        { id: 'play.endless', label: '无尽', en: 'Endless', desc: '没有终点的对局，只分成与败', icon: 'infinity' },
        { id: 'play.challenge', label: '挑战', en: 'Challenge', desc: '固定牌面，挑战最优解', icon: 'flag' },
      ],
      placeholder: {
        title: '游玩',
        sub: '四种模式：同屏 / 肉鸽 / 无尽 / 挑战',
        notes: ['对局界面尚未接入，先选好模式吧。', '正式版本会从这里进入牌桌。'],
      },
    },
    {
      id: 'test',
      label: '测试',
      en: 'Test',
      icon: 'flask',
      desc: '调试与试玩',
      options: [{ id: 'test.training', label: '训练场', en: 'Training', desc: '随便打，没有胜负', icon: 'target' }],
      placeholder: {
        title: '训练场',
        sub: '随便打，没有胜负',
        notes: ['这里将来会放沙盒：任意卡牌、任意对手、无限资源。'],
      },
    },
    {
      id: 'design',
      label: '设计',
      en: 'Design',
      icon: 'pen',
      desc: '做一张自己的卡',
      options: [{ id: 'design.editor', label: '编辑器', en: 'Editor', desc: '从一张白纸开始做卡', icon: 'edit' }],
      placeholder: {
        title: '编辑器',
        sub: '从一张白纸开始做卡',
        notes: ['画布、卡片模板、效果描述……都在路上。', '每个人都能做卡牌。'],
      },
    },
    {
      id: 'mods',
      label: '模组',
      en: 'Mods',
      icon: 'blocks',
      desc: '扩展内容管理',
      options: [{ id: 'mods.manage', label: '模组管理', en: 'Mod Manager', desc: '启用、排序、查看模组', icon: 'folder' }],
      placeholder: {
        title: '模组管理',
        sub: '启用、排序、查看模组',
        notes: ['模组加载尚未实现。'],
        tag: '即将开放',
      },
    },
    {
      id: 'settings',
      label: '设置',
      en: 'Settings',
      icon: 'gear',
      desc: '偏好与外观',
      options: [{ id: 'settings.general', label: '设置', en: 'Preferences', desc: '外观、声音、数据', icon: 'sliders' }],
      placeholder: {
        title: '设置',
        sub: '外观、声音、数据',
        notes: ['设置项会在后续版本接入。'],
        tag: '即将开放',
      },
    },
  ];

  const byId = Object.create(null);
  const optionById = Object.create(null);
  for (const m of MENUS) {
    byId[m.id] = m;
    for (const o of m.options || []) optionById[o.id] = { ...o, parent: m.id };
  }

  CW.menus = {
    items: MENUS,
    menu(id) { return byId[id] || null; },
    option(id) { return optionById[id] || null; },
    /** 默认落地页 */
    defaultRoute: { menu: 'play', option: 'play.local' },
  };
})((window.CW = window.CW || {}));
