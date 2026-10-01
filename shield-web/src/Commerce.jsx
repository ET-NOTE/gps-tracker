import React, { useContext, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Session } from "./session";
import { request } from "./api";
import { Intro, Icon, number, date } from "./components";
import { useDeviceList } from "./DeviceNavigation";
import { Commerce, useCommerce } from "./commerceContext";
export { useCommerce } from "./commerceContext";
export function Modal({ title, close, busy = false, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const d = ref.current;
    d.showModal();
    return () => d.close();
  }, []);
  return (
    <dialog
      className="commerce-modal"
      ref={ref}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
    >
      <header className="dialog-heading">
        <h2>{title}</h2>
        <button type="button" aria-label="닫기" disabled={busy} onClick={close}>
          ×
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function CommerceProvider({ children }) {
  const { user, reload } = useContext(Session),
    [modal, setModal] = useState(null),
    { pathname } = useLocation();
  useEffect(() => setModal(null), [user?.id, pathname]);
  const points = (device) => {
    setModal({ kind: "points", device });
    if (user) reload();
  };
  const usim = (device) => {
    setModal({ kind: "usim", device });
    if (user) reload();
  };
  const close = () => setModal(null);
  return (
    <Commerce.Provider
      value={{
        points: () => points(),
        usim,
        contact: () => setModal({ kind: "contact" }),
      }}
    >
      {children}
      {modal?.kind === "contact" && <ContactModal close={close} />}
      {modal && modal.kind !== "contact" && !user && (
        <Modal title="로그인이 필요합니다" close={close}>
          <p>내 계정의 포인트와 USIM을 확인하려면 로그인해 주세요.</p>
          <Link className="button" to="/login?next=/points">
            로그인
          </Link>
        </Modal>
      )}
      {user && modal?.kind === "points" && (
        <PointModal
          key={user.id}
          close={modal.device ? () => usim(modal.device) : close}
        />
      )}
      {user && modal?.kind === "usim" && (
        <SimModal
          key={user.id}
          initial={modal.device}
          close={close}
          points={points}
        />
      )}
    </Commerce.Provider>
  );
}
function useCatalog() {
  const [data, setData] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    const a = new AbortController();
    request("/commerce", { signal: a.signal })
      .then(setData)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => a.abort();
  }, []);
  return { data, error };
}
let sdkTask;
function tossSDK() {
  if (window.TossPayments) return Promise.resolve(window.TossPayments);
  if (!sdkTask)
    sdkTask = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://js.tosspayments.com/v2/standard";
      script.onload = () => resolve(window.TossPayments);
      script.onerror = () => {
        script.remove();
        sdkTask = null;
        reject(new Error("결제창을 불러오지 못했습니다. 다시 시도해 주세요."));
      };
      document.head.appendChild(script);
    });
  return sdkTask;
}
function PointModal({ close }) {
  const { user } = useContext(Session),
    { data, error: loadError } = useCatalog(),
    [amount, setAmount] = useState(50000),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const key = useRef(crypto.randomUUID());
  async function pay() {
    setBusy(true);
    setError("");
    try {
      const sdk = await tossSDK();
      const order = await request("/payments", {
        method: "POST",
        body: { amount, idempotency_key: key.current },
      });
      const payment = sdk(order.client_key).payment({
        customerKey: order.order_id,
      });
      await payment.requestPayment({
        method: "CARD",
        amount: { currency: "KRW", value: order.amount },
        orderId: order.order_id,
        orderName: order.order_name,
        successUrl: location.origin + "/points/success",
        failUrl: location.origin + "/points/fail",
      });
    } catch (e) {
      setError(
        e.code === "USER_CANCEL"
          ? "결제를 취소했습니다."
          : e.message || "결제를 시작하지 못했습니다.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="포인트 충전" close={close} busy={busy}>
      <p>포인트는 USIM 충전과 응용 프로젝트 구매에 사용할 수 있습니다.</p>
      <div className="wallet-banner">
        <span>현재 보유 포인트</span>
        <strong>
          <span className="point-icon">P</span> {number(user.credit_balance, 0)}{" "}
          P
        </strong>
      </div>
      <fieldset disabled={busy}>
        <legend>충전 금액 선택</legend>
        <div className="charge-options">
          {(data?.amounts || [10000, 30000, 50000, 100000]).map((v) => (
            <label className={amount === v ? "chosen" : ""} key={v}>
              <input
                type="radio"
                name="amount"
                value={v}
                checked={amount === v}
                onChange={() => {
                  setAmount(v);
                  key.current = crypto.randomUUID();
                }}
              />
              <strong>{number(v, 0)} P</strong>
              <span>₩{number(v, 0)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="point-uses">
        <div>
          <Icon name="sim" />
          <strong>USIM 데이터 충전</strong>
          <p>내 장치의 데이터 용량을 충전하세요.</p>
        </div>
        <div>
          <Icon name="book" />
          <strong>응용 프로젝트 구매</strong>
          <p>프로젝트 상품은 공개 준비 중입니다.</p>
        </div>
      </div>
      <dl className="checkout-summary">
        <div>
          <dt>선택 상품</dt>
          <dd>{number(amount, 0)} P</dd>
        </div>
        <div>
          <dt>결제 금액</dt>
          <dd>₩{number(amount, 0)}</dd>
        </div>
        <div className="total">
          <dt>충전 후 예상 잔액</dt>
          <dd>{number(user.credit_balance + amount, 0)} P</dd>
        </div>
      </dl>
      {(error || loadError) && (
        <p className="error" role="alert">
          {error || loadError}
        </p>
      )}
      {data && !data.enabled && (
        <p className="notice">
          온라인 충전을 준비 중입니다. 결제 연결 후 이용할 수 있습니다.
        </p>
      )}
      <div className="modal-actions">
        <button className="outline" disabled={busy} onClick={close}>
          취소
        </button>
        <button
          className="button"
          disabled={busy || !data?.enabled}
          onClick={pay}
        >
          {busy
            ? "결제창 연결 중…"
            : data?.enabled
              ? "충전하기"
              : "충전 준비 중"}
        </button>
      </div>
    </Modal>
  );
}
function SimModal({ initial, close, points }) {
  const { user, reload } = useContext(Session),
    { devices, loading, error: deviceError } = useDeviceList();
  const [id, setId] = useState(String(initial || "")),
    [data, setData] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [success, setSuccess] = useState(false),
    [agree, setAgree] = useState(false);
  const key = useRef(crypto.randomUUID());
  useEffect(() => {
    if (!id && devices.length) setId(String(devices[0].id));
  }, [devices, id]);
  useEffect(() => {
    setData(null);
    setError("");
    setAgree(false);
    key.current = crypto.randomUUID();
    if (!id) return;
    const a = new AbortController();
    Promise.all([
      request(`/devices/${id}/usim`, { signal: a.signal }),
      request("/sim-requests", { signal: a.signal }),
    ])
      .then(([s, rows]) =>
        setData({
          ...s,
          id,
          open: rows.some(
            (r) =>
              r.device_id === Number(id) &&
              [
                "pending",
                "approved",
                "submitting",
                "submitted",
                "unknown",
              ].includes(r.status),
          ),
        }),
      )
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => a.abort();
  }, [id]);
  const s = data?.id === id ? data : null,
    device = devices.find((d) => String(d.id) === id),
    insufficient = s && user.credit_balance < s.cost_credits;
  async function submit() {
    setBusy(true);
    setError("");
    try {
      await request("/sim-requests", {
        method: "POST",
        body: {
          device_id: Number(id),
          cost_credits: s.cost_credits,
          idempotency_key: key.current,
        },
      });
      setSuccess(true);
      await reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="USIM 데이터 충전" close={close} busy={busy}>
      {success ? (
        <>
          <p className="notice" role="status">
            충전 요청을 접수했습니다. 관리자가 확인 후 처리하며, 완료 상태는
            USIM 내역에서 확인할 수 있습니다.
          </p>
          <Link className="button" to={`/usim?device=${id}`}>
            요청 내역 보기
          </Link>
        </>
      ) : (
        <>
          <label>
            충전할 장치
            <select
              disabled={busy || loading}
              value={id}
              onChange={(e) => setId(e.target.value)}
            >
              {!devices.length && <option value="">등록된 장치 없음</option>}
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.display_name}
                </option>
              ))}
            </select>
          </label>
          {!loading && !devices.length && (
            <Link to="/devices">내 장치 등록하기 →</Link>
          )}
          {s && (
            <>
              <div className="wallet-banner sim-selected">
                <Icon name="sim" size={36} />
                <div>
                  <strong>{device?.display_name}</strong>
                  <p>USIM {s.sim?.last4 ? "···· " + s.sim.last4 : "미연결"}</p>
                  <small>
                    남은 데이터 {number(s.sim?.usage?.remaining_mb, 2)} MB ·
                    사용 기한 {s.sim?.usage?.expires_at || "확인 대기"}
                  </small>
                  <small className="block">
                    마지막 조회 {date(s.sim?.updated_at)}
                  </small>
                </div>
              </div>
              {s.sales_enabled ? (
                <>
                  <h3>데이터 용량 선택</h3>
                  <div className="charge-options single">
                    <div className="chosen">
                      <strong>{s.topup_mb} MB</strong>
                      <span>{number(s.cost_credits, 0)} P</span>
                    </div>
                  </div>
                  <dl className="checkout-summary">
                    <div>
                      <dt>보유 포인트</dt>
                      <dd>{number(user.credit_balance, 0)} P</dd>
                    </div>
                    <div>
                      <dt>사용 포인트</dt>
                      <dd>{number(s.cost_credits, 0)} P</dd>
                    </div>
                    <div className="total">
                      <dt>충전 후 잔액</dt>
                      <dd>
                        {number(
                          Math.max(0, user.credit_balance - s.cost_credits),
                          0,
                        )}{" "}
                        P
                      </dd>
                    </div>
                  </dl>
                  {insufficient ? (
                    <div className="error" role="alert">
                      <strong>보유 포인트가 부족합니다.</strong>
                      <p>
                        {number(s.cost_credits - user.credit_balance, 0)} P를 더
                        충전해 주세요.
                      </p>
                    </div>
                  ) : (
                    <label className="check-line">
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={agree}
                        onChange={(e) => setAgree(e.target.checked)}
                      />
                      대상 USIM과 포인트 차감 내용을 확인했습니다.
                    </label>
                  )}
                  <p className="muted">
                    접수 시 차감하며 관리자 확인 후 충전합니다. 전송 전
                    취소·반려 시 포인트가 반환됩니다.
                  </p>
                  <div className="modal-actions">
                    <button className="outline" onClick={close} disabled={busy}>
                      취소
                    </button>
                    {insufficient ? (
                      <button className="button" onClick={() => points(id)}>
                        포인트 충전하기
                      </button>
                    ) : (
                      <button
                        className="button"
                        disabled={
                          busy ||
                          !agree ||
                          !s.sim?.linked ||
                          s.open ||
                          !s.provider.configured
                        }
                        onClick={submit}
                      >
                        {s.open
                          ? "진행 중인 요청이 있습니다"
                          : busy
                            ? "접수 중…"
                            : "포인트로 충전 요청"}
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <div className="empty">
                  <h3>USIM 충전 상품 준비 중</h3>
                  <p>
                    상품 용량과 가격이 확정되면 여기에서 포인트로 충전할 수
                    있습니다.
                  </p>
                </div>
              )}
            </>
          )}
          {(error || deviceError) && (
            <p className="error" role="alert">
              {error || deviceError}
            </p>
          )}
          {!s && !error && !deviceError && id && (
            <p role="status">USIM 정보를 불러오는 중…</p>
          )}
        </>
      )}
    </Modal>
  );
}
export function PricingPage() {
  const { data, error } = useCatalog(),
    { points, usim } = useCommerce();
  return (
    <main className="container pricing-page">
      <Intro
        title="이용 요금 안내"
        description="포인트로 USIM 데이터를 충전하고 응용 프로젝트를 이용하세요."
      />
      <section className="panel pricing-intro">
        <div>
          <Icon name="sim" size={32} />
          <h2>USIM 데이터 충전</h2>
          <p>내 장치에 연결된 USIM을 충전합니다.</p>
        </div>
        <div>
          <Icon name="book" size={32} />
          <h2>응용 프로젝트</h2>
          <p>프로젝트 상품은 공개 준비 중입니다.</p>
        </div>
        <button className="button" onClick={points}>
          포인트 충전하기 →
        </button>
      </section>
      <section>
        <div className="panel-title">
          <h2>USIM 요금 안내</h2>
          <button className="outline" onClick={() => usim()}>
            USIM 충전하기
          </button>
        </div>
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : !data ? (
          <p role="status">상품을 불러오는 중…</p>
        ) : data.sim_plans.length ? (
          <div className="charge-options">
            {data.sim_plans.map((p) => (
              <div key={p.id}>
                <strong>{p.mb} MB 추가</strong>
                <b>{number(p.cost_credits, 0)} P</b>
              </div>
            ))}
          </div>
        ) : (
          <div className="panel empty">
            <Icon name="sim" size={36} />
            <h3>상품을 준비하고 있습니다</h3>
            <p>확정된 용량과 가격을 곧 안내하겠습니다.</p>
          </div>
        )}
      </section>
      <section className="panel project-preparing">
        <h2>응용 프로젝트</h2>
        <p>프로젝트 소개와 활용 예제를 먼저 살펴보세요.</p>
        <Link className="outline" to="/projects">
          전체 프로젝트 보기 →
        </Link>
      </section>
    </main>
  );
}
export function PaymentReturn() {
  const { reload } = useContext(Session),
    [params] = useState(() => new URLSearchParams(location.search)),
    [result, setResult] = useState(null),
    [error, setError] = useState(""),
    [tick, setTick] = useState(0),
    fail = location.pathname.endsWith("/fail");
  useEffect(() => {
    history.replaceState(null, "", location.pathname);
    if (fail) return;
    let active = true;
    request("/payments/confirm", {
      method: "POST",
      body: {
        order_id: params.get("orderId") || "",
        payment_key: params.get("paymentKey") || "",
        amount: Number(params.get("amount")),
      },
    })
      .then((r) => {
        if (active) {
          setResult(r);
          reload();
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [params, fail, tick, reload]);
  return (
    <main className="container payment-result">
      <Intro
        title={
          fail
            ? "결제가 완료되지 않았습니다"
            : result?.status === "paid"
              ? "포인트 충전 완료"
              : "결제 결과 확인"
        }
      />
      {fail ? (
        <p>
          결제가 취소되었거나 완료되지 않았습니다. 포인트 내역을 확인한 뒤 다시
          진행해 주세요.
        </p>
      ) : (
        <>
          <p role="status">
            {result?.status === "paid"
              ? `${number(result.amount, 0)} P를 충전했습니다.`
              : result?.message || (!error && "결제 결과를 확인하고 있습니다…")}
          </p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {(error || result?.status === "unknown") && (
            <button
              className="outline"
              onClick={() => {
                setError("");
                setTick((t) => t + 1);
              }}
            >
              결과 다시 확인
            </button>
          )}
        </>
      )}
      <Link className="button" to="/points">
        포인트 내역 보기
      </Link>
    </main>
  );
}

function ContactModal({ close }) {
  const [selected, setSelected] = useState("");
  return (
    <Modal title="1:1 문의" close={close}>
      <p>편한 문의 방법을 선택해 주세요.</p>
      <div className="contact-options">
        {[
          ["카카오톡 상담", "chat"],
          ["이메일 문의", "mail"],
        ].map(([name, icon]) => (
          <button key={name} onClick={() => setSelected(name)}>
            <Icon name={icon} />
            <strong>{name}</strong>
            <span className="badge warm">준비 중</span>
          </button>
        ))}
      </div>
      <p className="notice" role="status">
        {selected
          ? selected + " 채널을 준비 중입니다."
          : "상담 채널을 준비하고 있습니다."}{" "}
        아직 메시지가 전송되지 않습니다.
      </p>
      <button className="outline" onClick={close}>
        닫기
      </button>
    </Modal>
  );
}
