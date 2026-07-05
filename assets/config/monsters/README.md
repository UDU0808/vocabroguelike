# 怪物配置说明

- `monsters.json`：怪物总清单（manifest），包含 AI 等级、变体列表、各怪物独立 JSON 路径。
- `types/*.json`：每个怪物一个独立配置文件。
- 对应图片放在 `assets/monsters/types/<monster_id>/`，按 `idle/walk/attack/dash/hurt.webp` 五张动作表保存。

以后新增怪物时：
1. 新建 `assets/monsters/types/<monster_id>/` 素材。
2. 新建 `assets/config/monsters/types/<monster_id>.json`。
3. 在 `assets/config/monsters.json` 的 `types` 和 `variants` 里登记即可。
