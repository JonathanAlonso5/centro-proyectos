// D1 simulado para probar el servidor HTTP sin tocar Cloudflare.
import {DatabaseSync} from 'node:sqlite';
const source=new DatabaseSync(process.env.CDP_TEST_SOURCE);source.exec('PRAGMA foreign_keys=ON;');const original=global.fetch;
global.fetch=async(url,options)=>{
 if(!String(url).startsWith('https://api.cloudflare.com/client/v4/accounts/fixture/'))return original(url,options);
 const body=JSON.parse(options.body),statements=body.batch??[body];source.exec('BEGIN IMMEDIATE');
 try{const result=statements.map(({sql,params=[]})=>{const s=source.prepare(sql);if(s.columns().length)return {success:true,results:s.all(...params),meta:{}};const r=s.run(...params);return {success:true,results:[],meta:{changes:Number(r.changes)}}});source.exec('COMMIT');return Response.json({success:true,result})}
 catch(e){source.exec('ROLLBACK');return Response.json({success:false,errors:[{message:e.message}]},{status:400})}
};
