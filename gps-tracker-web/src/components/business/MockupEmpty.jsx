import Icon from '../Icon';

// Desktop design empty state: search icon, title and description, centred; `panel` adds the white card.
export const EMPTY_RENTAL = '조회 조건을 변경하거나 새 항목을 등록해 주세요.';
export const EMPTY_FREIGHT = '조회 조건을 바꾸거나 새 항목을 등록해 주세요.';
export const EMPTY_CORPORATE = '기간이나 검색 조건을 변경해 보세요.';

export default function MockupEmpty({ title, description, panel = false }) {
  return <div className={'mockup-empty' + (panel ? ' is-panel' : '')} role="status">
    <Icon name="search" size={31}/><strong>{title}</strong>{description && <small>{description}</small>}
  </div>;
}
