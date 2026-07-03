# 怪物资源模块规范

怪物现在采用“总清单 + 单体配置 + 独立动作素材”的结构。

## 总清单

```text
assets/config/monsters.json
```

## 单体配置

```text
assets/config/monsters/types/<monster_id>.json
```

## 资源目录

```text
assets/monsters/types/<monster_id>/
```

## 动作规范

怪物动作统一为：

```text
idle / walk / attack / hurt
```

## 朝向规范

每个动作都按四方向拆分：

```text
front / left / right / back
```

## 多帧动作

`attack` 和 `hurt` 已经是多帧序列图：

```text
attack_front_sheet.webp  # 3帧
hurt_front_sheet.webp    # 2帧
```

配置示例：

```json
"attack": {
  "right": {
    "src": "assets/monsters/types/monster_00/attack_right_sheet.webp",
    "cols": 3,
    "rows": 1,
    "duration": 0.34
  }
}
```

以后替换怪物动作时，只要替换对应素材并改单体 JSON，不需要改 `game.js`。
