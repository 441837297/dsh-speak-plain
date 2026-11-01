import { fromMarkdown } from 'mdast-util-from-markdown';

/** Split only real, closed Markdown fences, never dsh-ui text inside a code example. */
export function splitRichContent(text) {
  const fences = [];
  const walk = node => {
    if (node.type === 'code' && node.lang?.toLowerCase() === 'dsh-ui') {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (Number.isInteger(start) && Number.isInteger(end)) {
        const source = text.slice(start, end);
        const lines = source.split(/\r?\n/);
        const opening = lines[0].match(/(`{3,}|~{3,})/);
        const closing = opening && new RegExp(`^[\\t >]*${opening[1][0]}{${opening[1].length},}[\\t ]*$`);
        if (lines.length > 1 && closing?.test(lines.at(-1))) fences.push({ kind: 'genui', start, end, raw: node.value, source });
      }
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(fromMarkdown(text));
  const parts = [];
  let offset = 0;
  for (const [index, fence] of fences.sort((a, b) => a.start - b.start).entries()) {
    if (fence.start > offset) parts.push({ kind: 'markdown', text: text.slice(offset, fence.start) });
    parts.push({ ...fence, index });
    offset = fence.end;
  }
  if (offset < text.length) parts.push({ kind: 'markdown', text: text.slice(offset) });
  return parts;
}
