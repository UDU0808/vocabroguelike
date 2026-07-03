# Boss 配置说明

- `bosses.json`：Boss 总清单（manifest），包含关卡间隔、出生点、各 Boss 独立 JSON 路径。
- `types/*.json`：每个 Boss 一个独立配置文件。
- 对应图片放在 `assets/bosses/types/<boss_id>/`，按 `idle/walk/attack/hurt + front/left/right/back` 拆分。

以后新增 Boss 时：
1. 新建 `assets/bosses/types/<boss_id>/` 素材。
2. 新建 `assets/config/bosses/types/<boss_id>.json`。
3. 在 `assets/config/bosses.json` 的 `bosses` 数组里登记即可。
