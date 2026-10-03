import React, { useContext, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Session } from "./session";
import { request, query, timeRange } from "./api";
import { Board, Icon, Chart, Metric, number } from "./components";
import { useDeviceList, useSelectedDevice } from "./DeviceNavigation";
import DemoDashboard from "./DemoDashboard";
export default function Home() {
  const { user } = useContext(Session),
    { devices, loading, error } = useDeviceList();
  const [selected, select] = useSelectedDevice(devices),
    [hours, setHours] = useState(1),
    [result, setResult] = useState(null),
    [failure, setFailure] = useState("");
  useEffect(() => {
    if (!selected) {
      setFailure("");
      setResult(null);
      return;
    }
    const abort = new AbortController();
    setFailure("");
    request(`/devices/${selected.id}/summary?${query(timeRange(hours))}`, {
      signal: abort.signal,
    })
      .then((summary) => {
        if (!abort.signal.aborted)
          setResult({ id: selected.id, hours, summary });
      })
      .catch((e) => {
        if (e.name !== "AbortError") setFailure(e.message);
      });
    return () => abort.abort();
  }, [selected?.id, selected?.last_seen_at, hours]);
  const summary =
    result?.id === selected?.id && result?.hours === hours
      ? result.summary
      : null;
  const channels = (summary?.channels || []).filter((c) => c.active),
    first = channels[0];
  return (
    <>
      <section className="hero simple-hero">
        <div className="hero-inner">
          <div className="hero-copy">
            <h1>
              LTE와 GPS를 하나의 쉴드에
              <br />
              센서 확장까지 더 간편하게
            </h1>
            <p className="hero-description">
              USIM 기반 LTE 통신과 GPS 기능을 지원하며,
              <br />{" "}
              다양한 센서를 추가로 연결해 여러 IoT 프로젝트를 손쉽게 구현할 수 있습니다.
            </p>
            <div className="actions">
              <Link className="button" to="/guide">
                시작 가이드 <Icon name="arrow" size={17} />
              </Link>
              <Link className="outline" to="/examples">
                <Icon name="code" />
                예제 보기
              </Link>
            </div>
          </div>
          <div className="hero-art">
            <div className="orb" />
            <Board />
          </div>
        </div>
      </section>
      <main className="container home-content">
        <div className="quick-links simple-quick">
          {[
            ["sim", "USIM 관리", "/devices"],
            ["book", "예제 라이브러리", "/examples"],
            ["data", "데이터 보기", "/data"],
          ].map(([icon, label, to]) => (
            <Link className="quick-card" key={label} to={to}>
              <Icon name={icon} size={28} />
              <h2>{label}</h2>
            </Link>
          ))}
          <Link className="button" to="/devices">
            <Icon name="chip" />내 장치 연결하기 <Icon name="arrow" size={16} />
          </Link>
        </div>
        <div className="section-heading">
          <h2>내 데이터</h2>
          {devices.length > 0 && (
            <label className="home-device-select">
              장치
              <select
                value={selected?.id || ""}
                onChange={(e) => select(e.target.value)}
              >
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.display_name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {error || failure ? (
          <p className="error" role="alert">
            {error || failure}
          </p>
        ) : loading || (selected && !summary) ? (
          <p className="panel empty" role="status">
            데이터를 불러오는 중입니다.
          </p>
        ) : !user || !selected || !summary?.latest ? (
          <DemoDashboard compact />
        ) : (
          <>
            <div className="metrics two">
              {channels.length ? (
                channels
                  .slice(0, 2)
                  .map((c) => (
                    <Metric
                      key={c.id}
                      icon="data"
                      label={c.label}
                      value={number(c.latest?.value, 2)}
                      unit={c.unit}
                    />
                  ))
              ) : (
                <>
                  <Metric
                    icon="signal"
                    label="PV 입력 전압"
                    value={number(
                      summary.latest.pv_mv == null
                        ? null
                        : summary.latest.pv_mv / 1000,
                      2,
                    )}
                    unit="V"
                  />
                  <Metric
                    icon="data"
                    label="오늘 수신"
                    value={summary.received_today}
                    unit="건"
                  />
                </>
              )}
            </div>
            <section className="panel">
              <div className="panel-title">
                <h2>{first ? `${first.label} 변화` : "PV 입력 전압"}</h2>
                <div className="tabs small-tabs">
                  {[1, 6, 24].map((h) => (
                    <button
                      key={h}
                      onClick={() => setHours(h)}
                      className={hours === h ? "active" : ""}
                      aria-pressed={hours === h}
                    >
                      {h}시간
                    </button>
                  ))}
                </div>
              </div>
              <Chart
                points={first?.chart || summary.chart}
                field={first ? "value" : "pv_mv"}
                unit={first?.unit || "mV"}
              />
            </section>
          </>
        )}
      </main>
      <section className="start-strip">
        <div className="container">
          <span className="eyebrow">GET STARTED</span>
          <h2>3단계로 시작하기</h2>
          <div>
            {[
              ["chip", "쉴드 연결", "/guide"],
              ["code", "예제 업로드", "/examples"],
              ["data", "데이터 확인", "/data"],
            ].map(([icon, label, to], i) => (
              <Link key={to} to={to}>
                <span className="step-number">{i + 1}</span>
                <Icon name={icon} size={30} />
                <strong>{label}</strong>
                <Icon name="arrow" size={17} />
              </Link>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
