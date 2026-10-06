import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Modal } from "./Commerce";
import { request } from "./api";
import { date } from "./components";

export default function HttpDemoDialog({ device, close }) {
  const [status, setStatus] = useState(null), [uid, setUid] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [copied, setCopied] = useState(false), [reload, setReload] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setError("");
    request(`/devices/${device.id}/http-demo`, { signal: abort.signal })
      .then(value => { if (!abort.signal.aborted) setStatus(value); })
      .catch(e => { if (e.name !== "AbortError") setError(e.message); });
    return () => abort.abort();
  }, [device.id, reload]);
  async function change(enabled) {
    setBusy(true); setError(""); setCopied(false); setUid("");
    try {
      const value = await request(`/devices/${device.id}/http-demo`, { method: "POST", body: { enabled } });
      setStatus(value); setUid(value.device_uid || "");
    } catch (e) {
      setError(e.message + " 상태를 다시 확인한 뒤 필요하면 새 UID를 발급하세요.");
      setStatus(null);
    } finally { setBusy(false); }
  }
  return <Modal title="HTTP 학습 연결" close={close} busy={busy}>
    <h3>{device.display_name}</h3>
    <p>인증서 설치 없이 LTE 상태 전송을 연습합니다. 교육용 UID를 예제의 설정 파일에 넣으면 이 장치로 데이터가 들어옵니다.</p>
    <p className="notice">HTTP 전송은 암호화되지 않습니다. UID를 알면 이 장치에 학습용 상태를 보낼 수 있습니다. 온습도·GPS와 실제 운영에는 HTTPS 예제를 사용하세요.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {!status ? <p role="status">{error ? <button className="outline" onClick={() => setReload(v => v + 1)} disabled={busy}>상태 다시 확인</button> : "연결 상태를 불러오는 중입니다."}</p>
      : <p role="status">{status.enabled ? `사용 중 · ${date(status.expires_at)}까지` : "꺼짐 · 필요할 때 24시간 동안 켤 수 있습니다."}</p>}
    {uid && <section className="http-demo-code">
      <label>교육용 UID · 지금만 표시됩니다
        <input value={uid} readOnly autoComplete="off" spellCheck="false" onFocus={e => e.target.select()} />
      </label>
      <button className="outline" onClick={async () => {
        try { await navigator.clipboard.writeText(uid); setCopied(true); }
        catch { setError("UID 입력란을 선택해 직접 복사해 주세요."); }
      }}>{copied ? "복사됨" : "UID 복사"}</button>
      <p className="muted">config.h의 SHIELD_DEMO_UID에 붙여 넣으세요. 창을 닫으면 다시 조회할 수 없으며, 재발급하면 이전 UID는 즉시 만료됩니다.</p>
    </section>}
    <div className="actions">
      <button className="button" disabled={busy || !status} onClick={() => change(true)}>{busy ? "처리 중…" : status?.enabled ? "새 UID로 24시간 다시 켜기" : "24시간 켜고 UID 발급"}</button>
      {status?.enabled && <button className="outline" disabled={busy} onClick={() => change(false)}>학습 연결 끄기</button>}
    </div>
    <p><Link className="text-link" to="/examples/shield-uno-http-pairing">간편 HTTP 예제 보기 →</Link></p>
  </Modal>;
}
