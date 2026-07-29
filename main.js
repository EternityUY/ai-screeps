/*
 * ============================================================
 *  main.js — Screeps:World 游戏 AI (单文件完整版 v4.0)
 * ============================================================
 *
 * v4.0 新增:
 *   + Spawn Queue     — 队列孵化替代贪心链，支持预生成替换和多 Spawn
 *   + Link 网络        — RCL5+ 自动 Source→Controller Link 送能
 *   + 市场交易        — RCL4+ Terminal 自动买卖能量和矿物
 *   + 远征采集        — Claimer + RemoteHauler 跨房间挖矿
 *   + Lab 强化        — RCL6+ 自动购买化合物并 Boost Upgrader
 *
 * v3.0 中期改造:
 *   + Room Cache 层     — 每 tick 缓存 room.find() 结果，全 tick 共享
 *   + 动态身体部件      — 模式重复法替代固定模板，按 capacity 自动缩放
 *   + 容器定点采集      — RCL2+ 静止采集者 + 专用搬运工分离
 *   + CPU 降级策略      — 三层自动降级 (normal/moderate/critical)
 *   + 路径复用          — 所有 moveTo 加 reusePath 选项
 *   + 状态机            — working 布尔 → state 枚举
 *   + Bug 修复          — 重复 cleanMemory、角色计数缓存等
 *
 * 长期扩展预留:
 *   — Cache 按 roomName 索引 → 多房间直接扩展
 *   — BODY_PATTERNS 预留 claimer/remoteHarvester/miner
 *   — STATES 可升级为配置驱动 FSM
 *   — CONFIG 预留 REMOTE/LINKS/MARKET 段
 *
 * @version 3.0.0
 */

// ============================================================
//  SECTION: CONFIG — 全局配置
//  所有可调参数集中在此处
// ============================================================

const CONFIG = {
  ROLES: {
    HARVESTER:       "harvester",
    STATIC_HARVESTER:"staticHarvester",
    UPGRADER:        "upgrader",
    BUILDER:         "builder",
    REPAIRER:        "repairer",
    HAULER:          "hauler",
    WALL_REPAIRER:   "wallRepairer",
    CLAIMER:         "claimer",
    REMOTE_HAULER:   "remoteHauler",
  },

  // 种群控制
  POPULATION: {
    MIN_HARVESTERS: 1,      MAX_HARVESTERS: 6,
    MIN_UPGRADERS:  1,      MAX_UPGRADERS:  4,
    MIN_BUILDERS:   0,      MAX_BUILDERS:   3,
    MIN_REPAIRERS:  0,      MAX_REPAIRERS:  2,
    MIN_HAULERS:    1,      MAX_HAULERS:    3,
    MIN_WALL_REPAIRERS: 0,  MAX_WALL_REPAIRERS: 1,
    MIN_CLAIMERS:   0,      MAX_CLAIMERS:   1,
    MIN_REMOTE_HAULERS: 0,  MAX_REMOTE_HAULERS: 2,
    MAX_STATICHARVESTERS: 4,
  },

  // 孵化队列
  SPAWN: {
    PRE_SPAWN_TICKS: 50,       // 提前生成——Creep 剩余寿命低于此值时预生成替换
    ENERGY_RESERVE:  300,      // 最小保留能量，避免溢出后无法生成关键角色
  },

  // 能量阈值
  ENERGY: {
    TOWER_MIN_ENERGY:     500,
  },

  // 维修阈值
  REPAIR: {
    ROAD_THRESHOLD:      0.5,
    WALL_THRESHOLD:      0.0001,
    STRUCTURE_THRESHOLD: 0.5,
    WALL_MAX_RATIO:      0.001,
  },

  // 路径复用 tick 数
  PATH: {
    REUSE_TICKS: 25,
  },

  // CPU 降级阈值
  CPU: {
    MODERATE_BUCKET:  5000,
    CRITICAL_BUCKET:  2000,
  },

  // 容器采集
  CONTAINER: {
    ENABLE_AT_RCL:       2,
    WITHDRAW_THRESHOLD:  200,
    PICKUP_THRESHOLD:    50,
  },

  // 日志级别: 0=全部 | 1=一般 | 2=警告 | 3=错误
  LOG_LEVEL: 1,

  // 邮件通知 (发送到注册邮箱)
  NOTIFY: {
    ENABLED:      true,    // 总开关
    ON_HOSTILES:  true,    // 敌人入侵时通知
    ON_ALL_DEAD:  true,    // 所有 Creep 死亡时通知
    ON_STARTUP:   true,    // 脚本启动时发送现状报告
    ON_LOW_ENERGY:true,    // 能量持续 < 15% 时通知
    // Game.notify 的 groupInterval 单位是【分钟】且上限 1440(24h)，
    // 原值 172800 超出合法范围会被 API 拒绝 → 邮件分组失效
    INTERVAL:     1440,    // 同类通知最小间隔 (分钟, 1440 = 24 小时)
    LOW_ENERGY_TICKS: 300, // 能量需连续低于 15% 这么多 tick 才发信(避开孵化瞬时低谷)
  },

  // ---- 长期扩展预留 ----
  REMOTE: {
    MAX_REMOTE_ROOMS: 2,
    RESERVE_TICKS:    3000,
    CLAIM_FLAG_PREFIX: "remote_",  // 标记目标房间的 Flag 前缀: remote_W1N1
    MIN_STORAGE_ENERGY: 30000,     // Storage 能量低于此值时不启动远征
    HAUL_AMOUNT_MIN:  500,         // 远程容器低于此能量不搬运
    CLAIMER_RENEW_AT: 500,         // reservation 低于此 tick 时续约
  },
  LINKS: {
    ENABLED_AT_RCL:  5,
    SOURCE_RANGE:    2,
    CONTROLLER_RANGE: 3,
    SEND_THRESHOLD:  400,
    RECEIVE_MAX:     600,
  },

  // 市场交易
  MARKET: {
    ENABLED_AT_RCL:  4,          // RCL 4 解锁 Terminal 后启用
    ENERGY_BUY_MIN:  0.01,       // 买入能量最低单价
    ENERGY_BUY_MAX:  0.05,       // 买入能量最高单价
    ENERGY_BUY_AMOUNT: 2000,     // 单次买入量
    ENERGY_BUY_THRESHOLD: 10000, // Storage 能量低于此值时买入
    MINERAL_SELL_MIN: 0.05,      // 卖出矿物最低单价
    MINERAL_SELL_AMOUNT: 500,    // 单次卖出量
    STORAGE_SELL_THRESHOLD: 0.8, // Storage 填充率 > 80% 时卖出矿物
    TRADE_INTERVAL: 100,         // 两次交易间最小间隔 (tick)
    TERMINAL_ENERGY_RESERVE: 5000, // Terminal 保留的最小能量
  },

  // 实验室强化
  LABS: {
    ENABLED_AT_RCL: 6,         // RCL 6 解锁 Lab 后启用
    MIN_LABS: 3,               // 至少建造 3 个 Lab
    BOOST_COMPOUNDS: ["GH", "UH", "LH"],  // 优先使用的提升化合物
    COMPOUND_BUY_MAX: 0.5,     // 化合物最高买入单价
    COMPOUND_BUY_AMOUNT: 300,  // 每次买入量
    BOOST_MIN_ENERGY: 20000,   // Storage 能量低于此值时不 Boost
    LAB_RANGE: 3,              // 在 Controller 多少格内放置 Lab
  },
};

// ============================================================
//  SECTION: CPU_GOVERNOR — CPU 预算三层降级
// ============================================================

const CPUGovernor = {
  /** @returns {"normal"|"moderate"|"critical"} */
  tier() {
    if (Game.cpu.bucket < CONFIG.CPU.CRITICAL_BUCKET) return "critical";
    if (Game.cpu.bucket < CONFIG.CPU.MODERATE_BUCKET) return "moderate";
    return "normal";
  },

  /** 是否跳过可视化渲染 */
  shouldSkipVisual()   { return this.tier() !== "normal"; },

  /** 是否跳过非攻击性 Tower 操作 */
  shouldSkipTowerUtil(){ return this.tier() === "critical"; },

  /** 是否跳过非关键日志 */
  shouldSkipInfoLog()  { return this.tier() === "critical"; },

};

// ============================================================
//  SECTION: NOTIFIER — 邮件通知 (Game.notify)
//  发送到注册邮箱，Memory 追踪状态避免重复推送
// ============================================================

const Notifier = {
  /** 检查是否已发送过 */
  _sent(key) { return Memory._ntf && Memory._ntf[key]; },

  /** 标记已发送 */
  _mark(key) {
    if (!Memory._ntf) Memory._ntf = {};
    Memory._ntf[key] = Game.time;
  },

  /** 清除标记（下次事件重新通知） */
  _clear(key) {
    if (Memory._ntf) delete Memory._ntf[key];
  },

  /** 发送通知（自动去重） */
  _send(key, title, body) {
    if (!CONFIG.NOTIFY.ENABLED) return;
    if (this._sent(key)) return;
    const msg = `[Screeps AI] ${title}\n${body}\nTick: ${Game.time} | 房间: ${Helpers.getHomeRoom()}`;
    Game.notify(msg, CONFIG.NOTIFY.INTERVAL);
    this._mark(key);
    console.log(`[T${Game.time}] 📧 [通知] 已发送邮件: ${title}`);
  },

  /** 敌人入侵 */
  onHostiles(count) {
    this._send("hostiles", `🚨 发现 ${count} 个敌对 Creep！`,
      `你的房间遭到入侵，${count} 个敌对单位正在攻击。\nTower 已自动响应。`);
  },

  /** 敌人撤离 — 清除标记以便下次入侵重新通知 */
  onHostilesClear() { this._clear("hostiles"); },

  /** 全部 Creep 死亡 */
  onAllDead() {
    this._send("allDead", "💀 所有 Creep 已死亡！",
      "房间内没有任何存活的 Creep，经济已停止。\n请检查 Spawn 是否有足够能量生成新的采集者。");
  },

  /** 有新 Creep 生成 — 清除全灭标记 */
  onCreepSpawned() { this._clear("allDead"); },

  /** 能量持续低下 */
  onLowEnergy(energy, capacity) {
    this._send("lowEnergy", `🔴 能量严重不足: ${energy}/${capacity}`,
      `房间能量已持续低于 15%，当前 ${energy}/${capacity}。\nSpawn 将无法生成大型 Creep，升级速度也会下降。`);
  },

  /** 能量恢复 — 清除低能标记 */
  onLowEnergyClear() { this._clear("lowEnergy"); },

  /** 启动时现状报告 */
  onStartup(report) {
    if (!CONFIG.NOTIFY.ENABLED || !CONFIG.NOTIFY.ON_STARTUP) return;
    Game.notify(`[Screeps AI] 🎮 脚本已启动\n${report}\nTick: ${Game.time}`, CONFIG.NOTIFY.INTERVAL);
    Logger.info("通知", "📧 已发送启动报告");
  },
};

// ============================================================
//  SECTION: ROOM_CACHE — 房间对象缓存层
//  每个 tick 在 loop() 入口刷新一次，全 tick 共享
//  长期: 按 roomName 索引，多房间只需对每个房间调 refresh()
// ============================================================

const RoomCache = {
  _data: {},  // { [roomName]: CacheEntry }

  /**
   * 刷新一个房间的缓存 — 每个 tick 对每个活跃房间调用一次
   * @param {Room} room
   */
  refresh(room) {
    if (!room) return;

    const structures = room.find(FIND_STRUCTURES);
    const entry = {
      spawns:      [],
      extensions:  [],
      towers:      [],
      containers:  [],
      links:       [],
      labs:        [],
      storage:     room.storage || null,
      terminal:    room.terminal || null,
      roads:       [],
      walls:       [],
      ramparts:    [],
      myStructures:[],
      sources:     room.find(FIND_SOURCES),
      sites:       room.find(FIND_MY_CONSTRUCTION_SITES),
      dropped:     room.find(FIND_DROPPED_RESOURCES),
      hostiles:    room.find(FIND_HOSTILE_CREEPS),
      myCreeps:    room.find(FIND_MY_CREEPS),
      controller:  room.controller,
      rcl:         room.controller ? room.controller.level : 0,
      energyAvailable:       room.energyAvailable,
      energyCapacityAvailable: room.energyCapacityAvailable,
      tick:        Game.time,
    };

    // 一次遍历拆分所有结构类型（纯 CPU 过滤，比多次 room.find() 快得多）
    for (const s of structures) {
      switch (s.structureType) {
        case STRUCTURE_SPAWN:      if (s.my) entry.spawns.push(s);      break;
        case STRUCTURE_EXTENSION:  if (s.my) entry.extensions.push(s);  break;
        case STRUCTURE_TOWER:      if (s.my) entry.towers.push(s);      break;
        case STRUCTURE_CONTAINER:  entry.containers.push(s);            break;
        case STRUCTURE_LINK:       if (s.my) entry.links.push(s);       break;
        case STRUCTURE_LAB:        if (s.my) entry.labs.push(s);        break;
        case STRUCTURE_STORAGE:    entry.storage = entry.storage || s;  break;
        case STRUCTURE_TERMINAL:   entry.terminal = entry.terminal || s; break;
        case STRUCTURE_ROAD:       entry.roads.push(s);                 break;
        case STRUCTURE_WALL:       entry.walls.push(s);                 break;
        case STRUCTURE_RAMPART:    entry.ramparts.push(s);              break;
      }
      if (s.my) entry.myStructures.push(s);
    }

    this._data[room.name] = entry;
  },

  /**
   * 获取房间缓存
   * @param {string} roomName
   * @returns {object|null}
   */
  get(roomName) {
    return this._data[roomName] || null;
  },
};

// ============================================================
//  SECTION: BODY_BUILDER — 动态身体部件生成
//  基于可重复模式，按 energyCapacityAvailable 自动缩放
// ============================================================

const BODY_PATTERNS = {
  harvester:        [WORK, WORK, CARRY, MOVE],            // 350 能量/组   (走动式采集)
  staticHarvester:  [WORK, WORK, WORK, WORK, CARRY, MOVE],// 550 能量/组   (定点采集，高 WORK)
  upgrader:         [WORK, WORK, CARRY, MOVE],            // 350 能量/组   (升级专用，2:1:1)
  worker:           [WORK, CARRY, MOVE],                  // 200 能量/组   (建造/维修)
  hauler:           [CARRY, CARRY, MOVE],                 // 150 能量/组   (纯搬运)
  // 长期预留
  claimer:          [CLAIM, MOVE],                        // 650 能量/组
  remoteHauler:     [CARRY, CARRY, CARRY, CARRY, MOVE, MOVE], // 400 能量/组
};

/**
 * 各角色的“最小可用身体” — 能量不足时的保底方案
 * 关键: claimer 没有 CLAIM 部件就完全无法 reserveController，
 * 统一保底成 [WORK,CARRY,MOVE] 会造出一个永远干不了活的废人
 */
const MIN_BODIES = {
  claimer:      [CLAIM, MOVE],
  hauler:       [CARRY, CARRY, MOVE],
  remoteHauler: [CARRY, CARRY, MOVE],
};
const DEFAULT_MIN_BODY = [WORK, CARRY, MOVE];

const BodyBuilder = {
  /**
   * 根据可用能量容量动态构建身体部件
   * @param {number} energyCapacity — 使用 room.energyCapacityAvailable
   * @param {string} patternKey      — BODY_PATTERNS 的键
   * @param {number} maxParts        — 硬上限 (默认 50，游戏上限)
   * @returns {BodyPartConstant[]}
   */
  build(energyCapacity, patternKey, maxParts = 50) {
    const pattern = BODY_PATTERNS[patternKey] || BODY_PATTERNS.worker;
    if (!pattern) return [WORK, CARRY, MOVE];

    const groupCost = _.sum(pattern, p => BODYPART_COST[p]);
    const maxRepeats  = Math.floor(maxParts / pattern.length);
    const affordable  = Math.floor(energyCapacity / groupCost);
    const repeats     = Math.min(affordable, maxRepeats);

    if (repeats <= 0) return this.minBody(patternKey); // 最低保底(按角色区分)

    const body = [];
    for (let i = 0; i < repeats; i++) body.push(...pattern);

    // ---- 剩余能量追加部件 ----
    // 采集/升级角色追加额外 WORK 以用满容量
    const canBoost = patternKey === 'harvester' || patternKey === 'staticHarvester'
                  || patternKey === 'upgrader';
    if (canBoost) {
      let remaining = energyCapacity - BodyBuilder.cost(body);
      while (remaining >= 150 && body.length < maxParts - 1) {
        body.push(WORK);    // 100 能量
        body.push(MOVE);    // 50 能量
        remaining -= 150;
      }
      if (remaining >= 50 && body.length < maxParts)
        body.push(CARRY);   // 50 能量
    }
    // ---- 追加结束 ----

    return body;
  },

  /** 该角色的最小可用身体 */
  minBody(patternKey) {
    return MIN_BODIES[patternKey] || DEFAULT_MIN_BODY;
  },

  /** 计算身体成本 */
  cost(body) {
    return _.sum(body, p => BODYPART_COST[p]);
  },
};

// ============================================================
//  SECTION: STATES — 状态机枚举
//  替代原来的 working: true/false，为复杂行为打基础
// ============================================================

const STATES = {
  HARVESTING: "harvesting",   // 采集/取能量
  WORKING:    "working",      // 存放能量 (Harvester/Hauler)
  UPGRADING:  "upgrading",    // 升级控制器
  BUILDING:   "building",     // 建造工地
  REPAIRING:  "repairing",    // 维修建筑
  HAULING:    "hauling",      // 运输 (同 WORKING，语义更明确)
};

// ============================================================
//  SECTION: LOGGER — 分级日志（CPU 降级感知）
// ============================================================

const Logger = {
  _tick() { return `[T${Game.time}]`; },

  _fmt(icon, tag, msg, data) {
    let s = `${this._tick()} ${icon} [${tag}] ${msg}`;
    if (data !== undefined) {
      try { s += ` | ${JSON.stringify(data)}`; } catch (e) { /* ignore */ }
    }
    return s;
  },

  debug(tag, msg, data) {
    if (CONFIG.LOG_LEVEL <= 0 && !CPUGovernor.shouldSkipInfoLog())
      console.log(this._fmt("🔍", tag, msg, data));
  },
  info(tag, msg, data) {
    if (CONFIG.LOG_LEVEL <= 1 && !CPUGovernor.shouldSkipInfoLog())
      console.log(this._fmt("✅", tag, msg, data));
  },
  warn(tag, msg, data) {
    if (CONFIG.LOG_LEVEL <= 2)
      console.log(this._fmt("⚠️", tag, msg, data));
  },
  error(tag, msg, data) {
    if (CONFIG.LOG_LEVEL <= 3)
      console.log(this._fmt("❌", tag, msg, data));
  },

  report(s) {
    if (CPUGovernor.shouldSkipInfoLog()) return;
    console.log(this._fmt("📊", "全局",
      `采集:${s.h} | 定点:${s.sh || 0} | 升级:${s.u} | 建造:${s.b} | 维修:${s.r} | 运输:${s.haul} | 能量:${s.ea}/${s.ec}`));
  },
};

// ============================================================
//  SECTION: HELPERS — 通用辅助函数
// ============================================================

const Helpers = {
  /** 获取主房间名称 */
  getHomeRoom() {
    if (CONFIG.HOME_ROOM) return CONFIG.HOME_ROOM;
    for (const sn in Game.spawns) return Game.spawns[sn].room.name;
    return Object.keys(Game.rooms)[0] || "";
  },

  /** 获取主 Spawn */
  getHomeSpawn() {
    const cache = RoomCache.get(this.getHomeRoom());
    return cache && cache.spawns.length ? cache.spawns[0] : null;
  },

  /**
   * 统计各角色数量（从 Game.creeps 全局计数，不限于 homeRoom）
   * 避免因探索/远征中的 Creep 离开房间导致计数偏低、触发无限补充
   * @returns {object}
   */
  countCreepsByRole() {
    const counts = {};
    for (const name in Game.creeps) {
      const r = Game.creeps[name].memory.role || "unknown";
      counts[r] = (counts[r] || 0) + 1;
    }
    return counts;
  },

  /** 需要维修的结构列表（从缓存过滤，纯内存操作） */
  findToRepair(roomName) {
    const cache = RoomCache.get(roomName);
    if (!cache) return [];
    const R = CONFIG.REPAIR;
    const result = [];

    // 道路
    for (const s of cache.roads) {
      if (s.hits < s.hitsMax * R.ROAD_THRESHOLD) result.push(s);
    }
    // 容器
    for (const s of cache.containers) {
      if (s.hits < s.hitsMax * R.STRUCTURE_THRESHOLD) result.push(s);
    }
    // 城墙 & 壁垒
    for (const s of cache.walls) {
      if (s.hits < s.hitsMax * R.WALL_THRESHOLD) result.push(s);
    }
    for (const s of cache.ramparts) {
      if (s.hits < s.hitsMax * R.WALL_THRESHOLD) result.push(s);
    }
    // 其他我的建筑 (非墙/壁垒)
    for (const s of cache.myStructures) {
      if (s.structureType !== STRUCTURE_WALL && s.structureType !== STRUCTURE_RAMPART) {
        if (s.hits < s.hitsMax && s.hits < s.hitsMax * R.STRUCTURE_THRESHOLD)
          result.push(s);
      }
    }

    return _.sortBy(result, s => s.hits / s.hitsMax);
  },

  /** 获取当前 RCL */
  getRCL(roomName) {
    const cache = RoomCache.get(roomName);
    return cache ? cache.rcl : 0;
  },

  /** 能量状态快照 */
  energyStatus(roomName) {
    const cache = RoomCache.get(roomName);
    if (!cache) return { a: 0, c: 0, r: 0 };
    return {
      a: cache.energyAvailable,
      c: cache.energyCapacityAvailable,
      r: cache.energyCapacityAvailable > 0
        ? cache.energyAvailable / cache.energyCapacityAvailable
        : 0,
    };
  },

  /** 生成中文名 */
  genName(role) {
    const map = {
      harvester: "采集", staticHarvester: "定点", upgrader: "升级",
      builder: "建造", repairer: "维修", hauler: "运输", wallRepairer: "城墙",
      claimer: "占领", remoteHauler: "远征",
    };
    // 同一 tick 内多个 Spawn 生成同角色会撞名(ERR_NAME_EXISTS)，加个 tick 内序号
    if (Memory._nameTick !== Game.time) { Memory._nameTick = Game.time; Memory._nameSeq = 0; }
    Memory._nameSeq++;
    const suffix = Memory._nameSeq > 1 ? `_${Memory._nameSeq}` : "";
    return `${map[role] || role}_${Game.time}${suffix}`;
  },

  /** 清理死亡 Creep 内存（仅调用一次/tick） */
  cleanMemory() {
    for (const name in Memory.creeps) {
      if (!Game.creeps[name]) {
        const role = Memory.creeps[name].role || "未知";
        delete Memory.creeps[name];
        if (!CPUGovernor.shouldSkipInfoLog())
          console.log(`[T${Game.time}] 💀 [内存] 清除 "${name}"(${role})`);
      }
    }
  },
};

// ============================================================
//  SECTION: ROLES — 角色行为逻辑（状态机 + 缓存 + reusePath）
// ============================================================

// ---------- 通用辅助 ----------

const RoleUtil = {
  /**
   * 状态转换: 能量满 → WORKING 系列状态, 能量空 → HARVESTING
   * @returns {boolean} 是否发生了状态切换
   */
  toggleState(creep, workingState) {
    if (!creep.memory.state) creep.memory.state = STATES.HARVESTING;

    if (creep.memory.state === STATES.HARVESTING && creep.store.getFreeCapacity() === 0) {
      creep.memory.state = workingState;
      creep.memory.targetId = null; // 重置目标，下次重新搜索
      return true;
    }
    // 用 getUsedCapacity() 而不是 store[RESOURCE_ENERGY]:
    // 身上只剩矿物/化合物(能量为 0)时，旧写法会把满载的 Creep 判成"空"并切回采集，
    // 于是它既卸不掉货又装不进东西，永久卡死
    if (creep.memory.state !== STATES.HARVESTING && creep.store.getUsedCapacity() === 0) {
      creep.memory.state = STATES.HARVESTING;
      creep.memory.targetId = null;
      return true;
    }
    return false;
  },

  /**
   * 通用提能 — 优先 Container → Storage → Spawn/Extension (仅在能量充裕时)
   */
  withdraw(creep) {
    const cache = RoomCache.get(creep.room.name);
    if (!cache) return false;
    const TH = CONFIG.CONTAINER.WITHDRAW_THRESHOLD;

    // 1. 最近的 Container
    const cont = creep.pos.findClosestByRange(cache.containers.filter(
      s => s.store[RESOURCE_ENERGY] > TH
    ));
    if (cont) {
      if (creep.withdraw(cont, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE)
        creep.moveTo(cont, { reusePath: CONFIG.PATH.REUSE_TICKS, visualizePathStyle: { stroke: "#ffaa00" } });
      return true;
    }

    // 2. Storage
    if (cache.storage && cache.storage.store[RESOURCE_ENERGY] > 0) {
      if (creep.withdraw(cache.storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE)
        creep.moveTo(cache.storage, { reusePath: CONFIG.PATH.REUSE_TICKS, visualizePathStyle: { stroke: "#ffaa00" } });
      return true;
    }

    // 3. Controller Link — Upgrader 优先取能 (RCL5+)
    if (creep.memory.role === CONFIG.ROLES.UPGRADER && cache.links.length) {
      const ctrl = cache.controller;
      if (ctrl && ctrl.my) {
        const ctrlLink = creep.pos.findClosestByRange(
          cache.links.filter(l => l.pos.getRangeTo(ctrl.pos) <= 3 && l.store[RESOURCE_ENERGY] > 100)
        );
        if (ctrlLink) {
          if (creep.withdraw(ctrlLink, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE)
            creep.moveTo(ctrlLink, { reusePath: CONFIG.PATH.REUSE_TICKS, visualizePathStyle: { stroke: "#ffaa00" } });
          return true;
        }
      }
    }

    // 4. 自带 WORK 的角色 → 自己去挖，优先于抽 Spawn
    //    顺序很关键：Spawn 里的能量是"造下一个 Creep 的本钱"，只出不进。
    //    让建造者/升级者随手把它抽走，采集者一旦老死就再也凑不出复活的能量 → 死亡螺旋
    if (creep.getActiveBodyparts(WORK) > 0) {
      const src = creep.pos.findClosestByRange(cache.sources.filter(s => s.energy > 0));
      if (src) {
        if (creep.harvest(src) === ERR_NOT_IN_RANGE)
          creep.moveTo(src, { reusePath: CONFIG.PATH.REUSE_TICKS, visualizePathStyle: { stroke: "#ffaa00" } });
        return true;
      }
    }

    // 5. Spawn/Extension — 只留给没有 WORK 部件、确实挖不了矿的角色
    const es = cache.energyCapacityAvailable > 0
      ? cache.energyAvailable / cache.energyCapacityAvailable : 0;
    // RCL1:0.3 | RCL2:0.5（无Container/Storage时必须降低门槛让Upgrader能取能）| RCL3+:0.9
    const withdrawThreshold = cache.rcl <= 1 ? 0.3 : cache.rcl <= 2 ? 0.5 : 0.9;
    // 房间没有采集者时，必须始终留住"复活一个采集者"的本钱(200)。
    // 只锁这一份，而不是全锁 —— 能量充裕时采集者本 tick 就会被孵出来，
    // 此时再拦着升级者取能只会让它白白空转
    const reviveReserve = Emergency.noHarvesters(cache) ? Emergency.reviveCost() : 0;
    const wouldTake = creep.store.getFreeCapacity(RESOURCE_ENERGY);
    if (es >= withdrawThreshold && cache.energyAvailable - wouldTake >= reviveReserve) {
      // 注意阈值必须是 > 0 而不是 > 50：Extension 满仓正好就是 50，
      // 用 > 50 会导致 Extension 永远被跳过，开局只能从 Spawn 取能
      const se = creep.pos.findClosestByRange(
        [...cache.spawns, ...cache.extensions].filter(
          s => s.store[RESOURCE_ENERGY] > 0
        )
      );
      if (se) {
        if (creep.withdraw(se, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE)
          creep.moveTo(se, { reusePath: CONFIG.PATH.REUSE_TICKS, visualizePathStyle: { stroke: "#ffaa00" } });
        return true;
      }
    }

    return false;
  },

  /**
   * 通用目标储能筛选 (Spawn → Extension → Tower → Storage)
   * 用于 Harvester (传统模式) 和 Hauler 的存放
   */
  findDepositTarget(cache) {
    // 0. Controller Container 优先（能量低于 500 时）
    const ctrl = cache.controller;
    if (ctrl && ctrl.my) {
      const ctrlCont = ctrl.pos.findInRange(cache.containers, 3)
        .find(c => c.store.getFreeCapacity(RESOURCE_ENERGY) > 0 && c.store[RESOURCE_ENERGY] < 500);
      if (ctrlCont) return ctrlCont;
    }
    // Spawn
    const sp = _.find(cache.spawns, s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
    if (sp) return sp;
    // Extensions
    const ex = _.find(cache.extensions, s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
    if (ex) return ex;
    // Towers (< 500 能量)
    const tw = _.find(cache.towers, s => s.store[RESOURCE_ENERGY] < CONFIG.ENERGY.TOWER_MIN_ENERGY);
    if (tw) return tw;
    // Storage
    if (cache.storage && cache.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0)
      return cache.storage;
    // Links — 作为最后的能量缓冲
    if (cache.links && cache.links.length) {
      const ln = _.find(cache.links, s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
      if (ln) return ln;
    }
    return null;
  },

  /**
   * 升级控制器 fallback — 当角色无事可做时
   */
  upgradeFallback(creep) {
    const ctrl = creep.room.controller;
    if (!ctrl) return;
    if (creep.upgradeController(ctrl) === ERR_NOT_IN_RANGE)
      creep.moveTo(ctrl, { reusePath: CONFIG.PATH.REUSE_TICKS, visualizePathStyle: { stroke: "#00ff88" } });
  },

  /**
   * 头顶中文标签 — 简洁标示当前在做什么，低寿命时附加警告
   */
  sayState(creep) {
    const label = {
      [STATES.HARVESTING]: "采集",
      [STATES.WORKING]:    "存放",
      [STATES.UPGRADING]:  "升级",
      [STATES.BUILDING]:   "建造",
      [STATES.REPAIRING]:  "维修",
      [STATES.HAULING]:    "运输",
    }[creep.memory.state] || "";

    // 寿命 < 25t → 即将死亡标记；< 100t → 显示倒计时；< 300t → 附加数字
    if (creep.ticksToLive < 25) {
      creep.say(`⚠️${creep.ticksToLive}`);
    } else if (creep.ticksToLive < 100) {
      creep.say(`${label}·${creep.ticksToLive}`);
    } else if (creep.ticksToLive < 300) {
      creep.say(`${label}·${creep.ticksToLive}`);
    } else {
      creep.say(label);
    }
  },
};

// ---------- 采集者 Harvester ----------

const Harvester = {
  /** harvester 与 staticHarvester 共用本模块，Source 分配需一并统计 */
  _isHarvestRole(role) {
    return role === CONFIG.ROLES.HARVESTER || role === CONFIG.ROLES.STATIC_HARVESTER;
  },

  run(creep) {
    RoleUtil.toggleState(creep, STATES.WORKING);

    if (creep.memory.state === STATES.HARVESTING) {
      this._doHarvest(creep);
    } else {
      this._doDeposit(creep);
    }
    RoleUtil.sayState(creep);
  },

  _doHarvest(creep) {
    // 确保已分配 Source
    if (!creep.memory.sourceId) { this._assignSource(creep); return; }

    const source = Game.getObjectById(creep.memory.sourceId);
    if (!source || source.room.name !== creep.room.name) { this._assignSource(creep); return; }

    const r = creep.harvest(source);
    if (r === OK) {
      // 采集成功 → 重置失败状态
      creep.memory._harvestFailCount = 0;
      if (creep.memory._triedSources) delete creep.memory._triedSources;
      if (creep.memory._fallbackSince) delete creep.memory._fallbackSince;
    } else if (r === ERR_NOT_IN_RANGE) {
      creep.moveTo(source, { reusePath: CONFIG.PATH.REUSE_TICKS, visualizePathStyle: { stroke: "#ffaa00" } });
    } else if (r === ERR_NOT_ENOUGH_RESOURCES) {
      // Source 枯竭或占满 → 计数失败
      creep.memory._harvestFailCount = (creep.memory._harvestFailCount || 0) + 1;

      // 尝试走到 Source 附近（可能是其他 creep 挡路了，换个位置）
      if (Game.time % 3 === 0)
        creep.moveTo(source, { reusePath: CONFIG.PATH.REUSE_TICKS, visualizePathStyle: { stroke: "#ffaa00" } });

      if (creep.memory._harvestFailCount >= 10) {
        // 10 tick 连败 → 换一个 source
        creep.memory._harvestFailCount = 0;
        if (!creep.memory._triedSources) creep.memory._triedSources = [];
        creep.memory._triedSources.push(source.id);

        const newSrc = this._assignSourceExcluding(creep, creep.memory._triedSources);
        if (newSrc) {
          creep.memory.sourceId = newSrc;
          Logger.debug(creep.name, "🔄 切换 Source", `排除${creep.memory._triedSources.length}个`);
        } else {
          // 所有 source 都不可用 → fallback
          this._doFallback(creep);
        }
      }
    } else {
      // 其他错误
      Logger.debug(creep.name, "⚠️ 采集异常", `code:${r}`);
    }
  },

  _doDeposit(creep) {
    const cache = RoomCache.get(creep.room.name);
    if (!cache) return;

    // 检查 Source 旁边是否有 Container（定点采集模式）
    const source = creep.memory.sourceId ? Game.getObjectById(creep.memory.sourceId) : null;
    if (source) {
      const nearContainer = source.pos.findInRange(cache.containers, 1).find(
        c => c.store.getFreeCapacity(RESOURCE_ENERGY) > 0
      );
      if (nearContainer) {
        // 定点模式: 存到旁边的 Container
        if (creep.transfer(nearContainer, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE)
          creep.moveTo(nearContainer, { reusePath: CONFIG.PATH.REUSE_TICKS, visualizePathStyle: { stroke: "#ffffff" } });
        return;
      }
    }

    // 传统模式: 走回基地存放
    const target = RoleUtil.findDepositTarget(cache);
    if (!target) return;
    if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE)
      creep.moveTo(target, { reusePath: CONFIG.PATH.REUSE_TICKS, visualizePathStyle: { stroke: "#ffffff" } });
  },

  /** 所有 Source 都不可用时的等待退路（不离开房间） */
  _doFallback(creep) {
    // 身上有能量 → 去存放
    if (creep.store[RESOURCE_ENERGY] > 0) {
      creep.memory.state = STATES.WORKING;
      this._doDeposit(creep);
      RoleUtil.sayState(creep);
      return;
    }

    // 在 Source 附近做小范围走动（换位置等 Source 恢复/其他 creep 离开）
    const source = Game.getObjectById(creep.memory.sourceId);
    if (source && source.room.name === creep.room.name) {
      const dx = Math.floor(Math.sin(Game.time * 0.1) * 2);
      const dy = Math.floor(Math.cos(Game.time * 0.13) * 2);
      const target = new RoomPosition(
        Math.max(0, Math.min(49, source.pos.x + dx)),
        Math.max(0, Math.min(49, source.pos.y + dy)),
        creep.room.name
      );
      creep.moveTo(target, { reusePath: 10, visualizePathStyle: { stroke: "#ffaa00" } });
    }

    // 每 50 tick 重置尝试列表，看看 Source 恢复没有
    if (Game.time % 50 === 0) {
      delete creep.memory._triedSources;
    }
  },

  _assignSource(creep) {
    const cache = RoomCache.get(creep.room.name);
    if (!cache || !cache.sources.length) return;

    // 统计每个 Source 的采集者负载
    // staticHarvester 复用的就是本模块，必须一起计数，
    // 否则所有定点采集者都会被算成 0 负载而挤到同一个 Source 上
    const load = {};
    for (const s of cache.sources) load[s.id] = 0;
    for (const c of cache.myCreeps) {
      if (c.name === creep.name) continue;
      if (Harvester._isHarvestRole(c.memory.role) && c.memory.sourceId)
        load[c.memory.sourceId] = (load[c.memory.sourceId] || 0) + 1;
    }

    let best = cache.sources[0], min = Infinity;
    for (const s of cache.sources) {
      if ((load[s.id] || 0) < min) { min = load[s.id]; best = s; }
    }
    creep.memory.sourceId = best.id;
    Logger.debug(creep.name, "🔗 分配能量源", `负载:${min}`);
  },

  /** 排除已试 Source 后分配（给 fallback 用） */
  _assignSourceExcluding(creep, excludeIds) {
    const cache = RoomCache.get(creep.room.name);
    if (!cache || !cache.sources.length) return null;

    const available = cache.sources.filter(s => !excludeIds.includes(s.id));
    if (!available.length) return null;

    const load = {};
    for (const s of available) load[s.id] = 0;
    for (const c of cache.myCreeps) {
      if (c.name === creep.name) continue;
      if (Harvester._isHarvestRole(c.memory.role) && c.memory.sourceId && load[c.memory.sourceId] !== undefined)
        load[c.memory.sourceId] = (load[c.memory.sourceId] || 0) + 1;
    }

    let best = available[0], min = Infinity;
    for (const s of available) {
      if ((load[s.id] || 0) < min) { min = load[s.id]; best = s; }
    }
    return best.id;
  },
};

// ---------- 升级者 Upgrader ----------

const Upgrader = {
  run(creep) {
    RoleUtil.toggleState(creep, STATES.UPGRADING);

    // LabManager 点名要强化 → 先去 Lab 报到（强化是一次性投入，值得绕这一趟）
    if (creep.memory._boostLabId && !creep.memory._boosted) {
      const lab = Game.getObjectById(creep.memory._boostLabId);
      if (lab && creep.pos.getRangeTo(lab.pos) > 1) {
        creep.moveTo(lab, { reusePath: CONFIG.PATH.REUSE_TICKS, visualizePathStyle: { stroke: "#ff00ff" } });
        creep.say("🧪");
        return;
      }
      if (!lab) delete creep.memory._boostLabId;
    }

    if (creep.memory.state === STATES.UPGRADING) {
      const ctrl = creep.room.controller;
      if (!ctrl) return;
      const r = creep.upgradeController(ctrl);
      if (r === ERR_NOT_IN_RANGE) {
        creep.moveTo(ctrl, { reusePath: CONFIG.PATH.REUSE_TICKS, visualizePathStyle: { stroke: "#00ff88" } });
      }
    } else {
      RoleUtil.withdraw(creep);
    }
    RoleUtil.sayState(creep);
  },
};

// ---------- 建造者 Builder ----------

const Builder = {
  run(creep) {
    RoleUtil.toggleState(creep, STATES.BUILDING);

    // 处于 HARVESTING 之外的任何状态都算"满载干活"。
    // 原来只判 BUILDING，一旦无工地被切成 UPGRADING，下一 tick 就会掉进
    // else 分支去取能量 —— 而它本来就是满的，于是永远卡在"取能量"里不再升级
    if (creep.memory.state === STATES.HARVESTING) {
      RoleUtil.withdraw(creep);
      RoleUtil.sayState(creep);
      return;
    }

    if (creep.memory.state === STATES.BUILDING) {
      const cache = RoomCache.get(creep.room.name);
      if (!cache || !cache.sites.length) {
        // 无工地时 fallback 升级
        creep.memory.state = STATES.UPGRADING;
        RoleUtil.upgradeFallback(creep);
        RoleUtil.sayState(creep);
        return;
      }

      // 建造优先级
      const priority = [
        STRUCTURE_EXTENSION, STRUCTURE_TOWER, STRUCTURE_STORAGE,
        STRUCTURE_SPAWN, STRUCTURE_CONTAINER, STRUCTURE_ROAD,
        STRUCTURE_WALL, STRUCTURE_RAMPART,
      ];
      let target = null;
      for (const p of priority) {
        target = _.find(cache.sites, s => s.structureType === p);
        if (target) break;
      }
      if (!target) target = cache.sites[0];

      const r = creep.build(target);
      if (r === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, { reusePath: CONFIG.PATH.REUSE_TICKS, visualizePathStyle: { stroke: "#ffff00" } });
      } else if (r === OK) {
        Logger.debug(creep.name, `🔨 建造${target.structureType}`,
          `进度:${((target.progress / target.progressTotal) * 100).toFixed(1)}%`);
      }
    } else {
      // UPGRADING 等 fallback 状态
      RoleUtil.upgradeFallback(creep);
    }
    RoleUtil.sayState(creep);
  },
};

// ---------- 维修者 Repairer ----------

const Repairer = {
  run(creep) {
    RoleUtil.toggleState(creep, STATES.REPAIRING);

    // 同 Builder：只有 HARVESTING 才是"去取能量"，其余都是干活状态
    if (creep.memory.state === STATES.HARVESTING) {
      RoleUtil.withdraw(creep);
      RoleUtil.sayState(creep);
      return;
    }

    if (creep.memory.state === STATES.REPAIRING) {
      const structs = Helpers.findToRepair(creep.room.name);
      if (!structs.length) {
        creep.memory.state = STATES.UPGRADING;
        RoleUtil.upgradeFallback(creep);
        RoleUtil.sayState(creep);
        return;
      }

      // 优先道路和容器
      const road = _.find(structs, s => s.structureType === STRUCTURE_ROAD);
      const cont = _.find(structs, s => s.structureType === STRUCTURE_CONTAINER);
      const target = road || cont || structs[0];

      const r = creep.repair(target);
      if (r === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, { reusePath: CONFIG.PATH.REUSE_TICKS, visualizePathStyle: { stroke: "#ff4444" } });
      } else if (r === OK) {
        Logger.debug(creep.name, `🔧 维修${target.structureType}`,
          `耐久:${((target.hits / target.hitsMax) * 100).toFixed(1)}%`);
      }
    } else {
      RoleUtil.upgradeFallback(creep);
    }
    RoleUtil.sayState(creep);
  },
};

// ---------- 运输者 Hauler ----------

const Hauler = {
  run(creep) {
    RoleUtil.toggleState(creep, STATES.HAULING);

    if (creep.memory.state === STATES.HAULING) {
      const cache = RoomCache.get(creep.room.name);
      if (!cache) { RoleUtil.sayState(creep); return; }

      // 非能量资源 → 运往 Lab（RCL6+）
      const nonEnergy = Object.keys(creep.store).find(k => k !== RESOURCE_ENERGY && creep.store[k] > 0);
      if (nonEnergy) {
        // 找不到 Lab 时必须有退路(Terminal/Storage)，否则货卸不掉 → Creep 永久卡死
        const targetLab = (cache.labs || []).find(l =>
          (l.mineralType === null || l.mineralType === nonEnergy) &&
          l.store.getFreeCapacity(nonEnergy) > 0);
        const dest = targetLab || cache.terminal || cache.storage;
        if (dest) {
          if (creep.transfer(dest, nonEnergy) === ERR_NOT_IN_RANGE)
            creep.moveTo(dest, { reusePath: CONFIG.PATH.REUSE_TICKS, visualizePathStyle: { stroke: "#ff00ff" } });
        } else {
          creep.drop(nonEnergy);   // 实在无处可放，丢掉也好过一直堵着
        }
        RoleUtil.sayState(creep);
        return;
      }

      const target = RoleUtil.findDepositTarget(cache);
      if (!target) { RoleUtil.sayState(creep); return; }
      if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE)
        creep.moveTo(target, { reusePath: CONFIG.PATH.REUSE_TICKS, visualizePathStyle: { stroke: "#ffffff" } });
    } else {
      this._pickup(creep);
    }
    RoleUtil.sayState(creep);
  },

  _pickup(creep) {
    const cache = RoomCache.get(creep.room.name);
    if (!cache) return;
    const TH = CONFIG.CONTAINER.PICKUP_THRESHOLD;

    // 1. 地上掉落的能量
    const drop = creep.pos.findClosestByRange(
      cache.dropped.filter(r => r.resourceType === RESOURCE_ENERGY && r.amount > TH)
    );
    if (drop) {
      if (creep.pickup(drop) === ERR_NOT_IN_RANGE)
        creep.moveTo(drop, { reusePath: CONFIG.PATH.REUSE_TICKS, visualizePathStyle: { stroke: "#ffaa00" } });
      return;
    }

    // 2. Container 中取能量
    const cont = creep.pos.findClosestByRange(
      cache.containers.filter(s => s.store[RESOURCE_ENERGY] > CONFIG.CONTAINER.WITHDRAW_THRESHOLD)
    );
    if (cont) {
      if (creep.withdraw(cont, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE)
        creep.moveTo(cont, { reusePath: CONFIG.PATH.REUSE_TICKS, visualizePathStyle: { stroke: "#ffaa00" } });
      return;
    }

    // 3. 实验室化合物补给 (RCL6+ 从 Terminal 取)
    //    必须排在 Storage 之前：Storage 分支一旦命中就 return，否则本段永远不会执行
    if (cache.terminal && cache.labs && cache.labs.length) {
      const compound = CONFIG.LABS.BOOST_COMPOUNDS.find(c =>
        (cache.terminal.store[c] || 0) >= 30 &&
        cache.labs.some(l => (l.mineralType === null || l.mineralType === c)
                          && (l.store[c] || 0) < CONFIG.LABS.COMPOUND_BUY_AMOUNT)
      );
      if (compound) {
        const amount = Math.min(creep.store.getFreeCapacity(compound), cache.terminal.store[compound]);
        if (amount > 0) {
          if (creep.withdraw(cache.terminal, compound, amount) === ERR_NOT_IN_RANGE)
            creep.moveTo(cache.terminal, { reusePath: CONFIG.PATH.REUSE_TICKS, visualizePathStyle: { stroke: "#ff00ff" } });
          return;
        }
      }
    }

    // 4. Storage
    if (cache.storage && cache.storage.store[RESOURCE_ENERGY] > 0) {
      if (creep.withdraw(cache.storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE)
        creep.moveTo(cache.storage, { reusePath: CONFIG.PATH.REUSE_TICKS, visualizePathStyle: { stroke: "#ffaa00" } });
      return;   // 缺 return 会和下面的分支抢同一个 tick 的 withdraw/move 意图
    }

    // 5. RCL<3 且无 Container 时的 fallback：直接去 Source 采集（避免搬运工在容器经济启动前空闲）
    if (cache.rcl < 3 && !cache.containers.length && creep.getActiveBodyparts(WORK) > 0) {
      const src = creep.pos.findClosestByRange(cache.sources.filter(s => s.energy > 0));
      if (src) {
        if (creep.harvest(src) === ERR_NOT_IN_RANGE)
          creep.moveTo(src, { reusePath: CONFIG.PATH.REUSE_TICKS, visualizePathStyle: { stroke: "#ffaa00" } });
      }
    }
  },
};

// ---------- 城墙维修 WallRepairer ----------

const WallRepairer = {
  run(creep) {
    RoleUtil.toggleState(creep, STATES.REPAIRING);

    // 同 Builder/Repairer：非 HARVESTING 一律按干活处理
    if (creep.memory.state === STATES.HARVESTING) {
      this._withdraw(creep);
      RoleUtil.sayState(creep);
      return;
    }

    if (creep.memory.state === STATES.REPAIRING) {
      const target = this._findWall(creep);
      if (!target) {
        creep.memory.state = STATES.UPGRADING;
        RoleUtil.upgradeFallback(creep);
        RoleUtil.sayState(creep);
        return;
      }
      const r = creep.repair(target);
      if (r === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, { reusePath: CONFIG.PATH.REUSE_TICKS, visualizePathStyle: { stroke: "#884400" } });
      } else if (r === OK) {
        Logger.debug(creep.name, `🧱 维修${target.structureType}`,
          `耐久:${((target.hits / target.hitsMax) * 100).toFixed(2)}%`);
      }
    } else {
      RoleUtil.upgradeFallback(creep);
    }
    RoleUtil.sayState(creep);
  },

  _findWall(creep) {
    const cache = RoomCache.get(creep.room.name);
    if (!cache) return null;
    const R = CONFIG.REPAIR;

    // 修补目标 = 血量低于 WALL_MAX_RATIO 的墙/壁垒，取最残的那个。
    // 原实现先按 WALL_MAX_RATIO(0.001) 筛出候选，再要求最残者还得低于
    // WALL_THRESHOLD(0.0001) 才肯动手 —— 两个阈值方向相反，
    // 结果墙一旦修到 0.01% 就撒手不管，筛选出来的候选几乎全被丢弃
    const candidates = [...cache.walls, ...cache.ramparts].filter(
      s => s.hits < s.hitsMax * R.WALL_MAX_RATIO
    );
    if (!candidates.length) return null;

    return _.sortBy(candidates, s => s.hits / s.hitsMax)[0];
  },

  _withdraw(creep) {
    const cache = RoomCache.get(creep.room.name);
    if (!cache) return;

    // 从 Storage 取（城墙维修耗能大）
    if (cache.storage && cache.storage.store[RESOURCE_ENERGY] > 0) {
      if (creep.withdraw(cache.storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE)
        creep.moveTo(cache.storage, { reusePath: CONFIG.PATH.REUSE_TICKS, visualizePathStyle: { stroke: "#ffaa00" } });
      return;
    }
    // 备选: Container
    const cont = creep.pos.findClosestByRange(
      cache.containers.filter(s => s.store[RESOURCE_ENERGY] > 100)
    );
    if (cont) {
      if (creep.withdraw(cont, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE)
        creep.moveTo(cont, { reusePath: CONFIG.PATH.REUSE_TICKS, visualizePathStyle: { stroke: "#ffaa00" } });
    }
  },
};

// ============================================================
//  SECTION: 远程角色
// ============================================================

// ---------- 占領者 Claimer ----------

const Claimer = {
  run(creep) {
    const targetRoom = creep.memory.targetRoom;
    if (!targetRoom) { Logger.error("Claimer", "❌ 无目标房间"); return; }

    // 移动到目标房间
    if (creep.room.name !== targetRoom) {
      const exit = creep.room.findExitTo(targetRoom);
      if (exit !== ERR_NO_PATH && exit !== ERR_INVALID_ARGS)
        creep.moveTo(creep.pos.findClosestByRange(exit), { reusePath: 50 });
      return;
    }

    // 在目标房间: 续约控制器
    const ctrl = creep.room.controller;
    if (!ctrl) return;

    // 每个分支都要 return：原实现在 reserve 成功后还会再发一次"回家"的 moveTo，
    // 同一 tick 两条互相打架的移动意图，Claimer 会在房间边界来回抖动
    const result = creep.reserveController(ctrl);
    if (result === ERR_NOT_IN_RANGE) {
      creep.moveTo(ctrl, { reusePath: CONFIG.PATH.REUSE_TICKS, visualizePathStyle: { stroke: "#ff00ff" } });
      return;
    }
    if (result === OK) {
      const ticksLeft = ctrl.reservation ? ctrl.reservation.ticksToEnd : 0;
      if (Memory.remoteRooms && Memory.remoteRooms[targetRoom]) {
        Memory.remoteRooms[targetRoom].reservedUntil = Game.time + ticksLeft;
      }
      if (Game.time % 100 === 0)
        Logger.info("远征", `🏴 续约 ${targetRoom}`, `剩余:${ticksLeft}t`);
      return;
    }
    // 控制器不可预定(已被他人占领 / 是自己的房间)
    Logger.warn("远征", `⚠️ 无法预定 ${targetRoom}`, `code:${result}`);
  },
};

// ---------- 远征运输 RemoteHauler ----------

const RemoteHauler = {
  run(creep) {
    RoleUtil.toggleState(creep, STATES.HAULING);

    if (creep.memory.state === STATES.HAULING) {
      this._returnToHome(creep);
    } else {
      this._pickupRemote(creep);
    }
    RoleUtil.sayState(creep);
  },

  _returnToHome(creep) {
    // 回家 → 存能量
    if (creep.room.name === creep.memory.homeRoom) {
      const cache = RoomCache.get(creep.room.name);
      if (!cache) return;
      // 优先存 Storage
      if (cache.storage && cache.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        if (creep.transfer(cache.storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE)
          creep.moveTo(cache.storage, { reusePath: CONFIG.PATH.REUSE_TICKS, visualizePathStyle: { stroke: "#ffffff" } });
      } else {
        const target = RoleUtil.findDepositTarget(cache);
        if (target && creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE)
          creep.moveTo(target, { reusePath: CONFIG.PATH.REUSE_TICKS, visualizePathStyle: { stroke: "#ffffff" } });
      }
    } else {
      // 跨房间回家
      const exit = creep.room.findExitTo(creep.memory.homeRoom);
      if (exit !== ERR_NO_PATH && exit !== ERR_INVALID_ARGS)
        creep.moveTo(creep.pos.findClosestByRange(exit), { reusePath: 50 });
    }
  },

  _pickupRemote(creep) {
    const targetRoom = creep.memory.targetRoom;
    if (!targetRoom) return;

    // 跨房间移动
    if (creep.room.name !== targetRoom) {
      const exit = creep.room.findExitTo(targetRoom);
      if (exit !== ERR_NO_PATH && exit !== ERR_INVALID_ARGS)
        creep.moveTo(creep.pos.findClosestByRange(exit), { reusePath: 50 });
      return;
    }

    // 在远程房间: 捡能量/取容器
    const cache = RoomCache.get(targetRoom);
    if (!cache) return;

    // 1. 地上掉落
    const drop = creep.pos.findClosestByRange(
      cache.dropped.filter(r => r.resourceType === RESOURCE_ENERGY && r.amount > CONFIG.CONTAINER.PICKUP_THRESHOLD)
    );
    if (drop) {
      if (creep.pickup(drop) === ERR_NOT_IN_RANGE)
        creep.moveTo(drop, { reusePath: CONFIG.PATH.REUSE_TICKS, visualizePathStyle: { stroke: "#ffaa00" } });
      return;
    }

    // 2. 容器 > HAUL_AMOUNT_MIN
    const cont = creep.pos.findClosestByRange(
      cache.containers.filter(c => c.store[RESOURCE_ENERGY] > CONFIG.REMOTE.HAUL_AMOUNT_MIN)
    );
    if (cont) {
      if (creep.withdraw(cont, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE)
        creep.moveTo(cont, { reusePath: CONFIG.PATH.REUSE_TICKS, visualizePathStyle: { stroke: "#ffaa00" } });
      return;
    }

    // 3. 无资源 → 回家避免空等
    const homeExit = creep.room.findExitTo(creep.memory.homeRoom);
    if (homeExit !== ERR_NO_PATH && homeExit !== ERR_INVALID_ARGS)
      creep.moveTo(creep.pos.findClosestByRange(homeExit), { reusePath: 50 });
  },
};

// ============================================================
//  SECTION: EMERGENCY — 采集者灭绝时的自救
//
//  Screeps 里 Spawn 的能量只出不进：唯一的入口是采集者把矿运回来。
//  一旦采集者全部死光、而房间剩余能量又凑不出一个新采集者(200)，
//  局面就永久锁死 —— 谁也造不出来，谁也不会去挖矿。
//  这里让任何带 WORK+CARRY 的 Creep(建造者/升级者/维修者)临时改行去挖矿送回 Spawn，
//  把能量顶回复活线以上，孵化出采集者后自动退出该模式。
// ============================================================

const Emergency = {
  /** 房间里还有没有采集者(含定点采集) */
  noHarvesters(cache) {
    if (!cache) return false;
    for (const c of cache.myCreeps)
      if (Harvester._isHarvestRole(c.memory.role)) return false;
    return true;
  },

  /** 复活一个最小采集者需要多少能量 */
  reviveCost() {
    return BodyBuilder.cost(BodyBuilder.minBody(CONFIG.ROLES.HARVESTER));
  },

  /** 是否处于"没有采集者且造不出采集者"的死锁 */
  isDeadlocked(cache) {
    if (!cache || !cache.spawns.length) return false;
    if (!this.noHarvesters(cache)) return false;
    return cache.energyAvailable < this.reviveCost();
  },

  /** 这个 Creep 能不能顶上采集者的活 */
  canRescue(creep) {
    return creep.getActiveBodyparts(WORK) > 0 && creep.store.getCapacity() > 0;
  },

  /** 临时采集者行为：挖满 → 送回 Spawn/Extension */
  run(creep, cache) {
    const hasRoom = creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
    const src = hasRoom
      ? creep.pos.findClosestByRange(cache.sources.filter(s => s.energy > 0))
      : null;

    if (src) {
      if (creep.harvest(src) === ERR_NOT_IN_RANGE)
        creep.moveTo(src, { reusePath: CONFIG.PATH.REUSE_TICKS, visualizePathStyle: { stroke: "#ff0000" } });
      creep.say("🆘挖");
      return;
    }

    if ((creep.store[RESOURCE_ENERGY] || 0) === 0) {
      creep.say("🆘等");
      return;   // 没货也挖不到，原地等 Source 刷新
    }

    // 送回 Spawn（优先），其次 Extension —— 这是唯一能解除死锁的方向
    const dest = creep.pos.findClosestByRange(
      [...cache.spawns, ...cache.extensions].filter(
        s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
      )
    );
    if (!dest) { creep.say("🆘满"); return; }
    if (creep.transfer(dest, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE)
      creep.moveTo(dest, { reusePath: CONFIG.PATH.REUSE_TICKS, visualizePathStyle: { stroke: "#ff0000" } });
    creep.say("🆘送");
  },
};

// ============================================================
//  SECTION: MANAGERS — 管理器
// ============================================================

// ---------- 孵化管理器 ----------

const SpawnManager = {
  /**
   * 角色 → POPULATION 上限键 的显式映射
   * 原来用 `MAX_${role.toUpperCase()}S` 拼接，wallRepairer→MAX_WALLREPAIRERS、
   * remoteHauler→MAX_REMOTEHAULERS 都拼错了(配置里是 MAX_WALL_REPAIRERS /
   * MAX_REMOTE_HAULERS)，取到 undefined 后上限检查被整个跳过
   */
  MAX_KEYS: {
    harvester:       "MAX_HARVESTERS",
    staticHarvester: "MAX_STATICHARVESTERS",
    upgrader:        "MAX_UPGRADERS",
    builder:         "MAX_BUILDERS",
    repairer:        "MAX_REPAIRERS",
    hauler:          "MAX_HAULERS",
    wallRepairer:    "MAX_WALL_REPAIRERS",
    claimer:         "MAX_CLAIMERS",
    remoteHauler:    "MAX_REMOTE_HAULERS",
  },

  /** @param {object} counts — 角色计数 */
  run(counts) {
    const homeRoom = Helpers.getHomeRoom();
    const cache = RoomCache.get(homeRoom);
    if (!cache || !cache.spawns.length) return;

    const rcl = cache.rcl;

    // 构建优先级队列
    const queue = this._buildQueue(counts, cache, rcl, homeRoom);
    if (!queue.length) return;

    // 遍历所有 Spawn（支持多 Spawn）
    for (const spawn of cache.spawns) {
      if (spawn.spawning) {
        const sc = Game.creeps[spawn.spawning.name];
        if (sc && CONFIG.LOG_LEVEL <= 1)
          Logger.debug("孵化", `⏳ 孵化中: ${sc.name}(${sc.memory.role})`,
            `剩余:${spawn.spawning.remainingTime}/${spawn.spawning.needTime}`);
        continue;
      }

      const item = this._popAffordable(queue, spawn);
      if (item) this._executeSpawn(spawn, item, counts);
    }
  },

  /**
   * 构建孵化优先级队列
   * @returns {Array<{role:string, priority:number, reason:string}>}
   */
  _buildQueue(counts, cache, rcl, homeRoom) {
    const P = CONFIG.POPULATION;
    const queue = [];
    const c = (r) => counts[r] || 0;

    // === T0: 关键最小数 ===
    // 基础采集者
    if (c("harvester") < P.MIN_HARVESTERS || this._needMoreHarv(counts, cache)) {
      queue.push({ role: "harvester", priority: 0, reason: "min_harvester" });
    }
    // 定点采集（每个 Source 一个）— 仅在 Source Container 就位后生成
    const sourceContainersReady = cache.sources.every(src =>
      src.pos.findInRange(cache.containers, 1).length > 0 ||
      cache.sites.some(s => s.structureType === STRUCTURE_CONTAINER && s.pos.getRangeTo(src) <= 1)
    );
    if (cache && rcl >= CONFIG.CONTAINER.ENABLE_AT_RCL && sourceContainersReady && c("staticHarvester") < cache.sources.length) {
      queue.push({ role: "staticHarvester", priority: 0, reason: "min_static" });
    }
    // 运输者
    if (cache && rcl >= CONFIG.CONTAINER.ENABLE_AT_RCL && c("hauler") < P.MIN_HAULERS) {
      queue.push({ role: "hauler", priority: 0, reason: "min_hauler" });
    }
    // 升级者
    if (c("upgrader") < P.MIN_UPGRADERS) {
      queue.push({ role: "upgrader", priority: 0, reason: "min_upgrader" });
    }

    // === T1: 预生成替换（即将死亡的关键 Creep）===
    this._checkPreSpawn(queue, cache);

    // === T2: 填充到上限 ===
    // 建造者（有工地时）
    const sites = cache ? cache.sites : [];
    if (sites.length && c("builder") < P.MAX_BUILDERS) {
      if (!Memory._lastSiteCount || Memory._lastSiteCount !== sites.length) {
        Logger.info("孵化", `🏗️ ${sites.length}个工地`);
        Memory._lastSiteCount = sites.length;
      }
      queue.push({ role: "builder", priority: 2, reason: "sites" });
    } else { Memory._lastSiteCount = 0; }

    // 维修者（有道路损坏时）
    const damaged = Helpers.findToRepair(homeRoom);
    const roads = damaged.filter(s => s.structureType === STRUCTURE_ROAD);
    if (roads.length && c("repairer") < P.MAX_REPAIRERS) {
      if (!Memory._lastRoadCount || Memory._lastRoadCount !== roads.length) {
        Logger.info("孵化", `🔧 ${roads.length}条道路需维修`);
        Memory._lastRoadCount = roads.length;
      }
      queue.push({ role: "repairer", priority: 2, reason: "damaged" });
    } else { Memory._lastRoadCount = 0; }

    // 运输者补充
    if (c("hauler") < P.MAX_HAULERS) {
      queue.push({ role: "hauler", priority: 3, reason: "fill_hauler" });
    }
    // 城墙维修（RCL 3+）
    if (rcl >= 3 && c("wallRepairer") < P.MAX_WALL_REPAIRERS) {
      queue.push({ role: "wallRepairer", priority: 3, reason: "wall" });
    }
    // 升级者补充 (从 P4 改为 P2，与建造者同级，避免 RCL 升级停滞)
    if (c("upgrader") < P.MAX_UPGRADERS) {
      queue.push({ role: "upgrader", priority: 2, reason: "fill_upgrader" });
    }

    // === T3: 远程角色（由 RemoteManager 启用后激活）===
    const hasRemote = Memory.remoteRooms && Object.keys(Memory.remoteRooms).length > 0;
    if (hasRemote) {
      if (c("claimer") < P.MAX_CLAIMERS) {
        queue.push({ role: "claimer", priority: 1, reason: "remote_claim" });
      }
      if (c("remoteHauler") < P.MAX_REMOTE_HAULERS) {
        queue.push({ role: "remoteHauler", priority: 2, reason: "remote_haul" });
      }
    }

    // 按优先级排序（数字越小越优先）
    return _.sortBy(queue, q => q.priority);
  },

  /**
   * 检测即将死亡的关键 Creep，加入预生成队列
   */
  _checkPreSpawn(queue, cache) {
    const T = CONFIG.SPAWN.PRE_SPAWN_TICKS;
    const CRITICAL = ["harvester", "staticHarvester", "upgrader", "hauler"];
    for (const creep of cache.myCreeps) {
      if (!creep.ticksToLive || creep.ticksToLive > T) continue;
      const role = creep.memory.role;
      if (CRITICAL.includes(role)) {
        queue.push({ role, priority: 1, reason: "pre_spawn" });
      }
    }
  },

  /**
   * 从队列中弹出第一个可承受的孵化任务
   * @returns {{role:string, body:Array, cost:number}|null}
   */
  _popAffordable(queue, spawn) {
    const available = spawn.room.energyAvailable;
    const capacity = spawn.room.energyCapacityAvailable;
    const hasPendingP0 = queue.some(q => q.priority <= 0);
    const hasPendingP1 = queue.some(q => q.priority === 1);

    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];

      // P0 = 最低生存需求(采集者/升级者)。只要还有 P0 没被满足，其余角色一律不许动能量。
      // 原来只是"保留 300"，建造者照样能在能量充裕时抢先孵化；等采集者老死时
      // Spawn 已被榨干，凑不出复活所需的 200 → 房间永久死锁
      if (hasPendingP0 && item.priority > 0) continue;

      // 其次：预生成替换(P1)未完成前，填充类角色要给它留够能量
      const reserve = (item.priority >= 2 && hasPendingP1) ? CONFIG.SPAWN.ENERGY_RESERVE : 0;
      const usable = Math.max(available - reserve, 0);

      // 1. 尝试满容量身体
      let body = BodyBuilder.build(capacity, item.role);
      let cost = BodyBuilder.cost(body);
      if (cost > usable) {
        // 2. 满容量不够 → 用可用能量缩水
        body = BodyBuilder.build(usable, item.role);
        cost = BodyBuilder.cost(body);
      }
      if (cost > usable) {
        // 3. 缩水后还不够 → 按角色的最小可用身体保底
        //    (不能一律用 [WORK,CARRY,MOVE]：那样孵出来的 claimer 没有 CLAIM 部件)
        const fallback = BodyBuilder.minBody(item.role);
        const fbCost = BodyBuilder.cost(fallback);
        if (fbCost <= usable) {
          body = fallback;
          cost = fbCost;
          Logger.info("孵化", `💪 紧急降级${this._label(item.role)}`, `保底:${cost}`);
        } else {
          Logger.debug("孵化", `💰 能量不足生成${this._label(item.role)}`, `需${cost} 有${usable}`);
          continue;
        }
      }

      queue.splice(i, 1);
      return { role: item.role, body, cost, reason: item.reason };
    }
    return null;
  },

  /**
   * 执行孵化
   */
  _executeSpawn(spawn, item, counts) {
    const { role, body, cost, reason } = item;
    const max = CONFIG.POPULATION[this.MAX_KEYS[role]];
    // 预生成是给"即将死亡的 Creep"顶班的，此刻旧 Creep 还活着并占着名额，
    // 用原上限一卡，满编角色的预生成就永远排不进来 → 允许临时 +1
    const limit = (max !== undefined && reason === "pre_spawn") ? max + 1 : max;
    if (limit !== undefined && (counts[role] || 0) >= limit) return false;

    const memory = this._initialMemory(role);
    if (!memory) return false;   // 远程角色没有目标房间 → 别浪费能量

    const name = Helpers.genName(role);
    let result = spawn.spawnCreep(body, name, { memory });

    if (result === ERR_NOT_ENOUGH_ENERGY) {
      // 保底身体同样要按角色区分
      const fallback = BodyBuilder.minBody(role);
      const fbCost = BodyBuilder.cost(fallback);
      if (fbCost <= spawn.room.energyAvailable) {
        result = spawn.spawnCreep(fallback, name, { memory });
        if (result === OK)
          Logger.warn("孵化", `🐣 紧急${this._label(role)}"${name}"`, `保底:${fbCost}`);
      }
    }

    if (result === OK) {
      // 计数就地 +1：多 Spawn 同 tick 孵化时，不更新会双双越过人口上限
      counts[role] = (counts[role] || 0) + 1;
      Logger.info("孵化", `🐣 ${this._label(role)}"${name}"`,
        `部件:${body.length} | 成本:${cost} | 能量:${spawn.room.energyAvailable}/${spawn.room.energyCapacityAvailable}`);
      Notifier.onCreepSpawned();
      return true;
    }
    return false;
  },

  /** 初始 Memory —— 远程角色必须带上 targetRoom，否则孵出来就是废人 */
  _initialMemory(role) {
    const memory = { role, state: STATES.HARVESTING, homeRoom: Helpers.getHomeRoom() };
    if (role === CONFIG.ROLES.CLAIMER || role === CONFIG.ROLES.REMOTE_HAULER) {
      const targetRoom = this._pickRemoteRoom(role);
      if (!targetRoom) return null;
      memory.targetRoom = targetRoom;
    }
    return memory;
  },

  /** 挑一个远程房间：Claimer 挑最快到期的，RemoteHauler 挑人最少的 */
  _pickRemoteRoom(role) {
    if (!Memory.remoteRooms) return null;
    const names = Object.keys(Memory.remoteRooms);
    if (!names.length) return null;

    if (role === CONFIG.ROLES.CLAIMER)
      return _.min(names, rn => Memory.remoteRooms[rn].reservedUntil || 0);

    const load = {};
    for (const rn of names) load[rn] = 0;
    for (const cn in Game.creeps) {
      const m = Game.creeps[cn].memory;
      if (m.role === role && m.targetRoom && load[m.targetRoom] !== undefined)
        load[m.targetRoom]++;
    }
    return _.min(names, rn => load[rn]);
  },

  _needMoreHarv(counts, cache) {
    const h = counts.harvester || 0;
    const sh = counts.staticHarvester || 0;
    if (h + sh >= CONFIG.POPULATION.MAX_HARVESTERS) return false;
    if (sh > 0 && h >= 1) return false;
    // 已有 2 个移动采集者 → 不再追加，留给升级者和建造者
    if (h >= 2) return false;

    // 物理容量：每个 Source ~5 个可采位置（含固定采集）
    if (cache && cache.sources.length > 0) {
      const maxAtSources = cache.sources.length * 5;
      if (h + sh >= maxAtSources) return false;
    }

    const total = _.sum(Object.values(counts));
    if (total > 0 && (h + sh) / total < 0.25) return true;
    return h < 1;
  },

  _label(r) {
    const m = {
      harvester: "采集者", staticHarvester: "定点采集", upgrader: "升级者",
      builder: "建造者", repairer: "维修者", hauler: "运输者", wallRepairer: "城墙维修",
      claimer: "占领者", remoteHauler: "远征运输",
    };
    return m[r] || r;
  },
};

// ---------- 防御塔管理器 ----------

const TowerManager = {
  run() {
    const cache = RoomCache.get(Helpers.getHomeRoom());
    if (!cache || !cache.towers.length) return;

    Logger.debug("防御塔", `🛡️ 管理${cache.towers.length}座塔`);

    for (const tower of cache.towers) {
      if (tower.store[RESOURCE_ENERGY] < 10) continue;

      // 优先级 1: 攻击敌人
      if (this._attack(tower, cache.hostiles)) continue;

      // 优先级 2: 治疗己方 Creep
      if (this._heal(tower, cache.myCreeps)) continue;

      // 优先级 3: 维修 (CPU 紧急时跳过)
      if (!CPUGovernor.shouldSkipTowerUtil())
        this._repair(tower, cache);
    }
  },

  _attack(tower, hostiles) {
    if (!hostiles.length) return false;

    // 优先攻击有 HEAL 部件的敌人
    const target = _.max(hostiles, h =>
      _.filter(h.body, p => p.type === HEAL).length * 3 +
      _.filter(h.body, p => p.type === ATTACK || p.type === RANGED_ATTACK).length * 2
    );
    if (target && tower.attack(target) === OK) {
      Logger.warn("防御塔", `⚔️ 攻击:${target.name}`,
        `归属:${target.owner.username} | 生命:${target.hits}/${target.hitsMax}`);
      return true;
    }
    return false;
  },

  _heal(tower, myCreeps) {
    const injured = myCreeps.filter(c => c.hits < c.hitsMax);
    if (!injured.length) return false;

    const target = _.min(injured, c => c.hits / c.hitsMax);
    if (target && target.hits / target.hitsMax < 0.8 && tower.heal(target) === OK) {
      Logger.debug("防御塔", `💚 治疗:${target.name}`,
        `生命:${((target.hits / target.hitsMax) * 100).toFixed(0)}%`);
      return true;
    }
    return false;
  },

  _repair(tower, cache) {
    if (tower.store[RESOURCE_ENERGY] < CONFIG.ENERGY.TOWER_MIN_ENERGY) return false;

    // 优先维修道路
    const brokenRoad = _.find(cache.roads, s => s.hits < s.hitsMax * 0.5);
    if (brokenRoad) { tower.repair(brokenRoad); return true; }

    // 其次维修容器
    const brokenCont = _.find(cache.containers, s => s.hits < s.hitsMax * 0.5);
    if (brokenCont) { tower.repair(brokenCont); return true; }

    return false;
  },
};

// ---------- Link 网络管理器 ----------

const LinkManager = {
  run(cache) {
    if (!cache || cache.rcl < CONFIG.LINKS.ENABLED_AT_RCL) return;
    if (!cache.links || cache.links.length < 2) return;

    const ctrlLink = this._findControllerLink(cache);
    if (!ctrlLink) return;
    const srcLinks = this._findSourceLinks(cache, ctrlLink);
    if (!srcLinks.length) return;

    for (const src of srcLinks) {
      if (src.cooldown > 0) continue;
      if (src.store[RESOURCE_ENERGY] < CONFIG.LINKS.SEND_THRESHOLD) continue;
      if (ctrlLink.store.getFreeCapacity(RESOURCE_ENERGY) < 100) continue;
      if (ctrlLink.store[RESOURCE_ENERGY] >= CONFIG.LINKS.RECEIVE_MAX) continue;
      src.transferEnergy(ctrlLink);
    }
  },

  _findSourceLinks(cache, ctrlLink) {
    const R = CONFIG.LINKS.SOURCE_RANGE;
    // 必须排除 Controller Link 自己：Source 和 Controller 挨得近时它会同时命中两边，
    // 于是出现 link.transferEnergy(自己) 这种必然失败的调用
    return cache.links.filter(link =>
      (!ctrlLink || link.id !== ctrlLink.id) &&
      cache.sources.some(src => src.pos.getRangeTo(link.pos) <= R)
    );
  },

  _findControllerLink(cache) {
    const ctrl = cache.controller;
    if (!ctrl) return null;
    const R = CONFIG.LINKS.CONTROLLER_RANGE;
    return cache.links.find(link => link.pos.getRangeTo(ctrl.pos) <= R) || null;
  },
};

// ---------- 市场交易管理器 ----------

const MarketManager = {
  run(cache, homeRoom) {
    if (!cache || cache.rcl < CONFIG.MARKET.ENABLED_AT_RCL) return;
    if (!cache.terminal || !cache.storage) return;
    if (cache.terminal.cooldown > 0) return;

    // 节流: 每 TRADE_INTERVAL tick 扫一次市场
    // 关键是这里就要记账，而不是等成交才记 —— 否则一旦没有合适订单，
    // 每个 tick 都会调用 Game.market.getAllOrders()，这是全脚本最贵的一个 API
    if (!Memory._lastTradeTick) Memory._lastTradeTick = 0;
    if (Game.time - Memory._lastTradeTick < CONFIG.MARKET.TRADE_INTERVAL) return;
    Memory._lastTradeTick = Game.time;

    this._buyEnergy(cache, homeRoom);
    this._sellMinerals(cache, homeRoom);
  },

  _buyEnergy(cache, homeRoom) {
    const M = CONFIG.MARKET;
    const storageEnergy = cache.storage ? cache.storage.store[RESOURCE_ENERGY] : 0;
    if (storageEnergy >= M.ENERGY_BUY_THRESHOLD) return;
    if (cache.terminal.store[RESOURCE_ENERGY] < M.TERMINAL_ENERGY_RESERVE) return;

    // 找 sell orders 中价格合格的
    const orders = Game.market.getAllOrders(o =>
      o.resourceType === RESOURCE_ENERGY &&
      o.type === ORDER_SELL &&
      o.price >= M.ENERGY_BUY_MIN &&
      o.price <= M.ENERGY_BUY_MAX &&
      o.amount >= M.ENERGY_BUY_AMOUNT
    );
    if (!orders.length) return;

    const best = _.min(orders, o => o.price);
    const totalCost = best.price * M.ENERGY_BUY_AMOUNT;
    if (Game.market.credits < totalCost) return;

    const result = Game.market.deal(best.id, M.ENERGY_BUY_AMOUNT, homeRoom);
    if (result === OK) {
      Logger.info("市场", `💰 买入 ${M.ENERGY_BUY_AMOUNT} 能量`, `单价:${best.price.toFixed(3)}`);
      this._recordTrade("buy_energy", RESOURCE_ENERGY, best.price, M.ENERGY_BUY_AMOUNT);
    } else {
      Logger.debug("市场", "买入失败", `code:${result}`);
    }
  },

  _sellMinerals(cache, homeRoom) {
    const M = CONFIG.MARKET;
    const storage = cache.storage, terminal = cache.terminal;

    // 检查 Storage 填充率
    // storeCapacity 是已废弃属性，取到 undefined 会让 fillRatio 变 NaN，
    // 而 `NaN < 阈值` 恒为 false —— 于是这道闸门形同虚设，永远放行
    const capacity = storage.store.getCapacity();
    if (!capacity) return;
    const fillRatio = storage.store.getUsedCapacity() / capacity;
    if (fillRatio < M.STORAGE_SELL_THRESHOLD) return;

    // 只能卖 Terminal 里的货：Game.market.deal 是从 Terminal 发货的，
    // 原实现按 Storage 库存挑货和算量，货没搬进 Terminal 时必定 ERR_NOT_ENOUGH_RESOURCES
    const minerals = Object.keys(terminal.store).filter(k =>
      k !== RESOURCE_ENERGY && terminal.store[k] >= 100
    );
    if (!minerals.length) return;

    const mineral = _.max(minerals, k => terminal.store[k]);
    const orders = Game.market.getAllOrders(o =>
      o.resourceType === mineral &&
      o.type === ORDER_BUY &&
      o.price >= M.MINERAL_SELL_MIN
    );
    if (!orders.length) return;

    const best = _.max(orders, o => o.price);
    const amount = Math.min(M.MINERAL_SELL_AMOUNT, best.amount, terminal.store[mineral]);
    if (amount <= 0) return;
    const result = Game.market.deal(best.id, amount, homeRoom);
    if (result === OK) {
      Logger.info("市场", `💎 卖出 ${amount} ${mineral}`, `单价:${best.price.toFixed(3)}`);
      this._recordTrade("sell", mineral, best.price, amount);
    } else {
      Logger.debug("市场", "卖出失败", `code:${result}`);
    }
  },

  _recordTrade(type, resource, price, amount) {
    if (!Memory._trades) Memory._trades = [];
    Memory._trades.push({ tick: Game.time, type, resource, price, amount });
    if (Memory._trades.length > 20) Memory._trades.shift();
  },
};

// ---------- 远征探测 RemoteMonitor ----------

const RemoteMonitor = {
  /** 扫描 remote_* flags 注册远程房间 */
  run(homeRoom) {
    if (!Memory.remoteRooms) Memory.remoteRooms = {};

    const flags = _.filter(Game.flags, f => f.name.startsWith(CONFIG.REMOTE.CLAIM_FLAG_PREFIX));
    for (const flag of flags) {
      const roomName = flag.pos.roomName;
      if (roomName === homeRoom) continue;
      if (!Memory.remoteRooms[roomName]) {
        Memory.remoteRooms[roomName] = {
          flagName: flag.name,
          reservedUntil: 0,
          sources: [],
          containerIds: [],
        };
        Logger.info("远征", `📡 注册远程房间 ${roomName}`);
      }
    }

    // 清理已删除 flag 的房间记录
    for (const rn of Object.keys(Memory.remoteRooms)) {
      if (!flags.find(f => f.pos.roomName === rn)) {
        delete Memory.remoteRooms[rn];
        Logger.info("远征", `🧹 清除远程房间 ${rn}`);
      }
    }
  },

  /** 刷新远程房间缓存（如可见） */
  refreshCache(roomName) {
    const room = Game.rooms[roomName];
    if (!room) return null;
    RoomCache.refresh(room);
    const rc = RoomCache.get(roomName);
    if (rc && Memory.remoteRooms[roomName]) {
      Memory.remoteRooms[roomName].sources = rc.sources.map(s => s.id);
      Memory.remoteRooms[roomName].containerIds = rc.containers.map(c => c.id);
    }
    return rc;
  },
};

// ---------- 远征管理器 RemoteManager ----------

const RemoteManager = {
  run(homeRoom) {
    const M = CONFIG.REMOTE;
    const cache = RoomCache.get(homeRoom);
    if (!cache) return;

    // Storage 能量不足 → 不出征
    const storageEnergy = cache.storage ? cache.storage.store[RESOURCE_ENERGY] : 0;
    if (storageEnergy < M.MIN_STORAGE_ENERGY) return;
    if (!Memory.remoteRooms) return;

    for (const [roomName, data] of Object.entries(Memory.remoteRooms)) {
      // 尝试刷新远程房间缓存
      RemoteMonitor.refreshCache(roomName);

      // 进度日志
      if (Game.time % 200 === 0) {
        Logger.debug("远征", `🏁 ${roomName}`, `续约剩余:${data.reservedUntil - Game.time}t`);
      }
    }
  },
};

// ---------- 实验室管理器 LabManager ----------

const LabManager = {
  run(cache, homeRoom) {
    if (!cache || cache.rcl < CONFIG.LABS.ENABLED_AT_RCL) return;

    // 1. 规划 Lab 位置
    this._planLabs(cache, homeRoom);

    // 无 Lab 时跳过后续
    if (!cache.labs || !cache.labs.length) return;

    // 2. 购买化合物
    this._buyCompounds(cache, homeRoom);

    // 3. Boost Upgraders
    this._boostUpgraders(cache);
  },

  _planLabs(cache, homeRoom) {
    const ctrl = cache.controller;
    if (!ctrl || !ctrl.my) return;
    const labCount = cache.labs.length;
    const siteCount = cache.sites.filter(s => s.structureType === STRUCTURE_LAB).length;
    if (labCount + siteCount >= CONFIG.LABS.MIN_LABS) return;

    const room = Game.rooms[homeRoom];
    if (!room) return;
    const terrain = room.getTerrain();
    const R = CONFIG.LABS.LAB_RANGE;

    for (let dx = -R; dx <= R; dx++) {
      for (let dy = -R; dy <= R; dy++) {
        const px = ctrl.pos.x + dx, py = ctrl.pos.y + dy;
        if (px < 1 || px > 48 || py < 1 || py > 48) continue;
        if (terrain.get(px, py) === TERRAIN_MASK_WALL) continue;
        const blocked = cache.myStructures.some(s => s.pos.x === px && s.pos.y === py)
          || cache.sites.some(s => s.pos.x === px && s.pos.y === py);
        if (blocked) continue;
        room.createConstructionSite(px, py, STRUCTURE_LAB);
        Logger.info("实验室", "🔬 放置 Lab 工地");
        return;
      }
    }
  },

  _buyCompounds(cache, homeRoom) {
    if (!cache.terminal || cache.terminal.cooldown > 0) return;
    if (Game.time % 200 !== 0) return;

    const L = CONFIG.LABS;
    for (const compound of L.BOOST_COMPOUNDS) {
      const inTerminal = cache.terminal.store[compound] || 0;
      const inStorage = cache.storage ? (cache.storage.store[compound] || 0) : 0;
      const inLabs = _.sum(cache.labs, l => l.store[compound] || 0);
      if (inTerminal + inStorage + inLabs >= L.COMPOUND_BUY_AMOUNT) continue;

      const orders = Game.market.getAllOrders(o =>
        o.resourceType === compound &&
        o.type === ORDER_SELL &&
        o.price <= L.COMPOUND_BUY_MAX &&
        o.amount >= 100
      );
      if (!orders.length) continue;
      const best = _.min(orders, o => o.price);
      const amount = Math.min(L.COMPOUND_BUY_AMOUNT, best.amount);
      Game.market.deal(best.id, amount, homeRoom);
      Logger.info("实验室", `🛒 购买 ${amount} ${compound}`, `单价:${best.price.toFixed(3)}`);
      break;
    }
  },

  _boostUpgraders(cache) {
    const storageEnergy = cache.storage ? cache.storage.store[RESOURCE_ENERGY] : 0;
    if (storageEnergy < CONFIG.LABS.BOOST_MIN_ENERGY) return;

    // 找有化合物的 Lab
    for (const lab of cache.labs) {
      const compound = CONFIG.LABS.BOOST_COMPOUNDS.find(c => lab.mineralType === c);
      if (!compound || (lab.store[compound] || 0) < 30) continue;
      if (lab.store[RESOURCE_ENERGY] < 20) continue;   // boostCreep 还要耗能量

      // 每个 Lab 每 tick 只招呼一个最近的未强化 Upgrader，
      // 原实现对所有 Upgrader 挨个发 moveTo，等于让全体升级者集体罢工去排队
      const candidates = cache.myCreeps.filter(c =>
        c.memory.role === CONFIG.ROLES.UPGRADER && !c.memory._boosted &&
        c.getActiveBodyparts(WORK) > 0
      );
      if (!candidates.length) continue;

      const creep = lab.pos.findClosestByRange(candidates);
      if (!creep) continue;

      if (creep.pos.getRangeTo(lab.pos) > 1) {
        // 用 Memory 标记而不是直接 moveTo：本管理器在 _runAllCreeps 之前/之后运行都可能
        // 被角色自身的移动覆盖，交给 Upgrader 自己走过来才稳
        creep.memory._boostLabId = lab.id;
        continue;
      }
      const result = lab.boostCreep(creep);
      if (result === OK) {
        creep.memory._boosted = true;
        delete creep.memory._boostLabId;
        Logger.info("实验室", `🧪 强化 ${creep.name}`, `化合物:${compound}`);
      } else if (result === ERR_NOT_ENOUGH_RESOURCES) {
        delete creep.memory._boostLabId;
      }
    }
  },
};

// ---------- 房间管理器 ----------

const RoomManager = {
  /** @param {object} counts — 角色计数（从 loop 传入复用） */
  run(counts) {
    const hr = Helpers.getHomeRoom();
    const cache = RoomCache.get(hr);

    if (!cache) { Logger.warn("房间", `⚠️ 无法观察${hr}`); return; }

    const es = cache.energyCapacityAvailable > 0
      ? cache.energyAvailable / cache.energyCapacityAvailable : 0;

    // 能量预警 + 低能邮件通知
    // 必须是"持续"低于 15% 才发信：每次孵化都会把 energyAvailable 抽干，
    // 原实现见低就报，等于把正常的孵化波谷当成告警
    if (es <= 0.15) {
      if (!Memory._lowEnergySince) Memory._lowEnergySince = Game.time;
      if (!CPUGovernor.shouldSkipInfoLog() && Game.time % 100 === 0)
        Logger.warn("房间", `🔴 能量严重不足:${cache.energyAvailable}/${cache.energyCapacityAvailable}`);
      if (CONFIG.NOTIFY.ON_LOW_ENERGY &&
          Game.time - Memory._lowEnergySince >= CONFIG.NOTIFY.LOW_ENERGY_TICKS)
        Notifier.onLowEnergy(cache.energyAvailable, cache.energyCapacityAvailable);
    } else {
      delete Memory._lowEnergySince;
      Notifier.onLowEnergyClear();
    }
    if (es > 0.15 && es <= 0.3) {
      if (!CPUGovernor.shouldSkipInfoLog() && Game.time % 100 === 0)
        Logger.info("房间", `🟡 能量偏低:${cache.energyAvailable}/${cache.energyCapacityAvailable}`);
    }

    // 定期报告
    if (Game.time % 100 === 0 && cache.controller && cache.controller.my) {
      const c = cache.controller;
      Logger.info("房间", `🏛️ RCL${c.level}`,
        `升级:${((c.progress / c.progressTotal) * 100).toFixed(1)}% | 降级:${c.ticksToDowngrade}ticks`);
      if (c.ticksToDowngrade < 5000)
        Logger.warn("房间", `⚠️ 即将降级！剩余${c.ticksToDowngrade}ticks`);
    }

    // 敌对检测
    if (cache.hostiles.length) {
      if (!Memory._hadHostiles) {
        Logger.warn("房间", `🚨 ${cache.hostiles.length}个敌对Creep！`);
        if (CONFIG.NOTIFY.ON_HOSTILES) Notifier.onHostiles(cache.hostiles.length);
      }
      Memory._hadHostiles = true;
      if (cache.controller && cache.controller.my &&
          cache.controller.safeModeAvailable > 0 && !cache.controller.safeMode) {
        if (cache.controller.activateSafeMode() === OK)
          Logger.warn("房间", "🛡️ 安全模式已激活！");
      }
    } else if (Memory._hadHostiles) {
      Memory._hadHostiles = false;
      Notifier.onHostilesClear();
    }

    // Spawn 健康检查
    if (cache.spawns.length) {
      const sp = cache.spawns[0];
      if (sp.hits < sp.hitsMax * 0.5)
        Logger.warn("房间", `⚠️ Spawn受损:${sp.hits}/${sp.hitsMax}`);
    }

    // Controller Container 自动放置 (RCL2+)
    this._planControllerContainer(cache);
    // Source Container 自动放置 (RCL2+) — 容器经济的基础设施
    this._planSourceContainers(cache);

    // 调试可视化 (CPU 降级时跳过)
    if (CONFIG.LOG_LEVEL <= 0 && !CPUGovernor.shouldSkipVisual()) {
      const v = cache.controller ? cache.controller.room.visual : null;
      if (!v) return;

      for (const s of cache.sources) {
        v.text(`⛏️`, s.pos.x, s.pos.y - 1,
          { color: "#ffaa00", fontSize: 0.5, align: "center" });
      }
      for (const s of cache.spawns) {
        v.text("🐣", s.pos.x, s.pos.y - 1,
          { color: "#00ff00", fontSize: 0.5, align: "center" });
      }
      if (cache.controller && cache.controller.my) {
        v.text(`🏛️RCL${cache.rcl}`, cache.controller.pos.x, cache.controller.pos.y - 1,
          { color: "#00ffff", fontSize: 0.6, align: "center" });
      }
    }
  },

  /** 在 Controller 旁自动放置 Container（RCL2+） */
  _planControllerContainer(cache) {
    const ctrl = cache.controller;
    if (!ctrl || !ctrl.my) return;
    if (cache.rcl < 2) return;

    // 已有 Controller 近旁的 Container → 跳过
    const nearbyCont = ctrl.pos.findInRange(cache.containers, 3);
    if (nearbyCont.length > 0) return;

    // 已有工地 → 跳过
    const hasSite = cache.sites.some(s =>
      s.structureType === STRUCTURE_CONTAINER && s.pos.getRangeTo(ctrl) <= 3
    );
    if (hasSite) return;

    // 选取最优位置: Controller 2 格内，非墙、非建筑
    const room = Game.rooms[ctrl.room.name];
    const terrain = room.getTerrain();
    const candidates = [];
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const px = ctrl.pos.x + dx, py = ctrl.pos.y + dy;
        if (px < 1 || px > 48 || py < 1 || py > 48) continue;
        if (terrain.get(px, py) === TERRAIN_MASK_WALL) continue;
        const blocked = cache.myStructures.some(s => s.pos.x === px && s.pos.y === py)
          || cache.sites.some(s => s.pos.x === px && s.pos.y === py);
        if (blocked) continue;
        candidates.push(new RoomPosition(px, py, room.name));
      }
    }
    candidates.sort((a, b) => a.getRangeTo(ctrl) - b.getRangeTo(ctrl));
    const best = candidates.find(c => c.getRangeTo(ctrl) >= 1);
    if (best) {
      room.createConstructionSite(best, STRUCTURE_CONTAINER);
      Logger.info("建造", "📦 已放置 Controller Container 工地");
    }
  },

  /** 在 Source 旁自动放置 Container（RCL2+）— 容器经济基础设施 */
  _planSourceContainers(cache) {
    if (cache.rcl < 2) return;
    const room = Game.rooms[cache.controller.room.name];
    if (!room) return;
    const terrain = room.getTerrain();

    for (const src of cache.sources) {
      // 已有 Source 旁的 Container → 跳过
      const nearCont = src.pos.findInRange(cache.containers, 1);
      if (nearCont.length > 0) continue;

      // 已有 Container 工地 → 跳过
      const hasSite = cache.sites.some(s =>
        s.structureType === STRUCTURE_CONTAINER && s.pos.getRangeTo(src) <= 1
      );
      if (hasSite) continue;

      // 在 Source 1 格范围内找空地
      const candidates = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;   // Source 自己那格建不了东西
          const px = src.pos.x + dx, py = src.pos.y + dy;
          if (px < 1 || px > 48 || py < 1 || py > 48) continue;
          if (terrain.get(px, py) === TERRAIN_MASK_WALL) continue;
          const blocked = cache.myStructures.some(s => s.pos.x === px && s.pos.y === py)
            || cache.sites.some(s => s.pos.x === px && s.pos.y === py);
          if (blocked) continue;
          candidates.push(new RoomPosition(px, py, room.name));
        }
      }
      if (candidates.length > 0) {
        // 挑离 Spawn 最近的一格，缩短搬运工往返距离
        const spawn = cache.spawns[0];
        const best = spawn
          ? _.min(candidates, p => p.getRangeTo(spawn.pos))
          : candidates[0];
        // 检查返回值再打日志，否则失败时会每 tick 谎报一次"已放置"
        if (room.createConstructionSite(best, STRUCTURE_CONTAINER) === OK)
          Logger.info("建造", `📦 已放置 Source Container 工地 @(${best.x},${best.y})`);
      }
    }
  },
};

// ============================================================
//  SECTION: STATS_TRACKER — 统计数据追踪
//  记录能量、RCL 等历史数据，用于计算效率和 ETA
// ============================================================

const StatsTracker = {
  /** 每个 tick 记录一次快照 */
  record(roomName) {
    if (!Memory.stats) Memory.stats = {};
    const s = Memory.stats;
    const cache = RoomCache.get(roomName);
    if (!cache) return;

    // RCL 升级进度追踪 (保留最近 50 tick)
    if (cache.controller && cache.controller.my) {
      if (!s.rclLog) s.rclLog = [];
      const rclPrev = s.rclLog.length ? s.rclLog[s.rclLog.length - 1] : null;
      if (!rclPrev || rclPrev.p !== cache.controller.progress || Game.time - rclPrev.t >= 5) {
        s.rclLog.push({ t: Game.time, p: cache.controller.progress, total: cache.controller.progressTotal,
          level: cache.rcl, ticksToDowngrade: cache.controller.ticksToDowngrade });
        if (s.rclLog.length > 50) s.rclLog.shift();
      }
    }

    // GCL 追踪 (保留最近 100 tick)
    if (!s.gclLog) s.gclLog = [];
    const gclPrev = s.gclLog.length ? s.gclLog[s.gclLog.length - 1] : null;
    if (!gclPrev || gclPrev.p !== Game.gcl.progress || Game.time - gclPrev.t >= 10) {
      s.gclLog.push({ t: Game.time, p: Game.gcl.progress, total: Game.gcl.progressTotal, level: Game.gcl.level });
      if (s.gclLog.length > 100) s.gclLog.shift();
    }

    // 能量追踪 (保留最近 100 tick)
    if (!s.energyLog) s.energyLog = [];
    s.energyLog.push({ t: Game.time, e: cache.energyAvailable, c: cache.energyCapacityAvailable });
    if (s.energyLog.length > 100) s.energyLog.shift();

    // Spawn 活跃度追踪
    if (!s.spawnActivity) s.spawnActivity = { ticks: 0, spawning: 0 };
    s.spawnActivity.ticks++;
    for (const _sn in Game.spawns) {
      if (Game.spawns[_sn].spawning) { s.spawnActivity.spawning++; break; }
    }
  },

  /** 能量净变化率 */
  energyRate() {
    const log = Memory.stats?.energyLog;
    if (!log || log.length < 20) return null;
    const half = Math.floor(log.length / 2);
    const older = log.slice(0, half);
    const newer = log.slice(half);
    const avgOld = _.sum(older, p => p.e) / older.length;
    const avgNew = _.sum(newer, p => p.e) / newer.length;
    const dt = newer[newer.length - 1].t - older[0].t;
    return dt > 0 ? (avgNew - avgOld) / (dt / 2) : null;
  },

  /** RCL 升级 ETA (tick) */
  rclETA() {
    return this._eta(Memory.stats?.rclLog);
  },

  /** GCL 升级 ETA (tick) */
  gclETA() {
    return this._eta(Memory.stats?.gclLog);
  },

  /** 从进度日志计算 ETA */
  _eta(log) {
    if (!log || log.length < 3) return null;
    const samples = log.slice(-10);
    const first = samples[0], last = samples[samples.length - 1];
    const dt = last.t - first.t, dp = last.p - first.p;
    if (dt < 5 || dp <= 0) return null;
    const rate = dp / dt;
    const remaining = last.total - last.p;
    return rate > 0 ? Math.ceil(remaining / rate) : null;
  },

  /** Spawn 使用率 (0-100%) */
  spawnUptime() {
    const a = Memory.stats?.spawnActivity;
    if (!a || a.ticks < 100) return null;
    return Math.round((a.spawning / a.ticks) * 100);
  },

};


// ============================================================
//  SECTION: ROAD_PLANNER — 道路网络自动规划
//  每 200 tick 沿三条主干道（Source→Spawn, Spawn→Controller）
//  自动放置道路工地，让 Built 自然建造
// ============================================================

const RoadPlanner = {
  run() {
    const hr = Helpers.getHomeRoom();
    const room = Game.rooms[hr];
    if (!room) return;
    const cache = RoomCache.get(hr);
    if (!cache) return;

    const spawn = cache.spawns[0];
    const ctrl = cache.controller;
    if (!spawn || !ctrl) return;

    if (!Memory._lastRoadPlan) Memory._lastRoadPlan = 0;
    if (Game.time - Memory._lastRoadPlan < 200) return;  // 每 200t 一次
    Memory._lastRoadPlan = Game.time;

    // 构建 CostMatrix：已有道路低成本，墙不可通行，建筑不可通行
    const costs = new PathFinder.CostMatrix();
    for (const road of cache.roads)
      costs.set(road.pos.x, road.pos.y, 1);
    for (const s of cache.walls)
      costs.set(s.pos.x, s.pos.y, 255);
    // 已有建筑不可通行（Containers/Ramparts 可穿越，不阻塞）
    for (const s of cache.myStructures) {
      if (s.structureType !== STRUCTURE_ROAD && s.structureType !== STRUCTURE_CONTAINER
        && s.structureType !== STRUCTURE_RAMPART && s.structureType !== STRUCTURE_WALL)
        costs.set(s.pos.x, s.pos.y, 255);
    }

    // 三条关键路径: Source→Spawn + Spawn→Controller
    const paths = [];
    for (const src of cache.sources)
      paths.push(this._findPath(spawn.pos, src.pos, costs));
    paths.push(this._findPath(spawn.pos, ctrl.pos, costs));

    // 放置道路工地（去重 + 避让已有建筑/工地）
    const placed = new Set();
    const terrain = room.getTerrain();
    for (const path of paths) {
      for (const pos of path) {
        const key = `${pos.x},${pos.y}`;
        if (placed.has(key)) continue;
        placed.add(key);

        // 检查该位置是否已被占用
        const hasSite = cache.sites.some(s => s.pos.x === pos.x && s.pos.y === pos.y);
        const hasRoad = cache.roads.some(s => s.pos.x === pos.x && s.pos.y === pos.y);
        const hasStructure = cache.myStructures.some(s => s.pos.x === pos.x && s.pos.y === pos.y
          && s.structureType !== STRUCTURE_CONTAINER && s.structureType !== STRUCTURE_RAMPART);
        if (hasSite || hasRoad || hasStructure) continue;
        if (terrain.get(pos.x, pos.y) === TERRAIN_MASK_WALL) continue;

        room.createConstructionSite(pos.x, pos.y, STRUCTURE_ROAD);
      }
    }
  },

  _findPath(from, to, costs) {
    if (!from || !to) return [];
    const result = PathFinder.search(from, { pos: to, range: 1 }, {
      roomCallback: () => costs,
      plainCost: 2,
      swampCost: 10,
      maxOps: 2000,
    });
    return result.path || [];
  },
};

// ============================================================
//  SECTION: VIS_CONFIG — 可视化 Flag 开关
//  放置 flag 即可控制可视化级别，无需改代码
//    viz_off   → 关闭所有可视化
//    viz_min   → 仅面板+警报
//    viz_debug → 全部+调试信息
//    (无flag)  → 默认完整模式
// ============================================================

const VisConfig = {
  /** @returns {0|1|2|3} 0=off, 1=min, 2=normal, 3=debug */
  level() {
    const room = Game.rooms[Helpers.getHomeRoom()];
    if (!room) return 2;
    const flags = room.find(FIND_FLAGS);
    for (const f of flags) {
      if (f.name === "viz_off")   return 0;
      if (f.name === "viz_min")   return 1;
      if (f.name === "viz_debug") return 3;
    }
    return 2;
  },
};

// ============================================================
//  SECTION: VISUALS — 房间可视化层
//  使用 RoomVisual（零 CPU 成本）绘制信息面板、进度条、状态指示
//  全部在 CPUGovernor 控制下：critical 模式时自动跳过
// ============================================================

const Visuals = {
  run() {
    const level = VisConfig.level();
    if (level === 0 || CPUGovernor.shouldSkipVisual()) return;

    const hr = Helpers.getHomeRoom();
    const room = Game.rooms[hr];
    if (!room) return;
    const v = room.visual;
    const cache = RoomCache.get(hr);
    if (!cache) return;

    // 所有级别都显示面板+警报
    this._infoPanel(v, cache, hr);
    this._alerts(v, cache, hr);

    // level 1 (min) 仅面板+警报，不画其他
    if (level === 1) return;

    // level 2+ : 完整可视化
    this._phasePanel(v, cache);
    this._energyFlow(v, cache);
    this._controllerBar(v, cache);
    this._constructionBars(v, cache);
    this._sourceLabels(v, cache);
    this._spawnBar(v, cache);
  },

  // ---- 左上角信息面板 ----
  _infoPanel(v, cache, hr) {
    const x = 1.5, top = 1.5, lineH = 0.7;
    const eRate = StatsTracker.energyRate();
    const rclETA = StatsTracker.rclETA();
    const gclETA = StatsTracker.gclETA();
    const spawnUp = StatsTracker.spawnUptime();
    const es = cache.energyCapacityAvailable > 0
      ? cache.energyAvailable / cache.energyCapacityAvailable : 0;
    const tierMap = { normal: "🟢", moderate: "🟡", critical: "🔴" };
    const tierIcon = tierMap[CPUGovernor.tier()] || "⚪";
    const counts = Helpers.countCreepsByRole(hr);
    const level = VisConfig.level();

    function _bar(pct) {
      const n = Math.round(10 * Math.min(1, Math.max(0, pct)));
      return "█".repeat(n) + "░".repeat(10 - n);
    }

    const rclPct = (cache.controller?.progress || 0) / (cache.controller?.progressTotal || 1);
    const gclPct = Game.gcl.progress / Game.gcl.progressTotal;
    const eColor = es > 0.5 ? "#00ff88" : es > 0.2 ? "#ffaa00" : "#ff4444";
    const containerEnergy = _.sum(cache.containers, c => c.store[RESOURCE_ENERGY]);
    const storageEnergy = cache.storage ? cache.storage.store[RESOURCE_ENERGY] : 0;
    const totalHarv = (counts.harvester || 0) + (counts.staticHarvester || 0);
    const isSpawning = cache.spawns.some(s => s.spawning);

    const rows = [];

    // 标题
    rows.push({ text: `▛ 基地   T:${Game.time}   ${tierIcon}${level===3?" 调试":""}`, color: "#00ddff" });

    // GCL 行
    rows.push({ text: `🌐 GCL${Game.gcl.level}  ${_bar(gclPct)}  ${(gclPct * 100).toFixed(1)}%`, color: "#aaaacc" });
    if (gclETA) rows.push({ text: `   ⏱ GCL ${this._fmtTicks(gclETA)} 后升级`, color: "#8888cc" });

    // RCL 行
    rows.push({ text: `🏛 RCL${cache.rcl}  ${_bar(rclPct)}  ${(rclPct * 100).toFixed(0)}%`, color: "#cccccc" });
    if (rclETA) rows.push({ text: `   ⏱ 预计 ${this._fmtTicks(rclETA)} 后升级`, color: "#00cc88" });
    // 降级警告
    if (cache.controller?.my && cache.controller.ticksToDowngrade < 5000) {
      rows.push({ text: `   ⚠ ${this._fmtTicks(cache.controller.ticksToDowngrade)} 后降级！`, color: "#ff6666" });
    }

    // 能量行
    rows.push({ text: `⚡ 能量  ${_bar(es)}  ${cache.energyAvailable}/${cache.energyCapacityAvailable}`, color: eColor });

    // 能率 + Spawn 状态
    const spawnStatus = isSpawning
      ? (() => { const s = cache.spawns.find(sp => sp.spawning); return s ? `🐣孵化中 ${s.spawning.remainingTime}t` : "🐣孵化中"; })()
      : (spawnUp !== null ? `⏸ 空闲 (使用率${spawnUp}%)` : "⏸ 空闲");
    const spawnColor = isSpawning ? "#cc66ff" : es > 0.4 ? "#ffaa00" : "#888888";
    rows.push({ text: spawnStatus, color: spawnColor });

    if (eRate !== null) {
      const rColor = eRate > 0 ? "#00ff88" : "#ff4444";
      rows.push({ text: `📈 净能率  ${eRate > 0 ? "+" : ""}${eRate.toFixed(1)}/t`, color: rColor });
    }

    // 角色
    const allCount = _.sum(Object.values(counts));
    rows.push({ text: `👥 ${allCount}人   采:${totalHarv}  升:${counts.upgrader || 0}  建:${counts.builder || 0}  修:${counts.repairer || 0}  运:${counts.hauler || 0}  墙:${counts.wallRepairer || 0}  占:${counts.claimer || 0}  远:${counts.remoteHauler || 0}`, color: "#bbbbbb" });

    // 底部状态
    rows.push({ text: `📦 ${containerEnergy + storageEnergy}  |  🏗 ${cache.sites.length}  |  🛡 ${cache.towers.length}  |  💾 ${Game.cpu.bucket}`, color: "#999999" });

    // 自适应背景
    const panelW = 18;
    const panelH = rows.length * lineH + 0.5;
    v.rect(x - 0.3, top - 0.3, panelW, panelH, {
      fill: "#0a0a0f", opacity: 0.62, stroke: "#222244", strokeWidth: 0.06,
    });

    for (let i = 0; i < rows.length; i++) {
      v.text(rows[i].text, x, top + i * lineH, {
        color: rows[i].color, font: "0.48", align: "left",
      });
    }
  },

  // ---- 阶段面板 (替代原 Sparkline) ----
  _phasePanel(v, cache) {
    const hr = Helpers.getHomeRoom();
    const counts = Helpers.countCreepsByRole(hr);
    const rcl = cache.rcl;

    // 定义五个阶段的目标体系
    const phases = [
      { // P1: 基础期 (RCL 1)
        name: "基础·初始积累", icon: "🔰",
        objectives: [
          { label: "RCL 升到 2", done: () => rcl >= 2,
            pct: () => Math.min(1, (cache.controller?.progress || 0) / (cache.controller?.progressTotal || 1)),
            detail: () => rcl >= 2 ? "✅" : `${Math.round((cache.controller?.progress || 0) / (cache.controller?.progressTotal || 1) * 100)}%` },
          { label: "采集者就位", done: () => (counts.harvester || 0) + (counts.staticHarvester || 0) >= 1,
            pct: () => Math.min(1, (counts.harvester || 0) + (counts.staticHarvester || 0)),
            detail: () => `${(counts.harvester || 0) + (counts.staticHarvester || 0)}/1` },
          { label: "建造 Extensions", done: () => cache.extensions.length >= 5,
            pct: () => Math.min(1, cache.extensions.length / 5),
            detail: () => `${cache.extensions.length}/5` },
          { label: "能量正增长", done: () => { const r = StatsTracker.energyRate(); return r !== null && r > 0; },
            pct: () => { const r = StatsTracker.energyRate(); return r !== null ? (r > 0 ? 1 : 0) : 0; },
            detail: () => { const r = StatsTracker.energyRate(); return r !== null ? `${r > 0 ? "+" : ""}${r.toFixed(1)}/t` : "测算中"; } },
        ],
      },
      { // P2: 容器经济期 (RCL 2-3)
        name: "容器·定点经济", icon: "📦",
        objectives: [
          { label: "RCL 升到 3", done: () => rcl >= 3,
            pct: () => rcl >= 3 ? 1 : ((cache.controller?.progress || 0) / (cache.controller?.progressTotal || 1)),
            detail: () => rcl >= 3 ? "✅" : `RCL2 ${Math.round((cache.controller?.progress || 0) / (cache.controller?.progressTotal || 1) * 100)}%` },
          { label: "Container 覆盖", done: () => cache.sources.every(src => src.pos.findInRange(cache.containers, 1).length > 0),
            pct: () => cache.sources.length > 0 ? cache.sources.filter(src => src.pos.findInRange(cache.containers, 1).length > 0).length / cache.sources.length : 0,
            detail: () => `${cache.sources.filter(src => src.pos.findInRange(cache.containers, 1).length > 0).length}/${cache.sources.length}` },
          { label: "定点采集就位", done: () => (counts.staticHarvester || 0) >= cache.sources.length,
            pct: () => cache.sources.length > 0 ? Math.min(1, (counts.staticHarvester || 0) / cache.sources.length) : 0,
            detail: () => `${counts.staticHarvester || 0}/${cache.sources.length}` },
          { label: "搬运工就位", done: () => (counts.hauler || 0) >= 1,
            pct: () => Math.min(1, (counts.hauler || 0)),
            detail: () => `${counts.hauler || 0}/1` },
          { label: "建造 Storage", done: () => !!cache.storage,
            pct: () => cache.storage ? 1 : (cache.sites.some(s => s.structureType === STRUCTURE_STORAGE) ? 0.5 : 0),
            detail: () => cache.storage ? "✅" : (cache.sites.some(s => s.structureType === STRUCTURE_STORAGE) ? "建造中" : "未建造") },
        ],
      },
      { // P3: 设施完善期 (RCL 3-4)
        name: "建造·设施完善", icon: "🛠",
        objectives: [
          { label: "RCL 升到 4", done: () => rcl >= 4,
            pct: () => rcl >= 4 ? 1 : ((cache.controller?.progress || 0) / (cache.controller?.progressTotal || 1)),
            detail: () => rcl >= 4 ? "✅" : `RCL3 ${Math.round((cache.controller?.progress || 0) / (cache.controller?.progressTotal || 1) * 100)}%` },
          { label: "建造炮塔", done: () => cache.towers.length >= 1,
            pct: () => Math.min(1, cache.towers.length / 1),
            detail: () => `${cache.towers.length}/1` },
          { label: "城墙/路障", done: () => cache.walls.length >= 10 || cache.ramparts.length >= 10,
            pct: () => Math.min(1, (cache.walls.length + cache.ramparts.length) / 20),
            detail: () => `墙${cache.walls.length} 障${cache.ramparts.length}` },
          { label: "Storage 落成", done: () => !!cache.storage,
            pct: () => cache.storage ? 1 : (cache.sites.some(s => s.structureType === STRUCTURE_STORAGE) ? 0.5 : 0),
            detail: () => cache.storage ? "✅" : (cache.sites.some(s => s.structureType === STRUCTURE_STORAGE) ? "建造中" : "未建造") },
          { label: "储能达标 10K", done: () => cache.storage && cache.storage.store[RESOURCE_ENERGY] >= 10000,
            pct: () => cache.storage ? Math.min(1, cache.storage.store[RESOURCE_ENERGY] / 10000) : 0,
            detail: () => cache.storage ? `${Math.round(cache.storage.store[RESOURCE_ENERGY] / 1000)}K/10K` : "无 Storage" },
        ],
      },
      { // P4: 成长升级期 (RCL 4-6)
        name: "成长·生产升级", icon: "⚗",
        objectives: [
          { label: "RCL 升到 6", done: () => rcl >= 6,
            pct: () => rcl >= 6 ? 1 : Math.max(0, (rcl - 4) / 2),
            detail: () => rcl >= 6 ? "✅" : `RCL${rcl}` },
          { label: "炮塔完善", done: () => cache.towers.length >= 3,
            pct: () => Math.min(1, cache.towers.length / 3),
            detail: () => `${cache.towers.length}/3` },
          { label: "储能达标 50K", done: () => cache.storage && cache.storage.store[RESOURCE_ENERGY] >= 50000,
            pct: () => cache.storage ? Math.min(1, cache.storage.store[RESOURCE_ENERGY] / 50000) : 0,
            detail: () => cache.storage ? `${Math.round(cache.storage.store[RESOURCE_ENERGY] / 1000)}K/50K` : "无 Storage" },
          { label: "城墙维修者", done: () => (counts.wallRepairer || 0) >= 1,
            pct: () => Math.min(1, (counts.wallRepairer || 0)),
            detail: () => `${counts.wallRepairer || 0}/1` },
          { label: "矿物/交易系统", done: () => !!cache.terminal && !!cache.storage,
            pct: () => (cache.terminal ? 1 : 0) * 0.5 + (cache.storage ? 1 : 0) * 0.5,
            detail: () => cache.terminal ? (cache.storage ? "✅ 就绪" : "需 Storage") : "未建造 Terminal" },
        ],
      },
      { // P5: 扩张期 (RCL 6+)
        name: "扩张·跨房间", icon: "🚀",
        objectives: [
          { label: "远征采集", done: () => Memory.remoteRooms && Object.keys(Memory.remoteRooms).length > 0,
            pct: () => Memory.remoteRooms ? Math.min(1, Object.keys(Memory.remoteRooms).length / CONFIG.REMOTE.MAX_REMOTE_ROOMS) : 0,
            detail: () => Memory.remoteRooms ? `${Object.keys(Memory.remoteRooms).length}/${CONFIG.REMOTE.MAX_REMOTE_ROOMS}` : "0/2" },
          { label: "Claimer/远征运输", done: () => (counts.claimer || 0) >= 1 && (counts.remoteHauler || 0) >= 1,
            pct: () => Math.min(1, ((counts.claimer || 0) + (counts.remoteHauler || 0)) / 2),
            detail: () => `占${counts.claimer || 0} 远${counts.remoteHauler || 0}` },
          { label: "Link 网络", done: () => cache.links.length >= 2,
            pct: () => Math.min(1, cache.links.length / 2),
            detail: () => `${cache.links.length}/2 · RCL${rcl}` },
          { label: "多房间运营", done: () => Object.keys(Game.rooms).length > 1,
            pct: () => Math.min(1, Object.keys(Game.rooms).length - 1),
            detail: () => `${Object.keys(Game.rooms).length - 1}/1` },
        ],
      },
    ];

    // 定位当前阶段 (按 RCL)
    let phaseIdx = 0;
    if (rcl >= 6)      phaseIdx = 4;  // P5
    else if (rcl >= 4) phaseIdx = 3;  // P4
    else if (rcl >= 3) phaseIdx = 2;  // P3
    else if (rcl >= 2) phaseIdx = 1;  // P2
    // P1 为默认 (rcl === 1)

    const phase = phases[phaseIdx];

    // 阶段整体完成度
    const totalObjs = phase.objectives.length;
    const doneCount = phase.objectives.filter(o => o.done()).length;
    const overallPct = totalObjs > 0 ? doneCount / totalObjs : 0;

    // ---- 绘制面板 ----
    const bx = 19.8, by = 1.5;
    const pw = 16;
    const objH = 0.55;
    const panelH = 2.1 + phase.objectives.length * objH;

    // 背景
    v.rect(bx - 0.2, by - 0.2, pw, panelH, {
      fill: "#0a0a0f", opacity: 0.55, stroke: "#222244", strokeWidth: 0.05,
    });

    // 阶段标题
    v.text(`${phase.icon} P${phaseIdx+1}/5 ${phase.name}`, bx + 0.1, by, {
      color: "#ffcc00", font: "0.48", align: "left",
    });

    // 整体进度条
    const barW = pw - 3;
    const barY = by + 0.55;
    v.rect(bx, barY, barW, 0.22, {
      fill: "#1a1a2e", opacity: 0.8, stroke: "#333355", strokeWidth: 0.03,
    });
    if (overallPct > 0) v.rect(bx, barY, barW * overallPct, 0.22, {
      fill: "#ffcc00", opacity: 0.75,
    });
    v.text(`${Math.round(overallPct * 100)}%`, bx + barW + 0.3, barY, {
      color: "#ffcc00", font: "0.3", align: "left",
    });

    // 各项目标
    for (let i = 0; i < phase.objectives.length; i++) {
      const obj = phase.objectives[i];
      const done = obj.done();
      const pct = obj.pct();
      const detail = obj.detail();
      const icon = done ? "✅" : (pct > 0 ? "🔄" : "⬜");
      const objColor = done ? "#66ff66" : (pct > 0 ? "#ffaa00" : "#666666");
      const yy = barY + 0.4 + i * objH;

      v.text(`${icon} ${obj.label}`, bx + 0.1, yy, { color: objColor, font: "0.38", align: "left" });
      v.text(detail, bx + pw - 0.3, yy, { color: objColor, font: "0.38", align: "right" });
    }
  },

  // ---- 警报系统 ----
  _alerts(v, cache, hr) {
    const alerts = [];
    const counts = Helpers.countCreepsByRole(hr);
    const es = cache.energyCapacityAvailable > 0
      ? cache.energyAvailable / cache.energyCapacityAvailable : 0;

    // 致命
    if (!cache.myCreeps.length)
      alerts.push({ icon: "💀", text: "无 Creep！", color: "#ff3333" });
    if (!counts.harvester && !counts.staticHarvester)
      alerts.push({ icon: "⚠", text: "无采集者", color: "#ff4444" });

    // 危险
    if (cache.hostiles.length)
      alerts.push({ icon: "⚔", text: `${cache.hostiles.length}敌人`, color: "#ff3333" });
    if (es < 0.15)
      alerts.push({ icon: "🔴", text: `能量${cache.energyAvailable}`, color: "#ff4444" });
    if (cache.controller?.my && cache.controller.ticksToDowngrade < 3000)
      alerts.push({ icon: "⏬", text: `RCL${cache.rcl}降级`, color: "#ff4444" });

    // 警告
    if (!counts.upgrader && cache.myCreeps.length > 0)
      alerts.push({ icon: "⚠", text: "无升级者", color: "#ffaa00" });
    if (es > 0.5 && !cache.spawns.some(s => s.spawning) && cache.myCreeps.length > 0)
      alerts.push({ icon: "⏸", text: "Spawn空闲", color: "#ffaa00" });
    if (Game.cpu.bucket < 2000)
      alerts.push({ icon: "💾", text: `Bucket${Game.cpu.bucket}`, color: "#ffaa00" });
    if (Game.cpu.bucket < 500)
      alerts.push({ icon: "💾", text: "Bucket极低!", color: "#ff3333" });

    if (!alerts.length) return;

    // 画在面板下方
    const t = Game.time;
    const pulse = 0.6 + 0.4 * Math.sin(t * 0.12);
    const ay = 2 + 9; // below the panel

    // 背景条
    v.rect(1.2, ay - 0.3, 18, 0.6, {
      fill: "#1a0000", opacity: 0.45 * pulse, stroke: "#440000", strokeWidth: 0.03,
    });

    const ax = 1.7;
    for (let i = 0; i < alerts.length; i++) {
      v.text(`${alerts[i].icon}${alerts[i].text}`, ax + i * 3.2, ay, {
        color: alerts[i].color, font: "0.42", align: "left", opacity: pulse,
      });
    }
  },

  // ---- 控制器升级进度条 + ETA ----
  _controllerBar(v, cache) {
    const ctrl = cache.controller;
    if (!ctrl || !ctrl.my) return;
    const pct = ctrl.progress / ctrl.progressTotal;
    const barW = 8, barH = 0.35;
    const bx = ctrl.pos.x - barW / 2;
    const by = ctrl.pos.y - 1.6;

    // 背景
    v.rect(bx, by, barW, barH, { fill: "#1a1a2e", opacity: 0.8, stroke: "#333355", strokeWidth: 0.03 });
    // 进度
    if (pct > 0) v.rect(bx, by, barW * pct, barH, { fill: "#00ffff", opacity: 0.75 });

    const rclETA = StatsTracker.rclETA();
    const etaStr = rclETA ? `  ⏱${this._fmtTicks(rclETA)}` : "";
    v.text(`RCL${ctrl.level} ${(pct * 100).toFixed(1)}%${etaStr}`, ctrl.pos.x, by - 0.3, {
      color: "#00ffff", font: "0.45", align: "center",
    });
  },

  // ---- 工地进度条 ----
  _constructionBars(v, cache) {
    for (const site of cache.sites) {
      const pct = site.progress / site.progressTotal;
      const barW = 2.5, barH = 0.2;
      const bx = site.pos.x - barW / 2;
      const by = site.pos.y - 0.9;

      v.rect(bx, by, barW, barH, { fill: "#1a1a00", opacity: 0.7, stroke: "#333300", strokeWidth: 0.03 });
      if (pct > 0) v.rect(bx, by, barW * pct, barH, { fill: "#ffff00", opacity: 0.75 });
      v.text(`${(pct * 100).toFixed(0)}%`, site.pos.x, by - 0.15, {
        color: "#ffff00", font: "0.3", align: "center",
      });
    }
  },

  // ---- Source 标记（采集者数量 + 容器连线） ----
  _sourceLabels(v, cache) {
    for (const src of cache.sources) {
      let count = 0;
      for (const c of cache.myCreeps) {
        if ((c.memory.role === "harvester" || c.memory.role === "staticHarvester")
            && c.memory.sourceId === src.id) count++;
      }

      const nearCont = src.pos.findInRange(cache.containers, 1).find(
        c => c.store.getFreeCapacity(RESOURCE_ENERGY) > 0 || c.store[RESOURCE_ENERGY] > 0
      );
      const icon = nearCont ? "📦" : "⛏️";
      const color = count > 0 ? "#ffaa00" : "#555555";

      v.text(`${icon}${count}`, src.pos.x, src.pos.y - 0.8, { color, font: "0.5", align: "center" });

      // 容器连线
      if (nearCont) {
        v.line(src.pos.x, src.pos.y, nearCont.pos.x, nearCont.pos.y, {
          color: "#ffaa00", opacity: 0.25, lineStyle: "dashed",
        });
      }
    }
  },

  // ---- Spawn 孵化进度 ----
  _spawnBar(v, cache) {
    for (const spawn of cache.spawns) {
      if (!spawn.spawning) {
        // 显示待命状态
        v.text("🐣 待命", spawn.pos.x, spawn.pos.y - 1, {
          color: "#888888", font: "0.45", align: "center",
        });
        continue;
      }
      const info = spawn.spawning;
      const pct = 1 - (info.remainingTime / info.needTime);
      const barW = 3, barH = 0.2;
      const bx = spawn.pos.x - barW / 2;
      const by = spawn.pos.y - 1.2;

      v.rect(bx, by, barW, barH, { fill: "#1a001a", opacity: 0.7, stroke: "#330033", strokeWidth: 0.03 });
      if (pct > 0) v.rect(bx, by, barW * pct, barH, { fill: "#cc66ff", opacity: 0.75 });

      const creepName = info.name;
      const role = Memory.creeps[creepName]?.role || "";
      const roleLabel = { harvester: "采集", staticHarvester: "定点", upgrader: "升级",
        builder: "建造", repairer: "维修", hauler: "运输", wallRepairer: "城墙" }[role] || role;
      v.text(`🐣${roleLabel} ${info.remainingTime}t`, spawn.pos.x, by - 0.15, {
        color: "#cc66ff", font: "0.35", align: "center",
      });
    }
  },

  // ---- 能量流动画 — 展示能量在建筑间的流动路径 ----
  _energyFlow(v, cache) {
    const t = Game.time;
    const _pulse = (phase = 0) => 0.3 + 0.25 * Math.sin(t * 0.1 + phase);

    // ── 1. Source → Container (采集流) ──
    for (const src of cache.sources) {
      const cont = src.pos.findInRange(cache.containers, 1).find(
        c => (c.store.getFreeCapacity(RESOURCE_ENERGY) > 0 || c.store[RESOURCE_ENERGY] > 0)
      );
      if (!cont) continue;

      // 流动虚线
      v.line(src.pos.x, src.pos.y, cont.pos.x, cont.pos.y, {
        color: "#ffaa00", opacity: _pulse(0), lineStyle: "dashed",
      });
      // 移动粒子
      const raw = ((t * 7) % 100) / 100;
      const phase = raw < 0.5 ? raw * 2 : 2 - raw * 2; // 往复
      const mx = src.pos.x + (cont.pos.x - src.pos.x) * phase;
      const my = src.pos.y + (cont.pos.y - src.pos.y) * phase;
      v.circle(mx, my, { radius: 0.18, fill: "#ffcc44", opacity: 0.85 });
    }

    // ── 2. Container → Spawn/Extensions (配送流) ──
    for (const cont of cache.containers) {
      if (cont.store[RESOURCE_ENERGY] < 200) continue;
      // 找最近的 Spawn
      let nearest = null, minD = Infinity;
      for (const sp of cache.spawns) {
        const d = cont.pos.getRangeTo(sp);
        if (d < minD) { minD = d; nearest = sp; }
      }
      if (!nearest) continue;

      v.line(cont.pos.x, cont.pos.y, nearest.pos.x, nearest.pos.y, {
        color: "#66ff66", opacity: _pulse(1.2), lineStyle: "dashed",
      });
      // 粒子
      const raw2 = ((t * 8 + 30) % 100) / 100;
      const p2 = raw2 < 0.5 ? raw2 * 2 : 2 - raw2 * 2;
      const mx2 = cont.pos.x + (nearest.pos.x - cont.pos.x) * p2;
      const my2 = cont.pos.y + (nearest.pos.y - cont.pos.y) * p2;
      v.circle(mx2, my2, { radius: 0.14, fill: "#88ff88", opacity: 0.75 });
    }

    // ── 3. Spawn/Storage → Controller (升级流) ──
    if (cache.controller && cache.controller.my) {
      const ctrl = cache.controller;
      const origin = cache.storage || (cache.spawns.length ? cache.spawns[0] : null);
      if (origin && origin.pos.getRangeTo(ctrl) > 1) {
        v.line(origin.pos.x, origin.pos.y, ctrl.pos.x, ctrl.pos.y, {
          color: "#00ccff", opacity: _pulse(2.5), lineStyle: "dotted",
        });
        const raw3 = ((t * 6 + 60) % 100) / 100;
        const p3 = raw3 < 0.5 ? raw3 * 2 : 2 - raw3 * 2;
        v.circle(
          origin.pos.x + (ctrl.pos.x - origin.pos.x) * p3,
          origin.pos.y + (ctrl.pos.y - origin.pos.y) * p3,
          { radius: 0.16, fill: "#00eeff", opacity: 0.8 }
        );
      }
    }

    // ── 4. Storage 能量标注 ──
    if (cache.storage) {
      const amt = cache.storage.store[RESOURCE_ENERGY];
      v.text(amt > 1000 ? `${(amt / 1000).toFixed(1)}K` : `${amt}`,
        cache.storage.pos.x, cache.storage.pos.y - 0.7, {
          color: "#aaaaaa", font: "0.35", align: "center",
        });
    }

    // ── 5. Container 能量标注 ──
    for (const cont of cache.containers) {
      const amt = cont.store[RESOURCE_ENERGY];
      if (amt < 50) continue;
      v.text(`${amt}`, cont.pos.x, cont.pos.y - 0.5, {
        color: "#ffcc66", font: "0.3", align: "center",
      });
    }
  },

  // ---- 工具：格式化 tick 数 ----
  _fmtTicks(ticks) {
    if (ticks >= 10000) return `${(ticks / 1000).toFixed(1)}Kt`;
    if (ticks >= 1000)  return `${(ticks / 1000).toFixed(0)}.${Math.floor((ticks % 1000) / 100)}Kt`;
    return `${ticks}t`;
  },
};

// ============================================================
//  SECTION: MIGRATION — 版本迁移 & 状态评估
//  每次切换新脚本时自动评估当前游戏状态，无缝迁移 Creep 内存
//  不会打乱现有节奏 — 所有 Creep 保持原有工作状态继续运行
// ============================================================

const SCRIPT_VERSION = 4;

const Migration = {
  run() {
    const prev = Memory.scriptVersion || 0;
    if (prev >= SCRIPT_VERSION) return;

    // ---- 横幅 ----
    const bar = "=".repeat(48);
    console.log(`\n${bar}`);
    console.log(`🔄 脚本迁移: v${prev} → v${SCRIPT_VERSION}  (Tick ${Game.time})`);
    console.log(`${bar}`);

    // ==================== 1. 当前状态评估 ====================
    const hr = Helpers.getHomeRoom();
    const room = Game.rooms[hr];
    const rcl = room?.controller?.level ?? "?";
    const rclPct = room?.controller ? ((room.controller.progress / room.controller.progressTotal) * 100).toFixed(1) : "N/A";
    const energy = room ? `${room.energyAvailable}/${room.energyCapacityAvailable}` : "?";
    const energyPct = room?.energyCapacityAvailable > 0 ? ((room.energyAvailable / room.energyCapacityAvailable) * 100).toFixed(0) : "?";

    // 旧 Creep 统计（直接用旧 memory 统计，因为缓存还未刷新）
    const oldCounts = {};
    for (const name in Game.creeps) {
      const r = Game.creeps[name].memory.role || "unknown";
      oldCounts[r] = (oldCounts[r] || 0) + 1;
    }
    const totalCreeps = Object.keys(Game.creeps).length;

    console.log(`\n📊 [状态评估]  — 无缝接管当前局面`);
    console.log(`  🏠 主房间 : ${hr}`);
    console.log(`  🏛️ RCL    : ${rcl}  (升级 ${rclPct}%)`);
    console.log(`  ⚡ 能量   : ${energy}  (${energyPct}%)`);
    console.log(`  💾 Bucket : ${Game.cpu.bucket}`);
    console.log(`  ⏱️ GCL    : Lv${Game.gcl?.level ?? "?"} (${Game.gcl ? ((Game.gcl.progress / Game.gcl.progressTotal) * 100).toFixed(1) : "?"}%)`);
    console.log(`  👥 Creep  : ${totalCreeps} 个`);
    for (const [r, c] of Object.entries(oldCounts).sort())
      console.log(`     ${r}: ${c}`);

    if (room) {
      const sites = room.find(FIND_MY_CONSTRUCTION_SITES);
      const hostiles = room.find(FIND_HOSTILE_CREEPS);
      if (sites.length)  console.log(`  🏗️ 工地   : ${sites.length} 个`);
      if (hostiles.length) console.log(`  ⚔️ 敌人   : ${hostiles.length} 个！`);
    }

    // ==================== 2. Creep 内存迁移 ====================
    if (prev < 3) {
      let migrated = 0;
      for (const name in Game.creeps) {
        const c = Game.creeps[name];
        let dirty = false;

        // working 布尔 → state 枚举
        if (c.memory.state === undefined) {
          const role = c.memory.role;
          if (c.memory.working === true) {
            // 对应角色 "工作中" 状态
            const workMap = {
              harvester: STATES.WORKING, staticHarvester: STATES.WORKING,
              upgrader: STATES.UPGRADING, builder: STATES.BUILDING,
              repairer: STATES.REPAIRING, hauler: STATES.HAULING,
              wallRepairer: STATES.REPAIRING,
            };
            c.memory.state = workMap[role] || STATES.WORKING;
          } else if (c.memory.working === false) {
            c.memory.state = STATES.HARVESTING;
          } else {
            // 无 working 字段 — 从实时能量反推
            if (c.store.getFreeCapacity() === 0) {
              c.memory.state = (
                role === "upgrader" ? STATES.UPGRADING :
                role === "builder" ? STATES.BUILDING :
                role === "repairer" || role === "wallRepairer" ? STATES.REPAIRING :
                role === "hauler" ? STATES.HAULING :
                STATES.WORKING
              );
            } else {
              c.memory.state = STATES.HARVESTING;
            }
          }
          dirty = true;
        }

        // 补充缺失字段
        if (!c.memory.homeRoom) { c.memory.homeRoom = c.room.name; dirty = true; }

        // 清理旧字段
        if (c.memory.working !== undefined) { delete c.memory.working; dirty = true; }

        if (dirty) migrated++;
      }
      console.log(`\n🔄 已迁移 ${migrated} 个 Creep 的内存结构 (working → state)`);
    }

    // ==================== 3. 完成 ====================
    Memory.scriptVersion = SCRIPT_VERSION;
    // 清除旧通知标记，确保新脚本的通知能正常触发
    Memory._ntf = {};
    Memory._hadHostiles = false;
    console.log(`✅ 迁移完毕！AI v${SCRIPT_VERSION} 已就绪接管`);
    console.log(`${bar}\n`);

    // 启动邮件报告
    const notifyRoom = Game.rooms[hr];
    const rclReport = notifyRoom?.controller
      ? `等级 ${notifyRoom.controller.level}  进度 ${((notifyRoom.controller.progress / notifyRoom.controller.progressTotal) * 100).toFixed(1)}%`
      : "无控制器";
    const energyReport = notifyRoom ? `${notifyRoom.energyAvailable}/${notifyRoom.energyCapacityAvailable}` : "?";
    const gclReport = `Lv${Game.gcl?.level ?? "?"} (${Game.gcl ? ((Game.gcl.progress / Game.gcl.progressTotal) * 100).toFixed(1) : "?"}%)`;
    const roleList = Object.entries(oldCounts).map(([r, c]) => `${r}:${c}`).join("  ");

    Notifier.onStartup(
      `━━━ 启动报告 ━━━\n` +
      `房间: ${hr}\n` +
      `RCL : ${rclReport}\n` +
      `GCL : ${gclReport}\n` +
      `能量: ${energyReport}\n` +
      `Creep: ${totalCreeps}个\n` +
      `角色: ${roleList || "无"}\n` +
      `Bucket: ${Game.cpu.bucket}\n` +
      `━━━━━━━━━━━━━━`
    );
  },
};

// ============================================================
//  SECTION: 游戏主循环
// ============================================================

module.exports.loop = function () {
  // ---- 版本迁移 (每次脚本升级自动执行，评估现状+迁移内存) ----
  Migration.run();

  // ---- 首次运行初始化 ----
  if (!Memory.initialized) {
    const hr = Helpers.getHomeRoom();
    const room = Game.rooms[hr];
    Logger.info("主循环", "🎮 首次运行");
    Logger.info("主循环", `🏠 房间:${hr} | RCL:${room?.controller?.level ?? "?"}`);
    Logger.info("主循环", `⚙️ CPU限制:${Game.cpu.limit} | Bucket:${Game.cpu.bucket}`);
    Memory.initialized = true;
  }

  // ---- 主循环步骤 ----

  // 1. 清理死亡 Creep 内存（仅一次/tick）
  Helpers.cleanMemory();

  // 2. 刷新房间缓存（长期: 遍历所有活跃房间）
  const homeRoom = Helpers.getHomeRoom();
  RoomCache.refresh(Game.rooms[homeRoom]);

  // 2b. 扫描远程 Flag（Step 4）
  RemoteMonitor.run(homeRoom);

  // 3. 统计角色数量（一次计算，多处复用）
  const counts = Helpers.countCreepsByRole(homeRoom);

  // 3b. 全灭检测
  if (CONFIG.NOTIFY.ON_ALL_DEAD && !Object.keys(Game.creeps).length) {
    Notifier.onAllDead();
  }

  // 4. 管理模块
  RoomManager.run(counts);
  RemoteManager.run(homeRoom);             // Step 4 — 远征
  RoadPlanner.run();      // 自动规划道路网络（每 200t）
  TowerManager.run();
  LinkManager.run(RoomCache.get(homeRoom));   // Step 2 — Link 网络
  MarketManager.run(RoomCache.get(homeRoom), homeRoom); // Step 3 — 市场交易
  LabManager.run(RoomCache.get(homeRoom), homeRoom);    // Step 5 — Lab 强化

  // 5. 运行所有 Creep
  _runAllCreeps();

  // 6. 孵化新 Creep
  SpawnManager.run(counts);

  // 7. 记录统计数据 (用于效率计算和 ETA)
  StatsTracker.record(homeRoom);

  // 8. 全局统计报告
  _report(counts);

  // 9. 可视化层 (RoomVisual 零 CPU，CPUGovernor 控制是否跳过)
  Visuals.run();
};

// ---- 运行所有 Creep ----
function _runAllCreeps() {
  const modules = {
    harvester:       Harvester,
    staticHarvester: Harvester,    // 复用 Harvester 逻辑（容器检测自动切换）
    upgrader:        Upgrader,
    builder:         Builder,
    repairer:        Repairer,
    hauler:          Hauler,
    wallRepairer:    WallRepairer,
    claimer:         Claimer,
    remoteHauler:    RemoteHauler,
  };

  const deadlock = {};   // roomName → bool，每 tick 每房间只判定一次

  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    const role  = creep.memory.role;
    if (!role) continue;

    try {
      // ---- 采集者灭绝自救：优先于一切常规角色行为 ----
      const rn = creep.room.name;
      if (deadlock[rn] === undefined)
        deadlock[rn] = Emergency.isDeadlocked(RoomCache.get(rn));

      if (deadlock[rn] && !Harvester._isHarvestRole(role) && Emergency.canRescue(creep)) {
        Emergency.run(creep, RoomCache.get(rn));
        continue;
      }

      const mod = modules[role];
      if (!mod) continue;
      mod.run(creep);
    } catch (e) {
      Logger.error("主循环", `💥 "${name}"(${role})崩溃`, { msg: e.message || e });
    }
  }
}

// ---- 全局统计报告 ----
function _report(counts) {
  const es = Helpers.energyStatus(Helpers.getHomeRoom());
  const hTotal = (counts.harvester || 0) + (counts.staticHarvester || 0);
  Logger.report({
    h: hTotal,
    sh: counts.staticHarvester || 0,
    u: counts.upgrader || 0,
    b: counts.builder || 0,
    r: counts.repairer || 0,
    haul: counts.hauler || 0,
    ea: es.a,
    ec: es.c,
  });
}

// ---- 全局异常保护 ----
if (typeof global.__loopErrorCount === "undefined") global.__loopErrorCount = 0;
const _origLoop = module.exports.loop;
module.exports.loop = function () {
  try {
    _origLoop();
    if (global.__loopErrorCount > 0) global.__loopErrorCount = 0;
  } catch (err) {
    global.__loopErrorCount++;
    console.log(`[T${Game.time}] ❌❌❌ 崩溃(第${global.__loopErrorCount}次): ${err.message}\n堆栈: ${err.stack}`);
    if (global.__loopErrorCount >= 5) {
      Game.notify(`AI连续崩溃${global.__loopErrorCount}次！\n错误: ${err.message}\nTick: ${Game.time}`, 60);
    }
  }
};
