import {makeOrder,moneyValue} from './freightWorkflow.js';
export const freightHeaders=['화주주문번호','화주','지점','상차지','하차지','상차일시','하차일시','화물명','수량','단위','중량kg','차량형태','필요적재kg','청구운임','지급운임','메모'];

function parseRows(text){
  if(text.length>1024*1024)throw Error('CSV는 1MB 이하로 등록해 주세요.');
  const source=text.replace(/^\uFEFF/,'');
  const rows=[];let row=[],field='',quoted=false,closed=false;
  const endField=()=>{row.push(field.trim());field='';closed=false;};
  const endRow=()=>{endField();if(row.some(Boolean))rows.push(row);row=[];};
  for(let index=0;index<source.length;index++){
    const ch=source[index];
    if(quoted){
      if(ch!=='"'){field+=ch;continue;}
      if(source[index+1]==='"'){field+='"';index++;continue;}
      quoted=false;closed=true;continue;
    }
    if(ch===','){endField();continue;}
    if(ch==='\r'||ch==='\n'){if(ch==='\r'&&source[index+1]==='\n')index++;endRow();continue;}
    if(ch==='"'&&!field&&!closed){quoted=true;continue;}
    if(ch==='"'||closed&&ch.trim())throw Error('CSV 따옴표 형식을 확인해 주세요.');
    field+=ch;
  }
  if(quoted)throw Error('닫히지 않은 CSV 따옴표가 있습니다.');
  endRow();return rows;
}
export function importOrders(data,text){
  const [header,...rows]=parseRows(text);
  if(!header||header.length!==freightHeaders.length||freightHeaders.some((v,i)=>v!==header[i]))throw Error('등록 서식의 머리글을 확인해 주세요.');
  if(!rows.length||rows.length>100)throw Error('한 번에 1~100건의 주문을 등록할 수 있습니다.');
  const match=(kind,label)=>{
    const matches=data[kind].filter(r=>r.name===label&&r.active!==false);
    if(matches.length!==1)throw Error('등록된 이름을 정확하게 확인해 주세요. ('+label+')');
    return matches[0].id;
  };
  rows.forEach((cells,i)=>{
    try{
      if(cells.length!==header.length)throw Error('항목 수가 등록 서식과 다릅니다.');
      const [externalRef,shipper,branch,from,to,start,end,cargoName,quantity,unit,weightKg,vehicleType,capacityKg,sell,buy,note]=cells;
      if(!externalRef||externalRef.length>80)throw Error('화주 주문번호는 1~80자로 입력해 주세요.');
      makeOrder(data,{externalRef,shipperId:match('shippers',shipper),branchId:match('branches',branch),pickupLocationId:match('locations',from),dropoffLocationId:match('locations',to),
        start:start.replace(' ','T'),end:end.replace(' ','T'),cargoName,quantity:Number(quantity),unit,weightKg:Number(weightKg),vehicleType,capacityKg:Number(capacityKg),
        sellAmount:moneyValue(sell),buyAmount:moneyValue(buy),note,temperature:'상온',tripType:'편도',mixedAllowed:false,userId:''});
    }catch(e){throw Error((i+2)+'행 · '+e.message);}
  });
}
