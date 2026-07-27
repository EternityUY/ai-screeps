/*
 * ============================================================
 *  main.js — Screeps:World 游戏 AI (单文件完整版 v3.0)
 * ============================================================
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
  },

  // 种群控制
  POPULATION: {
    MIN_HARVESTERS: 1,      MAX_HARVESTERS: 6,
    MIN_UPGRADERS:  1,      MAX_UPGRADERS:  4,
    MIN_BUILDERS:   0,      MAX_BUILDERS:   3,
    MIN_REPAIRERS:  0,      MAX_REPAIRERS:  2,
    MIN_HAULERS:    1,      MAX_HAULERS:    3,
    MIN_WALL_REPAIRERS: 0,  MAX_WALL_REPAIRERS: 1,
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
    INTERVAL:     172800,  // 同类通知最小间隔 (tick, 172800 ≈ 48小时)
  },

  // ---- 长期扩展预留 ----
  REMOTE: {
    MAX_REMOTE_ROOMS: 2,
    RESERVE_TICKS:    3000,
  },
  LINKS: {
    ENABLED_AT_RCL: 5,
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

    if (repeats <= 0) return [WORK, CARRY, MOVE]; // 最低保底 (200 能量)

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
   * 统计各角色数量 (从缓存读取，不再遍历 Game.creeps)
   * @param {string} roomName
   * @returns {object}
   */
  countCreepsByRole(roomName) {
    const cache = RoomCache.get(roomName);
    if (!cache) return {};
    const counts = {};
    for (const c of cache.myCreeps) {
      const r = c.memory.role || "unknown";
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
    };
    return `${map[role] || role}_${Game.time}`;
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
    if (creep.memory.state !== STATES.HARVESTING && creep.store[RESOURCE_ENERGY] === 0) {
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

    // 3. Spawn/Extension — RCL1 无其他能源时降低门槛，避免开局卡死
    const es = cache.energyCapacityAvailable > 0
      ? cache.energyAvailable / cache.energyCapacityAvailable : 0;
    const withdrawThreshold = cache.rcl <= 1 ? 0.3 : 0.9;
    if (es >= withdrawThreshold) {
      const se = creep.pos.findClosestByRange(
        [...cache.spawns, ...cache.extensions].filter(
          s => s.store[RESOURCE_ENERGY] > 50
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
    // 长期预留: Links
    // const ln = _.find(cache.links, s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
    // if (ln) return ln;
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

    // 寿命 < 100t → 显示倒计时；< 300t → 附加数字
    if (creep.ticksToLive < 100) {
      creep.say(`💀${creep.ticksToLive}`);
    } else if (creep.ticksToLive < 300) {
      creep.say(`${label}·${creep.ticksToLive}`);
    } else {
      creep.say(label);
    }
  },
};

// ---------- 采集者 Harvester ----------

const Harvester = {
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
    if (!source) { this._assignSource(creep); return; }

    const r = creep.harvest(source);
    if (r === ERR_NOT_IN_RANGE) {
      creep.moveTo(source, { reusePath: CONFIG.PATH.REUSE_TICKS, visualizePathStyle: { stroke: "#ffaa00" } });
    } else if (r !== OK) {
      // 偶尔 source 被占满或无能量，等一等即可
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

  _assignSource(creep) {
    const cache = RoomCache.get(creep.room.name);
    if (!cache || !cache.sources.length) return;

    // 统计每个 Source 的采集者负载（从缓存中读，不再遍历 Game.creeps）
    const load = {};
    for (const s of cache.sources) load[s.id] = 0;
    for (const c of cache.myCreeps) {
      if (c.memory.role === CONFIG.ROLES.HARVESTER && c.memory.sourceId)
        load[c.memory.sourceId] = (load[c.memory.sourceId] || 0) + 1;
    }

    let best = cache.sources[0], min = Infinity;
    for (const s of cache.sources) {
      if ((load[s.id] || 0) < min) { min = load[s.id]; best = s; }
    }
    creep.memory.sourceId = best.id;
    Logger.debug(creep.name, "🔗 分配能量源", `负载:${min}`);
  },
};

// ---------- 升级者 Upgrader ----------

const Upgrader = {
  run(creep) {
    RoleUtil.toggleState(creep, STATES.UPGRADING);

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
      RoleUtil.withdraw(creep);
    }
    RoleUtil.sayState(creep);
  },
};

// ---------- 维修者 Repairer ----------

const Repairer = {
  run(creep) {
    RoleUtil.toggleState(creep, STATES.REPAIRING);

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
      RoleUtil.withdraw(creep);
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

    // 3. Storage
    if (cache.storage && cache.storage.store[RESOURCE_ENERGY] > 0) {
      if (creep.withdraw(cache.storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE)
        creep.moveTo(cache.storage, { reusePath: CONFIG.PATH.REUSE_TICKS, visualizePathStyle: { stroke: "#ffaa00" } });
    }
  },
};

// ---------- 城墙维修 WallRepairer ----------

const WallRepairer = {
  run(creep) {
    RoleUtil.toggleState(creep, STATES.REPAIRING);

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
      this._withdraw(creep);
    }
    RoleUtil.sayState(creep);
  },

  _findWall(creep) {
    const cache = RoomCache.get(creep.room.name);
    if (!cache) return null;
    const R = CONFIG.REPAIR;

    const candidates = [...cache.walls, ...cache.ramparts].filter(
      s => s.hits < s.hitsMax * R.WALL_MAX_RATIO
    );
    if (!candidates.length) return null;

    const sorted = _.sortBy(candidates, s => s.hits / s.hitsMax);
    return sorted[0].hits < sorted[0].hitsMax * R.WALL_THRESHOLD ? sorted[0] : null;
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
//  SECTION: MANAGERS — 管理器
// ============================================================

// ---------- 孵化管理器 ----------

const SpawnManager = {
  run(counts) {
    const homeRoom = Helpers.getHomeRoom();
    const spawn = Helpers.getHomeSpawn();
    if (!spawn) { Logger.error("孵化", "❌ 未找到Spawn！"); return; }

    if (spawn.spawning) {
      const sc = Game.creeps[spawn.spawning.name];
      if (sc && CONFIG.LOG_LEVEL <= 1)
        Logger.debug("孵化", `⏳ 孵化中: ${sc.name}(${sc.memory.role})`,
          `剩余:${spawn.spawning.remainingTime}/${spawn.spawning.needTime}`);
      return;
    }

    const cache = RoomCache.get(homeRoom);
    const sites = cache ? cache.sites : [];
    const rcl = cache ? cache.rcl : 0;
    const total = _.sum(Object.values(counts));

    Logger.debug("孵化", "📊 种群", {
      总数: total, 采集: counts.harvester || 0, 定点: counts.staticHarvester || 0,
      升级: counts.upgrader || 0, 建造: counts.builder || 0,
      维修: counts.repairer || 0, 运输: counts.hauler || 0,
    });

    // ---- 生成优先级 ----

    // 1. 保证有基础采集者
    if ((counts.harvester || 0) < CONFIG.POPULATION.MIN_HARVESTERS ||
        this._needMoreHarv(counts, total)) {
      if (this._trySpawn(spawn, "harvester", counts)) return;
    }

    // 2. 定点采集者 (RCL >= 容器采集阈值)
    if (rcl >= CONFIG.CONTAINER.ENABLE_AT_RCL && cache) {
      const sourceCount = cache.sources.length;
      if ((counts.staticHarvester || 0) < sourceCount) {
        if (this._trySpawn(spawn, "staticHarvester", counts)) return;
      }
    }

    // 3. 运输者 (有容器时需要)
    if (rcl >= CONFIG.CONTAINER.ENABLE_AT_RCL &&
        (counts.hauler || 0) < CONFIG.POPULATION.MIN_HAULERS) {
      if (this._trySpawn(spawn, "hauler", counts)) return;
    }

    // 4. 升级者
    if ((counts.upgrader || 0) < CONFIG.POPULATION.MIN_UPGRADERS) {
      if (this._trySpawn(spawn, "upgrader", counts)) return;
    }

    // 5. 建造者 (有工地时，只在数量变化时提示)
    if (sites.length && (counts.builder || 0) < CONFIG.POPULATION.MAX_BUILDERS) {
      if (!Memory._lastSiteCount || Memory._lastSiteCount !== sites.length) {
        Logger.info("孵化", `🏗️ ${sites.length}个工地`);
        Memory._lastSiteCount = sites.length;
      }
      if (this._trySpawn(spawn, "builder", counts)) return;
    } else { Memory._lastSiteCount = 0; }

    // 6. 维修者 (有道路需维修时，只在数量变化时提示)
    const damaged = Helpers.findToRepair(homeRoom);
    const roads = damaged.filter(s => s.structureType === STRUCTURE_ROAD);
    if (roads.length && (counts.repairer || 0) < CONFIG.POPULATION.MAX_REPAIRERS) {
      if (!Memory._lastRoadCount || Memory._lastRoadCount !== roads.length) {
        Logger.info("孵化", `🔧 ${roads.length}条道路需维修`);
        Memory._lastRoadCount = roads.length;
      }
      if (this._trySpawn(spawn, "repairer", counts)) return;
    } else { Memory._lastRoadCount = 0; }

    // 7. 运输者 (补充)
    if ((counts.hauler || 0) < CONFIG.POPULATION.MAX_HAULERS) {
      if (this._trySpawn(spawn, "hauler", counts)) return;
    }

    // 8. 城墙维修 (RCL 3+)
    if (rcl >= 3 && (counts.wallRepairer || 0) < CONFIG.POPULATION.MAX_WALL_REPAIRERS) {
      if (this._trySpawn(spawn, "wallRepairer", counts)) return;
    }

    // 9. 补充升级者
    if ((counts.upgrader || 0) < CONFIG.POPULATION.MAX_UPGRADERS) {
      if (this._trySpawn(spawn, "upgrader", counts)) return;
    }

    // 10. 兜底: 至少保证有采集者
    if (total > 0) this._trySpawn(spawn, "harvester", counts);
  },

  _needMoreHarv(counts, total) {
    const h = counts.harvester || 0;
    const sh = counts.staticHarvester || 0;
    if (h >= CONFIG.POPULATION.MAX_HARVESTERS) return false;
    if (sh > 0 && h >= 1) return false;              // 有定点采集者时只需1个传统采集者兜底
    if (total > 0 && (h + sh) / total < 0.4) return true;
    return h < 1;
  },

  _trySpawn(spawn, role, counts) {
    const maxKey = `MAX_${role.toUpperCase()}S`;
    const max = CONFIG.POPULATION[maxKey];
    if (max !== undefined && (counts[role] || 0) >= max) return false;

    const body = BodyBuilder.build(spawn.room.energyCapacityAvailable, role);
    const cost = BodyBuilder.cost(body);

    if (cost > spawn.room.energyAvailable) {
      Logger.debug("孵化", `💰 能量不足生成${this._label(role)}`, `需${cost}`);
      return false;
    }

    const name = Helpers.genName(role);
    const result = spawn.spawnCreep(body, name, {
      memory: { role, state: STATES.HARVESTING, homeRoom: Helpers.getHomeRoom() },
    });

    if (result === OK) {
      Logger.info("孵化", `🐣 ${this._label(role)}"${name}"`,
        `部件:${body.length} | 成本:${cost} | 能量:${spawn.room.energyAvailable}/${spawn.room.energyCapacityAvailable}`);
      Notifier.onCreepSpawned();
      return true;
    }
    if (result === ERR_NOT_ENOUGH_ENERGY) {
      // 能量不够：用最低保底再试一次
      const fallback = [WORK, CARRY, MOVE];
      const fbCost = BodyBuilder.cost(fallback);
      if (fbCost <= spawn.room.energyAvailable) {
        const fbName = Helpers.genName(role);
        if (spawn.spawnCreep(fallback, fbName, {
          memory: { role, state: STATES.HARVESTING, homeRoom: Helpers.getHomeRoom() },
        }) === OK) {
          Logger.warn("孵化", `🐣 紧急${this._label(role)}"${fbName}"`, `保底:${fbCost}`);
          return true;
        }
      }
    }
    return false;
  },

  _label(r) {
    const m = {
      harvester: "采集者", staticHarvester: "定点采集", upgrader: "升级者",
      builder: "建造者", repairer: "维修者", hauler: "运输者", wallRepairer: "城墙维修",
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
    if (es <= 0.15) {
      if (!CPUGovernor.shouldSkipInfoLog() && Game.time % 100 === 0)
        Logger.warn("房间", `🔴 能量严重不足:${cache.energyAvailable}/${cache.energyCapacityAvailable}`);
      if (CONFIG.NOTIFY.ON_LOW_ENERGY) Notifier.onLowEnergy(cache.energyAvailable, cache.energyCapacityAvailable);
    } else {
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
    rows.push({ text: `👥 ${cache.myCreeps.length}人   采:${totalHarv}  升:${counts.upgrader || 0}  建:${counts.builder || 0}  修:${counts.repairer || 0}  运:${counts.hauler || 0}  墙:${counts.wallRepairer || 0}`, color: "#bbbbbb" });

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
          { label: "矿物/交易系统", done: () => false,
            pct: () => 0, detail: () => "未完成·预留" },
        ],
      },
      { // P5: 扩张期 (RCL 6+)
        name: "扩张·跨房间", icon: "🚀",
        objectives: [
          { label: "远征采集", done: () => false,
            pct: () => 0, detail: () => "未完成·预留" },
          { label: "Claimer 就绪", done: () => false,
            pct: () => 0, detail: () => "未完成·预留" },
          { label: "Link 网络", done: () => false,
            pct: () => 0, detail: () => `RCL${rcl}/6 · 未完成` },
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

const SCRIPT_VERSION = 3;

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

  // 3. 统计角色数量（一次计算，多处复用）
  const counts = Helpers.countCreepsByRole(homeRoom);

  // 3b. 全灭检测
  if (CONFIG.NOTIFY.ON_ALL_DEAD && !Object.keys(Game.creeps).length) {
    Notifier.onAllDead();
  }

  // 4. 管理模块
  RoomManager.run(counts);
  RoadPlanner.run();      // 自动规划道路网络（每 200t）
  TowerManager.run();

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
  };

  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    const role  = creep.memory.role;
    if (!role) continue;

    const mod = modules[role];
    if (!mod) continue;

    try {
      mod.run(creep);
    } catch (e) {
      Logger.error("主循环", `💥 "${name}"(${role})崩溃`, { msg: e.message || e });
    }
  }
}

// ---- 全局统计报告 ----
function _report(counts) {
  const es = Helpers.energyStatus(Helpers.getHomeRoom());
  Logger.report({
    h: counts.harvester || 0,
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
