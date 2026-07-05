# 配置说明（v82 精简版）

Boss 和 monster 已统一成动作级配置，每个角色只登记 5 张动作表：

```text
idle.webp
walk.webp
attack.webp
dash.webp
hurt.webp
```

统一规格：

- attack：2列4行，行顺序 前、左、右、后
- dash：1列4行，行顺序 前、左、右、后
- hurt：1列4行，行顺序 前、左、右、后
- walk：4列4行，行顺序 前、左、右、后
- idle：1列4行，行顺序 前、左、右、后

新增 Boss：

1. 把素材放到 `assets/bosses/types/<id>/`。
2. 新建 `assets/config/bosses/types/<id>.json`。
3. 在 `assets/config/bosses.json` 的 `bosses` 数组登记。

新增 monster：

1. 把素材放到 `assets/monsters/types/<id>/`。
2. 新建 `assets/config/monsters/types/<id>.json`。
3. 在 `assets/config/monsters.json` 的 `types` 数组登记。
