(() => {
  'use strict';
  if (!window.__TAURI__ || window.desktop) return;
  let sequence = 0, beforeClose, currentMode = null, flushing = null;
  const pending = new Map(), listeners = new Map();
  const on = (event, callback) => {
    if (typeof callback !== 'function') throw new TypeError('回调必须为函数。');
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(callback);
    return () => listeners.get(event)?.delete(callback);
  };
  const invoke = (method, ...args) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('操作超时，请稍后重试。')); }, 30000);
    pending.set(id, { resolve, reject, timer });
    window.__TAURI__.core.invoke('request', { id, method, args }).catch(error => {
      clearTimeout(timer); pending.delete(id); reject(new Error(String(error)));
    });
  });
  const fire = (method, ...args) => { void invoke(method, ...args).catch(error => { for (const callback of listeners.get('notes:close-error') || []) callback(error.message); }); };
  window.__hostReceive = message => {
    if (message.event) {
      if (message.event === 'window:mode-changed') currentMode = message.payload;
      for (const callback of listeners.get(message.event) || []) callback(message.payload);
    } else {
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer); pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result);
    }
  };
  const flush = () => {
    if (!flushing) flushing = Promise.resolve().then(async () => {
      if (!beforeClose || await beforeClose() === false) throw new Error('保存失败，请先导出便签。');
    }).finally(() => { flushing = null; });
    return flushing;
  };
  on('notes:sync-request', async id => {
    try { await flush(); fire('notes:sync-complete', id); }
    catch { fire('notes:sync-error', id); }
  });
  window.desktop = {
    minimize: () => fire('window:minimize'), close: () => fire('window:close'),
    hide: () => invoke('window:hide'), ready: () => invoke('window:ready'),
    getCursorPosition: () => invoke('window:cursor-position'), moveNote: position => invoke('window:move-note', position),
    getDropPosition: async (offsetX, offsetY) => {
      const cursor = await invoke('window:cursor-position');
      return { x: Math.round((cursor.physicalX - (offsetX - 140) * cursor.scale) / cursor.worldScale - 140), y: Math.round((cursor.physicalY - (offsetY - 140) * cursor.scale) / cursor.worldScale - 140) };
    },
    togglePin: () => invoke('window:pin'), toggleCompact: () => invoke('window:compact'), openNotebook: () => invoke('window:open-notebook'),
    onModePreparing: callback => on('window:mode-preparing', callback), onModeCancelled: callback => on('window:mode-cancelled', callback),
    modePrepared: transition => invoke('window:mode-prepared', transition),
    modeLayoutReady: detail => fire('window:mode-layout-ready', detail),
    onModeChanged: callback => { const off = on('window:mode-changed', callback); if (currentMode) callback(currentMode); return off; },
    setHitRegions: regions => fire('window:hit-regions', regions), setInteracting: active => fire('window:interacting', active),
    beginPeel: rect => invoke('window:begin-peel', rect), preparePeel: rect => invoke('window:prepare-peel', rect),
    activatePeel: () => invoke('window:activate-peel'), prepareEndPeel: () => invoke('window:prepare-end-peel'), endPeel: () => invoke('window:end-peel'),
    load: () => invoke('notes:load'), getContext: () => invoke('notes:context'), dispatch: action => invoke('notes:dispatch', action),
    showNote: id => invoke('notes:show', id), save: data => invoke('notes:save', data),
    exportText: (filename, content) => invoke('file:export', filename, content),
    onStateChanged: callback => on('notes:state-changed', callback), onError: callback => on('notes:close-error', callback),
    onBeforeClose: callback => { if (typeof callback !== 'function') throw new TypeError('关闭回调必须为函数。'); beforeClose = callback; fire('notes:flush-ready'); },
  };
})();
