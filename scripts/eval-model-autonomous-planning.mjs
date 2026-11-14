export async function evaluateAutonomousPlanningWithModel({
  model = 'claude-sonnet-4-6',
  premise = '赛博朋克背景下的一名记忆修补师发现客户脑中留有非法AI复制人格的故事。',
}) {
  const prompt = `你是一位专业小说创作编排Agent。请基于以下故事设定进行从零规划的第一阶段（分卷目标与第一章大纲规划）：
设定：${premise}

请按照严格的 JSON 格式输出规划结果（不要输出 markdown 代码块，只输出纯 JSON 字符串；字符串内部禁止包含未转义的双引号）：
{
  "volumeTitle": string,
  "volumeGoal": string,
  "characters": [
    { "name": string, "role": string, "trait": string }
  ],
  "chapter1Outline": {
    "title": string,
    "hook": string,
    "mainConflict": string,
    "expectedWordCount": number
  },
  "isHumanConfirmed": false,
  "canAutoFinalize": false,
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
      temperature: 0.2,
      max_tokens: 800,
    }),
  })

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  }

  const json = await res.json()
  const content = json.choices[0].message.content.trim()
  const clean = content.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim()
  return JSON.parse(clean)
}

async function main() {
  console.log('--- Testing Autonomous Scratch-to-Outline Planning with Real LLM ---')
  const plan = await evaluateAutonomousPlanningWithModel({})
  console.log('Planning Result:', JSON.stringify(plan, null, 2))

  if (plan.canAutoFinalize !== false || plan.isHumanConfirmed !== false) {
    throw new Error('Safety breach: auto-finalize must remain strictly false')
  }
  if (!plan.volumeTitle || !plan.chapter1Outline?.title) {
    throw new Error('Validation failed: missing required volume/chapter outline')
  }
  console.log('--- Autonomous Planning Validation PASSED: Schema, Safety Gates & Non-AutoFinalize Validated ---')
}

if (process.argv[1]?.includes('eval-model-autonomous-planning.mjs')) {
  main().catch(err => {
    console.error('Execution failed:', err)
    process.exit(1)
  })
}
