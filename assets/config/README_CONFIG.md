# 全配置驱动说明

当前项目已将核心内容拆成配置文件，`game.js` 主要负责运行逻辑。

## 总配置入口

```text
assets/config/heroes.json
assets/config/monsters.json
assets/config/bosses.json
assets/config/items.json
assets/config/levels.json
```

## 英雄

```text
assets/config/heroes.json
assets/heroes/<heroId>/
  idle.png
  walk.png
  attack.png
  dash.png
  hurt.png
```

英雄动作统一为：

```text
idle / walk / attack / dash / hurt
```

## 怪物

怪物总清单：

```text
assets/config/monsters.json
```

每个怪物独立配置：

```text
assets/config/monsters/types/<monster_id>.json
```

每个怪物独立素材：

```text
assets/monsters/types/<monster_id>/
  idle_front.webp
  idle_left.webp
  idle_right.webp
  idle_back.webp
  walk_front.webp
  walk_left.webp
  walk_right.webp
  walk_back.webp
  attack_front_sheet.webp
  attack_left_sheet.webp
  attack_right_sheet.webp
  attack_back_sheet.webp
  hurt_front_sheet.webp
  hurt_left_sheet.webp
  hurt_right_sheet.webp
  hurt_back_sheet.webp
```

怪物动作统一为：

```text
idle / walk / attack / hurt
```

朝向统一为：

```text
front / left / right / back
```

其中 `attack` 和 `hurt` 已支持多帧序列图，配置内用：

```json
{
  "src": "assets/monsters/types/monster_00/attack_right_sheet.webp",
  "cols": 3,
  "rows": 1,
  "duration": 0.34
}
```

## Boss

Boss 总清单：

```text
assets/config/bosses.json
```

每个 Boss 独立配置：

```text
assets/config/bosses/types/<boss_id>.json
```

每个 Boss 独立素材：

```text
assets/bosses/types/<boss_id>/
```

Boss 动作统一为：

```text
idle / walk / attack / hurt
```

朝向统一为：

```text
front / left / right / back
```

## 道具

道具配置：

```text
assets/config/items.json
```

可配置：

- 道具标题
- 图标索引
- 颜色
- 是否正面道具
- 每关直接显示道具数量
- 每关藏在砖块里的道具数量
- 随机池排除项

## 关卡

关卡配置：

```text
assets/config/levels.json
```

可配置：

- 倒计时时间
- 地图格子尺寸
- 默认地图布局 JSON
- Boss 间隔关卡数
