import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyExtractionFailure, failureMessage, looksLikeRefusal } from '../lib/refusal.js';

test('空正文归为 empty', () => {
    assert.equal(classifyExtractionFailure('', null).kind, 'empty');
    assert.equal(classifyExtractionFailure('   ', null).kind, 'empty');
});

test('中文拒绝归为 refusal', () => {
    assert.equal(classifyExtractionFailure('抱歉，我无法协助处理这段内容。', null).kind, 'refusal');
    assert.equal(classifyExtractionFailure('作为 AI，我不能提供这类信息。', null).kind, 'refusal');
    assert.equal(classifyExtractionFailure('这违反了内容政策，恕不提供。', null).kind, 'refusal');
});

test('英文拒绝归为 refusal', () => {
    assert.equal(classifyExtractionFailure("I'm sorry, I can't help with that.", null).kind, 'refusal');
    assert.equal(classifyExtractionFailure('As an AI, I am unable to comply.', null).kind, 'refusal');
});

test('内容过滤优先于空正文', () => {
    const got = classifyExtractionFailure('', null, { finishReason: 'content_filter' });
    assert.equal(got.kind, 'content_filter');
});

test('鉴权、超时、限流、网络分别归类', () => {
    assert.equal(classifyExtractionFailure('', new Error('401 Unauthorized')).kind, 'auth');
    assert.equal(classifyExtractionFailure('', new Error('403 forbidden')).kind, 'auth');
    assert.equal(classifyExtractionFailure('', new Error('提取请求超时（20 秒）')).kind, 'timeout');
    assert.equal(classifyExtractionFailure('', new Error('429 too many requests')).kind, 'rate_limit');
    assert.equal(classifyExtractionFailure('', new Error('read ECONNRESET')).kind, 'network');
    assert.equal(classifyExtractionFailure('', new Error('something odd')).kind, 'request');
});

test('不是 JSON 但不是拒绝，归为 invalid_json', () => {
    assert.equal(classifyExtractionFailure('好的，已经处理完毕。', null).kind, 'invalid_json');
});

test('已经解析成 JSON 时不报故障', () => {
    const raw = '{"protagonist":"user","ops":[{"text":"他不能输"}]}';
    assert.equal(classifyExtractionFailure(raw, null, {}, { jsonParsed: true }), null);
});

test('普通叙述里的“不能”不误判为拒绝', () => {
    assert.equal(looksLikeRefusal('他不能输，也不能退。'), false);
    assert.equal(looksLikeRefusal('这一战没有不能输的理由。'), false);
});

test('错误提示都带“台账未更新”或明确处理方向', () => {
    for (const kind of ['refusal', 'content_filter', 'empty', 'auth', 'timeout', 'rate_limit', 'network', 'invalid_json', 'request']) {
        const message = failureMessage({ kind, detail: '' });
        assert.ok(message.length > 0);
        assert.ok(/台账未更新|检查|重试|换/.test(message), `${kind}: ${message}`);
    }
});
