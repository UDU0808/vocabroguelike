# Boss 素材标准（v82 精简版）

当前版本已统一为 WebP 动作表，每个角色 5 张图：

```text
attack.webp  2列4行  前/左/右/后
dash.webp    1列4行  前/左/右/后
hurt.webp    1列4行  前/左/右/后
walk.webp    4列4行  前/左/右/后
idle.webp    1列4行  前/左/右/后
```

对应配置在 `assets/config/bosses/types/*.json`。
新增角色时，建议直接使用 WebP；如果你放 PNG，也要把配置里的 `src` 改成对应文件名。
