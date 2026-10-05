export class RequestGate {
 active=0; waiting=null; idle=null;
 async run(fn){while(this.waiting)await this.waiting;this.active++;try{return await fn()}finally{if(--this.active===0)this.idle?.()}}
 async exclusive(fn){if(this.waiting)throw Error('Ya hay una migración en curso');let release;this.waiting=new Promise(r=>release=r);try {if(this.active)await new Promise(r=>this.idle=r);return await fn()}finally {this.idle=null;this.waiting=null;release()}}
}
