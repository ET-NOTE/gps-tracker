import React, { useContext, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Session } from "./session";
import { Intro, Icon, number, date } from "./components";
import { request } from "./api";
import { useDeviceList } from "./DeviceNavigation";
import { useCommerce } from "./Commerce";
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
  const { points } = useCommerce();
  const [orders, setOrders] = useState([]),
    [tick, setTick] = useState(0);
  const { user, reload } = useContext(Session),
    [rows, setRows] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    const a = new AbortController();
    Promise.all([
      request("/credits", { signal: a.signal }),
      request("/payments", { signal: a.signal }),
    ])
      .then(([r, o]) => {
        setRows(r);
        setOrders(o);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => a.abort();
  }, [user.id, tick]);
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
        <button className="button" onClick={points}>
          포인트 충전하기
        </button>
      </section>
      <section className="panel point-uses">
        <div>
          <h2>USIM 데이터 충전</h2>
          <p>보유 포인트로 내 장치의 데이터를 충전하세요.</p>
          <Link className="outline" to="/devices">
            내 장치에서 충전 →
          </Link>
        </div>
        <div>
          <h2>응용 프로젝트</h2>
          <p>상품은 공개 준비 중입니다.</p>
          <Link className="outline" to="/projects">
            프로젝트 보기 →
          </Link>
        </div>
      </section>
      <section className="panel history">
        <h2>포인트 결제 내역</h2>
        {orders.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>주문 시각</th>
                  <th>금액</th>
                  <th>상태</th>
                  <th>조회</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td>{date(o.created_at)}</td>
                    <td>₩{number(o.amount, 0)}</td>
                    <td>
                      {
                        {
                          pending: "결제 전",
                          paid: "충전 완료",
                          confirming: "확인 중",
                          unknown: "결과 확인 필요",
                        }[o.status]
                      }
                    </td>
                    <td>
                      {["unknown", "confirming"].includes(o.status) && (
                        <button
                          onClick={async () => {
                            try {
                              const r = await request(
                                `/payments/${o.id}/reconcile`,
                                { method: "POST", body: {} },
                              );
                              if (r.status === "unknown") setError(r.message);
                              else setError("");
                              setTick((t) => t + 1);
                              await reload();
                            } catch (e) {
                              setError(e.message);
                            }
                          }}
                        >
                          결과 다시 조회
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty">아직 결제 내역이 없습니다.</p>
        )}
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
                        payment: "결제 충전",
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
