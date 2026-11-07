卡面图片目录（默认）
=====================

编辑器「卡面图片路径」默认填「卡牌的短 id.png」：取卡牌 id 的标识段。
例如：

  default_unit_slime          → slime.png
  default_unit_slimefoam      → slimefoam.png
  study_unit_littleempire     → littleempire.png
  study_unit_empire           → empire.png

所以图片直接放在这里，文件名用短 id：

  assets/picture/cards/slime.png
  assets/picture/cards/littleempire.png
  assets/picture/cards/empire.png

也可以手动填路径（会覆盖默认短 id.png）：
  assets/banner/castorice.png
  ./assets/picture/cards/other.png
  https://example.com/card.png
  data:image/png;base64,...

规则（见 engine/editor.js 的 defaultCardImageName / cardImagePath / resolveCardImage / resolveImage）：
  · image 为空          → 默认「短 id.png」，从 assets/picture/cards/ 读取
  · image 为 null       → 强制使用内置占位卡面（「用占位图」按钮）
  · 只有文件名          → assets/picture/cards/<文件名>
  · 带目录的相对路径    → 按路径读取
  · / 开头的绝对路径    → 按路径读取
  · http(s) / data / blob URL → 原样使用
