import Icon from '../Icon';
import {Link} from 'react-router-dom';
import car from './login-vehicle.png';
import './login.css';

const services=[
  {icon:'car',title:'법인차량',detail:'차량 예약·운행기록부'},
  {icon:'calendar',title:'렌트카',detail:'대여·반납 관리'},
  {icon:'truck',title:'화물배차',detail:'운송 주문·운임 정산'}
];

function PolicyLinks() {
  return <nav aria-label="서비스 정책"><Link to="/privacy" target="_blank" rel="noreferrer">개인정보 처리방침</Link><Link to="/terms" target="_blank" rel="noreferrer">이용약관</Link><Link to="/privacy/result">개인정보 요청 결과 확인</Link></nav>;
}

export default function LoginLayout({register, children}) {
  return <div className="entry-scroll"><div className="entry-screen">
    <header className="entry-header"><div className="entry-brand"><span className="entry-brand-icon"><Icon name="car" size={19}/></span><span>시리얼링크</span></div>
      <details className="entry-policy-menu"
        onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))event.currentTarget.open=false;}}
        onKeyDown={event=>{if(event.key==='Escape'){event.currentTarget.open=false;event.currentTarget.querySelector('summary').focus();}}}>
        <summary>이용 안내</summary><PolicyLinks/>
      </details>
    </header>
    <main className="entry-main">
      <section className="entry-intro" aria-label="제공 서비스">
        <h2>차량 위치와<br/>운행 관리</h2>
        <p>내 단말기의 위치와 운행 기록을 확인하고<br/>계정에 연결된 차량 업무를 관리하세요.</p>
        <div className="entry-art" aria-hidden="true">
          <div className="entry-orbit"/><div className="entry-orbit is-outer"/>
          <div className="entry-car-photo"><img src={car} width="390" height="175" alt="" /></div>
          <div className="entry-route"><i/><i/><i/></div>
        </div>
        <ul className="entry-services">{services.map(s=><li key={s.title}><Icon name={s.icon} size={17}/><div><span>{s.title}</span><small>{s.detail}</small></div></li>)}</ul>
      </section>
      <section className="entry-panel" aria-labelledby="entry-title">
        <h1 id="entry-title">{register?'회원가입':'로그인'}</h1>
        <p className="entry-subtitle">{register?'단말기를 관리할 계정을 만들어 주세요.':'단말기의 위치와 연결된 업무를 확인하세요.'}</p>
        {children}
      </section>
    </main>
    <footer className="entry-footer"><span>© {new Date().getFullYear()} 시리얼링크</span>
      <PolicyLinks/>
    </footer>
  </div></div>;
}
