(() => {
  let W = 1280;
  let H = 720;
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const loading = document.getElementById("loading");
  const loadingTitleEl = loading?.querySelector(".loading-title");
  const loadingBarFillEl = loading?.querySelector(".loading-bar-fill");
  const loadingMetaEl = loading?.querySelector(".loading-meta");

  /*
   * ========================
   * ① 版本号与资源路径区
   * ========================
   *
   * 这一块是“缓存与资源路径”的总开关，平时你最常改的是 ASSET_VERSION。
   *
   * 【自己可以改】
   * - ASSET_VERSION：每次正式改完代码、配置、素材后，建议改成一个新版本号。
   *   例如：20260704-v76-my-change。
   *   作用：让 index.html、game.js、sw.js、图片、JSON 后面都带上 ?v=版本号，
   *   浏览器和 Service Worker 才不会继续用旧缓存。
   *
   * 【一般不建议改】
   * - SCRIPT_BASE、assetUrl：它们负责把 assets/xxx 自动转换成正确网址。
   *   这样游戏放在 GitHub Pages 子目录、本地服务目录里，素材路径都不容易跑偏。
   * - FORCE_REFRESH、DEV_CACHE_BUSTER：这是调试用的强制刷新功能。
   *   你访问 index.html?dev=1 或 index.html?nocache=1 时，会临时绕过固定缓存，方便排查素材是否真的更新。
   */
  const SCRIPT_BASE = new URL("./", document.currentScript?.src || window.location.href);
  const ASSET_VERSION = "20260708-v171-boss-top-center";

  // 正式访问只用固定版本号，方便 service worker 和浏览器缓存，第二次打开更快。
  // 本地调素材需要强制刷新时，在网址后加 ?dev=1 或 ?nocache=1。
  const FORCE_REFRESH = /(?:^|[?&])(dev|nocache)=1(?:&|$)/.test(window.location.search);
  const DEV_CACHE_BUSTER = FORCE_REFRESH ? Date.now().toString(36) : "";

  /*
   * ========================
   * 实时加载进度
   * ========================
   *
   * 旧版加载条是固定动画，只能表示“正在等”，不能表示真实资源进度。
   * 现在所有进入游戏前必须等待的 JSON / 图片资源，都会按实际完成数量推进：
   * - total：本轮需要处理的资源数；
   * - done：已经完成的资源数；
   * - failed：失败后使用兜底的资源数。
   */
  let runtimeGame = null;

  const loadProgress = {
    active: true,
    title: "正在加载...",
    stage: "准备资源",
    done: 0,
    total: 0,
    failed: 0,
    percent: 0
  };

  function clampProgress(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
  }

  function syncLoadingMessage() {
    const pct = Math.round(clampProgress(loadProgress.percent) * 100);
    const title = loadProgress.title || "正在加载...";
    const stage = loadProgress.stage || "准备资源";
    const total = Math.max(0, loadProgress.total | 0);
    const done = Math.max(0, Math.min(loadProgress.done | 0, total || loadProgress.done | 0));
    const failedText = loadProgress.failed ? ` · 失败${loadProgress.failed}项已兜底` : "";

    if (loadingTitleEl) loadingTitleEl.textContent = title;
    if (loadingBarFillEl) loadingBarFillEl.style.width = `${pct}%`;
    if (loadingMetaEl) loadingMetaEl.textContent = total ? `${stage} · ${pct}% · ${done}/${total}${failedText}` : `${stage} · 0%`;
    if (loading) {
      loading.style.setProperty("--loading-progress", `${pct}%`);
      loading.setAttribute("aria-label", `${title}，${stage}，${pct}%`);
    }

    if (runtimeGame && runtimeGame.mode === "loading") {
      runtimeGame.message = total ? `${title} ${pct}%（${done}/${total}）` : title;
    }
  }

  function beginLoadProgress(title = "正在加载...", stage = "准备资源") {
    loadProgress.active = true;
    loadProgress.title = title;
    loadProgress.stage = stage;
    loadProgress.done = 0;
    loadProgress.total = 0;
    loadProgress.failed = 0;
    loadProgress.percent = 0;
    if (loading) loading.style.display = "";
    syncLoadingMessage();
  }

  function setLoadStage(stage) {
    if (stage) loadProgress.stage = stage;
    syncLoadingMessage();
  }

  function addLoadWork(count = 1, stage = "") {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    if (!n) return;
    loadProgress.total += n;
    if (stage) loadProgress.stage = stage;
    loadProgress.percent = loadProgress.total ? loadProgress.done / loadProgress.total : 0;
    syncLoadingMessage();
  }

  function finishLoadWork(stage = "", failed = false) {
    if (stage) loadProgress.stage = stage;
    loadProgress.done = Math.min(loadProgress.total || loadProgress.done + 1, loadProgress.done + 1);
    if (failed) loadProgress.failed += 1;
    loadProgress.percent = loadProgress.total ? loadProgress.done / loadProgress.total : 1;
    syncLoadingMessage();
  }

  function finishLoadProgress(stage = "加载完成") {
    if (stage) loadProgress.stage = stage;
    if (loadProgress.total > 0) loadProgress.done = loadProgress.total;
    loadProgress.percent = 1;
    syncLoadingMessage();
  }

  // 所有资源路径都必须经过 assetUrl()，不要在代码里直接写 fetch("assets/xxx.json") 或 img.src="assets/xxx.webp"。
  // 这样才能统一追加版本号，避免“我明明改了代码/图片，浏览器还是旧效果”。
  const assetUrl = path => {
    const url = new URL(String(path).replace(/^\.?\//, ""), SCRIPT_BASE);
    url.searchParams.set("v", ASSET_VERSION);
    if (DEV_CACHE_BUSTER) url.searchParams.set("dev", DEV_CACHE_BUSTER);
    return url.href;
  };

  /*
   * ========================
   * ② 全局资源入口表 ASSETS
   * ========================
   *
   * 这里集中保存“主配置文件”和“首屏必须资源”的路径。
   *
   * 【自己可以改】
   * - menuBg：菜单首屏背景图。换菜单背景时，优先改这里或改 assets/config/items.json / 相关配置。
   * - items：道具/子弹/箱子图集路径。
   * - sounds：音效路径。替换音效文件时，保持 key 不变，只改文件即可。
   *
   * 【更推荐通过 JSON 改】
   * - 英雄：assets/config/heroes.json
   * - 怪物：assets/config/monsters.json 以及 assets/config/monsters/types/*.json
   * - Boss：assets/config/bosses.json 以及 assets/config/bosses/types/*.json
   * - 道具：assets/config/items.json
   * - 关卡：assets/config/levels.json 和 assets/levels/maze_layout.json
   * - 词库：assets/config/words.json 指向的词库分包
   *
   * 注意：ASSETS 里的路径都经过 assetUrl()，会自动追加版本号。
   */
  const ASSETS = {
    heroConfig: assetUrl("assets/config/heroes.json"),
    monsterConfig: assetUrl("assets/config/monsters.json"),
    bossConfig: assetUrl("assets/config/bosses.json"),
    itemConfig: assetUrl("assets/config/items.json"),
    levelConfig: assetUrl("assets/config/levels.json"),
    wordConfig: assetUrl("assets/config/words.json"),
    menuBg: assetUrl("assets/ui/menu_bg_image2.webp"),
    // 怪物/Boss 默认强制走 types 目录，common 只作为旧版备份，不自动加载。
    monsters: null,
    monstersWalk: null,
    bosses: null,
    bossesWalk: null,
    items: assetUrl("assets/items/items_projectiles_chests.webp"),
    levelBomberConfig: assetUrl("assets/levels/maze_layout.json"),
    backgrounds: [],
    sounds: {
      fire: assetUrl("assets/audio/fire.wav"),
      pickup: assetUrl("assets/audio/pickup.wav"),
      hit: assetUrl("assets/audio/hit_correct.wav"),
      wrong: assetUrl("assets/audio/wrong.wav"),
      dash: assetUrl("assets/audio/dash.wav"),
      reward: assetUrl("assets/audio/reward.wav"),
      clear: assetUrl("assets/audio/room_clear.wav"),
      hurt: assetUrl("assets/audio/hurt.wav"),
      footstep: assetUrl("assets/audio/footstep.wav")
    }
  };

  // 音效默认音量。脚步声单独恢复为更接近原素材的音量，避免格子移动后听感过轻。
  const SOUND_VOLUMES = {
    footstep: 0.72
  };

  /*
   * ========================
   * ③ 配置读取后的运行时数据
   * ========================
   *
   * 这些变量不是手动写死内容，而是从 JSON 配置读取后生成的运行时数据。
   *
   * 【自己一般不要直接改这里】
   * - HEROES、MONSTER_TYPES、BOSS_TYPES、WORD_CHUNKS 都会在 loadExternalConfigs() 里从 JSON 重新生成。
   * - 想新增英雄/怪物/Boss/词库，请改 assets/config 里的 JSON，不要在这里硬塞。
   *
   * 【本次性能优化重点】
   * - loadingImages：记录“正在加载中的图片”，防止同一张图被重复请求。
   * - requestedHeroPreviews：记录已经排队加载过预览图的英雄，防止菜单每一帧都重复排队。
   * - heroPreviewQueue：英雄预览懒加载队列。菜单里头像很多时，不一次性全部请求。
   * - heroPreviewQueueRunning：队列是否正在工作，避免同时开多个预览加载循环。
   */
  let MONSTER_VARIANTS = ["monster_00", "monster_01", "monster_02", "monster_03", "monster_04", "monster_05", "monster_06", "monster_07"];
  let MONSTER_TYPES = [];

  /*
   * 怪物等级顺序。
   *
   * 这里不是怪物出现顺序，而是“等级强弱顺序”：
   * - E 最低级，前期大量出现。
   * - A 最高级，后期主要出现。
   *
   * 后期你如果想扩展 S / SS 等级，可以在 monsters.json 里新增 aiClasses，
   * 然后同步把等级写进 gradeSpawnRules 和怪物子配置 grade 字段。
   * 代码会按 grade 字段自动归类，不需要再给单个怪物写特殊逻辑。
   */
  const MONSTER_GRADE_ORDER = ["E", "D", "C", "B", "A"];

  // 怪物等级颜色：只用于怪物头顶小标签，方便玩家一眼区分危险程度。
  const MONSTER_GRADE_COLORS = {
    A: "#ff6f7d",
    B: "#ffb35c",
    C: "#fff096",
    D: "#8ef3ff",
    E: "#b4ffb8"
  };

  /*
   * 默认关卡怪物数量表。
   *
   * 规则解释：
   * - 当前关卡 room 落在哪个区间，就按该区间 counts 生成怪物。
   * - counts 里的 key 是等级，value 是数量。
   * - 越往后，E / D 这种低级怪会自然消失。
   * - 这套默认值会被 assets/config/monsters.json 里的 gradeSpawnRules 覆盖。
   *
   * 你以后想调难度，优先改 monsters.json，不要直接改这里。
   */
  let MONSTER_GRADE_SPAWN_RULES = [
    { fromRoom: 1, toRoom: 2, counts: { E: 3, D: 1 } },
    { fromRoom: 3, toRoom: 4, counts: { E: 2, D: 2, C: 1 } },
    { fromRoom: 5, toRoom: 7, counts: { D: 2, C: 2, B: 1 } },
    { fromRoom: 8, toRoom: 10, counts: { C: 2, B: 2, A: 1 } },
    { fromRoom: 11, toRoom: 14, counts: { B: 2, A: 3 } },
    { fromRoom: 15, counts: { B: 1, A: 5 } }
  ];

  let BOSS_TYPES = [];
  let HEROES = [];
  let WORD_CHUNKS = [];
  const loadedWordChunks = new Set();
  const loadingImages = new Map();
  const requestedHeroPreviews = new Set();
  const heroPreviewQueue = [];
  let heroPreviewQueueRunning = false;

  const FALLBACK_HERO_ID = "swordsman";
  const ACTION_KEYS = ["idle", "walk", "attack", "dash", "hurt"];

  // 图片加载并发数。手机或本地小服务器容易被大量请求打满，所以不要设太大。
  // 【自己可以小范围改】电脑本地可试 6；手机建议 3~4；如果图片加载卡顿，就降到 2。
  const IMAGE_LOAD_CONCURRENCY = 4;

  // 菜单英雄头像/预览图分批懒加载间隔，单位毫秒。
  // 【自己可以改】数值越大，请求越慢但越稳；数值越小，预览出现越快但请求压力更大。
  const HERO_PREVIEW_BATCH_DELAY = 140;

  // 英雄方向标准：0前、1左、2右、3后。默认按 [前, 左, 右, 后] 读取。
  // 如果某张英雄图的行顺序不同，只需要在 heroes.json 的 sheet.rowByFacing 或 actions.xxx.rowByFacing 里改。
  const HERO_ROW_BY_FACING = [0, 1, 2, 3];

  // 英雄动作默认规格。这里只是“没写配置时的兜底”，不再强制所有英雄必须同规格。
  // 新增英雄优先改 assets/config/heroes.json：
  // - 五张分动作图：每个 action 自己写 src / cols / frameCols。
  // - 一张完整动作表：写 hero.sheet.src / sheet.cols，再给每个 action 写 frameCols 或 walkCols。
  // 支持 12 列、11 列、8 列等任意等宽切片，只要 JSON 的 cols 和列号写对即可。
  const HERO_ACTION_DEFAULTS = {
    idle: { cols: 1, rows: 4, frameCols: [0], idleFps: 4, frameHeight: 96 },
    walk: { cols: 4, rows: 4, walkCols: [0, 1, 2, 3], idleCol: 0, walkFps: 7, frameHeight: 96 },
    attack: { cols: 2, rows: 4, frameCols: [0, 1], duration: 0.34, frameHeight: 96 },
    dash: { cols: 1, rows: 4, frameCols: [0], duration: 0.28, frameHeight: 96 },
    hurt: { cols: 1, rows: 4, frameCols: [0], duration: 0.38, frameHeight: 96 }
  };

  function shortHash(text) {
    let hash = 2166136261;
    const str = String(text || "");
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function heroImageKey(id, rawSrc) {
    // 同一张完整动作表会被 idle/walk/attack/dash/hurt 共用。
    // 用 src 生成 key，可以避免同一图片被加载 5 次。
    return `hero_${id}_${shortHash(rawSrc)}`;
  }
  const DIRECTION_KEYS = ["front", "left", "right", "back"];
  const ENTITY_ROW_BY_FACING = [0, 1, 2, 3];
  const ENTITY_ACTION_STANDARDS = {
    idle: { cols: 1, rows: 4, frameCols: [0], duration: 0.25 },
    walk: { cols: 4, rows: 4, frameCols: [0, 1, 2, 3], walkFps: 7, duration: 0.5 },
    attack: { cols: 2, rows: 4, frameCols: [0, 1], duration: 0.34 },
    dash: { cols: 1, rows: 4, frameCols: [0], duration: 0.28 },
    hurt: { cols: 1, rows: 4, frameCols: [0], duration: 0.38 }
  };

  function facingKey(facing = 0) {
    return DIRECTION_KEYS[Math.max(0, Math.min(3, facing | 0))] || "front";
  }

  function entitySpriteKey(group, id, action, facing) {
    return `${group}_${id}_${action}_${facing}`;
  }

  function entityActionDefaultSrc(group, id, action) {
    const base = group === "boss" ? "assets/bosses/types" : "assets/monsters/types";
    return `${base}/${id}/${action}.webp`;
  }

  function compactEntityActionDef(actionCfg) {
    if (!actionCfg) return false;
    if (typeof actionCfg === "string") return true;
    if (typeof actionCfg !== "object") return false;
    return Boolean(actionCfg.src || actionCfg.file || actionCfg.path) && !DIRECTION_KEYS.some(dir => Object.prototype.hasOwnProperty.call(actionCfg, dir));
  }

  function entitySpriteKeyFor(group, id, action, dir, compact) {
    return compact ? `${group}_${id}_${action}` : entitySpriteKey(group, id, action, dir);
  }

  function normalizeEntityActionSprite(group, cfg, action, dir, actionCfg, raw, compact) {
    const standard = ENTITY_ACTION_STANDARDS[action] || ENTITY_ACTION_STANDARDS.idle;
    const dirIndex = DIRECTION_KEYS.indexOf(dir);
    const source = raw ?? actionCfg;
    if (!source) return null;

    const rel = typeof source === "string" ? source : (source.src || source.file || source.path || null);
    if (!rel) return null;

    const rowByFacing = Array.isArray(source.rowByFacing) ? source.rowByFacing
      : Array.isArray(actionCfg?.rowByFacing) ? actionCfg.rowByFacing
      : ENTITY_ROW_BY_FACING;
    const row = compact ? clamp(Number(rowByFacing[dirIndex] ?? dirIndex), 0, Math.max(0, Number(source.rows || standard.rows || 4) - 1)) : Number(source.row || 0);

    return {
      key: entitySpriteKeyFor(group, cfg.id, action, dir, compact),
      src: assetUrl(rel),
      cols: Number(source.cols || standard.cols || 1),
      rows: Number(source.rows || (compact ? standard.rows : 1) || 1),
      row,
      frameCols: Array.isArray(source.frameCols) ? source.frameCols.slice() : (standard.frameCols ? standard.frameCols.slice() : null),
      duration: Number(source.duration || standard.duration || (action === "attack" ? 0.34 : action === "hurt" ? 0.38 : 0.25)),
      walkFps: Number(source.walkFps || standard.walkFps || 7)
    };
  }

  function normalizeDirectionalActions(group, cfg, fallbackSize = { w: 96, h: 96, shadowW: 28, shadowH: 10 }) {
    const actions = {};
    for (const action of ACTION_KEYS) {
      actions[action] = {};
      const actionCfg = cfg.actions?.[action] || null;
      const idleCfg = cfg.actions?.idle || null;
      const compact = compactEntityActionDef(actionCfg);
      const compactIdle = compactEntityActionDef(idleCfg);

      for (const dir of DIRECTION_KEYS) {
        let raw = null;
        let useCfg = actionCfg;
        let useCompact = compact;

        if (compact) raw = actionCfg;
        else raw = actionCfg?.[dir] || null;

        if (!raw) {
          useCfg = idleCfg;
          useCompact = compactIdle;
          raw = compactIdle ? idleCfg : idleCfg?.[dir] || null;
        }

        actions[action][dir] = normalizeEntityActionSprite(group, cfg, action, dir, useCfg, raw, useCompact);
      }
    }
    return {
      id: cfg.id,
      name: cfg.name || cfg.id,
      kindIndex: Number.isFinite(Number(cfg.kindIndex)) ? Number(cfg.kindIndex) : 0,
      render: { ...fallbackSize, ...(cfg.render || {}) },
      actions
    };
  }

  function normalizeMonsterGrade(grade, fallback = "E") {
    const value = String(grade || fallback || "E").trim().toUpperCase();
    return value || "E";
  }

  function makeMonsterType(cfg) {
    const base = normalizeDirectionalActions("monster", cfg, { w: 94, h: 94, shadowW: 28, shadowH: 10 });

    /*
     * v78：怪物“外观类型”和“等级”正式绑定。
     *
     * 以前 monster_00~monster_07 只是外观，A/B/C/D/E 是按房间和序号轮流套上去。
     * 现在每个怪物子配置自己声明 grade：
     * - monster_00 写 grade: "E"，它就永远是 E 类。
     * - monster_06 写 grade: "B"，它就永远是 B 类。
     * - 以后新增 monster_08，只要在 JSON 里写 grade，就会自动进入对应等级池。
     */
    base.grade = normalizeMonsterGrade(cfg.grade || cfg.aiClass || cfg.tier || "E");
    base.title = cfg.title || cfg.name || cfg.id;
    base.description = cfg.description || "";
    base.combat = { ...(cfg.combat || {}) };
    return base;
  }

  function makeBossType(cfg) {
    const base = normalizeDirectionalActions("boss", cfg, { w: 206, h: 206, shadowW: 78, shadowH: 21 });

    /*
     * v79：Boss 支持从配置读取更多战斗参数。
     *
     * 新增 Boss 时主要改 assets/config/bosses/types/*.json：
     * - actions：四方向 idle / walk / attack / hurt 素材路径。
     * - combat.hpBase：Boss 基础血量。
     * - combat.hpGrowthPerRoom：每关血量成长。
     * - combat.radius：Boss 命中半径。
     *
     * 这样可以继续保持“Boss 才有血量”的规则，普通怪仍然是一发正确翻译击败。
     */
    base.info = {
      name: cfg.name || cfg.id,
      ...(cfg.combat || {})
    };
    return base;
  }

  function getMonsterTypeById(id) {
    return MONSTER_TYPES.find(type => type.id === id) || null;
  }

  function getBossTypeById(id) {
    return BOSS_TYPES.find(type => type.id === id) || null;
  }


  function toPositiveInt(value, fallback = 1) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  }

  function numberOr(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function indexList(value, fallback, cols) {
    const max = Math.max(1, toPositiveInt(cols, 1));
    const source = Array.isArray(value) && value.length ? value : fallback;
    const list = (Array.isArray(source) ? source : [])
      .map(v => Math.floor(Number(v)))
      .filter(v => Number.isFinite(v))
      .map(v => clamp(v, 0, max - 1));
    return list.length ? list : [0];
  }

  function normalizeRowByFacing(value, rows) {
    const maxRow = Math.max(1, toPositiveInt(rows, 4)) - 1;
    const source = Array.isArray(value) && value.length ? value : HERO_ROW_BY_FACING;
    const result = HERO_ROW_BY_FACING.map((fallback, index) => {
      const row = Math.floor(Number(source[index] ?? fallback));
      return clamp(Number.isFinite(row) ? row : fallback, 0, maxRow);
    });
    return result;
  }

  function heroActionRawConfig(heroCfg, action) {
    const actionCfg = heroCfg.actions?.[action];
    if (typeof actionCfg === "string") return { src: actionCfg };
    return actionCfg && typeof actionCfg === "object" ? actionCfg : {};
  }

  /*
   * 英雄动作配置标准化。
   *
   * v139 重点：不再把英雄强制写死成 idle 1列、walk 4列、attack 2列。
   * 现在游戏完全尊重 heroes.json 里的切片规格：
   * - cols / rows：这张图实际有几列几行。
   * - frameCols：当前动作播放哪些列。
   * - walkCols：行走循环播放哪些列。
   * - sheet：一张完整动作表的公共配置，可让 5 个动作共用同一张图。
   *
   * 以后做 11 列英雄，不需要再改 game.js，只改 heroes.json 的 sheet.cols 和列号。
   */
  function normalizeHeroActionConfig(heroCfg, action) {
    const id = heroCfg.id;
    const sheet = heroCfg.sheet && typeof heroCfg.sheet === "object" ? heroCfg.sheet : {};
    const actionCfg = heroActionRawConfig(heroCfg, action);
    const defaults = HERO_ACTION_DEFAULTS[action] || HERO_ACTION_DEFAULTS.idle;

    const rawSrc = actionCfg.src || actionCfg.file || actionCfg.path || sheet.src || `assets/heroes/${id}/${action}.webp`;
    const cols = toPositiveInt(actionCfg.cols ?? sheet.cols ?? defaults.cols, defaults.cols || 1);
    const rows = toPositiveInt(actionCfg.rows ?? sheet.rows ?? defaults.rows, defaults.rows || 4);

    const cfg = {
      imageKey: heroImageKey(id, rawSrc),
      src: assetUrl(rawSrc),
      rawSrc,
      cols,
      rows,
      rowByFacing: normalizeRowByFacing(actionCfg.rowByFacing || sheet.rowByFacing, rows),
      frameHeight: numberOr(actionCfg.frameHeight ?? sheet.frameHeight, defaults.frameHeight || 96),
      previewCol: numberOr(actionCfg.previewCol ?? sheet.previewCol, null),
      previewRow: numberOr(actionCfg.previewRow ?? sheet.previewRow, null)
    };

    if (action === "walk") {
      cfg.walkCols = indexList(actionCfg.walkCols || actionCfg.frameCols, defaults.walkCols, cols);
      cfg.idleCol = clamp(Math.floor(numberOr(actionCfg.idleCol ?? sheet.idleCol, defaults.idleCol ?? cfg.walkCols[0] ?? 0)), 0, cols - 1);
      cfg.walkFps = numberOr(actionCfg.walkFps ?? actionCfg.fps ?? sheet.walkFps, defaults.walkFps || 7);
    } else {
      cfg.frameCols = indexList(actionCfg.frameCols, defaults.frameCols, cols);
      if (action === "idle") cfg.idleFps = numberOr(actionCfg.idleFps ?? actionCfg.fps ?? sheet.idleFps, defaults.idleFps || 4);
    }

    if (actionCfg.duration || defaults.duration) cfg.duration = numberOr(actionCfg.duration, defaults.duration);
    return cfg;
  }

  /*
   * 把 heroes.json 里的一条英雄原始配置，转换成游戏内部英雄对象。
   *
   * 【你日常新增/修改英雄时，主要改 heroes.json】
   * - id：英雄文件夹名，必须和 assets/heroes/xxx 对上。
   * - name/sub/role：菜单显示文字。
   * - tint：兜底颜色、部分特效颜色。
   * - attackType：攻击类型。不要随意发明新类型，除非核心逻辑也支持。
   * - projectileColor / projectileRadius / projectileSpeed / damage：子弹颜色、半径、速度、伤害。
   * - attack：菜单显示的攻击描述。
   *
   * 【加载优化说明】
   * - imageKey 和 src 默认指向 idle.webp。
   * - 菜单预览只需要 idle，完整动作进入游戏时才由 ensureHeroImages() 加载。
   */
  function makeHero(cfg) {
    const actions = {};
    for (const action of ACTION_KEYS) {
      actions[action] = normalizeHeroActionConfig(cfg, action);
    }
    return {
      id: cfg.id,
      name: cfg.name || cfg.id,
      sub: cfg.sub || "",
      role: cfg.role || "英雄",
      imageKey: actions.idle.imageKey,
      imageMode: cfg.imageMode,
      src: actions.idle.src,
      actions,
      tint: cfg.tint || "#9fb8ff",
      attackType: cfg.attackType || "orb",
      projectileColor: cfg.projectileColor || cfg.tint || "#fff2a0",
      projectileRadius: cfg.projectileRadius || 10,
      projectileSpeed: cfg.projectileSpeed || 560,
      damage: cfg.damage || 60,
      attack: cfg.attack || "普通攻击"
    };
  }

  /*
   * 读取 JSON 配置的统一入口。
   *
   * 本次整改点：给 JSON 请求加“短重试”。
   * - 最多请求 3 次。
   * - 第 1 次失败后等约 180ms。
   * - 第 2 次失败后等约 440ms。
   * - 第 3 次还失败，就返回 fallback 兜底值。
   *
   * 为什么要这样？
   * - 本地服务、手机浏览器、GitHub Pages 偶尔会有瞬间读取失败。
   * - 如果没有重试，游戏可能因为一个 JSON 闪断而直接打不开。
   *
   * 【自己可以改】
   * - attempt < 3：可以改重试次数。一般 3 次够用，不建议太多。
   * - 180 + attempt * 260：可以改每次重试等待时间。
   *
   * 【不建议改】
   * - cache: "no-cache"：配置文件要尽量读到新版，避免旧 JSON 造成误判。
   */
  async function fetchJsonConfig(src, fallback, progressLabel = "") {
    const tracked = Boolean(progressLabel);
    if (tracked) addLoadWork(1, progressLabel);

    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = await fetch(src, { cache: "no-cache" });
        if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
        const data = await resp.json();
        if (tracked) finishLoadWork(progressLabel);
        return data;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 180 + attempt * 260));
      }
    }
    console.warn("配置读取失败，使用内置兜底：", src, lastError);
    if (tracked) finishLoadWork(`${progressLabel}失败，使用兜底`, true);
    return fallback;
  }

  /*
   * 读取所有外部配置。
   *
   * 执行顺序大致是：
   * 1. 英雄主配置 heroes.json。
   * 2. 怪物主配置 monsters.json，再按 types 列表逐个读取怪物子配置。
   * 3. Boss 主配置 bosses.json，再按 bosses 列表逐个读取 Boss 子配置。
   * 4. 道具、关卡、词库入口配置。
   * 5. 读取本地保存的上次选中英雄。
   *
   * 本次整改点：怪物/Boss 子配置是 for...of + await 串行读取。
   * - 不使用 Promise.all 一次性并发打满请求。
   * - 手机端和本地服务更稳。
   * - 哪个子配置失败，也更容易从控制台看出具体路径。
   */
  async function loadExternalConfigs() {
    // 英雄配置：只读取 JSON，不加载英雄完整动作图片。真正图片加载在 boot()/startGame() 里分阶段处理。
    const heroConfig = await fetchJsonConfig(ASSETS.heroConfig, { heroes: [] }, "英雄主配置");
    HEROES = (heroConfig.heroes || []).map(makeHero).filter(hero => hero.id);
    if (!HEROES.length) {
      HEROES = [makeHero({
        id: FALLBACK_HERO_ID,
        name: "剑士",
        sub: "黑发骑士",
        role: "战士",
        tint: "#4da3ff",
        attackType: "slash",
        projectileColor: "#8fd9ff",
        projectileRadius: 12,
        projectileSpeed: 560,
        damage: 76,
        attack: "剑气斩击",
        actions: {
          idle: { src: "assets/heroes/swordsman/hero_01_swordsman_full_sheet_transparent.webp", cols: 12, rows: 4, rowByFacing: [0, 1, 2, 3], frameCols: [0, 1, 2, 3], idleFps: 4, frameHeight: 96 },
          walk: { src: "assets/heroes/swordsman/hero_01_swordsman_full_sheet_transparent.webp", cols: 12, rows: 4, rowByFacing: [0, 1, 2, 3], walkCols: [4, 5, 6, 7], idleCol: 0, walkFps: 7, frameHeight: 96 },
          attack: { src: "assets/heroes/swordsman/hero_01_swordsman_full_sheet_transparent.webp", cols: 12, rows: 4, rowByFacing: [0, 1, 2, 3], frameCols: [8, 9], duration: 0.34, frameHeight: 96 },
          dash: { src: "assets/heroes/swordsman/hero_01_swordsman_full_sheet_transparent.webp", cols: 12, rows: 4, rowByFacing: [0, 1, 2, 3], frameCols: [10], duration: 0.28, frameHeight: 96 },
          hurt: { src: "assets/heroes/swordsman/hero_01_swordsman_full_sheet_transparent.webp", cols: 12, rows: 4, rowByFacing: [0, 1, 2, 3], frameCols: [11], duration: 0.38, frameHeight: 96 }
        }
      })];
      }

    const monsterConfig = await fetchJsonConfig(ASSETS.monsterConfig, {}, "怪物主配置");
    if (Array.isArray(monsterConfig.aiClasses)) MONSTER_AI_CLASSES = monsterConfig.aiClasses;
    if (Array.isArray(monsterConfig.gradeSpawnRules)) MONSTER_GRADE_SPAWN_RULES = monsterConfig.gradeSpawnRules;
    // v49：不再自动使用 legacySpriteSheets，避免误以为没有读取 assets/monsters/types。
    // 只有单体 types 配置读取失败时，才会显示圆形兜底。
    if (Array.isArray(monsterConfig.types)) {
      const monsterTypeConfigs = [];
      // 串行读取怪物子配置：一次只请求一个 JSON，避免 Promise.all 同时打爆本地服务/手机浏览器。
      for (const src of monsterConfig.types) {
        monsterTypeConfigs.push(await fetchJsonConfig(assetUrl(src), null, `怪物子配置 ${monsterTypeConfigs.length + 1}/${monsterConfig.types.length}`));
      }
      // 读取成功的子配置再统一标准化成 MONSTER_TYPES。失败项会被 filter(Boolean) 跳过。
      MONSTER_TYPES = monsterTypeConfigs.filter(Boolean).map(makeMonsterType).filter(type => type.id);
    }
    if (Array.isArray(monsterConfig.variants)) MONSTER_VARIANTS = monsterConfig.variants;
    else if (MONSTER_TYPES.length) MONSTER_VARIANTS = MONSTER_TYPES.map(type => type.id);

    const bossConfig = await fetchJsonConfig(ASSETS.bossConfig, {}, "Boss主配置");
    if (Number.isFinite(Number(bossConfig.roomInterval))) BOSS_ROOM_INTERVAL = Number(bossConfig.roomInterval);
    // v49：不再自动使用 Boss legacySpriteSheets，强制读取 assets/bosses/types。
    if (Array.isArray(bossConfig.bosses)) {
      const bossTypeConfigs = [];
      // 串行读取 Boss 子配置：Boss 图和动作通常更大，更不能首屏并发猛读。
      for (const src of bossConfig.bosses) {
        bossTypeConfigs.push(await fetchJsonConfig(assetUrl(src), null, `Boss子配置 ${bossTypeConfigs.length + 1}/${bossConfig.bosses.length}`));
      }
      // 转换成游戏内部 Boss 类型表，同时丢弃读取失败或缺 id 的配置。
      BOSS_TYPES = bossTypeConfigs.filter(Boolean).map(makeBossType).filter(type => type.id);
      if (BOSS_TYPES.length) BOSS_INFO = BOSS_TYPES.map(type => ({ ...type.info }));
    }

    const itemConfig = await fetchJsonConfig(ASSETS.itemConfig, {}, "道具配置");
    if (Array.isArray(itemConfig.items) && itemConfig.items.length) PICKUP_TYPES = itemConfig.items;
    ITEM_CONFIG = { ...ITEM_CONFIG, ...itemConfig };
    if (itemConfig.spriteSheet) ASSETS.items = assetUrl(itemConfig.spriteSheet);
    if (Number.isFinite(Number(itemConfig.roomPickup?.visible))) VISIBLE_ROOM_PICKUPS = Number(itemConfig.roomPickup.visible);
    if (Number.isFinite(Number(itemConfig.roomPickup?.hidden))) HIDDEN_ROOM_PICKUPS = Number(itemConfig.roomPickup.hidden);

    const levelConfig = await fetchJsonConfig(ASSETS.levelConfig, {}, "关卡配置");
    if (Number.isFinite(Number(levelConfig.roomTimeLimit))) ROOM_TIME_LIMIT = Number(levelConfig.roomTimeLimit);
    if (levelConfig.grid) Object.assign(BOMBER_GRID, levelConfig.grid);
    if (levelConfig.layout) ASSETS.levelBomberConfig = assetUrl(levelConfig.layout);
    if (Number.isFinite(Number(levelConfig.boss?.roomInterval))) BOSS_ROOM_INTERVAL = Number(levelConfig.boss.roomInterval);

    const wordConfig = await fetchJsonConfig(ASSETS.wordConfig, { chunks: [{ src: "wordbank.json", difficulty: 99 }] }, "词库入口配置");
    WORD_CHUNKS = Array.isArray(wordConfig.chunks) ? wordConfig.chunks : [];

    const savedHero = localStorage.getItem("wordRealmHero");
    if (savedHero && HEROES.some(hero => hero.id === savedHero)) game.selectedHeroId = savedHero;
    else game.selectedHeroId = HEROES[0]?.id || FALLBACK_HERO_ID;
  }

  const BOOK_COOLDOWN = 30;
  const BOOK_SHOW_DURATION = 5;
  const POSITIVE_BUFF_DURATION = 30;
  const NEGATIVE_BUFF_DURATION = 15;

  const DEFAULT_SETTINGS = {
    sound: true,
    crosshair: true,
    damageText: true,
    clickToShoot: true,
    autoPauseOnBlur: true
  };

  const SETTINGS_ITEMS = [
    { key: "sound", label: "\u97f3\u6548" },
    { key: "crosshair", label: "显示准星（仅PC）" },
    { key: "damageText", label: "\u663e\u793a\u6d6e\u52a8\u6587\u5b57" },
    { key: "clickToShoot", label: "鼠标点击射击（仅PC）" },
    { key: "autoPauseOnBlur", label: "\u5207\u51fa\u7a97\u53e3\u81ea\u52a8\u6682\u505c" }
  ];

  const themes = [
    { name: "迷宫大地图", tint: "#67c260", bg: null, obstacles: [], bomberman: true }
  ];

  let ITEM_CONFIG = { roomPickup: { visible: 2, hidden: 2, excludeFromRandomPool: ["mystery"] } };
  let PICKUP_TYPES = [
    { id: "reveal", title: "\u8bd1\u6587\u663e\u73b0", icon: 0, color: "#7bd8ff", positive: true },
    { id: "heal", title: "\u6cbb\u7597\u82f9\u679c", icon: 1, color: "#7bff90", positive: true },
    { id: "invincible", title: "\u65e0\u654c\u62a4\u661f", icon: 2, color: "#ffe27a", positive: true },
    { id: "speed", title: "\u75be\u8dd1\u4e4b\u9774", icon: 3, color: "#9dff7a", positive: true },
    { id: "pierce", title: "\u7a7f\u900f\u77db\u5934", icon: 4, color: "#ffc06f", positive: true },
    { id: "hide", title: "\u8ff7\u96fe\u9ed1\u5361", icon: 5, color: "#8c6cff", positive: false },
    { id: "damage", title: "\u8bc5\u5492\u6bd2\u74f6", icon: 6, color: "#ff7878", positive: false },
    { id: "slowSelf", title: "\u6ce5\u94fe\u8fdf\u7f13", icon: 7, color: "#b38a6e", positive: false },
    { id: "slowEnemy", title: "\u51b0\u65f6\u6c99\u6f0f", icon: 8, color: "#8ce8ff", positive: true },
    { id: "mystery", title: "\u95ee\u53f7\u5b9d\u7bb1", icon: 11, color: "#ffd36c", positive: true }
  ];

  function roomPickupPool() {
    const excluded = ITEM_CONFIG.roomPickup?.excludeFromRandomPool || ["mystery"];
    return PICKUP_TYPES.filter(p => !excluded.includes(p.id));
  }

  const OBSTACLE_POINTS = [
    { x: 250, y: 205 }, { x: 640, y: 180 }, { x: 1025, y: 205 },
    { x: 230, y: 395 }, { x: 640, y: 360 }, { x: 1050, y: 395 },
    { x: 300, y: 565 }, { x: 930, y: 565 }
  ];

  let BOSS_ROOM_INTERVAL = 5;
  let BOSS_INFO = [
    { name: "晶甲守卫", color: "#78d3ff", attackColor: "#95f5ff", baseStyle: "crystal", specialStyle: "crystalRain", basicCd: 4, skillCd: 8, skillName: "晶簇坠星" },
    { name: "赤焰天隼", color: "#ffb05c", attackColor: "#ff8c63", baseStyle: "fire", specialStyle: "featherNova", basicCd: 4, skillCd: 8, skillName: "炽羽爆散" },
    { name: "幽焰蛇后", color: "#b58dff", attackColor: "#af7dff", baseStyle: "venom", specialStyle: "serpentHoming", basicCd: 4, skillCd: 8, skillName: "灵蛇追咒" },
    { name: "棱镜幻蝶", color: "#8fe8ff", attackColor: "#b39cff", baseStyle: "prism", specialStyle: "prismSpiral", basicCd: 4, skillCd: 8, skillName: "幻蝶镜阵" },
    { name: "紫魇狮兽", color: "#c48dff", attackColor: "#d47cff", baseStyle: "claw", specialStyle: "shadowShockwave", basicCd: 4, skillCd: 8, skillName: "怒魇咆哮" },
    { name: "古林岩偶", color: "#b7d58a", attackColor: "#84d6ff", baseStyle: "rock", specialStyle: "golemRockfall", basicCd: 4, skillCd: 8, skillName: "陨岩轰落" }
  ];
  const BOSS_BASIC_CD_SECONDS = 4;
  const BOSS_SPECIAL_CD_SECONDS = 8;
  const BOSS_VISIBLE_TOKEN_MIN = 5;
  const BOSS_QUESTION_POOL_SIZE = 14;

  const BOMBER_GRID = {
    x: 64,
    y: 74,
    cols: 29,
    rows: 17,
    tile: 64
  };

  const BOMBER_DIRS = [
    { x: 1, y: 0, facing: 2 },
    { x: -1, y: 0, facing: 1 },
    { x: 0, y: 1, facing: 0 },
    { x: 0, y: -1, facing: 3 }
  ];

  /*
   * 炸弹人大地图格子坐标工具。
   * v82 精简版里这两个函数缺失，导致点击“开始冒险”后 nextRoom() 报错，页面看起来像“进不去”。
   * 统一放在 BOMBER_GRID 后面，后续移动、闪现、怪物寻路、出生点都共用这里。
   */
  function bomberCellCenter(col, row) {
    const c = clamp(Math.round(Number(col) || 0), 0, BOMBER_GRID.cols - 1);
    const r = clamp(Math.round(Number(row) || 0), 0, BOMBER_GRID.rows - 1);
    return {
      x: BOMBER_GRID.x + c * BOMBER_GRID.tile + BOMBER_GRID.tile / 2,
      y: BOMBER_GRID.y + r * BOMBER_GRID.tile + BOMBER_GRID.tile / 2,
      col: c,
      row: r
    };
  }

  function pointToBomberCell(x, y) {
    return {
      col: clamp(Math.floor((Number(x) - BOMBER_GRID.x) / BOMBER_GRID.tile), 0, BOMBER_GRID.cols - 1),
      row: clamp(Math.floor((Number(y) - BOMBER_GRID.y) / BOMBER_GRID.tile), 0, BOMBER_GRID.rows - 1)
    };
  }

  function bossTopCenterSpawnPoint() {
    // Boss 统一出生在地图顶部正中间：第 1 行是边界硬墙，所以放在顶部第一个可行动格的中心。
    return bomberCellCenter(Math.floor(BOMBER_GRID.cols / 2), 1);
  }

  const WRONG_HIT_AGGRO_TILES = 2;
  const WRONG_HIT_AGGRO_DURATION = 15;
  const WRONG_HIT_SPEED_MULT = 2;

  /*
   * 怪物追踪范围统一加成。
   *
   * 你的需求是：地图变大后，“所有怪物追踪逻辑在原先基础上 +3”。
   * 所以这里不去逐个修改 A/B/C/D/E 怪物配置，而是在统一追踪计算函数里加 3 格。
   *
   * 好处：
   * - 原来的配置值仍然保留，例如 A=5、B=4、C=3、D=2、E=1。
   * - 实际生效时统一变成 A=8、B=7、C=6、D=5、E=4。
   * - 不管怪物走“炸弹人大地图按格追踪”还是“普通地图智能追踪”，都会走同一个 effectiveMonsterAggroTiles()。
   * - 后面你觉得追踪还是短，只改这里的 3；觉得太远，就改成 2 或 1。
   *
   * 注意：这里的单位是“格”，不是像素。
   * 实际像素距离 = effectiveMonsterAggroTiles(monster) * BOMBER_GRID.tile。
   */
  const MONSTER_AGGRO_TILE_BONUS = 3;
  let ROOM_TIME_LIMIT = 180;
  let VISIBLE_ROOM_PICKUPS = 2;
  let HIDDEN_ROOM_PICKUPS = 2;

  let MONSTER_AI_CLASSES = [
    { grade: "A", name: "A类怪物", aggroTiles: 5, folder: "assets/monsters/A/" },
    { grade: "B", name: "B类怪物", aggroTiles: 4, folder: "assets/monsters/B/" },
    { grade: "C", name: "C类怪物", aggroTiles: 3, folder: "assets/monsters/C/" },
    { grade: "D", name: "D类怪物", aggroTiles: 2, folder: "assets/monsters/D/" },
    { grade: "E", name: "E类怪物", aggroTiles: 1, folder: "assets/monsters/E/" }
  ];

  function normalizeQuizMode(mode) {
    return ["forward", "reverse", "mixed"].includes(mode) ? mode : "forward";
  }

  function isMathMode() {
    return game.contentMode === "math";
  }

  function quizModeName(mode = game.quizMode) {
    const normalized = normalizeQuizMode(mode);
    if (isMathMode()) {
      if (normalized === "reverse") return "答案→算式";
      if (normalized === "mixed") return "混合";
      return "算式→答案";
    }
    if (normalized === "reverse") return "中→英";
    if (normalized === "mixed") return "混合";
    return "英→中";
  }


  function quizModeLabels() {
    return {
      forward: isMathMode() ? '算式→答案' : '英→中',
      reverse: isMathMode() ? '答案→算式' : '中→英',
      mixed: '混合'
    };
  }

  function contentModeName(mode = game.contentMode) {
    return mode === "math" ? "数学" : "英语";
  }

  function preferredInitialScreenMode() {
    const urlMode = new URLSearchParams(window.location.search).get("mode");
    if (urlMode === "portrait" || urlMode === "landscape") return urlMode;
    const saved = localStorage.getItem("wordRealmScreenMode");
    if (saved === "portrait" || saved === "landscape") return saved;
    const touchLike = !!window.matchMedia?.("(hover: none), (pointer: coarse), (max-width: 900px)")?.matches;
    return touchLike ? "portrait" : "landscape";
  }

  const game = {
    mode: "loading",
    words: [],
    bank: [],
    difficulty: 2,
    difficultyName: "\u7b80\u5355 / \u9ad8\u4e2d\u8bcd\u6c47",
    contentMode: localStorage.getItem("wordRealmContentMode") === "math" ? "math" : "word",
    quizMode: normalizeQuizMode(localStorage.getItem("wordRealmQuizMode") || "forward"),
    menuScreen: "home",
    screenMode: preferredInitialScreenMode(),
    selectedStartRoom: Math.max(1, Number(localStorage.getItem("wordRealmStartRoom") || 1)),
    selectedHeroId: (localStorage.getItem("wordRealmHero") === "agent" ? FALLBACK_HERO_ID : (localStorage.getItem("wordRealmHero") || FALLBACK_HERO_ID)),
    room: 0,
    bestRoom: Number(localStorage.getItem("wordRealmBestRoom") || 0),
    player: null,
    currentThemeIndex: 0,
    selectedThemeIndex: 0,
    monsters: [],
    boss: null,
    door: null,
    clearAnnounced: false,
    obstacles: [],
    bomberBlocks: [],
    tokens: [],
    pickups: [],
    projectiles: [],
    floats: [],
    rewards: [],
    message: "",
    score: 0,
    combo: 0,
    correct: 0,
    wrong: 0,
    roomTime: 0,
    runTime: 0,
    showMeaningTimer: 0,
    hideWordsTimer: 0,
    enemySlowTimer: 0,
    runSeen: new Set(),
    reviewStats: {},
    reviewOrder: 0,
    lastTime: performance.now(),
    mouse: { x: W / 2, y: H / 2, down: false },
    // 记录最近一次指针来源：
    // - PC 鼠标：mouse
    // - 手机/平板触摸：touch
    // 这个值主要用于输入层区分“鼠标瞄准”和“手机按钮操作”，
    // 避免手机端把手指点击画布误当成鼠标瞄准点。
    lastPointerType: "mouse",
    aim: { x: 1, y: 0 },
    move: { x: 0, y: 0 },
    touchMove: { x: 0, y: 0 },
    camera: { x: 0, y: 0 },
    keys: new Set(),
    settings: loadSettings(),
    levelConfigs: {},
    previousMode: "menu",
    showBook: false,
    bookCd: 0,
    bookTimer: 0,
    flash: 0,
    heroCarousel: { from: 0, to: 0, start: 0, duration: 280, active: false },
    // 开局设置英雄选择：只通过左右滑动切换，不再点击切换。
    heroSwipe: { active: false, pointerId: null, startX: 0, startY: 0, dx: 0, dy: 0 },
    heroDragOffset: 0,
    // 开局设置关卡走廊：显示已激活/未激活关卡，左右滑动切换可进入的关卡。
    levelCarousel: { from: 1, to: 1, start: 0, duration: 260, active: false },
    levelSwipe: { active: false, pointerId: null, startX: 0, startY: 0, dx: 0, dy: 0 },
    levelDragOffset: 0
  };
  runtimeGame = game;

  function isPortraitMode() {
    return game.screenMode === "portrait";
  }

  // 横屏开局设置控件尺寸统一表。
  // 后期只改这里，不要再把高度散落写在各个绘制函数里。
  const LANDSCAPE_CONFIG_UI = {
    // 横屏控件高度
    contentCardH: 75,
    quizCardH: 34,
    difficultyCardH: 78,
    startButtonH: 42,
    continueButtonH: 42,
    // 关卡卡片统一尺寸：当前卡、左右卡全部等大。
    levelCardW: 96,
    levelCardH: 92,
    levelCardGap: 28,
    levelVisibleSideCount: 3,

    // 横屏间距规则：难度卡片外部间距在 v150 基础上再增加 10px。
    contentTopY: 168,
    contentGap: 7,
    quizTopY: 338,
    quizGap: 6,
    difficultyTopY: 174,
    difficultyGap: 14,
    startButtonY: 568,
    continueButtonY: 626
  };

  function applyScreenMode(mode = game.screenMode) {
    game.screenMode = mode === "landscape" ? "landscape" : "portrait";
    localStorage.setItem("wordRealmScreenMode", game.screenMode);
    W = game.screenMode === "portrait" ? 720 : 1280;
    H = game.screenMode === "portrait" ? 1280 : 720;
    canvas.width = W;
    canvas.height = H;
    game.mouse.x = W / 2;
    game.mouse.y = H / 2;
    game.touchMove.x = 0; game.touchMove.y = 0;
    document.body.dataset.playOrientation = game.screenMode;
  }

  function homeModeCards() {
    if (isPortraitMode()) {
      return [
        { mode: "portrait", label: "竖屏模式", sub: "手机双手操作", x: 80, y: 470, w: 260, h: 112 },
        { mode: "landscape", label: "横屏模式", sub: "平板 / PC", x: 380, y: 470, w: 260, h: 112 }
      ];
    }
    return [
      { mode: "portrait", label: "竖屏模式", sub: "手机双手操作", x: 360, y: 360, w: 250, h: 96 },
      { mode: "landscape", label: "横屏模式", sub: "平板 / PC", x: 670, y: 360, w: 250, h: 96 }
    ];
  }

  function portraitContentCards() {
    return [
      { mode: "word", label: "英语", sub: "词汇闯关", icon: "Aa", x: 62, y: 552, w: 286, h: 78, accent: "#65f0ff" },
      { mode: "math", label: "数学", sub: "算式训练", icon: "√x", x: 372, y: 552, w: 286, h: 78, accent: "#8fb5ff" }
    ];
  }

  function portraitQuizCards() {
    return [
      { mode: "forward", label: quizModeName('forward'), x: 62, y: 644, w: 190, h: 52, accent: "#76fff0" },
      { mode: "reverse", label: quizModeName('reverse'), x: 266, y: 644, w: 190, h: 52, accent: "#78b8ff" },
      { mode: "mixed", label: quizModeName('mixed'), x: 470, y: 644, w: 190, h: 52, accent: "#b790ff" }
    ];
  }

  function landscapeContentCards() {
    const h = LANDSCAPE_CONFIG_UI.contentCardH;
    const top = LANDSCAPE_CONFIG_UI.contentTopY;
    const gap = LANDSCAPE_CONFIG_UI.contentGap;
    return [
      { mode: "word", label: "英语", sub: "词汇闯关", icon: "A", x: 56, y: top, w: 248, h, accent: "#65f0ff" },
      { mode: "math", label: "数学", sub: "算式训练", icon: "√x", x: 56, y: top + h + gap, w: 248, h, accent: "#8fb5ff" }
    ];
  }

  function landscapeQuizCards() {
    const h = LANDSCAPE_CONFIG_UI.quizCardH;
    const top = LANDSCAPE_CONFIG_UI.quizTopY;
    const gap = LANDSCAPE_CONFIG_UI.quizGap;
    const labels = quizModeLabels();
    return [
      { mode: "forward", label: labels.forward, x: 56, y: top, w: 248, h, accent: "#76fff0" },
      { mode: "reverse", label: labels.reverse, x: 56, y: top + h + gap, w: 248, h, accent: "#78b8ff" },
      { mode: "mixed", label: labels.mixed, x: 56, y: top + (h + gap) * 2, w: 248, h, accent: "#b790ff" }
    ];
  }

  function startButtonRect() {
    return isPortraitMode()
      ? { x: 150, y: 650, w: 420, h: 76 }
      : { x: 470, y: 500, w: 340, h: 72 };
  }

  function carouselEase(t) {
    const v = clamp(Number(t) || 0, 0, 1);
    return 1 - Math.pow(1 - v, 3);
  }

  function wrapCarouselDiff(diff, total) {
    if (!total) return 0;
    let d = Number(diff) || 0;
    while (d > total / 2) d -= total;
    while (d < -total / 2) d += total;
    return d;
  }

  function selectedHeroIndex() {
    return Math.max(0, HEROES.findIndex(hero => hero.id === game.selectedHeroId));
  }

  function heroSwipeArea() {
    return isPortraitMode()
      ? { x: 0, y: 124, w: W, h: 336 }
      : { x: 340, y: 96, w: 590, h: 380 };
  }

  function unlockedStartRoom() {
    // bestRoom 是历史最高到达关卡。下一关也应可从开局走廊进入，最低始终激活第 1 关。
    return Math.max(1, Math.floor(Number(game.bestRoom || 0)) + 1);
  }

  function levelLoopTotal() {
    // 关卡走廊改为“已激活关卡循环轮播”：
    // 只在可进入的关卡之间首尾循环，避免把未解锁关卡滑到中心后无法开始游戏。
    return Math.max(1, unlockedStartRoom());
  }

  function normalizeStartRoom(room) {
    return clamp(Math.floor(Number(room) || 1), 1, levelLoopTotal());
  }

  function syncSelectedStartRoom() {
    const fixed = normalizeStartRoom(game.selectedStartRoom);
    if (fixed !== game.selectedStartRoom) {
      game.selectedStartRoom = fixed;
      localStorage.setItem("wordRealmStartRoom", String(fixed));
    }
    return fixed;
  }

  function levelCorridorArea() {
    return isPortraitMode()
      ? { x: 54, y: 1008, w: W - 108, h: 118 }
      : { x: 56, y: 538, w: 872, h: 132 };
  }

  function levelCardMetrics() {
    const portrait = isPortraitMode();
    return portrait
      ? { w: 104, h: 64, gap: 20, sideCount: 2 }
      : {
        w: LANDSCAPE_CONFIG_UI.levelCardW,
        h: LANDSCAPE_CONFIG_UI.levelCardH,
        gap: LANDSCAPE_CONFIG_UI.levelCardGap,
        sideCount: LANDSCAPE_CONFIG_UI.levelVisibleSideCount
      };
  }

  function levelSwipeRange() {
    const m = levelCardMetrics();
    // 拖动一个“卡片宽度 + 间距”的距离，正好对应轮播移动一张卡。
    return Math.max(80, m.w + m.gap);
  }

  function activeLevelDragOffset() {
    const swipe = game.levelSwipe || null;
    if (!swipe?.active) return 0;
    return clamp(Number(game.levelDragOffset) || 0, -1.15, 1.15);
  }

  function levelCorridorCenter() {
    const current = syncSelectedStartRoom();
    const total = levelLoopTotal();
    const dragOffset = activeLevelDragOffset();
    if (Math.abs(dragOffset) > 0.001 && total > 1) return current - dragOffset;
    const ui = game.levelCarousel || {};
    if (!ui.active || total < 2) return current;
    const elapsed = performance.now() - Number(ui.start || 0);
    const t = clamp(elapsed / Math.max(80, Number(ui.duration || 260)), 0, 1);
    if (t >= 1) {
      ui.active = false;
      return current;
    }
    // 首尾循环时走最短方向，例如最后一关 -> 第 1 关，只移动一张卡的距离。
    const delta = wrapCarouselDiff((Number(ui.to || current) - 1) - (Number(ui.from || current) - 1), total);
    return Number(ui.from || current) + delta * carouselEase(t);
  }

  function levelCircularDiff(level, center, total) {
    if (total <= 1) return 0;
    return wrapCarouselDiff((Number(level) - 1) - (Number(center) - 1), total);
  }

  function levelCardLayout(level) {
    const total = levelLoopTotal();
    const center = levelCorridorCenter();
    const diff = levelCircularDiff(level, center, total);
    const m = levelCardMetrics();
    const area = levelCorridorArea();
    const limit = Math.min(m.sideCount + 0.55, Math.max(0.55, total / 2 + 0.1));
    if (Math.abs(diff) > limit) return { kind: "hidden", x: -999, y: -999, w: 1, h: 1, z: 0, diff, alpha: 0 };

    const stride = m.w + m.gap;
    const x = area.x + (area.w - m.w) / 2 + diff * stride;
    const y = area.y + (area.h - m.h) / 2;
    const abs = Math.abs(diff);
    const edgeFadeStart = Math.max(0.01, m.sideCount - 0.45);
    const edgeT = clamp((abs - edgeFadeStart) / 0.9, 0, 1);
    const alpha = 1 - edgeT * 0.38;
    return {
      x, y, w: m.w, h: m.h,
      kind: abs < .45 ? 'main' : 'side',
      diff,
      z: m.sideCount + 1 - abs,
      alpha
    };
  }

  function levelCorridorItems() {
    const total = levelLoopTotal();
    const rows = [];
    for (let level = 1; level <= total; level++) rows.push({ level, card: levelCardLayout(level) });
    return rows.filter(item => item.card.kind !== 'hidden').sort((a, b) => a.card.z - b.card.z);
  }

  // 关卡走廊卡片：毛玻璃质感。
  // 用半透明渐变、柔光高光、内描边模拟 glassmorphism；
  // 不再复用旧版实色面板，避免卡片看起来厚重。
  function drawGlassLevelCard(x, y, w, h, opts = {}) {
    const accent = opts.accent || '#76fff0';
    const active = !!opts.active;
    const current = !!opts.current;
    const locked = !active;
    const radius = opts.radius || 14;
    const phase = uiPhase(x, y);
    const pulse = current ? uiPulse(900, phase) : 0;

    const fill = ctx.createLinearGradient(x, y, x + w, y + h);
    if (locked) {
      fill.addColorStop(0, 'rgba(122,148,190,.16)');
      fill.addColorStop(0.48, 'rgba(32,44,72,.24)');
      fill.addColorStop(1, 'rgba(10,16,34,.36)');
    } else if (current) {
      fill.addColorStop(0, `rgba(184,250,255,${0.25 + pulse * 0.06})`);
      fill.addColorStop(0.45, `rgba(54,136,172,${0.34 + pulse * 0.05})`);
      fill.addColorStop(1, `rgba(20,76,104,${0.46 + pulse * 0.05})`);
    } else {
      fill.addColorStop(0, 'rgba(172,242,255,.18)');
      fill.addColorStop(0.50, 'rgba(28,78,118,.28)');
      fill.addColorStop(1, 'rgba(12,42,76,.42)');
    }

    ctx.save();
    ctx.shadowColor = current ? `rgba(255,228,142,${0.20 + pulse * 0.10})` : (active ? 'rgba(74,220,255,.13)' : 'rgba(0,0,0,.18)');
    ctx.shadowBlur = current ? 18 + pulse * 8 : 9;
    roundRect(x, y, w, h, radius, fill, current ? 'rgba(255,246,190,.82)' : (active ? `${accent}6e` : 'rgba(184,198,232,.24)'), current ? 1.6 : 1.2);
    ctx.restore();

    ctx.save();
    roundRectRaw(x + 1, y + 1, w - 2, h - 2, Math.max(4, radius - 1));
    ctx.clip();

    const frost = ctx.createLinearGradient(x, y, x, y + h);
    frost.addColorStop(0, current ? 'rgba(255,255,255,.24)' : 'rgba(255,255,255,.16)');
    frost.addColorStop(0.34, 'rgba(255,255,255,.055)');
    frost.addColorStop(1, 'rgba(255,255,255,.02)');
    ctx.fillStyle = frost;
    ctx.fillRect(x, y, w, h);

    const glare = ctx.createLinearGradient(x - w * .1, y, x + w * .85, y + h * .75);
    glare.addColorStop(0, 'rgba(255,255,255,.24)');
    glare.addColorStop(0.22, 'rgba(255,255,255,.06)');
    glare.addColorStop(0.46, 'rgba(255,255,255,0)');
    ctx.fillStyle = glare;
    ctx.fillRect(x, y, w, h);

    const bottomGlow = ctx.createRadialGradient(x + w / 2, y + h * .95, 4, x + w / 2, y + h * .95, w * .72);
    bottomGlow.addColorStop(0, active ? `${accent}30` : 'rgba(160,172,220,.08)');
    bottomGlow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = bottomGlow;
    ctx.fillRect(x, y, w, h);

    ctx.restore();

    ctx.strokeStyle = current ? 'rgba(255,255,255,.28)' : 'rgba(255,255,255,.14)';
    ctx.lineWidth = 1;
    roundRectRaw(x + 5, y + 5, w - 10, h - 10, Math.max(6, radius - 5));
    ctx.stroke();
  }

  function drawLevelCorridor() {
    const area = levelCorridorArea();
    const unlocked = unlockedStartRoom();
    const selected = syncSelectedStartRoom();
    const portrait = isPortraitMode();
    ctx.save();
    ctx.beginPath();
    roundRectRaw(area.x, area.y, area.w, area.h, portrait ? 20 : 16);
    ctx.clip();
    for (const { level, card } of levelCorridorItems()) {
      const active = level <= unlocked;
      const current = level === selected;
      const boss = level > 0 && level % Math.max(1, BOSS_ROOM_INTERVAL) === 0;
      ctx.save();
      ctx.globalAlpha = clamp(Number(card.alpha) || 1, 0, 1);
      const accent = active ? (boss ? '#ff9a76' : '#76fff0') : '#7b86a8';
      drawGlassLevelCard(card.x, card.y, card.w, card.h, {
        accent,
        active,
        current,
        radius: portrait ? 16 : 14
      });

      const compact = portrait
        ? { titleY: card.y + 28, tagY: card.y + 50 }
        : { titleY: card.y + 35, tagY: card.y + 66 };

      ctx.fillStyle = active ? '#ffffff' : 'rgba(198,206,224,.54)';
      ctx.font = current ? `900 ${portrait ? 24 : 22}px Microsoft YaHei UI` : `800 ${portrait ? 20 : 19}px Microsoft YaHei UI`;
      textCenter(levelDisplayLabel(level), card.x + card.w / 2, compact.titleY);

      ctx.fillStyle = active ? (boss ? '#ff95b2' : 'rgba(116,255,218,.92)') : 'rgba(186,194,214,.68)';
      ctx.font = `700 ${portrait ? (current ? 13 : 11) : 12}px Microsoft YaHei UI`;
      const tag = current ? '当前关卡' : (active ? (boss ? 'BOSS' : '已过关') : '未解锁');
      textCenter(tag, card.x + card.w / 2, compact.tagY);
      ctx.restore();
    }
    ctx.restore();
    // 关卡摘要放在分区标题处，这里不再重复绘制，避免底部小字叠加。
  }

  function heroSwipeRange() {
    const area = heroSwipeArea();
    return Math.max(160, area.w * (isPortraitMode() ? 0.42 : 0.46));
  }

  function activeHeroDragOffset() {
    const swipe = game.heroSwipe || null;
    if (!swipe?.active) return 0;
    return clamp(Number(game.heroDragOffset) || 0, -1.15, 1.15);
  }

  function heroCarouselCenter() {
    const total = HEROES.length || 1;
    const ui = game.heroCarousel || {};
    const current = selectedHeroIndex();
    const dragOffset = activeHeroDragOffset();
    if (Math.abs(dragOffset) > 0.001 && total > 1) return current - dragOffset;
    if (!ui.active || total < 2) return current;
    const elapsed = performance.now() - Number(ui.start || 0);
    const t = clamp(elapsed / Math.max(80, Number(ui.duration || 280)), 0, 1);
    if (t >= 1) {
      ui.active = false;
      return current;
    }
    const delta = wrapCarouselDiff(Number(ui.to || current) - Number(ui.from || current), total);
    return Number(ui.from || current) + delta * carouselEase(t);
  }

  function heroCarouselCard(i) {
    const total = HEROES.length || 1;
    const center = heroCarouselCenter();
    const diff = wrapCarouselDiff(i - center, total);
    if (Math.abs(diff) > 2.35) return { x: -999, y: -999, w: 1, h: 1, kind: 'hidden', diff, z: 0, alpha: 0 };

    const anchors = isPortraitMode()
      ? [
        { d: -2, x: -70, y: 236, w: 138, h: 184, z: 1, alpha: .24 },
        { d: -1, x: 78, y: 210, w: 150, h: 216, z: 2, alpha: .66 },
        { d: 0, x: 222, y: 154, w: 276, h: 300, z: 5, alpha: 1 },
        { d: 1, x: 492, y: 210, w: 150, h: 216, z: 2, alpha: .66 },
        { d: 2, x: 652, y: 236, w: 138, h: 184, z: 1, alpha: .24 }
      ]
      : [
        { d: -2, x: 344, y: 232, w: 96, h: 138, z: 1, alpha: .20 },
        { d: -1, x: 374, y: 178, w: 142, h: 202, z: 2, alpha: .58 },
        { d: 0, x: 526, y: 126, w: 216, h: 312, z: 5, alpha: 1 },
        { d: 1, x: 756, y: 178, w: 142, h: 202, z: 2, alpha: .58 },
        { d: 2, x: 870, y: 232, w: 96, h: 138, z: 1, alpha: .20 }
      ];
    let a = anchors[0], b = anchors[anchors.length - 1];
    for (let k = 0; k < anchors.length - 1; k++) {
      if (diff >= anchors[k].d && diff <= anchors[k + 1].d) { a = anchors[k]; b = anchors[k + 1]; break; }
    }
    const span = Math.max(.0001, b.d - a.d);
    const t = carouselEase((diff - a.d) / span);
    const mix = key => a[key] + (b[key] - a[key]) * t;
    const alpha = mix('alpha');
    const z = mix('z');
    const abs = Math.abs(diff);
    return {
      x: mix('x'), y: mix('y'), w: mix('w'), h: mix('h'),
      kind: abs < .45 ? 'main' : (abs < 1.45 ? 'side' : 'far'),
      diff, z, alpha
    };
  }

  function heroCarouselRenderItems() {
    return HEROES.map((hero, i) => ({ hero, i, card: heroCarouselCard(i) }))
      .filter(item => item.card.kind !== 'hidden')
      .sort((a, b) => a.card.z - b.card.z);
  }

  function drawHeroCarouselItems(animT) {
    const portrait = isPortraitMode();
    for (const { hero: heroItem, i, card: baseCard } of heroCarouselRenderItems()) {
      const selected = heroItem.id === game.selectedHeroId;
      const floatY = selected ? Math.sin(animT / 520) * (portrait ? 3 : 2) : Math.sin(animT / 760 + i * 0.85) * (portrait ? 5 : 3);
      const pulse = selected ? (0.5 + Math.sin(animT / 260) * 0.5) : 0;
      const card = { ...baseCard, y: baseCard.y + floatY };
      const accent = selected ? '#87e8ff' : (card.kind === 'far' ? '#6f86bf' : '#8b9eff');
      const imgPadX = selected ? (portrait ? 42 : 34) : (portrait ? 18 : 16);
      const imgTop = selected ? (portrait ? 30 : 24) : (portrait ? 24 : 18);
      const imgBottom = selected ? (portrait ? 108 : 120) : (portrait ? 82 : 76);
      const labelY = selected ? card.y + card.h - (portrait ? 76 : 64) : card.y + card.h - (portrait ? 40 : 30);

      ctx.save();
      ctx.globalAlpha = card.alpha;
      if (selected) {
        const aura = ctx.createRadialGradient(card.x + card.w / 2, card.y + card.h / 2, 40, card.x + card.w / 2, card.y + card.h / 2, portrait ? 270 : 220);
        aura.addColorStop(0, `rgba(138,246,255,${0.18 + pulse * 0.10})`);
        aura.addColorStop(0.55, `rgba(184,104,255,${0.12 + pulse * 0.08})`);
        aura.addColorStop(1, 'rgba(184,104,255,0)');
        ctx.fillStyle = aura;
        ctx.beginPath();
        ctx.ellipse(card.x + card.w / 2, card.y + card.h / 2, card.w * 0.74, card.h * 0.62, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      drawFantasyPanel(card.x, card.y, card.w, card.h, {
        accent,
        fillTop: selected ? 'rgba(90,46,142,.66)' : 'rgba(34,46,86,.56)',
        fillBottom: selected ? 'rgba(54,30,104,.82)' : 'rgba(16,26,50,.78)',
        stroke: selected ? `rgba(149,244,255,${0.76 + pulse * 0.18})` : 'rgba(118,138,188,.30)',
        shadow: selected ? 'rgba(88,240,255,.22)' : 'rgba(0,0,0,.12)',
        shadowBlur: selected ? 18 + pulse * 12 : 8,
        radius: selected ? (portrait ? 26 : 24) : (portrait ? 22 : 20),
        noDeco: true,
        noInner: true
      });
      if (selected) {
        ctx.strokeStyle = `rgba(232,169,255,${0.30 + pulse * 0.22})`;
        ctx.lineWidth = 3;
        roundRectRaw(card.x + 8, card.y + 8, card.w - 16, card.h - 16, portrait ? 22 : 20);
        ctx.stroke();
      }
      scheduleHeroPreview(heroItem, i);
      const previewAction = heroItem.actions?.idle || heroItem.actions?.walk;
      const img = images[previewAction?.imageKey || heroItem.imageKey] || images[heroItem.imageKey];
      if (img && previewAction) {
        drawAtlas(img, previewAction.cols || 1, previewAction.rows || 4, heroPreviewFrameIndex(previewAction), card.x + imgPadX, card.y + imgTop + (selected ? Math.sin(animT / 500) * 2 : 0), card.w - imgPadX * 2, card.h - imgTop - imgBottom);
      } else if (img) {
        drawImageCover(img, card.x + imgPadX, card.y + imgTop, card.w - imgPadX * 2, card.h - imgTop - imgBottom);
      }
      ctx.fillStyle = selected ? '#ffffff' : 'rgba(228,238,255,.86)';
      ctx.font = selected ? `900 ${portrait ? 26 : 22}px Microsoft YaHei UI` : `800 ${portrait ? 20 : 16}px Microsoft YaHei UI`;
      textCenter(heroItem.name, card.x + card.w / 2, labelY);
      if (selected) {
        const detailW = portrait ? card.w - 140 : card.w - 94;
        const detailH = portrait ? 38 : 32;
        const detailX = card.x + (card.w - detailW) / 2;
        const detailY = card.y + card.h - (portrait ? 58 : 48);
        drawFantasyPanel(detailX, detailY, detailW, detailH, {
          accent: '#d08aff',
          fillTop: `rgba(168,88,255,${0.48 + pulse * 0.12})`,
          fillBottom: 'rgba(116,64,222,.66)',
          stroke: `rgba(233,194,255,${0.45 + pulse * 0.18})`,
          radius: 20,
          shadowBlur: 8 + pulse * 6,
          noDeco: true,
          noInner: true
        });
        ctx.fillStyle = '#ffffff';
        ctx.font = `800 ${portrait ? 18 : 15}px Microsoft YaHei UI`;
        textCenter('滑动选择', card.x + card.w / 2, detailY + (portrait ? 26 : 22));
      }
      ctx.restore();
    }
  }

  function portraitDifficultyCards() {
    return [
      { name: "简单", sub: "基础", d: 2, x: 54, y: 824, w: 190, h: 66 },
      { name: "普通", sub: "进阶", d: 4, x: 266, y: 824, w: 190, h: 66 },
      { name: "困难", sub: "挑战", d: 6, x: 478, y: 824, w: 190, h: 66 }
    ];
  }

  function portraitActionButtons() {
    return {
      back: { x: 30, y: 30, w: 112, h: 56 },
      start: { x: 76, y: 1164, w: 568, h: 50 },
      continue: { x: 174, y: 1222, w: 372, h: 50 }
    };
  }


  /*
   * ========================
   * 手机 / PC 输入模式判断
   * ========================
   *
   * 手机端竖屏采用按钮操作：左手摇杆按格移动，右下角按钮负责指向发射和闪现。
   * 手机端不能把手指点击画布误当成 PC 鼠标准星。
   *
   * 这里和 styles.css 的手机断点保持一致：
   * - hover: none：没有鼠标悬停能力，通常是手机/平板触摸屏；
   * - pointer: coarse：粗指针，通常是手指触控；
   * - max-width: 900px：窄屏设备兜底。
   */
  const MOBILE_CONTROL_QUERY = "(hover: none), (pointer: coarse), (max-width: 900px)";

  function isMobileControlMode() {
    return !!window.matchMedia?.(MOBILE_CONTROL_QUERY)?.matches;
  }

  function shouldDrawMouseCrosshair() {
    // 手机端不画鼠标准星。
    // PC 端仍然保留“显示准星”开关，方便鼠标点击瞄准。
    return !isMobileControlMode();
  }

  const images = {};
  const sounds = {};
  const SAVE_KEY = "wordRealmSave";
  const walkMaskCache = {};

  function loadSave() {
    try {
      const data = JSON.parse(localStorage.getItem(SAVE_KEY) || "null");
      return data && Number.isFinite(data.room) && data.room > 0 ? data : null;
    } catch {
      return null;
    }
  }

  function clearSave() {
    localStorage.removeItem(SAVE_KEY);
  }

  function saveRun() {
    if (!game.player || game.room <= 0) return;
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      room: game.room,
      difficulty: game.difficulty,
      difficultyName: game.difficultyName,
      contentMode: game.contentMode,
      quizMode: game.quizMode,
      score: game.score,
      correct: game.correct,
      wrong: game.wrong,
      runTime: game.runTime,
      hero: game.selectedHeroId,
      theme: game.selectedThemeIndex,
      seen: [...game.runSeen].slice(-300),
      reviewStats: game.reviewStats,
      reviewOrder: game.reviewOrder,
      savedAt: Date.now()
    }));
  }

  function loadSettings() {
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("wordRealmSettings") || "{}") };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings() {
    localStorage.setItem("wordRealmSettings", JSON.stringify(game.settings));
  }

  function toggleSetting(key) {
    if (!(key in game.settings)) return;
    game.settings[key] = !game.settings[key];
    saveSettings();
    play("pickup");
  }

  function openSettings() {
    if (game.mode !== "settings") game.previousMode = game.mode;
    game.mode = "settings";
  }

  function closeSettings() {
    game.mode = game.previousMode || "menu";
  }

  /*
   * ========================
   * ④ 图片加载核心区
   * ========================
   *
   * loadImage / ensureImage / ensureImageEntries 是所有图片加载的基础。
   * 这里改错，可能会导致全游戏黑屏或素材不显示，所以只建议按注释里的范围改。
   */

  function loadImage(src) {
    return new Promise(resolve => {
      const img = new Image();
      let settled = false;

      // finish() 负责统一结束加载：成功返回 img，失败/超时返回 null。
      // settled 防止 onload、onerror、timeout 多次触发导致重复 resolve。
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };

      // 图片加载超时保护。
      // 【自己可以改】8000 毫秒 = 8 秒。素材很大或网络慢时可以改 12000。
      const timer = setTimeout(() => {
        console.warn("图片加载超时：", src);
        finish(null);
      }, 8000);

      img.onload = () => finish(img);
      img.onerror = () => {
        console.warn("图片加载失败：", src);
        finish(null);
      };

      // 真正开始请求图片。注意 src 应该已经经过 assetUrl() 加版本号。
      img.src = src;
    });
  }

  function ensureImage(key, src) {
    if (!key || !src) return Promise.resolve(null);

    // 已经加载成功的图片，直接复用，不重复请求。
    if (images[key]) return Promise.resolve(images[key]);

    // 正在加载中的图片，直接复用同一个 Promise，避免同一张图片被同时请求多次。
    if (loadingImages.has(key)) return loadingImages.get(key);

    const task = loadImage(src).then(img => {
      images[key] = img;
      loadingImages.delete(key);
      return img;
    });
    loadingImages.set(key, task);
    return task;
  }

  async function ensureImageEntries(entries, concurrency = IMAGE_LOAD_CONCURRENCY, progressLabel = "") {
    const list = (entries || []).filter(([, src]) => Boolean(src));
    if (!list.length) return [];

    const tracked = Boolean(progressLabel);
    if (tracked) addLoadWork(list.length, progressLabel);

    let cursor = 0;
    const results = new Array(list.length);

    // 并发加载控制：最多同时加载 concurrency 张图片。
    // 这就是“避免手机/本地服务瞬间被很多请求打满”的关键。
    const workerCount = Math.max(1, Math.min(Number(concurrency) || IMAGE_LOAD_CONCURRENCY, list.length));
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < list.length) {
        const current = cursor++;
        const [key, src] = list[current];
        const img = await ensureImage(key, src);
        results[current] = img;
        if (tracked) finishLoadWork(`${progressLabel} ${current + 1}/${list.length}`, !img);
      }
    });

    await Promise.all(workers);
    return results;
  }

  /*
   * ========================
   * ⑤ 英雄动作加载与菜单预览懒加载
   * ========================
   *
   * 本次整改最关键的性能优化就在这一段。
   *
   * 原思路：首屏/菜单阶段就加载当前英雄全套动作，甚至多个英雄预览一起请求。
   * 新思路：
   * - 首屏只加载菜单必须资源 + 当前英雄 idle 预览。
   * - 菜单卡片只懒加载每个英雄的 idle 预览。
   * - 点击开始游戏时，才加载当前英雄 idle/walk/attack/dash/hurt 完整动作。
   */

  function heroActionEntries(hero) {
    const entries = [];
    const seen = new Set();
    if (!hero) return entries;

    // 先放 idle，因为 hero.imageKey / hero.src 默认就是 idle。
    if (hero.imageKey && hero.src) {
      entries.push([hero.imageKey, hero.src]);
      seen.add(hero.imageKey);
    }

    // 再放 walk/attack/dash/hurt 等动作。seen 用来去重，防止 idle 被重复加载。
    for (const action of Object.values(hero.actions || {})) {
      if (!action || !action.imageKey || !action.src || seen.has(action.imageKey)) continue;
      entries.push([action.imageKey, action.src]);
      seen.add(action.imageKey);
    }
    return entries;
  }

  // 进入游戏时调用：加载“当前选中英雄”的完整动作。
  // 注意：不要在菜单首屏调用它，否则又会变成一开始就加载全套动作。
  function ensureHeroImages(hero, progressLabel = "") {
    return ensureImageEntries(heroActionEntries(hero), IMAGE_LOAD_CONCURRENCY, progressLabel);
  }

  // 菜单预览用：只加载 idle，最多 fallback 到 walk 或 hero.src。
  // 这样英雄再多，首屏也不会一次性加载每个英雄 5 张动作图。
  function ensureHeroPreview(hero) {
    if (!hero) return Promise.resolve(null);
    const action = hero.actions?.idle || hero.actions?.walk;
    if (action?.imageKey && action?.src) return ensureImage(action.imageKey, action.src);
    return ensureImage(hero.imageKey, hero.src);
  }

  function scheduleHeroPreview(hero, index = 0) {
    // 已经请求过或已经加载出来的预览，不再重复排队。
    if (!hero?.id || requestedHeroPreviews.has(hero.id) || images[hero.actions?.idle?.imageKey || hero.imageKey]) return;

    requestedHeroPreviews.add(hero.id);
    const selected = hero.id === game.selectedHeroId;
    const job = { hero, selected, order: index };

    // 当前选中的英雄预览优先加载；其他英雄排到后面慢慢加载。
    if (selected) heroPreviewQueue.unshift(job);
    else heroPreviewQueue.push(job);

    runHeroPreviewQueue(selected ? 0 : HERO_PREVIEW_BATCH_DELAY);
  }

  function runHeroPreviewQueue(initialDelay = 0) {
    // 队列已经在跑，就不要再启动第二个队列循环。
    if (heroPreviewQueueRunning) return;

    heroPreviewQueueRunning = true;
    window.setTimeout(async function loadNextHeroPreview() {
      const job = heroPreviewQueue.shift();
      if (!job) {
        heroPreviewQueueRunning = false;
        return;
      }

      // 每次只处理一个英雄预览。
      await ensureHeroPreview(job.hero);

      // 选中英雄稍快，普通英雄按 HERO_PREVIEW_BATCH_DELAY 分批加载。
      window.setTimeout(loadNextHeroPreview, job.selected ? 60 : HERO_PREVIEW_BATCH_DELAY);
    }, Math.max(0, initialDelay));
  }

  function entityTypeImageEntries(type) {
    const entries = [];
    const seen = new Set();
    for (const action of Object.values(type?.actions || {})) {
      for (const dirDef of Object.values(action || {})) {
        if (!dirDef || !dirDef.key || !dirDef.src || seen.has(dirDef.key)) continue;
        entries.push([dirDef.key, dirDef.src]);
        seen.add(dirDef.key);
      }
    }
    return entries;
  }

  function ensureMonsterTypeImages(type) {
    return ensureImageEntries(entityTypeImageEntries(type));
  }

  function ensureBossTypeImages(type) {
    return ensureImageEntries(entityTypeImageEntries(type));
  }

  function loadSound(src) {
    const audio = new Audio(src);
    audio.preload = "auto";
    return audio;
  }


  function heroImageEntries() {
    const entries = [];
    const seen = new Set();
    for (const hero of HEROES) {
      if (hero.imageKey && hero.src && !seen.has(hero.imageKey)) {
        entries.push([hero.imageKey, hero.src]);
        seen.add(hero.imageKey);
      }
      for (const action of Object.values(hero.actions || {})) {
        if (!action || !action.imageKey || !action.src || seen.has(action.imageKey)) continue;
        entries.push([action.imageKey, action.src]);
        seen.add(action.imageKey);
      }
    }
    return entries;
  }

  function directionalImageEntries(list) {
    const entries = [];
    const seen = new Set();
    for (const item of list) {
      for (const action of Object.values(item.actions || {})) {
        for (const dirDef of Object.values(action || {})) {
          if (!dirDef || !dirDef.key || !dirDef.src || seen.has(dirDef.key)) continue;
          entries.push([dirDef.key, dirDef.src]);
          seen.add(dirDef.key);
        }
      }
    }
    return entries;
  }

  function monsterImageEntries() {
    return directionalImageEntries(MONSTER_TYPES);
  }

  function bossImageEntries() {
    return directionalImageEntries(BOSS_TYPES);
  }

  /*
   * 按难度加载词库。
   *
   * 【自己可以改】
   * - assets/config/words.json：决定有哪些词库分包。
   * - 词库 JSON：每条通常包含 word、meaning、difficulty 等字段。
   *
   * 加载规则：
   * - 菜单首屏不读取完整词库，避免开局慢。
   * - 玩家选择难度并进入游戏时，才按 maxDifficulty 加载需要的词库分包。
   * - loadedWordChunks 防止同一个分包重复加载。
   */
  async function ensureWordsLoaded(maxDifficulty = 99) {
    if (!WORD_CHUNKS.length) {
      const fallbackRows = await fetchJsonConfig(assetUrl("wordbank.json"), [], "旧版词库");
      game.words = (Array.isArray(fallbackRows) ? fallbackRows : []).filter(w => w.word && w.meaning);
      if (!game.words.length) throw new Error("词库读取失败：未找到可用词条");
      return game.words;
    }

    const need = WORD_CHUNKS.filter(chunk => Number(chunk.difficulty ?? 99) <= Number(maxDifficulty));
    if (!need.length) return game.words;

    const newlyLoaded = [];
    for (const chunk of need) {
      if (!chunk.src || loadedWordChunks.has(chunk.src)) continue;

      // 词库分包同样使用 fetchJsonConfig()，因此也带短重试。
      const rows = await fetchJsonConfig(assetUrl(chunk.src), [], `词库分包 ${chunk.difficulty ?? "?"}级`);
      if (!Array.isArray(rows) || !rows.length) throw new Error(`词库分包读取失败：${chunk.src}`);
      newlyLoaded.push(...rows);
      loadedWordChunks.add(chunk.src);
    }

    // 合并词库时按英文单词去重，避免多个分包重复出现同一词。
    if (newlyLoaded.length) {
      const seen = new Set(game.words.map(w => w.word));
      for (const row of newlyLoaded) {
        if (!row.word || !row.meaning || seen.has(row.word)) continue;
        game.words.push(row);
        seen.add(row.word);
      }
    }
    return game.words;
  }

  function makeMathEntries(maxDifficulty = 6) {
    const rows = [];
    const seenExpressions = new Set();
    const add = (expression, answer, difficulty) => {
      const expr = String(expression).trim();
      const key = String(answer).trim();
      if (!expr || !key || seenExpressions.has(expr)) return;
      seenExpressions.add(expr);
      rows.push({
        word: expr,
        meaning: key,
        expression: expr,
        answer: key,
        difficulty,
        source: "math"
      });
    };
    const maxA = maxDifficulty <= 2 ? 20 : maxDifficulty <= 4 ? 50 : 100;
    const maxB = maxDifficulty <= 2 ? 12 : maxDifficulty <= 4 ? 30 : 80;
    for (let a = 2; a <= maxA && rows.length < 520; a++) {
      for (let b = 2; b <= maxB && rows.length < 520; b++) {
        const d = a <= 20 && b <= 12 ? 2 : a <= 50 && b <= 30 ? 4 : 6;
        if (d > maxDifficulty) continue;
        add(`${a} + ${b}`, a + b, d);
        add(`${a + b} - ${b}`, a, d);
        if (b <= 12) add(`${a} × ${b}`, a * b, Math.max(2, d));
        if (b > 1 && a * b <= 999) add(`${a * b} ÷ ${b}`, a, Math.max(4, d));
      }
    }
    return rows.length ? rows : [
      { word: "3 + 5", meaning: "8", expression: "3 + 5", answer: "8", difficulty: 2, source: "math" },
      { word: "4 + 4", meaning: "8", expression: "4 + 4", answer: "8", difficulty: 2, source: "math" },
      { word: "12 - 7", meaning: "5", expression: "12 - 7", answer: "5", difficulty: 2, source: "math" },
      { word: "6 × 8", meaning: "48", expression: "6 × 8", answer: "48", difficulty: 4, source: "math" }
    ];
  }

  function mathExpressionValue(text) {
    let expr = String(text || "").trim();
    if (!expr) return null;
    expr = expr
      .replace(/[？?]/g, "")
      .replace(/=/g, "")
      .replace(/×|x|X|＊/g, "*")
      .replace(/÷|／/g, "/")
      .replace(/＋/g, "+")
      .replace(/－/g, "-")
      .replace(/\s+/g, "");
    const m = expr.match(/^(-?\d+(?:\.\d+)?)([+\-*/])(-?\d+(?:\.\d+)?)$/);
    if (!m) return null;
    const a = Number(m[1]);
    const b = Number(m[3]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    switch (m[2]) {
      case "+": return a + b;
      case "-": return a - b;
      case "*": return a * b;
      case "/": return Math.abs(b) < 1e-9 ? null : a / b;
      default: return null;
    }
  }

  function numericTextValue(text) {
    const n = Number(String(text || "").trim());
    return Number.isFinite(n) ? n : null;
  }

  function sameNumber(a, b) {
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-9;
  }

  function mathAnswerValueFromEntry(entry) {
    if (!entry || entry.source !== "math") return null;
    const direct = numericTextValue(entry.answer ?? entry.expectedAnswer ?? "");
    if (Number.isFinite(direct)) return direct;
    const meaningValue = numericTextValue(entry.meaning);
    if (Number.isFinite(meaningValue)) return meaningValue;
    const wordValue = mathExpressionValue(entry.word);
    if (Number.isFinite(wordValue)) return wordValue;
    const exprValue = mathExpressionValue(entry.expression);
    return Number.isFinite(exprValue) ? exprValue : null;
  }

  function mathValueFromAnswerText(text) {
    const numeric = numericTextValue(text);
    if (Number.isFinite(numeric)) return numeric;
    const expr = mathExpressionValue(text);
    return Number.isFinite(expr) ? expr : null;
  }

  function sameStudyAnswerValue(a, b) {
    if (!a || !b) return false;
    if (a.source === "math" || b.source === "math") {
      const av = a.source === "math" ? mathAnswerValueFromEntry(a) : mathValueFromAnswerText(a.meaning);
      const bv = b.source === "math" ? mathAnswerValueFromEntry(b) : mathValueFromAnswerText(b.meaning);
      return sameNumber(av, bv);
    }
    return String(a.meaning || "").trim() === String(b.meaning || "").trim();
  }

  function isCorrectStudyMatch(answerText, targetEntry) {
    if (!targetEntry) return false;
    const proposed = String(answerText || "").trim();
    const expected = String(targetEntry.meaning || "").trim();
    if (!proposed || !expected) return false;
    if (targetEntry.source === "math") {
      const expectedAnswer = mathAnswerValueFromEntry(targetEntry);
      const proposedValue = mathValueFromAnswerText(proposed);
      return sameNumber(proposedValue, expectedAnswer);
    }
    return proposed === expected;
  }

  function prepareStudyEntry(entry, index = 0) {
    if (!entry) return null;
    const mode = normalizeQuizMode(game.quizMode);
    const reverse = mode === "reverse" || (mode === "mixed" && index % 2 === 1);
    if (isMathMode()) {
      const expression = String(entry.expression || entry.word || "").trim();
      const answer = String(entry.answer ?? entry.meaning ?? "").trim();
      if (!expression || !answer) return null;
      return reverse
        ? {
          ...entry,
          word: answer,
          meaning: expression,
          expression,
          answer,
          expectedAnswer: answer,
          source: "math",
          difficulty: Number(entry.difficulty || 2),
          mathDirection: "answerToExpression",
          quizDirection: "答案→算式"
        }
        : {
          ...entry,
          word: expression,
          meaning: answer,
          expression,
          answer,
          expectedAnswer: answer,
          source: "math",
          difficulty: Number(entry.difficulty || 2),
          mathDirection: "expressionToAnswer",
          quizDirection: "算式→答案"
        };
    }
    const originalWord = String(entry.word || "").trim();
    const originalMeaning = String(entry.meaning || "").trim();
    if (!originalWord || !originalMeaning) return null;
    return reverse
      ? { ...entry, word: originalMeaning, meaning: originalWord, sourceWord: originalWord, sourceMeaning: originalMeaning, quizDirection: "中→英" }
      : { ...entry, word: originalWord, meaning: originalMeaning, sourceWord: originalWord, sourceMeaning: originalMeaning, quizDirection: "英→中" };
  }


  function reviewDisplayPair(entry) {
    if (!entry) return { word: "", meaning: "" };
    if (entry.source === "math") {
      const expression = String(entry.expression || entry.word || "").trim();
      const answer = String(entry.answer ?? entry.expectedAnswer ?? entry.meaning ?? "").trim();
      return { word: expression, meaning: answer };
    }
    return {
      word: String(entry.sourceWord || entry.word || "").trim(),
      meaning: String(entry.sourceMeaning || entry.meaning || "").trim()
    };
  }

  function reviewEntryKey(entry) {
    if (!entry) return "";
    const pair = reviewDisplayPair(entry);
    if (entry.source === "math") {
      const value = mathAnswerValueFromEntry(entry);
      return `math:${pair.word}|${pair.meaning}|${Number.isFinite(value) ? value : ""}`;
    }
    return `word:${pair.word}|${pair.meaning}`;
  }

  function ensureReviewStat(entry) {
    const key = reviewEntryKey(entry);
    if (!key) return null;
    const pair = reviewDisplayPair(entry);
    if (!game.reviewStats[key]) {
      game.reviewStats[key] = {
        key,
        word: pair.word,
        meaning: pair.meaning,
        correct: 0,
        wrong: 0,
        death: 0,
        appear: 0,
        lastSeen: 0
      };
    } else {
      if (pair.word) game.reviewStats[key].word = pair.word;
      if (pair.meaning) game.reviewStats[key].meaning = pair.meaning;
    }
    return game.reviewStats[key];
  }

  function markReviewAppearance(entry, amount = 1) {
    const row = ensureReviewStat(entry);
    if (!row) return;
    row.appear += Math.max(1, Number(amount) || 1);
    row.lastSeen = ++game.reviewOrder;
  }

  function markReviewResult(entry, kind, amount = 1) {
    const row = ensureReviewStat(entry);
    if (!row || !(kind in row)) return;
    row[kind] += Math.max(1, Number(amount) || 1);
    row.lastSeen = ++game.reviewOrder;
  }

  function activeRoomReviewEntries() {
    const rows = [];
    if (game.boss?.entry) rows.push(game.boss.entry);
    for (const m of game.monsters || []) if (!m.dead && m.entry) rows.push(m.entry);
    return uniqueStudyEntries(rows);
  }

  function markDeathReview() {
    const active = activeRoomReviewEntries();
    if (!active.length && game.player?.held) {
      const heldText = String(game.player.held || "").trim();
      if (heldText) active.push({ word: heldText, meaning: heldText, source: isMathMode() ? "math" : "word" });
    }
    active.forEach(entry => markReviewResult(entry, "death", 1));
  }

  function gameOverReviewRows(limit = 4) {
    const rows = Object.values(game.reviewStats || {});
    rows.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0) || (b.appear || 0) - (a.appear || 0));
    return rows.slice(0, Math.max(1, limit));
  }

  function buildStudyBank(maxDifficulty = game.difficulty) {
    const source = isMathMode()
      ? makeMathEntries(maxDifficulty)
      : game.words.filter(w => Number(w.difficulty) <= Number(maxDifficulty));
    const prepared = source.map((entry, index) => prepareStudyEntry(entry, index)).filter(Boolean);
    return prepared.length ? prepared : source.filter(Boolean);
  }

  /*
   * 游戏启动入口。页面打开后会先走这里。
   *
   * 本次首屏优化的核心在这里：
   * - boot() 只加载配置、关卡、菜单背景、道具图、当前英雄 idle 预览。
   * - boot() 不加载当前英雄完整动作，不加载所有英雄头像，不加载完整词库。
   * - 完整动作在 startGame() 里加载。
   * - 其他英雄预览在 drawMenu() 中通过 scheduleHeroPreview() 分批懒加载。
   */
  async function boot() {
    beginLoadProgress("正在进入游戏", "读取配置");
    await loadExternalConfigs();

    setLoadStage("读取关卡走廊");
    const bomberLayout = await fetchJsonConfig(ASSETS.levelBomberConfig, null, "关卡走廊布局");
    if (bomberLayout) game.levelConfigs.bomberman = bomberLayout;
    else console.warn("关卡 JSON 加载失败，回退到内置布局");

    setLoadStage("读取首屏素材");
    const selected = selectedHero();

    // 首屏必须资源：当前英雄 idle 预览 + 菜单背景 + 道具图。
    // 注意：这里千万不要写 ...heroActionEntries(selected)，否则又会首屏加载全套动作。
    const imageEntries = [
      [selected.actions?.idle?.imageKey || selected.imageKey, selected.actions?.idle?.src || selected.src],
      ["menuBg", ASSETS.menuBg],
      ["items", ASSETS.items]
    ].filter(([, src]) => Boolean(src));

    await ensureImageEntries(imageEntries, IMAGE_LOAD_CONCURRENCY, "首屏图片素材");
    console.info("[assets] first screen loaded menu background, selected hero preview and items; full hero actions are loaded when entering a run");

    // 音频对象在首屏创建，但浏览器通常不会真正播放，直到用户点击/触摸后才允许播放。
    Object.entries(ASSETS.sounds).forEach(([key, src]) => {
      sounds[key] = loadSound(src);
    });

    syncSelectedStartRoom();
    finishLoadProgress("首屏加载完成");
    loading.style.display = "none";
    game.mode = "menu";
    document.body.dataset.gameMode = game.mode;
    game.message = "\u9009\u62e9\u82f1\u96c4\u548c\u96be\u5ea6\u540e\u5f00\u59cb\u63a2\u9669";
  }

  function play(name, volume = null) {
    if (!game.settings.sound) return;
    const source = sounds[name];
    if (!source) return;
    try {
      const audio = source.cloneNode();
      audio.volume = clamp(Number(volume ?? SOUND_VOLUMES[name] ?? 0.45), 0, 1);
      audio.play().catch(() => {});
    } catch {}
  }

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function len(x, y) {
    return Math.hypot(x, y);
  }

  function norm(v) {
    const l = len(v.x, v.y);
    return l < 0.001 ? { x: 0, y: 0 } : { x: v.x / l, y: v.y / l };
  }

  function dist(a, b) {
    return len(a.x - b.x, a.y - b.y);
  }

  function pickMany(list, count) {
    const pool = [...list];
    const out = [];
    while (pool.length && out.length < count) {
      out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    return out;
  }

  function getMaskImageKeyForRoom(room = game.room) {
    const theme = currentTheme(room);
    return theme?.maskKey || "";
  }

  function buildWalkMaskCache(key) {
    const img = images[key];
    if (!img) return null;
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = W;
    maskCanvas.height = H;
    const maskCtx = maskCanvas.getContext("2d", { willReadFrequently: true });
    maskCtx.drawImage(img, 0, 0, W, H);
    const imageData = maskCtx.getImageData(0, 0, W, H);
    walkMaskCache[key] = { width: W, height: H, data: imageData.data };
    return walkMaskCache[key];
  }

  function currentWalkMask(room = game.room) {
    const key = getMaskImageKeyForRoom(room);
    if (!key) return null;
    return walkMaskCache[key] || buildWalkMaskCache(key);
  }

  function isMaskPixelWalkable(mask, x, y) {
    if (!mask) return true;
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= mask.width || iy >= mask.height) return false;
    const idx = (iy * mask.width + ix) * 4;
    const alpha = mask.data[idx + 3];
    const bright = (mask.data[idx] + mask.data[idx + 1] + mask.data[idx + 2]) / 3;
    return alpha > 10 && bright >= 127;
  }

  function entityFitsCurrentMaskAt(x, y, radius = 16, room = game.room) {
    const mask = currentWalkMask(room);
    if (!mask) return true;
    const probes = [
      [0, 0], [radius, 0], [-radius, 0], [0, radius], [0, -radius],
      [radius * 0.72, radius * 0.72], [radius * 0.72, -radius * 0.72],
      [-radius * 0.72, radius * 0.72], [-radius * 0.72, -radius * 0.72]
    ];
    return probes.every(([ox, oy]) => isMaskPixelWalkable(mask, x + ox, y + oy));
  }

  function entityFitsCurrentMask(entity, radius = null, room = game.room) {
    const r = radius ?? Math.max(10, (entity.r || 18) - 4);
    return canStandAt(entity.x, entity.y, r, room);
  }

  function findNearestWalkablePoint(x, y, radius = 16, maxRadius = 220, room = game.room) {
    if (canStandAt(x, y, radius, room)) return { x, y };
    const ww = worldWidth(room);
    const wh = worldHeight(room);
    for (let ring = 8; ring <= maxRadius; ring += 8) {
      for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 18) {
        const px = clamp(x + Math.cos(angle) * ring, 45, ww - 45);
        const py = clamp(y + Math.sin(angle) * ring, 74, wh - 45);
        if (canStandAt(px, py, radius, room)) return { x: px, y: py };
      }
    }
    return null;
  }

  function moveWithinWalkMask(entity, targetX, targetY, radius = null, room = game.room) {
    const r = radius ?? Math.max(10, (entity.r || 18) - 4);
    const startX = entity.x;
    const startY = entity.y;
    const ww = worldWidth(room);
    const wh = worldHeight(room);
    const tx = clamp(targetX, 45, ww - 45);
    const ty = clamp(targetY, 74, wh - 45);
    if (canStandAt(tx, ty, r, room)) {
      entity.x = tx;
      entity.y = ty;
      return true;
    }
    let moved = false;
    if (canStandAt(tx, startY, r, room)) {
      entity.x = tx;
      moved = true;
    }
    if (canStandAt(entity.x, ty, r, room)) {
      entity.y = ty;
      moved = true;
    }
    if (moved) return true;
    const steps = Math.max(4, Math.ceil(Math.hypot(tx - startX, ty - startY) / 6));
    let bestX = startX, bestY = startY;
    for (let i = 1; i <= steps; i++) {
      const px = startX + (tx - startX) * i / steps;
      const py = startY + (ty - startY) * i / steps;
      if (canStandAt(px, py, r, room)) {
        bestX = px;
        bestY = py;
      }
    }
    entity.x = bestX;
    entity.y = bestY;
    return bestX !== startX || bestY !== startY;
  }

  function clampEntityToWalkMask(entity, fallbackX = entity.x, fallbackY = entity.y, radius = null, room = game.room) {
    if (entityFitsCurrentMask(entity, radius, room)) return;
    const r = radius ?? Math.max(10, (entity.r || 18) - 4);
    const rescue = findNearestWalkablePoint(entity.x, entity.y, r, 150, room)
      || findNearestWalkablePoint(fallbackX, fallbackY, r, 260, room);
    if (rescue) {
      entity.x = rescue.x;
      entity.y = rescue.y;
      return;
    }
    entity.x = clamp(fallbackX, 45, worldWidth(room) - 45);
    entity.y = clamp(fallbackY, 74, worldHeight(room) - 45);
  }

  function randomWalkablePosition(minX = 130, maxX = W - 130, minY = 145, maxY = H - 85, radius = 24, attempts = 100, room = game.room) {
    const ww = worldWidth(room);
    const wh = worldHeight(room);
    const x1 = clamp(minX, 45, ww - 45);
    const x2 = clamp(maxX, x1, ww - 45);
    const y1 = clamp(minY, 74, wh - 45);
    const y2 = clamp(maxY, y1, wh - 45);
    for (let i = 0; i < attempts; i++) {
      const pos = { x: rand(x1, x2), y: rand(y1, y2) };
      if (canStandAt(pos.x, pos.y, radius, room)) return pos;
    }
    return findNearestWalkablePoint((x1 + x2) / 2, (y1 + y2) / 2, radius, 320, room)
      || { x: clamp((x1 + x2) / 2, 45, ww - 45), y: clamp((y1 + y2) / 2, 74, wh - 45) };
  }

  function randomTokenPosition() {
    return randomWalkablePosition(130, worldWidth() - 130, 145, worldHeight() - 85, 24);
  }

  function separatedSpawn(edge, radius = 62, playerSafeRadius = 230) {
    let best = null;
    let bestScore = -1;
    const ww = worldWidth();
    const wh = worldHeight();
    for (let attempt = 0; attempt < 80; attempt++) {
      const pos = edge === 0
        ? { x: rand(90, ww - 90), y: 110 }
        : edge === 1
          ? { x: ww - 90, y: rand(125, wh - 90) }
          : edge === 2
            ? { x: rand(90, ww - 90), y: wh - 90 }
            : { x: 90, y: rand(125, wh - 90) };
      if (!canStandAt(pos.x, pos.y, Math.max(20, radius * 0.4))) continue;
      const nearest = game.monsters.length ? Math.min(...game.monsters.map(m => dist(pos, m))) : 999;
      const playerGap = game.player ? dist(pos, game.player) : 999;
      const score = Math.min(nearest, playerGap);
      if (nearest > radius && playerGap > playerSafeRadius) return pos;
      if (score > bestScore) {
        best = pos;
        bestScore = score;
      }
    }
    if (best && (!game.player || dist(best, game.player) > Math.min(150, playerSafeRadius))) return best;
    return randomWalkablePosition(120, ww - 120, 120, wh - 190, 26);
  }


  function isBomberTheme(room = game.room) {
    return true;
  }

  function worldWidth(room = game.room) {
    return BOMBER_GRID.x * 2 + BOMBER_GRID.cols * BOMBER_GRID.tile;
  }

  function worldHeight(room = game.room) {
    return BOMBER_GRID.y * 2 + BOMBER_GRID.rows * BOMBER_GRID.tile;
  }

  function updateCamera() {
    if (!game.player) { game.camera.x = 0; game.camera.y = 0; return game.camera; }
    game.camera.x = clamp(game.player.x - W / 2, 0, Math.max(0, worldWidth() - W));
    game.camera.y = clamp(game.player.y - H / 2, 0, Math.max(0, worldHeight() - H));
    return game.camera;
  }

  function screenToWorldPoint(pos) {
    if (game.mode === "playing") return { x: pos.x + game.camera.x, y: pos.y + game.camera.y };
    return { x: pos.x, y: pos.y };
  }

  function worldToScreenPoint(pos) {
    return { x: pos.x - game.camera.x, y: pos.y - game.camera.y };
  }

  function getMonsterAiClassByGrade(grade) {
    const normalized = normalizeMonsterGrade(grade, "E");
    return MONSTER_AI_CLASSES.find(item => normalizeMonsterGrade(item.grade) === normalized) || MONSTER_AI_CLASSES[MONSTER_AI_CLASSES.length - 1] || { grade: "E", name: "E类怪物", aggroTiles: 1, baseSpeed: 40, touchDamage: 6 };
  }

  function monsterAiFor(index = 0, room = game.room) {
    // 兼容旧逻辑：如果某些旧代码还调用 monsterAiFor，就仍然能返回一个等级。
    // v78 主生成流程已经不再用“房间+序号轮换等级”，而是走 monsterSpawnPlanForRoom()。
    return MONSTER_AI_CLASSES[(room + index) % MONSTER_AI_CLASSES.length];
  }

  function monsterTypesByGrade(grade) {
    const normalized = normalizeMonsterGrade(grade, "E");
    return MONSTER_TYPES.filter(type => normalizeMonsterGrade(type.grade) === normalized);
  }

  function nearestAvailableMonsterTypes(grade) {
    /*
     * 给扩展等级预留的兜底函数。
     *
     * 例如你后面在 gradeSpawnRules 里写了 S 类，但还没放 S 类怪物素材，
     * 游戏不会直接报错卡死，而是尝试找相邻等级的怪物外观顶上。
     * 正式发布前仍然建议把对应等级素材补齐。
     */
    const normalized = normalizeMonsterGrade(grade, "E");
    const exact = monsterTypesByGrade(normalized);
    if (exact.length) return exact;

    const currentIndex = MONSTER_GRADE_ORDER.indexOf(normalized);
    if (currentIndex >= 0) {
      for (let offset = 1; offset < MONSTER_GRADE_ORDER.length; offset += 1) {
        const lower = MONSTER_GRADE_ORDER[currentIndex - offset];
        const higher = MONSTER_GRADE_ORDER[currentIndex + offset];
        if (lower) {
          const list = monsterTypesByGrade(lower);
          if (list.length) return list;
        }
        if (higher) {
          const list = monsterTypesByGrade(higher);
          if (list.length) return list;
        }
      }
    }
    return MONSTER_TYPES.length ? MONSTER_TYPES : [];
  }

  function monsterTypeForGrade(grade, index = 0) {
    const list = nearestAvailableMonsterTypes(grade);
    if (!list.length) return null;
    return list[index % list.length];
  }

  function gradeSpawnRuleForRoom(room = game.room) {
    const currentRoom = Math.max(1, Number(room) || 1);
    let matched = null;
    for (const rule of MONSTER_GRADE_SPAWN_RULES || []) {
      const from = Math.max(1, Number(rule.fromRoom || rule.from || 1));
      const to = Number.isFinite(Number(rule.toRoom || rule.to)) ? Number(rule.toRoom || rule.to) : Infinity;
      if (currentRoom >= from && currentRoom <= to) matched = rule;
    }
    return matched || MONSTER_GRADE_SPAWN_RULES[MONSTER_GRADE_SPAWN_RULES.length - 1] || { counts: { E: 3, D: 1 } };
  }

  function monsterGradeCountsForRoom(room = game.room) {
    const rule = gradeSpawnRuleForRoom(room);
    const counts = rule?.counts || {};
    const result = {};
    for (const [grade, count] of Object.entries(counts)) {
      const normalized = normalizeMonsterGrade(grade);
      const n = Math.max(0, Math.floor(Number(count) || 0));
      if (n > 0) result[normalized] = (result[normalized] || 0) + n;
    }
    return result;
  }

  function monsterSpawnPlanForRoom(room = game.room) {
    /*
     * 根据“当前关卡”生成本房间怪物计划。
     *
     * 返回值示例：
     * [
     *   { grade: "D", ai: D类配置, spriteConfig: D类某个怪物 },
     *   { grade: "C", ai: C类配置, spriteConfig: C类某个怪物 }
     * ]
     *
     * 注意：这里只决定“生成哪些等级和外观”，不决定词条。
     * 词条仍然由 roomWords 分配，保持词库逻辑独立。
     */
    const counts = monsterGradeCountsForRoom(room);
    const plan = [];
    const useOrder = MONSTER_GRADE_ORDER.filter(g => counts[g] > 0).concat(Object.keys(counts).filter(g => !MONSTER_GRADE_ORDER.includes(g)));
    for (const grade of useOrder) {
      const ai = getMonsterAiClassByGrade(grade);
      const count = Math.max(0, Math.floor(Number(counts[grade]) || 0));
      for (let i = 0; i < count; i += 1) {
        const spriteConfig = monsterTypeForGrade(grade, room + i);
        plan.push({ grade, ai, spriteConfig });
      }
    }
    return pickMany(plan, plan.length);
  }

  function monsterRoomGrowth(room = game.room) {
    return Math.max(0, (Number(room) || 1) - 1);
  }

  function effectiveMonsterAggroTiles(monster) {
    const ai = monster?.aiConfig || getMonsterAiClassByGrade(monster?.aiClass || monster?.grade || "E");

    // base：等级原始追踪格数，来自 assets/config/monsters.json 的 aiClasses.aggroTiles。
    // 例如默认 A=5、B=4、C=3、D=2、E=1。
    const base = Number(monster?.baseAggroTiles ?? monster?.aggroTiles ?? ai.aggroTiles ?? 3);

    // v77 保留项：地图变大后，所有怪物在基础追踪上统一 +3 格。
    const mapBonus = MONSTER_AGGRO_TILE_BONUS;

    // v78 新增：追踪距离随关卡成长。
    // aggroGrowthPerRoom=0.25 的意思是：每过 4 关，大约多追 1 格。
    const growthPerRoom = Number(monster?.aggroGrowthPerRoom ?? ai.aggroGrowthPerRoom ?? 0);
    const roomBonus = Math.floor(monsterRoomGrowth() * growthPerRoom);
    const boostedBase = base + mapBonus + roomBonus;

    // 错误命中后的警觉状态不能小于普通追踪距离，所以取较大值。
    return monster?.wrongAggroTimer > 0 ? Math.max(boostedBase, WRONG_HIT_AGGRO_TILES) : boostedBase;
  }

  function effectiveMonsterSpeed(monster) {
    const ai = monster?.aiConfig || getMonsterAiClassByGrade(monster?.aiClass || monster?.grade || "E");
    const base = Number(monster?.baseSpeed ?? ai.baseSpeed ?? ai.speed ?? 48);
    const growthPerRoom = Number(monster?.speedGrowthPerRoom ?? ai.speedGrowthPerRoom ?? 0);
    return base + monsterRoomGrowth() * growthPerRoom;
  }

  function monsterTouchDamage(monster) {
    const ai = monster?.aiConfig || getMonsterAiClassByGrade(monster?.aiClass || monster?.grade || "E");
    const base = Number(monster?.touchDamage ?? ai.touchDamage ?? ai.damage ?? 12);
    const growthPerRoom = Number(monster?.damageGrowthPerRoom ?? ai.damageGrowthPerRoom ?? 0);
    return Math.max(1, Math.round(base + monsterRoomGrowth() * growthPerRoom));
  }

  function triggerWrongHitAggro(monster) {
    if (!monster || monster.dead) return;
    monster.wrongAggroTimer = WRONG_HIT_AGGRO_DURATION;
    monster.wrongSpeedTimer = WRONG_HIT_AGGRO_DURATION;
    monster.baseAggroTiles = monster.baseAggroTiles || monster.aggroTiles || 3;
    monster.tileTarget = null;
    addFloat(`警觉 ${effectiveMonsterAggroTiles(monster)}格 · 加速×${WRONG_HIT_SPEED_MULT} 15s`, monster.x - 74, monster.y - 72, "#ff6f7d");
  }

  function nearestBomberCellCenter(x, y, radius = 16) {
    const raw = pointToBomberCell(x, y);
    let best = null;
    let bestScore = Infinity;
    for (let ring = 0; ring <= 6; ring++) {
      const rowMin = clamp(raw.row - ring, 1, BOMBER_GRID.rows - 2);
      const rowMax = clamp(raw.row + ring, 1, BOMBER_GRID.rows - 2);
      const colMin = clamp(raw.col - ring, 1, BOMBER_GRID.cols - 2);
      const colMax = clamp(raw.col + ring, 1, BOMBER_GRID.cols - 2);
      for (let row = rowMin; row <= rowMax; row++) {
        for (let col = colMin; col <= colMax; col++) {
          if (Math.max(Math.abs(col - raw.col), Math.abs(row - raw.row)) !== ring) continue;
          const c = bomberCellCenter(col, row);
          if (!canStandAt(c.x, c.y, radius)) continue;
          const score = Math.hypot(c.x - x, c.y - y);
          if (score < bestScore) {
            best = { ...c, col, row };
            bestScore = score;
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  function directionToNeighborCell(entity, dir, radius = null) {
    const r = radius ?? Math.max(12, (entity.r || 18) - 3);
    const c = pointToBomberCell(entity.x, entity.y);
    const col = clamp(c.col + (dir.x || 0), 1, BOMBER_GRID.cols - 2);
    const row = clamp(c.row + (dir.y || 0), 1, BOMBER_GRID.rows - 2);
    const center = bomberCellCenter(col, row);
    if (!canStandAt(center.x, center.y, r)) return null;
    return { ...center, col, row };
  }

  function gridDirectionFromInput(input, fallbackFacing = 0) {
    const x = Number(input?.x || 0);
    const y = Number(input?.y || 0);
    if (Math.abs(x) + Math.abs(y) < 0.16) return null;
    if (Math.abs(x) >= Math.abs(y)) {
      const sx = x < 0 ? -1 : 1;
      return { x: sx, y: 0, facing: sx < 0 ? 1 : 2 };
    }
    const sy = y < 0 ? -1 : 1;
    return { x: 0, y: sy, facing: sy < 0 ? 3 : 0 };
  }

  function resetPlayerGridMove() {
    if (!game.player) return;
    game.player.tileReady = false;
    game.player.tileTarget = null;
    game.player.gridDir = null;
  }

  function updateGridPlayerMovement(p, rawMove, dt) {
    const radius = Math.max(10, p.r - 4);
    const dir = gridDirectionFromInput(rawMove, p.facing);

    if (!p.tileReady) {
      const snap = nearestBomberCellCenter(p.x, p.y, radius);
      if (snap) {
        p.x = snap.x;
        p.y = snap.y;
      }
      p.tileReady = true;
      p.tileTarget = null;
      p.gridDir = null;
    }

    if (!p.tileTarget) {
      const c = pointToBomberCell(p.x, p.y);
      const center = bomberCellCenter(clamp(c.col, 1, BOMBER_GRID.cols - 2), clamp(c.row, 1, BOMBER_GRID.rows - 2));
      if (Math.abs(p.x - center.x) > 1.5 || Math.abs(p.y - center.y) > 1.5) {
        p.tileTarget = { ...center, col: c.col, row: c.row };
      } else if (dir) {
        const target = directionToNeighborCell(p, dir, radius);
        if (target) {
          p.tileTarget = target;
          p.gridDir = dir;
          p.facing = dir.facing;
        } else {
          p.facing = dir.facing;
          p.walk = 0;
          return;
        }
      }
    }

    if (!p.tileTarget) {
      p.walk = 0;
      if (dir) p.facing = dir.facing;
      return;
    }

    const fromX = p.x;
    const fromY = p.y;
    const step = Math.max(1, effectivePlayerSpeed() * dt);
    const dx = p.tileTarget.x - p.x;
    const dy = p.tileTarget.y - p.y;
    const axisX = Math.abs(dx) >= Math.abs(dy);

    if (axisX && Math.abs(dx) > 0.05) {
      p.x += Math.sign(dx) * Math.min(Math.abs(dx), step);
    } else if (Math.abs(dy) > 0.05) {
      p.y += Math.sign(dy) * Math.min(Math.abs(dy), step);
    }

    if (!canStandAt(p.x, p.y, radius)) {
      p.x = fromX;
      p.y = fromY;
      p.tileTarget = null;
      p.gridDir = null;
      p.walk = 0;
      return;
    }

    p.walk += dt;
    if (p.gridDir?.x || p.gridDir?.y) p.facing = p.gridDir.facing;

    if (Math.abs(p.x - p.tileTarget.x) <= 1.2 && Math.abs(p.y - p.tileTarget.y) <= 1.2) {
      p.x = p.tileTarget.x;
      p.y = p.tileTarget.y;
      p.tileTarget = null;
      p.gridDir = null;
      if (!dir) p.walk = 0;
    }
  }

  function chooseBomberTileTarget(monster, chasing) {
    const dirs = [];
    if (chasing && game.player) {
      const dx = game.player.x - monster.x;
      const dy = game.player.y - monster.y;
      const primary = Math.abs(dx) >= Math.abs(dy)
        ? [{ x: Math.sign(dx), y: 0, facing: dx < 0 ? 1 : 2 }, { x: 0, y: Math.sign(dy), facing: dy < 0 ? 3 : 0 }]
        : [{ x: 0, y: Math.sign(dy), facing: dy < 0 ? 3 : 0 }, { x: Math.sign(dx), y: 0, facing: dx < 0 ? 1 : 2 }];
      dirs.push(...primary.filter(d => d.x || d.y));
    }
    dirs.push(...pickMany(BOMBER_DIRS, BOMBER_DIRS.length));
    for (const d of dirs) {
      const target = directionToNeighborCell(monster, d);
      if (!target) continue;
      monster.dir = d;
      monster.facing = d.facing ?? monster.facing ?? 0;
      return target;
    }
    return null;
  }

  function circleRectOverlap(cx, cy, r, rect) {
    const nearestX = clamp(cx, rect.x, rect.x + rect.w);
    const nearestY = clamp(cy, rect.y, rect.y + rect.h);
    return Math.hypot(cx - nearestX, cy - nearestY) < r;
  }

  function isBlockedByBomberBlocksAt(x, y, radius = 16) {
    if (!game.bomberBlocks || !game.bomberBlocks.length) return false;
    return game.bomberBlocks.some(block => circleRectOverlap(x, y, radius, block));
  }

  function isBlockedByHardBomberBlocksAt(x, y, radius = 16) {
    if (!game.bomberBlocks || !game.bomberBlocks.length) return false;
    return game.bomberBlocks.some(block => block.kind === "hard" && circleRectOverlap(x, y, radius, block));
  }

  function bomberBlockAtCell(col, row) {
    return (game.bomberBlocks || []).find(block => block.col === col && block.row === row) || null;
  }

  function canGridDashToCell(startCell, dir, cells, radius = 16) {
    const targetCol = clamp(startCell.col + dir.x * cells, 1, BOMBER_GRID.cols - 2);
    const targetRow = clamp(startCell.row + dir.y * cells, 1, BOMBER_GRID.rows - 2);

    // 被边界 clamp 回原地时不算有效闪现。
    if (targetCol === startCell.col && targetRow === startCell.row) return null;

    const targetBlock = bomberBlockAtCell(targetCol, targetRow);
    if (targetBlock) return null; // 落点必须是空格，不能落到砖墙/硬墙里。

    // 路径中硬墙永远不能越过；砖墙只允许作为中间格被越过。
    for (let step = 1; step < cells; step++) {
      const midCol = startCell.col + dir.x * step;
      const midRow = startCell.row + dir.y * step;
      const midBlock = bomberBlockAtCell(midCol, midRow);
      if (midBlock?.kind === "hard") return null;
    }

    const target = bomberCellCenter(targetCol, targetRow);
    if (!canDashLandAt(target.x, target.y, radius)) return null;
    return { ...target, col: targetCol, row: targetRow };
  }

  function canDashLandAt(x, y, radius = 16, room = game.room) {
    const ww = worldWidth(room);
    const wh = worldHeight(room);
    if (x < 45 || y < 74 || x > ww - 45 || y > wh - 45) return false;
    return entityFitsCurrentMaskAt(x, y, radius, room) && !isBlockedByBomberBlocksAt(x, y, radius);
  }

  function canStandAt(x, y, radius = 16, room = game.room) {
    const ww = worldWidth(room);
    const wh = worldHeight(room);
    if (x < 45 || y < 74 || x > ww - 45 || y > wh - 45) return false;
    return entityFitsCurrentMaskAt(x, y, radius, room) && !isBlockedByBomberBlocksAt(x, y, radius);
  }

  function bomberLevelConfig() {
    return game.levelConfigs?.bomberman || null;
  }

  function bomberLayoutRows() {
    const cfg = bomberLevelConfig();
    const rows = Array.isArray(cfg?.layout) ? cfg.layout : null;
    if (!rows?.length) return null;
    return rows.map(row => String(row || ""));
  }

  function cellTypeFromLayout(rows, col, row) {
    if (!rows || row < 0 || row >= rows.length) return null;
    const ch = rows[row]?.[col] || ".";
    if (ch === "#") return "hard";
    if (ch === "B") return "brick";
    if (ch === "S") return "safe";
    return "empty";
  }

  function buildBomberBlocks(roomEntries = [], bossRoom = false) {
    const blocks = [];
    const hiddenEntries = pickMany(roomEntries.filter(Boolean), bossRoom ? 4 : 3);
    const hiddenByCell = new Map();
    const hiddenPickupByCell = new Map();
    const candidateCells = [];
    const layoutRows = bomberLayoutRows();

    if (layoutRows) {
      for (let row = 0; row < Math.min(BOMBER_GRID.rows, layoutRows.length); row++) {
        for (let col = 0; col < Math.min(BOMBER_GRID.cols, layoutRows[row].length); col++) {
          if (cellTypeFromLayout(layoutRows, col, row) === "brick") candidateCells.push([col, row]);
        }
      }
    } else {
      for (let row = 1; row < BOMBER_GRID.rows - 1; row++) {
        for (let col = 1; col < BOMBER_GRID.cols - 1; col++) {
          if (col % 2 === 0 && row % 2 === 0) continue;
          candidateCells.push([col, row]);
        }
      }
    }

    const entryCells = pickMany(candidateCells, hiddenEntries.length);
    entryCells.forEach(([col, row], i) => hiddenByCell.set(`${col},${row}`, hiddenEntries[i]));

    const hiddenPickupCount = bossRoom ? HIDDEN_ROOM_PICKUPS + 1 : HIDDEN_ROOM_PICKUPS;
    const hiddenPickupTypes = pickMany(roomPickupPool(), hiddenPickupCount);
    const hiddenPickupPool = candidateCells.filter(([col, row]) => !hiddenByCell.has(`${col},${row}`));
    const hiddenPickupCells = pickMany(hiddenPickupPool, hiddenPickupTypes.length);
    hiddenPickupCells.forEach(([col, row], i) => hiddenPickupByCell.set(`${col},${row}`, hiddenPickupTypes[i]));

    const doorPool = candidateCells.filter(([col, row]) => !hiddenByCell.has(`${col},${row}`) && !hiddenPickupByCell.has(`${col},${row}`));
    const doorCell = pickMany(doorPool.length ? doorPool : candidateCells, 1)[0] || null;
    const doorKey = doorCell ? `${doorCell[0]},${doorCell[1]}` : "";

    for (let row = 0; row < BOMBER_GRID.rows; row++) {
      for (let col = 0; col < BOMBER_GRID.cols; col++) {
        const x = BOMBER_GRID.x + col * BOMBER_GRID.tile;
        const y = BOMBER_GRID.y + row * BOMBER_GRID.tile;
        const key = `${col},${row}`;
        let type = layoutRows ? cellTypeFromLayout(layoutRows, col, row) : null;

        if (!type) {
          const border = col === 0 || row === 0 || col === BOMBER_GRID.cols - 1 || row === BOMBER_GRID.rows - 1;
          const pillar = col % 2 === 0 && row % 2 === 0;
          const safe = (
            (Math.abs(col - Math.floor(BOMBER_GRID.cols / 2)) <= 1 && row >= BOMBER_GRID.rows - 4) ||
            (Math.abs(col - Math.floor(BOMBER_GRID.cols / 2)) <= 1 && row <= 3) ||
            (col <= 2 && row <= 2) ||
            (col >= BOMBER_GRID.cols - 3 && row <= 2) ||
            (col <= 2 && row >= BOMBER_GRID.rows - 3) ||
            (col >= BOMBER_GRID.cols - 3 && row >= BOMBER_GRID.rows - 3)
          );
          if (border || pillar) type = "hard";
          else if (!safe && Math.random() < (bossRoom ? 0.22 : 0.28)) type = "brick";
          else type = "empty";
        }

        if (type === "hard") {
          blocks.push({ kind: "hard", col, row, x, y, w: BOMBER_GRID.tile, h: BOMBER_GRID.tile, hp: 999 });
        } else if (type === "brick") {
          blocks.push({
            kind: "brick",
            col, row,
            x, y,
            w: BOMBER_GRID.tile,
            h: BOMBER_GRID.tile,
            hp: 2,
            maxHp: 2,
            storedMeanings: [],
            hiddenEntry: hiddenByCell.get(key) || null,
            hiddenPickup: hiddenPickupByCell.get(key) || null,
            hiddenDoor: key === doorKey
          });
        }
      }
    }
    return blocks;
  }

  function refreshRandomTranslation(x = null, y = null, glow = 1.0) {
    const entry = pickMany(game.bank.length ? game.bank : game.words, 1)[0];
    if (!entry) return;
    const pos = Number.isFinite(x) && Number.isFinite(y)
      ? (findNearestWalkablePoint(x, y, 24, 260) || randomWalkablePosition(130, worldWidth() - 130, 145, worldHeight() - 85, 24))
      : randomWalkablePosition(130, worldWidth() - 130, 145, worldHeight() - 85, 24);
    spawnTokenAt(entry, pos.x, pos.y, glow);
    if (entry.word) game.runSeen.add(entry.word);
  }

  function refreshMeaningByText(meaning, x = null, y = null, glow = 1.0) {
    if (!meaning) return false;
    const entry = replacementEntry(meaning);
    if (!entry) return false;
    const pos = Number.isFinite(x) && Number.isFinite(y)
      ? (findNearestWalkablePoint(x, y, 24, 260) || randomWalkablePosition(130, worldWidth() - 130, 145, worldHeight() - 85, 24))
      : randomWalkablePosition(130, worldWidth() - 130, 145, worldHeight() - 85, 24);
    spawnTokenAt(entry, pos.x, pos.y, glow);
    if (entry.word) game.runSeen.add(entry.word);
    return true;
  }

  function remainingEnemyCount() {
    return game.monsters.filter(m => !m.dead).length + (game.boss ? 1 : 0);
  }

  function revealDoorFromBlock(block) {
    if (!block?.hiddenDoor) return;
    game.door = {
      x: block.x + block.w / 2,
      y: block.y + block.h / 2,
      r: 24,
      revealed: true,
      active: false,
      pulse: 0
    };
    addFloat("小门出现", game.door.x - 28, game.door.y - 34, "#8ef3ff");
    activateDoorIfReady();
  }

  function activateDoorIfReady() {
    if (remainingEnemyCount() > 0) return false;
    if (game.door?.revealed) game.door.active = true;
    if (!game.clearAnnounced) {
      game.clearAnnounced = true;
      game.message = game.door?.revealed ? "小门已激活，进入小门到下一关" : "怪物已清空，继续打砖寻找小门";
      play("clear");
      saveRun();
    }
    return true;
  }

  function enterDoor() {
    if (!game.door?.active || game.mode !== "playing") return;
    addFloat("进入下一关", game.player.x - 34, game.player.y - 52, "#9ff7ff");
    play("clear");
    nextRoom();
  }

  function updateDoor(dt) {
    if (!game.door?.revealed || !game.player) {
      activateDoorIfReady();
      return;
    }
    game.door.pulse = (game.door.pulse || 0) + dt;
    activateDoorIfReady();
    if (game.door.active && dist(game.player, game.door) < game.player.r + game.door.r + 8) {
      enterDoor();
    }
  }

  function spawnStoredMeaningsAtBlock(block) {
    const meanings = Array.isArray(block?.storedMeanings) ? block.storedMeanings.filter(Boolean) : [];
    const cx = block.x + block.w / 2;
    const cy = block.y + block.h / 2;
    const offsets = meanings.length <= 1
      ? [{ x: 0, y: 0 }]
      : [{ x: -18, y: 0 }, { x: 18, y: 0 }, { x: 0, y: -18 }, { x: 0, y: 18 }];

    meanings.forEach((meaning, i) => {
      const entry = replacementEntry(meaning);
      const off = offsets[i % offsets.length];
      spawnTokenAt(entry, cx + off.x, cy + off.y, 1.45);
      if (entry.word) game.runSeen.add(entry.word);
    });
  }

  function breakBomberBrick(block, source = null, opts = {}) {
    if (!block || block.kind !== "brick") return false;

    block.maxHp = block.maxHp || 2;
    block.hp = Number.isFinite(block.hp) ? block.hp : block.maxHp;
    block.storedMeanings = Array.isArray(block.storedMeanings) ? block.storedMeanings : [];

    const absorbMeaning = opts.absorbMeaning !== false;
    if (absorbMeaning && source?.meaning) block.storedMeanings.push(source.meaning);
    block.hp -= Math.max(1, Number(opts.damage || 1));

    if (block.hp > 0) {
      block.hitFlash = 0.28;
      addFloat(opts.pierce ? "穿透-1" : "红砖受击", block.x + 8, block.y - 8, opts.pierce ? "#ffd37a" : "#ffb08a");
      play("hit");
      return false;
    }

    game.bomberBlocks = game.bomberBlocks.filter(item => item !== block);
    revealDoorFromBlock(block);

    let tip = opts.pierce ? "穿透破砖" : "翻译返还";
    if (block.hiddenDoor) tip = "发现小门";
    else if (block.hiddenPickup) tip = "隐藏道具";
    else if (block.hiddenEntry) tip = "隐藏翻译";
    addFloat(tip, block.x + 8, block.y - 8, "#8ef3ff");

    // 普通子弹会把被红砖吸收的翻译返还；穿透子弹不把同一个翻译复制进每块砖。
    spawnStoredMeaningsAtBlock(block);

    if (block.hiddenEntry) spawnTokenAt(block.hiddenEntry, block.x + block.w / 2, block.y + block.h / 2, 1.5);
    if (block.hiddenPickup) dropPickupAt(block.x + block.w / 2, block.y + block.h / 2, block.hiddenPickup, true);

    if (!block.storedMeanings.length && !opts.pierce) refreshRandomTranslation(block.x + block.w / 2, block.y + block.h / 2, 1.0);
    play("hit");
    return true;
  }

  function resolveBomberBlockCollision(entity, extra = 0) {
    if (!entity || !game.bomberBlocks?.length) return;
    for (const block of game.bomberBlocks) {
      const r = (entity.r || 18) + extra;
      if (!circleRectOverlap(entity.x, entity.y, r, block)) continue;
      const nearestX = clamp(entity.x, block.x, block.x + block.w);
      const nearestY = clamp(entity.y, block.y, block.y + block.h);
      let dx = entity.x - nearestX;
      let dy = entity.y - nearestY;
      let d = Math.hypot(dx, dy);
      if (d < 0.001) {
        const left = Math.abs(entity.x - block.x);
        const right = Math.abs(entity.x - (block.x + block.w));
        const top = Math.abs(entity.y - block.y);
        const bottom = Math.abs(entity.y - (block.y + block.h));
        const minSide = Math.min(left, right, top, bottom);
        if (minSide === left) { dx = -1; dy = 0; d = 1; }
        else if (minSide === right) { dx = 1; dy = 0; d = 1; }
        else if (minSide === top) { dx = 0; dy = -1; d = 1; }
        else { dx = 0; dy = 1; d = 1; }
      }
      const push = Math.max(0, r - d) + 0.5;
      entity.x += dx / d * push;
      entity.y += dy / d * push;
    }
  }

  function bomberProjectileHit(pr) {
    if (!game.bomberBlocks?.length || pr.enemy) return false;
    const r = pr.radius || 8;
    pr.hitBrickKeys = pr.hitBrickKeys || new Set();

    for (const block of [...game.bomberBlocks]) {
      if (!circleRectOverlap(pr.x, pr.y, r, block)) continue;

      if (block.kind === "brick") {
        const blockKey = `${block.col},${block.row}`;

        if (pr.pierceWalls) {
          if (pr.hitBrickKeys.has(blockKey)) continue;
          pr.hitBrickKeys.add(blockKey);
          breakBomberBrick(block, pr, { pierce: true, absorbMeaning: false, damage: 1 });
          continue;
        }

        breakBomberBrick(block, pr, { absorbMeaning: true, damage: 1 });
        pr.returned = true;
        pr.life = 0;
        return true;
      }

      addFloat("墙体阻挡", pr.x - 22, pr.y - 20, "#d6f2ff");
      returnProjectileMeaningRandom(pr, 1.05);
      pr.life = 0;
      return true;
    }

    // 穿透红砖不停止子弹，也不阻止当帧继续判定怪物/Boss。
    return false;
  }

  function chooseBomberDirection(monster, allowReverse = false) {
    const dirs = pickMany(BOMBER_DIRS, BOMBER_DIRS.length);
    const current = monster.dir || { x: 0, y: 0 };
    const options = [];
    for (const d of dirs) {
      if (!allowReverse && current.x === -d.x && current.y === -d.y && Math.random() < 0.65) continue;
      const tx = monster.x + d.x * BOMBER_GRID.tile * 0.45;
      const ty = monster.y + d.y * BOMBER_GRID.tile * 0.45;
      if (canStandAt(tx, ty, Math.max(12, monster.r - 3))) options.push(d);
    }
    if (!options.length) options.push(...dirs.filter(d => canStandAt(monster.x + d.x * 12, monster.y + d.y * 12, Math.max(12, monster.r - 3))));
    return options.length ? pickMany(options, 1)[0] : { x: 0, y: 0, facing: monster.facing || 0 };
  }

  function chooseBomberChaseDirection(monster) {
    const p = game.player;
    if (!p) return chooseBomberDirection(monster, true);
    const dx = p.x - monster.x;
    const dy = p.y - monster.y;
    const preferred = Math.abs(dx) > Math.abs(dy)
      ? [{ x: Math.sign(dx), y: 0, facing: dx < 0 ? 1 : 2 }, { x: 0, y: Math.sign(dy), facing: dy < 0 ? 3 : 0 }]
      : [{ x: 0, y: Math.sign(dy), facing: dy < 0 ? 3 : 0 }, { x: Math.sign(dx), y: 0, facing: dx < 0 ? 1 : 2 }];
    for (const d of preferred) {
      if (!d.x && !d.y) continue;
      if (canStandAt(monster.x + d.x * BOMBER_GRID.tile * 0.45, monster.y + d.y * BOMBER_GRID.tile * 0.45, Math.max(12, monster.r - 3))) return d;
    }
    return chooseBomberDirection(monster, true);
  }

  function updateBomberMonster(monster, dt, scale) {
    const p = game.player;
    if (monster.wrongAggroTimer > 0) monster.wrongAggroTimer = Math.max(0, monster.wrongAggroTimer - dt);
    if (monster.wrongSpeedTimer > 0) monster.wrongSpeedTimer = Math.max(0, monster.wrongSpeedTimer - dt);

    const radius = Math.max(12, monster.r - 3);
    const aggroPx = effectiveMonsterAggroTiles(monster) * BOMBER_GRID.tile;
    const chasing = p && dist(monster, p) <= aggroPx;

    // 怪物按“格子中心 -> 相邻格子中心”的方式移动，避免斜向卡在墙角或对角线。
    if (!monster.tileReady) {
      const snap = nearestBomberCellCenter(monster.x, monster.y, radius);
      if (snap) {
        monster.x = snap.x;
        monster.y = snap.y;
      }
      monster.tileReady = true;
      monster.tileTarget = null;
    }

    if (!monster.tileTarget) {
      const c = pointToBomberCell(monster.x, monster.y);
      const center = bomberCellCenter(clamp(c.col, 1, BOMBER_GRID.cols - 2), clamp(c.row, 1, BOMBER_GRID.rows - 2));
      if (Math.abs(monster.x - center.x) > 2 || Math.abs(monster.y - center.y) > 2) {
        monster.tileTarget = { ...center, col: c.col, row: c.row };
      } else {
        const shouldTurn = chasing || !monster.dir || monster.turnCd <= 0 || Math.random() < 0.018;
        if (shouldTurn) {
          monster.tileTarget = chooseBomberTileTarget(monster, chasing);
          monster.turnCd = chasing ? 0.12 : rand(0.45, 1.25);
        } else {
          monster.tileTarget = directionToNeighborCell(monster, monster.dir) || chooseBomberTileTarget(monster, false);
        }
      }
    }

    if (!monster.tileTarget) return;

    const speedBoost = monster.wrongSpeedTimer > 0 ? WRONG_HIT_SPEED_MULT : 1;
    const speed = effectiveMonsterSpeed(monster) * scale * (chasing ? 1.05 : 0.88) * speedBoost;
    const step = Math.max(1, speed * dt);
    const dx = monster.tileTarget.x - monster.x;
    const dy = monster.tileTarget.y - monster.y;
    const axisX = Math.abs(dx) >= Math.abs(dy);

    const fromX = monster.x;
    const fromY = monster.y;
    if (axisX && Math.abs(dx) > 0.1) {
      monster.x += Math.sign(dx) * Math.min(Math.abs(dx), step);
    } else if (Math.abs(dy) > 0.1) {
      monster.y += Math.sign(dy) * Math.min(Math.abs(dy), step);
    }

    if (!canStandAt(monster.x, monster.y, radius)) {
      monster.x = fromX;
      monster.y = fromY;
      monster.tileTarget = null;
      monster.dir = chooseBomberDirection(monster, true);
      monster.turnCd = 0;
      return;
    }

    if (Math.abs(monster.x - monster.tileTarget.x) <= 1.2 && Math.abs(monster.y - monster.tileTarget.y) <= 1.2) {
      monster.x = monster.tileTarget.x;
      monster.y = monster.tileTarget.y;
      monster.tileTarget = null;
      monster.turnCd -= dt;
    }

    if (monster.dir?.x || monster.dir?.y) {
      monster.facing = Math.abs(monster.dir.x) > Math.abs(monster.dir.y)
        ? (monster.dir.x < 0 ? 1 : 2)
        : (monster.dir.y < 0 ? 3 : 0);
    }
  }

  function updateMotionAnimation(entity, dt, fromX, fromY, fallbackDir = null) {
    const dx = entity.x - fromX;
    const dy = entity.y - fromY;
    const speed = Math.hypot(dx, dy) / Math.max(0.001, dt);
    const moving = speed > 2;
    if (moving) {
      entity.animVx = dx / Math.max(0.001, dt);
      entity.animVy = dy / Math.max(0.001, dt);
      entity.facing = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 1 : 2) : (dy < 0 ? 3 : 0);
    } else if (fallbackDir?.x || fallbackDir?.y) {
      entity.animVx = fallbackDir.x * 16;
      entity.animVy = fallbackDir.y * 16;
      entity.facing = Math.abs(fallbackDir.x) > Math.abs(fallbackDir.y) ? (fallbackDir.x < 0 ? 1 : 2) : (fallbackDir.y < 0 ? 3 : 0);
    } else {
      entity.animVx = (entity.animVx || 0) * 0.86;
      entity.animVy = (entity.animVy || 0) * 0.86;
    }
    entity.walkT = (entity.walkT || 0) + dt * (moving ? clamp(speed / 9, 5.5, 12) : 1.6);
    entity.moveAnim = moving ? clamp(speed / 80, 0.18, 1) : Math.max(0, (entity.moveAnim || 0) - dt * 3.6);
  }

  // v153：普通地图智能追踪旧逻辑已删除，怪物统一使用炸弹人格子追踪。

  function segmentExpandedRectHitT(x1, y1, x2, y2, rect, padding = 0) {
    const minX = rect.x - padding;
    const maxX = rect.x + rect.w + padding;
    const minY = rect.y - padding;
    const maxY = rect.y + rect.h + padding;
    const dx = x2 - x1;
    const dy = y2 - y1;
    let tMin = 0;
    let tMax = 1;

    if (Math.abs(dx) < 0.0001) {
      if (x1 < minX || x1 > maxX) return null;
    } else {
      const tx1 = (minX - x1) / dx;
      const tx2 = (maxX - x1) / dx;
      const txMin = Math.min(tx1, tx2);
      const txMax = Math.max(tx1, tx2);
      tMin = Math.max(tMin, txMin);
      tMax = Math.min(tMax, txMax);
    }

    if (Math.abs(dy) < 0.0001) {
      if (y1 < minY || y1 > maxY) return null;
    } else {
      const ty1 = (minY - y1) / dy;
      const ty2 = (maxY - y1) / dy;
      const tyMin = Math.min(ty1, ty2);
      const tyMax = Math.max(ty1, ty2);
      tMin = Math.max(tMin, tyMin);
      tMax = Math.min(tMax, tyMax);
    }

    if (tMax < tMin || tMax < 0 || tMin > 1) return null;
    return Math.max(0, tMin);
  }

  function maxDashDistanceBeforeHardBlock(x, y, dir, distance, radius = 16) {
    if (!game.bomberBlocks?.length) return distance;
    const endX = x + dir.x * distance;
    const endY = y + dir.y * distance;
    let nearestT = 1;
    for (const block of game.bomberBlocks) {
      if (block.kind !== "hard") continue;
      const t = segmentExpandedRectHitT(x, y, endX, endY, block, radius + 1);
      if (t !== null && t < nearestT) nearestT = t;
    }
    return Math.max(0, nearestT * distance - 3);
  }

  function dashThroughPath(entity, dir, distance, radius = null, room = game.room) {
    const r = radius ?? Math.max(10, (entity.r || 18) - 4);
    const startX = entity.x;
    const startY = entity.y;

    // 只把固定硬墙 hard 当作闪现路径阻挡；砖墙 brick 可以被闪现越过。
    const hardLimitedDistance = maxDashDistanceBeforeHardBlock(startX, startY, dir, distance, r);
    const usableDistance = Math.min(distance, hardLimitedDistance);

    // 闪现是位移技能，所以不逐点检查砖墙；只要求最终落点不能在墙体内部。
    const step = 4;
    const steps = Math.max(1, Math.ceil(usableDistance / step));
    let landed = false;
    let landX = startX;
    let landY = startY;

    for (let i = steps; i >= 1; i--) {
      const d = Math.min(usableDistance, i * step);
      const tx = clamp(startX + dir.x * d, 45, worldWidth(room) - 45);
      const ty = clamp(startY + dir.y * d, 74, worldHeight(room) - 45);
      if (canDashLandAt(tx, ty, r, room)) {
        landX = tx;
        landY = ty;
        landed = true;
        break;
      }
    }

    if (!landed && hardLimitedDistance < 6) {
      // 起点前方紧贴硬墙时不移动。
      entity.x = startX;
      entity.y = startY;
      return false;
    }

    entity.x = landX;
    entity.y = landY;
    return landX !== startX || landY !== startY;
  }

  function speedScale() {
    const base = (1 + Math.max(0, game.room - 1) * 0.055) * (1 + Math.min(game.runTime, 360) / 240);
    return base * (game.enemySlowTimer > 0 ? 0.58 : 1);
  }

  function spawnToken(entry, glow = 0.7) {
    const pos = randomTokenPosition();
    game.tokens.push({ entry, x: pos.x, y: pos.y, r: 24, glow });
  }

  function spawnTokenAt(entry, x, y, glow = 0.7) {
    const pos = findNearestWalkablePoint(x, y, 24, 240) || { x: clamp(x, 45, worldWidth() - 45), y: clamp(y, 74, worldHeight() - 45) };
    game.tokens.push({ entry, x: pos.x, y: pos.y, r: 24, glow });
  }

  function isBossRoom(room = game.room) {
    return room > 0 && room % BOSS_ROOM_INTERVAL === 0;
  }

  function bossEntryKey(entry) {
    if (!entry) return "";
    if (entry.source === "math") {
      const v = mathAnswerValueFromEntry(entry);
      return Number.isFinite(v) ? `math:${v}` : `math:${entry.word}|${entry.meaning}`;
    }
    return `${entry.word || ""}|${entry.meaning || ""}`;
  }

  function uniqueStudyEntries(entries = []) {
    const out = [];
    const seen = new Set();
    for (const entry of entries || []) {
      if (!entry || !entry.meaning) continue;
      const key = bossEntryKey(entry);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
    }
    return out;
  }

  function buildBossQuestionPool(roomWords = []) {
    const source = game.bank.length ? game.bank : game.words;
    const extra = pickMany(source.filter(e => e && e.meaning), BOSS_QUESTION_POOL_SIZE * 2);
    const pool = uniqueStudyEntries([...(roomWords || []), ...extra]);
    return pool.slice(0, Math.max(6, BOSS_QUESTION_POOL_SIZE));
  }

  function nextBossEntry(excludeEntry = null) {
    const source = game.boss?.questionPool?.length ? game.boss.questionPool : (game.bank.length ? game.bank : game.words);
    const pool = uniqueStudyEntries(source);
    const filtered = pool.filter(entry => entry.meaning && !sameStudyAnswerValue(entry, excludeEntry));
    return pickMany(filtered.length ? filtered : pool, 1)[0] || { word: "", meaning: excludeEntry?.meaning || "" };
  }

  function bossTokenCandidates(entry) {
    if (!entry || !entry.meaning) return [];
    const source = uniqueStudyEntries(game.bank.length ? game.bank : game.words);
    const correct = source.filter(candidate => candidate !== entry && isCorrectStudyMatch(candidate.meaning, entry));
    const wrong = source.filter(candidate => candidate.meaning && !isCorrectStudyMatch(candidate.meaning, entry));
    return uniqueStudyEntries([
      entry,
      ...pickMany(correct, Math.min(2, correct.length)),
      ...pickMany(wrong, Math.max(0, BOSS_VISIBLE_TOKEN_MIN - 1))
    ]).slice(0, Math.max(1, BOSS_VISIBLE_TOKEN_MIN));
  }

  function ensureBossToken(entry) {
    if (!entry || !entry.meaning) return;
    const candidates = bossTokenCandidates(entry);
    const hasCorrect = game.tokens.some(t => t.entry && isCorrectStudyMatch(t.entry.meaning, entry));
    if (hasCorrect && game.tokens.length >= BOSS_VISIBLE_TOKEN_MIN) return;
    const spawnList = hasCorrect ? candidates.filter(c => !game.tokens.some(t => t.entry && t.entry.meaning === c.meaning)) : candidates;
    for (const candidate of spawnList) {
      if (!candidate?.meaning) continue;
      if (game.tokens.some(t => t.entry && t.entry.meaning === candidate.meaning)) continue;
      spawnToken(candidate, isCorrectStudyMatch(candidate.meaning, entry) ? 1.35 : 0.7);
      if (game.tokens.length >= BOSS_VISIBLE_TOKEN_MIN + 3) break;
    }
  }

  function resolveEntityAction(entity) {
    if ((entity.hurtAnim || 0) > 0 || (entity.hitFlash || 0) > 0) return "hurt";
    if ((entity.dashAnim || 0) > 0) return "dash";
    if ((entity.attackAnim || 0) > 0) return "attack";
    if ((entity.moveAnim || 0) > 0.16) return "walk";
    return "idle";
  }

  function directionalSprite(type, action, facing) {
    const dir = facingKey(facing);
    return type?.actions?.[action]?.[dir] || type?.actions?.idle?.[dir] || null;
  }

  function buildBoss(theme, roomWords) {
    const kind = Math.max(0, ((game.room / BOSS_ROOM_INTERVAL - 1) % BOSS_INFO.length) | 0);
    const spriteConfig = BOSS_TYPES[kind] || null;
    ensureBossTypeImages(spriteConfig);
    const rawInfo = spriteConfig?.info || BOSS_INFO[kind];
    const info = { ...rawInfo, basicCd: BOSS_BASIC_CD_SECONDS, skillCd: BOSS_SPECIAL_CD_SECONDS };
    const questionPool = buildBossQuestionPool(roomWords);
    questionPool.forEach(entry => markReviewAppearance(entry));
    const entry = pickMany(questionPool, 1)[0] || nextBossEntry(null);
    const hp = Math.round(Number(info.hpBase || 360) + game.room * Number(info.hpGrowthPerRoom || info.hpGrowth || 36));
    const spawn = bossTopCenterSpawnPoint();
    game.boss = {
      kind,
      typeId: spriteConfig?.id || `boss_${kind}`,
      spriteConfig,
      info,
      x: spawn.x,
      y: spawn.y,
      r: Number(info.radius || 72),
      hp,
      maxHp: hp,
      hitFlash: 0,
      hurtAnim: 0,
      attackAnim: 0,
      action: "idle",
      attackCd: BOSS_BASIC_CD_SECONDS,
      patternCd: BOSS_SPECIAL_CD_SECONDS,
      pulse: Math.random() * 10,
      skillFlash: 0,
      entry,
      questionPool
    };
    ensureBossToken(entry);
  }

  function setNextBossWord() {
    if (!game.boss) return;
    const old = game.boss.entry || null;
    game.boss.entry = nextBossEntry(old);
    markReviewAppearance(game.boss.entry);
    ensureBossToken(game.boss.entry);
  }

  function defeatBoss() {
    if (!game.boss) return;
    addFloat("Boss 击败", game.boss.x - 34, game.boss.y - 92, "#ffe083");
    dropPickupAt(game.boss.x - 34, game.boss.y + 34, { id: "heal" });
    dropPickupAt(game.boss.x + 34, game.boss.y + 34, { id: "speed" });
    game.boss = null;
  }


  function buildMonsters(theme, roomWords) {
    const spawnPlan = monsterSpawnPlanForRoom(game.room);
    const fallbackPlan = spawnPlan[0] || monsterSpawnPlanForRoom(1)[0] || {
      grade: "E",
      ai: getMonsterAiClassByGrade("E"),
      spriteConfig: MONSTER_TYPES[0] || null
    };

    roomWords.forEach((entry, i) => {
      const edge = Math.floor(Math.random() * 4);
      const pos = separatedSpawn(edge, 82);
      const planned = spawnPlan[i] || fallbackPlan;
      const ai = planned.ai || getMonsterAiClassByGrade(planned.grade);
      const spriteConfig = planned.spriteConfig
        || monsterTypeForGrade(planned.grade || ai.grade, i)
        || MONSTER_TYPES[i % Math.max(1, MONSTER_TYPES.length)]
        || null;
      const grade = normalizeMonsterGrade(spriteConfig?.grade || planned.grade || ai.grade || "E");
      ensureMonsterTypeImages(spriteConfig);
      game.monsters.push({
        entry,
        x: pos.x,
        y: pos.y,
        r: Number(spriteConfig?.render?.radius || 25),
        hp: 1,
        maxHp: 1,
        imageKey: null,
        kind: spriteConfig?.kindIndex ?? ((game.room + i) % 8),
        typeId: spriteConfig?.id || MONSTER_VARIANTS[(game.room + i) % Math.max(1, MONSTER_VARIANTS.length)] || `monster_${i}`,
        spriteConfig,
        displayName: spriteConfig?.title || spriteConfig?.name || ai.name || `${grade}类怪物`,
        action: "idle",
        attackAnim: 0,
        hurtAnim: 0,
        grade,
        aiClass: grade,
        aiConfig: ai,
        baseSpeed: Number(ai.baseSpeed ?? ai.speed ?? 48),
        speedGrowthPerRoom: Number(ai.speedGrowthPerRoom ?? 0),
        touchDamage: Number(ai.touchDamage ?? ai.damage ?? 12),
        damageGrowthPerRoom: Number(ai.damageGrowthPerRoom ?? 0),
        aggroTiles: Number(ai.aggroTiles ?? 3),
        baseAggroTiles: Number(ai.aggroTiles ?? 3),
        aggroGrowthPerRoom: Number(ai.aggroGrowthPerRoom ?? 0),
        wrongAggroTimer: 0,
        wrongSpeedTimer: 0,
        tileReady: false,
        tileTarget: null,
        turnCd: rand(0.2, 1.2),
        dir: pickMany(BOMBER_DIRS, 1)[0],
        hitFlash: 0
      });
      if (entry.word) game.runSeen.add(entry.word);
      markReviewAppearance(entry);
    });
  }

  function spawnEnemyProjectile(opts = {}) {
    game.projectiles.push({
      enemy: true,
      x: opts.x ?? 0,
      y: opts.y ?? 0,
      vx: opts.vx ?? 0,
      vy: opts.vy ?? 0,
      radius: opts.radius ?? 10,
      color: opts.color || "#ffffff",
      attackType: "enemy",
      enemyStyle: opts.enemyStyle || "enemy",
      damage: opts.damage ?? 12,
      life: opts.life ?? 3,
      homing: opts.homing || 0,
      homingTurn: opts.homingTurn || 2.2,
      effect: opts.effect || "",
      sourceBoss: opts.sourceBoss ?? -1
    });
  }

  function aimedAngles(fromX, fromY, count = 3, spread = 0.18) {
    const base = Math.atan2(game.player.y - fromY, game.player.x - fromX);
    const out = [];
    const offset = (count - 1) / 2;
    for (let i = 0; i < count; i++) out.push(base + (i - offset) * spread);
    return out;
  }

  function radialAngles(count = 8, phase = 0) {
    return Array.from({ length: count }, (_, i) => phase + i * (Math.PI * 2 / count));
  }

  function shootBossBasic(boss) {
    boss.attackAnim = Math.max(boss.attackAnim || 0, 0.28);
    const speed = 260 + Math.min(140, game.room * 4);
    const damage = 11 + Math.floor(game.room / 4);
    const cx = boss.x, cy = boss.y + 10;
    switch (boss.info.baseStyle) {
      case "crystal":
        aimedAngles(cx, cy, 3, 0.2).forEach(ang => spawnEnemyProjectile({ x: cx, y: cy, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed, radius: 10, color: boss.info.attackColor, enemyStyle: "crystal", effect: "slow", damage, life: 3.2, sourceBoss: boss.kind }));
        break;
      case "fire":
        aimedAngles(cx, cy, 5, 0.16).forEach(ang => spawnEnemyProjectile({ x: cx, y: cy, vx: Math.cos(ang) * (speed + 20), vy: Math.sin(ang) * (speed + 20), radius: 9, color: boss.info.attackColor, enemyStyle: "fire", damage: damage + 1, life: 2.6, sourceBoss: boss.kind }));
        break;
      case "venom":
        aimedAngles(cx, cy, 2, 0.24).forEach(ang => spawnEnemyProjectile({ x: cx, y: cy, vx: Math.cos(ang) * (speed - 20), vy: Math.sin(ang) * (speed - 20), radius: 11, color: boss.info.attackColor, enemyStyle: "venom", homing: 1, homingTurn: 2.8, damage, life: 3.6, sourceBoss: boss.kind }));
        break;
      case "prism": {
        const base = Math.atan2(game.player.y - cy, game.player.x - cx);
        [base - 0.28, base + 0.28].forEach(ang => spawnEnemyProjectile({ x: cx, y: cy, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed, radius: 10, color: boss.info.attackColor, enemyStyle: "prism", damage, life: 3.1, sourceBoss: boss.kind }));
        break;
      }
      case "claw":
        aimedAngles(cx, cy, 3, 0.24).forEach(ang => spawnEnemyProjectile({ x: cx, y: cy, vx: Math.cos(ang) * (speed + 35), vy: Math.sin(ang) * (speed + 35), radius: 12, color: boss.info.attackColor, enemyStyle: "claw", effect: "hide", damage: damage + 2, life: 2.3, sourceBoss: boss.kind }));
        break;
      case "rock":
        aimedAngles(cx, cy, 2, 0.16).forEach(ang => spawnEnemyProjectile({ x: cx, y: cy, vx: Math.cos(ang) * (speed - 55), vy: Math.sin(ang) * (speed - 10), radius: 15, color: boss.info.attackColor, enemyStyle: "rock", damage: damage + 2, life: 3.7, sourceBoss: boss.kind }));
        break;
      default:
        aimedAngles(cx, cy, 3, 0.24).forEach(ang => spawnEnemyProjectile({ x: cx, y: cy, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed, radius: 10, color: boss.info.attackColor, enemyStyle: "enemy", damage, life: 3.2, sourceBoss: boss.kind }));
    }
  }

  function shootBossPattern(boss) {
    boss.attackAnim = Math.max(boss.attackAnim || 0, 0.42);
    boss.skillFlash = 0.28;
    const damage = 12 + Math.floor(game.room / 4);
    switch (boss.info.specialStyle) {
      case "crystalRain": {
        const xs = [200, 360, 520, 680, 840, 1000, 1160];
        pickMany(xs, 5).forEach((x, i) => spawnEnemyProjectile({ x, y: 84 - i * 26, vx: rand(-18, 18), vy: 290 + i * 10, radius: 13, color: boss.info.attackColor, enemyStyle: "crystal", effect: "slow", damage, life: 3.1, sourceBoss: boss.kind }));
        break;
      }
      case "featherNova":
        radialAngles(10, performance.now() / 550).forEach(ang => spawnEnemyProjectile({ x: boss.x, y: boss.y + 8, vx: Math.cos(ang) * 245, vy: Math.sin(ang) * 245, radius: 10, color: boss.info.attackColor, enemyStyle: "fire", damage, life: 2.9, sourceBoss: boss.kind }));
        break;
      case "serpentHoming":
        aimedAngles(boss.x, boss.y, 3, 0.32).forEach(ang => spawnEnemyProjectile({ x: boss.x, y: boss.y + 10, vx: Math.cos(ang) * 170, vy: Math.sin(ang) * 170, radius: 12, color: boss.info.attackColor, enemyStyle: "venom", homing: 1, homingTurn: 3.8, damage: damage + 1, life: 4.6, sourceBoss: boss.kind }));
        break;
      case "prismSpiral":
        radialAngles(12, performance.now() / 900).forEach(ang => spawnEnemyProjectile({ x: boss.x, y: boss.y + 8, vx: Math.cos(ang) * 230, vy: Math.sin(ang) * 230, radius: 9, color: boss.info.attackColor, enemyStyle: "prism", damage, life: 3.7, sourceBoss: boss.kind }));
        break;
      case "shadowShockwave":
        radialAngles(8, Math.PI / 8).forEach(ang => spawnEnemyProjectile({ x: boss.x, y: boss.y + 10, vx: Math.cos(ang) * 210, vy: Math.sin(ang) * 210, radius: 16, color: boss.info.attackColor, enemyStyle: "claw", effect: "hide", damage: damage + 1, life: 2.8, sourceBoss: boss.kind }));
        break;
      case "golemRockfall": {
        const lanes = [160, 320, 480, 640, 800, 960, 1120];
        pickMany(lanes, 4).concat([clamp(game.player.x, 120, W - 120)]).forEach((x, i) => spawnEnemyProjectile({ x, y: 70 - i * 18, vx: rand(-12, 12), vy: 320 + rand(-10, 25), radius: 18, color: boss.info.attackColor, enemyStyle: "rock", damage: damage + 2, life: 3.2, sourceBoss: boss.kind }));
        break;
      }
      default:
        radialAngles(8).forEach(ang => spawnEnemyProjectile({ x: boss.x, y: boss.y + 8, vx: Math.cos(ang) * 240, vy: Math.sin(ang) * 240, radius: 10, color: boss.info.attackColor, enemyStyle: "enemy", damage, life: 3, sourceBoss: boss.kind }));
    }
  }

  function replacementEntry(meaning) {
    return game.bank.find(entry => entry.meaning === meaning) || game.words.find(entry => entry.meaning === meaning) || { word: "", meaning };
  }

  function hasLooseMeaning(meaning, currentProjectile = null) {
    if (!meaning) return true;
    if (game.player?.held === meaning) return true;
    if (game.tokens.some(t => t.entry?.meaning === meaning)) return true;
    return game.projectiles.some(pr => pr !== currentProjectile && !pr.enemy && !pr.returned && pr.meaning === meaning && pr.life > 0);
  }

  function returnProjectileMeaning(pr, x = null, y = null, glow = 0.9) {
    if (!pr || pr.enemy || pr.returned || !pr.meaning || hasLooseMeaning(pr.meaning, pr)) return false;
    pr.returned = true;
    refreshMeaningByText(
      pr.meaning,
      clamp(Number.isFinite(x) ? x : rand(130, worldWidth() - 130), 70, worldWidth() - 70),
      clamp(Number.isFinite(y) ? y : rand(145, worldHeight() - 85), 92, worldHeight() - 62),
      glow
    );
    return true;
  }

  function returnProjectileMeaningRandom(pr, glow = 1.05) {
    if (!pr || pr.enemy || pr.returned || !pr.meaning || hasLooseMeaning(pr.meaning, pr)) return false;
    const pos = randomWalkablePosition(130, worldWidth() - 130, 145, worldHeight() - 85, 24);
    pr.returned = true;
    refreshMeaningByText(pr.meaning, pos.x, pos.y, glow);
    addFloat("翻译随机刷新", pos.x - 42, pos.y - 34, "#fff0a0");
    return true;
  }

  function collectToken(token) {
    if (!token || !game.player) return false;
    const p = game.player;
    if (p.held) {
      game.message = "已有翻译，先发射后再拾取";
      addFloat("已有翻译", p.x - 28, p.y - 34, "#ffd89a");
      return false;
    }
    p.held = token.entry.meaning;
    game.tokens = game.tokens.filter(t => t !== token);
    addFloat(`拾取：${p.held}`, p.x - 38, p.y - 34, "#fff0a0");
    play("pickup");
    return true;
  }


  function currentTheme(room = game.room || 1) {
    if (Number.isInteger(game.selectedThemeIndex) && game.selectedThemeIndex >= 0) {
      return themes[game.selectedThemeIndex % themes.length];
    }
    return themes[Math.max(0, room - 1) % themes.length];
  }

  function cycleTheme(step = 1) {
    const total = themes.length + 1; // include random
    let idx = Number.isInteger(game.selectedThemeIndex) ? game.selectedThemeIndex : -1;
    idx = ((idx + 1 + step) % total + total) % total - 1;
    game.selectedThemeIndex = idx;
    localStorage.setItem("wordRealmTheme", String(idx));
    const label = idx < 0 ? "\u968f\u673a\u8f6e\u6362" : themes[idx].name;
    game.message = `\u4e3b\u9898\uff1a${label}`;
    play("pickup");
  }

  function effectivePlayerSpeed() {
    if (!game.player) return 0;
    let speed = game.player.speed;
    if (game.player.speedBuff > 0) speed *= 1.45;
    if (game.player.slowSelf > 0) speed *= 0.58;
    return speed;
  }

  // v153：游戏地图已统一为炸弹人地图，普通地图障碍物生成/碰撞/绘制旧代码已删除。

  function resolveCircleBlock(entity, block, extra = 0) {
    if (!entity || !block) return false;
    const dx = entity.x - block.x;
    const dy = entity.y - block.y;
    const d = Math.hypot(dx, dy) || 0.001;
    const min = (entity.r || 18) + (block.r || 24) + extra;
    if (d >= min) return false;
    const push = min - d;
    entity.x += dx / d * push;
    entity.y += dy / d * push;
    return true;
  }

  function resolveTokenCollision(entity, extra = 2) {
    for (const token of game.tokens) resolveCircleBlock(entity, token, extra);
    entity.x = clamp(entity.x, 45, worldWidth() - 45);
    entity.y = clamp(entity.y, 74, worldHeight() - 45);
  }

  function resolveMonsterCollision(entity, extra = 2) {
    for (const monster of game.monsters) {
      if (monster.dead) continue;
      resolveCircleBlock(entity, monster, extra);
    }
    entity.x = clamp(entity.x, 45, worldWidth() - 45);
    entity.y = clamp(entity.y, 74, worldHeight() - 45);
  }

  function resolvePlayerSoftBlocks() {
    if (!game.player) return;
    resolveTokenCollision(game.player, 2);
    resolveMonsterCollision(game.player, 4);
  }

  function spawnRoomVisiblePickups(count = VISIBLE_ROOM_PICKUPS) {
    const picks = pickMany(roomPickupPool(), count);
    for (const type of picks) {
      const pos = randomWalkablePosition(160, worldWidth() - 160, 150, worldHeight() - 110, 24);
      dropPickupAt(pos.x, pos.y, type, true);
    }
  }

  function dropPickupAt(x, y, forced = null, persistent = true) {
    const roll = forced || pickMany(roomPickupPool(), 1)[0];
    if (!roll) return;
    const type = roll.id === "mystery" ? pickMany(roomPickupPool(), 1)[0] : roll;
    const pos = findNearestWalkablePoint(x, y, 24, 220) || randomWalkablePosition(160, worldWidth() - 160, 150, worldHeight() - 110, 24);
    game.pickups.push({ type, x: pos.x, y: pos.y, r: 24, life: persistent ? Infinity : 14, pulse: Math.random() * 10 });
  }

  function applyPickup(type) {
    const p = game.player;
    if (!p || !type) return;
    switch (type.id) {
      case "reveal":
        game.showMeaningTimer = Math.max(game.showMeaningTimer, POSITIVE_BUFF_DURATION);
        addFloat(`显示译文 ${POSITIVE_BUFF_DURATION}秒`, p.x - 52, p.y - 36, type.color);
        break;
      case "heal":
        p.hp = Math.min(p.maxHp, p.hp + 25);
        addFloat("+25 HP", p.x - 18, p.y - 36, type.color);
        break;
      case "invincible":
        p.invincibleBuff = POSITIVE_BUFF_DURATION;
        p.invuln = Math.max(p.invuln, POSITIVE_BUFF_DURATION);
        addFloat(`无敌 ${POSITIVE_BUFF_DURATION}秒`, p.x - 42, p.y - 36, type.color);
        break;
      case "speed":
        p.speedBuff = POSITIVE_BUFF_DURATION;
        addFloat(`加速 ${POSITIVE_BUFF_DURATION}秒`, p.x - 42, p.y - 36, type.color);
        break;
      case "pierce":
        p.pierceBuff = POSITIVE_BUFF_DURATION;
        addFloat(`穿透 ${POSITIVE_BUFF_DURATION}秒`, p.x - 42, p.y - 36, type.color);
        break;
      case "hide":
        game.hideWordsTimer = Math.max(game.hideWordsTimer, NEGATIVE_BUFF_DURATION);
        addFloat(`单词隐藏 ${NEGATIVE_BUFF_DURATION}秒`, p.x - 52, p.y - 36, type.color);
        break;
      case "damage":
        p.hp = Math.max(1, p.hp - 16);
        addFloat("-16 HP", p.x - 18, p.y - 36, type.color);
        break;
      case "slowSelf":
        p.slowSelf = NEGATIVE_BUFF_DURATION;
        addFloat(`自己减速 ${NEGATIVE_BUFF_DURATION}秒`, p.x - 52, p.y - 36, type.color);
        break;
      case "slowEnemy":
        game.enemySlowTimer = Math.max(game.enemySlowTimer, POSITIVE_BUFF_DURATION);
        addFloat(`敌人减速 ${POSITIVE_BUFF_DURATION}秒`, p.x - 52, p.y - 36, type.color);
        break;
    }
    play("pickup");
  }

  function updatePickups(dt) {
    for (const item of [...game.pickups]) {
      if (Number.isFinite(item.life)) item.life -= dt;
      item.pulse += dt * 5;
      item.spin = (item.spin || 0) + dt * 1.9;
      if (game.player && dist(game.player, item) < game.player.r + item.r + 6) {
        applyPickup(item.type);
        game.pickups = game.pickups.filter(p => p !== item);
      }
    }
    game.pickups = game.pickups.filter(p => !Number.isFinite(p.life) || p.life > 0);
  }

  function drawPickup(item) {
    const img = images.items;
    if (!img) return;
    const pulse = item.pulse || 0;
    const bob = Math.sin(pulse * 1.25) * 5;
    const glow = 0.55 + Math.sin(pulse * 1.8) * 0.22;
    const s = 46 + Math.sin(pulse) * 3.5;
    const alpha = Number.isFinite(item.life) && item.life < 2 ? clamp(item.life / 2, 0.25, 1) : 1;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(item.x, item.y + bob);
    ctx.shadowColor = item.type.color || "rgba(255,255,255,.7)";
    ctx.shadowBlur = 18 + glow * 12;
    ctx.strokeStyle = item.type.color || "rgba(255,255,255,.7)";
    ctx.globalAlpha = alpha * 0.36;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, 14, 28 + glow * 5, 9 + glow * 2, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.rotate(Math.sin(pulse * 0.75) * 0.08);
    ctx.globalAlpha = alpha;
    drawAtlas(img, 4, 4, item.type.icon, -s / 2, -s / 2, s, s);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = alpha * 0.55;
    ctx.rotate((item.spin || 0) * 0.65);
    ctx.strokeStyle = "rgba(255,246,176,.78)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, s * 0.55, -0.8, 0.65);
    ctx.stroke();
    ctx.rotate(Math.PI);
    ctx.beginPath();
    ctx.arc(0, 0, s * 0.55, -0.72, 0.48);
    ctx.stroke();
    ctx.restore();
  }

  function animatedEntityPose(entity, baseW, baseH, strength = 1) {
    return { flipX: false, x: entity.x, y: entity.y, w: baseW, h: baseH, rotate: 0, scaleX: 1, scaleY: 1, shadowScale: 1 };
  }

  function drawAnimatedAtlas(img, cols, rows, index, centerX, centerY, w, h, pose) {
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate(pose.rotate || 0);
    ctx.scale((pose.flipX ? -1 : 1) * (pose.scaleX || 1), pose.scaleY || 1);
    drawAtlas(img, cols, rows, index, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  function drawAnimatedImageCover(img, centerX, centerY, w, h, pose) {
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate(pose.rotate || 0);
    ctx.scale((pose.flipX ? -1 : 1) * (pose.scaleX || 1), pose.scaleY || 1);
    drawImageCover(img, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  function entityActionFrame(entity, spriteDef, action) {
    const cols = Math.max(1, spriteDef?.cols || 1);
    const rows = Math.max(1, spriteDef?.rows || 1);
    const row = clamp(Number(spriteDef?.row || 0), 0, rows - 1);
    const frameCols = spriteDef.frameCols || [...Array(cols).keys()];
    let col = 0;
    if (action === "walk") {
      const speed = Number(spriteDef.walkFps || 7);
      const frame = Math.floor(performance.now() / 1000 * speed) % frameCols.length;
      col = frameCols[frame] ?? 0;
    } else if (cols > 1) {
      const duration = spriteDef.duration || (action === "attack" ? 0.34 : action === "hurt" ? 0.38 : action === "dash" ? 0.28 : 0.25);
      const timer = action === "attack" ? (entity.attackAnim || 0)
        : action === "hurt" ? (entity.hurtAnim || entity.hitFlash || 0)
        : action === "dash" ? (entity.dashAnim || 0)
        : 0;
      const progress = clamp(1 - timer / Math.max(0.001, duration), 0, 0.999);
      col = frameCols[Math.floor(progress * frameCols.length)] ?? 0;
    }
    return row * cols + clamp(col, 0, cols - 1);
  }

  function drawAnimatedDirectionalSprite(img, spriteDef, action, entity, centerX, centerY, w, h, pose) {
    const cols = Math.max(1, spriteDef?.cols || 1);
    const rows = Math.max(1, spriteDef?.rows || 1);
    const frame = entityActionFrame(entity, spriteDef, action);
    if (cols > 1 || rows > 1) drawAnimatedAtlas(img, cols, rows, frame, centerX, centerY, w, h, pose);
    else drawAnimatedImageCover(img, centerX, centerY, w, h, pose);
  }

  function themeLabel() {
    return currentTheme().name;
  }

  function returnToMenu() {
    game.bestRoom = Math.max(game.bestRoom, game.room);
    localStorage.setItem("wordRealmBestRoom", String(game.bestRoom));
    game.mode = "menu";
    game.player = null;
    game.monsters = [];
    game.boss = null;
    game.door = null;
    game.clearAnnounced = false;
    game.obstacles = [];
    game.bomberBlocks = [];
    game.tokens = [];
    game.pickups = [];
    game.projectiles = [];
    game.floats = [];
    game.showBook = false;
    game.menuScreen = "home";
  }

  function exitGame() {
    returnToMenu();
    game.message = "\u5df2\u9000\u51fa\u6e38\u620f";
    window.close();
  }

  function selectedHero() {
    const fallback = HEROES[0] || makeHero({
      id: FALLBACK_HERO_ID,
      name: "剑士",
      sub: "黑发骑士",
      role: "战士",
      tint: "#4da3ff",
      attackType: "slash",
      actions: {
        idle: { cols: 1, rows: 1, frameHeight: 96 },
        walk: { cols: 1, rows: 1, frameHeight: 96 },
        attack: { cols: 1, rows: 1, frameHeight: 96 },
        dash: { cols: 1, rows: 1, frameHeight: 96 },
        hurt: { cols: 1, rows: 1, frameHeight: 96 }
      }
    });
    const hero = HEROES.find(hero => hero.id === game.selectedHeroId) || fallback;
    if (game.selectedHeroId !== hero.id) game.selectedHeroId = hero.id;
    return hero;
  }

  function selectHero(id) {
    const hero = HEROES.find(item => item.id === id);
    if (!hero) return;

    const fromIndex = selectedHeroIndex();
    const toIndex = HEROES.findIndex(item => item.id === hero.id);
    if (toIndex >= 0 && toIndex !== fromIndex) {
      game.heroCarousel = { from: fromIndex, to: toIndex, start: performance.now(), duration: 280, active: true };
    }

    game.selectedHeroId = hero.id;
    localStorage.setItem("wordRealmHero", hero.id);

    // 选择英雄时，只加载该英雄预览图，不加载 walk/attack/dash/hurt。
    // 这样玩家在菜单里快速切换英雄时，不会产生大量完整动作请求。
    game.message = `已选择英雄：${hero.name} · ${hero.sub}，正在加载预览`;
    ensureHeroPreview(hero).then(() => {
      if (game.selectedHeroId === hero.id) game.message = `已选择英雄：${hero.name} · ${hero.sub}`;
    });

    play("pickup");
  }

  function cycleHero(step = 1) {
    if (!HEROES.length) return;
    const index = HEROES.findIndex(hero => hero.id === game.selectedHeroId);
    const next = (Math.max(0, index) + step + HEROES.length) % HEROES.length;
    selectHero(HEROES[next].id);
  }

  async function startGame(maxDifficulty, name) {
    clearSave();
    game.mode = "loading";
    document.body.dataset.gameMode = game.mode;
    beginLoadProgress("正在进入关卡", "准备词库和英雄素材");

    // 真正进入游戏时才加载：
    // 1. 当前难度需要的词库分包；
    // 2. 当前选中英雄的完整动作 idle/walk/attack/dash/hurt。
    // 这行是“首屏不加载完整动作”的配套实现，不要挪到 boot() 里。
    await Promise.all([
      isMathMode() ? Promise.resolve([]) : ensureWordsLoaded(maxDifficulty),
      ensureHeroImages(selectedHero(), "英雄动作素材")
    ]);
    finishLoadProgress("进入关卡完成");
    game.difficulty = maxDifficulty;
    game.difficultyName = name;
    game.bank = buildStudyBank(maxDifficulty);
    if (!game.bank.length && !isMathMode()) game.bank = [...game.words];
    game.room = syncSelectedStartRoom() - 1;
    game.score = 0;
    game.combo = 0;
    game.correct = 0;
    game.wrong = 0;
    game.roomTime = 0;
    game.runTime = 0;
    game.showMeaningTimer = 0;
    game.hideWordsTimer = 0;
    game.enemySlowTimer = 0;
    game.bookCd = 0;
    game.bookTimer = 0;
    game.showBook = false;
    game.runSeen = new Set();
    game.reviewStats = {};
    game.reviewOrder = 0;
    game.player = {
      x: W / 2, y: H - 128, r: 18, hp: 100, maxHp: 100, speed: 245, held: "",
      dashCd: 0, shield: 0, invuln: 0, facing: 0, attackFacing: 0, attackActionFacing: 0, attackActionDir: null, attackActionTimer: 0, attackLockTimer: 0, walk: 0, footstepCd: 0, fireAnim: 0,
      dashAnim: 0, dashFacing: 0, hurtAnim: 0, tileReady: false, tileTarget: null, gridDir: null,
      speedBuff: 0, slowSelf: 0, invincibleBuff: 0, pierceBuff: 0
    };
    nextRoom();
  }

  async function continueSavedGame() {
    const saved = loadSave();
    if (!saved) {
      game.message = "暂无可继续的存档";
      return;
    }
    game.mode = "loading";
    document.body.dataset.gameMode = game.mode;
    beginLoadProgress("正在继续存档", "准备存档词库和英雄素材");
    game.difficulty = Number(saved.difficulty) || game.difficulty;
    game.difficultyName = saved.difficultyName || game.difficultyName;
    game.contentMode = saved.contentMode === "math" ? "math" : (saved.contentMode === "word" ? "word" : game.contentMode);
    game.quizMode = normalizeQuizMode(saved.quizMode || game.quizMode);
    await (isMathMode() ? Promise.resolve([]) : ensureWordsLoaded(game.difficulty));
    if (saved.hero && HEROES.some(hero => hero.id === saved.hero)) game.selectedHeroId = saved.hero;
    await ensureHeroImages(selectedHero(), "英雄动作素材");
    finishLoadProgress("继续存档完成");
    game.bank = buildStudyBank(game.difficulty);
    if (!game.bank.length && !isMathMode()) game.bank = [...game.words];
    if (Number.isInteger(saved.theme)) game.selectedThemeIndex = saved.theme;
    game.room = Math.max(0, Number(saved.room) - 1);
    game.score = Number(saved.score) || 0;
    game.combo = 0;
    game.correct = Number(saved.correct) || 0;
    game.wrong = Number(saved.wrong) || 0;
    game.roomTime = 0;
    game.runTime = Number(saved.runTime) || 0;
    game.showMeaningTimer = 0;
    game.hideWordsTimer = 0;
    game.enemySlowTimer = 0;
    game.bookCd = 0;
    game.bookTimer = 0;
    game.showBook = false;
    game.runSeen = new Set(Array.isArray(saved.seen) ? saved.seen : []);
    game.reviewStats = saved.reviewStats && typeof saved.reviewStats === "object" ? saved.reviewStats : {};
    game.reviewOrder = Number(saved.reviewOrder) || 0;
    game.player = {
      x: W / 2, y: H - 128, r: 18, hp: 100, maxHp: 100, speed: 245, held: "",
      dashCd: 0, shield: 0, invuln: 0, facing: 0, attackFacing: 0, attackActionFacing: 0, attackActionDir: null, attackActionTimer: 0, attackLockTimer: 0, walk: 0, footstepCd: 0, fireAnim: 0,
      dashAnim: 0, dashFacing: 0, hurtAnim: 0, tileReady: false, tileTarget: null, gridDir: null,
      speedBuff: 0, slowSelf: 0, invincibleBuff: 0, pierceBuff: 0
    };
    nextRoom();
  }

  function restartCurrentRoom() {
    if (!game.player || game.room <= 0) return;
    const targetRoom = game.room;
    game.room = targetRoom - 1;
    game.combo = 0;
    if (game.player) {
      game.player.hp = game.player.maxHp;
      game.player.held = "";
      game.player.dashCd = 0;
      game.player.shield = 0;
      game.player.invuln = 0;
      game.player.speedBuff = 0;
      game.player.slowSelf = 0;
      game.player.invincibleBuff = 0;
      game.player.pierceBuff = 0;
    }
    nextRoom();
    game.message = `已重新开始第 ${targetRoom} 关`;
  }

  function nextRoom() {
    game.room += 1;
    game.monsters = [];
    game.boss = null;
    game.door = null;
    game.clearAnnounced = false;
    game.obstacles = [];
    game.bomberBlocks = [];
    game.tokens = [];
    game.pickups = [];
    game.projectiles = [];
    game.floats = [];
    game.roomTime = 0;
    game.mode = "playing";
    document.body.dataset.gameMode = game.mode;
    if (loading) loading.style.display = "none";
    const theme = currentTheme(game.room);
    game.currentThemeIndex = themes.indexOf(theme);
    saveRun();

    if (isBossRoom(game.room)) {
      const bossWords = pickMany(game.bank, 8);
      bossWords.forEach(entry => {
        game.runSeen.add(entry.word);
        markReviewAppearance(entry);
      });
      game.bomberBlocks = buildBomberBlocks(bossWords, true);
      if (game.player) {
        const start = bomberCellCenter(Math.floor(BOMBER_GRID.cols / 2), BOMBER_GRID.rows - 3);
        game.player.x = start.x;
        game.player.y = start.y;
        resetPlayerGridMove();
      }
      buildBoss(theme, bossWords);
      spawnRoomVisiblePickups(VISIBLE_ROOM_PICKUPS + 1);
      game.message = `${game.boss.info.name} 出现：匹配顶部字词并躲避弹幕`;
      return;
    }

    const spawnPlan = monsterSpawnPlanForRoom(game.room);
    const count = Math.max(1, spawnPlan.length || Math.min(4 + Math.floor(game.room * 0.55), 11));
    const roomWords = pickMany(game.bank, count);
    roomWords.forEach(entry => {
      game.runSeen.add(entry.word);
      markReviewAppearance(entry);
    });
    game.bomberBlocks = buildBomberBlocks(roomWords, false);
    if (game.player) {
      const start = bomberCellCenter(Math.floor(BOMBER_GRID.cols / 2), BOMBER_GRID.rows - 3);
      game.player.x = start.x;
      game.player.y = start.y;
      resetPlayerGridMove();
    }
    buildMonsters(theme, roomWords);
    spawnRoomVisiblePickups(VISIBLE_ROOM_PICKUPS);
    const distractors = pickMany(game.bank.filter(w => !roomWords.includes(w)), Math.min(4, count));
    [...roomWords, ...distractors].forEach(entry => spawnToken(entry, roomWords.includes(entry) ? 1.6 : 0));
    game.message = `第 ${game.room} 关：打碎红砖，收集正确字词`;
  }

  function chooseReward(index) {
    const reward = game.rewards[index];
    if (!reward) return;
    if (reward.kind === "heal") {
      game.player.hp = Math.min(game.player.maxHp, game.player.hp + 35);
    } else if (reward.kind === "speed") {
      game.player.speed += 16;
    } else if (reward.kind === "maxhp") {
      game.player.maxHp += 18;
      game.player.hp += 18;
    } else if (reward.kind === "shield") {
      game.player.shield = 7;
    }
    play("reward");
    nextRoom();
  }

  function makeRewards() {
    const pool = [
      { kind: "heal", title: "\u751f\u547d\u8865\u7ed9", desc: "\u6062\u590d 35 \u70b9\u751f\u547d" },
      { kind: "speed", title: "\u673a\u52a8\u6b65\u4f10", desc: "\u79fb\u52a8\u901f\u5ea6\u6c38\u4e45\u63d0\u5347" },
      { kind: "maxhp", title: "\u8bb0\u5fc6\u97e7\u6027", desc: "\u751f\u547d\u4e0a\u9650\u6c38\u4e45\u63d0\u5347" },
      { kind: "shield", title: "\u80fd\u91cf\u62a4\u76fe", desc: "\u4e0b\u4e00\u95f4\u5f00\u5c40\u83b7\u5f97\u62a4\u76fe" }
    ];
    game.rewards = pickMany(pool, 3);
    game.mode = "reward";
    game.message = "\u9009\u62e9\u4e00\u5f20\u5956\u52b1\u5361";
  }

  function addFloat(text, x, y, color = "#fff2a0") {
    if (!game.settings.damageText) return;
    game.floats.push({ text, x, y, color, life: 1.2 });
  }

  function hasActiveFriendlyStudyProjectile() {
    return game.projectiles.some(pr => !pr.enemy && pr.meaning && pr.life > 0);
  }

  function hasAvailableStudyWord() {
    return !!game.player?.held || game.tokens.some(t => t.entry?.meaning) || hasActiveFriendlyStudyProjectile();
  }

  function checkNoAvailableStudyWords() {
    if (game.mode !== "playing" || game.roomTime < 1.2 || remainingEnemyCount() <= 0) return;
    if (hasAvailableStudyWord()) return;
    const lockedInBrick = game.bomberBlocks.some(block => block.kind === "brick" && (block.hiddenEntry || (Array.isArray(block.storedMeanings) && block.storedMeanings.length)));
    markDeathReview();
    game.bestRoom = Math.max(game.bestRoom, game.room);
    localStorage.setItem("wordRealmBestRoom", String(game.bestRoom));
    saveRun();
    game.mode = "gameover";
    game.message = lockedInBrick ? "场上无可用字词，剩余字词都在红砖里，挑战结束" : "场上无可用字词，挑战结束";
  }

  function update(dt) {
    if (game.mode !== "playing") {
      updateFloats(dt);
      return;
    }

    const p = game.player;
    game.roomTime += dt;
    game.runTime += dt;
    const kb = {
      x: (game.keys.has("KeyD") || game.keys.has("ArrowRight") ? 1 : 0) - (game.keys.has("KeyA") || game.keys.has("ArrowLeft") ? 1 : 0),
      y: (game.keys.has("KeyS") || game.keys.has("ArrowDown") ? 1 : 0) - (game.keys.has("KeyW") || game.keys.has("ArrowUp") ? 1 : 0)
    };
    const move = norm({ x: kb.x + game.touchMove.x, y: kb.y + game.touchMove.y });
    const fromX = p.x;
    const fromY = p.y;

    // v153：只保留炸弹人地图，玩家移动统一按格移动，落点永远吸附到方格中心。
    updateGridPlayerMovement(p, move, dt);
    if (Math.hypot(p.x - fromX, p.y - fromY) > 0.4) {
      p.footstepCd -= dt;
      if (p.footstepCd <= 0) { play("footstep"); p.footstepCd = 0.28; }
    } else {
      p.walk = 0;
      p.footstepCd = 0;
      p.tileTarget = null;
      p.gridDir = null;
    }

    p.dashCd = Math.max(0, p.dashCd - dt);
    p.shield = Math.max(0, p.shield - dt);
    p.invuln = Math.max(0, p.invuln - dt);
    p.fireAnim = Math.max(0, (p.fireAnim || 0) - dt);
    p.attackActionTimer = Math.max(0, (p.attackActionTimer || 0) - dt);
    p.attackLockTimer = Math.max(0, (p.attackLockTimer || 0) - dt);
    if ((p.attackActionTimer || 0) <= 0) p.attackActionDir = null;
    p.dashAnim = Math.max(0, (p.dashAnim || 0) - dt);
    p.hurtAnim = Math.max(0, (p.hurtAnim || 0) - dt);
    p.speedBuff = Math.max(0, p.speedBuff - dt);
    p.slowSelf = Math.max(0, p.slowSelf - dt);
    p.invincibleBuff = Math.max(0, p.invincibleBuff - dt);
    p.pierceBuff = Math.max(0, p.pierceBuff - dt);
    game.showMeaningTimer = Math.max(0, game.showMeaningTimer - dt);
    game.hideWordsTimer = Math.max(0, game.hideWordsTimer - dt);
    game.enemySlowTimer = Math.max(0, game.enemySlowTimer - dt);
    game.bookCd = Math.max(0, (game.bookCd || 0) - dt);
    game.bookTimer = Math.max(0, (game.bookTimer || 0) - dt);
    if (game.bookTimer <= 0) game.showBook = false;

    // 移动与攻击解耦：左手持续移动，右手按钮发射/闪现。

    updateMonsters(dt);
    updateBoss(dt);
    updateProjectiles(dt);
    updateTokens(dt);
    updateCamera();
    updatePickups(dt);
    updateFloats(dt);
    checkNoAvailableStudyWords();

    updateDoor(dt);

    if (game.roomTime >= ROOM_TIME_LIMIT && game.mode === "playing") {
      p.hp = 0;
      game.message = "倒计时结束";
    }

    if (p.hp <= 0) {
      markDeathReview();
      game.bestRoom = Math.max(game.bestRoom, game.room);
      localStorage.setItem("wordRealmBestRoom", String(game.bestRoom));
      saveRun();
      game.mode = "gameover";
      game.message = "角色死亡，请选择重新开始或返回主菜单";
    }
  }

  function updateMonsters(dt) {
    const p = game.player;
    const scale = speedScale();
    for (const m of game.monsters) {
      const fromX = m.x;
      const fromY = m.y;
      m.attackAnim = Math.max(0, (m.attackAnim || 0) - dt);
      m.hurtAnim = Math.max(0, (m.hurtAnim || 0) - dt);
      updateBomberMonster(m, dt, scale);
      updateMotionAnimation(m, dt, fromX, fromY, m.dir);
      m.hitFlash = Math.max(0, m.hitFlash - dt);
      if (dist(m, p) < m.r + p.r + 8 && p.invuln <= 0 && p.invincibleBuff <= 0) {
        // 普通怪没有血量概念，但每个等级对角色造成的接触伤害不同。
        // 护盾状态下仍然减伤，但不会把所有等级都压成同一个固定伤害。
        const rawDamage = monsterTouchDamage(m);
        const damage = p.shield > 0 ? Math.max(3, Math.ceil(rawDamage * 0.35)) : rawDamage;
        p.hp -= damage;
        p.invuln = 0.55;
        p.hurtAnim = 0.38;
        m.attackAnim = Math.max(m.attackAnim || 0, 0.26);
        game.combo = 0;
        addFloat(`-${damage}`, p.x - 12, p.y - 36, "#ff8a8a");
        play("hurt");
      }
      m.action = resolveEntityAction(m);
    }
  }

  function updateBoss(dt) {
    const b = game.boss;
    const p = game.player;
    if (!b || !p) return;
    const fromX = b.x;
    const fromY = b.y;
    b.hitFlash = Math.max(0, b.hitFlash - dt);
    b.hurtAnim = Math.max(0, (b.hurtAnim || 0) - dt);
    b.attackAnim = Math.max(0, (b.attackAnim || 0) - dt);
    b.skillFlash = Math.max(0, (b.skillFlash || 0) - dt);
    b.attackCd -= dt;
    b.patternCd -= dt;
    b.moveCd = Math.max(0, (b.moveCd || 0) - dt);
    b.pulse += dt;
    if (!b.moveTarget || b.moveCd <= 0 || dist(b, b.moveTarget) < 18) {
      const away = norm({ x: b.x - p.x, y: b.y - p.y });
      const offsets = [
        { x: away.x * 120 || 130, y: away.y * 80 || 0 },
        { x: -150, y: 0 },
        { x: 150, y: 0 },
        { x: 0, y: -74 },
        { x: 0, y: 92 }
      ];
      const pick = pickMany(offsets, offsets.length).find(o => {
        const tx = clamp(b.x + o.x, 150, worldWidth() - 150);
        const ty = clamp(b.y + o.y, 140, Math.min(worldHeight() - 190, H - 150));
        return canStandAt(tx, ty, 24);
      }) || { x: 0, y: 0 };
      b.moveTarget = {
        x: clamp(b.x + pick.x, 150, worldWidth() - 150),
        y: clamp(b.y + pick.y, 140, Math.min(worldHeight() - 190, H - 150))
      };
      b.moveCd = rand(1.0, 2.2);
    }
    if (b.moveTarget) {
      const d = norm({ x: b.moveTarget.x - b.x, y: b.moveTarget.y - b.y });
      const speed = 34 + Math.min(28, game.room * 1.2);
      const tx = b.x + d.x * speed * dt;
      const ty = b.y + d.y * speed * dt;
      if (canStandAt(tx, ty, 24)) {
        b.x = tx;
        b.y = ty;
      } else {
        b.moveTarget = null;
        b.moveCd = 0;
      }
    }
    updateMotionAnimation(b, dt, fromX, fromY, b.moveTarget ? norm({ x: b.moveTarget.x - b.x, y: b.moveTarget.y - b.y }) : null);
    b.action = resolveEntityAction(b);
    if (b.attackCd <= 0) {
      shootBossBasic(b);
      b.action = "attack";
      b.attackCd = BOSS_BASIC_CD_SECONDS;
    }
    if (b.patternCd <= 0) {
      shootBossPattern(b);
      b.action = "attack";
      b.patternCd = BOSS_SPECIAL_CD_SECONDS;
      addFloat(b.info.skillName, b.x - 40, b.y - 136, "#ffe7a5");
    }
  }

  function applyEnemyHitEffect(pr) {
    if (!game.player) return;
    if (pr.effect === "slow") {
      game.player.slowSelf = Math.max(game.player.slowSelf, 1.7);
      addFloat("减速", game.player.x - 14, game.player.y - 58, "#a6efff");
    } else if (pr.effect === "hide") {
      game.hideWordsTimer = Math.max(game.hideWordsTimer, 1.8);
      addFloat("迷雾", game.player.x - 14, game.player.y - 58, "#d5b2ff");
    }
  }

  function updateProjectiles(dt) {
    for (const pr of game.projectiles) {
      if (pr.enemy && pr.homing && game.player) {
        const speed = Math.max(1, Math.hypot(pr.vx, pr.vy));
        const cur = norm({ x: pr.vx, y: pr.vy });
        const target = norm({ x: game.player.x - pr.x, y: game.player.y - pr.y });
        const mix = clamp((pr.homingTurn || 2.2) * dt, 0, 1);
        const dir = norm({ x: cur.x * (1 - mix) + target.x * mix, y: cur.y * (1 - mix) + target.y * mix });
        pr.vx = dir.x * speed;
        pr.vy = dir.y * speed;
      }

      pr.x += pr.vx * dt;
      pr.y += pr.vy * dt;
      pr.life -= dt;

      if (pr.enemy) {
        if (game.player && dist(pr, game.player) <= (pr.radius || 10) + game.player.r) {
          if (game.player.invuln <= 0 && game.player.invincibleBuff <= 0) {
            const damage = pr.damage || 10;
            game.player.hp -= damage;
            game.player.invuln = 0.45;
            game.player.hurtAnim = 0.38;
            applyEnemyHitEffect(pr);
            addFloat(`-${damage}`, game.player.x - 12, game.player.y - 36, "#ff8a8a");
            play("hurt");
          }
          pr.life = 0;
        }
        continue;
      }

      if (bomberProjectileHit(pr)) continue;

      if (game.boss && dist(pr, game.boss) <= game.boss.r + (pr.radius || 10)) {
        const b = game.boss;
        if (isCorrectStudyMatch(pr.meaning, b.entry)) {
          const damage = pr.damage || 60;
          b.hp -= damage;
          b.hitFlash = 0.22;
          b.hurtAnim = 0.32;
          game.combo += 1;
          game.correct += 1;
          markReviewResult(b.entry, "correct", 1);
          game.score += 160 + game.combo * 18;
          addFloat("命中 Boss", b.x - 26, b.y - 88, "#b4ffb8");
          play("hit");
          if (b.hp <= 0) defeatBoss(); else setNextBossWord();
          if (pr.pierce > 0) pr.pierce -= 1;
          else {
            pr.consumed = true;
            pr.life = 0;
          }
        } else {
          game.combo = 0;
          game.wrong += 1;
          markReviewResult(b.entry, "wrong", 1);
          game.score = Math.max(0, game.score - 42);
          returnProjectileMeaningRandom(pr, 1.1);
          addFloat("错配·随机刷新", b.x - 44, b.y - 88, "#ffb3a5");
          play("wrong");
          pr.life = 0;
        }
        continue;
      }

      for (const m of game.monsters) {
        if (m.dead || dist(pr, m) > m.r + (pr.radius || 10)) continue;
        if (isCorrectStudyMatch(pr.meaning, m.entry)) {
          // 普通怪：正确翻译命中即击败，不走血量扣减。
          // Boss 才有血量，需要多个正确翻译才能击败。
          m.hp = 0;
          m.hitFlash = 0.18;
          m.hurtAnim = 0.28;
          game.combo += 1;
          game.correct += 1;
          markReviewResult(m.entry, "correct", 1);
          game.score += 100 + game.combo * 12;
          addFloat("正确消灭", m.x - 28, m.y - 42, "#b4ffb8");
          play("hit");
          m.dead = true; addFloat("+100", m.x - 14, m.y - 60, "#ffe083");
          if (pr.pierce > 0) pr.pierce -= 1;
          else {
            pr.consumed = true;
            pr.life = 0;
          }
        } else {
          game.combo = 0;
          game.wrong += 1;
          markReviewResult(m.entry, "wrong", 1);
          game.score = Math.max(0, game.score - 35);
          triggerWrongHitAggro(m);
          m.hurtAnim = 0.24;
          returnProjectileMeaningRandom(pr, 1.1);
          addFloat("错配·随机刷新", m.x - 44, m.y - 42, "#ffb3a5");
          play("wrong");
          pr.life = 0;
        }
        break;
      }
    }

    for (const pr of game.projectiles) {
      if (!pr.enemy && pr.life <= 0 && !pr.consumed) returnProjectileMeaning(pr, pr.x, pr.y, 0.85);
    }
    for (const pr of game.projectiles) {
      const outside = pr.x <= -40 || pr.x >= worldWidth() + 40 || pr.y <= -40 || pr.y >= worldHeight() + 40;
      if (!pr.enemy && !pr.returned && outside) {
        returnProjectileMeaning(pr, pr.x, pr.y, 0.85);
        pr.life = 0;
      }
    }

    game.projectiles = game.projectiles.filter(p => p.life > 0 && p.x > -60 && p.x < worldWidth() + 60 && p.y > -60 && p.y < worldHeight() + 60);
    game.monsters = game.monsters.filter(m => !m.dead);
  }
  function updateTokens(dt) {
    for (const t of [...game.tokens]) {
      t.glow = Math.max(0, t.glow - dt);
      if (game.player && !game.player.held && dist(game.player, t) < game.player.r + t.r + 6) {
        collectToken(t);
        break;
      }
    }
  }

  function updateFloats(dt) {
    for (const f of game.floats) {
      f.life -= dt;
      f.y -= 26 * dt;
    }
    game.floats = game.floats.filter(f => f.life > 0);
  }

  function facingVector(facing = game.player?.facing || 0) {
    if (facing === 1) return { x: -1, y: 0 };
    if (facing === 2) return { x: 1, y: 0 };
    if (facing === 3) return { x: 0, y: -1 };
    return { x: 0, y: 1 };
  }

  function facingFromVector(vec, fallbackFacing = 0) {
    const x = Number(vec?.x || 0);
    const y = Number(vec?.y || 0);
    if (Math.abs(x) + Math.abs(y) < 0.16) return clamp(fallbackFacing ?? 0, 0, 3) | 0;
    if (Math.abs(x) >= Math.abs(y)) return x < 0 ? 1 : 2;
    return y < 0 ? 3 : 0;
  }

  function keyboardMoveVector() {
    return {
      x: (game.keys.has("KeyD") || game.keys.has("ArrowRight") ? 1 : 0) - (game.keys.has("KeyA") || game.keys.has("ArrowLeft") ? 1 : 0),
      y: (game.keys.has("KeyS") || game.keys.has("ArrowDown") ? 1 : 0) - (game.keys.has("KeyW") || game.keys.has("ArrowUp") ? 1 : 0)
    };
  }

  function axisLockedDirection(raw = null, fallbackFacing = game.player?.facing || 0) {
    // 子弹弹道只允许横平竖直四方向：左、右、上、下。
    // 任意拖拽/鼠标角度都会吸附到绝对值更大的轴，彻底取消斜向子弹。
    const x = Number(raw?.x || 0);
    const y = Number(raw?.y || 0);
    if (Math.hypot(x, y) >= 0.12) {
      if (Math.abs(x) >= Math.abs(y)) {
        return x < 0 ? { x: -1, y: 0, facing: 1 } : { x: 1, y: 0, facing: 2 };
      }
      return y < 0 ? { x: 0, y: -1, facing: 3 } : { x: 0, y: 1, facing: 0 };
    }
    const facing = clamp(fallbackFacing ?? 0, 0, 3) | 0;
    const fallback = facingVector(facing);
    return { ...fallback, facing };
  }

  function freeActionDirection(raw = null, fallbackFacing = game.player?.facing || 0) {
    // 闪现和移动仍保留自由方向手感，不复用子弹四方向吸附逻辑。
    const x = Number(raw?.x || 0);
    const y = Number(raw?.y || 0);
    if (Math.hypot(x, y) >= 0.12) {
      const dir = norm({ x, y });
      return { x: dir.x, y: dir.y, facing: facingFromVector(dir, fallbackFacing) };
    }
    const facing = clamp(fallbackFacing ?? 0, 0, 3) | 0;
    const fallback = facingVector(facing);
    return { ...fallback, facing };
  }

  function currentFreeActionDirection() {
    const move = Math.abs(game.touchMove.x || 0) + Math.abs(game.touchMove.y || 0) > 0.16
      ? game.touchMove
      : keyboardMoveVector();
    if (Math.abs(move.x || 0) + Math.abs(move.y || 0) > 0.16) {
      return freeActionDirection(move, game.player?.facing || 0);
    }
    if (game.player?.gridDir?.x || game.player?.gridDir?.y) {
      return freeActionDirection(game.player.gridDir, game.player.facing || 0);
    }
    return freeActionDirection(null, game.player?.facing || 0);
  }

  function currentMoveFireDirection() {
    return axisLockedDirection(currentFreeActionDirection(), game.player?.facing || 0);
  }

  function beginPlayerAttack(p, fireDir, duration) {
    if (!p || !fireDir) return;
    const dir = axisLockedDirection(fireDir, p.facing || 0);
    const facing = clamp(dir.facing ?? facingFromVector(dir, p.facing ?? 0), 0, 3) | 0;
    const attackDuration = Math.max(0.12, Number(duration || 0.34));
    p.attackFacing = facing;
    p.attackActionFacing = facing;
    p.attackActionDir = { x: Number(dir.x || 0), y: Number(dir.y || 0), facing };
    p.attackActionTimer = attackDuration;
    p.attackLockTimer = attackDuration;
    p.fireAnim = attackDuration;
    p.facing = facing;
  }

  function aimDir() {
    // PC 鼠标仍可自由瞄准，但真正生成子弹前会统一吸附为横平竖直四方向。
    if (isMobileControlMode()) return currentMoveFireDirection();
    return norm({ x: game.mouse.x - game.player.x, y: game.mouse.y - game.player.y });
  }

  function fire(target = null, forcedDir = null) {
    if (game.mode !== "playing" || !game.player.held) return;
    const p = game.player;
    const rawDir = forcedDir
      ? freeActionDirection(forcedDir, p.facing || 0)
      : (target ? norm({ x: target.x - p.x, y: target.y - p.y }) : aimDir());
    const fireDir = axisLockedDirection(rawDir, p.facing || 0);
    const d = { x: fireDir.x, y: fireDir.y };
    if (!d.x && !d.y) return;
    const hero = selectedHero();
    const attackDuration = hero.actions?.attack?.duration || 0.38;
    beginPlayerAttack(p, fireDir, attackDuration);
    if (hero.attackType === "melee") {
      game.projectiles.push({
        meaning: p.held,
        melee: true,
        color: hero.projectileColor || hero.tint || "#fff2a0",
        x: p.x + d.x * 52,
        y: p.y + d.y * 52 - 8,
        vx: d.x,
        vy: d.y,
        radius: 76,
        damage: hero.damage || 85,
        life: 0.18
      });
      p.held = "";
      play("fire");
      return;
    }
    game.projectiles.push({
      meaning: p.held,
      x: p.x + d.x * 35,
      y: p.y + d.y * 35 - 8,
      vx: d.x * (hero.projectileSpeed || 620),
      vy: d.y * (hero.projectileSpeed || 620),
      radius: hero.projectileRadius || 8,
      color: hero.projectileColor || "#fff2a0",
      attackType: hero.attackType || "gun",
      damage: hero.damage || 60,
      pierce: p.pierceBuff > 0 ? 999 : 0,
      pierceWalls: p.pierceBuff > 0,
      life: 2.6
    });
    p.held = "";
    play("fire");
  }

  function interact() {
    if (game.mode !== "playing") return;
    const p = game.player;
    let best = null;
    let bestDist = 78;
    for (const t of game.tokens) {
      const d = dist(p, t);
      if (d < bestDist) {
        best = t;
        bestDist = d;
      }
    }
    if (!best) return;
    collectToken(best);
  }


  function dash(forcedDir = null) {
    if (game.mode !== "playing" || game.player.dashCd > 0) return;
    const p = game.player;
    let raw = forcedDir ? norm(forcedDir) : norm({ x: game.touchMove.x, y: game.touchMove.y });
    if (!raw.x && !raw.y) {
      raw = {
        x: (game.keys.has("KeyD") || game.keys.has("ArrowRight") ? 1 : 0) - (game.keys.has("KeyA") || game.keys.has("ArrowLeft") ? 1 : 0),
        y: (game.keys.has("KeyS") || game.keys.has("ArrowDown") ? 1 : 0) - (game.keys.has("KeyW") || game.keys.has("ArrowUp") ? 1 : 0)
      };
      raw = norm(raw);
    }
    // 闪现规范：
    // - 有移动输入：按当前移动方向闪现；
    // - 没有移动输入：按当前面朝方向闪现。
    // 这里不能再用 aimDir()，否则手机端会受“鼠标瞄准点/最后触摸点”影响。
    if (!raw.x && !raw.y) raw = facingVector(p.facing || 0);

    const dashDir = axisLockedDirection(raw, p.facing || 0);
    const d = { x: dashDir.x, y: dashDir.y };
    p.facing = dashDir.facing;
    p.dashFacing = dashDir.facing;

    const fromX = p.x, fromY = p.y;
    let dashed = false;
    const radius = Math.max(10, p.r - 4);

    const startCell = pointToBomberCell(p.x, p.y);
    const startCenter = bomberCellCenter(startCell.col, startCell.row);
    p.x = startCenter.x;
    p.y = startCenter.y;
    const target = canGridDashToCell(startCell, d, 2, radius) || canGridDashToCell(startCell, d, 1, radius);
    if (target) {
      p.x = target.x;
      p.y = target.y;
      dashed = true;
    }

    p.tileTarget = null;
    p.gridDir = null;
    p.tileReady = false;

    if (!dashed) addFloat("墙体阻挡", p.x - 22, p.y - 36, "#d6f2ff");
    p.dashCd = 1.1;
    p.invuln = 0.35;
    p.dashAnim = 0.28;
    play("dash");
  }

  function shield() {
    if (game.mode !== "playing") return;
    game.player.shield = Math.max(game.player.shield, POSITIVE_BUFF_DURATION);
    addFloat(`护盾 ${POSITIVE_BUFF_DURATION}秒`, game.player.x - 38, game.player.y - 36, "#91d9ff");
  }


  function useBook() {
    if (game.mode !== "playing") return false;

    // 图鉴已打开时，再按一次 Tab/T/按钮立即收回，不再卡住视线。
    if (game.showBook) {
      game.showBook = false;
      game.bookTimer = 0;
      game.message = "图鉴已收起";
      return true;
    }

    if (game.bookCd > 0) {
      const left = Math.ceil(game.bookCd);
      game.message = `图鉴冷却中：${left}秒`;
      if (game.player) addFloat(`图鉴CD ${left}s`, game.player.x - 34, game.player.y - 72, "#9fdcff");
      return false;
    }

    game.showBook = true;
    game.bookTimer = BOOK_SHOW_DURATION;
    game.bookCd = BOOK_COOLDOWN;
    game.message = `图鉴开启 ${BOOK_SHOW_DURATION}秒，再按 Tab/T 可收起，冷却 ${BOOK_COOLDOWN}秒`;
    play("pickup", 0.32);
    return true;
  }

  function drawBook() {
    const x = isPortraitMode() ? 40 : 150;
    const y = isPortraitMode() ? 150 : 82;
    const w = isPortraitMode() ? W - 80 : 980;
    const h = isPortraitMode() ? H - 260 : 540;
    const t = uiPulse(640);
    ctx.save();
    ctx.fillStyle = 'rgba(2,5,14,.74)';
    ctx.fillRect(0, 0, W, H);
    drawFantasyPanel(x, y, w, h, {
      accent: '#a78bff', radius: 28,
      fillTop: 'rgba(54,42,112,.72)', fillBottom: 'rgba(10,50,78,.82)',
      stroke: `rgba(204,176,255,${0.26 + t * 0.16})`,
      shadow: 'rgba(138,104,255,.22)', shadowBlur: 18, pulse: true,
      noDeco: true, noInner: true
    });
    ctx.fillStyle = '#f7fbff';
    ctx.font = isPortraitMode() ? '900 38px Microsoft YaHei UI' : '900 34px Microsoft YaHei UI';
    textCenter('战斗图鉴', x + w / 2, y + 54);
    ctx.fillStyle = 'rgba(214,232,255,.86)';
    ctx.font = '15px Microsoft YaHei UI';
    textCenter(`快捷键 T · 显示 ${BOOK_SHOW_DURATION}秒 · 冷却 ${BOOK_COOLDOWN}秒`, x + w / 2, y + 84);

    const rows = [];
    if (game.player?.held) rows.push({ kind: '当前弹药', word: '', meaning: game.player.held, color: '#ffe083' });
    for (const m of game.monsters || []) if (!m.dead && m.entry) rows.push({ kind: '怪物', word: m.entry.word, meaning: m.entry.meaning, color: '#fff096' });
    if (game.boss?.entry) rows.push({ kind: 'Boss', word: game.boss.entry.word, meaning: game.boss.entry.meaning, color: game.boss.info?.color || '#ffcf8a' });
    for (const tk of game.tokens || []) if (tk.entry) rows.push({ kind: '场上译文', word: tk.entry.word || '', meaning: tk.entry.meaning, color: '#b4ffcf' });

    const unique = [];
    const seen = new Set();
    for (const row of rows) { const key = `${row.kind}|${row.word}|${row.meaning}`; if (!seen.has(key)) { seen.add(key); unique.push(row); } }

    const colX = [x + 38, x + Math.min(180, w * 0.24), x + Math.min(430, w * 0.52)];
    ctx.font = '800 16px Microsoft YaHei UI';
    ctx.fillStyle = 'rgba(232,238,255,.58)';
    ctx.fillText('类型', colX[0], y + 128);
    ctx.fillText('单词', colX[1], y + 128);
    ctx.fillText('译文 / 目标', colX[2], y + 128);

    const maxRows = isPortraitMode() ? 20 : 13;
    unique.slice(0, maxRows).forEach((row, i) => {
      const yy = y + 164 + i * (isPortraitMode() ? 32 : 30);
      drawFantasyPanel(x + 24, yy - 23, w - 48, 27, {
        accent: row.color, radius: 12,
        fillTop: i % 2 ? 'rgba(50,44,92,.24)' : 'rgba(26,52,82,.26)',
        fillBottom: 'rgba(12,22,42,.28)', stroke: 'rgba(255,255,255,.04)', shadowBlur: 0,
        noDeco: true, noInner: true
      });
      ctx.fillStyle = row.color;
      ctx.font = '800 15px Microsoft YaHei UI';
      ctx.fillText(row.kind, colX[0], yy);
      ctx.fillStyle = '#f4fbff';
      ctx.fillText(row.word || '—', colX[1], yy);
      ctx.fillStyle = '#c9f2ff';
      ctx.fillText(String(row.meaning || '—').slice(0, isPortraitMode() ? 20 : 34), colX[2], yy);
    });

    if (!unique.length) {
      ctx.fillStyle = 'rgba(220,232,255,.86)';
      ctx.font = '900 22px Microsoft YaHei UI';
      textCenter('暂无可显示内容', x + w / 2, y + 170);
    }
    ctx.restore();
  }

  function updateTouchButtonLabels() {
    const p = game.player;
    const fireButton = document.querySelector('[data-action="fire"]');
    if (fireButton) {
      // 手机端发射按钮固定显示“发射”，不再把拾取到的词/译文写进按钮，避免按钮文字拥挤和误判为弹药栏。
      fireButton.textContent = "发射";
      fireButton.title = "发射";
    }
    const dashButton = document.querySelector('[data-action="dash"]');
    if (dashButton) {
      dashButton.textContent = p?.dashCd > 0 ? `闪${p.dashCd.toFixed(1)}` : "闪现";
      dashButton.title = p?.dashCd > 0 ? `闪现冷却 ${p.dashCd.toFixed(1)} 秒` : "闪现";
    }
    const bookButton = document.querySelector('[data-action="book"]');
    if (bookButton) {
      const left = Math.ceil(game.bookCd || 0);
      if (game.showBook) {
        bookButton.textContent = "收起";
        bookButton.title = "收起图鉴";
        bookButton.disabled = false;
      } else {
        bookButton.textContent = left > 0 ? `图${left}` : "图鉴";
        bookButton.title = left > 0 ? `图鉴冷却 ${left} 秒` : "图鉴（T / Tab）";
        bookButton.disabled = left > 0;
      }
    }
  }

  function drawFantasyBackdrop(alpha = 1) {
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#081326');
    bg.addColorStop(0.42, '#12264a');
    bg.addColorStop(1, '#0a1322');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    const moon = ctx.createRadialGradient(W * 0.5, H * 0.16, 10, W * 0.5, H * 0.16, W * 0.22);
    moon.addColorStop(0, `rgba(167,203,255,${0.24 * alpha})`);
    moon.addColorStop(0.45, `rgba(102,146,255,${0.10 * alpha})`);
    moon.addColorStop(1, 'rgba(88,86,214,0)');
    ctx.fillStyle = moon;
    ctx.fillRect(0, 0, W, H);

    const leftGlow = ctx.createRadialGradient(W * 0.18, H * 0.68, 12, W * 0.18, H * 0.68, W * 0.28);
    leftGlow.addColorStop(0, `rgba(62,255,230,${0.16 * alpha})`);
    leftGlow.addColorStop(1, 'rgba(62,255,230,0)');
    ctx.fillStyle = leftGlow;
    ctx.fillRect(0, 0, W, H);

    const rightGlow = ctx.createRadialGradient(W * 0.86, H * 0.52, 12, W * 0.86, H * 0.52, W * 0.24);
    rightGlow.addColorStop(0, `rgba(188,126,255,${0.17 * alpha})`);
    rightGlow.addColorStop(1, 'rgba(188,126,255,0)');
    ctx.fillStyle = rightGlow;
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = 'rgba(10,18,30,.55)';
    ctx.lineWidth = 8;
    for (let i = 0; i < 10; i++) {
      const x = i * 160 + (i % 2) * 25;
      ctx.beginPath();
      ctx.moveTo(x, H);
      ctx.quadraticCurveTo(x + 10, H * 0.72, x + 28, H * 0.40);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(0, H * 0.78);
    for (let i = 0; i <= 7; i++) {
      const x = (W / 7) * i;
      const y = H * (0.72 + (i % 2) * 0.05);
      ctx.quadraticCurveTo(x - 40, y + 20, x, y);
    }
    ctx.strokeStyle = 'rgba(8,16,28,.78)';
    ctx.lineWidth = 160;
    ctx.stroke();

    for (let i = 0; i < 24; i++) {
      const x = (i * 137) % W;
      const y = 80 + ((i * 73) % Math.max(1, H - 220));
      const r = 2 + (i % 3);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 7);
      const c = i % 2 === 0 ? '128,255,232' : '176,126,255';
      g.addColorStop(0, `rgba(${c},.92)`);
      g.addColorStop(0.45, `rgba(${c},.18)`);
      g.addColorStop(1, `rgba(${c},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r * 7, 0, Math.PI * 2);
      ctx.fill();
    }

    const vignette = ctx.createRadialGradient(W * 0.5, H * 0.48, Math.min(W, H) * 0.15, W * 0.5, H * 0.5, Math.max(W, H) * 0.68);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,.55)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, W, H);
  }

  function uiPulse(speed = 720, phase = 0) {
    return 0.5 + Math.sin(performance.now() / speed + phase) * 0.5;
  }

  function uiPhase(x = 0, y = 0) {
    return (x * 0.017 + y * 0.011) % 6.283;
  }

  function drawUiGlow(x, y, w, h, accent = '#9b8cff', alpha = 0.16) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const r = Math.max(w, h) * 0.7;
    const g = ctx.createRadialGradient(cx, cy, 8, cx, cy, r);
    g.addColorStop(0, accent + Math.floor(clamp(alpha * 255, 0, 255)).toString(16).padStart(2, '0'));
    g.addColorStop(0.55, 'rgba(116,92,255,.08)');
    g.addColorStop(1, 'rgba(116,92,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(cx, cy, w * 0.58, h * 0.58, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawFantasyPanel(x, y, w, h, opts = {}) {
    const accent = opts.accent || '#a78bff';
    const phase = uiPhase(x, y);
    const pulse = opts.pulse ? uiPulse(520, phase) : 0;
    const fill = ctx.createLinearGradient(x, y, x + w, y + h);
    fill.addColorStop(0, opts.fillTop || `rgba(40,34,86,${0.54 + pulse * 0.08})`);
    fill.addColorStop(0.52, opts.fillMid || 'rgba(18,30,64,.62)');
    fill.addColorStop(1, opts.fillBottom || `rgba(10,54,78,${0.64 + pulse * 0.08})`);

    ctx.save();
    ctx.shadowColor = opts.shadow || (opts.pulse ? 'rgba(136,214,255,.30)' : accent + '24');
    ctx.shadowBlur = opts.shadowBlur != null ? opts.shadowBlur + pulse * 10 : 10 + pulse * 8;
    roundRect(x, y, w, h, opts.radius || 20, fill, opts.stroke || `rgba(178,154,255,${0.18 + pulse * 0.18})`, opts.line || 1);
    ctx.restore();

    if (opts.glow || opts.pulse) drawUiGlow(x, y, w, h, accent, 0.08 + pulse * 0.08);

    if (!opts.noInner) {
      ctx.strokeStyle = opts.innerStroke || `rgba(214,238,255,${0.035 + pulse * 0.04})`;
      ctx.lineWidth = 1;
      roundRectRaw(x + 10, y + 10, w - 20, h - 20, Math.max(8, (opts.radius || 20) - 6));
      ctx.stroke();
    }
    if (!opts.noDeco && opts.corner) {
      const cs = opts.corner || 16;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      const corners = [[x + 12, y + 12, 1, 1], [x + w - 12, y + 12, -1, 1], [x + 12, y + h - 12, 1, -1], [x + w - 12, y + h - 12, -1, -1]];
      for (const [cx, cy, sx, sy] of corners) {
        ctx.beginPath();
        ctx.moveTo(cx, cy + sy * cs * 0.45);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx + sx * cs * 0.45, cy);
        ctx.stroke();
      }
    }
  }

  function drawFantasyTitle(x, y, w, title, accent = '#d8f2ff') {
    ctx.fillStyle = accent;
    ctx.font = '900 28px Microsoft YaHei UI';
    textCenter(title, x + w / 2, y + 12);
  }

  function drawFantasyButton(x, y, w, h, label, opts = {}) {
    const primary = !!opts.primary;
    const disabled = !!opts.disabled;
    const t = uiPulse(primary ? 520 : 900, uiPhase(x, y));
    const fill = ctx.createLinearGradient(x, y, x + w, y + h);
    if (primary) {
      fill.addColorStop(0, disabled ? 'rgba(70,72,100,.38)' : `rgba(138,92,255,${0.66 + t * 0.10})`);
      fill.addColorStop(0.52, disabled ? 'rgba(54,72,92,.42)' : `rgba(62,180,226,${0.70 + t * 0.08})`);
      fill.addColorStop(1, disabled ? 'rgba(36,54,76,.46)' : `rgba(38,218,216,${0.62 + t * 0.08})`);
    } else {
      fill.addColorStop(0, `rgba(44,46,96,${0.36 + t * 0.04})`);
      fill.addColorStop(1, `rgba(18,36,72,${0.48 + t * 0.04})`);
    }
    ctx.save();
    ctx.shadowColor = primary ? `rgba(116,226,255,${0.16 + t * 0.10})` : 'rgba(0,0,0,.10)';
    ctx.shadowBlur = primary ? 10 + t * 8 : 6;
    roundRect(x, y, w, h, Math.min(h / 2, 22), fill, primary ? `rgba(210,238,255,${0.32 + t * 0.18})` : 'rgba(160,178,230,.14)', 1);
    ctx.restore();
    if (primary && !disabled) {
      const glow = ctx.createRadialGradient(x + w * (0.35 + t * 0.3), y + h * 0.2, 4, x + w * (0.35 + t * 0.3), y + h * 0.2, w * 0.42);
      glow.addColorStop(0, 'rgba(255,255,255,.16)');
      glow.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = glow;
      roundRectRaw(x, y, w, h, Math.min(h / 2, 22));
      ctx.fill();
    }
    ctx.fillStyle = disabled ? 'rgba(255,255,255,.36)' : '#f6fbff';
    ctx.font = primary ? '900 22px Microsoft YaHei UI' : '700 18px Microsoft YaHei UI';
    textCenter(label, x + w / 2, y + h / 2 + 7);
  }

  function drawFantasySwitch(x, y, on) {
    const w = 82, h = 38;
    drawFantasyPanel(x, y, w, h, {
      accent: on ? '#76fff0' : '#7ea4d9',
      fillTop: on ? 'rgba(36,116,110,.48)' : 'rgba(28,40,62,.42)',
      fillBottom: on ? 'rgba(16,82,90,.58)' : 'rgba(16,24,40,.50)',
      stroke: on ? 'rgba(132,255,244,.32)' : 'rgba(112,148,210,.18)',
      shadow: on ? 'rgba(85,255,231,.14)' : 'rgba(0,0,0,.08)',
      shadowBlur: on ? 8 : 4,
      radius: 19,
      noDeco: true,
      noInner: true
    });
    ctx.fillStyle = on ? 'rgba(214,255,250,.96)' : 'rgba(230,240,255,.90)';
    ctx.beginPath();
    ctx.arc(x + (on ? 58 : 24), y + 19, 13.5, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawLoadingScreen() {
    ctx.clearRect(0, 0, W, H);
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, "#071217");
    bg.addColorStop(1, "#10251f");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#effdff";
    ctx.font = "800 42px Microsoft YaHei UI";
    center("头号玩家", 250);
    ctx.fillStyle = "#b8ead2";
    ctx.font = "700 20px Microsoft YaHei UI";
    center(game.message || loadProgress.title || "正在加载...", 314);

    const pct = clampProgress(loadProgress.percent);
    const pctText = `${Math.round(pct * 100)}%`;
    const w = 420;
    const x = W / 2 - w / 2;
    ctx.fillStyle = "rgba(255,255,255,.12)";
    roundRectRaw(x, 350, w, 14, 7);
    ctx.fill();
    ctx.fillStyle = "rgba(143,255,194,.86)";
    roundRectRaw(x, 350, Math.max(8, pct * w), 14, 7);
    ctx.fill();

    ctx.fillStyle = "rgba(239,253,255,.94)";
    ctx.font = "800 22px Microsoft YaHei UI";
    center(pctText, 394);
    ctx.fillStyle = "rgba(184,234,210,.86)";
    ctx.font = "600 16px Microsoft YaHei UI";
    center(loadProgress.total ? `${loadProgress.stage} · ${loadProgress.done}/${loadProgress.total}` : loadProgress.stage, 424);
  }

  function draw() {
    updateTouchButtonLabels();
    ctx.clearRect(0, 0, W, H);
    if (game.mode === "settings") return drawSettings();
    if (game.mode === "menu") return drawMenu();
    if (game.mode === "loading") return drawLoadingScreen();
    drawGame();
    if (game.mode === "reward") drawRewards();
    if (game.mode === "paused") drawPanel("\u6682\u505c", "\u624b\u673a\u70b9\u51fb\u53f3\u4e0a\u89d2\u7ee7\u7eed\u6309\u94ae\uff0c\u7535\u8111\u6309 Esc \u7ee7\u7eed");
    if (game.mode === "gameover") drawGameOver();
    if (game.showBook && game.mode === "playing") drawBook();
  }


  function drawBombermanMap(theme) {
    const ww = worldWidth();
    const wh = worldHeight();
    const g = BOMBER_GRID;

    ctx.clearRect(0, 0, ww, wh);

    const arena = ctx.createLinearGradient(g.x, g.y, g.x + g.cols * g.tile, g.y + g.rows * g.tile);
    arena.addColorStop(0, "#7db464");
    arena.addColorStop(0.42, "#5f9b4f");
    arena.addColorStop(1, "#3d6f38");
    ctx.fillStyle = arena;
    ctx.fillRect(g.x, g.y, g.cols * g.tile, g.rows * g.tile);

    const path = ctx.createLinearGradient(g.x, g.y, g.x, g.y + g.rows * g.tile);
    path.addColorStop(0, "rgba(225,237,176,.18)");
    path.addColorStop(1, "rgba(84,122,66,.16)");
    ctx.fillStyle = path;
    for (let row = 0; row < g.rows; row++) {
      for (let col = 0; col < g.cols; col++) {
        const x = g.x + col * g.tile;
        const y = g.y + row * g.tile;
        if ((row + col) % 2 === 0) ctx.fillRect(x + 1, y + 1, g.tile - 2, g.tile - 2);
        if (((row * 17 + col * 31) % 19) === 0) {
          ctx.fillStyle = "rgba(220,248,162,.16)";
          ctx.fillRect(x + g.tile * 0.62, y + g.tile * 0.28, 9, 2);
          ctx.fillRect(x + g.tile * 0.66, y + g.tile * 0.32, 2, 8);
          ctx.fillStyle = path;
        }
      }
    }

    ctx.strokeStyle = "rgba(230,242,214,.08)";
    ctx.lineWidth = 1;
    for (let col = 0; col <= g.cols; col++) {
      const x = g.x + col * g.tile;
      ctx.beginPath();
      ctx.moveTo(x, g.y);
      ctx.lineTo(x, g.y + g.rows * g.tile);
      ctx.stroke();
    }
    for (let row = 0; row <= g.rows; row++) {
      const y = g.y + row * g.tile;
      ctx.beginPath();
      ctx.moveTo(g.x, y);
      ctx.lineTo(g.x + g.cols * g.tile, y);
      ctx.stroke();
    }

    ctx.strokeStyle = "rgba(229,240,214,.28)";
    ctx.lineWidth = 3;
    ctx.strokeRect(g.x - 2, g.y - 2, g.cols * g.tile + 4, g.rows * g.tile + 4);

    const vignette = ctx.createRadialGradient(ww / 2, wh / 2, 120, ww / 2, wh / 2, Math.max(ww, wh) * 0.58);
    vignette.addColorStop(0, "rgba(255,255,255,0)");
    vignette.addColorStop(1, "rgba(3,8,15,.34)");
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, ww, wh);
  }

  function bomberBlockNeighborMap() {
    const map = new Map();
    for (const block of game.bomberBlocks || []) {
      map.set(`${block.kind}:${block.col},${block.row}`, block);
    }
    return map;
  }

  function hasSameBomberNeighbor(neighborMap, block, dx, dy) {
    return neighborMap.has(`${block.kind}:${block.col + dx},${block.row + dy}`);
  }

  function drawBomberBlocks() {
    if (!game.bomberBlocks?.length) return;
    const neighborMap = bomberBlockNeighborMap();

    for (const block of game.bomberBlocks) {
      const x = block.x;
      const y = block.y;
      const w = block.w;
      const h = block.h;
      const sameL = hasSameBomberNeighbor(neighborMap, block, -1, 0);
      const sameR = hasSameBomberNeighbor(neighborMap, block, 1, 0);
      const sameU = hasSameBomberNeighbor(neighborMap, block, 0, -1);
      const sameD = hasSameBomberNeighbor(neighborMap, block, 0, 1);

      if (block.kind === "hard") {
        const grad = ctx.createLinearGradient(x, y, x, y + h);
        grad.addColorStop(0, "#eef4fb");
        grad.addColorStop(0.42, "#b8c4d2");
        grad.addColorStop(1, "#7a8798");
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, w, h);

        const sheen = ctx.createLinearGradient(x, y, x + w, y + h);
        sheen.addColorStop(0, "rgba(255,255,255,.22)");
        sheen.addColorStop(0.55, "rgba(255,255,255,.03)");
        sheen.addColorStop(1, "rgba(133,225,255,.10)");
        ctx.fillStyle = sheen;
        ctx.fillRect(x + 1, y + 1, w - 2, h - 2);

        ctx.fillStyle = "rgba(255,255,255,.24)";
        ctx.fillRect(x + 5, y + 5, w - 10, 3);
        ctx.fillStyle = "rgba(35,46,62,.18)";
        ctx.fillRect(x + 7, y + h - 9, w - 14, 4);

        ctx.strokeStyle = "rgba(30,40,54,.78)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        if (!sameL) { ctx.moveTo(x + 0.5, y); ctx.lineTo(x + 0.5, y + h); }
        if (!sameR) { ctx.moveTo(x + w - 0.5, y); ctx.lineTo(x + w - 0.5, y + h); }
        if (!sameU) { ctx.moveTo(x, y + 0.5); ctx.lineTo(x + w, y + 0.5); }
        if (!sameD) { ctx.moveTo(x, y + h - 0.5); ctx.lineTo(x + w, y + h - 0.5); }
        ctx.stroke();
      } else {
        const grad = ctx.createLinearGradient(x, y, x, y + h);
        grad.addColorStop(0, "#d2a078");
        grad.addColorStop(0.5, "#a96f4d");
        grad.addColorStop(1, "#6f4738");
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, w, h);

        // v92：红砖改为“连片拼接”纹理。
        // 核心做法：
        // 1) 砖缝不再基于每块自己的 inset 小盒子，而是按全局坐标统一排布；
        // 2) 相邻红砖之间不画内侧粗外框；
        // 3) 砖缝线直接延伸到拼接边，让多个红砖连起来更像一整面墙。
        const bandH = h / 3;
        const row1Y = y + bandH;
        const row2Y = y + bandH * 2;
        const brickW = Math.max(20, w / 2);
        const mortar = "rgba(58,34,26,.68)";
        const mortarHi = "rgba(255,237,220,.24)";

        ctx.fillStyle = "rgba(255,255,255,.14)";
        ctx.fillRect(x, y + 3, w, 3);
        ctx.fillStyle = "rgba(0,0,0,.12)";
        ctx.fillRect(x, y + h - 5, w, 3);

        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();

        // 横向砖缝统一贯穿，视觉上连片。
        ctx.strokeStyle = mortar;
        ctx.lineWidth = 1.8;
        ctx.lineCap = "butt";
        ctx.beginPath();
        ctx.moveTo(x, row1Y); ctx.lineTo(x + w, row1Y);
        ctx.moveTo(x, row2Y); ctx.lineTo(x + w, row2Y);
        ctx.stroke();

        // 每层竖缝按全局坐标统一排布，相邻块自然对齐。
        const bands = [
          { y0: y, y1: row1Y, offset: brickW * 0.5 },
          { y0: row1Y, y1: row2Y, offset: 0 },
          { y0: row2Y, y1: y + h, offset: brickW * 0.5 }
        ];
        const anchorX = BOMBER_GRID.x;
        for (const band of bands) {
          let vx = anchorX + band.offset;
          while (vx > x) vx -= brickW;
          while (vx < x - brickW) vx += brickW;
          for (; vx <= x + w + brickW; vx += brickW) {
            const nearLeft = Math.abs(vx - x) < 1.2;
            const nearRight = Math.abs(vx - (x + w)) < 1.2;
            if ((nearLeft && sameL) || (nearRight && sameR)) continue;
            ctx.beginPath();
            ctx.moveTo(vx, band.y0);
            ctx.lineTo(vx, band.y1);
            ctx.stroke();
          }
        }

        // 轻微高光，让砖面不死板，但不再产生块与块之间的缝隙感。
        ctx.strokeStyle = mortarHi;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y + 1.5); ctx.lineTo(x + w, y + 1.5);
        ctx.moveTo(x, row1Y + 1); ctx.lineTo(x + w, row1Y + 1);
        ctx.moveTo(x, row2Y + 1); ctx.lineTo(x + w, row2Y + 1);
        ctx.stroke();
        ctx.restore();

        // 细裂纹保留，但位置做成按块稳定分布，不影响拼接连贯感。
        const crackSeed = ((block.col ?? Math.round(x)) * 17 + (block.row ?? Math.round(y)) * 31) % 100;
        ctx.strokeStyle = "rgba(92,42,28,.28)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + w * (0.18 + (crackSeed % 9) * 0.01), y + 7);
        ctx.lineTo(x + w * 0.28, y + 14);
        ctx.lineTo(x + w * 0.20, y + 21);
        ctx.moveTo(x + w * 0.70, row1Y + 5);
        ctx.lineTo(x + w * 0.78, row1Y + 11);
        ctx.lineTo(x + w * 0.73, row1Y + 18);
        ctx.moveTo(x + w * 0.38, row2Y + 4);
        ctx.lineTo(x + w * 0.33, row2Y + 12);
        ctx.stroke();

        // 外轮廓只绘制暴露边，相邻砖墙无缝拼接
        ctx.strokeStyle = "rgba(24,19,18,.78)";
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        if (!sameL) { ctx.moveTo(x + 1, y); ctx.lineTo(x + 1, y + h); }
        if (!sameR) { ctx.moveTo(x + w - 1, y); ctx.lineTo(x + w - 1, y + h); }
        if (!sameU) { ctx.moveTo(x, y + 1); ctx.lineTo(x + w, y + 1); }
        if (!sameD) { ctx.moveTo(x, y + h - 1); ctx.lineTo(x + w, y + h - 1); }
        ctx.stroke();
        if ((block.maxHp || 2) > 1) {
          const charge = (block.storedMeanings?.length || 0);
          if (charge > 0) {
            ctx.fillStyle = "rgba(255, 70, 58, .24)";
            ctx.fillRect(x + 4, y + 4, w - 8, h - 8);
            ctx.strokeStyle = "rgba(255, 220, 140, .72)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(x + w * 0.22, y + h * 0.25);
            ctx.lineTo(x + w * 0.46, y + h * 0.48);
            ctx.lineTo(x + w * 0.36, y + h * 0.72);
            ctx.moveTo(x + w * 0.62, y + h * 0.22);
            ctx.lineTo(x + w * 0.55, y + h * 0.48);
            ctx.lineTo(x + w * 0.76, y + h * 0.72);
            ctx.stroke();
          }
          // v59：红砖不再显示数字进度，只用裂纹/变色表现已受击。
        }

        if (block.hiddenEntry || block.hiddenDoor || block.hiddenPickup) {
          ctx.fillStyle = "rgba(255,247,170,.26)";
          ctx.beginPath();
          ctx.arc(x + w / 2, y + h / 2, 8 + Math.sin(performance.now() / 180) * 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  function drawDoor() {
    const door = game.door;
    if (!door?.revealed) return;
    const active = !!door.active;
    const pulse = Math.sin((door.pulse || 0) * 5) * 0.5 + 0.5;
    ctx.save();
    ctx.shadowColor = active ? "rgba(99,255,223,.9)" : "rgba(110,130,145,.35)";
    ctx.shadowBlur = active ? 18 + pulse * 10 : 8;
    const grad = ctx.createLinearGradient(door.x - 22, door.y - 30, door.x + 22, door.y + 30);
    if (active) {
      grad.addColorStop(0, "#8fffe8");
      grad.addColorStop(0.5, "#2dd9ff");
      grad.addColorStop(1, "#11698a");
    } else {
      grad.addColorStop(0, "#7d8a93");
      grad.addColorStop(1, "#303941");
    }
    roundRect(door.x - 24, door.y - 30, 48, 60, 10, grad, active ? "rgba(218,255,249,.9)" : "rgba(180,195,205,.5)", 2);
    ctx.fillStyle = active ? "rgba(255,255,255,.65)" : "rgba(255,255,255,.22)";
    ctx.fillRect(door.x - 12, door.y - 22, 24, 5);
    ctx.fillStyle = active ? "#eaffff" : "#b9c5cc";
    ctx.font = "700 12px Microsoft YaHei UI";
    textCenter(active ? "NEXT" : "LOCK", door.x, door.y + 43);
    ctx.restore();
  }

  function drawGame() {
    const theme = currentTheme(game.room);
    const cam = updateCamera();
    ctx.save();
    ctx.translate(-cam.x, -cam.y);
    drawBombermanMap(theme);
    drawBomberBlocks();
    drawDoor();
    for (const t of game.tokens) drawToken(t);
    for (const item of game.pickups) drawPickup(item);
    for (const pr of game.projectiles) drawProjectile(pr);
    for (const m of game.monsters) drawMonster(m);
    if (game.boss) drawBoss(game.boss);
    drawPlayer();
    drawFloats();
    ctx.restore();
    drawHud();
    if (game.boss && isPortraitMode()) drawBossBar(game.boss);
    if (game.mode === "playing" && game.settings.crosshair && shouldDrawMouseCrosshair()) drawCrosshair();
    drawRestartButton();
    drawBookQuickButton();
    drawSettingsButton();
  }

  function drawRestartButton() {
    return;
  }


  function actionFrameCol(actionName, cfg, p) {
    const cols = Math.max(1, cfg.cols || 1);

    if (actionName === "idle") {
      const frameCols = indexList(cfg.frameCols, [cfg.idleCol ?? 0], cols);
      if (frameCols.length <= 1) return clamp(frameCols[0] ?? 0, 0, cols - 1);
      const fps = Math.max(1, numberOr(cfg.idleFps, 4));
      const index = Math.floor(performance.now() / 1000 * fps) % frameCols.length;
      return clamp(frameCols[index] ?? 0, 0, cols - 1);
    }

    if (actionName === "walk") {
      const walkCols = indexList(cfg.walkCols, [0], cols);
      if (!p.walk) return clamp(cfg.idleCol ?? walkCols[0] ?? 0, 0, cols - 1);
      const fps = Math.max(1, numberOr(cfg.walkFps, 7));
      return clamp(walkCols[Math.floor(p.walk * fps) % walkCols.length] ?? 0, 0, cols - 1);
    }

    const frameCols = indexList(cfg.frameCols, [0], cols);
    if (frameCols.length <= 1) return clamp(frameCols[0] ?? 0, 0, cols - 1);

    const timer = actionName === "hurt" ? (p.hurtAnim || 0)
      : actionName === "dash" ? (p.dashAnim || 0)
      : actionName === "attack" ? ((p.attackActionTimer || 0) || (p.fireAnim || 0))
      : (p.fireAnim || 0);

    const duration = cfg.duration || (actionName === "hurt" ? 0.38 : actionName === "dash" ? 0.28 : 0.34);
    const progress = clamp(1 - timer / duration, 0, 0.999);
    return clamp(frameCols[Math.floor(progress * frameCols.length)] ?? 0, 0, cols - 1);
  }

  function heroPreviewFrameIndex(cfg) {
    if (!cfg) return 0;
    const cols = Math.max(1, cfg.cols || 1);
    const rows = Math.max(1, cfg.rows || 1);
    const rowByFacing = cfg.rowByFacing || HERO_ROW_BY_FACING;
    const row = clamp(Number.isFinite(cfg.previewRow) ? cfg.previewRow : (rowByFacing[0] ?? 0), 0, rows - 1);
    const firstCol = Array.isArray(cfg.frameCols) && cfg.frameCols.length ? cfg.frameCols[0]
      : Array.isArray(cfg.walkCols) && cfg.walkCols.length ? cfg.walkCols[0]
      : cfg.idleCol ?? 0;
    const col = clamp(Number.isFinite(cfg.previewCol) ? cfg.previewCol : firstCol, 0, cols - 1);
    return row * cols + col;
  }

  function playerActionFacing(actionName, p) {
    const baseFacing = clamp(p?.facing ?? 0, 0, 3) | 0;
    if (!p) return baseFacing;
    if (actionName === "attack") {
      if ((p.attackActionTimer || 0) > 0 && Number.isFinite(p.attackActionFacing)) {
        return clamp(p.attackActionFacing, 0, 3) | 0;
      }
      if (Number.isFinite(p.attackFacing)) return clamp(p.attackFacing, 0, 3) | 0;
    }
    if (actionName === "dash" && (p.dashAnim || 0) > 0 && Number.isFinite(p.dashFacing)) {
      return clamp(p.dashFacing, 0, 3) | 0;
    }
    return baseFacing;
  }

  function currentHeroAction(hero, p) {
    const actions = hero.actions || null;
    if (!actions) return null;
    const attackActive = ((p.attackActionTimer || 0) > 0 || (p.fireAnim || 0) > 0 || (p.attackLockTimer || 0) > 0) && actions.attack;
    let actionName = "walk";
    // 动作优先级：hurt > dash > attack > walk > idle。
    // 其中 attack 明确高于 walk：边移动边发射时显示攻击动作，不显示移动动作。
    if ((p.hurtAnim || 0) > 0 && actions.hurt) actionName = "hurt";
    else if ((p.dashAnim || 0) > 0 && actions.dash) actionName = "dash";
    else if (attackActive) actionName = "attack";
    else if ((p.walk || 0) <= 0 && actions.idle) actionName = "idle";
    const cfg = actions[actionName] || actions.walk || actions.idle;
    if (!cfg) return null;
    const img = images[cfg.imageKey] || images[hero.imageKey];
    if (!img) return null;
    const cols = Math.max(1, cfg.cols || 1);
    const rows = Math.max(1, cfg.rows || 1);

    // 方向触发规则：所有英雄动作图统一为 [前, 左, 右, 后] = [0,1,2,3]。
    // 不使用镜像，不按单个英雄或单张动作图写特殊逻辑。
    const rowByFacing = cfg.rowByFacing || hero.rowByFacing || HERO_ROW_BY_FACING;
    const facing = playerActionFacing(actionName, p);
    const row = clamp(rowByFacing[facing] ?? facing, 0, rows - 1);

    const flipX = false;

    const col = clamp(actionFrameCol(actionName, cfg, p), 0, cols - 1);
    return {
      img,
      cols,
      rows,
      index: row * cols + col,
      flipX,
      frameHeight: cfg.frameHeight || hero.frameHeight || 96,
      actionName,
      facing,
      row,
      col
    };
  }

  function drawActionAtlasAnchored(img, cols, rows, index, footX, footY, targetHeight, flipX = false) {
    if (!img) return;
    const info = getAtlasFrameMetrics(img, cols, rows, index);
    const bodyHeight = Math.max(1, info.bh || info.ch);
    const scale = (targetHeight || bodyHeight) / bodyHeight;
    const col = index % cols;
    const row = Math.floor(index / cols);
    const dx = footX - info.footX * scale;
    const dy = footY - info.footY * scale;
    if (flipX) {
      ctx.save();
      ctx.translate(dx + info.cw * scale, dy);
      ctx.scale(-1, 1);
      ctx.drawImage(img, col * info.cw, row * info.ch, info.cw, info.ch, 0, 0, info.cw * scale, info.ch * scale);
      ctx.restore();
    } else {
      ctx.drawImage(img, col * info.cw, row * info.ch, info.cw, info.ch, dx, dy, info.cw * scale, info.ch * scale);
    }
  }

  function drawPlayer() {
    const p = game.player;
    const hero = selectedHero();
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,.24)";
    ctx.beginPath();
    ctx.ellipse(p.x, p.y + 23, 30, 11, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const action = currentHeroAction(hero, p);
    if (action) {
      drawActionAtlasAnchored(action.img, action.cols, action.rows, action.index, p.x, p.y + 30, action.frameHeight, action.flipX);
    } else {
      // 兜底：如果图片路径写错或素材未加载成功，用颜色圆点保证游戏仍可运行。
      ctx.fillStyle = hero.tint || "#9fb8ff";
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }

    if (p.held) drawHeldTranslationOverhead(p.x, p.y - 126, p.held);
    drawHeadHpBar(p.x, p.y - 88, 72, p.hp / p.maxHp, "#70df86", `HP ${Math.max(0, Math.floor(p.hp))}/${p.maxHp}`);
    if (p.shield > 0) { ctx.strokeStyle = "rgba(145,217,255,.82)"; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(p.x, p.y - 8, 34 + Math.sin(performance.now() / 120) * 2, 0, Math.PI * 2); ctx.stroke(); }
    if (p.invincibleBuff > 0) { ctx.strokeStyle = "rgba(255,230,120,.92)"; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(p.x, p.y - 8, 39 + Math.sin(performance.now() / 140) * 2, 0, Math.PI * 2); ctx.stroke(); }
  }

  function drawMonster(m) {
    const facing = clamp(m.facing ?? 0, 0, 3) | 0;
    const spriteType = m.spriteConfig || getMonsterTypeById(m.typeId);
    const action = m.action || resolveEntityAction(m);
    const spriteDef = directionalSprite(spriteType, action, facing);
    const spriteImg = spriteDef ? images[spriteDef.key] : null;
    const render = spriteType?.render || { w: 94, h: 94, shadowW: 28, shadowH: 10 };
    const pose = animatedEntityPose(m, render.w, render.h, 0.82);

    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,.22)";
    ctx.beginPath();
    ctx.ellipse(m.x, m.y + 20, (render.shadowW || 28) * pose.shadowScale, (render.shadowH || 10) * pose.shadowScale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (spriteImg) {
      drawAnimatedDirectionalSprite(spriteImg, spriteDef, action, m, pose.x, pose.y - 12, render.w, render.h, pose);
    } else {
      // 配置或素材路径有问题时，用明显兜底圆形提示，方便排查。
      ctx.fillStyle = m.hitFlash > 0 ? "#ffef94" : "#d96d6d";
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = "10px Segoe UI";
      ctx.fillStyle = "#fff";
      ctx.fillText("type?", m.x - 14, m.y + 4);
    }

    if (m.wrongSpeedTimer > 0) {
      ctx.strokeStyle = `rgba(255,88,104,${0.45 + Math.sin(performance.now() / 90) * 0.18})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(m.x, m.y - 8, 31, 0, Math.PI * 2);
      ctx.stroke();
    }
    // v84：monster 头顶不再显示等级和怪物名称，只保留单词提示。

    const showWord = game.hideWordsTimer > 0 ? "???" : m.entry.word; ctx.font = "700 16px Segoe UI"; const w = ctx.measureText(showWord).width;
    ctx.fillStyle = "rgba(16,20,26,.82)"; roundRectRaw(m.x - w / 2 - 8, m.y - 62, w + 16, 25, 7); ctx.fill(); ctx.fillStyle = "#fff096"; ctx.fillText(showWord, m.x - w / 2, m.y - 44);
    if (game.showMeaningTimer > 0 && game.hideWordsTimer <= 0) { const meaning = m.entry.meaning || ""; ctx.font = "13px Microsoft YaHei UI"; const mw = ctx.measureText(meaning).width; ctx.fillStyle = "rgba(12,18,22,.78)"; roundRectRaw(m.x - mw / 2 - 8, m.y - 114, mw + 16, 20, 6); ctx.fill(); ctx.fillStyle = "#c8f6ff"; ctx.fillText(meaning, m.x - mw / 2, m.y - 99); }
  }


  function drawBoss(b) {
    const facing = clamp(b.facing ?? 0, 0, 3) | 0;
    const spriteType = b.spriteConfig || getBossTypeById(b.typeId);
    const action = b.action || resolveEntityAction(b);
    const spriteDef = directionalSprite(spriteType, action, facing);
    const spriteImg = spriteDef ? images[spriteDef.key] : null;
    const render = spriteType?.render || { w: 206, h: 206, shadowW: 78, shadowH: 21 };
    const pose = animatedEntityPose(b, render.w, render.h, 0.58);

    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,.26)";
    ctx.beginPath();
    ctx.ellipse(b.x, b.y + 64, (render.shadowW || 78) * pose.shadowScale, (render.shadowH || 21) * pose.shadowScale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (spriteImg) {
      drawAnimatedDirectionalSprite(spriteImg, spriteDef, action, b, pose.x, pose.y - 12, render.w, render.h, pose);
      if (b.hitFlash > 0) { ctx.fillStyle = `rgba(255,255,255,${0.25 + b.hitFlash})`; ctx.beginPath(); ctx.arc(b.x, b.y, 88, 0, Math.PI * 2); ctx.fill(); }
      if (b.skillFlash > 0) { ctx.strokeStyle = `rgba(255,232,168,${0.4 + b.skillFlash})`; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(b.x, b.y, 98 + Math.sin(performance.now() / 130) * 2, 0, Math.PI * 2); ctx.stroke(); }
    } else {
      ctx.fillStyle = b.info.color || "#c48dff";
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = "14px Segoe UI";
      ctx.fillStyle = "#fff";
      ctx.fillText("boss type?", b.x - 36, b.y + 4);
    }

    const showWord = game.hideWordsTimer > 0 ? "???" : b.entry.word; ctx.font = "700 21px Segoe UI"; const w = Math.max(120, ctx.measureText(showWord).width + 20);
    drawHeadHpBar(b.x, b.y - 176, 118, b.hp / b.maxHp, b.info.color, `${Math.max(0, Math.floor(b.hp))}/${b.maxHp}`);
    roundRect(b.x - w / 2, b.y - 118, w, 30, 8, "rgba(18,22,30,.88)", b.info.color, 2); ctx.fillStyle = "#fff4b5"; textCenter(showWord, b.x, b.y - 96);
    if (game.showMeaningTimer > 0 && game.hideWordsTimer <= 0) { ctx.font = "14px Microsoft YaHei UI"; const meaning = b.entry.meaning || ""; const mw = Math.max(130, ctx.measureText(meaning).width + 20); roundRect(b.x - mw / 2, b.y - 148, mw, 24, 8, "rgba(18,22,30,.74)", "rgba(255,255,255,.12)", 1); ctx.fillStyle = "#d3f6ff"; textCenter(meaning, b.x, b.y - 131); }
  }


  function drawToken(t) {
    const label = game.hideWordsTimer > 0 ? "???" : t.entry.meaning;
    ctx.font = "700 17px Microsoft YaHei UI";
    const w = Math.max(64, ctx.measureText(label).width + 28);
    const pulse = t.glow > 0 ? 0.5 + Math.sin(performance.now() / 140) * 0.5 : 0;
    const fill = ctx.createLinearGradient(t.x - w / 2, t.y - 18, t.x + w / 2, t.y + 18);
    fill.addColorStop(0, t.glow > 0 ? "#e5ffd0" : "#ffe1a0");
    fill.addColorStop(0.46, t.glow > 0 ? "#9deea6" : "#e9ae54");
    fill.addColorStop(1, t.glow > 0 ? "#4fae71" : "#a56432");
    ctx.save();
    ctx.shadowColor = t.glow > 0 ? `rgba(159,255,161,${0.36 + pulse * 0.28})` : "rgba(0,0,0,.26)";
    ctx.shadowBlur = t.glow > 0 ? 16 + pulse * 7 : 8;
    ctx.shadowOffsetY = 4;
    roundRect(t.x - w / 2, t.y - 18, w, 36, 10, fill, t.glow > 0 ? "rgba(229,255,198,.94)" : "rgba(95,59,26,.86)", 2);
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillStyle = "rgba(255,255,255,.28)";
    ctx.fillRect(t.x - w / 2 + 11, t.y - 12, w - 22, 2);
    ctx.fillStyle = "#2b1d0b";
    textCenter(label, t.x, t.y + 6);
    ctx.restore();
  }

  function drawProjectile(p) {
    if (p.melee) { ctx.save(); ctx.globalAlpha = Math.max(0.18, p.life / 0.18); ctx.strokeStyle = p.color || "#fff2a0"; ctx.lineWidth = 14; ctx.beginPath(); ctx.arc(p.x, p.y, p.radius * 0.52, -0.9, 0.9); ctx.stroke(); ctx.restore(); return; }
    const r = p.radius || 8; const color = p.color || "#fff2a0"; const angle = Math.atan2(p.vy || 0, p.vx || 1); ctx.save();
    if (p.enemy) {
      ctx.translate(p.x, p.y); ctx.rotate(angle);
      const style = p.enemyStyle || "enemy";
      ctx.shadowColor = color; ctx.shadowBlur = 12;
      if (style === "crystal") {
        ctx.fillStyle = color; ctx.strokeStyle = "rgba(230,251,255,.9)"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(r * 1.5, 0); ctx.lineTo(0, -r); ctx.lineTo(-r * 1.1, 0); ctx.lineTo(0, r); ctx.closePath(); ctx.fill(); ctx.stroke();
      } else if (style === "fire") {
        const g = ctx.createRadialGradient(0, 0, 1, 0, 0, r * 1.5); g.addColorStop(0, "rgba(255,252,220,.98)"); g.addColorStop(0.45, color); g.addColorStop(1, "rgba(255,120,55,.12)"); ctx.fillStyle = g;
        ctx.beginPath(); ctx.moveTo(r * 1.25, 0); ctx.quadraticCurveTo(0, -r * 1.25, -r * 0.8, 0); ctx.quadraticCurveTo(0, r * 1.25, r * 1.25, 0); ctx.fill();
      } else if (style === "venom") {
        ctx.fillStyle = color; ctx.beginPath(); ctx.arc(0, 0, r * 0.86, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = "rgba(233,215,255,.92)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-r * 0.6, -r * 0.3); ctx.lineTo(r * 0.9, 0); ctx.lineTo(-r * 0.6, r * 0.3); ctx.stroke();
      } else if (style === "prism") {
        ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(r * 1.4, 0); ctx.lineTo(-r * 0.2, -r * 0.95); ctx.lineTo(-r, 0); ctx.lineTo(-r * 0.2, r * 0.95); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,.86)"; ctx.lineWidth = 1.5; ctx.stroke();
      } else if (style === "claw") {
        ctx.strokeStyle = color; ctx.lineWidth = 4.5; ctx.beginPath(); ctx.arc(-r * 0.1, 0, r * 0.9, -0.9, 0.9); ctx.stroke(); ctx.beginPath(); ctx.arc(r * 0.45, 0, r * 0.72, -0.8, 0.8); ctx.stroke();
      } else if (style === "rock") {
        ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(r * 1.2, -r * 0.15); ctx.lineTo(r * 0.4, -r); ctx.lineTo(-r * 0.8, -r * 0.72); ctx.lineTo(-r * 1.05, r * 0.1); ctx.lineTo(-r * 0.35, r); ctx.lineTo(r * 0.85, r * 0.72); ctx.closePath(); ctx.fill(); ctx.strokeStyle = "rgba(34,46,58,.6)"; ctx.lineWidth = 2; ctx.stroke();
      } else {
        ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(r * 1.6, 0); ctx.lineTo(-r * 0.8, -r * 0.7); ctx.lineTo(-r * 1.25, 0); ctx.lineTo(-r * 0.8, r * 0.7); ctx.closePath(); ctx.fill();
      }
      ctx.globalAlpha = 0.22; ctx.fillStyle = color; ctx.fillRect(-r * 2.2, -2, r * 2, 4); ctx.restore(); return;
    }
    if (p.attackType === "slash") {
      ctx.translate(p.x, p.y);
      ctx.rotate(angle);
      ctx.shadowColor = "rgba(196,156,255,.95)";
      ctx.shadowBlur = 16;

      const t = performance.now() / 120;
      const qi = ctx.createLinearGradient(-r * 1.9, -r * 1.35, r * 2.2, r * 1.35);
      qi.addColorStop(0, "rgba(145,103,255,.05)");
      qi.addColorStop(0.35, "rgba(196,156,255,.74)");
      qi.addColorStop(0.65, "rgba(255,255,255,.96)");
      qi.addColorStop(1, "rgba(112,216,255,.16)");

      ctx.strokeStyle = qi;
      ctx.lineWidth = Math.max(6, r * 0.62);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.82, -0.74, 0.74);
      ctx.stroke();

      ctx.strokeStyle = "rgba(246,240,255,.95)";
      ctx.lineWidth = Math.max(2, r * 0.18);
      ctx.beginPath();
      ctx.arc(r * 0.08, 0, r * 1.52, -0.58, 0.58);
      ctx.stroke();

      ctx.fillStyle = "rgba(196,156,255,.22)";
      ctx.beginPath();
      ctx.ellipse(-r * 0.85, 0, r * 1.25, r * 0.34, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = 0.62;
      ctx.strokeStyle = "rgba(159,221,255,.62)";
      ctx.lineWidth = 2;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.arc(-r * (0.55 + i * 0.25), 0, r * (0.55 + i * 0.22), -0.46 + Math.sin(t + i) * 0.05, 0.46);
        ctx.stroke();
      }
      ctx.restore();
      return;
    }
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = "rgba(80,55,8,.8)"; ctx.stroke(); ctx.restore();
  }

  function drawHud() {
    if (!(game.mode === "playing" || game.mode === "paused")) return;

    const remain = Math.max(0, Math.ceil(ROOM_TIME_LIMIT - game.roomTime));
    const mm = String(Math.floor(remain / 60)).padStart(2, "0");
    const ss = String(remain % 60).padStart(2, "0");
    const t = uiPulse(680);

    if (isPortraitMode()) {
      drawFantasyPanel(18, 18, W - 36, 74, {
        accent: '#a78bff', radius: 22,
        fillTop: 'rgba(50,42,104,.42)', fillBottom: 'rgba(10,48,70,.54)',
        stroke: `rgba(188,168,255,${0.18 + t * 0.10})`, shadowBlur: 10, pulse: true, noDeco: true, noInner: true
      });
      ctx.fillStyle = 'rgba(248,252,255,.98)';
      ctx.font = '800 17px Microsoft YaHei UI';
      textCenter(`第 ${game.room} 关   ${mm}:${ss}   怪物 ${remainingEnemyCount()}`, W / 2, 47);
      ctx.fillStyle = 'rgba(220,232,255,.88)';
      ctx.font = '700 14px Microsoft YaHei UI';
      textCenter(`分数 ${game.score}   命中 ${accuracy()}   错误 ${errorRate()}`, W / 2, 74);
      return;
    }

    // 横屏顶部信息栏固定三等分，统一高度 38px。
    const hudX = 16;
    const hudY = 12;
    const hudH = 38;
    const hudGap = 12;
    const hudRightSafe = W - 112; // 右侧预留英雄头像/设置按钮空间。
    const colW = (hudRightSafe - hudX - hudGap * 2) / 3;
    const leftX = hudX;
    const midX = hudX + colW + hudGap;
    const rightX = hudX + (colW + hudGap) * 2;
    const textY = hudY + 25;

    const drawTopPanel = (x, accent) => drawFantasyPanel(x, hudY, colW, hudH, {
      accent,
      radius: 14,
      fillTop: 'rgba(46,40,94,.36)',
      fillBottom: 'rgba(12,46,72,.48)',
      shadowBlur: 6,
      pulse: true,
      noDeco: true,
      noInner: true,
      stroke: 'rgba(202,178,255,.14)'
    });

    const drawCompactTriplet = (x, a, b, c, colors = []) => {
      ctx.font = '800 14px Microsoft YaHei UI';
      ctx.fillStyle = colors[0] || 'rgba(248,252,255,.98)';
      ctx.fillText(a, x + 18, textY);
      ctx.fillStyle = colors[1] || 'rgba(210,224,255,.94)';
      textCenter(b, x + colW / 2, textY);
      ctx.fillStyle = colors[2] || 'rgba(255,230,164,.96)';
      ctx.fillText(c, x + colW - ctx.measureText(c).width - 18, textY);
    };

    drawTopPanel(leftX, '#a78bff');
    drawCompactTriplet(
      leftX,
      `关卡 ${game.room}`,
      `时间 ${mm}:${ss}`,
      `怪物 ${remainingEnemyCount()}`,
      ['rgba(248,252,255,.98)', 'rgba(210,224,255,.94)', 'rgba(255,230,164,.96)']
    );

    // 中间栏只在 Boss 关卡显示 Boss 信息；普通关不绘制中间栏内容。
    if (game.boss) {
      drawTopPanel(midX, game.boss.info?.color || '#ffe083');
      const b = game.boss;
      const name = b.info?.name || b.name || 'Boss';
      const hpText = `血量 ${Math.max(0, Math.ceil(b.hp || 0))}/${Math.max(1, Math.ceil(b.maxHp || 1))}`;
      const word = b.entry?.word || '?';
      ctx.font = '900 14px Microsoft YaHei UI';
      ctx.fillStyle = 'rgba(255,244,214,.98)';
      ctx.fillText(`BOSS：${name}`, midX + 18, textY);
      ctx.fillStyle = 'rgba(220,236,255,.92)';
      textCenter(hpText, midX + colW / 2, textY);
      ctx.fillStyle = 'rgba(248,252,255,.96)';
      const wordText = `词：${word}`;
      ctx.fillText(wordText, midX + colW - ctx.measureText(wordText).width - 18, textY);
    }

    drawTopPanel(rightX, '#74e5ff');
    drawCompactTriplet(
      rightX,
      `得分 ${game.score}`,
      `命中率 ${accuracy()}`,
      `错误率 ${errorRate()}`,
      ['rgba(248,252,255,.98)', 'rgba(150,255,242,.96)', 'rgba(255,186,214,.96)']
    );
  }

  function drawBossBar(b) {
    if (!b || !(game.mode === "playing" || game.mode === "paused") || !isPortraitMode()) return;

    const x = 18;
    const y = 98;
    const w = W - 36;
    const h = 84;
    const accent = b.info?.color || "#ffcf8a";
    const hpRatio = clamp((b.hp || 0) / Math.max(1, b.maxHp || 1), 0, 1);
    const name = b.info?.name || b.name || "Boss";
    const word = b.entry?.word || "?";

    drawFantasyPanel(x, y, w, h, {
      accent,
      radius: 22,
      fillTop: 'rgba(62,32,64,.54)',
      fillMid: 'rgba(48,34,72,.62)',
      fillBottom: 'rgba(22,34,62,.66)',
      stroke: 'rgba(255,224,174,.22)',
      shadowBlur: 12,
      pulse: true,
      noDeco: true,
      noInner: true
    });

    ctx.save();
    ctx.fillStyle = 'rgba(255,244,214,.98)';
    ctx.font = '900 18px Microsoft YaHei UI';
    ctx.fillText(`BOSS：${name}`, x + 22, y + 29);

    ctx.fillStyle = 'rgba(220,236,255,.90)';
    ctx.font = '700 13px Microsoft YaHei UI';
    const hpText = `血量 ${Math.max(0, Math.ceil(b.hp || 0))}/${Math.max(1, Math.ceil(b.maxHp || 1))}`;
    ctx.fillText(hpText, x + w - ctx.measureText(hpText).width - 22, y + 29);

    const barX = x + 22;
    const barY = y + 41;
    const barW = w - 44;
    const barH = 10;
    roundRect(barX, barY, barW, barH, 7, 'rgba(13,18,35,.72)', 'rgba(255,255,255,.10)', 1);
    const hpGrad = ctx.createLinearGradient(barX, barY, barX + barW, barY);
    hpGrad.addColorStop(0, '#ff6f7d');
    hpGrad.addColorStop(0.55, '#ffd36e');
    hpGrad.addColorStop(1, accent);
    roundRect(barX, barY, Math.max(8, barW * hpRatio), barH, 7, hpGrad, 'rgba(255,255,255,.25)', 1);

    ctx.fillStyle = 'rgba(248,252,255,.96)';
    ctx.font = '800 14px Microsoft YaHei UI';
    textCenter(`当前字词：${word}`, x + w / 2, y + 70);
    ctx.restore();
  }


  function difficultyMenuCards() {
    const rows = [
      { name: "简单", sub: "基础练习", d: 2 },
      { name: "普通", sub: "推荐挑战", d: 4 },
      { name: "困难", sub: "高压挑战", d: 6 }
    ];
    const h = LANDSCAPE_CONFIG_UI.difficultyCardH;
    const top = LANDSCAPE_CONFIG_UI.difficultyTopY;
    const gap = LANDSCAPE_CONFIG_UI.difficultyGap;
    return rows.map((it, idx) => ({ ...it, x: 962, y: top + idx * (h + gap), w: 270, h }));
  }


  function landscapeActionButtons() {
    return {
      back: { x: 22, y: 22, w: 118, h: 46 },
      start: { x: 964, y: LANDSCAPE_CONFIG_UI.startButtonY, w: 270, h: LANDSCAPE_CONFIG_UI.startButtonH },
      continue: { x: 964, y: LANDSCAPE_CONFIG_UI.continueButtonY, w: 270, h: LANDSCAPE_CONFIG_UI.continueButtonH }
    };
  }


  function drawHomeMenu() {
    ctx.fillStyle = '#f3fbff';
    ctx.shadowColor = 'rgba(74,212,191,.42)';
    ctx.shadowBlur = 18;
    ctx.font = isPortraitMode() ? '900 62px Microsoft YaHei UI' : '900 72px Microsoft YaHei UI';
    center('头号玩家', isPortraitMode() ? 250 : 220);
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(210,232,255,.92)';
    ctx.font = isPortraitMode() ? '20px Microsoft YaHei UI' : '22px Microsoft YaHei UI';
    center('英语 / 数学闯关学习游戏', isPortraitMode() ? 304 : 284);
    ctx.fillStyle = 'rgba(160,190,220,.88)';
    ctx.font = isPortraitMode() ? '15px Microsoft YaHei UI' : '16px Microsoft YaHei UI';
    center('竖屏双手手机模式 · 横屏平板 / PC', isPortraitMode() ? 336 : 316);

    for (const card of homeModeCards()) {
      const selected = game.screenMode === card.mode;
      drawFantasyPanel(card.x, card.y, card.w, card.h, {
        accent: selected ? '#76fff0' : '#8da8ff',
        fillTop: selected ? 'rgba(36,116,110,.62)' : 'rgba(22,36,58,.38)',
        fillBottom: selected ? 'rgba(16,82,90,.72)' : 'rgba(12,24,42,.48)',
        stroke: selected ? 'rgba(126,255,244,.42)' : 'rgba(150,190,240,.16)',
        shadowBlur: selected ? 12 : 6,
        radius: 26,
        noDeco: true,
        noInner: true
      });
      ctx.fillStyle = '#ffffff';
      ctx.font = '900 30px Microsoft YaHei UI';
      textCenter(card.label, card.x + card.w / 2, card.y + 48);
      ctx.fillStyle = selected ? '#d9fffb' : 'rgba(210,228,246,.76)';
      ctx.font = '15px Microsoft YaHei UI';
      textCenter(card.sub, card.x + card.w / 2, card.y + 76);
    }

    const btn = startButtonRect();
    drawFantasyButton(btn.x, btn.y, btn.w, btn.h, '开始游戏', { primary: true });
  }


  function drawTechNeonPanel(x, y, w, h, opts = {}) {
    const accent = opts.accent || '#23d9ff';
    drawFantasyPanel(x, y, w, h, {
      accent,
      fillTop: opts.fillTop || 'rgba(10,38,72,.62)',
      fillMid: opts.fillMid || 'rgba(4,20,44,.78)',
      fillBottom: opts.fillBottom || 'rgba(2,12,30,.92)',
      stroke: opts.stroke || 'rgba(70,198,255,.46)',
      shadow: opts.shadow || 'rgba(32,190,255,.24)',
      shadowBlur: opts.shadowBlur ?? 14,
      radius: opts.radius || 16,
      line: opts.line || 1.5,
      noDeco: true,
      noInner: true
    });
    ctx.save();
    ctx.strokeStyle = opts.cornerColor || 'rgba(74,214,255,.58)';
    ctx.lineWidth = 2;
    const s = opts.cornerSize || 18;
    const pad = 10;
    const corners = [
      [x + pad, y + pad, 1, 1],
      [x + w - pad, y + pad, -1, 1],
      [x + pad, y + h - pad, 1, -1],
      [x + w - pad, y + h - pad, -1, -1]
    ];
    for (const [cx, cy, sx, sy] of corners) {
      ctx.beginPath();
      ctx.moveTo(cx, cy + sy * s * .58);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + sx * s * .58, cy);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawConfigTopChrome(title = '配置中心') {
    ctx.save();
    ctx.fillStyle = '#f8fdff';
    ctx.shadowColor = 'rgba(74,214,255,.55)';
    ctx.shadowBlur = 16;
    ctx.font = isPortraitMode() ? '900 42px Microsoft YaHei UI' : '900 38px Microsoft YaHei UI';
    textCenter(title, W / 2, isPortraitMode() ? 78 : 52);
    ctx.shadowBlur = 0;
    const y = isPortraitMode() ? 104 : 74;
    const grad = ctx.createLinearGradient(W * .18, y, W * .82, y);
    grad.addColorStop(0, 'rgba(56,190,255,0)');
    grad.addColorStop(.5, 'rgba(76,218,255,.86)');
    grad.addColorStop(1, 'rgba(56,190,255,0)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(W * .18, y); ctx.lineTo(W * .82, y); ctx.stroke();
    ctx.fillStyle = 'rgba(92,226,255,.96)';
    ctx.beginPath();
    ctx.moveTo(W / 2, y + 10); ctx.lineTo(W / 2 + 9, y); ctx.lineTo(W / 2, y - 10); ctx.lineTo(W / 2 - 9, y); ctx.closePath(); ctx.fill();
    ctx.restore();
    const b = isPortraitMode() ? portraitActionButtons().back : landscapeActionButtons().back;
    drawTechNavButton(b.x, b.y, b.w, b.h, isPortraitMode() ? '‹' : '‹  返回');
    const gear = isPortraitMode()
      ? { x: W - 142, y: 30, w: 112, h: 56, label: '⚙' }
      : { x: W - 140, y: 22, w: 118, h: 46, label: '⚙  设置' };
    drawTechNavButton(gear.x, gear.y, gear.w, gear.h, gear.label);
  }

  function drawTechNavButton(x, y, w, h, label) {
    const fill = ctx.createLinearGradient(x, y, x + w, y + h);
    fill.addColorStop(0, 'rgba(18,78,126,.78)');
    fill.addColorStop(1, 'rgba(5,25,54,.86)');
    ctx.save();
    ctx.shadowColor = 'rgba(44,208,255,.28)';
    ctx.shadowBlur = 12;
    roundRect(x, y, w, h, 14, fill, 'rgba(94,218,255,.68)', 1.4);
    ctx.restore();
    ctx.fillStyle = '#f4fbff';
    ctx.font = isPortraitMode() ? '900 34px Microsoft YaHei UI' : '900 18px Microsoft YaHei UI';
    textCenter(label, x + w / 2, y + h / 2 + (isPortraitMode() ? 12 : 7));
  }

  function drawStepHeader(num, title, sub, x, y) {
    const badgeW = isPortraitMode() ? 46 : 42;
    const badgeH = isPortraitMode() ? 46 : 36;
    drawFantasyPanel(x, y, badgeW, badgeH, {
      accent: '#4bd7ff',
      fillTop: 'rgba(22,114,162,.80)',
      fillBottom: 'rgba(5,34,76,.92)',
      stroke: 'rgba(108,234,255,.78)',
      shadow: 'rgba(50,210,255,.25)',
      shadowBlur: 12,
      radius: 10,
      noDeco: true,
      noInner: true
    });
    ctx.fillStyle = '#bff8ff';
    ctx.font = isPortraitMode() ? '900 25px Microsoft YaHei UI' : '900 22px Microsoft YaHei UI';
    textCenter(num, x + badgeW / 2, y + (isPortraitMode() ? 31 : 27));
    ctx.fillStyle = '#ffffff';
    ctx.font = isPortraitMode() ? '900 27px Microsoft YaHei UI' : '900 23px Microsoft YaHei UI';
    ctx.fillText(title, x + badgeW + 16, y + (isPortraitMode() ? 28 : 24));
    ctx.fillStyle = 'rgba(198,224,245,.76)';
    ctx.font = isPortraitMode() ? '700 15px Microsoft YaHei UI' : '700 14px Microsoft YaHei UI';
    ctx.fillText(sub || '', x + badgeW + 16, y + (isPortraitMode() ? 52 : 46));
  }

  function drawConfigSection(x, y, w, h, num, title, sub) {
    drawTechNeonPanel(x, y, w, h, { radius: isPortraitMode() ? 18 : 16 });
    drawStepHeader(num, title, sub, x + 18, y + 22);
  }

  function drawTechChoiceCard(card, selected, opts = {}) {
    const accent = selected ? (card.accent || '#55e8ff') : 'rgba(124,162,210,.55)';
    drawFantasyPanel(card.x, card.y, card.w, card.h, {
      accent,
      fillTop: selected ? 'rgba(20,126,188,.86)' : 'rgba(18,40,72,.68)',
      fillBottom: selected ? 'rgba(8,74,126,.94)' : 'rgba(8,22,48,.88)',
      stroke: selected ? 'rgba(108,232,255,.86)' : 'rgba(108,148,190,.30)',
      shadow: selected ? 'rgba(42,206,255,.28)' : 'rgba(0,0,0,.12)',
      shadowBlur: selected ? 16 : 6,
      radius: opts.radius || 14,
      noDeco: true,
      noInner: true
    });
    if (opts.icon) {
      const iconSize = Math.min(card.h - 22, 58);
      drawFantasyPanel(card.x + 18, card.y + (card.h - iconSize) / 2, iconSize, iconSize, {
        accent,
        fillTop: selected ? 'rgba(76,190,255,.30)' : 'rgba(94,126,170,.18)',
        fillBottom: selected ? 'rgba(18,80,140,.36)' : 'rgba(32,54,88,.28)',
        stroke: selected ? 'rgba(130,238,255,.55)' : 'rgba(120,160,210,.24)',
        radius: 12,
        shadowBlur: 6,
        noDeco: true,
        noInner: true
      });
      ctx.fillStyle = selected ? '#bdfaff' : 'rgba(198,216,240,.55)';
      ctx.font = `900 ${opts.iconFont || 28}px Microsoft YaHei UI`;
      textCenter(card.icon || opts.icon, card.x + 18 + iconSize / 2, card.y + card.h / 2 + 10);
    }
    ctx.fillStyle = '#ffffff';
    ctx.font = opts.titleFont || (isPortraitMode() ? '900 24px Microsoft YaHei UI' : '900 22px Microsoft YaHei UI');
    ctx.fillText(card.label || card.name, card.x + (opts.icon ? 92 : 24), card.y + (isPortraitMode() ? 34 : 36));
    if (card.sub) {
      ctx.fillStyle = 'rgba(207,228,248,.78)';
      ctx.font = opts.subFont || '700 14px Microsoft YaHei UI';
      ctx.fillText(card.sub, card.x + (opts.icon ? 92 : 24), card.y + (isPortraitMode() ? 57 : 60));
    }
  }

  function drawTechStartRibbon(x, y, w, h, label) {
    const t = uiPulse(520, uiPhase(x, y));
    const fill = ctx.createLinearGradient(x, y, x + w, y);
    fill.addColorStop(0, 'rgba(0,168,255,.74)');
    fill.addColorStop(.5, `rgba(22,218,255,${0.86 + t * .10})`);
    fill.addColorStop(1, 'rgba(0,132,255,.82)');
    ctx.save();
    ctx.shadowColor = `rgba(40,216,255,${0.28 + t * .18})`;
    ctx.shadowBlur = 18 + t * 12;
    roundRect(x, y, w, h, 16, fill, 'rgba(175,247,255,.90)', 2);
    ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,.10)';
    ctx.beginPath(); ctx.moveTo(x + 22, y + 10); ctx.lineTo(x + 72, y + h / 2); ctx.lineTo(x + 22, y + h - 10); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x + w - 22, y + 10); ctx.lineTo(x + w - 72, y + h / 2); ctx.lineTo(x + w - 22, y + h - 10); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = isPortraitMode() ? '900 32px Microsoft YaHei UI' : '900 30px Microsoft YaHei UI';
    textCenter(label, x + w / 2, y + h / 2 + 11);
  }

  function drawHeroHallBackdrop(x, y, w, h) {
    const cx = x + w / 2, cy = y + h * .50;
    const glow = ctx.createRadialGradient(cx, cy, 18, cx, cy, Math.min(w, h) * .56);
    glow.addColorStop(0, 'rgba(64,212,255,.22)');
    glow.addColorStop(.54, 'rgba(40,110,220,.10)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(cx, cy, Math.min(w, h) * .54, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(73,205,255,.16)';
    ctx.lineWidth = 1;
    for (let r = 62; r < Math.min(w, h) * .48; r += 32) {
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    }
    const base = ctx.createRadialGradient(cx, y + h - 90, 10, cx, y + h - 90, w * .36);
    base.addColorStop(0, 'rgba(76,226,255,.30)');
    base.addColorStop(1, 'rgba(76,226,255,0)');
    ctx.fillStyle = base;
    ctx.beginPath(); ctx.ellipse(cx, y + h - 90, w * .32, 28, 0, 0, Math.PI * 2); ctx.fill();
  }

  function levelDisplayLabel(level) {
    const n = Math.max(1, Math.floor(Number(level) || 1));
    const stage = ((n - 1) % Math.max(1, BOSS_ROOM_INTERVAL)) + 1;
    const chapter = Math.floor((n - 1) / Math.max(1, BOSS_ROOM_INTERVAL)) + 1;
    return `${chapter}-${stage}`;
  }

  function drawPortraitSetup() {
    const saved = loadSave();
    const btns = portraitActionButtons();
    const animT = performance.now();

    drawConfigTopChrome('配置中心');

    drawConfigSection(24, 124, W - 48, 336, '01', '选择英雄', '滑动切换英雄');
    drawHeroHallBackdrop(24, 124, W - 48, 336);
    drawHeroCarouselItems(animT);

    drawConfigSection(24, 472, W - 48, 250, '02', '游戏模式', '数字 · 算式 · 答案');
    for (const card of portraitContentCards()) {
      drawTechChoiceCard(card, game.contentMode === card.mode, { icon: card.icon, iconFont: 27, titleFont: '900 24px Microsoft YaHei UI' });
    }
    for (const card of portraitQuizCards()) {
      const selected = normalizeQuizMode(game.quizMode) === card.mode;
      drawFantasyPanel(card.x, card.y, card.w, card.h, {
        accent: selected ? card.accent : '#6780aa',
        fillTop: selected ? 'rgba(28,156,190,.72)' : 'rgba(16,34,66,.56)',
        fillBottom: selected ? 'rgba(8,90,134,.82)' : 'rgba(7,18,42,.72)',
        stroke: selected ? 'rgba(112,246,255,.78)' : 'rgba(112,150,196,.25)',
        shadow: selected ? 'rgba(44,214,255,.22)' : 'rgba(0,0,0,.10)',
        shadowBlur: selected ? 12 : 4,
        radius: 14,
        noDeco: true,
        noInner: true
      });
      ctx.fillStyle = selected ? '#ffffff' : 'rgba(222,235,250,.82)';
      ctx.font = '800 18px Microsoft YaHei UI';
      textCenter(card.label, card.x + card.w / 2, card.y + 33);
    }

    drawConfigSection(24, 734, W - 48, 180, '03', '挑战难度', '选择适合你的挑战');
    for (const card of portraitDifficultyCards()) {
      drawTechChoiceCard(card, game.difficulty === card.d, { titleFont: '900 23px Microsoft YaHei UI', subFont: '700 14px Microsoft YaHei UI' });
    }

    drawConfigSection(24, 926, W - 48, 224, '04', '关卡选择', `当前 ${levelDisplayLabel(syncSelectedStartRoom())} · 已激活至 ${levelDisplayLabel(unlockedStartRoom())}`);
    drawLevelCorridor();

    drawTechStartRibbon(btns.start.x, btns.start.y, btns.start.w, btns.start.h, '开始游戏');
    if (saved) drawFantasyButton(btns.continue.x, btns.continue.y, btns.continue.w, btns.continue.h, '继续存档');
  }

  function drawMenu() {
    if (isPortraitMode()) {
      drawFantasyBackdrop(1);
      const vignette = ctx.createRadialGradient(W / 2, H * 0.46, 120, W / 2, H * 0.46, H * 0.72);
      vignette.addColorStop(0, 'rgba(42,38,92,.06)');
      vignette.addColorStop(0.65, 'rgba(4,8,18,.18)');
      vignette.addColorStop(1, 'rgba(2,5,12,.42)');
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, W, H);
      if (game.menuScreen === "home") return drawHomeMenu();
      return drawPortraitSetup();
    }

    drawFantasyBackdrop(1);

    if (game.menuScreen === "home") {
      const btn = startButtonRect();
      ctx.fillStyle = '#f3fbff';
      ctx.font = '900 88px Microsoft YaHei UI';
      center('头号玩家', 224);
      ctx.fillStyle = 'rgba(210,232,255,.92)';
      ctx.font = '24px Microsoft YaHei UI';
      center('英语 / 数学闯关学习游戏', 272);
      ctx.fillStyle = 'rgba(160,190,220,.88)';
      ctx.font = '16px Microsoft YaHei UI';
      center('学习闯关 · 角色战斗 · 探索成长', 306);
      for (const card of homeModeCards()) {
        const selected = game.screenMode === card.mode;
        drawFantasyPanel(card.x, card.y, card.w, card.h, {
          accent: selected ? '#76fff0' : '#8da8ff',
          fillTop: selected ? 'rgba(36,116,110,.62)' : 'rgba(22,36,58,.38)',
          fillBottom: selected ? 'rgba(16,82,90,.72)' : 'rgba(12,24,42,.48)',
          stroke: selected ? 'rgba(126,255,244,.42)' : 'rgba(150,190,240,.16)',
          shadowBlur: selected ? 12 : 6,
          radius: 24,
          noDeco: true,
          noInner: true
        });
        ctx.fillStyle = '#ffffff';
        ctx.font = '800 30px Microsoft YaHei UI';
        textCenter(card.label, card.x + card.w / 2, card.y + 48);
        ctx.fillStyle = selected ? '#d9fffb' : 'rgba(210,228,246,.76)';
        ctx.font = '15px Microsoft YaHei UI';
        textCenter(card.sub, card.x + card.w / 2, card.y + 76);
      }
      drawFantasyButton(btn.x, btn.y, btn.w, btn.h, '开始游戏', { primary: true });
      ctx.fillStyle = 'rgba(164,188,210,.78)';
      ctx.font = '14px Microsoft YaHei UI';
      center('Enter 开始', 590);
      return;
    }

    const actionBtns = landscapeActionButtons();
    const saved = loadSave();
    const animT = performance.now();

    drawConfigTopChrome('配置中心');

    drawConfigSection(26, 94, 300, 380, '01', '玩法', '选择学习内容与挑战方式');
    for (const card of landscapeContentCards()) {
      drawTechChoiceCard(card, game.contentMode === card.mode, { icon: card.icon, iconFont: 24, titleFont: '900 22px Microsoft YaHei UI' });
    }
    for (const card of landscapeQuizCards()) {
      const selected = normalizeQuizMode(game.quizMode) === card.mode;
      drawFantasyPanel(card.x, card.y, card.w, card.h, {
        accent: selected ? card.accent : '#617a9f',
        fillTop: selected ? 'rgba(26,156,204,.70)' : 'rgba(18,36,66,.56)',
        fillBottom: selected ? 'rgba(10,86,134,.82)' : 'rgba(8,20,42,.76)',
        stroke: selected ? 'rgba(110,238,255,.74)' : 'rgba(120,158,202,.22)',
        shadow: selected ? 'rgba(44,214,255,.20)' : 'rgba(0,0,0,.10)',
        shadowBlur: selected ? 12 : 4,
        radius: 12,
        noDeco: true,
        noInner: true
      });
      ctx.fillStyle = selected ? '#ffffff' : 'rgba(222,235,250,.82)';
      ctx.font = '800 18px Microsoft YaHei UI';
      textCenter(card.label, card.x + card.w / 2, card.y + 29);
      ctx.fillStyle = selected ? 'rgba(124,255,244,.20)' : 'rgba(255,255,255,.05)';
      ctx.beginPath(); ctx.arc(card.x + card.w - 28, card.y + card.h / 2, 12, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = selected ? '#aafff6' : 'rgba(170,192,220,.55)';
      ctx.font = '900 17px Microsoft YaHei UI';
      textCenter('›', card.x + card.w - 28, card.y + card.h / 2 + 6);
    }

    drawConfigSection(340, 94, 590, 380, '02', '英雄大厅', '滑动切换英雄');
    drawHeroHallBackdrop(340, 94, 590, 380);
    drawHeroCarouselItems(animT);

    drawConfigSection(944, 94, 312, 380, '03', '难度', '选择挑战难度');
    for (const card of difficultyMenuCards()) {
      drawTechChoiceCard(card, game.difficulty === card.d, { titleFont: '900 24px Microsoft YaHei UI', subFont: '700 14px Microsoft YaHei UI' });
    }

    drawConfigSection(26, 492, 904, 200, '04', '关卡走廊', `当前 ${levelDisplayLabel(syncSelectedStartRoom())} · 已通关至 ${levelDisplayLabel(Math.max(1, unlockedStartRoom() - 1))}`);
    drawLevelCorridor();

    drawConfigSection(944, 492, 312, 200, '05', '开始行动', '确认当前配置后进入挑战');
    drawTechStartRibbon(actionBtns.start.x, actionBtns.start.y, actionBtns.start.w, actionBtns.start.h, '开始游戏');
    drawFantasyButton(actionBtns.continue.x, actionBtns.continue.y, actionBtns.continue.w, actionBtns.continue.h, '继续存档', { disabled: !saved });

    ctx.fillStyle = 'rgba(140,182,214,.86)';
    ctx.font = '600 12px Microsoft YaHei UI';
    ctx.fillText('版本：v171 Boss顶部出生', 26, H - 16);
  }

  function drawPanel(title, body) {
    ctx.fillStyle = 'rgba(2,5,14,.68)';
    ctx.fillRect(0, 0, W, H);
    const x = W / 2 - 300;
    const y = H / 2 - 136;
    const t = uiPulse(620);
    drawFantasyPanel(x, y, 600, 272, {
      accent: '#a78bff', radius: 26,
      fillTop: 'rgba(52,42,112,.72)', fillBottom: 'rgba(12,56,82,.82)',
      stroke: `rgba(204,176,255,${0.28 + t * 0.16})`,
      shadow: 'rgba(138,104,255,.24)', shadowBlur: 18, pulse: true,
      noDeco: true, noInner: true
    });
    ctx.fillStyle = '#f7fbff';
    ctx.font = '900 40px Microsoft YaHei UI';
    textCenter(title, W / 2, H / 2 - 34);
    ctx.font = '700 18px Microsoft YaHei UI';
    ctx.fillStyle = 'rgba(220,234,255,.90)';
    textCenter(body, W / 2, H / 2 + 34);
  }

  function gameOverButtons() {
    if (isPortraitMode()) {
      return {
        restart: { x: W / 2 - 162, y: H / 2 + 248, w: 324, h: 54 },
        menu: { x: W / 2 - 162, y: H / 2 + 314, w: 324, h: 54 }
      };
    }
    return {
      restart: { x: W / 2 - 290, y: H / 2 + 205, w: 250, h: 56 },
      menu: { x: W / 2 + 40, y: H / 2 + 205, w: 250, h: 56 }
    };
  }

  function drawGameOver() {
    ctx.save();
    ctx.fillStyle = 'rgba(1,4,12,.88)';
    ctx.fillRect(0, 0, W, H);

    const portrait = isPortraitMode();
    const panelW = portrait ? W - 54 : 860;
    const panelH = portrait ? 760 : 620;
    const panelX = W / 2 - panelW / 2;
    const panelY = H / 2 - panelH / 2;
    const t = uiPulse(620);
    drawFantasyPanel(panelX, panelY, panelW, panelH, {
      accent: '#d783ff', radius: 28,
      fillTop: 'rgba(82,42,112,.76)', fillBottom: 'rgba(10,54,78,.88)',
      stroke: `rgba(255,196,238,${0.32 + t * 0.18})`,
      shadow: 'rgba(220,104,255,.22)', shadowBlur: 20, pulse: true,
      noDeco: true, noInner: true
    });

    ctx.fillStyle = '#fff4ff';
    ctx.font = portrait ? '900 42px Microsoft YaHei UI' : '900 46px Microsoft YaHei UI';
    textCenter('游戏结束', W / 2, panelY + 68);

    ctx.font = portrait ? '700 18px Microsoft YaHei UI' : '700 20px Microsoft YaHei UI';
    ctx.fillStyle = '#ffd6f0';
    const reason = game.message || '角色已死亡';
    textCenter(reason, W / 2, panelY + 108);

    const accuracy = game.correct + game.wrong > 0 ? Math.round(game.correct / Math.max(1, game.correct + game.wrong) * 100) : 0;
    const stats = [`到达关卡：${game.room}`, `得分：${game.score}`, `正确：${game.correct}`, `错误：${game.wrong}`, `命中率：${accuracy}%`];
    const statsArea = portrait ? { x: panelX + 36, y: panelY + 134, w: panelW - 72, h: 116 } : { x: panelX + 48, y: panelY + 136, w: panelW - 96, h: 70 };
    drawFantasyPanel(statsArea.x, statsArea.y, statsArea.w, statsArea.h, {
      accent: '#92e8ff', radius: 20, fillTop: 'rgba(22,38,70,.42)', fillBottom: 'rgba(8,22,44,.54)',
      stroke: 'rgba(120,214,255,.22)', noDeco: true, noInner: true
    });
    ctx.font = portrait ? '700 18px Microsoft YaHei UI' : '700 18px Microsoft YaHei UI';
    stats.forEach((line, i) => {
      const col = portrait ? 1 : 3;
      const row = portrait ? i : Math.floor(i / 3);
      const colIndex = portrait ? 0 : i % 3;
      const cellW = statsArea.w / col;
      const x = statsArea.x + cellW * colIndex + cellW / 2;
      const y = statsArea.y + (portrait ? 30 + i * 20 : 28 + row * 28);
      ctx.fillStyle = i % 2 ? '#c8f5ff' : '#fff0b8';
      textCenter(line, x, y);
    });

    const reviewRows = gameOverReviewRows(portrait ? 4 : 5);
    const reviewY = portrait ? panelY + 268 : panelY + 248;
    const reviewH = portrait ? 244 : 214;
    const reviewX = panelX + (portrait ? 22 : 34);
    const reviewW = panelW - (portrait ? 44 : 68);

    // v156：取消表格行，改成卡片式词汇回顾。
    // 旧版表格表头、横线、隔行底色全部删除，避免看起来像低配表格。
    ctx.save();
    const panelGrad = ctx.createLinearGradient(reviewX, reviewY, reviewX, reviewY + reviewH);
    panelGrad.addColorStop(0, 'rgba(13,28,58,.96)');
    panelGrad.addColorStop(1, 'rgba(4,14,32,.98)');
    ctx.shadowColor = 'rgba(72,220,255,.22)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 3;
    roundRect(reviewX, reviewY, reviewW, reviewH, 22, panelGrad, 'rgba(120,232,255,.52)', 1.6);
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    ctx.fillStyle = '#f5fbff';
    ctx.font = portrait ? '900 26px Microsoft YaHei UI' : '900 28px Microsoft YaHei UI';
    textCenter(`本局词汇回顾 ${reviewRows.length}词`, reviewX + reviewW / 2, reviewY + 34);

    if (!reviewRows.length) {
      ctx.fillStyle = 'rgba(218,236,255,.88)';
      ctx.font = portrait ? '700 18px Microsoft YaHei UI' : '700 19px Microsoft YaHei UI';
      textCenter('本局暂无可回顾的词汇记录', reviewX + reviewW / 2, reviewY + reviewH / 2 + 16);
    } else {
      const cardGap = portrait ? 10 : 8;
      const cardH = portrait ? 38 : 28;
      const cardX = reviewX + 18;
      const cardW = reviewW - 36;
      const cardStartY = reviewY + (portrait ? 58 : 56);
      reviewRows.forEach((row, idx) => {
        const y = cardStartY + idx * (cardH + cardGap);
        const cardGrad = ctx.createLinearGradient(cardX, y, cardX + cardW, y + cardH);
        cardGrad.addColorStop(0, idx % 2 ? 'rgba(18,64,94,.90)' : 'rgba(22,84,112,.94)');
        cardGrad.addColorStop(1, 'rgba(7,26,54,.92)');
        roundRect(cardX, y, cardW, cardH, 12, cardGrad, 'rgba(114,220,255,.28)', 1);

        const word = String(row.word || '').slice(0, portrait ? 10 : 16);
        const meaning = String(row.meaning || '').slice(0, portrait ? 7 : 12);
        const statText = `正${row.correct}  错${row.wrong}  死${row.death}  复${row.appear}`;

        ctx.fillStyle = '#ffffff';
        ctx.font = portrait ? '900 17px Microsoft YaHei UI' : '900 18px Microsoft YaHei UI';
        ctx.fillText(word, cardX + 18, y + cardH / 2 + 6);

        ctx.fillStyle = 'rgba(210,244,255,.92)';
        ctx.font = portrait ? '800 16px Microsoft YaHei UI' : '800 17px Microsoft YaHei UI';
        ctx.fillText(meaning, cardX + (portrait ? cardW * .35 : cardW * .30), y + cardH / 2 + 6);

        const chipW = portrait ? 138 : 184;
        const chipX = cardX + cardW - chipW - 14;
        const chipY = y + (cardH - 22) / 2;
        roundRect(chipX, chipY, chipW, 22, 11, 'rgba(3,11,26,.52)', 'rgba(116,238,255,.22)', 1);
        ctx.fillStyle = '#ffefb0';
        ctx.font = portrait ? '800 12px Microsoft YaHei UI' : '800 13px Microsoft YaHei UI';
        textCenter(statText, chipX + chipW / 2, chipY + 16);
      });
    }
    ctx.restore();

    const buttons = gameOverButtons();
    drawFantasyButton(buttons.restart.x, buttons.restart.y, buttons.restart.w, buttons.restart.h, '重新开始', { primary: true });
    drawFantasyButton(buttons.menu.x, buttons.menu.y, buttons.menu.w, buttons.menu.h, '返回主菜单');

    ctx.font = '14px Microsoft YaHei UI';
    ctx.fillStyle = 'rgba(235,240,255,.58)';
    textCenter('快捷键：Enter / R 重新开始，Esc / M 返回主菜单', W / 2, panelY + panelH - 24);
    ctx.restore();
  }

  function bookButtonRect() {
    return isPortraitMode()
      ? { x: W - 138, y: 18, w: 54, h: 54 }
      : { x: W - 100, y: 12, w: 38, h: 38 };
  }

  function settingsButtonRect() {
    return isPortraitMode()
      ? { x: W - 72, y: 16, w: 54, h: 54 }
      : { x: W - 54, y: 12, w: 38, h: 38 };
  }

  function drawBookQuickButton() {
    const b = bookButtonRect();
    if (!b || !(game.mode === 'playing' || game.mode === 'paused')) return;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const cd = Math.ceil(game.bookCd || 0);
    const t = uiPulse(520, 1.2);
    const portrait = isPortraitMode();
    const r = b.w / 2;
    ctx.save();
    ctx.shadowColor = cd > 0 ? 'rgba(0,0,0,.12)' : `rgba(255,218,116,${0.20 + t * 0.14})`;
    ctx.shadowBlur = cd > 0 ? 6 : (portrait ? 10 + t * 8 : 7 + t * 5);
    ctx.fillStyle = cd > 0 ? 'rgba(52,54,82,.42)' : `rgba(96,62,160,${0.42 + t * 0.10})`;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = cd > 0 ? 'rgba(200,210,220,.16)' : `rgba(255,226,140,${0.34 + t * 0.26})`;
    ctx.lineWidth = portrait ? 1.5 : 1.3;
    ctx.beginPath(); ctx.arc(cx, cy, r - 1, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = cd > 0 ? 'rgba(230,236,242,.52)' : '#fff0b0';
    ctx.font = portrait ? '900 20px Microsoft YaHei UI' : '900 15px Microsoft YaHei UI';
    textCenter(cd > 0 ? String(cd) : '图', cx, cy + (portrait ? 7 : 5));
    ctx.restore();
  }

  function drawSettingsButton() {
    const hero = selectedHero();
    const previewAction = hero.actions?.idle || hero.actions?.walk;
    const img = images[previewAction?.imageKey || hero.imageKey] || images[hero.imageKey];
    const b = settingsButtonRect();
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const r = b.w / 2;
    const t = uiPulse(580);

    ctx.save();
    ctx.shadowColor = `rgba(116,236,255,${0.24 + t * 0.22})`;
    ctx.shadowBlur = isPortraitMode() ? 10 + t * 8 : 7 + t * 5;
    ctx.fillStyle = `rgba(54,44,112,${0.48 + t * 0.08})`;
    ctx.beginPath(); ctx.arc(cx, cy, r + (isPortraitMode() ? 3 : 2), 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();
    if (img && previewAction) drawAtlas(img, previewAction.cols || 1, previewAction.rows || 4, heroPreviewFrameIndex(previewAction), cx - r, cy - r, r * 2, r * 2);
    else if (img) drawImageCover(img, cx - r, cy - r, r * 2, r * 2);
    else {
      const bg = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
      bg.addColorStop(0, 'rgba(78,72,144,.66)'); bg.addColorStop(1, 'rgba(16,56,88,.68)');
      ctx.fillStyle = bg; ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
    ctx.restore();
    ctx.strokeStyle = `rgba(178,238,255,${0.46 + t * 0.34})`;
    ctx.lineWidth = isPortraitMode() ? 2 : 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  }

  function settingsRects() {
    const panelW = Math.min(500, W - 48);
    const panelH = 596;
    const panelX = (W - panelW) / 2;
    const panelY = isPortraitMode() ? 240 : 92;
    const rowX = panelX + 30;
    const rowW = panelW - 60;
    const rows = SETTINGS_ITEMS.map((item, i) => ({ item, x: rowX, y: panelY + 138 + i * 62, w: rowW, h: 48 }));
    return {
      panel: { x: panelX, y: panelY, w: panelW, h: panelH },
      rows,
      menu: { x: panelX + 30, y: panelY + 450, w: 136, h: 46 },
      exit: { x: panelX + panelW / 2 - 68, y: panelY + 450, w: 136, h: 46 },
      close: { x: panelX + panelW - 166, y: panelY + 450, w: 136, h: 46 }
    };
  }

  function drawSettings() {
    if (game.player) drawGame();
    else drawMenu();
    const ui = settingsRects();
    const p = ui.panel;
    const t = uiPulse(640);

    ctx.fillStyle = 'rgba(2,5,14,.72)';
    ctx.fillRect(0, 0, W, H);
    drawFantasyPanel(p.x, p.y, p.w, p.h, {
      accent: '#a78bff', radius: 28,
      fillTop: 'rgba(54,42,112,.70)', fillBottom: 'rgba(10,50,78,.82)',
      stroke: `rgba(204,176,255,${0.24 + t * 0.16})`,
      shadow: 'rgba(138,104,255,.22)', shadowBlur: 18, pulse: true,
      noDeco: true, noInner: true
    });
    ctx.fillStyle = '#f7fbff';
    ctx.font = isPortraitMode() ? '900 38px Microsoft YaHei UI' : '900 34px Microsoft YaHei UI';
    textCenter('系统设置', W / 2, p.y + 68);
    ctx.fillStyle = 'rgba(220,234,255,.84)';
    ctx.font = '15px Microsoft YaHei UI';
    textCenter('点击开关即时生效', W / 2, p.y + 100);

    ui.rows.forEach((row, i) => {
      const rowPulse = uiPulse(900, i * 0.6);
      drawFantasyPanel(row.x - 6, row.y + 2, row.w + 12, row.h, {
        accent: '#8da8ff', radius: 16,
        fillTop: `rgba(40,42,90,${0.16 + rowPulse * 0.04})`,
        fillBottom: 'rgba(12,34,62,.22)', stroke: 'rgba(178,198,255,.06)', shadowBlur: 0,
        noDeco: true, noInner: true
      });
      ctx.fillStyle = '#eef7ff';
      ctx.font = isPortraitMode() ? '700 20px Microsoft YaHei UI' : '600 19px Microsoft YaHei UI';
      ctx.fillText(row.item.label, row.x + 8, row.y + 32);
      drawFantasySwitch(row.x + row.w - 92, row.y + 6, game.settings[row.item.key]);
    });

    drawFantasyButton(ui.menu.x, ui.menu.y, ui.menu.w, ui.menu.h, '主菜单');
    drawFantasyButton(ui.close.x, ui.close.y, ui.close.w, ui.close.h, '关闭', { primary: true });
    drawFantasyButton(ui.exit.x, ui.exit.y, ui.exit.w, ui.exit.h, '退出');
  }

  function drawToggle(x, y, on) {
    drawFantasySwitch(x, y - 2, on);
  }

  function drawCrosshair() {
    // 这个函数只给 PC 鼠标模式使用。
    // 手机端由 shouldDrawMouseCrosshair() 拦截，不再绘制鼠标瞄准点。
    const p = game.player;
    const a = aimDir();
    const worldPos = { x: game.mouse.x, y: game.mouse.y };
    const screenPos = worldToScreenPoint(worldPos);
    const x = screenPos.x;
    const y = screenPos.y;
    ctx.strokeStyle = "#ffe680";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.moveTo(x - 16, y);
    ctx.lineTo(x - 10, y);
    ctx.moveTo(x + 10, y);
    ctx.lineTo(x + 16, y);
    ctx.moveTo(x, y - 16);
    ctx.lineTo(x, y - 10);
    ctx.moveTo(x, y + 10);
    ctx.lineTo(x, y + 16);
    ctx.stroke();
  }

  function drawFloats() {
    ctx.font = "700 15px Microsoft YaHei UI";
    for (const f of game.floats) {
      ctx.globalAlpha = clamp(f.life / 1.2, 0, 1);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
      ctx.globalAlpha = 1;
    }
  }

  function drawAtlas(img, cols, rows, index, x, y, w, h, flipX = false) {
    if (!img) return;
    const cw = img.width / cols;
    const ch = img.height / rows;
    const col = index % cols;
    const row = Math.floor(index / cols);
    if (flipX) {
      ctx.save();
      ctx.translate(x + w, y);
      ctx.scale(-1, 1);
      ctx.drawImage(img, col * cw, row * ch, cw, ch, 0, 0, w, h);
      ctx.restore();
    } else {
      ctx.drawImage(img, col * cw, row * ch, cw, ch, x, y, w, h);
    }
  }


  function getAtlasFrameMetrics(img, cols, rows, index) {
    if (!img) return null;
    if (!img.__atlasMetrics) img.__atlasMetrics = {};
    const key = `${cols}x${rows}:${index}`;
    if (img.__atlasMetrics[key]) return img.__atlasMetrics[key];
    const cw = Math.floor(img.width / cols);
    const ch = Math.floor(img.height / rows);
    const col = index % cols;
    const row = Math.floor(index / cols);
    const cvs = document.createElement("canvas");
    cvs.width = cw; cvs.height = ch;
    const c = cvs.getContext("2d", { willReadFrequently: true });
    c.drawImage(img, col * cw, row * ch, cw, ch, 0, 0, cw, ch);
    const data = c.getImageData(0, 0, cw, ch).data;
    let minX = cw, minY = ch, maxX = -1, maxY = -1;
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        if (data[(y * cw + x) * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) {
      const empty = { cw, ch, minX: 0, minY: 0, maxX: cw - 1, maxY: ch - 1, bw: cw, bh: ch, footX: cw / 2, footY: ch - 1 };
      img.__atlasMetrics[key] = empty;
      return empty;
    }
    const footBandTop = Math.max(minY, Math.min(maxY, maxY - Math.max(14, Math.floor((maxY - minY + 1) * 0.22))));
    let sumX = 0, count = 0, footY = maxY;
    for (let y = footBandTop; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (data[(y * cw + x) * 4 + 3] > 24) {
          sumX += x;
          count++;
        }
      }
    }
    const footX = count ? sumX / count : (minX + maxX) / 2;
    const info = { cw, ch, minX, minY, maxX, maxY, bw: maxX - minX + 1, bh: maxY - minY + 1, footX, footY };
    img.__atlasMetrics[key] = info;
    return info;
  }

  function drawImageCover(img, x, y, w, h, flipX = false) {
    if (!img) return;
    const scale = Math.max(w / img.width, h / img.height);
    const sw = w / scale;
    const sh = h / scale;
    const sx = (img.width - sw) / 2;
    const sy = (img.height - sh) / 2;
    if (flipX) {
      ctx.save();
      ctx.translate(x + w, y);
      ctx.scale(-1, 1);
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
      ctx.restore();
    } else {
      ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
    }
  }

  function bar(x, y, w, h, value, fill) {
    ctx.fillStyle = "rgba(0,0,0,.45)";
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, w * clamp(value, 0, 1), h);
  }

  function drawHeldTranslationOverhead(x, y, text) {
    if (!text) return;
    const label = String(text);
    ctx.font = "700 16px Microsoft YaHei UI";
    const width = Math.min(240, Math.max(70, ctx.measureText(label).width + 28));
    const left = x - width / 2;
    roundRect(left, y, width, 30, 10, "rgba(255,222,109,.94)", "rgba(82,54,10,.78)", 2);
    ctx.fillStyle = "#2f2106";
    textCenter(label.length > 12 ? label.slice(0, 12) + "…" : label, x, y + 21);
    ctx.fillStyle = "rgba(255,255,255,.42)";
    ctx.fillRect(left + 10, y + 6, width - 20, 3);
  }

  function drawHeadHpBar(x, y, width, ratio, fill = "#74e083", label = "") {
    const safe = Math.max(0, Math.min(1, ratio || 0));
    const h = 8;
    const left = x - width / 2;
    ctx.fillStyle = "rgba(0,0,0,.62)";
    roundRectRaw(left - 2, y - 2, width + 4, h + 4, 5);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.14)";
    roundRectRaw(left - 1, y - 1, width + 2, h + 2, 4);
    ctx.fill();
    ctx.fillStyle = "#192228";
    roundRectRaw(left, y, width, h, 4);
    ctx.fill();
    ctx.fillStyle = fill;
    roundRectRaw(left, y, width * safe, h, 4);
    ctx.fill();
    if (label) {
      ctx.font = "700 11px Microsoft YaHei UI";
      ctx.fillStyle = "#f5fbff";
      const tw = ctx.measureText(label).width;
      roundRectRaw(x - tw / 2 - 6, y - 17, tw + 12, 13, 5);
      ctx.fillStyle = "rgba(8,12,16,.72)";
      roundRectRaw(x - tw / 2 - 6, y - 17, tw + 12, 13, 5);
      ctx.fill();
      ctx.fillStyle = "#f5fbff";
      ctx.fillText(label, x - tw / 2, y - 7);
    }
  }

  function accuracy() {
    const total = game.correct + game.wrong;
    return total ? `${Math.round(game.correct * 100 / total)}%` : "100%";
  }

  function errorRate() {
    const total = game.correct + game.wrong;
    return total ? `${Math.round(game.wrong * 100 / total)}%` : "0%";
  }

  function roundRect(x, y, w, h, r, fill, stroke, line = 1) {
    roundRectRaw(x, y, w, h, r);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = line;
      ctx.stroke();
    }
  }

  function roundRectRaw(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function center(text, y) {
    textCenter(text, W / 2, y);
  }

  function textCenter(text, x, y) {
    const w = ctx.measureText(text).width;
    ctx.fillText(text, x - w / 2, y);
  }

  function wrapText(text, x, y, maxWidth, lineHeight) {
    let line = "";
    for (const char of text) {
      const test = line + char;
      if (ctx.measureText(test).width > maxWidth && line) {
        ctx.fillText(line, x, y);
        line = char;
        y += lineHeight;
      } else {
        line = test;
      }
    }
    if (line) ctx.fillText(line, x, y);
  }

  function loop(now) {
    const dt = Math.min(0.033, (now - game.lastTime) / 1000);
    game.lastTime = now;
    document.body.dataset.gameMode = game.mode;
    update(dt);
    draw();
    requestAnimationFrame(loop);
  }

  function clientToGame(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: clamp((e.clientX - rect.left) * W / rect.width, 0, W),
      y: clamp((e.clientY - rect.top) * H / rect.height, 0, H)
    };
  }

  function handleCanvasClick(pos) {
    const quickBook = bookButtonRect();
    if (quickBook && (game.mode === "playing" || game.mode === "paused") && hit(pos, quickBook.x, quickBook.y, quickBook.w, quickBook.h)) {
      useBook();
      return true;
    }
    const settingsBtn = settingsButtonRect();
    if (settingsBtn && hit(pos, settingsBtn.x, settingsBtn.y, settingsBtn.w, settingsBtn.h)) {
      if (game.mode === "settings") closeSettings();
      else openSettings();
      return true;
    }
    if (game.mode === "settings") {
      const ui = settingsRects();
      for (const row of ui.rows) {
        if (hit(pos, row.x, row.y, row.w, row.h)) {
          toggleSetting(row.item.key);
          return true;
        }
      }
      if (hit(pos, ui.menu.x, ui.menu.y, ui.menu.w, ui.menu.h)) returnToMenu();
      else if (hit(pos, ui.exit.x, ui.exit.y, ui.exit.w, ui.exit.h)) exitGame();
      else if (hit(pos, ui.close.x, ui.close.y, ui.close.w, ui.close.h)) closeSettings();
      return true;
    }
    if (game.mode === "menu") {
      if (game.menuScreen === "home") {
        for (const card of homeModeCards()) {
          if (hit(pos, card.x, card.y, card.w, card.h)) {
            applyScreenMode(card.mode);
            play("pickup");
            return true;
          }
        }
        const btn = startButtonRect();
        if (hit(pos, btn.x, btn.y, btn.w, btn.h)) {
          game.menuScreen = "setup";
          play("reward");
        }
        return true;
      }

      if (isPortraitMode()) {
        for (const card of portraitContentCards()) {
          if (hit(pos, card.x, card.y, card.w, card.h)) {
            selectContentMode(card.mode);
            return true;
          }
        }
        for (const card of portraitQuizCards()) {
          if (hit(pos, card.x, card.y, card.w, card.h)) {
            selectQuizMode(card.mode);
            return true;
          }
        }
        for (const card of portraitDifficultyCards()) {
          if (hit(pos, card.x, card.y, card.w, card.h)) {
            selectDifficulty(card.d, `${card.name} / ${card.sub}`);
            return true;
          }
        }
        const btns = portraitActionButtons();
        if (hit(pos, btns.back.x, btns.back.y, btns.back.w, btns.back.h)) {
          game.menuScreen = "home";
          play("pickup");
          return true;
        }
        if (hit(pos, btns.start.x, btns.start.y, btns.start.w, btns.start.h)) {
          startGame(game.difficulty, game.difficultyName);
          return true;
        }
        const saved = loadSave();
        if (saved && hit(pos, btns.continue.x, btns.continue.y, btns.continue.w, btns.continue.h)) {
          continueSavedGame();
          return true;
        }
        return true;
      }

      for (const card of landscapeContentCards()) {
        if (hit(pos, card.x, card.y, card.w, card.h)) {
          selectContentMode(card.mode);
          return true;
        }
      }
      for (const card of landscapeQuizCards()) {
        if (hit(pos, card.x, card.y, card.w, card.h)) {
          selectQuizMode(card.mode);
          return true;
        }
      }

      for (const card of difficultyMenuCards()) {
        if (hit(pos, card.x, card.y, card.w, card.h)) {
          selectDifficulty(card.d, `${card.name} / ${card.sub}`);
          return true;
        }
      }
      const actionBtns = landscapeActionButtons();
      if (hit(pos, actionBtns.back.x, actionBtns.back.y, actionBtns.back.w, actionBtns.back.h)) {
        game.menuScreen = "home";
        play("pickup");
        return true;
      }
      if (hit(pos, actionBtns.start.x, actionBtns.start.y, actionBtns.start.w, actionBtns.start.h)) {
        startGame(game.difficulty, game.difficultyName);
        return true;
      }
      const saved = loadSave();
      if (saved && hit(pos, actionBtns.continue.x, actionBtns.continue.y, actionBtns.continue.w, actionBtns.continue.h)) {
        continueSavedGame();
        return true;
      }
      return true;
    } else if (game.mode === "reward") {
      for (let i = 0; i < 3; i++) if (hit(pos, 245 + i * 285, 245, 250, 215)) chooseReward(i);
    } else if (game.mode === "gameover") {
      const buttons = gameOverButtons();
      if (hit(pos, buttons.restart.x, buttons.restart.y, buttons.restart.w, buttons.restart.h)) {
        startGame(game.difficulty, game.difficultyName);
        return true;
      }
      if (hit(pos, buttons.menu.x, buttons.menu.y, buttons.menu.w, buttons.menu.h)) {
        returnToMenu();
        return true;
      }
      return true;
    }
  }

  function hit(p, x, y, w, h) {
    return p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h;
  }

  function selectDifficulty(d, name) {
    game.difficulty = d;
    game.difficultyName = name;
    play("reward");
  }

  function selectContentMode(mode) {
    game.contentMode = mode === "math" ? "math" : "word";
    localStorage.setItem("wordRealmContentMode", game.contentMode);
    game.message = `已选择${contentModeName()}`;
    play("pickup");
  }

  function selectQuizMode(mode) {
    game.quizMode = normalizeQuizMode(mode);
    localStorage.setItem("wordRealmQuizMode", game.quizMode);
    game.message = `${contentModeName()}模式：${quizModeName()}`;
    play("pickup");
  }

  function selectStartRoom(room) {
    const from = syncSelectedStartRoom();
    const next = normalizeStartRoom(room);
    if (next === from) return;
    game.selectedStartRoom = next;
    game.levelCarousel = { from, to: next, start: performance.now(), duration: 260, active: true };
    localStorage.setItem("wordRealmStartRoom", String(game.selectedStartRoom));
    play("reward");
  }

  function cycleStartRoom(step = 1) {
    const total = levelLoopTotal();
    if (total <= 1) {
      game.message = "当前只有 1 个已激活关卡";
      play("wrong");
      return;
    }
    const current = syncSelectedStartRoom();
    const dir = Math.sign(step || 0);
    if (!dir) return;
    const next = ((current - 1 + dir + total) % total) + 1;
    selectStartRoom(next);
  }

  function heroSwipeEnabled() {
    return game.mode === "menu" && game.menuScreen === "setup" && HEROES.length > 1;
  }

  function beginHeroSwipe(pos, event) {
    if (!heroSwipeEnabled()) return false;
    const area = heroSwipeArea();
    if (!hit(pos, area.x, area.y, area.w, area.h)) return false;
    event.preventDefault();
    event.stopPropagation();
    game.heroSwipe = {
      active: true,
      pointerId: event.pointerId,
      startX: pos.x,
      startY: pos.y,
      dx: 0,
      dy: 0
    };
    game.heroDragOffset = 0;
    canvas.setPointerCapture?.(event.pointerId);
    return true;
  }

  function updateHeroSwipe(event) {
    const swipe = game.heroSwipe;
    if (!swipe?.active || event.pointerId !== swipe.pointerId) return false;
    event.preventDefault();
    event.stopPropagation();
    const pos = clientToGame(event);
    swipe.dx = pos.x - swipe.startX;
    swipe.dy = pos.y - swipe.startY;
    game.heroDragOffset = clamp(swipe.dx / heroSwipeRange(), -1.15, 1.15);
    return true;
  }

  function endHeroSwipe(event) {
    const swipe = game.heroSwipe;
    if (!swipe?.active || event.pointerId !== swipe.pointerId) return false;
    event.preventDefault();
    event.stopPropagation();
    const pos = clientToGame(event);
    const dx = pos.x - swipe.startX;
    const dy = pos.y - swipe.startY;
    const area = heroSwipeArea();
    const threshold = Math.max(48, area.w * 0.12);
    game.heroSwipe = { active: false, pointerId: null, startX: 0, startY: 0, dx: 0, dy: 0 };
    game.heroDragOffset = 0;
    if (Math.abs(dx) >= threshold && Math.abs(dx) > Math.abs(dy) * 1.12) {
      cycleHero(dx < 0 ? 1 : -1);
    }
    return true;
  }

  function levelSwipeEnabled() {
    return game.mode === "menu" && game.menuScreen === "setup";
  }

  function beginLevelSwipe(pos, event) {
    if (!levelSwipeEnabled()) return false;
    const area = levelCorridorArea();
    if (!hit(pos, area.x, area.y, area.w, area.h)) return false;
    event.preventDefault();
    event.stopPropagation();
    game.levelSwipe = {
      active: true,
      pointerId: event.pointerId,
      startX: pos.x,
      startY: pos.y,
      dx: 0,
      dy: 0
    };
    game.levelDragOffset = 0;
    canvas.setPointerCapture?.(event.pointerId);
    return true;
  }

  function updateLevelSwipe(event) {
    const swipe = game.levelSwipe;
    if (!swipe?.active || event.pointerId !== swipe.pointerId) return false;
    event.preventDefault();
    event.stopPropagation();
    const pos = clientToGame(event);
    swipe.dx = pos.x - swipe.startX;
    swipe.dy = pos.y - swipe.startY;
    game.levelDragOffset = clamp(swipe.dx / levelSwipeRange(), -1.15, 1.15);
    return true;
  }

  function endLevelSwipe(event) {
    const swipe = game.levelSwipe;
    if (!swipe?.active || event.pointerId !== swipe.pointerId) return false;
    event.preventDefault();
    event.stopPropagation();
    const pos = clientToGame(event);
    const dx = pos.x - swipe.startX;
    const dy = pos.y - swipe.startY;
    const threshold = Math.max(34, levelSwipeRange() * 0.36);
    game.levelSwipe = { active: false, pointerId: null, startX: 0, startY: 0, dx: 0, dy: 0 };
    game.levelDragOffset = 0;
    if (Math.abs(dx) >= threshold && Math.abs(dx) > Math.abs(dy) * 1.1) {
      cycleStartRoom(dx < 0 ? 1 : -1);
    }
    return true;
  }

  canvas.addEventListener("pointermove", e => {
    game.lastPointerType = e.pointerType || "mouse";
    if (updateHeroSwipe(e)) return;
    if (updateLevelSwipe(e)) return;

    // PC 鼠标移动才更新 mouse 瞄准点。
    // 手机/平板触摸移动只负责按钮、摇杆、拾取等操作，不能写入鼠标瞄准点。
    if (e.pointerType && e.pointerType !== "mouse") return;

    const screen = clientToGame(e);
    const world = screenToWorldPoint(screen);
    game.mouse.x = world.x;
    game.mouse.y = world.y;
  });

  canvas.addEventListener("pointerdown", e => {
    game.lastPointerType = e.pointerType || "mouse";
    const screen = clientToGame(e);
    const world = screenToWorldPoint(screen);

    // 只有鼠标点击画布才更新 mouse 坐标和执行鼠标点击射击。
    // 手机端点击画布不再变成“鼠标瞄准点”，避免准星飘到手指点过的位置。
    if (!e.pointerType || e.pointerType === "mouse") {
      game.mouse = { x: world.x, y: world.y, down: true };
    }

    if (beginHeroSwipe(screen, e)) return;
    if (beginLevelSwipe(screen, e)) return;

    const handled = handleCanvasClick(screen);
    // 手机端不再监听画布点击攻击、双击闪现或全屏拖拽瞄准；局内攻击/闪现只走右下角按钮。
    if (!handled && game.mode === "playing" && e.pointerType === "mouse" && game.settings.clickToShoot) fire(world);
  });

  canvas.addEventListener("pointerup", e => {
    game.lastPointerType = e.pointerType || game.lastPointerType || "mouse";
    if (!e.pointerType || e.pointerType === "mouse") game.mouse.down = false;
    if (endHeroSwipe(e)) return;
    if (endLevelSwipe(e)) return;
  });

  canvas.addEventListener("pointercancel", e => {
    const heroSwipe = game.heroSwipe;
    if (heroSwipe?.active && e.pointerId === heroSwipe.pointerId) {
      game.heroSwipe = { active: false, pointerId: null, startX: 0, startY: 0, dx: 0, dy: 0 };
      game.heroDragOffset = 0;
    }
    const levelSwipe = game.levelSwipe;
    if (levelSwipe?.active && e.pointerId === levelSwipe.pointerId) {
      game.levelSwipe = { active: false, pointerId: null, startX: 0, startY: 0, dx: 0, dy: 0 };
      game.levelDragOffset = 0;
    }
  });

  window.addEventListener("keydown", e => {
    game.keys.add(e.code);
    if (e.code === "Digit1") {
      if (game.mode === "reward") chooseReward(0);
      else if (game.mode === "menu" && game.menuScreen === "setup") selectDifficulty(2, "\u7b80\u5355 / \u9ad8\u4e2d\u8bcd\u6c47");
    }
    if (e.code === "Digit2") {
      if (game.mode === "reward") chooseReward(1);
      else if (game.mode === "menu" && game.menuScreen === "setup") selectDifficulty(4, "\u666e\u901a / \u56db\u516d\u7ea7\u8bcd\u6c47");
    }
    if (e.code === "Digit3") {
      if (game.mode === "reward") chooseReward(2);
      else if (game.mode === "menu" && game.menuScreen === "setup") selectDifficulty(6, "\u56f0\u96be / \u96c5\u601d\u8bcd\u6c47");
    }
    if (e.code === "KeyH" && game.mode === "menu" && game.menuScreen === "setup") cycleHero(1);
    if (game.mode === "menu" && game.menuScreen === "setup" && !isPortraitMode()) {
      if (e.code === "ArrowLeft") { e.preventDefault(); cycleHero(-1); }
      if (e.code === "ArrowRight") { e.preventDefault(); cycleHero(1); }
    }
    if (e.code === "Enter" && game.mode === "menu") {
      if (game.menuScreen === "home") {
        game.menuScreen = "setup";
        play("reward");
      } else {
        startGame(game.difficulty, game.difficultyName);
      }
    }
    if ((e.code === "Enter" || e.code === "KeyR") && game.mode === "gameover") startGame(game.difficulty, game.difficultyName);
    if (e.code === "KeyC" && game.mode === "menu" && game.menuScreen === "setup") continueSavedGame();
    if (e.code === "KeyM" && game.mode === "gameover") returnToMenu();
    if (e.code === "KeyR" && (game.mode === "playing" || game.mode === "paused")) restartCurrentRoom();
    if (e.code === "Space") dash();
    if (e.code === "KeyE") interact();
    if (e.code === "KeyQ") shield();
    if (e.code === "KeyT" || e.code === "Tab") {
      e.preventDefault();
      if (!e.repeat) useBook();
    }
    if (e.code === "Escape" && game.mode === "gameover") returnToMenu();
    else if (e.code === "Escape" && game.mode === "menu" && game.menuScreen === "setup") game.menuScreen = "home";
    else if (e.code === "Escape") togglePause();
  });

  window.addEventListener("keyup", e => {
    game.keys.delete(e.code);
  });

  window.addEventListener("blur", () => {
    if (game.settings.autoPauseOnBlur && game.mode === "playing") game.mode = "paused";
  });

  function togglePause() {
    if (game.mode === "settings") {
      closeSettings();
      return;
    }
    if (game.mode === "playing") game.mode = "paused";
    else if (game.mode === "paused") game.mode = "playing";
  }

  async function lockPreferredOrientation() {
    try {
      if (screen.orientation?.lock) await screen.orientation.lock(isPortraitMode() ? "portrait" : "landscape");
    } catch (error) {
      console.warn("屏幕方向锁定失败，使用CSS比例兜底", error);
    }
  }

  function syncFullscreenState() {
    const doc = document;
    const active = !!(doc.fullscreenElement || doc.webkitFullscreenElement || doc.msFullscreenElement);
    document.body.dataset.fullscreen = active ? "1" : "0";
    document.body.dataset.forceLandscape = active && !isPortraitMode() ? "1" : "0";
    if (active) {
      setTimeout(() => window.scrollTo?.(0, 1), 60);
      lockPreferredOrientation();
    } else {
      document.body.dataset.forceLandscape = "0";
      screen.orientation?.unlock?.();
    }
  }

  async function toggleFullscreen() {
    const doc = document;
    const appRoot = document.getElementById("app");
    const fullscreenElement = doc.fullscreenElement || doc.webkitFullscreenElement || doc.msFullscreenElement;
    try {
      if (fullscreenElement) {
        const exit = doc.exitFullscreen || doc.webkitExitFullscreen || doc.msExitFullscreen;
        if (exit) {
          const result = exit.call(doc);
          if (result && typeof result.then === "function") await result;
        }
        syncFullscreenState();
        return;
      }
      const candidates = [appRoot, canvas, document.documentElement, document.body].filter(Boolean);
      let entered = false;
      for (const node of candidates) {
        const request = node.requestFullscreen || node.webkitRequestFullscreen || node.msRequestFullscreen;
        if (!request) continue;
        const result = request.call(node);
        if (result && typeof result.then === "function") await result;
        entered = true;
        break;
      }
      if (!entered) {
        game.message = "当前浏览器不支持网页全屏";
        return;
      }
      await lockLandscape();
      syncFullscreenState();
    } catch (error) {
      console.warn(error);
      game.message = "全屏启动失败，请检查浏览器权限";
    }
  }

  function bindStick(zoneId, knobId, target, resetOnEnd) {
    const zone = document.getElementById(zoneId);
    const knob = document.getElementById(knobId);
    if (!zone || !knob) return;
    let pointer = null;

    const resetStick = () => {
      if (resetOnEnd) {
        target.x = 0;
        target.y = 0;
      }
      knob.style.transform = "translate(0, 0)";
      zone.classList.remove("is-active");
    };

    const set = e => {
      e.preventDefault();
      const rect = zone.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const radius = Math.max(42, Math.min(rect.width, rect.height) * (isPortraitMode() && zoneId === "moveZone" ? 0.34 : 0.38));
      let x = (e.clientX - cx) / radius;
      let y = (e.clientY - cy) / radius;
      const l = len(x, y);
      if (l > 1) {
        x /= l;
        y /= l;
      }
      target.x = x;
      target.y = y;
      knob.style.transform = `translate(${x * radius}px, ${y * radius}px)`;
      zone.classList.add("is-active");
    };

    zone.addEventListener("pointerdown", e => {
      e.preventDefault();
      e.stopPropagation();
      pointer = e.pointerId;
      zone.setPointerCapture?.(pointer);
      set(e);
    });
    zone.addEventListener("pointermove", e => {
      if (e.pointerId !== pointer) return;
      e.preventDefault();
      e.stopPropagation();
      set(e);
    });
    const end = e => {
      if (e.pointerId !== pointer) return;
      e.preventDefault();
      e.stopPropagation();
      pointer = null;
      resetStick();
    };
    zone.addEventListener("pointerup", end);
    zone.addEventListener("pointercancel", end);
    zone.addEventListener("lostpointercapture", e => {
      if (e.pointerId !== pointer) return;
      pointer = null;
      resetStick();
    });
  }


  bindStick("moveZone", "moveKnob", game.touchMove, true);


  function runTouchAction(action, direction = null) {
    if (action === "fire") fire(null, direction || currentMoveFireDirection());
    if (action === "dash") dash(direction || currentFreeActionDirection());
    if (action === "interact") interact();
    if (action === "potion") shield();
    if (action === "book") useBook();
    // 手机端已删除暂停按钮，暂停仍保留 Esc 键。
    if (action === "resume" && game.mode === "paused") togglePause();
    if (action === "restart" && (game.mode === "playing" || game.mode === "paused")) restartCurrentRoom();
    if (action === "fullscreen") toggleFullscreen();
  }

  function buttonStickVector(button, event, originRect) {
    const rect = originRect || button.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = event.clientX - cx;
    const dy = event.clientY - cy;
    const distance = Math.hypot(dx, dy);
    const radius = Math.max(18, Math.min(rect.width, rect.height) * 0.32);
    const visualScale = distance > 0 ? Math.min(radius, distance) / distance : 0;
    button.style.setProperty("--stick-x", `${dx * visualScale}px`);
    button.style.setProperty("--stick-y", `${dy * visualScale}px`);
    button.classList.add("is-active");
    return {
      x: dx,
      y: dy,
      distance,
      threshold: Math.max(15, Math.min(rect.width, rect.height) * 0.22)
    };
  }

  function resetButtonStick(button) {
    button.classList.remove("is-active");
    button.style.setProperty("--stick-x", "0px");
    button.style.setProperty("--stick-y", "0px");
  }

  function directionFromButtonStick(stick) {
    if (stick && stick.distance >= stick.threshold) return freeActionDirection({ x: stick.x, y: stick.y }, game.player?.facing || 0);
    return currentFreeActionDirection();
  }

  function bindDirectionalActionButton(button) {
    let pointer = null;
    let originRect = null;
    let latestStick = null;
    let pointerHandledAt = 0;

    button.addEventListener("pointerdown", e => {
      e.preventDefault();
      e.stopPropagation();
      pointer = e.pointerId;
      originRect = button.getBoundingClientRect();
      button.setPointerCapture?.(pointer);
      latestStick = buttonStickVector(button, e, originRect);
    });

    button.addEventListener("pointermove", e => {
      if (e.pointerId !== pointer) return;
      e.preventDefault();
      e.stopPropagation();
      latestStick = buttonStickVector(button, e, originRect);
    });

    const finish = e => {
      if (e.pointerId !== pointer) return;
      e.preventDefault();
      e.stopPropagation();
      latestStick = buttonStickVector(button, e, originRect);
      pointer = null;
      originRect = null;
      pointerHandledAt = Date.now();
      runTouchAction(button.dataset.action, directionFromButtonStick(latestStick));
      resetButtonStick(button);
    };

    const cancel = e => {
      if (e.pointerId !== pointer) return;
      pointer = null;
      originRect = null;
      latestStick = null;
      resetButtonStick(button);
    };

    button.addEventListener("pointerup", finish);
    button.addEventListener("pointercancel", cancel);
    button.addEventListener("lostpointercapture", cancel);

    button.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      if (Date.now() - pointerHandledAt < 650) return;
      runTouchAction(button.dataset.action, currentFreeActionDirection());
    });
  }

  function bindInstantActionButton(button) {
    let pointerHandledAt = 0;

    button.addEventListener("pointerdown", e => {
      e.preventDefault();
      e.stopPropagation();
      button.setPointerCapture?.(e.pointerId);
      pointerHandledAt = Date.now();
      runTouchAction(button.dataset.action);
    });

    button.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      if (Date.now() - pointerHandledAt < 650) return;
      runTouchAction(button.dataset.action);
    });
  }

  document.querySelectorAll("[data-action]").forEach(button => {
    const action = button.dataset.action;
    if (action === "fire" || action === "dash") bindDirectionalActionButton(button);
    else bindInstantActionButton(button);
  });

  ["fullscreenchange", "webkitfullscreenchange", "msfullscreenchange"].forEach(evt => window.addEventListener(evt, syncFullscreenState));
  window.addEventListener("resize", () => syncFullscreenState());
  window.addEventListener("contextmenu", e => e.preventDefault());
  applyScreenMode(game.screenMode);
  requestAnimationFrame(loop);
  boot().catch(error => {
    console.error(error);
    loading.innerHTML = `\u52a0\u8f7d\u5931\u8d25\uff1a${error.message}<br><small>\u8bf7\u786e\u8ba4\u662f\u5728 web \u6587\u4ef6\u5939\u91cc\u542f\u52a8\u672c\u5730\u670d\u52a1\u5668\uff0c\u4e14 assets\u3001game.js\u3001wordbank.json \u90fd\u548c index.html \u5728\u540c\u4e00\u5c42\u3002</small>`;
  });
})();
