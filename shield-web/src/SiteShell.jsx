import React, { useContext, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { Session } from "./session";
import { Brand, Icon, number } from "./components";
import { useCommerce } from "./Commerce";
export function Header() {
  const { points } = useCommerce();
  const { user } = useContext(Session);
  const [open, setOpen] = useState(false);
  return (
    <header className="site-header portal-header">
      <div className="header-inner">
        <Brand />
        <button
          className="menu-toggle outline"
          aria-expanded={open}
          aria-controls="portal-nav"
          onClick={() => setOpen(!open)}
        >
          메뉴 {open ? "닫기" : "열기"}
        </button>
        <nav
          id="portal-nav"
          className={open ? "open" : ""}
          aria-label="주 메뉴"
          onClick={() => setOpen(false)}
        >
          {[
            ["/guide", "시작가이드"],
            ["/examples", "예제라이브러리"],
            ["/projects", "응용프로젝트"],
            ["/data", "내 데이터"],
            ["/devices", "내장치"],
            ["/pricing", "요금 안내"],
            ["/faq", "FAQ"],
          ].map(([to, label]) => (
            <NavLink key={to} to={to}>
              {label}
            </NavLink>
          ))}
          {user?.role === "admin" && <NavLink to="/admin">관리</NavLink>}
        </nav>
        <div className="account">
          {user ? (
            <>
              <Link className="point-balance" to="/points">
                <span>P</span>
                {number(user.credit_balance, 0)} P
              </Link>
              <button className="outline compact" onClick={points}>
                포인트충전
              </button>
              <Link
                className="account-link"
                to="/account"
                aria-label="마이페이지"
              >
                <Icon name="user" size={18} />
                <span>마이페이지</span>
              </Link>
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
export function Footer() {
  return (
    <footer className="site-footer portal-footer">
      <Brand />
      <nav aria-label="하단 메뉴">
        <Link to="/about">서비스 안내</Link>
        <Link to="/pricing">이용 요금 안내</Link>
        <Link to="/faq">FAQ</Link>
        <Link to="/account">마이페이지</Link>
      </nav>
      <small>LTE GPS Shield</small>
    </footer>
  );
}
