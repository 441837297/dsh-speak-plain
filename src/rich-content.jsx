import React, { useCallback, useMemo, useState } from 'react';
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives';
import {
  GenuiBlock, GenuiActionContext, ErrorBoundary,
  processGenuiSpec, isRenderableProcess,
} from '@changfenhuang/dsh-genui/embed';
import { splitRichContent } from './rich-content.js';

export const MARKDOWN_LABELS = {
  code: { copyLabel: '复制', copiedLabel: '已复制', toolbarLabels: { codeLabel: '代码', wrapLabel: '自动换行', unwrapLabel: '取消换行' } },
  footnotes: '脚注',
};

function GenuiPart({ part, sessionId, messageId, originalSeq }) {
  const processed = useMemo(() => {
    try { return processGenuiSpec(JSON.parse(part.raw)); }
    catch { return null; }
  }, [part.raw]);
  if (!processed || !isRenderableProcess(processed)) {
    return <div className="speak-plain-genui-fallback">
      <p className="speak-plain-muted">此组件无法解析，保留原始代码；可查看上方原回答。</p>
      <MarkdownText text={part.source} streaming={false} labels={MARKDOWN_LABELS} />
    </div>;
  }
  // The original answer already owns panel operations; do not publish/apply them twice.
  if (processed.spec.panel === true) return <p className="speak-plain-muted" data-speak-plain-panel-reference>此组件显示在会话面板中，润色区不重复发布。</p>;
  const stateKey = JSON.stringify(['speak-plain', sessionId, messageId, originalSeq, part.index, part.raw]);
  return <ErrorBoundary key={stateKey} label="润色回答中的 GenUI 组件">
    <GenuiBlock spec={processed.spec} stateKey={stateKey} animateEntrance={false} />
  </ErrorBoundary>;
}

/** Embed GenUI explicitly: the host's DOM fence recognizer does not own turnTail content. */
export function SpeakPlainContent({ text, sessionId, messageId, originalSeq, onAction }) {
  const parts = useMemo(() => splitRichContent(text), [text]);
  const [actionError, setActionError] = useState('');
  const action = useCallback((name, payload) => {
    setActionError('');
    Promise.resolve().then(() => onAction(name, payload)).catch(() => {
      setActionError('交互消息未发送，请回到此回答所属的会话后重试。');
    });
  }, [onAction]);
  return <GenuiActionContext.Provider value={onAction ? action : undefined}>
    {parts.map((part, index) => part.kind === 'genui'
      ? <GenuiPart key={`genui-${part.index}`} part={part} sessionId={sessionId} messageId={messageId} originalSeq={originalSeq} />
      : <MarkdownText key={`markdown-${index}`} text={part.text} streaming={false} labels={MARKDOWN_LABELS} />)}
    {actionError && <p className="speak-plain-error" role="alert">{actionError}</p>}
  </GenuiActionContext.Provider>;
}
