import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { demoData } from "./demo";
import { Metric, Chart, MapPanel, number, date } from "./components";
import { DeviceSidebar } from "./DeviceNavigation";
export default function DemoDashboard({
  compact = false,
  sidebar = false,
  message = "실제 장치 데이터가 아닌 체험용 데이터입니다.",
}) {
  const [hours, setHours] = useState(1),
    [field, setField] = useState("temp_c");
  const data = useMemo(() => demoData(hours), [hours]);
  const body = (
    <div className="demo-dashboard">
      <div className="demo-notice">
        <span className="badge demo">데모 데이터</span>
        <span>{message}</span>
        {!compact && <Link to="/devices">내 장치 등록 →</Link>}
      </div>
      {compact && (
        <div className="metrics two">
          <Metric
            icon="temp"
            label="온도"
            value={number(data.latest.temp_c)}
            unit="°C"
          />
          <Metric
            icon="drop"
            label="습도"
            value={number(data.latest.hum_pct, 0)}
            unit="%"
          />
        </div>
      )}
      <div className={compact ? "" : "data-charts"}>
        <section className="panel">
          <div className="panel-title">
            <h2>{field === "temp_c" ? "온도" : "습도"} 변화</h2>
            <div className="tabs small-tabs">
              {[1, 6, 24].map((h) => (
                <button
                  key={h}
                  aria-pressed={hours === h}
                  className={hours === h ? "active" : ""}
                  onClick={() => setHours(h)}
                >
                  {h}시간
                </button>
              ))}
            </div>
          </div>
          {!compact && (
            <div className="tabs small-tabs">
              {[
                ["temp_c", "온도"],
                ["hum_pct", "습도"],
              ].map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setField(key)}
                  aria-pressed={field === key}
                  className={field === key ? "active" : ""}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <Chart
            points={data.chart}
            field={field}
            unit={field === "temp_c" ? "°C" : "%"}
          />
        </section>
        {!compact && <MapPanel position={data.position} demo />}
      </div>
      {!compact && (
        <section className="panel history">
          <div className="panel-title">
            <h2>데모 수신 기록</h2>
            <span className="badge demo">합성 데이터</span>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>수신 시각</th>
                  <th>온도 (°C)</th>
                  <th>습도 (%)</th>
                  <th>구분</th>
                </tr>
              </thead>
              <tbody>
                {data.items.slice(0, 5).map((r) => (
                  <tr key={r.id}>
                    <td>{date(r.recorded_at)}</td>
                    <td>{number(r.temp_c)}</td>
                    <td>{number(r.hum_pct)}</td>
                    <td>데모</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
  return sidebar ? (
    <div className="device-workspace">
      <DeviceSidebar
        devices={[data.device]}
        selected="demo"
        onSelect={() => {}}
        demo
      />
      <div className="workspace-main">
        <div className="device-heading">
          <h2>LTE GPS Shield · 데모</h2>
          <Link className="outline" to="/login?next=/data">
            로그인
          </Link>
        </div>
        {body}
      </div>
    </div>
  ) : (
    body
  );
}
