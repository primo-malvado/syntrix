export default function expandTable (table) {
    const froms = table.map(item => item._ft_.codePointAt(0));

    const tos = table.map(item => item._tt_.codePointAt(0) + 1);

    const breaks = [...new Set(froms.concat(tos))].sort((a, b) => a - b);

    const newTable = [];

    table.forEach((item) => {
        let f = item._ft_.codePointAt(0);
        const t = item._tt_.codePointAt(0);

        breaks.forEach((_break) => {
            if (_break > f && _break <= t) {
                const _new = {
                    _ft_: String.fromCodePoint(f),
                    _tt_: String.fromCodePoint(_break - 1),
                    from: item.from,
                    to: item.to
                };
                newTable.push(_new);

                f = _break;
            }
        });

        newTable.push({
            _ft_: String.fromCodePoint(f),
            _tt_: String.fromCodePoint(t),
            from: item.from,
            to: item.to
        });
    });

    return newTable;
}
;
