export function getLineColumn (source, position, lineOffset = 0) {
    const before = source.slice(0, position);
    const lineStart = before.lastIndexOf('\n') + 1;
    return {
        line: before.split('\n').length + lineOffset,
        column: position - lineStart + 1
    };
}

export function formatSourceLocation (source, position, length = 1, lineOffset = 0) {
    const { line, column } = getLineColumn(source, position, lineOffset);
    const lineStart = position > 0 ? source.lastIndexOf('\n', position - 1) + 1 : 0;
    const lineEnd = source.indexOf('\n', position);
    const text = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
    const markerLength = Math.max(1, Math.min(length, text.length - (position - lineStart) || 1));
    const markerPrefix = text.slice(0, column - 1).replace(/[^\t]/g, ' ');
    return `${line}:${column}\n${text}\n${markerPrefix}${'^'.repeat(markerLength)}`;
}

export function createSyntaxError (source, message, position, length = 1, {
    positionOffset = 0, lineOffset = 0
} = {}) {
    const error = new SyntaxError(`${message} at ${formatSourceLocation(source, position, length, lineOffset)}`);
    error.position = position + positionOffset;
    const location = getLineColumn(source, position, lineOffset);
    error.line = location.line;
    error.column = location.column;
    return error;
}
