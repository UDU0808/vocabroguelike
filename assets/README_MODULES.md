# 资源模块说明（v22 精简版）

当前版本以 迷宫大地图玩法为核心，删除了旧版多地图背景、遮罩、障碍物贴图和未引用素材。

保留模块：
- `assets/heroes/`：角色动作图，已转为 WebP。
- `assets/monsters/`：怪物素材，已转为 WebP。
- `assets/bosses/`：Boss 素材，已转为 WebP。
- `assets/items/`：道具素材，已转为 WebP。
- `assets/audio/`：音效。
- `assets/levels/`：关卡布局 JSON，可继续编辑硬墙/砖墙。
- `wordbank.json`：词库，已压缩为单行 JSON，内容不删减。

已移除模块：
- 旧地图背景：`assets/maps/`
- 旧地图蒙版：`assets/masks/`
- 旧主题障碍素材：`assets/themes/`
- 未使用武器贴图：`assets/weapons/`
- 未被代码引用的重复 PNG 素材

后续建议：
如果继续缩小体积，可以再做“单角色版”，只保留一个角色素材，体积还能继续明显下降。
