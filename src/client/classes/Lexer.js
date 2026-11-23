import { createSyntaxError } from './diagnostics.js';

function addValueAlias (token) {
    if (!Object.hasOwn(token, 'value')) {
        Object.defineProperty(token, 'value', {
            configurable: true,
            get () { return this.content; }
        });
    }
    return token;
}

class Lexer {
    constructor (grammar, { unicode = grammar.INITIAL?.unicode || false, discardConsumedInput = false } = {}) {
        this.states = ['INITIAL'];
        this.YYCURSOR = 0;
        this.grammar = grammar;
        this.pendingToken = null;
        this._partialToken = null;
        this.transitionIndex = new Map();
        this.transitionCache = new Map();
        this.unicode = unicode;
        this.discardConsumedInput = discardConsumedInput;
    }

    setInput (exp, { final = true } = {}) {
        if (typeof exp !== 'string') throw new TypeError('Lexer input must be a string');
        this.input = exp;
        this.states = ['INITIAL'];
        this.YYCURSOR = 0;
        this.inputOffset = 0;
        this.lineOffset = 0;
        this.pendingToken = null;
        this._partialToken = null;
        this.finalInput = final;
    }

    appendInput (chunk) {
        if (typeof chunk !== 'string') throw new TypeError('Lexer input chunk must be a string');
        if (this.pendingToken !== null) {
            throw new Error('Lexer: consume the pending token before appending input');
        }
        if (this.finalInput) throw new Error('Lexer: input is already finished');
        if (this.discardConsumedInput && this.YYCURSOR > this.inputOffset) {
            const end = this.input.lastIndexOf('\n', this.YYCURSOR - this.inputOffset - 1) + 1;
            if (end > 0) {
                this.lineOffset += this.input.slice(0, end).split('\n').length - 1;
                this.inputOffset += end;
                this.input = this.input.slice(end);
            }
        }
        this.input += chunk;
    }

    finishInput () {
        this.finalInput = true;
    }

    readToken () {
        if (this.pendingToken === null) {
            this.pendingToken = this.parse();
        }

        return this.pendingToken;
    }

    nextToken () {
        const token = this.readToken();
        if (token === null) return null;
        this.pendingToken = null;
        return token;
    }


    beginState (state) {
        this.assertState(state);
        this._partialToken = null;
        this.states.unshift(state);
    }

    pushState (state) {
        this.beginState(state);
    }

    popState () {
        if (this.states.length === 1) {
            throw new Error('Lexer: cannot pop the INITIAL state');
        }
        this._partialToken = null;
        return this.states.shift();
    }

    currentState () {
        return this.states[0];
    }

    assertState (state) {
        if (!this.grammar[state]) throw new Error(`Lexer: unknown state ${state}`);
    }

    transitionsFor (state, from) {
        let stateIndex = this.transitionIndex.get(state);
        if (stateIndex === undefined) {
            if (!this.grammar[state]) throw new Error(`Lexer: unknown state ${state}`);
            stateIndex = new Map();
            this.transitionIndex.set(state, stateIndex);
        }
        let transitions = stateIndex.get(from);
        if (transitions === undefined) {
            transitions = this.grammar[state].table.filter(jump => jump.from === from);
            stateIndex.set(from, transitions);
        }
        return transitions;
    }

    transitionFor (state, from, character) {
        let characterIndex = this.transitionCache.get(state);
        if (characterIndex === undefined) {
            characterIndex = new Map();
            this.transitionCache.set(state, characterIndex);
        }
        let stateIndex = characterIndex.get(from);
        if (stateIndex === undefined) {
            stateIndex = new Map();
            characterIndex.set(from, stateIndex);
        }
        if (stateIndex.has(character)) return stateIndex.get(character);
        let transition = null;
        for (const jump of this.transitionsFor(state, from)) {
            if (jump._ft_ <= character && jump._tt_ >= character) {
                transition = jump;
                break;
            }
        }
        stateIndex.set(character, transition);
        return transition;
    }

    parse () {
        const startPosition = this.YYCURSOR;
        const state = this.currentState();
        this.assertState(state);
        const partial = this._partialToken;
        const resume = partial !== null && partial.startPosition === startPosition && partial.state === state;
        this._partialToken = null;
        this.yytext = resume ? partial.text : '';
        let stateId = resume ? partial.stateId : '0';
        const previous = resume ? partial.buffer : null;
        let acceptedPosition = previous?.pos;
        let acceptedContent = previous?.content;
        let acceptedType = previous?.tokenType;
        let acceptedAction = previous?.parseFunction;
        if (resume) this.YYCURSOR = partial.cursor;

        this.YYLIMIT = this.inputOffset + this.input.length;
        let incompleteUnicode = false;

        while (this.YYCURSOR < this.YYLIMIT) {
            const cursor = this.YYCURSOR - this.inputOffset;
            const codeUnit = this.input.charCodeAt(cursor);
            if (this.unicode && !this.finalInput &&
                codeUnit >= 0xD800 && codeUnit <= 0xDBFF &&
                this.YYCURSOR + 1 === this.YYLIMIT) {
                incompleteUnicode = true;
                break;
            }
            const current_read = this.unicode
                ? String.fromCodePoint(this.input.codePointAt(cursor))
                : this.input.charAt(cursor);
            const readLength = this.unicode ? current_read.length : 1;

            const transition = this.transitionFor(state, stateId, current_read);

            if (transition !== undefined && transition !== null) {
                this.YYCURSOR += readLength;
                this.yytext += current_read;
                stateId = transition.to;

                const accepting = this.grammar[state].endMap[stateId];
                if (accepting !== undefined) {
                    acceptedType = accepting.tokenType;
                    acceptedAction = accepting.parseFunction;
                    acceptedContent = this.yytext;
                    acceptedPosition = this.YYCURSOR;
                }
            } else {
                break;
            }
        }

        if (!this.finalInput && (incompleteUnicode || this.YYCURSOR === this.YYLIMIT)) {
            const buffer = acceptedPosition === undefined ? null : {
                tokenType: acceptedType,
                parseFunction: acceptedAction,
                content: acceptedContent,
                startPosition,
                pos: acceptedPosition
            };
            return this._suspendToken(startPosition, state, stateId, buffer);
        }

        if (acceptedPosition !== undefined) {
            this.YYCURSOR = acceptedPosition;
            this.yytext = acceptedContent;
            if (acceptedAction) {
                const tx = addValueAlias(acceptedAction(this));
                tx.startPosition = startPosition;
                tx.toPos = acceptedPosition;

                return tx;
            }
            return addValueAlias({
                tokenType: acceptedType,
                parseFunction: acceptedAction,
                content: acceptedContent,
                startPosition,
                pos: acceptedPosition
            });
        }

        if (startPosition < this.YYLIMIT) {
            throw createSyntaxError(
                this.input,
                `Lexer: unexpected input ${JSON.stringify(this.input[startPosition - this.inputOffset])}`,
                startPosition - this.inputOffset,
                1,
                { positionOffset: this.inputOffset, lineOffset: this.lineOffset }
            );
        }

        return addValueAlias({ tokenType: 'eof' });
    }

    _suspendToken (startPosition, state, stateId, buffer) {
        this._partialToken = {
            startPosition, state, stateId, buffer, cursor: this.YYCURSOR, text: this.yytext
        };
        this.YYCURSOR = startPosition;
        this.yytext = '';
        return null;
    }

    popToken () {
        const token = this.readToken();
        this.pendingToken = null;
        return token;
    }

}

export default Lexer;
