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
    detectLeaks,
    buildExtractionPrompt,
    selectSettleMessages,
    collectAssistantText,
    messageHash,
    detectAnchorMutation,
    reanchorWindow,
    computePrefixHashes,
    findReplayPoint,
    replayHistory,
    healthCheck,
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
    state.characters.user = { id: 'user', name: '你', tier: 'main', access: 'protagonist', state: {}, items: [], relations: [], skills: [], abilities: [] };
    state.characters.su = { id: 'su', name: '苏绾', tier: 'major', access: 'friend', state: {}, items: [], relations: [], skills: [], abilities: [] };
    state.characters.wang = { id: 'wang', name: '王掌柜', tier: 'major', access: 'public', state: {}, items: [], relations: [], skills: [], abilities: [] };
    return state;
}

test('createEmptyState 结构完整', () => {
    const state = createEmptyState();
    assert.deepEqual(state.characters, {});
    assert.equal(state.scene.time, '');
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

test('set_relation 类型变化保留历史，称呼变化原地更新', () => {
    let state = createEmptyState();
    let result = run(state, [
        { op: 'set_relation', from: 'lin_yuan', to: 'su_wan', toName: '苏婉', type: '同门', address: '师妹', validFrom: 'ch02', evidence: 'msg:3', confidence: 0.9 },
    ]);
    state = result.state;
    result = run(state, [
        { op: 'set_relation', from: 'lin_yuan', to: 'su_wan', toName: '苏婉', type: '同门', address: '师姐', validFrom: 'ch10', evidence: 'msg:60', confidence: 0.9 },
    ]);
    state = result.state;
    assert.equal(state.characters.lin_yuan.relations.length, 1);
    assert.equal(state.characters.lin_yuan.relations[0].address, '师姐');

    result = run(state, [
        { op: 'set_relation', from: 'lin_yuan', to: 'su_wan', toName: '苏婉', type: '仇敌', validFrom: 'ch20', evidence: 'msg:120', confidence: 0.9 },
    ]);
    state = result.state;
    const relations = state.characters.lin_yuan.relations;
    assert.equal(relations.length, 2);
    assert.equal(relations[0].type, '同门');
    assert.equal(relations[0].validTo, 'ch20');
    assert.equal(relations[1].type, '仇敌');
    assert.equal(relations[1].validTo, null);
});

test('reveal 放宽档位', () => {
    let state = createEmptyState();
    state.characters.su_wan = {
        id: 'su_wan', name: '苏婉', tier: 'npc', access: 'friend',
        state: {}, items: [], relations: [], skills: [], abilities: [],
    };
    let result = run(state, [
        { op: 'add_item', character: 'user', item: { name: '混沌珠', kind: 'artifact', access: 'protagonist' }, evidence: 'msg:10', confidence: 0.95 },
    ]);
    state = result.state;
    result = run(state, [
        { op: 'reveal', item: '混沌珠', to: '苏婉', by: '林远', method: '战斗中被迫使用', evidence: 'msg:92', confidence: 0.95 },
    ]);
    state = result.state;

    const item = state.characters.user.items.find((entry) => entry.name === '混沌珠');
    assert.equal(entityAccess(item), 'friend');
    assert.ok((result.changedOps || []).some((op) => op.op === 'reveal'));
});

test('被动暴露给公开级目击者不降档，显式当众公开才降档', () => {
    let state = createEmptyState();
    state.characters.user = {
        id: 'user', name: '你', tier: 'main', access: 'protagonist',
        state: {}, items: [], relations: [], skills: [], abilities: [],
    };
    state.characters.zhao = {
        id: 'zhao', name: '赵长老', tier: 'major', access: 'public',
        state: {}, items: [], relations: [], skills: [], abilities: [],
    };
    state.characters.user.items.push({
        id: 'i_jade', name: '玉牌', kind: 'artifact', quantity: 1, unit: '', holder: 'user',
        validFrom: '', validTo: null, access: 'protagonist',
    });

    let result = run(state, [
        { op: 'reveal', item: '玉牌', to: 'zhao', method: '被他看见', evidence: 'msg:1', confidence: 0.9 },
    ]);
    assert.equal(entityAccess(result.state.characters.user.items[0]), 'protagonist');

    result = run(result.state, [
        { op: 'reveal', item: '玉牌', to: 'zhao', method: '被他看见', passive: true, evidence: 'msg:2', confidence: 0.9 },
    ]);
    assert.equal(entityAccess(result.state.characters.user.items[0]), 'protagonist');

    result = run(result.state, [
        { op: 'reveal', item: '玉牌', to: 'zhao', method: '当众承认', access: 'public', evidence: 'msg:3', confidence: 0.9 },
    ]);
    assert.equal(entityAccess(result.state.characters.user.items[0]), 'public');
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

test('预算收紧时优先保留秘密认知', () => {
    const state = createEmptyState();
    state.characters.lin_yuan = {
        id: 'lin_yuan', name: '林远', tier: 'main',
        state: { realm: { current: '筑基一层', history: [] } },
        items: [{
            id: 'i_orb', name: '混沌珠', kind: 'artifact', quantity: 1, unit: '', holder: 'lin_yuan',
            validFrom: '', validTo: null, access: 'protagonist',
        }],
        skills: [], relations: [],
    };
    state.characters.su_wan = {
        id: 'su_wan', name: '苏婉', tier: 'major', state: {}, items: [], skills: [], relations: [],
    };
    state.meta.protagonistId = 'lin_yuan';
    state.scene = { time: '第三日 夜', place: '客栈', participants: ['lin_yuan', 'su_wan'] };

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

test('validateOps 容错 evidence 写法 msg:#0 与 msg:2,3', () => {
    const state = createEmptyState();
    const result = validateOps([
        { op: 'set', character: 'a', field: 'realm', value: 'x', evidence: 'msg:#0', confidence: 0.9 },
        { op: 'set', character: 'a', field: 'realm', value: 'y', evidence: 'msg:2,3', confidence: 0.9 },
        { op: 'set', character: 'a', field: 'realm', value: 'z', evidence: 'msg:4, msg:12', confidence: 0.9 },
    ], state, { confidenceThreshold: 0.7, reviewThreshold: 0.5, messageCount: 20 });
    assert.equal(result.accepted.length, 3);
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

test('assembleInjection 包含主角色与秘密知情', () => {
    let state = createEmptyState();
    state.scene = { time: '夜', place: '黑风寨', participants: ['lin_yuan', 'su_wan'] };
    state.characters.lin_yuan = { id: 'lin_yuan', name: '林远', tier: 'main', state: {}, items: [], relations: [] };
    let result = run(state, [
        { op: 'set', character: 'lin_yuan', name: '林远', field: 'realm', value: '炼气七层', validFrom: 'ch12', evidence: 'msg:87', confidence: 0.9 },
        { op: 'add_item', character: 'lin_yuan', name: '林远', item: { id: 'i_sword', name: '青锋剑' }, validFrom: 'ch03', evidence: 'msg:2', confidence: 0.9 },
        { op: 'add_item', character: 'lin_yuan', name: '林远', item: { id: 'i_orb', name: '混沌珠', access: 'protagonist' }, evidence: 'msg:10', confidence: 0.95 },
    ]);
    state = result.state;
    state.meta.protagonistId = 'lin_yuan';
    state.characters.su_wan = { id: 'su_wan', name: '苏婉', tier: 'minor', state: {}, items: [], relations: [] };

    const text = assembleInjection(state, { tokenBudget: 3000, knowledgeGate: true, recentText: '苏婉看着林远', protagonistId: 'lin_yuan' });
    assert.match(text, /林远/);
    assert.match(text, /炼气七层/);
    assert.match(text, /青锋剑/);
    assert.match(text, /秘密知情/);
    assert.match(text, /混沌珠 ｜ 主角级；只有你知道/);
});

test('parseExtractionResponse 支持代码围栏', () => {
    const data = parseExtractionResponse('```json\n{"scene":{"time":"ch01"},"ops":[],"leaks":[]}\n```');
    assert.equal(data.scene.time, 'ch01');
    assert.deepEqual(data.ops, []);
});

test('detectLeaks 标记档位不够却被提到的秘密', () => {
    const state = createEmptyState();
    state.characters = {
        user: {
            id: 'user', name: '你', tier: 'main', access: 'protagonist',
            state: {},
            items: [{ id: 'i_orb', name: '混沌珠', kind: 'artifact', quantity: 1, unit: '', holder: 'user', validFrom: '', validTo: null, access: 'protagonist' }],
            relations: [], skills: [], abilities: [],
        },
        su_wan: { id: 'su_wan', name: '苏婉', tier: 'major', access: 'public', state: {}, items: [], relations: [], skills: [], abilities: [] },
    };
    const leaks = detectLeaks(state, '苏婉盯着你的袖口：“混沌珠？你藏着什么？”', ['user', 'su_wan']);
    assert.equal(leaks.length, 1);
    assert.equal(leaks[0].character, 'su_wan');
    assert.equal(leaks[0].label, '混沌珠');
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
    state.characters.su_wan = { id: 'su_wan', name: '苏婉', tier: 'major', state: {}, items: [], relations: [] };

    const text = assembleInjection(state, { tokenBudget: 3000, activeCharacterIds: ['lin_yuan', 'su_wan'], protagonistId: 'lin_yuan' });
    const blockStart = text.indexOf('【角色·林远】');
    const blockEnd = text.indexOf('【秘密知情】', blockStart);
    const publicBlock = text.slice(blockStart, blockEnd);

    assert.match(publicBlock, /location：青云宗/);
    assert.doesNotMatch(publicBlock, /realm：筑基一层/);
    assert.match(text, /- 林远 · realm：筑基一层 ｜ 主角级；只有你知道/);
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

test('reveal 支持字段/物品/关系', () => {
    let state = createEmptyState();
    state.characters.lin_yuan = { id: 'lin_yuan', name: '林远', tier: 'main', access: 'protagonist', state: {}, items: [], relations: [] };
    state.characters.su_wan = { id: 'su_wan', name: '苏婉', tier: 'major', access: 'public', state: {}, items: [], relations: [] };
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
        { op: 'set_relation', from: 'lin_yuan', to: 'su_wan', toName: '苏婉', type: '秘密同盟', access: 'protagonist', validFrom: 'ch05', evidence: 'msg:3', confidence: 0.9 },
    ]);
    state = result.state;

    result = run(state, [
        { op: 'set_tier', character: 'su_wan', access: 'friend', reason: '共同守密', evidence: 'msg:4', confidence: 0.95 },
        { op: 'reveal', to: 'su_wan', by: 'lin_yuan', method: '战斗中暴露', character: 'lin_yuan', field: 'realm', validFrom: 'ch13', evidence: 'msg:4', confidence: 0.95 },
        { op: 'reveal', to: 'su_wan', by: 'lin_yuan', method: '被看见', item: 'i_orb', validFrom: 'ch13', evidence: 'msg:5', confidence: 0.95 },
        { op: 'reveal', to: 'su_wan', by: 'lin_yuan', method: '被迫承认', relation: 'su_wan', validFrom: 'ch13', evidence: 'msg:6', confidence: 0.95 },
    ]);
    state = result.state;

    const targets = [
        state.characters.lin_yuan.state.realm,
        state.characters.lin_yuan.items[0],
        state.characters.lin_yuan.relations[0],
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
    const text = assembleInjection(state, { tokenBudget: 3000, activeCharacterIds: ['lin_yuan'], protagonistId: 'lin_yuan' });
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

    result = run(state, [
        { op: 'set_item_quantity', item: 'i_spirit', quantity: 7, reason: '重新获得', validFrom: 'ch05', evidence: 'msg:7', confidence: 0.9 },
    ]);
    state = result.state;
    const set = state.characters.lin_yuan.items.find((entry) => entry.id === 'i_spirit' && entry.validTo == null);
    assert.equal(set.quantity, 7);
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
    state.meta.protagonistId = 'lin_yuan';
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
    state.meta.protagonistId = 'lin_yuan';
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
    state.meta.protagonistId = 'lin_yuan';
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
    state.meta.protagonistId = 'lin_yuan';
    const result = run(state, [
        { op: 'add_skill', character: 'lin_yuan', characterName: '林远', skill: { id: 'sk_a', name: '青木诀', level: '第三重' }, validFrom: '第一日 晨', evidence: 'msg:1', confidence: 0.9 },
        { op: 'add_ability', character: 'lin_yuan', ability: { id: 'ab_a', name: '御风诀', level: '入门', access: 'public' }, validFrom: '第一日 晨', evidence: 'msg:2', confidence: 0.9 },
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
    state.meta.protagonistId = 'lin_yuan';
    const result = run(state, [
        { op: 'add_ability', character: 'lin_yuan', characterName: '林远', ability: { id: 'ab_feng', name: '御风诀', level: '入门', access: 'protagonist' }, validFrom: '第一日 晨', evidence: 'msg:1', confidence: 0.9 },
        { op: 'add_ability', character: 'lin_yuan', ability: { id: 'ab_jian', name: '裂空剑', level: '小成', access: 'public' }, validFrom: '第一日 晨', evidence: 'msg:2', confidence: 0.9 },
    ]);
    state = result.state;
    state.characters.lin_yuan.tier = 'main';
    state.characters.su_wan = {
        id: 'su_wan', name: '苏婉', tier: 'npc', access: 'public',
        state: {}, items: [], relations: [], skills: [], abilities: [],
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

test('主角神通默认主角级', () => {
    const result = run(createEmptyState(), [
        { op: 'add_ability', character: 'user', ability: { id: 'ab_a', name: '噬灵诀' }, evidence: 'msg:0', confidence: 0.9 },
    ]);
    assert.equal(entityAccess(result.state.characters.user.abilities[0]), 'protagonist');
});

test('代码层拒绝给 NPC 建功法或神通', () => {
    const result = run(createEmptyState(), [
        { op: 'add_skill', character: '苏婉', skill: { id: 'sk_a', name: '剑诀' }, evidence: 'msg:0', confidence: 0.9 },
        { op: 'add_ability', character: '苏婉', ability: { id: 'ab_a', name: '剑诀' }, evidence: 'msg:0', confidence: 0.9 },
    ]);
    assert.equal(findCharacter(result.state, '苏婉')?.skills?.length ?? 0, 0);
    assert.equal(findCharacter(result.state, '苏婉')?.abilities?.length ?? 0, 0);
    assert.equal(result.rejected.filter((item) => /NPC 不单独建功法或神通档案/.test(item.reason)).length, 2);
});

test('提取提示严格限制神通的添加来源', () => {
    const { system } = buildExtractionPrompt(createEmptyState(), []);
    assert.match(system, /只有两种情况写 add_ability/);
    assert.match(system, /主角自己给招式起名/);
    assert.match(system, /正文明确写主角学到、习得或得到某门神通/);
    assert.match(system, /新神通默认 access:"protagonist"/);
    assert.match(system, /NPC 只保留最小档案/);
    assert.match(system, /不要给 NPC 单独建功法、神通、物品或秘密档案/);
});

test('秘密功法可以用 set_skill 改档，并用 reveal 放宽', () => {
    let state = createEmptyState();
    state.meta.protagonistId = 'lin_yuan';
    state = run(state, [
        { op: 'add_skill', character: 'lin_yuan', characterName: '林远', skill: { id: 'sk_sword', name: '御剑术', level: '入门' }, validFrom: '第一日 晨', evidence: 'msg:1', confidence: 0.9 },
        { op: 'set_skill', skill: 'sk_sword', access: 'protagonist', validFrom: '第二日 晨', evidence: 'msg:2', confidence: 0.9 },
    ]).state;
    state.characters.lin_yuan.tier = 'main';
    state.characters.su_wan = {
        id: 'su_wan', name: '苏婉', tier: 'npc', access: 'friend',
        state: {}, items: [], relations: [], skills: [], abilities: [],
    };
    state = run(state, [
        { op: 'reveal', skill: 'sk_sword', to: 'su_wan', by: 'lin_yuan', method: '当面运功', validFrom: '第三日 晨', evidence: 'msg:3', confidence: 0.9 },
    ]).state;
    const skill = state.characters.lin_yuan.skills.find((entry) => entry.id === 'sk_sword');
    assert.equal(entityAccess(skill), 'friend');
    assert.equal(knowsEntity(skill, 'su_wan', state), true);
});

test('重记秘密功法保档位，物品转手跟着持有人放宽', () => {
    let state = createEmptyState();
    state.meta.protagonistId = 'lin_yuan';
    state.characters.lin_yuan = { id: 'lin_yuan', name: '林远', tier: 'main', state: {}, items: [], relations: [], skills: [], abilities: [] };
    state.characters.su_wan = { id: 'su_wan', name: '苏婉', tier: 'npc', access: 'friend', state: {}, items: [], relations: [], skills: [], abilities: [] };
    state.characters.wang_shi = { id: 'wang_shi', name: '王掌柜', tier: 'npc', access: 'intimate', state: {}, items: [], relations: [], skills: [], abilities: [] };
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
        id: 'lin_yuan', name: '林远', tier: 'main', state: {}, items: [], skills: [], relations: [],
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
        items: [], skills: [], relations: [],
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
    };
    state.characters.wang = {
        id: 'wang', name: '王掌柜', tier: 'major', state: {}, items: [], skills: [], relations: [],
    };
    state.scene = { time: '夜', place: '客栈', participants: ['lin_yuan', 'wang'] };

    const text = assembleInjection(state, {
        tokenBudget: 3000,
        activeCharacterIds: ['lin_yuan', 'wang'],
        protagonistId: 'lin_yuan',
    });
    const blockStart = text.indexOf('【角色·林远】');
    const blockEnd = text.indexOf('【秘密知情】', blockStart);
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
    assert.match(user, /add_item \{character,item:/);
    assert.doesNotMatch(user, /add_fact/);
    assert.doesNotMatch(user, /append_event/);
});

test('提取提示的当前台账带上角色字段与档位', () => {
    const state = createEmptyState();
    state.characters.user = {
        id: 'user', name: '你', tier: 'main', access: 'protagonist',
        state: { realm: { current: '筑基一层', history: [], access: 'protagonist' } },
        items: [], relations: [], skills: [], abilities: [],
    };
    const { user } = buildExtractionPrompt(state, []);
    assert.match(user, /realm/);
    assert.match(user, /筑基一层/);
});

test('提取提示的当前台账带上角色别名', () => {
    const state = createEmptyState();
    state.characters.su = {
        id: 'su', name: '苏绾', aliases: ['月白长裙女修'], tier: 'major', access: 'friend',
        state: {}, items: [], relations: [], skills: [], abilities: [],
    };
    const { user } = buildExtractionPrompt(state, []);
    assert.match(user, /月白长裙女修/);
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
        { op: 'set_relation', from: '苏婉', to: 'user', type: '同门', address: '师兄', evidence: 'msg:1', confidence: 0.9 },
    ]);
    const relation = findCharacter(result.state, '苏婉').relations[0];
    assert.equal(relation.address, '师兄');
    assert.equal(relation.target, 'user');
    assert.equal(relation.targetName, '你');
    assert.deepEqual(result.state.characters.user.aliases, []);
});

test('只改称呼时原地更新关系，不新增版本', () => {
    let state = run(createEmptyState(), [
        { op: 'set_relation', from: '苏婉', to: 'user', type: '同门', address: '师兄', evidence: 'msg:1', confidence: 0.9 },
    ]).state;
    state = run(state, [
        { op: 'set_relation', from: '苏婉', to: 'user', type: '同门', address: '道友', evidence: 'msg:9', confidence: 0.9 },
    ]).state;

    const relations = findCharacter(state, '苏婉').relations;
    assert.equal(relations.length, 1);
    assert.equal(relations[0].address, '道友');
    assert.equal(relations[0].validTo, null);
});

test('态度不再记账，类型不变时原地更新', () => {
    let state = run(createEmptyState(), [
        { op: 'set_relation', from: 'user', to: '苏婉', type: '同门', attitude: '试探', address: '师妹', evidence: 'msg:1', confidence: 0.9 },
    ]).state;
    state = run(state, [
        { op: 'set_relation', from: 'user', to: '苏婉', type: '同门', attitude: '信任', evidence: 'msg:20', confidence: 0.9 },
    ]).state;

    const relations = state.characters.user.relations;
    assert.equal(relations.length, 1);
    assert.equal(relations[0].attitude, undefined);
    assert.equal(relations[0].address, '师妹');
});

test('关系类型变化才新增版本，称呼不跨类型继承', () => {
    let state = run(createEmptyState(), [
        { op: 'set_relation', from: 'user', to: '苏婉', type: '同门', address: '师妹', evidence: 'msg:1', confidence: 0.9 },
    ]).state;
    state = run(state, [
        { op: 'set_relation', from: 'user', to: '苏婉', type: '仇敌', evidence: 'msg:20', confidence: 0.9 },
    ]).state;
    const relations = state.characters.user.relations;
    assert.equal(relations.length, 2);
    assert.notEqual(relations[0].validTo, null);
    assert.equal(relations[1].type, '仇敌');
    assert.equal(relations[1].address, '');
});

test('assembleInjection 渲染关系称呼', () => {
    let state = run(createEmptyState(), [
        { op: 'set_relation', from: 'user', to: '苏婉', type: '同门', address: '师妹', evidence: 'msg:1', confidence: 0.9 },
    ]).state;
    state.scene = { time: '夜', place: '客栈', participants: ['user', '苏婉'] };
    const text = assembleInjection(state, {
        tokenBudget: 3000,
        activeCharacterIds: ['user', '苏婉'],
        protagonistId: 'user',
    });
    assert.match(text, /苏婉\(同门，称「师妹」\)/);
    assert.doesNotMatch(text, /态度|亲近/);
});

test('主角姓名优先用台账，其次 persona，且排在字段第一位', () => {
    const fieldLabels = getGenrePreset('xianxia').fieldLabels;
    let state = run(createEmptyState(), [
        { op: 'set', character: 'user', field: 'realm', value: '练气一层', evidence: 'msg:0', confidence: 0.9 },
    ]).state;
    state.scene = { time: '晨', place: '广场', participants: ['user'] };
    const withPersona = assembleInjection(state, {
        tokenBudget: 3000,
        protagonistId: 'user',
        protagonistName: '林远',
        fieldLabels,
    });
    assert.match(withPersona, /【角色·你】主角\n姓名：林远 \| 境界：练气一层/);

    // 台账里记过姓名时优先用台账，persona 不再覆盖。
    state.characters.user.state.name = { current: '林小远', history: [], access: 'public' };
    const recorded = assembleInjection(state, {
        tokenBudget: 3000,
        protagonistId: 'user',
        protagonistName: '林远',
        fieldLabels,
    });
    assert.match(recorded, /姓名：林小远/);
    assert.doesNotMatch(recorded, /姓名：林远/);
});

test('酒馆默认 persona 占位名不会被当成姓名注入', () => {
    const state = run(createEmptyState(), [
        { op: 'set', character: 'user', field: 'realm', value: '练气一层', evidence: 'msg:0', confidence: 0.9 },
    ]).state;
    state.scene = { time: '晨', place: '广场', participants: ['user'] };
    for (const name of ['User', 'user', '你', '玩家', '']) {
        const text = assembleInjection(state, {
            tokenBudget: 3000,
            protagonistId: 'user',
            protagonistName: name,
        });
        assert.doesNotMatch(text, /姓名：/, name);
    }
});

test('注入头部声明在场不等于知情', () => {
    const state = createEmptyState();
    const text = assembleInjection(state, { protagonistId: 'user' });
    assert.match(text, /在场、看到，不等于知情/);
    assert.match(text, /反复提到某条秘密，也不等于它已经公开/);
});

test('suspects 渲染具体怀疑内容', () => {
    let state = run(createEmptyState(), [
        { op: 'set', character: 'user', field: 'gender', value: '未知', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: '顾行舟', field: 'gender', value: '男', evidence: 'msg:0', confidence: 0.9 },
        { op: 'add_skill', character: 'user', skill: { name: '噬灵诀', type: 'technique', access: 'protagonist' }, evidence: 'msg:0', confidence: 0.9 },
        { op: 'reveal', skill: '噬灵诀', to: '顾行舟', suspicion: '你在偷练魔功', method: '暗中观察', evidence: 'msg:0', confidence: 0.9 },
    ]).state;
    state.scene = { time: '夜', place: '客栈', participants: ['user', '顾行舟'] };
    const text = assembleInjection(state, {
        activeCharacterIds: ['user', '顾行舟'],
        protagonistId: 'user',
    });
    assert.match(text, /顾行舟怀疑「你在偷练魔功」/);
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
    };
    state.scene = { time: '夜', place: '客栈', participants: ['user', '王掌柜'] };
    state.characters.wang_shop.access = 'friend';
    const active = assembleInjection(state, { activeCharacterIds: ['user', '王掌柜'], protagonistId: 'user' });
    assert.match(active, /identity：家族旧部（知情：你、王掌柜）/);

    state.scene = { time: '夜', place: '客栈', participants: ['user'] };
    const roster = assembleInjection(state, { activeCharacterIds: ['user'], protagonistId: 'user' });
    assert.match(roster, /王掌柜/);
    assert.doesNotMatch(roster, /家族旧部/);
});

test('提取提示词要求把称谓写进 address', () => {
    const { system } = buildExtractionPrompt(createEmptyState(), []);
    assert.match(system, /address/);
    assert.match(system, /称呼不是名字/);
});

test('提取提示词覆盖档位写法与 set_tier', () => {
    const { system, user } = buildExtractionPrompt(createEmptyState(), [], {});
    assert.match(system, /access:"protagonist"/);
    assert.match(system, /set_tier/);
    assert.match(system, /知情由角色档位 ≥ 条目档位决定/);
    assert.match(system, /定档顺序/);
    assert.match(user, /set_tier \{character,access,reason\}/);
    assert.doesNotMatch(user, /add_fact/);
    assert.doesNotMatch(system, /knownBy/);
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
        state: {}, items: [], relations: [], skills: [], abilities: [],
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
        state: {}, items: [], relations: [], skills: [], abilities: [],
    };
    state.characters.npc_001 = {
        id: 'npc_001', name: '苏绾', tier: 'major', access: 'friend',
        state: {}, items: [], relations: [], skills: [], abilities: [],
    };
    state.characters.user.relations.push({
        target: 'npc_001', targetName: '苏绾', type: '同门',
        validFrom: '', validTo: null, access: 'friend',
    });
    state.meta.protagonistId = 'user';
    state.scene = { time: '夜', day: 1, place: '客栈', participants: ['user', 'npc_001'] };
    const { user } = buildExtractionPrompt(state, [{ index: 0, isUser: false, mes: '夜。' }], { newFrom: 0 });
    assert.doesNotMatch(user, /npc_001/);
    assert.match(user, /"苏绾"/);
    assert.match(user, /"participants":\["你","苏绾"\]/);
});

test('改名后其他角色的 targetName 跟着更新', () => {
    const state = run(createEmptyState(), [
        { op: 'set_relation', from: 'user', to: '乙', toName: '乙', type: '同门', evidence: 'msg:0', confidence: 0.9 },
        { op: 'rename_character', from: '乙', to: '丙', evidence: 'msg:1', confidence: 0.9 },
    ]).state;
    assert.equal(state.characters.user.relations[0].targetName, '丙');
});

test('move_item 找不到物品时拒绝，不凭空创建物品', () => {
    const result = run(createEmptyState(), [
        { op: 'move_item', item: 'i_nope', to: '甲', evidence: 'msg:0', confidence: 0.9 },
    ]);
    const items = Object.values(result.state.characters).flatMap((character) => character.items || []);
    assert.equal(items.length, 0);
    assert.ok(result.rejected.some((item) => /找不到物品/.test(item.reason)));
});

test('默认档位与非法档位：物品公开级，写错按主角级', () => {
    const state = run(createEmptyState(), [
        { op: 'add_item', character: 'user', item: { id: 'i1', name: '普通物品' }, evidence: 'msg:0', confidence: 0.9 },
        { op: 'add_item', character: 'user', item: { id: 'i2', name: '写错档位', access: 'secret' }, evidence: 'msg:0', confidence: 0.9 },
    ]).state;
    assert.equal(entityAccess(state.characters.user.items.find((item) => item.id === 'i1')), 'public');
    assert.equal(entityAccess(state.characters.user.items.find((item) => item.id === 'i2')), 'protagonist');
});

test('预算极紧时整段裁剪，秘密块仍保留', () => {
    const state = run(createEmptyState(), [
        { op: 'add_item', character: 'user', item: { id: 'i_jade', name: '青玉牌', access: 'protagonist' }, evidence: 'msg:0', confidence: 0.9 },
    ]).state;
    const text = assembleInjection(state, { tokenBudget: 40 });
    assert.match(text, /青玉牌/);
});

test('注入把知情写成正文优先，并给出台账默认', () => {
    const state = createEmptyState();
    state.characters.user = { id: 'user', name: '你', tier: 'main', access: 'protagonist', state: {}, items: [], relations: [], skills: [], abilities: [] };
    state.characters.su = { id: 'su', name: '苏绾', tier: 'major', access: 'friend', state: {}, items: [], relations: [], skills: [], abilities: [] };
    state.characters.wang = { id: 'wang', name: '王掌柜', tier: 'major', access: 'public', state: {}, items: [], relations: [], skills: [], abilities: [] };
    state.characters.user.items.push({
        id: 'i_jade', name: '玉牌', kind: 'artifact', quantity: 1, unit: '', holder: 'user',
        validFrom: '', validTo: null, access: 'friend',
    });
    state.meta.protagonistId = 'user';
    state.scene = { time: '夜', day: 1, place: '客栈', participants: ['user', 'su', 'wang'] };
    const text = assembleInjection(state, { tokenBudget: 3000, activeCharacterIds: ['user', 'su', 'wang'] });
    assert.match(text, /先看正文/);
    assert.match(text, /不要用台账反驳正文/);
    assert.match(text, /默认知情=苏绾/);
    assert.match(text, /默认不知情=王掌柜/);
    assert.match(text, /以下是角色与世界的真相，只用于判断谁知道/);
    assert.match(text, /在场、看到，不等于知情/);
});

test('提取提示要求正文明确写才知道', () => {
    const { system } = buildExtractionPrompt(createEmptyState(), []);
    assert.match(system, /主动告知、主动展示、明确承认 → reveal/);
    assert.match(system, /把档位放宽到该人的档位/);
    assert.match(system, /被动被看见或偷听：不要 reveal/);
    assert.match(system, /正文没写某人知道\/不知道时/);
    assert.match(system, /不要因为他在场、看到或沉默就推断/);
});

test('提取提示默认不公开主角的灵根和体质', () => {
    const { system } = buildExtractionPrompt(createEmptyState(), []);
    assert.match(system, /灵根、体质默认只有主角知道/);
    assert.match(system, /开场旁白交代给玩家的信息不等于在场 NPC 已知/);
    assert.match(system, /当众测灵、摸骨、神识扫过之后，才写 public/);
});

test('set_tier 给 NPC 定档，主角档位不可改', () => {
    const result = run(createEmptyState(), [
        { op: 'set_tier', character: '苏婉', access: 'intimate', reason: '主动托付', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set_tier', character: 'user', access: 'public', reason: '主动托付', evidence: 'msg:0', confidence: 0.9 },
    ]);
    assert.equal(characterAccess(findCharacter(result.state, '苏婉')), 'intimate');
    assert.equal(characterAccess(result.state.characters.user), 'protagonist');
});

test('档位变化需要连续同向证据', () => {
    const base = tierState();
    base.characters.su.access = 'public';
    base.scene.day = 1;
    const first = run(base, [
        { op: 'set_tier', character: '苏绾', access: 'friend', reason: '共同守密', evidence: 'msg:1', confidence: 0.9 },
    ], { tierVoteThreshold: 2 });
    assert.equal(characterAccess(first.state.characters.su), 'public');
    assert.equal(first.pendingOps.length, 1);
    assert.equal(first.pendingOps[0].pendingTier.count, 1);
    const second = run(first.state, [
        { op: 'set_tier', character: '苏绾', access: 'friend', reason: '共同守密', evidence: 'msg:2', confidence: 0.9 },
    ], { tierVoteThreshold: 2 });
    assert.equal(characterAccess(second.state.characters.su), 'friend');
    assert.equal(second.state.characters.su.accessPending, null);
});

test('档位待确认遇到不同目标就重置计数', () => {
    const base = tierState();
    base.scene.day = 1;
    const first = run(base, [
        { op: 'set_tier', character: '苏绾', access: 'intimate', reason: '主动托付', evidence: 'msg:1', confidence: 0.9 },
    ], { tierVoteThreshold: 2 });
    assert.equal(characterAccess(first.state.characters.su), 'friend');
    assert.equal(first.state.characters.su.accessPending.target, 'intimate');
    assert.equal(first.state.characters.su.accessPending.count, 1);
    const second = run(first.state, [
        { op: 'set_tier', character: '苏绾', access: 'public', reason: '泄密', evidence: 'msg:2', confidence: 0.9 },
    ], { tierVoteThreshold: 2 });
    assert.equal(characterAccess(second.state.characters.su), 'friend');
    assert.equal(second.state.characters.su.accessPending.target, 'public');
    assert.equal(second.state.characters.su.accessPending.count, 1);
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
        { op: 'set_tier', character: '苏绾', access: 'friend', reason: '共同守密', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set_tier', character: '苏绾', access: 'intimate', reason: '主动托付', evidence: 'msg:0', confidence: 0.9 },
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
        { op: 'set_tier', character: '苏绾', access: 'friend', reason: '背叛', evidence: 'msg:0', confidence: 0.9 },
    ]);
    assert.equal(characterAccess(result.state.characters.su), 'friend');
    assert.equal(result.state.characters.su.accessReason, '背叛');
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

test('提取提示词区分玩家内心与当众说出', () => {
    const { system } = buildExtractionPrompt(createEmptyState(), []);
    assert.match(system, /不等于当众说出/);
});

test('提取提示要求按正文双向记录知情（重复覆盖）', () => {
    const { system } = buildExtractionPrompt(createEmptyState(), []);
    assert.match(system, /主动告知、主动展示、明确承认 → reveal/);
    assert.match(system, /正文明确写某人不知道\/被瞒着/);
});

test('注入渲染 NPC 对玩家的称呼', () => {
    let state = run(createEmptyState(), [
        { op: 'set_relation', from: '苏婉', to: 'user', type: '同门', address: '师兄', evidence: 'msg:1', confidence: 0.9 },
    ]).state;
    state.scene = { time: '夜', place: '客栈', participants: ['user', '苏婉'] };
    const text = assembleInjection(state, {
        tokenBudget: 3000,
        activeCharacterIds: ['user', '苏婉'],
        protagonistId: 'user',
    });
    assert.match(text, /【角色·苏婉】[\s\S]*对玩家：同门，称「师兄」/);
});

test('parseExtractionResponse 容忍字符串里的裸换行', () => {
    const text = '{"ops":[{"op":"set","character":"user","field":"situation","value":"第一行\n第二行"}],"leaks":[]}';
    const data = parseExtractionResponse(text);
    assert.equal(data.ops[0].value, '第一行\n第二行');
});

test('parseExtractionResponse 容忍 op 提前闭合', () => {
    const text = '{"ops":[{"op":"add_item","character":"user","item":{"name":"x"}},"evidence":"msg:0","confidence":0.9}],"leaks":[]}';
    const data = parseExtractionResponse(text);
    assert.equal(data.ops[0].evidence, 'msg:0');
    assert.equal(data.ops[0].item.name, 'x');
});

test('重复抽取同一关系不新增版本', () => {
    let state = run(createEmptyState(), [
        { op: 'set_relation', from: '阿箬', to: 'user', type: '同门', address: '师叔', evidence: 'msg:1', confidence: 0.9 },
    ]).state;
    state = run(state, [
        { op: 'set_relation', from: '阿箬', to: 'user', type: '同门', address: '师叔', evidence: 'msg:9', confidence: 0.9 },
    ]).state;
    assert.equal(findCharacter(state, '阿箬').relations.length, 1);
});

test('changedOps 只记录真正变化的关系和档位', () => {
    const first = run(createEmptyState(), [
        { op: 'set_relation', from: '苏婉', to: 'user', type: '同门', address: '师兄', evidence: 'msg:1', confidence: 0.9 },
        { op: 'set_tier', character: '苏婉', access: 'friend', reason: '共同守密', evidence: 'msg:1', confidence: 0.9 },
    ]);
    assert.ok(first.changedOps.some((op) => op.op === 'set_relation'));
    assert.ok(first.changedOps.some((op) => op.op === 'set_tier'));
    const repeat = run(first.state, [
        { op: 'set_relation', from: '苏婉', to: 'user', type: '同门', address: '师兄', evidence: 'msg:2', confidence: 0.9 },
        { op: 'set_tier', character: '苏婉', access: 'friend', reason: '共同守密', evidence: 'msg:2', confidence: 0.9 },
    ]);
    assert.equal(repeat.changedOps.length, 0);
});

test('称呼只收短称呼，台词不写进 address', () => {
    const state = run(createEmptyState(), [
        { op: 'set_relation', from: '苏婉', to: 'user', type: '同门', address: '急什么', evidence: 'msg:1', confidence: 0.9 },
    ]).state;
    assert.equal(findCharacter(state, '苏婉').relations[0].address, '');
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

test('状态文本里的 user 归一化为「你」', () => {
    const result = run(createEmptyState(), [
        { op: 'set', character: 'user', field: 'situation', value: '效忠 user 的旧仆围在门外', evidence: 'msg:0', confidence: 0.9 },
    ]);
    assert.equal(result.state.characters.user.state.situation.current, '效忠 你 的旧仆围在门外');
});

test('代码层不收录 status 字段', () => {
    const result = run(createEmptyState(), [
        { op: 'set', character: 'user', field: 'status', value: '气血两亏', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: '王掌柜', field: 'status', value: '对你有侵略性好奇', evidence: 'msg:0', confidence: 0.9 },
    ]);
    assert.equal(result.state.characters.user.state.status, undefined);
    // 王掌柜只是被拒 op 带出来的名字，不该留下空档案。
    assert.equal(findCharacter(result.state, '王掌柜'), undefined);
    assert.equal(result.rejected.filter((item) => /不记录 status/.test(item.reason)).length, 2);
});

test('旧数据里的 status 字段在归一化时清掉', () => {
    const state = createEmptyState();
    state.characters.user = {
        id: 'user',
        name: '你',
        state: { status: { current: '气血两亏', history: [] } },
    };
    const result = run(state, []);
    assert.equal(result.state.characters.user.state.status, undefined);
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
    assert.match(text, /progress：30\/100（只有你知道）/);
    assert.doesNotMatch(text, /progress：60/);
});

test('progress 非数字被拒绝', () => {
    const result = run(createEmptyState(), [
        { op: 'set', character: 'user', field: 'progress', value: '练气三层', evidence: 'msg:0', confidence: 0.9 },
    ]);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.state.characters.user?.state?.progress, undefined);
});

test('progress 随正文更新，旧值保留历史', () => {
    let state = run(createEmptyState(), [
        { op: 'set', character: 'user', field: 'realm', value: '练气三层', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: 'user', field: 'progress', value: 43, validFrom: '第一日', evidence: 'msg:0', confidence: 0.9 },
    ]).state;
    state = run(state, [
        { op: 'set', character: 'user', field: 'progress', value: 60, validFrom: '第二日', evidence: 'msg:2', confidence: 0.9 },
    ]).state;

    const progress = state.characters.user.state.progress;
    assert.equal(progress.current, 60);
    assert.equal(progress.history.length, 2);
    assert.equal(progress.history[0].value, 43);
    assert.equal(progress.history[0].validTo, '第二日');
    assert.equal(progress.history[1].value, 60);
    assert.equal(progress.history[1].validTo, null);
});

test('重复写入相同进度不膨胀历史', () => {
    let state = run(createEmptyState(), [
        { op: 'set', character: 'user', field: 'progress', value: 30, evidence: 'msg:0', confidence: 0.9 },
    ]).state;
    const before = JSON.stringify(state.characters.user.state.progress);
    state = run(state, [
        { op: 'set', character: 'user', field: 'progress', value: '30%', evidence: 'msg:1', confidence: 0.9 },
    ]).state;
    assert.equal(JSON.stringify(state.characters.user.state.progress), before);
});

test('突破换境界且本轮没写进度时自动归零', () => {
    let state = run(createEmptyState(), [
        { op: 'set', character: 'user', field: 'realm', value: '练气大圆满', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: 'user', field: 'progress', value: 90, evidence: 'msg:0', confidence: 0.9 },
    ]).state;
    state = run(state, [
        { op: 'set', character: 'user', field: 'realm', value: '筑基初期', evidence: 'msg:1', confidence: 0.9 },
    ]).state;

    assert.equal(state.characters.user.state.realm.current, '筑基初期');
    assert.equal(state.characters.user.state.progress.current, 0);
});

test('同一轮写了进度就以写的为准，不强制归零', () => {
    let state = run(createEmptyState(), [
        { op: 'set', character: 'user', field: 'realm', value: '练气大圆满', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: 'user', field: 'progress', value: 90, evidence: 'msg:0', confidence: 0.9 },
    ]).state;
    state = run(state, [
        { op: 'set', character: 'user', field: 'realm', value: '筑基初期', evidence: 'msg:1', confidence: 0.9 },
        { op: 'set', character: 'user', field: 'progress', value: 5, evidence: 'msg:1', confidence: 0.9 },
    ]).state;

    assert.equal(state.characters.user.state.progress.current, 5);
});

test('回放同样执行跨境界归零，避免历史状态漂移', () => {
    const replayed = replayHistory([
        {
            to: 0,
            ops: [
                { op: 'set', character: '你', field: 'realm', value: '练气大圆满', evidence: 'msg:0', confidence: 0.9 },
                { op: 'set', character: '你', field: 'progress', value: 90, evidence: 'msg:0', confidence: 0.9 },
            ],
            characters: [{ id: 'user', name: '你', aliases: [] }],
        },
        {
            to: 1,
            ops: [
                { op: 'set', character: '你', field: 'realm', value: '筑基初期', evidence: 'msg:1', confidence: 0.9 },
            ],
        },
    ]);
    assert.equal(replayed.characters.user.state.realm.current, '筑基初期');
    assert.equal(replayed.characters.user.state.progress.current, 0);
});

// ---------------------------------------------------------------- 境界进度的对抗场景

function progressState() {
    return run(createEmptyState(), [
        { op: 'set', character: 'user', field: 'realm', value: '练气大圆满', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: 'user', field: 'progress', value: 90, evidence: 'msg:0', confidence: 0.9 },
        { op: 'set_tier', character: '苏绾', access: 'friend', reason: '共同守密', evidence: 'msg:0', confidence: 0.9 },
    ]).state;
}

test('对抗：先写进度再换境界，仍以模型写的进度为准', () => {
    let state = progressState();
    state = run(state, [
        { op: 'set', character: 'user', field: 'progress', value: 5, evidence: 'msg:1', confidence: 0.9 },
        { op: 'set', character: 'user', field: 'realm', value: '筑基初期', evidence: 'msg:1', confidence: 0.9 },
    ]).state;
    assert.equal(state.characters.user.state.progress.current, 5);
});

test('对抗：NPC 换境界不会清掉主角的进度', () => {
    let state = progressState();
    state = run(state, [
        { op: 'set', character: '苏绾', field: 'realm', value: '金丹初期', evidence: 'msg:1', confidence: 0.9 },
    ]).state;
    assert.equal(findCharacter(state, '苏绾').state.realm.current, '金丹初期');
    assert.equal(state.characters.user.state.progress.current, 90);
});

test('对抗：自定义主角换境界同样会归零', () => {
    const state = createEmptyState();
    state.characters.lin = {
        id: 'lin', name: '林远', tier: 'main', access: 'protagonist',
        state: {
            realm: { current: '练气大圆满', history: [], access: 'public' },
            progress: { current: 80, history: [], access: 'protagonist' },
        },
        items: [], relations: [], skills: [], abilities: [],
    };
    state.meta.protagonistId = 'lin';
    const result = run(state, [
        { op: 'set', character: '林远', field: 'realm', value: '筑基初期', evidence: 'msg:1', confidence: 0.9 },
    ]);
    assert.equal(result.state.characters.lin.state.progress.current, 0);
});

test('对抗：进度写成中文字段时不会多出第二份进度', () => {
    let state = progressState();
    state = run(state, [
        { op: 'set', character: 'user', field: 'realm', value: '筑基初期', evidence: 'msg:1', confidence: 0.9 },
        { op: 'set', character: 'user', field: '进度', value: 50, evidence: 'msg:1', confidence: 0.9 },
    ]).state;
    assert.deepEqual(Object.keys(state.characters.user.state).sort(), ['progress', 'realm']);
    assert.equal(state.characters.user.state.progress.current, 50);
});

test('对抗：境界只是多了空白，不触发归零', () => {
    let state = progressState();
    state = run(state, [
        { op: 'set', character: 'user', field: 'realm', value: ' 练气大圆满 ', evidence: 'msg:1', confidence: 0.9 },
    ]).state;
    assert.equal(state.characters.user.state.progress.current, 90);
});

test('对抗：进度已经是 0 时换境界不再新增历史', () => {
    let state = progressState();
    state = run(state, [
        { op: 'set', character: 'user', field: 'progress', value: 0, evidence: 'msg:1', confidence: 0.9 },
    ]).state;
    const before = state.characters.user.state.progress.history.length;
    state = run(state, [
        { op: 'set', character: 'user', field: 'realm', value: '筑基初期', evidence: 'msg:2', confidence: 0.9 },
    ]).state;
    assert.equal(state.characters.user.state.progress.current, 0);
    assert.equal(state.characters.user.state.progress.history.length, before);
});

test('对抗：非法进度被拒后换境界，仍然兜底归零', () => {
    let state = progressState();
    const result = run(state, [
        { op: 'set', character: 'user', field: 'realm', value: '筑基初期', evidence: 'msg:1', confidence: 0.9 },
        { op: 'set', character: 'user', field: 'progress', value: '练气三层', evidence: 'msg:1', confidence: 0.9 },
    ]);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.state.characters.user.state.progress.current, 0);
});

test('对抗：待复核的换境界不触发归零', () => {
    let state = progressState();
    const result = run(state, [
        { op: 'set', character: 'user', field: 'realm', value: '筑基初期', evidence: 'msg:1', confidence: 0.6 },
    ]);
    assert.equal(result.review.length, 1);
    assert.equal(result.state.characters.user.state.realm.current, '练气大圆满');
    assert.equal(result.state.characters.user.state.progress.current, 90);
});

test('对抗：归零保留原档位，并把旧进度关进历史', () => {
    let state = progressState();
    state = run(state, [
        { op: 'set', character: 'user', field: 'realm', value: '筑基初期', evidence: 'msg:1', confidence: 0.9 },
    ]).state;
    const progress = state.characters.user.state.progress;
    assert.equal(progress.current, 0);
    assert.equal(progress.access, 'protagonist');
    assert.equal(progress.history.length, 2);
    assert.equal(progress.history[0].value, 90);
    assert.notEqual(progress.history[0].validTo, null);
    assert.equal(progress.history[1].value, 0);
    assert.equal(progress.history[1].validTo, null);
});

test('对抗：同一轮连跨两个境界只补一条 0', () => {
    let state = progressState();
    state = run(state, [
        { op: 'set', character: 'user', field: 'realm', value: '筑基初期', evidence: 'msg:1', confidence: 0.9 },
        { op: 'set', character: 'user', field: 'realm', value: '金丹初期', evidence: 'msg:1', confidence: 0.9 },
    ]).state;
    const progress = state.characters.user.state.progress;
    assert.equal(progress.current, 0);
    assert.equal(progress.history.length, 2);
});

test('对抗：归零后的注入显示 0/100 且仍标为只有主角知道', () => {
    let state = progressState();
    state = run(state, [
        { op: 'set', character: 'user', field: 'realm', value: '筑基初期', evidence: 'msg:1', confidence: 0.9 },
    ]).state;
    const text = assembleInjection(state, { protagonistId: 'user', activeCharacterIds: ['user'] });
    assert.match(text, /progress：0\/100（只有你知道）/);
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
        { op: 'reveal', to: '老乞丐', character: 'user', field: 'realm', method: '当众承认', access: 'public', evidence: 'msg:0', confidence: 0.9 },
    ]);
    // 老乞丐是公开级；主动当众承认并显式写 access 才放宽到公开。
    assert.equal(entityAccess(result.state.characters.user.state.realm), 'public');
});

test('怀疑与不知情不会进知情名单', () => {
    const result = run(createEmptyState(), [
        { op: 'set', character: 'user', field: 'gender', value: '男', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: '苏婉', field: 'gender', value: '女', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: '王掌柜', field: 'gender', value: '男', evidence: 'msg:0', confidence: 0.9 },
        { op: 'add_skill', character: 'user', skill: { name: '青玉诀', type: 'technique', access: 'protagonist' }, evidence: 'msg:0', confidence: 0.9 },
        { op: 'reveal', skill: '青玉诀', to: '苏婉', suspicion: '你藏着青玉牌', method: '暗中观察', evidence: 'msg:0', confidence: 0.9 },
    ]);
    const text = assembleInjection(result.state, {
        protagonistId: 'user',
        activeCharacterIds: ['user', '苏婉', '王掌柜'],
    });
    assert.match(text, /主角级；只有你知道/);
    assert.match(text, /怀疑=苏婉/);
    assert.doesNotMatch(text, /不知情=/);
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
        { op: 'set_tier', character: '白玉广场执事甲', access: 'friend', reason: '共同守密', evidence: 'msg:1', confidence: 0.9 },
        { op: 'add_skill', character: 'user', skill: { name: '青玉诀', type: 'technique', access: 'friend' }, evidence: 'msg:2', confidence: 0.9 },
    ]);
    const a = findCharacter(result.state, '白玉广场执事甲');
    const b = findCharacter(result.state, '坊市执事乙');
    const skill = result.state.characters.user.skills.find((entry) => entry.name === '青玉诀');
    assert.notEqual(a.id, b.id);
    assert.equal(knowsEntity(skill, a.id, result.state), true);
    assert.equal(knowsEntity(skill, b.id, result.state), false);
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

test('reveal 公开条目是空操作，不会把它变成秘密', () => {
    let state = createEmptyState();
    state.meta.protagonistId = 'lin_yuan';
    state.characters.lin_yuan = { id: 'lin_yuan', name: '林远', tier: 'main', state: {}, items: [], relations: [], skills: [], abilities: [] };
    state = run(state, [
        { op: 'add_skill', character: 'lin_yuan', skill: { id: 'sk_open', name: '御剑术' }, evidence: 'msg:1', confidence: 0.9 },
    ]).state;
    const before = entityAccess(state.characters.lin_yuan.skills[0]);
    state = run(state, [
        { op: 'reveal', skill: 'sk_open', to: 'su_wan', method: '当众演示', evidence: 'msg:2', confidence: 0.9 },
    ]).state;
    const skill = state.characters.lin_yuan.skills[0];
    assert.equal(entityAccess(skill), before);
    assert.equal(before, 'public');
});

test('关闭知情约束仍保留主角秘密内容', () => {
    let state = createEmptyState();
    state = run(state, [
        { op: 'set', character: 'user', field: 'realm', value: '筑基', access: 'protagonist', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: 'user', field: 'progress', value: '30', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: '王掌柜', field: 'gender', value: '男', evidence: 'msg:0', confidence: 0.9 },
        { op: 'add_item', character: 'user', item: { name: '混沌珠', access: 'protagonist' }, evidence: 'msg:0', confidence: 0.9 },
    ]).state;
    const text = assembleInjection(state, { tokenBudget: 3000, knowledgeGate: false });
    assert.match(text, /混沌珠/);
    assert.match(text, /筑基/);
    assert.match(text, /progress：30\/100/);
    assert.doesNotMatch(text, /\[K:|（知情：|（只有你知道）/);
});

test('回放真实版本日志不会造出幽灵角色', () => {
    const result = run(createEmptyState(), [
        { op: 'set_tier', character: '苏绾', access: 'friend', reason: '共同守密', evidence: 'msg:0', confidence: 0.9 },
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

test('reveal 只带怀疑时不改档位', () => {
    let state = run(tierState(), [
        { op: 'add_skill', character: 'user', skill: { name: '噬灵诀', type: 'technique', access: 'protagonist' }, evidence: 'msg:0', confidence: 0.9 },
    ]).state;
    const result = run(state, [
        { op: 'reveal', skill: '噬灵诀', to: '苏绾', suspicion: '看向你怀里', evidence: 'msg:0', confidence: 0.9 },
    ]);
    const skill = result.state.characters.user.skills.find((entry) => entry.name === '噬灵诀');
    assert.equal(entityAccess(skill), 'protagonist');
    assert.equal(result.changedOps.filter((op) => op.op === 'reveal').length, 0);
    assert.equal(skill.beliefs.su.state, 'suspects');
});

test('旧数据归一化：清掉 facts、旧 leaks 与 add_fact 待复核', () => {
    const state = createEmptyState();
    state.characters.su = {
        id: 'su', name: '苏绾', state: { realm: '筑基初期' }, facts: [{ id: 'f_old' }],
    };
    state.meta.leaks = [
        { field: 'spiritRoot', by: '苏绾' },
        { at: 'x', target: { kind: 'field', field: 'spiritRoot' } },
    ];
    state.meta.review = [
        { op: { op: 'add_fact', text: '旧秘密' } },
        { op: { op: 'set', character: 'su', field: 'realm', value: '金丹初期' } },
    ];
    state.facts = [{ id: 'f_top' }];

    const result = normalizeState(state);
    assert.equal(result.characters.su.facts, undefined);
    // 旧字符串字段迁移成 current/history，否则角色页显示空值。
    assert.equal(result.characters.su.state.realm.current, '筑基初期');
    assert.equal(result.meta.leaks.length, 1);
    assert.equal(result.meta.review.length, 1);
    assert.equal(result.facts, undefined);
});

test('旧关系里的 attitude 在归一化时清掉，也不再进注入', () => {
    const state = createEmptyState();
    state.characters.user = {
        id: 'user', name: '你', tier: 'main', access: 'protagonist', state: {},
        items: [], skills: [], abilities: [],
        relations: [{ target: 'su', targetName: '苏绾', type: '同门', attitude: '带着侵略性的好奇', validFrom: '', validTo: null, access: 'public' }],
    };
    state.characters.su = {
        id: 'su', name: '苏绾', tier: 'major', access: 'friend',
        state: {}, items: [], relations: [], skills: [], abilities: [],
    };
    const normalized = normalizeState(state);
    assert.equal(normalized.characters.user.relations[0].attitude, undefined);
    const text = assembleInjection(normalized, {
        tokenBudget: 3000,
        activeCharacterIds: ['user', 'su'],
        protagonistId: 'user',
    });
    assert.match(text, /苏绾\(同门\)/);
    assert.doesNotMatch(text, /带着侵略性的好奇/);
});

test('被拒的 op 不会留下空壳角色', () => {
    const result = run(createEmptyState(), [
        { op: 'set_tier', character: '王掌柜', access: 'friend', evidence: 'msg:0', confidence: 0.9 },
    ]);
    assert.equal(findCharacter(result.state, '王掌柜'), undefined);
    assert.equal(result.rejected.length, 1);
});

test('待确认的档位标记在 op 上，便于区分是否真的改档', () => {
    const state = tierState();
    state.characters.su.access = 'public';
    state.scene.day = 1;
    const result = run(state, [
        { op: 'set_tier', character: '苏绾', access: 'friend', reason: '共同守密', evidence: 'msg:0', confidence: 0.9 },
    ], { tierVoteThreshold: 2 });
    assert.equal(result.pendingOps.length, 1);
    assert.ok(result.applied[0].pendingTier);
    assert.equal(result.applied[0].pendingTier.count, 1);
});

test('数量为 0 的秘密物品不进秘密知情', () => {
    let state = run(createEmptyState(), [
        { op: 'add_item', character: 'user', item: { id: 'i_jade', name: '青玉牌', access: 'protagonist' }, evidence: 'msg:0', confidence: 0.9 },
    ]).state;
    state = run(state, [
        { op: 'set_item_quantity', item: 'i_jade', quantity: 0, evidence: 'msg:1', confidence: 0.9 },
    ]).state;
    const text = assembleInjection(state, { tokenBudget: 3000 });
    assert.doesNotMatch(text, /青玉牌/);
});

test('clear_items 指定 kinds 时 includeCurrency 仍能一并清钱', () => {
    const state = run(createEmptyState(), [
        { op: 'add_item', character: 'user', item: { id: 'i_gold', name: '灵石', kind: 'currency', quantity: 3 }, evidence: 'msg:0', confidence: 0.9 },
        { op: 'add_item', character: 'user', item: { id: 'i_jade', name: '青玉牌' }, evidence: 'msg:0', confidence: 0.9 },
    ]).state;
    const next = run(state, [
        { op: 'clear_items', character: 'user', kinds: ['item'], includeCurrency: true, evidence: 'msg:1', confidence: 0.9 },
    ]).state;
    const gold = next.characters.user.items.find((item) => item.id === 'i_gold');
    const jade = next.characters.user.items.find((item) => item.id === 'i_jade');
    assert.equal(gold.quantity, 0);
    assert.ok(jade.validTo !== null);
});

test('同一轮里 reveal 按定档后的档位判断', () => {
    let state = tierState();
    state.characters.su.access = 'public';
    state.scene.day = 1;
    state = run(state, [
        { op: 'add_skill', character: 'user', skill: { name: '噬灵诀', access: 'protagonist' }, evidence: 'msg:0', confidence: 0.9 },
    ]).state;
    const result = run(state, [
        // 模型常把 reveal 写在 set_tier 前面，实际落账应先定档再判知情。
        { op: 'reveal', skill: '噬灵诀', to: '苏绾', evidence: 'msg:1', confidence: 0.9 },
        { op: 'set_tier', character: '苏绾', access: 'friend', reason: '共同守密', evidence: 'msg:1', confidence: 0.9 },
    ]);
    const skill = result.state.characters.user.skills.find((entry) => entry.name === '噬灵诀');
    assert.equal(entityAccess(skill), 'friend');
});

test('reveal 可以指向同一轮由其他 op 建档的新角色', () => {
    let state = run(createEmptyState(), [
        { op: 'add_skill', character: 'user', skill: { name: '噬灵诀', access: 'protagonist' }, evidence: 'msg:0', confidence: 0.9 },
    ]).state;
    state.scene.day = 1;
    const result = run(state, [
        // 模型常把 reveal 写在新角色首次出现的 set_relation 前面。
        { op: 'reveal', skill: '噬灵诀', to: '王掌柜', evidence: 'msg:1', confidence: 0.9 },
        { op: 'set_relation', from: '王掌柜', to: 'user', type: '熟人', evidence: 'msg:1', confidence: 0.9 },
    ]);
    assert.ok(!result.rejected.some((item) => /找不到角色/.test(item.reason)));
    assert.ok(findCharacter(result.state, '王掌柜'));
});

test('每个题材预设都有技能与能力标签', () => {
    for (const id of ['xianxia', 'urban', 'scifi', 'mystery', 'romance', 'custom']) {
        const preset = getGenrePreset(id);
        assert.ok(preset.skillLabel, `${id} 缺少 skillLabel`);
        assert.ok(preset.abilityLabel, `${id} 缺少 abilityLabel`);
    }
});

test('add_item 只给 id 时沿用已有显示名', () => {
    let state = run(createEmptyState(), [
        { op: 'add_item', character: 'user', item: { id: 'i_jade', name: '青玉牌' }, evidence: 'msg:0', confidence: 0.9 },
    ]).state;
    state = run(state, [
        { op: 'add_item', character: 'user', item: { id: 'i_jade', access: 'public' }, evidence: 'msg:1', confidence: 0.9 },
    ]).state;
    const names = state.characters.user.items.map((item) => item.name);
    assert.deepEqual(names, ['青玉牌']);
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
    let state = run(tierState(), [
        { op: 'add_skill', character: 'user', skill: { name: '噬灵诀', type: 'technique', access: 'protagonist' }, evidence: 'msg:0', confidence: 0.9 },
    ]).state;
    const result = run(state, [
        { op: 'reveal', skill: '噬灵诀', to: '苏绾', access: 'public', evidence: 'msg:0', confidence: 0.9 },
    ]);
    const skill = result.state.characters.user.skills.find((entry) => entry.name === '噬灵诀');
    assert.equal(entityAccess(skill), 'friend');
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

test('reveal 目标写错名字时拒绝，不新建角色', () => {
    let state = run(tierState(), [
        { op: 'add_skill', character: 'user', skill: { name: '噬灵诀', type: 'technique', access: 'protagonist' }, evidence: 'msg:0', confidence: 0.9 },
    ]).state;
    const result = run(state, [
        { op: 'reveal', skill: '噬灵诀', to: '苏婉', evidence: 'msg:0', confidence: 0.9 },
    ]);
    const skill = result.state.characters.user.skills.find((entry) => entry.name === '噬灵诀');
    assert.equal(entityAccess(skill), 'protagonist');
    assert.ok(!Object.values(result.state.characters).some((character) => character.name === '苏婉'));
    assert.ok(result.rejected.some((item) => /找不到角色/.test(item.reason)));
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
    const text = '城卫盯着你袖口，忽然说：“筑基九层？还会噬灵诀？腰里那块残缺符文的玉牌是哪来的？”';
    const leaks = detectLeaks(state, text, ['wang']);
    assert.ok(leaks.some((leak) => leak.target?.item === '残缺符文的玉牌'));
    assert.ok(leaks.some((leak) => leak.target?.skill === '噬灵诀'));
    assert.ok(leaks.some((leak) => leak.target?.field === 'realm' && leak.target?.character === 'user'));

    const automatic = detectLeaks(state, text, []);
    assert.ok(automatic.some((leak) => leak.character === 'su'));
    assert.ok(automatic.every((leak) => leak.character !== 'user'));
});

test('泄露检测只看对话，旁白提到秘密不算', () => {
    const state = createEmptyState();
    state.characters = {
        user: {
            id: 'user', name: '你', tier: 'main', access: 'protagonist',
            state: {},
            items: [{ id: 'i_orb', name: '混沌珠', kind: 'artifact', quantity: 1, unit: '', holder: 'user', validFrom: '', validTo: null, access: 'protagonist' }],
            relations: [], skills: [], abilities: [],
        },
        su_wan: { id: 'su_wan', name: '苏婉', tier: 'major', access: 'public', state: {}, items: [], relations: [], skills: [], abilities: [] },
    };
    const narration = '苏婉看着你怀里的混沌珠，什么也没问。';
    assert.equal(detectLeaks(state, narration, ['user', 'su_wan']).length, 0);
    const spoken = '苏婉：“你怀里那颗混沌珠是什么？”';
    assert.equal(detectLeaks(state, spoken, ['user', 'su_wan']).length, 1);
});

test('泄露检测支持多种对话引号，未闭合引号只取到行尾', () => {
    const state = createEmptyState();
    state.characters = {
        user: {
            id: 'user', name: '你', tier: 'main', access: 'protagonist',
            state: {},
            items: [{ id: 'i_orb', name: '混沌珠', kind: 'artifact', quantity: 1, unit: '', holder: 'user', validFrom: '', validTo: null, access: 'protagonist' }],
            relations: [], skills: [], abilities: [],
        },
        su_wan: { id: 'su_wan', name: '苏婉', tier: 'major', access: 'public', state: {}, items: [], relations: [], skills: [], abilities: [] },
    };
    const variants = [
        '苏婉：「混沌珠？」',
        '苏婉：『混沌珠？』',
        '苏婉：“混沌珠？”',
        '苏婉："混沌珠？"',
        '苏婉：｢混沌珠？｣',
    ];
    for (const text of variants) {
        assert.equal(detectLeaks(state, text, ['user', 'su_wan']).length, 1, text);
    }
    assert.equal(detectLeaks(state, '苏婉：“混沌珠？\n她没再问。', ['user', 'su_wan']).length, 1);
});

test('两字以内的泛词片段不再误报', () => {
    const state = createEmptyState();
    state.characters = {
        user: {
            id: 'user', name: '你', tier: 'main', access: 'protagonist',
            state: { spiritRoot: { current: '五行杂灵根', history: [], access: 'protagonist' } },
            items: [], relations: [], skills: [], abilities: [],
        },
        su_wan: { id: 'su_wan', name: '苏婉', tier: 'major', access: 'public', state: {}, items: [], relations: [], skills: [], abilities: [] },
    };
    // 只说「灵根」这种两字泛词，不该算说破具体灵根。
    assert.equal(detectLeaks(state, '女修：“灵根？”', ['user', 'su_wan']).length, 0);
    assert.equal(detectLeaks(state, '女修：“五行杂灵根？”', ['user', 'su_wan']).length, 1);
});

test('灵根与体质默认主角级，其他字段仍公开', () => {
    const result = run(createEmptyState(), [
        { op: 'set', character: 'user', field: 'spiritRoot', value: '五行杂灵根', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: 'user', field: '体质', value: '凡体', evidence: 'msg:0', confidence: 0.9 },
        { op: 'set', character: 'user', field: 'realm', value: '练气初期', evidence: 'msg:0', confidence: 0.9 },
    ]);
    const state = result.state;
    assert.equal(entityAccess(state.characters.user.state.spiritRoot), 'protagonist');
    assert.equal(entityAccess(state.characters.user.state.physique), 'protagonist');
    assert.equal(entityAccess(state.characters.user.state.realm), 'public');
});

test('set/remove/move/adjust 可以用中文名引用条目', () => {
    let state = run(createEmptyState(), [
        { op: 'add_skill', character: 'user', skill: { name: '青木诀', type: 'technique', level: '第三重' }, evidence: 'msg:0', confidence: 0.9 },
        { op: 'add_item', character: 'user', item: { id: 'i_pill', name: '回气丹', quantity: 3 }, evidence: 'msg:0', confidence: 0.9 },
    ]).state;

    let result = run(state, [
        { op: 'set_skill', character: 'user', skill: '青木诀', level: '第四重', evidence: 'msg:1', confidence: 0.9 },
    ]);
    assert.equal(result.rejected.length, 0);
    assert.equal(result.state.characters.user.skills[0].level, '第四重');

    result = run(state, [
        { op: 'move_item', item: '回气丹', to: '苏婉', evidence: 'msg:1', confidence: 0.9 },
    ]);
    assert.equal(result.rejected.length, 0);
    const holder = Object.values(result.state.characters).find((character) => character.name === '苏婉');
    assert.equal(holder.items[0].id, 'i_pill');
    assert.equal(holder.items[0].name, '回气丹');

    const itemState = run(createEmptyState(), [
        { op: 'add_item', character: 'user', item: { id: 'i_pill', name: '回气丹', quantity: 3 }, evidence: 'msg:0', confidence: 0.9 },
    ]).state;
    result = run(itemState, [
        { op: 'remove_item', character: 'user', item: '回气丹', evidence: 'msg:1', confidence: 0.9 },
    ]);
    assert.equal(result.rejected.length, 0);
    assert.equal(result.state.characters.user.items[0].validTo != null, true);
});

test('add_item 同 id 只改档位时不重置数量', () => {
    let state = run(createEmptyState(), [
        { op: 'add_item', character: 'user', item: { id: 'i_pill', name: '回气丹', quantity: 3, access: 'protagonist' }, evidence: 'msg:0', confidence: 0.9 },
    ]).state;
    state = run(state, [
        { op: 'add_item', character: 'user', item: { id: 'i_pill', name: '回气丹', access: 'public' }, evidence: 'msg:1', confidence: 0.9 },
    ]).state;
    const current = state.characters.user.items.filter((item) => item.validTo == null);
    assert.equal(current.length, 1);
    assert.equal(current[0].quantity, 3);
    assert.equal(entityAccess(current[0]), 'public');
});

test('reveal 的 character 写错名字不会新建幽灵角色', () => {
    let state = run(createEmptyState(), [
        { op: 'set', character: '苏绾', field: 'gender', value: '女', evidence: 'msg:0', confidence: 0.9 },
    ]).state;
    const result = run(state, [
        { op: 'reveal', to: '苏绾', character: '对方', field: 'realm', method: '神识', evidence: 'msg:1', confidence: 0.9 },
    ]);
    assert.ok(result.rejected.some((item) => /找不到字段/.test(item.reason)));
    assert.ok(!Object.values(result.state.characters).some((character) => character.name === '对方'));
});

test('题材标签覆盖体质、家族、身世与目标', () => {
    const labels = getGenrePreset('xianxia').fieldLabels;
    assert.equal(labels.physique, '体质');
    assert.equal(labels.family, '家族');
    assert.equal(labels.origin, '身世');
    assert.equal(labels.objective, '目标');
    assert.equal(getGenrePreset('urban').fieldLabels.objective, '目标');
});

test('物品转给公开级角色不会把秘密变成公开', () => {
    let state = run(createEmptyState(), [
        { op: 'set', character: '苏婉', field: 'gender', value: '女', evidence: 'msg:0', confidence: 0.9 },
        { op: 'add_item', character: 'user', item: { id: 'i_orb', name: '混沌珠', access: 'protagonist' }, evidence: 'msg:0', confidence: 0.9 },
    ]).state;
    state = run(state, [
        { op: 'move_item', item: '混沌珠', to: '苏婉', evidence: 'msg:1', confidence: 0.9 },
    ]).state;
    const holder = Object.values(state.characters).find((character) => character.name === '苏婉');
    assert.equal(entityAccess(holder.items[0]), 'protagonist');
    assert.equal(knowsEntity(holder.items[0], holder.id, state), false);
});

test('collectAssistantText 只拼接本轮 AI 消息', () => {
    const chat = [
        { is_user: true, mes: '玩家 0' },
        { is_user: false, mes: 'AI 1' },
        { is_user: true, mes: '玩家 2' },
        { is_user: false, mes: 'AI 3' },
        { is_user: false, mes: 'AI 4' },
    ];
    assert.equal(collectAssistantText(chat, 1, 3), 'AI 1\nAI 3');
    assert.equal(collectAssistantText(chat, 4, 4), 'AI 4');
    assert.equal(collectAssistantText(chat, 0, 1), 'AI 1');
});
