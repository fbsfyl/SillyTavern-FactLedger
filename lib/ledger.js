/**
 * Fact Ledger pure logic.
 * No browser or SillyTavern imports: this module must be testable in Node.
 */

/** Stable id for the player's character, who deliberately has no in-story name. */
export const PROTAGONIST_ID = 'user';
export const PROTAGONIST_NAME = '你';
export const PROTAGONIST_ALIASES = ['你', '我', '玩家', '主角', '{{user}}', '%user%'];

/** 酒馆默认的 persona 占位名：不是故事里的姓名，不注入、不显示。 */
const PLACEHOLDER_PERSONA_NAMES = new Set(['user', 'you', '你', '我', '玩家', '主角', 'persona']);

export function isPlaceholderPersonaName(value) {
    return PLACEHOLDER_PERSONA_NAMES.has(String(value ?? '').trim().toLowerCase());
}

/** 知情档位：角色接近到什么程度，才允许知道这条信息。 */
export const ACCESS_LEVELS = ['public', 'friend', 'intimate', 'protagonist'];
const ACCESS_RANK = { public: 0, friend: 1, intimate: 2, protagonist: 3 };
export const ACCESS_LABELS = {
    public: '公开级',
    friend: '朋友级',
    intimate: '亲密级',
    protagonist: '主角级',
};

/** 档位只为事实隔离服务：升降看知情与信任证据，不看关系称谓。 */
const TIER_UPGRADE_REASONS = {
    'public>friend': new Set(['共同守密', '主动告知底牌', '长期同场']),
    'friend>intimate': new Set(['生死与共', '主动托付', '共同守密']),
    'public>intimate': new Set(['生死与共', '主动托付']),
};
const TIER_DOWNGRADE_REASONS = {
    'intimate>friend': new Set(['泄密', '背叛', '明确疏远']),
    'friend>public': new Set(['泄密', '背叛', '长期无往来']),
};
const TIER_MILESTONES = new Set(['生死与共', '主动托付', '泄密', '背叛']);
const TIER_REVERSE_COOLDOWN_DAYS = 3;
const TIER_ABSENCE_DAYS = 30;
const TIER_VOTE_WINDOW_DAYS = 3;

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

/** 只认档位；写错时按最严处理。 */
function inferAccess(entity, fallback = 'public') {
    if (!entity || typeof entity !== 'object') return fallback;
    const value = String(entity.access ?? '').trim().toLowerCase();
    if (ACCESS_LEVELS.includes(value)) return value;
    // 写错的档位按最严处理，避免拼写错误静默变成公开。
    if (value) return 'protagonist';
    return fallback;
}

export function entityAccess(entity, fallback = 'public') {
    return inferAccess(entity, fallback);
}

export function characterAccess(character) {
    if (!character) return 'public';
    if (character.id === PROTAGONIST_ID) return 'protagonist';
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

/** 提取模型有时把内部 id 写进正文，注入与状态栏就会露出 "user"。 */
function playerText(value) {
    const text = String(value ?? '');
    if (!text) return text;
    return text.replace(/(?<![A-Za-z0-9_])user(?![A-Za-z0-9_])/gi, PROTAGONIST_NAME);
}

export function isProtagonistAlias(value) {
    return PROTAGONIST_ALIASES.includes(String(value ?? '').trim());
}

/** 书名号不是功法名的一部分：模型偶尔把同一门写成《虎蹚步》。 */
function normalizedTraitName(value) {
    return String(value ?? '').trim()
        .replace(/^[《〈「『“"]+/, '')
        .replace(/[》〉」』”"]+$/, '')
        .trim();
}

export function createEmptyState() {
    return {
        characters: {},
        scene: {
            time: '',
            day: null,
            place: '',
            participants: [],
        },
        meta: {
            nextCharacterId: 1,
            lastProcessedMessage: -1,
            lastProcessedHash: '',
            messagesSinceSettle: 0,
            lastSettleAt: null,
            lastError: '',
            protagonistId: '',
            leaks: [],
            history: [],
        },
    };
}

export function normalizeState(input) {
    const state = input && typeof input === 'object' ? input : createEmptyState();
    if (!state.characters || typeof state.characters !== 'object') state.characters = {};
    if (!state.scene || typeof state.scene !== 'object') {
        state.scene = { time: '', day: null, place: '', participants: [] };
    }
    if (!Array.isArray(state.scene.participants)) state.scene.participants = [];
    state.scene.day = normalizeDay(state.scene.day);
    if (!state.meta || typeof state.meta !== 'object') state.meta = createEmptyState().meta;
    if (!Array.isArray(state.meta.leaks)) state.meta.leaks = [];
    if (!Array.isArray(state.meta.review)) state.meta.review = [];
    if (!Array.isArray(state.meta.history)) state.meta.history = [];
    // 旧版模型自报的 leaks 没有 target，已无法处理；保留 0.16 代码检测的记录。
    state.meta.leaks = state.meta.leaks.filter((leak) => (
        leak && typeof leak === 'object' && leak.target && typeof leak.target === 'object'
    ));
    // 旧版待复核里的 add_fact 已无法落地；其余条目保留。
    state.meta.review = state.meta.review.filter((item) => {
        const op = item && typeof item === 'object' && item.op && typeof item.op === 'object' ? item.op : item;
        return op && typeof op === 'object' && op.op !== 'add_fact';
    });
    const pinnedProtagonist = String(state.meta?.protagonistId || '').trim();

    for (const [id, character] of Object.entries(state.characters)) {
        // 手工改坏或导入异常的条目直接丢弃，避免整个面板卡死。
        if (!character || typeof character !== 'object') {
            delete state.characters[id];
            continue;
        }
        if (!character.state || typeof character.state !== 'object') character.state = {};
        // 旧版字段是纯字符串：迁移成 current/history，否则角色页会显示空值。
        for (const [field, entry] of Object.entries(character.state)) {
            if (entry === null || entry === undefined) {
                delete character.state[field];
            } else if (typeof entry !== 'object') {
                character.state[field] = { current: entry, history: [] };
            } else if (!Array.isArray(entry.history)) {
                entry.history = [];
            }
        }
        // 旧版每角色 facts 数组已废弃。
        if (character.facts !== undefined) delete character.facts;
        const isProtagonist = character.id === PROTAGONIST_ID
            || (pinnedProtagonist !== '' && character.id === pinnedProtagonist);
        if (isProtagonist) {
            character.tier = 'main';
            character.access = 'protagonist';
        } else {
            if (character.tier === 'main') character.tier = 'major';
            // protagonist 档位只属于玩家；NPC 身上残留的必须降回公开。
            character.access = character.access === 'protagonist'
                ? 'public'
                : normalizeAccess(character.access, 'public');
        }
        if (character.accessPending && typeof character.accessPending === 'object') {
            const target = normalizeAccess(character.accessPending.target, '');
            if (!target || target === character.access) character.accessPending = null;
            else character.accessPending.target = target;
        } else if (character.accessPending !== undefined) {
            character.accessPending = null;
        }
        // status / health / objective / situation 字段已废弃；旧聊天里的残留直接清掉。
        for (const retired of ['status', 'health', 'objective', 'situation']) {
            if (character.state?.[retired] !== undefined) delete character.state[retired];
        }
        character.items = (Array.isArray(character.items) ? character.items : [])
            .filter((item) => item && typeof item === 'object');
        character.relations = (Array.isArray(character.relations) ? character.relations : [])
            .filter((relation) => relation && typeof relation === 'object');
        character.skills = (Array.isArray(character.skills) ? character.skills : [])
            .filter((skill) => skill && typeof skill === 'object');
        // 神通并入功法：旧数据里的 abilities 直接并进 skills，之后不再有这一栏。
        if (Array.isArray(character.abilities)) {
            character.skills.push(...character.abilities.filter((ability) => ability && typeof ability === 'object'));
            delete character.abilities;
        }
        // 同名只保留一条当前条目，避免旧数据里换 id 或加书名号产生的重复。
        {
            const kept = new Map();
            character.skills = character.skills.filter((skill) => {
                // 功法不再分「功法/神通」，type 统一成内部默认值。
                skill.type = 'technique';
                skill.level = traitLevel(skill.level);
                const name = normalizedTraitName(skill.name);
                if (name) skill.name = name;
                if (skill.validTo != null || !name) return true;
                const existing = kept.get(name);
                if (!existing) {
                    kept.set(name, skill);
                    return true;
                }
                // 重复条目合并信息后丢弃，保住层次与来源。
                if (!existing.level && skill.level) existing.level = skill.level;
                if (!existing.evidence && skill.evidence) existing.evidence = skill.evidence;
                if (!existing.validFrom) existing.validFrom = skill.validFrom;
                return false;
            });
        }
        // 旧版把 location 当字段记；完整地点已由 scene.place 承担，迁移后删除。
        const legacyLocation = character.state?.location;
        if (legacyLocation !== undefined) {
            const place = String(legacyLocation?.current ?? legacyLocation ?? '').trim();
            if (isProtagonist && place && !String(state.scene.place || '').trim()) {
                state.scene.place = place;
            }
            delete character.state.location;
        }
        // 旧版把主修功法放在 technique 字段；统一迁进 skills，避免和 add_skill 两份。
        const legacyTechnique = character.state?.technique;
        if (legacyTechnique !== undefined) {
            const name = String(legacyTechnique?.current ?? legacyTechnique ?? '').trim();
            const access = entityAccess(legacyTechnique, 'public');
            delete character.state.technique;
            if (isProtagonist && name && !character.skills.some((skill) => skill.name === name && skill.validTo == null)) {
                character.skills.push({
                    id: `sk_${slug(name)}`,
                    name,
                    type: 'technique',
                    validFrom: legacyTechnique?.validFrom || '',
                    validTo: null,
                    evidence: legacyTechnique?.evidence || '',
                    access,
                    history: [],
                });
            }
        }
        // NPC 只保留最小档案：进度属于主角内景，功法不单独建档。
        if (!isProtagonist) {
            if (character.state?.progress !== undefined) delete character.state.progress;
            character.skills = [];
        }
        for (const item of character.items) {
            const quantity = Number(item.quantity);
            item.quantity = Number.isFinite(quantity) ? quantity : 1;
            if (typeof item.unit !== 'string') item.unit = '';
            if (typeof item.kind !== 'string') item.kind = 'item';
            item.access = entityAccess(item, 'public');
        }
        for (const entry of Object.values(character.state)) {
            entry.access = entityAccess(entry, 'public');
        }
        for (const relation of character.relations) {
            // 态度与称呼不再记账：旧聊天里的残留直接清掉。
            if (relation.attitude !== undefined) delete relation.attitude;
            if (relation.address !== undefined) delete relation.address;
            if (relation.callsPlayer !== undefined) delete relation.callsPlayer;
            relation.access = entityAccess(relation, 'public');
        }
        for (const skill of character.skills) {
            if (!skill.id) skill.id = `sk_${slug(skill.name || 'skill')}`;
            if (!Array.isArray(skill.history)) skill.history = [];
            skill.access = entityAccess(skill, 'public');
        }
    }

    // NPC 不再保存自己的关系：NPC→玩家只把 type 合并到主角侧，其余丢弃。
    {
        const ownerId = state.meta?.protagonistId || PROTAGONIST_ID;
        const owner = state.characters[ownerId] || state.characters[PROTAGONIST_ID];
        if (owner) {
            if (!Array.isArray(owner.relations)) owner.relations = [];
            for (const [id, character] of Object.entries(state.characters)) {
                if (character === owner) continue;
                const relations = Array.isArray(character.relations) ? character.relations : [];
                for (const relation of relations) {
                    if (relation.validTo != null) continue;
                    if (relation.target !== owner.id && relation.target !== PROTAGONIST_ID) continue;
                    const live = owner.relations.find((entry) => entry.validTo == null && entry.target === id);
                    if (!live) {
                        owner.relations.push({
                            target: id,
                            targetName: character.name || relation.targetName || id,
                            type: relation.type || '',
                            validFrom: relation.validFrom || '',
                            validTo: null,
                            evidence: relation.evidence || '',
                            confidence: relation.confidence ?? 1,
                            access: entityAccess(relation, 'public'),
                        });
                    } else if (relation.type && relationNewer(relation, live)) {
                        // 两边都写过时，取证据更新的那一条作为关系类型。
                        live.type = relation.type;
                        live.evidence = relation.evidence || live.evidence;
                        live.confidence = relation.confidence ?? live.confidence;
                        const nextAccess = entityAccess(relation, 'public');
                        if (ACCESS_RANK[nextAccess] > ACCESS_RANK[entityAccess(live, 'public')]) {
                            live.access = nextAccess;
                        }
                    }
                }
                character.relations = [];
            }
        }
    }

    if (state.characters[PROTAGONIST_ID]) state.meta.protagonistId = PROTAGONIST_ID;

    // 顶层事实（add_fact）已删除；旧聊天里的 facts 直接清掉。
    if (state.facts !== undefined) delete state.facts;

    sanitizePlayerRefs(state);

    return state;
}

/** 提取模型可能把内部 id 写进正文，加载时统一改回「你」。 */
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
    }
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
    return op.validFrom ?? sceneTimeLabel(state.scene);
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

const DAYS_PER_MONTH = 30;
const MONTHS_PER_YEAR = 12;
// 只认时辰/时段；旧数据里的完整日期（秋·九月初七·午时）会退化成其中的时辰。
const CLOCK_PATTERN = /(凌晨|清晨|早晨|上午|中午|正午|午后|下午|傍晚|黄昏|入夜|夜里|夜晚|深夜|半夜|子时|丑时|寅时|卯时|辰时|巳时|午时|未时|申时|酉时|戌时|亥时|夜|晨)/;

/** 把「故事内第几天」换算成年月日：一个月 30 天，一年 12 个月，开局是第 1 年 1 月 1 日。 */
export function storyDate(value) {
    const total = Math.max(1, Math.floor(normalizeDay(value) ?? 1));
    return {
        year: Math.floor((total - 1) / (DAYS_PER_MONTH * MONTHS_PER_YEAR)) + 1,
        month: Math.floor((total - 1) / DAYS_PER_MONTH) % MONTHS_PER_YEAR + 1,
        day: (total - 1) % DAYS_PER_MONTH + 1,
    };
}

export function formatStoryDate(value) {
    const { year, month, day } = storyDate(value);
    return `第${year}年${month}月${day}日`;
}

/** 场景时间的统一写法：日期由 day 推算，time 只补时辰。旧数据缺 day 时退回原文本。 */
export function sceneTimeLabel(scene = {}) {
    const raw = String(scene.time || '').trim();
    const clock = (raw.match(CLOCK_PATTERN) || [])[0] || '';
    const day = normalizeDay(scene.day);
    if (day === null) return clock || raw;
    const date = formatStoryDate(day);
    return clock ? `${date} · ${clock}` : date;
}

/**
 * 把 scene.advance 的单位累加到当前 day。
 * 模型只写 years/months/weeks/days，换算交给代码；没有 advance 时退回绝对 day（旧数据兼容）。
 */
export function resolveSceneDay(currentDay, scene = {}) {
    const advance = scene && typeof scene.advance === 'object' && scene.advance ? scene.advance : null;
    if (advance) {
        const years = Number(advance.years) || 0;
        const months = Number(advance.months) || 0;
        const weeks = Number(advance.weeks) || 0;
        const days = Number(advance.days) || 0;
        const delta = years * DAYS_PER_MONTH * MONTHS_PER_YEAR
            + months * DAYS_PER_MONTH
            + weeks * 7
            + days;
        if (Number.isFinite(delta) && delta > 0) {
            return (normalizeDay(currentDay) ?? 1) + Math.round(delta);
        }
        // advance 全为 0 或非法：保持原日期，不要把它抹成未知。
        return normalizeDay(currentDay) ?? 1;
    }
    return normalizeDay(scene?.day);
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
// name reveal never has to rewrite relations or beliefs.

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
        relations: [],
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


function isPublicEntity(entity, fallback = 'public') {
    return entityAccess(entity, fallback) === 'public';
}

/**
 * 定期把主角仍为公开级的字段/物品/功法升到朋友级，最高只到朋友级。
 * 性别、姓名、外貌体型、境界进度是身份与内景，关系表示双方之间的联系，都不参与。
 */
export function promotePublicEntries(state, protagonistId = PROTAGONIST_ID) {
    const id = protagonistId || state.meta?.protagonistId || PROTAGONIST_ID;
    const character = state.characters?.[id];
    if (!character) return 0;
    const skipFields = new Set(['gender', 'name', 'progress', 'appearance']);
    let count = 0;
    for (const [field, entry] of Object.entries(character.state || {})) {
        if (skipFields.has(field) || entityAccess(entry, 'public') !== 'public') continue;
        entry.access = 'friend';
        count += 1;
    }
    for (const pool of ['items', 'skills']) {
        for (const entity of character[pool] || []) {
            if (entity.validTo != null || entityAccess(entity, 'public') !== 'public') continue;
            entity.access = 'friend';
            count += 1;
        }
    }
    return count;
}

/** 给非公开条目加上中文知情名单，避免叙事者把秘密当成公开信息。 */
function knowledgeTag(entity, state, fallback = 'public') {
    const names = Object.values(state?.characters || {})
        .filter((character) => knowsEntity(entity, character.id, state, fallback))
        .map((character) => (character.id === PROTAGONIST_ID ? PROTAGONIST_NAME : (character.name || character.id)));
    if (!names.length) return '';
    return `（知情：${names.slice(0, 6).join('、')}${names.length > 6 ? '等' : ''}）`;
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
    if (!Array.isArray(character.relations)) character.relations = [];
    return character;
}

/** Create a name-only record for someone the narration put on stage. */
export function ensureCharacterRecord(inputState, name) {
    const ref = String(name || '').trim();
    if (!ref || isAddressTerm(ref)) return null;
    const state = normalizeState(inputState);
    return ensureCharacter(state, ref);
}

/**
 * 把酒馆 persona 名种进台账。姓名默认好友级：叙事者知道并可以称呼，
 * 但公开级 NPC 不会凭空知道玩家姓名。
 */
export function seedProtagonistName(inputState, name) {
    const text = String(name ?? '').trim();
    if (!text || isPlaceholderPersonaName(text)) return false;
    const state = inputState;
    if (!state || typeof state !== 'object') return false;
    if (!state.characters || typeof state.characters !== 'object') state.characters = {};
    if (!state.meta || typeof state.meta !== 'object') state.meta = createEmptyState().meta;
    const owner = state.meta.protagonistId || PROTAGONIST_ID;
    const character = ensureCharacter(state, owner);
    if (!character) return false;
    if (character.state?.name?.current) return false;
    if (!character.state) character.state = {};
    character.state.name = {
        current: text,
        history: [{ value: text, validFrom: '', validTo: null, evidence: 'persona', confidence: 1 }],
        validFrom: '',
        evidence: 'persona',
        confidence: 1,
        access: 'friend',
    };
    return true;
}

/** 玩家身份字段：允许首次记录，不允许后续改写。 */
const PLAYER_IDENTITY_FIELDS = new Set([
    'spiritRoot', 'physique', 'constitution', 'origin', 'birth', 'background', 'family', 'name',
]);

/** 灵根/体质/境界进度默认只有主角知道；正文明确公开时才写 access。 */
const SECRET_IDENTITY_FIELDS = new Set(['spiritRoot', 'physique', 'constitution', 'progress']);

/** 这些不是状态字段，各有专用 op；用 set 写进来会绕开 NPC 最小档案和结构校验。 */
const STRUCTURAL_FIELDS = new Set(['skills', 'abilities', 'items', 'relations', 'facts', 'tier', 'access', 'aliases', 'id']);

/** 提取模型偶尔会写中文字段名；先归一化，再走身份字段保护。 */
const FIELD_ALIASES = {
    灵根: 'spiritRoot',
    体质: 'physique',
    身世: 'origin',
    出身: 'origin',
    家族: 'family',
    姓名: 'name',
    境界: 'realm',
    进度: 'progress',
    境界进度: 'progress',
    地点: 'location',
    位置: 'location',
    功法: 'technique',
    主修功法: 'technique',
    伤势: 'health',
    目标: 'objective',
    局势: 'situation',
};

function setField(state, op, options = {}) {
    const character = ensureCharacter(state, op.character || op.characterId, op.name);
    const field = FIELD_ALIASES[String(op.field ?? '').trim()] || op.field;
    if (!field) throw new Error('set: 缺少 field');
    // status / health / objective / situation 已从台账移除。
    if (field === 'status') throw new Error('不记录 status 字段');
    if (field === 'health') throw new Error('不记录 health（伤势）字段');
    if (field === 'objective') throw new Error('不记录 objective（目标）字段');
    if (field === 'situation') throw new Error('不记录 situation（局势）字段');
    // 地点已经是 scene.place 的职责；功法已经是 skills 的职责，都不再走字段。
    if (field === 'location') throw new Error('地点用 set_scene 的 place，不记 location 字段');
    if (field === 'technique') throw new Error('功法用 add_skill，不记 technique 字段');
    if (STRUCTURAL_FIELDS.has(field)) throw new Error(`${field} 有专用 op，不用 set 字段`);
    const owner = state.meta?.protagonistId || PROTAGONIST_ID;
    const isProtagonist = character.id === PROTAGONIST_ID || character.id === owner;
    // NPC 只保留最小档案：性别 + 题材的等级字段；年龄、外貌、名望等都不落账。
    // 调用方没传 npcFields 时保持旧行为（测试脚本与旧数据迁移不必逐个改）。
    const npcFields = Array.isArray(options.npcFields) ? options.npcFields.filter(Boolean) : null;
    if (!isProtagonist && npcFields) {
        const allowed = new Set(['gender', ...npcFields]);
        if (!allowed.has(field)) throw new Error(`NPC 只记性别与等级字段，不记 ${field}`);
    }
    // 进度是主角内景；NPC 再写一次只会让台账多两份互相矛盾的进度。
    if (field === 'progress' && !isProtagonist) throw new Error('不记录 NPC 的境界进度');
    let value;
    if (field === 'gender') {
        value = normalizeGender(op.value);
    } else if (field === 'progress') {
        const next = normalizeProgress(op.value);
        const currentEntry = character.state?.progress;
        const current = Number(currentEntry?.current ?? currentEntry);
        // 进度只增不减；只有同一批里换了境界（突破/跌境）才允许下降或归零。
        if (!options.realmChanging && Number.isFinite(current) && next < current) {
            throw new Error(`境界进度不能从 ${current} 降到 ${next}；突破换境界请同时写 realm`);
        }
        value = next;
    } else {
        value = typeof op.value === 'string' ? playerText(op.value) : op.value;
    }
    // 玩家主权：灵根/体质/身世等身份字段只允许首次记录，不能覆盖已写出的内容。
    if (isProtagonist && PLAYER_IDENTITY_FIELDS.has(field)) {
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
    const creating = entry.current === null || entry.current === undefined;
    if (!Array.isArray(entry.history)) entry.history = [];

    // Repeating the same value (e.g. seeding from the character card every turn)
    // must not grow the dual-temporal history.
    if (entry.current !== null && entry.current !== undefined
        && String(entry.current) === String(value)
        && op.access === undefined) {
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
    // 灵根/体质/境界进度新建时默认主角级；姓名默认好友级；其余公开。
    const fallbackAccess = isProtagonist
        ? (SECRET_IDENTITY_FIELDS.has(field)
            ? 'protagonist'
            : (field === 'name' ? 'friend' : 'public'))
        : 'public';
    if (op.access !== undefined) {
        entry.access = explicitAccess(op.access, entityAccess(entry, fallbackAccess));
    } else if (entry.access === undefined && creating) {
        entry.access = fallbackAccess;
    }
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
    // 只给 id 时沿用台账里已有的显示名，别把 i_xxx 这类内部键写进正文。
    const displayName = raw.name || character.items.find((item) => item.id === id && item.validTo == null)?.name || name;
    const from = validFromOf(op, state);
    const quantity = Number(raw.quantity ?? op.quantity ?? 1);
    const safeQuantity = Number.isFinite(quantity) ? quantity : 1;
    const unit = raw.unit || op.unit || '';
    const kind = raw.kind || op.kind || 'item';
    const merge = raw.merge === true || op.merge === true || kind === 'currency';
    const accessGiven = raw.access !== undefined || op.access !== undefined;
    const quantityGiven = raw.quantity !== undefined || op.quantity !== undefined;
    const kindGiven = raw.kind !== undefined || op.kind !== undefined;
    // 货币没有默认 1：先 add_item 占位再 adjust 会凭空多出 1 点。
    if (kind === 'currency' && !quantityGiven && !accessGiven) {
        throw new Error('add_item: 货币要写明数量，或改用 adjust_item 从 0 开始增减');
    }

    // 只改档位：沿用旧记录，避免把数量重置成 1、丢掉 beliefs。
    if (!quantityGiven && accessGiven) {
        const existing = character.items.find((item) => item.id === id && item.validTo == null);
        if (existing) {
            existing.access = explicitAccess(raw.access ?? op.access, entityAccess(existing, 'public'));
            if (raw.name) existing.name = raw.name;
            if (unit) existing.unit = unit;
            if (kindGiven) existing.kind = kind;
            character.updatedAt = new Date().toISOString();
            return character;
        }
    }

    if (merge) {
        const existing = character.items.find((item) => item.id === id && item.validTo == null);
        if (existing) {
            existing.quantity = Number(existing.quantity ?? 1) + safeQuantity;
            if (unit) existing.unit = unit;
            if (kind) existing.kind = kind;
            if (raw.access ?? op.access) existing.access = explicitAccess(raw.access ?? op.access, entityAccess(existing, 'public'));
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
        name: displayName,
        holder: raw.holder || character.id,
        quantity: safeQuantity,
        unit,
        kind,
        validFrom: from,
        validTo: null,
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
    // 物品本来就在这个人手上：不要为了「转手给他」把旧记录关掉再开一条。
    const alreadyHeld = (state.characters[to]?.items || [])
        .find((item) => (item.id === itemId || item.name === itemId) && item.validTo == null);
    if (alreadyHeld) return state.characters[to];
    let template = null;
    for (const character of Object.values(state.characters)) {
        for (const item of character.items) {
            if ((item.id === itemId || item.name === itemId) && item.validTo == null) {
                template = item;
                item.validTo = from;
            }
        }
    }
    if (!template) throw new Error(`move_item: 找不到物品 ${itemId}`);
    const wasGated = !isPublicEntity(template);
    const holder = ensureCharacter(state, to, op.toName);
    // 物品到了谁手里，谁就必然知道；但公开级持有人不等于全城都知道。
    // 原档位更宽（如主角级）时只向持有人所在档放宽，公开级则保持原档位。
    const inherited = entityAccess(template, 'public');
    const holderTier = characterAccess(holder);
    const access = !wasGated
        ? inherited
        : (holderTier === 'public'
            ? inherited
            : (ACCESS_RANK[inherited] > ACCESS_RANK[holderTier] ? holderTier : inherited));
    holder.items.push({
        id: template.id || itemId,
        name: op.name || template.name || itemId,
        holder: holder.id,
        quantity: template.quantity ?? 1,
        unit: template.unit || '',
        kind: template.kind || 'item',
        validFrom: from,
        validTo: null,
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
        ? targetCharacter.items.find((entry) => (
            (entry.id === itemId || entry.name === itemId) && entry.validTo == null
        ))
        : findCurrentItem(state, itemId);

    if (!item && targetCharacter) {
        item = {
            id: itemId,
            name: op.itemName || spec?.name || itemId,
            holder: targetCharacter.id,
            quantity: 0,
            unit: op.unit || spec?.unit || '',
            kind: op.kind || spec?.kind || 'item',
            validFrom: validFromOf(op, state),
            validTo: null,
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
            if ((item.id === itemId || item.name === itemId) && item.validTo == null) {
                item.validTo = from;
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
            // kinds 只限定要清哪些类；货币还要另外声明 includeCurrency 才一起清。
            const matches = kinds
                ? kinds.includes(kind) || (includeCurrency && kind === 'currency')
                : (kind !== 'currency' || includeCurrency);
            if (!matches) continue;

            if (kind === 'currency') {
                item.quantity = 0;
            } else {
                item.validTo = from;
            }
            count += 1;
        }
    }
    return count;
}

/** 清空货币：写 item 只清这一种（贡献点/灵石）；不写才清全部。 */
function clearCurrency(state, op) {
    const { id: currencyId } = itemArg(op);
    const targetId = op.character || op.characterId;
    const targets = targetId
        ? [state.characters[targetId]].filter(Boolean)
        : Object.values(state.characters);
    let count = 0;
    for (const character of targets) {
        for (const item of character.items || []) {
            if (item.validTo != null || (item.kind || 'item') !== 'currency') continue;
            if (currencyId && item.id !== currencyId && item.name !== currencyId) continue;
            item.quantity = 0;
            count += 1;
        }
    }
    if (currencyId && !count) throw new Error(`clear_currency: 找不到货币 ${currencyId}`);
    return count;
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
        ? state.characters[targetId]?.items?.find((entry) => (
            (entry.id === itemId || entry.name === itemId) && entry.validTo == null
        ))
        : findCurrentItem(state, itemId);
    if (!item) throw new Error(`set_item_quantity: 找不到物品 ${itemId}`);

    item.quantity = quantity;
    return item;
}

/** 这些是状态/来源词，不是功法层次，不能写进 level。 */
const TRAIT_STATE_LEVELS = /^(残缺|破损|古老|上古|家传|祖传|无名|普通|神秘)$/;
/** 篇章、页码、招式编号也不是层次：第一章、头三式、上卷。 */
const TRAIT_NON_LEVEL = /[章节回式页卷篇部招]/;
/** 只有泛称、没有具体名字的功法不建档；载体（玉简/卷轴）加残损状态也不算名字。 */
const GENERIC_SKILL_NAME = /^(?:(?:残缺|破损|古老|上古|家传|祖传|无名|基础|普通|神秘|几卷|一部|一卷|数卷)?(?:功法|法诀|心法|秘籍|残卷|残篇|残页|残本|秘典)|功法(?:残卷|残篇|秘籍)|(?:玉简|卷轴|玉牌|兽皮|古籍|书页)(?:残篇|残卷|残页|残本|残册)?)$/;

function traitLevel(value) {
    const text = String(value ?? '').trim();
    return TRAIT_STATE_LEVELS.test(text) || TRAIT_NON_LEVEL.test(text) ? '' : text;
}

function addTrait(state, op, { field, payload, prefix, defaultType, defaultAccess = 'public', rejectName }, protagonistId = '') {
    const character = ensureCharacter(state, op.character || op.characterId, op.characterName);
    const owner = protagonistId || state.meta?.protagonistId || PROTAGONIST_ID;
    const isProtagonist = character.id === PROTAGONIST_ID || character.id === owner;
    // NPC 只保留最小档案；功法只记主角的，代码层直接拒绝。
    // 旧数据没有 protagonistId 时，允许 tier:"main" 的角色继续沿用，避免开局旧档全部被拒。
    const legacyProtagonist = !state.meta?.protagonistId && character.tier === 'main';
    if (!isProtagonist && !legacyProtagonist) {
        throw new Error('NPC 不单独建功法档案');
    }
    const raw = op[payload] && typeof op[payload] === 'object' ? op[payload] : { name: op[payload] };
    const name = normalizedTraitName(raw.name || raw.id);
    if (!name) throw new Error(`${op.op || 'add_trait'}: 缺少 ${payload}.name`);
    if (rejectName && rejectName.test(name)) {
        throw new Error('功法需要有具体名字，泛称不记');
    }
    const id = raw.id || `${prefix}${slug(name)}`;
    const from = validFromOf(op, state);
    // 重记同一门功法时继承旧版本的可见性，避免秘密被重新登记成公开。
    // 模型有时会给同一条目换一个 id；同名也算同一条，沿用已有 id，避免状态栏出现两份。
    let template = null;
    for (const entry of character[field]) {
        if (entry.validTo != null) continue;
        const sameId = entry.id === id;
        const sameName = normalizedTraitName(entry.name) === name;
        if (!sameId && !sameName) continue;
        if (!template) template = entry;
    }
    const fallbackAccess = typeof defaultAccess === 'function' ? defaultAccess(character) : defaultAccess;
    const access = explicitAccess(
        raw.access ?? op.access,
        template ? entityAccess(template, 'public') : fallbackAccess,
    );
    // 模型重复提取同一门功法时，层次常被省略；沿用旧层次，避免把已记录的层次刷掉。
    const level = traitLevel(raw.level) || (template?.level || '');
    // 值完全没变就不开新版本，否则每轮重复提取都会把历史日志刷满。
    if (template && level === (template.level || '') && access === entityAccess(template, 'public')) {
        return character;
    }
    for (const entry of character[field]) {
        if (entry.validTo != null) continue;
        const sameId = entry.id === id;
        const sameName = normalizedTraitName(entry.name) === name;
        if (sameId || sameName) entry.validTo = from;
    }
    character[field].push({
        id: template?.id || id,
        name,
        type: defaultType,
        level,
        access,
        validFrom: from,
        validTo: null,
        history: [],
    });
    return character;
}

function addSkill(state, op, protagonistId) {
    return addTrait(state, op, {
        field: 'skills',
        payload: 'skill',
        prefix: 'sk_',
        defaultType: 'technique',
        rejectName: GENERIC_SKILL_NAME,
    }, protagonistId);
}

function setTrait(state, op, { field, payload, label }) {
    const traitId = op[payload];
    if (!traitId) throw new Error(`set_${payload}: 缺少 ${payload}`);
    const targetId = op.character || op.characterId;
    const character = targetId
        ? state.characters[targetId]
        : Object.values(state.characters).find((entry) => (
            (entry[field] || []).some((trait) => (trait.id === traitId || trait.name === traitId) && trait.validTo == null)
        ));
    if (!character) throw new Error(`set_${payload}: 找不到角色`);
    const trait = (character[field] || []).find((entry) => (
        (entry.id === traitId || entry.name === traitId) && entry.validTo == null
    ));
    if (!trait) throw new Error(`set_${payload}: 找不到${label} ${traitId}`);

    const beforeLevel = trait.level || '';
    const from = validFromOf(op, state);
    const evidence = evidenceOf(op);
    if (op.level !== undefined) trait.level = traitLevel(op.level);
    if (op.access !== undefined) trait.access = explicitAccess(op.access, entityAccess(trait, 'public'));
    trait.history = Array.isArray(trait.history) ? trait.history : [];
    trait.history.push({
        fromLevel: beforeLevel,
        toLevel: trait.level || '',
        validFrom: from,
        evidence,
    });
    return trait;
}

function setSkill(state, op) {
    return setTrait(state, op, { field: 'skills', payload: 'skill', label: '技能' });
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
            if ((trait.id === traitId || trait.name === traitId) && trait.validTo == null) {
                trait.validTo = validFromOf(op, state);
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

/** 从 evidence（msg:N）里取消息序号，用来判断两份关系哪份更新。 */
function evidenceMessageIndex(relation) {
    const match = /msg:(\d+)/.exec(String(relation?.evidence ?? ''));
    return match ? Number(match[1]) : -1;
}

function relationNewer(candidate, current) {
    const next = evidenceMessageIndex(candidate);
    const prev = evidenceMessageIndex(current);
    if (next < 0) return false;
    if (prev < 0) return true;
    return next > prev;
}

function setRelation(state, op) {
    const pinnedId = state.meta?.protagonistId
        || (state.characters[PROTAGONIST_ID] ? PROTAGONIST_ID : '');
    const fromRef = op.from || op.character;
    const toRef = op.to || op.target;
    if (!fromRef || !toRef) throw new Error('set_relation: 缺少 from/to');
    const resolve = (ref) => {
        const id = resolveCharacterId(state, ref, { create: false });
        return id ? state.characters[id] : null;
    };
    const fromExisting = resolve(fromRef);
    const toExisting = resolve(toRef);
    // 有主角就用主角；旧数据/测试里没有 user 时，把 from 当作关系的主语。
    const owner = state.characters[pinnedId]
        || fromExisting
        || ensureCharacter(state, fromRef, op.fromName);
    if (!Array.isArray(owner.relations)) owner.relations = [];
    const fromIsOwner = fromExisting
        ? fromExisting.id === owner.id
        : String(fromRef) === owner.id;
    const toIsOwner = toExisting
        ? toExisting.id === owner.id
        : String(toRef) === owner.id;
    // 台账只保留主角一侧的关系；NPC 与 NPC 之间不建档。
    if (!fromIsOwner && !toIsOwner) return false;
    const redirected = !fromIsOwner && toIsOwner;
    const npc = redirected
        ? (fromExisting || ensureCharacter(state, fromRef, op.fromName))
        : (toExisting || ensureCharacter(state, toRef, op.toName));
    if (!npc || npc.id === owner.id) return false;
    const targetName = npc.name || (redirected ? op.fromName : op.toName) || npc.id;
    const timestamp = validFromOf(op, state);
    const type = op.type || '';
    const live = owner.relations.find(
        (relation) => (relation.target === npc.id || relation.target === targetName) && relation.validTo == null,
    );
    const sameKind = !live || !type || type === live.type;
    // 同一段关系被重复抽取（类型没变）：不产生新版本。
    if (live && sameKind && op.access === undefined) {
        return false;
    }
    // 只是补/改档位时原地更新，避免每回合关旧开新；关系类型变化才留历史版本。
    if (live && sameKind) {
        if (op.access === undefined) return false;
        const nextAccess = explicitAccess(op.access, entityAccess(live, 'public'));
        if (nextAccess === entityAccess(live, 'public')) return false;
        live.access = nextAccess;
        return true;
    }
    for (const relation of owner.relations) {
        if ((relation.target === npc.id || relation.target === targetName) && relation.validTo == null) {
            relation.validTo = timestamp;
        }
    }
    // 新版本继承旧关系的档位；否则关系一变，秘密同盟就变成公开关系。
    const access = explicitAccess(
        op.access,
        live ? entityAccess(live, 'public') : 'public',
    );
    owner.relations.push({
        target: npc.id,
        targetName,
        type: type || live?.type || '',
        validFrom: timestamp,
        validTo: null,
        evidence: evidenceOf(op),
        confidence: confidenceOf(op),
        access,
    });
    return true;
}

/** 给 NPC 定知情档位：只看知情与信任证据，不看关系称谓。 */
function setCharacterTier(state, op, tierVoteThreshold = 1) {
    const character = ensureCharacter(state, op.character || op.characterId, op.name);
    if (!character) throw new Error('set_tier: 找不到角色');
    if (character.id === PROTAGONIST_ID) return false;
    const current = characterAccess(character);
    const next = explicitAccess(op.access, current);
    if (next === 'protagonist') throw new Error('set_tier: 主角档位只属于玩家');
    if (next === current) return false;

    const reason = String(op.reason ?? '').trim();
    if (!reason) throw new Error('set_tier: 缺少 reason（知情或信任变化的依据）');
    const key = `${current}>${next}`;
    const up = ACCESS_RANK[next] > ACCESS_RANK[current];
    const allowed = up ? TIER_UPGRADE_REASONS[key] : TIER_DOWNGRADE_REASONS[key];
    if (!allowed || !allowed.has(reason)) {
        throw new Error(`set_tier: ${key} 不能用「${reason}」`);
    }

    const day = normalizeDay(state.scene?.day);
    // 档位变化先记票：同一目标在窗口内累计到阈值才真正生效。
    const threshold = Math.max(1, Math.min(5, Math.round(Number(tierVoteThreshold) || 1)));
    const required = Math.max(1, Number(op.votesRequired) || threshold);
    const pending = character.accessPending;
    const sameTarget = pending && pending.target === next
        && (day === null || pending.lastDay === null || day - pending.lastDay <= TIER_VOTE_WINDOW_DAYS);
    const count = sameTarget ? Number(pending.count || 0) + 1 : 1;
    if (required > 1 && count < required) {
        character.accessPending = { target: next, count, lastDay: day, reason };
        op.pendingTier = { from: current, to: next, count, required };
        return false;
    }
    character.accessPending = null;

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
    character.updatedAt = new Date().toISOString();
    return true;
}

/** reveal 的目标实体；找不到时抛出可读错误。 */
function revealTarget(state, op) {
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
    if (op.skill) {
        const trait = findCurrentTrait(state, 'skills', op.skill);
        if (!trait) throw new Error(`reveal: 找不到功法 ${op.skill}`);
        return { entity: trait, label: trait.name };
    }
    throw new Error('reveal: 需要 character+field / item / relation / skill');
}

/** 把条目的档位放宽到「这个人也够格」为止；已经是公开就不动。 */
function lowerAccess(entity, to, state) {
    const current = entityAccess(entity, 'public');
    if (current === 'public') return false;
    const wanted = normalizeAccess(undefined, characterAccess(state.characters?.[to]));
    if (ACCESS_RANK[wanted] < ACCESS_RANK[current]) {
        entity.access = wanted;
        return true;
    }
    return false;
}

function reveal(state, op) {
    const to = op.to;
    if (!to) throw new Error('reveal: 缺少 to');
    const { entity } = revealTarget(state, op);
    if (!state.characters?.[to]) throw new Error(`reveal: 找不到角色 ${to}`);
    // 猜疑与误信不属于档位：只记在这个人身上，不写泄露事件、不改档位。
    if (op.belief || op.suspicion) {
        entity.beliefs = entity.beliefs && typeof entity.beliefs === 'object' ? entity.beliefs : {};
        entity.beliefs[to] = op.belief
            ? { state: 'false_belief', belief: op.belief }
            : { state: 'suspects', suspicion: op.suspicion };
        return false;
    }
    // 被动暴露不降档：目击者是公开级时，只有显式当众公开（access:"public"）才扩散。
    const targetTier = characterAccess(state.characters?.[to]);
    const wantsPublic = String(op.access ?? '').trim().toLowerCase() === 'public';
    if (op.passive) return false;
    if (targetTier === 'public' && !wantsPublic) return false;
    // 知道某件事 = 把条目档位放宽到这个人所在的档位；不允许用显式 access 越权。
    return lowerAccess(entity, to, state);
}

export function validateOp(op, state) {
    if (!op || typeof op !== 'object') return 'op 不是对象';
    const type = op.op;
    if (!type) return '缺少 op 类型';
    const evidence = evidenceOf(op);
    // promote_public 由宿主定期追加，没有对应的消息证据。
    if (type !== 'set_scene' && type !== 'promote_public' && !evidence) {
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
            const next = explicitAccess(op.access, current);
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
        case 'move_item':
            if (!op.item) return 'move_item: 缺少 item';
            if (!op.to && !op.holder) return 'move_item: 缺少 to';
            return '';
        case 'set_relation':
            if (!op.from && !op.character) return 'set_relation: 缺少 from';
            if (!op.to && !op.target) return 'set_relation: 缺少 to';
            return '';
        case 'reveal':
            if (!op.to) return 'reveal: 缺少 to';
            if (!(op.character && op.field) && !op.item && !op.relation && !op.skill) {
                return 'reveal: 需要 character+field / item / relation / skill';
            }
            return '';
        case 'set_scene':
            if (!op.scene && !op.time && !op.place && !op.participants && !(op.field && op.value !== undefined)) {
                return 'set_scene: 缺少 scene';
            }
            return '';
        case 'promote_public':
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
        for (const key of ['character', 'characterId', 'from', 'to']) {
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
        if (op.item && typeof op.item === 'object') {
            op.item = { ...op.item };
            if (op.item.holder !== undefined) {
                op.item.holder = normalizeProtagonistRef(op.item.holder, aliases);
            }
        }
        return op;
    });
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
    for (const key of ['character', 'characterId', 'from', 'to']) {
        if (op[key] !== undefined) {
            const name = key === 'character' || key === 'characterId'
                ? op.name
                : key === 'from'
                    ? op.fromName
                    : key === 'to'
                        ? op.toName
                        : undefined;
            // reveal 的字段宿主必须是已有角色；写错名字不能新建一个角色来放宽秘密。
            // to 也一样：写错名字时宁可拒绝这条 reveal，也不凭空造一个能「知道」的人。
            const id = (key === 'to' || key === 'character') && op.op === 'reveal'
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
    if (op.scene && Array.isArray(op.scene.participants)) {
        op.scene = {
            ...op.scene,
            participants: resolveNameList(op.scene.participants),
        };
    }
    if (Array.isArray(op.participants)) {
        op.participants = resolveNameList(op.participants);
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
        for (const trait of character.skills || []) {
            if (trait.beliefs) trait.beliefs = replaceBeliefs(trait.beliefs);
        }
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
    const owner = state.meta?.protagonistId || PROTAGONIST_ID;
    const toIsProtagonist = to.id === PROTAGONIST_ID || to.id === owner;
    for (const [field, entry] of Object.entries(from.state || {})) {
        if (STRUCTURAL_FIELDS.has(field) || (!toIsProtagonist && field === 'progress')) continue;
        if (!to.state[field]) {
            to.state[field] = entry;
        } else if (entry && typeof entry === 'object' && Array.isArray(entry.history)) {
            to.state[field].history = [...(to.state[field].history || []), ...entry.history];
        }
    }
    for (const key of ['items', 'skills', 'relations']) {
        // 合并进 NPC 时只保留最小档案，别把主角的功法带过去。
        if (!toIsProtagonist && key === 'skills') continue;
        to[key] = [...(to[key] || []), ...(from[key] || [])];
    }
    to.aliases = [...new Set([...(to.aliases || []), ...(from.aliases || []), from.name])];
    to.updatedAt = new Date().toISOString();
    replaceCharacterRef(state, fromId, toId);
    delete state.characters[fromId];
}

export function applyOps(inputState, ops, options = {}) {
    let state = normalizeState(inputState);
    const aliases = Array.isArray(options.protagonistAliases) ? options.protagonistAliases : [];
    const normalizedOps = normalizeProtagonistOps(ops, aliases);
    const validation = validateOps(normalizedOps, state, options);
    const applied = [];
    const changedOps = [];
    const pendingOps = [];
    const failures = [];
    const tierVoteThreshold = Math.max(1, Math.min(5, Math.round(Number(options.tierVoteThreshold) || 1)));
    const protagonistId = options.protagonistId || state.meta?.protagonistId || PROTAGONIST_ID;
    // 一次结算里每个角色最多改一档，防止同一轮来回漂移。
    const tierChanged = new Set();

    // 0.5–0.7 只进入待复核，不落账；否则「待复核」等于已经生效。
    const all = [...validation.accepted];
    // set_scene 的在场者先建档，reveal.to 才能指向同一轮新出场的人。
    for (const op of all) {
        if (op.op !== 'set_scene') continue;
        const people = op.scene && Array.isArray(op.scene.participants) ? op.scene.participants : op.participants;
        for (const name of Array.isArray(people) ? people : []) ensureCharacter(state, name);
    }
    const knownCharacters = new Set(Object.keys(state.characters));
    // 其余 op 先解析：同一轮才出场的人由 relations/字段先建档，reveal 才能指到他。
    for (const op of all) {
        if (op.op !== 'reveal') resolveOpRefs(state, op);
    }
    for (const op of all) {
        if (op.op === 'reveal') resolveOpRefs(state, op);
    }
    const createdIds = Object.keys(state.characters).filter((id) => !knownCharacters.has(id));
    // 先落场景（长期无往来要看今天的同场），再定档（同一轮的 reveal 要按对方的新档位判断），其余保持原顺序。
    const opPriority = (op) => {
        if (op.op === 'set_scene') return 0;
        return op.op === 'set_tier' ? 1 : 2;
    };
    const ordered = all
        .map((op, index) => ({ op, index }))
        .sort((a, b) => opPriority(a.op) - opPriority(b.op) || a.index - b.index)
        .map((item) => item.op);
    // 突破换境界时模型常忘记把进度归零；先记下每个人的旧境界，结算末尾兜底。
    const realmBeforeById = new Map(
        Object.entries(state.characters).map(([id, character]) => [id, currentField(character, 'realm')]),
    );
    const progressGiven = new Set();
    // 同一批里写 realm 的引用：突破/跌境允许进度下降，其余情况进度只增不减。
    const canonicalRef = (value) => (
        resolveCharacterId(state, value, { create: false }) || String(value ?? '').trim()
    );
    const realmChangingRefs = new Set();
    for (const op of ordered) {
        if (op.op !== 'set') continue;
        const field = FIELD_ALIASES[String(op.field ?? '').trim()] || op.field;
        if (field !== 'realm') continue;
        const ref = canonicalRef(op.character || op.characterId);
        if (ref) realmChangingRefs.add(ref);
    }
    for (const op of ordered) {
        try {
            switch (op.op) {
                case 'rename_character':
                    renameCharacter(state, op);
                    break;
                case 'merge_character':
                    mergeCharacter(state, op);
                    break;
                case 'set': {
                    const ref = canonicalRef(op.character || op.characterId);
                    setField(state, op, {
                        npcFields: options.npcFields,
                        realmChanging: realmChangingRefs.has(ref),
                    });
                    break;
                }
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
                    addSkill(state, op, protagonistId);
                    break;
                case 'set_skill':
                    setSkill(state, op);
                    break;
                case 'remove_skill':
                    removeSkill(state, op);
                    break;
                case 'move_item':
                    moveItem(state, op);
                    break;
                case 'set_relation':
                    if (setRelation(state, op)) changedOps.push(op);
                    break;
                case 'set_tier': {
                    const key = op.character || op.characterId;
                    if (key && tierChanged.has(key)) {
                        throw new Error('set_tier: 本次结算每个角色只能改一档');
                    }
                    if (op.votesRequired === undefined) op.votesRequired = tierVoteThreshold;
                    if (key) tierChanged.add(key);
                    if (setCharacterTier(state, op, tierVoteThreshold)) changedOps.push(op);
                    else if (op.pendingTier) pendingOps.push(op);
                    break;
                }
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
                        time: scene.time || state.scene.time || '',
                        // advance 由代码累加；没给时沿用旧值，时间只前进。
                        day: resolveSceneDay(state.scene.day, scene) ?? state.scene.day ?? null,
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
                case 'promote_public':
                    // 定期上调由宿主在结算时追加；回放时按同一条 op 复原。
                    promotePublicEntries(state, protagonistId);
                    break;
                default:
                    throw new Error(`未知 op 类型：${op.op}`);
            }
            applied.push(op);
            if (op.op === 'set' && (FIELD_ALIASES[String(op.field ?? '').trim()] || op.field) === 'progress') {
                progressGiven.add(op.character);
            }
        } catch (err) {
            failures.push({ op, reason: err.message });
        }
    }

    // 换境界且本轮没写进度：补一条 0，避免「筑基初期 90%」这种跨境界的旧进度。
    const protagonistIds = new Set([PROTAGONIST_ID, state.meta?.protagonistId].filter(Boolean));
    for (const [id, realmBefore] of realmBeforeById) {
        if (!protagonistIds.has(id) || progressGiven.has(id)) continue;
        const character = state.characters[id];
        const realmAfter = currentField(character, 'realm');
        // 只多了空白不算换境界，别因此把进度清掉。
        if (!realmBefore || !realmAfter || String(realmBefore).trim() === String(realmAfter).trim()) continue;
        const progress = character?.state?.progress;
        if (!progress || progress.current === null || progress.current === undefined) continue;
        if (Number(progress.current) === 0) continue;
        try {
            setField(state, {
                op: 'set',
                character: id,
                field: 'progress',
                value: 0,
                evidence: '',
                confidence: 1,
            }, { realmChanging: true });
        } catch {
            // 补写失败不影响本轮其它结果。
        }
    }

    // 被拒的 op 可能在抛错前先建了角色档案；只清掉本轮新建、且没有任何内容的空壳。
    for (const id of createdIds) {
        const character = state.characters[id];
        if (character && isEmptyCharacter(state, character)) delete state.characters[id];
    }

    return {
        state,
        applied,
        changedOps,
        pendingOps,
        review: validation.review,
        rejected: [...validation.rejected, ...failures],
    };
}

function currentField(character, field) {
    const entry = character?.state?.[field];
    if (!entry) return '';
    return entry.current ?? entry ?? '';
}

/** 本轮新建但没有任何记录的角色：多半是被拒 op 留下的空壳。 */
function isEmptyCharacter(state, character) {
    if (character.id === PROTAGONIST_ID || character.id === state.meta?.protagonistId) return false;
    const onStage = (state.scene?.participants || []).some((ref) => (
        ref === character.id || ref === character.name
    ));
    if (onStage) return false;
    // 被别人写进关系里的人不能删，否则下一轮会重新分配 id，关系就对不上。
    const referenced = Object.values(state.characters).some((other) => (
        other !== character && (other.relations || []).some((relation) => (
            relation.target === character.id
            || (character.name && relation.targetName === character.name)
        ))
    ));
    if (referenced) return false;
    // 档位变化本身就是一条信息，不能因为没写其他字段就当空壳删掉。
    if (character.access && character.access !== 'public') return false;
    if (character.accessChangedFrom || character.accessPending) return false;
    if (Object.keys(character.state || {}).length) return false;
    return ['items', 'relations', 'skills']
        .every((field) => !(character[field] || []).length);
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

function formatItem(item) {
    const quantity = Number(item.quantity ?? 1);
    const unit = item.unit || '';
    if (item.kind === 'currency' || quantity !== 1) {
        return `${item.name}×${quantity}${unit}`;
    }
    return item.name;
}

function orderedStateFields(character, fieldOrder = []) {
    const keys = Object.keys(character?.state || {});
    // 与状态栏保持同一顺序：性别、年龄、外貌在前，其余按题材顺序。
    const preferred = ['gender', 'age', 'appearance'];
    const ordered = [];
    for (const field of [...preferred, ...fieldOrder.filter((item) => !preferred.includes(item))]) {
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
const BLOCK_CAPS = { items: 15, skills: 8, relations: 10 };

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
        // 主角姓名单独放在第一位，不再按普通字段排序。
        .filter((field) => !(isProtagonist && field === 'name'))
        // progress 只以「只有主角知道」的形式出现。
        .filter((field) => (field === 'progress' ? isProtagonist : visible(character.state[field])))
        .map((field) => {
            const value = currentField(character, field);
            // 0 是合法值（境界进度刚重置），不能当空值丢掉。
            if (value === '' || value === null || value === undefined) return '';
            const entry = character.state[field];
            const gate = options.knowledgeGate === false
                ? ''
                : (field === 'progress'
                    ? '（只有你知道）'
                    : (!isProtagonist && !isPublicEntity(entry) ? knowledgeTag(entry, options.state) : ''));
            // 注入给中文叙事模型，字段名用题材预设里的中文标签。
            const label = options.fieldLabels?.[field] || field;
            // progress 是 0-100 的刻度，标出满分，免得叙事者把它当等级。
            return `${label}：${value}${field === 'progress' ? '/100' : ''}${gate}`;
        })
        .filter(Boolean);
    // 主角姓名排在最前：优先台账里记下的 name，其次用酒馆 persona 名。
    const protagonistName = isProtagonist
        ? String(currentField(character, 'name') || options.protagonistName || '').trim()
        : '';
    if (protagonistName) {
        const nameEntry = character.state?.name;
        const nameGate = options.knowledgeGate === false || !nameEntry || isPublicEntity(nameEntry)
            ? ''
            : knowledgeTag(nameEntry, options.state);
        fields.unshift(`${options.fieldLabels?.name || '姓名'}：${protagonistName}${nameGate}`);
    }
    const allItems = isProtagonist
        ? currentItems(character)
            .filter(visible)
            .filter((item) => Number(item.quantity ?? 1) > 0)
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
        const target = relation.targetName || relation.target;
        return relation.type ? `${target}(${relation.type})` : target;
    });
    const allSkills = isProtagonist ? currentSkills(character).filter(visible) : [];
    const shownSkills = recallFirst(allSkills, (skill) => skill.name).slice(0, BLOCK_CAPS.skills);
    const hiddenSkills = allSkills.length - shownSkills.length;
    const skills = shownSkills.map((skill) => `${skill.name}${skill.level ? `(${skill.level})` : ''}`);
    const suffix = (hidden) => (hidden > 0 ? `（另有 ${hidden} 项）` : '');
    // 角色标题后直接给知情档位：内部重要性层级对叙事没用，档位才决定谁能知道秘密。
    const access = isProtagonist ? 'protagonist' : characterAccess(character);
    const accessLabel = options.knowledgeGate === false ? '' : (ACCESS_LABELS[access] || '');
    const lines = [`【角色·${character.name || character.id}】${accessLabel}`];
    if (fields.length) lines.push(fields.join(' | '));
    if (shownItems.length) lines.push(`物品：${shownItems.map(formatItem).join('、')}${suffix(hiddenItems)}`);
    if (skills.length) lines.push(`${options.skillLabel || '技能'}：${skills.join('、')}${suffix(hiddenSkills)}`);
    if (relations.length) lines.push(`关系：${relations.join('、')}${suffix(hiddenRelations)}`);
    return lines.join('\n');
}

function collectGatedEntities(state, protagonistId = '', fieldLabels = {}, labels = {}) {
    const entries = [];
    for (const character of Object.values(state.characters)) {
        // Only the protagonist's own records can be secrets; NPC self-description is public.
        if (character.id !== protagonistId) continue;
        for (const [field, entry] of Object.entries(character.state || {})) {
            if (isPublicEntity(entry)) continue;
            // 注入与面板都面向中文，字段名用题材预设里的中文标签。
            const label = fieldLabels?.[field] || field;
            entries.push({
                key: `field:${character.id}:${field}`,
                type: 'field',
                ownerId: character.id,
                field,
                text: `${character.name || character.id} · ${label}：${currentField(character, field)}`,
                entity: entry,
            });
        }
        for (const item of (character.items || []).filter((item) => (
            item.validTo == null
            && !isPublicEntity(item)
            && Number(item.quantity ?? 1) > 0
        ))) {
            entries.push({
                key: `item:${item.id}`,
                type: 'item',
                ownerId: character.id,
                text: `${character.name || character.id} 持有 ${formatItem(item)}`,
                entity: item,
            });
        }
        for (const relation of (character.relations || []).filter((relation) => relation.validTo == null && !isPublicEntity(relation))) {
            entries.push({
                key: `relation:${character.id}:${relation.target}`,
                type: 'relation',
                ownerId: character.id,
                text: `${character.name || character.id} → ${relation.targetName || relation.target}：${relation.type || '关系'}`,
                entity: relation,
            });
        }
        for (const skill of (character.skills || []).filter((skill) => skill.validTo == null && !isPublicEntity(skill))) {
            entries.push({
                key: `skill:${character.id}:${skill.id}`,
                type: 'skill',
                ownerId: character.id,
                text: `${character.name || character.id} ${labels.skillLabel || '技能'}「${skill.name}」${skill.level ? `（${skill.level}）` : ''}`,
                entity: skill,
            });
        }
    }
    return entries;
}

function joinNames(names) {
    if (names.length <= 6) return names.join('、');
    return `${names.slice(0, 6).join('、')}等${names.length}人`;
}

/**
 * One line per secret: who knows, who does not, and who believes what.
 * Scales with the number of secrets instead of characters × secrets.
 */
function secretBlock(state, activeIds, protagonistId = '', fieldLabels = {}, labels = {}) {
    const lines = [];
    for (const entry of collectGatedEntities(state, protagonistId, fieldLabels, labels)) {
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
        const parts = access === 'protagonist'
            ? ['主角级', '只有你知道']
            : [`${ACCESS_LABELS[access] || access}`, `默认知情=${known.length ? joinNames(known) : '无'}`];
        if (access !== 'protagonist' && unaware.length) parts.push(`默认不知情=${joinNames(unaware)}`);
        if (suspects.length) parts.push(`怀疑=${joinNames(suspects)}`);
        parts.push(...beliefs);
        lines.push(`- ${entry.text} ｜ ${parts.join('；')}`);
    }
    return lines.length ? `【秘密知情】\n${lines.join('\n')}` : '';
}

export function assembleInjection(inputState, options = {}) {
    const state = normalizeState(inputState);
    const tokenBudget = Number(options.tokenBudget ?? 3000);
    const knowledgeGate = options.knowledgeGate !== false;
    const recentText = String(options.recentText ?? '');
    const fieldOrder = Array.isArray(options.fieldOrder) ? options.fieldOrder : [];
    const fieldLabels = options.fieldLabels && typeof options.fieldLabels === 'object' ? options.fieldLabels : {};
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

    const header = knowledgeGate
        ? [
            '【事实台账】以下是角色与世界的真相，只用于判断谁知道；不要在正文里替角色说破秘密。',
            '【知情】先看正文：正文写明谁不知道，就按不知道；写明谁知道，就按知道。不要用台账反驳正文。',
            '正文没写才看台账：角色名后的档位、【秘密知情】每行的档位，都是默认可知情范围——公开级=人人可知，朋友级=朋友及交情更深的人可知，亲密级=只有最信任的人可知，主角级=只有你知道；实际谁已经知道，以「默认知情 / 默认不知情」名单为准。',
            '在场、看到，不等于知情；正文没提他不知道，也不等于他知道；反复提到某条秘密，也不等于它已经公开。',
        ].join('\n')
        : '【事实台账】知情约束已关闭：只按正文写，不要据此推断谁知道。';

    const sceneLine = [
        sceneTimeLabel(scene) ? `时间：${sceneTimeLabel(scene)}` : '',
        scene.place ? `地点：${scene.place}` : '',
        activeIds.length ? `在场：${activeIds.map((id) => state.characters[id]?.name || id).join('、')}` : '',
    ].filter(Boolean).join('｜');

    const protagonistId = resolveCharacterId(state, options.protagonistId ?? state.meta?.protagonistId, { create: false }) || '';
    // 酒馆默认 persona 名只是占位符，不能当成故事里的姓名。
    const personaName = isPlaceholderPersonaName(options.protagonistName)
        ? ''
        : String(options.protagonistName ?? '').trim();
    const activeBlocks = activeIds.map((id) => characterBlock(state.characters[id], fieldOrder, {
        isProtagonist: id === protagonistId,
        protagonistId,
        skillLabel: options.skillLabel,
        fieldLabels,
        knowledgeGate,
        recentText,
        protagonistName: personaName,
        state,
    }))
        // 只有名字（还带着档位）却没有任何状态的角色，多半是旁白里的临时描述或路人，不占注入。
        .filter((block) => block.includes('\n'));
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
        ? secretBlock(state, activeIds, protagonistId, fieldLabels, {
            skillLabel: options.skillLabel,
        })
        : '';

    const build = (parts) => parts.filter(Boolean).join('\n\n');

    let sections = {
        header,
        scene: sceneLine ? `【场景】${sceneLine}` : '',
        characters: activeBlocks.join('\n\n'),
        others,
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
    text = build([header, sections.scene, secrets]);
    if (estimateTokens(text) <= tokenBudget) return text;
    text = build([header, secrets]);
    if (estimateTokens(text) <= tokenBudget) return text;
    // 预算还超时按行裁剪秘密清单，宁可少列几条，也不能整块超预算塞进去。
    const secretHeader = '【秘密知情】：未列名者默认不知情';
    const secretLines = String(secrets || '')
        .split('\n')
        .filter((line) => line.trim())
        // secretBlock 自带一行标题，这里已经补了表头，别重复。
        .filter((line) => line.trim() !== '【秘密知情】');
    for (let keep = secretLines.length; keep >= 0; keep -= 1) {
        const candidate = build([secretHeader, secretLines.slice(0, keep).join('\n')]);
        if (estimateTokens(candidate) <= tokenBudget) return candidate;
    }
    return secretHeader;
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

// 对话边界：只认成对的引号。单引号、‘ ’ 在中文里多用于强调，不算对话。
const DIALOGUE_PAIRS = [
    ['「', '」'],
    ['『', '』'],
    ['“', '”'],
    ['＂', '＂'],
    ['"', '"'],
    ['｢', '｣'],
];

/**
 * 只取正文里的对话片段。没闭合的引号取到本行结尾，避免把后面整段旁白当成台词。
 */
export function extractDialogue(source) {
    const text = String(source ?? '');
    const parts = [];
    let index = 0;
    while (index < text.length) {
        let open = -1;
        let pair = null;
        for (const candidate of DIALOGUE_PAIRS) {
            const at = text.indexOf(candidate[0], index);
            if (at < 0) continue;
            if (open < 0 || at < open) {
                open = at;
                pair = candidate;
            }
        }
        if (open < 0) break;
        const start = open + pair[0].length;
        const close = text.indexOf(pair[1], start);
        const lineEnd = text.indexOf('\n', start);
        const end = close >= 0 ? close : (lineEnd < 0 ? text.length : lineEnd);
        const segment = text.slice(start, end).trim();
        if (segment) parts.push(segment);
        // 没闭合时从行尾继续，防止后面的引号被误当成新台词。
        index = close >= 0 ? close + pair[1].length : end;
    }
    return parts;
}

/** 去掉空白与常见标点后再比整值，避免「残缺符文的玉牌」被引号或逗号拆开就漏掉。 */
function compactText(source) {
    return String(source ?? '').replace(/[\s，,。.、；;：:！!？?“”"「」『』（）()《》〈〉—－\-~～…]/g, '');
}

/**
 * 对话里是否真的提到了某个秘密。判定从宽：
 * 整值命中即可；值超过两字时，只认 ≥3 字的连续片段，避免「灵根」这类泛词误报；
 * 两字条目（玉牌、灵石）仍要求整名命中。
 */
function dialogueMentions(source, dialogue) {
    const haystack = String(dialogue ?? '');
    const value = String(source ?? '').trim();
    if (!value || !haystack) return false;
    if (value.length <= 2) return haystack.includes(value);
    if (compactText(haystack).includes(compactText(value))) return true;
    for (const token of textTokens(value)) {
        if ([...token].length < 3) continue;
        if (haystack.includes(token)) return true;
    }
    return false;
}

/**
 * 可能被说破的受控条目：主角的字段/物品/关系/功法。
 * 角色身上的条目没有对应的 reveal 目标，暂不参与泄露检测。
 */
function leakCandidates(state, fieldLabels = {}, labels = {}) {
    const protagonistId = state.meta?.protagonistId || PROTAGONIST_ID;
    const list = [];
    for (const entry of collectGatedEntities(state, protagonistId, fieldLabels, labels)) {
        const entity = entry.entity;
        if (entry.type === 'field') {
            const owner = state.characters?.[entry.ownerId];
            const value = currentField(owner, entry.field);
            if (!value) continue;
            const label = fieldLabels?.[entry.field] || entry.field;
            list.push({
                entity,
                source: String(value),
                label: `${owner?.name || entry.ownerId} · ${label}：${value}`,
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
            list.push({ entity, source: name, label: `${labels.skillLabel || '技能'} ${name}`, target: { skill: name } });
        }
    }
    return list;
}

export function detectLeaks(inputState, text, activeCharacterIds = [], fieldLabels = {}, labels = {}) {
    const state = normalizeState(inputState);
    const protagonistId = state.meta?.protagonistId || PROTAGONIST_ID;
    const mentioned = leakCandidates(state, fieldLabels, labels);
    // 只扫对话：旁白、内心独白里提到秘密不算 NPC 知道，避免开场设定被误判。
    const dialogues = extractDialogue(text);
    if (!dialogues.length) return [];
    const active = activeCharacterIds.length
        ? activeCharacterIds
            .map((id) => resolveCharacterId(state, id, { create: false }) || id)
            .filter(Boolean)
        : Object.values(state.characters)
            .filter((character) => character.id !== protagonistId)
            .map((character) => character.id);
    const leaks = [];
    for (const candidate of mentioned) {
        const quote = dialogues.find((segment) => dialogueMentions(candidate.source, segment));
        if (!quote) continue;
        for (const id of active) {
            if (!knowsEntity(candidate.entity, id, state, 'protagonist')) {
                leaks.push({
                    character: id,
                    characterName: state.characters[id]?.name || id,
                    target: candidate.target,
                    label: candidate.label,
                    quote: quote.slice(0, 160),
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
 * 记录是否对应当前聊天里的这一条。
 * 新记录只看单条正文锚点，编辑别的消息不会连坐；旧记录没有 anchor 时退回整段前缀哈希。
 */
export function recordMatchesChat(record, chat, hashes = computePrefixHashes(chat)) {
    const list = Array.isArray(chat) ? chat : [];
    const to = Number(record?.to);
    if (!Number.isFinite(to) || to < 0 || to >= list.length) return false;
    if (record.anchor) return record.anchor === messageHash(list[to]);
    return Boolean(record.prefixHash) && record.prefixHash === hashes[to];
}

/** 给还能对上的旧记录补单条锚点，避免以后编辑其它消息时把它们一起判失效。 */
export function backfillAnchors(history, chat) {
    const records = Array.isArray(history) ? history : [];
    const list = Array.isArray(chat) ? chat : [];
    const hashes = computePrefixHashes(list);
    let changed = 0;
    for (const record of records) {
        if (!record || record.anchor) continue;
        const to = Number(record?.to);
        if (!Number.isFinite(to) || to < 0 || to >= list.length) continue;
        if (record.prefixHash && record.prefixHash === hashes[to]) {
            record.anchor = messageHash(list[to]);
            changed += 1;
        }
    }
    return changed;
}

/**
 * Find the newest history record whose chat prefix still matches the current chat.
 */
export function findReplayPoint(history, chat) {
    const records = Array.isArray(history) ? history : [];
    const hashes = computePrefixHashes(chat);
    for (let i = records.length - 1; i >= 0; i -= 1) {
        const record = records[i];
        if (recordMatchesChat(record, chat, hashes)) {
            return { index: Number(record.to), record };
        }
    }
    return { index: -1, record: null };
}

/**
 * 从多版本历史里挑出与当前正文匹配的那一条分支。
 * 同一消息序号的多个 swipe 各留一条记录，只有锚点对得上的那条会进入回放。
 */
export function selectHistoryBranch(history, chat) {
    const records = Array.isArray(history) ? history : [];
    const hashes = computePrefixHashes(chat);
    const chosen = new Map();
    for (const record of records) {
        if (!recordMatchesChat(record, chat, hashes)) continue;
        // 同一分支重复结算时保留最新的一条。
        chosen.set(Number(record.to), record);
    }
    return [...chosen.values()].sort((a, b) => Number(a.to) - Number(b.to));
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
        const result = applyOps(state, rawOps, {
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
    // 没有新消息时不要退化成「只带上下文」的提取：手动再点一次结算会把同一轮再加一遍。
    if (newFrom >= list.length) {
        return { messages: [], newFrom, to: list.length - 1 };
    }
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

/** 本轮结算涉及的 AI 正文；泄露检测只该看叙事者写了什么，不看玩家消息。 */
export function collectAssistantText(chat, from, to) {
    const list = Array.isArray(chat) ? chat : [];
    if (!list.length) return '';
    const start = Math.max(0, Math.min(list.length - 1, Number(from ?? 0) || 0));
    const end = Math.max(start, Math.min(list.length - 1, Number(to ?? list.length - 1)));
    const parts = [];
    for (let i = start; i <= end; i += 1) {
        const message = list[i];
        if (!message || message.is_user) continue;
        const text = String(message.mes ?? '').trim();
        if (text) parts.push(text);
    }
    return parts.join('\n');
}

/**
 * Compact view for the extraction prompt: current values only. History arrays,
 * evidence and timestamps are useless to the extractor and dominate long chats.
 */
function compactStateForPrompt(state) {
    // ID 只留在代码里；给提取模型看的键一律换成名字。
    const display = (id) => (id === PROTAGONIST_ID ? PROTAGONIST_NAME : (state.characters?.[id]?.name || id));
    const characters = {};
    for (const [id, character] of Object.entries(state.characters || {})) {
        const fields = {};
        const fieldAccess = {};
        for (const [field, entry] of Object.entries(character.state || {})) {
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
                level: skill.level,
                ...(entityAccess(skill, 'public') !== 'public' ? { access: entityAccess(skill, 'public') } : {}),
            }));
        const relations = (character.relations || [])
            .filter((relation) => relation.validTo == null)
            .map((relation) => ({
                target: relation.targetName || display(relation.target),
                type: relation.type,
                ...(entityAccess(relation, 'public') !== 'public' ? { access: entityAccess(relation, 'public') } : {}),
            }));
        let key = id === PROTAGONIST_ID ? PROTAGONIST_ID : (character.name || id);
        let suffix = 2;
        while (characters[key]) key = `${character.name || id}#${suffix++}`;
        characters[key] = {
            access: characterAccess(character),
            ...(Array.isArray(character.aliases) && character.aliases.some((alias) => alias && alias !== character.name)
                ? { aliases: character.aliases.filter((alias) => alias && alias !== character.name) }
                : {}),
            ...(character.accessReason ? {
                accessReason: character.accessReason,
                accessChangedDay: character.accessChangedDay ?? null,
            } : {}),
            state: fields,
            ...(Object.keys(fieldAccess).length ? { fieldAccess } : {}),
            ...(items.length ? { items } : {}),
            ...(skills.length ? { skills } : {}),
            ...(relations.length ? { relations } : {}),
        };
    }
    return {
        characters,
        scene: {
            time: state.scene.time,
            day: state.scene.day,
            place: state.scene.place,
            participants: (state.scene.participants || []).map(display),
        },
    };
}

/**
 * 在场角色 + 近期改过名的角色的紧凑名录。
 * 提取模型看整份台账时常常认不出「苏绾」就是「月白长裙女修」，这里单独列一遍旧名。
 */
function characterRoster(state) {
    const inScene = new Set(state.scene?.participants || []);
    const ids = new Set(inScene);
    const today = Number(state.scene?.day);
    for (const person of Object.values(state.characters || {})) {
        // 只有带别名（改过名）且近期还在场的临时名才值得占提示词；否则名录会无限变长。
        if (!person.aliases?.length) continue;
        const seen = Number(person.lastSeenDay);
        if (Number.isFinite(today) && Number.isFinite(seen) && today - seen <= 3) ids.add(person.id);
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
    const maxMessages = Number(options.maxMessages ?? 20);
    const newFrom = Number(options.newFrom ?? -1);
    const genreHint = String(options.genreHint ?? '').trim();
    // 技能/功法的叫法由题材预设提供。
    const skillLabel = String(options.skillLabel ?? '').trim() || '技能';
    // 题材额外允许 NPC 记的档案字段（修仙的宗门），没定义就不提。
    const npcExtraLabels = Array.isArray(options.npcExtraFieldLabels)
        ? options.npcExtraFieldLabels.map((label) => String(label ?? '').trim()).filter(Boolean)
        : [];
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
        '输出：{"protagonist":"user","scene":{"time","advance","place","participants"},"ops":[...]}',
        '',
        '【角色】',
        '- 新角色用中文姓名，不要拼音 id；台账已有的角色必须复用同一姓名（苏姑娘、师妹都写苏绾）。',
        '- 台账里已有的角色一律写姓名，不要写内部 id；不要换一个写法新建第二个档案。',
        '- 没有 add_character 这个 op：与主角直接对话的新角色，直接写进 set_scene 的 participants 建档，或在 set / set_relation 里第一次出现；旁白提到的路人不建。不要发明 op 类型，未知 op 会被整条丢弃。',
        '- 姓名揭示：如果台账里已有这个人的临时名或描述名，写 rename_character {from:"临时名",to:"正式名"}，不要新建。',
        '- 例：台账有「白玉广场执事甲」，旁白说「台上那个姓周，叫周显」→ rename_character {from:"白玉广场执事甲",to:"周显"}；不要新建「周显」，也不要同时写 set 把新名字当角色。',
        '- 例：台账有「月白长裙女修」，她自报「我姓苏，单名一个绾字」→ rename_character {from:"月白长裙女修",to:"苏绾"}。',
        '- 旁白或对话里说出某个在场角色的正式姓名时，先判断说的是不是台账里已有的临时名；是就改名，不是才新建。',
        '- 同一条回复里，同一个人只能留一个条目：不要同时写「月白长裙女修」和「苏绾」，也不要同时写「执事甲」和「周执事」。',
        '- 姓+职位（周执事、苏掌柜、王队长）是称呼不是姓名：先对照【在场角色】，若指其中某人，不要新建；称呼本身不记台账。只有本人明确说这就是他的名字，才 rename。',
        '- 无名角色用「地点+职位+序号」的临时名，例如「白玉广场执事甲」；只给与主角直接对话过的无名者建临时名。不同地点或不同场景的同职位角色用不同临时名。无法确认是否同一人时新建，不要合并。',
        '- 纯职位、外观（执事、月白长裙女修）只有与主角直接对话过才写进 participants 建档，且不补字段；只是被旁白提到、远处看见的不建。发生长期变化（收钱、结仇、拜师）或玩家主动追问后再补。',
        '- 每个 NPC 都要有 access 档位；知情或信任变化用 set_tier 改（定义见【档位与知情】）。',
        '- 主角永远是 protagonist，不要给 NPC 写 protagonist。',
        `- 物品、${skillLabel}也用故事里的中文名，不要把 id 当 name（不要写 i_xxx、sk_xxx 这类）。`,
        '- 玩家（「你」「我」）的 character 固定写 "user"；不要给玩家起正式姓名，也不要改写或新增其身世。不要把「你/我/玩家/主角」建成角色。',
        '- 称呼不是名字，不能拿称呼建角色；称呼本身不记台账。',
        '- 只记录与主角直接对话的角色：旁白一笔带过的路人、远处围观者、只被提到名字的人，不写进 participants，也不建角色档案。',
        '- 直接对话指该角色对主角说出台词（说/问/答/喊/叫/道），或被主角直接问话并回应；只是同行、旁观、被旁白提到都不算。',
        '- 例：我跟着执事穿过人群 → 执事没开口，不写 participants；旁白写「苏绾正在扫地」但没对主角说话 → 不写 participants；苏绾抬头问「你怎么来了？」→ 写进 participants。',
        '- gender 只有 男/女/未知：主角必须写；角色第一次进入 participants、建档的同一条回复里必须同时写 gender：同一段用「他/她」指代，或出现师兄/师姐、姑娘/小姐等称谓，就据此写 男/女；只有职位、没有线索写 未知，不凭名字猜。后来才发现就补一次。',
        '- 例：NPC 叫你「师兄」→ set user.gender 男；「师妹」→ 女。',
        `- NPC 只保留最小档案：姓名/别名、性别${npcExtraLabels.length ? `、${npcExtraLabels.join('/')}` : ''}、等级字段（境界/职位/军衔）、是否在场；姓名变化只走 rename_character，不要 set 一个 name 字段。不要给 NPC 单独建${skillLabel}、物品或秘密档案；NPC 的招式与装备只写在正文里。只有主角给出、被拿走或与主角直接相关的物品，才记在持有者名下。`,
        '- NPC 不保存自己的关系，也不建 NPC↔NPC 关系。关系统一写在主角→NPC 这一条，只记 type。',
        '',
        '【记录范围】',
        `- 只记四类当前状态：属性、物品/金钱、关系、${skillLabel}。`,
        '- 若【题材与字段约定】定义了 progress：出现该题材定义的进度行为就写 set {character:"user",field:"progress",value}，同一轮只写一条；在旧值基础上至少 +1，不要因为幅度小就不写，有明确成效再按题材说明加大。台账没有旧值时从 0 起算；刚开始就被打断也写 +1。明确的进度行为 confidence 写 0.8 以上。',
        '- 若题材有阶段字段（如境界）：换阶段当轮可以不写 progress，代码会把进度归零；写了就按新阶段的起点写。',
        '- 题材定义的其他状态字段也是当前值：正文出现该字段的明确变化就 set（字段名与含义见【题材与字段约定】）；只是提及、计划、未落地的不写，不要自创题材没定义的字段。',
        `- 只有两种情况写 add_skill：① 正文明确写出${skillLabel}的具体名字（如《青木诀》），且主角在修或已掌握；② 正文明确写主角学到、得到、继承某门${skillLabel}。泛称不算名字：残缺${skillLabel}、几卷${skillLabel}、家传${skillLabel}、无名${skillLabel}、${skillLabel}残卷、基础${skillLabel}；载体和残损状态也不算名字：玉简残篇、卷轴残卷、这枚玉简。`,
        '- level 只写正文明确给出的层次（入门/第X重/小成/大成/圆满）；“残缺/破损/古老”是状态，不是层次；第X章、头三式、第X页/卷 是篇章或招式编号，也不是层次；都不是就省略 level。',
        `- 主角刻意隐瞒的${skillLabel}、物品、秘密关系（隐藏的底牌与同盟）都写 access:"protagonist"。`,
        '- 同一条秘密的档位变化用 reveal 指向原条目（item/relation/skill 或 character+field）；不要为「谁知道」另写一条新条目。',
        '- 关系（秘密同盟、暗中勾结）被第三方得知时，同样用 reveal 的 relation 目标。例：苏绾当面质问你们的旧盟，你承认了 → reveal {relation:"王掌柜",to:"苏绾",method:"当面承认"}。',
        '- 天气、情绪、寒暄、点头、道谢、看了一眼、与状态无关的一次性动作一律不记。',
        '- 事件记忆交给酒馆原生上下文和向量召回：不要写事件条目，也不要把「今天发生了什么」重新抄成台账。只记当前仍然成立的状态；谁接近过你、说过什么、做过什么，都不记。',
        '- set_scene 的 participants 只写当前与主角直接对话的人（主角始终在内）；旁白提到、远处围观、没跟主角说过话的人不写；有人开口再加入。第一轮要给出 scene：用 set_scene，或直接写顶层 scene，不要同时写两种。',
        '- set_relation 只写与主角直接对话的人；旁白一笔带过的路人不建关系。from 固定写 "user"，to 写角色名；不要写 from:角色名、to:"user"。',
        '- time 只写时辰/时段（清晨、午时、黄昏、夜里），不写年月日或季节；日期由 scene.day 推算，没给就沿用原值。',
        '- 时间跳跃用 scene.advance，只写发生了的单位 {years, months, weeks, days}，不要自己换算成天数，也不要写 day：过一夜 {days:1}，一周 {weeks:1}，半个月 {days:15}，N 个月 {months:N}，N 年 {years:N}；一次跳跃可合并多个单位。没有时间跳跃就不写 advance。',
        '- 粒度：属性记字段+当前值；关系记双方+关系+公开程度。',
        '- 亲密/情感进展只写 relation.type，不要另立条目；一时的语气、态度变化不记账。',
        '- relation.type 写该题材的稳定称谓（见【题材与字段约定】的「关系」行），不要把一时的态度、情绪或整句话写进 type。',
        '- 只写正文里明确发生的事，不确定的不写。',
        `- 第一轮把开场白里已经写明的主角背景（家族、身世、随身物，以及有具体名字且主角在修的${skillLabel}）记进台账，不要扩写或补设定。`,
        '',
        '【物品与金钱】',
        '- 货币可以有多条，各自 kind:"currency" + 自己的 unit（如灵石/枚、贡献点/点）；不要把两种货币合并成一条。',
        '- 金钱和消耗品用 quantity 记。新货币第一次出现时用 adjust_item（从 0 起算）或 set_item_quantity 给出余额，不要先 add_item 占位；add_item 货币必须写明 quantity。',
        '- 花费/获得用 adjust_item（delta 正负）；精确设置用 set_item_quantity；失去单件 remove_item，失去一类 clear_items（includeCurrency:true 连钱）；花光某一种货币用 clear_currency {item:"贡献点"}，不写 item 才是清空所有货币。',
        '- 物品转手用 move_item，不要先删再建。',
        '- 首次给出一件物品的数量时先 add_item（写明 quantity）；货币例外：用 adjust_item 或 set_item_quantity 从 0 起算，不要 add_item 占位。',
        `- ${skillLabel}用 add_skill / set_skill / remove_skill，可以有多条；不要写 type，名字也不要加书名号。`,
        `- 同一门${skillLabel}只写一次，重复出现时用同一个名字，不要换写法或自造新 id；id 可以省略。正文只用「这枚玉简」「那卷残篇」指代时，先对照【当前台账】，指同一门就沿用原名，不要按载体另起一个名字。`,
        '',
        '【档位与知情】',
        '- 角色档位：主角 protagonist；NPC 分 intimate（托付过底牌、生死与共）、friend（共同守过密、长期同场）、public（陌生人/路人/仇敌）。档位看知情与信任，不看关系称谓。',
        '- 条目档位：protagonist（默认只有主角知道）/ intimate / friend / public（人人皆知）。顺序是 public < friend < intimate < protagonist，public 最宽；知情由角色档位 ≥ 条目档位决定，你只需要给条目定档。',
        `- 默认档位只在正文没给线索时使用：字段/物品/关系/${skillLabel} public；题材标记为身份秘密的字段（如灵根、体质）例外，默认 protagonist。再按下面的定档顺序判断。`,
        '- 定档顺序只用于新建条目：① 当众发生、公开场合、旁人能看到 → public；② 没人看见或刻意隐藏 → protagonist；③ 新建时被在场者看见 → 按在场者中与主角关系最疏远的那一档写 access；④ 拿不准 → protagonist。已有条目不因为被动被看见而重新定档。',
        '- 例：苏绾和你共同守过密 → set_tier {character:"苏绾",access:"friend",reason:"共同守密"}；她只是熟识 → 不升档；广场执事 → access:"public"。',
        '- 改档必须写 reason，且只能用这些：public→friend 用「共同守密/主动告知底牌/长期同场」；friend→intimate 用「生死与共/主动托付/共同守密」；public→intimate 只能用「生死与共/主动托付」。降档 intimate→friend 用「泄密/背叛/明确疏远」；friend→public 用「泄密/背叛/长期无往来」。',
        '- 关系称谓只写 set_relation，不作为改档理由；正文发生共同守密、主动托付、生死与共、泄密或背叛，才写 set_tier。',
        '- 分歧、吵架、语气变差不算降档，也不记账；只有关系称谓真的变了才写 set_relation。',
        '- 同一次结算每个角色最多改一档；改档后 3 个故事日内不要反向改，除非生死与共/主动托付/泄密/背叛。',
        '- 主角刻意隐瞒身份或某段经历时，把字段本身写低档：set {character:"user",field:"<字段名>",value:"...",access:"protagonist"}。单纯写一句“隐瞒”不算隔离，因为字段本身仍是公开的。',
        '- 主动告知、主动展示、明确承认 → reveal，把档位放宽到该人的档位。',
        '- 被动被看见或偷听：不要 reveal，也不要把这条秘密写成公开；保持原档位。只被一个路人看见不等于公开。',
        '- reveal 到公开级角色时要先判断是不是真要公开：只说给一个人听，先 set_tier 把他提到相应档位（如共同守密 → friend），再 reveal；确实当众公开才写 access:"public"。',
        '- 例：私下告诉王掌柜 → set_tier {character:"王掌柜",access:"friend",reason:"共同守密"} + reveal {skill:"噬灵诀",to:"王掌柜",method:"低声告知"}；不要直接 reveal 到公开级或写 access:"public"。',
        '- 例：把玉牌给苏绾看 → reveal {item:"残缺符文的玉牌",to:"苏绾",method:"给她看"}（档位放宽到朋友级；档位级下同档都会知道）。',
        '- 例：当着苏绾的面运转噬灵诀 → reveal {skill:"噬灵诀",to:"苏绾",method:"当面施展"}。',
        '- 正文明确写某人不知道/被瞒着，但档位把他算成知情：不要为这个改档；当前正文优先，台账保持默认。这是档位级的精度损失，不要用 reveal 绕过。',
        '- 正文没写某人知道/不知道时，不要因为他在场、看到或沉默就推断；按档位。',
        '- 看破/看穿别人隐藏的字段：玩家自己知道不需要记；要记就写 reveal {to:"苏绾",method:"神识",character:"王掌柜",field:"realm"}。to 和 character 都必须是台账里已有、且该字段已经记录过的角色，to 与 character 不能是同一个人。',
        '- 题材标记为身份秘密的字段（如灵根、体质）默认只有主角知道。正文写明自幼公开测过、乡里皆知，或当众测灵、摸骨、神识扫过之后，才写 public（或目击者所在档）；开场旁白交代给玩家的信息不等于在场 NPC 已知。',
        '- 例：测灵柱当众显出五行杂灵根 → set {character:"user",field:"spiritRoot",value:"五行杂灵根",access:"public"}；私下自测、心里回忆、旁白介绍都不公开。',
        '- 用户消息是玩家的行动或内心，不等于当众说出；只有明确“说出/被看见/被听见”才算 NPC 知情。',
        '- 猜测与误信不属于档位：用 reveal 的 belief/suspicion 记在那个人身上，例 reveal {item:"信笺",to:"王掌柜",belief:"袖中是药方"}、reveal {item:"信笺",to:"王掌柜",suspicion:"袖中藏着东西"}。条目内容只写真相，错误版本不要写进条目本身。',
        '- 只有正文明确当众公开（公告、传开、当众揭穿）才把同一 id 的 access 改成 "public"；只告诉一个人用 reveal，档位会放宽到该人所在档。同 id 重写时必须复用【当前台账】里的键，并原样复制名称。',
        '',
        '【格式】',
        '- 除 set_scene 外每个 op 都要 evidence（写实际消息号，如 msg:87，不是固定写 msg:0）和 confidence(0-1)；<0.5 不写；0.5–0.7 会进入待复核；validFrom 可省。',
        '- 带 [context] 的消息只用于理解指代，不生成 op。',
        '- advance 只在正文明确过夜或时间跳跃时写：过夜 days:1、一周 weeks:1、半个月 days:15、N 个月 months:N、N 年 years:N；不要写 day，也不要把月/年自己换算成天数。',
        '- 正文里指代玩家写「你」，不要写 user 或账号名。',
        '- field 用【题材与字段约定】里的字段名。',
        '示例：',
        '输入：#0 你把混沌珠藏进怀里，苏绾背对着你，她没有看见。 #1 苏绾叫你“师兄”。',
        '输出：{"protagonist":"user","scene":{"time":"午时","place":"云来客栈","participants":["user","苏绾"]},"ops":[{"op":"set","character":"user","field":"gender","value":"男","evidence":"msg:1","confidence":0.9},{"op":"set_relation","from":"user","to":"苏绾","type":"同门","evidence":"msg:1","confidence":0.9},{"op":"add_item","character":"user","item":{"name":"混沌珠","kind":"artifact","access":"protagonist"},"evidence":"msg:0","confidence":0.95}]}',
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
        '- 旁白提到下列角色时必须沿用表里的名字或别名，不要换一种写法另建档案。',
        '- 旁白说出新姓名或新头衔（周执事、苏姑娘）时先对照本表：指的是其中某人就用 rename_character，表里没有的才是新角色。',
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
        '- add_item {character,item:{id,name,quantity?,unit?,kind?,access?}}',
        '- adjust_item {item,delta,character?,reason?,unit?,kind?}',
        '- remove_item {item,character?,reason?}',
        '- clear_items {character?,kinds?,includeCurrency?,reason?}',
        '- clear_currency {character?,item?,reason?}',
        '- set_item_quantity {item,quantity,character?,reason?}',
        '- add_skill {character,skill:{id?,name,level?,access?}}',
        '- set_skill {skill,character?,level?,access?}',
        '- remove_skill {skill,character?,reason?}',
        '- move_item {item,to,access?}',
        '- set_relation {from:"user",to,type,access?}',
        '- reveal {to,method,access?,belief?,suspicion?,character?+field?|item?|relation?|skill?}',
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
    if (!data.scene || typeof data.scene !== 'object') data.scene = {};
    return data;
}

/** 当前在场、但档案里没有性别的 NPC：提取模型最容易漏的字段。 */
export function missingGenderCharacters(inputState) {
    const state = normalizeState(inputState);
    const protagonistId = state.meta?.protagonistId || PROTAGONIST_ID;
    const ids = [];
    for (const ref of state.scene?.participants || []) {
        const id = resolveCharacterId(state, ref, { create: false }) || ref;
        if (id && !ids.includes(id)) ids.push(id);
    }
    return ids
        .map((id) => state.characters?.[id])
        .filter((character) => character
            && character.id !== PROTAGONIST_ID
            && character.id !== protagonistId
            && !String(character.state?.gender?.current ?? '').trim());
}

/** 手动 op：追加到当前分支最后一条记录，回放时仍然生效。 */
export function appendManualOp(history, chat, op) {
    if (!op || typeof op !== 'object') return false;
    const branch = selectHistoryBranch(history, chat);
    const last = branch[branch.length - 1];
    if (!last) return false;
    if (!Array.isArray(last.ops)) last.ops = [];
    last.ops.push({ evidence: 'manual', confidence: 1, ...op });
    return true;
}

/** 手动补录字段：追加到当前分支最后一条记录，回放时仍然生效。 */
export function appendManualField(history, chat, characterId, field, value) {
    if (!characterId || !field) return false;
    return appendManualOp(history, chat, {
        op: 'set',
        character: characterId,
        field,
        value,
    });
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
    for (const character of missingGenderCharacters(state)) {
        issues.push(`角色 ${character.name || character.id} 性别未知，可在健康页补录`);
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
