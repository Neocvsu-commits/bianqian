#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod geometry;

use geometry::{Bounds, DesktopPlacement};
use serde_json::{json, Value};
use std::{collections::HashMap, fs, io::Write, path::PathBuf, sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, Arc, Mutex}, time::{Duration, Instant}};
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use windows::{core::{PCWSTR, PWSTR}, Win32::{Foundation::{GetLastError, SetLastError, ERROR_ALREADY_EXISTS, ERROR_SUCCESS, HWND, LPARAM, LRESULT, POINT, WPARAM}, Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH}, System::Threading::CreateMutexW, UI::{Controls::Dialogs::{GetSaveFileNameW, OPENFILENAMEW, OFN_OVERWRITEPROMPT, OFN_PATHMUSTEXIST, OFN_NOCHANGEDIR}, Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON}, Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass}, WindowsAndMessaging::{FindWindowW, GetCursorPos, GetWindowLongPtrW, MessageBoxW, PostMessageW, SetWindowLongPtrW, GWL_EXSTYLE, IDYES, MB_ICONERROR, MB_ICONINFORMATION, MB_YESNO, WM_APP, WM_DISPLAYCHANGE, WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE, WM_NCLBUTTONDOWN, WM_NCDESTROY, WS_EX_LAYERED, WS_EX_TRANSPARENT}}}};

const END_MOVE: u32 = WM_APP + 471;
const REFRESH_LAYOUT: u32 = WM_APP + 472;
const SECOND_INSTANCE: u32 = WM_APP + 473;
const REFRESH_SCALE: u32 = WM_APP + 474;
const MAX_DATA: usize = 5 * 1024 * 1024;

#[derive(Clone)]
struct Moving { offset_x: f64, offset_y: f64, layout: Value }
#[derive(Clone)]
struct NoteWindow {
    note_id: Value,
    compact: bool,
    hidden: bool,
    placement: DesktopPlacement,
    normal: Bounds,
    regions: Vec<Bounds>,
    interacting: bool,
    ignoring: bool,
    passthrough_added_layered: bool,
    native_dragging: bool,
    drag_anchor: Option<(f64,f64)>,
    drag_drop: Option<(i32,i32)>,
    drag_cancelled: bool,
    moving: Option<Moving>,
    suppress_until: Instant,
    minimized: bool,
}
struct Host {
    windows: Mutex<HashMap<String, NoteWindow>>,
    next_id: AtomicUsize,
    backend_ready: AtomicBool,
    pending: Mutex<Vec<Value>>,
    exiting: AtomicBool,
    data_dir: PathBuf,
    check_startup: bool,
    trace_drag: bool,
    ready: AtomicBool,
    store_lock: Mutex<()>,
}
struct Hook { app: AppHandle, label: String }

fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain(Some(0)).collect() }
fn err<E: std::fmt::Display>(e: E) -> String { e.to_string() }
fn argument(args: &[Value], i: usize) -> Result<&Value, String> { args.get(i).ok_or_else(|| "缺少调用参数".into()) }
fn text_argument(args: &[Value], i: usize) -> Result<&str, String> { argument(args, i)?.as_str().ok_or_else(|| "调用参数无效".into()) }
fn bool_argument(args: &[Value], i: usize) -> bool { args.get(i).and_then(Value::as_bool).unwrap_or(false) }
fn window(app: &AppHandle, id: &str) -> Result<WebviewWindow, String> { app.get_webview_window(id).filter(|w| w.label() != "backend").ok_or_else(|| "便签窗口已关闭".into()) }
fn context(app: &AppHandle, id: &str) -> Result<NoteWindow, String> { app.state::<Arc<Host>>().windows.lock().map_err(err)?.get(id).cloned().ok_or_else(|| "便签窗口已关闭".into()) }
fn drag_trace(app:&AppHandle,id:&str,stage:&str,detail:Value) {
    let host=app.state::<Arc<Host>>(); if !host.trace_drag{return}
    let entry=json!({"time":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis(),"window":id,"stage":stage,"detail":detail});
    if let Ok(mut file)=fs::OpenOptions::new().create(true).append(true).open(host.data_dir.join("drag-trace.jsonl")){let _=file.write_all(format!("{}\n",entry).as_bytes());}
}
fn frontend(win: &WebviewWindow, value: Value) { let _ = win.eval(&format!("window.__hostReceive&&window.__hostReceive({})", value)); }
fn event(win: &WebviewWindow, name: &str, payload: Value) { frontend(win, json!({"event":name,"payload":payload})); }
fn backend(app: &AppHandle, name: &str, payload: Value) {
    let host = app.state::<Arc<Host>>();
    let value = json!({"event":name,"payload":payload});
    if !host.backend_ready.load(Ordering::SeqCst) { host.pending.lock().unwrap().push(value); }
    else if let Some(win) = app.get_webview_window("backend") { frontend(&win, value); }
}
fn mode(ctx: &NoteWindow) -> Value {
    json!({"noteId":ctx.note_id,"compact":ctx.compact,"moving":ctx.moving.is_some(),"layout":if ctx.compact { ctx.moving.as_ref().map(|m|m.layout.clone()).unwrap_or_else(||geometry::layout(&ctx.placement)) } else {Value::Null}})
}
fn on_window_thread<T: Send + 'static>(win: &WebviewWindow, action: impl FnOnce(WebviewWindow) -> Result<T,String> + Send + 'static) -> Result<T,String> {
    let target=win.clone(); let (tx,rx)=std::sync::mpsc::sync_channel(1);
    // Tauri executes this inline when already on the HWND's UI thread.
    win.run_on_main_thread(move||{let _=tx.send(action(target));}).map_err(err)?;
    rx.recv().map_err(err)?
}
fn extended_style(hwnd: HWND) -> Result<isize,String> {
    unsafe {
        SetLastError(ERROR_SUCCESS);
        let style=GetWindowLongPtrW(hwnd,GWL_EXSTYLE);
        if style==0 && GetLastError()!=ERROR_SUCCESS {return Err(windows::core::Error::from_win32().to_string())}
        Ok(style)
    }
}
// UI thread only. Do not route through Tao's style diff: it also calls ShowWindow
// and refreshes the frame, which can reposition an oversized transparent HWND.
fn apply_mouse_passthrough(win: &WebviewWindow, requested: bool) -> Result<(),String> {
    let hwnd=win.hwnd().map_err(err)?;
    let ctx=context(win.app_handle(),win.label())?;
    let ignore=requested && ctx.compact && !ctx.interacting && ctx.moving.is_none() && !ctx.native_dragging;
    let old=extended_style(hwnd)?;
    let transparent=WS_EX_TRANSPARENT.0 as isize; let layered=WS_EX_LAYERED.0 as isize;
    let added_layered=ignore && (ctx.passthrough_added_layered || old & layered==0);
    let next=if ignore {old|transparent|layered} else {(old & !transparent) & if ctx.passthrough_added_layered {!layered} else {!0}};
    if next!=old {
        unsafe {
            SetLastError(ERROR_SUCCESS);
            if SetWindowLongPtrW(hwnd,GWL_EXSTYLE,next)==0 && GetLastError()!=ERROR_SUCCESS {
                return Err(windows::core::Error::from_win32().to_string());
            }
        }
    }
    let host=win.app_handle().state::<Arc<Host>>(); let mut states=host.windows.lock().map_err(err)?;
    if let Some(state)=states.get_mut(win.label()) {state.ignoring=ignore;state.passthrough_added_layered=added_layered;}
    Ok(())
}
fn set_mouse_passthrough(win: &WebviewWindow, ignore: bool) -> Result<(),String> {
    on_window_thread(win,move|target|apply_mouse_passthrough(&target,ignore))
}
// The paper lives inside a transparent screen-sized canvas. Windows' normal
// caption constraints apply to that invisible canvas and can pull its top back
// onto the work area on release. Keep the grabbed point under the cursor before
// a native move is applied, rather than moving the window again after release.
fn drag_origin(app: &AppHandle,id: &str,hwnd: HWND) -> Option<(i32,i32)> {
    let ctx=context(app,id).ok()?;
    if !ctx.compact || !ctx.native_dragging || ctx.drag_cancelled {return None}
    let (x,y)=ctx.drag_anchor?; let mut point=POINT::default();
    unsafe {
        if GetAsyncKeyState(windows::Win32::UI::Input::KeyboardAndMouse::VK_ESCAPE.0 as i32)<0 {
            let host=app.state::<Arc<Host>>();
            if let Some(state)=host.windows.lock().ok()?.get_mut(id){state.drag_cancelled=true;}
            return None
        }
        if let Some(drop)=ctx.drag_drop{return Some(drop)}
        GetCursorPos(&mut point).ok()?;
    }
    // Avoid re-entering Tao's window-state lock from its native window proc.
    let dpi=unsafe{windows::Win32::UI::HiDpi::GetDpiForWindow(hwnd)};
    if dpi==0{return None}
    let scale=dpi as f64/96.0;
    let origin=(point.x-(x*scale).round() as i32,point.y-(y*scale).round() as i32);
    if unsafe{GetAsyncKeyState(VK_LBUTTON.0 as i32)}>=0 {
        let host=app.state::<Arc<Host>>();
        if let Some(state)=host.windows.lock().ok()?.get_mut(id){state.drag_drop=Some(origin);};
    }
    Some(origin)
}
fn set_physical(win: &WebviewWindow, bounds: Bounds) -> Result<(), String> {
    win.set_position(PhysicalPosition::new(bounds.x.round() as i32, bounds.y.round() as i32)).map_err(err)?;
    win.set_size(PhysicalSize::new(bounds.width.round().max(1.0) as u32, bounds.height.round().max(1.0) as u32)).map_err(err)
}
fn apply_placement(app: &AppHandle, id: &str, place: DesktopPlacement) -> Result<Value, String> {
    let win = window(app,id)?;
    { let host = app.state::<Arc<Host>>(); let mut states = host.windows.lock().map_err(err)?;
      let ctx = states.get_mut(id).ok_or("便签窗口已关闭")?;
      ctx.placement = place.clone(); ctx.regions.clear(); ctx.ignoring = false; ctx.suppress_until = Instant::now()+Duration::from_millis(250);
    }
    set_mouse_passthrough(&win,false)?;
    set_physical(&win,place.canvas)?;
    let next = mode(&context(app,id)?); event(&win,"window:mode-changed",next.clone()); Ok(next)
}
fn begin_move(app: &AppHandle, id: &str) {
    let Ok(win) = window(app,id) else { return };
    let Ok(position) = win.inner_position() else { return };
    let Ok(origin) = win.outer_position() else { return };
    let scale = win.scale_factor().unwrap_or(1.0);
    let mut cursor=POINT::default();
    let anchor=unsafe {
        if GetAsyncKeyState(VK_LBUTTON.0 as i32)<0 && GetCursorPos(&mut cursor).is_ok() {
            win.hwnd().ok().map(|hwnd|windows::Win32::UI::HiDpi::GetDpiForWindow(hwnd)).filter(|dpi|*dpi>0)
                .map(|dpi|{let factor=dpi as f64/96.0;((cursor.x-origin.x) as f64/factor,(cursor.y-origin.y) as f64/factor)})
        }else{None}
    };
    let next = {
      let host = app.state::<Arc<Host>>(); let mut all = host.windows.lock().unwrap();
      let Some(ctx) = all.get_mut(id) else { return };
      if !ctx.compact || ctx.moving.is_some() { return }
      // WebView2 starts the real native loop from the CSS drag region. Bind
      // the cursor here so mouse drags and their release correction share it.
      // Keyboard moves keep the operating system's normal arrow-key behavior.
      ctx.native_dragging=anchor.is_some();ctx.drag_anchor=anchor;ctx.drag_drop=None;ctx.drag_cancelled=false;
      let (x,y) = ctx.placement.paper_origin_physical();
      ctx.moving = Some(Moving { offset_x:(x-position.x as f64)/scale, offset_y:(y-position.y as f64)/scale, layout:geometry::layout(&ctx.placement) });
      ctx.interacting = true; ctx.ignoring = false; mode(ctx)
    };
    let _ = set_mouse_passthrough(&win,false); event(&win,"window:mode-changed",next);
}
fn end_move(app: &AppHandle, id: &str) {
    let Ok(win) = window(app,id) else { return };
    let Ok(ctx) = context(app,id) else { return };
    if let Some(moving) = ctx.moving {
        let result = (|| -> Result<(),String> {
            let place = geometry::retain_canvas(&win,moving.offset_x,moving.offset_y)?;
            let next = {
                let host=app.state::<Arc<Host>>(); let mut states=host.windows.lock().map_err(err)?;
                let s=states.get_mut(id).ok_or("便签窗口已关闭")?;
                s.placement=place;s.moving=None;s.interacting=false;mode(s)
            };
            // Keep HWND, CSS coordinates and hit regions stationary on release.
            event(&win,"window:mode-changed",next); Ok(())
        })();
        if let Err(message)=result { event(&win,"notes:close-error",json!(message)); }
    }
    {let host=app.state::<Arc<Host>>();let mut states=host.windows.lock().unwrap();
     if let Some(state)=states.get_mut(id){state.native_dragging=false;state.drag_anchor=None;state.drag_drop=None;state.drag_cancelled=false;}}
    backend(app,"window-moved",json!({"windowId":id}));
}
fn refresh_scale(app: &AppHandle,id:&str) {
    let (Ok(ctx),Ok(win))=(context(app,id),window(app,id)) else{return};
    if !ctx.compact || ctx.moving.is_some(){return}
    let layout=geometry::layout(&ctx.placement);
    let (Some(x),Some(y))=(layout["paperX"].as_f64(),layout["paperY"].as_f64()) else{return};
    if let Ok(place)=geometry::retain_canvas(&win,x,y) {
        let next={let host=app.state::<Arc<Host>>();let mut states=host.windows.lock().unwrap();let Some(s)=states.get_mut(id) else{return};s.placement=place;mode(s)};
        event(&win,"window:mode-changed",next);
        backend(app,"window-moved",json!({"windowId":id}));
    }
}
fn refresh_layout(app: &AppHandle,id:&str) {
    if let Ok(ctx)=context(app,id) { if ctx.compact && ctx.moving.is_none() { if let Ok(place)=geometry::placement(app,Some(ctx.placement.logical)) {let _=apply_placement(app,id,place);backend(app,"window-moved",json!({"windowId":id}));} } }
}
unsafe extern "system" fn subclass(hwnd:HWND,msg:u32,w:WPARAM,l:LPARAM,_id:usize,data:usize)->LRESULT {
    let hook=&*(data as *const Hook);
    if [WM_NCLBUTTONDOWN,WM_ENTERSIZEMOVE,WM_EXITSIZEMOVE,END_MOVE,windows::Win32::UI::WindowsAndMessaging::WM_CANCELMODE].contains(&msg){
        drag_trace(&hook.app,&hook.label,"native-message",json!({"message":msg,"wparam":w.0,"left":GetAsyncKeyState(VK_LBUTTON.0 as i32)}));
    }
    match msg {
        windows::Win32::UI::WindowsAndMessaging::WM_MOVING if l.0!=0 => {
            if let Some((x,y))=drag_origin(&hook.app,&hook.label,hwnd) {
                let rect=&mut *(l.0 as *mut windows::Win32::Foundation::RECT);
                let width=rect.right-rect.left;let height=rect.bottom-rect.top;
                rect.left=x;rect.top=y;rect.right=x+width;rect.bottom=y+height;
                return LRESULT(1)
            }
        },
        windows::Win32::UI::WindowsAndMessaging::WM_WINDOWPOSCHANGING if l.0!=0 => {
            let pos=&mut *(l.0 as *mut windows::Win32::UI::WindowsAndMessaging::WINDOWPOS);
            if !pos.flags.contains(windows::Win32::UI::WindowsAndMessaging::SWP_NOMOVE) {
                if let Some((x,y))=drag_origin(&hook.app,&hook.label,hwnd) {
                    pos.x=x;pos.y=y;
                    return LRESULT(0)
                }
            }
        },
        WM_ENTERSIZEMOVE => begin_move(&hook.app,&hook.label),
        WM_EXITSIZEMOVE => {
            if let Some(origin)=drag_origin(&hook.app,&hook.label,hwnd){
                let host=hook.app.state::<Arc<Host>>();
                if let Some(state)=host.windows.lock().unwrap().get_mut(&hook.label){state.drag_drop=Some(origin);};
            }
            let _=PostMessageW(Some(hwnd),END_MOVE,WPARAM(0),LPARAM(0));
        },
        windows::Win32::UI::WindowsAndMessaging::WM_CANCELMODE => {
            let host=hook.app.state::<Arc<Host>>();
            if let Some(state)=host.windows.lock().unwrap().get_mut(&hook.label){if state.moving.is_some(){state.drag_cancelled=true;}};
        },
        END_MOVE => {end_move(&hook.app,&hook.label);return LRESULT(0)},
        WM_DISPLAYCHANGE => {let _=PostMessageW(Some(hwnd),REFRESH_LAYOUT,WPARAM(0),LPARAM(0));},
        REFRESH_LAYOUT => {refresh_layout(&hook.app,&hook.label);return LRESULT(0)},
        REFRESH_SCALE => {refresh_scale(&hook.app,&hook.label);return LRESULT(0)},
        SECOND_INSTANCE => {backend(&hook.app,"second-instance",json!({}));return LRESULT(0)},
        WM_NCDESTROY => {let _=RemoveWindowSubclass(hwnd,Some(subclass),471);let result=DefSubclassProc(hwnd,msg,w,l);drop(Box::from_raw(data as *mut Hook));return result},
        _=>{}
    }
    DefSubclassProc(hwnd,msg,w,l)
}
fn install_hook(win:&WebviewWindow)->Result<(),String> {
    let target=win.clone();
    win.app_handle().run_on_main_thread(move||{
        let Ok(hwnd)=target.hwnd() else{return};
        let hook=Box::new(Hook{app:target.app_handle().clone(),label:target.label().into()});let raw=Box::into_raw(hook);
        if !unsafe{SetWindowSubclass(hwnd,Some(subclass),471,raw as usize)}.as_bool(){unsafe{drop(Box::from_raw(raw))};event(&target,"notes:close-error",json!("无法连接窗口拖动事件"));}
    }).map_err(err)
}
fn create_note(app:&AppHandle,options:&Value)->Result<Value,String> {
    let host=app.state::<Arc<Host>>();let id=format!("note-{}",host.next_id.fetch_add(1,Ordering::SeqCst));
    let compact=options.get("compact").and_then(Value::as_bool).unwrap_or(true);
    let saved=options.get("desktopBounds").or_else(||options.get("position")).filter(|v|!v.is_null()).map(|v|Bounds{x:v["x"].as_f64().unwrap_or(0.0),y:v["y"].as_f64().unwrap_or(0.0),width:640.0,height:670.0});
    let place=geometry::placement(app,saved)?;
    let normal=geometry::notebook_bounds(options.get("bounds").filter(|v|!v.is_null()).and_then(|v|serde_json::from_value::<Bounds>(v.clone()).ok()).unwrap_or(Bounds{x:place.logical.x,y:place.logical.y,width:1120.0,height:850.0}));
    let initial=if compact{place.canvas}else{geometry::normal_physical(app,normal)?};
    let ctx=NoteWindow{note_id:options.get("noteId").cloned().unwrap_or(Value::Null),compact,hidden:options.get("hidden").and_then(Value::as_bool).unwrap_or(false),placement:place,normal,regions:Vec::new(),interacting:false,ignoring:false,passthrough_added_layered:false,native_dragging:false,drag_anchor:None,drag_drop:None,drag_cancelled:false,moving:None,suppress_until:Instant::now()+Duration::from_secs(2),minimized:false};
    host.windows.lock().map_err(err)?.insert(id.clone(),ctx.clone());
    let build=WebviewWindowBuilder::new(app,&id,WebviewUrl::App("index.html".into()))
       .title("便签").decorations(false).transparent(true).shadow(false).visible(false).focused(false)
       .resizable(!compact).maximizable(!compact).minimizable(true).skip_taskbar(compact).always_on_top(options.get("pinned").and_then(Value::as_bool).unwrap_or(false))
       .inner_size(if compact{640.0}else{normal.width},if compact{670.0}else{normal.height})
       .min_inner_size(if compact{1.0}else{880.0},if compact{1.0}else{680.0})
       .data_directory(host.data_dir.join("WebView2"))
       .disable_drag_drop_handler()
       .initialization_script(format!("window.__HOST_WINDOW__={};window.__HOST_TRACE_DRAG__={};",json!(id),host.trace_drag))
       .on_navigation(|url|matches!(url.host_str(),Some("tauri.localhost")|Some("localhost")))
       .build();
    let win=match build {Ok(w)=>w,Err(e)=>{host.windows.lock().unwrap().remove(&id);return Err(err(e))}};
    set_physical(&win,initial)?;install_hook(&win)?;
    let handle=app.clone();let label=id.clone();
    win.on_window_event(move|e|match e {
        WindowEvent::CloseRequested{api,..}=>{if !handle.state::<Arc<Host>>().exiting.load(Ordering::SeqCst){api.prevent_close();backend(&handle,"window-close",json!({"windowId":label}));}},
        WindowEvent::Destroyed=>{handle.state::<Arc<Host>>().windows.lock().unwrap().remove(&label);},
        WindowEvent::Focused(true)=>{let restore={let host=handle.state::<Arc<Host>>();let mut states=host.windows.lock().unwrap();if let Some(s)=states.get_mut(&label){let old=s.minimized;s.minimized=false;old}else{false}};if restore{backend(&handle,"window-restored",json!({"windowId":label}));}},
        WindowEvent::ScaleFactorChanged{..}=>{if let Some(w)=handle.get_webview_window(&label){if let Ok(hwnd)=w.hwnd(){unsafe{let _=PostMessageW(Some(hwnd),REFRESH_SCALE,WPARAM(0),LPARAM(0));}}}},
        _=>{}
    });
    Ok(json!({"windowId":id,"context":mode(&ctx)}))
}
fn update_passthrough(app:&AppHandle) {
    let snapshots:Vec<_>=app.state::<Arc<Host>>().windows.lock().unwrap().iter().map(|(id,ctx)|(id.clone(),ctx.clone())).collect();
    for (id,ctx) in snapshots {
        if ctx.hidden {continue} let Some(win)=app.get_webview_window(&id) else{continue};
        let ignore=if !ctx.compact||ctx.interacting||ctx.native_dragging||ctx.moving.is_some()||Instant::now()<ctx.suppress_until{false}else{
            match geometry::cursor(&win){Ok(p)=>{let x=p["clientX"].as_f64().unwrap_or(-1.0);let y=p["clientY"].as_f64().unwrap_or(-1.0);!ctx.regions.iter().any(|r|x>=r.x&&y>=r.y&&x<r.x+r.width&&y<r.y+r.height)},Err(_)=>false}
        };
        // Pin/visibility/mode changes can make Tao rewrite EXSTYLE. Inspect the
        // real HWND bits so a cached flag cannot leave the desktop blocked.
        let actual=win.hwnd().map_err(err).and_then(extended_style);
        if let Ok(style)=actual {
            let transparent=WS_EX_TRANSPARENT.0 as isize; let layered=WS_EX_LAYERED.0 as isize;
            let changed=if ignore {style & (transparent|layered)!=(transparent|layered)} else {style & transparent!=0 || (ctx.passthrough_added_layered && style & layered!=0)};
            if changed || ignore!=ctx.ignoring {let _=set_mouse_passthrough(&win,ignore);}
        }
    }
}

#[tauri::command]
async fn request(app:AppHandle,window:WebviewWindow,id:Value,method:String,args:Vec<Value>)->Result<(),String>{
    if window.label()=="backend"{return Err("后台请求入口无效".into())}
    if !app.state::<Arc<Host>>().windows.lock().unwrap().contains_key(window.label()){return Err("便签窗口已关闭".into())}
    backend(&app,"request",json!({"windowId":window.label(),"id":id,"method":method,"args":args}));Ok(())
}
fn atomic_write(host:&Host,data:&Value)->Result<(),String>{
    let bytes=serde_json::to_vec(data).map_err(err)?;if bytes.len()>MAX_DATA{return Err("便签数据超过 5 MB，请先导出部分内容。".into())}
    let _guard=host.store_lock.lock().map_err(err)?;fs::create_dir_all(&host.data_dir).map_err(err)?;
    let target=host.data_dir.join("notes.json");let temporary=host.data_dir.join("notes.json.tmp");let backup=host.data_dir.join("notes.json.bak");
    {let mut file=fs::File::create(&temporary).map_err(err)?;file.write_all(&bytes).map_err(err)?;file.sync_all().map_err(err)?;}
    if target.exists() && fs::read(&target).ok().and_then(|old|serde_json::from_slice::<Value>(&old).ok()).is_some(){fs::copy(&target,&backup).map_err(err)?;}
    let source=wide(&temporary.to_string_lossy());let dest=wide(&target.to_string_lossy());
    unsafe{MoveFileExW(PCWSTR(source.as_ptr()),PCWSTR(dest.as_ptr()),MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH)}.map_err(err)
}
fn read_store(host:&Host)->Value{
    let path=host.data_dir.join("notes.json");if !path.exists(){return json!({"data":null})}
    let read=|p:&PathBuf|->Result<Value,String>{let file=fs::read(p).map_err(err)?;if file.len()>MAX_DATA{return Err("便签数据超过 5 MB".into())}serde_json::from_slice(&file).map_err(err)};
    match read(&path){Ok(data)=>json!({"data":data}),Err(e)=>match read(&host.data_dir.join("notes.json.bak")){Ok(data)=>json!({"data":data,"error":"主数据损坏，已读取上次备份。请导出保留。"}),Err(_)=>json!({"data":null,"error":format!("无法读取便签：{}。原文件已保留。",e),"readOnly":true})}}
}
fn export_text(app:&AppHandle,name:&str,content:&str)->Result<Value,String>{
    if content.len()>MAX_DATA{return Err("导出内容过大".into())}
    let mut buffer=vec![0u16;32768];let safe=name.replace(['\\','/',':','*','?','"','<','>','|'],"_");let initial=wide(&safe);let len=initial.len().min(buffer.len());buffer[..len].copy_from_slice(&initial[..len]);
    let filter=wide("文本文件 (*.txt)\0*.txt\0所有文件 (*.*)\0*.*\0");let extension=wide("txt");
    let owner=app.webview_windows().into_iter().find(|(id,_)|id!="backend").and_then(|(_,w)|w.hwnd().ok()).unwrap_or_default();
    let mut dialog=OPENFILENAMEW{lStructSize:std::mem::size_of::<OPENFILENAMEW>() as u32,hwndOwner:owner,lpstrFilter:PCWSTR(filter.as_ptr()),lpstrFile:PWSTR(buffer.as_mut_ptr()),nMaxFile:buffer.len() as u32,lpstrDefExt:PCWSTR(extension.as_ptr()),Flags:OFN_OVERWRITEPROMPT|OFN_PATHMUSTEXIST|OFN_NOCHANGEDIR,..Default::default()};
    if !unsafe{GetSaveFileNameW(&mut dialog)}.as_bool(){return Ok(json!({"cancelled":true}))}
    let length=buffer.iter().position(|x|*x==0).unwrap_or(buffer.len());let path=PathBuf::from(String::from_utf16_lossy(&buffer[..length]));fs::write(&path,content.as_bytes()).map_err(err)?;Ok(json!({"cancelled":false}))
}

#[tauri::command]
async fn native_call(app:AppHandle,window:WebviewWindow,method:String,args:Vec<Value>)->Result<Value,String>{
    if window.label()!="backend"{return Err("此接口仅供便签后台使用".into())}
    let host=app.state::<Arc<Host>>();
    match method.as_str(){
        "backend.ready"=>{host.backend_ready.store(true,Ordering::SeqCst);let pending=std::mem::take(&mut*host.pending.lock().map_err(err)?);for value in pending{frontend(&window,value)}Ok(Value::Null)},
        "store.read"=>Ok(read_store(&host)),
        "store.write"=>{atomic_write(&host,argument(&args,0)?)?;Ok(Value::Null)},
        "window.create"=>create_note(&app,argument(&args,0)?),
        "window.context"=>Ok(mode(&context(&app,text_argument(&args,0)?)?)),
        "window.geometry"=>{let id=text_argument(&args,0)?;let ctx=context(&app,id)?;let normal=if ctx.compact{ctx.normal}else{geometry::normal_logical(&window_for(&app,id)?)?};let bounds=if ctx.compact{ctx.placement.logical}else{normal};Ok(json!({"compact":ctx.compact,"hidden":ctx.hidden,"bounds":bounds,"normalBounds":normal,"desktopBounds":ctx.placement.logical}))},
        "window.mode-plan"=>{let win=window_for(&app,text_argument(&args,0)?)?;let compact=bool_argument(&args,1);on_window_thread(&win,move|win|plan_mode(&win,compact))},
        "window.mode-layout-ready"=>{drag_trace(&app,text_argument(&args,0)?,"mode-layout-ready",argument(&args,1)?.clone());Ok(Value::Null)},
        "window.compact"=>{let win=window_for(&app,text_argument(&args,0)?)?;let compact=bool_argument(&args,1);let transition=args.get(2).cloned().unwrap_or(Value::Null);on_window_thread(&win,move|win|switch_mode(win,compact,transition))},
        "window.move"=>{let id=text_argument(&args,0)?;let p=argument(&args,1)?;let b=Bounds{x:p["x"].as_f64().ok_or("位置无效")?,y:p["y"].as_f64().ok_or("位置无效")?,width:640.0,height:670.0};apply_placement(&app,id,geometry::placement(&app,Some(b))?)},
        "window.show"=>{let id=text_argument(&args,0)?;let win=window_for(&app,id)?;let compact={let mut states=host.windows.lock().map_err(err)?;let s=states.get_mut(id).ok_or("便签窗口已关闭")?;s.hidden=false;s.compact};if compact{win.set_skip_taskbar(true).map_err(err)?;}win.unminimize().map_err(err)?;win.show().map_err(err)?;if bool_argument(&args,1){win.set_focus().map_err(err)?}Ok(Value::Null)},
        "window.hide"=>{let id=text_argument(&args,0)?;window_for(&app,id)?.hide().map_err(err)?;if let Some(s)=host.windows.lock().map_err(err)?.get_mut(id){s.hidden=true}Ok(Value::Null)},
        "window.minimize"=>{let id=text_argument(&args,0)?;let win=window_for(&app,id)?;win.set_skip_taskbar(false).map_err(err)?;win.show().map_err(err)?;if let Some(s)=host.windows.lock().map_err(err)?.get_mut(id){s.minimized=true}suppress_mouse(&win)?;win.minimize().map_err(err)?;Ok(Value::Null)},
        "window.pin"=>{window_for(&app,text_argument(&args,0)?)?.set_always_on_top(bool_argument(&args,1)).map_err(err)?;Ok(Value::Null)},
        "window.destroy"=>{let id=text_argument(&args,0)?;host.windows.lock().map_err(err)?.remove(id);if let Some(w)=app.get_webview_window(id){w.destroy().map_err(err)?}Ok(Value::Null)},
        "window.cursor"=>geometry::cursor(&window_for(&app,text_argument(&args,0)?)?),
        "window.hitRegions"=>{let id=text_argument(&args,0)?;let regions:Vec<Bounds>=serde_json::from_value(argument(&args,1)?.clone()).map_err(err)?;if regions.len()>64||regions.iter().any(|r|![r.x,r.y,r.width,r.height].iter().all(|x|x.is_finite()&&x.abs()<=20000.0)||r.width<=0.0||r.height<=0.0){return Err("便签点击区域无效".into())}if let Some(s)=host.windows.lock().map_err(err)?.get_mut(id){s.regions=regions;s.suppress_until=Instant::now();}Ok(Value::Null)},
        "window.interacting"=>{let id=text_argument(&args,0)?;let active=bool_argument(&args,1);if let Some(s)=host.windows.lock().map_err(err)?.get_mut(id){s.interacting=active;s.ignoring=false;}set_mouse_passthrough(&window_for(&app,id)?,false)?;Ok(Value::Null)},
        "reply"=>{if let Some(w)=app.get_webview_window(text_argument(&args,0)?){frontend(&w,json!({"id":argument(&args,1)?,"result":args.get(2).cloned().unwrap_or(Value::Null),"error":args.get(3).cloned().unwrap_or(Value::Null)}));}Ok(Value::Null)},
        "send"=>{if let Some(w)=app.get_webview_window(text_argument(&args,0)?){event(&w,text_argument(&args,1)?,args.get(2).cloned().unwrap_or(Value::Null));}Ok(Value::Null)},
        "broadcast"=>{let name=text_argument(&args,0)?;let payload=args.get(1).cloned().unwrap_or(Value::Null);for(id,w)in app.webview_windows(){if id!="backend"{event(&w,name,payload.clone())}}Ok(Value::Null)},
        "file.export"=>export_text(&app,text_argument(&args,0)?,text_argument(&args,1)?),
        "app.ready"=>{host.ready.store(true,Ordering::SeqCst);if host.check_startup{let log=json!({"ready":true,"runtime":"WebView2","windows":host.windows.lock().map_err(err)?.len()});fs::write(host.data_dir.join("startup-check.json"),serde_json::to_vec_pretty(&log).map_err(err)?).map_err(err)?;host.exiting.store(true,Ordering::SeqCst);app.exit(0);}Ok(Value::Null)},
        "app.error"=>{let message=text_argument(&args,0)?;let _=fs::write(host.data_dir.join("startup-error.txt"),message);if !host.check_startup{message_box(message);}Ok(Value::Null)},
        "app.quit"=>{host.exiting.store(true,Ordering::SeqCst);app.exit(0);Ok(Value::Null)},
        _=>Err(format!("未知本地操作：{}",method))
    }
}
fn window_for(app:&AppHandle,id:&str)->Result<WebviewWindow,String>{window(app,id)}
fn plan_mode(win:&WebviewWindow,compact:bool)->Result<Value,String>{
    let mut next=context(win.app_handle(),win.label())?;
    let bounds=if compact{next.placement.canvas}else{geometry::normal_physical(win.app_handle(),next.normal)?};
    next.compact=compact;
    let mut value=mode(&next);
    value["viewport"]=json!({"width":bounds.width,"height":bounds.height});
    Ok(value)
}
fn switch_mode(win:WebviewWindow,compact:bool,transition:Value)->Result<Value,String>{
    let started=Instant::now();let app=win.app_handle();let id=win.label();
    let previous=context(app,id)?;
    if previous.compact==compact{return Ok(mode(&previous))}
    let normal=if !previous.compact{geometry::normal_logical(&win)?}else{previous.normal};
    let bounds=if compact{previous.placement.canvas}else{geometry::normal_physical(app,normal)?};
    if win.is_maximized().map_err(err)?{win.unmaximize().map_err(err)?;}
    {let host=app.state::<Arc<Host>>();let mut states=host.windows.lock().map_err(err)?;
        let state=states.get_mut(id).ok_or("便签窗口已关闭")?;
        state.compact=compact;state.normal=normal;state.regions.clear();state.interacting=false;
        state.moving=None;state.ignoring=false;state.suppress_until=Instant::now()+Duration::from_millis(250);
    }
    apply_mouse_passthrough(&win,false)?;
    win.set_resizable(!compact).map_err(err)?;win.set_maximizable(!compact).map_err(err)?;
    win.set_skip_taskbar(compact).map_err(err)?;
    win.set_min_size(if compact{None}else{Some(LogicalSize::new(880.0,680.0))}).map_err(err)?;
    // Commit position and size together; splitting them exposes a moved old surface.
    unsafe{windows::Win32::UI::WindowsAndMessaging::SetWindowPos(win.hwnd().map_err(err)?,None,
        bounds.x.round() as i32,bounds.y.round() as i32,
        bounds.width.round().max(1.0) as i32,bounds.height.round().max(1.0) as i32,
        windows::Win32::UI::WindowsAndMessaging::SWP_NOZORDER|windows::Win32::UI::WindowsAndMessaging::SWP_NOACTIVATE)}.map_err(err)?;
    let size=win.inner_size().map_err(err)?;
    let mut next=mode(&context(app,id)?);
    next["transition"]=transition;next["viewport"]=json!({"width":size.width,"height":size.height});
    event(&win,"window:mode-changed",next.clone());
    drag_trace(app,id,"mode-commit",json!({"compact":compact,"elapsedMs":started.elapsed().as_secs_f64()*1000.0}));
    Ok(next)
}
fn suppress_mouse(win:&WebviewWindow)->Result<(),String>{set_mouse_passthrough(win,false)}
fn message_box(message:&str){let msg=wide(message);let title=wide("便签");unsafe{MessageBoxW(None,PCWSTR(msg.as_ptr()),PCWSTR(title.as_ptr()),MB_ICONERROR);}}

fn main(){
    let args:Vec<String>=std::env::args().collect();let check=args.iter().any(|a|a=="--check-startup");let trace_drag=args.iter().any(|a|a=="--trace-drag");
    let override_dir=args.windows(2).find(|pair|pair[0]=="--data-dir").map(|pair|PathBuf::from(&pair[1]));
    if (check||trace_drag)&&override_dir.is_none(){message_box("诊断检查必须指定隔离的 --data-dir。");return}
    let data_dir=override_dir.clone().unwrap_or_else(||PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default()).join("SiyeDemo"));
    if let Err(e)=fs::create_dir_all(&data_dir){message_box(&format!("无法创建便签数据目录：{}",e));return}
    let mutex_name=wide(if override_dir.is_some(){"Local\\SiyeDemo.WebView2.Check"}else{"Local\\SiyeDemo.WebView2"});
    let _mutex=unsafe{CreateMutexW(None,false,PCWSTR(mutex_name.as_ptr()))};
    if unsafe{GetLastError()}==ERROR_ALREADY_EXISTS{let title=wide("便签后台");if let Ok(hwnd)=unsafe{FindWindowW(None,PCWSTR(title.as_ptr()))}{unsafe{let _=PostMessageW(Some(hwnd),SECOND_INSTANCE,WPARAM(0),LPARAM(0));}}return}
    if tauri::webview_version().is_err(){
        let message="便签需要 Microsoft Edge WebView2 运行环境。\n\nWindows 通常已经自带；这台电脑暂未检测到。是否打开微软官方下载页面？\n安装后重新打开便签即可。";
        if check{let _=fs::write(data_dir.join("startup-error.txt"),message);return}
        let text=wide(message);let title=wide("安装便签运行环境");
        if unsafe{MessageBoxW(None,PCWSTR(text.as_ptr()),PCWSTR(title.as_ptr()),MB_YESNO|MB_ICONINFORMATION)}==IDYES{let _=std::process::Command::new("rundll32.exe").args(["url.dll,FileProtocolHandler","https://developer.microsoft.com/microsoft-edge/webview2/#download-section"]).spawn();}return
    }
    let state=Arc::new(Host{windows:Mutex::new(HashMap::new()),next_id:AtomicUsize::new(1),backend_ready:AtomicBool::new(false),pending:Mutex::new(Vec::new()),exiting:AtomicBool::new(false),data_dir:data_dir.clone(),check_startup:check,trace_drag,ready:AtomicBool::new(false),store_lock:Mutex::new(())});
    let host=state.clone();
    let result=tauri::Builder::default().manage(state).invoke_handler(tauri::generate_handler![request,native_call]).setup(move|app|{
        let background=WebviewWindowBuilder::new(app,"backend",WebviewUrl::App("desktop/backend.html".into())).title("便签后台").visible(false).skip_taskbar(true).focused(false).inner_size(8.0,8.0).data_directory(host.data_dir.join("WebView2")).initialization_script("window.__HOST_WINDOW__='backend';").on_navigation(|url|matches!(url.host_str(),Some("tauri.localhost")|Some("localhost"))).build()?;
        install_hook(&background).map_err(std::io::Error::other)?;
        let handle=app.handle().clone();let polling=host.clone();std::thread::spawn(move||{while !polling.exiting.load(Ordering::SeqCst){update_passthrough(&handle);std::thread::sleep(Duration::from_millis(24));}});
        if host.check_startup{let handle=app.handle().clone();let checking=host.clone();std::thread::spawn(move||{std::thread::sleep(Duration::from_secs(40));if !checking.ready.load(Ordering::SeqCst){let _=fs::write(checking.data_dir.join("startup-error.txt"),"启动超时：前端未报告 ready");checking.exiting.store(true,Ordering::SeqCst);handle.exit(2);}});}
        Ok(())
    }).build(tauri::generate_context!());
    match result{Ok(app)=>app.run(|app,event|{if let tauri::RunEvent::Exit=event{app.state::<Arc<Host>>().exiting.store(true,Ordering::SeqCst);}}),Err(error)=>{let message=format!("便签启动失败：{}",error);let _=fs::write(data_dir.join("startup-error.txt"),&message);if !check{message_box(&message)}}}
}
