import { buildChapterGoalReviewPrompt } from '../../shared/chapter-goal-review'
import type { ReviewRevisionContext } from '../../shared/review-revision-generation'
import { writingLanguageText as promptLanguageText, type WritingLanguage } from '../../shared/writing-language'
import type { PromptTemplate } from '../builtin-prompt-templates'
import type { ReviewRevisionMaterial } from '../workflows/chapter-materials'
import { ReviewPromptBuilder } from './prompt-builder'

export function appendReviewLengthGuidance(prompt: string, language: WritingLanguage): string {
  const lengthGuidance = promptLanguageText(language,
    '【篇幅提示】单纯超出约定字数只作非阻断提示，不属于必须修复的内容缺陷，不得仅因此要求修稿或记为 error/warning。完整性和作者事实优先；真实冗余复述、事实冲突和缺失事件仍须按原规则举证并报告。',
    '[Length guidance] Exceeding the agreed length alone is a nonblocking notice, not a mandatory content defect. Do not demand revision or mark error/warning solely for length. Completeness and author facts take priority; still provide evidence and report genuine redundancy, factual conflicts and missing events under the existing rules.')
  return `${prompt}\n\n${lengthGuidance}`
}

export function buildOrdinaryReviewPrompt(input: {
  context: ReviewRevisionContext
  template: PromptTemplate
  admitted: readonly ReviewRevisionMaterial[]
}): { systemPrompt: string; prompt: string } {
  const { context: frozen, template, admitted } = input
  const language = frozen.writingLanguage
  const builder = new ReviewPromptBuilder(template, language)
    .withChapterContent(frozen.source.content)
    .withCharacterStates(frozen.characterStates)
    .withGlobalSummary(admitted.filter(material => material.category === 'finalized-history').map(material => material.text).join('\n\n'))
    .withWorldBuilding(frozen.worldbuilding)
    .withReviewFocus(frozen.authorInputs.find(author => author.id === 'review-focus')?.text || '')
  const prompt = [
    builder.build(),
    ...admitted.filter(material => material.category !== 'finalized-history').map(material => material.text),
    promptLanguageText(language,
      '【作者设定优先】【作者确认项目配置】与【世界观设定】是权威事实；作者角色状态按标注时点理解；历史派生摘要不能覆盖作者事实。报告矛盾前，须说明作者设定或其必然前提与正文对同一对象、时点及条件的陈述为何不能同时成立，并纳入正文已有的兼容描述。正文未再次说明、未触碰或未明确位置，不证明权威状态已改变；存在合理兼容解释时，不得将推断当作事实矛盾要求修稿。新进展可以发生在同一时段或地点；作者未明确要求更换时点或场景时，不得强加，也不能因未更换就断言没有推进。若正文确实与作者事实或由其必然推出的前提矛盾，必须报告为 error 或 warning；即使蓝图、章节计划或冻结目标写法相反，也不得因此放过。',
      '[Author settings take priority] The author-confirmed project configuration and the worldbuilding settings are authoritative facts; author character states apply at their annotated time; historical derived summaries cannot override author facts. Before reporting a contradiction, explain why the author setting or its necessary premise and the draft cannot both be true for the same subject, time and conditions, considering compatible descriptions already present in the draft. Mere omission, lack of contact or an unstated location does not establish that an authoritative state has changed. Where a reasonable compatible interpretation exists, do not demand revision based on an inferred factual contradiction. New progress can occur within the same time period or location; do not require a time or scene change that the author has not specified, or infer no progress merely because neither changed. If the draft truly contradicts an author fact or a premise that necessarily follows from it, report it as an error or warning, even when a blueprint, chapter plan or frozen goal says otherwise.'),
    promptLanguageText(language,
      '【证据锚点硬约束】每个 error/warning 的 items[].quote 必须是待审正文中逐字连续、且全文仅出现一次的单一摘录；不得拼接多个位置、改写原文或包含省略号。优先选择足以证明问题的最短完整句。goalReviews[].evidence 中的每个 quote 也必须分别满足上述约束；需要多处证据时拆成多个 evidence 项，绝不可在一个 quote 中拼接。',
      '[Strict evidence-anchor constraint] Each items[].quote for an error/warning must be one verbatim, contiguous excerpt that occurs exactly once in the draft under review. Do not combine multiple locations, rewrite the text, or include ellipses. Prefer the shortest complete sentence that proves the issue. Every quote in goalReviews[].evidence must independently satisfy the same constraint; when multiple excerpts are needed, use separate evidence entries and never combine them in one quote.'),
    promptLanguageText(language,
      '【时间一致性检查】只核对正文实际表达的时间精度。宽泛回指只表达先后关系时，核对事件顺序即可；顺序一致则不补推更精确的历史日期或时段。明确日期、时段和相对时间须对照作者时点与前驱同一事件，不能假设另有同类事件来放行。正文自身明确写出的跨日或时间间隔优先于同日默认；作者和正文都未交代时，按前章结尾同日紧接核对，仍须报告与作者明确时点的冲突。需要具体时点时，使用事件自身或前面最近的明确时点，不借用更早段落时点；无法确定时保留不确定性。AI 建议中的具体时点不构成来源依据。同一事件的多处日期或状态须结合正文已交代的变化核对。真实冲突报 error 或 warning：quote 定位当前正文的冲突句；description 简述来源章节、同一事件及其必要时间引文和冲突依据。修法不得新增来源不支持的具体时点或原因。',
      '[Temporal consistency checks] Check only the time precision actually expressed in the draft. When a broad reference expresses only before/after order, check that order; if consistent, do not infer a more precise historical date or time period. Check explicit dates, time periods and relative times against author timing and the same predecessor event; do not excuse conflicts by inventing another similar event. An explicit day change or time gap in the manuscript takes priority over the same-day default. When neither author nor manuscript states one, check a same-day continuation from the previous ending, still reporting conflicts with explicit author timing. When a specific time is needed, use the event itself or the nearest preceding explicit time; do not borrow a time from before that anchor. Preserve uncertainty when it cannot be determined. A specific time proposed by AI is not source evidence. Check multiple dates or states for the same event against changes established in the prose. Report genuine conflicts as error or warning: quote the conflicting current-draft sentence; briefly give the source chapter, same event, necessary time excerpts and conflict evidence in description. Remedies must not add a specific time or cause unsupported by the sources.'),
    promptLanguageText(language,
      '【pass 依据】pass 简述实际核对的对象、来源与对照结果即可，不必逐项展开无问题内容的历史时点；不得照抄格式示例或用无依据套话替代核对。',
      '[Pass evidence] Briefly state the actual subject, source checked and comparison result for a pass; do not expand the historical timing of each problem-free detail. Never copy the format example or substitute unsupported stock conclusions for checking.'),
    buildChapterGoalReviewPrompt(frozen.frozenGoals, language),
  ].join('\n\n')
  return { systemPrompt: builder.getSystemRole(), prompt: appendReviewLengthGuidance(prompt, language) }
}

export function buildReviewRebuildPrompt(language: WritingLanguage, reviewPrompt: string): string {
  const instruction = promptLanguageText(language,
    '上一轮审稿输出未通过合同校验，已被丢弃，不得引用或续接。请重新完成原始审稿任务。',
    'The previous review output failed contract validation and was discarded. Do not quote or continue it; complete the original review task again.')
  const contract = promptLanguageText(language,
    '【硬性要求】只重新输出一个完整审稿 JSON，根字段为 summary、items、goalReviews：summary 不超过 120 字符；items 为 1–10 条，每条按 category、quote、description、severity(error|warning|pass) 顺序输出，先举证说明判断依据，最后确定 severity；description 不超过 200 字符，quote 仅 pass 可省略，error/warning 必须提供且不超过 160 字符。description 必须说明当前正文的具体客观缺陷才可标为 error/warning；若结论为合理、符合要求或未发现问题，该项应为 pass 或省略。全文未发现具体问题时，保留一条 pass；确有客观问题仍须按严重程度报告 error/warning。goalReviews 按上方最初冻结清单逐项返回 id、status、description、evidence，不受 items 条数限制；只用原始待审正文核对。不得输出这些约定以外的字段、Markdown、解释或思考过程。',
    '[Hard requirement] Output one complete review JSON with root fields summary, items and goalReviews: summary within 120 characters; items 1–10 entries in category, quote, description, severity order (error|warning|pass), with evidence and explanation before severity; description within 200 characters; quote is optional only for pass and required (≤160 characters) for error/warning. Use error/warning only when description identifies a specific objective defect in the current draft. If the conclusion is reasonable, meets requirements, or no issue found, use pass or omit the item. If the whole draft has no specific issue, keep one pass item. Still report genuine objective problems as error/warning according to their severity. goalReviews must cover the original frozen checklist above with id, status, description and evidence, without the general items count limit; use only the original draft for evidence. No fields outside these contracts, Markdown, explanation, or reasoning.')
  return [instruction, promptLanguageText(language, '【原始审稿任务】', '[Original review task]'), reviewPrompt, contract].join('\n\n')
}
