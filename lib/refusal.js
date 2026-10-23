/**
 * 提取失败的归类与用户提示。
 *
 * 区分“模型拒绝/内容过滤”与“超时、鉴权、网络、JSON 不合规”，
 * 让状态栏和 toast 能说清楚本轮台账为什么没更新。
 */

const REFUSAL_ZH = /^(?:\s*)(?:抱歉|对不起|很抱歉|我无法|我不能|无法|不能|不便|恕不)/;
const REFUSAL_ZH_ANY = /(?:作为.{0,8}(?:AI|人工智能|语言模型|助手)|(?:无法|不能|不便)(?:提供|协助|回答|完成|处理)|违反.{0,8}(?:政策|规定|准则)|内容政策|安全政策|敏感内容|拒绝回答)/;
const REFUSAL_EN = /(?:^\s*)(?:i'?m sorry|i am sorry|i cannot|i can'?t|i am unable|i'?m unable|unable to (?:comply|assist|provide)|as an ai|i won'?t|i will not)/i;
const POLICY_EN = /(?:content policy|safety policy|usage policy|against (?:my|our) (?:policy|guidelines)|violat(?:e|es|ing) (?:the|our) (?:policy|guidelines))/i;

function errorText(error) {
    if (!error) return '';
    if (typeof error === 'string') return error;
    const cause = error.cause;
    return String(
        cause?.message
        || cause?.error?.message
        || error.message
        || error,
    );
}

export function looksLikeRefusal(text) {
    const head = String(text || '').slice(0, 500);
    if (!head.trim()) return false;
    return REFUSAL_ZH.test(head)
        || REFUSAL_ZH_ANY.test(head)
        || REFUSAL_EN.test(head)
        || POLICY_EN.test(head);
}

/**
 * @param {string} raw 提取模型返回的正文（可能为空）
 * @param {unknown} error 调用模型时抛出的错误；没有就传 null
 * @param {{finishReason?: string}} meta 供应商返回的元信息
 * @param {{jsonParsed?: boolean}} options 已经成功解析成 JSON 时传 true，直接视为没有故障
 * @returns {{kind: string, detail: string}|null}
 */
export function classifyExtractionFailure(raw, error, meta = {}, options = {}) {
    if (options.jsonParsed) return null;

    const finish = String(meta?.finishReason || '').toLowerCase();
    if (finish === 'content_filter' || finish === 'content-filter') {
        return { kind: 'content_filter', detail: 'finish_reason=content_filter' };
    }

    const detail = errorText(error);
    if (detail) {
        if (/超时|timeout|timed out/i.test(detail)) return { kind: 'timeout', detail };
        if (/\b(?:401|403)\b|unauthorized|forbidden|invalid[_\s-]?(?:api[_\s-]?key|token)|鉴权|密钥|未授权/i.test(detail)) {
            return { kind: 'auth', detail };
        }
        if (/\b429\b|rate limit|capacity|too many requests|容量|满负荷/i.test(detail)) {
            return { kind: 'rate_limit', detail };
        }
        if (/空内容|empty (?:content|response)|no content/i.test(detail)) {
            return { kind: 'empty', detail };
        }
        if (/ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|network|socket|连接失败/i.test(detail)) {
            return { kind: 'network', detail };
        }
        return { kind: 'request', detail };
    }

    const text = String(raw || '').trim();
    if (!text) return { kind: 'empty', detail: '返回空正文' };
    if (looksLikeRefusal(text)) return { kind: 'refusal', detail: text.slice(0, 160) };
    return { kind: 'invalid_json', detail: '没有返回可解析的 JSON' };
}

const MESSAGES = {
    refusal: '提取模型拒绝处理本轮内容（可能触发审查）。本轮台账未更新，可换无审查模型或手动结算。',
    content_filter: '提取模型触发了内容过滤。本轮台账未更新，可换模型或调整本轮内容。',
    empty: '提取模型返回空正文（可能是思考占满或服务异常）。本轮台账未更新。',
    auth: '提取连接鉴权失败（401/403）。请检查 API Key 和连接配置。',
    timeout: '提取请求超时（20 秒）。本轮台账未更新，可重试或换更快的连接。',
    rate_limit: '提取服务容量不足或限流。本轮台账未更新，稍后重试。',
    network: '提取连接失败（网络）。本轮台账未更新，请检查代理或网络。',
    invalid_json: '提取模型没有返回可解析的 JSON。本轮台账未更新。',
    request: '提取请求失败。本轮台账未更新。',
};

export function failureMessage(failure) {
    const kind = failure?.kind || 'request';
    const base = MESSAGES[kind] || MESSAGES.request;
    const detail = String(failure?.detail || '').trim();
    if (!detail || ['empty', 'invalid_json', 'content_filter'].includes(kind)) return base;
    return `${base}（${detail.slice(0, 120)}）`;
}
