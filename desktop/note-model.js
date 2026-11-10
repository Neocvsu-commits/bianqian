(function (root, factory) {
	if (typeof module === 'object' && module.exports) module.exports = factory(require('node:crypto').randomUUID);
	else root.NoteModel = factory(() => root.crypto.randomUUID());
})(typeof globalThis !== 'undefined' ? globalThis : this, function (randomUUID) {
	'use strict';

const colors = new Set(['butter', 'sage', 'blue', 'rose', 'cream']);
const themes = new Set(['system', 'light', 'dark']);
const rangeFields = ['strikes', 'underlines', 'highlights', 'bolds'];

function blankNote(color = 'butter') {
	return { id: randomUUID(), color, title: '', body: '', strikes: [], underlines: [], highlights: [], bolds: [], createdAt: new Date().toISOString() };
}
function initialState() {
	const active = blankNote();
	active.title = '今天的小事';
	active.body = '把想法先记下来。\n\n□ 整理桌面\n□ 留一点时间散步\n□ 试着撕下这一页 ↖';
	return { version: 1, revision: 0, active, archive: [], trash: [], desktop: [], paperQueue: [], settings: { sound: true, pinned: false, randomColors: false, theme: 'system', mainWindow: { compact: true, hidden: false } } };
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
function migrateLegacyPaper(data) {
	if (!data || typeof data !== 'object') return;
	const notes = [data.active, ...(Array.isArray(data.archive) ? data.archive : []), ...(Array.isArray(data.desktop) ? data.desktop : []), ...(Array.isArray(data.trash) ? data.trash.map(item => item?.note) : [])];
	for (const note of notes) {
		if (!note || typeof note !== 'object' || Array.isArray(note)) continue;
		// Demo 22 stored dark appearance as a paper color. Restore its base color
		// before validation; subsequent theme switches only change settings.
		if (note.color === 'black') note.color = colors.has(note.lightColor) ? note.lightColor : 'butter';
		delete note.lightColor; delete note.manualColor;
	}
}
function normalizeData(data) {
	migrateLegacyPaper(data);
	if (!data || data.version !== 1 || (data.active !== null && !validNote(data.active)) || !Array.isArray(data.archive) || !data.archive.every(validNote)) throw new Error('便签数据格式无效。');
	data.trash ??= []; data.desktop ??= []; data.settings = { sound: true, pinned: false, randomColors: false, theme: 'system', ...data.settings };
	data.settings.mainWindow = { compact: true, hidden: false, ...data.settings.mainWindow };
	const mainSettings = data.settings.mainWindow;
	if (typeof data.settings.pinned !== 'boolean' || typeof data.settings.randomColors !== 'boolean' || !themes.has(data.settings.theme) || typeof mainSettings.compact !== 'boolean' || typeof mainSettings.hidden !== 'boolean' || (mainSettings.bounds !== undefined && !validBounds(mainSettings.bounds)) || (mainSettings.desktopBounds !== undefined && !validBounds(mainSettings.desktopBounds))) throw new Error('窗口设置格式无效。');
	data.revision ??= 0;
	if (!Number.isSafeInteger(data.revision) || data.revision < 0) throw new Error('便签版本号无效。');
	if (!Array.isArray(data.desktop) || !data.desktop.every(validNote) || !Array.isArray(data.trash) || !data.trash.every(item => item && validNote(item.note) && ['active', 'archive', 'desktop'].includes(item.source))) throw new Error('便签列表格式无效。');
	const notes = [data.active, ...data.archive, ...data.desktop, ...data.trash.map(item => item.note)].filter(Boolean);
	if (new Set(notes.map(note => note.id)).size !== notes.length) throw new Error('便签编号重复，已保留原文件。');
	normalizePaperQueue(data);
	return data;
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
		if (!action.changes || typeof action.changes !== 'object' || Array.isArray(action.changes) || Object.entries(action.changes).some(([key, value]) => key === 'theme' ? !themes.has(value) : !['sound', 'pinned', 'randomColors'].includes(key) || typeof value !== 'boolean')) throw new Error('偏好设置无效。');
		Object.assign(data.settings, action.changes);
		if ('randomColors' in action.changes) normalizePaperQueue(data);
		return;
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

function prepare(data) {
	const prepared = data == null ? initialState() : normalizeData(data);
	if (!prepared.active) ensurePaperPool(prepared, 'butter', true);
	return prepared;
}

	return {
		colors, themes, rangeFields, blankNote, initialState, normalizePaperQueue, validPosition, validRanges, validBounds,
		validNote, migrateLegacyPaper, normalizeData, locate, removeLocated, hasContent, blankFor, ensurePaperPool, toActive, reduceAction, prepare
	};
});
