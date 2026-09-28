import React, {
  createContext,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { request } from "./api";
export const Session = createContext(null);
export function SessionProvider({ children }) {
  const [user, setUser] = useState(undefined),
    [error, setError] = useState("");
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const version = ++generation.current;
    try {
      const next = await request("/auth/session");
      if (version === generation.current) {
        setUser(next);
        setError("");
      }
    } catch (e) {
      if (version === generation.current) {
        setUser(null);
        setError(e.status === 401 ? "" : "로그인 상태를 확인하지 못했습니다.");
      }
    }
  }, []);
  // A shared cookie can change in another tab; every account change remounts private views.
  useEffect(() => {
    reload();
    const update = (event) => {
      if (event.key !== "shield-session-event") return;
      setUser(undefined);
      reload();
    };
    window.addEventListener("storage", update);
    const focus = () => {
      if (!document.hidden) reload();
    };
    document.addEventListener("visibilitychange", focus);
    return () => {
      ++generation.current;
      window.removeEventListener("storage", update);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [reload]);
  const changed = async () => {
    setUser(undefined);
    try {
      localStorage.setItem("shield-session-event", String(Date.now()));
    } catch {}
    await reload();
  };
  const logout = async () => {
    await request("/auth/logout", { method: "POST" });
    ++generation.current;
    setUser(null);
    try {
      localStorage.setItem("shield-session-event", String(Date.now()));
    } catch {}
  };
  return (
    <Session.Provider value={{ user, reload, changed, logout }}>
      {error && (
        <div className="global-error" role="alert">
          로그인 상태를 확인하지 못했습니다.{" "}
          <button onClick={reload}>다시 확인</button>
        </div>
      )}
      {children}
    </Session.Provider>
  );
}
