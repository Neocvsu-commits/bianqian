/* UTF-16 text ranges shared by the editable paper and its canvas texture. */
(() => {
  'use strict';

  const FONT = '"SiyeLatin", "KaiTi", "STKaiti", "Microsoft YaHei", serif';
  const FORMAT_FIELDS = Object.freeze(['strikes', 'underlines', 'highlights', 'bolds']);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const integer = (value, fallback = 0) => Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : fallback;
  let measurementContext;

  function splitsSurrogate(text, index) {
    if (index <= 0 || index >= text.length) return false;
    const before = text.charCodeAt(index - 1);
    const after = text.charCodeAt(index);
    return before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF;
  }

  function boundary(text, index, outward) {
    const result = clamp(integer(index), 0, text.length);
    if (!splitsSurrogate(text, result)) return result;
    return result + (outward === 'end' ? 1 : -1);
  }

  // A string is also accepted in place of textLength, allowing these two
  // numeric-range helpers to protect surrogate pairs when text is available.
  function extent(textLength) {
    return typeof textLength === 'string'
      ? {length: textLength.length, text: textLength}
      : {length: Math.max(0, integer(textLength)), text: null};
  }

  function normalizeRanges(ranges, textLength) {
    const {length, text} = extent(textLength);
    const result = [];
    for (const range of Array.isArray(ranges) ? ranges : []) {
      if (!range || !Number.isFinite(Number(range.start)) || !Number.isFinite(Number(range.end))) continue;
      let start = clamp(integer(range.start), 0, length);
      let end = clamp(integer(range.end), 0, length);
      if (end <= start) continue;
      if (text !== null) {
        start = boundary(text, start, 'start');
        end = boundary(text, end, 'end');
      }
      result.push({start, end});
    }
    result.sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    for (const range of result) {
      const previous = merged[merged.length - 1];
      if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
      else merged.push({...range});
    }
    return merged;
  }

  function adjustRanges(oldText, newText, ranges) {
    oldText = String(oldText ?? '');
    newText = String(newText ?? '');
    const oldRanges = normalizeRanges(ranges, oldText);
    if (oldText === newText) return oldRanges;
    let prefix = 0;
    const limit = Math.min(oldText.length, newText.length);
    while (prefix < limit && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix++;
    prefix = Math.min(boundary(oldText, prefix, 'start'), boundary(newText, prefix, 'start'));
    let suffix = 0;
    while (suffix < oldText.length - prefix && suffix < newText.length - prefix &&
      oldText.charCodeAt(oldText.length - suffix - 1) === newText.charCodeAt(newText.length - suffix - 1)) suffix++;
    while (suffix > 0 && (splitsSurrogate(oldText, oldText.length - suffix) || splitsSurrogate(newText, newText.length - suffix))) suffix--;
    const oldEnd = oldText.length - suffix;
    const newEnd = newText.length - suffix;
    const delta = newText.length - oldText.length;
    const result = [];
    for (const range of oldRanges) {
      const leftEnd = Math.min(range.end, prefix);
      if (range.start < leftEnd) result.push({start: range.start, end: leftEnd});
      const rightStart = Math.max(range.start, oldEnd);
      if (rightStart < range.end) result.push({start: rightStart + delta, end: range.end + delta});
      // New text only inherits a strike strictly inside surviving struck text.
      // Inserting at either boundary, or replacing the whole marked passage,
      // does not silently strike the newly inserted characters.
      if (newEnd > prefix && range.start < prefix && range.end > oldEnd) {
        result.push({start: prefix, end: newEnd});
      }
    }
    return normalizeRanges(result, newText);
  }

  function toggleRange(ranges, start, end, textLength) {
    const {length, text} = extent(textLength);
    const normalized = normalizeRanges(ranges, textLength);
    let a = clamp(integer(start), 0, length);
    let b = clamp(integer(end), 0, length);
    if (a > b) [a, b] = [b, a];
    if (a === b) return normalized;
    if (text !== null) {
      a = boundary(text, a, 'start');
      b = boundary(text, b, 'end');
    }
    const covered = normalized.some(range => range.start <= a && range.end >= b);
    if (!covered) return normalizeRanges([...normalized, {start: a, end: b}], textLength);
    const result = [];
    for (const range of normalized) {
      if (range.end <= a || range.start >= b) result.push(range);
      else {
        if (range.start < a) result.push({start: range.start, end: a});
        if (range.end > b) result.push({start: b, end: range.end});
      }
    }
    return normalizeRanges(result, textLength);
  }

  function decorations(text, strikes, formats = {}) {
    const result = {strikes: normalizeRanges(strikes, text)};
    for (const field of FORMAT_FIELDS.slice(1)) result[field] = normalizeRanges(formats?.[field], text);
    const todos = new Map();
    const completed = [];
    for (const row of paragraphs(text)) {
      const prefix = text.slice(row.start, row.start + 2);
      if (prefix !== '○ ' && prefix !== '● ') continue;
      const todo = {offset: row.start, done: prefix[0] === '●'};
      todos.set(row.start, todo);
      if (todo.done && row.end > row.start + 2) completed.push({start: row.start + 2, end: row.end});
    }
    result.strikes = normalizeRanges([...result.strikes, ...completed], text);
    return {ranges: result, todos};
  }

  function render(container, text, ranges, formats = {}) {
    text = String(text ?? '');
    const doc = container.ownerDocument || document;
    const fragment = doc.createDocumentFragment();
    const styled = decorations(text, ranges, formats);
    const boundaries = new Set([0, text.length]);
    for (const field of FORMAT_FIELDS) for (const range of styled.ranges[field]) {
      boundaries.add(range.start); boundaries.add(range.end);
    }
    for (const offset of styled.todos.keys()) { boundaries.add(offset); boundaries.add(offset + 1); }
    const points = [...boundaries].sort((a, b) => a - b);
    const wrappers = [['bolds', 'span', 'ink-bold'], ['highlights', 'span', 'ink-highlight'],
      ['underlines', 'span', 'ink-underline'], ['strikes', 's', 'text-strike']];
    for (let i = 0; i < points.length - 1; i++) {
      const start = points[i], end = points[i + 1];
      if (start === end) continue;
      const todo = styled.todos.get(start);
      let node;
      if (todo && end === start + 1) {
        node = doc.createElement('span');
        node.className = `todo-marker${todo.done ? ' is-done' : ''}`;
        node.dataset.offset = String(todo.offset);
        node.append(doc.createTextNode(text.slice(start, end)));
      } else node = doc.createTextNode(text.slice(start, end));
      for (const [field, tag, className] of wrappers) {
        if (todo && end === start + 1 && field !== 'highlights') continue;
        if (!styled.ranges[field].some(range => range.start <= start && range.end >= end)) continue;
        const wrapper = doc.createElement(tag);
        wrapper.className = className;
        wrapper.append(node);
        node = wrapper;
      }
      fragment.append(node);
    }
    if (!fragment.childNodes.length) fragment.append(doc.createTextNode(''));
    container.replaceChildren(fragment);
    return container;
  }

  function paragraphs(text) {
    const rows = [];
    const separators = /\r\n|\r|\n/g;
    let start = 0;
    for (let match = separators.exec(text); match; match = separators.exec(text)) {
      const nextStart = match.index + match[0].length;
      rows.push({start, end: match.index, nextStart});
      start = nextStart;
    }
    rows.push({start, end: text.length, nextStart: text.length + 1});
    return rows;
  }

  function tabWidth(ctx, size) {
    const count = Number.isFinite(Number(size)) && Number(size) > 0 ? Number(size) : 8;
    return Math.max(.001, ctx.measureText(' ').width * count);
  }

  function measureLine(ctx, text, tabSize = 8) {
    text = String(text ?? '');
    if (!text.includes('\t')) return ctx.measureText(text).width;
    const stop = tabWidth(ctx, tabSize);
    let advance = 0;
    const parts = text.split('\t');
    for (let i = 0; i < parts.length; i++) {
      advance += ctx.measureText(parts[i]).width;
      if (i < parts.length - 1) advance = (Math.floor(advance / stop) + 1) * stop;
    }
    return advance;
  }

  // Ranges are UTF-16 offsets in the whole line. Tabs always use that line's
  // origin, even when only a selected bold fragment is being stroked.
  function drawLineRun(ctx, text, x, y, options = {}) {
    text = String(text ?? '');
    const start = boundary(text, options.start ?? 0, 'start');
    const end = boundary(text, options.end ?? text.length, 'end');
    if (end <= start) return;
    const method = options.stroke ? 'strokeText' : 'fillText';
    if (!text.includes('\t')) {
      if (start === 0 && end === text.length) ctx[method](text, x, y);
      else ctx[method](text.slice(start, end), x + ctx.measureText(text.slice(0, start)).width, y);
      return;
    }
    const stop = tabWidth(ctx, options.tabSize ?? 8);
    let offset = 0;
    let advance = 0;
    while (offset <= text.length) {
      const tab = text.indexOf('\t', offset);
      const segmentEnd = tab < 0 ? text.length : tab;
      const segment = text.slice(offset, segmentEnd);
      const from = Math.max(start, offset), to = Math.min(end, segmentEnd);
      if (to > from) {
        const leading = ctx.measureText(segment.slice(0, from - offset)).width;
        ctx[method](text.slice(from, to), x + advance + leading, y);
      }
      if (tab < 0 || segmentEnd >= end) break;
      advance += ctx.measureText(segment).width;
      advance = (Math.floor(advance / stop) + 1) * stop;
      offset = tab + 1;
    }
  }

  function wrap(text, ranges, width = 294, font = `20px ${FONT}`, formats = {}) {
    text = String(text ?? '');
    const styled = decorations(text, ranges, formats);
    if (!measurementContext) measurementContext = document.createElement('canvas').getContext('2d');
    const ctx = measurementContext;
    ctx.font = String(font);
    const maxWidth = Number.isFinite(Number(width)) && Number(width) > 0 ? Number(width) : 294;
    const output = [];
    const append = (line, offset) => {
      const end = offset + line.length;
      const result = {text: line, start: offset};
      for (const field of FORMAT_FIELDS) {
        result[field] = styled.ranges[field].filter(range => range.end > offset && range.start < end)
          .map(range => ({start: Math.max(range.start, offset) - offset, end: Math.min(range.end, end) - offset}));
      }
      const todo = styled.todos.get(offset);
      if (todo) result.todo = {...todo};
      output.push(result);
    };
    for (const row of paragraphs(text)) {
      let line = '';
      let lineStart = row.start;
      let offset = row.start;
      for (const char of text.slice(row.start, row.end)) {
        if (line && measureLine(ctx, line + char) > maxWidth) {
          append(line, lineStart);
          line = '';
          lineStart = offset;
        }
        line += char;
        offset += char.length;
      }
      append(line, lineStart);
    }
    return output;
  }

  function currentLineRange(text, caret) {
    text = String(text ?? '');
    const position = boundary(text, caret, 'start');
    for (const row of paragraphs(text)) {
      if (position < row.nextStart) return {start: row.start, end: row.end};
    }
    return {start: text.length, end: text.length};
  }

  window.PaperText = Object.freeze({FONT, FORMAT_FIELDS, normalizeRanges, adjustRanges, toggleRange, render, wrap, currentLineRange, measureLine, drawLineRun});
})();
