/**
 * Fact Ledger pure logic.
 * No browser or SillyTavern imports: this module must be testable in Node.
 */

export const LEDGER_VERSION = 1;

/** Internal identity schema: characters are keyed by opaque ids, names are display data. */
const IDENTITY_VERSION = 2;

/** Stable id for the player's character, who deliberately has no in-story name. */
export const PROTAGONIST_ID = 'user';
export const PROTAGONIST_NAME = '你';
export const PROTAGONIST_ALIASES = ['你', '我', '玩家', '主角', '{{user}}', '%user%'];

/** 知情档位：角色接近到什么程度，才允许知道这条信息。 */
export const ACCESS_LEVELS = ['public', 'friend', 'intimate', 'protagonist'];
const ACCESS_RANK = { public: 0, friend: 1, intimate: 2, protagonist: 3 };
export const ACCESS_LABELS = {
    public: '公开级',
    friend: '朋友级',
    intimate: '亲密级',
    protagonist: '主角级',
};

/** 关系档位只能按这些理由改，避免模型随意漂移。 */
const TIER_UPGRADE_REASONS = {
    'public>friend': new Set(['正式结交', '同门名分', '多次互助']),
    'friend>intimate': new Set(['结拜', '道侣', '共同生死', '长期共处']),
    'public>intimate': new Set(['结拜', '道侣', '共同生死']),
};
const TIER_DOWNGRADE_REASONS = {
    'intimate>friend': new Set(['决裂', '背叛', '明确疏远']),
    'friend>public': new Set(['决裂', '背叛', '长期无往来']),
};
const TIER_MILESTONES = new Set(['结拜', '道侣', '共同生死', '决裂', '背叛']);
const TIER_REVERSE_COOLDOWN_DAYS = 3;
const TIER_ABSENCE_DAYS = 30;

export function normalizeAccess(value, fallback = 'public') {
    const text = String(value ?? '').trim().toLowerCase();
    return ACCESS_LEVELS.includes(text) ? text : fallback;
}

/** 显式写入的档位：写错时按最严的「主角级」处理，而不是静默变公开。 */
function explicitAccess(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const text = String(value).trim().toLowerCase();
    return ACCESS_LEVELS.includes(text) ? text : 'protagonist';
}

/** 旧数据（visibility / knownBy）折算成档位；新聊天不会走这里。 */
function inferAccess(entity, fallback = 'public') {
    if (!entity || typeof entity !== 'object') return fallback;
    const value = String(entity.access ?? '').trim().toLowerCase();
    if (ACCESS_LEVELS.includes(value)) return value;
    // 写错的档位按最严处理，避免拼写错误静默变成公开。
    if (value) return 'protagonist';
    if (entity.visibility === 'public') return 'public';
    if (typeof entity.visibility === 'string' && entity.visibility) return 'protagonist';
    if (entity.knownBy && typeof entity.knownBy === 'object' && Object.keys(entity.knownBy).length) return 'protagonist';
    return fallback;
}

export function entityAccess(entity, fallback = 'public') {
    return inferAccess(entity, fallback);
}

export function characterAccess(character) {
    if (!character) return 'public';
    // 主角固定 protagonist；兼容旧数据里用 tier:"main" 标主角。
    if (character.id === PROTAGONIST_ID || character.tier === 'main') return 'protagonist';
    return normalizeAccess(character.access, 'public');
}

/** 角色够不够格知道这条信息；主角永远够格。 */
export function knowsEntity(entity, characterId, state, fallback = 'public') {
    if (!characterId) return false;
    if (characterId === PROTAGONIST_ID) return true;
    const need = ACCESS_RANK[entityAccess(entity, fallback)] ?? 0;
    const have = ACCESS_RANK[characterAccess(state?.characters?.[characterId])] ?? 0;
    return have >= need;
}

/** 「长老」这类称呼对不上档案时，尝试唯一匹配名字里含该称呼的人（赵长老）。 */
function matchByAddressTerm(state, text) {
    const needle = String(text ?? '').trim();
    if (!needle) return '';
    const hits = Object.values(state?.characters || {}).filter((character) => {
        const names = [character.name, ...(Array.isArray(character.aliases) ? character.aliases : [])].filter(Boolean);
        return names.some((name) => String(name).includes(needle) || needle.includes(String(name)));
    });
    return hits.length === 1 ? hits[0].id : '';
}

/** 目击者里与主角关系最疏远的那位，决定条目最窄能到哪一档。 */
function accessFromWitnesses(state, witnesses) {
    const ids = (Array.isArray(witnesses) ? witnesses : []).filter((id) => state?.characters?.[id]);
    if (!ids.length) return null;
    let rank = ACCESS_RANK.protagonist;
    for (const id of ids) rank = Math.min(rank, ACCESS_RANK[characterAccess(state.characters[id])]);
    return ACCESS_LEVELS[rank] || null;
}

/**
 * 按剧情定档：显式档位优先；但它若把目击者排除在外，就放宽到最疏远的目击者。
 * 没有目击者时保留显式档位；两者都没有才用类型默认。
 */
function deriveAccess(state, explicit, witnesses, fallback) {
    const hasExplicit = explicit !== undefined && explicit !== null && explicit !== '';
    const access = hasExplicit ? explicitAccess(explicit, fallback) : null;
    const scope = accessFromWitnesses(state, witnesses);
    if (!scope) return access ?? fallback;
    return access && ACCESS_RANK[access] <= ACCESS_RANK[scope] ? access : scope;
}


/** 提取模型有时把内部 id 写进正文，注入与状态栏就会露出 "user"。 */
function playerText(value) {
    const text = String(value ?? '');
    if (!text) return text;
    return text.replace(/(?<![A-Za-z0-9_])user(?![A-Za-z0-9_])/gi, PROTAGONIST_NAME);
}

/** 提取模型有时把 stateChanges 写成对象，直接 String() 会变成 "[object Object]"。 */
function changeText(value) {
    if (value == null) return '';
    if (typeof value === 'object') {
        const parts = Object.entries(value)
            .filter(([, part]) => part != null && part !== '')
            .map(([key, part]) => `${key}: ${typeof part === 'object' ? JSON.stringify(part) : part}`);
        return playerText(parts.join('；'));
    }
    return playerText(value);
}

export function isProtagonistAlias(value) {
    return PROTAGONIST_ALIASES.includes(String(value ?? '').trim());
}

export function createEmptyState() {
    return {
        version: LEDGER_VERSION,
        characters: {},
        facts: {},
        events: [],
        scene: {
            time: '',
            day: null,
            place: '',
            participants: [],
        },
        meta: {
            schemaVersion: 5,
            identityVersion: IDENTITY_VERSION,
            nextCharacterId: 1,
            lastProcessedMessage: -1,
            lastProcessedHash: '',
            messagesSinceSettle: 0,
            lastSettleAt: null,
            lastError: '',
            protagonistId: '',
            leaks: [],
            health: [],
            history: [],
        },
    };
}

export function normalizeState(input) {
    const state = input && typeof input === 'object' ? input : createEmptyState();
    if (!state.version) state.version = LEDGER_VERSION;
    if (!state.characters || typeof state.characters !== 'object') state.characters = {};
    if (!state.facts || typeof state.facts !== 'object') state.facts = {};
    if (!Array.isArray(state.events)) state.events = [];
    if (!state.scene || typeof state.scene !== 'object') {
        state.scene = { time: '', day: null, place: '', participants: [] };
    }
    if (state.scene.chapter !== undefined) {
        if (!state.scene.time) state.scene.time = state.scene.chapter || '';
        delete state.scene.chapter;
    }
    if (!Array.isArray(state.scene.participants)) state.scene.participants = [];
    state.scene.day = normalizeDay(state.scene.day);
    for (const event of state.events) {
        if (event.chapter !== undefined) {
            if (!event.time) event.time = event.chapter || '';
            delete event.chapter;
        }
        event.day = normalizeDay(event.day);
    }
    if (!state.meta || typeof state.meta !== 'object') state.meta = createEmptyState().meta;
    if (!Array.isArray(state.meta.leaks)) state.meta.leaks = [];
    if (!Array.isArray(state.meta.review)) state.meta.review = [];
    if (!Array.isArray(state.meta.health)) state.meta.health = [];
    if (!Array.isArray(state.meta.history)) state.meta.history = [];

    // 玩家固定是 user。旧聊天可能还没迁移到 user：此时唯一的 tier main 就是玩家本人。
    // 出现多个 tier main 时无法判断谁是玩家，全部降回 major，宁可没有主角也不让 NPC 拿到主角级。
    const hasUser = Boolean(state.characters[PROTAGONIST_ID]);
    const legacyMains = hasUser
        ? []
        : Object.values(state.characters).filter((character) => character.tier === 'main');
    const protagonistId = hasUser
        ? PROTAGONIST_ID
        : (legacyMains.length === 1 ? legacyMains[0].id : '');

    for (const character of Object.values(state.characters)) {
        if (!character.state) character.state = {};
        if (character.id === protagonistId) {
            character.tier = 'main';
            character.access = 'protagonist';
        } else {
            if (character.tier === 'main') character.tier = 'major';
            // protagonist 档位只属于玩家；NPC 身上残留的必须降回公开。
            character.access = character.access === 'protagonist'
                ? 'public'
                : normalizeAccess(character.access, 'public');
        }
        if (!Array.isArray(character.items)) character.items = [];
        if (!Array.isArray(character.relations)) character.relations = [];
        if (!Array.isArray(character.facts)) character.facts = [];
        if (!Array.isArray(character.skills)) character.skills = [];
        if (!Array.isArray(character.abilities)) character.abilities = [];
        for (const item of character.items) {
            const quantity = Number(item.quantity);
            item.quantity = Number.isFinite(quantity) ? quantity : 1;
            if (typeof item.unit !== 'string') item.unit = '';
            if (typeof item.kind !== 'string') item.kind = 'item';
            item.access = entityAccess(item, 'public');
        }
        for (const entry of Object.values(character.state)) {
            if (entry && typeof entry === 'object') entry.access = entityAccess(entry, 'public');
        }
        for (const relation of character.relations) {
            if (relation && typeof relation === 'object') relation.access = entityAccess(relation, 'public');
        }
        for (const fact of character.facts) {
            if (fact && typeof fact === 'object') fact.access = entityAccess(fact, 'public');
        }
        for (const skill of character.skills) {
            if (!skill.id) skill.id = `sk_${slug(skill.name || 'skill')}`;
            if (!Array.isArray(skill.history)) skill.history = [];
            skill.access = entityAccess(skill, 'public');
        }
        for (const ability of character.abilities) {
            if (!ability.id) ability.id = `ab_${slug(ability.name || 'ability')}`;
            if (!Array.isArray(ability.history)) ability.history = [];
            ability.access = entityAccess(ability, 'public');
        }
    }

    // 玩家固定是 user；只有它存在时才认这个主角 id。
    if (hasUser) state.meta.protagonistId = PROTAGONIST_ID;

    for (const fact of Object.values(state.facts)) {
        if (fact && typeof fact === 'object') fact.access = entityAccess(fact, 'protagonist');
    }
    for (const event of state.events) {
        if (event && typeof event === 'object') {
            event.access = entityAccess(event, 'public');
        }
    }

    sanitizePlayerRefs(state);

    return state;
}

/** 旧台账里可能已经把 user 写进正文，加载时统一改回「你」。 */
function sanitizePlayerRefs(state) {
    for (const character of Object.values(state.characters)) {
        for (const entry of Object.values(character.state || {})) {
            if (entry && typeof entry === 'object' && 'current' in entry) {
                if (typeof entry.current === 'string') entry.current = playerText(entry.current);
                for (const item of entry.history || []) {
                    if (typeof item.value === 'string') item.value = playerText(item.value);
                }
            }
        }
        for (const fact of character.facts || []) {
            if (typeof fact === 'string') continue;
            if (typeof fact.text === 'string') fact.text = playerText(fact.text);
        }
    }
    for (const fact of Object.values(state.facts || {})) {
        if (typeof fact.text === 'string') fact.text = playerText(fact.text);
        for (const item of fact.history || []) {
            if (typeof item.text === 'string') item.text = playerText(item.text);
        }
    }
    for (const event of state.events) {
        for (const key of ['problem', 'decision', 'result']) {
            if (typeof event[key] === 'string') event[key] = playerText(event[key]);
        }
        if (Array.isArray(event.stateChanges)) {
            event.stateChanges = event.stateChanges
                .map((change) => (typeof change === 'object' && change !== null ? changeText(change) : playerText(change)))
                .filter((change) => change && change !== '[object Object]');
        }
    }
}

/**
 * One-time migration: NPCs no longer keep items/relations.
 * Current NPC items are converted to personal facts so no plot information is lost.
 */
export function migrateNpcFields(inputState) {
    const state = normalizeState(inputState);
    if (Number(state.meta?.schemaVersion || 0) >= 4) return false;

    for (const character of Object.values(state.characters)) {
        if (character.tier === 'main') continue;
        const currentItems = (character.items || []).filter((item) => item.validTo == null);
        if (currentItems.length) {
            character.facts = Array.isArray(character.facts) ? character.facts : [];
            for (const item of currentItems) {
                character.facts.push({
                    text: `持有 ${formatItem(item)}`,
                    validFrom: item.validFrom || '',
                    validTo: null,
                });
            }
        }
        character.items = [];
        character.relations = [];
    }

    state.meta.schemaVersion = 4;
    return true;
}

/**
 * One-time migration: NPC self-description (fields/items/relations/facts) is always
 * player-visible, so its access/visibility/knownBy is dropped. Values stay untouched.
 */
export function migrateNpcIsolation(inputState) {
    const state = normalizeState(inputState);
    if (Number(state.meta?.schemaVersion || 0) >= 5) return false;

    for (const character of Object.values(state.characters)) {
        if (character.tier === 'main') continue;
        for (const entry of Object.values(character.state || {})) {
            if (!entry || typeof entry !== 'object') continue;
            delete entry.visibility;
            delete entry.knownBy;
            delete entry.access;
        }
        for (const collection of [character.items, character.relations, character.facts]) {
            for (const entry of collection || []) {
                if (!entry || typeof entry !== 'object') continue;
                delete entry.visibility;
                delete entry.knownBy;
                delete entry.access;
            }
        }
    }

    state.meta.schemaVersion = 5;
    return true;
}

export function estimateTokens(text) {
    if (!text) return 0;
    const cjk = (text.match(/[\u3400-\u9FFF\uF900-\uFAFF]/g) || []).length;
    const nonCjk = text.replace(/[\u3400-\u9FFF\uF900-\uFAFF]/g, ' ');
    const words = nonCjk.trim() ? nonCjk.trim().split(/\s+/).length : 0;
    const newlines = (text.match(/\n/g) || []).length;
    return Math.ceil(cjk + words * 1.3 + newlines * 0.5);
}

function slug(value) {
    const text = String(value ?? '').trim().toLowerCase();
    const ascii = text.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (ascii) return ascii;
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
        hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    }
    return `h${hash.toString(16)}`;
}

function validFromOf(op, state) {
    return op.validFrom ?? op.valid_from ?? state.scene?.time ?? '';
}

function evidenceOf(op) {
    let raw = String(op.evidence ?? '').trim();
    raw = raw.replace(/^msg:\s*/i, 'msg:').replace(/^msg:#/, 'msg:');
    if (/^#\d+$/.test(raw)) raw = `msg:${raw.slice(1)}`;
    return raw;
}

function confidenceOf(op) {
    const value = Number(op.confidence ?? 1);
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

/** Gender is a closed set: 男 / 女 / 未知. Titles are only used to infer it. */
function normalizeGender(value) {
    const text = String(value ?? '').trim();
    if (!text) return '未知';
    if (/女|姑娘|小姐|夫人|婆婆|师姐|师妹|妇人|女子/.test(text)) return '女';
    if (/男|公子|少爷|先生|师兄|师弟|男子/.test(text)) return '男';
    return '未知';
}

/** 境界进度统一成 0-100 的整数：容忍「43%」「43/100」，越界钳制，取不到数字就拒绝。 */
function normalizeProgress(value) {
    const number = Number.parseFloat(String(value ?? ''));
    if (!Number.isFinite(number)) throw new Error('set: progress 必须是 0-100 的数字');
    return Math.max(0, Math.min(100, Math.round(number)));
}

/** 故事内第几天：允许数字或数字字符串，取不到就当作未知。 */
function normalizeDay(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number.parseFloat(String(value));
    return Number.isFinite(number) ? Math.round(number) : null;
}

// Forms of address depend on who is speaking; they are never character names.
const ADDRESS_TERMS = new Set([
    '道友', '道兄', '道姑', '前辈', '晚辈', '后辈', '阁下', '足下', '施主',
    '父亲', '母亲', '爹', '娘', '师父', '师尊', '师叔', '师伯', '师兄', '师姐', '师弟', '师妹',
    '大人', '公子', '姑娘', '小姐', '夫人', '掌柜', '长老', '执事', '弟子', '老板', '东家',
    '蝼蚁', '小子', '丫头', '老丈', '婆婆', '先生',
    '小友', '客官', '小哥', '少侠', '兄弟', '贵客',
]);

function isAddressTerm(value) {
    return ADDRESS_TERMS.has(String(value ?? '').trim());
}

// ---------------------------------------------------------------- 角色身份
// Characters are keyed by opaque ids. Names and aliases are display data, so a
// name reveal never has to rewrite knownBy / relations / event actors.

function nextCharacterNumber(state) {
    const meta = state.meta || (state.meta = {});
    let next = Number(meta.nextCharacterId);
    if (!Number.isFinite(next) || next < 1) {
        next = 1;
        for (const id of Object.keys(state.characters || {})) {
            const match = String(id).match(/^npc_(\d+)$/);
            if (match) next = Math.max(next, Number(match[1]) + 1);
        }
    }
    return next;
}

function allocateCharacterId(state, reserved = new Set()) {
    const meta = state.meta || (state.meta = {});
    let next = nextCharacterNumber(state);
    let id;
    do {
        id = `npc_${String(next).padStart(3, '0')}`;
        next += 1;
    } while (reserved.has(id) || state.characters[id]);
    meta.nextCharacterId = next;
    return id;
}

function createCharacterRecord(state, id, name) {
    const isProtagonist = id === PROTAGONIST_ID;
    const character = {
        id,
        name: isProtagonist ? PROTAGONIST_NAME : (name || id),
        aliases: [],
        tier: isProtagonist ? 'main' : 'major',
        state: {},
        items: [],
        skills: [],
        abilities: [],
        relations: [],
        facts: [],
        updatedAt: null,
    };
    state.characters[id] = character;
    return character;
}

function findCharacterIdByName(state, name) {
    const text = String(name ?? '').trim();
    if (!text) return '';
    if (text === PROTAGONIST_ID || isProtagonistAlias(text)) return PROTAGONIST_ID;
    if (state.characters[text]) return text;
    for (const character of Object.values(state.characters || {})) {
        if (character.name === text) return character.id;
    }
    let aliasMatch = '';
    for (const character of Object.values(state.characters || {})) {
        if (!Array.isArray(character.aliases) || !character.aliases.includes(text)) continue;
        if (aliasMatch) return '';
        aliasMatch = character.id;
    }
    return aliasMatch;
}

/** Resolve a name / alias / id to the stable id. Unknown names create a record. */
export function resolveCharacterId(state, ref, options = {}) {
    const text = String(ref ?? '').trim();
    const create = options.create !== false;
    if (!text) return '';
    if (text === PROTAGONIST_ID || isProtagonistAlias(text)) {
        if (!state.characters[PROTAGONIST_ID] && create) {
            createCharacterRecord(state, PROTAGONIST_ID, PROTAGONIST_NAME);
        }
        return PROTAGONIST_ID;
    }
    if (state.characters[text]) return text;
    const found = findCharacterIdByName(state, text);
    if (found) return found;
    if (!create) return '';
    // A bare role ("执事") is not an identity; only create it when it already exists.
    if (isAddressTerm(text)) return '';
    // Existing opaque ids (lin_yuan, npc_001) keep their key; display names do not.
    if (/^[a-z][a-z0-9_]*$/i.test(text)) {
        createCharacterRecord(state, text, options.name || text);
        return text;
    }
    const id = allocateCharacterId(state);
    createCharacterRecord(state, id, options.name || text);
    return id;
}

function characterName(state, id) {
    if (id === PROTAGONIST_ID) return PROTAGONIST_NAME;
    return state.characters?.[id]?.name || id;
}

/**
 * Old ledgers keyed characters by name. Convert them once to opaque ids and
 * rewrite every reference, including the version log, so replay stays stable.
 */
export function migrateStableIds(inputState) {
    const state = inputState;
    if (!state || typeof state !== 'object') return false;
    if (!state.meta || typeof state.meta !== 'object') state.meta = {};
    if (Number(state.meta.identityVersion || 0) >= IDENTITY_VERSION) return false;
    if (!state.characters || typeof state.characters !== 'object') state.characters = {};

    const old = state.characters;
    const nameToId = new Map();
    const reserved = new Set();
    let next = Number(state.meta.nextCharacterId);
    if (!Number.isFinite(next) || next < 1) next = 1;
    for (const key of Object.keys(old)) {
        const match = String(key).match(/^npc_(\d+)$/);
        if (match) next = Math.max(next, Number(match[1]) + 1);
    }
    const allocate = () => {
        let id;
        do {
            id = `npc_${String(next).padStart(3, '0')}`;
            next += 1;
        } while (reserved.has(id));
        reserved.add(id);
        return id;
    };

    const rebuilt = {};
    for (const [oldKey, character] of Object.entries(old)) {
        if (!character || typeof character !== 'object') continue;
        let id;
        if (oldKey === PROTAGONIST_ID) {
            id = PROTAGONIST_ID;
        } else if (/^[a-z][a-z0-9_]*$/i.test(oldKey)) {
            // Existing opaque ids (lin_yuan, su_wan, npc_001) stay stable.
            id = oldKey;
        } else if (character.tier === 'main') {
            // A name-keyed protagonist becomes the reserved id.
            id = PROTAGONIST_ID;
        } else {
            id = allocate();
        }
        if (rebuilt[id]) id = allocate();
        reserved.add(id);
        const aliases = new Set(Array.isArray(character.aliases) ? character.aliases : []);
        if (oldKey && oldKey !== id && oldKey !== character.name) aliases.add(oldKey);
        const name = id === PROTAGONIST_ID ? PROTAGONIST_NAME : (character.name || oldKey || id);
        if (name && name !== id) nameToId.set(String(name), id);
        for (const alias of aliases) nameToId.set(String(alias), id);
        nameToId.set(oldKey, id);
        character.id = id;
        character.name = name;
        character.aliases = [...aliases];
        if (id === PROTAGONIST_ID) character.tier = 'main';
        rebuilt[id] = character;
    }
    state.characters = rebuilt;

    const resolve = (ref, create = true) => {
        const text = String(ref ?? '').trim();
        if (!text) return '';
        if (text === PROTAGONIST_ID || isProtagonistAlias(text)) {
            if (!state.characters[PROTAGONIST_ID] && create) {
                createCharacterRecord(state, PROTAGONIST_ID, PROTAGONIST_NAME);
            }
            return PROTAGONIST_ID;
        }
        if (state.characters[text]) return text;
        if (nameToId.has(text)) return nameToId.get(text);
        if (!create || isAddressTerm(text)) return '';
        const id = allocate();
        const character = createCharacterRecord(state, id, text);
        character.tier = 'major';
        nameToId.set(text, id);
        return id;
    };

    const rewriteBeliefs = (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const out = {};
        for (const [key, info] of Object.entries(value)) {
            const id = resolve(key, true);
            if (!id) continue;
            out[id] = info;
        }
        return out;
    };

    const rewriteOp = (op) => {
        if (!op || typeof op !== 'object') return;
        for (const key of ['character', 'characterId', 'from', 'to', 'by']) {
            if (op[key] !== undefined) op[key] = resolve(op[key], true);
        }
        if (op.scene && Array.isArray(op.scene.participants)) {
            op.scene = {
                ...op.scene,
                participants: [...new Set(op.scene.participants.map((name) => resolve(name, true)).filter(Boolean))],
            };
        }
        if (Array.isArray(op.participants)) {
            op.participants = [...new Set(op.participants.map((name) => resolve(name, true)).filter(Boolean))];
        }
        if (op.item && typeof op.item === 'object' && op.item.holder !== undefined) {
            op.item.holder = resolve(op.item.holder, true);
        }
        if (op.event && typeof op.event === 'object') {
            for (const key of ['actors', 'witnesses']) {
                if (Array.isArray(op.event[key])) {
                    op.event[key] = [...new Set(op.event[key].map((name) => resolve(name, true)).filter(Boolean))];
                }
            }
            if (op.event.beliefs) op.event.beliefs = rewriteBeliefs(op.event.beliefs);
        }
        if (op.fact && typeof op.fact === 'object' && op.fact.beliefs) {
            op.fact.beliefs = rewriteBeliefs(op.fact.beliefs);
        }
        if (op.relation !== undefined) op.relation = resolve(op.relation, true);
    };

    if (state.scene && Array.isArray(state.scene.participants)) {
        state.scene.participants = [
            ...new Set(state.scene.participants.map((name) => resolve(name, true)).filter(Boolean)),
        ];
    }
    for (const character of Object.values(state.characters)) {
        for (const item of character.items || []) {
            if (item.holder !== undefined) item.holder = resolve(item.holder, true);
            if (item.beliefs) item.beliefs = rewriteBeliefs(item.beliefs);
        }
        for (const entry of Object.values(character.state || {})) {
            if (entry && typeof entry === 'object' && entry.beliefs) entry.beliefs = rewriteBeliefs(entry.beliefs);
        }
        for (const relation of character.relations || []) {
            if (relation.target !== undefined) {
                const id = resolve(relation.target, true);
                if (id) relation.target = id;
                if (!relation.targetName && id) relation.targetName = characterName(state, id);
            }
            if (relation.beliefs) relation.beliefs = rewriteBeliefs(relation.beliefs);
        }
        for (const fact of character.facts || []) {
            if (fact.beliefs) fact.beliefs = rewriteBeliefs(fact.beliefs);
        }
        for (const trait of [...(character.skills || []), ...(character.abilities || [])]) {
            if (trait.beliefs) trait.beliefs = rewriteBeliefs(trait.beliefs);
        }
    }
    for (const fact of Object.values(state.facts || {})) {
        if (fact && typeof fact === 'object' && fact.beliefs) fact.beliefs = rewriteBeliefs(fact.beliefs);
    }
    for (const event of state.events || []) {
        if (Array.isArray(event.actors)) {
            event.actors = [...new Set(event.actors.map((name) => resolve(name, true)).filter(Boolean))];
        }
        if (Array.isArray(event.witnesses)) {
            event.witnesses = [...new Set(event.witnesses.map((name) => resolve(name, true)).filter(Boolean))];
        }
        if (event.beliefs) event.beliefs = rewriteBeliefs(event.beliefs);
    }
    for (const record of state.meta.history || []) {
        if (Array.isArray(record.ops)) record.ops.forEach(rewriteOp);
        if (record.scene && Array.isArray(record.scene.participants)) {
            record.scene.participants = [
                ...new Set(record.scene.participants.map((name) => resolve(name, true)).filter(Boolean)),
            ];
        }
    }
    if (Array.isArray(state.meta.leaks)) {
        for (const leak of state.meta.leaks) {
            if (!leak || typeof leak !== 'object' || !leak.character) continue;
            const id = resolve(leak.character, true);
            if (id) {
                leak.character = id;
                leak.characterName = characterName(state, id);
            }
        }
    }
    if (state.meta.protagonistId) {
        const id = resolve(state.meta.protagonistId, false);
        if (id) state.meta.protagonistId = id;
    }
    state.meta.identityVersion = IDENTITY_VERSION;
    state.meta.nextCharacterId = next;
    return true;
}

function isPublicEntity(entity, fallback = 'public') {
    return entityAccess(entity, fallback) === 'public';
}

/** 给非公开条目加一个 [K:...] 标记，避免叙事者把秘密当成公开信息。 */
function knownByTag(entity, state, fallback = 'public') {
    const names = Object.values(state?.characters || {})
        .filter((character) => knowsEntity(entity, character.id, state, fallback))
        .map((character) => (character.id === PROTAGONIST_ID ? PROTAGONIST_NAME : (character.name || character.id)));
    if (!names.length) return '';
    return `[K:${names.slice(0, 6).join('、')}${names.length > 6 ? '等' : ''}]`;
}

function findCurrentItem(state, itemRef) {
    const ref = String(itemRef ?? '').trim();
    // 同名物品很常见：先找主角自己的，再找别人手里的。
    const order = [
        ...(state.characters?.[PROTAGONIST_ID] ? [state.characters[PROTAGONIST_ID]] : []),
        ...Object.values(state.characters).filter((character) => character.id !== PROTAGONIST_ID),
    ];
    for (const character of order) {
        const item = (character.items || []).find(
            (entry) => entry.validTo == null && (entry.id === ref || entry.name === ref),
        );
        if (item) return item;
    }
    return null;
}

function findCurrentRelation(state, target) {
    for (const character of Object.values(state.characters)) {
        const relation = (character.relations || []).find(
            (entry) => entry.validTo == null && (entry.target === target || entry.targetName === target),
        );
        if (relation) return relation;
    }
    return null;
}

function findCurrentTrait(state, field, traitId) {
    for (const character of Object.values(state.characters)) {
        const trait = (character[field] || []).find(
            (entry) => entry.validTo == null && (entry.id === traitId || entry.name === traitId),
        );
        if (trait) return trait;
    }
    return null;
}

function ensureCharacter(state, id, name) {
    const ref = String(id ?? '').trim();
    let key;
    if (ref && state.characters[ref]) {
        key = ref;
    } else if (ref || name) {
        key = resolveCharacterId(state, ref || name, { create: true, name: name || ref });
    } else {
        key = allocateCharacterId(state);
    }
    if (!key) return null;
    const isProtagonist = key === PROTAGONIST_ID;
    if (!state.characters[key]) {
        createCharacterRecord(state, key, name || ref);
    }
    const character = state.characters[key];
    if (isProtagonist) {
        character.name = PROTAGONIST_NAME;
        character.tier = 'main';
    }
    if (!character.state) character.state = {};
    if (!Array.isArray(character.items)) character.items = [];
    if (!Array.isArray(character.skills)) character.skills = [];
    if (!Array.isArray(character.abilities)) character.abilities = [];
    if (!Array.isArray(character.relations)) character.relations = [];
    if (!Array.isArray(character.facts)) character.facts = [];
    return character;
}

/** Create a name-only record for someone the narration put on stage. */
export function ensureCharacterRecord(inputState, name) {
    const ref = String(name || '').trim();
    if (!ref || isAddressTerm(ref)) return null;
    const state = normalizeState(inputState);
    migrateStableIds(state);
    return ensureCharacter(state, ref);
}

/** 玩家身份字段：允许首次记录，不允许后续改写。 */
const PLAYER_IDENTITY_FIELDS = new Set([
    'spiritRoot', 'physique', 'constitution', 'origin', 'birth', 'background', 'family', 'name',
]);

/** 提取模型偶尔会写中文字段名；先归一化，再走身份字段保护。 */
const FIELD_ALIASES = {
    灵根: 'spiritRoot',
    体质: 'physique',
    身世: 'origin',
    出身: 'origin',
    家族: 'family',
    姓名: 'name',
};

function setField(state, op) {
    const character = ensureCharacter(state, op.character || op.characterId, op.name);
    const field = FIELD_ALIASES[String(op.field ?? '').trim()] || op.field;
    if (!field) throw new Error('set: 缺少 field');
    const value = field === 'gender'
        ? normalizeGender(op.value)
        : field === 'progress'
            ? normalizeProgress(op.value)
            : (typeof op.value === 'string' ? playerText(op.value) : op.value);
    // 玩家主权：灵根/体质/身世等身份字段只允许首次记录，不能覆盖已写出的内容。
    if (character.id === PROTAGONIST_ID && PLAYER_IDENTITY_FIELDS.has(field)) {
        const current = currentField(character, field);
        if (current !== '' && current !== null && current !== undefined && String(current) !== String(value)) {
            throw new Error(`set: 不能改写玩家的 ${field}`);
        }
    }
    const from = validFromOf(op, state);
    const evidence = evidenceOf(op);
    const confidence = confidenceOf(op);
    const entry = character.state[field] && typeof character.state[field] === 'object'
        ? character.state[field]
        : { current: character.state[field] ?? null, history: [] };
    if (!Array.isArray(entry.history)) entry.history = [];

    // Repeating the same value (e.g. seeding from the character card every turn)
    // must not grow the dual-temporal history.
    if (entry.current !== null && entry.current !== undefined
        && String(entry.current) === String(value)
        && op.access === undefined && op.visibility === undefined) {
        return character;
    }

    const open = entry.history.filter((item) => item.validTo == null);
    if (open.length === 0 && entry.current != null) {
        entry.history.push({
            value: entry.current,
            validFrom: entry.validFrom ?? '',
            validTo: from,
            evidence: entry.evidence ?? '',
            confidence: entry.confidence ?? 1,
        });
    } else {
        for (const item of open) item.validTo = from;
    }

    entry.history.push({
        value,
        validFrom: from,
        validTo: null,
        evidence,
        confidence,
    });
    entry.current = value;
    entry.validFrom = from;
    entry.evidence = evidence;
    entry.confidence = confidence;
    if (op.access !== undefined) entry.access = explicitAccess(op.access, entityAccess(entry, 'public'));
    else if (op.visibility !== undefined) entry.access = op.visibility === 'public' ? 'public' : 'protagonist';
    character.state[field] = entry;
    character.updatedAt = new Date().toISOString();
    return character;
}

function addItem(state, op) {
    const character = ensureCharacter(state, op.character || op.characterId, op.name);
    const raw = op.item && typeof op.item === 'object' ? op.item : { name: op.item };
    const name = raw.name || raw.id;
    if (!name) throw new Error('add_item: 缺少 item.name');
    const id = raw.id || `i_${slug(name)}`;
    const from = validFromOf(op, state);
    const evidence = evidenceOf(op);
    const confidence = confidenceOf(op);
    const quantity = Number(raw.quantity ?? op.quantity ?? 1);
    const safeQuantity = Number.isFinite(quantity) ? quantity : 1;
    const unit = raw.unit || op.unit || '';
    const kind = raw.kind || op.kind || 'item';
    const merge = raw.merge === true || op.merge === true || kind === 'currency';

    if (merge) {
        const existing = character.items.find((item) => item.id === id && item.validTo == null);
        if (existing) {
            existing.quantity = Number(existing.quantity ?? 1) + safeQuantity;
            if (unit) existing.unit = unit;
            if (kind) existing.kind = kind;
            if (raw.note) existing.note = raw.note;
            if (raw.access ?? op.access) existing.access = explicitAccess(raw.access ?? op.access, entityAccess(existing, 'public'));
            existing.updatedAt = new Date().toISOString();
            character.updatedAt = new Date().toISOString();
            return character;
        }
    }

    // 同名条目重新登记时，新版本要继承旧版本的可见性；否则秘密会因重记一次变成公开。
    let template = null;
    for (const item of character.items) {
        if (item.id === id && item.validTo == null) {
            if (!template) template = item;
            item.validTo = from;
        }
    }
    // 同名条目重新登记时，新版本要继承旧版本的档位；否则秘密会因重记一次变成公开。
    const access = explicitAccess(
        raw.access ?? op.access,
        template ? entityAccess(template, 'public') : 'public',
    );
    character.items.push({
        id,
        name,
        holder: raw.holder || character.id,
        note: raw.note || '',
        quantity: safeQuantity,
        unit,
        kind,
        quantityHistory: [],
        validFrom: from,
        validTo: null,
        evidence,
        confidence,
        access,
    });
    character.updatedAt = new Date().toISOString();
    return character;
}

/** 提取模型有时把 item 写成对象（add_item 的写法），统一取出 id 与附加字段。 */
function itemArg(op) {
    const raw = op.item;
    if (raw && typeof raw === 'object') {
        return { id: raw.id || raw.name || '', spec: raw };
    }
    return { id: raw, spec: null };
}

function moveItem(state, op) {
    const { id: itemId } = itemArg(op);
    if (!itemId) throw new Error('move_item: 缺少 item');
    const to = op.to || op.holder;
    if (!to) throw new Error('move_item: 缺少 to');
    const from = validFromOf(op, state);
    const evidence = evidenceOf(op);
    const confidence = confidenceOf(op);
    // 物品本来就在这个人手上：不要为了「转手给他」把旧记录关掉再开一条。
    const alreadyHeld = (state.characters[to]?.items || [])
        .find((item) => item.id === itemId && item.validTo == null);
    if (alreadyHeld) return state.characters[to];
    let template = null;
    for (const character of Object.values(state.characters)) {
        for (const item of character.items) {
            if (item.id === itemId && item.validTo == null) {
                template = item;
                item.validTo = from;
            }
        }
    }
    if (!template) throw new Error(`move_item: 找不到物品 ${itemId}`);
    const wasGated = !isPublicEntity(template);
    const holder = ensureCharacter(state, to, op.toName);
    // 物品到了谁手里，谁就必然知道；档位跟着持有人一起放宽。
    const inherited = entityAccess(template, 'public');
    const access = !wasGated
        ? inherited
        : (ACCESS_RANK[inherited] > ACCESS_RANK[characterAccess(holder)] ? characterAccess(holder) : inherited);
    holder.items.push({
        id: itemId,
        name: op.name || template.name || itemId,
        holder: holder.id,
        note: template.note || '',
        quantity: template.quantity ?? 1,
        unit: template.unit || '',
        kind: template.kind || 'item',
        quantityHistory: Array.isArray(template.quantityHistory) ? [...template.quantityHistory] : [],
        validFrom: from,
        validTo: null,
        evidence,
        confidence,
        access: explicitAccess(op.access, access),
    });
    return holder;
}

function adjustItem(state, op) {
    const { id: itemId, spec } = itemArg(op);
    if (!itemId) throw new Error('adjust_item: 缺少 item');
    const delta = Number(op.delta);
    if (!Number.isFinite(delta) || delta === 0) throw new Error('adjust_item: delta 必须是非零数字');

    const targetId = op.character || op.characterId;
    const targetCharacter = targetId ? ensureCharacter(state, targetId, op.characterName) : null;
    let item = targetCharacter
        ? targetCharacter.items.find((entry) => entry.id === itemId && entry.validTo == null)
        : findCurrentItem(state, itemId);

    if (!item && targetCharacter) {
        item = {
            id: itemId,
            name: op.itemName || spec?.name || itemId,
            holder: targetCharacter.id,
            note: '',
            quantity: 0,
            unit: op.unit || spec?.unit || '',
            kind: op.kind || spec?.kind || 'currency',
            quantityHistory: [],
            validFrom: validFromOf(op, state),
            validTo: null,
            evidence: evidenceOf(op),
            confidence: confidenceOf(op),
        };
        targetCharacter.items.push(item);
    }
    if (!item) throw new Error(`adjust_item: 找不到物品 ${itemId}`);

    const before = Number(item.quantity ?? 1);
    const after = Math.max(0, before + delta);
    item.quantity = after;
    if (op.unit) item.unit = op.unit;
    if (op.kind) item.kind = op.kind;
    if (op.itemName) item.name = op.itemName;
    item.quantityHistory = Array.isArray(item.quantityHistory) ? item.quantityHistory : [];
    item.quantityHistory.push({
        delta,
        before,
        after,
        clamped: before + delta < 0,
        reason: op.reason || '',
        validFrom: validFromOf(op, state),
        evidence: evidenceOf(op),
        at: new Date().toISOString(),
    });
    item.updatedAt = new Date().toISOString();
    return item;
}

function removeItem(state, op) {
    const { id: itemId } = itemArg(op);
    if (!itemId) throw new Error('remove_item: 缺少 item');
    const targetId = op.character || op.characterId;
    const from = validFromOf(op, state);
    const targets = targetId
        ? [state.characters[targetId]].filter(Boolean)
        : Object.values(state.characters);
    let found = 0;
    for (const character of targets) {
        for (const item of character.items || []) {
            if (item.id === itemId && item.validTo == null) {
                item.validTo = from;
                item.removedReason = op.reason || '';
                item.removedEvidence = evidenceOf(op);
                found += 1;
            }
        }
    }
    if (!found) throw new Error(`remove_item: 找不到物品 ${itemId}`);
    return found;
}

function clearItems(state, op) {
    const targetId = op.character || op.characterId;
    const kinds = Array.isArray(op.kinds) ? op.kinds : null;
    const includeCurrency = op.includeCurrency === true;
    const from = validFromOf(op, state);
    const targets = targetId
        ? [state.characters[targetId]].filter(Boolean)
        : Object.values(state.characters);
    let count = 0;

    for (const character of targets) {
        for (const item of character.items || []) {
            if (item.validTo != null) continue;
            const kind = item.kind || 'item';
            const matches = kinds
                ? kinds.includes(kind)
                : (kind !== 'currency' || includeCurrency);
            if (!matches) continue;

            if (kind === 'currency') {
                const before = Number(item.quantity ?? 0);
                item.quantity = 0;
                item.quantityHistory = Array.isArray(item.quantityHistory) ? item.quantityHistory : [];
                item.quantityHistory.push({
                    delta: -before,
                    before,
                    after: 0,
                    reason: op.reason || 'clear_items',
                    validFrom: from,
                    evidence: evidenceOf(op),
                    at: new Date().toISOString(),
                });
            } else {
                item.validTo = from;
                item.removedReason = op.reason || '';
                item.removedEvidence = evidenceOf(op);
            }
            count += 1;
        }
    }
    return count;
}

function clearCurrency(state, op) {
    return clearItems(state, { ...op, kinds: ['currency'] });
}

function setItemQuantity(state, op) {
    const { id: itemId } = itemArg(op);
    const quantity = Number(op.quantity);
    if (!itemId) throw new Error('set_item_quantity: 缺少 item');
    if (!Number.isFinite(quantity) || quantity < 0) {
        throw new Error('set_item_quantity: quantity 必须是 >=0 的数字');
    }
    const targetId = op.character || op.characterId;
    let item = targetId
        ? state.characters[targetId]?.items?.find((entry) => entry.id === itemId && entry.validTo == null)
        : findCurrentItem(state, itemId);
    if (!item) throw new Error(`set_item_quantity: 找不到物品 ${itemId}`);

    const before = Number(item.quantity ?? 1);
    item.quantity = quantity;
    item.quantityHistory = Array.isArray(item.quantityHistory) ? item.quantityHistory : [];
    item.quantityHistory.push({
        delta: quantity - before,
        before,
        after: quantity,
        reason: op.reason || '',
        validFrom: validFromOf(op, state),
        evidence: evidenceOf(op),
        at: new Date().toISOString(),
    });
    return item;
}

function addTrait(state, op, { field, payload, prefix, defaultType }) {
    const character = ensureCharacter(state, op.character || op.characterId, op.characterName);
    const raw = op[payload] && typeof op[payload] === 'object' ? op[payload] : { name: op[payload] };
    const name = raw.name || raw.id;
    if (!name) throw new Error(`${op.op || 'add_trait'}: 缺少 ${payload}.name`);
    const id = raw.id || `${prefix}${slug(name)}`;
    const from = validFromOf(op, state);
    const evidence = evidenceOf(op);
    // 重记同一门功法/神通时继承旧版本的可见性，避免秘密被重新登记成公开。
    let template = null;
    for (const entry of character[field]) {
        if (entry.id === id && entry.validTo == null) {
            if (!template) template = entry;
            entry.validTo = from;
        }
    }
    const access = explicitAccess(
        raw.access ?? op.access,
        template ? entityAccess(template, 'public') : 'public',
    );
    character[field].push({
        id,
        name,
        type: raw.type || defaultType,
        level: raw.level || '',
        note: raw.note || '',
        access,
        validFrom: from,
        validTo: null,
        evidence,
        confidence: confidenceOf(op),
        history: [],
    });
    return character;
}

function addSkill(state, op) {
    return addTrait(state, op, { field: 'skills', payload: 'skill', prefix: 'sk_', defaultType: 'technique' });
}

function addAbility(state, op) {
    return addTrait(state, op, { field: 'abilities', payload: 'ability', prefix: 'ab_', defaultType: 'ability' });
}

function setTrait(state, op, { field, payload, label }) {
    const traitId = op[payload];
    if (!traitId) throw new Error(`set_${payload}: 缺少 ${payload}`);
    const targetId = op.character || op.characterId;
    const character = targetId
        ? state.characters[targetId]
        : Object.values(state.characters).find((entry) => (
            (entry[field] || []).some((trait) => trait.id === traitId && trait.validTo == null)
        ));
    if (!character) throw new Error(`set_${payload}: 找不到角色`);
    const trait = (character[field] || []).find((entry) => entry.id === traitId && entry.validTo == null);
    if (!trait) throw new Error(`set_${payload}: 找不到${label} ${traitId}`);

    const beforeLevel = trait.level || '';
    const from = validFromOf(op, state);
    const evidence = evidenceOf(op);
    if (op.level !== undefined) trait.level = op.level;
    if (op.note !== undefined) trait.note = op.note;
    if (op.access !== undefined) trait.access = explicitAccess(op.access, entityAccess(trait, 'public'));
    else if (op.visibility !== undefined) trait.access = op.visibility === 'public' ? 'public' : 'protagonist';
    trait.history = Array.isArray(trait.history) ? trait.history : [];
    trait.history.push({
        fromLevel: beforeLevel,
        toLevel: trait.level || '',
        note: trait.note || '',
        validFrom: from,
        evidence,
    });
    return trait;
}

function setSkill(state, op) {
    return setTrait(state, op, { field: 'skills', payload: 'skill', label: '技能' });
}

function setAbility(state, op) {
    return setTrait(state, op, { field: 'abilities', payload: 'ability', label: '神通' });
}

function removeTrait(state, op, { field, payload, label }) {
    const traitId = op[payload];
    if (!traitId) throw new Error(`remove_${payload}: 缺少 ${payload}`);
    const targetId = op.character || op.characterId;
    const targets = targetId
        ? [state.characters[targetId]].filter(Boolean)
        : Object.values(state.characters);
    let found = 0;
    for (const character of targets) {
        for (const trait of character[field] || []) {
            if (trait.id === traitId && trait.validTo == null) {
                trait.validTo = validFromOf(op, state);
                trait.removedReason = op.reason || '';
                found += 1;
            }
        }
    }
    if (!found) throw new Error(`remove_${payload}: 找不到${label} ${traitId}`);
    return found;
}

function removeSkill(state, op) {
    return removeTrait(state, op, { field: 'skills', payload: 'skill', label: '技能' });
}

function removeAbility(state, op) {
    return removeTrait(state, op, { field: 'abilities', payload: 'ability', label: '神通' });
}

/** 称呼属于「谁怎么称呼谁」这条关系，不是角色的别名。 */
function normalizeAddress(value) {
    const text = String(value ?? '').trim();
    return text ? text.slice(0, 12) : '';
}

function setRelation(state, op) {
    const fromId = op.from || op.character;
    const toId = op.to || op.target;
    if (!fromId || !toId) throw new Error('set_relation: 缺少 from/to');
    const character = ensureCharacter(state, fromId, op.fromName);
    const targetCharacter = state.characters[toId]
        || (toId === PROTAGONIST_ID ? ensureCharacter(state, toId) : undefined);
    const targetName = op.toName || targetCharacter?.name || toId;
    const timestamp = validFromOf(op, state);
    const address = normalizeAddress(op.address);
    const type = op.type || '';
    const live = (character.relations || []).find(
        (relation) => (relation.target === toId || relation.target === targetName) && relation.validTo == null,
    );
    const sameKind = !live || !type || type === live.type;
    const sameAddress = !address || address === live?.address;
    const sameAttitude = !op.attitude || op.attitude === live?.attitude;
    // 同一段关系被重复抽取（类型/态度/称呼都没变）：不产生新版本。
    if (live && sameKind && sameAddress && sameAttitude
        && op.access === undefined && op.visibility === undefined) {
        return character;
    }
    // 只是补/改称呼时原地更新，避免每回合关旧开新；态度变化仍保留历史版本。
    if (live && sameKind && !op.attitude) {
        if (address) live.address = address;
        live.evidence = evidenceOf(op) || live.evidence;
        live.confidence = confidenceOf(op);
        if (op.access !== undefined) live.access = explicitAccess(op.access, entityAccess(live, 'public'));
        else if (op.visibility !== undefined) live.access = op.visibility === 'public' ? 'public' : 'protagonist';
        return character;
    }
    for (const relation of character.relations) {
        if ((relation.target === toId || relation.target === targetName) && relation.validTo == null) {
            relation.validTo = timestamp;
        }
    }
    // 新版本继承旧关系的档位；否则态度一变，秘密同盟就变成公开关系。
    const access = explicitAccess(
        op.access,
        live ? entityAccess(live, 'public') : 'public',
    );
    character.relations.push({
        target: targetCharacter?.id || toId,
        targetName,
        type: type || live?.type || '',
        attitude: op.attitude || '',
        address: address || (sameKind ? live?.address || '' : ''),
        validFrom: timestamp,
        validTo: null,
        evidence: evidenceOf(op),
        confidence: confidenceOf(op),
        access,
    });
    return character;
}

/** 给 NPC 定知情档位：必须给理由，且只允许白名单里的关系事件。 */
function setCharacterTier(state, op) {
    const character = ensureCharacter(state, op.character || op.characterId, op.name);
    if (!character) throw new Error('set_tier: 找不到角色');
    if (character.id === PROTAGONIST_ID) return false;
    const current = characterAccess(character);
    const next = explicitAccess(op.access ?? op.tier, current);
    if (next === 'protagonist') throw new Error('set_tier: 主角档位只属于玩家');
    if (next === current) return false;

    const reason = String(op.reason ?? '').trim();
    if (!reason) throw new Error('set_tier: 缺少 reason（关系变化的依据）');
    const key = `${current}>${next}`;
    const up = ACCESS_RANK[next] > ACCESS_RANK[current];
    const allowed = up ? TIER_UPGRADE_REASONS[key] : TIER_DOWNGRADE_REASONS[key];
    if (!allowed || !allowed.has(reason)) {
        throw new Error(`set_tier: ${key} 不能用「${reason}」`);
    }

    const day = normalizeDay(state.scene?.day);
    const changedDay = normalizeDay(character.accessChangedDay);
    const milestone = TIER_MILESTONES.has(reason);
    // 反向冷却：防止一场戏里来回改档。
    if (!milestone && changedDay !== null && character.accessChangedFrom === next) {
        if (day === null || day - changedDay < TIER_REVERSE_COOLDOWN_DAYS) {
            throw new Error(`set_tier: 距上次改档不足 ${TIER_REVERSE_COOLDOWN_DAYS} 个故事日，且不是里程碑`);
        }
    }
    if (reason === '长期无往来') {
        const lastSeen = normalizeDay(character.lastSeenDay);
        if (day === null || lastSeen === null || day - lastSeen < TIER_ABSENCE_DAYS) {
            throw new Error(`set_tier: 长期无往来需至少 ${TIER_ABSENCE_DAYS} 个故事日且期间没有同场`);
        }
    }

    character.access = next;
    character.accessReason = reason;
    character.accessChangedFrom = current;
    character.accessChangedDay = day;
    character.accessChangedMessage = evidenceOf(op);
    character.updatedAt = new Date().toISOString();
    return true;
}

/** 关键词：正文再次提到时让旧秘密保持热度。排除泛指词，避免命中一切。 */
const KEYWORD_STOPWORDS = new Set(['你', '我', '他', '她', '玩家', '主角', '事件', '对话', '冲突', '事情', '对方']);

function readKeywords(value) {
    if (!Array.isArray(value)) return [];
    const words = value
        .map((item) => String(item ?? '').trim())
        .filter((item) => item.length >= 2 && item.length <= 12 && !KEYWORD_STOPWORDS.has(item));
    return [...new Set(words)].slice(0, 6);
}

/** 秘密物品/事实的名字片段：用于发现公开事件里误写的秘密词。 */
function secretNameFragments(state) {
    const fragments = new Set();
    const add = (name) => {
        const text = String(name || '').trim();
        if (text.length < 2) return;
        for (let size = 2; size <= Math.min(text.length, 4); size += 1) {
            for (let start = 0; start + size <= text.length; start += 1) {
                fragments.add(text.slice(start, start + size));
            }
        }
    };
    for (const character of Object.values(state.characters || {})) {
        for (const item of character.items || []) {
            if (item.validTo == null && !isPublicEntity(item)) add(item.name);
        }
        for (const trait of [...(character.skills || []), ...(character.abilities || [])]) {
            if (trait.validTo == null && !isPublicEntity(trait)) add(trait.name);
        }
        for (const fact of character.facts || []) {
            if (!isPublicEntity(fact)) {
                for (const word of readKeywords(fact.keywords || [])) add(word);
            }
        }
    }
    for (const fact of Object.values(state.facts || {})) {
        if (!isPublicEntity(fact, 'protagonist')) {
            for (const word of readKeywords(fact.keywords || [])) add(word);
        }
    }
    return fragments;
}

function appendEvent(state, op) {
    const raw = op.event && typeof op.event === 'object' ? op.event : op;
    let id = raw.id || `e${String(state.events.length + 1).padStart(4, '0')}`;
    while (state.events.some((event) => event.id === id)) {
        id = `${id}_1`;
    }
    // 目击者决定谁知道；没写 witnesses 时，参与者至少都知道。
    const witnesses = Array.isArray(raw.witnesses)
        ? raw.witnesses
        : (Array.isArray(raw.actors) ? raw.actors : []);
    const event = {
        id,
        time: raw.time || raw.chapter || state.scene?.time || '',
        // 事件自带 day 时用它，否则落在当前场景日。
        day: normalizeDay(raw.day) ?? normalizeDay(state.scene?.day),
        place: raw.place || state.scene?.place || '',
        actors: Array.isArray(raw.actors) ? raw.actors : [],
        problem: playerText(raw.problem || ''),
        decision: playerText(raw.decision || ''),
        result: playerText(raw.result || ''),
        stateChanges: Array.isArray(raw.stateChanges)
            ? raw.stateChanges.map(changeText).filter(Boolean)
            : (raw.stateChanges ? [changeText(raw.stateChanges)].filter(Boolean) : []),
        importance: raw.importance === 'major' ? 'major' : 'normal',
        keywords: readKeywords(raw.keywords),
        sourceMessages: Array.isArray(raw.sourceMessages) ? raw.sourceMessages : [],
        witnesses,
        access: deriveAccess(
            state,
            raw.access ?? op.access ?? (raw.visibility === 'public' ? 'public' : (raw.visibility ? 'protagonist' : undefined)),
            witnesses,
            'public',
        ),
        beliefs: raw.beliefs && typeof raw.beliefs === 'object' ? raw.beliefs : {},
        createdAt: new Date().toISOString(),
    };
    // 公开事件里出现秘密物品/事实的名字，说明这条事件不该是公开的。
    if (event.access === 'public') {
        const text = `${event.problem}${event.decision}${event.result}`;
        const leaked = [...secretNameFragments(state)].find((fragment) => text.includes(fragment));
        if (leaked) event.access = 'protagonist';
    }
    // Incremental settles may re-read a small context overlap; do not append the same event twice.
    const signature = [
        event.time, event.place, event.actors.join(','), event.problem, event.decision, event.result,
    ].join('|');
    const duplicate = state.events.find((item) => [
        item.time || '', item.place || '', (item.actors || []).join(','), item.problem || '', item.decision || '', item.result || '',
    ].join('|') === signature);
    if (duplicate) {
        // 重复抽取时不新增事件，但要把后补的关键词并进去，否则这条旧事永远召回不到。
        const merged = readKeywords([...(duplicate.keywords || []), ...(event.keywords || [])]);
        if (merged.length) duplicate.keywords = merged;
        // 首轮可能没带日期，后补的 day 要收下，不然旧事件算不出「多久以前」。
        if (duplicate.day == null && event.day != null) duplicate.day = event.day;
        // 目击者取并集：后补的目击者会放宽范围，不能被旧的更保密档位压住。
        const mergedWitnesses = [...new Set([...(duplicate.witnesses || []), ...(event.witnesses || [])])];
        if (mergedWitnesses.length) duplicate.witnesses = mergedWitnesses;
        // 后到的更保密档位可以收紧首轮误判；但目击者一旦看到，就不能收紧到把他们排除。
        let nextRank = Math.max(
            ACCESS_RANK[entityAccess(event, 'public')],
            ACCESS_RANK[entityAccess(duplicate, 'public')],
        );
        const scope = accessFromWitnesses(state, mergedWitnesses);
        if (scope) nextRank = Math.min(nextRank, ACCESS_RANK[scope]);
        duplicate.access = ACCESS_LEVELS[nextRank];
        if (event.beliefs && Object.keys(event.beliefs).length) {
            duplicate.beliefs = { ...(duplicate.beliefs || {}), ...event.beliefs };
        }
        return { event: duplicate, created: false };
    }
    state.events.push(event);
    return { event, created: true };
}

/** 事件已退役：新版本不再记录或注入事件，这部分记忆交给酒馆原生上下文与向量召回。 */

/** 未了结的线索：挂在事实上的可选字段，不单独建实体。 */
function readThreadFields(raw) {
    const fields = {};
    if (typeof raw.thread_status === 'string' && raw.thread_status) fields.thread_status = raw.thread_status;
    if (typeof raw.thread_type === 'string' && raw.thread_type) fields.thread_type = raw.thread_type;
    if (typeof raw.thread_stake === 'string' && raw.thread_stake) fields.thread_stake = raw.thread_stake;
    return fields;
}

/** 从 evidence 的 msg:N 取出消息序号，作为「最近一次被触碰」的时间。 */
function messageIndexOf(op) {
    const match = /msg:\s*(\d+)/.exec(evidenceOf(op));
    return match ? Number(match[1]) : null;
}

function addFact(state, op) {
    const raw = op.fact && typeof op.fact === 'object' ? op.fact : op;
    const text = playerText(raw.text || raw.factText || '');
    if (!text) throw new Error('add_fact: 缺少 text');
    const id = raw.id || `f_${slug(text).slice(0, 24)}`;
    const from = validFromOf(op, state);
    const evidence = evidenceOf(op);
    const touched = messageIndexOf(op);
    const keywords = readKeywords(raw.keywords);
    const witnesses = Array.isArray(raw.witnesses)
        ? raw.witnesses
        : (Array.isArray(op.witnesses) ? op.witnesses : []);
    // 按剧情定档：没人看见、也没显式写档位时，才回落到主角级。
    const explicit = raw.access ?? op.access
        ?? (raw.visibility === 'public' ? 'public' : (raw.visibility ? 'protagonist' : undefined));
    const access = deriveAccess(state, explicit, witnesses, 'protagonist');
    const beliefs = raw.beliefs && typeof raw.beliefs === 'object' ? raw.beliefs : null;
    if (!state.facts[id]) {
        state.facts[id] = {
            id,
            text,
            access,
            ...(witnesses.length ? { witnesses } : {}),
            ...(beliefs ? { beliefs } : {}),
            history: [],
            keywords,
            lastTouched: touched,
            ...readThreadFields(raw),
        };
    } else if (state.facts[id].text !== text) {
        const old = state.facts[id];
        old.history = old.history || [];
        old.history.push({
            text: old.text,
            validFrom: old.validFrom ?? '',
            validTo: from,
            evidence: old.evidence ?? '',
        });
        old.text = text;
        old.validFrom = from;
        old.evidence = evidence;
        // 改文本时也要处理档位；否则秘密会被改写成公开，公开也能被改写成秘密。
        if (raw.access !== undefined || raw.visibility !== undefined || witnesses.length) {
            old.access = access;
            if (witnesses.length) old.witnesses = witnesses;
        }
        if (beliefs) old.beliefs = { ...(old.beliefs || {}), ...beliefs };
        if (keywords.length) old.keywords = readKeywords([...(old.keywords || []), ...keywords]);
        if (touched !== null) old.lastTouched = touched;
        Object.assign(old, readThreadFields(raw));
    } else {
        const fact = state.facts[id];
        if (raw.access !== undefined || raw.visibility !== undefined || witnesses.length) {
            fact.access = access;
            if (witnesses.length) fact.witnesses = witnesses;
        }
        if (beliefs) fact.beliefs = { ...(fact.beliefs || {}), ...beliefs };
        Object.assign(fact, readThreadFields(raw));
        if (keywords.length) fact.keywords = readKeywords([...(fact.keywords || []), ...keywords]);
        if (touched !== null) fact.lastTouched = touched;
    }
    return state.facts[id];
}

/** reveal 的目标实体；找不到时抛出可读错误。 */
function revealTarget(state, op) {
    // 带 character 的 fact 指角色个人事实，先于顶层事实解析。
    if (op.character && op.fact) {
        const character = state.characters[op.character];
        const wanted = String(op.fact).trim();
        const entry = (character?.facts || []).find((item) => (
            item && typeof item === 'object' && String(item.text || item).trim() === wanted
        ));
        if (!entry) throw new Error(`reveal: 找不到 ${op.character} 的个人事实 ${wanted}`);
        return { entity: entry, label: `${character.name || op.character}：${wanted}` };
    }
    if (op.fact) {
        let fact = state.facts[op.fact];
        if (!fact) fact = Object.values(state.facts).find((item) => item.text === String(op.fact).trim()) || null;
        // reveal 只放宽已有条目，绝不凭空造事实。
        if (!fact) throw new Error(`reveal: 找不到事实 ${op.fact}`);
        return { entity: fact, label: fact.text };
    }
    if (op.character && op.field) {
        const character = state.characters[op.character];
        const entry = character?.state?.[op.field];
        if (!entry) throw new Error(`reveal: 找不到字段 ${op.character}.${op.field}`);
        return { entity: entry, label: `${character.name || op.character}.${op.field}` };
    }
    if (op.item) {
        const item = findCurrentItem(state, op.item);
        if (!item) throw new Error(`reveal: 找不到物品 ${op.item}`);
        return { entity: item, label: item.name };
    }
    if (op.relation) {
        const relation = findCurrentRelation(state, op.relation);
        if (!relation) throw new Error(`reveal: 找不到关系 ${op.relation}`);
        return { entity: relation, label: `关系 ${relation.targetName || relation.target}` };
    }
    if (op.skill || op.ability) {
        const field = op.ability ? 'abilities' : 'skills';
        const traitId = op.ability || op.skill;
        const trait = findCurrentTrait(state, field, traitId);
        if (!trait) throw new Error(`reveal: 找不到${op.ability ? '神通' : '功法'} ${traitId}`);
        return { entity: trait, label: trait.name };
    }
    if (op.event) {
        const event = state.events.find((item) => item.id === op.event);
        if (!event) throw new Error(`reveal: 找不到事件 ${op.event}`);
        return { entity: event, label: `事件 ${event.id}` };
    }
    throw new Error('reveal: 需要 fact / character+field / item / relation / skill / ability / event');
}

/** 把条目的档位放宽到「这个人也够格」为止；已经是公开就不动。 */
function lowerAccess(entity, to, state, explicit) {
    const current = entityAccess(entity, 'public');
    if (current === 'public') return false;
    const wanted = normalizeAccess(explicit, characterAccess(state.characters?.[to]));
    if (ACCESS_RANK[wanted] < ACCESS_RANK[current]) {
        entity.access = wanted;
        return true;
    }
    return false;
}

function reveal(state, op) {
    const to = op.to;
    if (!to) throw new Error('reveal: 缺少 to');
    const { entity, label } = revealTarget(state, op);
    if (!state.characters?.[to]) throw new Error(`reveal: 找不到角色 ${to}`);
    const fact = op.fact ? state.facts[entity.id] : null;
    if (fact) {
        const touched = messageIndexOf(op);
        if (touched !== null) fact.lastTouched = touched;
    }
    // 猜疑与误信不属于档位：只记在这个人身上，不写泄露事件、不改档位。
    if (op.belief || op.suspicion) {
        entity.beliefs = entity.beliefs && typeof entity.beliefs === 'object' ? entity.beliefs : {};
        entity.beliefs[to] = op.belief
            ? { state: 'false_belief', belief: op.belief }
            : { state: 'suspects', suspicion: op.suspicion };
        return false;
    }
    // 知道某件事 = 把条目档位放宽到这个人所在的档位；不允许用显式 access 越权。
    // 事件已退役，这里只改当前的知情状态，不再为扩散补写审计事件。
    return lowerAccess(entity, to, state);
}

export function validateOp(op, state) {
    if (!op || typeof op !== 'object') return 'op 不是对象';
    const type = op.op;
    if (!type) return '缺少 op 类型';
    const evidence = evidenceOf(op);
    if (type !== 'set_scene' && type !== 'append_event' && type !== 'add_event' && !evidence) {
        return `${type}: 缺少 evidence`;
    }
    for (const key of ['character', 'characterId', 'from', 'to']) {
        if (type === 'rename_character' || type === 'merge_character') break;
        const value = op[key];
        if (value && isAddressTerm(value)) {
            return `${type}: 「${value}」是称呼，不是角色名；请先判断它指代谁，再写那个角色的正式姓名`;
        }
    }
    switch (type) {
        case 'rename_character':
            if (!op.id && !op.from) return 'rename_character: 缺少 from/id';
            if (!op.name && !op.to) return 'rename_character: 缺少 to/name';
            return '';
        case 'merge_character':
            if (!op.fromId && !op.from) return 'merge_character: 缺少 from';
            if (!op.toId && !op.to) return 'merge_character: 缺少 to';
            return '';
        case 'set':
            if (!op.character && !op.characterId) return 'set: 缺少 character';
            if (!op.field) return 'set: 缺少 field';
            if (op.value === undefined) return 'set: 缺少 value';
            return '';
        case 'set_tier': {
            if (!op.character && !op.characterId) return 'set_tier: 缺少 character';
            const id = resolveCharacterId(state, op.character || op.characterId, { create: false });
            const person = id ? state.characters?.[id] : null;
            const current = person ? characterAccess(person) : 'public';
            const next = explicitAccess(op.access ?? op.tier, current);
            if (next !== current && !String(op.reason ?? '').trim()) {
                return 'set_tier: 缺少 reason（关系变化的依据）';
            }
            return '';
        }
        case 'add_item':
            if (!op.character && !op.characterId) return 'add_item: 缺少 character';
            if (!op.item) return 'add_item: 缺少 item';
            return '';
        case 'adjust_item':
            if (!op.item) return 'adjust_item: 缺少 item';
            if (!Number.isFinite(Number(op.delta))) return 'adjust_item: delta 必须是数字';
            return '';
        case 'remove_item':
            if (!op.item) return 'remove_item: 缺少 item';
            return '';
        case 'clear_items':
            if (op.kinds !== undefined && !Array.isArray(op.kinds)) return 'clear_items: kinds 必须是数组';
            return '';
        case 'clear_currency':
            return '';
        case 'set_item_quantity':
            if (!op.item) return 'set_item_quantity: 缺少 item';
            if (!Number.isFinite(Number(op.quantity)) || Number(op.quantity) < 0) return 'set_item_quantity: quantity 必须 >=0';
            return '';
        case 'add_skill':
            if (!op.character && !op.characterId) return 'add_skill: 缺少 character';
            if (!op.skill) return 'add_skill: 缺少 skill';
            return '';
        case 'set_skill':
            if (!op.skill) return 'set_skill: 缺少 skill';
            return '';
        case 'remove_skill':
            if (!op.skill) return 'remove_skill: 缺少 skill';
            return '';
        case 'add_ability':
            if (!op.character && !op.characterId) return 'add_ability: 缺少 character';
            if (!op.ability) return 'add_ability: 缺少 ability';
            return '';
        case 'set_ability':
            if (!op.ability) return 'set_ability: 缺少 ability';
            return '';
        case 'remove_ability':
            if (!op.ability) return 'remove_ability: 缺少 ability';
            return '';
        case 'move_item':
            if (!op.item) return 'move_item: 缺少 item';
            if (!op.to && !op.holder) return 'move_item: 缺少 to';
            return '';
        case 'set_relation':
            if (!op.from && !op.character) return 'set_relation: 缺少 from';
            if (!op.to && !op.target) return 'set_relation: 缺少 to';
            return '';
        case 'append_event':
        case 'add_event': {
            const raw = op.event && typeof op.event === 'object' ? op.event : op;
            if (!raw || (!raw.problem && !raw.result)) return 'append_event: 缺少 event';
            const changes = Array.isArray(raw.stateChanges)
                ? raw.stateChanges.filter(Boolean)
                : (raw.stateChanges ? [raw.stateChanges] : []);
            if (raw.importance !== 'major' && changes.length === 0) {
                return 'append_event: 普通事件必须写 stateChanges；写不出改变了什么就不算事件';
            }
            return '';
        }
        case 'add_fact':
            if (!op.fact && !op.text) return 'add_fact: 缺少 fact';
            return '';
        case 'reveal':
            if (!op.to) return 'reveal: 缺少 to';
            if (!op.fact && !(op.character && op.field) && !op.item && !op.relation && !op.skill && !op.ability && !op.event) {
                return 'reveal: 需要 fact / character+field / character+fact / item / relation / skill / ability / event';
            }
            return '';
        case 'set_scene':
            if (!op.scene && !op.time && !op.place && !op.participants && !(op.field && op.value !== undefined)) {
                return 'set_scene: 缺少 scene';
            }
            return '';
        default:
            return `未知 op 类型：${type}`;
    }
}

export function validateOps(ops, state, options = {}) {
    const accepted = [];
    const review = [];
    const rejected = [];
    const threshold = Number(options.confidenceThreshold ?? 0.7);
    const reviewThreshold = Number(options.reviewThreshold ?? 0.5);
    const messageCount = Number(options.messageCount ?? Number.POSITIVE_INFINITY);
    const list = Array.isArray(ops) ? ops : [];
    for (const op of list) {
        const reason = validateOp(op, state);
        if (reason) {
            rejected.push({ op, reason });
            continue;
        }
        const evidence = evidenceOf(op);
        if (evidence.startsWith('msg:')) {
            const indices = evidence.slice(4)
                .split(/[,，、\s]+/)
                .filter(Boolean)
                .map((part) => Number(part.replace(/^msg:/i, '')));
            const outOfRange = indices.some((index) => (
                !Number.isFinite(index) || index < 0 || index >= messageCount
            ));
            if (!indices.length || outOfRange) {
                rejected.push({ op, reason: `evidence ${evidence} 超出消息范围（共 ${messageCount} 条）` });
                continue;
            }
        }
        const confidence = confidenceOf(op);
        if (confidence < reviewThreshold) {
            rejected.push({ op, reason: `置信度 ${confidence} < ${reviewThreshold}` });
            continue;
        }
        if (confidence < threshold) {
            review.push({ ...op, needsReview: true });
            continue;
        }
        accepted.push(op);
    }
    return { accepted, review, rejected };
}

function normalizeProtagonistRef(value, aliases = []) {
    const text = String(value ?? '').trim();
    if (!text) return value;
    if (text === PROTAGONIST_ID || isProtagonistAlias(text) || aliases.includes(text)) {
        return PROTAGONIST_ID;
    }
    return value;
}

/**
 * The player has no in-story name: every reference to 你/我/玩家/主角/persona
 * collapses onto the stable id `user` before validation and apply.
 */
function normalizeProtagonistOps(ops, aliases = []) {
    const list = Array.isArray(ops) ? ops : [];
    return list.map((raw) => {
        if (!raw || typeof raw !== 'object') return raw;
        const op = { ...raw };
        for (const key of ['character', 'characterId', 'from', 'to', 'by']) {
            if (op[key] !== undefined) op[key] = normalizeProtagonistRef(op[key], aliases);
        }
        if (op.character === PROTAGONIST_ID) op.name = PROTAGONIST_NAME;
        if (op.from === PROTAGONIST_ID) op.fromName = PROTAGONIST_NAME;
        if (op.to === PROTAGONIST_ID) op.toName = PROTAGONIST_NAME;
        if (op.characterId === PROTAGONIST_ID) op.character = PROTAGONIST_ID;
        if (op.scene && Array.isArray(op.scene.participants)) {
            op.scene = {
                ...op.scene,
                participants: op.scene.participants.map((name) => normalizeProtagonistRef(name, aliases)),
            };
        } else if (Array.isArray(op.participants)) {
            op.participants = op.participants.map((name) => normalizeProtagonistRef(name, aliases));
        }
        for (const key of ['actors', 'witnesses']) {
            if (Array.isArray(op[key])) op[key] = op[key].map((name) => normalizeProtagonistRef(name, aliases));
        }
        if (op.item && typeof op.item === 'object') {
            op.item = { ...op.item };
            if (op.item.holder !== undefined) {
                op.item.holder = normalizeProtagonistRef(op.item.holder, aliases);
            }
        }
        if (op.event && typeof op.event === 'object') {
            op.event = { ...op.event };
            for (const key of ['actors', 'witnesses']) {
                if (Array.isArray(op.event[key])) {
                    op.event[key] = op.event[key].map((name) => normalizeProtagonistRef(name, aliases));
                }
            }
        }
        if (op.fact && typeof op.fact === 'object') {
            op.fact = { ...op.fact };
            if (Array.isArray(op.fact.witnesses)) {
                op.fact.witnesses = op.fact.witnesses.map((name) => normalizeProtagonistRef(name, aliases));
            }
        }
        return op;
    });
}

/** beliefs 的键也是角色名，落库前统一换成稳定 id。 */
function rewriteBeliefKeys(state, beliefs) {
    if (!beliefs || typeof beliefs !== 'object' || Array.isArray(beliefs)) return beliefs;
    const out = {};
    for (const [key, info] of Object.entries(beliefs)) {
        const id = resolveCharacterId(state, key, { create: true });
        if (id) out[id] = info;
    }
    return out;
}

/** Turn every name in an op into the stable character id before it reaches a handler. */
function resolveOpRefs(state, op) {
    if (!op || typeof op !== 'object') return op;
    if (op.op === 'rename_character') {
        op.id = resolveCharacterId(state, op.id || op.from, { create: true });
        op.name = String(op.name || op.to || characterName(state, op.id)).trim();
        delete op.from;
        delete op.to;
        return op;
    }
    if (op.op === 'merge_character') {
        op.fromId = resolveCharacterId(state, op.fromId || op.from, { create: true });
        op.toId = resolveCharacterId(state, op.toId || op.to, { create: true });
        delete op.from;
        delete op.to;
        return op;
    }
    for (const key of ['character', 'characterId', 'from', 'to', 'by']) {
        if (op[key] !== undefined) {
            const name = key === 'character' || key === 'characterId'
                ? op.name
                : key === 'from'
                    ? op.fromName
                    : key === 'to'
                        ? op.toName
                        : undefined;
            const id = key === 'to' && op.op === 'reveal'
                // reveal 的目标必须是已有角色；写错名字不能新建一个公开级角色来放宽秘密。
                ? (resolveCharacterId(state, op[key], { create: false }) || String(op[key]))
                : resolveCharacterId(state, op[key], { create: true, name });
            if (id) op[key] = id;
        }
    }
    if (op.character && !op.name) op.name = characterName(state, op.character);
    if (op.characterId && !op.character) op.character = op.characterId;
    if (op.from && !op.fromName) op.fromName = characterName(state, op.from);
    if (op.to && !op.toName) op.toName = characterName(state, op.to);
    const resolveNameList = (value) => [...new Set((Array.isArray(value) ? value : [])
        .map((name) => String(name ?? '').trim())
        .filter(Boolean)
        .map((name) => resolveCharacterId(state, name, { create: true }) || matchByAddressTerm(state, name))
        .filter(Boolean))];
    if (op.item && typeof op.item === 'object' && op.item.holder !== undefined) {
        op.item.holder = resolveCharacterId(state, op.item.holder, { create: true });
    }
    if (op.event && typeof op.event === 'object') {
        for (const key of ['actors', 'witnesses']) {
            if (Array.isArray(op.event[key])) op.event[key] = resolveNameList(op.event[key]);
        }
        if (op.event.beliefs) op.event.beliefs = rewriteBeliefKeys(state, op.event.beliefs);
    }
    if (op.fact && typeof op.fact === 'object' && Array.isArray(op.fact.witnesses)) {
        op.fact.witnesses = resolveNameList(op.fact.witnesses);
    }
    // 提示词要求扁平写法：actors/witnesses/beliefs 直接挂在 op 上。
    for (const key of ['actors', 'witnesses']) {
        if (Array.isArray(op[key])) op[key] = resolveNameList(op[key]);
    }
    if (op.beliefs) op.beliefs = rewriteBeliefKeys(state, op.beliefs);
    if (op.scene && Array.isArray(op.scene.participants)) {
        op.scene = {
            ...op.scene,
            participants: resolveNameList(op.scene.participants),
        };
    }
    if (Array.isArray(op.participants)) {
        op.participants = resolveNameList(op.participants);
    }
    if (op.fact && typeof op.fact === 'object' && op.fact.beliefs) {
        op.fact.beliefs = rewriteBeliefKeys(state, op.fact.beliefs);
    }
    if (op.relation !== undefined) op.relation = resolveCharacterId(state, op.relation, { create: true });
    return op;
}

/** Replace every reference to one character id with another in the current state. */
function replaceCharacterRef(state, fromId, toId) {
    const replace = (value) => (value === fromId ? toId : value);
    const replaceBeliefs = (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const out = {};
        for (const [key, info] of Object.entries(value)) out[replace(key)] = info;
        return out;
    };
    if (state.scene && Array.isArray(state.scene.participants)) {
        state.scene.participants = [...new Set(state.scene.participants.map(replace))];
    }
    for (const character of Object.values(state.characters)) {
        for (const item of character.items || []) {
            if (item.holder !== undefined) item.holder = replace(item.holder);
            if (item.beliefs) item.beliefs = replaceBeliefs(item.beliefs);
        }
        for (const entry of Object.values(character.state || {})) {
            if (entry && typeof entry === 'object' && entry.beliefs) entry.beliefs = replaceBeliefs(entry.beliefs);
        }
        for (const relation of character.relations || []) {
            if (relation.target !== undefined) {
                relation.target = replace(relation.target);
                if (relation.target === toId) relation.targetName = characterName(state, toId);
            }
            if (relation.beliefs) relation.beliefs = replaceBeliefs(relation.beliefs);
        }
        for (const fact of character.facts || []) {
            if (fact.beliefs) fact.beliefs = replaceBeliefs(fact.beliefs);
        }
        for (const trait of [...(character.skills || []), ...(character.abilities || [])]) {
            if (trait.beliefs) trait.beliefs = replaceBeliefs(trait.beliefs);
        }
    }
    for (const fact of Object.values(state.facts || {})) {
        if (fact && typeof fact === 'object' && fact.beliefs) fact.beliefs = replaceBeliefs(fact.beliefs);
    }
    for (const event of state.events || []) {
        if (Array.isArray(event.actors)) event.actors = [...new Set(event.actors.map(replace))];
        if (Array.isArray(event.witnesses)) event.witnesses = [...new Set(event.witnesses.map(replace))];
        if (event.beliefs) event.beliefs = replaceBeliefs(event.beliefs);
    }
    if (Array.isArray(state.meta.leaks)) {
        for (const leak of state.meta.leaks) {
            if (!leak || typeof leak !== 'object' || leak.character !== fromId) continue;
            leak.character = toId;
            leak.characterName = characterName(state, toId);
        }
    }
    if (state.meta.protagonistId === fromId) state.meta.protagonistId = toId;
}

function renameCharacter(state, op) {
    const id = op.id || op.from;
    const character = state.characters[id];
    if (!character) throw new Error('rename_character: 找不到角色');
    if (id === PROTAGONIST_ID) throw new Error('rename_character: 玩家没有正式姓名，不能改名');
    const name = String(op.name || op.to || '').trim();
    if (!name) throw new Error('rename_character: 缺少新姓名');
    const existing = findCharacterIdByName(state, name);
    if (existing && existing !== id) {
        throw new Error('rename_character: 新姓名已属于另一个角色，请用 merge_character');
    }
    if (character.name && character.name !== name) {
        character.aliases = [...new Set([...(character.aliases || []), character.name])];
    }
    character.name = name;
    character.updatedAt = new Date().toISOString();
    // 其他角色关系里缓存的 targetName 也要跟着刷新，否则面板与提示词会一直显示旧名。
    for (const other of Object.values(state.characters)) {
        for (const relation of other.relations || []) {
            if (relation.target === id) relation.targetName = name;
        }
    }
    for (const leak of state.meta?.leaks || []) {
        if (leak && leak.character === id) leak.characterName = name;
    }
    return character;
}

function mergeCharacter(state, op) {
    const fromId = op.fromId || op.from;
    const toId = op.toId || op.to;
    if (!fromId || !toId || fromId === toId) return;
    const from = state.characters[fromId];
    const to = state.characters[toId];
    if (!from || !to) throw new Error('merge_character: 找不到角色');
    for (const [field, entry] of Object.entries(from.state || {})) {
        if (!to.state[field]) {
            to.state[field] = entry;
        } else if (entry && typeof entry === 'object' && Array.isArray(entry.history)) {
            to.state[field].history = [...(to.state[field].history || []), ...entry.history];
        }
    }
    for (const key of ['items', 'skills', 'abilities', 'relations', 'facts']) {
        to[key] = [...(to[key] || []), ...(from[key] || [])];
    }
    to.aliases = [...new Set([...(to.aliases || []), ...(from.aliases || []), from.name])];
    to.updatedAt = new Date().toISOString();
    replaceCharacterRef(state, fromId, toId);
    delete state.characters[fromId];
}

export function applyOps(inputState, ops, options = {}) {
    let state = normalizeState(inputState);
    if (migrateStableIds(state)) state = normalizeState(state);
    const aliases = Array.isArray(options.protagonistAliases) ? options.protagonistAliases : [];
    const normalizedOps = normalizeProtagonistOps(ops, aliases);
    const validation = validateOps(normalizedOps, state, options);
    const applied = [];
    const changedOps = [];
    const failures = [];
    // 普通事件每轮最多 2 条；major 不设上限，避免漏掉大事。
    let normalEvents = 0;
    const createdEvents = [];
    // 一次结算里每个角色最多改一档，防止同一轮来回漂移。
    const tierChanged = new Set();

    // 0.5–0.7 只进入待复核，不落账；否则「待复核」等于已经生效。
    const all = [...validation.accepted];
    for (const op of all) resolveOpRefs(state, op);
    for (const op of all) {
        try {
            switch (op.op) {
                case 'rename_character':
                    renameCharacter(state, op);
                    break;
                case 'merge_character':
                    mergeCharacter(state, op);
                    break;
                case 'set':
                    setField(state, op);
                    break;
                case 'add_item':
                    addItem(state, op);
                    break;
                case 'adjust_item':
                    adjustItem(state, op);
                    break;
                case 'remove_item':
                    removeItem(state, op);
                    break;
                case 'clear_items':
                    clearItems(state, op);
                    break;
                case 'clear_currency':
                    clearCurrency(state, op);
                    break;
                case 'set_item_quantity':
                    setItemQuantity(state, op);
                    break;
                case 'add_skill':
                    addSkill(state, op);
                    break;
                case 'set_skill':
                    setSkill(state, op);
                    break;
                case 'remove_skill':
                    removeSkill(state, op);
                    break;
                case 'add_ability':
                    addAbility(state, op);
                    break;
                case 'set_ability':
                    setAbility(state, op);
                    break;
                case 'remove_ability':
                    removeAbility(state, op);
                    break;
                case 'move_item':
                    moveItem(state, op);
                    break;
                case 'set_relation':
                    setRelation(state, op);
                    break;
                case 'set_tier':
                    if (op.character && tierChanged.has(op.character)) {
                        throw new Error('set_tier: 本次结算每个角色只能改一档');
                    }
                    if (setCharacterTier(state, op) && op.character) tierChanged.add(op.character);
                    break;
                case 'append_event':
                case 'add_event': {
                    const { event: createdEvent, created } = appendEvent(state, op);
                    if (created) {
                        createdEvents.push(createdEvent);
                        // 只有普通事件占配额；major 不设上限，避免漏掉大事。
                        if (createdEvent.importance !== 'major') {
                            normalEvents += 1;
                            if (normalEvents > 2) {
                                state.events.pop();
                                createdEvents.pop();
                                throw new Error('append_event: 本轮普通事件超过 2 条，请合并成一条；major 只用于大事');
                            }
                        }
                    }
                    break;
                }
                case 'add_fact':
                    addFact(state, op);
                    break;
                case 'reveal':
                    if (reveal(state, op)) changedOps.push(op);
                    break;
                case 'set_scene': {
                    let scene = op.scene && typeof op.scene === 'object' ? op.scene : op;
                    if (!op.scene && op.field && op.value !== undefined) {
                        scene = { [op.field]: op.value };
                    }
                    const rawParticipants = Array.isArray(scene.participants)
                        ? scene.participants
                        : state.scene.participants;
                    // 执事、掌柜这类是职务不是人名，别让它顺着 participants 混进角色档。
                    const participants = rawParticipants
                        .map((name) => String(name ?? '').trim())
                        .filter((name) => name && !isAddressTerm(name));
                    state.scene = {
                        time: scene.time || scene.chapter || state.scene.time || '',
                        // 没给 day 时沿用旧值；时间只前进，不让一次漏写把日期抹掉。
                        day: normalizeDay(scene.day) ?? state.scene.day ?? null,
                        place: scene.place || state.scene.place || '',
                        participants,
                    };
                    // Everyone on stage gets a record, even if the narration only
                    // gave a name; unknown fields stay empty and render as 未知.
                    for (const participant of participants) {
                        const name = String(participant || '').trim();
                        if (name) {
                            const person = ensureCharacter(state, name);
                            // 记录最近同场日：长期无往来的降档要用它算间隔。
                            if (person && state.scene.day !== null) person.lastSeenDay = state.scene.day;
                        }
                    }
                    break;
                }
                default:
                    throw new Error(`未知 op 类型：${op.op}`);
            }
            applied.push(op);
        } catch (err) {
            failures.push({ op, reason: err.message });
        }
    }

    mergeFragmentedEvents(state, createdEvents);

    return {
        state,
        applied,
        changedOps,
        review: validation.review,
        rejected: [...validation.rejected, ...failures],
    };
}

/** 同一次结算里被拆碎的同一场戏：地点、在场人相同，就按一个场景单元合并。 */
function mergeFragmentedEvents(state, createdEvents) {
    if (createdEvents.length < 2) return;
    const kept = [];
    for (const event of createdEvents) {
        if (!state.events.includes(event)) continue;
        const target = kept.find((candidate) => {
            if (!candidate.place || candidate.place !== event.place) return false;
            const left = [...new Set(candidate.actors || [])].sort().join('、');
            const right = [...new Set(event.actors || [])].sort().join('、');
            if (!left || left !== right) return false;
            // 同一场景单元还要同一天（没有 day 时退回 time）；否则跨天的两场戏会被并成一条。
            const leftDay = normalizeDay(candidate.day);
            const rightDay = normalizeDay(event.day);
            if (leftDay != null && rightDay != null) return leftDay === rightDay;
            return (candidate.time || '') === (event.time || '');
        });
        if (!target) {
            kept.push(event);
            continue;
        }
        // 合并时保留最早的问题、最关键的一步、最后的结果。
        target.result = event.result || target.result;
        if (!target.decision) target.decision = event.decision;
        target.keywords = readKeywords([...(target.keywords || []), ...(event.keywords || [])]);
        target.stateChanges = [...new Set([...(target.stateChanges || []), ...(event.stateChanges || [])])];
        target.sourceMessages = [...new Set([...(target.sourceMessages || []), ...(event.sourceMessages || [])])];
        target.witnesses = [...new Set([...(target.witnesses || []), ...(event.witnesses || [])])];
        if (event.importance === 'major') target.importance = 'major';
        // 合并后重算档位：后到的更保密档位可以收紧，但目击者一旦看到就不能被排除。
        let nextRank = Math.max(
            ACCESS_RANK[entityAccess(event, 'public')],
            ACCESS_RANK[entityAccess(target, 'public')],
        );
        const scope = accessFromWitnesses(state, target.witnesses);
        if (scope) nextRank = Math.min(nextRank, ACCESS_RANK[scope]);
        target.access = ACCESS_LEVELS[nextRank];
        state.events = state.events.filter((item) => item !== event);
    }
}

function currentField(character, field) {
    const entry = character?.state?.[field];
    if (!entry) return '';
    return entry.current ?? entry ?? '';
}

function currentItems(character) {
    return (character.items || []).filter((item) => item.validTo == null);
}

function currentRelations(character) {
    return (character.relations || []).filter((relation) => relation.validTo == null);
}

function currentSkills(character) {
    return (character.skills || []).filter((skill) => skill.validTo == null);
}

function currentAbilities(character) {
    return (character.abilities || []).filter((ability) => ability.validTo == null);
}

function formatItem(item) {
    const quantity = Number(item.quantity ?? 1);
    const unit = item.unit || '';
    if (item.kind === 'currency' || quantity !== 1) {
        return `${item.name}×${quantity}${unit}`;
    }
    return item.name;
}

/** 旧版预设字段：玩家主导写作下不再提取，也不再注入，避免把叙事者的解读固化成玩家目标。 */
const RETIRED_FIELDS = new Set(['objective']);

function orderedStateFields(character, fieldOrder = []) {
    const keys = Object.keys(character?.state || {}).filter((field) => !RETIRED_FIELDS.has(field));
    const ordered = [];
    for (const field of fieldOrder) {
        if (keys.includes(field) && !ordered.includes(field)) ordered.push(field);
    }
    for (const field of keys) {
        if (!ordered.includes(field)) ordered.push(field);
    }
    return ordered;
}

function characterLine(character, fieldOrder = []) {
    const values = orderedStateFields(character, fieldOrder)
        // 离场角色名录只列公开字段，避免把「秘密身份」当花名册念出来；进度也不进名录。
        .filter((field) => field !== 'progress' && isPublicEntity(character.state?.[field]))
        .map((field) => currentField(character, field))
        .filter(Boolean)
        .slice(0, 3);
    return [character.name || character.id, ...values].filter(Boolean).join('｜');
}

/** 单个角色块的上限：不设限的话，主角囤几十件物品就能把整块预算吃掉。 */
const BLOCK_CAPS = { items: 15, skills: 8, abilities: 8, relations: 10, facts: 6 };

/** 内部层级枚举不直接给叙事模型看，免得被当成设定词写进正文。 */
const TIER_LABELS = { main: '主角', major: '重要', support: '配角', minor: '次要', npc: '路人' };

function characterBlock(character, fieldOrder = [], options = {}) {
    const isProtagonist = options.isProtagonist === true;
    const recentText = String(options.recentText ?? '');
    // 条目超过上限时，先让本轮正文提到的条目上位；否则被截掉的东西永远回不来。
    const mentioned = (value) => Boolean(recentText) && Boolean(value) && recentText.includes(String(value));
    const recallFirst = (list, labelOf) => {
        if (!recentText || list.length < 2) return list;
        const hit = [];
        const rest = [];
        for (const entry of list) (mentioned(labelOf(entry)) ? hit : rest).push(entry);
        return [...hit, ...rest];
    };
    // NPC self-description is always player-visible; only the protagonist can own a secret.
    // 关闭知情约束时不再隐藏内容，只去掉“谁知情”的标注。
    const visible = (entity) => (isProtagonist && options.knowledgeGate !== false ? isPublicEntity(entity) : true);
    const fields = orderedStateFields(character, fieldOrder)
        // progress 不受 knownBy 影响：无论提取时写了什么，它都只以「只有主角知道」的形式出现。
        .filter((field) => (field === 'progress' ? isProtagonist : visible(character.state[field])))
        .map((field) => {
            // 境界进度只属于主角，且是内景：NPC 看不出具体进境，只能凭气息判断境界。
            if (field === 'progress' && !isProtagonist) return '';
            const value = currentField(character, field);
            // 0 是合法值（境界进度刚重置），不能当空值丢掉。
            if (value === '' || value === null || value === undefined) return '';
            const entry = character.state[field];
            const gate = options.knowledgeGate === false
                ? ''
                : (field === 'progress'
                    ? ` [K:${PROTAGONIST_NAME}]`
                    : (!isProtagonist && !isPublicEntity(entry) ? ` ${knownByTag(entry, options.state)}` : ''));
            // progress 是 0-100 的刻度，标出满分，免得叙事者把它当等级。
            return `${field}：${value}${field === 'progress' ? '/100' : ''}${gate}`;
        })
        .filter(Boolean);
    const allItems = isProtagonist
        ? currentItems(character)
            .filter(visible)
            .filter((item) => item.kind === 'currency' || Number(item.quantity ?? 1) > 0)
        : [];
    // 货币永远排在最前，避免被杂物挤出列表。
    const shownItems = [
        ...allItems.filter((item) => item.kind === 'currency'),
        ...recallFirst(allItems.filter((item) => item.kind !== 'currency'), (item) => item.name),
    ].slice(0, BLOCK_CAPS.items);
    const hiddenItems = allItems.length - shownItems.length;
    const allRelations = isProtagonist ? currentRelations(character).filter(visible) : [];
    const shownRelations = recallFirst(allRelations, (relation) => relation.targetName || relation.target)
        .slice(0, BLOCK_CAPS.relations);
    const hiddenRelations = allRelations.length - shownRelations.length;
    const relations = shownRelations.map((relation) => {
        const meta = [relation.type, relation.attitude].filter(Boolean).join('/');
        const address = relation.address ? `称「${relation.address}」` : '';
        const detail = [meta, address].filter(Boolean).join('，');
        return `${relation.targetName || relation.target}(${detail})`;
    });
    // NPC 对玩家的称呼与态度存在 NPC→玩家这条边上，必须单独渲染，否则「称你师兄」永远进不了提示词。
    const towardProtagonist = isProtagonist ? [] : currentRelations(character)
        .filter((relation) => options.protagonistId && relation.target === options.protagonistId)
        .map((relation) => {
            const meta = [relation.type, relation.attitude].filter(Boolean).join('/');
            const address = relation.address ? `称「${relation.address}」` : '';
            const gate = options.knowledgeGate === false || isPublicEntity(relation)
                ? ''
                : ` ${knownByTag(relation, options.state)}`;
            return `${[meta, address].filter(Boolean).join('，')}${gate}`;
        })
        .filter(Boolean);
    const allSkills = isProtagonist ? currentSkills(character).filter(visible) : [];
    const shownSkills = recallFirst(allSkills, (skill) => skill.name).slice(0, BLOCK_CAPS.skills);
    const hiddenSkills = allSkills.length - shownSkills.length;
    const skills = shownSkills.map((skill) => `${skill.name}${skill.level ? `(${skill.level})` : ''}`);
    const allAbilities = isProtagonist ? currentAbilities(character).filter(visible) : [];
    const shownAbilities = recallFirst(allAbilities, (ability) => ability.name).slice(0, BLOCK_CAPS.abilities);
    const hiddenAbilities = allAbilities.length - shownAbilities.length;
    const abilities = shownAbilities.map((ability) => `${ability.name}${ability.level ? `(${ability.level})` : ''}`);
    const allFacts = recallFirst(
        (character.facts || []).filter(visible),
        (fact) => fact.text || fact,
    )
        .map((fact) => {
            const text = fact.text || fact;
            if (!text) return '';
            // NPC 的秘密事实仍然给叙事者看，但必须带知情范围，否则会被当成公开信息。
            const gate = options.knowledgeGate === false
                ? ''
                : (!isProtagonist && !isPublicEntity(fact) ? ` ${knownByTag(fact, options.state)}` : '');
            return `${text}${gate}`;
        })
        .filter(Boolean);
    const facts = allFacts.slice(0, BLOCK_CAPS.facts);
    const hiddenFacts = allFacts.length - facts.length;
    const suffix = (hidden) => (hidden > 0 ? `（另有 ${hidden} 项）` : '');
    const lines = [`【角色·${character.name || character.id}】${TIER_LABELS[character.tier] || ''}`];
    if (fields.length) lines.push(fields.join(' | '));
    if (shownItems.length) lines.push(`物品：${shownItems.map(formatItem).join('、')}${suffix(hiddenItems)}`);
    if (skills.length) lines.push(`${options.skillLabel || '技能'}：${skills.join('、')}${suffix(hiddenSkills)}`);
    if (abilities.length) lines.push(`神通：${abilities.join('、')}${suffix(hiddenAbilities)}`);
    if (relations.length) lines.push(`关系：${relations.join('、')}${suffix(hiddenRelations)}`);
    if (towardProtagonist.length) lines.push(`对玩家：${towardProtagonist.join('、')}`);
    if (facts.length) lines.push(`个人事实：${facts.join('；')}${suffix(hiddenFacts)}`);
    return lines.join('\n');
}

/** 未了结条目也会带 beliefs/suspicion；不渲染就等于丢掉「他以为」。 */
function beliefNote(entity, state) {
    const beliefs = entity?.beliefs;
    if (!beliefs || typeof beliefs !== 'object') return '';
    const parts = [];
    for (const [id, info] of Object.entries(beliefs)) {
        const name = state?.characters?.[id]?.name || id;
        if (info?.state === 'suspects') {
            parts.push(info.suspicion ? `${name}怀疑「${info.suspicion}」` : `${name}有怀疑`);
        } else if (info?.state === 'false_belief') {
            parts.push(`${name}误以为「${info.belief || '未知'}」`);
        }
    }
    return parts.join('；');
}

function collectGatedEntities(state, protagonistId = '') {
    const entries = [];
    for (const character of Object.values(state.characters)) {
        // Only the protagonist's own records can be secrets; NPC self-description is public.
        if (character.id !== protagonistId) continue;
        for (const [field, entry] of Object.entries(character.state || {})) {
            if (isPublicEntity(entry)) continue;
            entries.push({
                key: `field:${character.id}:${field}`,
                type: 'field',
                event: false,
                ownerId: character.id,
                field,
                text: `${character.name || character.id}.${field}：${currentField(character, field)}`,
                entity: entry,
            });
        }
        for (const item of (character.items || []).filter((item) => item.validTo == null && !isPublicEntity(item))) {
            entries.push({
                key: `item:${item.id}`,
                type: 'item',
                event: false,
                ownerId: character.id,
                text: `${character.name || character.id} 持有 ${formatItem(item)}`,
                entity: item,
            });
        }
        for (const relation of (character.relations || []).filter((relation) => relation.validTo == null && !isPublicEntity(relation))) {
            entries.push({
                key: `relation:${character.id}:${relation.target}`,
                type: 'relation',
                event: false,
                ownerId: character.id,
                text: `${character.name || character.id} → ${relation.targetName || relation.target}：${[relation.type, relation.attitude].filter(Boolean).join('/')}${relation.address ? `，称「${relation.address}」` : ''}`,
                entity: relation,
            });
        }
        for (const skill of (character.skills || []).filter((skill) => skill.validTo == null && !isPublicEntity(skill))) {
            entries.push({
                key: `skill:${character.id}:${skill.id}`,
                type: 'skill',
                event: false,
                ownerId: character.id,
                text: `${character.name || character.id} 功法「${skill.name}」${skill.level ? `（${skill.level}）` : ''}`,
                entity: skill,
            });
        }
        for (const ability of (character.abilities || []).filter((ability) => ability.validTo == null && !isPublicEntity(ability))) {
            entries.push({
                key: `ability:${character.id}:${ability.id}`,
                type: 'ability',
                event: false,
                ownerId: character.id,
                text: `${character.name || character.id} 神通「${ability.name}」${ability.level ? `（${ability.level}）` : ''}`,
                entity: ability,
            });
        }
        for (const fact of (character.facts || []).filter((fact) => !isPublicEntity(fact))) {
            entries.push({
                key: `fact:${character.id}:${fact.text || fact}`,
                type: 'fact',
                event: false,
                ownerId: character.id,
                text: `${character.name || character.id}：${fact.text || fact}`,
                entity: fact,
            });
        }
    }
    return entries;
}

function joinNames(names) {
    if (names.length <= 6) return names.join('、');
    return `${names.slice(0, 6).join('、')}等${names.length}人`;
}

/** 秘密在创建/更新后保持「热」的消息数。超过后若无人在场、无关键词命中，就冷却。 */
const SECRET_HOT_WINDOW = 30;

function factKeywordHit(fact, recentText) {
    const keywords = Array.isArray(fact.keywords) ? fact.keywords : [];
    return keywords.some((word) => word.length >= 2 && recentText.includes(word));
}

/**
 * 热：涉及在场 NPC / 关键词命中 / 落在热窗口内 / 挂在未了结的线上。
 * 冷：都不满足，不注入，只计数；相关角色回来或关键词被提到就自动回热。
 */
function isFactHot(fact, context, state) {
    const { activeIds, protagonistId, recentText, lastProcessedMessage, hotWindow } = context;
    // 主角永远够格；冷却要看的是「现场有没有 NPC 够格」。
    const npcActive = activeIds.filter((id) => id !== protagonistId);
    if (npcActive.some((id) => knowsEntity(fact, id, state, 'protagonist'))) return true;
    if (fact.thread_status === 'open') return true;
    if (recentText && factKeywordHit(fact, recentText)) return true;
    const touched = Number(fact.lastTouched);
    if (Number.isFinite(touched) && Number.isFinite(lastProcessedMessage) && lastProcessedMessage >= 0) {
        return lastProcessedMessage - touched <= hotWindow;
    }
    // 没有时间戳的旧秘密：保守保留，等它被重新触碰后开始计时。
    return true;
}

/** 关闭知情约束时仍保留内容：列秘密事实与怀疑/误信，不带「谁知情」。 */
function plainSecretBlock(state) {
    const lines = [];
    for (const fact of Object.values(state.facts || {})) {
        // 未了结的线由【未了结】渲染，避免重复。
        if (fact.thread_status === 'open') continue;
        const text = String(fact.text || '').trim();
        if (!text) continue;
        const parts = [];
        for (const [id, info] of Object.entries(fact.beliefs || {})) {
            const name = state.characters?.[id]?.name || id;
            if (info?.state === 'suspects') parts.push(`${name}怀疑「${info.suspicion || '有隐情'}」`);
            else if (info?.state === 'false_belief') parts.push(`${name}误以为「${info.belief || '未知'}」`);
        }
        if (isPublicEntity(fact, 'protagonist') && !parts.length) continue;
        lines.push(`- ${text}${parts.length ? ` ｜ ${parts.join('；')}` : ''}`);
    }
    return lines.length ? `【秘密】\n${lines.join('\n')}` : '';
}

/**
 * One line per secret: who knows, who does not, and who believes what.
 * Scales with the number of secrets instead of characters × secrets.
 */
function secretBlock(state, activeIds, protagonistId = '', options = {}) {
    const cooling = options.cooling !== false;
    const context = {
        activeIds,
        protagonistId,
        recentText: String(options.recentText ?? ''),
        lastProcessedMessage: Number(options.lastProcessedMessage ?? -1),
        hotWindow: Number(options.hotWindow ?? SECRET_HOT_WINDOW),
    };
    const candidates = Object.values(state.facts).filter((fact) => {
        // 未了结的线由【未了结】渲染（已带 [K:]），这里不再重复。
        if (fact.thread_status === 'open') return false;
        if (entityAccess(fact, 'protagonist') !== 'public') return true;
        // 公开事实本身人人皆知；只有当某个角色信错了版本时，才值得跨回合记住。
        return Object.values(fact.beliefs || {})
            .some((info) => info?.state === 'suspects' || info?.state === 'false_belief');
    });
    const facts = candidates.filter((fact) => !cooling || isFactHot(fact, context, state));
    const hiddenCount = candidates.length - facts.length;
    const secretFactTexts = facts.map((fact) => String(fact.text || ''));
    const entries = facts.map((fact) => ({ text: fact.text, entity: fact }));

    for (const item of collectGatedEntities(state, protagonistId)) {
        if (item.type === 'item') {
            const name = item.entity?.name || '';
            if (name && secretFactTexts.some((text) => text.includes(name))) continue;
        }
        entries.push({ text: item.text, entity: item.entity });
    }

    const lines = [];
    for (const entry of entries) {
        const known = [];
        const unaware = [];
        const suspects = [];
        const beliefs = [];
        const access = entityAccess(entry.entity, 'protagonist');
        for (const id of activeIds) {
            if (id === protagonistId) continue;
            const name = state.characters[id]?.name || id;
            const info = entry.entity?.beliefs?.[id];
            if (info?.state === 'suspects') {
                suspects.push(info.suspicion ? `${name}怀疑「${info.suspicion}」` : name);
                continue;
            }
            if (info?.state === 'false_belief') {
                beliefs.push(`${name}误以为「${info.belief || '未知'}」`);
                continue;
            }
            if (knowsEntity(entry.entity, id, state, 'protagonist')) known.push(name);
            else unaware.push(name);
        }
        if (access === 'public') {
            // 公开事实没有「不知情」可言，只留下猜疑与错误认知。
            const publicParts = [];
            if (suspects.length) publicParts.push(`怀疑=${joinNames(suspects)}`);
            publicParts.push(...beliefs);
            if (!publicParts.length) continue;
            lines.push(`- ${entry.text} ｜ ${publicParts.join('；')}`);
            continue;
        }
        const parts = access === 'protagonist'
            ? ['主角级', '只有你知道']
            : [`${ACCESS_LABELS[access] || access}`, `默认知情=${known.length ? joinNames(known) : '无'}`];
        if (access !== 'protagonist' && unaware.length) parts.push(`默认不知情=${joinNames(unaware)}`);
        if (suspects.length) parts.push(`怀疑=${joinNames(suspects)}`);
        parts.push(...beliefs);
        lines.push(`- ${entry.text} ｜ ${parts.join('；')}`);
    }

    if (hiddenCount) {
        lines.push(`- （另有 ${hiddenCount} 条秘密已冷却或与场景无关）`);
    }

    return lines.length ? `【秘密知情】\n${lines.join('\n')}` : '';
}

/**
 * 未了结的人情、承诺、仇怨、悬案：只列一句标题，不展开历史。
 * 长篇里这些线如果不进上下文，玩家会感觉之前做的事没有回响。
 */
function threadBlock(state, options = {}) {
    const all = Object.values(state.facts || {}).filter((fact) => fact.thread_status === 'open');
    if (!all.length) return '';
    const recentText = String(options.recentText ?? '');
    // 超过 6 条时先保留正文刚提到的线，否则旧线永远轮不到。
    const open = recentText
        ? [
            ...all.filter((fact) => fact.text && recentText.includes(String(fact.text))),
            ...all.filter((fact) => !(fact.text && recentText.includes(String(fact.text)))),
        ]
        : all;
    const shown = open.slice(0, 6);
    const lines = shown.map((fact) => {
        const meta = [fact.thread_type, fact.thread_stake ? `代价：${fact.thread_stake}` : '']
            .filter(Boolean)
            .join('｜');
        // 未了结里也可能有秘密，必须带知情范围，否则会被当成桌上所有人都知道的事。
        const gate = options.knowledgeGate === false || isPublicEntity(fact)
            ? ''
            : ` ${knownByTag(fact, state)}`;
        // 未了结条目上的怀疑/误信任何模式下都要保留，否则「他以为」会被写成事实。
        const note = beliefNote(fact, state);
        return `- ${fact.text}${meta ? `｜${meta}` : ''}${gate}${note ? ` ｜ ${note}` : ''}`;
    });
    if (open.length > shown.length) lines.push(`- （另有 ${open.length - shown.length} 条未了结）`);
    return `【未了结】\n${lines.join('\n')}`;
}

export function assembleInjection(inputState, options = {}) {
    const state = normalizeState(inputState);
    migrateStableIds(state);
    const tokenBudget = Number(options.tokenBudget ?? 3000);
    const knowledgeGate = options.knowledgeGate !== false;
    const recentText = String(options.recentText ?? '');
    const fieldOrder = Array.isArray(options.fieldOrder) ? options.fieldOrder : [];
    const scene = state.scene || {};

    const requestedActive = Array.isArray(options.activeCharacterIds) ? options.activeCharacterIds : [];
    const activeSet = new Set(requestedActive
        .map((id) => resolveCharacterId(state, id, { create: false }) || id)
        .filter(Boolean));
    for (const participant of scene.participants || []) {
        activeSet.add(resolveCharacterId(state, participant, { create: false }) || participant);
    }
    for (const character of Object.values(state.characters)) {
        if (character.tier === 'main') activeSet.add(character.id);
        if (character.name && recentText.includes(character.name)) activeSet.add(character.id);
        for (const alias of character.aliases || []) {
            if (alias && recentText.includes(alias)) activeSet.add(character.id);
        }
    }
    const activeIds = [...activeSet].filter((id) => state.characters[id]);
    // 主角块必须排在第一个：预算极紧时只保留 activeBlocks[0]。
    activeIds.sort((a, b) => (a === PROTAGONIST_ID ? -1 : b === PROTAGONIST_ID ? 1 : 0));

    const header = [
        '【事实台账】玩家已知事实，角色块按真相写。',
        '【知情】先看正文：正文写明谁不知道，就按不知道；写明谁知道，就按知道。不要用台账反驳正文。',
        '正文没写才看台账：旧事离开上下文也按这里；角色档位 ≥ 条目档位的默认知情，不够格的默认不知情。',
        knowledgeGate
            ? '在场、看到、正文没提他不知道，都不等于他知道；[K:...] 是默认知情名单。'
            : '在场、看到、正文没提他不知道，都不等于他知道。',
    ].join('\n');

    const sceneLine = [
        scene.time ? `时间：${scene.time}` : '',
        scene.place ? `地点：${scene.place}` : '',
        activeIds.length ? `在场：${activeIds.map((id) => state.characters[id]?.name || id).join('、')}` : '',
    ].filter(Boolean).join('｜');

    const protagonistId = resolveCharacterId(state, options.protagonistId, { create: false })
        || Object.values(state.characters).find((character) => character.tier === 'main')?.id
        || '';
    const activeBlocks = activeIds.map((id) => characterBlock(state.characters[id], fieldOrder, {
        isProtagonist: id === protagonistId,
        protagonistId,
        skillLabel: options.skillLabel,
        knowledgeGate,
        recentText,
        state,
    }));
    const inactive = Object.values(state.characters)
        .filter((character) => !activeIds.includes(character.id))
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    const shownInactive = inactive.slice(0, 8);
    // 离场角色名录：会让叙事者记得这些人存在，但也可能诱发提到不在场的人。
    const others = options.showOthers !== false && shownInactive.length
        ? `【其他角色】\n${shownInactive.map((character) => `- ${characterLine(character, fieldOrder)}`).join('\n')}`
            + (inactive.length > shownInactive.length ? `\n- （其余 ${inactive.length - shownInactive.length} 人未列出）` : '')
        : '';

    const secrets = knowledgeGate
        ? secretBlock(state, activeIds, protagonistId, {
            recentText,
            lastProcessedMessage: Number(state.meta?.lastProcessedMessage ?? -1),
            cooling: options.secretCooling !== false,
            hotWindow: Number(options.secretHotWindow ?? SECRET_HOT_WINDOW),
        })
        : plainSecretBlock(state);

    const build = (parts) => parts.filter(Boolean).join('\n\n');

    let sections = {
        header,
        scene: sceneLine ? `【场景】${sceneLine}` : '',
        characters: activeBlocks.join('\n\n'),
        others,
        threads: threadBlock(state, { knowledgeGate, recentText }),
        secrets,
    };

    let text = build(Object.values(sections));
    if (estimateTokens(text) <= tokenBudget) return text;

    // Trim in an order that protects the secret-knowledge block as long as possible.
    sections.others = '';
    text = build(Object.values(sections));
    if (estimateTokens(text) <= tokenBudget) return text;

    sections.characters = activeBlocks.slice(0, 1).join('\n\n');
    text = build(Object.values(sections));
    if (estimateTokens(text) <= tokenBudget) return text;

    // Last resort: 按整段丢弃，永远不切字符；秘密是最后才砍的。
    text = build([header, sections.scene, sections.threads, secrets]);
    if (estimateTokens(text) <= tokenBudget) return text;
    text = build([header, sections.scene, secrets]);
    if (estimateTokens(text) <= tokenBudget) return text;
    text = build([header, secrets]);
    if (estimateTokens(text) <= tokenBudget) return text;
    return secrets;
}

/** 中文按 2–4 字滑窗切词，英文数字按词；命中任意一个就算被提到。 */
function textTokens(source) {
    const tokens = new Set();
    const text = String(source || '');
    for (const word of text.match(/[A-Za-z0-9]{2,}/g) || []) {
        tokens.add(word.toLowerCase());
    }
    const cjkRuns = text.match(/[\u3400-\u9FFF\uF900-\uFAFF]+/g) || [];
    for (const run of cjkRuns) {
        for (let size = 2; size <= 4; size += 1) {
            for (let index = 0; index + size <= run.length; index += 1) {
                tokens.add(run.slice(index, index + size));
            }
        }
    }
    return tokens;
}

function mentionsText(source, haystack) {
    const text = String(haystack ?? '');
    if (!text) return false;
    const lower = text.toLowerCase();
    return [...textTokens(source)].some((token) => lower.includes(token));
}

export function extractMentionedFacts(inputState, text) {
    const state = normalizeState(inputState);
    const result = [];
    const haystack = String(text ?? '');
    for (const fact of Object.values(state.facts)) {
        if (isPublicEntity(fact, 'protagonist')) continue;
        if (mentionsText(fact.text, haystack)) {
            result.push(fact);
        }
    }
    return result;
}

/**
 * 可能被说破的受控条目：顶层秘密 + 主角的字段/物品/关系/功法/神通。
 * 角色个人事实没有对应的 reveal 目标，暂不参与泄露检测。
 */
function leakCandidates(state) {
    const protagonistId = state.meta?.protagonistId || PROTAGONIST_ID;
    const list = [];
    for (const fact of Object.values(state.facts || {})) {
        if (isPublicEntity(fact, 'protagonist')) continue;
        list.push({
            entity: fact,
            source: fact.text,
            label: fact.text,
            target: { fact: fact.id },
        });
    }
    for (const entry of collectGatedEntities(state, protagonistId)) {
        const entity = entry.entity;
        if (entry.type === 'field') {
            const owner = state.characters?.[entry.ownerId];
            const value = currentField(owner, entry.field);
            if (!value) continue;
            list.push({
                entity,
                source: String(value),
                label: `${owner?.name || entry.ownerId}.${entry.field}：${value}`,
                target: { character: entry.ownerId, field: entry.field },
            });
        } else if (entry.type === 'item' && entity?.name) {
            list.push({ entity, source: entity.name, label: entity.name, target: { item: entity.name } });
        } else if (entry.type === 'relation') {
            const name = entity?.targetName || entity?.target;
            if (!name) continue;
            list.push({ entity, source: name, label: `关系 ${name}`, target: { relation: name } });
        } else if (entry.type === 'skill' && (entity?.name || entity?.id)) {
            const name = entity.name || entity.id;
            list.push({ entity, source: name, label: `功法 ${name}`, target: { skill: name } });
        } else if (entry.type === 'ability' && (entity?.name || entity?.id)) {
            const name = entity.name || entity.id;
            list.push({ entity, source: name, label: `神通 ${name}`, target: { ability: name } });
        } else if (entry.type === 'fact' && entity && typeof entity === 'object') {
            const text = String(entity.text || '').trim();
            if (!text) continue;
            const owner = state.characters?.[entry.ownerId];
            list.push({
                entity,
                source: text,
                label: `${owner?.name || entry.ownerId}：${text}`,
                target: { character: entry.ownerId, fact: text },
            });
        }
    }
    return list;
}

export function detectLeaks(inputState, text, activeCharacterIds = []) {
    const state = normalizeState(inputState);
    migrateStableIds(state);
    const protagonistId = state.meta?.protagonistId || PROTAGONIST_ID;
    const mentioned = leakCandidates(state);
    const haystack = String(text ?? '');
    const active = activeCharacterIds.length
        ? activeCharacterIds
            .map((id) => resolveCharacterId(state, id, { create: false }) || id)
            .filter(Boolean)
        : Object.values(state.characters)
            .filter((character) => character.id !== protagonistId)
            .map((character) => character.id);
    const leaks = [];
    const quote = haystack.slice(0, 160);
    for (const candidate of mentioned) {
        if (!mentionsText(candidate.source, haystack)) continue;
        for (const id of active) {
            if (!knowsEntity(candidate.entity, id, state, 'protagonist')) {
                leaks.push({
                    character: id,
                    characterName: state.characters[id]?.name || id,
                    ...(candidate.target.fact ? { fact: candidate.target.fact } : {}),
                    target: candidate.target,
                    factText: candidate.label,
                    quote,
                });
            }
        }
    }
    return leaks;
}

/**
 * Stable hash of one chat message, used to detect edits, deletes, rollbacks and branches.
 */
export function messageHash(message) {
    const text = `${message?.is_user ? 'u' : 'a'}|${String(message?.mes ?? '')}`;
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
        hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    }
    return hash.toString(16);
}

export function detectAnchorMutation(chat, lastProcessedMessage, lastProcessedHash) {
    const list = Array.isArray(chat) ? chat : [];
    const last = Number(lastProcessedMessage ?? -1);
    if (last < 0) return false;
    if (last >= list.length) return true;
    if (!lastProcessedHash) return false;
    return messageHash(list[last]) !== lastProcessedHash;
}

export function reanchorWindow(chatLength, window = 20) {
    const length = Math.max(0, Number(chatLength ?? 0));
    const size = Math.max(1, Number(window));
    return Math.max(-1, length - size - 1);
}

/**
 * Rolling hash of every chat prefix. A changed/edit/deleted message invalidates
 * all hashes from that index onward, which lets the ledger find a safe replay point.
 */
export function computePrefixHashes(chat) {
    const list = Array.isArray(chat) ? chat : [];
    const hashes = [];
    let hash = 0;
    for (let i = 0; i < list.length; i += 1) {
        const text = `${list[i]?.is_user ? 'u' : 'a'}|${String(list[i]?.mes ?? '')}`;
        for (let j = 0; j < text.length; j += 1) {
            hash = (hash * 31 + text.charCodeAt(j)) >>> 0;
        }
        hash = (hash * 31 + 31) >>> 0;
        hashes.push(hash.toString(16));
    }
    return hashes;
}

/**
 * Find the newest history record whose chat prefix still matches the current chat.
 */
export function findReplayPoint(history, chat) {
    const records = Array.isArray(history) ? history : [];
    const hashes = computePrefixHashes(chat);
    for (let i = records.length - 1; i >= 0; i -= 1) {
        const record = records[i];
        const to = Number(record?.to);
        if (!Number.isFinite(to) || to < 0 || to >= hashes.length) continue;
        if (record.prefixHash && record.prefixHash === hashes[to]) {
            return { index: to, record };
        }
    }
    return { index: -1, record: null };
}

/**
 * Rebuild the ledger from the op log up to a chat index.
 */
export function replayHistory(history, targetIndex = Number.POSITIVE_INFINITY) {
    let state = createEmptyState();
    const records = Array.isArray(history) ? history : [];
    for (const record of records) {
        if (Number(record?.to) > targetIndex) break;
        // applyOps 会就地把姓名解析成 id；回放必须用副本，否则版本日志被改写一次，
        // 之后场景参与者就只剩 id，角色档案再也重建不出来。
        const rawOps = Array.isArray(record.ops) ? JSON.parse(JSON.stringify(record.ops)) : [];
        // 新记录带角色快照：先按原始 id/名字建好角色，避免回放时按名字重新分配 id 造成串档。
        // 不预置结算后的 tier/access，让记录里的 op 按顺序自然重放。
        for (const snapshot of Array.isArray(record.characters) ? record.characters : []) {
            if (!snapshot?.id || state.characters[snapshot.id]) continue;
            const character = createCharacterRecord(state, snapshot.id, snapshot.name || snapshot.id);
            if (Array.isArray(snapshot.aliases) && snapshot.aliases.length) {
                character.aliases = [...new Set(snapshot.aliases.filter(Boolean))];
            }
        }
        const ops = rawOps;
        const result = applyOps(state, ops, {
            confidenceThreshold: 0,
            reviewThreshold: 0,
            messageCount: Number.POSITIVE_INFINITY,
        });
        state = result.state;
        if (record.scene && typeof record.scene === 'object') {
            state.scene = {
                time: record.scene.time || state.scene.time || '',
                day: normalizeDay(record.scene.day) ?? state.scene.day ?? null,
                place: record.scene.place || state.scene.place || '',
                participants: Array.isArray(record.scene.participants)
                    ? record.scene.participants
                    : state.scene.participants,
            };
        }
    }
    return state;
}

/**
 * Pick the messages for an incremental settle: new messages since the last settle,
 * plus a small overlap used only as context.
 */
export function selectSettleMessages(chat, lastProcessedMessage = -1, options = {}) {
    const list = Array.isArray(chat) ? chat : [];
    if (!list.length) return { messages: [], newFrom: 0 };
    const contextCount = Math.max(0, Number(options.contextCount ?? 3));
    const maxNew = Math.max(1, Number(options.maxNew ?? 20));
    const newFrom = Math.max(0, Number(lastProcessedMessage ?? -1) + 1);
    // 积压超过一批时从最早未结算的消息开始，避免只处理最近 20 条、把中间永久漏掉。
    const end = Math.min(list.length, newFrom + maxNew);
    const start = Math.max(0, newFrom - contextCount);
    const messages = [];
    for (let i = start; i < end; i += 1) {
        const message = list[i];
        const text = String(message?.mes ?? '');
        if (!text.trim()) continue;
        messages.push({
            isUser: Boolean(message.is_user),
            name: message.name || (message.is_user ? (options.userName || 'USER') : (options.aiName || 'AI')),
            mes: text,
            index: i,
        });
    }
    return { messages, newFrom, to: end - 1 };
}

/**
 * Compact view for the extraction prompt: current values only. History arrays,
 * evidence and timestamps are useless to the extractor and dominate long chats.
 */
function compactStateForPrompt(state) {
    // ID 只留在代码里；给提取模型看的键一律换成名字。
    const display = (id) => (id === PROTAGONIST_ID ? PROTAGONIST_NAME : (state.characters?.[id]?.name || id));
    const nameBeliefs = (beliefs) => {
        if (!beliefs || typeof beliefs !== 'object') return beliefs;
        const out = {};
        for (const [id, info] of Object.entries(beliefs)) out[display(id)] = info;
        return out;
    };
    const characters = {};
    for (const [id, character] of Object.entries(state.characters || {})) {
        const fields = {};
        const fieldAccess = {};
        for (const [field, entry] of Object.entries(character.state || {})) {
            if (RETIRED_FIELDS.has(field)) continue;
            const value = entry && typeof entry === 'object' && 'current' in entry ? entry.current : entry;
            if (value !== undefined && value !== null && value !== '') {
                fields[field] = value;
                const access = entityAccess(entry, 'public');
                if (access !== 'public') fieldAccess[field] = access;
            }
        }
        const items = (character.items || [])
            .filter((item) => item.validTo == null)
            .map((item) => ({
                id: item.id,
                name: item.name,
                quantity: item.quantity,
                ...(item.unit ? { unit: item.unit } : {}),
                kind: item.kind,
                ...(entityAccess(item, 'public') !== 'public' ? { access: entityAccess(item, 'public') } : {}),
            }));
        const skills = (character.skills || [])
            .filter((skill) => skill.validTo == null)
            .map((skill) => ({
                id: skill.id,
                name: skill.name,
                type: skill.type,
                level: skill.level,
                ...(entityAccess(skill, 'public') !== 'public' ? { access: entityAccess(skill, 'public') } : {}),
            }));
        const abilities = (character.abilities || [])
            .filter((ability) => ability.validTo == null)
            .map((ability) => ({
                id: ability.id,
                name: ability.name,
                type: ability.type,
                level: ability.level,
                ...(entityAccess(ability, 'public') !== 'public' ? { access: entityAccess(ability, 'public') } : {}),
            }));
        const relations = (character.relations || [])
            .filter((relation) => relation.validTo == null)
            .map((relation) => ({
                target: relation.targetName || display(relation.target),
                type: relation.type,
                attitude: relation.attitude,
                ...(relation.address ? { address: relation.address } : {}),
                ...(entityAccess(relation, 'public') !== 'public' ? { access: entityAccess(relation, 'public') } : {}),
            }));
        const facts = (character.facts || []).map((fact) => ({
            text: fact.text,
            ...(entityAccess(fact, 'public') !== 'public' ? { access: entityAccess(fact, 'public') } : {}),
        }));
        let key = id === PROTAGONIST_ID ? PROTAGONIST_ID : (character.name || id);
        let suffix = 2;
        while (characters[key]) key = `${character.name || id}#${suffix++}`;
        characters[key] = {
            access: characterAccess(character),
            ...(character.accessReason ? {
                accessReason: character.accessReason,
                accessChangedDay: character.accessChangedDay ?? null,
            } : {}),
            state: fields,
            ...(Object.keys(fieldAccess).length ? { fieldAccess } : {}),
            ...(items.length ? { items } : {}),
            ...(skills.length ? { skills } : {}),
            ...(abilities.length ? { abilities } : {}),
            ...(relations.length ? { relations } : {}),
            ...(facts.length ? { facts } : {}),
        };
    }
    const facts = {};
    for (const [id, fact] of Object.entries(state.facts || {})) {
        facts[id] = {
            text: fact.text,
            access: entityAccess(fact, 'protagonist'),
            ...(fact.beliefs && Object.keys(fact.beliefs).length ? { beliefs: nameBeliefs(fact.beliefs) } : {}),
            ...(fact.thread_status ? {
                thread_status: fact.thread_status,
                thread_type: fact.thread_type,
                thread_stake: fact.thread_stake,
            } : {}),
            ...(Array.isArray(fact.keywords) && fact.keywords.length ? { keywords: fact.keywords } : {}),
        };
    }
    return {
        characters,
        facts,
        scene: {
            time: state.scene.time,
            day: state.scene.day,
            place: state.scene.place,
            participants: (state.scene.participants || []).map(display),
        },
    };
}

/**
 * 在场角色 + 临时名档案的紧凑名录。
 * 提取模型看整份台账时常常认不出「苏绾」就是「月白长裙女修」，这里单独列一遍。
 */
function characterRoster(state) {
    const inScene = new Set(state.scene?.participants || []);
    const ids = new Set(inScene);
    for (const person of Object.values(state.characters || {})) {
        const name = String(person.name || '');
        if (/(执事|掌柜|女修|长老|夫人|公子|姑娘|甲|乙|丙|丁)$/.test(name)) ids.add(person.id);
    }
    const lines = [];
    for (const id of ids) {
        if (id === PROTAGONIST_ID) continue;
        const person = state.characters?.[id];
        if (!person) continue;
        const aliases = (person.aliases || []).filter(Boolean).join('、');
        lines.push(`- ${person.name || id}${aliases ? `｜别名：${aliases}` : ''}｜${inScene.has(id) ? '在场' : '台账'}`);
    }
    return lines;
}

export function buildExtractionPrompt(inputState, messages, options = {}) {
    const state = normalizeState(inputState);
    migrateStableIds(state);
    const maxMessages = Number(options.maxMessages ?? 20);
    const newFrom = Number(options.newFrom ?? -1);
    const genreHint = String(options.genreHint ?? '').trim();
    const recent = (Array.isArray(messages) ? messages : []).slice(-maxMessages);
    const transcript = recent
        .map((message, index) => {
            const role = message.isUser ? 'USER' : (message.name || 'ASSISTANT');
            const label = message.index ?? index;
            const context = newFrom >= 0 && label < newFrom ? ' [context]' : '';
            return `#${label}${context} ${role}: ${message.mes || ''}`;
        })
        .join('\n');

    const system = [
        '你是小说事实台账的提取引擎，只输出 JSON；沿用原文语言与写法，禁止翻译。',
        '输出：{"protagonist":"user","scene":{"time","day","place","participants"},"ops":[...],"leaks":[]}',
        '',
        '【角色】',
        '- 新角色用中文姓名，不要拼音 id；台账已有的角色必须复用同一姓名（苏姑娘、师妹都写苏绾）。',
        '- 台账里已有的角色一律写姓名，不要写内部 id；不要换一个写法新建第二个档案。',
        '- 姓名揭示：如果台账里已有这个人的临时名或描述名，写 rename_character {from:"临时名",to:"正式名"}，不要新建。',
        '- 例：台账有「白玉广场执事甲」，旁白说「台上那个姓周，叫周显」→ rename_character {from:"白玉广场执事甲",to:"周显"}；不要新建「周显」，也不要同时写 set 把新名字当角色。',
        '- 例：台账有「月白长裙女修」，她自报「我姓苏，单名一个绾字」→ rename_character {from:"月白长裙女修",to:"苏绾"}。',
        '- 旁白或对话里说出某个在场角色的正式姓名时，先判断说的是不是台账里已有的临时名；是就改名，不是才新建。',
        '- 同一条回复里，同一个人只能留一个条目：不要同时写「月白长裙女修」和「苏绾」，也不要同时写「执事甲」和「周执事」。',
        '- 姓+职位（周执事、苏掌柜、王队长）是称呼不是姓名：先对照【在场角色】，若指其中某人，写进 set_relation 的 address，仍然不新建；只有本人明确说这就是他的名字，才 rename。',
        '- 无名角色用「地点+职位+序号」的临时名，例如「白玉广场执事甲」；不同地点或不同场景的同职位角色用不同临时名。无法确认是否同一人时新建，不要合并。',
        '- 纯职位、外观（执事、月白长裙女修）只有在已经发生长期事实（收钱、结仇、承诺）或玩家主动追问时才建档；建档时给唯一临时名。',
        '- 每个 NPC 都要有 access 档位；关系变化用 set_tier 改（定义见【档位与知情】）。',
        '- 主角永远是 protagonist，不要给 NPC 写 protagonist。',
        '- 物品、功法、神通也用故事里的中文名，不要把 id 当 name（不要写 i_lingshi、sk_qingmu 这类）。',
        '- 玩家（「你」「我」）的 character 固定写 "user"；不要给玩家起正式姓名，也不要改写或新增其身世。开局和台账里已有的家族、灵根、体质、功法、随身物按原文记录；不要把「你/我/玩家/主角」建成角色。',
        '- 称呼不是名字，不能拿称呼建角色；称呼（含 NPC 起的外号）可记进 set_relation 的 address（小友/道友/师兄/少主/小石头都行），只在首次出现或改变时写。',
        '- 旁白里出场且有名字或稳定头衔（赵长老）的角色都要有记录：至少写进 set_scene 的 participants；有新角色进场就更新 participants。',
        '- gender 只有 男/女/未知：主角必须写；旁白用「他/她」指代某个角色时补该角色的 gender；师兄/师弟、姑娘/小姐可推；职位（掌柜/长老/弟子）不推；判断不了写未知，不凭名字猜。后来才发现就补一次。',
        '- 例：NPC 叫你「师兄」→ set user.gender 男；「师妹」→ 女。',
        '- NPC 只记 name 与 gender/realm/status 等关键字段；NPC 与玩家的关系要记，NPC 之间的关系网不用铺开。',
        '',
        '【记录范围】',
        '- 只记五类当前事实：状态、物品/金钱、关系、功法与神通、秘密/身份/承诺。',
        '- 顶层事实（add_fact）只写主角已经知道的事；NPC 单方面知道的秘密不建档。',
        '- 功法用于提升境界、灵力与根基；神通是攻伐、防御、身法、遁术等外显招式。不要把神通记成功法。',
        '- 主角刻意隐瞒的功法/神通（暗功、底牌）写 access:"protagonist"。',
        '- 同一条秘密的档位变化用 reveal 指向原条目（fact/item/relation/skill/ability）；不要为「谁知道」另写一条新事实。',
        '- 关系（秘密同盟、暗中勾结）被第三方得知时，同样用 reveal 的 relation 目标。例：你与王掌柜的秘密同盟被苏绾看破 → reveal {relation:"王掌柜",to:"苏绾",by:"你",method:"当面确认"}。',
        '- 天气、情绪、寒暄、点头、道谢、看了一眼、日常修炼、一次性动作一律不记。',
        '- 事件记忆交给酒馆原生上下文和向量召回：不要写事件条目，也不要把「今天发生了什么」重新抄成事实。只记当前仍然成立的状态与秘密。',
        '- set_scene 的 participants 只写当前在场的人；进场/离场或时间地点变化时更新；第一轮必须写一次 set_scene。',
        '- 时间写具体：季节·月·日·时辰（夏·六月初三·午时），禁止写「某日」「近日」「不详」。叙述没给日期时，按季节补一个具体日子；之后以台账里的 time 为基准往后推，不要凭季节重选月份。',
        '- scene.day 记故事内第几天（整数，开局写 1）：过夜 +1，一个月 +30；day 每 +30，月份 +1、日不变，跨季按 1-3 春、4-6 夏、7-9 秋、10-12 冬。没有明确时间流逝就不改 day。',
        '- 粒度：状态记属性+当前值；秘密记内容+知情者+代价；关系记双方+关系+公开程度。',
        '- 亲密/情感进展用一句事实或 relation.attitude 概括。',
        '- 只写对话里明确发生的事，不确定的不写。',
        '- 第一轮把开场白里已经写明的主角背景（家族、灵根、体质、功法、随身物）记进台账，不要扩写或补设定。',
        '',
        '【物品与金钱】',
        '- 货币设 kind:"currency" + unit；金钱和消耗品用 quantity 记。',
        '- 花费/获得用 adjust_item（delta 正负）；精确设置用 set_item_quantity；失去单件 remove_item，失去一类 clear_items（includeCurrency:true 连钱），失去所有钱 clear_currency。',
        '- 物品转手用 move_item，不要先删再建。',
        '- 首次给出余额或数量时先 add_item / set_item_quantity，再 adjust；不要操作台账里不存在的物品。',
        '- 功法用 add_skill / set_skill / remove_skill；神通用 add_ability / set_ability / remove_ability。两者都可以有多条。',
        '',
        '【档位与知情】',
        '- 角色档位：主角 protagonist；NPC 分 intimate（道侣/挚友/生死之交）、friend（同门/熟识/长期合作）、public（陌生人/路人/仇敌）。',
        '- 条目档位：protagonist（默认只有主角知道；正文写明的例外另记）/ intimate / friend / public（人人皆知）。知情 = 角色档位 ≥ 条目档位。',
        '- 默认档位只在正文没给线索时使用：顶层事实 protagonist；字段/物品/关系/功法/神通 public。事实先按下面的定档顺序判断。',
        '- 定档顺序：① 当众发生、公开场合、旁人能看到 → public；② 没人看见或刻意隐藏 → protagonist；③ 有目击者 → 取目击者中与主角关系最疏远的那一档（有 public 目击者就是 public）；④ 拿不准 → protagonist。',
        '- 目击者写真正看到/听到的人：add_fact 可以写 witnesses。承诺保密只另记一条承诺事实，不改变谁知道。',
        '- 例：苏绾是道侣 → set_tier {character:"苏绾",access:"intimate",reason:"道侣"}；王掌柜只是熟识 → access:"friend"；广场执事 → access:"public"。',
        '- 改档必须写 reason，且只能用这些：public→friend 用「正式结交/同门名分/多次互助」；friend→intimate 用「结拜/道侣/共同生死/长期共处」；public→intimate 只能用「结拜/道侣/共同生死」。降档 intimate→friend 用「决裂/背叛/明确疏远」；friend→public 用「决裂/背叛/长期无往来」。',
        '- 分歧、吵架、语气变差不算降档，只改 relation.attitude。长期无往来要至少 30 故事日且期间没有同场。',
        '- 同一次结算每个角色最多改一档；改档后 3 个故事日内不要反向改，除非结拜/道侣/共同生死/决裂/背叛。',
        '- 主角刻意隐藏修为或身份时，把字段本身写低档：set {character:"user",field:"realm",value:"筑基",access:"protagonist"}。只写一条“隐瞒修为”的事实不算隔离，因为 realm 字段仍是公开的。',
        '- 正文明确写某人知道了（说出、展示、看到、听到、看破）→ reveal，把档位放宽到该人的档位。',
        '- 例：把玉牌给苏绾看 → reveal {item:"残缺符文的玉牌",to:"苏绾",by:"你",method:"给她看"}（档位放宽到朋友级；档位级下同档都会知道）。',
        '- 例：当着苏绾的面运转噬灵诀 → reveal {skill:"噬灵诀",to:"苏绾",by:"你",method:"当面施展"}。',
        '- 例：在宗门大殿当众承认 → reveal {fact:"你藏着混沌珠",to:"王掌柜",by:"你",method:"当众承认"}（王掌柜是公开级，档位放宽到公开）。',
        '- 正文明确写某人不知道/被瞒着，但档位把他算成知情：不要为这个改档；当前正文优先，台账保持默认。',
        '- 正文没写某人知道/不知道时，不要因为他在场、看到或沉默就推断；按档位。',
        '- 看穿别人的隐藏修为或身份时，把知情落到字段上：reveal {to,by,method:"神识",character:"对方",field:"realm"}；字段本来公开的就不用。',
        '- 主角的灵根、体质、身世默认 public；正文写明只有自己知道或刻意隐瞒时，才写 access:"protagonist"。',
        '- 用户消息是玩家的行动或内心，不等于当众说出；只有明确“说出/被看见/被听见”才算 NPC 知情。',
        '- 猜测与误信不属于档位：写进 beliefs，例 add_fact {text:"王掌柜以为你袖中是药方",access:"public",beliefs:{"王掌柜":{state:"false_belief",belief:"袖中是药方"}}}；起疑写 {state:"suspects",suspicion:"袖中藏着东西"}。',
        '- 事实正文只写真相；谣传与猜疑放进 beliefs，否则叙述者只拿到错误版本。',
        '- 只有正文明确当众公开（公告、传开、当众揭穿）才把同一 id 的 access 改成 "public"；只告诉一个人用 reveal，档位会放宽到该人所在档。',
        '- 人情/承诺/仇怨/悬案用 add_fact + thread_status:"open"、thread_type、thread_stake；家族旧祠、残卷来历这类长期悬念同样用 open，不要只记成普通事实；了结时同 id 重写 "closed"。',
        '- 谣言扩散记成一条公开事实（谁在传、范围），正文只写“关于什么”，错误版本放 belief。',
        '- 秘密写清对象（“你藏着混沌珠”），并写 keywords（2-4 个专名/物件）；冷却后靠它被重新提起。',
        '- leaks 列出角色引用了认知外的事实；没有就空数组。',
        '',
        '【格式】',
        '- 除 set_scene 外每个 op 都要 evidence（msg:0）和 confidence(0-1)；<0.5 不写；validFrom 可省。',
        '- 带 [context] 的消息只用于理解指代，不生成 op。',
        '- 正文里指代玩家写「你」，不要写 user 或账号名。',
        '- field 用【题材与字段约定】里的字段名。',
        '示例：',
        '输入：#0 你把混沌珠藏进怀里，苏绾背对着你，她没有看见。 #1 苏绾叫你“师兄”。',
        '输出：{"protagonist":"user","scene":{"time":"秋·九月初七·午时","day":12,"place":"云来客栈","participants":["user","苏绾"]},"ops":[{"op":"set","character":"user","field":"gender","value":"男","evidence":"msg:1","confidence":0.9},{"op":"set_tier","character":"苏绾","access":"friend","reason":"同门名分","evidence":"msg:1","confidence":0.9},{"op":"set_relation","from":"苏绾","to":"user","type":"同门","attitude":"亲近","address":"师兄","evidence":"msg:1","confidence":0.9},{"op":"add_item","character":"user","item":{"name":"混沌珠","kind":"artifact","access":"protagonist"},"evidence":"msg:0","confidence":0.95}],"leaks":[]}',
        '',
        '【输出前自检】',
        '- 按【角色】的规则过一遍：同一人只留一个条目，新名字先 rename_character，不新建。',
    ].join('\n');

    const roster = characterRoster(state);
    const user = [
        '【题材与字段约定】',
        genreHint || '（未指定，按对话内容自行判断字段名）',
        '',
        '【在场角色】',
        '- 旁白提到下列角色时必须沿用表里的名字或 id，不要换一种写法另建档案。',
        '- 旁白说出新姓名或新头衔（周执事、苏姑娘）时先对照本表：指的是其中某人就用 rename_character（或 set_relation 的 address），表里没有的才是新角色。',
        ...(roster.length ? roster : ['（无）']),
        '',
        '【当前台账】',
        // Do not send meta (version log / leaks / health) to the extraction model.
        JSON.stringify(compactStateForPrompt(state)),
        '',
        '【最近对话】',
        newFrom >= 0 ? `（只提取 #${newFrom} 及之后的消息；带 [context] 的仅作上下文）` : '',
        transcript || '（无）',
        '',
        '【输出要求】',
        '- set {character,field,value,access?}',
        '- set_tier {character,access,reason}',
        '- add_item {character,item:{id,name,holder?,note?,quantity?,unit?,kind?,access?}}',
        '- adjust_item {item,delta,character?,reason?,unit?,kind?}',
        '- remove_item {item,character?,reason?}',
        '- clear_items {character?,kinds?,includeCurrency?,reason?}',
        '- clear_currency {character?,reason?}',
        '- set_item_quantity {item,quantity,character?,reason?}',
        '- add_skill {character,skill:{id,name,type,level,note?,access?}}',
        '- set_skill {skill,character?,level?,note?,access?}',
        '- remove_skill {skill,character?,reason?}',
        '- add_ability {character,ability:{id,name,type,level,note?,access?}}',
        '- set_ability {ability,character?,level?,note?,access?}',
        '- remove_ability {ability,character?,reason?}',
        '- move_item {item,to,access?}',
        '- set_relation {from,to,type,attitude?,address?,access?}',
        '- add_fact {fact:{id,text,access?,witnesses?,beliefs?,keywords?,thread_status?,thread_type?,thread_stake?}}',
        '- reveal {to,by,method,fact?|character?+field?|character?+fact?|item?|relation?|skill?|ability?}',
        '- set_scene {scene:{time,day,place,participants}}',
        '- rename_character {from,to}（姓名揭示，沿用原档案）',
        '- merge_character {from,to}（确认两个临时档案是同一人）',
    ].join('\n');

    return { system, user };
}

/**
 * DeepSeek 的 json_object 模式并不保证换行被转义，长句里常出现裸换行。
 * JSON 字符串内不允许裸控制字符，这里逐字符补转义后再解析。
 */
function repairJsonStrings(text) {
    let out = '';
    let inString = false;
    let escaped = false;
    for (const char of text) {
        if (inString) {
            if (escaped) {
                out += char;
                escaped = false;
                continue;
            }
            if (char === '\\') {
                out += char;
                escaped = true;
                continue;
            }
            if (char === '"') {
                out += char;
                inString = false;
                continue;
            }
            const code = char.charCodeAt(0);
            if (code < 0x20) {
                if (char === '\n') out += '\\n';
                else if (char === '\r') out += '\\r';
                else if (char === '\t') out += '\\t';
                else out += `\\u${code.toString(16).padStart(4, '0')}`;
                continue;
            }
            out += char;
            continue;
        }
        if (char === '"') inString = true;
        out += char;
    }
    return out;
}

/**
 * 模型偶尔会提前关掉 op 对象，写成 "event":{...}},"evidence":...。
 * evidence/confidence 一定与 op 平级，所以这类多余右括号可以安全合并。
 */
function collapsePrematureBraces(text) {
    return text.replace(/\}{2,}(?=,\s*"(?:evidence|confidence)")/g, '}');
}

function parseJsonLenient(text) {
    try {
        return JSON.parse(text);
    } catch (err) {
        const repaired = collapsePrematureBraces(text);
        if (repaired === text) throw err;
        return JSON.parse(repaired);
    }
}

export function parseExtractionResponse(text) {
    let raw = String(text ?? '').trim();
    raw = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
        throw new Error('响应中没有 JSON 对象');
    }
    const data = parseJsonLenient(repairJsonStrings(raw.slice(start, end + 1)));
    if (!Array.isArray(data.ops)) data.ops = [];
    if (!Array.isArray(data.leaks)) data.leaks = [];
    if (!data.scene || typeof data.scene !== 'object') data.scene = {};
    return data;
}

export function healthCheck(inputState, options = {}) {
    const state = normalizeState(inputState);
    const issues = [];
    const injection = options.injection ?? '';
    const budget = Number(options.tokenBudget ?? 3000);

    for (const character of Object.values(state.characters)) {
        for (const [field, entry] of Object.entries(character.state || {})) {
            if (!entry || typeof entry !== 'object' || !Array.isArray(entry.history)) {
                issues.push(`角色 ${character.name || character.id} 字段 ${field} 缺少 history`);
            }
        }
        const currentItems = (character.items || []).filter((item) => item.validTo == null);
        const byId = new Map();
        for (const item of currentItems) {
            byId.set(item.id, (byId.get(item.id) || 0) + 1);
        }
        for (const [id, count] of byId) {
            if (count > 1) issues.push(`角色 ${character.name || character.id} 的物品 ${id} 有 ${count} 个当前持有记录`);
        }
    }
    for (const character of Object.values(state.characters)) {
        if (character.id !== PROTAGONIST_ID && character.access === 'protagonist') {
            issues.push(`角色 ${character.name || character.id} 不应是主角级`);
        }
    }
    if (state.meta?.lastError) {
        issues.push(`上次提取错误：${state.meta.lastError}`);
    }
    if (Array.isArray(state.meta?.leaks) && state.meta.leaks.length > 0) {
        issues.push(`存在 ${state.meta.leaks.length} 条泄露记录`);
    }
    if (injection && estimateTokens(injection) > budget) {
        issues.push(`注入块 ${estimateTokens(injection)} tokens，超出预算 ${budget}`);
    }
    return issues;
}
