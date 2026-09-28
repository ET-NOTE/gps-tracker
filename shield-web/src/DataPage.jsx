import React, {
  useContext,
  useState,
  useRef,
  useEffect,
  useCallback,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Session } from "./session";
import { request, query, exportReadings, timeRange } from "./api";
import {
  Icon,
  Intro,
  Metric,
  Chart,
  MapPanel,
  number,
  date,
  relative,
} from "./components";
import { validCsq } from "./telemetry";
function ClaimDialog({ done, close }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const dialog = useRef();
  useEffect(() => {
    dialog.current.showModal();
  }, []);
  return (
    <dialog ref={dialog} onCancel={close}>
      <div className="dialog-heading">
        <h2>내 쉴드 등록</h2>
        <button aria-label="닫기" className="icon-button" onClick={close}>
          <Icon name="close" />
        </button>
      </div>
      <p>제품과 함께 받은 일회용 등록 코드를 입력하세요.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          const f = new FormData(e.currentTarget);
          try {
            const d = await request("/devices/claim", {
              method: "POST",
              body: { display_name: f.get("name"), claim_code: f.get("code") },
            });
            done(d.id);
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
            name="name"
            required
            maxLength={60}
            placeholder="예: 창가 온습도 센서"
            autoFocus
          />
        </label>
        <label>
          장치 등록 코드
          <input
            name="code"
            autoComplete="off"
            required
            minLength={64}
            maxLength={64}
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="button" disabled={busy}>
          {busy ? "등록 중…" : "장치 등록"}
        </button>
      </form>
    </dialog>
  );
}
export default function DataPage() {
  const { reload } = useContext(Session);
  const [params, setParams] = useSearchParams();
  const [devices, setDevices] = useState([]),
    [id, setId] = useState(null),
    [hours, setHours] = useState(24),
    [auto, setAuto] = useState(true),
    [tick, setTick] = useState(0),
    [inventory, setInventory] = useState(0),
    [claim, setClaim] = useState(false),
    [bundle, setBundle] = useState(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [field, setField] = useState(""),
    [showHistory, setShowHistory] = useState(false),
    [cursors, setCursors] = useState([{}]),
    [page, setPage] = useState(0),
    [exporting, setExporting] = useState(false);
  const exporter = useRef(null),
    generation = useRef(0);
  const [range, setRange] = useState(() => timeRange(24));
  useEffect(() => {
    const abort = new AbortController();
    request("/devices", { signal: abort.signal })
      .then((list) => {
        setDevices(list);
        setId((previous) =>
          list.some((d) => d.id === previous)
            ? previous
            : (list.find((d) => String(d.id) === params.get("device"))?.id ??
              list[0]?.id ??
              null),
        );
        setLoading(false);
      })
      .catch((e) => {
        if (e.name !== "AbortError") {
          setError(e.message);
          setLoading(false);
          if (e.status === 401) reload();
        }
      });
    return () => abort.abort();
  }, [inventory, reload]);
  useEffect(() => {
    exporter.current?.abort();
    setExporting(false);
    setBundle(null);
    setCursors([{}]);
    setPage(0);
    setRange(timeRange(hours));
  }, [id, hours]);
  useEffect(() => {
    if (!id) return;
    const version = ++generation.current,
      abort = new AbortController();
    setLoading(true);
    setError("");
    const cursor = cursors[page] || {};
    Promise.all([
      request(`/devices/${id}/summary?${query(range)}`, {
        signal: abort.signal,
      }),
      request(
        `/devices/${id}/readings?${query({ ...range, ...cursor, limit: 20 })}`,
        { signal: abort.signal },
      ),
      request(`/devices/${id}/locations?${query({ ...range, limit: 1000 })}`, {
        signal: abort.signal,
      }),
    ])
      .then(([summary, readings, locations]) => {
        if (version === generation.current)
          setBundle({ summary, readings, locations });
      })
      .catch((e) => {
        if (e.name !== "AbortError" && version === generation.current) {
          setError(e.message);
          if ([401, 404].includes(e.status)) setBundle(null);
          if (e.status === 401) reload();
        }
      })
      .finally(() => {
        if (version === generation.current) setLoading(false);
      });
    return () => {
      ++generation.current;
      abort.abort();
    };
  }, [id, range, page, tick, reload]);
  const refresh = useCallback(() => {
    if (page === 0) setRange(timeRange(hours));
    else setTick((t) => t + 1);
  }, [hours, page]);
  useEffect(() => {
    if (!auto) return;
    const run = () => {
      if (!document.hidden) refresh();
    };
    const timer = setInterval(run, 10000);
    document.addEventListener("visibilitychange", run);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", run);
    };
  }, [auto, refresh]);
  useEffect(() => {
    let gone = false,
      retry;
    const connect = () => {
      if (gone) return;
      const ws = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`,
      );
      socket = ws;
      ws.onmessage = (e) => {
        if (gone || !auto || document.hidden) return;
        try {
          const data = JSON.parse(e.data);
          if (data.kind === "refresh" || data.device_id === id) refresh();
        } catch {}
      };
      ws.onclose = () => {
        if (!gone) retry = setTimeout(connect, 10000);
      };
    };
    let socket;
    connect();
    return () => {
      gone = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, [id, auto, refresh]);
  useEffect(() => () => exporter.current?.abort(), []);
  const selected = devices.find((d) => d.id === id),
    summary = bundle?.summary,
    latest = summary?.latest,
    position = summary?.position,
    rows = bundle?.readings.items || [];
  const allChannels = summary?.channels || [];
  const channels = allChannels.filter((c) => showHistory || c.active);
  const actualField =
    field === "pv_mv" || channels.some((c) => String(c.id) === field)
      ? field
      : String((channels.find((c) => c.active) || channels[0])?.id ?? "pv_mv");
  const selectedChannel = allChannels.find((c) => String(c.id) === actualField);

  const select = (e) => {
    const value = Number(e.target.value);
    setBundle(null);
    setId(value);
    setParams({ device: String(value) }, { replace: true });
  };
  const download = async () => {
    const abort = new AbortController();
    exporter.current = abort;
    setExporting(true);
    try {
      const text = await exportReadings(id, range, abort.signal, allChannels);
      if (abort.signal.aborted) return;
      const url = URL.createObjectURL(
        new Blob([text], { type: "text/csv;charset=utf-8" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `${selected.device_uid}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.hidden = true;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      if (e.name !== "AbortError") setError(e.message);
    } finally {
      if (exporter.current === abort) setExporting(false);
    }
  };
  return (
    <main className="container">
      <Intro
        title="내 데이터"
        description="내 디바이스에서 전송한 센서 값과 위치를 확인하세요."
      >
        <button className="outline" onClick={() => setClaim(true)}>
          ＋ 디바이스 등록
        </button>
      </Intro>
      {claim && (
        <ClaimDialog
          close={() => setClaim(false)}
          done={(id) => {
            setId(id);
            setParams({ device: String(id) }, { replace: true });
            setInventory((v) => v + 1);
            setClaim(false);
          }}
        />
      )}
      {error && (
        <p className="error" role="alert">
          {error}{" "}
          <button
            onClick={() => {
              setInventory((v) => v + 1);
              refresh();
            }}
          >
            다시 시도
          </button>
        </p>
      )}
      {!devices.length ? (
        <section className="panel empty">
          <Icon name="chip" size={46} />
          <h2>
            {loading
              ? "장치를 확인하고 있습니다"
              : "아직 등록된 쉴드가 없습니다"}
          </h2>
          <p>제품의 등록 코드로 첫 번째 쉴드를 연결해 주세요.</p>
          <button className="button" onClick={() => setClaim(true)}>
            디바이스 등록
          </button>
        </section>
      ) : (
        <>
          <div className="device-toolbar panel">
            <label>
              디바이스
              <select aria-label="디바이스" value={id || ""} onChange={select}>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.display_name}
                  </option>
                ))}
              </select>
            </label>
            <div className="device-status">
              <span>{selected?.device_uid}</span>
              <span>
                <i
                  className={
                    "status-dot " +
                    (!summary?.device.last_seen_at ||
                    Date.now() - Date.parse(summary.device.last_seen_at) >
                      180000
                      ? "quiet"
                      : "")
                  }
                />
                {summary?.device.last_seen_at
                  ? relative(summary.device.last_seen_at)
                  : "수신 대기"}
              </span>
            </div>
            <label>
              조회 기간
              <select
                value={hours}
                onChange={(e) => {
                  setHours(Number(e.target.value));
                  setAuto(true);
                }}
              >
                <option value={1}>최근 1시간</option>
                <option value={24}>최근 24시간</option>
                <option value={168}>최근 7일</option>
              </select>
            </label>
            <button
              className="outline"
              onClick={download}
              disabled={exporting || !summary?.total}
            >
              <Icon name="download" size={17} />
              {exporting ? "전체 기록 수집 중…" : "CSV 다운로드"}
            </button>
            <label className="toggle">
              <input
                type="checkbox"
                checked={auto}
                onChange={(e) => {
                  setAuto(e.target.checked);
                  if (e.target.checked) {
                    setPage(0);
                    setCursors([{}]);
                    refresh();
                  }
                }}
              />
              실시간 갱신
            </label>
          </div>
          <div className="metrics">
            {channels.map((c) => (
              <Metric
                key={c.id}
                icon="data"
                label={c.label}
                value={number(c.latest?.value, 2)}
                unit={c.unit}
                hint={`${c.sensor_set} · ${c.latest ? date(c.latest.at) : "미수신"}${c.active ? "" : " · 이전 센서"}`}
              />
            ))}
            <Metric
              icon="signal"
              label="PV 입력 전압"
              value={number(
                latest?.pv_mv == null ? null : latest.pv_mv / 1000,
                3,
              )}
              unit="V"
              hint="쉴드 A0 실측 · 배터리 잔량이 아닙니다"
            />
            <Metric
              icon="signal"
              label="LTE 신호"
              value={validCsq(latest?.csq) ? String(latest.csq) : "—"}
              unit="CSQ"
              hint={
                validCsq(latest?.csq)
                  ? `${-113 + 2 * latest.csq} dBm (CSQ 환산)`
                  : "신호 미확인"
              }
            />
            <Metric
              icon="data"
              label="오늘 수신"
              value={number(summary?.received_today, 0)}
              unit="건"
              hint="한국 시각 · 중복 제외 보고 수"
            />
          </div>
          <div className="data-charts">
            <section className="panel">
              <div className="panel-title">
                <div>
                  <h2>센서 변화</h2>
                  <p>
                    5분 평균 ·{" "}
                    {hours === 168 ? "최근 7일" : `최근 ${hours}시간`}
                  </p>
                </div>
                <div className="tabs small-tabs">
                  {[
                    ["pv_mv", "PV"],
                    ...channels.map((c) => [
                      String(c.id),
                      `${c.label} · ${c.sensor_set}`,
                    ]),
                  ].map(([key, label]) => (
                    <button
                      className={actualField === key ? "active" : ""}
                      key={key}
                      onClick={() => setField(key)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <label className="check-line">
                <input
                  type="checkbox"
                  checked={showHistory}
                  onChange={(e) => setShowHistory(e.target.checked)}
                />
                이전 센서 구성도 보기
              </label>
              {!channels.length && (
                <p className="muted">
                  수신한 센서 채널이 있으면 카드와 기록 열이 자동으로
                  추가됩니다. 현재는 쉴드 자체 측정값을 표시합니다.
                </p>
              )}
              <Chart
                points={
                  actualField === "pv_mv"
                    ? summary?.chart || []
                    : selectedChannel?.chart || []
                }
                field={actualField === "pv_mv" ? "pv_mv" : "value"}
                unit={
                  actualField === "pv_mv" ? "mV" : selectedChannel?.unit || ""
                }
              />
              {actualField !== "pv_mv" && (
                <div className="chart-stats">
                  {[
                    ["min", "최저"],
                    ["avg", "평균"],
                    ["max", "최고"],
                  ].map(([key, label]) => (
                    <div key={key}>
                      {label}
                      <strong>
                        {number(selectedChannel?.stats?.[key], 2)}{" "}
                        {selectedChannel?.unit}
                      </strong>
                    </div>
                  ))}
                </div>
              )}
            </section>
            <MapPanel
              key={id}
              position={position}
              locations={bundle?.locations.items}
            />
          </div>
          <section className="panel history">
            <div className="panel-title">
              <div>
                <h2>
                  데이터 수신 기록{" "}
                  <span className="muted">
                    총 {number(summary?.total, 0)}건
                  </span>
                </h2>
                <p>한국 시각 · 센서 UTC가 없으면 서버 수신 시각으로 표시</p>
              </div>
              <button
                className="icon-button"
                aria-label="수신 기록 새로고침"
                onClick={refresh}
                disabled={loading}
              >
                <Icon name="clock" />
              </button>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    {[
                      "기록 시각",
                      "센서 구성",
                      ...channels.map(
                        (c) => `${c.label} (${c.unit}) · ${c.sensor_set}`,
                      ),
                      "PV (V)",
                      "CSQ",
                      "측정 기준",
                      "펌웨어",
                    ].map((s) => (
                      <th key={s}>{s}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>{date(r.recorded_at)}</td>
                      <td>{r.sensor_set || "쉴드 상태"}</td>
                      {channels.map((c) => (
                        <td key={c.id}>{number(r.values_json?.[c.id], 2)}</td>
                      ))}
                      <td>
                        {number(r.pv_mv == null ? null : r.pv_mv / 1000, 3)}
                      </td>
                      <td>{validCsq(r.csq) ? r.csq : "—"}</td>
                      <td>
                        <span className="badge neutral">
                          {r.measured_at ? "센서 측정" : "상태 수신"}
                        </span>
                      </td>
                      <td>{r.build_tag}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!rows.length && (
              <p className="empty">
                {loading
                  ? "기록을 불러오는 중입니다."
                  : "이 기간에 수신된 기록이 없습니다."}
              </p>
            )}
            <div className="pagination">
              <span>
                {loading
                  ? "갱신 중…"
                  : `${page + 1}페이지 · ${rows.length}건 표시`}
              </span>
              <div>
                <button
                  disabled={!page}
                  onClick={() => {
                    setAuto(false);
                    setPage((p) => p - 1);
                  }}
                >
                  이전
                </button>
                <strong>{page + 1}</strong>
                <button
                  disabled={!bundle?.readings.next || loading}
                  onClick={() => {
                    setAuto(false);
                    setCursors((c) => [
                      ...c.slice(0, page + 1),
                      bundle.readings.next,
                    ]);
                    setPage((p) => p + 1);
                  }}
                >
                  다음
                </button>
              </div>
            </div>
          </section>
          <p className="muted footnote">
            지도 경로는 조회 기간 중 최신 1,000개 좌표까지 표시합니다. PV는
            배터리 잔량이 아닙니다. GNSS 위치가 없어도 센서와 통신 상태는
            수신됩니다.
          </p>
          <Link className="help-banner" to="/guide">
            <Icon name="book" />
            <span>
              <strong>데이터가 보이지 않나요?</strong> 디바이스 연결과 첫 데이터
              전송 가이드를 확인하세요.
            </span>
            <Icon name="arrow" size={16} />
          </Link>
        </>
      )}
    </main>
  );
}
