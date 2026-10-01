export function simState(sim, now = Date.now()) {
  if (!sim?.linked) return { label: "미연결", warning: false };
  const usage = sim.usage;
  if (!usage) return { label: "조회 대기", warning: false };
  if (
    usage.expires_at &&
    Number.isFinite(Date.parse(usage.expires_at)) &&
    Date.parse(usage.expires_at) <= now
  )
    return { label: "사용 기한 확인 필요", warning: true };
  if (Number.isFinite(usage.remaining_mb) && usage.remaining_mb <= 0)
    return { label: "USIM을 충전해 주세요", warning: true };
  if (usage.status === "Disabled")
    return { label: "비활성 · 상태 확인 필요", warning: true };
  if (usage.status === "Enabled") return { label: "사용 중", warning: false };
  return { label: "상태 확인 필요", warning: false };
}
