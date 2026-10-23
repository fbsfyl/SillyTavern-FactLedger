import { getContext } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import {
    createEmptyState,
    normalizeState,
    applyOps,
    assembleInjection,
    healthCheck,
    estimateTokens,
    buildExtractionPrompt,
    parseExtractionResponse,
    detectLeaks,
    selectSettleMessages,
    messageHash,
    detectAnchorMutation,
    reanchorWindow,
    computePrefixHashes,
    findReplayPoint,
    replayHistory,
    migrateNpcFields,
    migrateNpcIsolation,
    migrateStableIds,
    ensureCharacterRecord,
    PROTAGONIST_ID,
    PROTAGONIST_ALIASES,
    ACCESS_LEVELS,
    ACCESS_LABELS,
    entityAccess,
    characterAccess,
    knowsEntity,
    normalizeAccess,
} from './lib/ledger.js';
import { DEFAULT_GENRE, GENRE_PRESETS, getGenrePreset, listGenrePresets } from './lib/genres.js';
import { classifyExtractionFailure, failureMessage } from './lib/refusal.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';

const MODULE_NAME = 'factLedger';
const INJECTION_KEY = 'factledger';
const VERSION = '0.14.0';
const EXTENSION_DIR = new URL('.', import.meta.url).pathname;
// Qwen/Queen chat templates reject a system message that is not the first one,
// so the ledger is merged into the main system prompt instead of inserted
// in-chat. Role stays SYSTEM; the depth setting no longer applies.
const IN_PROMPT = 0;
const ROLE_SYSTEM = 0;

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
    injectBudget: 3000,
    depth: 0,
    knowledgeGate: true,
    leakCheck: true,
    showOthers: true,
    secretCooling: true,
};

const TABS = [
    { id: 'characters', label: '角色' },
    { id: 'knowledge', label: '认知' },
    { id: 'history', label: '日志' },
    { id: 'health', label: '健康' },
];

let activeTab = 'characters';
let panelVisible = false;
let editorMode = false;
let settleRunning = false;
let settlePending = false;
let settleQueued = false;
let lastExtractionFailure = { kind: '', at: 0 };
let knowledgeEntries = [];
const collapsedStatusPanels = new Set();

function log(...args) {
    console.log('[FactLedger]', ...args);
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
    if (typeof settings.genreHint !== 'string') {
        settings.genreHint = getGenrePreset(settings.genrePreset).hint;
    }
    if (typeof settings.narrativeRules !== 'string') {
        settings.narrativeRules = getGenrePreset(settings.genrePreset).narrativeRules || '';
    }
    return settings;
}

function saveSettings() {
    saveSettingsDebounced();
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
    const migratedItems = migrateNpcFields(state);
    const migratedIsolation = migrateNpcIsolation(state);
    const migratedIds = migrateStableIds(state);
    const normalizedAliases = normalizeStateAliases(state);
    if (migratedItems || migratedIsolation || migratedIds || normalizedAliases) {
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

function revealTargetLabel(op, state) {
    const nameOf = (id) => (id === PROTAGONIST_ID ? '你' : (state.characters?.[id]?.name || id));
    if (op.fact) return state.facts?.[op.fact]?.text || String(op.fact);
    if (op.item) {
        for (const character of Object.values(state.characters || {})) {
            const item = (character.items || []).find((entry) => entry.id === op.item && entry.validTo == null);
            if (item) return item.name;
        }
        return String(op.item);
    }
    if (op.relation) return `与 ${nameOf(op.relation)} 的关系`;
    if (op.skill || op.ability) {
        const key = op.ability ? 'abilities' : 'skills';
        const wanted = op.ability || op.skill;
        for (const character of Object.values(state.characters || {})) {
            const trait = (character[key] || []).find((entry) => entry.id === wanted && entry.validTo == null);
            if (trait) return trait.name;
        }
        return String(wanted);
    }
    if (op.event) return `事件 ${op.event}`;
    if (op.field) return `${nameOf(op.character)}.${op.field}`;
    return '秘密';
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
 * Rebuild the ledger at the newest chat prefix that still matches the op log.
 * Used for edits, deletes, swipes, branches and checkpoint restores.
 */
function restoreLedgerFromHistory(reason = '') {
    const ctx = getContext();
    const state = getState();
    const history = Array.isArray(state.meta.history) ? state.meta.history : [];

    if (!history.length) {
        state.meta.lastProcessedMessage = reanchorWindow(ctx.chat.length, 20);
        state.meta.lastProcessedHash = '';
        saveState();
        return -1;
    }

    const { index } = findReplayPoint(history, ctx.chat);
    if (index < 0) {
        // 找不到能对上的前缀时保留现有台账，只把结算锚点退回去重算最近一段。
        // 直接 replayHistory(-1) 会把角色、物品、关系和秘密全部清空。
        state.meta.lastProcessedMessage = reanchorWindow(ctx.chat.length, 20);
        state.meta.lastProcessedHash = '';
        saveState();
        log('ledger restore skipped: no matching prefix', reason);
        return -1;
    }
    const restored = replayHistory(history, index);
    state.characters = restored.characters;
    state.facts = restored.facts;
    // events 已退役：回放不再覆盖旧数据，保留原样供导出查看。
    state.scene = restored.scene;
    state.meta.history = history.filter((record) => Number(record?.to) <= index);
    // 回放会重新分配 npc_xxx，计数器只许往前，不能让后来的角色复用已有 id。
    state.meta.nextCharacterId = Math.max(
        Number(state.meta.nextCharacterId) || 1,
        Number(restored.meta?.nextCharacterId) || 1,
    );
    state.meta.lastProcessedMessage = index;
    state.meta.lastProcessedHash = index >= 0 && ctx.chat[index]
        ? messageHash(ctx.chat[index])
        : '';
    saveState();
    log('ledger restored', reason, index);
    return index;
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
    const ledger = assembleInjection(getState(), {
        tokenBudget: settings.injectBudget,
        knowledgeGate: settings.knowledgeGate,
        showOthers: settings.showOthers,
        secretCooling: settings.secretCooling,
        skillLabel: getGenrePreset(settings.genrePreset).skillLabel,
        recentText,
        fieldOrder: getGenrePreset(settings.genrePreset).fieldOrder,
        protagonistId: getProtagonist()?.id || '',
    });
    if (!rules) return ledger;
    return ledger ? `${rules}\n\n${ledger}` : rules;
}

function refreshInjection() {
    const ctx = getContext();
    const settings = getSettings();
    if (typeof ctx.setExtensionPrompt !== 'function') {
        return '';
    }
    if (!settings.enabled || !ctx.chatMetadata) {
        const rules = narrativeRulesText();
        if (!rules) {
            ctx.setExtensionPrompt(INJECTION_KEY, '', -1, 0, false, ROLE_SYSTEM);
            return '';
        }
        ctx.setExtensionPrompt(INJECTION_KEY, rules, IN_PROMPT, 0, false, ROLE_SYSTEM);
        return rules;
    }
    const text = buildInjectionText();
    ctx.setExtensionPrompt(INJECTION_KEY, text, IN_PROMPT, 0, false, ROLE_SYSTEM);
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
const EXTRACTION_TIMEOUT_MS = 20000;

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}超时（${Math.round(ms / 1000)} 秒），已放弃本次结算`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function callExtractionModel(system, user, maxTokens, options = {}) {
    const ctx = getContext();
    const settings = getSettings();
    const meta = options.meta || null;
    // 一次结算共用同一个截止时间：重试、换备选连接、解析失败重试都算在这 20 秒里。
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
    const delayMs = Number(options.delayMs ?? 8000);
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

// DeepSeek Flash thinks by default and spends the whole response budget on
// reasoning, leaving an empty content field. reasoning_effort:none disables it.
function thinkingOffPayload(profileId) {
    return /deepseek/i.test(profileModelName(profileId)) ? { reasoning_effort: 'none' } : {};
}

async function requestExtraction(service, profileId, messages, maxTokens, retries, delayMs, deadline = Date.now() + EXTRACTION_TIMEOUT_MS, meta = null) {
    const requestOptions = {
        extractData: true,
        includePreset: getSettings().extractionIncludePreset === true,
        stream: false,
    };
    const noThinking = thinkingOffPayload(profileId);
    const remaining = () => Math.max(0, deadline - Date.now());
    let lastDetail = '';

    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            const left = remaining();
            if (left <= 0) {
                throw new Error(`提取请求超时（${Math.round(EXTRACTION_TIMEOUT_MS / 1000)} 秒），已放弃本次结算`);
            }
            let response;
            try {
                response = await withTimeout(
                    service.sendRequest(profileId, messages, maxTokens, requestOptions, {
                        ...noThinking,
                        response_format: { type: 'json_object' },
                    }),
                    left,
                    '提取请求',
                );
            } catch (err) {
                const detail = errorDetail(err);
                // Some providers reject response_format; retry once without it.
                if (/response_format|json_object|bad request|400/i.test(detail)) {
                    response = await withTimeout(
                        service.sendRequest(profileId, messages, maxTokens, requestOptions, noThinking),
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
            if (isCapacity && attempt < retries && remaining() > delayMs) {
                setStatus(`模型容量不足，${Math.round(delayMs / 1000)} 秒后重试（${attempt + 1}/${retries}）…`);
                await sleep(delayMs);
                continue;
            }
            throw new Error(lastDetail || 'API request failed');
        }
    }

    throw new Error(lastDetail || 'API request failed');
}

async function settleLedger(options = {}) {
    const manual = Boolean(options.manual);
    if (settleRunning) {
        if (manual) setStatus('结算正在进行中，请稍候。');
        return null;
    }
    const ctx = getContext();
    const settings = getSettings();
    if (!settings.enabled) {
        if (manual) setStatus('台账已禁用。');
        return null;
    }
    if (!Array.isArray(ctx.chat) || ctx.chat.length === 0) {
        if (manual) setStatus('当前没有聊天消息可结算。');
        return null;
    }
    if (!settings.useCurrentConnection && !getProfileId() && !settings.fallbackProfileId) {
        if (manual) setStatus('未选择提取连接配置，请先到设置里选择，或勾选“跟随当前连接”。');
        return null;
    }

    settleRunning = true;
    settlePending = true;
    renderStatusBar();
    setStatus('正在结算本幕…');
    const settleStartedAt = Date.now();
    const extractionMeta = {};
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
            setStatus('没有新的消息需要结算。');
            return null;
        }
        const { system, user } = buildExtractionPrompt(state, messages, {
            maxMessages: messages.length,
            newFrom,
            genreHint: settings.genreHint,
        });
        // 本轮结算最多 20 秒：首次请求、重试和解析失败重试共用这个截止时间。
        const extractionDeadline = Date.now() + EXTRACTION_TIMEOUT_MS;
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
        const parsedDay = (() => {
            const number = Number.parseFloat(String(parsedScene?.day ?? ''));
            return Number.isFinite(number) ? Math.round(number) : null;
        })();
        const baseState = parsedDay === null || parsedDay === state.scene.day
            ? state
            : { ...state, scene: { ...state.scene, day: parsedDay } };
        // 记录本次新建的角色，回放时按原始 id 重建，避免按名字重新分配 id 造成串档。
        const beforeIds = new Set(Object.keys(state.characters || {}));
        const requestedOps = normalizeOpsAliases(parsed.ops);
        // 事件已退役：新结算不再接受事件 op；旧版本日志回放仍由 applyOps 处理。
        const opsForApply = requestedOps.filter((op) => op?.op !== 'append_event' && op?.op !== 'add_event');
        const ignoredEvents = requestedOps.length - opsForApply.length;
        const result = applyOps(baseState, opsForApply, {
            confidenceThreshold: settings.confidenceThreshold,
            reviewThreshold: 0.5,
            messageCount: ctx.chat.length,
            protagonistAliases,
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
                time: parsed.scene.time || parsed.scene.chapter || nextState.scene.time || '',
                // 漏写 day 时沿用旧值，别让一次空字段把日期抹掉。
                day: parsedDay ?? nextState.scene.day ?? null,
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
        const lastIndex = Number.isFinite(to) ? to : ctx.chat.length - 1;
        const prefixHashes = computePrefixHashes(ctx.chat);
        const history = (nextState.meta.history || []).filter((record) => Number(record?.to) !== lastIndex);
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
        const newCharacters = Object.values(nextState.characters || {})
            .filter((character) => !beforeIds.has(character.id))
            .map((character) => ({
                id: character.id,
                name: character.name,
                aliases: character.aliases || [],
            }));
        history.push({
            to: lastIndex,
            prefixHash: prefixHashes[lastIndex] || '',
            ops: [...result.applied, ...sceneOps],
            characters: newCharacters,
            scene: { ...nextState.scene },
        });
        nextState.meta.history = history;
        nextState.meta.lastProcessedMessage = lastIndex;
        nextState.meta.lastProcessedHash = messageHash(ctx.chat[lastIndex]);
        nextState.meta.messagesSinceSettle = 0;
        nextState.meta.lastSettleAt = new Date().toISOString();
        nextState.meta.lastError = '';
        nextState.meta.leaks = settings.leakCheck ? parsed.leaks : [];
        // 低置信 op 不落账，但要留一个入口：面板可以补采纳，否则等于静默丢弃。
        const pendingReview = Array.isArray(nextState.meta.review) ? nextState.meta.review : [];
        const freshReview = (result.review || []).map((op) => ({
            op,
            at: new Date().toISOString(),
            messageIndex: lastIndex,
        }));
        nextState.meta.review = [...pendingReview, ...freshReview].slice(-50);
        nextState.meta.health = healthCheck(nextState, { tokenBudget: settings.injectBudget });

        ctx.chatMetadata[MODULE_NAME] = nextState;
        saveState();
        refreshInjection();
        renderPanel();
        lastExtractionFailure = { kind: '', at: 0 };
        setStatus(
            `结算完成（${((Date.now() - settleStartedAt) / 1000).toFixed(1)} 秒）：应用 ${result.applied.length} 条，待复核 ${result.review.length} 条，拒绝 ${result.rejected.length} 条，泄露 ${parsed.leaks.length} 条${ignoredEvents ? `，忽略事件 ${ignoredEvents} 条` : ''}。`,
        );
        // reveal 改变了谁知道，必须让用户当场看到；只提示真正改了档位的 reveal。
        notifyReveals((result.changedOps || []).filter((op) => op && op.op === 'reveal'), nextState);
        log('settle result', result);
        return result;
    } catch (err) {
        showExtractionFailure(classifyExtractionFailure('', err, extractionMeta));
        error('settle failed', err);
        return null;
    } finally {
        settleRunning = false;
        settlePending = false;
        renderStatusBar();
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
    bindCheckbox('factledger_secret_cooling', 'secretCooling');
    bindCheckbox('factledger_narrative_rules_toggle', 'injectNarrativeRules');

    bindNumber('factledger_auto_interval', 'autoInterval');
    bindNumber('factledger_max_tokens', 'maxTokens');
    bindNumber('factledger_confidence', 'confidenceThreshold');
    bindNumber('factledger_inject_budget', 'injectBudget');

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
    panel.querySelector('#factledger_panel_edit')?.addEventListener('click', () => {
        editorMode = !editorMode;
        renderPanel();
    });
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
                ? Object.entries(character.state).map(([key, value]) => `${key}: ${value?.current ?? ''}`).join('；')
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
            const abilities = currentAbilities(character)
                .map((ability) => `${ability.name}${ability.level ? `(${ability.level})` : ''}`)
                .join('、');
            return `
                <div class="factledger-card">
                    <div class="factledger-card-head">
                        <strong>${escapeHtml(character.name || character.id)}</strong>
                        <span class="factledger-muted">${escapeHtml(character.tier || '')}</span>
                    </div>
                    <div class="factledger-muted">${escapeHtml(stateEntries || '无状态字段')}</div>
                    <div class="factledger-muted">物品：${escapeHtml(items || '无')}</div>
                    <div class="factledger-muted">${escapeHtml(preset.skillLabel || '技能')}：${escapeHtml(skills || '无')}</div>
                    <div class="factledger-muted">神通：${escapeHtml(abilities || '无')}</div>
                </div>
            `;
        })
        .join('');
}

function renderHistory(body) {
    const state = getState();
    const history = Array.isArray(state.meta?.history) ? state.meta.history : [];
    if (!history.length) {
        body.innerHTML = '<div class="factledger-empty">还没有结算日志。</div>';
        return;
    }
    const shown = history.slice(-20).reverse();
    body.innerHTML = `
        <div class="factledger-muted">共 ${history.length} 条结算记录，显示最近 ${shown.length} 条。</div>
        ${shown.map((record) => {
            const scene = record.scene || {};
            const meta = [scene.time, scene.place].filter(Boolean).join('｜');
            const count = Array.isArray(record.ops) ? record.ops.length : 0;
            return `
                <div class="factledger-card">
                    <div class="factledger-card-head">
                        <strong>#${escapeHtml(String(record.to ?? ''))}</strong>
                        <span class="factledger-badge">${count} 条 op</span>
                    </div>
                    <div class="factledger-muted">${escapeHtml(meta || '无场景信息')}</div>
                </div>
            `;
        }).join('')}
    `;
}

function isGated(entity) {
    return entityAccess(entity, 'public') !== 'public';
}

/** 一行说明：档位 + 当前够格知道的人。 */
function knownBySummary(entity, state) {
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
    const cards = [];

    for (const fact of Object.values(state.facts)) {
        cards.push({
            type: '事实',
            id: fact.id,
            text: fact.text,
            access: entityAccess(fact, 'protagonist'),
            known: knownBySummary(fact, state),
            ref: { kind: 'fact', id: fact.id },
        });
    }

    for (const character of Object.values(state.characters)) {
        // 只有主角自己的秘密需要标注知情者；NPC 自身信息公开。
        if (character.id !== protagonistId) continue;
        const name = character.name || character.id;
        for (const [field, entry] of Object.entries(character.state || {})) {
            if (!isGated(entry)) continue;
            cards.push({
                type: '字段',
                id: `${name}.${field}`,
                text: `${field}：${entry.current ?? entry}`,
                access: entityAccess(entry, 'public'),
                known: knownBySummary(entry, state),
                ref: { kind: 'field', charId: character.id, field },
            });
        }
        for (const item of (character.items || []).filter((item) => item.validTo == null && isGated(item))) {
            const quantity = Number(item.quantity ?? 1);
            const unit = item.unit || '';
            const quantityText = item.kind === 'currency' || quantity !== 1 ? `×${quantity}${unit}` : '';
            cards.push({
                type: '物品',
                id: item.id,
                text: `${name} 持有 ${item.name}${quantityText}`,
                access: entityAccess(item, 'public'),
                known: knownBySummary(item, state),
                ref: { kind: 'item', charId: character.id, itemId: item.id },
            });
        }
        for (const relation of (character.relations || []).filter((relation) => relation.validTo == null && isGated(relation))) {
            cards.push({
                type: '关系',
                id: `${name} → ${relation.targetName || relation.target}`,
                text: [relation.type, relation.attitude].filter(Boolean).join('/'),
                access: entityAccess(relation, 'public'),
                known: knownBySummary(relation, state),
                ref: { kind: 'relation', charId: character.id, target: relation.target || relation.targetName },
            });
        }
        for (const skill of (character.skills || []).filter((skill) => skill.validTo == null && isGated(skill))) {
            cards.push({
                type: '功法',
                id: skill.name,
                text: `${name} 修炼 ${skill.name}${skill.level ? `（${skill.level}）` : ''}`,
                access: entityAccess(skill, 'public'),
                known: knownBySummary(skill, state),
                ref: { kind: 'skill', charId: character.id, traitId: skill.id },
            });
        }
        for (const ability of (character.abilities || []).filter((ability) => ability.validTo == null && isGated(ability))) {
            cards.push({
                type: '神通',
                id: ability.name,
                text: `${name} 修习 ${ability.name}${ability.level ? `（${ability.level}）` : ''}`,
                access: entityAccess(ability, 'public'),
                known: knownBySummary(ability, state),
                ref: { kind: 'ability', charId: character.id, traitId: ability.id },
            });
        }
        (character.facts || []).forEach((fact, index) => {
            if (!isGated(fact)) return;
            cards.push({
                type: '个人事实',
                id: name,
                text: fact.text || fact,
                access: entityAccess(fact, 'public'),
                known: knownBySummary(fact, state),
                ref: { kind: 'characterFact', charId: character.id, index },
            });
        });
    }

    knowledgeEntries = cards;

    if (!cards.length) {
        body.innerHTML = '<div class="factledger-empty">还没有需要标注知情者的秘密。</div>';
        return;
    }

    body.innerHTML = cards
        .map((card, index) => `
            <div class="factledger-card">
                <div class="factledger-card-head">
                    <strong>${escapeHtml(card.id || '')}</strong>
                    <span class="factledger-badge ${card.access === 'protagonist' ? 'warn' : 'ok'}">${escapeHtml(card.type)} · ${escapeHtml(ACCESS_LABELS[card.access] || card.access)}</span>
                </div>
                <div>${escapeHtml(card.text || '')}</div>
                <div class="factledger-muted">${escapeHtml(card.known)}</div>
                <button class="menu_button factledger-edit-known" data-index="${index}" style="margin-top:6px;">编辑档位</button>
            </div>
        `)
        .join('');

    body.querySelectorAll('.factledger-edit-known').forEach((button) => {
        button.addEventListener('click', () => {
            const entry = knowledgeEntries[Number(button.dataset.index)];
            if (entry) openKnownByEditor(entry);
        });
    });
}

function resolveEntity(ref) {
    const state = getState();
    switch (ref?.kind) {
        case 'fact':
            return state.facts[ref.id];
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
        case 'ability':
            return state.characters[ref.charId]?.abilities?.find((ability) => ability.validTo == null && ability.id === ref.traitId);
        case 'characterFact':
            return state.characters[ref.charId]?.facts?.[ref.index];
        default:
            return null;
    }
}

function openKnownByEditor(card) {
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
            <div class="factledger-muted">对象：${escapeHtml(card.type)} · ${escapeHtml(card.id || '')}</div>
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
        const selected = document.getElementById('factledger_known_access')?.value || current;
        entity.access = normalizeAccess(selected, current);
        // 旧字段不再参与判定，顺手清掉，避免两份规则并存。
        delete entity.visibility;
        delete entity.knownBy;
        saveState();
        refreshInjection();
        close();
        renderPanel();
        setStatus(`已把「${card.id || card.type}」改为${ACCESS_LABELS[entity.access]}。`);
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
    return Object.values(state.characters).find((character) => character.tier === 'main') || null;
}

function stateValue(entry) {
    if (entry === undefined || entry === null) return '';
    return entry?.current ?? entry;
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

function currentAbilities(character) {
    return (character.abilities || []).filter((ability) => ability.validTo == null);
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
        option.textContent = `${character.name || character.id}${character.tier === 'main' ? '（main）' : ''}`;
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
    if (!settings.statusBarEnabled) {
        bar?.remove();
        return;
    }
    const target = getProtagonist();
    const protagonist = target || { id: '', name: '', state: {}, items: [], relations: [], skills: [], abilities: [] };

    const state = getState();
    const preset = getGenrePreset(settings.genrePreset);
    const id = protagonist.id;
    const worldLines = [];
    const personalLines = [];

    const scenePlace = state.scene?.place || '';
    worldLines.push(`时间：${state.scene?.time || '未知'}`);
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
        // progress 单独画进度条，不再作为一行文字重复出现。
        if (field === 'location' || field === 'objective' || field === 'progress') continue;
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
    const realmValue = stateValue(protagonist.state?.realm);
    const progressBar = progressValue === null ? '' : `
        <div class="factledger-progress">
            <div class="factledger-progress-meta">
                <span>${escapeHtml([progressLabel, realmValue].filter(Boolean).join('｜'))}</span>
                <span>${progressValue}%</span>
            </div>
            <div class="factledger-progress-track">
                <div class="factledger-progress-fill" style="width:${progressValue}%"></div>
            </div>
        </div>
    `;

    const skillLines = currentSkills(protagonist).map((skill) => (
        [skill.name, skill.level].filter(Boolean).join('｜')
    ));

    const abilityLines = currentAbilities(protagonist).map((ability) => (
        [ability.name, ability.level].filter(Boolean).join('｜')
    ));

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

    const relationLines = [];
    const participantIds = (state.scene?.participants || []).filter((pid) => pid !== id);
    for (const pid of participantIds) {
        const npc = state.characters[pid];
        if (!npc) {
            relationLines.push(`${pid}｜未知｜未知`);
            continue;
        }
        const gender = stateValue(npc.state?.gender);
        const levelEntry = npc.state?.realm || npc.state?.rank || npc.state?.level || npc.state?.stage;
        const level = stateValue(levelEntry);
        const ownRelation = (protagonist.relations || []).find((item) => item.validTo == null && item.target === pid);
        // 称呼与「NPC 怎么看玩家」通常记在 NPC→玩家这条边上。
        const npcRelation = (npc.relations || []).find((item) => item.validTo == null && protagonist.id && item.target === protagonist.id);
        const relation = ownRelation || npcRelation || null;
        const address = npcRelation?.address || ownRelation?.address || '';
        const relationText = (relation || address)
            ? [[relation?.type, relation?.attitude].filter(Boolean).join('/'), address ? `称「${address}」` : ''].filter(Boolean).join('，')
            : '';
        relationLines.push([npc.name || pid, gender || '未知', level || '未知', ACCESS_LABELS[characterAccess(npc)] || characterAccess(npc), relationText].filter(Boolean).join('｜'));
    }

    // 开局还没有主角记录时也要显示骨架（时间/地点/境界进度），而不是整条状态栏消失。
    const panels = [
        { key: 'world', title: '状态', lines: worldLines },
        { key: 'personal', title: '个人状态', lines: personalLines, extra: progressBar },
        { key: 'skills', title: preset.skillLabel || '技能', lines: skillLines },
        { key: 'abilities', title: '神通', lines: abilityLines },
        { key: 'items', title: '物品', lines: itemLines },
        { key: 'relations', title: '关系', lines: relationLines, head: '人物｜性别｜境界｜档位｜关系' },
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
            <span class="factledger-statusbar-open" title="打开完整台账">打开台账</span>
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
    const injection = assembleInjection(state, {
        tokenBudget: settings.injectBudget,
        knowledgeGate: settings.knowledgeGate,
        showOthers: settings.showOthers,
        secretCooling: settings.secretCooling,
        skillLabel: getGenrePreset(settings.genrePreset).skillLabel,
        recentText: '',
        fieldOrder: getGenrePreset(settings.genrePreset).fieldOrder,
        protagonistId: getProtagonist()?.id || '',
    });
    const issues = healthCheck(state, { injection, tokenBudget: settings.injectBudget });
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
                <div class="factledger-muted">
                    ${escapeHtml(leak.characterName || leak.character || '')}：${escapeHtml(leak.factText || leak.fact || '')}
                    <button class="menu_button" data-leak-ack="${index}">设为已知</button>
                    <button class="menu_button" data-leak-dismiss="${index}" title="仅清除本条记录，台账不变；叙事者下次仍可能越界。反复出现时建议设为已知或修正提取规则。">忽略</button>
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
}

/** 低置信 op 的可读摘要，避免在面板里糊一整段 JSON。 */
function describeReviewOp(op) {
    const parts = [String(op?.op || 'op')];
    for (const key of ['character', 'field', 'value', 'fact', 'item', 'skill', 'ability', 'relation', 'to', 'access', 'reason']) {
        if (op?.[key] === undefined || op?.[key] === null || op?.[key] === '') continue;
        const value = typeof op[key] === 'object' ? JSON.stringify(op[key]) : String(op[key]);
        parts.push(`${key}=${value}`);
    }
    const text = parts.join(' ');
    return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

/** 叙事者已经写漏了：把这条泄漏接成既成事实，或当它没发生。 */
function findFactForLeak(state, leak) {
    const id = leak.factId || leak.fact || '';
    if (state.facts?.[id]) return state.facts[id];
    const text = String(leak.factText || leak.fact || '').trim();
    return Object.values(state.facts || {}).find((fact) => String(fact.text || '').trim() === text) || null;
}

/** 把泄露记录还原成 reveal 的目标；0.13.4 之前只有顶层事实。 */
function leakRevealTarget(state, leak) {
    const target = leak.target || {};
    if (target.item) return { item: target.item, label: target.item };
    if (target.skill) return { skill: target.skill, label: target.skill };
    if (target.ability) return { ability: target.ability, label: target.ability };
    if (target.relation) return { relation: target.relation, label: `关系 ${target.relation}` };
    if (target.character && target.fact) {
        const name = state.characters?.[target.character]?.name || target.character;
        return { character: target.character, fact: target.fact, label: `${name}：${target.fact}` };
    }
    if (target.character && target.field) {
        const name = state.characters?.[target.character]?.name || target.character;
        return { character: target.character, field: target.field, label: `${name}.${target.field}` };
    }
    const fact = findFactForLeak(state, leak);
    return fact ? { fact: fact.id, label: fact.text } : null;
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
        ...(target.fact ? { fact: target.fact } : {}),
        ...(target.item ? { item: target.item } : {}),
        ...(target.skill ? { skill: target.skill } : {}),
        ...(target.ability ? { ability: target.ability } : {}),
        ...(target.relation ? { relation: target.relation } : {}),
        ...(target.character && target.field ? { character: target.character, field: target.field } : {}),
        ...(target.character && target.fact ? { character: target.character, fact: target.fact } : {}),
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
    const existing = history.find((record) => Number(record?.to) === lastIndex);
    if (existing) {
        existing.ops = [...(existing.ops || []), ...ops];
    } else {
        const prefixHashes = computePrefixHashes(ctx.chat);
        history.push({
            to: lastIndex,
            prefixHash: prefixHashes[lastIndex] || '',
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
    const { needsReview, ...op } = entry.op || entry;
    const result = applyOps(state, [op], { confidenceThreshold: 0, reviewThreshold: 0 });
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
        factIds: Object.keys(state.facts || {}),
        leakCount: Array.isArray(state.meta?.leaks) ? state.meta.leaks.length : 0,
        injectionTokens: estimateTokens(injection),
        settings: {
            autoInterval: settings.autoInterval,
            genrePreset: settings.genrePreset,
            profileId: settings.profileId,
            maxTokens: settings.maxTokens,
            confidenceThreshold: settings.confidenceThreshold,
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
            const target = [...history]
                .reverse()
                .find((record) => Number(record.to) <= index && Number(record.to) < ctx.chat.length);
            if (!target) {
                setStatus(`没有 <= #${index} 的版本记录。`);
                return '';
            }
            const restored = replayHistory(history, target.to);
            state.characters = restored.characters;
            state.facts = restored.facts;
            // events 已退役：回放不再覆盖旧数据。
            state.scene = restored.scene;
            state.meta.history = history.filter((record) => Number(record.to) <= target.to);
            state.meta.lastProcessedMessage = target.to;
            state.meta.lastProcessedHash = messageHash(ctx.chat[target.to]);
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
    const leaks = detectLeaks(state, lastAssistant.mes, active);
    state.meta.leaks = leaks;
    saveState();
    renderPanel();
    setStatus(`泄露检查完成：候选 ${leaks.length} 条。`);
}

function renderEditor(body) {
    const state = getState();
    body.innerHTML = `
        <div class="factledger-muted">直接编辑完整台账 JSON。保存前会做基本结构校验。</div>
        <textarea id="factledger_editor">${escapeHtml(JSON.stringify(state, null, 2))}</textarea>
        <div class="factledger-actions">
            <button class="menu_button" id="factledger_editor_save">保存</button>
            <button class="menu_button" id="factledger_editor_cancel">取消</button>
        </div>
    `;
    body.querySelector('#factledger_editor_save')?.addEventListener('click', saveEditor);
    body.querySelector('#factledger_editor_cancel')?.addEventListener('click', () => {
        editorMode = false;
        renderPanel();
    });
}

function saveEditor() {
    const textarea = document.getElementById('factledger_editor');
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
        editorMode = false;
        renderPanel();
        setStatus('台账 JSON 已保存。');
    } catch (err) {
        setStatus(`保存失败：${err.message}`);
    }
}

function renderPanel() {
    const body = document.getElementById('factledger_body');
    if (!body) return;

    populateProtagonistSelect();
    renderStatusBar();

    if (editorMode) {
        document.querySelectorAll('.factledger-tab').forEach((el) => el.classList.remove('active'));
        renderEditor(body);
        return;
    }

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
        editorMode = false;
        restoreLedgerFromHistory('chat-changed');
        refreshInjection();
        renderPanel();
        setStatus(`已切换聊天：${ctx.getCurrentChatId?.() ?? ''}`);
    });

    eventSource.on(eventTypes.MESSAGE_RECEIVED, () => {
        const state = getState();
        const settings = getSettings();
        state.meta.messagesSinceSettle = (state.meta.messagesSinceSettle || 0) + 1;
        saveState();
        refreshInjection();
        renderPanel();

        if (!settings.enabled || settings.autoInterval <= 0) return;
        if (state.meta.messagesSinceSettle < settings.autoInterval) return;
        if (settleRunning) {
            // 结算期间到达的回复不能丢，等本轮结束后补一次。
            settleQueued = true;
            return;
        }
        if (settings.useCurrentConnection || getProfileId() || settings.fallbackProfileId) {
            settleLedger().catch((err) => error('auto settle failed', err));
        }
    });

    eventSource.on(eventTypes.GENERATION_AFTER_COMMANDS, () => {
        refreshInjection();
    });

    const invalidateFrom = (index) => {
        const changed = Number(index);
        if (!Number.isFinite(changed)) return;
        restoreLedgerFromHistory('message-edited');
        refreshInjection();
        renderPanel();
    };

    eventSource.on(eventTypes.MESSAGE_EDITED, (index) => invalidateFrom(index));
    eventSource.on(eventTypes.MESSAGE_SWIPED, (index) => invalidateFrom(index));
    eventSource.on(eventTypes.MESSAGE_DELETED, () => {
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
