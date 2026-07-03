# 英雄动作模块规范

每个英雄一个文件夹，统一放在：

```text
assets/heroes/<heroId>/
```

固定动作文件名：

```text
idle.png
walk.png
attack.png
dash.png
hurt.png
```

英雄属性和动作参数不再写死在 `game.js`，统一写在：

```text
assets/config/heroes.json
```

新增英雄时：

1. 新建 `assets/heroes/<heroId>/`
2. 放入 `idle.png / walk.png / attack.png / dash.png / hurt.png`
3. 在 `assets/config/heroes.json` 复制一个英雄配置块，改 `id/name/sub/role/动作参数/攻击参数`
4. 刷新网页即可加载，不需要改 `game.js`

方向约定：

```text
rowByFacing: [前, 左, 右, 后]
```

如果没有左方向素材，可以把左方向映射到右方向，并设置：

```json
"mirrorLeft": true
```


## v47 方向帧规则

当前英雄动作图统一按以下顺序读取：

```text
第1帧 / 第1行：向前
第2帧 / 第2行：向右
第3帧 / 第3行：向左
第4帧 / 第4行：向后
```

游戏内部方向顺序是：

```text
[前, 左, 右, 后]
```

所以 `heroes.json` 中每个动作的方向映射统一为：

```json
"rowByFacing": [0, 2, 1, 3]
```

`idle / walk / attack / dash / hurt` 都按这个逻辑触发。

默认不再使用 `mirrorLeft` 镜像左方向。左方向使用第3帧/第3行，右方向使用第2帧/第2行。
