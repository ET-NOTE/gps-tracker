import {authScope} from '../authSession.js';
// Company scope never changes the authenticated account or SIM ownership.
let owner = null, generation = 0;
export function setFleetOwner(value) { owner = value == null ? null : Number(value); generation++; }
export function fleetRequestScope(url) {
  const path = new URL(url, 'https://local.invalid').pathname;
  const scoped = /\/(corporate|documents)\//.test(path) && !/\/corporate\/(workspaces|join)$/.test(path);
  const stamp = generation;
  return { owner: scoped ? owner : null, assert() {
    if (scoped && stamp !== generation) throw new DOMException('회사가 변경되었습니다.', 'AbortError');
  }};
}

const preferred=new Map();
export const rememberFleetOwner=value=>preferred.set(authScope(),value);
export const preferredFleetOwner=()=>preferred.get(authScope())??null;
