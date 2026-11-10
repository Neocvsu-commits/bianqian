const { app, BrowserWindow, ipcMain, Menu, screen } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');

app.setName('便签');
app.setPath('userData', path.join(app.getPath('appData'), 'SiyeDemo'));
app.setAppUserModelId('local.siye.demo');
const entryPath = path.join(__dirname, '..', 'index.html');
const entryUrl = pathToFileURL(entryPath).href;
const dataPath = path.join(app.getPath('userData'), 'notes.json');
const maxDataBytes = 5 * 1024 * 1024;
const colors = new Set(['butter', 'sage', 'blue', 'rose', 'cream']);
const rangeFields = ['strikes', 'underlines', 'highlights', 'bolds'];
const contexts = new Map();
const noteWindows = new Map();
let mainContext = null, store = null, stateReady = null, loadError = null;
let mutationQueue = Promise.resolve();
let shuttingDown = false, appExiting = false;

function isEntryUrl(value) {
	try { const url = new URL(value); url.search = ''; url.hash = ''; return url.href === entryUrl; }
	catch { return false; }
}
function trusted(event) {
	const ctx = contexts.get(event.sender.id);
	if (!ctx || ctx.win.isDestroyed() || !isEntryUrl(event.senderFrame?.url)) throw new Error('此操作只能由便利贴窗口发起。');
	return ctx;
}
function blankNote(color = 'butter') {
	return { id: randomUUID(), color, title: '', body: '', strikes: [], underlines: [], highlights: [], bolds: [], createdAt: new Date().toISOString() };
}
function initialState() {
	const active = blankNote();
	active.title = '今天的小事';
	active.body = '把想法先记下来。\n\n□ 整理桌面\n□ 留一点时间散步\n□ 试着撕下这一页 ↖';
	return { version: 1, revision: 0, active, archive: [], trash: [], desktop: [], paperQueue: [], settings: { sound: true, pinned: false, randomColors: false, mainWindow: { compact: true, hidden: false } } };
}
function normalizePaperQueue(data) {
	if (!data.settings.randomColors) { data.paperQueue = []; return; }
	const used = new Set(data.active ? [data.active.color] : []);
	const queue = [];
	for (const color of Array.isArray(data.paperQueue) ? data.paperQueue : []) {
		if (!colors.has(color) || used.has(color)) continue;
		queue.push(color); used.add(color);
		if (queue.length === 3) break;
	}
	while (queue.length < 3) {
		const choices = [...colors].filter(color => !used.has(color));
		const color = choices[Math.floor(Math.random() * choices.length)];
		queue.push(color); used.add(color);
	}
	data.paperQueue = queue;
}
function validPosition(value) {
	return value && Number.isFinite(value.x) && Number.isFinite(value.y) && Math.abs(value.x) < 1000000 && Math.abs(value.y) < 1000000;
}
function validRanges(value, length) {
	return Array.isArray(value) && value.every(range => range && Number.isInteger(range.start) && Number.isInteger(range.end) && range.start >= 0 && range.end > range.start && range.end <= length);
}
function validBounds(value) {
	return validPosition(value) && Number.isFinite(value.width) && Number.isFinite(value.height) && value.width > 0 && value.height > 0 && value.width <= 20000 && value.height <= 20000;
}
function validNote(note) {
	return note && typeof note.id === 'string' && note.id.length > 0 && typeof note.title === 'string' && typeof note.body === 'string' && colors.has(note.color) && Number.isFinite(Date.parse(note.createdAt)) && rangeFields.every(field => note[field] === undefined || validRanges(note[field], note.body.length)) && (note.position === undefined || validPosition(note.position));
}
function normalizeData(data) {
	if (!data || data.version !== 1 || (data.active !== null && !validNote(data.active)) || !Array.isArray(data.archive) || !data.archive.every(validNote)) throw new Error('便签数据格式无效。');
	data.trash ??= []; data.desktop ??= []; data.settings = { sound: true, pinned: false, randomColors: false, ...data.settings };
	data.settings.mainWindow = { compact: true, hidden: false, ...data.settings.mainWindow };
	const mainSettings = data.settings.mainWindow;
	if (typeof data.settings.pinned !== 'boolean' || typeof data.settings.randomColors !== 'boolean' || typeof mainSettings.compact !== 'boolean' || typeof mainSettings.hidden !== 'boolean' || (mainSettings.bounds !== undefined && !validBounds(mainSettings.bounds)) || (mainSettings.desktopBounds !== undefined && !validBounds(mainSettings.desktopBounds))) throw new Error('窗口设置格式无效。');
	data.revision ??= 0;
	if (!Number.isSafeInteger(data.revision) || data.revision < 0) throw new Error('便签版本号无效。');
	if (!Array.isArray(data.desktop) || !data.desktop.every(validNote) || !Array.isArray(data.trash) || !data.trash.every(item => item && validNote(item.note) && ['active', 'archive', 'desktop'].includes(item.source))) throw new Error('便签列表格式无效。');
	const notes = [data.active, ...data.archive, ...data.desktop, ...data.trash.map(item => item.note)].filter(Boolean);
	if (new Set(notes.map(note => note.id)).size !== notes.length) throw new Error('便签编号重复，已保留原文件。');
	normalizePaperQueue(data);
	return data;
}
function encodeData(data) {
	const text = JSON.stringify(normalizeData(data));
	if (Buffer.byteLength(text, 'utf8') > maxDataBytes) throw new Error('便签数据已超过 5 MB，请先导出部分历史。');
	return text;
}
async function initializeStore() {
	let previousQueue, restoredMother = false;
	try {
		if ((await fs.stat(dataPath)).size > maxDataBytes) throw new Error('too-large');
		const loaded = JSON.parse(await fs.readFile(dataPath, 'utf8'));
		previousQueue = JSON.stringify(loaded.paperQueue);
		store = normalizeData(loaded);
		if (!store.active) {
			ensurePaperPool(store, 'butter', true);
			restoredMother = true;
		}
	} catch (error) {
		store = initialState();
		if (error.code !== 'ENOENT') loadError = '原便签数据无法读取，已保留原文件并暂停保存。请先导出当前内容。';
		return;
	}
	// Persist repaired mother pages and preview colors once when loading older data.
	if (restoredMother || previousQueue !== JSON.stringify(store.paperQueue)) {
		try {
			const migrated = structuredClone(store); migrated.revision += 1;
			await atomicWrite(migrated); store = migrated;
		} catch {
			loadError = '便签已读取，但母页或纸色更新无法保存，已暂停修改。请先导出便签并检查文件权限。';
		}
	}
}
async function atomicWrite(data) {
	const text = encodeData(data); await fs.mkdir(path.dirname(dataPath), { recursive: true });
	const temporaryPath = dataPath + '.tmp'; const file = await fs.open(temporaryPath, 'w');
	try { await file.writeFile(text, 'utf8'); await file.sync(); } finally { await file.close(); }
	await fs.rename(temporaryPath, dataPath);
}
function broadcast() {
	for (const ctx of contexts.values()) if (!ctx.win.isDestroyed()) ctx.win.webContents.send('notes:state-changed', store);
}
function mutate(operation, afterCommit) {
	const pending = mutationQueue.catch(() => {}).then(async () => {
		await stateReady;
		if (loadError) throw new Error(loadError);
		const next = structuredClone(store);
		if (operation(next) === false) return structuredClone(store);
		next.revision = store.revision + 1;
		await atomicWrite(next); store = next; syncWindowPresentation(); broadcast();
		if (afterCommit) afterCommit();
		return structuredClone(store);
	});
	mutationQueue = pending; return pending;
}
function locate(data, id) {
	if (data.active?.id === id) return { source: 'active', note: data.active, index: 0 };
	for (const source of ['archive', 'desktop']) {
		const index = data[source].findIndex(note => note.id === id);
		if (index >= 0) return { source, note: data[source][index], index };
	}
	throw new Error('便签已被移动或删除，请刷新后重试。');
}
function removeLocated(data, found) {
	if (found.source === 'active') data.active = null;
	else data[found.source].splice(found.index, 1);
}
function hasContent(note) { return Boolean(note && (note.title.trim() || note.body.trim())); }
function blankFor(data, fixedColor = 'butter') {
	normalizePaperQueue(data);
	return blankNote(data.settings.randomColors ? data.paperQueue.shift() : fixedColor);
}
function ensurePaperPool(data, color = 'butter', renewMother = false) {
	if (!data.active && (renewMother || data.desktop.length === 0)) { data.active = blankFor(data, color); data.settings.mainWindow.hidden = false; }
	else if (!data.active && data.settings.mainWindow.compact) data.settings.mainWindow.hidden = true;
	normalizePaperQueue(data);
}
function toActive(data, note) {
	if (hasContent(data.active)) data.archive.push({ ...data.active, tornAt: new Date().toISOString() });
	data.active = { ...note }; delete data.active.tornAt; delete data.active.position; delete data.active.hidden;
	data.settings.mainWindow.hidden = false;
	normalizePaperQueue(data);
}
function reduceAction(data, action, ctx) {
	if (!action || typeof action.type !== 'string') throw new Error('便签操作无效。');
	if (action.type === 'setSettings') {
		if (!action.changes || Object.keys(action.changes).some(key => !['sound', 'pinned', 'randomColors'].includes(key) || typeof action.changes[key] !== 'boolean')) throw new Error('偏好设置无效。');
		Object.assign(data.settings, action.changes); normalizePaperQueue(data); return;
	}
	if (action.type === 'createNote') {
		if (!data.active) { data.active = blankFor(data); data.settings.mainWindow.hidden = false; }
		else {
			const bounds = ctx.compact ? ctx.desktopBounds : ctx.win.getBounds();
			data.desktop.push({ ...blankFor(data, data.active.color), position: { x: bounds.x + 42, y: bounds.y + 28 }, hidden: false });
		}
		normalizePaperQueue(data); return;
	}
	if (action.type === 'purgeTrash') { data.trash = []; return; }
	if (typeof action.id !== 'string') throw new Error('缺少便签编号。');
	if (action.type === 'restoreTrash') {
		const index = data.trash.findIndex(item => item.note.id === action.id);
		if (index < 0) throw new Error('最近删除中已没有这张便签。');
		const [item] = data.trash.splice(index, 1);
		if (item.source === 'active') toActive(data, item.note);
		else { const list = data[item.source]; if (item.source === 'desktop') item.note.hidden = false; list.splice(Number.isInteger(item.index) ? Math.max(0, Math.min(item.index, list.length)) : list.length, 0, item.note); }
		return;
	}
	const found = locate(data, action.id);
	switch (action.type) {
		case 'randomizePaper': {
			if (!['active', 'desktop'].includes(found.source)) throw new Error('请先把归档便签放回桌面再随机配色。');
			const previousQueue = JSON.stringify(data.paperQueue);
			const choices = [...colors].filter(color => color !== found.note.color);
			found.note.color = choices[Math.floor(Math.random() * choices.length)];
			data.settings.randomColors = true;
			if (found.source === 'active') data.paperQueue = [];
			normalizePaperQueue(data);
			// A deliberate reroll must visibly change the mother's preview stack,
			// even when the random draw happened to reproduce its prior order.
			if (found.source === 'active' && JSON.stringify(data.paperQueue) === previousQueue) {
				[data.paperQueue[0], data.paperQueue[1]] = [data.paperQueue[1], data.paperQueue[0]];
			}
			return;
		}
		case 'patchNote': {
			const changes = action.changes;
			if (!changes || typeof changes !== 'object' || Array.isArray(changes) || Object.keys(changes).some(key => !['title', 'body', 'color', ...rangeFields].includes(key))) throw new Error('便签字段无效。');
			for (const key of ['title', 'body']) if (key in changes) { if (typeof changes[key] !== 'string') throw new Error('便签文字格式无效。'); found.note[key] = changes[key]; }
			if ('color' in changes) { if (!colors.has(changes.color)) throw new Error('纸张颜色无效。'); found.note.color = changes.color; }
			for (const field of rangeFields) {
				if (field in changes) {
					if (!validRanges(changes[field], found.note.body.length)) throw new Error('文字标记范围无效。');
					found.note[field] = changes[field].map(({ start, end }) => ({ start, end }));
				} else if ('body' in changes && found.note[field]) {
					found.note[field] = found.note[field].map(range => ({ start: range.start, end: Math.min(range.end, found.note.body.length) })).filter(range => range.start < range.end);
				}
			}
			if (found.source === 'active' && 'color' in changes) normalizePaperQueue(data);
			return;
		}
		case 'archiveNote':
			if (found.source === 'archive') return false;
			removeLocated(data, found); data.archive.push({ ...found.note, tornAt: new Date().toISOString() }); ensurePaperPool(data, found.note.color, found.source === 'active'); return;
		case 'deleteNote':
			removeLocated(data, found); data.trash.push({ note: found.note, source: found.source, index: found.index, deletedAt: new Date().toISOString() }); ensurePaperPool(data, found.note.color, found.source === 'active'); return;
		case 'detachNote': {
			if (!['active', 'archive'].includes(found.source)) throw new Error('普通桌面便签不能再撕出，请拖动胶条移动它。');
			if (action.position !== undefined && !validPosition(action.position)) throw new Error('桌面位置无效。');
			const sourceBounds = ctx.compact ? ctx.desktopBounds : ctx.win.getBounds();
			const position = action.position || found.note.position || { x: sourceBounds.x + 42, y: sourceBounds.y + 28 };
			removeLocated(data, found); data.desktop.push(found.note);
			if (found.source === 'active') { data.active = blankFor(data, found.note.color); data.settings.mainWindow.hidden = false; }
			found.note.position = { x: Math.round(position.x), y: Math.round(position.y) }; found.note.hidden = false; delete found.note.tornAt;
			normalizePaperQueue(data); return;
		}
		case 'restoreArchive':
			if (found.source !== 'archive') throw new Error('这张便签不在归档中。');
			removeLocated(data, found); toActive(data, found.note); return;
		default: throw new Error('未知便签操作。');
	}
}

ipcMain.handle('notes:load', async event => { trusted(event); await stateReady; await mutationQueue.catch(() => {}); return { data: structuredClone(store), ...(loadError ? { error: loadError } : {}) }; });
ipcMain.handle('notes:context', event => { const ctx = trusted(event); return { noteId: ctx.noteId, ...windowMode(ctx) }; });
ipcMain.handle('notes:dispatch', async (event, action) => {
	const ctx = trusted(event);
	await stateReady;
	if (action && ['archiveNote', 'deleteNote'].includes(action.type)) {
		const child = noteWindows.get(action.id);
		if (child && child !== ctx && !child.win.isDestroyed()) await requestSync(child);
	}
	return mutate(data => reduceAction(data, action, ctx), () => {
		if (action.type === 'createNote') {
			for (const note of store.desktop) if (!noteWindows.has(note.id) && !note.hidden) showNote(note.id);
			if (store.active && mainContext && !mainContext.hidden) revealWindow(mainContext, true);
		}
		if (action.type === 'detachNote') showNote(action.id, true);
		if (action.type === 'restoreTrash' && store.desktop.some(note => note.id === action.id)) showNote(action.id);
		setImmediate(() => { for (const child of noteWindows.values()) if (!store.desktop.some(note => note.id === child.noteId)) destroyContext(child); });
	});
});
ipcMain.handle('notes:save', (event, data) => {
	if (trusted(event).noteId !== null) throw new Error('独立便签请使用操作接口保存。');
	return mutate(next => { if (next.desktop.length) throw new Error('多窗口模式请使用操作接口保存。'); Object.assign(next, normalizeData(data)); });
});
ipcMain.handle('notes:show', async (event, id) => {
	trusted(event);
	await mutate(data => { const note = data.desktop.find(item => item.id === id); if (!note) throw new Error('桌面便签已被移动或删除。'); note.hidden = false; }, () => showNote(id));
});

function updateMousePassthrough(ctx) {
	const win = ctx.win;
	if (win.isDestroyed() || win.isMinimized() || !win.isVisible()) return;
	let ignore = false;
	if (ctx.compact && !ctx.interacting) {
		const pointer = screen.getCursorScreenPoint(); const bounds = win.getBounds(); const x = pointer.x - bounds.x; const y = pointer.y - bounds.y;
		ignore = !ctx.hitRegions.some(region => x >= region.x && y >= region.y && x < region.x + region.width && y < region.y + region.height);
	}
	if (ignore !== ctx.ignoringMouse) { win.setIgnoreMouseEvents(ignore, { forward: true }); ctx.ignoringMouse = ignore; }
}
ipcMain.on('window:minimize', event => trusted(event).win.minimize());
ipcMain.on('window:close', event => trusted(event).win.close());
ipcMain.on('window:hit-regions', (event, regions) => {
	const ctx = trusted(event);
	if (!Array.isArray(regions) || regions.length > 64 || !regions.every(region => region && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(region[key]) && Math.abs(region[key]) <= 10000) && region.width > 0 && region.height > 0)) return;
	ctx.hitRegions = regions.map(({ x, y, width, height }) => ({ x, y, width, height })); updateMousePassthrough(ctx);
});
ipcMain.on('window:interacting', (event, active) => { const ctx = trusted(event); ctx.interacting = active === true; updateMousePassthrough(ctx); });
function setWindowBounds(ctx, bounds) { ctx.ignorePositionUntil = Date.now() + 400; ctx.win.setBounds(bounds); }
function saveWindowState(ctx, options = {}) {
	if (ctx.win.isDestroyed()) return Promise.resolve();
	// Compact native bounds are a screen-sized canvas, never a note position.
	const bounds = ctx.compact ? ctx.desktopBounds : (options.bounds || (ctx.noteId === null ? ctx.win.getBounds() : ctx.desktopBounds));
	if (!bounds) return Promise.resolve();
	const saved = { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) };
	const compact = ctx.compact;
	const logicalSnapshot = { ...ctx.desktopBounds };
	return mutate(data => {
		if (ctx.noteId === null) {
			const old = data.settings.mainWindow;
			const next = { ...old, bounds: saved, desktopBounds: logicalSnapshot, compact, ...(typeof options.hidden === 'boolean' ? { hidden: options.hidden } : {}) };
			if (!data.active && compact) next.hidden = true;
			if (JSON.stringify(old) === JSON.stringify(next)) return false;
			data.settings.mainWindow = next;
		} else {
			const note = data.desktop.find(item => item.id === ctx.noteId); if (!note) return false;
			const hidden = typeof options.hidden === 'boolean' ? options.hidden : Boolean(note.hidden);
			if (note.position?.x === saved.x && note.position?.y === saved.y && Boolean(note.hidden) === hidden) return false;
			note.position = { x: saved.x, y: saved.y }; note.hidden = hidden;
		}
	});
}
function positionError(ctx) { if (!ctx.win.isDestroyed()) ctx.win.webContents.send('notes:close-error', '位置保存失败，请先导出便签。'); }
// Compatibility endpoints: a peel never moves or resizes a native window.
ipcMain.handle('window:prepare-peel', event => { trusted(event); return null; });
ipcMain.handle('window:activate-peel', event => { trusted(event); });
ipcMain.handle('window:begin-peel', event => { trusted(event); return null; });
ipcMain.handle('window:prepare-end-peel', event => { trusted(event); return null; });
function restorePeelWindow(ctx) {
	ctx.peelExpansion = null; ctx.interacting = false; updateMousePassthrough(ctx);
}
ipcMain.handle('window:end-peel', event => restorePeelWindow(trusted(event)));
ipcMain.handle('window:pin', async event => { trusted(event); const next = await mutate(data => { data.settings.pinned = !data.settings.pinned; }); return next.settings.pinned; });
ipcMain.handle('window:cursor-position', event => { trusted(event); return screen.getCursorScreenPoint(); });
function fitBounds(bounds) {
	const area = screen.getDisplayMatching(bounds).workArea;
	return { ...bounds, x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - bounds.width)), y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - bounds.height)) };
}
function fitPaperBounds(bounds) {
	const center = { x: Math.round(bounds.x + 320), y: Math.round(bounds.y + 335) };
	const area = screen.getDisplayNearestPoint(center).workArea;
	return { ...bounds, x: Math.max(area.x - 70, Math.min(bounds.x, area.x + area.width - 500)), y: Math.max(area.y - 140, Math.min(bounds.y, area.y + area.height - 530)) };
}
function canvasBoundsFor(logical) {
	return screen.getDisplayNearestPoint({ x: Math.round(logical.x + 320), y: Math.round(logical.y + 335) }).workArea;
}
function windowMode(ctx) {
	if (!ctx.compact) return { compact: false, layout: null };
	const canvas = ctx.win.getBounds(), logical = ctx.desktopBounds;
	return { compact: true, layout: { paperX: logical.x + 140 - canvas.x, paperY: logical.y + 140 - canvas.y, viewportWidth: canvas.width, viewportHeight: canvas.height } };
}
function updateDesktopBounds(ctx, position) {
	ctx.desktopBounds = fitPaperBounds({ x: Math.round(position.x), y: Math.round(position.y), width: 640, height: 670 });
	const canvas = canvasBoundsFor(ctx.desktopBounds), current = ctx.win.getBounds();
	// Same-screen moves update only logical paper coordinates.
	if (['x', 'y', 'width', 'height'].some(key => canvas[key] !== current[key])) setWindowBounds(ctx, canvas);
	return windowMode(ctx);
}
function setCompact(ctx, compact) {
	if (ctx.compact === compact) return windowMode(ctx);
	clearTimeout(ctx.moveTimer);
	const win = ctx.win; restorePeelWindow(ctx);
	if (compact) {
		if (win.isMaximized()) win.unmaximize(); ctx.normalBounds = win.getBounds(); win.setMinimumSize(1, 1);
		ctx.compact = true;
		updateDesktopBounds(ctx, ctx.desktopBounds || { x: ctx.normalBounds.x + 210, y: ctx.normalBounds.y + 55 });
		win.setResizable(false); win.setBackgroundColor('#00000000');
	} else {
		ctx.compact = false; win.setResizable(true); win.setMinimumSize(880, 680);
		setWindowBounds(ctx, fitBounds(ctx.normalBounds || { x: ctx.desktopBounds.x - 210, y: ctx.desktopBounds.y - 55, width: 1060, height: 780 }));
		win.setBackgroundColor('#f4f2ed');
	}
	ctx.compact = compact; ctx.interacting = false; updateMousePassthrough(ctx);
	const mode = windowMode(ctx); win.webContents.send('window:mode-changed', mode);
	return mode;
}
ipcMain.handle('window:compact', async event => { const ctx = trusted(event); const mode = setCompact(ctx, !ctx.compact); await saveWindowState(ctx); return mode; });
ipcMain.handle('window:move-note', async (event, position) => {
	const ctx = trusted(event);
	if (!ctx.compact || !validPosition(position)) throw new Error('只能移动桌面便签，且位置必须有效。');
	if (shuttingDown || appExiting) throw new Error('便签本正在关闭。');
	clearTimeout(ctx.moveTimer);
	const previous = { ...ctx.desktopBounds };
	try {
		const mode = updateDesktopBounds(ctx, position);
		ctx.win.webContents.send('window:mode-changed', mode);
		await saveWindowState(ctx);
		return mode;
	} catch (error) {
		ctx.win.webContents.send('window:mode-changed', updateDesktopBounds(ctx, previous));
		throw error;
	}
});
async function openMother(notebook = true) {
	await stateReady;
	if (shuttingDown || appExiting) throw new Error('便签本正在关闭。');
	const newlyCreated = !mainContext || mainContext.win.isDestroyed();
	const ctx = newlyCreated ? createWindow() : mainContext;
	ctx.taskbarFallback = false;
	if (notebook || !store.active) setCompact(ctx, false);
	await saveWindowState(ctx, { hidden: false });
	revealWindow(ctx, true);
}
ipcMain.handle('window:open-notebook', async event => { trusted(event); await openMother(true); });

function requestFlush(ctx) {
	if (ctx.win.isDestroyed() || !ctx.flushReady) return Promise.resolve();
	if (ctx.flushRequest) return ctx.flushRequest.promise;
	let resolve, reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	ctx.flushRequest = { promise, resolve, reject }; ctx.win.webContents.send('notes:flush'); return promise;
}
function finishSync(ctx, requestId, error) {
	const pending = ctx.syncRequest;
	if (!pending || pending.id !== requestId) return;
	clearTimeout(pending.timer); ctx.syncRequest = null;
	if (error) pending.reject(new Error(error));
	else pending.resolve();
}
function requestSync(ctx) {
	if (ctx.win.isDestroyed()) return Promise.reject(new Error('便签窗口已关闭，请重试。'));
	if (!ctx.flushReady) return Promise.reject(new Error('便签仍在加载，请稍后重试。'));
	if (ctx.syncRequest) return ctx.syncRequest.promise;
	const id = randomUUID();
	let resolve, reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	const timer = setTimeout(() => finishSync(ctx, id, '便签同步超时，本次操作已取消，请稍后重试。'), 8000);
	ctx.syncRequest = { id, promise, resolve, reject, timer };
	ctx.win.webContents.send('notes:sync-request', id);
	return promise;
}
ipcMain.on('notes:flush-ready', event => { trusted(event).flushReady = true; });
ipcMain.on('notes:flushed', event => { const ctx = trusted(event); ctx.flushRequest?.resolve(); ctx.flushRequest = null; });
ipcMain.on('notes:flush-failed', event => { const ctx = trusted(event); ctx.flushRequest?.reject(new Error('保存失败，窗口已保留，请先导出便签。')); ctx.flushRequest = null; });
ipcMain.on('notes:sync-complete', (event, id) => finishSync(trusted(event), id));
ipcMain.on('notes:sync-error', (event, id) => finishSync(trusted(event), id, '便签同步失败，本次操作已取消，请先导出便签。'));
function destroyContext(ctx) { clearTimeout(ctx.moveTimer); if (!ctx.win.isDestroyed()) { restorePeelWindow(ctx); ctx.win.destroy(); } }
async function closeMain() {
	if (shuttingDown || appExiting) return;
	shuttingDown = true; const targets = [...contexts.values()];
	try {
		const flushed = await Promise.allSettled(targets.map(requestFlush)); const failed = flushed.find(result => result.status === 'rejected');
		if (failed) throw failed.reason;
		await Promise.all(targets.filter(ctx => !ctx.win.isDestroyed()).map(ctx => { clearTimeout(ctx.moveTimer); return saveWindowState(ctx, { hidden: ctx.hidden }); }));
		await mutationQueue; appExiting = true;
		for (const ctx of [...contexts.values()]) destroyContext(ctx);
		app.quit();
	} catch (error) {
		shuttingDown = false;
		for (const ctx of contexts.values()) ctx.win.webContents.send('notes:close-error', error.message || '保存失败，请先导出便签。');
	}
}
function hideWindow(ctx) {
	if (ctx.hidePromise) return ctx.hidePromise;
	if (shuttingDown) return Promise.reject(new Error('便签本正在关闭。'));
	ctx.hidePromise = (async () => {
		await requestFlush(ctx); clearTimeout(ctx.moveTimer); restorePeelWindow(ctx);
		await saveWindowState(ctx, { hidden: true });
	})().finally(() => { ctx.hidePromise = null; });
	return ctx.hidePromise;
}
ipcMain.handle('window:hide', event => hideWindow(trusted(event)));
function ensureMotherReachable() {
	const ctx = mainContext;
	if (!ctx?.ready || ctx.win.isDestroyed() || shuttingDown || appExiting || [...contexts.values()].some(item => !item.hidden && (item.noteId === null || store.desktop.some(note => note.id === item.noteId)))) return;
	if (!ctx.taskbarFallback) { ctx.taskbarFallback = true; ctx.hasEverShown = true; ctx.win.showInactive(); ctx.win.minimize(); }
}
function revealWindow(ctx, focus = false) {
	if (focus) ctx.wantFocus = true;
	if (!ctx.ready || ctx.hidden || ctx.win.isDestroyed() || shuttingDown) return;
	ctx.taskbarFallback = false; ctx.hasEverShown = true;
	if (ctx.win.isMinimized()) ctx.win.restore();
	ctx.win.show();
	if (ctx.wantFocus) { ctx.win.focus(); ctx.wantFocus = false; }
}
function finishWindowReady(ctx) {
	if (!ctx.nativeReady || !ctx.rendererReady || ctx.ready || ctx.win.isDestroyed()) return;
	ctx.ready = true;
	syncWindowPresentation();
	ctx.win.webContents.send('window:mode-changed', windowMode(ctx));
	updateMousePassthrough(ctx);
}
ipcMain.handle('window:ready', event => { const ctx = trusted(event); ctx.rendererReady = true; finishWindowReady(ctx); });
function syncWindowPresentation() {
	if (!store) return;
	for (const ctx of contexts.values()) {
		if (ctx.win.isDestroyed()) continue;
		if (ctx.win.isAlwaysOnTop() !== store.settings.pinned) ctx.win.setAlwaysOnTop(store.settings.pinned);
		const note = ctx.noteId === null ? null : store.desktop.find(item => item.id === ctx.noteId);
		if (ctx.noteId !== null && !note) continue;
		const wasHidden = ctx.hidden;
		ctx.hidden = ctx.noteId === null ? Boolean(store.settings.mainWindow.hidden || (!store.active && ctx.compact)) : Boolean(note.hidden);
		if (!ctx.ready) continue;
		if (ctx.hidden) { if (!ctx.taskbarFallback) ctx.win.hide(); }
		else if (wasHidden || !ctx.hasEverShown || ctx.wantFocus) revealWindow(ctx);
	}
	ensureMotherReachable();
}
function showNote(id, moveToSaved = false) {
	if (shuttingDown) return;
	const note = store.desktop.find(item => item.id === id);
	if (!note) throw new Error('桌面便签已被移动或删除。');
	let ctx = noteWindows.get(id);
	if (!ctx || ctx.win.isDestroyed()) ctx = createWindow(id, note.position);
	else {
		if (moveToSaved && note.position && ctx.compact) { const mode = updateDesktopBounds(ctx, note.position); ctx.win.webContents.send('window:mode-changed', mode); }
		if (!note.hidden) { ctx.hidden = false; revealWindow(ctx, true); }
	}
	return ctx;
}
function checkNoteLifecycleInMemory() {
	const assert = (condition, message) => { if (!condition) throw new Error(`便签生命周期检查失败：${message}`); };
	const fixture = initialState();
	const fixtureContext = { peelExpansion: null, win: { getBounds: () => ({ x: 100, y: 100, width: 640, height: 670 }) } };
	const archivedId = fixture.active.id;
	const first = blankNote('sage'), second = blankNote('blue');
	fixture.desktop = [first, second];
	const count = () => (fixture.active ? 1 : 0) + fixture.desktop.length;
	reduceAction(fixture, { type: 'archiveNote', id: archivedId }, fixtureContext);
	assert(fixture.active && fixture.active.id !== archivedId && fixture.active.title === '' && fixture.active.body === '' && count() === 3 && !fixture.settings.mainWindow.hidden, '归档母页后必须续空白新页，保留两张桌面便签');
	const renewedId = fixture.active.id;
	reduceAction(fixture, { type: 'deleteNote', id: first.id }, fixtureContext);
	assert(fixture.active.id === renewedId && count() === 2, '删除普通便签只应消耗自身，母页不能被替换');
	reduceAction(fixture, { type: 'deleteNote', id: second.id }, fixtureContext);
	assert(fixture.active.id === renewedId && fixture.desktop.length === 0 && count() === 1, '删除最后一张普通便签应保留原母页');
	reduceAction(fixture, { type: 'deleteNote', id: renewedId }, fixtureContext);
	assert(fixture.active && fixture.active.id !== renewedId && fixture.active.body === '' && count() === 1 && fixture.trash.some(item => item.note.id === renewedId), '删除母页后必须续空白新页，原纸进入最近删除');
	reduceAction(fixture, { type: 'detachNote', id: archivedId, position: { x: 240, y: 180 } }, fixtureContext);
	const allIds = [fixture.active, ...fixture.desktop, ...fixture.archive, ...fixture.trash.map(item => item.note)].filter(Boolean).map(note => note.id);
	assert(fixture.desktop.filter(note => note.id === archivedId).length === 1 && !fixture.archive.some(note => note.id === archivedId) && new Set(allIds).size === allIds.length, '归档拖回桌面应移动原便签且不重复编号');
	assert(typeof fixture.settings.pinned === 'boolean', '全局置顶状态应为布尔值');
	reduceAction(fixture, { type: 'setSettings', changes: { randomColors: true } }, fixtureContext);
	const previousColor = fixture.active.color;
	reduceAction(fixture, { type: 'createNote' }, fixtureContext);
	assert(colors.has(fixture.desktop.at(-1).color) && fixture.desktop.at(-1).color !== previousColor, '随机新纸应选有效颜色并避开上一张');
	const queued = initialState();
	reduceAction(queued, { type: 'setSettings', changes: { randomColors: true } }, fixtureContext);
	const visibleColors = data => [data.active.color, ...data.paperQueue];
	assert(queued.paperQueue.length === 3 && new Set(visibleColors(queued)).size === 4, '当前页与三层预告纸色必须互不重复');
	for (let attempt = 0; attempt < 3; attempt++) {
		const beforeColor = queued.active.color, beforeQueue = JSON.stringify(queued.paperQueue);
		reduceAction(queued, { type: 'randomizePaper', id: queued.active.id }, fixtureContext);
		assert(queued.settings.randomColors === true && colors.has(queued.active.color) && queued.active.color !== beforeColor, '连续点击骰子应始终保持随机模式且每次更换当前纸色');
		assert(queued.paperQueue.length === 3 && new Set(visibleColors(queued)).size === 4 && JSON.stringify(queued.paperQueue) !== beforeQueue, '母便签重新配色应更新三层队列且四种可见纸色互异');
	}
	const tornId = queued.active.id, tornColor = queued.active.color, predictedColor = queued.paperQueue[0];
	reduceAction(queued, { type: 'detachNote', id: tornId }, fixtureContext);
	assert(queued.active.color === predictedColor, '下一张母页必须使用先前预告的第一种颜色');
	assert(queued.desktop.find(note => note.id === tornId)?.color === tornColor, '撕出的便签必须保留原纸色');
	assert(queued.paperQueue.length === 3 && new Set(visibleColors(queued)).size === 4, '消费队列后必须补齐且保持四层纸色不同');
	for (const action of ['archiveNote', 'deleteNote']) {
		const oldId = queued.active.id, nextColor = queued.paperQueue[0], children = JSON.stringify(queued.desktop);
		reduceAction(queued, { type: action, id: oldId }, fixtureContext);
		assert(queued.active.id !== oldId && queued.active.title === '' && queued.active.body === '' && queued.active.color === nextColor && new Set(visibleColors(queued)).size === 4 && JSON.stringify(queued.desktop) === children, '母页归档或删除必须接续预告纸色，且不影响普通便签');
	}
	const reloaded = normalizeData(structuredClone(queued));
	assert(JSON.stringify(reloaded.paperQueue) === JSON.stringify(queued.paperQueue) && reloaded.active.color === queued.active.color, '重新加载不能改变已预告的纸色');
	const motherColor = queued.active.color, motherQueue = JSON.stringify(queued.paperQueue);
	reduceAction(queued, { type: 'randomizePaper', id: tornId }, fixtureContext);
	assert(queued.settings.randomColors === true && queued.desktop.find(note => note.id === tornId)?.color !== tornColor && queued.active.color === motherColor && JSON.stringify(queued.paperQueue) === motherQueue, '子便签点击骰子只改该纸颜色，不重配母便签及其合法队列');
	const formatted = initialState();
	const formatting = { body: '○ 写😀字\n● 完成', strikes: [{ start: 7, end: 11 }], underlines: [{ start: 2, end: 6 }], highlights: [{ start: 0, end: 6 }], bolds: [{ start: 2, end: 5 }] };
	reduceAction(formatted, { type: 'patchNote', id: formatted.active.id, changes: formatting }, fixtureContext);
	const formattedReloaded = normalizeData(JSON.parse(encodeData(formatted)));
	assert(formattedReloaded.active.body === formatting.body && rangeFields.every(field => JSON.stringify(formattedReloaded.active[field]) === JSON.stringify(formatting[field])), '四种文字标记及待办正文应在保存重载后保持 UTF-16 范围');
	const legacy = initialState();
	legacy.active.strikes = [{ start: 0, end: 2 }];
	for (const field of ['underlines', 'highlights', 'bolds']) delete legacy.active[field];
	const legacyReloaded = normalizeData(legacy);
	assert(JSON.stringify(legacyReloaded.active.strikes) === JSON.stringify([{ start: 0, end: 2 }]) && ['underlines', 'highlights', 'bolds'].every(field => legacyReloaded.active[field] === undefined), '只有旧 strikes 字段的便签应保持兼容');
	legacyReloaded.active = null; legacyReloaded.desktop = [blankNote('sage')]; legacyReloaded.settings.mainWindow.hidden = true;
	ensurePaperPool(legacyReloaded, 'butter', true);
	assert(legacyReloaded.active?.body === '' && legacyReloaded.desktop.length === 1 && !legacyReloaded.settings.mainWindow.hidden, '旧版缺失母页应补回并显示，已有普通便签保持不变');
	return true;
}
function createWindow(noteId = null, position) {
	const mainSettings = store.settings.mainWindow;
	const compact = noteId !== null || mainSettings.compact;
	const saved = noteId === null ? mainSettings.bounds : position;
	const primary = screen.getPrimaryDisplay().workArea;
	const logicalSaved = noteId === null && validBounds(mainSettings.desktopBounds) ? mainSettings.desktopBounds : null;
	const logicalPosition = logicalSaved ? { x: Math.round(logicalSaved.x), y: Math.round(logicalSaved.y) } : validPosition(saved) ? { x: Math.round(saved.x) + (compact ? 0 : 210), y: Math.round(saved.y) + (compact ? 0 : 55) } : { x: Math.round(primary.x + (primary.width - 640) / 2), y: Math.round(primary.y + (primary.height - 670) / 2) };
	const desktopBounds = fitPaperBounds({ ...logicalPosition, width: 640, height: 670 });
	const normalSize = { width: Math.max(880, Math.round(saved?.width || 1060)), height: Math.max(680, Math.round(saved?.height || 780)) };
	const bounds = compact ? canvasBoundsFor(desktopBounds) : validPosition(saved) ? fitBounds({ x: Math.round(saved.x), y: Math.round(saved.y), ...normalSize }) : normalSize;
	const hidden = noteId === null ? Boolean(mainSettings.hidden || (!store.active && compact)) : Boolean(store.desktop.find(note => note.id === noteId)?.hidden);
	const win = new BrowserWindow({
		...bounds, minWidth: compact ? 1 : 880, minHeight: compact ? 1 : 680, title: '便签', icon: path.join(__dirname, '..', 'assets', 'icon.ico'), frame: false, transparent: true, hasShadow: false, resizable: !compact, show: false, alwaysOnTop: store.settings.pinned, backgroundColor: compact ? '#00000000' : '#f4f2ed',
		webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
	});
	const ctx = { win, noteId, compact, hidden, ready: false, nativeReady: false, rendererReady: false, wantFocus: false, hasEverShown: false, taskbarFallback: false, hidePromise: null, normalBounds: compact ? null : win.getBounds(), desktopBounds, hitRegions: [], interacting: false, ignoringMouse: false, hitTimer: null, peelExpansion: null, flushReady: false, flushRequest: null, syncRequest: null, moveTimer: null, ignorePositionUntil: Date.now() + 500 };
	const layout = windowMode(ctx).layout;
	if (layout) ctx.hitRegions = [{ x: layout.paperX, y: layout.paperY, width: 360, height: 390 }];
	contexts.set(win.webContents.id, ctx); if (noteId === null) mainContext = ctx; else noteWindows.set(noteId, ctx);
	win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
	win.webContents.on('will-navigate', (event, url) => { if (!isEntryUrl(url)) event.preventDefault(); });
	win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
	win.once('ready-to-show', () => { ctx.nativeReady = true; finishWindowReady(ctx); });
	ctx.hitTimer = setInterval(() => updateMousePassthrough(ctx), 32);
	win.on('blur', () => { ctx.interacting = false; updateMousePassthrough(ctx); });
	const rememberBounds = () => {
		if (ctx.compact || noteId !== null || Date.now() < ctx.ignorePositionUntil) return;
		clearTimeout(ctx.moveTimer); const current = win.getBounds();
		ctx.moveTimer = setTimeout(() => { void saveWindowState(ctx, { bounds: current }).catch(() => positionError(ctx)); }, 250);
	};
	win.on('moved', rememberBounds); win.on('resized', rememberBounds);
	win.on('restore', () => { if (ctx.taskbarFallback && noteId === null) { ctx.taskbarFallback = false; void openMother(false).catch(() => positionError(ctx)); } });
	win.on('close', event => { event.preventDefault(); if (noteId === null) void closeMain(); else void hideWindow(ctx).catch(error => { if (!win.isDestroyed()) win.webContents.send('notes:close-error', error.message); }); });
	if (process.argv.includes('--smoke-check') && noteId === null) {
		win.webContents.once('did-finish-load', async () => {
			let noteLifecycle = false;
			try {
				noteLifecycle = checkNoteLifecycleInMemory();
				const originalCanvasBounds = JSON.stringify(win.getBounds());
				const result = await win.webContents.executeJavaScript(`(async () => {
					const ready = Boolean(window.siyeReady && typeof window.siyeReady.then === 'function'); if (ready) await window.siyeReady;
					const canvas = document.querySelector('#paper-canvas');
					const context = await window.desktop.getContext();
					const paperRect = document.querySelector(document.body.classList.contains('no-active') ? '#empty-active' : '.paper-stage').getBoundingClientRect();
					const desktopLayout = !context.compact || (Math.abs(paperRect.x - context.layout.paperX) < .1 && Math.abs(paperRect.y - context.layout.paperY) < .1);
					if (!desktopLayout) throw new Error('桌面纸张与固定画布坐标不一致');
					const actions = [...document.querySelectorAll('.note-actions button')].filter(button => !button.hidden && getComputedStyle(button).display !== 'none').map(button => button.id);
					const expectedActions = context.noteId ? ['archive-current','delete-current'] : ['archive-current','delete-current','new-note'];
					const actionRoles = JSON.stringify(actions) === JSON.stringify(expectedActions);
					if (!actionRoles) throw new Error('母便签与普通便签的操作入口不匹配');
					const utility = document.querySelector('.paper-utility').getBoundingClientRect();
					const tools = ['.palette','.format-tools','#undo'].map(selector => document.querySelector(selector));
					const toolbarRow = tools.every(tool => { const rect = tool.getBoundingClientRect(); return rect.left >= utility.left && rect.right <= utility.right && Math.abs(rect.top + rect.height / 2 - utility.top - utility.height / 2) < 1; }) && getComputedStyle(tools[0]).opacity === '1' && getComputedStyle(document.querySelector('#bold')).opacity === '1';
					if (!toolbarRow) throw new Error('颜色与文字工具未正确对齐或仍被淡化');
					const model = (await window.desktop.load()).data;
					const paperPreview = context.noteId || !model.active || !model.settings.randomColors || ['sheet-one','sheet-two','sheet-three'].every((name, index) => document.querySelector('.'+name).style.getPropertyValue('--sheet-color') === document.querySelector('[data-color="'+model.paperQueue[index]+'"]').style.getPropertyValue('--swatch'));
					if (!paperPreview) throw new Error('下层纸色未按保存的顺序显示');
					const sample = '○ 待办事项' + String.fromCharCode(10) + '● 已完成事项' + String.fromCharCode(10) + '中文' + String.fromCharCode(9) + 'English🙂';
					const formats = {underlines:[{start:2,end:6}],highlights:[{start:2,end:6}],bolds:[{start:2,end:6}]};
					const originalFormats = JSON.stringify(formats), rendered = document.createElement('div');
					window.PaperText.render(rendered, sample, [], formats);
					const styledLines = window.PaperText.wrap(sample, [], 294, undefined, formats);
					const textFormatting = rendered.textContent === sample && rendered.querySelectorAll('.todo-marker').length === 2 && rendered.querySelectorAll('.todo-marker.is-done').length === 1 && Boolean(rendered.querySelector('.ink-underline') && rendered.querySelector('.ink-highlight') && rendered.querySelector('.ink-bold')) && styledLines.some(line => line.todo?.done && line.strikes.length > 0) && JSON.stringify(formats) === originalFormats;
					if (!textFormatting) throw new Error('文字格式或待办状态渲染检查失败');
					// Detached canvases exercise pointer math without touching live notes or windows.
					let gripTracking = true;
					for (const side of ['left', 'right']) {
						const holder = document.createElement('div'), probe = document.createElement('canvas'); holder.append(probe);
						const paper = new window.PaperMotion({canvas: probe, lines: styledLines});
						try {
							const x = side === 'left' ? 4 : 356, dx = side === 'left' ? 168 : -168;
							paper.begin(x, 195, side); paper.move(x + dx, 223);
							gripTracking &&= paper.phase === 'dragging' && paper.x === dx && paper.y === 28;
							const g = paper.geometry(), s = g.nx * g.gripX + g.ny * paper.gripY - g.origin;
							gripTracking &&= Math.abs(g.nx * -2 * s - dx) < .01 && Math.abs(g.ny * -2 * s - 28) < .01;
							gripTracking &&= paper.release('archive') && paper.x === dx && paper.y === 28;
							paper.tick(paper.flightStart + 1000);
							gripTracking &&= paper.phase === 'detached' && paper.resetAfterDetach() && paper.phase === 'idle';
						} finally { paper.destroy(); }
					}
					if (!gripTracking) throw new Error('左右抓点或离场连续性检查失败');
					return {ready, gripTracking, desktopLayout, actionRoles, toolbarRow, textFormatting, paperPreview: Boolean(paperPreview), bridgeAvailable: Boolean(window.desktop && ['dispatch','getContext','onStateChanged','showNote','openNotebook','onModeChanged','hide','getCursorPosition','moveNote','ready'].every(key => typeof window.desktop[key] === 'function')), canvasReady: Boolean(canvas && canvas.width > 0 && canvas.height > 0 && typeof window.PaperMotion === 'function')};
				})()`);
				const stationaryCanvas = JSON.stringify(win.getBounds()) === originalCanvasBounds;
				if (!stationaryCanvas) throw new Error('纸张动画期间原生画布发生移动');
				console.log(JSON.stringify({ ...result, stationaryCanvas, noteLifecycle, windowTitle: win.getTitle(), transparent: true, compact: ctx.compact, hitRegionCount: ctx.hitRegions.length, windowCount: contexts.size }));
			} catch (error) { console.log(JSON.stringify({ ready: false, noteLifecycle, error: error.message })); }
		});
	}
	const webContentsId = win.webContents.id;
	win.on('closed', () => {
		if (ctx.syncRequest) finishSync(ctx, ctx.syncRequest.id, '便签窗口已关闭，本次操作已取消，请重试。');
		clearInterval(ctx.hitTimer); clearTimeout(ctx.moveTimer); ctx.flushRequest?.resolve(); ctx.flushRequest = null; ctx.peelExpansion = null; contexts.delete(webContentsId);
		if (noteId !== null && noteWindows.get(noteId) === ctx) noteWindows.delete(noteId);
		if (mainContext === ctx) mainContext = null;
	});
	win.loadFile(entryPath, noteId === null ? {} : { query: { noteId } }); return ctx;
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
	app.on('second-instance', () => { if (mainContext) void openMother(false).catch(error => { if (mainContext && !mainContext.win.isDestroyed()) mainContext.win.webContents.send('notes:close-error', error.message); }); });
	app.whenReady().then(async () => {
		Menu.setApplicationMenu(null); stateReady = initializeStore(); await stateReady; createWindow();
		for (const note of store.desktop) createWindow(note.id, note.position);
	});
	app.on('before-quit', event => { if (!appExiting && mainContext) { event.preventDefault(); void closeMain(); } });
	app.on('window-all-closed', () => { appExiting = true; app.quit(); });
}
