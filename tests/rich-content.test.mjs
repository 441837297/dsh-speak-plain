import test from 'node:test';
import assert from 'node:assert/strict';
import { splitRichContent } from '../src/rich-content.js';

test('splits preserved dsh-ui fences and reconstructs exact mixed Markdown', () => {
  const input = '前文\n\n```dsh-ui\n{"items":[]}\n```\n\n后文 `code`\n\n~~~dsh-ui\n{"title":"第二块","items":[]}\n~~~';
  const parts = splitRichContent(input);
  assert.equal(parts.filter(p => p.kind === 'genui').length, 2);
  assert.equal(parts.map(p => p.kind === 'genui' ? p.source : p.text).join(''), input);
  assert.equal(parts.find(p => p.kind === 'genui').raw, '{"items":[]}');
});
test('dsh-ui examples inside outer Markdown/code fences stay literal', () => {
  for (const input of ['````markdown\n```dsh-ui\n{"items":[]}\n```\n````', '```js\nconst sample = "dsh-ui";\n```', '```dsh-ui\n{"items":[]}']) {
    assert.equal(splitRichContent(input).some(p => p.kind === 'genui'), false);
  }
});
test('CRLF and ordinary JSON code blocks preserve source order', () => {
  const input = '开头\r\n```json\r\n{"x":1}\r\n```\r\n```dsh-ui\r\n{"items":[]}\r\n```\r\n结束';
  const parts = splitRichContent(input);
  assert.equal(parts.filter(p => p.kind === 'genui').length, 1);
  assert.equal(parts.map(p => p.kind === 'genui' ? p.source : p.text).join(''), input);
});
