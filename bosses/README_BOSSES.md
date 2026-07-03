# Boss 资源模块规范

Boss 现在采用“总清单 + 单体配置 + 独立动作素材”的结构。

## 总清单

```text
assets/config/bosses.json
```

## 单体配置

```text
assets/config/bosses/types/<boss_id>.json
```

## 资源目录

```text
assets/bosses/types/<boss_id>/
```

## 动作规范

Boss 动作统一为：

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

Boss 的战斗参数也写在单体 JSON 的 `combat` 里：

```json
"combat": {
  "color": "#78d3ff",
  "attackColor": "#95f5ff",
  "baseStyle": "crystal",
  "specialStyle": "crystalRain",
  "basicCd": 1.25,
  "skillCd": 4.2,
  "skillName": "晶簇坠星"
}
```

以后新增 Boss，只要增加一个单体 JSON，并在 `assets/config/bosses.json` 登记即可。
