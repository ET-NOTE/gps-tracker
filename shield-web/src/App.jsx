import React, { useContext, useEffect, useState } from "react";
import {
  Link,
  NavLink,
  Route,
  Routes,
  useNavigate,
  useLocation,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { request } from "./api";
import { Session, SessionProvider } from "./session";
import DataPage from "./DataPage";
import {
  Intro,
  Brand,
  Board,
  Icon,
  Metric,
  Chart,
  MapPanel,
  number,
  date,
  relative,
} from "./components";
import { demoData } from "./demo";
import { PostsProvider, usePosts, PostStatus } from "./posts";
import AdminPage from "./AdminPage";
import UsimPage from "./UsimPage";
import GuidePage, { LessonNavigation } from "./GuidePage";

function Header() {
  const { user, logout } = useContext(Session);
  const navigate = useNavigate();
  return (
    <header className="site-header">
      <div className="header-inner">
        <Brand />
        <nav aria-label="주 메뉴">
          <NavLink to="/guide">시작 가이드</NavLink>
          <NavLink to="/examples">예제 라이브러리</NavLink>
          <NavLink to="/data">내 데이터</NavLink>
          <NavLink to="/usim">내 USIM</NavLink>
          {user?.role === "admin" && <NavLink to="/admin">관리</NavLink>}
        </nav>
        <div className="account">
          {user ? (
            <>
              <span>{user.display_name}님</span>
              <button
                className="outline compact"
                onClick={async () => {
                  try {
                    await logout();
                    navigate("/");
                  } catch {
                    alert("로그아웃에 실패했습니다. 다시 시도해 주세요.");
                  }
                }}
              >
                <Icon name="user" size={16} />
                로그아웃
              </button>
            </>
          ) : (
            <Link className="outline compact" to="/login">
              <Icon name="user" size={16} />
              로그인
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
function Footer() {
  return (
    <footer className="site-footer">
      <div>
        <Brand />
        <p>작은 연결에서 시작되는 가능성.</p>
      </div>
      <nav>
        <Link to="/guide">시작 가이드</Link>
        <Link to="/examples">예제 라이브러리</Link>
        <Link to="/about">서비스 안내</Link>
      </nav>
      <span>SIM7080G · LTE · GNSS</span>
    </footer>
  );
}
function Home() {
  const { posts: examples } = usePosts();
  const { user } = useContext(Session);
  return (
    <>
      <section className="hero">
        <div className="hero-inner">
          <div className="hero-copy">
            <p className="eyebrow">ARDUINO · LTE · GNSS</p>
            <h1>
              연결하고, 만들고,
              <br />
              데이터를 확인하세요.
            </h1>
            <p>
              쉴드 연결부터 센서 실습, 나만의 데이터까지.
              <br />첫 프로젝트를 시작하는 가장 가까운 곳.
            </p>
            <div className="actions">
              <Link className="button" to="/guide">
                <Icon name="chip" />
                시작 가이드
              </Link>
              <Link className="outline" to="/examples">
                <Icon name="book" />
                예제 둘러보기
              </Link>
            </div>
            <div className="hero-features">
              <span>
                <Icon name="signal" />
                LTE 데이터
                <br />
                연결
              </span>
              <span>
                <Icon name="pin" />
                SIM7080G
                <br />
                내장 GNSS
              </span>
              <span>
                <Icon name="chip" />
                Arduino와
                <br />
                센서 확장
              </span>
            </div>
          </div>
          <div className="hero-art">
            <div className="orb" />
            <Board />
            <span className="art-label">LTE + GNSS, 하나의 쉴드에서</span>
            <small>제품 구조를 설명하는 일러스트입니다.</small>
          </div>
        </div>
      </section>
      <main className="container home-content">
        <div className="quick-links">
          {[
            ["sim", "내 USIM", "상태와 데이터 잔량 확인", "/usim"],
            [
              "code",
              "예제 라이브러리",
              "온습도부터 GPS까지 차근차근",
              "/examples",
            ],
            ["data", "내 데이터", "센서 값을 한눈에 확인", "/data"],
          ].map(([icon, title, text, to]) => (
            <Link className="quick-card" to={to} key={to}>
              <Icon name={icon} size={31} />
              <div>
                <h2>{title}</h2>
                <p>{text}</p>
              </div>
              <Icon name="arrow" size={18} />
            </Link>
          ))}
        </div>
        <div className="section-heading">
          <h2>
            {user ? "내 디바이스 확인하기" : "내 디바이스 한눈에 보기"}{" "}
            {!user && <span className="badge demo">데모 데이터</span>}
          </h2>
          <Link to="/data">
            {user ? "내 데이터 열기" : "내 장치 연결하기"}{" "}
            <Icon name="arrow" size={16} />
          </Link>
        </div>
        {user ? (
          <section className="panel start-panel">
            <Icon name="data" size={36} />
            <div>
              <h3>{user.display_name}님의 프로젝트를 확인하세요.</h3>
              <p>
                등록한 쉴드의 센서 값과 위치를 내 데이터에서 볼 수 있습니다.
              </p>
            </div>
            <Link to="/data" className="button">
              내 데이터 열기
            </Link>
          </section>
        ) : (
          <Demo compact />
        )}
        <div className="section-heading">
          <div>
            <h2>예제로 바로 시작하기</h2>
            <p>배선부터 데이터 확인까지, 단계별로 따라 해보세요.</p>
          </div>
          <Link to="/examples">
            전체 예제 보기 <Icon name="arrow" size={16} />
          </Link>
        </div>
        <div className="example-grid home-examples">
          {examples.slice(1, 4).map((e) => (
            <ExampleCard key={e.id} example={e} />
          ))}
        </div>
      </main>
    </>
  );
}
function Demo({ compact = false }) {
  const [data] = useState(demoData);
  return (
    <div className={"demo-panel " + (compact ? "compact-demo" : "")}>
      <div className="demo-top">
        <span>
          <i className="status-dot" />
          데모 장치 <span className="muted">실제 수신 데이터가 아닙니다.</span>
        </span>
        <span>온습도 센서 01</span>
      </div>
      <div className="dashboard-grid">
        <div>
          <div className="metrics two">
            <Metric
              icon="temp"
              label="온도"
              value={number(data.latest.temp_c)}
              unit="°C"
              hint="DHT11 · 데모"
            />
            <Metric
              icon="drop"
              label="습도"
              value={number(data.latest.hum_pct, 0)}
              unit="%"
              hint="DHT11 · 데모"
            />
          </div>
          <section className="panel">
            <div className="panel-title">
              <h2>온도 변화</h2>
              <span className="muted">최근 4시간 · 데모</span>
            </div>
            <Chart points={data.chart} />
          </section>
        </div>
        <section className="panel demo-aside">
          <span className="mini-label">YOUR NEXT PROJECT</span>
          <Icon name="chip" size={52} />
          <h2>
            이제, 내 데이터로
            <br />
            채워볼까요?
          </h2>
          <p>
            초대코드로 가입하고
            <br />
            쉴드의 등록 코드를 연결하세요.
          </p>
          <Link className="button" to="/login?mode=register">
            내 쉴드 시작하기 <Icon name="arrow" size={16} />
          </Link>
          <Link to="/guide">연결 방법 알아보기</Link>
        </section>
      </div>
    </div>
  );
}
function ExampleCard({ example: e }) {
  return (
    <Link className="example-card" to={"/examples/" + e.id}>
      <div className="example-art">
        <Board variant={e.variant} small />
      </div>
      <div className="example-body">
        <span className="badge">
          {e.level} · 약 {e.minutes}분
        </span>
        <h3>{e.title}</h3>
        <p>{e.description}</p>
        <div className="tags">
          <span>{e.category}</span>
          <span>단계별 가이드</span>
        </div>
        <strong>
          예제 시작하기 <Icon name="arrow" size={14} />
        </strong>
      </div>
    </Link>
  );
}
function Examples() {
  const { posts: examples } = usePosts();
  const [search, setSearch] = useState(""),
    [category, setCategory] = useState("전체"),
    [level, setLevel] = useState("전체");
  const shown = examples.filter(
    (e) =>
      (category === "전체" || e.category === category) &&
      (level === "전체" || e.level === level) &&
      (e.title + e.description).includes(search),
  );
  return (
    <main className="container">
      <Intro
        title="예제 라이브러리"
        description="배선부터 코드 실행, 데이터 확인까지 차근차근 시작하세요."
      />
      <Link to="/guide" className="guide-banner">
        <Icon name="book" size={47} />
        <div>
          <small>처음 사용하시나요?</small>
          <h2>장치 등록부터 데이터 확인, USIM 충전까지</h2>
          <p>쉴드 연결 → 온습도 측정 → 서버 전송 순서로 실습하세요.</p>
        </div>
        <span className="button">
          시작 가이드 <Icon name="arrow" size={16} />
        </span>
      </Link>
      <label className="search">
        <Icon name="search" />
        <input
          aria-label="예제 검색"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="센서명, 기능, 예제 검색"
        />
      </label>
      <div className="filter-bar">
        <div className="tabs">
          {["전체", ...new Set(examples.map((e) => e.category))].map((c) => (
            <button
              key={c}
              aria-pressed={category === c}
              className={category === c ? "active" : ""}
              onClick={() => setCategory(c)}
            >
              {c}
            </button>
          ))}
        </div>
        <select
          aria-label="예제 난이도"
          value={level}
          onChange={(e) => setLevel(e.target.value)}
        >
          <option value="전체">난이도 전체</option>
          <option>입문</option>
          <option>기초</option>
          <option>응용</option>
        </select>
      </div>
      <PostStatus />
      <p className="muted">예제 {shown.length}개</p>
      <div className="example-grid">
        {shown.map((e) => (
          <ExampleCard key={e.id} example={e} />
        ))}
      </div>
      {!shown.length && (
        <div className="empty">
          검색 결과가 없습니다. 다른 검색어를 입력해 주세요.
        </div>
      )}
      <div className="download-banner">
        <Icon name="download" size={33} />
        <div>
          <h3>데이터 전송을 먼저 시험해 보세요</h3>
          <p>Python 합성 데이터 전송 예제 · 장치 ID와 키 필요</p>
        </div>
        <a className="outline" href="/downloads/send_sample.py" download>
          전송 예제 다운로드
        </a>
      </div>
    </main>
  );
}
function ExampleDetail() {
  const { posts: examples, loading, error } = usePosts();
  const { id } = useParams();
  const e = examples.find((e) => e.id === id);
  if (!e)
    return loading || error ? (
      <main className="container">
        <PostStatus />
      </main>
    ) : (
      <NotFound />
    );
  return (
    <main className="container article">
      <Intro
        crumb="예제 라이브러리"
        title={e.title}
        description={e.description}
      />
      <div className="article-layout">
        <article className="panel instructions">
          <span className="badge">
            {e.level} · 약 {e.minutes}분
          </span>
          <ol>
            {e.steps.map((s, i) => (
              <li key={i}>
                <span>{i + 1}</span>
                <p>{s}</p>
              </li>
            ))}
          </ol>
          {e.code && (
            <>
              <h2>예제 코드</h2>
              <pre>
                <code>{e.code}</code>
              </pre>
              <button
                className="outline"
                onClick={() => {
                  const url = URL.createObjectURL(
                    new Blob([e.code], { type: "text/plain;charset=utf-8" }),
                  );
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = e.id + "-example.txt";
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(url), 10000);
                }}
              >
                현재 예제 코드 다운로드
              </button>
            </>
          )}
          {e.id === "upload" && (
            <>
              <a className="button" href="/downloads/send_sample.py" download>
                <Icon name="download" />
                Python 전송 예제
              </a>
              <pre>
                <code>
                  {
                    '$env:SHIELD_URL = "https://shield.serial.kr"\n$env:SHIELD_DEVICE_UID = "발급된 장치 ID"\n$env:SHIELD_DEVICE_KEY = "발급된 단말 키"\npython send_sample.py'
                  }
                </code>
              </pre>
              <p className="notice">
                실제 측정값이 아닌 합성 데이터를 보냅니다. 별도로 등록한 시험
                장치의 정보로 실행하세요.
              </p>
            </>
          )}
          {["start", "dht11", "upload"].includes(e.id) ? (
            <LessonNavigation id={e.id} />
          ) : (
            <Link className="button" to="/data">
              내 데이터에서 확인하기 <Icon name="arrow" size={16} />
            </Link>
          )}
        </article>
        <aside className="article-aside">
          <Board variant={e.variant} />
          <h3>시작 전 확인</h3>
          <p>
            SIM7080G 내장 GNSS를 사용합니다. 별도 GPS 수신기를 연결하는 예제와
            혼동하지 마세요.
          </p>
          <p>
            센서 배선은 전원을 끈 상태에서 확인하고, 단말 키는 비공개로
            보관하세요.
          </p>
          <Link to="/examples">전체 예제로 돌아가기</Link>
        </aside>
      </div>
    </main>
  );
}
function Auth() {
  const { user, changed } = useContext(Session);
  const [params, setParams] = useSearchParams();
  const register = params.get("mode") === "register";
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const next = ["/data", "/usim", "/admin"].includes(params.get("next"))
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
  return user === undefined ? (
    <main className="container empty" role="status">
      로그인 상태를 확인하는 중입니다.
    </main>
  ) : !user ? (
    <main className="container">
      <Intro
        title="내 쉴드의 데이터를 만나보세요"
        description="로그인하면 내 계정에 연결된 쉴드의 센서와 위치를 확인할 수 있습니다."
      />
      <Link
        className="button"
        to={
          "/login?next=" +
          (pathname === "/usim"
            ? "/usim"
            : pathname === "/admin"
              ? "/admin"
              : "/data")
        }
      >
        로그인하고 시작하기
      </Link>
      <div className="section-heading">
        <h2>
          이렇게 확인할 수 있어요{" "}
          <span className="badge demo">데모 데이터</span>
        </h2>
      </div>
      <Demo />
    </main>
  ) : (
    <React.Fragment key={user.id}>{children}</React.Fragment>
  );
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
          <Route path="/examples" element={<Examples />} />
          <Route path="/examples/:id" element={<ExampleDetail />} />
          <Route path="/login" element={<Auth />} />
          <Route
            path="/data"
            element={
              <Protected>
                <DataPage />
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
