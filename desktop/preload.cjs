const { contextBridge, ipcRenderer } = require('electron');
let beforeClose = null;
let flushInProgress = false;
let rendererFlush = null;
let currentMode = null;
const modeCallbacks = new Set();
ipcRenderer.on('window:mode-changed', (_event, mode) => {
	currentMode = mode;
	for (const callback of modeCallbacks) callback(mode);
});

function flushRenderer() {
	if (!rendererFlush) {
		rendererFlush = Promise.resolve().then(async () => {
			if (!beforeClose || await beforeClose() === false) throw new Error('保存失败，请先导出便签。');
		}).finally(() => { rendererFlush = null; });
	}
	return rendererFlush;
}

ipcRenderer.on('notes:sync-request', async (_event, id) => {
	try { await flushRenderer(); ipcRenderer.send('notes:sync-complete', id); }
	catch { ipcRenderer.send('notes:sync-error', id); }
});

ipcRenderer.on('notes:flush', async () => {
	if (flushInProgress) return;
	flushInProgress = true;
	try {
		await flushRenderer();
		ipcRenderer.send('notes:flushed');
	} catch {
		ipcRenderer.send('notes:flush-failed');
	} finally {
		flushInProgress = false;
	}
});

contextBridge.exposeInMainWorld('desktop', {
	minimize: () => ipcRenderer.send('window:minimize'),
	close: () => ipcRenderer.send('window:close'),
	hide: () => ipcRenderer.invoke('window:hide'),
	getCursorPosition: () => ipcRenderer.invoke('window:cursor-position'),
	moveNote: (position) => ipcRenderer.invoke('window:move-note', position),
	ready: () => ipcRenderer.invoke('window:ready'),
	togglePin: () => ipcRenderer.invoke('window:pin'),
	toggleCompact: () => ipcRenderer.invoke('window:compact'),
	openNotebook: () => ipcRenderer.invoke('window:open-notebook'),
	onModeChanged: (callback) => {
		if (typeof callback !== 'function') throw new TypeError('模式回调必须为函数。');
		modeCallbacks.add(callback);
		if (currentMode !== null) callback(currentMode);
		return () => modeCallbacks.delete(callback);
	},
	setHitRegions: (regions) => ipcRenderer.send('window:hit-regions', regions),
	setInteracting: (active) => ipcRenderer.send('window:interacting', active),
	beginPeel: (stageRect) => ipcRenderer.invoke('window:begin-peel', stageRect),
	preparePeel: (stageRect) => ipcRenderer.invoke('window:prepare-peel', stageRect),
	activatePeel: () => ipcRenderer.invoke('window:activate-peel'),
	prepareEndPeel: () => ipcRenderer.invoke('window:prepare-end-peel'),
	endPeel: () => ipcRenderer.invoke('window:end-peel'),
	load: () => ipcRenderer.invoke('notes:load'),
	getContext: () => ipcRenderer.invoke('notes:context'),
	dispatch: (action) => ipcRenderer.invoke('notes:dispatch', action),
	showNote: (id) => ipcRenderer.invoke('notes:show', id),
	onStateChanged: (callback) => {
		if (typeof callback !== 'function') throw new TypeError('状态回调必须为函数。');
		const listener = (_event, state) => callback(state);
		ipcRenderer.on('notes:state-changed', listener);
		return () => ipcRenderer.removeListener('notes:state-changed', listener);
	},
	onError: (callback) => {
		if (typeof callback !== 'function') throw new TypeError('错误回调必须为函数。');
		const listener = (_event, message) => callback(message);
		ipcRenderer.on('notes:close-error', listener);
		return () => ipcRenderer.removeListener('notes:close-error', listener);
	},
	save: (data) => ipcRenderer.invoke('notes:save', data),
	onBeforeClose: (callback) => {
		if (typeof callback !== 'function') throw new TypeError('关闭回调必须为函数。');
		beforeClose = callback;
		ipcRenderer.send('notes:flush-ready');
	},
});
