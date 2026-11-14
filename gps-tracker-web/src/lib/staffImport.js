export const staffCsvHeaders = ['이름','연락처','부서','직책','담당 업무'];
export const staffCsvTemplate = '\uFEFF'+staffCsvHeaders.join(',')+'\r\n';

// RFC-style quoted fields; never evaluate spreadsheet formulas or infer types.
export function parseStaffCsv(source) {
  if (new TextEncoder().encode(source).length > 1024*1024) throw Error('1MB 이하의 CSV 파일을 선택하세요.');
  const text=source.replace(/^\uFEFF/,'');
  const records=[];let row=[],cell='',quoted=false,closed=false;
  const pushCell=()=>{row.push(cell.trim());cell='';closed=false;};
  const pushRow=()=>{pushCell();if(row.some(Boolean))records.push(row);row=[];};
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=c;continue;}
    if(c==='"'){if(cell||closed)throw Error('따옴표 형식을 확인하세요. CSV UTF-8로 다시 저장해 주세요.');quoted=true;}
    else if(c===',')pushCell();
    else if(c==='\r'||c==='\n'){if(c==='\r'&&text[i+1]==='\n')i++;pushRow();}
    else if(closed)throw Error('닫는 따옴표 뒤에는 쉼표 또는 줄바꿈이 필요합니다.');
    else cell+=c;
  }
  if(quoted)throw Error('닫히지 않은 따옴표가 있습니다.');
  if(cell||row.length||closed)pushRow();
  const header=records.shift();
  if(!header||header.length!==5||staffCsvHeaders.some((v,i)=>v!==header[i]))throw Error('양식의 열 순서를 유지하세요: '+staffCsvHeaders.join(', '));
  if(!records.length||records.length>500)throw Error('한 번에 1~500명을 등록할 수 있습니다.');
  return records.map((r,i)=>{if(r.length!==5)throw Error(`${i+2}행: 5개 열이 필요합니다.`);return Object.fromEntries(['name','phone','department','position','role'].map((k,j)=>[k,r[j]]));});
}
