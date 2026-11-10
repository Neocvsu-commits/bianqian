/* Each window submits operations to the shared desktop store. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id), bridge = window.desktop, Text = window.PaperText;
  const COLORS = { butter:'#f2df99', sage:'#ceddc9', blue:'#cbdde7', rose:'#e9ccc5', cream:'#eae5d7' };
  const LIGHTS = { butter:'#faebba', sage:'#e0ebd8', blue:'#dfedf3', rose:'#f3ded7', cream:'#f6f1e5' };
  const stage = document.querySelector('.paper-stage'), edges = [$('tear-left'), $('tear-handle')];
  const sound = new window.PaperAudio(), storageKey = 'siye-demo-v1';
  const FORMAT_TOOLS={strike:'strikes',underline:'underlines',highlight:'highlights',bold:'bolds'};
  const FORMAT_FIELDS=Object.values(FORMAT_TOOLS);
  const newNote = (color='butter') => ({id:crypto.randomUUID(),color,title:'',body:'',strikes:[],underlines:[],highlights:[],bolds:[],createdAt:new Date().toISOString()});
  function fillPreviewQueue(data,previous=data.active?.color){
    if(!data.settings.randomColors){data.paperQueue=[];return;}
    const used=new Set(previous?[previous]:[]),queue=[];
    for(const color of data.paperQueue||[]){if(COLORS[color]&&!used.has(color)&&queue.length<3){queue.push(color);used.add(color);}}
    while(queue.length<3){const choices=Object.keys(COLORS).filter(color=>!used.has(color)),color=choices[Math.floor(Math.random()*choices.length)];queue.push(color);used.add(color);}
    data.paperQueue=queue;
  }
  const date = (value,options={year:'numeric',month:'2-digit',day:'2-digit'}) => new Intl.DateTimeFormat('zh-CN',options).format(new Date(value));
  let state, motion, noteId=null, currentId=null, surfaceColor=null;
  let draft=null, draftSerial=0, queuedSerial=-1, pendingSave=Promise.resolve(true);
  let saveTimer, toastTimer, busy=false, loadBlocked=false;
  let view='archive', selectedId=null, selectedView='archive', lastUndo=null;
  let gesture=null, zoneAction=null, peelAction=null, dropPosition=null;
  let finishing=false, autoPeel=false;
  let nativeLayout=null, noteDrag=null, archiveDrag=null;
  const current = () => noteId ? state?.desktop.find(n=>n.id===noteId) : state?.active;
  const findNote = id => [state.active,...state.desktop,...state.archive].find(n=>n?.id===id) || state.trash.find(r=>r.note.id===id)?.note;
  const hasContent = n => Boolean(n && (n.title.trim() || n.body.trim()));

  function status(message,error=false) {
    $('save-status').replaceChildren(document.createElement('i'),document.createTextNode(message));
    $('save-status').classList.toggle('error',error);
  }
  function toast(message,undo=false) {
    $('toast').textContent=message;
    if(undo && lastUndo) { const b=document.createElement('button'); b.textContent='撤销'; b.addEventListener('click',undoLast); $('toast').append(b); }
    $('toast').hidden=false; clearTimeout(toastTimer);
    toastTimer=setTimeout(()=>{$('toast').hidden=true;updateHitRegions();},undo?6500:3500); updateHitRegions();
  }
  function updateHitRegions() {
    if(!bridge) return;
    const dialog=document.querySelector('dialog[open]');
    const targets=dialog?[dialog]:[stage,$('empty-active'),...edges,document.querySelector('.note-actions'),document.querySelector('.titlebar'),document.querySelector('.paper-tools'),$('undo'),document.querySelector('.statusbar')];
    if(!$('toast').hidden) targets.push($('toast'));
    bridge.setHitRegions(targets.map(el=>el.getBoundingClientRect()).filter(r=>r.width&&r.height).map(r=>({x:r.x-3,y:r.y-3,width:r.width+6,height:r.height+6})));
  }
  function appearance() {
    const n=current()||{color:'butter',title:'',body:'',createdAt:new Date().toISOString()}, rows=Text.wrap(n.body,n.strikes||[],294,undefined,n), scroll=$('note-body').scrollTop;
    return {color:COLORS[n.color],title:n.title,lines:rows.slice(Math.floor(scroll/36),Math.floor(scroll/36)+7),scrollOffset:scroll%36,wordCount:Array.from(n.body.replace(/\s/g,'')).length,date:date(n.createdAt),number:noteId?'•':String(state.archive.length+1).padStart(2,'0')};
  }
  function renderInk() {
    const n=current(); if(!n) return;
    Text.render($('note-ink'),n.body,n.strikes||[],n);$('note-ink').classList.toggle('has-trailing-line',/[\r\n]$/.test(n.body));$('note-ink').scrollTop=$('note-body').scrollTop;
    renderTodoHits();updateFormatButtons();
    $('word-count').textContent=`${Array.from(n.body.replace(/\s/g,'')).length} 字`;
  }
  function renderTodoHits(){
    const n=current(),container=$('todo-hits');container.replaceChildren();if(!n)return;
    const bounds=container.getBoundingClientRect();
    for(const marker of $('note-ink').querySelectorAll('.todo-marker')){
      const rect=marker.getBoundingClientRect(),y=rect.top+rect.height/2-bounds.top-12;
      if(y+24<=0||y>=214)continue;
      const offset=Number(marker.dataset.offset),done=marker.classList.contains('is-done'),line=Text.currentLineRange(n.body,offset);
      const button=document.createElement('button');button.className='todo-hit';button.type='button';button.dataset.offset=String(offset);
      button.style.top=`${y}px`;button.style.left=`${rect.left+rect.width/2-bounds.left-10}px`;button.setAttribute('role','checkbox');button.setAttribute('aria-checked',String(done));
      button.setAttribute('aria-label',`${done?'标为未完成':'标为完成'}：${n.body.slice(offset+2,line.end).trim()||'待办事项'}`);button.title=done?'标为未完成':'标为完成';button.disabled=busy;
      container.append(button);
    }
  }
  function updateFormatButtons(){
    const n=current(),input=$('note-body');if(!n)return;
    let start=input.selectionStart,end=input.selectionEnd;
    if(start===end)({start,end}=Text.currentLineRange(n.body,start));
    for(const [id,field] of Object.entries(FORMAT_TOOLS))$(id).setAttribute('aria-pressed',String(start<end&&Text.normalizeRanges(n[field]||[],n.body).some(range=>range.start<=start&&range.end>=end)));
    const line=Text.currentLineRange(n.body,input.selectionStart);$('todo').setAttribute('aria-pressed',String(/^[○●] /.test(n.body.slice(line.start,line.end))));
  }
  function renderCurrent() {
    const n=current();
    document.body.classList.toggle('no-active',!n);
    $('empty-active').hidden=Boolean(n);
    for(const id of ['note-title','note-body',...Object.keys(FORMAT_TOOLS),'todo','archive-current','delete-current','new-note'])$(id).disabled=busy||!n;
    $('random-color').disabled=busy||!n;
    document.querySelectorAll('[data-color]').forEach(el=>{el.disabled=busy||!n;});
    edges.forEach(el=>{el.disabled=!n||(busy&&!gesture);});
    if(!n){currentId=null;$('note-title').value='';$('note-body').value='';$('note-ink').replaceChildren();$('todo-hits').replaceChildren();return;}
    const changed=currentId!==n.id; currentId=n.id;
    if($('note-title').value!==n.title) $('note-title').value=n.title;
    if($('note-body').value!==n.body) $('note-body').value=n.body;
    if(changed) $('note-body').scrollTop=0;
    $('note-date').textContent=date(n.createdAt); $('note-number').textContent=noteId?'•':String(state.archive.length+1).padStart(2,'0');
    stage.style.setProperty('--paper',COLORS[n.color]); stage.style.setProperty('--paper-light',LIGHTS[n.color]);
    for(const [index,name] of ['sheet-one','sheet-two','sheet-three'].entries()){
      const color=!noteId&&state.settings.randomColors?state.paperQueue?.[index]||n.color:n.color;
      stage.querySelector(`.${name}`).style.setProperty('--sheet-color',COLORS[color]);
    }
    document.querySelectorAll('[data-color]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.color===n.color))); renderInk();
    if(motion&&!busy) {
      motion.setAppearance(appearance());
      if(surfaceColor!==n.color) { $('paper').style.setProperty('--paper-surface',`url("${motion.getSurfaceDataURL()}")`); surfaceColor=n.color; }
    }
  }
  function applyState(next) {
    if(!next||(state&&(next.revision||0)<(state.revision||0))) return;
    state=structuredClone(next); state.desktop||=[]; state.trash||=[]; state.settings||={sound:true};
    if(draft) { const n=findNote(draft.id); if(n) Object.assign(n,draft.changes); }
    renderCurrent();renderList();sound.setEnabled(state.settings.sound!==false);
    $('sound').setAttribute('aria-pressed',String(state.settings.sound!==false));
    $('sound').querySelector('use').setAttribute('href',state.settings.sound!==false?'#i-sound':'#i-muted');
    $('pin').setAttribute('aria-pressed',String(Boolean(state.settings.pinned)));
    $('random-color').setAttribute('aria-pressed',String(Boolean(state.settings.randomColors)));
  }
  function edit(changes) {
    const n=current(); if(!n||busy) return;
    Object.assign(n,changes); draft={id:n.id,changes:{...(draft?.id===n.id?draft.changes:{}),...changes},serial:++draftSerial}; renderInk();save();
  }
  function save(immediate=false) {
    clearTimeout(saveTimer);
    if(loadBlocked) {status('保存失败，请先导出备份',true);return Promise.resolve(false);}
    if(!draft) return pendingSave;
    status('保存中…');
    const execute=()=>{
      if(!draft||draft.serial===queuedSerial) return pendingSave;
      const snapshot=structuredClone(draft);queuedSerial=snapshot.serial;
      pendingSave=pendingSave.then(async()=>{
        try {
          const next=await dispatch({type:'patchNote',id:snapshot.id,changes:snapshot.changes});
          if(draft?.serial===snapshot.serial) draft=null;
          applyState(next);if(!draft)status('已保存在本机');return true;
        } catch(error) {queuedSerial=-1;status('保存失败，请先导出备份',true);toast(error.message||'保存失败');return false;}
      });return pendingSave;
    };
    if(immediate)return execute();saveTimer=setTimeout(execute,240);return pendingSave;
  }
  async function submit(action) {
    if(!await save(true))throw new Error('当前内容尚未保存，请先重试或导出');
    const next=await dispatch(action);applyState(next);return next;
  }
  async function run(action,message,undo=null) {
    if(busy)return;
    try{await submit(action);lastUndo=undo;renderList();if(message)toast(message,Boolean(undo));}
    catch(error){toast(error.message||'操作未完成');}
  }
  // Browser-only preview fallback. The desktop edition uses the native store.
  async function dispatch(action) {
    if(bridge)return bridge.dispatch(action);
    const next=structuredClone(state);
    const nextBlank=(color='butter')=>{if(!next.settings.randomColors)return newNote(color);fillPreviewQueue(next,color);return newNote(next.paperQueue.shift());};
    const locate=id=>next.active?.id===id?{source:'active',note:next.active}:['desktop','archive'].map(source=>({source,index:next[source].findIndex(n=>n.id===id)})).filter(r=>r.index>=0).map(r=>({...r,note:next[r.source][r.index]}))[0];
    const take=r=>{if(r.source==='active')next.active=null;else next[r.source].splice(r.index,1);};
    const item=locate(action.id);
    if(action.type==='detachNote'&&item?.source==='desktop')throw new Error('这张便签已在桌面，可归档或删除');
    if(action.type==='randomizePaper'){
      if(!item||!['active','desktop'].includes(item.source))throw new Error('只能为当前桌面便签重新配色');
      const previousQueue=JSON.stringify(next.paperQueue||[]),choices=Object.keys(COLORS).filter(color=>color!==item.note.color);
      item.note.color=choices[Math.floor(Math.random()*choices.length)];next.settings.randomColors=true;
      if(item.source==='active'){
        next.paperQueue=[];fillPreviewQueue(next);
        if(JSON.stringify(next.paperQueue)===previousQueue)[next.paperQueue[0],next.paperQueue[1]]=[next.paperQueue[1],next.paperQueue[0]];
      }
    }
    else if(action.type==='patchNote'&&item)Object.assign(item.note,action.changes);
    else if(['archiveNote','deleteNote','detachNote'].includes(action.type)&&item){
      take(item);
      if(action.type==='archiveNote')next.archive.push({...item.note,tornAt:new Date().toISOString()});
      else if(action.type==='deleteNote')next.trash.push({note:item.note,source:item.source,index:item.index,deletedAt:new Date().toISOString()});
      else next.desktop.push(item.note);
      if(item.source==='active')next.active=nextBlank(item.note.color);
    }else if(action.type==='restoreArchive'&&item?.source==='archive'){
      take(item);if(hasContent(next.active))next.archive.push(next.active);next.active=item.note;
    }else if(action.type==='restoreTrash'){
      const index=next.trash.findIndex(r=>r.note.id===action.id);
      if(index>=0){const[r]=next.trash.splice(index,1);if(r.source==='active'){if(hasContent(next.active))next.archive.push(next.active);next.active=r.note;}else next[r.source].push(r.note);}
    }else if(action.type==='purgeTrash')next.trash=[];
    else if(action.type==='createNote'){if(!next.active)next.active=nextBlank();else next.desktop.push(nextBlank(next.active.color));}
    else if(action.type==='setSettings')Object.assign(next.settings,action.changes);
    if(!next.active&&!next.desktop.length)next.active=nextBlank(item?.note.color);
    fillPreviewQueue(next);
    next.revision=(next.revision||0)+1;localStorage.setItem(storageKey,JSON.stringify(next));return next;
  }
  function renderList() {
    if(!state||archiveDrag?.dragging)return;
    const notes=view==='trash'?state.trash.map(r=>r.note):view==='desktop'?[...(state.active?[{...state.active,isMother:true,hidden:state.settings.mainWindow?.hidden}]:[]),...state.desktop]:state[view];
    $('archive-title').textContent={archive:'已归档',desktop:'桌面便签',trash:'最近删除'}[view];$('archive-count').textContent=String(notes.length).padStart(2,'0');
    $('desktop-label').textContent=view==='desktop'?'返回归档':`桌面便签 · ${state.desktop.length+(state.active?1:0)}`;
    $('trash-label').textContent=view==='trash'?'返回归档':`最近删除${state.trash.length?` · ${state.trash.length}`:''}`;
    $('purge-trash').hidden=view!=='trash';$('purge-trash').disabled=!state.trash.length;$('archive-list').replaceChildren();
    if(!notes.length){const el=document.createElement('div');el.className='archive-empty';el.textContent={archive:'归档的便签会留在这里',desktop:'撕下的便签会贴在桌面上',trash:'没有已删除的便签'}[view];$('archive-list').append(el);}
    [...notes].reverse().forEach((n,index)=>{
      const card=document.createElement('article');card.className='archive-card';card.style.setProperty('--card-color',COLORS[n.color]);card.style.setProperty('--tilt',`${index%2?1.1:-1.2}deg`);
      const title=document.createElement('h3');title.textContent=n.title||'未命名便签';
      const body=document.createElement('p');Text.render(body,n.body||'空白便签',n.strikes||[],n);
      const time=document.createElement('time');time.textContent=(view==='desktop'?`${n.isMother?'母便签 · ':''}${n.hidden?'已隐藏 · ':''}`:'')+date(n.tornAt||n.createdAt,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
      const open=document.createElement('button');open.className='archive-open';open.append(title,body,time);
      let suppressClick=false;
      open.addEventListener('click',()=>{if(suppressClick){suppressClick=false;return;}if(view==='desktop'&&bridge)(n.isMother?bridge.openNotebook():bridge.showNote(n.id)).catch(e=>toast(e.message));else openNote(n.id);});
      if(view==='archive'&&bridge)bindArchiveDrag(open,card,n,()=>{suppressClick=true;});
      const action=document.createElement('button');action.className='archive-card-action';action.title=`${view==='trash'?'恢复':'删除'}：${n.title||'未命名便签'}`;action.setAttribute('aria-label',action.title);
      action.innerHTML=`<svg><use href="${view==='trash'?'#i-undo':'#i-trash'}"/></svg>`;
      action.addEventListener('click',()=>view==='trash'?run({type:'restoreTrash',id:n.id},'已恢复便签'):run({type:'deleteNote',id:n.id},'已移到最近删除',{kind:'delete',id:n.id}));
      card.append(open,action);$('archive-list').append(card);
    });
    $('undo').disabled=!lastUndo;$('undo-label').textContent=lastUndo?.kind==='delete'?'撤销删除':'撤销归档';$('undo').title=`${$('undo-label').textContent}（Ctrl+Z）`;
  }
  function undoLast(){if(lastUndo)void run({type:lastUndo.kind==='delete'?'restoreTrash':'restoreArchive',id:lastUndo.id},'已恢复便签');}
  function cancelArchiveDrag(){
    if(!archiveDrag)return;
    const drag=archiveDrag;archiveDrag=null;drag.ghost?.remove();drag.card.classList.remove('dragging');
    if(drag.handle.hasPointerCapture(drag.pointer))drag.handle.releasePointerCapture(drag.pointer);
    if(drag.dragging){setBusy(false);renderList();}
  }
  function bindArchiveDrag(handle,card,note,suppressClick){
    handle.title='拖到桌面，或点击查看';
    handle.addEventListener('pointerdown',event=>{
      if(event.button!==0||busy||archiveDrag)return;
      archiveDrag={handle,card,noteId:note.id,pointer:event.pointerId,x:event.screenX,y:event.screenY,dragging:false,ghost:null};
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener('pointermove',event=>{
      const drag=archiveDrag;if(!drag||drag.handle!==handle||drag.pointer!==event.pointerId)return;
      if(!drag.dragging&&Math.hypot(event.screenX-drag.x,event.screenY-drag.y)>7){
        drag.dragging=true;suppressClick();setBusy(true);card.classList.add('dragging');
        const ghost=document.createElement('div');ghost.className='archive-drag-ghost';
        ghost.textContent=note.title||note.body.slice(0,60)||'空白便签';ghost.style.background=COLORS[note.color];
        document.body.append(ghost);drag.ghost=ghost;
      }
      if(drag.ghost)drag.ghost.style.transform=`translate(${event.clientX-48}px,${event.clientY-25}px) rotate(-3deg)`;
    });
    handle.addEventListener('pointerup',async event=>{
      const drag=archiveDrag;if(!drag||drag.handle!==handle||drag.pointer!==event.pointerId)return;
      archiveDrag=null;drag.ghost?.remove();card.classList.remove('dragging');
      if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);
      if(!drag.dragging)return;
      try{
        const cursor=await bridge.getCursorPosition(),panel=document.querySelector('.archive-panel').getBoundingClientRect();
        const x=cursor.x-window.screenX,y=cursor.y-window.screenY;
        if(x<panel.left||x>panel.right||y<panel.top||y>panel.bottom){
          await submit({type:'detachNote',id:drag.noteId,position:{x:Math.round(cursor.x-188),y:Math.round(cursor.y-165)}});
          lastUndo=null;
        }
      }catch(error){toast(error.message||'未能放回桌面，便签仍保留在归档中');}
      finally{setBusy(false);renderList();}
    });
    handle.addEventListener('pointercancel',()=>{if(archiveDrag?.handle===handle)cancelArchiveDrag();});
    handle.addEventListener('lostpointercapture',()=>{if(archiveDrag?.handle===handle)cancelArchiveDrag();});
  }
  function openNote(id){
    if(busy)return;const n=findNote(id);if(!n)return;selectedId=id;selectedView=view;
    $('preview-kind').textContent={archive:'已归档的便签',desktop:'桌面便签',trash:'已删除的便签'}[view];$('delete-note').hidden=view==='trash';$('restore-note').textContent=view==='trash'?'恢复便签':'放回便签本';
    $('preview-title').textContent=n.title||'未命名便签';Text.render($('preview-body'),n.body,n.strikes||[],n);$('preview-date').textContent=date(n.createdAt);$('preview-paper').style.setProperty('--preview-color',COLORS[n.color]);$('note-dialog').showModal();updateHitRegions();
  }
  function exportNotes(notes){
    const content=notes.filter(Boolean).map(n=>`${n.title||'未命名便签'}\n${date(n.createdAt)}\n\n${n.body}`).join('\n\n────────────────────\n\n');
    const url=URL.createObjectURL(new Blob(['\uFEFF',content],{type:'text/plain;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download=`便签-${new Date().toLocaleDateString('sv-SE')}.txt`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function toggleFormat(field){
    if(busy||!current())return;const input=$('note-body'),n=current();let start=input.selectionStart,end=input.selectionEnd;
    if(start===end)({start,end}=Text.currentLineRange(n.body,start));if(start===end)return;
    edit({[field]:Text.toggleRange(n[field]||[],start,end,n.body)});input.focus();input.setSelectionRange(start,end);updateFormatButtons();
  }
  function editBody(body){
    const n=current();if(!n||busy)return;
    const changes={body};for(const field of FORMAT_FIELDS)changes[field]=Text.adjustRanges(n.body,body,n[field]||[]);edit(changes);
  }
  function toggleTodo(){
    const n=current(),input=$('note-body');if(!n||busy)return;
    const line=Text.currentLineRange(n.body,input.selectionStart),marked=/^[○●] /.test(n.body.slice(line.start,line.end));
    const start=input.selectionStart,end=input.selectionEnd,delta=marked?-2:2;
    const body=n.body.slice(0,line.start)+(marked?'':'○ ')+n.body.slice(line.start+(marked?2:0));
    input.value=body;editBody(body);input.focus();input.setSelectionRange(Math.max(line.start,start+delta),Math.max(line.start,end+delta));updateFormatButtons();
  }
  function toggleTodoDone(offset){
    const n=current(),input=$('note-body');if(!n||busy||!Number.isInteger(offset)||!/^[○●] /.test(n.body.slice(offset,offset+2)))return;
    const start=input.selectionStart,end=input.selectionEnd;
    const body=n.body.slice(0,offset)+(n.body[offset]==='○'?'●':'○')+n.body.slice(offset+1);
    input.value=body;editBody(body);input.focus();input.setSelectionRange(start,end);
  }
  function setBusy(value){busy=value;bridge?.setInteracting(value);for(const id of ['note-title','note-body',...Object.keys(FORMAT_TOOLS),'todo','random-color','archive-current','delete-current','new-note'])$(id).disabled=value||!current();document.querySelectorAll('[data-color],.todo-hit').forEach(el=>{el.disabled=value||!current();});edges.forEach(el=>{el.disabled=!current()||(value&&!gesture);});}
  function placePaper(x,y){
    document.body.style.setProperty('--note-x',`${x}px`);document.body.style.setProperty('--note-y',`${y}px`);
    motion?.resizeViewport();updateHitRegions();
  }
  function restoreViewport(){document.body.classList.remove('peel-active');motion.resizeViewport();updateHitRegions();}
  function hideZones(){zoneAction=null;$('peel-actions').hidden=true;$('peel-actions').querySelectorAll('[data-action]').forEach(el=>el.classList.remove('selected'));}
  function detectZone(){
    if(!gesture||motion.progress<.35)return null;const p=gesture.point;
    if(!(gesture.side==='right'?p.x<190:p.x>170)||p.y< -150||p.y>540)return null;
    if(noteId)return p.y<195?'archive':'delete';
    return p.y<130?'archive':p.y<260?'delete':'detach';
  }
  function updateZones(){
    if(!gesture||finishing)return;$('peel-actions').hidden=motion.progress<.30;$('peel-actions').dataset.side=gesture.side;
    const action=detectZone();zoneAction=action;
    $('peel-actions').querySelectorAll('[data-action]').forEach(el=>el.classList.toggle('selected',el.dataset.action===action));
  }
  function startPeel(){
    $('note-title').blur();$('note-body').blur();motion.setAppearance(appearance());stage.classList.add('is-tearing');stage.classList.remove('is-hovering');
    $('toast').hidden=true;finishing=false;peelAction=null;dropPosition=null;setBusy(true);
    // The desktop canvas is already in place. Grabbing never moves or resizes
    // its native window, and shares the notebook's synchronous animation path.
    document.body.classList.add('peel-active');
  }
  function releaseCapture(){if(!gesture)return;const old=gesture;gesture=null;if(old.handle.hasPointerCapture(old.id))old.handle.releasePointerCapture(old.id);}
  function moveGrip(event){
    if(!gesture)return;
    const latest=event.getCoalescedEvents?.().at(-1)||event,now=performance.now();
    gesture.speed=Math.hypot(latest.screenX-gesture.lastScreen.x,latest.screenY-gesture.lastScreen.y)/Math.max(.008,(now-gesture.lastTime)/1000);
    gesture.point={x:gesture.origin.x+latest.screenX-gesture.screen.x,y:gesture.origin.y+latest.screenY-gesture.screen.y};gesture.lastScreen={x:latest.screenX,y:latest.screenY};gesture.lastTime=now;
    motion.move(gesture.point.x,gesture.point.y);sound.update(motion.progress,gesture.speed);updateZones();
  }
  async function endGesture(action=null){
    if(!gesture||finishing)return;finishing=true;const accepted=motion.progress>=.35&&!(noteId&&action==='detach')?action:null,point=gesture.lastScreen;
    dropPosition=accepted==='detach'?{x:Math.round(point.x-(gesture.side==='left'?140:500)),y:Math.round(point.y-140-motion.gripY)}:null;
    releaseCapture();hideZones();peelAction=accepted;
    const detached=motion.release(accepted);sound.release({detached});if(!detached)finishing=false;
  }
  function cancelPeel(){releaseCapture();hideZones();autoPeel=false;sound.cancel();motion.cancel();}
  async function finishPeel(){
    const id=current()?.id,action=peelAction;let committed=false;hideZones();
    try{
      await restoreViewport();
      if(id&&action){await submit({type:{archive:'archiveNote',delete:'deleteNote',detach:'detachNote'}[action],id,...(dropPosition?{position:dropPosition}:{})});committed=true;lastUndo=action==='detach'?null:{kind:action,id};}
    }catch(error){toast(error.message||'操作未完成，便签已保留');}
    finally{stage.classList.remove('is-tearing','is-hovering');motion.resetAfterDetach();setBusy(false);finishing=false;autoPeel=false;renderCurrent();renderList();if(committed&&action==='delete'&&!noteId)toast('已移到最近删除',true);}
  }
  async function settle(){
    if(noteDrag||archiveDrag?.dragging)return;
    if(!document.body.classList.contains('peel-active')){stage.classList.remove('is-tearing','is-hovering');return;}
    hideZones();restoreViewport();stage.classList.remove('is-tearing','is-hovering');setBusy(false);finishing=false;autoPeel=false;renderCurrent();
  }
  async function tearAutomatically(action='detach'){
    if(busy||!['archive','delete','detach'].includes(action)||(noteId&&action==='detach'))return;
    if(!current()){if(action==='detach')await run({type:'createNote'});return;}
    autoPeel=action;startPeel();sound.begin();motion.demo();
  }
  function applyMode(mode){
    const compact=typeof mode==='object'?mode.compact:mode;
    document.body.classList.toggle('desktop-note',compact);$('compact').setAttribute('aria-pressed',String(compact));
    if(mode?.layout){nativeLayout=mode.layout;placePaper(nativeLayout.paperX,nativeLayout.paperY);}
    else{motion?.resizeViewport();updateHitRegions();}
  }
  async function chooseColor(color){
    if(busy||!current())return;edit({color});renderCurrent();setBusy(true);
    try{await submit({type:'setSettings',changes:{randomColors:false}});}
    catch(error){toast(error.message||'纸色设置未保存');}
    finally{setBusy(false);renderCurrent();}
  }
  async function randomizePaper(){
    if(busy||!current())return;setBusy(true);
    try{await submit({type:'randomizePaper',id:current().id});}
    catch(error){toast(error.message||'随机纸叠设置未保存');}
    finally{setBusy(false);renderCurrent();}
  }
  function movePaper(event){
    if(!noteDrag||noteDrag.pointer!==event.pointerId)return;
    noteDrag.x=noteDrag.startX+event.screenX-noteDrag.screenX;noteDrag.y=noteDrag.startY+event.screenY-noteDrag.screenY;
    placePaper(noteDrag.x,noteDrag.y);
  }
  async function finishPaperMove(cancel=false){
    if(!noteDrag)return;const drag=noteDrag;noteDrag=null;
    if(drag.handle.hasPointerCapture(drag.pointer))drag.handle.releasePointerCapture(drag.pointer);
    try{
      if(cancel)placePaper(drag.startX,drag.startY);
      else applyMode(await bridge.moveNote({x:Math.round(window.screenX+drag.x-140),y:Math.round(window.screenY+drag.y-140)}));
    }catch(error){placePaper(drag.startX,drag.startY);toast(error.message||'便签位置未保存');}
    finally{setBusy(false);renderCurrent();}
  }
  function bindPaperMove(){
    const handle=document.querySelector('.glue-strip');
    handle.addEventListener('pointerdown',event=>{
      if(!bridge||!document.body.classList.contains('desktop-note')||event.button!==0||busy||!current())return;
      event.preventDefault();motion.leave();stage.classList.remove('is-tearing','is-hovering');
      const rect=stage.getBoundingClientRect();noteDrag={handle,pointer:event.pointerId,startX:rect.x,startY:rect.y,x:rect.x,y:rect.y,screenX:event.screenX,screenY:event.screenY};
      handle.setPointerCapture(event.pointerId);setBusy(true);document.body.classList.add('moving-note');
    });
    handle.addEventListener('pointermove',movePaper);
    handle.addEventListener('pointerup',event=>{if(noteDrag?.pointer===event.pointerId){movePaper(event);document.body.classList.remove('moving-note');void finishPaperMove();}});
    for(const type of ['pointercancel','lostpointercapture'])handle.addEventListener(type,()=>{if(noteDrag){document.body.classList.remove('moving-note');void finishPaperMove(true);}});
  }

  async function init(){
    await document.fonts.load('20px SiyeLatin');
    let loaded;
    if(bridge){const context=await bridge.getContext();noteId=context.noteId;applyMode(context);loaded=await bridge.load();}
    else{document.body.classList.remove('desktop-note');try{loaded={data:JSON.parse(localStorage.getItem(storageKey)||'null')};}catch{loaded={error:'无法读取便签'};}}
    if(loaded.error){loadBlocked=true;status('原数据无法读取，已保留原文件',true);toast(loaded.error);}
    state=loaded.data||{version:1,revision:0,active:{...newNote(),title:'今天的小事',body:'把想法先记下来。\n\n□ 整理桌面\n□ 留一点时间散步'},archive:[],desktop:[],trash:[],settings:{sound:true}};
    state.desktop||=[];state.trash||=[];
    if(!bridge){
      fillPreviewQueue(state);
      if(!state.active){state.active=newNote(state.settings.randomColors?state.paperQueue.shift():'butter');fillPreviewQueue(state);state.revision=(state.revision||0)+1;localStorage.setItem(storageKey,JSON.stringify(state));}
    }
    if(noteId&&!current())throw new Error('这张便签已经归档或删除');
    document.body.classList.toggle('mother-note',noteId===null);
    motion=new window.PaperMotion({canvas:$('paper-canvas'),...appearance(),onProgress:updateZones,onDetach:finishPeel,onSettle:settle,onHold:()=>{if(autoPeel){peelAction=autoPeel;finishing=true;hideZones();motion.commit();sound.release({detached:true});}}});
    applyState(state);$('today').textContent=date(new Date(),{year:'numeric',month:'2-digit',day:'2-digit',weekday:'long'});
    $('note-title').addEventListener('input',()=>edit({title:$('note-title').value}));
    $('note-body').addEventListener('input',()=>editBody($('note-body').value));
    $('note-body').addEventListener('scroll',()=>{$('note-ink').scrollTop=$('note-body').scrollTop;renderTodoHits();});
    for(const event of ['select','keyup','click'])$('note-body').addEventListener(event,updateFormatButtons);
    for(const [id,field] of Object.entries(FORMAT_TOOLS)){$(id).addEventListener('pointerdown',event=>event.preventDefault());$(id).addEventListener('click',()=>toggleFormat(field));}
    $('todo').addEventListener('pointerdown',event=>event.preventDefault());$('todo').addEventListener('click',toggleTodo);
    $('todo-hits').addEventListener('pointerdown',event=>{if(event.target.closest('.todo-hit'))event.preventDefault();});
    $('todo-hits').addEventListener('click',event=>{const hit=event.target.closest('.todo-hit');if(hit)toggleTodoDone(Number(hit.dataset.offset));});
    document.querySelectorAll('[data-color]').forEach(el=>el.addEventListener('click',()=>void chooseColor(el.dataset.color)));
    $('random-color').addEventListener('click',()=>void randomizePaper());bindPaperMove();
    for(const handle of edges){
      const side=handle.id==='tear-left'?'left':'right';
      const local=event=>{const r=stage.getBoundingClientRect();return{x:event.clientX-r.x,y:event.clientY-r.y};};
      const hover=event=>{if(busy||!current()||event.pointerType==='touch')return;motion.setAppearance(appearance());const p=local(event);stage.classList.add('is-tearing','is-hovering');motion.hover(p.x,p.y,side);};
      handle.addEventListener('pointerenter',hover);handle.addEventListener('pointerleave',()=>{if(!busy)motion.leave();});
      handle.addEventListener('pointerdown',event=>{
        if(event.button!==0||busy||!current())return;event.preventDefault();const p=local(event);
        gesture={id:event.pointerId,handle,side,origin:p,point:p,screen:{x:event.screenX,y:event.screenY},lastScreen:{x:event.screenX,y:event.screenY},lastTime:performance.now(),speed:0};
        handle.setPointerCapture(event.pointerId);startPeel();sound.begin();motion.begin(p.x,p.y,side);
      });
      handle.addEventListener('pointermove',event=>{
        if(gesture?.id===event.pointerId&&gesture.handle===handle){
          moveGrip(event);
        }else if(!busy&&event.pointerType!=='touch'){if(!stage.classList.contains('is-hovering'))hover(event);else{const p=local(event);motion.hover(p.x,p.y,side);}}
      });
      handle.addEventListener('pointerup',event=>{if(gesture?.id===event.pointerId){moveGrip(event);void endGesture(detectZone());}});
      handle.addEventListener('pointercancel',()=>{if(gesture?.handle===handle)cancelPeel();});handle.addEventListener('lostpointercapture',()=>{if(gesture?.handle===handle)cancelPeel();});
      handle.addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();void tearAutomatically(noteId?'archive':'detach');}});
    }
    for(const id of ['note-title','note-body'])$(id).addEventListener('focus',()=>{if(!busy){motion.leave();stage.classList.remove('is-tearing','is-hovering');}});
    window.addEventListener('blur',()=>{if(noteDrag){document.body.classList.remove('moving-note');void finishPaperMove(true);}if(archiveDrag)cancelArchiveDrag();if(gesture)cancelPeel();else if(!busy)motion.leave();});
    $('new-note').addEventListener('click',()=>void tearAutomatically());$('undo').addEventListener('click',undoLast);
    $('archive-current').addEventListener('click',()=>void tearAutomatically('archive'));
    $('delete-current').addEventListener('click',()=>void tearAutomatically('delete'));
    $('create-note').addEventListener('click',()=>void run({type:'createNote'}));
    $('trash-toggle').addEventListener('click',()=>{if(!busy){view=view==='trash'?'archive':'trash';renderList();}});
    $('desktop-view').addEventListener('click',()=>{if(!busy){view=view==='desktop'?'archive':'desktop';renderList();}});
    $('dialog-close').addEventListener('click',()=>$('note-dialog').close());
    $('delete-note').addEventListener('click',()=>{$('note-dialog').close();void run({type:'deleteNote',id:selectedId},'已移到最近删除',{kind:'delete',id:selectedId});});
    $('restore-note').addEventListener('click',()=>{$('note-dialog').close();void run({type:selectedView==='trash'?'restoreTrash':'restoreArchive',id:selectedId},'已恢复便签');});
    $('export-note').addEventListener('click',()=>{const n=findNote(selectedId);if(n)exportNotes([n]);});$('export-all').addEventListener('click',()=>exportNotes([state.active,...state.desktop,...state.archive]));
    $('purge-trash').addEventListener('click',()=>{if(busy||!state.trash.length)return;$('purge-description').textContent=`将永久删除 ${state.trash.length} 张便签，此操作无法撤销。`;$('purge-dialog').showModal();updateHitRegions();});
    $('purge-cancel').addEventListener('click',()=>$('purge-dialog').close());
    $('purge-confirm').addEventListener('click',async()=>{
      $('purge-confirm').disabled=true;
      try{await submit({type:'purgeTrash'});lastUndo=null;renderList();$('purge-dialog').close();toast('最近删除已清空');}catch(error){toast(error.message);}finally{$('purge-confirm').disabled=false;}
    });
    for(const dialog of document.querySelectorAll('dialog')){
      dialog.addEventListener('close',updateHitRegions);dialog.addEventListener('click',event=>{const r=dialog.getBoundingClientRect();if(event.target===dialog&&(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom))dialog.close();});
    }
    $('sound').addEventListener('click',()=>void run({type:'setSettings',changes:{sound:state.settings.sound===false}}));
    if(bridge){
      bridge.onStateChanged(applyState);bridge.onModeChanged(applyMode);bridge.onError(message=>toast(message));bridge.onBeforeClose(async()=>{if(!await save(true))throw new Error('保存失败，请先导出');});
      $('pin').addEventListener('click',()=>bridge.togglePin().catch(error=>toast(error.message)));
      $('compact').addEventListener('click',async()=>{if(busy)return;motion.leave();if(noteId)await bridge.openNotebook();else applyMode(await bridge.toggleCompact());});
      $('minimize').addEventListener('click',()=>bridge.hide().catch(error=>toast(error.message)));$('close').addEventListener('click',()=>bridge.close());
      if(noteId){$('close').hidden=true;$('new-note').hidden=true;$('compact').title='打开便签本';for(const handle of edges)handle.setAttribute('aria-label',`捏住${handle.id==='tear-left'?'左':'右'}边缘揭开，松手归档或删除；回车归档`);}
    }else for(const id of ['pin','compact','minimize','close'])$(id).hidden=true;
    document.addEventListener('keydown',event=>{
      if(event.key==='Escape'&&noteDrag){event.preventDefault();document.body.classList.remove('moving-note');void finishPaperMove(true);return;}if(event.key==='Escape'&&archiveDrag){event.preventDefault();cancelArchiveDrag();return;}if(event.key==='Escape'&&gesture){event.preventDefault();cancelPeel();return;}if(document.querySelector('dialog[open]')||busy)return;
      if(event.ctrlKey&&event.shiftKey&&event.key.toLowerCase()==='x'){event.preventDefault();toggleFormat('strikes');}
      else if(event.ctrlKey&&event.key.toLowerCase()==='b'){event.preventDefault();toggleFormat('bolds');}
      else if(event.ctrlKey&&event.key.toLowerCase()==='u'){event.preventDefault();toggleFormat('underlines');}
      else if(event.ctrlKey&&event.shiftKey&&event.key.toLowerCase()==='h'){event.preventDefault();toggleFormat('highlights');}
      else if(event.ctrlKey&&event.shiftKey&&event.key.toLowerCase()==='l'){event.preventDefault();toggleTodo();}
      else if(event.ctrlKey&&event.key.toLowerCase()==='n'){event.preventDefault();if(noteId&&bridge)void bridge.openNotebook();else void tearAutomatically();}
      else if(event.ctrlKey&&event.key.toLowerCase()==='z'&&!['INPUT','TEXTAREA'].includes(event.target.tagName)){event.preventDefault();undoLast();}
    });
    document.addEventListener('visibilitychange',()=>{if(document.hidden)void save(true);});window.addEventListener('beforeunload',()=>{void save(true);sound.destroy();});
    window.addEventListener('resize',()=>{motion.resizeViewport();updateHitRegions();});updateHitRegions();
    if(bridge)await bridge.ready();
  }
  window.siyeReady=init();window.siyeReady.catch(error=>{status('启动失败，请重新打开',true);console.error(error);});
})();
