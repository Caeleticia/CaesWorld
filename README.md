# Cae'sWorld · 每个人都能做卡牌

本轮只做**动态 UI**（载入页 + 主菜单 + 桌宠），不含任何玩法内容。

---
## 运行

不能直接双击 `index.html`（`file://` 下模型与字符库会被浏览器按 CORS 拦掉）。起一个静态服务器即可：

```bash
cd "Cae's World"
python3 -m http.server 8766 --bind 127.0.0.1
# 打开 http://127.0.0.1:8766/index.html
```

也可以用任意静态服务器（nginx / `npx serve` 等）。`index.html` 里声明了 `<base href="./">`，所以部署在子目录下也能正确解析 `js/ css/ data/ vendor/`。

## 界面

**载入页**
- 大标题 `Cae'sWorld` + 副标题「每个人都能做卡牌」（红笔手划下划线）
- 「你知道吗」纸条：从 `data/tips.txt` 逐行读取，定期换一条（同一会话不连续重复）
- 铅笔样式进度条：真实反映启动阶段（字符库 → 存档 → 组件 → 模型资源校验），不会空转
- 状态行显示当前在做什么（如「已载入 4 条你知道吗」）

**主菜单**
- 左侧栏：品牌、「你知道吗」（可点 ↻ 手动换一条）、5 个一级标签，每个标签带弹出式子选项
  - 游玩：同屏 / 肉鸽 / 无尽 / 挑战
  - 测试：训练场
  - 设计：编辑器
  - 模组：模组管理
  - 设置：设置
- 右侧：桌宠舞台 + 一张演示便签卡。演示卡明确写着「演示 · 无玩法」，选中模式只切换占位视图，不进入玩法。

**桌宠（Live2D）**
- 模型：`assets/live2d/hiyori_vts.zip` 解包到 `vendor/live2d/hiyori_vts/`
- 桌宠是个浮动小组件，可**拖到屏幕任意位置（位置会记住）**、**点一下**有反应（表情变化 + 气泡台词）、**双击**打开设置抽屉（重试 / 回到右下角 / 逗一下）
- 视线会跟随指针；空闲时会走神；自带呼吸、眨眼、物理

## 目录

```
index.html            入口（载入页 + 主菜单骨架）
css/theme.css         色板（#FCF3E8）、方格纸纹、纸张质感、通用动效
css/loading.css       载入页
css/menu.css          侧栏 + 演示卡
css/pet.css           桌宠、气泡、设置抽屉、降级替身
js/utils.js           DOM/工具、WebGL 能力探测、路径解析
js/storage.js         localStorage 封装（含内存回退）
js/tips.js            字符库读取
js/menus.js           菜单结构（纯数据）
js/icons.js           手绘风线性图标
js/live2d.js          桌宠引擎（纯逻辑）+ Live2D 渲染层
js/pet.js             桌宠交互层（拖动/戳/双击/气泡）
js/app.js             启动流程与界面编排
js/dev-preview.js     仅调试用：`?preview=loading&freeze=1` 冻结载入页
tests/engine.test.js  桌宠引擎单测（Node，无需浏览器）
vendor/live2d/        Cubism Core + pixi-live2d-display + hiyori 模型
vendor/pixi/          pixi v6 的 ESM 分片 + 第三方依赖（eventemitter3 / earcut / url 垫片）
data/tips.txt         你知道吗字符库
```

## 测试

```bash
node tests/engine.test.js
```

覆盖：视线跟随方向、被戳反应、空闲走神、眨眼 0..1、400 次随机交互后参数值域、帧率无关性。桌宠逻辑与渲染解耦（`js/live2d.js` 里的 `PetEngine`），所以没有 GPU 也能完整验证。

## 显存不足 / 渲染失败时会发生什么

模型是否渲染成功**不影响界面与逻辑**。任何一步失败都会走同一条降级路径：

1. 能力预检（`probeWebGL`）：无 WebGL、`MAX_TEXTURE_SIZE < 2048`、或 **`getProgramParameter` 缺失**（着色器管线不可用）→ 直接判定
2. 资源预检：逐个确认 `moc3 / 贴图 / physics` 可访问
3. 依赖加载：默认用 `vendor/` 本地副本，失败再试 CDN（`?libs=cdn` 可反过来）
4. 首帧可视性自检：模型加载完成后回读画布像素，若连续 3 次全空 → 判定「GPU 未产出任何像素」
5. 运行期：WebGL 上下文丢失事件 → 降级

降级后：桌宠位置变成一个手绘替身（呼吸、眨眼都与 CSS 同步），拖动 / 戳 / 双击设置全部照常，状态行显示具体原因，演示卡底部补一行说明。**不会黑屏，也不会卡在载入页。**

> 当前这台测试机（Adreno 830，WebGL 内核 `getProgramParameter` 不可用）就命中第 5 条：模型与纹理都已正确加载、`Live2DModel` 逐帧渲染无异常，但 GPU 不产出像素，界面按设计降级。换一台 WebGL 管线正常的设备即可看到 hiyori。

## 调试开关

| 参数 | 作用 |
| --- | --- |
| `?preview=loading&freeze=1` | 冻结在载入页（只看视觉） |
| `?debug=title` | 把桌宠状态写进页面标题，便于远程观察 |
| `?libs=cdn` | 优先从 CDN 加载 pixi 依赖 |
| `?renderer=webgl1` / `webgl2` | 强制渲染后端（默认 WebGL2 优先，回落 WebGL1） |
| `?poke=1&at=3000` | 进入后自动戳一下桌宠 |
