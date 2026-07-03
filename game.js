(() => {
  const W = 1280;
  const H = 720;
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const loading = document.getElementById("loading");

  // 资源路径统一从 game.js 所在目录计算，避免部署到子目录时素材路径跑偏。
  // Resource paths are resolved relative to game.js so deployments under subfolders still work.
  const SCRIPT_BASE = new URL("./", document.currentScript?.src || window.location.href);
  const ASSET_VERSION = "20260703-maze-v51-lazy-cache";
  // 正式访问只用固定版本号，方便 service worker 和浏览器缓存，第二次打开更快。
  // 本地调素材需要强制刷新时，在网址后加 ?dev=1 或 ?nocache=1。
  const FORCE_REFRESH = /(?:^|[?&])(dev|nocache)=1(?:&|$)/.test(window.location.search);
  const DEV_CACHE_BUSTER = FORCE_REFRESH ? Date.now().toString(36) : "";
  const assetUrl = path => {
    const url = new URL(String(path).replace(/^\.?\//, ""), SCRIPT_BASE);
    url.searchParams.set("v", ASSET_VERSION);
    if (DEV_CACHE_BUSTER) url.searchParams.set("dev", DEV_CACHE_BUSTER);
    return url.href;
  };

  const ASSETS = {
    heroConfig: assetUrl("assets/config/heroes.json"),
    monsterConfig: assetUrl("assets/config/monsters.json"),
    bossConfig: assetUrl("assets/config/bosses.json"),
    itemConfig: assetUrl("assets/config/items.json"),
    levelConfig: assetUrl("assets/config/levels.json"),
    wordConfig: assetUrl("assets/config/words.json"),
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

  let MONSTER_VARIANTS = ["monster_00", "monster_01", "monster_02", "monster_03", "monster_04", "monster_05", "monster_06", "monster_07"];
  let MONSTER_TYPES = [];
  let BOSS_TYPES = [];
  let HEROES = [];
  let WORD_CHUNKS = [];
  const loadedWordChunks = new Set();
  const loadingImages = new Map();

  const FALLBACK_HERO_ID = "sunshangxiang";
  const ACTION_KEYS = ["idle", "walk", "attack", "dash", "hurt"];
  const heroAsset = (id, action) => assetUrl(`assets/heroes/${id}/${action}.png`);
  const heroKey = (id, action) => `hero_${id}_${action}`;
  const DIRECTION_KEYS = ["front", "left", "right", "back"];

  function facingKey(facing = 0) {
    return DIRECTION_KEYS[Math.max(0, Math.min(3, facing | 0))] || "front";
  }

  function entitySpriteKey(group, id, action, facing) {
    return `${group}_${id}_${action}_${facing}`;
  }

  function normalizeDirectionalActions(group, cfg, fallbackSize = { w: 96, h: 96, shadowW: 28, shadowH: 10 }) {
    const actions = {};
    for (const action of ["idle", "walk", "attack", "hurt"]) {
      actions[action] = {};
      for (const dir of DIRECTION_KEYS) {
        const raw = cfg.actions?.[action]?.[dir] || cfg.actions?.idle?.[dir] || null;
        if (!raw) {
          actions[action][dir] = null;
          continue;
        }
        const rel = typeof raw === "string" ? raw : raw.src;
        actions[action][dir] = rel ? {
          key: entitySpriteKey(group, cfg.id, action, dir),
          src: assetUrl(rel),
          cols: Number(raw.cols || 1),
          rows: Number(raw.rows || 1),
          frameCols: raw.frameCols || null,
          duration: Number(raw.duration || (action === "attack" ? 0.34 : action === "hurt" ? 0.28 : 0.25))
        } : null;
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

  function makeMonsterType(cfg) {
    return normalizeDirectionalActions("monster", cfg, { w: 94, h: 94, shadowW: 28, shadowH: 10 });
  }

  function makeBossType(cfg) {
    const base = normalizeDirectionalActions("boss", cfg, { w: 206, h: 206, shadowW: 78, shadowH: 21 });
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


  function makeHero(cfg) {
    const actions = {};
    for (const action of ACTION_KEYS) {
      const actionCfg = cfg.actions?.[action] || {};
      const { src: actionSrc, ...restActionCfg } = actionCfg;
      const rawSrc = actionSrc || (cfg.basePath ? `${cfg.basePath}/${action}.png` : `assets/heroes/${cfg.id}/${action}.png`);
      actions[action] = {
        imageKey: heroKey(cfg.id, action),
        src: assetUrl(rawSrc),
        ...restActionCfg
      };
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
      useMirrorLeft: !!cfg.useMirrorLeft,
      attackType: cfg.attackType || "orb",
      projectileColor: cfg.projectileColor || cfg.tint || "#fff2a0",
      projectileRadius: cfg.projectileRadius || 10,
      projectileSpeed: cfg.projectileSpeed || 560,
      damage: cfg.damage || 60,
      attack: cfg.attack || "普通攻击"
    };
  }

  async function fetchJsonConfig(src, fallback) {
    try {
      const resp = await fetch(src, { cache: "no-cache" });
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
      return await resp.json();
    } catch (error) {
      console.warn("配置读取失败，使用内置兜底：", src, error);
      return fallback;
    }
  }

  async function loadExternalConfigs() {
    const heroConfig = await fetchJsonConfig(ASSETS.heroConfig, { heroes: [] });
    HEROES = (heroConfig.heroes || []).map(makeHero).filter(hero => hero.id);
    if (!HEROES.length) {
      HEROES = [makeHero({
        id: FALLBACK_HERO_ID,
        name: "孙尚香",
        sub: "默认英雄",
        role: "射手",
        tint: "#9ddd58",
        attackType: "cannon",
        projectileColor: "#ffcf62",
        projectileRadius: 13,
        projectileSpeed: 500,
        damage: 78,
        attack: "重炮轰击",
        actions: {
          idle: { cols: 1, rows: 4, rowByFacing: [0, 2, 1, 3], frameHeight: 96 },
          walk: { cols: 4, rows: 4, rowByFacing: [0, 2, 1, 3], walkCols: [0, 1, 2, 3], frameHeight: 96 },
          attack: { cols: 1, rows: 4, rowByFacing: [0, 1, 1, 3], mirrorLeft: true, frameHeight: 100 },
          dash: { cols: 1, rows: 4, rowByFacing: [0, 1, 1, 3], mirrorLeft: true, frameHeight: 100 },
          hurt: { cols: 2, rows: 4, rowByFacing: [0, 1, 1, 3], frameCols: [0, 1], mirrorLeft: true, frameHeight: 98 }
        }
      })];
    }

    const monsterConfig = await fetchJsonConfig(ASSETS.monsterConfig, {});
    if (Array.isArray(monsterConfig.aiClasses)) MONSTER_AI_CLASSES = monsterConfig.aiClasses;
    // v49：不再自动使用 legacySpriteSheets，避免误以为没有读取 assets/monsters/types。
    // 只有单体 types 配置读取失败时，才会显示圆形兜底。
    if (Array.isArray(monsterConfig.types)) {
      const monsterTypeConfigs = await Promise.all(monsterConfig.types.map(src => fetchJsonConfig(assetUrl(src), null)));
      MONSTER_TYPES = monsterTypeConfigs.filter(Boolean).map(makeMonsterType).filter(type => type.id);
    }
    if (Array.isArray(monsterConfig.variants)) MONSTER_VARIANTS = monsterConfig.variants;
    else if (MONSTER_TYPES.length) MONSTER_VARIANTS = MONSTER_TYPES.map(type => type.id);

    const bossConfig = await fetchJsonConfig(ASSETS.bossConfig, {});
    if (Number.isFinite(Number(bossConfig.roomInterval))) BOSS_ROOM_INTERVAL = Number(bossConfig.roomInterval);
    if (Array.isArray(bossConfig.spawnPoints)) BOSS_POINTS = bossConfig.spawnPoints;
    // v49：不再自动使用 Boss legacySpriteSheets，强制读取 assets/bosses/types。
    if (Array.isArray(bossConfig.bosses)) {
      const bossTypeConfigs = await Promise.all(bossConfig.bosses.map(src => fetchJsonConfig(assetUrl(src), null)));
      BOSS_TYPES = bossTypeConfigs.filter(Boolean).map(makeBossType).filter(type => type.id);
      if (BOSS_TYPES.length) BOSS_INFO = BOSS_TYPES.map(type => ({ ...type.info }));
    }

    const itemConfig = await fetchJsonConfig(ASSETS.itemConfig, {});
    if (Array.isArray(itemConfig.items) && itemConfig.items.length) PICKUP_TYPES = itemConfig.items;
    ITEM_CONFIG = { ...ITEM_CONFIG, ...itemConfig };
    if (itemConfig.spriteSheet) ASSETS.items = assetUrl(itemConfig.spriteSheet);
    if (Number.isFinite(Number(itemConfig.roomPickup?.visible))) VISIBLE_ROOM_PICKUPS = Number(itemConfig.roomPickup.visible);
    if (Number.isFinite(Number(itemConfig.roomPickup?.hidden))) HIDDEN_ROOM_PICKUPS = Number(itemConfig.roomPickup.hidden);

    const levelConfig = await fetchJsonConfig(ASSETS.levelConfig, {});
    if (Number.isFinite(Number(levelConfig.roomTimeLimit))) ROOM_TIME_LIMIT = Number(levelConfig.roomTimeLimit);
    if (levelConfig.grid) Object.assign(BOMBER_GRID, levelConfig.grid);
    if (levelConfig.layout) ASSETS.levelBomberConfig = assetUrl(levelConfig.layout);
    if (Number.isFinite(Number(levelConfig.boss?.roomInterval))) BOSS_ROOM_INTERVAL = Number(levelConfig.boss.roomInterval);

    const wordConfig = await fetchJsonConfig(ASSETS.wordConfig, { chunks: [{ src: "wordbank.json", difficulty: 99 }] });
    WORD_CHUNKS = Array.isArray(wordConfig.chunks) ? wordConfig.chunks : [];

    const savedHero = localStorage.getItem("wordRealmHero");
    if (savedHero && HEROES.some(hero => hero.id === savedHero)) game.selectedHeroId = savedHero;
    else game.selectedHeroId = HEROES[0]?.id || FALLBACK_HERO_ID;
  }

  const DEFAULT_SETTINGS = {
    sound: true,
    crosshair: true,
    damageText: true,
    clickToShoot: true,
    autoPauseOnBlur: true
  };

  const SETTINGS_ITEMS = [
    { key: "sound", label: "\u97f3\u6548" },
    { key: "crosshair", label: "\u663e\u793a\u51c6\u661f" },
    { key: "damageText", label: "\u663e\u793a\u6d6e\u52a8\u6587\u5b57" },
    { key: "clickToShoot", label: "\u9f20\u6807\u70b9\u51fb\u5c04\u51fb" },
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
  let BOSS_POINTS = [
    { x: 250, y: 265 }, { x: 1025, y: 265 },
    { x: 250, y: 485 }, { x: 1025, y: 485 },
    { x: 640, y: 515 }
  ];
  let BOSS_INFO = [
    { name: "晶甲守卫", color: "#78d3ff", attackColor: "#95f5ff", baseStyle: "crystal", specialStyle: "crystalRain", basicCd: 1.25, skillCd: 4.2, skillName: "晶簇坠星" },
    { name: "赤焰天隼", color: "#ffb05c", attackColor: "#ff8c63", baseStyle: "fire", specialStyle: "featherNova", basicCd: 1.1, skillCd: 4.6, skillName: "炽羽爆散" },
    { name: "幽焰蛇后", color: "#b58dff", attackColor: "#af7dff", baseStyle: "venom", specialStyle: "serpentHoming", basicCd: 1.35, skillCd: 4.8, skillName: "灵蛇追咒" },
    { name: "棱镜幻蝶", color: "#8fe8ff", attackColor: "#b39cff", baseStyle: "prism", specialStyle: "prismSpiral", basicCd: 1.2, skillCd: 4.4, skillName: "幻蝶镜阵" },
    { name: "紫魇狮兽", color: "#c48dff", attackColor: "#d47cff", baseStyle: "claw", specialStyle: "shadowShockwave", basicCd: 1.18, skillCd: 4.2, skillName: "怒魇咆哮" },
    { name: "古林岩偶", color: "#b7d58a", attackColor: "#84d6ff", baseStyle: "rock", specialStyle: "golemRockfall", basicCd: 1.5, skillCd: 5.0, skillName: "陨岩轰落" }
  ];

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

  const WRONG_HIT_AGGRO_TILES = 2;
  const WRONG_HIT_AGGRO_DURATION = 15;
  const WRONG_HIT_SPEED_MULT = 2;
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

  const game = {
    mode: "loading",
    words: [],
    bank: [],
    difficulty: 2,
    difficultyName: "\u7b80\u5355 / \u9ad8\u4e2d\u8bcd\u6c47",
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
    lastTime: performance.now(),
    mouse: { x: W / 2, y: H / 2, down: false },
    aim: { x: 1, y: 0 },
    move: { x: 0, y: 0 },
    touchMove: { x: 0, y: 0 },
    touchAim: { x: 0, y: -1, active: false },
    camera: { x: 0, y: 0 },
    keys: new Set(),
    settings: loadSettings(),
    levelConfigs: {},
    previousMode: "menu",
    showBook: false,
    flash: 0
  };

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
      score: game.score,
      correct: game.correct,
      wrong: game.wrong,
      runTime: game.runTime,
      hero: game.selectedHeroId,
      theme: game.selectedThemeIndex,
      seen: [...game.runSeen].slice(-300),
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

  function loadImage(src) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => {
        console.warn("\u56fe\u7247\u52a0\u8f7d\u5931\u8d25\uff1a", src);
        resolve(null);
      };
      img.src = src;
    });
  }

  function ensureImage(key, src) {
    if (!key || !src) return Promise.resolve(null);
    if (images[key]) return Promise.resolve(images[key]);
    if (loadingImages.has(key)) return loadingImages.get(key);
    const task = loadImage(src).then(img => {
      images[key] = img;
      loadingImages.delete(key);
      return img;
    });
    loadingImages.set(key, task);
    return task;
  }

  function ensureImageEntries(entries) {
    return Promise.all((entries || []).filter(([, src]) => Boolean(src)).map(([key, src]) => ensureImage(key, src)));
  }

  function heroActionEntries(hero) {
    const entries = [];
    const seen = new Set();
    if (!hero) return entries;
    if (hero.imageKey && hero.src) {
      entries.push([hero.imageKey, hero.src]);
      seen.add(hero.imageKey);
    }
    for (const action of Object.values(hero.actions || {})) {
      if (!action || !action.imageKey || !action.src || seen.has(action.imageKey)) continue;
      entries.push([action.imageKey, action.src]);
      seen.add(action.imageKey);
    }
    return entries;
  }

  function ensureHeroImages(hero) {
    return ensureImageEntries(heroActionEntries(hero));
  }

  function ensureHeroPreview(hero) {
    if (!hero) return Promise.resolve(null);
    const action = hero.actions?.idle || hero.actions?.walk;
    if (action?.imageKey && action?.src) return ensureImage(action.imageKey, action.src);
    return ensureImage(hero.imageKey, hero.src);
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

  async function ensureWordsLoaded(maxDifficulty = 99) {
    if (!WORD_CHUNKS.length) {
      const fallback = await fetch(assetUrl("wordbank.json"), { cache: "no-cache" });
      if (!fallback.ok) throw new Error(`词库读取失败：${fallback.status}`);
      game.words = (await fallback.json()).filter(w => w.word && w.meaning);
      return game.words;
    }

    const need = WORD_CHUNKS.filter(chunk => Number(chunk.difficulty ?? 99) <= Number(maxDifficulty));
    if (!need.length) return game.words;
    const newlyLoaded = [];
    for (const chunk of need) {
      if (!chunk.src || loadedWordChunks.has(chunk.src)) continue;
      const resp = await fetch(assetUrl(chunk.src), { cache: "force-cache" });
      if (!resp.ok) throw new Error(`词库分包读取失败：${chunk.src}`);
      const rows = await resp.json();
      newlyLoaded.push(...rows);
      loadedWordChunks.add(chunk.src);
    }
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

  async function boot() {
    loading.textContent = "正在加载配置...";
    await loadExternalConfigs();

    loading.textContent = "正在加载关卡...";
    try {
      const levelResp = await fetch(ASSETS.levelBomberConfig, { cache: "force-cache" });
      if (levelResp.ok) game.levelConfigs.bomberman = await levelResp.json();
    } catch (error) {
      console.warn("关卡 JSON 加载失败，回退到内置布局", error);
    }

    loading.textContent = "正在加载首屏素材...";
    const selected = selectedHero();
    const imageEntries = [
      ...heroActionEntries(selected),
      ["items", ASSETS.items]
    ].filter(([, src]) => Boolean(src));
    await ensureImageEntries(imageEntries);
    console.info(`[assets] first screen loaded hero=${heroActionEntries(selected).length}, items=1; other heroes/monster/boss are lazy-loaded`);
    Object.entries(ASSETS.sounds).forEach(([key, src]) => {
      sounds[key] = loadSound(src);
    });

    loading.style.display = "none";
    game.mode = "menu";
    game.message = "\u9009\u62e9\u82f1\u96c4\u548c\u96be\u5ea6\u540e\u5f00\u59cb\u63a2\u9669";
    requestAnimationFrame(loop);
  }

  function play(name, volume = 0.45) {
    if (!game.settings.sound) return;
    const source = sounds[name];
    if (!source) return;
    try {
      const audio = source.cloneNode();
      audio.volume = volume;
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
    return !!currentTheme(room)?.bomberman;
  }

  function worldWidth(room = game.room) {
    return isBomberTheme(room) ? BOMBER_GRID.x * 2 + BOMBER_GRID.cols * BOMBER_GRID.tile : W;
  }

  function worldHeight(room = game.room) {
    return isBomberTheme(room) ? BOMBER_GRID.y * 2 + BOMBER_GRID.rows * BOMBER_GRID.tile : H;
  }

  function updateCamera() {
    if (!isBomberTheme() || !game.player) {
      game.camera.x = 0;
      game.camera.y = 0;
      return game.camera;
    }
    game.camera.x = clamp(game.player.x - W / 2, 0, Math.max(0, worldWidth() - W));
    game.camera.y = clamp(game.player.y - H / 2, 0, Math.max(0, worldHeight() - H));
    return game.camera;
  }

  function screenToWorldPoint(pos) {
    if (game.mode === "playing" && isBomberTheme()) return { x: pos.x + game.camera.x, y: pos.y + game.camera.y };
    return { x: pos.x, y: pos.y };
  }

  function worldToScreenPoint(pos) {
    if (isBomberTheme()) return { x: pos.x - game.camera.x, y: pos.y - game.camera.y };
    return { x: pos.x, y: pos.y };
  }

  function monsterAiFor(index = 0, room = game.room) {
    return MONSTER_AI_CLASSES[(room + index) % MONSTER_AI_CLASSES.length];
  }

  function bomberCellCenter(col, row) {
    return {
      x: BOMBER_GRID.x + col * BOMBER_GRID.tile + BOMBER_GRID.tile / 2,
      y: BOMBER_GRID.y + row * BOMBER_GRID.tile + BOMBER_GRID.tile / 2
    };
  }

  function pointToBomberCell(x, y) {
    return {
      col: Math.floor((x - BOMBER_GRID.x) / BOMBER_GRID.tile),
      row: Math.floor((y - BOMBER_GRID.y) / BOMBER_GRID.tile)
    };
  }

  function effectiveMonsterAggroTiles(monster) {
    const base = Number(monster?.baseAggroTiles || monster?.aggroTiles || 3);
    return monster?.wrongAggroTimer > 0 ? Math.max(base, WRONG_HIT_AGGRO_TILES) : base;
  }

  function triggerWrongHitAggro(monster) {
    if (!monster || monster.dead) return;
    monster.wrongAggroTimer = WRONG_HIT_AGGRO_DURATION;
    monster.wrongSpeedTimer = WRONG_HIT_AGGRO_DURATION;
    monster.baseAggroTiles = monster.baseAggroTiles || monster.aggroTiles || 3;
    monster.tileTarget = null;
    addFloat(`警觉 ${WRONG_HIT_AGGRO_TILES}格 · 加速×${WRONG_HIT_SPEED_MULT} 15s`, monster.x - 74, monster.y - 72, "#ff6f7d");
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

  function directionToNeighborCell(monster, dir) {
    const c = pointToBomberCell(monster.x, monster.y);
    const col = clamp(c.col + (dir.x || 0), 1, BOMBER_GRID.cols - 2);
    const row = clamp(c.row + (dir.y || 0), 1, BOMBER_GRID.rows - 2);
    const center = bomberCellCenter(col, row);
    if (!canStandAt(center.x, center.y, Math.max(12, monster.r - 3))) return null;
    return { ...center, col, row };
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
            hp: 1,
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

  function breakBomberBrick(block, source = null) {
    if (!block || block.kind !== "brick") return false;
    game.bomberBlocks = game.bomberBlocks.filter(item => item !== block);
    revealDoorFromBlock(block);

    let tip = "翻译回场";
    if (block.hiddenDoor) tip = "发现小门";
    else if (block.hiddenPickup) tip = "隐藏道具";
    else if (block.hiddenEntry) tip = "隐藏翻译";
    addFloat(tip, block.x + 8, block.y - 8, "#8ef3ff");

    if (block.hiddenEntry) spawnTokenAt(block.hiddenEntry, block.x + block.w / 2, block.y + block.h / 2, 1.5);
    if (block.hiddenPickup) dropPickupAt(block.x + block.w / 2, block.y + block.h / 2, block.hiddenPickup, true);

    if (source?.meaning) {
      const pos = randomWalkablePosition(130, worldWidth() - 130, 145, worldHeight() - 85, 24);
      refreshMeaningByText(source.meaning, pos.x, pos.y, 1.25);
    } else {
      refreshRandomTranslation(null, null, 1.0);
    }
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
    for (const block of [...game.bomberBlocks]) {
      if (!circleRectOverlap(pr.x, pr.y, r, block)) continue;
      if (block.kind === "brick") {
        breakBomberBrick(block, pr);
        pr.returned = true;
      } else {
        addFloat("墙体阻挡", pr.x - 22, pr.y - 20, "#d6f2ff");
        returnProjectileMeaning(pr, block.x + block.w / 2, block.y + block.h / 2, 0.95);
      }
      pr.life = 0;
      return true;
    }
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
    const speed = (monster.baseSpeed || monster.speed || 48) * scale * (chasing ? 1.05 : 0.88) * speedBoost;
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

  function updateSmartMonster(monster, dt, scale) {
    if (monster.wrongAggroTimer > 0) monster.wrongAggroTimer = Math.max(0, monster.wrongAggroTimer - dt);
    if (monster.wrongSpeedTimer > 0) monster.wrongSpeedTimer = Math.max(0, monster.wrongSpeedTimer - dt);
    const p = game.player;
    const aggroPx = effectiveMonsterAggroTiles(monster) * BOMBER_GRID.tile;
    const chasing = p && dist(monster, p) <= aggroPx;
    let move;
    if (chasing) {
      let sepX = 0, sepY = 0;
      for (const other of game.monsters) {
        if (other === monster || other.dead) continue;
        const dx = monster.x - other.x, dy = monster.y - other.y;
        const gap = Math.hypot(dx, dy);
        const minGap = monster.r + other.r + 18;
        if (gap > 0.01 && gap < minGap) {
          const push = (minGap - gap) / minGap;
          sepX += (dx / gap) * push;
          sepY += (dy / gap) * push;
        }
      }
      const d = norm({ x: p.x - monster.x, y: p.y - monster.y });
      move = norm({ x: d.x + sepX * 1.1, y: d.y + sepY * 1.1 });
      monster.turnCd = Math.min(monster.turnCd || 0, 0.3);
    } else {
      if (!monster.dir || monster.turnCd <= 0 || Math.random() < 0.006) {
        monster.dir = pickMany(BOMBER_DIRS, 1)[0];
        monster.turnCd = rand(0.45, 1.6);
      }
      monster.turnCd -= dt;
      move = monster.dir;
    }
    const speedBoost = monster.wrongSpeedTimer > 0 ? WRONG_HIT_SPEED_MULT : 1;
    const speed = (monster.baseSpeed || monster.speed || 48) * scale * (chasing ? 1.05 : 0.78) * speedBoost;
    const fromX = monster.x, fromY = monster.y;
    const targetX = monster.x + move.x * speed * dt;
    const targetY = monster.y + move.y * speed * dt;
    if (!canStandAt(targetX, targetY, Math.max(12, monster.r - 3))) {
      monster.dir = pickMany(BOMBER_DIRS, 1)[0];
      monster.turnCd = rand(0.3, 1.2);
      return;
    }
    moveWithinWalkMask(monster, targetX, targetY, Math.max(12, monster.r - 3));
    resolveObstacleCollision(monster, 4);
    resolveBomberBlockCollision(monster, 4);
    if (game.player) resolveCircleBlock(monster, game.player, 3);
    clampEntityToWalkMask(monster, fromX, fromY, Math.max(12, monster.r - 3));
    if (move.x || move.y) monster.facing = Math.abs(move.x) > Math.abs(move.y) ? (move.x < 0 ? 1 : 2) : (move.y < 0 ? 3 : 0);
  }

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

  function nextBossEntry(excludeMeaning = "") {
    const pool = game.bank.filter(e => e.meaning && e.meaning !== excludeMeaning);
    return pickMany(pool.length ? pool : game.bank, 1)[0] || { word: "", meaning: excludeMeaning };
  }

  function ensureBossToken(entry) {
    if (!entry || !entry.meaning) return;
    if (game.tokens.some(t => t.entry && t.entry.meaning === entry.meaning)) return;
    spawnToken(entry, 1.3);
  }

  function resolveEntityAction(entity) {
    if ((entity.hurtAnim || 0) > 0 || (entity.hitFlash || 0) > 0) return "hurt";
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
    const info = spriteConfig?.info || BOSS_INFO[kind];
    const entry = pickMany(roomWords, 1)[0] || nextBossEntry("");
    game.boss = {
      kind,
      typeId: spriteConfig?.id || `boss_${kind}`,
      spriteConfig,
      info,
      x: W / 2,
      y: 205,
      r: 72,
      hp: 360 + game.room * 36,
      maxHp: 360 + game.room * 36,
      hitFlash: 0,
      hurtAnim: 0,
      attackAnim: 0,
      action: "idle",
      attackCd: info.basicCd,
      patternCd: info.skillCd,
      pulse: Math.random() * 10,
      skillFlash: 0,
      entry
    };
    ensureBossToken(entry);
  }

  function setNextBossWord() {
    if (!game.boss) return;
    const old = game.boss.entry?.meaning || "";
    game.boss.entry = nextBossEntry(old);
    ensureBossToken(game.boss.entry);
  }

  function defeatBoss() {
    if (!game.boss) return;
    addFloat("Boss 击败", game.boss.x - 34, game.boss.y - 92, "#ffe083");
    dropPickupAt(game.boss.x - 34, game.boss.y + 34, { id: "heal" });
    dropPickupAt(game.boss.x + 34, game.boss.y + 34, { id: "speed" });
    game.boss = null;
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

  function buildObstaclesForTheme(theme, roomEntries = [], bossRoom = false) {
    const ids = Array.isArray(theme.obstacles) && theme.obstacles.length ? theme.obstacles : [0, 7];
    const points = bossRoom ? BOSS_POINTS : pickMany(OBSTACLE_POINTS, 4);
    const hiddenEntries = pickMany(roomEntries.filter(Boolean), bossRoom ? 3 : 2);
    return points.map((p, i) => ({
      x: p.x,
      y: p.y,
      r: bossRoom ? (i < 2 ? 46 : 52) : 44 + (i % 2) * 8,
      index: ids[i % ids.length],
      destructible: i >= 2,
      hp: i >= 2 ? 2 : 999,
      hiddenEntry: hiddenEntries[i - 2] || null,
      revealed: false
    }));
  }

  function resolveObstacleCollision(entity, extra = 0) {
    for (const ob of game.obstacles) {
      const dx = entity.x - ob.x;
      const dy = entity.y - ob.y;
      const d = Math.hypot(dx, dy) || 0.001;
      const min = entity.r + ob.r + extra;
      if (d < min) {
        const push = min - d;
        entity.x += dx / d * push;
        entity.y += dy / d * push;
      }
    }
    entity.x = clamp(entity.x, 45, worldWidth() - 45);
    entity.y = clamp(entity.y, 74, worldHeight() - 45);
  }

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
    for (const token of game.tokens) {
      resolveCircleBlock(entity, token, extra);
    }
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

  function revealHiddenEntry(ob) {
    if (!ob || ob.revealed || !ob.hiddenEntry) return;
    ob.revealed = true;
    spawnTokenAt(ob.hiddenEntry, ob.x, ob.y, 1.5);
    addFloat("\u9690\u85cf\u7ffb\u8bd1\u51fa\u73b0", ob.x - 32, ob.y - ob.r - 12, "#8ef3ff");
  }

  function dropPickupAt(x, y, forced = null, persistent = true) {
    const roll = forced || pickMany(roomPickupPool(), 1)[0];
    if (!roll) return;
    const type = roll.id === "mystery" ? pickMany(roomPickupPool(), 1)[0] : roll;
    const pos = findNearestWalkablePoint(x, y, 24, 220) || randomWalkablePosition(160, W - 160, 150, H - 110, 24);
    game.pickups.push({ type, x: pos.x, y: pos.y, r: 24, life: persistent ? Infinity : 14, pulse: Math.random() * 10 });
  }

  function applyPickup(type) {
    const p = game.player;
    if (!p || !type) return;
    switch (type.id) {
      case "reveal":
        game.showMeaningTimer = Math.max(game.showMeaningTimer, 3);
        addFloat("\u663e\u793a\u8bd1\u6587 3\u79d2", p.x - 42, p.y - 36, type.color);
        break;
      case "heal":
        p.hp = Math.min(p.maxHp, p.hp + 25);
        addFloat("+25 HP", p.x - 18, p.y - 36, type.color);
        break;
      case "invincible":
        p.invincibleBuff = 3;
        p.invuln = Math.max(p.invuln, 3);
        addFloat("\u65e0\u654c 3\u79d2", p.x - 34, p.y - 36, type.color);
        break;
      case "speed":
        p.speedBuff = 3;
        addFloat("\u52a0\u901f 3\u79d2", p.x - 34, p.y - 36, type.color);
        break;
      case "pierce":
        p.pierceBuff = 3;
        addFloat("\u7a7f\u900f 3\u79d2", p.x - 34, p.y - 36, type.color);
        break;
      case "hide":
        game.hideWordsTimer = Math.max(game.hideWordsTimer, 3);
        addFloat("\u5355\u8bcd\u9690\u85cf 3\u79d2", p.x - 42, p.y - 36, type.color);
        break;
      case "damage":
        p.hp = Math.max(1, p.hp - 16);
        addFloat("-16 HP", p.x - 18, p.y - 36, type.color);
        break;
      case "slowSelf":
        p.slowSelf = 3;
        addFloat("\u81ea\u5df1\u51cf\u901f 3\u79d2", p.x - 42, p.y - 36, type.color);
        break;
      case "slowEnemy":
        game.enemySlowTimer = Math.max(game.enemySlowTimer, 3);
        addFloat("\u654c\u4eba\u51cf\u901f 3\u79d2", p.x - 42, p.y - 36, type.color);
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
    const move = clamp(entity.moveAnim || 0, 0, 1);
    const t = entity.walkT || entity.pulse || 0;
    const step = Math.sin(t * Math.PI * 2);
    const hop = Math.abs(step) * 7 * move * strength + Math.sin(t * 2.1) * (1.2 + move) * strength;
    const lean = clamp((entity.animVx || 0) / 420, -0.16, 0.16) * strength;
    const facing = entity.facing ?? 0;
    const dirScaleY = facing === 3 ? 0.95 : facing === 0 ? 1.03 : 1;
    const dirScaleX = facing === 3 ? 0.98 : facing === 0 ? 1.03 : 1;
    const squash = 1 + Math.sin(t * Math.PI * 2 + Math.PI / 2) * 0.045 * move * strength;
    return {
      flipX: facing === 1,
      x: entity.x,
      y: entity.y - hop,
      w: baseW,
      h: baseH,
      rotate: lean,
      scaleX: dirScaleX * (entity.wrongSpeedTimer > 0 ? 1.05 : 1) * (1 / squash),
      scaleY: dirScaleY * squash,
      shadowScale: 1 - move * 0.12 + Math.abs(step) * move * 0.08
    };
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
    if (cols <= 1) return 0;
    const duration = spriteDef.duration || (action === "attack" ? 0.34 : action === "hurt" ? 0.28 : 0.25);
    const timer = action === "attack" ? (entity.attackAnim || 0) : action === "hurt" ? (entity.hurtAnim || entity.hitFlash || 0) : 0;
    const progress = clamp(1 - timer / Math.max(0.001, duration), 0, 0.999);
    const frameCols = spriteDef.frameCols || [...Array(cols).keys()];
    return frameCols[Math.floor(progress * frameCols.length)] ?? 0;
  }

  function drawAnimatedDirectionalSprite(img, spriteDef, action, entity, centerX, centerY, w, h, pose) {
    const cols = Math.max(1, spriteDef?.cols || 1);
    const rows = Math.max(1, spriteDef?.rows || 1);
    const frame = entityActionFrame(entity, spriteDef, action);
    if (cols > 1 || rows > 1) drawAnimatedAtlas(img, cols, rows, frame, centerX, centerY, w, h, pose);
    else drawAnimatedImageCover(img, centerX, centerY, w, h, pose);
  }


  function drawObstacles() {
    const img = images.themeObstacles;
    for (const ob of game.obstacles) {
      if (img) drawAtlas(img, 4, 2, ob.index, ob.x - ob.r - 12, ob.y - ob.r - 18, ob.r * 2 + 24, ob.r * 2 + 24);
      else { ctx.fillStyle = "rgba(70,70,70,.65)"; ctx.beginPath(); ctx.arc(ob.x, ob.y, ob.r, 0, Math.PI * 2); ctx.fill(); }
      if (ob.destructible) {
        ctx.strokeStyle = ob.hiddenEntry ? "rgba(142,243,255,.72)" : "rgba(255,255,255,.38)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(ob.x - 10, ob.y - 6); ctx.lineTo(ob.x + 8, ob.y + 2); ctx.lineTo(ob.x - 2, ob.y + 12); ctx.stroke();
        ctx.fillStyle = "rgba(10,12,16,.6)"; ctx.fillRect(ob.x - 18, ob.y + ob.r + 4, 36, 4); ctx.fillStyle = "#8ef3ff"; ctx.fillRect(ob.x - 18, ob.y + ob.r + 4, 36 * Math.max(0, ob.hp / 2), 4);
      }
    }
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
  }

  function exitGame() {
    returnToMenu();
    game.message = "\u5df2\u9000\u51fa\u6e38\u620f";
    window.close();
  }

  function selectedHero() {
    const fallback = HEROES[0] || makeHero({
      id: FALLBACK_HERO_ID,
      name: "默认英雄",
      sub: "",
      role: "英雄",
      tint: "#9fb8ff",
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
    game.selectedHeroId = hero.id;
    localStorage.setItem("wordRealmHero", hero.id);
    game.message = `已选择英雄：${hero.name} · ${hero.sub}，正在加载动作素材`;
    ensureHeroImages(hero).then(() => {
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
    game.message = "正在加载词库和英雄素材...";
    await Promise.all([ensureWordsLoaded(maxDifficulty), ensureHeroImages(selectedHero())]);
    game.difficulty = maxDifficulty;
    game.difficultyName = name;
    game.bank = game.words.filter(w => Number(w.difficulty) <= maxDifficulty);
    if (!game.bank.length) game.bank = [...game.words];
    game.room = 0;
    game.score = 0;
    game.combo = 0;
    game.correct = 0;
    game.wrong = 0;
    game.roomTime = 0;
    game.runTime = 0;
    game.showMeaningTimer = 0;
    game.hideWordsTimer = 0;
    game.enemySlowTimer = 0;
    game.runSeen = new Set();
    game.player = {
      x: W / 2, y: H - 128, r: 18, hp: 100, maxHp: 100, speed: 245, held: "",
      dashCd: 0, shield: 0, invuln: 0, facing: 0, walk: 0, footstepCd: 0, fireAnim: 0,
      dashAnim: 0, hurtAnim: 0,
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
    game.message = "正在读取存档和词库...";
    game.difficulty = Number(saved.difficulty) || game.difficulty;
    game.difficultyName = saved.difficultyName || game.difficultyName;
    await ensureWordsLoaded(game.difficulty);
    if (saved.hero && HEROES.some(hero => hero.id === saved.hero)) game.selectedHeroId = saved.hero;
    await ensureHeroImages(selectedHero());
    game.bank = game.words.filter(w => Number(w.difficulty) <= game.difficulty);
    if (!game.bank.length) game.bank = [...game.words];
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
    game.runSeen = new Set(Array.isArray(saved.seen) ? saved.seen : []);
    game.player = {
      x: W / 2, y: H - 128, r: 18, hp: 100, maxHp: 100, speed: 245, held: "",
      dashCd: 0, shield: 0, invuln: 0, facing: 0, walk: 0, footstepCd: 0, fireAnim: 0,
      dashAnim: 0, hurtAnim: 0,
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
    const theme = currentTheme(game.room);
    game.currentThemeIndex = themes.indexOf(theme);
    if (game.player) {
      const spawn = findNearestWalkablePoint(game.player.x, game.player.y, Math.max(10, game.player.r - 4), 260);
      if (spawn) {
        game.player.x = spawn.x;
        game.player.y = spawn.y;
      }
    }
    saveRun();

    if (isBossRoom(game.room)) {
      const bossWords = pickMany(game.bank, 8);
      bossWords.forEach(entry => game.runSeen.add(entry.word));
      if (theme.bomberman) {
        game.obstacles = [];
        game.bomberBlocks = buildBomberBlocks(bossWords, true);
        if (game.player) { const start = bomberCellCenter(Math.floor(BOMBER_GRID.cols / 2), BOMBER_GRID.rows - 3); game.player.x = start.x; game.player.y = start.y; }
      } else {
        game.obstacles = buildObstaclesForTheme(theme, bossWords, true);
      }
      buildBoss(theme, bossWords);
      const distractors = pickMany(game.bank.filter(w => w.meaning !== game.boss.entry.meaning), 3);
      [game.boss.entry, ...distractors].forEach((entry, idx) => {
        spawnTokenAt(entry, 250 + idx * 250, H - 78, entry.meaning === game.boss.entry.meaning ? 1.6 : 0);
      });
      spawnRoomVisiblePickups(VISIBLE_ROOM_PICKUPS + 1);
      game.message = `\u7b2c ${game.room} \u95f4\uff1a${theme.name} · \u5173\u5361 Boss`;
      return;
    }

    const count = Math.min(4 + Math.floor(game.room * 0.55), 11);
    const roomWords = pickMany(game.bank, count);
    if (theme.bomberman) {
      game.obstacles = [];
      game.bomberBlocks = buildBomberBlocks(roomWords, false);
      if (game.player) { const start = bomberCellCenter(Math.floor(BOMBER_GRID.cols / 2), BOMBER_GRID.rows - 3); game.player.x = start.x; game.player.y = start.y; }
    } else {
      game.obstacles = buildObstaclesForTheme(theme, roomWords, false);
    }
    spawnRoomVisiblePickups(VISIBLE_ROOM_PICKUPS);

    roomWords.forEach((entry, i) => {
      const edge = Math.floor(Math.random() * 4);
      const pos = separatedSpawn(edge, 82);
      const ai = monsterAiFor(i, game.room);
      const typeId = MONSTER_VARIANTS[(game.room + i) % MONSTER_VARIANTS.length];
      const spriteConfig = getMonsterTypeById(typeId) || MONSTER_TYPES[(game.room + i) % Math.max(1, MONSTER_TYPES.length)] || null;
      ensureMonsterTypeImages(spriteConfig);
      game.monsters.push({
        entry, x: pos.x, y: pos.y, r: 25, hp: 35 + game.room * 5, maxHp: 35 + game.room * 5,
        baseSpeed: 48 + i * 1.2, imageKey: null, kind: spriteConfig?.kindIndex ?? ((game.room + i) % 8),
        typeId: spriteConfig?.id || typeId, spriteConfig, action: "idle", attackAnim: 0, hurtAnim: 0,
        aiClass: ai.grade, aggroTiles: ai.aggroTiles, baseAggroTiles: ai.aggroTiles, wrongAggroTimer: 0, wrongSpeedTimer: 0,
        tileReady: false, tileTarget: null, turnCd: rand(0.2, 1.2), dir: pickMany(BOMBER_DIRS, 1)[0], hitFlash: 0
      });
      game.runSeen.add(entry.word);
    });

    const distractors = pickMany(game.bank.filter(w => !roomWords.includes(w)), Math.min(4, count));
    [...roomWords, ...distractors].forEach(entry => spawnToken(entry, roomWords.includes(entry) ? 1.6 : 0));
    game.message = `\u7b2c ${game.room} \u95f4\uff1a${theme.name}`;
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
    if (move.x || move.y) {
      p.walk += dt;
      p.footstepCd -= dt;
      if (p.footstepCd <= 0) { play("footstep", 0.18); p.footstepCd = 0.28; }
      const playerSpeed = effectivePlayerSpeed();
      const fromX = p.x, fromY = p.y;
      moveWithinWalkMask(p, p.x + move.x * playerSpeed * dt, p.y + move.y * playerSpeed * dt, Math.max(10, p.r - 4));
      resolveObstacleCollision(p, 8);
      resolveBomberBlockCollision(p, 8);
      resolvePlayerSoftBlocks();
      clampEntityToWalkMask(p, fromX, fromY, Math.max(10, p.r - 4));
      if (Math.abs(move.x) > Math.abs(move.y)) p.facing = move.x < 0 ? 1 : 2; else p.facing = move.y < 0 ? 3 : 0;
    } else {
      p.walk = 0; p.footstepCd = 0;
      const a = aimDir();
      if (Math.abs(a.x) > Math.abs(a.y)) p.facing = a.x < 0 ? 1 : 2; else p.facing = a.y < 0 ? 3 : 0;
    }

    p.dashCd = Math.max(0, p.dashCd - dt);
    p.shield = Math.max(0, p.shield - dt);
    p.invuln = Math.max(0, p.invuln - dt);
    p.fireAnim = Math.max(0, (p.fireAnim || 0) - dt);
    p.dashAnim = Math.max(0, (p.dashAnim || 0) - dt);
    p.hurtAnim = Math.max(0, (p.hurtAnim || 0) - dt);
    p.speedBuff = Math.max(0, p.speedBuff - dt);
    p.slowSelf = Math.max(0, p.slowSelf - dt);
    p.invincibleBuff = Math.max(0, p.invincibleBuff - dt);
    p.pierceBuff = Math.max(0, p.pierceBuff - dt);
    game.showMeaningTimer = Math.max(0, game.showMeaningTimer - dt);
    game.hideWordsTimer = Math.max(0, game.hideWordsTimer - dt);
    game.enemySlowTimer = Math.max(0, game.enemySlowTimer - dt);

    updateMonsters(dt);
    updateBoss(dt);
    updateProjectiles(dt);
    updateTokens(dt);
    updateCamera();
    updatePickups(dt);
    updateFloats(dt);

    updateDoor(dt);

    if (game.roomTime >= ROOM_TIME_LIMIT && game.mode === "playing") {
      p.hp = 0;
      game.message = "倒计时结束";
    }

    if (p.hp <= 0) {
      game.bestRoom = Math.max(game.bestRoom, game.room);
      localStorage.setItem("wordRealmBestRoom", String(game.bestRoom));
      saveRun();
      game.mode = "gameover";
      game.message = "\u63a2\u9669\u5931\u8d25\uff0c\u70b9\u51fb\u753b\u9762\u53ef\u56de\u5230\u83dc\u5355\u91cd\u65b0\u6311\u6218";
    }
  }

  function updateMonsters(dt) {
    const p = game.player;
    const scale = speedScale();
    const bomberMode = isBomberTheme();
    for (const m of game.monsters) {
      const fromX = m.x;
      const fromY = m.y;
      m.attackAnim = Math.max(0, (m.attackAnim || 0) - dt);
      m.hurtAnim = Math.max(0, (m.hurtAnim || 0) - dt);
      if (bomberMode) updateBomberMonster(m, dt, scale);
      else updateSmartMonster(m, dt, scale);
      updateMotionAnimation(m, dt, fromX, fromY, m.dir);
      m.hitFlash = Math.max(0, m.hitFlash - dt);
      if (dist(m, p) < m.r + p.r + 8 && p.invuln <= 0 && p.invincibleBuff <= 0) {
        const damage = p.shield > 0 ? 4 : 12;
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
      b.attackCd = b.info.basicCd;
    }
    if (b.patternCd <= 0) {
      shootBossPattern(b);
      b.action = "attack";
      b.patternCd = b.info.skillCd;
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

      let hitObstacle = false;
      for (const ob of [...game.obstacles]) {
        if (dist(pr, ob) > ob.r + (pr.radius || 10)) continue;
        hitObstacle = true;
        if (ob.destructible) {
          ob.hp -= 1;
          addFloat("石块受击", ob.x - 18, ob.y - ob.r - 10, "#d6f2ff");
          if (ob.hp <= 0) { revealHiddenEntry(ob); game.obstacles = game.obstacles.filter(o => o !== ob); }
        }
        if (pr.pierce > 0) pr.pierce -= 1;
        else {
          returnProjectileMeaning(pr, ob.x, ob.y + ob.r + 18, 1.0);
          pr.life = 0;
        }
        break;
      }
      if (hitObstacle || pr.life <= 0) continue;

      if (game.boss && dist(pr, game.boss) <= game.boss.r + (pr.radius || 10)) {
        const b = game.boss;
        if (pr.meaning === b.entry.meaning) {
          const damage = pr.damage || 60;
          b.hp -= damage;
          b.hitFlash = 0.22;
          b.hurtAnim = 0.32;
          game.combo += 1;
          game.correct += 1;
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
          game.score = Math.max(0, game.score - 42);
          returnProjectileMeaning(pr, b.x, b.y + b.r + 28, 1.1);
          addFloat("错配", b.x - 18, b.y - 88, "#ffb3a5");
          play("wrong");
          pr.life = 0;
        }
        continue;
      }

      for (const m of game.monsters) {
        if (m.dead || dist(pr, m) > m.r + (pr.radius || 10)) continue;
        if (pr.meaning === m.entry.meaning) {
          m.hp = 0;
          m.hitFlash = 0.18;
          m.hurtAnim = 0.28;
          game.combo += 1;
          game.correct += 1;
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
          game.score = Math.max(0, game.score - 35);
          triggerWrongHitAggro(m);
          m.hurtAnim = 0.24;
          returnProjectileMeaning(pr, m.x, m.y + m.r + 28, 1.1);
          addFloat("错配", m.x - 18, m.y - 42, "#ffb3a5");
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

  function aimDir() {
    if (game.touchAim.active || Math.abs(game.touchAim.x) + Math.abs(game.touchAim.y) > 0.1) {
      return norm(game.touchAim);
    }
    return norm({ x: game.mouse.x - game.player.x, y: game.mouse.y - game.player.y });
  }

  function fire(target = null) {
    if (game.mode !== "playing" || !game.player.held) return;
    const p = game.player;
    const d = target ? norm({ x: target.x - p.x, y: target.y - p.y }) : aimDir();
    if (!d.x && !d.y) return;
    if (Math.abs(d.x) > Math.abs(d.y)) p.facing = d.x < 0 ? 1 : 2;
    else p.facing = d.y < 0 ? 3 : 0;
    const hero = selectedHero();
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
      p.fireAnim = 0.34;
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
      life: isBomberTheme() ? 2.6 : 1.4
    });
    p.held = "";
    p.fireAnim = 0.34;
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

  function tokenAt(pos) {
    let best = null;
    let bestDist = 58;
    for (const t of game.tokens) {
      const d = dist(pos, t);
      if (d < bestDist) {
        best = t;
        bestDist = d;
      }
    }
    return best;
  }

  function tapToken(pos) {
    if (game.mode !== "playing") return false;
    const token = tokenAt(pos);
    if (!token) return false;
    const p = game.player;
    if (dist(p, token) > 92) {
      token.glow = 0.8;
      addFloat("\u9760\u8fd1\u540e\u62fe\u53d6", token.x - 36, token.y - 34, "#fff0a0");
      return true;
    }
    collectToken(token);
    return true;
  }

  function dash() {
    if (game.mode !== "playing" || game.player.dashCd > 0) return;
    const p = game.player;
    let d = norm({ x: game.touchMove.x, y: game.touchMove.y });
    if (!d.x && !d.y) {
      d = {
        x: (game.keys.has("KeyD") || game.keys.has("ArrowRight") ? 1 : 0) - (game.keys.has("KeyA") || game.keys.has("ArrowLeft") ? 1 : 0),
        y: (game.keys.has("KeyS") || game.keys.has("ArrowDown") ? 1 : 0) - (game.keys.has("KeyW") || game.keys.has("ArrowUp") ? 1 : 0)
      };
      d = norm(d);
    }
    if (!d.x && !d.y) d = aimDir();
    const fromX = p.x, fromY = p.y;
    const dashed = dashThroughPath(p, d, 135, Math.max(10, p.r - 4));
    resolveObstacleCollision(p, 12);
    resolveBomberBlockCollision(p, 12);
    clampEntityToWalkMask(p, fromX, fromY, Math.max(10, p.r - 4));
    if (!dashed) addFloat("墙体阻挡", p.x - 22, p.y - 36, "#d6f2ff");
    p.dashCd = 1.1;
    p.invuln = 0.35;
    p.dashAnim = 0.28;
    play("dash");
  }

  function shield() {
    if (game.mode !== "playing") return;
    game.player.shield = Math.max(game.player.shield, 5);
    addFloat("护盾", game.player.x - 18, game.player.y - 36, "#91d9ff");
  }


  function updateTouchButtonLabels() {
    const p = game.player;
    const fireButton = document.querySelector('[data-action="fire"]');
    if (fireButton) {
      const label = p?.held ? String(p.held).slice(0, 6) : "发射";
      fireButton.textContent = label;
      fireButton.title = p?.held ? `发射：${p.held}` : "发射";
    }
    const dashButton = document.querySelector('[data-action="dash"]');
    if (dashButton) {
      dashButton.textContent = p?.dashCd > 0 ? `闪${p.dashCd.toFixed(1)}` : "闪避";
      dashButton.title = p?.dashCd > 0 ? `闪现冷却 ${p.dashCd.toFixed(1)} 秒` : "闪避";
    }
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
    center("词域探险", 250);
    ctx.fillStyle = "#b8ead2";
    ctx.font = "700 20px Microsoft YaHei UI";
    center(game.message || "正在加载...", 314);
    const t = performance.now() / 600;
    const w = 360;
    ctx.fillStyle = "rgba(255,255,255,.1)";
    roundRectRaw(W / 2 - w / 2, 350, w, 10, 5);
    ctx.fill();
    ctx.fillStyle = "rgba(143,255,194,.78)";
    roundRectRaw(W / 2 - w / 2, 350, (0.25 + (Math.sin(t) + 1) * 0.35) * w, 10, 5);
    ctx.fill();
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
    arena.addColorStop(0, "#355b3a");
    arena.addColorStop(0.42, "#456f43");
    arena.addColorStop(1, "#253f36");
    ctx.fillStyle = arena;
    ctx.fillRect(g.x, g.y, g.cols * g.tile, g.rows * g.tile);

    const path = ctx.createLinearGradient(g.x, g.y, g.x, g.y + g.rows * g.tile);
    path.addColorStop(0, "rgba(205,190,139,.18)");
    path.addColorStop(1, "rgba(58,73,55,.16)");
    ctx.fillStyle = path;
    for (let row = 0; row < g.rows; row++) {
      for (let col = 0; col < g.cols; col++) {
        const x = g.x + col * g.tile;
        const y = g.y + row * g.tile;
        if ((row + col) % 2 === 0) ctx.fillRect(x + 1, y + 1, g.tile - 2, g.tile - 2);
        if (((row * 17 + col * 31) % 19) === 0) {
          ctx.fillStyle = "rgba(214,236,166,.18)";
          ctx.fillRect(x + g.tile * 0.62, y + g.tile * 0.28, 9, 2);
          ctx.fillRect(x + g.tile * 0.66, y + g.tile * 0.32, 2, 8);
          ctx.fillStyle = path;
        }
      }
    }

    ctx.strokeStyle = "rgba(214,234,204,.08)";
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

    ctx.strokeStyle = "rgba(225,240,214,.28)";
    ctx.lineWidth = 3;
    ctx.strokeRect(g.x - 2, g.y - 2, g.cols * g.tile + 4, g.rows * g.tile + 4);

    const vignette = ctx.createRadialGradient(ww / 2, wh / 2, 120, ww / 2, wh / 2, Math.max(ww, wh) * 0.58);
    vignette.addColorStop(0, "rgba(255,255,255,0)");
    vignette.addColorStop(1, "rgba(4,13,15,.28)");
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
        grad.addColorStop(0, "#dae7d2");
        grad.addColorStop(0.46, "#9faf95");
        grad.addColorStop(1, "#647764");
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, w, h);

        ctx.fillStyle = "rgba(255,255,255,.16)";
        ctx.fillRect(x + 5, y + 5, w - 10, 3);
        ctx.fillStyle = "rgba(39,62,43,.18)";
        ctx.fillRect(x + 7, y + h - 9, w - 14, 4);
        ctx.strokeStyle = "rgba(36,52,43,.42)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x + w * 0.2, y + h * 0.28);
        ctx.lineTo(x + w * 0.34, y + h * 0.36);
        ctx.lineTo(x + w * 0.27, y + h * 0.52);
        ctx.moveTo(x + w * 0.62, y + h * 0.22);
        ctx.lineTo(x + w * 0.74, y + h * 0.38);
        ctx.stroke();

        ctx.strokeStyle = "rgba(16,26,22,.74)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        if (!sameL) { ctx.moveTo(x + 0.5, y); ctx.lineTo(x + 0.5, y + h); }
        if (!sameR) { ctx.moveTo(x + w - 0.5, y); ctx.lineTo(x + w - 0.5, y + h); }
        if (!sameU) { ctx.moveTo(x, y + 0.5); ctx.lineTo(x + w, y + 0.5); }
        if (!sameD) { ctx.moveTo(x, y + h - 0.5); ctx.lineTo(x + w, y + h - 0.5); }
        ctx.stroke();
      } else {
        const grad = ctx.createLinearGradient(x, y, x, y + h);
        grad.addColorStop(0, "#c99f75");
        grad.addColorStop(0.55, "#a36f4f");
        grad.addColorStop(1, "#704b3e");
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, w, h);

        // 三层砖墙纹理：每格内部做三层错缝、砂浆线、高光和细裂纹，仍限制在单格内
        const inset = 4;
        const innerX = x + inset;
        const innerY = y + inset;
        const innerW = w - inset * 2;
        const innerH = h - inset * 2;
        const row1Y = innerY + innerH / 3;
        const row2Y = innerY + innerH * 2 / 3;
        const topX = innerX + innerW * 0.5;
        const midX1 = innerX + innerW / 3;
        const midX2 = innerX + innerW * 2 / 3;
        const botX = innerX + innerW * 0.5;

        // 砖面轻微颗粒感
        ctx.fillStyle = "rgba(255,244,235,.08)";
        ctx.fillRect(innerX + 3, innerY + 2, innerW - 6, 2);
        ctx.fillRect(innerX + 5, row1Y + 2, innerW - 10, 1.5);
        ctx.fillRect(innerX + 4, row2Y + 2, innerW - 8, 1.5);
        ctx.fillStyle = "rgba(255,222,198,.08)";
        ctx.fillRect(innerX + 5, innerY + innerH - 7, innerW - 10, 2);

        // 主砂浆线（三层）
        ctx.strokeStyle = "rgba(44,30,24,.72)";
        ctx.lineWidth = 1.9;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(innerX, row1Y);
        ctx.lineTo(innerX + innerW, row1Y);
        ctx.moveTo(innerX, row2Y);
        ctx.lineTo(innerX + innerW, row2Y);
        ctx.moveTo(topX, innerY);
        ctx.lineTo(topX, row1Y - 1);
        ctx.moveTo(midX1, row1Y + 1);
        ctx.lineTo(midX1, row2Y - 1);
        ctx.moveTo(midX2, row1Y + 1);
        ctx.lineTo(midX2, row2Y - 1);
        ctx.moveTo(botX, row2Y + 1);
        ctx.lineTo(botX, innerY + innerH);
        ctx.stroke();

        // 辅助砖缝短线，增加三层纹理复杂度
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.moveTo(innerX + 5, innerY + innerH * 0.16);
        ctx.lineTo(topX - 6, innerY + innerH * 0.16);
        ctx.moveTo(topX + 6, innerY + innerH * 0.16);
        ctx.lineTo(innerX + innerW - 5, innerY + innerH * 0.16);

        ctx.moveTo(innerX + 4, innerY + innerH * 0.50);
        ctx.lineTo(midX1 - 5, innerY + innerH * 0.50);
        ctx.moveTo(midX1 + 5, innerY + innerH * 0.50);
        ctx.lineTo(midX2 - 5, innerY + innerH * 0.50);
        ctx.moveTo(midX2 + 5, innerY + innerH * 0.50);
        ctx.lineTo(innerX + innerW - 4, innerY + innerH * 0.50);

        ctx.moveTo(innerX + 5, innerY + innerH * 0.84);
        ctx.lineTo(botX - 6, innerY + innerH * 0.84);
        ctx.moveTo(botX + 6, innerY + innerH * 0.84);
        ctx.lineTo(innerX + innerW - 5, innerY + innerH * 0.84);
        ctx.stroke();

        // 细裂纹/切痕，限制在格子内部
        ctx.strokeStyle = "rgba(92,42,28,.38)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(innerX + innerW * 0.16, innerY + 6);
        ctx.lineTo(innerX + innerW * 0.22, innerY + 11);
        ctx.lineTo(innerX + innerW * 0.14, innerY + 17);
        ctx.moveTo(innerX + innerW * 0.74, row1Y + 4);
        ctx.lineTo(innerX + innerW * 0.80, row1Y + 10);
        ctx.lineTo(innerX + innerW * 0.73, row1Y + 16);
        ctx.moveTo(innerX + innerW * 0.36, row2Y + 4);
        ctx.lineTo(innerX + innerW * 0.31, row2Y + 11);
        ctx.stroke();

        // 三层高光与阴影
        ctx.strokeStyle = "rgba(255,248,240,.34)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(innerX + 1, innerY + 1);
        ctx.lineTo(innerX + innerW - 1, innerY + 1);
        ctx.moveTo(innerX + 1, row1Y + 1);
        ctx.lineTo(innerX + innerW - 1, row1Y + 1);
        ctx.moveTo(innerX + 1, row2Y + 1);
        ctx.lineTo(innerX + innerW - 1, row2Y + 1);
        ctx.stroke();
        ctx.strokeStyle = "rgba(0,0,0,.18)";
        ctx.beginPath();
        ctx.moveTo(innerX + 1, innerY + innerH - 1);
        ctx.lineTo(innerX + innerW - 1, innerY + innerH - 1);
        ctx.moveTo(innerX + innerW - 1, innerY + 1);
        ctx.lineTo(innerX + innerW - 1, innerY + innerH - 1);
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
    if (theme.bomberman) {
      const cam = updateCamera();
      ctx.save();
      ctx.translate(-cam.x, -cam.y);
      drawBombermanMap(theme);
      drawObstacles();
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
    } else {
      const bg = images[`bg${theme.bg}`] || images.bg0;
      if (bg) ctx.drawImage(bg, 0, 0, W, H); else { ctx.fillStyle = "#17222b"; ctx.fillRect(0, 0, W, H); }
      ctx.fillStyle = "rgba(0,0,0,.12)";
      for (let x = 0; x < W; x += 80) ctx.fillRect(x, 58, 2, H - 58);
      for (let y = 80; y < H; y += 80) ctx.fillRect(0, y, W, 2);
      drawObstacles();
      drawBomberBlocks();
      drawDoor();
      for (const t of game.tokens) drawToken(t);
      for (const item of game.pickups) drawPickup(item);
      for (const pr of game.projectiles) drawProjectile(pr);
      for (const m of game.monsters) drawMonster(m);
      if (game.boss) drawBoss(game.boss);
      drawPlayer();
      drawFloats();
    }
    drawHud();
    if (game.boss) drawBossBar(game.boss);
    if (game.mode === "playing" && game.settings.crosshair) drawCrosshair();
    drawRestartButton();
    drawSettingsButton();
  }

  function drawRestartButton() {
    return;
  }


  function actionFrameCol(actionName, cfg, p) {
    const cols = Math.max(1, cfg.cols || 1);
    if (actionName === "walk") {
      const walkCols = cfg.walkCols || [0, 1, 2, 3].filter(c => c < cols);
      if (!p.walk) return clamp(cfg.idleCol ?? 0, 0, cols - 1);
      return walkCols[Math.floor(p.walk * 10) % Math.max(1, walkCols.length)] ?? 0;
    }
    const frameCols = cfg.frameCols || [...Array(cols).keys()];
    if (cols <= 1) return clamp(cfg.col ?? 0, 0, cols - 1);
    const timer = actionName === "hurt" ? (p.hurtAnim || 0) : actionName === "dash" ? (p.dashAnim || 0) : (p.fireAnim || 0);
    const duration = cfg.duration || (actionName === "hurt" ? 0.38 : actionName === "dash" ? 0.28 : 0.34);
    const progress = clamp(1 - timer / duration, 0, 0.999);
    return frameCols[Math.floor(progress * frameCols.length)] ?? 0;
  }

  function currentHeroAction(hero, p) {
    const actions = hero.actions || null;
    if (!actions) return null;
    let actionName = "walk";
    if ((p.hurtAnim || 0) > 0 && actions.hurt) actionName = "hurt";
    else if ((p.dashAnim || 0) > 0 && actions.dash) actionName = "dash";
    else if ((p.fireAnim || 0) > 0 && actions.attack) actionName = "attack";
    else if ((p.walk || 0) <= 0 && actions.idle) actionName = "idle";
    const cfg = actions[actionName] || actions.walk || actions.idle;
    if (!cfg) return null;
    const img = images[cfg.imageKey] || images[hero.imageKey];
    if (!img) return null;
    const cols = Math.max(1, cfg.cols || 1);
    const rows = Math.max(1, cfg.rows || 1);

    // 方向触发规则：
    // 内部 facing 顺序是 [前, 左, 右, 后] = [0,1,2,3]
    // 你的素材帧/行顺序是 [前, 右, 左, 后]
    // 所以映射必须是 [0,2,1,3]。
    const rowByFacing = cfg.rowByFacing || hero.rowByFacing || [0, 2, 1, 3];
    const facing = clamp(p.facing ?? 0, 0, 3) | 0;
    const row = clamp(rowByFacing[facing] ?? facing, 0, rows - 1);

    // 默认不再镜像左方向。左/右方向都使用素材里的独立帧。
    // 只有显式写 useMirrorLeft: true 时，才允许复用右方向镜像。
    const flipX = !!((cfg.useMirrorLeft || hero.useMirrorLeft) && facing === 1);

    const col = clamp(actionFrameCol(actionName, cfg, p), 0, cols - 1);
    return {
      img,
      cols,
      rows,
      index: row * cols + col,
      flipX,
      frameHeight: cfg.frameHeight || hero.frameHeight || 96
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
      const img = images[hero.imageKey] || images.heroGun || images.hero;
      if (img) {
        const cols = hero.atlasCols || 8;
        const rows = hero.atlasRows || 4;
        const frameRows = hero.frameRows || [0, 1, 2, 3];
        const walkCols = hero.walkCols || [1, 2, 3, 4];
        let row = frameRows[p.facing] ?? p.facing;
        const flipX = !!(hero.useMirrorLeft && p.facing === 1);
        if (flipX && hero.frameRows) row = hero.frameRows[2] ?? row;
        const col = p.fireAnim > 0 ? (hero.fireCol ?? Math.min(cols - 1, 6)) : (p.walk > 0 ? walkCols[Math.floor(p.walk * 10) % walkCols.length] : (hero.idleCol ?? 0));
        const index = row * cols + col;
        if (hero.anchorFeet) drawAtlasAnchored(img, hero, cols, rows, index, p.x, p.y + 30, hero.frameHeight || 84, flipX);
        else if (flipX) drawAtlas(img, cols, rows, index, p.x - 40, p.y - 58, 80, 88, true);
        else drawAtlas(img, cols, rows, index, p.x - 40, p.y - 58, 80, 88);
      } else {
        ctx.fillStyle = hero.tint || "#9fb8ff";
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
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
    const showWord = game.hideWordsTimer > 0 ? "???" : m.entry.word; ctx.font = "700 16px Segoe UI"; const w = ctx.measureText(showWord).width;
    ctx.fillStyle = "rgba(16,20,26,.82)"; roundRectRaw(m.x - w / 2 - 8, m.y - 62, w + 16, 25, 7); ctx.fill(); ctx.fillStyle = "#fff096"; ctx.fillText(showWord, m.x - w / 2, m.y - 44);
    if (game.showMeaningTimer > 0 && game.hideWordsTimer <= 0) { const meaning = m.entry.meaning || ""; ctx.font = "13px Microsoft YaHei UI"; const mw = ctx.measureText(meaning).width; ctx.fillStyle = "rgba(12,18,22,.78)"; roundRectRaw(m.x - mw / 2 - 8, m.y - 86, mw + 16, 20, 6); ctx.fill(); ctx.fillStyle = "#c8f6ff"; ctx.fillText(meaning, m.x - mw / 2, m.y - 71); }
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
      drawAnimatedDirectionalSprite(spriteImg, spriteDef, action, b, pose.x, pose.y - 12 + Math.sin(b.pulse * 2) * 3, render.w, render.h, pose);
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
    drawHeadHpBar(b.x, b.y - 176, 118, b.hp / b.maxHp, b.info.color, `${b.info.name} ${Math.max(0, Math.floor(b.hp))}/${b.maxHp}`);
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
    if (p.attackType === "orb") { ctx.translate(p.x, p.y); ctx.rotate(angle); ctx.shadowColor = "rgba(255,117,224,.95)"; ctx.shadowBlur = 12; for (let i = 0; i < 8; i++) { ctx.save(); ctx.rotate((Math.PI * 2 / 8) * i + performance.now() / 520); const petal = ctx.createRadialGradient(r * 0.55, 0, 1, r * 0.9, 0, r * 1.25); petal.addColorStop(0, "rgba(255,255,255,.96)"); petal.addColorStop(0.45, "rgba(255,143,226,.9)"); petal.addColorStop(1, "rgba(201,54,180,.35)"); ctx.fillStyle = petal; ctx.beginPath(); ctx.ellipse(r * 0.86, 0, r * 0.42, r * 0.18, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore(); } ctx.fillStyle = "#fff7b8"; ctx.beginPath(); ctx.arc(0, 0, r * 0.42, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = "rgba(255,214,250,.92)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, r * 1.16, 0, Math.PI * 2); ctx.stroke(); ctx.restore(); return; }
    if (p.attackType === "cannon") { ctx.translate(p.x, p.y); ctx.rotate(angle); ctx.shadowColor = "rgba(255,188,69,.9)"; ctx.shadowBlur = 10; const body = ctx.createLinearGradient(-r * 1.2, -r * 0.65, r * 1.4, r * 0.65); body.addColorStop(0, "#5a3820"); body.addColorStop(0.35, "#f3a63c"); body.addColorStop(0.7, "#ffdf7a"); body.addColorStop(1, "#6b3f20"); ctx.fillStyle = "rgba(255,130,32,.28)"; ctx.beginPath(); ctx.moveTo(-r * 2.7, 0); ctx.lineTo(-r * 1.15, -r * 0.52); ctx.lineTo(-r * 1.15, r * 0.52); ctx.closePath(); ctx.fill(); ctx.fillStyle = body; ctx.strokeStyle = "rgba(66,40,14,.95)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(r * 1.55, 0); ctx.quadraticCurveTo(r * 0.95, -r * 0.82, -r * 1.05, -r * 0.68); ctx.lineTo(-r * 1.42, 0); ctx.lineTo(-r * 1.05, r * 0.68); ctx.quadraticCurveTo(r * 0.95, r * 0.82, r * 1.55, 0); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.fillStyle = "#3b2b1c"; ctx.fillRect(-r * 0.45, -r * 0.58, r * 0.18, r * 1.16); ctx.restore(); return; }
    if (p.attackType === "ice") { ctx.translate(p.x, p.y); ctx.rotate(angle); ctx.fillStyle = color; ctx.strokeStyle = "rgba(214,248,255,.92)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(r * 1.55, 0); ctx.lineTo(0, -r); ctx.lineTo(-r * 1.15, 0); ctx.lineTo(0, r); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.globalAlpha = 0.28; ctx.fillRect(-r * 2.2, -2, r * 2.1, 4); ctx.restore(); return; }
    if (p.attackType === "deer") { ctx.translate(p.x, p.y); ctx.rotate(angle); ctx.shadowColor = "rgba(143,240,231,.95)"; ctx.shadowBlur = 14; ctx.fillStyle = "rgba(143,240,231,.3)"; ctx.beginPath(); ctx.ellipse(-r * 0.65, 0, r * 0.8, r * 0.34, 0, 0, Math.PI * 2); ctx.fill(); const leaf = ctx.createLinearGradient(-r * 0.5, -r, r * 1.2, r); leaf.addColorStop(0, "rgba(255,255,255,.98)"); leaf.addColorStop(0.45, color); leaf.addColorStop(1, "rgba(105,202,180,.22)"); ctx.fillStyle = leaf; ctx.beginPath(); ctx.moveTo(r * 1.35, 0); ctx.quadraticCurveTo(r * 0.18, -r * 0.95, -r * 0.75, 0); ctx.quadraticCurveTo(r * 0.18, r * 0.95, r * 1.35, 0); ctx.fill(); ctx.strokeStyle = "rgba(207,255,248,.92)"; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.moveTo(-r * 0.15, 0); ctx.lineTo(r * 0.95, 0); ctx.moveTo(r * 0.1, -r * 0.18); ctx.quadraticCurveTo(r * 0.32, -r * 0.72, r * 0.64, -r * 0.48); ctx.moveTo(r * 0.1, r * 0.18); ctx.quadraticCurveTo(r * 0.32, r * 0.72, r * 0.64, r * 0.48); ctx.stroke(); ctx.fillStyle = "#f8fff5"; ctx.beginPath(); ctx.arc(-r * 0.18, 0, r * 0.22, 0, Math.PI * 2); ctx.fill(); ctx.restore(); return; }
    if (p.attackType === "water") { const gradient = ctx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.35, 2, p.x, p.y, r * 1.55); gradient.addColorStop(0, "rgba(255,255,255,.95)"); gradient.addColorStop(0.45, color); gradient.addColorStop(1, "rgba(82,177,255,.18)"); ctx.fillStyle = gradient; ctx.beginPath(); ctx.arc(p.x, p.y, r * 1.18, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = "rgba(180,244,255,.78)"; ctx.lineWidth = 2; ctx.stroke(); ctx.globalAlpha = 0.34; ctx.fillStyle = color; ctx.beginPath(); ctx.arc(p.x - p.vx * 0.018, p.y - p.vy * 0.018, r * 0.48, 0, Math.PI * 2); ctx.fill(); ctx.restore(); return; }
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = "rgba(80,55,8,.8)"; ctx.stroke(); ctx.restore();
  }

  function drawHud() {
    if (!(game.mode === "playing" || game.mode === "paused")) return;

    const remain = Math.max(0, Math.ceil(ROOM_TIME_LIMIT - game.roomTime));
    const mm = String(Math.floor(remain / 60)).padStart(2, "0");
    const ss = String(remain % 60).padStart(2, "0");
    const panels = [
      { label: `第 ${game.room} 关`, w: 104 },
      { label: `倒计时 ${mm}:${ss}`, w: 142 },
      { label: `剩余怪物 ${remainingEnemyCount()}`, w: 136 },
      { label: `命中率 ${accuracy()}`, w: 126 },
      { label: `错误率 ${errorRate()}`, w: 126 },
      { label: `得分 ${game.score}`, w: 132 }
    ];

    let x = 18;
    const top = 14;
    ctx.font = "700 14px Microsoft YaHei UI";
    for (const item of panels) {
      const grad = ctx.createLinearGradient(x, top, x + item.w, top + 36);
      grad.addColorStop(0, "rgba(4,26,40,.82)");
      grad.addColorStop(1, "rgba(9,63,79,.56)");
      roundRect(x, top, item.w, 36, 12, grad, "rgba(103,232,255,.32)", 1.2);
      ctx.fillStyle = "#eaffff";
      textCenter(item.label, x + item.w / 2, top + 24);
      x += item.w + 10;
    }
  }

  function drawBossBar(b) {
    return;
  }


  function heroMenuCard(i) {
    const cols = Math.min(5, HEROES.length);
    const row = Math.floor(i / cols);
    const col = i % cols;
    const inRow = Math.min(cols, HEROES.length - row * cols);
    const gap = 150;
    const w = 144;
    const h = 82;
    const rowWidth = inRow * gap - 6;
    return {
      x: W / 2 - rowWidth / 2 + col * gap,
      y: 196 + row * 94,
      w,
      h
    };
  }

  function drawMenu() {
    const previewBg = images.bg0 || images.bg1;
    if (previewBg) {
      ctx.drawImage(previewBg, 0, 0, W, H);
      ctx.fillStyle = "rgba(4,12,18,.72)";
      ctx.fillRect(0, 0, W, H);
    } else {
      const bg = ctx.createLinearGradient(0, 0, W, H);
      bg.addColorStop(0, "#081719");
      bg.addColorStop(0.48, "#12241e");
      bg.addColorStop(1, "#061018");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
    }

    const glow = ctx.createRadialGradient(W / 2, 150, 10, W / 2, 150, 460);
    glow.addColorStop(0, "rgba(156,226,189,.18)");
    glow.addColorStop(1, "rgba(156,226,189,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = "rgba(180,234,213,.07)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= W; x += 48) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y <= H; y += 48) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

    ctx.fillStyle = "#effdff";
    ctx.font = "800 52px Microsoft YaHei UI";
    center("词域探险", 94);
    ctx.fillStyle = "#d7f3df";
    ctx.font = "700 20px Microsoft YaHei UI";
    center("选择角色 / 皮肤", 178);

    HEROES.forEach((hero, i) => {
      const card = heroMenuCard(i);
      const { x, y } = card;
      const selected = game.selectedHeroId === hero.id;
      const fill = selected ? "rgba(35,91,68,.76)" : "rgba(11,24,28,.58)";
      const stroke = selected ? "rgba(179,255,194,.86)" : "rgba(181,223,198,.18)";
      roundRect(x, y, card.w, card.h, 12, fill, stroke, selected ? 2.5 : 1);
      ctx.fillStyle = selected ? "rgba(255,226,139,.5)" : "rgba(179,255,194,.16)";
      ctx.fillRect(x + 8, y + 8, 4, card.h - 16);
      ensureHeroPreview(hero);
      const previewAction = hero.actions?.idle || hero.actions?.walk;
      const img = images[previewAction?.imageKey || hero.imageKey] || images[hero.imageKey];
      if (img) {
        if (previewAction) drawAtlas(img, previewAction.cols || 1, previewAction.rows || 4, previewAction.previewIndex || 0, x + 8, y + 9, 50, 60);
        else if (hero.imageMode === "single") drawImageCover(img, x + 12, y + 12, 46, 54);
      } else {
        ctx.fillStyle = "rgba(255,255,255,.08)";
        roundRectRaw(x + 8, y + 9, 50, 60, 8);
        ctx.fill();
        ctx.fillStyle = "#9fb8a9";
        ctx.font = "10px Microsoft YaHei UI";
        ctx.fillText("加载中", x + 16, y + 43);
      }
      ctx.fillStyle = selected ? "#ffffff" : "#d9f7ff";
      ctx.font = "700 17px Microsoft YaHei UI";
      ctx.fillText(hero.name, x + 62, y + 28);
      ctx.fillStyle = selected ? "#d9ffcf" : "#b8d0bf";
      ctx.font = "12px Microsoft YaHei UI";
      ctx.fillText(hero.sub, x + 62, y + 49);
      ctx.fillStyle = "#91a99d";
      ctx.font = "10px Microsoft YaHei UI";
      ctx.fillText(hero.attack, x + 62, y + 68);
    });

    const cards = [{ name: "简单", sub: "高中词汇", d: 2, x: 260 }, { name: "普通", sub: "四六级词汇", d: 4, x: 510 }, { name: "困难", sub: "雅思词汇", d: 6, x: 760 }];
    for (const card of cards) {
      const selected = game.difficulty === card.d;
      roundRect(card.x, 426, 220, 105, 14, selected ? "rgba(39,115,76,.78)" : "rgba(11,24,28,.58)", selected ? "rgba(190,255,189,.84)" : "rgba(181,223,198,.18)", selected ? 2.5 : 1);
      ctx.fillStyle = "#fff";
      ctx.font = "700 34px Microsoft YaHei UI";
      textCenter(card.name, card.x + 110, 468);
      ctx.fillStyle = selected ? "#c5ffe0" : "#cfe7ef";
      ctx.font = "18px Microsoft YaHei UI";
      textCenter(card.sub, card.x + 110, 504);
    }

    const saved = loadSave();
    if (saved) {
      roundRect(350, 570, 270, 56, 14, "rgba(48,134,89,.84)", "rgba(194,255,184,.68)", 1.5);
      roundRect(660, 570, 270, 56, 14, "rgba(44,89,122,.84)", "rgba(151,222,255,.64)", 1.5);
      ctx.fillStyle = "#f6fffb";
      ctx.font = "700 22px Microsoft YaHei UI";
      textCenter("新游戏", 485, 605);
      textCenter(`继续第 ${saved.room} 间`, 795, 605);
    } else {
      roundRect(495, 570, 290, 56, 14, "rgba(48,134,89,.84)", "rgba(194,255,184,.68)", 1.5);
      ctx.fillStyle = "#f6fffb";
      ctx.font = "700 24px Microsoft YaHei UI";
      textCenter("开始游戏", 640, 606);
    }
    ctx.fillStyle = "#8daab8";
    ctx.font = "13px Microsoft YaHei UI";
    center(`最佳关卡：${game.bestRoom || 0} · H切换英雄 · 空格闪现`, 668);
  }

  function drawPanel(title, body) {
    ctx.fillStyle = "rgba(2,8,14,.66)";
    ctx.fillRect(0, 0, W, H);
    const g = ctx.createLinearGradient(W / 2 - 250, H / 2 - 118, W / 2 + 250, H / 2 + 118);
    g.addColorStop(0, "rgba(8,34,52,.82)");
    g.addColorStop(0.5, "rgba(11,20,32,.88)");
    g.addColorStop(1, "rgba(4,45,62,.82)");
    roundRect(W / 2 - 250, H / 2 - 118, 500, 236, 18, g, "rgba(91,226,255,.38)", 1.5);
    ctx.strokeStyle = "rgba(91,226,255,.32)";
    ctx.lineWidth = 2;
    ctx.strokeRect(W / 2 - 224, H / 2 - 92, 448, 184);
    ctx.fillStyle = "#eaffff";
    ctx.font = "700 38px Microsoft YaHei UI";
    textCenter(title, W / 2, H / 2 - 34);
    ctx.font = "18px Microsoft YaHei UI";
    ctx.fillStyle = "#bdefff";
    textCenter(body, W / 2, H / 2 + 34);
  }

  function drawSettingsButton() {
    const hero = selectedHero();
    const img = images[hero.imageKey] || images.heroGun || images.hero;
    const x = W - 72;
    const y = 16;
    const size = 54;
    const cx = x + size / 2;
    const cy = y + size / 2;

    ctx.save();
    ctx.shadowColor = "rgba(69,224,255,.46)";
    ctx.shadowBlur = 12;
    ctx.fillStyle = "rgba(5,18,29,.72)";
    ctx.beginPath();
    ctx.arc(cx, cy, size / 2 + 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = "#22303a";
    ctx.fillRect(x, y, size, size);
    if (img) {
      if (hero.imageMode === "single") drawImageCover(img, x + 3, y + 3, size - 6, size - 6);
      else drawAtlas(img, hero.atlasCols || 8, hero.atlasRows || 4, hero.previewIndex || 0, x - 1, y - 1, size + 2, size + 4);
    } else {
      ctx.fillStyle = hero.tint || "#9fb8ff";
      ctx.beginPath();
      ctx.arc(cx, cy, size * 0.28, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    ctx.strokeStyle = "rgba(116,236,255,.92)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
    ctx.stroke();
  }

  function drawSettings() {
    if (game.player) drawGame();
    else drawMenu();
    ctx.fillStyle = "rgba(2,8,14,.82)";
    ctx.fillRect(0, 0, W, H);
    const panel = ctx.createLinearGradient(390, 92, 890, 688);
    panel.addColorStop(0, "rgba(6,28,42,.96)");
    panel.addColorStop(0.48, "rgba(8,17,27,.98)");
    panel.addColorStop(1, "rgba(6,35,48,.96)");
    roundRect(390, 92, 500, 596, 18, panel, "rgba(103,232,255,.42)", 1.5);
    ctx.fillStyle = "#ecfeff";
    ctx.font = "700 34px Microsoft YaHei UI";
    textCenter("系统设置", W / 2, 166);
    ctx.fillStyle = "#8eeeff";
    ctx.font = "15px Microsoft YaHei UI";
    textCenter("点击开关即时生效，再点右上角头像或 Esc 关闭", W / 2, 196);
    SETTINGS_ITEMS.forEach((item, i) => {
      const y = 230 + i * 62;
      roundRect(420, y, 440, 48, 12, "rgba(255,255,255,.07)", "rgba(116,236,255,.16)", 1);
      ctx.fillStyle = "#eafcff";
      ctx.font = "700 20px Microsoft YaHei UI";
      ctx.fillText(item.label, 438, y + 31);
      drawToggle(756, y + 8, game.settings[item.key]);
    });
    roundRect(420, 542, 136, 46, 12, "rgba(20,98,122,.68)", "rgba(135,238,255,.45)", 1);
    roundRect(572, 542, 136, 46, 12, "rgba(122,42,64,.68)", "rgba(255,160,190,.45)", 1);
    roundRect(724, 542, 136, 46, 12, "rgba(120,96,30,.72)", "rgba(255,226,128,.55)", 1);
    ctx.fillStyle = "#f4fdff";
    ctx.font = "700 20px Microsoft YaHei UI";
    textCenter("主菜单", 488, 572);
    textCenter("退出", 640, 572);
    ctx.fillStyle = "#fff7da";
    ctx.font = "700 22px Microsoft YaHei UI";
    textCenter("关闭", 792, 572);
  }

  function drawToggle(x, y, on) {
    const fill = on ? "rgba(34,214,156,.82)" : "rgba(60,82,96,.72)";
    const stroke = on ? "rgba(167,255,223,.62)" : "rgba(161,199,216,.28)";
    roundRect(x, y, 72, 34, 17, fill, stroke, 1.5);
    ctx.fillStyle = on ? "rgba(220,255,244,.95)" : "rgba(215,230,238,.88)";
    ctx.beginPath();
    ctx.arc(x + (on ? 52 : 20), y + 17, 12, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawCrosshair() {
    const p = game.player;
    const a = aimDir();
    const worldPos = game.touchAim.active ? { x: p.x + a.x * 150, y: p.y + a.y * 150 } : { x: game.mouse.x, y: game.mouse.y };
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

  function getHeroAnchorScaleInfo(hero, img) {
    if (!img) return { refHeight: hero.frameHeight || 84 };
    if (!hero.__scaleInfo) hero.__scaleInfo = {};
    const key = `${hero.id}:${hero.atlasCols || 8}x${hero.atlasRows || 4}`;
    if (hero.__scaleInfo[key]) return hero.__scaleInfo[key];
    const cols = hero.atlasCols || 8;
    const rows = hero.atlasRows || 4;
    const heights = [];
    const sampleCols = hero.walkCols || [0, 1, 2, 3];
    const sampleRows = [...new Set((hero.frameRows || [0, 1, 2, 3]).slice(0, rows))];
    for (const r of sampleRows) {
      for (const c of sampleCols.slice(0, 4)) {
        const idx = r * cols + Math.min(cols - 1, c);
        const info = getAtlasFrameMetrics(img, cols, rows, idx);
        if (info && info.bh > 8) heights.push(info.bh);
      }
    }
    const refHeight = heights.length ? heights.reduce((a, b) => a + b, 0) / heights.length : (hero.frameHeight || 84);
    hero.__scaleInfo[key] = { refHeight };
    return hero.__scaleInfo[key];
  }

  function drawAtlasAnchored(img, hero, cols, rows, index, footX, footY, targetHeight, flipX = false) {
    if (!img) return;
    const info = getAtlasFrameMetrics(img, cols, rows, index);
    const ref = getHeroAnchorScaleInfo(hero, img);
    const scale = (targetHeight || hero.frameHeight || ref.refHeight) / Math.max(1, ref.refHeight);
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
    if (hit(pos, W - 78, 10, 70, 70)) {
      if (game.mode === "settings") closeSettings();
      else openSettings();
      return true;
    }
    if (game.mode === "settings") {
      for (let i = 0; i < SETTINGS_ITEMS.length; i++) {
        if (hit(pos, 420, 230 + i * 62, 440, 48)) {
          toggleSetting(SETTINGS_ITEMS[i].key);
          return true;
        }
      }
      if (hit(pos, 420, 542, 136, 46)) returnToMenu();
      else if (hit(pos, 572, 542, 136, 46)) exitGame();
      else if (hit(pos, 724, 542, 136, 46)) closeSettings();
      return true;
    }
    if (game.mode === "menu") {
      for (let i = 0; i < HEROES.length; i++) {
        const card = heroMenuCard(i);
        if (hit(pos, card.x, card.y, card.w, card.h)) {
          selectHero(HEROES[i].id);
          return true;
        }
      }
      if (hit(pos, 260, 426, 220, 105)) selectDifficulty(2, "简单 / 高中词汇");
      else if (hit(pos, 510, 426, 220, 105)) selectDifficulty(4, "普通 / 四六级词汇");
      else if (hit(pos, 760, 426, 220, 105)) selectDifficulty(6, "困难 / 雅思词汇");
      else if (hit(pos, 380, 558, 44, 32)) cycleTheme(-1);
      else if (hit(pos, 856, 558, 44, 32)) cycleTheme(1);
      else {
        const saved = loadSave();
        if (saved && hit(pos, 350, 570, 270, 56)) startGame(game.difficulty, game.difficultyName);
        else if (saved && hit(pos, 660, 570, 270, 56)) continueSavedGame();
        else if (!saved && hit(pos, 495, 570, 290, 56)) startGame(game.difficulty, game.difficultyName);
      }
      return true;
    } else if (game.mode === "reward") {
      for (let i = 0; i < 3; i++) if (hit(pos, 245 + i * 285, 245, 250, 215)) chooseReward(i);
    } else if (game.mode === "gameover") {
      game.mode = "menu";
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

  canvas.addEventListener("pointermove", e => {
    const screen = clientToGame(e);
    const world = screenToWorldPoint(screen);
    game.mouse.x = world.x;
    game.mouse.y = world.y;
  });

  canvas.addEventListener("pointerdown", e => {
    const screen = clientToGame(e);
    const world = screenToWorldPoint(screen);
    game.mouse = { x: world.x, y: world.y, down: true };
    const handled = handleCanvasClick(screen);
    if (!handled && game.mode === "playing" && e.pointerType !== "mouse" && tapToken(world)) return;
    if (!handled && game.mode === "playing" && e.pointerType === "mouse" && game.settings.clickToShoot) fire(world);
  });

  canvas.addEventListener("pointerup", () => {
    game.mouse.down = false;
  });

  window.addEventListener("keydown", e => {
    game.keys.add(e.code);
    if (e.code === "Digit1") game.mode === "reward" ? chooseReward(0) : selectDifficulty(2, "\u7b80\u5355 / \u9ad8\u4e2d\u8bcd\u6c47");
    if (e.code === "Digit2") game.mode === "reward" ? chooseReward(1) : selectDifficulty(4, "\u666e\u901a / \u56db\u516d\u7ea7\u8bcd\u6c47");
    if (e.code === "Digit3") game.mode === "reward" ? chooseReward(2) : selectDifficulty(6, "\u56f0\u96be / \u96c5\u601d\u8bcd\u6c47");
    if (e.code === "KeyH" && game.mode === "menu") cycleHero(1);
    if (e.code === "KeyJ" && game.mode === "menu") cycleTheme(-1);
    if (e.code === "KeyK" && game.mode === "menu") cycleTheme(1);
    if (e.code === "Enter" && game.mode === "menu") startGame(game.difficulty, game.difficultyName);
    if (e.code === "KeyC" && game.mode === "menu") continueSavedGame();
    if (e.code === "KeyR" && (game.mode === "playing" || game.mode === "paused")) restartCurrentRoom();
    if (e.code === "Space") dash();
    if (e.code === "KeyE") interact();
    if (e.code === "KeyQ") shield();
    if (e.code === "Tab") {
      e.preventDefault();
      game.showBook = true;
    }
    if (e.code === "Escape") togglePause();
  });

  window.addEventListener("keyup", e => {
    game.keys.delete(e.code);
    if (e.code === "Tab") game.showBook = false;
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

  function syncFullscreenState() {
    const doc = document;
    const active = !!(doc.fullscreenElement || doc.webkitFullscreenElement || doc.msFullscreenElement);
    document.body.dataset.fullscreen = active ? "1" : "0";
    if (active) {
      setTimeout(() => window.scrollTo?.(0, 1), 60);
      screen.orientation?.lock?.("landscape").catch?.(() => {});
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
    const set = e => {
      e.preventDefault();
      const rect = zone.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const radius = Math.min(rect.width, rect.height) * 0.38;
      let x = (e.clientX - cx) / radius;
      let y = (e.clientY - cy) / radius;
      const l = len(x, y);
      if (l > 1) {
        x /= l;
        y /= l;
      }
      target.x = x;
      target.y = y;
      if (target === game.touchAim) target.active = true;
      knob.style.transform = `translate(${x * radius}px, ${y * radius}px)`;
    };
    zone.addEventListener("pointerdown", e => {
      e.preventDefault();
      pointer = e.pointerId;
      zone.setPointerCapture(pointer);
      set(e);
    });
    zone.addEventListener("pointermove", e => {
      e.preventDefault();
      if (e.pointerId === pointer) set(e);
    });
    const end = e => {
      e.preventDefault();
      if (e.pointerId !== pointer) return;
      pointer = null;
      if (resetOnEnd) {
        target.x = 0;
        target.y = 0;
      }
      if (target === game.touchAim) target.active = false;
      knob.style.transform = "translate(0, 0)";
    };
    zone.addEventListener("pointerup", end);
    zone.addEventListener("pointercancel", end);
  }

  bindStick("moveZone", "moveKnob", game.touchMove, true);
  bindStick("aimZone", "aimKnob", game.touchAim, false);

  let touchFirePointer = null;

  function setTouchAimFromButton(e, button) {
    if (!game.player) return;
    const rect = button.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    const l = len(dx, dy);
    game.touchAim.active = true;
    if (l > 8) {
      game.touchAim.x = dx / l;
      game.touchAim.y = dy / l;
    } else {
      game.touchAim.x = game.aim.x || (game.player.facing === 1 ? -1 : 1);
      game.touchAim.y = game.aim.y || 0;
    }
  }

  function runTouchAction(action) {
    if (action === "dash") dash();
    if (action === "interact") interact();
    if (action === "potion") shield();
    if (action === "book") game.showBook = true;
    if (action === "pause") togglePause();
    if (action === "resume" && game.mode === "paused") togglePause();
    if (action === "restart" && (game.mode === "playing" || game.mode === "paused")) restartCurrentRoom();
    if (action === "fullscreen") toggleFullscreen();
  }

  document.querySelectorAll("[data-action]").forEach(button => {
    button.addEventListener("pointerdown", e => {
      e.preventDefault();
      e.stopPropagation();
      button.setPointerCapture?.(e.pointerId);
      const action = button.dataset.action;
      if (action === "fire") {
        touchFirePointer = e.pointerId;
        setTouchAimFromButton(e, button);
        return;
      }
      button.dataset.lastPointerAction = String(Date.now());
      runTouchAction(action);
    });
    button.addEventListener("pointermove", e => {
      if (button.dataset.action !== "fire" || e.pointerId !== touchFirePointer) return;
      e.preventDefault();
      e.stopPropagation();
      setTouchAimFromButton(e, button);
    });
    button.addEventListener("pointerup", e => {
      if (button.dataset.action === "fire" && e.pointerId === touchFirePointer) {
        e.preventDefault();
        e.stopPropagation();
        fire();
        touchFirePointer = null;
        game.touchAim.active = false;
      }
      if (button.dataset.action === "book") game.showBook = false;
    });
    button.addEventListener("pointercancel", e => {
      if (button.dataset.action === "fire" && e.pointerId === touchFirePointer) {
        touchFirePointer = null;
        game.touchAim.active = false;
      }
      if (button.dataset.action === "book") game.showBook = false;
    });
    button.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      const last = Number(button.dataset.lastPointerAction || 0);
      if (Date.now() - last < 650) return;
      runTouchAction(button.dataset.action);
    });
  });

  ["fullscreenchange", "webkitfullscreenchange", "msfullscreenchange"].forEach(evt => window.addEventListener(evt, syncFullscreenState));
  window.addEventListener("resize", () => syncFullscreenState());
  window.addEventListener("contextmenu", e => e.preventDefault());
  boot().catch(error => {
    console.error(error);
    loading.innerHTML = `\u52a0\u8f7d\u5931\u8d25\uff1a${error.message}<br><small>\u8bf7\u786e\u8ba4\u662f\u5728 web \u6587\u4ef6\u5939\u91cc\u542f\u52a8\u672c\u5730\u670d\u52a1\u5668\uff0c\u4e14 assets\u3001game.js\u3001wordbank.json \u90fd\u548c index.html \u5728\u540c\u4e00\u5c42\u3002</small>`;
  });
})();
