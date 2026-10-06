import React, { useState } from "react";
import { Link } from "react-router-dom";
import { Modal } from "./Commerce";
import { request } from "./api";

export default function DeviceRegistration({ done, close }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <Modal title="내 쉴드 등록" busy={busy} close={close}>
    <ol className="setup-next-steps">
      <li><Link to="/examples/shield-uno-easy-https" target="_blank" rel="noopener">1NCE 간편 HTTPS 예제 ZIP</Link>을 풀고 Arduino UNO에 그대로 업로드하세요. 설정값을 찾거나 코드를 수정할 필요가 없습니다.</li>
      <li>시리얼 모니터를 <strong>115200 baud</strong>로 열고 <code>[REGISTER]</code> 뒤의 등록 코드를 복사하세요.</li>
      <li>아래에 코드와 장치 이름을 입력하면 내 계정에 연결됩니다. 다음 전송부터 데이터를 확인할 수 있습니다.</li>
    </ol>
    <form className="device-setup-fields" onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError("");
      const form = new FormData(e.currentTarget);
      try {
        const result = await request("/devices/claim", { method: "POST", body: { display_name: form.get("name"), claim_code: form.get("code") } });
        done(result.id);
      } catch (err) { setError(err.message); }
      finally { setBusy(false); }
    }}>
      <label>시리얼 모니터의 등록 코드<input name="code" required maxLength={80} placeholder="예: abcd-1234-ef56-7890" autoComplete="off" spellCheck={false} autoFocus disabled={busy} /></label>
      <label>장치 이름<input name="name" required maxLength={60} placeholder="예: 책상 위 쉴드" disabled={busy} /></label>
      <p className="muted">등록 코드는 발급 후 24시간 동안 한 번 사용할 수 있습니다. 기존 제품의 64자리 등록 코드도 사용할 수 있습니다. 시리얼의 [REGISTER] 뒤에 표시된 코드만 입력하세요.</p>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="button" disabled={busy}>{busy ? "등록 중…" : "내 계정에 장치 연결"}</button>
    </form>
    <p className="muted">이미 등록했다면 재부팅·같은 예제 재업로드 후에도 연결이 유지됩니다. 등록 코드가 만료되었다면 예제의 재등록 안내를 확인하세요.</p>
  </Modal>;
}
