# 英雄动作模块规范 v70

英雄素材目录：

```text
assets/heroes/<heroId>/
```

固定动作文件名：

```text
idle.webp
walk.webp
attack.webp
dash.webp
hurt.webp
```

英雄属性和动作参数统一写在：

```text
assets/config/heroes.json
```

## 方向统一标准

所有英雄动作素材行顺序统一为：

```text
前、左、右、后
```

对应配置统一为：

```json
"rowByFacing": [0, 1, 2, 3]
```

不使用 `mirrorLeft` 或 `useMirrorLeft` 做方向纠正。

## 动作规格统一标准

| 动作 | 文件名 | 规格 |
|---|---|---|
| 待机 | `idle.webp` | 1 列 × 4 行 |
| 行走 | `walk.webp` | 4 列 × 4 行 |
| 攻击 | `attack.webp` | 2 列 × 4 行 |
| 闪现 | `dash.webp` | 1 列 × 4 行 |
| 受伤 | `hurt.webp` | 1 列 × 4 行 |

## 接入检查

- 每个动作文件必须存在。
- 图片高度必须能按 4 行切格。
- 图片宽度必须能按对应列数切格。
- `walk` 使用 `walkCols: [0,1,2,3]`。
- `attack` 使用 `frameCols: [0,1]`。
- 方向素材必须独立，不使用镜像纠正。
