import React, { useEffect, useState } from 'react';

/** Last-resort fallback: if the delegated default renderer throws, show readable
 *  plain text of the answer instead of leaving the row blank. */
class ShadowFallbackBoundary extends React.Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { /* swallow: keep the answer readable */ }
  render() {
    if (this.state.failed === true) {
      const text = (this.props.blocks ?? []).filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n\n');
      return <pre className="speak-plain-fallback">{text}</pre>;
    }
    return this.props.children;
  }
}

/**
 * Build a drop-in `assistant-step` renderer that delegates to DSH's own default
 * AnswerNodeView. It only changes ONE node: the turn's closing final answer once
 * the polished copy is ready — that original is wrapped in a collapsed
 * <details>, so the polished result below (rendered by the turn tail) becomes
 * the default view. Every other node and every non-polished answer is the
 * untouched default rendering.
 */
export function createAssistantShadow({ Default, call }) {
  return function SpeakAssistantStep(props) {
    const { node, sessionId, useTurnData } = props;
    const turn = node?.location?.kind === 'turn' || node?.location?.kind === 'step' ? node.location.turn : undefined;
    const tail = typeof useTurnData === 'function' ? useTurnData('turn-tail') : undefined;
    const finalNode = node?.data?.finalNode;
    const turnNo = turn?.turn;
    const isTurnFinal = finalNode !== undefined
      && turn?.status === 'closed'
      && tail?.closing?.finalNode?.seq === finalNode.seq;
    const [polished, setPolished] = useState(false);

    useEffect(() => {
      let cancelled = false;
      if (!isTurnFinal || typeof sessionId !== 'string' || !Number.isInteger(turnNo) || typeof call !== 'function') {
        setPolished(false);
        return undefined;
      }
      const controller = new AbortController();
      call('result/get', { sessionId, turn: turnNo }, controller.signal).then(value => {
        if (cancelled) return;
        const result = value?.result;
        setPolished(Boolean(result && result.status === 'ready' && result.originalSeq === finalNode.seq));
      }).catch(() => { if (!cancelled) setPolished(false); });
      return () => { cancelled = true; controller.abort(); };
    }, [isTurnFinal, sessionId, turnNo, finalNode?.seq]);

    const boundary = <ShadowFallbackBoundary blocks={node?.data?.blocks}><Default {...props} /></ShadowFallbackBoundary>;
    if (polished) {
      return <div className="speak-plain-answer">
        <details className="speak-plain-original">
          <summary>查看原回答</summary>
          <div className="speak-plain-original-body">{boundary}</div>
        </details>
      </div>;
    }
    return boundary;
  };
}
