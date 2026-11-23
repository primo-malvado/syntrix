const Actions = {
    shift: 0,
    reduce: 1,
    accept: 2,
    goto: 2,
    error: 3
};

export class ParserConflictError extends Error {
    constructor ({ state, token, actions }) {
        const descriptions = actions.map(action => {
            if (action.action === Actions.shift) return `shift to state ${action.to}`;
            if (action.action === Actions.reduce) return `reduce ${action.to}`;
            if (action.action === Actions.error) return 'syntax error';
            return 'accept';
        });
        super(
            `Parser conflict in state ${state} on token ${JSON.stringify(token)}: ` +
            `${descriptions.join(' / ')}`
        );
        this.name = 'ParserConflictError';
        this.state = state;
        this.token = token;
        this.actions = actions;
    }
}

function unique (values) {
    return [...new Set(values)];
}

function firstOf (symbols, first, nullable) {
    const result = [];
    for (const symbol of symbols) {
        for (const value of first[symbol] || []) {
            if (!result.includes(value)) result.push(value);
        }
        if (!nullable.has(symbol)) return result;
    }
    return result;
}

function itemKey (item) {
    return `${item.production}:${item.dot}:${item.lookahead}`;
}

function coreKey (items) {
    return [...new Set(items.map(item => `${item.production}:${item.dot}`))]
        .sort()
        .join('|');
}

function itemSetKey (items) {
    return items.map(itemKey).sort().join('|');
}

function productionText (production) {
    return `${production.create} := ${production.rule.join(' ')}`;
}

function createConflict (state, token, actions) {
    return new ParserConflictError({ state, token, actions });
}

export function createParser (parserRules) {
    const goal = parserRules.start;
    const algorithm = parserRules.algorithm || 'lalr1';
    if (!['slr1', 'lalr1', 'lr1', 'glr'].includes(algorithm)) {
        throw new TypeError(`Unsupported parser algorithm ${algorithm}`);
    }
    const nonTerminals = new Set(Object.keys(parserRules.states));
    const precedence = {};

    for (let level = 0; level < (parserRules.precedence || []).length; level++) {
        const declaration = parserRules.precedence[level];
        for (const token of declaration.tokens) {
            precedence[token] = { type: declaration.type, level: level + 1 };
        }
    }

    const productions = [{
        create: '__accept__',
        rule: [goal],
        action: args => args[0].rules,
        augmented: true
    }];
    const productionByNonTerminal = new Map();
    for (const [create, definition] of Object.entries(parserRules.states)) {
        const indexes = [];
        for (const rule of definition.rules) {
            const production = {
                create,
                rule: rule.rule,
                action: rule.action,
                prec: rule.prec
            };
            indexes.push(productions.length);
            productions.push(production);
        }
        productionByNonTerminal.set(create, indexes);
    }

    if (!nonTerminals.has(goal)) {
        throw new Error(`Unknown parser start rule ${goal}`);
    }

    const terminals = new Set(['eof']);
    for (const production of productions) {
        for (const symbol of production.rule) {
            if (!nonTerminals.has(symbol)) terminals.add(symbol);
        }
    }

    const first = {};
    for (const terminal of terminals) first[terminal] = [terminal];
    for (const nonTerminal of nonTerminals) first[nonTerminal] = [];
    const nullable = new Set();
    let changed = true;
    while (changed) {
        changed = false;
        for (const production of productions.slice(1)) {
            const before = first[production.create].length;
            first[production.create] = unique(
                first[production.create].concat(firstOf(production.rule, first, nullable))
            );
            if (first[production.create].length !== before) changed = true;
            if (production.rule.every(symbol => nullable.has(symbol) || symbol === '')) {
                if (!nullable.has(production.create)) {
                    nullable.add(production.create);
                    changed = true;
                }
            }
        }
    }

    const follow = {};
    for (const nonTerminal of nonTerminals) follow[nonTerminal] = [];
    follow[goal] = ['eof'];
    changed = true;
    while (changed) {
        changed = false;
        for (const production of productions.slice(1)) {
            for (let index = 0; index < production.rule.length; index++) {
                const symbol = production.rule[index];
                if (!nonTerminals.has(symbol)) continue;
                const suffix = production.rule.slice(index + 1);
                const before = follow[symbol].length;
                follow[symbol] = unique(follow[symbol].concat(
                    firstOf(suffix, first, nullable)
                ));
                if (suffix.every(item => nullable.has(item))) {
                    follow[symbol] = unique(follow[symbol].concat(follow[production.create]));
                }
                if (follow[symbol].length !== before) changed = true;
            }
        }
    }

    function closure (seed) {
        const items = new Map(seed.map(item => [itemKey(item), item]));
        let expanded = true;
        while (expanded) {
            expanded = false;
            for (const item of items.values()) {
                const production = productions[item.production];
                const symbol = production.rule[item.dot];
                if (!nonTerminals.has(symbol)) continue;

                const suffix = production.rule.slice(item.dot + 1);
                suffix.push(item.lookahead);
                const lookaheads = firstOf(suffix, first, nullable);
                for (const productionIndex of productionByNonTerminal.get(symbol)) {
                    for (const lookahead of lookaheads) {
                        const next = { production: productionIndex, dot: 0, lookahead };
                        const key = itemKey(next);
                        if (!items.has(key)) {
                            items.set(key, next);
                            expanded = true;
                        }
                    }
                }
            }
        }
        return [...items.values()].sort((a, b) => itemKey(a).localeCompare(itemKey(b)));
    }

    function goTo (items, symbol) {
        const moved = [];
        for (const item of items) {
            const production = productions[item.production];
            if (production.rule[item.dot] === symbol) {
                moved.push({ production: item.production, dot: item.dot + 1, lookahead: item.lookahead });
            }
        }
        return moved.length ? closure(moved) : [];
    }

    const canonicalStates = [];
    const canonicalTransitions = [];
    const canonicalByKey = new Map();
    const initial = closure([{ production: 0, dot: 0, lookahead: 'eof' }]);

    function addCanonicalState (items) {
        const key = itemSetKey(items);
        if (!canonicalByKey.has(key)) {
            canonicalByKey.set(key, canonicalStates.length);
            canonicalStates.push(items);
            canonicalTransitions.push({});
        }
        return canonicalByKey.get(key);
    }

    addCanonicalState(initial);
    for (let stateId = 0; stateId < canonicalStates.length; stateId++) {
        const symbols = unique(canonicalStates[stateId].map(item =>
            productions[item.production].rule[item.dot]
        ).filter(symbol => symbol !== undefined));
        for (const symbol of symbols) {
            canonicalTransitions[stateId][symbol] = addCanonicalState(
                goTo(canonicalStates[stateId], symbol)
            );
        }
    }

    let states;
    let transitions;
    if (algorithm === 'lr1') {
        states = canonicalStates;
        transitions = canonicalTransitions;
    } else {
        const mergedStates = [];
        const mergedByCore = new Map();
        const canonicalToMerged = [];
        for (const items of canonicalStates) {
            const key = coreKey(items);
            let mergedId = mergedByCore.get(key);
            if (mergedId === undefined) {
                mergedId = mergedStates.length;
                mergedByCore.set(key, mergedId);
                mergedStates.push(new Map());
            }
            canonicalToMerged.push(mergedId);
            for (const item of items) {
                const keyWithoutLookahead = `${item.production}:${item.dot}`;
                const lookaheads = mergedStates[mergedId].get(keyWithoutLookahead) || new Set();
                lookaheads.add(item.lookahead);
                mergedStates[mergedId].set(keyWithoutLookahead, lookaheads);
            }
        }

        states = mergedStates.map(items => [...items].flatMap(([key, lookaheads]) => {
            const [production, dot] = key.split(':').map(Number);
            return [...lookaheads].map(lookahead => ({ production, dot, lookahead }));
        }).sort((a, b) => itemKey(a).localeCompare(itemKey(b))));

        transitions = states.map(() => ({}));
        for (let canonicalId = 0; canonicalId < canonicalStates.length; canonicalId++) {
            const mergedId = canonicalToMerged[canonicalId];
            for (const [symbol, target] of Object.entries(canonicalTransitions[canonicalId])) {
                const mergedTarget = canonicalToMerged[target];
                const previous = transitions[mergedId][symbol];
                if (previous !== undefined && previous !== mergedTarget) {
                    throw new Error(`Invalid LALR merge transition in state ${mergedId} on ${symbol}`);
                }
                transitions[mergedId][symbol] = mergedTarget;
            }
        }
    }

    function productionPrecedence (production) {
        if (production.prec !== undefined) return precedence[production.prec];
        for (let index = production.rule.length - 1; index >= 0; index--) {
            if (precedence[production.rule[index]]) return precedence[production.rule[index]];
        }
        return null;
    }

    function chooseAction (stateId, token, candidates) {
        if (candidates.length === 1) return candidates[0];
        const shifts = candidates.filter(candidate => candidate.action === Actions.shift);
        const reduces = candidates.filter(candidate => candidate.action === Actions.reduce);
        if (shifts.length === 1 && reduces.length === 1) {
            const tokenPrecedence = precedence[token];
            const reducePrecedence = productionPrecedence(productions[reduces[0].production]);
            if (tokenPrecedence && reducePrecedence) {
                if (tokenPrecedence.level > reducePrecedence.level) return shifts[0];
                if (tokenPrecedence.level < reducePrecedence.level) return reduces[0];
                if (tokenPrecedence.type === 'left') return reduces[0];
                if (tokenPrecedence.type === 'right') return shifts[0];
                if (tokenPrecedence.type === 'nonassoc') return {
                    action: Actions.error,
                    stateId,
                    to: 'non-associative operator'
                };
            }
        }
        throw createConflict(stateId, token, candidates);
    }

    const table = {};
    for (let stateId = 0; stateId < states.length; stateId++) {
        table[stateId] = {};
        for (const [symbol, target] of Object.entries(transitions[stateId])) {
            const transition = [
                terminals.has(symbol) ? Actions.shift : Actions.goto,
                target
            ];
            table[stateId][symbol] = algorithm === 'glr' ? [transition] : transition;
        }

        const candidates = new Map();
        const slrReductionItems = new Set();
        for (const item of states[stateId]) {
            const production = productions[item.production];
            if (item.dot !== production.rule.length) continue;
            if (production.augmented) {
                candidates.set('eof', [{
                    action: Actions.accept,
                    stateId: 0,
                    to: 'accept'
                }]);
                continue;
            }
            if (algorithm === 'slr1') {
                const reductionKey = `${item.production}:${item.dot}`;
                if (slrReductionItems.has(reductionKey)) continue;
                slrReductionItems.add(reductionKey);
            }
            const lookaheads = algorithm === 'slr1'
                ? follow[production.create]
                : [item.lookahead];
            for (const lookahead of lookaheads) {
                const candidate = {
                    action: Actions.reduce,
                    stateId: item.production - 1,
                    production: item.production,
                    to: productionText(production)
                };
                const list = candidates.get(lookahead) || [];
                list.push(candidate);
                candidates.set(lookahead, list);
            }
        }

        for (const [token, reductions] of candidates) {
            const shift = transitions[stateId][token];
            const actions = [];
            if (shift !== undefined) {
                actions.push({
                    action: Actions.shift,
                    stateId,
                    to: shift,
                    prec: precedence[token] || { type: 'none', level: -1 }
                });
            }
            actions.push(...reductions.map(reduction => reduction.action === Actions.accept
                ? reduction
                : ({
                    ...reduction,
                    prec: productionPrecedence(productions[reduction.production]) ||
                        { type: 'none', level: -1 }
                })));
            const chosen = algorithm === 'glr'
                ? actions
                : [chooseAction(stateId, token, actions)];
            const encoded = chosen.map(action => [
                action.action,
                action.action === Actions.shift ? action.to : action.action === Actions.accept
                    ? 0
                    : action.stateId
            ]);
            table[stateId][token] = algorithm === 'glr' ? encoded : encoded[0];
        }
    }

    return {
        tokens: [...terminals],
        states: productions.slice(1).map(production => ({
            create: production.create,
            base: production.rule,
            action: production.action
        })),
        ignoreTokens: parserRules.ignoreTokens || [],
        table,
        diagnostics: parserRules.diagnostics || [],
        algorithm: algorithm === 'lr1'
            ? 'LR(1)'
            : algorithm === 'slr1' ? 'SLR(1)'
                : algorithm === 'glr' ? 'GLR' : 'LALR(1)'
    };
}
