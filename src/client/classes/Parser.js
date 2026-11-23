import { formatSourceLocation, getLineColumn } from './diagnostics.js';

let Actions = {
    'shift': 0,
    'reduce': 1,
    'accept': 2,
    'goto': 2,
    'error': 3
};

export class ParserSyntaxError extends SyntaxError {
    constructor (message, details = {}) {
        super(message);
        this.name = 'ParserSyntaxError';
        Object.assign(this, details);
    }
}

export class ParserParseError extends ParserSyntaxError {
    constructor (errors) {
        super(`${errors.length} syntax error${errors.length === 1 ? '' : 's'} found`, { errors });
        this.name = 'ParserParseError';
    }
}

class Parser {

    constructor (lexer, config) {
        this.lexer = lexer;
        this.table = config.table;
        this.algorithm = config.algorithm;
        this.forest = config.forest === true;
        if (this.forest && this.algorithm !== 'GLR') {
            throw new TypeError('Parser: forest mode requires a GLR table');
        }
        this.ignoreTokens = new Set(config.ignoreTokens || []);
        this.states = config.states;
        this.nonTerminals = new Set(config.states.map(state => state.create));
        this.recoverErrors = config.recoverErrors === true;
        this.channels = new Set(config.channels || ['default']);
        this.errors = [];
    }

    0 /* shift*/ (stateId) {
        const next = this.lexer.popToken();
        this.stack.unshift(next);

        this._stateStack.push(stateId);
        this._actualState = stateId;
    }

    1 /* reduce*/ (stateId) {
        const reducer = this.states[stateId];
        const baseLen = reducer.base.length;
        if (baseLen >= this._stateStack.length) {
            throw new Error(`Parser: invalid reduction for ${reducer.create}`);
        }
        this._reduce(stateId);
        this._stateStack.length -= baseLen;
        const state = this._stateStack[this._stateStack.length - 1];
        const transition = this.table[state]?.[reducer.create];
        if (!transition || transition[0] !== Actions.goto) {
            throw new Error(`Parser: invalid goto for ${reducer.create} in state ${state}`);
        }
        this._actualState = transition[1];
        this._stateStack.push(this._actualState);
    }

    2 /* accept*/ (stateId) {
        const reducer = this.states[stateId];
        if (reducer.base.length > this.stack.length) {
            throw new Error(`Parser: invalid reduction for ${reducer.create}`);
        }
        this._reduce(stateId);
    }


    _reduce (stateId) {
        const reducer = this.states[stateId];

        const baseLen = reducer.base.length;
        const tree = new Array(baseLen);
        for (let index = 0; index < baseLen; index++) {
            tree[index] = this.stack[baseLen - index - 1];
        }
        if (baseLen === this.stack.length) {
            this.stack.length = 0;
        } else {
            this.stack.copyWithin(0, baseLen);
            this.stack.length -= baseLen;
        }
        if (reducer.action === undefined) {
            reducer.action = function (args) {
                return args;
            };
        }
        const value = reducer.action(tree);

        const reduced = {
            tokenType: reducer.create,
            tree,
            rules: value
        };
        Object.defineProperty(reduced, 'value', { configurable: true, value });
        this.stack.unshift(reduced);
    }

    actualState () {
        let actualState = 0;

        for (let pos = this.stack.length - 1; pos > -1; pos--) {


            actualState = this.table[actualState][this.stack[pos].tokenType][1];
        }
        return actualState;
    }
    parse (text) {
        if (this.algorithm === 'GLR') {
            this.start(text);
            return this.finish();
        }
        this.start(text);
        this.lexer.finishInput();
        const result = this.process(true);
        if (!this.completed) {
            if (this.errors.length) throw new ParserParseError(this.errors);
            throw new Error('Parser: input ended before the start rule was accepted');
        }
        return result;
    }

    _startGlr () {
        let nextNodeId = 0;
        let nextEdgeId = 0;
        const node = (state, position) => ({
            id: nextNodeId++, state, position, edges: [], keys: new Set()
        });
        let position = 0;
        let active = new Map([[0, node(0, position)]]);
        const forestNodes = new Map();
        const forestIds = new WeakMap();
        const packedKeys = new WeakMap();
        let nextForestId = 0;

        const forestNode = (symbol, start, end, token) => {
            const key = JSON.stringify([symbol, start, end]);
            if (!forestNodes.has(key)) {
                const value = token
                    ? { symbol, start, end, token }
                    : { symbol, start, end, alternatives: [] };
                forestNodes.set(key, value);
                forestIds.set(value, nextForestId++);
                if (!token) packedKeys.set(value, new Set());
            }
            return forestNodes.get(key);
        };
        const addAlternative = (parent, production, children) => {
            const key = `${production}:${children.map(child => forestIds.get(child)).join(',')}`;
            const keys = packedKeys.get(parent);
            if (keys.has(key)) return;
            const pending = [...children];
            const visited = new Set();
            while (pending.length) {
                const current = pending.pop();
                if (current === parent) {
                    throw new Error('Parser: GLR cannot represent cyclic derivations');
                }
                if (visited.has(current)) continue;
                visited.add(current);
                for (const alternative of current.alternatives || []) {
                    pending.push(...alternative.children);
                }
            }
            keys.add(key);
            parent.alternatives.push({ production, children });
        };

        const actionsFor = (state, symbol) => {
            const cell = this.table[state]?.[symbol];
            return cell ? (Array.isArray(cell[0]) ? cell : [cell]) : [];
        };
        const getNode = (nodes, state, nodePosition) => {
            if (!nodes.has(state)) nodes.set(state, node(state, nodePosition));
            return nodes.get(state);
        };
        const addEdge = (target, previous, key, createValue) => {
            if (target.keys.has(key)) return false;
            // Cyclic derivations cannot be enumerated as a finite result list.
            const pending = previous.position === target.position ? [previous] : [];
            const visited = new Set();
            while (pending.length) {
                const current = pending.pop();
                if (current === target) {
                    throw new Error('Parser: GLR cannot enumerate cyclic derivations');
                }
                if (visited.has(current)) continue;
                visited.add(current);
                for (const edge of current.edges) {
                    if (edge.previous.position === target.position) pending.push(edge.previous);
                }
            }
            target.keys.add(key);
            target.edges.push({ id: nextEdgeId++, previous, end: target.position, ...createValue() });
            return true;
        };
        const paths = function * (top, length, edges = []) {
            if (length === 0) {
                yield { previous: top, edges };
                return;
            }
            for (const edge of top.edges) {
                yield * paths(edge.previous, length - 1, [...edges, edge]);
            }
        };

        this._processGlr = () => {
            while (true) {
                const token = this.lexer.readToken();
                if (token === null) return undefined;
                if (!this.channels.has(token.channel || 'default')) {
                    this.hiddenTokens.push(this.lexer.popToken());
                    continue;
                }
                if (this.ignoreTokens.has(token.tokenType)) {
                    this.lexer.popToken();
                    continue;
                }

                let changed = true;
                while (changed) {
                    changed = false;
                    for (const top of active.values()) {
                        for (const [action, index] of actionsFor(top.state, token.tokenType)) {
                            if (action !== Actions.reduce) continue;
                            const reducer = this.states[index];
                            for (const path of paths(top, reducer.base.length)) {
                                const goto = actionsFor(path.previous.state, reducer.create)[0];
                                if (!goto || goto[0] !== Actions.goto) {
                                    throw new Error(`Parser: invalid GLR goto for ${reducer.create}`);
                                }
                                const target = getNode(active, goto[1], position);
                                if (this.forest) {
                                    const value = forestNode(reducer.create, path.previous.position, position);
                                    const children = path.edges.map(edge => edge.value).reverse();
                                    addAlternative(value, index, children);
                                    const key = `forest:${path.previous.id}:${forestIds.get(value)}`;
                                    if (addEdge(target, path.previous, key, () => ({ value }))) changed = true;
                                    continue;
                                }
                                const key = `${path.previous.id}:${index}:${path.edges.map(edge => edge.id).join(',')}`;
                                if (addEdge(target, path.previous, key, () => {
                                    const spanning = new Set([reducer.create]);
                                    for (const edge of path.edges) {
                                        if (edge.previous.position !== path.previous.position ||
                                        edge.end !== position) continue;
                                        if (edge.spanning.has(reducer.create)) {
                                            throw new Error('Parser: GLR cannot enumerate cyclic derivations');
                                        }
                                        for (const symbol of edge.spanning) spanning.add(symbol);
                                    }
                                    const tree = path.edges.map(edge => edge.value).reverse();
                                    const value = reducer.action ? reducer.action(tree) : tree;
                                    const reduced = {
                                        tokenType: reducer.create,
                                        tree,
                                        rules: value
                                    };
                                    Object.defineProperty(reduced, 'value', { configurable: true, value });
                                    return {
                                        spanning,
                                        value: reduced
                                    };
                                })) changed = true;
                            }
                        }
                    }
                }

                const shifted = new Map();
                const results = [];
                for (const top of active.values()) {
                    for (const [action, index] of actionsFor(top.state, token.tokenType)) {
                        if (action === Actions.shift) {
                            const target = getNode(shifted, index, position + 1);
                            addEdge(target, top, `shift:${top.id}`, () => ({
                                value: this.forest
                                    ? forestNode(token.tokenType, position, position + 1, token)
                                    : token,
                                spanning: new Set()
                            }));
                        } else if (action === Actions.accept) {
                            for (const edge of top.edges) {
                                results.push(this.forest ? edge.value : edge.value.rules);
                            }
                        } else if (action !== Actions.reduce && action !== Actions.error) {
                            throw new Error(`Parser: invalid GLR action ${action}`);
                        }
                    }
                }
                if (results.length) {
                    if (this.forest && new Set(results).size !== 1) {
                        throw new Error('Parser: GLR produced multiple forest roots');
                    }
                    this.completed = true;
                    this.glrResults = this.forest ? results[0] : results;
                    return this.glrResults;
                }
                if (!shifted.size) {
                    const expected = Object.create(null);
                    for (const top of active.values()) {
                        for (const name of Object.keys(this.table[top.state])) {
                            (expected[name] ||= []).push(...actionsFor(top.state, name));
                        }
                    }
                    throw this.createSyntaxError(expected, token);
                }
                this.lexer.popToken();
                active = shifted;
                position++;
            }
        };
    }

    start (text = '') {
        this.lexer.setInput(text, { final: false });
        this.stack = [];
        this.errors = [];
        this.hiddenTokens = [];
        this.completed = false;
        this.started = true;
        if (this.algorithm === 'GLR') {
            this.glrResults = undefined;
            this._startGlr();
            return;
        }
        this._stateStack = [0];
        this._actualState = 0;
    }

    push (chunk) {
        if (!this.started) this.start();
        if (this.algorithm === 'GLR' && this.completed) {
            throw new Error('Parser: input is already finished');
        }
        this.lexer.appendInput(chunk);
        if (this.algorithm === 'GLR') return this._processGlr();
        return this.process(false);
    }

    finish () {
        if (!this.started) this.start();
        if (this.algorithm === 'GLR') {
            if (this.completed) return this.glrResults;
            this.lexer.finishInput();
            const result = this._processGlr();
            if (!this.completed) {
                throw new Error('Parser: GLR input ended before the start rule was accepted');
            }
            return result;
        }
        this.lexer.finishInput();
        const result = this.process(true);
        if (!this.completed) {
            if (this.errors.length) throw new ParserParseError(this.errors);
            throw new Error('Parser: input ended before the start rule was accepted');
        }
        return result;
    }

    process (final) {
        while (!this.completed) {
            const token = this.lexer.readToken();
            if (token === null) return undefined;

            const channel = token.channel || 'default';
            if (!this.channels.has(channel)) {
                this.hiddenTokens.push(this.lexer.popToken());
                continue;
            }

            if (this.ignoreTokens.has(token.tokenType)) {
                this.lexer.popToken();
                continue;
            }

            const state = this.table[this._actualState];
            if (!state) {
                throw new Error(`Parser: invalid state ${this._actualState}`);
            }
            if (state[token.tokenType]) {
                const nextAction = state[token.tokenType];
                const action = nextAction[0];
                if (action === Actions.shift) {
                    this[0](nextAction[1]);
                } else if (action === Actions.reduce) {
                    this[1](nextAction[1]);
                } else if (action === Actions.accept) {
                    this[2](nextAction[1]);
                    this.completed = true;
                    return this.stack[0].rules;
                } else if (action === Actions.error) {
                    const error = this.createSyntaxError(state, token);
                    if (!this.recoverErrors) throw error;
                    this.errors.push(error);
                    this.lexer.popToken();
                    continue;
                } else {
                    throw new Error(`Parser: invalid action ${action} in state ${this._actualState}`);
                }
            } else {
                const error = this.createSyntaxError(state, token);
                if (!this.recoverErrors) throw error;
                this.errors.push(error);
                this.lexer.popToken();
                if (token.tokenType === 'eof') break;
            }
        }
        return this.completed ? this.stack[0].rules : undefined;
    }

    createSyntaxError (state, token) {
        const expected = Object.keys(state).filter(name => {
            if (this.nonTerminals.has(name)) return false;
            const actions = state[name];
            return Array.isArray(actions[0])
                ? actions.some(action => action[0] !== Actions.error)
                : actions[0] !== Actions.error;
        });
        const position = token.startPosition ?? this.lexer.YYCURSOR;
        const source = this.lexer.input || '';
        const sourcePosition = position - (this.lexer.inputOffset || 0);
        const lineOffset = this.lexer.lineOffset || 0;
        const tokenLength = token.content?.length || 1;
        const location = getLineColumn(source, sourcePosition, lineOffset);
        const error = new ParserSyntaxError(
            `Unexpected token ${token.tokenType} at position ${position}; ` +
            `expected: ${expected.join(', ')}\n` +
            `${formatSourceLocation(source, sourcePosition, tokenLength, lineOffset)}`,
            {
                position,
                expected,
                token,
                line: location.line,
                column: location.column
            }
        );
        return error;
    }

}

export default Parser;
