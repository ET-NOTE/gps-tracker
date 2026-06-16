// 개인정보 처리방침 · 이용약관 — 스켈레톤.
// 실제 발효 전 법률 검토 및 사업자 정보 채워넣어야 함.

const TODO = '[ TODO — 발효 전 사업자 정보 / 법률 검토 필요 ]';

export default function LegalPage({ kind }) {
  const data = kind === 'privacy' ? PRIVACY : TERMS;
  return (
    <div style={st.root}>
      <div style={st.shell}>
        <div style={st.head}>
          <a href={import.meta.env.BASE_URL} style={st.back}>← GPS Tracker</a>
          <div style={st.title}>{data.title}</div>
          <div style={st.meta}>최종 수정일: {data.updated}</div>
        </div>
        <div style={st.body}>
          {data.sections.map((s, i) => (
            <section key={i} style={{ marginBottom: 28 }}>
              <h2 style={st.h2}>{s.h}</h2>
              {s.p.map((p, j) => (
                <p key={j} style={st.p}>{p}</p>
              ))}
              {s.list && (
                <ul style={st.ul}>
                  {s.list.map((li, j) => <li key={j} style={st.li}>{li}</li>)}
                </ul>
              )}
            </section>
          ))}
        </div>
        <div style={st.foot}>
          <a href={`${import.meta.env.BASE_URL}privacy`} style={st.footLink}>개인정보 처리방침</a>
          <span style={{ color: 'var(--text-3)' }}>·</span>
          <a href={`${import.meta.env.BASE_URL}terms`} style={st.footLink}>이용약관</a>
        </div>
      </div>
    </div>
  );
}

const PRIVACY = {
  title: '개인정보 처리방침',
  updated: '2026-05-07',
  sections: [
    {
      h: '1. 수집하는 개인정보 항목',
      p: ['GPS Tracker (이하 "서비스")는 다음 항목을 수집·이용합니다.'],
      list: [
        '필수: 이메일, 비밀번호 (해시), 휴대폰 번호 (OTP 인증)',
        '선택: 표시 이름, 추가 휴대폰 번호',
        '자동 수집: 접속 IP, 브라우저/기기 정보, 서비스 이용 기록',
        '디바이스 데이터: 페어링된 GPS 단말기의 위치(위도/경도), 속도, 배터리 상태, 이벤트 로그',
      ],
    },
    {
      h: '2. 개인정보 수집 및 이용 목적',
      list: [
        '회원 가입 및 본인 확인 (휴대폰 OTP)',
        '서비스 제공 — 위치 추적, 운행 일지, 알림',
        '부정 이용 방지 및 보안',
        '고객 문의 응대',
      ],
    },
    {
      h: '3. 개인정보 보유 및 이용 기간',
      p: [
        '회원 탈퇴 시 즉시 파기. 단, 관련 법령에 의해 보존이 필요한 정보는 해당 기간 동안 보관.',
      ],
      list: [
        '계약/청약철회 기록: 5년 (전자상거래법)',
        '대금결제 및 재화 공급 기록: 5년 (전자상거래법)',
        '소비자 불만 또는 분쟁처리 기록: 3년 (전자상거래법)',
        '접속 로그: 3개월 (통신비밀보호법)',
      ],
    },
    {
      h: '4. 개인정보의 제3자 제공',
      p: [
        '서비스는 원칙적으로 개인정보를 외부에 제공하지 않습니다. 다만, 다음 경우는 예외입니다.',
      ],
      list: [
        '이용자가 사전 동의한 경우',
        '법령의 규정에 의거하거나 수사기관의 적법한 절차에 의한 요청이 있는 경우',
        'SMS 발송 (bizmsg.kr) — 휴대폰 번호 일시 제공',
        '결제 처리 (Toss Payments) — 결제 정보 일시 제공',
        '카카오맵 SDK — 좌표 (위도/경도) 일시 제공 (지도 표시용)',
      ],
    },
    {
      h: '5. 정보주체의 권리',
      p: [
        '이용자는 언제든지 본인의 개인정보를 조회·수정·삭제할 수 있습니다. (마이페이지 → 회원 탈퇴)',
        '회원 탈퇴 시 위치 데이터·운행 기록은 30일 유예 후 영구 삭제됩니다.',
      ],
    },
    {
      h: '6. 개인정보 보호 책임자',
      p: [TODO, '문의: project307@naver.com'],
    },
  ],
};

const TERMS = {
  title: '이용약관',
  updated: '2026-05-07',
  sections: [
    {
      h: '제1조 (목적)',
      p: [
        '본 약관은 GPS Tracker (이하 "서비스") 이용과 관련하여 회사와 이용자 간의 권리, 의무 및 책임사항을 규정함을 목적으로 합니다.',
      ],
    },
    {
      h: '제2조 (서비스 내용)',
      list: [
        'GPS 단말기의 실시간 위치 조회',
        '운행 기록 (이동 경로, 정지 시간, 통계) 제공',
        '알림 (지오펜스 진입/이탈, 배터리 저전압 등)',
        '단말기 페어링 및 공유 링크 발급',
      ],
    },
    {
      h: '제3조 (회원가입)',
      p: [
        '서비스 이용을 위해 이메일, 비밀번호, 휴대폰 번호 (OTP 인증) 가 필요합니다.',
        '회원은 정확한 정보를 제공할 의무가 있으며, 변경 사항은 즉시 갱신해야 합니다.',
      ],
    },
    {
      h: '제4조 (서비스 이용)',
      list: [
        '회원은 본인의 계정 정보를 안전하게 관리할 책임이 있습니다.',
        '타인의 명의 도용, 부정 사용은 금지됩니다.',
        '서비스 점검 등으로 인해 일시 중단될 수 있습니다.',
      ],
    },
    {
      h: '제5조 (회원 탈퇴 및 자격 상실)',
      p: [
        '회원은 언제든지 마이페이지를 통해 탈퇴할 수 있습니다.',
        '약관 위반 시 회사는 사전 통지 후 자격을 제한·정지할 수 있습니다.',
      ],
    },
    {
      h: '제6조 (책임 제한)',
      p: [
        '천재지변, 통신 두절 등 회사의 귀책 사유 없는 사유로 인한 손해에 대해 책임을 지지 않습니다.',
        '단말기 (하드웨어) 의 위치 정보 정확도는 GPS / LTE 신호 환경에 따라 달라질 수 있습니다.',
      ],
    },
    {
      h: '제7조 (요금 및 환불)',
      p: [TODO, '결제 관련 환불 정책은 별도 안내합니다.'],
    },
    {
      h: '제8조 (분쟁 해결)',
      p: [
        '서비스 이용과 관련하여 분쟁이 발생할 경우, 우선 양 당사자가 협의하여 해결합니다.',
        '협의가 어려운 경우 관할 법원에 의해 처리됩니다.',
      ],
    },
  ],
};

const st = {
  root: {
    minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)',
    padding: '24px 16px',
  },
  shell: {
    maxWidth: 720, margin: '0 auto', background: 'var(--surface)',
    borderRadius: 14, padding: '32px 28px',
    border: '1px solid var(--border)',
  },
  head: { borderBottom: '1px solid var(--border)', paddingBottom: 16, marginBottom: 24 },
  back: { color: 'var(--text-3)', fontSize: 12, textDecoration: 'none' },
  title: { fontSize: 24, fontWeight: 700, marginTop: 8 },
  meta:  { fontSize: 12, color: 'var(--text-3)', marginTop: 4 },
  body:  { lineHeight: 1.7 },
  h2:    { fontSize: 16, fontWeight: 700, marginBottom: 8 },
  p:     { fontSize: 14, color: 'var(--text-2)', margin: '6px 0' },
  ul:    { paddingLeft: 20, margin: '8px 0' },
  li:    { fontSize: 14, color: 'var(--text-2)', margin: '4px 0' },
  foot:  {
    marginTop: 32, paddingTop: 16, borderTop: '1px solid var(--border)',
    display: 'flex', justifyContent: 'center', gap: 12,
    fontSize: 12,
  },
  footLink: { color: 'var(--text-2)', textDecoration: 'none' },
};
