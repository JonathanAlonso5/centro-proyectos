// Solo se usa durante la preparación. Tras migrar, el servidor usa SQLite.
export function remoteBinding({account,token,database}) {
 const url=`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`;
 async function query(body){const r=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});const b=await r.json();if(!r.ok||!b.success||b.result?.some(r=>!r.success))throw Error(`D1 remoto no disponible (${r.status})`);return b.result}
 function prepare(sql,params=[]){return {sql,params,bind(...p){return prepare(sql,p)},async first(column){const row=(await query({sql,params}))[0].results[0]??null;return column?(row?.[column]??null):row},async all(){return (await query({sql,params}))[0]},async run(){return (await query({sql,params}))[0]}}}
 return {prepare,query,async batch(statements){return query({batch:statements.map(({sql,params})=>({sql,params}))})}};
}
