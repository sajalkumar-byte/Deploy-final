/* export.js – file export service (PDF / Excel / Print) for the Task and Project Tracker
   Part of the MVP split. The Presenter decides WHAT to export (title, filters, sections);
   this module only knows HOW to turn sections into a PDF, an .xlsx workbook or a print job.
   A "section" is {title, columns:[...], rows:[[...],...], color?}.
   Libraries (SheetJS, jsPDF, jsPDF-AutoTable) are loaded lazily from the CDN on first use. */

const Exporter={
 /* each entry: [local copy in vendor/, CDN fallback] */
 LIBS:{
  xlsx:[['vendor/xlsx.full.min.js','https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js']],
  pdf:[['vendor/jspdf.umd.min.js','https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'],['vendor/jspdf.plugin.autotable.min.js','https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js']]},
 _loaded:{},
 _script(src){return new Promise((ok,fail)=>{const s=document.createElement('script');s.src=src;s.onload=ok;s.onerror=()=>{s.remove();fail(new Error('Could not load '+src.split('/').pop()))};document.head.appendChild(s)})},
 load(srcs){const k=srcs[0];return this._loaded[k]||(this._loaded[k]=(async()=>{let err;for(const u of srcs){try{await this._script(u);return}catch(e){err=e}}delete this._loaded[k];throw err})())},
 async libs(kind){for(const pair of this.LIBS[kind])await this.load(pair)},
 stamp(){const d=new Date();return d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})+' '+d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})},
 slug(s){return String(s).replace(/[^\w]+/g,'-').replace(/^-|-$/g,'')},
 clean(v){return String(v==null?'':v).replace(/[\u{1F000}-\u{1FFFF}☀-➿️]/gu,'').trim()},

 /* ---------- small text file (used for config/users.js) ---------- */
 saveText(name,text,type='text/javascript'){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type}));a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1500)},

 /* ---------- Excel (.xlsx): one sheet per section ---------- */
 async excel(doc){
  await this.libs('xlsx');
  const wb=XLSX.utils.book_new(),used={};
  doc.sections.forEach(sec=>{
   const ws=XLSX.utils.aoa_to_sheet([[doc.title],[doc.subtitle||''],[],sec.columns,...sec.rows]);
   ws['!cols']=sec.columns.map((c,i)=>({wch:Math.min(60,Math.max(String(c).length,...sec.rows.map(r=>String(r[i]==null?'':r[i]).length))+2)}));
   ws['!merges']=[{s:{r:0,c:0},e:{r:0,c:Math.max(0,sec.columns.length-1)}}];
   let name=this.clean(sec.title).replace(/[\\/?*\[\]:]/g,' ').slice(0,28)||'Sheet';if(used[name])name+=' '+(++used[name]);else used[name]=1;
   XLSX.utils.book_append_sheet(wb,ws,name)});
  XLSX.writeFile(wb,doc.file+'.xlsx')},

 /* ---------- PDF: landscape A4, one table per section ---------- */
 async pdf(doc){
  await this.libs('pdf');
  const {jsPDF}=window.jspdf;const d=new jsPDF({orientation:'landscape',unit:'mm',format:'a4'});
  const W=d.internal.pageSize.getWidth();
  d.setFont('helvetica','bold');d.setFontSize(15);d.text(this.clean(doc.title),14,14);
  d.setFont('helvetica','normal');d.setFontSize(9);d.setTextColor(100);
  d.text(this.clean((doc.subtitle?doc.subtitle+'  ·  ':'')+'Generated '+this.stamp()),14,20);d.setTextColor(0);
  let y=26;
  doc.sections.forEach((sec,i)=>{
   if(i&&y>d.internal.pageSize.getHeight()-40){d.addPage();y=14}
   d.setFont('helvetica','bold');d.setFontSize(11);d.text(this.clean(sec.title)+(sec.rows.length?'  ('+sec.rows.length+')':''),14,y);
   d.autoTable({startY:y+3,head:[sec.columns.map(c=>this.clean(c))],body:sec.rows.length?sec.rows.map(r=>r.map(v=>this.clean(v))):[[{content:'No items',colSpan:sec.columns.length,styles:{textColor:120,fontStyle:'italic'}}]],
    styles:{fontSize:7.5,cellPadding:1.6,overflow:'linebreak',valign:'top'},headStyles:{fillColor:sec.color||[79,70,229],textColor:255,fontStyle:'bold'},alternateRowStyles:{fillColor:[245,246,250]},
    margin:{left:14,right:14},tableWidth:W-28,didDrawPage:h=>{d.setFontSize(8);d.setTextColor(130);d.text('Page '+d.internal.getNumberOfPages(),W-14,d.internal.pageSize.getHeight()-6,{align:'right'});d.setTextColor(0)}});
   y=d.lastAutoTable.finalY+10});
  d.save(doc.file+'.pdf')},

 /* ---------- Print: a clean document in a hidden iframe, then the browser's print dialog ---------- */
 print(doc){
  const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const html=`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(doc.title)}</title><style>
   body{font:11px/1.4 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:#111;margin:16mm 12mm}
   h1{font-size:18px;margin:0 0 2px}.sub{color:#666;font-size:11px;margin:0 0 14px}h2{font-size:13px;margin:18px 0 6px;page-break-after:avoid}
   table{width:100%;border-collapse:collapse;font-size:10px;page-break-inside:auto}tr{page-break-inside:avoid}
   th{background:#4f46e5;color:#fff;text-align:left;padding:4px 5px;font-weight:600}td{padding:4px 5px;border-bottom:1px solid #ddd;vertical-align:top}
   tr:nth-child(even) td{background:#f5f6fa}.empty{color:#888;font-style:italic}@page{size:A4 landscape;margin:10mm}
   @media print{thead{display:table-header-group}}</style></head><body>
   <h1>${esc(doc.title)}</h1><p class="sub">${esc((doc.subtitle?doc.subtitle+'  ·  ':'')+'Generated '+this.stamp())}</p>
   ${doc.sections.map(sec=>`<h2>${esc(sec.title)}${sec.rows.length?' ('+sec.rows.length+')':''}</h2>${sec.rows.length?`<table><thead><tr>${sec.columns.map(c=>`<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${sec.rows.map(r=>`<tr>${r.map(v=>`<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`:'<p class="empty">No items</p>'}`).join('')}
   </body></html>`;
  document.querySelectorAll('iframe.print-frame').forEach(f=>f.remove());
  const f=document.createElement('iframe');f.className='print-frame';f.style.cssText='position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(f);const w=f.contentWindow;w.document.open();w.document.write(html);w.document.close();
  const go=()=>{try{w.focus();w.print()}catch(e){}setTimeout(()=>f.remove(),60000)};
  if(w.document.readyState==='complete')setTimeout(go,150);else w.onload=()=>setTimeout(go,150)}
};
