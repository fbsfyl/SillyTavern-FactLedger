import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createEmptyState,
    normalizeState,
    applyOps,
    validateOps,
    assembleInjection,
    estimateTokens,
    parseExtractionResponse,
    extractMentionedFacts,
    detectLeaks,
    detectMissingMajorEvent,
    buildExtractionPrompt,
    selectSettleMessages,
    messageHash,
    detectAnchorMutation,
    reanchorWindow,
    computePrefixHashes,
    findReplayPoint,
    replayHistory,
    healthCheck,
    migrateNpcFields,
    migrateNpcIsolation,
    migrateStableIds,
    entityAccess,
    characterAccess,
    knowsEntity,
    ensureCharacterRecord,
} from '../lib/ledger.js';
import { DEFAULT_GENRE, getGenrePreset } from '../lib/genres.js';

function run(state, ops, options = {}) {
    return applyOps(state, ops, { confidenceThreshold: 0.7, reviewThreshold: 0.5, ...options });
}

function findCharacter(state, name) {
    return state.characters[name]
        || Object.values(state.characters || {}).find((character) => character.name === name
            || character.id === name
            || (character.aliases || []).includes(name));
}

/** 主角 + 朋友级苏绾 + 公开级王掌柜，用于测按剧情定档。 */
function tierState() {
    const state = createEmptyState();
    state.characters.user = { id: 'user', name: '你', tier: 'main', access: 'protagonist', state: {}, items: [], relations: [], facts: [], skills: [], abilities: [] };
    state.characters.su = { id: 'su', name: '苏绾', tier: 'major', access: 'friend', state: {}, items: [], relations: [], facts: [], skills: [], abilities: [] };
    state.characters.wang = { id: 'wang', name: '王掌柜', tier: 'major', access: 'public', state: {}, items: [], relations: [], facts: [], skills: [], abilities: [] };
    return state;
}

function eventOp(extra = {}) {
    return {
        op: 'append_event',
        time: '第一日',
        place: '客栈',
        problem: '出了事',
        decision: '去处理',
        result: '处理完',
        stateChanges: ['有变化'],
        sourceMessages: [0],
        evidence: 'msg:0',
        confidence: 0.9,
        ...extra,
    };
}

test('createEmptyState 结构完整', () => {
    const state = createEmptyState();
    assert.equal(state.version, 1);
    assert.deepEqual(state.characters, {});
    assert.deepEqual(state.events, []);
    assert.equal(state.scene.time, '');
});

test('migrateNpcFields 将 NPC 物品转为事实并清空 items/relations', () => {
    const state = createEmptyState();
    state.meta.schemaVersion = 3;
    state.characters.npc = {
        id: 'npc',
        name: '苏婉',
        tier: 'major',
        state: {},
        items: [{ id: 'i_dagger', name: '毒匕首', kind: 'equipment', quantity: 1, validTo: null }],
        relations: [{ target: 'lin_yuan' }],
        facts: [],
    };

    const changed = migrateNpcFields(state);
    assert.equal(changed, true);
    assert.equal(state.characters.npc.items.length, 0);
    assert.equal(state.characters.npc.relations.length, 0);
    assert.match(state.characters.npc.facts[0].text, /毒匕首/);
    assert.equal(state.meta.schemaVersion, 4);
});

test('migrateNpcIsolation 清除 NPC 自身信息的隔离标记，主角保留', () => {
    const state = createEmptyState();
    state.meta.schemaVersion = 4;
    state.characters = {
        lin_yuan: {
            id: 'lin_yuan', name: '林远', tier: 'main',
            state: { realm: { current: '筑基一层', visibility: 'secret', knownBy: { lin_yuan: { state: 'knows' } }, history: [] } },
            items: [], relations: [], facts: [],
        },
        wang: {
            id: 'wang', name: '王掌柜', tier: 'major',
            state: {
                realm: { current: '筑基九层', visibility: 'secret', knownBy: { su_wan: { state: 'knows' } }, history: [] },
            },
            items: [{ id: 'i1', name: '算盘', visibility: 'secret', knownBy: { wang: { state: 'knows' } }, validTo: null }],
            relations: [{ target: 'lin_yuan', visibility: 'secret', knownBy: {}, validTo: null }],
            facts: [{ text: '隐藏修为', visibility: 'secret', knownBy: {} }],
        },
    };

    assert.equal(migrateNpcIsolation(state), true);
    assert.equal(state.meta.schemaVersion, 5);
    assert.equal(state.characters.wang.state.realm.current, '筑基九层');
    assert.equal(state.characters.wang.state.realm.visibility, undefined);
    assert.equal(state.characters.wang.state.realm.knownBy, undefined);
    assert.equal(state.characters.wang.items[0].knownBy, undefined);
    assert.equal(state.characters.wang.relations[0].visibility, undefined);
    assert.equal(state.characters.wang.facts[0].visibility, undefined);
    // NPC 自身信息一律公开，不再带档位。
    assert.equal(entityAccess(state.characters.wang.state.realm), 'public');
    assert.equal(entityAccess(state.characters.wang.items[0]), 'public');
    assert.equal(entityAccess(state.characters.lin_yuan.state.realm), 'protagonist');
    assert.equal(migrateNpcIsolation(state), false);
});

test('normalizeState 将旧 chapter 迁移为 time 并删除 chapter', () => {
    const state = normalizeState({
        scene: { chapter: 'ch01', place: '客栈', participants: [] },
        events: [{ id: 'e1', chapter: 'ch02', problem: 'x', result: 'y' }],
        characters: {},
    });
    assert.equal(state.scene.time, 'ch01');
    assert.equal(state.scene.chapter, undefined);
    assert.equal(state.events[0].time, 'ch02');
    assert.equal(state.events[0].chapter, undefined);
});

test('set 双时态：旧值关闭，新值成为 current', () => {
    let state = createEmptyState();
    state.scene.time = 'ch03';
    let result = run(state, [
        { op: 'set', character: 'lin_yuan', name: '林远', field: 'realm', value: '炼气六层', validFrom: 'ch03', evidence: 'msg:1', confidence: 0.95 },
    ]);
    state = result.state;

    result = run(state, [
        { op: 'set', character: 'lin_yuan', field: 'realm', value: '炼气七层', validFrom: 'ch12', evidence: 'msg:87', confidence: 0.9 },
    ]);
    state = result.state;

    const entry = state.characters.lin_yuan.state.realm;
    assert.equal(entry.current, '炼气七层');
    assert.equal(entry.history.length, 2);
    assert.equal(entry.history[0].value, '炼气六层');
    assert.equal(entry.history[0].validTo, 'ch12');
    assert.equal(entry.history[1].value, '炼气七层');
    assert.equal(entry.history[1].validTo, null);
});

test('add_item + move_item：物品转手只保留一个当前持有人', () => {
    let state = createEmptyState();
    let result = run(state, [
        { op: 'add_item', character: 'lin_yuan', name: '林远', item: { id: 'i_sword', name: '青锋剑' }, validFrom: 'ch03', evidence: 'msg:2', confidence: 0.95 },
    ]);
    state = result.state;

    result = run(state, [
        { op: 'move_item', item: 'i_sword', to: 'su_wan', toName: '苏婉', validFrom: 'ch13', evidence: 'msg:90', confidence: 0.9 },
    ]);
    state = result.state;

    const lin = state.characters.lin_yuan.items.filter((item) => item.id === 'i_sword');
    const su = state.characters.su_wan.items.filter((item) => item.id === 'i_sword');
    assert.equal(lin.length, 1);
    assert.equal(lin[0].validTo, 'ch13');
    assert.equal(su.length, 1);
    assert.equal(su[0].holder, 'su_wan');
    assert.equal(su[0].validTo, null);
});

test('set_relation 关系更新保留历史', () => {
    let state = createEmptyState();
    let result = run(state, [
        { op: 'set_relation', from: 'lin_yuan', to: 'su_wan', toName: '苏婉', type: '同门', attitude: '互相试探', validFrom: 'ch02', evidence: 'msg:3', confidence: 0.9 },
    ]);
    state = result.state;
    result = run(state, [
        { op: 'set_relation', from: 'lin_yuan', to: 'su_wan', toName: '苏婉', type: '同门', attitude: '信任', validFrom: 'ch20', evidence: 'msg:120', confidence: 0.9 },
    ]);
    state = result.state;

    const relations = state.characters.lin_yuan.relations;
    assert.equal(relations.length, 2);
    assert.equal(relations[0].attitude, '互相试探');
    assert.equal(relations[0].validTo, 'ch20');
    assert.equal(relations[1].attitude, '信任');
    assert.equal(relations[1].validTo, null);
});

test('append_event 自动生成 id 并可追加', () => {
    const state = createEmptyState();
    const result = run(state, [
        { op: 'append_event', event: { time: 'ch05', place: '黑风寨', actors: ['lin_yuan'], problem: '矿脉被劫', decision: '夜袭', result: '夺回', importance: 'major', sourceMessages: [41, 42] } },
    ]);
    assert.equal(result.state.events.length, 1);
    assert.match(result.state.events[0].id, /^e\d{4}$/);
    assert.equal(result.state.events[0].importance, 'major');
});

test('reveal 放宽档位并写入泄露事件', () => {
    let state = createEmptyState();
    state.characters.su_wan = {
        id: 'su_wan', name: '苏婉', tier: 'npc', access: 'friend',
        state: {}, items: [], relations: [], facts: [], skills: [], abilities: [],
    };
    let result = run(state, [
        { op: 'add_fact', fact: { id: 'f_orb', text: '林远持有混沌珠', access: 'protagonist' }, evidence: 'msg:10', confidence: 0.95 },
    ]);
    state = result.state;
    result = run(state, [
        { op: 'reveal', fact: 'f_orb', to: '苏婉', by: '林远', method: '战斗中被迫使用', evidence: 'msg:92', confidence: 0.95 },
    ]);
    state = result.state;

    assert.equal(entityAccess(state.facts.f_orb), 'friend');
    assert.ok(state.events.some((event) => event.problem === '秘密泄露'));
});

test('validateOps 拒绝缺证据与低置信度，标记待复核', () => {
    const state = createEmptyState();
    const result = validateOps([
        { op: 'set', character: 'a', field: 'realm', value: 'x', confidence: 0.9 },
        { op: 'set', character: 'a', field: 'realm', value: 'x', evidence: 'msg:1', confidence: 0.3 },
        { op: 'set', character: 'a', field: 'realm', value: 'x', evidence: 'msg:1', confidence: 0.6 },
    ], state, { confidenceThreshold: 0.7, reviewThreshold: 0.5 });

    assert.equal(result.accepted.length, 0);
    assert.equal(result.review.length, 1);
    assert.equal(result.rejected.length, 2);
});

test('validateOps 拒绝超出消息范围的 evidence', () => {
    const state = createEmptyState();
    const result = validateOps(
        [{ op: 'set', character: 'a', field: 'realm', value: 'x', evidence: 'msg:99', confidence: 0.9 }],
        state,
        { confidenceThreshold: 0.7, reviewThreshold: 0.5, messageCount: 10 },
    );
    assert.equal(result.rejected.length, 1);
    assert.match(result.rejected[0].reason, /超出消息范围/);
});

test('档位字段支持新写法，旧 visibility 折算成档位', () => {
    const state = createEmptyState();
    state.characters.lin_yuan = {
        id: 'lin_yuan', name: '林远', tier: 'main', access: 'protagonist',
        state: {}, items: [], relations: [], facts: [],
    };
    const result = run(state, [
        {
            op: 'add_item',
            character: 'lin_yuan',
            item: { id: 'i_orb', name: '混沌珠', access: 'intimate' },
            evidence: 'msg:0',
            confidence: 0.9,
        },
    ]);
    assert.equal(entityAccess(result.state.characters.lin_yuan.items[0]), 'intimate');

    const secret = normalizeState({
        characters: {},
        events: [],
        facts: { f1: { id: 'f1', text: '秘密', visibility: 'secret' } },
    });
    assert.equal(entityAccess(secret.facts.f1), 'protagonist');
    const open = normalizeState({
        characters: {},
        events: [],
        facts: { f2: { id: 'f2', text: '公开', visibility: 'public' } },
    });
    assert.equal(entityAccess(open.facts.f2), 'public');
});

test('预算收紧时优先保留秘密认知', () => {
    const state = createEmptyState();
    state.characters.lin_yuan = {
        id: 'lin_yuan', name: '林远', tier: 'main',
        state: { realm: { current: '筑基一层', history: [] } },
        items: [], skills: [], relations: [], facts: [],
    };
    state.characters.su_wan = {
        id: 'su_wan', name: '苏婉', tier: 'major', state: {}, items: [], skills: [], relations: [], facts: [],
    };
    state.facts.f_orb = {
        id: 'f_orb',
        text: '林远持有混沌珠',
        visibility: 'secret',
        knownBy: { lin_yuan: { state: 'knows' }, su_wan: { state: 'unaware' } },
        history: [],
    };
    state.scene = { time: '第三日 夜', place: '客栈', participants: ['lin_yuan', 'su_wan'] };
    for (let i = 0; i < 30; i += 1) {
        state.events.push({
            id: `e${String(i).padStart(4, '0')}`,
            problem: `旧事件${i}的问题描述很长很长`,
            result: `旧事件${i}的结果描述很长很长`,
            importance: 'normal',
            visibility: 'public',
            witnesses: [],
            sourceMessages: [i],
        });
    }

    const text = assembleInjection(state, { tokenBudget: 500, protagonistId: 'lin_yuan' });
    assert.match(text, /混沌珠/);
    assert.match(text, /秘密知情/);
    assert.ok(estimateTokens(text) <= 700, `注入仍然过大：${estimateTokens(text)}`);
});

test('set_scene 支持顶层 time/place/participants', () => {
    const result = run(createEmptyState(), [
        { op: 'set_scene', time: '第三日 夜', place: '客栈', participants: ['lin_yuan'], evidence: 'msg:0', confidence: 0.9 },
    ]);
    assert.equal(result.state.scene.time, '第三日 夜');
    assert.equal(result.state.scene.place, '客栈');
    assert.deepEqual(result.state.scene.participants, ['lin_yuan']);
});

test('add_event 与 set_scene field/value 兼容写法', () => {
    const result = run(createEmptyState(), [
        { op: 'set_scene', field: 'place', value: '客栈', evidence: 'msg:0', confidence: 0.9 },
        { op: 'add_event', event: { problem: '旧事', result: '结束', stateChanges: ['旧事结束'], sourceMessages: [0] } },
    ]);
    assert.equal(result.state.scene.place, '客栈');
    assert.equal(result.state.events.length, 1);
    assert.equal(result.state.events[0].problem, '旧事');
});

test('validateOps 容错 evidence 写法 msg:#0 与 msg:2,3', () => {
    const state = createEmptyState();
    const result = validateOps([
        { op: 'set', character: 'a', field: 'realm', value: 'x', evidence: 'msg:#0', confidence: 0.9 },
        { op: 'set', character: 'a', field: 'realm', value: 'y', evidence: 'msg:2,3', confidence: 0.9 },
        { op: 'set', character: 'a', field: 'realm', value: 'z', evidence: 'msg:4, msg:12', confidence: 0.9 },
    ], state, { confidenceThreshold: 0.7, reviewThreshold: 0.5, messageCount: 20 });
    assert.equal(result.accepted.length, 3);
});

test('重复 add_fact 保留档位并记录误信，reveal 可用事实文本定位', () => {
    const state = createEmptyState();
    state.characters.lin_yuan = { id: 'lin_yuan', name: '林远', tier: 'main', state: {}, items: [], relations: [], facts: [] };
    state.characters.su_wan = { id: 'su_wan', name: '苏婉', tier: 'major', access: 'friend', state: {}, items: [], relations: [], facts: [] };

    let result = run(state, [
        {
            op: 'add_fact',
            fact: { id: 'f_orb', text: '林远持有混沌珠', access: 'protagonist' },
            evidence: 'msg:0',
            confidence: 0.95,
        },
    ]);
    result = run(result.state, [
        {
            op: 'add_fact',
            fact: {
                id: 'f_orb',
                text: '林远持有混沌珠',
                beliefs: { su_wan: { state: 'suspects', suspicion: '看向怀里' } },
            },
            evidence: 'msg:1',
            confidence: 0.95,
        },
    ]);
    assert.equal(entityAccess(result.state.facts.f_orb), 'protagonist');
    assert.equal(result.state.facts.f_orb.beliefs.su_wan.state, 'suspects');

    result = run(result.state, [
        { op: 'reveal', fact: '林远持有混沌珠', to: 'su_wan', by: 'lin_yuan', method: '被看见', evidence: 'msg:2', confidence: 0.95 },
    ]);
    assert.equal(entityAccess(result.state.facts.f_orb), 'friend');
    assert.equal(knowsEntity(result.state.facts.f_orb, 'su_wan', result.state), true);
});

test('selectSettleMessages 只取新消息并带上下文', () => {
    const chat = Array.from({ length: 10 }, (_, i) => ({ is_user: i % 2 === 0, mes: `m${i}`, name: `n${i}` }));
    const incremental = selectSettleMessages(chat, 6, { contextCount: 3, maxNew: 20, userName: 'U', aiName: 'A' });
    assert.equal(incremental.newFrom, 7);
    assert.deepEqual(incremental.messages.map((m) => m.index), [4, 5, 6, 7, 8, 9]);

    const first = selectSettleMessages(Array.from({ length: 30 }, (_, i) => ({ mes: `m${i}` })), -1, {
        contextCount: 3, maxNew: 20,
    });
    assert.equal(first.newFrom, 0);
    assert.equal(first.messages[0].index, 0);
    assert.equal(first.messages.length, 20);
    assert.equal(first.to, 19);

    // 积压时从最早未结算的一批开始，下一轮接着处理剩下的。
    const second = selectSettleMessages(Array.from({ length: 30 }, (_, i) => ({ mes: `m${i}` })), first.to, {
        contextCount: 3, maxNew: 20,
    });
    assert.equal(second.newFrom, 20);
    assert.equal(second.messages[0].index, 17);
    assert.equal(second.messages.length, 13);
    assert.equal(second.to, 29);

    const empty = selectSettleMessages([{ mes: '  ' }, { mes: 'ok' }], -1, { contextCount: 3 });
    assert.equal(empty.messages.length, 1);
    assert.equal(empty.messages[0].index, 1);
});

test('检测编辑/删除/分支导致的锚点失效', () => {
    const chat = [
        { is_user: true, mes: 'a' },
        { is_user: false, mes: 'b' },
        { is_user: true, mes: 'c' },
    ];
    assert.equal(detectAnchorMutation(chat, 2, messageHash(chat[2])), false);
    assert.equal(detectAnchorMutation(chat, 3, messageHash(chat[2])), true);
    assert.equal(detectAnchorMutation(chat, 2, messageHash({ is_user: true, mes: 'edited' })), true);
    assert.equal(detectAnchorMutation(chat, -1, ''), false);
    assert.equal(reanchorWindow(30, 20), 9);
    assert.equal(reanchorWindow(3, 20), -1);
    assert.equal(messageHash(chat[2]), messageHash({ is_user: true, mes: 'c' }));
});

test('前缀哈希能定位编辑/截断后的回放点', () => {
    const chat = [0, 1, 2, 3, 4].map((i) => ({ is_user: i % 2 === 0, mes: `m${i}` }));
    const hashes = computePrefixHashes(chat);
    const history = [
        { to: 1, prefixHash: hashes[1], ops: [] },
        { to: 3, prefixHash: hashes[3], ops: [] },
    ];
    assert.equal(findReplayPoint(history, chat).index, 3);

    const edited = chat.map((message) => ({ ...message }));
    edited[3].mes = 'changed';
    assert.equal(findReplayPoint(history, edited).index, 1);

    assert.equal(findReplayPoint(history, chat.slice(0, 2)).index, 1);
    assert.equal(findReplayPoint(history, chat.slice(0, 3)).index, 1);
});

test('replayHistory 能按日志重建到任意回合', () => {
    const history = [
        {
            to: 0,
            ops: [{ op: 'add_item', character: 'lin_yuan', name: '林远', item: { id: 'i_sword', name: '青锋剑' }, evidence: 'msg:0', confidence: 0.9 }],
        },
        {
            to: 1,
            ops: [{ op: 'move_item', item: 'i_sword', to: 'su_wan', toName: '苏婉', evidence: 'msg:1', confidence: 0.9 }],
        },
    ];

    const early = replayHistory(history, 0);
    assert.equal(early.characters.lin_yuan.items.filter((item) => item.validTo == null).length, 1);
    assert.equal((early.characters.su_wan?.items || []).filter((item) => item.validTo == null).length, 0);

    const late = replayHistory(history, 1);
    assert.equal(late.characters.lin_yuan.items.filter((item) => item.validTo == null).length, 0);
    assert.equal(late.characters.su_wan.items.filter((item) => item.validTo == null).length, 1);
});

test('提取提示不发送 meta 与版本日志', () => {
    const state = createEmptyState();
    state.meta.lastError = 'META_SECRET';
    state.meta.history.push({ to: 0, prefixHash: 'x', ops: [], scene: {} });
    const { user } = buildExtractionPrompt(state, [], {});
    assert.doesNotMatch(user, /META_SECRET/);
    assert.doesNotMatch(user, /"history"/);
    assert.match(user, /"characters"/);
});

test('buildExtractionPrompt 标记上下文消息与提取范围', () => {
    const state = createEmptyState();
    const messages = [4, 5, 6, 7].map((index) => ({
        index, isUser: index % 2 === 0, name: 'AI', mes: `消息${index}`,
    }));
    const { system, user } = buildExtractionPrompt(state, messages, { newFrom: 7 });
    assert.match(system, /\[context\]/);
    assert.match(user, /#4 \[context\]/);
    assert.match(user, /#7 AI: 消息7/);
    assert.doesNotMatch(user, /#7 \[context\]/);
    assert.match(user, /只提取 #7 及之后/);
});

test('append_event 相同事件不重复追加', () => {
    const state = createEmptyState();
    const op = {
        op: 'append_event',
        event: {
            time: '第三日 夜', place: '客栈', actors: ['lin_yuan'],
            problem: '矿脉被劫', decision: '夜袭', result: '夺回', stateChanges: ['矿脉夺回'], sourceMessages: [3],
        },
    };
    const result = run(state, [op, op]);
    assert.equal(result.state.events.length, 1);
});

test('append_event 的 stateChanges 写成对象时转成可读文本', () => {
    const state = createEmptyState();
    const result = run(state, [
        {
            op: 'append_event',
            event: {
                time: '第三日', place: '客栈', actors: ['lin_yuan'], problem: '争执', decision: '赔钱', result: '和解',
                stateChanges: [{ field: 'money', from: 10, to: 5 }, '与王掌柜关系变差'], sourceMessages: [3],
            },
        },
    ]);
    assert.deepEqual(result.state.events[0].stateChanges, ['field: money；from: 10；to: 5', '与王掌柜关系变差']);
});

test('加载旧台账时清掉 stateChanges 里的 [object Object]', () => {
    const state = createEmptyState();
    state.events.push({
        id: 'e0001', time: '第一日', place: '客栈', actors: ['user'], problem: '争执', decision: '赔钱', result: '和解',
        stateChanges: ['[object Object]', '境界提升'], knownBy: {}, witnesses: [], keywords: [], sourceMessages: [],
    });
    const result = normalizeState(state);
    assert.deepEqual(result.events[0].stateChanges, ['境界提升']);
});

test('assembleInjection 包含主角色、事件与秘密知情', () => {
    let state = createEmptyState();
    state.scene = { time: '夜', place: '黑风寨', participants: ['lin_yuan', 'su_wan'] };
    state.characters.lin_yuan = { id: 'lin_yuan', name: '林远', tier: 'main', state: {}, items: [], relations: [], facts: [] };
    let result = run(state, [
        { op: 'set', character: 'lin_yuan', name: '林远', field: 'realm', value: '炼气七层', validFrom: 'ch12', evidence: 'msg:87', confidence: 0.9 },
        { op: 'add_item', character: 'lin_yuan', name: '林远', item: { id: 'i_sword', name: '青锋剑' }, validFrom: 'ch03', evidence: 'msg:2', confidence: 0.9 },
        { op: 'add_fact', fact: { id: 'f_orb', text: '林远持有混沌珠', visibility: 'secret' }, evidence: 'msg:10', confidence: 0.95 },
        { op: 'append_event', event: { time: 'ch05', place: '黑风寨', actors: ['lin_yuan', 'su_wan'], problem: '矿脉被劫', decision: '夜袭', result: '夺回', importance: 'major', sourceMessages: [41] } },
    ]);
    state = result.state;
    state.characters.su_wan = { id: 'su_wan', name: '苏婉', tier: 'minor', state: {}, items: [], relations: [], facts: [] };

    const text = assembleInjection(state, { tokenBudget: 3000, knowledgeGate: true, recentText: '苏婉看着林远' });
    assert.match(text, /林远/);
    assert.match(text, /炼气七层/);
    assert.match(text, /青锋剑/);
    assert.match(text, /事件台账/);
    assert.match(text, /秘密知情/);
    assert.match(text, /- 林远持有混沌珠 ｜ 主角级；只有你知道/);
});

test('parseExtractionResponse 支持代码围栏', () => {
    const data = parseExtractionResponse('```json\n{"scene":{"time":"ch01"},"ops":[],"leaks":[]}\n```');
    assert.equal(data.scene.time, 'ch01');
    assert.deepEqual(data.ops, []);
});

test('extractMentionedFacts 只返回被提到的秘密事实', () => {
    const state = createEmptyState();
    state.facts = {
        f_orb: { id: 'f_orb', text: '林远持有混沌珠', visibility: 'secret', knownBy: {} },
        f_public: { id: 'f_public', text: '宗门大比三日后举行', visibility: 'public', knownBy: {} },
    };
    const result = extractMentionedFacts(state, '苏婉忽然看向林远手里的混沌珠。');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'f_orb');
});

test('detectLeaks 标记档位不够却被提到的秘密', () => {
    const state = createEmptyState();
    state.facts = {
        f_orb: {
            id: 'f_orb',
            text: '林远持有混沌珠',
            access: 'protagonist',
        },
    };
    state.characters = {
        lin_yuan: { id: 'lin_yuan', name: '林远', tier: 'main' },
        su_wan: { id: 'su_wan', name: '苏婉', tier: 'major', access: 'public' },
    };
    const leaks = detectLeaks(state, '苏婉看着混沌珠说：你藏着什么？', ['lin_yuan', 'su_wan']);
    assert.equal(leaks.length, 1);
    assert.equal(leaks[0].character, 'su_wan');
    assert.equal(leaks[0].factText, '林远持有混沌珠');
});

test('主角秘密字段不进公开块，只进秘密知情', () => {
    let state = createEmptyState();
    state.scene = { time: 'ch12', participants: ['lin_yuan', 'su_wan'] };
    let result = run(state, [
        {
            op: 'set',
            character: 'lin_yuan',
            name: '林远',
            field: 'realm',
            value: '筑基一层',
            validFrom: 'ch12',
            evidence: 'msg:1',
            confidence: 0.9,
            access: 'protagonist',
        },
        {
            op: 'set',
            character: 'lin_yuan',
            field: 'location',
            value: '青云宗',
            validFrom: 'ch12',
            evidence: 'msg:1',
            confidence: 0.9,
        },
    ]);
    state = result.state;
    state.characters.lin_yuan.tier = 'main';
    state.characters.su_wan = { id: 'su_wan', name: '苏婉', tier: 'major', state: {}, items: [], relations: [], facts: [] };

    const text = assembleInjection(state, { tokenBudget: 3000, activeCharacterIds: ['lin_yuan', 'su_wan'] });
    const blockStart = text.indexOf('【角色·林远】');
    const blockEnd = text.indexOf('【秘密知情】');
    const publicBlock = text.slice(blockStart, blockEnd);

    assert.match(publicBlock, /location：青云宗/);
    assert.doesNotMatch(publicBlock, /realm：筑基一层/);
    assert.match(text, /- 林远\.realm：筑基一层 ｜ 主角级；只有你知道/);
});

test('物品与关系支持档位', () => {
    let state = createEmptyState();
    const result = run(state, [
        {
            op: 'add_item',
            character: 'lin_yuan',
            name: '林远',
            item: { id: 'i_orb', name: '混沌珠', access: 'intimate' },
            validFrom: 'ch05',
            evidence: 'msg:2',
            confidence: 0.9,
        },
        {
            op: 'set_relation',
            from: 'lin_yuan',
            to: 'su_wan',
            toName: '苏婉',
            type: '秘密同盟',
            attitude: '互信',
            access: 'intimate',
            validFrom: 'ch05',
            evidence: 'msg:3',
            confidence: 0.9,
        },
    ]);
    state = result.state;
    assert.equal(entityAccess(state.characters.lin_yuan.items[0]), 'intimate');
    assert.equal(entityAccess(state.characters.lin_yuan.relations[0]), 'intimate');
});

test('事件档位生成 [K:] 标签，档位不够的人不可引用', () => {
    let state = createEmptyState();
    state.scene = { time: 'ch05', participants: ['lin_yuan'] };
    state.characters.lin_yuan = { id: 'lin_yuan', name: '林远', tier: 'main', access: 'protagonist', state: {}, items: [], relations: [], facts: [] };
    state.characters.su_wan = { id: 'su_wan', name: '苏婉', tier: 'major', access: 'public', state: {}, items: [], relations: [], facts: [] };
    let result = run(state, [
        {
            op: 'append_event',
            event: {
                id: 'e0001',
                chapter: 'ch05',
                actors: ['lin_yuan'],
                witnesses: ['lin_yuan'],
                problem: '秘密行动',
                decision: '潜入',
                result: '成功',
                importance: 'major',
                access: 'friend',
                sourceMessages: [1],
            },
        },
    ]);
    state = result.state;

    const text = assembleInjection(state, { tokenBudget: 3000, activeCharacterIds: ['lin_yuan', 'su_wan'] });
    assert.match(text, /\[K:林远\]/);
    assert.doesNotMatch(text, /\[K:[^\]]*苏婉/);
    assert.doesNotMatch(text, /事件 e0001/);
});

test('reveal 支持字段/物品/关系/事件', () => {
    let state = createEmptyState();
    state.characters.lin_yuan = { id: 'lin_yuan', name: '林远', tier: 'main', access: 'protagonist', state: {}, items: [], relations: [], facts: [] };
    state.characters.su_wan = { id: 'su_wan', name: '苏婉', tier: 'major', access: 'public', state: {}, items: [], relations: [], facts: [] };
    let result = run(state, [
        {
            op: 'set',
            character: 'lin_yuan',
            name: '林远',
            field: 'realm',
            value: '筑基一层',
            validFrom: 'ch12',
            evidence: 'msg:1',
            confidence: 0.9,
            access: 'protagonist',
        },
        {
            op: 'add_item',
            character: 'lin_yuan',
            name: '林远',
            item: { id: 'i_orb', name: '混沌珠', access: 'protagonist' },
            validFrom: 'ch05',
            evidence: 'msg:2',
            confidence: 0.9,
        },
        {
            op: 'set_relation',
            from: 'lin_yuan',
            to: 'su_wan',
            toName: '苏婉',
            type: '秘密同盟',
            access: 'protagonist',
            validFrom: 'ch05',
            evidence: 'msg:3',
            confidence: 0.9,
        },
        {
            op: 'append_event',
            event: {
                id: 'e0001',
                actors: ['lin_yuan'],
                witnesses: ['lin_yuan'],
                problem: '秘密行动',
                decision: '潜入',
                result: '成功',
                importance: 'major',
                access: 'protagonist',
                sourceMessages: [1],
            },
        },
    ]);
    state = result.state;

    result = run(state, [
        { op: 'set_tier', character: 'su_wan', access: 'friend', reason: '同门名分', evidence: 'msg:4', confidence: 0.95 },
        { op: 'reveal', to: 'su_wan', by: 'lin_yuan', method: '战斗中暴露', character: 'lin_yuan', field: 'realm', validFrom: 'ch13', evidence: 'msg:4', confidence: 0.95 },
        { op: 'reveal', to: 'su_wan', by: 'lin_yuan', method: '被看见', item: 'i_orb', validFrom: 'ch13', evidence: 'msg:5', confidence: 0.95 },
        { op: 'reveal', to: 'su_wan', by: 'lin_yuan', method: '被迫承认', relation: 'su_wan', validFrom: 'ch13', evidence: 'msg:6', confidence: 0.95 },
        { op: 'reveal', to: 'su_wan', by: 'lin_yuan', method: '得知', event: 'e0001', validFrom: 'ch13', evidence: 'msg:7', confidence: 0.95 },
    ]);
    state = result.state;

    const targets = [
        state.characters.lin_yuan.state.realm,
        state.characters.lin_yuan.items[0],
        state.characters.lin_yuan.relations[0],
        state.events.find((event) => event.id === 'e0001'),
    ];
    for (const target of targets) {
        assert.equal(entityAccess(target), 'friend');
        assert.equal(knowsEntity(target, 'su_wan', state), true);
    }
});

test('物品数量与货币：add_item 合并、adjust_item 增减并记录历史', () => {
    let state = createEmptyState();
    let result = run(state, [
        { op: 'add_item', character: 'lin_yuan', name: '林远', item: { id: 'i_spirit', name: '灵石', kind: 'currency', quantity: 100, unit: '枚' }, validFrom: 'ch01', evidence: 'msg:1', confidence: 0.9 },
        { op: 'add_item', character: 'lin_yuan', name: '林远', item: { id: 'i_spirit', name: '灵石', kind: 'currency', quantity: 50, unit: '枚' }, validFrom: 'ch02', evidence: 'msg:2', confidence: 0.9 },
    ]);
    state = result.state;
    const item = state.characters.lin_yuan.items.find((entry) => entry.id === 'i_spirit' && entry.validTo == null);
    assert.equal(item.quantity, 150);
    assert.equal(item.unit, '枚');
    assert.equal(item.kind, 'currency');

    result = run(state, [
        { op: 'adjust_item', item: 'i_spirit', delta: -30, reason: '购买回气丹', validFrom: 'ch03', evidence: 'msg:3', confidence: 0.9 },
    ]);
    state = result.state;
    const after = state.characters.lin_yuan.items.find((entry) => entry.id === 'i_spirit' && entry.validTo == null);
    assert.equal(after.quantity, 120);
    assert.equal(after.quantityHistory.length, 1);
    assert.equal(after.quantityHistory[0].delta, -30);
    assert.equal(after.quantityHistory[0].after, 120);
});

test('adjust_item 可为指定角色创建货币物品', () => {
    const state = createEmptyState();
    const result = run(state, [
        {
            op: 'adjust_item',
            character: 'wang_shop',
            characterName: '王掌柜',
            item: 'i_spirit',
            itemName: '灵石',
            unit: '枚',
            kind: 'currency',
            delta: 30,
            reason: '收到货款',
            validFrom: 'ch03',
            evidence: 'msg:4',
            confidence: 0.9,
        },
    ]);
    const item = result.state.characters.wang_shop.items.find((entry) => entry.id === 'i_spirit' && entry.validTo == null);
    assert.equal(item.quantity, 30);
    assert.equal(item.kind, 'currency');
    assert.equal(item.holder, 'wang_shop');
});

test('normalizeState 为旧物品补默认数量', () => {
    const state = normalizeState({
        characters: { a: { items: [{ id: 'i1', name: '旧物', validTo: null }] } },
        events: [],
    });
    assert.equal(state.characters.a.items[0].quantity, 1);
    assert.equal(state.characters.a.items[0].unit, '');
    assert.equal(state.characters.a.items[0].kind, 'item');
});

test('assembleInjection 渲染物品数量', () => {
    let state = createEmptyState();
    let result = run(state, [
        { op: 'add_item', character: 'lin_yuan', name: '林远', item: { id: 'i_spirit', name: '灵石', kind: 'currency', quantity: 120, unit: '枚' }, validFrom: 'ch01', evidence: 'msg:1', confidence: 0.9 },
        { op: 'add_item', character: 'lin_yuan', name: '林远', item: { id: 'i_pill', name: '回气丹', kind: 'consumable', quantity: 3, unit: '颗' }, validFrom: 'ch01', evidence: 'msg:2', confidence: 0.9 },
    ]);
    state = result.state;
    state.characters.lin_yuan.tier = 'main';
    state.scene = { time: 'ch01', place: '', participants: ['lin_yuan'] };
    const text = assembleInjection(state, { tokenBudget: 3000, activeCharacterIds: ['lin_yuan'] });
    assert.match(text, /灵石×120枚/);
    assert.match(text, /回气丹×3颗/);
});

test('move_item 保留数量与单位', () => {
    let state = createEmptyState();
    let result = run(state, [
        { op: 'add_item', character: 'lin_yuan', name: '林远', item: { id: 'i_pill', name: '回气丹', kind: 'consumable', quantity: 3, unit: '颗' }, validFrom: 'ch01', evidence: 'msg:1', confidence: 0.9 },
    ]);
    state = result.state;
    result = run(state, [
        { op: 'move_item', item: 'i_pill', to: 'su_wan', toName: '苏婉', validFrom: 'ch02', evidence: 'msg:2', confidence: 0.9 },
    ]);
    state = result.state;
    const moved = state.characters.su_wan.items.find((entry) => entry.id === 'i_pill' && entry.validTo == null);
    assert.equal(moved.quantity, 3);
    assert.equal(moved.unit, '颗');
});

test('remove_item / clear_items / clear_currency / set_item_quantity', () => {
    let state = createEmptyState();
    let result = run(state, [
        { op: 'add_item', character: 'lin_yuan', name: '林远', item: { id: 'i_sword', name: '青锋剑', kind: 'equipment', quantity: 1 }, validFrom: 'ch01', evidence: 'msg:1', confidence: 0.9 },
        { op: 'add_item', character: 'lin_yuan', name: '林远', item: { id: 'i_pill', name: '回气丹', kind: 'consumable', quantity: 3, unit: '颗' }, validFrom: 'ch01', evidence: 'msg:2', confidence: 0.9 },
        { op: 'add_item', character: 'lin_yuan', name: '林远', item: { id: 'i_spirit', name: '灵石', kind: 'currency', quantity: 100, unit: '枚' }, validFrom: 'ch01', evidence: 'msg:3', confidence: 0.9 },
    ]);
    state = result.state;

    result = run(state, [
        { op: 'remove_item', item: 'i_sword', reason: '被夺走', validFrom: 'ch02', evidence: 'msg:4', confidence: 0.9 },
    ]);
    state = result.state;
    const removedSword = state.characters.lin_yuan.items.find((entry) => entry.id === 'i_sword');
    assert.ok(removedSword.validTo);
    assert.equal(removedSword.removedReason, '被夺走');

    result = run(state, [
        { op: 'clear_items', character: 'lin_yuan', reason: '被洗劫', validFrom: 'ch03', evidence: 'msg:5', confidence: 0.9 },
    ]);
    state = result.state;
    assert.ok(state.characters.lin_yuan.items.find((entry) => entry.id === 'i_pill').validTo);
    const currencyAfterItems = state.characters.lin_yuan.items.find((entry) => entry.id === 'i_spirit' && entry.validTo == null);
    assert.equal(currencyAfterItems.quantity, 100);

    result = run(state, [
        { op: 'clear_currency', character: 'lin_yuan', reason: '灵石被抢', validFrom: 'ch04', evidence: 'msg:6', confidence: 0.9 },
    ]);
    state = result.state;
    const cleared = state.characters.lin_yuan.items.find((entry) => entry.id === 'i_spirit' && entry.validTo == null);
    assert.equal(cleared.quantity, 0);
    assert.equal(cleared.quantityHistory.length, 1);

    result = run(state, [
        { op: 'set_item_quantity', item: 'i_spirit', quantity: 7, reason: '重新获得', validFrom: 'ch05', evidence: 'msg:7', confidence: 0.9 },
    ]);
    state = result.state;
    const set = state.characters.lin_yuan.items.find((entry) => entry.id === 'i_spirit' && entry.validTo == null);
    assert.equal(set.quantity, 7);
    assert.equal(set.quantityHistory.length, 2);
});

test('注入只为故事主角显示物品，NPC 物品不进入公开块', () => {
    let state = createEmptyState();
    let result = run(state, [
        { op: 'add_item', character: 'lin_yuan', name: '林远', item: { id: 'i_sword', name: '青锋剑' }, validFrom: 'ch01', evidence: 'msg:1', confidence: 0.9 },
        { op: 'add_item', character: 'su_wan', name: '苏婉', item: { id: 'i_dagger', name: '毒匕首' }, validFrom: 'ch01', evidence: 'msg:2', confidence: 0.9 },
    ]);
    state = result.state;
    state.characters.lin_yuan.tier = 'main';
    state.characters.su_wan.tier = 'major';
    state.scene = { time: '夜', place: '客栈', participants: ['lin_yuan', 'su_wan'] };

    const text = assembleInjection(state, {
        tokenBudget: 3000,
        activeCharacterIds: ['lin_yuan', 'su_wan'],
        protagonistId: 'lin_yuan',
    });
    assert.match(text, /青锋剑/);
    assert.doesNotMatch(text, /毒匕首/);
});

test('多技能：add_skill / set_skill / remove_skill', () => {
    let state = createEmptyState();
    let result = run(state, [
        { op: 'add_skill', character: 'lin_yuan', characterName: '林远', skill: { id: 'sk_qingmu', name: '青木诀', type: 'technique', level: '第三重' }, validFrom: '第一日 晨', evidence: 'msg:1', confidence: 0.9 },
        { op: 'add_skill', character: 'lin_yuan', skill: { id: 'sk_sword', name: '御剑术', type: 'skill', level: '入门' }, validFrom: '第三日 夜', evidence: 'msg:2', confidence: 0.9 },
    ]);
    state = result.state;
    assert.equal(state.characters.lin_yuan.skills.length, 2);

    result = run(state, [
        { op: 'set_skill', character: 'lin_yuan', skill: 'sk_qingmu', level: '第四重', validFrom: '第四日 晨', evidence: 'msg:3', confidence: 0.9 },
    ]);
    state = result.state;
    const qingmu = state.characters.lin_yuan.skills.find((skill) => skill.id === 'sk_qingmu' && skill.validTo == null);
    assert.equal(qingmu.level, '第四重');
    assert.equal(qingmu.history.length, 1);

    result = run(state, [
        { op: 'remove_skill', skill: 'sk_sword', reason: '被废', validFrom: '第五日 夜', evidence: 'msg:4', confidence: 0.9 },
    ]);
    state = result.state;
    const sword = state.characters.lin_yuan.skills.find((skill) => skill.id === 'sk_sword');
    assert.ok(sword.validTo);
});

test('assembleInjection 显示多条技能', () => {
    let state = createEmptyState();
    let result = run(state, [
        { op: 'add_skill', character: 'lin_yuan', characterName: '林远', skill: { id: 'sk_a', name: '青木诀', type: 'technique', level: '第三重' }, validFrom: '第一日 晨', evidence: 'msg:1', confidence: 0.9 },
        { op: 'add_skill', character: 'lin_yuan', skill: { id: 'sk_b', name: '御剑术', type: 'skill', level: '入门' }, validFrom: '第一日 晨', evidence: 'msg:2', confidence: 0.9 },
    ]);
    state = result.state;
    state.characters.lin_yuan.tier = 'main';
    state.scene = { time: '夜', place: '客栈', participants: ['lin_yuan'] };
    const text = assembleInjection(state, {
        tokenBudget: 3000,
        activeCharacterIds: ['lin_yuan'],
        protagonistId: 'lin_yuan',
        skillLabel: '功法',
    });
    assert.match(text, /功法：青木诀\(第三重\)、御剑术\(入门\)/);
});

test('多神通：add_ability / set_ability / remove_ability', () => {
    let state = createEmptyState();
    let result = run(state, [
        { op: 'add_ability', character: 'lin_yuan', characterName: '林远', ability: { id: 'ab_feng', name: '御风诀', level: '入门' }, validFrom: '第一日 晨', evidence: 'msg:1', confidence: 0.9 },
        { op: 'add_ability', character: 'lin_yuan', ability: { id: 'ab_jian', name: '裂空剑', level: '小成' }, validFrom: '第二日 晨', evidence: 'msg:2', confidence: 0.9 },
    ]);
    state = result.state;
    assert.equal(state.characters.lin_yuan.abilities.length, 2);
    assert.equal(state.characters.lin_yuan.skills.length, 0);

    result = run(state, [
        { op: 'set_ability', character: 'lin_yuan', ability: 'ab_feng', level: '小成', validFrom: '第三日 晨', evidence: 'msg:3', confidence: 0.9 },
    ]);
    state = result.state;
    const wind = state.characters.lin_yuan.abilities.find((ability) => ability.id === 'ab_feng' && ability.validTo == null);
    assert.equal(wind.level, '小成');
    assert.equal(wind.history.length, 1);

    result = run(state, [
        { op: 'remove_ability', ability: 'ab_jian', reason: '被废', validFrom: '第四日 夜', evidence: 'msg:4', confidence: 0.9 },
    ]);
    state = result.state;
    assert.ok(state.characters.lin_yuan.abilities.find((ability) => ability.id === 'ab_jian').validTo);
});

test('assembleInjection 把功法与神通分开显示', () => {
    let state = createEmptyState();
    const result = run(state, [
        { op: 'add_skill', character: 'lin_yuan', characterName: '林远', skill: { id: 'sk_a', name: '青木诀', level: '第三重' }, validFrom: '第一日 晨', evidence: 'msg:1', confidence: 0.9 },
        { op: 'add_ability', character: 'lin_yuan', ability: { id: 'ab_a', name: '御风诀', level: '入门' }, validFrom: '第一日 晨', evidence: 'msg:2', confidence: 0.9 },
    ]);
    state = result.state;
    state.characters.lin_yuan.tier = 'main';
    state.scene = { time: '夜', place: '客栈', participants: ['lin_yuan'] };
    const text = assembleInjection(state, {
        tokenBudget: 3000,
        activeCharacterIds: ['lin_yuan'],
        protagonistId: 'lin_yuan',
        skillLabel: '功法',
    });
    assert.match(text, /功法：青木诀\(第三重\)/);
    assert.match(text, /神通：御风诀\(入门\)/);
});

test('修仙预设包含外貌体型与神通说明', () => {
    const preset = getGenrePreset('xianxia');
    assert.equal(preset.fieldLabels.appearance, '外貌体型');
    assert.match(preset.hint, /add_ability/);
    assert.match(preset.hint, /身材魁梧/);
});

test('秘密神通与其他秘密一样隔离注入', () => {
    let state = createEmptyState();
    const result = run(state, [
        { op: 'add_ability', character: 'lin_yuan', characterName: '林远', ability: { id: 'ab_feng', name: '御风诀', level: '入门', access: 'protagonist' }, validFrom: '第一日 晨', evidence: 'msg:1', confidence: 0.9 },
        { op: 'add_ability', character: 'lin_yuan', ability: { id: 'ab_jian', name: '裂空剑', level: '小成' }, validFrom: '第一日 晨', evidence: 'msg:2', confidence: 0.9 },
    ]);
    state = result.state;
    state.characters.lin_yuan.tier = 'main';
    state.characters.su_wan = {
        id: 'su_wan', name: '苏婉', tier: 'npc', access: 'public',
        state: {}, items: [], relations: [], facts: [], skills: [], abilities: [],
    };
    state.scene = { time: '夜', day: 3, place: '客栈', participants: ['lin_yuan', 'su_wan'] };
    const secret = state.characters.lin_yuan.abilities.find((entry) => entry.id === 'ab_feng');
    assert.equal(entityAccess(secret), 'protagonist');

    const text = assembleInjection(state, {
        tokenBudget: 3000,
        activeCharacterIds: ['lin_yuan', 'su_wan'],
        protagonistId: 'lin_yuan',
        skillLabel: '功法',
    });
    assert.match(text, /神通：裂空剑\(小成\)/);
    assert.doesNotMatch(text, /神通：.*御风诀/);
    assert.match(text, /神通「御风诀」/);
    assert.match(text, /主角级；只有你知道/);
});

test('秘密功法可以用 set_skill 改档，并用 reveal 放宽', () => {
    let state = createEmptyState();
    state = run(state, [
        { op: 'add_skill', character: 'lin_yuan', characterName: '林远', skill: { id: 'sk_sword', name: '御剑术', level: '入门' }, validFrom: '第一日 晨', evidence: 'msg:1', confidence: 0.9 },
        { op: 'set_skill', skill: 'sk_sword', access: 'protagonist', validFrom: '第二日 晨', evidence: 'msg:2', confidence: 0.9 },
    ]).state;
    state.characters.lin_yuan.tier = 'main';
    state.characters.su_wan = {
        id: 'su_wan', name: '苏婉', tier: 'npc', access: 'friend',
        state: {}, items: [], relations: [], facts: [], skills: [], abilities: [],
    };
    state = run(state, [
        { op: 'reveal', skill: 'sk_sword', to: 'su_wan', by: 'lin_yuan', method: '当面运功', validFrom: '第三日 晨', evidence: 'msg:3', confidence: 0.9 },
    ]).state;
    const skill = state.characters.lin_yuan.skills.find((entry) => entry.id === 'sk_sword');
    assert.equal(entityAccess(skill), 'friend');
    assert.equal(knowsEntity(skill, 'su_wan', state), true);
});

test('事件 [K:] 只列档位够格或目击的人', () => {
    const state = createEmptyState();
    state.characters.lin_yuan = { id: 'lin_yuan', name: '林远', tier: 'main', state: {}, items: [], relations: [], facts: [], skills: [], abilities: [] };
    state.characters.su_wan = { id: 'su_wan', name: '苏婉', tier: 'npc', access: 'friend', state: {}, items: [], relations: [], facts: [], skills: [], abilities: [] };
    state.characters.wang_shi = { id: 'wang_shi', name: '王掌柜', tier: 'npc', access: 'public', state: {}, items: [], relations: [], facts: [], skills: [], abilities: [] };
    state.characters.zhao = { id: 'zhao', name: '赵长老', tier: 'npc', access: 'public', state: {}, items: [], relations: [], facts: [], skills: [], abilities: [] };
    state.scene = { time: '夜', place: '客栈', participants: ['lin_yuan', 'su_wan'] };
    const result = run(state, [{
        op: 'append_event',
        event: {
            time: '夜',
            place: '客栈',
            actors: ['lin_yuan', 'su_wan'],
            problem: '试探来历',
            decision: '出手',
            result: '惊动旁人',
            stateChanges: ['realm'],
            witnesses: ['su_wan'],
            access: 'friend',
            beliefs: { wang_shi: { state: 'suspects', suspicion: '有隐情' } },
            sourceMessages: [5],
        },
        validFrom: '夜',
        evidence: 'msg:5',
        confidence: 0.9,
    }]);
    const text = assembleInjection(result.state, {
        tokenBudget: 4000,
        activeCharacterIds: ['lin_yuan', 'su_wan', 'wang_shi', 'zhao'],
        protagonistId: 'lin_yuan',
    });
    assert.match(text, /\[K:[^\]]*苏婉/);
    assert.doesNotMatch(text, /\[K:[^\]]*王掌柜/);
    assert.doesNotMatch(text, /\[K:[^\]]*赵长老/);
});

test('add_fact 改文本时保留档位，误信单独记录', () => {
    let state = createEmptyState();
    state.characters.lin_yuan = { id: 'lin_yuan', name: '林远', tier: 'main', state: {}, items: [], relations: [], facts: [], skills: [], abilities: [] };
    state = run(state, [{
        op: 'add_fact',
        fact: { id: 'f_seal', text: '你怀有混沌珠', access: 'protagonist' },
        validFrom: '第一日',
        evidence: 'msg:1',
        confidence: 0.9,
    }]).state;
    state = run(state, [{
        op: 'add_fact',
        fact: {
            id: 'f_seal',
            text: '你怀有混沌珠，且已认主',
            beliefs: { wang_shi: { state: 'suspects', suspicion: '有隐情' } },
        },
        validFrom: '第二日',
        evidence: 'msg:2',
        confidence: 0.9,
    }]).state;
    const fact = state.facts.f_seal;
    assert.equal(fact.text, '你怀有混沌珠，且已认主');
    assert.equal(entityAccess(fact), 'protagonist');
    assert.equal(fact.beliefs.wang_shi.state, 'suspects');
});

test('重记秘密功法保档位，物品转手跟着持有人放宽', () => {
    let state = createEmptyState();
    state.characters.lin_yuan = { id: 'lin_yuan', name: '林远', tier: 'main', state: {}, items: [], relations: [], facts: [], skills: [], abilities: [] };
    state.characters.su_wan = { id: 'su_wan', name: '苏婉', tier: 'npc', access: 'friend', state: {}, items: [], relations: [], facts: [], skills: [], abilities: [] };
    state.characters.wang_shi = { id: 'wang_shi', name: '王掌柜', tier: 'npc', access: 'intimate', state: {}, items: [], relations: [], facts: [], skills: [], abilities: [] };
    state = run(state, [
        { op: 'add_skill', character: 'lin_yuan', characterName: '林远', skill: { id: 'sk_hidden', name: '噬灵诀', access: 'protagonist' }, validFrom: '第一日', evidence: 'msg:1', confidence: 0.9 },
        { op: 'add_item', character: 'lin_yuan', item: { id: 'i_jade', name: '缺角玉牌', access: 'protagonist' }, validFrom: '第一日', evidence: 'msg:2', confidence: 0.9 },
    ]).state;
    state = run(state, [
        { op: 'add_skill', character: 'lin_yuan', skill: { id: 'sk_hidden', name: '噬灵诀', level: '第二重' }, validFrom: '第二日', evidence: 'msg:3', confidence: 0.9 },
        { op: 'set_skill', skill: 'sk_hidden', access: 'intimate', validFrom: '第二日', evidence: 'msg:3', confidence: 0.9 },
        { op: 'move_item', item: 'i_jade', to: 'su_wan', validFrom: '第二日', evidence: 'msg:4', confidence: 0.9 },
    ]).state;

    const skill = state.characters.lin_yuan.skills.find((entry) => entry.id === 'sk_hidden' && entry.validTo == null);
    assert.equal(entityAccess(skill), 'intimate');
    assert.equal(knowsEntity(skill, 'wang_shi', state), true);
    assert.equal(knowsEntity(skill, 'su_wan', state), false);

    const item = state.characters.su_wan.items.find((entry) => entry.id === 'i_jade' && entry.validTo == null);
    // 物品到了苏婉（朋友级）手里，档位跟着放宽到朋友级。
    assert.equal(entityAccess(item), 'friend');
    assert.equal(knowsEntity(item, 'su_wan', state), true);
});

test('NPC 自身字段一律公开注入，主角仍可见真相', () => {
    const state = createEmptyState();
    state.characters.lin_yuan = {
        id: 'lin_yuan', name: '林远', tier: 'main', state: {}, items: [], skills: [], relations: [], facts: [],
    };
    state.characters.wang = {
        id: 'wang',
        name: '王掌柜',
        tier: 'major',
        state: {
            realm: {
                current: '筑基九层',
                access: 'public',
                history: [],
            },
            gender: { current: '男', history: [] },
        },
        items: [], skills: [], relations: [], facts: [],
    };
    state.scene = { time: '夜', place: '客栈', participants: ['lin_yuan', 'wang'] };

    const text = assembleInjection(state, {
        tokenBudget: 3000,
        activeCharacterIds: ['lin_yuan', 'wang'],
        protagonistId: 'lin_yuan',
    });
    assert.match(text, /【角色·王掌柜】/);
    assert.match(text, /realm：筑基九层/);
    assert.match(text, /gender：男/);
    // 不再对 NPC 自身信息做「未知/真相」处理
    assert.doesNotMatch(text, /未知/);
    assert.doesNotMatch(text, /【真相/);
});

test('NPC 对主角秘密的错误认知渲染在秘密知情里，真相仍属于主角', () => {
    const state = createEmptyState();
    state.characters.lin_yuan = {
        id: 'lin_yuan',
        name: '林远',
        tier: 'main',
        state: {
            realm: {
                current: '筑基九层',
                access: 'protagonist',
                beliefs: {
                    wang: { state: 'false_belief', belief: '凡人' },
                },
                history: [],
            },
        },
        items: [],
        skills: [],
        relations: [],
        facts: [],
    };
    state.characters.wang = {
        id: 'wang', name: '王掌柜', tier: 'major', state: {}, items: [], skills: [], relations: [], facts: [],
    };
    state.scene = { time: '夜', place: '客栈', participants: ['lin_yuan', 'wang'] };

    const text = assembleInjection(state, {
        tokenBudget: 3000,
        activeCharacterIds: ['lin_yuan', 'wang'],
        protagonistId: 'lin_yuan',
    });
    const blockStart = text.indexOf('【角色·林远】');
    const blockEnd = text.indexOf('【秘密知情】');
    const protagonistBlock = text.slice(blockStart, blockEnd);

    // 真相在秘密知情里；NPC 的错误认知同一条内渲染
    assert.match(text, /主角级；只有你知道；王掌柜误以为「凡人」/);
    assert.doesNotMatch(protagonistBlock, /凡人/);
});

test('默认题材预设为修仙且包含字段顺序', () => {
    const preset = getGenrePreset(DEFAULT_GENRE);
    assert.equal(DEFAULT_GENRE, 'xianxia');
    assert.match(preset.hint, /修仙/);
    assert.ok(preset.fieldOrder.includes('realm'));
});

test('assembleInjection 动态渲染自定义字段', () => {
    const state = createEmptyState();
    state.characters.lin_yuan = {
        id: 'lin_yuan',
        name: '林远',
        tier: 'main',
        state: {
            rank: { current: '科长', history: [] },
            wealth: { current: '富有', history: [] },
            realm: { current: '炼气七层', history: [] },
        },
        items: [],
        relations: [],
        facts: [],
    };
    state.scene = { time: 'ch01', place: '', participants: ['lin_yuan'] };
    const text = assembleInjection(state, { tokenBudget: 3000, fieldOrder: ['rank', 'wealth', 'realm'] });
    assert.match(text, /rank：科长/);
    assert.match(text, /wealth：富有/);
    assert.match(text, /realm：炼气七层/);
});

test('buildExtractionPrompt 包含题材与字段提示', () => {
    const state = createEmptyState();
    const { user } = buildExtractionPrompt(state, [], { genreHint: '题材：都市。state 常用字段：rank。' });
    assert.match(user, /题材：都市/);
    assert.match(user, /rank/);
});

test('buildExtractionPrompt 包含台账、对话与输出规则', () => {
    const state = createEmptyState();
    const { system, user } = buildExtractionPrompt(state, [{ isUser: false, name: 'AI', mes: '她走进酒吧。' }]);
    assert.match(system, /只输出 JSON/);
    assert.match(user, /当前台账/);
    assert.match(user, /最近对话/);
    assert.match(user, /append_event/);
});

test('healthCheck 标记缺 sourceMessages 的事件', () => {
    const state = createEmptyState();
    state.events.push({ id: 'e0001', problem: 'x', result: 'y', sourceMessages: [] });
    const issues = healthCheck(state, { tokenBudget: 3000 });
    assert.ok(issues.some((issue) => issue.includes('缺少 sourceMessages')));
});

test('estimateTokens 对中文返回正数', () => {
    assert.ok(estimateTokens('林远持有混沌珠') >= 6);
});

test('set_scene 为在场角色自动建立记录', () => {
    const state = createEmptyState();
    run(state, [
        {
            op: 'set_scene',
            scene: { time: '夜', place: '客栈', participants: ['林远', '苏婉', '王掌柜'] },
            evidence: 'msg:0',
            confidence: 0.9,
        },
    ]);
    assert.ok(findCharacter(state, '林远'));
    assert.ok(findCharacter(state, '苏婉'));
    assert.ok(findCharacter(state, '王掌柜'));
    // 只有名字，字段留空，由状态栏显示「未知」
    assert.deepEqual(findCharacter(state, '苏婉').state, {});
});

test('gender 只保留 男/女/未知', () => {
    const state = createEmptyState();
    run(state, [
        { op: 'set', character: '甲', field: 'gender', value: '姑娘', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: '乙', field: 'gender', value: '男', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: '丙', field: 'gender', value: '苏掌柜', evidence: 'msg:0', confidence: 0.9 },
    ]);
    assert.equal(findCharacter(state, '甲').state.gender.current, '女');
    assert.equal(findCharacter(state, '乙').state.gender.current, '男');
    assert.equal(findCharacter(state, '丙').state.gender.current, '未知');
});

test('parseExtractionResponse 保留 protagonist', () => {
    const parsed = parseExtractionResponse('{"protagonist":"林远","scene":{},"ops":[],"leaks":[]}');
    assert.equal(parsed.protagonist, '林远');
});

test('assembleInjection 限制其他角色条数', () => {
    const state = createEmptyState();
    for (let i = 0; i < 12; i += 1) {
        run(state, [
            { op: 'set', character: `角色${i}`, field: 'gender', value: '男', evidence: 'msg:0', confidence: 0.9 },
        ]);
    }
    state.scene = { time: '夜', place: '客栈', participants: ['角色0'] };
    const text = assembleInjection(state, {
        tokenBudget: 3000,
        knowledgeGate: true,
        recentText: '',
        fieldOrder: getGenrePreset('xianxia').fieldOrder,
        protagonistId: '角色0',
    });
    assert.match(text, /其余 3 人未列出/);
});

test('纯称呼不能作为角色名', () => {
    const state = createEmptyState();
    const result = validateOps([
        { op: 'set', character: '父亲', field: 'realm', value: '金丹', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: '赵长老', field: 'realm', value: '金丹', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set_relation', from: '林远', to: '前辈', type: '师徒', evidence: 'msg:1', confidence: 0.9 },
    ], state, { confidenceThreshold: 0.7, reviewThreshold: 0.5, messageCount: 3 });

    assert.equal(result.rejected.length, 2);
    assert.ok(result.accepted.some((op) => op.character === '赵长老'));
    assert.equal(state.characters['父亲'], undefined);
});

test('玩家角色归一化为 user（你/我/玩家/主角/persona）', () => {
    const state = createEmptyState();
    const result = run(state, [
        { op: 'set', character: '我', field: 'realm', value: '筑基一层', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set_relation', from: '苏婉', to: '你', type: '同门', evidence: 'msg:1', confidence: 0.9 },
        { op: 'set', character: 'Player', field: 'gender', value: '男', evidence: 'msg:2', confidence: 0.9 },
    ], { protagonistAliases: ['Player'] });

    assert.ok(result.state.characters.user);
    assert.equal(result.state.characters.user.name, '你');
    assert.equal(result.state.characters.user.tier, 'main');
    assert.equal(findCharacter(result.state, '苏婉').relations[0].target, 'user');
    assert.equal(result.state.characters['我'], undefined);
    assert.equal(result.state.characters['你'], undefined);
    assert.equal(result.state.characters['Player'], undefined);
});

test('主角占位符在注入里显示为「你」', () => {
    let state = createEmptyState();
    const result = run(state, [
        { op: 'set', character: 'user', field: 'realm', value: '筑基一层', evidence: 'msg:0', confidence: 0.9 },
    ]);
    state = result.state;
    state.scene = { time: '夜', place: '客栈', participants: ['user', '苏婉'] };
    const text = assembleInjection(state, {
        tokenBudget: 3000,
        activeCharacterIds: ['user', '苏婉'],
        protagonistId: 'user',
    });
    assert.match(text, /【角色·你】/);
    assert.match(text, /realm：筑基一层/);
});

test('set_relation 把称呼记在关系上，不进主角别名', () => {
    const result = run(createEmptyState(), [
        { op: 'set_relation', from: '苏婉', to: 'user', type: '同门', attitude: '亲近', address: '师兄', evidence: 'msg:1', confidence: 0.9 },
    ]);
    const relation = findCharacter(result.state, '苏婉').relations[0];
    assert.equal(relation.address, '师兄');
    assert.equal(relation.target, 'user');
    assert.equal(relation.targetName, '你');
    assert.deepEqual(result.state.characters.user.aliases, []);
});

test('只改称呼时原地更新关系，不新增版本', () => {
    let state = run(createEmptyState(), [
        { op: 'set_relation', from: '苏婉', to: 'user', type: '同门', attitude: '亲近', address: '师兄', evidence: 'msg:1', confidence: 0.9 },
    ]).state;
    state = run(state, [
        { op: 'set_relation', from: '苏婉', to: 'user', type: '同门', address: '道友', evidence: 'msg:9', confidence: 0.9 },
    ]).state;

    const relations = findCharacter(state, '苏婉').relations;
    assert.equal(relations.length, 1);
    assert.equal(relations[0].address, '道友');
    assert.equal(relations[0].attitude, '亲近');
    assert.equal(relations[0].validTo, null);
});

test('态度变化保留关系历史并继承称呼', () => {
    let state = run(createEmptyState(), [
        { op: 'set_relation', from: 'user', to: '苏婉', type: '同门', attitude: '试探', address: '师妹', evidence: 'msg:1', confidence: 0.9 },
    ]).state;
    state = run(state, [
        { op: 'set_relation', from: 'user', to: '苏婉', type: '同门', attitude: '信任', evidence: 'msg:20', confidence: 0.9 },
    ]).state;

    const relations = state.characters.user.relations;
    assert.equal(relations.length, 2);
    assert.notEqual(relations[0].validTo, null);
    assert.equal(relations[1].attitude, '信任');
    assert.equal(relations[1].address, '师妹');
});

test('assembleInjection 渲染关系称呼', () => {
    let state = run(createEmptyState(), [
        { op: 'set_relation', from: 'user', to: '苏婉', type: '同门', attitude: '亲近', address: '师妹', evidence: 'msg:1', confidence: 0.9 },
    ]).state;
    state.scene = { time: '夜', place: '客栈', participants: ['user', '苏婉'] };
    const text = assembleInjection(state, {
        tokenBudget: 3000,
        activeCharacterIds: ['user', '苏婉'],
        protagonistId: 'user',
    });
    assert.match(text, /苏婉\(同门\/亲近，称「师妹」\)/);
});

test('未了结的线索单独注入，了结后消失', () => {
    let state = run(createEmptyState(), [
        { op: 'set', character: 'user', field: 'gender', value: '未知', evidence: 'msg:0', confidence: 0.9 },
        {
            op: 'add_fact',
            fact: {
                id: 'f_debt',
                text: '你欠柳三娘一块灵石',
                visibility: 'public',
                thread_status: 'open',
                thread_type: '人情',
                thread_stake: '她会记恨',
            },
            evidence: 'msg:0',
            confidence: 0.9,
        },
    ]).state;
    state.scene = { time: '夜', place: '客栈', participants: ['user'] };
    let text = assembleInjection(state, { activeCharacterIds: ['user'], protagonistId: 'user' });
    assert.match(text, /【未了结】/);
    assert.match(text, /你欠柳三娘一块灵石｜人情｜代价：她会记恨/);

    state = run(state, [
        {
            op: 'add_fact',
            fact: { id: 'f_debt', text: '你欠柳三娘一块灵石', visibility: 'public', thread_status: 'closed' },
            evidence: 'msg:1',
            confidence: 0.9,
        },
    ]).state;
    text = assembleInjection(state, { activeCharacterIds: ['user'], protagonistId: 'user' });
    assert.doesNotMatch(text, /【未了结】/);
});

test('注入头部声明在场不等于知情', () => {
    const state = createEmptyState();
    const text = assembleInjection(state, { protagonistId: 'user' });
    assert.match(text, /在场、看到、正文没提他不知道，都不等于他知道/);
});

test('suspects 渲染具体怀疑内容', () => {
    let state = run(createEmptyState(), [
        { op: 'set', character: 'user', field: 'gender', value: '未知', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: '顾行舟', field: 'gender', value: '男', evidence: 'msg:0', confidence: 0.9 },
        {
            op: 'add_fact',
            fact: {
                id: 'f_gongfa',
                text: '你在暗中修炼噬灵诀',
                access: 'protagonist',
                beliefs: { 顾行舟: { state: 'suspects', suspicion: '你在偷练魔功' } },
            },
            evidence: 'msg:0',
            confidence: 0.9,
        },
    ]).state;
    state.scene = { time: '夜', place: '客栈', participants: ['user', '顾行舟'] };
    const text = assembleInjection(state, {
        activeCharacterIds: ['user', '顾行舟'],
        protagonistId: 'user',
    });
    assert.match(text, /顾行舟怀疑「你在偷练魔功」/);
});

test('秘密线索在【未了结】里带知情标记，不再重复进秘密块', () => {
    let state = run(createEmptyState(), [
        { op: 'set', character: 'user', field: 'gender', value: '未知', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: '柳三娘', field: 'gender', value: '女', evidence: 'msg:0', confidence: 0.9 },
        {
            op: 'add_fact',
            fact: {
                id: 'f_secret_thread',
                text: '你答应替柳三娘保守九幽兰的来历',
                access: 'friend',
                thread_status: 'open',
                thread_type: '承诺',
            },
            evidence: 'msg:0',
            confidence: 0.9,
        },
    ]).state;
    findCharacter(state, '柳三娘').access = 'friend';
    state.scene = { time: '夜', place: '客栈', participants: ['user', '苏婉'] };
    const text = assembleInjection(state, { activeCharacterIds: ['user', '苏婉'], protagonistId: 'user' });
    assert.match(text, /【未了结】[\s\S]*\[K:你、柳三娘\]/);
    const secretPart = text.split('【秘密知情】')[1] || '';
    assert.doesNotMatch(secretPart, /九幽兰/);
});

test('NPC 的秘密字段带知情标记，离场名录不显示', () => {
    let state = run(createEmptyState(), [
        { op: 'set', character: 'user', field: 'gender', value: '未知', evidence: 'msg:0', confidence: 0.9 },
    ]).state;
    state.characters.wang_shop = {
        id: 'wang_shop',
        name: '王掌柜',
        tier: 'major',
        state: {
            identity: { current: '家族旧部', access: 'friend', history: [] },
        },
        items: [],
        skills: [],
        relations: [],
        facts: [],
    };
    state.scene = { time: '夜', place: '客栈', participants: ['user', '王掌柜'] };
    state.characters.wang_shop.access = 'friend';
    const active = assembleInjection(state, { activeCharacterIds: ['user', '王掌柜'], protagonistId: 'user' });
    assert.match(active, /identity：家族旧部 \[K:你、王掌柜\]/);

    state.scene = { time: '夜', place: '客栈', participants: ['user'] };
    const roster = assembleInjection(state, { activeCharacterIds: ['user'], protagonistId: 'user' });
    assert.match(roster, /王掌柜/);
    assert.doesNotMatch(roster, /家族旧部/);
});

test('热窗口外的秘密冷却，近期触碰的仍注入', () => {
    let state = run(createEmptyState(), [
        { op: 'set', character: 'user', field: 'gender', value: '未知', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: '苏婉', field: 'gender', value: '女', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: '柳三娘', field: 'gender', value: '女', evidence: 'msg:0', confidence: 0.9 },
        {
            op: 'add_fact',
            fact: {
                id: 'f_bailu',
                text: '白鹿庄大火时柳三娘在场',
                access: 'protagonist',
            },
            evidence: 'msg:0',
            confidence: 0.9,
        },
        {
            op: 'add_fact',
            fact: {
                id: 'f_self',
                text: '你随身藏着混沌珠',
                access: 'protagonist',
            },
            evidence: 'msg:95',
            confidence: 0.9,
        },
    ]).state;
    state.meta.lastProcessedMessage = 100;
    state.scene = { time: '夜', place: '客栈', participants: ['user', '苏婉'] };
    const text = assembleInjection(state, {
        activeCharacterIds: ['user', '苏婉'],
        protagonistId: 'user',
    });
    assert.doesNotMatch(text, /白鹿庄/);
    assert.match(text, /混沌珠/);
    assert.match(text, /另有 1 条秘密已冷却或与场景无关/);
});

test('关键词命中让冷却的秘密回热', () => {
    let state = run(createEmptyState(), [
        { op: 'set', character: 'user', field: 'gender', value: '未知', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: '柳三娘', field: 'gender', value: '女', evidence: 'msg:0', confidence: 0.9 },
        {
            op: 'add_fact',
            fact: {
                id: 'f_bailu',
                text: '白鹿庄大火时柳三娘在场',
                access: 'protagonist',
                keywords: ['白鹿庄', '大火'],
            },
            evidence: 'msg:0',
            confidence: 0.9,
        },
    ]).state;
    state.meta.lastProcessedMessage = 200;
    state.scene = { time: '夜', place: '客栈', participants: ['user', '苏婉'] };
    const options = { activeCharacterIds: ['user', '苏婉'], protagonistId: 'user' };
    assert.doesNotMatch(assembleInjection(state, { ...options, recentText: '你沉默着。' }), /白鹿庄/);
    assert.match(assembleInjection(state, { ...options, recentText: '你问起白鹿庄的旧事。' }), /白鹿庄/);
});

test('未了结的线索不会被冷却，关闭冷化后全部注入', () => {
    let state = run(createEmptyState(), [
        { op: 'set', character: 'user', field: 'gender', value: '未知', evidence: 'msg:0', confidence: 0.9 },
        {
            op: 'add_fact',
            fact: { id: 'f_debt', text: '你欠柳三娘一块灵石', access: 'protagonist', thread_status: 'open', thread_type: '人情' },
            evidence: 'msg:0',
            confidence: 0.9,
        },
        {
            op: 'add_fact',
            fact: { id: 'f_old', text: '你在黑市卖过一株九幽兰', access: 'protagonist' },
            evidence: 'msg:0',
            confidence: 0.9,
        },
    ]).state;
    state.meta.lastProcessedMessage = 100;
    state.scene = { time: '夜', place: '客栈', participants: ['user'] };
    const options = { activeCharacterIds: ['user'], protagonistId: 'user' };

    const cooled = assembleInjection(state, options);
    assert.match(cooled, /你欠柳三娘一块灵石/);
    assert.doesNotMatch(cooled, /九幽兰/);

    const uncooled = assembleInjection(state, { ...options, secretCooling: false });
    assert.match(uncooled, /九幽兰/);
});

test('lastTouched 从 evidence 记录', () => {
    const result = run(createEmptyState(), [
        { op: 'add_fact', fact: { id: 'f1', text: '某秘密', access: 'protagonist' }, evidence: 'msg:7', confidence: 0.9 },
    ]);
    assert.equal(result.state.facts.f1.lastTouched, 7);
});

test('提取提示词要求把称谓写进 address', () => {
    const { system } = buildExtractionPrompt(createEmptyState(), []);
    assert.match(system, /address/);
    assert.match(system, /称呼不是名字/);
});

test('公开事实里的错误认知仍会注入', () => {
    let state = run(createEmptyState(), [
        { op: 'set', character: 'user', field: 'gender', value: '未知', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: '柳三娘', field: 'gender', value: '女', evidence: 'msg:0', confidence: 0.9 },
        {
            op: 'add_fact',
            fact: {
                id: 'f_rumor',
                text: '镇上流传你是被青云宗赶出来的弃徒',
                access: 'public',
                beliefs: { 柳三娘: { state: 'false_belief', belief: '你是被青云宗赶出来的弃徒' } },
            },
            evidence: 'msg:0',
            confidence: 0.9,
        },
    ]).state;
    state.scene = { time: '黄昏', place: '药铺', participants: ['user', '柳三娘'] };
    const text = assembleInjection(state, {
        activeCharacterIds: ['user', '柳三娘'],
        protagonistId: 'user',
    });
    assert.match(text, /柳三娘误以为「你是被青云宗赶出来的弃徒」/);
    assert.doesNotMatch(text, /不知情=/);
});

test('提取提示词覆盖档位写法与 set_tier', () => {
    const { system, user } = buildExtractionPrompt(createEmptyState(), [], {});
    assert.match(system, /access:"protagonist"/);
    assert.match(system, /set_tier/);
    assert.match(system, /知情 = 角色档位 ≥ 条目档位/);
    assert.match(system, /定档顺序/);
    assert.match(user, /set_tier \{character,access,reason\}/);
    assert.match(user, /add_fact \{fact:\{id,text,access\?,witnesses\?/);
    assert.doesNotMatch(system, /knownBy/);
});

test('事件 stateChanges 写成字符串也能收下', () => {
    const result = run(createEmptyState(), [
        { op: 'append_event', time: '夜', place: '客栈', actors: ['user'], problem: 'p', decision: 'd', result: 'r', stateChanges: '你失去三十枚灵石', evidence: 'msg:0', confidence: 0.9 },
    ]);
    assert.deepEqual(result.state.events[0].stateChanges, ['你失去三十枚灵石']);
});

test('提到关键词时召回已滑出窗口的旧事件', () => {
    const ops = [
        { op: 'set', character: 'user', field: 'gender', value: '男', evidence: 'msg:0', confidence: 0.9 },
        {
            op: 'append_event',
            time: '第一日',
            place: '白鹿庄',
            actors: ['user', '阿箬'],
            problem: '白鹿庄大火',
            decision: '你冲进火场',
            result: '你救出阿箬',
            stateChanges: ['阿箬获救'],
            keywords: ['白鹿庄', '大火', '阿箬'],
            sourceMessages: [1],
            evidence: 'msg:1',
            confidence: 0.9,
        },
    ];
    for (let i = 0; i < 20; i += 1) {
        ops.push({
            op: 'append_event',
            time: `第${i + 2}日`,
            place: '客栈',
            actors: ['user'],
            problem: `日常${i}`,
            decision: '应对',
            result: '过去',
            stateChanges: ['客栈歇脚'],
            keywords: [`日常${i}`],
            sourceMessages: [i + 2],
            evidence: 'msg:0',
            confidence: 0.9,
        });
    }
    let state = createEmptyState();
    for (const op of ops) state = run(state, [op]).state;
    state.scene = { time: '第三十日', place: '客栈', participants: ['user'] };

    const silent = assembleInjection(state, { activeCharacterIds: ['user'], protagonistId: 'user', recentText: '你沉默了一会儿。' });
    assert.doesNotMatch(silent, /【相关旧事】/);

    const mentioned = assembleInjection(state, {
        activeCharacterIds: ['user'],
        protagonistId: 'user',
        recentText: '你问：“白鹿庄那场火，你还记得吗？”',
    });
    assert.match(mentioned, /【相关旧事】/);
    assert.match(mentioned, /白鹿庄大火/);

    const off = assembleInjection(state, {
        activeCharacterIds: ['user'],
        protagonistId: 'user',
        recentText: '你问：“白鹿庄那场火，你还记得吗？”',
        recallEvents: false,
    });
    assert.doesNotMatch(off, /【相关旧事】/);
});

test('set_scene 不会把职务当成角色', () => {
    const result = run(createEmptyState(), [
        { op: 'set_scene', scene: { time: '白日', place: '白玉广场', participants: ['user', '沈砚', '执事', '掌柜'] } },
    ]);
    assert.ok(findCharacter(result.state, '沈砚'));
    assert.equal(findCharacter(result.state, '执事'), undefined);
    assert.equal(findCharacter(result.state, '掌柜'), undefined);
    assert.deepEqual(result.state.scene.participants, ['user', findCharacter(result.state, '沈砚').id]);
});

test('reveal 可以用物品名定位，并把档位放宽', () => {
    let state = createEmptyState();
    state.characters.su = {
        id: 'su', name: '苏绾', tier: 'npc', access: 'friend',
        state: {}, items: [], relations: [], facts: [], skills: [], abilities: [],
    };
    state = run(state, [
        { op: 'add_item', character: 'user', item: { id: 'i_yu', name: '残缺符文的玉牌', access: 'protagonist' }, evidence: 'msg:0', confidence: 0.9 },
    ]).state;
    state = run(state, [
        { op: 'reveal', item: '残缺符文的玉牌', to: '苏绾', method: '给她看', evidence: 'msg:1', confidence: 0.9 },
    ]).state;
    const item = state.characters.user.items[0];
    assert.equal(entityAccess(item), 'friend');
    assert.equal(knowsEntity(item, 'su', state), true);
});

test('提取提示里的角色键与引用都用姓名，不暴露内部 id', () => {
    const state = createEmptyState();
    state.characters.user = {
        id: 'user', name: '你', tier: 'main', access: 'protagonist',
        state: {}, items: [], relations: [], facts: [], skills: [], abilities: [],
    };
    state.characters.npc_001 = {
        id: 'npc_001', name: '苏绾', tier: 'major', access: 'friend',
        state: {}, items: [], relations: [], facts: [], skills: [], abilities: [],
    };
    state.scene = { time: '夜', day: 1, place: '客栈', participants: ['user', 'npc_001'] };
    state.facts.f1 = {
        id: 'f1', text: '你藏着玉牌', access: 'friend',
        beliefs: { npc_001: { state: 'suspects' } }, keywords: [], history: [],
    };
    const { user } = buildExtractionPrompt(state, [{ index: 0, isUser: false, mes: '夜。' }], { newFrom: 0 });
    assert.doesNotMatch(user, /npc_001/);
    assert.match(user, /"苏绾"/);
    assert.match(user, /"participants":\["你","苏绾"\]/);
    assert.match(user, /"beliefs":\{"苏绾":\{"state":"suspects"\}\}/);
});

test('扁平 append_event 的 actors/witnesses/beliefs 也归一化成 id', () => {
    const result = run(createEmptyState(), [{
        op: 'append_event',
        time: '夜', place: '客栈',
        actors: ['苏婉'], witnesses: ['王掌柜'],
        problem: '试探', decision: '出手', result: '惊动',
        stateChanges: ['x'], access: 'friend',
        beliefs: { 王掌柜: { state: 'suspects' } },
        evidence: 'msg:0', confidence: 0.9,
    }]);
    const event = result.state.events[0];
    assert.match(event.actors[0], /^npc_\d+$/);
    assert.match(event.witnesses[0], /^npc_\d+$/);
    const wang = findCharacter(result.state, '王掌柜');
    assert.equal(event.beliefs[wang.id].state, 'suspects');
    assert.ok(findCharacter(result.state, '苏婉'));
});

test('reveal 找不到事实时拒绝，不凭空造条目', () => {
    const result = run(createEmptyState(), [
        { op: 'reveal', fact: 'f_typo', to: '苏婉', evidence: 'msg:0', confidence: 0.9 },
    ]);
    assert.equal(Object.keys(result.state.facts).length, 0);
    assert.equal(result.state.events.length, 0);
    assert.ok(result.rejected.some((item) => /找不到事实/.test(item.reason)));
});

test('事件 [K:] 只看档位，公开级目击者不算知情', () => {
    const state = createEmptyState();
    state.characters.user = { id: 'user', name: '你', tier: 'main', access: 'protagonist', state: {}, items: [], relations: [], facts: [], skills: [], abilities: [] };
    state.characters.guard = { id: 'guard', name: '城卫', tier: 'major', access: 'public', state: {}, items: [], relations: [], facts: [], skills: [], abilities: [] };
    state.characters.su = { id: 'su', name: '苏绾', tier: 'major', access: 'friend', state: {}, items: [], relations: [], facts: [], skills: [], abilities: [] };
    state.scene = { time: '夜', day: 1, place: '客栈', participants: ['user', 'guard', 'su'] };
    const result = run(state, [{
        op: 'append_event',
        event: {
            actors: ['user', 'su'], witnesses: ['guard'],
            problem: '秘密行动', decision: '潜入', result: '成功', stateChanges: ['x'],
            access: 'intimate', sourceMessages: [0],
        },
        evidence: 'msg:0', confidence: 0.9,
    }]);
    const text = assembleInjection(result.state, { tokenBudget: 3000, activeCharacterIds: ['user', 'guard', 'su'] });
    const eventLine = text.split('\n').find((line) => line.startsWith('- [')) || '';
    assert.doesNotMatch(eventLine, /\[K:[^\]]*城卫/);
});

test('改名后其他角色的 targetName 跟着更新', () => {
    const state = run(createEmptyState(), [
        { op: 'set_relation', from: 'user', to: '乙', toName: '乙', type: '同门', evidence: 'msg:0', confidence: 0.9 },
        { op: 'rename_character', from: '乙', to: '丙', evidence: 'msg:1', confidence: 0.9 },
    ]).state;
    assert.equal(state.characters.user.relations[0].targetName, '丙');
});

test('重复事件合并时收紧档位并合并 beliefs', () => {
    const base = {
        op: 'append_event',
        time: '夜', place: '客栈', actors: ['user'],
        problem: 'p', decision: 'd', result: 'r', stateChanges: ['x'], sourceMessages: [0],
        evidence: 'msg:0', confidence: 0.9,
    };
    let state = run(createEmptyState(), [{ ...base, event: { ...base, access: 'public' } }]).state;
    state = run(state, [{
        ...base,
        event: { ...base, access: 'protagonist', beliefs: { 王掌柜: { state: 'suspects' } } },
    }]).state;
    assert.equal(entityAccess(state.events[0]), 'protagonist');
    const wang = findCharacter(state, '王掌柜');
    assert.equal(state.events[0].beliefs[wang.id].state, 'suspects');
});

test('move_item 找不到物品时拒绝，不凭空创建物品', () => {
    const result = run(createEmptyState(), [
        { op: 'move_item', item: 'i_nope', to: '甲', evidence: 'msg:0', confidence: 0.9 },
    ]);
    const items = Object.values(result.state.characters).flatMap((character) => character.items || []);
    assert.equal(items.length, 0);
    assert.ok(result.rejected.some((item) => /找不到物品/.test(item.reason)));
});

test('默认档位与非法档位：事实主角级、物品公开级、写错按主角级', () => {
    const state = run(createEmptyState(), [
        { op: 'add_item', character: 'user', item: { id: 'i1', name: '普通物品' }, evidence: 'msg:0', confidence: 0.9 },
        { op: 'add_item', character: 'user', item: { id: 'i2', name: '写错档位', access: 'secret' }, evidence: 'msg:0', confidence: 0.9 },
        { op: 'add_fact', fact: { id: 'f1', text: '秘密' }, evidence: 'msg:0', confidence: 0.9 },
    ]).state;
    assert.equal(entityAccess(state.characters.user.items.find((item) => item.id === 'i1')), 'public');
    assert.equal(entityAccess(state.characters.user.items.find((item) => item.id === 'i2')), 'protagonist');
    assert.equal(entityAccess(state.facts.f1), 'protagonist');
});

test('预算极紧时整段裁剪，秘密块仍保留', () => {
    const state = run(createEmptyState(), [
        { op: 'add_fact', fact: { id: 'f1', text: '你藏着青玉牌', access: 'protagonist' }, evidence: 'msg:0', confidence: 0.9 },
    ]).state;
    const text = assembleInjection(state, { tokenBudget: 40 });
    assert.match(text, /青玉牌/);
});

test('注入把知情写成正文优先，并给出台账默认', () => {
    const state = createEmptyState();
    state.characters.user = { id: 'user', name: '你', tier: 'main', access: 'protagonist', state: {}, items: [], relations: [], facts: [], skills: [], abilities: [] };
    state.characters.su = { id: 'su', name: '苏绾', tier: 'major', access: 'friend', state: {}, items: [], relations: [], facts: [], skills: [], abilities: [] };
    state.characters.wang = { id: 'wang', name: '王掌柜', tier: 'major', access: 'public', state: {}, items: [], relations: [], facts: [], skills: [], abilities: [] };
    state.scene = { time: '夜', day: 1, place: '客栈', participants: ['user', 'su', 'wang'] };
    state.facts.f1 = { id: 'f1', text: '你藏着玉牌', access: 'friend', keywords: [], history: [], lastTouched: 0 };
    const text = assembleInjection(state, { tokenBudget: 3000, activeCharacterIds: ['user', 'su', 'wang'] });
    assert.match(text, /先看正文/);
    assert.match(text, /不要用台账反驳正文/);
    assert.match(text, /默认知情=苏绾/);
    assert.match(text, /默认不知情=王掌柜/);
    assert.match(text, /旧事离开上下文也按这里/);
    assert.match(text, /在场、看到、正文没提他不知道，都不等于他知道/);
});

test('提取提示要求正文明确写才知道', () => {
    const { system } = buildExtractionPrompt(createEmptyState(), []);
    assert.match(system, /正文明确写某人知道了/);
    assert.match(system, /把档位放宽到该人的档位/);
    assert.match(system, /正文没写某人知道\/不知道时/);
    assert.match(system, /不要因为他在场、看到或沉默就推断/);
});

test('set_tier 给 NPC 定档，主角档位不可改', () => {
    const result = run(createEmptyState(), [
        { op: 'set_tier', character: '苏婉', access: 'intimate', reason: '道侣', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set_tier', character: 'user', access: 'public', reason: '道侣', evidence: 'msg:0', confidence: 0.9 },
    ]);
    assert.equal(characterAccess(findCharacter(result.state, '苏婉')), 'intimate');
    assert.equal(characterAccess(result.state.characters.user), 'protagonist');
});

test('事件按目击者定档：最疏远的目击者决定范围', () => {
    let result = run(tierState(), [eventOp({ actors: ['user', '苏绾'] })]);
    assert.equal(entityAccess(result.state.events[0]), 'friend');

    result = run(tierState(), [eventOp({ actors: ['user'] })]);
    assert.equal(entityAccess(result.state.events[0]), 'protagonist');

    result = run(tierState(), [eventOp({ actors: ['user', '苏绾'], witnesses: ['user', '苏绾', '王掌柜'] })]);
    assert.equal(entityAccess(result.state.events[0]), 'public');
});

test('重复事件合并目击者会放宽范围', () => {
    let result = run(tierState(), [eventOp({ actors: ['user', '苏绾'] })]);
    assert.equal(entityAccess(result.state.events[0]), 'friend');

    result = run(result.state, [
        eventOp({ actors: ['user', '苏绾'], witnesses: ['user', '苏绾', '王掌柜'] }),
    ]);
    assert.equal(result.state.events.length, 1);
    assert.equal(entityAccess(result.state.events[0]), 'public');
});

test('顶层事实按目击者定档，不再一律主角级', () => {
    let result = run(tierState(), [
        { op: 'add_fact', fact: { id: 'f1', text: '你藏着混沌珠', witnesses: ['苏绾'] }, evidence: 'msg:0', confidence: 0.9 },
    ]);
    assert.equal(entityAccess(result.state.facts.f1), 'friend');

    result = run(tierState(), [
        { op: 'add_fact', fact: { id: 'f2', text: '城主贴出悬赏', witnesses: ['王掌柜'] }, evidence: 'msg:0', confidence: 0.9 },
    ]);
    assert.equal(entityAccess(result.state.facts.f2), 'public');

    result = run(tierState(), [
        { op: 'add_fact', fact: { id: 'f3', text: '只有你知道' }, evidence: 'msg:0', confidence: 0.9 },
    ]);
    assert.equal(entityAccess(result.state.facts.f3), 'protagonist');
});

test('显式档位排除了目击者时，按目击者放宽', () => {
    const result = run(tierState(), [
        {
            op: 'add_fact',
            fact: { id: 'f1', text: '你藏着混沌珠', access: 'protagonist', witnesses: ['苏绾'] },
            evidence: 'msg:0',
            confidence: 0.9,
        },
    ]);
    assert.equal(entityAccess(result.state.facts.f1), 'friend');
});

test('set_tier 必须给理由，白名单外的理由被拒绝', () => {
    let result = run(tierState(), [
        { op: 'set_tier', character: '苏绾', access: 'intimate', evidence: 'msg:0', confidence: 0.9 },
    ]);
    assert.equal(characterAccess(result.state.characters.su), 'friend');
    assert.ok(result.rejected.some((item) => /缺少 reason/.test(item.reason)));

    result = run(tierState(), [
        { op: 'set_tier', character: '苏绾', access: 'intimate', reason: '关系变好', evidence: 'msg:0', confidence: 0.9 },
    ]);
    assert.equal(characterAccess(result.state.characters.su), 'friend');
    assert.ok(result.rejected.some((item) => /不能用/.test(item.reason)));
});

test('分歧不降档，只有决裂/背叛/明确疏远能降', () => {
    const state = tierState();
    state.characters.su.access = 'intimate';
    const result = run(state, [
        { op: 'set_tier', character: '苏绾', access: 'friend', reason: '分歧', evidence: 'msg:0', confidence: 0.9 },
    ]);
    assert.equal(characterAccess(result.state.characters.su), 'intimate');
    assert.ok(result.rejected.length);
});

test('同一次结算每个角色只能改一档', () => {
    const state = tierState();
    state.characters.su.access = 'public';
    const result = run(state, [
        { op: 'set_tier', character: '苏绾', access: 'friend', reason: '正式结交', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set_tier', character: '苏绾', access: 'intimate', reason: '道侣', evidence: 'msg:0', confidence: 0.9 },
    ]);
    assert.equal(characterAccess(result.state.characters.su), 'friend');
    assert.ok(result.rejected.some((item) => /只能改一档/.test(item.reason)));
});

test('反向改档有 3 日冷却，里程碑可越过', () => {
    const make = () => {
        const state = tierState();
        state.characters.su.access = 'intimate';
        state.characters.su.accessChangedFrom = 'friend';
        state.characters.su.accessChangedDay = 10;
        state.scene.day = 12;
        return state;
    };
    let result = run(make(), [
        { op: 'set_tier', character: '苏绾', access: 'friend', reason: '明确疏远', evidence: 'msg:0', confidence: 0.9 },
    ]);
    assert.equal(characterAccess(result.state.characters.su), 'intimate');
    assert.ok(result.rejected.some((item) => /不足 3 个故事日/.test(item.reason)));

    const later = make();
    later.scene.day = 13;
    result = run(later, [
        { op: 'set_tier', character: '苏绾', access: 'friend', reason: '明确疏远', evidence: 'msg:0', confidence: 0.9 },
    ]);
    assert.equal(characterAccess(result.state.characters.su), 'friend');

    result = run(make(), [
        { op: 'set_tier', character: '苏绾', access: 'friend', reason: '决裂', evidence: 'msg:0', confidence: 0.9 },
    ]);
    assert.equal(characterAccess(result.state.characters.su), 'friend');
    assert.equal(result.state.characters.su.accessReason, '决裂');
    assert.equal(result.state.characters.su.accessChangedDay, 12);
});

test('长期无往来降档需 30 故事日', () => {
    const make = () => {
        const state = tierState();
        state.characters.su.lastSeenDay = 10;
        state.scene.day = 20;
        return state;
    };
    let result = run(make(), [
        { op: 'set_tier', character: '苏绾', access: 'public', reason: '长期无往来', evidence: 'msg:0', confidence: 0.9 },
    ]);
    assert.equal(characterAccess(result.state.characters.su), 'friend');
    assert.ok(result.rejected.some((item) => /至少 30 个故事日/.test(item.reason)));

    const later = make();
    later.scene.day = 40;
    result = run(later, [
        { op: 'set_tier', character: '苏绾', access: 'public', reason: '长期无往来', evidence: 'msg:0', confidence: 0.9 },
    ]);
    assert.equal(characterAccess(result.state.characters.su), 'public');
});

test('set_scene 记录最近同场日', () => {
    const result = run(tierState(), [
        { op: 'set_scene', scene: { time: '第一日', day: 5, place: '客栈', participants: ['苏绾'] }, evidence: 'msg:0', confidence: 0.9 },
    ]);
    assert.equal(findCharacter(result.state, '苏绾').lastSeenDay, 5);
});

test('重复事件会补齐关键词', () => {
    let state = run(createEmptyState(), [
        { op: 'append_event', time: '第一日', place: '白鹿庄', actors: ['user'], problem: '大火', decision: '冲进去', result: '救人', stateChanges: ['救出阿箬'], sourceMessages: [0], evidence: 'msg:0', confidence: 0.9 },
    ]).state;
    state = run(state, [
        { op: 'append_event', time: '第一日', place: '白鹿庄', actors: ['user'], problem: '大火', decision: '冲进去', result: '救人', stateChanges: ['救出阿箬'], keywords: ['白鹿庄', '大火'], sourceMessages: [0], evidence: 'msg:0', confidence: 0.9 },
    ]).state;
    assert.equal(state.events.length, 1);
    assert.deepEqual(state.events[0].keywords, ['白鹿庄', '大火']);
});

test('两个字的泛指关键词单独命中不触发召回', () => {
    let state = run(createEmptyState(), [
        {
            op: 'append_event',
            time: '第一日',
            place: '客栈',
            actors: ['user'],
            problem: '买了灵石',
            decision: '付钱',
            result: '成交',
            stateChanges: ['灵石成交'],
            keywords: ['灵石'],
            sourceMessages: [0],
            evidence: 'msg:0',
            confidence: 0.9,
        },
    ]).state;
    state.scene = { time: '夜', place: '客栈', participants: ['user'] };
    const options = { activeCharacterIds: ['user'], protagonistId: 'user' };
    assert.doesNotMatch(assembleInjection(state, { ...options, recentText: '你数了数灵石。' }), /【相关旧事】/);
});

test('关闭离场角色名录后不再注入其他角色', () => {
    let state = run(createEmptyState(), [
        { op: 'set', character: 'user', field: 'gender', value: '未知', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: '苏婉', field: 'gender', value: '女', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: '柳三娘', field: 'gender', value: '女', evidence: 'msg:0', confidence: 0.9 },
    ]).state;
    state.scene = { time: '夜', place: '客栈', participants: ['user', '苏婉'] };
    const options = { activeCharacterIds: ['user', '苏婉'], protagonistId: 'user' };
    assert.match(assembleInjection(state, options), /【其他角色】/);
    assert.doesNotMatch(assembleInjection(state, { ...options, showOthers: false }), /【其他角色】/);
});

test('主角物品过多时截断并给出计数', () => {
    const ops = [{ op: 'set', character: 'user', field: 'gender', value: '未知', evidence: 'msg:0', confidence: 0.9 }];
    for (let i = 0; i < 20; i += 1) {
        ops.push({ op: 'add_item', character: 'user', item: { id: `i_x${i}`, name: `杂物${i}` }, evidence: 'msg:0', confidence: 0.9 });
    }
    let state = run(createEmptyState(), ops).state;
    state.scene = { time: '夜', place: '客栈', participants: ['user'] };
    const text = assembleInjection(state, { activeCharacterIds: ['user'], protagonistId: 'user' });
    assert.match(text, /另有 5 项/);
});

test('重大事件不会无限累积，注入里也不出现事件 id', () => {
    const ops = [];
    for (let i = 0; i < 20; i += 1) {
        ops.push({
            op: 'append_event',
            time: `第${i}日`,
            place: '客栈',
            actors: ['user'],
            problem: `问题${i}`,
            decision: '决策',
            result: '结果',
            importance: 'major',
            sourceMessages: [i],
            evidence: 'msg:0',
            confidence: 0.9,
        });
    }
    let state = run(createEmptyState(), ops).state;
    state.scene = { time: '夜', place: '客栈', participants: ['user'] };
    const text = assembleInjection(state, { activeCharacterIds: ['user'], protagonistId: 'user', tokenBudget: 5000 });
    const lines = text.split('\n').filter((line) => line.includes(' → '));
    assert.equal(lines.length, 13);
    assert.doesNotMatch(text, /问题0/);
    assert.match(text, /问题7/);
    assert.doesNotMatch(text, /\[e\d{4}/);
});

test('旧版 objective 字段不再注入', () => {
    let state = run(createEmptyState(), [
        { op: 'set', character: 'user', field: 'objective', value: '夺回宗门', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: 'user', field: 'realm', value: '筑基一层', evidence: 'msg:0', confidence: 0.9 },
    ]).state;
    state.scene = { time: '夜', place: '客栈', participants: ['user'] };
    const text = assembleInjection(state, { activeCharacterIds: ['user'], protagonistId: 'user' });
    assert.doesNotMatch(text, /夺回宗门/);
    assert.match(text, /realm：筑基一层/);
});

test('提取提示词区分玩家内心与当众说出', () => {
    const { system } = buildExtractionPrompt(createEmptyState(), []);
    assert.match(system, /不等于当众说出/);
});

test('提取提示要求按正文双向记录知情（重复覆盖）', () => {
    const { system } = buildExtractionPrompt(createEmptyState(), []);
    assert.match(system, /正文明确写某人知道了/);
    assert.match(system, /正文明确写某人不知道\/被瞒着/);
});

test('注入渲染 NPC 对玩家的称呼', () => {
    let state = run(createEmptyState(), [
        { op: 'set_relation', from: '苏婉', to: 'user', type: '同门', attitude: '亲近', address: '师兄', evidence: 'msg:1', confidence: 0.9 },
    ]).state;
    state.scene = { time: '夜', place: '客栈', participants: ['user', '苏婉'] };
    const text = assembleInjection(state, {
        tokenBudget: 3000,
        activeCharacterIds: ['user', '苏婉'],
        protagonistId: 'user',
    });
    assert.match(text, /【角色·苏婉】[\s\S]*对玩家：同门\/亲近，称「师兄」/);
});

test('parseExtractionResponse 容忍字符串里的裸换行', () => {
    const text = '{"ops":[{"op":"append_event","event":{"problem":"第一行\n第二行"}}],"leaks":[]}';
    const data = parseExtractionResponse(text);
    assert.equal(data.ops[0].event.problem, '第一行\n第二行');
});

test('parseExtractionResponse 容忍 op 提前闭合', () => {
    const text = '{"ops":[{"op":"append_event","event":{"problem":"x"}},"evidence":"msg:0","confidence":0.9}],"leaks":[]}';
    const data = parseExtractionResponse(text);
    assert.equal(data.ops[0].evidence, 'msg:0');
    assert.equal(data.ops[0].event.problem, 'x');
});

test('重复抽取同一关系不新增版本', () => {
    let state = run(createEmptyState(), [
        { op: 'set_relation', from: '阿箬', to: 'user', type: '同门', attitude: '惊讶', address: '师叔', evidence: 'msg:1', confidence: 0.9 },
    ]).state;
    state = run(state, [
        { op: 'set_relation', from: '阿箬', to: 'user', type: '同门', attitude: '惊讶', address: '师叔', evidence: 'msg:9', confidence: 0.9 },
    ]).state;
    assert.equal(findCharacter(state, '阿箬').relations.length, 1);
});

test('move_item 移到当前持有者不产生新版本', () => {
    let state = run(createEmptyState(), [
        { op: 'add_item', character: 'user', item: { id: 'i_lan', name: '九幽兰' }, evidence: 'msg:0', confidence: 0.9 },
    ]).state;
    state = run(state, [
        { op: 'move_item', item: 'i_lan', to: 'user', evidence: 'msg:1', confidence: 0.9 },
    ]).state;
    const items = state.characters.user.items;
    assert.equal(items.length, 1);
    assert.equal(items[0].validTo, null);
});

test('adjust_item 接受对象形式的 item', () => {
    const result = run(createEmptyState(), [
        {
            op: 'adjust_item',
            character: 'user',
            item: { id: 'i_lingshi', name: '灵石', kind: 'currency', unit: '枚' },
            delta: 50,
            evidence: 'msg:0',
            confidence: 0.9,
        },
    ]);
    const item = result.state.characters.user.items[0];
    assert.equal(item.name, '灵石');
    assert.equal(item.quantity, 50);
    assert.equal(item.unit, '枚');
});

test('事实与事件文本里的 user 归一化为「你」', () => {
    const result = run(createEmptyState(), [
        {
            op: 'add_fact',
            fact: { id: 'f1', text: '王掌柜称 user 为少主', visibility: 'secret', knownBy: { user: { state: 'knows' } } },
            evidence: 'msg:0',
            confidence: 0.9,
        },
        {
            op: 'append_event',
            event: {
                time: '夜',
                place: '客栈',
                actors: ['user'],
                problem: 'user 追问身份',
                decision: '王掌柜承认',
                result: 'user 得知真相',
                stateChanges: ['王掌柜承认身份'],
                sourceMessages: [0],
            },
            evidence: 'msg:0',
            confidence: 0.9,
        },
        { op: 'set', character: '王掌柜', field: 'status', value: '效忠 user 的旧仆', evidence: 'msg:0', confidence: 0.9 },
    ]);
    assert.equal(result.state.facts.f1.text, '王掌柜称 你 为少主');
    assert.equal(result.state.events[0].problem, '你 追问身份');
    assert.equal(result.state.events[0].result, '你 得知真相');
    assert.equal(findCharacter(result.state, '王掌柜').state.status.current, '效忠 你 的旧仆');
});

test('progress 归一化为 0-100 的整数', () => {
    let result = run(createEmptyState(), [
        { op: 'set', character: 'user', field: 'realm', value: '练气三层', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: 'user', field: 'progress', value: '43%', evidence: 'msg:0', confidence: 0.9 },
    ]);
    assert.equal(result.state.characters.user.state.progress.current, 43);

    result = run(result.state, [
        { op: 'set', character: 'user', field: 'progress', value: 180, evidence: 'msg:1', confidence: 0.9 },
    ]);
    assert.equal(result.state.characters.user.state.progress.current, 100);

    result = run(result.state, [
        { op: 'set', character: 'user', field: 'progress', value: -3, evidence: 'msg:2', confidence: 0.9 },
    ]);
    assert.equal(result.state.characters.user.state.progress.current, 0);
});

test('progress 为 0 仍然注入台账', () => {
    const result = run(createEmptyState(), [
        { op: 'set', character: 'user', field: 'progress', value: 0, evidence: 'msg:0', confidence: 0.9 },
    ]);
    const text = assembleInjection(result.state, { protagonistId: 'user', activeCharacterIds: ['user'] });
    assert.match(text, /progress：0\/100/);
});

test('progress 只对主角可见，NPC 的进度不注入', () => {
    const result = run(createEmptyState(), [
        { op: 'set', character: 'user', field: 'progress', value: 30, evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: '苏婉', field: 'progress', value: 60, evidence: 'msg:0', confidence: 0.9 },
    ]);
    const text = assembleInjection(result.state, {
        protagonistId: 'user',
        activeCharacterIds: ['user', '苏婉'],
    });
    assert.match(text, /progress：30\/100 \[K:你\]/);
    assert.doesNotMatch(text, /progress：60/);
});

test('progress 非数字被拒绝', () => {
    const result = run(createEmptyState(), [
        { op: 'set', character: 'user', field: 'progress', value: '练气三层', evidence: 'msg:0', confidence: 0.9 },
    ]);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.state.characters.user?.state?.progress, undefined);
});

test('scene.day 与事件日期算出「多久以前」', () => {
    const result = run(createEmptyState(), [
        { op: 'set_scene', scene: { time: '夏·六月初三·午时', day: 1, place: '白玉广场', participants: ['user'] } },
        {
            op: 'append_event',
            event: {
                time: '夏·六月初三',
                place: '白玉广场',
                actors: ['user'],
                problem: '沈砚被追债',
                decision: '你替他挡下',
                result: '追债的人走了',
                sourceMessages: [0],
                importance: 'major',
            },
            evidence: 'msg:0',
            confidence: 0.9,
        },
        { op: 'set_scene', scene: { time: '夏·七月初三·午时', day: 31, place: '白玉广场', participants: ['user'] } },
    ]);
    assert.equal(result.state.scene.day, 31);
    assert.equal(result.state.events[0].day, 1);
    const text = assembleInjection(result.state, { protagonistId: 'user', activeCharacterIds: ['user'] });
    assert.match(text, /约 1 个月前/);
});

test('缺少日期时不编造「多久以前」', () => {
    const result = run(createEmptyState(), [
        {
            op: 'append_event',
            event: {
                time: '某日',
                place: '某地',
                actors: ['user'],
                problem: '甲',
                decision: '乙',
                result: '丙',
                sourceMessages: [0],
            },
            evidence: 'msg:0',
            confidence: 0.9,
        },
    ]);
    const text = assembleInjection(result.state, { protagonistId: 'user', activeCharacterIds: ['user'] });
    assert.doesNotMatch(text, /\[\d+ 天前/);
    assert.doesNotMatch(text, /\[约 \d+ 个月前/);
});

test('replayHistory 按场景参与者重建角色档案且不改写日志', () => {
    const history = [{
        to: 0,
        prefixHash: 'x',
        ops: [
            { op: 'set', character: '你', field: 'gender', value: '男', evidence: 'msg:0', confidence: 0.9 },
            {
                op: 'set_scene',
                scene: { time: '夏·六月初三·午时', day: 1, place: '白玉广场', participants: ['你', '白玉广场执事', '月白长裙女修'] },
            },
        ],
        scene: { time: '夏·六月初三·午时', day: 1, place: '白玉广场', participants: ['user', 'npc_001', 'npc_002'] },
    }];

    const state = replayHistory(history, 0);
    assert.equal(state.characters.npc_001.name, '白玉广场执事');
    assert.equal(state.characters.npc_002.name, '月白长裙女修');
    assert.deepEqual(state.scene.participants, ['user', 'npc_001', 'npc_002']);
    // 回放用的是副本：日志里仍然是姓名，第二次回放照样能认出同一批角色。
    assert.equal(history[0].ops[1].scene.participants[1], '白玉广场执事');
    const again = replayHistory(history, 0);
    assert.equal(Object.keys(again.characters).length, 3);
});

test('replayHistory 保留 scene.day', () => {
    const state = replayHistory([{
        to: 1,
        prefixHash: 'x',
        ops: [],
        scene: { time: '夏·六月初三', day: 5, place: '白玉广场', participants: ['user'] },
    }], 1);
    assert.equal(state.scene.day, 5);
});

test('reveal 字段时放宽到该角色所在档', () => {
    const result = run(createEmptyState(), [
        { op: 'set', character: 'user', field: 'realm', value: '筑基', access: 'protagonist', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: '老乞丐', field: 'gender', value: '男', evidence: 'msg:0', confidence: 0.9 },
        { op: 'reveal', to: '老乞丐', character: 'user', field: 'realm', method: '神识', evidence: 'msg:0', confidence: 0.9 },
    ]);
    // 老乞丐是公开级，放宽档位等于公开。
    assert.equal(entityAccess(result.state.characters.user.state.realm), 'public');
});

test('怀疑与不知情不会进知情名单', () => {
    const result = run(createEmptyState(), [
        { op: 'set', character: 'user', field: 'gender', value: '男', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: '苏婉', field: 'gender', value: '女', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: '王掌柜', field: 'gender', value: '男', evidence: 'msg:0', confidence: 0.9 },
        {
            op: 'add_fact',
            fact: {
                id: 'f1',
                text: '你藏着青玉牌',
                access: 'protagonist',
                beliefs: { 苏婉: { state: 'suspects' } },
            },
            evidence: 'msg:0',
            confidence: 0.9,
        },
        {
            op: 'add_fact',
            fact: {
                id: 't1',
                text: '你欠柳三娘一个人情',
                access: 'protagonist',
                thread_status: 'open',
            },
            evidence: 'msg:0',
            confidence: 0.9,
        },
    ]);
    const text = assembleInjection(result.state, {
        protagonistId: 'user',
        activeCharacterIds: ['user', '苏婉', '王掌柜'],
    });
    assert.match(text, /主角级；只有你知道/);
    assert.match(text, /怀疑=苏婉/);
    assert.doesNotMatch(text, /不知情=/);
    // 未了结的线走 [K:]：只有档位够格的人进名单。
    assert.match(text, /【未了结】[\s\S]*\[K:你\]/);
    assert.doesNotMatch(text, /\[K:[^\]]*苏婉/);
});

test('普通事件必须写 stateChanges', () => {
    const result = run(createEmptyState(), [
        {
            op: 'append_event',
            event: { problem: '看了一眼', decision: '没动', result: '无事', sourceMessages: [0] },
            evidence: 'msg:0',
            confidence: 0.9,
        },
        {
            op: 'append_event',
            event: {
                problem: '买下符纸', decision: '付钱', result: '成交',
                stateChanges: ['灵石 -3'], sourceMessages: [1],
            },
            evidence: 'msg:1',
            confidence: 0.9,
        },
    ]);
    assert.equal(result.state.events.length, 1);
    assert.equal(result.state.events[0].problem, '买下符纸');
    assert.equal(result.rejected.length, 1);
});

test('每轮普通事件最多 2 条，major 不占配额', () => {
    const result = run(createEmptyState(), [
        { op: 'append_event', event: { problem: 'a', result: 'A', stateChanges: ['x'], sourceMessages: [0] }, evidence: 'msg:0', confidence: 0.9 },
        { op: 'append_event', event: { problem: 'b', result: 'B', stateChanges: ['y'], sourceMessages: [1] }, evidence: 'msg:1', confidence: 0.9 },
        { op: 'append_event', event: { problem: 'c', result: 'C', stateChanges: ['z'], sourceMessages: [2] }, evidence: 'msg:2', confidence: 0.9 },
        { op: 'append_event', event: { problem: 'd', result: 'D', importance: 'major', sourceMessages: [3] }, evidence: 'msg:3', confidence: 0.9 },
    ]);
    assert.equal(result.state.events.length, 3);
    assert.deepEqual(result.state.events.map((event) => event.problem), ['a', 'b', 'd']);
    assert.equal(result.rejected.length, 1);
});

test('同场地同人物的拆碎事件自动合并', () => {
    const result = run(createEmptyState(), [
        {
            op: 'append_event',
            event: {
                place: '破庙', actors: ['user', '沈砚'],
                problem: '两个人打起来', decision: '你挡在中间', result: '暂时停手',
                stateChanges: ['冲突暂缓'], keywords: ['破庙'], sourceMessages: [0],
            },
            evidence: 'msg:0',
            confidence: 0.9,
        },
        {
            op: 'append_event',
            event: {
                place: '破庙', actors: ['user', '沈砚'],
                problem: '其中一人拔刀', decision: '你夺下刀', result: '人跑了',
                stateChanges: ['刀被夺下'], keywords: ['钢刀'], sourceMessages: [0, 1],
            },
            evidence: 'msg:1',
            confidence: 0.9,
        },
    ]);
    assert.equal(result.state.events.length, 1);
    const event = result.state.events[0];
    assert.equal(event.problem, '两个人打起来');
    assert.equal(event.result, '人跑了');
    assert.deepEqual([...event.keywords].sort(), ['破庙', '钢刀'].sort());
    assert.deepEqual(event.stateChanges, ['冲突暂缓', '刀被夺下']);
    assert.deepEqual([...event.sourceMessages].sort((a, b) => a - b), [0, 1]);
});

test('公开事件写到秘密物品名时自动降级为 secret', () => {
    const result = run(createEmptyState(), [
        { op: 'set', character: 'user', field: 'gender', value: '男', evidence: 'msg:0', confidence: 0.9 },
        {
            op: 'add_item',
            character: 'user',
            item: {
                id: 'i_yu', name: '青玉牌', access: 'protagonist',
            },
            evidence: 'msg:0',
            confidence: 0.9,
        },
        {
            op: 'append_event',
            event: {
                place: '街角',
                actors: ['user'],
                problem: '老乞丐搭话',
                decision: '你揣着玉牌走到街角',
                result: '他笑了笑',
                stateChanges: ['被认出'],
                sourceMessages: [0],
                access: 'public',
            },
            evidence: 'msg:0',
            confidence: 0.9,
        },
    ]);
    const event = result.state.events[0];
    // 公开事件写到秘密物品名，自动收紧为主角级。
    assert.equal(entityAccess(event), 'protagonist');
});

test('文本命中大事但没记 major 时给出提醒', () => {
    const messages = [{ mes: '你突然筑基成功，气机惊动了半条街。' }];
    assert.match(detectMissingMajorEvent(messages, []), /疑似漏记大事/);
    const ops = [{ op: 'append_event', event: { importance: 'major', problem: '筑基', result: '成功' } }];
    assert.equal(detectMissingMajorEvent(messages, ops), '');
});

test('背景设定里的境界词不触发漏记提醒', () => {
    assert.equal(detectMissingMajorEvent([{ mes: '祖上也曾出过金丹修士，如今家道中落。' }], []), '');
    assert.equal(detectMissingMajorEvent([{ mes: '城里流传着元婴老祖的传说。' }], []), '');
});

test('真正的大事仍然触发提醒', () => {
    assert.match(detectMissingMajorEvent([{ mes: '他突破金丹，雷劫压了下来。' }], []), /疑似漏记大事/);
});

test('稳定 ID：姓名揭示只改名，不新建档案', () => {
    const state = run(createEmptyState(), [
        { op: 'set', character: '月白长裙女修', name: '月白长裙女修', field: 'gender', value: '女', evidence: 'msg:0', confidence: 0.9 },
    ]).state;
    const id = findCharacter(state, '月白长裙女修').id;
    const result = run(state, [
        { op: 'rename_character', from: '月白长裙女修', to: '苏绾', evidence: 'msg:1', confidence: 0.9 },
    ]);
    const su = findCharacter(result.state, '苏绾');
    assert.equal(su.id, id);
    assert.equal(su.name, '苏绾');
    assert.ok(su.aliases.includes('月白长裙女修'));
    assert.equal(findCharacter(result.state, '月白长裙女修').id, id);
});

test('稳定 ID：不同执事是两个档案，档位互不影响', () => {
    const result = run(createEmptyState(), [
        { op: 'set', character: '白玉广场执事甲', field: 'gender', value: '男', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: '坊市执事乙', field: 'gender', value: '男', evidence: 'msg:1', confidence: 0.9 },
        { op: 'set_tier', character: '白玉广场执事甲', access: 'friend', reason: '正式结交', evidence: 'msg:1', confidence: 0.9 },
        {
            op: 'add_fact',
            fact: { id: 'f1', text: '你藏了玉牌', access: 'friend' },
            evidence: 'msg:2',
            confidence: 0.9,
        },
    ]);
    const a = findCharacter(result.state, '白玉广场执事甲');
    const b = findCharacter(result.state, '坊市执事乙');
    assert.notEqual(a.id, b.id);
    assert.equal(knowsEntity(result.state.facts.f1, a.id, result.state), true);
    assert.equal(knowsEntity(result.state.facts.f1, b.id, result.state), false);
});

test('稳定 ID：merge_character 迁移数据与引用', () => {
    const state = run(createEmptyState(), [
        { op: 'add_item', character: '月白长裙女修', item: { id: 'i_coin', name: '旧铜钱' }, evidence: 'msg:0', confidence: 0.9 },
        { op: 'set_relation', from: '月白长裙女修', to: 'user', type: '相识', evidence: 'msg:1', confidence: 0.9 },
        { op: 'set', character: '苏绾', field: 'gender', value: '女', evidence: 'msg:2', confidence: 0.9 },
    ]).state;
    const from = findCharacter(state, '月白长裙女修');
    const to = findCharacter(state, '苏绾');
    const result = run(state, [
        { op: 'merge_character', from: '月白长裙女修', to: '苏绾', evidence: 'msg:3', confidence: 0.9 },
    ]);
    assert.equal(findCharacter(result.state, '月白长裙女修').id, to.id);
    assert.equal(findCharacter(result.state, '苏绾').items.length, 1);
    assert.equal(findCharacter(result.state, '苏绾').relations.length, 1);
    assert.ok(findCharacter(result.state, '苏绾').aliases.includes('月白长裙女修'));
    assert.equal(result.state.characters[from.id], undefined);
});

test('稳定 ID：旧名字台账迁移并重写版本日志', () => {
    const state = createEmptyState();
    state.meta.identityVersion = 0;
    state.characters = {
        苏婉: {
            id: '苏婉', name: '苏婉', tier: 'major', state: {}, items: [],
            relations: [{ target: '王掌柜', targetName: '王掌柜', validTo: null }],
            facts: [], skills: [], abilities: [],
        },
        王掌柜: {
            id: '王掌柜', name: '王掌柜', tier: 'major', state: {}, items: [],
            relations: [], facts: [], skills: [], abilities: [],
        },
    };
    state.facts = { f1: { id: 'f1', text: '秘密', access: 'protagonist', beliefs: { 苏婉: { state: 'suspects' } } } };
    state.events = [{
        id: 'e1',
        actors: ['苏婉'],
        witnesses: ['王掌柜'],
        beliefs: { 苏婉: { state: 'suspects' } },
        problem: 'x',
        decision: 'y',
        result: 'z',
    }];
    state.meta.history = [{
        to: 0,
        prefixHash: 'h',
        ops: [{ op: 'set', character: '苏婉', field: 'gender', value: '女' }],
        scene: { participants: ['苏婉'] },
    }];

    assert.equal(migrateStableIds(state), true);
    const su = findCharacter(state, '苏婉');
    const wang = findCharacter(state, '王掌柜');
    assert.notEqual(su.id, '苏婉');
    assert.equal(state.facts.f1.beliefs[su.id].state, 'suspects');
    assert.deepEqual(state.events[0].actors, [su.id]);
    assert.deepEqual(state.events[0].witnesses, [wang.id]);
    assert.equal(state.events[0].beliefs[su.id].state, 'suspects');
    assert.equal(state.meta.history[0].ops[0].character, su.id);
    assert.deepEqual(state.meta.history[0].scene.participants, [su.id]);
    assert.equal(migrateStableIds(state), false);
});

test('真正的大事：杀人也触发提醒', () => {
    assert.match(detectMissingMajorEvent([{ mes: '你一剑杀死了追兵。' }], []), /疑似漏记大事/);
});

test('reveal 已记录扩散时不再误报漏记大事', () => {
    const messages = [{ mes: '你的身份暴露了，满堂哗然。' }];
    const ops = [{ op: 'reveal', fact: 'f_identity', to: 'su_wan' }];
    assert.equal(detectMissingMajorEvent(messages, ops), '');
});

test('reveal 公开条目是空操作，不会把它变成秘密', () => {
    let state = createEmptyState();
    state.characters.lin_yuan = { id: 'lin_yuan', name: '林远', tier: 'main', state: {}, items: [], relations: [], facts: [], skills: [], abilities: [] };
    state = run(state, [
        { op: 'add_skill', character: 'lin_yuan', skill: { id: 'sk_open', name: '御剑术' }, evidence: 'msg:1', confidence: 0.9 },
    ]).state;
    const before = state.events.length;
    state = run(state, [
        { op: 'reveal', skill: 'sk_open', to: 'su_wan', method: '当众演示', evidence: 'msg:2', confidence: 0.9 },
    ]).state;
    const skill = state.characters.lin_yuan.skills[0];
    assert.ok(!skill.knownBy || Object.keys(skill.knownBy).length === 0);
    assert.equal(state.events.length, before);
});

test('所有秘密都冷却时仍输出冷条目计数', () => {
    let state = createEmptyState();
    state.characters.lin_yuan = { id: 'lin_yuan', name: '林远', tier: 'main', state: {}, items: [], relations: [], facts: [], skills: [], abilities: [] };
    state = run(state, [{
        op: 'add_fact',
        fact: { id: 'f_cold', text: '旧日的血债', access: 'protagonist' },
        evidence: 'msg:1',
        confidence: 0.9,
    }]).state;
    state.meta.lastProcessedMessage = 100;
    state.scene = { time: '夜', place: '客栈', participants: ['lin_yuan'] };
    const text = assembleInjection(state, {
        activeCharacterIds: ['lin_yuan'],
        protagonistId: 'lin_yuan',
    });
    assert.doesNotMatch(text, /旧日的血债/);
    assert.match(text, /另有 1 条秘密已冷却/);
});

test('关闭知情约束仍保留主角秘密内容', () => {
    let state = createEmptyState();
    state = run(state, [
        { op: 'set', character: 'user', field: 'realm', value: '筑基', access: 'protagonist', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: 'user', field: 'progress', value: '30', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: '王掌柜', field: 'gender', value: '男', evidence: 'msg:0', confidence: 0.9 },
        { op: 'add_item', character: 'user', item: { name: '混沌珠', access: 'protagonist' }, evidence: 'msg:0', confidence: 0.9 },
        { op: 'add_fact', fact: { id: 'f1', text: '你是魔修', access: 'protagonist' }, evidence: 'msg:0', confidence: 0.9 },
        {
            op: 'add_fact',
            fact: {
                id: 'f2', text: '宗门大比三日后举行', access: 'public',
                beliefs: { 王掌柜: { state: 'false_belief', belief: '大比取消了' } },
            },
            evidence: 'msg:0', confidence: 0.9,
        },
        {
            op: 'append_event',
            event: {
                time: '第一日', place: '客栈', actors: ['user'], problem: '秘密行动',
                decision: '潜入', result: '成功', importance: 'major',
                access: 'protagonist', sourceMessages: [0],
            },
            evidence: 'msg:0', confidence: 0.9,
        },
    ]).state;
    const text = assembleInjection(state, { tokenBudget: 3000, knowledgeGate: false });
    assert.match(text, /混沌珠/);
    assert.match(text, /筑基/);
    assert.match(text, /你是魔修/);
    assert.match(text, /大比取消了/);
    assert.match(text, /progress：30\/100/);
    assert.doesNotMatch(text, /\[K:你\]/);
});

test('回放真实版本日志不会造出幽灵角色', () => {
    const result = run(createEmptyState(), [
        {
            op: 'append_event', time: '第一日', place: '客栈', actors: ['苏绾', '你'],
            problem: '事', decision: '做', result: '成', stateChanges: ['有变化'],
            sourceMessages: [0], evidence: 'msg:0', confidence: 0.9,
        },
        { op: 'set_tier', character: '苏绾', access: 'friend', reason: '同门名分', evidence: 'msg:0', confidence: 0.9 },
    ]);
    const sceneOp = {
        op: 'set_scene',
        scene: { time: '第一日', day: 1, place: '客栈', participants: ['你', '苏绾'] },
    };
    const replayed = replayHistory([{
        to: 0,
        prefixHash: '',
        ops: [...result.applied, sceneOp],
        characters: Object.values(result.state.characters).map((character) => ({
            id: character.id,
            name: character.name,
            aliases: character.aliases || [],
        })),
    }]);
    const characters = Object.values(replayed.characters);
    assert.equal(characters.length, 2);
    const su = characters.find((character) => character.name === '苏绾');
    assert.ok(su);
    assert.equal(characterAccess(su), 'friend');
    assert.ok(!characters.some((character) => character.name === 'npc_001'));
});

test('回放按角色快照分配 id，不会把境界串到在场角色', () => {
    const result = run(createEmptyState(), [
        { op: 'set', character: '林远', field: 'realm', value: '筑基', access: 'public', evidence: 'msg:0', confidence: 0.9 },
    ]);
    ensureCharacterRecord(result.state, '苏绾');
    const sceneOp = {
        op: 'set_scene',
        scene: { time: '第一日', day: 1, place: '客栈', participants: ['苏绾'] },
    };
    const replayed = replayHistory([{
        to: 0,
        prefixHash: '',
        ops: [...result.applied, sceneOp],
        characters: Object.values(result.state.characters).map((character) => ({
            id: character.id,
            name: character.name,
            aliases: character.aliases || [],
        })),
    }]);
    const lin = Object.values(replayed.characters).find((character) => character.name === '林远');
    const su = Object.values(replayed.characters).find((character) => character.name === '苏绾');
    assert.ok(lin);
    assert.ok(su);
    assert.equal(lin.state.realm.current, '筑基');
    assert.equal(su.state.realm, undefined);
});

test('回放保留同一次结算里改名的旧名别名', () => {
    const result = run(createEmptyState(), [
        { op: 'set', character: '月白长裙女修', field: 'gender', value: '女', evidence: 'msg:0', confidence: 0.9 },
        { op: 'rename_character', from: '月白长裙女修', to: '苏绾', evidence: 'msg:0', confidence: 0.9 },
    ]);
    const replayed = replayHistory([{
        to: 0,
        prefixHash: '',
        ops: [...result.applied],
        characters: Object.values(result.state.characters).map((character) => ({
            id: character.id,
            name: character.name,
            aliases: character.aliases || [],
        })),
    }]);
    const su = Object.values(replayed.characters).find((character) => character.name === '苏绾');
    assert.ok(su);
    assert.ok(su.aliases.includes('月白长裙女修'));
    assert.equal(Object.values(replayed.characters).length, 1);
});

test('reveal 只带怀疑时不写泄露事件、不改档位', () => {
    const state = tierState();
    state.facts.f1 = { id: 'f1', text: '你藏着玉牌', access: 'protagonist', keywords: [], history: [] };
    const result = run(state, [
        { op: 'reveal', fact: 'f1', to: '苏绾', suspicion: '看向你怀里', evidence: 'msg:0', confidence: 0.9 },
    ]);
    assert.equal(entityAccess(result.state.facts.f1), 'protagonist');
    assert.equal(result.state.events.length, 0);
    assert.equal(result.changedOps.filter((op) => op.op === 'reveal').length, 0);
    assert.equal(result.state.facts.f1.beliefs.su.state, 'suspects');
});

test('0.5–0.7 的 op 只待复核，不落账', () => {
    const result = run(createEmptyState(), [
        { op: 'set', character: 'user', field: 'realm', value: '金丹', evidence: 'msg:0', confidence: 0.6 },
    ]);
    assert.equal(result.state.characters.user?.state?.realm, undefined);
    assert.equal(result.applied.length, 0);
    assert.equal(result.review.length, 1);
});

test('reveal 不能被显式 access 越过目标档位', () => {
    const state = tierState();
    state.facts.f1 = { id: 'f1', text: '你藏着玉牌', access: 'protagonist', keywords: [], history: [] };
    const result = run(state, [
        { op: 'reveal', fact: 'f1', to: '苏绾', access: 'public', evidence: 'msg:0', confidence: 0.9 },
    ]);
    assert.equal(entityAccess(result.state.facts.f1), 'friend');
});

test('玩家身份字段首次可写，之后不可改写', () => {
    const result = run(createEmptyState(), [
        { op: 'set', character: 'user', field: 'spiritRoot', value: '杂灵根', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: 'user', field: 'spiritRoot', value: '天灵根', evidence: 'msg:1', confidence: 0.9 },
    ]);
    assert.equal(result.state.characters.user.state.spiritRoot.current, '杂灵根');
    assert.ok(result.rejected.some((item) => /不能改写玩家的 spiritRoot/.test(item.reason)));
});

test('中文身份字段也受写保护', () => {
    const result = run(createEmptyState(), [
        { op: 'set', character: 'user', field: '灵根', value: '杂灵根', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: 'user', field: '灵根', value: '天灵根', evidence: 'msg:1', confidence: 0.9 },
    ]);
    assert.equal(result.state.characters.user.state.spiritRoot.current, '杂灵根');
    assert.ok(result.rejected.some((item) => /不能改写玩家的 spiritRoot/.test(item.reason)));
});

test('有 user 时，旧数据里 NPC 的 tier main 会被降级', () => {
    const state = createEmptyState();
    state.characters.user = {
        id: 'user', name: '你', tier: 'main', access: 'protagonist',
        state: {}, items: [], relations: [], facts: [], skills: [], abilities: [],
    };
    state.characters.su = {
        id: 'su', name: '苏绾', tier: 'main', access: 'protagonist',
        state: {}, items: [], relations: [], facts: [], skills: [], abilities: [],
    };
    state.meta.protagonistId = 'su';
    normalizeState(state);
    assert.equal(state.meta.protagonistId, 'user');
    assert.equal(characterAccess(state.characters.su), 'public');
});

test('reveal 目标写错名字时拒绝，不新建角色', () => {
    const state = tierState();
    state.facts.f1 = { id: 'f1', text: '你藏着玉牌', access: 'protagonist', keywords: [], history: [] };
    const result = run(state, [
        { op: 'reveal', fact: 'f1', to: '苏婉', evidence: 'msg:0', confidence: 0.9 },
    ]);
    assert.equal(entityAccess(result.state.facts.f1), 'protagonist');
    assert.ok(!Object.values(result.state.characters).some((character) => character.name === '苏婉'));
    assert.ok(result.rejected.some((item) => /找不到角色/.test(item.reason)));
});

test('有 user 时，NPC 从 tier main 降级时保留朋友档位', () => {
    const state = createEmptyState();
    state.characters.user = {
        id: 'user', name: '你', tier: 'main', access: 'protagonist',
        state: {}, items: [], relations: [], facts: [], skills: [], abilities: [],
    };
    state.characters.su = {
        id: 'su', name: '苏绾', tier: 'main', access: 'friend',
        state: {}, items: [], relations: [], facts: [], skills: [], abilities: [],
    };
    normalizeState(state);
    assert.equal(state.characters.su.tier, 'major');
    assert.equal(characterAccess(state.characters.su), 'friend');
});

test('没有 user 且出现多个 tier main 时，没有角色拿到主角级', () => {
    const state = createEmptyState();
    for (const id of ['a', 'b']) {
        state.characters[id] = {
            id, name: id, tier: 'main', access: 'protagonist',
            state: {}, items: [], relations: [], facts: [], skills: [], abilities: [],
        };
    }
    normalizeState(state);
    assert.equal(characterAccess(state.characters.a), 'public');
    assert.equal(characterAccess(state.characters.b), 'public');
    assert.equal(state.characters.a.tier, 'major');
});

test('未了结条目上的怀疑与误信会注入', () => {
    const state = tierState();
    state.facts.f_thread = {
        id: 'f_thread',
        text: '柳三娘托你查账',
        access: 'public',
        thread_status: 'open',
        thread_type: '人情',
        beliefs: {
            su: { state: 'suspects', suspicion: '账本被人换过' },
            wang: { state: 'false_belief', belief: '你已经查完了' },
        },
    };
    for (const gate of [true, false]) {
        const text = assembleInjection(state, { activeCharacterIds: ['user', 'su'], protagonistId: 'user', knowledgeGate: gate });
        assert.match(text, /苏绾怀疑「账本被人换过」/);
        assert.match(text, /王掌柜误以为「你已经查完了」/);
    }
});

test('事件上的怀疑与误信会注入', () => {
    const state = tierState();
    state.events.push({
        id: 'e1',
        day: 1,
        place: '客栈',
        problem: '账本失踪',
        decision: '暗中查访',
        result: '没有找到',
        importance: 'major',
        actors: ['user'],
        beliefs: { su: { state: 'suspects', suspicion: '你动过账本' } },
    });
    const text = assembleInjection(state, { activeCharacterIds: ['user'], protagonistId: 'user' });
    assert.match(text, /苏绾怀疑「你动过账本」/);
});

test('条目超过上限时，正文提到的物品优先保留', () => {
    const state = tierState();
    for (let i = 0; i < 20; i += 1) {
        state.characters.user.items.push({
            id: `i_${i}`, name: `杂物${i}`, quantity: 1, kind: 'item', validFrom: '', validTo: null,
        });
    }
    const plain = assembleInjection(state, { activeCharacterIds: ['user'], protagonistId: 'user' });
    assert.doesNotMatch(plain, /杂物19/);

    const recalled = assembleInjection(state, {
        activeCharacterIds: ['user'],
        protagonistId: 'user',
        recentText: '你翻出杂物19看了看',
    });
    assert.match(recalled, /杂物19/);
});

test('泄露检测覆盖物品、功法与字段，且没有在场记录时扫全部 NPC', () => {
    const state = tierState();
    state.characters.user.state.realm = { current: '筑基九层', history: [], access: 'protagonist' };
    state.characters.user.items.push({
        id: 'i_jade', name: '残缺符文的玉牌', kind: 'item', access: 'protagonist', validFrom: '', validTo: null,
    });
    state.characters.user.skills.push({
        id: 'sk_devour', name: '噬灵诀', access: 'protagonist', validFrom: '', validTo: null, history: [],
    });
    const text = '城卫盯着你袖口的残缺玉牌，忽然说：“筑基九层？还会噬灵诀？”';
    const leaks = detectLeaks(state, text, ['wang']);
    assert.ok(leaks.some((leak) => leak.target?.item === '残缺符文的玉牌'));
    assert.ok(leaks.some((leak) => leak.target?.skill === '噬灵诀'));
    assert.ok(leaks.some((leak) => leak.target?.field === 'realm' && leak.target?.character === 'user'));

    const automatic = detectLeaks(state, text, []);
    assert.ok(automatic.some((leak) => leak.character === 'su'));
    assert.ok(automatic.every((leak) => leak.character !== 'user'));
});
