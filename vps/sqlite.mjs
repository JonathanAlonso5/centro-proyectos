export function sqliteBinding(sql) {
 sql.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
 function prepare(query,args=[]) {return {query,args,bind(...p){return prepare(query,p)},async first(column){const row=sql.prepare(query).get(...args)??null;return column?(row?.[column]??null):row},async all(){return {success:true,results:sql.prepare(query).all(...args),meta:{}}},async run(){const r=sql.prepare(query).run(...args);return {success:true,results:[],meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}}}}
 return {sql,prepare,async batch(statements){sql.exec('BEGIN IMMEDIATE');try {const result=[];for(const s of statements){const r=sql.prepare(s.query).run(...s.args);result.push({success:true,results:[],meta:{changes:Number(r.changes)}})}sql.exec('COMMIT');return result}catch(e){sql.exec('ROLLBACK');throw e}}};
}
