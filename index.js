import { getContext } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import {
    createEmptyState,
    normalizeState,
    applyOps,
    assembleInjection,
    healthCheck,
    missingGenderCharacters,
    duplicateCharacterGroups,
    missingFieldCharacters,
    appendManualField,
    appendManualOp,
    estimateTokens,
    buildExtractionPrompt,
    parseExtractionResponse,
    detectLeaks,
    selectSettleMessages,
    collectAssistantText,
    messageHash,
    detectAnchorMutation,
    reanchorWindow,
    computePrefixHashes,
    findReplayPoint,
    replayHistory,
    ensureCharacterRecord,
    seedProtagonistName,
    PROTAGONIST_ID,
    PROTAGONIST_ALIASES,
    ACCESS_LEVELS,
    ACCESS_LABELS,
    entityAccess,
    characterAccess,
    knowsEntity,
    normalizeAccess,
    isPlaceholderPersonaName,
    promotePublicEntries,
    sceneTimeLabel,
    resolveSceneDay,
    selectHistoryBranch,
    recordMatchesChat,
    backfillAnchors,
} from './lib/ledger.js';
import { DEFAULT_GENRE, GENRE_PRESETS, getGenrePreset, listGenrePresets } from './lib/genres.js';
import { classifyExtractionFailure, failureMessage } from './lib/refusal.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';

const MODULE_NAME = 'factLedger';
const INJECTION_KEY = 'factledger';
const VERSION = '0.16.38';
const EXTENSION_DIR = new URL('.', import.meta.url).pathname;
// Matches SillyTavern's extension_prompt_types / extension_prompt_roles.
// IN_PROMPT merges into the main system prompt (before world info and chat).
// IN_CHAT inserts a message at the given depth in the chat history (after world info).
const IN_PROMPT = 0;
const IN_CHAT = 1;
const ROLE_SYSTEM = 0;
// Qwen/Queen chat templates reject a system message that is not the first one;
// switch the position back to IN_PROMPT for those models.
const INJECT_POSITIONS = new Set(['chat', 'prompt']);

const DEFAULT_SETTINGS = {
    enabled: true,
    autoInterval: 1,
    genrePreset: DEFAULT_GENRE,
    genreHint: getGenrePreset(DEFAULT_GENRE).hint,
    injectNarrativeRules: true,
    statusBarEnabled: true,
    protagonistId: '',
    useCurrentConnection: false,
    extractionIncludePreset: false,
    profileId: '',
    fallbackProfileId: '',
    maxTokens: 4096,
    confidenceThreshold: 0.7,
    tierVoteThreshold: 2,
    injectBudget: 3000,
    // chat = 对话历史中（世界书之后）；prompt = 主系统提示词。
    injectPosition: 'chat',
    // 距最新消息的条数，0 = 紧贴最新消息；仅 injectPosition 为 chat 时生效。
    injectDepth: 4,
    knowledgeGate: true,
    leakCheck: true,
    showOthers: true,
    // 每 N 条结算过的消息，把主角仍公开的字段/物品/功法升到朋友级；0 = 关闭。
    publicPromoteInterval: 20,
    // 正文被改动后，自动重新提取被改的那一条（会多一次模型调用）。
    autoResettleOnEdit: true,
};

const TABS = [
    { id: 'characters', label: '角色' },
    { id: 'knowledge', label: '认知' },
    { id: 'history', label: '日志' },
    { id: 'health', label: '健康' },
];

/** 内部层级枚举不直接显示给玩家。 */
const TIER_LABELS = { main: '主角', major: '重要', support: '配角', minor: '次要', npc: '路人' };

let activeTab = 'characters';
let panelVisible = false;
let settleRunning = false;
let settlePending = false;
let settleQueued = false;
let sendLocked = false;
let sendLockChatId = '';
let sendLockTimer = null;
let sendGuardsInstalled = false;
let lastSendLockWarnAt = 0;
let lastExtractionFailure = { kind: '', at: 0 };
let knowledgeEntries = [];
const collapsedStatusPanels = new Set();

function log(...args) {
    console.log('[FactLedger]', ...args);
}

function currentChatId() {
    const ctx = getContext();
    return ctx.chatId || ctx.getCurrentChatId?.() || '';
}

function renderSendLockUi(locked) {
    const form = document.getElementById('send_form');
    const notice = document.getElementById('factledger_send_lock');
    if (!locked) {
        form?.classList.remove('factledger-send-locked');
        notice?.remove();
        return;
    }
    form?.classList.add('factledger-send-locked');
    if (notice || !form?.parentElement) return;
    const el = document.createElement('div');
    el.id = 'factledger_send_lock';
    el.className = 'factledger-send-lock';
    el.textContent = '台账结算中，稍候再发';
    form.parentElement.insertBefore(el, form);
}

/** 结算期间锁住发送；只锁「发出」这个动作，输入框仍可正常打字。 */
function lockSending() {
    sendLocked = true;
    sendLockChatId = currentChatId();
    if (sendLockTimer) clearTimeout(sendLockTimer);
    // 看门狗：正常路径由 settle finally 解锁，这里只兜底异常。
    sendLockTimer = setTimeout(() => unlockSending('watchdog'), EXTRACTION_TIMEOUT_MS + 5000);
    renderSendLockUi(true);
    log('send locked', sendLockChatId);
}

function unlockSending(reason = '') {
    const wasLocked = sendLocked;
    sendLocked = false;
    sendLockChatId = '';
    if (sendLockTimer) {
        clearTimeout(sendLockTimer);
        sendLockTimer = null;
    }
    renderSendLockUi(false);
    if (wasLocked) log('send unlocked', reason);
}

function warnSendLocked() {
    const now = Date.now();
    if (now - lastSendLockWarnAt < 1000) return;
    lastSendLockWarnAt = now;
    const toast = globalThis.toastr || (typeof toastr !== 'undefined' ? toastr : null);
    toast?.warning('台账结算中，请稍候再发送。', 'Fact Ledger');
    setStatus('台账结算中，请稍候再发送。');
}

/**
 * 酒馆没有可取消的 MESSAGE_SENDING 事件，只能在 DOM 事件到达酒馆处理器之前拦住。
 * capture 阶段只拦发送下一条消息；重新生成、swipe、继续属于当前回合的新尝试，放行。
 */
function installSendGuards() {
    if (sendGuardsInstalled) return;
    sendGuardsInstalled = true;
    window.addEventListener('keydown', (event) => {
        if (!sendLocked) return;
        const textarea = document.getElementById('send_textarea');
        if (!textarea || event.target !== textarea) return;
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        warnSendLocked();
    }, true);
    window.addEventListener('click', (event) => {
        if (!sendLocked) return;
        const target = event.target instanceof Element
            ? event.target.closest('#send_but')
            : null;
        if (!target) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        warnSendLocked();
    }, true);
}

function error(...args) {
    console.error('[FactLedger]', ...args);
}

function getSettings() {
    const ctx = getContext();
    if (!ctx.extensionSettings[MODULE_NAME]) {
        ctx.extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    const settings = ctx.extensionSettings[MODULE_NAME];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (settings[key] === undefined) {
            settings[key] = structuredClone(value);
        }
    }
    if (!settings.genrePreset || !GENRE_PRESETS[settings.genrePreset]) {
        settings.genrePreset = DEFAULT_GENRE;
    }
    if (!INJECT_POSITIONS.has(settings.injectPosition)) {
        settings.injectPosition = DEFAULT_SETTINGS.injectPosition;
    }
    const injectDepth = Number(settings.injectDepth);
    if (!Number.isFinite(injectDepth) || injectDepth < 0) {
        settings.injectDepth = DEFAULT_SETTINGS.injectDepth;
    }
    return settings;
}

function saveSettings() {
    saveSettingsDebounced();
}

/** NPC 可写入的字段：题材的等级字段，以及题材定义了标签的宗门。 */
function npcFieldsOf(preset) {
    return [preset?.levelField, preset?.fieldLabels?.sect ? 'sect' : ''].filter(Boolean);
}

function normalizeStateAliases(state) {
    const preset = getGenrePreset(getSettings().genrePreset);
    const aliases = preset.stateAliases || {};
    let changed = false;
    for (const character of Object.values(state.characters || {})) {
        for (const [field, map] of Object.entries(aliases)) {
            const entry = character.state?.[field];
            if (!entry || typeof entry !== 'object') continue;
            const current = String(entry.current ?? '').trim();
            const mapped = map[current];
            if (!mapped || mapped === current) continue;
            entry.current = mapped;
            const open = [...(entry.history || [])].reverse().find((item) => item.validTo == null);
            if (open && String(open.value ?? '').trim() === current) open.value = mapped;
            changed = true;
        }
    }
    return changed;
}

function normalizeOpsAliases(ops) {
    if (!Array.isArray(ops)) return ops;
    const preset = getGenrePreset(getSettings().genrePreset);
    const aliases = preset.stateAliases || {};
    return ops.map((op) => {
        if (op?.op !== 'set' || !op.field) return op;
        const map = aliases[op.field];
        if (!map) return op;
        const key = String(op.value ?? '').trim();
        const mapped = map[key];
        return mapped ? { ...op, value: mapped } : op;
    });
}

function getState() {
    const ctx = getContext();
    if (!ctx.chatMetadata) {
        return createEmptyState();
    }
    if (!ctx.chatMetadata[MODULE_NAME] || typeof ctx.chatMetadata[MODULE_NAME] !== 'object') {
        ctx.chatMetadata[MODULE_NAME] = createEmptyState();
    }
    ctx.chatMetadata[MODULE_NAME] = normalizeState(ctx.chatMetadata[MODULE_NAME]);
    const state = ctx.chatMetadata[MODULE_NAME];
    let changed = normalizeStateAliases(state);
    const personaName = isPlaceholderPersonaName(ctx.name1) ? '' : String(ctx.name1 || '').trim();
    if (seedProtagonistName(state, personaName)) changed = true;
    if (changed) {
        saveState();
    }
    return state;
}

function saveState() {
    const ctx = getContext();
    if (typeof ctx.saveMetadataDebounced === 'function') {
        ctx.saveMetadataDebounced();
    }
}

function setStatus(message) {
    const el = document.getElementById('factledger_status');
    if (el) el.textContent = message;
    log(message);
}

/** 面板没打开时 setStatus 看不见；手动操作的结果用 toast 兜底。 */
function toastInfo(message) {
    const toast = globalThis.toastr || (typeof toastr !== 'undefined' ? toastr : null);
    toast?.info(message, 'Fact Ledger');
}

function revealTargetLabel(op, state) {
    const nameOf = (id) => (id === PROTAGONIST_ID ? '你' : (state.characters?.[id]?.name || id));
    if (op.item) {
        for (const character of Object.values(state.characters || {})) {
            const item = (character.items || []).find((entry) => entry.id === op.item && entry.validTo == null);
            if (item) return item.name;
        }
        return String(op.item);
    }
    if (op.relation) return `与 ${nameOf(op.relation)} 的关系`;
    if (op.skill) {
        const wanted = op.skill;
        for (const character of Object.values(state.characters || {})) {
            const trait = (character.skills || []).find((entry) => entry.id === wanted && entry.validTo == null);
            if (trait) return trait.name;
        }
        return String(wanted);
    }
    if (op.field) {
        const label = getGenrePreset(getSettings().genrePreset).fieldLabels?.[op.field] || op.field;
        return `${nameOf(op.character)} · ${label}`;
    }
    return '条目';
}

/** reveal 是知情边界的变化，必须让用户看见，不能只写进日志。 */
function notifyReveals(reveals, state) {
    if (!Array.isArray(reveals) || !reveals.length) return;
    const nameOf = (id) => (id === PROTAGONIST_ID ? '你' : (state.characters?.[id]?.name || id));
    const lines = reveals.map((op) => {
        return `${nameOf(op.to)} 知道了「${revealTargetLabel(op, state)}」（知情放宽到该档${op.method ? `，${op.method}` : ''}）`;
    });
    const message = `秘密知情变化：\n${lines.join('\n')}`;
    setStatus(message.replace(/\n/g, '；'));
    const toast = globalThis.toastr || (typeof toastr !== 'undefined' ? toastr : null);
    if (typeof toast?.warning === 'function') {
        toast.warning(message, 'FactLedger', { timeOut: 12000, extendedTimeOut: 6000, closeButton: true });
    } else if (typeof toast?.info === 'function') {
        toast.info(message, 'FactLedger', { timeOut: 12000, extendedTimeOut: 6000, closeButton: true });
    } else {
        error('[FactLedger] 无法弹出提醒，请查看状态栏：', message);
    }
}

function characterByRef(state, ref) {
    const key = String(ref ?? '').trim();
    if (!key) return null;
    return state.characters?.[key]
        || Object.values(state.characters || {}).find((character) => (
            character.name === key || (character.aliases || []).includes(key)
        ))
        || null;
}

/** 日志与提示里的角色名：内部 id 一律换成显示名。 */
function displayName(state, ref) {
    const key = String(ref ?? '').trim();
    if (!key) return '';
    if (key === PROTAGONIST_ID) return '你';
    return characterByRef(state, key)?.name || key;
}

/** 新建 NPC、关系边和档位变化：结算后给一条可读提示，不要只写进日志。 */
function notifyLedgerChanges({ newCharacters, changedOps, pendingOps }, state) {
    const newcomers = [];
    const seen = new Set();
    for (const character of Array.isArray(newCharacters) ? newCharacters : []) {
        if (!character?.id || character.id === PROTAGONIST_ID || seen.has(character.id)) continue;
        seen.add(character.id);
        newcomers.push(character.name || character.id);
    }
    const relationLines = [];
    const tierLines = [];
    const pendingLines = [];
    for (const op of Array.isArray(changedOps) ? changedOps : []) {
        if (op?.op === 'set_relation') {
            const from = characterByRef(state, op.from);
            const to = characterByRef(state, op.to);
            const detail = op.type || '';
            relationLines.push(`${from?.name || op.from} → ${to?.name || op.to}：${detail || '关系更新'}`);
        } else if (op?.op === 'set_tier') {
            const person = characterByRef(state, op.character || op.characterId);
            if (!person) continue;
            const from = person.accessChangedFrom
                ? (ACCESS_LABELS[person.accessChangedFrom] || person.accessChangedFrom)
                : '新建';
            const to = ACCESS_LABELS[characterAccess(person)] || characterAccess(person);
            tierLines.push(`${person.name || person.id}：${from} → ${to}${op.reason ? `（${op.reason}）` : ''}`);
        }
    }
    for (const op of Array.isArray(pendingOps) ? pendingOps : []) {
        if (op?.op !== 'set_tier' || !op.pendingTier) continue;
        const person = characterByRef(state, op.character || op.characterId);
        if (!person) continue;
        const pending = op.pendingTier;
        const from = ACCESS_LABELS[pending.from] || pending.from;
        const to = ACCESS_LABELS[pending.to] || pending.to;
        pendingLines.push(`${person.name || person.id}：${from} → ${to} ${pending.count}/${pending.required}${op.reason ? `（${op.reason}）` : ''}`);
    }
    const lines = [];
    if (newcomers.length) lines.push(`新建角色：${newcomers.join('、')}`);
    if (relationLines.length) lines.push(`关系变化：\n${relationLines.join('\n')}`);
    if (tierLines.length) lines.push(`档位变化：\n${tierLines.join('\n')}`);
    if (pendingLines.length) lines.push(`档位待确认：\n${pendingLines.join('\n')}`);
    if (!lines.length) return;
    const message = lines.join('\n');
    setStatus(message.replace(/\n/g, '；'));
    const toast = globalThis.toastr || (typeof toastr !== 'undefined' ? toastr : null);
    if (typeof toast?.info === 'function') {
        toast.info(message, 'FactLedger', { timeOut: 10000, extendedTimeOut: 5000, closeButton: true });
    }
}

/**
 * 提取失败要同时落到状态栏、面板和 toast；同一类失败 60 秒内只弹一次，
 * 避免自动结算连续失败时刷屏。
 */
function showExtractionFailure(failure) {
    const message = failureMessage(failure);
    const state = getState();
    state.meta.lastError = message;
    saveState();
    try {
        renderPanel();
        renderStatusBar();
    } catch (err) {
        error('render extraction failure failed', err);
    }
    setStatus(message);

    const now = Date.now();
    if (lastExtractionFailure.kind === failure.kind && now - lastExtractionFailure.at < 60000) return;
    lastExtractionFailure = { kind: failure.kind, at: now };

    const toast = globalThis.toastr || (typeof toastr !== 'undefined' ? toastr : null);
    const method = ['refusal', 'content_filter', 'auth', 'timeout', 'network'].includes(failure.kind)
        ? 'error'
        : 'warning';
    if (typeof toast?.[method] === 'function') {
        toast[method](message, 'FactLedger 提取失败', {
            timeOut: 15000,
            extendedTimeOut: 8000,
            closeButton: true,
        });
    } else {
        error('[FactLedger] 提取失败：', message);
    }
}

/**
 * 回放/恢复后，泄露与待复核都对应已被改掉的那几条回复，留着只会误导。
 */
function clearTransientMeta(state) {
    state.meta.leaks = [];
    state.meta.review = [];
}

/** 回放后主角指向的角色若已不存在，退回默认身份。 */
function dropMissingProtagonist(state, pinnedBefore, existedBefore) {
    if (!existedBefore || state.characters[pinnedBefore]) return;
    state.meta.protagonistId = '';
}

/**
 * Rebuild the ledger at the newest chat prefix that still matches the op log.
 * Used for edits, deletes, swipes, branches and checkpoint restores.
 */
function restoreLedgerFromHistory(reason = '') {
    const ctx = getContext();
    const state = getState();
    const history = Array.isArray(state.meta.history) ? state.meta.history : [];
    // 能对上的旧记录补单条锚点：以后编辑别的消息只影响被改的那一条。
    backfillAnchors(history, ctx.chat);

    if (!history.length) {
        state.meta.lastProcessedMessage = reanchorWindow(ctx.chat.length, 20);
        state.meta.lastProcessedHash = '';
        clearTransientMeta(state);
        saveState();
        return -1;
    }

    const { index } = findReplayPoint(history, ctx.chat);
    if (index < 0) {
        // 找不到能对上的前缀时保留现有台账，只把结算锚点退回去重算最近一段。
        // 直接 replayHistory(-1) 会把角色、物品、关系和秘密全部清空。
        state.meta.lastProcessedMessage = reanchorWindow(ctx.chat.length, 20);
        state.meta.lastProcessedHash = '';
        clearTransientMeta(state);
        saveState();
        log('ledger restore skipped: no matching prefix', reason);
        return -1;
    }
    // 同一消息序号可能有多条 swipe 记录；只回放与当前正文匹配的那条分支。
    const branch = selectHistoryBranch(history, ctx.chat);
    const restored = replayHistory(branch, index);
    const pinnedBefore = String(state.meta.protagonistId || '').trim();
    const pinnedExisted = pinnedBefore !== '' && Boolean(state.characters[pinnedBefore]);
    state.characters = restored.characters;
    dropMissingProtagonist(state, pinnedBefore, pinnedExisted);
    state.scene = restored.scene;
    // 不裁掉其它 swipe 的记录：切回旧版时还要靠它们回放。
    state.meta.history = history;
    // 回放会重新分配 npc_xxx，计数器只许往前，不能让后来的角色复用已有 id。
    state.meta.nextCharacterId = Math.max(
        Number(state.meta.nextCharacterId) || 1,
        Number(restored.meta?.nextCharacterId) || 1,
    );
    state.meta.lastProcessedMessage = index;
    state.meta.lastProcessedHash = index >= 0 && ctx.chat[index]
        ? messageHash(ctx.chat[index])
        : '';
    clearTransientMeta(state);
    saveState();
    log('ledger restored', reason, index);
    return index;
}

/** 当前正文下，哪些消息序号的记录已经全部对不上（正文被改过）。 */
function lostHistoryIndices(chat, history) {
    const hashes = computePrefixHashes(chat);
    const byIndex = new Map();
    for (const record of Array.isArray(history) ? history : []) {
        const to = Number(record?.to);
        if (!Number.isFinite(to) || to < 0 || to >= chat.length) continue;
        if (!byIndex.has(to)) byIndex.set(to, []);
        byIndex.get(to).push(record);
    }
    const lost = [];
    for (const [to, records] of byIndex) {
        if (!records.some((record) => recordMatchesChat(record, chat, hashes))) lost.push(to);
    }
    return lost.sort((a, b) => a - b);
}

/** 只重算一条 AI 回复：用它前面的台账状态做底，重新提取后替换该轮记录。 */
async function resettleMessage(index, options = {}) {
    const auto = Boolean(options.auto);
    if (settleRunning) {
        if (!auto) setStatus('结算正在进行中，请稍候。');
        // 结算中改过正文：本轮结果会作废，结束后按新正文补一次整体结算。
        else settleQueued = true;
        return null;
    }
    // 后台标签下 Chrome 会挂起这类请求，两次尝试都只会白等超时；留到切回可见时再算。
    if (auto && typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        pendingResettleIndex = Number(index);
        return null;
    }
    const ctx = getContext();
    const settings = getSettings();
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    const target = Number(index);
    if (!settings.enabled) return null;
    if (!Number.isFinite(target) || target < 0 || target >= chat.length) return null;
    if (chat[target]?.is_user) {
        if (!auto) setStatus('只能重算 AI 回复的那一条。');
        return null;
    }
    if (!settings.useCurrentConnection && !getProfileId() && !settings.fallbackProfileId) {
        if (!auto) setStatus('未选择提取连接配置，请先到设置里选择，或勾选“跟随当前连接”。');
        return null;
    }

    const chatId = currentChatId();
    const startedAt = Date.now();
    const extractionMeta = {};
    let settleError = '';
    let settlePromptChars = 0;
    settleRunning = true;
    settlePending = true;
    armSettleWatchdog('resettle', startedAt);
    lockSending();
    renderStatusBar();
    setStatus(`正在重算 #${target}…`);
    try {
        // 先按当前正文回放一次，确保历史与分支是最新的。
        restoreLedgerFromHistory('resettle-start');
        if (chatId !== currentChatId()) return null;
        const state = getState();
        const history = state.meta.history || [];
        const hashes = computePrefixHashes(chat);
        const branch = selectHistoryBranch(history, chat);
        const base = replayHistory(branch.filter((record) => Number(record?.to) < target), target - 1);
        seedProtagonistName(base, ctx.name1);
        const baseState = {
            ...base,
            meta: {
                ...state.meta,
                history,
                nextCharacterId: Math.max(
                    Number(state.meta.nextCharacterId) || 1,
                    Number(base.meta?.nextCharacterId) || 1,
                ),
            },
        };
        // 只把被改的这条当作待提取内容，前面最多 3 条只作上下文。
        const start = Math.max(0, target - 3);
        const messages = [];
        for (let i = start; i <= target; i += 1) {
            const message = chat[i];
            const text = String(message?.mes ?? '');
            if (!text.trim()) continue;
            messages.push({
                isUser: Boolean(message.is_user),
                name: message.name || (message.is_user ? ctx.name1 : ctx.name2),
                mes: text,
                index: i,
            });
        }
        const preset = getGenrePreset(settings.genrePreset);
        const { system, user } = buildExtractionPrompt(baseState, messages, {
            maxMessages: messages.length,
            newFrom: target,
            genreHint: settings.genreHint,
            skillLabel: preset.skillLabel,
            npcExtraFieldLabels: [preset.fieldLabels?.sect].filter(Boolean),
        });
        settlePromptChars = system.length + user.length;
        const deadline = Date.now() + EXTRACTION_TIMEOUT_MS;
        let parsed;
        let lastRaw = '';
        try {
            lastRaw = await callExtractionModel(system, user, settings.maxTokens, { deadline, meta: extractionMeta });
            parsed = parseExtractionResponse(lastRaw);
        } catch (err) {
            log('重算提取失败，重试一次', err.message);
            try {
                lastRaw = await callExtractionModel(system, user, settings.maxTokens, { deadline, meta: extractionMeta });
                parsed = parseExtractionResponse(lastRaw);
            } catch (retryErr) {
                settleError = errorDetail(retryErr);
                showExtractionFailure(classifyExtractionFailure(lastRaw, retryErr, extractionMeta));
                return null;
            }
        }
        if (parsed && !parsed.ops.length && typeof parsed.error === 'string' && parsed.error.trim()) {
            showExtractionFailure({ kind: 'refusal', detail: parsed.error.trim() });
            return null;
        }

        const protagonistAliases = [...PROTAGONIST_ALIASES, ctx.name1].filter(Boolean);
        const parsedScene = parsed.scene && typeof parsed.scene === 'object' ? parsed.scene : null;
        const parsedDay = parsedScene ? resolveSceneDay(baseState.scene.day, parsedScene) : null;
        const workBase = parsedDay === null || parsedDay === baseState.scene.day
            ? baseState
            : { ...baseState, scene: { ...baseState.scene, day: parsedDay } };
        const beforeIds = new Set(Object.keys(baseState.characters || {}));
        // applyOps 会原地改动状态，进度快照必须在应用之前取。
        const progressBefore = progressOf(workBase);
        const result = applyOps(workBase, normalizeOpsAliases(parsed.ops), {
            confidenceThreshold: settings.confidenceThreshold,
            tierVoteThreshold: settings.tierVoteThreshold,
            protagonistId: baseState.meta?.protagonistId || settings.protagonistId || PROTAGONIST_ID,
            reviewThreshold: 0.5,
            messageCount: chat.length,
            protagonistAliases,
            npcFields: npcFieldsOf(preset),
        });
        const nextState = result.state;
        const normalizeRef = (value) => {
            const text = String(value ?? '').trim();
            return text && (text === PROTAGONIST_ID || protagonistAliases.includes(text)) ? PROTAGONIST_ID : value;
        };
        if (nextState.characters[PROTAGONIST_ID]) {
            nextState.meta.protagonistId = PROTAGONIST_ID;
            nextState.characters[PROTAGONIST_ID].tier = 'main';
        } else if (typeof parsed.protagonist === 'string' && parsed.protagonist.trim()) {
            const wanted = normalizeRef(parsed.protagonist.trim());
            const match = nextState.characters[wanted]
                || Object.values(nextState.characters).find((character) => character.name === wanted
                    || (character.aliases || []).includes(wanted));
            if (match) {
                nextState.meta.protagonistId = match.id;
                match.tier = 'main';
            }
        }
        if (parsed.scene && typeof parsed.scene === 'object') {
            nextState.scene = {
                time: parsed.scene.time || nextState.scene.time || '',
                day: parsedDay ?? nextState.scene.day ?? 1,
                place: parsed.scene.place || nextState.scene.place || '',
                participants: Array.isArray(parsed.scene.participants)
                    ? parsed.scene.participants
                        .map(normalizeRef)
                        .map((name) => ensureCharacterRecord(nextState, name))
                        .filter(Boolean)
                        .map((character) => character.id)
                    : nextState.scene.participants,
            };
            for (const participant of nextState.scene.participants) {
                const name = String(participant || '').trim();
                if (!name) continue;
                const person = ensureCharacterRecord(nextState, name);
                if (person && nextState.scene.day !== null) person.lastSeenDay = nextState.scene.day;
            }
        }
        if (nextState.scene.day === null) nextState.scene.day = 1;

        const sceneOps = parsed.scene && typeof parsed.scene === 'object'
            ? [{
                op: 'set_scene',
                scene: {
                    time: nextState.scene.time || '',
                    day: nextState.scene.day ?? null,
                    place: nextState.scene.place || '',
                    participants: (nextState.scene.participants || [])
                        .map((participant) => nextState.characters?.[participant]?.name || participant),
                },
            }]
            : [];
        const newCharacters = Object.values(nextState.characters || {})
            .filter((character) => !beforeIds.has(character.id))
            .map((character) => ({
                id: character.id,
                name: character.name,
                aliases: character.aliases || [],
            }));
        const anchor = messageHash(chat[target]);
        // 同一条正文的旧记录替换掉；其它 swipe 的记录保留。
        const mergedHistory = (nextState.meta.history || history).filter((record) => !(
            Number(record?.to) === target
            && (record.anchor ? record.anchor === anchor : record.prefixHash === hashes[target])
        ));
        mergedHistory.push({
            to: target,
            anchor,
            prefixHash: hashes[target] || '',
            ops: [...result.applied, ...sceneOps],
            characters: newCharacters,
            scene: { ...nextState.scene },
            progress: { before: progressBefore, after: progressOf(nextState) },
        });

        // 用新记录重建整条分支；后面仍然对得上的记录继续生效。
        const nextBranch = selectHistoryBranch(mergedHistory, chat);
        const newest = nextBranch.length ? Number(nextBranch[nextBranch.length - 1].to) : target;
        const restored = replayHistory(nextBranch, newest);
        const pinnedBefore = String(state.meta.protagonistId || '').trim();
        const pinnedExisted = pinnedBefore !== '' && Boolean(state.characters[pinnedBefore]);
        state.characters = restored.characters;
        dropMissingProtagonist(state, pinnedBefore, pinnedExisted);
        state.scene = restored.scene;
        state.meta.history = mergedHistory;
        state.meta.nextCharacterId = Math.max(
            Number(state.meta.nextCharacterId) || 1,
            Number(restored.meta?.nextCharacterId) || 1,
        );
        state.meta.lastProcessedMessage = newest;
        state.meta.lastProcessedHash = chat[newest] ? messageHash(chat[newest]) : '';
        state.meta.lastSettleAt = new Date().toISOString();
        state.meta.lastError = '';
        state.meta.review = [
            ...(state.meta.review || []),
            ...(result.review || []).map((op) => ({ op, at: new Date().toISOString(), messageIndex: target })),
        ].slice(-50);
        if (settings.leakCheck) {
            const active = (state.scene?.participants || [])
                .filter((id) => id && id !== (state.meta?.protagonistId || PROTAGONIST_ID));
            const fresh = detectLeaks(state, collectAssistantText(chat, target, target), active, preset.fieldLabels, {
                skillLabel: preset.skillLabel,
            });
            const seen = new Set((state.meta.leaks || []).map((leak) => `${leak.character}|${leak.label}|${leak.quote}`));
            const added = fresh.filter((leak) => !seen.has(`${leak.character}|${leak.label}|${leak.quote}`));
            if (added.length) state.meta.leaks = [...(state.meta.leaks || []), ...added];
        }

        ctx.chatMetadata[MODULE_NAME] = state;
        // 保存统一交给 finally 里的追踪写入。
        refreshInjection();
        renderPanel();
        const count = result.applied.filter((op) => !op?.pendingTier).length;
        setStatus(`#${target} 重算完成（${((Date.now() - startedAt) / 1000).toFixed(1)} 秒）：应用 ${count} 条，待复核 ${result.review.length} 条，拒绝 ${result.rejected.length} 条。`);
        notifyReveals((result.changedOps || []).filter((op) => op && op.op === 'reveal'), state);
        notifyLedgerChanges({
            newCharacters,
            changedOps: result.changedOps || [],
            pendingOps: result.pendingOps || [],
        }, state);
        return result;
    } catch (err) {
        settleError = errorDetail(err);
        showExtractionFailure(classifyExtractionFailure('', err, extractionMeta));
        error('resettle failed', err);
        return null;
    } finally {
        clearSettleWatchdog();
        settleRunning = false;
        settlePending = false;
        if (settleError && extractionMeta.attempts && extractionMeta.abortSettledMs == null) {
            await new Promise((resolve) => setTimeout(resolve, 60));
        }
        recordSettleTrace('resettle', startedAt, settlePromptChars, extractionMeta, settleError);
        renderStatusBar();
        unlockSending('resettle-done');
        // 重算期间被挡下的自动结算不能丢，结束后补跑。
        if (settleQueued) {
            settleQueued = false;
            setTimeout(() => {
                settleLedger().catch((err) => error('queued settle failed', err));
            }, 0);
        }
    }
}

let resettleTimer = null;
let resettleIndex = -1;
let resettleChatId = '';
// 生成期间不发起提取：读到的是旧 swipe 或半截正文，会造出正文里没有的角色。
let generationActive = false;
let pendingResettleIndex = -1;
let pendingResettleHash = '';

/** 消费待重算楼层：只有正文确实被新内容替换过才重算，生成失败（空 swipe）时不跑。 */
function consumePendingResettle() {
    const target = pendingResettleIndex;
    const beforeHash = pendingResettleHash;
    pendingResettleIndex = -1;
    pendingResettleHash = '';
    if (target < 0) return false;
    const chat = Array.isArray(getContext().chat) ? getContext().chat : [];
    const message = chat[target];
    if (!message || message.is_user) return false;
    const text = String(message.mes || '').trim();
    // 502/中止时 swipe 会被清成空串，或内容根本没变：这两种都不该重算。
    if (!text || messageHash(message) === beforeHash) return false;
    setTimeout(() => {
        resettleMessage(target, { auto: true });
    }, 500);
    return true;
}
// 结算看门狗：任何一轮超过这个时间仍未结束，强制复位，避免把后续结算全部堵死。
const SETTLE_WATCHDOG_MS = 120000;
let settleWatchdog = null;

function armSettleWatchdog(mode, startedAt) {
    clearSettleWatchdog();
    settleWatchdog = setTimeout(() => {
        settleWatchdog = null;
        error('settle watchdog fired', mode);
        settleRunning = false;
        settlePending = false;
        unlockSending('watchdog');
        recordSettleTrace(`${mode}-watchdog`, startedAt, 0, {}, '结算超过 120 秒未结束，已强制复位');
        renderStatusBar();
        if (settleQueued) {
            settleQueued = false;
            setTimeout(() => {
                settleLedger().catch((err) => error('queued settle failed', err));
            }, 1000);
        }
    }, SETTLE_WATCHDOG_MS);
}

function clearSettleWatchdog() {
    if (settleWatchdog) {
        clearTimeout(settleWatchdog);
        settleWatchdog = null;
    }
}

/** 编辑/切换正文后，若该条记录已失效就安排一次自动重算。 */
function scheduleResettle(index) {
    const ctx = getContext();
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    const target = Number(index);
    if (!Number.isFinite(target) || target < 0 || target >= chat.length || chat[target]?.is_user) return false;
    const state = getState();
    if (!lostHistoryIndices(chat, state.meta.history || []).includes(target)) return false;
    if (!getSettings().autoResettleOnEdit) return false;
    resettleIndex = target;
    resettleChatId = currentChatId();
    if (resettleTimer) clearTimeout(resettleTimer);
    setStatus(`第 ${target} 条正文已改，约 1 秒后自动重算…`);
    resettleTimer = setTimeout(() => {
        resettleTimer = null;
        const pending = resettleIndex;
        const pendingChat = resettleChatId;
        resettleIndex = -1;
        if (!pendingChat || pendingChat !== currentChatId()) return;
        // 生成进行中不提取，等 GENERATION_ENDED 再算。
        if (generationActive) {
            pendingResettleIndex = pending;
            return;
        }
        resettleMessage(pending, { auto: true });
    }, 1200);
    return true;
}

function narrativeRulesText() {
    const settings = getSettings();
    return settings.injectNarrativeRules ? String(settings.narrativeRules || '').trim() : '';
}

function buildInjectionText() {
    const ctx = getContext();
    const settings = getSettings();
    const recentText = Array.isArray(ctx.chat)
        ? ctx.chat.slice(-12).map((message) => message?.mes || '').join('\n')
        : '';
    const rules = narrativeRulesText();
    const preset = getGenrePreset(settings.genrePreset);
    const ledger = assembleInjection(getState(), {
        tokenBudget: settings.injectBudget,
        knowledgeGate: settings.knowledgeGate,
        showOthers: settings.showOthers,
        skillLabel: preset.skillLabel,
        fieldLabels: preset.fieldLabels,
        levelField: preset.levelField,
        recentText,
        fieldOrder: preset.fieldOrder,
        protagonistId: getProtagonist()?.id || '',
        protagonistName: ctx.name1,
    });
    if (!rules) return ledger;
    return ledger ? `${rules}\n\n${ledger}` : rules;
}

/** 设置里的注入位置转成 SillyTavern 的 position/depth。 */
function injectionTarget(settings) {
    if (settings.injectPosition === 'prompt') {
        return { position: IN_PROMPT, depth: 0 };
    }
    const depth = Math.max(0, Math.round(Number(settings.injectDepth) || 0));
    return { position: IN_CHAT, depth };
}

function refreshInjection() {
    const ctx = getContext();
    const settings = getSettings();
    if (typeof ctx.setExtensionPrompt !== 'function') {
        return '';
    }
    const { position, depth } = injectionTarget(settings);
    if (!settings.enabled || !ctx.chatMetadata) {
        const rules = narrativeRulesText();
        if (!rules) {
            ctx.setExtensionPrompt(INJECTION_KEY, '', -1, 0, false, ROLE_SYSTEM);
            return '';
        }
        ctx.setExtensionPrompt(INJECTION_KEY, rules, position, depth, false, ROLE_SYSTEM);
        return rules;
    }
    const text = buildInjectionText();
    ctx.setExtensionPrompt(INJECTION_KEY, text, position, depth, false, ROLE_SYSTEM);
    return text;
}

function getProfileId() {
    const ctx = getContext();
    const settings = getSettings();
    return settings.profileId || ctx.extensionSettings?.connectionManager?.selectedProfile || '';
}

function errorDetail(err) {
    const cause = err?.cause;
    return cause?.message || cause?.error?.message || err?.message || String(err);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A provider that never answers would leave settleRunning stuck forever,
// silently disabling every later auto settle. Always give up eventually.
// 提取要读台账 + 20 条消息再输出 JSON；思考型模型还要先推理，超时给太短会误判失败。
const EXTRACTION_TIMEOUT_MS = 30000;
// 自动结算稍作异步缓冲即可，不要人为拉长等待。
const AUTO_SETTLE_DELAY_MS = 1000;
// 首次请求的超时上限：给重试留出剩余预算。追踪数据显示同一份请求第一次无响应、
// 第二次 3~4 秒就能返回，所以首次先给 20 秒，超时后立即重试。
const FIRST_ATTEMPT_TIMEOUT_MS = 20000;
// 思考 token 和 JSON 正文共用 max_tokens；低于这个值容易只剩思考、正文为空。
const THINKING_MIN_TOKENS = 8192;

function withTimeout(promise, ms, label, onTimeout) {
    let timer;
    const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
            // 超时同时取消底层请求，避免僵尸请求继续占着连接。
            try {
                onTimeout?.();
            } catch {
                // 取消失败不影响超时判定。
            }
            reject(new Error(`${label}超时（${Math.round(ms / 1000)} 秒），已放弃本次结算`));
        }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function callExtractionModel(system, user, maxTokens, options = {}) {
    const ctx = getContext();
    const settings = getSettings();
    const meta = options.meta || null;
    // 一次结算共用同一个截止时间：重试、换备选连接、解析失败重试都算在这 60 秒里。
    const deadline = Number(options.deadline) || (Date.now() + EXTRACTION_TIMEOUT_MS);
    const remaining = () => Math.max(0, deadline - Date.now());
    const timeoutFor = (label) => {
        const left = remaining();
        if (left <= 0) throw new Error(`${label}超时（${Math.round(EXTRACTION_TIMEOUT_MS / 1000)} 秒），已放弃本次结算`);
        return left;
    };

    if (settings.useCurrentConnection) {
        const content = await withTimeout(ctx.generateQuietPrompt({
            quietPrompt: `${system}\n\n${user}`,
            responseLength: maxTokens,
            removeReasoning: true,
            skipWIAN: true,
        }), timeoutFor('提取请求'), '提取请求');
        if (meta) {
            meta.finishReason = '';
            meta.status = 0;
        }
        if (!String(content ?? '').trim()) {
            throw new Error('提取模型返回空内容（可能是思考 token 占满，请提高提取最大 token）');
        }
        return String(content);
    }

    const service = ctx.ConnectionManagerRequestService;
    if (!service || typeof service.sendRequest !== 'function') {
        throw new Error('当前 SillyTavern 不提供 ConnectionManagerRequestService');
    }

    const profileId = getProfileId();
    const fallbackId = settings.fallbackProfileId || '';
    if (!profileId && !fallbackId) {
        throw new Error('未选择提取连接配置，请到“事实台账”设置里选择');
    }

    const retries = Number(options.retries ?? 2);
    const delayMs = Number(options.delayMs ?? 3000);
    const messages = [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];

    if (!profileId) {
        return requestExtraction(service, fallbackId, messages, maxTokens, 0, delayMs, deadline, meta);
    }

    try {
        return await requestExtraction(service, profileId, messages, maxTokens, retries, delayMs, deadline, meta);
    } catch (err) {
        if (!fallbackId || fallbackId === profileId) {
            throw err;
        }
        setStatus(`主连接提取失败，改用备选连接：${errorDetail(err)}`);
        return requestExtraction(service, fallbackId, messages, maxTokens, 0, delayMs, deadline, meta);
    }
}

function profileModelName(profileId) {
    const ctx = getContext();
    const profiles = ctx.extensionSettings?.connectionManager?.profiles ?? [];
    return String(profiles.find((profile) => profile.id === profileId)?.model || '');
}

// SillyTavern 的 DeepSeek 适配器用 include_reasoning 决定请求里的
// thinking.type，reasoning_effort 单独写不会打开或关闭思考。
// 开思考时要同时给 include_reasoning 和 effort，并用够大的 max_tokens。
function thinkingPayload(profileId) {
    return /deepseek/i.test(profileModelName(profileId))
        ? { include_reasoning: true, reasoning_effort: 'high' }
        : {};
}

async function requestExtraction(service, profileId, messages, maxTokens, retries, delayMs, deadline = Date.now() + EXTRACTION_TIMEOUT_MS, meta = null) {
    if (meta) {
        meta.profileId = String(profileId || '').slice(0, 8);
        meta.visibility = typeof document !== 'undefined' ? document.visibilityState : '';
        meta.online = typeof navigator !== 'undefined' ? navigator.onLine : null;
    }
    const requestOptions = {
        extractData: true,
        includePreset: getSettings().extractionIncludePreset === true,
        stream: false,
    };
    const thinking = thinkingPayload(profileId);
    const thinkingOn = thinking.include_reasoning === true;
    // 思考型模型至少给到 8192，避免推理占满预算后正文为空。
    const effectiveMaxTokens = thinkingOn ? Math.max(Number(maxTokens) || 0, THINKING_MIN_TOKENS) : maxTokens;
    const remaining = () => Math.max(0, deadline - Date.now());
    let lastDetail = '';

    for (let attempt = 0; attempt <= retries; attempt += 1) {
        const attemptStartedAt = Date.now();
        if (meta) meta.attempts = Number(meta.attempts || 0) + 1;
        try {
            const left = remaining();
            if (left <= 0) {
                throw new Error(`提取请求超时（${Math.round(EXTRACTION_TIMEOUT_MS / 1000)} 秒），已放弃本次结算`);
            }
            let response;
            try {
                // 首次只给 20 秒：万一无响应，剩下的预算还能再发一次。
                const attemptBudget = attempt === 0 ? Math.min(left, FIRST_ATTEMPT_TIMEOUT_MS) : left;
                const controller = new AbortController();
                let abortedAt = 0;
                const request = service.sendRequest(profileId, messages, effectiveMaxTokens, {
                    ...requestOptions,
                    signal: controller.signal,
                }, {
                    ...thinking,
                    response_format: { type: 'json_object' },
                });
                // 诊断：记录 abort 之后底层请求隔了多久才结束。
                // 几毫秒内结束（AbortError）说明它一直挂在网络层；毫无反应说明卡在酒馆内部。
                request.catch((err) => {
                    if (meta && controller.signal.aborted) {
                        meta.abortSettledMs = abortedAt ? Date.now() - abortedAt : -1;
                        meta.abortError = String(err?.name || err?.message || err).slice(0, 60);
                    }
                });
                response = await withTimeout(
                    request,
                    attemptBudget,
                    '提取请求',
                    () => {
                        abortedAt = Date.now();
                        controller.abort();
                    },
                );
            } catch (err) {
                const detail = errorDetail(err);
                // Some providers reject response_format; retry once without it.
                if (/response_format|json_object|bad request|400/i.test(detail)) {
                    response = await withTimeout(
                        service.sendRequest(profileId, messages, effectiveMaxTokens, requestOptions, thinking),
                        Math.max(1, remaining()),
                        '提取请求',
                    );
                } else {
                    throw err;
                }
            }
            const content = response?.content ?? response?.text ?? '';
            if (meta) {
                meta.finishReason = String(
                    response?.finish_reason
                    || response?.finishReason
                    || response?.response?.finish_reason
                    || response?.choices?.[0]?.finish_reason
                    || '',
                );
                meta.status = Number(response?.status ?? response?.statusCode ?? 0) || 0;
            }
            if (!String(content).trim()) {
                throw new Error('提取模型返回空内容（可能是思考 token 占满，请提高提取最大 token）');
            }
            return String(content);
        } catch (err) {
            lastDetail = errorDetail(err);
            const isCapacity = /capacity|at capacity|rate limit|too many requests|429/i.test(lastDetail);
            const isTimeout = /超时|timeout|timed out/i.test(lastDetail);
            // 首次请求无响应时立即重试：同一份请求第二次通常几秒就能返回。
            if (isTimeout && attempt === 0 && attempt < retries && remaining() > 2000) {
                setStatus('提取请求未响应，正在重试…');
                continue;
            }
            if (isCapacity && attempt < retries && remaining() > delayMs) {
                setStatus(`模型容量不足，${Math.round(delayMs / 1000)} 秒后重试（${attempt + 1}/${retries}）…`);
                await sleep(delayMs);
                continue;
            }
            throw new Error(lastDetail || 'API request failed');
        } finally {
            if (meta) {
                const attemptMs = Array.isArray(meta.attemptMs) ? meta.attemptMs : [];
                attemptMs.push(Date.now() - attemptStartedAt);
                meta.attemptMs = attemptMs;
            }
        }
    }

    throw new Error(lastDetail || 'API request failed');
}

/** 最近一次生成请求的 resource timing：requestStart 有值说明请求已发出。 */
function lastGenerateTiming() {
    try {
        const entries = performance.getEntriesByType('resource')
            .filter((entry) => String(entry.name).includes('/api/backends/chat-completions/generate'));
        const last = entries[entries.length - 1];
        if (!last) return null;
        return {
            requestStart: Math.round(Number(last.requestStart) || 0),
            responseStart: Math.round(Number(last.responseStart) || 0),
            duration: Math.round(Number(last.duration) || 0),
            transferSize: Number(last.transferSize) || 0,
        };
    } catch {
        return null;
    }
}

/** 记录一轮结算的耗时与失败阶段，自动、手动、重算各自一条。 */
function recordSettleTrace(mode, startedAt, promptChars, extractionMeta, errorText, failedPrompt = '') {
    try {
        const traceState = getState();
        const trace = {
            at: new Date(startedAt).toISOString(),
            mode,
            promptChars: Number(promptChars) || 0,
            elapsedMs: Date.now() - startedAt,
            attempts: Number(extractionMeta?.attempts || 0),
            attemptMs: Array.isArray(extractionMeta?.attemptMs) ? extractionMeta.attemptMs : [],
            profileId: extractionMeta?.profileId || '',
            visibility: extractionMeta?.visibility || '',
            online: extractionMeta?.online,
            abortSettledMs: extractionMeta?.abortSettledMs ?? null,
            abortError: extractionMeta?.abortError || '',
            networkTiming: lastGenerateTiming(),
            error: String(errorText || '').slice(0, 200),
            // 失败时留存完整 prompt，可在本地用同一份内容复现，不必再靠猜。
            prompt: errorText ? String(failedPrompt || '').slice(0, 20000) : '',
        };
        const traces = Array.isArray(traceState.meta.settleTraces) ? traceState.meta.settleTraces : [];
        traces.push(trace);
        traceState.meta.settleTraces = traces.slice(-8);
        traceState.meta.lastSettleTrace = trace;
        saveState();
    } catch (err) {
        error('settle trace failed', err);
    }
}

async function settleLedger(options = {}) {
    const manual = Boolean(options.manual);
    // 自动结算被跳过时留下一行原因，避免“没跑”和“跑了但没记录”混在一起。
    const noteSkip = (reason) => {
        if (manual) return;
        try {
            const skipState = getState();
            skipState.meta.lastSettleSkip = {
                at: new Date().toISOString(),
                sinceSettle: Number(skipState.meta.messagesSinceSettle) || 0,
                reason,
            };
            saveState();
        } catch {
            // 记录失败不影响结算流程。
        }
    };
    if (settleRunning) {
        if (manual) setStatus('结算正在进行中，请稍候。');
        // 自动调用被重算/结算占着时不能直接丢，结束后必须补跑。
        else settleQueued = true;
        noteSkip('running');
        return null;
    }
    const ctx = getContext();
    const settings = getSettings();
    if (!settings.enabled) {
        if (manual) setStatus('台账已禁用。');
        noteSkip('disabled');
        return null;
    }
    if (!Array.isArray(ctx.chat) || ctx.chat.length === 0) {
        if (manual) setStatus('当前没有聊天消息可结算。');
        noteSkip('no-chat');
        return null;
    }
    if (!settings.useCurrentConnection && !getProfileId() && !settings.fallbackProfileId) {
        if (manual) setStatus('未选择提取连接配置，请先到设置里选择，或勾选“跟随当前连接”。');
        noteSkip('no-profile');
        return null;
    }
    if (getState().meta.messagesSinceSettle < (Number(settings.autoInterval) || 1) && !manual) {
        // 理论上入口已判断过，这里兜一层，防止补跑时条件已变。
        noteSkip('interval');
        return null;
    }
    if (generationActive && !manual) {
        // 叙事还在生成：此刻正文不完整，提取会造出正文里没有的角色。
        settleQueued = true;
        noteSkip('generating');
        return null;
    }

    settleRunning = true;
    settlePending = true;
    const settleStartedAt = Date.now();
    const extractionMeta = {};
    let settlePromptChars = 0;
    let settlePromptText = '';
    let settleError = '';
    armSettleWatchdog(manual ? 'manual' : 'auto', settleStartedAt);
    lockSending();
    renderStatusBar();
    setStatus('正在结算本幕…');
    try {
        const state = getState();
        if (detectAnchorMutation(ctx.chat, state.meta.lastProcessedMessage, state.meta.lastProcessedHash)) {
            const restored = restoreLedgerFromHistory('settle-mutation');
            setStatus(restored >= 0
                ? `检测到消息变动，台账已回放到 #${restored}…`
                : '台账没有可回放的版本，重新结算最近 20 条…');
        }
        const { messages, newFrom, to } = selectSettleMessages(ctx.chat, state.meta.lastProcessedMessage, {
            contextCount: 3,
            maxNew: 20,
            userName: ctx.name1,
            aiName: ctx.name2,
        });
        if (!messages.length) {
            const message = '没有新的消息需要结算。';
            setStatus(message);
            if (manual) toastInfo(message);
            return null;
        }
        // 提取期间正文可能被重新生成或 swipe：冻结目标消息的锚点与前缀，落账时挂回它原本那一版。
        const settleTargetIndex = Number(to);
        const settleTargetHash = ctx.chat[settleTargetIndex]
            ? messageHash(ctx.chat[settleTargetIndex])
            : '';
        const settlePrefixHashes = computePrefixHashes(ctx.chat);
        const { system, user } = buildExtractionPrompt(state, messages, {
            maxMessages: messages.length,
            newFrom,
            genreHint: settings.genreHint,
            skillLabel: getGenrePreset(settings.genrePreset).skillLabel,
            npcExtraFieldLabels: [getGenrePreset(settings.genrePreset).fieldLabels?.sect].filter(Boolean),
        });
        // 本轮结算最多 30 秒：首次请求、重试和解析失败重试共用这个截止时间。
        const extractionDeadline = Date.now() + EXTRACTION_TIMEOUT_MS;
        settlePromptChars = system.length + user.length;
        settlePromptText = `${system}\n\n${user}`;
        const raw = await callExtractionModel(system, user, settings.maxTokens, {
            deadline: extractionDeadline,
            meta: extractionMeta,
        });
        let parsed;
        let lastRaw = raw;
        try {
            parsed = parseExtractionResponse(raw);
        } catch (err) {
            // 模型偶尔会漏右括号；解析失败重试一次，不直接放弃整轮结算。
            log('提取 JSON 解析失败，重试一次', err.message);
            try {
                const retryRaw = await callExtractionModel(system, user, settings.maxTokens, {
                    deadline: extractionDeadline,
                    meta: extractionMeta,
                });
                lastRaw = retryRaw;
                parsed = parseExtractionResponse(retryRaw);
            } catch (retryErr) {
                settleError = errorDetail(retryErr);
                showExtractionFailure(classifyExtractionFailure(lastRaw, retryErr, extractionMeta));
                return null;
            }
        }
        if (parsed && !parsed.ops.length && typeof parsed.error === 'string' && parsed.error.trim()) {
            showExtractionFailure({ kind: 'refusal', detail: parsed.error.trim() });
            return null;
        }

        const protagonistAliases = [...PROTAGONIST_ALIASES, ctx.name1].filter(Boolean);
        // 场景日期先落进 scene：档位冷却和「最近同场」都要用当天的 day。
        const parsedScene = parsed.scene && typeof parsed.scene === 'object' ? parsed.scene : null;
        // 模型只写 advance 的单位，换算和累加由这里做。
        const parsedDay = parsedScene ? resolveSceneDay(state.scene.day, parsedScene) : null;
        const baseState = parsedDay === null || parsedDay === state.scene.day
            ? state
            : { ...state, scene: { ...state.scene, day: parsedDay } };
        // 记录本次新建的角色，回放时按原始 id 重建，避免按名字重新分配 id 造成串档。
        const beforeIds = new Set(Object.keys(state.characters || {}));
        const requestedOps = normalizeOpsAliases(parsed.ops);
        // applyOps 会原地改动状态，进度快照必须在应用之前取。
        const progressBefore = progressOf(baseState);
        const result = applyOps(baseState, requestedOps, {
            confidenceThreshold: settings.confidenceThreshold,
            tierVoteThreshold: settings.tierVoteThreshold,
            protagonistId: state.meta?.protagonistId || settings.protagonistId || PROTAGONIST_ID,
            reviewThreshold: 0.5,
            messageCount: ctx.chat.length,
            protagonistAliases,
            npcFields: npcFieldsOf(getGenrePreset(settings.genrePreset)),
        });

        const nextState = result.state;
        const normalizeRef = (value) => {
            const text = String(value ?? '').trim();
            return text && (text === PROTAGONIST_ID || protagonistAliases.includes(text)) ? PROTAGONIST_ID : value;
        };
        // The player has no in-story name; pin the reserved id instead of guessing.
        if (nextState.characters[PROTAGONIST_ID]) {
            nextState.meta.protagonistId = PROTAGONIST_ID;
            nextState.characters[PROTAGONIST_ID].tier = 'main';
        } else if (typeof parsed.protagonist === 'string' && parsed.protagonist.trim()) {
            const wanted = normalizeRef(parsed.protagonist.trim());
            const match = nextState.characters[wanted]
                || Object.values(nextState.characters).find((character) => character.name === wanted
                    || (character.aliases || []).includes(wanted));
            if (match) {
                nextState.meta.protagonistId = match.id;
                match.tier = 'main';
            }
        }
        if (parsed.scene && typeof parsed.scene === 'object') {
            nextState.scene = {
                time: parsed.scene.time || nextState.scene.time || '',
                // 漏写 day 时沿用旧值；第一次结算还没有 day 就从开局（第 1 天）起算。
                day: parsedDay ?? nextState.scene.day ?? 1,
                place: parsed.scene.place || nextState.scene.place || '',
                participants: Array.isArray(parsed.scene.participants)
                    ? parsed.scene.participants
                        .map(normalizeRef)
                        .map((name) => ensureCharacterRecord(nextState, name))
                        .filter(Boolean)
                        .map((character) => character.id)
                    : nextState.scene.participants,
            };
            for (const participant of nextState.scene.participants) {
                const name = String(participant || '').trim();
                if (!name) continue;
                const person = ensureCharacterRecord(nextState, name);
                // 顶层 scene 不走 set_scene op，这里也要记最近同场日，长期无往来才判得了。
                if (person && nextState.scene.day !== null) person.lastSeenDay = nextState.scene.day;
            }
        }
        // 开局（或旧数据）还没有内部日期时，从第 1 天起算。
        if (nextState.scene.day === null) nextState.scene.day = 1;
        const lastIndex = Number.isFinite(to) ? to : ctx.chat.length - 1;
        // 结算期间切到了别的 swipe：结果仍属于原来那一版，用冻结的锚点写回。
        const staleSwipe = Boolean(settleTargetHash)
            && messageHash(ctx.chat[lastIndex]) !== settleTargetHash;
        // 同一序号的不同 swipe 各留一条记录；只有正文完全相同的重复结算才替换。
        const currentHash = staleSwipe
            ? (settlePrefixHashes[lastIndex] || '')
            : (computePrefixHashes(ctx.chat)[lastIndex] || '');
        const history = (nextState.meta.history || []).filter((record) => (
            Number(record?.to) !== lastIndex || record.prefixHash !== currentHash
        ));
        // 场景来自 parsed.scene，不在 ops 里；不补成 op 的话，回放时这些只有名字的角色
        // 档案就会丢掉，关系栏只剩 npc_001｜未知｜未知。存显示名而不是 id，回放才认得出来。
        const sceneOps = parsed.scene && typeof parsed.scene === 'object'
            ? [{
                op: 'set_scene',
                scene: {
                    time: nextState.scene.time || '',
                    day: nextState.scene.day ?? null,
                    place: nextState.scene.place || '',
                    participants: (nextState.scene.participants || [])
                        .map((participant) => nextState.characters?.[participant]?.name || participant),
                },
            }]
            : [];
        // 公开项定期上调：按结算过的消息数计，把主角仍公开的字段/物品/功法升到朋友级。
        // 结果作为一条 promote_public 写进版本日志，回放时按同一条 op 复原。
        const promoteInterval = Math.max(0, Math.round(Number(settings.publicPromoteInterval) || 0));
        let promotionOp = null;
        if (promoteInterval > 0) {
            const anchor = Number(nextState.meta.lastPublicPromotionAt);
            const lastPromoted = Number.isFinite(anchor) ? anchor : -1;
            if (lastIndex - lastPromoted >= promoteInterval) {
                const promoted = promotePublicEntries(nextState, nextState.meta.protagonistId || PROTAGONIST_ID);
                nextState.meta.lastPublicPromotionAt = lastIndex;
                if (promoted > 0) promotionOp = { op: 'promote_public', count: promoted };
            }
        }
        const newCharacters = Object.values(nextState.characters || {})
            .filter((character) => !beforeIds.has(character.id))
            .map((character) => ({
                id: character.id,
                name: character.name,
                aliases: character.aliases || [],
            }));
        const record = {
            to: lastIndex,
            anchor: staleSwipe ? settleTargetHash : messageHash(ctx.chat[lastIndex]),
            prefixHash: currentHash,
            ops: [...result.applied, ...sceneOps, ...(promotionOp ? [promotionOp] : [])],
            characters: newCharacters,
            scene: { ...nextState.scene },
            progress: { before: progressBefore, after: progressOf(nextState) },
        };
        if (staleSwipe) {
            // 只补旧版的日志，不动当前分支的状态和游标；切回旧 swipe 时按锚点命中。
            const liveState = getState();
            const liveHistory = (liveState.meta?.history || []).filter((entry) => (
                Number(entry?.to) !== lastIndex || entry.anchor !== settleTargetHash
            ));
            liveHistory.push(record);
            liveState.meta.history = liveHistory;
            saveState();
            renderPanel();
            setStatus('本回合已重新生成，旧版结果已记在原来那一版上；切回旧版可以看到。');
            return null;
        }
        history.push(record);
        nextState.meta.history = history;
        // 以版本日志为准重建一次：上次结算留下的状态漂移（例如旧记录里的境界被
        // 这次批量提取漏掉）会在这里纠正，避免状态栏和日志各说各的。
        const settledBranch = selectHistoryBranch(history, ctx.chat);
        const settledNewest = settledBranch.length
            ? Number(settledBranch[settledBranch.length - 1].to)
            : lastIndex;
        const settledState = replayHistory(settledBranch, settledNewest);
        nextState.characters = settledState.characters;
        nextState.scene = settledState.scene;
        seedProtagonistName(nextState, ctx.name1);
        nextState.meta.nextCharacterId = Math.max(
            Number(nextState.meta.nextCharacterId) || 1,
            Number(settledState.meta?.nextCharacterId) || 1,
        );
        nextState.meta.lastProcessedMessage = settledNewest;
        nextState.meta.lastProcessedHash = ctx.chat[settledNewest]
            ? messageHash(ctx.chat[settledNewest])
            : '';
        nextState.meta.messagesSinceSettle = 0;
        nextState.meta.lastSettleAt = new Date().toISOString();
        nextState.meta.lastError = '';
        // 泄露由代码检测，不依赖提取模型自报。
        const leakActive = (nextState.scene?.participants || [])
            .filter((id) => id && id !== (nextState.meta?.protagonistId || PROTAGONIST_ID));
        const leakPreset = getGenrePreset(settings.genrePreset);
        nextState.meta.leaks = settings.leakCheck
            ? detectLeaks(
                nextState,
                collectAssistantText(ctx.chat, newFrom, lastIndex),
                leakActive,
                leakPreset.fieldLabels,
                { skillLabel: leakPreset.skillLabel },
            )
            : [];
        // 低置信 op 不落账，但要留一个入口：面板可以补采纳，否则等于静默丢弃。
        const pendingReview = Array.isArray(nextState.meta.review) ? nextState.meta.review : [];
        const freshReview = (result.review || []).map((op) => ({
            op,
            at: new Date().toISOString(),
            messageIndex: lastIndex,
        }));
        nextState.meta.review = [...pendingReview, ...freshReview].slice(-50);

        ctx.chatMetadata[MODULE_NAME] = nextState;
        // 保存统一交给 finally 里的追踪写入，避免一次结算触发两次 /api/chats/save。
        refreshInjection();
        renderPanel();
        lastExtractionFailure = { kind: '', at: 0 };
        // 待确认的档位票只是记了一票，没有真正落地，不能算进「应用」。
        const appliedCount = result.applied.filter((op) => !op?.pendingTier).length;
        setStatus(
            `结算完成（${((Date.now() - settleStartedAt) / 1000).toFixed(1)} 秒）：应用 ${appliedCount} 条，待复核 ${result.review.length} 条，拒绝 ${result.rejected.length} 条，泄露 ${nextState.meta.leaks.length} 条${promotionOp ? `，公开项上调 ${promotionOp.count} 条` : ''}。`,
        );
        // reveal 改变了谁知道，必须让用户当场看到；只提示真正改了档位的 reveal。
        notifyReveals((result.changedOps || []).filter((op) => op && op.op === 'reveal'), nextState);
        notifyLedgerChanges({
            newCharacters,
            changedOps: result.changedOps || [],
            pendingOps: result.pendingOps || [],
        }, nextState);
        log('settle result', result);
        return result;
    } catch (err) {
        settleError = errorDetail(err);
        showExtractionFailure(classifyExtractionFailure('', err, extractionMeta));
        error('settle failed', err);
        return null;
    } finally {
        clearSettleWatchdog();
        settleRunning = false;
        settlePending = false;
        // 等一拍，让 abort 的落地结果写进 meta 再落 trace。
        if (settleError && extractionMeta.attempts && extractionMeta.abortSettledMs == null) {
            await new Promise((resolve) => setTimeout(resolve, 60));
        }
        recordSettleTrace(manual ? 'manual' : 'auto', settleStartedAt, settlePromptChars, extractionMeta, settleError, settlePromptText);
        renderStatusBar();
        unlockSending('settle-done');
        // 结算期间到达的回复：本轮结束后立刻补一次，避免要等到再下一条消息。
        if (settleQueued) {
            settleQueued = false;
            setTimeout(() => {
                settleLedger().catch((err) => error('queued settle failed', err));
            }, 0);
        }
    }
}

async function waitForElement(selector, timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const el = document.querySelector(selector);
        if (el) return el;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
}

async function loadSettingsHtml() {
    await waitForElement('#extensions_settings2');
    const response = await fetch(`${EXTENSION_DIR}settings.html`);
    if (!response.ok) {
        throw new Error(`settings.html ${response.status}`);
    }
    const html = await response.text();
    $('#extensions_settings2').append(html);
}

function populateProfileSelect() {
    const ctx = getContext();
    const settings = getSettings();
    const profiles = ctx.extensionSettings?.connectionManager?.profiles ?? [];
    const selected = ctx.extensionSettings?.connectionManager?.selectedProfile ?? '';

    const fill = (id, current, emptyLabel) => {
        const select = document.getElementById(id);
        if (!select) return;
        select.innerHTML = '';
        const empty = document.createElement('option');
        empty.value = '';
        empty.textContent = emptyLabel;
        select.appendChild(empty);
        for (const profile of profiles) {
            const option = document.createElement('option');
            option.value = profile.id;
            option.textContent = profile.name || profile.id;
            select.appendChild(option);
        }
        select.value = profiles.some((p) => p.id === current) ? current : '';
    };

    fill('factledger_profile', settings.profileId || selected || '', '（跟随当前连接）');
    fill('factledger_fallback_profile', settings.fallbackProfileId || '', '（不启用备选）');
}

function bindGenreControls() {
    const settings = getSettings();
    const select = document.getElementById('factledger_genre_preset');
    const hint = document.getElementById('factledger_genre_hint');

    if (select) {
        select.innerHTML = '';
        for (const preset of listGenrePresets()) {
            const option = document.createElement('option');
            option.value = preset.id;
            option.textContent = preset.label;
            select.appendChild(option);
        }
        select.value = settings.genrePreset;
        select.addEventListener('change', () => {
            const oldPreset = getGenrePreset(settings.genrePreset);
            settings.genrePreset = select.value;
            const newPreset = getGenrePreset(select.value);
            if (select.value !== 'custom') {
                settings.genreHint = newPreset.hint;
                if (hint) hint.value = settings.genreHint;
            }
            const currentRules = String(settings.narrativeRules || '');
            if (!currentRules.trim() || currentRules === (oldPreset.narrativeRules || '')) {
                settings.narrativeRules = newPreset.narrativeRules || '';
                const rulesEl = document.getElementById('factledger_narrative_rules');
                if (rulesEl) rulesEl.value = settings.narrativeRules;
            }
            saveSettings();
            refreshInjection();
            renderPanel();
        });
    }

    if (hint) {
        hint.value = settings.genreHint;
        hint.addEventListener('change', () => {
            settings.genreHint = hint.value;
            saveSettings();
        });
    }
}

function bindSettings() {
    const settings = getSettings();

    const bindCheckbox = (id, key) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.checked = Boolean(settings[key]);
        el.addEventListener('change', () => {
            settings[key] = el.checked;
            saveSettings();
            refreshInjection();
            renderPanel();
        });
    };

    const bindNumber = (id, key, transform = Number) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = settings[key];
        el.addEventListener('change', () => {
            const value = transform(el.value);
            if (Number.isFinite(value)) {
                settings[key] = value;
                saveSettings();
                refreshInjection();
                renderPanel();
            }
        });
    };

    bindCheckbox('factledger_enabled', 'enabled');
    bindCheckbox('factledger_status_bar', 'statusBarEnabled');
    bindCheckbox('factledger_use_current', 'useCurrentConnection');
    bindCheckbox('factledger_extraction_preset', 'extractionIncludePreset');
    bindCheckbox('factledger_knowledge_gate', 'knowledgeGate');
    bindCheckbox('factledger_leak_check', 'leakCheck');
    bindCheckbox('factledger_show_others', 'showOthers');
    bindCheckbox('factledger_narrative_rules_toggle', 'injectNarrativeRules');
    bindCheckbox('factledger_auto_resettle', 'autoResettleOnEdit');

    bindNumber('factledger_auto_interval', 'autoInterval');
    bindNumber('factledger_public_promote_interval', 'publicPromoteInterval');
    bindNumber('factledger_tier_votes', 'tierVoteThreshold');
    bindNumber('factledger_max_tokens', 'maxTokens');
    bindNumber('factledger_confidence', 'confidenceThreshold');
    bindNumber('factledger_inject_budget', 'injectBudget');
    bindNumber('factledger_inject_depth', 'injectDepth');

    const positionEl = document.getElementById('factledger_inject_position');
    if (positionEl) {
        positionEl.value = settings.injectPosition;
        positionEl.addEventListener('change', () => {
            settings.injectPosition = positionEl.value;
            saveSettings();
            refreshInjection();
        });
    }

    const rulesEl = document.getElementById('factledger_narrative_rules');
    if (rulesEl) {
        rulesEl.value = settings.narrativeRules || '';
        rulesEl.addEventListener('change', () => {
            settings.narrativeRules = rulesEl.value;
            saveSettings();
            refreshInjection();
        });
    }

    document.getElementById('factledger_restore_rules')?.addEventListener('click', () => {
        const preset = getGenrePreset(settings.genrePreset);
        const text = preset.narrativeRules || '';
        if (!text) {
            setStatus('当前题材没有默认叙事规则');
            return;
        }
        if (rulesEl && rulesEl.value.trim() && rulesEl.value.trim() !== text.trim()) {
            if (!confirm('用当前题材的默认规则覆盖文本框？')) return;
        }
        if (rulesEl) rulesEl.value = text;
        settings.narrativeRules = text;
        settings.injectNarrativeRules = true;
        const toggle = document.getElementById('factledger_narrative_rules_toggle');
        if (toggle) toggle.checked = true;
        saveSettings();
        refreshInjection();
        setStatus('已恢复当前题材的默认叙事规则');
    });

    bindGenreControls();
    populateProfileSelect();
    populateProtagonistSelect();
    const profileSelect = document.getElementById('factledger_profile');
    if (profileSelect) {
        profileSelect.addEventListener('change', () => {
            settings.profileId = profileSelect.value;
            saveSettings();
        });
    }

    const fallbackSelect = document.getElementById('factledger_fallback_profile');
    if (fallbackSelect) {
        fallbackSelect.addEventListener('change', () => {
            settings.fallbackProfileId = fallbackSelect.value;
            saveSettings();
        });
    }

    document.getElementById('factledger_open_panel')?.addEventListener('click', () => togglePanel(true));
    document.getElementById('factledger_settle')?.addEventListener('click', () => {
        settleLedger({ manual: true });
    });
    document.getElementById('factledger_export')?.addEventListener('click', exportState);
    document.getElementById('factledger_import')?.addEventListener('click', () => {
        document.getElementById('factledger_import_file')?.click();
    });
    document.getElementById('factledger_import_file')?.addEventListener('change', importState);
}

function createMenuButton() {
    if (document.getElementById('factledger_menu_button')) return;
    const container = document.getElementById('extensionsMenu');
    if (!container) {
        log('extensionsMenu not found, skip menu button');
        return;
    }
    const button = document.createElement('div');
    button.id = 'factledger_menu_button';
    button.className = 'list-group-item flex-container flexGap5';
    button.title = '事实台账';
    button.innerHTML = '<div class="fa-solid fa-book"></div><span>事实台账</span>';
    button.addEventListener('click', () => togglePanel());
    container.appendChild(button);
}

function makeDraggable(element, handleSelector) {
    if (!element || element.dataset.dragBound === '1') return;
    element.dataset.dragBound = '1';
    let drag = null;
    element.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        const handle = event.target.closest(handleSelector);
        if (!handle || !element.contains(handle)) return;
        if (event.target.closest('button, input, textarea, select, a, .factledger-close, .factledger-collapse, .factledger-statusbar-open')) return;
        const rect = element.getBoundingClientRect();
        drag = { startX: event.clientX, startY: event.clientY, left: rect.left, top: rect.top };
        element.style.left = rect.left + 'px';
        element.style.top = rect.top + 'px';
        element.style.right = 'auto';
        element.style.bottom = 'auto';
        element.classList.add('factledger-dragging');
        event.preventDefault();
    });
    window.addEventListener('pointermove', (event) => {
        if (!drag) return;
        const left = Math.min(Math.max(0, window.innerWidth - 80), Math.max(0, drag.left + event.clientX - drag.startX));
        const top = Math.min(Math.max(0, window.innerHeight - 40), Math.max(0, drag.top + event.clientY - drag.startY));
        element.style.left = left + 'px';
        element.style.top = top + 'px';
    });
    window.addEventListener('pointerup', () => {
        if (!drag) return;
        drag = null;
        element.classList.remove('factledger-dragging');
    });
}

function createPanel() {
    if (document.getElementById('factledger_panel')) return;

    const panel = document.createElement('div');
    panel.id = 'factledger_panel';
    panel.className = 'factledger-panel';
    panel.innerHTML = `
        <div class="factledger-header">
            <span>事实台账 <span class="factledger-muted">v${VERSION}</span></span>
            <span class="factledger-header-actions">
                <span class="factledger-collapse" title="收起">▾</span>
                <span class="factledger-close" title="关闭">✕</span>
            </span>
        </div>
        <div class="factledger-tabs">
            ${TABS.map((tab) => `<div class="factledger-tab" data-tab="${tab.id}">${tab.label}</div>`).join('')}
        </div>
        <div class="factledger-body" id="factledger_body"></div>
        <div class="factledger-footer">
            <button class="menu_button" id="factledger_panel_settle">结算本幕</button>
            <button class="menu_button" id="factledger_panel_edit">编辑 JSON</button>
            <button class="menu_button" id="factledger_panel_export">导出</button>
            <button class="menu_button" id="factledger_panel_import">导入</button>
            <button class="menu_button" id="factledger_panel_refresh">刷新</button>
            <button class="menu_button" id="factledger_panel_close">关闭</button>
        </div>
    `;
    document.body.appendChild(panel);
    makeDraggable(panel, '.factledger-header');

    panel.querySelector('.factledger-collapse')?.addEventListener('click', (event) => {
        event.stopPropagation();
        const collapsed = panel.classList.toggle('collapsed');
        const icon = panel.querySelector('.factledger-collapse');
        if (icon) {
            icon.textContent = collapsed ? '▸' : '▾';
            icon.title = collapsed ? '展开' : '收起';
        }
    });

    panel.querySelector('.factledger-close')?.addEventListener('click', () => togglePanel(false));
    panel.querySelector('#factledger_panel_close')?.addEventListener('click', () => togglePanel(false));
    panel.querySelector('#factledger_panel_refresh')?.addEventListener('click', () => renderPanel());
    panel.querySelector('#factledger_panel_edit')?.addEventListener('click', () => openJsonEditor());
    panel.querySelector('#factledger_panel_settle')?.addEventListener('click', () => {
        settleLedger({ manual: true });
    });
    panel.querySelector('#factledger_panel_export')?.addEventListener('click', exportState);
    panel.querySelector('#factledger_panel_import')?.addEventListener('click', () => {
        document.getElementById('factledger_import_file')?.click();
    });
    panel.querySelectorAll('.factledger-tab').forEach((el) => {
        el.addEventListener('click', () => {
            activeTab = el.dataset.tab;
            renderPanel();
        });
    });
}

function togglePanel(force) {
    const panel = document.getElementById('factledger_panel');
    if (!panel) return;
    panelVisible = typeof force === 'boolean' ? force : !panelVisible;
    panel.classList.toggle('open', panelVisible);
    if (panelVisible) renderPanel();
}

function renderCharacters(body) {
    const state = getState();
    const preset = getGenrePreset(getSettings().genrePreset);
    const characters = Object.values(state.characters);
    if (!characters.length) {
        body.innerHTML = '<div class="factledger-empty">还没有角色。点击“结算本幕”或导入 JSON。</div>';
        return;
    }
    body.innerHTML = characters
        .map((character) => {
            const stateEntries = character.state && typeof character.state === 'object'
                ? Object.entries(character.state)
                    .map(([key, value]) => `${preset.fieldLabels?.[key] || key}: ${value?.current ?? ''}`)
                    .join('；')
                : '';
            const items = (character.items || [])
                .filter((item) => item.validTo == null)
                .map((item) => {
                    const quantity = Number(item.quantity ?? 1);
                    const unit = item.unit || '';
                    return item.kind === 'currency' || quantity !== 1
                        ? `${item.name}×${quantity}${unit}`
                        : item.name;
                })
                .join('、');
            const skills = currentSkills(character)
                .map((skill) => `${skill.name}${skill.level ? `(${skill.level})` : ''}`)
                .join('、');
            return `
                <div class="factledger-card">
                    <div class="factledger-card-head">
                        <strong>${escapeHtml(character.name || character.id)}</strong>
                        <span class="factledger-muted">${escapeHtml(TIER_LABELS[character.tier] || character.tier || '')}</span>
                    </div>
                    <div class="factledger-muted">${escapeHtml(stateEntries || '无状态字段')}</div>
                    <div class="factledger-muted">物品：${escapeHtml(items || '无')}</div>
                    <div class="factledger-muted">${escapeHtml(preset.skillLabel || '技能')}：${escapeHtml(skills || '无')}</div>
                </div>
            `;
        })
        .join('');
}

/** 把一条 op 说成中文；认不出的旧版 op 返回空串。 */
function describeLedgerOp(op, state, preset) {
    if (!op || typeof op !== 'object') return '';
    const name = (ref) => displayName(state, ref);
    const fieldLabel = (field) => preset.fieldLabels?.[field] || field;
    const refText = (raw) => {
        const key = String(raw && typeof raw === 'object' ? (raw.name || raw.id || '') : raw ?? '').trim();
        return key;
    };
    const itemLabel = (raw) => {
        const key = refText(raw);
        if (!key) return '';
        for (const character of Object.values(state.characters || {})) {
            for (const item of character.items || []) {
                if (item.id === key || item.name === key) return item.name;
            }
        }
        return key;
    };
    const traitLabel = (raw) => {
        const key = refText(raw);
        if (!key) return '';
        for (const character of Object.values(state.characters || {})) {
            for (const trait of character.skills || []) {
                if (trait.id === key || trait.name === key) return trait.name;
            }
        }
        return key;
    };
    switch (op.op) {
        case 'set':
            return `${name(op.character)} · ${fieldLabel(op.field)}：${op.value ?? ''}`;
        case 'set_tier': {
            const access = ACCESS_LABELS[op.access] || op.access || '';
            const reason = op.reason ? `（${op.reason}）` : '';
            if (op.pendingTier) {
                return `${name(op.character)} 的知情档位待确认 → ${access} ${op.pendingTier.count}/${op.pendingTier.required}${reason}`;
            }
            return `${name(op.character)} 的知情档位 → ${access}${reason}`;
        }
        case 'set_relation': {
            const detail = op.type || '';
            return `${name(op.from)} → ${name(op.to)}：${detail || '关系更新'}`;
        }
        case 'add_item':
            return `${name(op.character)} 获得 ${itemLabel(op.item)}`;
        case 'adjust_item': {
            const delta = Number(op.delta) || 0;
            return `${itemLabel(op.item)} ${delta >= 0 ? '+' : ''}${delta}${op.reason ? `（${op.reason}）` : ''}`;
        }
        case 'set_item_quantity':
            return `${itemLabel(op.item)} 数量 → ${op.quantity}`;
        case 'remove_item':
            return `${name(op.character)} 失去 ${itemLabel(op.item)}${op.reason ? `（${op.reason}）` : ''}`;
        case 'move_item':
            return `${itemLabel(op.item)} → ${name(op.to)}`;
        case 'clear_items':
            return `${name(op.character)} 清空物品${Array.isArray(op.kinds) && op.kinds.length ? `（${op.kinds.join('、')}）` : ''}`;
        case 'clear_currency':
            return `${name(op.character)} 清空钱财`;
        case 'promote_public':
            return `公开项定期上调：${op.count ? `${op.count} 项` : '公开项'} → 朋友级`;
        case 'add_skill':
            return `${name(op.character)} 习得${preset.skillLabel || '技能'} ${traitLabel(op.skill)}`;
        case 'set_skill':
            return `${preset.skillLabel || '技能'} ${traitLabel(op.skill)}${op.level ? ` → ${op.level}` : ' 更新'}`;
        case 'remove_skill':
            return `${name(op.character)} 失去${preset.skillLabel || '技能'} ${traitLabel(op.skill)}`;
        case 'reveal': {
            if (op.belief) return `${name(op.to)} 误以为「${op.belief}」`;
            if (op.suspicion) return `${name(op.to)} 起疑「${op.suspicion}」`;
            const method = op.method ? `（${op.method}）` : '';
            return `${name(op.to)} 知道了「${revealTargetLabel(op, state)}」${method}`;
        }
        case 'rename_character': {
            const person = op.id ? state.characters?.[op.id] : null;
            const oldName = person?.aliases?.[0] || '临时名';
            return `改名：${oldName} → ${person?.name || op.name || ''}`;
        }
        case 'merge_character':
            return `合并档案 → ${name(op.toId || op.to)}`;
        // 场景已在卡片顶部单独显示；旧版 add_fact 等已停用。
        default:
            return '';
    }
}

function renderHistory(body) {
    const state = getState();
    const preset = getGenrePreset(getSettings().genrePreset);
    const history = Array.isArray(state.meta?.history) ? state.meta.history : [];
    if (!history.length) {
        body.innerHTML = '<div class="factledger-empty">还没有结算日志。</div>';
        return;
    }
    const shown = history.slice(-20).reverse();
    const chat = Array.isArray(getContext().chat) ? getContext().chat : [];
    // 正文改过、当前分支里已经没有对应记录的序号；这些轮次可以单独重算。
    const lost = lostHistoryIndices(chat, history).filter((index) => chat[index] && !chat[index].is_user);
    body.innerHTML = `
        <div class="factledger-muted">共 ${history.length} 条结算记录，显示最近 ${shown.length} 条。</div>
        ${lost.length ? `
            <div class="factledger-card">
                <div class="factledger-card-head">
                    <strong>正文已改</strong>
                    <span class="factledger-badge err">${lost.length} 条失效</span>
                </div>
                <div class="factledger-muted">这些消息改过之后，原来的提取记录不再生效；重算只会替换这一轮。</div>
                <div class="factledger-actions">
                    ${lost.map((index) => `<button class="menu_button" data-resettle="${index}">重算 #${index}</button>`).join('')}
                </div>
            </div>
        ` : ''}
        ${shown.map((record) => {
            const scene = record.scene || {};
            const ops = (Array.isArray(record.ops) ? record.ops : []).filter((op) => op?.op !== 'set_scene');
            const lines = ops.map((op) => describeLedgerOp(op, state, preset)).filter(Boolean);
            const skipped = ops.length - lines.length;
            const personNames = (scene.participants || [])
                .map((participant) => displayName(state, participant))
                .filter(Boolean);
            const sceneTime = sceneTimeLabel(scene);
            const meta = [
                sceneTime ? `时间：${sceneTime}` : '',
                scene.place ? `地点：${scene.place}` : '',
                personNames.length ? `在场：${personNames.join('、')}` : '',
            ].filter(Boolean).join('｜');
            return `
                <div class="factledger-card">
                    <div class="factledger-card-head">
                        <strong>至 #${escapeHtml(String(record.to ?? ''))}</strong>
                        <span class="factledger-badge">${lines.length} 项变更</span>
                    </div>
                    <div class="factledger-muted">${escapeHtml(meta || '无场景信息')}</div>
                    ${lines.length
                        ? `<ul class="factledger-log-list">${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`
                        : '<div class="factledger-muted">本幕没有可展示的变更。</div>'}
                    ${skipped > 0 ? `<div class="factledger-muted">另有 ${skipped} 条旧版记录已停用，不再展示。</div>` : ''}
                </div>
            `;
        }).join('')}
    `;
    body.querySelectorAll('[data-resettle]').forEach((button) => {
        button.addEventListener('click', () => resettleMessage(Number(button.dataset.resettle)));
    });
}

function isGated(entity) {
    return entityAccess(entity, 'public') !== 'public';
}

/** 一行说明：档位 + 当前够格知道的人。 */
function knowledgeSummary(entity, state) {
    const access = entityAccess(entity, 'public');
    if (access === 'public') return '公开';
    const names = Object.values(state?.characters || {})
        .filter((character) => knowsEntity(entity, character.id, state, 'public'))
        .map((character) => (character.id === PROTAGONIST_ID ? '你' : (character.name || character.id)));
    return `${ACCESS_LABELS[access] || access}｜知情：${names.join('、') || '无'}`;
}

function renderKnowledge(body) {
    const state = getState();
    const protagonistId = getProtagonist()?.id || '';
    const preset = getGenrePreset(getSettings().genrePreset);
    const fieldLabel = (field) => preset.fieldLabels?.[field] || field;
    const cards = [];

    for (const character of Object.values(state.characters)) {
        // 只有主角自己的秘密需要标注知情者；NPC 自身信息公开。
        if (character.id !== protagonistId) continue;
        // 认知页只列主角的秘密，主体统一写「你」，不显示内部 id。
        const name = '你';
        for (const [field, entry] of Object.entries(character.state || {})) {
            if (!isGated(entry)) continue;
            cards.push({
                type: '字段',
                subject: `${name} · ${fieldLabel(field)}`,
                text: `${entry.current ?? entry}`,
                access: entityAccess(entry, 'public'),
                known: knowledgeSummary(entry, state),
                ref: { kind: 'field', charId: character.id, field },
            });
        }
        // 数量归零的条目（用光的丹药、花完的货币）等同于失去，不再留在认知页。
        for (const item of (character.items || []).filter((item) => (
            item.validTo == null && Number(item.quantity ?? 1) > 0 && isGated(item)
        ))) {
            const quantity = Number(item.quantity ?? 1);
            const unit = item.unit || '';
            const quantityText = item.kind === 'currency' || quantity !== 1 ? `×${quantity}${unit}` : '';
            cards.push({
                type: '物品',
                subject: `${name} · 持有`,
                text: `${item.name}${quantityText}`,
                access: entityAccess(item, 'public'),
                known: knowledgeSummary(item, state),
                ref: { kind: 'item', charId: character.id, itemId: item.id },
            });
        }
        for (const relation of (character.relations || []).filter((relation) => relation.validTo == null && isGated(relation))) {
            cards.push({
                type: '关系',
                subject: `${name} → ${relation.targetName || relation.target}`,
                text: relation.type || '关系',
                access: entityAccess(relation, 'public'),
                known: knowledgeSummary(relation, state),
                ref: { kind: 'relation', charId: character.id, target: relation.target || relation.targetName },
            });
        }
        for (const skill of (character.skills || []).filter((skill) => skill.validTo == null && isGated(skill))) {
            cards.push({
                type: preset.skillLabel || '技能',
                subject: `${name} · ${preset.skillLabel || '技能'}`,
                text: `${skill.name}${skill.level ? `（${skill.level}）` : ''}`,
                access: entityAccess(skill, 'public'),
                known: knowledgeSummary(skill, state),
                ref: { kind: 'skill', charId: character.id, traitId: skill.id },
            });
        }
    }

    knowledgeEntries = cards;

    if (!cards.length) {
        body.innerHTML = '<div class="factledger-empty">还没有需要标注知情者的秘密。</div>';
        return;
    }

    body.innerHTML = cards
        .map((card, index) => {
            const deletable = card.ref.kind === 'item' || card.ref.kind === 'skill';
            return `
            <div class="factledger-card">
                <div class="factledger-card-head">
                    <strong class="factledger-card-subject">${escapeHtml(card.subject || '')}</strong>
                    <span class="factledger-badge ${card.access === 'protagonist' ? 'warn' : 'ok'}">${escapeHtml(card.type)} · ${escapeHtml(ACCESS_LABELS[card.access] || card.access)}</span>
                </div>
                <div class="factledger-card-text">${escapeHtml(card.text || '')}</div>
                <div class="factledger-card-foot">
                    <span class="factledger-muted">${escapeHtml(card.known)}</span>
                    <button class="menu_button factledger-edit-entry" data-index="${index}">编辑</button>
                    <button class="menu_button factledger-edit-known" data-index="${index}">编辑档位</button>
                    ${deletable ? `<button class="menu_button factledger-delete-known" data-index="${index}">删除</button>` : ''}
                </div>
            </div>
        `;
        })
        .join('');

    body.querySelectorAll('.factledger-edit-entry').forEach((button) => {
        button.addEventListener('click', () => {
            const entry = knowledgeEntries[Number(button.dataset.index)];
            if (entry) openKnowledgeEditor(entry);
        });
    });
    body.querySelectorAll('.factledger-edit-known').forEach((button) => {
        button.addEventListener('click', () => {
            const entry = knowledgeEntries[Number(button.dataset.index)];
            if (entry) openKnownByEditor(entry);
        });
    });
    body.querySelectorAll('.factledger-delete-known').forEach((button) => {
        button.addEventListener('click', () => {
            const entry = knowledgeEntries[Number(button.dataset.index)];
            if (entry) deleteKnowledgeEntity(entry);
        });
    });
}

function resolveEntity(ref) {
    const state = getState();
    switch (ref?.kind) {
        case 'field':
            return state.characters[ref.charId]?.state?.[ref.field];
        case 'item':
            return state.characters[ref.charId]?.items?.find((item) => item.id === ref.itemId && item.validTo == null);
        case 'relation':
            return state.characters[ref.charId]?.relations?.find((relation) => (
                relation.validTo == null && (relation.target === ref.target || relation.targetName === ref.target)
            ));
        case 'skill':
            return state.characters[ref.charId]?.skills?.find((skill) => skill.validTo == null && skill.id === ref.traitId);
        default:
            return null;
    }
}

/** 手动删除物品/功法：关闭当前条目，并把 remove op 追加到当前分支，回放时不复活。 */
function deleteKnowledgeEntity(card) {
    const state = getState();
    const entity = resolveEntity(card.ref);
    if (!entity) {
        setStatus('找不到要删除的对象，可能已被删除。');
        renderPanel();
        return;
    }
    const preset = getGenrePreset(getSettings().genrePreset);
    const isSkill = card.ref.kind === 'skill';
    const label = isSkill ? (preset.skillLabel || '技能') : '物品';
    const name = entity.name || card.text || '';
    const confirmed = typeof window.confirm !== 'function'
        || window.confirm(`从台账删除${label}「${name}」？只删台账记录，不改正文。`);
    if (!confirmed) return;

    const op = isSkill
        ? { op: 'remove_skill', character: card.ref.charId, skill: entity.id || entity.name, reason: '手动删除' }
        : { op: 'remove_item', character: card.ref.charId, item: entity.id || entity.name, reason: '手动删除' };
    const appended = appendManualOp(state.meta?.history || [], getContext().chat || [], op);
    entity.validTo = sceneTimeLabel(state.scene) || '手动删除';
    saveState();
    refreshInjection();
    renderPanel();
    setStatus(appended
        ? `已从台账删除${label}「${name}」。`
        : `已从当前台账删除${label}「${name}」，但没有可写入的日志记录，重算后可能恢复。`);
}

/** 认知页改档位：按条目类型构造只改 access 的手动 op。 */
function accessOp(ref, entity, access) {
    switch (ref?.kind) {
        case 'field':
            return { op: 'set', character: ref.charId, field: ref.field, value: entity.current ?? entity, access, manual: true };
        case 'item':
            return { op: 'add_item', character: ref.charId, item: { id: entity.id, name: entity.name, access }, access, manual: true };
        case 'relation':
            return {
                op: 'set_relation',
                from: ref.charId,
                to: entity.target || entity.targetName,
                type: entity.type || '',
                access,
                manual: true,
            };
        case 'skill':
            return {
                op: 'add_skill',
                character: ref.charId,
                skill: { id: entity.id, name: entity.name, level: entity.level || '', access },
                access,
                manual: true,
            };
        default:
            return null;
    }
}

function openKnownByEditor(card) {
    const state = getState();
    const entity = resolveEntity(card.ref);
    if (!entity) {
        setStatus('找不到要编辑的对象，可能已被删除。');
        return;
    }

    const current = entityAccess(entity, 'public');
    const options = ACCESS_LEVELS
        .map((level) => `<option value="${level}" ${level === current ? 'selected' : ''}>${ACCESS_LABELS[level]}</option>`)
        .join('');
    const note = '档位越高，能知道的人越少：主角级只有你自己，公开级人人皆知。';

    document.getElementById('factledger_known_modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'factledger_known_modal';
    modal.className = 'factledger-modal';
    modal.innerHTML = `
        <div class="factledger-modal-content">
            <div class="factledger-modal-head">
                <strong>编辑档位</strong>
                <span class="factledger-modal-close" title="关闭">✕</span>
            </div>
            <div class="factledger-muted">对象：${escapeHtml(card.subject || card.type)}${card.text ? `｜${escapeHtml(card.text)}` : ''}</div>
            <div class="factledger-row">
                <label for="factledger_known_access">知情档位</label>
                <select id="factledger_known_access">${options}</select>
            </div>
            <div class="factledger-hint">${escapeHtml(note)}</div>
            <div class="factledger-actions">
                <button class="menu_button" id="factledger_known_save">保存</button>
                <button class="menu_button" id="factledger_known_cancel">取消</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    const close = () => modal.remove();
    modal.querySelector('.factledger-modal-close')?.addEventListener('click', close);
    modal.querySelector('#factledger_known_cancel')?.addEventListener('click', close);
    modal.querySelector('#factledger_known_save')?.addEventListener('click', () => {
        const selected = normalizeAccess(document.getElementById('factledger_known_access')?.value || current, current);
        const op = accessOp(card.ref, entity, selected);
        if (!op) {
            setStatus('这条记录不支持改档位。');
            return;
        }
        // 档位也要写进日志：只改内存的话，删回合或刷新回放就会退回默认档。
        const prepared = { evidence: 'manual', confidence: 1, ...op };
        const preset = getGenrePreset(getSettings().genrePreset);
        let result;
        try {
            result = applyOps(state, [prepared], {
                confidenceThreshold: 0,
                reviewThreshold: 0,
                npcFields: [preset.levelField].filter(Boolean),
            });
        } catch (err) {
            setStatus(`保存失败：${err.message}`);
            return;
        }
        if (result.rejected?.length) {
            setStatus(`保存失败：${result.rejected[0].reason || '未知原因'}`);
            return;
        }
        appendManualOp(state.meta?.history || [], getContext().chat || [], prepared);
        saveState();
        refreshInjection();
        close();
        renderPanel();
        setStatus(`已把「${card.subject || card.type}」改为${ACCESS_LABELS[selected]}。`);
    });
}

/** 认知页手动编辑：字段改值，物品改名称/数量，关系改称谓，功法改名称/层次。 */
function openKnowledgeEditor(card) {
    const state = getState();
    const entity = resolveEntity(card.ref);
    if (!entity) {
        setStatus('找不到要编辑的对象，可能已被删除。');
        return;
    }
    const preset = getGenrePreset(getSettings().genrePreset);
    const kind = card.ref.kind;
    const row = (id, label, value, { type = 'text', multiline = false } = {}) => `
        <div class="factledger-row">
            <label for="factledger_edit_${id}">${escapeHtml(label)}</label>
            ${multiline
                ? `<textarea id="factledger_edit_${id}" rows="3">${escapeHtml(String(value ?? ''))}</textarea>`
                : `<input id="factledger_edit_${id}" class="text_pole" type="${type}" value="${escapeHtml(String(value ?? ''))}" />`}
        </div>
    `;
    let rows = '';
    if (kind === 'field') {
        rows = row('value', '值', entity.current ?? entity, { multiline: true });
    } else if (kind === 'item') {
        rows = row('name', '名称', entity.name)
            + row('quantity', '数量', entity.quantity ?? 1, { type: 'number' });
    } else if (kind === 'relation') {
        rows = row('type', '关系', entity.type);
    } else if (kind === 'skill') {
        rows = row('name', '名称', entity.name)
            + row('level', '层次', entity.level);
    } else {
        setStatus('这条记录不支持编辑。');
        return;
    }

    document.getElementById('factledger_edit_modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'factledger_edit_modal';
    modal.className = 'factledger-modal';
    modal.innerHTML = `
        <div class="factledger-modal-content">
            <div class="factledger-modal-head">
                <strong>编辑词条</strong>
                <span class="factledger-modal-close" title="关闭">✕</span>
            </div>
            <div class="factledger-muted">对象：${escapeHtml(card.subject || card.type)}</div>
            ${rows}
            <div class="factledger-hint">只改台账记录，不改正文；回放与刷新后仍然生效。</div>
            <div class="factledger-hint" id="factledger_edit_error"></div>
            <div class="factledger-actions">
                <button class="menu_button" id="factledger_edit_save">保存</button>
                <button class="menu_button" id="factledger_edit_cancel">取消</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    const close = () => modal.remove();
    const valueOf = (id) => String(document.getElementById(`factledger_edit_${id}`)?.value ?? '').trim();
    const showError = (message) => {
        const el = modal.querySelector('#factledger_edit_error');
        if (el) el.textContent = message;
        setStatus(message);
    };
    const finish = (ops) => {
        // 手动编辑也要带证据：applyOps 会先校验，缺 evidence 会被整条拒绝。
        const prepared = ops.map((op) => ({ evidence: 'manual', confidence: 1, ...op }));
        let result;
        try {
            result = applyOps(state, prepared, {
                confidenceThreshold: 0,
                reviewThreshold: 0,
                npcFields: [preset.levelField].filter(Boolean),
            });
        } catch (err) {
            showError(`保存失败：${err.message}`);
            return;
        }
        if (result.rejected?.length) {
            showError(`保存失败：${result.rejected[0].reason || '未知原因'}`);
            return;
        }
        for (const op of prepared) {
            appendManualOp(state.meta?.history || [], getContext().chat || [], op);
        }
        saveState();
        refreshInjection();
        close();
        renderPanel();
        setStatus(`已更新「${card.subject || card.type}」。`);
    };

    modal.querySelector('.factledger-modal-close')?.addEventListener('click', close);
    modal.querySelector('#factledger_edit_cancel')?.addEventListener('click', close);
    modal.querySelector('#factledger_edit_save')?.addEventListener('click', () => {
        const charId = card.ref.charId;
        const ops = [];
        if (kind === 'field') {
            const value = valueOf('value');
            if (!value) { showError('值不能为空。'); return; }
            if (value !== String(entity.current ?? entity ?? '')) {
                ops.push({ op: 'set', character: charId, field: card.ref.field, value, manual: true });
            }
        } else if (kind === 'item') {
            const name = valueOf('name');
            const quantity = Number(valueOf('quantity'));
            if (!name) { showError('物品名称不能为空。'); return; }
            if (!Number.isFinite(quantity) || quantity < 0) { showError('数量必须是不小于 0 的数字。'); return; }
            if (name !== entity.name) {
                ops.push({
                    op: 'add_item',
                    character: charId,
                    item: {
                        id: entity.id,
                        name,
                        kind: entity.kind || 'item',
                        access: entityAccess(entity, 'public'),
                    },
                });
            }
            if (quantity !== Number(entity.quantity ?? 1)) {
                ops.push({ op: 'set_item_quantity', character: charId, item: entity.id, quantity });
            }
        } else if (kind === 'relation') {
            const type = valueOf('type');
            if (!type) { showError('关系不能为空。'); return; }
            if (type !== (entity.type || '')) {
                ops.push({ op: 'set_relation', from: charId, to: entity.target || entity.targetName, type });
            }
        } else if (kind === 'skill') {
            const name = valueOf('name');
            const level = valueOf('level');
            if (!name) { showError('功法名称不能为空。'); return; }
            if (name !== entity.name) {
                ops.push({
                    op: 'add_skill',
                    character: charId,
                    skill: {
                        id: entity.id,
                        name,
                        level: level || entity.level || '',
                        access: entityAccess(entity, 'public'),
                    },
                });
            } else if (level !== (entity.level || '')) {
                ops.push({ op: 'set_skill', character: charId, skill: entity.id, level });
            }
        }
        if (!ops.length) { close(); return; }
        finish(ops);
    });
}

function getProtagonist() {
    const state = getState();
    const settings = getSettings();
    const pinned = state.meta?.protagonistId;
    if (pinned && state.characters[pinned]) {
        return state.characters[pinned];
    }
    if (settings.protagonistId && state.characters[settings.protagonistId]) {
        return state.characters[settings.protagonistId];
    }
    return state.characters[PROTAGONIST_ID] || null;
}

function stateValue(entry) {
    if (entry === undefined || entry === null) return '';
    return entry?.current ?? entry;
}

/** 主角当前进度；没记过按 0，和进度条的起点一致。 */
function progressOf(state, ownerId = '') {
    const id = ownerId || state?.meta?.protagonistId || PROTAGONIST_ID;
    const entry = state?.characters?.[id]?.state?.progress;
    const value = entry && typeof entry === 'object' ? entry.current : entry;
    const number = Number.parseFloat(value);
    return Number.isFinite(number) ? Math.round(number) : 0;
}

/** 本轮进度变化：只看当前分支最后一条记录；旧记录没有快照就不显示。 */
function lastRoundProgressDelta(state, chat) {
    const branch = selectHistoryBranch(state?.meta?.history || [], chat || []);
    const record = branch[branch.length - 1];
    const before = Number(record?.progress?.before);
    const after = Number(record?.progress?.after);
    return Number.isFinite(before) && Number.isFinite(after) ? after - before : null;
}

function formatItemText(item) {
    const quantity = Number(item.quantity ?? 1);
    const unit = item.unit || '';
    return item.kind === 'currency' || quantity !== 1
        ? `${item.name}×${quantity}${unit}`
        : item.name;
}

function currentSkills(character) {
    return (character.skills || []).filter((skill) => skill.validTo == null);
}

function populateProtagonistSelect() {
    const select = document.getElementById('factledger_protagonist');
    if (!select) return;
    const settings = getSettings();
    const state = getState();

    select.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = '（自动：按提取结果）';
    select.appendChild(auto);
    for (const character of Object.values(state.characters)) {
        const option = document.createElement('option');
        option.value = character.id;
        option.textContent = `${character.name || character.id}${character.tier === 'main' ? '（当前主角）' : ''}`;
        select.appendChild(option);
    }
    const current = state.meta?.protagonistId || settings.protagonistId || '';
    select.value = state.characters[current] ? current : '';

    if (!select.dataset.bound) {
        select.dataset.bound = '1';
        select.addEventListener('change', () => {
            const next = select.value;
            // 面板可能跨结算存活，必须重新取当前台账，不能用渲染时捕获的旧对象。
            const currentState = getState();
            // 主角固定是玩家本人；选中 NPC 会让它拿到 protagonist 档位，直接等于泄密。
            if (next && next !== PROTAGONIST_ID) {
                select.value = currentState.meta?.protagonistId || settings.protagonistId || '';
                setStatus('主角固定是玩家本人，不能把 NPC 设为主角。');
                return;
            }
            currentState.meta.protagonistId = next;
            settings.protagonistId = next;
            for (const character of Object.values(currentState.characters)) {
                if (character.tier === 'main') character.tier = 'major';
            }
            if (next === PROTAGONIST_ID && currentState.characters[next]) currentState.characters[next].tier = 'main';
            saveSettings();
            saveState();
            renderStatusBar();
            renderPanel();
        });
    }
}

function fieldMeta(field, entry, preset) {
    return {
        label: entry?.label || preset.fieldLabels?.[field] || field,
        panel: entry?.panel || preset.panelMap?.[field] || 'personal',
    };
}

function renderStatusBar() {
    const settings = getSettings();
    let bar = document.getElementById('factledger_statusbar');
    // 关闭聊天后 SillyTavern 会清空 chat_metadata，但状态栏 DOM 还留在页面上。
    const ctx = getContext();
    const chatId = ctx.chatId || ctx.getCurrentChatId?.();
    if (!settings.statusBarEnabled || !chatId) {
        bar?.remove();
        return;
    }
    const target = getProtagonist();
    const protagonist = target || { id: '', name: '', state: {}, items: [], relations: [], skills: [] };

    const state = getState();
    const preset = getGenrePreset(settings.genrePreset);
    const id = protagonist.id;
    const worldLines = [];
    const personalLines = [];

    // 姓名固定放个人状态第一位：台账记过就用台账，否则用酒馆 persona 名（默认占位符不算）。
    const recordedName = stateValue(protagonist.state?.name);
    const personaName = isPlaceholderPersonaName(ctx.name1) ? '' : String(ctx.name1 || '').trim();
    const displayName = recordedName || personaName;
    if (displayName) personalLines.push(`${preset.fieldLabels?.name || '姓名'}：${displayName}`);

    const scenePlace = state.scene?.place || '';
    worldLines.push(`时间：${sceneTimeLabel(state.scene) || '未知'}`);
    worldLines.push(`地点：${scenePlace || '未知'}`);

    // Show the genre's standard fields even when the ledger has no value yet,
    // so an unknown baseline reads as「未知」instead of silently disappearing.
    const fieldOrder = Array.isArray(preset.fieldOrder) ? preset.fieldOrder : [];
    const preferredFields = ['gender', 'age', 'appearance', ...fieldOrder.filter((field) => !['gender', 'age', 'appearance'].includes(field))];
    const orderedFields = [];
    const seenFields = new Set();
    for (const field of [...preferredFields, ...Object.keys(preset.panelMap || {}), ...Object.keys(protagonist.state || {})]) {
        if (!field || seenFields.has(field)) continue;
        seenFields.add(field);
        orderedFields.push(field);
    }
    for (const field of orderedFields) {
        // progress 单独画进度条，不再作为一行文字重复出现；姓名已在最上面单独处理。
        if (field === 'progress' || field === 'name') continue;
        const entry = protagonist.state?.[field];
        const value = stateValue(entry);
        const meta = fieldMeta(field, entry, preset);
        const line = `${meta.label}：${value || '未知'}`;
        if (meta.panel === 'world') worldLines.push(line);
        else personalLines.push(line);
    }

    const progressLabel = preset.fieldLabels?.progress || '';
    const progressRaw = Number.parseFloat(stateValue(protagonist.state?.progress));
    // 该题材定义了「进度」字段就从第一轮起显示；台账还没记到时按 0 起步，而不是整条消失。
    const progressValue = !progressLabel
        ? null
        : (Number.isFinite(progressRaw) ? Math.max(0, Math.min(100, Math.round(progressRaw))) : 0);
    const realmValue = preset.levelField ? stateValue(protagonist.state?.[preset.levelField]) : '';
    const progressDelta = progressValue === null ? null : lastRoundProgressDelta(state, ctx.chat);
    const progressDeltaHtml = progressDelta
        ? `<span class="factledger-progress-delta ${progressDelta > 0 ? 'up' : 'down'}" title="本轮变化 ${progressDelta > 0 ? '+' : ''}${progressDelta}">${progressDelta > 0 ? '+' : ''}${progressDelta}</span>`
        : '';
    const progressBar = progressValue === null ? '' : `
        <div class="factledger-progress">
            <div class="factledger-progress-meta">
                <span>${escapeHtml([progressLabel, realmValue].filter(Boolean).join('｜'))}</span>
                <span>${progressValue}%${progressDeltaHtml}</span>
            </div>
            <div class="factledger-progress-track">
                <div class="factledger-progress-fill" style="width:${progressValue}%"></div>
            </div>
        </div>
    `;

    const skillLines = currentSkills(protagonist).map((skill) => (
        [skill.name, skill.level].filter(Boolean).join('｜')
    ));

    const artLines = [];
    if (skillLines.length) artLines.push(skillLines.join('、'));
    if (!artLines.length) artLines.push('无');

    const items = (protagonist.items || []).filter((item) => item.validTo == null);
    const itemLines = [];
    const assets = items.filter((item) => item.kind === 'currency').map(formatItemText);
    if (assets.length) itemLines.push(`资产：${assets.join('、')}`);

    const groups = [
        { label: '装备', kinds: ['equipment'] },
        { label: '消耗', kinds: ['consumable'] },
        { label: '其他', kinds: ['item', 'material'] },
    ];
    const groupedKinds = new Set(['currency', 'equipment', 'consumable', 'item', 'material']);
    for (const group of groups) {
        const list = items
            .filter((item) => group.kinds.includes(item.kind || 'item') && Number(item.quantity ?? 1) > 0)
            .map(formatItemText);
        if (list.length) itemLines.push(`${group.label}：${list.join('、')}`);
    }
    const otherItems = items.filter((item) => item.kind && !groupedKinds.has(item.kind) && Number(item.quantity ?? 1) > 0);
    if (otherItems.length) itemLines.push(`其他：${otherItems.map(formatItemText).join('、')}`);
    // 物品面板常驻；台账还没有物品时显示「无」，避免误以为面板坏了。
    if (!itemLines.length) itemLines.push('无');

    const relationLines = [];
    const participantIds = (state.scene?.participants || []).filter((pid) => pid !== id);
    // 宗门列只在题材定义了该字段时出现；修仙显示「宗门」，其他题材不多一列。
    const sectLabel = preset.fieldLabels?.sect || '';
    for (const pid of participantIds) {
        const npc = state.characters[pid];
        if (!npc) {
            relationLines.push([
                pid,
                '未知',
                ...(sectLabel ? ['未知'] : []),
                '未知',
                '—',
                '未知',
            ].join('｜'));
            continue;
        }
        const gender = stateValue(npc.state?.gender);
        const sect = sectLabel ? stateValue(npc.state?.sect) : '';
        const levelEntry = preset.levelField ? npc.state?.[preset.levelField] : null;
        const level = stateValue(levelEntry);
        const tierText = ACCESS_LABELS[characterAccess(npc)] || characterAccess(npc);
        // 关系只存在主角一侧；NPC 自己的关系列表不再使用。
        const ownRelation = (protagonist.relations || []).find((item) => item.validTo == null && item.target === pid);
        const rawType = String(ownRelation?.type || '').trim();
        // 只显示短称谓；过长的关系类型用「—」代替，避免撑开状态栏。
        const relationType = rawType && rawType.length <= 8 && !/[，,。；;：:！!？?…]/.test(rawType)
            ? rawType
            : '—';
        relationLines.push([
            npc.name || pid,
            gender || '未知',
            ...(sectLabel ? [sect || '未知'] : []),
            level || '未知',
            relationType,
            tierText,
        ].filter(Boolean).join('｜'));
    }

    // 关系表头的等级列跟着题材走：修仙是境界，都市是职位，通用题材退回「等级」。
    const levelLabel = (preset.levelField && preset.fieldLabels?.[preset.levelField]) || '等级';

    // 开局还没有主角记录时也要显示骨架（时间/地点/境界进度），而不是整条状态栏消失。
    const panels = [
        { key: 'world', title: '状态', lines: worldLines },
        { key: 'personal', title: '个人状态', lines: personalLines, extra: progressBar },
        { key: 'arts', title: preset.skillLabel || '技能', lines: artLines },
        { key: 'items', title: '物品', lines: itemLines },
        { key: 'relations', title: '关系', lines: relationLines, head: `人物｜性别${sectLabel ? `｜${sectLabel}` : ''}｜${levelLabel}｜关系｜档位` },
    ].filter((panel) => panel.lines.length || panel.extra);

    if (!panels.length && !settlePending) {
        bar?.remove();
        return;
    }

    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'factledger_statusbar';
        bar.className = 'factledger-statusbar';
        document.body.appendChild(bar);
    }
    makeDraggable(bar, '.factledger-statusbar-top');

    const loading = settlePending
        ? '<div class="factledger-statusbar-loading"><span class="factledger-spinner"></span><span>台账结算中…</span></div>'
        : '';
    const leakCount = Array.isArray(state.meta?.leaks) ? state.meta.leaks.length : 0;
    const leakNotice = leakCount
        ? `<div class="factledger-statusbar-notice">${leakCount} 条泄漏待处理，打开台账确认</div>`
        : '';
    const lastError = String(state.meta?.lastError || '').trim();
    const errorNotice = lastError
        ? `<div class="factledger-statusbar-notice factledger-statusbar-error">提取失败：${escapeHtml(lastError.slice(0, 180))}</div>`
        : '';

    bar.innerHTML = `
        <div class="factledger-statusbar-top">
            <strong>${escapeHtml(protagonist.name || protagonist.id || '事实台账')}</strong>
            <div class="factledger-statusbar-actions">
                <span class="factledger-statusbar-settle ${settlePending ? 'disabled' : ''}" title="立即结算本幕">结算本幕</span>
                <span class="factledger-statusbar-open" title="打开完整台账">打开台账</span>
            </div>
        </div>
        ${loading}
        ${errorNotice}
        ${leakNotice}
        ${panels.map((panel) => {
            const collapsed = collapsedStatusPanels.has(panel.key);
            return `
                <div class="factledger-statusbar-panel ${collapsed ? 'collapsed' : ''}" data-panel="${panel.key}">
                    <div class="factledger-statusbar-head">
                        <strong>${escapeHtml(panel.title)}</strong>
                        <span class="factledger-statusbar-toggle">▾</span>
                    </div>
                    <div class="factledger-statusbar-body">
                        ${panel.head ? `<div class="factledger-statusbar-line factledger-statusbar-line-head">${escapeHtml(panel.head)}</div>` : ''}
                        ${panel.extra || ''}
                        ${panel.lines.map((line) => `<div class="factledger-statusbar-line">${escapeHtml(line)}</div>`).join('')}
                    </div>
                </div>
            `;
        }).join('')}
    `;

    bar.querySelector('.factledger-statusbar-open')?.addEventListener('click', () => togglePanel(true));
    bar.querySelector('.factledger-statusbar-settle')?.addEventListener('click', () => {
        if (settlePending) return;
        settleLedger({ manual: true });
    });
    bar.querySelectorAll('.factledger-statusbar-panel').forEach((panelEl) => {
        panelEl.querySelector('.factledger-statusbar-head')?.addEventListener('click', () => {
            const key = panelEl.dataset.panel;
            if (collapsedStatusPanels.has(key)) collapsedStatusPanels.delete(key);
            else collapsedStatusPanels.add(key);
            panelEl.classList.toggle('collapsed');
        });
    });
}

function renderHealth(body) {
    const state = getState();
    const settings = getSettings();
    const leaks = state.meta?.leaks ?? [];
    const review = Array.isArray(state.meta?.review) ? state.meta.review : [];
    const preset = getGenrePreset(settings.genrePreset);
    const injection = assembleInjection(state, {
        tokenBudget: settings.injectBudget,
        knowledgeGate: settings.knowledgeGate,
        showOthers: settings.showOthers,
        skillLabel: preset.skillLabel,
        fieldLabels: preset.fieldLabels,
        levelField: preset.levelField,
        recentText: '',
        fieldOrder: preset.fieldOrder,
        protagonistId: getProtagonist()?.id || '',
        protagonistName: getContext().name1,
    });
    const issues = healthCheck(state, { injection, tokenBudget: settings.injectBudget });
    const missingGenders = missingGenderCharacters(state);
    const sectLabel = preset.fieldLabels?.sect || '';
    const missingSects = sectLabel ? missingFieldCharacters(state, 'sect') : [];
    const protagonist = getProtagonist();
    const protagonistSect = stateValue(protagonist?.state?.sect);
    const duplicates = duplicateCharacterGroups(state);
    const history = Array.isArray(state.meta?.history) ? state.meta.history : [];
    const historyKb = Math.max(1, Math.round(JSON.stringify(history).length / 1024));

    body.innerHTML = `
        <div class="factledger-card">
            <div><strong>运行状态</strong></div>
            <div class="factledger-muted">启用：${settings.enabled ? '是' : '否'}；自动结算：${settings.autoInterval > 0 ? settings.autoInterval + ' 条' : '手动'}</div>
            <div class="factledger-muted">上次结算：${escapeHtml(state.meta?.lastSettleAt || '从未')}</div>
            <div class="factledger-muted">最后错误：${escapeHtml(state.meta?.lastError || '无')}</div>
            <div class="factledger-muted">注入估算：${estimateTokens(injection)} / ${settings.injectBudget} tokens</div>
            <div class="factledger-muted">版本日志：${history.length} 条 / ${historyKb} KB</div>
        </div>
        <div class="factledger-card">
            <div><strong>泄露检测</strong> ${leaks.length ? '<span class="factledger-badge err">有泄露</span>' : '<span class="factledger-badge ok">正常</span>'}</div>
            ${leaks.length ? leaks.map((leak, index) => `
                <div class="factledger-leak-row">
                    <span class="factledger-leak-text">${escapeHtml(leak.characterName || leak.character || '')}：${escapeHtml(leak.label || leak.factText || leak.fact || '')}</span>
                    <span class="factledger-leak-actions">
                        <button class="menu_button" data-leak-ack="${index}">设为已知</button>
                        <button class="menu_button" data-leak-dismiss="${index}" title="仅清除本条记录，台账不变；叙事者下次仍可能越界。反复出现时建议设为已知或修正提取规则。">忽略</button>
                    </span>
                </div>
            `).join('') : '<div class="factledger-muted">无</div>'}
            <div class="factledger-actions" style="margin-top:6px;">
                <button class="menu_button" id="factledger_check_leaks">检查最近回复</button>
                <button class="menu_button" id="factledger_copy_debug">复制调试信息</button>
            </div>
        </div>
        <div class="factledger-card">
            <div><strong>待复核</strong> ${review.length ? `<span class="factledger-badge">${review.length} 条</span>` : '<span class="factledger-badge ok">无</span>'}</div>
            ${review.length ? review.map((entry, index) => `
                <div class="factledger-muted">
                    ${escapeHtml(describeReviewOp(entry?.op || entry))}
                    <button class="menu_button" data-review-accept="${index}">采纳</button>
                    <button class="menu_button" data-review-dismiss="${index}" title="丢弃这条低置信记录；台账不变。">忽略</button>
                </div>
            `).join('') : '<div class="factledger-muted">置信度 0.5–0.7 的 op 会留在这里，不会自动落账。</div>'}
        </div>
        <div class="factledger-card">
            <div><strong>健康检查</strong></div>
            ${issues.length ? issues.map((item) => `<div class="factledger-muted">${escapeHtml(item)}</div>`).join('') : '<div class="factledger-muted">无告警</div>'}
        </div>
        ${duplicates.length ? `
        <div class="factledger-card">
            <div><strong>重复角色</strong> <span class="factledger-badge warn">${duplicates.length}</span></div>
            <div class="factledger-muted">同名记录会合并到资料最多的一条；关系、场景和物品引用会一起更新。</div>
            <div class="factledger-actions">
                ${duplicates.map((group) => `<button class="menu_button" data-merge-name="${escapeHtml(group.name)}">合并 ${escapeHtml(group.name)}（${group.ids.length}）</button>`).join('')}
            </div>
        </div>` : ''}
        ${protagonist && sectLabel ? `
        <div class="factledger-card">
            <div><strong>主角${escapeHtml(sectLabel)}</strong> <span class="factledger-muted">${escapeHtml(protagonistSect || '未记录')}</span></div>
            <div class="factledger-actions">
                <button class="menu_button" data-sect-fix="${escapeHtml(protagonist.id)}">编辑${escapeHtml(sectLabel)}</button>
            </div>
        </div>` : ''}
        ${missingGenders.length ? `
        <div class="factledger-card">
            <div><strong>性别缺失</strong> <span class="factledger-badge warn">${missingGenders.length}</span></div>
            <div class="factledger-muted">以下在场角色建档时没有写 gender，点名字补录。</div>
            <div class="factledger-actions">
                ${missingGenders.map((character) => `<button class="menu_button" data-gender-fix="${escapeHtml(character.id)}">${escapeHtml(character.name || character.id)}</button>`).join('')}
            </div>
        </div>` : ''}
        ${missingSects.length ? `
        <div class="factledger-card">
            <div><strong>${escapeHtml(sectLabel)}缺失</strong> <span class="factledger-badge warn">${missingSects.length}</span></div>
            <div class="factledger-muted">以下在场角色没有记录${escapeHtml(sectLabel)}，点名字补录。</div>
            <div class="factledger-actions">
                ${missingSects.map((character) => `<button class="menu_button" data-sect-fix="${escapeHtml(character.id)}">${escapeHtml(character.name || character.id)}</button>`).join('')}
            </div>
        </div>` : ''}
        <details class="factledger-card">
            <summary><strong>注入预览</strong></summary>
            <pre style="white-space:pre-wrap;font-size:0.8em;">${escapeHtml(injection || '（空）')}</pre>
        </details>
    `;
    body.querySelector('#factledger_check_leaks')?.addEventListener('click', checkRecentLeaks);
    body.querySelector('#factledger_copy_debug')?.addEventListener('click', copyDebugInfo);
    body.querySelectorAll('[data-leak-ack]').forEach((button) => {
        button.addEventListener('click', () => acknowledgeLeak(Number(button.dataset.leakAck)));
    });
    body.querySelectorAll('[data-leak-dismiss]').forEach((button) => {
        button.addEventListener('click', () => dismissLeak(Number(button.dataset.leakDismiss)));
    });
    body.querySelectorAll('[data-review-accept]').forEach((button) => {
        button.addEventListener('click', () => acceptReview(Number(button.dataset.reviewAccept)));
    });
    body.querySelectorAll('[data-review-dismiss]').forEach((button) => {
        button.addEventListener('click', () => dismissReview(Number(button.dataset.reviewDismiss)));
    });
    body.querySelectorAll('[data-gender-fix]').forEach((button) => {
        button.addEventListener('click', () => openGenderEditor(button.dataset.genderFix));
    });
    body.querySelectorAll('[data-sect-fix]').forEach((button) => {
        button.addEventListener('click', () => openSectEditor(button.dataset.sectFix));
    });
    body.querySelectorAll('[data-merge-name]').forEach((button) => {
        button.addEventListener('click', () => mergeDuplicateCharacters(button.dataset.mergeName));
    });
}

/** 把同名 NPC 记录合并到资料最多的一条；合并 op 写入当前分支最后一条记录。 */
function mergeDuplicateCharacters(name) {
    const state = getState();
    const group = duplicateCharacterGroups(state).find((item) => item.name === name);
    if (!group) {
        setStatus('没有可合并的重复角色。');
        return;
    }
    if (!window.confirm(`把「${name}」的 ${group.ids.length} 条记录合并到 ${group.keep}？`)) return;
    const branch = selectHistoryBranch(state.meta?.history || [], getContext().chat || []);
    const last = branch[branch.length - 1];
    if (!last) {
        setStatus('当前分支还没有结算记录，先结算一次再合并。');
        return;
    }
    if (!Array.isArray(last.ops)) last.ops = [];
    const ops = group.ids
        .filter((id) => id !== group.keep)
        .map((id) => ({ op: 'merge_character', fromId: id, toId: group.keep, evidence: 'manual', confidence: 1 }));
    if (!ops.length) return;
    let result;
    try {
        result = applyOps(state, ops, {
            confidenceThreshold: 0,
            reviewThreshold: 0,
            npcFields: [getGenrePreset(getSettings().genrePreset).levelField].filter(Boolean),
        });
    } catch (err) {
        setStatus(`合并失败：${err.message}`);
        return;
    }
    if (result.rejected?.length) {
        setStatus(`合并失败：${result.rejected[0].reason || '未知原因'}`);
        return;
    }
    last.ops.push(...ops);
    saveState();
    refreshInjection();
    renderPanel();
    setStatus(`已合并「${name}」的 ${ops.length + 1} 条记录。`);
}

/** 健康页的性别补录：只改字段，不动正文与日志。 */
function openGenderEditor(characterId) {
    const character = getState().characters?.[characterId];
    if (!character) {
        setStatus('找不到这个角色。');
        return;
    }
    const current = String(character.state?.gender?.current || '');
    const options = ['男', '女', '未知']
        .map((value) => `<option value="${value}" ${value === current ? 'selected' : ''}>${value}</option>`)
        .join('');
    document.getElementById('factledger_gender_modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'factledger_gender_modal';
    modal.className = 'factledger-modal';
    modal.innerHTML = `
        <div class="factledger-modal-content">
            <div class="factledger-modal-head">
                <strong>补录性别</strong>
                <span class="factledger-modal-close" title="关闭">✕</span>
            </div>
            <div class="factledger-muted">角色：${escapeHtml(character.name || character.id)}</div>
            <div class="factledger-row">
                <label for="factledger_gender_value">性别</label>
                <select id="factledger_gender_value">${options}</select>
            </div>
            <div class="factledger-actions">
                <button class="menu_button" id="factledger_gender_save">保存</button>
                <button class="menu_button" id="factledger_gender_cancel">取消</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    const close = () => modal.remove();
    modal.querySelector('.factledger-modal-close')?.addEventListener('click', close);
    modal.querySelector('#factledger_gender_cancel')?.addEventListener('click', close);
    modal.querySelector('#factledger_gender_save')?.addEventListener('click', () => {
        const value = document.getElementById('factledger_gender_value')?.value || '未知';
        appendManualField(getState().meta?.history || [], getContext().chat || [], characterId, 'gender', value);
        if (!character.state) character.state = {};
        const entry = character.state.gender && typeof character.state.gender === 'object'
            ? character.state.gender
            : { current: '', history: [] };
        entry.current = value;
        if (!Array.isArray(entry.history)) entry.history = [];
        character.state.gender = entry;
        saveState();
        refreshInjection();
        close();
        renderPanel();
        setStatus(`已把「${character.name || character.id}」的性别补为${value}。`);
    });
}

/** 健康页的宗门补录：和性别一样只改字段，回放不丢。 */
function openSectEditor(characterId) {
    const character = getState().characters?.[characterId];
    if (!character) {
        setStatus('找不到这个角色。');
        return;
    }
    const preset = getGenrePreset(getSettings().genrePreset);
    const label = preset.fieldLabels?.sect || '宗门';
    const current = String(character.state?.sect?.current ?? character.state?.sect ?? '');
    document.getElementById('factledger_sect_modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'factledger_sect_modal';
    modal.className = 'factledger-modal';
    modal.innerHTML = `
        <div class="factledger-modal-content">
            <div class="factledger-modal-head">
                <strong>补录${escapeHtml(label)}</strong>
                <span class="factledger-modal-close" title="关闭">✕</span>
            </div>
            <div class="factledger-muted">角色：${escapeHtml(character.name || character.id)}</div>
            <div class="factledger-row">
                <label for="factledger_sect_value">${escapeHtml(label)}</label>
                <input type="text" id="factledger_sect_value" class="text_pole" value="${escapeHtml(current)}" placeholder="如：青云剑宗内门" />
            </div>
            <div class="factledger-actions">
                <button class="menu_button" id="factledger_sect_save">保存</button>
                <button class="menu_button" id="factledger_sect_cancel">取消</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    const close = () => modal.remove();
    const save = () => {
        const input = document.getElementById('factledger_sect_value');
        const value = String(input?.value ?? '').trim();
        if (!value) {
            setStatus(`${label}不能为空。`);
            input?.focus();
            return;
        }
        appendManualField(getState().meta?.history || [], getContext().chat || [], characterId, 'sect', value);
        if (!character.state) character.state = {};
        const entry = character.state.sect && typeof character.state.sect === 'object'
            ? character.state.sect
            : { current: '', history: [] };
        entry.current = value;
        if (!Array.isArray(entry.history)) entry.history = [];
        entry.access = entry.access || 'public';
        character.state.sect = entry;
        saveState();
        refreshInjection();
        close();
        renderPanel();
        setStatus(`已把「${character.name || character.id}」的${label}补为${value}。`);
    };
    modal.querySelector('.factledger-modal-close')?.addEventListener('click', close);
    modal.querySelector('#factledger_sect_cancel')?.addEventListener('click', close);
    modal.querySelector('#factledger_sect_save')?.addEventListener('click', save);
    modal.querySelector('#factledger_sect_value')?.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        save();
    });
}

/** 低置信 op 的可读摘要，避免在面板里糊一整段 JSON。 */
function describeReviewOp(op) {
    const parts = [String(op?.op || 'op')];
    for (const key of ['character', 'field', 'value', 'item', 'skill', 'relation', 'to', 'access', 'reason']) {
        if (op?.[key] === undefined || op?.[key] === null || op?.[key] === '') continue;
        const value = typeof op[key] === 'object' ? JSON.stringify(op[key]) : String(op[key]);
        parts.push(`${key}=${value}`);
    }
    const text = parts.join(' ');
    return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

/** 把泄露记录还原成 reveal 的目标。 */
function leakRevealTarget(state, leak) {
    const target = leak.target || {};
    if (target.item) return { item: target.item, label: target.item };
    if (target.skill) return { skill: target.skill, label: target.skill };
    if (target.relation) return { relation: target.relation, label: `关系 ${target.relation}` };
    if (target.character && target.field) {
        const name = state.characters?.[target.character]?.name || target.character;
        return { character: target.character, field: target.field, label: `${name}.${target.field}` };
    }
    return null;
}

function acknowledgeLeak(index) {
    const ctx = getContext();
    const state = getState();
    const leak = state.meta?.leaks?.[index];
    if (!leak) return;
    const characterId = leak.character || leak.characterName || '';
    const target = leakRevealTarget(state, leak);
    if (!characterId || !target) {
        setStatus('找不到对应的秘密条目，请到编辑器里手动处理。');
        return;
    }
    const revealOp = {
        op: 'reveal',
        to: characterId,
        method: '叙事中已经泄露，按已知处理',
        ...(target.item ? { item: target.item } : {}),
        ...(target.skill ? { skill: target.skill } : {}),
        ...(target.relation ? { relation: target.relation } : {}),
        ...(target.character && target.field ? { character: target.character, field: target.field } : {}),
        evidence: 'msg:0',
        confidence: 1,
    };
    const result = applyOps(state, [revealOp], { confidenceThreshold: 0.7, reviewThreshold: 0.5 });
    const changed = (result.changedOps || []).some((op) => op && op.op === 'reveal');
    if (!changed) {
        // 扩散失败时不能删掉泄露记录，否则玩家会失去这个处理入口。
        const reason = (result.rejected || [])[0]?.reason || '目标可能已经知情，或档位没有变化';
        setStatus(`未能扩散「${target.label || '这条秘密'}」：${reason}`);
        return;
    }
    result.state.meta.leaks = (result.state.meta.leaks || []).filter((_, i) => i !== index);
    // 手动泄露处理也要进版本日志，否则编辑消息/swipe 回放会把这次扩散一起冲掉。
    recordManualOps(result.state, [revealOp], ctx);
    ctx.chatMetadata[MODULE_NAME] = result.state;
    saveState();
    refreshInjection();
    renderPanel();
    notifyReveals((result.changedOps || []).filter((op) => op && op.op === 'reveal'), result.state);
}

function dismissLeak(index) {
    const ctx = getContext();
    const state = getState();
    state.meta.leaks = (state.meta.leaks || []).filter((_, i) => i !== index);
    ctx.chatMetadata[MODULE_NAME] = state;
    saveState();
    renderPanel();
    setStatus('已忽略这条泄露记录。');
}

/** 手工采纳/扩散也写版本日志，否则编辑消息或 swipe 回放会把它冲掉。 */
function recordManualOps(state, ops, ctx) {
    if (!Array.isArray(ops) || !ops.length) return;
    const settled = Number(state.meta?.lastProcessedMessage);
    const lastIndex = Number.isFinite(settled) && settled >= 0
        ? settled
        : Math.max(0, ctx.chat.length - 1);
    const history = state.meta.history || [];
    const hashes = computePrefixHashes(ctx.chat);
    const existing = history.find((record) => (
        Number(record?.to) === lastIndex && recordMatchesChat(record, ctx.chat, hashes)
    ));
    if (existing) {
        existing.ops = [...(existing.ops || []), ...ops];
    } else {
        history.push({
            to: lastIndex,
            anchor: messageHash(ctx.chat[lastIndex]),
            prefixHash: hashes[lastIndex] || '',
            ops: [...ops],
            characters: [],
            scene: { ...state.scene },
        });
    }
    state.meta.history = history;
}

/** 低置信 op 是提取模型犹豫的记录；采纳时信任它一次，但只应用这一条。 */
function acceptReview(index) {
    const ctx = getContext();
    const state = getState();
    const entry = state.meta?.review?.[index];
    if (!entry) return;
    const rawOp = entry?.op && typeof entry.op === 'object' ? entry.op : entry;
    const { needsReview, ...op } = rawOp;
    const result = applyOps(state, [op], {
        confidenceThreshold: 0,
        reviewThreshold: 0,
        tierVoteThreshold: getSettings().tierVoteThreshold,
        protagonistId: state.meta?.protagonistId || getSettings().protagonistId || PROTAGONIST_ID,
    });
    if (!(result.applied || []).length) {
        const reason = (result.rejected || [])[0]?.reason || '这条 op 被拒绝';
        setStatus(`未能采纳：${reason}`);
        return;
    }
    result.state.meta.review = (result.state.meta.review || []).filter((_, i) => i !== index);
    recordManualOps(result.state, [op], ctx);
    ctx.chatMetadata[MODULE_NAME] = result.state;
    saveState();
    refreshInjection();
    renderPanel();
    notifyReveals((result.changedOps || []).filter((item) => item && item.op === 'reveal'), result.state);
    setStatus(`已采纳：${op.op}。`);
}

function dismissReview(index) {
    const ctx = getContext();
    const state = getState();
    state.meta.review = (state.meta.review || []).filter((_, i) => i !== index);
    ctx.chatMetadata[MODULE_NAME] = state;
    saveState();
    renderPanel();
    setStatus('已忽略这条待复核记录。');
}

function buildDebugData() {
    const ctx = getContext();
    const state = getState();
    const settings = getSettings();
    const history = Array.isArray(state.meta?.history) ? state.meta.history : [];
    const injection = buildInjectionText();
    return {
        version: VERSION,
        chatId: ctx.getCurrentChatId?.() || '',
        chatLength: Array.isArray(ctx.chat) ? ctx.chat.length : 0,
        lastProcessedMessage: state.meta?.lastProcessedMessage ?? -1,
        lastProcessedHash: state.meta?.lastProcessedHash || '',
        historyLength: history.length,
        historyTo: history.slice(-20).map((record) => record.to),
        lastError: state.meta?.lastError || '',
        lastSettleAt: state.meta?.lastSettleAt || '',
        scene: state.scene,
        characters: Object.values(state.characters || {})
            .map((character) => `${character.id}:${character.name}:${character.tier}`),
        leakCount: Array.isArray(state.meta?.leaks) ? state.meta.leaks.length : 0,
        injectionTokens: estimateTokens(injection),
        settings: {
            autoInterval: settings.autoInterval,
            publicPromoteInterval: settings.publicPromoteInterval,
            genrePreset: settings.genrePreset,
            profileId: settings.profileId,
            maxTokens: settings.maxTokens,
            confidenceThreshold: settings.confidenceThreshold,
            tierVoteThreshold: settings.tierVoteThreshold,
            injectBudget: settings.injectBudget,
            knowledgeGate: settings.knowledgeGate,
            leakCheck: settings.leakCheck,
            useCurrentConnection: settings.useCurrentConnection,
        },
    };
}

function showDebugModal(title, data) {
    document.getElementById('factledger_debug_modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'factledger_debug_modal';
    modal.className = 'factledger-modal';
    const json = JSON.stringify(data, null, 2);
    modal.innerHTML = `
        <div class="factledger-modal-content factledger-debug-content">
            <div class="factledger-modal-head">
                <strong>${escapeHtml(title)}</strong>
                <span class="factledger-modal-close" title="关闭">✕</span>
            </div>
            <textarea id="factledger_debug_text" readonly>${escapeHtml(json)}</textarea>
            <div class="factledger-actions">
                <button class="menu_button" id="factledger_debug_copy">复制</button>
                <button class="menu_button" id="factledger_debug_close">关闭</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    const close = () => modal.remove();
    modal.querySelector('.factledger-modal-close')?.addEventListener('click', close);
    modal.querySelector('#factledger_debug_close')?.addEventListener('click', close);
    modal.querySelector('#factledger_debug_copy')?.addEventListener('click', async () => {
        const textarea = modal.querySelector('#factledger_debug_text');
        try {
            await navigator.clipboard.writeText(textarea.value);
            setStatus('调试信息已复制到剪贴板。');
        } catch (err) {
            textarea.focus();
            textarea.select();
            setStatus(`复制失败：${err.message}（已选中文本，可手动 Ctrl+C）`);
        }
    });
    console.log(`[FactLedger] ${title}`, data);
    return modal;
}

async function copyDebugInfo() {
    const data = buildDebugData();
    const text = JSON.stringify(data, null, 2);
    console.log('[FactLedger] debug', data);
    try {
        await navigator.clipboard.writeText(text);
        setStatus('调试信息已复制到剪贴板。');
    } catch (err) {
        showDebugModal('事实台账·调试信息', data);
        setStatus(`复制失败：${err.message}（已打开调试窗口，可手动复制）`);
    }
}

let slashCommandsRegistered = false;

function registerSlashCommands() {
    if (slashCommandsRegistered) return;
    if (!SlashCommandParser?.addCommandObject || !SlashCommand?.fromProps) {
        log('slash commands unavailable');
        return;
    }

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'factledger-status',
        aliases: ['fl-status'],
        callback: () => {
            showDebugModal('事实台账·调试信息', buildDebugData());
            return '';
        },
        helpString: '打开事实台账调试信息。',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'factledger-history',
        aliases: ['fl-history'],
        callback: () => {
            const ctx = getContext();
            const state = getState();
            const history = Array.isArray(state.meta?.history) ? state.meta.history : [];
            showDebugModal('事实台账·版本日志', {
                chatLength: Array.isArray(ctx.chat) ? ctx.chat.length : 0,
                lastProcessedMessage: state.meta?.lastProcessedMessage ?? -1,
                historyLength: history.length,
                historyTo: history.map((record) => record.to),
            });
            return '';
        },
        helpString: '查看事实台账的版本日志。',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'factledger-settle',
        aliases: ['fl-settle'],
        callback: async () => {
            await settleLedger({ manual: true });
            return '';
        },
        helpString: '立即结算事实台账。',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'factledger-replay',
        aliases: ['fl-replay'],
        unnamedArgumentList: [
            new SlashCommandArgument('message index', [ARGUMENT_TYPE.NUMBER], true),
        ],
        callback: (args, indexText) => {
            const index = Number(indexText);
            const ctx = getContext();
            if (!Number.isFinite(index) || index < 0) {
                setStatus('用法：/factledger-replay <消息序号>');
                return '';
            }
            const state = getState();
            const history = Array.isArray(state.meta?.history) ? state.meta.history : [];
            const branch = selectHistoryBranch(history, ctx.chat);
            const target = [...branch]
                .reverse()
                .find((record) => Number(record.to) <= index && Number(record.to) < ctx.chat.length);
            if (!target) {
                setStatus(`没有 <= #${index} 的版本记录。`);
                return '';
            }
            const restored = replayHistory(branch, target.to);
            const pinnedBefore = String(state.meta.protagonistId || '').trim();
            const pinnedExisted = pinnedBefore !== '' && Boolean(state.characters[pinnedBefore]);
            state.characters = restored.characters;
            dropMissingProtagonist(state, pinnedBefore, pinnedExisted);
            state.scene = restored.scene;
            // 保留其它 swipe 的记录，切回旧版时还要用。
            state.meta.history = history;
            state.meta.lastProcessedMessage = target.to;
            state.meta.lastProcessedHash = messageHash(ctx.chat[target.to]);
            clearTransientMeta(state);
            saveState();
            refreshInjection();
            renderPanel();
            showDebugModal('事实台账·回放完成', {
                requested: index,
                restoredTo: target.to,
                historyLength: state.meta.history.length,
                chatLength: ctx.chat.length,
            });
            return '';
        },
        helpString: '把台账回放到指定聊天序号对应的版本（不修改聊天内容）。',
    }));

    slashCommandsRegistered = true;
    log('slash commands registered');
}

function checkRecentLeaks() {
    const ctx = getContext();
    const state = getState();
    const lastAssistant = [...(ctx.chat || [])].reverse().find((message) => !message.is_user && String(message.mes || '').trim());
    if (!lastAssistant) {
        setStatus('没有可检查的 AI 回复。');
        return;
    }
    const active = state.scene?.participants?.length
        ? state.scene.participants
        // 没有在场记录时扫全部 NPC；只扫 tier main 会永远只命中玩家，等于不检查。
        : Object.values(state.characters)
            .filter((character) => character.id !== PROTAGONIST_ID)
            .map((character) => character.id);
    const leaks = detectLeaks(
        state,
        lastAssistant.mes,
        active,
        getGenrePreset(getSettings().genrePreset).fieldLabels,
        {
            skillLabel: getGenrePreset(getSettings().genrePreset).skillLabel,
        },
    );
    state.meta.leaks = leaks;
    saveState();
    renderPanel();
    setStatus(`泄露检查完成：候选 ${leaks.length} 条。`);
}

/** 独立的 JSON 编辑弹窗：大编辑框，Ctrl+S 保存，Esc 关闭。 */
function openJsonEditor() {
    document.getElementById('factledger_json_modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'factledger_json_modal';
    modal.className = 'factledger-modal';
    modal.innerHTML = `
        <div class="factledger-modal-content factledger-json-content">
            <div class="factledger-modal-head">
                <strong>编辑台账 JSON</strong>
                <span class="factledger-modal-close" title="关闭">✕</span>
            </div>
            <div class="factledger-muted">保存前会做基本结构校验；改动较大时建议先导出备份。Ctrl+S 保存，Esc 关闭。</div>
            <details class="factledger-json-help">
                <summary>编辑说明与常用改法</summary>
                <div class="factledger-json-help-body">
                    <p><b>结构：</b><code>characters</code>（角色）、<code>scene</code>（场景）、<code>meta</code>（版本日志等）。主角固定 <code>id: "user"</code>。</p>
                    <p><b>档位：</b><code>public</code>（人人皆知）&lt; <code>friend</code> &lt; <code>intimate</code> &lt; <code>protagonist</code>（只有你知道）。字段、物品、功法、关系上都有 <code>access</code>。</p>
                    <ul>
                        <li>改谁知道：把该条目的 <code>"access"</code> 改成 <code>"friend"</code> / <code>"intimate"</code> / <code>"protagonist"</code>。</li>
                        <li>改字段值：<code>characters.user.state.realm.current</code>。</li>
                        <li>改关系类型：<code>characters.user.relations[0].type</code>。</li>
                        <li>加物品：复制 <code>characters.user.items</code> 里的一条，改 <code>id</code> / <code>name</code> / <code>quantity</code>。</li>
                    </ul>
                    <p><b>注意：</b>不要删掉 <code>characters</code>；改坏时先「取消」，再点「导出」备份。</p>
                </div>
            </details>
            <textarea id="factledger_json_editor" spellcheck="false">${escapeHtml(JSON.stringify(getState(), null, 2))}</textarea>
            <div class="factledger-actions">
                <button class="menu_button" id="factledger_json_save">保存</button>
                <button class="menu_button" id="factledger_json_cancel">取消</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    const close = () => {
        document.removeEventListener('keydown', onKey);
        modal.remove();
    };
    const save = () => {
        const textarea = modal.querySelector('#factledger_json_editor');
        if (!textarea) return;
        try {
            const data = JSON.parse(textarea.value);
            if (!data || typeof data !== 'object' || typeof data.characters !== 'object') {
                throw new Error('结构不完整：需要 characters 对象');
            }
            const ctx = getContext();
            ctx.chatMetadata[MODULE_NAME] = normalizeState(data);
            saveState();
            refreshInjection();
            close();
            renderPanel();
            setStatus('台账 JSON 已保存。');
        } catch (err) {
            setStatus(`保存失败：${err.message}`);
        }
    };
    function onKey(event) {
        if (event.key === 'Escape') {
            close();
        } else if (event.key.toLowerCase() === 's' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            save();
        }
    }

    modal.querySelector('.factledger-modal-close')?.addEventListener('click', close);
    modal.querySelector('#factledger_json_cancel')?.addEventListener('click', close);
    modal.querySelector('#factledger_json_save')?.addEventListener('click', save);
    // 点遮罩关闭，点内容区不关。
    modal.addEventListener('click', (event) => {
        if (event.target === modal) close();
    });
    document.addEventListener('keydown', onKey);
    modal.querySelector('#factledger_json_editor')?.focus();
}

function renderPanel() {
    const body = document.getElementById('factledger_body');
    // 面板没打开时也要刷新状态栏：swipe/编辑/删除后的回放结果不能等到下次打开面板才显示。
    if (!body) {
        renderStatusBar();
        return;
    }

    populateProtagonistSelect();
    renderStatusBar();

    document.querySelectorAll('.factledger-tab').forEach((el) => {
        el.classList.toggle('active', el.dataset.tab === activeTab);
    });

    switch (activeTab) {
        case 'characters':
            renderCharacters(body);
            break;
        case 'knowledge':
            renderKnowledge(body);
            break;
        case 'history':
            renderHistory(body);
            break;
        case 'health':
            renderHealth(body);
            break;
        default:
            body.textContent = '';
    }
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function exportState() {
    const state = getState();
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fact-ledger-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

async function importState(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || !parsed.characters) {
            throw new Error('不是有效的台账 JSON');
        }
        const data = normalizeState(parsed);
        const ctx = getContext();
        ctx.chatMetadata[MODULE_NAME] = data;
        saveState();
        refreshInjection();
        renderPanel();
        setStatus('导入成功。');
    } catch (err) {
        setStatus(`导入失败：${err.message}`);
    } finally {
        event.target.value = '';
    }
}

function registerEvents() {
    const ctx = getContext();
    const eventSource = ctx.eventSource;
    const eventTypes = ctx.eventTypes;
    if (!eventSource || !eventTypes) return;

    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        log('chat changed');
        if (sendLocked && sendLockChatId && sendLockChatId !== currentChatId()) {
            unlockSending('chat-changed');
        }
        restoreLedgerFromHistory('chat-changed');
        pendingResettleIndex = -1;
        pendingResettleHash = '';
        generationActive = false;
        // 聊天加载完成后再写版本：初始化时写会被聊天文件里的旧 metadata 覆盖。
        const changedState = getState();
        if (changedState.meta.extensionVersion !== VERSION) {
            changedState.meta.extensionVersion = VERSION;
            saveState();
        }
        refreshInjection();
        renderPanel();
        setStatus(`已切换聊天：${ctx.getCurrentChatId?.() ?? ''}`);
    });

    eventSource.on(eventTypes.MESSAGE_RECEIVED, () => {
        generationActive = false;
        const state = getState();
        const settings = getSettings();
        state.meta.messagesSinceSettle = (state.meta.messagesSinceSettle || 0) + 1;
        // 自动结算的决策路径全部落盘，否则“没触发”和“触发了但没记录”分不清。
        const autoEvent = {
            at: new Date().toISOString(),
            since: state.meta.messagesSinceSettle,
            interval: Number(settings.autoInterval),
            enabled: Boolean(settings.enabled),
            running: settleRunning,
            step: 'received',
        };
        state.meta.lastAutoEvent = autoEvent;
        saveState();
        refreshInjection();
        renderPanel();

        // swipe 留下的待重算楼层：只有新正文确实落定才重算，生成失败时不动。
        if (consumePendingResettle()) {
            autoEvent.step = 'resettle-pending';
            return;
        }

        if (!settings.enabled || settings.autoInterval <= 0) {
            autoEvent.step = 'disabled-or-zero';
            return;
        }
        if (state.meta.messagesSinceSettle < settings.autoInterval) {
            autoEvent.step = 'below-interval';
            return;
        }
        if (settleRunning) {
            // 结算期间到达的回复不能丢，等本轮结束后补一次。
            settleQueued = true;
            autoEvent.step = 'running';
            return;
        }
        // 后台标签下请求会被挂起，等切回可见再结算。
        if (document.visibilityState === 'hidden') {
            settleQueued = true;
            autoEvent.step = 'hidden-deferred';
            return;
        }
        if (settings.useCurrentConnection || getProfileId() || settings.fallbackProfileId) {
            const chatId = currentChatId();
            autoEvent.step = 'scheduled';
            setTimeout(() => {
                if (chatId !== currentChatId()) {
                    const live = getState();
                    live.meta.lastAutoEvent = { ...autoEvent, at: new Date().toISOString(), step: 'chat-changed' };
                    saveState();
                    return;
                }
                if (settleRunning) {
                    settleQueued = true;
                    const live = getState();
                    live.meta.lastAutoEvent = { ...autoEvent, at: new Date().toISOString(), step: 'running-at-timer' };
                    saveState();
                    return;
                }
                const live = getState();
                live.meta.lastAutoEvent = { ...autoEvent, at: new Date().toISOString(), step: 'settling' };
                saveState();
                settleLedger().catch((err) => error('auto settle failed', err));
            }, AUTO_SETTLE_DELAY_MS);
        } else {
            autoEvent.step = 'no-profile';
            saveState();
        }
    });

    eventSource.on(eventTypes.GENERATION_AFTER_COMMANDS, () => {
        refreshInjection();
    });

    const invalidateFrom = (index, reason) => {
        const target = Number(index);
        if (!Number.isFinite(target)) return;
        restoreLedgerFromHistory(reason);
        refreshInjection();
        renderPanel();
        // 回放后再判断：这一条的记录是不是因为正文改动而失效了。
        const chat = Array.isArray(getContext().chat) ? getContext().chat : [];
        if (!chat[target] || chat[target].is_user) return;
        if (!lostHistoryIndices(chat, getState().meta.history || []).includes(target)) return;
        if (getSettings().autoResettleOnEdit) {
            scheduleResettle(target);
        } else {
            setStatus(`第 ${target} 条正文已改，该轮台账已失效；可在台账日志页点「重算这一条」。`);
        }
    };

    eventSource.on(eventTypes.MESSAGE_EDITED, (index) => invalidateFrom(index, 'message-edited'));
    // swipe 触发时新正文还没生成，此刻提取会读到旧内容或半截正文，先只做回放并记下待重算。
    eventSource.on(eventTypes.MESSAGE_SWIPED, (index) => {
        const target = Number(index);
        const chat = Array.isArray(getContext().chat) ? getContext().chat : [];
        restoreLedgerFromHistory('message-swiped');
        refreshInjection();
        renderPanel();
        if (!Number.isFinite(target) || !chat[target] || chat[target].is_user) return;
        if (!getSettings().autoResettleOnEdit) {
            setStatus(`第 ${target} 条正文已改，该轮台账已失效；可在台账日志页点「重算这一条」。`);
            return;
        }
        pendingResettleIndex = target;
        pendingResettleHash = messageHash(chat[target]);
        setStatus(`第 ${target} 条正在重新生成，结束后重算台账。`);
    });

    eventSource.on(eventTypes.GENERATION_STARTED, () => {
        generationActive = true;
    });
    // 生成结束或中止后才允许提取；只有正文确实更新了才重算，生成失败时不动。
    const flushPendingResettle = () => {
        generationActive = false;
        if (consumePendingResettle()) return;
        if (settleQueued) {
            settleQueued = false;
            setTimeout(() => {
                settleLedger().catch((err) => error('queued settle failed', err));
            }, 500);
        }
    };
    if (eventTypes.GENERATION_ENDED) eventSource.on(eventTypes.GENERATION_ENDED, flushPendingResettle);
    if (eventTypes.GENERATION_STOPPED) eventSource.on(eventTypes.GENERATION_STOPPED, flushPendingResettle);

    // 切回可见时立即补跑后台期间攒下的结算。
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (settleRunning) return;
        if (consumePendingResettle()) return;
        if (settleQueued) {
            settleQueued = false;
            setTimeout(() => {
                settleLedger().catch((err) => error('queued settle failed', err));
            }, 300);
        }
    });
    eventSource.on(eventTypes.MESSAGE_DELETED, () => {
        pendingResettleIndex = -1;
        pendingResettleHash = '';
        restoreLedgerFromHistory('message-deleted');
        refreshInjection();
        renderPanel();
    });
    // 部分编辑路径（/set、其它扩展更新消息、删除 swipe）只发这两个事件。
    if (eventTypes.MESSAGE_UPDATED) {
        eventSource.on(eventTypes.MESSAGE_UPDATED, () => {
            restoreLedgerFromHistory('message-updated');
            refreshInjection();
            renderPanel();
        });
    }
    if (eventTypes.MESSAGE_SWIPE_DELETED) {
        eventSource.on(eventTypes.MESSAGE_SWIPE_DELETED, () => {
            restoreLedgerFromHistory('message-swipe-deleted');
            refreshInjection();
            renderPanel();
        });
    }

    installSendGuards();
}

function initializeState() {
    const state = getState();
    if (!state.meta.lastSettleAt) {
        state.meta.lastSettleAt = null;
    }
    saveState();
    refreshInjection();
}

jQuery(async function () {
    try {
        log(`loading v${VERSION}`);
        await loadSettingsHtml();
        bindSettings();
        createMenuButton();
        createPanel();
        initializeState();
        // 把实际加载的版本写进聊天数据：刷新后读文件就能确认跑的是哪一版。
        {
            const bootState = getState();
            if (bootState.meta.extensionVersion !== VERSION) {
                bootState.meta.extensionVersion = VERSION;
                saveState();
            }
        }
        registerEvents();
        registerSlashCommands();
        renderPanel();
        setStatus('已加载。等待结算模块。');
        window.FactLedger = {
            version: VERSION,
            selfTest() {
                const ctx = getContext();
                return {
                    version: VERSION,
                    panel: Boolean(document.getElementById('factledger_panel')),
                    menuButton: Boolean(document.getElementById('factledger_menu_button')),
                    settings: Boolean(document.getElementById('factledger_settings')),
                    chatId: ctx.getCurrentChatId?.() ?? null,
                    hasState: Boolean(ctx.chatMetadata?.[MODULE_NAME]),
                };
            },
            open: () => togglePanel(true),
            state: getState,
            refreshInjection,
            getInjection: buildInjectionText,
            getPrompt: () => getContext().extensionPrompts?.[INJECTION_KEY]?.value ?? null,
            settle: () => settleLedger({ manual: true }),
            checkLeaks: checkRecentLeaks,
            getGenre: () => getSettings().genrePreset,
            getGenreHint: () => getSettings().genreHint,
            renderStatusBar,
            getProtagonist,
            debug: buildDebugData,
            showDebug: () => showDebugModal('事实台账·调试信息', buildDebugData()),
            history: () => (getState().meta?.history || []).map((record) => record.to),
        };
        log('loaded');
    } catch (err) {
        error('load failed', err);
        setStatus(`加载失败：${err.message}`);
    }
});
