import { chapterTimeContinuity } from './chapter-time-continuity'
import { draftTargetUnitRange, countDraftUnits } from './draft-units'
import { sanitizeDraftText, type DraftVisibleTextVersion } from './draft-visible-text'
import { writingLanguageText as promptLanguageText, type WritingLanguage } from './writing-language'
import { draftContinuationBudget } from './draft-generation-policy'

type ChapterHeading = Readonly<{
  lineIndex: number
  from: number
  to: number
  markdownLevel: number
}>

function parseChapterHeading(line: string, lineIndex: number): ChapterHeading | null {
  const match = /^\s*(?:(#{1,6})[\t ]+)?(?:第\s*([1-9]\d*)(?:\s*[–—-]\s*([1-9]\d*))?\s*章|Chapters?[\t ]+([1-9]\d*)(?:[\t ]*[–—-][\t ]*([1-9]\d*))?)(?=[\t ]*(?:[:：.．—-]|$))/iu.exec(line)
  if (!match) return null
  // Bare headings must use the production outline's explicit title separator.
  if (!match[1] && !/^[\t ]*[:：]\s*\S/u.test(line.slice(match[0].length))) return null
  const from = Number(match[2] ?? match[4])
  const to = Number(match[3] ?? match[5] ?? from)
  return {
    lineIndex,
    from,
    to,
    markdownLevel: match[1]?.length ?? 0,
  }
}

/**
 * Project an explicitly chapter-structured synopsis onto one chapter without
 * cutting any selected section. Ambiguous or unlocatable structures stay
 * verbatim so author facts are never discarded on a guess.
 */
export function synopsisForDraftChapter(synopsis: string, chapterNumber: number): string {
  // Quoted examples can contain chapter-like headings; do not interpret them.
  if (/^\s*(?:`{3,}|~{3,})/mu.test(synopsis)) return synopsis.trim()
  const lines = synopsis.trim().split(/\r?\n/u)
  const headings = lines
    .map((line, lineIndex) => parseChapterHeading(line, lineIndex))
    .filter((heading): heading is ChapterHeading => heading !== null)
  if (headings.length < 2) return synopsis.trim()

  const firstLevel = headings[0]!.markdownLevel
  const hasConsistentHeadingStyle = headings.every(heading => heading.markdownLevel === firstLevel)
  const hasStrictChapterOrder = headings.every((heading, index) => (
    heading.from <= heading.to
    && (index === 0 || heading.from > headings[index - 1]!.to)
  ))
  const currentHeadings = headings.filter(heading => heading.from <= chapterNumber && chapterNumber <= heading.to)
  if (!hasConsistentHeadingStyle || !hasStrictChapterOrder || currentHeadings.length !== 1) {
    return synopsis.trim()
  }

  const headingsByLine = new Map(headings.map(heading => [heading.lineIndex, heading]))
  let activeRange: Pick<ChapterHeading, 'from' | 'to'> | null = null
  const projected: string[] = []
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!
    const chapterHeading = headingsByLine.get(lineIndex)
    if (chapterHeading) {
      activeRange = chapterHeading
    } else {
      const markdownHeading = /^\s*(#{1,6})\s+/u.exec(line)
      if (markdownHeading && (firstLevel === 0 || markdownHeading[1]!.length <= firstLevel)) {
        activeRange = null
      }
    }
    if (
      activeRange === null
      || (activeRange.from <= chapterNumber && chapterNumber <= activeRange.to)
    ) projected.push(line)
  }
  return projected.join('\n').trim()
}

export interface WriterChapterInfo {
  chapterNumber: number
  title: string
  role: string
  purpose: string
  characters: string[]
  keyEvents: string
  suspenseHook?: string
  userGuidance?: string
}

/** Keep workflow metadata out of both initial and continuation writer prompts. */
export function toWriterChapterInfo(chapterInfo: WriterChapterInfo): WriterChapterInfo {
  return {
    chapterNumber: chapterInfo.chapterNumber,
    title: chapterInfo.title,
    role: chapterInfo.role,
    purpose: chapterInfo.purpose,
    characters: chapterInfo.characters,
    keyEvents: chapterInfo.keyEvents,
    suspenseHook: chapterInfo.suspenseHook,
    userGuidance: chapterInfo.userGuidance,
  }
}

export function chapterLengthContractText(writingLanguage: WritingLanguage, targetUnits: number): string {
  const { minimum, maximum } = draftTargetUnitRange(targetUnits)
  const aimLow = Math.round(targetUnits * 0.85)
  return promptLanguageText(
    writingLanguage,
    `【本章篇幅合同】\n目标 ${targetUnits} 字（按汉字计，不含标点）；请写到约 ${aimLow}–${targetUnits} 字。${maximum} 字是参考上限，超出时只提示并保留完整正文；少于 ${minimum} 字会被退回。篇幅紧张时，压缩描写与过渡、减少场景数量，而不是删掉必需事件；本章蓝图中的全部作者任务和必需事件都要落实，不得删除、改写或截断，也不要为凑字数增加无关内容。`,
    `[Chapter length contract]\nTarget: ${targetUnits} words (counted as words, excluding punctuation); aim for about ${aimLow}-${targetUnits} words. ${maximum} words is a reference maximum; longer complete drafts are kept with a notice. Drafts under ${minimum} words are rejected. When space is tight, compress description and transitions and use fewer scenes rather than dropping required events; realize every author task and required event in the chapter blueprint without deleting, rewriting, or truncating them, and do not add unrelated content to fill space.`,
  )
}

/**
 * 固定解释规则与作者原文分开角色；规则仅按写作语言和是否有前驱分支。
 * 首稿、续写、压缩和历史恢复共用规则，但不扩大各次请求的操作范围。
 */
export function chapterExecutionContractText(writingLanguage: WritingLanguage, chapterInfo: WriterChapterInfo): {
  rules: string
  authorItems: string
} {
  const executionItems = [
    { zhCN: '必需事件', enUS: 'Required events', value: chapterInfo.keyEvents },
    { zhCN: '章节钩子', enUS: 'Chapter hook', value: chapterInfo.suspenseHook },
    { zhCN: '作者本章指导', enUS: 'Author guidance for this chapter', value: chapterInfo.userGuidance },
  ]
  const zhItems = executionItems.flatMap(item => item.value?.trim() ? [`- ${item.zhCN}: ${item.value}`] : []).join('\n')
  const enItems = executionItems.flatMap(item => item.value?.trim() ? [`- ${item.enUS}: ${item.value}`] : []).join('\n')
  const hasPredecessor = chapterInfo.chapterNumber > 1
  const rules = promptLanguageText(
    writingLanguage,
    `【本章执行合同】
【作者本章任务】按作者原文含义遵循：明确要求在本章发生的事件与收束须由正文动作或结果落实；持续状态、知情边界、禁止事项和文风要求是叙述约束，不要仅为证明遵守而新增或反复确认动作、对话或解释。悬念按原文揭示时点处理，留待后文的事不得提前写成已完成；作者明确要求的回顾、回忆、动作、揭示或反复仍按原文执行。后一项动作必须承接正文实际形成的物品持有、人物知情和计划完成状态。
【本章可推进的事件】可以写与既有事实相容的新行动和结果；普通无代价情节无需增加代价。${hasPredecessor ? `
【前文已定稿事实】本章蓝图、章节计划或必需事件的措辞与已定稿章节中确立的事实（包括作者在定稿中的最新更正）冲突时，以定稿事实为准：按与定稿事实一致的方式落实该条目，不得把已撤回、取消或被取代的计划追溯写成已执行。人物身份、物品持有、人物知情、付款与收回及事件时点应承接前文；付款、收回、失去等状态改变必须按事件先后写清，不能把同一笔钱款或物品同时写成已收回与仍然失去。
【前文计划与本章决定】人物的等待、暂停或撤回是当时的计划状态，不是作者禁令；本章可以先写出人物基于既有事实作出的新决定、理由及连续性依据，再推进或替换计划，但不能违反作者明确禁令、必需呈现或既成事实。
【本章事件兑现】作者或本章蓝图要求在本章发生的事件，必须在本章通过具体行动及其实际后果发生；复述、确认或记账前章已发生的结果不能替代本章要求发生的动作或结果。
【前文待核实问题】定稿只发现疑点、提出猜测或写明待核实时，不能把某一解释、原因或哪一方出错写成已确认事实；本章可以通过新线索和调查推进并解决疑点，但须先写出与既有事实相容且足以支持结论的核验过程与证据，证据不足时保留疑点，结论的方向、时间和因果前后必须一致。
${chapterTimeContinuity('zh-CN')}` : ''}
【操作边界】本合同不扩大本次请求的操作范围：续写及无进展恢复只接续已有正文，不重写旧文；已达目标篇幅时只补完断句并收束。压缩只删减既有正文，不新增情节或修补缺失事件。`,
    `[Current-chapter execution contract]
[Author tasks for this chapter] Follow the author text according to its meaning: events and outcomes explicitly required in this chapter must be realized through manuscript action or outcome. Ongoing states, knowledge boundaries, prohibitions, and style requests are narrative constraints; do not add or repeatedly confirm actions, dialogue, or explanations merely to prove compliance. Follow the reveal timing specified by the author; do not present what is reserved for later chapters as already completed. Still carry out explicitly requested recollections, flashbacks, actions, reveals, or repetition. Each later action must continue from the item ownership, character knowledge, and plan-completion state actually established in the prose.
[Events this chapter may advance] New actions and outcomes consistent with established facts are allowed. Ordinary events need no added cost.${hasPredecessor ? `
[Established finalized facts] When the chapter blueprint, chapter plans, or the wording of required events conflict with facts established in finalized chapters (including the author's latest corrections in them), the finalized facts prevail: realize the item consistently and never retroactively portray a withdrawn, cancelled, or superseded plan as executed. Preserve identities, item ownership, character knowledge, payments and recoveries, and event times from prior prose. Keep the order and result of paying, recovering, or losing money or property consistent; do not describe the same amount or item as both recovered and still lost.
[Prior plans and current decisions] Characters' waiting, paused, or withdrawn plans describe their prior intention, not an author prohibition; this chapter may first show a new decision grounded in established facts, the character's reason, and continuity evidence, then advance or replace the plan without violating explicit author prohibitions, required on-page events, or completed facts.
[Required events in this chapter] Events required by the author or this chapter blueprint to happen in this chapter must happen through concrete action and actual consequence here; merely repeating, confirming, or accounting for an outcome already completed in an earlier chapter cannot replace the action or outcome required in this chapter.
[Unverified prior questions] If a finalized chapter only discovers a discrepancy, raises a suspicion, or leaves a question for verification, do not present an explanation, cause, or which side is wrong as confirmed. This chapter may pursue new clues and resolve the question, but first show a verification process and evidence sufficient for a conclusion consistent with established facts; otherwise keep it unresolved. The conclusion's direction, timing, and causality must remain consistent throughout.
${chapterTimeContinuity('en-US')}` : ''}
[Operation boundary] This contract does not expand the current request's scope: continuation and no-progress recovery only append to existing prose without rewriting it; at the target length, only finish the truncated sentence and close. Condensing only cuts existing prose and must not add plot or repair missing events.`,
  )
  return { rules, authorItems: promptLanguageText(writingLanguage, zhItems, enItems) }
}

/** 自动续写与压缩修订共用的作者资料块：本章蓝图、全局写作要求、文风、小说配置事实与章节材料。 */
export function draftAuthorMaterialBlock(writingLanguage: WritingLanguage, material: {
  chapterInfo: WriterChapterInfo
  globalGuidance: string
  writingStyle: string
  novelConfigFacts: string
  chapterMaterials: string
  /** 生成前定稿对账注入块；无对账时为空。 */
  reconciliation?: string
}): string {
  const reconciliation = material.reconciliation ? `${material.reconciliation}\n\n` : ''
  return promptLanguageText(
    writingLanguage,
    `【本章蓝图】
${JSON.stringify(material.chapterInfo, null, 2)}

【全局写作要求】
${material.globalGuidance}

【文风要求】
${material.writingStyle || '（无）'}

【文风适用边界】
- 文风仅用于选择表达方式，不是新增事实或事件要求；无需逐条强行兑现。
- 作者明确事实与指导、实际前文、本章关键因果和本章篇幅优先。不得用文风改写这些内容或仅为兑现文风增加场景、动作或事件；不得把作者明确事实或要求降格为推测。

【小说配置事实】
${material.novelConfigFacts}

${material.chapterMaterials}

${reconciliation}${chapterExecutionContractText(writingLanguage, material.chapterInfo).authorItems}`,
    `[Current chapter blueprint]
${JSON.stringify(material.chapterInfo, null, 2)}

[Project-wide writing guidance]
${material.globalGuidance}

[Writing style]
${material.writingStyle || '(none)'}

[Writing-style applicability]
- Writing style selects expression only; it adds no facts or events, and not every item must be forced into the manuscript.
- Explicit author facts and guidance, actual prior prose, the chapter's key causality, and its target length take priority. Do not use style guidance to rewrite them, relabel explicit author facts or requirements as guesses, or add scenes, actions, or events merely to satisfy style guidance.

[Novel configuration facts]
${material.novelConfigFacts}

${material.chapterMaterials}

${reconciliation}${chapterExecutionContractText(writingLanguage, material.chapterInfo).authorItems}`,
  )
}

export type DraftPromptMaterial = Parameters<typeof draftAuthorMaterialBlock>[1]

export function buildDraftContinuationPrompt(params: DraftPromptMaterial & {
  writingLanguage: WritingLanguage
  targetChars: number
  compositionVersion: DraftVisibleTextVersion
  draft: string
  recoveryPending: boolean
}): { prompt: string; remaining: number; ceiling: number; allowance: number } {
  const { remaining, ceiling, allowance } = draftContinuationBudget(countDraftUnits(params.draft), params.targetChars)
  const draft = params.draft, recoveryPending = params.recoveryPending
  const visibleDraft = sanitizeDraftText(draft, params.compositionVersion)
  const recoveryInstruction = recoveryPending
    ? promptLanguageText(
        params.writingLanguage,
        '上一轮续写达到输出上限且没有增加足够的新正文，已被全部丢弃。\n'
          + '这是本次任务唯一一次无进展恢复机会：请直接推进下一事件、动作或对话，禁止复述已写末尾。\n\n',
        'The previous continuation reached the output limit without adding enough new prose, so it was discarded in full.\n'
          + 'This is the only no-progress recovery attempt: advance directly to the next event, action, or line of dialogue without repeating the existing ending.\n\n',
      )
    : ''
  const lengthInstruction = remaining > 0
    ? promptLanguageText(
        params.writingLanguage,
        `- 本次续写补足约 ${allowance} 字即可，新增部分绝不超过 ${ceiling} 字；接近时按本章结束状态收束，停在完整句子和自然段落末尾。`,
        `- Add about ${allowance} words in this continuation and never more than ${ceiling}; as you approach that length, close at the chapter's ending state and stop at the end of a complete sentence and paragraph.`,
      )
    : promptLanguageText(
        params.writingLanguage,
        `- 本章已达到目标篇幅：只补完被截断的句子并收束当前场景，新增部分约 ${allowance} 字以内、绝不超过 ${ceiling} 字，不要展开新事件。`,
        `- The chapter has reached its target length: only finish the truncated sentence and close the current scene in about ${allowance} words or fewer, never more than ${ceiling}; do not start new events.`,
      )
  const authorMaterial = draftAuthorMaterialBlock(params.writingLanguage, params)
  const lengthContract = chapterLengthContractText(params.writingLanguage, params.targetChars)
  const continuationPrompt = promptLanguageText(
    params.writingLanguage,
    `${recoveryInstruction}请无缝续写当前章节正文。

【硬性要求】
- 只输出新增正文，不要复述已写内容。
- 根据下方本章已写正文全文，从末尾自然接下去，保持同一场景逻辑或合理转场。
${lengthInstruction}
- 不要输出标题、解释、总结、Markdown、思考过程或“点我继续”。
- 避免重复已写正文中的整句、整段、动作链和意象。
- 不提前写后续章节，只完成本章蓝图允许的内容。

${lengthContract}

${authorMaterial}

【本章已写正文全文】
${visibleDraft}`,
    `${recoveryInstruction}Continue the current chapter seamlessly.

[Requirements]
- Output only new manuscript prose; do not repeat existing text.
- Read the full existing manuscript below and continue naturally from its ending, preserving the same scene logic or making a justified transition.
${lengthInstruction}
- Do not output a title, explanation, summary, Markdown, reasoning, or an interface continuation prompt.
- Avoid repeating complete sentences, paragraphs, action sequences, or imagery from the existing manuscript.
- Complete only the current chapter blueprint; do not advance later chapters.

${lengthContract}

${authorMaterial}

[Full existing manuscript for this chapter]
${visibleDraft}`,
  )
  return { prompt: continuationPrompt, remaining, ceiling, allowance }
}

export function buildDraftCondensePrompt(params: DraftPromptMaterial & {
  writingLanguage: WritingLanguage
  targetChars: number
  candidate: { text: string }
}): { prompt: string; originalUnits: number; aimUnits: number; ceilUnits: number; cutUnits: number; cutPercent: number } {
  const range = draftTargetUnitRange(params.targetChars)
  const originalUnits = countDraftUnits(params.candidate.text)
  const authorMaterial = draftAuthorMaterialBlock(params.writingLanguage, params)
  const lengthContract = chapterLengthContractText(params.writingLanguage, params.targetChars)
  // 压缩仅在 originalUnits > range.maximum 时触发，故 cutUnits > 0。
  const aimUnits = Math.round(params.targetChars * 0.89)
  const ceilUnits = Math.min(range.maximum, Math.max(Math.round(params.targetChars * 1.05), aimUnits + 1))
  const cutUnits = originalUnits - aimUnits
  const cutPercent = Math.round(cutUnits / originalUnits * 100)
  const condensePrompt = promptLanguageText(
    params.writingLanguage,
    `请把下面的本章正文压缩修订到可接受篇幅内，输出修订后的完整正文。

【篇幅现状】待压缩正文当前约 ${originalUnits} 字，超出上限。请压缩到约 ${aimUnits} 字（参考上限 ${ceilUnits} 字），即删去约 ${cutUnits} 字，约占全文 ${cutPercent}%。做法：逐段压缩，每段都删减描写、重复动作和心理，不要只删某一段。

【硬性要求】
- 修订后正文建议在 ${range.minimum}–${range.maximum} 字之间；完整事件和作者事实优先，仍超长时保留完整正文。按下方篇幅合同写到约 ${Math.round(params.targetChars * 0.85)}–${params.targetChars} 字。
- 保留本章蓝图中的全部必需事件、作者任务和情节事实，保留人物身份与关系，保留本章结尾的收束与钩子。
- 只通过删减冗余描写、重复动作、重复心理和啰嗦对话来缩短；不得新增情节、人物、设定或事实，不得改变事件顺序与因果。
- 只输出修订后的完整正文；不要输出标题、解释、总结、Markdown、思考过程或“点我继续”。

${authorMaterial}

${lengthContract}

【待压缩正文】
${params.candidate.text}`,
    `Condense the chapter manuscript below into the acceptable length and output the complete revised manuscript.

[Current length] The manuscript to condense is about ${originalUnits} words, above the ceiling. Condense it to about ${aimUnits} words (reference maximum ${ceilUnits} words), which means cutting about ${cutUnits} words, roughly ${cutPercent}% of the text. Method: condense paragraph by paragraph, trimming description, repeated actions, and repeated introspection in every paragraph rather than cutting only one part.

[Requirements]
- Aim for between ${range.minimum} and ${range.maximum} words; complete events and author facts take priority, and a longer complete manuscript is retained. Following the length contract below, aim for about ${Math.round(params.targetChars * 0.85)}-${params.targetChars} words.
- Keep every required event, author task, and plot fact from the chapter blueprint, keep character identities and relationships, and keep the chapter ending and hook.
- Shorten only by cutting redundant description, repeated actions, repeated introspection, and wordy dialogue; do not add plot, characters, setting, or facts, and do not change event order or causality.
- Output only the complete revised manuscript; do not output a title, explanation, summary, Markdown, reasoning, or an interface continuation prompt.

${authorMaterial}

${lengthContract}

[Manuscript to condense]
${params.candidate.text}`,
  )
  return { prompt: condensePrompt, originalUnits, aimUnits, ceilUnits, cutUnits, cutPercent }
}
