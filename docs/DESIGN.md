# 设计细节：数据模型、提取协议与注入装配

> 面向维护者。使用与安装请看 [README](../README.md)。

> 数据模型自 0.15.0 起不再包含 `events`，也不再兼容旧格式数据：旧聊天里的台账可能为空或角色对不上，直接新开聊天即可。

## 1. 数据模型

```json
{
  "characters": {
    "user": {
      "id": "user",
      "name": "你",
      "aliases": ["林师兄"],
      "tier": "main",
      "access": "protagonist",
      "state": {
        "realm": {
          "current": "炼气七层",
          "history": [
            { "value": "炼气六层", "validFrom": "第一日 晨", "validTo": "第三日 夜", "evidence": "msg:1", "confidence": 0.95 },
            { "value": "炼气七层", "validFrom": "第三日 夜", "validTo": null, "evidence": "msg:87", "confidence": 0.9 }
          ]
        },
        "gender": { "current": "男", "history": [] },
        "appearance": { "current": "清瘦，左手有旧伤", "history": [] },
        "fame": { "current": "外门新秀", "history": [] }
      },
      "items": [
        { "id": "i_sword", "name": "青锋剑", "kind": "equipment", "quantity": 1, "unit": "", "holder": "user", "validFrom": "第一日 晨", "validTo": null, "evidence": "msg:2" },
        { "id": "i_spirit", "name": "灵石", "kind": "currency", "quantity": 120, "unit": "枚", "holder": "user", "validFrom": "第一日 晨", "validTo": null, "evidence": "msg:3" }
      ],
      "skills": [
        { "id": "sk_qingmu", "name": "青木诀", "type": "technique", "level": "第三重", "validFrom": "第一日 晨", "validTo": null, "history": [] },
        { "id": "sk_sword", "name": "御剑术", "type": "skill", "level": "入门", "validFrom": "第三日 夜", "validTo": null, "history": [] }
      ],
      "relations": [
        { "target": "su_wan", "targetName": "苏婉", "type": "同门", "validFrom": "第一日 晨", "validTo": null }
      ]
    },
    "su_wan": {
      "id": "su_wan",
      "name": "苏婉",
      "tier": "major",
      "access": "friend",
      "state": { "gender": { "current": "女", "history": [] } },
      "items": [],
      "skills": [],
      "relations": []
    }
  },
  "scene": {
    "time": "夜里",
    "day": 3,
    "place": "黑风寨",
    "participants": ["user", "su_wan"]
  },
  "meta": {
    "lastProcessedMessage": 1,
    "messagesSinceSettle": 0,
    "lastSettleAt": null,
    "lastError": "",
    "leaks": [],
    "protagonistId": "",
    "history": []
  }
}
```

### 角色从哪里来

台账**不读取角色卡的人物设定**，所有角色都来自开场白、用户消息和 AI 回复：

- 主角：固定 id `user`，显示名「你」。提取提示词要求 `protagonist` 固定输出 `user`；旁白里的「你」、用户消息里的「我」、`玩家/主角/persona 名` 在落账前统一归一化为 `user`，不会分裂成多个角色。
- 主角不需要名字：卡片提示词要求旁白用第二人称「你」，NPC 追问姓名时由玩家自己回答，台账不编造名字。
- 在场角色：`set_scene` 的参与者会自动建立记录（只有名字），字段缺失时状态栏显示「未知」，后续被旁白提到再补。
- 性别：只允许 `男` / `女` / `未知`。姑娘、公子、师兄、师姐这类明确称谓可用于推断；只有姓氏+职位（如苏掌柜）时记为未知，禁止凭名字用字猜。
- 境界、宗门、功法：只在旁白或对话明确说明时记录，不编造。

### 角色身份：稳定 ID

`characters` 的键是**不随剧情变化的不透明 ID**，姓名只是显示数据：

- 主角固定 `user`；其他角色用 `npc_001`、`npc_002`……按出现顺序分配。手写的英文键（如 `lin_yuan`）保持原样。
- `name` 是显示名，`aliases` 存旧名和称呼。旁白、知情名单、关系里写的名字，落库前统一解析成 ID。
- 「执事」后来报出姓名，只改 `name`，不新建档案；问出名字前用的临时名（如「白玉广场执事甲」）留在 `aliases` 里。
- 无名角色不共用档案：同一职位出现在不同地点，就是不同的 `npc_xxx`，知情也不互通。
- 认错了要合并：`merge_character {from, to}`；只是改名：`rename_character {from, to}`（主角不可改名）。

### 双时态规则

- 状态变化时，旧记录填 `validTo`，新记录 `validTo = null`；
- 当前值 = `validTo` 为空的最新记录；
- 历史值只用于追溯，不覆盖当前值。

### 知情档位

隔离不再按「具体谁」记，而是按**知情档位**：

| 档位 | 谁够格知道 |
|---|---|
| `protagonist` | 只有主角 |
| `intimate` | 托付过底牌、生死与共的人，以及主角 |
| `friend` | 共同守过密、长期同场的人，以及更高档位 |
| `public` | 人人皆知，没有隔离 |

- 角色有 `access`，条目也有 `access`；**角色档位 ≥ 条目档位 = 默认知情**。
- 主角固定 `protagonist`，永远知道；NPC 默认 `public`。
- **条目按剧情定档，不按类型一刀切**：
  1. 当众发生、公开场合、旁人能看到 → `public`；
  2. 没人看见或刻意隐藏 → `protagonist`；
  3. 有旁人在场且被看见 → 按在场者中与主角关系最疏远的那一档写 `access`；
  4. 拿不准 → `protagonist`。
- **正文明确优先，正文沉默时按台账**：
  - 正文明确写某人不知道 / 被瞒着 → 当前正文按不知道；台账不改档位（档位级不记个人例外）。
  - 正文明确写某人知道 → 当前正文按知道；只有扩散到某个范围时，才用 `reveal` 放宽档位。
  - 正文没提 → 按档位：够格的默认知情，不够格的默认不知情。
- 两个典型错误由档位兜住：
  1. 旧秘密离开上下文后，叙事者没看到，把知情的 NPC 写成不知道；
  2. 秘密还在正文里反复出现，「只有谁知道」被稀释，正文又没重新写明谁不知情，叙事者就把不相干的人写成知道。
  反复提及不等于公开；在场、看到、沉默都不等于知情。
- `reveal` 把条目档位放宽到目标所在档（目标公开级就是公开级）。只用于主动告知、主动展示、当众承认；同档其他人也会知道，这是档位级的近似。
- **被动暴露不降档**：被路人撞见、偷听不触发 `reveal`，保持原档位。只被一个公开级目击者看到，不该等于全城知道；代价是这个目击者超出上下文后可能漏提，属于可接受的漏判。
- **只告诉一个人会按该人档位记录**：同档其他人也会知道；不引入个人级 `knownBy`。这是有意接受的精度代价。
- 承诺保密不改变谁知道，只约束「会不会传出去」。
- 档位降级按「直接遗忘」处理；升级则自动获得该档旧秘密的默认知情。
- 档位与关系摘要解耦：`set_relation` 只记叙事摘要，不参与档位判定；档位只看知情与信任证据。
- 功法的建档来源限制为主角自己起名或正文明确写出的学得；主角功法默认 `public`，刻意隐瞒时才写 `protagonist`。
- 代码层拒绝给 NPC 写 `add_skill`；NPC 只保留身份字段与在场状态。
- 关系只保存在主角身上，只记 `type` 与 `access`；称呼（`address` / `callsPlayer`）不记台账。NPC 的 `relations` 一律为空；旧数据里的 NPC→玩家关系在加载时合并到主角侧，NPC↔NPC 关系丢弃。

#### 档位变化标准

档位是**信息权限**，不是 NPC 与主角的关系称谓。`set_tier` 必须写 `reason`，只接受下表理由：

| 变化 | 允许理由 |
|---|---|
| `public → friend` | 共同守密 / 主动告知底牌 / 长期同场 |
| `friend → intimate` | 生死与共 / 主动托付 / 共同守密 |
| `public → intimate` | 只允许生死与共 / 主动托付 |
| `intimate → friend` | 泄密 / 背叛 / 明确疏远 |
| `friend → public` | 泄密 / 背叛 / 长期无往来 |

防漂移：

- 分歧、吵架、语气变差**不降档**，也不记账；关系称谓真的变了才写 `set_relation`；
- 同一次结算每个角色最多改一档；
- 默认需要连续 **2 次同向证据**才实际升降档（设置项「档位变化所需次数」，1–5，1 = 立即）；待确认计数在 3 个故事日内有效，遇到不同目标就重置；
- 反向改动需间隔 3 个故事日，里程碑（生死与共/主动托付/泄密/背叛）可越过；
- 「长期无往来」需至少 30 个故事日，且期间没有同场记录；
- 同档 `set_tier` 是空操作，不写历史。

### 猜疑与误信

档位只表达「够不够格知道」。个别角色的怀疑、错误认知单独存在 `beliefs` 里，不影响档位：

| 状态 | 含义 |
|---|---|
| `suspects` | 怀疑，必须带依据；可以试探但不能说破 |
| `false_belief` | 错误认知；可以笃定地说错话 |

```json
"items": [
  {
    "id": "i_orb",
    "name": "混沌珠",
    "access": "protagonist",
    "beliefs": {
      "wang_shop": { "state": "false_belief", "belief": "林远只是个没背景的外门弟子" }
    }
  }
]
```

可带 `access` 的实体：

- `characters[主角].state[field]`（隐藏修为等）
- `characters[主角].items[]`（暗藏法宝）
- `characters[主角].relations[]`（秘密同盟）
- `characters[主角].skills[]`（隐藏功法、底牌招式）

示例：

```json
{
  "state": {
    "realm": { "current": "筑基一层", "access": "protagonist", "history": [] }
  },
  "items": [
    { "id": "i_orb", "name": "混沌珠", "access": "intimate" }
  ],
  "relations": [
    { "target": "su_wan", "type": "秘密同盟", "access": "intimate" }
  ]
}
```

行为：

- 受限字段/物品/关系/功法**不进入公开角色块**，只出现在【秘密知情】里；
- 角色块标题后直接标该角色的知情档位（主角级/亲密级/朋友级/公开级），不再输出内部重要性层级「主角/重要/配角」；
- 只有名字和档位、没有任何状态的角色块不注入（旁白里的临时描述、路人），但仍保留在【场景】的在场名单里；
- 【秘密知情】每条写 `档位；默认知情=…；默认不知情=…`，主角级写「只有你知道」；注入头部用一句说明各档位的默认可知情范围（公开级人人可知 → 主角级只有你知道），并声明以名单为准；
- 未写 `access` 时：字段/物品/关系/功法按 `public`；灵根、体质、境界进度按 `protagonist`（进度属于内景，NPC 看不出）。
- `reveal` 把条目档位放宽到 `to` 所在档；同档其他人也会知道。

`reveal` 支持这些目标：

```json
{ "op": "reveal", "character": "user", "field": "realm", "to": "su_wan", "method": "战斗中暴露" }
{ "op": "reveal", "item": "i_orb", "to": "su_wan", "method": "被看见" }
{ "op": "reveal", "relation": "su_wan", "to": "wang_shop", "method": "被迫承认" }
{ "op": "reveal", "skill": "sk_qingmu", "to": "su_wan", "method": "当面运功" }
```

- `reveal` 在正文明确写某人知道了时使用，把档位放宽到该人所在档；同档其他人也会知道。
- 每次成功的 `reveal` 都会在状态栏和 toastr 弹提醒，不会静默改知情。

---

## 2. 提取输出（ops）

提取模型只输出 JSON：

```json
{
  "scene": { "time": "夜里", "advance": { "days": 2 }, "place": "黑风寨", "participants": ["user", "su_wan"] },
  "ops": [
    { "op": "set", "character": "user", "field": "realm", "value": "炼气七层", "validFrom": "第三日 夜", "evidence": "msg:87", "confidence": 0.9 },
    { "op": "add_item", "character": "user", "item": { "id": "i_sword", "name": "青锋剑" }, "validFrom": "第一日 晨", "evidence": "msg:2", "confidence": 0.9 },
    { "op": "add_item", "character": "user", "item": { "id": "i_spirit", "name": "灵石", "kind": "currency", "quantity": 120, "unit": "枚" }, "validFrom": "第一日 晨", "evidence": "msg:3", "confidence": 0.9 },
    { "op": "adjust_item", "item": "i_spirit", "delta": -30, "reason": "购买回气丹", "validFrom": "第三日 夜", "evidence": "msg:4", "confidence": 0.95 },
    { "op": "add_skill", "character": "user", "skill": { "id": "sk_qingmu", "name": "青木诀", "type": "technique", "level": "第三重" }, "validFrom": "第一日 晨", "evidence": "msg:5", "confidence": 0.9 },
    { "op": "set_skill", "character": "user", "skill": "sk_qingmu", "level": "第四重", "validFrom": "第四日 晨", "evidence": "msg:6", "confidence": 0.9 },
    { "op": "move_item", "item": "i_sword", "to": "su_wan", "validFrom": "第四日 晨", "evidence": "msg:90", "confidence": 0.9 },
    { "op": "set_relation", "from": "user", "to": "su_wan", "type": "同门", "validFrom": "第五日 夜", "evidence": "msg:120", "confidence": 0.9 },
    { "op": "reveal", "item": "i_orb", "to": "su_wan", "method": "战斗中被迫使用", "validFrom": "第三日 夜", "evidence": "msg:92", "confidence": 0.95 },
    { "op": "set_scene", "scene": { "time": "夜里", "advance": { "days": 2 }, "place": "黑风寨", "participants": ["user", "su_wan"] } }
  ]
}
```

规则层会校验：

- 每个 op 必须有 `evidence` 与 `confidence`；
- `evidence: msg:N` 必须在当前消息范围内；
- `confidence < 0.5` 拒绝，`0.5–0.7` 待复核，`≥0.7` 应用；
- 未知 op、缺字段直接拒绝。

### 增量结算与版本日志

- 台账用 `meta.lastProcessedMessage` 记录上次结算到哪条消息；
- 每次只取它之后的新消息，再额外带前 3 条作上下文；
- 上下文消息在提取提示里标记 `[context]`，模型不得为它们生成 op；
- 首次结算最多回看 20 条，避免一次性把整段聊天灌进去。

每次结算还会向 `meta.history` 追加一条记录：

```json
{ "to": 42, "anchor": "9c2e…", "prefixHash": "a3f1…", "ops": [...], "scene": {...} }
```

- `anchor` 是第 42 条消息**自身**正文的哈希，用来判断这一条有没有被改过；
- `prefixHash` 是前 42 条消息的滚动哈希，只作为旧记录的兼容回退；
- 同一序号的不同 swipe 各留一条，按当前正文选中匹配的那条。

打开聊天或检测到消息变动时：

1. 旧记录如果前缀仍然匹配，自动补上 `anchor`；
2. 找到最后一条仍然匹配的记录 `to = k`；
3. 从空台账回放到 `k`，跳过已失效的记录；
4. `lastProcessedMessage = k`，下次只重抽 `k+1` 之后。

编辑某一轮不会再连坐后面的记录；失效的那一轮会出现在日志页的「正文已改」里，可以单独重算（`重算 #N`）。开启「正文改动后自动重算该条」时，编辑或切换 AI 回复会在 1.2 秒防抖后自动重跑这一条的提取。

酒馆的分支/检查点会复制当前 `chat_metadata`，所以版本日志会自动带到新聊天；新聊天长度就是分叉点，不需要手动操作插件。

`meta.history` 只保存在聊天 metadata 和导出 JSON 中，**不会进入提取提示**；健康页会显示日志条数与体积。

---

## 3. 注入装配

注入的 system 块由两部分组成：先放插件侧的叙事规则（台账与知情约束，来自设置或题材预设，独立于角色卡），再放台账。台账部分如下：

1. **规则头**：台账是玩家已知事实；`access` 只约束 NPC；字段名用题材预设的中文标签；
2. **场景**：时间、地点、在场角色；
3. **角色**：主角 + 在场角色全量按真相渲染；其他角色一行；
4. **秘密知情**：每条秘密一行，列出「知情 / 不知情 / 怀疑 / 错误认知」。

`【秘密知情】` 示例：

```text
- 你 持有 混沌珠 ｜ 主角级；只有你知道
```

这样比“按角色列认知”短得多，而且“谁不知道”一眼可见。

超出 token 预算时按以下顺序裁剪：

```
其他角色 → 非主角角色块 → 全部角色块 → 场景 → 秘密（最后整段丢）
```

---

