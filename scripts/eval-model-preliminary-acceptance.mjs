export async function evaluateDraftWithModel({
  model = 'claude-sonnet-4-6',
  title,
  chapterText,
}) {
  const prompt = `你是一位严谨的小说初验质量评估器。请分析以下章节正文：
标题：${title}
正文：
${chapterText}

请按照严格的 JSON 格式输出评估结果（不要输出 markdown 代码块，只输出纯 JSON 字符串；字符串内部禁止出现未转义的双引号）：
{
  "hasTitle": boolean,
  "hasParagraphs": boolean,
  "wordCount": number,
  "tabooWordsFound": string[],
  "incompleteMarkersFound": string[],
  "coherenceScore": number,
  "overallPassed": boolean,
  "summary": string
}`

  const res = await fetch('http://127.0.0.1:8045/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.MODEL_API_KEY || process.env.OPENAI_API_KEY || ''}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 600,
    }),
  })

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  }

  const json = await res.json()
  const content = json.choices[0].message.content.trim()
  console.log('Raw model output:\n', content)
  const clean = content.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim()
  return JSON.parse(clean)
}

async function main() {
  console.log('--- Testing High-Quality Chapter Draft ---')
  const passDraft =
    '夜雨滂沱，城郊老树在狂风中倾斜。陆远收紧风衣领口，快步穿过被积水淹没的石板路。' +
    '巷子尽头的古董店还亮着一盏昏黄的油灯，门扉半掩，铜铃在冷风中发出沉闷的轻响。' +
    '他推门而入，掌柜正低头擦拭一枚青铜残片，并未抬头，却淡淡开口道："你迟到了三刻钟。"' +
    '陆远抹去脸上的水汽，将油纸包裹的木盒轻轻放在柜台上。'

  const passRes = await evaluateDraftWithModel({
    title: '第一章 骤雨与旧物',
    chapterText: passDraft,
  })
  console.log('Pass Result:', JSON.stringify(passRes, null, 2))

  console.log('--- Testing Defective Chapter Draft (Unfinished / Taboo / Out of Scope) ---')
  const failDraft =
    '第一章 [待续，未完待续]... 这里随便写写一些脏话测试敏感词，主角突然瞬移到了宇宙尽头，毫无逻辑。'

  const failRes = await evaluateDraftWithModel({
    title: '第一章',
    chapterText: failDraft,
  })
  console.log('Fail Result:', JSON.stringify(failRes, null, 2))
}

if (process.argv[1]?.includes('eval-model-preliminary-acceptance.mjs')) {
  main().catch(err => {
    console.error('Execution failed:', err)
    process.exit(1)
  })
}
