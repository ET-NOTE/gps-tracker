import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { referenceTarget } from './referenceNavigation';
import { bootDocument, channel, readSampleSession, writeSampleSession } from './referenceSession';

export default function ReferenceFrame({target, onRoute, onExit, onMap}) {
  const frame = useRef(null);
  const active = useRef(null);
  const latest = useRef({target, onRoute, onExit, onMap});
  const [html, setHtml] = useState('');
  const [failed, setFailed] = useState(false);
  const [attempt, retry] = useState(0);
  const [storageWarning, setStorageWarning] = useState(false);

  useLayoutEffect(() => { latest.current = {target, onRoute, onExit, onMap}; });
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(import.meta.env.BASE_URL + 'fleet-preview/fleet-v1.html', {
          signal: controller.signal, credentials: 'omit', cache: 'no-cache',
        });
        if (!response.ok) throw new Error('체험 화면을 열 수 없습니다.');
        const template = await response.text();
        if (controller.signal.aborted) return;
        const initial = latest.current.target;
        active.current = initial;
        setHtml(bootDocument(template, initial, readSampleSession()));
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    }
    load();
    return () => controller.abort();
  }, [attempt]);

  useEffect(() => {
    function receive(event) {
      if (!frame.current || event.source !== frame.current.contentWindow || event.origin !== 'null') return;
      const message = event.data;
      if (message?.channel !== channel) return;
      const actions = latest.current;
      if (message.type === 'route') {
        const next = referenceTarget(message.route, message.service);
        if (!next) return;
        active.current = next;
        if (next.route !== actions.target.route || next.service !== actions.target.service) actions.onRoute(next);
      } else if (message.type === 'store' && message.state && typeof message.state === 'object') {
        setStorageWarning(!writeSampleSession(message.state));
      } else if (message.type === 'map') actions.onMap();
      else if (message.type === 'exit') actions.onExit();
    }
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);

  useEffect(() => {
    if (!frame.current || !html || (active.current?.route === target.route && active.current?.service === target.service)) return;
    active.current = target;
    frame.current.contentWindow.postMessage({channel, type: 'navigate', ...target}, '*');
  }, [target.route, target.service, html]);

  if (!html) return <main className="fleet-demo-status" aria-live="polite">
    <p>{failed ? '데모 화면을 불러오지 못했습니다.' : '데모 화면을 여는 중입니다.'}</p>
    {failed && <button onClick={() => { setFailed(false); retry(value => value + 1); }}>다시 시도</button>}
    <button onClick={onExit}>체험 종료</button>
  </main>;
  return <div className="fleet-demo-frame">
    {storageWarning && <div role="status">이 탭의 저장 공간이 부족합니다. 새로고침하면 체험 중 변경한 내용이 초기화될 수 있습니다.</div>}
    <iframe ref={frame} title="시리얼링크 서비스 체험" sandbox="allow-scripts allow-forms allow-downloads" referrerPolicy="no-referrer" srcDoc={html}/>
  </div>;
}
