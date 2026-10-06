import { Modal, useCommerce } from "./Commerce";
import { validCsq } from "./telemetry";
import React, { useContext, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Session } from "./session";
import { deviceDemo } from "./deviceDemo";
import { request, query, timeRange } from "./api";
import {
  Board,
  Intro,
  MapPanel,
  date,
  relative,
  number,
  Icon,
} from "./components";
import { ClaimDialog } from "./DataPage";
import {
  DeviceSidebar,
  useDeviceList,
  useSelectedDevice,
  connectionState,
} from "./DeviceNavigation";
import { simState } from "./deviceState";
import HttpDemoDialog from "./HttpDemoDialog";
export default function DevicesPage() {
  const { usim: realUsim } = useCommerce(),
    { user } = useContext(Session),
    navigate = useNavigate(),
    [params, setParams] = useSearchParams(),
    sample = useMemo(() => deviceDemo(), []),
    [demoUsim, setDemoUsim] = useState(false);
  const [tick, setTick] = useState(0),
    { devices, loading, error: inventoryError } = useDeviceList(tick),
    demo = params.get("demo") === "1" || (!loading && !inventoryError && !devices.length),
    shownDevices = demo ? [sample.summary.device] : devices,
    [selected, select] = useSelectedDevice(shownDevices);
  const [claim, setClaim] = useState(false),
    [result, setResult] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState(false),
    [httpDemo, setHttpDemo] = useState(false),
    [name, setName] = useState("");
  const register = () => user ? setClaim(true)
    : navigate("/login?next=" + encodeURIComponent("/devices?register=1"));
  const openUsim = (id) => demo ? setDemoUsim(true) : realUsim(id);
  useEffect(() => {
    if (params.get("register") === "1" && user) {
      setClaim(true);
      setParams(
        (p) => {
          const next = new URLSearchParams(p);
          next.delete("register");
          return next;
        },
        { replace: true },
      );
    }
  }, [params, setParams, user]);
  useEffect(() => {
    setEditing(false);
    setHttpDemo(false);
    setName(selected?.display_name || "");
  }, [selected?.id, selected?.display_name]);
  useEffect(() => {
    if (!selected || demo) return;
    const abort = new AbortController();
    setError("");
    Promise.all([
      request(`/devices/${selected.id}/summary?${query(timeRange(168))}`, {
        signal: abort.signal,
      }),
      request(`/devices/${selected.id}/usim`, { signal: abort.signal }),
      request(
        `/devices/${selected.id}/readings?${query({ ...timeRange(168), limit: 5 })}`,
        { signal: abort.signal },
      ),
    ])
      .then(([summary, sim, readings]) => {
        if (!abort.signal.aborted)
          setResult({ id: selected.id, summary, sim, readings });
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => abort.abort();
  }, [selected?.id, selected?.last_seen_at, tick, demo]);
  const data = demo ? sample : result?.id === selected?.id ? result : null,
    summary = data?.summary,
    latest = summary?.latest,
    position = summary?.position,
    sim = data?.sim.sim,
    usage = sim?.usage,
    lastSeen = summary?.device.last_seen_at || selected?.last_seen_at,
    status = demo ? { label: "온라인 · 데모", tone: "" } : connectionState(lastSeen),
    simStatus = simState(sim);
  const channels = (summary?.channels || [])
      .filter((c) => c.active)
      .slice(0, 6),
    rows = data?.readings.items || [];
  return (
    <main className="container workspace-page">
      <Intro title="내 장치">
        {devices.length > 0 && <Link className="outline" to={demo ? "/devices" : "/devices?demo=1"}>
          {demo ? "내 실제 장치 보기" : "데모 둘러보기"}
        </Link>}
      </Intro>
      {demo && <div className="demo-notice" role="status">
        <span className="badge demo">데모 장치</span>
        <span>장치 상태·수신 기록·USIM 잔량은 체험용 예시입니다. 실제 장치나 잔액이 아닙니다.</span>
      </div>}
      <div className="device-workspace">
        <DeviceSidebar
          devices={shownDevices}
          selected={selected?.id}
          onSelect={select}
          onRegister={register}
          loading={loading}
          demo={demo}
        />
        <div className="workspace-main">
          {!demo && (inventoryError || error) && (
            <p className="error" role="alert">
              {inventoryError || error}{" "}
              <button onClick={() => setTick((t) => t + 1)}>다시 시도</button>
            </p>
          )}
          {!selected ? (
            <section className="panel empty">
              <Icon name="chip" size={46} />
              <h2>
                {loading
                  ? "장치를 불러오는 중입니다"
                  : "첫 번째 쉴드를 등록하세요"}
              </h2>
              <p>예제를 그대로 업로드하고 시리얼 모니터의 등록 코드로 내 장치를 연결하세요.</p>
              <button className="button" onClick={register}>
                ＋ 내 장치 등록
              </button>
              <Link className="text-link" to="/data">
                데모 데이터 둘러보기 →
              </Link>
            </section>
          ) : (
            <>
              <section className="panel device-overview">
                <div className="device-heading">
                  <div className="device-product">
                    <Board small />
                    <div>
                      <h2>{selected.display_name}</h2>
                      <p>
                        <i className={"status-dot " + status.tone} />
                        {status.label}
                      </p>
                      <small className="muted">
                        {lastSeen
                          ? `마지막 수신 ${date(lastSeen)} · ${relative(lastSeen)}`
                          : "아직 수신된 데이터가 없습니다"}
                      </small>
                    </div>
                  </div>
                  <div className="device-actions">
                    <button
                      className="outline"
                      disabled={demo}
                      onClick={() => setEditing(!editing)}
                    >
                      장치 이름 변경
                    </button>
                    <button className="outline" disabled={demo} onClick={() => setHttpDemo(true)}>
                      HTTP 학습 연결
                    </button>
                    <button
                      className="outline"
                      onClick={() => openUsim(selected.id)}
                    >
                      USIM 충전하기
                    </button>
                    <button
                      className="outline"
                      disabled={demo}
                      onClick={() => setTick((t) => t + 1)}
                    >
                      새로고침
                    </button>
                  </div>
                </div>
                {editing && !demo && (
                  <form
                    className="rename-form"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      setBusy(true);
                      try {
                        await request(`/devices/${selected.id}`, {
                          method: "POST",
                          body: { display_name: name },
                        });
                        setEditing(false);
                        setTick((t) => t + 1);
                      } catch (e) {
                        setError(e.message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <label>
                      장치 이름
                      <input
                        value={name}
                        required
                        maxLength={60}
                        onChange={(e) => setName(e.target.value)}
                      />
                    </label>
                    <button className="button" disabled={busy}>
                      저장
                    </button>
                    <button type="button" onClick={() => setEditing(false)}>
                      취소
                    </button>
                  </form>
                )}
              </section>
              {!data && !error ? (
                <p className="panel empty" role="status">
                  장치 정보를 불러오는 중입니다.
                </p>
              ) : (
                data && (
                  <>
                    <div className="device-summary-grid">
                      <section className="panel">
                        <h2>장치 현황</h2>
                        <table className="status-table">
                          <thead>
                            <tr>
                              <th>항목</th>
                              <th>상태</th>
                              <th>상세 정보</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr>
                              <th>서버 연결</th>
                              <td>{status.label}</td>
                              <td>{demo ? "체험용 온라인 상태" : "최근 3분 수신 기준"}</td>
                            </tr>
                            <tr>
                              <th>LTE</th>
                              <td>
                                {latest?.reg === 1 || latest?.reg === 5
                                  ? "망 등록"
                                  : "미확인"}
                              </td>
                              <td>
                                {latest ? "마지막 보고 기준" : "수신 이력 없음"}
                              </td>
                            </tr>
                            <tr>
                              <th>GPS</th>
                              <td>
                                {position
                                  ? Date.now() -
                                      Date.parse(position.recorded_at) <
                                    180000
                                    ? "위치 확보"
                                    : "이전 위치 있음"
                                  : "미수신"}
                              </td>
                              <td>
                                {position
                                  ? relative(position.recorded_at)
                                  : "하늘이 보이는 곳에서 확인하세요"}
                              </td>
                            </tr>
                            <tr>
                              <th>USIM</th>
                              <td
                                className={
                                  simStatus.warning ? "warning-text" : ""
                                }
                              >
                                {simStatus.label}
                              </td>
                              <td>
                                {sim?.last4
                                  ? "···· " + sim.last4
                                  : "연결된 USIM 없음"}
                              </td>
                            </tr>
                            <tr>
                              <th>최근 데이터</th>
                              <td>{latest ? "수신 이력 있음" : "미수신"}</td>
                              <td>{date(latest?.received_at)}</td>
                            </tr>
                          </tbody>
                        </table>
                        <p className="muted status-note">
                          오프라인은 수신이 끊긴 상태입니다. 전원 OFF 여부는
                          직접 확인해 주세요.
                        </p>
                      </section>
                      <section className="panel">
                        <div className="panel-title">
                          <h2>USIM 및 사용 정보</h2>
                          <button className="text-link" onClick={() => openUsim(selected.id)}>
                            USIM 충전하기 →
                          </button>
                        </div>
                        <dl className="detail-list">
                          <div>
                            <dt>USIM</dt>
                            <dd>
                              {sim?.last4 ? "···· " + sim.last4 : "미연결"}
                            </dd>
                          </div>
                          <div>
                            <dt>통신 서비스</dt>
                            <dd>{sim?.linked ? "1NCE" : "—"}</dd>
                          </div>
                          <div>
                            <dt>남은 데이터</dt>
                            <dd>
                              {usage
                                ? `${number(usage.remaining_mb, 2)} / ${number(usage.total_mb, 0)} MB`
                                : "조회 대기"}
                            </dd>
                          </div>
                          <div>
                            <dt>사용 기한</dt>
                            <dd>{demo ? "데모에서는 기한을 표시하지 않습니다" : usage?.expires_at || "확인된 기한 없음"}</dd>
                          </div>
                          <div>
                            <dt>상태</dt>
                            <dd
                              className={
                                simStatus.warning ? "warning-text" : ""
                              }
                            >
                              {simStatus.label}
                            </dd>
                          </div>
                          <div>
                            <dt>마지막 조회</dt>
                            <dd>
                              {sim?.updated_at
                                ? date(sim.updated_at)
                                : "조회 전"}
                            </dd>
                          </div>
                        </dl>
                        {usage && (
                          <progress
                            aria-label="USIM 남은 데이터"
                            max={usage.total_mb || 1}
                            value={Math.max(0, usage.remaining_mb)}
                          />
                        )}
                        <p className="muted">
                          {demo ? "350 / 500 MB는 화면 안내를 위한 예시 잔량입니다." : sim?.error ||
                            "통신사 마지막 조회값이며 집계 지연이 있을 수 있습니다."}
                        </p>
                        {simStatus.warning && (
                          <Link
                            className="button"
                            to={`/usim?device=${selected.id}`}
                          >
                            USIM 충전 내역
                          </Link>
                        )}
                      </section>
                    </div>
                    <div className="device-recent-grid">
                      <section className="panel history">
                        <div className="panel-title">
                          <h2>최근 데이터</h2>
                          <Link to={demo ? "/data" : `/data?device=${selected.id}`}>
                            전체 보기 →
                          </Link>
                        </div>
                        <div className="table-scroll">
                          <table>
                            <thead>
                              <tr>
                                <th>수신 시각</th>
                                {channels.map((c) => (
                                  <th key={c.id}>
                                    {c.label} ({c.unit})
                                  </th>
                                ))}
                                <th>PV (V)</th>
                                <th>LTE (CSQ)</th>
                              </tr>
                            </thead>
                            <tbody>
                              {rows.map((r) => (
                                <tr key={r.id}>
                                  <td>{date(r.received_at)}</td>
                                  {channels.map((c) => (
                                    <td key={c.id}>
                                      {number(r.values_json?.[c.id], 2)}
                                    </td>
                                  ))}
                                  <td>
                                    {number(
                                      r.pv_mv == null ? null : r.pv_mv / 1000,
                                      2,
                                    )}
                                  </td>
                                  <td>{validCsq(r.csq) ? r.csq : "—"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {!rows.length && (
                          <p className="empty">
                            {latest
                              ? "최근 7일 이내 데이터가 없습니다."
                              : "아직 데이터가 수신되지 않았습니다."}
                          </p>
                        )}
                      </section>
                      <MapPanel key={selected.id} position={position} demo={demo} />
                    </div>
                  </>
                )
              )}
            </>
          )}
        </div>
      </div>
      {httpDemo && user && selected && !demo && <HttpDemoDialog key={`${user.id}:${selected.id}`} device={selected} close={() => setHttpDemo(false)} />}
      {claim && user && (
        <ClaimDialog
          close={() => setClaim(false)}
          done={(id) => {
            navigate(`/devices?device=${encodeURIComponent(id)}`);
            setTick((t) => t + 1);
            setClaim(false);
          }}
        />
      )}
      {demo && demoUsim && <Modal title="USIM 충전 안내 · 데모" close={() => setDemoUsim(false)}>
        <p className="notice">체험 화면입니다. 실제 포인트 차감이나 USIM 충전 요청은 실행되지 않습니다.</p>
        <h3>USIM 잔량 예시</h3>
        <p><strong>350 MB / 500 MB</strong> · 예시 USIM ···· 1234</p>
        <ol className="demo-recharge-steps">
          <li>예제를 그대로 업로드하고 시리얼 등록 코드로 내 장치에 연결합니다.</li>
          <li>장착된 USIM의 실제 잔량과 상태를 확인합니다.</li>
          <li>내 장치 또는 요금 안내의 USIM 충전하기에서 같은 장치를 선택합니다.</li>
          <li>상품이 판매 중일 때 용량·차감 포인트를 확인하고 충전을 요청합니다.</li>
        </ol>
        <div className="actions">
          <Link className="button" to="/pricing">요금 안내 보기</Link>
          <button className="outline" onClick={() => setDemoUsim(false)}>닫기</button>
        </div>
      </Modal>}
    </main>
  );
}
