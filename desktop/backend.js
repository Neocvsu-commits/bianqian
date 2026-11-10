/* One authoritative store for every WebView2 window. Native code owns disk I/O. */
(() => {
  'use strict';
  const M = window.NoteModel;
  const native = (method, ...args) => window.__TAURI__.core.invoke('native_call', { method, args });
  const windows = new Map(), noteWindows = new Map(), pendingSync = new Map(), creating = new Map(), pendingModes = new Map();
  let store, loadError = null, motherId = null, closing = false, startupReported = false;
  let mutations = Promise.resolve(), initialized;

  const send = (id, event, payload) => native('send', id, event, payload);
  const errorText = error => error?.message || String(error);
  const motherSettings = () => store.settings.mainWindow;
  const noteFor = ctx => ctx.noteId === null ? store.active : store.desktop.find(note => note.id === ctx.noteId);
  const hiddenFor = ctx => ctx.noteId === null ? Boolean(motherSettings().hidden || (!store.active && motherSettings().compact)) : Boolean(noteFor(ctx)?.hidden);

  async function context(id) {
    if (windows.has(id)) return windows.get(id);
    const mode = await native('window.context', id);
    if (windows.has(id)) return windows.get(id);
    const ctx = { id, noteId: mode.noteId ?? null, ready: false, shown: false, hidden: true, fallback: false, flushReady: false };
    windows.set(id, ctx);
    if (ctx.noteId === null) motherId = id; else noteWindows.set(ctx.noteId, id);
    return ctx;
  }
  async function create(noteId = null) {
    const existing = noteId === null ? motherId : noteWindows.get(noteId);
    if (existing) return context(existing);
    if (creating.has(noteId)) return creating.get(noteId);
    const pending = createWindow(noteId).finally(() => creating.delete(noteId));
    creating.set(noteId, pending);
    return pending;
  }
  async function createWindow(noteId) {
    const note = noteId === null ? null : store.desktop.find(item => item.id === noteId);
    const settings = motherSettings();
    const result = await native('window.create', {
      noteId, compact: noteId !== null || settings.compact,
      hidden: noteId === null ? Boolean(settings.hidden) : Boolean(note?.hidden),
      pinned: store.settings.pinned,
      ...(noteId === null ? { desktopBounds: settings.desktopBounds, bounds: settings.bounds } : { position: note.position }),
    });
    return context(result.windowId);
  }
  async function reveal(ctx, focus = false) {
    ctx.wantFocus = ctx.wantFocus || focus;
    if (!ctx.ready || hiddenFor(ctx)) return;
    ctx.hidden = false; ctx.shown = true; ctx.fallback = false;
    await native('window.show', ctx.id, Boolean(ctx.wantFocus));
    ctx.wantFocus = false;
  }
  async function present() {
    for (const ctx of [...windows.values()]) {
      if (ctx.noteId !== null && !noteFor(ctx)) {
        windows.delete(ctx.id); noteWindows.delete(ctx.noteId);
        for (const [key, pending] of pendingSync) if (pending.windowId === ctx.id) { clearTimeout(pending.timer); pending.reject(new Error('便签窗口已关闭，请重试。')); pendingSync.delete(key); }
        await native('window.destroy', ctx.id);
        continue;
      }
      if(ctx.pinned!==store.settings.pinned){await native('window.pin', ctx.id, store.settings.pinned);ctx.pinned=store.settings.pinned;}
      const wasHidden = ctx.hidden;
      ctx.hidden = hiddenFor(ctx);
      if (!ctx.ready) continue;
      if (ctx.hidden && !ctx.fallback) await native('window.hide', ctx.id);
      else if (!ctx.hidden && (wasHidden || !ctx.shown || ctx.wantFocus)) await reveal(ctx);
    }
    const mother = windows.get(motherId);
    if (!closing && mother?.ready && ![...windows.values()].some(ctx => !ctx.hidden)) {
      if (!mother.fallback) { mother.fallback = true; await native('window.minimize', mother.id); }
    }
  }
  function mutate(operation) {
    const pending = mutations.catch(() => {}).then(async () => {
      await initialized;
      if (loadError) throw new Error(loadError);
      const next = structuredClone(store);
      if (await operation(next) === false) return structuredClone(store);
      next.revision = store.revision + 1;
      M.normalizeData(next);
      await native('store.write', next);
      store = next;
      await native('broadcast', 'notes:state-changed', store);
      await present();
      return structuredClone(store);
    });
    mutations = pending;
    return pending;
  }
  async function modelContext(id) {
    const geometry = await native('window.geometry', id);
    return { compact: geometry.compact, desktopBounds: geometry.desktopBounds, win: { getBounds: () => geometry.bounds } };
  }
  async function savePosition(id, hidden) {
    const ctx = windows.get(id);
    if (!ctx) return;
    const geometry = await native('window.geometry', id);
    return mutate(data => {
      if (ctx.noteId === null) {
        const old = data.settings.mainWindow;
        const next = { ...old, bounds: geometry.normalBounds, desktopBounds: geometry.desktopBounds, compact: geometry.compact, ...(typeof hidden === 'boolean' ? { hidden } : {}) };
        if (JSON.stringify(old) === JSON.stringify(next)) return false;
        data.settings.mainWindow = next;
      } else {
        const note = data.desktop.find(item => item.id === ctx.noteId);
        if (!note) return false;
        const position = { x: Math.round(geometry.desktopBounds.x), y: Math.round(geometry.desktopBounds.y) };
        const nextHidden = typeof hidden === 'boolean' ? hidden : Boolean(note.hidden);
        if (note.position?.x === position.x && note.position?.y === position.y && Boolean(note.hidden) === nextHidden) return false;
        note.position = position; note.hidden = nextHidden;
      }
    });
  }
  function flush(ctx) {
    if (!ctx.flushReady) return ctx.ready ? Promise.reject(new Error('便签仍在加载，请稍后重试。')) : Promise.resolve();
    const previous = [...pendingSync.values()].find(item => item.windowId === ctx.id);
    if (previous) return previous.promise;
    const id = crypto.randomUUID();
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const timer = setTimeout(() => { pendingSync.delete(id); reject(new Error('便签同步超时，窗口已保留，请稍后重试。')); }, 8000);
    pendingSync.set(id, { windowId: ctx.id, promise, resolve, reject, timer });
    send(ctx.id, 'notes:sync-request', id).catch(error => { clearTimeout(timer); pendingSync.delete(id); reject(error); });
    return promise;
  }
  function synced(windowId, id, success) {
    const pending = pendingSync.get(id);
    if (!pending || pending.windowId !== windowId) return;
    clearTimeout(pending.timer); pendingSync.delete(id);
    if (success) pending.resolve(); else pending.reject(new Error('保存失败，窗口已保留，请先导出便签。'));
  }
  async function changeMode(ctx, compact) {
    if (ctx.modeChange) await ctx.modeChange;
    const previous = await native('window.context', ctx.id);
    if (previous.compact === compact) return previous;
    const transition = crypto.randomUUID();
    const operation = (async () => {
      const target = await native('window.mode-plan', ctx.id, compact);
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { pendingModes.delete(transition); reject(new Error('界面切换未就绪，请重试。')); }, 4000);
          pendingModes.set(transition, { windowId: ctx.id, resolve, reject, timer });
          send(ctx.id, 'window:mode-preparing', { transition, mode: target }).catch(reject);
        });
        return await native('window.compact', ctx.id, compact, transition);
      } catch (error) {
        await send(ctx.id, 'window:mode-cancelled', { transition, mode: await native('window.context', ctx.id) });
        throw error;
      } finally {
        const pending = pendingModes.get(transition);
        if (pending) { clearTimeout(pending.timer); pendingModes.delete(transition); }
      }
    })();
    ctx.modeChange = operation;
    try { return await operation; } finally { if (ctx.modeChange === operation) ctx.modeChange = null; }
  }
  async function openMother(notebook = true) {
    if (closing) throw new Error('便签本正在关闭。');
    const ctx = windows.get(motherId);
    if (!ctx) return;
    ctx.fallback = false;
    if (notebook || !store.active) await changeMode(ctx, false);
    ctx.wantFocus = true;
    await savePosition(ctx.id, false);
    // A changed position/visibility already reveals through present(). When
    // nothing changed, perform just the remaining focus request here.
    if (ctx.wantFocus) await reveal(ctx);
  }
  async function hide(ctx) {
    if (closing) throw new Error('便签本正在关闭。');
    await flush(ctx); await savePosition(ctx.id, true);
  }
  async function closeAll() {
    if (closing) return;
    closing = true;
    try {
      await Promise.all([...windows.values()].map(flush));
      for (const ctx of windows.values()) await savePosition(ctx.id, ctx.hidden);
      await mutations;
      await native('app.quit');
    } catch (error) {
      closing = false;
      await native('broadcast', 'notes:close-error', errorText(error));
    }
  }
  async function dispatch(ctx, action) {
    if (closing && action?.type !== 'patchNote') throw new Error('便签本正在关闭。');
    if (action && ['archiveNote', 'deleteNote'].includes(action.type)) {
      const child = windows.get(noteWindows.get(action.id));
      if (child && child !== ctx) await flush(child);
    }
    const model = await modelContext(ctx.id);
    const data = await mutate(next => M.reduceAction(next, action, model));
    for (const note of store.desktop) if (!noteWindows.has(note.id)) await create(note.id);
    if (action.type === 'detachNote' || action.type === 'restoreTrash') {
      const id = noteWindows.get(action.id);
      if (id && !store.desktop.find(note => note.id === action.id)?.hidden) await reveal(windows.get(id), true);
    }
    return data;
  }
  async function handle(id, method, args) {
    await initialized;
    const ctx = await context(id);
    switch (method) {
      case 'notes:context': return native('window.context', id);
      case 'notes:load': await mutations.catch(() => {}); return { data: store, ...(loadError ? { error: loadError } : {}) };
      case 'notes:dispatch': return dispatch(ctx, args[0]);
      case 'notes:show': {
        const noteId = args[0];
        await mutate(data => { const note = data.desktop.find(item => item.id === noteId); if (!note) throw new Error('桌面便签已被移动或删除。'); note.hidden = false; });
        const child = noteWindows.has(noteId) ? windows.get(noteWindows.get(noteId)) : await create(noteId);
        return reveal(child, true);
      }
      case 'notes:save': throw new Error('请使用便签操作接口保存。');
      case 'notes:flush-ready': ctx.flushReady = true; return;
      case 'notes:sync-complete': return synced(id, args[0], true);
      case 'notes:sync-error': return synced(id, args[0], false);
      case 'window:ready':
        ctx.ready = true; await present();
        await send(id, 'window:mode-changed', await native('window.context', id));
        if (!startupReported) { startupReported = true; await native('app.ready'); }
        return;
      case 'window:hide': case 'window:minimize': return hide(ctx);
      case 'window:close': return ctx.noteId === null ? closeAll() : hide(ctx);
      case 'window:open-notebook': return openMother(true);
      case 'window:mode-prepared': {
        const pending = pendingModes.get(args[0]);
        if (pending?.windowId === id) { clearTimeout(pending.timer); pendingModes.delete(args[0]); pending.resolve(); }
        return;
      }
      case 'window:mode-layout-ready': return native('window.mode-layout-ready', id, args[0]);
      case 'window:compact': {
        if (ctx.modeChange) return ctx.modeChange;
        const mode = await native('window.context', id);
        const next = await changeMode(ctx, !mode.compact);
        await savePosition(id); return next;
      }
      case 'window:pin': await mutate(data => { data.settings.pinned = !data.settings.pinned; }); return store.settings.pinned;
      case 'window:cursor-position': return native('window.cursor', id);
      case 'window:hit-regions': return native('window.hitRegions', id, args[0]);
      case 'window:interacting': return native('window.interacting', id, args[0] === true);
      case 'window:move-note': {
        if (!M.validPosition(args[0])) throw new Error('桌面位置无效。');
        const mode = await native('window.move', id, args[0]); await savePosition(id); return mode;
      }
      case 'window:prepare-peel': case 'window:activate-peel': case 'window:begin-peel': case 'window:prepare-end-peel': return null;
      case 'window:end-peel': return native('window.interacting', id, false);
      case 'file:export': return native('file.export', args[0], args[1]);
      default: throw new Error('未知便签操作。');
    }
  }
  window.__hostReceive = message => {
    if (message.event === 'request') {
      const { windowId, id, method, args = [] } = message.payload;
      handle(windowId, method, args).then(result => native('reply', windowId, id, result ?? null, null), error => native('reply', windowId, id, null, errorText(error))).catch(console.error);
      return;
    }
    (async () => {
      await initialized;
      const ctx = windows.get(message.payload?.windowId);
      if (message.event === 'window-moved' && ctx?.ready && !closing) await savePosition(ctx.id);
      else if (message.event === 'window-close' && ctx) await (ctx.noteId === null ? closeAll() : hide(ctx));
      else if (message.event === 'window-restored' && ctx?.fallback) await openMother(false);
      else if (message.event === 'second-instance') await openMother(false);
    })().catch(error => native('broadcast', 'notes:close-error', errorText(error)));
  };
  initialized = (async () => {
    const loaded = await native('store.read');
    loadError = loaded.error || null;
    const previous = loaded.data === null ? null : JSON.stringify(loaded.data);
    try { store = M.prepare(loaded.data); }
    catch { loadError = '原便签数据无法读取，已保留原文件并暂停保存。请先导出当前内容。'; store = M.prepare(null); }
    if (!loadError && JSON.stringify(store) !== previous) {
      try { store.revision += 1; await native('store.write', store); }
      catch { loadError = '便签已读取，但无法保存，已暂停修改。请先导出便签并检查文件权限。'; }
    }
  })();
  (async () => {
    await initialized;
    await native('backend.ready');
    await create();
    for (const note of store.desktop) await create(note.id);
  })().catch(error => native('app.error', errorText(error)));
})();
