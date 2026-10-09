/* Read shared JSON test datasets from stdin; no browser or dependencies needed. */
const fs=require('node:fs');
const schema=require('../web/src/schema.js');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const results=input.map(({name,data})=>{
  const before=JSON.stringify(data);
  try {
    const result=schema.validateDataset(data);
    return {name,valid:true,sameObject:result===data,unchanged:JSON.stringify(data)===before};
  } catch(error) {
    return {name,valid:false,unchanged:JSON.stringify(data)===before,error:String(error.message)};
  }
});
process.stdout.write(JSON.stringify(results));
