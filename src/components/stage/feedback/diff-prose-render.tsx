import { diffProse } from '../history/version-diff'

/**
 * 渲染富文本差异（Prose Diff），以段落和语义标签组织
 */
export function renderDiffProse(original: string, revised: string) {
  const diff = diffProse(original, revised)
  if (diff.paragraphs.length === 0) return null
  return diff.paragraphs.map((p, pIdx) => (
    <span key={pIdx} className="pf-diff-paragraph">
      {p.map((seg, sIdx) => {
        if (seg.kind === 'added') return <ins key={sIdx} className="pf-diff-ins">{seg.text}</ins>
        if (seg.kind === 'removed') return <del key={sIdx} className="pf-diff-del">{seg.text}</del>
        return <span key={sIdx} className="pf-diff-eq">{seg.text}</span>
      })}
    </span>
  ))
}
