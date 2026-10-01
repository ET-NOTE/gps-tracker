import React, { useEffect, useRef, useState, useId } from "react";
import { Link } from "react-router-dom";
import { pathSegments } from "./telemetry";

export function Icon({ name, size = 22, ...props }) {
  const paths = {
    chat: <path d="M4 3h16v13H9l-5 5z"/>,
    mail: <><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 5 10 8L22 5"/></>,
    chip: (
      <>
        <rect x="5" y="5" width="14" height="14" rx="3" />
        <path d="M9 1v4m6-4v4M9 19v4m6-4v4M1 9h4m-4 6h4m14-6h4m-4 6h4" />
        <rect x="9" y="9" width="6" height="6" rx="1" />
      </>
    ),
    book: (
      <>
        <path d="M3 4h6l3 2 3-2h6v15h-6l-3 2-3-2H3zM12 6v15" />
      </>
    ),
    data: (
      <>
        <path d="M4 19V9h4v10m3 0V4h4v15m3 0v-7h3v7M2 21h21" />
      </>
    ),
    sim: (
      <>
        <path d="M7 2h8l4 4v16H5V4z" />
        <rect x="8" y="10" width="8" height="8" rx="1" />
        <path d="M12 10v8m-4-4h8" />
      </>
    ),
    pin: (
      <>
        <path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0z" />
        <circle cx="12" cy="10" r="2.5" />
      </>
    ),
    temp: (
      <>
        <path d="M9 14V5a3 3 0 0 1 6 0v9a5 5 0 1 1-6 0z" />
        <path d="M12 7v10" />
      </>
    ),
    drop: <path d="M12 2s7 9 7 13a7 7 0 1 1-14 0c0-4 7-13 7-13z" />,
    signal: (
      <>
        <path d="M4 21v-4m5 4V12m5 9V7m5 14V2" strokeWidth="3" />
      </>
    ),
    arrow: <path d="m9 5 7 7-7 7" />,
    download: (
      <>
        <path d="M12 2v13m-5-5 5 5 5-5M4 17v5h16v-5" />
      </>
    ),
    user: (
      <>
        <circle cx="12" cy="7" r="4" />
        <path d="M4 22v-4a8 8 0 0 1 16 0v4" />
      </>
    ),
    code: <path d="m7 6-6 6 6 6m10-12 6 6-6 6M14 2l-4 20" />,
    close: <path d="m5 5 14 14M5 19 19 5" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 6v6l4 2" />
      </>
    ),
    check: <path d="m5 12 4 4L20 5" />,
    search: (
      <>
        <circle cx="10" cy="10" r="7" />
        <path d="m15 15 7 7" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[name] || paths.chip}
    </svg>
  );
}
export function Brand() {
  return (
    <Link to="/" className="brand">
      <span className="brand-mark">
        <Icon name="chip" size={27} />
      </span>
      LTE GPS Shield
    </Link>
  );
}
export function Board({ variant = "board", small = false }) {
  const unique = useId().replaceAll(":", "");
  return (
    <svg
      className={"board-art " + (small ? "small" : "")}
      viewBox="0 0 560 350"
      role="img"
      aria-label={
        variant === "sensor"
          ? "온습도 센서와 쉴드 설명 그림"
          : "SIM7080G LTE GNSS 쉴드 설명 그림"
      }
    >
      <defs>
        <linearGradient id={"pcb-" + unique} x2="1" y2="1">
          <stop stopColor="#168d86" />
          <stop offset="1" stopColor="#064e57" />
        </linearGradient>
        <filter id={"shadow-" + unique}>
          <feDropShadow
            dx="0"
            dy="16"
            stdDeviation="14"
            floodColor="#005963"
            floodOpacity=".18"
          />
        </filter>
      </defs>
      <g
        transform="translate(88 42) rotate(-9 180 130)"
        filter={"url(#shadow-" + unique + ")"}
      >
        <path
          d="M20 40h305l25 25v193H5V56z"
          fill={"url(#pcb-" + unique + ")"}
          stroke="#0c5b59"
          strokeWidth="4"
        />
        {[30, 70, 110, 150, 190, 230, 270, 310].map((x) => (
          <g key={x}>
            <path d={`M${x} 42V20m0 222v25`} stroke="#c9b789" strokeWidth="6" />
            <rect x={x - 10} y="38" width="20" height="22" fill="#253c3e" />
            <rect x={x - 10} y="234" width="20" height="22" fill="#253c3e" />
          </g>
        ))}
        <path
          d="M40 100h65v-20h160m-214 70h80v40h158M60 218h80v-35h150"
          fill="none"
          stroke="#75c4a6"
          strokeWidth="2"
          opacity=".6"
        />
        <rect
          x="105"
          y="85"
          width="142"
          height="117"
          rx="4"
          fill="#d9e4e0"
          stroke="#9caeaa"
          strokeWidth="3"
        />
        <text
          x="176"
          y="132"
          textAnchor="middle"
          fill="#34504f"
          fontSize="23"
          fontWeight="700"
        >
          SIM7080G
        </text>
        <text x="176" y="155" textAnchor="middle" fill="#57716b" fontSize="13">
          LTE + GNSS
        </text>
        <rect
          x="7"
          y="105"
          width="51"
          height="47"
          rx="3"
          fill="#d7ddda"
          stroke="#859591"
          strokeWidth="3"
        />
        <rect x="15" y="116" width="20" height="26" fill="#304142" />
        {[80, 270, 296].map((x) => (
          <g key={x}>
            <rect x={x} y="180" width="16" height="26" fill="#263f40" />
            <path
              d={`M${x + 3} 176v-6m10 6v-6`}
              stroke="#d2bd7b"
              strokeWidth="4"
            />
          </g>
        ))}
        <circle cx="288" cy="90" r="9" fill="#ddca8b" />
        <path
          d="M288 89q140-95 110-20"
          stroke="#253f47"
          strokeWidth="6"
          fill="none"
        />
        <rect x="366" y="13" width="55" height="65" rx="12" fill="#243b42" />
        <text x="35" y="220" fill="#a7ddd0" fontSize="10" letterSpacing="3">
          SERIAL · SHIELD
        </text>
      </g>
      {variant === "sensor" && (
        <g transform="translate(390 188) rotate(12)">
          <rect width="62" height="91" rx="5" fill="#31bcdf" />
          <path
            d="M15 92v28m16-28v28m16-28v28"
            stroke="#9faeaa"
            strokeWidth="5"
          />
          {[17, 31, 45, 59, 73].map((y) => (
            <path key={y} d={`M12 ${y}h38`} stroke="#117eaa" strokeWidth="5" />
          ))}
        </g>
      )}
      {variant === "data" && (
        <g transform="translate(418 184)">
          <circle r="48" fill="#d3f4f6" />
          <path
            d="M-28 21V1m18 20v-36M8 21v-17m18 17v-50"
            stroke="#008b95"
            strokeWidth="9"
            strokeLinecap="round"
          />
        </g>
      )}
    </svg>
  );
}
export const number = (value, digits = 1) =>
  typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("ko-KR", {
        maximumFractionDigits: digits,
        minimumFractionDigits: digits,
      })
    : "—";
export const date = (value) =>
  value
    ? new Date(value).toLocaleString("ko-KR", {
        timeZone: "Asia/Seoul",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })
    : "수신 전";
export function relative(value) {
  const sec = (Date.now() - Date.parse(value)) / 1000;
  if (!Number.isFinite(sec)) return "수신 전";
  return sec < 60
    ? `${Math.max(0, Math.floor(sec))}초 전`
    : sec < 3600
      ? `${Math.floor(sec / 60)}분 전`
      : `${Math.floor(sec / 3600)}시간 전`;
}
export function Metric({ icon, label, value, unit, hint }) {
  return (
    <article className="metric">
      <Icon name={icon} size={31} />
      <div>
        <div className="metric-label">{label}</div>
        <strong>
          {value}
          <small>{unit}</small>
        </strong>
        <p>{hint}</p>
      </div>
    </article>
  );
}
export function Chart({ points = [], field = "temp_c", unit: channelUnit }) {
  const unit =
    channelUnit ??
    (field === "hum_pct" ? "%" : field === "pv_mv" ? "mV" : "°C");
  const values = points
    .map((p) => p[field])
    .filter((v) => typeof v === "number");
  if (!values.length)
    return (
      <div className="chart-empty">
        <Icon name="data" size={36} />
        <p>선택한 기간에 수신된 값이 없습니다.</p>
        <span>센서가 연결되어 있는지 확인해 주세요.</span>
      </div>
    );
  const min = Math.min(...values),
    max = Math.max(...values),
    pad = Math.max((max - min) * 0.15, field === "pv_mv" ? 5 : 1),
    lo = min - pad,
    hi = max + pad;
  const times = points.map((p) => Date.parse(p.at)),
    start = Math.min(...times),
    end = Math.max(...times);
  const x = (p) =>
      end === start
        ? 340
        : 48 + ((Date.parse(p.at) - start) / (end - start)) * 570,
    y = (v) => 162 - ((v - lo) / (hi - lo)) * 125;
  // Missing readings and gaps over 15 minutes split the line instead of inventing continuity.
  let previous = null;
  const segments = [];
  let line = [];
  points.forEach((p) => {
    if (
      typeof p[field] !== "number" ||
      (previous && Date.parse(p.at) - Date.parse(previous.at) > 900000)
    ) {
      if (line.length) segments.push(line);
      line = [];
    }
    if (typeof p[field] === "number") {
      line.push(p);
      previous = p;
    }
  });
  if (line.length) segments.push(line);
  return (
    <svg
      className="chart"
      viewBox="0 0 660 211"
      role="img"
      aria-label={`5분 평균 추이, 단위 ${unit}`}
    >
      {[0, 1, 2, 3, 4].map((i) => {
        const v = lo + ((hi - lo) * i) / 4;
        return (
          <g key={i}>
            <line x1="48" x2="618" y1={y(v)} y2={y(v)} stroke="var(--line)" />
            <text x="38" y={y(v) + 4} textAnchor="end">
              {number(v, field === "pv_mv" ? 0 : 1)}
            </text>
          </g>
        );
      })}
      {segments.map((s, i) => (
        <g key={i}>
          <polyline
            points={s.map((p) => `${x(p)},${y(p[field])}`).join(" ")}
            stroke="var(--primary)"
            strokeWidth="2.5"
            fill="none"
          />
          {s.length === 1 && (
            <circle
              cx={x(s[0])}
              cy={y(s[0][field])}
              r="3"
              fill="var(--primary)"
            />
          )}
        </g>
      ))}
      {[0, 0.33, 0.66, 1].map((f) => (
        <text key={f} x={48 + 570 * f} y="192" textAnchor="middle">
          {new Date(start + (end - start) * f).toLocaleTimeString("ko-KR", {
            timeZone: "Asia/Seoul",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })}
        </text>
      ))}
    </svg>
  );
}
export function MapPanel({ position, locations = [], demo = false }) {
  const root = useRef(null),
    map = useRef(null),
    library = useRef(null),
    layers = useRef(null);
  const initial = useRef(position);
  initial.current = position;
  const [error, setError] = useState(false),
    [ready, setReady] = useState(false);
  const hasPosition = Boolean(position);
  useEffect(() => {
    let gone = false;
    if (!hasPosition) return;
    setError(false);
    Promise.all([import("leaflet"), import("leaflet/dist/leaflet.css")])
      .then(([leaflet]) => {
        if (gone || !root.current) return;
        const L = (library.current = leaflet.default);
        const p = initial.current;
        const m = (map.current = L.map(root.current, {
          scrollWheelZoom: false,
        }).setView([p.lat, p.lng], 15));
        L.tileLayer(
          import.meta.env.VITE_TILE_URL ||
            "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
          {
            maxZoom: 19,
            attribution:
              '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
          },
        )
          .on("tileerror", () => {
            if (!gone) setError(true);
          })
          .addTo(m);
        layers.current = L.layerGroup().addTo(m);
        setReady(true);
      })
      .catch(() => {
        if (!gone) setError(true);
      });
    return () => {
      gone = true;
      map.current?.remove();
      map.current = null;
      layers.current = null;
      setReady(false);
    };
  }, [hasPosition]);
  useEffect(() => {
    if (!ready || !position || !layers.current) return;
    const L = library.current,
      layer = layers.current;
    layer.clearLayers();
    const color = getComputedStyle(root.current)
      .getPropertyValue("--primary")
      .trim();
    L.circleMarker([position.lat, position.lng], {
      radius: 9,
      color: "#fff",
      weight: 3,
      fillColor: color,
      fillOpacity: 1,
    }).addTo(layer);
    pathSegments(locations).forEach((segment) =>
      L.polyline(segment, { color, weight: 3 }).addTo(layer),
    );
    // Polling updates layers only; the user's zoom and pan remain intact.
  }, [ready, position, locations]);
  return (
    <section className="panel map-panel">
      <div className="panel-title">
        <h2>최근 위치</h2>
        <span className="muted">
          {demo
            ? "예시 위치"
            : position
              ? relative(position.recorded_at)
              : "측위 대기"}
        </span>
      </div>
      {position ? (
        <>
          <div ref={root} className="map" aria-label="최근 위치 지도" />
          {error && (
            <p className="map-notice">
              지도 배경을 불러오지 못했습니다. 아래 좌표는 확인할 수 있습니다.
            </p>
          )}
          <div className="coordinates">
            <div>
              위도<strong>{number(position.lat, 6)}</strong>
            </div>
            <div>
              경도<strong>{number(position.lng, 6)}</strong>
            </div>
            <div>
              측정 시각<strong>{date(position.recorded_at)}</strong>
            </div>
          </div>
        </>
      ) : (
        <div className="chart-empty">
          <Icon name="pin" size={36} />
          <p>아직 확보된 위치가 없습니다.</p>
          <span>GNSS 안테나를 하늘이 보이는 곳에 두세요.</span>
        </div>
      )}
    </section>
  );
}

export function Intro({ crumb, title, description, children }) {
  return (
    <div className="page-intro">
      <div>
        <p className="breadcrumb">
          <Link to="/">홈</Link>
          <span>/</span>
          {crumb || title}
        </p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children}
    </div>
  );
}
