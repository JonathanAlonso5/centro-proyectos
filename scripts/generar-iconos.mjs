// Icono de tablero dibujado con primitivas; sin recursos externos.
import {mkdirSync,writeFileSync} from 'node:fs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
mkdirSync('icons',{recursive:true});
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try {
 for(const size of [192,512]) {
  const page=await browser.newPage();
  await page.setContent('<canvas id="icon"></canvas>');
  const png=await page.evaluate(n=>{
   const c=document.querySelector('canvas');c.width=c.height=n;const x=c.getContext('2d');x.scale(n/512,n/512);
   x.fillStyle='#101318';x.fillRect(0,0,512,512);
   const colors=['#68b9a4','#d9ae68','#91a8d3'];
   for(let col=0;col<3;col++)for(let row=0;row<3-col;row++){
    x.fillStyle=colors[col];x.beginPath();x.roundRect(92+col*116,108+row*100,96,80,12);x.fill();
   }
   return c.toDataURL('image/png').split(',')[1];
  },size);
  writeFileSync(`icons/icon-${size}.png`,Buffer.from(png,'base64'));await page.close();
 }
} finally {await browser.close()}
