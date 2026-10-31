/**
 * Genre presets for the fact ledger.
 *
 * The data model itself is genre-agnostic; these presets only provide:
 * - a human-readable hint inserted into the extraction prompt;
 * - a preferred field order used by the injection assembler.
 *
 * Default is xianxia (修仙), matching the original use case.
 */

/**
 * 与题材无关的叙事规则：读台账、处理知情与揭示。所有题材共用一份。
 */
const COMMON_NARRATIVE_RULES = "【台账】注入的【事实台账】是玩家已知事实的摘要，玩家始终知道真相；不能据此改写玩家的姓名、身世与已经写出的经历。\n\n【知情】正文明确写谁不知道/谁知道，就按正文；正文没写时，按【秘密知情】的默认知情/默认不知情名单。要避免两种错法：① 旧秘密超出上下文，把明明知情的 NPC 写成不知道；② 秘密被反复提及稀释了保密属性，正文又没重新写明谁不知情，就把不相干的人写成知道。在场、看到、反复提及都不等于知情。\n\n【秘密知情】怀疑=某人已起疑，可以试探但不能说破；误以为=按错误认知行动，不要替其纠正。";

export const GENRE_PRESETS = {
    xianxia: {
        label: '修仙',
        hint: `题材：修仙。
state 常用字段：realm（境界）、progress（境界进度，0-100 的整数）、spiritRoot（灵根）、physique（体质）、family（家族）、sect（宗门）、appearance（外貌体型，如“身材魁梧”）、fame（名望）、age（年龄）。
realm 只写：练气初期/中期/后期/大圆满、筑基初期/中期/后期/大圆满、金丹初期/中期/后期/大圆满、元婴、化神；不要写“引气期”“炼气期”等别称。
进度只记主角，不写档位（NPC 看不出具体进境）：出现修炼行为（打坐吐纳、运功周天、炼化丹药、闭关、锻体淬炼）就至少 +1，有明确成效再增加；突破换境界后重置到 0。
功法（提升境界、灵力与根基，以及攻伐、防御、身法、遁术等招式）统一用 add_skill。
物品：法宝、丹药、灵石、符箓。
货币：灵石（枚）、宗门贡献点（点）；「贡献值 / 积分」统一记成贡献点，不要建「贡献晶石」这类物品。
关系：师徒、道侣、同门、仇敌。
场景：记录时间、地点。`,
        levelField: 'realm',
        skillLabel: '功法',
        fieldLabels: {
            realm: '境界', progress: '境界进度', spiritRoot: '灵根', sect: '宗门',
            physique: '体质', constitution: '体质', family: '家族', origin: '身世', name: '姓名',
            fame: '名望', gender: '性别',
            appearance: '外貌体型', age: '年龄',
        },
        panelMap: {
            fame: 'world',
            realm: 'personal', progress: 'personal', spiritRoot: 'personal', sect: 'personal',
            physique: 'personal', family: 'personal',
            gender: 'personal', appearance: 'personal', age: 'personal',
        },
        fieldOrder: ['realm', 'progress', 'spiritRoot', 'physique', 'family', 'sect', 'appearance', 'fame', 'age'],
        stateAliases: {
            realm: {
                '引气期': '练气初期',
                '引气': '练气初期',
                '炼气期': '练气初期',
                '炼气': '练气初期',
                '练气': '练气初期',
                '练气一层': '练气初期',
                '练气二层': '练气初期',
                '练气三层': '练气初期',
                '练气四层': '练气中期',
                '练气五层': '练气中期',
                '练气六层': '练气中期',
                '练气七层': '练气后期',
                '练气八层': '练气后期',
                '练气九层': '练气后期',
                '练气十层': '练气大圆满',
                '练气巅峰': '练气大圆满',
                '筑基': '筑基初期',
                '筑基期': '筑基初期',
                '金丹': '金丹初期',
                '金丹期': '金丹初期',
                '元婴': '元婴初期',
                '元婴期': '元婴初期',
                '化神': '化神初期',
                '化神期': '化神初期',
            },
        },
    },
    urban: {
        label: '都市',
        hint: `题材：都市。
state 常用字段：rank（职位）、wealth（财力）、network（人脉）、company（公司）、fame（名声）、appearance（外貌体型）、age（年龄）。
技能：可以有多条，用 add_skill 记录。
物品：合同、把柄、房产、车辆。
货币：人民币（元）。
关系：上司、下属、竞争对手、旧情。
场景：记录时间、地点。`,
        levelField: 'rank',
        skillLabel: '技能/专长',
        fieldLabels: {
            rank: '职位', wealth: '财力', network: '人脉', company: '公司',
            fame: '名声', gender: '性别',
            appearance: '外貌体型', age: '年龄',
            name: '姓名',
        },
        panelMap: {
            fame: 'world',
            rank: 'personal', wealth: 'personal', network: 'personal', company: 'personal',
            gender: 'personal', appearance: 'personal', age: 'personal',
        },
        fieldOrder: ['rank', 'wealth', 'network', 'company', 'fame', 'age'],
    },
    scifi: {
        label: '科幻',
        hint: `题材：科幻。
state 常用字段：rank（军衔）、cyberware（义体等级）、clearance（权限）、ship（舰船）、fame（声望）、appearance（外貌体型）、age（年龄）。
义体等级写 cyberware；具体的改造功能用 add_skill 记录。
技能：可以有多条，用 add_skill 记录。
物品：装备、芯片、通行证。
货币：信用点（点）。
关系：舰队、盟友、AI 归属。
场景：记录时间、地点。`,
        levelField: 'rank',
        skillLabel: '技能/改造',
        fieldLabels: {
            rank: '军衔', cyberware: '义体等级', clearance: '权限', ship: '舰船',
            fame: '声望', gender: '性别',
            appearance: '外貌体型', age: '年龄',
            name: '姓名',
        },
        panelMap: {
            fame: 'world',
            rank: 'personal', cyberware: 'personal', clearance: 'personal', ship: 'personal',
            gender: 'personal', appearance: 'personal', age: 'personal',
        },
        fieldOrder: ['rank', 'cyberware', 'clearance', 'ship', 'fame', 'age'],
    },
    mystery: {
        label: '悬疑',
        hint: `题材：悬疑。
state 常用字段：suspicion（嫌疑度）、motive（动机）、alibi（不在场证明）、fame（名声）、appearance（外貌体型）、age（年龄）。
技能：可以有多条，用 add_skill 记录。
物品：线索、证据、凶器。
货币：现金（元）。
关系：共犯、目击者、委托人。
场景：记录时间、地点。`,
        levelField: '',
        skillLabel: '技能/专长',
        fieldLabels: {
            suspicion: '嫌疑度', motive: '动机', alibi: '不在场证明',
            fame: '名声', gender: '性别',
            appearance: '外貌体型', age: '年龄',
            name: '姓名',
        },
        panelMap: {
            fame: 'world',
            suspicion: 'personal', motive: 'personal', alibi: 'personal',
            gender: 'personal', appearance: 'personal', age: 'personal',
        },
        fieldOrder: ['suspicion', 'motive', 'alibi', 'fame', 'age'],
    },
    romance: {
        label: '言情',
        hint: `题材：言情。
state 常用字段：affection（好感度）、stage（关系阶段）、misunderstanding（误会）、fame（名声）、appearance（外貌体型）、age（年龄）。
技能：可以有多条，用 add_skill 记录。
物品：信物、礼物。
货币：现金（元）。
关系：前任、暗恋、家族关系。
场景：记录时间、地点。`,
        levelField: 'stage',
        skillLabel: '技能/特长',
        fieldLabels: {
            affection: '好感度', stage: '关系阶段', misunderstanding: '误会',
            fame: '名声', gender: '性别',
            appearance: '外貌体型', age: '年龄',
            name: '姓名',
        },
        panelMap: {
            fame: 'world',
            affection: 'personal', stage: 'personal', misunderstanding: 'personal',
            gender: 'personal', appearance: 'personal', age: 'personal',
        },
        fieldOrder: ['affection', 'stage', 'misunderstanding', 'fame', 'age'],
    },
    custom: {
        label: '自定义',
        hint: '',
        levelField: '',
        skillLabel: '技能',
        fieldLabels: {},
        panelMap: {},
        fieldOrder: [],
    },
};

export const DEFAULT_GENRE = 'xianxia';

export function getGenrePreset(id) {
    const preset = GENRE_PRESETS[id] ?? GENRE_PRESETS[DEFAULT_GENRE];
    // 叙事规则与题材无关：所有预设共用同一份，避免修仙文案注入到其他题材。
    return {
        ...preset,
        narrativeRules: preset.narrativeRules || COMMON_NARRATIVE_RULES,
    };
}

export function listGenrePresets() {
    return Object.entries(GENRE_PRESETS).map(([id, preset]) => ({ id, label: preset.label }));
}
