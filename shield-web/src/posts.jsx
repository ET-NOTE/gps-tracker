import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { request } from "./api";
const Posts = createContext(null);
export function PostsProvider({ children }) {
  const [posts, setPosts] = useState([]),
    [settings, setSettings] = useState({ guide_slug: "start" }),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    try {
      const [next, config] = await Promise.all([
        request("/posts"),
        request("/site-settings"),
      ]);
      setPosts(next);
      setSettings(config);
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);
  return (
    <Posts.Provider value={{ posts, settings, error, loading, reload }}>
      {children}
    </Posts.Provider>
  );
}
export function usePosts() {
  return useContext(Posts);
}
export function PostStatus() {
  const { error, loading, reload } = usePosts();
  return error ? (
    <p className="error" role="alert">
      게시물을 불러오지 못했습니다. <button onClick={reload}>다시 시도</button>
    </p>
  ) : loading ? (
    <p className="notice">게시물을 불러오는 중입니다.</p>
  ) : null;
}
