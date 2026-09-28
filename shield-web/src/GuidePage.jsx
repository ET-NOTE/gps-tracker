import React, { useContext } from "react";
import { Link } from "react-router-dom";
import { Session } from "./session";
import { Intro, Icon } from "./components";
import { PostStatus, usePosts } from "./posts";

const stages = [
  { id: "register", title: "장치 등록", icon: "chip" },
  { id: "practice", title: "예제로 실습", icon: "book" },
  { id: "check-data", title: "내 데이터 확인", icon: "data" },
  { id: "recharge", title: "USIM 충전", icon: "sim" },
];
const lessons = [
  {
    id: "start",
    title: "쉴드 연결",
    icon: "chip",
    check: "보드·USIM·안테나를 연결하고 시리얼 로그를 확인해요.",
  },
  {
    id: "dht11",
    title: "DHT 온습도 측정",
    icon: "temp",
    check: "온도와 습도가 시리얼 모니터에 표시되는지 확인해요.",
  },
  {
    id: "upload",
    title: "서버로 데이터 보내기",
    icon: "signal",
    check: "장치 ID와 단말 키로 전송하고 서버의 응답을 확인해요.",
  },
];

function Stage({ index, children, check }) {
  const stage = stages[index];
  return (
    <section
      className="panel journey-stage"
      id={stage.id}
      aria-labelledby={stage.id + "-title"}
    >
      <header className="journey-heading">
        <span className="journey-number" aria-hidden="true">
          {String(index + 1).padStart(2, "0")}
        </span>
        <h2 id={stage.id + "-title"}>{stage.title}</h2>
        <Icon name={stage.icon} size={24} />
      </header>
      {children}
      <p className="journey-check">
        <Icon name="check" size={18} />
        <span>
          <strong>다음으로 넘어가기 전</strong>
          {check}
        </span>
      </p>
    </section>
  );
}

export default function GuidePage() {
  const { user } = useContext(Session);
  const { posts } = usePosts();
  return (
    <main className="container journey">
      <Intro
        title="첫 쉴드, 이 순서로 시작하세요"
        description="장치 등록부터 첫 측정, 데이터 확인과 USIM 충전까지 한 단계씩 따라가세요."
        crumb="시작 가이드"
      />
      <nav className="journey-index" aria-label="시작 가이드 단계">
        {stages.map((stage, i) => (
          <a key={stage.id} href={"#" + stage.id}>
            <span>{String(i + 1).padStart(2, "0")}</span>
            <strong>{stage.title}</strong>
            <Icon name="arrow" size={16} />
          </a>
        ))}
      </nav>
      <aside className="journey-ready">
        <Icon name="chip" size={30} />
        <div>
          <h2>시작 전에 준비해 주세요</h2>
          <p>
            Arduino Uno, LTE GPS Shield, USB 케이블, USIM과 LTE·GNSS 안테나를
            준비하세요. 온습도 실습에는 DHT11 센서와 점퍼선이 필요합니다.
          </p>
          <p>
            가입용 <strong>초대코드</strong>와 제품의{" "}
            <strong>장치 등록 코드</strong>도 확인해 주세요. 두 코드는 서로
            다릅니다.
          </p>
        </div>
      </aside>
      <Stage
        index={0}
        check="내 데이터의 장치 목록에 등록한 쉴드 이름이 보이면 준비 완료입니다. 아직 전송 전이라면 ‘수신 대기’가 정상입니다."
      >
        <ol className="journey-list">
          <li>
            <strong>Shield 계정을 만드세요.</strong>
            <p>
              전달받은 초대코드로 가입합니다. 이미 가입했다면 로그인하세요. GPS
              서비스 계정과는 별도로 관리됩니다.
            </p>
          </li>
          <li>
            <strong>내 데이터에서 ‘디바이스 등록’을 누르세요.</strong>
            <p>
              알아보기 쉬운 장치 이름과 제품의 일회용 장치 등록 코드를
              입력합니다. 이미 등록된 장치는 다시 등록하지 않아도 됩니다.
            </p>
          </li>
          <li>
            <strong>전송에 사용할 장치 정보를 준비하세요.</strong>
            <p>
              제공받은 장치 ID와 단말 키를 확인하세요. 단말 키는 장치의 전송
              인증에 사용하며, 등록 코드나 로그인 비밀번호와 다릅니다.
            </p>
          </li>
        </ol>
        <div className="journey-actions">
          {!user && (
            <Link className="button" to="/login?mode=register&next=%2Fdata">
              초대코드로 가입하기 <Icon name="arrow" size={16} />
            </Link>
          )}
          <Link
            className={user ? "button" : "outline"}
            to={user ? "/data" : "/login?next=%2Fdata"}
          >
            {user ? "내 데이터에서 장치 등록" : "로그인하고 장치 등록"}
            <Icon name="arrow" size={16} />
          </Link>
        </div>
      </Stage>
      <Stage
        index={1}
        check="센서 측정과 서버 전송을 각각 확인하세요. 시리얼 모니터에 값이 보이는 것만으로는 웹에 저장되지 않습니다."
      >
        <p>
          예제 라이브러리를 아래 순서로 따라 해보세요. 각 예제의 끝에서 다음
          단계로 바로 이동할 수 있습니다.
        </p>
        <PostStatus />
        <div className="journey-lessons">
          {lessons.map((lesson, i) => {
            const post = posts.find((p) => p.id === lesson.id);
            return (
              <article className="journey-lesson" key={lesson.id}>
                <span className="mini-label">실습 {i + 1}</span>
                <Icon name={lesson.icon} size={30} />
                <h3>{lesson.title}</h3>
                <p>{lesson.check}</p>
                {post ? (
                  <>
                    <small>
                      {post.level} · 약 {post.minutes}분
                    </small>
                    <Link className="outline" to={"/examples/" + post.id}>
                      {lesson.title} 예제 <Icon name="arrow" size={16} />
                    </Link>
                  </>
                ) : (
                  <span className="muted">공개 예제를 준비 중입니다.</span>
                )}
              </article>
            );
          })}
        </div>
        <div className="journey-tip">
          <h3>실제 측정값과 연습용 데이터는 구분해 주세요</h3>
          <p>
            DHT 예제는 먼저 센서 값을 시리얼 모니터에서 확인하는 단계입니다.
            실제 온습도를 웹에서 보려면 센서 측정값을 전송 펌웨어에 포함해야
            합니다. 서버 전송 예제의 Python 스크립트는 합성 데이터를 보내므로
            별도로 등록한 시험 장치에서 사용하세요.
          </p>
        </div>
        <Link to="/examples">전체 예제 라이브러리 보기 →</Link>
      </Stage>
      <Stage
        index={2}
        check="선택한 장치의 마지막 수신 시각이 갱신되고, 보내는 센서 종류에 맞는 값이 표시되는지 확인하세요."
      >
        <ol className="journey-list">
          <li>
            <strong>내 데이터에서 쉴드를 선택하세요.</strong>
            <p>
              마지막 수신 시각과 LTE 상태로 연결을 확인합니다. 다른 장치를
              등록해 두었다면 선택한 이름이 맞는지도 확인하세요.
            </p>
          </li>
          <li>
            <strong>카드·그래프·표에서 값을 확인하세요.</strong>
            <p>
              온습도뿐 아니라 조도·압력 등 수신한 센서에 맞춰 화면이 구성됩니다.
              센서를 바꾼 뒤에는 ‘이전 센서 구성도 보기’로 교체 전 기록을 볼 수
              있습니다.
            </p>
          </li>
          <li>
            <strong>기간을 선택하고 필요한 기록을 내려받으세요.</strong>
            <p>
              최근 1시간·24시간·7일을 조회하고 CSV로 저장할 수 있습니다. GPS
              위치는 유효한 좌표를 받은 뒤 지도에 나타납니다.
            </p>
          </li>
        </ol>
        <div className="journey-actions">
          <Link className="button" to="/data">
            내 데이터 확인하기 <Icon name="arrow" size={16} />
          </Link>
          <Link className="outline" to="/examples/dynamic-sensors">
            다른 센서 연결하기
          </Link>
        </div>
        <details className="journey-help">
          <summary>값이 보이지 않나요?</summary>
          <ul>
            <li>장치 선택, 전송 주소, 장치 ID와 단말 키를 확인하세요.</li>
            <li>
              온습도 카드가 없다면 센서 값을 실제로 전송하고 있는지 확인하세요.
              GPS·PV만 보내는 장치에는 온습도가 표시되지 않습니다.
            </li>
            <li>
              수신 시각은 갱신되지만 지도에 위치가 없다면, GNSS 안테나를 하늘이
              보이는 곳에 두고 위치 확보를 기다리세요.
            </li>
          </ul>
          <Link to="/examples/status">연결 상태 확인 예제 →</Link>
        </details>
      </Stage>
      <Stage
        index={3}
        check="충전 요청 내역의 처리 상태와 통신사 잔량을 확인하세요. 요청 접수만으로 데이터가 즉시 충전되지는 않습니다."
      >
        <ol className="journey-list">
          <li>
            <strong>내 USIM에서 대상 장치와 유심을 확인하세요.</strong>
            <p>
              장치 이름과 USIM 끝자리, 남은 데이터와 마지막 조회 시각을
              확인합니다. USIM이 연결되지 않았다면 제품 담당자에게 문의하세요.
            </p>
          </li>
          <li>
            <strong>충전에 필요한 포인트를 확인하세요.</strong>
            <p>
              화면에 표시된 충전 용량·필요 포인트와 내 잔액을 비교합니다.
              포인트는 Shield 전용이며 GPS 계정의 잔액과 합산되지 않습니다.
            </p>
          </li>
          <li>
            <strong>내용을 확인하고 충전을 요청하세요.</strong>
            <p>
              접수 시 포인트가 차감되고 관리자가 확인 후 통신사에 주문합니다.
              전송 전 취소·반려 또는 통신사의 확정 거절은 환불됩니다.
            </p>
          </li>
        </ol>
        <p className="notice">
          <strong>현재 포인트 충전 안내</strong>
          <br />
          온라인 카드 결제는 아직 준비 중입니다. 포인트가 부족하면 제품
          담당자에게 충전을 요청해 주세요. USIM 잔량 조회와 포인트를 이용한 충전
          요청은 사용할 수 있습니다.
        </p>
        <div className="journey-actions">
          <Link className="button" to="/usim">
            내 USIM 잔량·충전 확인 <Icon name="arrow" size={16} />
          </Link>
        </div>
      </Stage>
    </main>
  );
}

export function LessonNavigation({ id }) {
  const { posts } = usePosts();
  const index = lessons.findIndex((lesson) => lesson.id === id);
  if (index < 0) return null;
  const next = lessons[index + 1];
  const available = next && posts.some((post) => post.id === next.id);
  return (
    <nav className="lesson-navigation" aria-label="실습 이어가기">
      <Link to="/guide#practice">← 전체 시작 과정</Link>
      <Link
        className="button"
        to={
          next
            ? available
              ? "/examples/" + next.id
              : "/guide#practice"
            : "/data"
        }
      >
        {next
          ? available
            ? "다음: " + next.title
            : "다음 실습 안내"
          : "다음: 내 데이터 확인"}
        <Icon name="arrow" size={16} />
      </Link>
    </nav>
  );
}
