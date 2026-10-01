import React, { useContext, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Session } from "./session";
import { Intro, Icon, number, date } from "./components";
import { request } from "./api";
import { useDeviceList } from "./DeviceNavigation";
const questions = [
  [
    "시작하기",
    "처음 연결할 때 무엇이 필요한가요?",
    "쉴드와 Arduino Uno, LTE·GNSS 안테나, 사용 가능한 USIM을 준비하세요. 전원을 끈 상태에서 연결하고 시작가이드의 순서대로 진행해 주세요.",
    "/guide",
  ],
  [
    "시작하기",
    "초대코드와 장치 등록 코드는 다른가요?",
    "초대코드는 계정을 만들 때, 제품의 일회용 등록 코드는 내 장치를 계정에 연결할 때 사용합니다. 이미 사용한 등록 코드는 다시 사용할 수 없습니다.",
    "/devices",
  ],
  [
    "데이터",
    "데이터가 없는데 그래프가 보여요.",
    "장치가 없거나 아직 수신하지 않은 경우에는 “데모 데이터” 표시와 함께 합성 데이터를 보여드립니다. 내 장치의 실제 측정값과는 별개입니다.",
    "/data",
  ],
  [
    "장치",
    "오프라인이면 전원이 꺼진 건가요?",
    "온라인은 최근 3분 안에 서버가 데이터를 받은 상태입니다. 오프라인은 수신이 멈춘 상태로 전원·망 연결·전송 주기를 함께 확인해 주세요. 전원 OFF를 직접 확인한 것은 아닙니다.",
    "/devices",
  ],
  [
    "장치",
    "통신은 되는데 위치가 미수신이에요.",
    "SIM7080G 내장 GNSS가 위치를 확보해야 합니다. GNSS 안테나를 하늘이 보이는 곳에 고정하고 기다려 주세요. 센서/통신 수신과 GNSS 측위는 각각 확인합니다.",
    "/examples/gnss",
  ],
  [
    "데이터",
    "다른 센서를 연결해도 되나요?",
    "가능합니다. 서버에 센서 이름·단위·값을 함께 보내면 데이터 화면이 해당 센서에 맞춰 표시됩니다. 센서 구성이나 단위가 바뀌면 새 구성 키를 사용해 이전 기록을 보존하세요.",
    "/examples/dynamic-sensors",
  ],
  [
    "USIM·포인트",
    "USIM은 어떻게 충전하나요?",
    "내 장치에서 대상을 선택하고 USIM 충전으로 이동하세요. 대상과 비용을 확인해 포인트로 요청하면 관리자가 확인 후 처리합니다. 포인트가 부족하면 제품 담당자에게 문의해 주세요.",
    "/devices",
  ],
  [
    "USIM·포인트",
    "온라인 포인트 충전과 유료 프로젝트 구매가 가능한가요?",
    "현재 온라인 카드 결제와 유료 프로젝트 판매는 준비 중입니다. 결제 기능이 열리기 전에는 구매나 자동 결제가 진행되지 않습니다.",
    "/points",
  ],
  [
    "데이터",
    "GPS 서비스 계정과 같이 쓰나요?",
    "Shield는 계정과 데이터를 별도로 관리합니다. Shield 전용 계정으로 로그인하고 전용 장치 ID와 키를 사용하세요.",
    "/login",
  ],
];
export function FaqPage() {
  const [search, setSearch] = useState("");
  const shown = questions.filter((q) =>
    q.slice(0, 3).join(" ").includes(search.trim()),
  );
  return (
    <main className="container faq-page">
      <Intro
        title="자주 묻는 질문"
        description="쉴드 연결부터 데이터와 USIM까지."
      />
      <label className="search">
        <Icon name="search" />
        <input
          aria-label="FAQ 검색"
          placeholder="궁금한 내용을 검색하세요"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      <div className="faq-list">
        {shown.map(([category, q, answer, to]) => (
          <details className="panel" key={q}>
            <summary>
              <span className="badge neutral">{category}</span>
              <strong>{q}</strong>
              <span>＋</span>
            </summary>
            <p>{answer}</p>
            <Link to={to}>관련 페이지 →</Link>
          </details>
        ))}
      </div>
      {!shown.length && <p className="empty">검색 결과가 없습니다.</p>}
    </main>
  );
}
export function AccountPage() {
  const { user, logout } = useContext(Session),
    { devices, loading, error } = useDeviceList(),
    navigate = useNavigate(),
    [failure, setFailure] = useState("");
  return (
    <main className="container account-page">
      <Intro title="마이페이지" />
      <section className="panel">
        <div className="account-profile">
          <Icon name="user" size={42} />
          <div>
            <h2>{user.display_name}님</h2>
            <p>{user.email}</p>
            <span className="badge">
              {user.role === "admin" ? "관리자" : "Shield 회원"}
            </span>
          </div>
        </div>
        <div className="account-summary">
          <Link to="/devices">
            <small>내 장치</small>
            <strong>
              {loading ? "…" : error ? "확인 필요" : devices.length + "대"}
            </strong>
            <span>장치 관리 →</span>
          </Link>
          <Link to="/points">
            <small>보유 포인트</small>
            <strong>{number(user.credit_balance, 0)} P</strong>
            <span>충전 및 내역 →</span>
          </Link>
        </div>
        {user.role === "admin" && (
          <Link className="outline" to="/admin">
            관리자 페이지
          </Link>
        )}
        <button
          className="outline"
          onClick={async () => {
            try {
              await logout();
              navigate("/");
            } catch {
              setFailure("로그아웃에 실패했습니다. 다시 시도해 주세요.");
            }
          }}
        >
          로그아웃
        </button>
        {failure && (
          <p role="alert" className="error">
            {failure}
          </p>
        )}
      </section>
    </main>
  );
}
export function PointsPage() {
  const { user } = useContext(Session),
    [rows, setRows] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    const a = new AbortController();
    request("/credits", { signal: a.signal })
      .then(setRows)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => a.abort();
  }, [user.id]);
  return (
    <main className="container points-page">
      <Intro
        title="포인트 충전"
        description="Shield에서 사용할 포인트와 이용 내역을 확인하세요."
      />
      <section className="panel point-wallet">
        <span className="point-icon">P</span>
        <div>
          <p>보유 포인트</p>
          <h2>{number(user.credit_balance, 0)} P</h2>
        </div>
        <span className="badge warm">온라인 충전 준비 중</span>
      </section>
      <section className="panel">
        <h2>포인트 충전 안내</h2>
        <p>
          온라인 카드 결제는 준비 중입니다. 충전이 필요하면 제품 담당자에게 계정
          이메일과 필요한 금액을 알려 주세요.
        </p>
        <p className="muted">
          현재 화면에서 결제가 발생하지 않습니다. USIM 충전 요청은 보유 포인트로
          내 장치에서 진행할 수 있습니다.
        </p>
        <Link className="button" to="/devices">
          내 장치 · USIM 관리 →
        </Link>
      </section>
      <section className="panel history">
        <h2>포인트 이용 내역</h2>
        <p className="muted">최근 100건</p>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : rows === null ? (
          <p role="status">불러오는 중…</p>
        ) : rows.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {["시각", "구분", "변동", "잔액", "사유"].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{date(r.created_at)}</td>
                    <td>
                      {{
                        adjustment: "관리자 조정",
                        charge: "사용",
                        refund: "환불",
                      }[r.kind] || r.kind}
                    </td>
                    <td>{number(r.amount, 0)} P</td>
                    <td>{number(r.balance_after, 0)} P</td>
                    <td>{r.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty">아직 포인트 이용 내역이 없습니다.</p>
        )}
      </section>
    </main>
  );
}
