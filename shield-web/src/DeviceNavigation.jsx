import React, { useContext, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { request } from "./api";
import { Session } from "./session";
import { Board, Icon, relative } from "./components";
export function connectionState(at, now = Date.now()) {
  if (!at || !Number.isFinite(Date.parse(at)))
    return { label: "미수신", tone: "quiet" };
  return now - Date.parse(at) <= 180000
    ? { label: "온라인", tone: "" }
    : { label: "오프라인", tone: "quiet" };
}
export function useDeviceList(tick = 0) {
  const { user, reload } = useContext(Session);
  const [result, setResult] = useState({
    owner: null,
    devices: [],
    loading: true,
    error: "",
  });
  useEffect(() => {
    if (!user) {
      setResult({
        owner: null,
        devices: [],
        loading: user === undefined,
        error: "",
      });
      return;
    }
    let gone = false,
      abort;
    const fetchList = async () => {
      abort?.abort();
      abort = new AbortController();
      const signal = abort.signal;
      try {
        const devices = await request("/devices", { signal });
        if (!gone && !signal.aborted)
          setResult({ owner: user.id, devices, loading: false, error: "" });
      } catch (e) {
        if (!gone && e.name !== "AbortError") {
          setResult((v) => ({
            ...v,
            devices: v.owner === user.id ? v.devices : [],
            owner: user.id,
            loading: false,
            error: e.message,
          }));
          if (e.status === 401) reload();
        }
      }
    };
    fetchList();
    const timer = setInterval(() => {
      if (!document.hidden) fetchList();
    }, 15000);
    return () => {
      gone = true;
      abort?.abort();
      clearInterval(timer);
    };
  }, [user?.id, tick, reload]);
  return result.owner === (user?.id ?? null)
    ? result
    : { devices: [], loading: true, error: "" };
}
export function useSelectedDevice(devices) {
  const [params, setParams] = useSearchParams();
  const selected =
    devices.find((d) => String(d.id) === params.get("device")) || devices[0];
  return [
    selected,
    (id) =>
      setParams(
        (p) => {
          const next = new URLSearchParams(p);
          next.set("device", String(id));
          return next;
        },
        { replace: true },
      ),
  ];
}
export function DeviceSidebar({
  devices,
  selected,
  onSelect,
  onRegister,
  loading = false,
  demo = false,
}) {
  return (
    <aside className="device-sidebar" aria-label="내 장치 목록">
      <div className="sidebar-heading">
        <h2>{demo ? "데모 장치" : "내 장치"}</h2>
        {onRegister ? (
          <button className="button compact" onClick={onRegister}>
            ＋ 등록
          </button>
        ) : (
          <Link className="button compact" to="/devices">
            ＋ 등록
          </Link>
        )}
      </div>
      <div className="device-list">
        {devices.map((d) => {
          const status = connectionState(d.last_seen_at);
          return (
            <button
              key={d.id}
              className={
                "device-choice " + (d.id === selected ? "selected" : "")
              }
              aria-pressed={d.id === selected}
              onClick={() => onSelect(d.id)}
            >
              <div className="device-thumb">
                <Board small />
              </div>
              <span>
                <strong>{d.display_name}</strong>
                <small>
                  <i className={"status-dot " + status.tone} />
                  {demo ? "데모" : status.label}
                </small>
                <small>
                  마지막 수신 {demo ? "예시" : relative(d.last_seen_at)}
                </small>
              </span>
            </button>
          );
        })}
      </div>
      {!devices.length && (
        <p className="muted sidebar-empty">
          {loading ? "장치 확인 중…" : "등록한 장치가 없습니다."}
        </p>
      )}
      <Link className="sidebar-help" to="/faq">
        <Icon name="book" size={19} />
        <span>
          연결이 궁금하신가요?<small>자주 묻는 질문 →</small>
        </span>
      </Link>
    </aside>
  );
}
