export const PHOTO_TYPES = [
  { id: 'damage', label: '외관' }, { id: 'odometer', label: '주행거리' }, { id: 'fuel', label: '연료' },
];
export const PHOTO_KINDS = Object.fromEntries(['pickup', 'return'].flatMap(phase => PHOTO_TYPES.map(type => [`${phase}_${type.id}`, `${phase === 'pickup' ? '인수' : '반납'} ${type.label}`])));
export const PHOTO_INPUT_LIMIT = 10 * 1024 * 1024;
export const PHOTO_UPLOAD_LIMIT = 4 * 1024 * 1024;
export const photoTimestamp = photo => photo.uploaded_at || photo.created_at || null;
export function photoGroups(photos, filter = 'all') {
  const sorted = [...photos].sort((a, b) => (Date.parse(photoTimestamp(a)) || 0) - (Date.parse(photoTimestamp(b)) || 0) || Number(a.id) - Number(b.id));
  const groups = PHOTO_TYPES.filter(type => filter === 'all' || filter === type.id).map(type => ({ ...type,
    pickup: sorted.filter(p => p.kind === `pickup_${type.id}`), returned: sorted.filter(p => p.kind === `return_${type.id}`),
  })).filter(group => group.pickup.length || group.returned.length);
  const other = filter === 'all' ? sorted.filter(p => !Object.hasOwn(PHOTO_KINDS, p.kind)) : [];
  return { groups, other };
}
export function photoFileError(file) {
  if (!file || !file.size) return '내용이 없는 파일입니다. 다른 사진을 선택해 주세요.';
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return 'JPG, PNG, WebP 사진을 선택해 주세요.';
  if (file.size > PHOTO_INPUT_LIMIT) return '사진은 한 장당 10MB 이하로 선택해 주세요.';
  return '';
}
export async function prepareRentalPhoto(file) {
  const error = photoFileError(file);
  if (error) throw new Error(error);
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('사진을 열지 못했습니다. 다른 사진을 선택해 주세요.')); image.src = url; });
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40_000_000) throw new Error('사진 해상도가 너무 큽니다. 4,000만 화소 이하 사진을 선택해 주세요.');
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('이 기기에서 사진을 준비할 수 없습니다. 다른 브라우저로 다시 시도해 주세요.');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    if (!dataUrl.startsWith('data:image/jpeg;base64,') || (dataUrl.split(',')[1]?.length || 0) * 3 / 4 > PHOTO_UPLOAD_LIMIT) throw new Error('저장할 사진이 너무 큽니다. 더 작은 사진을 선택해 주세요.');
    return { dataUrl, name: file.name, width: canvas.width, height: canvas.height };
  } finally { URL.revokeObjectURL(url); }
}
