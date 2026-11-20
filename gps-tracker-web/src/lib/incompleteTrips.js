export const tripNeedsDetails = t => !t.annotation?.purpose || t.annotation.purpose==='unspecified'
  || (t.annotation?.driver_staff_id==null && !t.annotation?.driver_name?.trim());

// Explicitly requested overview inspection; at most two full trip reads at once.
// Failures are rows, never zero counts. A closed panel stops taking queued work.
export async function inspectIncompleteTrips(devices,load,receive,cancelled=()=>false){
 let next=0;
 async function worker(){while(!cancelled()&&next<devices.length){const device=devices[next++];let result;
  try{const trips=await load(device);result={id:device.id,total:trips.length,missing:trips.filter(tripNeedsDetails).length};}
  catch{result={id:device.id,error:true};}
  if(!cancelled())receive(result);
 }}
 await Promise.all(Array.from({length:Math.min(2,devices.length)},worker));
}
