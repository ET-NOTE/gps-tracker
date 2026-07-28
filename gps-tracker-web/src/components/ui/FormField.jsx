// (2026-07-28) Phase F1 primitive — FormField + Input/Select/Textarea.
//
// 감사 결과: `function Labeled` 가 RentcarPanel, CorporatePanel 각각 자체 정의.
// Input 도 인라인 style 로 각 파일마다 반복 (padding/border/font).
//
// 사용:
//   <FormField label="이름 *"><Input value={v} onChange={..} /></FormField>
//   <FormField label="종료" hint="시작보다 늦어야 함" error={err}>
//     <Input type="datetime-local" ... />
//   </FormField>
//   <FormField.Row cols="repeat(auto-fit, minmax(140px, 1fr))">
//     <FormField label="A"><Input .../></FormField>
//     <FormField label="B"><Input .../></FormField>
//   </FormField.Row>

const INPUT_STYLE = {
  display: 'block',
  width: '100%',
  padding: 'var(--space-2) var(--space-3)',
  background: 'var(--surface)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  fontSize: 13,
  boxSizing: 'border-box',
  outline: 'none',
  font: 'inherit',
};

export default function FormField({ label, hint, error, children, style }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, ...style }}>
      {label && (
        <div style={{
          fontSize: 11, fontWeight: 600, color: 'var(--text-2)',
        }}>{label}</div>
      )}
      {children}
      {error ? (
        <div style={{ fontSize: 11, color: 'var(--danger)', fontWeight: 600 }}>{error}</div>
      ) : hint ? (
        <div style={{ fontSize: 10, color: 'var(--text-3)' }}>{hint}</div>
      ) : null}
    </div>
  );
}

FormField.Row = function Row({ cols = 'repeat(auto-fit, minmax(140px, 1fr))', gap = 'var(--space-2)', children, style }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: cols, gap, ...style }}>{children}</div>
  );
};

export function Input({ style, ...rest }) {
  return <input {...rest} style={{ ...INPUT_STYLE, ...style }} />;
}

export function Select({ style, children, ...rest }) {
  return <select {...rest} style={{ ...INPUT_STYLE, ...style }}>{children}</select>;
}

export function Textarea({ style, ...rest }) {
  return <textarea {...rest} style={{
    ...INPUT_STYLE, minHeight: 60, resize: 'vertical', fontFamily: 'inherit',
    ...style,
  }} />;
}
