/**
 * Genre presets for the fact ledger.
 *
 * The data model itself is genre-agnostic; these presets only provide:
 * - a human-readable hint inserted into the extraction prompt;
 * - a preferred field order used by the injection assembler.
 *
 * Default is xianxia (修仙), matching the original use case.
 */

export const GENRE_PRESETS = {
    xianxia: {
        label: '修仙',
        narrativeRules: "【台账】注入的【事实台账】是玩家已知事实的摘要，玩家始终知道真相；不能据此改写玩家的姓名、身世、灵根、体质与已经写出的经历。\n\n【知情】正文明确写谁不知道/谁知道，就按正文；正文没写时，按【秘密知情】的默认知情/默认不知情名单。要避免两种错法：① 旧秘密超出上下文，把明明知情的 NPC 写成不知道；② 秘密被反复提及稀释了保密属性，正文又没重新写明谁不知情，就把不相干的人写成知道。在场、看到、反复提及都不等于知情。\n\n【秘密知情】怀疑=某人已起疑，可以试探但不能说破；误以为=按错误认知行动，不要替其纠正。\n\n【未了结】里的旧账、人情、仇怨仍然有效，相关角色在场时可以推进，不要当成已经了结。",
        hint: `题材：修仙。
state 常用字段：realm（境界）、progress（境界进度，0-100 的整数）、technique（功法）、spiritRoot（灵根）、sect（宗门）、location（地点）、status（状态）、appearance（外貌体型，如“身材魁梧”）。
realm 只写：练气初期/中期/后期/大圆满、筑基初期/中期/后期/大圆满、金丹初期/中期/后期/大圆满、元婴、化神；不要写“引气期”“炼气期”等别称。
进度只记主角，不写档位（NPC 看不出具体进境），在修炼有实质推进时更新；突破换境界后重置到 0。
文字冒险常用字段：situation（局势）、fame（名望）、health（伤势）。
功法与神通分别用 add_skill / add_ability 记录。
物品：法宝、丹药、灵石、符箓。
货币：灵石（枚）。
关系：师徒、道侣、同门、仇敌。
场景：记录时间、地点。`,
        currency: { name: '灵石', unit: '枚' },
        skillLabel: '功法',
        fieldLabels: {
            realm: '境界', progress: '境界进度', technique: '功法', spiritRoot: '灵根', sect: '宗门',
            location: '地点', status: '状态', fame: '名望', gender: '性别',
            appearance: '外貌体型', age: '年龄', situation: '局势', health: '伤势',
        },
        panelMap: {
            location: 'world', fame: 'world', situation: 'world',
            realm: 'personal', progress: 'personal', technique: 'personal', spiritRoot: 'personal', sect: 'personal',
            status: 'personal', gender: 'personal', appearance: 'personal', age: 'personal', health: 'personal',
        },
        fieldOrder: ['realm', 'progress', 'technique', 'spiritRoot', 'sect', 'appearance', 'fame', 'location', 'status', 'health', 'situation'],
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
state 常用字段：rank（职位）、wealth（财力）、network（人脉）、company（公司）、location（地点）、status（状态）。
文字冒险常用字段：situation（局势）、fame（名声）、health（伤势）。
技能：可以有多条，用 add_skill 记录。
物品：合同、把柄、房产、车辆。
货币：人民币（元）。
关系：上司、下属、竞争对手、旧情。
场景：记录时间、地点。`,
        currency: { name: '人民币', unit: '元' },
        skillLabel: '技能/专长',
        fieldLabels: {
            rank: '职位', wealth: '财力', network: '人脉', company: '公司',
            location: '地点', status: '状态', fame: '名声', gender: '性别',
            appearance: '外貌体型', age: '年龄', situation: '局势', health: '伤势',
        },
        panelMap: {
            location: 'world', fame: 'world', situation: 'world',
            rank: 'personal', wealth: 'personal', network: 'personal', company: 'personal',
            status: 'personal', gender: 'personal', appearance: 'personal', age: 'personal', health: 'personal',
        },
        fieldOrder: ['rank', 'wealth', 'network', 'company', 'fame', 'location', 'status', 'health', 'situation'],
    },
    scifi: {
        label: '科幻',
        hint: `题材：科幻。
state 常用字段：rank（军衔）、cyberware（义体等级）、clearance（权限）、ship（舰船）、location（地点）、status（状态）。
文字冒险常用字段：situation（局势）、fame（声望）、health（伤势）。
技能：可以有多条，用 add_skill 记录。
物品：装备、芯片、通行证。
货币：信用点（点）。
关系：舰队、盟友、AI 归属。
场景：记录时间、地点。`,
        currency: { name: '信用点', unit: '点' },
        skillLabel: '技能/改造',
        fieldLabels: {
            rank: '军衔', cyberware: '义体等级', clearance: '权限', ship: '舰船',
            location: '地点', status: '状态', fame: '声望', gender: '性别',
            appearance: '外貌体型', age: '年龄', situation: '局势', health: '伤势',
        },
        panelMap: {
            location: 'world', fame: 'world', situation: 'world',
            rank: 'personal', cyberware: 'personal', clearance: 'personal', ship: 'personal',
            status: 'personal', gender: 'personal', appearance: 'personal', age: 'personal', health: 'personal',
        },
        fieldOrder: ['rank', 'cyberware', 'clearance', 'ship', 'fame', 'location', 'status', 'health', 'situation'],
    },
    mystery: {
        label: '悬疑',
        hint: `题材：悬疑。
state 常用字段：suspicion（嫌疑度）、motive（动机）、alibi（不在场证明）、location（地点）、status（状态）。
文字冒险常用字段：situation（局势）、fame（名声）、health（伤势）。
技能：可以有多条，用 add_skill 记录。
物品：线索、证据、凶器。
货币：现金（元）。
关系：共犯、目击者、委托人。
场景：记录时间、地点。`,
        currency: { name: '现金', unit: '元' },
        skillLabel: '技能/专长',
        fieldLabels: {
            suspicion: '嫌疑度', motive: '动机', alibi: '不在场证明',
            location: '地点', status: '状态', fame: '名声', gender: '性别',
            appearance: '外貌体型', age: '年龄', situation: '局势', health: '伤势',
        },
        panelMap: {
            location: 'world', fame: 'world', situation: 'world',
            suspicion: 'personal', motive: 'personal', alibi: 'personal',
            status: 'personal', gender: 'personal', appearance: 'personal', age: 'personal', health: 'personal',
        },
        fieldOrder: ['suspicion', 'motive', 'alibi', 'fame', 'location', 'status', 'health', 'situation'],
    },
    romance: {
        label: '言情',
        hint: `题材：言情。
state 常用字段：affection（好感度）、stage（关系阶段）、misunderstanding（误会）、location（地点）、status（状态）。
文字冒险常用字段：situation（局势）、fame（名声）、health（伤势）。
技能：可以有多条，用 add_skill 记录。
物品：信物、礼物。
货币：现金（元）。
关系：前任、暗恋、家族关系。
场景：记录时间、地点。`,
        currency: { name: '现金', unit: '元' },
        skillLabel: '技能/特长',
        fieldLabels: {
            affection: '好感度', stage: '关系阶段', misunderstanding: '误会',
            location: '地点', status: '状态', fame: '名声', gender: '性别',
            appearance: '外貌体型', age: '年龄', situation: '局势', health: '伤势',
        },
        panelMap: {
            location: 'world', fame: 'world', situation: 'world',
            affection: 'personal', stage: 'personal', misunderstanding: 'personal',
            status: 'personal', gender: 'personal', appearance: 'personal', age: 'personal', health: 'personal',
        },
        fieldOrder: ['affection', 'stage', 'misunderstanding', 'fame', 'location', 'status', 'health', 'situation'],
    },
    custom: {
        label: '自定义',
        hint: '',
        currency: { name: '', unit: '' },
        skillLabel: '技能',
        fieldLabels: {},
        panelMap: {},
        fieldOrder: [],
    },
};

export const DEFAULT_GENRE = 'xianxia';

export function getGenrePreset(id) {
    const preset = GENRE_PRESETS[id] ?? GENRE_PRESETS[DEFAULT_GENRE];
    // 叙事规则与题材无关：除修仙外的预设没有单独写，回落到共享默认。
    return {
        ...preset,
        narrativeRules: preset.narrativeRules || GENRE_PRESETS[DEFAULT_GENRE].narrativeRules,
    };
}

export function listGenrePresets() {
    return Object.entries(GENRE_PRESETS).map(([id, preset]) => ({ id, label: preset.label }));
}
