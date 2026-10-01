import React, { useContext, useEffect, useState } from "react";
import {
  Link,
  Route,
  Routes,
  useNavigate,
  useLocation,
  useSearchParams,
} from "react-router-dom";
import { request } from "./api";
import { Session, SessionProvider } from "./session";
import DataPage from "./DataPage";
import { Intro, Icon } from "./components";
import { PostsProvider } from "./posts";
import AdminPage from "./AdminPage";
import UsimPage from "./UsimPage";
import { Header, Footer } from "./SiteShell";
import Home from "./HomePage";
import { Library, Catalog, LessonPage, GuidePage } from "./LibraryPages";
import DevicesPage from "./DevicesPage";
import { FaqPage, AccountPage, PointsPage } from "./AccountPages";

function Auth() {
  const { user, changed } = useContext(Session);
  const [params, setParams] = useSearchParams();
  const register = params.get("mode") === "register";
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const next = [
    "/data",
    "/devices",
    "/usim",
    "/admin",
    "/account",
    "/points",
  ].includes(params.get("next"))
    ? params.get("next")
    : "/data";
  useEffect(() => {
    if (user) navigate(next, { replace: true });
  }, [user, next, navigate]);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget);
    try {
      await request("/auth/" + (register ? "register" : "login"), {
        method: "POST",
        body: {
          email: f.get("email"),
          password: f.get("password"),
          ...(register
            ? { display_name: f.get("name"), invite_code: f.get("invite") }
            : {}),
        },
      });
      await changed();
      navigate(next, { replace: true });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="auth-page">
      <section className="panel auth-card">
        <span className="auth-mark">
          <Icon name="chip" size={39} />
        </span>
        <h1>
          {register ? "나만의 프로젝트를 시작하세요" : "다시 만나 반갑습니다"}
        </h1>
        <p>
          Shield 전용 계정으로 연결하세요.
          <br />
          GPS 서비스의 계정과 별도로 관리됩니다.
        </p>
        <div className="tabs auth-tabs">
          <button
            className={!register ? "active" : ""}
            onClick={() => {
              setError("");
              setParams({ next });
            }}
          >
            로그인
          </button>
          <button
            className={register ? "active" : ""}
            onClick={() => {
              setError("");
              setParams({ mode: "register", next });
            }}
          >
            초대코드로 가입
          </button>
        </div>
        <form onSubmit={submit}>
          {register && (
            <label>
              이름
              <input
                name="name"
                autoComplete="nickname"
                required
                maxLength={50}
              />
            </label>
          )}
          <label>
            이메일
            <input
              name="email"
              type="email"
              autoComplete="username"
              required
              maxLength={254}
            />
          </label>
          <label>
            비밀번호
            <input
              name="password"
              type="password"
              autoComplete={register ? "new-password" : "current-password"}
              minLength={10}
              maxLength={128}
              required
              placeholder="10자 이상"
            />
          </label>
          {register && (
            <label>
              초대코드
              <input
                name="invite"
                autoComplete="off"
                required
                minLength={64}
                maxLength={64}
                placeholder="전달받은 초대코드를 입력하세요"
              />
            </label>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="button" disabled={busy}>
            {busy ? "확인 중…" : register ? "계정 만들기" : "로그인"}
          </button>
        </form>
        <p className="muted">
          초대코드와 장치 등록 코드는 서로 다릅니다.
          <br />
          가입 후 제품의 등록 코드로 쉴드를 연결하세요.
        </p>
      </section>
    </main>
  );
}
function Protected({ children }) {
  const { user } = useContext(Session);
  const { pathname } = useLocation();
  if (user === undefined)
    return (
      <main className="container empty" role="status">
        로그인 상태를 확인하고 있습니다.
      </main>
    );
  if (!user)
    return (
      <main className="container empty">
        <Icon name="user" size={40} />
        <h1>로그인하고 내 쉴드를 관리하세요</h1>
        <p>장치와 USIM, 포인트는 내 계정에서 안전하게 관리합니다.</p>
        <Link
          className="button"
          to={"/login?next=" + encodeURIComponent(pathname)}
        >
          로그인
        </Link>
        <Link className="text-link" to="/data">
          데모 데이터 둘러보기 →
        </Link>
      </main>
    );
  return <React.Fragment key={user.id}>{children}</React.Fragment>;
}
function About() {
  return (
    <main className="container article">
      <Intro
        title="서비스 안내"
        description="LTE GPS Shield의 첫 프로젝트를 위한 전용 공간입니다."
      />
      <section className="panel instructions">
        <h2>초기 운영 안내</h2>
        <p>
          현재 초대코드로 가입할 수 있습니다. GPS 서비스와 계정·데이터가
          분리되며, 로그인한 소유자만 실제 센서와 위치 기록을 확인할 수
          있습니다.
        </p>
        <h2>데이터와 예제</h2>
        <p>
          홈의 데모는 합성 데이터입니다. 제품 설명 그림은 일러스트이며 실제
          배선과 핀 배치는 제품 표기를 기준으로 확인하세요.
        </p>
        <h2>USIM과 결제</h2>
        <p>
          USIM 잔량은 통신사 조회값으로 표시합니다. 충전 요청은 Shield 전용
          포인트를 사용하며, 관리자의 확인 후 통신사에 주문합니다. 기존 GPS
          계정의 포인트와는 별도로 관리됩니다. 온라인 카드 결제는 아직 준비
          중입니다. 포인트 충전은 제품 담당자에게 요청해 주세요.
        </p>
        <h2>지원이 필요하면</h2>
        <p>
          제품을 제공한 담당자에게 장치 ID와 오류 시각을 전달해 주세요.
          비밀번호와 단말 키는 전달하지 마세요.
        </p>
      </section>
    </main>
  );
}
function NotFound() {
  return (
    <main className="container empty">
      <h1>페이지를 찾을 수 없습니다.</h1>
      <Link className="button" to="/">
        홈으로
      </Link>
    </main>
  );
}
function RouteScroll() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const target = hash && document.getElementById(hash.slice(1));
      if (target) target.scrollIntoView();
      else window.scrollTo(0, 0);
    });
    return () => cancelAnimationFrame(frame);
  }, [pathname, hash]);
  return null;
}
export default function App() {
  return (
    <SessionProvider>
      <PostsProvider>
        <Header />
        <RouteScroll />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/guide" element={<GuidePage />} />
          <Route path="/examples" element={<Library />} />
          <Route path="/examples/:id" element={<LessonPage />} />
          <Route path="/login" element={<Auth />} />
          <Route path="/examples/all" element={<Catalog key="example" kind="example" />} />
          <Route path="/projects" element={<Catalog key="project" kind="project" />} />
          <Route path="/data" element={<DataPage />} />
          <Route
            path="/devices"
            element={
              <Protected>
                <DevicesPage />
              </Protected>
            }
          />
          <Route path="/faq" element={<FaqPage />} />
          <Route
            path="/account"
            element={
              <Protected>
                <AccountPage />
              </Protected>
            }
          />
          <Route
            path="/points"
            element={
              <Protected>
                <PointsPage />
              </Protected>
            }
          />
          <Route
            path="/usim"
            element={
              <Protected>
                <UsimPage />
              </Protected>
            }
          />
          <Route
            path="/admin"
            element={
              <Protected>
                <AdminPage />
              </Protected>
            }
          />
          <Route path="/about" element={<About />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
        <Footer />
      </PostsProvider>
    </SessionProvider>
  );
}
